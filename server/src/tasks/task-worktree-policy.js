/**
 * Worktree 隔离的纯策略：要不要开、开在哪、分支叫什么、什么时候才算「互不干扰」。
 *
 * ## 要解决的问题
 *
 * 多个成员（或 C3 的多个分身）并行写同一个 Git 仓库时，共享工作目录会互相踩：
 * 彼此未提交的改动混在一起，`git status` 里分不清谁改了哪一行，
 * 冲突要等最后一刻才炸。C3 只能靠 `fileClaims` 把编码活硬排成串行。
 *
 * C4 让**需要隔离的编码子任务**在独立 Git Worktree + 独立分支里跑，
 * 验收（含 C2 Critic）通过后再在仓库写锁下合回主仓。
 *
 * ## 六条硬约束（一条都不许破）
 *
 * 1. **落点必须在 workspace 内**：`<workspace>/.orbis-worktrees/<safeId>`。
 *    绝不落 `config.dataDir`（沙箱把 dataDir 当保护目录、repoTrustVerdict
 *    也要求目标在 `workspace` 之内）。
 * 2. **绝不改用户的 `.gitignore`**：靠 `<commonDir>/info/exclude`（Git 本地私有忽略）。
 * 3. **分支名白名单规范化**：`orbis/task/<safeId>`，`safeId` 只允许 `[A-Za-z0-9._-]`，
 *    防参数注入与路径穿越（`../`、空格、引号一律清掉）。
 * 4. **只有子任务**能开 worktree：负责人/主控永远在主工作区协调。
 * 5. **默认 `explicit`**：不显式要求就不建，普通调研任务零惊吓。
 * 6. **双 worktree 才放宽文件互斥**：只有两个子任务**都**隔离在各自 worktree
 *    里时，同文件才算不冲突（磁盘真的分开了）；否则 `fileClaims` 照旧。
 *
 * ## 边界
 *
 * 纯函数、零 IO：不建目录、不跑 git、不读盘。
 * 真正的 Git 操作在 `task-worktree.js`。
 */
import { readBrandEnv } from '../brand.js';

/** 三档。 */
export const WORKTREE_MODE = Object.freeze({ off: 'off', explicit: 'explicit', auto: 'auto' });

/** 默认：只在显式要求时建（不替用户决定要不要隔离）。 */
export const DEFAULT_WORKTREE_MODE = WORKTREE_MODE.explicit;

export const WORKTREE_MODES = Object.values(WORKTREE_MODE);

/** 固定落点目录名（在 workspace 根下）。 */
export const WORKTREE_DIR_NAME = '.orbis-worktrees';

/** 分支前缀。 */
export const WORKTREE_BRANCH_PREFIX = 'orbis/task/';

/** 从环境读档位：`ORBIS_TASK_WORKTREE`。 */
export function resolveWorktreeMode(env = process.env) {
  const raw = String(readBrandEnv(env, 'TASK_WORKTREE') ?? '').trim().toLowerCase();
  return WORKTREE_MODES.includes(raw) ? raw : DEFAULT_WORKTREE_MODE;
}

/**
 * 任务 id → 安全的目录/分支片段。
 *
 * 只留 `[A-Za-z0-9._-]`，且把 `..` 折叠掉：
 * `tr_x/../../evil` 之类不能变成路径穿越，也不能变成 git 参数注入
 * （`-c`、`--upload-pack=...` 这种必须以 `-` 开头才生效，而 `-` 已被排除）。
 */
