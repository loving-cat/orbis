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
 */
import { createTaskRun } from './task-run-factory.js';
import { fileClaimList } from './task-file-claims.js';
import { normalizeDependsOn, detectDependencyCycle } from './task-dag.js';

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
  /** 前置完成后要不要先唤醒负责人把关再放行（默认不要）。 */
  checkpointBeforeRun = false,
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

  // ★ 依赖必须在落盘前核完（fail-closed）：环与越界依赖一旦写进去，
  //   下游就永远不会跑，而界面上只会看到“排队中”。
  const siblings = childrenOf(taskRuns, parentTaskRun).filter((run) => run.id !== childId);
  const deps = normalizeDependsOn(dependsOn, siblings.map((run) => run.id), {
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
      checkpointBeforeRun: checkpointBeforeRun === true,
      checkpointApprovedAt: null,
      checkpointApprovedBy: null,
    }),
    at: clock(),
  });
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
      const linkedA = await mergeChildLinks(taskRuns, existing?.id, {
        dependsOn: deps.ids, checkpointBeforeRun, modelTier, useWorktree, worktreeRepo, siblings, clock,
      });
      if (!linkedA.ok) return linkedA;
      return { ok: true, child: existing, reused: true };
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
    const linkedB = await mergeChildLinks(taskRuns, child?.id, {
      dependsOn: deps.ids, checkpointBeforeRun, modelTier, useWorktree, worktreeRepo, siblings, clock,
    });
    if (!linkedB.ok) return linkedB;
    return { ok: true, child, reused: true };
  }
  await taskRuns.mutate(child.id, {
    mutate: (cur) => (cur ? { ...cur, parentRevision, dispatchFingerprint: fingerprint, updatedAt: clock() } : null),
  });
  return { ok: true, child, reused: false };
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
      const gate = checkpointBeforeRun === true || cur.checkpointBeforeRun === true;
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
      if (sameDeps && gate === (cur.checkpointBeforeRun === true) && !tierChanged && !worktreeChanged) return null;
      return {
        ...cur,
        dependsOn: mergedDeps.ids,
        checkpointBeforeRun: gate,
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
