/**
 * 长任务：推进器不能把「跑得久但在推进」误判成「卡住了」。
 *   node tests/long-task-supervisor.mjs
 *
 * 守的是这几条（每条都对应一次真实的中断/停下来问）：
 *   1. 两档停滞：每段都真实干活（改文件/出产物）→ 一直续跑；
 *      什么都没干 → 第一档照样拦住（防空转）；一直干活但目标从不推进 → 第二档兜底拦住；
 *   2. 让出分支不再双重计数（以前第 2 次没有「里程碑」的让出就被判死）；
 *   3. 子任务全部受阻：自主任务交回负责人重新安排（带着失败原因），
 *      非自主任务如实阻塞并说清谁卡住了（以前这段代码根本走不到，根任务永远「排队中」）；
 *   4. 续段提示、默认自主推进、私聊 direct 用「亲手做完」的提示词。
 *
 * 用真实 TaskRunStore + 假执行器，不 mock 存储。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-longtask-'));
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
const { createTaskSupervisor, bumpStall, workDoneBy } = await import(src('tasks/task-supervisor.js'));
const { reduceTaskRun } = await import(src('tasks/task-reduce.js'));
const { EVENT } = await import(src('tasks/task-contract.js'));
const { buildLeadPrompt, buildMemberPrompt, continuationNote, AUTONOMY_RULE } = await import(src('tasks/task-prompts.js'));
const { resolveAutonomy, detectAutonomy } = await import(src('tasks/task-autonomy.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const chief = store.mainBot();
const member = store.createBot({ name: '长任务成员', persona: '写代码' });
const room = store.createGroup({
  name: '长任务测试组',
  botIds: [chief.id, member.id],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeTask({ autonomous = false } = {}) {
  seq += 1;
  const id = 'tr_long' + seq;
  const requestId = 'rq_long' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: '一件要跑很多段的长任务 ' + seq,
      verification: [{ id: 'c1', kind: 'artifact', description: '交一份文件', spec: { count: 100 } }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-long-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

function makeSupervisor({ execute, executeMember = null, maxStallRounds = 2, maxMilestoneRounds = 12 } = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 8,
    maxStallRounds,
    maxMilestoneRounds,
    execute,
    executeMember,
    verify: async () => ({ passed: false, unmet: ['还没好'], needsReview: [], blocked: [] }),
    access: { stat: async () => ({ ok: false }), readText: async () => ({ ok: false }), resolveRef: () => null },
    clock: () => Date.now(),
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

/** 等推进器停下来（跨过让出续行的 1s 定时器），直到任务进入期望状态或超时。 */
async function waitUntil(sup, id, predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, 150))]);
    const run = taskRuns.read(id).taskRun;
    if (predicate(run)) return run;
    if (Date.now() > deadline) return run;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function blockTask(id, reason) {
  return taskRuns.mutate(id, {
    mutate: (cur) => {
      const out = reduceTaskRun(cur, {
        type: EVENT.blocked, revision: cur.revision, at: Date.now(), reason, sequence: cur.sequence + 1,
      });
      assert.equal(out.ok, true, '置为受阻应成功：' + (out.text ?? ''));
      return out.taskRun;
    },
  });
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑：两档停滞计数 / 真实干活判定
// ---------------------------------------------------------------------------

await test('bumpStall：干了活只清第一档，目标签名不变第二档照样涨', () => {
  const base = { revision: 1, progress: { evidence: [], unmet: [] }, openGates: [], attempts: [] };
  const first = bumpStall({ ...base, stall: null }, { didWork: true });
  assert.deepEqual([first.rounds, first.milestoneRounds], [0, 0], '第一次总是清零（签名从无到有）');
  const second = bumpStall({ ...base, stall: first }, { didWork: true });
  assert.deepEqual([second.rounds, second.milestoneRounds], [0, 1]);
  const idle = bumpStall({ ...base, stall: second }, { didWork: false });
  assert.deepEqual([idle.rounds, idle.milestoneRounds], [1, 2], '没干活两档一起涨');
  const moved = bumpStall({ ...base, progress: { evidence: [], unmet: ['少了一项'] }, stall: idle }, { didWork: false });
  assert.deepEqual([moved.rounds, moved.milestoneRounds], [0, 0], '目标推进（缺项变化）两档都清零');
});

await test('bumpStall：旧记录没有 milestoneRounds 时按 rounds 起算（升级不清零）', () => {
  const base = { revision: 1, progress: { evidence: [], unmet: [] }, openGates: [], attempts: [] };
  const sig = bumpStall({ ...base, stall: null }).lastSignature;
  const next = bumpStall({ ...base, stall: { rounds: 3, lastSignature: sig } }, { didWork: true });
  assert.equal(next.milestoneRounds, 4);
  assert.equal(next.rounds, 0);
});

await test('workDoneBy：只认运行层事实（改了文件 / 登记了产物），不认模型自述', () => {
  assert.equal(workDoneBy(null), false);
  assert.equal(workDoneBy({ ok: true, text: '我改好了' }), false, '只说不算');
  assert.equal(workDoneBy({ work: { files: 3 } }), true);
  assert.equal(workDoneBy({ artifacts: ['out/report.md'] }), true);
  assert.equal(workDoneBy({ attemptEvent: { attempt: { artifacts: ['a.csv'] } } }), true);
  assert.equal(workDoneBy({ work: { files: 0 }, artifacts: [] }), false);
});

// ---------------------------------------------------------------------------
// 2. 推进器：让出续跑的边界
// ---------------------------------------------------------------------------

await test('★ 每段都真实干活 → 远超旧上限地续跑，直到第二档兜底才停', async () => {
  const id = await makeTask();
  let execs = 0;
  const sup = makeSupervisor({
    maxStallRounds: 2,
    maxMilestoneRounds: 5,
    execute: async () => {
      execs += 1;
      return { ok: true, stop: 'yielded', work: { files: 2 } };
    },
  });
  sup.notify(id);
  const run = await waitUntil(sup, id, (r) => r.state === 'blocked');
  sup.dispose();
  assert.equal(run.state, 'blocked', '最终应被第二档兜底拦住，而不是无限跑');
  assert.ok(execs > 3, `每段都在干活时不能第 2~3 段就判死（旧行为），实际只跑了 ${execs} 段`);
  assert.equal(execs, 6, `第二档上限 5：首段建立基线 + 5 段无里程碑 = 6 段，实际 ${execs}`);
  assert.match(run.flags.blockedReason, /在干活.*目标一直没推进/);
});

await test('★ 什么都没干的让出 → 第一档照样拦住（防空转不放松）', async () => {
  const id = await makeTask();
  let execs = 0;
  const sup = makeSupervisor({
    maxStallRounds: 2,
    maxMilestoneRounds: 50,
    execute: async () => {
      execs += 1;
      return { ok: true, stop: 'yielded' };
    },
  });
  sup.notify(id);
  const run = await waitUntil(sup, id, (r) => r.state === 'blocked');
  sup.dispose();
  assert.equal(run.state, 'blocked');
  assert.ok(execs <= 3, `空转必须很快被拦住，实际跑了 ${execs} 段`);
  assert.match(run.flags.blockedReason, /既没推进目标、也没改动任何东西/);
});

await test('★ 正常返回但没到可验收、这一段改了文件 → 接着推进，不判「没有产出」', async () => {
  const id = await makeTask();
  let execs = 0;
  const sup = makeSupervisor({
    maxStallRounds: 2,
    maxMilestoneRounds: 3,
    execute: async () => {
      execs += 1;
      return { ok: true, stop: 'returned', work: { files: 1 } };
    },
  });
  sup.notify(id);
  const run = await waitUntil(sup, id, (r) => r.state === 'blocked');
  sup.dispose();
  assert.ok(execs >= 3, `写代码这类活一段没写完不该第一段就停，实际 ${execs} 段`);
  assert.doesNotMatch(run.flags.blockedReason ?? '', /没有产出可核验的交付/);
});

// ---------------------------------------------------------------------------
// 3. 子任务全部受阻：不再永远「排队中」
// ---------------------------------------------------------------------------

async function parentWithBlockedChild({ autonomous }) {
  const parentId = await makeTask({ autonomous });
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    goal: { requirement: '抓 60 条数据', verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }] },
    botId: member.id,
  });
  assert.equal(out.ok, true, out.text ?? '');
  assert.equal(out.child.flags.autonomous, autonomous, '子任务应继承整件事的推进方式');
  const blocked = await blockTask(out.child.id, '超过 600s 未完成，已中断');
  assert.equal(blocked.ok, true);
  return { parentId, childId: out.child.id };
}

