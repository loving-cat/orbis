/**
 * 示例 07 · 注入点：把 Orbis 接到**你自己的**基础设施上。
 *
 *   node examples/sdk/07-injection.mjs
 *
 * 六类注入点里最常用的三条路：
 *   ① 全内存（`memory: true`）：跑一次、一个字节都不写盘；
 *   ② 共享总线（`bus`）：把 Orbis 的事件并进宿主的日志/指标管道；
 *   ③ 换模型运行时（`modelRuntime`）：宿主已经预热好的那个直接用。
 *
 * 细节见 docs/SDK.md 的「六类注入点」。
 */
import { createOrbisRuntime, createBus, createStore } from 'orbis-agent/sdk';
import { demoOptions, offlineModelRuntimeFactory } from './_offline.mjs';

// ① 全内存：连数据目录都不建（这里故意给一个不存在的路径）
const memoryRuntime = await createOrbisRuntime(
  demoOptions({ dataDir: '.orbis-demo/never-created', memory: true, store: createStore({ memory: true }) }),
);
try {
  console.log('内存模式 store.memory =', memoryRuntime.store.memory);
  console.log('run-stats 落盘文件 =', JSON.stringify(memoryRuntime.runner.stats.file), '（空串 = 不落盘）');
  const res = await memoryRuntime.askMain('内存里跑一轮');
  console.log('照样能跑：', res.replyText);
} finally {
  await memoryRuntime.dispose();
}

// ② 共享总线：宿主自己的监听与 SDK 的事件走同一条线
const bus = createBus();
const types = new Set();
const hostListener = (ev) => types.add(ev.t);
bus.on('event', hostListener);

const sharedRuntime = await createOrbisRuntime(demoOptions({ bus }));
try {
  await sharedRuntime.askMain('共享总线上跑一轮');
  // 等 run.settled 的去抖窗口过去（150ms）
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log('宿主在共享总线上看到的事件：', [...types].sort().join(', '));
} finally {
  // dispose 只摘 SDK 自己挂的监听；宿主这条还在（共享总线不能被顺手清空）
  await sharedRuntime.dispose();
  console.log('dispose 后宿主监听还在：', bus.listeners('event').includes(hostListener));
  bus.off('event', hostListener);
}

// ③ 换模型运行时：宿主预热好的实例直接交给 runtime，不再自己建
const modelRuntime = await offlineModelRuntimeFactory();
const custom = await createOrbisRuntime(demoOptions({ modelRuntime, modelGroups: undefined }));
try {
  console.log('用的就是宿主那个实例：', custom.runner.modelRuntime === modelRuntime);
} finally {
  await custom.dispose();
}
