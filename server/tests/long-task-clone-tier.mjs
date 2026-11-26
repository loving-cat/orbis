/**
 * 同角色临时分身扩容（Ephemeral Worker Clone）+ 任务难度模型分档（Task Difficulty Tier）。
 *   node tests/long-task-clone-tier.mjs
 *
 * ## 守的是什么
 *
 * 分身的两条硬不变量：**文件互斥**与**根并发/DAG 闸门**绝不放松；
 * 以及五个「按 key 存」的状态必须全部绑到泳道键（会话 / 报告收集器 /
 * 受管上下文 / dispatching / managedInflight），否则 A 的结论会写到 B 头上。
 *
 * 分档的六条硬边界：standard 零扰动、lockModel 不覆盖、本地不外泄、
 * 熔断跳过、档位打分、同模型不覆盖 —— 任何一条破了，用户要么多花钱，
 * 要么被静默换掉自己选的模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-clone-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
});
delete process.env.ORBIS_WORKER_CLONE;
delete process.env.ORBIS_MAX_CLONES_PER_BOT;
delete process.env.ORBIS_MODEL_TIER;
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createChildTask } = await import(src('tasks/task-subtasks.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { createTaskRuntime } = await import(src('tasks/task-runtime.js'));
const { STATE } = await import(src('tasks/task-contract.js'));
const POOL = await import(src('tasks/task-worker-pool.js'));
const TIER = await import(src('tasks/task-model-tier.js'));
const LANES = await import(src('runner/session-lanes.js'));
const BRIDGE = await import(src('runner/task-bridge.js'));

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
// 1. 分身池纯逻辑
// ---------------------------------------------------------------------------

await test('1. resolveCloneConfig：默认开（1 主 + 2 分身）、off 时恒为 1、硬封顶', () => {
  const def = POOL.resolveCloneConfig({});
  assert.equal(def.enabled, true);
  assert.equal(def.maxClonesPerBot, 2);
  assert.equal(def.maxPerBot, 3, '默认 1 主 + 2 分身');
  assert.equal(POOL.resolveCloneConfig({ ORBIS_WORKER_CLONE: 'off' }).maxPerBot, 1, 'off 必须退回串行');
  assert.equal(POOL.resolveCloneConfig({ ORBIS_MAX_CLONES_PER_BOT: '1' }).maxPerBot, 2);
  assert.equal(
    POOL.resolveCloneConfig({ ORBIS_MAX_CLONES_PER_BOT: '99' }).maxPerBot,
    POOL.MAX_CLONES_HARD_CAP + 1,
    '失控值要被硬封顶',
  );
  assert.equal(POOL.resolveCloneConfig({ ORBIS_MAX_CLONES_PER_BOT: 'x' }).maxClonesPerBot, 2, '垃圾值回落默认');
});

await test('2. effectivePerBotLimit：被根并发预算裁剪、上游不健康退回 1', () => {
  assert.equal(POOL.effectivePerBotLimit({ maxPerBot: 3 }), 3);
  assert.equal(POOL.effectivePerBotLimit({ maxPerBot: 3, concurrencyCap: 2 }), 2, '根并发只有 2 就不能开 3 路');
  assert.equal(POOL.effectivePerBotLimit({ maxPerBot: 3, concurrencyCap: 1 }), 1);
  assert.equal(POOL.effectivePerBotLimit({ maxPerBot: 3, upstreamHealth: 0.5 }), 1, '有熔断打开就退回串行');
  assert.equal(POOL.effectivePerBotLimit({ maxPerBot: 1 }), 1);
  assert.equal(POOL.effectivePerBotLimit({}), 1);
});

await test('3. 泳道键：主会话 / #fb / #clone_x / #clone_x#fb 互不撞键，且能还原 botId', () => {
  const main = POOL.cloneLaneKey({ roomId: 'r1', botId: 'b1' });
  const fb = POOL.cloneLaneKey({ roomId: 'r1', botId: 'b1', modelOverride: 'x' });
  const c1 = POOL.cloneLaneKey({ roomId: 'r1', botId: 'b1', cloneId: 'tr_1' });
  const c2 = POOL.cloneLaneKey({ roomId: 'r1', botId: 'b1', cloneId: 'tr_2' });
  const c1fb = POOL.cloneLaneKey({ roomId: 'r1', botId: 'b1', cloneId: 'tr_1', modelOverride: 'x' });
  assert.equal(main, 'r1:b1');
  assert.equal(fb, 'r1:b1#fb');
  assert.equal(c1, 'r1:b1#clone_tr_1');
  assert.equal(c1fb, 'r1:b1#clone_tr_1#fb');
  assert.notEqual(c1fb, c2 + '#fb', '两个分身各自回退也绝不撞键');

  assert.deepEqual(POOL.parseLaneKey(c1fb), { roomId: 'r1', botId: 'b1', cloneId: 'tr_1', fallback: true });
  assert.equal(POOL.parseLaneKey(main).cloneId, null);
  assert.equal(POOL.isCloneLane(c1), true);
  assert.equal(POOL.isCloneLane(main), false);
  assert.equal(POOL.baseBotIdOfKey('r1', c1fb), 'b1', '还原真实 botId（房间级中止要用）');
  assert.equal(POOL.baseBotIdOfKey('r1', fb), 'b1');
});

await test('4. planWorkerSlot：子任务才开分身；主会话空闲就用主槽；配额满了不开', () => {
  const kid = { id: 'k1', parentTaskId: 'p1' };
  const root = { id: 'r1', parentTaskId: null };
  assert.equal(POOL.planWorkerSlot({ taskRun: root, limit: 3, mainLaneBusy: true }).useClone, false, '负责人/主控永远主会话');
  assert.equal(POOL.planWorkerSlot({ taskRun: kid, limit: 1, mainLaneBusy: true }).useClone, false, '上限 1 时不开分身');
  assert.equal(POOL.planWorkerSlot({ taskRun: kid, limit: 3, activeForBot: 0, mainLaneBusy: false }).useClone, false, '主槽空闲就别多开');
  const busy = POOL.planWorkerSlot({ taskRun: kid, limit: 3, activeForBot: 0, mainLaneBusy: true });
  assert.equal(busy.useClone, true);
  assert.equal(busy.cloneId, 'k1', 'cloneId 用任务 id（幂等、可读）');
  const occupied = POOL.planWorkerSlot({ taskRun: kid, limit: 3, activeForBot: 1, mainLaneBusy: false });
  assert.equal(occupied.useClone, true, '同 Bot 已有在途任务时开分身');
  assert.equal(POOL.planWorkerSlot({ taskRun: kid, limit: 3, activeForBot: 3, mainLaneBusy: true }).useClone, false, '配额满就不再开');
});

// ---------------------------------------------------------------------------
// 2. 分档纯逻辑
// ---------------------------------------------------------------------------

await test('5. resolveTierMode：默认 explicit（只在显式指定时生效），垃圾值回落', () => {
  assert.equal(TIER.resolveTierMode({}), 'explicit');
  assert.equal(TIER.resolveTierMode({ ORBIS_MODEL_TIER: 'AUTO' }), 'auto');
  assert.equal(TIER.resolveTierMode({ ORBIS_MODEL_TIER: 'off' }), 'off');
  assert.equal(TIER.resolveTierMode({ ORBIS_MODEL_TIER: 'nonsense' }), 'explicit');
});

await test('6. inferTaskTier：机械活 fast、架构/排错/质量闸门 strong、拿不准 standard', () => {
  const mk = (requirement, verification = [{ id: 'v', kind: 'artifact', description: '交了产物' }]) => ({
    id: 't', goal: { requirement, verification }, flags: {},
  });
  assert.equal(TIER.inferTaskTier(mk('把这份表格式化并整理成清单')), 'fast');
  assert.equal(TIER.inferTaskTier(mk('翻译并润色这段文案')), 'fast');
  assert.equal(TIER.inferTaskTier(mk('重构并发调度并排查死锁根因')), 'strong');
  assert.equal(TIER.inferTaskTier(mk('做一次安全审计')), 'strong');
  assert.equal(TIER.inferTaskTier(mk('写一段说明')), 'standard');
  assert.equal(
    TIER.inferTaskTier(mk('随便干点啥', [{ id: 'c', kind: 'expert', description: '负责人确认' }])),
    'strong',
    '有 expert 闸门就是要质量',
  );
  assert.equal(
    TIER.inferTaskTier({ id: 't', goal: { requirement: '整理清单' }, flags: { criticRequired: true } }),
    'strong',
    'criticRequired 也要质量',
  );
  assert.equal(
    TIER.inferTaskTier(mk('随便跑点东西', [{ id: 't', kind: 'test', description: '测试通过' }])),
    'strong',
    '要求跑测试的活不该用快模型',
  );
});

await test('7. selectTierModel：六条硬边界（standard/lockModel/本地/熔断/打分/同模型）', () => {
  const candidates = [
    { slug: 'cloud/flash', label: 'gpt flash', groupId: 'cloud', provider: 'openai', baseUrl: 'https://api.example.com', contextWindow: 128_000 },
    { slug: 'cloud/opus', label: 'claude opus', groupId: 'cloud2', provider: 'openai', baseUrl: 'https://api2.example.com', contextWindow: 200_000 },
    { slug: 'ollama/qwen3', label: '本地 qwen3', groupId: 'ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', contextWindow: 32_000 },
  ];

  // 1) standard / 无效 → 零扰动
  assert.equal(TIER.selectTierModel({ tier: 'standard', candidates }).overrideModel, null);
  assert.equal(TIER.selectTierModel({ tier: 'nope', candidates }).overrideModel, null);

  // 2) 用户锁定 → 绝不覆盖
  assert.equal(
    TIER.selectTierModel({ tier: 'fast', candidates, userLocked: true }).overrideModel,
    null,
  );

  // 5) 档位打分
  const fast = TIER.selectTierModel({
    tier: 'fast', candidates, baseModel: { slug: 'cloud/opus', provider: 'openai', baseUrl: 'https://api2.example.com' },
  });
  assert.equal(fast.overrideModel, 'cloud/flash', 'fast 档要挑 flash 类');
  const strong = TIER.selectTierModel({
    tier: 'strong', candidates, baseModel: { slug: 'cloud/flash', provider: 'openai', baseUrl: 'https://api.example.com' },
  });
  assert.equal(strong.overrideModel, 'cloud/opus', 'strong 档要挑 opus/reason 类');

  // 3) 本地执行者：云端候选一律不许选（含显式配置）
  const localBase = { slug: 'ollama/qwen3', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
  assert.equal(
    TIER.selectTierModel({ tier: 'strong', candidates, baseModel: localBase }).overrideModel,
    null,
    '只有云端强模型时，本地执行者必须沿用自己',
  );
  const localExplicit = TIER.selectTierModel({
    tier: 'strong', candidates, baseModel: localBase, explicitTierModels: { strong: 'cloud/opus' },
  });
  assert.equal(localExplicit.overrideModel, null);
  assert.match(localExplicit.why, /拒绝外泄/);

  // 4) 熔断打开跳过
  const breaker = TIER.selectTierModel({
    tier: 'strong',
    candidates,
    baseModel: { slug: 'cloud/flash', provider: 'openai', baseUrl: 'https://api.example.com' },
    isBreakerOpen: (slug) => slug === 'cloud/opus',
  });
  assert.notEqual(breaker.overrideModel, 'cloud/opus');

  // 6) 同模型 → 不覆盖
  assert.equal(
    TIER.selectTierModel({
      tier: 'fast',
      candidates: [{ slug: 'cloud/flash', label: 'gpt flash', groupId: 'cloud', enabled: true }],
      baseModel: { slug: 'cloud/flash', provider: 'openai' },
    }).overrideModel,
    null,
  );

  // 显式档位模型可用 → 用它
  const explicit = TIER.selectTierModel({
    tier: 'strong',
    candidates,
    baseModel: { slug: 'cloud/flash', provider: 'openai', baseUrl: 'https://api.example.com' },
    explicitTierModels: { strong: 'cloud/opus' },
  });
  assert.equal(explicit.overrideModel, 'cloud/opus');
});

await test('8. resolveTaskTier：off 关闭、显式优先、auto 才推断', () => {
  const run = { id: 't', goal: { requirement: '把表整理成清单', verification: [{ id: 'v', kind: 'artifact', description: 'x' }] }, flags: {} };
  assert.deepEqual(TIER.resolveTaskTier({ taskRun: run, mode: 'off' }), { tier: 'standard', source: 'off' });
  assert.deepEqual(
    TIER.resolveTaskTier({ taskRun: { ...run, flags: { modelTier: 'strong' } }, mode: 'explicit' }),
    { tier: 'strong', source: 'explicit' },
  );
  assert.deepEqual(TIER.resolveTaskTier({ taskRun: run, mode: 'auto' }), { tier: 'fast', source: 'auto' });
  assert.deepEqual(TIER.resolveTaskTier({ taskRun: run, mode: 'explicit' }), { tier: 'standard', source: 'standard' });
});

// ---------------------------------------------------------------------------
// 3. 端到端：分身并发
// ---------------------------------------------------------------------------

const chief = store.mainBot();
const memberA = store.createBot({ name: '分身成员A', persona: 'x' });
const memberB = store.createBot({ name: '分身成员B', persona: 'x' });
const room = store.createGroup({
  name: '分身测试组',
  botIds: [chief.id, memberA.id, memberB.id],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot({ autonomous = true, concurrencyLimit = undefined } = {}) {
  seq += 1;
  const id = 'tr_ct' + seq;
  const requestId = 'rq_ct' + seq;
  const budget = { maxRuns: null };
  if (concurrencyLimit !== undefined) budget.concurrencyLimit = concurrencyLimit;
  const built = createTaskRun({
    id, requestId, requesterId: 'local', at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget,
    goal: { requirement: '分身并发测试 #' + seq, verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }] },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
  });
  assert.equal(built.ok, true, built.text ?? '');
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-ct-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, accepted.text ?? '');
  return id;
}

let kidSeq = 0;
async function addKid(parentId, { botId, files = [], modelTier = undefined } = {}) {
  kidSeq += 1;
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    files,
    modelTier,
    goal: {
      requirement: '分工 #' + kidSeq,
      verification: [{ id: 'v1', kind: 'expert', description: '负责人确认' }],
    },
  });
  assert.equal(out.ok, true, out.text ?? '');
  return out.child.id;
}

/** 并发计量 + 每路拿到的 cloneId / 档位。 */
function meter() {
  const m = { inflight: 0, max: 0, starts: 0, maxPerBot: 0, perBot: new Map(), cloneIds: [], metas: [] };
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

function memberRunner(m, ms = 60) {
  return async (args) => {
    m.cloneIds.push(args?.cloneId ?? null);
    m.enter(args?.botId);
    try {
      await sleep(ms);
    } finally {
      m.leave(args?.botId);
    }
    return { ok: true, stop: 'returned', appliedCompletion: true, artifacts: ['out/' + args.taskRun.id + '.md'] };
  };
}

function makeSupervisor({
  execute = async () => ({ ok: true, stop: 'returned' }),
  executeMember,
  maxPerBot = 1,
  isExecutorBusy = null,
  upstreamHealth = null,
  logs = [],
} = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 10,
    maxStallRounds: 4,
    execute,
    executeMember,
    maxPerBot,
    isExecutorBusy,
    upstreamHealth,
    verify: async () => ({ passed: true, reason: '测试验收通过' }),
    access: { stat: async () => ({ exists: true }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
    criticMode: 'off',
    clock: () => Date.now(),
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

async function waitFor(sup, ids, predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), sleep(30)]);
    const runs = ids.map((id) => taskRuns.read(id).taskRun);
    if (predicate(runs)) return runs;
    if (Date.now() > deadline) return runs;
    await sleep(30);
  }
}

