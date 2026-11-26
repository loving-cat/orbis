/**
 * 气泡收尾与「换条」的落库逻辑（从 `turn-executor.js` 抽出的自包含部分）。
 *
 * ## 为什么单独一个文件
 *
 * 这两段是单轮执行里**唯一**直接操作消息气泡的收尾逻辑，彼此自包含、
 * 不依赖执行主干的任何闭包变量。它们把 `turn-executor` 撑到了行预算边缘
 * （C3/C4 之后还要往里加东西），抽出来是为了给后续接线留空间 ——
 * 同时从 `turn-executor.js` 原样 re-export，外部导入 100% 兼容。
 *
 * ## 各自的职责
 *
 * · `settleRunningSteps`：把残留的 `running` 步骤收敛成 `error`；
 * · `applyPendingReseat`：把「换条」请求执行掉（封口旧气泡、按需新建下一个）。
 */
/**
 * 把残留的 `running` 步骤收敛成 `error`（Mac 实机 UX-1）。
 *
 * 模型报错 / 被中止 / 命中步数上限 / 换条封口时，最后一个工具可能**没有**
 * `tool_execution_end`（SDK 抛错、进程被杀、用户中断）。这些步骤会以
 * `status: 'running'` 落库，客户端就一直显示「正在干活…」—— 用户看到一条
 * 永远不动的气泡，重开历史也还是转圈。
 *
 * @param {Array<object>} steps 就地修改（调用方拿到的就是要落库的那个数组）
 * @param {string} reason 写进 `step.error`
 * @returns {Array<object>}
 */
export function settleRunningSteps(steps, reason = '这一步没有返回结果（本轮已结束）') {
  if (!Array.isArray(steps)) return steps;
  const now = Date.now();
  for (const step of steps) {
    if (step?.status !== 'running') continue;
    step.status = 'error';
    step.error = reason;
    step.durationMs = Math.max(0, now - Number(step.startedAt ?? now));
  }
  return steps;
}

/**
 * 执行一次「换条」：封口旧气泡（带上已产生的步骤），按需新建下一个气泡。
 *
 * @param {object} p
 * @returns {object|null} 新气泡（`createNext === false` 时返回 null）
 */
export function applyPendingReseat({
  store, roomId, entry, botMsgId, render, meta = null, bot, bus = null, log: logFn = () => {},
  resetDraft = null,
  /** 这一轮已产生的工具步骤：封口旧气泡时要一起写进去，否则会被清空丢弃（D1 第 3 条） */
  steps = null,
  /** false = 只封口旧气泡，不新建（收尾兜底用，避免复制出第二份内容） */
  createNext = true,
} = {}) {
  const pending = entry?.pendingReseat;
  if (!pending) return null;
  entry.pendingReseat = null;

  const sealed = typeof render === 'function' ? render() : '';
  // 封口旧气泡时，旧的 running 步骤归旧气泡 —— 一起收敛，别让它在历史里转圈
  if (Array.isArray(steps)) settleRunningSteps(steps, '这条气泡已封口，这一步没有返回结果');
  const oldMsg = store.getMessage(roomId, botMsgId);
  try {
    store.updateMessage(roomId, botMsgId, {
      text: sealed,
      status: 'done',
      // ★ 工具步骤属于这一轮：封口时一并写进去，别让随后的 resetDraft 把它们清丢
      ...(Array.isArray(steps) ? { steps: [...steps] } : {}),
      meta: { ...(oldMsg?.meta ?? {}), reseatAfterId: pending.afterId },
    }, { silent: false });
  } catch (err) {
    logFn('封口旧气泡失败：', err?.message || err);
  }

  if (typeof resetDraft === 'function') resetDraft();

  // 收尾兜底：只封口，不新建 —— 否则调用方接着把同一份 finalText 写进新气泡就是复制
  if (!createNext) return null;

  let next;
  try {
    next = store.appendMessage({
      roomId,
      authorType: 'bot',
      authorId: bot?.id ?? null,
      authorName: bot?.name ?? '',
      authorEmoji: bot?.emoji ?? null,
      text: '',
      status: 'streaming',
      meta: { ...(meta ?? {}), continuedFrom: botMsgId },
    });
  } catch (err) {
    logFn('插话后新建气泡失败：', err?.message || err);
    return null;
  }
  store.moveMessageAfter(roomId, next.id, pending.afterId, { touch: true });
  entry.liveMsgId = next.id;
  // ★ 不再手动补发 msg.new：store.appendMessage 内部已经发过一次（D3 第 1 条）。
  //   重复广播会让总线 / SDK 订阅者收到两条同样的新建事件。
  bus?.emit?.('event', { t: 'typing', roomId, botId: bot?.id ?? null, active: true, lane: 'work', msgId: next.id });
  return next;
}
