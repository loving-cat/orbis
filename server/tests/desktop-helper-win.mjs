/**
 * Windows 桌面助手（阶段 A）的契约测试。
 *   node tests/desktop-helper-win.mjs
 *
 * 分两层：
 *   1. **跨平台**：注入 `run`，覆盖版本/哈希校验、失败映射、回退判定 ——
 *      macOS / Linux CI 上没有这个 exe，但"参数怎么拼、输出怎么翻译、什么时候回退"
 *      是纯逻辑，任何平台都能验。
 *   2. **Windows 真机**（有助手二进制时才跑）：真调 helper，断言返回形状与
 *      `desktop-input-win.js` 的对外契约一致（screen/dpi/session、x/y、windows 字段）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const helper = await import(src('desktop-helper-win.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 造一个假 exe（内容无所谓，校验用的是注入的 run）。 */
function fakeExe(payload = { version: helper.DESKTOP_HELPER_VERSION, protocol: 1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-desktop-helper-'));
  const exe = path.join(dir, 'orbis-desktop-win.exe');
  fs.writeFileSync(exe, 'MZ fake', 'utf8');
  const calls = [];
  const run = (file, args, input) => {
    calls.push({ file, args, input });
    if (args[0] === 'version') return JSON.stringify({ ok: true, ...payload });
    const command = args[0];
    const canned = payload.responses?.[command];
    if (canned === undefined) return JSON.stringify({ ok: true });
    return typeof canned === 'string' ? canned : JSON.stringify(canned);
  };
  return { dir, exe, run, calls };
}

// ---------------------------------------------------------------------------
// 1. 协议解析
// ---------------------------------------------------------------------------

await test('parseHelperOutput：正常 / 非 JSON / 空输出 / 失败对象', () => {
  assert.deepEqual(helper.parseHelperOutput('{"ok":true,"x":1}'), { ok: true, x: 1 });
  assert.equal(helper.parseHelperOutput('').code, 'call_failed');
  assert.equal(helper.parseHelperOutput('not json').code, 'call_failed');
  const failed = helper.parseHelperOutput('{"ok":false,"code":"not_aware","text":"没声明感知"}');
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'not_aware');
  assert.equal(failed.text, '没声明感知');
  // 多行输出取最后一行（有的运行时会在前面打日志）
  assert.deepEqual(helper.parseHelperOutput('warning\n{"ok":true}\n'), { ok: true });
});

// ---------------------------------------------------------------------------
// 2. 校验与回退
// ---------------------------------------------------------------------------

await test('verifyHelper：版本对得上 → ok；版本/协议不符 → 明确原因', () => {
  const good = fakeExe();
  assert.equal(helper.verifyHelper(good.exe, { run: good.run }).ok, true);

  const badVersion = fakeExe({ version: '9.9.9', protocol: 1 });
  const v = helper.verifyHelper(badVersion.exe, { run: badVersion.run });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'version_mismatch');
  assert.match(v.detail, /9\.9\.9/);

  const badProtocol = fakeExe({ version: helper.DESKTOP_HELPER_VERSION, protocol: 7 });
  assert.equal(helper.verifyHelper(badProtocol.exe, { run: badProtocol.run }).reason, 'protocol_mismatch');
});

await test('verifyHelper：跑不起来 / 输出不是 JSON → broken（不抛）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-desktop-broken-'));
  const exe = path.join(dir, 'orbis-desktop-win.exe');
  fs.writeFileSync(exe, 'x', 'utf8');
  const thrower = () => { throw new Error('ENOENT'); };
  assert.equal(helper.verifyHelper(exe, { run: thrower }).reason, 'broken');
  const garbage = () => 'not json';
  assert.equal(helper.verifyHelper(exe, { run: garbage }).reason, 'broken');
});

await test('verifyHelper：有 sha256 清单就必须对得上', () => {
  const good = fakeExe();
  const wrong = path.join(good.dir, 'orbis-desktop-win.sha256');
  fs.writeFileSync(wrong, `${'0'.repeat(64)}  orbis-desktop-win.exe`, 'utf8');
  const v = helper.verifyHelper(good.exe, { run: good.run });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hash_mismatch');
});

await test('helperState：ORBIS_DESKTOP_WIN_IMPL=powershell 强制旧实现', () => {
  helper.resetHelperState();
  const st = helper.helperState({ env: { [helper.IMPL_ENV]: 'powershell' }, force: true });
  assert.equal(st.mode, 'powershell');
  assert.equal(st.why, 'forced_by_env');
});

await test('helperState：助手缺失 → 回退（不是崩溃）', () => {
  helper.resetHelperState();
  const st = helper.helperState({
    env: { ORBIS_DESKTOP_WIN_HELPER: path.join(os.tmpdir(), 'definitely-missing', 'orbis-desktop-win.exe') },
    force: true,
  });
  assert.ok(['powershell'].includes(st.mode));
  helper.resetHelperState();
});

