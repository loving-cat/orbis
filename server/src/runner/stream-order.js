/**
 * 并发群聊的「首字落位」。
 *
 * ## 为什么需要它
 *
 * 群里多个 bot 同时开工时，每个 bot 在**思考/跑工具**阶段就先建了一条空气泡
 * （`status: streaming`，正文空）。这些空气泡按"开始时间"排在数组里，于是：
 *
 *   · A 先开始（空占位在最前），B 后开始；
 *   · B 先想完、先吐字 —— 内容从 B 的位置往下长；
 *   · A 随后吐首字 —— 它只占住自己**很早**的位置，于是插到了 B 头上；
 *   · 结果是上面在长高、下面也在流式，整屏上下抽搐（Mac 实机）。
 *
 * 规则：**谁先开口谁在上面**。首字出现时，如果这条消息后面已经有别的 bot 的
 * 可见正文（且中间没有跨过用户的新消息），就把它挪到那一波的最后一条之后。
 * 这样并发多个 bot 自然追加，刷新页面后顺序也完全一致。
 */

/** 这条消息算不算「可见」（有正文或有附件）。空占位不算。 */
function isVisible(message) {
  if (!message) return false;
  if (String(message.text ?? '').trim()) return true;
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

/**
 * @param {Array<object>} messages 当前房间的消息（按展示顺序）
 * @param {string} msgId 本轮的气泡 id
 * @returns {string|null} 应该挪到哪条消息之后；null = 不用动
 */
export function claimOrderTarget(messages, msgId) {
  if (!Array.isArray(messages) || !msgId) return null;
  const idx = messages.findIndex((m) => m?.id === msgId);
  if (idx < 0) return null;
  let target = null;
  for (const m of messages.slice(idx + 1)) {
    // 不越过用户后来发的新消息：那是新的一轮，越过去读起来会错位
    if (m?.authorType === 'user') break;
    if (m?.authorType !== 'bot') continue;
    if (m.id === msgId) continue;
    if (!isVisible(m)) continue;
    target = m.id;
  }
  return target;
}
