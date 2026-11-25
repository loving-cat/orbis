/**
 * Windows 桌面助手客户端（阶段 A：单次进程）。
 *
 * 规格 SPEC-PERF-V1 §5.3：`orbis-desktop-win.exe <command>` + stdin/stdout 一个 JSON。
 * 阶段 B（§5.4）在同一文件里加了常驻客户端：`callHelperAsync` 走
 * `orbis-desktop-win.exe serve`，按 id 匹配响应、单请求超时、崩溃退避重启；
 * 连着崩就**自动降级回 PowerShell**（绝不无限重启风暴）。
 * 阶段 A 的 `callHelper`（一次性进程）保留 —— 它是常驻模式的最后一道兜底。
 *
 * ## 三件事必须做对
 *
 *   1. **fail-open 回退**：助手缺失 / 跑不起来 / 版本不符 / 哈希不符 → 自动回退到
 *      原来的 PowerShell 实现，并**只打一次**日志。桌面输入是用户要用的功能，
 *      不能因为一个可选的原生二进制没打进包就整个不可用。
 *   2. **fail-closed 校验**：只要用了助手，就必须认版本与 sha256 清单 ——
 *      一个来历不明的同名 exe 不该拿到用户桌面的输入权限。
 *   3. **可注入**：`run` 可替换，单测在 macOS / Linux CI 上也能覆盖参数拼装、
 *      输出解析、回退分支（那两个平台没有这个 exe）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { log } from './util.js';
import { readBrandEnv } from './brand.js';

/** 助手版本（与 native/orbis-desktop-win/Cargo.toml 一致；不一致就回退）。 */
export const DESKTOP_HELPER_VERSION = '0.2.0';

/** 协议版本：stdio 上一问一答的 JSON，字段见 §5.2。 */
export const HELPER_PROTOCOL = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE_NAME = 'orbis-desktop-win.exe';

/** 环境变量开关：`native`（默认）或 `powershell`（强制旧实现）。 */
export const IMPL_ENV = 'ORBIS_DESKTOP_WIN_IMPL';

/**
 * 候选路径。
 *
 * `ORBIS_DESKTOP_WIN_HELPER` 是**排他**覆盖：设了就只认它（哪怕它不存在）。
 * 这样运维/测试可以明确指定"用这个构建"，而不是"优先这个、找不到再悄悄换一个"——
 * 后者会让"我明明指向了新版本却没生效"变成一个很难查的问题。
 */
export function helperCandidates({ env = process.env } = {}) {
  // ★ 一律走 readBrandEnv（品牌前缀只有一处真源）；直接读 env.ORBIS_* 会被
  //   `tests/brand.mjs` 判红，更实际的问题是改名时会漏掉这一处。
  const override = String(readBrandEnv(env, 'DESKTOP_WIN_HELPER') || '').trim();
  if (override) return [override];
  return [path.join(HERE, '..', 'resources', EXE_NAME)];
}

/** 找到第一个存在的助手文件（不校验，只找）。 */
export function resolveHelper({ env = process.env } = {}) {
  for (const candidate of helperCandidates({ env })) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 不存在就试下一个 */ }
  }
  return null;
}

/** 默认 runner：同步执行，stdin 写 JSON，stdout 收 JSON。 */
export function defaultRun(exe, args, input, { timeoutMs = 15_000 } = {}) {
  return execFileSync(exe, args, {
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 把助手的 stdout 解析成统一返回；解析不出来就是 call_failed，绝不猜。 */
export function parseHelperOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, code: 'call_failed', text: '桌面助手没有输出（可能被系统杀掉或崩溃）' };
  }
  const lastLine = text.split('\n').filter(Boolean).pop() || '';
  let value;
  try {
    value = JSON.parse(lastLine);
  } catch {
    return { ok: false, code: 'call_failed', text: `桌面助手输出不是 JSON：${lastLine.slice(0, 200)}` };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'call_failed', text: '桌面助手返回的不是对象' };
  }
  return normalizeHelperValue(value);
}

