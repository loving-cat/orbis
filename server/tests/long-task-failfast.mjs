/**
 * 上游失败快判（SPEC-PERF-V1 §4.2 b/c）：模型无进展超时 + SDK 重试看得见。
 *   node tests/long-task-failfast.mjs
 *
 * 守的这几条：
 *   1. 永远不吐字 → 在 `modelIdleMs` 内判定 `model-idle` 并落 `endedBy='model-idle'`
 *      （旧行为：等看门狗 6 分钟，且 endedBy 只有一句笼统的 retry-exhausted）；
 *   2. 工具在跑时**暂停**计时（长命令不算模型挂住），工具回来重新起表；
 *   3. `auto_retry_start` → 刷心跳 + 广播 `bot.retrying` + 顺延期限（SDK 退避不是挂死）；
 *   4. 连续 2 次 SDK 级失败 → 按一次通路失败喂给熔断（`markGroupFailed`）；
 *   5. 定时/阈值全部注入毫秒级，测试不真等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-failfast-'));
const wsDir = path.join(root, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: wsDir,
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
  ORBIS_TASK_INTAKE: '0',
  ORBIS_WATCH_CHANGES: '0',
  ORBIS_AUTO_ATTACH: '0',
  ORBIS_AUTO_ATTACH_FILES: '0',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { PiRunner } = await import(src('pi-runner.js'));
const { executeTurn } = await import(src('runner/turn-executor.js'));
const {
  createModelIdleGuard, createSdkRetryWatch, modelIdleMsFrom, DEFAULT_MODEL_IDLE_MS, announceSdkRetry,
  resolveIdleFailure, onSdkRetryStart,
} = await import(src('runner/model-idle.js'));
const { decideRetry, isUpstreamTransient, isRecoverableFailure } = await import(src('retry-policy.js'));
const modelFallback = await import(src('runner/model-fallback.js'));
const {
  shouldSwitchEarly, pickAlternateModel, planFallbackForBot, meetsNeeds, FALLBACK_AFTER_FAILS,
} = modelFallback;
const { ENDED_BY } = await import(src('run-stats.js'));
const { sessionKey } = await import(src('runner/runner-utils.js'));
const { executeGroupRound } = await import(src('runner/group-orchestrator.js'));

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

const MODEL = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };
const bot = store.createBot({ name: '快判成员', persona: '测试' });
const room = store.createGroup({ name: '快判测试组', botIds: [bot.id], leadBotId: bot.id });

/** 造一个假 runner + 假会话：`script(session)` 决定这一轮如何"流"。 */
function harness(script, { modelIdleMs = 120 } = {}) {
  const abortCalls = [];
  let listeners = [];
  const session = {
    model: MODEL,
    subscribe(fn) {
      listeners.push(fn);
      return () => {};
    },
    async abort() {
      abortCalls.push(Date.now());
      session.cancelled?.();
    },
    prompt: async (text) => {
      const emit = (ev) => listeners.forEach((fn) => fn(ev));
      await script({ emit, session, text });
    },
  };
  const entry = {
    bot, busy: false, session, liveMsgId: null, turnAmends: [], pendingReseat: null,
  };
  // 用真的 PiRunner：executeTurn 依赖它的会话/租约/事件总线，逐字段 mock 只会
  // 每加一处调用就崩一次（而且测不出真接线）。只替换会话、模型调用与两个探针。
  const runner = new PiRunner();
  runner.model = MODEL;
  runner.modelRuntime = { completeSimple: () => assert.fail('这一轮不该问模型要不要回复') };
  runner.memoryAutoDisabled = true;
  runner.ensureSession = async () => entry;
  runner.sessions.set(`${room.id}:${bot.id}`, entry);
  const runs = [];
  const recordRun = runner.recordRun.bind(runner);
  runner.recordRun = (rec) => { runs.push(rec); return recordRun(rec); };
  const failures = [];
  runner.markGroupFailed = (botId, info) => { failures.push({ botId, ...info }); return null; };
  const events = [];
  const emit = runner.bus.emit.bind(runner.bus);
  // 真实总线签名是 emit('event', payload)：包错一层就什么都收不到
  runner.bus.emit = (name, payload) => {
    if (name === 'event') events.push(payload);
    return emit(name, payload);
  };
  const run = () => executeTurn(runner, room.id, bot.id, '做一件小事', { skipUserMessage: true, modelIdleMs });
  return { runner, entry, session, events, abortCalls, failures, runs, run, emitAll: (ev) => listeners.forEach((fn) => fn(ev)) };
}

// ---------------------------------------------------------------------------
// 0. 纯函数：阈值与判定口径
// ---------------------------------------------------------------------------

