/**
 * 独立评审（Critic）的纯判定层：要不要审、审什么、怎么解析、怎么回灌给执行者。
 *
 * ## 为什么需要它
 *
 * 机械验收只能回答「文件在不在、格式对不对、测试过没过」。它答不了
 * 「这份结论对不对、口径一致不一致、有没有把 100 条写成 10 条」——
 * 于是现在的 `VERIFY_KIND.expert` 只能靠负责人自己调 `task_expert_review`：
 * 私聊 solo 模式下**执行者自己审自己**，成员子任务则根本没人审。
 * 质量就这么靠"看起来做完了"过关。
 *
 * 独立 Critic 要解决的就是这件事，但它必须**严丝合缝**地接进来，所以这一层
 * 只做纯计算，把四件容易做错的事固定下来：
 *
 *   · **零浪费**：机械验收没过时绝不调 Critic（确定性错误先让执行者自己修）；
 *   · **可解释的触发条件**：`off / auto / all` 三档，默认 `auto`
 *     （有未评审的 expert 条件，或任务显式要求质检）；
 *   · **fail-closed 解析**：输出含糊、自相矛盾、缺字段一律不判通过；
 *   · **版本绑定**：每次评审绑定 `(revision, 最新已结算 attemptId, 产物指纹)`，
 *     同一份产出不重复审，返工后的新产出也不会被上一轮的 failed 记录挡住。
 *
 * ## 边界
 *
 * 不建会话、不读文件、不发请求、不写账本 —— 全部入参出参。
 * 真正的评审执行在 `task-critic-runner.js`，接线在 `task-supervisor.js`。
 */
import { readBrandEnv } from '../brand.js';
import { isLocalEndpoint, providerOfSlug } from '../runner/model-fallback.js';
import { artifactRefs } from './task-dag.js';

/** 谁来决定跑不跑 Critic。 */
export const CRITIC_MODE = Object.freeze({
  off: 'off',
  auto: 'auto',
  all: 'all',
});

/** `auto` 之外的档位是显式选择，非法值一律回落到默认。 */
export const DEFAULT_CRITIC_MODE = CRITIC_MODE.auto;

/**
 * 同一目标版本内允许的自动返工轮数。
 *
 * 一次评审不通过 → 返工 1 轮；再不过就停下交给人。
 * 有上限是硬要求：评审本身也烧 token，而"改不到评审员满意"这件事
 * 在模型能力不够时是稳定失败 —— 不设上限就是无限烧钱。
 */
export const MAX_CRITIC_REWORKS = 2;

/** 单条缺陷的字数上限（进提示词与 `unmet`，都要有界）。 */
export const MAX_DEFECT_CHARS = 240;

/** 一次评审最多采信几条缺陷（再多执行者也修不过来，反而变成噪音）。 */
export const MAX_DEFECTS = 8;

/** 渲染返工清单的默认字数上限。 */
export const DEFAULT_FEEDBACK_CHARS = 1200;

/** 评审提示词里列出的验收条件上限。 */
const MAX_CONDITIONS = 12;

/** 从环境变量读评审档位：`ORBIS_CRITIC_REVIEW`。 */
export function resolveCriticMode(env = process.env) {
  const raw = String(readBrandEnv(env, 'CRITIC_REVIEW') ?? '').trim().toLowerCase();
  return Object.values(CRITIC_MODE).includes(raw) ? raw : DEFAULT_CRITIC_MODE;
}

/** 评审用的显式模型（可选，`ORBIS_CRITIC_MODEL`）。 */
export function criticModelFromEnv(env = process.env) {
  const raw = String(readBrandEnv(env, 'CRITIC_MODEL') ?? '').trim();
  return raw || null;
}

/** 稳定的短指纹（只用于 targetKey 与条目去重，不做安全用途）。 */
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 最近一次**已结算**的尝试（评审必须绑定到一次真实产出上）。 */
export function latestSettledAttempt(taskRun) {
  const ledger = Array.isArray(taskRun?.attempts) ? taskRun.attempts : [];
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const attempt = ledger[i];
    if (attempt?.state === 'settled') return attempt;
  }
  return null;
}

