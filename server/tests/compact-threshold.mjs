import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { PiRunner } from '../src/pi-runner.js';

// ---------------------------------------------------------------------------
// 压缩阈值：为什么从 0.8 降到 0.4
//
// 实测：主控会话积到 408,213 token（1M 窗口的 40.8%）就**再也没涨过**，
// 离原来 80% 的压缩线（80 万）还很远。而每轮都在按全量重算 40 万 token。
//
// 延迟实测（未命中缓存）：
//   5.6 万 → 3.8s
//   11 万  → 3.4s
//   22 万  → 5.8s
//   33 万  → 7.6s
//   44 万  → 9.5s
//
// 压到 40% 触发后，单轮从 9.5 秒降到 4 秒左右。
// ---------------------------------------------------------------------------

test('默认阈值是 0.6 —— 不在还很宽裕时就把细节收走', () => {
  // 为什么不是 0.8：实测主控积到 40.8 万就再也没涨过，离 80 万差 39 万，
  // 等于永远不压缩。为什么不是 0.4：压缩必然丢细节
  // （工具结果超 2000 字符的部分进不了摘要），能晚压就晚压。
  assert.equal(config.compactAtPercent, 0.6);
});

test('★ 阈值能真正生效，不会被 clamp 悄悄改掉', () => {
  // 这个坑已经踩过一次：config 改成 0.4，但 clamp 下限写的是 Math.max(0.5, ...)
  // → 0.4 被夹成 0.5，用户以为改了其实没生效。
  // 这里直接断言 planCompaction 在这个阈值下会触发。
  const plan = PiRunner.planCompaction({
    percent: 42, // 40 万 / 100 万
    threshold: 40,
    autoCompact: true,
  });
  assert.equal(plan.compact, true, '42% ≥ 40% 应该触发压缩');
});

test('刚过线就压，不等到一半', () => {
  assert.equal(PiRunner.planCompaction({ percent: 41, threshold: 40 }).compact, true);
});

test('没到线不压', () => {
  assert.equal(PiRunner.planCompaction({ percent: 39, threshold: 40 }).compact, false);
});

test('压缩频次不能失控 —— 0.2 以下没有意义', () => {
  // 压得太勤会把刚讨论完的细节过早收进摘要，用户会觉得 bot 忘事
  assert.ok(config.compactAtPercent >= 0.2);
});

test('不能设成 0 或负数（那等于每轮都压）', () => {
  assert.ok(config.compactAtPercent > 0);
});

test('关掉自动压缩时不压', () => {
  const plan = PiRunner.planCompaction({
    percent: 90,
    threshold: 40,
    autoCompact: false,
  });
  assert.equal(plan.compact, false);
  assert.match(plan.why, /关闭/);
});

test('拿不到占用时不猜', () => {
  const plan = PiRunner.planCompaction({ percent: null, threshold: 40 });
  assert.equal(plan.compact, false);
});
// ---------------------------------------------------------------------------
// 强制压缩（force）与「高水位补盲」
//
// 真机：128k 窗口的模型上一轮压缩过之后 `getContextUsage().percent` 是 null，
// 按阈值判会直接放过；而"只数消息正文"的粗估把 117k/128k 报成 45%。
// 于是会话一路顶到 97% 被截断（stopReason: 'length'），谁都没压过。
// ---------------------------------------------------------------------------

test('★ force 跳过阈值判定（上下文确实撑满但 percent 为 null 时也要能压）', () => {
  const plan = PiRunner.planCompaction({ percent: 10, threshold: 60, force: true });
  assert.equal(plan.compact, true);
  assert.match(plan.why, /强制压缩/);

  const fromNull = PiRunner.planCompaction({ percent: null, threshold: 60, force: true });
  assert.equal(fromNull.compact, true, '拿不到占用也要能强制压');
});

test('force 也要守用户意图与状态：关掉自动压缩 / 正在压缩时仍然不压', () => {
  assert.equal(PiRunner.planCompaction({ force: true, autoCompact: false }).compact, false);
  assert.equal(PiRunner.planCompaction({ force: true, compacting: true }).compact, false);
});

test('force 跳过失败冷却（上一轮压缩刚失败过，这一轮被截断时仍要重试压）', () => {
  const now = 1_000_000;
  const cooling = PiRunner.planCompaction({
    percent: 95, threshold: 60, now, retryAfter: now + 30_000, force: false,
  });
  assert.equal(cooling.compact, false, '普通路径要尊重冷却');
  const forced = PiRunner.planCompaction({
    percent: 95, threshold: 60, now, retryAfter: now + 30_000, force: true,
  });
  assert.equal(forced.compact, true, '强制路径不受冷却限制');
});