await test('0. `ORBIS_MODEL_IDLE_MS`：默认 180s，越界/非数字回落默认', () => {
  assert.equal(DEFAULT_MODEL_IDLE_MS, 180_000);
  assert.equal(modelIdleMsFrom({}), 180_000);
  assert.equal(modelIdleMsFrom({ ORBIS_MODEL_IDLE_MS: '120000' }), 120_000);
  assert.equal(modelIdleMsFrom({ ORBIS_MODEL_IDLE_MS: '999' }), 180_000, '太小会误杀慢思考模型 → 回落默认');
  assert.equal(modelIdleMsFrom({ ORBIS_MODEL_IDLE_MS: 'abc' }), 180_000);
  assert.equal(modelIdleMsFrom({ ORBIS_MODEL_IDLE_MS: '600000' }), 600_000);
  assert.equal(modelIdleMsFrom({ ORBIS_MODEL_IDLE_MS: '99999999' }), 180_000, '超上限回落默认');
});

await test('0b. `decideRetry`：model-idle 走分钟级阶梯并提示换模型，用尽后如实停', () => {
  const first = decideRetry({ error: '模型 180s 没有进展（model-idle）', attempt: 1 });
  assert.equal(first.retry, true);
  assert.equal(first.kind, 'model-idle');
  assert.equal(first.switchModel, true, '第 1 次重试就提示换模型（§4.2 d 的早切换门槛）');
  assert.ok(first.delayMs >= 1_000, '不会是 1.5s 的快速重试：退避要按分钟级排');
  const last = decideRetry({ error: 'model-idle 没有进展', attempt: 11 });
  assert.equal(last.retry, false);
  assert.equal(last.kind, 'transient-exhausted');
  assert.equal(isUpstreamTransient({ kind: 'model-idle' }), true, '算上游暂时不健康');
  assert.equal(isRecoverableFailure({ error: 'model-idle 没有进展' }), true);
});

await test('0c. 守卫本身：暂停不计时、进展重置、SDK 退避顺延、只报一次', async () => {
  let fired = 0;
  const g = createModelIdleGuard({ limitMs: 40, onIdle: () => { fired += 1; } });
  g.arm();
  await sleep(60);
  assert.equal(g.fired, true, '一直没进展应判超时');
  assert.equal(fired, 1, '只报一次');
  const g2 = createModelIdleGuard({ limitMs: 40, onIdle: () => { fired += 1; } });
  g2.arm();
  g2.pause();
  await sleep(70);
  assert.equal(g2.fired, false, '工具在跑时不该判超时');
  g2.resume();
  await sleep(20);
  g2.beat();
  await sleep(30);
  assert.equal(g2.fired, false, '有进展就重新起算');
  await sleep(40);
  assert.equal(g2.fired, true);
  const g3 = createModelIdleGuard({ limitMs: 40, onIdle: () => {} });
  g3.arm();
  g3.sdkRetry(80);
  await sleep(60);
  assert.equal(g3.fired, false, 'SDK 退避睡眠期间不该判挂死');
});

await test('0e. resolveIdleFailure：把自家 abort 改写成「上游超时」，用户真取消时不动', () => {
  const fixed = resolveIdleFailure({ fired: true, limitMs: 180_000 }, false, { aborted: true, error: '已终止', status: 0 });
  assert.equal(fixed.aborted, false, '不能标成用户终止');
  assert.equal(fixed.timedOut, true);
  assert.equal(fixed.status, null);
  assert.match(fixed.error, /没有进展|model-idle/);
  assert.doesNotMatch(fixed.error, /已终止|已中止/, '文案不能踩 isRecoverableFailure 的「已终止/已中止」判据');
  assert.equal(isRecoverableFailure({ error: fixed.error }), true);
  assert.equal(resolveIdleFailure({ fired: true }, true, { error: 'x' }), null, '用户真取消时不改写');
  assert.equal(resolveIdleFailure({ fired: false }, false, { error: 'x' }), null, '没触发时不动');

  // onSdkRetryStart 不能走 beat()：beat 会把顺延的期限抹平
  const entry = { progressAt: 0 };
  let beatCalls = 0;
  const fakeIdle = { sdkRetry: () => {}, beat: () => { beatCalls += 1; } };
  onSdkRetryStart({ entry, idle: fakeIdle, event: { delayMs: 5000 } });
  assert.ok(entry.progressAt > 0, '必须刷心跳，否则看门狗会先判卡死');
  assert.equal(beatCalls, 0, '不能调 beat()');
});

await test('0d. SDK 重试收敛：连续 2 次算一次通路失败，成功清零', () => {
  const reported = [];
  const w = createSdkRetryWatch({ onUpstreamFailure: (info) => reported.push(info) });
  assert.equal(w.start({ attempt: 1, delayMs: 2000 }).reported, false);
  const second = w.start({ attempt: 2, delayMs: 4000 });
  assert.equal(second.reported, true, '第 2 次必须上报');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].delayMs, 4000);
  w.start({});
  w.end(true);
  assert.equal(w.streak, 0, 'SDK 自己成功就清零');
});

