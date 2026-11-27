/**
 * 「被模型长度上限截断」的止血：
 *   · 纯判定 `lengthTruncationOf`（这一轮到底算不算被截断、在不在高水位）；
 *   · 抢救 `recoverFromLengthTruncation`（强制压一次 + 续答一次 + 该不该出提示）。
 *   · 强制压缩 `compactIfNeeded({ force: true })` 与「percent 为 null 时用固定开销补盲」。
 *
 * ## 为什么要有这一份（真机复现）
 *
 * `nemotron-3.5-super-vl`（128k 窗口）在上一轮压缩后，老会话里残留着 5 篇技能全文、
 * 工具定义与历史摘要，已占 ~117k；界面按 `chars/4` 粗估只显示 45%，`compactIfNeeded`
 * 于是放行。轮内连调 3 次工具，第 4 次请求到 124,339 / 128,000（97.1%），模型返回：
 *
 *     output: 1 · THINK: "Found" · 正文为空 · stopReason: "length"
 *
 * 工具调用前它顺口吐过一句过渡话，那句已经在 `committed` 里 —— `render()` 非空，
 * 旧代码把这半句话标成 `status: 'done'`：不报错、不压缩、不重试。
 */
import assert from 'node:assert/strict';

const { lengthTruncationOf, estimateUsagePercent, latestPromptTokens, LENGTH_NOTICE, SMALL_CONTEXT_WINDOW } =
  await import('../src/context-budget.js');
const { recoverFromLengthTruncation, LENGTH_RESUME_PROMPT } = await import('../src/runner/turn-length-recovery.js');
const { compactIfNeeded } = await import('../src/runner/memory-compactor.js');

let pass = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err: err?.message || String(err) });
    console.log(`✗ ${name}: ${err?.message || err}`);
  }
}

/** 假的会话：只有本模块用到的那几个面。 */
function fakeSession({
  contextWindow = 128_000, messages = [], usage = undefined, systemPrompt = 'SYS',
  compactOk = true, compactErr = null, onPrompt = null, onCompact = null,
} = {}) {
  const session = {
    model: { contextWindow },
    messages,
    systemPrompt,
    isCompacting: false,
    getContextUsage: () => usage,
    compact: async () => {
      onCompact?.();
      if (compactErr) throw compactErr;
      if (!compactOk) throw new Error('压缩失败');
      return { ok: true };
    },
    prompt: async (text) => { onPrompt?.(text); },
    settingsManager: null,
  };
  return session;
}

function fakeRunner({ compact = null, session = null } = {}) {
  return {
    config: { compactAtPercent: 0.6, autoCompact: true, backgroundSlotWaitMs: 0, reserveTokens: 16_384 },
    aborting: new Set(),
    acquireBackgroundSlot: async () => ({ ok: true, release: () => {} }),
    compactIfNeeded: compact ?? (async () => ({ compacted: true, failed: false, attempts: 1, why: 'ok' })),
  };
}

// ---------------------------------------------------------------------------
// 1. 纯判定
// ---------------------------------------------------------------------------

await test('LENGTH_NOTICE：必须明确告诉用户这不是完整结论', () => {
  assert.ok(LENGTH_NOTICE.trim().length > 10);
  assert.match(LENGTH_NOTICE, /中断|截断/);
});

await test('★ lengthTruncationOf：stopReason=length 且这条正文为空 → 判为截断', () => {
  const hit = lengthTruncationOf({
    stopReason: 'length', hadText: false, promptTokens: 124_339, contextWindow: 128_000,
  });
  assert.equal(hit.truncated, true);
  assert.equal(hit.nearLimit, true, '97% 属于逼近上限');
  assert.equal(Math.round(hit.percent ?? 0), 97);
});

