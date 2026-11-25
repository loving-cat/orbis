/** 运行统计：已报告用量、请求恢复次数及有界日汇总；不存提示词与凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

export const MAX_EVENTS = 2000;
export const MAX_DAYS = 90;
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'inputTotal'];
const count = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const sumKnown = (a, b) => a == null ? b : (b == null ? a : a + b);
const positiveInt = (value, fallback = 1) => Math.max(1, Math.floor(count(value) ?? fallback));
const nonnegativeInt = (value) => Math.floor(count(value) ?? 0);

/** SDK 的 input 不含缓存；原始 prompt_tokens 为总输入，未知字段保持 null。 */
export function normalizeUsage(source = {}) {
  const usage = source ?? {};
  const cacheRead = count(usage.cacheRead ?? usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  const cacheWrite = count(usage.cacheWrite ?? usage.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens);
  const output = count(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens);
  let input = count(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.prompt_cache_miss_tokens);
  let inputTotal = count(usage.inputTotal ?? usage.prompt_tokens);
  const partial = nonnegativeInt(usage.missingUsage) > 0 || nonnegativeInt(usage.unknownUsageRecords) > 0;
  if (!partial && inputTotal == null && input != null && cacheRead != null && cacheWrite != null) {
    inputTotal = input + cacheRead + cacheWrite;
  }
  if (!partial && input == null && inputTotal != null && cacheRead != null && cacheWrite != null) {
    input = Math.max(0, inputTotal - cacheRead - cacheWrite);
  }
  return { input, output, cacheRead, cacheWrite, inputTotal };
}

/** 已知总输入中缓存读取的占比；缺失缓存字段时不将未知显示为零命中。 */
export function cacheHitRate(usage = {}) {
  if (nonnegativeInt(usage?.missingCacheUsage) || nonnegativeInt(usage?.unknownCacheRecords)) return null;
  const normalized = normalizeUsage(usage);
  if (normalized.inputTotal == null || normalized.cacheRead == null || normalized.inputTotal <= 0) return null;
  return Math.min(1, normalized.cacheRead / normalized.inputTotal);
}

/** 累加一次 run 内所有 assistant 响应；模型多步调用不算重试。 */
export class RunUsage {
  constructor() {
    this.calls = 0;
    this.retries = 0;
    this.missingUsage = 0;
    this.missingCacheUsage = 0;
    this.totals = Object.fromEntries(USAGE_FIELDS.map((field) => [field, null]));
  }

  add(usage) {
    const normalized = normalizeUsage(usage);
    this.calls++;
    if (USAGE_FIELDS.some((field) => normalized[field] == null)) this.missingUsage++;
    if (normalized.inputTotal == null || normalized.cacheRead == null) this.missingCacheUsage++;
    for (const field of USAGE_FIELDS) {
      this.totals[field] = sumKnown(this.totals[field], normalized[field]);
    }
  }

  retry() { this.retries++; }

  snapshot() {
    return {
      ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, this.calls ? this.totals[field] : null])),
      calls: this.calls,
      missingUsage: this.calls ? this.missingUsage : 1,
      missingCacheUsage: this.calls ? this.missingCacheUsage : 1,
    };
  }
}

/**
 * 这次运行为什么结束（`run-stats` 的 `endedBy`）。
 *
 * 只记**分类**，不记错误正文 —— 报告要能贴出去，正文里可能有路径与供应商信息。
 */
export const ENDED_BY = Object.freeze({
  ok: 'ok',
  retryExhausted: 'retry-exhausted',
  modelIdle: 'model-idle',
  stall: 'stall',
  abort: 'abort',
  auth: 'auth',
  quota: 'quota',
  slice: 'slice',
});

const ENDED_BY_VALUES = new Set(Object.values(ENDED_BY));

/**
 * 由「成功与否 + 现有 kind」推出 `endedBy`。
 *
 * 放在这里而不是塞进 `turn-executor.js`：那个文件有 1350 行预算，
 * 而这是一条纯映射规则，正好属于统计层的职责。
 *
 * @param {{ok?:boolean, kind?:string}} p
 * @returns {string} `ENDED_BY` 之一
 */