/**
 * 把助手回的对象归一成统一形状（`{ok:true,...}` / `{ok:false,code,text}`）。
 *
 * 单独抽出来是为了**异步路径直接复用**：常驻模式拿到的是已经 parse 过的对象，
 * 再 `JSON.stringify` + `JSON.parse` 走一遍 parseHelperOutput 是纯浪费
 * （一条 windows 列表要往返序列化两次，几毫秒就这么没了）。
 */
export function normalizeHelperValue(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'call_failed', text: '桌面助手返回的不是对象' };
  }
  if (value.ok === true) return value;
  return {
    ok: false,
    code: typeof value.code === 'string' ? value.code : 'call_failed',
    text: typeof value.text === 'string' ? value.text : '桌面助手返回了失败但没有说明原因',
  };
}

/**
 * 校验助手：版本 + 协议 + sha256 清单。
 *
 * 清单（`orbis-desktop-win.sha256`）是可选的：本地开发直接从 cargo 产物拷过来
 * 可能没有清单；**但只要有清单就必须对得上**。
 */
export function verifyHelper(exePath, { run = defaultRun } = {}) {
  // ★ 顺序很重要：**先验哈希，再执行**。
  //
  //   先 `run(exe, ['version'])` 等于「把一份可能被替换过的可执行文件先跑起来」——
  //   版本自检本身就是执行它，篡改过的 exe 已经跑完了再报"哈希不符"毫无意义。
  //   所以清单存在时，必须先算摘要比对通过，才允许 spawn。
  const manifest = path.join(path.dirname(exePath), 'orbis-desktop-win.sha256');
  let manifestText = null;
  try {
    manifestText = fs.readFileSync(manifest, 'utf8');
  } catch (err) {
    // 只有"清单不存在"才算没有清单（本地开发直接拷 cargo 产物就是这种）；
    // 其它读失败（权限/IO）一律 fail-closed —— 读不到清单就没法证明 exe 没被换过。
    if (err?.code !== 'ENOENT') {
      return { ok: false, reason: 'manifest_unreadable', detail: String(err?.message || err).slice(0, 200) };
    }
  }
  if (manifestText != null) {
    let want = '';
    try {
      want = String(manifestText).trim().split(/\s+/)[0].toLowerCase();
    } catch {
      want = '';
    }
    let got = '';
    try {
      got = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
    } catch (err) {
      return { ok: false, reason: 'hash_unreadable', detail: String(err?.message || err).slice(0, 200) };
    }
    if (!want) {
      return { ok: false, reason: 'manifest_unreadable', detail: '清单里没有哈希' };
    }
    if (want !== got) {
      // ★ 到这里就返回：**绝不执行**一个对不上清单的 exe
      return { ok: false, reason: 'hash_mismatch', detail: `${want} != ${got}` };
    }
  }

  // 哈希过关（或本来就没有清单）之后，才允许执行版本自检。
  let raw;
  try {
    raw = run(exePath, ['version'], '{}', { timeoutMs: 10_000 });
  } catch (err) {
    return { ok: false, reason: 'broken', detail: String(err?.message || err).slice(0, 200) };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? '').trim().split(String.fromCharCode(10)).filter(Boolean).pop() || '');
  } catch {
    return { ok: false, reason: 'broken', detail: '版本输出不是 JSON' };
  }
  if (parsed?.ok !== true) {
    return { ok: false, reason: 'broken', detail: String(parsed?.text || '版本自检失败').slice(0, 200) };
  }
  if (String(parsed.version) !== DESKTOP_HELPER_VERSION) {
    return {
      ok: false,
      reason: 'version_mismatch',
      detail: `期望 ${DESKTOP_HELPER_VERSION}，实际 ${parsed.version}`,
    };
  }
  if (Number(parsed.protocol) !== HELPER_PROTOCOL) {
    return {
      ok: false,
      reason: 'protocol_mismatch',
      detail: `期望 ${HELPER_PROTOCOL}，实际 ${parsed.protocol}`,
    };
  }
  return { ok: true, version: String(parsed.version) };
}

/** 缓存：一次进程生命周期里只探测/校验一次（每次调用都跑一遍 exe 太亏）。 */
let cached = null;