await test('★ 非自主：子任务全部受阻 → 根任务如实受阻并说清谁卡住了（以前永远停在排队中）', async () => {
  const { parentId } = await parentWithBlockedChild({ autonomous: false });
  const sup = makeSupervisor({ execute: async () => assert.fail('负责人不该被叫起来') });
  sup.notify(parentId);
  const run = await waitUntil(sup, parentId, (r) => r.state === 'blocked', { timeoutMs: 5_000 });
  sup.dispose();
  assert.equal(run.state, 'blocked', `根任务应受阻，实际 ${run.state}`);
  assert.match(run.flags.blockedReason, /长任务成员受阻/);
  assert.match(run.flags.blockedReason, /600s/);
});

await test('★ 自主：子任务全部受阻 → 收回交给负责人重新安排，负责人看得到失败原因', async () => {
  const { parentId, childId } = await parentWithBlockedChild({ autonomous: true });
  const prompts = [];
  const sup = makeSupervisor({
    execute: async ({ prompt }) => {
      prompts.push(prompt);
      // 负责人这一段自己把活干了（改了文件）
      return { ok: true, stop: 'yielded', work: { files: 1 } };
    },
  });
  sup.notify(parentId);
  await waitUntil(sup, parentId, () => prompts.length >= 1, { timeoutMs: 5_000 });
  sup.dispose();
  const child = taskRuns.read(childId).taskRun;
  const parent = taskRuns.read(parentId).taskRun;
  assert.equal(child.state, 'cancelled', '受阻的分工应被收回');
  assert.equal(parent.childHandBacks, 1);
  assert.equal(parent.childFailures?.[0]?.name, '长任务成员');
  assert.ok(prompts.length >= 1, '负责人应被叫起来重新安排');
  assert.match(prompts[0], /已收回交给你重新安排/);
  assert.match(prompts[0], /600s/, '负责人要看到失败原因，才能换人或拆小');
});