export function endedByOf({
  ok = true,
  kind = '',
  // 执行器**当场就知道**的事实，比 `kind` 可靠得多：
  // 以前这里只认 kind，结果"超时/被终止/鉴权失败/欠费"全坍缩成 retry-exhausted，
  // 报告里看不出失败到底是什么类型。
  timedOut = false,
  aborted = false,
  auth = false,
  quota = false,
} = {}) {
  const k = String(kind ?? '').trim().toLowerCase();
  // 1) 明确「这一轮被收住/让出」：不是失败
  if (k === 'step-cap' || k === 'slice' || k === 'yielded') return ENDED_BY.slice;
  if (k === 'model-idle') return ENDED_BY.modelIdle;
  // 2) 按真实结局排优先级（谁先发生谁更可信）
  if (timedOut || k === 'stall' || k === 'timeout') return ENDED_BY.stall;
  if (aborted || k === 'aborted' || k === 'abort' || k === 'cancelled') return ENDED_BY.abort;
  if (auth || k === 'auth' || k === 'unauthorized') return ENDED_BY.auth;
  if (quota || k === 'quota') return ENDED_BY.quota;
  // 3) 最后才是「成了 / 重试用尽」
  if (ok) return ENDED_BY.ok;
  // 其它失败（error / empty / retrying / 未知）：本轮确实没成，decision 已走完
  return ENDED_BY.retryExhausted;
}

/**
 * 一次 run 的计时与失败分类。
 *
 * ## 计时边界（规格 §4.2 a，别改成 `message_start`）
 *
 * `message_start` 是上游**已经回应**之后才有的，用它当起点会把
 * 「TCP 握手挂死、prefill 一直不出字」排除在统计外 —— 而那正是失败运行
 * 要拖 6 分钟的主要来源。所以起点是**发请求的那一刻**（以及工具回来之后
 * 重新发请求的 `tool_execution_end`），终点是该请求的第一个 `message_update`。
 * 工具执行期 `pauseWait()`：跑工具不算模型没进展。
 */
export class RunTiming {
  constructor() {
    /** 每轮「发请求 → 首字」的样本（毫秒） */
    this.ttftSamples = [];
    /** SDK 内部重试的等待合计 */
    this.sdkRetryWaitMs = 0;
    /** 各类失败的计数：`{ transient: 3, auth: 1 }` */
    this.failKinds = {};
    /** 当前这一轮等模型的起点（null = 没在等） */
    this.waitStartedAt = null;
  }

  /** 开始等模型（发请求 / 工具结束之后重新发请求）。 */
  beginWait(at = Date.now()) {
    if (this.waitStartedAt == null) this.waitStartedAt = at;
  }

  /** 工具在跑：暂停计时（不算模型没进展）。 */
  pauseWait() {
    this.waitStartedAt = null;
  }

  /** 收到首字（`message_update`）或思考增量：记一条 TTFT 样本。 */
  markProgress(at = Date.now()) {
    if (this.waitStartedAt == null) return;
    const ms = Math.max(0, Number(at) - this.waitStartedAt);
    this.waitStartedAt = null;
    if (ms > 0) this.ttftSamples.push(Math.round(ms));
  }

  /** SDK 内部重试的等待（`auto_retry_start` 的延迟字段，缺省安全降级为 0）。 */
  addSdkRetryWait(ms) {
    const n = count(ms);
    if (n != null && n > 0) this.sdkRetryWaitMs += Math.round(n);
  }

  /**
   * SDK 要重试了（`auto_retry_start`）。
   *
   * ★ 两个细节：
   *   1. `auto_retry_start` 在 SDK **Sleep 之前**触发，所以这段等待要记进
   *      `sdkRetryWaitMs`，但不能算成「模型没出字」—— 那是可控的退避，不是挂死。
   *   2. 因此把等模型的锚点**强制**挪到「睡醒之后」（`at + delayMs`）：
   *      `beginWait()` 有 `waitStartedAt == null` 守卫，直接用它会因为已有锚点而无效，
   *      于是 SDK 睡眠时间会被重复算进 TTFT（样本虚高，还会误导 modelIdle 的收紧决策）。
   */
  onSdkRetry(delayMs, at = Date.now()) {
    const delay = Math.max(0, count(delayMs) ?? 0);
    this.addSdkRetryWait(delay);
    this.countFail('sdk-retry');
    this.waitStartedAt = at + delay;
  }

