/**
 * 独立评审 / 质检回路（Independent Critic Verification Loop）。
 *   node tests/long-task-critic.mjs
 *
 * ## 守的是什么
 *
 * 机械验收只能回答「文件在不在、格式对不对」；「结论对不对、口径一致不一致」
 * 以前只能靠负责人自己调 `task_expert_review`（私聊 solo 里等于执行者自评）。
 * 这条回路把独立 Critic 接进既有 `doVerify` + `expertReviews`，所以必须钉死
 * 六件一旦做错就会静默出事的行为：
 *
 *   1. **零浪费**：机械验收没过时一次都不调 Critic；
 *   2. **fail-closed**：评审输出含糊 / 自相矛盾 = 不放行（不自动 passed）；
 *   3. **版本绑定**：上一轮的 `failed` 记录不能挡住返工后的新一轮评审；
 *   4. **有界**：连续 2 轮不过就停，交回负责人，不无限烧钱；
 *   5. **基础设施工伤**：评审员超时/抛错不算业务缺陷、不扣返工额度、不伪造通过；
 *   6. **预算与竞态**：token 计入根预算、预算尽不偷跑、评审期间被取消/改版则丢弃结论。
 *
 * 加上会话隔离断言：`criticLane` 必须是纯内存 + 只读工具白名单
 * （没有写工具、没有 shell、没有 MCP），否则「独立」两个字就是空的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-critic-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
});
// 这个文件要自己控制档位（会临时改环境变量），先确保默认 auto
delete process.env.ORBIS_CRITIC_REVIEW;

globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { createChildTask } = await import(src('tasks/task-subtasks.js'));
const { createTaskSupervisor } = await import(src('tasks/task-supervisor.js'));
const { verifyTaskRun } = await import(src('tasks/task-verification.js'));
const { STATE } = await import(src('tasks/task-contract.js'));
const C = await import(src('tasks/task-critic.js'));
const { createSessionBuilder } = await import(src('session-factory.js'));
const { renderCriticFeedback } = await import(src('tasks/task-critic.js'));
const { criticFeedbackBlock } = await import(src('tasks/task-prompts.js'));

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

// ---------------------------------------------------------------------------
// 1. 纯逻辑
// ---------------------------------------------------------------------------

await test('1. resolveCriticMode：默认 auto，off/all 可指定，垃圾值回落 auto', () => {
  assert.equal(C.resolveCriticMode({}), 'auto');
  assert.equal(C.resolveCriticMode({ ORBIS_CRITIC_REVIEW: 'off' }), 'off');
  assert.equal(C.resolveCriticMode({ ORBIS_CRITIC_REVIEW: 'ALL' }), 'all');
  assert.equal(C.resolveCriticMode({ ORBIS_CRITIC_REVIEW: 'nonsense' }), 'auto');
  assert.equal(C.MAX_CRITIC_REWORKS, 2);
});

await test('2. shouldRunCritic：机械未过恒为 false；auto 只在需要时触发；已审过的不重复审', () => {
  const base = {
    id: 't1',
    revision: 1,
    attempts: [{ attemptId: 'a1', state: 'settled' }],
    progress: { evidence: [{ kind: 'artifact', ref: 'out/a.md', attemptId: 'a1' }] },
  };
  const mechanicalFail = { unmet: ['产物不存在'], needsReview: [], blocked: [] };
  assert.equal(C.shouldRunCritic({ taskRun: base, verification: mechanicalFail, mode: 'all' }), false,
    '机械没过时连 all 档也不该审（零浪费）');
  assert.equal(
    C.shouldRunCritic({ taskRun: base, verification: { unmet: [], blocked: [], needsReview: [] }, mode: 'auto' }),
    false,
    'auto 档没有未评审的 expert 条件也不该审',
  );
  assert.equal(C.shouldRunCritic({
    taskRun: base,
    verification: { unmet: [], blocked: [], needsReview: [{ id: 'c1', description: '口径一致' }] },
    mode: 'auto',
  }), true);
  assert.equal(
    C.shouldRunCritic({ taskRun: base, verification: { unmet: [], blocked: [], needsReview: [] }, mode: 'all' }),
    true,
    'all 档对普通任务也审',
  );
  assert.equal(C.shouldRunCritic({
    taskRun: { ...base, flags: { criticRequired: true } },
    verification: { unmet: [], blocked: [], needsReview: [] },
    mode: 'auto',
  }), true, 'criticRequired 不需要 expert 条件也能触发');
  assert.equal(C.shouldRunCritic({
    taskRun: base,
    verification: { unmet: [], blocked: [], needsReview: [{ id: 'c1' }] },
    mode: 'off',
  }), false);
  // 同一份产出已经审过并通过 → 不重复审
  const passed = {
    ...base,
    criticState: { lastPassedKey: C.criticTargetKeyOf(base) },
  };
  assert.equal(C.shouldRunCritic({
    taskRun: passed,
    verification: { unmet: [], blocked: [], needsReview: [{ id: 'c1' }] },
    mode: 'auto',
  }), false);
});

await test('3. criticTargetKeyOf：绑定 revision + 最新已结算 attemptId + 产物集合', () => {
  const run = {
    revision: 3,
    attempts: [
      { attemptId: 'a1', state: 'settled' },
      { attemptId: 'a2', state: 'registered' },
    ],
    progress: {
      evidence: [
        { kind: 'artifact', ref: 'out/b.md', attemptId: 'a1' },
        { kind: 'artifact', ref: 'out/a.md', attemptId: 'a1' },
      ],
    },
  };
  const key = C.criticTargetKeyOf(run);
  assert.match(key, /^r3\|aa1\|x/);
  // 换版本 → 变
  assert.notEqual(key, C.criticTargetKeyOf({ ...run, revision: 4 }));
  // 新增产物 → 变（执行者改完文件但没重跑也要重审）
  const more = { ...run, progress: { evidence: [...run.progress.evidence, { kind: 'artifact', ref: 'out/c.md', attemptId: 'a1' }] } };
  assert.notEqual(key, C.criticTargetKeyOf(more));
  // 新的结算尝试 → 变
  const next = { ...run, attempts: [{ attemptId: 'a1', state: 'settled' }, { attemptId: 'a2', state: 'settled' }] };
  assert.notEqual(key, C.criticTargetKeyOf(next));
});

await test('4. parseCriticVerdict：合法 JSON / fenced / passed 带缺陷拒收 / 垃圾文本 fail-closed', () => {
  const ok = C.parseCriticVerdict('{"verdict":"passed","summary":"核对过口径表","defects":[]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, 'passed');

  const fenced = C.parseCriticVerdict('这里是结论：\n```json\n{"verdict":"failed","summary":"数值错","defects":["out/a.md 第 3 行 100 应为 10"]}\n```\n以上。');
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.defects, ['out/a.md 第 3 行 100 应为 10']);

  const contradiction = C.parseCriticVerdict('{"verdict":"passed","summary":"看起来行","defects":["还是有问题"]}');
  assert.equal(contradiction.ok, false, '既通过又列缺陷 = 自相矛盾，绝不能放行');
  assert.equal(contradiction.verdict, 'parse_error');

  assert.equal(C.parseCriticVerdict('我觉得还行').ok, false);
  assert.equal(C.parseCriticVerdict('').ok, false);
  assert.equal(C.parseCriticVerdict('{"verdict":"failed","summary":"x","defects":[]}').ok, false,
    '判不通过却没给缺陷 → 无法执行，不能放行');
  assert.equal(C.parseCriticVerdict('{"verdict":"maybe","summary":"x"}').ok, false);

  // 缺陷去重 + 逐条截断
  const long = C.parseCriticVerdict(JSON.stringify({
    verdict: 'failed',
    summary: 'x',
    defects: ['a'.repeat(500), 'a'.repeat(500), 'b'],
  }));
  assert.equal(long.ok, true);
  assert.equal(long.defects.length, 2, '完全重复的缺陷要去重');
  assert.ok(long.defects[0].length <= C.MAX_DEFECT_CHARS);
});

await test('5. renderCriticFeedback：轮次、结论与缺陷清单都在，且字数有界', () => {
  const text = renderCriticFeedback({
    round: 1, maxRounds: 2, reviewerModel: 'critic-x',
    summary: '数值与口径不一致',
    defects: ['out/a.md 第 3 行 100 应为 10', 'out/b.md 少了单位'],
  });
  assert.match(text, /第 1\/2 轮/);
  assert.match(text, /critic-x/);
  assert.match(text, /100 应为 10/);
  assert.match(text, /少了单位/);
  assert.equal(renderCriticFeedback(null), '');
  const huge = renderCriticFeedback({ round: 1, defects: Array.from({ length: 30 }, (_, i) => 'x'.repeat(300) + i) }, { maxChars: 400 });
  assert.ok(huge.length <= 400, `返工清单必须硬控字数，实际 ${huge.length}`);
});

await test('6. selectCriticModel：优先不同健康模型；本地执行者绝不外泄到公有云', () => {
  const candidates = [
    { slug: 'cloud/a', label: 'Cloud A', groupId: 'cloud', provider: 'openai', baseUrl: 'https://api.example.com' },
    { slug: 'cloud/b', label: 'Cloud B', groupId: 'cloud2', provider: 'openai', baseUrl: 'https://api2.example.com' },
    { slug: 'ollama/qwen', label: '本地 Qwen', groupId: 'ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  ];
  const cloudExecutor = { slug: 'cloud/a', groupId: 'cloud', provider: 'openai', baseUrl: 'https://api.example.com' };
  const pick = C.selectCriticModel({ executorModel: cloudExecutor, candidates });
  assert.notEqual(pick.slug, 'cloud/a', '不能和执行者是同一个模型（除非别无选择）');
  assert.equal(pick.sameAsExecutor, false);

  // 熔断打开的跳过
  const healthAware = C.selectCriticModel({
    executorModel: cloudExecutor,
    candidates,
    isBreakerOpen: (slug) => slug === 'cloud/b',
  });
  assert.notEqual(healthAware.slug, 'cloud/b', '熔断打开的候选不能选');

  // 本地执行者：只剩公有云候选时绝不外泄
  const localExecutor = { slug: 'ollama/qwen', groupId: 'ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
  const localPick = C.selectCriticModel({ executorModel: localExecutor, candidates });
  assert.equal(localPick.slug, null, '本地执行者不该被换到公有云评审');
  assert.equal(localPick.sameAsExecutor, true, '只能退回同款模型 + 干净会话');

  // 显式指定优先
  const explicit = C.selectCriticModel({ executorModel: cloudExecutor, candidates, explicitModel: 'cloud/b' });
  assert.equal(explicit.slug, 'cloud/b');
});

// ---------------------------------------------------------------------------
// 2. 验收层：多条评审记录取最新且按尝试绑定
// ---------------------------------------------------------------------------

const access = {
  // ★ 注意形状：`safeAccess` 拿 `stat()` 的返回值直接看 `.exists`
  //   （不是 `{ ok, value }` 的包层）。写错就等于“所有产物都不存在”。
  stat: async (ref) => ({ exists: String(ref).startsWith('out/') }),
  readText: async () => ({ ok: false }),
  resolveRef: (ref) => ref,
};

function runWith({ revision = 1, attempts = [], reviews = [], evidence = [] } = {}) {
  return {
    id: 'tr_v1',
    revision,
    attempts,
    expertReviews: reviews,
    goal: { verification: [{ id: 'c1', kind: 'expert', description: '口径一致' }] },
    progress: { evidence, unmet: [] },
    openGates: [],
    flags: {},
    state: 'verifying',
  };
}

await test('7. checkExpert：上一轮 critic failed 不挡返工后的新一轮评审（取最新且按尝试绑定）', async () => {
  const attempts = [
    { attemptId: 'a1', taskRunId: 'tr_v1', state: 'settled', revision: 1, result: { artifacts: ['out/a1.md'] } },
    { attemptId: 'a2', taskRunId: 'tr_v1', state: 'settled', revision: 1, result: { artifacts: ['out/a2.md'] } },
  ];
  const failedOnA1 = {
    taskRunId: 'tr_v1', revision: 1, conditionId: 'c1', verdict: 'failed',
    note: '数值不对', attemptId: 'a1', source: 'critic_review', at: 1,
  };
  // 第 2 轮（a2）还没有评审记录 → 应该是 needsReview，而不是继承 a1 的 failed
  const afterRework = runWith({ attempts, reviews: [failedOnA1] });
  const v1 = await verifyTaskRun(awaitRework(afterRework), { access, attemptId: null });
  assert.equal(v1.passed, false);
  assert.equal(v1.needsReview.length, 1, '返工后的新产出必须重新进入评审，不能拿上一轮的 failed 当结论');
  assert.equal(v1.unmet.length, 0, '旧 failed 不该变成 unmet（否则执行者被自己的旧结论卡死）');

  // a2 也评过且通过 → 应通过
  const passedOnA2 = {
    taskRunId: 'tr_v1', revision: 1, conditionId: 'c1', verdict: 'passed',
    note: '核对过', attemptId: 'a2', source: 'critic_review', at: 2,
  };
  const v2 = await verifyTaskRun(awaitRework(runWith({ attempts, reviews: [failedOnA1, passedOnA2] })), { access, attemptId: null });
  assert.equal(v2.passed, true, '最新一条（a2）的 passed 必须生效');

  // 负责人的历史判断仍对整个版本有效（不因一次重试作废）
  const leadReview = {
    taskRunId: 'tr_v1', revision: 1, conditionId: 'c1', verdict: 'passed',
    note: '我看过了', attemptId: 'a1', source: 'lead_review', at: 1,
  };
  const v3 = await verifyTaskRun(awaitRework(runWith({ attempts, reviews: [leadReview] })), { access, attemptId: null });
  assert.equal(v3.passed, true, '负责人的判断不该因为后来重跑一次就作废');
});

/** 小工具：让上面的用例读起来更顺（同步返回 Promise 给 verifyTaskRun）。 */
function awaitRework(run) {
  return run;
}

