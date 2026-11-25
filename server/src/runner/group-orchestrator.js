/**
 * 群组（部门）多智能体并发轮次编排子模块。
 *
 * 收敛：
 *   1. 房间级串行锁与代数失效（`dispatchGroupRound` / `drainGroupRounds` / `interruptRoundForUser`）；
 *   2. 便宜同步 + Jev 兜底的发言判断（`shouldBotReplySync` / `askShouldReply`）；
 *   3. 受管单次执行（`runManagedOnce`）与非受管群波次并发调度、熔断重试、PASS 剔除及老大收尾轮（`executeGroupRound`）。
 *
 * 约定：所有实际触发单 Bot 运行的调用均经由 `runner.run(...)` 与 `runner.runRound(...)`，
 * 保持对外部测试桩与原型拦截的 100% 兼容。
 */
import { log, newId, isSuperiorCall } from '../util.js';
import { pickDepartmentDelivery, pickLeadResult } from '../chief-summary.js';
import { isMainChatBusy } from './chief-summary-runner.js';
import { shouldMirrorProgress, mirrorProgress, MIRROR_SKIPPED_NO_DM } from '../dm.js';
import { settleRetryMessage } from '../retry-messages.js';
import { decideRetry, failureNote, retryHint, transientBackoffMs } from '../retry-policy.js';
import { planFallbackForBot } from './model-fallback.js';
import { continuationPrompt } from '../turn-continuation.js';
import {
  isUpstreamTransient,
  retrySchedulerFor,
  cancelGroupRetries,
  resetGroupRetryBackoff,
  describeWait,
} from './group-retry.js';
import {
  canRequest as breakerAllows,
  breakerNote,
  BREAKER_STATE,
} from '../circuit-breaker.js';
import { parseMentions } from '../mentions.js';
import { decide as decidePoint, interpretShouldReply, shouldAskShouldReply, shouldUseJev } from '../decision-router.js';
import { planItem, shouldStopRound, leftBehind, planClosing, isUserInitiatedRound } from '../group-round.js';
import { resolveManagedContext, MANAGED } from '../tasks/task-progress.js';
import { STOP } from '../tasks/task-contract.js';
import {
  composeGroupPrompt,
  departmentOf,
  isStrictlyAfter,
  lastDoneIdOf,
  lastDoneIndexAll,
  lastMessageId,
  openingSpeakers,
  transcriptFor,
} from '../group-prompt.js';
import { RETRY_DELAY_MS, sessionKey } from './runner-utils.js';

// 供外观层（`pi-runner.js` 的 abort / disposeAll）直接取消挂起的续派，不必再造入口
export { cancelGroupRetries, cancelAllGroupRetries } from './group-retry.js';

export function roundEpoch(runner, roomId) {
  return runner.roundEpochs.get(roomId) ?? 0;
}

/** 用户在群里插话：代数 +1，打断本轮在跑会话，当场把正在写消息标成 aborted。 */
export function interruptRoundForUser(runner, roomId) {
  runner.roundEpochs.set(roomId, roundEpoch(runner, roomId) + 1);
  // 用户插话 = 旧要求作废：挂着的上游续派必须跟着取消，否则会发「幽灵续派」
  cancelGroupRetries(runner, roomId, '用户插话');

  let n = 0;
  const botIds = [];
  for (const [key, entry] of runner.sessions) {
    if (!key.startsWith(`${roomId}:`)) continue;
    if (!entry.session || !entry.busy) continue;
    const botId = key.slice(roomId.length + 1);
    botIds.push(botId);
    if (entry.compactingOnly) {
      entry.turnController?.abort();
      n++;
      continue;
    }
    try {
      entry.turnController?.abort();
      entry.session.abort?.().catch(() => {});
      n++;
    } catch {}
  }

  if (botIds.length) {
    for (const msg of runner.store.listMessages(roomId, { limit: 200 })) {
      if (msg.status !== 'streaming') continue;
      if (!botIds.includes(msg.authorId)) continue;
      runner.store.updateMessage(
        roomId,
        msg.id,
        {
          status: 'aborted',
          error: '已按你的要求终止',
          steps: (msg.steps ?? []).map((s) =>
            s?.status === 'running' ? { ...s, status: 'error', error: '已终止' } : s,
          ),
        },
        { silent: false },
      );
    }
    for (const id of botIds) {
      runner.bus.emit('event', { t: 'typing', roomId, botId: id, active: false });
    }
  }

  if (n) log(`已打断 ${n} 个正在跑的会话（用户插话，旧轮作废）`);
}

