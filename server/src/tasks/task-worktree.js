/**
 * Worktree 生命周期执行层：准备 / 合入 / 清理 / 扫尾。
 *
 * ## 所有 Git 调用都复用 git-ops 的同一套安全口径
 *
 * `locateGit()` + `resolveRepoLayout()` + `repoTrustVerdict()` + 安全参数
 * （`-c core.pager=cat` / `-c core.quotepath=false` / `-c advice.detachedHead=false`），
 * `spawnSync` 直接给 argv，**绝不用 shell: true**，**绝不加 `--no-verify`**
 * （用户的 hook 该跑就跑；hook 失败就如实报错，不偷改结果）。
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
 * 1. **fail-closed 于脏主仓**：主仓有未提交改动时**绝不 merge**，保留分支并回报；
 * 2. **fail-closed 于冲突**：冲突立即 `merge --abort`，保证主工作树 100% 干净；
 * 3. **绝不 `-D`**：合入成功的分支只用安全 `-d` 删；作废清理才用 `-D`（且只在
 *    `status === 'active'` 时，保护已验收成果）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { locateGit, resolveRepoLayout } from '../git-ops.js';
import { repoTrustVerdict, insideRoot } from '../repo-trust.js';
import { acquireRepoWrite, releaseRepoWrite } from '../repo-lock.js';
import {
  WORKTREE_DIR_NAME, worktreeBranchOf, worktreeRelPathOf,
} from './task-worktree-policy.js';

/** 安全配置：把会「改行为」的仓库级配置压住（与 git-ops 保持一致）。 */
const CONFIG_GUARDS = ['-c', 'core.pager=cat', '-c', 'core.quotepath=false', '-c', 'advice.detachedHead=false'];

