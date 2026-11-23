/**
 * 群聊里用户 @ 之后不能"直接断开、什么都没发生"（Mac 实机 UX-3）。
 *   node tests/group-round-dispatch.mjs
 *
 * ## 三个根因，这里守第一和第二的一半
 *
 * 1. **roundQueue 黑洞**：`dispatchGroupRound` 以前把
 *    `roundLocks.has(roomId) || isRoomBusy(roomId)` 当成"已经有 drain 循环在跑"。
 *    可 `isRoomBusy` 可能是"受管 TaskRun 在跑"或"上一轮 awaitPending 超时放锁后
 *    残留的忙会话"—— 那时没有人在消费队列，消息被塞进去就永远没人跑：
 *    用户看到的是 bob 断线（连一条错误气泡都没有）。
 *
 * 2. **旁路 Talk 的 AbortError 被当成用户取消**：上游网络/SDK 抛的 AbortError
 *    会让消息被标成 `aborted`，而客户端对 aborted 是整条隐藏的 → 同样"没反应"。
 *
 * 3. **用户直接点名却被 [PASS] 静默删消息**：见 group-orchestrator 的 PASS 分支。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { dispatchGroupRound } = await import(src('runner/group-orchestrator.js'));

const results = [];
let tests = Promise.resolve();
function test(name, fn) {
  tests = tests.then(async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, err: err?.message || String(err) });
    }
  });
}

/** 最小 runner：只实现 dispatchGroupRound / interruptRoundForUser 用到的东西。 */
function makeRunner({ busy = false, locked = false, roomId = 'r_g' } = {}) {
  const messages = [];
  const ran = [];
  const runner = {
    roundLocks: new Set(locked ? [roomId] : []),
    roundQueue: new Map(),
    roundEpochs: new Map(),
    sessions: new Map(),
    aborting: new Set(),
    dispatching: new Set(),
    mergeQueue: { drop() {} },
    bus: { emit() {} },
    store: {
      getRoom: (id) => (id === roomId ? { id, name: '测试部门', kind: 'group' } : null),
      listMessages: () => messages,
      getMessage: (rid, mid) => messages.find((m) => m.id === mid) ?? null,
      updateMessage: (rid, mid, patch) => {
        const msg = messages.find((m) => m.id === mid);
        if (msg) Object.assign(msg, patch);
        return msg;
      },
      appendMessage: (m) => { messages.push(m); return m; },
    },
    isRoomBusy: () => busy,
    buildInput: async (text) => ({ promptText: text }),
    runRound: async (rid, opts) => {
      ran.push({ roomId: rid, text: opts.openerText });
      // 模拟 runRound 期间又把一条消息塞进队列（会被 drain 的第二圈消费）
      return { ok: true };
    },
  };
  return { runner, ran, messages, roomId };
}

test('★ 没有 drain 循环但房间忙（isRoomBusy）→ 仍然真的执行新消息，不塞进黑洞', async () => {
  const { runner, ran, roomId } = makeRunner({ busy: true, locked: false });
  await dispatchGroupRound(runner, roomId, '帮我把这个报错看一下', []);
  assert.equal(ran.length, 1, '用户的消息必须真的被跑一次（不能只入队然后没人消费）');
  assert.equal(ran[0].text, '帮我把这个报错看一下');
  assert.equal(runner.roundQueue.has(roomId), false, '队列里不该留下没人消费的残留');
  assert.equal(runner.roundLocks.has(roomId), false, '跑完要把锁放掉');
});

test('已经有 drain 循环（roundLocks 命中）→ 入队等它消费，不并发起第二轮', async () => {
  const { runner, ran, roomId } = makeRunner({ busy: true, locked: true });
  await dispatchGroupRound(runner, roomId, '插一句', []);
  assert.equal(ran.length, 0, '锁在别人手里时不能自己起一轮');
  assert.equal(runner.roundQueue.get(roomId)?.text, '插一句', '要进队列');
  assert.equal(runner.roundEpochs.get(roomId), 1, '插话要打断旧轮（代数 +1）');
});

test('房间空闲 → 正常持锁跑一轮', async () => {
  const { runner, ran, roomId } = makeRunner({ busy: false, locked: false });
  await dispatchGroupRound(runner, roomId, '你好', []);
  assert.equal(ran.length, 1);
  assert.equal(runner.roundLocks.has(roomId), false);
});

test('★ 旧会话 80ms 后才释放 busy → 新消息等它退出再跑，不会双锁并发', async () => {
  // 模拟"上一轮还在收尾"：isRoomBusy 先真后假，80ms 后才放。
  let busy = true;
  const released = new Promise((resolve) => {
    setTimeout(() => { busy = false; resolve(); }, 80);
  });
  const { runner, ran, roomId } = makeRunner({ busy: false, locked: false });
  runner.isRoomBusy = () => busy;

  const pending = dispatchGroupRound(runner, roomId, '这条要等旧会话退出', []);
  // 1) 必须**立刻**持锁：否则第二个并发调用会在加锁前通过检查，双开 drain
  assert.equal(runner.roundLocks.has(roomId), true, '★ 加锁必须发生在任何 await 之前');
  // 2) 第二个调用看到锁 → 入队，不并发起一轮
  await dispatchGroupRound(runner, roomId, '插一句', []);
  assert.equal(ran.length, 0, '旧会话还忙时不该已经开跑');
  assert.equal(runner.roundQueue.get(roomId)?.text, '插一句');

  await released;
  await pending;
  assert.ok(ran.length >= 1, '旧会话退出后要真的跑');
  assert.equal(ran[0].text, '这条要等旧会话退出', '先跑的是第一条真实消息');
  assert.equal(runner.roundLocks.has(roomId), false, '跑完要放锁（含异常路径）');
});

test('★ 旁路 Talk：上游 AbortError 必须标 error（不能当用户取消整条藏掉）', () => {
  const file = path.join(import.meta.dirname, '..', 'src', 'runner', 'duplex-lane.js');
  const text = fs.readFileSync(file, 'utf8');
  // cancelled 只能来自"真的被打断"
  assert.equal(
    /const cancelled = [^;]*err\?\.name === 'AbortError'/.test(text),
    false,
    'cancelled 判定里不许再出现裸 AbortError',
  );
  assert.match(text, /const cancelled = inflight\.aborted \|\| runner\.aborting\.has\(roomId\);/);
  // 错误文案要带模型名（和 turn-executor 对齐）
  assert.match(text, /withModelHint\(modelFailure\(err\)\.error, modelLabel\)/);
  // 连气泡都没建就失败时，要补一条可见的错误
  assert.match(text, /if \(talkMsg\) \{[\s\S]{0,4000}?\} else if \(!cancelled\) \{/);
});

test('★ 用户直接点名的 [PASS] 不静默删消息（源码守卫）', () => {
  const file = path.join(import.meta.dirname, '..', 'src', 'runner', 'group-orchestrator.js');
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf('if (isPass) {');
  assert.ok(at > 0, 'PASS 分支还在');
  const block = text.slice(at, at + 2000);
  assert.match(block, /const userAddressed = !item\.fromId;/, '要先判是不是用户点名');
  assert.match(block, /不删消息/, '用户点名时要留可见说明');
  // deleteMessage 只能在"不是用户点名"的那一侧
  const del = block.indexOf('deleteMessage');
  const guard = block.indexOf('if (userAddressed) {');
  assert.ok(guard > 0 && del > guard, 'deleteMessage 必须在 userAddressed 分支之后（即只对非点名生效）');
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
