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
import { isUpstreamTransient } from '../retry-policy.js';

// 判定口径与受管链路共用一份（见 retry-policy.js `isUpstreamTransient`），
// 免得群聊与任务对「什么算上游故障」给出两种答案。
export { isUpstreamTransient };

/** 阶梯退避：1 → 2 → 5 → 10 分钟（可注入，单测用毫秒级）。 */
export const RETRY_LADDER_MS = Object.freeze([60_000, 120_000, 300_000, 600_000]);

/** 累计等待上限：超过就如实失败，不再排。 */
export const RETRY_MAX_TOTAL_MS = 60 * 60 * 1000;

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
export function cancelGroupRetries(runner, roomId, why = '', options = {}) {
  const scheduler = SCHEDULERS.get(runner);
  if (!scheduler) return false;
  return scheduler.cancel(roomId, why, options);
}

/**
 * 清掉某房间的退避累计（这一轮真的跑通了 / 到上限放弃了）。
 *
 * 为什么要单独一个入口：`cancel()` 默认会连累计一起清（用户插话就该从第一档重来），
 * 但「续派到位后又跑通了」只该清累计、不该动别的；而 `fire()` 本身**绝不能**清 ——
 * 那正是「等待越久、退避越长」失效的地方（每轮都从 1 分钟重来 = 无限重试）。
 */
