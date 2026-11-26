# TaskRun 协议与模块（批次 06）

一页冻结首次接单准入、客户端任务投影与控制协议。内部字段名、模型路由参数和凭据不出现在用户文案里。

## 首次接单链路

```text
已鉴权请求（WS/HTTP）
  → 请求闸门：requesterId + 稳定 requestId + 原始内容指纹 → 持久回执
      stage: running（并发同键返回 inflight；不同内容冲突；坏回执拒绝）
  → 现有 Mainbot 理解轮（同一轮，不另起模型）
      accept_task 工具：answer / clarification / accept_task proposal
  → 宿主准入：createTaskRun + acceptRequest（首个 Goal/预算/路由意图）
      · 未伪造 initial attempt / root started grant
      · 任务已落盘但回执写失败 → TaskRunStore.findByRequest 恢复，不重跑理解
  → 组织交接：04 同一服务核心 + 准入授权包装（0 次模型调用）
  → 该轮真正结束：关闭请求作用域，回执转 accepted/answered/failed
  → 05 调度负责人真实 attempt（独立事件入口）
```

- 不可变请求信封随 runner.send 进入实际队列；真正取得执行权时激活作用域、该轮真正结束时收尾。WS/HTTP 只交信封，不各自 begin/finally。
- 忙时新的独立请求按信封排队，不 steer 进正在跑的目标，不借身份。
- 残缺 managed 上下文明确拒绝，不降级到准入或 legacy；群聊明确拒绝（REQUEST_GROUP_UNSUPPORTED），不静默走旧路径。
- 预算由宿主给（`ORBIS_TASK_MAX_RUNS`，默认不限额，按次计）；理解轮不计入任务额度。
- 预算也能用 token 维度：`ORBIS_TASK_MAX_TOKENS`（部门 `maxTokens` 只收紧不放大）→ 根上按 `attempt.usage` 的 `inputTokens + outputTokens` 跨整棵树原子幂等累计；用尽进 `paused_budget`，扩额（`extraTokens`）后可继续。**超额不算坏数据**——跨过上限的那次执行只能结算后才知道。
- 并发也由宿主给：同一个根默认**最多 4 份受管执行同时在跑**（`ORBIS_TASK_CONCURRENCY`，1..16；部门预算里的 `concurrencyLimit` 只收紧不放大），部门里各成员的会话本来就独立。真正硬的两条不变量是**同 Bot 互斥**（一个成员只有一个会话）与**同 tick 文件互斥**（声明了同一个文件的活不同时在途）；上游熔断时并发自动降回 1。名额满只是排队，不判死。

## 受控子任务 DAG 与共享黑板（2.0 集群 C1）

- 派活可带 `dependsOn`（前置**子任务 id** 或计划**步骤号**）：**全部前置验收完成**之前不启动；落盘前跑环检测，自环/任意长度环/跨父依赖一律拒收（fail-closed）。
- 依赖状态只有四种：`ready` / `waiting` / `checkpoint`（前置都完成、等负责人放行）/ `upstream_failed`（前置已永久受阻或被取消 —— 下游绝不启动）。
- 自动接力：子任务交付（机械验收通过）后，因它变 `ready` 的下游立即被唤醒 —— **零次负责人模型调用**。
- 防死等：`upstream_failed` 与「受阻」等价参与父任务收口，自主模式交回负责人、非自主模式如实阻塞并说清是谁的失败。
- 父任务一定会被叫醒：负责人在自己这一轮里派出的子任务，是在这一轮收尾后由调度器单独跑的（父任务那一轮已经返回 wait）。子任务在这条路上**变成**取消 / 永久受阻 / 预算暂停时，推进器主动叫醒父任务；用户单独取消一份子任务同样叫醒父任务。可恢复阻塞（等上游、等主仓可合入）不叫——它们到点会自己醒，父任务该等着。
- 共享黑板挂在根任务 `blackboard` 上：最多 24 条（先淘汰最旧的非约束）、单条 ≤240 字、渲染 ≤1200 字；交付事实自动落一条 `artifact`，负责人/成员可用 `task_blackboard` 写 `decision`/`constraint`/`fact`。写入目标只取受管上下文的根任务，调用方无法指定（防跨任务串写）。

## 集群全景与候选经验（2.0 集群 C5）

- **服务端投影（向后兼容）**：
  - `GET /api/task-runs`（列表）保持轻量：`budget` 补全 token 维度（`maxTokens`/`usedTokens`/`extraTokens`/`remainingTokens`）+ 一个只有几个标量的 `telemetrySummary`；
  - `GET /api/task-runs/:id`（单条详情）额外投影 `waterfall`（时间线 `originAt`/`endAt`/`items`/`truncated`）、`telemetry`（`totalTokens`/`byBot`/`byModel`/`counts`/`budget`）与 `blackboard`（精选 10 条）；
  - **Token 口径不双计**：`totalTokens` 优先用根 `budget.usedTokens`（整棵树权威累计），缺失时才退化为子树已结算尝试求和，并用 `totalTokensSource` 标明来源；
  - **不编造价格**：没有单价时 `costUsd` / `estimatedCostUsd` 一律 `null`（服务端不内置价目表，由宿主注入 `costOf`）。
