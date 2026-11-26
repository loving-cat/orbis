/**
 * 集群全景投影（纯逻辑，零 IO）：时间线 + Token/费用 + C1–C4 状态徽章的聚合。
 *
 * ## 为什么单独一层
 *
 * C1–C4 把大量状态落进了 TaskRun（DAG 依赖/checkpoint、共享黑板、Critic 复核轮次、
 * 分身与模型档位、Worktree 合入/冲突），但客户端一直只看到「排队/执行/验收」这种
 * 四类阶段。真正想问的是：
 *   · 这 40 分钟里每个成员各干了多久、谁在等谁？
 *   · Token 花在谁身上、花在哪个模型上？还剩多少额度？
 *   · 有多少活是分身跑完的、被复核打回几次、代码合进去了几个文件？
 *
 * 这些**全是已落盘事实的算术**，所以放在纯函数里：可单测、可复用、不碰 IO。
 *
 * ## 三条不许破的口径
 *
 * 1. **Token 绝不双计**：根 `budget.usedTokens` 已经是整棵树的权威累计（每个已结算
 *    尝试都记进去过）。所以 `telemetry.totalTokens` 优先用它；只有它缺失
 *    （老数据 / 未开预算）才退化成「子树已结算尝试之和」。两者都给出时才展示
 *    分项，并明确 `totalTokensSource`。
 * 2. **不编造价格**：没有单价（`costOf` 返回 null）就 `costUsd: null`。
 *    编一个假价格比不显示更糟 —— 用户会照着它做决策。
 * 3. **有界**：`items` 截断到 `limit` 并带 `truncated` / `total`；
 *    `byBot` / `byModel` 各最多 12 条。这份数据会进 App 详情页，不能无限长。
 */
import { remainingRuns } from './task-budget.js';
import { isTerminal } from './task-contract.js';
import { DEP_STATUS, dependencyStatus, planWaitingSteps } from './task-dag.js';

/** 每个任务最多展示几条依赖 / 缺陷 / 冲突文件。 */
export const MAX_LIST = 10;

/** `byBot` / `byModel` 各自最多几条。 */
export const MAX_GROUPS = 12;

const STATE_TEXT = Object.freeze({
  queued: '准备中', running: '执行中', verifying: '验收中',
  waiting_approval: '等待批准', waiting_input: '等待补充', waiting_dependency: '等待子任务',
  paused_user: '已暂停', paused_budget: '额度用尽', blocked: '受阻',
  completed: '已完成', cancelled: '已取消',
});

/**
 * 客户端用的四类阶段（与 task-transport 的 PHASE_OF_STATE 同口径）。
 *
 * ★ `paused_budget` 是 `needs_user`：额度用尽需要用户加钱/加次数才能继续，
 *   把它归成 `paused`（＝用户主动停）会让界面不显示「追加额度」入口。
 */
function phaseOf(state) {
  if (state === 'completed' || state === 'cancelled') return 'done';
  if (state === 'paused_user') return 'paused';
  if (['paused_budget', 'waiting_approval', 'waiting_input', 'blocked'].includes(state)) return 'needs_user';
  return 'active';
}

/** 一个数字字段（非有限数一律当 0）。 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 取一堆候选时间戳里最早/最晚的有效值。 */
function pickTime(values, mode = 'min') {
  let out = null;
  for (const raw of values) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (out === null) out = n;
    else out = mode === 'min' ? Math.min(out, n) : Math.max(out, n);
  }
  return out;
}

/** 已结算尝试（只认结算过的，排队/在途的不算产出）。 */
function settledAttempts(taskRun) {
  return (taskRun?.attempts ?? []).filter((a) => a && a.state === 'settled');
}

/** 一次尝试的 token 用量（`result.usage` 里的 input/output）。 */
function usageOf(attempt) {
  const usage = attempt?.result?.usage ?? null;
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
  const pick = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
  return {
    input: pick(usage.inputTokens ?? usage.inputTotal ?? usage.input),
    output: pick(usage.outputTokens ?? usage.output),
  };
}

