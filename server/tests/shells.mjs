/**
 * 后台进程注册表测试。
 *   node tests/shells.mjs
 *
 * 覆盖启动/读输出/写 stdin/结束、输出上限、模式等待、并发上限、空闲清理。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellRegistry, trimChunks } from '../src/shells.js';
import { findProcesses, waitGone, describeRemaining } from './helpers/proc-scan.mjs';

// 用临时脚本文件跑，避免不同平台 shell 对引号/括号的解析差异。
// 目录名带 `Orbis-shells-` 前缀 + 每条用例自己的 tag：进程表扫描按 tag 精确找，
// 不会把别的用例（或别人的机器上）的进程误算进来。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-shells-'));
const script = (name, body, tag = '') => {
  const dir = tag ? path.join(tmp, tag) : tmp;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return `node "${file}"`;
};

const NL = String.fromCharCode(10);
let tagSeq = 0;
const tagOf = (base) => {
  tagSeq += 1;
  return `${base}-${process.pid}-${tagSeq}`;
};

/**
 * 起一个「带孙进程」的后台命令：脚本自己再落一个脚本文件到同目录并 spawn 它。
 *
 * 为什么要有孙进程：`shell: true` 的真实形态就是 `cmd.exe / sh -c → 命令 → 命令的子进程`，
 * 只测一层等于不测（旧实现杀掉的正是最外面那层）。
 */
