/**
 * 进程入口：只做一件事 —— 判断这次是「跑子命令」「起服务端」还是「pi CLI 被当成了入口」。
 *
 * 服务端真正的启动逻辑在 server-main.js；这里保持入口很小，
 * 免得以后又有人在入口里堆业务。
 *
 * 目前只有两条子命令：
 *   · `migrate`（1.7 数据目录 → 2.0 新目录，只复制不删除）；
 *   · `prune-orphans`（清掉 state 里已无引用的房间/会话文件，默认只预览）。
 * 它们要排在 `isPiInvocation` **之前**判：这些不是 pi 的旗标，
 * 但被当成 pi CLI 透传出去会让用户看到一堆莫名其妙的帮助。
 */
import { installChildEnvScrub } from './child-env.js';

// 进程入口：子进程环境白名单在这里显式装上（SDK 不再 import 即生效，见 child-env.js）
installChildEnvScrub();
import { isPiInvocation, runPiCli } from './pi-args.js';
import { markServerBoot } from './data-migration.js';

const argv = process.argv.slice(2);

if (argv[0] === 'migrate') {
  const { runMigrateCli } = await import('./migrate-cli.js');
  process.exit(await runMigrateCli(argv.slice(1)));
} else if (argv[0] === 'prune-orphans') {
  const { runPruneOrphansCli } = await import('./prune-orphans-cli.js');
  process.exit(await runPruneOrphansCli(argv.slice(1)));
} else if (isPiInvocation(argv)) {
  process.exit(await runPiCli(argv));
} else {
  // 只有真的起服务端时，config.js 才会迁移 / 修复数据目录（见 data-migration.js）
  markServerBoot();
  await import('./server-main.js');
}