/**
 * 根预算的 token 视图。
 *
 * ★ `maxTokens` **已经包含历次追加的 `extraTokens`**（`extendRootBudget` 与
 *   `task-reduce.js` 都是这么加的口径）。所以剩余额度只能是 `max - used`；
 *   再减一次 extra 会把额度凭空算多（1500+500-1600 会算出 400，实际已经用尽）。
 *   `extraTokens` 只作为「追加过多少」的展示字段，不参与计算。
 *
 * 不设上限时返回 `null`（"不限"与"剩 0"是两件事，不能混）。
 */
export function budgetTokensView(budget) {
  const max = Number(budget?.maxTokens);
  const hasMax = Number.isInteger(max) && max > 0;
  const used = num(budget?.usedTokens);
  const extra = num(budget?.extraTokens);
  return {
    maxTokens: hasMax ? max : null,
    usedTokens: used || null,
    extraTokens: extra,
    remainingTokens: hasMax ? Math.max(0, max - used) : null,
  };
}

/** 一个任务的 Token 汇总。 */
export function tokensOf(taskRun) {
  let input = 0;
  let output = 0;
  for (const attempt of settledAttempts(taskRun)) {
    const usage = usageOf(attempt);
    input += usage.input;
    output += usage.output;
  }
  return { input, output, total: input + output };
}

/**
 * 一个任务的时间线：排队 / 开始 / 结束。
 *
 * ★ `startedAt` 是**第一次真正派出去执行**的时刻（最早一次尝试的开始），不是建档时间。
 *   等前置 / 等名额 / 等把关的那段不是在干活：以前拿 `createdAt` 当起点，
 *   一份排了 30 分钟、只干了 2 分钟的活会画成一根 32 分钟的长条 ——
 *   瀑布流要回答的「谁在等谁」恰好被抹平。排队那段单独给 `queuedAt`。
 * ★ 还没结束（执行中 / 验收中 / 等返工）的任务，条子画到 `now`；没开始过的 `startedAt` 为 null。
 *
 * @param {object} taskRun
 * @param {{now?:number|null}} [opts]
 * @returns {{queuedAt:number|null, startedAt:number|null, endedAt:number|null, durationMs:number|null}}
 */
export function timelineOf(taskRun, { now = null } = {}) {
  const attempts = Array.isArray(taskRun?.attempts) ? taskRun.attempts : [];
  const startedAt = pickTime(attempts.map((a) => a?.startedAt ?? a?.at), 'min');
  const queuedAt = pickTime([taskRun?.createdAt], 'min');
  const terminal = isTerminal(taskRun?.state);
  const endedAt = terminal
    ? pickTime([taskRun?.delivery?.at, ...attempts.map((a) => a?.settledAt), taskRun?.updatedAt], 'max')
    : null;
  const until = endedAt ?? pickTime([now], 'max');
  const durationMs = startedAt && until ? Math.max(0, until - startedAt) : null;
  return { queuedAt, startedAt, endedAt, durationMs };
}

/** Critic 摘要（C2）：没有复核记录就返回 null。 */
export function criticOf(taskRun) {
  const state = taskRun?.criticState ?? null;
  const feedback = taskRun?.criticFeedback ?? null;
  const verdict = state?.lastVerdict ?? (feedback ? 'failed' : null);
  // ★ 被打回过几轮。通过时 `reworkCount` 已清零（下一轮重新计数），
  //   打回轮数由 writeCriticPassed 记在 `criticState.rounds`；只读 reworkCount 的话，
  //   每一份「返工两轮后通过」的活都显示成 0 轮，面板上的「复核返工」总数恒偏小。
  //   老数据没有 `rounds` 时退回 reworkCount。
  const rounds = verdict === 'passed'
    ? num(state?.rounds ?? state?.reworkCount ?? 0)
    : num(state?.reworkCount ?? feedback?.round ?? 0);
  const reviewed = verdict === 'passed' || verdict === 'failed' || rounds > 0;
  if (!reviewed) return null;
  return {
    verdict: verdict ?? null,
    rounds,
    maxRounds: num(state?.maxRounds ?? feedback?.maxRounds ?? 0) || null,
    reviewerModel: String(state?.reviewerModel ?? feedback?.reviewerModel ?? '') || null,
    defects: (feedback?.defects ?? []).map((d) => String(d ?? '')).filter(Boolean).slice(0, MAX_LIST),
  };
}

