/**
 * 「这一轮已经手动发过的附件」去重表（Mac 实机 UX-2）。
 *
 * 背景：bot 用 `send_image` 发了一张图之后，回合收尾的自动附图 / 产物发现
 * 又会把同一个文件带上一次 —— 聊天里出现两份一模一样的图。
 *
 * 做法：`send_image` 成功落盘后把规范化路径记到当前 session entry 上，
 * 收尾扫描（`collectNewImages` / `collectArtifacts`）按这份集合跳过。
 * 集合只活在这一轮：`turn-executor` 的 finally 会清掉。
 *
 * 单独成模块的原因：`pi-runner.js` 是外观层，行数有预算（见 check-style）。
 */

/**
 * @param {object} entry 当前 session entry（可能没有）
 * @param {string} filePath 用户/模型给的原始路径
 * @param {object} meta 落盘后的附件元信息
 * @param {(p:string)=>string} normalize 路径规范化函数（attachments.normalizeAttachmentPath）
 */
export function recordSentAttachment(entry, filePath, meta, normalize) {
  if (!entry) return;
  try {
    if (!(entry.sentFiles instanceof Set)) entry.sentFiles = new Set();
    const key = typeof normalize === 'function' ? normalize(filePath) : String(filePath ?? '');
    if (key) entry.sentFiles.add(key);
    if (!Array.isArray(entry.sentMetas)) entry.sentMetas = [];
    entry.sentMetas.push(meta);
  } catch {
    // 去重失败不该让发图失败 —— 最坏结果是多带一份图
  }
}
