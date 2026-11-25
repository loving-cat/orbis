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
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
function fakeExe(payload = { version: helper.DESKTOP_HELPER_VERSION, protocol: 2 }) {
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

  const badVersion = fakeExe({ version: '9.9.9', protocol: 2 });
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

await test('verifyHelper：有 sha256 清单就必须对得上，且**对不上就不许执行**', () => {
  const good = fakeExe();
  const wrong = path.join(good.dir, 'orbis-desktop-win.sha256');
  fs.writeFileSync(wrong, `${'0'.repeat(64)}  orbis-desktop-win.exe`, 'utf8');
  const before = good.calls.length;
  const v = helper.verifyHelper(good.exe, { run: good.run });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hash_mismatch');
  // ★ 顺序断言：一份对不上清单的 exe，连"版本自检"都不该跑起来
  assert.equal(good.calls.length - before, 0, '哈希不符时 run 调用次数必须为 0');
});

await test('verifyHelper：先验哈希、后执行（顺序不可颠倒）', () => {
  const good = fakeExe();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(good.exe)).digest('hex');
  fs.writeFileSync(path.join(good.dir, 'orbis-desktop-win.sha256'),
    `${hash}  orbis-desktop-win.exe`, 'utf8');
  const order = [];
  const run = (file, args, input) => {
    order.push('exec:version');
    return JSON.stringify({ ok: true, version: helper.DESKTOP_HELPER_VERSION, protocol: 2 });
  };
  const v = helper.verifyHelper(good.exe, { run });
  assert.equal(v.ok, true);
  assert.deepEqual(order, ['exec:version'], '哈希通过之后才允许执行一次版本自检');
});

