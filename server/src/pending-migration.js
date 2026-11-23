/**
 * 「待迁移模式」的轻量 HTTP 监听（P0-2）。
 *
 * ⚠️ 这个模块**只**做监听：不读 store、不写任何文件，所以可以直接对临时目录单测。
 *
 * 1.7 升级上来的第一启动会走到这里：旧目录有数据、新目录还没有。
 * 这一支**只**回 `/health` 与一页提示，绝不生成密钥 / 证书 / state.json，
 * 也不起定时任务与任务宿主 —— 那些都要等 `orbis migrate` 之后才该发生。
 */
import httpMod from 'node:http';

import { log } from './util.js';
import { VERSION } from './version.js';

/**
 * 「待迁移模式」：旧目录有数据、新目录还没有（1.7 升级上来的第一启动）。
 *
 * ## 为什么必须单独一支
 *
 * 正常启动会做三件**不可逆**的事：生成 `secret.key`（站点口令的加密密钥）、
 * 签一张自签 TLS 证书（手机固定的是它的指纹）、写一份初始 `state.json`。
 * 1.7 用户的真实密钥 / 证书 / 数据都还在旧目录里 —— 先起一次 2.0 就等于
 * 抢先落了一套新的，于是：站点口令解不开、每台手机都要重新配对、
 * 后面的 `orbis migrate` 还得跟这套新文件打架（见 migrate-home 的隔离逻辑）。
 *
 * 所以这一支**只做一件事**：起一个极小的 HTTP 监听，把「该迁移了」如实告诉
 * 桌面端 / 手机 / curl。不建密钥、不签证书、不写 state.json、不起定时任务 /
 * 任务宿主 / housekeeping、退出时也不保存任何东西。
 *
 * @param {object} cfg
 */
export async function servePendingMigrationMode(cfg, { installSignalHandlers = true } = {}) {
  const legacy = cfg.legacyDataDir;
  const target = cfg.dataDir;
  const command = `orbis migrate --from "${legacy}" --to "${target}"`;

  const health = () => ({
    ok: true,
    serverName: cfg.serverName,
    version: VERSION,
    auth: cfg.trustLocal ? 'local' : 'token',
    tls: null, // 待迁移模式下不签证书：证书要用 1.7 那份
    // ★ 这两个字段是 App 的阻断式引导与 curl 的全部信息源
    needsMigration: true,
    legacyDataDir: legacy,
    targetDataDir: target,
    hint: '旧数据还在旧目录里。先停掉服务端，运行上面的 orbis migrate，再重新启动。',
  });

  const page = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>Orbis · 需要先迁移数据</title>
<style>
  body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:8vh auto;padding:0 20px;color:#1c1c1e}
  code{background:#f2f2f7;padding:2px 6px;border-radius:4px}
  pre{background:#f2f2f7;padding:12px;border-radius:8px;overflow:auto}
  .warn{color:#b25000}
</style>
<h1>先迁移数据，再使用 Orbis</h1>
<p>发现 1.7 的数据，但新目录里还没有。为了不弄坏密钥与证书指纹，本次启动
   <b>没有</b>创建任何新文件，只在这里等你迁移。</p>
<p>旧数据目录：<br><code>${legacy}</code></p>
<p>新数据目录：<br><code>${target}</code></p>
<p>停掉服务端后执行：</p>
<pre>${command}</pre>
<p>迁移只复制、不删除。完成后重新启动 Orbis。</p>
<p class="warn">迁移不会复制 workspace；如果旧目录里有 workspace，它会继续被使用，届时旧目录不能删。</p>
</html>`;

  const server = httpMod.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch { /* 畸形 URL 当首页处理 */ }
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health()));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 8787, cfg.host ?? '127.0.0.1', resolve);
  });
  const port = server.address()?.port ?? cfg.port;

  log('');
  log('[Orbis] ⚠️  发现 1.7 的数据，但新目录里还没有。本次以「待迁移模式」启动：');
  log(`          旧：${legacy}`);
  log(`          新：${target}`);
  log('        没有生成密钥、没有签证书、没有写 state.json。请先停掉服务端，然后运行：');
  log(`          ${command}`);
  log(`        迁移完再启动。详细说明：http://127.0.0.1:${port}/`);
  log('');

  const close = () => new Promise((resolve) => {
    try { server.close(() => resolve(true)); } catch { resolve(false); }
  });
  if (installSignalHandlers) {
    const shutdown = () => { close().finally(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  return { server, port, close };
}