- **控制通道**：`POST /api/task-runs/:id/control` 的 `extend` 支持同时或单独传 `extraRuns` / `extraTokens`；新增 `approve_checkpoint`（`childTaskRunId`），记成用户放行（`checkpointApprovedBy = 'user'`）并走与负责人相同的放行链路。
- **候选经验通知**：复盘生成新 `candidate` 时广播轻量 `{ t: 'lessons.changed', roomId, count }`（不带正文），客户端收到后自行 `loadLessons()`；启用仍受 `lessons.js` 的「无证据不可启用」fail-closed 校验。
- **客户端**：详情弹窗打开即异步 `fetchDetail` 拉完整快照；轻量列表/WS 推送合并时**保留已有明细**（不会把瀑布流冲成 null）；侧栏顶部常驻候选经验卡（0 条时 0 像素，无证据禁用采纳）。

## 并发编码的 Git Worktree 隔离（2.0 集群 C4）

- **何时启用**：`ORBIS_TASK_WORKTREE` = `off` | `explicit`（默认）| `auto`。只有**子任务**可开（负责人/主控永远在主工作区协调）；`explicit` 只在 `assign_member_task` / `createChildTask` / `createTaskRun` 显式给了 `useWorktree: true` 或 `worktreeRepo` 时建，`auto` 额外按「声明了仓库内文件 / 目标是改代码」判定。
- **落点**：`<workspace>/.orbis-worktrees/<safeTaskId>`（必须在 workspace 内 —— 沙箱允许目录、`repoTrustVerdict`、git 工具的 `resolveRepo` 三条都按这条判）。**绝不落 `dataDir`**；**绝不改 `.gitignore`**（幂等写 `<commonDir>/info/exclude`）；分支固定 `orbis/task/<safeTaskId>`，`safeId` 只允许 `[A-Za-z0-9._-]`（防参数注入与路径穿越）。
- **生命周期**（全部在 `withRepoWriteLock({ commonDir })` 内串行化，拿不到锁短暂重排而非判死）：
  1. `prepareWorktree`（幂等）：复用优先 —— 返工/续段直接接着用同一棵树，**绝不清空半成品**；空仓（无 HEAD）与越界 `worktreeRepo` fail-closed 拒绝。
  2. `mergeWorktree`（**只在机械验收 + 独立复核全过之后、`verification_finished(passed)` 之前**，否则归约器已把任务置为 `completed`，再 `block()` 会被拒、冲突被静默吞掉）：自动 `git add -A` + `commit`（没配提交身份才用兜底身份，**绝不 `--no-verify`**）→ 无净提交记 `noop` 并清理 → **主仓此刻不能安全合入就不合并**（保留分支，`preserved_dirty_main` + `waitCode`）→ 能则 `git merge --no-ff` → 成功后核对 HEAD 前进、`worktree remove` + 安全 `branch -d`，记 `mergedHead` / `filesChanged`（**只算这次合入带进主仓的文件**，即合入前后 HEAD 之差）并落黑板。
     - 「不能安全合入」逐条判（与 merge 同一把写锁）：`detached_head`（分离头指针，bisect / rebase 停住时——合进去的提交不属于任何分支）、`operation_in_progress`（MERGE_HEAD / rebase-merge / rebase-apply / CHERRY_PICK_HEAD / REVERT_HEAD / BISECT_LOG）、`dirty_main`（**已跟踪**文件有未提交改动——带着它们 merge 一旦冲突，`merge --abort` 不保证能还原）、`base_not_in_head`（当前分支不包含这份活的起点，合入会带进无关提交）、`untracked_collision`（未跟踪文件会被这次合入覆盖）。**其余未跟踪文件不挡合入**（用户草稿、`_inbox/` 附件副本、构建产物合并根本碰不到）。
     - 这些都是「用户处理一下就好」的状态，所以子任务进**可恢复阻塞**（`recoverableBlock: 'worktree_main'` + `retryAt`，默认 60 秒）：到点只重跑纯代码验收 + 合入（不调模型、不扣额度）；父任务视它为「在等、会自己醒」——**不交回、不取消、不重做**，下游依赖也只是继续等；用户点「解除阻塞」立即重试。
  3. **冲突 fail-closed**：冲突清单**先取再 `merge --abort`**（abort 会清空未合并索引），主工作树恢复 100% 干净，分支与 worktree **完整保留**（`conflict`），`block()` 交回负责人。
  4. `cleanupWorktree`：取消/改版时只清 `status === 'active'` 的树（`worktree remove --force` + `branch -D`）；`conflict` / `preserved_dirty_main` 的分支**绝不删**。`pruneOrphanWorktrees` 只扫终态残留。
- **与文件互斥**：非 worktree 子任务 `fileClaims` 100% 照旧；**只有双方都在各自 worktree** 时才放宽（`worktreesBypassFileClaims`）——磁盘真分开了，冲突留到合并阶段。
- **Critic 联动**：`task-critic-runner` 把 `workDir = taskRun.worktree.worktreePath` 传给 `criticLane`，评审员的 `read/ls/find/grep` 直接在子任务那棵树里验真改动；没过就在同一棵里返工，绝不污染主仓。
- **会话隔离**：带 `workDir` 的执行一律走独立内存泳道（`cloneId = taskRun.id` + `persist: false`）；`session-factory` 用 `effectiveWorkDir = opts.workDir || config.workspace` 注入 `cwd` / 沙箱 `workDir` / `createAgentSession.cwd` / git 工具目标。

## 同角色临时分身与模型分档（2.0 集群 C3）

