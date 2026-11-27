/**
 * 受控子任务 DAG：依赖规范化 / 环检测 / 依赖状态 / 上游上下文压缩（纯函数）。
 *
 * ## 为什么要有这一层
 *
 * 2.0 的集群是**受控**的（负责人统一掌控，成员之间不去中心化协商）。
 * 那么「谁该先做、谁在等谁、上游死了谁买单」就必须由系统算出**确定答案** ——
 * 如果交给负责人每轮用模型重想一遍，既慢又不一致，还会出现同一个
 * 依赖在两轮里得到两种结论。
 *
 * 所以这里只回答五个问题：
 *   · `normalizeDependsOn`：模型给的依赖洗成「同父、真实存在」的 id 列表；
 *   · `detectDependencyCycle`：落盘前 fail-closed 拒绝自环与任意长度的环；
 *   · `dependencyStatus`：某子任务此刻只能是 ready / waiting / checkpoint / upstream_failed；
 *   · `collectUpstreamContext`：把已完成前置的交付压成短块，下游直接开干；
 *   · `planStepBindings` / `matchPlanStep` / `planLinksOf`：`task_plan` 里写的依赖与把关位
 *     落到真实子任务上 —— 计划只写在纸上、派活时不生效，下游就会照样抢跑。
 *
 * ## 边界
 *
 * 不读账本、不写记录、不唤醒任何人 —— 全部入参出参。
 * 落盘在 `task-subtasks.js`，唤醒在 `task-supervisor.js`，渲染在 `task-prompts.js`。
 * 这样调度判定能单测，也不会和归约器互相打架。
 */
import { STATE, isTerminal } from './task-contract.js';

/**
 * 依赖状态：只有这四种，没有「大概能跑」。
 *
 *   · ready           现在就能跑（无前置，或前置都已验收完成，且没有待放行的关卡）；
 *   · waiting         至少一个前置还在推进（非终态、也还没永久受阻）；
 *   · checkpoint      前置都完成了，但设了「先由负责人把关」，还没放行；
 *   · upstream_failed 至少一个前置已经永久受阻 / 被取消 —— 下游绝不启动。
 */
export const DEP_STATUS = Object.freeze({
  ready: 'ready',
  waiting: 'waiting',
  checkpoint: 'checkpoint',
  upstream_failed: 'upstream_failed',
});

/** 上游上下文默认预算（字符）。够装两三条交付摘要，又不会把上下文撑爆。 */
export const DEFAULT_UPSTREAM_CHARS = 1200;

