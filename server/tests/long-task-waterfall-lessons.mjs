/**
 * C5 服务端：集群全景投影（时间线 + Token/费用）+ 候选经验通知。
 *   node tests/long-task-waterfall-lessons.mjs
 *
 * ## 守的是什么
 *
 * 全景面板是「用户据以做决策」的东西，所以口径错一点代价都很大：
 *   · Token 双计（根预算 + 子树求和相加）→ 用户以为额度用完了；
 *   · 没有单价却编一个价格 → 用户照着它算钱；
 *   · 列表接口带上完整瀑布流 → 每次列表都要算整棵树；
 *   · 时间轴算成负数 / 越界 → 甘特条画到屏幕外。
 *
 * 这里的用例全部打在 `task-waterfall.js` 的纯函数与 `task-transport.js`
 * 的投影上（不依赖真实 git/网络），外加候选经验的广播与 fail-closed 校验。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wf-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
});
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const WF = await import(src('tasks/task-waterfall.js'));
const { projectTaskRun } = await import(src('tasks/task-transport.js'));
const { createLessonReflector } = await import(src('lesson-reflect.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
    console.log(`✗ ${name}: ${err?.message || err}`);
  }
}

const settled = (startedAt, settledAt, input, output) => ({
  state: 'settled', startedAt, settledAt,
  result: { usage: { inputTokens: input, outputTokens: output } },
});

function makeRoot(extra = {}) {
  return {
    id: 'tr_root', state: 'running', createdAt: 1000, updatedAt: 9000,
    budget: { maxRuns: null, usedRuns: 3, maxTokens: 1000, usedTokens: 500, extraTokens: 100 },
    attempts: [settled(1000, 1500, 60, 40)],
    ...extra,
  };
}

function makeKid(id, extra = {}) {
  return {
    id, parentTaskId: 'tr_root', state: 'completed', createdAt: 1100,
    owner: { leadBotId: 'b_a' },
    goal: { requirement: '分工 ' + id },
    attempts: [settled(1200, 1800, 100, 50)],
    delivery: { at: 1800 },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑
// ---------------------------------------------------------------------------

await test('1. 空子树：返回空 items + 合法时间轴，绝不抛', () => {
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [], now: 20_000 });
  assert.deepEqual(out.items, []);
  assert.equal(out.total, 0);
  assert.equal(out.truncated, 0);
  assert.equal(out.originAt, 1000);
  assert.equal(out.endAt, 20_000, '还在跑就用 now 收口');
  assert.equal(out.telemetry.counts.childrenTotal, 0);
  assert.equal(out.telemetry.totalTokens, 500, '根预算优先');
  assert.equal(out.telemetry.totalTokensSource, 'root_budget');
});

await test('2. 多子任务：拓扑/开始时间排序 + 甘特区间（offset/duration 不为负）', () => {
  const kids = [
    makeKid('k2', { createdAt: 1500, attempts: [settled(1600, 2000, 10, 5)], delivery: { at: 2000 } }),
    makeKid('k1', { createdAt: 1100, attempts: [settled(1200, 1900, 20, 10)], delivery: { at: 1900 } }),
  ];
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: kids, now: 20_000 });
  assert.deepEqual(out.items.map((i) => i.id), ['k1', 'k2'], '按开始时间排序');
  for (const item of out.items) {
    assert.ok(item.durationMs >= 0, `duration 不能为负：${item.durationMs}`);
    assert.ok(item.offsetMs >= 0, `offset 不能为负：${item.offsetMs}`);
    assert.equal(item.offsetMs, item.startedAt - out.originAt);
  }
  assert.equal(out.durationMs, 20_000 - 1000);
});

await test('3. Token 聚合不双计；无单价时 costUsd/estimatedCostUsd 必须是 null', () => {
  const kids = [makeKid('k1'), makeKid('k2')];
  const noPrice = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: kids, now: 5000 });
  assert.equal(noPrice.telemetry.totalTokens, 500, '有根预算就只信根预算，不与子树相加');
  assert.equal(noPrice.telemetry.totalTokensSource, 'root_budget');
  assert.equal(noPrice.telemetry.estimatedCostUsd, null, '没有单价绝不编价格');
  assert.equal(noPrice.items[0].costUsd, null);
  // 子树求和仍单独给出（输入/输出分项）
  assert.equal(noPrice.telemetry.inputTokens, 60 + 100 + 100);
  assert.equal(noPrice.telemetry.outputTokens, 40 + 50 + 50);

  // 有单价才估算
  const priced = WF.buildTaskWaterfall({
    rootRun: makeRoot(),
    children: kids,
    now: 5000,
    costOf: ({ inputTokens, outputTokens }) => (inputTokens / 1000) * 3 + (outputTokens / 1000) * 15,
  });
  assert.ok(priced.telemetry.estimatedCostUsd > 0);
  assert.ok(priced.items.every((i) => typeof i.costUsd === 'number'));
});

await test('4. 缺根预算时不虚报：退回子树求和并标明口径', () => {
  const root = makeRoot({ budget: { maxRuns: null } });
  const out = WF.buildTaskWaterfall({ rootRun: root, children: [makeKid('k1')], now: 5000 });
  assert.equal(out.telemetry.totalTokensSource, 'attempt_sum');
  assert.equal(out.telemetry.totalTokens, 60 + 40 + 100 + 50, '根 + 子树的已结算用量');
  assert.equal(out.telemetry.budget.maxTokens, null);
  assert.equal(out.telemetry.budget.remainingTokens, null, '不限额度不是“剩 0”');
});

await test('5. byBot / byModel 聚合排序（Token 降序），byModel 认 lastDispatchMeta', () => {
  const kids = [
    makeKid('k1', { attempts: [settled(1200, 1800, 300, 100)], lastDispatchMeta: { modelOverride: 'cloud/opus', tier: 'strong', cloned: true, cloneId: 'k1' } }),
    makeKid('k2', { owner: { leadBotId: 'b_b' }, attempts: [settled(1200, 1800, 10, 5)], lastDispatchMeta: { tier: 'fast' } }),
  ];
  const out = WF.buildTaskWaterfall({
    rootRun: makeRoot(), children: kids, now: 5000, nameOf: (id) => ({ b_a: '甲', b_b: '乙' }[id] ?? ''),
  });
  assert.equal(out.telemetry.byBot[0].botId, 'b_a', '消耗多的排前面');
  assert.equal(out.telemetry.byBot[0].name, '甲');
  assert.equal(out.telemetry.byBot[0].clonedRuns, 1, '分身次数要单独标出来');
  assert.equal(out.telemetry.byModel[0].model, 'cloud/opus');
  assert.equal(out.telemetry.byModel.some((m) => m.model === 'default'), true, '没指定模型记成 default');
});

await test('6. C1–C4 字段完整投影：依赖/把关/Critic/分身/档位/Worktree', () => {
  const dep = makeKid('k0', { state: 'completed' });
  const kid = makeKid('k1', {
    // 等把关的活一定是「还没结束」的；已完成的子任务谈不上等放行
    state: 'queued',
    dependsOn: ['k0'],
    checkpointBeforeRun: true,
    criticState: { lastVerdict: 'failed', reworkCount: 2, maxRounds: 2, reviewerModel: 'critic-x' },
    criticFeedback: { defects: ['数值不对'], round: 2, maxRounds: 2 },
    lastDispatchMeta: { cloned: true, cloneId: 'k1', tier: 'strong', modelOverride: 'cloud/opus' },
    worktree: {
      status: 'conflict', branch: 'orbis/task/k1', mergedHead: null,
      conflictFiles: ['src/a.js'], filesChanged: [],
    },
  });
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [dep, kid], now: 5000 });
  const item = out.items.find((i) => i.id === 'k1');
  assert.deepEqual(item.dependsOn, ['k0']);
  assert.deepEqual(item.waitingOn, [], 'k0 已完成，不在「还在等」里');
  assert.equal(item.waitingCheckpoint, true, '等把关');
  assert.equal(item.checkpointApproved, false);
  assert.equal(item.critic.verdict, 'failed');
  assert.equal(item.critic.rounds, 2);
  assert.deepEqual(item.critic.defects, ['数值不对']);
  assert.equal(item.dispatch.cloned, true);
  assert.equal(item.dispatch.cloneId, 'k1');
  assert.equal(item.dispatch.tier, 'strong');
  assert.equal(item.dispatch.model, 'cloud/opus');
  assert.equal(item.worktree.status, 'conflict');
  assert.deepEqual(item.worktree.conflictFiles, ['src/a.js']);
  assert.equal(out.telemetry.counts.worktreeConflicts, 1);
  assert.equal(out.telemetry.counts.checkpointsPending, 1);
  assert.equal(out.telemetry.counts.criticReworks, 2);
});

await test('7. 超过 limit 要截断并报出还有多少', () => {
  const kids = Array.from({ length: 9 }, (_, i) => makeKid('k' + i, { createdAt: 1100 + i }));
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: kids, limit: 4, now: 5000 });
  assert.equal(out.items.length, 4);
  assert.equal(out.total, 9);
  assert.equal(out.truncated, 5, '必须告诉客户端还有 5 条没显示');
});

await test('8. projectBlackboard：只给安全摘要，倒序取最新 N 条', () => {
  const board = {
    entries: [
      { kind: 'constraint', authorName: '甲', text: '金额用 addMoney', ref: '', at: 1, id: 'bb_1', taskRunId: 'tr_x' },
      { kind: 'artifact', authorName: '乙', text: '交付 out/a.md', ref: 'out/a.md', at: 2, id: 'bb_2' },
      { kind: 'fact', authorName: '丙', text: '已合入主仓 abc', ref: '', at: 3, id: 'bb_3' },
    ],
  };
  const out = WF.projectBlackboard(board, { limit: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.text), ['已合入主仓 abc', '交付 out/a.md'], '最新的在前');
  assert.equal(out[1].ref, 'out/a.md');
  for (const entry of out) {
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'authorName', 'kind', 'ref', 'text'], '不带内部 id');
  }
  assert.deepEqual(WF.projectBlackboard(null), []);
});

// ---------------------------------------------------------------------------
// 2. transport 投影
// ---------------------------------------------------------------------------

await test('9. budget 补全 Token 维度；列表轻量 vs 详情完整', () => {
  const root = makeRoot();
  const kids = [makeKid('k1')];
  const light = projectTaskRun(root, { root, children: kids, nameOf: () => '甲' });
  assert.equal(light.budget.maxTokens, 1000);
  assert.equal(light.budget.usedTokens, 500);
  assert.equal(light.budget.extraTokens, 100);
  assert.equal(light.budget.remainingTokens, 500, 'maxTokens 已含 extraTokens：1000 - 500');
  assert.equal(light.budget.maxRuns, null);
  assert.equal(light.waterfall, undefined, '列表不该带完整瀑布流');
  assert.equal(light.telemetry, undefined);
  assert.equal(light.blackboard, undefined);
  assert.equal(light.telemetrySummary.totalTokens, 500, '但要有极小摘要');
  assert.equal(light.telemetrySummary.checkpointsPending, 0);

  const detail = projectTaskRun(root, { root, children: kids, nameOf: () => '甲', includeDetail: true });
  assert.ok(detail.waterfall, '详情必须带瀑布流');
  assert.equal(detail.waterfall.items.length, 1);
  assert.equal(detail.waterfall.items[0].botName, '甲');
  assert.ok(detail.telemetry, '详情必须带完整遥测');
  assert.equal(detail.telemetry.totalTokens, 500);
  assert.ok(Array.isArray(detail.blackboard), '详情必须带黑板');
});

await test('10. 老数据缺新字段零报错（向后兼容）', () => {
  const legacy = { id: 'tr_old', state: 'completed', revision: 1, sequence: 1, createdAt: 1, updatedAt: 2 };
  const out = projectTaskRun(legacy, { includeDetail: true });
  assert.equal(out.id, 'tr_old');
  assert.equal(out.budget.maxTokens, null);
  assert.equal(out.budget.remainingTokens, null);
  assert.deepEqual(out.waterfall.items, []);
  assert.equal(out.telemetry.totalTokens, 0);
  assert.deepEqual(out.blackboard, []);
  assert.equal(out.telemetrySummary.totalTokens, 0);
});

// ---------------------------------------------------------------------------
// 3. 候选经验：广播 + fail-closed
// ---------------------------------------------------------------------------

await test('11. 复盘生成候选时广播 lessons.changed；无证据候选仍被 fail-closed', async () => {
  const { store } = await import(src('store.js'));
  const { createCapabilityService } = await import(src('services/capability-service.js'));
  const svc = createCapabilityService({ store });

  // (a) 有证据的候选：可以启用
  const good = store.addLesson({
    cue: '用户要求先给结论', lesson: '先给结论再展开', evidence: [{ quote: '先说结论' }],
    status: 'candidate', roomId: 'r1',
  });
  assert.equal(good.error, undefined, '有证据的候选可以入库');
  const goodId = good.lesson.id;
  const activated = store.updateLesson(goodId, { status: 'active' });
  assert.equal(activated.error, undefined, '有证据的可以启用：' + String(activated.error ?? ''));
  assert.equal(activated.lesson?.status, 'active');

  // (b) 无证据的候选：启用必须被拦（fail-closed）
  const bad = store.addLesson({
    cue: '随便', lesson: '没有证据的做法', evidence: [], status: 'candidate', roomId: 'r1',
  });
  if (!bad.error) {
    const rejected = store.updateLesson(bad.lesson.id, { status: 'active' });
    assert.ok(rejected.error, '无证据的经验绝不启用（fail-closed）');
    // 服务层要把这类拒绝翻成 409（界面才能说清“先补证据”）
    if (svc) {
      const viaService = svc.updateLesson(bad.lesson.id, { status: 'active' });
      assert.equal(viaService.ok, false);
      assert.ok([400, 409].includes(viaService.status), `服务层状态码应是 400/409，实际 ${viaService.status}`);
    }
  }

  // (c) 广播契约：新增候选后必须 emit lessons.changed（带 count）
  const sourceText = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'lesson-reflect.js'), 'utf8');
  assert.match(sourceText, /lessons\.changed/, '必须广播 lessons.changed');
  assert.match(sourceText, /count:\s*added/, '事件要带新增条数');
});

await test('12. 控制通道：extend 支持 extraTokens；approve_checkpoint 校验归属并放行', async () => {
  const { store } = await import(src('store.js'));
  const { createTaskCommands } = await import(src('tasks/task-commands.js'));
  const calls = [];
  const runtime = {
    onExtendBudget: async (args) => { calls.push({ type: 'extend', ...args }); return { ok: true }; },
    approveCheckpoint: async (id, opts) => { calls.push({ type: 'approve', id, opts }); return { ok: true, approved: [id] }; },
  };
  const taskRuns = store.taskRuns;
  const root = {
    id: 'tr_wf_root', revision: 1, sequence: 0, state: 'paused_budget',
    request: { requesterId: 'local' }, budget: { maxTokens: 10, usedTokens: 10 },
  };
  const kid = {
    id: 'tr_wf_kid', parentTaskId: 'tr_wf_root', revision: 1, sequence: 0, state: 'queued',
    checkpointBeforeRun: true,
  };
  const byId = new Map([[root.id, root], [kid.id, kid]]);
  const commands = createTaskCommands({
    store,
    runner: { taskRuntime: runtime },
    taskRuns,
    commandDir: path.join(fixture, 'commands'),
  });
  const snapshotOf = (run) => ({ id: run.id, state: run.state, revision: run.revision, sequence: run.sequence, flags: run.flags ?? {} });

  const extended = await commands.handle({
    taskRunId: root.id,
    body: { commandId: 'cmd_extend_0001', type: 'extend', extraTokens: 500, expectedRevision: 1 },
    device: { id: 'dev' },
    findRun: (id) => byId.get(id) ?? null,
    snapshotOf,
  });
  assert.ok(extended.status < 400, `extend 应成功：${JSON.stringify(extended.body)}`);
  assert.equal(calls.find((c) => c.type === 'extend')?.extraTokens, 500, 'extraTokens 必须传给 onBudgetExtended');

  const approved = await commands.handle({
    taskRunId: root.id,
    body: { commandId: 'cmd_approve_0001', type: 'approve_checkpoint', childTaskRunId: kid.id, expectedRevision: 1 },
    device: { id: 'dev' },
    findRun: (id) => byId.get(id) ?? null,
    snapshotOf,
  });
  assert.ok(approved.status < 400, `approve_checkpoint 应成功：${JSON.stringify(approved.body)}`);
  const approveCall = calls.find((c) => c.type === 'approve');
  assert.equal(approveCall?.id, kid.id);
  assert.equal(approveCall?.opts?.by, 'user', 'App 里放行要记成用户');

  // 不是这个任务的子任务 → 拒绝
  const stranger = { id: 'tr_wf_other', parentTaskId: 'tr_other', revision: 1, sequence: 0, state: 'queued' };
  byId.set(stranger.id, stranger);
  const denied = await commands.handle({
    taskRunId: root.id,
    body: { commandId: 'cmd_approve_0002', type: 'approve_checkpoint', childTaskRunId: stranger.id, expectedRevision: 1 },
    device: { id: 'dev' },
    findRun: (id) => byId.get(id) ?? null,
    snapshotOf,
  });
  assert.equal(denied.status, 409, '不属于该任务的子任务要 409');
});

await test('13. ★ budgetTokensView：maxTokens 已含 extraTokens，不再重复加（P1-1）', () => {
  // extendRootBudget 把追加额度加进 maxTokens，所以剩余只能是 max - used
  const view = WF.budgetTokensView({ maxTokens: 1500, extraTokens: 500, usedTokens: 1600 });
  assert.equal(view.maxTokens, 1500);
  assert.equal(view.extraTokens, 500, 'extraTokens 只作为展示字段');
  assert.equal(view.remainingTokens, 0, `已用尽就该是 0（旧口径会算成 400），实际 ${view.remainingTokens}`);

  // 还有余量的情形
  assert.equal(WF.budgetTokensView({ maxTokens: 2000, extraTokens: 500, usedTokens: 1600 }).remainingTokens, 400);
  // 没设上限：null（"不限"不是"剩 0"）
  assert.equal(WF.budgetTokensView({ usedTokens: 999 }).remainingTokens, null);
  // 上层投影同口径
  const run = projectTaskRun({
    id: 'tr_b', revision: 1, sequence: 1, state: 'paused_budget',
    budget: { maxTokens: 1500, extraTokens: 500, usedTokens: 1600 },
  }, { includeDetail: true });
  assert.equal(run.budget.remainingTokens, 0);
  assert.equal(run.telemetry.budget.remainingTokens, 0);
});

await test('14. ★ criticTokens 只认真实复核用量，不拿成员执行 token 冒充（P1-2）', () => {
  const heavyMember = makeKid('k1', {
    attempts: [settled(1200, 1800, 4000, 1000)], // 成员自己跑了 5000 tokens
    criticState: { lastVerdict: 'passed', reworkCount: 1 }, // 没记 usedTokens
  });
  const none = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [heavyMember], now: 5000 });
  assert.equal(none.telemetry.criticTokens, 0, '没记复核用量就是 0，绝不是 5000');

  const recorded = makeKid('k2', {
    attempts: [settled(1200, 1800, 4000, 1000)],
    criticState: { lastVerdict: 'passed', reworkCount: 1, usedTokens: 300 },
  });
  const withCritic = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [recorded], now: 5000 });
  assert.equal(withCritic.telemetry.criticTokens, 300, `严格等于记录的复核用量，实际 ${withCritic.telemetry.criticTokens}`);
});

await test('15. ★ waitingCheckpoint 与推进器同判据；paused_budget 的 phase 是 needs_user（P1-3）', () => {
  const unsettled = makeKid('k_up', { state: 'running', attempts: [settled(1200, 1300, 1, 1)] });
  const cases = [
    // 已取消：谈不上"等把关"
    ['k_cancelled', makeKid('k_cancelled', { state: 'cancelled', checkpointBeforeRun: true }), false],
    // 上游还在跑：它在等前置，不是在等放行
    ['k_waiting', makeKid('k_waiting', { state: 'queued', checkpointBeforeRun: true, dependsOn: ['k_up'] }), false],
    // 上游永久失败：它在等一个不会来的前置
    ['k_failed', makeKid('k_failed', {
      state: 'queued', checkpointBeforeRun: true, dependsOn: ['k_up'],
    }), false],
    // 真·等放行：前置都完成（本例无前置）、没被放行
    ['k_gate', makeKid('k_gate', { state: 'queued', checkpointBeforeRun: true }), true],
  ];
  const blockers = makeKid('k_up', { state: 'running' });
  const kids = [blockers, ...cases.map(([, kid]) => kid)];
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: kids, now: 5000 });
  for (const [id, , expected] of cases) {
    const item = out.items.find((i) => i.id === id);
    assert.equal(item.waitingCheckpoint, expected, `${id} 的 waitingCheckpoint 应为 ${expected}`);
  }
  assert.equal(out.telemetry.counts.checkpointsPending, 1, '只有真正等放行的那一份计入');
  assert.equal(out.telemetry.counts.childrenTotal, kids.length);

  // 上游永久失败 → upstream_failed
  const dead = makeKid('k_dead', { state: 'blocked', attempts: [settled(1200, 1300, 1, 1)] });
  const downstream = makeKid('k_down', { state: 'queued', checkpointBeforeRun: true, dependsOn: ['k_dead'] });
  const failedOut = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [dead, downstream], now: 5000 });
  assert.equal(failedOut.items.find((i) => i.id === 'k_down').waitingCheckpoint, false);
  assert.equal(failedOut.telemetry.counts.checkpointsPending, 0);

  // phase：paused_budget 需要用户加额度 → needs_user（不是 paused）
  const paused = makeKid('k_paused', { state: 'paused_budget' });
  const pausedOut = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [paused], now: 5000 });
  assert.equal(pausedOut.items[0].phase, 'needs_user', '额度用尽要显示「追加额度」入口');
});

await test('16. ★ 超 limit 时聚合仍覆盖全量子任务（P2-1）', () => {
  const kids = Array.from({ length: 6 }, (_, i) => makeKid('k' + i, {
    createdAt: 1100 + i,
    attempts: [settled(1200 + i, 1800 + i, 10, 5)],
    lastDispatchMeta: { cloned: i % 2 === 0, tier: i % 2 === 0 ? 'strong' : 'fast', modelOverride: i % 2 === 0 ? 'cloud/opus' : null },
    criticState: { lastVerdict: 'passed', reworkCount: 1, usedTokens: 10 },
    worktree: i < 3
      ? { status: 'merged', branch: 'b' + i, filesChanged: ['f'] }
      : { status: 'conflict', branch: 'c' + i, conflictFiles: ['x'] },
  }));
  const out = WF.buildTaskWaterfall({
    rootRun: makeRoot(), children: kids, limit: 2, now: 5000, costOf: ({ inputTokens }) => inputTokens / 1000,
  });
  assert.equal(out.items.length, 2, 'items 截断到 limit');
  assert.equal(out.truncated, 4);
  // 但聚合与计数必须是**全量**的
  assert.equal(out.telemetry.counts.childrenTotal, 6);
  assert.equal(out.telemetry.counts.clonedRuns, 3, '分身次数要按 6 条算');
  assert.equal(out.telemetry.counts.worktreeMerged, 3);
  assert.equal(out.telemetry.counts.worktreeConflicts, 3);
  assert.equal(out.telemetry.counts.criticReworks, 6);
  assert.equal(out.telemetry.criticTokens, 60, '复核用量也按全量算');
  assert.equal(out.telemetry.byBot.length, 1);
  assert.equal(out.telemetry.byBot[0].runs, 6, 'byBot 的 runs 是 6 而不是 2');
  assert.equal(out.telemetry.byModel.find((m) => m.model === 'cloud/opus')?.runs, 3);
  assert.equal(typeof out.telemetry.estimatedCostUsd, 'number', '有单价时全量都算过才给总数');
});

await test('17. ★ 控制通道：同一 commandId 不同子任务 → 409；终态/跨版本放行 → 409（P1-4）', async () => {
  const { store } = await import(src('store.js'));
  const { createTaskCommands } = await import(src('tasks/task-commands.js'));
  const calls = [];
  const runtime = {
    approveCheckpoint: async (id, opts) => { calls.push({ id, opts }); return { ok: true }; },
    onExtendBudget: async () => ({ ok: true }),
  };
  const taskRuns = store.taskRuns;
  const root = { id: 'tr_cmd_root', revision: 2, sequence: 0, state: 'running', request: { requesterId: 'local' } };
  const kidA = { id: 'tr_cmd_a', parentTaskId: root.id, parentRevision: 2, revision: 2, sequence: 0, state: 'queued', checkpointBeforeRun: true };
  const kidB = { id: 'tr_cmd_b', parentTaskId: root.id, parentRevision: 2, revision: 2, sequence: 0, state: 'queued', checkpointBeforeRun: true };
  const staleKid = { id: 'tr_cmd_old', parentTaskId: root.id, parentRevision: 1, revision: 1, sequence: 0, state: 'queued', checkpointBeforeRun: true };
  const byId = new Map([[root.id, root], [kidA.id, kidA], [kidB.id, kidB], [staleKid.id, staleKid]]);
  const commands = createTaskCommands({ store, runner: { taskRuntime: runtime }, taskRuns, commandDir: path.join(fixture, 'commands2') });
  const snapshotOf = (run) => ({ id: run.id, state: run.state, revision: run.revision, sequence: run.sequence, flags: run.flags ?? {} });
  const handle = (body) => commands.handle({
    taskRunId: root.id, body, device: { id: 'dev' },
    findRun: (id) => byId.get(id) ?? null, snapshotOf,
  });

  // 同一 commandId、不同 childTaskRunId → 内容指纹不符
  await handle({ commandId: 'cmd_ck_0001', type: 'approve_checkpoint', childTaskRunId: kidA.id, expectedRevision: 2 });
  const conflict = await handle({ commandId: 'cmd_ck_0001', type: 'approve_checkpoint', childTaskRunId: kidB.id, expectedRevision: 2 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'COMMAND_CONFLICT');
  assert.equal(calls.length, 1, '第二个不能真的去放行');

  // 跨版本子任务 → 409 STALE_CHILD_REVISION
  const stale = await handle({ commandId: 'cmd_ck_0002', type: 'approve_checkpoint', childTaskRunId: staleKid.id, expectedRevision: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_CHILD_REVISION');

  // 服务层语义拒绝（终态 / 没有关卡位）也要回 409，不能 500
  runtime.approveCheckpoint = async () => ({ ok: false, code: 'terminal', text: '父任务已经结束' });
  const rejected = await handle({ commandId: 'cmd_ck_0003', type: 'approve_checkpoint', childTaskRunId: kidB.id, expectedRevision: 2 });
  assert.equal(rejected.status, 409, `语义拒绝应 409，实际 ${rejected.status}`);
  assert.equal(rejected.body.code, 'terminal');
});

await test('18. ★ approveCheckpoint 的语义拒绝都带 code（调用方据此回 409）', async () => {
  const { approveCheckpoint } = await import(src('tasks/task-checkpoint.js'));
  const taskRuns = {
    read: (id) => ({ status: 'found', taskRun: {
      tr_p: { id: 'tr_p', state: 'running', revision: 1 },
      tr_done_child: { id: 'tr_done_child', parentTaskId: 'tr_p', state: 'completed', checkpointBeforeRun: true },
      tr_no_gate: { id: 'tr_no_gate', parentTaskId: 'tr_p', state: 'queued' },
    }[id] }),
    mutate: async () => ({ ok: true }),
  };
  const notify = () => {};
  const missing = await approveCheckpoint({ taskRuns, childTaskRunId: 'tr_nope', notify });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');

  const terminal = await approveCheckpoint({ taskRuns, childTaskRunId: 'tr_done_child', notify });
  assert.equal(terminal.code, 'terminal');

  const noGate = await approveCheckpoint({ taskRuns, childTaskRunId: 'tr_no_gate', notify });
  assert.equal(noGate.code, 'not_checkpoint');
});

await test('19. ★ 甘特条从第一次派出执行算起（不是建档时刻）；排队段单独给；没开跑的不画执行条', () => {
  // 建档 1100，排队到 5000 才第一次派出，干到 6000
  const waited = makeKid('k_wait', { createdAt: 1100, attempts: [settled(5000, 6000, 10, 5)], delivery: { at: 6000 } });
  // 还在执行：从 2000 开跑，此刻 now = 9000
  const running = makeKid('k_run', { state: 'running', createdAt: 1500, attempts: [{ state: 'registered', startedAt: 2000 }], delivery: null });
  // 从没开跑：还在等前置
  const pending = makeKid('k_pend', { state: 'queued', createdAt: 1800, attempts: [], delivery: null });
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [waited, running, pending], now: 9000 });
  const byId = Object.fromEntries(out.items.map((i) => [i.id, i]));

  assert.equal(byId.k_wait.startedAt, 5000, '以前是 createdAt=1100：排队 3.9 秒被画成了执行');
  assert.equal(byId.k_wait.durationMs, 1000, '执行时长只算真正在干活的那段');
  assert.equal(byId.k_wait.queuedAt, 1100);
  assert.equal(byId.k_wait.queuedOffsetMs, 1100 - out.originAt);
  assert.equal(byId.k_wait.offsetMs, 5000 - out.originAt);

  assert.equal(byId.k_run.endedAt, null, '没结束就没有结束时间');
  assert.equal(byId.k_run.durationMs, 9000 - 2000, '执行中的条画到此刻');

  assert.equal(byId.k_pend.startedAt, null, '没开跑过就没有开始时间');
  assert.equal(byId.k_pend.offsetMs, null);
  assert.equal(byId.k_pend.durationMs, null);
  assert.equal(byId.k_pend.queuedAt, 1800);

  // 排序：开跑早的在前；没开跑的按建档时间
  assert.deepEqual(out.items.map((i) => i.id), ['k_pend', 'k_run', 'k_wait']);
});

await test('20. ★ 复核返工轮数：返工两轮后通过的活仍记 2 轮（通过时 reworkCount 已清零）', () => {
  // 与 writeCriticPassed 落盘的形状一致：rounds = 通过前打回的轮数，reworkCount 归零
  const passedAfterRework = makeKid('k_pass', {
    criticState: { lastVerdict: 'passed', reworkCount: 0, rounds: 2, maxRounds: 3 },
  });
  const failing = makeKid('k_fail', {
    state: 'running',
    criticState: { lastVerdict: 'failed', reworkCount: 1, rounds: 2 },
    criticFeedback: { defects: ['还差一张表'], round: 1 },
  });
  const clean = makeKid('k_clean', { criticState: { lastVerdict: 'passed', reworkCount: 0, rounds: 0 } });
  assert.equal(WF.criticOf(passedAfterRework).rounds, 2, '以前读 reworkCount → 0');
  assert.equal(WF.criticOf(failing).rounds, 1, '没通过时看当前这一轮的打回次数');
  assert.equal(WF.criticOf(clean).rounds, 0);
  const out = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [passedAfterRework, failing, clean], now: 9000 });
  assert.equal(out.telemetry.counts.criticReworks, 3);
  assert.equal(WF.telemetrySummaryOf(makeRoot(), [passedAfterRework, failing, clean]).criticReworks, 3);
});

await test('21. ★ 被计划挂起的活：瀑布流标出在等计划第几条，而不是只说「等把关」', () => {
  const held = makeKid('k_held', {
    state: 'queued', attempts: [], delivery: null,
    checkpointBeforeRun: true,
    planHold: { waitSteps: [{ index: 1, task: '取数' }], addedGate: true },
  });
  const item = WF.buildTaskWaterfall({ rootRun: makeRoot(), children: [held], now: 9000 }).items[0];
  assert.deepEqual(item.waitingPlanSteps, [1]);
  assert.equal(item.waitingCheckpoint, true, '仍然是一道可以放行的关（负责人可以决定不等）');
  const approved = makeKid('k_ok', { ...held, id: 'k_ok', checkpointApprovedAt: 5 });
  assert.deepEqual(WF.dependenciesOf(approved, [approved]).waitingPlanSteps, [], '放行过的不再显示在等');
});

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nlong-task-waterfall-lessons：${passed}/${results.length} 通过`);
try {
  fs.rmSync(fixture, { recursive: true, force: true });
} catch { /* 留给系统 */ }
if (failed) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.err}`);
  process.exit(1);
}
process.exit(0);
