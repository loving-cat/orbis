/**
 * T6 长任务护栏：不可恢复错误快停 + 根任务可选 maxTokens 预算。
 *   node tests/long-task-guardrails.mjs
 *
 * 守的这几条（每条都对应一笔实打实的空转或一次「预算形同虚设」）：
 *   1. 401/402/配置缺失/显式 impossible/审批被拒 → **一次都不再试**
 *      （旧行为：自主模式还会自动 unblock 再排 3 轮，父子再交回 2 轮 = 9 次白跑）；
 *   2. 可重试的失败（429 / 5xx / model-idle / 空回复 / context_length_exceeded /
 *      普通工具报错）**绝不能**被这条护栏误杀；
 *   3. 子任务卡在不可恢复的问题上 → 父任务跳过「取消并交回负责人重排」；
 *   4. 根 maxTokens 预算：跨整棵任务树原子幂等累计，超额**不算坏数据**，
 *      下一次派发干净进入 paused_budget，裸 resume 被拒，扩额后可继续。
 *
 * 用真实 TaskRunStore + 假执行器，不 mock 存储。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guardrails-'));
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
const { classifyNonRetriableFailure, handBackBlockedBy } = await import(src('tasks/task-guardrails.js'));
const { reserveRootBudget, startRootBudget, settleRootBudget, extendRootBudget } = await import(src('tasks/task-budget-coordinator.js'));
const { checkCanRun, validateBudget, tokenCountOf } = await import(src('tasks/task-budget.js'));
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
const member = store.createBot({ name: '护栏成员', persona: '写代码' });
const room = store.createGroup({ name: '护栏测试组', botIds: [chief.id, member.id], leadBotId: chief.id });
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot({ autonomous = true, maxTokens = null } = {}) {
  seq += 1;
  const id = 'tr_g' + seq;
  const requestId = 'rq_g' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null, ...(maxTokens === null ? {} : { maxTokens }) },
    goal: {
      requirement: '一件要跑几段的长任务 #' + seq,
      verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-g-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

async function addKid(parentId, botId = member.id) {
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    goal: { requirement: '分工 ' + (++seq), verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }] },
  });
  assert.equal(out.ok, true, '建子任务应成功：' + (out.text ?? ''));
  return out.child.id;
}

function makeSupervisor({ execute, executeMember = null, verify = null } = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 6,
    maxStallRounds: 2,
    execute,
    executeMember,
    verify: verify ?? (async () => ({ passed: false, unmet: ['还没好'], needsReview: [], blocked: [] })),
    access: { stat: async () => ({ ok: false }), readText: async () => ({ ok: false }), resolveRef: () => null },
    clock: () => Date.now(),
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

async function waitUntil(sup, id, predicate, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), sleep(80)]);
    const run = taskRuns.read(id).taskRun;
    if (predicate(run)) return run;
    if (Date.now() > deadline) return run;
    await sleep(80);
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

/** 走一次完整的预留 → 启动 → 结算，并带上这次花掉的 token。 */
async function burnTokens(rootId, { taskRunId = rootId, attemptId, tokens }) {
  const grant = { store: taskRuns, rootTaskId: rootId, taskRunId, attemptId, revision: null, at: Date.now() };
  const reserved = await reserveRootBudget({ ...grant, botId: null });
  assert.equal(reserved.ok, true, '预留应成功：' + (reserved.text ?? reserved.code ?? ''));
  const started = await startRootBudget(grant);
  assert.equal(started.ok, true, '启动应成功：' + (started.text ?? started.code ?? ''));
  const settled = await settleRootBudget({ ...grant, tokens });
  assert.equal(settled.ok, true, '结算应成功：' + (settled.text ?? settled.code ?? ''));
  return settled;
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑：什么算「不可恢复」
// ---------------------------------------------------------------------------

await test('1. 不可恢复：auth / quota / aborted / config / impossible / 审批被拒', () => {
  const cases = [
    ['auth', { error: '401 unauthorized：鉴权失败', status: 401 }],
    ['quota', { error: 'insufficient_quota 余额不足', status: 402 }],
    ['aborted', { error: '已按你的要求终止' }],
    ['config', { error: 'model not found: glm/x' }],
    ['impossible', { error: '这条路走不通', impossible: true }],
    ['approval_rejected', { error: '审批被拒绝', approvalRejected: true }],
  ];
  for (const [kind, input] of cases) {
    const hit = classifyNonRetriableFailure(input);
    assert.ok(hit, kind + ' 应判不可恢复');
    assert.equal(hit.kind, kind);
    assert.ok(hit.why.length > 0, '要说清为什么不再试');
  }
});

await test('★ 1b. 严禁误杀：429 / 5xx / model-idle / 空回复 / 上下文超限 / 普通工具报错', () => {
  const pass = [
    { error: '429 rate limit', status: 429 },
    { error: '503 upstream unavailable', status: 503 },
    { error: '502 bad gateway', status: 502 },
    { error: '模型 180s 没有进展（model-idle），本次等待已放弃' },
    { error: '没有给出内容（empty）' },
    { error: 'context_length_exceeded: too many tokens' },
    { error: 'bash exited with code 1' },
    { error: '工具执行失败：permission denied on /tmp/x' },
    { error: '' },
    {},
  ];
  for (const input of pass) {
    assert.equal(classifyNonRetriableFailure(input), null, '不该判死：' + JSON.stringify(input));
  }
});

await test('1c. handBackBlockedBy：全是不可恢复 / 含「换人也没用」的类别才跳过交回', () => {
  const fatal = [{ id: 'k1', nonRetriableBlock: { kind: 'auth', why: '鉴权' } }];
  assert.equal(handBackBlockedBy(fatal)?.skip, true);

  const allSoft = [
    { id: 'k1', nonRetriableBlock: { kind: 'config', why: '缺模型' } },
    { id: 'k2' },
  ];
  assert.equal(handBackBlockedBy(allSoft), null, '还有别的没标记的分工 → 仍可交回');

  const mixed = [
    { id: 'k1', nonRetriableBlock: { kind: 'quota', why: '余额' } },
    { id: 'k2', nonRetriableBlock: { kind: 'config', why: '缺模型' } },
  ];
  assert.equal(handBackBlockedBy(mixed)?.kind, 'quota', '含 quota（换人也没用）→ 跳过交回');
});

// ---------------------------------------------------------------------------
// 2. 自主任务：不可恢复 → 一次就停（不再空转 3 轮）
// ---------------------------------------------------------------------------

await test('★ 2. 自主任务遇 401：执行 1 次就 blocked，记 nonRetriableBlock，不空转', async () => {
  const id = await makeRoot();
  let execs = 0;
  const sup = makeSupervisor({
    execute: async () => {
      execs += 1;
      return { ok: false, stop: 'failed', error: '401 unauthorized：鉴权失败', status: 401 };
    },
  });
  sup.notify(id);
  const run = await waitUntil(sup, id, (r) => r.state === 'blocked');
  sup.dispose();
  assert.equal(run.state, 'blocked');
  assert.equal(execs, 1, `不可恢复的错误只该试 1 次（旧行为是 3 次），实际 ${execs}`);
  assert.equal(run.nonRetriableBlock?.kind, 'auth');
  assert.match(run.flags?.blockedReason ?? '', /不可恢复/);
  assert.match(run.flags?.blockedReason ?? '', /停止自动重试/);
  assert.equal(run.retryAt ?? null, null, '不该再排重试');
});

await test('★ 2b. 执行器显式 impossible:true → 同样一次就停', async () => {
  const id = await makeRoot();
  let execs = 0;
  const sup = makeSupervisor({
    execute: async () => {
      execs += 1;
      return { ok: false, stop: 'failed', error: '接口返回了无法继续的结构', impossible: true };
    },
  });
  sup.notify(id);
  const run = await waitUntil(sup, id, (r) => r.state === 'blocked');
  sup.dispose();
  assert.equal(execs, 1, '显式 impossible 不该重试');
  assert.equal(run.nonRetriableBlock?.kind, 'impossible');
});

await test('★ 2c. 手动解除阻塞后清掉 nonRetriableBlock，可以恢复继续跑', async () => {
  const id = await makeRoot();
  let execs = 0;
  const sup = makeSupervisor({
    execute: async () => {
      execs += 1;
      if (execs === 1) return { ok: false, stop: 'failed', error: 'insufficient_quota 余额不足', status: 402 };
      return { ok: true, stop: 'yielded', work: { files: 1 } };
    },
  });
  sup.notify(id);
  const blocked = await waitUntil(sup, id, (r) => r.state === 'blocked');
  assert.equal(blocked.nonRetriableBlock?.kind, 'quota');

  const released = await sup.onControl(id, { type: 'unblock', reason: '已充值' });
  assert.equal(released.ok, true, '手动解除应成功：' + (released.text ?? released.code ?? ''));
  const after = taskRuns.read(id).taskRun;
  assert.equal(after.nonRetriableBlock ?? null, null, '解除阻塞要连不可恢复标记一起清');
  sup.dispose();
});

await test('★ 2d. 可重试的失败仍走既有自主重试（护栏不能误杀）', async () => {
  const id = await makeRoot();
  let execs = 0;
  const sup = makeSupervisor({
    execute: async () => {
      execs += 1;
      return { ok: false, stop: 'failed', error: 'bash exited with code 1' };
    },
  });
  sup.notify(id);
  await Promise.race([sup.idle(), sleep(500)]);
  sup.dispose();
  assert.ok(execs >= 1);
  const run = taskRuns.read(id).taskRun;
  assert.equal(run.nonRetriableBlock ?? null, null, '普通工具报错不该被打成不可恢复');
});

// ---------------------------------------------------------------------------
// 3. 父子：不可恢复的子任务不触发「交回负责人」空转
// ---------------------------------------------------------------------------

await test('★ 3. 子任务卡在 401 → 父任务跳过交回（childHandBacks 0），直接阻塞并带真实原因', async () => {
  const parentId = await makeRoot({ autonomous: true });
  const kidId = await addKid(parentId);
  let kidExecs = 0;
  const sup = makeSupervisor({
    execute: async () => ({ ok: true, stop: 'yielded', work: { files: 1 } }),
    executeMember: async () => {
      kidExecs += 1;
      return { ok: false, stop: 'failed', error: '401 unauthorized：鉴权失败', status: 401 };
    },
  });
  sup.notify(kidId);
  const kid = await waitUntil(sup, kidId, (r) => r.state === 'blocked');
  assert.equal(kid.nonRetriableBlock?.kind, 'auth');
  assert.equal(kidExecs, 1);

  sup.notify(parentId);
  const parent = await waitUntil(sup, parentId, (r) => r.state === 'blocked');
  sup.dispose();
  assert.equal(parent.state, 'blocked');
  assert.equal(Number(parent.childHandBacks ?? 0), 0, '不可恢复的分工不该被交回重排');
  assert.match(parent.flags?.blockedReason ?? '', /不可恢复/);
  assert.match(parent.flags?.blockedReason ?? '', /auth/);
});

await test('★ 3c. 负责人在自己这一轮里派出的子任务卡在 401 → 不用任何人去叫，父任务自己醒来如实阻塞', async () => {
  // 真实链路：子任务是负责人这一轮里 assign_member_task 派出来的，之后由调度器单独跑。
  // 父任务那一轮已经因「签名没变、有在途子任务」返回 wait —— 以前子任务永久受阻后
  // 没有任何东西叫醒父任务，它会永远停在「准备中」（上面第 3 条靠测试手动 notify 掩盖了这一点）。
  for (const autonomous of [false, true]) {
    const parentId = await makeRoot({ autonomous });
    let kidId = null;
    let leadTurns = 0;
    const sup = makeSupervisor({
      execute: async () => {
        leadTurns += 1;
        if (!kidId) kidId = await addKid(parentId);
        return { ok: true, stop: 'returned' };
      },
      executeMember: async () => ({ ok: false, stop: 'failed', error: '401 unauthorized：鉴权失败', status: 401 }),
    });
    sup.notify(parentId);
    const parent = await waitUntil(sup, parentId, (r) => r.state === 'blocked', { timeoutMs: 8000 });
    sup.dispose();
    assert.ok(kidId, '负责人这一轮应派出子任务');
    assert.equal(taskRuns.read(kidId).taskRun.nonRetriableBlock?.kind, 'auth');
    assert.equal(parent.state, 'blocked', `autonomous=${autonomous}：父任务必须自己醒来并阻塞，实际 ${parent.state}`);
    assert.match(parent.flags?.blockedReason ?? '', /auth/, '要带上子任务的真实原因');
    assert.equal(Number(parent.childHandBacks ?? 0), 0, '不可恢复的分工不该被交回重排');
    assert.equal(leadTurns, 1, '不该为此多跑负责人');
  }
});

await test('★ 3d. 用户单独取消一份子任务 → 父任务被叫醒重新判定（不再空等）', async () => {
  const parentId = await makeRoot({ autonomous: false });
  let kidId = null;
  let leadTurns = 0;
  const sup = makeSupervisor({
    execute: async () => {
      leadTurns += 1;
      if (!kidId) kidId = await addKid(parentId);
      return { ok: true, stop: 'returned' };
    },
    // 子任务一直在干活（每段让出、排续行），父任务那一轮早已返回 wait
    executeMember: async () => ({ ok: true, stop: 'yielded', work: { files: 1 } }),
  });
  sup.notify(parentId);
  await waitUntil(sup, parentId, () => Boolean(kidId) && (taskRuns.read(kidId).taskRun.attempts ?? []).length >= 1);
  await sup.idle();
  const before = leadTurns;
  const out = await sup.cancelTask(kidId, { reason: '这份不要了' });
  assert.equal(out?.ok, true, '取消应成功：' + (out?.text ?? out?.code ?? ''));
  const deadline = Date.now() + 8000;
  while (leadTurns === before && Date.now() < deadline) {
    await Promise.race([sup.idle(), sleep(80)]);
    await sleep(80);
  }
  sup.dispose();
  assert.equal(taskRuns.read(kidId).taskRun.state, 'cancelled');
  assert.ok(leadTurns > before, `取消子任务后父任务必须被叫醒、由负责人接着推进（负责人轮次 ${before} → ${leadTurns}）`);
});

await test('★ 3b. 对照：普通受阻子任务仍走既有「交回负责人」路径', async () => {
  const parentId = await makeRoot({ autonomous: true });
  const kidId = await addKid(parentId);
  await blockTask(kidId, '超过 600s 未完成，已中断');
  const prompts = [];
  const sup = makeSupervisor({
    execute: async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true, stop: 'yielded', work: { files: 1 } };
    },
  });
  sup.notify(parentId);
  const parent = await waitUntil(sup, parentId, (r) => Number(r.childHandBacks ?? 0) >= 1);
  sup.dispose();
  assert.equal(parent.childHandBacks, 1, '普通受阻仍应交回一次');
  assert.ok(prompts.length >= 1, '负责人要能被叫起来重排');
});

