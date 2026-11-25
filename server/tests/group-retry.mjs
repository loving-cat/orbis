/**
 * 群聊上游故障（429 / 5xx / 熔断）不丢活：分钟级退避 + 自动续派。
 *
 * 以前这里直接落「[这单断了] …请重新发送任务」——把「系统暂时不健康」
 * 变成「用户的活没了」。现在的行为：
 *   · 不持锁等待（`runner.roundLocks` 立刻释放）；
 *   · 到期复核 `aborting` / 轮次代数，作废的不发（不发幽灵续派）；
 *   · 累计等待有上限，超了如实失败。
 *
 * 定时器全部注入（毫秒级），测试不真等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-group-retry-'));
const wsDir = path.join(root, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: wsDir,
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
  ORBIS_TASK_INTAKE: '0',
  ORBIS_WATCH_CHANGES: '0',
  ORBIS_AUTO_ATTACH: '0',
  ORBIS_AUTO_ATTACH_FILES: '0',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('test forbids network');
};

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const {
  executeGroupRound,
  dispatchGroupRound,
  interruptRoundForUser,
  roundEpoch,
} = await import('../src/runner/group-orchestrator.js');
const {
  retrySchedulerFor,
  isUpstreamTransient,
  nextRetryDelay,
  describeWait,
  cancelGroupRetries,
} = await import('../src/runner/group-retry.js');

const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

/** 假的定时器：不真等，测试手动 fire。 */
function fakeTimers() {
  const list = [];
  const setTimer = (fn, ms) => {
    const token = { fn, ms, cleared: false };
    list.push(token);
    return token;
  };
  const clearTimer = (token) => {
    if (token) token.cleared = true;
  };
  return {
    setTimer,
    clearTimer,
    /** 还有几个活着的定时器 */
    alive: () => list.filter((t) => !t.cleared).length,
    /** 到点：跑所有活着的回调（跑过就作废，别重复触发），返回它们的返回值（可 await） */
    fire: () => {
      const alive = list.filter((t) => !t.cleared);
      for (const t of alive) t.cleared = true;
      return alive.map((t) => t.fn());
    },
    list,
  };
}

function setup({ ladder = [10], maxTotalMs = 60_000, fail = null } = {}) {
  const lead = store.createBot({ name: '负责人', role: 'lead', persona: '测试' });
  const member = store.createBot({ name: '组员', role: 'member', persona: '测试' });
  const room = store.createGroup({
    name: '上游测试部门',
    botIds: [member.id, lead.id],
    leadBotId: lead.id,
  });
  store.updateGroupLimits({ memberTurns: 15, leadTurns: 15 });

  const runner = new PiRunner();
  runner.model = model;
  runner.modelRuntime = { completeSimple: () => assert.fail('这一轮不该问模型要不要回复') };

  const timers = fakeTimers();
  const scheduler = retrySchedulerFor(runner, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ladder,
    maxTotalMs,
  });

  const calls = [];
  runner.run = async (roomId, botId, prompt) => {
    calls.push({ botId, prompt });
    if (fail) return fail(botId, calls);
    return { ok: true, text: '做完了', ms: 1, messageId: '' };
  };

  const openerText = `@${member.name} 把这件事做完`;
  const opener = store.appendMessage({
    roomId: room.id,
    authorType: 'user',
    authorName: '用户',
    text: openerText,
    status: 'done',
  });
  return { runner, room, lead, member, calls, timers, scheduler, openerText, opener };
}

const upstreamFail = () => ({
  ok: false,
  text: '',
  ms: 0,
  error: '429 上游限流：Rate limit exceeded',
  status: 429,
  breakerSkipped: true,
});

const msgs = (roomId) => store.messages.get(roomId) ?? [];
const viaCount = (roomId, via) =>
  msgs(roomId).filter((m) => m?.meta?.via === via).length;

await test('判定：429 / 5xx / 熔断 / 网络瞬断算瞬时；401/403/402 不算', () => {
  assert.equal(isUpstreamTransient({ status: 429 }), true);
  assert.equal(isUpstreamTransient({ status: 503 }), true);
  assert.equal(isUpstreamTransient({ kind: 'breaker-open' }), true);
  assert.equal(isUpstreamTransient({ error: 'socket hang up' }), true);
  assert.equal(isUpstreamTransient({ status: 401 }), false, '身份问题等一下也不会好');
  assert.equal(isUpstreamTransient({ status: 403 }), false);
  assert.equal(isUpstreamTransient({ status: 402 }), false);
  assert.equal(isUpstreamTransient({ error: '参数不合法' }), false);
});

