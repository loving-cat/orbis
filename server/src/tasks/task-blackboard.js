/**
 * 根任务级「共享黑板」：全组共用的事实、约束、决定与产物（纯函数）。
 *
 * ## 为什么需要它
 *
 * 一份大活拆给几个人之后，最贵的信息传递是「刚才那个人得出的结论」：
 *   · 甲量出「金额一律用 addMoney，不许浮点相加」——乙不知道，就会写出另一种口径；
 *   · 甲已经把数据集整理到 `out/clean.csv`——乙又从原始表重做了一遍；
 *   · 负责人决定了「先交首批 100 条」——第三天新起的成员完全不知道。
 *
 * 靠模型在群里"转述"这件事有三个毛病：要额外一次模型调用、会走样、
 * 而且每转述一次就再烧一次上下文。所以这里给它一块**确定性的**黑板：
 * 交付事实由系统自动落（0 次模型调用），人/负责人可以显式补决定与约束，
 * 之后任何成员开工时都会自动读到压缩版。
 *
 * ## 边界（为什么必须严格有界）
 *
 * 黑板会进每一轮成员提示词，所以它**必须**有硬上限：
 *   · 最多 24 条（超了先淘汰最旧的非约束条目 —— 约束是规矩，不该被时间挤掉）；
 *   · 单条正文 ≤ 240 字、引用 ≤ 160 字；
 *   · 渲染成提示词时总共 ≤ 1200 字。
 * 没有这些上限，黑板会随着任务推进慢慢长成吃光上下文的东西，
 * 而"吃光上下文"的表现是任务开始胡说 —— 比没有黑板更糟。
 *
 * 不读盘、不写记录：写入方（supervisor / 工具）自己拿 mutate 落盘。
 */
import { artifactRefs } from './task-dag.js';

/** 一条黑板能记的四类东西。 */
export const BLACKBOARD_KINDS = Object.freeze(['decision', 'constraint', 'artifact', 'fact']);

/** 黑板的各种硬上限（单一真源，工具与提示词都用它）。 */
export const BLACKBOARD_LIMITS = Object.freeze({
  maxEntries: 24,
  maxTextChars: 240,
  maxRefChars: 160,
  maxRenderChars: 1200,
});

const KIND_LABEL = Object.freeze({
  decision: '决定',
  constraint: '约束',
  artifact: '产物',
  fact: '事实',
});

/** 空黑板。 */
export function emptyBlackboard(at = 0) {
  return { entries: [], updatedAt: Number(at) || 0 };
}

/**
 * 把任意来路的数据洗成合法黑板（旧记录 / 手工改过的 / 缺字段的都要能用）。
 *
 * @param {object|null|undefined} raw
 * @returns {{entries:Array<object>, updatedAt:number}}
 */
export function normalizeBlackboard(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return {
    entries: entries.filter((e) => e && typeof e === 'object' && String(e.text ?? '').trim()),
    updatedAt: Number(raw?.updatedAt) || 0,
  };
}

/** 稳定短指纹（只用于生成幂等的条目 id）。 */
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 按字数硬截断。 */
function clamp(text, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + '…';
}

/**
 * 追加一条（幂等 + 有界）。
 *
 * ★ 幂等判据是 `taskRunId + kind + text`：同一份交付被重复收口时，
 *   黑板里不该出现两条一模一样的「产物」；而两个不同任务写下同一句话
 *   （例如各自都声明"用 addMoney"）则各留一条 —— 那是两次独立的决定。
 *
 * ★ 淘汰顺序：先扔**最旧的非约束**条目，实在全是约束才扔最旧的那条。
 *   约束是"不许做的事"，被时间挤掉等于规矩悄悄失效。
 *
 * @param {object} blackboard 当前黑板（可空/可为脏数据）
 * @param {object} entry { kind, text, ref?, authorBotId?, authorName?, taskRunId?, at? }
 * @param {{now?:number, maxEntries?:number}} [opts]
 * @returns {{blackboard:object, entry:object|null, added:boolean, duplicate:boolean, evicted:Array<object>}}
 */
