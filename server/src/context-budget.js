/**
 * 上下文预算：模型容量覆盖 + 压缩参数 + 占用读数。
 *
 * 本模块只跟 pi 的会话对象打交道，不碰房间、不碰调度：
 *   · withCapacity        把 bot 上设的 contextWindow / maxTokens 盖到模型上
 *   · applyCompactionBudget  把"什么时候压缩、压缩时保留多少"套到会话上
 *   · readContext         读回占用（给界面显示用了多少）
 *
 * 四个数（contextWindow / maxTokens / reserveTokens / keepRecentTokens）
 * 都能被用户或主控单独覆盖，所以每一层都是"设了才覆盖，没设交给下一层"。
 */
import { calculateContextTokens, estimateTokens } from '@earendil-works/pi-coding-agent';

import { config } from './config.js';
import { log } from './util.js';

/** 正数才要，其他一律 null（和 store 里那个同名助手一个意思） */
export function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * 保留原文必须低于最早触发线，并为摘要和**固定开销**留出空间。
 *
 * ★ 为什么要扣固定开销（fixedOverheadTokens）
 *
 *   上下文里有一块是每轮都在、且压缩动不了的：system prompt + 工具定义。
 *   原来算"压缩后能留多少原文"时只看触发线和摘要预算，没把这块算进去 ——
 *   于是账面上留 6 万，实际留给原文的只剩 6 万减掉固定开销。
 *
 *   实测症状（128k 窗口 / 0.6 触发 / 保留 60k）：
 *     触发线 76.8k，摘要预算 16k，名义保留上限 60.8k
 *     但 system + tools 通常有三四十 k，压完实际腾出的空间只有约 1 万 ——
 *     等于刚压完很快就又到线了，用户感觉"一直在压缩"。
 *
 *   扣掉之后，保留上限是"真正能留给原文的部分"。
 *   不额外设用户可感知的新下限：算出来太小就照实小，回退逻辑交给调用方。
 *
 * @param {object} p
 * @param {number} [p.fixedOverheadTokens] system + tools 占用的 token；不知道就传 0
 */
export function capRecentTokens({
  contextWindow, keepRecentTokens, reserveTokens = 16384, threshold = 0.6,
  fixedOverheadTokens = 0,
}) {
  const cw = positiveOrNull(contextWindow);
  const keep = positiveOrNull(keepRecentTokens);
  if (!cw || !keep) return keep;
  const configuredReserve = positiveOrNull(reserveTokens) ?? 16384;
  const reserve = configuredReserve < cw ? configuredReserve : Math.max(1, Math.floor(cw / 2));
  const ratio = Number.isFinite(Number(threshold))
    ? Math.min(0.95, Math.max(0.2, Number(threshold))) : 0.6;
  const trigger = Math.max(1, Math.floor(Math.min(cw * ratio, cw - reserve)));
  const summaryBudget = Math.min(reserve, Math.floor(trigger / 2));

  // 固定开销不能吃掉全部余量：至少给原文留 1 token，
  // 否则这个函数会返回一个没有意义的负数被上层当成"极小的保留量"。
  const overhead = Math.max(0, Math.floor(Number(fixedOverheadTokens) || 0));
  const roomForRecent = trigger - summaryBudget - overhead;
  return Math.min(keep, Math.max(1, roomForRecent));
}

/**
 * 把 bot 上设的 contextWindow / maxTokens 盖到模型对象上。
 *
 * ★ 只影响这一个会话 —— 不去改 pi 的 models.json。那是全局的，改了连用户在终端里
 *   用的 pi 一起变；而且"每个 bot 一套预算"本来就该是会话级的事。
 * 典型场景：模型标称 1M 上下文 / 32k 输出，但用户知道它实际能出 161k。
 */
export function withCapacity(model, bot = {}) {
  const cw = positiveOrNull(bot.contextWindow);
  const mt = positiveOrNull(bot.maxTokens);
  if (cw == null && mt == null) return model;
  return {
    ...model,
    ...(cw != null ? { contextWindow: cw } : {}),
    ...(mt != null ? { maxTokens: mt } : {}),
  };
}

/**
 * 把某个 bot 的上下文预算套到会话上。
 *
 * 触发线 = contextWindow - reserveTokens 用满就自动压缩；
 * 压缩时保留最近 keepRecentTokens 不总结。
 *
 * 三层回退：bot 上单独设的 → 全局 config（环境变量）→ pi 自带默认（16384 / 20000）。
 * 任何一层是 null 就不覆盖，交给下一层。
 */
