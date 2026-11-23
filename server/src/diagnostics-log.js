/**
 * 模型失败诊断记录（有界、脱敏、可导出）。
 *
 * ## 为什么需要它
 *
 * 用户看到的红字是「模型请求失败，接口详情已隐藏，请检查服务端或模型接口日志」，
 * 而 `server.log` 里同样写着一句「详情已隐藏」—— 于是排障变成死循环：
 * 「去看日志」→「日志里说看日志」。真正能定位问题的东西（HTTP 状态、网络错误码、
 * 上游的 error.type/message）必须**记下来**，并且能在 App 里直接看到。
 *
 * ## 三条约束
 *
 *   1. **绝不存 prompt、聊天正文与密钥**：只存技术摘要（已脱敏、单条 ≤500 字符）；
 *   2. **有界**：内存环形缓冲最近 200 条；落盘 `model-errors.jsonl` 超 512KB 轮转一次；
 *   3. **只读导出**：`GET /api/diagnostics/logs` 读它 + server.log 尾部，App 展示。
 */
import fs from 'node:fs';
import path from 'node:path';

import { config as defaultConfig } from './config.js';
import { redactDiagnostic } from './model-reply.js';

/** 内存里保留多少条。 */
export const MODEL_ERROR_LIMIT = 200;
/** 落盘文件（在数据目录里）。 */
export const MODEL_ERROR_FILE = 'model-errors.jsonl';
/** 文件到这个大小就轮转（旧的留一份 `.1`）。 */
export const MODEL_ERROR_MAX_BYTES = 512 * 1024;

const PHASES = new Set(['turn', 'talk', 'compact', 'test', 'probe']);

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/**
 * 造一个诊断记录器。
 *
 * @param {{dataDir?:string, memory?:boolean}} opts `memory` = 一个字节都不写盘
 */
export function createDiagnosticsLog({ dataDir = '', memory = false } = {}) {
  const file = dataDir ? path.join(dataDir, MODEL_ERROR_FILE) : '';
  /** @type {object[]} */
  const ring = [];

  const appendToDisk = (item) => {
    if (memory || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > MODEL_ERROR_MAX_BYTES) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch { /* 文件还不存在 */ }
      fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    } catch { /* 落盘失败不该影响主流程：内存里还有 */ }
  };

  return {
    get file() {
      return file;
    },
    get writing() {
      return !memory && Boolean(file);
    },
    /** 记一条（自动脱敏 + 截断）。 */
    record(entry = {}) {
      const item = {
        ts: Number(entry.ts) || Date.now(),
        phase: PHASES.has(entry.phase) ? entry.phase : 'turn',
        roomId: text(entry.roomId, 64),
        roomName: text(entry.roomName, 60),
        botId: text(entry.botId, 64),
        botName: text(entry.botName, 40),
        model: text(entry.model, 120),
        status: Number.isFinite(entry.status) ? Number(entry.status) : null,
        code: text(entry.code, 40),
        summary: redactDiagnostic(text(entry.summary, 300)),
        detail: redactDiagnostic(text(entry.detail, 500)),
        ms: Number.isFinite(entry.ms) ? Math.max(0, Math.floor(entry.ms)) : null,
      };
      ring.push(item);
      while (ring.length > MODEL_ERROR_LIMIT) ring.shift();
      appendToDisk(item);
      return item;
    },
    /** 最新在前。 */
    recent(limit = 100) {
      const n = Math.max(1, Math.min(MODEL_ERROR_LIMIT, Number(limit) || 100));
      return ring.slice(-n).reverse();
    },
    clear() {
      ring.length = 0;
    },
  };
}

let shared = null;

/** 进程级共享记录器（挂在默认数据目录上）。 */
export function diagnosticsLog() {
  if (!shared) shared = createDiagnosticsLog({ dataDir: defaultConfig.dataDir });
  return shared;
}

/** 测试用：换掉共享实例（传 null 复位）。 */
export function _setDiagnosticsLogForTest(next) {
  shared = next;
}

/**
 * 记一条失败；任何异常都吞掉 —— 诊断记录绝不该让正常的失败处理再抛一次。
 *
 * @param {object|null} log 记录器（传 null 用共享的）
 * @param {object} payload
 */
export function recordFailure(log, payload) {
  try {
    (log ?? diagnosticsLog()).record(payload);
  } catch {
    /* 忽略 */
  }
}

/**
 * 给 PiRunner 造默认记录器（P2-1）。
 *
 * `store.memory === true` 时**零写盘** —— 测试与嵌入式宿主只 import 不落文件。
 * 宿主显式注入 `opts.diagnostics` 时直接用它的。
 *
 * @param {object} config
 * @param {object} store
 * @param {object} [override]
 */
export function diagnosticsForRunner(config, store, override) {
  if (override) return override;
  return createDiagnosticsLog({
    dataDir: config?.dataDir ?? '',
    memory: store?.memory === true,
  });
}

/** `server.log` 的位置：桌面端把服务端 stdout 重定向到数据目录的上一级。 */
export function serverLogPath(dataDir = defaultConfig.dataDir) {
  if (!dataDir) return '';
  return path.join(path.dirname(path.resolve(dataDir)), 'server.log');
}

/**
 * 读 `server.log` 尾部 N 行（二次脱敏）。
 *
 * 服务端自己只往 stdout 写；文件是桌面启动器重定向出来的。独立运行时没有这个
 * 文件 —— 那就返回空数组 + 路径，让界面说清楚"这里没有文件"。
 *
 * @param {{dataDir?:string, lines?:number, logPath?:string}} [opts]
 * @returns {{logPath:string, lines:string[]}}
 */
export function serverLogTail({ dataDir = defaultConfig.dataDir, lines = 120, logPath = '' } = {}) {
  const file = logPath || serverLogPath(dataDir);
  const n = Math.max(1, Math.min(500, Number(lines) || 120));
  if (!file) return { logPath: '', lines: [] };
  try {
    const stat = fs.statSync(file);
    // 只读尾部 256KB：日志可能很大，整份读进来会把事件循环卡住
    const start = Math.max(0, stat.size - 256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const tail = buf.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
      return { logPath: file, lines: tail.slice(-n).map((line) => redactDiagnostic(line)) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { logPath: file, lines: [] };
  }
}
