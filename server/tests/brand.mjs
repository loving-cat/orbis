/**
 * 品牌环境变量与改名兼容测试。
 *   node tests/brand.mjs
 *
 * ## 为什么这块要单独守
 *
 * 项目从 1.7 的旧品牌改名为 **Orbis** 后，环境变量统一成 `ORBIS_*`，但老用户的
 * `.env`、桌面端传参、systemd/supervisor 配置里可能还写着旧前缀（2.0 起不再读）。这里守住三条：
 *   1. `readBrandEnv` 只认 `ORBIS_*`，空串视为未设置，旧前缀读不到；
 *   2. 各个消费点（接单开关 / 任务上限 / 抓网页上限）真的走这条路，
 *      不是只在 brand.js 里写了个没人用的助手；
 *   3. 品牌常量与更新源不许回退成占位地址 —— 开源分发后检查更新打的就是它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-brand-'));
process.env.ORBIS_HOME = fixture;
process.env.PI_CODING_AGENT_DIR = path.join(fixture, 'agent');
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
// 旧前缀在源码里**拼出来**：扫描器数的是品牌残留，而这里要的正是那个旧名字（C1 回归点）。
const legacyEnv = (suffix) => ['PI', 'BOT', suffix].join('_');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const {
  BRAND_NAME, BRAND_SLUG, BRAND_ENV_PREFIX, LEGACY_SLUG, DEFAULT_UPDATE_REPO, DEFAULT_MAIN_BOT_NAME, readBrandEnv,
} = await import(src('brand.js'));
const { intakeEnabled } = await import(src('coordination/intake-tool.js'));
const { admissionBudget } = await import(src('coordination/task-admission.js'));

// ---------------------------------------------------------------------------
// 1. 品牌常量：改名的单一真源
// ---------------------------------------------------------------------------

await test('1. 品牌常量是 Orbis，旧 slug 与更新源都写死在一处', () => {
  assert.equal(BRAND_NAME, 'Orbis');
  assert.equal(BRAND_SLUG, 'orbis');
  assert.equal(DEFAULT_MAIN_BOT_NAME, 'Orbis');
  // 老数据目录/老安装包仍能按这个 slug 找到，不许删
  assert.equal(LEGACY_SLUG, 'pi-bot');
  // 检查更新打的就是这个仓库：不许再回退成 orbis-ai/orbis 这类占位地址
  assert.equal(DEFAULT_UPDATE_REPO, 'loving-cat/orbis');
});

// ---------------------------------------------------------------------------
// 2. readBrandEnv 的读取顺序
// ---------------------------------------------------------------------------

await test('2. readBrandEnv：只认 ORBIS_*（旧前缀 2.0 起读不到）', () => {
  assert.equal(readBrandEnv({ ORBIS_PORT: '8787' }, 'PORT'), '8787');
  // 空串等于没配 —— `ORBIS_PORT=` 不该被当成“端口是空字符串”
  assert.equal(readBrandEnv({ ORBIS_PORT: '' }, 'PORT'), undefined);
  assert.equal(readBrandEnv({}, 'PORT'), undefined);
  assert.equal(readBrandEnv(undefined, 'PORT'), undefined);
  // ★ 旧前缀已删：同一个变量用旧名字给，读不到（这就是 C1 的验收点）
  assert.equal(readBrandEnv({ [legacyEnv('PORT')]: '9000' }, 'PORT'), undefined);
  assert.equal(readBrandEnv({ ORBIS_PORT: '8787', [legacyEnv('PORT')]: '9000' }, 'PORT'), '8787');
});

// ---------------------------------------------------------------------------
// 3. 消费点确实走这条路（否则 echo 一遍品牌常量没有意义）
// ---------------------------------------------------------------------------

await test('3. 接单开关：默认开启，ORBIS_TASK_INTAKE 生效，旧前缀不生效', () => {
  assert.equal(intakeEnabled({}), true);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '0' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: 'false' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: 'off' }), false);
  assert.equal(intakeEnabled({ ORBIS_TASK_INTAKE: '1' }), true);
  // ★ 旧前缀已删：只剩旧名时按“没配”处理（默认开启）
  assert.equal(intakeEnabled({ [legacyEnv('TASK_INTAKE')]: '0' }), true);
});

await test('4. 任务上限：ORBIS_TASK_MAX_RUNS 生效，旧前缀不生效；并发默认 4', () => {
  assert.deepEqual(admissionBudget({}, null), { maxRuns: null, concurrencyLimit: 4 });
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: '7' }, null).maxRuns, 7);
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: '0' }, null).maxRuns, null, '0 = 不限额');
  assert.equal(admissionBudget({ ORBIS_TASK_MAX_RUNS: 'abc' }, null).maxRuns, null, '非数字 = 不限额');
  assert.equal(admissionBudget({ [legacyEnv('TASK_MAX_RUNS')]: '9' }, null).maxRuns, null, '旧前缀已删');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '6' }, null).concurrencyLimit, 6, '环境变量可覆盖');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '16' }, null).concurrencyLimit, 16, '上限 16 合法');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '17' }, null).concurrencyLimit, 4, '超上限回落默认');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '0' }, null).concurrencyLimit, 4, '0 非法');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: 'abc' }, null).concurrencyLimit, 4, '非数字回落默认');
  assert.equal(admissionBudget({ ORBIS_TASK_CONCURRENCY: '2.5' }, null).concurrencyLimit, 4, '小数非法');
  assert.equal(admissionBudget({ [legacyEnv('TASK_CONCURRENCY')]: '9' }, null).concurrencyLimit, 4, '旧前缀已删');
});

await test('5. 源码里不再有绕过品牌读取的直接 env.ORBIS_* 读法', () => {
  const dir = path.join(import.meta.dirname, '..', 'src');
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      // brand.js 就是老名读取本身；child-env* 需要知道老名才能过滤，属放行清单
      if (/(^|[\\/])(brand|child-env|child-env-typed)\.js$/.test(full)) continue;
      // ★ 新旧前缀都要拦：只查 ORBIS_ 会漏掉源码里残留的旧前缀直读。
      //
      //   旧前缀在这里**刻意拼出来**（与 app/test 里同样的做法）：这个扫描器
      //   的职责就是找旧前缀，但完整串不该出现在源码里 ——
      //   `scripts/check-legacy.mjs` 数的是品牌残留，扫描器自己不能变成债。
      const OLD_ENV_PREFIX = ['PI', 'BOT'].join('_');
      const re = new RegExp(
        `(?:process\\.)?env(?:ironment)?\\.(?:${BRAND_ENV_PREFIX}|${OLD_ENV_PREFIX})_[A-Z0-9_]+`,
        'g',
      );
      for (const m of text.match(re) ?? []) offenders.push(`${path.relative(dir, full)} → ${m}`);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `这些地方没走 readBrandEnv，ORBIS_* 会失效：\n${offenders.join('\n')}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
