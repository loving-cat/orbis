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
const {
  shouldSwitchEarly, pickAlternateModel, planFallbackForBot, meetsNeeds, FALLBACK_AFTER_FAILS,
} = await import(src('runner/model-fallback.js'));
const { ENDED_BY } = await import(src('run-stats.js'));

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

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`上游快判：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
