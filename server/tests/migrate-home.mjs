/**
 * `orbis migrate`（路线图 §3 T1.2 前半）：1.7 数据目录 → 2.0 新目录。
 *   node tests/migrate-home.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **只复制，不删除**：迁移完旧目录里每个文件都还在（这是唯一能让人放心的姿态）。
 * 2. **幂等**：第二次跑返回 `already`，不重复复制、不会把新数据覆盖回去。
 * 3. **目标已有数据就拒绝**（`TARGET_HAS_DATA`）；`--force` 也只**补齐缺失**，不覆盖。
 * 4. **会话引用要改写**：`state.json` 里存的是绝对路径，不改写的话服务端会继续写旧目录。
 * 5. **配置改名**：旧名字的配置文件 → `orbis.config.json`（旧文件原样留在旧目录）。
 * 6. **工作目录只记指针**：workspace 动辄几百 MB，复制既慢又会弄坏 .venv 里的绝对路径。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MIGRATION_REPORT, migrateHome, hasLegacyData, CONFIG_RENAMES,
} from '../src/migrate-home.js';
import { NEEDS_MIGRATION_MARKER } from '../src/data-migration.js';
import { LEGACY_HOME_DIR_NAME } from '../src/user-dirs.js';


let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-migrate-'));

/** 造一个"1.7 老用户"的数据目录 */
function makeLegacy(tag) {
  const dir = path.join(root, tag, LEGACY_HOME_DIR_NAME, 'data');
  fs.mkdirSync(path.join(dir, 'rooms'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'taskruns'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace', 'proj'), { recursive: true });

  const sessionFile = path.join(dir, 'sessions', 's1.jsonl');
  fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n');
  fs.writeFileSync(path.join(root, tag, LEGACY_HOME_DIR_NAME, 'data', 'rooms', 'dm.json'), '[]');
  fs.writeFileSync(path.join(dir, 'taskruns', 't1.json'), '{"version":1}');
  fs.writeFileSync(path.join(dir, 'model-groups.json'), '{"version":1,"groups":[]}');
  fs.writeFileSync(path.join(dir, CONFIG_RENAMES[0].from), '{"providers":{}}');
  // 上传半成品：不该被搬
  fs.writeFileSync(path.join(root, tag, LEGACY_HOME_DIR_NAME, 'data', '_partial.tmp'), 'x');
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ version: 4, bots: {}, rooms: {}, sessions: { 'dm:chief': sessionFile } }, null, 2),
  );
  return { dataDir: dir, sessionFile };
}

const target = (tag) => path.join(root, tag, 'orbis', 'data');

await test('只复制、不删除：旧目录每个文件都还在，新目录拿到同样的内容', () => {
  const { dataDir } = makeLegacy('copy');
  const before = fs.readdirSync(dataDir).sort();
  const r = migrateHome({ from: dataDir, to: target('copy') });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), before, '旧目录的文件一个都不能少');
  assert.ok(fs.existsSync(path.join(target('copy'), 'state.json')));
  assert.ok(fs.existsSync(path.join(target('copy'), 'rooms', 'dm.json')));
  assert.ok(fs.existsSync(path.join(target('copy'), 'taskruns', 't1.json')), 'taskruns 不搬 = 执行中的任务全丢');
  assert.equal(fs.existsSync(path.join(target('copy'), '_partial.tmp')), false, '`_` 开头的半成品不搬');
  assert.ok(fs.existsSync(path.join(target('copy'), MIGRATION_REPORT)), '报告要落盘');
  assert.equal(r.legacyUntouched, true);
});

await test('会话引用被改写：state.json 里指到新目录（否则服务端会继续写旧目录）', () => {
  const { dataDir } = makeLegacy('refs');
  const to = target('refs');
  const r = migrateHome({ from: dataDir, to });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.sessionsRewritten >= 1, '至少改写一条');
  const state = JSON.parse(fs.readFileSync(path.join(to, 'state.json'), 'utf8'));
  const ref = state.sessions['dm:chief'];
  assert.ok(ref.startsWith(path.join(to, 'sessions')), `会话应指向新目录，实际 ${ref}`);
  assert.ok(fs.existsSync(ref), '改写后的文件必须真的在');
});

