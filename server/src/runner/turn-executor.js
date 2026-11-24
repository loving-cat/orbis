/**
 * 单 Bot 单轮会话执行循环子模块。
 *
 * 收敛：`run` -> `runInScope` -> `runWithLease` 完整执行主干：
 *   1. 受管上下文校验与报告 scope 生命周期绑定；
 *   2. 获取运行槽位与主动压缩检查；
 *   3. 技能按需增量注入（压缩后自动失效重注）、经验注入、旁路备忘消费；
 *   4. 流式事件订阅（delta / steps / compaction_end）、空回复三层恢复、产物收集与统计落盘；
 *   5. 长任务：软截止分段（到点先收尾再让出）、回合收尾续跑守卫、非受管私聊自动续段。
 */
import { log, newId } from '../util.js';
import { isMainChatBusy } from './chief-summary-runner.js';
import { scheduleRunSettled } from './run-settled.js';
import { readBrandEnv } from '../brand.js';
import { readForModel, saveFromPath } from '../attachments.js';
import { RunUsage } from '../run-stats.js';
import { providerLeaseScope } from '../provider-updates.js';
import {
  assistantFailure, fallbackModels, formatFailureDetail, modelFailure, recoverModelReply, withModelHint,
} from '../model-reply.js';
import { recordFailure } from '../diagnostics-log.js';
import { claimOrderTarget } from './stream-order.js';
import { isRecoverableFailure } from '../retry-policy.js';
import { collectNewImages, snapshotImages } from '../image-watch.js';
import { snapshotWorkspace, diffSnapshots, summarizeChanges } from '../change-watch.js';
import { collectArtifacts } from '../artifact-watch.js';
import { selectSkillsFor, skillFingerprint, skillsPromptLines, skillsToInject } from '../skills.js';
import { selectLessonsFor, lessonsPromptLines, resolveModelFamilyForModel } from '../lessons.js';
import { resolveManagedContext, planAttemptEvent, adaptRunOutcome, MANAGED } from '../tasks/task-progress.js';
import { createReportCollector } from '../tasks/task-report.js';
import { STOP } from '../tasks/task-contract.js';
import { autonomyByDefault } from '../tasks/task-autonomy.js';
import {
  CONTINUE_NOTE, NUDGE_NOTE, extractContinuation, wantsAskFirst, wrapUpPrompt,
} from '../turn-continuation.js';
import {
  STEP_CAP_GRACE, isBlockingAsk, managedIsAutonomous, runContinuationGuard, scheduleDmContinuation, softDeadlineTimeout,
} from './turn-slicing.js';
import { emitContext, sessionKey, summarizeArgs, textOf, throttle } from './runner-utils.js';

/** 执行一次 bot 会话回合（带 provider 配置更新租约与受管报告通道作用域） */
export async function executeTurn(runner, roomId, botId, prompt, options = {}) {
  runner.flushProviderUpdates();
  return runner.providerUpdates.withLease((lease) =>
    runInScope(runner, roomId, botId, prompt, { ...options, lease }),
  );
}

async function runInScope(runner, roomId, botId, prompt, options = {}) {
  const managed = resolveManagedContext(options.managedContext, {
    loadTaskRun: (id) => runner.store.taskRuns.read(id),
    loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    actualBotId: botId,
  });
  const collector = managed.kind === MANAGED.managed ? createReportCollector() : null;
  return runWithLease(runner, roomId, botId, prompt, { ...options, reportCollector: collector });
}