/** 单测用：清掉缓存（改了 env / 换了假 exe 之后要能重来）。 */
export function resetHelperState() {
  cached = null;
}

/**
 * 这个进程现在该用哪条实现。
 *
 * @returns {{mode:'native'|'powershell', exe:string|null, why:string}}
 *   `mode==='native'` 时 `exe` 一定已经通过版本/哈希校验。
 */
export function helperState({ env = process.env, run = defaultRun, force = false } = {}) {
  if (cached && !force) return cached;
  const impl = String(readBrandEnv(env, 'DESKTOP_WIN_IMPL') || 'native').trim().toLowerCase();
  if (impl === 'powershell') {
    cached = { mode: 'powershell', exe: null, why: 'forced_by_env' };
    return cached;
  }
  const exe = resolveHelper({ env });
  if (!exe) {
    cached = { mode: 'powershell', exe: null, why: 'helper_missing' };
    logDesktopFallback(cached.why);
    return cached;
  }
  const verdict = verifyHelper(exe, { run });
  if (!verdict.ok) {
    cached = { mode: 'powershell', exe: null, why: verdict.reason, detail: verdict.detail };
    logDesktopFallback(verdict.reason, verdict.detail);
    return cached;
  }
  cached = { mode: 'native', exe, why: 'ok' };
  return cached;
}

/** 回退只记一次日志：每次调用都喊一遍会把 server.log 刷满。 */
let fallbackLogged = false;
function logDesktopFallback(reason, detail = '') {
  if (fallbackLogged) return;
  fallbackLogged = true;
  log(
    `ℹ️ Windows 桌面助手不可用（${reason}${detail ? `：${detail}` : ''}）→ 回退 PowerShell 实现`
    + '（慢约 10 倍，但功能不变）。跑 scripts/build-desktop-win.ps1 可生成原生助手。',
  );
}

/**
 * 调一次助手。
 *
 * @param {string} command 子命令（version/env/probe/cursor/foreground/perform/noise/windows/drag-step）
 * @param {object} [payload] 请求体
 * @param {{run?:Function, state?:object, timeoutMs?:number}} [opts]
 * @returns {object} 助手返回的 JSON（`{ok:true,...}` 或 `{ok:false, code, text}`）
 */
export function callHelper(command, payload = {}, { run = defaultRun, state = null, timeoutMs = 15_000 } = {}) {
  const current = state ?? helperState({ run });
  if (current.mode !== 'native' || !current.exe) {
    return { ok: false, code: 'helper_unavailable', text: `桌面助手不可用（${current.why}）` };
  }
  let raw;
  try {
    raw = run(current.exe, [command], JSON.stringify(payload ?? {}), { timeoutMs });
  } catch (err) {
    return { ok: false, code: 'call_failed', text: `桌面助手调用失败：${String(err?.message || err).slice(0, 300)}` };
  }
  return parseHelperOutput(raw);
}

/** 给测试用的「跳过缓存」入口（生产不用）。 */
export function callHelperFresh(command, payload = {}, { run = defaultRun, env = process.env, timeoutMs = 15_000 } = {}) {
  return callHelper(command, payload, { run, state: helperState({ env, run, force: true }), timeoutMs });
}
// ---------------------------------------------------------------- 常驻客户端（阶段 B）

/**
 * 常驻进程状态。
 *
 * `pending` 用**自增 id** 匹配：这条管道是串行复用的，所以「谁的回包」必须靠 id
 * 而不是「谁发的下一个」。乱序（超时/重试交错）时这一点尤其关键。
 */
const resident = {
  child: null,
  ready: null,
  closed: false,
  seq: 0,
  pending: new Map(),
  buffer: '',
  /** 连续崩溃计数（短时间窗内超过阈值就降级 PowerShell） */
  crashes: 0,
  lastCrashAt: 0,
  /** 常驻不可用（降级后）的原因；null = 还能用 */
  broken: null,
  /** 崩溃退避窗口的截止时刻（`ensureResident` 会等它过去） */
  nextRestartAt: 0,
};

