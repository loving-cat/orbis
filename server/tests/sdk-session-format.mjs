/**
 * 会话文件契约（路线图 §4 T2.7）：`docs/SDK-SESSION-FORMAT.md` 说的事是不是真的。
 *   node tests/sdk-session-format.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **文档里的示例是能加载的**：直接从那篇 markdown 里把 `session-example`
 *    代码块抠出来，喂给真的 `SessionManager.open()` —— 文档写错就红。
 *    （这条比"再抄一份 fixture 到测试里"强：抄一份就等于允许两边慢慢不一样。）
 * 2. **答出来的上下文与文档一致**：两条消息按顺序、`model_change` 进了模型选择、
 *    不认识的 entry / 坏行被跳过而不是让整条会话打不开。
 * 3. **runtime 找会话靠 `state.json` 里的映射，不靠文件名**：
 *    `store.setSessionFile()` 之后建会话必须走 `SessionManager.open(那个路径)`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeMockModelRuntimeFactory, makeMockSessionApi } from './helpers/sdk-mock.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-session-format-'));
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

const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const sdk = await import('../src/sdk/index.js');
const { createStore } = await import('../src/store.js');

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

/**
 * 从文档里抠出示例 JSONL。
 *
 * 为什么这么做：会话格式的"事实源"必须是文档本身。测试里再维护一份 fixture，
 * 早晚会出现"文档说 A、代码做 B、测试验 C"的三方不一致。
 */
function exampleFromDoc() {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'SDK-SESSION-FORMAT.md'), 'utf8');
  const start = doc.indexOf('<!-- session-example:start -->');
  const end = doc.indexOf('<!-- session-example:end -->');
  assert.ok(start >= 0 && end > start, '文档里找不到 session-example 标记');
  const block = doc.slice(start, end);
  // ★ `\r?\n` 不是洁癖：Windows runner checkout 出来是 CRLF，只写 `\n`
  //   会让这条在 CI 上直接崩（本地 LF 环境完全看不到）。
  const fenced = /```jsonl\r?\n([\s\S]*?)```/.exec(block);
  assert.ok(fenced, '示例块必须是 ```jsonl 围栏');
  return fenced[1].trimEnd().replace(/\r\n/g, '\n');
}

const SAMPLE = exampleFromDoc();

function writeSession(rel, lines) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'demo.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

await test('文档里的示例是合法 JSONL，且第一行是会话头（version 3）', () => {
  const lines = SAMPLE.split('\n');
  assert.ok(lines.length >= 3, '示例至少要有头 + 两条消息');
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'session');
  assert.equal(header.version, 3);
  assert.equal(typeof header.id, 'string');
  assert.equal(typeof header.cwd, 'string');
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line);
    assert.equal(typeof entry.id, 'string', `entry 缺 id：${line.slice(0, 60)}`);
    assert.ok('parentId' in entry, `entry 缺 parentId：${line.slice(0, 60)}`);
    assert.equal(typeof entry.timestamp, 'string');
  }
});

await test('按文档手搓的文件能被真的 SessionManager 加载，消息顺序与内容一致', () => {
  const file = writeSession('load', SAMPLE.split('\n'));
  const sm = SessionManager.open(file);
  const ctx = sm.buildSessionContext();
  assert.equal(ctx.messages.length, 2, '示例里有两条消息');
  assert.equal(ctx.messages[0].role, 'user');
  assert.equal(ctx.messages[0].content[0].text, '你好，先看下 server/src/http.js 的鉴权。');
  assert.equal(ctx.messages[1].role, 'assistant');
  assert.match(ctx.messages[1].content[0].text, /nonce/);
});

await test('`model_change` 会被当成"当前模型"，但不进消息列表', () => {
  const file = writeSession('model-change', SAMPLE.split('\n'));
  const ctx = SessionManager.open(file).buildSessionContext();
  assert.deepEqual(ctx.model, { provider: 'offline', modelId: 'demo-1' });
  assert.equal(ctx.messages.some((m) => m.type === 'model_change'), false);
});

await test('坏行 / 未知 entry / 不认识的 version 都不会让会话打不开', () => {
  const lines = SAMPLE.split('\n');
  const lastId = JSON.parse(lines.at(-1)).id;
  // 末尾追加：一条解析不了的（没有 id，不改变叶子）、一条未知 type 但**挂在链上**的
  lines.push('{ this is not json');
  lines.push(JSON.stringify({
    type: 'weird_future_entry', id: 'ffff0001', parentId: lastId, timestamp: new Date().toISOString(),
  }));
  const file = writeSession('tolerant', lines);
  const ctx = SessionManager.open(file).buildSessionContext();
  assert.equal(ctx.messages.length, 2, '坏行与未知 type 都不该变成消息');

  // version 不匹配也一样能读（pi 是宽容的：历史不能因为版本号打不开）
  const old = SAMPLE.split('\n');
  const header = JSON.parse(old[0]);
  old[0] = JSON.stringify({ ...header, version: 2 });
  const ctx2 = SessionManager.open(writeSession('old-version', old)).buildSessionContext();
  assert.equal(ctx2.messages.length, 2);
});

await test('runtime 靠 state.json 的映射找会话：登记过的文件走 open，不是 create', async () => {
  const file = writeSession('wired', SAMPLE.split('\n'));
  const state = { behavior: 'reply' };
  // 不能用内存 store：内存模式（T2.3）故意全走 SessionManager.inMemory，根本不碰盘
  const dataDir = path.join(root, 'wired', 'data');
  const rt = await sdk.createOrbisRuntime({
    dataDir,
    workspace: path.join(root, 'wired', 'workspace'),
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(root, 'wired', 'agent')),
  });
  try {
    const chief = rt.store.mainBot();
    const dm = rt.store.ensureDm(chief.id);
    // ★ 这就是文档里"接上已有会话"的两行
    rt.store.setSessionFile(dm.id, chief.id, file);
    assert.equal(rt.store.sessionFileFor(dm.id, chief.id), file);

    await rt.askMain('接着刚才那条说');
    assert.equal(state.sessionManagerCalls?.open, 1, '登记过的会话必须走 SessionManager.open');
    assert.equal(state.sessionManagerCalls?.create ?? 0, 0, '登记过就不该新建会话文件');
  } finally {
    await rt.dispose();
  }
});

await test('没登记的会话走 create（新会话），并且文件名由 pi 决定、不靠猜', async () => {
  const state = { behavior: 'reply' };
  const dataDir = path.join(root, 'fresh', 'data');
  const rt = await sdk.createOrbisRuntime({
    dataDir,
    workspace: path.join(root, 'fresh', 'workspace'),
    defaultModel: 'mock/fast-1',
    modelRuntimeFactory: makeMockModelRuntimeFactory(),
    sessionApi: makeMockSessionApi(state, path.join(root, 'fresh', 'agent')),
  });
  try {
    await rt.askMain('第一次说话');
    assert.equal(state.sessionManagerCalls?.create, 1);
    assert.equal(state.sessionManagerCalls?.open ?? 0, 0);
  } finally {
    await rt.dispose();
  }
});

console.log(`\nsdk-session-format: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
