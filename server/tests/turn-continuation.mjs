/**
 * 回合收尾判定（纯函数）：「半路停下来问」和「真的做完 / 真的需要用户」要分得开。
 *   node tests/turn-continuation.mjs
 *
 * 宁可少催，不能乱催：误催的代价是去做用户没要的事；漏催的代价是长任务停在原地。
 * 这里把两边的真实措辞都钉住。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const {
  classifyTurnEnding, shouldNudge, wantsAskFirst, claimsCompleted, extractContinuation,
  nudgePrompt, wrapUpPrompt, continuationPrompt, CONTINUE_MARKER,
} = await import(src('turn-continuation.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const kind = (t) => classifyTurnEnding(t).kind;

test('问能不能接着干 → continue_permission', () => {
  for (const t of [
    '第一部分改好了。需要我继续做第二部分吗？',
    '目前完成了 3/5，要不要我继续？',
    '前置检查都过了，是否继续执行迁移？',
    '我可以开始改代码了吗？',
    '等你确认后我再执行下一步。',
    '如果你同意，我就按这个方案改。',
    'Shall I proceed with the migration?',
  ]) {
    assert.equal(kind(t), 'continue_permission', t);
  }
});

test('只报计划没动手 → plan_only', () => {
  for (const t of [
    '代码看完了。接下来我会修改 a.js 并补测试。',
    '思路理清了，我现在开始改。',
    '下一步我将运行全部测试。',
  ]) {
    assert.equal(kind(t), 'plan_only', t);
  }
});

test('不是「我要做」的结尾不算计划（给用户的建议、对用户的说明）', () => {
  assert.notEqual(kind('已经全部完成。接下来你可以运行 npm start 查看效果。'), 'plan_only');
  assert.notEqual(kind('下一步建议：1. 加缓存 2. 补测试'), 'plan_only');
});

test('附加提议 → offer；普通问句 → question；陈述 → none', () => {
  assert.equal(kind('已全部完成。需要我再导出一份 Excel 吗？'), 'offer');
  assert.equal(kind('这个接口用 v1 还是 v2？'), 'question');
  assert.equal(kind('全部改完，测试 42/42 通过。'), 'none');
  assert.equal(kind(''), 'none');
});

test('只看结尾：正文中间复述用户的「要不要继续」不算', () => {
  const long = '你上次问「要不要继续」，我按你的意思继续做了。' + '处理细节。'.repeat(80) + '全部完成，测试通过。';
  assert.equal(kind(long), 'none');
});

test('「做完了」识别', () => {
  assert.equal(claimsCompleted('已全部完成。'), true);
  assert.equal(claimsCompleted('都改好了'), true);
  assert.equal(claimsCompleted('还差最后一步'), false);
});

test('★ shouldNudge：干活回合问「要不要继续」→ 催；纯聊天 → 不催', () => {
  const ask = '改了一半。要不要我继续？';
  assert.equal(shouldNudge({ text: ask, workTurn: true }).nudge, true);
  assert.equal(shouldNudge({ text: ask, workTurn: false }).nudge, false);
});

test('★ shouldNudge：退出条件（完成/等待/先问我/次数/催了仍只回文字）', () => {
  const ask = '要不要我继续？';
  assert.equal(shouldNudge({ text: ask, workTurn: true, completed: true }).nudge, false);
  assert.equal(shouldNudge({ text: ask, workTurn: true, waiting: true }).nudge, false);
  assert.equal(shouldNudge({ text: ask, workTurn: true, askFirst: true }).nudge, false);
  assert.equal(shouldNudge({ text: ask, workTurn: true, nudges: 2, max: 2 }).nudge, false);
  assert.equal(shouldNudge({ text: ask, workTurn: true, nudges: 1, max: 2, actedSinceNudge: false }).nudge, false);
  assert.equal(shouldNudge({ text: ask, workTurn: true, nudges: 1, max: 2, actedSinceNudge: true }).nudge, true);
});

test('★ shouldNudge：做完后的附加提议不催；没说做完的提议/问句要催', () => {
  assert.equal(shouldNudge({ text: '已全部完成。需要我再导出 Excel 吗？', workTurn: true }).nudge, false);
  assert.equal(shouldNudge({ text: '需要我把剩下的接口也改了吗？', workTurn: true }).nudge, true);
  assert.equal(shouldNudge({ text: '这里用 A 还是 B？', workTurn: true }).nudge, true);
});

test('shouldNudge：受管任务没申请完成就收手 → 催一次「做完就交付，没做完就继续」', () => {
  const v = shouldNudge({ text: '这一段做完了数据抓取。', managed: true });
  assert.equal(v.nudge, true);
  assert.equal(v.kind, 'managed_unfinished');
  assert.match(nudgePrompt(v.kind, { managed: true }), /apply_completion/);
});

test('先问我 / 先停：用户原话与插话都认', () => {
  assert.equal(wantsAskFirst('改之前先问我'), true);
  assert.equal(wantsAskFirst('先别动，等我确认'), true);
  assert.equal(wantsAskFirst(['随便插一句', '暂停一下']), true);
  assert.equal(wantsAskFirst('把这个文件改了'), false);
  assert.equal(wantsAskFirst('风格要和我现有代码一致'), false);
});

test('暂停：只认对着它说的指令句，业务描述不当成叫停', () => {
  // 正例：句首 / 逗号后 / 加语气词 都算
  assert.equal(wantsAskFirst('暂停'), true);
  assert.equal(wantsAskFirst('暂停一下'), true);
  assert.equal(wantsAskFirst('先暂停'), true);
  assert.equal(wantsAskFirst('麻烦暂停吧'), true);
  assert.equal(wantsAskFirst('好，暂停'), true);
  assert.equal(wantsAskFirst('暂停推进'), true);
  assert.equal(wantsAskFirst('暂停。等我确认完再说'), true);

  // 反例：业务内容里的「暂停」不能把续跑守卫关掉
  assert.equal(wantsAskFirst('基金暂停申购'), false, '业务名词前的暂停不是指令');
  assert.equal(wantsAskFirst('服务已暂停'), false, '陈述句不是指令');
  assert.equal(wantsAskFirst('这个功能暂停了，明天再看'), false);
  assert.equal(wantsAskFirst('页面上显示“已暂停”三个字'), false);
});

test('催促文案：允许在不可逆操作 / 缺账号密码时停下来说明', () => {
  const text = nudgePrompt('continue_permission');
  assert.match(text, /继续执行/);
  assert.match(text, /不可逆/);
  assert.match(text, /账号密码/);
  assert.match(nudgePrompt('offer'), /不要追加用户没要求的事/);
});

test('收尾通知：受管走 task_report；非受管教续段标记；关了续段就不教标记', () => {
  assert.match(wrapUpPrompt({ managed: true }), /task_report/);
  assert.ok(wrapUpPrompt({ managed: false }).includes(CONTINUE_MARKER));
  assert.ok(!wrapUpPrompt({ managed: false, canContinue: false }).includes(CONTINUE_MARKER));
  assert.match(wrapUpPrompt({ reason: 'steps' }), /步数/);
});

test('续段标记：取出并从正文里去掉；没有标记原样返回', () => {
  const out = extractContinuation(`做到第三步。\n${CONTINUE_MARKER}`);
  assert.equal(out.wanted, true);
  assert.equal(out.text, '做到第三步。');
  assert.deepEqual(extractContinuation('全部完成。'), { wanted: false, text: '全部完成。' });
  assert.match(continuationPrompt({ n: 2, max: 12 }), /续段 2\/12/);
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`回合收尾判定：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