await test('阶梯：1→2→5→10 分钟封顶，累计超上限返回 null', () => {
  const ladder = [60_000, 120_000, 300_000, 600_000];
  assert.equal(nextRetryDelay({ attempt: 0, ladder }), 60_000);
  assert.equal(nextRetryDelay({ attempt: 1, ladder }), 120_000);
  assert.equal(nextRetryDelay({ attempt: 3, ladder }), 600_000);
  assert.equal(nextRetryDelay({ attempt: 9, ladder }), 600_000, '阶梯到顶就停在最长那一档');
  assert.equal(nextRetryDelay({ attempt: 0, ladder, waitedMs: 3_600_000, maxTotalMs: 3_600_000 }), null);
  assert.equal(describeWait(60_000), '1 分钟');
  assert.equal(describeWait(1500), '2 秒');
});

await test('① 429 失败 → 排期（不持锁）、到期自动续派成功', async () => {
  const { runner, room, member, calls, timers, scheduler, openerText } = setup({ fail: upstreamFail });

  await executeGroupRound(runner, room.id, {
    openerText,
    openerBotId: null,
    openerMessageId: null,
  });

  assert.equal(runner.roundLocks.has(room.id), false, '排队等待期间绝不能占着房间锁');
  assert.equal(viaCount(room.id, 'upstream_retry_scheduled'), 1, '群里要留一条「X 分钟后自动接着做」');
  assert.equal(viaCount(room.id, 'failed'), 0, '不该再落失败回执');
  assert.equal(timers.alive(), 1, '应该挂了一个续派定时器');
  assert.ok(scheduler.pending(room.id));
  const note = msgs(room.id).find((m) => m?.meta?.via === 'upstream_retry_scheduled');
  assert.match(note.text, /自动接着做/);
  assert.match(note.text, /不用重新发送任务/);

  // 到期：上游好了，续派应该真的把活接着跑下去
  const { member: m } = { member };
  const before = calls.filter((c) => c.botId === m.id).length;
  runner.run = async (roomId2, botId) => {
    calls.push({ botId, prompt: '' });
    return { ok: true, text: '这次做完了', ms: 1, messageId: '' };
  };
  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 30));

  const after = calls.filter((c) => c.botId === m.id).length;
  assert.ok(after > before, '续派必须真的重新派一轮，而不是只留一条提示');
  assert.equal(viaCount(room.id, 'upstream_retry_fire'), 1);
  assert.equal(runner.roundLocks.has(room.id), false, '续派跑完也要把锁放掉');
});

await test('② 等待期间用户插话 → 定时器取消，不发幽灵续派', async () => {
  const { runner, room, member, calls, timers, openerText } = setup({ fail: upstreamFail });

  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });
  assert.equal(timers.alive(), 1, '前置：已挂起续派');

  interruptRoundForUser(runner, room.id);
  assert.equal(timers.alive(), 0, '用户插话必须把挂起的续派取消掉');

  const before = calls.length;
  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, before, '取消之后不能再偷偷跑一轮');
  assert.equal(viaCount(room.id, 'upstream_retry_fire'), 0);
});

await test('②b 用户终止（abort）→ 定时器取消', async () => {
  const { runner, room, timers, openerText } = setup({ fail: upstreamFail });

  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });
  assert.equal(timers.alive(), 1);

  await runner.abort(room.id);
  assert.equal(timers.alive(), 0, 'abort 必须把挂起的续派取消掉');
  assert.equal(runner.aborting.has(room.id), true);
});

await test('②c 到期时轮次代数变了（先前插话过）→ 作废不发', async () => {
  const { runner, room, calls, timers, openerText } = setup({ fail: upstreamFail });
  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });

  // 只 bump 代数、不经过 cancelGroupRetries：模拟「取消没赶上」的最坏情况，
  // 到期复核必须自己挡住。
  const captured = timers.list.filter((t) => !t.cleared);
  runner.roundEpochs.set(room.id, (runner.roundEpochs.get(room.id) ?? 0) + 1);
  const before = calls.length;
  await Promise.allSettled(captured.map((t) => t.fn()));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, before, '代数变了就不该续派');
});