// ---------------------------------------------------------------------------
// 4. 根 maxTokens 预算
// ---------------------------------------------------------------------------

await test('4. tokenCountOf 只认上报的 input+output，脏数据记 0', () => {
  assert.equal(tokenCountOf({ inputTokens: 300, outputTokens: 100 }), 400);
  assert.equal(tokenCountOf(null), 0);
  assert.equal(tokenCountOf({ inputTokens: -5, outputTokens: 'x' }), 0);
  assert.equal(tokenCountOf({ inputTokens: 12.6 }), 13);
});

await test('★ 4b. 跨整棵树的原子幂等累计 + 超额不算坏数据 + 下一次派发进 paused_budget', async () => {
  const rootId = await makeRoot({ maxTokens: 1000 });
  const kidA = await addKid(rootId);
  const kidB = await addKid(rootId);

  await burnTokens(rootId, { attemptId: 'a_root_1', tokens: 400 });
  await burnTokens(rootId, { taskRunId: kidA, attemptId: 'a_kid_a_1', tokens: 350 });
  await burnTokens(rootId, { taskRunId: kidB, attemptId: 'a_kid_b_1', tokens: 350 });

  const budget = taskRuns.read(rootId).taskRun.budget;
  assert.equal(budget.usedTokens, 1100, `整棵树的用量要汇到根上，实际 ${budget.usedTokens}`);
  assert.ok(budget.usedTokens > budget.maxTokens, '这里就是「超额」现场');
  assert.equal(validateBudget(budget).ok, true, '★ 超额绝不能判成坏数据（否则永远进不了 paused_budget）');
  const gate = checkCanRun(budget, { at: Date.now() });
  assert.equal(gate.ok, false, '用尽后不能再放行');
  assert.equal(gate.field, 'budget.maxTokens');

  // 幂等：同一次结算再来一次（只走结算，不重新预留），不重复累加
  const again = await settleRootBudget({
    store: taskRuns, rootTaskId: rootId, taskRunId: kidA, attemptId: 'a_kid_a_1', at: Date.now(), tokens: 350,
  });
  assert.equal(again.ok, true, '重复结算应幂等成功：' + (again.text ?? again.code ?? ''));
  assert.equal(taskRuns.read(rootId).taskRun.budget.usedTokens, 1100, '重复结算不能把用量算两遍');

  // 下一次派发：不调执行器，直接落 paused_budget
  let execs = 0;
  const sup = makeSupervisor({
    execute: async () => { execs += 1; return { ok: true, stop: 'yielded' }; },
  });
  sup.notify(rootId);
  const paused = await waitUntil(sup, rootId, (r) => r.state === 'paused_budget');
  assert.equal(paused.state, 'paused_budget', `应停在预算暂停，实际 ${paused.state}`);
  assert.equal(execs, 0, '预算用尽时不该再调执行器');
  assert.match(String(paused.reason ?? paused.flags?.blockedReason ?? ''), /Token 预算已用尽|1100/);

  // 裸 resume 必须被拒
  const bare = await sup.onControl(rootId, { type: 'resume' });
  assert.equal(bare.ok, false, '没有扩额不能裸 resume');
  assert.equal(taskRuns.read(rootId).taskRun.state, 'paused_budget');

  // 扩额（token 维度）→ 可以继续
  const extended = await sup.onBudgetExtended(rootId, { extraTokens: 1000 });
  assert.equal(extended.ok, true, '扩额应成功：' + (extended.text ?? extended.code ?? ''));
  const after = taskRuns.read(rootId).taskRun;
  assert.equal(after.budget.maxTokens, 2000);
  assert.equal(after.budget.extraTokens, 1000);
  sup.notify(rootId);
  const resumed = await waitUntil(sup, rootId, (r) => r.state !== 'paused_budget');
  sup.dispose();
  assert.notEqual(resumed.state, 'paused_budget', '扩额后要能继续跑');
});

