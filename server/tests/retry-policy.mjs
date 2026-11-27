/**
 * 成员失败后的重试策略测试。
 *
 * 起因：用户观察"负责人发现成员卡住/失败时，不让人重干，而是自己上"。
 * 根因是成员失败只打日志、不告诉任何人，负责人回来只看到"弟弟没说话"。
 *
 * 这里验三件事：
 *   1. 哪些错误值得重试、哪些重试也没用；
 *   2. 重试时提示词怎么变（原样重发大概率得到同样结果）；
 *   3. 用完次数后给负责人的话里，不能留"自己上"的口子。
 */
import assert from 'node:assert/strict';
import {
  MAX_RETRIES,
  decideRetry,
  retryHint,
  giveUpNote,
  failureNote,
  isRecoverableFailure,
  isUpstreamTransient,
} from '../src/retry-policy.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

test('空回复最值得重试', () => {
  const d = decideRetry({ error: '没有给出内容（已自动重试两次）', attempt: 1 });
  assert.equal(d.retry, true);
  assert.equal(d.kind, 'empty');
});

test('超时给一次重试，连续超时就放弃', () => {
  assert.equal(decideRetry({ error: '请求超时（600s）', attempt: 1 }).retry, true);
  const twice = decideRetry({ error: '请求超时（600s）', attempt: 2 });
  assert.equal(twice.retry, false);
  assert.equal(twice.kind, 'timeout-twice');
});

test('「忙」不是失败，重试只会继续撞墙', () => {
  const d = decideRetry({ error: 'Agent is already processing', attempt: 1 });
  assert.equal(d.retry, false);
  assert.equal(d.kind, 'busy');
});

test('鉴权问题重试没用', () => {
  for (const err of ['401', 'invalid api key', '未授权', 'forbidden']) {
    assert.equal(decideRetry({ error: err, attempt: 1 }).retry, false, err);
  }
});

test('用户终止就不重试', () => {
  assert.equal(decideRetry({ error: '任意错误', attempt: 1, aborting: true }).retry, false);
  assert.equal(decideRetry({ error: '这一轮已被终止', attempt: 1 }).retry, false);
});

test('次数用完就停', () => {
  const d = decideRetry({ error: '未知', attempt: MAX_RETRIES + 1 });
  assert.equal(d.retry, false);
  assert.equal(d.kind, 'exhausted');
  assert.match(d.why, /已经试了/);
});

test('默认最多重试 2 次（不含第一次）', () => {
  assert.equal(MAX_RETRIES, 2);
  assert.equal(decideRetry({ error: '未知错误', attempt: 1 }).retry, true, '第 1 次可重试');
  assert.equal(decideRetry({ error: '未知错误', attempt: 2 }).retry, false, '第 2 次后停');
});

test('重试提示词要说清"上次没成"并给新办法', () => {
  const hint = retryHint({ attempt: 1, error: '超时了', kind: 'timeout' });
  assert.match(hint, /第 1 次重试/);
  assert.match(hint, /超时/);
  assert.match(hint, /别一次做太多|先做最关键/, '要给具体建议，不能只说重试');
});

test('空回复的重试提示要它直接给结论', () => {
  const hint = retryHint({ attempt: 1, error: '空回复', kind: 'empty' });
  assert.match(hint, /直接给结论|不要只调工具/);
});

test('重试提示词会截断超长错误（别把上下文撑爆）', () => {
  const hint = retryHint({ attempt: 1, error: 'x'.repeat(2000), kind: 'unknown' });
  assert.ok(hint.length < 600, `实际 ${hint.length}`);
});

test('收尾文案：给出"先重派 → 换人 → 自己上但要说明"的顺序', () => {
  const note = giveUpNote({
    botName: '小王',
    task: '整理上月数据',
    attempts: 3,
    reason: '连续超时',
  });
  assert.match(note, /小王/);
  assert.match(note, /3 次/);
  assert.match(note, /连续超时/);
  assert.match(note, /整理上月数据/);
  // 三步顺序必须都在
  assert.match(note, /再派一次|重新派/);
  assert.match(note, /另一个同事|换人/);
  assert.match(note, /必须在群里说明你接手了/);
});

test('收尾文案明确不许悄悄接手', () => {
  const note = giveUpNote({ botName: '小王', attempts: 3, reason: 'x' });
  assert.match(note, /不要悄悄把活接下/);
  assert.match(note, /掩盖/);
});