await test('幂等：第二次跑返回 already，不重复复制也不覆盖', () => {
  const { dataDir } = makeLegacy('idem');
  const to = target('idem');
  const first = migrateHome({ from: dataDir, to });
  assert.equal(first.ok, true, first.error);

  const marker = path.join(to, MIGRATION_REPORT);
  const stamp = fs.statSync(marker).mtimeMs;
  const stateBefore = fs.readFileSync(path.join(to, 'state.json'), 'utf8');

  const second = migrateHome({ from: dataDir, to });
  assert.equal(second.already, true, '第二次必须是 already');
  assert.equal(fs.statSync(marker).mtimeMs, stamp, '报告不该被重写');
  assert.equal(fs.readFileSync(path.join(to, 'state.json'), 'utf8'), stateBefore);
});

await test('目标已有数据 → 拒绝（TARGET_HAS_DATA），一个文件都不覆盖', () => {
  const { dataDir } = makeLegacy('occupied');
  const to = target('occupied');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'state.json'), '{"version":4,"bots":{"mine":{}}}');
  const r = migrateHome({ from: dataDir, to });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TARGET_HAS_DATA');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(to, 'state.json'), 'utf8')).bots.mine !== undefined,
    true,
    '已有的 state.json 不能被覆盖',
  );
});

await test('--force 只补齐缺失：已有的 state.json 原样保留，缺的条目补上', () => {
  const { dataDir } = makeLegacy('force');
  const to = target('force');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'state.json'), '{"version":4,"bots":{"mine":{}}}');
  const r = migrateHome({ from: dataDir, to, force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.kept.includes('state.json'), '已存在的文件应记为 kept');
  assert.ok(r.copied.includes('rooms') || r.copied.includes('taskruns'), '缺失的条目要补上');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(to, 'state.json'), 'utf8')).bots.mine !== undefined,
    true,
    'force 也不能覆盖已有文件',
  );
});

await test('配置文件改名：旧名字 → orbis.config.json（旧文件留在旧目录）', () => {
  const { dataDir } = makeLegacy('config');
  const to = target('config');
  const r = migrateHome({ from: dataDir, to });
  assert.equal(r.ok, true, r.error);
  const rename = CONFIG_RENAMES[0];
  assert.ok(fs.existsSync(path.join(to, rename.to)), '新名字要有');
  assert.equal(fs.existsSync(path.join(to, rename.from)), false, '不该把旧名字也复制进去');
  assert.ok(fs.existsSync(path.join(dataDir, rename.from)), '旧目录那份原样保留');
  assert.equal(r.configs[0].result, 'copied');
});

await test('工作目录只记指针，不复制；报告与标记里记的是旧路径', () => {
  const { dataDir } = makeLegacy('workspace');
  const to = target('workspace');
  const r = migrateHome({ from: dataDir, to });
  assert.equal(r.ok, true, r.error);
  const legacyWs = path.join(dataDir, 'workspace');
  assert.equal(r.workspace, legacyWs);
  assert.equal(fs.existsSync(path.join(to, 'workspace')), false, 'workspace 不该被复制');
  const report = JSON.parse(fs.readFileSync(path.join(to, MIGRATION_REPORT), 'utf8'));
  assert.equal(report.workspace, legacyWs);
  const marker = JSON.parse(fs.readFileSync(path.join(to, '.migrated-from.json'), 'utf8'));
  assert.equal(marker.workspace, legacyWs, '服务端靠这个标记继续用旧 workspace');
});

