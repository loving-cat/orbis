/**
 * 生成一条**真正能跑**的迁移命令。
 *
 * ## 为什么不能直接给 `orbis migrate ...`
 *
 * Windows 安装包（Inno Setup）和 macOS `.app` 都**没有**把 `orbis` 放进 `PATH`，
 * 而 `orbis.exe` 是 GUI 入口、不处理 CLI 参数。桌面老用户在迁移门禁页看到
 * `orbis migrate --from ...` 根本敲不了 —— 迁移的最后一公里就卡在这儿。
 *
 * 所以默认给出「内置 node + server/src/index.js」的完整形态：
 *
 *   "C:\…\orbis.exe" "C:\…\resources\server\src\index.js" migrate --from "…" --to "…"
 *
 * CLI / npm 安装的用户仍然可以直接 `orbis migrate`（文档里两种都写）。
 */
import { fileURLToPath } from 'node:url';

/** 本仓的 CLI 入口（`server/src/index.js`，`migrate` 子命令由它分发）。 */
export const MIGRATE_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

const quote = (value) => `"${String(value ?? '').replace(/"/g, '\\"')}"`;

/**
 * @param {{legacy?:string, target?:string, execPath?:string, entryPath?:string}} [opts]
 * @returns {string} 可直接粘贴执行的命令
 */
export function buildMigrateCommand({
  legacy = '',
  target = '',
  execPath = process.execPath,
  entryPath = MIGRATE_ENTRY,
} = {}) {
  const from = String(legacy ?? '').trim();
  const to = String(target ?? '').trim();
  const parts = [];
  if (execPath && entryPath) {
    parts.push(quote(execPath), quote(entryPath));
  } else {
    // 实在定位不到内置 node（例如被裁过的第三方安装）：退回 CLI 形态
    parts.push('orbis');
  }
  parts.push('migrate');
  if (from) parts.push('--from', quote(from));
  if (to) parts.push('--to', quote(to));
  return parts.join(' ');
}
