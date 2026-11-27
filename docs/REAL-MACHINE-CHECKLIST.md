# 真机验收清单（2026-11-19）

> **这份清单只做一件事**：把 `docs/acceptance-matrix.md` 和 `docs/WINDOWS.md` 里
> 还挂在 `静态` / `未做` 的那几行，用最小的操作量填成 `实机 ✓` 或 `实机 ✗`。
>
> 三条约定的执行纪律（跟这份清单一起定下的）：
> 1. **走真实装配层**：不在底层纯函数上打勾。脚本驱动的是
>    `desktop-input-session` / `createPolicyExtension` / `grant-gate` 这些真实接线；
>    手机确认那一步必须在真 App 上点，不接受“模拟通道”。
> 2. **非破坏性**：所有脚本用 `%TEMP%` 下的临时 `dataDir`，不碰你正在用的配置；
>    需要造数据的（Bot / 授权）用完即删，或者刻意建带 `__验收` 前缀的临时对象。
> 3. **一条对一行**：每条都写清「回填哪一行」，见文末表格。

先说结论式的顺序：**先跑 3 个脚本（合计约 1 分钟），再花 10 分钟做手机确认那项**。
中途唯一会打断你的是 #31（要锁屏十几秒）。

---

## 0. 前置

```bash
cd D:/Orbis/server
node tests/all.mjs | tail -2        # 期望 214/214（含 real-sdk-lanes 真 SDK 零 mock 泳道、write-json-atomic 落盘重试）
```

- 关闭或至少知道：本机装了远程控制软件（`GameViewer` / UU 远程那一类）时，
  它会持续合成鼠标输入，接管检测会一直让开 —— `docs/WINDOWS.md`「环境噪声」一节有记账。
  验收"用户接管"那行必须换干净机器，其余行不受影响。
- 多屏那项：需要一块**不同缩放**的外接屏，只有一块屏时脚本会明确打印"没有拿到证据"。

---

## 1. `#31` 锁屏后不盲点（脚本 · 约 40 秒，含锁屏/解锁）

```bash
node scripts/probes/acceptance-lock-screen.mjs
```

按提示在 20 秒内 **Win+L** 锁屏，然后不用管，脚本自己继续；它会在锁屏状态下真的
发一次输入，再等你解锁。期望结尾三行：

```
LOCK_NO_SESSION true
LEASE_RELEASED_ON_LOCK true
REACQUIRE_AFTER_UNLOCK true
```

**失败时看什么**：如果打印 `✗ 20 秒内没检测到锁屏`，是脚本没等到会话断开（可能锁屏
被组策略/远程会话禁用）；如果打印 `锁屏状态下居然发出了输入`，那是**安全底线破了**，
把输出整段留下。

---

## 2. `#32` 多屏 / 混合缩放（脚本 · 约 10 秒）

```bash
node scripts/probes/acceptance-multiscreen.mjs
```

它枚举显示器（矩形 + 每块屏的 DPI + 工作区），把光标移到**每块屏的中心**读回核对，
再给一个屏外点确认被 `out_of_screen` 拒掉。

- 两块屏（不同缩放）→ 期望结尾 `MATCH true`，且中间打印
  `缩放混合：100% / 125% —— 混合缩放场景已覆盖。`
- 只有一块屏 → 打印 `⚠ 只有一块显示器 …… 没有拿到证据`。
  **这时不要把这一行标成实机 ✓**，保持 `静态`，等接了第二块屏再跑。

---

## 3. W6-2 · T1 独立桌面 vs T2 用户桌面（脚本 · 约 5 秒）

```bash
node scripts/probes/acceptance-island-vs-desktop.mjs
```

三段都走真实装配（临时 `dataDir`，不碰你的配置）：

1. **工具集**：成员 68 个工具、主控 72 个 —— 差的 4 个正是
   `desktop_observe` / `desktop_screenshot` / `desktop_input` / `desktop_lease`；
   而 `desktop_island_*` 成员都有（T1 该用的那张岛）。
2. **授权网关**：成员调 `desktop.observe` 这个**动作**是放行的（`migration: 'all'`，
   T1 共用它，属设计）；但成员调 `desktop.input` 直接 `action_not_covered`。
3. **执行边界**：用真实 `createPolicyExtension` 驱动一次 `tool_call` —— 成员调
   `desktop_observe` 被 `block`（`no_grant`），主控同一个调用 `allow`。

期望结尾：