/** Worktree 摘要（C4）：没有 worktree 就返回 null。 */
export function worktreeOf(taskRun) {
  const note = taskRun?.worktree ?? null;
  if (!note?.worktreePath && !note?.branch) return null;
  return {
    status: String(note.status ?? 'active'),
    branch: String(note.branch ?? '') || null,
    mergedHead: String(note.mergedHead ?? '') || null,
    conflictFiles: (note.conflictFiles ?? []).map((f) => String(f ?? '')).filter(Boolean).slice(0, MAX_LIST),
    filesCount: num((note.filesChanged ?? []).length),
  };
}

/** 派发摘要（C3 分身 + 模型分档）。 */
export function dispatchOf(taskRun) {
  const meta = taskRun?.lastDispatchMeta ?? {};
  return {
    cloned: meta.cloned === true,
    cloneId: meta.cloneId ? String(meta.cloneId) : null,
    tier: meta.tier ? String(meta.tier) : null,
    model: meta.modelOverride ? String(meta.modelOverride) : null,
  };
}

/**
 * 依赖 + 把关状态（C1）。
 *
 * ★ `waitingCheckpoint` 必须与推进器同一判据（`dependencyStatus === 'checkpoint'`），
 *   而不是"设了 checkpointBeforeRun 且没放行"这么一句：
 *   · 已取消 / 已完成的子任务谈不上"等把关"；
 *   · 前置还没完成、或上游已经永久失败时，它停在那里**不是**在等负责人放行 ——
 *     显示「等把关」会让用户去点一个点了也没用的按钮。
 *   这里传的是**同父子任务**数组（不含 root），与推进器一致。
 */
export function dependenciesOf(taskRun, siblings = []) {
  const brothers = (Array.isArray(siblings) ? siblings : []).filter((s) => s && s.id);
  const byId = new Map(brothers.map((s) => [String(s.id), s]));
  const deps = Array.isArray(taskRun?.dependsOn) ? taskRun.dependsOn : [];
  const terminal = isTerminal(taskRun?.state);
  const status = terminal ? null : dependencyStatus(taskRun, brothers);
  const approved = taskRun?.checkpointBeforeRun === true && Boolean(taskRun?.checkpointApprovedAt);
  return {
    dependsOn: deps.map((d) => String(d)).filter(Boolean).slice(0, MAX_LIST),
    // 依赖里还有谁没完成（客户端据此显示「等 A、B」）
    waitingOn: deps
      .map((d) => byId.get(String(d)))
      .filter((d) => d && !isTerminal(d.state))
      .map((d) => String(d.id))
      .slice(0, MAX_LIST),
    waitingCheckpoint: status === DEP_STATUS.checkpoint,
    checkpointApproved: approved,
    // ★ 被计划挂起：「等把关」其实是在等计划里还没派出去的第 N 条。
    //   不单独标出来，用户只看到「等把关」+「放行」按钮，点下去下游就抢跑了。
    waitingPlanSteps: planWaitingSteps(taskRun)
      .map((w) => Number(w.index))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, MAX_LIST),
  };
}

/** 排序权重：先按开始时间（早的在前），没开始的按创建时间。 */
function orderKey(taskRun) {
  const tl = timelineOf(taskRun);
  return num(tl.startedAt ?? taskRun?.createdAt ?? 0);
}

/**
 * 一个子任务 → 瀑布流条。
 *
 * @param {object} child
 * @param {object} ctx `{ siblings, nameOf, costOf, originAt, now }`
 */
export function waterfallItemOf(child, {
  siblings = [], nameOf = null, costOf = null, originAt = null, now = null,
} = {}) {
  const id = String(child?.id ?? '');
  const state = String(child?.state ?? 'queued');
  const botId = child?.owner?.leadBotId ?? null;
  const tl = timelineOf(child, { now });
  const tokens = tokensOf(child);
  const dispatch = dispatchOf(child);
  const name = typeof nameOf === 'function' ? String(nameOf(botId) ?? '') : '';
  const costUsd = typeof costOf === 'function'
    ? (() => {
        const value = costOf({
          model: dispatch.model, botId, inputTokens: tokens.input, outputTokens: tokens.output,
        });
        return Number.isFinite(Number(value)) ? Number(value) : null;
      })()
    : null;
  const dep = dependenciesOf(child, siblings);
  return {
    id,
    title: String(child?.goal?.requirement ?? '').slice(0, 200),
    botId,
    botName: name,
    state,
    stateText: STATE_TEXT[state] ?? state,
    phase: phaseOf(state),
    // 建档（开始排队）时刻：排队到开跑之间那段是「等」，客户端画成虚段
    queuedAt: tl.queuedAt,
    startedAt: tl.startedAt,
    endedAt: tl.endedAt,
    durationMs: tl.durationMs,
    // 相对整棵树起点的偏移：客户端画甘特条用（服务端算好省得客户端各算一遍）
    queuedOffsetMs: tl.queuedAt && originAt ? Math.max(0, tl.queuedAt - originAt) : null,
    offsetMs: tl.startedAt && originAt ? Math.max(0, tl.startedAt - originAt) : null,
    dependsOn: dep.dependsOn,
    waitingOn: dep.waitingOn,
    waitingCheckpoint: dep.waitingCheckpoint,
    checkpointApproved: dep.checkpointApproved,
    waitingPlanSteps: dep.waitingPlanSteps,
    dispatch,
    critic: criticOf(child),
    worktree: worktreeOf(child),
    tokens,
    costUsd,
  };
}

