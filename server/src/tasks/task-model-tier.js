/**
 * 任务难度的模型分档：一次执行该用「快 / 标准 / 强」哪一档模型（纯策略）。
 *
 * ## 要解决的问题
 *
 * 一个成员名下所有子任务共用一个固定模型。结果就是：
 *   · 「把这份表整理成清单」也在烧最贵的强模型（慢、贵）；
 *   · 「重构这段并发逻辑、排查这个死锁」可能被默认的轻模型卡住，反复返工。
 * 两头的浪费都很真实，而**用户配好的成员模型不该被随便改** —— 所以默认
 * 档位是 `explicit`：只有任务/负责人显式写了 `modelTier` 才生效。
 *
 * ## 六条硬边界（一条都不许破）
 *
 * 1. `standard` / 无效 / 模式 `off` → 不覆盖（零扰动）；
 * 2. `bot.lockModel === true`（用户锁定）→ 绝不覆盖；
 * 3. **本地/内网隔离**：执行者是本地端点时，分档候选（含
 *    `ORBIS_TIER_MODEL_FAST/STRONG`）**绝不能跳到公有云**；
 * 4. 熔断打开的组跳过；
 * 5. 档位打分（`fast` 偏好 flash/mini/haiku…，`strong` 偏好 opus/pro/reason…）；
 * 6. 挑出来和基线是同一个模型 → 返回不覆盖（没必要为同名模型多开一层会话）。
 *
 * ## 边界
 *
 * 纯函数、零 IO：不建会话、不改 `bot.model`。真正用哪个模型由
 * `task-runtime.runOne` 传 `modelOverride` 给一次性内存会话。
 */
import { readBrandEnv } from '../brand.js';
import { isLocalEndpoint, providerOfSlug } from '../runner/model-fallback.js';

/** 三档。 */
export const MODEL_TIER = Object.freeze({ fast: 'fast', standard: 'standard', strong: 'strong' });

/** 档位模式。 */
export const TIER_MODE = Object.freeze({ off: 'off', explicit: 'explicit', auto: 'auto' });

/** 默认：只在显式指定时生效（不擅自改用户配好的成员模型）。 */
export const DEFAULT_TIER_MODE = TIER_MODE.explicit;

export const TIER_MODES = Object.values(TIER_MODE);
export const TIER_VALUES = Object.values(MODEL_TIER);

/** 从环境读档位模式：`ORBIS_MODEL_TIER`。 */
export function resolveTierMode(env = process.env) {
  const raw = String(readBrandEnv(env, 'MODEL_TIER') ?? '').trim().toLowerCase();
  return TIER_MODES.includes(raw) ? raw : DEFAULT_TIER_MODE;
}

/**
 * 显式档位模型覆盖（`ORBIS_TIER_MODEL_FAST` / `ORBIS_TIER_MODEL_STRONG`）。
 *
 * `standard` 刻意不支持覆盖：标准档就该用成员自己的模型，配了反而容易
 * 把「用户选的模型」悄悄换掉。
 */
export function tierModelOverrides(env = process.env) {
  const fast = String(readBrandEnv(env, 'TIER_MODEL_FAST') ?? '').trim();
  const strong = String(readBrandEnv(env, 'TIER_MODEL_STRONG') ?? '').trim();
  return { fast: fast || null, strong: strong || null };
}

/** 规范化一个档位值（不合法返回 null）。 */
export function normalizeTier(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return TIER_VALUES.includes(text) ? text : null;
}

// ---------------------------------------------------------------- 难度推断

/** 强推理/易错活的信号词。 */
const STRONG_SIGNALS = [
  /架构|设计|方案设计|重构|排障|排查|死锁|并发|竞态|性能|优化|审计|安全|漏洞|迁移|协议|一致性|接口设计|取舍|权衡|证明|推理|算法|调优|根因|疑难|复杂/i,
  /refactor|architect|debug|deadlock|race|concurrenc|performance|profil|audit|secur|migrat|protocol|consisten|reason|algorithm|root cause|redesign/i,
];

/** 机械/低风险活的信号词。 */
const FAST_SIGNALS = [
  /格式化|排版|提取|抽取|汇总|摘要|摘要化|清单|列表|整理|翻译|润色|改名|替换|分类|归类|去重|排序|模板|套模板|填写|录入/i,
  /format|reformat|extract|lint|summar|translat|proofread|rename|replace|categor|dedupe|sort|template|fill|clean ?up/i,
];

function textOfGoal(taskRun) {
  const goal = taskRun?.goal ?? {};
  const parts = [
    String(goal.requirement ?? ''),
    String(goal.scope ?? ''),
    ...(goal.deliverables ?? []).map((d) => String(d ?? '')),
  ];
  return parts.filter(Boolean).join('\n');
}

function countSignals(text, list) {
  let hits = 0;
  const seen = new Set();
  for (const pattern of list) {
    const found = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'));
    if (!found) continue;
    for (const item of found) {
      const key = String(item).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      hits += 1;
    }
  }
  return hits;
}

