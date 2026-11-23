/**
 * 旁路 Talk 失败路径：**真的**执行 executeTalkItem（review 抓到的块级作用域 bug）。
 *   node tests/talk-failure-diagnostics.mjs
 *
 * 原来 `let responseFailure = null;` 声明在 `try` 块里，`catch` 却读
 * `responseFailure?.detail` —— 任意旁路失败都会当场抛 ReferenceError（TDZ），
 * 日志与诊断记录全被跳过：用户看到的只是一条没有原因的红字。
 *
 * 这个测试用一个假 session 触发 `message_end { stopReason: 'error' }`，
 * 断言：① 不抛；② 气泡是 error；③ 诊断记录里拿到脱敏后的真实上游 detail。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-talk-diag-'));
const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

const { executeTalkItem } = await import(src('runner/duplex-lane.js'));
const { createDiagnosticsLog } = await import(src('diagnostics-log.js'));

// 假密钥：运行时拼，源码里不留完整 key 形状（secret scan 会当成泄漏）
const SECRET = ['sk', 'talkfake', 'notreal456'].join('-');

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

/** 假 session：prompt 时先推 message_start，再推一个失败的 message_end。 */
function failingSession({ emit = true } = {}) {
  let subscriber = null;
  const session = {
    model: { provider: 'fixture', id: 'm1', contextWindow: 16000, maxTokens: 1000 },
    subscribe(cb) {
      subscriber = cb;
      return () => { subscriber = null; };
    },
    abort: async () => {},
    async prompt() {
      if (!emit) throw new Error(`transport exploded ${SECRET}`);
      subscriber?.({ type: 'message_start', message: { role: 'assistant' } });
      subscriber?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: `400 invalid_request_error: thinking budget too low (Bearer ${SECRET})`,
          usage: { input: 10, output: 2 },
        },
      });
      return { text: '' };
    },
  };
  return session;
}

function harness({ session }) {
  const messages = [];
  const events = [];
  const runner = {
    store: {
      getBot: (id) => ({ id, name: '编码手', emoji: '🤖', model: 'fixture/m1' }),
      getRoom: (id) => ({ id, name: '研发部' }),
      appendMessage: (m) => {
        const msg = { ...m, id: m.id ?? `m_${messages.length + 1}` };
        messages.push(msg);
        return msg;
      },
      updateMessage: (roomId, id, patch) => {
        const msg = messages.find((m) => m.id === id);
        if (msg) Object.assign(msg, patch);
        return msg;
      },
      listMessages: () => messages,
      memorySummaryFor: () => null,
    },
    bus: { emit: (e) => events.push(e) },
    aborting: new Set(),
    talkInflight: new Map(),
    providerUpdates: { withLease: (fn) => fn() },
    requestLifecycle: { close: () => {} },
    acquireRunSlot: async () => ({ ok: true, release: () => {} }),
    __buildTalkSession: async () => ({ session }),
    diagnostics: createDiagnosticsLog({ memory: true }),
  };
  return { runner, messages, events };
}

const flush = () => new Promise((r) => setImmediate(r));

test('★ 旁路 Talk 在上游 message_end 报错时：不抛、气泡标 error、诊断拿到脱敏 detail', async () => {
  const { runner, messages } = harness({ session: failingSession() });
  const inflight = { aborted: false, session: null, turnController: { signal: { aborted: false } } };

  await executeTalkItem(runner, {
    roomId: 'r1',
    botId: 'b1',
    userMessage: { id: 'u1' },
    cleanText: '现在到哪了？',
    snapshotPrompt: '快照',
    duringMsgId: 'msg_during',
    scope: { id: 'scope1' },
  }, inflight);

  const bubble = messages.find((m) => m.authorType === 'bot');
  assert.ok(bubble, '要建出气泡');
  assert.equal(bubble.status, 'error', '上游失败必须是 error（不是 aborted）');
  assert.ok(bubble.error, '要有给人看的错误文案');

  const [diag] = runner.diagnostics.recent(1);
  assert.ok(diag, '诊断记录要写进去（ReferenceError 会让它整条丢失）');
  assert.equal(diag.phase, 'talk');
  assert.match(diag.detail, /thinking budget too low/, '★ 上游原文必须在 detail 里');
  assert.equal(diag.detail.includes(SECRET), false, 'detail 要脱敏');
  assert.equal(`${diag.summary}`.includes(SECRET), false);
});

test('★ 连会话都没起来就失败（prompt 抛错）也不能把异常吞掉或抛出去', async () => {
  const { runner, messages } = harness({ session: failingSession({ emit: false }) });
  const inflight = { aborted: false, session: null, turnController: { signal: { aborted: false } } };

  await executeTalkItem(runner, {
    roomId: 'r1',
    botId: 'b1',
    userMessage: { id: 'u1' },
    cleanText: '在吗？',
    snapshotPrompt: '',
    duringMsgId: null,
    scope: null,
  }, inflight);
  await flush();

  const bubble = messages.find((m) => m.authorType === 'bot');
  assert.ok(bubble, '失败也要留下一条可见气泡');
  assert.equal(bubble.status, 'error');
  const [diag] = runner.diagnostics.recent(1);
  assert.ok(diag, '诊断要记');
  assert.equal(diag.detail.includes(SECRET), false, '也要脱敏');
});

await tests;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