const treeCommand = (tag) => {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  const grand = path.join(dir, 'grand.js');
  fs.writeFileSync(grand, 'setInterval(() => {}, 1000);' + NL, 'utf8');
  const main = path.join(dir, 'main.js');
  fs.writeFileSync(main, [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: 'ignore' });`,
    'setInterval(() => {}, 1000);',
    '',
  ].join(NL), 'utf8');
  return `node "${main}"`;
};

/** 断言某条用例的进程树在 5 s 内彻底消失。 */
const expectNoProcess = async (tag) => {
  const { ok, remaining } = await waitGone(tag, { timeoutMs: 5000 });
  assert.equal(ok, true, `标记 ${tag} 还有存活进程：${describeRemaining(remaining)}`);
};

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
// 所有 registry 都登记起来：文件末尾统一 `await stopAll()`，
// 否则先退出进程 = 那些后台进程直接变孤儿（这正是 P0-1 要治的病）。
const regs = [];
const newReg = (opts) => {
  const r = new ShellRegistry(opts);
  regs.push(r);
  return r;
};

const reg = newReg({ idleMs: 60_000 });

await test('启动并读到输出', async () => {
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: 'echo hello-from-shell', cwd: process.cwd() });
  assert.ok(started.id, started.error);
  const r = await reg.read(started.id, { waitMs: 4000 });
  assert.match(r.output, /hello-from-shell/);
  await sleep(300);
  const done = reg.get(started.id);
  assert.equal(done.running, false);
  assert.equal(done.exitCode, 0);
});

await test('★ 写 stdin 能送到进程里', async () => {
  const cmd = script('stdin.js', `process.stdin.on('data',d=>{console.log('got:'+d.toString().trim());process.exit(0)});
`);
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  assert.ok(started.id, started.error);
  await sleep(500);
  const w = reg.write(started.id, 'ping\n');
  assert.equal(w.ok, true, w.error);
  const r = await reg.read(started.id, { pattern: 'got:ping', waitMs: 5000 });
  assert.equal(r.matched, true, r.output);
});

await test('★ pattern 等待：命中就返回', async () => {
  const cmd = script('ready.js', `setTimeout(()=>console.log('READY'),400);
`);
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  const begin = Date.now();
  const r = await reg.read(started.id, { pattern: 'READY', waitMs: 5000 });
  assert.equal(r.matched, true);
  assert.ok(Date.now() - begin < 5000);
});

await test('结束进程', async () => {
  const started = reg.start({ roomId: 'r1', botId: 'b1', command: script('idle.js', `setInterval(()=>{},500);
`), cwd: process.cwd() });
  await sleep(400);
  assert.equal(reg.get(started.id).running, true);
  const killed = reg.kill(started.id);
  assert.equal(killed.ok, true);
  await sleep(600);
  const r = await reg.read(started.id);
  assert.equal(r.running, false);
});

await test('★ 输出上限：超出后标记 truncated 且只保留尾部', async () => {
  const small = newReg({ maxBytes: 4096, idleMs: 60_000 });
  const cmd = script('big.js', `process.stdout.write('a'.repeat(200000));
`);
  const started = small.start({ roomId: 'r1', botId: 'b1', command: cmd, cwd: process.cwd() });
  await sleep(1200);
  const r = await small.read(started.id);
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 4096 + 64, `实际 ${r.output.length}`);
  small.stopAll();
});

await test('并发上限：超出直接拒绝', async () => {
  const tiny = newReg({ maxShells: 1, idleMs: 60_000 });
  const first = tiny.start({ roomId: 'r1', botId: 'b1', command: script('idle2.js', `setInterval(()=>{},500);
`), cwd: process.cwd() });
  assert.ok(first.id);
  const second = tiny.start({ roomId: 'r1', botId: 'b1', command: 'echo x', cwd: process.cwd() });
  assert.equal(second.id, null);
  assert.match(second.error, /上限/);
  tiny.stopAll();
});

await test('空闲清理：结束并移除记录', async () => {
  const quick = newReg({ idleMs: 50 });
  const started = quick.start({ roomId: 'r1', botId: 'b1', command: script('idle3.js', `setInterval(()=>{},300);
`), cwd: process.cwd() });
  await sleep(200);
  quick.pruneIdle();
  assert.equal(quick.get(started.id), null);
  quick.stopAll();
});

await test('按房间清理', async () => {
  const started = reg.start({ roomId: 'r_clear', botId: 'b1', command: script('idle4.js', `setInterval(()=>{},300);
`), cwd: process.cwd() });
  await sleep(300);
  assert.equal(reg.killRoom('r_clear'), 1);
  assert.equal(reg.get(started.id), null);
});

await test('单块超上限也要截尾（不依赖操作系统的分块大小）', () => {
  const entry = { chunks: ['a'.repeat(200000)], bytes: 200000, truncated: false };
  trimChunks(entry, 1024);
  assert.equal(entry.truncated, true);
  assert.ok(Buffer.byteLength(entry.chunks[0]) <= 1024, `实际 ${Buffer.byteLength(entry.chunks[0])}`);
});

await test('截尾不会切断 UTF-8 多字节字符', () => {
  const text = '中'.repeat(1000); // 3000 字节
  const entry = { chunks: [text], bytes: Buffer.byteLength(text), truncated: false };
  trimChunks(entry, 1000);
  const kept = entry.chunks[0];
  assert.ok(Buffer.byteLength(kept) <= 1000);
  assert.ok(!kept.startsWith('\uFFFD'), '开头不能是替换符（说明切在了半个字符上）');
  assert.ok(/^中+$/.test(kept), kept.slice(0, 10));
});

await reg.stopAll();

await test('★ 按任务回收后台进程（任务结束不该留 dev server）', async () => {
  const reg = newReg();
  const a = reg.start({ roomId: 'r1', botId: 'b1', taskId: 'tr_1', command: script('t1.js', 'setInterval(()=>{},500);'), cwd: process.cwd() });
  const b = reg.start({ roomId: 'r1', botId: 'b1', taskId: 'tr_1', command: script('t2.js', 'setInterval(()=>{},500);'), cwd: process.cwd() });
  const other = reg.start({ roomId: 'r1', botId: 'b1', taskId: 'tr_2', command: script('t3.js', 'setInterval(()=>{},500);'), cwd: process.cwd() });
  await new Promise((r) => setTimeout(r, 300));

  const r = reg.killByTask('tr_1', { reason: '测试' });
  assert.equal(r.killed.length, 2, '同一个任务的两个进程都要收');
  assert.ok(r.killed.includes(a.id) && r.killed.includes(b.id));
  const left = reg.list().map((x) => x.id);
  assert.ok(left.includes(other.id), '不同任务的进程不能收');
  reg.kill(other.id);
});

await test('没有 taskId 的进程不会被任何任务收掉（手工起的就手工关）', async () => {
  const reg = newReg();
  const manual = reg.start({ roomId: 'r1', botId: 'b1', command: script('m.js', 'setInterval(()=>{},500);'), cwd: process.cwd() });
  await new Promise((r) => setTimeout(r, 300));
  const r = reg.killByTask('tr_x');
  assert.equal(r.killed.length, 0);
  assert.ok(reg.list().some((x) => x.id === manual.id));
  reg.kill(manual.id);
});

// ---- 进程树零残留（SPEC-PERF-V1 P0-1） ----
//
// 这些用例守的是「kill 之后进程树真的没了」，不是「kill 返回了 ok」。
// 旧实现：异步 taskkill 不等结果就 child.kill()，cmd/sh 先死、孙进程变孤儿
// （实测 3/3 存活），而测试自己 process.exit() 时内核把会话收掉，所以看不见。

await test('★ kill 之后整棵进程树 5 s 内消失（含孙进程）', async () => {
  const reg = newReg();
  const tag = tagOf('kill');
  const started = reg.start({ roomId: 'r_leak', botId: 'b1', command: treeCommand(tag), cwd: process.cwd() });
  assert.ok(started.id, started.error);
  await sleep(1200);
  const alive = await findProcesses(tag);
  assert.ok(alive.length >= 2, `前置：应该已有 2+ 个进程在跑（实际 ${alive.length}：${describeRemaining(alive)}）`);

  const hit = reg.kill(started.id);
  assert.deepEqual(hit, { ok: true, wasRunning: true }, 'kill() 保持同步返回契约');
  const exit = await reg.waitExit(started.id, 5000);
  assert.equal(exit.ok, true, `waitExit 应等到真的退出（running=${exit.running}）`);
  await expectNoProcess(tag);
});

await test('★ killRoom 之后整棵进程树 5 s 内消失', async () => {
  const reg = newReg();
  const tag = tagOf('killroom');
  const a = reg.start({ roomId: 'r_leak2', botId: 'b1', command: treeCommand(tag), cwd: process.cwd() });
  reg.start({ roomId: 'r_leak2', botId: 'b2', command: treeCommand(tag), cwd: process.cwd() });
  assert.ok(a.id, a.error);
  await sleep(1200);
  assert.ok((await findProcesses(tag)).length >= 2);

  assert.equal(reg.killRoom('r_leak2'), 2);
  await expectNoProcess(tag);
});

await test('★ killByTask 之后整棵进程树 5 s 内消失', async () => {
  const reg = newReg();
  const tag = tagOf('killtask');
  const a = reg.start({ roomId: 'r_leak3', botId: 'b1', taskId: 'tr_leak', command: treeCommand(tag), cwd: process.cwd() });
  assert.ok(a.id, a.error);
  await sleep(1200);
  assert.ok((await findProcesses(tag)).length >= 1);

  const r = reg.killByTask('tr_leak', { reason: '测试' });
  assert.equal(r.killed.length, 1);
  await expectNoProcess(tag);
});

await test('★ stopAll 返回 Promise 并等整棵进程树收干净', async () => {
  const reg = newReg();
  const tag = tagOf('stopall');
  reg.start({ roomId: 'r_leak4', botId: 'b1', command: treeCommand(tag), cwd: process.cwd() });
  await sleep(1200);
  assert.ok((await findProcesses(tag)).length >= 2);

  const pending = reg.stopAll();
  assert.equal(typeof pending?.then, 'function', 'stopAll 必须返回 Promise（收尾要等）');
  const out = await pending;
  assert.equal(out.ok, true);
  assert.equal(reg.list().length, 0, 'map 要清干净');
  await expectNoProcess(tag);
});

await test('空闲剪枝回收时不产生 unhandled rejection', async () => {
  const reg = newReg({ idleMs: 50 });
  const tag = tagOf('prune');
  reg.start({ roomId: 'r_leak5', botId: 'b1', command: treeCommand(tag), cwd: process.cwd() });
  await sleep(900);
  reg.pruneIdle(10);
  await expectNoProcess(tag);
});

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}

// 收工：所有注册表都等它们把进程树收干净（这是 P0-1 的一部分）
for (const r of regs) {
  try { await r.stopAll(); } catch { /* 已收 */ }
}

const passed = results.filter((r) => r.ok).length;
console.log('\n================ 后台进程测试 ================');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
