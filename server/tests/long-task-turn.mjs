/**
 * 长任务：单轮执行器不能把「正在干活」砍断，也不能让模型「半路停下来问」就收手。
 *   node tests/long-task-turn.mjs
 *
 * 用假 session 驱动真实的 runner.run（不起模型、不联网），守这几条：
 *   1. 工具在出输出（tool_execution_update）就是活着：刷新进展时间、记录在跑的工具数；
 *   2. 续跑守卫：干活回合以「需要我继续吗」「接下来我会…」收尾 → 同一会话里催它继续；
 *      纯聊天提问、用户要求先问、做完后的附加提议、催了仍只回文字 → 都不催；
 *   3. 软截止：到点先 steer 收尾通知，模型自己收住就是「让出待续」，私聊自动排下一段；
 *      模型不理收尾通知 → 宽限后硬中断；工具还在出结果 → 延长宽限，直到硬上限；
 *   4. 受管任务：软截止后收住、没申请完成 → 账本记「让出」（不是失败）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-longturn-'));
Object.assign(process.env, {
  ORBIS_HOME: fixture,
  ORBIS_WORKSPACE: path.join(fixture, 'workspace'),
  PI_CODING_AGENT_DIR: path.join(fixture, 'agent'),
  ORBIS_PROBE: '0',
  ORBIS_LESSON_REFLECT: '0',
});
fs.mkdirSync(process.env.ORBIS_WORKSPACE, { recursive: true });
globalThis.fetch = () => { throw new Error('测试期间不允许联网'); };

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { store } = await import(src('store.js'));
const { PiRunner } = await import(src('pi-runner.js'));
const { CONTINUE_NOTE, NUDGE_NOTE, CONTINUE_MARKER } = await import(src('turn-continuation.js'));
const { createTaskRun } = await import(src('tasks/task-run-factory.js'));
const { runManagedAttempt } = await import(src('tasks/run-managed-attempt.js'));
const { reduceTaskRun } = await import(src('tasks/task-reduce.js'));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('等待超时');
    await sleep(10);
  }
}

const model = { provider: 'fixture', id: 'model-a', contextWindow: 100_000, reasoning: false, input: ['text'] };

/**
 * 按脚本回应的假会话：第 n 次 prompt() 跑 script[n]（超出就重复最后一段）。
 * 记录每次 prompt 的文本与 steer 的文本。
 */
function scriptedSession(script) {
  let listener = () => {};
  let streaming = false;
  const session = {
    model,
    isCompacting: false,
    calls: [],
    steers: [],
    aborted: false,
    get isStreaming() { return streaming; },
    getContextUsage: () => ({ percent: 10, tokens: 1, contextWindow: model.contextWindow }),
    subscribe(fn) { listener = fn; return () => {}; },
    dispose() {},
    async abort() { session.aborted = true; },
    async compact() {},
    async steer(text) { session.steers.push(text); },
    async prompt(text) {
      session.calls.push(text);
      const step = script[Math.min(session.calls.length - 1, script.length - 1)];
      streaming = true;
      try {
        await step({ emit: (e) => listener(e), session, text });
      } finally {
        streaming = false;
      }
    },
  };
  return session;
}

const begin = (emit) => emit({ type: 'message_start', message: { role: 'assistant' } });
const reply = (emit, text) => emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
async function work(emit, { name = 'bash', ms = 0, args = { command: 'echo hi' } } = {}) {
  emit({ type: 'tool_execution_start', toolName: name, args });
  if (ms) await sleep(ms);
  emit({ type: 'tool_execution_end', toolName: name });
}

let seq = 0;
function setup(script, configPatch = {}) {
  seq += 1;
  const bot = store.createBot({ name: '长任务执行者' + seq, persona: '写代码' });
  const room = store.ensureDm(bot.id);
  const runner = new PiRunner();
  runner.__buildSession = async () => assert.fail('不该构造真实会话');
  runner.model = model;
  runner.modelRuntime = { completeSimple: async () => ({ role: 'assistant', content: [{ type: 'text', text: '' }] }) };
  runner.config = { ...runner.config, runSlotWaitMs: 0, maxConcurrentRuns: 0, ...configPatch };
  const session = scriptedSession(script);
  runner.sessions.set(`${room.id}:${bot.id}`, { bot, busy: false, session });
  return { runner, bot, room, session, entry: runner.sessions.get(`${room.id}:${bot.id}`) };
}

const lastBotText = (room) => {
  const msgs = store.listMessages(room.id, { limit: 50 }).filter((m) => m.authorType === 'bot');
  return msgs[msgs.length - 1]?.text ?? '';
};