// ---------------------------------------------------------------------------
// 0f. §4.2 d：早切换的门槛与选型（纯函数）
// ---------------------------------------------------------------------------

await test('0f. 门槛：连续 2 次临时故障才切；model-idle / 熔断打开更早；锁定与已切过不切', () => {
  const base = { kind: 'transient', hasAlternate: true };
  assert.equal(shouldSwitchEarly({ ...base, fails: 1 }), false, '一次抖动不值得换');
  assert.equal(shouldSwitchEarly({ ...base, fails: FALLBACK_AFTER_FAILS }), true);
  assert.equal(shouldSwitchEarly({ ...base, fails: 1, kind: 'model-idle' }), true, '一个字都不吐：第 1 次就切');
  assert.equal(shouldSwitchEarly({ ...base, fails: 1, breakerOpen: true }), true, '组熔断已打开：别等端点轮转');
  assert.equal(shouldSwitchEarly({ ...base, fails: 5, userLocked: true }), false, '用户锁了模型就不切');
  assert.equal(shouldSwitchEarly({ ...base, fails: 5, alreadySwitched: true }), false, '单链最多切 1 次');
  assert.equal(shouldSwitchEarly({ ...base, fails: 5, hasAlternate: false }), false, '没替代就维持现状');
});

await test('0g. 选型：跳过自己/已试/熔断打开/停用，优先健康默认模型，带图过滤无 vision', () => {
  const candidates = [
    { slug: 'a/one', label: '甲', groupId: 'a' },
    { slug: 'b/two', label: '乙', groupId: 'b' },
    { slug: 'c/three', label: '丙', groupId: 'c' },
    { slug: 'd/off', label: '丁', groupId: 'd', enabled: false },
  ];
  const caps = {
    'a/one': { contextWindow: 8000 },
    'b/two': { contextWindow: 200000 },
    'c/three': { contextWindow: 200000, vision: true },
  };
  const got = pickAlternateModel({ from: 'a/one', candidates, capabilitiesOf: (c) => caps[c.slug] ?? c });
  assert.equal(got.slug, 'b/two', '跳过自己，按候选顺序取第一个健康的');

  const viaDefault = pickAlternateModel({ from: 'a/one', candidates, defaultModel: 'c/three', capabilitiesOf: (c) => caps[c.slug] ?? c });
  assert.equal(viaDefault.slug, 'c/three', '默认模型健康时优先回默认');

  const withImage = pickAlternateModel({
    from: 'a/one', candidates, needs: { images: true }, capabilitiesOf: (c) => caps[c.slug] ?? c,
  });
  assert.equal(withImage.slug, 'c/three', '带图：跳过没有 vision 的乙');

  const noisy = pickAlternateModel({
    from: 'a/one',
    candidates,
    tried: ['b/two', 'c/three'],
    isBreakerOpen: (slug) => slug === 'd/off',
    capabilitiesOf: (c) => caps[c.slug] ?? c,
  });
  assert.equal(noisy, null, '全被跳过就返回 null（不硬切）');

  assert.equal(pickAlternateModel({ from: 'a/one', candidates: [], capabilitiesOf: (c) => c }), null);
  assert.equal(meetsNeeds({ vision: false }, { images: true }), false);
  assert.equal(meetsNeeds({ contextWindow: 1000 }, { contextWindow: 9000 }), false, '窗口明显不够就不选它');
});

await test('0h. planFallbackForBot：读 bot.model / 候选清单 / 熔断状态，只回答要不要切、切到谁', () => {
  const fakeRunner = {
    store: { getBot: () => ({ id: 'b1', model: 'a/one' }) },
    modelLabel: () => 'c/three',
    modelGroups: { menuEntries: () => ([{ slugs: ['a/one'], label: '甲', groupId: 'a' }, { slugs: ['c/three'], label: '丙', groupId: 'c' }]) },
    breakerFor: (botId, slug) => ({ breaker: { state: String(slug ?? 'a/one').startsWith('a') ? 'open' : 'closed' } }),
    resolveModel: (slug) => ({ provider: slug.split('/')[0], id: slug.split('/')[1], contextWindow: 200000, vision: true }),
  };
  const alt = planFallbackForBot({ runner: fakeRunner, botId: 'b1', fails: 1, kind: 'transient' });
  assert.equal(alt.slug, 'c/three', '主组熔断打开 → 立刻切到健康的默认模型');
  assert.equal(planFallbackForBot({ runner: fakeRunner, botId: 'b1', fails: 1, kind: 'transient', userLocked: true }), null);
  assert.equal(planFallbackForBot({ runner: fakeRunner, botId: 'b1', fails: 1, kind: 'transient', alreadySwitched: true }), null);
  const healthy = { ...fakeRunner, breakerFor: () => ({ breaker: { state: 'closed' } }) };
  assert.equal(planFallbackForBot({ runner: healthy, botId: 'b1', fails: 1, kind: 'transient' }), null, '第 1 次临时故障不切');
});

