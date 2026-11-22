/**
 * 示例 03 · 工具注入 + 只读策略边界。
 *
 *   node examples/sdk/03-tools.mjs
 *
 * 三件事：
 *   ① `customTools` 挂宿主自己的工具（`defineTool` + `Type` 都从 SDK 拿）；
 *   ② `tools` 追加启用内置工具名；
 *   ③ `policy: { dangerous: 'deny' }` 下两者都会被**同一道**过滤挡掉 ——
 *      注入工具是"我能给你什么"，不是"我能替你破规矩"。
 */
import { createOrbisRuntime, defineTool, Type } from 'orbis-agent/sdk';
import { demoOptions, offlineSessionApi } from './_offline.mjs';

/** 一个最小的自定义工具：返回当前工作目录 */
const repoRoot = defineTool({
  name: 'repo_root',
  label: '工作目录',
  description: '返回当前工作目录（演示用，不带参数）',
  parameters: Type.Object({}),
  async execute() {
    /** @type {{type: 'text', text: string}} */
    const block = { type: 'text', text: process.cwd() };
    return { content: [block], details: {} };
  },
});

/** 每次建会话的入参桩都会记在 `lastSessionOptions` 上，好让示例能验证结果 */
const api = offlineSessionApi();
const runtime = await createOrbisRuntime(
  demoOptions({ sessionApi: api, customTools: [repoRoot], tools: ['git_status'] }),
);

try {
  await runtime.askMain('随便说一句');
  const opts = api.lastSessionOptions;
  console.log('注入的工具进了 customTools：', (opts?.customTools ?? []).some((t) => t.name === 'repo_root'));
  console.log('追加启用的内置工具进了 tools：', (opts?.tools ?? []).includes('git_status'));
} finally {
  await runtime.dispose();
}

// 只读策略：同样的注入，两个都被拦掉
const readonlyApi = offlineSessionApi();
const readonly = await createOrbisRuntime(
  demoOptions({
    sessionApi: readonlyApi,
    customTools: [repoRoot],
    tools: ['bash'],
    policy: { dangerous: 'deny' },
  }),
);
try {
  await readonly.askMain('随便说一句');
  const opts = readonlyApi.lastSessionOptions;
  console.log('只读策略下 bash 被拦：', !(opts?.tools ?? []).includes('bash'));
  console.log('只读策略下 repo_root 被拦：', !(opts?.customTools ?? []).some((t) => t.name === 'repo_root'));
} finally {
  await readonly.dispose();
}
