/**
 * Worktree 生命周期执行层：准备 / 合入 / 清理 / 扫尾。
 *
 * ## 所有 Git 调用都复用 git-ops 的同一套安全口径
 *
 * `locateGit()` + `resolveRepoLayout()` + `repoTrustVerdict()` + 安全参数
 * （`-c core.pager=cat` / `-c core.quotepath=false` / `-c advice.detachedHead=false`），
 * `spawn` 直接给 argv，**绝不用 shell: true**，**绝不加 `--no-verify`**
 * （用户的 hook 该跑就跑；hook 失败就如实报错，不偷改结果）。
 *
 * ★ git 一律**异步**跑：merge / commit 会触发用户的 hook（lint、测试，动辄几十秒），
 *   以前用 `spawnSync`，这期间整个服务端事件循环停摆 —— WebSocket 心跳、HTTP、
 *   别的任务全卡住。异步之后同一仓库的收口由 `serialized` 排队，语义与原来一致。
 *
 * ## 为什么不用 `runGit()`
 *
 * `runGit` 是**给模型工具用的**受控入口：`merge` 之类的破坏性操作在那一层
 * 需要用户确认票据、而且是同步拒绝（拿不到锁就报错）。这里的合入是系统内部
 * 行为（验收通过后的收口），语义不同 —— 所以只复用底层 helper 与安全参数，
 * 写锁自己用 `withRepoWriteLock` 包（允许短暂重排等待）。
 *
 * ## 三个不可退让的安全点
 *
 * 1. **fail-closed 于「主仓此刻不能安全合入」**：已跟踪文件有未提交改动、未跟踪文件会被
 *    这次合入覆盖、分离头指针（bisect / rebase 停住时）、有进行中的 merge/rebase/
 *    cherry-pick、当前分支不包含这份活的起点 —— 任一成立都**绝不 merge**，保留分支并回报
 *    （`preserved_dirty_main` + 具体原因，推进器按可恢复阻塞稍后自动重试）；
 * 2. **fail-closed 于冲突**：冲突立即 `merge --abort`，保证主工作树 100% 干净；
 * 3. **绝不 `-D`**：合入成功的分支只用安全 `-d` 删；作废清理才用 `-D`（且只在
 *    `status === 'active'` 时，保护已验收成果）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { locateGit, resolveRepoLayout } from '../git-ops.js';
import { repoTrustVerdict, insideRoot } from '../repo-trust.js';
import { acquireRepoWrite, releaseRepoWrite } from '../repo-lock.js';
import {
  WORKTREE_DIR_NAME, worktreeBranchOf, worktreeRelPathOf,
} from './task-worktree-policy.js';

/** 安全配置：把会「改行为」的仓库级配置压住（与 git-ops 保持一致）。 */
const CONFIG_GUARDS = ['-c', 'core.pager=cat', '-c', 'core.quotepath=false', '-c', 'advice.detachedHead=false'];

/**
 * 主仓里「有 git 操作做到一半」的标记文件（`git rev-parse --git-path` 解析真实位置）。
 *
 * 这些状态下主仓 HEAD/索引都不是用户的最终意图：往里 merge 要么被 git 拒绝，
 * 要么把任务的提交混进一次还没收尾的 rebase / cherry-pick 里。
 */
const IN_PROGRESS_MARKERS = Object.freeze([
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply',
]);

/**
 * `-z` 输出 → 路径列表（不受引号/换行/非 ASCII 文件名影响）。
 *
 * ★ 不能 trim：文件名本身可能带首尾空格，而 porcelain 的 `XY` 状态位里空格是有意义的。
 */
function splitZ(text) {
  return String(text ?? '').split('\0').filter(Boolean);
}

/**
 * `git status --porcelain -z` → 路径列表。
 *
 * 每段是 `XY<空格>路径`；重命名/复制（X 或 Y 是 R/C）后面还跟着一段原路径，要跳过。
 */
function porcelainPaths(text) {
  const parts = String(text ?? '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    out.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  return out;
}

/** 调用时从当前 process.env 现拼（运行期或单测修改 GIT_* 能即时生效）。 */
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  LANG: 'C',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单次 git 输出上限（stdout + stderr）：超了就当失败，绝不无限攒内存。 */
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

/**
 * 同一仓库的收口串行队列（进程内，所有管理器共用）。
 *
 * ★ git 改成异步之后，「拿锁 → 一串 git → 放锁」之间事件循环会转起来。
 *   repo-lock 对**同一个 taskId 可重入** —— 同一个任务的取消清理（`cleanupWorktree`）
 *   可能恰好插进它自己正在进行的合入，两边同时动同一棵树。原来同步实现天然不会交错，
 *   这里按仓库（commonDir）排一次队，把这条不变量补回来。
 */
const repoQueues = new Map();
const queueKey = (commonDir) => String(commonDir ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

async function serialized(commonDir, fn) {
  const key = queueKey(commonDir);
  const prev = repoQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  repoQueues.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
  }
}

/** 真路径（目录不存在时退回 resolve）。 */
function realish(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(String(p ?? ''));
  }
}

