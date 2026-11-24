/**
 * 附件解析线程池（SPEC-PERF-V1 §6.2）。
 *
 * ## 为什么需要
 *
 * 立项实测：1.25 MB PDF 在主线程卡 247 ms，6 万行 xlsx 卡 1066 ms。
 * 这期间整个服务端（包括 WS 心跳、`/health`、别的 bot 的流式）都停着。
 *
 * ## 设计（四点，都是踩过的坑）
 *
 *   1. **懒启动**：没有附件就一个线程都不起（空转的 worker 也占内存）。
 *   2. **有界**：默认 1 个 worker（可配 2），任务排队；单任务 60 s 超时。
 *   3. **坏了就换**：超时或崩溃 → `terminate()` 并重建，返回**明确错误**，
 *      主进程不受影响（不能因为一个坏文件把服务端拖死）。
 *   4. **起不来就退回主线程**：worker 创建失败（受限环境 / 打包漏文件）时
 *      退回内联解析并记一次日志 —— 慢，但功能不能没了。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { log } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(HERE, 'extract-worker.js');

/** 单任务超时：再大的表格也不该超过一分钟。 */
export const TASK_TIMEOUT_MS = 60_000;

/** worker 堆上限：6 万行 xlsx 展开成对象时很吃内存。 */
export const WORKER_HEAP_MB = 1024;

/** 默认并发：1 个就够（解析是 CPU 密集，开多了只会互相抢核）。 */
export const DEFAULT_WORKERS = 1;
export const MAX_WORKERS = 2;

let seq = 0;

/** 单条任务的结果形状：`{ok:true, value}` 或 `{ok:false, error}`。 */
function fail(error, code = 'extract_failed') {
  return { ok: false, code, error: String(error ?? '解析失败').slice(0, 400) };
}