await test('lengthTruncationOf：有正文 / 不是 length / 用户取消 / 步数上限都不算要抢救的截断', () => {
  const base = { promptTokens: 124_339, contextWindow: 128_000 };
  assert.equal(lengthTruncationOf({ ...base, stopReason: 'length', hadText: true }).truncated, false,
    '有正文说明模型正常说完了');
  assert.equal(lengthTruncationOf({ ...base, stopReason: 'end_turn', hadText: false }).truncated, false);
  assert.equal(lengthTruncationOf({ ...base, stopReason: 'length', hadText: false, cancelled: true }).truncated, false,
    '用户取消不该触发抢救');
  assert.equal(lengthTruncationOf({ ...base, stopReason: 'length', hadText: false, stepCapHit: true }).truncated, false);
});

await test('★ 请求超时（timedOut）不算可抢救的截断：stopReason 也可能长成 length', () => {
  // 硬超时会 abort 会话，事件里可能只留下 stopReason='length' 且没有正文；
  // 这种情况再去"强压 + 续答一次"只是在超时之上再加一段超时。
  const hit = lengthTruncationOf({
    stopReason: 'length', hadText: false, promptTokens: 124_339, contextWindow: 128_000, timedOut: true,
  });
  assert.equal(hit.truncated, false);
  assert.equal(hit.nearLimit, true, '占用判断照旧');
});

await test('lengthTruncationOf：nearLimit 认 percent（getContextUsage 口径）也认 promptTokens', () => {
  assert.equal(lengthTruncationOf({ stopReason: 'length', percent: 90 }).nearLimit, true);
  assert.equal(lengthTruncationOf({ stopReason: 'length', percent: 40, promptTokens: 100 }).nearLimit, false);
  assert.equal(
    lengthTruncationOf({ stopReason: 'length', promptTokens: 115_000, contextWindow: 128_000 }).nearLimit,
    true,
    '115k/128k ≈ 90%',
  );
});

// ---------------------------------------------------------------------------
// 2. 占用估计（高水位补盲）
// ---------------------------------------------------------------------------

await test('★ estimateUsagePercent：把固定开销（system + 工具定义）算进去', () => {
  // 只数消息正文会把这些漏掉 —— 真机 117k 被显示成 45% 就是这个原因
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: 'user', content: '第' + i + '条：' + '内容'.repeat(600),
  }));
  const session = fakeSession({ contextWindow: 128_000, messages, usage: undefined });
  const percent = estimateUsagePercent(session);
  assert.equal(typeof percent, 'number');
  assert.ok(percent > 0 && percent <= 100, `估计值应在 0..100，实际 ${percent}`);
  // 窗口未知 → 不猜
  assert.equal(estimateUsagePercent(fakeSession({ contextWindow: 0 })), null);
});

await test('latestPromptTokens：取最近一条 assistant 的 input + cacheRead', () => {
  const session = fakeSession({
    messages: [
      { role: 'assistant', usage: { input: 1_000, cacheRead: 9_000 } },
      { role: 'assistant', usage: { input: 2_000, cacheRead: 3_000 } },
      { role: 'user', content: 'x' },
    ],
  });
  assert.equal(latestPromptTokens(session), 5_000);
  assert.equal(latestPromptTokens(fakeSession({ messages: [] })), null);
});

await test('★ compactIfNeeded({force:true})：percent 为 null 也照压，且跳过冷却', async () => {
  let compacted = 0;
  const session = fakeSession({
    usage: { percent: null }, messages: [{ role: 'user', content: 'x' }], onCompact: () => { compacted += 1; },
  });
  const entry = { session, compactRetryAfter: Date.now() + 60_000 };
  const out = await compactIfNeeded(fakeRunner({ session }), entry, { name: '小窗模型' }, null, { force: true });
  assert.equal(out.compacted, true, '拿不到占用 + 冷却中，也必须能强制压');
  assert.equal(compacted, 1);
});

