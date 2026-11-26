/**
 * 受控子任务 DAG（dependsOn + checkpoint）与根任务共享黑板。
 *   node tests/long-task-dag-blackboard.mjs
 *
 * ## 守的是什么
 *
 * 纯逻辑（`tasks/task-dag.js` / `tasks/task-blackboard.js`）：
 *   1. 依赖规范化：去重、计划步骤号解析、跨父/不存在/自依赖明确拒绝；
 *   2. 环检测：自环 / 二元环 / 三元环全部拒收，合法菱形 DAG 放行；
 *   3. 四种依赖状态：ready / waiting / checkpoint / upstream_failed；
 *   4. 上游上下文：只收已完成前置，标题+负责人+摘要+产物，字数硬控；
 *   5. 黑板：上限裁剪（约束不被时间挤掉）、幂等去重、渲染字数上限。
 *
 * 真账本（真 TaskRunStore + 假执行器，不 mock 存储）：
 *   6. 菱形 DAG 自动接力：C 依赖 [A, B] → 在 A、B 交付前绝不启动；
 *      A、B 都机械验收通过后，**零次唤醒负责人**就把 C 跑起来，
 *      且 C 拿到的提示词里有 A、B 的产物路径与摘要；
 *   7. checkpoint 把关：B 前置完成后停在 checkpoint、唤醒负责人把关，
 *      负责人放行后 B 才执行；
 *   8. 上游失败防死等：A 永久受阻、C 依赖 A → C 绝不运行，父任务不死等
 *      （自主模式交回负责人，非自主模式如实阻塞并说清是 A 的失败）；
 *   9. 共享黑板跨子任务传递：A 交付自动落黑板 + 显式写 constraint →
 *      同根后续成员 B 的提示词能读到；跨任务写入被拒（结构上无法指定目标）。
 *
 * ## 为什么每条都要
 *
 * DAG 与黑板的失效方式特别安静：下游不跑、或拿了半份前置产物开干，
 * 界面上都只显示「排队中」。所以每条都钉一个具体可观察量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dag-'));
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
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createChildTask } = await import(src('tasks/task-subtasks.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { reduceTaskRun } = await import(src('tasks/task-reduce.js'));
const { EVENT, STATE } = await import(src('tasks/task-contract.js'));
const DAG = await import(src('tasks/task-dag.js'));
const BOARD = await import(src('tasks/task-blackboard.js'));
const { normalizePlan, renderPlan } = await import(src('tasks/task-plan-tool.js'));
const { planStepIds, buildCheckpointApproveTool } = await import(src('tasks/task-member-tool.js'));
const { buildBlackboardTool } = await import(src('tasks/task-blackboard-tool.js'));
const { buildLeadPrompt, buildMemberPrompt } = await import(src('tasks/task-prompts.js'));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

await test('1. normalizeDependsOn：去重、丢空值、跨父/不存在/自依赖明确拒绝', () => {
  const out = DAG.normalizeDependsOn(['a1', 'a2', 'a1', '', null, 'zz', 'self1'], ['a1', 'a2'], { selfId: 'self1' });
  assert.deepEqual(out.ids, ['a1', 'a2'], '重复项必须去重');
  assert.deepEqual(out.rejected.map((r) => r.raw), ['zz', 'self1']);
  assert.equal(out.rejected[0].reason, 'unknown');
  assert.equal(out.rejected[1].reason, 'self');
});

await test('2. normalizeDependsOn：计划步骤号能翻成真实子任务 id', () => {
  const stepIds = new Map([['1', 'kid_1'], ['2', 'kid_2']]);
  const out = DAG.normalizeDependsOn([1, '2'], ['kid_1', 'kid_2'], { stepIds });
  assert.deepEqual(out.ids, ['kid_1', 'kid_2'], '负责人写“第 1、2 条”要落到真实子任务');
  assert.equal(out.rejected.length, 0);
});

await test('3. detectDependencyCycle：自环 / 二元环 / 三元环拒收，菱形放行', () => {
  assert.equal(DAG.detectDependencyCycle([{ id: 'a', dependsOn: ['a'] }]).ok, false, '自依赖必须拒');
  const two = DAG.detectDependencyCycle([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] },
  ]);
  assert.equal(two.ok, false);
  assert.deepEqual(two.cycle, ['a', 'b', 'a'], '报错要说清是哪几条互相等');
  const three = DAG.detectDependencyCycle([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] },
  ]);
  assert.equal(three.ok, false);
  assert.equal(three.cycle.length, 4, '三元环应回吐 a→b→c→a');
  const diamond = DAG.detectDependencyCycle([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ]);
  assert.equal(diamond.ok, true, '合法菱形 DAG 必须放行');
});

await test('4. dependencyStatus：四种状态各就各位', () => {
  const done = { id: 'a', state: STATE.completed };
  const running = { id: 'a', state: STATE.running };
  const upBlocked = { id: 'a', state: STATE.blocked, recoverableBlock: 'upstream' };
  const dead = { id: 'a', state: STATE.blocked };
  const gone = { id: 'a', state: STATE.cancelled };

  assert.equal(DAG.dependencyStatus({ id: 'k' }, []), 'ready', '无依赖就是 ready');
  assert.equal(DAG.dependencyStatus({ id: 'k', dependsOn: ['a'] }, [done]), 'ready');
  assert.equal(DAG.dependencyStatus({ id: 'k', dependsOn: ['a'] }, [running]), 'waiting');
  assert.equal(
    DAG.dependencyStatus({ id: 'k', dependsOn: ['a'] }, [upBlocked]), 'waiting',
    '可恢复阻塞是在自愈，不能判成上游失败',
  );
  assert.equal(
    DAG.dependencyStatus({ id: 'k', dependsOn: ['a'], checkpointBeforeRun: true }, [done]),
    'checkpoint',
    '前置完成但设了把关、还没放行 → checkpoint',
  );
  assert.equal(
    DAG.dependencyStatus(
      { id: 'k', dependsOn: ['a'], checkpointBeforeRun: true, checkpointApprovedAt: 1 }, [done],
    ),
    'ready',
    '放行之后就是 ready',
  );
  assert.equal(DAG.dependencyStatus({ id: 'k', dependsOn: ['a'] }, [dead]), 'upstream_failed');
  assert.equal(DAG.dependencyStatus({ id: 'k', dependsOn: ['a'] }, [gone]), 'upstream_failed');
  assert.equal(DAG.dependencyStatus({ id: 'k', dependsOn: ['ghost'] }, []), 'upstream_failed', '找不到的依赖不能当没有');
  // 一个死了、另一个还在跑：上游失败优先（下游绝不启动）
  assert.equal(
    DAG.dependencyStatus({ id: 'k', dependsOn: ['a', 'b'] }, [{ ...running, id: 'a' }, { ...dead, id: 'b' }]),
    'upstream_failed',
  );
});

await test('5. collectUpstreamContext：只收已完成前置，含摘要与产物，字数硬控', () => {
  const siblings = [
    {
      id: 'a',
      state: STATE.completed,
      owner: { leadBotId: 'b_fin' },
      goal: { requirement: '整理口径表' },
      delivery: { summary: '任务「整理口径表」已验收通过。\n交付物：out/caliber.md' },
      progress: { evidence: [{ kind: 'artifact', ref: 'out/caliber.md' }] },
    },
    { id: 'b', state: STATE.running, goal: { requirement: '还在跑的活' } },
  ];
  const text = DAG.collectUpstreamContext({ id: 'c', dependsOn: ['a', 'b'] }, siblings, {
    nameOf: (id) => (id === 'b_fin' ? '财务建模师' : ''),
  });
  assert.match(text, /整理口径表/);
  assert.match(text, /财务建模师/);
  assert.match(text, /out\/caliber\.md/, '产物路径必须出现，下游才能直接用');
  assert.equal(text.includes('还在跑的活'), false, '没完成的前置不该被写进上下文');
  assert.equal(text.includes('已验收通过。'), false, '回声行不该占字数');

  assert.equal(DAG.collectUpstreamContext({ id: 'c', dependsOn: ['b'] }, siblings), '', '没有可用前置就返回空串');

  const long = DAG.collectUpstreamContext({ id: 'c', dependsOn: ['a'] }, [
    { ...siblings[0], delivery: { summary: 'x'.repeat(4000) } },
  ], { maxChars: 200 });
  assert.ok(long.length <= 200, `上游上下文必须硬控在 200 字内，实际 ${long.length}`);
});

await test('6. 黑板：幂等去重（同一份交付不写两条）', () => {
  const first = BOARD.appendEntry(null, { kind: 'artifact', taskRunId: 't1', text: '交付了 out/a.md' }, { now: 1 });
  assert.equal(first.added, true);
  const again = BOARD.appendEntry(first.blackboard, { kind: 'artifact', taskRunId: 't1', text: '交付了 out/a.md' }, { now: 2 });
  assert.equal(again.added, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.blackboard.entries.length, 1);
  // 不同任务写下同一句话是两次独立的决定 → 各留一条
  const other = BOARD.appendEntry(first.blackboard, { kind: 'artifact', taskRunId: 't2', text: '交付了 out/a.md' }, { now: 3 });
  assert.equal(other.blackboard.entries.length, 2);
});

await test('7. 黑板：24 条上限，先淘汰最旧的非约束（约束不被时间挤掉）', () => {
  let board = BOARD.appendEntry(null, { kind: 'constraint', text: '金额一律用 addMoney', at: 1 }).blackboard;
  for (let i = 0; i < 30; i += 1) {
    board = BOARD.appendEntry(board, { kind: 'fact', text: '事实 #' + i, at: 10 + i }).blackboard;
  }
  assert.equal(board.entries.length, BOARD.BLACKBOARD_LIMITS.maxEntries, '必须有界');
  assert.ok(board.entries.some((e) => e.kind === 'constraint'), '约束不能被时间淘汰掉');
  assert.equal(board.entries.some((e) => e.text === '事实 #0'), false, '最旧的普通条目应被淘汰');
  assert.equal(board.entries.some((e) => e.text === '事实 #29'), true, '最新的必须还在');
});

await test('8. 黑板：渲染字数上限 + 约束优先', () => {
  let board = null;
  board = BOARD.appendEntry(board, { kind: 'constraint', text: '金额一律用 addMoney，不许浮点相加'.repeat(1), at: 1 }).blackboard;
  for (let i = 0; i < 20; i += 1) {
    board = BOARD.appendEntry(board, {
      kind: 'fact', text: '第 ' + i + ' 条事实：' + 'x'.repeat(200), at: 100 + i,
    }).blackboard;
  }
  const rendered = BOARD.renderBlackboard(board, { maxChars: 600 });
  assert.ok(rendered.length <= 600, `渲染必须硬控在 600 字内，实际 ${rendered.length}`);
  assert.match(rendered, /addMoney/, '约束优先渲染：被截也要先保住');
  assert.equal(BOARD.renderBlackboard(null), '', '空黑板不占提示词');
});

await test('9. 黑板：交付自动条含摘要与产物路径', () => {
  const entry = BOARD.artifactEntryOf({
    id: 't1',
    owner: { leadBotId: 'b_data' },
    goal: { requirement: '盘点数据集' },
    delivery: { summary: '任务「盘点数据集」已验收通过。\n交付物：out/clean.csv' },
    progress: { evidence: [{ kind: 'artifact', ref: 'out/clean.csv' }, { kind: 'artifact', ref: 'out/report.md' }] },
  }, { nameOf: () => '数据核验员', at: 7 });
  assert.equal(entry.kind, 'artifact');
  assert.equal(entry.taskRunId, 't1');
  assert.equal(entry.authorName, '数据核验员');
  assert.match(entry.text, /盘点数据集/);
  assert.match(entry.text, /out\/clean\.csv/);
  assert.equal(entry.ref, 'out/clean.csv');
  assert.equal(BOARD.artifactEntryOf({ id: 'x' }), null, '没有信息就不写空条目');
});

await test('10. 计划：dependsOn/checkpoint 能渲染出来，成环或越界依赖整份拒收', () => {
  const members = [{ id: 'b_1', name: '甲' }, { id: 'b_2', name: '乙' }];
  const ok = normalizePlan([
    { member: 'b_1', task: '先取数' },
    { member: 'b_2', task: '再建模', dependsOn: [1], checkpoint: true },
  ], members);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.steps[1].dependsOn, [1]);
  assert.equal(ok.steps[1].checkpoint, true);
  const text = renderPlan(ok.steps);
  assert.match(text, /等第 1 条完成/, '计划文本里必须看得到依赖');
  assert.match(text, /完成后先叫你把关/);

  const self = normalizePlan([{ member: 'b_1', task: 'x', dependsOn: [1] }], members);
  assert.equal(self.ok, false, '第 1 条依赖自己必须拒收');
  const forward = normalizePlan([
    { member: 'b_1', task: 'x', dependsOn: [2] },
    { member: 'b_2', task: 'y' },
  ], members);
  assert.equal(forward.ok, false, '依赖后面的条目 = 环或笔误，整份拒收');
});

await test('11. planStepIds：按“成员+任务正文”把步骤号对到真实子任务', () => {
  const parent = {
    id: 'p1', revision: 1,
    plan: { steps: [{ task: '取数', memberBotId: 'b_1' }, { task: '建模', memberBotId: 'b_2' }] },
  };
  const taskRuns = {
    listAll: () => ({
      taskRuns: [
        { id: 'p1_c1_aaa', parentTaskId: 'p1', parentRevision: 1, goal: { requirement: '取数' } },
        { id: 'p1_c1_bbb', parentTaskId: 'p1', parentRevision: 1, goal: { requirement: '建模' } },
      ],
    }),
  };
  const map = planStepIds(taskRuns, parent);
  assert.equal(map.get('1'), 'p1_c1_aaa');
  assert.equal(map.get('2'), 'p1_c1_bbb');
});

// ---------------------------------------------------------------------------
// 真账本
// ---------------------------------------------------------------------------

const chief = store.mainBot();
const members = [1, 2, 3].map((i) => store.createBot({ name: 'DAG成员' + i, persona: '写代码' }));
const room = store.createGroup({
  name: 'DAG 测试组',
  botIds: [chief.id, ...members.map((m) => m.id)],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot({ autonomous = false, requirement = '' } = {}) {
  seq += 1;
  const id = 'tr_dag' + seq;
  const requestId = 'rq_dag' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: requirement || '一件要按依赖顺序做的大活 #' + seq,
      verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-dag-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

let kidSeq = 0;
async function addKid(parentId, {
  botId, dependsOn = [], checkpointBeforeRun = false, requirement = '',
} = {}) {
  kidSeq += 1;
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    dependsOn,
    checkpointBeforeRun,
    goal: {
      requirement: requirement || '分工 #' + kidSeq,
      verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }],
    },
  });
  assert.equal(out.ok, true, '建子任务应成功：' + (out.text ?? ''));
  return out.child.id;
}

/** 执行记录：谁在什么时候开始/结束、拿到什么提示词。 */
function recorder() {
  const rec = { order: [], starts: new Map(), ends: new Map(), prompts: new Map(), leads: [] };
  rec.enter = (id, prompt) => {
    rec.order.push(id);
    rec.starts.set(id, Date.now());
    rec.prompts.set(id, prompt ?? '');
  };
  rec.leave = (id) => rec.ends.set(id, Date.now());
  return rec;
}