```
T2_CHIEF_ONLY true
MEMBER_TOOLSET_CLEAN true
GATEWAY_BLOCKS_MEMBER true
HOOK_BLOCKS_MEMBER true
```

---

## 4. W6-1 · Jarvis 高危确认门禁（真 App + 手机 · 约 10 分钟）

这一项**没有脚本**：核心动作是"在手机上点确认"，任何脚本模拟都等于绕过验收目标。
脚本只能帮你查状态，命令在下面。

### 4.1 准备（不碰你现有的 Bot）

在 App 里新建一个临时 Bot，名字以 `__验收` 开头（例如 `__验收临时__`），
**不要**改任何现有 Bot / 知识库 / 全局策略。

### 4.2 让主 Bot 触发一次高危动作

在电脑端主控会话里发：

```
把刚建的「__验收临时__」这个 Bot 删掉
```

### 4.3 预期（这一步是验收的核心）

| 检查点 | 期望 |
|---|---|
| App 里出现确认卡片 | `kind: 'confirmation'`，卡片写到「需要在手机上确认」+ 目标摘要 |
| 本机（桌面）批准 | **HTTP 403 `WEAK_CHANNEL`**，理由指向"不可撤销动作要在已配对设备上确认" |
| 手机端能看到同一条确认 | `GET /api/confirmations` 里有这一条（`minChannel: 'device'`） |
| 手机确认后 | 后端更新卡片 `meta.decision` 并**自动续跑**会话（你不用再催它一句），那个临时 Bot 从花名册消失 |
| 同一条确认不能再批一次 | 第二次会被拒（一次一用，`consumedAt` 已经写上） |

> 覆盖的工具（`capabilities.js` 的 `needsSecondFactor`）：
> `delete_bot` / `manage_department(op=delete)` / `manage_knowledge(op=delete_skill|delete_lesson)`
> / `set_policy(op=update)` / `manage_model_group(op=delete)` / `git_destructive`。
> 其中 `git_destructive` 由 `git-tools.js` 自己在动手前建确认 —— **不要在两条路上重复弹卡**。

查状态用（`TOKEN` 换成 App「系统 → 连接」里的 API token，端口按实际）：

```bash
TOKEN=<你的 API token>
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/confirmations | head -c 800
```

### 4.4 如果失败了

- 卡片没出现 → 先看 `needsSecondFactor(tool, input)` 有没有覆盖这个工具/这个 op，
  再看那条回复；两样都留下（这是"以为拦了其实没拦"的典型）
- 本机批准居然成功了 → **安全底线破了**，立刻停下并把 `relevant audit` 贴出来
- 手机确认后没执行 → 看 `GET /api/grant-audit` 里那条 `deny` 的 `code`

### 4.5 收尾

把临时 Bot 删干净（如果第 4.3 步没删掉）；确认没有留下多余的授权
（`GET /api/grants` 里不该有 `__验收临时__` 相关的条目）。

---

## 4b. 后台进程清理（P0-1 · 真机 · 约 3 分钟）

自动化部分已经在 `server/tests/shells.mjs` 里（每条用例起「命令 + 孙进程」，
`kill` / `killRoom` / `killByTask` / `stopAll` 之后 5 s 内扫进程表断言零存活）。
真机这一条验的是**端口与进程表**，因为用户报的是"进程结束了但风扇还在转 / 端口还占着"。

1. 让 bot 起一个开发服务器（`run_background` 里跑 `npm run dev` 或
   `python -m http.server 8931`），确认端口在听：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8931/`。
2. 用 `kill_shell` 结束它，**3 秒内**再打一次同一个地址 —— 期望连接被拒（不是超时）。
3. 同时看进程表：Windows `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*8931*' }`
   应该为空；macOS / Linux `ps -A -o pid=,command= | grep 8931` 应该只剩 grep 自己。
4. 再验一次服务端收工：Ctrl+C 停服务端，重复第 3 步的进程表检查（`shutdown` 现在会等
   `shells.stopAll()` 最多 3 s）。

**失败时看什么**：端口还在听 = 进程树没杀干净（回到 `shells.js` 的
`#terminateEntry`：Windows 是否等到了 `taskkill /T` 退出，POSIX 是否用了进程组信号）。

---

## 4c. Windows 原生桌面助手 · 阶段 A（P1-2 · 真机 · 约 10 分钟）

