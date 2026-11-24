# 规格：性能治理与平台层原生化（SPEC-PERF-V1）

> **状态**：已拍板 · **M1 进行中**（§11 已定稿）
> **对应基线**：`feat/long-task-autonomy` @ `30c2126`（开发分支 `feat/perf-v1`）
> **适用范围**：`server/src/` 后台进程管理、模型请求失败判定、附件解析、Windows 桌面输入/观察、落盘；`app/lib/` 流式渲染；`native/` 新增 Windows 桌面助手
> **关联文档**：`docs/ARCHITECTURE.md`（§五 性能）、`docs/WINDOWS-SANDBOX.md`、`docs/MACOS-DESKTOP-INPUT.md`、`docs/STORAGE-RETENTION.md`、`docs/REAL-MACHINE-CHECKLIST.md`
> **核心定位**：**先量后改，Rust 只进平台层。** 实测显示，用户感知到的“慢”有四分之三在等模型，一半以上的运行时长耗在最终失败的运行上；Orbis 自身的 JS 开销是毫秒级。真正值得原生化的只有一处：Windows 桌面操作（每次调用都现起 PowerShell、现编译 C#）。其余问题都是**主线程同步阻塞**和**每帧全量重算**，在 JS / Dart 里修。

---

## 0. 五条硬规矩

1. **先量后改**：每个工作项都要带可复现的测量脚本（§10），提交说明里写改前 / 改后数字。没有数字的“优化”不合入。
2. **不整体重写**：业务逻辑留在 JS / Dart。Rust 只用于必须直调 Win32 的平台层（沙箱、桌面输入/观察、进程树），不新增 C++。
3. **服务端主线程不长阻塞**：运行期路径（请求、工具、流式、定时任务）禁止新增 `spawnSync` / `execSync` / `Atomics.wait` / 大文件同步解析。启动期与 CLI 工具不受此限。目标：正常运行时事件循环单次卡顿 ≤ 50 ms。
4. **用户可见语义不变**：不丢活（`runner/group-retry.js` 的阶梯退避与 1 小时上限不变）；WS 协议不变（`msg.delta` 仍下发全文）；落盘格式可回读（旧数据目录直接能用）。
5. **原生组件 fail-closed、可回退**：沿用 `orbis-sandbox` 的做法（版本常量 + sha256 清单 + 打包缺失时黄字警告）。缺二进制或版本不符时，回退到旧实现或明确报错码，绝不静默“假成功”。

---

## 1. 立项实测（为什么是这些项）

### 1.1 方法

- **数据**：一台 Windows 11 开发机的真实数据目录，包括 `run-stats.json`（104 次运行，约 7 天）、`sessions/*.jsonl`（65 个会话文件）、`rooms/`、`uploads/`。只做聚合统计，不读正文。
- **基准**：直接 `import` 仓库里的模块（`change-watch.js`、`extract.js`、`desktop-observe.js`、`desktop-input-win.js`、`shells.js`、pi `SessionManager`），在临时目录读写副本，不碰原数据。
- **事件循环卡顿**：用 5 ms 间隔的 `setInterval` 探针量最大间隔。`monitorEventLoopDelay` 在 `await` 刚返回就关闭时会漏记同步阻塞，所以不用它。
- 脚本整理后进仓库，见 §10。数字是**立项基线**，验收时用同一脚本重测对比。

### 1.2 时间花在哪

按会话文件里每条消息的时间戳切分（相邻消息间隔超过 15 分钟算用户空闲，不计入）：

| 指标 | 实测 |
|---|---|
| 活跃时间构成 | **等模型 75%**（2139 轮）/ 跑工具 25%（1841 批） |
| 模型单轮（发起到整条回复落盘） | p50 5.8 s · p90 14.1 s |
| 工具单批 | p50 0.2 s · p90 4.5 s |
| 工具耗时大头 | `bash`（1532 次，p50 0.2 s，p90 10.7 s，慢的是命令本身：装依赖、构建、测试） |
| 本地工具 `read` / `write` / `ls` | p90 ≤ 0.2 s |
| 每次运行的输入 token | p50 约 40 万 · p90 约 248 万 · 最大约 1430 万 |
| 缓存命中（`cacheRead / inputTotal`） | p50 0.92；87 次里有 25 次低于 0.5 |

**结论**：服务端整体换语言，影响不到这 75%。

### 1.3 失败的运行

| 指标 | 实测 |
|---|---|
| 运行结局 | 104 次中 77 次正常结束；15 次 `error`，12 次 `retrying` |
| **耗在最终没成功的运行上的时长** | **占全部运行时长的 53%** |
| 失败运行从开始到判定失败 | **p50 364 s** · p90 600 s（只有 4 次是撞上 10 分钟时间片） |
| 失败运行内的尝试次数（`attempts`） | p50 11（全部失败运行合计 145 次重试） |
| 成功运行耗时 | p50 40 s |
| 端点情况 | 两个在用的模型组都只有 1 个端点，`#tryRotateEndpoint` 无路可切 |

失败判定中位数 364 s，与看门狗阈值 `stallMs`（默认 360 000 ms，`watchdog.js:32` / `config.js:235`）几乎重合。同时 `auto_retry_start` 在 `runner/turn-executor.js:535` 只计数（`meter.retry()`），既不刷心跳，也不喂熔断器。**这些数据能定位到“失败要拖约 6 分钟、期间 SDK 内部重试了约 10 次”，但还拆不出这 6 分钟里有多少是等待、多少是请求挂住**，所以 §4 第一步先补埋点。

### 1.4 本地阻塞点