- **分身边界**：只有**子任务**（`parentTaskId` 非空）可以开临时分身；负责人（根任务）与私聊 solo 永远走主会话，保住协调记忆连续性。
- **开关**：`ORBIS_WORKER_CLONE` = `on`（默认）| `off`；`ORBIS_MAX_CLONES_PER_BOT` 默认 2（单个成员最多 1 主 + 2 分身，硬封顶 6）。`off` 时槽位恒为 1，行为与加这个能力之前逐字节一致。
- **实际并发还被压两次**：根 `budget.concurrencyLimit` / 部门并发预算，以及上游健康度（有熔断打开 → 自动退回串行）。
- **两条硬不变量绝不放松**：① 文件占用互斥（`fileClaims` / `claimsOverlap`）—— 同一个 Bot 的两个分身撞文件照样排队；② 根并发上限与 DAG 依赖/checkpoint 闸门。
- **主槽 vs 分身**：子任务且（同 Bot 已有在途 **或** 主会话被用户聊天占着）且还有配额 → 直接开分身（`cloneId = taskRunId`）立刻跑，不再傻等 15 秒；否则走主会话。
- **泳道键（`runner/session-lanes.js`）**：`room:bot` / `room:bot#fb` / `room:bot#clone_<id>` / `room:bot#clone_<id>#fb`。分身会话 `persist: false`（纯内存、不写 `store.sessionFile`），`finally` 里 `dispose()` 用完即焚。**五处按 key 存的状态全部绑泳道键**：`runner.sessions`、报告收集器（`activateReportScope`）、`currentTaskContext`（policy-hook / 黑板）、`dispatching`、`managedInflight`；房间级中止从键里剥离 `#…` 还原真实 `botId`。
- **模型分档**：`ORBIS_MODEL_TIER` = `off` | `explicit`（默认）| `auto`；`ORBIS_TIER_MODEL_FAST` / `ORBIS_TIER_MODEL_STRONG` 可指定档位模型。`assign_member_task` / `createChildTask` / `createTaskRun` 可传 `modelTier`（存 `flags.modelTier`，不进业务身份指纹，子任务默认继承父任务）。
- **七条硬边界**：`standard`/无效 → 零扰动；`bot.lockModel === true` → 绝不覆盖；本地/内网执行者绝不外泄到公有云（含 `ORBIS_TIER_MODEL_*`）；熔断组跳过；按档位打分（fast 偏 flash/mini，strong 偏 opus/reason/large）；挑出的模型与当前相同 → 不覆盖；**遵守 `ORBIS_MODEL_FALLBACK`**（`same-provider` 只在执行者同一家里挑、显式档位模型跨家也拒绝；`off` 不自动挑，显式档位模型照用）。**绝不写 `bot.model`**，只对这一次执行生效（纯内存会话，跑完即弃）。
- 实际生效的 `{ cloned, cloneId, tier, modelOverride, why }` 记在 `taskRun.lastDispatchMeta`，供可观测与面板展示。

## 独立评审 / 质检回路（2.0 集群 C2）

- 档位：`ORBIS_CRITIC_REVIEW` = `off` | `auto`（默认）| `all`。
  - `auto`：机械验收全过后，只要「有未评审的 `expert` 条件」或「任务 `criticRequired: true`」就审一次；
  - `all`：所有通过机械验收的任务都审；
  - `off`：完全关闭（也不注入执行器）。
- **零浪费**：机械验收没过（`unmet` / `blocked` 非空）时**绝不调用**评审员，先让执行者修确定性错误。
- 评审会话：全新 `SessionManager.inMemory`（不落盘、不复用执行者历史）+ 只读工具白名单 `read/ls/find/grep`（无写、无 shell、无 MCP、无宿主自定义工具）+ 策略层 `dangerous: 'deny'`；`finally` 里 `dispose()`。选模优先换一个健康且不同的模型（`ORBIS_CRITIC_MODEL` 可指定），**本地/内网执行者绝不被换到公有云**（`ORBIS_CRITIC_MODEL` 指向云端也一样拒绝，不做“静默忽略”），没有替代时退回同款模型但仍是干净会话。评审员会读产物原文，所以选模**与自动兜底守同一条 `ORBIS_MODEL_FALLBACK` 边界**：`same-provider` 只在执行者同一家里换（显式指定跨家也拒绝并说明），`off` 不自动换（显式指定照用）；成员 `lockModel === true` 时只用同款模型（显式指定也不用）。
- 读评审输出按真实 SDK 事件：`message_start`（assistant）清本轮缓冲、`text_delta` 只追加、`message_end`（assistant）单点计 `usage` 并先判 `assistantFailure`（429/auth/模型错走 `prompt_failed`，不落成 `no_output`）；结论取**最后一个带 `verdict` 的平衡 JSON**（模型在结论前提字段、或先调只读工具都不会把解析带偏）。
- 结论 fail-closed：只接受 `{verdict, summary, defects}`；`passed` 必须带结论依据且 `defects` 为空；`failed` 必须至少 1 条可执行缺陷；解析不了 = `parse_error`，绝不自动放行。
- 绑定与去重：每次评审绑定 `(revision, 最新已结算 attemptId, 产物指纹)`；同一产出不重复审；**上一轮的 `failed` 记录不会挡住返工后的新一轮评审**（`expertReviews` 里的 `critic_review` 按尝试过滤，负责人的人工判断仍对整个版本有效）。
- 有界返工：`MAX_CRITIC_REWORKS = 2`；未达标就走标准 `verification_finished(passed: false, unmet: defects)` 自动返工，返工提示词带完整缺陷清单；连续 2 轮不过 → `block`，子任务走既有 `handBackBlockedChildren` 把真实缺陷交给负责人。
- 评审员自身故障（超时 / 429 / 抛错 / 输出无法解析）**不算业务缺陷**：不扣返工额度、不伪造通过，30 秒后重试（`retryAt` 在 `verifying` 态也生效，到期前的任何 `notify` 不得穿透连撞）；连续 3 次跑不起来才阻塞等人工，并记成「不交回」的不可恢复类别 `critic_unavailable`——活已经做完、只是没人能审，父任务如实停下，而不是把它交回负责人取消、再派人重做一遍。
- 人工介入后的重置：手动解除阻塞 / 暂停后继续 会把 `criticState` 的 `reworkCount` / `errorCount` 清零（保留 `lastPassedKey` 等历史）——否则按钮按下去立刻又到上限、又 block。达上限时**先把验收收口（清 `verifyingAt`）再 block**，解除后回到 `queued` 让执行者真的再干一轮，而不是拿旧产出秒阻。
- 追加额度（`onBudgetExtended`）会把整棵树的预算暂停一起恢复，且**先恢复全部子任务再唤醒**（否则先醒来的根会看到还在暂停的子任务，把它自己又暂停回去）。
- 预算与竞态：评审前查根 `remainingTokensOf`（用尽走 `paused_budget`，不偷跑）；返回的 `usage` 计入根 `budget.usedTokens`；`await` 回来后重读任务，取消/暂停/改版则丢弃结论（写事务里再核一次 revision）。