await test('helperState：版本不符 → 回退，并在 detail 里说清差在哪', () => {
  helper.resetHelperState();
  const bad = fakeExe({ version: '0.0.1', protocol: 1 });
  const st = helper.helperState({
    env: { ORBIS_DESKTOP_WIN_HELPER: bad.exe },
    run: bad.run,
    force: true,
  });
  assert.equal(st.mode, 'powershell');
  assert.equal(st.why, 'version_mismatch');
  helper.resetHelperState();
});

await test('helperState：校验通过 → native，且 callHelper 真的调它', () => {
  helper.resetHelperState();
  const fake = fakeExe({ version: helper.DESKTOP_HELPER_VERSION, protocol: 1, responses: { cursor: { ok: true, x: 11, y: 22 } } });
  const st = helper.helperState({ env: { ORBIS_DESKTOP_WIN_HELPER: fake.exe }, run: fake.run, force: true });
  assert.equal(st.mode, 'native');
  const r = helper.callHelper('cursor', {}, { run: fake.run, state: st });
  assert.deepEqual(r, { ok: true, x: 11, y: 22 });
  const cursorCall = fake.calls.find((c) => c.args[0] === 'cursor');
  assert.equal(cursorCall.input, '{}', '请求体走 stdin，不走 argv');
  helper.resetHelperState();
});

await test('callHelper：不可用时返回 helper_unavailable（调用方据此回退）', () => {
  const r = helper.callHelper('env', {}, { state: { mode: 'powershell', exe: null, why: 'helper_missing' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'helper_unavailable');
});

await test('callHelper：助手抛错（超时/被杀）→ call_failed', () => {
  const r = helper.callHelper('env', {}, {
    state: { mode: 'native', exe: 'x', why: 'ok' },
    run: () => { const err = new Error('ETIMEDOUT'); throw err; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'call_failed');
  assert.match(r.text, /ETIMEDOUT/);
});

// ---------------------------------------------------------------------------
// 3. Windows 真机：真调助手（没有二进制就跳过）
// ---------------------------------------------------------------------------

const realExe = helper.resolveHelper();
const hasReal = process.platform === 'win32' && realExe && helper.verifyHelper(realExe).ok;

await test('★ 真机：version / env / cursor / foreground / windows 的形状与旧契约一致', async () => {
  if (!hasReal) {
    console.log('    （跳过：本机没有可用的桌面助手）');
    return;
  }
  helper.resetHelperState();
  const { probeEnvironment, cursorPosition, foregroundTitle } = await import(src('desktop-input-win.js'));
  const { listWindows } = await import(src('desktop-observe.js'));

  const env = probeEnvironment();
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.ok(env.screen.width > 0 && env.screen.height > 0);
  assert.ok(Number(env.dpi) >= 96);
  assert.equal(typeof env.session, 'boolean');

  const cursor = cursorPosition();
  assert.equal(cursor.ok, true);
  assert.equal(typeof cursor.x, 'number');
  assert.equal(typeof cursor.y, 'number');

  const fg = foregroundTitle();
  assert.equal(fg.ok, true);
  assert.equal(typeof fg.title, 'string');

  const win = listWindows({ limit: 5 });
  assert.equal(win.ok, true);
  assert.ok(win.windows.length <= 5);
  for (const w of win.windows) {
    assert.equal(typeof w.handle, 'number');
    assert.equal(typeof w.title, 'string');
    assert.equal(typeof w.app, 'string');
    assert.ok(w.width > 0 && w.height > 0);
    assert.equal(w.minimized, false);
  }
});

await test('★ 真机：perform(move) 走到位，且不点击', async () => {
  if (!hasReal) {
    console.log('    （跳过：本机没有可用的桌面助手）');
    return;
  }
  helper.resetHelperState();
  const { probeEnvironment, perform, cursorPosition } = await import(src('desktop-input-win.js'));
  const env = probeEnvironment();
  assert.equal(env.ok, true);
  const target = {
    x: Math.round(env.screen.x + env.screen.width / 2),
    y: Math.round(env.screen.y + env.screen.height / 2),
  };
  const r = perform({ plan: { action: 'move', point: target } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.at.x - target.x) <= 24 && Math.abs(r.at.y - target.y) <= 24,
    `光标没到位：目标 ${JSON.stringify(target)} 实际 ${JSON.stringify(r.at)}`);
  // 再读一次：真实环境里可能有别的程序在动光标（本机就有合成输入的远程控制类程序），
  // 所以只断言「还在目标附近的容差内」，不断言逐像素不动。
  const back = cursorPosition();
  assert.equal(back.ok, true);
  assert.ok(Math.abs(back.x - target.x) <= 24 && Math.abs(back.y - target.y) <= 24,
    `移动后光标漂出了容差：目标 ${JSON.stringify(target)} 实际 ${JSON.stringify(back)}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
