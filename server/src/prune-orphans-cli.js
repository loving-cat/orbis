/**
 * `orbis prune-orphans` 的命令行外壳（只有参数解析与输出，干活在 prune-orphans.js）。
 *
 * 用法：
 *   orbis prune-orphans                 # 只列出会清掉什么，一个字节都不动（默认）
 *   orbis prune-orphans --apply         # 真的挪到 orphans-backup-<时间戳>/
 *   orbis prune-orphans --older-than 7d # 只清 7 天前的（保护刚产生的残骸）
 *   orbis prune-orphans --json          # 给脚本看
 *
 * 退出码：0 = 成功（含「没有孤儿」）；1 = 参数错误或执行失败。
 *
 * ★ 默认 dry-run 是故意的：这个命令删的是用户真实聊天记录。
 *   让用户先看一眼清单，比让他事后去备份目录里找回来便宜得多。
 */
import fs from 'node:fs';
import path from 'node:path';

import { pruneOrphans } from './prune-orphans.js';
import { userDataPaths } from './user-dirs.js';

export const PRUNE_HELP = `用法：orbis prune-orphans [选项]

清掉「已经不在 state.json 里的」房间文件与会话文件（孤儿）。
默认**只列出来**，加 --apply 才会真的挪走。

选项：
  --data <dir>        数据目录（默认 <数据根>/orbis/data）
  --apply             真的执行（不删，挪到 <数据目录>/orphans-backup-<时间戳>/）
  --older-than <dur>  只清这个时间之前没动过的（例：7d / 36h / 30m）
  --json              输出机器可读的结果
  -h, --help          这条帮助

判据：只有 state.json 里没有引用的文件才算孤儿。有引用的一律不碰。
`;

/** `7d` / `36h` / `30m` / 纯数字（当小时） → 毫秒 */
export function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] ?? 'h';
  const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return Math.round(n * mult);
}

export function parsePruneArgs(argv = []) {
  const opts = { data: null, apply: false, json: false, help: false, olderThanMs: 0, olderThanRaw: null, error: null };
  const takeValue = (name, raw) => {
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value || value.startsWith('-')) {
      opts.error = `${name} 后面要跟一个值`;
      return null;
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--data') opts.data = takeValue('--data', argv[++i]);
    else if (arg.startsWith('--data=')) opts.data = takeValue('--data', arg.slice('--data='.length));
    else if (arg === '--older-than') {
      const raw = takeValue('--older-than', argv[++i]);
      if (raw) {
        const ms = parseDuration(raw);
        if (ms == null) opts.error = `--older-than 看不懂「${raw}」：用 7d / 36h / 30m 这种写法`;
        else { opts.olderThanMs = ms; opts.olderThanRaw = raw; }
      }
    } else if (arg.startsWith('--older-than=')) {
      const raw = takeValue('--older-than', arg.slice('--older-than='.length));
      if (raw) {
        const ms = parseDuration(raw);
        if (ms == null) opts.error = `--older-than 看不懂「${raw}」：用 7d / 36h / 30m 这种写法`;
        else { opts.olderThanMs = ms; opts.olderThanRaw = raw; }
      }
    } else if (arg.trim()) opts.error = `看不懂的参数：${arg}`;
  }
  return opts;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * @param {string[]} argv 不含子命令名（即 `prune-orphans` 之后的部分）
 * @returns {Promise<number>} 退出码
 */
export async function runPruneOrphansCli(argv = []) {
  const opts = parsePruneArgs(argv);
  if (opts.help) {
    process.stdout.write(PRUNE_HELP);
    return 0;
  }
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${PRUNE_HELP}`);
    return 1;
  }

  const dataDir = opts.data ?? userDataPaths().target;
  if (!fs.existsSync(path.join(dataDir, 'state.json'))) {
    process.stderr.write(`✗ ${dataDir} 下没有 state.json —— 这不是一个数据目录。\n`);
    return 1;
  }

  let result;
  try {
    result = pruneOrphans({
      dataDir,
      apply: opts.apply,
      olderThanMs: opts.olderThanMs,
    });
  } catch (err) {
    // 判定不了就明说，退出码 1；此时**一个字节都没写**，也没建备份目录
    process.stderr.write(`✗ ${err?.message || err}${String.fromCharCode(10)}`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const scope = opts.olderThanRaw ? `（只看 ${opts.olderThanRaw} 之前没动过的）` : '';
  process.stdout.write(`数据目录：${dataDir}${scope}\n`);
  process.stdout.write(
    `  活着的：${result.referenced.rooms} 个房间 / ${result.referenced.sessions} 个会话\n`,
  );
  process.stdout.write(
    `  孤儿房间：${result.rooms.files.length} 个，${human(result.rooms.bytes)}\n`
    + `  孤儿会话：${result.sessions.files.length} 个，${human(result.sessions.bytes)}\n`,
  );
  for (const f of result.rooms.files.slice(0, 20)) {
    process.stdout.write(`    · rooms/${path.basename(f.file)}  ${human(f.size)}\n`);
  }
  if (result.rooms.files.length > 20) {
    process.stdout.write(`    · …还有 ${result.rooms.files.length - 20} 个房间文件\n`);
  }
  for (const f of result.sessions.files.slice(0, 10)) {
    process.stdout.write(`    · sessions/${path.basename(f.file)}  ${human(f.size)}\n`);
  }
  if (result.sessions.files.length > 10) {
    process.stdout.write(`    · …还有 ${result.sessions.files.length - 10} 个会话文件\n`);
  }

  if (!result.rooms.files.length && !result.sessions.files.length) {
    process.stdout.write('\n✓ 没有可清的东西。\n');
    return 0;
  }

  if (!result.applied) {
    process.stdout.write(
      '\n这是**预览**，什么都没动。确认要清就加 --apply：\n'
      + '  不会真的删除，会挪到 <数据目录>/orphans-backup-<时间戳>/ 里，随时能挪回来。\n',
    );
    return 0;
  }

  if (result.moved === 0) {
    process.stdout.write('\n✓ 没有可清的东西。\n');
    return 0;
  }
  process.stdout.write(
    `\n✓ 已挪走 ${result.moved} 个文件 → ${result.backupDir}\n`
    + '  确认没问题后，这个备份目录可以自行删掉（不删也不会被程序读）。\n',
  );
  return 0;
}