// ---------------------------------------------------------------------------
// 1. 永远不吐字 → 到点判 model-idle
// ---------------------------------------------------------------------------

await test('★ 1. 永不吐字：在 modelIdleMs 内判 model-idle，endedBy 落 model-idle', async () => {
  const h = harness(async ({ session }) => {
    // 只发 message_start，之后一个字都没有 —— 上游把请求挂住了
    session.cancelled = null;
    h.entry.toolsRunning = 0;
    await new Promise((resolve) => { session.cancelled = resolve; });
    throw Object.assign(new Error('已中止'), { name: 'AbortError' });
  }, { modelIdleMs: 150 });
  const t0 = Date.now();
  const res = await h.run();
  const elapsed = Date.now() - t0;
  assert.equal(h.abortCalls.length, 1, '超时后必须中止本次请求');
  assert.ok(elapsed < 3_000, `应在 modelIdleMs 附近就判定（实测 ${elapsed}ms，旧行为要等看门狗 6 分钟）`);
  const rec = h.runs.at(-1);
  assert.ok(rec, '应记录一条 run-stats');
  assert.equal(rec.kind, 'model-idle');
  assert.equal(rec.endedBy, ENDED_BY.modelIdle, 'endedBy 必须是 model-idle');
  assert.ok(rec.timing, '计时对象要一起落盘');

  // ★ 关键：自己 abort 出来的 AbortError 不能被当成「用户终止」。
  //   否则 isRecoverableFailure / decideRetry / isUpstreamTransient 全部否掉，
  //   0 次重试、不喂熔断、不进分钟级续派，气泡还变红「已终止」。
  assert.match(String(res.error ?? ''), /没有进展|model-idle/);
  assert.doesNotMatch(String(res.error ?? ''), /已终止/, '用户没取消，不能说被终止');
  const decision = decideRetry({ error: res.error, attempt: 1 });
  assert.equal(decision.retry, true, '必须还能重试');
  assert.equal(decision.kind, 'model-idle');
  assert.equal(decision.switchModel, true, '第 1 次重试就提示换模型');
  assert.equal(isUpstreamTransient({ error: res.error }), true, '要走分钟级续派，别把活当失败');
  assert.equal(rec.timing.failKinds['model-idle'], 1, 'failKinds 里要能看见 model-idle');
});

// ---------------------------------------------------------------------------
// 2. 工具期间不计时
// ---------------------------------------------------------------------------

await test('★ 2. 工具在跑时不判卡死；工具回来重新起表', async () => {
  const h = harness(async ({ session }) => {
    await new Promise((resolve) => { session.cancelled = resolve; });
    throw Object.assign(new Error('已中止'), { name: 'AbortError' });
  }, { modelIdleMs: 120 });
  const p = h.run();
  // 起跑后马上进入工具期：比阈值长得多，也不该被判挂死
  h.entry.toolsRunning = 1;
  await sleep(20);
  h.emitAll({ type: 'tool_execution_start', toolName: 'bash', args: {} });
  await sleep(220);
  assert.equal(h.abortCalls.length, 0, '工具在跑时不算模型没进展');
  h.entry.toolsRunning = 0;
  h.emitAll({ type: 'tool_execution_end', toolName: 'bash', isError: false });
  await p;
  assert.equal(h.abortCalls.length, 1, '工具结束后重新起表，没进展才判');
  assert.equal(h.runs.at(-1).endedBy, ENDED_BY.modelIdle);
});

// ---------------------------------------------------------------------------
// 3. SDK 内部重试看得见、算得进熔断
// ---------------------------------------------------------------------------

await test('★ 3. auto_retry_start：广播 bot.retrying、顺延期限、连续 2 次喂一次熔断', async () => {
  const h = harness(async ({ emit }) => {
    emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 10, delayMs: 2000 });
    emit({ type: 'auto_retry_end', success: false });
    emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 10, delayMs: 4000 });
    emit({ type: 'auto_retry_end', success: false });
    await sleep(10);
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好了' } });
    emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '好了' }] } });
  }, { modelIdleMs: 100 });

  await h.run();
  const retrying = h.events.filter((e) => e.t === 'bot.retrying');
  assert.equal(retrying.length, 2, '每次 SDK 重试都要让用户看见');
  assert.equal(retrying[0].delayMs, 2000);
  assert.equal(retrying[1].attempt, 2);
  assert.ok(retrying.every((e) => e.kind === 'sdk-retry'));
  assert.equal(h.failures.length, 1, '连续 2 次 SDK 级失败 = 一次通路失败（不放大成 2 次）');
  assert.equal(h.failures[0].botId, bot.id);
  assert.equal(h.abortCalls.length, 0, 'SDK 退避不是挂死，不该被判 model-idle');
  const rec = h.runs.at(-1);
  assert.equal(rec.ok, true, '这一轮最后是成功的');
  assert.equal(rec.sdkRetries >= 1, true);
});

