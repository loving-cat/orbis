/**
 * 上游临时故障（429 / 5xx / 熔断）不判死：快速重试用尽后进入**可恢复阻塞**。
 *   node tests/long-task-upstream.mjs
 *
 * 守三条：
 *   1. 快速重试（最多 10 次、几十秒）穿不过分钟级限流 → 排分钟级退避 + retryAt，
 *      `recoverableBlock: 'upstream'`，到期自动解阻并继续跑通；
 *   2. 重启恢复：退避**没到期**不许抢跑（以前任何 recoverableBlock 都立刻 clearBlocked）；
 *   3. 累计等超过 2 小时 → 转成真正的 blocked 给用户看，不再自动排。
 *
 * 用真实 TaskRunStore + 假执行器；退避阶梯注入成毫秒级，clock 可推进，不真等。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-longtask-up-'));
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
const { EVENT } = await import(src('tasks/task-contract.js'));
const { reduceTaskRun } = await import(src('tasks/task-reduce.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { decideRecovery, RECOVERY_STAGE } = await import(src('tasks/task-recovery.js'));
const { isUpstreamTransient } = await import(src('retry-policy.js'));

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
const room = store.createGroup({ name: '上游测试组', botIds: [chief.id], leadBotId: chief.id });
const taskRuns = store.taskRuns;

let seq = 0;
/** 把任务的快速重试额度直接置为用尽（否则要真等 10 轮各 1.5–12 秒）。 */
async function exhaustQuickRetries(id, count = 10) {
  await taskRuns.mutate(id, {
    mutate: (cur) => ({ ...cur, retry: { count, at: Date.now() } }),
  });
}

async function makeTask({ autonomous = true } = {}) {
  seq += 1;
  const id = 'tr_up' + seq;
  const requestId = 'rq_up' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: '上游抽风也要做完的活 ' + seq,
      verification: [{ id: 'c1', kind: 'artifact', description: '交一份文件', spec: { count: 100 } }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '测试：逐步确认',
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-up-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

const read = (id) => taskRuns.read(id)?.taskRun ?? taskRuns.read(id);

/** 父任务（自主）+ 一个子任务，子任务用来走上游退避。 */
async function makeParentWithChild() {
  const parentId = await makeTask();
  const parent = read(parentId);
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    goal: { requirement: '抓 60 条数据', verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }] },
    botId: chief.id,
  });
  assert.equal(out.ok, true, '建子任务应成功：' + (out.text ?? ''));
  return { parentId, childId: out.child.id };
}

/** 直接给某任务打上「上游可恢复阻塞」（等价于 scheduleUpstreamRetry 落盘后的样子）。 */
async function markUpstreamBlocked(taskRunId, { dueAt }) {
  const wrote = await taskRuns.mutate(taskRunId, {
    mutate: (cur) => {
      const out = reduceTaskRun(cur, {
        type: EVENT.blocked,
        revision: cur.revision,
        at: Date.now(),
        reason: '上游限流/临时故障，1 分钟后自动继续：429 上游限流',
        sequence: (cur.sequence ?? 0) + 1,
      });
      assert.equal(out.ok, true, '置为受阻应成功：' + (out.text ?? ''));
      return {
        ...out.taskRun,
        recoverableBlock: 'upstream',
        retryAt: dueAt,
        upstreamWait: { attempt: 1, waitedMs: 60_000, at: Date.now() },
        nextAction: null,
      };
    },
  });
  assert.equal(wrote.ok, true, '标记上游阻塞应成功：' + (wrote.text ?? wrote.code ?? ''));
}

/**
 * 造一个可推进的推进器：执行器按 `plan` 逐次返回结果（耗尽后一直用最后一个）。
 */
