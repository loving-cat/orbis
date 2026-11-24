#!/usr/bin/env node
/**
 * 只读性能报告（SPEC-PERF-V1 §10）。
 *
 *   node tools/perf-report.mjs                 # 用默认数据目录
 *   node tools/perf-report.mjs --data=DIR      # 指定数据目录
 *   node tools/perf-report.mjs --json          # 输出机器可读 JSON
 *
 * ## 只打聚合，不打正文
 *
 * 这个报告是要**贴出去**的（贴进 issue、贴给同事、贴进提交说明），所以：
 *   · 不输出消息正文、工具参数、文件名、绝对路径；
 *   · 不输出供应商身份（baseUrl / endpoint / 密钥名），模型只用序号；
 *   · 不输出会话文件名（里面带时间戳与 id）。
 *
 * ## 数据来源
 *
 *   1. `<dataDir>/run-stats.json`：运行记录（`endedBy` / TTFT / SDK 重试等待 / 失败分类）；
 *   2. `<dataDir>/sessions/*.jsonl`：每条 assistant 消息带 `durationMs`，
 *      工具调用与工具结果按条计数 —— 用来切「等模型 vs 跑工具」。
 *
 * 两者都缺失时如实说"没有数据"，不造零。
 */
import fs from 'node:fs';
import path from 'node:path';

import { summarize } from '../src/run-stats.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}`) != null;
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

// 只有没给 `--data` 时才去读 config（它会带来 store / 平台目录判断这些副作用；
// 测试与 CI 永远显式传 --data，走不到这条路径）。
let dataDir = value('data');
if (!dataDir) {
  try {
    const { config } = await import('../src/config.js');
    dataDir = config?.dataDir ?? '';
  } catch {
    dataDir = '';
  }
}

const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  : null);

function readRunStats(dir) {
  const file = path.join(dir, 'run-stats.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const records = Array.isArray(raw?.records) ? raw.records : [];
    return { records, days: raw?.days ?? {} };
  } catch {
    return { records: [], days: {} };
  }
}

/**
 * 扫会话文件：只取「一轮多久」与「工具调用/结果有多少、多久」。
 *
 * 会话行形状（pi）：`{ type:'message', message:{ role, durationMs?, usage?, content? } }`。
 * 认不出来的行直接跳过 —— 报告宁可少一行，也不能因为一条怪数据炸掉。
 */
function readSessions(dir) {
  const out = { files: 0, assistantRounds: 0, modelMs: [], toolCalls: 0, toolMs: [], skipped: 0 };
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, 'sessions')).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return out;
  }
  out.files = names.length;
  for (const name of names) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, 'sessions', name), 'utf8');
    } catch {
      out.skipped++;
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        out.skipped++;
        continue;
      }
      const message = row?.message;
      if (row?.type !== 'message' || !message) continue;
      const ms = Number(message.durationMs);
      if (message.role === 'assistant') {
        out.assistantRounds++;
        if (Number.isFinite(ms) && ms > 0) out.modelMs.push(Math.round(ms));
        const parts = Array.isArray(message.content) ? message.content : [];
        out.toolCalls += parts.filter((p) => p?.type === 'toolCall' || p?.type === 'tool_use').length;
      } else if (message.role === 'toolResult' || message.role === 'tool') {
        if (Number.isFinite(ms) && ms > 0) out.toolMs.push(Math.round(ms));
      }
    }
  }
  return out;
}