// ---------------------------------------------------------------------------
// 1. 工具输出 = 活着
// ---------------------------------------------------------------------------

await test('★ 工具在出输出（tool_execution_update）→ 刷新进展时间，在跑的工具数进出平衡', async () => {
  const seen = {};
  const { runner, room, bot, entry } = setup([async ({ emit }) => {
    begin(emit);
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'npm test' } });
    seen.running = entry.toolsRunning;
    entry.progressAt = 0; // 假装已经安静了很久
    emit({ type: 'tool_execution_update', toolName: 'bash', partialResult: { content: [] } });
    seen.progress = entry.progressAt;
    emit({ type: 'tool_execution_end', toolName: 'bash' });
    seen.after = entry.toolsRunning;
    reply(emit, '测试全部通过。');
  }]);
  const res = await runner.run(room.id, bot.id, '跑一下测试');
  assert.equal(res.ok, true, res.error);
  assert.equal(seen.running, 1);
  assert.ok(seen.progress > 0, '工具输出必须刷新进展时间，否则看门狗会把正在跑的构建判成卡死');
  assert.equal(seen.after, 0);
  assert.equal(entry.toolsRunning, 0, '收尾后清零');
});

// ---------------------------------------------------------------------------
// 2. 续跑守卫
// ---------------------------------------------------------------------------

await test('★ 干活回合以「需要我继续吗」收尾 → 自动继续，不停下来等人', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '第一部分改好了。需要我继续做第二部分吗？'); },
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '第二部分也改好了，全部完成。'); },
  ]);
  const res = await runner.run(room.id, bot.id, '把这两部分都改掉');
  assert.equal(res.ok, true, res.error);
  assert.equal(session.calls.length, 2, '应该自动催一次');
  assert.match(session.calls[1], /继续执行/);
  const text = lastBotText(room);
  assert.ok(text.includes('第二部分也改好了'), text);
  assert.ok(!text.includes(NUDGE_NOTE), '系统尾巴不再拼进正文（用户看到的是一条正常回复）');
});

await test('★ 群聊：prompt 是几千字规则模板，但 meta.text 才是用户原话 —— 纯提问不许催', async () => {
  // 真机：群里问「孤儿房间文件是什么？」，turn-executor 收到的 prompt 是 composeGroupPrompt
  // 拼出来的长模板（满是「修/改/写/做/跑」），isPureQuestion(prompt) 永远 false ——
  // 于是只查资料的人被「继续执行，不要停下来问」逼着去改代码。改成读 meta.text。
  const groupTemplate = [
    '【你是部门老大】默认先派活：拆解需求 → @同事派活 → 核对交付 → 汇总。',
    '改代码 / 写测试 / 跑全量验证 都拆给专职成员做；实在没人能接你自己上。',
  ].join(String.fromCharCode(10)).repeat(20);
  const { runner, room, bot, session } = setup([
    async ({ emit }) => {
      begin(emit);
      await work(emit, { name: 'read' });
      reply(emit, '孤儿房间文件是 state.json 里没有、磁盘上还在的那些。要不要我顺手清一下，等你确认？');
    },
  ]);
  const res = await runner.run(room.id, bot.id, groupTemplate, {
    groupTurn: true,
    meta: { text: '孤儿房间文件是什么？' },
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(session.calls.length, 1, '纯提问不该被续跑守卫催第二遍');
});

await test('★ 只报了计划没动手（「接下来我会…」）→ 催它去做', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit, { name: 'read' }); reply(emit, '代码我看完了。接下来我会修改 a.js 并补测试。'); },
    async ({ emit }) => { begin(emit); await work(emit, { name: 'edit' }); reply(emit, 'a.js 改好了，测试也补上了。'); },
  ]);
  await runner.run(room.id, bot.id, '修 a.js 的 bug');
  assert.equal(session.calls.length, 2);
  assert.match(session.calls[1], /还没动手/);
});

await test('纯聊天回合的提问不催（没动工具 = 不是在干活）', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); reply(emit, '你想要中文版还是英文版？'); },
  ]);
  await runner.run(room.id, bot.id, '帮我写个介绍');
  assert.equal(session.calls.length, 1);
});

await test('用户说了「先问我」→ 守卫关闭', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '改了一半。要不要我继续改剩下的？'); },
  ]);
  await runner.run(room.id, bot.id, '改这个文件之前先问我一下');
  assert.equal(session.calls.length, 1);
});

