/**
 * 接单工具：把这一轮已有理解结果提交为正式接单。
 *
 * ## 两条固定来源，各自校验、互不降级
 *
 *   · 受管执行（已有 TaskRun 的负责人）：走 04 的统一交接入口，读可信受管提交；
 *   · 首次接单（用户原始请求的理解轮）：走本轮请求作用域 + 宿主准入，
 *     由宿主建首个 TaskRun 并执行组织交接，不伪造 attempt / root grant。
 *
 * 残缺的受管上下文直接拒绝，**不回退**到首次准入或 legacy。
 *
 * ## 开关控制
 *
 * 默认开启（`ORBIS_TASK_INTAKE`；设 `'0'` / `'false'` / `'off'` 关闭）。
 * SDK 轻量模式由 `createOrbisRuntime` 显式传 `taskIntake: false` 隔离。
 */
import path from 'node:path';
import { isToolBlockedInSummaryTurn, SUMMARY_TURN_BLOCK_MESSAGE } from '../chief-summary.js';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readBrandEnv } from '../brand.js';
import { parseIntake } from '../tasks/task-run-factory.js';
import { handleIntake, ACTION, INTAKE_OUTCOME } from './intake.js';
import { makeSpecPreparer } from './department-spec.js';
import { readManagedSubmission, SUBMISSION } from './task-context.js';
import { admitFirstTask, admissionBudget } from './task-admission.js';
import { createRequestReceipts } from '../tasks/task-request-receipts.js';
import { config } from '../config.js';

