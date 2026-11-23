/**
 * 并发群聊的「首字落位」（Mac 实机：多 bot 流式时整屏上下抽搐）。
 *   node tests/group-stream-order.mjs
 *
 * 规则：谁先开口谁在上面。空气泡占着更早的位置不算数 —— 它吐首字时必须
 * 落到**当前并发波次的末尾**，但不能越过用户后来发的新消息。
 */
import assert from 'node:assert/strict';

const { claimOrderTarget } = await import('../src/runner/stream-order.js');

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

const bot = (id, text = '', extra = {}) => ({
  id, authorType: 'bot', text, attachments: [], ...extra,
});
const user = (id, text = '') => ({ id, authorType: 'user', text });

test('★ A 先建空占位、B 先吐字 → A 吐首字时落到 B 之后（不插队）', () => {
  const messages = [
    bot('A'),            // A 先开始，但还空着
    bot('B', 'B 的结论'),
  ];
  assert.equal(claimOrderTarget(messages, 'A'), 'B');
});

test('多路并发：落到「已经可见」的最后一条之后（中间还有别人的空占位）', () => {
  const messages = [
    bot('A'),
    bot('B', 'B 先说'),
    bot('C'),            // C 也还空着
    bot('D', 'D 后说'),
  ];
  assert.equal(claimOrderTarget(messages, 'A'), 'D', '要落到最后一条可见的之后');
});

test('★ 不越过用户后来发的新消息（那是新的一轮）', () => {
  const messages = [
    bot('A'),
    bot('B', 'B 先说'),
    user('u1', '我刚补了一句'),
    bot('C', 'C 在新一轮里说'),
  ];
  assert.equal(claimOrderTarget(messages, 'A'), 'B', '不能挪到用户消息之后');
});

test('后面没有任何可见消息（只有空占位）→ 不用动', () => {
  const messages = [bot('A'), bot('B'), bot('C')];
  assert.equal(claimOrderTarget(messages, 'A'), null);
});

test('附件也算可见（不只是正文）', () => {
  const messages = [
    bot('A'),
    bot('B', '', { attachments: [{ id: 'att1' }] }),
  ];
  assert.equal(claimOrderTarget(messages, 'A'), 'B');
});

test('找不到自己 / 入参非法 → null（不猜）', () => {
  assert.equal(claimOrderTarget([bot('B', 'x')], 'A'), null);
  assert.equal(claimOrderTarget([], 'A'), null);
  assert.equal(claimOrderTarget(null, 'A'), null);
  assert.equal(claimOrderTarget([bot('A')], ''), null);
});

test('自己不在别人后面（自己就是最后一条）→ null', () => {
  const messages = [bot('B', '先说'), bot('A')];
  assert.equal(claimOrderTarget(messages, 'A'), null);
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