/** stdout 缓冲上限：capture 的 base64 PNG 可以是几 MB，给 64 MB 很宽松。 */
const MAX_BUFFER = 64 * 1024 * 1024;
/** 连续崩溃超过这个次数（在窗口期内）就降级。 */
const MAX_CRASHES = 5;
/** 崩溃计数的窗口：超过这个时间没崩，计数清零（偶发崩溃不该累积成降级）。 */
const CRASH_WINDOW_MS = 60_000;
/** 退避重启：200ms → 1s → 5s。 */
const RESTART_BACKOFF_MS = [200, 1_000, 5_000];

/** 每个命令的默认超时（capture 要给 PrintWindow + PNG 编码多留时间）。 */
export function timeoutForCommand(command) {
  return command === 'capture' ? 20_000 : 15_000;
}

/** 默认 spawn（可注入：macOS/Linux CI 上用假的子进程跑协议单测）。 */
export function defaultSpawn(exe, args, opts = {}) {
  return spawn(exe, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

/** 清掉常驻状态（单测用；生产只在停机时用）。 */
export function resetResidentHelper() {
  resident.child = null;
  resident.ready = null;
  resident.closed = false;
  resident.seq = 0;
  resident.pending.clear();
  resident.buffer = '';
  resident.crashes = 0;
  resident.lastCrashAt = 0;
  resident.broken = null;
  resident.nextRestartAt = 0;
}

/** 这一条待处理请求作废（超时 / 进程挂了）。 */
function failPending(id, result) {
  const entry = resident.pending.get(id);
  if (!entry) return;
  resident.pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(result);
}

/**
 * 常驻进程死了：所有在途请求立刻失败，按退避重启；连着崩就降级 PowerShell。
 *
 * ★ 降级要**改掉 helperState 的缓存** —— 否则下一次 `helperState()` 还说
 *   "native 可用"，我们又把它拉起来，变成「崩溃 → 重启 → 崩溃」的风暴。
 */
function handleResidentExit(exitedChild = null) {
  // ★ 三条独立守卫，缺一条都会实盘出事：
  //
  //   ① **旧子进程的迟到 exit 不能动新进程**：超时路径会先 kill 再重启，
  //      被杀的 child1 的 'exit' 常常晚于 child2 的创建才到。不过滤的话这一刀
  //      会把 resident.child（此刻是 child2）抹成 null —— 要么制造孤儿 child2，
  //      要么把它在途请求全判死。
  //   ② **同一次退出只算一次**：timeout 自己调一次、'error' 一次、'exit' 一次，
  //      同一 child 会被数到 3 次，5 次阈值几秒就撞穿，直接误降级 PowerShell。
  //   ③ 只有当前 child（或未传）才清状态与 fail pending。
  if (exitedChild && exitedChild.__exitHandled) return;
  if (exitedChild) exitedChild.__exitHandled = true;
  if (exitedChild && resident.child && exitedChild !== resident.child) return;

  const child = resident.child;
  resident.child = null;
  resident.ready = null;
  resident.buffer = '';
  if (child) {
    try { child.stdout?.removeAllListeners?.(); } catch {}
    try { child.stdin?.end?.(); } catch {}
  }
  for (const id of [...resident.pending.keys()]) {
    failPending(id, { ok: false, code: 'helper_crashed', text: '桌面助手常驻进程退出了' });
  }
  if (resident.closed) return; // 主动停机，不算崩溃

  const now = Date.now();
  if (now - resident.lastCrashAt > CRASH_WINDOW_MS) resident.crashes = 0;
  resident.crashes += 1;
  resident.lastCrashAt = now;

  if (resident.crashes > MAX_CRASHES) {
    resident.broken = 'resident_crashed';
    cached = { mode: 'powershell', exe: null, why: 'resident_crashed' };
    logDesktopFallback('resident_crashed', `连续 ${resident.crashes} 次异常退出`);
    return;
  }
  const backoff = RESTART_BACKOFF_MS[Math.min(resident.crashes - 1, RESTART_BACKOFF_MS.length - 1)];
  // ★ 退避要**真的等**：只打一行日志等于没有退避，一次上游问题能让它
  //   1 秒内重启 5 次。ensureResident 会看这个时间戳。
  resident.nextRestartAt = now + backoff;
  log(`桌面助手常驻进程异常退出，${backoff}ms 后重启（第 ${resident.crashes} 次）`);
}

/** 等到退避窗口过去（没有退避时立刻返回）。 */
async function waitRestartBackoff() {
  const at = Number(resident.nextRestartAt) || 0;
  if (!at) return;
  const left = at - Date.now();
  resident.nextRestartAt = 0;
  if (left > 0) {
    // ★ 这个定时器**不能 unref**：它是"有人正在等退避结束"的唯一强引用，
    //   unref 掉之后事件循环会立刻空转退出（node 报 unsettled top-level await）。
    await new Promise((resolve) => { setTimeout(resolve, left); });
  }
}

/** 拉起（或复用）常驻进程；返回可用的 child，不可用返回 null。 */
async function ensureResident({ spawn: spawnFn = defaultSpawn, state = null } = {}) {
  if (resident.broken) return null;
  if (resident.child && !resident.closed) return resident.child;
  if (resident.ready) return resident.ready;

  const current = state ?? helperState();
  if (current.mode !== 'native' || !current.exe) return null;

  // ★ 退避窗口内不重启：不然「200ms→1s→5s」只是三行日志。
  //   注意只在**真有窗口**时才 await —— 否则这一个 await 会让并发进来的第二条
  //   请求看不见下面刚占位的 `resident.ready`，各自拉起一个常驻进程（实测双 spawn）。
  if (resident.nextRestartAt) {
    await waitRestartBackoff();
    if (resident.broken) return null;
    if (resident.child && !resident.closed) return resident.child;
    if (resident.ready) return resident.ready;
  }

  resident.closed = false;
  resident.ready = (async () => {
    let child;
    try {
      child = spawnFn(current.exe, ['serve'], {});
    } catch (err) {
      resident.ready = null;
      resident.broken = 'spawn_failed';
      logDesktopFallback('spawn_failed', String(err?.message || err).slice(0, 160));
      return null;
    }
    resident.child = child;
    resident.buffer = '';

    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => onResidentData(String(chunk)));
    // 助手的 stderr 只做诊断，不进协议
    child.stderr?.on?.('data', () => {});
    child.once?.('exit', () => handleResidentExit(child));
    child.once?.('error', () => handleResidentExit(child));
    child.stdin?.on?.('error', () => {});
    // ★ 子进程与它的管道必须 unref：常驻进程是「服务端活着它就活着」的附属物，
    //   但它**不能**成为「进程为什么退不出去」的原因。
    //   不加这一步，任何跑完就想退出的场景（单测、CLI、one-shot 脚本）都会卡在
    //   「还有一个子进程的 pipe 开着」上永远不退 —— 实测把 tests/all.mjs 挂死。
    //   真正在途的请求由下面的超时定时器（ref 的）保证事件循环不会提前收工。
    try { child.unref?.(); } catch {}
    try { child.stdin?.unref?.(); } catch {}
    try { child.stdout?.unref?.(); } catch {}
    try { child.stderr?.unref?.(); } catch {}
    return child;
  })();
  try {
    const child = await resident.ready;
    resident.ready = null;
    return child;
  } catch {
    resident.ready = null;
    return null;
  }
}

/** 收到一段 stdout：按行切，逐行匹配 id。 */
function onResidentData(chunk) {
  resident.buffer += chunk;
  if (resident.buffer.length > MAX_BUFFER) {
    // 缓冲爆掉 = 协议已经乱了（对端在吐垃圾），按崩溃处理
    resident.buffer = '';
    try { resident.child?.kill?.(); } catch {}
    handleResidentExit();
    return;
  }
  let idx = resident.buffer.indexOf('\n');
  while (idx >= 0) {
    const line = resident.buffer.slice(0, idx).trim();
    resident.buffer = resident.buffer.slice(idx + 1);
    if (line) onResidentLine(line);
    idx = resident.buffer.indexOf('\n');
  }
}

function onResidentLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    // 解析不了当噪声忽略：真正的请求会各自超时，不会永久挂着
    return;
  }
  const id = value?.id;
  if (id == null) return;
  failPending(id, value && typeof value === 'object' ? value : { ok: false, code: 'call_failed', text: '助手返回的不是对象' });
}

