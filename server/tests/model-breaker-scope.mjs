/**
 * 熔断按「模型」隔离，不连坐同组活模型（GA 前置模型接入层缺陷）。
 *   node tests/model-breaker-scope.mjs
 *
 * ## 修的是什么
 *
 * 以前 `runner.breakers` 的 key 是**模型组**。于是：
 *   · 组里配置了一个已下线的模型 ID → 404 → 整组熔断 → 同组的健康模型也一起停；
 *   · 熔断打开还会顺手把**整组**的端点轮转走 —— 同组健康模型跟着换了接口；
 *   · C2 评审 / C3 分级选模拿 `breakers.get(groupId)` 判断，只能看到"组是否坏"，
 *     看不到"同组里 A 死 B 活"，于是一个死模型就能把整个候选池拖下水。
 *
 * 现在 key = 完整 slug（`groupId/modelId`）；两个纯辅助函数在
 * `circuit-breaker.js` 里（`breakerKeyOf` / `clearBreakersForGroup`），
 * 保证 `pi-runner.js` 的行数预算不被撑爆。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-breaker-scope-'));
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
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { PiRunner } = await import(src('pi-runner.js'));
const { selectCriticModel } = await import(src('tasks/task-critic.js'));
const { selectTierModel } = await import(src('tasks/task-model-tier.js'));
const { BREAKER_STATE } = await import(src('circuit-breaker.js'));

let pass = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err: err?.message || String(err) });
    console.log(`✗ ${name}: ${err?.message || err}`);
  }
}

/**
 * 一个只有熔断相关面的 PiRunner：
 *   · `modelGroups` 提供 g1（两个端点 → 可轮转）与 g2（单端点）；
 *   · `modelRuntime.registerProvider` 被记账（端点轮转是否发生就看它）。
 */
function breakerHarness() {
  const bot = store.createBot({ name: '熔断成员', persona: '测试' });
  store.updateBot(bot.id, { model: 'g1/dead-model' });
  const runner = new PiRunner();
  const registers = [];
  runner.modelGroups = {
    get: (id) => {
      if (id === 'g1') {
        return {
          id: 'g1',
          name: '坏组',
          endpoints: [{ baseUrl: 'https://a' }, { baseUrl: 'https://b' }],
          toProviderConfig: (i) => ({ baseUrl: `https://e${i}` }),
        };
      }
      if (id === 'g2') {
        return { id: 'g2', name: '好组', endpoints: [{ baseUrl: 'https://g2' }], toProviderConfig: () => ({}) };
      }
      return null;
    },
    menuEntries: () => [],
    list: () => [],
    toProviderConfigs: () => ({}),
  };
  runner.modelRuntime = {
    registerProvider: (id, cfg) => registers.push({ id, cfg }),
    unregisterProvider: () => {},
    completeSimple: () => assert.fail('不该真的问模型'),
  };
  runner.health = { forgetProvider: () => 0 };
  runner.resolveModel = (slug) => {
    const [provider, id] = String(slug).split('/');
    return { provider, id, contextWindow: 200_000 };
  };
  return { runner, bot, registers };
}

// ---------------------------------------------------------------------------
// 1. 同组不连坐
// ---------------------------------------------------------------------------

await test('★ g1/dead-model 一次 404 就熔断，同组 g1/healthy-model 仍是 closed', async () => {
  const { runner, bot } = breakerHarness();
  const out = runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  assert.equal(out?.state, BREAKER_STATE.open, '404 应当一次就打开熔断');
  assert.equal(runner.breakerFor(bot.id, 'g1/dead-model').breaker.state, BREAKER_STATE.open);
  assert.equal(
    runner.breakerFor(bot.id, 'g1/healthy-model').breaker.state,
    BREAKER_STATE.closed,
    '★ 同组活模型不能被连坐 (key 必须按模型，不是按组)',
  );
  assert.equal(runner.breakerFor(bot.id, 'g2/other').breaker.state, BREAKER_STATE.closed);
  // 键必须是完整 slug，而不是组 id
  assert.equal(runner.breakers.has('g1'), false, 'breakers 里不该再有"组级"key');
  assert.equal(runner.breakers.has('g1/dead-model'), true);
});

await test('★ 单模型 404 绝不触发整组端点轮转（同组健康模型不受牵连）', async () => {
  const { runner, bot, registers } = breakerHarness();
  runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  assert.equal(registers.length, 0, '404 不该把整组切到备用端点');
  assert.equal(runner.endpointCursors.has('g1'), false);

  // 反过来：真的是通路故障（5xx ×3）时照旧轮转，证明这条保护没把功能关掉
  for (let i = 0; i < 3; i += 1) {
    runner.markGroupFailed(bot.id, { kind: 'transient', status: 503, model: 'g1/dead-model' });
  }
  assert.equal(registers.filter((r) => r.id === 'g1').length, 1, '5xx 连续 3 次要轮转端点');
});

