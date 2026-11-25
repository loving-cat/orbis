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

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`长任务护栏：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