/**
 * 校准系数 r：真实 token / estimateTokens 的估计值。
 *
 * ★ 为什么需要
 *
 *   依赖里的 estimateTokens 是 **chars / 4**。英文大致对（4 字符≈1 token），
 *   但中文约 **1 字 1 token** —— 于是 estimateTokens 把中文上下文低估约 4 倍。
 *   而切压缩保留点用的正是这个估计值，所以名义上"保留 6 万 token"
 *   实际留下了 25–29 万字符的原文（实测基准：压缩前 60.5 万、
 *   压缩请求 input 32–36 万，正是这个比例）。
 *
 *   要按"真实 token"来定保留量，就得先测出这块偏差。
 *
 * ★ 公式（分子分母覆盖同一批上下文，都含 system + 工具 + 全部历史）
 *
 *     分子 realTokens = (最近一次有效 assistant usage 的 input + cacheRead)
 *                     + Σ estimateTokens(该 usage 之后的消息)
 *     分母 estTokens  = estimateTokens(system prompt)
 *                     + Σ estimateTokens(工具定义)
 *                     + Σ estimateTokens(session.messages 全部)
 *     r = realTokens / estTokens
 *
 *   ★ 分子为什么是 input + cacheRead，不是 calculateContextTokens：
 *     calculateContextTokens 是 totalTokens || (input + output + cacheRead + cacheWrite)，
 *     **含 output**（模型这次生成的内容）。而对比基准是"上下文有多长" ——
 *     上下文里没有上一轮的 output（它作为 assistant 消息进了 messages，
 *     由分母的 estimateTokens 计入）。把 output 放分子会让 r 虚高。
 *     压缩请求的 cacheRead 几乎为 0（实测基准），所以实际 ≈ input。
 *
 *   ★ 分母为什么必须补 system 和工具：
 *     真实 usage 覆盖的是**整次请求**（system + 工具定义 + 全部消息）。
 *     只估 messages 会让分母偏小，r 虚高，keep 被算得过小 → 压得太狠。
 *
 * ★ 回退：任一为 0/NaN、或 r 落在不合理区间，返回 null，调用方不动 keep 值。
 *   宁可保持原行为，也不要拿一个错系数把会话压垮。
 */
export function estimateTokenRatio(session) {
  try {
    if (typeof estimateTokens !== 'function' || typeof calculateContextTokens !== 'function') {
      return null;
    }
    const messages = session?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // 分母：system + 工具 + 全部消息（与真实 usage 的覆盖范围对齐）
    let estTokens = 0;
    for (const m of messages) estTokens += estimateTokens(m);
    // system prompt 通常已经在 messages 里（role === 'system'），
    // 但有些分支下它单独挂在 session 上 —— 补一次，重复时不加。
    const hasSystemMsg = messages.some((m) => m?.role === 'system');
    if (!hasSystemMsg) {
      const sys = session?.systemPrompt;
      if (sys) {
        const msg = typeof sys === 'string'
          ? { role: 'system', content: sys }
          : { role: 'system', content: sys.content ?? '', sections: sys.sections };
        estTokens += estimateTokens(msg);
      }
    }
    // 工具定义也是每次请求都发出去的，真实 usage 里算进去了
    estTokens += estimateToolTokens(session);
    if (!Number.isFinite(estTokens) || estTokens <= 0) return null;

    // 分子：找最近一条有效 assistant usage，取其 **input + cacheRead**。
    //
    // 不用 calculateContextTokens —— 它是
    // totalTokens || (input + output + cacheRead + cacheWrite)，**含 output**。
    // 我们要比的是"上下文有多长"，而上一轮的 output 已经作为 assistant 消息
    // 进了 messages（由分母计入）。把它放分子会让 r 虚高、keep 算得过小。
    let usageIndex = -1;
    let usageTokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'assistant' || !m.usage) continue;
      if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
      const u = m.usage;
      const input = Number(u.input ?? u.inputTokens ?? u.input_tokens ?? 0) || 0;
      const cacheRead = Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0) || 0;
      const t = input + cacheRead;
      if (!Number.isFinite(t) || t <= 0) continue;
      usageIndex = i;
      usageTokens = t;
      break;
    }
    if (usageIndex < 0) return null; // 还没有真实 usage（新会话），没得校准

    // usage 之后新追加的消息只能估，补进分子
    let trailing = 0;
    for (let i = usageIndex + 1; i < messages.length; i++) {
      trailing += estimateTokens(messages[i]);
    }
    const realTokens = usageTokens + trailing;
    if (!Number.isFinite(realTokens) || realTokens <= 0) return null;

    const ratio = realTokens / estTokens;
    // 合理区间：英文约 1 倍，纯中文约 4 倍，中文为主 + 大段代码/JSON 时更高。
    // 实测（60 万汉字、真实 60.5 万 token）能到 8 左右，所以上限放到 16 ——
    // 留足余量，同时仍能挡住明显的脏数据（比如 usage 记的是上一次压缩前的，
    // 那种情况会算出几十上百）。
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 16) return null;
    return ratio;
  } catch {
    return null;
  }
}

