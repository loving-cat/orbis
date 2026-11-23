/**
 * 模型失败诊断日志（Mac 实机 UX-4）。
 *   node tests/diagnostics-log.mjs
 *
 * ## 守什么
 *
 * 1. **脱敏**：Bearer / sk-… / api_key=… / token 一律打码 —— 这些记录会进 App、
 *    进 `model-errors.jsonl`，还可能被用户原样贴进公开 issue。
 * 2. **有界**：内存最多 200 条；落盘文件超上限轮转一次，不无限长。
 * 3. **只读可见**：`GET /api/diagnostics/logs` 带常规鉴权，返回模型异常 + server.log 尾部。
 * 4. **零写盘（memory）**：测试 / 内存模式下不创建任何文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-diag-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
Object.assign(process.env, {
  ORBIS_HOME: dataDir,
  ORBIS_WORKSPACE: path.join(root, 'ws'),
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  ORBIS_PROBE: '0',
});
fs.mkdirSync(process.env.ORBIS_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  createDiagnosticsLog, MODEL_ERROR_LIMIT, MODEL_ERROR_FILE, serverLogTail,
} = await import(src('diagnostics-log.js'));
const { formatFailureDetail, redactDiagnostic } = await import(src('model-reply.js'));

const results = [];
let tests = Promise.resolve();
function test(name, fn) {
  tests = tests.then(async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, err: err?.message || String(err) });
    }
  });
}

// 假密钥：**运行时拼出来**，源码里不留完整 key 形状（secret scan 会当成泄漏）
const SECRET = ['sk', 'fakefake', 'notreal123'].join('-');
const BEARER = `Bearer ${'ya29'}.totally-not-real`;

test('★ 脱敏：Bearer / sk- / api_key= / token= 全部打码', () => {
  const out = redactDiagnostic(
    `auth ${BEARER} key ${SECRET} api_key=zzz111 token=${SECRET} x-api-key: kkk-222`,
  );
  assert.equal(out.includes(SECRET), false, `密钥漏出来了：${out}`);
  assert.equal(out.includes('ya29.totally-real-token'), false, `Bearer 漏出来了：${out}`);
  assert.equal(out.includes('zzz111'), false);
  assert.equal(out.includes('kkk-222'), false);
  assert.match(out, /\[REDACTED\]/);
});

test('formatFailureDetail：状态码 / 网络错误码 / cause / 上游 error 都提取出来', () => {
  const err = Object.assign(new Error(`fetch failed ${SECRET}`), {
    status: 502,
    code: 'ECONNRESET',
    cause: { code: 'UND_ERR_HEADERS_TIMEOUT', message: 'headers timeout' },
    response: { data: { error: { type: 'upstream_error', message: 'bad gateway' } } },
  });
  const detail = formatFailureDetail(err);
  assert.match(detail, /HTTP 502/);
  assert.match(detail, /ECONNRESET/);
  assert.match(detail, /UND_ERR_HEADERS_TIMEOUT/);
  assert.match(detail, /upstream_error/);
  assert.match(detail, /bad gateway/);
  assert.equal(detail.includes(SECRET), false, '详情里不许出现密钥');
  assert.ok(detail.length <= 500, '单条要截断');
});

test('★ message_end 的上游原文要进 detail（不再是"接口详情已隐藏"）', async () => {
  const { modelFailure } = await import(src('model-reply.js'));
  // 真实形态：SDK 把上游 body 塞进 errorMessage，stopReason 是 'error'
  const failure = modelFailure({
    stopReason: 'error',
    errorMessage: `400 invalid_request_error: thinking budget too low (Bearer ${SECRET})`,
  });
  assert.match(failure.detail, /thinking budget too low/, '上游原文必须进 detail');
  assert.match(failure.detail, /400/, '状态码要在');
  assert.equal(failure.detail.includes(SECRET), false, 'detail 里的密钥要打码');
  assert.equal(failure.error.includes('thinking budget'), false, '给人看的那句话保持原样（不塞技术细节）');
});

test('★ 诊断记录里也带 code 与脱敏后的 detail', () => {
  const log = createDiagnosticsLog({ memory: true });
  const item = log.record({
    phase: 'turn',
    code: 'ECONNRESET',
    detail: redactDiagnostic(`HTTP 502 · upstream error: ${SECRET}`),
  });
  assert.equal(item.code, 'ECONNRESET');
  assert.match(item.detail, /HTTP 502/);
  assert.equal(item.detail.includes(SECRET), false);
});

test('记录形状：时间/阶段/房间/Bot/模型/状态码/耗时齐了', () => {
  const log = createDiagnosticsLog({ dataDir, memory: true });
  const item = log.record({
    phase: 'turn',
    roomId: 'r1',
    roomName: '研发部',
    botId: 'b1',
    botName: '编码手',
    model: 'provider/model-a',
    status: 429,
    code: 'rate_limited',
    summary: '模型请求被限流',
    detail: 'HTTP 429',
    ms: 1234,
  });
  assert.equal(item.phase, 'turn');
  assert.equal(item.roomName, '研发部');
  assert.equal(item.status, 429);
  assert.equal(item.ms, 1234);
  assert.ok(item.ts > 0);
  // 未知 phase 会被归一到 turn（不让脏数据进界面）
  assert.equal(log.record({ phase: 'weird' }).phase, 'turn');
});

test('★ 有界：内存只留最近 200 条，recent 最新在前', () => {
  const log = createDiagnosticsLog({ memory: true });
  for (let i = 0; i < MODEL_ERROR_LIMIT + 25; i += 1) {
    log.record({ summary: `第 ${i} 条` });
  }
  const recent = log.recent(500);
  assert.equal(recent.length, MODEL_ERROR_LIMIT, '不能无限长');
  assert.equal(recent[0].summary, `第 ${MODEL_ERROR_LIMIT + 24} 条`, '最新在前');
});

test('memory 模式一个字节都不写', () => {
  const dir = path.join(root, 'memory-only');
  const log = createDiagnosticsLog({ dataDir: dir, memory: true });
  log.record({ summary: 'x' });
  assert.equal(fs.existsSync(dir), false, 'memory 模式不该建目录/文件');
});

test('落盘：写 jsonl、脱敏后再存、超上限轮转一次', () => {
  const dir = path.join(root, 'disk');
  fs.mkdirSync(dir, { recursive: true });
  const log = createDiagnosticsLog({ dataDir: dir });
  log.record({ summary: `auth ${BEARER}`, detail: `key ${SECRET}` });
  const file = path.join(dir, MODEL_ERROR_FILE);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(SECRET), false, '落盘内容也必须脱敏');
  assert.equal(raw.trim().split('\n').length, 1);

  // 把文件撑到上限以上，再写一条 → 应当轮转出 .1
  fs.writeFileSync(file, 'x'.repeat(600 * 1024));
  log.record({ summary: 'after rotate' });
  assert.ok(fs.existsSync(`${file}.1`), '超上限要轮转');
  assert.ok(fs.statSync(file).size < 10 * 1024, '新文件只装新的一条');
});

test('serverLogTail：只读尾部、行数受限、内容二次脱敏', () => {
  const dir = path.join(root, 'logs', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(path.dirname(dir), 'server.log');
  fs.writeFileSync(logFile, [
    'line 1',
    `line 2 with ${SECRET}`,
    ...Array.from({ length: 300 }, (_, i) => `filler ${i}`),
  ].join('\n'));
  const tail = serverLogTail({ dataDir: dir, lines: 5 });
  assert.equal(tail.logPath, logFile);
  assert.equal(tail.lines.length, 5, '只要最后 5 行');
  assert.equal(tail.lines.join('\n').includes(SECRET), false);
  assert.equal(tail.lines.join('\n').includes('filler 299'), true, '应当是文件尾部');
});

test('serverLogTail：文件不存在时返回空数组（不抛）', () => {
  const tail = serverLogTail({ dataDir: path.join(root, 'nope', 'data'), lines: 5 });
  assert.deepEqual(tail.lines, []);
  assert.ok(tail.logPath.endsWith('server.log'));
});

test('★ memory 模式的 PiRunner 零写盘（P2-1）：diagnostics 跟着 store 走', async () => {
  const { PiRunner } = await import(src('pi-runner.js'));
  const { Store } = await import(src('store.js'));
  const memDir = path.join(root, 'memory-runner');
  const memStore = new Store({ memory: true, dataDir: memDir });
  try {
    const runner = new PiRunner({ store: memStore });
    assert.equal(runner.diagnostics.writing, false, 'memory 模式不该写 model-errors.jsonl');
    runner.diagnostics.record({ phase: 'turn', summary: '模拟一次模型报错' });
    runner.diagnostics.record({ phase: 'talk', summary: '再一次' });
    assert.equal(fs.existsSync(path.join(memDir, MODEL_ERROR_FILE)), false, '一个字节都不该写');
    assert.equal(runner.diagnostics.recent(5).length, 2, '内存里仍然要看得到');
    runner.dispose?.();
  } finally {
    memStore.dispose();
  }
});

// ---------------------------------------------------------------- HTTP

const { createHttpServer } = await import(src('http.js'));
const { store } = await import(src('store.js'));
const { Pairing } = await import(src('pairing.js'));

const diagnostics = createDiagnosticsLog({ dataDir, memory: true });
diagnostics.record({
  phase: 'turn',
  roomId: 'r1',
  roomName: '研发部',
  botId: 'b1',
  botName: '编码手',
  model: 'p/m',
  status: 502,
  summary: `上游挂了 ${SECRET}`,
  detail: `HTTP 502 · ${SECRET}`,
  ms: 900,
});

const runner = {
  diagnostics,
  availableModels: [],
  modelLabel: () => null,
  initNote: null,
  send: async () => ({}),
  sessions: new Map(),
  isBusy: () => false,
  stats: null,
  health: null,
  model: 'test',
};
const server = createHttpServer({ runner, pairing: new Pairing() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const { token } = store.addDevice('看日志的手机');

test('★ GET /api/diagnostics/logs 不带 token → 401', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/logs`);
  assert.equal(res.status, 401);
});

test('★ 带设备 token → 返回模型异常 + server.log 尾部，且没有密钥', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/logs?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.modelErrors), '要含 modelErrors');
  assert.ok(Array.isArray(body.serverLogTail), '要含 serverLogTail');
  assert.equal(typeof body.logPath, 'string');
  assert.equal(body.modelErrors[0].phase, 'turn');
  assert.equal(body.modelErrors[0].status, 502);
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(SECRET), false, '接口返回里不许有密钥');
});

test('limit 会被夹在 1..200（不让它变成一次全量导出）', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/logs?limit=9999`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.modelErrors.length <= 200);
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
server.close();
clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
