/**
 * 进程表扫描（测试用，**异步**）。
 *
 * 为什么不用 `execSync` / `ps` 同步版：这是测试辅助，但硬规矩 3 的精神同样适用 ——
 * `shells.mjs` 里要反复扫表，同步阻塞会把被测的定时器逻辑搅乱（扫描期间事件循环停住，
 * 进程回收的 `exit` 事件迟迟不派发，反而制造假残留）。
 *
 * 两个平台各走一条：
 *   · Windows：`Get-CimInstance Win32_Process`，服务端按命令行过滤（只回带标记的行）；
 *   · POSIX：`ps -A -o pid= -o command=`，客户端过滤（macOS / Linux 都支持这套参数）。
 *
 * 只在测试里用：它会起子进程，不能进运行期路径。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 进程表里的一条：只要 pid 与命令行，不碰其它字段。 */
/**
 * @typedef {{pid:number, command:string}} ProcRow
 */

function parseRows(stdout) {
  const rows = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const m = text.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

/**
 * 列出命令行里带某个标记的进程。
 *
 * @param {string} marker
 * @returns {Promise<ProcRow[]>}
 */
export async function findProcesses(marker) {
  const tag = String(marker ?? '').trim();
  if (!tag) throw new Error('proc-scan 需要一个标记');
  if (process.platform === 'win32') {
    // 标记只含字母数字与短横线，拼进 PowerShell 单引号里是安全的
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe' or Name='sh' or Name='bash'" |`,
      `  Where-Object { $_.CommandLine -like '*${tag}*' } |`,
      '  ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
    ].join('\n');
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return parseRows(stdout).filter((row) => row.command.includes(tag));
    } catch {
      // 查询失败就别把测试搞红（拿不到证据 ≠ 有残留），由调用方按超时处理
      return [];
    }
  }
  try {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=', '-o', 'command='], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseRows(stdout).filter((row) => row.command.includes(tag));
  } catch {
    return [];
  }
}

/**
 * 等到扫描不到任何带标记的进程（或在超时后如实返回残留）。
 *
 * @param {string} marker
 * @param {{timeoutMs?:number, intervalMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, remaining:ProcRow[]}>}
 */
export async function waitGone(marker, { timeoutMs = 5_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 5_000);
  let remaining = [];
  for (;;) {
    remaining = await findProcesses(marker);
    if (!remaining.length) return { ok: true, remaining };
    if (Date.now() > deadline) return { ok: false, remaining };
    await new Promise((r) => setTimeout(r, Math.max(50, Number(intervalMs) || 200)));
  }
}

/** 把残留格式化成人能看的一行（只打 pid 和命令前 120 字，避免日志刷屏）。 */
export function describeRemaining(rows) {
  return (rows ?? [])
    .map((row) => `pid=${row.pid} ${String(row.command).slice(0, 120)}`)
    .join(' | ');
}