await test('★ 3b. announceSdkRetry 只带次数/延迟，不带 endpoint 与密钥', async () => {
  const out = [];
  announceSdkRetry({
    emit: (e) => out.push(e), roomId: 'r1', botId: 'b1',
    event: { attempt: 3, maxAttempts: 10, delayMs: 8000, endpoint: 'https://secret.example', apiKey: 'sk-xxx' },
  });
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['attempt', 'botId', 'delayMs', 'kind', 'maxAttempts', 'roomId', 't']);
  assert.equal(JSON.stringify(out[0]).includes('secret'), false);
});


// ---------------------------------------------------------------------------
// 4. 集成：真 PiRunner.ensureSession + turn-executor + group-orchestrator
//    （只替换 __buildSession —— 会话创建不是被测对象，#fb 键与复用逻辑要真跑）
// ---------------------------------------------------------------------------

let gSeq = 0;
const okBody = (emit) => {
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '做完了' } });
  emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '做完了' }] } });
};

function groupHarness({ primary = 'a/prime', alternate = 'c/good', alternateVision = false, script }) {
  gSeq += 1;
  const lead = store.mainBot();
  const b = store.createBot({ name: '编排成员' + gSeq, role: 'member', persona: '测试' });
  store.updateBot(b.id, { model: primary });
  const room = store.createGroup({ name: '编排组' + gSeq, botIds: [lead.id, b.id], leadBotId: lead.id });
  store.updateGroupLimits({ memberTurns: 15, leadTurns: 15 });
  const runner = new PiRunner();
  runner.model = { provider: 'c', id: 'good', contextWindow: 200_000 };
  runner.modelRuntime = { completeSimple: () => assert.fail('这一轮不该问模型要不要回复') };
  runner.modelLabel = () => alternate;
  runner.resolveModel = (slug) => {
    const [provider, id] = String(slug).split('/');
    return { provider, id, contextWindow: 200_000, ...(slug === alternate && alternateVision ? { vision: true } : {}) };
  };
  runner.modelGroups = {
    menuEntries: () => [
      { slugs: [primary], label: primary, groupId: primary.split('/')[0] },
      { slugs: [alternate], label: alternate, groupId: alternate.split('/')[0] },
    ],
    get: () => null, list: () => [], toProviderConfigs: () => [],
  };
  const builds = []; const records = []; const events = []; const disposes = [];
  runner.__buildSession = async (roomId, botId, opts = {}) => {
    builds.push({ roomId, botId, ...opts });
    const model = opts.modelOverride ?? primary;
    const listeners = [];
    const session = {
      model: runner.resolveModel(model),
      subscribe(fn) { listeners.push(fn); return () => {}; },
      async abort() {},
      async prompt(text) {
        const emit = (ev) => listeners.forEach((fn) => fn(ev));
        await script({ model, emit, text, botId, opts });
      },
      dispose() { disposes.push(model); },
    };
    return { bot: store.getBot(botId), session, busy: false, unsubscribe: null, pending: null, liveMsgId: null, turnAmends: [] };
  };
  const recordRun = runner.recordRun.bind(runner);
  runner.recordRun = (rec) => { records.push(rec); return recordRun(rec); };
  // 真正落到 run-stats 的那条记录（model/provider/switchedModel 都在这里定型）
  const stats = [];
  runner.stats = { record: (rec) => { stats.push(rec); return null; } };
  const emitBus = runner.bus.emit.bind(runner.bus);
  runner.bus.emit = (name, payload) => { if (name === 'event') events.push(payload); return emitBus(name, payload); };
  runSessionCleanup = null;
  return {
    runner, room, bot: b, builds, records, stats, events, disposes,
    openerText: '@' + b.name + ' 把这件事做完',
    run: (attachments = []) => executeGroupRound(runner, room.id, {
      openerText: '@' + b.name + ' 把这件事做完', openerBotId: null, openerMessageId: null, attachments,
    }),
  };
}

const fail = (status, text = 'upstream boom') => Object.assign(new Error(text), { status });
let runSessionCleanup = null;

const emitRetrying = (events) => events.filter((e) => e?.t === 'bot.retrying');
const switchedEvents = (events) => emitRetrying(events).filter((e) => e?.switchedTo);