async function runWithLease(
  runner,
  roomId,
  botId,
  prompt,
  {
    timeoutMs = runner.config.runTimeoutMs,
    meta = null,
    skipUserMessage = false,
    attachments = [],
    groupTurn = false,
    retryManaged = false,
    taskRunId = newId('run_'),
    attemptIndex = 1,
    lease = null,
    human = false,
    managedContext = null,
    reportCollector = null,
    summaryTurn = false,
    /**
     * 关掉回合收尾的续跑守卫与自动续段（收尾轮、汇总轮这类「本来就该停在这里」的回合）。
     * 守卫本身还会看：纯聊天回合、用户要求先确认时不催（见 turn-continuation.js）。
     */
    noContinueGuard = false,
  } = {},
) {
  const started = Date.now();
  // 汇总交卷轮标记：工具层（dispatch_to_department / create_department / accept_task）
  // 靠它硬拦"汇总完又自己派活"的无限套娃。entry 在这里还没装配，后面再写上去。
  const isSummaryTurn = summaryTurn === true;
  // 只有「真的跑完并落出回复」才值得评估注入的经验。
  // 429 / 超时 / 用户终止进的是 catch → finally，那时评估等于拿没跑通的对话给经验打分。
  let turnSucceeded = false;
  const approvalsAtStart = new Set(
    (runner.store.state.approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.id),
  );

  const managed = resolveManagedContext(managedContext, {
    loadTaskRun: (id) => runner.store.taskRuns.read(id),
    loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    actualBotId: botId,
  });

  if (managed.kind === MANAGED.invalid) {
    return {
      ok: false,
      text: '',
      ms: 0,
      messageId: '',
      error: `受管执行上下文不合法：${managed.text}`,
      code: 'INVALID_MANAGED_CONTEXT',
      stop: STOP.failed,
    };
  }
  const isManaged = managed.kind === MANAGED.managed;
  const reports = reportCollector ?? null;

  const firstNewApproval = () => {
    const pending = (runner.store.state.approvals ?? []).filter(
      (a) =>
        a.status === 'pending' &&
        !approvalsAtStart.has(a.id) &&
        a.roomId === roomId &&
        (a.botId === null || a.botId === undefined || a.botId === botId),
    );
    return pending.length ? pending[0].id : null;
  };

  const reportWaiting = (kind) => {
    const latest = reports?.latest();
    if (!latest || latest.kind !== kind) return null;
    const field = {
      need_approval: 'approvalId',
      need_input: 'inputKey',
      waiting_dependency: 'dependencyTaskId',
    }[kind];
    const ref = latest.waitFor?.[field];
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  };

  const artifactPathsOf = (list) =>
    (Array.isArray(list) ? list : [])
      .map((a) => (typeof a === 'string' ? a : (a?.id ?? a?.rel ?? a?.path ?? a?.ref ?? '')))
      .filter((a) => typeof a === 'string' && a.trim())
      .slice(0, 200);

  const withAttempt = (payload, facts = {}) => {
    if (!isManaged) return payload;
    const adapted = adaptRunOutcome({
      ok: payload.ok === true,
      cancelled: facts.cancelled === true,
      aborted: facts.aborted === true,
      timedOut: facts.timedOut === true,
      stepCapHit: facts.stepCapHit === true,
      empty: facts.empty === true,
      usage: facts.usage ?? null,
      artifacts: facts.artifacts ?? [],
      appliedCompletion: facts.appliedCompletion ?? reports?.appliedCompletion() === true,
      needsApproval: facts.needsApproval ?? reportWaiting('need_approval') ?? firstNewApproval(),
      needsInput: facts.needsInput ?? reportWaiting('need_input'),
      waitingDependency: facts.waitingDependency ?? reportWaiting('waiting_dependency'),
      report: reports?.latest() ?? null,
    });

    const plan = planAttemptEvent({
      stop: adapted.stop,
      context: managed.context,
      revision: managed.context.revision,
      attemptId: managed.context.attemptId,
      botId: managed.context.botId,
      at: Date.now(),
      usage: adapted.usage,
      artifacts: adapted.artifacts,
      phase: adapted.phase,
      waiting: adapted.waiting,
    });

    return {
      ...payload,
      stop: adapted.stop,
      managed: { context: managed.context },
      ...(plan.emit ? { attemptEvent: plan.event } : {}),
      ...(plan.emit ? {} : { attemptEventSkipped: plan.reason }),
      ...(plan.waiting ? { waiting: plan.waiting } : {}),
    };
  };

  const capMs = runner.store.groupLimits().turnMaxMs;
  const effectiveTimeout = groupTurn ? Math.min(timeoutMs || capMs, capMs) : timeoutMs;
  const deadline = effectiveTimeout > 0 ? started + effectiveTimeout : 0;
  let timedOut = false;
  // ★ 软截止（长任务）：单轮到点不再直接砍断，而是先请模型收尾、写进度，
  //   宽限期内自己收住就算「这一段让出」，由推进器/续段接着跑下一段。
  //   以前到点即 abort，记成「失败」只重试一次 —— 跑了 71 步的活被拦腰截断、
  //   半截成果没有检查点，重试又要在同样的 10 分钟里从头做。
  const graceMs = Math.max(0, Number(runner.config.turnGraceMs ?? 180_000) || 0);
  const hardCapMs = effectiveTimeout > 0
    ? Math.max(effectiveTimeout + graceMs, Number(runner.config.turnHardMaxMs) || effectiveTimeout * 3)
    : 0;
  /** 已经发过收尾通知（时间到或步数到） */
  let sliceEnding = false;
  /** 非受管会话能不能自动续段（`autoContinueMax` = 0 时关闭，SDK 默认关） */
  const autoContinueOn = Math.max(0, Number(runner.config.autoContinueMax ?? 12) || 0) > 0
    && !noContinueGuard && !isSummaryTurn;
  /** 模型调用（含续跑守卫的追加）已经结束：之后的定时器回调一律不再动会话 */
  let runFinished = false;

  const room = runner.store.getRoom(roomId);
  if (!room) {
    return withAttempt({
      ok: false, text: '', ms: 0, error: '会话不存在', messageId: '',
      code: 'ROOM_MISSING',
    }, { cancelled: false });
  }
  if (runner.aborting.has(roomId)) {
    return withAttempt({
      ok: false, text: '', ms: 0, error: '已终止', messageId: '',
      code: 'ALREADY_CANCELLED',
    }, { cancelled: true });
  }
  if (runner.providerUpdates.has(runner.providerForBot(botId))) {
    const error = '模型组正在处理配置切换，本次任务未执行。请稍后重试，或检查模型组配置。';
    const msg = runner.store.appendMessage({
      roomId, authorType: 'bot', authorId: botId,
      authorName: runner.store.getBot(botId)?.name ?? botId,
      text: '', status: 'error', error,
    });
    return withAttempt({
      ok: false, text: '', ms: 0, error, messageId: msg.id,
      code: 'PROVIDER_UPDATES_PENDING',
    }, {});
  }

  let entry;
  let collectedArtifacts = [];
  try {
    entry = await runner.ensureSession(roomId, botId);
  } catch (err) {
    if (err?.code === 'SESSION_BUSY') {
      return withAttempt({
        ok: false, code: 'SESSION_BUSY', text: '', ms: 0, error: '会话正在忙', messageId: '',
      }, {});
    }
    const message = modelFailure(err).error;
    runner.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: botId,
      authorName: runner.store.getBot(botId)?.name ?? botId,
      text: '',
      status: 'error',
      error: `起不来：${message}`,
    });
    return withAttempt({
      ok: false, text: '', ms: Date.now() - started, error: message, messageId: '',
      code: 'SESSION_BUILD_FAILED',
    }, {});
  }

  const scopeKey = roomId + ':' + botId;
  const scopeReady = runner.activateReportScope(scopeKey, reports);
  if (!scopeReady) {
    log('报告通道未能激活，本轮不接受阶段报告：', scopeKey);
  }
  const managedCancelTask = managed.kind === 'managed' ? (managed.context?.taskRunId ?? null) : null;
  if (managedCancelTask) {
    runner.managedInflight.set(managedCancelTask, {
      key: sessionKey(roomId, botId), botId, roomId,
      session: entry?.session ?? null, attemptId: managed.context?.attemptId ?? null,
    });
  }

  if (managed.kind === MANAGED.managed) {
    const ctx = managed.context;
    entry.managedContext = {
      taskRunId: ctx.taskRunId,
      attemptId: ctx.attemptId,
      revision: ctx.revision,
      rootTaskId: ctx.rootTaskId,
      botId: ctx.botId,
      candidateDepartmentIds: runner.candidateDepartmentIds(roomId, botId),
    };
  }

  const fallbackModel = runner.model;
  const providerScope = providerLeaseScope(entry.session.model, fallbackModel);
  const turnController = new AbortController();
  entry.turnController = turnController;
  const cancelled = () => runner.aborting.has(roomId) || turnController.signal.aborted;
  const checkCancelled = () => {
    if (cancelled()) throw turnController.signal.reason ?? Object.assign(new Error('已终止'), { name: 'AbortError' });
  };

  entry.lastUsed = Date.now();
  entry.summaryTurn = isSummaryTurn;
  const bot = entry.bot;
  entry.startedAt = Date.now();
  entry.progressAt = entry.startedAt;
  entry.stallNotified = false;
  // 此刻有几个工具在执行（看门狗据此放宽阈值：安静跑着的构建/测试不是卡死）
  entry.toolsRunning = 0;
  const beat = () => {
    entry.progressAt = Date.now();
  };

  let botMsg;
  try {
    botMsg = runner.store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot.id,
      authorName: bot.name,
      authorEmoji: bot.emoji,
      text: '',
      status: 'streaming',
      meta,
    });
  } catch (err) {
    try { runner.releaseReportScope(scopeKey, reports); } catch {}
    try { entry.managedContext = null; } catch {}
    try { entry.busy = false; } catch {}
    try { entry.slotTicket?.release?.(); } catch {}
    try { entry.slotTicket = null; } catch {}
    if (managedCancelTask) {
      try { runner.managedInflight.delete(managedCancelTask); } catch {}
    }
    log('建消息失败，已归还执行权：', roomId, botId, err?.message || err);
    return withAttempt({
      ok: false, code: 'MESSAGE_WRITE_FAILED', text: '', ms: Date.now() - started,
      error: '无法写入消息：' + String(err?.message ?? err).slice(0, 120), messageId: '',
    }, {});
  }
  entry.liveMsgId = botMsg.id;
  // ★ 本轮聚合键**在轮次开始时钉死**，换条（P0-2 插话）也不改：
  //   派活时用的是 msg:<首条气泡>，若封口时用 entry.liveMsgId（可能已被换成第二条），
  //   两边 key 对不上 → 批次永远卡在 dispatchOpen=true。
  entry.originTurnKey = `msg:${botMsg.id}`;
  entry.goalText = String(prompt ?? '').slice(0, 600);
  beat();
  runner.bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: true, lane: 'work', msgId: botMsg.id });

  const committed = [];
  let buffer = '';
  let usage = null;
  const meter = new RunUsage();
  let responseFailure = null;
  const steps = [];

  const render = () => {
    const parts = [...committed];
    if (buffer) parts.push(buffer);
    return parts.join('\n\n');
  };
  entry.liveSteps = steps;
  entry.liveDraft = render;
  entry.turnAmends = [];
  /**
   * 插话换条（P0-2 情形 B），**只能在消息轮次边界调用**。
   *
   * 为什么不能放在 delta 里（D1）：`message_update` 是先 `buffer += delta` 再 push，
   * 此时 render() 已经把**新回复的首段**算进去了 —— 在那里换条会把新内容封进旧气泡，
   * 接着清空草稿，新气泡直接缺开头。
   *
   * 所以时机固定在两处：
   * - `message_start`：新 turn 还没吐 delta，render() 里全是旧内容；
   * - `message_end` 之后：旧正文已 committed 进旧气泡，再换条不会污染新气泡。
   *
   * @param {boolean} createNext 收尾兜底时传 false —— 只封口旧气泡，不凭空建一条空的
   */
  const reseatAtBoundary = (createNext = true) => {
    const next = applyPendingReseat({
      store: runner.store,
      roomId,
      entry,
      botMsgId: botMsg.id,
      render,
      steps,
      meta,
      bot,
      bus: runner.bus,
      log,
      createNext,
      resetDraft: () => {
        committed.length = 0;
        buffer = '';
        steps.length = 0;
      },
    });
    if (next) botMsg = next;
  };

  /**
   * 本轮是否已经出过可见正文。
   *
   * ★ 并发群聊的顺序问题：bot 在思考/跑工具阶段就提前建了空 `botMsg`，它会占住
   *   更早的数组位置。如果另一个 bot 先开口、而这个 bot 后来才吐首字，它就会
   *   插到别人头上 —— 用户看到上面在长高、下面也在流式，整屏上下抽搐。
   *   所以首字落位时把它挪到**当前并发波次的末尾**（谁先开口谁在上）。
   */
  let hasEmittedVisibleText = false;

  /** 首次可见输出（正文或附件）时的落位；多次调用只生效一次。 */
  const claimOrder = () => {
    if (hasEmittedVisibleText) return;
    hasEmittedVisibleText = true;
    // 换条（插话）自己管顺序：pendingReseat 存在时绝不能在这里抢位置
    if (entry?.pendingReseat) return;
    try {
      const target = claimOrderTarget(runner.store.listMessages(roomId, { limit: 200 }), botMsg.id);
      if (target) runner.store.moveMessageAfter(roomId, botMsg.id, target, { touch: true });
    } catch (err) {
      log('并发流式落位失败（不影响本轮）：', err?.message || err);
    }
  };

  const pushDelta = throttle(() => {
    beat();
    const text = render();
    if (text.trim()) claimOrder();
    // ★ 同步落库（静默）：duplex-lane 判「这一轮到底写出正文没有」读的就是
    //   store 里这条消息的 text。只 emit 不落库，那边永远看到空字符串，
    //   于是“已写半截”会被误判成“空占位”，FD-0 直接破。
    runner.store.updateMessage(roomId, botMsg.id, { text }, { silent: true });
    runner.bus.emit('event', { t: 'msg.delta', roomId, msgId: botMsg.id, text });
  }, 80);
  const pushSteps = () => {
    // 工具步骤属于**当前**气泡：换条只发生在消息边界，这里不能动
    beat();
    runner.bus.emit('event', { t: 'msg.steps', roomId, msgId: botMsg.id, steps: [...steps] });
    runner.store.updateMessage(roomId, botMsg.id, { steps: [...steps] }, { silent: true });
  };

  let stepCapHit = false;
  const turnCap = groupTurn ? runner.store.groupLimits().maxSteps : 0;
  let turns = 0;
  /** 这一轮一共调过几次工具（换条会清空 steps，这个不清） */
  let toolCalls = 0;
  /** 这一轮弹过「要停下来等」的卡片（blocking 询问 / 接入确认）：续跑守卫不能催 */
  let askedUser = false;
  /** 最后一条回复的正文（续跑守卫看它判断是不是「半路停下来问」） */
  let lastAssistantText = '';

  /**
   * 软截止：请模型把手上这一步收尾、写进度（steer 在当前工具跑完、下次调模型前送达）。
   * 同一轮只发一次；会话已经不在跑了就不发（否则会被留到下一轮开头误收）。
   */
  const beginWrapUp = (reason) => {
    if (sliceEnding || runFinished) return false;
    sliceEnding = true;
    try {
      if (entry.session?.isStreaming !== false && typeof entry.session?.steer === 'function') {
        const text = wrapUpPrompt({ managed: isManaged, reason, canContinue: autoContinueOn });
        void Promise.resolve(entry.session.steer(text)).catch(() => {});
      }
    } catch {}
    log(`${bot.name} 这一段${reason === 'steps' ? '步数' : '时间'}快用完了 → 请它收尾、写进度（软截止）`);
    return true;
  };

  const onEvent = (event) => {
    switch (event.type) {
      case 'compaction_start':
        runner.bus.emit('event', {
          t: 'bot.compacting',
          roomId,
          botId: bot.id,
          active: true,
          reason: event.reason,
        });
        log(`[${bot.name}] 上下文压缩开始（${event.reason}）`);
        break;
      case 'compaction_end': {
        runner.bus.emit('event', {
          t: 'bot.compacting',
          roomId,
          botId: bot.id,
          active: false,
          reason: event.reason,
          error: event.errorMessage ? modelFailure(event.errorMessage).error : null,
        });
        log(`[${bot.name}] 上下文压缩结束（${event.reason}）`);
        entry.compactedSinceInjection = true;
        entry.skillsInjected = null;
        const res = event.result;
        if (res && !event.aborted && !event.errorMessage) {
          const saved = res.tokensBefore
            ? Math.max(0, res.tokensBefore - (res.estimatedTokensAfter ?? 0))
            : null;
          runner.store.appendMessage(
            {
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: bot.name,
              kind: 'compact',
              text: '',
              status: 'done',
              meta: {
                reason: event.reason,
                tokensBefore: res.tokensBefore ?? null,
                tokensAfter: res.estimatedTokensAfter ?? null,
                saved,
              },
            },
            { beforeStreaming: true },
          );
        }
        break;
      }
      case 'message_start':
        if (event.message?.role === 'assistant') {
          // ★ 换条的最佳时机（D1）：新 turn 还没吐任何 delta，render() 里全是旧内容。
          //   在这里封口，旧的 steps 一并写进旧气泡，新气泡从空开始。
          reseatAtBoundary(true);
          buffer = '';
          turns++;
          // ★ 步数上限也按软截止处理：到上限先请它收尾，再多给几轮宽限，
          //   宽限也用完才硬收住。以前一到上限当场 abort，正在写的东西直接断掉。
          if (turnCap > 0 && turns >= turnCap && !sliceEnding && !stepCapHit) {
            beginWrapUp('steps');
          }
          if (turnCap > 0 && turns >= turnCap + STEP_CAP_GRACE && !stepCapHit) {
            stepCapHit = true;
            log(`${bot.name} 在群里来回 ${turns} 轮，收住`);
            entry.session.abort().catch(() => {});
          }
        }
        break;
      case 'message_update':
        // 模型在出东西（包括思考过程）就是活着：高思考档位的模型可能想很久才吐第一个字
        beat();
        if (event.assistantMessageEvent?.type === 'text_delta') {
          buffer += event.assistantMessageEvent.delta;
          pushDelta();
        }
        break;
      case 'auto_retry_start':
        meter.retry();
        break;
      case 'message_end':
        if (event.message?.role === 'assistant') {
          meter.add(event.message.usage);
          usage = meter.snapshot();
          const failure = assistantFailure(event.message);
          if (failure) {
            responseFailure = failure;
            buffer = '';
            pushDelta.flush();
            break;
          }
          responseFailure = null;
          const finalText = textOf(event.message) || buffer;
          lastAssistantText = finalText.trim();
          if (finalText.trim()) claimOrder();
          if (finalText.trim()) committed.push(finalText.trim());
          buffer = '';
          pushDelta.flush();
          // ★ 旧正文已经 committed 进**旧**气泡，此时再换条（D1 第 2 条）：
          //   早一步换会让这条 message_end 把整段旧正文 push 进新气泡，两边内容重复。
          reseatAtBoundary(true);
        }
        break;
      case 'tool_execution_start': {
        entry.toolsRunning = (Number(entry.toolsRunning) || 0) + 1;
        toolCalls += 1;
        if (isBlockingAsk(event.toolName, event.args)) askedUser = true;
        steps.push({
          tool: event.toolName,
          detail: summarizeArgs(event.args),
          status: 'running',
          startedAt: Date.now(),
        });
        pushSteps();
        break;
      }
      case 'tool_execution_update':
        // ★ 工具还在跑、并且在出输出（bash 的 stdout/stderr 流）：这就是"活着"。
        //
        //   以前不处理这个事件：一条持续打印日志的构建跑过 6 分钟，
        //   在看门狗眼里就是"6 分钟没动静"，被判心跳断了、整轮中断。
        //   只刷新进展时间，不推界面（输出可能非常频繁）。
        beat();
        break;
      case 'tool_execution_end': {
        entry.toolsRunning = Math.max(0, (Number(entry.toolsRunning) || 0) - 1);
        const step = [...steps].reverse().find((s) => s.status === 'running' && s.tool === event.toolName);
        if (step) {
          step.status = event.isError ? 'error' : 'done';
          step.durationMs = event.durationMs ?? Date.now() - step.startedAt;
        }
        pushSteps();
        break;
      }
      case 'queue_update':
        runner.bus.emit('event', {
          t: 'queue',
          roomId,
          botId: bot.id,
          steering: event.steering ?? [],
          followUp: event.followUp ?? [],
        });
        break;
      default:
        break;
    }
  };

  const unsubscribe = entry.session.subscribe(onEvent);
  entry.unsubscribe = unsubscribe;

  let beforeFiles = null;
  const changes = () => {
    if (!beforeFiles) return null;
    try {
      const diff = diffSnapshots(beforeFiles, snapshotWorkspace(runner.config.workspace));
      return diff.total ? summarizeChanges(diff) : null;
    } catch {
      return null;
    }
  };

  let timeoutHandle = null;
  /** 这一轮收尾后要不要自动接着跑下一段（非受管私聊在 finally 里排续段） */
  let continuationPlan = null;
  // 用户终止会让这个代数 +1：续段排出去之前再核对一次，终止过就不续
  const deliveryEpochAtStart = runner.directDeliveryEpochs?.get?.(roomId) ?? 0;
  try {
    checkCancelled();
    await runner.compactIfNeeded(entry, bot, roomId, { signal: turnController.signal, deadline });
    checkCancelled();
    lease?.restrictTo(providerScope);

    entry.compactingOnly = false;

    const images = [];
    for (const id of attachments) {
      const img = readForModel(id);
      if (img) images.push(img);
    }
    const beforeImages = runner.config.autoAttachImages ? snapshotImages(runner.config.workspace) : null;
    const watchChanges = readBrandEnv(process.env, 'WATCH_CHANGES') !== '0';
    beforeFiles = watchChanges ? snapshotWorkspace(runner.config.workspace) : null;
    checkCancelled();

    const remainingMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
    const slotWaitMs = remainingMs && runner.config.runSlotWaitMs > 0
      ? Math.min(remainingMs, runner.config.runSlotWaitMs) : remainingMs || runner.config.runSlotWaitMs;
    const slotTicket = await runner.acquireRunSlot({
      roomId, botId, human, signal: turnController.signal, timeoutMs: slotWaitMs,
    });
    entry.slotTicket = slotTicket;
    if (slotTicket && !slotTicket.ok) {
      checkCancelled();
      throw new Error('运行槽位排队超时');
    }
    checkCancelled();

    let skillsAddedThisTurn = [];
    const withSkills = (text) => {
      try {
        const library = runner.store.skillLibrary();
        if (!library.length) return text;
        const task = text + '\n' + String(meta?.text ?? '');
        const picked = selectSkillsFor(library, task, { max: 5 });
        const already = entry.skillsInjected ?? null;
        const { skills: fresh } = skillsToInject(picked, {
          alreadyGiven: already,
          afterCompaction: Boolean(entry.compactedSinceInjection),
        });
        entry.compactedSinceInjection = false;
        if (!fresh.length) return text;
        const lines = skillsPromptLines(fresh);
        if (!lines.length) return text;
        if (!entry.skillsInjected) entry.skillsInjected = new Set();
        for (const s of fresh) {
          const fp = skillFingerprint(s);
          if (!entry.skillsInjected.has(fp)) skillsAddedThisTurn.push(fp);
          entry.skillsInjected.add(fp);
        }
        return lines.join('\n') + '\n\n' + text;
      } catch (err) {
        log('技能库匹配失败：', err?.message || err);
        return text;
      }
    };

    const withLessons = (text) => {
      try {
        if (bot?.role !== 'main') return text;
        // ★ 经验库整体关掉时（ORBIS_LESSON_REFLECT=0）**不注入、也不 touchLessons**。
        //
        //   以前只关了"收尾复盘"，注入和 hit 计数照旧落盘：用户把开关关了，
        //   提示词里还有经验、磁盘还每秒被写 —— 那个开关等于没关。
        if (typeof runner.store.lessonsEnabled === 'function' && !runner.store.lessonsEnabled()) return text;
        const library = runner.store.lessonLibrary();
        if (!library.length) return text;
        const task = text + '\n' + String(meta?.text ?? '');
        // SIM-Lite：把「当前模型的族」与「关系边」一起传进去 —— 不传的话，
        // 同族加成与矛盾排除在真实注入里等于没做。
        const modelFamily = resolveModelFamilyForModel(entry.session?.model ?? runner.model);
        const edges = runner.store.lessonEdges?.() ?? [];
        const picked = selectLessonsFor(library, task, { roomId, modelFamily, edges });
        const lines = lessonsPromptLines(picked);
        if (!lines.length) return text;
        try {
          // ★ 只记 `hit`（被注入过一次）。**绝不在这里记 win/fail**：
          //   本轮 ok 只说明模型没报错（答非所问也是 ok）；429/超时/用户终止也不是 fail。
          //   真实胜率只来自复盘评估 / 已验收 TaskRun / 用户反馈。
          runner.store.touchLessons(picked.map((l) => l.id), { modelFamily });
          entry.lessonsInjected = { ids: picked.map((l) => l.id), modelFamily, at: Date.now() };
        } catch {}
        return lines.join('\n') + '\n\n' + text;
      } catch (err) {
        log('经验库匹配失败：', err?.message || err);
        return text;
      }
    };

    const consumedSide = !isManaged && !meta?.opening
      ? runner.consumeSideContext(roomId, botId)
      : { items: [], promptBlock: '' };

    const startTurn = async () => {
      const promptWithSide = consumedSide.promptBlock
        ? `${consumedSide.promptBlock}\n\n${prompt}`
        : prompt;
      const finalPrompt = withLessons(withSkills(promptWithSide));
      try {
        return images.length
          ? await entry.session.prompt(finalPrompt, { images })
          : await entry.session.prompt(finalPrompt);
      } catch (err) {
        const msg = String(err?.message || err);
        if (!/already processing/i.test(msg) || !entry.session.followUp) throw err;
        log(`${bot.name} 那一轮还没完，这条改成排队投递（followUp）`);
        try {
          return images.length
            ? await entry.session.followUp(finalPrompt, images)
            : await entry.session.followUp(finalPrompt);
        } catch (followErr) {
          if (entry.skillsInjected && skillsAddedThisTurn.length) {
            for (const fp of skillsAddedThisTurn) entry.skillsInjected.delete(fp);
          }
          skillsAddedThisTurn = [];
          runner.restoreSideContext(roomId, botId, consumedSide.items);
          throw followErr;
        }
      }
    };
    if (deadline && Date.now() >= deadline) throw new Error('本轮等待超时，尚未发起模型请求');

    // ---- 续跑守卫（回合收尾处的 Stop hook，判定见 turn-continuation.js）
    //
    //   模型常用一句「需要我继续吗？」「接下来我会改 X。」收尾，这一轮就结束了 ——
    //   用户不在旁边，长任务就停在那里。提示词压不住这个习惯，所以在收尾处判一次：
    //   是「半路停下来问」就在同一会话里追加「继续执行」（有上限、有退出条件）。
    const guardOn = !noContinueGuard && !isSummaryTurn && !meta?.opening
      && runner.config.continueGuard !== false;
    const guardMax = Math.max(0, Number(runner.config.continueGuardMax ?? 2) || 0);
    const guardAutonomous = isManaged
      ? managedIsAutonomous(runner, managed.context)
      : autonomyByDefault();
    const askFirstAtStart = guardOn && wantsAskFirst(prompt, String(meta?.text ?? ''));
    const runWithGuard = async () => {
      await runner.providerUpdates.withLease(startTurn, providerScope);
      if (!guardOn || guardMax <= 0 || !guardAutonomous) return;
      await runContinuationGuard({
        max: guardMax,
        isStopped: () => cancelled() || sliceEnding || stepCapHit || Boolean(responseFailure) || timedOut,
        readInput: () => ({
          text: lastAssistantText,
          managed: isManaged,
          workTurn: toolCalls > 0,
          toolCalls,
          completed: reports?.appliedCompletion?.() === true,
          waiting: Boolean(
            reportWaiting('need_approval') || reportWaiting('need_input')
            || reportWaiting('waiting_dependency') || firstNewApproval() || askedUser,
          ),
          // 插话里说了「先别动 / 等我确认」也算
          askFirst: askFirstAtStart || wantsAskFirst(entry.turnAmends ?? []),
        }),
        onNudge: (verdict, n) => {
          log(`${bot.name} 收尾时在「${verdict.kind}」（${String(verdict.why).slice(0, 40)}）→ 自动继续（第 ${n} 次）`);
          // 气泡里留一句：用户看得见这里是系统让它接着做，不是它自说自话
          committed.push(NUDGE_NOTE);
          pushDelta();
        },
        nudge: (text) => runner.providerUpdates.withLease(() => entry.session.prompt(text), providerScope),
      });
    };
    const runPromise = runWithGuard().finally(() => { runFinished = true; });

    if (effectiveTimeout > 0) {
      await Promise.race([runPromise, softDeadlineTimeout({
        deadline, started, graceMs, hardCapMs,
        isFinished: () => runFinished,
        beginWrapUp: () => beginWrapUp('time'),
        // 工具在跑、而且最近还在出结果：别把正在出结果的构建/测试砍在半路
        toolAlive: (now) => Number(entry.toolsRunning) > 0
          && now - (entry.progressAt ?? started) < Math.max(60_000, Number(runner.config.stallMs) || 360_000),
        onExtend: (ms) => log(`${bot.name} 收尾宽限到了，但工具还在出结果 → 再等 ${Math.round(ms / 1000)}s`),
        onHardTimeout: () => {
          timedOut = true;
          turnController.abort(new Error('模型请求超时'));
          entry.session.abort().catch(() => {});
          return new Error(`超过 ${Math.round((Date.now() - started) / 1000)}s 未完成，已中断`);
        },
        track: (handle) => { timeoutHandle = handle; },
      })]);
    } else {
      await runPromise;
    }
    checkCancelled();

    let finalText = render().trim();
    let emptyRecovered = false;
    if (responseFailure) throw new Error(responseFailure.error);
    if (!finalText && !stepCapHit) {
      const stepDigest = steps.length
        ? `\n\n你刚才实际执行了这些操作：\n${steps.map((s) => `- ${s.tool} ${s.detail ?? ''}`.slice(0, 160)).join('\n')}`
        : '';
      const userContent = `下面是你（另一个模型）接到的任务：\n\n${prompt.slice(0, 6000)}${stepDigest}\n\n请用几句话给出结论。`;
      const recovery = await recoverModelReply({
        signal: turnController.signal,
        isCancelled: cancelled,
        failure: responseFailure,
        nudge: () => entry.session.prompt(steps.length
          ? '请用一两句话说明刚才操作的结果，不要调用工具。'
          : '请直接用文字回答刚才的问题，不要调用工具。'),
        readText: () => render(),
        readFailure: () => responseFailure,
        models: fallbackModels(entry.session.model, fallbackModel),
        complete: async (model, signal) => {
          try {
            const reply = await runner.modelRuntime.completeSimple(
              model,
              {
                systemPrompt: `${bot.persona ?? ''}\n\n你是「${bot.name}」。直接给结论，不要客套。`,
                messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
              },
              { maxTokens: Math.min(2048, model.maxTokens ?? 2048), signal },
            );
            meter.add(reply?.usage);
            usage = meter.snapshot();
            return reply;
          } catch (error) {
            meter.add(error?.usage);
            usage = meter.snapshot();
            throw error;
          }
        },
      });
      if (recovery.failure) {
        responseFailure = recovery.failure;
        throw new Error(recovery.failure.error);
      }
      finalText = recovery.text;
      emptyRecovered = recovery.recovered;
    }
    checkCancelled();

    // ★ 这一轮已经用 send_image 手动发过的文件不再自动带（Mac 实机 UX-2）
    const sentFiles = entry?.sentFiles instanceof Set ? entry.sentFiles : null;
    const produced = beforeImages
      ? collectNewImages(runner.config.workspace, beforeImages, {
          save: saveFromPath,
          excludePaths: sentFiles,
          onError: (err) => log('自动附图失败：', err?.message || err),
        })
      : [];

    if (runner.config.autoAttachArtifacts !== false && beforeFiles) {
      try {
        for (const item of collectArtifacts(runner.config.workspace, beforeFiles, { excludePaths: sentFiles })) {
          try {
            produced.push(saveFromPath(item.file));
          } catch (err) {
            log(`自动带产物失败（${item.rel}）：`, err?.message || err);
          }
        }
      } catch (err) {
        log('自动带产物失败：', err?.message || err);
      }
    }

    // 交付记录（任务回执 / SDK artifacts）要包含手动 send_image 的那几张：
    // 它们确实交付了，只是不该在聊天里再出现一次。
    collectedArtifacts = [...produced, ...(Array.isArray(entry?.sentMetas) ? entry.sentMetas : [])];

    // ★ 没有正文、只产出了附件（例如只跑了一个工具就结束）：同样要落位。
    //   否则这条"只有图/文件"的气泡会插在正在流式的 bot 上面（P2-2）。
    if (!hasEmittedVisibleText && collectedArtifacts.length) claimOrder();

    // ★ 收尾兜底（D1 第 3 条）：走到这里还有 pendingReseat，说明插话之后
    //   这一轮**没有任何新的 assistant 轮**（纯工具 / 直接结束）。此时只能把旧气泡
    //   封口，**不能**再建一条 —— 否则下面把缓存的 finalText 写进新气泡就是复制一份。
    reseatAtBoundary(false);

    if (!finalText && !stepCapHit) {
      // 没有正文就结束：残留的 running 步骤必须收敛，否则气泡永远停在转圈
      settleRunningSteps(steps, '模型没有返回内容，这一步没有结果');
      const digest = steps.length
        ? `（${bot.name} 执行了 ${steps.length} 步但没有给出说明）\n\n${steps
            .map((s) => `- \`${s.tool}\` ${s.detail ?? ''}`)
            .join('\n')}`
        : '';
      const msg = runner.store.updateMessage(
        roomId,
        botMsg.id,
        {
          text: digest,
          status: 'error',
          error: '模型没有返回可展示内容，也未提供明确错误，请检查接口状态与模型配置。',
          steps,
          usage,
          attachments: produced,
        },
        { silent: true },
      );
      runner.bus.emit('event', { t: 'msg.error', roomId, msgId: botMsg.id, error: msg.error, msg });
      runner.recordRun({
        roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'empty',
      });
      return withAttempt({
        ok: false,
        text: '',
        ms: Date.now() - started,
        error: msg.error,
        messageId: botMsg.id,
      }, { empty: true, usage: usage ?? null });
    }

    if (!finalText) finalText = '（在群里动手步数到上限，先收住）';
    if (emptyRecovered) finalText = `${finalText}\n\n_（原模型首次没出内容，已自动重试）_`;

    // ★ 这一段是「让出待续」还是「做完了」：
    //   · 受管：软截止后自己收住、又没申请完成 → 让出（推进器排下一段，不是失败）；
    //   · 非受管：收尾通知后它写了续段标记、或者硬撞了步数上限 → 自动接着跑下一段。
    const completedNow = reports?.appliedCompletion?.() === true;
    const sliceYield = isManaged && sliceEnding && !stepCapHit && !completedNow;
    const marked = extractContinuation(finalText);
    if (marked.wanted) finalText = marked.text || '（这一段先做到这里）';
    const continueWanted = !isManaged && autoContinueOn
      && ((sliceEnding && marked.wanted) || stepCapHit);
    const continuing = continueWanted || sliceYield || (isManaged && stepCapHit);
    if (continueWanted) continuationPlan = { reason: stepCapHit ? 'steps' : 'time' };

    settleRunningSteps(steps, '本轮结束，这一步没有返回结果');

    const changed = changes();
    const msg = runner.store.updateMessage(
      roomId,
      botMsg.id,
      {
        text: continuing
          ? `${finalText}\n\n${CONTINUE_NOTE}`
          : stepCapHit
            ? `${finalText}\n\n_（部门里一次最多来回 ${turnCap} 轮，已收住；要它继续做完就在私聊里派活）_`
            : finalText,
        status: 'done',
        steps,
        usage,
        attachments: produced,
        meta: { ...(botMsg.meta ?? {}), ...(changed ? { changed } : {}), ...(continuing ? { continuing: true } : {}) },
      },
      { silent: true },
    );
    runner.bus.emit('event', { t: 'msg.done', msg });
    runner.recordRun({
      roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
      taskRunId, attemptIndex, sdkRetries: meter.retries,
      ...(sliceEnding ? { kind: 'slice' } : {}),
    });
    turnSucceeded = true;
    return withAttempt({
      ok: true,
      text: finalText,
      ms: Date.now() - started,
      messageId: botMsg.id,
      // 这一段真实改动了几个文件：推进器据此区分「在干活」和「卡住了」
      work: { files: Number(changed?.total ?? 0) },
      ...(continuationPlan ? { continuation: continuationPlan } : {}),
    }, {
      usage: meter.snapshot(),
      artifacts: artifactPathsOf(produced),
      stepCapHit: stepCapHit || sliceYield,
      needsApproval: firstNewApproval(),
    });
  } catch (err) {
    const failure = cancelled() ? modelFailure(turnController.signal.reason ?? { name: 'AbortError' })
      : responseFailure ?? modelFailure(err);
    const current = runner.store.getMessage(roomId, botMsg.id);
    const previousError = current?.error;
    const message = failure.aborted && previousError === '已按你的要求终止'
      ? previousError
      : withModelHint(failure.error, runner.store.getBot(botId)?.model || runner.modelLabel?.() || '');
    const keepAborted = cancelled() && current?.status === 'aborted';
    const partial = render().trim();
    if (stepCapHit) {
      settleRunningSteps(steps, '步数到上限，这一步没有返回结果');
      // 步数硬上限：受管由推进器按「让出」续跑；非受管（没关续段的）自动接着跑下一段
      const capContinue = !isManaged && autoContinueOn && !cancelled();
      if (capContinue) continuationPlan = { reason: 'steps' };
      const capChanged = changes();
      const capPartial = extractContinuation(partial).text;
      const msg = runner.store.updateMessage(
        roomId,
        botMsg.id,
        {
          text: (isManaged || capContinue)
            ? `${capPartial || '（这一段步数用完了）'}\n\n${CONTINUE_NOTE}`
            : `${capPartial || '（在群里来回轮数到上限，先收住）'}\n\n_（部门里一次最多来回 ${turnCap} 轮，已收住）_`,
          status: 'done',
          steps,
          usage,
          meta: { ...(botMsg.meta ?? {}), ...(capChanged ? { changed: capChanged } : {}) },
        },
        { silent: true },
      );
      runner.bus.emit('event', { t: 'msg.done', msg });
      runner.recordRun({
        roomId, botId, startedAt: started, ok: true, usage: meter.snapshot(),
        taskRunId, attemptIndex, sdkRetries: meter.retries, kind: 'step-cap',
      });
      // 轮数到上限也算"跑完了"（真实落出了回复），只是被收住 —— 照样可以评估
      turnSucceeded = true;
      return withAttempt({
        ok: true,
        text: capPartial,
        ms: Date.now() - started,
        messageId: botMsg.id,
        work: { files: Number(capChanged?.total ?? 0) },
        ...(continuationPlan ? { continuation: continuationPlan } : {}),
      }, {
        usage: meter.snapshot(),
        artifacts: artifactPathsOf(collectedArtifacts),
        stepCapHit: true,
      });
    }
    const changedOnce = changes();
    const recoverable = retryManaged && !keepAborted && !cancelled()
      && isRecoverableFailure({ error: message, status: failure.status ?? null });
    // ★ 报错 / 中止 / 待重试：最后一个工具不会有 tool_execution_end，
    //   不收敛就会留下一条永远「正在干活…」的气泡（客户端 isLive 只是第二道闸）。
    settleRunningSteps(steps, recoverable ? '本轮要在重试，这一步没有返回结果' : '本轮中断，这一步没有结果');
    const msg = runner.store.updateMessage(
      roomId,
      botMsg.id,
      {
        text: recoverable
          ? (partial || '接口临时不稳定，正在重试…')
          : partial,
        status: keepAborted
          ? 'aborted'
          : (recoverable ? 'retrying' : 'error'),
        error: recoverable ? null : message,
        steps,
        usage,
        meta: {
          ...(botMsg.meta ?? {}),
          ...(changedOnce ? { changed: changedOnce } : {}),
          ...(recoverable ? { retrying: true } : {}),
          ...(recoverable ? { retryPlaceholder: !partial } : {}),
        },
      },
      { silent: true },
    );
    runner.bus.emit('event', {
      t: keepAborted || recoverable ? 'msg.updated' : 'msg.error',
      roomId,
      msgId: botMsg.id,
      error: message,
      msg,
    });
    // ★ 真实上游原因优先取 responseFailure 上的 detail。
    //
    //   `message_end` 报 `{ stopReason: 'error', errorMessage: '400 invalid_request_error:
    //   thinking budget too low' }` 时，抛出来的只是 `new Error(给人看的那句话)` ——
    //   里面没有上游原文。以前因此 detail 只剩「接口详情已隐藏」，server.log 也是同一句：
    //   用户照提示去看日志，看到的还是「请看日志」。现在两条路都带上脱敏 detail。
    const diagDetail = responseFailure?.detail || failure.detail || formatFailureDetail(err);
    const diagCode = responseFailure?.code || err?.code || err?.cause?.code || '';
    log(`模型本轮出错：${message}${diagDetail ? ` [${diagDetail}]` : ''}`);
    recordFailure(runner.diagnostics ?? null, {
      phase: 'turn',
      roomId,
      roomName: runner.store.getRoom(roomId)?.name ?? '',
      botId: bot.id,
      botName: bot.name,
      model: runner.store.getBot(botId)?.model || runner.modelLabel?.() || '',
      status: failure.status ?? null,
      code: diagCode,
      summary: message,
      detail: diagDetail,
      ms: Date.now() - started,
    });
    runner.recordRun({
      roomId, botId, startedAt: started, ok: false, usage: meter.snapshot(),
      taskRunId, attemptIndex, sdkRetries: meter.retries, kind: recoverable ? 'retrying' : 'error',
    });
    return withAttempt({
      ok: false,
      text: partial,
      ms: Date.now() - started,
      error: message,
      status: failure.status ?? null,
      messageId: botMsg.id,
    }, {
      cancelled: (cancelled() || keepAborted) && !timedOut,
      aborted: failure.aborted === true && !timedOut,
      timedOut: timedOut || failure.timedOut === true,
      usage: meter.snapshot(),
      artifacts: artifactPathsOf(collectedArtifacts),
    });
  } finally {
    // 定时器回调可能还挂着：标记结束，回调里一律不再动会话（不再 steer / abort）
    runFinished = true;
    runner.releaseReportScope(scopeKey, reports);
    if (entry) entry.managedContext = null;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    unsubscribe?.();
    entry.unsubscribe = null;
    entry.busy = false;
    if (managedCancelTask) {
      const current = runner.managedInflight.get(managedCancelTask);
      if (!current || current.attemptId === (managed.context?.attemptId ?? null)) {
        runner.managedInflight.delete(managedCancelTask);
      }
    }
    // ★ 先**取出**本轮聚合键再清理（顺序反了就永远是空串 —— 封口变死代码，
    //   所有直派批次都会永久卡在 dispatchOpen=true）。
    const originTurnKey = entry.originTurnKey || '';
    // 汇总轮标记与聚合键只活在这一轮里：异常退出也不能污染下一轮
    entry.summaryTurn = false;
    entry.originTurnKey = null;
    // 发起轮封口：这一轮登记出来的批次必须 `dispatchOpen=false` 才能就绪。
    // 部门回得比派活快是常态，不封口就会出现"汇总里漏掉后面那个部门"。
    if (bot?.role === 'main' && !isSummaryTurn && originTurnKey) {
      try {
        runner.store.sealChiefSummariesForTurn(originTurnKey, {
          mainBusy: isMainChatBusy(runner, roomId, bot.id),
        });
      } catch (err) {
        log('封口主控汇总失败：', err?.message || err);
      }
    }
    setTimeout(() => { void runner.drainRequestQueue(roomId, botId); }, 0);
    // ★ 非受管私聊：这一段到点让出、还没做完 → 自动接着跑下一段（有上限）。
    //   群聊由编排器把它重新排进队列；受管任务由推进器按「让出」续跑。
    if (continuationPlan && !groupTurn && !isManaged) {
      scheduleDmContinuation(runner, roomId, botId, {
        epoch: deliveryEpochAtStart,
        n: Number(meta?.continuation ?? 0) + 1,
        reason: continuationPlan.reason,
      });
    }
    // 这一轮结束后，把排队等发送的主控汇总消费掉（汇总轮自己不再触发，防递归）
    if (bot.role === 'main' && !isSummaryTurn) {
      setTimeout(() => { void runner.drainChiefSummaries?.().catch?.(() => {}); }, 0);
    }
    entry.turnController = null;
    entry.liveMsgId = null;
    entry.startedAt = null;
    entry.toolsRunning = 0;
    entry.goalText = '';
    entry.liveSteps = null;
    entry.liveDraft = null;
    entry.turnAmends = null;
    // ★ 必须清（D2）：本轮若挂着 pendingReseat 就超时/报错/被 abort，
    //   标志会残留在持久化的 entry 上，下一轮一吐字就被强行封口挪走。
    entry.pendingReseat = null;
    // 本轮"已手动发过"的去重表只活在这一轮：清了下次才不会被上一轮的路径挡住
    entry.sentFiles = null;
    entry.sentMetas = null;
    entry.slotTicket?.release?.();
    entry.slotTicket = null;
    runner.bus.emit('event', { t: 'typing', roomId, botId: bot.id, active: false, lane: 'work', msgId: botMsg?.id ?? null });
    emitContext(roomId, bot.id, entry.session, runner.bus);
    // SIM-Lite：本轮注入过经验才做一次独立评估（win/fail 的唯一合法来源之一）。
    // 先把快照摘走再交给后台：`drainRequestQueue` 会立刻起下一轮，
    // 留在 entry 上会被下一批注入覆盖掉，导致少记/错记。
    if (entry.lessonsInjected) {
      const injected = entry.lessonsInjected;
      entry.lessonsInjected = null;
      // 失败/终止轮只清痕迹、不评估：没有可信的因果，硬评只会制造噪音。
      if (turnSucceeded) {
        void Promise.resolve(
          runner.reflect?.evaluateInjected?.({ roomId, botId: bot.id, injected }),
        ).catch(() => {});
      }
    }
    if (bot.role === 'main') {
      try { runner.store.redactRoomSecrets(roomId, [], { limit: 8 }); } catch {}
    }
    runner.maybeAutoSummarize(roomId, bot.id);
    // 生命周期（T2.4）：这一轮结束 → 房间真的安静下来时发 `run.settled`。
    // 去抖与"安静"判定都在 PiRunner.scheduleRunSettled 里：finally 里还会
    // setTimeout(0) 去 drain 排队请求 / 主控汇总，同步发会误报。
    scheduleRunSettled(runner, roomId, {
      botId: bot.id,
      ok: turnSucceeded,
      reason: turnSucceeded ? 'turn_done' : 'turn_failed',
    });
  }
}

