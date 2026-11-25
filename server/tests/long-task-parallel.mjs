/**
 * 受管子任务**真并发**（路线图第 1 步）。
 *   node tests/long-task-parallel.mjs
 *
 * 守的这六条（每条都对应一个「用户看到人都闲着 / 任务无缘无故受阻」的坑）：
 *   1. 1 个父任务 + 3 个不同成员的独立分工 → 真的同时在跑；
 *      旧码是 `for (const kid of liveKids) await runTask(kid)`，最大在途恒为 1，
 *      总耗时就等于三段相加；
 *   2. 同一个成员的两份分工不并发（一个 Bot 只有一个会话，同时派会撞
 *      「Agent is already processing」）；
 *   3. 同一 tick 抢同一份文件的两份分工不同时在途 —— `fileClaimBlocker` 只算
 *      「正在持有」的任务，看不见还没进 running 的兄弟，所以选批时就按声明路径错开；
 *   4. 根并发名额满 → 排队等名额，**绝不判死**；
 *      旧码把 `phase === 'reserved'` 一刀切 block()，子任务被永久打死成受阻；
 *   5. 上游熔断（`upstreamHealth = 0`）→ 并发自动降回 1（不放大失败）；
 *   6. 部分受阻 / 部分等上游：不误杀还在等上游的那份；两份都永久受阻才交回负责人。
 *
 * 用真实 TaskRunStore + 假执行器，不 mock 存储。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parallel-'));
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
const { EVENT } = await import(src('tasks/task-contract.js'));
const { admissionBudget } = await import(src('coordination/task-admission.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chief = store.mainBot();
// 4 个成员：部门里 5 个人 → 调度预算按人数算不会成为瓶颈，档位由根预算说了算
const members = [1, 2, 3, 4].map((i) => store.createBot({ name: '并发成员' + i, persona: '写代码' }));
const room = store.createGroup({
  name: '并发测试组',
  botIds: [chief.id, ...members.map((m) => m.id)],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot({ autonomous = false, concurrencyLimit = undefined, requirement = '' } = {}) {
  seq += 1;
  const id = 'tr_par' + seq;
  const requestId = 'rq_par' + seq;
  const budget = { maxRuns: null };
  if (concurrencyLimit !== undefined) budget.concurrencyLimit = concurrencyLimit;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget,
    goal: {
      requirement: requirement || '一件要分给几个成员同时做的大活 #' + seq,
      verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-par-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

let kidSeq = 0;
async function addKid(parentId, { botId, files = [], priority = 0, requirement = '' } = {}) {
  kidSeq += 1;
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    files,
    priority,
    goal: {
      requirement: requirement || '分工 #' + kidSeq,
      verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }],
    },
  });
  assert.equal(out.ok, true, '建子任务应成功：' + (out.text ?? ''));
  return out.child.id;
}

/** 并发计量：同时在途的最大数、同一个 Bot 同时在途的最大数。 */
function meter() {
  const m = { inflight: 0, max: 0, starts: 0, maxPerBot: 0, perBot: new Map() };
  m.enter = (botId) => {
    m.inflight += 1;
    m.starts += 1;
    m.max = Math.max(m.max, m.inflight);
    const n = (m.perBot.get(botId) ?? 0) + 1;
    m.perBot.set(botId, n);
    m.maxPerBot = Math.max(m.maxPerBot, n);
  };
  m.leave = (botId) => {
    m.inflight -= 1;
    m.perBot.set(botId, Math.max(0, (m.perBot.get(botId) ?? 1) - 1));
  };
  return m;
}

/** 假成员执行器：在途陪跑 `ms`，然后申请完成（带产物）。 */
function memberRunner(m, ms) {
  return async ({ botId }) => {
    m.enter(botId);
    try {
      await sleep(ms);
    } finally {
      m.leave(botId);
    }
    return { ok: true, stop: 'returned', appliedCompletion: true, artifacts: ['out/' + botId + '.md'] };
  };
}

