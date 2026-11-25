/**
 * 单轮临时切健康模型（SPEC-PERF-V1 §4.2 d / §11·3）。
 *
 * ## 要解决的问题
 *
 * `retry-policy.js` 的 `switchModel` 以前**只改提示词文案**：提示里多一句
 * 「考虑换个模型」，实际重跑还是用原来那个坏掉的模型。单端点组没有端点可轮转，
 * 于是「上游这家挂了」等于「这件事死了」。
 *
 * ## 六条硬约束（§4.2 d）
 *
 * | 项 | 这里怎么落实 |
 * |---|---|
 * | 作用域 | 只对**当前这次重试**生效（`withFallbackModel` 的一次性会话）；绝不写 `bot.model` |
 * | 选型 | 只在「已启用」的模型组里挑，优先健康的默认模型，其次其它已启用且健康的候选 |
 * | 能力校验 | 带图请求必须有 vision；给了 `contextWindow` 需求就过滤明显不够的 |
 * | 跨 provider | 一次性会话（`sessionKey#fb` + `SessionManager.inMemory`），不碰原 JSONL |
 * | 可观测 | `bot.retrying` 带 `switchedTo`（只给安全显示名），`run-stats` 记 `switchedModel` |
 * | 失败回退 | 单条重试链最多切 1 次；临时模型也失败就回原模型走既有链路，不连环换 |
 *
 * 纯函数部分（`shouldSwitchEarly` / `pickAlternateModel`）不碰 IO，单测直接打；
 * IO 部分只有 `withFallbackModel` 一个入口。
 */
import { sessionKey } from './runner-utils.js';

/** 同一模型连续第几次临时故障才切（`model-idle` 与熔断另有更早的门槛）。 */
export const FALLBACK_AFTER_FAILS = 2;

/**
 * 要不要早切换。
 *
 * @param {object} p
 * @param {number} [p.fails]           这个模型**连续**几次临时故障（从 1 起算）
 * @param {string} [p.kind]            最近一次的失败类型（`decideRetry` 的 kind）
 * @param {boolean} [p.breakerOpen]    该模型所属组熔断是否已打开
 * @param {boolean} [p.userLocked]     用户显式锁定了模型 → 一律不切
 * @param {boolean} [p.hasAlternate]   有没有健康替代（没有就维持现状）
 * @param {boolean} [p.alreadySwitched] 这条重试链已经切过一次 → 不连环换
 * @returns {boolean}
 */
export function shouldSwitchEarly({
  fails = 0,
  kind = '',
  breakerOpen = false,
  userLocked = false,
  hasAlternate = false,
  alreadySwitched = false,
} = {}) {
  if (userLocked || alreadySwitched || !hasAlternate) return false;
  if (breakerOpen) return true;
  // 一个字都不吐：等它自愈不如换条通路（第 1 次就切）
  if (kind === 'model-idle') return fails >= 1;
  // 其它临时故障：连续第 2 次才切（一次抖动不值得换，换过去还有会话成本）
  return fails >= FALLBACK_AFTER_FAILS;
}

/** 候选模型是否满足这次请求的能力要求。 */
export function meetsNeeds(model, { images = false, contextWindow = 0 } = {}) {
  if (!model) return false;
  if (images) {
    const vision = model.vision === true
      || (Array.isArray(model.input) && model.input.includes('image'));
    if (!vision) return false;
  }
  const need = Number(contextWindow) || 0;
  const have = Number(model.contextWindow) || 0;
  if (need > 0 && have > 0 && have < need) return false;
  return true;
}

/**
 * 挑一个替代模型。
 *
 * 顺序：**健康的默认模型优先**，其次按候选给出的先后（调用方按已启用顺序传）。
 *
 * @param {object} p
 * @param {string} [p.from]                 当前正在用的模型 slug
 * @param {Array<object>} [p.candidates]    `[{ slug, label, groupId, enabled, ...能力字段 }]`
 * @param {string|null} [p.defaultModel]    默认模型 slug（健康时优先）
 * @param {string[]} [p.tried]              已经试过的 slug（不回头）
 * @param {(slug:string, groupId:string)=>boolean} [p.isBreakerOpen]
 * @param {{images?:boolean, contextWindow?:number}} [p.needs]
 * @param {(candidate:object)=>object|null} [p.capabilitiesOf] 把候选换成带能力字段的对象
 * @returns {{slug:string, label:string, groupId:string, why:string}|null}
 */
