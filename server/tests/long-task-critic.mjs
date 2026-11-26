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

await test('6b. ★ selectCriticModel 遵守 ORBIS_MODEL_FALLBACK 与 lockModel（评审员会读产物原文）', () => {
  const executor = { slug: 'azure/gpt-main', groupId: 'azure', provider: 'azure', baseUrl: 'https://corp.openai.azure.com' };
  const candidates = [
    { slug: 'azure/gpt-mini', label: 'gpt mini', groupId: 'azure-b', provider: 'azure', baseUrl: 'https://corp2.openai.azure.com' },
    { slug: 'other/opus', label: 'opus', groupId: 'other', provider: 'other', baseUrl: 'https://api.other.example' },
  ];
  // 默认 cloud：沿用原行为（云端之间可以换，优先其它模型组）
  assert.notEqual(C.selectCriticModel({ executorModel: executor, candidates }).slug, 'azure/gpt-main');

  // same-provider：只在执行者同一家里换
  const same = C.selectCriticModel({ executorModel: executor, candidates, policyMode: 'same-provider' });
  assert.equal(same.slug, 'azure/gpt-mini', `same-provider 不能换到别家：${same.slug}`);
  const onlyOther = C.selectCriticModel({ executorModel: executor, candidates: [candidates[1]], policyMode: 'same-provider' });
  assert.equal(onlyOther.slug, null, '同一家里没有别的模型 → 用同款干净会话，绝不跨家');
  assert.equal(onlyOther.sameAsExecutor, true);
  // same-provider 下显式指定跨家的评审模型：拒绝并说明，不静默照用
  const explicitCross = C.selectCriticModel({
    executorModel: executor, candidates, policyMode: 'same-provider',
    explicitModel: 'other/opus', explicitResolvable: true, explicitProvider: 'other',
  });
  assert.notEqual(explicitCross.slug, 'other/opus');
  assert.match(String(explicitCross.rejected ?? ''), /same-provider/);

  // off：不自动换（显式指定的照用 —— 那是用户的明确选择）
  const off = C.selectCriticModel({ executorModel: executor, candidates, policyMode: 'off' });
  assert.equal(off.slug, null);
  assert.match(off.why, /ORBIS_MODEL_FALLBACK=off/);
  assert.equal(
    C.selectCriticModel({ executorModel: executor, candidates, policyMode: 'off', explicitModel: 'azure/gpt-mini' }).slug,
    'azure/gpt-mini',
  );

  // lockModel：只用同款（显式指定的也不用）
  const locked = C.selectCriticModel({
    executorModel: executor, candidates, userLocked: true, explicitModel: 'other/opus', explicitResolvable: true,
  });
  assert.equal(locked.slug, null, '成员模型锁定时不能换评审模型');
  assert.equal(locked.sameAsExecutor, true);
  assert.match(String(locked.rejected ?? ''), /锁定/);
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

await test('14. ★ Token 预算用尽 → 不启动评审、严格停在 paused_budget；追加额度后自动恢复并完成', async () => {
  const goal = {
    requirement: '预算很紧的活',
    verification: [
      { id: 'm1', kind: 'artifact', description: '交了产物', spec: { count: 1 } },
      { id: 'c1', kind: 'expert', description: '口径一致' },
    ],
  };
  const rootId = await makeRoot({ goal });
  await taskRuns.mutate(rootId, {
    mutate: (cur) => ({ ...cur, budget: { ...(cur.budget ?? {}), maxTokens: 100, usedTokens: 0 }, updatedAt: Date.now() }),
  });
  const kid = await addKid(rootId, { botId: memberA.id, goal });
  const critic = makeCritic([{ ok: true, verdict: 'passed', summary: '核对过', defects: [] }]);
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
  const paused = await waitFor(sup, [kid], (rs) => rs[0].state === STATE.paused_budget, { timeoutMs: 3000 });
  assert.equal(paused[0].state, STATE.paused_budget, `预算用尽必须严格停在 paused_budget，实际 ${paused[0].state}`);
  assert.equal(critic.calls.length, 0, '预算用尽时一次评审都不该跑（不偷跑模型）');

  // ★ 追加额度后要能真的继续（否则扩额按钮就是假的），且这次评审真的跑了
  const extended = await sup.onBudgetExtended(rootId, { extraTokens: 500 });
  assert.equal(extended?.ok, true, '扩额应成功：' + (extended?.text ?? extended?.code ?? ''));
  const done = await waitFor(sup, [kid], (rs) => rs[0].state === STATE.completed, { timeoutMs: 8000 });
  sup.dispose();
  assert.equal(done[0].state, STATE.completed, `扩额后应自动恢复并完成，实际 ${done[0].state}（${done[0].flags?.blockedReason ?? ''}）`);
  assert.ok(critic.calls.length >= 1, '扩额后评审应真的跑起来');
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
            listener?.({ type: 'message_start', message: { role: 'assistant' } });
            listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"verdict":"passed",' } });
            listener?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '"summary":"核对过产物","defects":[]}' } });
            // usage **只在** message_end（assistant）上报一次；update 里不报
            listener?.({ type: 'message_end', message: { role: 'assistant', usage: { inputTokens: 300, outputTokens: 50 }, content: [{ type: 'text', text: '{"verdict":"passed","summary":"核对过产物","defects":[]}' }] } });
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

await test('18. ★ 本地执行者（含默认模型 + ollama/… 内置 slug）绝不被换到云端评审', async () => {
  const { createCriticReviewer, criticCandidatesOf } = await import(src('tasks/task-critic-runner.js'));

  // (a) 纯策略：`ollama/qwen3` 这种内置本地 slug（没有 provider 字段）也必须认出本地
  const cloudCandidates = [
    { slug: 'cloud/a', label: 'Cloud A', groupId: 'cloud', provider: 'openai', baseUrl: 'https://api.example.com' },
    { slug: 'cloud/b', label: 'Cloud B', groupId: 'cloud2', provider: 'openai', baseUrl: 'https://api2.example.com' },
  ];
  const localPicked = C.selectCriticModel({
    executorModel: { slug: 'ollama/qwen3' },
    candidates: cloudCandidates,
  });
  assert.equal(localPicked.slug, null, '本地执行者不能选到云端候选');
  assert.equal(localPicked.sameAsExecutor, true);

  // (b) 显式指定云端也不许外泄（环境变量写错就是数据泄露）
  const explicitCloud = C.selectCriticModel({
    executorModel: { slug: 'ollama/qwen3' },
    candidates: cloudCandidates,
    explicitModel: 'cloud/b',
    explicitResolvable: true,
  });
  assert.notEqual(explicitCloud.slug, 'cloud/b', 'ORBIS_CRITIC_MODEL 指向云端时，本地执行者必须拒绝');
  assert.match(String(explicitCloud.rejected ?? explicitCloud.why), /拒绝外泄/);

  // (c) 非本地执行者：显式模型可解析但不在候选里 → 不要静默丢弃
  const explicitKnown = C.selectCriticModel({
    executorModel: { slug: 'cloud/a', provider: 'openai', baseUrl: 'https://api.example.com' },
    candidates: cloudCandidates,
    explicitModel: 'cloud/self-hosted',
    explicitResolvable: true,
  });
  assert.equal(explicitKnown.slug, 'cloud/self-hosted', '能解析的显式模型要用上，而不是默默忽略');

  // (d) 真实装配：bot.model 为空 → 回落真跑模型标签
  const localBot = store.createBot({ name: '本地评审执行者', role: 'main' });
  const calls = [];
  const fakeRunner = {
    model: { provider: 'ollama', id: 'qwen3' },
    modelLabel: () => 'ollama/qwen3',
    resolveModel: (slug) => (String(slug).startsWith('ollama/')
      ? { provider: 'ollama', id: 'qwen3', baseUrl: 'http://127.0.0.1:11434' }
      : null),
    modelGroups: {
      list: () => [
        {
          id: 'cloud',
          enabled: true,
          baseUrl: 'https://api.example.com',
          endpoints: [{ baseUrl: 'https://api.example.com' }],
          menuEntries: () => [{ label: 'Cloud A', slugs: ['cloud/a'] }],
        },
        {
          id: 'ollama',
          enabled: true,
          baseUrl: 'http://127.0.0.1:11434',
          endpoints: [{ baseUrl: 'http://127.0.0.1:11434' }],
          menuEntries: () => [{ label: '本地 Qwen', slugs: ['ollama/qwen3'] }],
        },
      ],
      get: () => null,
    },
    breakerFor: () => null,
    breakers: new Map(),
    __buildSession: async (roomId, botId, opts) => {
      calls.push(opts);
      return {
        session: {
          subscribe: () => () => {},
          async prompt() {},
          async dispose() {},
        },
      };
    },
  };
  const reviewer = createCriticReviewer({
    runner: fakeRunner,
    store,
    routeOf: () => ({ roomId: room.id, botId: localBot.id }),
    log: () => {},
  });
  await reviewer({ taskRun: { id: 'tr_local', revision: 1, goal: { requirement: 'x' } }, verification: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelOverride, undefined, '本地执行者不得被换到 cloud/a 评审（真实装配也要守住）');
  assert.equal(calls[0].criticLane, true);

  // (e) 候选透传：真实 ModelGroup 没有 provider 字段，要从 slug 前缀补
  const cands = criticCandidatesOf(fakeRunner.modelGroups, { resolveModel: fakeRunner.resolveModel });
  const cloudCand = cands.find((c) => c.slug === 'cloud/a');
  const ollamaCand = cands.find((c) => c.slug === 'ollama/qwen3');
  // 真实 ModelGroup 没有 provider 字段 → 从 resolveModel 或 slug 前缀补
  assert.equal(cloudCand.provider, 'cloud', 'provider 要能从 slug 前缀补全');
  assert.equal(cloudCand.local, false);
  assert.equal(ollamaCand.provider, 'ollama', 'resolveModel 给的 provider 优先');
  assert.equal(ollamaCand.local, true, '端点/地址是 loopback 就要判成本地');
});

await test('19. ★ 多轮工具调用：只取最后一轮结论、usage 不双计；SDK 静默报错不被吞成 no_output', async () => {
  const { createCriticReviewer } = await import(src('tasks/task-critic-runner.js'));
  const bot = store.createBot({ name: '多轮评审执行者', role: 'main' });
  const buildFake = (script) => ({
    model: { provider: 'cloud', id: 'critic' },
    modelLabel: () => 'cloud/critic',
    resolveModel: () => null,
    modelGroups: { list: () => [], get: () => null },
    breakerFor: () => null,
    breakers: new Map(),
    __buildSession: async () => ({
      session: {
        subscribe: (fn) => { script(fn); return () => {}; },
        async prompt() {},
        async dispose() {},
      },
    }),
  });

  // 第 1 轮：思考文本里带一个 `{placeholder}` 并调工具；第 2 轮才是结论
  const multiTurn = (fn) => {
    fn({ type: 'message_start', message: { role: 'assistant' } });
    fn({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '我先看 {"path":"out/a.md"} 这个文件' } });
    fn({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '我先看 {"path":"out/a.md"} 这个文件' }], usage: { inputTokens: 100, outputTokens: 10 } },
    });
    fn({ type: 'message_start', message: { role: 'assistant' } });
    fn({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '结论：' } });
    fn({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '{"verdict":"failed","summary":"数值不一致","defects":["out/a.md 第 3 行 100 应为 10"]}' } });
    fn({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '结论：{"verdict":"failed","summary":"数值不一致","defects":["out/a.md 第 3 行 100 应为 10"]}' }],
        usage: { inputTokens: 200, outputTokens: 20 },
      },
    });
  };
  const multi = createCriticReviewer({
    runner: buildFake(multiTurn), store, routeOf: () => ({ roomId: room.id, botId: bot.id }), log: () => {},
  });
  const multiOut = await multi({ taskRun: { id: 'tr_multi', revision: 1, goal: { requirement: 'x' } }, verification: {} });
  assert.equal(multiOut.status, 'reviewed', '多轮工具调用后仍要能解析出结论：' + JSON.stringify(multiOut));
  assert.equal(multiOut.verdict, 'failed', '要取最后一轮的结论对象，不能被第一轮的 {placeholder} 带偏');
  assert.deepEqual(multiOut.defects, ['out/a.md 第 3 行 100 应为 10']);
  assert.equal(multiOut.usage.inputTokens, 300, 'usage 只按 message_end 累加一次（100 + 200）');
  assert.equal(multiOut.usage.outputTokens, 30, 'output 同理（10 + 20），update 里不得再累一次');

  // SDK 静默上报的错误（429）：必须当基础设施工伤，而不是「评审员没说话」
  const sdkError = (fn) => {
    fn({ type: 'message_start', message: { role: 'assistant' } });
    fn({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit exceeded', usage: { inputTokens: 5, outputTokens: 0 } },
    });
  };
  const failing = createCriticReviewer({
    runner: buildFake(sdkError), store, routeOf: () => ({ roomId: room.id, botId: bot.id }), log: () => {},
  });
  const sdkOut = await failing({ taskRun: { id: 'tr_sdk', revision: 1, goal: { requirement: 'x' } }, verification: {} });
  assert.equal(sdkOut.status, 'error');
  assert.equal(sdkOut.code, 'prompt_failed', 'SDK 报错要走 prompt_failed，不能落成 no_output');
  assert.match(String(sdkOut.why), /429/);
});