## 回执读结果原则

只有 ENOENT 才是「不存在」。有效 JSON 但缺 receipt、身份/请求不符、未知版本/阶段、字段损坏 → 一律 corrupt：调用方如实失败，不当新请求，不重跑理解。running 超过租约且无对应 TaskRun → 允许同 requestId 重试；已有 TaskRun 事实 → 重建 accepted。

## 首次准入模式（宿主可信）

- 用户消息模式由宿主请求信封携带；discussion 在准入入口统一生效：不建任务/不建组/不派执行，模型换工具也不能覆盖。
- direct：不建部门，绑定主控为合法执行者，由 05 在用户房间启动；createOnly：复用 04 创建操作建组后收口，不派执行、不 notify 05。
- 只有新部门正常路径会创建部门并派发；三条路都不另造组织协调器。

## 命令应用事实

命令信封（commandId/type/ref/decision/text/原 expectedRevision）先写 pending；副作用成功后把 commandId 与领域变更一起写进 TaskRun.appliedCommands，再写 applied 回执。重放只认应用事实：已应用 → 回放不重复；未应用且任务 sequence 已变化 → 不确定拒绝；从未变动才允许重试。输入/审批先校验任务/版本/ref 门槛与审批归属，再产生任何副作用。

## 请求 outbox

完整不可变请求信封（requestId/房间/文本/原 mode/附件/所属服务身份）发送前落盘；写盘失败不发送。新用户操作新信封，重传只复发原信封；跨服务身份不重发；WS queued/inProgress ACK 不清理，只有可靠受理/明确拒绝才清理。

## 同步完整性

hello 带活跃快照（含完整性与根预算）+ taskRunMeta.activeCount/activeComplete + recent 终态；/api/task-runs?scope=active|history&before=&limit= 返回 complete/nextBefore。客户端按 before 翻页取完整活跃集合，完整快照缺席的旧活跃任务按单任务快照补查终态，不把截断当删除、也不让旧 running 永挂。第三张及以后活跃与历史统一进“任务记录”入口。

## DM 受管执行与仅建组收口

- direct/私聊 TaskRun 不再走 runRound：runtime 按真实房间类型选择，DM 用 PiRunner.run(roomId,botId,prompt,{managedContext,skipUserMessage:true})，复用同一 attempt/根授权/报告/产物/用量；group 保留 runRound。执行前用房间成员事实核对 bot，不靠上下文自证。
- 受管取消句柄在真实取得会话执行权时登记（DM/group 同一 map），finally 只清自己的 task/attempt；abortManagedTask 对 DM 同样生效。
- createOnly：复用 04 创建操作真建组；完成后用可验证的主机建组收据把容器 TaskRun 终结为 completed，写 delivery（source=host_department_receipt），不伪造模型 attempt/报告，也不留 queued 幽灵任务。

## 命令应用事实的身份

appliedCommands 与命令回执同键：requesterId + commandId + fingerprint 三者全匹配才认作本命令的应用事实；缺身份或不匹配一律不能用别的操作成功事实回放，返回不确定/冲突。事实写在领域变更之后是第二次 mutate（非原子）；失败保持 pending，重放按 sequence 变化判不确定，不重复。

## 输入提交校验

输入在 taskRuns.mutate 的当前记录内校验 revision 与 input 门槛后再追加；入口预检只做早拒绝。被拒文本不进入 inputs、不进入后续 prompt；审计信息与已接受上下文分离。

## 发送 outbox 交错

首发开始即捕获服务身份与不可变信封；写盘成功后校验同一代次，切服期间不把 A 文本发给 B。写盘失败恢复原 pending entry，不能先覆盖再删除。