| 路径 | 实测 | 事件循环 |
|---|---|---|
| Windows `listWindows()`（`desktop-observe.js:306`） | 852–885 ms / 次 | **全程卡住**（`spawnSync`） |
| Windows `cursorPosition()` / `lastInputAt()`（`desktop-input-win.js`） | 约 360 ms / 次 | 全程卡住 |
| 对照：空跑 `powershell -Command 1` | 169 ms | — |
| 对照：PowerShell + `Add-Type` 一小段 P/Invoke | 344 ms | — |
| 对照：Rust 程序单次进程（`orbis-sandbox.exe version`） | **22 ms** | — |
| 一次点击（`desktop-input-session.js` 全链路，按代码路径估算） | 7–10 次 PowerShell 启动 ≈ 2.5–3.5 s | 全程卡住，等待用 `Atomics.wait`（`desktop-input-win.js:721`） |
| 附件解析：1.25 MB PDF（`extract.js`，pdf.js 在主线程） | 231 ms | **卡 247 ms** |
| 附件解析：6 万行 xlsx（合成，19 MB，SheetJS 同步） | 1064 ms | **卡 1066 ms**，期间所有房间的流式输出都停 |
| 落盘 `saveNow()`：`state.json` + 最大房间文件 | 3.5 ms + 2.9 ms = 6.4 ms | 流式期间每 300 ms 一次，约占 2% |
| 服务端冷启动：加载整个模块图 | 约 2.0 s（其中 pi 引擎 1.15 s） | 启动期 |

冷启动的 CPU profile 显示：文件系统调用约 1.0 s（`internalModuleStat` 484 ms、`lstat` 246 ms、`open` 187 ms，加上读文件），JS 编译只占约 230 ms。开启 `NODE_COMPILE_CACHE` 实测无改善。

### 1.5 进程泄漏（缺陷）

- 开发机上一天内累积了 **91 个孤儿 `node` 进程，合计约 3.9 GB**，每 7 个一批，均来自反复运行 `tests/shells.mjs`，父进程都已退出。
- 复现：用 `ShellRegistry` 起 3 个后台进程，再逐个 `kill()`。`kill()` 返回 `{ok:true, wasRunning:true}`，**3 秒后 3 个真正干活的进程全部存活**。所以这不只是测试问题：生产环境里 bot 的后台进程（开发服务器等）被“结束”后，会继续占着端口和内存。
- 根因与已验证的修法见 §3。

### 1.6 测过、不是瓶颈的

| 路径 | 实测 |
|---|---|
| 工作区快照 `snapshotWorkspace`（每轮 2 次） | 322 个文件 16–20 ms（上限 6000 个文件） |
| 打开 3.4 MB 会话（736 条消息）+ 构建上下文 | 11–14 ms |
| 服务端常驻内存（空闲） | 约 64 MB |
| 工具步骤 `msg.steps` 负载 | 每条消息 p50 1.2 KB，p90 8.5 KB，最大 19 KB |
| bot 消息正文长度 | p50 123 字，p90 约 2300 字，p99 约 5000 字，最大约 8200 字 |
| 头像动画 | 只有干活中的 bot 常驻动画，空闲会自动休眠（`widgets/blob_avatar.dart`） |

---

## 2. 工作项总表

| ID | 项 | 层 | 语言 | 预期收益 | 依赖 |
|---|---|---|---|---|---|
| **P0-1** | 后台进程树泄漏 | server | JS | 杀得干净；停止泄漏内存和端口 | — |
| **P1-1** | 上游失败快速判定与早切换（含埋点） | server | JS | 失败判定从约 6 分钟降到约 2 分钟内 | — |
| **P1-2** | Windows 原生桌面助手 · 阶段 A（单次进程，同步 API 不变） | native + server | Rust + JS | 每次调用约 360 ms → 约 25 ms；单次卡顿 ≤ 50 ms | — |
| **P2-1** | 附件解析移出主线程 | server | JS | 大文件解析不再卡住全服 | — |
| **P2-2** | 客户端流式增量渲染 | app | Dart | 每帧开销不再随消息长度增长 | — |
| **P2-3** | 桌面助手 · 阶段 B（常驻 + 异步 + 截图） | native + server | Rust + JS | 每次调用 ≤ 2 ms；桌面操作零阻塞 | P1-2 |
| **P2-4** | 流式期间不重写 `state.json` | server | JS | 流式落盘开销约减半 | — |
| **P3-1** | 冷启动打包（调研，有门槛才做） | server / 打包 | JS | 冷启动 2.0 s → ≤ 1.0 s | — |
| **P3-2** | 客户端大 JSON 解码放进 isolate | app | Dart | 打开大房间不掉帧 | — |
| **P3-3** | 所有后台进程挂 Job Object（可选） | native + server | Rust + JS | 服务端崩溃也不留孤儿 | P0-1 |

---

## 3. P0-1 后台进程树泄漏

### 3.1 根因

`shells.js:460` 的 `#terminateEntry`（Windows、非沙箱分支）：

```js
spawn('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
// ……没有等它跑完
try { entry.child.kill(); } catch {}
```

后台命令以 `shell: true` 启动，实际进程树是 `node(server) → cmd.exe → node / python …`。`taskkill` 还没来得及按父子关系枚举，`child.kill()` 已经先把 `cmd.exe` 结束了。之后 `taskkill /T` 找不到这个 PID，孙进程就成了孤儿。

- `stopAll()`（`shells.js:444`）走同一个函数，所以服务端正常收工（`server-main.js:462`）时也会漏。
- `tests/shells.mjs` 末尾直接 `process.exit()`，`unref()` 过的 `taskkill` 可能根本没执行，于是每跑一次漏 7 个。

### 3.2 方案

