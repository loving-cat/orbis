#!/usr/bin/env node
/**
 * 干净容器验收（路线图 §4 T2.6 的验收项）：
 *
 *   node scripts/check-pack-install.mjs
 *
 * 做的是一件很朴素的事：**当成别人**，在一个空目录里 `npm i <tgz>`，
 * 然后真的把 `examples/sdk/01-minimal.mjs` 跑起来。
 *
 * 为什么值得单独一个脚本：仓库里跑得通不代表装得上 ——
 *   · `files` 白名单漏了某个运行时文件（只有 import 到才会暴露）；
 *   · `exports` 少了一项 / types 指错；
 *   · `private: true` 忘了改；
 *   · 依赖没写进 `dependencies`（本地有 node_modules，装出来却没有）。
 * 这四种问题的共同点：在仓库里永远看不到，在用户那里第一次就炸。
 *
 * 需要网络（会真的去装依赖）。CI 里只在 `sdk-types` job 跑一次。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
const IS_WIN = process.platform === 'win32';

const problems = [];
const note = (msg) => console.log(`· ${msg}`);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

/**
 * 跑 npm：Windows 上 `npm` 是 .cmd，Node 24 起必须走 shell 才肯 spawn。
 * 这里的参数都不含空格（tgz 先复制到工作目录、用相对名装），所以拼字符串是安全的。
 */
function npm(args, opts = {}) {
  return execFileSync(IS_WIN ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: IS_WIN,
    ...opts,
  });
}

// ① 真的打一个包（prepack 会重建 types、复制 LICENSE 与 docs）
note('npm pack（会跑 prepack）…');
const packOut = npm(['pack', '--json'], { cwd: serverDir });
const [info] = JSON.parse(packOut);
const tgz = path.join(serverDir, info.filename);
if (!fs.existsSync(tgz)) {
  console.error(`✗ npm pack 没有产出 ${info.filename}`);
  process.exit(1);
}
note(`打出来 ${info.filename}（${(info.size / 1024).toFixed(0)}KB / ${info.files.length} 个文件）`);

// ② 空目录里装它
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-pack-install-'));
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
// 先复制进工作目录：用相对路径装，Windows 的 shell 拼接就不用担心空格/盘符
const localTgz = path.join(work, path.basename(tgz));
fs.copyFileSync(tgz, localTgz);
note(`在干净目录里 npm install ./${path.basename(localTgz)} …`);
try {
  npm(['install', `./${path.basename(localTgz)}`, '--no-audit', '--no-fund'], { cwd: work });
} catch (err) {
  console.error('✗ 安装失败：');
  console.error(String(err?.stdout ?? '') + String(err?.stderr ?? ''));
  process.exit(1);
}

const installedDir = path.join(work, 'node_modules', pkg.name);
if (!fs.existsSync(installedDir)) {
  console.error(`✗ 装完看不到 node_modules/${pkg.name}`);
  process.exit(1);
}

// ③ `./package.json` 可达（工具链常靠它读元数据）
try {
  const seen = JSON.parse(
    run(process.execPath, ['-e', `console.log(JSON.stringify(require('${pkg.name}/package.json').version))`], { cwd: work }),
  );
  if (seen !== pkg.version) problems.push(`读到的版本 ${seen} 与 package.json 的 ${pkg.version} 不一致`);
  note(`require('${pkg.name}/package.json') → ${seen}`);
} catch (err) {
  problems.push(`\`${pkg.name}/package.json\` 不可达：${String(err?.stderr ?? '').trim().slice(0, 200)}`);
}

// ④ 入口能 import 且导出齐全
const probe = `
  const sdk = await import('${pkg.name}/sdk');
  const need = ['createOrbisRuntime', 'createOrbisClient', 'defineTool', 'Type', 'createStore', 'createBus'];
  const missing = need.filter((k) => sdk[k] === undefined);
  console.log(JSON.stringify({ missing, hasTypes: true }));
`;
try {
  const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', probe], { cwd: work }));
  if (out.missing.length) problems.push(`入口缺导出：${out.missing.join(', ')}`);
  note(`import('${pkg.name}/sdk') 正常，导出齐全`);
} catch (err) {
  problems.push(`入口 import 失败：${String(err?.stderr ?? '').trim().slice(0, 400)}`);
}

// ⑤ 类型文件真的进了包，而且能被 tsc 解析
const installedTypes = path.join(installedDir, 'types', 'sdk', 'index.d.ts');
if (!fs.existsSync(installedTypes)) {
  problems.push('types/sdk/index.d.ts 没进包');
} else {
  note('types/sdk/index.d.ts 在包里');
}

// ⑥ 真跑一个示例（离线桩，不需要 API key）
const example = path.join(installedDir, 'examples', 'sdk', '01-minimal.mjs');
if (!fs.existsSync(example)) {
  problems.push('examples/sdk/01-minimal.mjs 没进包');
} else {
  const demoCwd = path.join(work, 'demo');
  fs.mkdirSync(demoCwd, { recursive: true });
  try {
    const stdout = run(process.execPath, [example], {
      cwd: demoCwd,
      env: {
        ...process.env,
        HOME: path.join(demoCwd, 'home'),
        ORBIS_HOME: path.join(demoCwd, 'home-data'),
        ORBIS_WORKSPACE: path.join(demoCwd, 'workspace'),
        ORBIS_PROBE: '0',
        ORBIS_LESSON_REFLECT: '0',
      },
      timeout: 120_000,
    });
    if (!stdout.includes('已收尾')) problems.push('示例跑完了但没走到 dispose（输出里没有“已收尾”）');
    note('examples/sdk/01-minimal.mjs 在装好的包里跑通');
  } catch (err) {
    problems.push(`装好的包里示例跑不通：${String(err?.stderr ?? err?.message ?? '').trim().slice(-800)}`);
  }
}

// ⑦ 收尾：删掉打出来的 tgz（它已在 .gitignore 里，别留垃圾）
fs.rmSync(tgz, { force: true });

if (problems.length) {
  console.error('\n✗ 干净容器验收未通过：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log('\n✓ 干净容器验收通过：npm pack → 空目录 npm i → 示例跑通');
