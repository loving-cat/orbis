#!/usr/bin/env node
/**
 * 打包前的准备（`prepack` 的第一步）。
 *
 *   node scripts/prepare-pack.mjs
 *
 * 做两件事：
 *   1. 把仓库根的 `LICENSE` 与 `docs/SDK.md` 复制到包内（`server/LICENSE` /
 *      `server/docs/SDK.md`）—— npm 只会打**包根目录**下的文件，根目录那些它看不见；
 *      而 MIT 要求随分发带上许可证原文，SDK 文档也算"离线可读"的一部分。
 *      复制而不手抄第二份：事实源只能有一个，抄一份迟早会漂。
 *   2. 清掉上一次打出来的 `.tgz`，免得 `npm pack` 把旧包也打进去（体积上限会莫名变大）。
 *
 * 复制出来的 `server/LICENSE` 与 `.tgz` 都在 `.gitignore` 里，不随仓库走。
 */
import fs from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '..');
const rootLicense = path.join(serverDir, '..', 'LICENSE');
const localLicense = path.join(serverDir, 'LICENSE');

if (!fs.existsSync(rootLicense)) {
  console.error(`✗ 找不到根 LICENSE：${rootLicense}`);
  process.exit(1);
}
fs.copyFileSync(rootLicense, localLicense);

const rootSdkDoc = path.join(serverDir, '..', 'docs', 'SDK.md');
const localDocsDir = path.join(serverDir, 'docs');
if (!fs.existsSync(rootSdkDoc)) {
  console.error(`✗ 找不到 docs/SDK.md：${rootSdkDoc}`);
  process.exit(1);
}
fs.mkdirSync(localDocsDir, { recursive: true });
fs.copyFileSync(rootSdkDoc, path.join(localDocsDir, 'SDK.md'));

let removed = 0;
for (const name of fs.readdirSync(serverDir)) {
  if (!name.endsWith('.tgz')) continue;
  fs.rmSync(path.join(serverDir, name), { force: true });
  removed++;
}

console.log(`✓ LICENSE 与 docs/SDK.md 已就位${removed ? `，清掉 ${removed} 个旧 .tgz` : ''}`);
