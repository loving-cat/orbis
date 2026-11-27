/**
 * 启动收尾必须**连磁盘上的孤儿房间一起扫**。
 *   node tests/reap-orphan-streaming.mjs
 *
 * 背景（现场证据）：`rooms/` 里的文件数 > `state.rooms` 里的房间数。
 * 房间被删掉之后文件还在（老版本不 unlink），而 `reapStaleStreaming()`
 * 只遍历 `this.messages`（它只从 `state.rooms` 装载）—— 于是这些房间里的
 * `streaming` 消息**重启也收不掉**，永远转圈。
 *
 * 实测现场两个：`dm_5834660d1c3b7f4f`（自检（临时））、`r_x`。
 *
 * 守四条：
 *   ① 活房间里的 streaming 照样收成 error（老行为不能退化）；
 *   ② 孤儿房间文件里的 streaming 也要收成 error，并**写回磁盘**；
 *   ③ 孤儿房间不能被加载进内存（用户删过的房间不许自己冒出来）；
 *   ④ 已经是 done 的消息一个字都不许动。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-reap-orphan-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
});

const { store } = await import('../src/store.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const roomsDir = path.join(fixture, 'rooms');
const roomFile = (id) => path.join(roomsDir, `${id}.json`);
const readRoom = (id) => JSON.parse(fs.readFileSync(roomFile(id), 'utf8'));

// ---- 造现场：一个活房间 + 两个孤儿房间
const bot = store.createBot({ name: '收尾工', persona: 'x' });
const live = store.ensureDm(bot.id);

const streamingMsg = (id, { steps = [], text = '' } = {}) => ({
  id,
  roomId: 'x',
  authorType: 'bot',
  authorName: '某个 bot',
  text,
  status: 'streaming',
  steps,
  createdAt: Date.now() - 5000,
  updatedAt: Date.now() - 1000,
  meta: { retrying: true, retryPlaceholder: true },
});

// 活房间：一条 streaming + 一条已经 done 的
store.appendMessage({ roomId: live.id, authorType: 'bot', authorName: '收尾工', text: '', status: 'streaming' });
store.appendMessage({ roomId: live.id, authorType: 'bot', authorName: '收尾工', text: '已经答完了', status: 'done' });
store.saveNow();

// 两个孤儿房间：文件在，state 里没有
for (const orphanId of ['dm_5834660d1c3b7f4f', 'r_x']) {
  fs.writeFileSync(
    roomFile(orphanId),
    JSON.stringify([
      streamingMsg(`m_${orphanId}_1`, {
        steps: [{ name: 'bash', status: 'running', startedAt: Date.now() - 3000 }],
      }),
      // 已完成的，不该被改
      { id: `m_${orphanId}_done`, authorType: 'bot', authorName: 'x', text: '历史消息', status: 'done', steps: [] },
    ]),
  );
}

const doneBefore = readRoom('dm_5834660d1c3b7f4f')[1];

await test('① 活房间里的 streaming 收成 error', () => {
  const reaped = store.reapStaleStreaming();
  assert.ok(reaped >= 1, `应该至少收了 1 条，实际 ${reaped}`);
  const msgs = store.listMessages(live.id, { limit: 50 });
  const spinning = msgs.filter((m) => m.status === 'streaming' || m.status === 'retrying');
  assert.equal(spinning.length, 0, `活房间还有 ${spinning.length} 条在转圈`);
  const errored = msgs.find((m) => m.status === 'error');
  assert.ok(errored?.error?.includes('服务端重启'), `错误文案不对：${errored?.error}`);
});

await test('② 孤儿房间文件里的 streaming 也收掉，并写回磁盘', () => {
  for (const orphanId of ['dm_5834660d1c3b7f4f', 'r_x']) {
    const msgs = readRoom(orphanId);
    const spinning = msgs.filter((m) => m.status === 'streaming' || m.status === 'retrying');
    assert.equal(spinning.length, 0, `${orphanId} 还有 ${spinning.length} 条在转圈`);
    const fixed = msgs.find((m) => m.id === `m_${orphanId}_1`);
    assert.equal(fixed.status, 'error', `${orphanId} 里的 streaming 没被收`);
    assert.ok(fixed.error?.includes('本轮中断'), `错误文案不对：${fixed.error}`);
    assert.equal(fixed.meta.retrying, false, 'retrying 标记没清掉，界面还会画重试中');
    // 工具行也要落地
    assert.equal(fixed.steps[0].status, 'error', '卡住的工具行没收敛，客户端会一直转圈');
  }
});

await test('③ 孤儿房间不许被加载进内存（用户删过的房间不能自己回来）', () => {
  assert.equal(store.getRoom('dm_5834660d1c3b7f4f'), null, '孤儿房间被塞进了 state');
  assert.equal(store.messages.has('dm_5834660d1c3b7f4f'), false, '孤儿房间被塞进了内存消息表');
});

await test('④ 已经 done 的消息一个字都不动（含 updatedAt）', () => {
  const after = readRoom('dm_5834660d1c3b7f4f')[1];
  assert.equal(after.status, 'done');
  assert.equal(after.text, doneBefore.text);
  assert.equal(after.updatedAt, doneBefore.updatedAt, 'done 的消息不该被 touch');
});

await test('⑤ 第二次跑是幂等的（不会反复改写）', () => {
  const before = readRoom('r_x')[0].updatedAt;
  const n = store.reapStaleStreaming();
  assert.equal(n, 0, `已经没有残留，不该再收，实际收了 ${n}`);
  assert.equal(readRoom('r_x')[0].updatedAt, before, '不该重复 touch');
});

let failed = 0;
console.log('\n================ 孤儿房间 streaming 收尾 ================');
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else {
    failed++;
    console.log(`✗ ${r.name}\n     ${r.err}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
fs.rmSync(fixture, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
