/**
 * SDK 六类注入点（路线图 §4 T2.3）：`config` / `store` / `bus` / `modelRuntime` /
 * `resourceLoader` / `tools`。
 *   node tests/sdk-injection.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **默认值 = 现有行为**：这些字段全都不传时，`createOrbisRuntime` 走的是和
 *    以前逐字节一样的路（room dir / state.json / 自建模型运行时 / 默认 loader）。
 * 2. **传了就真的用**：不是"收下了但没用"。每一项都断言到"底层确实拿到了"。
 * 3. **谁建谁拆**：注入的 store / bus 归宿主所有 —— `dispose()` 之后宿主的监听
 *    还在（共享 bus 被 `removeAllListeners()` 一下就会把别的 runtime 一起干掉）。
 * 4. **`memory: true` 是真的不吃盘**：连数据目录都不建。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMockModelRuntimeFactory, makeMockSessionApi } from './helpers/sdk-mock.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-sdk-injection-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ORBIS_HOME = path.join(root, 'home-data');
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const sdk = await import('../src/sdk/index.js');
const { createConfig, isConfigObject } = await import('../src/config.js');
const { createStore } = await import('../src/store.js');
const { createBus } = await import('../src/bus.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

function makeDirs(tag) {
  const base = path.join(root, tag);
  const dataDir = path.join(base, 'data');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { base, dataDir, workspace };
}

/** 递归数文件（目录不算）：用来断言"真的没写盘" */
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

async function makeRuntime(tag, options = {}) {
  const dirs = makeDirs(tag);
  const state = { behavior: 'reply' };
  const runtime = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    userName: 'Tester',
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(dirs.base, 'agent')),
    ...options,
  });
  return { runtime, state, dirs };
}

// ---------------------------------------------------------------- ① config

await test('config：`createConfig()` 产出的整份配置被认出，字段生效且不是"字段覆盖"', async () => {
  const dirs = makeDirs('config-full');
  const full = createConfig({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    userName: 'Branded',
    chiefTools: ['read', 'grep'],
    ensureDirs: false,
  });
  assert.equal(isConfigObject(full), true, 'createConfig() 的结果必须带品牌标记');
  assert.equal(isConfigObject({ dataDir: dirs.dataDir }), false, '普通对象不算整份配置');

  const rt = await sdk.createOrbisRuntime({
    config: full,
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
  });
  try {
    assert.deepEqual(rt.config.chiefTools, ['read', 'grep'], '整份配置的字段必须原样生效');
    assert.equal(rt.config.userName, 'Branded');
    assert.equal(rt.config.dataDir, path.resolve(dirs.dataDir));
    // 走过的仍是 createConfig（会重新打标），所以还能被下一次注入认出来
    assert.equal(isConfigObject(rt.config), true);
  } finally {
    await rt.dispose();
  }
});

await test('config：老写法（字段覆盖）行为不变，dataDir / workspace 覆盖仍优先', async () => {
  const dirs = makeDirs('config-partial');
  const rt = await sdk.createOrbisRuntime({
    config: { confidenceThreshold: 0.9, userName: 'Partial' },
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
  });
  try {
    assert.equal(rt.config.confidenceThreshold, 0.9);
    assert.equal(rt.config.dataDir, path.resolve(dirs.dataDir));
    assert.equal(rt.config.workspace, path.resolve(dirs.workspace));
  } finally {
    await rt.dispose();
  }
});

// ---------------------------------------------------------------- ② store

await test('store：内存实现一个字节都不写盘（state / rooms / taskruns / run-stats）', async () => {
  const base = path.join(root, 'store-memory');
  const dataDir = path.join(base, 'data'); // 故意不创建
  const workspace = path.join(base, 'workspace');
  const memory = createStore({ memory: true, dataDir });
  assert.equal(fs.existsSync(dataDir), false, '内存 store 不该建数据目录');

  const state = { behavior: 'reply' };
  const rt = await sdk.createOrbisRuntime({
    store: memory,
    dataDir,
    workspace,
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(base, 'agent')),
  });
  assert.equal(rt.store, memory, '注入的 store 必须就是运行用的那一个');
  await rt.askMain('在内存里跑一轮');
  assert.equal(countFiles(dataDir), 0, `内存模式写盘了：${JSON.stringify(fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [])}`);
  assert.equal(rt.runner.stats.file, '', '内存模式下 run-stats 不该落盘');
  memory.saveNow(); // 内存下是空操作，不该炸也不该建目录
  assert.equal(memory.flushNow().ok, true);
  await rt.dispose();
  assert.equal(fs.existsSync(dataDir), false, 'dispose 也不该建目录');
});

await test('store：不传时仍然是真实 store（state.json 落盘，老行为）', async () => {
  const { runtime: rt, dirs } = await makeRuntime('store-default');
  await rt.askMain('跑一轮');
  assert.equal(rt.store.memory, false);
  await rt.dispose(); // 写盘是节流的，dispose 会写净
  assert.ok(fs.existsSync(path.join(dirs.dataDir, 'state.json')), '默认 store 必须照旧写 state.json');
});

// ---------------------------------------------------------------- ③ bus

await test('bus：注入的总线能收到事件，且 dispose 不会清掉宿主的监听', async () => {
  const dirs = makeDirs('bus-shared');
  const bus = createBus();
  let hostEvents = 0;
  const hostListener = () => { hostEvents++; };
  bus.on('event', hostListener);

  const rt = await sdk.createOrbisRuntime({
    bus,
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
  });
  try {
    assert.equal(rt.bus, bus, '注入的 bus 必须就是运行用的那一个');
    await rt.askMain('跑一轮');
    assert.ok(hostEvents > 0, '宿主在注入的 bus 上应该能收到事件');
  } finally {
    await rt.dispose();
  }
  assert.ok(
    bus.listeners('event').includes(hostListener),
    'dispose 之后宿主的监听必须还在（共享总线上的别的 runtime 不能被顺手拆掉）',
  );
  bus.off('event', hostListener);
});