await test('★ 4c. extendRootBudget / extendBudget 只认正整数，空调用如实拒绝', async () => {
  const rootId = await makeRoot({ maxTokens: 500 });
  const empty = await extendRootBudget({ store: taskRuns, rootTaskId: rootId, at: Date.now() });
  assert.equal(empty.ok, false);
  const bad = await extendRootBudget({ store: taskRuns, rootTaskId: rootId, extraTokens: 0, at: Date.now() });
  assert.equal(bad.ok, false);
  const both = await extendRootBudget({ store: taskRuns, rootTaskId: rootId, extraRuns: 2, extraTokens: 100, at: Date.now() });
  assert.equal(both.ok, true);
  assert.equal(both.budget.maxTokens, 600);
  assert.equal(both.budget.extraRuns, 2);
  assert.equal(both.budget.extraTokens, 100);
});

await test('★ 4d. admissionBudget：ORBIS_TASK_MAX_TOKENS 与部门上限取更紧，缺省 null', () => {
  assert.equal(admissionBudget({}, null).maxTokens, null, '默认不限 token');
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_TOKENS: '5000' }, null).maxTokens, 5000);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_TOKENS: '5000' }, { maxTokens: 3000 }).maxTokens, 3000);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_TOKENS: '2000' }, { maxTokens: 9000 }).maxTokens, 2000);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_TOKENS: 'abc' }, null).maxTokens, null, '非法值当没配');
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_TOKENS: '0' }, null).maxTokens, null);
});