await test('③ 多轮续派仍 429 → 延迟按阶梯递增（10 → 20），到上限才失败', async () => {
  // 阶梯 10ms / 20ms，上限 35ms：10（剩 25）→ 20（剩 5）→ 第三次排不下 → 放弃
  const { runner, room, timers, scheduler, openerText } = setup({
    ladder: [10, 20],
    maxTotalMs: 35,
    fail: upstreamFail,
  });
  const ep = () => runner.roundEpochs.get(room.id) ?? 0;

  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });
  assert.equal(viaCount(room.id, 'upstream_retry_scheduled'), 1);
  assert.equal(timers.list[0].ms, 10, '第一档 10ms');

  // 第一次续派：还是 429
  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(viaCount(room.id, 'upstream_retry_scheduled'), 2);
  assert.equal(timers.list.at(-1).ms, 20, '第二档 20ms（累计没被 fire 清掉）');

  // 第二次续派：还是 429 → 10+20=30，再排 20 会超 35 → 放弃
  const epochBefore = ep();
  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(viaCount(room.id, 'upstream_retry_scheduled'), 2, '到上限不该再排');
  assert.equal(viaCount(room.id, 'failed'), 1, '到上限要如实落失败回执');
  const receipt = msgs(room.id).find((m) => m?.meta?.via === 'failed');
  assert.match(String(receipt.text), /这单断了|重新发送任务/);
  assert.equal(scheduler.pending(room.id), null, '不该留着挂起项');
  assert.equal(scheduler.backoff.has(room.id), false, '到上限要把累计也清掉');
  assert.equal(ep(), epochBefore, '续派本身不该改轮次代数');
});

await test('③ b 续派成功一次后，下一次 429 从第一档重新开始', async () => {
  const { runner, room, calls, timers, scheduler, openerText } = setup({
    ladder: [10, 20],
    maxTotalMs: 35,
    fail: upstreamFail,
  });

  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });
  assert.equal(timers.list[0].ms, 10);

  // 这一轮续派跑通了
  runner.run = async (roomId2, botId) => {
    calls.push({ botId, prompt: '' });
    return { ok: true, text: '做完了', ms: 1, messageId: '' };
  };
  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(scheduler.backoff.has(room.id), false, '跑通后累计要清零');

  // 再抽风一次：应该又是第一档 10ms
  runner.run = async () => upstreamFail();
  const opener2 = store.appendMessage({
    roomId: room.id, authorType: 'user', authorName: '用户', text: openerText, status: 'done',
  });
  await executeGroupRound(runner, room.id, {
    openerText, openerBotId: null, openerMessageId: opener2.id,
  });
  assert.equal(timers.list.at(-1).ms, 10, '成功之后重新从第一档开始');
});

await test('⑤ 续派只催失败的那个成员，不把同波已成功的同事重跑一遍', async () => {
  // 一条消息 @ 了两个人：甲被 429 打回，乙正常交活
  const lead = store.createBot({ name: '负责人', role: 'lead', persona: '测试' });
  const jia = store.createBot({ name: '甲', role: 'member', persona: '测试' });
  const yi = store.createBot({ name: '乙', role: 'member', persona: '测试' });
  const room = store.createGroup({ name: '定向续派组', botIds: [jia.id, yi.id, lead.id], leadBotId: lead.id });
  store.updateGroupLimits({ memberTurns: 15, leadTurns: 15 });

  const runner = new PiRunner();
  runner.model = model;
  runner.modelRuntime = { completeSimple: () => assert.fail('这一轮不该问模型要不要回复') };
  const timers = fakeTimers();
  retrySchedulerFor(runner, {
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, ladder: [10], maxTotalMs: 60_000,
  });
  const calls = [];
  runner.run = async (roomId, botId) => {
    calls.push(botId);
    if (botId === jia.id) return upstreamFail();
    return { ok: true, text: '做完了', ms: 1, messageId: '' };
  };

  const openerText = `@${jia.name} @${yi.name} 各做一半`;
  const opener = store.appendMessage({
    roomId: room.id, authorType: 'user', authorName: '用户', text: openerText, status: 'done',
  });
  await executeGroupRound(runner, room.id, { openerText, openerBotId: null, openerMessageId: opener.id });
  assert.equal(calls.filter((id) => id === jia.id).length, 1);
  assert.equal(calls.filter((id) => id === yi.id).length, 1, '前置：乙本来就已经交过一次活');
  assert.equal(timers.alive(), 1);

  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(calls.filter((id) => id === jia.id).length, 2, '失败的甲要被再叫一次');
  assert.equal(
    calls.filter((id) => id === yi.id).length,
    1,
    '续派不许把同波里已经成功的乙再跑一遍（白烧额度、群里重复回复）',
  );
});