// ---------------------------------------------------------------- ④ modelRuntime

await test('modelRuntime：传实例就跳过自建，factory 一次都不调', async () => {
  const dirs = makeDirs('model-runtime');
  const instance = await makeMockModelRuntimeFactory()();
  let factoryCalls = 0;
  const rt = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    defaultModel: 'mock/fast-1',
    modelRuntime: instance,
    modelRuntimeFactory: async () => {
      factoryCalls++;
      return makeMockModelRuntimeFactory()();
    },
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
  });
  try {
    assert.equal(rt.runner.modelRuntime, instance, '应该直接用注入的实例');
    assert.equal(factoryCalls, 0, '注入了实例就不该再调 factory');
  } finally {
    await rt.dispose();
  }
});

// ---------------------------------------------------------------- ⑤ resourceLoader

await test('resourceLoader：工厂按会话被调用，拿到的默认参数与默认路径一致', async () => {
  const dirs = makeDirs('loader');
  const seen = [];
  const rt = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
    resourceLoader: (defaults) => {
      seen.push(defaults);
      return {
        defaults,
        async reload() {},
        dispose() {},
      };
    },
    // 只有建会话时才会调工厂
  });
  try {
    assert.equal(seen.length, 0, '建 runtime 本身不该造 loader');
    await rt.askMain('跑一轮');
    assert.ok(seen.length >= 1, '建会话时必须调注入的工厂');
    const defaults = seen[0];
    assert.equal(defaults.cwd, path.resolve(dirs.workspace), '默认参数要带 workspace');
    assert.ok(Array.isArray(defaults.extensionFactories), '策略/MCP 扩展仍要传进去（注入的是“怎么造”，不是“不要扩展”）');
    // pi 的 appendSystemPrompt 收 string 或 string[]，本项目产的是数组
    assert.ok(
      Array.isArray(defaults.appendSystemPrompt) || typeof defaults.appendSystemPrompt === 'string',
      '注入工厂拿到的参数要是完整的一套（appendSystemPrompt 缺失就说明默认值被拆错了）',
    );
  } finally {
    await rt.dispose();
  }
});

await test('resourceLoader：传了非函数 → E_INVALID_ARGUMENT（不静默忽略）', async () => {
  const dirs = makeDirs('loader-bad');
  await assert.rejects(
    () => sdk.createOrbisRuntime({
      dataDir: dirs.dataDir,
      workspace: dirs.workspace,
      modelRuntimeFactory: makeMockModelRuntimeFactory(),
      sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
      resourceLoader: { reload() {} },
    }),
    (err) => err?.code === 'E_INVALID_ARGUMENT',
  );
});

// ---------------------------------------------------------------- ⑥ tools

await test('tools：customTools 进会话、tools 追加启用名，且都过角色/policy 同一道过滤', async () => {
  const dirs = makeDirs('tools');
  const state = { behavior: 'reply' };
  const hostTool = {
    name: 'host_probe',
    description: '宿主注入的探针工具',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const rt = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(dirs.base, 'agent')),
    customTools: [hostTool],
    tools: ['host_only_tool'],
  });
  try {
    await rt.askMain('跑一轮');
    const opts = state.sessionOptions?.at(-1);
    assert.ok(opts, '应该建过会话');
    assert.ok(
      opts.customTools.some((t) => t.name === 'host_probe'),
      '宿主工具必须出现在 customTools 里',
    );
    assert.ok(
      opts.tools.includes('host_probe'),
      '宿主工具的启用名必须出现在 tools 里（否则工具对象挂上了也不会被调）',
    );
    assert.ok(opts.tools.includes('host_only_tool'), '追加启用的内置工具要并进 tools');
  } finally {
    await rt.dispose();
  }
});

await test('tools：不传时工具集与之前完全一致（基线快照）', async () => {
  const { runtime: rt, state } = await makeRuntime('tools-baseline');
  try {
    await rt.askMain('跑一轮');
    const opts = state.sessionOptions?.at(-1);
    assert.ok(opts, '应该建过会话');
    assert.equal(
      opts.customTools.some((t) => t.name === 'host_probe'),
      false,
      '没注入就不该凭空多出宿主的工具',
    );
    assert.equal(opts.tools.includes('host_only_tool'), false, '没注入就不该凭空多启用内置工具');
  } finally {
    await rt.dispose();
  }
});

// ---------------------------------------------------------------- 回归：六类全关

await test('六类全不传：默认路径照旧（自建 store/bus/modelRuntime，modelRuntimeFactory 被调）', async () => {
  const dirs = makeDirs('all-default');
  let factoryCalls = 0;
  const rt = await sdk.createOrbisRuntime({
    dataDir: dirs.dataDir,
    workspace: dirs.workspace,
    modelRuntimeFactory: async () => {
      factoryCalls++;
      return makeMockModelRuntimeFactory()();
    },
    sessionApi: makeMockSessionApi({ behavior: 'reply' }, path.join(dirs.base, 'agent')),
  });
  try {
    assert.equal(factoryCalls, 1, '没注入实例时必须调 factory');
    assert.equal(rt.store.memory, false);
    assert.equal(typeof rt.bus.on, 'function');
  } finally {
    await rt.dispose();
  }
});

console.log(`\nsdk-injection: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
