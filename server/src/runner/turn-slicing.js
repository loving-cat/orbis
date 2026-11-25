/**
 * 长任务的分段与续跑（单轮执行的「时间片」机制）。
 *
 * 从 turn-executor 拆出来的三件事，执行器只负责接线：
 *
 *   1. 软截止 `softDeadlineTimeout`：单段到点先请模型收尾、写进度（steer），
 *      宽限期内自己收住就是「这一段让出」；宽限期满工具还在出结果就再等，
 *      总时长到硬上限、或者已经安静太久，才真的中断。
 *      以前到点即 abort、记成「失败」只重试一次 —— 正在干活的轮次被拦腰截断。
 *
 *   2. 续跑守卫 `runContinuationGuard`：回合收尾时判一次是不是「半路停下来问」，
 *      是就在同一会话里追加「继续执行」（判定是纯函数，见 turn-continuation.js）。
 *
 *   3. 非受管私聊自动续段 `scheduleDmContinuation`：上一段到点让出、还没做完，
 *      就接着跑下一段（受管任务由推进器续跑，群聊由编排器重新排队）。
 */
import { log } from '../util.js';
import { continuationPrompt, nudgePrompt, shouldNudge } from '../turn-continuation.js';

/** 步数到上限、发出收尾通知后，再宽限几轮回复才硬收住 */
export const STEP_CAP_GRACE = 3;

/**
 * 这次工具调用是不是「停下来等用户点卡片」：续跑守卫不能催。
 *
 * 询问卡片默认不阻塞（先按默认选项接着做），只有 blocking=true 才是真的在等；
 * 站点接入确认永远要等用户点头。
 */
export function isBlockingAsk(toolName, args = null) {
  if (toolName === 'confirm_site') return true;
  return toolName === 'ask_user' && args?.blocking === true;
}

/** 受管任务是不是「自主推进」：以根任务为准（子任务跟着整件事走） */
export function managedIsAutonomous(runner, ctx) {
  try {
    const id = ctx?.rootTaskId ?? ctx?.taskRunId ?? null;
    const loaded = id ? runner.store.taskRuns?.read?.(id) : null;
    const run = loaded?.status === 'found' ? loaded.taskRun : null;
    return run?.flags?.autonomous === true;
  } catch {
    return false;
  }
}

/**
 * 软截止计时：返回一个**只会 reject** 的 Promise，和真正的执行 race。
 *
 * @param {object} p
 * @param {number} p.deadline 软截止时刻（started + 单段时长）
 * @param {number} p.started 本轮开始时刻
 * @param {number} p.graceMs 收尾宽限；0 = 到点直接中断（旧行为）
 * @param {number} p.hardCapMs 单段硬上限（从 started 算，含所有宽限与延长）
 * @param {() => boolean} p.isFinished 执行已结束（之后一律不再动会话）
 * @param {() => void} p.beginWrapUp 发收尾通知
 * @param {(now:number) => boolean} p.toolAlive 有工具在跑、而且最近还有动静
 * @param {() => Error} p.onHardTimeout 真的中断：置标记、abort，返回要 reject 的错误
 * @param {(ms:number) => void} [p.onExtend] 工具还在出结果、再宽限一段时的回调（记日志）
 * @param {(handle:any) => void} p.track 记下最新的定时器（收尾时统一 clearTimeout）
 * @returns {Promise<never>}
 */
export function softDeadlineTimeout({
  deadline, started, graceMs, hardCapMs, isFinished, beginWrapUp, toolAlive, onHardTimeout, onExtend = null, track,
}) {
  return new Promise((_, reject) => {
    const hardCheck = () => {
      if (isFinished()) return;
      const now = Date.now();
      // 宽限期满：工具还在跑、而且最近还在出结果 → 别把正在出结果的构建/测试砍在半路
      if (toolAlive(now) && graceMs > 0 && now + graceMs <= started + hardCapMs) {
        onExtend?.(graceMs);
        track(setTimeout(hardCheck, graceMs));
        return;
      }
      reject(onHardTimeout());
    };
    track(setTimeout(() => {
      if (isFinished()) return;
      if (!(graceMs > 0)) {
        reject(onHardTimeout());
        return;
      }
      // 软截止：先请它收尾、写进度；宽限期内自己收住就是「这一段让出」
      beginWrapUp();
      track(setTimeout(hardCheck, graceMs));
    }, Math.max(1, deadline - Date.now())));
  });
}

