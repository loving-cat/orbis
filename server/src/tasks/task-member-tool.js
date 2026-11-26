/**
 * 成员派活工具：负责人把工作拆成持久子任务。
 *
 * ## 职责
 *
 * 只做编排：复用 04 的可信提交与统一 guard 核对身份，核对部门职责与成员资格，
 * 再交给子任务契约落盘。子任务契约、预算归属、验收条件都复用既有模块。
 *
 * ## 边界
 *
 *   · 只有**这个部门**的负责人能派活（不是"owner 恰好是我"）；
 *   · 成员必须属于本部门；
 *   · 取消/改版/旧尝试在写入前后各核一次；
 *   · 不启动执行 —— 由推进器在持久化之后调度。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { createChildTask, childrenOf } from './task-subtasks.js';
import { planStepBindings } from './task-dag.js';
import { readManagedSubmission, revalidateManaged, SUBMISSION } from '../coordination/task-context.js';
import { isLeadOfRoom } from '../role-tools.js';

const error = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 构造「派给成员」工具。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store 应用 store
 * @param {string} p.roomId
 * @param {string} p.botId
 * @param {string|null} [p.laneKey] 本会话泳道键。
 *   ★ 负责人这一轮被分档（`ORBIS_MODEL_TIER`）或兜底换了模型时跑在 `#fb` 泳道上，
 *   受管上下文挂在那条泳道的会话上 —— 按主泳道查只会得到「当前没有受管任务」。
 */
