/**
 * 示例 04 · 多 Bot 部门：建部门、@成员、等这一轮落定。
 *
 *   node examples/sdk/04-department.mjs
 *
 * 部门 = 一个群聊 + 若干 bot + 一个负责人（lead）。
 * 用户 @谁，就只有谁那一支并行跑；@部门负责人 则由它拆解再派工。
 */
import { createOrbisRuntime } from 'orbis-agent/sdk';
import { demoOptions } from './_offline.mjs';

const runtime = await createOrbisRuntime(demoOptions());

try {
  const { room } = runtime.rooms.createDepartment({
    name: '代码审查组',
    lead: '审查组长',
    members: [
      { name: '审查组长', role: 'lead', persona: '负责拆解审查清单并汇总结论' },
      { name: '安全专家', persona: '专注鉴权、注入与敏感信息检查' },
    ],
  });
  console.log('部门群：', room.name, `(${room.id})`);
  console.log('成员：', runtime.rooms.get(room.id).botIds.join(', '));

  // 等这一轮真的结束：run.settled 在“房间安静下来”之后才发（去抖 150ms）
  const settled = new Promise((resolve) => {
    const off = runtime.onEvent((ev) => {
      if (ev.t === 'run.settled' && ev.roomId === room.id) {
        off();
        resolve(ev);
      }
    });
  });

  await runtime.send(room.id, '请 @安全专家 看一下 server/src/http.js 的鉴权');
  const ev = await settled;
  console.log('这一轮落定：ok=', ev.ok, 'reason=', ev.reason);
} finally {
  await runtime.dispose();
}