/**
 * 估算工具定义占的 token（name + description + 参数 schema）。
 *
 * 抽出来是因为两处要用：固定开销（capRecentTokens）和校准分母
 * （estimateTokenRatio）—— 两处用同一套口径，结果才可比。
 */
function estimateToolTokens(session) {
  try {
    // ★ 依赖公开的接口是 getAllTools()，没有 tools getter 也没有 getTools()。
    //   写成后者会永远拿到 undefined → 返回 0 → 工具开销实际一分没扣，
    //   而且不报错（评审组抓到的）。
    //   这里用公开接口；拿不到就当 0（不猜），不影响其它逻辑。
    const tools = typeof session?.getAllTools === 'function'
      ? session.getAllTools()
      : null;
    if (!Array.isArray(tools)) return 0;
    let sum = 0;
    for (const t of tools) {
      const json = JSON.stringify({
        name: t?.name ?? '',
        description: t?.description ?? '',
        parameters: t?.parameters ?? t?.inputSchema ?? null,
      });
      // 与 estimateTokens 同量纲（chars / 4）
      sum += Math.ceil(json.length / 4);
    }
    return sum;
  } catch {
    return 0;
  }
}

/**
 * 估算「每轮都在、压缩动不了」的固定开销：system prompt + 工具定义。
 *
 * 拿不到就返回 0（当作没有固定开销），不猜一个数字糊弄调用方 ——
 * 猜大了会让保留量被无谓压小，猜小了等于没扣。
 *
 * 用 estimateTokens 的同一套口径（chars / 4）估，
 * 这样它和 capRecentTokens 里的其它数字在同一量纲上。
 */
export function fixedOverheadOf(session) {
  try {
    if (typeof estimateTokens !== 'function') return 0;
    let sum = 0;
    // system prompt（含 sections / toolsAdded）
    const sys = session?.systemPrompt;
    if (sys) {
      const msg = typeof sys === 'string'
        ? { role: 'system', content: sys }
        : { role: 'system', content: sys.content ?? '', sections: sys.sections };
      sum += estimateTokens(msg);
    }
    // 工具定义：参数 schema 也是每轮都发出去的
    sum += estimateToolTokens(session);
    return sum;
  } catch {
    return 0;
  }
}