await test('dry-run：一个字节都不写', () => {
  const { dataDir } = makeLegacy('dry');
  const to = target('dry');
  const r = migrateHome({ from: dataDir, to, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dryRun, true);
  assert.ok(r.copied.length > 0, '要说清会搬什么');
  assert.equal(fs.existsSync(to), false, 'dry-run 不能建目录');
});

await test('拒绝的几种：没有旧数据 / 同一个目录 / 互为父子', () => {
  assert.equal(hasLegacyData(path.join(root, 'nope')), false);
  // 目标不能放在 from 里面，否则先撞的是 NESTED_PATH（那也是对的，只是不是这条要测的）
  assert.equal(
    migrateHome({ from: path.join(root, 'nope'), to: path.join(root, 'nope-target') }).code,
    'NO_LEGACY',
  );

  const { dataDir } = makeLegacy('same');
  assert.equal(migrateHome({ from: dataDir, to: dataDir }).code, 'SAME_PATH');

  const inside = path.join(dataDir, 'inner');
  assert.equal(migrateHome({ from: dataDir, to: inside }).code, 'NESTED_PATH');
  assert.equal(migrateHome({ from: inside, to: dataDir }).code, 'NESTED_PATH');
});

await test('CLI：node src/index.js migrate --json 能跑通并返回 0', () => {
  const { dataDir } = makeLegacy('cli');
  const to = target('cli');
  const res = spawnSync(
    process.execPath,
    ['src/index.js', 'migrate', '--from', dataDir, '--to', to, '--json'],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(res.status, 0, `退出码 ${res.status}\nstderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.from, dataDir);
  assert.ok(fs.existsSync(path.join(to, MIGRATION_REPORT)));

  // 第二次：already，仍然 0（幂等不该报错）
  const again = spawnSync(
    process.execPath,
    ['src/index.js', 'migrate', '--from', dataDir, '--to', to, '--json'],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).already, true);
});

await test('CLI：目标已有数据时返回 1 并在 stderr 说清原因', () => {
  const { dataDir } = makeLegacy('cli-refuse');
  const to = target('cli-refuse');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'state.json'), '{"version":4}');
  const res = spawnSync(
    process.execPath,
    ['src/index.js', 'migrate', '--from', dataDir, '--to', to],
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /已经有数据/);
  assert.match(res.stderr, /--force/);
});

await test('★ 目标已有空目录时仍然递归合并（不能整棵跳过，否则聊天记录一条都不搬）', () => {
  const { dataDir } = makeLegacy('merge');
  const to = target('merge');
  // 模拟“用户先起过一次 2.0”：目标里已有空 rooms/ 与一个不该被覆盖的文件
  fs.mkdirSync(path.join(to, 'rooms'), { recursive: true });
  fs.writeFileSync(path.join(to, 'rooms', 'keep.json'), '["新目录里自己的消息"]');

  const r = migrateHome({ from: dataDir, to, force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.merged.includes('rooms') || r.copied.includes('rooms'), 'rooms 应记为合并/复制');
  assert.ok(fs.existsSync(path.join(to, 'rooms', 'dm.json')), '旧房间文件必须补上');
  assert.equal(
    fs.readFileSync(path.join(to, 'rooms', 'keep.json'), 'utf8'),
    '["新目录里自己的消息"]',
    '已有文件永远不覆盖',
  );
});

await test('★ 目录合并对 dry-run 也成立（要能提前看清会补哪些）', () => {
  const { dataDir } = makeLegacy('merge-dry');
  const to = target('merge-dry');
  fs.mkdirSync(path.join(to, 'rooms'), { recursive: true });
  const r = migrateHome({ from: dataDir, to, dryRun: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.merged.includes('rooms'), `dry-run 应报"合并 rooms"，实际 ${JSON.stringify(r.merged)}`);
});

await test('★ 配置迁移后落在 dataDir 里，providers 优先读新名字那份', async () => {
  const { dataDir } = makeLegacy('provider-config');
  const to = target('provider-config');
  const r = migrateHome({ from: dataDir, to, force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(path.join(to, 'orbis.config.json')), '迁移后应存在 <dataDir>/orbis.config.json');

  const { pickLocalConfigFile } = await import('../src/providers.js');
  const picked = pickLocalConfigFile({ dataDir: to, pkgRoot: path.join(root, 'provider-config', 'pkg') });
  assert.equal(picked, path.join(to, 'orbis.config.json'), 'dataDir 里的新名字要优先于安装目录');
});

await test('配置查找顺序：dataDir 新名 > dataDir 旧名 > pkgRoot 新名 > pkgRoot 旧名', async () => {
  const { pickLocalConfigFile } = await import('../src/providers.js');
  const base = path.join(root, 'pick-order');
  const dataDir = path.join(base, 'data');
  const pkgRoot = path.join(base, 'pkg');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pkgRoot, { recursive: true });
  const write = (dir, name) => fs.writeFileSync(path.join(dir, name), '{}');

  write(pkgRoot, CONFIG_RENAMES[0].from);
  assert.equal(pickLocalConfigFile({ dataDir, pkgRoot }), path.join(pkgRoot, CONFIG_RENAMES[0].from), '只有安装目录的旧名');

  write(pkgRoot, 'orbis.config.json');
  assert.equal(pickLocalConfigFile({ dataDir, pkgRoot }), path.join(pkgRoot, 'orbis.config.json'), '安装目录新名 > 旧名');

  write(dataDir, CONFIG_RENAMES[0].from);
  assert.equal(pickLocalConfigFile({ dataDir, pkgRoot }), path.join(dataDir, CONFIG_RENAMES[0].from), 'dataDir 旧名 > pkgRoot 新名');

  write(dataDir, 'orbis.config.json');
  assert.equal(pickLocalConfigFile({ dataDir, pkgRoot }), path.join(dataDir, 'orbis.config.json'), 'dataDir 新名最高');
});

await test('CLI：--from / --to 缺值或被吃成别的选项 → 报错，不当成目录', async () => {
  const { parseArgs } = await import('../src/migrate-cli.js');
  assert.match(parseArgs(['--from', '--dry-run']).error ?? '', /--from 后面要跟/);
  assert.match(parseArgs(['--to']).error ?? '', /--to 后面要跟/);
  assert.match(parseArgs(['--from=']).error ?? '', /--from 后面要跟/);
  assert.equal(parseArgs(['--from', 'a', '--to', 'b']).error, undefined);
});

test('★ dry-run：目标目录已齐备时如实报 kept（不能一律说 merged）', () => {
  const { dataDir } = makeLegacy('dry-kept');
  const to = target('dry-kept');
  const first = migrateHome({ from: dataDir, to });
  assert.equal(first.ok, true, first.error);
  // 第二次得加 --force：目标已经有 state.json（否则会被 TARGET_HAS_DATA 挡住）
  const dry = migrateHome({ from: dataDir, to, dryRun: true, force: true });
  assert.equal(dry.ok, true, dry.error);
  assert.deepEqual(dry.merged, [], '目录已经齐备就不该报 merged，实际 ' + JSON.stringify(dry.merged));
  assert.ok(dry.kept.includes('rooms'), 'rooms 应报 kept');
});

test('★ createConfig 真的带 legacyDataDir 字段（漏写会让 /health 永远 false）', async () => {
  const { createConfig } = await import('../src/config.js');
  const cfg = createConfig({ serverBoot: false, ensureDirs: false });
  assert.ok(Object.hasOwn(cfg, 'legacyDataDir'), 'built 里必须有这个字段');
  assert.equal(cfg.legacyDataDir, null, '非启动路径默认应为 null');
});

test('★ /health 的 needsMigration 跟着 config.legacyDataDir 走', async () => {
  const { createHttpServer } = await import('../src/http.js');
  const { createConfig } = await import('../src/config.js');
  const base = createConfig({ ensureDirs: false });
  const runner = {
    config: { ...base, legacyDataDir: '/old/data' },
    availableModels: [],
    modelLabel: () => null,
    initNote: null,
  };
  const server = createHttpServer({ runner, pairing: { list: () => [], claim: () => null } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject);
    });
    assert.equal(body.needsMigration, true, '/health 要能告诉界面先跑 orbis migrate');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('★ 迁移成功后清掉 .needs-migration.json（否则 /health 一直提示）', () => {
  const { dataDir } = makeLegacy('clear-marker');
  const to = target('clear-marker');
  fs.mkdirSync(to, { recursive: true });
  const markerFile = path.join(to, NEEDS_MIGRATION_MARKER);
  fs.writeFileSync(markerFile, '{"from":"x"}');
  const r = migrateHome({ from: dataDir, to, force: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(markerFile), false, '迁完还挂着标记只会误导');
});

console.log(`\nmigrate-home: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
