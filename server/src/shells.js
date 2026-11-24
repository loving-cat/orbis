/**
 * 后台进程注册表。
 *
 * 普通 bash 工具是阻塞的：跑一个 dev server 就只能等到超时。
 * 这里维护一组长任务：拿到 id 与 pid，之后可以读增量输出、写 stdin、主动结束。
 *
 * 约束：
 *   · 全局同时最多 MAX_SHELLS 个，超出拒绝（由调用方先结束旧的）；
 *   · 每个进程只保留最近 MAX_BUFFER_BYTES 字节输出，超出丢弃最早的并置 truncated；
 *   · 空闲超过 IDLE_MS 自动结束（防忘记关）；
 *   · 只登记输出与状态，不做任何命令判定 —— 规则在调用方（工具层）执行。
 */
import './child-env.js';
import { spawn } from 'node:child_process';
import {
  buildChildEnv,
  defaultInstanceDir,
  ensureInstanceDirs,
  hostLocale,
  instanceHomeDir,
  instanceTmpDir,
} from './child-env-typed.js';
import { config } from './config.js';
import { store } from './store.js';
import { probeSandbox, wrapCommand } from './sandbox.js';
import { windowsSandboxMessage } from './sandbox-win.js';


import { newId, now, log } from './util.js';

/**
 * 把累计输出裁到 maxBytes 以内（只留尾部）。
 *
 * 两个坑：
 *   · **只剩一块时也可能超**：一次大写入、或者 maxBytes 很小，
 *     只判 `chunks.length > 1` 会漏掉这种情况，最后一块必须按字节截断；
 *   · 按字节截断会切断多字节字符，所以要跳过开头那些 UTF-8 续字节，
 *     否则界面第一行会是个乱码方块。
 *
 * @param {{chunks:string[], bytes:number, truncated:boolean}} entry
 * @param {number} maxBytes
 */
export function trimChunks(entry, maxBytes) {
  while (entry.bytes > maxBytes) {
    if (entry.chunks.length > 1) {
      entry.bytes -= Buffer.byteLength(entry.chunks.shift());
      entry.truncated = true;
      continue;
    }
    const buf = Buffer.from(entry.chunks[0] ?? '', 'utf8');
    const tail = buf.subarray(Math.max(0, buf.length - maxBytes));
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    const kept = tail.subarray(start).toString('utf8');
    entry.chunks[0] = kept;
    entry.bytes = Buffer.byteLength(kept);
    entry.truncated = true;
    return;
  }
}

export const MAX_SHELLS = 20;
export const MAX_BUFFER_BYTES = 64 * 1024;
export const IDLE_MS = 30 * 60 * 1000;

/**
 * 这个 bot 是不是挂了 MCP。
 *
 * 挂了 MCP 的 bot 已经具备"驱动外部程序"的能力，它自己的 shell 也不该
 * 能碰到用户凭据 —— 这条判定与 sandboxed-shell.js 里的口径一致。
 * 查不到就当作**有**（fail-closed：宁可多隔离一层）。
 */
function hasMcpFor(botId) {
  try {
    const bot = store.getBot(botId);
    if (bot?.role === 'main' && config.jarvisMode !== false) return false;
    return store.mcpServersFor(botId).length > 0;
  } catch {
    return true;
  }
}

/** Windows：等 `taskkill /T` 自己退出的上限。 */
const KILL_TREE_TIMEOUT_MS = 5_000;

/** POSIX：整组 SIGTERM 之后等多久再升到 SIGKILL。 */
const GROUP_TERM_GRACE_MS = 1_500;

/** `stopAll()` 收工总等待上限（server-main 还会再兜一层 3 s）。 */
const STOP_ALL_TIMEOUT_MS = 3_000;

export class ShellRegistry {
  constructor({ maxShells = MAX_SHELLS, maxBytes = MAX_BUFFER_BYTES, idleMs = IDLE_MS } = {}) {
    this.maxShells = maxShells;
    this.maxBytes = maxBytes;
    this.idleMs = idleMs;
    /** @type {Map<string, object>} */
    this.shells = new Map();
    this.timer = setInterval(() => this.pruneIdle(), 60_000);
    this.timer.unref?.();
  }

