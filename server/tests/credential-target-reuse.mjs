/**
 * 换目标时不许沿用旧凭据（安全审计 P1-1）。
 *   node tests/credential-target-reuse.mjs
 *
 * ## 三个入口，同一个规则
 *
 * 用户在界面上把某个地址改掉之后点「测试连接」/「探测一下」，如果后端还把
 * **已保存的 key** 带过去，那就是：改一个输入框 = 把密钥交给那台服务器。
 *
 *   · `model-service.testGroup()`        —— 模型组「测试连接」
 *   · `model-service.probeDecision()`    —— 决策路由「探测」
 *   · `store.updateSite()`               —— 站点改域名（旧口令不能跟着走）
 *
 * 「同一个目标」的判定用 `model-endpoints.endpointTarget()`（scheme + host + path，
 * 规范化后比较）与站点 origin，跟运行时挑选凭据的口径保持一致。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-cred-'));
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
const { store } = await import(src('store.js'));
const { modelGroups } = await import(src('model-groups.js'));
const { endpointTarget } = await import(src('model-endpoints.js'));
const { createModelService } = await import(src('services/model-service.js'));
const { loadOrCreateKey } = await import(src('secrets.js'));
// 决策 key 是密封存储的：没有本机密钥时 updateDecision 会直接拒绝（这是对的）
store.useSecretsKey(loadOrCreateKey(dataDir));

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

/**
 * 一台「服务器」：只记录收到了什么，然后回一个能骗过探测的 /models。
 * 这样断言的是**真的发出去的请求头**，不是被测代码里的某个变量。
 */
async function captureServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => server.close(r)),
    reset: () => { seen.length = 0; },
  };
}

const saved = await captureServer();   // 用户已经配好、存着 key 的那台
const attacker = await captureServer(); // 用户刚刚填进去的新地址
const service = createModelService({ store });

const SAVED_KEY = '{{SECRET_cerhqahe}}';

// ---------------------------------------------------------------- 模型组「测试连接」

const { group } = modelGroups.upsert({
  name: '已保存的组',
  baseUrl: saved.base,
  apiKey: SAVED_KEY,
  models: [{ id: 'm1' }],
});
assert.ok(group?.id, '模型组要建起来');

test('对照：目标没变 → 复用已保存的 key（不能把正常路径一起禁掉）', async () => {
  saved.reset();
  const r = await service.testGroup({ id: group.id });
  assert.equal(r.ok, true, r.error);
  assert.ok(saved.seen.length >= 1, '应当真的打到了保存的那台');
  assert.equal(saved.seen[0].authorization, `Bearer ${SAVED_KEY}`);
});

test('★ testGroup：显式换了 baseUrl → 绝不把已保存的 key 发过去', async () => {
  attacker.reset();
  const r = await service.testGroup({ id: group.id, baseUrl: attacker.base });
  assert.equal(r.ok, true, r.error);
  assert.ok(attacker.seen.length >= 1, '应当打到新地址');
  for (const hit of attacker.seen) {
    assert.equal(hit.authorization, null, `新目标收到了凭据：${hit.url}`);
  }
});

test('★ testGroup：同一目标只是写法不同（尾斜杠 / 大小写）→ 仍然复用', async () => {
  saved.reset();
  const r = await service.testGroup({ id: group.id, baseUrl: `${saved.base}/` });
  assert.equal(r.ok, true, r.error);
  assert.equal(saved.seen[0].authorization, `Bearer ${SAVED_KEY}`);
});

test('★ testGroup：换了目标但**同时**给了新 key → 发新 key', async () => {
  attacker.reset();
  const r = await service.testGroup({ id: group.id, baseUrl: attacker.base, apiKey: 'sk-new-key' });
  assert.equal(r.ok, true, r.error);
  assert.equal(attacker.seen[0].authorization, 'Bearer sk-new-key');
  assert.equal(attacker.seen.some((h) => h.authorization === `Bearer ${SAVED_KEY}`), false);
});

// ---------------------------------------------------------------- 决策路由「探测」