/** 环境开关：默认开启，可通过 `ORBIS_TASK_INTAKE=0` 显式关闭。 */
export function intakeEnabled(env = process.env) {
  const raw = readBrandEnv(env, 'TASK_INTAKE');
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * 把模型替用户做的假设并进 `goal.scope`。
 *
 * ## 为什么要有「假设」这一栏
 *
 * 以前接单工具要求「目标、交付物、验收标准……任一不明确就先问」，长任务几乎必然
 * 先停下来问一轮。现在的做法是：能合理假设的就先定下来、照做，把假设写清楚 ——
 * 用户随时可以插话纠正（全双工），不需要停下来等。
 *
 * 目标契约只认 requirement / scope / deliverables / verification（见 task-goal.js），
 * 所以假设并进 scope 文本：负责人每轮都读得到，任务卡上也看得到。
 *
 * @param {object} params accept_task 的入参
 * @returns {object} 去掉 assumptions、并进 scope 后的入参（没有假设时原样返回）
 */
export function foldAssumptions(params) {
  const goal = params?.goal;
  if (!goal || typeof goal !== 'object' || !('assumptions' in goal)) return params;
  const { assumptions, ...rest } = goal;
  const list = (Array.isArray(assumptions) ? assumptions : [])
    .map((a) => String(a ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!list.length) return { ...params, goal: rest };
  const block = '按以下假设推进（用户可随时纠正）：'
    + list.map((a, i) => `${i + 1}) ${a.slice(0, 160)}`).join('；');
  const scope = [String(rest.scope ?? '').trim(), block].filter(Boolean).join('\n').slice(0, 2000);
  return { ...params, goal: { ...rest, scope } };
}

/** 请求回执目录（小文件，原子写；优先使用当前运行时实例的 dataDir）。 */
export function requestReceipts(dataDir = config.dataDir) {
  return createRequestReceipts({ dir: path.join(dataDir, 'task-requests') });
}

/**
 * 构造接单工具定义。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store
 * @param {string} p.roomId
 * @param {string} p.botId
 * @param {object} [p.health]
 * @param {(scope:object)=>object|null} [p.requestScopeOf] 当前理解轮请求作用域
 * @param {object} [p.receipts]
 */
export function buildIntakeTools({
  runner, store, roomId, botId, health = null, requestScopeOf = null, receipts = null,
  /** 本会话泳道键：受管轮次可能跑在 `#fb`（分档/兜底换模型）泳道上，上下文要按它查。 */
  laneKey = null,
}) {
  const wanted = [
    defineTool({
      name: 'accept_task',
      description:
        '把用户这次的要求登记成任务并交给合适的执行者。' +
        '\n\n' +
        '· kind=answer：普通问答，不进入执行；\n' +
        '· kind=clarification：只在**连从哪下手都不知道**时用 —— 要做的对象说不清（"改一下那个"却不知道是哪个）、' +
        '两种理解会做出完全不同的东西而且做错了没法回头、或者缺只有用户才能给的东西（账号密码、授权、原始数据）。' +
        '用户只是在聊想法 / 问方案 / 随口一句，也用它（不建任务）；\n' +
        '· kind=accept_task：确实要做的事，需给出目标与验收条件。' +
        '交付物格式、验收口径、细节取舍这类**能合理假设**的，不要为它们停下来问：' +
        '直接接单，把你替用户做的假设写进 goal.assumptions（交付时列给用户看，用户随时可以插话纠正）。\n' +
        '\nrouting.type 决定去向：direct（你自己做）、existing（交给已有部门，需 departmentId）、' +
        'new（新建部门，需 departmentSpec）。' +
        '如果用户只是要你建个部门、不要立刻开工，用 routing.departmentOnly=true。',
      parameters: Type.Object({
        kind: Type.Union(
          [Type.Literal('answer'), Type.Literal('clarification'), Type.Literal('accept_task')],
          { description: '接单意图' },
        ),
        text: Type.Optional(Type.String({ description: 'answer/clarification 时给用户的话' })),
        goal: Type.Optional(
          Type.Object({
            requirement: Type.String({ description: '要达成什么' }),
            scope: Type.Optional(Type.String()),
            deliverables: Type.Optional(Type.Array(Type.String())),
            assumptions: Type.Optional(Type.Array(
              Type.String({ description: '一条你替用户做的合理假设（例如「输出成 Markdown 表格」「只统计近一年的数据」）' }),
              { description: '用户没说清、你按合理做法先定下来的地方；执行和交付时都会带上，用户可随时纠正' },
            )),
            verification: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.Optional(Type.String({ description: '可省，自动生成' })),
                  kind: Type.Union(
                    [
                      Type.Literal('artifact'),
                      Type.Literal('format'),
                      Type.Literal('count'),
                      Type.Literal('test'),
                      Type.Literal('receipt'),
                      Type.Literal('expert'),
                    ],
                    { description: '验收种类' },
                  ),
                  description: Type.String({ description: '怎么算做完，必须写清楚' }),
                  spec: Type.Optional(Type.Any()),
                  required: Type.Optional(Type.Boolean()),
                }),
              ),
            ),
          }),
        ),
        routing: Type.Optional(
          Type.Object({
            type: Type.Union([Type.Literal('direct'), Type.Literal('existing'), Type.Literal('new')]),
            departmentId: Type.Optional(Type.String()),
            departmentOnly: Type.Optional(Type.Boolean()),
            departmentSpec: Type.Optional(
              Type.Object({
                name: Type.String(),
                topic: Type.Optional(Type.String()),
                lead: Type.Optional(Type.String()),
                members: Type.Optional(Type.Array(Type.Any())),
              }),
            ),
          }),
        ),
      }),
      execute: async (_id, rawParams) => {
        // 假设并进 scope：目标契约不认 assumptions 字段，直接丢就白写了
        const params = foldAssumptions(rawParams);
        // ★ 汇总交卷轮硬拦（规格 §3.3）：只许如实汇报，不许再派活/接新任务
        if (isToolBlockedInSummaryTurn('accept_task', { summaryTurn: runner.isSummaryTurn?.(roomId, botId) })) {
          return { content: [{ type: 'text', text: SUMMARY_TURN_BLOCK_MESSAGE }], isError: true };
        }
        const submission = readManagedSubmission({ runner, taskRuns: store.taskRuns, roomId, botId, laneKey });

        // 受管上下文残缺：明确拒绝，不降级
        if (submission.kind === SUBMISSION.invalid) {
          return { content: [{ type: 'text', text: `这次执行不能接单：${submission.text}` }], isError: true };
        }

        // ---- 来源一：受管执行（已有 TaskRun）
        if (submission.kind === SUBMISSION.managed) {
          const parsed = parseIntake(params);
          if (!parsed.ok) {
            return { content: [{ type: 'text', text: `接单结构不合法：${parsed.text}` }], isError: true };
          }
          const out = await handleIntake({
            action: { type: ACTION.accept, intake: parsed.intake },
            submission,
            store,
            taskRuns: store.taskRuns,
            prepareSpec: makeSpecPreparer({ store, runner, health }),
          });
          if (!out.ok) {
            return { content: [{ type: 'text', text: `接单未完成：${out.text ?? out.code}` }], isError: true };
          }
          const say = {
            [INTAKE_OUTCOME.direct]: '这一件由你自己做。',
            [INTAKE_OUTCOME.existing]: '已交给部门负责人。',
            [INTAKE_OUTCOME.created]: out.createOnly ? '部门已建好，没有派发任务。' : '部门已就绪，目标已交给负责人。',
            [INTAKE_OUTCOME.skipped]: '这次不进执行。',
          }[out.outcome] ?? '已登记。';
          return {
            content: [{ type: 'text', text: say }],
            details: { outcome: out.outcome, departmentId: out.departmentId ?? null, leadBotId: out.leadBotId ?? null, createOnly: out.createOnly === true },
          };
        }

        // ---- 来源二：首次接单（本轮请求作用域）
        const scope = typeof requestScopeOf === 'function' ? requestScopeOf() : null;
        if (!scope) {
          return {
            content: [{ type: 'text', text: '这次没有可信的接单作用域，不能创建任务（不会改用其它执行身份）。' }],
            isError: true,
          };
        }

        const out = await admitFirstTask({
          store,
          taskRuns: store.taskRuns,
          receipts: receipts ?? requestReceipts(runner?.config?.dataDir ?? config.dataDir),
          scope,
          proposal: params,
          prepareSpec: makeSpecPreparer({ store, runner, health }),
        });
        if (!out.ok) {
          return {
            content: [{ type: 'text', text: `接单未完成：${out.text ?? out.code}` }],
            isError: true,
            details: { code: out.code ?? null, taskRunId: out.taskRunId ?? null },
          };
        }
        if (!out.accepted) {
          runner.setRequestDecision?.(roomId, botId, scope, out.kind === 'clarification' ? 'clarification' : 'answer');
          return {
            content: [{ type: 'text', text: out.text || '这次不需要执行。' }],
            details: { accepted: false, kind: out.kind, outcome: out.outcome },
          };
        }
        runner.setRequestDecision?.(roomId, botId, scope, 'accepted', { taskRunId: out.taskRunId });
        if (!out.createOnly && (out.outcome === 'created' || out.outcome === 'existing' || out.outcome === 'direct')) {
          runner.queueAdmittedTask?.(out.taskRunId);
        }
        const say = out.outcome === 'created'
          ? (out.createOnly ? '部门已建好，没有派发任务。' : '部门已就绪，目标已交给负责人。')
          : out.outcome === 'existing'
            ? '已交给部门负责人。'
            : out.outcome === 'direct'
              ? '这一件由你自己做。'
              : '已登记。';
        return {
          content: [{ type: 'text', text: out.duplicate ? '这个请求之前已经受理过，沿用它。' : say }],
          details: {
            accepted: true, duplicate: out.duplicate === true, taskRunId: out.taskRunId,
            outcome: out.outcome, departmentId: out.departmentId ?? null,
            leadBotId: out.leadBotId ?? null, createOnly: out.createOnly === true,
            budget: admissionBudget(),
          },
        };
      },
    }),
  ];
  return wanted;
}

export { INTAKE_OUTCOME };