await test('9. ★ maxPerBot = 1（默认）：同 Bot 两个子任务严格串行（零回归）', async () => {
  const rootId = await makeRoot();
  const kids = [await addKid(rootId, { botId: memberA.id }), await addKid(rootId, { botId: memberA.id })];
  const m = meter();
  const sup = makeSupervisor({ executeMember: memberRunner(m, 60), maxPerBot: 1 });
  sup.notify(rootId);
  const runs = await waitFor(sup, kids, (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();
  for (const run of runs) assert.equal(run.state, STATE.completed, `应完成，实际 ${run.state}`);
  assert.equal(m.maxPerBot, 1, `默认必须串行，实测同 Bot 并发 ${m.maxPerBot}`);
  assert.equal(m.cloneIds.every((c) => c === null), true, '不启用分身时任何一路都不该带 cloneId');
});

await test('10. ★ maxPerBot = 3：同 Bot 三个子任务真并行（各自的 cloneId），全部交付并落黑板', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kids = [];
  for (let i = 0; i < 3; i += 1) kids.push(await addKid(rootId, { botId: memberA.id }));
  const m = meter();
  const sup = makeSupervisor({ executeMember: memberRunner(m, 80), maxPerBot: 3 });
  sup.notify(rootId);
  const runs = await waitFor(sup, kids, (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();
  for (const run of runs) assert.equal(run.state, STATE.completed, `应完成，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
  assert.ok(m.maxPerBot >= 2, `同 Bot 应该真并行，实测最大 ${m.maxPerBot}`);
  assert.ok(m.cloneIds.filter(Boolean).length >= 1, '并行的那几路应带 cloneId（主槽之外都走分身）');
  // 主槽最多 1 路：cloneId 为 null 的次数不应超过已执行份数
  assert.ok(m.cloneIds.filter((c) => c === null).length <= 1, `主槽只该有一路，实测 ${m.cloneIds.filter((c) => c === null).length}`);
  const board = taskRuns.read(rootId).taskRun.blackboard;
  const artifacts = (board?.entries ?? []).filter((e) => e.kind === 'artifact');
  assert.ok(artifacts.length >= 1, '分身交付也要落黑板');
});

await test('11. ★ 文件互斥硬守卫：开了分身，抢同一文件的两个人也不并行', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kids = [
    await addKid(rootId, { botId: memberA.id, files: ['docs/shared.md'] }),
    await addKid(rootId, { botId: memberA.id, files: ['docs/shared.md'] }),
  ];
  const m = meter();
  const sup = makeSupervisor({ executeMember: memberRunner(m, 80), maxPerBot: 3 });
  sup.notify(rootId);
  const runs = await waitFor(sup, kids, (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();
  for (const run of runs) assert.equal(run.state, STATE.completed, `应完成，实际 ${run.state}`);
  assert.equal(m.max, 1, `抢同一个文件绝不能并行（实测 ${m.max}）`);
});

await test('12. ★ 上游降级：upstreamHealth < 1 时自动退回串行', async () => {
  const rootId = await makeRoot({ concurrencyLimit: 4 });
  const kids = [await addKid(rootId, { botId: memberA.id }), await addKid(rootId, { botId: memberA.id })];
  const m = meter();
  const sup = makeSupervisor({ executeMember: memberRunner(m, 50), maxPerBot: 3, upstreamHealth: () => 0.5 });
  sup.notify(rootId);
  const runs = await waitFor(sup, kids, (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();
  for (const run of runs) assert.equal(run.state, STATE.completed);
  assert.equal(m.maxPerBot, 1, `上游不健康必须退回串行，实测 ${m.maxPerBot}`);
});

await test('13. ★ 主会话被用户占着：子任务不等 15s，直接开分身跑', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  const m = meter();
  const sup = makeSupervisor({
    executeMember: memberRunner(m, 30),
    maxPerBot: 3,
    // 模拟「用户正在和这个 Bot 聊天」：主会话一直忙
    isExecutorBusy: ({ botId }) => botId === memberA.id,
  });
  const t0 = Date.now();
  sup.notify(rootId);
  const runs = await waitFor(sup, [kid], (rs) => rs[0].state === STATE.completed, { timeoutMs: 6000 });
  const elapsed = Date.now() - t0;
  sup.dispose();
  assert.equal(runs[0].state, STATE.completed, `应该绕过忙等直接跑完，实际 ${runs[0].state}`);
  assert.ok(elapsed < 6000, `不该傻等退避，实测 ${elapsed}ms`);
  assert.equal(m.cloneIds[0] !== null, true, '主会话被占时这一路必须走分身');
  const meta = taskRuns.read(kid).taskRun.lastDispatchMeta;
  assert.equal(meta?.cloned, true, '派发元数据要记下“这次是分身”');
  assert.ok(meta?.cloneId, '要记下 cloneId');
});

await test('14. ★ 五处按 key 存的状态全部绑泳道：报告/上下文/中止/释放', async () => {
  const laneMain = LANES.sessionLaneKey({ roomId: room.id, botId: memberA.id });
  const laneA = LANES.sessionLaneKey({ roomId: room.id, botId: memberA.id, cloneId: 'tr_kidA' });
  const laneB = LANES.sessionLaneKey({ roomId: room.id, botId: memberA.id, cloneId: 'tr_kidB' });
  assert.notEqual(laneA, laneB);

  const mkCollector = (note) => ({ note, accept: () => {}, noteBlocked: () => {} });
  const collectors = { [laneA]: mkCollector('A'), [laneB]: mkCollector('B') };
  const sessions = new Map();
  const disposed = [];
  const makeEntry = (taskRunId) => ({
    session: { abort: () => { disposed.push(taskRunId); }, dispose: async () => { disposed.push('dispose:' + taskRunId); } },
    managedContext: { taskRunId, attemptId: 'a_' + taskRunId },
    unsubscribe: () => {},
  });
  sessions.set(laneA, makeEntry('tr_kidA'));
  sessions.set(laneB, makeEntry('tr_kidB'));
  const runner = { sessions, reportScopes: new Map(Object.entries(collectors)), managedInflight: new Map() };

  // (1) 受管上下文不串台
  assert.equal(BRIDGE.currentTaskContext(runner, room.id, memberA.id, laneA).taskRunId, 'tr_kidA');
  assert.equal(BRIDGE.currentTaskContext(runner, room.id, memberA.id, laneB).taskRunId, 'tr_kidB');
  // 不传 laneKey = 主会话（既有行为）
  assert.equal(BRIDGE.currentTaskContext(runner, room.id, memberA.id), null);

  // (2) 报告收集器不串台：按泳道键取，各自是各自那一份
  BRIDGE.collectReport(runner, room.id, memberA.id, { phase: 'progress' }, laneA);
  BRIDGE.collectReport(runner, room.id, memberA.id, { phase: 'progress' }, laneB);
  assert.equal(runner.reportScopes.get(laneA).note, 'A');
  assert.equal(runner.reportScopes.get(laneB).note, 'B');

  // (3) 中止只打自己那一路
  runner.managedInflight.set('tr_kidB', { key: laneB, botId: memberA.id, roomId: room.id, session: sessions.get(laneB).session, attemptId: 'a_tr_kidB' });
  const aborted = BRIDGE.abortManagedTask(runner, 'tr_kidB');
  assert.equal(aborted.ok, true);
  assert.deepEqual(disposed, ['tr_kidB'], '只中止分身 B，不该碰主槽或兄弟分身');

  // (4) 用完即焚：删 key + dispose
  disposed.length = 0;
  await LANES.releaseLaneSession(runner, laneA);
  assert.equal(sessions.has(laneA), false, '分身会话必须从池里摘掉');
  assert.equal(sessions.has(laneB), true, '兄弟分身不受影响');
  assert.deepEqual(disposed, ['dispose:tr_kidA'], '必须 dispose');
});

// ---------------------------------------------------------------------------
// 4. 端到端：分档（真 runtime.runOne）
// ---------------------------------------------------------------------------

function makeRuntimeRunner({ slugOverride = null, locked = false, calls, modelGroupsList }) {
  return {
    store,
    model: { provider: 'cloud', id: 'default', slug: 'cloud/default' },
    modelGroups: { list: () => modelGroupsList, get: (id) => modelGroupsList.find((g) => g.id === id) ?? null },
    resolveModel: (slug) => (slug === 'cloud/opus'
      ? { provider: 'openai', id: 'opus', baseUrl: 'https://api2.example.com' }
      : (slug.startsWith('cloud/') ? { provider: 'openai', id: slug.split('/')[1], baseUrl: 'https://api.example.com' } : null)),
    breakerFor: () => null,
    breakers: new Map(),
    isBusy: () => false,
    abortManagedTask: () => {},
    roomHasBot: () => true,
    async run(roomId, botId, prompt, opts) {
      calls.push({ roomId, botId, opts });
      return { ok: true, stop: 'returned', appliedCompletion: true, artifacts: [] };
    },
    async runRound(roomId, opts) {
      calls.push({ roomId, opts });
      return { ok: true, stop: 'returned', appliedCompletion: true };
    },
    _slugOverride: slugOverride,
    _locked: locked,
  };
}

const modelGroupsList = [
  {
    id: 'cloud',
    enabled: true,
    baseUrl: 'https://api.example.com',
    endpoints: [{ baseUrl: 'https://api.example.com' }],
    menuEntries: () => [{ label: 'gpt flash', slugs: ['cloud/flash'], contextWindow: 128000 }],
  },
  {
    id: 'cloud2',
    enabled: true,
    baseUrl: 'https://api2.example.com',
    endpoints: [{ baseUrl: 'https://api2.example.com' }],
    menuEntries: () => [{ label: 'claude opus', slugs: ['cloud/opus'], contextWindow: 200000 }],
  },
];

async function driveRuntime({ tier, botModel = 'cloud/flash', locked = false, env = {} } = {}) {
  const savedEnv = { ORBIS_MODEL_TIER: process.env.ORBIS_MODEL_TIER };
  if (env.ORBIS_MODEL_TIER !== undefined) process.env.ORBIS_MODEL_TIER = env.ORBIS_MODEL_TIER;
  const bot = store.createBot({ name: '分档成员' + Math.random().toString(36).slice(2, 6), persona: 'x', model: botModel });
  if (locked && store.state?.bots?.[bot.id]) store.state.bots[bot.id].lockModel = true;
  const dm = store.ensureDm(bot.id);
  const calls = [];
  const runner = makeRuntimeRunner({ calls, modelGroupsList });
  const runtime = createTaskRuntime({
    taskRuns,
    runner,
    routeOf: (taskRun) => ({ roomId: taskRun.origin?.roomId ?? dm.id, botId: taskRun.owner?.leadBotId ?? bot.id, kind: 'dm' }),
    verify: async () => null,
    access: { stat: async () => ({ exists: true }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
    clock: () => Date.now(),
    log: () => {},
    emit: () => {},
  });
  // 直接驱动一次受管执行（不经完整调度，验证 runOne 的接线）
  const requestId = 'rq-tier-' + Math.random().toString(36).slice(2, 8);
  const built = createTaskRun({
    id: 'tr_tier_' + requestId.slice(-6),
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: dm.id },
    owner: { departmentId: dm.id, leadBotId: bot.id, roomKind: 'dm' },
    budget: { maxRuns: null },
    goal: { requirement: '整理清单', verification: [{ id: 'v', kind: 'artifact', description: 'x' }] },
    modelTier: tier,
  });
  assert.equal(built.ok, true, built.text ?? '');
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-' + requestId, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, accepted.text ?? '');
  const taskRun = taskRuns.read(built.taskRun.id).taskRun;
  // 直接调 runtime 的执行入口（内部会走 runOne：算档位 → 传 modelOverride）
  const out = await runtime.supervisor.runTask(taskRun.id).catch(() => null);
  if (savedEnv.ORBIS_MODEL_TIER === undefined) delete process.env.ORBIS_MODEL_TIER;
  else process.env.ORBIS_MODEL_TIER = savedEnv.ORBIS_MODEL_TIER;
  return { calls, out, taskRun, runtime, bot };
}

await test('15. ★ 显式 modelTier=fast：以 modelOverride 运行，且 bot.model 一个字节未改', async () => {
  const { calls, bot } = await driveRuntime({
    tier: 'fast', botModel: 'cloud/opus', env: { ORBIS_MODEL_TIER: 'explicit' },
  });
  assert.ok(calls.length >= 1, '应真的派发了一次');
  const opts = calls[0].opts ?? {};
  assert.equal(opts.modelOverride, 'cloud/flash', `fast 档应选 flash 类，实际 ${opts.modelOverride}`);
  assert.equal(store.getBot(bot.id).model, 'cloud/opus', 'bot.model 绝不能被改写');
  // 落盘开关由 turn-executor 强制为 `persist: false`（见其 ensureSession 调用），
  // 这里只确认调用方没有反过来要求持久化。
  assert.notEqual(opts.persist, true, '档位模型不得要求持久化会话');
});

await test('16. ★ 显式 modelTier=strong：换到强模型；lockModel=true 时绝不覆盖', async () => {
  const strong = await driveRuntime({ tier: 'strong', env: { ORBIS_MODEL_TIER: 'explicit' } });
  assert.equal(strong.calls[0]?.opts?.modelOverride, 'cloud/opus', 'strong 档应选 opus 类');

  const locked = await driveRuntime({ tier: 'strong', locked: true, env: { ORBIS_MODEL_TIER: 'explicit' } });
  assert.equal(locked.calls[0]?.opts?.modelOverride, undefined, '用户锁定模型时不得覆盖');
  assert.equal(store.getBot(locked.bot.id).model, 'cloud/flash');
});

await test('17. ★ 本地执行者 + strong：只有云端强模型时拒绝外泄，沿用本地模型', async () => {
  const bot = store.createBot({ name: '本地分档成员', persona: 'x', model: 'ollama/qwen3' });
  const dm = store.ensureDm(bot.id);
  const calls = [];
  const runner = {
    ...makeRuntimeRunner({ calls, modelGroupsList }),
    model: { provider: 'ollama', id: 'qwen3', slug: 'ollama/qwen3' },
    resolveModel: (slug) => (slug.startsWith('ollama/')
      ? { provider: 'ollama', id: 'qwen3', baseUrl: 'http://127.0.0.1:11434' }
      : (slug.split('/')[1] ? { provider: 'openai', id: slug.split('/')[1], baseUrl: 'https://api.example.com' } : null)),
    modelGroups: {
      list: () => [
        ...modelGroupsList,
        { id: 'ollama', enabled: true, baseUrl: 'http://127.0.0.1:11434', endpoints: [{ baseUrl: 'http://127.0.0.1:11434' }], menuEntries: () => [{ label: '本地 qwen3', slugs: ['ollama/qwen3'] }] },
      ],
      get: (id) => null,
    },
  };
  const runtime = createTaskRuntime({
    taskRuns, runner,
    routeOf: (taskRun) => ({ roomId: dm.id, botId: bot.id, kind: 'dm' }),
    verify: async () => null,
    access: { stat: async () => ({ exists: true }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
    clock: () => Date.now(), log: () => {}, emit: () => {},
  });
  process.env.ORBIS_MODEL_TIER = 'explicit';
  const requestId = 'rq-local';
  const built = createTaskRun({
    id: 'tr_local_tier', requestId, requesterId: 'local', at: Date.now(),
    origin: { roomId: dm.id },
    owner: { departmentId: dm.id, leadBotId: bot.id, roomKind: 'dm' },
    budget: { maxRuns: null },
    goal: { requirement: '重构并发调度', verification: [{ id: 'v', kind: 'artifact', description: 'x' }] },
    modelTier: 'strong',
  });
  await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-local-tier', build: () => built.taskRun, at: Date.now(),
  });
  await runtime.supervisor.runTask(built.taskRun.id).catch(() => null);
  delete process.env.ORBIS_MODEL_TIER;
  assert.ok(calls.length >= 1, '应真的派发了');
  assert.equal(calls[0].opts?.modelOverride, undefined, '本地执行者不得被换到云端强模型');
  assert.equal(store.getBot(bot.id).model, 'ollama/qwen3');
});

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nlong-task-clone-tier：${passed}/${results.length} 通过`);
if (failed) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.err}`);
  process.exit(1);
}
process.exit(0);