/**
 * 回合收尾续跑守卫（相当于 Claude Code 的 Stop hook）。
 *
 * 每次模型收手后判一次：是「半路停下来问」就追加一句「继续执行」，直到：
 * 判定不用催 / 次数用完 / 催了以后仍只回文字（说明真需要用户）/ 外部要求停下。
 *
 * @param {object} p
 * @param {number} p.max 最多催几次
 * @param {() => boolean} p.isStopped 终止、软截止、出错等：不再催
 * @param {() => object} p.readInput 当前状态 → shouldNudge 的输入（含 toolCalls 计数）
 * @param {(verdict:object, n:number) => void} p.onNudge 催之前（记日志、气泡里留一句）
 * @param {(text:string) => Promise<any>} p.nudge 真正把话发进会话
 * @returns {Promise<number>} 一共催了几次
 */
export async function runContinuationGuard({ max, isStopped, readInput, onNudge, nudge }) {
  let nudges = 0;
  let toolsAtNudge = -1;
  for (;;) {
    if (isStopped()) return nudges;
    const input = readInput();
    const verdict = shouldNudge({
      ...input,
      nudges,
      max,
      actedSinceNudge: toolsAtNudge < 0 || Number(input.toolCalls ?? 0) > toolsAtNudge,
    });
    if (!verdict.nudge) return nudges;
    nudges += 1;
    toolsAtNudge = Number(input.toolCalls ?? 0);
    onNudge(verdict, nudges);
    try {
      await nudge(nudgePrompt(verdict.kind, { managed: input.managed === true }));
    } catch (err) {
      // 会话还在处理别的（用户插话排进来了）：守卫让路，不把整轮判失败
      if (/already processing/i.test(String(err?.message || err))) return nudges;
      throw err;
    }
  }
}

/**
 * 非受管私聊的自动续段：上一段到点让出、还没做完，就接着跑下一段。
 *
 * 让路规则（用户永远优先）：
 *   · 用户点了终止（aborting / 投递代数变了）→ 不续；
 *   · 有排队的用户请求、或者用户正在连发（合并队列里有东西）→ 不续，先处理用户的；
 *   · 会话已经在跑别的（用户的新消息）→ 不续。
 * 有上限：连续续段到 `autoContinueMax` 就停下，留一句话告诉用户怎么接着做；
 * 上限为 0 表示关闭自动续段（SDK 默认）。
 *
 * @returns {boolean} 是否排上了续段
 */
export function scheduleDmContinuation(runner, roomId, botId, { epoch = 0, n = 1, reason = 'time', delayMs = 250 } = {}) {
  const max = Math.max(0, Number(runner.config?.autoContinueMax ?? 12) || 0);
  if (max <= 0) return false;
  if (n > max) {
    try {
      runner.store.appendMessage({
        roomId,
        authorType: 'system',
        authorName: '续段',
        text: `已经连续自动接着做了 ${max} 段，先停在这里，免得一直跑下去。要它接着做，回一句「继续」就行。`,
        status: 'done',
        meta: { via: 'auto_continue_cap', botId, segments: max },
      });
    } catch {}
    log(`自动续段到上限（${max} 段），停下等用户`);
    return false;
  }
  const timer = setTimeout(() => {
    try {
      if (runner.aborting?.has?.(roomId)) return;
      if ((runner.directDeliveryEpochs?.get?.(roomId) ?? 0) !== epoch) return;
      if ((runner.requestQueues?.get?.(roomId)?.length ?? 0) > 0) return;
      if (runner.mergeQueue?.hasPending?.(roomId)) return;
      if (runner.isBusy?.(roomId, botId)) return;
      log(`${runner.store.getBot(botId)?.name ?? botId} 上一段${reason === 'steps' ? '步数' : '时间'}用完、还没做完 → 自动续段 ${n}/${max}`);
      void Promise.resolve(runner.run(roomId, botId, continuationPrompt({ n, max }), {
        skipUserMessage: true,
        meta: { continuation: n },
      })).catch((err) => log('自动续段失败：', err?.message || err));
    } catch (err) {
      log('自动续段失败：', err?.message || err);
    }
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return true;
}
