/**
 * 群聊上游故障的**分钟级延时续派**（T4.1）。
 *
 * ## 为什么需要它
 *
 * 429 / 5xx / 网络瞬断 / 熔断打开时，原来的行为是把这条活直接判死：
 * 落一条「[这单断了] 上游限流…请重新发送任务」，然后等用户自己再发一遍。
 * 但上游限流是分钟级的事 —— 五分钟后再试通常就好了。判死等于把
 * 「系统暂时不健康」变成「用户的活没了」。
 *
 * ## 三条硬约束（都是踩过的坑）
 *
 *   1. **绝不持锁等待**。`runner.roundLocks` 是按房间的唯一锁，在里面 sleep
 *      几分钟等于把整个群冻住（用户再发消息也进不来）。这里只登记一个
 *      `unref()` 过的定时器就返回，锁在本轮结束时照常释放。
 *   2. **到期要重新核对**。等待期间用户可能插话、终止、或者又发了一条新消息
 *      （`roundEpoch` 会 +1）。到期时 `aborting` 或代数变了就**不发**，
 *      否则就是一条「幽灵续派」：用户已经让停的事又自己跑起来了。
 *   3. **有上限**。阶梯退避累计到 `RETRY_MAX_TOTAL_MS`（默认 1 小时）就停手，
 *      如实落失败回执 —— 一直排下去只是把「不知道坏在哪」藏起来。
 */
import { log } from '../util.js';

/** 阶梯退避：1 → 2 → 5 → 10 分钟（可注入，单测用毫秒级）。 */
export const RETRY_LADDER_MS = Object.freeze([60_000, 120_000, 300_000, 600_000]);

/** 累计等待上限：超过就如实失败，不再排。 */
export const RETRY_MAX_TOTAL_MS = 60 * 60 * 1000;

/** 网络瞬断的各种写法（undici / node / 上游网关）。 */
const TRANSIENT_HINTS =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|terminated/i;

/**
 * 这次失败是不是「等一会儿可能就好」的上游故障。
 *
 * 身份（401/403）与欠费（402）**不算**：等多久都不会好，早点说清楚比排队强。
 *
 * @param {{kind?:string, status?:number|null, error?:string}} failure
 * @returns {boolean}
 */
export function isUpstreamTransient({ kind = '', status = null, error = '' } = {}) {
  const code = Number(status);
  if (code === 401 || code === 403 || code === 402) return false;
  if (kind === 'breaker-open') return true;
  if (code === 429) return true;
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;
  return TRANSIENT_HINTS.test(String(error ?? ''));
}

/**
 * 下一次该等多久；返回 `null` = 累计已到上限，不该再排。
 *
 * @param {{attempt?:number, waitedMs?:number, ladder?:number[], maxTotalMs?:number}} p
 * @returns {number|null}
 */
export function nextRetryDelay({
  attempt = 0,
  waitedMs = 0,
  ladder = RETRY_LADDER_MS,
  maxTotalMs = RETRY_MAX_TOTAL_MS,
} = {}) {
  const list = Array.isArray(ladder) && ladder.length ? ladder : RETRY_LADDER_MS;
  const delay = list[Math.min(Math.max(attempt, 0), list.length - 1)];
  if (!Number.isFinite(delay) || delay <= 0) return null;
  if (waitedMs + delay > maxTotalMs) return null;
  return delay;
}

/** 给用户看的时间：不足 1 分钟说秒，否则说分钟。 */
export function describeWait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '稍后';
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`;
  const min = n / 60_000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} 分钟`;
}

/**
 * 每个 runner 一份调度器（房间维度去重）。
 *
 * 用 WeakMap 而不是挂在 `runner` 上：`pi-runner.js` 有 850 行预算，
 * 而且这里的状态是「编排层的临时状态」，不该进外观层。
 */
const SCHEDULERS = new WeakMap();

/**
 * 取（或建）某个 runner 的续派调度器。
 *
 * @param {object} runner
 * @param {object} [options] 只在首次创建时生效（单测注入 clock/timer/阶梯）
 * @returns {GroupRetryScheduler}
 */
export function retrySchedulerFor(runner, options = {}) {
  let scheduler = SCHEDULERS.get(runner);
  if (!scheduler) {
    scheduler = new GroupRetryScheduler(options);
    SCHEDULERS.set(runner, scheduler);
  }
  return scheduler;
}

/** 取消某个房间挂起的续派（用户插话 / 终止 / 来了新消息）。 */
export function cancelGroupRetries(runner, roomId, why = '') {
  const scheduler = SCHEDULERS.get(runner);
  if (!scheduler) return false;
  return scheduler.cancel(roomId, why);
}