/**
 * 按任务特征推断难度档（纯启发式，只在 `auto` 且未显式指定时用）。
 *
 * 判据刻意保守：**拿不准就 `standard`**。分错档的代价是「用错模型」，
 * 而 `standard` 永远是成员自己的模型 —— 至少不会比今天更差。
 *
 * @param {object} taskRun
 * @returns {'fast'|'standard'|'strong'}
 */
export function inferTaskTier(taskRun) {
  const text = textOfGoal(taskRun);
  if (!text.trim()) return MODEL_TIER.standard;
  const verifications = Array.isArray(taskRun?.goal?.verification) ? taskRun.goal.verification : [];
  const hasExpert = verifications.some((v) => String(v?.kind ?? '') === 'expert');
  const hasTest = verifications.some((v) => String(v?.kind ?? '') === 'test');
  const criticRequired = taskRun?.flags?.criticRequired === true;
  const strongHits = countSignals(text, STRONG_SIGNALS);
  const fastHits = countSignals(text, FAST_SIGNALS);
  // 要求「独立复核 / 专业判断 / 跑测试」本来就是要质量：直接强档
  if (criticRequired || hasExpert) return MODEL_TIER.strong;
  if (strongHits > 0 && strongHits >= fastHits) return MODEL_TIER.strong;
  if (hasTest && fastHits === 0) return MODEL_TIER.strong;
  if (fastHits > 0 && strongHits === 0) {
    // 纯机械活：只有「明确没有质量闸门」时才算快档
    return criticRequired || hasExpert || hasTest ? MODEL_TIER.standard : MODEL_TIER.fast;
  }
  return MODEL_TIER.standard;
}

// ---------------------------------------------------------------- 选模型

/** 快档偏好的模型名特征。 */
const FAST_PATTERN = /flash|mini|haiku|lite|small|nano|fast|turbo|instant/i;
/** 强档偏好的模型名特征。 */
const STRONG_PATTERN = /opus|pro\b|max|sonnet|o1|o3|o4|r1|reason|thinking|codex|large|72b|70b|qwen3-max|ultra/i;

/** 候选是不是本地端点（支持预计算的 `local`）。 */
function isLocalCandidate(candidate) {
  if (typeof candidate?.local === 'boolean') return candidate.local;
  return isLocalEndpoint(candidate ?? {});
}

/** 候选的显示名（打分只看名字与上下文长度）。 */
function labelOf(candidate) {
  return String(candidate?.label ?? candidate?.alias ?? candidate?.slug ?? '');
}

/** 档位打分：同档里越高越好。 */
function scoreForTier(tier, candidate) {
  const name = labelOf(candidate);
  const window = Number(candidate?.contextWindow ?? 0);
  if (tier === MODEL_TIER.fast) {
    let score = 0;
    if (FAST_PATTERN.test(name)) score += 3;
    // 本身就是重推理/高延迟模型的，快档要扣分
    if (STRONG_PATTERN.test(name)) score -= 2;
    if (window > 0) score -= Math.min(1, Math.log10(window / 100_000 + 1));
    return score;
  }
  let score = 0;
  if (STRONG_PATTERN.test(name)) score += 3;
  if (FAST_PATTERN.test(name)) score -= 2;
  if (window > 0) score += Math.min(2, Math.log10(window / 100_000 + 1) * 1.5);
  return score;
}

/**
 * 选一档模型。
 *
 * @param {object} p
 * @param {string} p.tier `fast` / `standard` / `strong`
 * @param {object|null} [p.baseModel] 生效的执行模型 `{ slug, provider, baseUrl, local }`
 * @param {Array<object>} [p.candidates] `[{ slug, label, groupId, provider, baseUrl, contextWindow, local, enabled }]`
 * @param {boolean} [p.userLocked] `bot.lockModel === true`
 * @param {{fast?:string|null, strong?:string|null}} [p.explicitTierModels]
 * @param {Function} [p.isBreakerOpen]
 * @returns {{overrideModel:string|null, tier:string, why:string, candidate?:object|null}}
 */