// ---------------------------------------------------------------------------
// 3. 端到端（真 TaskRunStore + 假执行器 + 假评审员）
// ---------------------------------------------------------------------------

const chief = store.mainBot();
const memberA = store.createBot({ name: '质检成员A', persona: '写代码' });
const memberB = store.createBot({ name: '质检成员B', persona: '写代码' });
const room = store.createGroup({
  name: '质检测试组',
  botIds: [chief.id, memberA.id, memberB.id],
  leadBotId: chief.id,
});
const taskRuns = store.taskRuns;

let seq = 0;
async function makeRoot({ autonomous = true, criticRequired = false, goal = null } = {}) {
  seq += 1;
  const id = 'tr_cr' + seq;
  const requestId = 'rq_cr' + seq;
  const built = createTaskRun({
    id,
    requestId,
    requesterId: 'local',
    at: Date.now(),
    origin: { roomId: room.id },
    owner: { departmentId: room.id, leadBotId: chief.id },
    budget: { maxRuns: null },
    goal: goal ?? {
      requirement: '做一份能过质检的分析',
      verification: [{ id: 'r1', kind: 'expert', description: '负责人确认' }],
    },
    autonomous,
    autonomyReason: autonomous ? '测试：自主推进' : '',
    criticRequired,
  });
  assert.equal(built.ok, true, '建任务应成功：' + (built.text ?? ''));
  const accepted = await taskRuns.acceptRequest({
    requesterId: 'local', requestId, fingerprint: 'fp-cr-' + seq, build: () => built.taskRun, at: Date.now(),
  });
  assert.equal(accepted.ok, true, '接单应成功：' + (accepted.text ?? ''));
  return id;
}