// ---------------------------------------------------------------------------
// 4. 提示词与默认自主
// ---------------------------------------------------------------------------

await test('续段提示：上一段让出 → 告诉它从断点接着做；被中断 → 说明不是它的错', () => {
  const ledger = (stop, reason = '') => ({ attempts: [{ state: 'settled', result: { stop, reason } }] });
  assert.equal(continuationNote(ledger('returned')), '');
  assert.equal(continuationNote({ attempts: [] }), '');
  const slice = continuationNote(ledger('yielded'), { autonomous: true });
  assert.match(slice, /从断点继续/);
  assert.match(slice, /不需要问用户要不要继续/);
  assert.match(continuationNote(ledger('yielded', '服务重启，执行被中断')), /被中断/);
});

await test('私聊 direct（主控亲自干）用「亲手做完」，不叫它去派给并不存在的部门成员', () => {
  const run = { goal: { requirement: '整理目录' }, owner: { roomKind: 'dm' }, flags: { autonomous: true } };
  const text = buildLeadPrompt({ phase: 'plan', taskRun: run });
  assert.match(text, /亲手做完/);
  assert.doesNotMatch(text, /派给部门成员/);
  assert.ok(text.includes(AUTONOMY_RULE));
});

await test('成员提示词：自主推进时也带上「拿不准先按合理假设推进」的规矩', () => {
  const child = { goal: { requirement: '抓数据' } };
  assert.ok(buildMemberPrompt({ childTaskRun: child, autonomous: true }).includes(AUTONOMY_RULE));
  assert.ok(!buildMemberPrompt({ childTaskRun: child }).includes(AUTONOMY_RULE));
});

await test('★ 默认自主推进；用户明确说「先问我」才逐步确认', () => {
  assert.equal(resolveAutonomy('帮我调研一下开源 bot 项目').autonomous, true, '没说就默认自主');
  assert.equal(resolveAutonomy('改之前先问我一下').autonomous, false);
  assert.equal(resolveAutonomy('每一步都要跟我确认').autonomous, false);
  assert.equal(resolveAutonomy('方案先给我看，确认之后再动手').autonomous, false);
  assert.equal(resolveAutonomy('一直干到有结果，不用问我').autonomous, true);
  assert.equal(resolveAutonomy('帮我调研', { defaultAutonomous: false }).autonomous, false, '开关可退回旧行为');
});

await test('「先问我」的识别不误伤普通句子（默认自主后误判代价变大）', () => {
  assert.equal(detectAutonomy('代码风格要和我现有的保持一致').reason, '', '「要和我」后面不是沟通动词，不算先问我');
  assert.equal(resolveAutonomy('代码风格要和我现有的保持一致').autonomous, true);
  assert.equal(detectAutonomy('做完要跟我汇报一下').autonomous, false);
});

await test('任务卡开关：从任意一层切换都落在根上，整棵任务树跟着变；已结束的任务拒绝', async () => {
  const { createTaskRuntime } = await import(src('tasks/task-runtime.js'));
  const parentId = await makeTask({ autonomous: true });
  const parent = taskRuns.read(parentId).taskRun;
  const kid = await createChildTask({
    taskRuns, parentTaskRun: parent, botId: member.id,
    goal: { requirement: '子活', verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }] },
  });
  assert.equal(kid.ok, true, kid.text ?? '');
  const runtime = createTaskRuntime({
    taskRuns,
    runner: { store, isBusy: () => false },
    routeOf: () => ({ roomId: room.id, botId: chief.id, kind: 'group' }),
    emit: () => {},
  });
  try {
    const off = await runtime.onSetAutonomy({ taskRunId: kid.child.id, autonomous: false });
    assert.equal(off.ok, true, off.text);
    assert.equal(taskRuns.read(parentId).taskRun.flags.autonomous, false, '根任务要跟着变（推进器以根为准）');
    assert.equal(taskRuns.read(kid.child.id).taskRun.flags.autonomous, false);
    const on = await runtime.onSetAutonomy({ taskRunId: parentId, autonomous: true });
    assert.equal(on.ok, true);
    assert.equal(taskRuns.read(kid.child.id).taskRun.flags.autonomous, true);

    await taskRuns.mutate(parentId, {
      mutate: (cur) => reduceTaskRun(cur, {
        type: EVENT.cancelled, revision: cur.revision, at: Date.now(), reason: '测试', sequence: cur.sequence + 1,
      }).taskRun,
    });
    const late = await runtime.onSetAutonomy({ taskRunId: parentId, autonomous: false });
    assert.equal(late.ok, false);
    assert.equal(late.code, 'terminal');
  } finally {
    runtime.supervisor.dispose?.();
  }
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`长任务推进：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