// ---------------------------------------------------------------------------
// 5. 预算恢复的边界（P1 回归）
// ---------------------------------------------------------------------------

/** 直接问归约器：这份预算下 EVENT.resumed 能不能通过。 */
let rvSeq = 0;
function resumeVerdict(budget) {
  // 用真工厂造一条合法记录，再换成目标预算/状态 —— 自己拼字段会被结构校验拒掉
  rvSeq += 1;
  const built = createTaskRun({
    id: 'tr_rv' + rvSeq, requestId: 'rq_rv' + rvSeq, requesterId: 'local', at: Date.now(),
    origin: { roomId: room.id }, owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: { requirement: '恢复判定用例', verification: [{ id: 'v1', kind: 'expert', description: 'x' }] },
  });
  // 状态一致性校验会核对「预算暂停」这个事实：必须带上 budgetPausedAt
  const base = {
    ...built.taskRun, state: 'paused_budget', budget,
    flags: { ...(built.taskRun.flags ?? {}), budgetPausedAt: Date.now() },
  };
  return reduceTaskRun(base, {
    type: EVENT.resumed, revision: base.revision, at: Date.now(), sequence: (base.sequence ?? 0) + 1,
  });
}

async function pauseForBudget(rootId) {
  const sup = makeSupervisor({ execute: async () => assert.fail('预算用尽时不该调执行器') });
  sup.notify(rootId);
  const run = await waitUntil(sup, rootId, (r) => r.state === 'paused_budget');
  sup.dispose();
  assert.equal(run.state, 'paused_budget', '应停在预算暂停，实际 ' + run.state);
  return run;
}

