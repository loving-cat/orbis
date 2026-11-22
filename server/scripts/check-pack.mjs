#!/usr/bin/env node
/**
 * 发布包体检（路线图 §4 T2.6）。
 *
 *   node scripts/check-pack.mjs            # 生成 types + 打包清单，断言内容与体积
 *   node scripts/check-pack.mjs --no-types # 跳过 tsc（types/ 已是最新时快点）
 *
 * ## 这个文件守什么
 *
 * 发布包最怕的不是"少打了一个文件"（用户会立刻报错），而是**多打了东西**：
 * `node_modules/`、`data/`、测试夹具、1.2MB 的临时产物……体积一涨就没人敢改白名单了。
 * 所以这里不只看"该有的在不在"，也看"不该有的在不在"，并且给体积划一条线。
 *
 * 依赖 typescript 与 devDependencies（`npm install` 不带 `--omit=dev`）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));

/** 体积上限（解包后）。超过就先问"这次多出来的是什么"，而不是直接调大数字。 */
const MAX_UNPACKED_BYTES = 12 * 1024 * 1024;
/** 压缩包上限 */
const MAX_PACKED_BYTES = 4 * 1024 * 1024;

/**
 * 包里必须有的文件。
 *
 * `types/sdk/index.d.ts` 与 `examples/sdk/01-minimal.mjs` 是 T2.2 / T2.8 的验收对象：
 * 少了它们，"`npm i` 之后 5 行跑起来 + IDE 有类型"这两件事就不成立。
 */
const REQUIRED = [
  'package.json',
  'src/sdk/index.js',
  'src/sdk/client.js',
  'src/index.js',
  'types/sdk/index.d.ts',
  'types/sdk/client.d.ts',
  'examples/sdk/01-minimal.mjs',
  'examples/sdk/README.md',
  'LICENSE',
  'README.md',
  'docs/SDK.md',
];

/** 一定不能在包里的前缀（打进去就是事故或体积事故） */
const FORBIDDEN_PREFIX = ['node_modules/', 'tests/', 'data/', 'examples/sdk/.orbis-demo/', '.git/'];

const IS_WIN = process.platform === 'win32';

/**
 * 跑 npm：先找 npm 自己的 CLI 入口，再退回到 spawn `npm`。
 *
 * 为什么不直接 spawn `npm`：Windows 上它是 `npm.cmd`，Node 24 起不加
 * `shell: true` 就 EINVAL；加了 shell 又要拼字符串（有注入风险 + 一条
 * DeprecationWarning）。用 `process.execPath npm-cli.js …` 两头都躲开了。
 *
 * 三个候选按可信度排：npm 自己注入的 → 跟当前 node 同级的 → PATH 里的 npm。
 */
function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function npm(args, opts = {}) {
  const cli = npmCliPath();
  if (cli) {
    return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
  }
  return execFileSync(IS_WIN ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8', stdio: 'pipe', shell: IS_WIN, ...opts,
  });
}

const problems = [];
const notes = [];

if (pkg.private !== false) problems.push('package.json 仍是 private: true（`npm publish` 会被拒）');
if (!pkg.exports?.['./package.json']) problems.push('exports 里缺 "./package.json"（工具读包元数据会失败）');
if (!pkg.types) problems.push('package.json 缺顶层 `types` 字段');
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === 'string') {
    // 只允许 "./package.json" 走字符串简写：其余入口必须带 types 条件
    if (key !== './package.json') problems.push(`exports["${key}"] 是字符串简写，缺 types 条件`);
    continue;
  }
  if (!value?.types) problems.push(`exports["${key}"] 缺 types`);
  if (!value?.default) problems.push(`exports["${key}"] 缺 default`);
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  problems.push('package.json 缺 `files` 白名单（会按 .gitignore 打包，极易夹带杂物）');
}

// 打包前的准备（复制 LICENSE / docs/SDK.md、清旧 tgz）—— 幂等，直接跑
console.log('· 准备打包内容（prepare-pack）…');
execFileSync(process.execPath, ['scripts/prepare-pack.mjs'], { cwd: serverDir, stdio: 'inherit' });

if (!process.argv.includes('--no-types')) {
  console.log('· 生成声明文件（tsc）…');
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.types.json'], {
    cwd: serverDir,
    stdio: 'inherit',
  });
}
// ★ 文件存在性要等 tsc 跑完再查：刚 clone 下来时 types/ 还不存在
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const typesPath = typeof value === 'string' ? null : value?.types;
  if (!typesPath) continue;
  if (!fs.existsSync(path.join(serverDir, typesPath.replace(/^\.\//, '')))) {
    problems.push(`exports["${key}"] 的 types 指向不存在的文件：${typesPath}`);
  }
}
if (!fs.existsSync(path.join(serverDir, 'types', 'sdk', 'index.d.ts'))) {
  problems.push('types/sdk/index.d.ts 不存在（先跑 npm run types）');
}
if (!fs.existsSync(path.join(serverDir, 'LICENSE'))) {
  problems.push('server/LICENSE 不存在（prepare-pack 会从仓库根复制）');
}
if (!fs.existsSync(path.join(serverDir, 'docs', 'SDK.md'))) {
  problems.push('server/docs/SDK.md 不存在（prepare-pack 会从仓库根复制）');
}

// `--ignore-scripts`：不让 npm 顺带跑 prepack（types/licenses 上面都已经准备好了），这样 --json 输出干净
const raw = npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: serverDir });
const [info] = JSON.parse(raw);
const files = info.files.map((f) => f.path.replace(/\\/g, '/'));

for (const need of REQUIRED) {
  if (!files.includes(need)) problems.push(`包里缺 ${need}`);
}
for (const file of files) {
  const bad = FORBIDDEN_PREFIX.find((prefix) => file.startsWith(prefix));
  if (bad) problems.push(`包里不该有 ${file}（命中禁用前缀 ${bad}）`);
}
if (info.unpackedSize > MAX_UNPACKED_BYTES) {
  problems.push(`解包体积 ${(info.unpackedSize / 1024 / 1024).toFixed(2)}MB 超过上限 ${(MAX_UNPACKED_BYTES / 1024 / 1024).toFixed(0)}MB`);
}
if (info.size > MAX_PACKED_BYTES) {
  problems.push(`压缩包 ${(info.size / 1024 / 1024).toFixed(2)}MB 超过上限 ${(MAX_PACKED_BYTES / 1024 / 1024).toFixed(0)}MB`);
}

notes.push(`文件数 ${files.length}`);
notes.push(`压缩包 ${(info.size / 1024).toFixed(0)}KB`);
notes.push(`解包后 ${(info.unpackedSize / 1024 / 1024).toFixed(2)}MB`);

if (problems.length) {
  console.error('✗ 发布包体检未通过：');
  for (const p of problems) console.error(`  · ${p}`);
  console.error(`\n  ${notes.join(' / ')}`);
  process.exit(1);
}
console.log(`✓ 发布包体检通过（${notes.join(' / ')}）`);