await test('★ compactIfNeeded：percent=null 但固定开销+消息已超阈值 → 自动触发压缩', async () => {
  let compacted = 0;
  // 128k 窗口、阈值 60% = 76.8k；这里塞 ~30 万字符 ≈ 7.5 万 token 以上
  const messages = Array.from({ length: 30 }, () => ({ role: 'user', content: '字'.repeat(10_000) }));
  const session = fakeSession({
    contextWindow: 128_000, messages, usage: { percent: null }, onCompact: () => { compacted += 1; },
  });
  const out = await compactIfNeeded(fakeRunner({ session }), { session }, { name: '小窗模型' });
  assert.equal(out.compacted, true, '补盲估计超阈值时必须压：' + out.why);
  assert.equal(compacted, 1);
});

await test('compactIfNeeded：大窗口 + 真实 percent 未到阈值时不压（零扰动）', async () => {
  let compacted = 0;
  const session = fakeSession({
    contextWindow: 1_000_000, messages: [{ role: 'user', content: 'x' }],
    usage: { percent: 12 }, onCompact: () => { compacted += 1; },
  });
  const out = await compactIfNeeded(fakeRunner({ session }), { session }, { name: '大窗模型' });
  assert.equal(out.compacted, false);
  assert.equal(compacted, 0);
});

// ---------------------------------------------------------------------------
// 3. 抢救：压缩 + 续答一次 / 给出截断提示
// ---------------------------------------------------------------------------

await test('★ 截断 + 逼近上限：先强制压缩、再续答一次；续答成功后不再出提示', async () => {
  const calls = [];
  const facts = [{ stopReason: 'length', hadText: false, promptTokens: 124_339, contextWindow: 128_000 }];
  const runner = fakeRunner({
    compact: async (entry, bot, roomId, opts) => { calls.push(['compact', opts?.force]); return { compacted: true }; },
  });
  const session = fakeSession({ onPrompt: (text) => calls.push(['prompt', text]) });
  const out = await recoverFromLengthTruncation({
    runner, entry: { session }, bot: { name: '小窗模型' }, roomId: null,
    facts: () => {
      const hit = facts.length > 1 ? facts.shift() : facts[0];
      return hit;
    },
    log: () => {},
  });
  assert.equal(calls[0]?.[0], 'compact');
  assert.equal(calls[0]?.[1], true, '必须是 force 压缩');
  assert.equal(calls[1]?.[0], 'prompt');
  assert.equal(calls[1]?.[1], LENGTH_RESUME_PROMPT);
  assert.equal(out.notice, true, 'facts 没变化（续答仍判截断）→ 仍然要提示');
});

await test('★ 截断 + 离上限还很远：不压缩不续答，直接给提示', async () => {
  const calls = [];
  const out = await recoverFromLengthTruncation({
    runner: fakeRunner({ compact: async () => { calls.push('compact'); return {}; } }),
    entry: { session: fakeSession({ onPrompt: () => calls.push('prompt') }) },
    bot: { name: 'x' },
    facts: () => ({ stopReason: 'length', hadText: false, promptTokens: 10_000, contextWindow: 128_000 }),
    log: () => {},
  });
  assert.deepEqual(calls, [], '不逼近上限不该白跑压缩/续答');
  assert.equal(out.notice, true);
});

await test('截断 + 压缩抛错：不升级成失败，仍然给提示', async () => {
  const out = await recoverFromLengthTruncation({
    runner: fakeRunner({ compact: async () => { throw new Error('压缩超时'); } }),
    entry: { session: fakeSession() },
    bot: { name: 'x' },
    facts: () => ({ stopReason: 'length', hadText: false, promptTokens: 120_000, contextWindow: 128_000 }),
    log: () => {},
  });
  assert.equal(out.notice, true);
  assert.equal(out.rescued, false);
});

await test('没被截断时完全零副作用（既有行为不变）', async () => {
  const calls = [];
  const out = await recoverFromLengthTruncation({
    runner: fakeRunner({ compact: async () => { calls.push('compact'); return {}; } }),
    entry: { session: fakeSession({ onPrompt: () => calls.push('prompt') }) },
    facts: () => ({ stopReason: 'end_turn', hadText: true, promptTokens: 100, contextWindow: 128_000 }),
    log: () => {},
  });
  assert.deepEqual(calls, []);
  assert.equal(out.notice, false);
});