/** 一组 id 的字符串集合视图（去重 + 去空）。 */
function idSet(list) {
  const out = new Set();
  for (const raw of list ?? []) {
    const id = String(raw ?? '').trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * 计划步骤号 → 真实子任务 id。
 *
 * 负责人写计划时手里只有「第 1 条、第 2 条」，让他去记 `tr_x_c1_ab12cd34`
 * 这种子任务 id 不现实。所以允许依赖写成步骤序号，这里统一翻成 id。
 *
 * 接受两种形态：`Map<步骤号, id>`，或「按序号排的数组」（1 基）。
 */
function stepResolver(stepIds) {
  if (!stepIds) return null;
  const map = new Map();
  if (stepIds instanceof Map) {
    for (const [key, value] of stepIds) {
      if (key === null || key === undefined || !value) continue;
      map.set(String(key).trim(), String(value));
    }
    return map;
  }
  if (Array.isArray(stepIds)) {
    stepIds.forEach((value, index) => {
      if (value) map.set(String(index + 1), String(value));
    });
    return map;
  }
  return null;
}

/**
 * 规范化依赖列表：去重、解析步骤号、只留「同父且真实存在」的。
 *
 * @param {unknown} dependsOn 模型给的原始依赖（单个/数组/含空值都容忍）
 * @param {Iterable<string>} knownIds 同一父任务、同一目标版本下真实存在的子任务 id
 * @param {{stepIds?: Iterable|Map, selfId?: string|null}} [opts]
 * @returns {{ids:string[], rejected:Array<{raw:unknown, reason:string}>}}
 *   `rejected` 里的每一条都是**必须拒绝落盘**的理由（unknown / self），
 *   调用方不能只取 `ids` 然后默默吞掉 —— 那等于把依赖悄悄降级成"没依赖"。
 */
export function normalizeDependsOn(dependsOn, knownIds, { stepIds = null, selfId = null } = {}) {
  const known = idSet(knownIds);
  const steps = stepResolver(stepIds);
  const self = selfId ? String(selfId) : null;
  const list = Array.isArray(dependsOn)
    ? dependsOn
    : (dependsOn === null || dependsOn === undefined ? [] : [dependsOn]);
  const ids = [];
  const seen = new Set();
  const rejected = [];
  for (const raw of list) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const resolved = steps?.has(text) ? steps.get(text) : text;
    if (self && resolved === self) {
      rejected.push({ raw, reason: 'self' });
      continue;
    }
    if (!known.has(resolved)) {
      rejected.push({ raw, reason: 'unknown' });
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    ids.push(resolved);
  }
  return { ids, rejected };
}

/**
 * DFS 环检测（自环 / 二元环 / 任意长度环全部拦下）。
 *
 * 三色标记：白=没访问过，灰=在当前递归栈上，黑=已确认无环。
 * 走到灰点就是一条真实的环，直接把栈上的那段路径回吐出来 ——
 * 报错要能说清「是哪几条互相等」，否则负责人只能瞎猜。
 *
 * @param {Array<{id:string, dependsOn?:Array<string>}>} nodes 同一父任务下的子任务
 * @returns {{ok:true, cycle:null}|{ok:false, cycle:string[]}}
 */
export function detectDependencyCycle(nodes) {
  const graph = new Map();
  for (const node of nodes ?? []) {
    const id = String(node?.id ?? '').trim();
    if (!id) continue;
    graph.set(id, idSet(node.dependsOn));
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...graph.keys()].map((id) => [id, WHITE]));
  const stack = [];

  const visit = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      // 图外的依赖不归这里管：`normalizeDependsOn` 已经拒过，重复报错只会淹没真因
      if (!graph.has(dep)) continue;
      if (color.get(dep) === GRAY) {
        const from = stack.indexOf(dep);
        return [...stack.slice(from < 0 ? 0 : from), dep];
      }
      if (color.get(dep) === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of graph.keys()) {
    if (color.get(id) !== WHITE) continue;
    const cycle = visit(id);
    if (cycle) return { ok: false, cycle };
  }
  return { ok: true, cycle: null };
}

/** 永久受阻：不会再自己动起来的那种（可恢复阻塞 / 排队中都不算）。 */
export function isPermanentlyFailed(run) {
  if (!run) return false;
  if (run.state === STATE.cancelled) return true;
  return run.state === STATE.blocked && !run.recoverableBlock;
}

/** 这道关卡还没放行吗：设了 checkpointBeforeRun 且负责人还没点头。 */
export function needsCheckpoint(kid) {
  return kid?.checkpointBeforeRun === true && !kid?.checkpointApprovedAt;
}

/** 同父子任务按 id 索引（重复 id 后者覆盖，存储里不会出现，防手写脏数据）。 */
function siblingIndex(siblings) {
  const map = new Map();
  for (const sib of siblings ?? []) {
    if (sib?.id) map.set(String(sib.id), sib);
  }
  return map;
}

/**
 * 这个子任务此刻的依赖状态（四选一，见 `DEP_STATUS`）。
 *
 * ★ 判定顺序很重要：**上游永久失败优先于一切**。
 *   哪怕另一个前置还在跑，只要有一个前置已经死了，下游就不该启动 ——
 *   否则下游会拿半份前置产物开干，产出没人能验的东西。
 *
 * @param {object} kid
 * @param {Array<object>} siblings 同父同版本的全部子任务（含已完成的）
 * @returns {string} DEP_STATUS 之一
 */
export function dependencyStatus(kid, siblings) {
  const byId = siblingIndex(siblings);
  let waiting = false;
  for (const depId of idSet(kid?.dependsOn)) {
    const dep = byId.get(depId);
    // 依赖不在同父同版本里 = 数据坏了。宁可当作上游失败暴露出来，也不能放它跑。
    if (!dep) return DEP_STATUS.upstream_failed;
    if (dep.state === STATE.completed) continue;
    if (isPermanentlyFailed(dep)) return DEP_STATUS.upstream_failed;
    waiting = true;
  }
  if (waiting) return DEP_STATUS.waiting;
  // 前置都完成了（或本来就没有前置）：再看这道闸要不要负责人先点头
  if (needsCheckpoint(kid)) return DEP_STATUS.checkpoint;
  return DEP_STATUS.ready;
}

/** 已永久失败的前置子任务 id（用于把「谁拖垮了它」说清楚）。 */
export function upstreamFailedIds(kid, siblings) {
  const byId = siblingIndex(siblings);
  const out = [];
  for (const depId of idSet(kid?.dependsOn)) {
    const dep = byId.get(depId);
    if (!dep || isPermanentlyFailed(dep)) out.push(depId);
  }
  return out;
}

/** 还在等放行的子任务（负责人的待办清单，也是「不能干等」的判据）。 */
export function pendingCheckpointKids(siblings) {
  const list = Array.isArray(siblings) ? siblings : [];
  return list.filter((kid) => !isTerminal(kid?.state) && dependencyStatus(kid, list) === DEP_STATUS.checkpoint);
}

/**
 * 所有未结束的子任务是不是「都只在等负责人放行」。
 *
 * ## 为什么不能只比数量
 *
 * 三级流水线 A → B（checkpoint）→ C[dependOn B] 里，A 完成后
 * 未终态子任务是 [B, C]：B 在等放行、C 在等 B。
 * 旧判据 `pendingCheckpointKids().length === liveKids.length` 是 1 === 2，
 * 永远不成立 → 父任务落进 `return wait`，负责人永远不会被叫醒，
 * B 与它的下游 C 一起永久死锁。
 *
 * ## 判据（必须同时成立）
 *
 *   · 至少有一个子任务在等放行（否则没什么可审的）；
 *   · 每一个活子任务都处在 checkpoint 或 waiting（下游等上游算 waiting）；
 *   · 没有任何「现在就能跑 / 正在跑 / 正在验收 / 可恢复阻塞」的——
 *     那种情况该继续推进，不该拿审批去打扰负责人。
 *
 * 换句话说：**全队的共同阻塞点就是那句放行**。
 *
 * @param {Array<object>} siblings 同父同版本的全部子任务（含已完成的）
 * @returns {boolean}
 */
export function isWaitingOnlyOnCheckpoints(siblings) {
  const list = Array.isArray(siblings) ? siblings : [];
  const live = list.filter((kid) => !isTerminal(kid?.state));
  if (!live.length) return false;
  const pending = live.filter((kid) => dependencyStatus(kid, list) === DEP_STATUS.checkpoint);
  if (!pending.length) return false;
  return live.every((kid) => {
    const status = dependencyStatus(kid, list);
    return status === DEP_STATUS.checkpoint || status === DEP_STATUS.waiting;
  });
}

/**
 * 因某个刚完成的子任务而变得可跑的下游（自动接力的候选集）。
 *
 * 只算「依赖里含它」且此刻 `ready` 的：还在等别的兄弟、或等着负责人放行的，
 * 都不在此列 —— 它们各有各的唤醒来源。
 */
export function readyDownstreamOf(finishedId, siblings) {
  const id = String(finishedId ?? '').trim();
  if (!id) return [];
  const list = Array.isArray(siblings) ? siblings : [];
  return list.filter((sib) => {
    if (!sib?.id || sib.id === id || isTerminal(sib.state)) return false;
    if (!idSet(sib.dependsOn).has(id)) return false;
    return dependencyStatus(sib, list) === DEP_STATUS.ready;
  });
}

/** 这条任务的产物路径（去重、限量）。 */
export function artifactRefs(taskRun, limit = 4) {
  const out = [];
  for (const item of taskRun?.progress?.evidence ?? []) {
    const ref = String(item?.ref ?? '').trim();
    if (!ref || out.includes(ref)) continue;
    out.push(ref);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

/** 按字数硬截断（超了补一个省略号，绝不因为超长把下游提示词顶爆）。 */
function clamp(text, maxChars) {
  const limit = Math.max(0, Number(maxChars) || 0);
  const value = String(text ?? '');
  if (!limit) return '';
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)) + '…';
}

/** 单条前置交付的描述行。 */
function describeDelivered(dep, nameOf, maxLineChars) {
  const title = String(dep?.goal?.requirement ?? dep?.id ?? '').replace(/\s+/g, ' ').trim();
  const who = typeof nameOf === 'function' ? String(nameOf(dep?.owner?.leadBotId) ?? '').trim() : '';
  const summary = String(dep?.delivery?.summary ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // 「任务「…」已验收通过。」只是回声，占字数不带信息
    .filter((line) => !/^任务「.*」已验收通过。$/.test(line))
    .join(' ');
  const artifacts = artifactRefs(dep);
  const body = [summary, artifacts.length ? '产物：' + artifacts.join('、') : ''].filter(Boolean).join('；');
  return clamp(`- ${title}${who ? '（' + who + '）' : ''}${body ? '：' + body : ''}`, maxLineChars);
}

/**
 * 把「已完成的前置」压成结构化的短块，供下游成员直接开干。
 *
 * 只收 `state === completed` 的前置：还在跑的、被取消的都不该出现在这里
 * （它们要么没产物，要么产物不可信）。没有可用的前置时返回空串，
 * 调用方据此决定要不要往提示词里加这一段。
 *
 * @param {object} kid
 * @param {Array<object>} siblings
 * @param {{maxChars?:number, nameOf?:Function|null, maxLineChars?:number}} [opts]
 * @returns {string}
 */
export function collectUpstreamContext(kid, siblings, {
  maxChars = DEFAULT_UPSTREAM_CHARS,
  nameOf = null,
  maxLineChars = 200,
} = {}) {
  const byId = siblingIndex(siblings);
  const lines = [];
  for (const depId of idSet(kid?.dependsOn)) {
    const dep = byId.get(depId);
    if (!dep || dep.state !== STATE.completed) continue;
    lines.push(describeDelivered(dep, nameOf, maxLineChars));
  }
  if (!lines.length) return '';
  const header = '前置子任务已经交付（直接用它们的产物，不要重做）：';
  return clamp(`${header}\n${lines.join('\n')}`, maxChars);
}

// ---------------------------------------------------------------- 计划条目 ↔ 子任务

/**
 * 计划条目的身份：正文（去首尾空白）。
 *
 * 不拿序号当身份：负责人修订计划（`task_plan` 覆盖）时序号会挪，正文才是「这一条活」。
 */
export function planStepText(step) {
  return String(step?.task ?? '').trim();
}

/** 计划条目上的依赖/把关说明（负责人与用户都靠这半句判断「它为什么还没开始」）。 */
export function planStepNote(step, index) {
  const self = Number(index) + 1;
  const deps = (Array.isArray(step?.dependsOn) ? step.dependsOn : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== self);
  return [
    deps.length ? '等第 ' + deps.join('、') + ' 条完成' : '',
    step?.checkpoint === true ? '前置完成后先叫你把关' : '',
  ].filter(Boolean).join('；');
}

/** 被取消 / 永久受阻的子任务不再占着它那条计划（那一条要重新派，下游也不该等一个死掉的活）。 */
function holdsPlanStep(kid) {
  return Boolean(kid?.id) && !isPermanentlyFailed(kid);
}

/** 子任务上记的计划绑定（派活时认定的那一条）。 */
function boundStepOf(kid) {
  const raw = kid?.planStep;
  if (!raw || typeof raw !== 'object') return null;
  const task = String(raw.task ?? '').trim();
  if (!task) return null;
  const index = Number(raw.index);
  return { index: Number.isInteger(index) ? index : null, task };
}

const newestFirst = (a, b) => Number(b?.createdAt ?? 0) - Number(a?.createdAt ?? 0);
const oldestFirst = (a, b) => Number(a?.createdAt ?? 0) - Number(b?.createdAt ?? 0);

/**
 * 计划步骤号（1 基）→ 此刻占着这一条的子任务。
 *
 * 认领顺序（每个子任务只认一条，每条只认一个子任务）：
 *   1) 派活时记下的绑定：同序号 + 同正文；
 *   2) 绑定正文相同（计划被修订、序号挪了）；
 *   3) 子任务目标正文 == 步骤正文（负责人原样照抄 / 旧数据）；
 *   4) 还没绑定的子任务，按派出先后对上**同一成员**还空着的条目 ——
 *      @ 派活的正文是摘录、对不上原文；「先派活、后补计划」也靠这一条认回来。
 *
 * ★ 被取消 / 永久受阻的子任务不占条目：那一条得重新派；
 *   要是还让它占着，下游会去等一个永远不会交付的活。
 *
 * @param {Array<object>} steps 计划条目（`plan.steps`）
 * @param {Array<object>} kids 同父同版本的子任务
 * @returns {Map<number, object>} 步骤号 → 子任务
 */
export function planStepBindings(steps, kids) {
  const list = Array.isArray(steps) ? steps : [];
  const live = (Array.isArray(kids) ? kids : []).filter(holdsPlanStep);
  const out = new Map();
  const used = new Set();
  const claim = (index, candidates) => {
    if (out.has(index)) return;
    const hit = candidates.find((kid) => !used.has(kid.id));
    if (!hit) return;
    out.set(index, hit);
    used.add(hit.id);
  };
  const newest = [...live].sort(newestFirst);
  const eachStep = (fn) => list.forEach((step, i) => {
    const text = planStepText(step);
    if (text) fn(step, i + 1, text);
  });
  eachStep((_step, index, text) => claim(index, newest.filter((kid) => {
    const bound = boundStepOf(kid);
    return bound?.task === text && bound.index === index;
  })));
  eachStep((_step, index, text) => claim(index, newest.filter((kid) => boundStepOf(kid)?.task === text)));
  eachStep((_step, index, text) => claim(index, newest.filter(
    (kid) => String(kid?.goal?.requirement ?? '').trim() === text,
  )));
  const unbound = [...live].sort(oldestFirst).filter((kid) => !boundStepOf(kid));
  eachStep((step, index) => {
    const member = String(step?.memberBotId ?? '').trim();
    if (!member) return;
    claim(index, unbound.filter((kid) => String(kid?.owner?.leadBotId ?? '') === member));
  });
  return out;
}

/**
 * 一次派活对应计划里的哪一条（对不上返回 null）。
 *
 *   1) 负责人显式写了步骤号 → 就是那一条（序号不存在 → `{error}`，不能猜）；
 *   2) 这份活本来就占着某一条（同一份派工重试）→ 还是那一条；
 *   3) 派活正文 == 某条步骤正文 → 那一条（优先还空着的）；
 *   4) 这个成员在计划里**还空着**的最早一条（@ 派活的正文是摘录，对不上原文）。
 *
 * @returns {null | {index:number, step:object} | {error:string}}
 */
export function matchPlanStep({
  steps, bindings = null, memberBotId = null, requirement = '', explicitStep = null, selfId = null,
} = {}) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return null;
  const taken = bindings instanceof Map ? bindings : new Map();
  const wanted = explicitStep === null || explicitStep === undefined ? '' : String(explicitStep).trim();
  if (wanted) {
    const n = Number(wanted);
    if (!Number.isInteger(n) || n < 1 || n > list.length || !planStepText(list[n - 1])) {
      return { error: `计划里没有第 ${wanted} 条（共 ${list.length} 条）` };
    }
    return { index: n, step: list[n - 1] };
  }
  if (selfId) {
    for (const [index, kid] of taken) {
      if (kid?.id === selfId) return { index, step: list[index - 1] };
    }
  }
  const member = String(memberBotId ?? '').trim();
  const text = String(requirement ?? '').trim();
  if (text) {
    const same = list.map((step, i) => ({ step, index: i + 1 }))
      .filter(({ step }) => planStepText(step) === text);
    if (same.length) {
      // 只认空位，不回退 same[0]（否则第二次同正文派活会把两个活子任务绑到同一条）；
      // 同成员优先，避免甲乙同正文条目互串。全被占满时直接返回 null。
      const untaken = same.filter(({ index }) => !taken.has(index));
      const pick = (member ? untaken.find(({ step }) => String(step?.memberBotId ?? '').trim() === member) : null)
        ?? untaken[0]
        ?? null;
      return pick;
    }
  }
  if (member) {
    const i = list.findIndex((step, idx) => String(step?.memberBotId ?? '') === member
      && planStepText(step) && !taken.has(idx + 1));
    if (i >= 0) return { index: i + 1, step: list[i] };
  }
  return null;
}

/**
 * 一条计划条目 → 这份活该带上的依赖与把关位。
 *
 * @returns {{dependsOn:string[], waitSteps:Array<{index:number, task:string}>, checkpoint:boolean}}
 *   `dependsOn`：已派出的前置条目对应的子任务 id；
 *   `waitSteps`：前置条目**还没派出去** —— 调用方必须把这份活挂起，不能当成没有依赖
 *   （那正是「计划里写了依赖、下游照样抢跑」的老问题）。
 */
export function planLinksOf({ steps, bindings = null, index, selfId = null } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const self = Number(index);
  const step = list[self - 1];
  const taken = bindings instanceof Map ? bindings : new Map();
  const dependsOn = [];
  const waitSteps = [];
  if (!step) return { dependsOn, waitSteps, checkpoint: false };
  for (const raw of Array.isArray(step.dependsOn) ? step.dependsOn : []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > list.length || n === self) continue;
    const kid = taken.get(n);
    if (kid?.id && kid.id !== selfId) {
      if (!dependsOn.includes(kid.id)) dependsOn.push(kid.id);
    } else if (!waitSteps.some((w) => w.index === n)) {
      waitSteps.push({ index: n, task: planStepText(list[n - 1]) });
    }
  }
  return { dependsOn, waitSteps, checkpoint: step.checkpoint === true };
}