  list({ roomId = null } = {}) {
    return [...this.shells.values()]
      .filter((s) => !roomId || s.roomId === roomId)
      .map((s) => ({
        id: s.id,
        pid: s.pid,
        command: s.command,
        running: s.running,
        exitCode: s.exitCode,
        startedAt: s.startedAt,
        bytes: s.bytes,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id) {
    return this.shells.get(id) ?? null;
  }

  /**
   * 正在运行的后台命令所属的实例键（`${roomId}-${botId}`）。
   *
   * 给存储清理用：`instances/<roomId>-<botId>` 是这些进程的 HOME/TMPDIR，
   * 只要进程还活着，那个目录就不能删 —— 删了进程会立刻写失败。
   */
  runningKeys() {
    const out = new Set();
    for (const entry of this.shells.values()) {
      if (!entry?.running) continue;
      if (entry.roomId && entry.botId) out.add(`${entry.roomId}-${entry.botId}`);
    }
    return out;
  }

  /**
   * 启动一个后台命令。
   * @returns {{id:string, pid:number|null, error?:string}}
   */
  start({ roomId, botId, taskId = null, command, cwd, env = null }) {
    // ★ 只数**还在跑**的：以前用 this.shells.size（含已结束的），死条目会永久占着
    //   额度 —— 跑过几轮之后就再也起不来新的，而且报的还是“已达上限”。
    const runningCount = [...this.shells.values()].filter((s) => s.running).length;
    if (runningCount >= this.maxShells) {
      return { id: null, pid: null, error: `后台进程已达上限（${this.maxShells} 个），先结束不用的` };
    }
    // 顺手清一条已结束的旧记录：只清死的，不影响正在跑的
    if (this.shells.size >= this.maxShells * 3) {
      for (const [oldId, old] of this.shells) {
        if (!old.running) {
          this.shells.delete(oldId);
          break;
        }
      }
    }
    const text = String(command ?? '').trim();
    if (!text) return { id: null, pid: null, error: '命令为空' };

    const id = newId('sh_');
    // 这个 bot 实例的私有目录：HOME / TMPDIR 都指向这里
    const instanceDir = defaultInstanceDir(
      config.dataDir,
      `${roomId ?? 'room'}-${botId ?? 'bot'}`,
    );
    ensureInstanceDirs(instanceDir);

    // ★ 挂了 MCP 的 bot：后台命令也要走沙箱。
    //
    //   这里原来直接 `spawn(text, {shell: true})`，等于完全绕过隔离：
    //   同一个 bot 的 bash 工具读不到 token，但 run_background 一句话就读到了（实测）。
    //   只有挂了 MCP 的 bot 才需要隔离（与其他 shell 工具的判定保持一致）；
    //   没挂 MCP 的 bot 保持原行为。
    const needsSandbox = hasMcpFor(botId);
    let spawnFile = text;
    let spawnArgs = [];
    let spawnShell = true;
    let sandboxCleanup = null;
    let spawnCwd = cwd;
    let spawnEnv = buildChildEnv({
      kind: 'bash',
      homeDir: instanceHomeDir(instanceDir),
      tmpDir: instanceTmpDir(instanceDir),
      locale: hostLocale(),
      // 调用方显式给的 env（后台命令的 extra）仍然生效，
      // 但敏感键由 buildChildEnv 再挡一次。
      extra: env || null,
    });

    if (needsSandbox) {
      // 后台命令统一用 powershell 跑：spec §18 的 Windows v0 只交付 PowerShell，
      // 而非 Windows 上 wrapCommand 本来就用 /bin/sh -c，两者行为一致。
      const wrapped = wrapCommand({
        command: text,
        workDir: cwd,
        tmpDir: instanceTmpDir(instanceDir),
        instanceDir,
        dataDir: config.dataDir,
      });
      if (!wrapped.ok) {
        const reason = wrapped.message
          || (process.platform === 'win32'
            ? windowsSandboxMessage(wrapped.reason, wrapped.detail)
            : wrapped.reason)
          || 'unknown';
        return { id: null, pid: null, error: `沙箱不可用，已拒绝后台执行：${reason}` };
      }
      spawnFile = wrapped.file;
      spawnArgs = wrapped.args;
      spawnShell = false;
      sandboxCleanup = wrapped.cleanup ?? null;
      // Windows 启动器自己管 cwd / env，Node 再传会和它打架
      if (process.platform === 'win32') {
        spawnCwd = undefined;
        spawnEnv = undefined;
      }
    }

    let child;
    try {
      child = spawn(spawnFile, spawnArgs, {
        cwd: spawnCwd,
        // ★ shell 子进程用类型化白名单：默认什么都不继承。
        //
        //   原来是 childEnv(process.env, ...) —— 继承宿主环境再屏蔽若干危险项，
        //   但屏蔽清单补不完（宿主 PATH 能被改，HOME 决定加载哪个 rc）。
        //   现在从空白开始，只给 PATH（固定值）/ HOME / TMPDIR / LANG。
        //
        //   HOME 和 TMPDIR 指向这个 bot 实例自己的目录，不碰用户真实的
        //   ~ 和宿主 /tmp —— 写进 rc 文件、共享临时目录这两条路都断了。
        //
        //   needsSandbox 时 spawnEnv 为 undefined 只发生在 Windows
        //   （启动器自己造环境）。
        env: spawnEnv,
        windowsHide: true,
        // 沙箱包装已经带了 shell，不能再套一层
        shell: spawnShell,
        // ★ POSIX 上让子进程当**进程组组长**（pid === pgid）。
        //   `shell: true` 走的是 `/bin/sh -c`，真实命令是孙进程；
        //   不建组就只能杀 sh，孙进程（dev server / watch）继续占着端口。
        //   Windows 走 taskkill /T，不需要也不该建组。
        detached: process.platform !== 'win32' && !needsSandbox,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      try { sandboxCleanup?.(); } catch { /* 已删 */ }
      return { id: null, pid: null, error: String(err?.message || err) };
    }

    const entry = {
      id,
      command: text,
      roomId,
      botId,
      // ★ 属于哪个任务：任务被取消/结束时按它收掉（规格 §6.3 "后台执行"
      //   以前是靠模型自己记得 kill_shell —— 那等于没回收）。
      taskId: taskId ? String(taskId) : null,
      cwd,
      needsSandbox,
      child,
      pid: child.pid ?? null,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: now(),
      lastOutputAt: now(),
      bytes: 0,
      truncated: false,
      chunks: [],
      waiters: [],
      // Windows 沙箱的 cmd 文件清理函数（非 Windows / 无沙箱时为 null）
      sandboxCleanup,
      // 正在收尾时挂着的 Promise（`kill()` 同步返回，真正的回收在这里等）
      stopping: null,
    };
    this.shells.set(id, entry);

    const append = (buf) => {
      const text = buf.toString('utf8');
      if (!text) return;
      entry.chunks.push(text);
      entry.bytes += Buffer.byteLength(text);
      entry.lastOutputAt = now();
      trimChunks(entry, this.maxBytes);
      this.#notify(entry);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (code, signal) => {
      entry.running = false;
      entry.exitCode = code;
      entry.signal = signal ?? null;
      entry.endedAt = now();
      // 沙箱的 cmd 文件由启动器读走后自己删；这里兜一次底
      try { entry.sandboxCleanup?.(); } catch { /* 已删 */ }
      this.#notify(entry);
    };
    child.on('exit', finish);
    child.on('error', (err) => {
      append(Buffer.from(`\n[启动失败] ${err?.message || err}\n`));
      finish(null, null);
    });

    return { id, pid: entry.pid };
  }

  /** 当前累计输出（受 maxBytes 限制） */
  output(id) {
    const entry = this.shells.get(id);
    if (!entry) return null;
    return entry.chunks.join('');
  }

  /**
   * 读取输出。
   *
   * @param {string} id
   * @param {{since?:number, pattern?:string, waitMs?:number}} opts
   *   since   —— 只要这个字符位置之后的内容（前端翻页用）
   *   pattern —— 匹配到就置 matched=true
   *   waitMs  —— 等新输出最多等多久（毫秒，上限 10s）
   */
  async read(id, { since = 0, pattern = '', waitMs = 0 } = {}) {
    const entry = this.shells.get(id);
    if (!entry) return null;
    const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 10_000);
    // ★ 正则只编译一次：以前每次轮询都 new RegExp，长 wait 会反复编译同一串；
    //   无效正则也不再抛（回退成子串包含）。
    let compiled = null;
    let invalidPattern = false;
    if (pattern) {
      try {
        compiled = new RegExp(String(pattern).slice(0, 512), 'm');
      } catch {
        invalidPattern = true;
      }
    }

    const snapshot = () => {
      const full = entry.chunks.join('');
      const from = Math.min(Math.max(Number(since) || 0, 0), full.length);
      const chunk = full.slice(from);
      return {
        id: entry.id,
        command: entry.command,
        running: entry.running,
        exitCode: entry.exitCode,
        signal: entry.signal,
        truncated: entry.truncated,
        offset: full.length,
        output: chunk,
        // 只看尾部 16KB：轮询是在“等新输出”，对几百 KB 的历史反复正则没有意义
        matched: pattern
          ? (invalidPattern ? chunk.includes(String(pattern)) : compiled.test(chunk.slice(-16384)))
          : false,
      };
    };

    let first = snapshot();
    while (pattern && !first.matched && entry.running && Date.now() < deadline) {
      await this.#waitForChange(entry, deadline - Date.now());
      first = snapshot();
    }
    if (!pattern && waitMs > 0 && entry.running && !first.output && Date.now() < deadline) {
      await this.#waitForChange(entry, deadline - Date.now());
      first = snapshot();
    }
    return first;
  }

  write(id, chars) {
    const entry = this.shells.get(id);
    if (!entry) return { ok: false, error: '没有这个后台进程' };
    if (!entry.running) return { ok: false, error: '进程已结束' };
    try {
      entry.child.stdin.write(String(chars ?? ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /**
   * 收掉某个任务起的全部后台进程。
   *
   * 为什么要成组收：`run_background` 起的进程不属于"某个工具调用"，
   * 而属于**那次任务**。任务被取消/结束时，它们还在跑（跑 dev server、
   * 跑 watch）—— 以前只能靠模型自己记得 `kill_shell`，等于没回收。
   *
   * @returns {{killed:string[], failed:string[]}}
   */
  killByTask(taskId, { reason = '任务结束' } = {}) {
    const id = String(taskId ?? '');
    const killed = [];
    const failed = [];
    if (!id) return { killed, failed };
    for (const entry of [...this.shells.values()]) {
      if (entry.taskId !== id) continue;
      try {
        this.kill(entry.id);
        killed.push(entry.id);
      } catch {
        failed.push(entry.id);
      }
    }
    if (killed.length) log(`🧹 回收任务 ${id} 的后台进程 ${killed.length} 个（${reason}）`);
    return { killed, failed };
  }

  kill(id) {
    const entry = this.shells.get(id);
    if (!entry) return { ok: false, error: '没有这个后台进程' };
    try {
      this.#terminateEntry(entry);
      return { ok: true, wasRunning: entry.running };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** 结束并移除（用户确认不要了） */
  remove(id) {
    const hit = this.kill(id);
    this.shells.delete(id);
    return hit;
  }

  killRoom(roomId) {
    let n = 0;
    for (const [id, entry] of this.shells) {
      if (entry.roomId !== roomId) continue;
      // 兜一层 catch：回收是异步的，谁都不想因为一个进程收不掉而炸掉调用方
      Promise.resolve(this.#terminateEntry(entry)).catch(() => {});
      this.shells.delete(id);
      n++;
    }
    return n;
  }

  /**
   * 等某个后台进程真的退出（含它的整棵进程树）。
   *
   * `kill()` 是同步返回的：它只保证"已经在收"，不保证"已经收干净"。
   * 测试和收工流程需要后者。
   *
   * @param {string} id
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok:boolean, running:boolean, timedOut:boolean}>}
   */
  async waitExit(id, timeoutMs = KILL_TREE_TIMEOUT_MS) {
    const entry = this.shells.get(id);
    if (!entry) return { ok: true, running: false, timedOut: false };
    const stop = entry.stopping ?? this.#terminateEntry(entry);
    const timedOut = await Promise.race([
      Promise.resolve(stop).then(() => false),
      new Promise((resolve) => {
        // ★ 这个定时器**不能 unref**：等待期间它往往是唯一压住事件循环的东西，
        //   unref 掉会让 Node 直接退出（测试里就是 "unsettled top-level await"）。
        setTimeout(() => resolve(true), Math.max(50, Number(timeoutMs) || KILL_TREE_TIMEOUT_MS));
      }),
    ]);
    return { ok: !entry.running, running: entry.running, timedOut };
  }

  /** 清理空闲过久的进程 */
  pruneIdle(limit = this.idleMs) {
    const at = now();
    let n = 0;
    for (const [id, entry] of this.shells) {
      if (!entry.running && at - (entry.endedAt ?? entry.lastOutputAt) > limit) {
        this.shells.delete(id);
        n++;
        continue;
      }
      if (entry.running && at - entry.lastOutputAt > limit) {
        // 异步回收：这里不等它退（剪枝是定时任务，不该被一个进程卡住），
        // 但必须兜住 rejection —— 否则一个收不掉的进程会变成 unhandled rejection。
        Promise.resolve(this.#terminateEntry(entry)).catch(() => {});
        this.shells.delete(id);
        n++;
        log(`后台进程空闲超时已结束：${entry.command.slice(0, 60)}`);
      }
    }
    return n;
  }

  /**
   * 收工：收掉所有后台进程树。
   *
   * 返回 Promise（以前是同步返回 undefined）：真实收尾要等 `taskkill /T`
   * 或进程组信号生效，不退也得退的时候由调用方（server-main）兜超时。
   * 先快照再清 map —— 否则新起的进程会被漏掉，正在收的又会从 map 里消失。
   */
  stopAll() {
    const entries = [...this.shells.values()];
    this.shells.clear();
    clearInterval(this.timer);
    if (!entries.length) return Promise.resolve({ ok: true, stopped: 0 });
    const all = Promise.allSettled(entries.map((entry) => this.#terminateEntry(entry)));
    // 同理：收尾等待的兜底定时器不 unref（有界 3 s，不能让它被"没事可做"吞掉）
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), STOP_ALL_TIMEOUT_MS);
    });
    return Promise.race([all, timeout]).then(() => ({ ok: true, stopped: entries.length }));
  }

  /**
   * 结束一个后台进程（含整棵进程树）。
   *
   * ★ 顺序必须是「先树、后根」：
   *
   *   Windows 上 `child.kill()` 只杀直接子进程，孙子进程（命令里起的
   *   node / python / 构建工具）会留在后台继续跑 —— 用户看到的是
   *   "进程结束了但风扇还在转"。而 `taskkill /T` 是**按父子关系枚举**的：
   *   如果先 `child.kill()` 把根干掉了，taskkill 再去找这个 PID 就找不到，
   *   孙进程直接变孤儿（实测 3/3 存活）。所以必须**等 taskkill 跑完**再
   *   `child.kill()` —— 但不能用 `spawnSync`（硬规矩 3：运行期不许同步阻塞）。
   *
   *   POSIX 同理：`/bin/sh -c` 之后真实命令是孙进程，只杀 sh 没用。
   *   我们让子进程当了进程组组长（spawn 时 `detached: true`），
   *   用 `process.kill(-pid, ...)` 整组发信号。
   *
   *   沙箱内跑的不走这条路：沙箱用 Job Object KILL_ON_JOB_CLOSE 收尾，
   *   外面再 taskkill 反而会打失败。
   *
   * 返回 Promise：`kill()` 仍然同步返回 `{ok, wasRunning}`，真正等收干净
   * 用 `waitExit(id, timeoutMs)`。
   */
  #terminateEntry(entry) {
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    if (!entry.running) return Promise.resolve();
    entry.stopping = (async () => {
      try {
        if (entry.needsSandbox || !entry.pid) {
          // 沙箱：Job Object 会随句柄关闭整树收掉；这里只收直接子进程
          try { entry.child.kill(); } catch { /* 已退出 */ }
          return;
        }
        if (process.platform === 'win32') {
          await this.#taskkillTree(entry);
          try { entry.child.kill(); } catch { /* 已退出 */ }
          return;
        }
        // POSIX：先整组 SIGTERM，给一点时间；不退再 SIGKILL 整组
        this.#signalGroup(entry, 'SIGTERM');
        const exited = await this.#waitChildExit(entry, GROUP_TERM_GRACE_MS);
        if (!exited) {
          this.#signalGroup(entry, 'SIGKILL');
          await this.#waitChildExit(entry, 1_000);
        }
      } finally {
        entry.stopping = null;
      }
    })().catch(() => {});
    return entry.stopping;
  }

  /** Windows：起 `taskkill /T /F` 并等它自己退出（最多 5 s）。 */
  #taskkillTree(entry) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // 不 unref：taskkill 期间没有别的活，unref 掉会让收尾静默半途而废
      const timer = setTimeout(done, KILL_TREE_TIMEOUT_MS);
      try {
        const killer = spawn('taskkill', ['/PID', String(entry.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('exit', done);
        killer.once('error', done);
      } catch {
        // taskkill 不可用（极简环境）：退回 child.kill()
        done();
      }
    });
  }

  /** POSIX：给整组发信号；组已经不在了（ESRCH）就当它已经退干净。 */
  #signalGroup(entry, signal) {
    try {
      process.kill(-entry.pid, signal);
      return true;
    } catch (err) {
      if (err?.code === 'ESRCH') return false;
      // 拿不到进程组（比如被外部改过），退回直接杀子进程
      try { entry.child.kill(signal); } catch { /* 已退出 */ }
      return false;
    }
  }

  /** 等子进程 `exit`；超时返回 false。 */
  #waitChildExit(entry, timeoutMs) {
    if (!entry?.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.child?.off?.('exit', onExit);
        resolve(ok);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(50, Number(timeoutMs) || 1_000));
      entry.child?.once?.('exit', onExit);
      if (!entry.running) done(true);
    });
  }

  #notify(entry) {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #waitForChange(entry, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      entry.waiters.push(finish);
      setTimeout(finish, Math.max(50, timeoutMs));
    });
  }
}

/** 全局一份：工具层与服务端共用 */
export const shells = new ShellRegistry();