await test('做完后的附加提议（「已全部完成，需要我再导出 Excel 吗？」）不催 —— 不做用户没要的事', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '已全部完成。需要我再导出一份 Excel 吗？'); },
  ]);
  await runner.run(room.id, bot.id, '整理一下数据');
  assert.equal(session.calls.length, 1);
});

await test('★ 催了以后仍只回文字（没动工具）→ 它是真的需要用户，不再催', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '准备好了。需要我继续执行吗？'); },
    async ({ emit }) => { begin(emit); reply(emit, '下一步要删除线上数据库，必须等你确认后我再执行。'); },
  ]);
  const res = await runner.run(room.id, bot.id, '迁移数据库');
  assert.equal(res.ok, true, res.error);
  assert.equal(session.calls.length, 2, '只催一次：第二次仍只回文字就停下');
});

await test('弹了「要停下来等」的卡片（ask_user blocking）→ 它在等用户点，不催', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => {
      begin(emit);
      await work(emit, { name: 'ask_user', args: { question: '删哪个库？', blocking: true } });
      reply(emit, '卡片发给你了，你选一个？');
    },
  ]);
  await runner.run(room.id, bot.id, '帮我清理数据库');
  assert.equal(session.calls.length, 1);
});

await test('默认不阻塞的卡片之后又停下来问 → 照样催（卡片本来就说了先按默认继续）', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => {
      begin(emit);
      await work(emit, { name: 'ask_user', args: { question: '用表格还是列表？' } });
      reply(emit, '卡片发给你了，要不要我先按表格继续？');
    },
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '按表格做完了。'); },
  ]);
  await runner.run(room.id, bot.id, '整理成文档');
  assert.equal(session.calls.length, 2);
});

await test('收尾轮（noContinueGuard）不催', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit }) => { begin(emit); await work(emit); reply(emit, '本轮结论如上。要不要我继续优化？'); },
  ]);
  await runner.run(room.id, bot.id, '收尾', { noContinueGuard: true });
  assert.equal(session.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 3. 软截止 / 续段
// ---------------------------------------------------------------------------

await test('★ 软截止：到点先发收尾通知，它写了续段标记 → 让出待续，私聊自动排下一段', async () => {
  const { runner, room, bot, session } = setup([
    async ({ emit, session: s }) => {
      begin(emit);
      emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'build' } });
      await waitFor(() => s.steers.length > 0, 3000);
      emit({ type: 'tool_execution_end', toolName: 'bash' });
      begin(emit);
      reply(emit, `前三步做完了，下一段从第四步继续。\n${CONTINUE_MARKER}`);
    },
  ], { runTimeoutMs: 150, turnGraceMs: 3000, autoContinueMax: 5 });

  const res = await runner.run(room.id, bot.id, '做一个要很久的活');
  assert.equal(res.ok, true, res.error);
  assert.match(session.steers[0], /系统·分段/, '到点先 steer 收尾通知，而不是直接砍断');
  assert.equal(res.continuation?.reason, 'time');
  const text = lastBotText(room);
  assert.ok(text.includes(CONTINUE_NOTE), text);
  assert.ok(!text.includes(CONTINUE_MARKER), '续段标记不能露给用户');

  // 自动续段：截住下一次 run（真正的续段在 250ms 后排出）
  const next = [];
  runner.run = async (...args) => { next.push(args); return { ok: true }; };
  await waitFor(() => next.length > 0, 2000);
  assert.equal(next[0][3]?.meta?.continuation, 1);
  assert.match(next[0][2], /续段/);
});

await test('续段到上限就停下，留一句话告诉用户怎么接着做', async () => {
  const { runner, room, bot } = setup([
    async ({ emit, session: s }) => {
      begin(emit);
      emit({ type: 'tool_execution_start', toolName: 'bash', args: {} });
      await waitFor(() => s.steers.length > 0, 3000);
      emit({ type: 'tool_execution_end', toolName: 'bash' });
      reply(emit, `还没完。\n${CONTINUE_MARKER}`);
    },
  ], { runTimeoutMs: 100, turnGraceMs: 3000, autoContinueMax: 2 });
  const next = [];
  const realRun = runner.run.bind(runner);
  // 已经是第 2 段（上限 2）：再要续段就该停
  await realRun(room.id, bot.id, '接着做', { meta: { continuation: 2 } });
  runner.run = async (...args) => { next.push(args); return { ok: true }; };
  await sleep(500);
  assert.equal(next.length, 0, '到上限不能再续');
  const notes = store.listMessages(room.id, { limit: 50 }).filter((m) => m.meta?.via === 'auto_continue_cap');
  assert.equal(notes.length, 1);
});