await test('★ 5a. 双维度不互锁：只扩超额的那个维度就能恢复', async () => {
  // token 超额、次数富余 → 只扩 extraTokens 能过
  // ★ 用**真实扩额后**的预算形状：`maxTokens` 已经含了这次追加（1000 + 1000），
  //   `extraTokens` 只是流水记录 —— 再加一遍就成了双倍计数（P1 修的就是这个）。
  const okTokens = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 0, maxTokens: 2000, usedTokens: 1100, extraTokens: 1000,
  });
  assert.equal(okTokens.ok, true, '只扩 token 就该能恢复（旧实现会因 extraRuns 也必须是正数而互锁）');

  // 反例 1：第二次超额 —— maxTokens 2000 已含上次扩的 1000，用过 2100 就是真超额。
  // 若把 extraTokens 再叠加一遍会变成 2100 < 3000 而错误放行。
  const secondOver = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 0, maxTokens: 2000, usedTokens: 2100, extraTokens: 1000,
  });
  assert.equal(secondOver.ok, false, '二次超额不能放行（extraTokens 不能重复计）');
  assert.equal(secondOver.code, 'budget_not_extended');

  // 反例 2：扩额不足 —— 只扩到 1060，用过 1100 仍然超额
  const notEnough = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 0, maxTokens: 1060, usedTokens: 1100, extraTokens: 60,
  });
  assert.equal(notEnough.ok, false, '扩额不足也不能放行');
  assert.equal(notEnough.code, 'budget_not_extended');

  // 反例：只扩次数（token 仍超额）→ 仍拒绝
  const badTokens = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 5, maxTokens: 1000, usedTokens: 1100, extraTokens: 0,
  });
  assert.equal(badTokens.ok, false, 'token 还超额时只扩次数不能放行');
  assert.equal(badTokens.code, 'budget_not_extended');

  // 镜像：次数用尽、token 富余 → 只扩 extraRuns 能过
  const okRuns = resumeVerdict({
    maxRuns: 1, usedRuns: 1, extraRuns: 5, maxTokens: 1000, usedTokens: 100, extraTokens: 0,
  });
  assert.equal(okRuns.ok, true, '只扩次数就该能恢复');

  // 裸 resume（两个维度都没扩）→ 拒绝
  const bare = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 0, maxTokens: 1000, usedTokens: 1100, extraTokens: 0,
  });
  assert.equal(bare.ok, false, '裸 resume 不能绕过');

  // 只设了 maxRuns 的老预算：行为与以前完全一致
  const legacyOk = resumeVerdict({ maxRuns: 10, usedRuns: 1, extraRuns: 3 });
  assert.equal(legacyOk.ok, true);
  const legacyBare = resumeVerdict({ maxRuns: 10, usedRuns: 1, extraRuns: 0 });
  assert.equal(legacyBare.ok, false);

  // 共享子任务：读 sharedExtraTokens（子任务自己不持有 maxTokens）
  const shared = resumeVerdict({
    maxRuns: 10, usedRuns: 1, extraRuns: 0, maxTokens: null, usedTokens: 0, extraTokens: 0,
    sharedWithRoot: true, sharedExtraTokens: 1000,
  });
  assert.equal(shared.ok, true, '子任务要能看到根扩的 token 额度');
});

