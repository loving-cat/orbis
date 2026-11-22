/**
 * `orbis migrate` 的命令行外壳（只有参数解析与输出，干活在 `migrate-home.js`）。
 *
 * 用法：
 *   orbis migrate                 # 按平台默认目录（<数据根>/旧目录/data → <数据根>/orbis/data）
 *   orbis migrate --dry-run       # 只说会搬什么，一个字节都不写
 *   orbis migrate --json          # 给脚本看
 *   orbis migrate --from A --to B # 显式指定（测试/自定义安装位置）
 *   orbis migrate --force         # 新目录已有数据时：只补齐缺失文件，不覆盖
 *
 * 退出码：0 = 迁移成功或无事可做；1 = 拒绝/失败（原因打在 stderr）。
 * ★ 「已经迁移过」返回 0 —— 幂等是给用户手滑跑两遍留的余地，不该报错。
 */
import { migrateHome } from './migrate-home.js';
import { userDataPaths } from './user-dirs.js';

/** 解析 `--key value` / `--flag`（不引第三方依赖，参数就这几个） */
export function parseArgs(argv = []) {
  const opts = { from: null, to: null, force: false, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (arg === '--from') opts.from = argv[++i] ?? null;
    else if (arg === '--to') opts.to = argv[++i] ?? null;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--from=')) opts.from = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) opts.to = arg.slice('--to='.length);
    else if (arg.trim()) opts.error = `看不懂的参数：${arg}`;
  }
  return opts;
}

export const MIGRATE_HELP = `用法：orbis migrate [选项]

把 1.7 的数据目录复制到 2.0 的新目录（<数据根>/<旧目录名>/data → <数据根>/orbis/data）。
**只复制，不删除**：旧目录原样保留，确认没问题后可以自己删。

选项：
  --from <dir>    旧数据目录（默认按平台推断）
  --to <dir>      新数据目录（默认按平台推断）
  --dry-run, -n   只说会搬什么，不写任何文件
  --force         新目录已有数据时，只补齐缺失文件（永不覆盖已有文件）
  --json          输出机器可读的结果
  -h, --help      这条帮助

迁移完再启动服务端；报告写在 <新目录>/migration-report.json。
`;

/**
 * @param {string[]} argv 不含子命令名（即 `migrate` 之后的部分）
 * @returns {Promise<number>} 退出码
 */
export async function runMigrateCli(argv = []) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(MIGRATE_HELP);
    return 0;
  }
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${MIGRATE_HELP}`);
    return 1;
  }

  const defaults = userDataPaths();
  const from = opts.from ?? defaults.legacy;
  const to = opts.to ?? defaults.target;

  // 日志先攒着：`--json` 时 stdout 必须只有 JSON（否则脚本解析不了）
  const logLines = [];
  const result = migrateHome({
    from,
    to,
    force: opts.force,
    dryRun: opts.dryRun,
    log: (line) => logLines.push(line),
  });

  if (opts.json) {
    if (logLines.length) process.stderr.write(`${logLines.join('\n')}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  for (const line of logLines) process.stdout.write(`${line}\n`);

  if (!result.ok) {
    process.stderr.write(`✗ 迁移未执行：${result.error}\n`);
    if (result.code === 'TARGET_HAS_DATA') {
      process.stderr.write('  已经有新数据了就不该搬旧数据；确实要补齐缺的文件，加 --force（不会覆盖已有文件）。\n');
    }
    if (result.code === 'NO_LEGACY') {
      process.stderr.write('  旧目录不存在或没有数据 —— 全新安装不需要迁移。\n');
    }
    return 1;
  }

  if (result.already) {
    process.stdout.write(`✓ 已经迁移过，什么都没做（报告：${result.reportFile}）\n`);
    return 0;
  }

  if (result.dryRun) {
    process.stdout.write(
      `（dry-run）会复制：${result.copied.join('、') || '（无）'}\n`
      + `（dry-run）新目录已有、会保留：${result.kept.join('、') || '（无）'}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `✓ 迁移完成：${result.from} → ${result.to}\n`
    + `  报告：${result.reportFile}\n`
    + '  旧目录一个字节没动；确认新目录能正常启动后，可以自行删除旧目录。\n',
  );
  return 0;
}