  /** 强制清掉等待锚点（`auto_retry_end` / 工具开始等其他"现在不算等模型"的时机）。 */
  resetWait() {
    this.waitStartedAt = null;
  }

  /** 记一次失败分类（只留类别名，不留正文）。 */
  countFail(kind) {
    const key = String(kind ?? '').trim().slice(0, 24) || 'unknown';
    this.failKinds[key] = (this.failKinds[key] ?? 0) + 1;
  }

  /** 落进 `run-stats` 记录里的字段。 */
  snapshot() {
    const samples = [...this.ttftSamples].sort((a, b) => a - b);
    const pick = (q) => (samples.length
      ? samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]
      : null);
    return {
      ttftMsP50: pick(0.5),
      ttftMsMax: samples.length ? samples[samples.length - 1] : null,
      sdkRetryWaitMs: this.sdkRetryWaitMs,
      failKinds: { ...this.failKinds },
    };
  }
}

/** 每条记录对应一次 run；attemptIndex 标记外层尝试，sdkRetries 只计本次内部恢复。 */
export function makeRecord({
  at = Date.now(), roomId = '', botId = '', model = '', provider = '', ms = 0,
  usage = null, attempts = 1, taskRunId = '', attemptIndex = 1, sdkRetries = null,
  ok = true, kind = '',
  // ---- 长任务埋点（SPEC-PERF-V1 §4.2 a；旧记录没有这些字段也要能读） ----
  endedBy = '', ttftMsP50 = null, ttftMsMax = null, sdkRetryWaitMs = null, failKinds = null,
  // 执行器直接递 RunTiming 时，五个字段在这里一次性取齐
  timing = null,
} = {}) {
  const measured = timing?.snapshot?.() ?? null;
  if (measured) {
    ttftMsP50 = ttftMsP50 ?? measured.ttftMsP50;
    ttftMsMax = ttftMsMax ?? measured.ttftMsMax;
    sdkRetryWaitMs = sdkRetryWaitMs ?? measured.sdkRetryWaitMs;
    failKinds = failKinds ?? measured.failKinds;
  }
  const normalized = normalizeUsage(usage);
  const innerRetries = sdkRetries == null ? positiveInt(attempts) - 1 : nonnegativeInt(sdkRetries);
  const index = positiveInt(attemptIndex);
  const ended = ENDED_BY_VALUES.has(String(endedBy))
    ? String(endedBy)
    : endedByOf({ ok: ok !== false, kind });
  const ttftP50 = count(ttftMsP50);
  const ttftMax = count(ttftMsMax);
  return {
    at, roomId, botId, model, provider,
    ms: Math.round(count(ms) ?? 0),
    ...normalized,
    missingUsage: Math.max(nonnegativeInt(usage?.missingUsage),
      USAGE_FIELDS.some((field) => normalized[field] == null) ? 1 : 0),
    missingCacheUsage: Math.max(nonnegativeInt(usage?.missingCacheUsage),
      normalized.inputTotal == null || normalized.cacheRead == null ? 1 : 0),
    calls: nonnegativeInt(usage?.calls),
    taskRunId: String(taskRunId ?? '').slice(0, 160),
    attemptIndex: index,
    attempts: 1 + innerRetries,
    retries: innerRetries + (index > 1 ? 1 : 0),
    ok: ok !== false,
    kind,
    // 分类字段：只留类别与计数，不含任何正文
    endedBy: ended,
    ttftMsP50: ttftP50 == null ? null : Math.round(ttftP50),
    ttftMsMax: ttftMax == null ? null : Math.round(ttftMax),
    sdkRetryWaitMs: count(sdkRetryWaitMs) == null ? null : Math.round(count(sdkRetryWaitMs)),
    failKinds: failKinds && typeof failKinds === 'object' && !Array.isArray(failKinds)
      ? Object.fromEntries(Object.entries(failKinds)
        .map(([k, v]) => [String(k).slice(0, 24), nonnegativeInt(v)])
        .filter(([k, v]) => k && v > 0)
        .slice(0, 12))
      : {},
  };
}

