# Orbis SDK 与单骨架说明

`Orbis`（包名 `orbis-agent`）不只是配套 App 的服务端，它和底层 `@earendil-works/pi-coding-agent` 一样，是一套可被外部程序直接嵌入或远程调用的**多智能体基座**。

---

## 一、四层单骨架

| 层 | 核心模块 | 职责 |
|---|---|---|
| **1. 实例原语与纯算法** | `brand.js` / `config.js` / `bus.js` / `store.js` / `model-groups.js` / `capabilities.js` / `grants.js` | `createConfig`（优先读取 `ORBIS_*`，兼容 `PI_BOT_*`）、`createBus`、`createStore`、`createModelGroupStore` 按实例隔离数据目录与事件流，仅 `import` 不碰全局磁盘；能力、授权与调度规则保存在单一声明源。 |
| **2. 多智能体编排内核** | `session-factory.js` / `pi-runner.js` / `policy-hook.js` / `mcp-hook.js` | 负责单 Bot 单轮运行、模型熔断与多端点轮转、全双工旁路响应、部门 `@提及` 并发轮次引擎与空回复三层恢复。 |
| **3. 应用服务与 SDK 门面** | `services/*` / `sdk/index.js` / `sdk/client.js` | 把 Bot/部门、模型组、定时任务、技能/MCP 与全局策略收束到唯一的领域服务层（UI、Jarvis 工具、SDK 三端同源）。 |
| **4. 宿主适配外壳** | `server-main.js` / `http.js` / `ws.js` / `tools.js` / `jarvis-tools.js` | HTTP/WS 协议传输、一次性 nonce 鉴权、以及给大模型调用的 Schema 包装，自身不复制业务规则。 |

---

## 二、进程内嵌入（`orbis-agent/sdk`）

适合将 `Orbis` 直接作为 Node 库嵌入脚本、CLI、自动化编排或自定义宿主；同一进程内可以按需启动多套互相隔离的 `runtime`。

```js
import { createOrbisRuntime } from 'orbis-agent/sdk';

const runtime = await createOrbisRuntime({
  dataDir: './.orbis-state',
  workspace: '/path/to/your/project',
  userName: 'Alice',
  modelGroups: [
    {
      name: 'default',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '<YOUR_API_KEY>',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }],
    },
  ],
  policy: { dangerous: 'allow', requireProof: true },
});

const unsub = runtime.onEvent((ev) => {
  if (ev.t === 'msg.delta') process.stdout.write(ev.text ?? '');
});

// 1. 直接与主控（mainBot / Orbis）对话并等待本轮结果
const mainReply = await runtime.askMain('总结这个仓库最近三次提交的风险点');
console.log(mainReply.replyText);

// 2. 通过领域服务管理多 Bot 部门与系统设置（与 App / Jarvis 工具同一条主干）
const { room } = runtime.rooms.createDepartment({
  name: '代码审查组',
  lead: '审查组长',
  members: [
    { name: '审查组长', role: 'lead', persona: '拆解审查清单并汇总结论' },
    { name: '安全专家', persona: '专注鉴权、注入与敏感信息检查' },
  ],
});
await runtime.send(room.id, '请 @安全专家 重点审计 server/src/http.js');

unsub();
await runtime.dispose(); // 清空会话、停掉定时器与总线监听，事件循环可直接退出
```

> 2.0 起旧别名 `createPiBotRuntime` / `createPiBotClient` / `PiBotClient` **已删除**：
> 迁移就是把 import 换成 `createOrbisRuntime` / `createOrbisClient` / `OrbisClient`（签名一致）。

### `createOrbisRuntime` 主要字段

- `runtime.askMain(text, opts)`：向主控发消息并等待其完成回复，返回 `{ roomId, userMessage, reply, replyText }`。
- `runtime.send(roomId, text, opts)`：向任意私聊或部门群发消息（异步触发编排轮次，结合 `onEvent` 订阅流式输出）。
- `runtime.runBotOnce({ roomId, botId, prompt, timeoutMs, meta })`：在指定会话跑完单次 Bot 回合。
- `runtime.bots` / `runtime.rooms` / `runtime.models` / `runtime.automations` / `runtime.capabilities` / `runtime.policy`：对应 `server/src/services/*` 的领域服务实例。
- `runtime.abort(roomId)` / `runtime.reset(roomId)` / `runtime.dispose()`。

### 六类注入点（T2.3）

全部**可选**，默认值 = 不注入时的老行为（零破坏）。

| 字段 | 传什么 | 默认 |
|---|---|---|
| `config` | `createConfig({...})` 的**整份配置**，或普通对象（按字段覆盖） | 由 `createConfig` 按 `dataDir` / `workspace` / 环境变量算 |
| `store` | `createStore({ memory: true })` 或任何 Store 实现 | 建一个真实的 `Store`（会写 `state.json`） |
| `bus` | `createBus()` 或共享总线 | 新建一条总线 |
| `modelRuntime` | 已建好的模型运行时**实例**（可与别人共用） | 调 `modelRuntimeFactory` / `ModelRuntime.create()` |
| `resourceLoader` | 工厂函数 `(defaults) => loader`，每次建会话调一次 | `new sessionApi.DefaultResourceLoader(defaults)` |
| `tools` / `customTools` | `tools`：追加启用的**内置工具名**；`customTools`：`defineTool()` 的**工具对象** | 只有角色本来该有的那些 |

补充约定：

