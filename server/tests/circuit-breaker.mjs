import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BREAKER_STATE,
  COOLDOWN_AUTH_MS,
  COOLDOWN_TRANSIENT_MS,
  OPEN_AFTER_FAILS,
  breakerKeyOf,
  breakerNote,
  canRequest,
  clearBreakersForGroup,
  cooldownFor,
  createBreaker,
  isCircuitFailure,
  recordFailure,
  recordSuccess,
  settleAfterCooldown,
} from '../src/circuit-breaker.js';

// ---------------------------------------------------------------------------
// 熔断器：一条路确定不通，就别再往上撞
//
// 实测背景：6 个成员的群、key 彻底不可用时，没有熔断会打 66 次请求、
// 累积等 584 秒、用户看到 6 条"在等接口恢复"。
// 而第 1 个 bot 撞 3 次就足以确定 key 不通。
// ---------------------------------------------------------------------------

test('新熔断器是 closed，允许请求', () => {
  const b = createBreaker();
  assert.equal(b.state, BREAKER_STATE.closed);
  assert.equal(canRequest(b, 0).allow, true);
});

test('连续失败到阈值才打开', () => {
  let b = createBreaker();
  for (let i = 1; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: i });
    assert.equal(b.state, BREAKER_STATE.closed, '第 ' + i + ' 次还不该打开');
  }
  b = recordFailure(b, { kind: 'transient', status: 502, now: 99 });
  assert.equal(b.state, BREAKER_STATE.open);
});

test('★ 打开后立刻拒绝，不发请求 —— 这就是快的原因', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const gate = canRequest(b, 1001);
  assert.equal(gate.allow, false);
  assert.ok(gate.retryAfterMs > 0);
});

test('冷却结束后放**一个**探路请求（halfOpen）', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const later = 1000 + COOLDOWN_TRANSIENT_MS + 1;
  b = settleAfterCooldown(b, later);
  assert.equal(b.state, BREAKER_STATE.halfOpen);
  const gate = canRequest(b, later);
  assert.equal(gate.allow, true);
  assert.equal(gate.probing, true, '要标记成探路');
});

test('探路期间并发请求被挡住 —— 不把上游再打一遍', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const later = 1000 + COOLDOWN_TRANSIENT_MS + 1;
  b = settleAfterCooldown(b, later);
  const first = canRequest(b, later);
  assert.equal(first.allow, true);
  // 模拟：第一个探路请求在飞，状态记成 probing
  b = { ...b, probing: true };
  const second = canRequest(b, later);
  assert.equal(second.allow, false, '探路中不该再放行');
});

test('探路成功 → 回到 closed', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  b = settleAfterCooldown(b, 1000 + COOLDOWN_TRANSIENT_MS + 1);
  b = recordSuccess(b);
  assert.equal(b.state, BREAKER_STATE.closed);
  assert.equal(b.fails, 0);
});

test('探路失败 → 重新打开，不再等攒够 3 次', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const later = 1000 + COOLDOWN_TRANSIENT_MS + 1;
  b = settleAfterCooldown(b, later);
  assert.equal(b.state, BREAKER_STATE.halfOpen);
  b = recordFailure(b, { kind: 'transient', status: 502, now: later });
  assert.equal(b.state, BREAKER_STATE.open, '探路失败要立刻重新打开');
});

// ---------------------------------------------------------------------------
// 哪些失败算通路故障
// ---------------------------------------------------------------------------

test('429 / 5xx / 网络错计入熔断', () => {
  assert.equal(isCircuitFailure({ status: 429 }), true);
  assert.equal(isCircuitFailure({ status: 502 }), true);
  assert.equal(isCircuitFailure({ status: 503 }), true);
  assert.equal(isCircuitFailure({ kind: 'transient' }), true);
  assert.equal(isCircuitFailure({ kind: 'timeout' }), true);
});

test('401/403 计入（凭证问题，一次就该打开）', () => {
  assert.equal(isCircuitFailure({ status: 401 }), true);
  assert.equal(isCircuitFailure({ status: 403 }), true);
  assert.equal(isCircuitFailure({ kind: 'auth' }), true);
});

test('用户终止不计入 —— 不是故障', () => {
  assert.equal(isCircuitFailure({ kind: 'aborted' }), false);
  assert.equal(isCircuitFailure({ kind: 'busy' }), false);
});

test('400/422 不计入 —— 是我们的 bug，熔断救不了', () => {
  assert.equal(isCircuitFailure({ status: 400 }), false);
  assert.equal(isCircuitFailure({ status: 422 }), false);
});

test('任务做不成（没有通路特征）不计入', () => {
  assert.equal(isCircuitFailure({ kind: 'empty' }), false);
  assert.equal(isCircuitFailure({ kind: 'logic', status: null }), false);
});

// ---------------------------------------------------------------------------
// 冷却时长
// ---------------------------------------------------------------------------

test('★ 凭证错误的冷却比临时故障长得多', () => {
  // 钥匙不对不会 60 秒后自己变对 —— 短冷却只会一直撞
  assert.equal(cooldownFor({ kind: 'auth' }), COOLDOWN_AUTH_MS);
  assert.equal(cooldownFor({ status: 401 }), COOLDOWN_AUTH_MS);
  assert.equal(cooldownFor({ status: 502 }), COOLDOWN_TRANSIENT_MS);
  assert.ok(COOLDOWN_AUTH_MS > COOLDOWN_TRANSIENT_MS * 5);
});