function makeSupervisor({
  execute, executeMember, rec = null, verify = null, logs = [],
} = {}) {
  const wrapLead = async (args) => {
    if (rec) rec.leads.push({ taskRunId: args?.taskRun?.id, prompt: args?.prompt ?? '', at: Date.now() });
    return execute(args);
  };
  const wrapMember = async (args) => {
    if (rec) {
      rec.enter(args?.taskRun?.id, args?.prompt);
      try {
        return await executeMember(args);
      } finally {
        rec.leave(args?.taskRun?.id);
      }
    }
    return executeMember(args);
  };
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 8,
    maxStallRounds: 2,
    execute: wrapLead,
    executeMember: execute ? wrapMember : null,
    verify: verify ?? (async () => ({ passed: true, reason: '测试验收通过：成员交了产物' })),
    access: { stat: async () => ({ ok: false }), readText: async () => ({ ok: false }), resolveRef: () => null },
    clock: () => Date.now(),
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

async function waitFor(sup, ids, predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), sleep(40)]);
    const runs = ids.map((id) => taskRuns.read(id).taskRun);
    if (predicate(runs)) return runs;
    if (Date.now() > deadline) return runs;
    await sleep(40);
  }
}

const memberOk = (id) => async () => ({ ok: true, stop: 'returned', appliedCompletion: true, artifacts: ['out/' + id + '.md'] });

