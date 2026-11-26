/**
 * 成员分身池的纯调度逻辑：配额、并发上限、泳道键、真实执行者还原。
 *
 * ## 要解决的问题
 *
 * 部门里通常只有 1 个「研究员」。负责人同时派 3 份互不冲突的调研时，
 * 现在的调度器「同 Bot 上限 1」只能让它们排队 —— 用户看到的是
 * 「3 个人闲着，1 个人在干」，而实际上那 3 份活彼此无关。
 *
 * ## 为什么上限是「可配 + 会被压」的
 *
 * 分身不是免费的：每一路都要一个会话、一份 token、一份上下文。
 * 所以这里只算**上界**，真正还能开几路由三样共同压：
 *   · `maxPerBot`（宿主配置，默认 1 = 完全不启用）；
 *   · 根预算的 `concurrencyLimit`（同一个根总共能跑几个）；
 *   · 上游健康度（有熔断打开就退回串行，别放大失败）。
 *
 * ## 边界
 *
 * 纯函数、零 IO。真正开分身/开会话在 `pi-runner` 与
 * `runner/session-lanes.js`，调度判定在 `task-supervisor.js`。
 */
import { readBrandEnv } from '../brand.js';
import { CLONE_INFIX, sessionLaneKey, parseLaneKey, baseBotIdOfKey, isCloneLane } from '../runner/session-lanes.js';

/** 单个成员最多额外开几个分身（硬封顶，防失控）。 */
export const MAX_CLONES_HARD_CAP = 6;

/** 默认每个成员额外开几个分身。 */
export const DEFAULT_CLONES_PER_BOT = 2;

/** 分身的「槽位数」上限 = 1 主 + N 分身。 */
export function clonesSlotCeiling() {
  return MAX_CLONES_HARD_CAP + 1;
}

/** `on|off` 解析（大小写不敏感，非法值按默认 on）。 */
function parseOnOff(raw, fallback = true) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['on', '1', 'true', 'yes'].includes(text)) return true;
  if (['off', '0', 'false', 'no'].includes(text)) return false;
  return fallback;
}

/**
 * 解析分身配置。
 *
 * @param {object} [env]
 * @returns {{enabled:boolean, maxClonesPerBot:number, maxPerBot:number}}
 *   `maxPerBot` 是**槽位总数**（1 主 + N 分身）：`off` 或未启用时恒为 1，
 *   于是调度器的「同 Bot 上限 1」行为与以前完全一致。
 */
export function resolveCloneConfig(env = process.env) {
  const enabled = parseOnOff(readBrandEnv(env, 'WORKER_CLONE'), true);
  const raw = Number(readBrandEnv(env, 'MAX_CLONES_PER_BOT'));
  const wanted = Number.isFinite(raw) && raw >= 0
    ? Math.min(MAX_CLONES_HARD_CAP, Math.floor(raw))
    : DEFAULT_CLONES_PER_BOT;
  return {
    enabled,
    maxClonesPerBot: wanted,
    maxPerBot: enabled ? Math.min(clonesSlotCeiling(), 1 + wanted) : 1,
  };
}

/**
 * 这一次真正允许几个「同 Bot 槽位」。
 *
 * @param {object} p
 * @param {number} [p.maxPerBot] 配置的槽位上限（1 = 串行）
 * @param {number} [p.upstreamHealth] 0..1；< 1 说明有熔断打开的组
 * @param {number} [p.concurrencyCap] 根并发上限 / 部门并发预算（Infinity = 不限）
 * @returns {number} 至少 1
 */
export function effectivePerBotLimit({ maxPerBot = 1, upstreamHealth = 1, concurrencyCap = null } = {}) {
  const slots = Math.max(1, Math.floor(Number(maxPerBot) || 1));
  if (slots <= 1) return 1;
  // ★ 上游不健康就退回串行：多开分身只会同时撞同一堵墙。
  const health = Number(upstreamHealth);
  if (Number.isFinite(health) && health < 1) return 1;
  const cap = Number(concurrencyCap);
  if (Number.isFinite(cap) && cap >= 1) return Math.max(1, Math.min(slots, Math.floor(cap)));
  return slots;
}

/**
 * 分身槽位键（会话泳道键）。
 *
 * 与 `runner/session-lanes.js` 同一套构造，这里只是给调度器一个
 * 「按任务算 cloneId」的入口（`cloneId = taskRunId`，天然幂等、可读）。
 */
export function cloneLaneKey({ roomId, botId, cloneId = null, modelOverride = null } = {}) {
  return sessionLaneKey({ roomId, botId, cloneId, modelOverride });
}

export { parseLaneKey, baseBotIdOfKey, isCloneLane, CLONE_INFIX };

/**
 * 这个子任务该用主槽位还是分身槽位。
 *
 * 判定顺序（都满足才开分身）：
 *   1. 是子任务（负责人/主控永远走主会话，保住协调记忆连续性）；
 *   2. 允许分身且还有配额；
 *   3. 主槽位**被占着**：同 Bot 已有别的在途任务，或主会话被用户聊天占着。
 *
 * @param {object} p
 * @param {object} p.taskRun
 * @param {number} [p.activeForBot] 同 Bot 当前在途任务数（含主槽）
 * @param {boolean} [p.mainLaneBusy] 主会话是否被占用（用户聊天/别的执行）
 * @param {number} [p.limit] `effectivePerBotLimit()` 的结果
 * @param {boolean} [p.enabled]
 * @returns {{useClone:boolean, cloneId:string|null, why:string}}
 */
export function planWorkerSlot({
  taskRun, activeForBot = 0, mainLaneBusy = false, limit = 1, enabled = true,
} = {}) {
  if (!taskRun?.parentTaskId) return { useClone: false, cloneId: null, why: '负责人/主控走主会话' };
  if (!enabled) return { useClone: false, cloneId: null, why: '分身未启用' };
  if (limit <= 1) return { useClone: false, cloneId: null, why: '同 Bot 槽位上限为 1' };
  const used = Math.max(0, Number(activeForBot) || 0);
  // 主槽位空着且用户没在聊 → 直接用主会话，没必要多开
  if (used === 0 && !mainLaneBusy) return { useClone: false, cloneId: null, why: '主会话空闲' };
  if (used >= limit) return { useClone: false, cloneId: null, why: '分身配额已满' };
  return { useClone: true, cloneId: String(taskRun.id), why: mainLaneBusy ? '主会话被占用' : '同 Bot 已有在途任务' };
}