function makeSupervisor({ plan, ladder = [60_000], maxUpstreamWaitMs = 600_000, clockRef }) {
  let nth = 0;
  const step = async () => {
    const one = plan[Math.min(nth, plan.length - 1)];
    nth += 1;
    return one;
  };
  const sup = createTaskSupervisor({
    taskRuns,
    maxSteps: 8,
    execute: step,
    // 子任务（成员执行）走的也是同一套失败剧本 —— 否则测不到「子任务上游退避」
    executeMember: step,
    verify: async () => ({ passed: false, unmet: ['还没好'], needsReview: [], blocked: [] }),
    access: { stat: async () => ({ ok: false }), readText: async () => ({ ok: false }), resolveRef: () => null },
    clock: () => clockRef.now,
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
    upstreamLadder: ladder,
    maxUpstreamWaitMs,
  });
  return { sup, calls: () => nth };
}

/** 等推进器静下来（自带定时器不真等到期：靠 clock 推进 + notify） */
async function settle(sup, id, predicate, { clockRef, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, 120))]);
    const run = read(id);
    if (predicate(run)) return run;
    if (Date.now() > deadline) return run;
    await new Promise((r) => setTimeout(r, 120));
  }
}

const upstreamFailure = {
  ok: false,
  code: 'upstream_unavailable',
  text: '429 上游限流：Rate limit exceeded',
  status: 429,
};

// ---------------------------------------------------------------------------

await test('判定口径：429/5xx/熔断/网络算上游瞬时；401/403/402/额度不算', () => {
  assert.equal(isUpstreamTransient({ status: 429 }), true);
  assert.equal(isUpstreamTransient({ status: 503 }), true);
  assert.equal(isUpstreamTransient({ kind: 'breaker-open' }), true);
  assert.equal(isUpstreamTransient({ error: 'socket hang up' }), true);
  assert.equal(isUpstreamTransient({ status: 401 }), false);
  assert.equal(isUpstreamTransient({ status: 403 }), false);
  assert.equal(isUpstreamTransient({ status: 402 }), false);
  assert.equal(isUpstreamTransient({ kind: 'quota' }), false);
  assert.equal(isUpstreamTransient({ error: 'budget_exhausted' }), false);
});

await test('快速重试用尽 → recoverableBlock=upstream + retryAt（不是真阻塞）', async () => {
  const clockRef = { now: Date.now() };
  const id = await makeTask();
  await exhaustQuickRetries(id);
  const { sup, calls } = makeSupervisor({ plan: [upstreamFailure], clockRef });
  sup.notify(id);
  const run = await settle(sup, id, (r) => r?.recoverableBlock === 'upstream', { clockRef });
  sup.dispose();

  assert.equal(run.state, 'blocked', '状态如实是受阻（用户看得见）');
  assert.equal(run.recoverableBlock, 'upstream', '但要记成「等上游」而不是「需要人工确认」');
  assert.ok(Number.isFinite(run.retryAt), 'retryAt 必须落盘 —— block() 会清它，得显式传');
  assert.ok(run.retryAt > clockRef.now, '到期时间在未来');
  assert.match(String(run.flags?.blockedReason ?? ''), /上游限流|临时故障/);
  assert.match(String(run.flags?.blockedReason ?? ''), /自动继续/);
  assert.ok(calls() >= 1, '用尽快速重试后仍会真的执行一次，然后才转分钟级退避');
  assert.ok(
    (run.retry?.count ?? 0) >= 10,
    '快速重试计数不清零 —— 清掉的话下一轮又能白拿 10 次快速重试，分钟级退避永远轮不到',
  );
  assert.ok(run.upstreamWait?.attempt >= 1, '累计状态要落盘（重启不丢）');
});