let kidSeq = 0;
async function addKid(parentId, { botId, goal = null, criticRequired = undefined } = {}) {
  kidSeq += 1;
  const parent = taskRuns.read(parentId).taskRun;
  const out = await createChildTask({
    taskRuns,
    parentTaskRun: parent,
    botId,
    criticRequired,
    goal: goal ?? {
      requirement: '分工 #' + kidSeq + '：写口径表',
      verification: [
        { id: 'm1', kind: 'artifact', description: '交了产物', spec: { count: 1 } },
        { id: 'c1', kind: 'expert', description: '口径与数值一致' },
      ],
    },
  });
  assert.equal(out.ok, true, '建子任务应成功：' + (out.text ?? ''));
  return out.child.id;
}

/** 一次评审的脚本化返回（记录每次传入的参数，便于断言绑定信息）。 */
function makeCritic(script) {
  const calls = [];
  const queue = [...script];
  const fn = async (args) => {
    calls.push({ ...args, round: calls.length + 1 });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const base = {
      status: 'reviewed',
      reviewerModel: 'critic-model',
      reviewerSlug: 'cloud/critic',
      usage: { inputTokens: 120, outputTokens: 80 },
      at: Date.now(),
    };
    if (typeof next === 'function') return { ...base, ...(await next(args)) };
    return { ...base, ...next };
  };
  return { fn, calls };
}