function buildReport(dir) {
  const { records, days } = readRunStats(dir);
  const sessions = readSessions(dir);
  const summary = summarize(records);

  const modelMs = sessions.modelMs.slice().sort((a, b) => a - b);
  const toolMs = sessions.toolMs.slice().sort((a, b) => a - b);
  const modelTotal = modelMs.reduce((a, b) => a + b, 0);
  const toolTotal = toolMs.reduce((a, b) => a + b, 0);
  const busyTotal = modelTotal + toolTotal;

  const failed = records.filter((r) => r && r.ok === false);
  const failMs = failed.reduce((acc, r) => acc + (Number(r.ms) || 0), 0);
  const failDurations = failed.map((r) => Number(r.ms) || 0).filter((n) => n > 0).sort((a, b) => a - b);

  return {
    dataDirGiven: Boolean(dir),
    runs: {
      total: summary.runs,
      succeeded: summary.succeeded,
      failed: summary.failed,
      p50Ms: summary.p50Ms,
      p90Ms: summary.p90Ms,
      totalMs: summary.totalMs,
      // 失败运行吃掉了多少运行时长（立项值 53%）
      failTimeShare: summary.totalMs > 0 ? Number((failMs / summary.totalMs).toFixed(3)) : null,
      failedP50Ms: pct(failDurations, 0.5),
      failedP90Ms: pct(failDurations, 0.9),
    },
    endedBy: summary.endedBy,
    failKinds: summary.failKinds,
    timing: {
      // 每条记录先取自己最坏一轮，再取中位数/最大值（见 run-stats.summarize）
      ttftMsP50: summary.ttftMsP50,
      ttftMsMax: summary.ttftMsMax,
      sdkRetryWaitMs: summary.sdkRetryWaitMs,
      recordsWithTiming: summary.timingRecords,
    },
    cache: {
      hitRate: summary.cacheHitRate,
      inputTotal: summary.inputTotal,
      unknownRecords: summary.unknownCacheRecords,
    },
    sessions: {
      files: sessions.files,
      assistantRounds: sessions.assistantRounds,
      skippedLines: sessions.skipped,
      modelMs: { p50: pct(modelMs, 0.5), p90: pct(modelMs, 0.9), total: modelTotal },
      toolCalls: sessions.toolCalls,
      toolMs: { p50: pct(toolMs, 0.5), p90: pct(toolMs, 0.9), total: toolTotal },
      // 「时间花在哪」：等模型 vs 跑工具（立项值 75% / 25%）
      modelShare: busyTotal > 0 ? Number((modelTotal / busyTotal).toFixed(3)) : null,
    },
    days: Object.keys(days).length,
  };
}

const report = buildReport(dataDir);

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const r = report;
  const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value ?? '—'}`);
  console.log('\nOrbis 性能报告（只读聚合，不含正文/路径/供应商）\n');
  console.log('运行');
  line('总运行 / 成功 / 失败', `${r.runs.total} / ${r.runs.succeeded} / ${r.runs.failed}`);
  line('时长 p50 / p90', `${r.runs.p50Ms ?? '—'} ms / ${r.runs.p90Ms ?? '—'} ms`);
  line('失败吃掉时长占比', r.runs.failTimeShare == null ? '—' : `${(r.runs.failTimeShare * 100).toFixed(1)}%`);
  line('失败判定 p50 / p90', `${r.runs.failedP50Ms ?? '—'} ms / ${r.runs.failedP90Ms ?? '—'} ms`);
  console.log('\n结束方式（endedBy）');
  const ended = Object.entries(r.endedBy ?? {}).sort((a, b) => b[1] - a[1]);
  if (!ended.length) line('（无）', '—');
  for (const [kind, n] of ended) line(kind, n);
  console.log('\n失败分类（failKinds）');
  const kinds = Object.entries(r.failKinds ?? {}).sort((a, b) => b[1] - a[1]);
  if (!kinds.length) line('（无）', '—');
  for (const [kind, n] of kinds) line(kind, n);
  console.log('\n首字延迟（TTFT，每条运行先取最坏一轮）');
  line('p50 / 最大', `${r.timing.ttftMsP50 ?? '—'} ms / ${r.timing.ttftMsMax ?? '—'} ms`);
  line('SDK 重试等待合计', `${r.timing.sdkRetryWaitMs ?? '—'} ms`);
  line('带埋点的运行数', `${r.timing.recordsWithTiming}/${r.runs.total}`);
  console.log('\n缓存命中');
  line('命中率', r.cache.hitRate == null ? '—' : `${(r.cache.hitRate * 100).toFixed(1)}%`);
  console.log('\n会话（时间花在哪）');
  line('会话文件 / assistant 轮', `${r.sessions.files} / ${r.sessions.assistantRounds}`);
  line('等模型 p50 / p90', `${r.sessions.modelMs.p50 ?? '—'} ms / ${r.sessions.modelMs.p90 ?? '—'} ms`);
  line('工具批次', r.sessions.toolCalls);
  line('跑工具 p50 / p90', `${r.sessions.toolMs.p50 ?? '—'} ms / ${r.sessions.toolMs.p90 ?? '—'} ms`);
  line('等模型占比', r.sessions.modelShare == null ? '—' : `${(r.sessions.modelShare * 100).toFixed(1)}%`);
  console.log('');
  if (!r.runs.total && !r.sessions.files) {
    console.log('（没有读到达数据：用 --data=<数据目录> 指定，或先跑一段时间）\n');
  }
}