## 稳定分页游标

排序固定为 updatedAt desc + id asc；cursor 为 {updatedAt,id} 的不透明编码，服务端过滤与客户端传参同一契约，返回 complete/nextCursor。同毫秒任务不会因仅时间戳分页被跳过。
## R4 提交一致性补充

- RequestOutbox 使用单事务队列串行化「读最新快照 → 构造候选 → 写盘 → 提交内存」；remember/clear/persist/load 共用同一条队列。失败恢复原记录，队列吞掉异常后仍可继续；并发两条待确认请求都能持久化并在重启恢复。
- 准入完成提交在最终 mutate 的当前记录上复用 admissionAuthorize，并核对冻结 admission.revision、operationId、createOnly 模式与主机收据 operationId；不匹配返回 admission_stale，保留新目标与进度，旧操作已建资源保留，不把旧收据标成新版本完成。
- 完成 mutate 结果逐项检查；失败不得包装成 accepted/completed。
## 请求终态确认（R5）

- 收件 ACK/queued/inflight 只表示已收到，不是受理终态；客户端不得用缺省字段推断完成，outbox 保留完整信封直至可靠终态。
- 终态由持久 receipts/TaskRun 事实投影：accepted（宿主已接管，TaskRun 已落盘）、answer、clarification、discussion、failed（无 TaskRun 时可重试）。`projectRequestResult` 是唯一投影，WS `request.result` 与 HTTP `GET /api/request-results/:requestId` 共用。
- 终态事件携带原 requestId、status、accepted、kind、taskRunId、retryable；`request.result` 只在 receipt 写入成功后发送（lifecycle close 回调），不把模型文本/msg.done 当受理确认。
- AppState 收到可靠终态才清理 outbox；丢最终帧时按原服务身份与 requestId 查询回执对账（重连 hello 后逐条对账、HTTP fallback 轮询），不重新调用模型；旧服务确认不能清新服务待发项。
## 权威结果读取（R6）

- `createRequestResultService` 是唯一读取：认证 requesterId+requestId 对应的 TaskRun 已存在即 accepted（taskRunId 真实），回执缺失/滞后/写失败不得降级为 pending/failed；无 TaskRun 才看校验过的回执；读取不确定明确失败。
- `closeRequest` 与 query、WS publisher 共用该服务；accepted 回执修复写入失败与 Goal 已接管分开，不把已接管任务反写成 failed/NO_INTAKE_VERDICT。
- 无 TaskRun 的终态写失败不发布成功；坏回执/任务读取不确定发布明确失败；未知请求保持 pending。

## 统一请求身份（R6）

- 规范键为认证 requesterId + requestId（`requestIdentityKey`），贯穿回执、忙时队列去重、requestDecisions、结果投递与客户端确认匹配；持久回执键格式保持兼容。
- 队列/决议不再用裸 requestId；A/B 同 ID 是两条独立请求，可各自排队执行；同一来源同 ID 同内容仍去重，改内容仍冲突。
- `request.result` 按原请求来源设备定向投递（同一人的其他配对设备仍可控制同一 TaskRun，不做租户墙）；客户端用 hello 下发的当前认证 device id 核对来源，不从正文猜匹配。
## R7 确认边界

- 读取不确定（坏回执/TaskRun 读取 EIO）不是可靠拒绝：publisher 只发非终态 `status:unknown`（source:uncertain），客户端一律保留原信封并继续保留确认依据；`retryable` 只描述能否重发，不用于删除确认。修复数据后仍按原 requestId 查询事实，不重跑模型。真实 answer/clarification/discussion/failed 与 accepted 语义不变。
- 客户端设备身份绑定当前 API/凭据/服务代次：api setter 变化即清除旧 hello 设备绑定；当前已认证 HTTP 回执无需新 WS hello 即可消费；旧服务回包仍按服务身份拒绝；轮询只有真正消费了可靠终态才停止，身份拒绝不算收口。
## 生产启动与受控启用（批次 07）

- 真实入口 `src/index.js → server-main.js` 在 PiRunner 初始化后装配唯一 `TaskRuntime`（bootstrap/task-host.js），默认机械验收 access 只按附件 id 读写真实产物；HTTP/WS 就绪后执行一次 `recover()`；SIGINT/SIGTERM 时 dispose 任务调度并保存 store。测试不再在外部手装 runtime 或手动 notify。
- 开关 `ORBIS_TASK_INTAKE` 默认关闭。关闭态：新 App 携带合法 requestId 的私聊/群聊按普通聊天处理，不要求 accept_task、不建 TaskRun，本轮结束记 answered 并发布终态确认；无 requestId 旧协议保持；显式非法 requestId 明确 400/error，不静默回落 legacy。
- 开启态：自然消息→主控既有理解轮→真实 accept_task→组织/直派→负责人/成员→默认验收→completed；createOnly/direct/discussion 沿用 04/06 语义。
- 任务咨询/修订工具 `task_status` / `task_revise` 只在受控启用时注册给主控；查询只读，修订以“认证来源+requestId”派生稳定命令身份，冻结原 taskRunId、expectedRevision 与完整修改方案，重放先查原命令应用事实；不覆盖 TaskRun.request 原接单身份，不按最新 updatedAt 猜目标，同一次修改重试不重复升版。
- 改版事件在归约当前记录上核对 expectedRevision，入口与执行之间被并发改版时拒绝旧提交。