function makeSupervisor({ criticReview = null, rec = null, verify = null, criticMode = 'auto', maxCriticReworks = null } = {}) {
  return createTaskSupervisor({
    taskRuns,
    maxSteps: 10,
    maxStallRounds: 3,
    execute: async (args) => {
      if (rec) rec.leads.push(args?.prompt ?? '');
      return { ok: true, stop: 'returned' };
    },
    executeMember: async (args) => {
      if (rec) {
        rec.members.push({ taskRunId: args?.taskRun?.id, prompt: args?.prompt ?? '' });
        if (rec.onMember) await rec.onMember(args);
      }
      const artifacts = rec?.artifactsFor ? rec.artifactsFor(args) : ['out/' + args.taskRun.id + '.md'];
      return { ok: true, stop: 'returned', appliedCompletion: true, artifacts };
    },
    verify,
    criticReview,
    criticMode,
    maxCriticReworks,
    access,
    clock: () => Date.now(),
    log: () => {},
    botNameOf: (id) => store.getBot(id)?.name ?? '',
  });
}

async function waitFor(sup, ids, predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.race([sup.idle(), sleep(40)]);
    const runs = ids.map((id) => taskRuns.read(id).taskRun);
    if (predicate(runs)) return runs;
    if (Date.now() > deadline) return runs;
    await sleep(40);
  }
}