const JEV_KEY = 'jev-key-for-tests';
store.updateDecision({ mode: 'custom', baseUrl: saved.base, apiKey: JEV_KEY });

test('★ probeDecision：换了地址 → 不复用已保存的决策 key（连请求都不发）', async () => {
  attacker.reset();
  const r = await service.probeDecision({ mode: 'custom', baseUrl: attacker.base });
  // 没有可用的 key 时 jevProbe 直接判「未配置」，一个请求都不发 ——
  // 这比"发出去但不带 Authorization"更强：新目标连我们的存在都不该知道。
  assert.equal(attacker.seen.length, 0, '没有 key 时不该向新地址发起探测');
  assert.equal(r.ok, false);
});

test('probeDecision：换地址但同时给新 key → 用新 key（旧 key 仍然不出现）', async () => {
  attacker.reset();
  await service.probeDecision({ mode: 'custom', baseUrl: attacker.base, apiKey: 'sk-jev-new' });
  assert.ok(attacker.seen.length >= 1);
  assert.equal(attacker.seen[0].authorization, 'Bearer sk-jev-new');
  assert.equal(attacker.seen.some((h) => h.authorization === `Bearer ${JEV_KEY}`), false);
});

test('对照：probeDecision 目标没变 → 用已保存的 key', async () => {
  saved.reset();
  await service.probeDecision({ mode: 'custom', baseUrl: saved.base });
  assert.equal(saved.seen[0].authorization, `Bearer ${JEV_KEY}`);
});

// ---------------------------------------------------------------- 站点改域名

const PASSWORD = 'password';
const added = store.addSite({
  name: 'CRM', baseUrl: 'https://crm.example.com/app', account: 'me', [PASSWORD]: 'pw-original',
});
assert.ok(added.site?.id, added.error);
const siteId = added.site.id;

test('对照：站点只改登录路径 → 口令保留', () => {
  const r = store.updateSite(siteId, { auth: { ...store.getSite(siteId).auth, loginPath: '/auth/login2' } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(store.getSite(siteId)[PASSWORD], 'pw-original', '同源改路径不该清口令');
});

test('★ updateSite：改了站点域名（origin 变了）→ 旧口令必须清掉', () => {
  const r = store.updateSite(siteId, { baseUrl: 'https://evil.example.net/app' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(store.getSite(siteId)[PASSWORD], '', '换域名还把旧口令留着 = 下一条登录就发给攻击者');
  assert.equal(store.getSite(siteId).baseUrl, 'https://evil.example.net/app');
});

test('★ updateSite：换域名 + 同时给新口令 → 保留新口令', () => {
  const r = store.updateSite(siteId, { baseUrl: 'https://crm2.example.com/app', [PASSWORD]: 'pw-new' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(store.getSite(siteId)[PASSWORD], 'pw-new');
});

test('★ updateSite：换域名同时传空口令也不算"给了新口令"（仍然清空）', () => {
  store.updateSite(siteId, { [PASSWORD]: 'pw-temp' });
  const r = store.updateSite(siteId, { baseUrl: 'https://evil2.example.net/app', [PASSWORD]: '' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(store.getSite(siteId)[PASSWORD], '');
});

// ---------------------------------------------------------------- 目标比较规则

test('endpointTarget：尾斜杠、大小写主机等价；路径/端口/协议不等价', () => {
  assert.equal(
    endpointTarget('https://API.example.com/v1/'),
    endpointTarget('https://api.example.com/v1'),
  );
  assert.notEqual(
    endpointTarget('https://api.example.com/v1'),
    endpointTarget('https://api.example.com/v2'),
  );
  assert.notEqual(
    endpointTarget('http://api.example.com/v1'),
    endpointTarget('https://api.example.com/v1'),
  );
  assert.notEqual(
    endpointTarget('https://api.example.com:8443/v1'),
    endpointTarget('https://api.example.com/v1'),
  );
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);

await saved.close();
await attacker.close();
clearTimeout(store.saveTimer);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