await test('退避到期 → 自动解阻并继续跑通；跑通后累计清零', async () => {
  const clockRef = { now: Date.now() };
  const id = await makeTask();
  const okStep = {
    ok: true,
    text: '这一段做完了',
    work: { files: ['out/a.md'] },
  };
  const id0 = id;
  await exhaustQuickRetries(id0);
  const { sup, calls } = makeSupervisor({ plan: [upstreamFailure, okStep], clockRef });
  sup.notify(id);
  const blocked = await settle(sup, id, (r) => r?.recoverableBlock === 'upstream', { clockRef });
  assert.ok(Number.isFinite(blocked.retryAt));

  const callsBefore = calls();
  // 时间推到到期之后，再来一次唤醒（生产里是 setTimer 到点 notify）
  clockRef.now = blocked.retryAt + 1;
  sup.notify(id);
  const after = await settle(sup, id, (r) => (r?.recoverableBlock ?? null) === null, { clockRef });
  sup.dispose();

  assert.ok(calls() > callsBefore, '到期必须真的再跑一次，而不是只清掉阻塞');
  assert.equal(after.recoverableBlock ?? null, null, '解阻时要把可恢复标记清掉');
  assert.equal(after.upstreamWait ?? null, null, '跑通一段后上游退避累计要清零');
  assert.equal(after.retryAt ?? null, null, '解阻后不该留着旧的到期时间');
});

await test('重启恢复：退避没到期不解阻、不抢跑', () => {
  const now = 1_000_000;
  const run = {
    id: 'tr_x', state: 'blocked', revision: 3,
    recoverableBlock: 'upstream', retryAt: now + 60_000,
    attemptSlots: {}, attempts: [],
  };
  const { stages } = decideRecovery(run, { root: run, load: () => run, clock: () => now });
  const kinds = stages.map((s) => s.stage);
  assert.equal(kinds.includes(RECOVERY_STAGE.clearBlocked), false, '没到期不许提前解阻');
  const defer = stages.find((s) => s.stage === RECOVERY_STAGE.deferUpstream);
  assert.ok(defer, '应该只排一个「等它到期」的阶段');
  assert.equal(defer.dueAt, run.retryAt);
});

await test('重启恢复：退避已到期 → 正常解阻', () => {
  const now = 2_000_000;
  const run = {
    id: 'tr_y', state: 'blocked', revision: 3,
    recoverableBlock: 'upstream', retryAt: now - 1,
    attemptSlots: {}, attempts: [],
  };
  const { stages } = decideRecovery(run, { root: run, load: () => run, clock: () => now });
  assert.ok(stages.some((s) => s.stage === RECOVERY_STAGE.clearBlocked));
  assert.equal(stages.some((s) => s.stage === RECOVERY_STAGE.deferUpstream), false);
});

await test('累计等待超过上限 → 转成真正的阻塞（不再自动排）', async () => {
  const clockRef = { now: Date.now() };
  // 非自主任务：自主模式在阻塞后还会自己再排几次重试，这里要看的是「到上限就停」
  const id = await makeTask({ autonomous: false });
  await exhaustQuickRetries(id);
  const { sup } = makeSupervisor({
    plan: [upstreamFailure], ladder: [60_000], maxUpstreamWaitMs: 60_000, clockRef,
  });
  sup.notify(id);
  await settle(sup, id, (r) => r?.recoverableBlock === 'upstream', { clockRef });
  const first = read(id);
  assert.ok(Number.isFinite(first.retryAt), '前置：已经排了一次上游退避');

  // 造「已经等过好几轮、累计到达上限」：到期后再来一次上游失败就该放弃
  await taskRuns.mutate(id, {
    mutate: (cur) => ({
      ...cur,
      upstreamWait: { attempt: 5, waitedMs: 60_000, at: clockRef.now },
      retryAt: first.retryAt,
    }),
  });
  clockRef.now = first.retryAt + 1;
  sup.notify(id);
  const ended = await settle(
    sup,
    id,
    (r) => String(r?.flags?.blockedReason ?? '').includes('上游持续不可用'),
    { clockRef },
  );
  sup.dispose();

  assert.equal(ended.state, 'blocked');
  assert.equal(ended.recoverableBlock ?? null, null, '到上限就不再是「可恢复」');
  assert.equal(ended.upstreamWait ?? null, null, '到上限后不再累计上游等待');
  assert.match(String(ended.flags?.blockedReason ?? ''), /上游持续不可用/);
});