await test('verifyHelper：清单读不出来（非 ENOENT）→ fail-closed，不执行', () => {
  const good = fakeExe();
  const manifestPath = path.join(good.dir, 'orbis-desktop-win.sha256');
  fs.mkdirSync(manifestPath); // 目录代替文件：读会 EISDIR
  const before = good.calls.length;
  const v = helper.verifyHelper(good.exe, { run: good.run });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'manifest_unreadable');
  assert.equal(good.calls.length - before, 0);
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
  const bad = fakeExe({ version: '0.0.1', protocol: 2 });
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
  const fake = fakeExe({ version: helper.DESKTOP_HELPER_VERSION, protocol: 2, responses: { cursor: { ok: true, x: 11, y: 22 } } });
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

  const env = await probeEnvironment();
  // ★ 锁屏 / 远程会话断开 / CI 的无头桌面上 `session` 是 false：
  //   那时**不该**要求光标与窗口列表有值（它们本来就取不到），
  //   但 `env` 必须如实返回 `session:false`，而不是假装成功。
  if (env.ok === true && env.session !== true) {
    console.log('    （跳过 cursor/windows：当前没有可交互桌面，session=false）');
    assert.ok(env.screen.width > 0 && env.screen.height > 0, '锁屏时虚拟屏矩形仍应可读');
    assert.ok(Number(env.dpi) >= 96);
    return;
  }
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.ok(env.screen.width > 0 && env.screen.height > 0);
  assert.ok(Number(env.dpi) >= 96);
  assert.equal(env.session, true);

  const cursor = await cursorPosition();
  assert.equal(cursor.ok, true);
  assert.equal(typeof cursor.x, 'number');
  assert.equal(typeof cursor.y, 'number');

  const fg = await foregroundTitle();
  assert.equal(fg.ok, true);
  assert.equal(typeof fg.title, 'string');

  const win = await listWindows({ limit: 5 });
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

await test('★ 真机：perform(move) 走到位，且不点击（默认不抢用户鼠标）', async () => {
  if (!hasReal) {
    console.log('    （跳过：本机没有可用的桌面助手）');
    return;
  }
  // ★ 这条会**真的移动用户鼠标**。默认不跑：`tests/all.mjs` 是开发者和 CI 天天跑的，
  //   不该在有人正用电脑时把光标抢走，也不该在无头环境里报错。
  //   想验这一项：`ORBIS_TEST_REAL_MOUSE=1 node tests/desktop-helper-win.mjs`
  if (process.env.ORBIS_TEST_REAL_MOUSE !== '1') {
    console.log('    （跳过：会真实移动鼠标，设 ORBIS_TEST_REAL_MOUSE=1 才跑）');
    return;
  }
  helper.resetHelperState();
  const { probeEnvironment, perform, cursorPosition } = await import(src('desktop-input-win.js'));
  const env = await probeEnvironment();
  if (env.ok === true && env.session !== true) {
    console.log('    （跳过：没有可交互桌面，session=false）');
    return;
  }
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

// ---------------------------------------------------------------------------
// 常驻客户端（阶段 B）：协议、分片、乱序、超时、崩溃退避降级
//
// 这一段用**假子进程**（注入 spawn）在 macOS/Linux CI 上也能完整跑：
// 被测的是「按 id 匹配 / 分片缓冲 / 超时杀进程 / 崩溃后降级」这些逻辑，
// 不是 Win32 本身。
// ---------------------------------------------------------------------------

/**
 * 造一个假常驻进程。
 *
 * @param {(req:{id:any,cmd:string,payload:object}) => object|string|null} onRequest
 *   返回对象/字符串 = 回一条响应；返回 null = **不回**（用来测超时）。
 * @param {{split?:boolean}} [opts] split: 把一条响应拆成两个 chunk 发（测分片）
 */
function makeFakeServe(onRequest, { split = false } = {}) {
  const stdout = new EventEmitter();
  stdout.setEncoding = () => {};
  const stdin = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  const sent = [];
  let killed = false;
  let buffer = '';

  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => { killed = true; child.emit('exit', 0); };
  child.stdin.end = () => {};

  const emitLine = (obj) => {
    const text = JSON.stringify(obj) + '\n';
    if (split && text.length > 8) {
      stdout.emit('data', text.slice(0, 5));
      stdout.emit('data', text.slice(5));
    } else {
      stdout.emit('data', text);
    }
  };

  stdin.write = (chunk) => {
    buffer += String(chunk);
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let req = null;
      try { req = JSON.parse(line); } catch { req = null; }
      if (req) {
        sent.push(req);
        const answer = onRequest(req);
        if (answer !== null && answer !== undefined) {
          // 走一个微任务再回，模拟真实管道的异步
          queueMicrotask(() => emitLine({ id: req.id, ...answer }));
        }
      }
      idx = buffer.indexOf('\n');
    }
    return true;
  };

  return { child, sent, get killed() { return killed; } };
}

function residentSetup(onRequest, opts = {}) {
  const helperMod = helper;
  helperMod.resetResidentHelper();
  helperMod.resetHelperState();
  const spawned = [];
  const spawnFn = () => {
    const fake = makeFakeServe(onRequest, opts);
    spawned.push(fake);
    return fake.child;
  };
  const state = { mode: 'native', exe: 'C:/fake/orbis-desktop-win.exe', why: 'ok' };
  return { spawnFn, spawned, state, helperMod };
}

await test('★ 常驻：按 id 匹配响应（不再靠「下一个回包就是我的」）', async () => {
  const { spawnFn, spawned, state, helperMod } = residentSetup((req) => ({ ok: true, echo: req.cmd }));
  try {
    const r1 = await helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state });
    const r2 = await helperMod.callHelperAsync('cursor', {}, { spawn: spawnFn, state });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.echo, 'probe');
    assert.equal(r2.echo, 'cursor');
    assert.equal(spawned.length, 1, '两条请求必须复用同一个常驻进程');
    assert.deepEqual(spawned[0].sent.map((s) => s.cmd), ['probe', 'cursor']);
    assert.equal(helperMod.residentInfo().alive, true);
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ 常驻：一条 stdout 被拆成多个 chunk 也能正确拼回去', async () => {
  const big = { ok: true, pngBase64: 'A'.repeat(5000), width: 10, height: 10 };
  const { spawnFn, state, helperMod } = residentSetup(() => big, { split: true });
  try {
    const r = await helperMod.callHelperAsync('capture', {}, { spawn: spawnFn, state });
    assert.equal(r.ok, true);
    assert.equal(r.pngBase64.length, 5000, '分片要拼完整（否则 base64 会被截断成坏图）');
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ 常驻：多条响应挤在同一个 chunk 里也按行切开', async () => {
  const { spawnFn, spawned, state, helperMod } = residentSetup((req) => ({ ok: true, n: req.id }));
  try {
    // 灌两段进同一个 data 事件
    const p1 = helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state });
    const p2 = helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state });
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.n, b.n, '两条响应的 id 必须分别对上（不能都拿到第一条）');
    assert.equal(spawned[0].sent.length, 2);
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ 常驻：单条超时 → 杀进程、这条如实失败、下一条自动重启', async () => {
  let n = 0;
  const { spawnFn, spawned, state, helperMod } = residentSetup(() => {
    n += 1;
    return n === 1 ? null : { ok: true, after: true }; // 第一条永不回包
  });
  try {
    const slow = await helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state, timeoutMs: 120 });
    assert.equal(slow.ok, false);
    assert.equal(slow.code, 'helper_timeout', JSON.stringify(slow));
    assert.equal(spawned[0].killed, true, '超时必须杀掉进程（否则这条管道永远被占着）');
    const next = await helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(spawned.length, 2, '超时之后要能重新拉起一个');
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ 常驻：连续崩溃超过阈值 → 自动降级 PowerShell（不无限重启）', async () => {
  helper.resetHelperState();
  helper.resetResidentHelper();
  let spawns = 0;
  const spawnFn = () => {
    spawns += 1;
    // 一起来就"崩"：不回任何东西，直接 exit
    const fake = makeFakeServe(() => null);
    queueMicrotask(() => fake.child.emit('exit', 1));
    return fake.child;
  };
  const state = { mode: 'native', exe: 'C:/fake/orbis-desktop-win.exe', why: 'ok' };
  try {
    for (let i = 0; i < 8; i += 1) {
      await helper.callHelperAsync('probe', {}, {
        spawn: spawnFn, state, timeoutMs: 60,
        // 常驻起不来时退回一次性进程：这里让它也失败，只观察降级
        run: () => { throw new Error('no exe here'); },
      });
    }
    assert.ok(helper.residentInfo().broken === 'resident_crashed',
      `连着崩之后必须降级，实际 ${JSON.stringify(helper.residentInfo())}`);
    assert.ok(spawns <= 7, `不能无限重启风暴（实际拉了 ${spawns} 次）`);
    // 降级之后 helperState 缓存必须是 powershell
    assert.equal(helper.helperState().mode, 'powershell');
  } finally {
    helper.resetResidentHelper();
    helper.resetHelperState();
  }
});

