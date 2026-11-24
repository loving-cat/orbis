/**
 * `foldAssumptions`：把「我按这些假设推进」折进目标契约的 `scope`。
 *
 * 目标契约只认 4 个字段（requirement / scope / deliverables / verification），
 * 塞新字段会被下游丢掉，所以假设只能折进 scope —— 这几个用例守住折叠规则：
 * 原 scope 不被吃掉、每条有长度上限、条数有上限、没假设时字段要摘干净。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-intake-assume-'));
Object.assign(process.env, {
  HOME: root,
  PI_CODING_AGENT_DIR: path.join(root, 'agent'),
  ORBIS_HOME: path.join(root, 'data'),
  ORBIS_WORKSPACE: path.join(root, 'workspace'),
  ORBIS_PROBE: '0',
});
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.mkdirSync(process.env.ORBIS_WORKSPACE, { recursive: true });

const { foldAssumptions } = await import('../src/coordination/intake-tool.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    fail++;
  }
}

await test('假设并进 scope，原 scope 保留，字段被摘掉', () => {
  const out = foldAssumptions({
    goal: {
      requirement: '做一份竞品清单',
      scope: '只看 B2B SaaS',
      deliverables: ['清单'],
      assumptions: ['先按 20 家做', '价格只写公开报价'],
    },
  });

  assert.equal(out.goal.requirement, '做一份竞品清单', '其他字段必须原样带过去');
  assert.deepEqual(out.goal.deliverables, ['清单']);
  assert.equal('assumptions' in out.goal, false, '契约里不该留下 assumptions');
  assert.match(out.goal.scope, /^只看 B2B SaaS/, '原 scope 要在前面');
  assert.match(out.goal.scope, /按以下假设推进/);
  assert.match(out.goal.scope, /1\) 先按 20 家做；2\) 价格只写公开报价/);
});

await test('每条截到 160 字，最多 8 条', () => {
  const long = 'x'.repeat(500);
  const out = foldAssumptions({
    goal: { scope: '', assumptions: Array.from({ length: 20 }, () => long) },
  });

  const numbered = out.goal.scope.match(/\d\) /g) ?? [];
  assert.equal(numbered.length, 8, '最多折 8 条假设');
  for (const piece of out.goal.scope.split(/；/)) {
    assert.ok(piece.length <= 200, `单条假设过长：${piece.length}`);
  }
  assert.equal(out.goal.scope.includes(long), false, '500 字的假设必须被截断');
});

await test('scope 总长封顶 2000，超了只截不炸', () => {
  const out = foldAssumptions({
    goal: {
      scope: 'y'.repeat(1900),
      assumptions: Array.from({ length: 8 }, (_, i) => `假设${i}${'z'.repeat(150)}`),
    },
  });
  assert.equal(out.goal.scope.length, 2000);
});

await test('没有假设（空数组 / 全空白）→ 只摘字段，scope 不动', () => {
  for (const assumptions of [[], ['  ', ''], null, 'not-an-array']) {
    const out = foldAssumptions({ goal: { scope: '原样', assumptions } });
    assert.equal(out.goal.scope, '原样', `assumptions=${JSON.stringify(assumptions)} 不该改 scope`);
    assert.equal('assumptions' in out.goal, false);
  }
});

await test('本来就没有 assumptions 字段 → 原样返回，不碰 goal', () => {
  const input = { goal: { requirement: 'x', scope: 'y' }, phone: '123' };
  const out = foldAssumptions(input);
  assert.equal(out, input, '没有这个字段就不该复制对象');
  assert.deepEqual(out.goal, { requirement: 'x', scope: 'y' });
});

await test('没有 goal（参数残缺）也不炸', () => {
  assert.deepEqual(foldAssumptions({}), {});
  assert.deepEqual(foldAssumptions(null), null);
  assert.deepEqual(foldAssumptions({ goal: 'text' }), { goal: 'text' });
});

console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
