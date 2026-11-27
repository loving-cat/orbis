/**
 * 技能注入真的跑通了吗（防"静默 ReferenceError"）。
 *   node tests/skill-injection-live.mjs
 *
 * ## 回归背景（复审打回的 P0）
 *
 * `withSkills()` 里引用了 `skillBudget.maxChars`，却**从来没有声明** `skillBudget` ——
 * `skillBudgetForContext` import 进来后一次都没调用。结果：库里只要有一条命中的技能，
 * 每次注入都抛 `ReferenceError: skillBudget is not defined`，然后被 `catch` 静默吞掉。
 * 表现是「技能库明明有内容，模型却一次也没用上」，日志里只有一行『技能库匹配失败』。
 *
 * 纯函数单测（`skills.mjs`）测不出这种坑：函数本身是对的，是接线断了。
 * 这里跑一次**真实的 `runner.run()`**（假 session），断言技能正文确实进了提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.ORBIS_HOME = path.join(process.cwd(), 'data', '_unit_test_skill_injection');
fs.rmSync(process.env.ORBIS_HOME, { recursive: true, force: true });
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';

const { store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { PiRunner } = await import('../src/pi-runner.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const model = { provider: 'fixture', id: 'model-a', contextWindow: 100_000, reasoning: false, input: ['text'] };

/** 假 session：记下每一次 prompt 的正文，然后回一条正常回答。 */
function fakeSession(prompts) {
  let listener = () => {};
  return {
    model,
    isCompacting: false,
    getContextUsage: () => ({ percent: 10, tokens: 1, contextWindow: model.contextWindow }),
    subscribe(fn) { listener = fn; return () => {}; },
    dispose() {},
    async abort() {},
    async compact() {},
    async prompt(text) {
      prompts.push(String(text));
      listener({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '收到，按技能做。' }], stopReason: 'end_turn' },
      });
    },
  };
}

function isolatedRunner() {
  const runner = new PiRunner();
  runner.__buildSession = async () => assert.fail('fixture must not construct a real SDK session');
  runner.model = model;
  runner.modelRuntime = { completeSimple: async () => ({ role: 'assistant', content: [{ type: 'text', text: '' }] }) };
  return runner;
}

function typingTracker(roomId) {
  const state = new Map();
  const onEvent = (e) => { if (e?.t === 'typing' && e.roomId === roomId) state.set(e.botId, e.active); };
  bus.on('event', onEvent);
  return { stop: () => bus.off('event', onEvent) };
}

/** 一条能被「发布检查」这个任务命中的技能。 */
function skill(title, howto) {
  return { title, summary: '发布前必查', howto, tags: ['发布', '检查'] };
}

await test('★ 命中技能库时真的注入正文（不再静默 ReferenceError）', async () => {
  const added = store.addSkill(skill('发布检查', '1. 跑全量测试\n2. 看门禁'));
  assert.ok(added?.skill?.id, '技能没存进去：' + (added?.error ?? ''));

  const bot = store.createBot({ name: '技能够用', persona: 'x' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const prompts = [];
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session: fakeSession(prompts) });
  const typing = typingTracker(room.id);
  const res = await runner.run(room.id, bot.id, '帮我做发布检查');
  typing.stop();

  assert.equal(res.ok, true, '这一轮应当正常结束：' + (res.error ?? ''));
  assert.equal(prompts.length >= 1, true, '模型应当收到至少一次 prompt');
  const text = prompts[0];
  assert.match(text, /发布检查/, '技能标题没进提示词 —— 技能注入又静默失败了');
  assert.match(text, /跑全量测试/, '技能正文（howto）没进提示词');
  // 注入内容必须放在用户任务之前（技能是参考，不能被当成用户说的话）
  assert.ok(text.indexOf('发布检查') < text.indexOf('帮我做发布检查'), '技能应当在任务正文之前');
});

await test('★ 小窗口模型：技能拦截在 2 条 / 6,000 字以内（真的按 maxChars 截断）', async () => {
  // 每条技能正文上限 4,000 字（SKILL_LIMITS.howto），三条就撑爆 6,000 的预算
  store.state.skills = [];
  const big = '步骤'.repeat(4_000);
  store.addSkill(skill('发布检查二', big));
  store.addSkill(skill('发布检查三', big));
  store.addSkill(skill('发布检查四', big));

  const bot = store.createBot({ name: '小窗', persona: 'x' });
  const room = store.ensureDm(bot.id);
  const runner = isolatedRunner();
  const prompts = [];
  runner.sessions.set(`${room.id}/${bot.id}`, { bot, busy: false, session: fakeSession(prompts) });
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session: fakeSession(prompts) });
  const typing = typingTracker(room.id);
  await runner.run(room.id, bot.id, '帮我做发布检查');
  typing.stop();

  const text = prompts[0] ?? '';
  // 每条技能的头部是「标题（摘要）」，用它来数"到底注入了几条"（标题互相包含容易数错）
  const titleHits = text.match(/（发布前必查）/g) ?? [];
  assert.ok(titleHits.length >= 1, '至少注入一条');
  assert.ok(titleHits.length <= 2, `100k 窗口最多 2 条技能，实际注入 ${titleHits.length} 条`);
  // 技能段整体要在预算内（6,000 字 + 标题/省略说明的余量）
  assert.ok(
    text.length <= 6_000 + 4_000,
    `技能段应当被截断到预算内，实际提示词 ${text.length} 字`,
  );
  assert.match(text, /按上下文预算截断|因当前模型上下文较小未加载/, '被截断/省略时要有可读说明');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed++;
    console.log(`  ✗ ${r.name}\n      ${r.err}`);
  }
}
console.log(`\n技能注入接线：${results.length - failed}/${results.length} 通过`);
fs.rmSync(process.env.ORBIS_HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