/** 这次产出的产物路径（限定在最新尝试上，混进历史产物会让指纹乱跳）。 */
export function reviewedArtifacts(taskRun) {
  const attempt = latestSettledAttempt(taskRun);
  const attemptId = attempt?.attemptId ?? null;
  const refs = (taskRun?.progress?.evidence ?? [])
    .filter((item) => {
      const kind = String(item?.kind ?? '');
      if (kind === 'claim') return false;
      if (!attemptId) return true;
      return !item?.attemptId || String(item.attemptId) === String(attemptId);
    })
    .map((item) => String(item?.ref ?? '').trim())
    .filter(Boolean);
  return [...new Set(refs)].sort().slice(0, 40);
}

/**
 * 评审目标指纹：`revision + 最新已结算 attemptId + 产物集合`。
 *
 * 三件都要，缺一件就出两类经典事故：
 *   · 只看 revision → 同一版里返工后的新产出被当成"已经审过了"直接放行；
 *   · 只看 attemptId → 产物补登记（同一 attempt 多出文件）不会被重审；
 *   · 不看产物 → 执行者改完文件但没重跑，指纹不变，评审结论还挂在旧产出上。
 */
export function criticTargetKeyOf(taskRun) {
  const revision = Number(taskRun?.revision) || 0;
  const attemptId = latestSettledAttempt(taskRun)?.attemptId ?? '';
  const artifacts = reviewedArtifacts(taskRun);
  return `r${revision}|a${attemptId}|x${fingerprint(artifacts.join('\n'))}`;
}

/** 需要专业判断（未评审）的 expert 条件。 */
export function pendingExpertConditions(verification) {
  return (verification?.needsReview ?? []).filter((item) => item?.id);
}

/**
 * 现在要不要跑 Critic（纯判定）。
 *
 * 判定顺序就是优先级：
 *   1. `off` → 永不跑；
 *   2. 机械没过（unmet / blocked 非空）→ 永不跑（先让执行者修确定性错误）；
 *   3. 同一份产出已经审过并通过 → 不重复审；
 *   4. 按档位：`all` 一律审；`auto` 只在「有未评审的 expert 条件」或
 *      「任务显式 criticRequired」时审。
 *
 * @param {object} p
 * @param {object} p.taskRun
 * @param {object} p.verification 机械验收结果
 * @param {string} [p.mode]
 * @returns {boolean}
 */
export function shouldRunCritic({ taskRun, verification, mode = DEFAULT_CRITIC_MODE } = {}) {
  const resolved = Object.values(CRITIC_MODE).includes(mode) ? mode : DEFAULT_CRITIC_MODE;
  if (resolved === CRITIC_MODE.off) return false;
  const blocked = (verification?.blocked ?? []).length;
  const unmet = (verification?.unmet ?? []).length;
  if (blocked > 0 || unmet > 0) return false;
  // 同一份产出审过并通过：换轮次没意义，白烧一次模型
  const state = taskRun?.criticState ?? {};
  const targetKey = criticTargetKeyOf(taskRun);
  if (state.lastPassedKey && state.lastPassedKey === targetKey) return false;
  const needsReview = pendingExpertConditions(verification).length > 0;
  const required = taskRun?.flags?.criticRequired === true;
  if (resolved === CRITIC_MODE.all) return true;
  return needsReview || required;
}

/** 按字数硬截断（超了补省略号，绝不撑爆上下文）。 */
function clamp(text, maxChars) {
  const limit = Math.max(0, Number(maxChars) || 0);
  const value = String(text ?? '');
  if (!limit) return '';
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + '…';
}

/**
 * 评审提示词：让评审员能**自己去看**，而不是只凭一句交付说明下判断。
 *
 * 只给三类信息：任务目标与验收条件、本次交付的产物路径、全组黑板（约束/决定）。
 * 刻意**不给**执行者的对话历史 —— 那会把执行者的自我解释当成事实，
 * 评审就退化成"复述执行者的话"。
 *
 * @param {object} p
 * @param {object} p.taskRun
 * @param {object} [p.verification]
 * @param {object|null} [p.blackboard]
 * @param {number} [p.maxChars]
 * @returns {string}
 */