await test('★ ①b 熔断直切：首发即走 #fb 临时会话，坏主组不被标健康', async () => {
  const h = groupHarness({
    script: ({ model, emit }) => (model === 'a/prime' ? Promise.reject(fail(503)) : okBody(emit)),
  });
  for (let i = 0; i < 3; i += 1) h.runner.markGroupFailed(h.bot.id, { kind: 'transient', status: 503 });
  assert.equal(h.runner.breakerFor(h.bot.id).breaker.state, 'open');

  await h.run();

  assert.ok(h.builds.some((b) => b.modelOverride === 'c/good' && b.persist === false),
    '#fb 会话必须用 modelOverride 且 persist=false 建：' + JSON.stringify(h.builds));
  assert.equal(h.runner.sessions.has(`${sessionKey(h.room.id, h.bot.id)}#fb`), false, '#fb 必须释放');
  assert.ok(h.disposes.length >= 1, '一次性会话要 dispose');
  assert.equal(store.getBot(h.bot.id).model, 'a/prime', 'bot.model 纹丝未动');
  assert.equal(h.runner.breakerFor(h.bot.id).breaker.state, 'open', '坏着的主组不能被标成健康');
  const rec = h.stats.find((r) => r.ok === true);
  assert.equal(rec.model, 'c/good', '统计按实际执行的模型记');
  assert.equal(rec.switchedModel, true);
  assert.ok(switchedEvents(h.events).length >= 1, 'bot.retrying 要带 switchedTo');
});

await test('★ ① 连续 2 次 503 → 第 3 次自动切健康备用模型', async () => {
  let primaryFails = 0;
  const h = groupHarness({
    script: ({ model, emit }) => {
      if (model !== 'a/prime') return okBody(emit);
      primaryFails += 1;
      if (primaryFails <= 2) return Promise.reject(fail(503));
      return okBody(emit);
    },
  });
  await h.run();
  const overrides = h.builds.filter((b) => b.modelOverride === 'c/good');
  assert.equal(overrides.length, 1, '只切一次：' + JSON.stringify(h.builds));
  assert.equal(overrides[0].persist, false);
  assert.equal(primaryFails, 2);
  assert.equal(h.runner.sessions.has(`${sessionKey(h.room.id, h.bot.id)}#fb`), false);
  assert.equal(h.runner.sessions.has(sessionKey(h.room.id, h.bot.id)), true, '原会话缓存不能被污染/删掉');
  assert.equal(store.getBot(h.bot.id).model, 'a/prime');
  assert.equal(h.stats.find((r) => r.ok === true)?.switchedModel, true);
  assert.ok(switchedEvents(h.events).length >= 1);
});

await test('★ ② model-idle：第一次失败就够切换门槛（decideRetry × planFallbackForBot）', async () => {
  // 说明：模型挂住的判定发生在 turn-executor（用例 1 已端到端验过 endedBy=model-idle），
  // 这里验的是「这条失败传到编排层后，第一次重试就该切」—— 也就是门槛的组合口径。
  // （fake session 造不出 model-idle：`modelFailure` 会按 status 重新归类，正文只留脱敏文案。）
  const idleError = resolveIdleFailure({ fired: true, limitMs: 180_000 }, false, fail(503)).error;
  const decision = decideRetry({ error: idleError, attempt: 1 });
  assert.equal(decision.kind, 'model-idle');

  const fakeRunner = {
    store: { getBot: () => ({ id: 'b1', model: 'a/prime' }) },
    modelLabel: () => 'c/good',
    modelGroups: {
      menuEntries: () => [
        { slugs: ['a/prime'], label: '甲', groupId: 'a' },
        { slugs: ['c/good'], label: '丙', groupId: 'c' },
      ],
    },
    breakerFor: () => ({ breaker: { state: 'closed' } }),
    resolveModel: (slug) => ({ provider: slug.split('/')[0], id: slug.split('/')[1], contextWindow: 200_000 }),
  };
  const first = planFallbackForBot({ runner: fakeRunner, botId: 'b1', fails: 1, kind: decision.kind });
  assert.equal(first?.slug, 'c/good', 'model-idle 第 1 次失败就要切，不能等第 2 次');
  const tooEarly = planFallbackForBot({ runner: fakeRunner, botId: 'b1', fails: 1, kind: 'transient' });
  assert.equal(tooEarly, null, '普通临时故障要连续 2 次才切');
});

await test('★ ③a 带图片 + 备用无 vision → 拒绝切换（不走看不懂图的模型）', async () => {
  const h = groupHarness({
    alternateVision: false,
    script: ({ model, emit }) => (model === 'a/prime' ? Promise.reject(fail(503)) : okBody(emit)),
  });
  for (let i = 0; i < 3; i += 1) h.runner.markGroupFailed(h.bot.id, { kind: 'transient', status: 503 });
  await h.run(['chart.png']);
  assert.equal(h.builds.filter((b) => b.modelOverride).length, 0, '带图不能切到无 vision 的候选');
  assert.equal(switchedEvents(h.events).length, 0);
});

