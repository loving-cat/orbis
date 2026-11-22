/**
 * 授权审计检索（路线图 §4 T2.10）：`server/src/audit-query.js` + 网关真的记 roomId。
 *   node tests/audit-query.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **过滤口径**：按房间 / Bot / 动作 / 结果 / 码 / 时间窗（闭区间）组合过滤，
 *    分页与排序都要可用。
 * 2. **老记录不串门**：1.7 之前的审计没有 `roomId`；按房间查时它们必须**不出现**
 *    （宁可少给，也不要把别的房间的事算进来）。
 * 3. **非法过滤要报错**：`from > to`、`limit<=0` 不能变成"查到 0 条" ——
 *    空结果会让人以为真的没记录。
 * 4. **网关真的记了 roomId**：`grant-gate.check({ roomId })` 落库的每条审计都带它，
 *    否则前面三条都是空中楼阁。
 */
import assert from 'node:assert/strict';

import { queryAudit, summarizeAudit, filterAudit, toMillis, AUDIT_QUERY_MAX_LIMIT } from '../src/audit-query.js';
import { createGrantGate } from '../src/grant-gate.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

const T0 = Date.parse('2026-11-22T00:00:00Z');
const at = (minutes) => T0 + minutes * 60_000;

/** 三条“人话”记录 + 两条老记录（没有 roomId） */
function fixture() {
  return [
    { id: 'a1', at: at(0), roomId: 'r1', botId: 'b1', action: 'write_file', result: 'allow', code: '', grantId: 'g1' },
    { id: 'a2', at: at(10), roomId: 'r1', botId: 'b2', action: 'run_command', result: 'deny', code: 'no_grant' },
    { id: 'a3', at: at(20), roomId: 'r2', botId: 'b1', action: 'write_file', result: 'deny', code: 'revoked' },
    { id: 'old1', at: at(30), botId: 'b3', action: 'write_file', result: 'allow', code: '' },
    { id: 'old2', at: at(40), botId: 'b4', action: 'run_command', result: 'deny', code: 'no_grant' },
  ];
}

test('按 roomId 过滤：只出这个房间的，老记录（没 roomId）不串进来', () => {
  const r = queryAudit(fixture(), { roomId: 'r1' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map((x) => x.id), ['a2', 'a1'], '默认按时间倒序');
});

test('按 botId / action / result / code / grantId 过滤', () => {
  assert.deepEqual(queryAudit(fixture(), { botId: 'b1' }).items.map((x) => x.id), ['a3', 'a1']);
  assert.equal(queryAudit(fixture(), { action: 'run_command' }).total, 2);
  assert.equal(queryAudit(fixture(), { result: 'deny' }).total, 3);
  assert.equal(queryAudit(fixture(), { code: 'revoked' }).total, 1);
  assert.equal(queryAudit(fixture(), { grantId: 'g1' }).total, 1);
});

test('时间窗是闭区间；只给 from / 只给 to 都能用（毫秒与 ISO 都认）', () => {
  const onlyFrom = queryAudit(fixture(), { from: at(10) });
  assert.equal(onlyFrom.total, 4, '含端点 at(10)');
  assert.ok(onlyFrom.items.every((x) => x.at >= at(10)));

  const onlyTo = queryAudit(fixture(), { to: at(10) });
  assert.equal(onlyTo.total, 2);
  assert.ok(onlyTo.items.every((x) => x.at <= at(10)));

  const iso = queryAudit(fixture(), { from: '2026-11-22T00:10:00Z', to: '2026-11-22T00:20:00Z' });
  assert.deepEqual(iso.items.map((x) => x.id), ['a3', 'a2']);
  assert.equal(toMillis('2026-11-22T00:10:00Z'), at(10));
});

test('分页：total 是命中总数，nextOffset 给下一页（null = 到底了）', () => {
  const page1 = queryAudit(fixture(), { limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.deepEqual(page1.items.map((x) => x.id), ['old2', 'old1']);
  assert.equal(page1.nextOffset, 2);

  const page2 = queryAudit(fixture(), { limit: 2, offset: 2 });
  assert.deepEqual(page2.items.map((x) => x.id), ['a3', 'a2']);
  assert.equal(page2.nextOffset, 4);

  const last = queryAudit(fixture(), { limit: 2, offset: 4 });
  assert.deepEqual(last.items.map((x) => x.id), ['a1']);
  assert.equal(last.nextOffset, null);
});

test('order=asc 正序；limit 超过上限被夹住', () => {
  const asc = queryAudit(fixture(), { order: 'asc', limit: 3 });
  assert.deepEqual(asc.items.map((x) => x.id), ['a1', 'a2', 'a3']);

  const big = queryAudit(fixture(), { limit: 9999 });
  assert.equal(big.filter.limit, AUDIT_QUERY_MAX_LIMIT, 'limit 必须有上限');
});

test('非法过滤直接报 AUDIT_QUERY_INVALID，不能变成“查到 0 条”', () => {
  assert.throws(() => queryAudit(fixture(), { from: at(30), to: at(10) }), /from 不能晚于 to/);
  assert.throws(() => queryAudit(fixture(), { limit: 0 }), (err) => err.code === 'AUDIT_QUERY_INVALID');
  assert.throws(() => queryAudit(fixture(), { offset: -1 }), (err) => err.code === 'AUDIT_QUERY_INVALID');
  assert.throws(() => queryAudit(fixture(), { from: '不是时间' }), (err) => err.code === 'AUDIT_QUERY_INVALID');
});

test('汇总：结果分布 / 动作分布 / 拒绝码分布（按全部命中算，不是当前页）', () => {
  const { hits } = filterAudit(fixture(), { result: 'deny' });
  const s = summarizeAudit(hits);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byResult, { allow: 0, deny: 3 });
  assert.equal(s.byAction.run_command, 2);
  assert.equal(s.denyByCode.no_grant, 2);
  assert.equal(s.lastAt, at(40));
});

test('没有 at 的老记录：给时间窗时被排除（而不是被当成 1970 算进来）', () => {
  const list = [{ id: 'no-at', roomId: 'r1', action: 'x', result: 'allow' }];
  assert.equal(queryAudit(list, { roomId: 'r1' }).total, 1);
  assert.equal(queryAudit(list, { roomId: 'r1', from: at(0) }).total, 0);
});

test('网关真的把 roomId 记进审计（按房间查得到）', () => {
  const state = { grants: [], grantAudit: [] };
  const bus = { emit() {} };
  const store = {
    state,
    scheduleSave() {},
    policyVersion: () => 1,
  };
  const gate = createGrantGate({
    store,
    bus,
    currentPolicyRevision: () => 1,
    currentGeneration: () => 'gen-1',
    // 没有任何授权 → 必定拒绝，并且拒绝也要留痕
    syncGrants: null,
  });

  const verdict = gate.check({
    roomId: 'dm_chief',
    subject: { botId: 'chief', role: 'main' },
    action: 'write_file',
    targets: [{ kind: 'file', ref: 'a.txt' }],
  });
  assert.equal(verdict.ok, false);
  assert.equal(state.grantAudit.length, 1, '拒绝也必须留一条审计');
  assert.equal(state.grantAudit[0].roomId, 'dm_chief', '审计必须带 roomId');

  const found = queryAudit(state.grantAudit, { roomId: 'dm_chief' });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].result, 'deny');
  assert.equal(queryAudit(state.grantAudit, { roomId: '别的房间' }).total, 0);
});

console.log(`\naudit-query: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