## 迁移与回退（07）

- 新增数据均为可选文件：TaskRun、请求回执、命令回执；旧会话/消息/任务板无需迁移。旧版本可忽略新任务文件，但**不能**继续执行/完成新协议 TaskRun。
- 回退顺序：先暂停新执行任务并保存进展（关闭开关或停止调度），保留 TaskRun/回执用于查证；不得清空或重放未知副作用。旧版本不识别新任务时仅继续旧聊天/旧任务板。
- 开关关闭不删除已有 TaskRun，后续可重新受控启用查看/继续；迁移/回退不新增数据库或云服务。

## 用户群预算与任务根预算（07）

- 旧 `groupLimits.maxRuns` 是“一条用户消息最多触发几次 bot 运行”的用户上限。新受管链保留每次 groupTurn 的单段限制（turnMaxMs/maxSteps）。
- **根预算默认不限额**：只有用户**显式改过**部门预算的 `maxRuns`（`state.groupLimitsExplicit.maxRuns`，只在值真的变了时才记）才收紧任务根预算，取 `min(任务链默认值, 用户 maxRuns)`：只收紧、不放大。
  - 为什么不能用“patch 里出现过”判显式：面板保存时会把整份 limits 一起发过来，`maxRuns` 总是出现在 patch 里 —— 那样等于每个保存过面板的人都“显式设置”了根预算，默认值会悄悄变成天花板。
  - 用户调低上限会真实限制自然接单后的根/父子累计执行，重启不重置；恢复成默认值后重新回到不限额。
- `maxSteps/turnMaxMs` 仍是单段执行限制，不是 Goal 总步数；模型字段不能当作用户追加预算。共享子任务的预算展示读取根事实。

## 改版命令的不变信封（07）

- 同一认证请求（requesterId+requestId）派生稳定 commandId；首次调用冻结目标任务、原 expectedRevision 与完整修改 goal，并交给命令服务持久 pending envelope。
- 同请求重试先读原命令信封/应用事实：已应用则回放、不再次升版；不按当前版本/当前 Goal 重新解释。改版归约在当前记录上核对 expectedRevision，入口与执行之间被并发改版时拒绝旧提交。TaskRun.request 的最初接单身份保持不变。

## 成果证据来源与专业验收（07 修正）

- 默认验收的白名单不再只取本任务当前 attempt：共用可信解析会读取本任务当前/历史已登记产物，以及**通过持久 parentTaskId/parentRevision 真实关联且已完成**的子任务账本。每条候选保留 sourceTaskId/sourceRevision/attemptId 来源，仍按当前版本目标条件重新 stat/read；旧版本或子任务产物不会复制成父 attempt，也不会直接改写 evidence.revision。
- 读不到文件必须走失败/阻塞通道：生产 createTaskAccess.readText 对缺失文件抛错；markdown/text 格式读取失败是 blocked，不会把“文件不存在”当正文通过。
- expert 条件是专业判断而非机械证明：负责人受管验收回合可用 task_expert_review 记录 conditionId/任务/版本/判断/依据/来源；机械验收消费同任务、同版本、同条件的记录，没有记录仍是 needsReview，普通完成文本不能放行。runTest/listReceipts 未配置时对应条件保持 blocked。
- 改版命令冻结信封包含 deferNotify；自然 task_revise 先入本轮请求队列，等当前主控理解轮释放后再启动新尝试，不抢会话、不白扣失败尝试。命令应用事实保留原 envelope，同一请求重试可回放。

## 初次交接恢复（07 修正）

- 真实启动 recover 先扫描 admission.status 为 pending_handoff / handoff_failed 的 TaskRun，按已持久化 routeSpec/operationId/请求身份恢复建部门与 owner，不依赖用户重发、不重放未知副作用；随后再做普通任务恢复扫描。已完成任务重启不重做、运行中未知仍按既有保守核验处理，三者分别取证。

## 远程帧与日志（07 修正）

- App 共享 WS 帧解码同时接受文本帧和合法 UTF-8 二进制 JSON（relay 实际转发 Buffer），坏帧忽略；兼容直连/现有 relay，Mac/Win 共用同一逻辑。
- relay/agent 诊断日志对 WS path 的 query 统一脱敏为 ?<redacted>，不改变实际转发；正常连接诊断保留 pathname。

## 07 支持边界（如实）

- 默认 access 只提供 stat/readText；runTest、listReceipts 未配置时，test/receipt 条件按既有规则 blocked，不会假装通过；需要时由宿主显式注入对应入口。
- 专业验收由负责人受管验收回合的 task_expert_review 记录驱动；机械条件与专业判断分开，普通完成文本不能替代专业判断。未记录的 expert 条件保持 needsReview。
- 可信候选的旧版本/子交付只在当前目标条件重新 stat/read 通过后使用；不把旧 evidence.revision 改写为新版本，不伪造父 attempt，不因改版自动放宽负责人写权限或恒真 verify。
- 真实公网 relay/TLS、真实手机现场、原生安装包/窗口关闭仍未测；relay 结论只覆盖现有代码的合成 loopback 与 Flutter 帧解码组合。

## 07 R2 修复边界

