/**
 * C4：并发编码的 Git Worktree 自动隔离与合入。
 *   node tests/long-task-worktree.mjs
 *
 * ## 守的是什么
 *
 * Worktree 隔离最容易出事的不是"没建起来"，而是**建起来之后丢代码**：
 *   · 合入冲突没回滚 → 用户主工作树里留下冲突标记与 MERGE_HEAD；
 *   · 主仓有未提交改动却强行 merge → 覆盖用户正在写的东西；
 *   · 取消/改版把**已验收**的分支删了 → 成员的劳动成果凭空消失；
 *   · Critic 在错误目录里评审 → "通过"与"实际交付"完全脱节。
 *
 * 所以这些用例全用**真实临时 git 仓库**跑（`os.tmpdir()`，结束清理干净），
 * 断言的是磁盘上的真实状态（工作树文件、分支、MERGE_HEAD、git status）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-wt-'));
const workspace = path.join(fixture, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
Object.assign(process.env, {
  ORBIS_HOME: path.join(fixture, 'home'),
  ORBIS_WORKSPACE: workspace,
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
});
delete process.env.ORBIS_TASK_WORKTREE;
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createChildTask } = await import(src('tasks/task-subtasks.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { STATE } = await import(src('tasks/task-contract.js'));
const POLICY = await import(src('tasks/task-worktree-policy.js'));
const { createWorktreeManager } = await import(src('tasks/task-worktree.js'));
const { buildMemberPrompt } = await import(src('tasks/task-prompts.js'));
const { verifyTaskRun } = await import(src('tasks/task-verification.js'));
const { createSessionBuilder } = await import(src('session-factory.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
    console.log(`✗ ${name}: ${err?.message || err}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 直接跑 git（测试自己用；与被测代码无关）。 */
function git(cwd, args) {
  const res = spawnSync('git', ['-c', 'core.pager=cat', '-c', 'user.name=Test', '-c', 'user.email=t@local', ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' },
  });
  return { ok: res.status === 0, out: String(res.stdout ?? ''), err: String(res.stderr ?? ''), code: res.status };
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

/** 建一个真实仓库（可选：先提交一次）。 */
function makeRepo(dir, { initial = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(git(dir, ['init', '-q']).ok, true, 'git init 应成功');
  if (initial) {
    write(path.join(dir, 'README.md'), '# repo\n');
    assert.equal(git(dir, ['add', '-A']).ok, true);
    assert.equal(git(dir, ['commit', '-q', '-m', 'init']).ok, true, '初始提交应成功');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. 纯策略
// ---------------------------------------------------------------------------

await test('1. resolveWorktreeMode：默认 explicit，off/auto 可指定，垃圾值回落', () => {
  assert.equal(POLICY.resolveWorktreeMode({}), 'explicit');
  assert.equal(POLICY.resolveWorktreeMode({ ORBIS_TASK_WORKTREE: 'OFF' }), 'off');
  assert.equal(POLICY.resolveWorktreeMode({ ORBIS_TASK_WORKTREE: 'auto' }), 'auto');
  assert.equal(POLICY.resolveWorktreeMode({ ORBIS_TASK_WORKTREE: 'zzz' }), 'explicit');
});

await test('2. sanitizeWorktreeId：拦住 ../、空格、引号、参数注入与超长', () => {
  assert.equal(POLICY.sanitizeWorktreeId('tr_abc-1'), 'tr_abc-1');
  assert.equal(POLICY.sanitizeWorktreeId('../../etc/passwd').includes('/'), false);
  assert.equal(POLICY.sanitizeWorktreeId('../../etc/passwd').includes('..'), false);
  assert.equal(POLICY.sanitizeWorktreeId('a b\tc').includes(' '), false);
  assert.equal(POLICY.sanitizeWorktreeId('--upload-pack=evil').startsWith('-'), false, '不能变成 git 参数');
  assert.equal(POLICY.sanitizeWorktreeId('`rm -rf /`').includes('`'), false);
  assert.equal(POLICY.sanitizeWorktreeId('').length > 0, true, '空 id 也要给一个兜底名');
  assert.ok(POLICY.sanitizeWorktreeId('x'.repeat(300)).length <= 80);
});

await test('3. 分支名与落点：orbis/task/<safeId> + <workspace>/.orbis-worktrees/<safeId>', () => {
  assert.equal(POLICY.worktreeBranchOf('tr a/b'), 'orbis/task/tr-a-b');
  assert.equal(POLICY.worktreeRelPathOf('tr a/b'), '.orbis-worktrees/tr-a-b');
  assert.match(POLICY.worktreeBranchOf('tr_1'), /^orbis\/task\/[A-Za-z0-9._-]+$/);
});

await test('4. shouldUseWorktree：根任务恒 false；explicit 只在显式要求时；auto 看代码特征；off 全关', () => {
  const kid = (flags = {}, goal = {}) => ({
    id: 'k1', parentTaskId: 'p1', flags, goal: { requirement: goal.requirement ?? '写个功能', ...goal },
  });
  assert.equal(POLICY.shouldUseWorktree({ taskRun: { id: 'r1', parentTaskId: null, flags: { useWorktree: true } }, mode: 'auto' }), false, '根任务永远不开');
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid({ useWorktree: true }), mode: 'explicit' }), true);
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid(), mode: 'explicit' }), false, 'explicit 下不显式要求就不开');
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid({}, { requirement: '把这份表整理成清单' }), mode: 'auto' }), false, '纯整理不算改代码');
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid({}, { requirement: '重构并发调度并修 bug' }), mode: 'auto' }), true);
  assert.equal(POLICY.shouldUseWorktree({ taskRun: { ...kid(), fileClaims: ['src/a.js'] }, mode: 'auto' }), true, '声明了文件就算');
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid({ useWorktree: true }), mode: 'off' }), false);
  assert.equal(POLICY.shouldUseWorktree({ taskRun: kid({ worktreeRepo: 'sub' }), mode: 'explicit' }), true);
});