export function appendEntry(blackboard, entry, { now = Date.now(), maxEntries = BLACKBOARD_LIMITS.maxEntries } = {}) {
  const board = normalizeBlackboard(blackboard);
  const kind = BLACKBOARD_KINDS.includes(entry?.kind) ? entry.kind : 'fact';
  const text = clamp(String(entry?.text ?? '').replace(/\s+/g, ' ').trim(), BLACKBOARD_LIMITS.maxTextChars);
  if (!text) return { blackboard: board, entry: null, added: false, duplicate: false, evicted: [] };
  const taskRunId = entry?.taskRunId ? String(entry.taskRunId) : null;
  const existing = board.entries.find((e) => String(e.text ?? '') === text
    && (e.kind ?? 'fact') === kind
    && (taskRunId ? String(e.taskRunId ?? '') === taskRunId : !e.taskRunId));
  if (existing) return { blackboard: board, entry: existing, added: false, duplicate: true, evicted: [] };

  const at = Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Number(now) || 0;
  const record = {
    id: entry?.id ? String(entry.id) : 'bb_' + fingerprint(kind + '|' + (taskRunId ?? '') + '|' + text),
    kind,
    authorBotId: entry?.authorBotId ? String(entry.authorBotId) : null,
    authorName: clamp(String(entry?.authorName ?? '').trim(), 40),
    taskRunId,
    text,
    ref: clamp(String(entry?.ref ?? '').trim(), BLACKBOARD_LIMITS.maxRefChars),
    at,
  };

  const entries = [...board.entries, record];
  const evicted = [];
  const limit = Math.max(1, Number(maxEntries) || BLACKBOARD_LIMITS.maxEntries);
  while (entries.length > limit) {
    const index = oldestEvictableIndex(entries);
    if (index < 0) break;
    evicted.push(...entries.splice(index, 1));
  }
  return { blackboard: { entries, updatedAt: at }, entry: record, added: true, duplicate: false, evicted };
}

/** 该淘汰哪一条：最旧的非约束；全是约束才动约束本身。 */
function oldestEvictableIndex(entries) {
  let softest = -1;
  let oldest = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const at = Number(entries[i]?.at) || 0;
    if (oldest < 0 || at < (Number(entries[oldest]?.at) || 0)) oldest = i;
    if (entries[i]?.kind === 'constraint') continue;
    if (softest < 0 || at < (Number(entries[softest]?.at) || 0)) softest = i;
  }
  return softest >= 0 ? softest : oldest;
}

/**
 * 渲染成给模型看的短块（总共硬控 ≤ maxChars）。
 *
 * 顺序：**约束优先**（它们是全组的规矩），其余按时间新→旧。
 * 装不下就丢掉尾部（最旧的普通条目），绝不截断约束之后的内容逻辑 ——
 * 因为截断发生在"这一行放不下"的边界上。
 *
 * @param {object|null} blackboard
 * @param {{maxChars?:number}} [opts]
 * @returns {string} 空黑板返回空串
 */
export function renderBlackboard(blackboard, { maxChars = BLACKBOARD_LIMITS.maxRenderChars } = {}) {
  const board = normalizeBlackboard(blackboard);
  if (!board.entries.length) return '';
  const limit = Math.max(1, Number(maxChars) || BLACKBOARD_LIMITS.maxRenderChars);
  const ordered = [
    ...board.entries.filter((e) => e.kind === 'constraint'),
    ...board.entries.filter((e) => e.kind !== 'constraint').slice().reverse(),
  ];
  const lines = ['【共享黑板】'];
  let used = lines[0].length;
  for (const entry of ordered) {
    const who = String(entry.authorName ?? '').trim();
    const ref = String(entry.ref ?? '').trim();
    const line = '· ' + (KIND_LABEL[entry.kind] ?? '事实') + '｜' + (who || '系统') + '：'
      + String(entry.text ?? '') + (ref ? '（' + ref + '）' : '');
    if (used + line.length + 1 > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 一份交付自动落黑板的那条「产物」（摘要 + 关键产物路径，0 次模型调用）。
 *
 * @param {object} taskRun 刚交付的子任务
 * @param {{nameOf?:Function|null, at?:number}} [opts]
 * @returns {object|null} 没有可用信息时返回 null（不写空条目）
 */
export function artifactEntryOf(taskRun, { nameOf = null, at = 0 } = {}) {
  const requirement = String(taskRun?.goal?.requirement ?? '').replace(/\s+/g, ' ').trim();
  const summary = String(taskRun?.delivery?.summary ?? '')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !/^任务「.*」已验收通过。$/.test(line))
    .join(' ');
  const refs = artifactRefs(taskRun);
  const body = [requirement ? requirement.slice(0, 100) : '', summary, refs.length ? '产物：' + refs.join('、') : '']
    .filter(Boolean).join('；');
  if (!body) return null;
  const botId = taskRun?.owner?.leadBotId ?? null;
  return {
    kind: 'artifact',
    taskRunId: taskRun?.id ?? null,
    authorBotId: botId,
    authorName: typeof nameOf === 'function' && botId ? String(nameOf(botId) ?? '') : '',
    text: body,
    ref: refs[0] ?? '',
    at,
  };
}