export function applyCompactionBudget(session, bot = {}) {
  const sm = session?.settingsManager;
  if (!sm || typeof sm.applyOverrides !== 'function') return null;

  let reserve = positiveOrNull(bot.reserveTokens) ?? config.reserveTokens ?? null;
  let keep = positiveOrNull(bot.keepRecentTokens) ?? config.keepRecentTokens ?? null;
  // ★ 防御：reserve / keep ≥ 上下文窗口 = 没有意义的值。
  //   reserve 用来算"什么时候压缩"，等于窗口时触发线变成 0；
  //   keep 等于窗口时等于"什么都保留"，压缩压不动，会话会一路顶到 100% 再炸。
  //   这种配置直接丢弃，回退到 pi 的默认值。
  const cw = Number(session?.model?.contextWindow ?? 0);
  if (cw > 0) {
    if (reserve != null && reserve >= cw) reserve = null;
    if (keep != null && keep >= cw) keep = null;
  }
  const overrides = {};
  if (reserve != null) overrides.reserveTokens = reserve;
  if (keep != null) overrides.keepRecentTokens = keep;
  if (cw > 0) {
    let existing = {};
    try { existing = sm.getCompactionSettings?.(session.model) ?? {}; } catch {}
    let effectiveReserve = reserve ?? positiveOrNull(existing.reserveTokens) ?? 16384;
    if (effectiveReserve >= cw) {
      effectiveReserve = Math.max(1, Math.floor(cw / 2));
      overrides.reserveTokens = effectiveReserve;
    }
    const requestedKeep = keep ?? positiveOrNull(existing.keepRecentTokens) ?? 20000;
    const boundedKeep = capRecentTokens({
      contextWindow: cw, keepRecentTokens: requestedKeep,
      reserveTokens: effectiveReserve, threshold: config.compactAtPercent,
      // system prompt + 工具定义是压缩动不了的固定开销，必须从"能留给原文的空间"里扣掉
      fixedOverheadTokens: fixedOverheadOf(session),
    });
    if (boundedKeep < requestedKeep) {
      overrides.keepRecentTokens = boundedKeep;
    }
    const model = session.model;
    if (model?.provider && model?.id
        && (overrides.keepRecentTokens != null || overrides.reserveTokens != null)) {
      overrides.modelOverrides = {
        [`${model.provider}/${model.id}`]: {
          ...(overrides.keepRecentTokens != null ? { keepRecentTokens: overrides.keepRecentTokens } : {}),
          ...(overrides.reserveTokens != null ? { reserveTokens: overrides.reserveTokens } : {}),
        },
      };
    }
  }
  if (!config.autoCompact) overrides.enabled = false;
  if (Object.keys(overrides).length === 0) return null;
  try {
    sm.applyOverrides({ compaction: overrides });
    return overrides;
  } catch (err) {
    log('⚠️  设置上下文预算失败：', err?.message || err);
    return null;
  }
}

/**
 * 读一个会话的上下文占用。
 *
 * 返回 null 表示"现在还不知道"（比如刚压缩完、还没等到下一次回复）——
 * 这时候界面该显示"—"而不是 0%，否则用户会以为上下文是空的。
 */
export function readContext(session) {
  try {
    const u = session?.getContextUsage?.();
    if (!u) return null;
    return {
      tokens: u.tokens ?? null,
      contextWindow: u.contextWindow ?? null,
      percent: u.percent ?? null,
      compacting: Boolean(session.isCompacting),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 小上下文窗口（≤ 128k）的补盲：占用估计 + 截断判定
//
// ★ 真机复现（`nemotron-3.5-super-vl`，128k 窗口）：上一轮压缩过一次之后
//   `getContextUsage().percent` 是 **null**（还没有新的 assistant usage），
//   于是 `compactIfNeeded` 直接放过；界面按 `chars/4` 粗估只显示 45%，
//   而老会话残留的 5 篇技能全文 + 工具定义 + 历史摘要其实已占 ~117k。
//   轮内连调 3 次工具后第 4 次请求就到了 124,339 / 128,000（97.1%），
//   模型返回 `output: 1, stopReason: 'length'`、正文为空 —— 静默中断。
//
//   所以这里补两件事：一个**保守**的占用估计（把固定开销算进去），
//   和一个纯的"这一轮是不是被长度上限截断了"的判定。
// ---------------------------------------------------------------------------

/** ≤ 这个值就算「小上下文窗口」：压缩与技能注入都要收紧。 */
export const SMALL_CONTEXT_WINDOW = 128_000;

/** 被长度上限截断后追加在正文末尾的提示（用户必须知道这不是完整结论）。 */
export const LENGTH_NOTICE =
  '\n\n_（本轮输出因达到模型上下文/长度上限被中断，建议重置当前会话或切换更大上下文模型后重试）_';

/** 最近一条 assistant 消息的提示 token（input + cacheRead）。拿不到返回 null。 */
export function latestPromptTokens(session) {
  try {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'assistant' || !m.usage) continue;
      if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
      const u = m.usage;
      const input = Number(u.input ?? u.inputTokens ?? u.input_tokens ?? 0) || 0;
      const cacheRead = Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0) || 0;
      const total = input + cacheRead;
      if (Number.isFinite(total) && total > 0) return total;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 保守的上下文占用（0..100）。拿不到窗口时返回 null。
 *
 * 口径：`fixedOverheadOf`（system prompt + 工具定义，每轮都发）+ 逐条非 system
 * 消息的 `estimateTokens`（pi 的 chars/4）。**故意偏保守**：
 *   · 工具定义与技能注入占的是一大块，界面那个只数消息正文的估算法会漏掉它
 *     （117k 被显示成 45% 就是漏了这块）；
 *   · 真 window 未知时不做猜测（返回 null），不拿 0 假装"很空"。
 */
/**
 * 单条消息的**保守** token 估计。
 *
 * ★ 为什么不用现成的 `estimateTokens`（chars/4）：
 *   中文一个字约等于 1 token，而 chars/4 会把它算成 0.25 —— 中文会话的占用
 *   会被**低估到四分之一**，正是真机上「实际 117k、界面显示 45%」的来源。
 *   这里按「CJK/全角按 1 token/字 + 其余按 4 字符/token」，再与框架估计取较大值，
 *   宁可高估（提前压缩）也不要低估（撑爆后被截断）。
 */
function conservativeMessageTokens(message) {
  const base = estimateTokens(message);
  try {
    const parts = Array.isArray(message?.content) ? message.content : [message?.content];
    const text = parts
      .map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : '')))
      .join('\n');
    if (!text) return base;
    const cjk = (text.match(/[㐀-鿿豈-﫿＀-￯　-〿]/g) ?? []).length;
    const rest = text.length - cjk;
    return Math.max(base, Math.ceil(cjk + rest / 4));
  } catch {
    return base;
  }
}