/**
 * 挂起的计划前置里，哪些现在已经派出去了（新派一份活 / 计划修订之后回填用）。
 *
 * 按正文认（序号可能被修订挪动）。正文已经不在计划里的前置**留着**：
 * 那是负责人改了计划，得由他放行或改派，不能自作主张当成已满足。
 *
 * @returns {{resolved:Array<{wait:object, kidId:string}>, still:Array<object>}}
 */
export function resolvePlanWaits(waitSteps, steps, bindings) {
  const list = Array.isArray(steps) ? steps : [];
  const taken = bindings instanceof Map ? bindings : new Map();
  const resolved = [];
  const still = [];
  for (const wait of Array.isArray(waitSteps) ? waitSteps : []) {
    const text = String(wait?.task ?? '').trim();
    const at = text ? list.findIndex((step, i) => planStepText(step) === text && taken.has(i + 1)) : -1;
    const kid = at >= 0 ? taken.get(at + 1) : null;
    if (kid?.id) resolved.push({ wait, kidId: kid.id });
    else still.push(wait);
  }
  return { resolved, still };
}

/** 被计划挂起、还在等哪几条派出去（没挂起 / 已放行 / 已结束都返回空数组）。 */
export function planWaitingSteps(kid) {
  if (isTerminal(kid?.state) || kid?.checkpointApprovedAt) return [];
  const waits = kid?.planHold?.waitSteps;
  return Array.isArray(waits) ? waits.filter((w) => w && String(w.task ?? '').trim()) : [];
}