export function buildCriticPrompt({
  taskRun, verification = null, blackboard = null, maxChars = 6000,
} = {}) {
  const goal = taskRun?.goal ?? {};
  const lines = [
    '你是这次交付的**独立评审员**。你没有参与执行，也不要相信执行者的自述：',
    '下面给出任务目标、验收条件与本次交付的产物路径，请用只读工具（read/ls/find/grep）',
    '亲自打开这些产物核对，再给出结论。',
    '',
    '## 任务目标',
    String(goal.requirement ?? '').slice(0, 600) || '(未提供)',
    goal.scope ? `范围：${String(goal.scope).slice(0, 300)}` : '',
    (goal.deliverables ?? []).length
      ? '要求的交付物：' + (goal.deliverables ?? []).map((x) => String(x)).slice(0, 8).join('、')
      : '',
  ].filter(Boolean);

  const conditions = (goal.verification ?? []).slice(0, MAX_CONDITIONS);
  if (conditions.length) {
    lines.push('', '## 验收条件');
    for (const condition of conditions) {
      lines.push(`- [${condition.id}] (${condition.kind}) ${String(condition.description ?? '').slice(0, 200)}`);
    }
  }

  const artifacts = reviewedArtifacts(taskRun);
  lines.push('', '## 本次交付的产物路径');
  if (artifacts.length) {
    for (const ref of artifacts.slice(0, 10)) lines.push('- ' + ref);
  } else {
    lines.push('(这次没有登记任何产物路径：请按验收条件判断是否需要交付物，缺产物本身就是缺陷)');
  }

  const boardText = clamp(renderBoardLines(blackboard), 800);
  if (boardText) lines.push('', '## 全组共享的约束与决定（违反其中任何一条都算缺陷）', boardText);

  // 机械验收的通过项也告诉它：省得把力气花在已经验过的事情上
  const passedConditions = (verification?.verdicts ?? [])
    .filter((v) => v?.verdict === 'passed')
    .map((v) => String(v.id ?? ''));
  if (passedConditions.length) {
    lines.push('', `（机械验收已通过的条件：${passedConditions.join('、')}；这些不必重复核对，但产物内容本身仍要读）`);
  }

  lines.push(
    '',
    '## 输出要求（必须严格遵守）',
    '只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块以外的内容：',
    '{"verdict":"passed"|"failed","summary":"一句话结论","defects":["具体缺陷（含文件路径与位置）"]}',
    '规则：',
    '- 判 passed 时 defects 必须是空数组，summary 要说明你**核对过什么**；',
    '- 判 failed 时至少给 1 条缺陷，每条都要能让执行者直接照着改（哪个文件、哪一处、错在哪）；',
    '- 不要因为"风格偏好"判 failed；只判目标与验收条件、以及黑板上的约束。',
  );
  return clamp(lines.join('\n'), maxChars);
}

/** 黑板 → 纯文本（只取约束/决定/事实，产物条已经单独列过了）。 */
function renderBoardLines(blackboard) {
  const entries = Array.isArray(blackboard?.entries) ? blackboard.entries : [];
  const useful = entries.filter((e) => e?.kind !== 'artifact' && String(e?.text ?? '').trim());
  if (!useful.length) return '';
  return useful
    .slice(-12)
    .map((e) => '· [' + String(e.kind ?? 'fact') + '] ' + String(e.text ?? '').slice(0, 200))
    .join('\n');
}

/** 从一段文本里抠出第一个完整 JSON 对象（容忍 markdown 代码块与前后废话）。 */
/**
 * 扫描所有**括号平衡**的 `{...}` 片段。
 *
 * 为什么不能只取第一个：评审员在给出结论前经常先提一句「字段是 {"verdict": ...}」
 * 或把工具入参 `{"path": "out/a.md"}` 写进正文。只取第一个就会拿一个
 * 与结论无关的对象去解析，结果是误判 / 误报 parse_error。
 */
function balancedObjects(text) {
  const out = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) { cursor = start + 1; continue; }
    out.push(text.slice(start, end + 1));
    cursor = end + 1;
  }
  return out;
}

/** 从一段文本里找出候选 JSON 对象（fenced 代码块内优先）。 */
function extractJsonObject(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inside = balancedObjects(fenced[1]);
    if (inside.length) return inside;
  }
  return balancedObjects(raw);
}

/** 缺陷归一化：去空白、去重、逐条截断、限量。 */
function normalizeDefects(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = clamp(text, MAX_DEFECT_CHARS);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_DEFECTS) break;
  }
  return out;
}