export function selectTierModel({
  tier = MODEL_TIER.standard,
  baseModel = null,
  candidates = [],
  userLocked = false,
  explicitTierModels = null,
  isBreakerOpen = null,
} = {}) {
  const wanted = normalizeTier(tier);
  const baseSlug = String(baseModel?.slug ?? '').trim();
  // 边界 1：标准档 / 无效档 → 零扰动
  if (!wanted || wanted === MODEL_TIER.standard) {
    return { overrideModel: null, tier: wanted ?? MODEL_TIER.standard, why: '沿用成员默认模型', candidate: null };
  }
  // 边界 2：用户锁定了模型 → 绝不覆盖
  if (userLocked === true) {
    return { overrideModel: null, tier: wanted, why: '用户锁定了成员模型，不覆盖', candidate: null };
  }
  const open = typeof isBreakerOpen === 'function' ? isBreakerOpen : () => false;
  const pool = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.slug && c.enabled !== false && !open(c.slug, c.groupId ?? ''));
  // 边界 3：本地执行者的判定（多端点/预计算 local 都吃得住）
  const baseProbe = {
    ...(baseModel ?? {}),
    provider: String(baseModel?.provider ?? '').trim() || providerOfSlug(baseSlug),
    model: baseSlug,
    id: baseSlug,
  };
  const baseLocal = typeof baseModel?.local === 'boolean' ? baseModel.local : isLocalEndpoint(baseProbe);
  const isLocalNow = (candidate) => {
    if (!baseLocal) return true;
    return isLocalCandidate(candidate);
  };

  // ---------------------------------------------------------------- 显式档位
  //
  // ★ 显式配置是**用户的明确选择**，只有两种结局：用它，或明确拒绝并说明原因。
  //   绝不能「它不能用 → 我顺手换一个别的」：用户以为生效了，实际跑的是另一个模型。
  const explicitWanted = String(explicitTierModels?.[wanted] ?? '').trim();
  if (explicitWanted) {
    if (explicitWanted === baseSlug) {
      // 显式指定的就是当前模型：什么都不用做（也别换走！）
      return {
        overrideModel: null,
        tier: wanted,
        why: '显式档位模型就是当前模型，不覆盖',
        candidate: null,
      };
    }
    const hit = pool.find((c) => c.slug === explicitWanted) ?? null;
    const explicitIsLocal = hit ? isLocalCandidate(hit) : isLocalEndpoint({
      model: explicitWanted,
      id: explicitWanted,
      provider: providerOfSlug(explicitWanted),
    });
    if (baseLocal && !explicitIsLocal) {
      // 本地执行者 + 云端显式档位模型 = 数据外泄。池里有没有本地候选都无所谓：
      // 用户点名要的那个不能用，就如实沿用成员模型。
      return {
        overrideModel: null,
        tier: wanted,
        why: '显式档位模型在云端，而执行者是本地模型：拒绝外泄',
        rejected: 'explicit_cloud_for_local',
        candidate: null,
      };
    }
    if (hit) {
      return {
        overrideModel: hit.slug,
        tier: wanted,
        why: '按 ORBIS_TIER_MODEL_' + wanted.toUpperCase() + ' 指定',
        candidate: hit,
      };
    }
    return {
      overrideModel: null,
      tier: wanted,
      why: '显式档位模型不可用（不在已启用组里或熔断打开）：沿用成员默认模型',
      rejected: 'explicit_unavailable',
      candidate: null,
    };
  }

  // ---------------------------------------------------------------- 自动挑选
  //
  // ★ 必须**比基线更好**才换：旧实现只在「同分」时才不换，于是
  //   `opus + strong` 会被挑成 mini（因为 mini 在别的维度分更高）、
  //   `flash + fast` 会被升成 opus —— 反向降级/升级比不换更贵。
  const others = pool.filter((c) => c.slug !== baseSlug && isLocalNow(c));
  if (!others.length) {
    return { overrideModel: null, tier: wanted, why: '没有其它可用模型，沿用成员默认模型', candidate: null };
  }
  const baseScore = scoreForTier(wanted, baseProbe);
  const scored = others
    .map((candidate, index) => ({ candidate, score: scoreForTier(wanted, candidate) - index * 0.01 }))
    .sort((a, b) => b.score - a.score);
  const pick = scored[0]?.candidate ?? null;
  const bestScore = scored[0]?.score ?? Number.NEGATIVE_INFINITY;
  // 必须有**正向**档位特征，且比当前模型更贴这一档
  if (!pick || bestScore <= 0 || bestScore <= baseScore) {
    return {
      overrideModel: null,
      tier: wanted,
      why: '当前模型已是同档最佳或无更合适候选，不覆盖',
      candidate: null,
    };
  }
  return {
    overrideModel: pick.slug,
    tier: wanted,
    why: (wanted === MODEL_TIER.fast ? '换快模型省时省钱' : '换强模型保证质量') + '：' + labelOf(pick),
    candidate: pick,
  };
}

/**
 * 一次执行最终用哪一档（把模式、显式档、推断档收成一处）。
 *
 * @param {object} p
 * @param {object} p.taskRun
 * @param {string} [p.mode] 见 `TIER_MODE`
 * @param {object} [p.env]
 * @returns {{tier:string, source:'explicit'|'auto'|'off'|'standard'}}
 */
export function resolveTaskTier({ taskRun, mode = DEFAULT_TIER_MODE, env = process.env } = {}) {
  void env;
  const explicit = normalizeTier(taskRun?.flags?.modelTier ?? taskRun?.modelTier);
  if (mode === TIER_MODE.off) return { tier: MODEL_TIER.standard, source: 'off' };
  if (explicit) return { tier: explicit, source: 'explicit' };
  if (mode === TIER_MODE.auto) return { tier: inferTaskTier(taskRun), source: 'auto' };
  return { tier: MODEL_TIER.standard, source: 'standard' };
}
