/**
 * checkpoint 放行的落地（账本 + 唤醒），从推进器里拆出来的一层。
 *
 * ## 为什么单独一层
 *
 * 「前置都交付了，但设了先由我把关」这件事有两个入口：负责人在会话里调
 * `approve_subtask_checkpoint`，主控可能在别处批量放行。两处都要做同样三件事
 * （校验、写放行证据、唤醒），写成两份就会分叉。放到这里，`task-supervisor`
 * 只留一行接线。
 *
 * ## 边界
 *
 * 不做身份核对（那是工具层的事：谁在什么角色下能放行），也不决定"该不该放行" —
 * 只回答"这条子任务还需要放行吗"，需要就写 `checkpointApprovedAt/By`。
 * 唤醒**必须**走调用方给的 `notify`：自己改 state 会造成"账本说该跑了、
 * 调度器却不知道"的隐形任务。
 */
import { pendingCheckpointKids } from './task-dag.js';

/** 这份子任务还需要放行吗（设了 checkpoint 且还没点头）。 */
export function needsApprove(kid) {
  return kid?.checkpointBeforeRun === true && !kid?.checkpointApprovedAt;
}

/**
 * 放行一份子任务。
 *
 * @param {object} p
 * @param {object} p.taskRuns TaskRunStore
 * @param {string} p.childTaskRunId
 * @param {string|null} [p.botId] 放行的人（记进 checkpointApprovedBy）
 * @param {string} [p.reason] 放行理由（一句话，进子任务的备注）
 * @param {Function} p.notify 唤醒（推进器注入）
 * @param {()=>number} [p.clock]
 * @returns {Promise<{ok:boolean, approved:string[], text:string}>}
 */
export async function approveCheckpoint({
  taskRuns, childTaskRunId, botId = null, reason = '', notify, clock = () => Date.now(),
}) {
  const loaded = childTaskRunId ? taskRuns.read(childTaskRunId) : null;
  const child = loaded?.status === 'found' ? loaded.taskRun : null;
  const parentLoaded = child?.parentTaskId ? taskRuns.read(child.parentTaskId) : null;
  const parent = parentLoaded?.status === 'found' ? parentLoaded.taskRun : null;
  if (!child || !parent) return { ok: false, approved: [], text: '找不到这份子任务或它的父任务。' };
  if (parent.state === 'cancelled' || parent.state === 'completed') {
    return { ok: false, approved: [], text: '父任务已经结束，不用再放行。' };
  }
  if (needsApprove(child)) {
    const out = await taskRuns.mutate(child.id, {
      mutate: (cur) => (cur ? {
        ...cur,
        checkpointApprovedAt: clock(),
        checkpointApprovedBy: botId ?? null,
        checkpointApproveNote: String(reason ?? '').slice(0, 120),
        updatedAt: clock(),
      } : null),
    });
    if (!out?.ok) return { ok: false, approved: [], text: '放行没写进去：' + (out?.text ?? '未知原因') };
  }
  // ★ 只写一个"允许开始"：真正跑起来走统一唤醒链路，不另开执行路径。
  if (typeof notify === 'function') notify(child.id);
  return { ok: true, approved: [child.id], text: '已放行：' + child.id + '，它会自己开跑。' };
}

/**
 * 把一个父任务下**所有**等把关的子任务一次放行。
 *
 * 批量入口（负责人说"都行，继续"时用）：逐条走同一份放行逻辑，
 * 少一条都不算成功 —— 部分放行会让负责人以为都放过了。
 */
export async function approveCheckpointsOf({
  taskRuns, parentTaskRunId, botId = null, reason = '', notify, clock = () => Date.now(),
}) {
  const loaded = parentTaskRunId ? taskRuns.read(parentTaskRunId) : null;
  const parent = loaded?.status === 'found' ? loaded.taskRun : null;
  if (!parent) return { ok: false, approved: [], text: '找不到这个任务。' };
  const all = taskRuns.listAll?.();
  const list = all?.taskRuns ?? all ?? [];
  const siblings = list.filter((run) => run.parentTaskId === parent.id
    && (run.parentRevision ?? run.revision) === parent.revision);
  const targets = pendingCheckpointKids(siblings);
  const approved = [];
  for (const kid of targets) {
    const one = await approveCheckpoint({ taskRuns, childTaskRunId: kid.id, botId, reason, notify, clock });
    if (one.ok) approved.push(...one.approved);
  }
  if (!approved.length) return { ok: false, approved: [], text: '没有等把关的分工。' };
  if (typeof notify === 'function') notify(parent.id);
  return { ok: true, approved, text: '已放行 ' + approved.length + ' 份分工，它们会自己开跑。' };
}