/**
 * 把「这一轮的在途气泡」按插话位置重新安置（P0-2 情形 B 的落地实现）。
 *
 * 为什么单独抽出来：它要同时做四件事（封口旧条、清空草稿、新开一条、
 * 把新条挪到插话之后），而它只在**流式过程中**被触发 —— 端到端跑需要真模型。
 * 抽成函数后可以直接单测：给定一条已写正文的 bot 消息 + 一条 user 插话，
 * 断言旧条定稿、新条排在 user 之后、且新条从空开始（内容不重复）。
 *
 * @returns {object|null} 新建的那条消息；没有待换条任务时返回 null
 */
/**
 * 把残留的 `running` 步骤收敛成 `error`（Mac 实机 UX-1）。
 *
 * 模型报错 / 被中止 / 命中步数上限 / 换条封口时，最后一个工具可能**没有**
 * `tool_execution_end`（SDK 抛错、进程被杀、用户中断）。这些步骤会以
 * `status: 'running'` 落库，客户端就一直显示「正在干活…」—— 用户看到一条
 * 永远不动的气泡，重开历史也还是转圈。
 *
 * @param {Array<object>} steps 就地修改（调用方拿到的就是要落库的那个数组）
 * @param {string} reason 写进 `step.error`
 * @returns {Array<object>}
 */