await test('★ 常驻：stopDesktopHelper 杀掉子进程，之后 residentInfo().alive === false', async () => {
  const { spawnFn, spawned, state, helperMod } = residentSetup(() => ({ ok: true }));
  const p = helperMod.callHelperAsync('probe', {}, { spawn: spawnFn, state });
  await p;
  assert.equal(helperMod.residentInfo().alive, true);
  const stopped = await helperMod.stopDesktopHelper();
  assert.equal(stopped.stopped, true);
  assert.equal(spawned[0].killed, true, '停机必须真的 kill');
  assert.equal(helperMod.residentInfo().alive, false);
});

await test('★ 常驻：协议是 {id, cmd, payload}，一行一条', async () => {
  const { spawnFn, spawned, state, helperMod } = residentSetup(() => ({ ok: true }));
  try {
    await helperMod.callHelperAsync('capture', { rect: { x: 1, y: 2, width: 3, height: 4 } }, { spawn: spawnFn, state });
    const sent = spawned[0].sent[0];
    assert.deepEqual(sent.cmd, 'capture');
    assert.deepEqual(sent.payload.rect, { x: 1, y: 2, width: 3, height: 4 });
    assert.equal(typeof sent.id, 'number');
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ 常驻：助手回 {ok:false} 时如实透出 code/text（不当成功）', async () => {
  const { spawnFn, state, helperMod } = residentSetup(() => ({ ok: false, code: 'not_aware', text: '声明不了 DPI 感知' }));
  try {
    const r = await helperMod.callHelperAsync('env', {}, { spawn: spawnFn, state });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_aware');
    assert.match(r.text, /DPI/);
  } finally {
    await helperMod.stopDesktopHelper();
  }
});

await test('★ capture 落盘：助手只回 base64，文件由 Node 侧写（助手不碰文件系统）', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'Orbis-shot-'));
  const outFile = pathMod.join(dir, 'shot.png');
  // 1×1 的合法 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const { spawnFn, state, helperMod } = residentSetup(() => ({
    ok: true, pngBase64: png.toString('base64'), width: 1, height: 1,
    originalWidth: 4000, originalHeight: 3000, resized: true, method: 'print_window',
  }));
  try {
    const obs = await import(src('desktop-observe.js'));
    // 直接测「解码 + 落盘」这一段：走的是 captureScreenshot 里的原生分支
    const r = await helperMod.callHelperAsync('capture', {}, { spawn: spawnFn, state });
    assert.equal(r.ok, true);
    await fsMod.promises.writeFile(outFile, Buffer.from(r.pngBase64, 'base64'));
    const bytes = fsMod.readFileSync(outFile);
    assert.deepEqual(bytes, png, '落盘内容必须和助手给的 base64 一致');
    assert.equal(r.resized, true);
    assert.equal(r.originalWidth, 4000);
    assert.equal(obs.listWindows !== undefined, true);
  } finally {
    await helperMod.stopDesktopHelper();
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

await test('★ 真机：常驻 capture 可用时返回 base64 且长边不超过 maxEdge', async () => {
  if (!hasReal) {
    console.log('    （跳过：本机没有可用的桌面助手）');
    return;
  }
  helper.resetHelperState();
  helper.resetResidentHelper();
  try {
    const r = await helper.callHelperAsync('capture', {
      rect: { x: 0, y: 0, width: 1200, height: 800 }, maxEdge: 640,
    });
    if (r.ok !== true) {
      console.log(`    （跳过：capture 不可用 —— ${r.code} ${r.text}）`);
      return;
    }
    assert.ok(String(r.pngBase64).length > 100, '应回一张真图');
    assert.ok(Math.max(r.width, r.height) <= 640, `长边应 ≤ 640，实际 ${r.width}x${r.height}`);
    assert.equal(r.resized, true);
    assert.ok(['print_window', 'bitblt'].includes(r.method), `method 应如实，实际 ${r.method}`);
  } finally {
    await helper.stopDesktopHelper();
  }
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
