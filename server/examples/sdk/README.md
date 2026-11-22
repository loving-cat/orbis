# SDK 示例

七个小例子，每个都能**直接跑**（默认用离线桩：不联网、不要 API key）：

```bash
cd server
node examples/sdk/01-minimal.mjs        # 最小嵌入：5 行拿到一个能对话的 runtime
node examples/sdk/02-custom-model.mjs   # 自定义模型：baseUrl / apiKey / 模型清单
node examples/sdk/03-tools.mjs          # 工具注入 + 只读策略的边界
node examples/sdk/04-department.mjs     # 多 Bot 部门：建部门、@成员、等落定
node examples/sdk/05-events.mjs         # 事件订阅与 run.settled
node examples/sdk/06-lessons.mjs        # 经验库：propose → 审批 → activate
node examples/sdk/07-injection.mjs      # 注入点：内存 / 共享总线 / 换模型运行时
```

状态默认写在**当前目录**的 `.orbis-demo/`（已在 `.gitignore` 里）。想清干净就
`rm -rf .orbis-demo`。

## 换成真模型

每个示例顶部都写了怎么换。共性只有两处：

```js
// ① 填模型组
modelGroups: [{ name: 'default', baseUrl, apiKey, api: 'openai-completions', models: [...] }],
defaultModel: 'default/<模型 id>',

// ② 删掉离线桩这两个参数（真实运行用的是 pi 自己的会话与模型运行时）
// modelRuntimeFactory: ...,
// sessionApi: ...,
```

`_offline.mjs` 不是 SDK 的一部分，只是示例的脚手架；把示例搬到自己项目里时不需要它。

## 类型

示例是被 `tsc` 真正检查的（`server/tsconfig.examples.json`）：

```bash
cd server
npm install          # 需要 devDependency typescript
npm run types        # 由 JSDoc 生成 server/types/（发布前 prepack 也会跑）
npm run check:types  # tsc --noEmit 检查本目录的示例
```
