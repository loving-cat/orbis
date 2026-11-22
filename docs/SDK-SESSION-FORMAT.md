# SDK 会话文件格式（JSONL）

本文是**会话可移植性契约**：工具/脚本按本文手搓出来的会话文件，Orbis 必须能加载；
反过来，Orbis 写出来的文件也必须长得像本文。底层实现是
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的 `SessionManager`，本文描述的是它的事实格式（`version: 3`）。

守这条契约的测试：`server/tests/sdk-session-format.mjs`（它会把本文下面那段示例
**从文档里抠出来**直接喂给 `SessionManager.open()`，所以文档写错会红）。

---

## 一、文件放在哪

| 谁决定 | 值 |
|---|---|
| 目录 | `<dataDir>/sessions/` |
| 文件名 | 由 pi 生成：`<ISO 时间戳>_<uuid>.jsonl`（如 `2026-11-22T08-20-06-769Z_01a20257-….jsonl`） |
| 映射 | `state.json` 的 `sessions["<roomId>:<botId>"] = "<绝对路径>"` |

要点：

- **文件名不要自己编**：pi 用时间戳 + uuid，只是为了让目录好看、可排序；
  Orbis 从来不靠文件名找会话，靠的是 `state.json` 里那条映射
  （`store.sessionFileFor(roomId, botId)` / `store.setSessionFile(...)`）。
- 一个 `(房间, Bot)` 一条会话：同一 Bot 在不同群里互不干扰，这是 Orbis 的
  会话键设计（`sessionKey(roomId, botId)`）。
- 映射缺失或文件不存在 → 建一条新会话；映射存在且文件存在 →
  `SessionManager.open()` 接着写。
- 内存模式（`memory: true` / 旁路 Talk）**完全不落盘**，也不写映射。

## 二、一行的格式

整个文件是**追加写的 JSONL**：一行一个 JSON 对象，**第一行必须是会话头**，
之后每一行是一条 entry。entry 之间靠 `id` / `parentId` 组成一棵树（分叉 = 重试/编辑），
`parentId: null` 是根。

★ **链必须接得上**：正常追加时新 entry 的 `parentId` 就是上一条的 `id`。
"当前语境"是从**最后一条 entry（叶子）**沿着 `parentId` 往回走得到的 ——
所以手搓时如果某条的 `parentId` 写错（或者最后多出一条 `parentId: null` 的孤立 entry），
前面好好的历史在上下文里会**整段消失**（文件里还在，只是不在当前这条链上）。

```jsonc
// 第一行：会话头（一次）
{ "type": "session", "version": 3, "id": "<会话 uuid>", "timestamp": "<ISO>", "cwd": "<工作目录>" }

// 之后：entry（追加）
{ "type": "message", "id": "a1b2c3d4", "parentId": null, "timestamp": "<ISO>", "message": { … } }
```

`id` 是短 id（8 位十六进制），只在**同一个文件内**唯一；`timestamp` 是 ISO 字符串。
`cwd` 是建会话时的工作目录（Orbis 传的是 `config.workspace`）。

### entry 类型

| `type` | 进上下文？ | 作用 |
|---|---|---|
| `message` | ✅ | 一条消息（user / assistant / toolResult …），`message` 字段是原始消息对象 |
| `model_change` | ❌ | 记录切过模型：`{ provider, modelId }` |
| `thinking_level_change` | ❌ | 记录思考档位变化：`{ thinkingLevel }` |
| `usage` | ❌ | 模型用量记账：`{ kind, provider, model, usage, note? }` |
| `compaction` | ✅（替换前缀） | 压缩摘要：`{ summary, firstKeptEntryId, tokensBefore, details?, usage? }` |
| `branch_summary` | ✅ | 分叉摘要：`{ fromId, summary, details?, usage? }` |
| `custom` | ❌ | 扩展自己的数据：`{ customType, data? }`（重启后靠它重建扩展状态） |
| `custom_message` | ✅（转成 user 消息） | 扩展注入的上下文：`{ customType, content, display, details? }` |
| `context_edit` | ✅（替换/删除目标） | 只追加的语境修订：`{ targetId, replacement }`，`replacement: null` = 从上下文里去掉 |
| `label` | ❌ | 书签：`{ targetId, label }` |
| `session_info` | ❌ | 会话展示名：`{ name }` |