await test('④ 身份/参数类失败（401 / 400）走原来的失败回执，不排期', async () => {
  const { runner, room, timers, openerText } = setup({
    fail: () => ({
      ok: false,
      text: '',
      ms: 0,
      error: '401 模型鉴权失败',
      status: 401,
      breakerSkipped: true,
    }),
  });

  await executeGroupRound(runner, room.id, { openerText, openerBotId: null });
  assert.equal(timers.alive(), 0, '401 等一下也不会好，不该排期');
  assert.equal(viaCount(room.id, 'failed'), 1);
});

// ---------------------------------------------------------------------------
// Bug 1（高危）：同一轮 A、B 同时 429，续派键必须按房间+成员独立
// ---------------------------------------------------------------------------

await test('★ 同一轮 A/B 同时 429：两个续派各自保留、各自第 1 档、到期各自触发', async () => {
  const { runner, room, lead, member, timers, scheduler } = setup();
  const epoch = roundEpoch(runner, room.id);
  const fired = [];
  const make = (bot) => scheduler.schedule({
    runner, roomId: room.id, roomName: room.name, botId: bot.id, botName: bot.name, epoch,
    onFire: ({ attempt }) => { fired.push({ botId: bot.id, attempt }); },
  });

  const a = make(lead);
  const b = make(member);
  assert.equal(a.scheduled, true);
  assert.equal(b.scheduled, true);
  assert.equal(a.delay, b.delay, '两条都应是第一档，B 不该把 A 推高');
  assert.equal(timers.alive(), 2, '两个成员必须各留一个定时器（旧实现只剩一个）');
  assert.ok(scheduler.pending(room.id, lead.id), 'A 的续派必须还在');
  assert.ok(scheduler.pending(room.id, member.id), 'B 的续派必须还在');

  await Promise.allSettled(timers.fire());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    fired.map((f) => f.botId).sort(),
    [lead.id, member.id].sort(),
    '两个成员都应在到期时被续派一次（A 的承诺不能失约）',
  );
  assert.ok(fired.every((f) => f.attempt === 1), '都应是第 1 次续派');
});

await test('★ 房间级 cancel 仍能一次清掉该房间下所有成员的续派', async () => {
  const { runner, room, lead, member, timers, scheduler } = setup();
  const epoch = roundEpoch(runner, room.id);
  const make = (bot) => scheduler.schedule({
    runner, roomId: room.id, botId: bot.id, botName: bot.name, epoch, onFire: () => {},
  });
  make(lead);
  make(member);
  assert.equal(timers.alive(), 2);
  assert.equal(cancelGroupRetries(runner, room.id, '用户插话'), true);
  assert.equal(timers.alive(), 0, '房间级 cancel 必须把两个成员一起清掉');
  assert.equal(scheduler.pending(room.id, lead.id), null);
  assert.equal(scheduler.pending(room.id, member.id), null);
});

await test('★ 成员级 cancel 不碰兄弟成员', async () => {
  const { runner, room, lead, member, timers, scheduler } = setup();
  const epoch = roundEpoch(runner, room.id);
  const make = (bot) => scheduler.schedule({
    runner, roomId: room.id, botId: bot.id, botName: bot.name, epoch, onFire: () => {},
  });
  make(lead);
  make(member);
  assert.equal(scheduler.cancel(room.id, '只取消 A', { botId: lead.id }), true);
  assert.equal(timers.alive(), 1, '只该少掉 A 那一条');
  assert.ok(scheduler.pending(room.id, member.id), 'B 的续派必须留着');
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
