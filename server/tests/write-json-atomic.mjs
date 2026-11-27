/**
 * 原子落盘的重试路径（`writeJsonAtomic` / `renameWithRetry`）：
 *   node tests/write-json-atomic.mjs
 *
 * ## 为什么要有这一条
 *
 * Windows 上 rename 会被「目标文件短暂被占」打断：杀软实时扫描、Everything / 索引器
 * 开着句柄、另一个进程刚关掉文件但内核还没释放 —— `fs.renameSync` 抛
 * `EPERM` / `EACCES` / `EBUSY`。以前 `writeJsonAtomic` 没有任何重试，于是：
 *
 *   · `tests/long-task-guardrails.mjs` 的 4b 偶发红：`写盘失败：EPERM: operation not
 *     permitted, rename '…tr_g15.json.tmp-…' -> '…tr_g15.json'`
 *   · 真机上就是用户可见的「写盘失败」——长任务直接断在那里
 *
 * 这里把重试策略固定在用例里：该重试的码必须重试并最终成功、重试次数准确；
 * 不该重试的码（ENOENT / EXDEV / ENOSPC）必须**一次就抛**，不能拖住调用方。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, renameWithRetry, readJson } from '../src/util.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`✗ ${name}\n    ${err?.message ?? err}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-write-atomic-'));

/** 造一个指定错误码的异常（形状与 Node 的 fs 错误一致）。 */
function fsError(code, message = `simulated ${code}`) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/**
 * 让接下来 `failures` 次 rename 抛 `code`，之后放行到真实实现。
 * 返回一个「已调用次数」的读取器。
 */
function failRenames(failures, code) {
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => {
    calls += 1;
    if (calls <= failures) throw fsError(code, `rename blocked (fail ${calls}/${failures})`);
    return real(...args);
  };
  return {
    get calls() { return calls; },
    restore() { fs.renameSync = real; },
  };
}

test('WA-1 正常路径：落盘后能读回、内容一致、临时文件不残留', () => {
  const file = path.join(root, 'plain', 'state.json');
  writeJsonAtomic(file, { a: 1, nested: { b: ['中', '文'] } });
  assert.deepEqual(readJson(file), { a: 1, nested: { b: ['中', '文'] } });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join(', ')}`);
});

test('WA-2 前两次 EPERM（杀软/索引器占着目标文件）→ 重试后成功，且恰好重试 3 次', () => {
  const file = path.join(root, 'retry', 'taskruns.json');
  const fake = failRenames(2, 'EPERM');
  try {
    writeJsonAtomic(file, { ok: true });
  } finally {
    fake.restore();
  }
  assert.equal(fake.calls, 3, `应该在第三次成功（实际 ${fake.calls} 次）`);
  assert.deepEqual(readJson(file), { ok: true }, '最终内容必须是新写的这份');
});

test('WA-3 EBUSY / EACCES 同样算「短暂占用」，也要重试', () => {
  for (const code of ['EBUSY', 'EACCES']) {
    const file = path.join(root, `retry-${code}`, 'state.json');
    const fake = failRenames(1, code);
    try {
      writeJsonAtomic(file, { code });
    } finally {
      fake.restore();
    }
    assert.equal(fake.calls, 2, `${code} 应重试一次后成功（实际 ${fake.calls} 次）`);
    assert.deepEqual(readJson(file), { code });
  }
});

test('WA-4 一直 EPERM：按 attempts 用尽后抛原错误码，且未丢数据（tmp 还在）', () => {
  const file = path.join(root, 'stuck', 'state.json');
  const fake = failRenames(99, 'EPERM');
  let thrown = null;
  try {
    writeJsonAtomic(file, { keep: 'me' });
  } catch (err) {
    thrown = err;
  } finally {
    fake.restore();
  }
  assert.ok(thrown, '失败必须抛出来，不能静默当成写成功');
  assert.equal(thrown.code, 'EPERM', `错误码要原样保留（实际 ${thrown.code}）`);
  assert.equal(fake.calls, 5, `默认 attempts=5（实际 ${fake.calls} 次）`);
  assert.equal(fs.existsSync(file), false, '目标文件不该出现半成品');
  const tmp = fs.readdirSync(path.dirname(file)).find((n) => n.includes('.tmp-'));
  assert.ok(tmp, '临时文件应保留（数据还在里面，方便排查/恢复）');
  assert.deepEqual(readJson(path.join(path.dirname(file), tmp)), { keep: 'me' });
});

test('WA-5 ENOENT / EXDEV / ENOSPC 这类重试无用的错误：一次就抛，不许拖时间', () => {
  for (const code of ['ENOENT', 'EXDEV', 'ENOSPC']) {
    const fake = failRenames(99, code);
    let thrown = null;
    try {
      writeJsonAtomic(path.join(root, `no-retry-${code}`, 'state.json'), { code });
    } catch (err) {
      thrown = err;
    } finally {
      fake.restore();
    }
    assert.ok(thrown, `${code} 必须抛`);
    assert.equal(thrown.code, code);
    assert.equal(fake.calls, 1, `${code} 不该重试（实际 ${fake.calls} 次）`);
  }
});

test('WA-6 renameWithRetry 可直接用：跨目录移动也走得通', () => {
  const from = path.join(root, 'direct', 'a.tmp');
  const to = path.join(root, 'direct', 'a.json');
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, '{"direct":true}');
  renameWithRetry(from, to);
  assert.deepEqual(readJson(to), { direct: true });
  assert.equal(fs.existsSync(from), false);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
if (failed.length) {
  for (const f of failed) console.error(`失败：${f.name}\n${f.err?.stack ?? f.err}`);
  process.exit(1);
}
