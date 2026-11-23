/**
 * 只 import 不该在用户家目录里建东西（P2-3：SDK 的「零副作用」承诺）。
 *   node tests/config-no-dirs.mjs
 *
 * 宿主（IDE 插件、别人的服务、诊断脚本）import `orbis-agent` 时，我们只应该
 * 提供能力，不该悄悄创建 `orbis/data`、`workspace`、`rooms/` 这些目录 ——
 * 那会让「我只是 import 了一下」变成对用户磁盘的写入。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-nod irs-'.replace(' ', '')));
const home = path.join(root, 'home');
const dataDir = path.join(root, 'data');
const workspace = path.join(root, 'ws');
// 故意都不创建
process.env.ORBIS_HOME = home;
process.env.ORBIS_WORKSPACE = workspace;

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

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

test('★ 只 import config（默认导出）不建任何目录', async () => {
  const { config } = await import(src('config.js'));
  assert.equal(config.dataDir.startsWith(root), true, `dataDir 应在本测试目录内：${config.dataDir}`);
  for (const dir of [config.home, config.dataDir, config.workspace]) {
    assert.equal(fs.existsSync(dir), false, `import 之后 ${dir} 不该被创建`);
  }
});

test('createConfig({ ensureDirs: true }) 才建目录（真正起服务时由 server-main 用）', async () => {
  const { createConfig } = await import(src('config.js'));
  const cfg = createConfig({ dataDir, workspace, ensureDirs: true });
  for (const dir of [cfg.dataDir, cfg.workspace, path.join(cfg.dataDir, 'rooms')]) {
    assert.equal(fs.existsSync(dir), true, `${dir} 应当被创建`);
  }
});

test('★ memory 模式的 Store 一个字节都不写', async () => {
  const { Store } = await import(src('store.js'));
  const memoryDir = path.join(root, 'memory-store');
  const store = new Store({ memory: true, dataDir: memoryDir });
  try {
    store.createBot({ name: '只活在内存里' });
    store.addDevice('内存设备');
    const flushed = store.flushNow();
    assert.equal(flushed.ok, true);
    assert.equal(fs.existsSync(memoryDir), false, 'memory 模式不该建数据目录');
  } finally {
    store.dispose();
  }
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