const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  LANG: 'C',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  workspace, clock = () => Date.now(), log = () => {}, lockWaitMs = 15_000, lockRetryMs = 250,
} = {}) {
  const root = realish(workspace);
  const gitFile = locateGit();
  if (!gitFile.ok) {
    // 没有 git 也不该让整件事挂掉：管理器静默降级成「不可用」
    log('Worktree 不可用：', gitFile.error);
  }

  /** 直接跑一次 git（安全参数 + 无 shell）。 */
  function git(cwd, args, { timeoutMs = 60_000 } = {}) {
    if (!gitFile.ok) return { ok: false, code: -1, stdout: '', stderr: '', error: gitFile.error };
    const res = spawnSync(gitFile.file, [...CONFIG_GUARDS, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: GIT_ENV,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (res.error) {
      return { ok: false, code: -1, stdout: '', stderr: '', error: `git 启动失败：${String(res.error.message || res.error)}` };
    }
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');
    return {
      ok: res.status === 0,
      code: res.status,
      stdout,
      stderr,
      error: res.status === 0 ? undefined : `git ${args.slice(0, 3).join(' ')} 退出码 ${res.status}：${stderr.slice(0, 400)}`,
    };
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
    const repoPick = resolveRepoDir(worktreeRepo ?? taskRun.worktree?.repoDirRel ?? taskRun.worktreeRepo);
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

    const head = git(layout.root, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) {
      return {
        ok: false, code: 'empty_repo',
        text: '这个仓库还没有任何提交（HEAD 不存在），建不了 worktree。先在主仓做一次提交，再重试。',
      };
    }
    const baseHead = String(head.stdout ?? '').trim();
    const excluded = ensureExclude(layout.commonDir);
    if (!excluded.ok) return { ok: false, code: 'exclude_failed', text: excluded.text };

    const branch = worktreeBranchOf(taskRun.id);
    const locked = await withLock(layout.commonDir, taskRun.id, () => {
      // 幂等复用：目录 + 分支都在（返工轮 / 时间片续段）→ 直接接着用
      const branchExists = git(layout.root, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok;
      const dirExists = fs.existsSync(path.join(worktreePath, '.git'));
      if (dirExists && branchExists) return { ok: true, reused: true, branch, worktreePath, baseHead, layout };
      // 目录在但没挂接好：先 prune 再重建（成员改动可能还在，先备份意识：不 rm）
      if (dirExists && !branchExists) return { ok: true, reused: true, branch, worktreePath, baseHead, layout };
      if (!dirExists) {
        git(layout.root, ['worktree', 'prune']);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        const add = git(layout.root, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
        if (!add.ok) return { ok: false, code: 'worktree_add_failed', text: add.error ?? 'git worktree add 失败' };
        return { ok: true, reused: false, branch, worktreePath, baseHead, layout };
      }
      return { ok: true, reused: false, branch, worktreePath, baseHead, layout };
    });
    if (!locked.ok) return { ok: false, code: locked.code, text: locked.text };
    const out = locked.value;
    const worktree = {
      repoDir: layout.root,
      repoDirRel: path.relative(root, layout.root) || '.',
      commonDir: layout.commonDir,
      worktreePath: out.worktreePath,
      branch: out.branch,
      baseHead: out.baseHead ?? baseHead,
      status: 'active',
      createdAt: clock(),
    };
    if (taskRuns) {
      await taskRuns.mutate(taskRun.id, {
        mutate: (cur) => (cur ? { ...cur, worktree, updatedAt: clock() } : null),
      });
    }
    log('worktree 就绪', taskRun.id, out.reused ? '(复用)' : '(新建)', worktree.worktreePath);
    return { ok: true, reused: out.reused === true, worktree };
  }

  /** 主仓是否干净（只有连 `??` 都没有才算干净）。 */
  function isDirty(dir) {
    const res = git(dir, ['status', '--porcelain']);
    if (!res.ok) return { ok: false, text: res.error ?? 'git status 失败' };
    return { ok: true, dirty: String(res.stdout ?? '').trim().length > 0, text: String(res.stdout ?? '').trim() };
  }

  /** 有没有配提交身份（没配才临时兜底，已配就保留用户真实身份）。 */
  function hasIdentity(dir) {
    const name = git(dir, ['config', 'user.name']);
    const email = git(dir, ['config', 'user.email']);
    return name.ok && String(name.stdout).trim() && email.ok && String(email.stdout).trim();
  }

  /** 该分支相对 base 有几个「净提交」。 */
  function commitCount(dir, baseHead, branch) {
    const res = git(dir, ['rev-list', '--count', `${baseHead}..${branch}`]);
    if (!res.ok) return { ok: false, text: res.error ?? 'git rev-list 失败' };
    const n = Number(String(res.stdout ?? '0').trim());
    return { ok: true, count: Number.isFinite(n) ? n : 0 };
  }

  /** 变更文件清单（相对 base）。 */
  function changedFiles(dir, baseHead, branch) {
    const res = git(dir, ['diff', '--name-only', `${baseHead}..${branch}`]);
    if (!res.ok) return [];
    return String(res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 200);
  }

  /** 移除 worktree（`--force` 只在明确要丢改动时用）+ prune。 */
  function removeWorktree(layout, worktreePath, { force = false } = {}) {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
    const res = git(layout.root, args);
    git(layout.root, ['worktree', 'prune']);
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

    // 1) 先把 worktree 里的改动收口成提交
    const status = git(note.worktreePath, ['status', '--porcelain']);
    if (!status.ok) {
      return { ok: false, status: 'error', code: 'status_failed', text: status.error ?? '读 worktree 状态失败' };
    }
    // ★ commit 与 merge **都**需要提交身份（CI 上常常没配全局 user.name）：
    //   只在 commit 上兜底、merge 时不兜底，会得到「Committer identity unknown」
    //   → 被当成冲突 → 白白 abort 一次。所以两份共用一个 identity。
    const identity = hasIdentity(note.worktreePath)
      ? []
      : ['-c', 'user.name=Orbis', '-c', 'user.email=orbis@local'];
    if (String(status.stdout ?? '').trim()) {
      const add = git(note.worktreePath, ['add', '-A']);
      if (!add.ok) return { ok: false, status: 'error', code: 'add_failed', text: add.error ?? 'git add 失败' };
      const msg = `orbis(task): ${String(shortTitle || taskRun?.goal?.requirement || taskRun.id).slice(0, 120)}`;
      const commit = git(note.worktreePath, [...identity, 'commit', '-m', msg]);
      if (!commit.ok) {
        // hook 失败 / 身份缺失都如实报错，绝不 --no-verify 糊过去
        return { ok: false, status: 'error', code: 'commit_failed', text: commit.error ?? '提交 worktree 改动失败' };
      }
    }

    // 2) 有没有净提交：没有就是没改代码
    const counts = commitCount(layout.root, note.baseHead, note.branch);
    if (!counts.ok) return { ok: false, status: 'error', code: 'revlist_failed', text: counts.text };
    if (counts.count === 0) {
      const locked = await withLock(layout.commonDir, taskRun.id, () => {
        removeWorktree(layout, note.worktreePath, { force: true });
        git(layout.root, ['branch', '-d', note.branch]);
        return { ok: true };
      });
      await persist({ status: 'noop', cleanedAt: clock() });
      return {
        ok: true, status: 'noop', branch: note.branch, worktreePath: note.worktreePath,
        text: locked.ok ? '没有代码改动，已清理 worktree' : '没有代码改动',
      };
    }

    // 3) 主仓脏检查（fail-closed #1）：绝不 merge 覆盖用户未提交的代码
    const main = isDirty(layout.root);
    if (!main.ok) return { ok: false, status: 'error', code: 'status_failed', text: main.text };
    if (main.dirty) {
      await persist({ status: 'preserved_dirty_main', preservedAt: clock(), branch: note.branch });
      return {
        ok: false, status: 'preserved_dirty_main', code: 'dirty_main',
        branch: note.branch, worktreePath: note.worktreePath,
        text: `主仓库有未提交改动，不敢合并（会覆盖你正在写的东西）。改动已完整保留在分支 ${note.branch}。`,
      };
    }

    // 4) 干净合入
    const locked = await withLock(layout.commonDir, taskRun.id, () => {
      const before = String(git(layout.root, ['rev-parse', 'HEAD']).stdout ?? '').trim();
      const merge = git(layout.root, [...identity, 'merge', '--no-ff', '--no-edit', note.branch]);
      if (!merge.ok) {
        // ★ 冲突清单必须在 abort **之前**取：`merge --abort` 会清掉未合并索引，
        //   之后再问 `--diff-filter=U` 只会得到空列表（等于把冲突原因丢了）。
        const conflicts = String(git(layout.root, ['diff', '--name-only', '--diff-filter=U']).stdout ?? '')
          .split('\n').map((s) => s.trim()).filter(Boolean);
        // fail-closed #2：冲突立刻回滚，主工作树必须恢复 100% 干净
        git(layout.root, ['merge', '--abort']);
        return { conflict: true, text: merge.error ?? 'git merge 失败', conflictFiles: conflicts };
      }
      const after = String(git(layout.root, ['rev-parse', 'HEAD']).stdout ?? '').trim();
      if (!after || after === before) {
        return { conflict: false, advanced: false, text: '合并后 HEAD 没有前进，拒绝当作成功' };
      }
      // 合入成功：清 worktree + 安全删分支（只用 -d）
      removeWorktree(layout, note.worktreePath, { force: false });
      git(layout.root, ['branch', '-d', note.branch]);
      return { conflict: false, advanced: true, mergedHead: after };
    });
    if (!locked.ok) {
      await persist({ status: 'merge_retry', lastError: locked.text });
      return { ok: false, status: 'merge_retry', code: locked.code, text: locked.text, branch: note.branch };
    }
    const out = locked.value;
    if (out.conflict) {
      await persist({
        status: 'conflict', conflictFiles: out.conflictFiles ?? [], conflictAt: clock(), branch: note.branch,
      });
      return {
        ok: false, status: 'conflict', code: 'merge_conflict',
        branch: note.branch, worktreePath: note.worktreePath,
        conflictFiles: out.conflictFiles ?? [],
        text: String(out.text ?? '').slice(0, 400),
      };
    }
    if (!out.advanced) {
      await persist({ status: 'merge_failed', lastError: out.text });
      return { ok: false, status: 'merge_failed', code: 'head_not_advanced', text: out.text, branch: note.branch };
    }
    const files = changedFiles(layout.root, note.baseHead, out.mergedHead);
    await persist({ status: 'merged', mergedHead: out.mergedHead, mergedAt: clock(), filesChanged: files });
    log('worktree 已合入', taskRun.id, note.branch, out.mergedHead.slice(0, 8), files.length + ' files');
    return {
      ok: true, status: 'merged', branch: note.branch, worktreePath: note.worktreePath,
      mergedHead: out.mergedHead, files,
      text: `已合入主仓：${out.mergedHead.slice(0, 8)}（${files.length} 个文件）`,
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
    const locked = await withLock(layout.commonDir, taskRun.id, () => {
      removeWorktree(layout, note.worktreePath, { force: true });
      // 作废的未交付分支：允许 -D（它没有验收成果，留着只会越积越多）
      git(layout.root, ['branch', '-D', note.branch]);
      return { ok: true };
    });
    if (taskRuns) {
      await taskRuns.mutate(taskRun.id, {
        mutate: (cur) => (cur ? {
          ...cur,
          worktree: { ...(cur.worktree ?? {}), status: 'cleaned', cleanedAt: clock(), cleanupReason: String(reason).slice(0, 200) },
          updatedAt: clock(),
        } : null),
      });
    }
    log('worktree 已清理', taskRun.id, note.branch, reason);
    return { ok: locked.ok, status: 'cleaned', branch: note.branch, text: locked.ok ? '已清理' : locked.text };
  }

  /**
   * 扫掉异常残留：只清「任务已终态且 worktree 还挂 active」的目录。
   *
   * 绝不误删活跃任务或冲突保留的 worktree。
   */
  async function pruneOrphanWorktrees({ taskRuns } = {}) {
    const report = { pruned: [], kept: [], errors: [] };
    if (!taskRuns) return report;
    const scan = taskRuns.listAll?.();
    const all = scan?.taskRuns ?? scan ?? [];
    for (const run of all) {
      const note = run?.worktree;
      if (!note?.worktreePath) continue;
      const terminal = run.state === 'completed' || run.state === 'cancelled';
      if (!terminal || note.status !== 'active') {
        if (note.status === 'active') report.kept.push(run.id);
        continue;
      }
      try {
        const out = await cleanupWorktree({ taskRun: run, taskRuns, reason: '孤儿扫描' });
        if (out.ok) report.pruned.push(run.id);
        else report.errors.push({ taskRunId: run.id, text: out.text ?? '' });
      } catch (err) {
        report.errors.push({ taskRunId: run.id, text: String(err?.message ?? err) });
      }
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