await test('8. ★ 机械验收没过 → 一次都不调 Critic（零浪费）', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  const critic = makeCritic([{ ok: true, verdict: 'passed', summary: '不该被调用', defects: [] }]);
  const rec = { members: [], leads: [], artifactsFor: () => [] }; // 永远交不出产物
  const sup = makeSupervisor({ criticReview: critic.fn, rec });
  sup.notify(rootId);
  await waitFor(sup, [kid], (rs) => rs[0].state === STATE.blocked, { timeoutMs: 6000 });
  sup.dispose();
  assert.equal(critic.calls.length, 0, `机械验收没过时不该调评审，实测 ${critic.calls.length} 次`);
  assert.notEqual(taskRuns.read(kid).taskRun.state, STATE.completed);
});

await test('9. ★ 完整闭环：机械过 → 评审 failed(2 缺陷) → 返工带缺陷 → 评审 passed → 交付并落黑板', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  const critic = makeCritic([
    {
      ok: true, verdict: 'failed', summary: '数值口径不一致',
      defects: ['out/x.md 第 3 行 100 应为 10', 'out/x.md 缺少单位「元」'],
    },
    { ok: true, verdict: 'passed', summary: '核对过口径与数值，一致', defects: [] },
  ]);
  const rec = { members: [], leads: [] };
  const sup = makeSupervisor({ criticReview: critic.fn, rec });
  sup.notify(rootId);
  const runs = await waitFor(sup, [kid], (rs) => [STATE.completed, STATE.blocked, STATE.cancelled].includes(rs[0].state));

  assert.equal(runs[0].state, STATE.completed, `子任务应最终交付，实际 ${runs[0].state}（${runs[0].flags?.blockedReason ?? ''}）`);
  assert.equal(critic.calls.length, 2, `应该审两次（初次 + 复核），实测 ${critic.calls.length}`);
  assert.equal(critic.calls[0].taskRun.id, kid);
  assert.ok(critic.calls[0].attemptId, '评审必须绑定一次真实产出（attemptId）');
  assert.notEqual(critic.calls[0].targetKey, critic.calls[1].targetKey, '返工是新产出，评审目标指纹必须变');

  // 返工那一轮的提示词里必须带上两条缺陷原文
  const reworkPrompt = rec.members.map((m) => m.prompt).find((p) => p.includes('独立复核未通过')) ?? '';
  assert.ok(reworkPrompt, '返工轮的成员提示词里必须有独立复核结论');
  assert.match(reworkPrompt, /100 应为 10/);
  assert.match(reworkPrompt, /缺少单位/);
  assert.match(reworkPrompt, /第 1\/2 轮/);

  const finalRun = taskRuns.read(kid).taskRun;
  assert.equal(finalRun.criticFeedback, null, '通过之后要清掉返工清单（否则下一轮还在骂人）');
  const passedReview = (finalRun.expertReviews ?? []).find((r) => r.source === 'critic_review' && r.verdict === 'passed');
  assert.ok(passedReview, '通过的评审记录要写进 expertReviews');
  assert.equal(passedReview.conditionId, 'c1');
  assert.ok(finalRun.criticState?.lastPassedKey, '要记下已通过的目标指纹，避免同一份产出重复审');

  // 交付事实自动落根黑板
  const board = taskRuns.read(rootId).taskRun.blackboard;
  assert.ok((board?.entries ?? []).some((e) => e.kind === 'artifact' && e.taskRunId === kid), '子任务交付应落黑板');
  // 评审消耗计入根预算
  const rootBudget = taskRuns.read(rootId).taskRun.budget ?? {};
  assert.ok(Number(rootBudget.usedTokens ?? 0) >= 400, `评审的 token 要计入根预算，实际 ${rootBudget.usedTokens}`);
  sup.dispose();
});

