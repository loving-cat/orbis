/**
 * 会话 `appendSystemPrompt` **类型**回归（真 DefaultResourceLoader，不 mock）：
 *   node tests/session-append-array.mjs
 *
 * ## 真机现场（P0）
 *
 * 群里后台有成员在干活时，用户继续发消息走全双工旁路（Talk Lane），负责人 35ms 内报
 * 「模型请求失败，接口详情已隐藏」，`model-errors.jsonl` 的 detail 是：
 *
 *     appendSources.map is not a function
 *
 * ## 根因
 *
 * 1. `system-prompt.buildAppendSystemPrompt()` 返回 **`string[]`**；
 * 2. SDK 的 `DefaultResourceLoader.reload()` 强要求 `appendSystemPrompt` 是数组，
 *    它第一件事就是 `appendSources.map((s) => resolvePromptInput(s, ...))`；
 * 3. `session-factory.js` 在 Talk / Critic 两条隔离通道里用**模板字符串**拼它
 *    （`` `${baseAppendPrompt}\n\n## …规则\n` ``），`string[]` 被隐式转成「逗号拼接的
 *    单个字符串」—— 类型上看不出来，运行时 100% 在 reload 阶段抛。
 *
 * ## 这个用例为什么以前抓不到
 *
 * 既有用例（`full-duplex.mjs` 的 FD-1 等）为了隔离副作用，把 `DefaultResourceLoader`
 * 整个换成了假对象（只记 options、reload 里手工调 extensionFactories）——`reload()`
 * 里那段 `.map()` 根本没被执行过，所以类型错误全绿。
 *
 * 所以这里**只用真的 loader、真的跑 reload()**，只把 `createAgentSession` 换成
 * 不发网络的替身，用它把建好的 loader 捞出来断言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-append-array-'));
const wsDir = path.join(root, 'workspace');
const agentDir = path.join(root, 'agent');
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: agentDir,
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: wsDir,
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
  ORBIS_TASK_INTAKE: '0',
  ORBIS_WATCH_CHANGES: '0',
  ORBIS_AUTO_ATTACH: '0',
  ORBIS_AUTO_ATTACH_FILES: '0',
  // 资源发现全部关掉：这一条用例只看 append prompt，不想让技能/MCP/扩展读盘
  ORBIS_EXTENSIONS: '0',
  ORBIS_MCP: '0',
  ORBIS_SKILLS: '0',
});
globalThis.fetch = () => { throw new Error('test forbids network'); };

const sdk = await import('@earendil-works/pi-coding-agent');
const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { createSessionBuilder } = await import('../src/session-factory.js');

const TALK_RULE = '## 全双工快速旁路通道规则';
const CRITIC_RULE = '## 独立评审（Critic）通道规则';
const TYPE_ERROR = /appendSources\.map is not a function/;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`✗ ${name}\n    ${err?.message ?? err}`);
  }
}

function makeRunner() {
  const runner = new PiRunner();
  runner.model = null;
  runner.memoryAutoDisabled = true;
  runner.modelRuntime = null;
  return runner;
}

/**
 * 用**生产装配**建一个会话，只把 `createAgentSession` 换成替身：
 * · 其余 `sessionApi` 全部来自真 SDK（含真 DefaultResourceLoader / SessionManager）；
 * · 替身只是把 `options` 记下来并返回一个最小 session，绝不发网络。
 */
async function buildLane(opts = {}, { resourceLoaderFactory = null } = {}) {
  const bot = store.createBot({ name: `lane-${results.length}-${Math.random().toString(36).slice(2, 7)}` });
  const dm = store.ensureDm(bot.id);
  const runner = makeRunner();
  let captured = null;
  const builder = createSessionBuilder({
    runner,
    health: null,
    resolveModel: () => null,
    modelLabel: () => '',
    ...(resourceLoaderFactory ? { resourceLoaderFactory } : {}),
    sessionApi: {
      ...sdk,
      async createAgentSession(options) {
        captured = options;
        return {
          session: {
            model: null,
            sessionFile: null,
            settingsManager: { applyOverrides() {} },
            subscribe() { return () => {}; },
            dispose() {},
          },
          modelFallbackMessage: '',
        };
      },
    },
  });
  const built = await builder(dm.id, bot.id, opts);
  assert.ok(captured, 'createAgentSession 必须被调用（替身没被接上？）');
  assert.ok(captured.resourceLoader, '必须把 resourceLoader 传进 createAgentSession');
  // ★ 关键：真的 DefaultResourceLoader（不是替身），且 reload() 已经真实跑过
  assert.ok(
    captured.resourceLoader instanceof sdk.DefaultResourceLoader,
    'resourceLoader 必须是真实的 DefaultResourceLoader（本用例禁止 mock）',
  );
  return { built, captured, loader: captured.resourceLoader };
}