export async function dispatchGroupRound(
  runner,
  roomId,
  text,
  files,
  { fromUpstreamRetry = false } = {},
) {
  const roomName = runner.store.getRoom(roomId)?.name ?? roomId;
  // 来了新消息（或本函数自己就是续派）：先把旧的挂起续派撤掉，一轮只留一个。
  // ★ 续派自己进来时**不能清退避累计** —— 清了就等于每轮都从第一档重来，
  //   持续限流时永远走不到上限，也没有真正的退避。
  cancelGroupRetries(runner, roomId, '本轮重新开始', { resetBackoff: !fromUpstreamRetry });
  // ★ 只有「已经有 drainGroupRounds 在跑」才允许入队。
  //
  //   以前条件是 `roundLocks.has || isRoomBusy`，而 `isRoomBusy` 可能是真的忙、
  //   却没有 drain 循环在消费队列（受管 TaskRun 在跑、或上一轮 awaitPending 5s
  //   超时放锁后残留的忙会话）。那种情况下把消息塞进 `roundQueue` 再返回，
  //   等于扔进黑洞：用户 @ 完 bot 直接"断开"、连一条错误气泡都没有
  //   （Mac 实机 UX-3 根因 1）。
  if (runner.roundLocks.has(roomId)) {
    log(`【${roomName}】用户插话 → 打断进行中的一轮，按新要求重来`);
    interruptRoundForUser(runner, roomId);
    runner.roundQueue.delete(roomId);
    runner.mergeQueue.drop(roomId);
    runner.roundQueue.set(roomId, { text, files: [...files] });
    return;
  }

  // ★ 先加锁、再做任何 `await`。
  //
  //   以前是"检查忙 → await 一下 → 才加锁"：两个并发调用都能在加锁前通过上面的
  //   `roundLocks.has` 检查，各自起一轮 drain —— 双锁并发、消息互相 steer。
  runner.roundLocks.add(roomId);
  try {
    if (runner.isRoomBusy(roomId)) {
      // 忙，但没有 drain 循环：打断旧会话后**自己持锁起一轮**，绝不入队。
      log(`【${roomName}】房间里还有会话在忙（没有 drain 循环）→ 打断它并直接开新的一轮`);
      interruptRoundForUser(runner, roomId);
      runner.roundQueue.delete(roomId);
      runner.mergeQueue.drop(roomId);
      // 有界短轮询等旧会话真的退出（最多 1.5s，每 25ms 看一次）：
      //   只 `setTimeout(0)` 不够 —— 旧轮可能还在收尾，新轮会和它抢同一个 entry
      //   （被当成"插话"steer 进去，用户看到新消息没被单独回）。
      const deadline = Date.now() + 1500;
      while (runner.isRoomBusy(roomId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await drainGroupRounds(runner, roomId, { text, files });
  } finally {
    // drainGroupRounds 自己也会放；这里兜底一次（delete 是幂等的），
    // 保证它抛异常时不会把锁泄漏在房间里。
    runner.roundLocks.delete(roomId);
  }
}

async function drainGroupRounds(runner, roomId, first) {
  let next = first;
  try {
    while (next) {
      try {
        const { promptText } = await runner.buildInput(next.text, next.files, roomId);
        await runner.runRound(roomId, {
          openerText: next.text,
          attachmentContext: promptText,
          attachments: next.files,
        });
      } catch (err) {
        log('runRound 异常：', err?.stack || err);
      }
      next = runner.roundQueue.get(roomId) ?? null;
      if (next) runner.roundQueue.delete(roomId);
    }
  } finally {
    runner.roundLocks.delete(roomId);
  }
}

function mirrorGroupProgress(runner, progress) {
  try {
    const result = mirrorProgress({ store: runner.store, ...progress });
    if (result === MIRROR_SKIPPED_NO_DM) {
      log(
        `私聊回执跳过：${progress.bot?.name ?? '某个 bot'} 还没和用户开过私聊 — ` +
          '在侧边栏点开它一次，之后的部门回执才会同步到这里',
      );
    }
  } catch (err) {
    log('私聊进度回执失败：', err?.message || err);
  }
}

async function awaitPending(pending, stale, { graceMs = 5000, pollMs = 100 } = {}) {
  if (!pending.length) return;
  let settled = false;
  const all = Promise.allSettled(pending).then(() => {
    settled = true;
  });
  const watch = (async () => {
    while (!settled) {
      if (stale()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  })();
  const wentStale = await Promise.race([watch, all.then(() => false)]);
  if (!wentStale || settled) return;
  await Promise.race([all, new Promise((r) => setTimeout(r, graceMs))]);
  if (!settled) {
    log(`用户已插话/终止：旧轮还有 ${pending.length} 个会话没退出，先释放房间锁`);
  }
}

function shouldBotReplySync(runner, { room, roomId, item, bot, isOpening = false }) {
  if (runner.aborting.has(roomId)) return false;
  // 续段：它上一段自己说了还没做完，不需要再判「该不该发言」
  if (Boolean(item?.fromId) || isOpening || Number(item?.continuation) > 0) return true;

  const settings = (() => {
    try { return runner.store.decisionRoute(); } catch { return {}; }
  })();
  const gate = shouldUseJev('should-reply', settings);
  const throttleKey = `${roomId}:${bot.id}:${item?.sourceMessageId ?? ''}`;

  const { ask, why } = shouldAskShouldReply({
    addressed: false,
    enabled: gate.use,
    alreadyAsked: runner.shouldReplyAsked.has(throttleKey),
  });
  if (!ask) {
    const cached = runner.shouldReplyAsked.get(throttleKey);
    if (cached === false) {
      log(`【${room.name}】${bot.name} 不发言：${why}`);
      return false;
    }
    return true;
  }
  return null;
}

function rememberShouldReply(runner, key, value) {
  if (runner.shouldReplyAsked.size > 500) {
    const keys = [...runner.shouldReplyAsked.keys()].slice(0, 250);
    for (const k of keys) runner.shouldReplyAsked.delete(k);
  }
  runner.shouldReplyAsked.set(key, value);
}

async function askShouldReply(runner, { room, roomId, item, bot }) {
  const throttleKey = `${roomId}:${bot.id}:${item?.sourceMessageId ?? ''}`;
  const settings = (() => {
    try { return runner.store.decisionRoute(); } catch { return {}; }
  })();

  let decision;
  try {
    decision = await decidePoint('should-reply', {
      message: String(item?.fromText || item?.reason || '').slice(0, 2000),
      recent: runner.store.listMessages(roomId, { limit: 8 })
        .filter((m) => m.authorType !== 'system')
        .map((m) => `${m.authorName || '用户'}：${String(m.text ?? '').slice(0, 300)}`),
      botName: bot.name,
    }, settings, { timeoutMs: 4000 });
  } catch (err) {
    log(`【${room.name}】${bot.name} 的 should-reply 判断抛错：`, err?.message || err);
    rememberShouldReply(runner, throttleKey, false);
    return false;
  }

  const { run, why: verdict } = interpretShouldReply(decision);
  rememberShouldReply(runner, throttleKey, run);
  log(`【${room.name}】${bot.name} should-reply=${run}：${verdict}`);
  return run;
}

async function runManagedOnce(runner, {
  room,
  botId,
  managedContext,
  openerText = '',
  openerBotId = null,
  openerName = '用户',
  attachments = [],
  attachmentContext = null,
  kickoff = false,
} = {}) {
  const roomId = room.id;
  const bot = runner.store.getBot(botId);
  if (!bot) {
    return { ok: false, code: 'MANAGED_TARGET_MISSING', error: '受管目标 Bot 不存在', stop: STOP.failed };
  }

  const dept = departmentOf(room, runner.store);
  const fresh = transcriptFor(roomId, botId, undefined, { store: runner.store });
  const prompt = composeGroupPrompt(room, bot, fresh, {
    isLead: botId === (dept.leadId ?? null),
    reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? openerName + ' 叫了你' : '用户发了新消息',
    members: dept.members,
    leadId: dept.leadId,
    order: { index: 1 },
  });

  const taskPrompt = typeof openerText === 'string' && openerText.trim() ? openerText.trim() : '';
  const composed = [taskPrompt, prompt].filter(Boolean).join('\n\n');

  const key = sessionKey(roomId, botId);
  const managedTaskRun = managedContext?.taskRunId ?? null;
  runner.dispatching.add(key);
  if (managedTaskRun) {
    const entry = runner.sessions.get(key);
    runner.managedInflight.set(managedTaskRun, {
      key, botId, roomId, session: entry?.session ?? null, attemptId: managedContext?.attemptId ?? null,
    });
  }
  try {
    const res = await runner.run(roomId, botId, attachmentContext ? attachmentContext + '\n\n' + composed : composed, {
      groupTurn: true,
      retryManaged: true,
      taskRunId: newId('run_'),
      attemptIndex: 1,
      attachments,
      managedContext,
      human: !openerBotId,
    });
    return res;
  } catch (err) {
    log('【' + room.name + '】受管单次执行异常：', err?.message || err);
    return {
      ok: false,
      code: 'MANAGED_EXECUTION_FAILED',
      error: err?.message || String(err),
      reason: '执行失败：' + String(err?.message ?? err).slice(0, 200),
      stop: STOP.failed,
    };
  } finally {
    runner.dispatching.delete(key);
    if (managedTaskRun) runner.managedInflight.delete(managedTaskRun);
  }
}

/** 群（部门）一轮并发波次编排入口。 */
export async function executeGroupRound(
  runner,
  roomId,
  {
    openerText = '',
    openerBotId = null,
    openerMessageId = null,
    openerName = '用户',
    kickoff = false,
    attachments = [],
    attachmentContext = null,
    managedContext = null,
    summary = null,
  } = {},
) {
  const room = runner.store.getRoom(roomId);
  if (!room || room.kind !== 'group') return;
  const { members, leadId } = departmentOf(room, runner.store);
  if (!members.length) return;

  const isManagedRound = managedContext !== null && managedContext !== undefined;

  if (isManagedRound) {
    const probe = resolveManagedContext(managedContext, {
      loadTaskRun: (id) => runner.store.taskRuns.read(id),
      loadRootTaskRun: (id) => runner.store.taskRuns.read(id),
    });
    if (probe.kind === MANAGED.invalid) {
      return {
        ok: false,
        code: 'INVALID_MANAGED_CONTEXT',
        error: `受管执行上下文不合法：${probe.text}`,
        stop: STOP.failed,
      };
    }

    if (!members.some((m) => m.id === probe.context.botId)) {
      return {
        ok: false,
        code: 'MANAGED_TARGET_NOT_IN_DEPARTMENT',
        error:
          `受管执行上下文授权给 ${probe.context.botId}，但这次部门里没有它 ——` +
          '不能把这份授权用于别的成员',
        stop: STOP.failed,
      };
    }

    return runManagedOnce(runner, {
      room,
      botId: probe.context.botId,
      managedContext,
      openerText,
      openerBotId,
      openerName,
      attachments,
      attachmentContext,
      kickoff,
    });
  }

  const epoch = roundEpoch(runner, roomId);
  const stale = () => roundEpoch(runner, roomId) !== epoch;

  const opening = openingSpeakers(room, { text: openerText, openerBotId, kickoff, store: runner.store });
  const openingSet = new Set(opening);
  if (!opening.length) return;

  const limits = runner.store.groupLimits();
  const budget = (botId) => (botId === leadId ? limits.leadTurns : limits.memberTurns);
  const used = new Map();
  const called = new Set(opening);
  const chiefId = runner.store.mainBot()?.id ?? null;
  const queue = opening.map((botId) => ({
    botId,
    reason: kickoff ? '部门刚成立，先由你安排' : openerBotId ? `${openerName} 叫了你` : '用户发了新消息',
    fromId: openerBotId ?? null,
    fromName: openerName,
    fromText: openerText,
    sourceMessageId: openerMessageId,
  }));

  log(
    `【${room.name}】${openerBotId ? `${openerName} 发言` : '用户发言'} → 首发：${opening
      .map((id) => runner.store.getBot(id)?.name ?? id)
      .join('、')}`,
  );

  const roundStartIndex = lastDoneIndexAll(roomId, runner.store);
  const roundStartMsgId = lastMessageId(roomId, runner.store);
  const participants = [leadId, ...members.map((m) => m.id)].filter(Boolean);

  let runs = 0;
  const pending = [];
  // 本轮成功产出（主控汇总回传的兜底：没有独立收尾轮时用它）
  const roundSuccesses = [];
  for (;;) {
    const stop = shouldStopRound({
      queueLen: queue.length,
      pendingLen: pending.length,
      runs,
      maxRuns: limits.maxRuns,
      aborting: runner.aborting.has(roomId),
      stale: stale(),
    });
    if (stop.stop) {
      const voided = stop.why === '已终止' || stop.why === '用户插话';
      if (queue.length) {
        log(
          voided
            ? `【${room.name}】⏹ ${stop.why}，剩下的 ${queue.length} 个人不再派`
            : `【${room.name}】⚠️ ${stop.why}，还有 ${queue.length} 个人没轮到：` +
                leftBehind(queue, (id) => runner.store.getBot(id)?.name ?? id).join('、'),
        );
      }
      if (voided) queue.length = 0;
      break;
    }
    if (!queue.length) {
      await awaitPending(pending.splice(0), stale);
      continue;
    }
    const item = queue.shift();
    const bot = runner.store.getBot(item.botId);
    if (!bot) continue;
    const done = used.get(item.botId) ?? 0;
    const busyNow = runner.isBusy(roomId, bot.id);
    const superior = isSuperiorCall({
      fromId: item.fromId,
      fromRole: item.fromId ? 'bot' : 'user',
      leadId,
      chiefId,
      selfId: bot.id,
    });
    const plan = planItem({
      item,
      name: bot.name,
      done,
      budget: budget(bot.id),
      busy: busyNow,
      superior,
      userRound: !item.fromId && isUserInitiatedRound({ openerBotId }),
    });
    if (plan.kind === 'skip') {
      log(`【${room.name}】${plan.why} → 不再叫它`);
      const byUser = !item.fromId;
      runner.store.appendMessage({
        roomId,
        authorType: 'system',
        authorName: '调度提示',
        text: byUser
          ? `${bot.name} 本轮已发言 ${done} 次（上限 ${budget(bot.id)} 次），` +
            '这次没有派发。发一条新消息可重置本轮预算，或在「部门预算」里调高每轮发言次数。'
          : `${bot.name} 本轮已发言 ${done} 次（上限 ${budget(bot.id)} 次），` +
            '这条 @ 没有派发。发一条新消息可重置本轮预算，或在「部门预算」里调高每轮发言次数。',
        status: 'done',
        meta: { via: 'turn_budget_skip', botId: bot.id, fromId: item.fromId ?? null },
      });
      continue;
    }
    if (plan.kind === 'interrupt' || plan.kind === 'queue') {
      const entry = runner.sessions.get(sessionKey(roomId, bot.id));
      if (plan.kind === 'interrupt' && entry?.session) {
        const userRound = isUserInitiatedRound({ openerBotId });
        const from = item.fromName || '上级';
        const steered = userRound
          ? `【用户叫停】用户刚发了新要求，**你手上那件立刻停下、不要再继续**。\n\n` +
            `用户说：\n${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
            '旧任务的产出作废，不要再补完、也不要再汇报旧进度。\n' +
            '直接按用户的新要求重新开始；如果这活不该你干，说一句就停，等负责人重新安排。'
          : `【${from} 叫停】先把你手上正在做的事停一下。\n\n` +
            `${from} 刚刚说：\n` +
            `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
            '请先回报一句：你现在做到哪一步了、还差什么。\n' +
            '然后按上面的新要求继续 —— 新要求优先于你手上正在做的事。';
        try {
          await entry.session.steer(steered);
          log(
            userRound
              ? `【${room.name}】用户新需求 → 叫停 ${bot.name}（旧活作废，按新的重来）`
              : `【${room.name}】上级改主意了 → 叫停 ${bot.name}（它正忙，让它先报进度再接新要求）`,
          );
          runner.store.appendMessage(
            {
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: '叫停回执',
              text: userRound
                ? `已让${bot.name}停下，按你的新要求重来。`
                : `已叫停${bot.name}：让它先报进度，再按新的要求继续。`,
              status: 'done',
              meta: {
                via: userRound ? 'steer_by_user' : 'steer_by_superior',
                fromId: item.fromId ?? null,
              },
            },
            { beforeStreaming: true },
          );
          continue;
        } catch (err) {
          log(`叫停 ${bot.name} 失败：${err?.message || err}`);
        }
      }
      log(`【${room.name}】${bot.name} 还在忙 → 等它空下来再派（${item.reason}）`);
      if (entry?.session?.followUp) {
        try {
          await entry.session.followUp(
            `【${item.fromName || '同事'} 找你】${item.fromName || '同事'} 刚在群里说：\n` +
              `${(item.fromText || '').slice(0, 1200) || '（看群里的最新消息）'}\n\n` +
              '你手上那件做完之后再处理这条（不急，但也别忘了）。',
          );
          log(`【${room.name}】把话投进 ${bot.name} 的 inbox（它在忙，忙完自己看）`);
          runner.store.appendMessage(
            {
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: '投递回执',
              text: `${bot.name} 正在忙：这句已经放进它的待办，忙完会看到。`,
              status: 'done',
              meta: { via: 'queued_for_busy', fromId: item.fromId ?? null },
            },
            { beforeStreaming: true },
          );
          continue;
        } catch (err) {
          log(`投递给 ${bot.name} 失败：${err?.message || err}`);
        }
      }
      const deadline = Date.now() + runner.config.groupBusyWaitMs;
      while (runner.isBusy(roomId, bot.id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (runner.isBusy(roomId, bot.id)) {
        log(`【${room.name}】${bot.name} 一直忙，这一单没派出去 → 上报`);
        runner.escalate({
          roomId,
          fromBotId: bot.id,
          reason: `要派给${bot.name}的活一直没派出去（它忙了 ${Math.round(runner.config.groupBusyWaitMs / 1000)} 秒以上）`,
          prefer: 'lead',
        }).catch((err) => log('上报失败：', err?.message || err));
        continue;
      }
    }
    used.set(item.botId, done + 1);
    runs++;
    const dispatchKey = sessionKey(roomId, bot.id);
    runner.dispatching.add(dispatchKey);

    const fresh = transcriptFor(roomId, bot.id, undefined, { store: runner.store });
    let prompt = composeGroupPrompt(room, bot, fresh, {
      isLead: bot.id === leadId,
      reason: item.reason,
      members,
      leadId,
      order: { index: runs },
      // 用户直接发起的一轮（不是同事派活）：提示词里不许诱导它 [PASS]
      // 没有派活人 = 这条是用户自己发的（或在收首轮）；有人 fromId 才是同事 @
      userAddressed: !item.fromId,
    });
    if (attachmentContext) prompt = `${attachmentContext}\n\n${prompt}`;
    // 续段：告诉它从断点接着做，不要把整件事从头再来
    if (Number(item.continuation) > 0) prompt = `${continuationPrompt({ n: item.continuation })}\n\n${prompt}`;

    pending.push(
      (async () => {
        try {
          const mirror = shouldMirrorProgress({
            roomKind: room.kind,
            fromId: item.fromId,
            botId: bot.id,
          });
          const progressSource = {
            dispatchId: newId('dispatch_'),
            sourceMessageId: item.sourceMessageId ?? null,
            fromId: item.fromId ?? null,
            fromName: item.fromName || (item.fromId ? (runner.store.getBot(item.fromId)?.name ?? '') : ''),
          };
          if (isManagedRound && managedContext.botId !== bot.id) {
            log(`【${room.name}】${bot.name} 跳过：本轮是受管执行，只跑 ${managedContext.botId}`);
            return;
          }

          const syncVerdict = shouldBotReplySync(runner, {
            room,
            roomId,
            item,
            bot,
            isOpening: openingSet.has(bot.id) && item.sourceMessageId === openerMessageId,
          });
          if (syncVerdict === false) return;
          if (syncVerdict === null) {
            if (!(await askShouldReply(runner, { room, roomId, item, bot }))) return;
            if (runner.aborting.has(roomId)) return;
          }

          // ★ 不再往旧 TaskItem 写派活流水：任务板/顶栏浮层现在只读 TaskRun，
          //   再写一份就是双轨。受管任务的账本在 taskRuns，未受管波次不再登记。
          const taskId = null;
          runner.flushProviderUpdates();
          const gate = runner.breakerFor(bot.id);
          const gateCheck = gate ? breakerAllows(gate.breaker, Date.now()) : { allow: true };
          const taskRunId = newId('run_');

          const itemManaged = isManagedRound ? managedContext : null;
          let res;
          if (!gateCheck.allow) {
            log(`【${room.name}】${bot.name} 跳过：${gateCheck.reason}`);
            res = {
              ok: false,
              text: '',
              ms: 0,
              error: breakerNote(gate.breaker, {
                groupName: runner.modelGroups.get(gate.groupId)?.name ?? '',
              }),
              status: 503,
              messageId: '',
              breakerSkipped: true,
            };
          } else {
            res = await runner.run(roomId, bot.id, prompt, {
              groupTurn: true,
              retryManaged: true,
              taskRunId, attemptIndex: 1,
              attachments,
              managedContext: itemManaged,
              human: !item.fromId && isUserInitiatedRound({ openerBotId }),
            });
          }
          if (res.ok) {
            runner.markGroupHealthy(bot.id);
          } else if (!res.breakerSkipped) {
            const firstDecision = decideRetry({
              error: String(res.error ?? ''),
              attempt: 1,
              aborting: runner.aborting.has(roomId),
              status: res.status ?? null,
            });
            runner.markGroupFailed(bot.id, {
              kind: firstDecision.kind,
              status: res.status ?? null,
            });
          }
          let attempt = 1;
          let lastError = res.ok ? '' : String(res.error ?? '未知原因');
          let lastStatus = res.ok ? null : (res.status ?? null);
          let lastKind = res.breakerSkipped ? 'breaker-open' : '';
          // 这条重试链临时切到的模型（null = 还在用配置里的模型）；单链最多切一次
          let overrideModel = null;
          const retries = [];

          while (!res.ok) {
            if (res.breakerSkipped) break;
            if (stale()) break;
            const decision = decideRetry({
              error: lastError,
              attempt,
              aborting: runner.aborting.has(roomId),
              status: lastStatus,
            });
            if (!decision.retry) {
              log(`【${room.name}】${bot.name} 不再重试：${decision.why}`);
              lastKind = decision.kind;
              break;
            }
            const afterFail = runner.breakerFor(bot.id);
            if (afterFail && afterFail.breaker.state === BREAKER_STATE.open) {
              log(`【${room.name}】${bot.name} 熔断已打开，停止重试`);
              lastKind = 'breaker-open';
              break;
            }
            attempt++;
            retries.push(`${attempt}. ${decision.why}`);
            log(
              `【${room.name}】${bot.name} 第 ${attempt} 次尝试（${decision.kind}）：${lastError.slice(0, 80)}`,
            );
            const waitMs =
              decision.kind === 'transient'
                ? transientBackoffMs(attempt - 1)
                : RETRY_DELAY_MS;
            await new Promise((r) => setTimeout(r, waitMs));
            if (runner.aborting.has(roomId)) break;
            if (stale()) break;
            const hinted = retryHint({
              attempt: attempt - 1,
              error: lastError,
              kind: decision.kind,
              switchModel: decision.switchModel === true,
            });
            settleRetryMessage(runner.store, roomId, res, { willRetry: true });
            // ★ 早切换（§4.2 d）：连续第 2 次临时故障 / 第 1 次 model-idle / 所属组熔断打开
            //   → 这一轮换一个健康的已启用模型跑（一次性会话，不改 bot.model）
            const alt = planFallbackForBot({
              runner, botId: bot.id, fails: attempt - 1, kind: decision.kind,
              hasImages: (attachments?.length ?? 0) > 0, alreadySwitched: overrideModel !== null,
            });
            if (alt) {
              overrideModel = alt.slug;
              runner.bus.emit('event', {
                t: 'bot.retrying', roomId, botId: bot.id, attempt,
                delayMs: waitMs, kind: decision.kind, switchedTo: alt.label,
              });
            }
            res = await runner.run(roomId, bot.id, hinted + prompt, {
              groupTurn: true,
              retryManaged: true,
              taskRunId, attemptIndex: attempt,
              attachments,
              managedContext: itemManaged,
              ...(overrideModel ? { modelOverride: overrideModel } : {}),
            });
            if (!res.ok) {
              lastError = String(res.error ?? '未知原因');
              lastStatus = res.status ?? null;
            }
            // ★ 熔断按**真的在跑的那个模型**归属：主组坏着、临时切到好组跑通时，
            //   绝不能把坏着的组标成健康（照 `markGroupHealthy(bot.id)` 就会这么错）
            if (res.ok) {
              runner.markGroupHealthy(bot.id, overrideModel);
            } else {
              runner.markGroupFailed(bot.id, {
                kind: decision.kind,
                status: res.status ?? null,
                model: overrideModel,
              });
            }
          }

          if (stale()) {
            settleRetryMessage(runner.store, roomId, res, { aborted: true });
            if (taskId && !itemManaged) {
              runner.store.voidTask(taskId);
            }
            log(`【${room.name}】用户插话 → ${bot.name} 这一条作废（不重试、不上报）`);
            return;
          }

          settleRetryMessage(runner.store, roomId, res, res.ok
            ? { succeeded: true }
            : { error: lastError, aborted: runner.aborting.has(roomId) });
          if (taskId && !itemManaged) {
            runner.store.finishTask(taskId, {
              ok: res.ok,
              text: res.ok ? res.text : `失败 ${attempt} 次：${lastError}`,
            });
          }
          if (res.messageId && progressSource.sourceMessageId) {
            try {
              runner.store.updateMessage(roomId, res.messageId, {
                meta: {
                  ...(runner.store.getMessage(roomId, res.messageId)?.meta ?? {}),
                  re: progressSource.sourceMessageId,
                  reFrom: progressSource.fromId ?? null,
                },
              });
            } catch {}
          }
          const passText = (res.text ?? '').trim();
          const isPass = res.ok && /^\[?PASS\]?$/i.test(passText);
          if (mirror && !isPass) {
            mirrorGroupProgress(runner, {
              room,
              bot,
              phase: 'done',
              text: res.text,
              ok: res.ok,
              ...progressSource,
            });
          }
          runner.store.setCursor(roomId, bot.id, lastMessageId(roomId, runner.store));

          if (!res.ok) {
            log(
              `【${room.name}】${bot.name} 最终没跑成（试了 ${attempt} 次）：${lastError}`,
            );
            // ★ 上游瞬时故障（429 / 5xx / 网络瞬断 / 熔断打开）**不丢活**。
            //   以前这里直接落「[这单断了] …请重新发送任务」：把「系统暂时不健康」
            //   变成「用户的活没了」。改成分钟级阶梯退避后自动续派一行，
            //   全程不持锁（详见 runner/group-retry.js 的三条约束）。
            if (
              !itemManaged &&
              !stale() &&
              isUpstreamTransient({ kind: lastKind, status: lastStatus, error: lastError })
            ) {
              const plan = retrySchedulerFor(runner).schedule({
                runner,
                roomId,
                roomName: room.name,
                botId: bot.id,
                botName: bot.name,
                epoch,
                onFire: ({ attempt: nth }) => {
                  // ★ 只催**这一个**失败的成员。
                  //   原来把 item.fromText 整条重发 —— 那句话里可能 @ 了好几个人，
                  //   于是同一波里已经成功的同事会被再跑一遍：白烧额度、群里还多两条
                  //   内容重复的回复。
                  const again = `@${bot.name} 上游已恢复，请继续完成上一轮交办的工作`;
                  runner.store.appendMessage({
                    roomId,
                    authorType: 'system',
                    authorId: bot.id,
                    authorName: '续派提示',
                    text: `上游恢复了，接着做（第 ${nth} 次重派）。`,
                    status: 'done',
                    meta: { via: 'upstream_retry_fire', botId: bot.id, attempt: nth },
                  });
                  return dispatchGroupRound(runner, roomId, again, [], { fromUpstreamRetry: true });
                },
              });
              if (plan.scheduled) {
                const wait = describeWait(plan.delay);
                log(
                  `【${room.name}】${bot.name} 上游限流/波动 → ${wait} 后自动续派（第 ${plan.attempt + 1} 次）`,
                );
                runner.store.appendMessage({
                  roomId,
                  authorType: 'system',
                  authorId: bot.id,
                  authorName: '排期提示',
                  text:
                    `上游限流/波动（${String(lastError || lastKind || '暂时不可用').slice(0, 80)}），` +
                    `${wait}后自动接着做，不用重新发送任务。`,
                  status: 'done',
                  meta: {
                    via: 'upstream_retry_scheduled',
                    botId: bot.id,
                    delayMs: plan.delay,
                    attempt: plan.attempt + 1,
                  },
                });
                return;
              }
              log(
                `【${room.name}】${bot.name} 上游退避已累计 ${describeWait(plan.waitedMs)}，到上限 → 如实失败`,
              );
            }
            runner.store.appendMessage({
              roomId,
              authorType: 'system',
              authorId: bot.id,
              authorName: '失败回执',
              text: failureNote({
                botName: bot.name,
                reason: lastError,
                attempt,
                willRetry: false,
                kind: lastKind,
              }),
              status: 'done',
              meta: { via: 'failed', attempts: attempt },
            });

            if (leadId && bot.id !== leadId && !runner.aborting.has(roomId)) {
              runner.escalate({
                roomId,
                fromBotId: bot.id,
                reason: `试了 ${attempt} 次都没成：${lastError}`,
                task: item.fromText || item.reason,
                attempts: attempt,
                why: retries[retries.length - 1] ?? '',
                prefer: 'lead',
              }).catch((err) => log('上报失败：', err?.message || err));
            }
            return;
          }
          // 这一段真的跑通了 → 这个房间的上游退避累计清零（下次抽风从第一档排起）
          resetGroupRetryBackoff(runner, roomId, '本轮跑通');

          const text = res.text.trim();
          if (isPass) {
            // ★ 用户直接点名它、它却回了 [PASS]：**不能静默删掉气泡**。
            //
            //   以前这里无条件把气泡删掉，用户看到的是"我 @ 了它，它原地消失"
            //   （Mac 实机 UX-3 根因 3：直接断开思考且无气泡）。
            //   现在留一条可见说明，并把"该怎么说清"教给他。
            const userAddressed = !item.fromId;
            if (userAddressed) {
              const note = '这一轮是你在群里直接点名的，但它判断这条不需要它出手（[PASS]）。'
                + '想把活交给谁，就在消息里 @ 它并说清「做什么 / 交回什么 / 怎么算完成」。';
              try {
                const msg = runner.store.updateMessage(roomId, res.messageId, {
                  text: note,
                  status: 'done',
                  meta: {
                    ...(runner.store.getMessage(roomId, res.messageId)?.meta ?? {}),
                    pass: true,
                  },
                }, { silent: false });
                runner.bus.emit('event', { t: 'msg.updated', roomId, msgId: res.messageId, msg });
              } catch (err) {
                log('PASS 占位更新失败：', err?.message || err);
              }
              log(`${bot.name} PASS（用户直接点名 → 保留可见说明，不删消息）`);
              return;
            }
            runner.store.deleteMessage(roomId, res.messageId);
            log(`${bot.name} PASS`);
            return;
          }
          roundSuccesses.push({ botId: bot.id, res });

          const { all, found } = parseMentions(text, members, {
            selfId: bot.id,
          });
          const next = all
            ? members.filter((m) => m.id !== bot.id).map((m) => m.id)
            : found;
          const queued = new Set(queue.map((q) => q.botId));
          for (const id of next) {
            if (id === bot.id || queued.has(id)) continue;
            queue.push({
              botId: id,
              reason: `${bot.name} 叫了你`,
              fromId: bot.id,
              fromName: bot.name,
              fromText: text,
              sourceMessageId: res.messageId || null,
            });
            queued.add(id);
            called.add(id);
          }
          // ★ 这一段到点让出、还没做完：把它自己重新排进本轮队列，接着做下一段。
          //
          //   以前一到上限就是「已收住；要它继续做完就在私聊里派活」——
          //   活停在半路，等用户自己去私聊里再派一遍。
          //   续段占它自己的发言预算（leadTurns / memberTurns）和本轮总次数（maxRuns），
          //   所以有界；派活人沿用原来那条（权限与「用户点名」语义不变）。
          if (res.continuation && !stale() && !runner.aborting.has(roomId)
              && !queue.some((q) => q.botId === bot.id)) {
            const segment = Number(item.continuation ?? 0) + 1;
            queue.push({
              botId: bot.id,
              reason: '接着做上一段没做完的',
              fromId: item.fromId ?? null,
              fromName: item.fromName,
              fromText: item.fromText,
              sourceMessageId: item.sourceMessageId ?? null,
              continuation: segment,
            });
            log(`【${room.name}】${bot.name} 这一段到点了、还没做完 → 排下一段（续段 ${segment}）`);
          }
        } finally {
          runner.dispatching.delete(dispatchKey);
        }
      })().catch((err) =>
        log(`【${room.name}】${bot.name} 这一轮异常：`, err?.message || err),
      ),
    );
  }
  await awaitPending(pending, stale);

  if (stale()) {
    log(`【${room.name}】用户插话 → 旧轮收手，改为按新要求重新开始`);
    return;
  }

  if (!runner.aborting.has(roomId) && leadId) {
    const lead = runner.store.getBot(leadId);
    const closing = lead
      ? planClosing({
          leadSpokeThisRound: isStrictlyAfter(roomId, roundStartMsgId, lastDoneIdOf(roomId, [leadId], runner.store), runner.store),
          memberSpokeAfterLead: isStrictlyAfter(
            roomId,
            lastDoneIdOf(roomId, [leadId], runner.store),
            lastDoneIdOf(roomId, participants, runner.store),
            runner.store,
          ),
        })
      : { needed: false, why: '找不到老大' };

    let closingResult = null;
    if (lead && closing.needed) {
      const leadKey = sessionKey(roomId, lead.id);
      runner.dispatching.add(leadKey);
      try {
        log(`【${room.name}】🗣 ${closing.why} → 叫 ${lead.name} 收尾`);
        const prompt = composeGroupPrompt(room, lead, transcriptFor(roomId, leadId, undefined, { store: runner.store }), {
          isLead: true,
          reason: '大家交完了，给用户一个最终结论',
          members,
          leadId,
          closing: true,
        });
        // 收尾轮本来就是「最后一条消息」：不催继续、不自动续段
        const res = await runner.run(roomId, lead.id, prompt, { groupTurn: true, noContinueGuard: true });
        closingResult = res;
        if (res.ok && res.text.trim()) {
          log(`【${room.name}】✅ 收尾完成（${res.text.trim().length} 字）`);
          const { found } = parseMentions(res.text, members, { selfId: lead.id });
          if (found.length) {
            log(
              `【${room.name}】⚠️ 收尾轮又 @ 了 ${found
                .map((id) => runner.store.getBot(id)?.name ?? id)
                .join('、')}，但本轮已收口，这些活留到下次`,
            );
          }
        } else {
          log(`【${room.name}】收尾没跑成：${res.error ?? '空回复'}`);
        }
        runner.store.setCursor(roomId, lead.id, lastMessageId(roomId, runner.store));
      } catch (err) {
        log(`【${room.name}】收尾异常：`, err?.message || err);
      } finally {
        runner.dispatching.delete(leadKey);
      }
    }
  }

  // ★ 主控总汇总：部门这一轮收口了，把负责人的结论回填到批次里。
  //   没有 summary 参数（用户在部门群直接派活）就什么都不做 —— 规格 §0 硬规矩 5。
  if (summary?.batchId) {
    try {
      // ★ 兜底：`closing.needed === false` 是**很常见的正常成功**
      //   （单人部门、负责人直接答完没人再被 @）—— 这时 closingResult 是 null，
      //   不能直接记成 failed。三档回落写在纯函数里，单测覆盖。
      // 负责人可能说了两次（开头派活 + 最后结论）—— 要取**最后一条**，
      // 否则回传里塞的是"@A @B 你俩分一下"这种派活话。
      // 负责人可能说了两次（开头派活 + 最后结论）—— 取最后一条，别把派活话当交付
      const leadResult = pickLeadResult(roundSuccesses, leadId);
      const lastResult = roundSuccesses.length ? roundSuccesses[roundSuccesses.length - 1].res : null;
      const delivery = pickDepartmentDelivery({ closingResult, leadResult, lastResult });
      const target = {
        key: summary.targetKey || `group:${roomId}:${openerMessageId || ''}`,
        departmentId: roomId,
        departmentName: room.name,
        kind: 'group',
        refId: openerMessageId || '',
        ...delivery,
      };
      const batch = runner.store.chiefSummary(summary.batchId);
      const main = runner.store.mainBot();
      const mainBusy = batch && main ? isMainChatBusy(runner, batch.originRoomId, main.id) : false;
      runner.store.noteChiefSummaryTarget(summary.batchId, target, { mainBusy });
      void runner.drainChiefSummaries?.().catch?.(() => {});
      log(`【${room.name}】📮 已回填主控汇总（${target.status}）`);
    } catch (err) {
      log(`【${room.name}】回填主控汇总失败：`, err?.message || err);
    }
  }

  const lastId = lastMessageId(roomId, runner.store);
  for (const m of members) {
    if (used.has(m.id) || called.has(m.id)) continue;
    runner.store.setCursor(roomId, m.id, lastId);
  }

  if (roundStartIndex >= 0 && runner.store.lessonsEnabled()) {
    void runner.reflect?.({ roomId, sinceIndex: roundStartIndex }).catch((err) =>
      log(`【${room.name}】复盘异常：`, err?.message || err),
    );
  }
}
