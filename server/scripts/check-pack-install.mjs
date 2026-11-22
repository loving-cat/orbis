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
 *   · `prepack` 少了一步（`LICENSE` / `docs/SDK.md` 是它复制进来的）；
 *   · `private: true` 忘了改；
 *   · 依赖没写进 `dependencies`（本地有 node_modules，装出来却没有）。
 * 这几种问题的共同点：在仓库里永远看不到，在用户那里第一次就炸。
 *
 * ★ 打包前会**先删掉** `server/LICENSE` 与 `server/docs/SDK.md`：
 *   它们是 prepack 的产物，留在盘上就会让"prepack 漏了一步"这件事测不出来
 *   （CI 上就差点这么漏过去 —— 前一步 `check:pack` 刚好把它们留在了盘上）。
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

/** prepack 才应该生成的文件：打包前必须不存在，否则等于没测 prepack */
const PREPACK_OUTPUTS = ['LICENSE', path.join('docs', 'SDK.md')];

const problems = [];
const note = (msg) => console.log(`· ${msg}`);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

/**
 * 跑 npm：先找 npm 自己的 CLI 入口，再退回到 spawn `npm`。
 *
 * 为什么不直接 spawn `npm`：Windows 上它是 `npm.cmd`，Node 24 起不加
 * `shell: true` 就 EINVAL；加了 shell 又要拼字符串（有注入风险 + 一条
 * DeprecationWarning）。用 `process.execPath npm-cli.js …` 两头都躲开了。
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

/**
 * 从 `npm pack --json` 的输出里挖出那段 JSON。
 *
 * ★ 不能直接 `JSON.parse(stdout)`：prepack 里的 `prepare-pack.mjs` / `tsc` 也会往
 *   stdout 打东西（"✓ LICENSE 已就位"…），npm 把它们排在 JSON 前面。
 *   所以从后往前找第一个能解析成数组的 `[`。
 */
function parsePackJson(out) {
  const text = String(out ?? '').trim();
  let idx = text.length;
  while ((idx = text.lastIndexOf('[', idx - 1)) >= 0) {
    try {
      const parsed = JSON.parse(text.slice(idx));
      if (Array.isArray(parsed) && parsed[0]?.filename) return parsed[0];
    } catch {
      // 不是这一段，继续往前找
    }
  }
  return null;
}

/** 打包 → 装 → 验 → 跑示例；失败用异常表达，好让 finally 一定跑到 */
function verify() {
  // ① 先把 prepack 的产物清掉：这样"prepack 到底有没有复制"才是真的被测到
  for (const rel of PREPACK_OUTPUTS) {
    fs.rmSync(path.join(serverDir, rel), { force: true });
  }
  note('已清掉 prepack 产物（LICENSE / docs/SDK.md），接下来只看 prepack 自己能不能造出来');

  // ② 真的打一个包（prepack 会复制 LICENSE / docs/SDK.md 并重建 types）
  note('npm pack（会跑 prepack）…');
  const packOut = npm(['pack', '--json'], { cwd: serverDir });
  const info = parsePackJson(packOut);
  if (!info) throw new Error(`npm pack 的输出里找不到打包信息：
${packOut.slice(0, 800)}`);
  const tgz = path.join(serverDir, info.filename);
  if (!fs.existsSync(tgz)) throw new Error(`npm pack 没有产出 ${info.filename}`);
  note(`打出来 ${info.filename}（${(info.size / 1024).toFixed(0)}KB / ${info.files.length} 个文件）`);

  // ③ 空目录里装它
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-pack-install-'));
  try {
    fs.writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2),
    );
    // 复制进工作目录后用相对路径装：避免绝对路径里的空格/盘符问题
    fs.copyFileSync(tgz, path.join(work, path.basename(tgz)));
    note(`在干净目录里 npm install ./${path.basename(tgz)} …`);
    npm(['install', `./${path.basename(tgz)}`, '--no-audit', '--no-fund'], { cwd: work });

    const installedDir = path.join(work, 'node_modules', pkg.name);
    if (!fs.existsSync(installedDir)) throw new Error(`装完看不到 node_modules/${pkg.name}`);

    // ④ prepack 复制进来的两份东西必须真的在包里
    for (const rel of PREPACK_OUTPUTS) {
      if (!fs.existsSync(path.join(installedDir, rel))) {
        problems.push(`prepack 没把 ${rel} 打进包（检查 package.json 的 prepack 是否包含 prepare-pack.mjs）`);
      } else {
        note(`${rel} 在包里（prepack 生效）`);
      }
    }

    // ⑤ `./package.json` 可达（工具链常靠它读元数据）
    try {
      const seen = JSON.parse(
        run(process.execPath, ['-e', `console.log(JSON.stringify(require('${pkg.name}/package.json').version))`], { cwd: work }),
      );
      if (seen !== pkg.version) problems.push(`读到的版本 ${seen} 与 package.json 的 ${pkg.version} 不一致`);
      note(`require('${pkg.name}/package.json') → ${seen}`);
    } catch (err) {
      problems.push(`\`${pkg.name}/package.json\` 不可达：${String(err?.stderr ?? '').trim().slice(0, 200)}`);
    }

    // ⑥ 入口能 import 且导出齐全
    const probe = `
      const sdk = await import('${pkg.name}/sdk');
      const need = ['createOrbisRuntime', 'createOrbisClient', 'defineTool', 'Type', 'createStore', 'createBus'];
      const missing = need.filter((k) => sdk[k] === undefined);
      console.log(JSON.stringify({ missing }));
    `;
    try {
      const out = JSON.parse(run(process.execPath, ['--input-type=module', '-e', probe], { cwd: work }));
      if (out.missing.length) problems.push(`入口缺导出：${out.missing.join(', ')}`);
      note(`import('${pkg.name}/sdk') 正常，导出齐全`);
    } catch (err) {
      problems.push(`入口 import 失败：${String(err?.stderr ?? '').trim().slice(0, 400)}`);
    }

    // ⑦ 类型文件真的进了包
    if (!fs.existsSync(path.join(installedDir, 'types', 'sdk', 'index.d.ts'))) {
      problems.push('types/sdk/index.d.ts 没进包');
    } else {
      note('types/sdk/index.d.ts 在包里');
    }

    // ⑧ 真跑一个示例（离线桩，不需要 API key）
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
  } finally {
    // ⑨ 收尾：装出来的 node_modules 与打出来的 tgz 都别留在盘上
    //    （尤其 Windows：不删的话临时目录会一直涨，且下次 npm i 可能命中旧包）
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
  }
}

try {
  verify();
} catch (err) {
  problems.push(String(err?.stderr ?? '').trim() || String(err?.message ?? err));
}

if (problems.length) {
  console.error('\n✗ 干净容器验收未通过：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log('\n✓ 干净容器验收通过：npm pack（含 prepack）→ 空目录 npm i → 示例跑通');
