/**
 * `ask_user` 的默认值语义：默认**不停下来等**。
 *
 * 长任务最常见的停摆就是「弹了张卡片，然后一直等」——用户不在旁边，
 * 一张卡能让整件事停一整夜。所以默认先按 defaultOption（不写就第一个）接着做，
 * 只有 blocking=true 才真的等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-ask-default-'));
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: path.join(root, 'workspace'),
  ORBIS_PROBE: '0',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.mkdirSync(process.env.ORBIS_WORKSPACE, { recursive: true });

const { store } = await import('../src/store.js');
const { buildCommonTools } = await import('../src/tools.js');

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

const bot = store.createBot({ name: '助手', role: 'member', persona: '测试' });
const dm = store.ensureDm(bot.id);
const askTool = () =>
  buildCommonTools({ runner: {}, roomId: dm.id, botId: bot.id }).find((t) => t.name === 'ask_user');

const textOf = (res) => res.content.map((c) => c.text).join('');
const lastCard = () => store.listMessages(dm.id, { limit: 1 })[0];

await test('默认不停下来等：meta 带 defaultOption（第一个选项）', async () => {
  const res = await askTool().execute('c1', {
    question: '先做哪个？',
    options: [{ label: '方案 A' }, { label: '方案 B' }],
  });

  assert.equal(res.isError, undefined);
  assert.equal(res.details.defaultOption, '方案 A', '不写就按第一个');
  assert.equal(res.details.blocking, undefined, '默认不该阻塞');
  assert.match(textOf(res), /不要停下来等/, '返回文案要明确叫它继续做');

  const card = lastCard();
  assert.equal(card.kind, 'ask');
  assert.equal(card.meta.defaultOption, '方案 A', '卡片要带上「先按哪个做的」');
  assert.equal(card.meta.blocking, undefined);
});

await test('defaultOption 非法（卡片上没这个选项）→ 回落第一个', async () => {
  const res = await askTool().execute('c2', {
    question: '走哪条路？',
    options: [{ label: '甲' }, { label: '乙' }],
    defaultOption: '丙',
  });

  assert.equal(res.details.defaultOption, '甲');
  assert.match(textOf(res), /按「甲」/);
  assert.equal(lastCard().meta.defaultOption, '甲');
});

await test('defaultOption 合法就用它（不是永远第一个）', async () => {
  const res = await askTool().execute('c3', {
    question: '走哪条路？',
    options: [{ label: '甲' }, { label: '乙' }],
    defaultOption: '乙',
  });

  assert.equal(res.details.defaultOption, '乙');
  assert.match(textOf(res), /按「乙」/);
  assert.equal(lastCard().meta.defaultOption, '乙');
});

await test('blocking=true：真的停下来等，且不再带默认选项', async () => {
  const res = await askTool().execute('c4', {
    question: '要删掉这个目录吗？',
    options: [{ label: '删' }, { label: '先不删' }],
    blocking: true,
  });

  assert.equal(res.details.blocking, true);
  assert.equal(res.details.defaultOption, undefined, '停下来等的时候没有「先按哪个做」');
  assert.match(textOf(res), /停在这里/);

  const card = lastCard();
  assert.equal(card.meta.blocking, true);
  assert.equal(card.meta.defaultOption, undefined);
});

await test('能把「默认不停」和「停下来等」说成一句话给模型看', async () => {
  // 两段文案必须能区分，否则模型只会照抄其中一句
  const idle = await askTool().execute('c5', { question: 'q', options: [{ label: 'x' }] });
  const blocked = await askTool().execute('c6', {
    question: 'q',
    options: [{ label: 'x' }],
    blocking: true,
  });
  assert.notEqual(textOf(idle), textOf(blocked));
  assert.doesNotMatch(textOf(idle), /停在这里/);
  assert.doesNotMatch(textOf(blocked), /不要停下来等/);
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
