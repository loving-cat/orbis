/**
 * 部门模板预览（路线图 §4 T2.10）：开之前先看清会开出来什么样。
 *   node tests/department-preview.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **预览与真实创建同源**：同样的输入，预览说的名字/负责人必须和真建出来的一致
 *    （否则预览就是另一个故事，用户会照着它做决定）。
 * 2. **权限差异看得见**：负责人比普通成员多/少哪些工具，要显式列出来。
 * 3. **重名即复用**：真实创建时重名的人不会新建，预览必须提前说。
 * 4. **只读策略生效**：`policy.dangerous === 'deny'` 时，预览里也不该出现写工具 ——
 *    算"预览"的时候就不该用一套宽松口径。
 */
import assert from 'node:assert/strict';

import { previewDepartment } from '../src/department-preview.js';
import { createStore } from '../src/store.js';
import { createBotService } from '../src/services/bot-service.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

const LEAD_TOOLS = ['read', 'write', 'edit', 'bash', 'list_bots', 'dispatch_bot'];
const MEMBER_TOOLS = ['read', 'write', 'edit', 'bash'];

const template = {
  name: '代码审查组',
  topic: '审查 PR 的安全与性能',
  lead: '审查组长',
  members: [
    { name: '审查组长', persona: '拆解清单并汇总', emoji: '🧭' },
    { name: '安全专家', persona: '盯鉴权与注入', skills: [{ title: 'a', howto: 'b' }] },
  ],
};

await test('基本形状：部门信息 / 成员角色 / 权限差异', () => {
  const p = previewDepartment(template, { leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS });
  assert.equal(p.ok, true);
  assert.equal(p.room.name, '代码审查组');
  assert.equal(p.room.memberCount, 2);
  assert.equal(p.room.leadName, '审查组长');
  assert.equal(p.room.leadFallback, false);

  const lead = p.members.find((m) => m.name === '审查组长');
  const member = p.members.find((m) => m.name === '安全专家');
  assert.equal(lead.role, 'lead');
  assert.equal(member.role, 'member');
  // 负责人比普通成员多的工具要显式列出来
  assert.deepEqual(lead.added, ['list_bots', 'dispatch_bot']);
  assert.deepEqual(lead.removed, []);
  assert.deepEqual(member.added, []);
  assert.equal(member.skills, 1);
});

await test('负责人名字对不上 → 退回第一个人，并且明确告警（不能悄悄换人）', () => {
  const p = previewDepartment({ ...template, lead: '不存在的人' }, {
    leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS,
  });
  assert.equal(p.room.leadFallback, true);
  assert.equal(p.room.leadName, '审查组长');
  assert.ok(p.warnings.some((w) => w.includes('不存在的人')), p.warnings.join(' | '));
});

await test('重名的人会被复用：预览必须说清（不然用户以为会新建一个）', () => {
  const p = previewDepartment(template, {
    existingBots: [{ id: 'b_existing', name: '安全专家' }],
    leadTools: LEAD_TOOLS,
    memberTools: MEMBER_TOOLS,
  });
  const reused = p.members.find((m) => m.name === '安全专家');
  assert.equal(reused.reused, true);
  assert.equal(reused.existingId, 'b_existing');
  assert.ok(p.warnings.some((w) => w.includes('已经存在')), p.warnings.join(' | '));
});

await test('只读策略：预览里也不出现写/命令工具', () => {
  const p = previewDepartment(template, {
    leadTools: LEAD_TOOLS,
    memberTools: MEMBER_TOOLS,
    policy: { dangerous: 'deny' },
  });
  for (const m of p.members) {
    assert.equal(m.tools.includes('bash'), false, `${m.name} 不该有 bash`);
    assert.equal(m.tools.includes('write'), false, `${m.name} 不该有 write`);
  }
});

await test('非法输入给出人话原因：没名字 / 没人 / 人太多 / 单人要提醒', () => {
  assert.match(previewDepartment({ members: [{ name: 'a' }] }).error, /名字/);
  assert.match(previewDepartment({ name: 'x', members: [] }).error, /至少/);
  assert.match(
    previewDepartment(template, { maxMembers: 1 }).error,
    /上限 1/,
    '超过人数上限要报原因',
  );
  const one = previewDepartment({ name: 'x', members: [{ name: 'a' }] }, { leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS });
  assert.ok(one.warnings.some((w) => w.includes('只有一个人')), one.warnings.join(' | '));
});

