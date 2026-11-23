/**
 * `normalizePlan`：计划里的「交给谁」必须落成**真实名字**。
 *
 *   node tests/task-plan-tool.mjs
 *
 * ## 为什么这条要单独守
 *
 * 模型手里既有成员名字也有 botId，它经常直接把 `member` 填成 `b_xxxx`。
 * 早期实现把这个字符串原样存进 `memberName`，于是：
 *   · 任务详情/右侧面板的「负责人」那一列显示一串 id（用户原话「露出 botId」）；
 *   · 派活时 `memberName` 又不等于任何成员名字，跨房间的活直接派不出去。
 * 现在凡是能解析成成员的，一律存 `member.name`；解析不到的才原样保留，
 * 由投影层再用 `nameOf` 兜一次。
 *
 * 顺带守住「跨房间/主控私聊」这条：`buildPlanTool` 的候选成员是
 * 房间成员 + 花名册兜底，不能只看 `room.botIds`。
 */
import assert from 'node:assert/strict';

const { normalizePlan, renderPlan, planMembersFor } = await import('../src/tasks/task-plan-tool.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { failed++; console.log(`✗ ${name}: ${err.message}`); }
}

const members = [
  { id: 'b_main', name: '主控', role: 'main' },
  { id: 'b_fin', name: '财务建模师', role: 'member' },
  { id: 'b_data', name: '数据核验员', role: 'member' },
];

test('★ member 填 botId 时，memberName 存真实名字（不是 id）', () => {
  const out = normalizePlan([{ member: 'b_fin', task: '写出核算口径' }], members);
  assert.equal(out.ok, true);
  assert.equal(out.steps[0].memberBotId, 'b_fin');
  assert.equal(out.steps[0].memberName, '财务建模师', '存 id 会让界面显示 b_fin');
});

test('member 填名字时照常解析出 botId', () => {
  const out = normalizePlan([{ member: '数据核验员', task: '盘点数据集' }], members);
  assert.equal(out.steps[0].memberBotId, 'b_data');
  assert.equal(out.steps[0].memberName, '数据核验员');
});

test('assignee 是别名，同样按 id / 名字两路解析', () => {
  const out = normalizePlan([
    { assignee: 'b_data', task: 'a' },
    { assignee: '财务建模师', task: 'b' },
  ], members);
  assert.deepEqual(out.steps.map((s) => s.memberName), ['数据核验员', '财务建模师']);
  assert.deepEqual(out.steps.map((s) => s.memberBotId), ['b_data', 'b_fin']);
});

test('解析不到的人名原样保留（不猜、不丢），memberBotId 为 null', () => {
  const out = normalizePlan([{ member: '还没入职的同事', task: 'x' }], members);
  assert.equal(out.steps[0].memberName, '还没入职的同事');
  assert.equal(out.steps[0].memberBotId, null);
});

test('没写 member 时退回「未指定」，不会被渲染成空负责人', () => {
  const out = normalizePlan([{ task: 'x' }], members);
  assert.equal(out.steps[0].memberName, '未指定');
  assert.equal(out.steps[0].memberBotId, null);
});

test('renderPlan 读的是 memberName：不会把 id 写进给模型看的那段文本', () => {
  const out = normalizePlan([{ member: 'b_fin', task: '写出核算口径' }], members);
  const text = renderPlan(out.steps);
  assert.match(text, /财务建模师：写出核算口径/);
  assert.equal(text.includes('b_fin'), false, `计划文本里露出了 botId：${text}`);
});

test('成员表里有重名时，第一个生效且不互相覆盖（name → member 一对一）', () => {
  const dup = [
    { id: 'b_1', name: '同名', role: 'member' },
    { id: 'b_2', name: '同名', role: 'member' },
  ];
  const byId = normalizePlan([{ member: 'b_2', task: 'x' }], dup);
  assert.equal(byId.steps[0].memberName, '同名');
  assert.equal(byId.steps[0].memberBotId, 'b_2', '按 id 指定时必须精确到那一只');
});

test('空成员表也不崩：id 解析不到就原样留着', () => {
  const out = normalizePlan([{ member: 'b_fin', task: 'x' }], []);
  assert.equal(out.steps[0].memberName, 'b_fin');
  assert.equal(out.steps[0].memberBotId, null);
});

/** 假 store：房间成员 + 花名册，形状与真实 store 的 listBots/getBot/getRoom 一致。 */
function fakeStore({ roomIds = [], bots = [] } = {}) {
  const byId = new Map(bots.map((b) => [b.id, b]));
  return {
    getRoom: (id) => (id === 'r_main' ? { id, botIds: roomIds } : null),
    getBot: (id) => byId.get(id) ?? null,
    listBots: () => bots,
  };
}

test('★ 候选成员 = 房间成员 + 花名册兜底（跨房间/主控私聊也能解析）', () => {
  const store = fakeStore({
    roomIds: ['b_main', 'b_fin'],
    bots: [
      { id: 'b_main', name: '主控', role: 'main' },
      { id: 'b_fin', name: '财务建模师', role: 'member' },
      { id: 'b_ops', name: '运维工程师', role: 'member' }, // 别的房间
    ],
  });
  const got = planMembersFor(store, 'r_main');
  assert.deepEqual(got.map((m) => m.id), ['b_main', 'b_fin', 'b_ops'], '房间成员排前面，其余按花名册补');
  // 兜底进来的那只也能把 id 解析成名字：这才是「跨房间不露 botId」的保证
  const out = normalizePlan([{ member: 'b_ops', task: '把服务发上去' }], got);
  assert.equal(out.steps[0].memberName, '运维工程师');
  assert.equal(out.steps[0].memberBotId, 'b_ops');
});

test('候选成员按 id 去重，不重复堆同一个人', () => {
  const store = fakeStore({
    roomIds: ['b_main', 'b_main'],
    bots: [
      { id: 'b_main', name: '主控', role: 'main' },
      { id: 'b_main', name: '主控', role: 'main' },
    ],
  });
  assert.deepEqual(planMembersFor(store, 'r_main').map((m) => m.id), ['b_main']);
});

test('房间不存在 / store 缺方法时退化成花名册，不抛', () => {
  const noRoom = fakeStore({ bots: [{ id: 'b_ops', name: '运维工程师', role: 'member' }] });
  assert.deepEqual(planMembersFor(noRoom, 'r_missing').map((m) => m.id), ['b_ops']);
  const bare = { getRoom: () => null };
  assert.deepEqual(planMembersFor(bare, 'r_main'), []);
});

console.log(`\ntask-plan-tool：${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