await test('10. ★ 连续 2 轮评审不过 → 停止循环、阻塞子任务、父任务交回负责人并带上缺陷', async () => {
  const rootId = await makeRoot({ autonomous: true });
  const kid = await addKid(rootId, { botId: memberA.id });
  const critic = makeCritic([{
    ok: true, verdict: 'failed', summary: '一直不对',
    defects: ['out/x.md 结论与数据矛盾'],
  }]);
  const sup = makeSupervisor({ criticReview: critic.fn, maxCriticReworks: 2 });
  sup.notify(rootId);

  // ★ 终态是 `cancelled`（父任务把卡住的分工收回了），中间那一瞬的 `blocked`
  //   看不清。所以持久证据看两处：交回清单里的原因，以及 criticState 的轮次。
  await waitFor(sup, [rootId], (rs) => (rs[0].childHandBacks ?? 0) >= 1, { timeoutMs: 8000 });
  await sleep(150);
  await sup.idle();
  const finalRoot = taskRuns.read(rootId).taskRun;
  const finalKid = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.ok(critic.calls.length >= 2, `至少要审两轮才到上限，实测 ${critic.calls.length}`);
  assert.ok(critic.calls.length <= 3, `到上限就停，不能一直审，实测 ${critic.calls.length}`);
  assert.equal(Number(finalKid.criticState?.reworkCount ?? 0), 2, '轮次要如实计到上限');
  assert.ok((finalRoot.childHandBacks ?? 0) >= 1, '自主任务应把卡住的分工交回负责人');
  const failures = finalRoot.childFailures ?? [];
  assert.ok(failures.length >= 1, '父任务要收到交回的分工');
  const reasons = failures.map((f) => String(f.reason ?? '')).join('\n');
  assert.match(reasons, /独立复核连续 2 轮未通过/, '交回原因要说清是质检不过：' + reasons);
  assert.match(reasons, /结论与数据矛盾/, '负责人要能看到真实缺陷');
  assert.notEqual(finalKid.state, STATE.completed);
});

await test('11. ★ 评审员自身故障：不伪造通过、不扣返工额度、稍后重试', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  const critic = makeCritic([{
    status: 'error', code: 'timeout', why: '评审超时（180 秒无结论）', ok: undefined, usage: null,
  }]);
  const sup = makeSupervisor({ criticReview: critic.fn });
  sup.notify(rootId);
  await sleep(400);
  await sup.idle();
  const run = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.equal(critic.calls.length, 1);
  assert.notEqual(run.state, STATE.completed, '基础设施故障绝不能伪造成通过');
  assert.equal(Number(run.criticState?.errorCount ?? 0), 1, '要记下评审失败次数');
  assert.equal(Number(run.criticState?.reworkCount ?? 0), 0, '基础设施故障不能扣返工额度');
  assert.equal((run.expertReviews ?? []).length, 0, '不能写任何评审记录');
  assert.match(String(run.criticState?.lastError ?? ''), /超时/);
});

await test('12. ★ 评审期间改版 → 结论丢弃，不污染新版本', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const critic = makeCritic([async () => {
    await gate;
    return { ok: true, verdict: 'failed', summary: '过期结论', defects: ['不该被写入'] };
  }]);
  const sup = makeSupervisor({ criticReview: critic.fn });
  sup.notify(rootId);
  // 等评审开始
  for (let i = 0; i < 40 && !critic.calls.length; i += 1) {
    await Promise.race([sup.idle(), sleep(30)]);
    await sleep(30);
  }
  assert.equal(critic.calls.length, 1, '评审应该已经开始');
  // 评审挂起期间改版（`revision_bumped` 要求真的换了目标）
  const bumped = await sup.bumpRevision(kid, {
    goal: {
      requirement: '分工：写口径表（改版：换成新版口径）',
      verification: [
        { id: 'm1', kind: 'artifact', description: '交了产物', spec: { count: 1 } },
        { id: 'c1', kind: 'expert', description: '口径与数值一致（v2）' },
      ],
    },
    reason: '测试改版',
  });
  assert.equal(bumped?.ok, true, '改版应成功：' + (bumped?.text ?? bumped?.code ?? ''));
  const staleAttempt = critic.calls[0].attemptId;
  // 改版那一刻评审状态就该清空
  const afterBump = taskRuns.read(kid).taskRun;
  assert.equal(afterBump.criticState ?? null, null, '改版要清空 criticState');
  assert.equal(afterBump.criticFeedback ?? null, null, '改版要清空返工清单');

  release();
  await sleep(400);
  await sup.idle();
  const run = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.equal(run.revision, 2);
  const stale = (run.expertReviews ?? []).filter((r) => String(r.attemptId) === String(staleAttempt));
  assert.equal(stale.length, 0, `改版前那次评审的结论不得写入（attempt=${staleAttempt}）`);
  const staleFeedback = run.criticFeedback && String(run.criticFeedback.attemptId) === String(staleAttempt);
  assert.equal(Boolean(staleFeedback), false, '过期结论不能变成返工清单');
});