await test('★ ③b 非图片附件允许切换；备用也失败 → 单链不二次切换且归属备用组', async () => {
  const h = groupHarness({
    script: ({ model }) => Promise.reject(fail(503)), // 主、备都失败
  });
  for (let i = 0; i < 3; i += 1) h.runner.markGroupFailed(h.bot.id, { kind: 'transient', status: 503 });
  await h.run(['notes.md']);
  const overrides = h.builds.filter((b) => b.modelOverride === 'c/good');
  assert.equal(overrides.length, 1, '单链最多切 1 次：' + JSON.stringify(h.builds));
  assert.equal(switchedEvents(h.events).length, 1, '只广播一次切换');
  const altBreaker = h.runner.breakerFor(h.bot.id, 'c/good').breaker;
  assert.ok((altBreaker.fails ?? 0) >= 1, '备用组的失败要记在备用组上');
  assert.equal(h.runner.sessions.has(`${sessionKey(h.room.id, h.bot.id)}#fb`), false);
  assert.equal(store.getBot(h.bot.id).model, 'a/prime');
});

// ---------------------------------------------------------------------------
// 6. 策略：自动兜底的隐私 / 费用边界 + #fb 下一轮不失忆
// ---------------------------------------------------------------------------

await test('★ 6a. ORBIS_MODEL_FALLBACK：off / same-provider / cloud / any', () => {
  const M = modelFallback;
  assert.equal(M.fallbackModeFrom({}), 'cloud', '默认 cloud');
  assert.equal(M.fallbackModeFrom({ ORBIS_MODEL_FALLBACK: 'off' }), 'off');
  assert.equal(M.fallbackModeFrom({ ORBIS_MODEL_FALLBACK: 'same-provider' }), 'same-provider');
  assert.equal(M.fallbackModeFrom({ ORBIS_MODEL_FALLBACK: 'any' }), 'any');
  assert.equal(M.fallbackModeFrom({ ORBIS_MODEL_FALLBACK: '乱写' }), 'cloud', '非法值回落默认');

  const from = { provider: 'openai' };
  const cand = { provider: 'anthropic' };
  assert.equal(M.allowedByPolicy(from, cand, 'off'), false, 'off：一律不切');
  assert.equal(M.allowedByPolicy(from, cand, 'same-provider'), false, '跨 provider 不许切');
  assert.equal(M.allowedByPolicy(from, { provider: 'openai' }, 'same-provider'), true);
  assert.equal(M.allowedByPolicy(from, cand, 'any'), true);
  assert.equal(M.allowedByPolicy(from, cand, 'cloud'), true, '云端之间可以兜底');
});

