# SDK 稳定档位与弃用流程

`orbis-agent` 的每个导出都有一个**档位**，档位决定"你能指望它多稳"。
档位的唯一事实源是 [`server/src/sdk/stability.js`](../server/src/sdk/stability.js)；
`server/tests/sdk-contract.snapshot.json` 会把每个导出的档位一起锁住 ——
**新增导出必须显式定档**，忘了会在 CI 上红。

---

## 一、三档

| 档位 | 承诺 | 动了会怎样 |
|---|---|---|
| **`stable`** | 宿主可以长期依赖：名字、签名、语义、返回字段都不变 | 破坏性变更必须**一版弃用、一版删除**（见下） |
| **`beta`** | 方向已定，细节可能动 | 允许在 minor 里改，但必须写进 CHANGELOG 并给迁移说明 |
| **`internal`** | 随时可能改或删，宿主不该直接用 | 不通知 |

判断标准只有一条：**"别人照着它写业务代码，我们好意思半年后断他吗"**。
好意思 → `stable`；不太好意思但得先跑起来看看 → `beta`；本来就是我家的螺丝 → `internal`。

同一个名字在所有入口（`.` / `./sdk` / `./client` / `./capabilities`）里**必须是同一档** ——
否则"从哪个入口 import"会变成语义差异，那是没人能记住的坑（契约测试会查这条）。

## 二、当前清单

### `stable`（可以放心用）

| 导出 | 用途 |
|---|---|
| `createOrbisRuntime` | 起一个 runtime（SDK 主入口） |
| `createOrbisClient` | 连一个已经在跑的服务端 |
| `defineTool` / `Type` | 定义工具（宿主扩展能力的唯一正路） |
| `OrbisError` / `ORBIS_ERROR_CODES` / `orbisError` / `isOrbisError` / `asOrbisError` | 错误契约 |
| `BRAND_NAME` / `BRAND_SLUG` | 品牌常量（别从字符串里抄名字） |

### `beta`（能用，但会比 stable 动得多）

`createConfig` / `createBus` / `createStore` / `createModelGroupStore`（低阶构件）、
`OrbisClient`（类本体，一般用 `createOrbisClient`）、
`ACTIONS` / `ACTION` / `TOOL_SPECS` / `auditCapabilities`（能力清单）。

### `internal`（别用）

`createServices`，以及 `./capabilities` 里那一堆派生层
（`TOOLS` / `MUTATING_TOOLS` / `READONLY_ALLOW` / `riskOf` / `actionForTool` …）。
它们随时会随内部结构变，宿主要的是**查询**，不是这份表本身。

## 三、破坏性变更流程：一版弃用、一版删除

"破坏性"包括：改名、删导出、改签名（哪怕只是加必填参数）、
改返回字段名/形状、**改语义**（同样的调用结果不一样了）、把 `stable` 降档。

以 `v2.1` 想把 `foo()` 改成 `bar(foo, options)` 为例：

| 版本 | 做什么 |
|---|---|
| `v2.0` | 加 `bar()`；`foo()` 仍在，内部转调 `bar()`，控制台打一条 `deprecated` 警告（每进程一次）；`docs/SDK-STABILITY.md` 标注「`foo()` 将在 v2.1 移除」；CHANGELOG 的 `### Deprecated` 段落写明替换方式与迁移示例 |
| `v2.1` | 删 `foo()`；CHANGELOG 的 `### Breaking` 段落给出「从 v2.0 升上来的操作步骤」 |

硬要求：

- **必须有至少一个版本的过渡期**（`v2.0 → v2.1` 这种相邻两个 release 就算）。
  突发断供（同一个版本里既弃用又删）只允许一种情况：那个导出有**安全漏洞**（凭据泄漏、越权）。
- **警告要说清替换方法**，不能只写一句 "foo is deprecated"。
- **降档也算破坏性变更**：`stable → beta` 要走同样的流程。
- **升档不花钱**，但要改 `stability.js`（快照随之更新，diff 里能看见）。

## 四、alpha / beta 期间的例外

当前版本是 `2.0.0-beta.1`，`stable` 档的承诺**已经开始生效**（上面那张表就是承诺）。
但整个包还没到 GA：`beta` 档的东西在 `2.0.0-beta.x` / `rc.1` 之间可能直接改，
只在 CHANGELOG 里说明，不保证一个版本的过渡期。

到 `2.0.0` 正式版之后，本文的三条流程就是硬约定。

## 五、怎么检查自己用的东西是哪档

```js
// 档位表是内部模块（不进公开导出），但你可以直接读仓库里那份：
//   server/src/sdk/stability.js
```

或者看契约快照里每个导出的 `stability` 字段：

```bash
cd server
node tests/sdk-contract.mjs      # 5 条全绿 = 导出的形状与档位都没静默变化
```

CI 上 `SDK-C5` 这条会拦住两种事：**新增导出没定档**、**同一名字在不同入口不同档**。