await test('13. ★ 取消竞态：评审返回时任务已取消 → 丢弃结论', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const critic = makeCritic([async () => {
    await gate;
    return { ok: true, verdict: 'passed', summary: '过期通过', defects: [] };
  }]);
  const sup = makeSupervisor({ criticReview: critic.fn });
  sup.notify(rootId);
  for (let i = 0; i < 40 && !critic.calls.length; i += 1) {
    await Promise.race([sup.idle(), sleep(30)]);
    await sleep(30);
  }
  assert.equal(critic.calls.length, 1);
  await sup.cancelTask(kid, { reason: '用户取消' });
  release();
  await sleep(400);
  await sup.idle();
  const run = taskRuns.read(kid).taskRun;
  sup.dispose();

  assert.equal(run.state, STATE.cancelled);
  assert.equal((run.expertReviews ?? []).length, 0, '取消后不得写入评审记录');
  assert.notEqual(run.state, STATE.completed);
});

await test('14. ★ Token 预算用尽 → 不启动评审，走预算暂停', async () => {
  const goal = {
    requirement: '预算很紧的活',
    verification: [
      { id: 'm1', kind: 'artifact', description: '交了产物', spec: { count: 1 } },
      { id: 'c1', kind: 'expert', description: '口径一致' },
    ],
  };
  const rootId = await makeRoot({ goal });
  const requestId = 'rq-budget-' + rootId;
  await taskRuns.mutate(rootId, {
    mutate: (cur) => ({ ...cur, budget: { ...(cur.budget ?? {}), maxTokens: 100, usedTokens: 0 }, updatedAt: Date.now() }),
  });
  const kid = await addKid(rootId, { botId: memberA.id, goal });
  const critic = makeCritic([{ ok: true, verdict: 'passed', summary: '不该被调用', defects: [] }]);
  const rec = {
    members: [], leads: [],
    // 执行期间把根预算烧光（模拟这一轮真的花了 token）
    onMember: async () => {
      await taskRuns.mutate(rootId, {
        mutate: (cur) => ({ ...cur, budget: { ...(cur.budget ?? {}), usedTokens: 100 }, updatedAt: Date.now() }),
      });
    },
  };
  const sup = makeSupervisor({ criticReview: critic.fn, rec });
  sup.notify(rootId);
  await sleep(600);
  await sup.idle();
  const run = taskRuns.read(kid).taskRun;
  sup.dispose();
  assert.equal(critic.calls.length, 0, '预算用尽时一次评审都不该跑（不偷跑模型）');
  assert.ok([STATE.paused_budget, STATE.verifying].includes(run.state), `应停在预算暂停，实际 ${run.state}`);
  assert.equal(requestId.length > 0, true);
});

await test('15. ★ criticLane 会话隔离：纯内存 + 只读工具白名单（无写/shell/MCP）', async () => {
  const bot = store.createBot({ name: '评审lane', role: 'main' });
  const dm = store.ensureDm(bot.id);
  const runner = {
    config: store.config ?? { workspace: path.join(fixture, 'workspace'), dataDir: path.join(fixture, 'data') },
    store,
    bus: null,
    modelGroups: { list: () => [], get: () => null },
    breakerFor: () => null,
  };
  const model = { provider: 'cloud', id: 'critic' };
  let inMemoryCalls = 0;
  let diskCalls = 0;
  let captured = null;
  const builder = createSessionBuilder({
    runner,
    health: null,
    resolveModel: () => null,
    modelLabel: () => '',
    sessionApi: {
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
      SessionManager: {
        inMemory: () => { inMemoryCalls += 1; return {}; },
        create: () => { diskCalls += 1; return {}; },
        open: () => { diskCalls += 1; return {}; },
      },
      DefaultResourceLoader: class {
        constructor(options) { this.options = options; }
        async reload() {}
      },
      async createAgentSession(options) {
        captured = options;
        return {
          session: {
            model,
            sessionFile: path.join(fixture, 'should-not-save.jsonl'),
            settingsManager: { applyOverrides() {} },
            subscribe() { return () => {}; },
            dispose() {},
          },
        };
      },
    },
  });
  await builder(dm.id, bot.id, { criticLane: true });

  assert.equal(inMemoryCalls, 1, '评审通道必须用 SessionManager.inMemory');
  assert.equal(diskCalls, 0, '评审通道不能创建/打开磁盘会话');
  assert.equal(captured.customTools.length, 0, '评审通道不能有自定义工具（含 MCP/派活等）');
  for (const tool of ['bash', 'write', 'edit', 'run_background', 'dispatch_bot', 'git_commit', 'task_report']) {
    assert.equal(captured.tools.includes(tool), false, `评审通道禁止启用 ${tool}`);
  }
  for (const tool of ['read', 'ls', 'find', 'grep']) {
    assert.equal(captured.tools.includes(tool), true, `评审通道应保留只读工具 ${tool}`);
  }
  assert.equal(captured.resourceLoader.options.noExtensions, true);
  assert.equal(captured.resourceLoader.options.noMcp, true);
  assert.equal(store.sessionFileFor(dm.id, bot.id), null, '评审通道不得写 store sessionFile');
  const prompt = String(captured.resourceLoader.options.appendSystemPrompt ?? '');
  assert.match(prompt, /只读/, '评审通道要有自己的系统提示（只读、不信自述）');
});