1. **先树后根**：先启动 `taskkill /PID <pid> /T /F`，等它的 `exit` 事件（超时 5 s），再 `child.kill()`。**不用 `spawnSync`**（硬规矩 3）。
2. `kill(id)` 的同步返回值 `{ ok, wasRunning }` 保持不变，调用方无感知。条目新增 `stopping` 状态，收到子进程 `exit` 后再置为已结束。新增 `waitExit(id, timeoutMs)`，给测试和收工流程用。
3. `stopAll()` 改为返回 Promise。`server-main.js` 的 `shutdown` 最多等 3 s 再退出。
4. 沙箱分支不变：沙箱进程已经由 Job Object（`KILL_ON_JOB_CLOSE`）收尾，外面再 `taskkill` 反而会失败（见 `shells.js` 现有注释）。
5. **POSIX 侧同样要收进程组**：非 Windows 的 `shell: true` 走 `/bin/sh -c`，同样是 `sh → 真实命令` 两层；只 `child.kill()` 杀掉的是 `sh`，孙进程照样活着（开发服务器占着端口、`npm run dev` 留下 node）。所以非 Windows 非沙箱分支改为：
   - `spawn(..., { detached: true })`，让子进程成为自己进程组的组长（`pid === pgid`）；
   - 终止时 `process.kill(-entry.pid, 'SIGTERM')` 整组发信号（`ESRCH` 忽略：已经退干净了）；
   - 等子进程 `exit`（超时兜底 `SIGKILL` 整组，再 `child.kill()`）。
   - macOS / Linux CI 必须跑同一套零残留断言（§3.3）：这两个平台的残留平时看不见，因为测试自己 `process.exit()` 时内核会把会话收掉 —— 只有改成"到点扫进程表"才暴露出来。

**对照实验**（同样的启动方式，各 3 个进程）：

| 杀法 | 3 秒后存活 |
|---|---|
| 现状：异步 `taskkill` 不等结果，立刻 `child.kill()` | 3 / 3 |
| 先等 `taskkill /T` 结束，再 `child.kill()` | **0 / 3** |

### 3.3 测试

- `tests/shells.mjs`：每个用例的脚本名带唯一标记。`kill` / `killRoom` / `killByTask` 之后，5 s 内按标记扫进程表（Windows 用 CIM 查询，POSIX 用 `ps`），断言**零存活**。末尾先 `await reg.stopAll()` 再退出。
- 进程扫描抽成测试辅助模块 `tests/helpers/proc-scan.mjs`（新增）。

### 3.4 验收

- `node tests/all.mjs` 连跑 3 次，进程表里没有任何带 `Orbis-shells-` 标记的残留。
- 真机：让 bot 起一个开发服务器，再结束它，端口立即释放。补进 `docs/REAL-MACHINE-CHECKLIST.md`。

---

## 4. P1-1 上游失败快速判定与早切换

### 4.1 现有的四层机制（都保留，只改接线与阈值）

| 层 | 位置 | 现状 |
|---|---|---|
| pi SDK 内部重试 | pi `settings-defaults`：`retry.maxRetries` 3、`baseDelayMs` 2000、`provider.maxRetryDelayMs` 60000 | Orbis 只在 `auto_retry_start` 计数（`runner/turn-executor.js:535`），不刷心跳、不喂熔断 |
| Orbis 单轮重试 | `retry-policy.js` 的 `decideRetry` | 临时故障最多 10 次（`MAX_RETRIES_TRANSIENT`）；退避 1.5 s 起翻倍、封顶 12 s；**第 6 次起**才 `switchModel`（`retry-policy.js:134`） |
| 熔断 / 端点轮转 | `circuit-breaker.js`、`pi-runner.js:508` 的 `markGroupFailed` | 连续 3 次通路失败打开（`OPEN_AFTER_FAILS`），冷却 60 s；**只有多端点的组才能切换** |
| 看门狗 | `watchdog.js` | 模型 6 分钟（`stallMs`）、工具 15 分钟（`toolStallMs`）没有动静，才判卡死并上报 |
| 分钟级续派（不丢活） | `runner/group-retry.js`、`tasks/task-supervisor.js` | 1 / 2 / 5 / 10 分钟阶梯，累计上限 1 小时。**本规格不动** |

### 4.2 方案

**a. 埋点先行**（`run-stats.js`，同一次提交里先上线）。每条记录新增以下字段，仍然不存提示词和凭据：

| 字段 | 含义 |
|---|---|
| `endedBy` | `ok` / `retry-exhausted` / `model-idle` / `stall` / `abort` / `auth` / `quota` / `slice` |
| `ttftMsP50`、`ttftMsMax` | 本次运行各轮**从发请求（或 `tool_execution_end`）到第一个 `message_update`** 的耗时 |
| `sdkRetryWaitMs` | SDK 内部重试的等待合计（取 `auto_retry_start` 事件的延迟） |
| `failKinds` | 本次运行内各类失败的计数（`transient` / `timeout` / `empty` / `auth` / `quota` …） |

**计时边界（不要写成 `message_start`）**：`message_start` 是上游**已经回应**之后才有的，用它当起点会把「TCP 握手挂死、prefill 一直不出字」这类最恶心的失败排除在统计之外 —— 而它们恰恰是 §1.3 里「判定要 364 s」的主要来源。所以：

- 起点：**发出请求的那一刻**（以及工具回来之后重新发请求的 `tool_execution_end`）；
- 终点：该请求的第一个 `message_update`（思考增量也算）；
- **工具执行期暂停计时**：跑工具不算「模型没进展」，否则长命令会被误记成模型卡住；
- `modelIdleMs`（b）用同一个锚点，所以 M1 之后可以直接拿 `ttftMsMax` 的分布决定是否收紧 —— 初始 180 s（§11·2）就是为了不误杀慢思考模型。