test('收尾文案不再出现"换个人或者再派一次"这种暗示可以自己上的说法', () => {
  const note = giveUpNote({ botName: '小王', attempts: 3, reason: 'x' });
  // 旧文案是"请你重新安排：换个人，或者再派一次"
  assert.ok(!/请你重新安排/.test(note), '旧文案给了自己上的口子，不该再出现');
});

test('放弃时才写回执，且不掺技术细节', () => {
  const gaveUp = failureNote({ botName: '小王', reason: '超时', willRetry: false });
  assert.match(gaveUp, /没能完成/);
  assert.ok(!/正在重试/.test(gaveUp));

  // 熔断后的任务已经终止，需要用户重新发起。
  const breaker = failureNote({
    botName: '小王',
    reason: 'HTTP 502',
    willRetry: false,
    kind: 'breaker-open',
  });
  assert.match(breaker, /这次任务已停止/);
  assert.match(breaker, /请重新发送任务/);
  assert.doesNotMatch(breaker, /自动恢复|你不用做什么|会自己接着跑/);
  assert.ok(!/502/.test(breaker), '熔断文案不该带技术码：' + breaker);
});

test('★ 中途重试不再写进群里（用户说"尽可能无感"）', () => {
  // 10 次重试就是 10 条系统消息，把对话刷满。
  // 现在中途只在日志里留痕，群里不写。
  const retrying = failureNote({
    botName: '小王',
    reason: 'HTTP 502',
    attempt: 3,
    willRetry: true,
  });
  assert.ok(retrying.length < 30, '中途文案要极短：' + retrying);
  assert.ok(!/502/.test(retrying), '不该把错误码念给用户');
});

test('留痕文案截断长错误', () => {
  const note = failureNote({ botName: 'x', reason: 'y'.repeat(500), willRetry: false });
  assert.ok(note.length < 250, `实际 ${note.length}`);
});


// ---------------------------------------------------------------------------
// 404 = 模型不存在/已下线：不原地重试，直接换模型
//
// 真机：模型组里留着一个已下线的 ID。旧行为是「每轮白撞两次再报错」，
// 用户看到的是「这个 bot 每轮都失败，但换个模型就好了」。
// ---------------------------------------------------------------------------

test('★ 404 归为 model-not-found，且明确不重试', () => {
  const d = decideRetry({ error: '模型不存在或已下线（HTTP 404），请检查模型 ID 或切换其它模型。', attempt: 1, status: 404 });
  assert.equal(d.kind, 'model-not-found');
  assert.equal(d.retry, false, '原地重试一万次也还是 404');
  assert.equal(d.delayMs, 0, '别让用户白等一轮退避');
  assert.match(d.why, /404|下线|不存在/);
});

test('★ 只有错误文案、没有 status 时也能认出 404', () => {
  const d = decideRetry({ error: 'Model gpt-x not found', attempt: 1 });
  assert.equal(d.kind, 'model-not-found');
  assert.equal(d.retry, false);
});

test('★ 404 不可恢复、也不是上游临时故障（等它自愈没意义）', () => {
  assert.equal(isRecoverableFailure({ error: '404 model not found', status: 404 }), false);
  assert.equal(isUpstreamTransient({ error: 'model not found', status: 404, kind: 'model-not-found' }), false);
  assert.equal(isUpstreamTransient({ status: 404 }), false);
});

test('★ 模型下线有独立的人话文案（要告诉用户去换模型，而不是再试一次）', () => {
  const note = failureNote({ botName: '阿蓝', reason: '模型不存在或已下线（HTTP 404）', willRetry: false, kind: 'model-not-found' });
  assert.match(note, /已下线|不可用|不存在/);
  assert.match(note, /换|切换|改/, '要给出可执行的下一步');
  assert.doesNotMatch(note, /自动重试/, '别承诺会自动重试');
  assert.ok(note.length < 260, '别写成小作文：' + note.length);
});

test('404 不会被 5xx 分支抢走（400/422 仍按原来的路子走）', () => {
  assert.notEqual(decideRetry({ error: 'bad request', attempt: 1, status: 400 }).kind, 'model-not-found');
  const d = decideRetry({ error: 'upstream 503', attempt: 1, status: 503 });
  assert.equal(d.kind, 'transient');
  assert.equal(d.retry, true);
});
console.log(`\n重试策略测试：${pass}/${pass + fail} 通过`);
if (fail > 0) process.exit(1);
