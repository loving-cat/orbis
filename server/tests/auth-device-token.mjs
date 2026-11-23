/**
 * 设备 token / 本机 token 的鉴权加固（安全审计 P0-1 + P2-7 + P2-8）。
 *   node tests/auth-device-token.mjs
 *
 * ## 守什么
 *
 * 1. **原型链上的名字不是 token**。`devices` 以前是 `{}`，`devices['constructor']`
 *    查到的是 `Object` 函数 —— `?? null` 之后是 truthy，于是一个随便写的
 *    `Authorization: Bearer constructor` 就能通过鉴权。`__proto__` / `toString` /
 *    `valueOf` / `hasOwnProperty` 同理。HTTP 与 WS 两条链路都要 401/4401，
 *    而且不许污染 `Object.prototype`。
 * 2. **state.json 里不出现明文 token**。备份盘、同步盘、崩溃转储都会把这份文件
 *    带走；以前 key 就是 token 本身，等于把每台手机的凭证一起交出去。
 * 3. **老 state.json 能平滑迁移**：明文键加载时原地换成 `sha256:<hex>`，
 *    老手机不用重新配对（同一个 token 仍然鉴权通过）。
 * 4. **本机 token 必须来自回环**：HTTP 侧和 WS 侧同一套判断，泄露的 token
 *    不能从中转/局域网冒充本机。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-auth-'));
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
const { Store, store } = await import(src('store.js'));
const { config } = await import(src('config.js'));
const { createHttpServer, resetLocalTokenCache } = await import(src('http.js'));
const { attachWs } = await import(src('ws.js'));
const { Pairing } = await import(src('pairing.js'));
const { issueLocalToken } = await import(src('local-token.js'));

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

const runner = {
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
attachWs(server, { runner });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/** 攻击面清单：这些字符串全部是原型链上真实存在的名字。 */
const PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
];

async function get(pathname, { headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.closeInfo = null;
    ws.on('close', (code, reason) => {
      ws.closeInfo = { code, reason: String(reason ?? '') };
      resolve(ws);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.t === 'error') ws.errorMessage = msg.error;
      } catch { /* 非 JSON 忽略 */ }
    });
    ws.on('error', (err) => {
      ws.errorSeen = err;
      resolve(ws);
    });
    setTimeout(() => reject(new Error('ws 连接超时')), 4000);
  });
}

// ---------------------------------------------------------------- 原型链

test('★ store.findDeviceByToken：原型链上的名字一个都不认', () => {
  for (const name of PROTOTYPE_NAMES) {
    assert.equal(store.findDeviceByToken(name), null, `${name} 不该被当成设备`);
  }
  // 非字符串 / 空串也不认（以前 devices[undefined] 会拼成字符串 'undefined'）
  assert.equal(store.findDeviceByToken(undefined), null);
  assert.equal(store.findDeviceByToken(null), null);
  assert.equal(store.findDeviceByToken(''), null);
  assert.equal(store.findDeviceByToken({}), null);
});

test('★ devices 是无原型字典（__proto__ 赋值不会改原型）', () => {
  assert.equal(Object.getPrototypeOf(store.state.devices), null);
  store.state.devices['__proto__'] = { id: 'd_evil' };
  assert.equal(Object.getPrototypeOf(store.state.devices), null, '原型没被换掉');
  assert.equal(store.findDeviceByToken('__proto__'), null);
  delete store.state.devices['__proto__'];
});

test('★ HTTP：Bearer / ?token= 传原型链名字一律 401', async () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  for (const name of PROTOTYPE_NAMES) {
    const viaHeader = await get('/api/bots', { headers: { authorization: `Bearer ${name}` } });
    assert.equal(viaHeader.status, 401, `Authorization: Bearer ${name} 必须 401`);
    const viaQuery = await get(`/api/bots?token=${encodeURIComponent(name)}`);
    assert.equal(viaQuery.status, 401, `?token=${name} 必须 401`);
  }
  const after = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  assert.equal(after, before, 'Object.prototype 被污染了');
});

test('★ WS：原型链名字连不上（4401），不会当成设备发 hello', async () => {
  for (const name of ['constructor', '__proto__', 'toString']) {
    const ws = await openWs(name);
    assert.ok(ws.closeInfo, `${name} 应被关闭`);
    assert.equal(ws.closeInfo.code, 4401, `${name} 必须 4401`);
    ws.terminate();
  }
});