// ---------------------------------------------------------------------------
// 用户可见文案
// ---------------------------------------------------------------------------

test('提示说明本次未执行、等待时间和需要用户重试', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const note = breakerNote(b, { groupName: 'GPT', now: 1000 });
  assert.match(note, /GPT/, '要说清是哪条路');
  assert.match(note, /秒/, '要给时间');
  assert.match(note, /本次请求未执行/, '不能把未执行说成仍在等待');
  assert.match(note, /请在 \d+ 秒后重试/, '需要用户重新发起请求');
  assert.doesNotMatch(note, /自动重试|不用做什么|无需操作/, '不能承诺没有排程的自动恢复');
  assert.ok(note.length < 60, '别写成小作文：' + note);
});

test('没有组名时也能给出通顺的句子', () => {
  let b = createBreaker();
  for (let i = 0; i < OPEN_AFTER_FAILS; i++) {
    b = recordFailure(b, { kind: 'transient', status: 502, now: 1000 });
  }
  const note = breakerNote(b, { now: 1000 });
  assert.match(note, /当前模型/);
});

// ---------------------------------------------------------------------------
// 404 = 模型不存在/已下线：一次就熔断，给长冷却
//
// 真机：配置里留着一个已经下线的模型 ID。每次派活都白撞两次（decideRetry 默认
// 给 1 次重试）再报错，用户看到的是「每轮都失败，但换模型就好了」。
// 下线不会在 60 秒后自愈，所以冷却按 auth 档（10 分钟）。
// ---------------------------------------------------------------------------

test('★ 404 计入熔断，且第一次就打开（不攒 3 次）', () => {
  assert.equal(isCircuitFailure({ status: 404 }), true);
  assert.equal(isCircuitFailure({ kind: 'model-not-found' }), true);
  let b = createBreaker();
  b = recordFailure(b, { kind: 'model-not-found', status: 404, now: 1000 });
  assert.equal(b.state, BREAKER_STATE.open, '第一次 404 就该熔断');
  assert.equal(b.cooldownMs, COOLDOWN_AUTH_MS, '下线模型不会 60 秒复活，给长冷却');
  assert.equal(canRequest(b, 1000 + 1).allow, false);
  assert.equal(canRequest(b, 1000 + COOLDOWN_AUTH_MS + 1).allow, true, '冷却结束后放探路请求');
});

test('★ 404 的冷却比临时故障长得多（不是同一个档）', () => {
  assert.equal(cooldownFor({ status: 404 }), COOLDOWN_AUTH_MS);
  assert.equal(cooldownFor({ kind: 'model-not-found' }), COOLDOWN_AUTH_MS);
  assert.ok(COOLDOWN_AUTH_MS >= COOLDOWN_TRANSIENT_MS * 5);
});

test('★ 400/422 仍然不算熔断（是我们的 bug，重试和熔断都救不了）', () => {
  assert.equal(isCircuitFailure({ status: 400 }), false);
  assert.equal(isCircuitFailure({ status: 422 }), false);
  let b = createBreaker();
  for (let i = 0; i < 5; i++) b = recordFailure(b, { status: 422, now: 1000 });
  assert.equal(b.state, BREAKER_STATE.closed);
});

// ---------------------------------------------------------------------------
// 按模型隔离：key = groupId/modelId，清空按组前缀
// ---------------------------------------------------------------------------

test('breakerKeyOf：合法 slug 拆出 key 与 groupId', () => {
  assert.deepEqual(breakerKeyOf('g1/model-a'), { key: 'g1/model-a', groupId: 'g1' });
  // 模型 id 里带斜杠也只认第一个
  assert.deepEqual(breakerKeyOf('g1/vendor/model-b'), { key: 'g1/vendor/model-b', groupId: 'g1' });
  assert.deepEqual(breakerKeyOf('  g2/m  '), { key: 'g2/m', groupId: 'g2' });
});

test('breakerKeyOf：没组没模型的 slug 一律无效（别造出空 key 的熔断器）', () => {
  for (const bad of ['', '   ', 'onlygroup', '/model', 'g1/', null, undefined, 42]) {
    assert.deepEqual(breakerKeyOf(bad), { key: '', groupId: '' }, `slug=${bad}`);
  }
});

test('★ clearBreakersForGroup：只清这一组的所有模型，别的组不受影响', () => {
  const map = new Map([
    ['g1/dead-model', { state: 'open' }],
    ['g1/healthy-model', { state: 'closed' }],
    ['g1/vendor/x', { state: 'open' }],
    ['g10/other', { state: 'open' }],
    ['g2/model', { state: 'open' }],
  ]);
  const cleared = clearBreakersForGroup(map, 'g1');
  assert.equal(cleared, 3);
  assert.deepEqual([...map.keys()].sort(), ['g10/other', 'g2/model']);
  // 前缀清理不能把 g10 当成 g1 的子串误删
  assert.equal(map.has('g10/other'), true);
});

test('clearBreakersForGroup：空组名/坏 map 安全返回 0', () => {
  assert.equal(clearBreakersForGroup(new Map([['g1/m', {}]]), ''), 0);
  assert.equal(clearBreakersForGroup(null, 'g1'), 0);
  assert.equal(clearBreakersForGroup({}, 'g1'), 0);
});
