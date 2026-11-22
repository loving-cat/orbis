/**
 * 示例 05 · 事件订阅与 `run.settled`：怎么判断“这一轮真的完了”。
 *
 *   node examples/sdk/05-events.mjs
 *
 * 为什么不能自己数 `msg.done`：一轮里可能还有排队请求、合并窗、主控汇总在后头跑。
 * `run.settled` 是**房间安静下来**（没有 bot 在跑、排队队列空）之后才发的，
 * 带 `roomId / botId / ok / reason / generation`，去抖 150ms，不会连发。
 */
import { createOrbisRuntime } from 'orbis-agent/sdk';
import { demoOptions } from './_offline.mjs';

const runtime = await createOrbisRuntime(demoOptions());

/** 收到的事件类型（去重后打印，便于看清一轮里到底发生了什么） */
const seen = new Set();
const settledEvents = [];

const off = runtime.onEvent((ev) => {
  seen.add(ev.t);
  if (ev.t === 'run.settled') settledEvents.push(ev);
});

try {
  const res = await runtime.askMain('随便说一句');
  console.log('回答：', res.replyText);

  // 等去抖窗口过去
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log('本轮收到的事件类型：', [...seen].sort().join(', '));
  console.log('run.settled 次数：', settledEvents.length);
  if (settledEvents.length) {
    const ev = settledEvents[0];
    console.log('  roomId =', ev.roomId, '| ok =', ev.ok, '| reason =', ev.reason, '| generation =', ev.generation);
  }
} finally {
  off(); // 退订：共享总线时这一步尤其重要（否则监听会一直挂着）
  await runtime.dispose();
}