await test('★ 6b. 本地/内网模型绝不自动换到公有云', () => {
  const M = modelFallback;
  assert.equal(M.isLocalEndpoint({ provider: 'ollama' }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://127.0.0.1:11434/v1' }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://localhost:8080' }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://10.1.2.3:8000' }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://192.168.1.9' }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://172.20.0.4' }), true);
  // 局域网 mDNS 名（`.local`）也算本地：这里拼出来，避免被 secrets 扫描当成真实主机名
  assert.equal(M.isLocalEndpoint({ baseUrl: `http://box.${'local'}:8000` }), true);
  assert.equal(M.isLocalEndpoint({ baseUrl: 'http://nas.example.test:8000' }), false, '公网域名不算本地');
  assert.equal(M.isLocalEndpoint({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), false);

  const local = { provider: 'ollama' };
  assert.equal(M.allowedByPolicy(local, { provider: 'openai' }, 'cloud'), false,
    '本地 → 公有云：绝不允许（那是把代码/文档悄悄上传）');
  assert.equal(M.allowedByPolicy(local, { provider: 'lmstudio' }, 'cloud'), true,
    '本地 → 另一个本地：可以');
  assert.equal(M.allowedByPolicy(local, { provider: 'openai' }, 'any'), true,
    'any 是老行为，用户显式选了就按它');
});

await test('★ 6c. bot.lockModel === true 才不切；按角色配了 model 的成员照常兜底', () => {
  const mkRunner = (bot) => ({
    store: { getBot: () => bot },
    modelLabel: () => 'g2/b',
    modelGroups: { menuEntries: () => ([
      { slugs: ['g1/a'], label: '甲', groupId: 'g1' },
      { slugs: ['g2/b'], label: '乙', groupId: 'g2' },
    ]) },
    breakerFor: () => ({ breaker: { state: 'closed' } }),
    resolveModel: (slug) => ({ provider: slug.split('/')[0], id: slug.split('/')[1], contextWindow: 200000 }),
  });
  const plain = modelFallback.planFallbackForBot({
    runner: mkRunner({ id: 'b1', model: 'g1/a' }), botId: 'b1', fails: 5, kind: 'transient',
    env: {},
  });
  assert.equal(plain?.slug, 'g2/b', '普通成员（有 model、没锁）应当照常兜底');

  const locked = modelFallback.planFallbackForBot({
    runner: mkRunner({ id: 'b1', model: 'g1/a', lockModel: true }), botId: 'b1', fails: 5, kind: 'transient',
    env: {},
  });
  assert.equal(locked, null, '显式锁定就不切');

  const offMode = modelFallback.planFallbackForBot({
    runner: mkRunner({ id: 'b1', model: 'g1/a' }), botId: 'b1', fails: 5, kind: 'transient',
    env: { ORBIS_MODEL_FALLBACK: 'off' },
  });
  assert.equal(offMode, null, 'off 模式一律不切');
});

await test('★ 6d. #fb 跑完后游标不误前移，且 transcriptFor 能看到 viaFallback 的自身回复', async () => {
  const { transcriptFor } = await import(src('group-prompt.js'));
  const room2 = store.createGroup({ name: '回退上下文组', botIds: [bot.id], leadBotId: bot.id });
  const u1 = store.appendMessage({
    roomId: room2.id, authorType: 'user', authorName: '用户', text: '帮我看下这个仓库', status: 'done',
  });
  // 模拟「那一轮跑在 #fb 内存会话里」：游标不动，自身回复带 viaFallback
  store.appendMessage({
    roomId: room2.id, authorType: 'bot', authorId: bot.id, authorName: bot.name,
    text: '看了，是 Node 项目', status: 'done', meta: { viaFallback: true },
  });
  assert.equal(store.seenCursor(room2.id, bot.id), null, '这一轮不该推进游标');

  const fresh = transcriptFor(room2.id, bot.id, 30, { store });
  const own = fresh.filter((m) => m.authorId === bot.id);
  assert.equal(own.length, 1, '自身的回退回复必须出现在下一轮上下文里');
  assert.equal(own[0].meta.viaFallback, true);
  assert.ok(fresh.some((m) => m.id === u1.id), '那条用户消息也要还在（游标没前移）');

  // 普通（非 viaFallback）的自身回复仍然不进上下文
  store.appendMessage({
    roomId: room2.id, authorType: 'bot', authorId: bot.id, authorName: bot.name,
    text: '普通回复不应重读', status: 'done',
  });
  const again = transcriptFor(room2.id, bot.id, 30, { store });
  assert.equal(again.filter((m) => m.authorId === bot.id).length, 1, '普通自身回复不该被放进来');
});

await test('★ 6e. 上下文压缩期间不判 model-idle（暂停计时）', async () => {
  // compaction_start → idle.pause()；compaction_end → idle.resume()
  // 这里直接验证守卫的语义（turn-executor 里就是这两句）：
  const g = createModelIdleGuard({ limitMs: 80, onIdle: () => { g.hit = true; } });
  g.arm();
  g.pause();                       // == compaction_start
  await sleep(200);                // 压缩比阈值久得多
  assert.ok(!g.fired, '压缩期间不该判 model-idle');
  g.resume();                      // == compaction_end
  await sleep(30);
  assert.ok(!g.fired, '恢复后重新起算');
  await sleep(120);
  assert.ok(g.fired, '恢复之后真的没动静才判');
});

// ---------------------------------------------------------------------------
// 7. 上游超时 / 断流不得被当成「用户终止」（否则 T6 护栏直接判死）
// ---------------------------------------------------------------------------

await test('★ 7a. TimeoutError / Stream aborted by upstream 都不判 aborted', async () => {
  const { modelFailure } = await import(src('model-reply.js'));
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const f1 = modelFailure(timeout);
  assert.ok(!f1.aborted, '超时不是用户终止（否则一次超时会永久判死）');
  assert.equal(f1.timedOut, true, '要如实标成超时');
  assert.notEqual(f1.error, '已终止');

  const f2 = modelFailure(new Error('Stream aborted by upstream'));
  assert.ok(!f2.aborted, '上游断流不是用户终止');

  const f3 = modelFailure(Object.assign(new Error('late'), { status: 504 }));
  assert.equal(f3.timedOut, true, '504 是超时');

  // 真用户中止仍然认
  assert.equal(modelFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })).aborted, true, '结构化中止仍要认');
  assert.equal(modelFailure(new Error('已按你的要求终止')).aborted, true);
});

await test('★ 7b. 同样的失败不触发 T6 不可恢复快停；真中止仍立刻快停', async () => {
  const { classifyNonRetriableFailure } = await import(src('tasks/task-guardrails.js'));
  for (const error of ['The operation was aborted due to timeout', 'Stream aborted by upstream']) {
    assert.equal(classifyNonRetriableFailure({ error }), null, `不该判死：${error}`);
  }
  assert.equal(classifyNonRetriableFailure({ stop: 'cancelled', error: 'x' })?.kind, 'aborted');
  assert.equal(classifyNonRetriableFailure({ error: '已按你的要求终止' })?.kind, 'aborted');
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`上游快判：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