自动部分：`server/tests/desktop-helper-win.mjs`（契约 + 回退）、
`node server/tests/perf-stall.mjs`（两种实现的耗时与卡顿对比）、
`node server/tools/desktop-parity.mjs`（口径对拍）。下面是**只能真机做**的那几项。

1. **口径对拍**：`cd server && node tools/desktop-parity.mjs`
   期望最后一行是 `结论：口径一致 ✅`，且窗口矩形误差 `0px`。
   不一致时看谁多/谁少：多了 WorkerW 之类 → 少了 `WS_EX_TOOLWINDOW` 过滤或退回了 `GetWindowRect`。
2. **DPI 100% / 150%**：改缩放后重启 App（DPI 感知是进程启动时声明的），
   各跑一次 `desktop-parity.mjs`；两次的 `虚拟屏` 都应是物理像素
   （2560x1440 那台：100% 与 125% 都报 2560x1440，**不是** 2048x1152）。
3. **多显示器 / 混合缩放**：把光标移到第二块屏上，跑
   `node -e "…cursorPosition()"`（或工具层 `desktop_observe`），坐标应落在
   虚拟屏矩形内（虚拟屏的原点可能是负数）。
4. **锁屏**：Win+L 之后 `probeEnvironment()` 的 `session` 必须是 `false`；
   此时任何输入都应被拒绝（`no_session`），不允许"看起来点了"。
5. **UAC 安全桌面**：弹一个 UAC 提权框，确认助手拿不到输入桌面
   （`session:false`）—— 应当**停下来交还用户**，不是硬点。
6. **装了远程控制软件时**：`sampleInputNoise()` 应报 `phantom: true`
   （合成输入），验收这一项时换干净机器。

## 4d. Windows 原生桌面助手 · 阶段 B（M4 · 真机 · 约 15 分钟）

自动部分：`server/tests/desktop-helper-win.mjs`（含常驻协议/分片/超时/崩溃降级）、
`node server/tests/perf-stall.mjs --impl=native`（耗时与卡顿）、
`node server/tools/desktop-parity.mjs`（口径对拍）。下面是**只能真机做**的那几项。

1. **常驻进程起来了**：启动服务端后 `tasklist | findstr orbis-desktop-win` 应能看到
   **一个** `orbis-desktop-win.exe`（`serve`）。再点一次桌面动作，进程数**不变**
   （复用，不是每次都新起）。服务端停机（Ctrl+C / 退出）后该进程应消失，不留孤儿。
2. **阶段 B 指标**（§5.6）：`node server/tests/perf-stall.mjs --impl=native`
   期望 `probeP50Ms ≤ 2`、`listWindowsP50Ms ≤ 5`、`captureP50Ms ≤ 150`，
   且 `maxStallMs - baselineGapMs` 接近 0（`baselineGapMs` 是这台机器的计时器地板，
   Windows 一般 15–16 ms，**不要**把它当成卡顿）。
3. **截图不写盘**：截图落盘路径只由 Node 侧决定（`desktop-shots/...`）；
   助手进程**不接收任何文件路径**（`capture` 只回 `pngBase64`）。可用
   `strings server/resources/orbis-desktop-win.exe | findstr desktop-shots` 抽查（结果应为空）。
4. **外接屏热插拔 / 改缩放**：插拔一块外接屏或改 125%→150%，
   **无需重启服务端**，再截图与点击；坐标应仍然正确
   （常驻进程不缓存显示器与 DPI，每次请求都重查）。
5. **锁屏 / UAC**：Win+L 与弹 UAC 期间 `probeEnvironment().session` 应为 `false`，
   输入被拒绝（`no_session`），不是"点了但没效果"。
6. **GDI 句柄不涨**：连点/连截 200 次（`for /l %i in (1,1,200) do ...` 或脚本循环），
   任务管理器里助手进程的 **GDI 对象**数应回到基线（不随次数线性增长）。
   涨了就是 RAII 漏了一个句柄 —— 常驻进程最怕这个。
7. **截图长边**：`captureScreenshot({maxEdge:1600})` 的产物长边应 ≤ 1600，
   且 `meta.resized` 与 `originalWidth/originalHeight` 如实（纯 Rust 盒滤波，不是 PowerShell 缩放）。
8. **老程序全黑回退**：找一个 PrintWindow 只给黑图的程序（老 Win32 工具常见），
   截图应是**真实画面**而不是全黑（内存里 `is_mostly_blank` 判出来后回了 `bitblt`）。

