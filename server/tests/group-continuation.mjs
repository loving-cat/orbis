/**
 * 群聊续段（continuation）测试。
 *
 * 背景：非受管群聊里，某一段跑到时间片上限时本轮还没做完 —— 以前直接收住，
 * 活停在半路，要靠用户再去私聊里派一遍。现在的行为是：把**同一个 bot**
 * 重新排进本轮队列继续做下一段，并给它一段「接着上一段做」的提示词。
 *
 * 这里用真实 store + 真实 PiRunner，只把 `runner.run` 换成桩，
 * 从 `executeGroupRound` 这一层验证行为（不是测一个纯函数）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-group-cont-'));
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
const { executeGroupRound } = await import('../src/runner/group-orchestrator.js');
const { GROUP_LIMITS_DEFAULT } = await import('../src/store.js');

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

/** 造一个「负责人 + 一名组员」的部门，返回可打桩的 runner。 */
function setup({ memberTurns = GROUP_LIMITS_DEFAULT.memberTurns } = {}) {
  store.updateGroupLimits({
    memberTurns,
    leadTurns: GROUP_LIMITS_DEFAULT.leadTurns,
  });
  const lead = store.createBot({ name: '负责人', role: 'lead', persona: '测试' });
  const member = store.createBot({ name: '组员', role: 'member', persona: '测试' });
  const room = store.createGroup({
    name: '测试部门',
    botIds: [member.id, lead.id],
    leadBotId: lead.id,
  });
  const runner = new PiRunner();
  runner.model = model;
  // 这一轮不该向模型问「要不要回复」：续段条目本来就该直接派
  runner.modelRuntime = {
    completeSimple: () => assert.fail('这一轮不该问模型要不要回复'),
  };
  const calls = [];
  runner.run = async (roomId, botId, prompt) => {
    calls.push({ botId, prompt });
    const nth = calls.filter((c) => c.botId === botId).length;
    // 组员第一次只做了一半就撞到时间片上限
    if (botId === member.id && nth === 1) {
      return {
        ok: true,
        text: '先做了一半，剩下的接着做',
        messageId: '',
        continuation: { reason: 'time' },
      };
    }
    return { ok: true, text: '做完了', ms: 1, messageId: '' };
  };
  return { runner, room, lead, member, calls };
}

const mention = (name) => `@${name} 把这件事做完`;

/** 用户的发言得先进房间（真实链路里就是这样），否则续段的提示词里没有原始任务。 */
function say(room, text) {
  return store.appendMessage({
    roomId: room.id,
    authorType: 'user',
    authorName: '用户',
    text,
    status: 'done',
  });
}

await test('组员这一段到点 → 它自己被重新排进本轮队列并接着做', async () => {
  const { runner, room, member, calls } = setup();
  const openerText = mention(member.name);
  const opener = say(room, openerText);
  await executeGroupRound(runner, room.id, {
    openerText,
    openerBotId: null,
    openerMessageId: opener.id,
  });

  const mine = calls.filter((c) => c.botId === member.id);
  assert.equal(mine.length, 2, '撞到时间片上限后必须再排一段，不能停在半路');
  assert.match(mine[1].prompt, /【系统·续段】/, '续段提示词要标明这是接着上一段');
  assert.match(mine[1].prompt, /接着上一段继续做/, '续段提示词要说明接着做');
  assert.match(mine[1].prompt, /不要从头再来/, '续段提示词要禁止重做已经做完的步骤');
  assert.match(mine[1].prompt, /接着做上一段没做完的/, '续段这一条要沿用原来那条的来历');
});

await test('续段跳过「要不要回复」判定（不向模型问、也不被跳过）', async () => {
  // setup 里把 completeSimple 换成了 assert.fail：只要走了 should-reply 判定就会红
  const { runner, room, member, calls } = setup();
  const openerText = mention(member.name);
  const opener = say(room, openerText);
  await executeGroupRound(runner, room.id, {
    openerText,
    openerBotId: null,
    openerMessageId: opener.id,
  });
  assert.equal(calls.filter((c) => c.botId === member.id).length, 2);
});

await test('续段占它自己这一轮的发言预算：memberTurns=1 时不再排第二段', async () => {
  const { runner, room, member, calls } = setup({ memberTurns: 1 });
  const openerText = mention(member.name);
  const opener = say(room, openerText);
  await executeGroupRound(runner, room.id, {
    openerText,
    openerBotId: null,
    openerMessageId: opener.id,
  });

  const mine = calls.filter((c) => c.botId === member.id);
  assert.equal(mine.length, 1, '预算只够一次发言，续段不能再跑');

  const skipped = (store.messages.get(room.id) ?? [])
    .filter((m) => m?.meta?.via === 'turn_budget_skip' && m?.meta?.botId === member.id);
  assert.equal(skipped.length, 1, '应该留一条「本轮预算用完」的调度提示');
  assert.match(skipped[0].text, /本轮已发言 1 次（上限 1 次）/);
});

await test('第二段没说「还没做完」→ 不再无限续段', async () => {
  const { runner, room, member, calls } = setup();
  const openerText = mention(member.name);
  const opener = say(room, openerText);
  await executeGroupRound(runner, room.id, {
    openerText,
    openerBotId: null,
    openerMessageId: opener.id,
  });
  assert.equal(
    calls.filter((c) => c.botId === member.id).length,
    2,
    '第二段正常收尾就该停，不能一直排队',
  );
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
