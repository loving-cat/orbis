/**
 * 「等模型」的两种可见性（SPEC-PERF-V1 §4.2 b / §4.2 c）。
 *
 * 这里只管**计时与计数**，不碰会话、不发请求 —— 接线在 `turn-executor.js`。
 *
 * ## 1. `modelIdleMs`：模型无进展超时
 *
 * 看门狗（`watchdog.js`）是最外层兜底：模型 6 分钟没动静才判卡死。对
 * 「上游一直不吐字」来说 6 分钟太长 —— 用户干等 6 分钟才知道要重试。
 * 这里给「等模型」单独一档更短的阈值（默认 180 s，§11·2 的保守初值）。
 *
 * 锚点与 TTFT 埋点完全一致（否则两套数字对不上）：
 *   · 起算：发出请求 / **所有**工具结束之后重新发请求（`entry.toolsRunning === 0`）；
 *   · 暂停：还有工具在跑 → 跑工具不算「模型没进展」；
 *   · 重置：收到 `message_update`（思考增量也算进展）；
 *   · 顺延：`auto_retry_start` 的退避睡眠是**可控等待**，按 `delayMs` 往后挪，
 *     不能把 SDK 的 60 s 退避错判成挂死。
 *
 * ## 2. SDK 内部重试看得见、算得进熔断
 *
 * 以前 `auto_retry_start` 只加一个计数：不刷心跳、不喂熔断、也不告诉用户。
 * 于是一次 0-token 报错能让 SDK 自己重试 10 次、干等 6 分钟，而 Orbis 这边
 * 看到的只是「没动静」。现在：
 *   · 每次 SDK 重试都刷心跳 + 广播 `bot.retrying`（客户端能看到「上游不稳」）；
 *   · 连续 `failsBeforeUpstream`（默认 2）次 SDK 级失败，按**一次**通路失败
 *     上报 `markGroupFailed` —— 熔断器不再对 SDK 内部的 10 次重试完全失明，
 *     但也不会把 SDK 的 10 次重试放大成 10 次通路失败（那会把冷却时间无限续期）。
 */
import { readBrandEnv } from '../brand.js';

/** 默认 180 s：M1 保守初值，攒够 3–7 天 `ttftMsMax` 分布后再考虑收紧到 120 s。 */
export const DEFAULT_MODEL_IDLE_MS = 180_000;
/** 再短就不是「挂死」，而是慢思考模型正常在想（会误杀）。 */
export const MIN_MODEL_IDLE_MS = 30_000;
/** 超过这个数就不如交给看门狗兜底了。 */
export const MAX_MODEL_IDLE_MS = 900_000;

/**
 * 从环境变量取阈值：`ORBIS_MODEL_IDLE_MS`。
 *
 * 非数字 / 越界一律回落默认 —— 一个手滑的 `0` 不能让每一轮都被判成挂死。
 */
export function modelIdleMsFrom(env = process.env) {
  const raw = Number(readBrandEnv(env, 'MODEL_IDLE_MS'));
  if (!Number.isFinite(raw) || raw < MIN_MODEL_IDLE_MS || raw > MAX_MODEL_IDLE_MS) {
    return DEFAULT_MODEL_IDLE_MS;
  }
  return Math.round(raw);
}

/**
 * 无进展守卫。
 *
 * @param {object} [p]
 * @param {number} [p.limitMs]          阈值；默认按环境变量取
 * @param {Function} [p.onIdle]         超时回调（接线里做 `session.abort()`）
 * @param {Function} [p.clock]
 * @param {Function} [p.setTimer]
 * @param {Function} [p.clearTimer]
 */
