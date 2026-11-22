/**
 * 示例 06 · 经验库读写：propose → 人审批 → activate。
 *
 *   node examples/sdk/06-lessons.mjs
 *
 * 规矩（SIM-Lite）：
 *   · 一条经验必须有 `cue`（什么情况下用得上）与 `lesson`（下次具体怎么做）；
 *   · `propose()` **永远只产出 candidate**，即使传了 `status: 'active'` 也会被改回去；
 *   · 要生效必须显式 `activate()` —— 而它自己会校验证据、以及有没有否决/降级边。
 */
import { createOrbisRuntime } from 'orbis-agent/sdk';
import { demoOptions } from './_offline.mjs';

const runtime = await createOrbisRuntime(demoOptions());

try {
  const lessons = runtime.lessons;

  // ① 提一条候选：cue = 什么时候用得上，lesson = 下次怎么做
  const proposed = lessons.propose({
    cue: '改完代码准备提交之前',
    lesson: '先跑 check-style / check-consistency / tests/all.mjs 三个守卫，全绿再提交。',
    scope: 'repo',
    // 证据必须是「原话」（quote）+ 出处（taskId / msgId 可选）—— 不接受自由格式
    evidence: [{ taskId: 'demo-1', quote: '跑完三个守卫再提交，别再让 CI 红一次。' }],
    status: 'active', // ← 会被强制降回 candidate
  });
  console.log('propose：', proposed.ok === false ? proposed.error : `ok（id=${proposed.lesson?.id}）`);

  const list = lessons.list();
  const first = list[0];
  if (!first) throw new Error('示例预期至少有一条 candidate');
  console.log('候选数量：', list.length, '| 状态：', first.status);

  // ② 审批通过（真实场景里这一步是人在 App 里点的按钮）
  const activated = lessons.activate(first.id);
  console.log('activate：', activated?.ok === false ? activated.error : 'ok');
  console.log('按任务预览会被注入哪几条：', lessons.preview('改完代码该怎么提交').lines.length, '行');

  // ③ 记错了 → 否决 + 归档；撤销否决之后才能再激活
  const rejected = lessons.reject(first.id);
  console.log('reject：', rejected?.ok === false ? rejected.error : 'ok');
  console.log('reject 后的状态：', lessons.list()[0]?.status);
  const unrejected = lessons.unreject(first.id);
  console.log('unreject：', unrejected?.ok === false ? unrejected.error : 'ok');
} finally {
  await runtime.dispose();
}