await test('服务层：预览与真实创建同源（名字 / 负责人 / 复用）', async () => {
  const store = createStore({ memory: true });
  const { rooms } = createBotService({ store, config: { leadTools: LEAD_TOOLS, tools: MEMBER_TOOLS } });
  const input = {
    name: '爬虫攻坚组',
    topic: '抓数据',
    lead: '调度',
    members: [
      { name: '调度', persona: '排期' },
      { name: '抓取', persona: '写采集' },
      { name: '清洗', persona: '洗数据' },
    ],
  };
  const preview = rooms.previewDepartment(input);
  assert.equal(preview.ok, true);
  assert.equal(preview.room.leadName, '调度');

  const created = store.createDepartment(input);
  const createdNames = created.bots.map((b) => b.name).sort();
  const previewNames = preview.members.map((m) => m.name).sort();
  assert.deepEqual(createdNames, previewNames, '预览的人必须和真建出来的一致');
  const leadBot = created.bots.find((b) => b.id === created.room.leadBotId);
  assert.equal(leadBot?.name, preview.room.leadName, '负责人也必须一致');

  // 再预演一次：这次所有人都应该被标成"复用"
  const again = rooms.previewDepartment(input);
  assert.equal(again.members.every((m) => m.reused), true, '第二遍应当全是复用');
});

await test('服务层：按 templateId 预览模板', async () => {
  const store = createStore({ memory: true });
  const { rooms } = createBotService({ store, config: { leadTools: LEAD_TOOLS, tools: MEMBER_TOOLS } });
  const created = store.createDepartment(template);
  const saved = store.saveTemplateFromRoom(created.room.id, { name: '审查模板' });
  assert.ok(saved?.template?.id, JSON.stringify(saved));

  const p = rooms.previewDepartment({ templateId: saved.template.id });
  assert.equal(p.ok, true);
  assert.equal(p.templateId, saved.template.id);
  assert.equal(p.room.memberCount, template.members.length);

  const missing = rooms.previewDepartment({ templateId: '不存在' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'TEMPLATE_NOT_FOUND');
});

await test('名字带空格：先 trim 再匹配负责人（不能让全员都不匹配）', () => {
  const input = {
    name: '  测试组  ',
    lead: ' 组长 ',
    members: [{ name: ' 组长 ' }, { name: ' 组员 ' }],
  };
  const p = previewDepartment(input, { leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS });
  assert.equal(p.ok, true);
  assert.equal(p.room.name, '测试组');
  assert.equal(p.room.leadName, '组长');
  assert.equal(p.room.leadFallback, false, `不该退回：${p.warnings.join(' | ')}`);
  assert.equal(p.members.find((m) => m.name === '组长').role, 'lead');
  assert.equal(p.members.find((m) => m.name === '组员').role, 'member');
});

await test('单人部门：按 isLeadOfRoom 的规则，不按负责人那套算工具', () => {
  const p = previewDepartment(
    { name: '一个人', members: [{ name: '独苗' }] },
    { leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS },
  );
  const only = p.members[0];
  assert.equal(only.role, 'member', '成员 <2 时谁都不是负责人（role-tools.js 的规则）');
  assert.deepEqual(only.tools, [...MEMBER_TOOLS], '工具要按普通成员算');
  assert.deepEqual(only.added, []);
  assert.ok(p.warnings.some((w) => w.includes('只有一个人')), p.warnings.join(' | '));
});

await test('多人部门：负责人仍然拿 lead 工具（单人的特殊化不能波及多人）', () => {
  const p = previewDepartment(template, { leadTools: LEAD_TOOLS, memberTools: MEMBER_TOOLS });
  const lead = p.members.find((m) => m.name === '审查组长');
  assert.equal(lead.role, 'lead');
  assert.deepEqual(lead.added, ['list_bots', 'dispatch_bot']);
});

console.log(`\ndepartment-preview: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