/** 取消这个 runner 上所有挂起的续派（进程收工用）。 */
export function cancelAllGroupRetries(runner, why = '') {
  const scheduler = SCHEDULERS.get(runner);
  if (!scheduler) return 0;
  return scheduler.cancelAll(why);
}

export class GroupRetryScheduler {
  /**
   * @param {{now?:()=>number, setTimer?:(fn:Function,ms:number)=>any,
   *          clearTimer?:(timer:any)=>void, ladder?:number[], maxTotalMs?:number}} [options]
   */
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    ladder = RETRY_LADDER_MS,
    maxTotalMs = RETRY_MAX_TOTAL_MS,
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.ladder = ladder;
    this.maxTotalMs = maxTotalMs;
    /** @type {Map<string, {timer:any, dueAt:number, attempt:number, waitedMs:number, botId:string}>} */
    this.timers = new Map();
  }

  /** 这个房间有没有挂起的续派（测试与日志用）。 */
  pending(roomId) {
    return this.timers.get(roomId) ?? null;
  }

  /** 当前挂起的房间数。 */
  get size() {
    return this.timers.size;
  }

  /**
   * 安排一次延时续派。
   *
   * @param {object} p
   * @param {object} p.runner 用来在到期时核对 `aborting` / `roundEpochs`
   * @param {string} p.roomId
   * @param {string} [p.roomName]
   * @param {string} [p.botId]
   * @param {string} [p.botName]
   * @param {number} p.epoch 登记时的轮次代数
   * @param {(info:{attempt:number, waitedMs:number, dueAt:number}) => void|Promise<void>} p.onFire
   * @returns {{scheduled:boolean, delay:number, dueAt:number, attempt:number, waitedMs:number, reason?:string}}
   */
  schedule({ runner, roomId, roomName = roomId, botId = '', botName = '', epoch = 0, onFire }) {
    const prev = this.timers.get(roomId);
    const attempt = prev ? prev.attempt + 1 : 0;
    const waitedMs = prev ? prev.waitedMs : 0;
    const delay = nextRetryDelay({
      attempt,
      waitedMs,
      ladder: this.ladder,
      maxTotalMs: this.maxTotalMs,
    });
    if (delay == null) {
      return { scheduled: false, reason: 'exhausted', delay: 0, dueAt: 0, attempt, waitedMs };
    }
    // 同一房间只保留一个挂起项：新的故障覆盖旧的（旧的作废，不做并行排期）
    this.cancel(roomId, '重新排期');
    const dueAt = this.now() + delay;
    const entry = { timer: null, dueAt, attempt, waitedMs: waitedMs + delay, botId };
    const fire = () => {
      this.timers.delete(roomId);
      // ★ 到期复核：终止/插话/新消息都会让这一条作废
      if (runner?.aborting?.has?.(roomId)) {
        log(`【${roomName}】续派作废：房间已被终止（${botName || botId}）`);
        return;
      }
      const now = runner?.roundEpochs?.get?.(roomId) ?? 0;
      if (now !== epoch) {
        log(`【${roomName}】续派作废：轮次代数变了（${epoch} → ${now}），用户已经改主意`);
        return;
      }
      log(`【${roomName}】上游恢复窗口到点 → 续派 ${botName || botId}（第 ${attempt + 1} 次）`);
      try {
        const out = onFire?.({ attempt: attempt + 1, waitedMs: entry.waitedMs, dueAt });
        if (out && typeof out.catch === 'function') {
          out.catch((err) => log(`【${roomName}】续派失败：${err?.message || err}`));
        }
      } catch (err) {
        log(`【${roomName}】续派失败：${err?.message || err}`);
      }
    };
    const timer = this.setTimer(fire, delay);
    // 不阻塞进程退出：这是个"有空再试"的定时器，不是必须完成的工作
    timer?.unref?.();
    entry.timer = timer;
    this.timers.set(roomId, entry);
    return { scheduled: true, delay, dueAt, attempt, waitedMs: entry.waitedMs };
  }

  /** 取消某房间挂起的续派；返回是否真的取消了一个。 */
  cancel(roomId, why = '') {
    const entry = this.timers.get(roomId);
    if (!entry) return false;
    if (entry.timer) this.clearTimer(entry.timer);
    this.timers.delete(roomId);
    if (why) log(`续派已取消（${roomId}）：${why}`);
    return true;
  }

  /** 取消全部挂起的续派。 */
  cancelAll(why = '') {
    let n = 0;
    for (const roomId of [...this.timers.keys()]) {
      if (this.cancel(roomId, why)) n++;
    }
    return n;
  }
}
