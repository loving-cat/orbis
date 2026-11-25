/**
 * 「待迁移模式」（P0-2）。
 *   node tests/pending-migration.mjs
 *
 * ## 守什么
 *
 * 1.7 用户升级后第一启动会走到这一支：旧目录有数据、新目录还没有。
 * 它**只**回 /health 与一页提示 —— 绝不能顺手生成 `secret.key`（站点口令密钥）、
 * 签一张新证书（手机固定的是旧指纹）或写一份空 `state.json`。
 * 一旦写了，后面的 `orbis migrate` 就得跟这套新文件打架（见 migrate-home 的隔离逻辑）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { servePendingMigrationMode } = await import(src('pending-migration.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-pending-'));
const legacy = path.join(root, 'legacy', 'data');
const target = path.join(root, 'orbis', 'data');
fs.mkdirSync(legacy, { recursive: true });
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(legacy, 'state.json'), '{"version":4}');

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

const handle = await servePendingMigrationMode(
  {
    port: 0,
    host: '127.0.0.1',
    serverName: '待迁移的机器',
    trustLocal: true,
    legacyDataDir: legacy,
    dataDir: target,
  },
  { installSignalHandlers: false },
);
const base = `http://127.0.0.1:${handle.port}`;

test('/health：needsMigration + 两个真实路径 + 版本/身份', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.needsMigration, true);
  assert.equal(body.legacyDataDir, legacy);
  assert.equal(body.targetDataDir, target);
  assert.equal(body.tls, null, '待迁移模式不签证书');
  assert.ok(String(body.version ?? '').length > 0);
  assert.ok(String(body.serverName ?? '').length > 0);
  // P0-1：/health 要把真实可执行命令带下来，App 的「一键迁移」直接用它
  assert.match(String(body.migrateCommand ?? ''), /index\.js/, 'migrateCommand 要含真实入口路径');
  assert.match(String(body.migrateCommand ?? ''), /migrate --from/, '要含 migrate --from');
  assert.ok(String(body.migrateCommand).includes(legacy), '命令里要有旧目录');
  assert.ok(String(body.migrateCommand).includes(target), '命令里要有新目录');
});

test('/health 不带 stats / model（没有 runner，别假装自己在干活）', async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(Object.hasOwn(body, 'stats'), false);
  assert.equal(Object.hasOwn(body, 'model'), false);
});

test('任意其它路径给一页人话（含可复制命令）', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('migrate --from'), '页面里要有可复制的命令');
  // ★ 必须是**真的能跑**的形态：node + server/src/index.js（安装包里没有 orbis 在 PATH 上）
  assert.match(html, /index\.js" migrate/, '页面里的命令要带真实入口');
  assert.ok(html.includes(legacy), '要写出旧目录');
  assert.ok(html.includes(target), '要写出新目录');
  assert.ok(html.includes('workspace'), '要提醒 workspace 不会复制、旧目录不能删');
});

test('★ 一个字节都没写：新目录里没有 secret.key / tls / state.json', async () => {
  // 前面的请求本身也不该触发任何写盘
  await fetch(`${base}/health`);
  assert.equal(fs.existsSync(path.join(target, 'secret.key')), false, '绝不能生成新密钥');
  assert.equal(fs.existsSync(path.join(target, 'tls')), false, '绝不能签新证书');
  assert.equal(fs.existsSync(path.join(target, 'state.json')), false, '绝不能写空 state');
  assert.deepEqual(fs.readdirSync(target), [], '目标目录应当还是空的');
});

test('旧目录也没被碰过', async () => {
  assert.deepEqual(fs.readdirSync(legacy), ['state.json']);
  assert.equal(fs.readFileSync(path.join(legacy, 'state.json'), 'utf8'), '{"version":4}');
});

test('★ 非本机 /health 不返回路径与命令（局域网看不到本机用户名/node 路径）', async () => {
  const mod = await import(new URL('../src/pending-migration.js', import.meta.url));
  const cfg = { serverName: '待迁移的机器', trustLocal: true };
  const redacted = mod.pendingHealthPayload({
    cfg,
    legacy: '/Users/example/Library/Application Support/pi-bot/data',
    target: '/Users/example/Library/Application Support/Orbis/data',
    command: '/usr/local/bin/node /opt/orbis/migrate.mjs --legacy ...',
    local: false,
  });
  assert.equal(redacted.needsMigration, true, '仍然要告诉对方「要迁移」');
  assert.equal(redacted.ok, true);
  assert.equal(redacted.legacyDataDir, undefined, '非本机不能给旧目录');
  assert.equal(redacted.targetDataDir, undefined, '非本机不能给新目录');
  assert.equal(redacted.migrateCommand, undefined, '非本机不能给命令（含用户名与 node 路径）');
  assert.match(redacted.hint, /本机/);
  assert.doesNotMatch(JSON.stringify(redacted), /example|opt\/orbis/, '脱敏后的载荷里不能出现本机痕迹');

  // 本机仍然完整（桌面端一键迁移依赖它）
  const local = mod.pendingHealthPayload({
    cfg,
    legacy: '/Users/example/legacy',
    target: '/Users/example/orbis',
    command: '/usr/local/bin/node /opt/orbis/migrate.mjs',
    local: true,
  });
  assert.equal(local.legacyDataDir, '/Users/example/legacy');
  assert.equal(local.migrateCommand, '/usr/local/bin/node /opt/orbis/migrate.mjs');
});

test('★ 本机请求拿到完整字段，非本机判定按 remoteAddress 走', async () => {
  const mod = await import(new URL('../src/pending-migration.js', import.meta.url));
  assert.equal(mod.isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(mod.isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(mod.isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(mod.isLoopbackRequest({ socket: { remoteAddress: '192.168.1.23' } }), false, '局域网地址不是本机');
  assert.equal(mod.isLoopbackRequest({ socket: { remoteAddress: '10.0.0.9' } }), false);
  assert.equal(mod.isLoopbackRequest({ socket: {} }), false, '拿不到地址时按非本机处理（保守）');

  // 真的走 HTTPSERVER 本机访问：完整字段
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.legacyDataDir, legacy, '本机（127.0.0.1）必须拿到完整路径');
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);

await handle.close();
fs.rmSync(root, { recursive: true, force: true });
// ★ 别用 process.exit()：Windows 上 listen handle 正在关闭时强退会触发 libuv 断言。
if (failed.length) process.exitCode = 1;
