/**
 * 附件解析 worker（SPEC-PERF-V1 §6.2）。
 *
 * 只做一件事：收一个任务，跑**内联解析函数**，把结果发回去。
 *
 * 为什么另开一个文件而不是在池里 `new Function` / `eval`：worker 必须是独立入口，
 * 打包（P3-1）与 `resourceLimits` 都依赖它。这里**不复制**任何解析逻辑 ——
 * 直接 import `extract.js` / `render-html.js` 里的 inline 版本，保证
 * 「池里跑」与「主线程跑」逐字节一致。
 */
import { parentPort } from 'node:worker_threads';

import { parseFileInline } from './extract.js';
import { renderFileAsHtmlInline } from './render-html.js';

if (parentPort) {
  parentPort.on('message', async (job) => {
    const { id, op, filePath, options = {} } = job ?? {};
    try {
      let result;
      if (op === 'html') {
        result = { ok: true, value: await renderFileAsHtmlInline(filePath, options) };
      } else {
        result = { ok: true, value: await parseFileInline(filePath, options) };
      }
      parentPort.postMessage({ id, ...result });
    } catch (err) {
      parentPort.postMessage({
        id,
        ok: false,
        error: String(err?.message || err).slice(0, 400),
      });
    }
  });
}