// ---------------------------------------------------------------------------
// 4. 源码守卫：turn-executor 真的接上了（行预算紧，接线在两处不能漏）
// ---------------------------------------------------------------------------

await test('★ turn-executor 接线：message_end 记录 stopReason，收尾调抢救模块', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(import.meta.dirname, '..', 'src', 'runner', 'turn-executor.js');
  const srcText = fs.readFileSync(file, 'utf8');
  assert.match(srcText, /lastStopReason = event\.message\?\.stopReason/, '要记下最后一条 assistant 的结束原因');
  assert.match(srcText, /lastAssistantHadText/, '要记下这条有没有正文');
  assert.match(srcText, /recoverFromLengthTruncation\(/, '收尾必须接上抢救模块');
  assert.match(srcText, /LENGTH_NOTICE/, '抢救失败时要在正文末尾追加提示');
  // ★ 复审 P0：import 了却没调用、L721 写死 { max: 5 }，导致每次注入都抛
  //   `ReferenceError: skillBudget` 并被 catch 静默吞掉 —— 技能库等于失效。
  assert.match(srcText, /skillBudgetForContext\(/, '技能注入要真的调用按窗口给预算的函数');
  assert.match(srcText, /max: skillBudget\.max/, '挑几条要用预算里的 max，不能再写死 5');
  assert.match(srcText, /maxChars: skillBudget\.maxChars/, '截断字数要用预算里的 maxChars');
  assert.equal(/selectSkillsFor\(library, task, \{ max: 5 \}\)/.test(srcText), false, '写死 5 的老写法必须消失');
  // ★ 真机 UX：偶尔空回复被兜底重试补齐后，以前会往正文末尾拼一句
  //   「_（原模型首次没出内容，已自动重试）_」—— 既违背「中途重试尽量无感」，
  //   又会把这句痕迹写进后续上下文。现在只记日志与 meta。
  assert.doesNotMatch(srcText, /原模型首次没出内容/, '不能再往正文里拼「已自动重试」的尾巴');
  assert.doesNotMatch(srcText, /已自动重试）_/, '「已自动重试」正文必须消失');
  assert.match(srcText, /emptyRecovered \? \{ emptyRecovered: true \}/, '兜底重试补齐过要记进 meta（界面可据此打点，不改正文）');
  // ★ 复审 P1：兜底已经补齐结论（emptyRecovered）时不能再挂"本轮被截断"
  assert.match(srcText, /if \(lengthNotice && !emptyRecovered\)/, 'LENGTH_NOTICE 要排除"已恢复出完整结论"');
  // ★ 复审 P1：明确的上游错误优先抛出（不先强压续答）
  const posFailure = srcText.indexOf('if (responseFailure) throw new Error(responseFailure.error);');
  const posRecover = srcText.indexOf('recoverFromLengthTruncation({');
  assert.ok(posFailure > 0 && posRecover > 0 && posFailure < posRecover, 'responseFailure 要先于长度抢救');
  // ★ 复审 P1：普通空回复不重排 fallbackModels（只有真被截断才按窗口降序）
  assert.match(srcText, /models: lengthNotice\r?\n\s*\?/, 'fallbackModels 的排序要挂在 lengthNotice 上');
  // 行预算红线
  const lines = srcText.split(/\r?\n/).length;
  assert.ok(lines <= 1350, `turn-executor.js 超出 1350 行预算：${lines}`);
  assert.equal(SMALL_CONTEXT_WINDOW, 128_000);
});

console.log(`\n长度截断止血：${pass}/${pass + fail} 通过`);
if (fail) {
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.err}`);
  process.exit(1);
}
process.exit(0);