**与 SDK 内部重试的关系**：`auto_retry_start` 的等待（`baseDelayMs` 起、`provider.maxRetryDelayMs` 封顶 60 s）也在「等模型」区间里，但它是**可控的等待**，不是挂死。因此：

- `auto_retry_start` 时**重置** `modelIdleMs` 的计时锚点（否则一次 60 s 退避 + 60 s 思考会被误判成 model-idle）；
- 同时把这段等待如实累计进 `sdkRetryWaitMs`；
- M1 拿到数据后评估收紧 pi SDK 的 `retry.maxRetries`（默认 3）—— 现在是**两层重试叠加**（SDK 3 次 × Orbis 10 次），而 §1.3 实测失败运行 p50 有 11 次尝试。「一层重试 + 明确的失败分类」比叠两层更好定位。

**b. 模型无进展超时**（新增，独立于看门狗）。`runner/turn-executor.js` 在“等模型”阶段（从发起请求到 `message_end`）计时：超过 `modelIdleMs` 没有任何 `message_update`（思考增量也算进展），就中止本次请求，按 `kind: 'model-idle'` 失败，进入现有的 `decideRetry` / `markGroupFailed` 路径。

- 默认 **180 000 ms**（M1 保守初值，§11·2），可用 `ORBIS_MODEL_IDLE_MS` 覆盖；
- 锚点与暂停规则同 a：发请求 / `tool_execution_end` 起算，工具执行期不计时，`auto_retry_start` 重置；
- 跑出 3–7 天 `endedBy` / `ttftMsMax` 分布后，再决定是否收紧到 120 s；
- 看门狗 `stallMs` 保留，作为最外层兜底。

**c. SDK 重试看得见、算得进熔断**：

- `auto_retry_start` 时调用 `beat()`，并广播 `bot.retrying`（`{ roomId, botId, attempt, maxAttempts, delayMs, kind }`）。
- 连续 2 次 SDK 级上游失败，按一次通路失败调用 `markGroupFailed`。
- 客户端左下角活动胶囊（`widgets/activity_monitor.dart`）显示“上游不稳 · 第 k 次重试”或“已换到 X”。

**d. 早切换**（M2 实装；M1 只把埋点做出来）：

- 同一模型连续 2 次临时故障，并且存在**另一个健康的已启用模型**（默认模型或 `model-dispatch.js` 的推荐）时，第 2 次就触发切换。
- 没有可换的模型时维持现状；单端点组不再指望端点轮转，熔断打开时直接走换模型。

**现状必须先说清（否则 M2 会写成一个假开关）**：`retry-policy.js` 里的 `switchModel` 目前**只改 `retryHint` 的文案** —— 提示词里多一句「考虑换个模型」，实际仍由 `runner/group-orchestrator.js` / `tasks/task-supervisor.js` 用**原来的模型**重跑。也就是说，今天**没有任何运行期临时切模型的机制**（只有 `markGroupFailed` 打开熔断后由 `pi-runner.js` 选下一个端点，而单端点组没得选）。M2 要补的是真机制，约束如下：

| 项 | 规则 |
|---|---|
| 作用域 | **仅当前这次重试**。绝不改写持久化的 `bot.model` / 模型组配置；重试成功也不「粘」到新模型 —— 下一次请求仍从用户配置的模型开始 |
| 选型 | 只在**已启用**的模型里挑，按 `model-dispatch.js` 的推荐顺序；跳过熔断打开、健康度为 0 的组 |
| 能力校验 | 必须满足这次请求所需的能力：带图请求要目标模型有 `vision`，带工具的要支持 tool calling，上下文窗口装得下当前 prompt —— 不满足就跳过这个候选（而不是「先切过去再失败一次」） |
| 跨 provider | 换到不同 provider 时**不能复用原会话文件**（`sessionKey` 里带模型组），否则等于把 A 家的 tool-call 历史喂给 B 家。做法：为临时模型开一次性会话，本轮结束就丢弃；原会话留给下一次正常请求 |
| 可观测 | 切换时写一条 `bot.retrying`（`{ roomId, botId, from, to, attempt }`，只带模型组**序号或别名**，不带 endpoint 与密钥），并在 `run-stats` 记 `switchedModel: true` |
| 失败回退 | 切换后仍失败：不连环换第三个模型，回到原模型并走既有 `decideRetry` → 熔断 → 分钟级退避链路 |

**e. 接线点**（各链路的现有入口，只加判定，不新开路径）：

| 链路 | 位置 |
|---|---|
| 群聊 | `runner/group-orchestrator.js:678` / `:698`（`decideRetry`）、`:684` / `:748`（`markGroupFailed`）、`:809`（续派判定） |
| 受管任务 | `tasks/task-supervisor.js:1178` / `:1356` |
| 单轮收尾 | `runner/turn-executor.js:1042`（`isRecoverableFailure` → `retrying` 状态） |

### 4.3 测试

- 在 `tests/` 里注入假的 `streamFn` 覆盖三种场景：
  - 永远不吐字：在 `modelIdleMs + 5 s` 内判定 `model-idle`，不再等 6 分钟。
  - 连续返回 429：第 2 次就切到健康模型。
  - 没有可换的模型：行为与现状一致。
- `retry-policy.js` 的新阈值配纯函数单测（它本来就在纯模块里）。

### 4.4 验收

- 假上游下，各类“挂住”的判定时间 ≤ `modelIdleMs` + 5 s（立项值约 360 s）。
- 真实数据：连续 7 天，用 `server/tools/perf-report.mjs` 统计，上游类失败的“开始到判定”p50 ≤ 150 s（立项值 364 s）。同时报告失败运行的时长占比，不设硬目标，因为它取决于上游质量。
- 回归：`group-retry` 的续派次数、间隔、1 小时上限不变（现有测试全绿）。

---