`message` 里的 `role` 目前是 `user` / `assistant` / `toolResult`，`content` 是块数组
（`{ "type": "text", "text": "…" }`、`{ "type": "image", "data": "<base64>", "mimeType": "…" }`、
`{ "type": "toolCall", … }`）。工具结果用 `toolResult` 角色并带 `toolCallId`。

## 三、最小可加载示例

<!-- session-example:start -->
```jsonl
{"type":"session","version":3,"id":"01a20257-51f0-77a4-9c4b-dcd4e4c62f77","timestamp":"2026-11-22T08:20:06.769Z","cwd":"/tmp/orbis-demo"}
{"type":"message","id":"cbd6544f","parentId":null,"timestamp":"2026-11-22T08:20:06.769Z","message":{"role":"user","content":[{"type":"text","text":"你好，先看下 server/src/http.js 的鉴权。"}]}}
{"type":"message","id":"ff909316","parentId":"cbd6544f","timestamp":"2026-11-22T08:20:06.770Z","message":{"role":"assistant","content":[{"type":"text","text":"看过了：nonce 校验在 requireAdmin 里，一次性有效。"}],"usage":{"input":1,"output":2,"totalTokens":3}}}
{"type":"model_change","id":"5554997f","parentId":"ff909316","timestamp":"2026-11-22T08:20:06.770Z","provider":"offline","modelId":"demo-1"}
```
<!-- session-example:end -->

把这段存成 `demo.jsonl`，然后让某个 `(房间, Bot)` 用它：

```js
import { createOrbisRuntime } from 'orbis-agent/sdk';

const runtime = await createOrbisRuntime({ /* dataDir / workspace / modelGroups … */ });
const chief = runtime.store.mainBot();
const dm = runtime.store.ensureDm(chief.id);
// 这一行就是"接上已有会话"的全部魔法：只登记路径，不搬文件
runtime.store.setSessionFile(dm.id, chief.id, '/abs/path/demo.jsonl');
await runtime.askMain('接着刚才那条说');   // 下一轮会 SessionManager.open() 这个文件，并继续追加
```

不需要改 `state.json` 再重启 —— `setSessionFile()` 会自己排一次落盘。

## 四、兼容与容错

- **读出宽容**：不认识的 `version`、解析不了的坏行、未知 `type` 都不会抛异常
  （这是 pi 的行为，别为了"严格"去改它 —— 用户的历史不能因为一行坏了就打不开）。
  但注意上一节那条：宽容的是"不炸"，**不是**"当作没发生" —— 叶子变了，
  上下文跟着变。坏行没有 `id` / 解析不出来时会整行丢弃，不影响链；
  未知 `type` 若挂在链上只是不进上下文。
- **写入严格**：Orbis / pi 只写 `version: 3` 与上表列出的 `type`。要加新 `type`
  必须同时改本文与该测试。
- **追加不改写**：文件只往后追加（压缩、分支也是追加 `compaction` / `branch_summary`
  entry），所以任何时刻中断都不会损坏已写的历史。
- **压缩不删历史**：`compaction` entry 只是让"从哪开始算上下文"往后挪
  （`firstKeptEntryId`），原消息仍在文件里。

## 五、几条别做的事

- 不要手改 `id` / `parentId` 链去"整理"历史 —— 树一旦有环，加载会出问题；
  要换语境就追加 `context_edit` 或 `compaction`。
- 手搓时别把新 entry 写成 `parentId: null`：那会另起一条根，当前语境变成空的。
  要么接上一条的 `id`，要么就从头造一条完整链。
- 不要把敏感信息塞进 `custom` / `custom_message`：它们和聊天记录同盘，
  且会被导出工具原样带走。
- 不要为了"省空间"删中间行：那是就地改写，会破坏 append-only 的前提。
