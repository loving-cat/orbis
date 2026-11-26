/**
 * 子任务：负责人把工作派给成员时创建的持久 TaskRun。
 *
 * 复用既有任务契约（父/根/父版本/预算归属/验收条件），不另建任务系统。
 *
 * 业务身份 = 父任务 + 父目标版本 + 完整派工内容指纹（成员、目标、交付物、
 * 每条验收的 kind/description/spec/required）。因此：
 *   · 完全相同的一份派工重试 → 同一身份，复用；
 *   · 任一验收参数（例如 count 2→3）变化 → 明确的新派工；
 *   · 短 ID 碰撞但内容不同 → 请求指纹冲突，拒绝复用。
 *
 * ## 文件占用（fileClaims）
 *
 * 派工时可以声明这份活要碰哪些文件。它**不进**业务身份指纹 ——
 * 同一份活重派时补一句文件清单不该变成另一条任务；复用同一条时把新声明的
 * 并进去即可。它的唯一用途是给调度器做互斥判定（见 task-supervisor）。
 *
 * ## 依赖（dependsOn）与把关关（checkpointBeforeRun）
 *
 * 和文件占用一样**不进**业务身份指纹：补一条依赖不等于换了一份活。
 * 但依赖的合法性在落盘前就 fail-closed 核完：
 *   · 只能依赖同一父任务、同一目标版本下真实存在的子任务（跨父/不存在 → 拒）；
 *   · 不允许自依赖，也不允许形成任何长度的环（`detectDependencyCycle`）；
 * 理由：依赖写错的代价是“下游永远不跑”或“拿了半份前置产物开干”，
 * 而这两种在界面上都只能看到“任务卡住了”，排查成本极高。
 *
 * ## 计划条目（planStep / planHold）
 *
 * 负责人在 `task_plan` 里写的依赖与把关位，派活时**自动落到子任务上**：
 * 每份新活先认领它对应的那条计划（`matchPlanStep`），再带上那一条的前置与把关。
 * 以前计划只写在纸上 —— 负责人照着 @ 派活（或调工具时没重复写依赖），
 * 下游就和上游同时开跑，拿不到上游的产物。
 *
 * 前置条目还没派出去时，这份活**挂起**（`planHold` + 临时把关位）而不是当成没有依赖：
 * 等前置那条派出去，`releasePlanHolds` 自动接上依赖并撤掉临时把关；
 * 负责人也可以直接放行（他决定不等了）。挂起走的是既有 checkpoint 唤醒链路，
 * 所以不会出现「全队都在等一条没人派的活」的死等。
 */
import { createTaskRun } from './task-run-factory.js';
import { fileClaimList } from './task-file-claims.js';
import {
  normalizeDependsOn, detectDependencyCycle,
  planStepBindings, matchPlanStep, planLinksOf, planStepText, resolvePlanWaits,
} from './task-dag.js';
import { isTerminal } from './task-contract.js';

/** 稳定序列化：对象键排序，数组保持顺序。 */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/** 规范化后的完整派工内容。 */
export function dispatchContentOf({ botId, goal }) {
  return {
    botId: String(botId ?? ''),
    requirement: String(goal?.requirement ?? ''),
    scope: String(goal?.scope ?? ''),
    deliverables: (goal?.deliverables ?? []).map((x) => String(x)),
    verification: (goal?.verification ?? []).map((v) => ({
      id: String(v?.id ?? ''),
      kind: String(v?.kind ?? ''),
      description: String(v?.description ?? ''),
      spec: v?.spec === undefined || v?.spec === null ? null : v.spec,
      required: v?.required !== false,
    })),
  };
}

/** 完整内容指纹：冲突判定用这一份，不用短 hash。 */
export function dispatchKeyOf({ botId, goal }) {
  return stableJson(dispatchContentOf({ botId, goal }));
}