await test('★ 改模型组 g1 的配置 → g1 下所有模型的熔断全部清空，g2 不受影响', async () => {
  const { runner, bot } = breakerHarness();
  runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  // 注意：用 transient（不是 auth）—— auth 一次就开熔断，会顺手触发端点轮转把 g1 清掉
  runner.markGroupFailed(bot.id, { kind: 'transient', status: 503, model: 'g1/other-model' });
  runner.markGroupFailed(bot.id, { kind: 'transient', status: 503, model: 'g2/keep-me' });
  assert.equal([...runner.breakers.keys()].length, 3, '前置：三条熔断都在');

  await runner.applyModelGroupChange('g1');

  assert.deepEqual([...runner.breakers.keys()], ['g2/keep-me'], 'g1 的全部清掉，g2 保留');
  assert.equal(runner.breakerFor(bot.id, 'g1/dead-model').breaker.state, BREAKER_STATE.closed, '清完再查是全新 closed');
});

await test('markGroupHealthy 只恢复跑通的那个模型，不动同组其它', async () => {
  const { runner, bot } = breakerHarness();
  runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  runner.markGroupFailed(bot.id, { kind: 'transient', status: 503, model: 'g1/flaky' });
  runner.markGroupHealthy(bot.id, 'g1/flaky');
  assert.equal(runner.breakerFor(bot.id, 'g1/flaky').breaker.fails, 0, '跑通了就该清零');
  assert.equal(runner.breakerFor(bot.id, 'g1/dead-model').breaker.state, BREAKER_STATE.open, '死的还开着');
});

/** 与生产代码同形状的判据（C2/C3 用的就是这个）。 */
const breakerProbe = (runner, botId) => (slug, groupId) => {
  const found = runner.breakerFor?.(botId, slug) ?? null;
  const breaker = found?.breaker
    ?? runner.breakers?.get?.(slug)
    ?? runner.breakers?.get?.(found?.groupId ?? groupId)
    ?? null;
  return breaker?.state === 'open';
};

// ---------------------------------------------------------------------------
// 2. C2 评审选模 / C3 分级选模：同组 A 死 B 活要能选中 B
// ---------------------------------------------------------------------------

const candidates = [
  { slug: 'g1/dead-model', label: '死模型', groupId: 'g1', enabled: true },
  { slug: 'g1/healthy-model', label: '活模型', groupId: 'g1', enabled: true },
  { slug: 'g2/other', label: '别组模型', groupId: 'g2', enabled: true },
];

await test('★ C2 评审选模：g1/dead-model 熔断后跳过它，选中同组 g1/healthy-model', async () => {
  const { runner, bot } = breakerHarness();
  runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  const picked = selectCriticModel({
    executorModel: { slug: 'g1/dead-model', provider: 'g1', model: 'dead-model', local: false },
    candidates,
    isBreakerOpen: breakerProbe(runner, bot.id),
    policyMode: 'cloud',
  });
  assert.notEqual(picked.slug, 'g1/dead-model', '熔断的模型不能当选');
  assert.ok(picked.slug, '同组还有活模型，不该判"没有可用的评审模型"：' + JSON.stringify(picked));
  assert.equal(breakerProbe(runner, bot.id)('g1/healthy-model', 'g1'), false, '活模型的判据必须是关闭');
});

await test('★ C3 分级选模：熔断的是那一个模型，不是整组', async () => {
  const { runner, bot } = breakerHarness();
  runner.markGroupFailed(bot.id, { kind: 'model-not-found', status: 404, model: 'g1/dead-model' });
  const probe = breakerProbe(runner, bot.id);
  const base = { slug: 'g1/base', provider: 'g1', model: 'base' };

  // ① 同组还有活模型 → 显式档位可以选它（组没被整体判死）
  const healthy = selectTierModel({
    tier: 'strong',
    baseModel: base,
    candidates,
    isBreakerOpen: probe,
    explicitTierModels: { strong: 'g1/healthy-model' },
  });
  assert.equal(healthy.overrideModel, 'g1/healthy-model', '同组活模型必须能被选中：' + JSON.stringify(healthy));

  // ② 指定那个死模型 → 池子里没有它（被自己的熔断挡住），如实说明不可用
  const dead = selectTierModel({
    tier: 'strong',
    baseModel: base,
    candidates,
    isBreakerOpen: probe,
    explicitTierModels: { strong: 'g1/dead-model' },
  });
  assert.equal(dead.overrideModel, null, '熔断的模型不能被选中');
  assert.equal(dead.rejected, 'explicit_unavailable', '要说清是「不可用」而不是别的原因：' + JSON.stringify(dead));
});

// ---------------------------------------------------------------------------
// 3. 源码守卫：两处 isBreakerOpen 必须先读模型级熔断
// ---------------------------------------------------------------------------

await test('★ C2/C3 的 isBreakerOpen 都优先读 found?.breaker（而不是组）', async () => {
  for (const rel of ['tasks/task-critic-runner.js', 'tasks/task-runtime.js']) {
    const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', rel), 'utf8');
    assert.match(text, /found\?\.breaker/, `${rel} 要先读模型级熔断`);
    assert.match(text, /breakerFor\?\.\(botId,\s*slug\)/, `${rel} 要按候选模型 slug 查`);
  }
});

console.log(`\n熔断按模型隔离：${pass}/${pass + fail} 通过`);
if (fail) {
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.err}`);
  process.exit(1);
}
process.exit(0);
