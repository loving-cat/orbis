/**
 * 校验桌面助手 exe 的版本与 Node 侧常量一致。
 *   node tools/check-desktop-helper-version.mjs [exe路径]
 *
 * 与 `check-launcher-version.mjs` 同一个理由：CI 的 native job 和
 * `scripts/build-desktop-win.ps1` 要做同一件事，两边各写一份解析必然漂移。
 *
 * 与沙箱启动器的区别：助手说的是 **JSON 协议**（不是 `name version` 那种文本行），
 * 所以这里按 JSON 解析，而不是正则抓版本号。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exeArg = process.argv[2];
if (!exeArg) {
  console.error('用法: node tools/check-desktop-helper-version.mjs <orbis-desktop-win.exe>');
  process.exit(2);
}
const exe = path.resolve(exeArg);
if (!fs.existsSync(exe)) {
  console.error(`找不到桌面助手：${exe}`);
  process.exit(1);
}

const nodeSide = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'desktop-helper-win.js'), 'utf8',
);
const wanted = /DESKTOP_HELPER_VERSION = '([^']+)'/.exec(nodeSide)?.[1];
if (!wanted) {
  console.error('无法从 server/src/desktop-helper-win.js 读出 DESKTOP_HELPER_VERSION');
  process.exit(1);
}

const res = spawnSync(exe, ['version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: '{}' });
if (res.status !== 0) {
  console.error(`桌面助手跑不起来（exit ${res.status}）：${(res.stderr || '').slice(0, 200)}`);
  process.exit(1);
}
let parsed = null;
try {
  parsed = JSON.parse(String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || '');
} catch {
  console.error(`版本输出不是 JSON：${JSON.stringify(res.stdout)}`);
  process.exit(1);
}
if (parsed?.ok !== true || typeof parsed?.version !== 'string') {
  console.error(`版本输出缺少 version 字段：${JSON.stringify(parsed)}`);
  process.exit(1);
}
if (parsed.version !== wanted) {
  console.error(`版本不一致：Node 侧 ${wanted}，exe ${parsed.version}`);
  console.error('改了一边就要改另一边，并重新编译 native/orbis-desktop-win。');
  process.exit(1);
}
if (Number(parsed.protocol) !== 1) {
  console.error(`协议版本不一致：期望 1，实际 ${parsed.protocol}`);
  process.exit(1);
}
console.log(`version ok: ${parsed.version} (protocol ${parsed.protocol})`);