/**
 * 严格 fail-closed 的结论解析。
 *
 * 判据（任一条不满足就是 `parse_error`，**绝不放行**）：
 *   · 能抠出一个 JSON 对象；
 *   · `verdict` 只能是 `passed` / `failed`；
 *   · `passed`：`summary` 非空，且 `defects` 为空（既通过又列缺陷 = 自相矛盾）；
 *   · `failed`：至少 1 条可执行缺陷。
 *
 * @param {string} rawText 评审员的原始输出
 * @returns {{ok:boolean, verdict:string, summary:string, defects:string[], reason?:string}}
 */
export function parseCriticVerdict(rawText) {
  const raw = String(rawText ?? '').trim();
  if (!raw) return { ok: false, verdict: 'parse_error', summary: '', defects: [], reason: '评审员没有输出任何内容' };
  const candidates = extractJsonObject(raw);
  if (!candidates.length) {
    return { ok: false, verdict: 'parse_error', summary: '', defects: [], reason: '输出里找不到 JSON 结论' };
  }
  // ★ 优先取**最后一个带 `verdict` 键**的合法对象：结论总是在理由之后。
  //   全部没 `verdict` 时退回最后一个能解析的对象（由后续校验判矛盾）。
  let parsed = null;
  let lastAny = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      lastAny = value;
      if ('verdict' in value) parsed = value;
    } catch {
      // 不是合法 JSON 的候选直接跳过（正文里常见的 `{字段}` 就是这种）
    }
  }
  if (!parsed) parsed = lastAny;
  if (!parsed) {
    return { ok: false, verdict: 'parse_error', summary: '', defects: [], reason: '输出里的 JSON 都解析不了' };
  }
  const verdict = String(parsed.verdict ?? '').trim().toLowerCase();
  const summary = clamp(String(parsed.summary ?? '').replace(/\s+/g, ' ').trim(), 400);
  const defects = normalizeDefects(parsed.defects);
  if (verdict !== 'passed' && verdict !== 'failed') {
    return {
      ok: false, verdict: 'parse_error', summary, defects,
      reason: `verdict 必须是 passed 或 failed，收到 ${JSON.stringify(parsed.verdict)}`,
    };
  }
  if (verdict === 'passed') {
    if (!summary) {
      return { ok: false, verdict: 'parse_error', summary, defects, reason: '判通过却没写结论依据' };
    }
    if (defects.length) {
      return {
        ok: false, verdict: 'parse_error', summary, defects,
        reason: '结论自相矛盾：判通过却列了缺陷',
      };
    }
    return { ok: true, verdict: 'passed', summary, defects: [] };
  }
  if (!defects.length) {
    return {
      ok: false, verdict: 'parse_error', summary, defects,
      reason: '判不通过却没给出可执行的缺陷描述',
    };
  }
  return { ok: true, verdict: 'failed', summary, defects };
}

/**
 * 返工清单渲染（注入执行者下一轮的提示词）。
 *
 * 只说三件事：这是第几轮、上一轮评审的结论、逐条缺陷。
 * 执行者拿到的必须是**可以直接照着改**的清单，否则下一轮还是重做一遍。
 *
 * @param {object|null} feedback
 * @param {{maxChars?:number}} [opts]
 * @returns {string} 没有返工信息时返回空串
 */
export function renderCriticFeedback(feedback, { maxChars = DEFAULT_FEEDBACK_CHARS } = {}) {
  const defects = normalizeDefects(feedback?.defects);
  if (!defects.length) return '';
  const round = Number(feedback?.round) || 1;
  const maxRounds = Number(feedback?.maxRounds) || MAX_CRITIC_REWORKS;
  const model = String(feedback?.reviewerModel ?? '').trim();
  const summary = String(feedback?.summary ?? '').trim();
  const lines = [
    `【独立复核未通过】第 ${round}/${maxRounds} 轮${model ? '（评审：' + model + '）' : ''}`,
    summary ? '评审结论：' + summary : '',
    '请逐条修掉下面这些问题，修完再申请验收（不要重做无关部分）：',
    ...defects.map((d, i) => `${i + 1}. ${d}`),
  ].filter(Boolean);
  return clamp(lines.join('\n'), maxChars);
}

/**
 * 一个候选是不是本地 / 内网端点。
 *
 * 优先用调用方预先算好的 `local`：真实数据里一个模型组**可能有多个端点**，
 * 而 `isLocalEndpoint` 只看单个 `baseUrl` —— 只看第一个会把
 * 「主端点公有云、备用端点局域网」判错，那就成了数据外泄。
 */