export function sanitizeWorktreeId(taskRunId) {
  const text = String(taskRunId ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  if (!text) return 'task';
  return text.slice(0, 80);
}

/** 这个任务的分支名（`orbis/task/<safeId>`）。 */
export function worktreeBranchOf(taskRunId) {
  return WORKTREE_BRANCH_PREFIX + sanitizeWorktreeId(taskRunId);
}

/** 这个任务的 worktree 相对路径（相对 workspace）。 */
export function worktreeRelPathOf(taskRunId) {
  return `${WORKTREE_DIR_NAME}/${sanitizeWorktreeId(taskRunId)}`;
}

/**
 * 任务里声明的 worktree 意图。
 *
 * 允许两种写法（都不进业务身份指纹）：`flags.useWorktree` / `worktreeRepo`，
 * 顶部字段同名也认得（工具/工厂把它们写在顶层更好读）。
 */
export function worktreeIntentOf(taskRun) {
  const flags = taskRun?.flags ?? {};
  const useWorktree = taskRun?.useWorktree === true || flags.useWorktree === true;
  const repoRaw = taskRun?.worktreeRepo ?? flags.worktreeRepo ?? null;
  const repo = repoRaw === null || repoRaw === undefined ? null : String(repoRaw).trim() || null;
  return { useWorktree, worktreeRepo: repo };
}

/** 代码修改类活的特征词（`auto` 模式才用）。 */
const CODE_SIGNALS = [
  /代码|实现|重构|修复|修 bug|补丁|优化|加个接口|改功能|单元测试|测试用例|迁移脚本/i,
  /\b(code|implement|refactor|fix|patch|optimi[sz]e|feature|unit test|api|migrate)\b/i,
];

/**
 * 这个任务要不要开 worktree。
 *
 * 判定顺序：
 *   1. 模式 `off` → 永不；
 *   2. **根任务/负责人** → 永不（它们在主工作区协调整件事）；
 *   3. 显式 `useWorktree` 或指定了 `worktreeRepo` → 开（`explicit` / `auto` 都算）；
 *   4. `auto` 且声明了仓库内文件或目标明显是改代码 → 开；
 *   5. 其余 → 不开。
 *
 * @param {object} p
 * @param {object} p.taskRun
 * @param {string} [p.mode]
 * @returns {boolean}
 */
export function shouldUseWorktree({ taskRun, mode = DEFAULT_WORKTREE_MODE } = {}) {
  const resolved = WORKTREE_MODES.includes(mode) ? mode : DEFAULT_WORKTREE_MODE;
  if (resolved === WORKTREE_MODE.off) return false;
  if (!taskRun?.parentTaskId) return false;
  const intent = worktreeIntentOf(taskRun);
  if (intent.useWorktree || intent.worktreeRepo) return true;
  if (resolved !== WORKTREE_MODE.auto) return false;
  // auto：声明了文件（说明要动仓库里的东西）或目标看起来就是改代码
  if (Array.isArray(taskRun?.fileClaims) && taskRun.fileClaims.length) return true;
  const text = [
    String(taskRun?.goal?.requirement ?? ''),
    String(taskRun?.goal?.scope ?? ''),
    ...(taskRun?.goal?.deliverables ?? []).map((d) => String(d ?? '')),
  ].join('\n');
  if (!text.trim()) return false;
  return CODE_SIGNALS.some((pattern) => pattern.test(text));
}

/**
 * 给成员提示词的那句话。
 *
 * 必须写清「直接在当前工作目录改、不要切分支、不要 push」——
 * 否则模型很可能自己 `git checkout -b` / `git push`，把隔离层绕过去。
 *
 * @param {object|null} worktree `taskRun.worktree`
 * @returns {string} 没有 worktree 时返回空串
 */
export function worktreePromptNote(worktree) {
  const dir = String(worktree?.worktreePath ?? '').trim();
  if (!dir) return '';
  const branch = String(worktree?.branch ?? '').trim();
  return [
    `你正在独立的 Git worktree 里开发：目录 ${dir}${branch ? `，分支 ${branch}` : ''}。`,
    '直接修改当前工作目录里的文件即可；不要切换分支、不要 push、不要动主仓库目录。',
    '你在这里的改动会在验收（含独立复核）通过后由系统合回主仓库；验收没过就在这个目录里继续改。',
  ].join('\n');
}

/**
 * 这两个子任务之间还需要文件互斥吗？
 *
 * ★ 只有**双方都隔离在各自 worktree** 时才不需要：磁盘真的分开了，
 *   各改各的文件，冲突留到合并阶段由 repo 锁 + git 确定性处理。
 *   任何一方没隔离都必须照旧互斥（否则就是同一份工作树被你改我改）。
 *
 * @param {object} kidA
 * @param {object} kidB
 * @returns {boolean} true = 可以放宽（不阻塞）
 */
export function worktreesBypassFileClaims(kidA, kidB) {
  const isolated = (kid) => kid?.worktree?.status === 'active'
    || kid?.flags?.useWorktree === true
    || kid?.useWorktree === true;
  return isolated(kidA) && isolated(kidB);
}