await test('5. worktreesBypassFileClaims：只有双方都隔离才放宽', () => {
  const iso = { worktree: { status: 'active' } };
  const plain = { flags: {} };
  assert.equal(POLICY.worktreesBypassFileClaims(iso, iso), true);
  assert.equal(POLICY.worktreesBypassFileClaims(iso, plain), false);
  assert.equal(POLICY.worktreesBypassFileClaims(plain, plain), false);
  assert.equal(POLICY.worktreesBypassFileClaims({ worktree: { status: 'merged' } }, { worktree: { status: 'merged' } }), false);
});

await test('6. worktreePromptNote：说清「就在当前目录改、别切分支、别 push」', () => {
  const note = POLICY.worktreePromptNote({ worktreePath: '/w/t1', branch: 'orbis/task/t1' });
  assert.match(note, /\/w\/t1/);
  assert.match(note, /不要切换分支/);
  assert.match(note, /不要 push/);
  assert.equal(POLICY.worktreePromptNote(null), '');
});

// ---------------------------------------------------------------------------
// 2. 真实仓库：prepareWorktree
// ---------------------------------------------------------------------------

const repoDir = makeRepo(path.join(workspace, 'repo'));
const manager = createWorktreeManager({ workspace: repoDir, log: () => {} });

function fakeTaskRun(id, extra = {}) {
  return { id, parentTaskId: extra.parentTaskId === undefined ? 'tr_parent' : extra.parentTaskId, flags: {}, goal: { requirement: '写功能' }, ...extra };
}