function makeSupervisor({ execute, executeMember = null, verify = null, upstreamHealth = null, maxConcurrency = null, logs = [] } = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 8,
    maxStallRounds: 2,
    execute,
    executeMember,
    verify: verify ?? (async () => ({ passed: true, reason: '测试验收通过：成员交了产物' })),
    access: { stat: async () => ({ ok: false }), readText: async () => ({ ok: false }), resolveRef: () => null },
    upstreamHealth,
    maxConcurrency,
    clock: () => Date.now(),
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

/** 等一段条件成立（期间定期把控制权还给调度器），并把每次观察到的状态记下来。 */
async function waitFor(sup, ids, predicate, { timeoutMs = 20_000, onTick = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const seenStates = [];
  for (;;) {
    await Promise.race([sup.idle(), sleep(50)]);
    const runs = ids.map((id) => taskRuns.read(id).taskRun);
    for (const run of runs) {
      seenStates.push(run?.state);
      if (onTick) onTick(run);
    }
    if (predicate(runs)) return { runs, seenStates };
    if (Date.now() > deadline) return { runs, seenStates };
    await sleep(50);
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

/** 直接给某任务打上「上游可恢复阻塞」（等价于 scheduleUpstreamRetry 落盘后的样子）。 */
function markUpstreamBlocked(taskRunId, { dueAt }) {
  return taskRuns.mutate(taskRunId, {
    mutate: (cur) => {
      const out = reduceTaskRun(cur, {
        type: EVENT.blocked,
        revision: cur.revision,
        at: Date.now(),
        reason: '上游限流/临时故障，1 分钟后自动继续：429 上游限流',
        sequence: (cur.sequence ?? 0) + 1,
      });
      assert.equal(out.ok, true, '置为可恢复阻塞应成功：' + (out.text ?? ''));
      return {
        ...out.taskRun,
        recoverableBlock: 'upstream',
        retryAt: dueAt,
        upstreamWait: { attempt: 1, waitedMs: 60_000, at: Date.now() },
        nextAction: null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 0. 准入口径：新任务的根并发默认 4（不再是硬编码 1）
// ---------------------------------------------------------------------------

await test('0. 新任务的根并发默认 4，环境变量可收紧，非法值回落默认', () => {
  assert.equal(admissionBudget({}, null).concurrencyLimit, 4, '默认允许 4 份受管执行同时在跑');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '2' }, null).concurrencyLimit, 2);
  assert.equal(admissionBudget({}, { concurrencyLimit: 1 }).concurrencyLimit, 1, '部门上限可以压回串行');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: 'abc' }, null).concurrencyLimit, 4);
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '99' }, null).concurrencyLimit, 4, '超上限回落默认');
});

// ---------------------------------------------------------------------------
// 1. 真并发：三个不同成员的分工同时跑
// ---------------------------------------------------------------------------