export function pickAlternateModel({
  from = '',
  candidates = [],
  defaultModel = null,
  tried = [],
  isBreakerOpen = () => false,
  needs = {},
  capabilitiesOf = null,
} = {}) {
  const blocked = new Set([from, ...tried].filter(Boolean));
  const pool = [];
  for (const c of candidates ?? []) {
    if (!c || !c.slug) continue;
    if (c.enabled === false) continue;
    if (blocked.has(c.slug)) continue;
    if (isBreakerOpen(c.slug, c.groupId ?? '')) continue;
    const caps = capabilitiesOf ? (capabilitiesOf(c) ?? c) : c;
    if (!meetsNeeds(caps, needs)) continue;
    pool.push({ ...c, ...caps });
  }
  if (!pool.length) return null;
  const preferred = defaultModel ? pool.find((c) => c.slug === defaultModel) : null;
  const pick = preferred ?? pool[0];
  return {
    slug: pick.slug,
    label: pick.label ?? pick.alias ?? pick.slug,
    groupId: pick.groupId ?? '',
    why: preferred ? '默认模型健康，先回到默认模型' : '换一条健康的已启用通路',
  };
}

/**
 * 一次性回退会话：在本轮里用**另一个模型**跑，跑完就扔掉。
 *
 * ★ 三条不许破：
 *   1. 不写 `bot.model`，也不"粘"到新模型：下一轮仍从用户配置开始；
 *   2. 不复用原会话文件（跨 provider 会把 A 家的 tool-call 历史喂给 B 家）：
 *      `persist: false` 走 `SessionManager.inMemory`；
 *   3. 用户点「终止」要能打到它：键是 `${sessionKey}#fb`，`${roomId}:` 前缀仍在，
 *      `runner.abort(roomId)` 照旧能中止。
 */
export async function withFallbackModel({ runner, roomId, botId, model, log = () => {} }, fn) {
  if (!model || !runner?.__buildSession) return fn(null);
  const key = `${sessionKey(roomId, botId)}#fb`;
  const entry = await runner.__buildSession(roomId, botId, {
    reportTool: false, modelOverride: model, persist: false,
  });
  entry.busy = false;
  entry.unsubscribe = null;
  entry.pending = null;
  runner.sessions.set(key, entry);
  log(`临时切到备用模型（本轮有效，不改配置）：${botId} → ${model}`);
  try {
    return await fn(entry);
  } finally {
    runner.sessions.delete(key);
    try { entry.unsubscribe?.(); } catch {}
    try { await entry.session?.dispose?.(); } catch {}
  }
}

/**
 * 熔断与统计的归属：按**这次真的在跑的那个模型**记，而不是 `bot.model`。
 *
 * 踩过的坑：主模型在组 A（坏着），临时切到组 B 跑通了 —— 如果照旧按 `bot.model`
 * 记 `markGroupHealthy(botId)`，就会把坏着的组 A 标成健康，下一次立刻又撞墙。
 */
export function attributeModel({ botId, overrideModel = null, bot = null } = {}) {
  const slug = overrideModel || String(bot?.model ?? '');
  if (!slug) return null;
  const idx = slug.includes('/') ? slug.indexOf('/') : -1;
  return {
    botId,
    model: slug,
    groupId: idx > 0 ? slug.slice(0, idx) : '',
    switched: Boolean(overrideModel),
  };
}

/**
 * 给编排层用的一步到位版本：读 bot 当前模型、候选清单与熔断状态，回答「这一轮要不要切、切到谁」。
 *
 * 只读：不改 `bot.model`、不建会话。真正的切换由 `turn-executor` 用一次性会话做。
 *
 * @returns {{slug:string, label:string, groupId:string, why:string}|null}
 */
export function planFallbackForBot({
  runner, botId, fails = 0, kind = '', hasImages = false, contextWindow = 0,
  userLocked = false, alreadySwitched = false,
} = {}) {
  const bot = runner?.store?.getBot?.(botId);
  const from = String(bot?.model ?? '');
  if (!from) return null;
  const breakerOpen = runner?.breakerFor?.(botId)?.breaker?.state === 'open';
  const candidates = [];
  for (const entry of runner?.modelGroups?.menuEntries?.() ?? []) {
    for (const slug of entry.slugs ?? []) {
      candidates.push({
        slug,
        label: entry.label ?? entry.alias ?? slug,
        groupId: entry.groupId ?? '',
        contextWindow: entry.contextWindow,
      });
    }
  }
  const alt = pickAlternateModel({
    from,
    candidates,
    // 默认模型（用户配置的那个）健康时优先回去
    defaultModel: runner?.modelLabel?.() ?? null,
    isBreakerOpen: (slug) => runner?.breakerFor?.(botId, slug)?.breaker?.state === 'open',
    needs: { images: hasImages, contextWindow },
    capabilitiesOf: (c) => runner?.resolveModel?.(c.slug) ?? c,
  });
  if (!alt) return null;
  const go = shouldSwitchEarly({
    fails, kind, breakerOpen, userLocked, hasAlternate: true, alreadySwitched,
  });
  return go ? alt : null;
}