await test('12. ★ 菱形 DAG：C 在 A、B 交付前绝不启动；两者通过后零次唤醒负责人自动接力', async () => {
  const rootId = await makeRoot({ requirement: '菱形 DAG' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '取数' });
  const b = await addKid(rootId, { botId: members[1].id, requirement: '定口径' });
  const c = await addKid(rootId, { botId: members[2].id, dependsOn: [a, b], requirement: '按取数与口径建模' });

  const rec = recorder();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'returned' }), // 负责人这一轮什么都不做
    executeMember: async (args) => {
      await sleep(40);
      return memberOk(args.taskRun.id)();
    },
    rec,
  });
  sup.notify(rootId);
  const runs = await waitFor(sup, [a, b, c], (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();

  for (const [i, run] of runs.entries()) {
    assert.equal(run.state, STATE.completed, `第 ${i + 1} 份分工应完成，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
  }
  assert.ok(
    rec.starts.get(c) >= rec.ends.get(a) && rec.starts.get(c) >= rec.ends.get(b),
    'C 必须等 A、B 都收口后才启动',
  );
  const cPrompt = rec.prompts.get(c) ?? '';
  assert.match(cPrompt, new RegExp(`out/${a}.md`), 'C 的提示词里要有 A 的产物路径');
  assert.match(cPrompt, new RegExp(`out/${b}.md`), 'C 的提示词里要有 B 的产物路径');
  assert.match(cPrompt, /前置子任务已经交付/, '前置交付块必须注入');
  // ★ “零次唤醒负责人”指的是**接力**不要花模型：C 必须在负责人第一次
  //   被叫起来之前就已经跑起来了（后面那次是根任务自己的验收/交付）。
  const firstLeadAt = rec.leads.length ? rec.leads[0].at : Infinity;
  assert.ok(
    rec.starts.get(c) < firstLeadAt,
    `C 应该在负责人被唤醒前就自动接力，实测 C 启动 ${rec.starts.get(c)} / 首次唤醒 ${firstLeadAt}`,
  );
  console.log(`    · 执行顺序：${rec.order.map((id) => id.slice(-6)).join(' → ')}；负责人模型调用 ${rec.leads.length} 次（均在接力之后）`);
});

await test('13. ★ checkpoint：前置完成后停在把关位，负责人放行后才执行', async () => {
  const rootId = await makeRoot({ requirement: '带把关的 DAG' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '先取数' });
  const b = await addKid(rootId, {
    botId: members[1].id, dependsOn: [a], checkpointBeforeRun: true, requirement: '按取数建模',
  });

  const rec = recorder();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember: async (args) => {
      await sleep(30);
      return memberOk(args.taskRun.id)();
    },
    rec,
  });
  sup.notify(rootId);
  await waitFor(sup, [a], (rs) => rs[0].state === STATE.completed);
  // 让父任务再推进几轮：把关位上的 B 不能自己跑
  await sleep(120);
  await sup.idle();
  const blockedB = taskRuns.read(b).taskRun;
  assert.notEqual(blockedB.state, STATE.completed, 'B 在放行前不能完成');
  assert.equal(rec.starts.has(b), false, 'B 在放行前绝不能开始');
  assert.ok(rec.leads.length >= 1, '把关必须唤醒负责人（一轮）');
  const leadPrompt = rec.leads.map((l) => l.prompt).join('\n---\n');
  assert.match(leadPrompt, /approve_subtask_checkpoint/, '提示词里必须告诉负责人怎么放行');
  assert.match(leadPrompt, /按取数建模/, '提示词里必须列出待放行的子任务');
  assert.match(leadPrompt, new RegExp(`out/${a}.md`), '提示词里必须带上待审的前置产物');

  const approved = await sup.approveCheckpointsOf(rootId, { botId: chief.id });
  assert.equal(approved.ok, true, '放行应成功：' + approved.text);
  assert.deepEqual(approved.approved, [b]);
  const after = await waitFor(sup, [b], (rs) => rs[0].state === STATE.completed);
  sup.dispose();
  assert.equal(after[0].state, STATE.completed, `放行后 B 应跑完，实际 ${after[0].state}`);
  assert.equal(taskRuns.read(b).taskRun.checkpointApprovedBy, chief.id, '要记下是谁放行的');
});

await test('14. ★ 上游失败防死等：A 永久受阻 + C 依赖 A → C 绝不运行，父任务交回负责人', async () => {
  const rootId = await makeRoot({ autonomous: true, requirement: '上游失败' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '会失败的那份' });
  const c = await addKid(rootId, { botId: members[1].id, dependsOn: [a], requirement: '依赖失败上游的下游' });
  // 让 A 永久受阻（不可恢复：没有 recoverableBlock）
  await taskRuns.mutate(a, {
    mutate: (cur) => {
      const out = reduceTaskRun(cur, {
        type: EVENT.blocked, revision: cur.revision, at: Date.now(), reason: '成员跑挂了', sequence: cur.sequence + 1,
      });
      return out.ok ? out.taskRun : null;
    },
  });

  const rec = recorder();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember: async (args) => memberOk(args.taskRun.id)(),
    rec,
  });
  sup.notify(rootId);
  const root = await waitFor(sup, [rootId], (rs) => (rs[0].childHandBacks ?? 0) >= 1);
  await sleep(120);
  await sup.idle();
  const finalRoot = taskRuns.read(rootId).taskRun;
  const finalC = taskRuns.read(c).taskRun;
  sup.dispose();

  assert.equal(rec.starts.has(c), false, 'C 依赖的上游已死，绝不能启动');
  assert.equal(finalC.state, STATE.cancelled, `C 应随上游一并收回，实际 ${finalC.state}`);
  assert.ok((finalRoot.childHandBacks ?? 0) >= 1, '自主模式必须交回负责人，而不是永久死等（旧码 stuck.every(blocked) 恒为 false）');
  const failures = finalRoot.childFailures ?? [];
  assert.ok(
    failures.some((f) => String(f.reason).includes('上游分工没完成')),
    `交回原因里要说清是上游失败：${JSON.stringify(failures.map((f) => f.reason))}`,
  );
  assert.ok(rec.leads.length >= 1, '交回之后负责人要被唤醒一次');
  assert.ok(root !== null);
});

await test('15. 非自主模式：上游永久不可恢复 → 父任务如实阻塞并说清是谁的失败', async () => {
  const rootId = await makeRoot({ autonomous: false, requirement: '非自主上游失败' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '会失败的那份' });
  const c = await addKid(rootId, { botId: members[1].id, dependsOn: [a], requirement: '等上游的下游' });
  await taskRuns.mutate(a, {
    mutate: (cur) => {
      const out = reduceTaskRun(cur, {
        type: EVENT.blocked, revision: cur.revision, at: Date.now(), reason: '鉴权失败', sequence: cur.sequence + 1,
      });
      return out.ok ? out.taskRun : null;
    },
  });
  const rec = recorder();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember: async (args) => memberOk(args.taskRun.id)(),
    rec,
  });
  sup.notify(rootId);
  const root = await waitFor(sup, [rootId], (rs) => rs[0].state === STATE.blocked, { timeoutMs: 8000 });
  sup.dispose();
  assert.equal(root[0].state, STATE.blocked, '非自主模式应如实阻塞父任务');
  assert.match(String(root[0].flags?.blockedReason ?? ''), /受阻|无法启动/, '原因里要说清卡在谁身上');
  assert.equal(rec.starts.has(c), false, 'C 绝不能启动');
});

await test('16. ★ 共享黑板：A 交付自动落板 + 显式约束 → B 的提示词能读到', async () => {
  const rootId = await makeRoot({ requirement: '黑板传递' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '先定口径' });

  const rec = recorder();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember: async (args) => {
      await sleep(20);
      return memberOk(args.taskRun.id)();
    },
    rec,
  });
  sup.notify(rootId);
  await waitFor(sup, [a], (rs) => rs[0].state === STATE.completed);

  // 显式写一条约束（等价于负责人或成员调用 task_blackboard）
  const written = BOARD.appendEntry(taskRuns.read(rootId).taskRun.blackboard, {
    kind: 'constraint',
    text: '金额一律用 addMoney，不许浮点相加',
    authorBotId: chief.id,
    authorName: '主控',
    taskRunId: a,
    at: Date.now(),
  });
  assert.equal(written.added, true);
  await taskRuns.mutate(rootId, {
    mutate: (cur) => ({ ...cur, blackboard: written.blackboard, updatedAt: Date.now() }),
  });

  // ★ B 在 A 完成之后才派：这时黑板上已经有 A 的产物与这条约束，
  //   才能确定性地验“后来的人读得到”。
  const b = await addKid(rootId, { botId: members[1].id, dependsOn: [a], requirement: '按口径建模' });
  sup.notify(rootId);

  const runs = await waitFor(sup, [b], (rs) => rs[0].state === STATE.completed);
  sup.dispose();
  assert.equal(runs[0].state, STATE.completed, `B 应跑完，实际 ${runs[0].state}`);

  const rootNow = taskRuns.read(rootId).taskRun;
  const boardText = BOARD.renderBlackboard(rootNow.blackboard);
  assert.match(boardText, /addMoney/, '黑板里应有那条约束');
  assert.match(boardText, /产物/, 'A 的交付应自动落成产物条目');
  const bPrompt = rec.prompts.get(b) ?? '';
  assert.match(bPrompt, /共享黑板/, 'B 的提示词必须注入黑板');
  assert.match(bPrompt, /addMoney/, 'B 必须读到全组约束');
  assert.match(bPrompt, /前置子任务已经交付/, 'B 必须读到前置交付块');
});

await test('17. 跨任务写入被拒：没有本任务的有效受管上下文就写不进去（且工具没有“指定目标”参数）', async () => {
  const rootId = await makeRoot({ requirement: '防越权串写' });
  const otherRootId = await makeRoot({ requirement: '别人的任务' });

  // 假 runner：上下文指向一个**不存在**的任务 → 受管上下文校验失败
  const runner = { currentTaskContext: () => ({ taskRunId: 'tr_not_exist', revision: 1, attemptId: 'a_x', botId: chief.id }) };
  const tool = buildBlackboardTool({ runner, store, roomId: room.id, botId: chief.id });
  const out = await tool.execute('call1', { kind: 'constraint', text: '越权写一条' });
  assert.equal(out.isError, true, '没有有效受管上下文必须拒绝');
  assert.equal(taskRuns.read(rootId).taskRun.blackboard, undefined, '被拒时不能写进任何黑板');

  // 结构上无法指定目标：参数里没有任何任务 id
  const paramNames = Object.keys(tool.parameters?.properties ?? {});
  assert.equal(paramNames.includes('taskRunId'), false, '黑板工具不能接受调用方指定任务');
  assert.equal(paramNames.includes('rootTaskId'), false);
  assert.deepEqual(paramNames.sort(), ['kind', 'ref', 'text']);
  assert.notEqual(taskRuns.read(otherRootId).taskRun.id, rootId);
});

await test('18. 放行工具：非负责人 / 非本任务子任务一律拒绝', async () => {
  const rootId = await makeRoot({ requirement: '放行权限' });
  const a = await addKid(rootId, { botId: members[0].id, requirement: '先取数' });
  const tool = buildCheckpointApproveTool({
    runner: { currentTaskContext: () => ({ taskRunId: rootId, revision: 1, attemptId: 'a_x', botId: members[0].id }) },
    store,
    roomId: room.id,
    botId: members[0].id, // 成员，不是负责人
  });
  const out = await tool.execute('call1', { childTaskRunId: a });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /负责人|受管任务|失效/);
});

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nlong-task-dag-blackboard：${passed}/${results.length} 通过`);
if (failed) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.err}`);
  process.exit(1);
}
process.exit(0);
