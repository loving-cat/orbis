/**
 * 「被模型长度上限截断」的抢救（从 `turn-executor.js` 抽出的接线级逻辑）。
 *
 * ## 现场（真机复现，128k 窗口的小上下文模型）
 *
 * 老会话里残留着 5 篇技能全文 + 工具定义 + 摘要，已占 ~117k。轮内连调 3 次工具，
 * 第 4 次请求到 124,339 / 128,000（97.1%），模型返回：
 *
 *     output: 1 · THINK: "Found" · 正文为空 · stopReason: "length"
 *
 * 而工具调用前它顺口吐过一句过渡话 —— 那句话已经在 `committed` 里，于是
 * `render()` 非空，旧代码把这半句话标成 `done` 收尾：不报错、不压缩、不重试。
 * 用户随后追问时，又在 125k 的满会话里原地空回复重试，再撞一次同一个上限。
 *
 * ## 这里做什么
 *
 * 只做「判 + 压 + 续答一次」，判定本身是纯函数（`context-budget.lengthTruncationOf`）：
 *   1. 确认是「长度截断且这条正文为空」（不是取消、不是步数上限）；
 *   2. 若上下文逼近上限 → 强制压缩一次，再让它基于工具结果重新收口；
 *   3. 压完仍然截断 / 压不了 → 返回 `notice: true`，由调用方在正文末尾追加提示。
 *
 * 不抛异常：抢救失败也只是"这轮没有完整结论"，不该把整轮升级成失败。
 */
import { lengthTruncationOf } from '../context-budget.js';

/** 续答用的一句话：明确告诉它不要重新做一遍，只基于已有工具结果收口。 */
export const LENGTH_RESUME_PROMPT = '上下文已整理，请基于前面工具执行的结果直接给出完整结论。';

/**
 * @param {object} p
 * @param {object} p.runner PiRunner（用它的 `compactIfNeeded`）
 * @param {object} p.entry 会话条目
 * @param {object} p.bot
 * @param {string|null} [p.roomId]
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.deadline]
 * @param {Function} [p.facts] 返回 `lengthTruncationOf` 的入参（调用方现取最新值）
 * @param {Function} [p.log]
 * @returns {Promise<{notice:boolean, rescued:boolean, verdict:object}>}
 *   `notice: true` → 调用方必须在正文末尾追加截断提示（否则用户以为结论完整）。
 */
export async function recoverFromLengthTruncation({
  runner, entry, bot, roomId = null, signal = null, deadline = 0,
  facts = null, log = () => {},
} = {}) {
  const read = () => lengthTruncationOf(typeof facts === 'function' ? (facts() ?? {}) : {});
  let verdict = read();
  if (!verdict.truncated) return { notice: false, rescued: false, verdict };
  log(`${bot?.name ?? '模型'} 本轮被长度上限截断（上下文 ${Math.round(verdict.percent ?? 0)}%，正文为空）`);
  if (!verdict.nearLimit) return { notice: true, rescued: false, verdict };

  let rescued = false;
  try {
    await runner.compactIfNeeded(entry, bot, roomId, { signal, deadline, force: true });
    await entry.session.prompt(LENGTH_RESUME_PROMPT);
    rescued = true;
  } catch (err) {
    log(`${bot?.name ?? '模型'} 截断后强制压缩/续答失败：`, err?.message || err);
    rescued = false;
  }
  verdict = read();
  // 续答后又有正文了（且不再是 length）→ 不需要提示；否则必须告诉用户被截断了
  return { notice: verdict.truncated, rescued, verdict };
}
