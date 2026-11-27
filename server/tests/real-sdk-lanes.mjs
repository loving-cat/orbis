/**
 * 真 SDK 端到端泳道回归（**零 mock**）：
 *   node tests/real-sdk-lanes.mjs
 *
 * ## 为什么要有这条
 *
 * 既有用例为了隔离副作用，几乎都把 SDK（`DefaultResourceLoader` / `createAgentSession`）
 * 或 runner（`{ resolveModel: (s) => … }` 这种箭头函数替身）换成了假对象 —— 于是
 * 「真 SDK 的契约」与「真 PiRunner 的 this 绑定」两类错误在单测里**永远是绿的**，
 * 只在真机上炸：
 *
 *   · Talk / Critic：`appendSystemPrompt` 被模板字符串拼成单串 → reload() 抛
 *     `appendSources.map is not a function`（真机 35ms 报「模型请求失败」）；
 *   · Critic / 分档：`runner.resolveModel` 被摘下来裸调 → `this` 为 undefined →
 *     `Cannot read properties of undefined (reading 'modelRuntime')`；
 *   · 复盘 / 经验评分：传入的 loader 从未 reload() → `REFLECT_SYSTEM` 被静默丢掉，
 *     模型拿到的是 SDK 默认的 coding-assistant 提示词。
 *
 * 这里用**真** `PiRunner.init()`、真模型组、真 SDK 会话，对着本机一个假的
 * OpenAI 兼容流式端点（127.0.0.1，记录每个请求）把每条泳道真跑一遍 `prompt()`。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-real-sdk-'));
const wsDir = path.join(root, 'workspace');
const agentDir = path.join(root, 'agent');
for (const d of [wsDir, agentDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wsDir, 'deliverable.md'), '# 交付物\n验收内容 OK\n');
Object.assign(process.env, {
  HOME: root,
  USERPROFILE: root,
  PI_CODING_AGENT_DIR: agentDir,
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: wsDir,
  ORBIS_PROBE: '0',
  ORBIS_TASK_INTAKE: '0',
  ORBIS_WATCH_CHANGES: '0',
  ORBIS_AUTO_ATTACH: '0',
  ORBIS_AUTO_ATTACH_FILES: '0',
});

// ---------------------------------------------------------------- 假模型端点（只听 127.0.0.1）
const requests = [];
const systemOf = (body) => (body?.messages ?? [])
  .filter((m) => m.role === 'system' || m.role === 'developer')
  .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('')))
  .join('\n');
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
    return;
  }
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const sys = systemOf(body);
  requests.push({ body, sys });
  let reply = 'E2E-REPLY-OK';
  if (sys.includes('独立评审（Critic）通道规则')) {
    reply = '{"verdict":"passed","summary":"产物齐全，验收条件满足","defects":[]}';
  } else if (sys.includes('只输出 JSON 的复盘工具')) {
    reply = 'NO_ENTRY';
  }
  const id = 'chatcmpl-e2e';
  const chunk = (delta, finish = null) => ({
    id, object: 'chat.completion.chunk', created: 1, model: 'm1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: reply }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'm1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id, object: 'chat.completion', created: 1, model: 'm1',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ---------------------------------------------------------------- 生产装配（真 PiRunner / 真 SDK）
const { store } = await import('../src/store.js');
const { createModelGroupStore } = await import('../src/model-groups.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { executeTalkItem } = await import('../src/runner/duplex-lane.js');
const { createCriticReviewer, executorModelOf } = await import('../src/tasks/task-critic-runner.js');

const modelGroups = createModelGroupStore({ memory: true });
const upserted = modelGroups.upsert({
  name: 'fake', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-e2e', api: 'openai-completions', models: ['m1'],
});
if (upserted.error) throw new Error(upserted.error);
const slug = upserted.group.slugFor('m1');
const runner = new PiRunner({ modelGroups, inheritHostProviders: false });
await runner.init();
if (!runner.model) runner.model = runner.resolveModel(slug);

const results = [];
async function test(name, fn) {
  const before = requests.length;
  try {
    await fn(() => requests.slice(before));
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`✗ ${name}\n    ${err?.message ?? err}`);
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const toolsOf = (req) => (req?.body?.tools ?? []).map((t) => t.function?.name ?? t.name).sort();
const READONLY = ['find', 'grep', 'ls', 'read'];

const bot = store.createBot({ name: 'e2e-bot', model: slug });
const dm = store.ensureDm(bot.id);

async function talkOnce(roomId, botId, question) {
  const userMessage = store.appendMessage({
    roomId, authorType: 'user', authorId: 'user', authorName: '用户', text: question, status: 'done',
  });
  const inflight = { aborted: false, turnController: new AbortController(), next: null };
  await executeTalkItem(runner, {
    roomId, botId, userMessage, cleanText: question,
    snapshotPrompt: '【实时工作台】后台正在执行', duringMsgId: null, scope: null,
  }, inflight);
  return store.listMessages(roomId, { limit: 5 }).filter((m) => m.authorType === 'bot').pop();
}

await test('RS-1 普通通道：真会话 prompt() 打到模型并流式回包', async (got) => {
  const entry = await runner.ensureSession(dm.id, bot.id);
  let text = '';
  const off = entry.session.subscribe((ev) => {
    if (ev?.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
      text += ev.assistantMessageEvent.delta;
    }
  });
  try {
    await entry.session.prompt('你好');
  } finally {
    off();
    entry.busy = false;
  }
  const reqs = got();
  check(reqs.length >= 1, '模型一个请求都没收到');
  check(text.includes('E2E-REPLY-OK'), `回包没流回来：${JSON.stringify(text)}`);
  check(!/,## /.test(reqs[0].sys), '系统提示里出现了「数组被逗号拼接」的痕迹');
});

await test('RS-2 Talk 旁路（私聊）：气泡 done，提示含旁路规则，只读四件套', async (got) => {
  const last = await talkOnce(dm.id, bot.id, '进度怎么样了？');
  const reqs = got();
  check(last?.status === 'done', `旁路气泡 status=${last?.status} error=${last?.error}`);
  check(String(last.text).includes('E2E-REPLY-OK'), `旁路正文：${JSON.stringify(last.text)}`);
  check(reqs[0]?.sys.includes('## 全双工快速旁路通道规则'), '系统提示缺旁路规则');
  check(toolsOf(reqs[0]).every((t) => READONLY.includes(t)), `旁路暴露了非只读工具：${toolsOf(reqs[0])}`);
});

await test('RS-3 Talk 旁路（部门群 · 负责人）：真机现场同形态', async (got) => {
  const lead = store.createBot({ name: 'e2e-lead', model: slug });
  const member = store.createBot({ name: 'e2e-member', model: slug });
  const created = store.createGroup({ name: 'e2e-dept', botIds: [lead.id, member.id], leadBotId: lead.id });
  const room = created.room ?? created;
  const last = await talkOnce(room.id, lead.id, '现在做到哪了？');
  const reqs = got();
  check(last?.status === 'done', `群旁路气泡 status=${last?.status} error=${last?.error}`);
  check(toolsOf(reqs[0]).every((t) => READONLY.includes(t)), `群旁路暴露了非只读工具：${toolsOf(reqs[0])}`);
});

await test('RS-4 分档选模：executorModelOf(真 PiRunner) 不能因 this 丢失而抛', async () => {
  const described = executorModelOf({ runner, store, botId: bot.id });
  check(described.slug === slug, `执行者模型应为 ${slug}，实际 ${described.slug}`);
});

await test('RS-5 独立评审：createCriticReviewer(真 PiRunner) → reviewed / passed，只读四件套', async (got) => {
  const criticReview = createCriticReviewer({ runner, store, routeOf: () => ({ roomId: dm.id, botId: bot.id }) });
  const out = await criticReview({
    taskRun: { id: 'tr_e2e', goal: '写 deliverable.md', owner: { leadBotId: bot.id } },
    prompt: '请评审 deliverable.md 是否满足验收条件，按 JSON 输出。',
  });
  const reqs = got();
  check(out.status === 'reviewed', `评审 status=${out.status} code=${out.code} why=${out.why}`);
  check(out.verdict === 'passed', `评审结论=${out.verdict}`);
  check(reqs[0]?.sys.includes('## 独立评审（Critic）通道规则'), '系统提示缺评审规则');
  check(toolsOf(reqs[0]).every((t) => READONLY.includes(t)), `评审暴露了非只读工具：${toolsOf(reqs[0])}`);
});

await test('RS-6 复盘隔离会话：REFLECT_SYSTEM 真的送到模型（loader 必须 reload）', async (got) => {
  const created = store.createGroup({ name: 'e2e-reflect', botIds: [bot.id], leadBotId: bot.id });
  const room = created.room ?? created;
  store.appendMessage({ roomId: room.id, authorType: 'user', authorId: 'user', authorName: '用户', text: '不是这样，我要表格格式', status: 'done' });
  store.appendMessage({ roomId: room.id, authorType: 'bot', authorId: bot.id, authorName: bot.name, text: '好的，下次直接按表格格式交付', status: 'done' });
  const out = await runner.reflect({ roomId: room.id, sinceIndex: -1 });
  const reqs = got();
  check(reqs.length >= 1, `复盘没有发出模型请求：${JSON.stringify(out)}`);
  check(reqs[0].sys.includes('只输出 JSON 的复盘工具'),
    `REFLECT_SYSTEM 被丢掉了，模型拿到的系统提示开头是：${JSON.stringify(reqs[0].sys.slice(0, 80))}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n真 SDK 端到端泳道：${results.length - failed.length}/${results.length} 通过`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
if (failed.length) {
  for (const f of failed) console.error(`失败：${f.name}\n${f.err?.stack ?? f.err}`);
}
// ★ 不要先 server.close() 再 exit：Windows 上 keep-alive 连接还在关时 exit 会撞
//   libuv 断言（UV_HANDLE_CLOSING，进程以 127 退出）。看门狗等后台定时器也不该拖住进程，
//   所以直接退出，套接字交给系统回收。
process.exit(failed.length ? 1 : 0);