await test('★ 5b. 端到端：token 超额进 paused_budget → 只扩 extraTokens 就能继续跑', async () => {
  const rootId = await makeRoot({ maxTokens: 1000 });
  await taskRuns.mutate(rootId, {
    mutate: (cur) => ({ ...cur, budget: { ...cur.budget, maxRuns: 10 } }),
  });
  await burnTokens(rootId, { attemptId: 'a_over_1', tokens: 1100 });
  await pauseForBudget(rootId);

  const extended = await extendRootBudget({
    store: taskRuns, rootTaskId: rootId, extraTokens: 1000, at: Date.now(),
  });
  assert.equal(extended.ok, true, '只扩 token 应成功：' + (extended.text ?? extended.code ?? ''));
  const verdict = resumeVerdict(taskRuns.read(rootId).taskRun.budget);
  assert.equal(verdict.ok, true, '扩额后 resume 应通过归约器：' + (verdict.code ?? '') + ' ' + (verdict.text ?? ''));
});

await test('★ 5c. 子任务因根 token 用尽进 paused_budget → 根扩额后父子都干净恢复', async () => {
  const rootId = await makeRoot({ maxTokens: 1000 });
  const kidId = await addKid(rootId);
  assert.equal(taskRuns.read(kidId).taskRun.budget.maxTokens, null, '子任务不持有自己的 maxTokens（共享根预算）');

  // 子任务这一轮把根预算烧超（等价于「它刚跑完最后一次」）
  await burnTokens(rootId, { taskRunId: kidId, attemptId: 'a_kid_over_1', tokens: 1100 });

  const sup = makeSupervisor({ execute: async () => assert.fail('不该调执行器'), executeMember: async () => assert.fail('不该调成员') });
  sup.notify(kidId);
  const kidPaused = await waitUntil(sup, kidId, (r) => r.state === 'paused_budget');
  assert.equal(kidPaused.state, 'paused_budget', '子任务应停在预算暂停，实际 ' + kidPaused.state);

  const extended = await sup.onBudgetExtended(kidId, { extraTokens: 1000 });
  assert.equal(extended.ok, true, '根扩额应成功：' + (extended.text ?? extended.code ?? ''));
  const rootAfter = taskRuns.read(rootId).taskRun;
  const kidAfter = taskRuns.read(kidId).taskRun;
  sup.dispose();

  assert.equal(rootAfter.budget.maxTokens, 2000);
  assert.equal(rootAfter.budget.extraTokens, 1000);
  assert.notEqual(kidAfter.state, 'paused_budget', '子任务要跟着恢复，实际 ' + kidAfter.state);
  assert.equal(kidAfter.budget.maxTokens, null, '子任务恢复后仍不存自己的 maxTokens');
  assert.equal(kidAfter.budget.sharedExtraTokens, 1000, '子任务要看到根扩的 token 额度');
});

