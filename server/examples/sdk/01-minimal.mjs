/**
 * 示例 01 · 最小嵌入：5 行拿到一个能干活的多智能体 runtime。
 *
 *   node examples/sdk/01-minimal.mjs
 *
 * 示例默认走离线桩（不联网、不要 key）。要接真实模型，把
 * `modelRuntimeFactory` / `sessionApi` 两行删掉，并填上 `modelGroups`：
 *
 *   modelGroups: [{ name: 'default', baseUrl: 'https://api.xxx/v1', apiKey: process.env.KEY,
 *                   api: 'openai-completions',
 *                   models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }] }]
 */
import { createOrbisRuntime } from 'orbis-agent/sdk';
import { demoOptions } from './_offline.mjs';

const runtime = await createOrbisRuntime(demoOptions());

try {
  // ① 直接和主控说话：等待这一轮跑完
  const res = await runtime.askMain('用一句话介绍你自己');
  console.log('主控：', res.replyText);

  // ② 挂个事件订阅（App 里那些流式气泡就是靠它）
  const off = runtime.onEvent((ev) => {
    if (ev.t === 'msg.delta') process.stdout.write(ev.text ?? '');
    if (ev.t === 'run.settled') console.log(`\n[settled] room=${ev.roomId} ok=${ev.ok}`);
  });
  await runtime.askMain('再说一句');
  off();
  console.log('本次运行标记：', runtime.generation);
} finally {
  // ③ 一定要 dispose：定时器、会话、落盘节流都在里面收尾
  const r = await runtime.dispose();
  console.log('已收尾：', r.ok ? 'ok' : JSON.stringify(r.failed));
}