/** 短码只用于 ID 后缀。 */
export function dispatchCodeOf({ botId, goal }) {
  const payload = dispatchKeyOf({ botId, goal });
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 建一个子任务。
 *
 * @param {object} p
 * @param {object} p.taskRuns
 * @param {object} p.parentTaskRun 当前父任务快照
 * @param {object} p.goal
 * @param {string} p.botId 成员
 * @param {()=>number} [p.clock]
 */
export async function createChildTask({
  taskRuns, parentTaskRun, goal, botId, clock = () => Date.now(),
  /** 调度优先级：负责人安排谁先做（数字小的先跑）。 */
  priority = 0,
  /** 这份活要碰的文件（可空）。只用于调度互斥，不参与业务身份指纹。 */
  files = [],
  /**
   * 前置子任务（可空）：这些子任务**都已验收完成**之前，这份活不会被启动。
   *
   * 支持三种写法（都过同一套规范化）：
   *   · 真实子任务 id（`tr_x_c1_ab12cd34`）；
   *   · 计划步骤号（`2`，配合 `stepIds` 翻成真实子任务）；
   *   · 混着写。
   */
  dependsOn = [],
  /**
   * 前置完成后要不要先唤醒负责人把关再放行。
   *
   * 显式 `true/false` 说了算；不传（`undefined`）就跟这份活对应的计划条目走
   * （计划里写了 `checkpoint` 就开），对不上计划就不开。
   */
  checkpointBeforeRun = undefined,
  /**
   * 负责人点名这份活是计划里的第几条（1 基，可空）。
   *
   * 不填时按「正文 == 步骤正文」→「这个成员在计划里还空着的最早一条」自动认领。
   * 填了不存在的序号直接拒绝（不能猜一条错的依赖）。
   */
  planStep = null,
  /** 是否按父任务的计划自动带上依赖/把关（只在测试或特殊入口里关）。 */
  usePlan = true,
  /**
   * 强制独立复核（默认跟随父任务）。
   *
   * `true` = 这份活即使没有 expert 验收条件也要被 Critic 审一次；
   * `undefined` / `false` = 按档位与目标条件自动决定。
   */
  criticRequired = undefined,
  /** 难度档位（fast/standard/strong）：不进业务身份指纹，复用时可更新。 */
  modelTier = undefined,
  /** 显式要求独立 worktree（默认跟随父任务）。 */
  useWorktree = undefined,
  /** 目标仓库（相对 workspace）。 */
  worktreeRepo = undefined,
  /** 计划步骤号 → 真实子任务 id（负责人只记得住“第 2 条”）。 */
  stepIds = null,
}) {
  if (!parentTaskRun) return { ok: false, code: 'no_parent', text: '缺少父任务' };
  if (!goal || typeof goal !== 'object') return { ok: false, code: 'no_goal', text: '缺少子任务目标' };
  if (!Array.isArray(goal.verification) || goal.verification.length === 0) {
    return { ok: false, code: 'no_verification', text: '子任务必须有验收条件' };
  }

  const parentId = parentTaskRun.id;
  const parentRevision = parentTaskRun.revision;
  const fingerprint = dispatchKeyOf({ botId, goal });
  const code = dispatchCodeOf({ botId, goal });
  const claims = fileClaimList(files);
  const childId = parentId + '_c' + parentRevision + '_' + code;
  const requestId = parentId + '_r' + parentRevision + '_c' + code;

  const allKids = childrenOf(taskRuns, parentTaskRun);
  const siblings = allKids.filter((run) => run.id !== childId);

  // ★ 计划条目：这份活是计划里的哪一条 → 带上那一条写好的前置与把关位。
  //   负责人照着计划 @ 派活时不会再把依赖抄一遍；以前这里不认计划，
  //   计划里「第 2 条等第 1 条」只是一行字，两份活照样同时开跑。
  const planSteps = usePlan && Array.isArray(parentTaskRun.plan?.steps) ? parentTaskRun.plan.steps : [];
  const bindings = planSteps.length ? planStepBindings(planSteps, allKids) : new Map();
  const matched = planSteps.length
    ? matchPlanStep({
      steps: planSteps, bindings, memberBotId: botId, requirement: goal.requirement,
      explicitStep: planStep, selfId: childId,
    })
    : null;
  if (matched?.error) return { ok: false, code: 'bad_plan_step', text: matched.error };
  const planLinks = matched
    ? planLinksOf({ steps: planSteps, bindings, index: matched.index, selfId: childId })
    : { dependsOn: [], waitSteps: [], checkpoint: false };
  const planBinding = matched ? { index: matched.index, task: planStepText(matched.step) } : null;
  // 显式写了就听显式的；没写才跟计划
  const gate = typeof checkpointBeforeRun === 'boolean' ? checkpointBeforeRun : planLinks.checkpoint;
  // 前置条目还没派出去：挂起（临时把关位），等它派出后由 releasePlanHolds 接上依赖
  const waits = planLinks.waitSteps;

  // ★ 依赖必须在落盘前核完（fail-closed）：环与越界依赖一旦写进去，
  //   下游就永远不会跑，而界面上只会看到“排队中”。
  const explicitDeps = Array.isArray(dependsOn) ? dependsOn : (dependsOn === null || dependsOn === undefined ? [] : [dependsOn]);
  const deps = normalizeDependsOn([...explicitDeps, ...planLinks.dependsOn], siblings.map((run) => run.id), {
    stepIds,
    selfId: childId,
  });
  if (deps.rejected.length) {
    const why = deps.rejected
      .map((item) => (item.reason === 'self'
        ? `子任务不能依赖自己（${String(item.raw)}）`
        : `依赖 ${String(item.raw)} 不是这个任务下已存在的子任务`))
      .join('；');
    return { ok: false, code: 'bad_depends_on', text: why };
  }
  const cycle = detectDependencyCycle([
    ...siblings.map((run) => ({ id: run.id, dependsOn: run.dependsOn ?? [] })),
    { id: childId, dependsOn: deps.ids },
  ]);
  if (!cycle.ok) {
    return { ok: false, code: 'dependency_cycle', text: '依赖成环：' + cycle.cycle.join(' → ') };
  }

  const built = createTaskRun({
    id: childId,
    requestId,
    requesterId: parentTaskRun.request?.requesterId ?? 'task-parent',
    parentTaskId: parentId,
    rootTaskId: parentTaskRun.rootTaskId ?? parentId,
    origin: parentTaskRun.origin ?? null,
    goal,
    budget: parentTaskRun.budget ?? null,
    at: clock(),
    // 成员的活跟着整件事走：整件事是自主推进，成员失败也自己补做，不停下来等人
    // （推进器判定时以根任务为准，这里只是让子任务自己的记录也说得清）
    autonomous: parentTaskRun.flags?.autonomous === true,
    autonomyReason: parentTaskRun.flags?.autonomyReason ?? '',
    // ★ 质检开关：子任务显式指定优先，否则跟父任务走（“这件事要质检”应该传导下去）
    criticRequired: criticRequired === undefined
      ? parentTaskRun.flags?.criticRequired === true
      : criticRequired === true,
    // 档位：显式优先，否则跟随父任务（“这件事要强模型”应该往下传导）
    modelTier: modelTier === undefined
      ? (parentTaskRun.flags?.modelTier ?? null)
      : modelTier,
    // worktree 隔离：显式优先，否则跟随父任务
    useWorktree: useWorktree === undefined
      ? parentTaskRun.flags?.useWorktree === true
      : useWorktree === true,
    worktreeRepo: worktreeRepo === undefined
      ? (parentTaskRun.flags?.worktreeRepo ?? null)
      : (worktreeRepo ? String(worktreeRepo) : null),
  });
  if (!built.ok) return { ok: false, code: 'bad_child', text: built.text };

  const accepted = await taskRuns.acceptRequest({
    requesterId: parentTaskRun.request?.requesterId ?? 'task-parent',
    requestId,
    fingerprint,
    build: () => ({
      ...built.taskRun,
      parentRevision,
      dispatchFingerprint: fingerprint,
      owner: { leadBotId: botId, departmentId: parentTaskRun.owner?.departmentId ?? null },
      // ★ 负责人安排的先后顺序 → 调度器按它决定谁先跑。
      //   「先交首批、别等全量」这种要求如果只写在正文里，调度是看不见的；
      //   记到账本上才能真的影响执行顺序。
      dispatchPriority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      // 这份活声明的文件占用：调度器据此把撞车的活排开（同一时刻只跑一份）。
      fileClaims: claims.files,
      // ★ 受控 DAG：前置没完成就不启动。checkpoint 是“完成后先由负责人点头”。
      dependsOn: deps.ids,
      checkpointBeforeRun: gate === true || waits.length > 0,
      checkpointApprovedAt: null,
      checkpointApprovedBy: null,
      // ★ 计划条目绑定与挂起（见文件头「计划条目」）
      planStep: planBinding,
      planHold: waits.length ? { waitSteps: waits, addedGate: gate !== true, at: clock() } : null,
    }),
    at: clock(),
  });
  const planOut = planBinding
    ? { ...planBinding, dependsOn: planLinks.dependsOn, waitSteps: waits, checkpoint: gate === true }
    : null;
  const linkOpts = {
    dependsOn: deps.ids, checkpointBeforeRun: gate === true, modelTier, useWorktree, worktreeRepo, siblings, clock,
    planStep: planBinding, planWaits: waits,
  };
  if (!accepted.ok) {
    if (accepted.code === 'request_conflict') {
      return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
    }
    if (accepted.code === 'duplicate' || accepted.existing) {
      const existing = accepted.taskRun ?? accepted.existing;
      if (existing?.dispatchFingerprint && existing.dispatchFingerprint !== fingerprint) {
        return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
      }
      await mergeClaims(existing?.id, claims.files, taskRuns, clock);
      const linkedA = await mergeChildLinks(taskRuns, existing?.id, linkOpts);
      if (!linkedA.ok) return linkedA;
      await releasePlanHolds({ taskRuns, parentTaskRun, clock });
      return { ok: true, child: existing, reused: true, plan: planOut };
    }
    return { ok: false, code: accepted.code ?? 'accept_failed', text: accepted.text };
  }

  const child = accepted.taskRun ?? built.taskRun;
  // 复用已有记录时，内容指纹必须与这次完全一致；短码相同但内容不同要明确冲突
  if (accepted.created === false) {
    if (child?.dispatchFingerprint && child.dispatchFingerprint !== fingerprint) {
      return { ok: false, code: 'dispatch_conflict', text: '同一派工身份的内容不一致，拒绝复用' };
    }
    await mergeClaims(child?.id, claims.files, taskRuns, clock);
    const linkedB = await mergeChildLinks(taskRuns, child?.id, linkOpts);
    if (!linkedB.ok) return linkedB;
    await releasePlanHolds({ taskRuns, parentTaskRun, clock });
    return { ok: true, child, reused: true, plan: planOut };
  }
  await taskRuns.mutate(child.id, {
    mutate: (cur) => (cur ? { ...cur, parentRevision, dispatchFingerprint: fingerprint, updatedAt: clock() } : null),
  });
  // 这条派出去了：之前挂起等它的兄弟现在可以接上依赖
  await releasePlanHolds({ taskRuns, parentTaskRun, clock });
  return { ok: true, child, reused: false, plan: planOut };
}

/** 同一条计划前置的身份（按正文认，序号可能被修订挪动）。 */
const waitKey = (wait) => String(wait?.task ?? '').trim();

/**
 * 计划写好（或修订）之后，把它落到**还没开始**的子任务上。
 *
 * 「先派活、后补计划」也是常见路径：负责人先 @ 了两个人，再用 task_plan 写下
 * 「第 2 条等第 1 条」。不回头补的话，这句依赖对已经派出去的活不生效。
 *
 * 只动从没开始过的（没有任何尝试、没放行过、未终态）：已经在跑的活补依赖没有意义，
 * 中途改它的闸门只会让返工轮莫名其妙地停下来。依赖是并集，不清掉负责人原来写的。
 *
 * @returns {Promise<{applied:string[]}>} 核对过的子任务（没有可补的就原样不动）
 */
export async function applyPlanToChildren({ taskRuns, parentTaskRun, clock = () => Date.now() }) {
  const out = { applied: [] };
  if (!parentTaskRun?.id) return out;
  const fresh = taskRuns.read?.(parentTaskRun.id);
  const parent = fresh?.status === 'found' ? fresh.taskRun : parentTaskRun;
  const steps = Array.isArray(parent.plan?.steps) ? parent.plan.steps : [];
  if (!steps.length) return out;
  const kids = childrenOf(taskRuns, parent);
  const bindings = planStepBindings(steps, kids);
  for (const [index, kid] of bindings) {
    if (isTerminal(kid.state) || kid.checkpointApprovedAt || (kid.attempts ?? []).length) continue;
    const links = planLinksOf({ steps, bindings, index, selfId: kid.id });
    const step = steps[index - 1];
    const linked = await mergeChildLinks(taskRuns, kid.id, {
      dependsOn: links.dependsOn,
      checkpointBeforeRun: links.checkpoint,
      planStep: { index, task: planStepText(step) },
      planWaits: links.waitSteps,
      siblings: kids,
      clock,
    });
    if (linked.ok) out.applied.push(kid.id);
  }
  await releasePlanHolds({ taskRuns, parentTaskRun: parent, clock });
  return out;
}

/**
 * 被计划挂起的子任务：前置条目现在派出去了就接上依赖；全接上了就撤掉临时把关位。
 *
 * 每次派出新活（以及负责人修订计划）之后调一次。幂等：没有可接的就什么都不写。
 *
 * ★ 撤掉的只是**挂起时临时加的**那道把关（`addedGate`）。计划或负责人本来就要求
 *   「前置完成后先叫我把关」的，那道关照样留着。
 * ★ 接上会成环的前置不接：留着挂起，由负责人放行或改派（它在提示词里看得到原因）。
 *
 * @param {object} p
 * @param {object} p.taskRuns
 * @param {object} p.parentTaskRun
 * @param {()=>number} [p.clock]
 * @returns {Promise<{linked:string[], released:string[]}>}
 */
export async function releasePlanHolds({ taskRuns, parentTaskRun, clock = () => Date.now() }) {
  const out = { linked: [], released: [] };
  if (!parentTaskRun?.id) return out;
  // 计划读最新的：负责人可能刚在这一轮里改过
  const fresh = taskRuns.read?.(parentTaskRun.id);
  const parent = fresh?.status === 'found' ? fresh.taskRun : parentTaskRun;
  if (parent.revision !== parentTaskRun.revision) return out;
  const steps = Array.isArray(parent.plan?.steps) ? parent.plan.steps : [];
  if (!steps.length) return out;
  const kids = childrenOf(taskRuns, parent);
  const held = kids.filter((kid) => !isTerminal(kid.state) && !kid.checkpointApprovedAt
    && Array.isArray(kid.planHold?.waitSteps) && kid.planHold.waitSteps.length);
  if (!held.length) return out;
  const bindings = planStepBindings(steps, kids);
  for (const kid of held) {
    const usable = resolvePlanWaits(kid.planHold.waitSteps, steps, bindings).resolved
      .filter(({ kidId }) => kidId !== kid.id);
    if (!usable.length) continue;
    let released = false;
    const res = await taskRuns.mutate(kid.id, {
      mutate: (cur) => {
        if (!cur || isTerminal(cur.state) || cur.checkpointApprovedAt) return null;
        const hold = cur.planHold;
        if (!Array.isArray(hold?.waitSteps) || !hold.waitSteps.length) return null;
        const done = new Set(usable.map(({ wait }) => waitKey(wait)));
        const nextDeps = [...new Set([...(cur.dependsOn ?? []), ...usable.map(({ kidId }) => kidId)])];
        const cycle = detectDependencyCycle([
          ...kids.filter((k) => k.id !== cur.id).map((k) => ({ id: k.id, dependsOn: k.dependsOn ?? [] })),
          { id: cur.id, dependsOn: nextDeps },
        ]);
        if (!cycle.ok) return null;
        const still = hold.waitSteps.filter((wait) => !done.has(waitKey(wait)));
        released = still.length === 0;
        return {
          ...cur,
          dependsOn: nextDeps,
          planHold: released ? null : { ...hold, waitSteps: still },
          checkpointBeforeRun: released && hold.addedGate === true ? false : cur.checkpointBeforeRun,
          updatedAt: clock(),
        };
      },
    });
    if (res?.ok && res.changed !== false) {
      out.linked.push(kid.id);
      if (released) out.released.push(kid.id);
    }
  }
  return out;
}

/**
 * 把新声明的依赖并进已有子任务（复用同一条活时用）。
 *
 * 并集而不是覆盖：同一份活重派时可能只补一句「还有这条依赖」，
 * 把旧的清掉会让先前的等待丢失 —— 下游会抢跑。
 *
 * 依赖并集同样要过环检测：两份重派各自只合法，合起来可能就成环了。
 */
async function mergeChildLinks(taskRuns, childId, {
  dependsOn = [], checkpointBeforeRun = false, modelTier = undefined,
  useWorktree = undefined, worktreeRepo = undefined, siblings = [], clock = () => Date.now(),
  planStep = null, planWaits = [],
} = {}) {
  if (!childId) return { ok: true };
  const others = siblings.filter((run) => run.id !== childId).map((run) => run.id);
  const out = await taskRuns.mutate(childId, {
    mutate: (cur) => {
      if (!cur) return null;
      const mergedDeps = normalizeDependsOn([...(cur.dependsOn ?? []), ...dependsOn], others, { selfId: childId });
      const cycle = detectDependencyCycle([
        ...siblings.filter((run) => run.id !== childId)
          .map((run) => ({ id: run.id, dependsOn: run.dependsOn ?? [] })),
        { id: childId, dependsOn: mergedDeps.ids },
      ]);
      if (!cycle.ok) {
        return { __reject: { ok: false, code: 'dependency_cycle', text: '依赖成环：' + cycle.cycle.join(' → ') } };
      }
      // ★ 计划绑定：已有绑定不改（同一份活不会换条目）；以前没绑上的（先派活、后写计划）补上。
      const bindStep = !cur.planStep && planStep ? planStep : null;
      // ★ 计划前置还没派出去：还没开始、负责人也没放行的活补挂起；已经在跑/放行过的不再拦。
      const canHold = Array.isArray(planWaits) && planWaits.length > 0
        && !isTerminal(cur.state) && !cur.checkpointApprovedAt && !(cur.attempts ?? []).length;
      const prevWaits = Array.isArray(cur.planHold?.waitSteps) ? cur.planHold.waitSteps : [];
      const addWaits = canHold ? planWaits.filter((w) => !prevWaits.some((p) => waitKey(p) === waitKey(w))) : [];
      const nextHold = addWaits.length
        ? {
          waitSteps: [...prevWaits, ...addWaits],
          // 原来就有一道「真」把关（计划/负责人要求的）时，挂起撤销后也要留着它
          addedGate: cur.planHold ? cur.planHold.addedGate === true : cur.checkpointBeforeRun !== true && checkpointBeforeRun !== true,
          at: cur.planHold?.at ?? clock(),
        }
        : (cur.planHold ?? null);
      const gate = checkpointBeforeRun === true || cur.checkpointBeforeRun === true || addWaits.length > 0;
      const sameDeps = mergedDeps.ids.join('|') === (cur.dependsOn ?? []).join('|');
      // ★ 档位：显式传入合法值就跟着更新（它不进业务身份指纹，复用时可改）。
      //   `undefined` = 这次没指定，保持原样；不能因为没填就把已有档位清掉。
      const wantTier = ['fast', 'standard', 'strong'].includes(String(modelTier ?? '').trim().toLowerCase())
        ? String(modelTier).trim().toLowerCase()
        : null;
      const tierChanged = wantTier !== null && (cur.flags?.modelTier ?? null) !== wantTier;
      // worktree 意图同样是「显式才更新，未指定就保持」
      const wantWorktree = useWorktree === undefined ? null : useWorktree === true;
      const wantRepo = worktreeRepo === undefined ? null : (worktreeRepo ? String(worktreeRepo) : null);
      const worktreeChanged = (wantWorktree !== null && (cur.flags?.useWorktree === true) !== wantWorktree)
        || (wantRepo !== null && (cur.flags?.worktreeRepo ?? null) !== wantRepo);
      if (sameDeps && gate === (cur.checkpointBeforeRun === true) && !tierChanged && !worktreeChanged
        && !bindStep && !addWaits.length) return null;
      return {
        ...cur,
        dependsOn: mergedDeps.ids,
        checkpointBeforeRun: gate,
        ...(bindStep ? { planStep: bindStep } : {}),
        planHold: nextHold,
        ...(tierChanged || worktreeChanged ? {
          flags: {
            ...(cur.flags ?? {}),
            ...(tierChanged ? { modelTier: wantTier } : {}),
            ...(wantWorktree !== null ? { useWorktree: wantWorktree } : {}),
            ...(wantRepo !== null ? { worktreeRepo: wantRepo } : {}),
          },
        } : {}),
        updatedAt: clock(),
      };
    },
  });
  if (out?.ok === false) {
    return { ok: false, code: out.code ?? 'merge_failed', text: out.text ?? '子任务依赖没写进去' };
  }
  return { ok: true };
}

/**
 * 把新声明的文件并进已有子任务（复用同一条活时用）。
 *
 * 并集而不是覆盖：同一份活重派时可能只补一句"还有这个文件"，
 * 把旧的清掉会让先前的占用丢失，撞车就又挡不住了。
 */
async function mergeClaims(childId, files, taskRuns, clock) {
  if (!childId || !Array.isArray(files) || !files.length) return;
  await taskRuns.mutate(childId, {
    mutate: (cur) => {
      if (!cur) return null;
      const merged = fileClaimList([...(cur.fileClaims ?? []), ...files]);
      const same = merged.files.length === (cur.fileClaims ?? []).length;
      if (same) return null;
      return { ...cur, fileClaims: merged.files, updatedAt: clock() };
    },
  });
}

/** 父任务当前那版目标下的子任务（按持久 parentRevision 判定）。 */
export function childrenOf(taskRuns, parentTaskRun) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  return all.filter((run) => run.parentTaskId === parentTaskRun.id
    && (run.parentRevision ?? run.revision) === parentTaskRun.revision);
}

/** 任意版本（用于取消传播/诊断）。 */
export function allChildrenOf(taskRuns, parentTaskRun) {
  const scan = taskRuns.listAll?.();
  const all = scan?.taskRuns ?? scan ?? [];
  return all.filter((run) => run.parentTaskId === parentTaskRun.id);
}
