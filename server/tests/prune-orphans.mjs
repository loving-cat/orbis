/**
 * `orbis prune-orphans`：孤儿文件盘点与清理。
 *   node tests/prune-orphans.mjs
 *
 * 这个命令删的是用户真实聊天记录，所以守的边界比功能本身重要：
 *   ① 默认**不写盘**（纯预览），一个字节都不能动；
 *   ② 有引用的文件一个都不许碰 —— 判据只有「state.json 里有没有它」；
 *   ③ `--apply` 不 unlink，而是挪进 `orphans-backup-<时间戳>/`（可逆）；
 *   ④ `--older-than` 真的按 mtime 过滤（刚产生的残骸别一起清掉）；
 *   ⑤ 会话判据按**文件名**比，不比绝对路径（数据目录改名/迁移后 state 里存的是旧绝对路径，
 *      按全路径比会把活会话误判成孤儿 —— 那是最坏的结果）；
 *   ⑥ 没有 state.json 的目录必须拒绝（拒绝的比清错的便宜）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOrphans, pruneOrphans, BACKUP_PREFIX } from '../src/prune-orphans.js';
import { parsePruneArgs, parseDuration } from '../src/prune-orphans-cli.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

/** 造一个数据目录：2 个活房间 + 3 个孤儿房间；1 个活会话 + 2 个孤儿会话 */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-prune-'));
  fs.mkdirSync(path.join(dir, 'rooms'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

  const liveSession = path.join(dir, 'sessions', 'live-1.jsonl');
  fs.writeFileSync(liveSession, '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'sessions', 'orphan-1.jsonl'), '{"b":2}\n');
  fs.writeFileSync(path.join(dir, 'sessions', 'orphan-2.jsonl'), '{"c":3}\n');

  fs.writeFileSync(path.join(dir, 'rooms', 'r_live1.json'), '[]');
  fs.writeFileSync(path.join(dir, 'rooms', 'r_live2.json'), '[]');
  for (const id of ['r_orphan1', 'r_orphan2', 'dm_orphan3']) {
    fs.writeFileSync(path.join(dir, 'rooms', `${id}.json`), '[{"id":"m1","status":"done"}]');
  }

  // ★ 故意把活会话写成「旧数据目录」的绝对路径：prune 必须按文件名认出来它还活着
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      rooms: { r_live1: { id: 'r_live1' }, r_live2: { id: 'r_live2' } },
      sessions: {
        'r_live1:b1': 'C:\\OldOrbisHome\\data\\sessions\\live-1.jsonl',
      },
    }),
  );
  return dir;
}