## 5. P1-2 / P2-3 Windows 原生桌面助手

### 5.1 为什么这里用 Rust

- macOS 早就是原生实现：零依赖的 Swift 助手 `native/orbis-desktop-mac/main.swift`，用 stdin / stdout 收发 JSON，Node 侧是 `desktop-input-mac.js:102` 的 `callHelper`。
- **只有 Windows** 还在每次调用时起 PowerShell、用 `Add-Type` 现编译 P/Invoke（`desktop-input-win.js:236`、`desktop-observe.js:53`）。单次调用的大头就是这一步：PowerShell 启动约 170 ms，`Add-Type` 编译再加约 180 ms。
- 仓库里已有 Rust 工具链和 `windows-sys` 依赖（`native/orbis-sandbox`），构建、校验、打包流程都是现成的。

### 5.2 新组件 `native/orbis-desktop-win/`（新增）

| 项 | 约定 |
|---|---|
| 产物 | `orbis-desktop-win.exe` → `server/resources/orbis-desktop-win.exe`（`.gitignore`，随发版编译） |
| 依赖 | `windows-sys`（与 `orbis-sandbox` 同版本）+ `png`（截图编码，§11·1）。**不引入 `image` 全家桶** |
| 启动 | 第一件事是设置 DPI 感知（`SetProcessDpiAwarenessContext`，失败时退回 `SetProcessDPIAware`）。坐标口径必须与现有 PowerShell 实现**逐项一致** |
| 协议（阶段 A） | 与 macOS 助手同构：`orbis-desktop-win.exe <command>`，stdin 一个 UTF-8 JSON，stdout 一个 UTF-8 JSON；失败一律 `{ok:false, code, text}`；`version` 返回 `{ok:true, version, protocol:1}` |
| 协议（阶段 B） | `orbis-desktop-win.exe serve`：stdin / stdout 按行 JSON，每条带 `id`，单进程常驻 |
| 安全 | 只做被要求的单个动作，不执行命令、不联网、不读写用户文件；未知命令直接拒绝。授权、租约、审计**全部留在 Node 侧**（`desktop-input-session.js`），助手只负责执行 |
| 构建 | `scripts/build-desktop-win.ps1`（新增，仿 `scripts/build-sandbox-win.ps1`）：`cargo build --release`、写 sha256 清单、校验 Node 侧版本常量 |
| 打包 | `scripts/pack-windows.ps1` 照第 363 行 `orbis-sandbox.exe` 的写法拷进发行包；缺失时打黄字警告 |

**命令映射**（Node 侧导出 API 与返回结构不变）：

| Node 函数 | 现状 | 助手命令 | 阶段 |
|---|---|---|---|
| `probeEnvironment()` | PowerShell | `env`：DPI、虚拟屏矩形、`OpenInputDesktop` 能否打开 | A |
| `lastInputAt()` | PowerShell | `probe`（同 macOS） | A |
| `cursorPosition()` | PowerShell | `cursor`（同 macOS） | A |
| `foregroundTitle()` | PowerShell | `foreground`（同 macOS） | A |
| `perform({ plan })` | 多次 PowerShell（移动最多 3 次 + 点击） | `perform`：移动、核对、点击在**同一进程内**完成，保留“紧跟移动、减少被抢”的语义 | A |
| `sampleInputNoise()` | 5 轮 × 2 次 PowerShell + `Atomics.wait` | `noise`（同 macOS，在助手内部采样和等待） | A |
| `listWindows()` | PowerShell + `EnumWindows` | `windows` | A |
| `performDrag()` | 每段一次 PowerShell | A：每段一次 `drag-step`（保留 `shouldAbort` / `onStep` 回调）；B：常驻进程内分段 | A / B |
| `captureScreenshot()` | `PrintWindow` → 空白则 `CopyFromScreen` → 缩放，1–3 次 PowerShell | `capture`：`PrintWindow`，空白时退回 `BitBlt`，缩放后编码 PNG | B |
| `screenSize()` | PowerShell | 并入 `env` | A |

### 5.3 阶段 A（P1-2）：单次进程，同步 API 不变

- `desktop-input-win.js` / `desktop-observe.js` 内部的 `run(script)` 换成 `callHelper(command, payload)`，写法与 `desktop-input-mac.js` 相同，`run` 可注入，方便测试。对外函数签名和返回结构一字不改，`desktop-input-session.js` 无需改动。
- 仍然是 `spawnSync`，但单次只阻塞约 25 ms。这是从约 360 ms 降下来的过渡，阶段 B 彻底去掉阻塞。
- **回退开关**：`ORBIS_DESKTOP_WIN_IMPL=native|powershell`。默认是 `native`；助手缺失或版本不符时自动回退 `powershell`，并且只记一次日志。保留一个版本周期后删除 PowerShell 实现。

### 5.4 阶段 B（P2-3）：常驻、异步、截图

- Node 侧新增 `server/src/desktop-helper-win.js`（新增）：负责常驻进程的拉起、按 `id` 匹配请求和响应、单请求超时、崩溃后退避重启、服务端退出时随之结束。
- `desktop-input-session.js` 及其调用方改为 `async`。租约、`epoch` 核对、用户接管判定的顺序不变；同一租约内的动作串行执行。
- 截图并入助手（`capture`），`desktop-observe.js` 不再起 PowerShell，`shrinkIfNeeded` 的缩放也在助手内完成。
- **常驻 `serve` 不许跨请求缓存显示器 / DPI / 桌面句柄**：每次请求都重新枚举显示器与 DPI、重新 `OpenInputDesktop`，用完**立即 `CloseDesktop`**。理由：用户插拔外接屏、改缩放、锁屏/解锁、切换 UAC 安全桌面，都会让上一次的口径失效 —— 缓存下来的句柄还会泄漏（`OpenInputDesktop` 每打开一次要关一次），而缓存下来的坐标会**点偏**。这几项本身就是微秒级调用，省不出什么。
- 岛（`desktop-island-win.js`，每岛一个常驻 PowerShell）**不在本规格范围**，见 §9。