function isLocalCandidate(candidate) {
  if (typeof candidate?.local === 'boolean') return candidate.local;
  return isLocalEndpoint(candidate ?? {});
}

/** 候选/执行者的服务商（小写；没有 provider 字段时取 slug 前缀）。 */
function providerKeyOf(model) {
  return (String(model?.provider ?? '').trim() || providerOfSlug(String(model?.slug ?? model?.model ?? '')))
    .toLowerCase();
}

/**
 * 选一个评审模型（纯策略）。
 *
 * 优先级：显式配置 → 与执行者**不同**的健康模型 → 同模型干净会话。
 * 五条边界不能破：
 *   1. 执行者用的是本地/内网模型时，**绝不**把内容发到公有云；显式指定的
 *      `ORBIS_CRITIC_MODEL` 也不例外（环境变量写错就是数据外泄）；
 *   2. 熔断打开的候选不选（免得一上来就失败）；
 *   3. 没有别的可用模型时退回同模型 —— 但仍是**全新内存会话**，
 *      独立性靠「干净上下文 + 只读工具」保证，不靠模型不同；
 *   4. **遵守 `ORBIS_MODEL_FALLBACK`**（隐私/费用边界，与自动兜底同一份口径）：
 *      `same-provider` 只在执行者同一家服务商里换（显式指定的也一样，跨家就拒绝并说明）；
 *      `off` 不自动换模型（显式指定的照用 —— 那是用户的明确选择）；
 *   5. **成员模型被锁定（`bot.lockModel === true`）**：只用同款模型在干净会话里审，
 *      显式指定的评审模型也不用 —— 锁定的意思就是「这个成员的内容只走这一个模型」。
 *   评审员会用 read/grep 读产物原文：「换一家模型审」就是把这些内容发给另一家，
 *   不能绕过用户为自动兜底设的同一条边界。
 *
 * @param {object} p
 * @param {object} [p.executorModel] `{ slug, provider, model, baseUrl, local, groupId }`
 * @param {Array<object>} [p.candidates]
 *   `[{ slug, label, groupId, provider, baseUrl, endpoints, local, enabled }]`
 * @param {string|null} [p.explicitModel]
 * @param {boolean|null} [p.explicitLocal] 显式模型是否本地（调用方已解析过）
 * @param {boolean} [p.explicitResolvable] 显式模型能被 `resolveModel` 解析（不在候选里也算数）
 * @param {string|null} [p.explicitProvider] 显式模型的服务商（调用方用 `resolveModel` 解析过）
 * @param {Function} [p.isBreakerOpen]
 * @param {string} [p.policyMode] `ORBIS_MODEL_FALLBACK` 的值（调用方读环境变量传入；默认 `cloud`）
 * @param {boolean} [p.userLocked] 执行者 `bot.lockModel === true`
 * @returns {{slug:string|null, label:string, why:string, sameAsExecutor:boolean, isolated:boolean, rejected?:string}}
 */