await test('20. ★ 评审员故障退避：到期前重复 notify 不连撞；连续 3 次才停（off-by-one）', async () => {
  const rootId = await makeRoot();
  const kid = await addKid(rootId, { botId: memberA.id });
  const critic = makeCritic([{ status: 'error', code: 'timeout', why: '评审超时', ok: undefined, usage: null }]);
  const sup = makeSupervisor({ criticReview: critic.fn });
  sup.notify(rootId);
  await sleep(300);
  await sup.idle();
  assert.equal(critic.calls.length, 1, '第一次评审应跑过');
  const afterFirst = taskRuns.read(kid).taskRun;
  assert.ok(Number.isFinite(afterFirst.retryAt), '故障后要排一个到期唤醒');
  assert.ok(afterFirst.retryAt > Date.now(), '退避必须排到未来');

  // 到期前反复 notify：不能穿透退避连撞评审
  for (let i = 0; i < 5; i += 1) {
    sup.notify(kid);
    sup.notify(rootId);
    await sleep(30);
    await sup.idle();
  }
  assert.equal(critic.calls.length, 1, `退避期内不该重复评审，实测 ${critic.calls.length} 次`);

  // 连续 3 次（常量语义）才停：手动清掉退避模拟到期
  for (let round = 2; round <= 3; round += 1) {
    await taskRuns.mutate(kid, { mutate: (cur) => ({ ...cur, retryAt: null, updatedAt: Date.now() }) });
    sup.notify(kid);
    await sleep(250);
    await sup.idle();
    const now = taskRuns.read(kid).taskRun;
    assert.equal(Number(now.criticState?.errorCount ?? 0), round, `第 ${round} 次失败应记到 errorCount=${round}`);
  }
  await sleep(250);
  await sup.idle();
  const finalRun = taskRuns.read(kid).taskRun;
  const rootRun = taskRuns.read(rootId).taskRun;
  sup.dispose();
  assert.equal(finalRun.state, STATE.blocked, '连续 3 次跑不起来就停下等人工，不是 4 次');
  assert.match(String(finalRun.flags?.blockedReason ?? ''), /连续 3 次无法完成/);
  // ★ 评审员跑不起来不是「活没干好」：父任务醒来后不能把它交回负责人取消、再派人重做
  assert.equal(finalRun.nonRetriableBlock?.kind, 'critic_unavailable', '要记成「不交回」的不可恢复类别');
  assert.equal(Number(rootRun.childHandBacks ?? 0), 0, '评审员故障不能触发交回重做');
  assert.equal(rootRun.state, STATE.blocked, '父任务应如实停下等人工');
  assert.match(String(rootRun.flags?.blockedReason ?? ''), /critic_unavailable/);
});