await test('16. criticFeedback 只在同版本注入；改版后不再贴旧缺陷', () => {
  const run = {
    revision: 2,
    criticFeedback: { revision: 2, round: 1, maxRounds: 2, summary: 'x', defects: ['旧缺陷 A'] },
  };
  assert.match(criticFeedbackBlock(run), /旧缺陷 A/);
  assert.equal(criticFeedbackBlock({ ...run, revision: 3 }), '', '改版后旧缺陷必须失效');
  assert.equal(criticFeedbackBlock({ revision: 2, criticFeedback: null }), '');
});

await test('17. task-critic-runner：真的用 criticLane 开会话、收文本与 usage、finally 里 dispose', async () => {
  const { createCriticReviewer } = await import(src('tasks/task-critic-runner.js'));
  const buildCalls = [];
  let disposed = 0;
  let listener = null;
  const runner = {
    modelGroups: { list: () => [{ id: 'cloud', enabled: true, provider: 'openai', baseUrl: 'https://api.example.com', menuEntries: () => [{ label: 'Cloud X', slugs: ['cloud/x'] }] }], get: () => null },
    breakerFor: () => null,
    breakers: new Map(),
    __buildSession: async (roomId, botId, opts) => {
      buildCalls.push({ roomId, botId, opts });
      return {
        session: {
          subscribe(fn) { listener = fn; return () => { listener = null; }; },
          async prompt() {
            listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"verdict":"passed",' } });
            listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '"summary":"核对过产物","defects":[]}' } });
            listener?.({ type: 'message_end', message: { usage: { inputTokens: 300, outputTokens: 50 } } });
          },
          async dispose() { disposed += 1; },
        },
      };
    },
  };
  const reviewer = createCriticReviewer({
    runner,
    store,
    routeOf: () => ({ roomId: room.id, botId: memberA.id }),
    log: () => {},
  });
  const out = await reviewer({
    taskRun: { id: 'tr_x', revision: 1, goal: { requirement: '活' }, attempts: [], progress: { evidence: [] } },
    verification: { verdicts: [] },
  });
  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].opts.criticLane, true, '必须走 criticLane（纯内存只读）');
  assert.equal(buildCalls[0].opts.persist, false, '评审会话不得落盘');
  assert.equal(out.status, 'reviewed');
  assert.equal(out.verdict, 'passed');
  assert.match(String(out.summary), /核对过产物/);
  assert.equal(out.usage.inputTokens, 300, '评审的 usage 要能被调用方记账');
  assert.equal(disposed, 1, '会话必须 dispose（防内存/监听器泄漏）');

  // 评审员抛错 → status: error（不当成业务缺陷）
  const failing = createCriticReviewer({
    runner: {
      modelGroups: { list: () => [], get: () => null },
      breakerFor: () => null,
      breakers: new Map(),
      __buildSession: async () => ({ session: { subscribe: () => () => {}, async prompt() { throw new Error('429 rate limited'); }, async dispose() {} } }),
    },
    store,
    routeOf: () => ({ roomId: room.id, botId: memberA.id }),
    log: () => {},
  });
  const bad = await failing({ taskRun: { id: 'tr_y', revision: 1 }, verification: {} });
  assert.equal(bad.status, 'error');
  assert.match(String(bad.why), /429/);
});

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`
long-task-critic：${passed}/${results.length} 通过`);
if (failed) {
  for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}
    ${r.err}`);
  process.exit(1);
}
process.exit(0);
