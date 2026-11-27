/**
 * 压缩期间（`entry.compactingOnly`）用户补发消息：**等压缩完自动续跑**，不许假叫停。
 *   node tests/compaction-wait.mjs
 *
 * ## Mac 实机现场
 *
 * 1. 群里 Bot 正在 `compactIfNeeded`（649k 上下文，30~60s，`entry.busy && entry.compactingOnly`）；
 * 2. 用户补发一句 → 旧轮被 abort、新轮入队；新轮跑到派发闸门时压缩还在跑；
 * 3. 旧代码把"它在忙"当成 `plan.kind === 'interrupt'`，对**正在压缩的会话** `steer()`
 *    一句「已让 XXX 停下，按你的新要求重来」，然后 `continue` 结束本轮；
 * 4. 压缩结束那一刻 `memory-compactor` 的 finally 会 `session.abort()` —— 刚 steer 进去的
 *    新要求连同这一轮一起没了。用户看到的是「点了发送，什么都没发生」，只能人工重发。
 *
 * 这里从 `executeGroupRound` 这一层验证修好之后的行为（真实 store + 真实 PiRunner，
 * 只把 `runner.run` 与会话换成桩）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-compaction-wait-'));
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
globalThis.fetch = () => { throw new Error('test forbids network'); };

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { executeGroupRound, interruptRoundForUser } = await import('../src/runner/group-orchestrator.js');

const model = { provider: 'fixture', id: 'fixture', contextWindow: 16000, maxTokens: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail += 1;
  }
}

/**
 * 造一个「负责人 + 组员」的部门，并让组员处于**压缩中**：
 * `entry.busy === true && entry.compactingOnly === true`。
 */
function setup({ compacting = true, busy = true } = {}) {
  const lead = store.createBot({ name: '负责人', role: 'lead', persona: '测试' });
  const member = store.createBot({ name: '组员', role: 'member', persona: '测试' });
  const room = store.createGroup({ name: '测试部门', botIds: [member.id, lead.id], leadBotId: lead.id });
  const runner = new PiRunner();
  runner.model = model;
  // 这一轮不该向模型问「要不要回复」
  runner.modelRuntime = { completeSimple: () => assert.fail('这一轮不该问模型要不要回复') };

  const steers = [];
  const followUps = [];
  const entry = {
    busy,
    compactingOnly: compacting,
    turnController: { abort() {} },
    session: {
      sessionFile: null,
      steer: async (text) => { steers.push(text); },
      followUp: async (text) => { followUps.push(text); },
      abort: async () => {},
      subscribe: () => () => {},
    },
  };
  runner.sessions.set(`${room.id}:${member.id}`, entry);

  const runs = [];
  runner.run = async (roomId, botId, prompt) => {
    runs.push({ botId, prompt });
    return { ok: true, text: '收到，我按新要求做', ms: 1, messageId: '' };
  };
  return { runner, room, lead, member, entry, runs, steers, followUps };
}

const say = (room, text) => store.appendMessage({
  roomId: room.id, authorType: 'user', authorName: '用户', text, status: 'done',
});
const userVisible = (roomId) => store.listMessages(roomId)
  .filter((m) => m.authorType === 'system')
  .map((m) => ({ text: m.text ?? '', via: m.meta?.via ?? null, botId: m.meta?.botId ?? null }));

await test('★ 压缩中补发：不 steer、不发「已让…停下」，发 waiting_compaction 提示后自动续跑', async () => {
  const { runner, room, member, entry, runs, steers, followUps } = setup();
  const openerText = `@${member.name} 帮我看下这个报错`;
  const opener = say(room, openerText);

  // 压缩在 300ms 后结束（轮询间隔 200ms，所以会在 ~400ms 时退出等待）
  const timer = setTimeout(() => { entry.compactingOnly = false; entry.busy = false; }, 300);
  try {
    await executeGroupRound(runner, room.id, { openerText, openerMessageId: opener.id, openerName: '用户' });
  } finally {
    clearTimeout(timer);
  }

  assert.deepEqual(steers, [], '压缩期间绝不能 steer（新要求会被压缩收尾的 session.abort() 冲掉）');
  assert.deepEqual(followUps, [], '压缩期间也不该 followUp（同样会被 abort 吞掉）');

  const notices = userVisible(room.id);
  const waiting = notices.find((m) => m.via === 'waiting_compaction');
  assert.ok(waiting, '要发一条 waiting_compaction 系统提示');
  assert.match(waiting.text, /正在整理上下文/, `提示文案不对：${waiting.text}`);
  assert.match(waiting.text, /无需重复发送/, '要明确告诉用户不用重发');
  assert.equal(waiting.botId, member.id, '关联 bot 记在 meta.botId');
  assert.equal(
    notices.some((m) => /已让.*停下/.test(m.text)),
    false,
    '绝不能出现「已让…停下」的假叫停回执',
  );

  assert.equal(runs.length, 1, '压缩完成后要自动把用户的新要求跑起来（零人工介入）');
  assert.equal(runs[0].botId, member.id);
  assert.match(String(runs[0].prompt), /帮我看下这个报错/, `新一轮要带用户的新要求：${runs[0].prompt}`);
});

await test('★ 等待期间用户又插一句（stale）→ 立刻让出，不抢跑去派', async () => {
  const { runner, room, member, entry, runs } = setup();
  const openerText = `@${member.name} 先看这个`;
  const opener = say(room, openerText);

  const pending = executeGroupRound(runner, room.id, {
    openerText, openerMessageId: opener.id, openerName: '用户',
  });
  await sleep(250); // 让它进到等待循环里
  interruptRoundForUser(runner, room.id); // 用户又插了一句：代数 +1，旧的等待必须让位
  entry.compactingOnly = false;
  entry.busy = false;
  await pending;

  assert.equal(runs.length, 0, '被更新的消息顶掉后，这一轮不许再派（否则会和新的那轮打架）');
});

await test('普通忙（没在压缩）仍然走老的 steer 路径 —— 这次修复不许把正常叫停改坏', async () => {
  const { runner, room, member, runs, steers } = setup({ compacting: false, busy: true });
  const openerText = `@${member.name} 换个做法`;
  const opener = say(room, openerText);

  await executeGroupRound(runner, room.id, { openerText, openerMessageId: opener.id, openerName: '用户' });

  assert.equal(steers.length, 1, '没在压缩时，用户叫停仍然要 steer 进去（旧行为）');
  assert.match(steers[0], /用户叫停/, 'steer 文案还是用户叫停');
  assert.equal(runs.length, 0, 'steer 之后本轮结束（不等它再派一次）');
  const notices = userVisible(room.id);
  assert.ok(notices.some((m) => m.via === 'steer_by_user'), '仍然要有叫停回执');
  assert.equal(member.id, notices.find((m) => m.via === 'steer_by_user')?.botId, '回执要把 bot 记在 meta.botId');
});

await test('系统回执一律不填 authorId（绝不冒充 Bot 本人发言）', () => {
  const file = path.join(import.meta.dirname, '..', 'src', 'runner', 'group-orchestrator.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(
    /authorType: 'system',\s*\n\s*authorId: bot\.id/.test(text),
    false,
    '系统回执不能带 authorId: bot.id（App 会据此画 Bot 头像/负责人徽章）',
  );
  assert.match(text, /via: 'waiting_compaction', botId: bot\.id/, '等待压缩提示要带 meta.botId');
});

console.log(`\n压缩期间续跑：${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
process.exit(0);
