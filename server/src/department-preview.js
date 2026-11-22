/**
 * 部门模板预览（纯逻辑）：**开之前先看清会开出来什么样**。
 *
 * 为什么需要它：模板里装的是"人 + 人设 + 模型 + 技能"，而真正影响安全的是
 * **每个人会拿到哪些工具/能力**。规格 §P2 点名要"模板权限差异预览" ——
 * 用户点"照这个模板开一个"之前，得能看见"这个负责人比普通成员多了什么"、
 * "这个模板会不会带出一个能写文件的人"，而不是开完再去授权页对着看。
 *
 * 三条边界（别越界）：
 *   1. **只算不写**：不碰 store、不建 bot、不发事件；输入是纯数据。
 *   2. **与真实创建同源**：角色到工具的映射直接复用 `role-tools.js`，
 *      不在这里另抄一份表（抄一份就会慢慢和真实行为不一样）。
 *   3. **重名即复用**：真实创建时重名的人不会新建（`createDepartment`），
 *      预览必须说清"这个人是复用的现成的"，否则用户以为会新建一个。
 */

import { toolsForPolicy } from './role-tools.js';

/**
 * 预览一个将要创建的部门。
 *
 * @param {{name?:string, topic?:string, lead?:string|null, members?:Array<object>}} input
 *   与 `store.createDepartment()` 同形（模板就传模板对象本身）。
 * @param {{existingBots?:Array<{id:string,name:string}>,
 *          leadTools?:string[], memberTools?:string[], policy?:object,
 *          maxMembers?:number|null}} [opts]
 *   `leadTools` / `memberTools` 来自 config；`existingBots` 用来判"重名复用"。
 * @returns {{
 *   ok: boolean, error?: string,
 *   room: {name:string, topic:string, memberCount:number, leadName:string|null, leadFallback:boolean},
 *   members: Array<{name:string, role:'lead'|'member', reused:boolean, existingId:string|null,
 *                   tools:string[], added:string[], removed:string[], skills:number, mcp:number}>,
 *   warnings: string[]
 * }}
 */
export function previewDepartment(input = {}, opts = {}) {
  const {
    existingBots = [],
    leadTools = [],
    memberTools = [],
    policy = {},
    maxMembers = null,
  } = opts;

  const name = String(input?.name ?? '').trim();
  if (!name) return fail('部门要有名字');
  const members = (Array.isArray(input?.members) ? input.members : []).filter((m) => m && String(m.name ?? '').trim());
  if (!members.length) return fail('至少要有一个人');
  if (maxMembers && members.length > maxMembers) return fail(`人太多了（上限 ${maxMembers}）`);

  const warnings = [];
  const byName = new Map(existingBots.map((b) => [b.name, b]));
  const baseline = toolsForPolicy(memberTools, policy);
  const leadToolsResolved = toolsForPolicy(leadTools, policy);

  /**
   * 老大按名字匹配；匹配不上退回第一个人（与 `createDepartment` 一致）。
   * 这里必须显式告诉用户"没匹配上、退回了谁" —— 否则他以为自己指定的人在场。
   */
  const wantedLead = input?.lead ? String(input.lead) : null;
  const matchedLead = wantedLead ? members.find((m) => m.name === wantedLead) : null;
  const leadFallback = Boolean(wantedLead) && !matchedLead;
  if (leadFallback) {
    warnings.push(`指定的负责人「${wantedLead}」不在成员里，会退回第一个人（${members[0].name}）`);
  }
  const effectiveLeadName = matchedLead?.name ?? (wantedLead ? members[0].name : members[0].name);
  if (!wantedLead) warnings.push(`没指定负责人，会默认由第一个人（${members[0].name}）带`);

  const seen = new Set();
  const out = members.map((m) => {
    const memberName = String(m.name).trim();
    const isLead = memberName === effectiveLeadName;
    const tools = isLead ? leadToolsResolved : baseline;
    const existing = byName.get(memberName) ?? null;
    if (existing) warnings.push(`「${memberName}」已经存在，会直接复用（不会新建一个人）`);
    if (seen.has(memberName)) warnings.push(`成员「${memberName}」在模板里重复了，只会建一次`);
    seen.add(memberName);

    return {
      name: memberName,
      role: isLead ? 'lead' : 'member',
      reused: Boolean(existing),
      existingId: existing?.id ?? null,
      tools: [...tools],
      // 「差异」相对一个刚建的普通成员：多了什么、少了什么
      added: tools.filter((t) => !baseline.includes(t)),
      removed: baseline.filter((t) => !tools.includes(t)),
      skills: Array.isArray(m.skills) ? m.skills.length : 0,
      mcp: Array.isArray(m.mcpServers) ? m.mcpServers.length : 0,
    };
  });

  if (out.length === 1) warnings.push('只有一个人：部门群里没人可协作，普通私聊更合适');
  if (out.some((m) => m.tools.includes('bash') || m.tools.includes('write'))) {
    warnings.push('这个部门里有人能跑命令 / 写文件：开之前确认你真的要给他们这个能力');
  }

  return {
    ok: true,
    room: {
      name,
      topic: String(input?.topic ?? ''),
      memberCount: out.length,
      leadName: effectiveLeadName,
      leadFallback,
    },
    members: out,
    warnings,
  };
}

function fail(error) {
  return {
    ok: false,
    error,
    room: { name: '', topic: '', memberCount: 0, leadName: null, leadFallback: false },
    members: [],
    warnings: [],
  };
}