/** 运行记录汇总；总量是已知部分，完整性和未知记录数单独返回。 */
export function summarize(records = []) {
  const out = {
    runs: 0, succeeded: 0, failed: 0,
    ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, null])),
    totalMs: 0, attempts: 0, retries: 0, retried: 0,
    unknownUsageRecords: 0, unknownCacheRecords: 0,
    // 长任务埋点：只统计**有这些字段**的记录（旧记录不算 0，也不算未知）
    endedBy: {}, sdkRetryWaitMs: null, failKinds: {},
    ttftMsP50: null, ttftMsMax: null, timingRecords: 0,
  };
  const durations = [];
  /** 每轮最坏 TTFT 的样本（用各记录自己的 ttftMsMax 再取中位数，见下方注释） */
  const worstTtft = [];
  for (const record of records) {
    if (!record) continue;
    out.runs++;
    if (record.ok) out.succeeded++; else out.failed++;
    const usage = normalizeUsage(record);
    for (const field of USAGE_FIELDS) out[field] = sumKnown(out[field], usage[field]);
    if (nonnegativeInt(record.missingUsage) || USAGE_FIELDS.some((field) => usage[field] == null)) {
      out.unknownUsageRecords++;
    }
    if (nonnegativeInt(record.missingCacheUsage) || usage.inputTotal == null || usage.cacheRead == null) {
      out.unknownCacheRecords++;
    }
    const attempts = positiveInt(record.attempts);
    const retries = record.retries == null ? attempts - 1 : nonnegativeInt(record.retries);
    out.attempts += attempts;
    out.retries += retries;
    if (retries > 0) out.retried++;
    const ms = count(record.ms) ?? 0;
    out.totalMs += ms;
    if (ms > 0) durations.push(ms);

    // ---- 埋点聚合（旧记录缺字段就跳过，不拉低也不伪造） ----
    const ended = String(record.endedBy ?? '');
    if (ENDED_BY_VALUES.has(ended)) out.endedBy[ended] = (out.endedBy[ended] ?? 0) + 1;
    const wait = count(record.sdkRetryWaitMs);
    const ttftMax = count(record.ttftMsMax);
    if (wait != null || ttftMax != null) out.timingRecords++;
    if (wait != null) out.sdkRetryWaitMs = (out.sdkRetryWaitMs ?? 0) + Math.round(wait);
    if (ttftMax != null && ttftMax > 0) worstTtft.push(ttftMax);
    if (record.failKinds && typeof record.failKinds === 'object' && !Array.isArray(record.failKinds)) {
      for (const [k, v] of Object.entries(record.failKinds)) {
        const n = nonnegativeInt(v);
        if (n > 0) out.failKinds[String(k).slice(0, 24)] = (out.failKinds[String(k).slice(0, 24)] ?? 0) + n;
      }
    }
  }
  out.usageComplete = out.runs > 0 && out.unknownUsageRecords === 0;
  out.cacheHitRate = out.unknownCacheRecords ? null : cacheHitRate(out);
  out.avgMs = out.runs ? Math.round(out.totalMs / out.runs) : 0;
  durations.sort((a, b) => a - b);
  const percentile = (q) => durations.length
    ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : null;
  out.p50Ms = percentile(0.5);
  out.p90Ms = percentile(0.9);
  // TTFT 的分位数口径：**每条记录先取自己的最坏一轮**，再在这些最坏值里取中位数/最大值。
  // 拿全部样本混起来算 p50 会把「绝大多数轮都很快、偶尔有一轮挂死」抹平，
  // 而我们要看的正是那个尾巴（它决定失败判定要等多久）。
  worstTtft.sort((a, b) => a - b);
  out.ttftMsP50 = worstTtft.length
    ? worstTtft[Math.min(worstTtft.length - 1, Math.floor(worstTtft.length * 0.5))] : null;
  out.ttftMsMax = worstTtft.length ? worstTtft[worstTtft.length - 1] : null;
  return out;
}