export function estimateUsagePercent(session) {
  try {
    const cw = Number(session?.model?.contextWindow ?? 0);
    if (!Number.isFinite(cw) || cw <= 0) return null;
    const overhead = fixedOverheadOf(session);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    let tokens = overhead;
    for (const m of messages) {
      // system 已经在 fixedOverheadOf 里算过，不重复计
      if (m?.role === 'system') continue;
      tokens += conservativeMessageTokens(m);
    }
    // ★ 一条数据都没有（没有消息、也没有 system/工具开销）时返回 null：
    //   拿 0% 冒充"很空"会把真实读数（例如 usage.percent = 90）覆盖掉，
    //   压缩反而被跳过 —— 这正是 abort-placeholder 那条回归抓到的坑。
    if (!messages.length && !overhead) return null;
    return Math.min(100, Math.max(0, (tokens / cw) * 100));
  } catch {
    return null;
  }
}

/**
 * 这一轮是不是被「长度上限」截断了（纯判定）。
 *
 * 典型现场：工具调用前模型顺口吐了一句过渡话（进 `committed`），工具回来后
 * 剩下 3% 窗口，模型只吐了 1 个 thinking token 就被截断
 * （`stopReason: 'length'`、正文为空）。这时 `render()` 非空，
 * 旧代码直接把那句过渡话标成 `done` —— 不报错、不压缩、不重试。
 *
 * @param {object} p
 * @param {string|null} p.stopReason
 * @param {boolean} p.hadText 最后一条 assistant 是否有正文
 * @param {number|null} [p.promptTokens] 最近一次请求的 input + cacheRead
 * @param {number} [p.contextWindow]
 * @param {number|null} [p.percent] `getContextUsage().percent`（可能为 null）
 * @param {boolean} [p.cancelled]
 * @param {boolean} [p.stepCapHit]
 * @returns {{truncated:boolean, nearLimit:boolean, promptTokens:number|null, percent:number|null}}
 */
export function lengthTruncationOf({
  stopReason = null,
  hadText = false,
  promptTokens = null,
  contextWindow = 0,
  percent = null,
  cancelled = false,
  stepCapHit = false,
  timedOut = false,
} = {}) {
  const cw = Number(contextWindow);
  const tokens = Number.isFinite(Number(promptTokens)) && Number(promptTokens) > 0
    ? Number(promptTokens)
    : null;
  const byTokens = Number.isFinite(cw) && cw > 0 && tokens != null ? (tokens / cw) * 100 : null;
  const usage = typeof percent === 'number' && Number.isFinite(percent) ? percent : byTokens;
  const nearLimit = (tokens != null && Number.isFinite(cw) && cw > 0 && tokens >= cw * 0.85)
    || (usage != null && usage >= 85);
  // 取消 / 步数上限 / 请求超时都属于"本来就要停"，不该被当成需要抢救的截断
  // （超时被 abort 后 stopReason 也会是 'length' 或空，不能拿它去强压续答）
  const truncated = stopReason === 'length' && !hadText && !cancelled && !stepCapHit && !timedOut;
  return { truncated, nearLimit, promptTokens: tokens, percent: usage };
}