/** 按 key 聚合，降序取前 N。 */
function groupBy(list, keyOf, seedOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!key) continue;
    const entry = map.get(key) ?? { ...seedOf(item), tokens: 0, runs: 0 };
    entry.tokens += item.tokens?.total ?? 0;
    entry.runs += 1;
    if (item.dispatch?.cloned) entry.clonedRuns = (entry.clonedRuns ?? 0) + 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || b.runs - a.runs);
}

/**
 * 整棵树的全景。
 *
 * @param {object} p
 * @param {object} p.rootRun 根任务（预算是它的权威）
 * @param {Array<object>} [p.children] 本版本的子任务
 * @param {Function} [p.nameOf] botId → 名字
 * @param {Function} [p.costOf] `({model,botId,inputTokens,outputTokens}) => number|null`
 * @param {number} [p.now]
 * @param {number} [p.limit]
 */
export function buildTaskWaterfall({
  rootRun = null, children = [], nameOf = null, costOf = null, now = Date.now(), limit = 40,
} = {}) {
  const root = rootRun ?? null;
  const kids = (Array.isArray(children) ? children : []).filter((c) => c && c.id);
  const siblings = root ? [root, ...kids] : kids;
  const ordered = [...kids].sort((a, b) => orderKey(a) - orderKey(b));
  const max = Math.max(1, Math.floor(num(limit) || 40));

  // ---- 时间轴：整棵树从最早的动作到最后一次动作
  const times = [];
  for (const run of siblings) {
    const tl = timelineOf(run);
    if (tl.startedAt) times.push(tl.startedAt);
    if (tl.endedAt) times.push(tl.endedAt);
    if (run?.createdAt) times.push(Number(run.createdAt));
    if (run?.delivery?.at) times.push(Number(run.delivery.at));
  }
  const originAt = pickTime(times, 'min');
  const endRaw = pickTime(times, 'max');
  const running = siblings.some((run) => !isTerminal(run?.state));
  const endAt = pickTime([endRaw, running ? now : null], 'max');
  const durationMs = originAt && endAt && endAt >= originAt ? endAt - originAt : null;

  // ★ 先把**全量**子任务都投影一遍（聚合与计数要用完整数据），
  //   最后才截断给客户端 —— 否则 `truncated > 0` 时 byBot/byModel/counts
  //   都只统计到前 N 条，用户看到的"总分身数/总冲突数"是错的。
  const allItems = ordered.map((child) => waterfallItemOf(child, {
    siblings, nameOf, costOf, originAt, now,
  }));
  const items = allItems.slice(0, max);

  // ---- Token：根预算优先（权威），子树求和不与它相加
  const treeTokens = siblings.reduce((acc, run) => {
    const t = tokensOf(run);
    acc.input += t.input;
    acc.output += t.output;
    return acc;
  }, { input: 0, output: 0 });
  const rootUsed = Number(root?.budget?.usedTokens);
  const hasRootUsed = Number.isFinite(rootUsed) && rootUsed > 0;
  const totalTokens = hasRootUsed ? Math.round(rootUsed) : treeTokens.input + treeTokens.output;
  // ★ 只汇总**真实记录下来的**复核用量（`criticState.usedTokens`）。
  //   以前这里拿 `tokensOf(run).total`（成员执行的 token）冒充评审用量 ——
  //   那会把"评审花了多少"说成一个完全不一样的数。
  const criticTokens = siblings.reduce((sum, run) => sum + num(run?.criticState?.usedTokens), 0);

  const withCost = allItems.filter((item) => item.costUsd !== null);
  const estimatedCostUsd = typeof costOf === 'function' && allItems.length && withCost.length === allItems.length
    ? Number(withCost.reduce((sum, item) => sum + item.costUsd, 0).toFixed(6))
    : null;

  const byBot = groupBy(allItems, (item) => item.botId, (item) => ({ botId: item.botId, name: item.botName }))
    .slice(0, MAX_GROUPS)
    .map((row) => ({ ...row, clonedRuns: row.clonedRuns ?? 0 }));
  const byModel = groupBy(allItems, (item) => item.dispatch?.model || 'default', (item) => ({
    model: item.dispatch?.model || 'default',
  }))
    .slice(0, MAX_GROUPS)
    .map((row) => ({ model: row.model, tokens: row.tokens, runs: row.runs }));

  const counts = {
    childrenTotal: kids.length,
    childrenDone: kids.filter((k) => isTerminal(k.state)).length,
    clonedRuns: allItems.filter((item) => item.dispatch?.cloned).length,
    criticReworks: allItems.reduce((sum, item) => sum + num(item.critic?.rounds), 0),
    worktreeMerged: allItems.filter((item) => item.worktree?.status === 'merged').length,
    worktreeConflicts: allItems.filter((item) => item.worktree?.status === 'conflict').length,
    checkpointsPending: allItems.filter((item) => item.waitingCheckpoint).length,
  };

  return {
    originAt,
    endAt,
    durationMs,
    items,
    total: kids.length,
    truncated: Math.max(0, kids.length - items.length),
    telemetry: {
      totalTokens,
      inputTokens: treeTokens.input,
      outputTokens: treeTokens.output,
      // 口径来源写清楚：客户端/诊断不该猜「这个数是怎么来的」
      totalTokensSource: hasRootUsed ? 'root_budget' : 'attempt_sum',
      criticTokens: criticTokens || 0,
      estimatedCostUsd,
      budget: budgetTokensView(root?.budget ?? null),
      runs: {
        maxRuns: root?.budget?.maxRuns ?? null,
        usedRuns: num(root?.budget?.usedRuns) || null,
        remainingRuns: remainingRuns(root?.budget ?? null),
      },
      byBot,
      byModel,
      counts,
    },
  };
}