export function selectCriticModel({
  executorModel = null,
  candidates = [],
  explicitModel = null,
  explicitLocal = null,
  explicitResolvable = false,
  explicitProvider = null,
  isBreakerOpen = null,
  policyMode = 'cloud',
  userLocked = false,
} = {}) {
  const executorSlug = String(executorModel?.slug ?? '').trim();
  // ★ provider / model 必须一起喂给 `isLocalEndpoint`：`ollama/qwen3`、`lmstudio/...`
  //   这类内置本地 slug 只有在带 provider 或 model 名时才认得出来，
  //   否则会被当成公有云 —— 于是「本地执行者」可以被换到云端评审。
  const executorProbe = {
    ...(executorModel ?? {}),
    provider: String(executorModel?.provider ?? '').trim() || providerOfSlug(executorSlug),
    model: String(executorModel?.model ?? '').trim() || executorSlug,
    id: String(executorModel?.id ?? '').trim() || executorSlug,
  };
  const executorLocal = typeof executorModel?.local === 'boolean'
    ? executorModel.local
    : isLocalEndpoint(executorProbe);
  const open = typeof isBreakerOpen === 'function' ? isBreakerOpen : () => false;
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.slug && c.enabled !== false);
  const mode = String(policyMode ?? 'cloud').trim().toLowerCase();
  const executorProvider = providerKeyOf(executorProbe);
  // same-provider：只认执行者同一家（执行者的服务商都认不出来时，一个也不认 —— 宁可同款）
  const inProviderBoundary = (provider) => mode !== 'same-provider'
    || (Boolean(executorProvider) && provider === executorProvider);
  const sameModel = (why, rejectedWhy = '') => ({
    slug: null,
    label: executorSlug || '(执行者同款)',
    why: [rejectedWhy, why].filter(Boolean).join('；'),
    sameAsExecutor: true,
    isolated: executorLocal,
    ...(rejectedWhy ? { rejected: rejectedWhy } : {}),
  });

  // ★ 成员模型被锁定：显式指定的评审模型也不用（锁定 = 这个成员的内容只走这一个模型）
  if (userLocked === true) {
    return sameModel(
      '成员模型已锁定：用执行者同款在干净会话里审',
      explicitModel && explicitModel !== executorSlug ? '成员模型已锁定，不采用 ORBIS_CRITIC_MODEL' : '',
    );
  }

  let rejected = '';
  if (explicitModel) {
    const hit = list.find((c) => c.slug === explicitModel)
      ?? (executorSlug === explicitModel ? { ...executorProbe, label: explicitModel } : null);
    const explicitIsLocal = typeof explicitLocal === 'boolean'
      ? explicitLocal
      : (hit ? isLocalCandidate(hit) : isLocalEndpoint({
        model: explicitModel,
        id: explicitModel,
        provider: providerOfSlug(explicitModel),
      }));
    const explicitProviderKey = String(explicitProvider ?? '').trim().toLowerCase()
      || (hit ? providerKeyOf(hit) : providerOfSlug(explicitModel).toLowerCase());
    if (executorLocal && !explicitIsLocal) {
      // ★ 不回退成「静默忽略环境变量」，要说清为什么不用它
      rejected = '显式指定的评审模型在云端，而执行者是本地模型：拒绝外泄';
    } else if (explicitModel !== executorSlug && !inProviderBoundary(explicitProviderKey)) {
      rejected = '显式指定的评审模型与执行者不是同一家服务商（ORBIS_MODEL_FALLBACK=same-provider）：拒绝使用';
    } else if (hit || explicitResolvable || executorSlug === explicitModel) {
      return {
        slug: explicitModel,
        label: String(hit?.label ?? explicitModel),
        why: '按 ORBIS_CRITIC_MODEL 指定',
        sameAsExecutor: explicitModel === executorSlug,
        isolated: executorLocal,
      };
    } else {
      rejected = '显式指定的评审模型不在已启用的模型组里，且无法解析';
    }
  }

  // ★ ORBIS_MODEL_FALLBACK=off：不自动换模型（显式指定的上面已经处理过）
  if (mode === 'off') {
    return sameModel('ORBIS_MODEL_FALLBACK=off：不自动换模型，用执行者同款在干净会话里审', rejected);
  }

  const allowed = list.filter((c) => {
    if (c.slug === executorSlug) return false;              // 先找不同模型
    if (open(c.slug, c.groupId ?? '')) return false;         // 熔断打开不选
    if (executorLocal && !isLocalCandidate(c)) return false; // 本地模型绝不外泄到公有云
    if (!inProviderBoundary(providerKeyOf(c))) return false; // same-provider：不出这一家
    return true;
  });
  // 跨组优先：不同 groupId 能避开「同一家挂了全挂」
  const crossGroup = allowed.filter((c) => String(c.groupId ?? '') !== String(executorModel?.groupId ?? ''));
  const pool = crossGroup.length ? crossGroup : allowed;
  if (pool.length) {
    const pick = pool.find((c) => c.enabled !== false) ?? pool[0];
    return {
      slug: pick.slug,
      label: String(pick.label ?? pick.slug),
      why: [rejected, crossGroup.length ? '换一个其它模型组里健康的已启用模型' : '换一个健康的已启用模型']
        .filter(Boolean).join('；'),
      sameAsExecutor: false,
      isolated: executorLocal,
      ...(rejected ? { rejected } : {}),
    };
  }

  return sameModel('没有其它可用模型，用执行者同款在干净会话里审', rejected);
}

/** 产物清单（给提示词与黑板用，去重限量）。 */
export function criticDeliverables(taskRun, limit = 10) {
  return artifactRefs(taskRun, limit);
}
