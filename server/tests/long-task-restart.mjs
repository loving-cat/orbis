/**
 * 重启后「执行结果未知」的自动续跑判定（T4.3）。
 *   node tests/long-task-restart.mjs
 *
 * 以前一条尝试没留下结果记录（服务重启）就一律 `unresolved` →
 * 任务被钉在「执行结果未知，需人工确认」，用户点解除也一样，只能手动改数据。
 *
 * 现在按授权审计判断：**只要证明不了「这段没做不可逆的事」，就维持人工确认**
 * （fail-closed）。三种情况各有断言：
 *   ① 只是只读/可逆动作，或不可逆动作被拒 → 结算成「让出」，自动续跑；
 *   ② 放行过不可逆动作（含老记录没 roomId 的）→ 保持 unresolved 等人工确认；
 *   ③ 拿不到 startedAt → 保守阻塞（分不清哪些审计属于这一段）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-longtask-restart-'));
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
const { createOutcomeInspector } = await import(src('tasks/task-runtime.js'));
const { ATTEMPT_SLOT, slotKey } = await import(src('tasks/task-run-store.js'));
const { isIrreversible: isIrreversibleForTest } = await import(src('capabilities.js'));
const { PiRunner } = await import(src('pi-runner.js'));

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
const room = store.createGroup({ name: '重启测试组', botIds: [chief.id], leadBotId: chief.id });
const taskRuns = store.taskRuns;
const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };

let seq = 0;
/** 造一个任务 + 一条「已登记但未结算」的尝试（模拟服务重启那一刻）。 */
async function makeRestartScene({ startedAt = Date.now() - 60_000 } = {}) {
  seq += 1;
  const id = 'tr_rs' + seq;
  const requestId = 'rq_rs' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: {
      requirement: '重启后要能自己接着做的活 ' + seq,
      verification: [{ id: 'c1', kind: 'artifact', description: '交一份文件', spec: { count: 100 } }],
    },
    autonomous: true,
    autonomyReason: '测试',
  });
  assert.equal(built.ok, true, built.text ?? '');
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-rs-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, accepted.text ?? '');

  const attemptId = 'a_' + id + '_1';
  const run = taskRuns.read(id).taskRun;
  // 占位先到 started（存储层会校验：账本里能写 registered 的前提是根已 started）
  const startedOk = Number.isFinite(startedAt) ? startedAt : undefined;
  await taskRuns.mutate(id, {
    mutate: (cur) => ({
      ...cur,
      attemptSlots: {
        ...(cur.attemptSlots ?? {}),
        [slotKey(id, attemptId)]: {
          taskRunId: id,
          attemptId,
          botId: chief.id,
          revision: cur.revision,
          phase: ATTEMPT_SLOT.started,
          startedAt: startedOk,
        },
      },
    }),
  });
  const wrote = await taskRuns.mutate(id, {
    mutate: (cur) => ({
      ...cur,
      state: 'running',
      attempts: [...(cur.attempts ?? []), {
        attemptId,
        taskRunId: id,
        state: 'registered',
        botId: chief.id,
        revision: cur.revision,
        startedAt: startedOk,
      }],
    }),
  });
  assert.equal(wrote.ok, true, '写入 registered 尝试应成功：' + (wrote.text ?? wrote.code ?? ''));
  assert.ok(run);
  return { id, attemptId };
}

/** 直接拿到核验器（不启动调度器）—— 与运行时内部装配的是同一个函数。 */
function inspectOf() {
  const runner = new PiRunner();
  runner.model = model;
  runner.store = store;
  return createOutcomeInspector({
    taskRuns,
    runner,
    routeOf: () => ({ roomId: room.id, botId: chief.id }),
  });
}

store.state.grantAudit = [];

// ---------------------------------------------------------------------------

await test('① 只有只读 allow → 结算成「让出」并说明是重启中断', async () => {
  const { id, attemptId } = await makeRestartScene();
  store.state.grantAudit = [
    { at: Date.now() - 30_000, roomId: room.id, botId: chief.id, action: 'file.read', result: 'allow' },
  ];
  const found = await inspectOf()({ taskRun: { id }, attemptId });

  assert.equal(found.resolved, true, '只读动作不该拦住自动续跑：' + (found.reason ?? ''));
  assert.equal(isIrreversibleForTest('file.read'), false, '前置：file.read 是可逆动作');
  assert.equal(found.restarted, true);
  const attempt = found.attemptEvent.attempt ?? found.attemptEvent;
  assert.equal(attempt.stop, 'yielded', '「让出」不是失败 —— 推进器会按续段接着做');
  assert.match(String(attempt.reason ?? ''), /重启/);
});

await test('① b 不可逆动作被**拒**了 → 照样自动续跑', async () => {
  const { id, attemptId } = await makeRestartScene();
  store.state.grantAudit = [
    { at: Date.now() - 30_000, roomId: room.id, botId: chief.id, action: 'file.delete', result: 'deny' },
  ];
  const found = await inspectOf()({ taskRun: { id }, attemptId });
  assert.equal(found.resolved, true, '被拒的动作没有产生副作用');
  assert.equal((found.attemptEvent.attempt ?? found.attemptEvent).stop, 'yielded');
});

await test('② 放行过不可逆动作 → 保持 unresolved，等人工确认', async () => {
  const { id, attemptId } = await makeRestartScene();
  store.state.grantAudit = [
    { at: Date.now() - 30_000, roomId: room.id, botId: chief.id, action: 'file.delete', result: 'allow' },
  ];
  const found = await inspectOf()({ taskRun: { id }, attemptId });
  assert.equal(found.resolved, false, '删过东西就不能自动重放');
  assert.match(String(found.reason ?? ''), /不可逆/);
});

await test('② b 老审计记录没有 roomId → 保守当成命中', async () => {
  const { id, attemptId } = await makeRestartScene();
  store.state.grantAudit = [
    { at: Date.now() - 30_000, roomId: null, botId: chief.id, action: 'git_destructive', result: 'allow' },
  ];
  const found = await inspectOf()({ taskRun: { id }, attemptId });
  assert.equal(found.resolved, false, '分不清是哪个房间的记录，按可能命中算');
});

await test('② c 审计里别的 bot / 更早的时间点不算', async () => {
  const startedAt = Date.now() - 60_000;
  const { id, attemptId } = await makeRestartScene({ startedAt });
  store.state.grantAudit = [
    // 别的 bot 干的
    { at: Date.now() - 30_000, roomId: room.id, botId: 'b_someone_else', action: 'file.delete', result: 'allow' },
    // 这次执行之前就结束了
    { at: startedAt - 1, roomId: room.id, botId: chief.id, action: 'file.delete', result: 'allow' },
    // 别的房间
    { at: Date.now() - 30_000, roomId: 'r_other', botId: chief.id, action: 'file.delete', result: 'allow' },
  ];
  const found = await inspectOf()({ taskRun: { id }, attemptId });
  assert.equal(found.resolved, true, '这三条都不属于这一段，不该拦住续跑：' + (found.reason ?? ''));
});

await test('③ 拿不到 startedAt → 保守阻塞', async () => {
  const { id, attemptId } = await makeRestartScene({ startedAt: NaN });
  store.state.grantAudit = [];
  const found = await inspectOf()({ taskRun: { id }, attemptId });
  assert.equal(found.resolved, false, '分不清时间范围就必须人工确认');
  assert.match(String(found.reason ?? ''), /时间起点/);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