### 5.5 测试

- Node：对每个命令做契约测试（注入假 `run` / 假常驻进程），覆盖成功、`{ok:false, code}`、超时、助手缺失回退。
- Rust：JSON 解析、计划校验、坐标换算的单元测试（`cargo test`）。
- 真机（写进 `docs/REAL-MACHINE-CHECKLIST.md`）：DPI 100% / 150%、多显示器、锁屏、UAC 安全桌面（应暂停而不是乱点）、远程控制软件刷新“最后输入时间”的情况（与现有判定一致）。
- **口径对拍**：同一台机器上，PowerShell 实现与原生实现对同一组探针（光标、前台窗口、窗口列表、移动后坐标）给出相同结果。

### 5.6 验收

| 指标 | 立项值 | 阶段 A | 阶段 B |
|---|---|---|---|
| 单次只读探针 p50 | 约 360 ms | ≤ 40 ms | ≤ 2 ms |
| `listWindows()` p50 | 约 870 ms | ≤ 60 ms | ≤ 5 ms |
| 一次点击全链路（不含刻意等待） | 约 2.5–3.5 s（估算） | ≤ 300 ms | ≤ 50 ms |
| 桌面操作造成的事件循环单次卡顿 | 350–900 ms | ≤ 50 ms | ≤ 5 ms |
| 窗口截图 | 1–3 次 PowerShell | 不变 | ≤ 150 ms，且不阻塞 |

---

## 6. P2-1 附件解析移出主线程

### 6.1 现状

- `extract.js` 用 SheetJS 同步解析 xlsx，PDF 由 `pdf-parse`（pdf.js）在主线程解析，docx 用 mammoth。
- 入口有三个：`tools.js:1130`（`extractText`）、`extract.js:186`（`attachmentBlock`，经 `pi-runner.js:30` 注入 `prompt-input.js`）、`http.js:1639`（预览，按需加载 `render-html.js` 的 `renderFileAsHtml`）。
- 实测：1.25 MB PDF 卡 247 ms，6 万行 xlsx 卡 1066 ms。

### 6.2 方案

- 新增 `server/src/extract-worker.js`（worker 入口）和 `server/src/extract-pool.js`（池）：
  - 懒启动，1 个 worker（可配置到 2 个），任务排队。
  - 单个任务超时 60 s；`resourceLimits.maxOldGenerationSizeMb` 设为 1024。
  - 超时或崩溃时 `terminate()` 并重建 worker，返回明确错误，服务端不受影响。
- `extractText` / `attachmentBlock` / `renderFileAsHtml` 的签名不变，内部改为交给池执行。小文本类（`.txt` / `.md` / `.json` / `.csv` 小于 256 KB）仍然直接在主线程读，省掉线程往返。
- worker 起不来时退回主线程内联解析（即旧行为），并记日志。

### 6.3 测试与验收

- `tests/extract.mjs`：经池解析的结果与内联解析逐字节一致。
- `server/tests/perf-stall.mjs`（新增，见 §10）：解析合成的 6 万行 xlsx 时，事件循环最大卡顿 ≤ 50 ms（立项值 1066 ms）；1.25 MB PDF 同样 ≤ 50 ms（立项值 247 ms）。
- 解析总耗时不超过内联解析的 +20%。
- 构造一个会超时的文件：worker 被终止，返回错误，服务端持续响应 `/health`。

---

## 7. P2-2 客户端流式增量渲染

### 7.1 现状

- `StreamingMarkdownView`（`widgets/streaming_markdown_view.dart`）的吐字动画在 `_onTick`（第 129 行）里每帧 `setState`，每帧截出一个新的 `visible` 字符串。
- `MdText` 的解析缓存 `_blocksFor`（`widgets/md_text.dart:93`）按整段文本比较，文本每帧都变，所以**每帧都要整段重新解析**。
- `build` 每次都重新创建所有块的 widget，Flutter 要逐块深比较 span 树。
- 光标闪烁（第 204 行的 `AnimatedBuilder`）在输出期间一直运行，**没有新字时也每帧重建整条 `MdText`**。
- 每帧开销随消息长度线性增长，整条消息输出下来是平方级；多个 bot 同时输出时按气泡数叠加。按立项时的消息长度（p99 约 5000 字），桌面端问题不大，主要风险在手机上多个 bot 同时长输出。

### 7.2 方案

1. **增量解析**：`_parse`（`widgets/md_text.dart:549`）是逐行分块解析器。遇到代码围栏之外的空行时，解析状态完全清空，前面所有块都已闭合。因此：
   - 缓存 `stableOffset`：最后一个“围栏外空行”之后的字符位置，以及它之前的 `stableBlocks`。
   - 新文本以旧文本为前缀（流式追加的常态）时，只解析 `text.substring(stableOffset)`，再拼到 `stableBlocks` 后面。
   - 不满足前缀关系（编辑、回滚、换条）时，退回整段解析。
   - **不变量**：`parse(full) == stableBlocks + parse(tail)`，由属性测试保证。
2. **复用块 widget**：前 `stableCount` 个块的 widget 实例缓存起来，跨 build 复用同一个对象，Flutter 会直接跳过它们。缓存键是渲染配置签名（`style`、`mono`、`linkColor`、`mentions`、主题亮度）；签名一变就整体失效。只有末尾块在重建。
3. **光标独立**：光标只在最后一块里渲染为单独的小部件，闪烁只重绘光标本身，不再经过 `MdText` 的 build。