await test('① 预览不动任何文件（不写盘、不建目录）', () => {
  const dir = makeFixture();
  const before = fs.readdirSync(path.join(dir, 'rooms')).sort();
  const r = pruneOrphans({ dataDir: dir });
  assert.equal(r.applied, false);
  assert.equal(r.moved, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'rooms')).sort(), before, '预览阶段抄动了房间文件');
  assert.equal(r.rooms.files.length, 3, `孤儿房间该是 3 个，实际 ${r.rooms.files.length}`);
  assert.equal(r.sessions.files.length, 2, `孤儿会话该是 2 个，实际 ${r.sessions.files.length}`);
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(BACKUP_PREFIX)), '预览阶段不该建备份目录');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('② 有引用的一个都不碰（含 state 里存旧绝对路径的活会话）', () => {
  const dir = makeFixture();
  const r = findOrphans({ dataDir: dir });
  const names = [...r.rooms.files, ...r.sessions.files].map((f) => path.basename(f.file));
  assert.ok(!names.includes('r_live1.json'), '活房间被当成孤儿了');
  assert.ok(!names.includes('r_live2.json'), '活房间被当成孤儿了');
  assert.ok(!names.includes('live-1.jsonl'), '活会话被当成孤儿了（按绝对路径比会误判，必须按文件名）');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('③ --apply 是挪进备份目录，不是删除；内容逐字节保留', () => {
  const dir = makeFixture();
  const orphanRoom = path.join(dir, 'rooms', 'r_orphan1.json');
  const original = fs.readFileSync(orphanRoom, 'utf8');
  const r = pruneOrphans({ dataDir: dir, apply: true, stamp: 'TEST' });
  assert.equal(r.applied, true);
  assert.equal(r.moved, 5, `该挪 5 个（3 房间 + 2 会话），实际 ${r.moved}`);
  assert.ok(fs.existsSync(orphanRoom) === false, '孤儿房间文件应该已经不在原处');
  assert.ok(fs.existsSync(path.join(dir, 'rooms', 'r_live1.json')), '活房间被误挪了');
  assert.ok(fs.existsSync(path.join(dir, 'sessions', 'live-1.jsonl')), '活会话被误挪了');
  const backup = path.join(dir, `${BACKUP_PREFIX}TEST`, 'rooms', 'r_orphan1.json');
  assert.equal(fs.readFileSync(backup, 'utf8'), original, '备份内容与原文件不一致');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('④ --older-than 按 mtime 过滤，刚产生的残骸不清', () => {
  const dir = makeFixture();
  const fresh = path.join(dir, 'rooms', 'r_orphan1.json');
  // r_orphan1 是刚刚写的（mtime=现在），把另外两个压成 10 天前
  const old = Date.now() - 10 * 86400000;
  fs.utimesSync(path.join(dir, 'rooms', 'r_orphan2.json'), old / 1000, old / 1000);
  fs.utimesSync(path.join(dir, 'rooms', 'dm_orphan3.json'), old / 1000, old / 1000);
  const r = findOrphans({ dataDir: dir, olderThanMs: 7 * 86400000 });
  const names = r.rooms.files.map((f) => path.basename(f.file)).sort();
  assert.deepEqual(names, ['dm_orphan3.json', 'r_orphan2.json'], `按 7 天过滤后该剩两个旧的，实际 ${names}`);
  assert.ok(!names.includes(path.basename(fresh)), '刚写出来的孤儿不该被 --older-than 7d 选中');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('⑤ 幂等：清完再跑一次没有可清的', () => {
  const dir = makeFixture();
  pruneOrphans({ dataDir: dir, apply: true, stamp: 'A' });
  const again = pruneOrphans({ dataDir: dir, apply: true, stamp: 'B' });
  assert.equal(again.moved, 0, `第二次不该再挪东西，实际挪了 ${again.moved}`);
  assert.ok(!fs.existsSync(path.join(dir, `${BACKUP_PREFIX}B`)), '没东西可挪时不该建空备份目录');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('⑥ 没有 state.json 的目录：CLI 必须拒绝（返回 1）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-prune-empty-'));
  const { runPruneOrphansCli } = await import('../src/prune-orphans-cli.js');
  const writes = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  process.stdout.write = () => true;
  let code;
  try {
    code = await runPruneOrphansCli(['--data', dir]);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  assert.equal(code, 1, '没有 state.json 时必须返回 1');
  assert.ok(writes.join('').includes('不是一个数据目录'), `拒绝理由缺失：${writes.join('')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('⑦ 参数解析：--older-than 支持 d/h/m，看不懂的要报错', () => {
  assert.equal(parseDuration('7d'), 7 * 86400000);
  assert.equal(parseDuration('36h'), 36 * 3600000);
  assert.equal(parseDuration('30m'), 30 * 60000);
  assert.equal(parseDuration('12'), 12 * 3600000, '纯数字按小时');
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parsePruneArgs(['--apply']).apply, true);
  assert.equal(parsePruneArgs([]).apply, false, '默认必须是预览');
  assert.ok(parsePruneArgs(['--older-than', 'zzz']).error, '看不懂的时长要报错，不能静默当 0');
  assert.ok(parsePruneArgs(['--data']).error, '--data 缺值要报错');
});

let failed = 0;
console.log('\n================ 孤儿文件清理 prune-orphans ================');
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else {
    failed++;
    console.log(`✗ ${r.name}\n     ${r.err}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