export function settleRunningSteps(steps, reason = '这一步没有返回结果（本轮已结束）') {
  if (!Array.isArray(steps)) return steps;
  const now = Date.now();
  for (const step of steps) {
    if (step?.status !== 'running') continue;
    step.status = 'error';
    step.error = reason;
    step.durationMs = Math.max(0, now - Number(step.startedAt ?? now));
  }
  return steps;
}

export function applyPendingReseat({
  store, roomId, entry, botMsgId, render, meta = null, bot, bus = null, log: logFn = () => {},
  resetDraft = null,
  /** 这一轮已产生的工具步骤：封口旧气泡时要一起写进去，否则会被清空丢弃（D1 第 3 条） */
  steps = null,
  /** false = 只封口旧气泡，不新建（收尾兜底用，避免复制出第二份内容） */
  createNext = true,
} = {}) {
  const pending = entry?.pendingReseat;
  if (!pending) return null;
  entry.pendingReseat = null;

  const sealed = typeof render === 'function' ? render() : '';
  // 封口旧气泡时，旧的 running 步骤归旧气泡 —— 一起收敛，别让它在历史里转圈
  if (Array.isArray(steps)) settleRunningSteps(steps, '这条气泡已封口，这一步没有返回结果');
  const oldMsg = store.getMessage(roomId, botMsgId);
  try {
    store.updateMessage(roomId, botMsgId, {
      text: sealed,
      status: 'done',
      // ★ 工具步骤属于这一轮：封口时一并写进去，别让随后的 resetDraft 把它们清丢
      ...(Array.isArray(steps) ? { steps: [...steps] } : {}),
      meta: { ...(oldMsg?.meta ?? {}), reseatAfterId: pending.afterId },
    }, { silent: false });
  } catch (err) {
    logFn('封口旧气泡失败：', err?.message || err);
  }

  if (typeof resetDraft === 'function') resetDraft();

  // 收尾兜底：只封口，不新建 —— 否则调用方接着把同一份 finalText 写进新气泡就是复制
  if (!createNext) return null;

  let next;
  try {
    next = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot?.id ?? null,
      authorName: bot?.name ?? '',
      authorEmoji: bot?.emoji ?? null,
      text: '',
      status: 'streaming',
      meta: { ...(meta ?? {}), continuedFrom: botMsgId },
    });
  } catch (err) {
    logFn('插话后新建气泡失败：', err?.message || err);
    return null;
  }
  store.moveMessageAfter(roomId, next.id, pending.afterId, { touch: true });
  entry.liveMsgId = next.id;
  // ★ 不再手动补发 msg.new：store.appendMessage 内部已经发过一次（D3 第 1 条）。
  //   重复广播会让总线 / SDK 订阅者收到两条同样的新建事件。
  bus?.emit?.('event', { t: 'typing', roomId, botId: bot?.id ?? null, active: true, lane: 'work', msgId: next.id });
  return next;
}