await test('★ 1. 三个不同成员的分工真的同时跑（旧码最大在途恒为 1、耗时是三段相加）', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kidIds = [];
  for (let i = 0; i < 3; i += 1) kidIds.push(await addKid(rootId, { botId: members[i].id }));

  const WORK = 200;
  const m = meter();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'yielded', work: { files: 1 } }),
    executeMember: memberRunner(m, WORK),
  });
  const t0 = Date.now();
  sup.notify(rootId);
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'));
  const elapsed = Date.now() - t0;
  sup.dispose();

  for (const [i, run] of runs.entries()) {
    assert.equal(run.state, 'completed', `第 ${i + 1} 份分工应完成，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
  }
  assert.equal(m.max, 3, `三份分工应同时在途，实测最大并发 ${m.max}`);
  assert.equal(m.starts, 3, `每份分工只应执行一次，实测 ${m.starts} 次`);
  assert.ok(
    elapsed < WORK * 3,
    `并发后总耗时应明显小于串行的 ${WORK * 3}ms，实测 ${elapsed}ms`,
  );
  console.log(`    · 改后：最大在途 ${m.max}，总耗时 ${elapsed}ms（串行基线 ${WORK * 3}ms）`);
});

// ---------------------------------------------------------------------------
// 2. 同 Bot 互斥：一个成员只有一个会话
// ---------------------------------------------------------------------------

await test('★ 2. 同一个成员的两份分工不并发（撞同一个会话）', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const sameBot = members[0].id;
  const kidIds = [
    await addKid(rootId, { botId: sameBot }),
    await addKid(rootId, { botId: sameBot }),
  ];
  const m = meter();
  const sup = makeSupervisor({ execute: async () => ({ ok: true, stop: 'yielded' }), executeMember: memberRunner(m, 80) });
  sup.notify(rootId);
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'));
  sup.dispose();
  assert.equal(m.maxPerBot, 1, `同一个成员不能同时跑两份，实测 ${m.maxPerBot}`);
  for (const run of runs) assert.equal(run.state, 'completed', `两份分工都应完成，实际 ${run.state}`);
});

// ---------------------------------------------------------------------------
// 3. 同 tick 文件互斥：还没进 running 的兄弟也要错开
// ---------------------------------------------------------------------------

await test('★ 3. 两份分工声明同一个文件 → 不同时在途（fileClaimBlocker 看不见还没 running 的兄弟）', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kidIds = [
    await addKid(rootId, { botId: members[0].id, files: ['docs/shared-design.md'] }),
    await addKid(rootId, { botId: members[1].id, files: ['docs/shared-design.md'] }),
  ];
  const m = meter();
  const sup = makeSupervisor({ execute: async () => ({ ok: true, stop: 'yielded' }), executeMember: memberRunner(m, 80) });
  sup.notify(rootId);
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'));
  sup.dispose();
  assert.equal(m.max, 1, `抢同一个文件的两份活不能同时在途，实测最大并发 ${m.max}`);
  for (const run of runs) assert.equal(run.state, 'completed', `两份分工都应完成，实际 ${run.state}`);
});

// ---------------------------------------------------------------------------
// 4. 名额满 → 排队等，绝不判死
// ---------------------------------------------------------------------------

await test('★ 4. 根并发 2 时 4 份分工排队：在途 ≤ 2、绝不变成受阻、最后全部完成', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 2 });
  const kidIds = [];
  for (let i = 0; i < 4; i += 1) kidIds.push(await addKid(rootId, { botId: members[i].id }));

  const logs = [];
  const m = meter();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'yielded' }),
    executeMember: memberRunner(m, 120),
    logs,
    // 调度预算放宽到 5：让「超额请求」真的打到根预算的并发门上，而不是被调度器提前挡掉
    maxConcurrency: () => 5,
  });
  // 一次叫醒 4 份：名额只有 2 个，后两份必然撞门（旧码正是在这里把它们打死成受阻）
  const t0 = Date.now();
  for (const id of kidIds) sup.notify(id);
  const blocked = [];
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'), {
    onTick: (run) => { if (run?.state === 'blocked') blocked.push(run.id); },
  });
  const elapsed = Date.now() - t0;
  sup.dispose();

  assert.ok(m.max <= 2, `在途不能超过根并发 2，实测 ${m.max}`);
  assert.ok(m.max >= 2, `名额够时应该真的并行，实测最大在途只有 ${m.max}`);
  for (const run of runs) {
    assert.equal(run.state, 'completed', `排队的第 ${run.id} 份分工最后应完成，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
  }
  assert.deepEqual(blocked, [], '名额满只是排队，任何时刻都不该出现「受阻」');
  assert.ok(
    logs.some((l) => l.includes('并发名额已满')),
    '这次应真的撞到并发门（否则用例没验证到排队路径）：' + logs.filter((l) => l.includes('并发')).join(' | '),
  );
  // 撞门的那些排的是 BUSY_RETRY_MS（15s），能在 10s 内跑完说明是「名额一空就被叫醒」，
  // 而不是傻等满 15s 再重派。
  assert.ok(elapsed < 10_000, `排队的份应名额一空就跑，实测总耗时 ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// 4b. 名额被占住的那一刻：只排队，绝不判死
// ---------------------------------------------------------------------------

await test('★ 4b. 撞到并发门：不执行、不判死，名额空出后接着跑完', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 1 });
  const kidId = await addKid(rootId, { botId: members[0].id });
  // 先把根上唯一的名额占住（等价于「另一个执行正拿着名额在跑」）
  const root = taskRuns.read(rootId).taskRun;
  const slotKey = rootId + '::a_fake_1';
  const hold = await taskRuns.mutate(rootId, {
    mutate: (cur) => ({
      ...cur,
      attemptSlots: {
        [slotKey]: {
          attemptId: 'a_fake_1', taskRunId: rootId, botId: chief.id, revision: root.revision,
          phase: 'started', reservedAt: Date.now(), startedAt: Date.now(), settledAt: null,
        },
      },
    }),
  });
  assert.equal(hold.ok, true, '占住名额应成功：' + (hold.text ?? ''));

  const m = meter();
  const sup = makeSupervisor({ execute: async () => ({ ok: true, stop: 'yielded' }), executeMember: memberRunner(m, 40) });
  sup.notify(kidId);
  await sleep(400);
  const queued = taskRuns.read(kidId).taskRun;
  assert.equal(m.starts, 0, '名额被占住时不该真的跑起来');
  assert.notEqual(queued.state, 'blocked', `撞门不能判死，实际 ${queued.state}（${queued.flags?.blockedReason ?? ''}）`);
  assert.ok(Number(queued.retryAt) > Date.now(), `应排一个稍后的重派，实际 retryAt=${queued.retryAt}`);
  assert.equal(Number(queued.retry?.count ?? 0), 0, '排队不算失败次数');

  // 名额空出来 → 把到期时间拨到当下再叫醒，应一次就跑完
  await taskRuns.mutate(rootId, { mutate: (cur) => ({ ...cur, attemptSlots: {} }) });
  await taskRuns.mutate(kidId, { mutate: (cur) => ({ ...cur, retryAt: Date.now() - 1 }) });
  sup.notify(kidId);
  const { runs } = await waitFor(sup, [kidId], (rs) => rs.every((r) => r.state === 'completed'));
  sup.dispose();
  assert.equal(runs[0].state, 'completed', `名额空出后应跑完，实际 ${runs[0].state}（${runs[0].flags?.blockedReason ?? ''}）`);
});

// ---------------------------------------------------------------------------
// 4c. 内联收口释放名额 → 立刻唤醒等待中的兄弟
// ---------------------------------------------------------------------------

await test('★ 4c. 父任务内联收口释放名额 → 立刻叫醒等待中的兄弟（不再傻等 BUSY_RETRY_MS）', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 2 });
  // 先把两个名额里的一个占住：只占「预留」，还没开始跑（避免被判成结果未知）。
  // 这样父任务内联一次放两份进来时，必有一份撞门排队。
  const root = taskRuns.read(rootId).taskRun;
  const hold = await taskRuns.mutate(rootId, {
    mutate: (cur) => ({
      ...cur,
      attemptSlots: {
        [rootId + '::a_hold_1']: {
          attemptId: 'a_hold_1', taskRunId: rootId, botId: chief.id, revision: root.revision,
          phase: 'reserved', reservedAt: Date.now(), startedAt: null, settledAt: null,
        },
      },
    }),
  });
  assert.equal(hold.ok, true, '占住名额应成功：' + (hold.text ?? ''));
  const kidIds = [
    await addKid(rootId, { botId: members[0].id }),
    await addKid(rootId, { botId: members[1].id }),
  ];

  const m = meter();
  const sup = makeSupervisor({ execute: async () => ({ ok: true, stop: 'yielded' }), executeMember: memberRunner(m, 60) });
  const t0 = Date.now();
  sup.notify(rootId);
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'));
  const elapsed = Date.now() - t0;
  sup.dispose();

  for (const [i, run] of runs.entries()) {
    assert.equal(run.state, 'completed', `第 ${i + 1} 份分工应完成，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
  }
  // 撞门那份排的是 BUSY_RETRY_MS（15s）：能在 8s 内跑完，说明是同批收口就唤醒，
  // 而不是等定时器到点。这一句正好挡住「progressed 判在循环之前」那种死代码回归。
  assert.ok(elapsed < 8_000, `撞门的那份应被立刻唤醒，实测总耗时 ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// 5. 上游熔断 → 并发自动降回 1
// ---------------------------------------------------------------------------

await test('★ 5. 上游熔断（upstreamHealth=0）→ 并发自动降回 1 并正常跑完', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kidIds = [];
  for (let i = 0; i < 3; i += 1) kidIds.push(await addKid(rootId, { botId: members[i].id }));
  const m = meter();
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'yielded' }),
    executeMember: memberRunner(m, 60),
    upstreamHealth: () => 0,
  });
  sup.notify(rootId);
  const { runs } = await waitFor(sup, kidIds, (rs) => rs.every((r) => r.state === 'completed'));
  sup.dispose();
  assert.equal(m.max, 1, `上游不可用时并发必须降到 1，实测 ${m.max}`);
  for (const run of runs) assert.equal(run.state, 'completed', `降级后仍应跑完，实际 ${run.state}`);
});

// ---------------------------------------------------------------------------
// 6. 受阻语义：可恢复阻塞不算卡住；全永久受阻才交回
// ---------------------------------------------------------------------------

await test('★ 6. 一份等上游 + 一份永久受阻：父任务不误杀、也不判死', async () => {
  const rootId = await makeRoot();
  const upstreamKid = await addKid(rootId, { botId: members[0].id });
  const deadKid = await addKid(rootId, { botId: members[1].id });
  await markUpstreamBlocked(upstreamKid, { dueAt: Date.now() + 60_000 });
  await blockTask(deadKid, '超过 600s 未完成，已中断');

  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'yielded', work: { files: 1 } }),
    executeMember: async () => assert.fail('两份分工都在等，不该再派'),
  });
  sup.notify(rootId);
  await sleep(400);
  const parent = taskRuns.read(rootId).taskRun;
  const stillWaiting = taskRuns.read(upstreamKid).taskRun;
  sup.dispose();

  assert.ok(
    !['blocked', 'completed', 'cancelled'].includes(parent.state),
    `父任务不该被判死，实际 ${parent.state}（${parent.flags?.blockedReason ?? ''}）`,
  );
  assert.equal(stillWaiting.state, 'blocked');
  assert.equal(stillWaiting.recoverableBlock, 'upstream', '还在等上游的分工不能被取消');
});

await test('★ 6b. 两份都永久受阻 + 自主任务 → 交回负责人重新安排', async () => {
  const rootId = await makeRoot({ autonomous: true });
  const kidIds = [await addKid(rootId, { botId: members[0].id }), await addKid(rootId, { botId: members[1].id })];
  for (const id of kidIds) await blockTask(id, '超过 600s 未完成，已中断');

  const prompts = [];
  const sup = makeSupervisor({
    execute: async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true, stop: 'yielded', work: { files: 1 } };
    },
  });
  sup.notify(rootId);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && prompts.length === 0) {
    await Promise.race([sup.idle(), sleep(50)]);
    await sleep(50);
  }
  sup.dispose();

  const parent = taskRuns.read(rootId).taskRun;
  assert.equal(parent.childHandBacks, 1, '受阻的分工应被收回交回负责人一次');
  for (const id of kidIds) {
    assert.equal(taskRuns.read(id).taskRun.state, 'cancelled', '收回的分工应是「已取消」而不是留在受阻');
  }
  assert.equal(prompts.length >= 1, true, '负责人应被叫起来重新安排');
  assert.match(prompts[0], /已收回交给你重新安排/);
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`受管子任务并发：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