/**
 * 黑板 → 客户端安全摘要。
 *
 * 只给「谁写的 / 什么类型 / 说了什么 / 引用 / 时间」，不带内部 id 与指纹。
 */
export function projectBlackboard(blackboard, { limit = 10 } = {}) {
  const entries = Array.isArray(blackboard?.entries) ? blackboard.entries : [];
  const max = Math.max(0, Math.floor(num(limit) || 10));
  return entries.slice(-max).map((entry) => ({
    kind: String(entry?.kind ?? 'fact'),
    authorName: String(entry?.authorName ?? '') || null,
    text: String(entry?.text ?? '').slice(0, 240),
    ref: String(entry?.ref ?? '') || null,
    at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : null,
  })).reverse();
}

/** 列表接口用的极轻量摘要（只有几个标量，别拖慢列表）。 */
export function telemetrySummaryOf(rootRun, children = []) {
  const kids = Array.isArray(children) ? children : [];
  const used = Number(rootRun?.budget?.usedTokens);
  let tokens = Number.isFinite(used) && used > 0 ? Math.round(used) : 0;
  if (!tokens) {
    tokens = kids.reduce((sum, kid) => sum + tokensOf(kid).total, 0);
  }
  let criticReworks = 0;
  let worktreeConflicts = 0;
  let checkpointsPending = 0;
  for (const kid of kids) {
    criticReworks += num(criticOf(kid)?.rounds);
    if (kid?.worktree?.status === 'conflict') worktreeConflicts += 1;
    if (!isTerminal(kid?.state) && dependencyStatus(kid, kids) === DEP_STATUS.checkpoint) {
      checkpointsPending += 1;
    }
  }
  return {
    totalTokens: tokens,
    estimatedCostUsd: null,
    criticReworks,
    worktreeConflicts,
    checkpointsPending,
  };
}