/**
 * 异步调一次助手（**优先常驻**，常驻起不来就退回一次性进程）。
 *
 * @param {string} command
 * @param {object} [payload]
 * @param {object} [opts]
 * @param {Function} [opts.spawn]   注入 spawn（单测用假子进程）
 * @param {object}   [opts.state]   注入 helperState 结果
 * @param {Function} [opts.run]     一次性进程的 runner（常驻不可用时用）
 * @param {number}   [opts.timeoutMs]
 */
export async function callHelperAsync(command, payload = {}, {
  spawn: spawnFn = defaultSpawn, state = null, run = defaultRun, timeoutMs = null,
} = {}) {
  const current = state ?? helperState({ run });
  if (current.mode !== 'native' || !current.exe) {
    return { ok: false, code: 'helper_unavailable', text: `桌面助手不可用（${current.why}）` };
  }
  // ★ 已经降级（连着崩）时直接说不可用：绝不能在这里退回 `callHelper()` ——
  //   那是 execFileSync，会在事件循环上同步阻塞，而「降级」的前提恰恰是
  //   「这条路已经不可靠」，用它兜底等于把卡顿重新引回来。
  if (resident.broken) {
    return {
      ok: false,
      code: 'helper_unavailable',
      text: `桌面助手常驻不可用（${resident.broken}），已降级 PowerShell`,
    };
  }
  const child = await ensureResident({ spawn: spawnFn, state: current });
  if (!child) {
    // 常驻起不来 → 退回一次性进程（阶段 A 的路径），功能不降级
    return callHelper(command, payload, { run, state: current, timeoutMs: timeoutMs ?? timeoutForCommand(command) });
  }

  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : timeoutForCommand(command);
  resident.seq += 1;
  const id = resident.seq;
  const line = JSON.stringify({ id, cmd: command, payload: payload ?? {} });
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resident.pending.delete(id);
      // 单条卡死：杀进程（下次请求自动重启），这条如实超时。
      // 传当前 child 进去，让它在同一个「一次性已处理」标记下只算一次崩溃。
      const dying = resident.child;
      try { dying?.kill?.(); } catch {}
      handleResidentExit(dying);
      resolve({ ok: false, code: 'helper_timeout', text: `桌面助手 ${limit}ms 内没有响应（已重启）` });
    }, limit);
    resident.pending.set(id, { resolve, timer });
    try {
      child.stdin?.write?.(line + '\n');
    } catch (err) {
      failPending(id, { ok: false, code: 'call_failed', text: String(err?.message || err).slice(0, 200) });
    }
  });
  return normalizeHelperValue(answer);
}