export function buildMemberTaskTool({ runner, store, roomId, botId, laneKey = null }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'assign_member_task',
    label: '把活派给成员',
    description:
      '把当前目标拆出一份可独立完成的小任务，派给部门里的某个成员去做。' +
      '每份小任务都要写清目标与验收条件；派出去之后成员会自己执行，结果回来你再继续。' +
      '如果两份活要改同一批文件，填 files 声明一下——撞车的会排队，不会两个人同时改坏同一份文件。' +
      '不要替成员做它们自己的工作。',
    parameters: Type.Object({
      memberBotId: Type.String({ description: '指派给哪个成员（部门成员 id）' }),
      requirement: Type.String({ description: '这份小任务要达成什么' }),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '这份活会碰的文件或目录路径（仓库内相对路径）。'
            + '填了就与其它正在跑的活互斥：别人也在改同一批文件时，这份会排队而不是同时写坏。不填表示不知道/不冲突。',
        }),
      ),
      planStep: Type.Optional(
        Type.Number({
          description:
            '这份活是 task_plan 计划里的第几条（序号）。计划里那一条写的依赖与把关会自动带上，不用再抄一遍。'
            + '不填时按正文 / 成员自动对应到计划里还没派出的那一条。',
        }),
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description:
            '前置子任务 id（也可以是计划里的步骤号）：这些子任务全部验收完成后，这份活才会开跑。'
            + '计划里已经写了的依赖不用重复填（会自动带上）。不要填成本身，也不许成环。',
        }),
      ),
      checkpointBeforeRun: Type.Optional(
        Type.Boolean({
          description:
            '前置都完成后，先唤醒你（负责人）审一下上游产物再放行，而不是直接开跑。'
            + '适合“下一步依赖上一步的结论与口径”的活。不填就跟计划里这一条的设置走（计划没写则直接开跑）。',
        }),
      ),
      modelTier: Type.Optional(
        Type.Union([Type.Literal('fast'), Type.Literal('standard'), Type.Literal('strong')], {
          description:
            '这份活用哪一档模型：fast=格式化/提取/清单这类机械活（省钱省时）；'
            + 'strong=架构设计/排错/重构/审计这类要吃推理的活；standard 或不填=成员自己的模型。'
            + '不会改成员配置，只影响这一次执行。',
        }),
      ),
      useWorktree: Type.Optional(
        Type.Boolean({
          description:
            '这份编码活要不要在独立的 Git worktree + 独立分支里做（改代码互不打扰，验收通过后自动合回主仓）。'
            + '默认不填 = 跟主工作区一样；同一仓库的并行编码活建议开。',
        }),
      ),
      worktreeRepo: Type.Optional(
        Type.String({
          description: '目标仓库（相对工作目录的路径；不填 = 工作目录本身就是仓库）。',
        }),
      ),
      criticRequired: Type.Optional(
        Type.Boolean({
          description:
            '这份活要不要让独立复核员审一次（机械验收通过后仍可能被退回）。'
            + '适合“内容对不对比文件在不在更重要”的活（报告、分析、口径、文案）。不填默认跟随目标条件。',
        }),
      ),
      deliverables: Type.Optional(Type.Array(Type.String(), { description: '交付物清单' })),
      verification: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          kind: Type.Union([
            Type.Literal('artifact'),
            Type.Literal('format'),
            Type.Literal('count'),
            Type.Literal('test'),
            Type.Literal('receipt'),
            Type.Literal('expert'),
          ]),
          description: Type.String({ description: '怎么算做完' }),
          spec: Type.Optional(Type.Any()),
          required: Type.Optional(Type.Boolean()),
        }),
        { description: '验收条件，至少一条' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      // 1) 复用 04 可信提交与统一 guard
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId, laneKey });
      if (submission.kind === SUBMISSION.invalid) {
        return error(`这次执行不能派活：${submission.text}`);
      }
      if (submission.kind !== SUBMISSION.managed) {
        return error('当前没有受管任务，不能派活。');
      }

      // 2) 部门职责：必须是这个部门的负责人
      const room = store.getRoom(roomId);
      if (!room || room.kind !== 'group' || !isLeadOfRoom(room, botId)) {
        return error('只有部门负责人可以派活。');
      }

      // 3) 成员必须是本部门成员
      const memberBotId = String(params.memberBotId ?? '');
      if (!(room.botIds ?? []).includes(memberBotId)) {
        return error('这个成员不在当前部门里。');
      }

      const loaded = taskRuns.read(submission.taskRunId);
      const parent = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!parent) return error('找不到当前任务。');

      // 4) 写入前再核：取消/改版/旧尝试都拦住
      const stale = revalidateManaged(parent, {
        taskRuns,
        expectRevision: submission.revision,
        attemptId: submission.attemptId,
        botId,
        // 派活只能发生在任务自己的会话里（防跨部门串台）
        roomId,
      });
      if (stale) return error(`这次派工已失效：${stale.text}`);

      const goal = {
        requirement: String(params.requirement ?? '').slice(0, 600),
        scope: '',
        deliverables: (params.deliverables ?? []).map((x) => String(x)).slice(0, 20),
        verification: (params.verification ?? []).map((v, i) => ({
          id: String(v.id ?? 'vc' + (i + 1)),
          kind: String(v.kind),
          description: String(v.description ?? ''),
          spec: v.spec && typeof v.spec === 'object' ? v.spec : {},
          required: v.required !== false,
        })),
      };

      const created = await createChildTask({
        taskRuns,
        parentTaskRun: parent,
        goal,
        botId: memberBotId,
        files: params.files ?? [],
        dependsOn: params.dependsOn ?? [],
        // 不填 = 跟计划里这一条走（计划没写就直接开跑）；显式 true/false 说了算
        checkpointBeforeRun: typeof params.checkpointBeforeRun === 'boolean' ? params.checkpointBeforeRun : undefined,
        // 负责人点名「这是计划第 N 条」；不填由 createChildTask 按正文/成员自动对应
        planStep: params.planStep ?? null,
        // 不填就是 undefined（跟随父任务），不能写成 false —— 那会把父任务的要求吞掉
        criticRequired: typeof params.criticRequired === 'boolean' ? params.criticRequired : undefined,
        modelTier: params.modelTier ? String(params.modelTier) : undefined,
        useWorktree: typeof params.useWorktree === 'boolean' ? params.useWorktree : undefined,
        worktreeRepo: params.worktreeRepo ? String(params.worktreeRepo) : undefined,
        // 计划步骤号 → 真实子任务 id（负责人手里只有“第 2 条”这种写法）
        stepIds: planStepIds(taskRuns, parent),
      });
      if (!created.ok) return error(`没派出去：${created.text ?? created.code}`);

      // 5) 写入后再核父版本：期间被改版就不算这次派工生效
      const after = taskRuns.read(submission.taskRunId);
      const stillSame = after?.status === 'found' && after.taskRun?.revision === submission.revision;
      if (!stillSame) return error('派工期间父目标已改版，这次派工不生效。');

      // 以落盘后的那一份为准（复用 / 计划回填都可能改过依赖与把关位）
      const saved = taskRuns.read(created.child?.id);
      const child = saved?.status === 'found' ? saved.taskRun : created.child;
      const claims = child?.fileClaims ?? [];
      const deps = child?.dependsOn ?? [];
      const plan = created.plan ?? null;
      const waits = Array.isArray(child?.planHold?.waitSteps) ? child.planHold.waitSteps : [];
      return {
        content: [{
          type: 'text',
          text: `已派给成员，子任务 ${child?.id} 已登记。`
            + (plan ? `\n对应计划第 ${plan.index} 条（计划里写的依赖与把关已自动带上）。` : '')
            + (claims.length ? `\n占用的文件：${claims.join('、')}（撞车的活会排队）` : '')
            + (deps.length
              ? `\n等这些前置完成才开跑：${deps.join('、')}`
                + (child?.checkpointBeforeRun && !waits.length ? '（前置完成后先叫你来把关）' : '')
              : '')
            + (waits.length
              ? `\n计划里它还要等第 ${waits.map((w) => w.index).join('、')} 条，那几条还没派出去：`
                + '这份活先挂着不开跑；把那几条派出去后会自动接上依赖。确定不用等就用 approve_subtask_checkpoint 放行。'
              : ''),
        }],
        details: {
          childTaskRunId: child?.id ?? null,
          reused: created.reused === true,
          files: claims,
          dependsOn: deps,
          checkpointBeforeRun: child?.checkpointBeforeRun === true,
          planStep: plan?.index ?? null,
          waitingPlanSteps: waits.map((w) => w.index),
        },
      };
    },
  });
}

