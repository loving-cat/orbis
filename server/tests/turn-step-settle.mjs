/**
 * 「正在干活…」不能卡死（Mac 实机 UX-1）。
 *   node tests/turn-step-settle.mjs
 *
 * 模型报错 / 被中止 / 命中步数上限时，最后一个工具往往**没有**
 * `tool_execution_end`。这些步骤会以 `status: 'running'` 落库，客户端就一直
 * 转圈 —— 用户描述的是「报错气泡左上角永远卡在正在干活…」。
 *
 * 服务端的收口是 `settleRunningSteps()`：每个非 streaming 的落库出口都要调它。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { settleRunningSteps } = await import(src('runner/turn-executor.js'));

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

test('★ running → error，并补齐 error 文案与 durationMs', () => {
  const startedAt = Date.now() - 120;
  const steps = [{ tool: 'bash', detail: 'npm test', status: 'running', startedAt }];
  settleRunningSteps(steps, '本轮中断，这一步没有结果');
  assert.equal(steps[0].status, 'error');
  assert.equal(steps[0].error, '本轮中断，这一步没有结果');
  assert.ok(steps[0].durationMs >= 100, `durationMs 应按 startedAt 补出来，实际 ${steps[0].durationMs}`);
});

test('已经结束的步骤一个字段都不动（done/error 不能被打回）', () => {
  const steps = [
    { tool: 'read', status: 'done', durationMs: 12 },
    { tool: 'bash', status: 'error', error: '原本就错了', durationMs: 34 },
  ];
  const before = JSON.parse(JSON.stringify(steps));
  settleRunningSteps(steps, 'x');
  assert.deepEqual(steps, before);
});

test('多个 running 一起收敛（并发工具 / 上一个没回来又起了下一个）', () => {
  const steps = [
    { tool: 'a', status: 'running', startedAt: Date.now() },
    { tool: 'b', status: 'done' },
    { tool: 'c', status: 'running', startedAt: Date.now() },
  ];
  settleRunningSteps(steps);
  assert.deepEqual(steps.map((s) => s.status), ['error', 'done', 'error']);
  assert.ok(steps[0].error && steps[2].error);
});

test('空 / 非数组不炸（落库路径会在各种奇怪状态下调用它）', () => {
  assert.equal(settleRunningSteps(null), null);
  assert.equal(settleRunningSteps(undefined), undefined);
  assert.deepEqual(settleRunningSteps([]), []);
});

test('★ 四个落库出口 + 封口都调了 settleRunningSteps（源码守卫，防以后加出口忘了它）', () => {
  // 出口是"改完状态就落库"的几处；新增出口时必须一起收敛，否则又会出现转圈气泡。
  // ★ C4 起：气泡收尾/换条（含"这条气泡已封口"那处）搬到了 `runner/stream-bubbles.js`，
  //   所以**两个文件一起看**才算完整 —— 只数 turn-executor 会把搬走的那处漏掉。
  const dir = path.join(import.meta.dirname, '..', 'src', 'runner');
  const files = ['turn-executor.js', 'stream-bubbles.js'];
  const srcText = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const calls = srcText.match(/settleRunningSteps\(/g) ?? [];
  assert.ok(calls.length >= 5, `期望至少 5 处调用（4 个出口 + 封口），实际 ${calls.length}`);
  for (const marker of ['模型没有返回内容', '本轮结束，这一步没有返回结果', '步数到上限', '本轮要在重试', '这条气泡已封口']) {
    assert.ok(srcText.includes(marker), `缺一处收口：${marker}`);
  }
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