- **初次执行恢复**：交接 admission 写 done 后，next.action=dispatch + owner + admission.done + 0 attempt + queued 是持久首派意图；supervisor 恢复阶段显式识别并唤醒既有执行路径。createOnly、暂停、取消、open gate、已有 attempt/未知占位不满足首派条件，不复活；pending_handoff/handoff_failed 仍先由交接恢复补建唯一部门/owner。
- **证据选择**：候选池保留当前版本、真实子交付、最近历史交付的来源全集；本次选定交付取当前版本最近一次真实登记产物，数量不足才按“同版本更早 attempt → 当前子交付 → 最近历史交付”补足；count/format 对同一选定集合逐条核验，不允许好文件掩盖同集合坏文件，也不改写历史 revision。显式 attemptId 只取该已结算 attempt；不存在/无产物不借历史。
- **完成申请的选择集合**：正式 task_report 的完成选择在 attempt 结算时归一化为 AttemptResult 结果字段（completionSelection）并随账本持久；验收只读该持久事实，从可信候选池中选择本次核验集合，claim 本身不是证明。旧账本无该字段时按默认规则兼容；新的空选择不继承更早选择。选择未知/坏 ref 直接拒绝并失败，不加入 allowedRefs、不交给 stat/read、不静默换成旁边好文件；没有明确 claimedEvidence 选择时才用默认“最近登记交付 + 数量不足按同版本→子交付→最近历史补足”的保守规则。候选收集、选择、验证是三个职责，count/format 使用同一选定集合。显式 attempt 的总入口统一校验存在/归属/版本/结算状态，expert 判断也只消费该 attempt 范围；默认任务级合法汇总保持不变。
- **专业验收**：审查历史 append；同一受管 attempt 重复调用是操作重放（同载荷复用、不同载荷拒绝），新的合法 attempt 可更新当前结论，消费者取最后一条有效判断。验收能力与派工能力分开：真实部门负责人（含单成员部门）可验收；DM direct 的 expert 条件在接单阶段明确拒绝 expert_route_unsupported，不空转烧预算。

## 长任务：默认自主、时间片与续段（2.0）

### 自主推进（`autonomy` 控制命令）

| 项 | 规则 |
|---|---|
| 默认 | 新任务默认**自主**（做完为止，不停下来问「要不要继续」）。用户原话命中「先问我 / 每步确认 / 确认后再动手」才逐步确认；`ORBIS_TASK_AUTONOMY=0` 退回旧行为 |
| 命令 | `{type:'autonomy', decision:'on'|'off', commandId, expectedRevision}`；`decision` 只认 `on`/`off`，其他值 400 `BAD_DECISION` |
| 生效范围 | 写**根任务**并同步全部子孙（`flags.autonomous`）；投影 `autonomous`/`autonomyReason` 以根为准，子任务不各自为政 |
| 生效判定 | 与 pause 等一致：应用后回读根任务 `flags.autonomous` 是否真的等于请求值；任务已终态时返回 `terminal`（客户端置灰） |
| 幂等 | 同 `commandId` 重发按回执回放，不二次升版 |

### 单轮时间片（替代 10 分钟硬上限）

- 到点先 steer 一条收尾通知（报进度、说还差什么）→ 宽限 `ORBIS_TURN_GRACE_MS`（默认 3 分钟）→ 宽限内工具还在出结果就再宽限一次 → 硬上限 `ORBIS_TURN_HARD_MAX_MS`（默认单段 ×3）。
- 收住的记 `stop:'yielded'`（让出）**不记失败**：推进器按让出续跑，非受管群聊把同一个 bot 重新排进本轮队列（占它自己的发言预算）。
- 续段提示词带 `【系统·续段】`，要求先核对现状再从断点继续，不许从头重来。

### 停滞判定（两档）

| 档 | 默认 | 含义 |
|---|---|---|
| `maxStallRounds` | 2 | 既没推进目标、也**没改动任何东西**的连续轮数 → 真卡住 |
| `maxMilestoneRounds` | 12 | 一直在改文件/出产物，但目标迟迟没推进的轮数 → 磨洋工 |

- 「改了文件 / 出了产物」算真实干活（`workDoneBy`），不按「有没有说话」判。
- 让出（yielded）分支只计一次数：旧代码在第 2 段就判死，长任务必挂。

### 子任务全部受阻

- 非自主：如实阻塞（等用户），不假装推进。
- 自主：把失败的分工**交回负责人**（`MAX_CHILD_HANDBACKS=2`，记 `childFailures`），由它重新安排；负责人提示词里会列出被收回的失败分工。
- 旧代码这一段走不到，结果是根任务永远停在 `queued`。

### 上游故障：不丢活（2.0 第二批）

| 场景 | 规则 |
|---|---|
| 判定 | `retry-policy.js` 的 `isUpstreamTransient`：429 / 5xx / 熔断打开 / 网络瞬断算；401/403/402/额度/用户中止**不算**（等一下也不会好，早说清） |
| 受管任务 | 快速重试（1.5–12s，最多 10 次）用尽 → `recoverableBlock: 'upstream'` + `retryAt`，阶梯 `1→2→5→10→15` 分钟、累计上限 2 小时；到期自动走 `unblocked` 清标记并续跑 |
| 群聊 | 熔断/瞬试用尽 → 阶梯 `1→2→5→10` 分钟、累计上限 1 小时，**不持锁等待**（`roundLocks` 照常释放），到期复核 `aborting` / `roundEpoch` 后才续派 |
| 作废 | 用户插话（`interruptRoundForUser`）、来新消息、`abort` 都会取消挂起的定时器；到期复核也自己挡一道 |
| 到上限 | 摘掉可恢复标记，如实阻塞 + 说清累计等了多久，不再自动排 |
| 恢复 | `recoverableBlock: 'upstream'` 且 `retryAt > now` → 只出 `deferUpstream`（挂定时器），**不许提前解阻** |