/**
 * 计划步骤号 → 真实子任务 id 的对照表（只含已真的派出去、还占着那一条的）。
 *
 * 负责人写依赖时手里只有「第 2 条」，而调度需要的是 `tr_x_c1_ab12cd34`。
 * 对照规则与派活时的认领是**同一份**（`planStepBindings`）：派活时记下的绑定 →
 * 正文相同 → 同一成员按派出先后。对不上就不给映射 —— 宁可让 normalizeDependsOn
 * 明确报“不存在”，也不能猜一条错的依赖（猜错的代价是下游永远不跑）。
 *
 * @returns {Map<string,string>} 步骤号（1 基字符串）→ 子任务 id
 */
export function planStepIds(taskRuns, parentTaskRun) {
  const steps = parentTaskRun?.plan?.steps ?? [];
  const map = new Map();
  if (!Array.isArray(steps) || !steps.length) return map;
  for (const [index, kid] of planStepBindings(steps, childrenOf(taskRuns, parentTaskRun))) {
    if (kid?.id) map.set(String(index), kid.id);
  }
  return map;
}

/**
 * 构造「放行等把关的分工」工具。
 *
 * ## 只给本部门真实负责人
 *
 * checkpoint 的含义是“前置做完了，但得有人看一眼才准继续”，那个人就是负责人。
 * 所以这里按真实角色再核一次（不是“owner 恰好是我”），成员拿到也调不通。
 *
 * ## 为什么写进 supervisor 而不是直接改账本
 *
 * 放行只是“允许开始”，真正跑起来要靠统一的唤醒链路：自己写 state 会造成
 * “账本说该跑了、调度器却不知道”的隐形任务。
 */
export function buildCheckpointApproveTool({ runner, store, roomId, botId, laneKey = null }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'approve_subtask_checkpoint',
    label: '★ 放行等把关的分工',
    description:
      '有一份分工的前置已经都交付了，但它设了「先由你放行」，现在停着等你把关。' +
      '看过前置产物觉得可以，就调用它放行（放行后立即自动开跑）；不够就改派或取消。' +
      '不传 childTaskRunId 时放行当前所有等把关的分工。',
    parameters: Type.Object({
      childTaskRunId: Type.Optional(Type.String({ description: '要放行的子任务 id（不填=全部待放行的）' })),
      reason: Type.Optional(Type.String({ description: '放行理由（一句话，会记在子任务上）' })),
    }),
    execute: async (_toolCallId, params) => {
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId, laneKey });
      if (submission.kind === SUBMISSION.invalid) return error(`这次执行不能放行：${submission.text}`);
      if (submission.kind !== SUBMISSION.managed) return error('当前没有受管任务，不能放行。');

      const room = store.getRoom(roomId);
      if (!room || room.kind !== 'group' || !isLeadOfRoom(room, botId)) {
        return error('只有部门负责人可以放行分工。');
      }

      const supervisor = runner?.taskRuntime?.supervisor ?? null;
      if (typeof supervisor?.approveCheckpoint !== 'function') {
        return error('任务调度器不在线，暂时不能放行（稍后再试一次）。');
      }

      const wanted = String(params?.childTaskRunId ?? '').trim();
      const parent = taskRuns.read(submission.taskRunId);
      const parentRun = parent?.status === 'found' ? parent.taskRun : null;
      if (!parentRun) return error('找不到当前任务。');

      // 点名放行时必须是**这个任务**的子任务（防跨任务串改）
      if (wanted) {
        const kids = childrenOf(taskRuns, parentRun);
        if (!kids.some((kid) => kid.id === wanted)) {
          return error(`${wanted} 不是这个任务下的分工，不能放行。`);
        }
      }

      const out = wanted
        ? await supervisor.approveCheckpoint(wanted, { botId, reason: params?.reason ?? '' })
        : await supervisor.approveCheckpointsOf(parentRun.id, { botId, reason: params?.reason ?? '' });

      if (!out.ok) return error(out.text ?? '没有可放行的分工。');
      return {
        content: [{ type: 'text', text: out.text }],
        details: { approved: out.approved ?? [] },
      };
    },
  });
}
