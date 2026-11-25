/**
 * 运行统计的埋点字段 + 只读性能报告（SPEC-PERF-V1 §4.2 a / M1-b）。
 *   node tests/perf-report.mjs
 *
 * 守三件事：
 *   1. 新字段（endedBy / ttft / sdkRetryWaitMs / failKinds）能落、能聚合；
 *   2. **旧 `run-stats.json` 完全兼容**：没有这些字段的记录照常统计，不报错、不伪造 0；
 *   3. `tools/perf-report.mjs` 在临时目录 fixture 上跑得通，且不泄露正文/路径/供应商。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

const {
  makeRecord, summarize, endedByOf, RunTiming, RunStats, ENDED_BY,
} = await import(src('run-stats.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// 1. 纯函数：endedBy 映射与计时器
// ---------------------------------------------------------------------------

await test('endedBy：成功 / 让出 / 各类失败映射到固定枚举', () => {
  assert.equal(endedByOf({ ok: true }), ENDED_BY.ok);
  assert.equal(endedByOf({ ok: true, kind: 'slice' }), ENDED_BY.slice);
  assert.equal(endedByOf({ ok: true, kind: 'step-cap' }), ENDED_BY.slice);
  assert.equal(endedByOf({ ok: false, kind: 'model-idle' }), ENDED_BY.modelIdle);
  assert.equal(endedByOf({ ok: false, kind: 'stall' }), ENDED_BY.stall);
  assert.equal(endedByOf({ ok: false, kind: 'auth' }), ENDED_BY.auth);
  assert.equal(endedByOf({ ok: false, kind: 'quota' }), ENDED_BY.quota);
  assert.equal(endedByOf({ ok: false, kind: 'aborted' }), ENDED_BY.abort);
  assert.equal(endedByOf({ ok: false, kind: 'retrying' }), ENDED_BY.retryExhausted);
  // 未知 kind 也不能写出枚举外的值（报告靠它分组）
  assert.equal(
    Object.values(ENDED_BY).includes(endedByOf({ ok: false, kind: '???' })),
    true,
  );
});

await test('RunTiming：TTFT 样本 / 工具期暂停 / SDK 重试等待 / 失败分类', () => {
  const t = new RunTiming();
  // 第 1 轮：发请求 → 1200 ms 出首字
  t.beginWait(1000);
  t.markProgress(2200);
  // 工具期：暂停，工具自己的耗时不算进 TTFT
  t.pauseWait();
  t.markProgress(9000); // 没在等 → 不记样本
  assert.equal(t.ttftSamples.length, 1);
  // 第 2 轮：600 ms
  t.beginWait(10_000);
  t.markProgress(10_600);
  t.addSdkRetryWait(2000);
  t.addSdkRetryWait(0); // 缺省/非法值安全降级
  t.addSdkRetryWait('nope');
  t.countFail('transient');
  t.countFail('transient');

  const snap = t.snapshot();
  assert.deepEqual(t.ttftSamples, [1200, 600]);
  assert.equal(snap.ttftMsMax, 1200);
  assert.ok(snap.ttftMsP50 === 600 || snap.ttftMsP50 === 1200, `实际 ${snap.ttftMsP50}`);
  assert.equal(snap.sdkRetryWaitMs, 2000);
  assert.deepEqual(snap.failKinds, { transient: 2 });
});

await test('endedBy：stall / abort / auth / quota 按真实结局分桶（不再全坍缩）', () => {
  // 这些是执行器**当场就知道**的事实，必须优先于 kind 的兜底分类
  assert.equal(endedByOf({ ok: false, timedOut: true }), ENDED_BY.stall);
  assert.equal(endedByOf({ ok: false, aborted: true }), ENDED_BY.abort);
  assert.equal(endedByOf({ ok: false, auth: true }), ENDED_BY.auth);
  assert.equal(endedByOf({ ok: false, quota: true }), ENDED_BY.quota);
  // 优先级：让出/步数上限 > 停滞 > 中止 > 鉴权 > 欠费 > 成功 > 重试用尽
  assert.equal(endedByOf({ ok: false, timedOut: true, auth: true }), ENDED_BY.stall);
  assert.equal(endedByOf({ ok: false, aborted: true, auth: true }), ENDED_BY.abort);
  assert.equal(endedByOf({ ok: false, auth: true, quota: true }), ENDED_BY.auth);
  assert.equal(endedByOf({ ok: true, timedOut: true }), ENDED_BY.stall, '超时优先于成功');
  assert.equal(endedByOf({ ok: true, kind: 'step-cap', timedOut: true }), ENDED_BY.slice);
  // 兜底：只有真的什么都不知道，才落到 retry-exhausted
  assert.equal(endedByOf({ ok: false, kind: 'error' }), ENDED_BY.retryExhausted);
});

await test('onSdkRetry：锚点挪到睡醒之后，退避睡眠不重复算进 TTFT', () => {
  const t = new RunTiming();
  t.beginWait(1000);
  // 模型想了 400 ms 还没出字，SDK 决定重试（2000 ms 退避）
  t.onSdkRetry(2000, 1400);
  assert.equal(t.sdkRetryWaitMs, 2000);
  assert.deepEqual(t.failKinds, { 'sdk-retry': 1 });
  assert.equal(t.waitStartedAt, 3400, '锚点必须被强制重置到 1400 + 2000');

  // 睡醒后 800 ms 才出首字：样本应该是 800，而不是含退避的 3200
  t.markProgress(4200);
  assert.deepEqual(t.ttftSamples, [800], `实际 ${JSON.stringify(t.ttftSamples)}`);

  // 老实现用 beginWait()（带 `== null` 守卫）：锚点不会被挪，样本就会虚高
  const broken = new RunTiming();
  broken.beginWait(1000);
  broken.beginWait(3400); // 守卫拦掉，等于没挪
  broken.markProgress(4200);
  assert.deepEqual(broken.ttftSamples, [3200], '（对照）旧写法会把 2 s 退避算进 TTFT');
});

await test('并发工具：全部结束才起表，工具耗时不算进模型 TTFT', () => {
  // 复刻执行器的规则：tool_execution_start 暂停、tool_execution_end 时
  // **只有 toolsRunning === 0** 才 beginWait()。
  const t = new RunTiming();
  let toolsRunning = 0;
  const onToolStart = () => { toolsRunning += 1; t.pauseWait(); };
  const onToolEnd = () => { toolsRunning = Math.max(0, toolsRunning - 1); if (toolsRunning === 0) t.beginWait(); };

  t.beginWait(0);        // 请求发出
  onToolStart();         // 工具 A 开始（暂停）
  onToolStart();         // 工具 B 并发开始
  onToolEnd();           // A 结束，B 还在跑 → 不能起表
  assert.equal(t.waitStartedAt, null, '并发工具还在跑时不许起表');
  onToolEnd();           // B 结束 → 起表
  assert.ok(t.waitStartedAt != null, '全部工具结束才起表');
  const startedAt = t.waitStartedAt;
  t.markProgress(startedAt + 300);
  assert.deepEqual(t.ttftSamples, [300], '样本只含「最后一个工具结束 → 首字」这段');
});

// ---------------------------------------------------------------------------
// 2. 记录与聚合
// ---------------------------------------------------------------------------

await test('makeRecord：直接吃 RunTiming，字段落齐且只留类别', () => {
  const timing = new RunTiming();
  timing.beginWait(0);
  timing.markProgress(700);
  timing.addSdkRetryWait(5000);
  timing.countFail('auth');

  const record = makeRecord({ ok: false, kind: 'retrying', timing, roomId: 'r1', botId: 'b1' });
  assert.equal(record.endedBy, ENDED_BY.retryExhausted);
  // 执行器显式给的 endedBy 优先（它知道 timedOut / aborted 这些 kind 表达不了的事实）
  assert.equal(makeRecord({ ok: false, kind: 'retrying', endedBy: 'stall' }).endedBy, ENDED_BY.stall);
  assert.equal(makeRecord({ ok: false, kind: 'error', endedBy: '不是枚举值' }).endedBy,
    ENDED_BY.retryExhausted, '非法值不能落进记录');
  assert.equal(record.ttftMsMax, 700);
  assert.equal(record.sdkRetryWaitMs, 5000);
  assert.deepEqual(record.failKinds, { auth: 1 });
  // 不含正文/路径这类东西
  const json = JSON.stringify(record);
  assert.equal(/\/|\\\\/.test(json.replace(/"(roomId|botId|model|provider|taskRunId)":"[^"]*"/g, '')), false);
});

await test('summarize：聚合 endedBy / failKinds / TTFT / SDK 等待', () => {
  const records = [
    makeRecord({ ok: true, kind: '', timing: Object.assign(new RunTiming(), { ttftSamples: [200] }) }),
    makeRecord({ ok: false, kind: 'retrying', timing: Object.assign(new RunTiming(), { ttftSamples: [9000] }) }),
    makeRecord({ ok: false, kind: 'auth' }),
  ];
  const s = summarize(records);
  assert.equal(s.endedBy[ENDED_BY.ok], 1);
  assert.equal(s.endedBy[ENDED_BY.retryExhausted], 1);
  assert.equal(s.endedBy[ENDED_BY.auth], 1);
  assert.equal(s.ttftMsMax, 9000);
  assert.ok(s.ttftMsP50 != null);
  assert.equal(s.runs, 3);
});

await test('旧记录兼容：没有新字段也能聚合（不报错、不当成 0）', () => {
  const legacy = [
    { at: 1, ms: 1000, ok: true, attempts: 1, retries: 0 },
    { at: 2, ms: 500, ok: false, attempts: 2, retries: 1 },
  ];
  const s = summarize(legacy);
  assert.equal(s.runs, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.totalMs, 1500);
  assert.deepEqual(s.endedBy, {}, '旧记录不该被算进任何 endedBy 桶');
  assert.equal(s.timingRecords, 0);
  assert.equal(s.ttftMsP50, null);
  assert.equal(s.sdkRetryWaitMs, null);
  assert.deepEqual(s.failKinds, {});
});

await test('RunStats：新字段落盘后可回读（含旧文件的 day 汇总）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-stats-'));
  const file = path.join(dir, 'run-stats.json');
  fs.writeFileSync(file, JSON.stringify({
    records: [{ at: Date.now() - 86_400_000, ms: 300, ok: true, attempts: 1 }],
    days: { '2000-01-01': { runs: 1, succeeded: 1, failed: 0, totalMs: 10 } },
  }), 'utf8');

  const stats = new RunStats({ file });
  assert.equal(stats.records.length, 1, '旧记录要能读回来');
  const timing = new RunTiming();
  timing.beginWait(0);
  timing.markProgress(1234);
  const row = stats.record({ ok: true, kind: '', timing, ms: 2000 });
  assert.equal(row.endedBy, ENDED_BY.ok);
  assert.equal(row.ttftMsMax, 1234);
  stats.save();

  const reread = new RunStats({ file });
  const kept = reread.records.at(-1);
  assert.equal(kept.endedBy, ENDED_BY.ok);
  assert.equal(kept.ttftMsMax, 1234);
  assert.equal(reread.day('2000-01-01').runs, 1, '旧 day 汇总仍在');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. tools/perf-report.mjs：临时目录 fixture 真跑一遍
// ---------------------------------------------------------------------------

await test('perf-report：fixture 上跑得通，聚合正确且不泄露正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-perf-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

  const now = Date.now();
  const timing = new RunTiming();
  timing.beginWait(0);
  timing.markProgress(1500);
  const stats = new RunStats({ file: path.join(dir, 'run-stats.json') });
  stats.record({ ok: true, kind: '', ms: 20_000, timing });
  stats.record({ ok: false, kind: 'retrying', ms: 600_000, timing, failKinds: { transient: 2 } });
  stats.save();

  const lines = [
    { type: 'session', id: 's1', timestamp: now, cwd: '/secret/path' },
    { type: 'message', message: { role: 'assistant', durationMs: 1000, content: [{ type: 'text', text: '机密正文-SHOULD-NOT-APPEAR' }] } },
    { type: 'message', message: { role: 'assistant', durationMs: 3000, content: [{ type: 'toolCall', name: 'bash' }] } },
    { type: 'message', message: { role: 'toolResult', durationMs: 500 } },
    'not-json-line',
  ];
  fs.writeFileSync(path.join(dir, 'sessions', 'x.jsonl'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'), 'utf8');

  const tool = path.join(import.meta.dirname, '..', 'tools', 'perf-report.mjs');
  const { stdout } = await run(process.execPath, [tool, `--data=${dir}`, '--json'], { timeout: 30_000 });
  const report = JSON.parse(stdout);

  assert.equal(report.runs.total, 2);
  assert.equal(report.runs.succeeded, 1);
  assert.equal(report.runs.failed, 1);
  assert.equal(report.endedBy[ENDED_BY.ok], 1);
  assert.equal(report.endedBy[ENDED_BY.retryExhausted], 1);
  assert.equal(report.failKinds.transient, 2);
  assert.equal(report.timing.ttftMsMax, 1500);
  assert.equal(report.sessions.assistantRounds, 2);
  assert.equal(report.sessions.toolCalls, 1);
  assert.equal(report.sessions.skippedLines, 1, '坏行只计数，不炸');
  assert.ok(report.runs.failTimeShare > 0.9, `失败吃掉时长占比应很高，实际 ${report.runs.failTimeShare}`);

  // 隐私：不出现正文、绝对路径、供应商信息
  assert.equal(stdout.includes('机密正文'), false);
  assert.equal(stdout.includes('secret/path'), false);
  assert.equal(/"(model|provider|baseUrl|endpoint)"/.test(stdout), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.err}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exit(1);
