/**
 * 流式期间不重写 `state.json`（SPEC-PERF-V1 §8）。
 *   node tests/store-state-dirty.mjs
 *
 * 守四条：
 *   1. 只改房间消息（`updateMessage` / `moveMessageAfter`）→ `state.json` 一次都不写；
 *   2. `state` 真变了 → 必须写（漏写就是数据丢失）；
 *   3. 写失败**保持 dirty**，下次 `saveNow()` 会重试（不是"先清标记再写"）；
 *   4. `flushNow()` 语义不变：成功之后同样把 dirty 清掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-state-dirty-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
});

const { store } = await import('../src/store.js');

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

const stateFile = path.join(fixture, 'state.json');
const mtime = () => fs.statSync(stateFile).mtimeMs;

const room = store.createGroup({ name: '流式部门', botIds: [store.mainBot().id] });
const msg = store.appendMessage({
  roomId: room.id, authorType: 'bot', authorId: store.mainBot().id, authorName: '甲', text: '开始',
});
store.saveNow(); // 把初始状态写干净
assert.equal(store.stateDirty, false, '前置：落盘后不该还 dirty');

await test('只改消息：saveNow 不写 state.json', async () => {
  const before = mtime();
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 20; i += 1) {
    store.updateMessage(room.id, msg.id, { text: `流式第 ${i} 段` });
    store.saveNow();
  }
  assert.equal(mtime(), before, 'state.json 不该被重写');
  assert.equal(store.stateDirty, false, '纯消息变更不该把 state 标脏');
});

await test('moveMessageAfter 也不写 state.json', async () => {
  const second = store.appendMessage({
    roomId: room.id, authorType: 'bot', authorId: store.mainBot().id, authorName: '甲', text: '第二条',
  });
  store.saveNow();
  const before = mtime();
  await new Promise((r) => setTimeout(r, 30));
  store.moveMessageAfter(room.id, second.id, msg.id);
  store.saveNow();
  assert.equal(mtime(), before, '挪消息顺序不该重写 state.json');
});

await test('state 真变了就必须写（漏写就是数据丢失）', async () => {
  const before = mtime();
  await new Promise((r) => setTimeout(r, 30));
  store.updateBot(store.mainBot().id, { name: '改了名字' });
  assert.equal(store.stateDirty, true, '改了 state 应立即标脏');
  store.saveNow();
  assert.notEqual(mtime(), before, 'state.json 必须被重写');
  assert.equal(store.stateDirty, false, '写成功后清 dirty');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.bots[store.mainBot().id].name, '改了名字', '落盘内容要跟上');
});

await test('scheduleSave({state:false}) 不会把 dirty 置上', async () => {
  store.saveNow();
  assert.equal(store.stateDirty, false);
  store.scheduleSave({ state: false });
  assert.equal(store.stateDirty, false, '纯消息路径不该置 dirty');
  store.scheduleSave(); // 默认 = state 也改了
  assert.equal(store.stateDirty, true, '默认参数必须朝安全一侧偏');
  store.saveNow();
  assert.equal(store.stateDirty, false);
});

await test('写失败保持 dirty，下次重试能补上', async () => {
  store.saveNow();
  const before = mtime();
  await new Promise((r) => setTimeout(r, 30));
  // 把 state.json 换成目录：写入必然失败（rename 到目录上）
  const backup = `${stateFile}.bak`;
  fs.renameSync(stateFile, backup);
  fs.mkdirSync(stateFile);

  store.updateBot(store.mainBot().id, { name: '写失败的名字' });
  store.saveNow();
  assert.equal(store.stateDirty, true, '写失败必须保持 dirty（否则这份状态永远丢在内存里）');

  // 恢复成文件：下一次 saveNow 应该把内容补上
  fs.rmdirSync(stateFile);
  fs.renameSync(backup, stateFile);
  store.saveNow();
  assert.equal(store.stateDirty, false);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.bots[store.mainBot().id].name, '写失败的名字', '重试要真的把内容写进去');
});

await test('flushNow 成功后同样清 dirty', async () => {
  store.updateBot(store.mainBot().id, { name: 'flush 的名字' });
  const out = store.flushNow();
  assert.deepEqual(out, { ok: true });
  assert.equal(store.stateDirty, false);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.bots[store.mainBot().id].name, 'flush 的名字');
});

await test('内存模式：不落盘也不谎称失败', async () => {
  const { createStore } = await import('../src/store.js');
  const mem = createStore({ memory: true });
  mem.updateBot(mem.mainBot().id, { name: '内存里改名' });
  mem.saveNow(); // 不该抛
  assert.equal(mem.flushNow().ok, true);
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
