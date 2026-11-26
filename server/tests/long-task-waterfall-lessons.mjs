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
  const dep = makeKid('k0', { state: 'running' });
  const kid = makeKid('k1', {
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
  assert.deepEqual(item.waitingOn, ['k0'], '前置还没完成要标出来');
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
  assert.equal(light.budget.remainingTokens, 600, '1000 + 100 - 500');
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
  const events = [];

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
  void events;
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
