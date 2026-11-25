/**
 * Windows 桌面助手客户端（阶段 A：单次进程）。
 *
 * 规格 SPEC-PERF-V1 §5.3：`orbis-desktop-win.exe <command>` + stdin/stdout 一个 JSON。
 * 阶段 B 会在这个文件里加「常驻进程 + 按 id 匹配 + 崩溃重启」，所以文件名先占住
 * `desktop-helper-win.js`（§5.4 点名的就是它）。
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { log } from './util.js';
import { readBrandEnv } from './brand.js';

/** 助手版本（与 native/orbis-desktop-win/Cargo.toml 一致；不一致就回退）。 */
export const DESKTOP_HELPER_VERSION = '0.1.0';

/** 协议版本：stdio 上一问一答的 JSON，字段见 §5.2。 */
export const HELPER_PROTOCOL = 1;

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