**两条实现约束（写错就是错的缓存，不是慢）**：

- **切分点必须是「已闭合的空行」**：`stableOffset` 只能落在 `
[ 	]*
` **之后**；不能把「末尾那个单个 `
` 产生的尾部空串」当空行 —— 那说明这一行还没写完（围栏、表格行、列表项都可能续写），提前切会把半块缓存下来。判定方式是逐字符扫、只在遇到真正的连续两个换行且不在围栏内时推进 `stableOffset`。
- **块 widget 缓存键必须包含渲染配置**：至少 `style`、`mono`、`linkColor`、`mentions`、主题亮度（`isDark`），**外加 `selectable` 与 `textScaler`**。少一个就会在「用户开了选中复制 / 系统改了字号或缩放」之后，复用一批用旧配置画出来的 widget —— 表现为文字选中不了或字号不跟着系统走，而且不会报错。
4. 协议不变：`AppState` 处理 `msg.delta` 的方式（`app_state.dart:3142`）不动，仍然整段覆盖，保持幂等。

### 7.3 测试与验收

- `app/test/md_text_incremental_test.dart`（新增）：随机生成含围栏、表格、列表、引用、标题、CJK 和 emoji 代理对的文本，在随机位置切成多段逐步追加，断言增量结果与整段解析逐块相等。需要给解析函数加一个 `@visibleForTesting` 入口。
- widget 测试：连续两帧之间，稳定块的 widget 实例相同（`identical`）；光标闪烁时 `MdText` 不重建。
- profile 模式实测：
  - 桌面端：单个流式气泡每帧的 build + layout 耗时，在 1000 字和 2 万字之间相差不超过 2 倍（立项时随长度线性增长）。
  - 中端 Android 机：3 个 bot 同时输出 5000 字消息时，DevTools 帧图里没有超过 16.7 ms 的帧。

---

## 8. P2-4 流式期间不重写 `state.json`

### 8.1 现状

- 流式时 `pushDelta`（`runner/turn-executor.js:414`）每 80 ms 调一次 `store.updateMessage`（`store.js:3376`）。它只改房间里的消息，却会调用 `scheduleSave()`。
- `saveNow()`（`store.js:598`）**无条件**重写整份 `state.json`，即 `writeJsonAtomic`（`util.js:8`，同步写临时文件再改名）。
- 结果是：只要有 bot 在输出，每 300 ms 就整份重写一次 `state.json`。

### 8.2 方案

- `store.js` 新增 `#stateDirty`。`scheduleSave({ state = true } = {})` 默认按“state 也改了”处理，漏改的调用点仍然安全。
- 纯消息变更（至少包括 `updateMessage`；其它方法实现时逐个确认，拿不准的保持默认）改为 `scheduleSave({ state: false })`。
- `saveNow()` 只在 `#stateDirty` 为真时写 `state.json`。`flushNow()` 语义不变，因为调用方要的是“都落盘了”的确认。
- **清 dirty 的时机只有一个**：`writeJsonAtomic(stateFile)` **成功返回之后**才清 `#stateDirty`。写失败（磁盘满、权限、重命名跨设备）必须保持 dirty，让下一次 `saveNow()` 重试 —— 「先清标记再写」会在一次写失败后把整份状态永久丢在内存里，直到进程退出。
- `tests/bench.mjs` 增加“流式落盘”场景。

### 8.3 验收

- 只有消息在流式更新时，`state.json` 写入次数为 0。
- 流式期间每次落盘约 6.4 ms → 约 2.9 ms（只剩房间文件，按立项数据）。
- 下一步的触发条件（本期不做）：`state.json` 超过 1.5 MB，或房间文件单次落盘 p95 超过 10 ms 时，再考虑审计改成追加写，或改用 `node:sqlite`。

---

## 9. P3 项与本期不做

### 9.1 P3

| ID | 内容 | 门槛 / 验收 |
|---|---|---|
| P3-1 冷启动打包 | 发行包用 esbuild 把服务端打成单文件，开发态不变。必须保证：`isPiInvocation` 入口（`pi-args.js`，子 agent 用 `argv[1]` 当 pi 入口）可用；`render-html.js` 仍然按需加载；原生扩展 `@napi-rs/canvas` 外置；pi 扩展的动态加载不受影响 | 先做原型。**冷启动减少 ≥ 40% 且全量测试对打包产物全绿**才排期。目标 ≤ 1.0 s |
| P3-2 大 JSON 解码 | `api.dart` 响应体超过 64 KB 时用 `Isolate.run` 解码。WS 帧（`ws_frame.dart`）维持主线程，因为都很小 | 打开 455 KB 的房间时，Android 帧图里没有由解码造成的超时帧 |
| P3-3 Job Object 托管 | 非沙箱后台进程也放进 `KILL_ON_JOB_CLOSE` 的 Job（复用 `native/orbis-sandbox/src/main.rs` 第 765–787 行的写法），服务端崩溃时整棵进程树随之结束 | 仅当 P0-1 上线后仍出现孤儿进程时启动 |

### 9.2 本期不做

| 不做 | 理由 | 何时重议 |
|---|---|---|
| 服务端改写为 Rust / C++ | 75% 时间在等模型，JS 开销是毫秒级；重写还要放弃 pi 引擎和 2.0 SDK 的兼容 | 不重议 |
| 客户端核心改写为 Rust / C++ | Dart 发布时已经 AOT 编译成原生代码，排版和绘制本来就在 Flutter 的 C++ 引擎里；瓶颈是每帧全量重算，换语言照样慢 | 不重议 |
| `msg.delta` 改增量协议 | 全文下发是刻意的幂等设计；立项时消息 p99 约 5000 字，局域网带宽可忽略 | 中继用量上来，且消息常超过 2 万字时 |
| 用 Rust 解析 PDF / Excel（calamine / pdfium） | P2-1 之后不再阻塞，剩下的只是绝对速度 | 解析耗时本身成为投诉点时 |
| 落盘改用 SQLite | 现有体量下开销约 2% | 见 §8.3 的触发条件 |
| 岛（`desktop-island-win.js`）迁到原生助手 | 已经是常驻进程，不是每次调用都起 PowerShell | P2-3 稳定后单独评估 |
| macOS 助手常驻化 | 原生单次进程已经只有几十毫秒 | 需要高频连续输入时 |

