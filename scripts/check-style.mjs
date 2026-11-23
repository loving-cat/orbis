#!/usr/bin/env node
/**
 * 编码风格与模块边界自检（CI 用）。
 *
 *   node scripts/check-style.mjs
 *
 * ## 为什么需要它
 *
 * 对应 `docs/spec-convergence-v1.md` §1：
 *   1. 纯逻辑模块必须独立成无副作用叶子文件：头部写清“为什么”，不引 store/config/IO，不偷读系统时钟；
 *   2. 核心纯逻辑模块必须有对应回归测试文件兜底（拒绝形式主义空壳单测）；
 *   3. `pi-runner.js` 外观层体积受控，`runner/*.js` 保持单向 DAG 与体积预算，防止逻辑重新糊成大泥球。
 *   4. `server/tests/*.mjs` 里同步 runner 不许挂 async 用例（假绿守卫，见文件末尾）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_SRC = path.join(ROOT, 'server', 'src');
const SERVER_TESTS = path.join(ROOT, 'server', 'tests');

const PURE_MODULES = [
  'grants.js',
  'capabilities.js',
  'policy-version.js',
  'role-tools.js',
  'action-catalog.js',
  'chief-summary.js',
  'duplex-router.js',
  'group-round.js',
  'overrides.js',
  'desktop-lease.js',
  'desktop-takeover.js',
  'retry-policy.js',
  'circuit-breaker.js',
  'memory-policy.js',
  'model-thinking.js',
  'brand.js',
  'chat-redact.js',
  'update-check.js',
  'opening-reply.js',
  'pass-marker.js',
  'task-title.js',
  'tasks/legacy-task-migration.js',
  // SIM-Lite（2.0）：打分 / 淘汰 / 关系边都是纯函数，蒸馏输出解析同理 ——
  // 加进名单才算真的“零 IO”，否则路线图 §5.8 I1 只是口号。
  'lessons.js',
  'lesson-reflect-prompt.js',
  // 运行数据保留策略：只回答“哪些能删”，不读盘也不删东西
  'storage-retention.js',
  // 审计检索：过滤/排序/分页/汇总是纯算法，记录由 grant-gate 写
  'audit-query.js',
  // 部门模板预览：只算“会开成什么样”，不建 bot 也不碰 store
  'department-preview.js',
  // 用户数据目录规则：只做平台路径计算，不建目录（migrate 命令与 config 共用）
  'user-dirs.js',
];

const TEST_OVERRIDES = new Map([
  ['group-round.js', 'closing-turn.mjs'],
  ['brand.js', 'sdk-runtime.mjs'],
  ['chat-redact.js', 'jarvis-mode.mjs'],
  // 复盘提示词/解析的回归测试在 lesson-reflect.mjs（同一个文件覆盖 build + parse）
  ['lesson-reflect-prompt.js', 'lesson-reflect.mjs'],
]);

const FORBIDDEN_IMPORT =
  /(?:from\s+|import\s*\(\s*|import\s+)['"](?:(?:\.\.?\/)*(?:store|config)\.js|(?:node:)?(?:fs|child_process|http|https|net))['"]/g;

function stripCommentsPreserveStrings(source) {
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal) => (literal ?? ''),
  );
}

const problems = [];

for (const file of PURE_MODULES) {
  const full = path.join(SERVER_SRC, file);
  if (!fs.existsSync(full)) {
    problems.push(`缺少纯逻辑模块：server/src/${file}`);
    continue;
  }

  const raw = fs.readFileSync(full, 'utf8');
  if (!raw.trimStart().startsWith('/**')) {
    problems.push(`server/src/${file} 必须以 /** 文件头注释说明设计原因与边界`);
  }

  const code = stripCommentsPreserveStrings(raw);
  for (const m of code.matchAll(FORBIDDEN_IMPORT)) {
    problems.push(`纯逻辑模块 server/src/${file} 禁止引入 IO/状态依赖（${m[0].trim()}）`);
  }

  for (const m of code.matchAll(/Date\.now\(\)/g)) {
    const before = code.slice(Math.max(0, m.index - 24), m.index);
    if (!/\bnow\s*=\s*$/.test(before)) {
      problems.push(`纯逻辑模块 server/src/${file} 禁止直接调用 Date.now()，须通过 now = Date.now() 注入时钟`);
    }
  }

  const testName = TEST_OVERRIDES.get(file) ?? file.replace(/\.js$/, '.mjs');
  if (!fs.existsSync(path.join(SERVER_TESTS, testName))) {
    problems.push(`纯逻辑模块 server/src/${file} 缺少对应回归测试 server/tests/${testName}`);
  }
}

const runnerFacadePath = path.join(SERVER_SRC, 'pi-runner.js');
if (!fs.existsSync(runnerFacadePath)) {
  problems.push('缺少 server/src/pi-runner.js');
} else {
  const lines = fs.readFileSync(runnerFacadePath, 'utf8').split(/\r?\n/).length;
  if (lines > 850) {
    problems.push(`server/src/pi-runner.js 超出外观层行数预算（${lines} > 850）`);
  }
}

const runnerDir = path.join(SERVER_SRC, 'runner');
let runnerSubCount = 0;
if (!fs.existsSync(runnerDir)) {
  problems.push('缺少 server/src/runner 目录');
} else {
  for (const file of fs.readdirSync(runnerDir).filter((f) => f.endsWith('.js')).sort()) {
    runnerSubCount++;
    const raw = fs.readFileSync(path.join(runnerDir, file), 'utf8');
    if (!raw.trimStart().startsWith('/**')) {
      problems.push(`server/src/runner/${file} 缺少 /** 模块头说明`);
    }
    const lines = raw.split(/\r?\n/).length;
    if (lines > 1350) {
      problems.push(`server/src/runner/${file} 超出行数预算（${lines} > 1350）`);
    }
    const imports = [...stripCommentsPreserveStrings(raw).matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    if (imports.some((spec) => spec.includes('pi-runner'))) {
      problems.push(`server/src/runner/${file} 违反单向依赖 DAG：禁止反向导入 pi-runner.js`);
    }
  }
}

// ---------------------------------------------------------------- 假绿用例
//
// ★ 背景（P1-5）：`function test(name, fn) { try { fn(); … } }` 这种**同步** runner
//   遇到 `test('…', async () => { … })` 时拿到的是 promise，然后把它丢掉了。
//   断言失败变成一个未处理的 rejection，测试照样打印 ✓ —— 审计在 7 个文件里
//   抓到 11 条这种假绿（grant-request 里甚至藏着一个 404 当 403 的旧路由）。
//
// 规则：同步 runner 的文件里**不许**出现 async 用例。异步用例必须用
// 「串行队列 + 真 await」的 runner（body 里有 `await fn(`、`tests = tests.then(`
// 或 `checks.push(` 这类收集），否则一有 async 用例就是假绿。
function fakeGreenCases() {
  const problems = [];
  let files = [];
  try {
    files = fs.readdirSync(SERVER_TESTS).filter((f) => f.endsWith('.mjs'));
  } catch {
    return problems;
  }
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SERVER_TESTS, file), 'utf8');
    const def = /function\s+test\s*\(\s*name\s*,\s*fn\s*\)\s*\{/.exec(raw)
      ?? /const\s+test\s*=\s*(?:async\s*)?\(\s*name\s*,\s*fn\s*\)\s*=>\s*\{/.exec(raw);
    if (!def) continue;
    const open = raw.indexOf('{', def.index);
    let depth = 0;
    let end = raw.length;
    for (let i = open; i < raw.length; i += 1) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const body = raw.slice(open, end);
    const awaited = /await\s+fn\s*\(/.test(body) || /then\s*\(/.test(body);
    const queued = /\.push\s*\(/.test(body); // fn 存进队列，文件末尾统一 await
    // 队列 / Promise 链型（`tests = tests.then(...)`）都在内部串行 await：
    // 调用方写 `test(...)` 就够了，不需要 `await`。
    const chained = /\.then\s*\(/.test(body);
    if (queued || chained) continue;

    const asyncRunner = /async\s+function\s+test\s*\(/.test(raw)
      || /const\s+test\s*=\s*async\b/.test(raw);
    if (awaited || asyncRunner) {
      // ★ 异步 runner：每次 `test(...)` 调用都必须带 `await`。
      //   漏一个就是那条用例"发出去了但没人等"—— 失败只会变成未处理的拒绝。
      for (const m of raw.matchAll(/^[ \t]*(?:await[ \t]+)?test\s*\(/gm)) {
        if (/await\s+test\s*\(/.test(m[0])) continue;
        const line = raw.slice(0, m.index).split('\n').length;
        problems.push(`${file}:${line} 的 test(...) 没有 await（异步 runner 下这条会被漏跑）`);
      }
      continue;
    }

    // 同步 runner：任何 async 用例都是假绿
    for (const m of raw.matchAll(/\btest\s*\(\s*(?:[\r\n]\s*)?['"`]/g)) {
      const head = raw.slice(m.index, m.index + 240).split(/\r?\n/).slice(0, 4).join('\n');
      if (!/async\s*(?:\(|function)/.test(head)) continue;
      const line = raw.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line} 的 async 用例不会被 await（同步 test() 会丢掉 promise → 假绿）`);
    }
  }
  return problems;
}

problems.push(...fakeGreenCases());

if (problems.length) {
  console.log('✗ 编码风格与模块边界检查未通过：');
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
}

console.log(`✓ 编码风格与模块边界全部通过（${PURE_MODULES.length} 个纯逻辑模块 / pi-runner + ${runnerSubCount} 个 runner 子模块）`);