await test('审计：分钟级退避不像快速重试那样烧额度（retry.count 不累到上限）', async () => {
  const clockRef = { now: Date.now() };
  const id = await makeTask();
  await exhaustQuickRetries(id);
  const { sup } = makeSupervisor({ plan: [upstreamFailure], clockRef });
  sup.notify(id);
  const run = await settle(sup, id, (r) => r?.recoverableBlock === 'upstream', { clockRef });
  sup.dispose();

  assert.ok((run.retry?.count ?? 0) <= 11, `快速重试次数不该无限涨（实际 ${run.retry?.count}）`);
});

await test('★ 父子：子任务在等上游时，父任务不取消也不阻塞它', async () => {
  const clockRef = { now: Date.now() };
  const { parentId, childId } = await makeParentWithChild();
  // 故意不挂依赖门槛：父任务必须走到「子任务全部受阻？」那段判定
  // 才会碰上面这个坑（挂了门槛的话它在更早的分支就 return wait 了，测不出问题）
  // 子任务处于上游可恢复阻塞，但 `retryAt` 不在了（重启/旧记录清过时间的真实形态）。
  // 没有 retryAt 时 planNextAction 判它 blocked，父任务就会走到「子任务全部受阻？」
  // 那段 —— 坑就在那儿。
  await markUpstreamBlocked(childId, { dueAt: null });
  assert.equal(read(childId).recoverableBlock, 'upstream');
  assert.equal(read(childId).retryAt ?? null, null);

  const { sup } = makeSupervisor({ plan: [{ ok: true, text: '干别的', work: { files: ['x.md'] } }], clockRef });
  sup.notify(parentId);
  await settle(sup, parentId, (r) => (r?.childHandBacks ?? 0) > 0 || r?.state === 'blocked', { clockRef });
  const parent = read(parentId);
  const child = read(childId);
  sup.dispose();

  assert.equal(parent.childHandBacks ?? 0, 0, '自主父任务不许把还在等上游的子任务收回去重排');
  assert.notEqual(parent.state, 'blocked', '父任务也不该因为子任务在等上游就阻塞');
  assert.equal(child.state, 'blocked', '子任务保持等待，由其自己的定时器唤醒');
  assert.equal(child.recoverableBlock, 'upstream', '可恢复标记不能被父任务清掉');
});

await test('★ 父子：子任务退避耗尽转永久阻塞 → 父任务被叫醒并收回重排', async () => {
  const clockRef = { now: Date.now() };
  const { parentId, childId } = await makeParentWithChild();
  // 故意不挂依赖门槛：父任务要走到「子任务全部受阻」那段判定才看得出有没有被叫醒
  // 子任务：快速重试已用尽 + 累计已到上限 → 再失败一次就是永久阻塞
  await exhaustQuickRetries(childId);
  await taskRuns.mutate(childId, {
    mutate: (cur) => ({ ...cur, upstreamWait: { attempt: 5, waitedMs: 7_200_000, at: clockRef.now } }),
  });

  const { sup } = makeSupervisor({
    plan: [upstreamFailure],
    ladder: [60_000],
    maxUpstreamWaitMs: 60_000,
    clockRef,
  });
  sup.notify(childId);
  // 父任务被 notifyParent 叫醒后会把这块分工收回去（childHandBacks +1）
  const parent = await settle(sup, parentId, (r) => (r?.childHandBacks ?? 0) > 0, { clockRef });
  sup.dispose();

  assert.equal(parent.childHandBacks, 1, '父任务必须被叫醒并处理（不然它会永远悬在排队中）');
  assert.equal(read(childId).state, 'cancelled', '永久受阻的分工被收回重排');
  assert.equal(read(childId).recoverableBlock ?? null, null);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