**回退演练**：`set ORBIS_DESKTOP_WIN_IMPL=powershell` 重启服务端 → 桌面输入仍然可用
（慢约 15 倍），`server.log` 只该出现一次"回退 PowerShell"的提示；再删掉
`server/resources/orbis-desktop-win.exe` 重启 → 同样自动回退且只记一次。

## 4e. 集群泳道：Talk 旁路 / 独立复核 / 模型分档（rc.3 / 2.0.0 必验 · 真机 · 约 10 分钟）

rc.1 的两类问题都**只在真 SDK + 真 PiRunner 下出现**，单测全绿也抓不到：
`appendSystemPrompt` 被拼成字符串（真机暴露：Talk / Critic 在 reload 阶段抛 `appendSources.map`），
以及 `runner.resolveModel` 被摘下来裸调（复审时用真 SDK 端到端复现：Critic 与 fast/strong 分档抛
`Cannot read properties of undefined (reading 'modelRuntime')`）。
自动部分是 `node server/tests/real-sdk-lanes.mjs`（假模型端点，期望 6/6）；下面三项要对真模型跑一遍。

为了让结果确定、不靠模型自己决定要不要复核/分档，验收这一节时临时设两个开关
（验完删掉，恢复默认 `auto` / `explicit`）：`ORBIS_CRITIC_REVIEW=all`、`ORBIS_MODEL_TIER=auto`。

1. **群里 Talk 旁路**：部门群里成员正在干活时，用户在群里再发一句（比如「现在做到哪了？」）。
   期望几秒内出现一条旁路回话气泡；**不是**几十毫秒就报「模型请求失败，接口详情已隐藏」。
   `model-errors.jsonl` 里不该出现 `appendSources`。
2. **独立复核真的跑完**：派一份小活并让它交付（`ORBIS_CRITIC_REVIEW=all` 下机械验收一过就会复核）。
   期望 `server.log` 出现 `独立评审 <任务id> passed|failed round … model …`，任务的
   `criticState.lastVerdict` 有值；**不能**是连错 3 次后停在 `critic_unavailable`。
3. **fast/strong 分档真的派出去**：`ORBIS_MODEL_TIER=auto` 下让负责人拆一份含机械小活的任务。
   期望子任务正常执行完，`lastDispatchMeta.tier` 为 `fast` 或 `strong`；
   **不能**出现 `unknown_outcome` + `modelRuntime` 的 TypeError。

失败时把 `server.log` 里对应那几行与 `model-errors.jsonl` 末尾整段留下。

---

## 5. 回填对照表

| # | 验收项 | `docs/acceptance-matrix.md` 的行 | 期望关键字 |
|---|---|---|---|
| 1 | 锁屏后不盲点 | §1「电脑操作」→ `锁屏后不盲点` | `LOCK_NO_SESSION true` |
| 2 | 多屏 / 混合缩放 | §1「电脑操作」→ `多屏 / 混合缩放不盲点` | `MATCH true` + `缩放混合` |
| 3 | T1/T2 隔离 | §4「GUI 间接越权」→ `T1 独立桌面不能越界操控 T2 用户桌面` | `HOOK_BLOCKS_MEMBER true` |
| 4 | 手机强确认 | §5「用户确认」→ `手机通道的强确认在真机上有效` | 卡片 + 本机批准被拒 |

回填时按 `acceptance-matrix.md` 开头的规矩：填**环境**（OS 版本 / 屏幕 / 缩放到百分比）、
贴**证据命令**、改**状态**；一条没验就不要顺手把整组标通过。

`docs/WINDOWS.md`「桌面输入」表里还剩两行 `⚠ 静态实现，未实测`：

| 行 | 用哪条脚本 |
|---|---|
| 锁屏 / 断开会话 | 本清单第 1 条（`acceptance-lock-screen.mjs`） |
| 多屏 | 本清单第 2 条（`acceptance-multiscreen.mjs`） |

---

## 6. 还不能自动化的部分（写清楚，避免误以为漏了）

| 项 | 为什么还不能自动化 |
|---|---|
| `§2 桌面调度`「端到端：真机上用户接管 → 输入停下」 | 需要人在拖拽/输入过程中动手；且本机有合成输入源时判据不可信（见 §0） |
| `§9 push/merge`「实机 push 一次」 | 需要真远端 + 手机确认；`git-push-flow.mjs` 已经覆盖了确认链路，缺的是真手机那一下 |
| `#30 macOS 桌面输入` | 需要 Mac 硬件 |