export function createModelIdleGuard({
  limitMs = modelIdleMsFrom(),
  onIdle = null,
  clock = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const limit = Number.isFinite(Number(limitMs)) && Number(limitMs) > 0 ? Number(limitMs) : DEFAULT_MODEL_IDLE_MS;
  let timer = null;
  let dueAt = 0;
  let armed = false;
  let paused = false;
  let stopped = false;
  let fired = false;
  let idleAtFire = 0;

  const clear = () => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const armAt = (when) => {
    clear();
    if (stopped || paused) return;
    dueAt = when;
    timer = setTimer(check, Math.max(0, dueAt - clock()));
  };

  function check() {
    timer = null;
    if (stopped || paused || !armed) return;
    const idle = clock() - (dueAt - limit);
    if (idle < limit) {
      armAt(dueAt);
      return;
    }
    // 只报一次：abort 之后事件循环里还会有一堆尾巴，不能反复中止
    fired = true;
    stopped = true;
    idleAtFire = idle;
    try {
      onIdle?.({ idleMs: idle, limitMs: limit });
    } catch {}
  }

  const api = {
    get limitMs() { return limit; },
    get fired() { return fired; },
    get idleMs() { return idleAtFire; },
    /** 开始等模型（发请求 / 所有工具结束之后重新发请求）。 */
    arm() {
      if (stopped) return api;
      armed = true;
      paused = false;
      armAt(clock() + limit);
      return api;
    },
    /** 有进展：`message_update`（含思考增量）。 */
    beat() {
      if (stopped || paused || !armed) return api;
      armAt(clock() + limit);
      return api;
    },
    /**
     * SDK 要重试了：把到期时间往后顺延一段（这段等待是可控的）。
     *
     * 用 `clock() + delay + limit` 而不是「往后加 delay」：SDK 是在 Sleep
     * **之前**发的事件，睡醒之后还要给模型整整一个 `limit` 的机会。
     */
    sdkRetry(delayMs) {
      if (stopped || paused || !armed) return api;
      const delay = Math.min(MAX_MODEL_IDLE_MS, Math.max(0, Number(delayMs) || 0));
      armAt(clock() + delay + limit);
      return api;
    },
    /** 工具开始跑：暂停计时。 */
    pause() {
      paused = true;
      clear();
      return api;
    },
    /** 工具跑完（且没有别的工具在跑）：重新起表。 */
    resume() {
      if (stopped) return api;
      armed = true;
      paused = false;
      armAt(clock() + limit);
      return api;
    },
    stop() {
      stopped = true;
      clear();
      return api;
    },
  };
  return api;
}

/**
 * SDK 级重试的收敛器。
 *
 * 「连续 2 次 SDK 级失败 → 算一次通路失败」：熔断器要能看到 SDK 内部的
 * 反复失败，但又不能被 SDK 的 10 次重试灌成 10 次（冷却会被无限续期）。
 */
export function createSdkRetryWatch({ failsBeforeUpstream = 2, onUpstreamFailure = null } = {}) {
  const limit = Math.max(1, Math.floor(Number(failsBeforeUpstream) || 2));
  let streak = 0;
  let reported = 0;
  return {
    /** `auto_retry_start`：SDK 又要重试了 → 计数 +1，达到阈值就上报一次通路失败。 */
    start(event = {}) {
      streak += 1;
      if (streak < limit) return { streak, reported: false };
      streak = 0;
      reported += 1;
      const info = {
        attempt: Number(event.attempt ?? event.attempts ?? 0) || reported,
        maxAttempts: Number(event.maxAttempts ?? 0) || null,
        delayMs: Number(event.delayMs ?? event.delay ?? event.retryAfterMs ?? 0) || 0,
        kind: 'sdk-retry',
        reported: reported,
      };
      try {
        onUpstreamFailure?.(info);
      } catch {}
      return { streak: 0, reported: true, info };
    },
    /** `auto_retry_end`：SDK 自己成功了就清零，失败继续攒（下一次 start 会续上）。 */
    end(success = true) {
      if (success) streak = 0;
      return streak;
    },
    get streak() { return streak; },
    get reportedCount() { return reported; },
    get limit() { return limit; },
  };
}

/**
 * 广播一次 SDK 级重试，并把它记进收敛器。
 *
 * 客户端拿这条消息在左下角显示「上游不稳 · 第 k 次重试」——
 * 用户至少知道系统还在动，而不是盯着一个不动的气泡猜。
 * 只带次数/延迟，不带 endpoint、密钥、供应商身份（与既有 `bot.retrying` 口径一致）。
 */
export function announceSdkRetry({ emit = null, roomId = '', botId = '', event = {}, watch = null } = {}) {
  const delayMs = Number(event.delayMs ?? event.delay ?? event.retryAfterMs ?? 0) || 0;
  const out = watch ? watch.start(event) : { streak: 1, reported: false };
  try {
    emit?.({
      t: 'bot.retrying',
      roomId,
      botId,
      attempt: Number(event.attempt ?? event.attempts ?? 0) || 1,
      maxAttempts: Number(event.maxAttempts ?? 0) || null,
      delayMs,
      kind: 'sdk-retry',
    });
  } catch {}
  return { ...out, delayMs };
}

/**
 * 一次接好「等模型」的两件事：无进展超时守卫 + SDK 重试收敛器。
 *
 * 接线故意收在一个函数里：`turn-executor.js` 有硬行数预算，那里只留一行
 * `const { idle, sdkWatch } = wireModelWait({...})`。
 * 超时只中止**本次请求**（`entry.session.abort()`），不碰用户会话的持久化配置；
 * 中止后由既有失败分类记成 `kind: 'model-idle'`。
 */
export function wireModelWait({
  runner, entry, botId = '', botName = '', log = () => {},
  limitMs = undefined,
} = {}) {
  const idle = createModelIdleGuard({
    ...(limitMs === undefined ? {} : { limitMs }),
    onIdle: (info) => {
      log(`${botName || botId} 等模型 ${Math.round(info.idleMs / 1000)}s 没有进展，中止本次请求`);
      try { entry?.session?.abort?.().catch?.(() => {}); } catch {}
    },
  });
  const sdkWatch = createSdkRetryWatch({
    // 连续 2 次 SDK 级失败 = 一次通路失败：熔断器不再对 SDK 内部重试完全失明
    onUpstreamFailure: (info) => {
      try { runner?.markGroupFailed?.(botId, { kind: 'transient', status: null, sdkRetry: info }); } catch {}
    },
  });
  return { idle, sdkWatch };
}

/**
 * `model-idle` 的失败口径：它**不是**「用户终止」。
 *
 * 上游一个字都不吐的时候是我们自己 `abort()` 的，SDK 抛出来的就是 AbortError。
 * 如果照实当成 `aborted`，下游会全线短路：
 *   · `isRecoverableFailure` / `decideRetry` / `isUpstreamTransient` 全部否掉
 *     → 0 次重试、不喂熔断、不进分钟级续派；
 *   · 气泡直接变红「已终止」，用户以为是自己取消的。
 *
 * 所以这里把它改写成「上游超时」：`timedOut`、`aborted: false`、`status: null`。
 * **文案里不能出现「中止/终止」** —— `isRecoverableFailure` 用 `/已.{0,2}(终止|中止)/`
 * 判「用户终止」，写进去就又把这条路堵死了。
 *
 * @returns {object|null} 需要覆盖时返回新的失败对象；用户真取消或没触发则返回 null
 */
export function resolveIdleFailure(idle, userCancelled = false, failure = null) {
  if (!idle?.fired || userCancelled) return null;
  const seconds = Math.round((Number(idle.limitMs) || 0) / 1000);
  return {
    ...(failure ?? {}),
    status: null,
    auth: false,
    quota: false,
    aborted: false,
    timedOut: true,
    error: `模型超过 ${seconds} 秒没有进展（model-idle），本次等待已放弃`,
  };
}

/**
 * `auto_retry_start` 的一处接线（心跳 + 顺延 + 广播）。
 *
 * ★ 心跳要写 `entry.progressAt`，但**不能**走 `beat()`：`beat()` 里带着
 *   `idle.beat()`，会把刚刚 `idle.sdkRetry(delayMs)` 顺延出来的期限又抹平 ——
 *   SDK 一次 60 s 退避立刻被当成「模型 60 s 没进展」。
 */
export function onSdkRetryStart({ entry = null, idle = null, sdkWatch = null, emit = null, roomId = '', botId = '', event = {} } = {}) {
  if (entry) entry.progressAt = Date.now();
  const delayMs = Number(event.delayMs ?? event.delay ?? event.retryAfterMs ?? 0) || 0;
  idle?.sdkRetry(delayMs);
  return announceSdkRetry({ emit, roomId, botId, event, watch: sdkWatch });
}