await test('★ 5d. 最后一步跨过上限：0-token 的验收与交付照旧能做完', async () => {
  const rootId = await makeRoot({ maxTokens: 100 });
  const sup = makeSupervisor({
    execute: async () => {
      // 这一轮执行结算后把预算烧超（现场：最后一次执行刚好跨过上限）
      await burnTokens(rootId, { attemptId: 'a_last_1', tokens: 200 });
      return { ok: true, stop: 'returned', appliedCompletion: true, artifacts: ['out/report.md'] };
    },
    verify: async () => ({ passed: true, reason: '测试验收通过：产物已登记' }),
  });
  sup.notify(rootId);
  const run = await waitUntil(sup, rootId, (r) => r.state === 'completed' || r.state === 'paused_budget');
  sup.dispose();
  assert.equal(run.state, 'completed', `跨额的最后一步仍要能验收+交付完成，实际 ${run.state}`);
  assert.ok(run.delivery, '要真的交付了，而不是停在验收中');
});

await test('★ 5e. pause → resume 会清掉旧的 nonRetriableBlock', async () => {
  const id = await makeRoot();
  const sup = makeSupervisor({
    execute: async () => ({ ok: false, stop: 'failed', error: '401 unauthorized：鉴权失败', status: 401 }),
  });
  sup.notify(id);
  const blocked = await waitUntil(sup, id, (r) => r.state === 'blocked');
  assert.equal(blocked.nonRetriableBlock?.kind, 'auth');

  const paused = await sup.onControl(id, { type: 'pause', reason: '先停一下' });
  assert.equal(paused.ok, true, '暂停应成功：' + (paused.text ?? paused.code ?? ''));
  const resumed = await sup.onControl(id, { type: 'resume' });
  assert.equal(resumed.ok, true, '继续应成功：' + (resumed.text ?? resumed.code ?? ''));
  const after = taskRuns.read(id).taskRun;
  sup.dispose();
  assert.equal(after.nonRetriableBlock ?? null, null, '暂停→继续后不能残留不可恢复标记');
  assert.ok(!['paused_user', 'blocked'].includes(after.state), '要真的回到可推进状态，实际 ' + after.state);
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`长任务护栏：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