await test('★ 模型不理收尾通知 → 宽限期满硬中断（不会无限跑）', async () => {
  const { runner, room, bot } = setup([
    async ({ session: s }) => {
      // 一直不收手，直到被 abort
      while (!s.aborted) await sleep(10);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  ], { runTimeoutMs: 100, turnGraceMs: 200, turnHardMaxMs: 400 });
  const t0 = Date.now();
  const res = await runner.run(room.id, bot.id, '不肯停的活');
  const ms = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.match(String(res.error), /未完成，已中断|超时/);
  assert.ok(ms >= 250 && ms < 2000, `应在软截止+宽限后中断，实际 ${ms}ms`);
});

await test('★ 工具还在出结果 → 延长宽限，不把正在出结果的构建砍在半路', async () => {
  const { runner, room, bot, entry } = setup([
    async ({ emit, session: s }) => {
      begin(emit);
      emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'long build' } });
      // 一直出输出，跑过「软截止 + 一次宽限」之后才结束
      for (let i = 0; i < 9; i += 1) {
        if (s.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        await sleep(100);
        emit({ type: 'tool_execution_update', toolName: 'bash', partialResult: {} });
      }
      emit({ type: 'tool_execution_end', toolName: 'bash' });
      begin(emit);
      reply(emit, '构建完成。');
    },
  ], { runTimeoutMs: 100, turnGraceMs: 300, turnHardMaxMs: 3000 });
  const res = await runner.run(room.id, bot.id, '跑一个长构建');
  assert.equal(res.ok, true, res.error);
  assert.equal(entry.session.aborted, false, '工具在出结果时不能被硬中断');
});

// ---------------------------------------------------------------------------
// 4. 受管任务：软截止 → 账本记「让出」
// ---------------------------------------------------------------------------

await test('★ 受管任务：软截止后收住、没申请完成 → 账本记「让出」（推进器会接着排），不是失败', async () => {
  const { runner, room, bot } = setup([
    async ({ emit, session: s }) => {
      begin(emit);
      emit({ type: 'tool_execution_start', toolName: 'bash', args: {} });
      await waitFor(() => s.steers.length > 0, 3000);
      emit({ type: 'tool_execution_end', toolName: 'bash' });
      begin(emit);
      reply(emit, '这一段做完了数据抓取，下一段整理表格。');
    },
  ], { runTimeoutMs: 150, turnGraceMs: 3000 });

  const taskRuns = store.taskRuns;
  const id = 'tr_turnslice1';
  const built = createTaskRun({
    id, requestId: 'rq_turnslice1', requesterId: 'local', at: Date.now(),
    origin: { roomId: room.id }, owner: { leadBotId: bot.id, roomKind: 'dm' },
    budget: { maxRuns: null },
    goal: { requirement: '一件长任务', verification: [{ id: 'c1', kind: 'artifact', description: '交一份文件' }] },
    autonomous: true,
  });
  assert.equal(built.ok, true, built.text);
  await taskRuns.acceptRequest({ requesterId: 'local', requestId: 'rq_turnslice1', fingerprint: 'fp-ts1', build: () => built.taskRun, at: Date.now() });

  const settle = async (event) => {
    const out = await taskRuns.mutate(id, {
      mutate: (cur) => {
        const reduced = reduceTaskRun(cur, { ...event, sequence: cur.sequence + 1 });
        return reduced.ok ? reduced.taskRun : { __reject: reduced };
      },
    });
    return out.ok ? { ok: true, taskRun: out.taskRun } : { ok: false, code: out.code, text: out.text };
  };
  const attemptId = 'a_' + id + '_r1_1';
  const out = await runManagedAttempt({
    taskRuns, taskRun: taskRuns.read(id).taskRun, taskRunId: id, attemptId, botId: bot.id, revision: 1,
    settleEvent: settle,
    execute: () => runner.run(room.id, bot.id, '做长任务', {
      managedContext: { taskRunId: id, revision: 1, attemptId, botId: bot.id },
    }),
  });
  assert.equal(out.ok, true, out.text);
  const attempt = taskRuns.read(id).taskRun.attempts.find((a) => a.attemptId === attemptId);
  assert.equal(attempt.result.stop, 'yielded', `软截止后应记「让出」，实际 ${attempt.result.stop}`);
});

for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`长任务单轮：${results.length - failed.length}/${results.length} 通过`);
clearTimeout(store.saveTimer);
setTimeout(() => {
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
}, 50);