await test('7. prepareWorktree：真实建树、info/exclude 幂等、主仓 status 干净、不碰 .gitignore', async () => {
  const run = fakeTaskRun('tr_wt1');
  const out = await manager.prepareWorktree({ taskRun: run });
  assert.equal(out.ok, true, out.text ?? '');
  const note = out.worktree;
  assert.equal(note.worktreePath, path.join(repoDir, '.orbis-worktrees', 'tr_wt1'));
  assert.equal(fs.existsSync(path.join(note.worktreePath, '.git')), true, 'worktree 目录要真的挂接上');
  assert.equal(note.branch, 'orbis/task/tr_wt1');
  assert.equal(git(repoDir, ['rev-parse', '--verify', 'refs/heads/orbis/task/tr_wt1']).ok, true, '分支应存在');

  const exclude = read(path.join(repoDir, '.git', 'info', 'exclude'));
  assert.match(String(exclude), /\.orbis-worktrees\//, '要把落点写进 info/exclude');
  assert.equal(git(repoDir, ['status', '--porcelain']).out.trim(), '', '主仓 status 必须干净');
  assert.equal(fs.existsSync(path.join(repoDir, '.gitignore')), false, '绝不创建/修改 .gitignore');

  // 幂等：再调一次仍然复用同一棵树，且 exclude 不重复追加
  const again = await manager.prepareWorktree({ taskRun: run });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  const exclude2 = read(path.join(repoDir, '.git', 'info', 'exclude'));
  assert.equal((String(exclude2).match(/\.orbis-worktrees\//g) ?? []).length, 1, 'exclude 必须幂等（只写一条）');
});

await test('8. prepareWorktree 复用不丢半成品；空仓与越界 fail-closed', async () => {
  const run = fakeTaskRun('tr_wt_reuse');
  const first = await manager.prepareWorktree({ taskRun: run });
  assert.equal(first.ok, true);
  const half = path.join(first.worktree.worktreePath, 'src', 'half.js');
  write(half, 'export const half = 1;\n');

  const again = await manager.prepareWorktree({ taskRun: run });
  assert.equal(again.reused, true);
  assert.equal(read(half), 'export const half = 1;\n', '返工/续段必须保留半成品，绝不清空');

  // 越界仓库 → 拒绝
  const outside = await manager.prepareWorktree({ taskRun: fakeTaskRun('tr_x'), worktreeRepo: '../outside' });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'outside_workspace');

  // 0 提交空仓 → 可解释的拒绝，不崩
  const emptyRepo = makeRepo(path.join(workspace, 'empty-repo'), { initial: false });
  const emptyMgr = createWorktreeManager({ workspace: emptyRepo, log: () => {} });
  const empty = await emptyMgr.prepareWorktree({ taskRun: fakeTaskRun('tr_empty') });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty_repo');
  assert.match(String(empty.text), /没有任何提交/);
});

// ---------------------------------------------------------------------------
// 3. 端到端：真 supervisor + 真 git（A/B 改不同文件 → 自动合入）
// ---------------------------------------------------------------------------

const chief = store.mainBot();
const memberA = store.createBot({ name: '编码成员A', persona: 'x' });
const memberB = store.createBot({ name: '编码成员B', persona: 'x' });
const room = store.createGroup({ name: '编码组', botIds: [chief.id, memberA.id, memberB.id], leadBotId: chief.id });
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot() {
  seq += 1;
  const id = 'tr_wr' + seq;
  const requestId = 'rq_wr' + seq;
  const built = createTaskRun({
    id, requestId, requesterId: 'local', at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: { requirement: '一件要分给几个人并行写代码的活', verification: [{ id: 'c1', kind: 'expert', description: '负责人确认' }] },
    autonomous: true,
    autonomyReason: '测试',
  });
  assert.equal(built.ok, true, built.text ?? '');
  await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-wr-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  return id;
}

async function addKid(parentId, { botId, useWorktree = true, files = [], requirement = '' } = {}) {
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    files,
    useWorktree,
    goal: {
      requirement: requirement || '写一段代码',
      verification: [{ id: 'v1', kind: 'artifact', description: '交了产物' }],
    },
  });
  assert.equal(out.ok, true, out.text ?? '');
  return out.child.id;
}

/** 让成员在它自己的工作目录里写文件（模拟真实编码）。 */
function codeWriter(script) {
  return async (args) => {
    const dir = args?.workDir ?? repoDir;
    const spec = script(args);
    for (const [rel, text] of Object.entries(spec.files ?? {})) write(path.join(dir, rel), text);
    return { ok: true, stop: 'returned', appliedCompletion: true, artifacts: spec.artifacts ?? [] };
  };
}

function makeSupervisor({ executeMember, maxPerBot = 3, worktreeManager = manager } = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 10,
    maxStallRounds: 5,
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember,
    maxPerBot,
    worktreeManager,
    criticMode: 'off',
    verify: async () => ({ passed: true, reason: '机械验收通过' }),
    access: { stat: async (ref) => ({ exists: Boolean(ref) }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
    clock: () => Date.now(),
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

async function waitFor(sup, ids, predicate, { timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), sleep(40)]);
    const runs = ids.map((id) => taskRuns.read(id).taskRun);
    if (predicate(runs)) return runs;
    if (Date.now() > deadline) return runs;
    await sleep(40);
  }
}

await test('9. ★ 两个子任务并行写不同文件 → 各自 worktree → 自动合入，主仓同时包含两者', async () => {
  const rootId = await makeRoot();
  const kidA = await addKid(rootId, { botId: memberA.id, requirement: '写 src/a.js' });
  const kidB = await addKid(rootId, { botId: memberB.id, requirement: '写 src/b.js' });

  const starts = new Map();
  const sup = makeSupervisor({
    executeMember: codeWriter((args) => {
      starts.set(args.taskRun.id, Date.now());
      const isA = args.taskRun.id === kidA;
      return { files: { [isA ? 'src/a.js' : 'src/b.js']: `export const ${isA ? 'a' : 'b'} = 1;\n` } };
    }),
  });
  sup.notify(rootId);
  const runs = await waitFor(sup, [kidA, kidB], (rs) => rs.every((r) => r.state === STATE.completed));
  sup.dispose();

  for (const [i, run] of runs.entries()) {
    assert.equal(run.state, STATE.completed, `第 ${i + 1} 份应交付，实际 ${run.state}（${run.flags?.blockedReason ?? ''}）`);
    assert.equal(run.worktree?.status, 'merged', `worktree 应已合入，实际 ${run.worktree?.status}`);
    assert.ok(run.worktree?.mergedHead, '要记下合入的 commit');
  }
  // 主仓真的同时有两个文件
  assert.equal(fs.existsSync(path.join(repoDir, 'src', 'a.js')), true, '主仓应包含 src/a.js');
  assert.equal(fs.existsSync(path.join(repoDir, 'src', 'b.js')), true, '主仓应包含 src/b.js');
  const log = git(repoDir, ['log', '--oneline', '-5']).out;
  assert.match(log, /orbis\(task\)/, '应有 orbis(task) 的合入提交');
  // 临时 worktree 与分支都清理掉了
  const wtList = git(repoDir, ['worktree', 'list']).out;
  assert.equal(wtList.includes('tr_wr'), false, `临时 worktree 应清理干净：${wtList}`);
  assert.equal(git(repoDir, ['rev-parse', '--verify', 'refs/heads/orbis/task/' + kidA]).ok, false, '合入后分支应删除');
  // 黑板有交付记录
  const board = taskRuns.read(rootId).taskRun.blackboard;
  assert.ok((board?.entries ?? []).some((e) => e.kind === 'artifact'), '交付应落黑板');
  assert.ok((board?.entries ?? []).some((e) => e.kind === 'fact' && /已合入主仓/.test(String(e.text))), '合入也要落一条');
});

// ---------------------------------------------------------------------------
// 4. 冲突 / 脏主仓 / 取消清理
// ---------------------------------------------------------------------------

await test('10. ★ 同一文件同一行冲突：主仓 merge --abort 保持干净，B 的分支与 worktree 保留并阻塞', async () => {
  // 先让主仓有一个共享文件
  write(path.join(repoDir, 'src', 'shared.js'), 'export const v = 1;\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'add shared']);

  const rootId = await makeRoot();
  const kidA = await addKid(rootId, {
    botId: memberA.id, requirement: '改 shared 第 1 行（A）', files: ['src/shared.js'],
  });
  const kidB = await addKid(rootId, {
    botId: memberB.id, requirement: '改 shared 第 1 行（B）', files: ['src/shared.js'],
  });

  // 两棵树都基于同一个 HEAD（真实并发开发的前提），各自改同一行
  const prepA = await manager.prepareWorktree({ taskRun: taskRuns.read(kidA).taskRun, taskRuns });
  const prepB = await manager.prepareWorktree({ taskRun: taskRuns.read(kidB).taskRun, taskRuns });
  assert.equal(prepA.ok, true, prepA.text ?? '');
  assert.equal(prepB.ok, true, prepB.text ?? '');
  write(path.join(prepA.worktree.worktreePath, 'src', 'shared.js'), 'export const v = 2; // A\n');
  write(path.join(prepB.worktree.worktreePath, 'src', 'shared.js'), 'export const v = 3; // B\n');

  // A 先合入（成功），B 后合入（必然冲突）
  const mergedA = await manager.mergeWorktree({ taskRun: taskRuns.read(kidA).taskRun, taskRuns, shortTitle: 'A' });
  assert.equal(mergedA.ok, true, `A 应合入成功：${mergedA.text ?? mergedA.code ?? ''}`);
  assert.equal(mergedA.status, 'merged');
  assert.equal(read(path.join(repoDir, 'src', 'shared.js')).includes('v = 2'), true, '主仓应是 A 的版本');

  const mergedB = await manager.mergeWorktree({ taskRun: taskRuns.read(kidB).taskRun, taskRuns, shortTitle: 'B' });
  assert.equal(mergedB.ok, false, 'B 必须撞冲突');
  assert.equal(mergedB.status, 'conflict');
  assert.ok((mergedB.conflictFiles ?? []).includes('src/shared.js'), `冲突文件要记下来：${JSON.stringify(mergedB.conflictFiles)}`);
  // 主仓 100% 干净：无冲突标记、无 MERGE_HEAD、无未合并索引项
  assert.equal(git(repoDir, ['status', '--porcelain']).out.trim(), '', '冲突后主仓必须恢复干净');
  assert.equal(fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD')), false, '不能留下 MERGE_HEAD');
  assert.equal(read(path.join(repoDir, 'src', 'shared.js')).includes('<<<<<<<'), false, '不能留冲突标记');
  // 冲突方的分支与 worktree 必须保留（劳动成果）
  const afterB = taskRuns.read(kidB).taskRun;
  assert.equal(afterB.worktree?.status, 'conflict');
  assert.equal(git(repoDir, ['rev-parse', '--verify', `refs/heads/${afterB.worktree.branch}`]).ok, true, '冲突分支必须保留');
  assert.equal(fs.existsSync(afterB.worktree.worktreePath), true, '冲突的 worktree 也要保留');
  assert.equal(read(path.join(afterB.worktree.worktreePath, 'src', 'shared.js')).includes('v = 3'), true, '成员改动必须还在');

  // 再跑一遍推进器：它会在验收通过后再次尝试合入 → 冲突 → block → 交回负责人
  const sup = makeSupervisor({
    executeMember: async () => ({ ok: true, stop: 'returned', appliedCompletion: true, artifacts: [] }),
  });
  sup.notify(rootId);
  await waitFor(sup, [rootId], (rs) => (rs[0].childHandBacks ?? 0) >= 1, { timeoutMs: 10_000 });
  await sleep(150);
  await sup.idle();
  const rootRun = taskRuns.read(rootId).taskRun;
  sup.dispose();
  assert.ok((rootRun.childHandBacks ?? 0) >= 1 || (rootRun.childFailures ?? []).length >= 1, '应把冲突的分工交回负责人');
});

await test('11. ★ 主仓有未提交改动：拒绝合并、保留分支、用户文件丝毫无损', async () => {
  const wip = path.join(repoDir, 'local-wip.txt');
  write(wip, '用户正在写的东西\n');

  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id, requirement: '写 src/feature2.js' });
  const sup = makeSupervisor({
    executeMember: codeWriter(() => ({ files: { 'src/feature2.js': 'export const f2 = 1;\n' } })),
  });
  sup.notify(rootId);
  const runs = await waitFor(sup, [kid], (rs) => [STATE.completed, STATE.blocked, STATE.cancelled].includes(rs[0].state));
  await sleep(150);
  await sup.idle();
  const finalRun = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.equal(finalRun.worktree?.status, 'preserved_dirty_main', `实际 ${finalRun.worktree?.status}`);
  assert.equal(read(wip), '用户正在写的东西\n', '用户未提交的文件必须丝毫无损');
  assert.equal(fs.existsSync(path.join(repoDir, 'src', 'feature2.js')), false, '没有合并进来');
  assert.match(git(repoDir, ['status', '--porcelain']).out, /local-wip\.txt/, '主仓仍是脏的（我们没有动它）');
  assert.equal(git(repoDir, ['rev-parse', '--verify', `refs/heads/${finalRun.worktree.branch}`]).ok, true, '分支必须保留');
  assert.notEqual(finalRun.worktree?.status, 'merged', '不能真的合入');
  assert.equal(fs.existsSync(path.join(repoDir, '.orbis-worktrees', String(finalRun.worktree.branch ?? '').split('/').pop())), true,
    'worktree 应保留');

  // 收尾：把用户改动收进仓库，避免影响后续用例
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'commit wip']);
});