- **谁建谁拆**：注入的 `store` / `bus` / `modelGroupStore` 归调用方所有，`dispose()` 不会去拆；但本 runtime 经 `onEvent()` 自己挂上的监听会被**逐条摘掉**（共享总线上别人的监听不受影响）。
- **`store` 与 `bus` 是同一根神经**：只给 `store` 时直接沿用它的 `store.bus`（否则 store 发出的 `policy.updated` / `bot.updated` 会落在另一条线上，谁也收不到）；同时给两个且不是同一条会报 `E_INVALID_ARGUMENT`，不替调用方猜。
- `memory: true`（或传一个 `memory: true` 的 store）＝ **真的不吃盘**：连数据目录都不建，`state.json` / `rooms/` / `taskruns/` / `sessions/` / `run-stats.json` 全不写（会话走 `SessionManager.inMemory`），也不会去删宿主的 `instances/`。
- `tools` / `customTools` 必须是数组（`customTools` 每项要带 `name`），否则 `E_INVALID_ARGUMENT` —— 与 `resourceLoader` 一致，不静默当空数组。
- `customTools` / `tools` 追加进来的东西**要走同一道角色与 policy 过滤** —— 往只读角色的会话里塞写工具会被挡掉，注入不是绕过策略的后门。

### 审计与部门预览（T2.10）

```js
// 授权审计检索：按房间 / Bot / 动作 / 结果 / 时间窗（闭区间，毫秒或 ISO 都认）过滤
const page = runtime.capabilities.queryAudit({
  roomId: room.id,
  from: '2026-11-22T00:00:00Z',
  result: 'deny',
  limit: 50,          // 上限 200
  offset: 0,          // 返回 { total, items, nextOffset }
});
const stat = runtime.capabilities.auditSummary({ roomId: room.id }); // 结果/动作/拒绝码分布

// 部门模板预览：开之前先看清会开出来什么样、每个人会拿到哪些工具
const plan = runtime.rooms.previewDepartment({ templateId: 'tpl_xxx' });
// → { room: {leadName, leadFallback, memberCount}, members: [{role, tools, added, removed, reused}], warnings }
```

- 审计记录由授权网关（`grant-gate`）在**每次判定**时写一条（含 `roomId`），本接口只读。
- 预览与真实创建**同源**：角色到工具的映射复用 `role-tools.js`，所以预览说"这个负责人多两个工具"就是真的多两个。
- HTTP 侧同款：`GET /api/audit`、`GET /api/audit/summary`、`POST /api/departments/preview`。

### 稳定档位

每个导出都有 `stable` / `beta` / `internal` 三档之一，档位与弃用流程见
[`docs/SDK-STABILITY.md`](SDK-STABILITY.md)。一句话版：`stable` 保证「一版弃用、一版删除」，
`internal` 别用（兼容别名与派生层都在这一档）。

### 会话文件（可移植）

会话是**一条 `(房间, Bot)` 一份的 JSONL 文件**，格式与接线见
[`docs/SDK-SESSION-FORMAT.md`](SDK-SESSION-FORMAT.md)：文件在 `<dataDir>/sessions/`，
`state.json` 的 `sessions["<roomId>:<botId>"]` 存它的绝对路径；
`runtime.store.setSessionFile(roomId, botId, file)` 这一行就能接上**外部造好的**会话。

### 类型（TypeScript）

声明文件由 **JSDoc 生成**（`server/tsconfig.types.json` → `server/types/`，不入库，`npm run types` 随时重生），`exports` 每一项都带了 `types`，所以 `import { createOrbisRuntime } from 'orbis-agent/sdk'` 开箱就有类型：

```ts
import { createOrbisRuntime, defineTool, Type } from 'orbis-agent/sdk';
import type { OrbisRuntime, OrbisRuntimeOptions } from 'orbis-agent/sdk';
```

- `OrbisRuntimeOptions` / `OrbisRuntime` 是手写的 JSDoc typedef（`src/sdk/index.js`），**与本文表格是同一份契约的两种写法**，改一边必须改另一边。
- `defineTool()` 的 `parameters` 要 typebox 的 `TSchema`，所以 `Type` 由 SDK 重导出 —— 宿主不用自己装 typebox（版本必须与 pi 内部那个一致）。
- 门禁：`npm run check:types` 用 `tsc --noEmit` 检查 `examples/sdk/`，改错字段名会在 CI 上红（`.github/workflows/ci.yml` 的 `sdk-types` job）。

---

## 三、远程调用已运行的 Orbis 服务端（`orbis-agent/client`）

如果桌面端或常驻服务已经在后台运行，可以通过 HTTP + WebSocket 客户端连过去，服务端管理员接口所需的一次性 `nonce` 会自动向 `/api/local-nonce` 申请。

```js
import { createOrbisClient } from 'orbis-agent/client';

const client = createOrbisClient({
  baseUrl: 'http://127.0.0.1:8787',
  dataDir: process.env.ORBIS_HOME || process.env.PI_BOT_HOME, // 自动读取 local-token，也可直接传 token
});

const conn = await client.connectEvents((ev) => {
  if (ev.t === 'msg.done') console.log(ev.msg?.authorName, ev.msg?.text);
});

const rooms = await client.listRooms();
const dm = rooms.find((r) => r.kind === 'dm');
await client.send(dm.id, '帮我列出当前启用的定时任务');

await conn.close();
```

---

## 四、扩展能力（单一事实源）

新增内置工具或高风险能力时：
1. 在 `server/src/capabilities.js` 的 `ACTIONS` 与 `TOOL_SPECS` 中登记动作归属、风险级别、是否可撤销与目标提取规则（`action-catalog`、`role-tools`、`migration-grants` 会自动派生）；
2. 用从 `orbis-agent/sdk` 重导出的 `defineTool` 定义 Schema 与执行逻辑（共享逻辑优先放进 `server/src/services/*`）；
3. 运行 `cd server && node scripts/check-capability-drift.mjs && node scripts/check-consistency.mjs` 守住防漂移不变量。