---

## 10. 测量工具（新增 / 扩展）

| 文件 | 类型 | 内容 |
|---|---|---|
| `server/tools/perf-report.mjs`（新增） | 只读报告 | 读数据目录的 `run-stats.json` 和 `sessions/*.jsonl`，输出模型 / 工具时间占比、各工具 p50 / p90、失败运行时长占比与判定耗时、缓存命中分布、`endedBy` 分布。只打聚合，不打正文 |
| `server/tests/perf-stall.mjs`（新增，手动） | 卡顿探针 | 附件解析（PDF / 合成 xlsx）、落盘，以及 Windows 上的只读桌面探针，各自报告事件循环最大卡顿 |
| `server/tests/bench.mjs`（扩展） | 基准 | 增加流式落盘场景（§8） |
| `server/tests/shells.mjs`（扩展） | 回归 | 进程零残留断言（§3） |
| `app/test/md_text_incremental_test.dart`（新增） | 回归 | 增量解析不变量（§7） |

计时类脚本受机器负载影响，**不进 `tests/all.mjs`**；零残留断言是确定性的，跟随 `shells` 进入统一入口。

---

## 11. 已拍板（M1 进行中）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 桌面助手截图的 PNG 编码 | **用纯 Rust 的 `png` crate**（MIT / Apache-2.0），不用 WIC / COM。阶段 B 的缩放在 Rust 内**手写轻量双线性 / 盒式下采样**，不引入 `image` 全家桶（它会把 `png`、`jpeg`、`gif`、`webp`、`rayon` 一整套拖进来，为一个 800×500 的缩图不值得）。crate 在 M2 随助手一起落地，届时同步登记 `docs/LICENSES.md`（该文件只覆盖 npm / pub 依赖，Rust crate 需要手工补一行） |
| 2 | `modelIdleMs` 默认值 | **M1 只落埋点**，先不启用硬超时；默认初值保守取 **180 s**。跑出 3–7 天 `endedBy` / `ttftMsMax` 分布后，再决定是否收紧到 120 s（见 §4.2 b） |
| 3 | 早切换门槛 | **同意「连续 2 次临时故障」触发**，但必须同时满足：**仅当前这次重试临时回退**、**绝不改写持久化的 `bot.model`**、**跳过不具备当前所需能力的替代模型**（典型：带图请求没有 `vision` 的模型）。完整规则见 §4.2 d |
| 4 | PowerShell 实现保留多久 | **保留一个版本周期**，用 `ORBIS_DESKTOP_WIN_IMPL=powershell` 作逃生舱（助手缺失、版本不符或杀毒误杀时回退，且只记一次日志）。之后随大版本删除 |
| 5 | P3-1 冷启动打包是否立项 | **先做原型，按 §9.1 的门槛决策**（冷启动减少 ≥ 40% 且打包产物全量测试全绿）。原型要同时验证 `extract-worker.js` 的**独立入口**能被打进单文件（worker 不能用 `__dirname` 猜路径） |

---

## 12. 里程碑

| 批次 | 内容 | 出口条件 |
|---|---|---|
| M1 | P0-1、P1-1 的埋点（§4.2 a） | 零残留断言全绿；`run-stats` 新字段落盘 |
| M2 | P1-1 其余部分、P1-2 | §4.4、§5.6 阶段 A 达标；真机清单补齐 |
| M3 | P2-1、P2-4、P2-2 | §6.3、§8.3、§7.3 达标 |
| M4 | P2-3 | §5.6 阶段 B 达标；PowerShell 实现进入删除倒计时 |
| — | P3 | 按 §9.1 的门槛单独排期 |

**完成定义**：代码、测试、改前 / 改后数字都要有。同步更新 `docs/MODULE-MAP.md`（新文件登记）、`docs/ARCHITECTURE.md` §五（性能表换成新数字）、`docs/REAL-MACHINE-CHECKLIST.md`（桌面助手、进程清理两项）、`docs/LICENSES.md`（如引入新 crate）。

---

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| 原生助手与 PowerShell 的 DPI / 坐标口径不一致，点偏 | §5.5 口径对拍；回退开关保留一个版本周期 |
| 新 exe 被杀毒软件误报 | 与 `orbis-sandbox.exe` 同一套 sha256 清单与发版流程；`docs/WINDOWS.md` 写明排查方法 |
| `modelIdleMs` 误判慢思考模型 | 思考增量算进展；可按环境变量覆盖；用 `endedBy` 统计误判率再调 |
| 早切换把用户指定的模型换掉 | 只在存在健康替代时切换，并通过 `bot.retrying` 明确告知；用户锁定模型的场景（若有）不切 |
| worker 内存失控或卡死 | `resourceLimits` + 超时 `terminate()` + 退回内联 |
| 增量解析与整段解析结果不一致 | 属性测试；前缀不成立就整段解析 |
| 桌面会话层异步化引入竞态（阶段 B） | 租约 / `epoch` 核对顺序不变；同一租约内串行；保留现有的接管判定测试 |
| 杀进程等 `taskkill` 退出时拖慢收工 | 单次超时 5 s，`stopAll` 总等待 3 s，超时后照旧退出 |