/**
 * 造一个 worktree 管理器。
 *
 * @param {object} p
 * @param {string} p.workspace 信任域根（worktree 只能落在这里面）
 * @param {()=>number} [p.clock]
 * @param {Function} [p.log]
 * @param {number} [p.lockWaitMs] 拿不到仓库写锁时最多等多久（重排等待）
 * @param {number} [p.lockRetryMs] 重排间隔
 */
export function createWorktreeManager({
  workspace,
  clock = () => Date.now(),
  log = () => {},
  lockWaitMs = 15_000,
  lockRetryMs = 250,
  gitTimeoutMs = 60_000,
  killGraceMs = 3_000,
} = {}) {
  const root = realish(workspace);
  const gitFile = locateGit();
  if (!gitFile.ok) {
    // 没有 git 也不该让整件事挂掉：管理器静默降级成「不可用」
    log('Worktree 不可用：', gitFile.error);
  }

  /**
   * 跑一次 git（安全参数 + 无 shell），**异步**。
   *
   * 返回形状与原来同步版一致：`{ok, code, stdout, stderr, error?}`。
   * 起不来 / 超时 / 输出超限都是 `ok:false, code:-1`（与 spawnSync 超时同口径）。
   *
   * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, error?:string}>}
   */
  function git(cwd, args, { timeoutMs = gitTimeoutMs } = {}) {
    if (!gitFile.ok) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '', error: gitFile.error });
    const label = `git ${args.slice(0, 3).join(' ')}`;
    const limitMs = Math.max(1, Number(timeoutMs) || 60_000);
    const graceMs = Math.max(1, Number(killGraceMs) || 3_000);
    return new Promise((resolve) => {
      let timer = null;
      let killTimer = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };
      let child;
      try {
        child = spawn(gitFile.file, [...CONFIG_GUARDS, ...args], {
          cwd,
          windowsHide: true,
          env: gitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({ ok: false, code: -1, stdout: '', stderr: '', error: `git 启动失败：${String(err?.message || err)}` });
        return;
      }
      const out = [];
      const errs = [];
      let size = 0;
      let overflow = false;
      let timedOut = false;
      let terminationReason = '';
      const terminate = (reason) => {
        if (settled) return;
        if (!terminationReason) terminationReason = reason;
        try { child.kill('SIGTERM'); } catch { /* 进程可能已退 */ }
        if (killTimer) return;
        // 孙进程继承 stdio 管道或忽略 SIGTERM 时，'close' 可能迟迟不来；
        // 宽限期后强杀并强制 resolve，避免仓库 serialized 队列永久锁死。
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          try { child.stdout?.destroy(); } catch { /* ignore */ }
          try { child.stderr?.destroy(); } catch { /* ignore */ }
          finish({
            ok: false,
            code: -1,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(errs).toString('utf8'),
            error: terminationReason || reason,
          });
        }, graceMs);
        killTimer.unref?.();
      };
      const collect = (bucket) => (chunk) => {
        size += chunk.length;
        if (size > MAX_GIT_OUTPUT) {
          if (!overflow) {
            overflow = true;
            terminate(`${label} 输出超过 ${MAX_GIT_OUTPUT / 1024 / 1024} MB，已终止`);
          }
          return;
        }
        bucket.push(chunk);
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(errs));
      timer = setTimeout(() => {
        timedOut = true;
        terminate(`${label} 超时（${Math.round(limitMs / 1000)} 秒没结束，已终止）`);
      }, limitMs);
      timer.unref?.();
      child.on('error', (err) => finish({
        ok: false, code: -1, stdout: '', stderr: '', error: `git 启动失败：${String(err?.message || err)}`,
      }));
      child.on('close', (code) => {
        // 按整段解码：多字节字符可能被切在两个 chunk 之间
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(errs).toString('utf8');
        if (timedOut || overflow) {
          finish({
            ok: false, code: -1, stdout, stderr,
            error: terminationReason || (timedOut
              ? `${label} 超时（${Math.round(limitMs / 1000)} 秒没结束，已终止）`
              : `${label} 输出超过 ${MAX_GIT_OUTPUT / 1024 / 1024} MB，已终止`),
          });
          return;
        }
        finish({
          ok: code === 0,
          code,
          stdout,
          stderr,
          error: code === 0 ? undefined : `${label} 退出码 ${code}：${stderr.slice(0, 400)}`,
        });
      });
    });
  }

  /** 解析仓库（含信任域校验）。 */
  function inspectRepo(dir) {
    const layout = resolveRepoLayout(dir);
    if (!layout.ok) return { ok: false, code: 'no_repo', text: `${dir} 不是 Git 仓库：${layout.error}` };
    const trust = repoTrustVerdict({ layout, roots: [root] });
    if (!trust.ok) return { ok: false, code: 'outside_trust', text: trust.text };
    return { ok: true, layout };
  }

  /**
   * 在仓库写锁内跑一段同步逻辑，拿不到锁时**短暂重排等待**。
   *
   * 为什么不直接失败：合入阶段往往正好撞上「另一个任务在收口」，
   * 那只是排队几十毫秒的事，判死却会让一个已经做完的任务白丢。
   */
  async function withLock(commonDir, taskId, fn) {
    return serialized(commonDir, () => withRepoLock(commonDir, taskId, fn));
  }

  /** 拿 repo-lock（与模型 git 工具协调）：拿不到时短暂重排等待。 */
  async function withRepoLock(commonDir, taskId, fn) {
    const deadline = clock() + Math.max(0, Number(lockWaitMs) || 0);
    let last = null;
    for (;;) {
      const got = acquireRepoWrite({ commonDir, taskId });
      if (got.ok) {
        try {
          return { ok: true, value: await fn() };
        } finally {
          releaseRepoWrite({ commonDir, taskId });
        }
      }
      last = got;
      if (clock() >= deadline) break;
      await sleep(Math.min(lockRetryMs, Math.max(1, deadline - clock())));
    }
    return {
      ok: false, code: last?.code ?? 'repo_busy',
      text: last?.text ?? '仓库正在被另一个任务写入，等不到锁',
      holder: last?.holder ?? null,
    };
  }

  /** 幂等把 `.orbis-worktrees/` 写进 `<commonDir>/info/exclude`（绝不碰 .gitignore）。 */
  function ensureExclude(commonDir) {
    const line = `${WORKTREE_DIR_NAME}/`;
    const infoDir = path.join(commonDir, 'info');
    const file = path.join(infoDir, 'exclude');
    try {
      fs.mkdirSync(infoDir, { recursive: true });
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const has = current.split(/\r?\n/).some((l) => l.trim() === line);
      if (has) return { ok: true, already: true };
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(file, `${prefix}${line}\n`);
      return { ok: true, already: false };
    } catch (err) {
      return { ok: false, text: `写 info/exclude 失败：${String(err?.message ?? err)}` };
    }
  }

  /** 目标仓库目录（相对 workspace，缺省 workspace 本身；越界一律拒）。 */
  function resolveRepoDir(worktreeRepo) {
    const rel = String(worktreeRepo ?? '').trim();
    if (!rel) return { ok: true, dir: root };
    const abs = path.resolve(root, rel);
    const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs !== root && !abs.startsWith(normalizedRoot)) {
      return { ok: false, code: 'outside_workspace', text: `worktreeRepo「${rel}」跑到 workspace 外面了，拒绝` };
    }
    return { ok: true, dir: abs };
  }

  /**
   * 准备 worktree（幂等：返工/续段都复用同一棵树，绝不清空半成品）。
   *
   * @param {object} p
   * @param {object} p.taskRun
   * @param {object} [p.taskRuns] 需要落盘时传
   * @returns {Promise<{ok:boolean, code?:string, text?:string, worktree?:object}>}
   */
  async function prepareWorktree({ taskRun, taskRuns = null, worktreeRepo = null } = {}) {
    if (!gitFile.ok) return { ok: false, code: 'no_git', text: gitFile.error };
    if (!taskRun?.id) return { ok: false, code: 'bad_task', text: '缺少任务 id' };
    if (!taskRun.parentTaskId) return { ok: false, code: 'root_task', text: '根任务/负责人不开 worktree（在主工作区协调）' };
    // ★ 目标仓库优先级：显式参数 → 已落盘的 worktree → **flags.worktreeRepo** → 顶层字段
    const repoPick = resolveRepoDir(
      worktreeRepo
      ?? taskRun.worktree?.repoDirRel
      ?? taskRun.flags?.worktreeRepo
      ?? taskRun.worktreeRepo,
    );
    if (!repoPick.ok) return repoPick;
    const inspected = inspectRepo(repoPick.dir);
    if (!inspected.ok) return inspected;
    const { layout } = inspected;
    // ★ 落点必须在 workspace 内（沙箱允许目录、repoTrustVerdict、git 工具
    //   的 resolveRepo 全都按这一条判）。路径由我们构造，这里显式再核一次。
    const worktreePath = path.join(root, worktreeRelPathOf(taskRun.id), '');
    if (!insideRoot(root, worktreePath)) {
      return {
        ok: false, code: 'outside_trust',
        text: `worktree 落点 ${worktreePath} 不在 workspace 内，拒绝（沙箱与信任域都要求它在里面）`,
      };
    }

    const head = await git(layout.root, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
      return {
        ok: false, code: 'empty_repo',
        text: '这个仓库还没有任何提交（HEAD 不存在），建不了 worktree。先在主仓做一次提交，再重试。',
      };
    }
    const headNow = String(head.stdout ?? '').trim();
    const sym = await git(layout.root, ['symbolic-ref', '-q', 'HEAD']);
    const symRef = String(sym.stdout ?? '').trim();
    const branchNow = sym.ok && symRef.startsWith('refs/heads/') ? symRef.slice('refs/heads/'.length) : null;
    const excluded = ensureExclude(layout.commonDir);
    if (!excluded.ok) return { ok: false, code: 'exclude_failed', text: excluded.text };

    const branch = worktreeBranchOf(taskRun.id);
    const prev = taskRun.worktree ?? null;
    const locked = await withLock(layout.commonDir, taskRun.id, async () => {
      const branchExists = (await git(layout.root, ['rev-parse', '--verify', `refs/heads/${branch}`])).ok;
      const dirExists = fs.existsSync(path.join(worktreePath, '.git'));
      // 1) 目录 + 分支都在：直接复用（返工轮 / 时间片续段），绝不清空半成品
      if (dirExists && branchExists) return { ok: true, reused: true };
      // 2) 目录在、分支没了（被人删了 / 上次只挂了一半）：在树里补回分支引用
      if (dirExists && !branchExists) {
        const checkout = await git(worktreePath, ['checkout', '-B', branch]);
        if (!checkout.ok) {
          return { ok: false, code: 'branch_restore_failed', text: checkout.error ?? `补回分支 ${branch} 失败` };
        }
        return { ok: true, reused: true, restoredBranch: true };
      }
      // 3) 分支在、目录没了（被 prune / 手工删掉）：挂回**已有分支**，不能再带 `-b`
      if (!dirExists && branchExists) {
        await git(layout.root, ['worktree', 'prune']);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        const attach = await git(layout.root, ['worktree', 'add', worktreePath, branch]);
        if (!attach.ok) {
          return { ok: false, code: 'worktree_attach_failed', text: attach.error ?? `挂回分支 ${branch} 失败` };
        }
        return { ok: true, reused: true, reattached: true };
      }
      // 4) 全新的活：从当前 HEAD 开新分支
      await git(layout.root, ['worktree', 'prune']);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      const add = await git(layout.root, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
      if (!add.ok) return { ok: false, code: 'worktree_add_failed', text: add.error ?? 'git worktree add 失败' };
      return { ok: true, reused: false };
    });
    if (!locked.ok) return { ok: false, code: locked.code, text: locked.text };
    const out = locked.value;
    // ★ 复用时保留**最初**的 baseHead / createdAt：主仓 HEAD 可能已经被兄弟任务
    //   推进过，用新 HEAD 覆盖会让「本次改动相对哪个基线」失真（甚至把别人的
    //   提交算成自己的改动）。
    const keepBase = out.reused === true && prev?.baseHead ? prev.baseHead : null;
    const keepBaseBranch = out.reused === true && prev?.baseBranch ? prev.baseBranch : null;
    const worktree = {
      ...(prev ?? {}),
      repoDir: layout.root,
      repoDirRel: path.relative(root, layout.root) || '.',
      commonDir: layout.commonDir,
      worktreePath,
      branch,
      baseHead: keepBase ?? prev?.baseHead ?? headNow,
      baseBranch: keepBaseBranch ?? prev?.baseBranch ?? branchNow,
      status: 'active',
      createdAt: prev?.createdAt ?? clock(),
      ...(out.restoredBranch ? { restoredBranchAt: clock() } : {}),
      ...(out.reattached ? { reattachedAt: clock() } : {}),
    };
    if (taskRuns) {
      await taskRuns.mutate(taskRun.id, {
        mutate: (cur) => (cur ? { ...cur, worktree, updatedAt: clock() } : null),
      });
    }
    log('worktree 就绪', taskRun.id, out.reused ? '(复用)' : '(新建)', worktree.worktreePath);
    return { ok: true, reused: out.reused === true, worktree };
  }

  /**
   * 主仓此刻能不能安全合入（只读检查；**必须在仓库写锁内调用**，与随后的 merge 同锁）。
   *
   * 逐条 fail-closed，任一不满足就不合入、保留分支，由推进器按可恢复阻塞稍后重试：
   *   1. 停在某个分支上 —— 分离头指针（bisect / rebase 停住时）合进去的提交不属于任何
   *      分支，任务分支随后又被 `-d` 删掉，改动就只剩 reflog 能找回（实测复现过）；
   *   2. 没有做到一半的 merge / rebase / cherry-pick / revert / bisect；
   *   3. **已跟踪**文件没有未提交改动 —— 带着本地改动 merge，一旦冲突，
   *      `merge --abort` 不保证能还原它们（git 文档原话），所以宁可等；
   *   4. 当前分支包含这份活的起点 `baseHead` —— 否则合入会把起点之后、当前分支
   *      没有的无关提交一起带进来（典型：用户切到了别的分支）；
   *   5. 未跟踪文件**只在会被这次合入覆盖时**才挡：其余未跟踪文件（用户草稿、
   *      `_inbox/` 附件副本、构建产物）合并根本碰不到。以前任何 `??` 都判脏，
   *      而不在 worktree 里干活的成员从不提交 —— 合入几乎永远进不去。
   *
   * @returns {{ok:true, branch:string}
   *   | {ok:false, code:string, text:string, files?:string[], hard?:boolean}}
   *   `hard: true` = git 自身出错（不是「等一等就好」的状态）。
   */
  async function mainMergeReadiness(layout, note) {
    const dir = layout.root;
    const head = await git(dir, ['symbolic-ref', '-q', 'HEAD']);
    const ref = String(head.stdout ?? '').trim();
    if (!head.ok || !ref.startsWith('refs/heads/')) {
      return {
        ok: false, code: 'detached_head',
        text: '主仓当前是分离头指针（detached HEAD，常见于 bisect / rebase 进行中），合进去的提交不属于任何分支',
      };
    }
    const branch = ref.slice('refs/heads/'.length);
    for (const marker of IN_PROGRESS_MARKERS) {
      const res = await git(dir, ['rev-parse', '--git-path', marker]);
      const rel = String(res.stdout ?? '').trim();
      if (res.ok && rel && fs.existsSync(path.resolve(dir, rel))) {
        return { ok: false, code: 'operation_in_progress', text: `主仓有做到一半的 git 操作（${marker}）` };
      }
    }
    const tracked = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=no']);
    if (!tracked.ok) return { ok: false, code: 'status_failed', text: tracked.error ?? 'git status 失败', hard: true };
    const dirty = porcelainPaths(tracked.stdout);
    if (dirty.length) {
      return {
        ok: false, code: 'dirty_main', text: `主仓有 ${dirty.length} 个已跟踪文件改了还没提交`, files: dirty.slice(0, 20),
      };
    }
    const contains = await git(dir, ['merge-base', '--is-ancestor', note.baseHead, 'HEAD']);
    if (!contains.ok) {
      if (contains.code === 1) {
        return {
          ok: false, code: 'base_not_in_head',
          text: `主仓当前分支 ${branch} 不包含这份活的起点 ${String(note.baseHead).slice(0, 8)}（合入会带进无关提交）`,
        };
      }
      return { ok: false, code: 'merge_base_failed', text: contains.error ?? 'git merge-base 失败', hard: true };
    }
    if (note.baseBranch && branch !== note.baseBranch) {
      return {
        ok: false, code: 'branch_changed',
        text: `主仓当前在分支 ${branch}，与建 worktree 时的分支 ${note.baseBranch} 不同（切回原分支后再合入）`,
      };
    }
    // 这次合入会**写出**的文件（分支上删掉的不算：删除碰不到主仓里的未跟踪文件）
    const incoming = await changedFiles(dir, note.baseHead, note.branch, { limit: Infinity, excludeDeleted: true });
    if (incoming.length) {
      const others = await git(dir, ['ls-files', '-z', '--others', '--exclude-standard']);
      if (!others.ok) {
        return { ok: false, code: 'status_failed', text: others.error ?? '列未跟踪文件失败', hard: true };
      }
      const untracked = new Set(splitZ(others.stdout));
      const collisions = incoming.filter((file) => untracked.has(file));
      if (collisions.length) {
        return {
          ok: false, code: 'untracked_collision',
          text: `主仓有 ${collisions.length} 个未跟踪文件会被这次合入覆盖`, files: collisions.slice(0, 20),
        };
      }
    }
    return { ok: true, branch };
  }

  /** 有没有配提交身份（没配才临时兜底，已配就保留用户真实身份）。 */
  async function hasIdentity(dir) {
    const name = await git(dir, ['config', 'user.name']);
    const email = await git(dir, ['config', 'user.email']);
    return name.ok && String(name.stdout).trim() && email.ok && String(email.stdout).trim();
  }

  /** 该分支相对 base 有几个「净提交」。 */
  async function commitCount(dir, baseHead, branch) {
    const res = await git(dir, ['rev-list', '--count', `${baseHead}..${branch}`]);
    if (!res.ok) return { ok: false, text: res.error ?? 'git rev-list 失败' };
    const n = Number(String(res.stdout ?? '0').trim());
    return { ok: true, count: Number.isFinite(n) ? n : 0 };
  }

  /** 两个提交之间变了哪些文件（`-z`：文件名里有空格/引号/中文也不会被转义坏）。 */
  async function changedFiles(dir, from, to, { limit = 200, excludeDeleted = false } = {}) {
    const res = await git(dir, ['diff', '--name-only', '-z', ...(excludeDeleted ? ['--diff-filter=d'] : []), from, to]);
    if (!res.ok) return [];
    const files = splitZ(res.stdout);
    return Number.isFinite(limit) ? files.slice(0, limit) : files;
  }

  /** 移除 worktree（`--force` 只在明确要丢改动时用）+ prune。 */
  async function removeWorktree(layout, worktreePath, { force = false } = {}) {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
    const res = await git(layout.root, args);
    await git(layout.root, ['worktree', 'prune']);
    return res;
  }

  /**
   * 合入主仓（只有在机械验收 + 独立复核全过之后才调）。
   *
   * @returns {Promise<{ok:boolean, status:string, code?:string, text?:string, mergedHead?:string,
   *   files?:string[], branch?:string, worktreePath?:string, conflictFiles?:string[]}>}
   */
  async function mergeWorktree({ taskRun, taskRuns = null, shortTitle = '' } = {}) {
    const note = taskRun?.worktree ?? null;
    if (!note?.worktreePath) return { ok: true, status: 'none', text: '没有 worktree，无需合入' };
    if (note.status === 'merged') return { ok: true, status: 'merged', text: '已经合入过' };
    if (!gitFile.ok) return { ok: false, status: note.status, code: 'no_git', text: gitFile.error };
    const inspected = inspectRepo(note.repoDir);
    if (!inspected.ok) return { ok: false, status: 'error', code: inspected.code, text: inspected.text };
    const { layout } = inspected;

    const persist = async (patch) => {
      if (!taskRuns) return;
      await taskRuns.mutate(taskRun.id, {
        mutate: (cur) => (cur ? { ...cur, worktree: { ...(cur.worktree ?? {}), ...patch }, updatedAt: clock() } : null),
      });
    };

    /**
     * ★ 整个收口流程（收编改动 → 判净提交 → 主仓脏检查 → merge → 清理）
     *   **必须在同一把仓库写锁里**，不能各段各拿一次锁：
     *   · 两个子任务同时收口时，后到者若在锁外做 `git status`，会把对方正在进行的
     *     合并看成「主仓脏」→ 误判成 `preserved_dirty_main`（假失败）；
     *   · 各段各拿锁还会并发写 commonDir（refs/index），那是"下次才炸"的损坏；
     *   · 锁内读到的 before/after HEAD 才是同一把锁下的真实前后状态（无 TOCTOU）。
     *   `persist` 落盘放在锁外：它不碰 git，锁外做还能缩短持锁时间。
     */
    const locked = await withLock(layout.commonDir, taskRun.id, async () => {
      // 1) 先把 worktree 里的改动收口成提交
      const status = await git(note.worktreePath, ['status', '--porcelain']);
      if (!status.ok) {
        return { ok: false, status: 'error', code: 'status_failed', text: status.error ?? '读 worktree 状态失败' };
      }
      // ★ commit 与 merge **都**需要提交身份（CI 上常常没配全局 user.name）：
      //   只在 commit 上兜底、merge 时不兜底，会得到「Committer identity unknown」
      //   → 被当成冲突 → 白白 abort 一次。所以两份共用一个 identity。
      const identity = (await hasIdentity(note.worktreePath))
        ? []
        : ['-c', 'user.name=Orbis', '-c', 'user.email=orbis@local'];
      if (String(status.stdout ?? '').trim()) {
        const add = await git(note.worktreePath, ['add', '-A']);
        if (!add.ok) return { ok: false, status: 'error', code: 'add_failed', text: add.error ?? 'git add 失败' };
        const msg = `orbis(task): ${String(shortTitle || taskRun?.goal?.requirement || taskRun.id).slice(0, 120)}`;
        const commit = await git(note.worktreePath, [...identity, 'commit', '-m', msg]);
        if (!commit.ok) {
          // hook 失败 / 身份缺失都如实报错，绝不 --no-verify 糊过去
          return { ok: false, status: 'error', code: 'commit_failed', text: commit.error ?? '提交 worktree 改动失败' };
        }
      }

      // 2) 有没有净提交：没有就是没改代码
      const counts = await commitCount(layout.root, note.baseHead, note.branch);
      if (!counts.ok) return { ok: false, status: 'error', code: 'revlist_failed', text: counts.text };
      if (counts.count === 0) {
        await removeWorktree(layout, note.worktreePath, { force: true });
        await git(layout.root, ['branch', '-d', note.branch]);
        return { ok: true, status: 'noop' };
      }

      // 3) 主仓此刻能不能安全合入（fail-closed #1）：不能就保留分支，推进器按可恢复阻塞稍后重试
      const ready = await mainMergeReadiness(layout, note);
      if (!ready.ok) {
        if (ready.hard) return { ok: false, status: 'error', code: ready.code, text: ready.text };
        return {
          ok: false, status: 'preserved_dirty_main', code: ready.code, text: ready.text, files: ready.files ?? [],
        };
      }

      // 4) 干净合入
      const before = String((await git(layout.root, ['rev-parse', 'HEAD'])).stdout ?? '').trim();
      const merge = await git(layout.root, [...identity, 'merge', '--no-ff', '--no-edit', note.branch]);
      if (!merge.ok) {
        // ★ 冲突清单必须在 abort **之前**取：`merge --abort` 会清掉未合并索引，
        //   之后再问 `--diff-filter=U` 只会得到空列表（等于把冲突原因丢了）。
        const conflicts = String((await git(layout.root, ['diff', '--name-only', '--diff-filter=U'])).stdout ?? '')
          .split('\n').map((line) => line.trim()).filter(Boolean);
        // fail-closed #2：冲突立刻回滚，主工作树必须恢复 100% 干净
        await git(layout.root, ['merge', '--abort']);
        return {
          ok: false, status: 'conflict', code: 'merge_conflict',
          conflictFiles: conflicts, text: merge.error ?? 'git merge 失败',
        };
      }
      const after = String((await git(layout.root, ['rev-parse', 'HEAD'])).stdout ?? '').trim();
      if (!after || after === before) {
        return { ok: false, status: 'merge_failed', code: 'head_not_advanced', text: '合并后 HEAD 没有前进，拒绝当作成功' };
      }
      // 合入成功：清 worktree + 安全删分支（只用 -d）
      await removeWorktree(layout, note.worktreePath, { force: false });
      await git(layout.root, ['branch', '-d', note.branch]);
      // ★ 只记**这次合入**带进主仓的文件（合入前后 HEAD 之差）。
      //   以前用 `baseHead..after`：起点之后兄弟任务先合进来的文件也被算成自己的改动，
      //   黑板上的「已合入主仓（N 个文件）」与面板的文件数都跟着错。
      const files = await changedFiles(layout.root, before, after);
      return { ok: true, status: 'merged', mergedHead: after, files };
    });

    // 锁外只做落盘与措辞
    if (!locked.ok) {
      await persist({ status: 'merge_retry', lastError: locked.text });
      return { ok: false, status: 'merge_retry', code: locked.code, text: locked.text, branch: note.branch };
    }
    const out = locked.value;
    if (out.status === 'noop') {
      await persist({ status: 'noop', cleanedAt: clock() });
      return {
        ok: true, status: 'noop', branch: note.branch, worktreePath: note.worktreePath,
        text: '没有代码改动，已清理 worktree',
      };
    }
    if (out.status === 'preserved_dirty_main') {
      const files = Array.isArray(out.files) ? out.files : [];
      const reason = String(out.text ?? '主仓暂时不能安全合入');
      await persist({
        status: 'preserved_dirty_main', preservedAt: clock(), branch: note.branch,
        waitCode: out.code ?? 'dirty_main', waitText: reason.slice(0, 200), waitFiles: files.slice(0, 20),
      });
      return {
        ok: false, status: 'preserved_dirty_main', code: out.code ?? 'dirty_main',
        branch: note.branch, worktreePath: note.worktreePath, files,
        text: `${reason}${files.length ? '（' + files.slice(0, 6).join('、') + '）' : ''}。改动已完整保留在分支 ${note.branch}。`,
      };
    }
    if (out.status === 'conflict') {
      await persist({
        status: 'conflict', conflictFiles: out.conflictFiles ?? [], conflictAt: clock(), branch: note.branch,
      });
      return {
        ok: false, status: 'conflict', code: out.code ?? 'merge_conflict',
        branch: note.branch, worktreePath: note.worktreePath,
        conflictFiles: out.conflictFiles ?? [],
        text: String(out.text ?? '').slice(0, 400),
      };
    }
    if (out.ok !== true) {
      await persist({ status: 'merge_failed', lastError: out.text ?? out.code ?? '' });
      return {
        ok: false, status: out.status ?? 'error', code: out.code ?? 'merge_failed',
        text: out.text ?? '合入失败', branch: note.branch,
      };
    }
    const files = out.files ?? [];
    await persist({
      status: 'merged', mergedHead: out.mergedHead, mergedAt: clock(), filesChanged: files,
      waitCode: null, waitText: null, waitFiles: null,
    });
    log('worktree 已合入', taskRun.id, note.branch, String(out.mergedHead).slice(0, 8), files.length + ' files');
    return {
      ok: true, status: 'merged', branch: note.branch, worktreePath: note.worktreePath,
      mergedHead: out.mergedHead, files,
      text: `已合入主仓：${String(out.mergedHead).slice(0, 8)}（${files.length} 个文件）`,
    };
  }

  /**
   * 作废一个 worktree（取消 / 改版）。
   *
   * ★ 只有 `status === 'active'` 才丢改动；`conflict` / `preserved_dirty_main`
   *   是「成果已验收但没合进去」，分支必须留着。
   */
  async function cleanupWorktree({ taskRun, taskRuns = null, reason = '' } = {}) {
    const note = taskRun?.worktree ?? null;
    if (!note?.worktreePath) return { ok: true, status: 'none' };
    if (note.status !== 'active') {
      return { ok: true, status: note.status, preserved: true, branch: note.branch, text: '已保留（不删分支）' };
    }
    const inspected = inspectRepo(note.repoDir);
    if (!inspected.ok) return { ok: false, status: note.status, code: inspected.code, text: inspected.text };
    const { layout } = inspected;
    const locked = await withLock(layout.commonDir, taskRun.id, async () => {
      await removeWorktree(layout, note.worktreePath, { force: true });
      // 作废的未交付分支：允许 -D（它没有验收成果，留着只会越积越多）
      await git(layout.root, ['branch', '-D', note.branch]);
      // ★ 以结果为准，不以「命令跑过了」为准：Windows 上目录里有文件被占用时
      //   `worktree remove --force` 会失败，分支因为还挂在那棵树上也删不掉。
      const dirLeft = fs.existsSync(note.worktreePath);
      const branchLeft = (await git(layout.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${note.branch}`])).ok;
      return { dirLeft, branchLeft };
    });
    const leftovers = locked.ok
      ? [locked.value?.dirLeft ? '目录还在（可能有文件被占用）' : '', locked.value?.branchLeft ? `分支 ${note.branch} 还在` : '']
        .filter(Boolean).join('，')
      : String(locked.text ?? '拿不到仓库写锁');
    const done = locked.ok && !leftovers;
    if (taskRuns) {
      await taskRuns.mutate(taskRun.id, {
        mutate: (cur) => {
          if (!cur) return null;
          // ★ 没清干净就**不**标 cleaned：以前不管成没成都写 cleaned，
          //   启动扫描从此不再碰它 —— 目录和分支永远留在磁盘上。
          //   保持 active + 记下原因，下次启动的残留扫描（pruneOrphanWorktrees）会再试。
          const worktree = done
            ? {
              ...(cur.worktree ?? {}), status: 'cleaned', cleanedAt: clock(),
              cleanupReason: String(reason).slice(0, 200), cleanupError: null,
            }
            : { ...(cur.worktree ?? {}), cleanupError: leftovers.slice(0, 200), cleanupTriedAt: clock() };
          return { ...cur, worktree, updatedAt: clock() };
        },
      });
    }
    if (done) log('worktree 已清理', taskRun.id, note.branch, reason);
    else log('worktree 没清干净（下次启动再试）', taskRun.id, note.branch, leftovers);
    return {
      ok: done, status: done ? 'cleaned' : 'active', branch: note.branch,
      text: done ? '已清理' : `没清干净：${leftovers}`,
    };
  }

  /**
   * 启动时扫一遍残留：任务**已取消**、worktree 却还挂着 active 的，作废清理。
   *
   * 残留从哪来：取消时进程正好崩了 / 当时目录被占用没删掉（`cleanupWorktree`
   * 会把它留在 active 并记下 cleanupError，等这里再试一次）。
   *
   * ★ 已完成（completed）但 worktree 还是 active 的**绝不碰**：那是验收通过却没走到合入的成果
   *   （例如中途关过 ORBIS_TASK_WORKTREE）。作废清理用的是 `branch -D`，会把成果直接删掉。
   *   只报出来（`unmerged`），留给人处理。
   * ★ 冲突 / 等主仓 / 合入失败这些非 active 状态的分支一律保留（同 cleanupWorktree）；
   *   未终态任务的 worktree 是活的，更不能碰。
   *
   * @returns {Promise<{pruned:string[], kept:string[], unmerged:string[], errors:Array<{taskRunId:string, text:string}>}>}
   */
  async function pruneOrphanWorktrees({ taskRuns } = {}) {
    const report = { pruned: [], kept: [], unmerged: [], errors: [] };
    if (!taskRuns || !gitFile.ok) return report;
    const scan = taskRuns.listAll?.();
    const all = scan?.taskRuns ?? scan ?? [];
    for (const run of all) {
      const note = run?.worktree;
      if (!note?.worktreePath || note.status !== 'active') continue;
      if (run.state === 'completed') {
        report.unmerged.push(run.id);
        continue;
      }
      if (run.state !== 'cancelled') {
        report.kept.push(run.id);
        continue;
      }
      try {
        const out = await cleanupWorktree({ taskRun: run, taskRuns, reason: '启动扫描：任务已取消' });
        if (out.ok) report.pruned.push(run.id);
        else report.errors.push({ taskRunId: run.id, text: out.text ?? '' });
      } catch (err) {
        report.errors.push({ taskRunId: run.id, text: String(err?.message ?? err) });
      }
    }
    if (report.unmerged.length) {
      log('这些已完成任务的 worktree 没合入主仓（已保留，不清理）：', report.unmerged.join(', '));
    }
    return report;
  }

  return {
    available: gitFile.ok,
    prepareWorktree,
    mergeWorktree,
    cleanupWorktree,
    pruneOrphanWorktrees,
    /** 诊断用：workspace 与 git 可执行文件。 */
    describe() {
      return { workspace: root, git: gitFile.ok ? gitFile.file : null, tmp: os.tmpdir() };
    },
  };
}
