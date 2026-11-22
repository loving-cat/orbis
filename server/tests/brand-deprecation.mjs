/**
 * 弃用提醒通道（1.7.1 引入的过渡机制）在 2.0 之后还剩什么。
 *   node tests/brand-deprecation.mjs
 *
 * ## 2.0 之后这条通道只管两件事
 *
 * 1.7.1 时代它管三件：`PI_BOT_*` 环境变量双读、旧数据目录回退、`x-pi-bot-*` 旧头。
 * 2.0（Phase 3）把这三件都删了，但通道本身还有用 ——
 * **配置文件名**（`pi-bot.config.json` → `orbis.config.json`）还要读旧写新，
 * 而"读到旧名时提醒一次"仍然必须做到：
 *   · 同一进程内按 `kind:from` 去重（`readBrandEnv` 那种热路径不去重就是刷屏）；
 *   · 可订阅、可重置，单测不用抓 stderr；
 *   · 提醒里必须给出**当下能做的事**（别让人去敲一个还不存在的命令）。
 *
 * 旧数据目录那一半现在守的是**启动护栏**（`noticeLegacyDataIfAny`）：
 * 2.0 不再自动回退，但发现旧数据时必须大声给出 `orbis migrate` 指引。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-brand-dep-'));
process.env.ORBIS_HOME = fixture;
process.env.PI_CODING_AGENT_DIR = path.join(fixture, 'agent');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
  }
}

const {
  readBrandEnv,
  noticeBrandDeprecation,
  onBrandDeprecation,
  brandDeprecations,
  resetBrandDeprecations,
} = await import(src('brand.js'));

// ---------------------------------------------------------------------------
// C1（2.0 已删）：环境变量不再双读，也不该再产生任何"环境变量弃用"
// ---------------------------------------------------------------------------

await test('BD-1 旧环境变量前缀已删：读不到，也不再有弃用记录', () => {
  resetBrandDeprecations();
  assert.equal(readBrandEnv({ PI_BOT_HOME: '/legacy' }, 'HOME'), undefined);
  assert.deepEqual(brandDeprecations(), [], '旧前缀已经删了，不该还提醒"将在 2.0 移除"');
});

await test('BD-2 新名字照常读；同一变量反复读也不产生记录（热路径）', () => {
  resetBrandDeprecations();
  const env = { ORBIS_WORKSPACE: '/w' };
  for (let i = 0; i < 50; i++) assert.equal(readBrandEnv(env, 'WORKSPACE'), '/w');
  assert.deepEqual(brandDeprecations(), []);
});

await test('BD-3 提醒通道本身仍然去重：同一个 key 只留一条', () => {
  resetBrandDeprecations();
  const info = { kind: 'file', from: 'pi-bot.config.json', to: 'orbis.config.json' };
  noticeBrandDeprecation(info);
  noticeBrandDeprecation(info);
  noticeBrandDeprecation(info);
  assert.deepEqual(brandDeprecations(), ['file:pi-bot.config.json']);
});

await test('BD-4 订阅者能收到结构化事件（kind / from / to），且每个 key 只回调一次', () => {
  resetBrandDeprecations();
  const seen = [];
  const off = onBrandDeprecation((ev) => seen.push(ev));
  noticeBrandDeprecation({ kind: 'file', from: 'a.json', to: 'b.json' });
  noticeBrandDeprecation({ kind: 'file', from: 'a.json', to: 'b.json' });
  off();
  noticeBrandDeprecation({ kind: 'file', from: 'c.json', to: 'd.json' });
  assert.equal(seen.length, 1, '退订后不该再回调');
  assert.deepEqual(seen[0], { kind: 'file', from: 'a.json', to: 'b.json', hint: '' });
});

await test('BD-5 noticeBrandDeprecation 返回值：首次 true / 重复 false', () => {
  resetBrandDeprecations();
  const info = { kind: 'test', from: 'a', to: 'b' };
  assert.equal(noticeBrandDeprecation(info), true);
  assert.equal(noticeBrandDeprecation(info), false);
});

// ---------------------------------------------------------------------------
// 真实场景：配置文件读旧写新（2.0 还剩的那一处弃用）
// ---------------------------------------------------------------------------

const { pickLocalConfigFile } = await import(src('providers.js'));

await test('BD-6 只有 pi-bot.config.json 时仍读它，并记一条 file 弃用（指向新名字）', () => {
  resetBrandDeprecations();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-cfg-'));
  const pkgRoot = path.join(base, 'pkg');
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'pi-bot.config.json'), '{"providers":{}}');
  const seen = [];
  const off = onBrandDeprecation((ev) => seen.push(ev));
  const picked = pickLocalConfigFile({ dataDir: path.join(base, 'data'), pkgRoot });
  off();
  assert.equal(path.basename(picked), 'pi-bot.config.json');
  assert.deepEqual(brandDeprecations(), ['file:pi-bot.config.json']);
  assert.equal(seen[0].to, 'orbis.config.json');
  assert.match(seen[0].hint ?? '', /orbis migrate|改/, '要给出当下能做的事');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// C2（2.0 已删）：旧数据目录不再自动回退，但必须大声给出迁移指引
// ---------------------------------------------------------------------------

const { resolveHomeDir, noticeLegacyDataIfAny } = await import(src('config.js'));

await test('BD-7 只有旧目录有数据：不再回退，但护栏必须给出 orbis migrate 指引', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  fs.mkdirSync(path.join(base, 'pi-bot', 'data'), { recursive: true });
  fs.writeFileSync(path.join(base, 'pi-bot', 'data', 'state.json'), '{}');

  // ① 目录解析：只给新目录（2.0 不再沿用旧目录）
  assert.equal(path.basename(resolveHomeDir(base)), 'orbis');

  // ② 护栏：大声提示 + 落标记（绝不静默建空库）
  const home = path.join(base, 'orbis', 'data');
  const lines = [];
  const found = noticeLegacyDataIfAny({ home, base, log: (m) => lines.push(m) });
  assert.equal(path.basename(path.dirname(found)), 'pi-bot', '应指出旧数据目录');
  const text = lines.join('\n');
  assert.match(text, /orbis migrate/, '必须给出可复制执行的命令');
  assert.match(text, /旧：/, '要说清旧目录在哪');
  assert.match(text, /新：/, '要说清新目录在哪');
  assert.ok(fs.existsSync(path.join(home, '.needs-migration.json')), '标记文件要给 /health 用');
  fs.rmSync(base, { recursive: true, force: true });
});

await test('BD-8 新目录已经有数据：不提示（用户已经在用了）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  fs.mkdirSync(path.join(base, 'pi-bot', 'data'), { recursive: true });
  fs.writeFileSync(path.join(base, 'pi-bot', 'data', 'state.json'), '{}');
  const home = path.join(base, 'orbis', 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'state.json'), '{}');
  const lines = [];
  assert.equal(noticeLegacyDataIfAny({ home, base, log: (m) => lines.push(m) }), null);
  assert.deepEqual(lines, []);
  fs.rmSync(base, { recursive: true, force: true });
});

await test('BD-9 旧目录存在但没数据（或全新安装）：不提示', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-home-'));
  fs.mkdirSync(path.join(base, 'pi-bot', 'data'), { recursive: true }); // 空目录，没有 state.json
  const lines = [];
  assert.equal(noticeLegacyDataIfAny({ home: path.join(base, 'orbis', 'data'), base, log: (m) => lines.push(m) }), null);
  assert.deepEqual(lines, []);
  fs.rmSync(base, { recursive: true, force: true });
});

fs.rmSync(fixture, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\nbrand-deprecation: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