/** 按 UTC 日期汇总运行记录。 */
export function aggregateByDay(records = []) {
  const days = new Map();
  for (const record of records) {
    if (!Number.isFinite(Number(record?.at))) continue;
    const date = new Date(Number(record.at));
    if (Number.isNaN(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(record);
  }
  return Object.fromEntries([...days].map(([day, list]) => [day, summarize(list)]));
}

/** 聚合总量可相加；没有原始样本时不伪造合并后的分位数。 */
function mergeStats(a, b) {
  const merged = {};
  for (const field of ['runs', 'succeeded', 'failed', 'totalMs', 'attempts', 'retries', 'retried',
    'unknownUsageRecords', 'unknownCacheRecords']) {
    merged[field] = (count(a[field]) ?? 0) + (count(b[field]) ?? 0);
  }
  for (const field of USAGE_FIELDS) merged[field] = sumKnown(count(a[field]), count(b[field]));
  if (a.unknownUsageRecords == null) merged.unknownUsageRecords += count(a.runs) ?? 0;
  if (a.unknownCacheRecords == null) merged.unknownCacheRecords += count(a.runs) ?? 0;
  merged.usageComplete = merged.runs > 0 && merged.unknownUsageRecords === 0;
  merged.cacheHitRate = merged.unknownCacheRecords ? null : cacheHitRate(merged);
  merged.avgMs = merged.runs ? Math.round(merged.totalMs / merged.runs) : 0;
  merged.p50Ms = null;
  merged.p90Ms = null;
  // 埋点字段：计数类可相加；TTFT 分位数不可合并（没有原始样本就不伪造），只留最大值
  merged.endedBy = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src?.endedBy ?? {})) {
      merged.endedBy[k] = (merged.endedBy[k] ?? 0) + (count(v) ?? 0);
    }
  }
  merged.failKinds = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src?.failKinds ?? {})) {
      merged.failKinds[k] = (merged.failKinds[k] ?? 0) + (count(v) ?? 0);
    }
  }
  merged.sdkRetryWaitMs = (count(a.sdkRetryWaitMs) == null && count(b.sdkRetryWaitMs) == null)
    ? null : (count(a.sdkRetryWaitMs) ?? 0) + (count(b.sdkRetryWaitMs) ?? 0);
  merged.timingRecords = (count(a.timingRecords) ?? 0) + (count(b.timingRecords) ?? 0);
  merged.ttftMsP50 = null;
  const maxima = [count(a.ttftMsMax), count(b.ttftMsMax)].filter((v) => v != null);
  merged.ttftMsMax = maxima.length ? Math.max(...maxima) : null;
  return merged;
}

export class RunStats {
  constructor({ file = '', maxEvents = MAX_EVENTS, maxDays = MAX_DAYS } = {}) {
    this.file = file;
    this.maxEvents = positiveInt(maxEvents, MAX_EVENTS);
    this.maxDays = positiveInt(maxDays, MAX_DAYS);
    this.records = [];
    this.days = {};
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) this.days = raw.days;
      if (Array.isArray(raw?.records)) {
        this.records = raw.records.filter((record) => record && typeof record === 'object').map((record) =>
          record.missingUsage == null
            ? { ...record, missingUsage: 1, missingCacheUsage: 1 } : record);
      }
      for (const [day, stat] of Object.entries(this.days)) {
        if (!stat || typeof stat !== 'object') { delete this.days[day]; continue; }
        if (stat.unknownUsageRecords == null) {
          this.days[day] = { ...stat, unknownUsageRecords: count(stat.runs) ?? 0,
            unknownCacheRecords: count(stat.runs) ?? 0, usageComplete: false, cacheHitRate: null };
        }
      }
      this.#trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') log('读取运行统计失败：', error?.message || error);
    }
  }

  record(entry) {
    const row = makeRecord(entry);
    this.records.push(row);
    this.#trim();
    this.#scheduleSave();
    return row;
  }

  #trim() {
    const overflow = this.records.length - this.maxEvents;
    if (overflow > 0) {
      for (const [day, stat] of Object.entries(aggregateByDay(this.records.splice(0, overflow)))) {
        this.days[day] = this.days[day] ? mergeStats(this.days[day], stat) : stat;
      }
    }
    const keys = Object.keys(this.days).sort();
    while (keys.length > this.maxDays) delete this.days[keys.shift()];
  }

  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ records: this.records, days: this.days }));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      log('写入运行统计失败：', error?.message || error);
    }
  }

  recent(limit = 100) {
    return summarize(this.records.slice(-Math.min(this.maxEvents, positiveInt(limit, 100))));
  }

  day(day) {
    const records = this.records.filter((record) => {
      const date = new Date(record.at);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
    });
    const archived = this.days[day];
    if (archived && records.length) return mergeStats(archived, summarize(records));
    return records.length ? summarize(records) : archived ?? null;
  }
}