test('★ 撤销：认 id、认原始 token，不认原型链名字；列表不再下发 token', () => {
  const a = store.addDevice('撤销-A');
  const b = store.addDevice('撤销-B');
  const c = store.addDevice('撤销-C');
  assert.equal(store.revokeDevice('constructor'), false, '原型链名字不是设备');
  assert.equal(store.revokeDevice(''), false);
  assert.equal(store.revokeDevice(undefined), false);
  assert.equal(store.revokeDevice(a.token), true, '按原始 token 撤销');
  assert.equal(store.revokeDevice(b.device.id), true, '按设备 id 撤销');
  assert.equal(store.revokeDevice(a.device.id), false, '撤过的再撤返回 false');
  assert.equal(store.findDeviceByToken(a.token), null);
  assert.equal(store.findDeviceByToken(b.token), null);
  assert.ok(store.findDeviceByToken(c.token), '没被撤的那台还在');

  const listed = store.listDevices();
  for (const d of listed) {
    assert.equal(Object.hasOwn(d, 'token'), false, '设备列表不许带 token');
    assert.ok(String(d.tokenPreview ?? '').length > 0, '要给预览');
  }
  const pub = store.listDevicesPublic();
  for (const d of pub) assert.equal(Object.hasOwn(d, 'token'), false);
  store.revokeDevice(c.token);
});

// ---------------------------------------------------------------- 落盘形态

test('★ 落盘只有散列：state.json 里找不到明文 token，但同一个 token 仍能鉴权', async () => {
  const { token } = store.addDevice('审计用手机');
  assert.match(token, /^t_/, 'token 本身还是 t_ 前缀（只改存储形态，不改签发）');

  const r = await get('/api/bots', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, '真实 token 要能过');

  const flushed = store.flushNow();
  assert.equal(flushed.ok, true, flushed.text);
  const raw = fs.readFileSync(path.join(config.dataDir, 'state.json'), 'utf8');
  assert.equal(raw.includes(token), false, 'state.json 里出现了明文 token');
  const parsed = JSON.parse(raw);
  const keys = Object.keys(parsed.devices ?? {});
  assert.ok(keys.length >= 1);
  for (const key of keys) {
    assert.match(key, /^sha256:[0-9a-f]{64}$/, `设备键必须是散列：${key}`);
    assert.equal(key.includes('t_'), false);
  }
  const device = Object.values(parsed.devices).find((d) => d.name === '审计用手机');
  assert.ok(device, '设备本身要还在');
  assert.match(String(device.tokenPreview), /^t_.*…$/, '列表要能显示预览');

  // 落盘之后再查一次：同一个 token 仍然认得出（说明散列是可复现的）
  assert.equal(store.findDeviceByToken(token)?.id, device.id);
});

test('★ 老 state.json 明文键：加载后原地迁移成散列，老 token 仍可用', async () => {
  const legacyDir = path.join(root, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyToken = 't_legacyPhone0123456789';
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
    version: 2,
    serverName: 'legacy',
    devices: {
      [legacyToken]: { id: 'd_legacy', name: '1.7 老手机', createdAt: 1, lastSeenAt: 1 },
    },
    bots: {},
    rooms: {},
    sessions: {},
  }, null, 2));

  const legacyStore = new Store({ dataDir: legacyDir });
  try {
    assert.equal(Object.getPrototypeOf(legacyStore.state.devices), null, '加载后也是无原型字典');
    const keys = Object.keys(legacyStore.state.devices);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^sha256:[0-9a-f]{64}$/, '明文键要迁移成散列');
    const found = legacyStore.findDeviceByToken(legacyToken);
    assert.equal(found?.id, 'd_legacy', '★ 老手机不用重新配对');
    assert.ok(found?.tokenPreview, '迁移时补齐预览列');

    // 迁移结果要落盘（scheduleSave 是定时器，这里直接 flush）
    const ok = legacyStore.flushNow();
    assert.equal(ok.ok, true, ok.text);
    const raw = fs.readFileSync(path.join(legacyDir, 'state.json'), 'utf8');
    assert.equal(raw.includes(legacyToken), false, '迁移后落盘不许再有明文 token');
  } finally {
    clearTimeout(legacyStore.saveTimer);
  }
});

// ---------------------------------------------------------------- 本机 token

test('★ 本机 token：回环能用，中转进来的（非回环）401', async () => {
  // ★ 必须用 config.dataDir：http.js 用同一份配置读 token 文件（不是 ORBIS_HOME 本身）。
  //   前面的 401 请求已经把「没有 token 文件」缓存进 http.js 了，签发后要清缓存。
  const localToken = issueLocalToken(config.dataDir);
  resetLocalTokenCache();
  const ok = await get('/api/bots', { headers: { authorization: `Bearer ${localToken}` } });
  assert.equal(ok.status, 200, '回环 + 有效本机 token 应当放行');

  // `x-pi-relay` 代表这条请求是「中转进来的远程设备」：物理上回环，身份不是本机。
  const relayed = await get('/api/bots', {
    headers: { authorization: `Bearer ${localToken}`, 'x-pi-relay': '1' },
  });
  assert.equal(relayed.status, 401, '★ 非回环来源带本机 token 必须 401');
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);

server.close();
for (const client of server.clients ?? []) client.terminate?.();
clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