/** 三条通道共用的断言：数组类型 + reload 后拿到预期规则段落。 */
function assertAppendShape(loader, { expect, forbid = [] }) {
  // ① 传进 DefaultResourceLoader 的就是数组（真机崩的就是它不是数组）
  assert.ok(
    Array.isArray(loader.appendSystemPromptSource),
    `appendSystemPrompt 必须是数组，实际拿到 ${typeof loader.appendSystemPromptSource}：` +
      `${String(loader.appendSystemPromptSource).slice(0, 60)}…`,
  );
  assert.ok(loader.appendSystemPromptSource.every((s) => typeof s === 'string'), '数组元素必须都是字符串');
  // ② reload() 之后解析出来的也是数组（旧代码在这一步抛 appendSources.map）
  assert.ok(Array.isArray(loader.appendSystemPrompt), 'reload() 之后 appendSystemPrompt 必须是数组');
  const text = loader.appendSystemPrompt.join('\n\n');
  for (const needle of expect) {
    assert.ok(text.includes(needle), `append prompt 应包含「${needle}」，实际：${text.slice(0, 200)}…`);
  }
  for (const needle of forbid) {
    assert.ok(!text.includes(needle), `append prompt 不该包含「${needle}」`);
  }
}

await test('SA-1 普通通道：appendSystemPrompt 是数组，reload() 不抛，且无旁路/评审规则', async () => {
  const { loader } = await buildLane();
  assertAppendShape(loader, { expect: [], forbid: [TALK_RULE, CRITIC_RULE] });
  // 普通通道仍要把人设/规矩带上（不是被这次修复搞空了）
  assert.ok(loader.appendSystemPrompt.length > 0, '普通通道的 append prompt 不能为空');
});

await test('SA-2 Talk 通道（talkLane: true）：数组追加，不抛，含「全双工快速旁路通道规则」', async () => {
  const { loader } = await buildLane({ talkLane: true });
  assertAppendShape(loader, { expect: [TALK_RULE], forbid: [CRITIC_RULE] });
  // 基础段落还在（数组追加，不是替换）
  assert.ok(loader.appendSystemPromptSource.length >= 2, 'Talk 通道应是「基础段落 + 规则」至少两条');
});

await test('SA-3 Critic 通道（criticLane: true）：数组追加，不抛，含「独立评审（Critic）通道规则」', async () => {
  const { loader } = await buildLane({ criticLane: true });
  assertAppendShape(loader, { expect: [CRITIC_RULE], forbid: [TALK_RULE] });
  assert.ok(loader.appendSystemPromptSource.length >= 2, 'Critic 通道应是「基础段落 + 规则」至少两条');

  // 优先级不变：两条都为 true 时 Critic 胜（它比旁路更严）
  const both = await buildLane({ talkLane: true, criticLane: true });
  assertAppendShape(both.loader, { expect: [CRITIC_RULE], forbid: [TALK_RULE] });
});

await test('SA-4 反向验证 a：字符串 appendSystemPrompt 在真 reload() 里必抛 appendSources.map', async () => {
  // 旧代码交给 loader 的正是这种形态：`string[]` 被模板字符串拼成一个逗号串
  const loader = new sdk.DefaultResourceLoader({
    cwd: wsDir,
    agentDir,
    noExtensions: true,
    noMcp: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: ['你是助手', `${TALK_RULE}\n只读旁路`].join(','),
  });
  await assert.rejects(() => loader.reload(), TYPE_ERROR);
});

await test('SA-5 反向验证 b：把旧形态塞回装配（talkLane / criticLane）→ 建会话必抛同一个错', async () => {
  // 用 resourceLoaderFactory 重建旧代码的产物：真 loader + 被拼成字符串的 append prompt。
  // 这样 reload() 仍在 builder 内部真实执行 —— 如果修复回退，这两条会立刻红。
  const legacyFactory = (defaults) => new sdk.DefaultResourceLoader({
    ...defaults,
    appendSystemPrompt: Array.isArray(defaults.appendSystemPrompt)
      ? defaults.appendSystemPrompt.join(',')
      : defaults.appendSystemPrompt,
  });
  for (const opts of [{ talkLane: true }, { criticLane: true }]) {
    await assert.rejects(() => buildLane(opts, { resourceLoaderFactory: legacyFactory }), TYPE_ERROR);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
if (failed.length) {
  for (const f of failed) console.error(`失败：${f.name}\n${f.err?.stack ?? f.err}`);
  process.exit(1);
}