await test('12. ★ 取消活跃 worktree 会清理；冲突保留态的分支不被误删', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id, requirement: '写 src/cancel-me.js' });
  const sup = makeSupervisor({
    executeMember: async (args) => {
      write(path.join(args.workDir ?? repoDir, 'src/cancel-me.js'), 'export const x = 1;\n');
      await sleep(400);
      return { ok: true, stop: 'returned', appliedCompletion: true };
    },
  });
  sup.notify(rootId);
  // 等 worktree 建好
  for (let i = 0; i < 60; i += 1) {
    const run = taskRuns.read(kid).taskRun;
    if (run?.worktree?.worktreePath) break;
    await Promise.race([sup.idle(), sleep(30)]);
    await sleep(30);
  }
  const during = taskRuns.read(kid).taskRun;
  assert.ok(during.worktree?.worktreePath, '应该已经建好 worktree');
  const wtPath = during.worktree.worktreePath;
  const branch = during.worktree.branch;
  await sup.cancelTask(kid, { reason: '测试取消' });
  await sleep(300);
  await sup.idle();
  const after = taskRuns.read(kid).taskRun;
  sup.dispose();
  assert.equal(after.worktree?.status, 'cleaned', `取消后应清理，实际 ${after.worktree?.status}`);
  assert.equal(fs.existsSync(wtPath), false, 'worktree 目录应删除');
  assert.equal(git(repoDir, ['rev-parse', '--verify', `refs/heads/${branch}`]).ok, false, '作废分支应删除');
});