export class ExtractPool {
  /**
   * @param {{size?:number, timeoutMs?:number, heapMb?:number, workerFile?:string, createWorker?:Function}} [opts]
   *   `createWorker` 可注入（单测造"起不来"与"超时"两种现场）。
   */
  constructor({
    size = DEFAULT_WORKERS,
    timeoutMs = TASK_TIMEOUT_MS,
    heapMb = WORKER_HEAP_MB,
    workerFile = WORKER_FILE,
    createWorker = null,
  } = {}) {
    this.size = Math.max(1, Math.min(Number(size) || DEFAULT_WORKERS, MAX_WORKERS));
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || TASK_TIMEOUT_MS);
    this.heapMb = Number(heapMb) || WORKER_HEAP_MB;
    this.workerFile = workerFile;
    this.createWorker = createWorker;
    /** @type {Array<{worker:Worker, busy:boolean}>} */
    this.slots = [];
    this.queue = [];
    this.dead = false;
    this.fallbackLogged = false;
    this.stats = { tasks: 0, timeouts: 0, crashes: 0, fallbacks: 0 };
  }

  /** worker 起不来（或已被判定为不可用）时，调用方回退主线程解析。 */
  get unavailable() {
    return this.dead;
  }

  #spawn() {
    if (this.createWorker) return this.createWorker(this.workerFile);
    return new Worker(this.workerFile, {
      resourceLimits: { maxOldGenerationSizeMb: this.heapMb },
      // stdout/stderr 不影响解析结果；吞掉，避免污染服务端日志格式
      stdout: true,
      stderr: true,
    });
  }

  /** 懒启动：池被用到才建 worker。 */
  #ensure() {
    if (this.dead) return false;
    while (this.slots.length < this.size) {
      try {
        const worker = this.#spawn();
        const slot = { worker, busy: false };
        // ★ 空闲的 worker 不许拖住进程退出：`tests/*.mjs` 跑完就该立刻退，
        //   服务端收工也不该为了一个没在干活的解析线程多等。派发时再 ref 回来。
        worker.unref?.();
        worker.on?.('error', (err) => this.#onCrash(slot, err));
        worker.on?.('exit', (code) => {
          if (code !== 0) this.#onCrash(slot, new Error(`worker 退出码 ${code}`));
        });
        this.slots.push(slot);
      } catch (err) {
        this.dead = true;
        log('⚠️  附件解析线程池启动失败，退回主线程解析：', err?.message || err);
        return false;
      }
    }
    return true;
  }

  #onCrash(slot, err) {
    this.stats.crashes += 1;
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    try { slot.worker.terminate?.(); } catch { /* 已退出 */ }
    if (slot.pending) slot.pending(fail(err?.message || err, 'extract_crashed'));
    // 崩溃之后重建：下一个任务会重新 spawn（懒启动）
    if (!this.slots.length) this.#pump();
  }

  #idleSlot() {
    return this.slots.find((s) => !s.busy) ?? null;
  }

  /**
   * 提交一个任务。
   *
   * @param {{op?:'text'|'html', filePath:string, options?:object}} job
   * @returns {Promise<{ok:true, value:any}|{ok:false, code:string, error:string}>}
   */
  run({ op = 'text', filePath, options = {} }) {
    if (!this.#ensure()) return Promise.resolve({ ok: false, code: 'pool_unavailable', error: '线程池不可用' });
    return new Promise((resolve) => {
      this.queue.push({ op, filePath, options, resolve });
      this.#pump();
    });
  }

  #pump() {
    while (this.queue.length) {
      let slot = this.#idleSlot();
      // ★ worker 崩溃/超时之后 `slots` 会空掉，队列里剩下的任务**没人来取** ——
      //   以前这里直接 break，于是队列永久挂起（调用方永远等不到 resolve）。
      //   发现"有活干、槽位不够"就补建一个；补不起来就把队列如实结算掉。
      if (!slot && this.slots.length < this.size) {
        if (!this.#ensure()) {
          this.#flushQueue(fail('线程池不可用', 'pool_unavailable'));
          return;
        }
        slot = this.#idleSlot();
      }
      if (!slot) break;
      const job = this.queue.shift();
      this.#dispatch(slot, job);
    }
  }

  /** 把排队中的任务全部结算掉（池关了 / 补建失败时用，绝不能让它们悬着）。 */
  #flushQueue(result) {
    for (const job of this.queue.splice(0)) job.resolve(result);
  }

  #dispatch(slot, job) {
    const id = `job_${(seq += 1)}`;
    slot.busy = true;
    // 忙的时候必须 ref：否则事件循环里只剩一条"不会被等的"线程，
    // 进程可能在任务跑到一半就退出（表现为结果偶发丢失）。
    slot.worker.ref?.();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      slot.busy = false;
      slot.pending = null;
      slot.worker.unref?.();
      job.resolve(result);
      this.#pump();
    };
    slot.pending = finish;

    const timer = setTimeout(() => {
      this.stats.timeouts += 1;
      // 超时就**终止**它：卡死的 worker 会一直占着 CPU/内存，留着比杀掉更糟
      try { slot.worker.terminate?.(); } catch { /* 已退出 */ }
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      finish(fail(`解析超时（>${Math.round(this.timeoutMs / 1000)} s），已终止该任务`, 'extract_timeout'));
    }, this.timeoutMs);
    // ★ 这个定时器**不能 unref**：任务在飞的时候它往往是唯一压住事件循环的东西
    //   （真 worker 忙时我们 ref 过，但假 worker / 已崩的 worker 不占句柄），
    //   unref 掉会让进程"没事可做"直接退出，超时判定永远不触发。

    const onMessage = (msg) => {
      if (!msg || msg.id !== id) return;
      slot.worker.off?.('message', onMessage);
      this.stats.tasks += 1;
      if (msg.ok) finish({ ok: true, value: msg.value });
      else finish(fail(msg.error, 'extract_failed'));
    };
    slot.worker.on?.('message', onMessage);
    try {
      slot.worker.postMessage({ id, op: job.op, filePath: job.filePath, options: job.options });
    } catch (err) {
      slot.worker.off?.('message', onMessage);
      finish(fail(err?.message || err, 'extract_failed'));
    }
  }

  /** 收工：终止所有 worker，拒绝排队中的任务（不拖住进程退出）。 */
  async dispose() {
    this.dead = true;
    this.#flushQueue(fail('线程池已关闭', 'pool_closed'));
    const workers = this.slots.map((s) => s.worker);
    // 在途任务同样要 settle：否则 terminate() 之后那些 promise 永远悬着，
    // 调用方的 await 卡死（服务端收工时表现为"等不到返回"）。
    for (const slot of this.slots) {
      const pending = slot.pending;
      slot.pending = null;
      slot.busy = false;
      pending?.(fail('线程池已关闭', 'pool_closed'));
    }
    this.slots = [];
    await Promise.allSettled(workers.map((w) => w.terminate?.()));
  }
}

/** 进程级单例（懒建）。 */
let shared = null;

export function getExtractPool() {
  if (!shared) shared = new ExtractPool();
  return shared;
}

/** 单测 / 收工用。 */
export async function disposeExtractPool() {
  if (!shared) return;
  const pool = shared;
  shared = null;
  await pool.dispose();
}
