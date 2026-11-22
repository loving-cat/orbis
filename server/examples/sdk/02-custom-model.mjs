/**
 * 示例 02 · 自定义模型：自己配 provider（baseUrl / apiKey / 模型清单）。
 *
 *   node examples/sdk/02-custom-model.mjs
 *   # 真跑（会联网）：
 *   ORBIS_EXAMPLE_LIVE=1 OPENAI_BASE_URL=... OPENAI_API_KEY=... \
 *     node examples/sdk/02-custom-model.mjs
 *
 * 不设 `ORBIS_EXAMPLE_LIVE` 时用离线桩，只说明“配置长什么样、怎么生效”。
 */
import { createOrbisRuntime } from 'orbis-agent/sdk';
import { demoOptions } from './_offline.mjs';

const LIVE = process.env.ORBIS_EXAMPLE_LIVE === '1';

/** 你要用的模型组：一个 baseUrl 可以挂多个模型，`api` 决定请求/响应格式 */
const modelGroups = [
  {
    name: 'my-provider',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    api: 'openai-completions', // 或 'anthropic-messages' / 'openai-responses'
    models: [
      { id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 },
      { id: 'gpt-4o-mini', contextWindow: 128000, maxTokens: 16384 },
    ],
  },
];
console.log('模型组配置（真跑时原样传进 createOrbisRuntime）：', JSON.stringify(modelGroups, null, 2));

/** @type {import('orbis-agent/sdk').OrbisRuntimeOptions} */
const options = demoOptions();
if (LIVE) {
  // 真跑：换成自己的 provider，并且去掉离线桩（这两行就是“换成真模型”的全部改动）
  Object.assign(options, { modelGroups, defaultModel: 'my-provider/gpt-4o' });
  delete options.modelRuntimeFactory;
  delete options.sessionApi;
}

const runtime = await createOrbisRuntime(options);

try {
  console.log('可用模型：', runtime.runner.availableModels.map((m) => `${m.provider}/${m.id}`).join(', ') || '（无）');
  console.log('当前默认：', `${runtime.runner.model?.provider}/${runtime.runner.model?.id}`);

  if (LIVE) {
    // 换默认模型：只影响之后的轮次，不动已有会话
    const picked = await runtime.models.setDefaultModel('my-provider/gpt-4o-mini');
    console.log('切换默认模型：', picked.ok ? 'ok' : picked.error);
    console.log('当前默认：', `${runtime.runner.model?.provider}/${runtime.runner.model?.id}`);
    const res = await runtime.askMain('用一句话说明你正在用哪个模型');
    console.log('回答：', res.replyText);
  } else {
    console.log('（离线模式：把 ORBIS_EXAMPLE_LIVE=1 与 OPENAI_API_KEY 设上就会真的调模型）');
  }
} finally {
  await runtime.dispose();
}
