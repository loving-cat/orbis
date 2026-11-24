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
  // ★ fail-closed：查询本身失败时**绝不**返回空数组。
  //
  //   返回 [] 看起来像「零残留，通过」—— 那是最坏的一种假绿：扫表功能坏了，
  //   泄漏的进程再也不会让测试变红。这里直接抛，由 `waitGone` 重试到超时再如实报错。
  if (process.platform === 'win32') {
    // 标记只含字母数字与短横线，拼进 PowerShell 单引号里是安全的
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe' or Name='sh' or Name='bash'" |`,
      `  Where-Object { $_.CommandLine -like '*${tag}*' } |`,
      '  ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
    ].join(String.fromCharCode(10));
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseRows(stdout).filter((row) => row.command.includes(tag) && row.pid !== process.pid);
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=', '-o', 'command='], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  // 排除扫描器自己：`node -e "...Orbis-shells-..."` 这类命令行也带标记，
  // 不排掉就会把自己当成残留（假红），或者在"扫表失败"的诊断里刷屏。
  return parseRows(stdout).filter((row) => row.command.includes(tag) && row.pid !== process.pid);
}

export async function waitGone(marker, { timeoutMs = 5_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 5_000);
  let remaining = [];
  let lastError = null;
  for (;;) {
    try {
      remaining = await findProcesses(marker);
      lastError = null;
      if (!remaining.length) return { ok: true, remaining };
    } catch (err) {
      // 查询失败重试到超时：**不能**当成「没残留」（那是假绿）
      remaining = [];
      lastError = err;
    }
    if (Date.now() > deadline) {
      if (lastError) throw new Error(`进程表扫描失败（无法证明零残留）：${lastError?.message || lastError}`);
      return { ok: false, remaining };
    }
    await new Promise((r) => setTimeout(r, Math.max(50, Number(intervalMs) || 200)));
  }
}

/** 把残留格式化成人能看的一行（只打 pid 和命令前 120 字，避免日志刷屏）。 */
export function describeRemaining(rows) {
  return (rows ?? [])
    .map((row) => `pid=${row.pid} ${String(row.command).slice(0, 120)}`)
    .join(' | ');
}