### 重启后自动续跑（受管）

一条尝试没留下结果记录（服务重启）时，按 `state.grantAudit` 判断那一段做过什么，**fail-closed**：

1. 拿不到 `startedAt` → 保守阻塞；
2. 那段期间、同 bot、同房间**放行过**不可逆动作（`capabilities.isIrreversible`）→ 保持「需人工确认」；
   老审计记录没有 `roomId` 的按「可能命中」算；
3. 证明没做过不可逆的事 → 结算成 `stop:'yielded'` +「服务重启，执行被中断」，推进器按让出续跑。

## 客户端协议

| 项 | 规则 |
|---|---|
| 快照 | hello.taskRuns（权威）；GET /api/task-runs 列表；GET /api/task-runs/:id 带 authoritative/cursor/gap |
| 增量 | WS taskRun.updated（服务端投影）；客户端按每任务 storeVersion 合并，旧值/同版本重复拒绝，跨度>1 触发补拉 |
| 版本 | revision 目标版本、sequence 领域事件序号、storeVersion 持久变化版本；预算/nextAction 变化也走 storeVersion |
| 控制 | POST /api/task-runs/:id/control：type, commandId, expectedRevision, ref?, text?, decision?, reason?, extraRuns?；type 含 pause/resume/cancel/input/approval/revision/unblock/extend/**autonomy** |
| 幂等 | 命令回执按认证身份+commandId 持久；重发返回 replayed；同 ID 不同内容 409；旧 revision 409 |
| 身份 | 只来自现有鉴权；不按来源设备隔离可见性（同一用户已配对设备互控）；不新增云端/DB |
| 结果 | result.prepared（服务端已验收）≠ delivered（设备已收到）；离线补送不重做任务 |
| 旧语义 | 手工 TaskItem/500 条/勾完成保持；TaskRun 独立存储，通用勾选不能绕过验收 |

入口：TaskRunStrip（输入框上方状态卡）→ showTaskRunSheet（详情/暂停/继续/取消/补输入/审批/**自主推进开关**）。新增图标沿用 lucide_icons_flutter 既有字形。

## 文件占用（fileClaims）

同一波派出去的成员是并行跑的，调度器只按执行者去重、不看文件。两个人各改同一个文件时，
读-改-写之间没有任何锁（bash 工具更不经过任何队列），后写的静默覆盖先写的。

| 项 | 约定 |
|---|---|
| 声明 | `assign_member_task` 的 `files`、`task_plan` 每步的 `files`；正文里 `@甲 改 app/lib/a.js` 那一句会自动挑出路径 |
| 规范化 | 反斜杠统一成 `/`，去 `./` 与结尾斜杠，`/*`、`/**` 视作目录本身；Windows/macOS 折叠大小写，Linux 不折叠 |
| 覆盖 | 声明目录即覆盖其下所有文件（`src/auth` 与 `src/auth/login.js` 冲突） |
| 互斥 | 另一份活正占着同一批文件时，这一份排到 5 秒后重试：**不登记尝试、不扣额度**，日志写清被谁占着 |
| 不算冲突 | 祖先与子孙（否则父等子、子等父自锁）；排队/受阻/暂停中的活（它们此刻不会写） |
| 审核 | 文件清单**不进**派工指纹：同一份活重派时补一句文件只是合并，不新建任务；诊断投影里能看到实际占用 |

## 模块

服务端：coordination/task-admission.js（首次准入）、coordination/task-request-gate.js（预约/生命周期）、tasks/task-request-receipts.js（持久回执与恢复）、tasks/task-projection.js（用户投影）、task-routes.js（HTTP 任务路由）。
客户端：task_run_models.dart、task_run_merge.dart、task_run_api.dart、task_run_controller.dart、widgets/task_run_card.dart、widgets/task_run_sheet.dart；app_state.dart/chat_screen.dart 只接线。

## 启用边界

ORBIS_TASK_INTAKE 默认关闭；批次 07 已在真实 server-main 装配一个 TaskRuntime 并执行 recover；关闭态按下方“生产启动与受控启用”处理。

## 当前状态（v1.4.1）

- 引擎代码在位（约 2900 行，其中 `task-supervisor` 1564 行），**默认关闭**（`ORBIS_TASK_INTAKE`）。
- 关闭的原因不是功能不能用，而是**开启前的三道门还没过**：
  1. 核心路径测试（命令重放幂等 / 预算耗尽 / 撤销不丢 / 终态必达）；
  2. 端到端（用户加任务 → 真派出去执行，`task-intake-e2e.mjs` 用假模型替身）；
  3. 任务看板能显示活数据（否则四列全空，用户会以为坏了）。
- 缺口清单见 `docs/taskrun-gaps.md`；跟踪项在 GitHub Issue「TaskRun 引擎：开启前的三条门」。
- 关闭态下用户看到的是：任务板能增删改，但"引擎执行"那一层不产出活数据 ——
  这是**如实的状态**，不是"已完成但没数据"。
