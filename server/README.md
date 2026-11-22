# orbis-agent

**Orbis** —— 一套可嵌入的多智能体基座：一个 Node 进程里可以起多套互相隔离的
`runtime`，每套都有自己的数据目录、事件总线、模型组与 Bot 部门。

它是 [Orbis 桌面/安卓 App](https://github.com/loving-cat/orbis) 的服务端，也是
可以直接 `import` 的 SDK —— App、Jarvis 工具、你自己的脚本走的是同一条主干。

## 安装

```bash
npm i orbis-agent
```

## 最小用法

```js
import { createOrbisRuntime } from 'orbis-agent/sdk';

const runtime = await createOrbisRuntime({
  dataDir: './.orbis-state',
  workspace: process.cwd(),
  modelGroups: [
    {
      name: 'default',
      baseUrl: 'https://api.example.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      api: 'openai-completions',
      models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }],
    },
  ],
  defaultModel: 'default/gpt-4o',
});

try {
  const res = await runtime.askMain('总结这个仓库最近三次提交的风险点');
  console.log(res.replyText);
} finally {
  await runtime.dispose();
}
```

不想落盘就跑内存模式：`createOrbisRuntime({ memory: true })`。

## 入口

| 入口 | 用途 |
|---|---|
| `orbis-agent/sdk` | 进程内嵌入：`createOrbisRuntime`、`defineTool`、`Type` |
| `orbis-agent/client` | 连一个已经在跑的服务端（HTTP + WebSocket） |
| `orbis-agent/capabilities` | 能力清单与动作目录（单一事实源） |
| `orbis-agent/server` | 常驻服务端进程（App 连的就是它） |

## 文档

- [`docs/SDK.md`](docs/SDK.md)：四层单骨架、六类注入点、类型与扩展方式
- [`examples/sdk/`](examples/sdk/)：七个可直接运行的例子（离线桩，不要 API key）
- 仓库主文档：<https://github.com/loving-cat/orbis>

## 版本

当前是 `2.0.0-alpha`：SDK 门面（`createOrbisRuntime` / 错误契约 / 生命周期 /
注入点 / 类型）已经稳定下来，但**破坏性变更仍可能出现在 alpha 之间**；
稳定版是 `1.7.x`。稳定档位与弃用流程见仓库的 `docs/SDK-STABILITY.md`（T2.9 落地）。

## 许可证

MIT