export function resetGroupRetryBackoff(runner, roomId, why = '') {
  const scheduler = SCHEDULERS.get(runner);
  if (!scheduler) return false;
  return scheduler.resetBackoff(roomId, why);
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
    /** 挂起的定时器（fire 一次就删） */
    /** @type {Map<string, {timer:any, dueAt:number, attempt:number, waitedMs:number, botId:string}>} */
    this.timers = new Map();
    /**
     * 退避累计（**不随 fire 清空**）。
     *
     * ★ 这一份和 timers 必须分开：`fire()` 只是「到点试一次」，
     *   试完还是 429 就该往下一档走（1→2→5→10 分钟）；如果 fire 顺手把
     *   累计清了，每轮都从第一档重来，本质上就是无间隔无限重试 ——
     *   既挡不住持续限流，也会把群里刷满提示。
     */
    /** @type {Map<string, {attempt:number, waitedMs:number}>} */
    this.backoff = new Map();
  }

  /** 排期键：`${roomId}:${botId}`；没有 botId 时退回 roomId。 */
  static keyFor(roomId, botId = '') {
    return botId ? `${roomId}:${botId}` : String(roomId);
  }

  /**
   * 这个房间（或这个房间里的某个成员）有没有挂起的续派。
   *
   * ★ 键从 `roomId` 改成 `${roomId}:${botId}`：同一轮里 A、B 同时撞 429 时，
   *   原来共用一把键 —— B 排期会把 A 的定时器 cancel 掉（A 承诺的「自动续派」
   *   永远失约），还把累计推到第 2 档。查到 roomId 但没给 botId 时返回该房间
   *   第一个挂起项（测试/日志用），给 botId 就精确到那一条。
   */
  pending(roomId, botId = '') {
    const exact = this.timers.get(GroupRetryScheduler.keyFor(roomId, botId));
    if (exact) return exact;
    if (botId) return null;
    const prefix = `${roomId}:`;
    for (const [key, entry] of this.timers) {
      if (key === roomId || key.startsWith(prefix)) return entry;
    }
    return null;
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
    const key = GroupRetryScheduler.keyFor(roomId, botId);
    const prev = this.backoff.get(key) ?? null;
    const attempt = prev ? prev.attempt : 0;
    const waitedMs = prev ? prev.waitedMs : 0;
    const delay = nextRetryDelay({
      attempt,
      waitedMs,
      ladder: this.ladder,
      maxTotalMs: this.maxTotalMs,
    });
    if (delay == null) {
      // 到上限：累计清掉，交给调用方如实失败（下次再抽风从第一档重新算起）
      this.backoff.delete(key);
      return { scheduled: false, reason: 'exhausted', delay: 0, dueAt: 0, attempt, waitedMs };
    }
    // 同一**成员**只保留一个挂起项：新的故障覆盖旧的（旧的作废，不做并行排期）。
    // ★ 只取消自己这条（带 botId）：兄弟成员 A 的续派不能被 B 的排期顺手干掉。
    // ★ 这里**不能**清累计 —— 我们正是要接着上一档往上走。
    this.cancel(roomId, '重新排期', { resetBackoff: false, botId });
    const dueAt = this.now() + delay;
    const entry = { timer: null, dueAt, attempt, waitedMs: waitedMs + delay, botId };
    const fire = () => {
      this.timers.delete(key);
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
    this.timers.set(key, entry);
    // 累计跟着这一档一起往上走（fire 时不清，见 backoff 的注释）
    this.backoff.set(key, { attempt: attempt + 1, waitedMs: entry.waitedMs });
    return { scheduled: true, delay, dueAt, attempt, waitedMs: entry.waitedMs };
  }

  /**
   * 取消某房间挂起的续派；返回是否真的取消了东西。
   *
   * `resetBackoff` 默认 true：用户插话/终止/来了新消息都意味着「重来」，
   * 下次抽风该从第一档 1 分钟排起。只有「本轮就是那次续派」要传 false。
   */
  /**
   * 取消续派。
   *
   * - **按房间批量**（默认）：清掉该房间下所有 `${roomId}:*` 以及老的 `roomId` 项，
   *   用户插话/终止/重新开始就是这一种；
   * - **按成员精确**（传 `botId`）：只动那一条，兄弟成员的续派留着
   *   （`schedule()` 内部重排自己时用这个）。
   */
  cancel(roomId, why = '', { resetBackoff = true, botId = '' } = {}) {
    if (botId) {
      const key = GroupRetryScheduler.keyFor(roomId, botId);
      const entry = this.timers.get(key);
      const hadBackoff = this.backoff.has(key);
      if (!entry && !hadBackoff) return false;
      if (entry?.timer) this.clearTimer(entry.timer);
      this.timers.delete(key);
      if (resetBackoff) this.backoff.delete(key);
      if (why && (entry || (resetBackoff && hadBackoff))) log(`续派已取消（${key}）：${why}`);
      return true;
    }
    const keys = this.#keysOfRoom(roomId);
    if (!keys.length) return false;
    let touched = false;
    for (const key of keys) {
      const entry = this.timers.get(key);
      const hadBackoff = this.backoff.has(key);
      if (!entry && !hadBackoff) continue;
      if (entry?.timer) this.clearTimer(entry.timer);
      this.timers.delete(key);
      if (resetBackoff) this.backoff.delete(key);
      touched = true;
    }
    if (why && touched) log(`续派已取消（${roomId}）：${why}`);
    return touched;
  }

  /** 只清累计，不动挂起的定时器（可按成员精确）。 */
  resetBackoff(roomId, why = '', { botId = '' } = {}) {
    if (botId) {
      const key = GroupRetryScheduler.keyFor(roomId, botId);
      const had = this.backoff.delete(key);
      if (had && why) log(`上游退避累计已清零（${key}）：${why}`);
      return had;
    }
    let had = false;
    for (const key of this.#keysOfRoom(roomId)) {
      if (this.backoff.delete(key)) had = true;
    }
    if (had && why) log(`上游退避累计已清零（${roomId}）：${why}`);
    return had;
  }

  /** 该房间名下的所有键（含老的无成员后缀项）。 */
  #keysOfRoom(roomId) {
    const prefix = `${roomId}:`;
    const keys = new Set();
    for (const map of [this.timers, this.backoff]) {
      for (const key of map.keys()) {
        if (key === roomId || key.startsWith(prefix)) keys.add(key);
      }
    }
    return [...keys];
  }

  /** 取消全部挂起的续派（并清空累计）。 */
  cancelAll(why = '') {
    let n = 0;
    for (const key of [...this.timers.keys()]) {
      const entry = this.timers.get(key);
      if (entry?.timer) this.clearTimer(entry.timer);
      this.timers.delete(key);
      n++;
    }
    if (why && n) log(`全部续派已取消：${why}`);
    // 只剩累计、没有定时器的房间也要清掉，否则进程收工后状态还赖在内存里
    n += this.backoff.size;
    this.backoff.clear();
    return n;
  }
}