await test('21. ★ criticRequired 达上限阻塞后，手动解除阻塞能回到返工（不原地秒阻）', async () => {
  const rootId = await makeRoot({ autonomous: false });
  // 没有 expert 条件，只靠 criticRequired 触发质检
  const kid = await addKid(rootId, {
    botId: memberA.id,
    criticRequired: true,
    goal: {
      requirement: '写一份要被质检的报告',
      verification: [{ id: 'm1', kind: 'artifact', description: '交了产物', spec: { count: 1 } }],
    },
  });
  const critic = makeCritic([
    { ok: true, verdict: 'failed', summary: '不行', defects: ['结论缺依据'] },
    { ok: true, verdict: 'failed', summary: '还不行', defects: ['结论仍缺依据'] },
    { ok: true, verdict: 'passed', summary: '这次可以了', defects: [] },
  ]);
  const rec = { members: [], leads: [] };
  const sup = makeSupervisor({ criticReview: critic.fn, rec, maxCriticReworks: 2 });
  sup.notify(rootId);
  const blocked = await waitFor(sup, [kid], (rs) => rs[0].state === STATE.blocked, { timeoutMs: 8000 });
  assert.equal(blocked[0].state, STATE.blocked, '连续两轮不过应阻塞');
  const memberRunsBefore = rec.members.filter((m) => m.taskRunId === kid).length;

  // 手动解除阻塞：必须先回到 queued（让执行者真的再干一轮），而不是立刻拿旧产出重审
  const unblocked = await sup.onControl(kid, { type: 'unblock', reason: '我改好了' });
  assert.equal(unblocked?.ok, true, '解除阻塞应成功：' + (unblocked?.text ?? unblocked?.code ?? ''));
  const afterUnblock = taskRuns.read(kid).taskRun;
  assert.equal(afterUnblock.state, STATE.queued, `解除后应回到排队返工，实际 ${afterUnblock.state}`);
  assert.equal(Number(afterUnblock.criticState?.reworkCount ?? 0), 0, '人工介入后返工轮次要清零（否则一动就到上限）');
  assert.equal(Number(afterUnblock.criticState?.errorCount ?? 0), 0, '错误计数也要清零');

  const done = await waitFor(sup, [kid], (rs) => rs[0].state === STATE.completed, { timeoutMs: 8000 });
  sup.dispose();
  assert.equal(done[0].state, STATE.completed, `解除后应能返工并通过，实际 ${done[0].state}（${done[0].flags?.blockedReason ?? ''}）`);
  const memberRunsAfter = rec.members.filter((m) => m.taskRunId === kid).length;
  assert.ok(memberRunsAfter > memberRunsBefore, '解除阻塞后执行者必须真的再跑一轮（而不是直接拿旧产出重审）');
  assert.equal(critic.calls.length, 3, '解除后应有一次新的评审');
});

await test('22. parseCriticVerdict：多个平衡 JSON 时取最后一个带 verdict 的（正文提字段不误伤）', () => {
  const text = '先看 {"path":"out/a.md"}，字段是 {"verdict":"passed"} 这种形状。\n结论：{"verdict":"failed","summary":"数值不对","defects":["out/a.md 第 3 行 100 应为 10"]}';
  const parsed = C.parseCriticVerdict(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict, 'failed', '要取最后一个带 verdict 的结论对象');
  assert.deepEqual(parsed.defects, ['out/a.md 第 3 行 100 应为 10']);
  const fenced = C.parseCriticVerdict('草稿 {"verdict":"failed","summary":"草稿","defects":["a"]}\n```json\n{"verdict":"passed","summary":"最终核对过","defects":[]}\n```');
  assert.equal(fenced.verdict, 'passed', '代码块内的结论优先');
  assert.equal(C.parseCriticVerdict('{"path":"out/a.md"}').ok, false, '只有无关对象时 fail-closed');
});

// ---------------------------------------------------------------------------

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