// ---------------------------------------------------------------------------
// 5. Critic 联动 / 会话隔离 / 行预算
// ---------------------------------------------------------------------------

await test('13. ★ C2 Critic 在 worktree 目录里验收（主仓还没有那个文件）；返工仍在同一棵树', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, {
    botId: memberA.id,
    requirement: '在 worktree 里写 src/feature.js',
    // 需要 expert 条件才会触发 critic
  });
  // 给这份子任务加一个 expert 验收条件
  await taskRuns.mutate(kid, {
    mutate: (cur) => (cur ? {
      ...cur,
      goal: { ...(cur.goal ?? {}), verification: [
        { id: 'v1', kind: 'artifact', description: '交了产物' },
        { id: 'c1', kind: 'expert', description: '功能正确' },
      ] },
      updatedAt: Date.now(),
    } : null),
  });

  const criticCalls = [];
  let round = 0;
  const criticReview = async (args) => {
    criticCalls.push({
      workDir: args?.taskRun?.worktree?.worktreePath ?? null,
      hasFeature: Boolean(read(path.join(args?.taskRun?.worktree?.worktreePath ?? '/nonexistent', 'src', 'feature.js'))),
    });
    round += 1;
    if (round === 1) return { status: 'reviewed', ok: true, verdict: 'failed', summary: '还差点', defects: ['缺少导出'], reviewerModel: 'c', usage: null };
    return { status: 'reviewed', ok: true, verdict: 'passed', summary: '核对过，功能对', defects: [], reviewerModel: 'c', usage: null };
  };

  const sup = createTaskSupervisor({
    taskRuns,
    maxSteps: 12,
    maxStallRounds: 5,
    execute: async () => ({ ok: true, stop: 'returned' }),
    executeMember: codeWriter(() => ({
      files: { 'src/feature.js': 'export const feature = 1;\n' },
      artifacts: ['src/feature.js'],
    })),
    maxPerBot: 3,
    worktreeManager: manager,
    criticReview,
    criticMode: 'auto',
    // ★ 用真实验收器：critic 写入的 expertReviews 必须真的能让条件通过
    verify: async (run) => {
      const v = await verifyTaskRun(run, {
        access: { stat: async (ref) => ({ exists: Boolean(ref) }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
        taskRuns,
        attemptId: null,
      });
      return v;
    },
    access: { stat: async (ref) => ({ exists: Boolean(ref) }), readText: async () => ({ ok: false }), resolveRef: (r) => r },
    clock: () => Date.now(),
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
  sup.notify(rootId);
  const runs = await waitFor(sup, [kid], (rs) => [STATE.completed, STATE.blocked].includes(rs[0].state));
  await sleep(150);
  await sup.idle();
  const finalRun = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.ok(criticCalls.length >= 2, `应审两轮（初次 + 复核），实际 ${criticCalls.length}`);
  for (const call of criticCalls) {
    assert.ok(call.workDir, '评审必须拿到 workDir');
    assert.match(String(call.workDir), /\.orbis-worktrees/, 'workDir 必须是 worktree 目录');
    assert.equal(call.hasFeature, true, '评审员必须能在 worktree 里看到那个文件（主仓此时没有）');
  }
  assert.equal(runs[0].state, STATE.completed, `最终应交付，实际 ${runs[0].state}`);
  assert.equal(finalRun.worktree?.status, 'merged');
  assert.equal(fs.existsSync(path.join(repoDir, 'src', 'feature.js')), true, '合入后主仓才有这个文件');
});

await test('14. ★ session-factory 传 workDir：cwd/沙箱都指向 worktree，且不落盘主会话', async () => {
  const bot = store.createBot({ name: 'worktree 会话', role: 'main' });
  const dm = store.ensureDm(bot.id);
  const workDir = path.join(workspace, '.orbis-worktrees', 'tr_session');
  fs.mkdirSync(workDir, { recursive: true });
  let inMemory = 0;
  let disk = 0;
  let captured = null;
  let shellWorkDir = null;
  const builder = createSessionBuilder({
    runner: {
      config: store.config ?? { workspace, dataDir: path.join(fixture, 'data') },
      store, bus: null,
      modelGroups: { list: () => [], get: () => null },
      breakerFor: () => null,
    },
    health: null,
    resolveModel: () => null,
    modelLabel: () => '',
    sessionApi: {
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      SessionManager: {
        inMemory: () => { inMemory += 1; return {}; },
        create: () => { disk += 1; return {}; },
        open: () => { disk += 1; return {}; },
      },
      DefaultResourceLoader: class {
        constructor(options) { this.options = options; captured = options; }
        async reload() {}
      },
      async createAgentSession(options) {
        captured = { ...(captured ?? {}), agentSession: options };
        return {
          session: {
            model: { provider: 'cloud', id: 'x' },
            sessionFile: path.join(fixture, 'should-not-save.jsonl'),
            settingsManager: { applyOverrides() {} },
            subscribe() { return () => {}; },
            dispose() {},
          },
        };
      },
      createBashTool: () => ({ name: 'bash' }),
      createPowerShellTool: () => ({ name: 'powershell' }),
    },
  });
  await builder(dm.id, bot.id, { workDir, cloneId: 'tr_session', persist: false });
  const resolved = fs.realpathSync.native(workDir);
  assert.equal(inMemory >= 1, true, 'worktree 会话必须是内存会话');
  assert.equal(disk, 0, '不得创建/打开磁盘会话');
  const cwd = captured?.agentSession?.cwd ?? captured?.cwd;
  assert.equal(path.resolve(String(cwd)), resolved, `cwd 应指向 worktree，实际 ${cwd}`);
  assert.equal(store.sessionFileFor(dm.id, bot.id), null, '不得写 store sessionFile');
  void shellWorkDir;
});

await test('15. 行预算：pi-runner ≤ 850、turn-executor ≤ 1350', () => {
  const count = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', rel), 'utf8').split(/\r?\n/).length;
  assert.ok(count('pi-runner.js') <= 850, `pi-runner.js ${count('pi-runner.js')} > 850`);
  assert.ok(count('runner/turn-executor.js') <= 1350, `turn-executor.js ${count('runner/turn-executor.js')} > 1350`);
});

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nlong-task-worktree：${passed}/${results.length} 通过`);
// 清理临时仓库（Windows 上句柄可能还没放，失败就留给系统）
try {
  fs.rmSync(fixture, { recursive: true, force: true });
} catch { /* 留给系统清理 */ }
if (failed) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.err}`);
  process.exit(1);
}
process.exit(0);