/**
 * 停机：杀掉常驻子进程，不留孤儿。
 *
 * `process.once('exit')` 与 server-main 的停机钩子都会调它；重复调用安全。
 */
export async function stopDesktopHelper() {
  resident.closed = true;
  resident.broken = null;
  resident.nextRestartAt = 0;
  const child = resident.child;
  resident.child = null;
  resident.ready = null;
  resident.buffer = '';
  for (const id of [...resident.pending.keys()]) {
    failPending(id, { ok: false, code: 'helper_stopped', text: '桌面助手已停机' });
  }
  if (!child) return { ok: true, stopped: false };
  try { child.stdin?.end?.(); } catch {}
  try { child.kill?.(); } catch {}
  return { ok: true, stopped: true };
}

/** 常驻进程现在是不是活着（诊断/测试用）。 */
export function residentInfo() {
  return {
    alive: Boolean(resident.child) && !resident.closed,
    pending: resident.pending.size,
    crashes: resident.crashes,
    broken: resident.broken,
    nextRestartAt: resident.nextRestartAt,
  };
}

// 进程退出时兜底杀一次：不能留一个还在等 stdin 的助手进程。
if (typeof process !== 'undefined' && typeof process.once === 'function') {
  process.once('exit', () => { try { stopDesktopHelper(); } catch {} });
}
