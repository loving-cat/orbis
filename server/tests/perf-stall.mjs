/**
 * 桌面层的卡顿探针（SPEC-PERF-V1 §10，**手动**跑，不进 tests/all.mjs）。
 *
 *   node tests/perf-stall.mjs                  # 两种实现各跑一遍并对比
 *   node tests/perf-stall.mjs --impl=native
 *   node tests/perf-stall.mjs --impl=powershell
 *
 * 为什么手动：这些数字受机器负载影响（远程控制软件、别的构建在跑），
 * 拿它当 CI 门槛会变成环境彩票。它是**立项/验收用的尺子**，不是回归测试。
 *
 * 量三件事（§5.6 阶段 A 的验收指标）：
 *   1. 单次只读探针 p50（`probeEnvironment`，目标 ≤ 40 ms）
 *   2. `listWindows()` p50（目标 ≤ 60 ms）
 *   3. 上述调用期间**事件循环最大卡顿**（目标 ≤ 50 ms）
 *
 * 实现方式：父进程按 `--impl` 拉起自己，子进程里 `process.env.ORBIS_DESKTOP_WIN_IMPL`
 * 决定走哪条路（helperState 是进程内缓存，所以要分进程量）。
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const implArg = (args.find((a) => a.startsWith('--impl=')) || '').split('=')[1] || '';
const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** 事件循环卡顿探针：5 ms 间隔，记录最大间隔（比 monitorEventLoopDelay 更贴近真实阻塞）。 */
function startStallProbe() {
  const gaps = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    gaps.push(now - last);
    last = now;
  }, 5);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      gaps.sort((a, b) => a - b);
      return {
        maxStallMs: gaps.length ? gaps[gaps.length - 1] : 0,
        p99GapMs: percentile(gaps, 0.99),
        samples: gaps.length,
      };
    },
  };
}

async function runChild(impl) {
  const self = path.join(import.meta.dirname, 'perf-stall.mjs');
  const out = execFileSync(process.execPath, [self, `--impl=${impl}`], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ORBIS_DESKTOP_WIN_IMPL: impl },
    windowsHide: true,
  });
  const lastLine = String(out).trim().split('\n').filter(Boolean).pop() || '{}';
  return JSON.parse(lastLine);
}

async function measure(impl) {
  process.env.ORBIS_DESKTOP_WIN_IMPL = impl;
  const helper = await import(src('desktop-helper-win.js'));
  helper.resetHelperState();
  const di = await import(src('desktop-input-win.js'));
  const obs = await import(src('desktop-observe.js'));

  const mode = helper.helperState().mode;
  const probeTimes = [];
  const winTimes = [];

  // 先预热，再开始量卡顿。
  // ★ 首调里含着模块初始化 / 助手版本+哈希校验 / DWM 首次枚举 —— 那些是**一次性**开销，
  //   算进"稳态卡顿"只会得到一条假红线。首调单独记下来（它决定第一次桌面动作要等多久）。
  const firstT0 = performance.now();
  di.probeEnvironment();
  const firstCallMs = performance.now() - firstT0;
  obs.listWindows({ limit: 5 });

  const stall = startStallProbe();

  // ★ 每次调用之后让出一拍：探针要能在**两次 tick 之间**看到"事件循环被堵了多久"。
  //   全同步一口气跑完的话，定时器一次都不会触发，量出来永远是 0（假的好看数字）。
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    di.probeEnvironment();
    probeTimes.push(performance.now() - t0);
    await yieldTick();
  }
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    obs.listWindows({ limit: 10 });
    winTimes.push(performance.now() - t0);
    await yieldTick();
  }
  const gaps = stall.stop();

  const sortedProbe = probeTimes.slice().sort((a, b) => a - b);
  const sortedWin = winTimes.slice().sort((a, b) => a - b);
  return {
    impl,
    mode,
    firstCallMs: Math.round(firstCallMs),
    probeP50Ms: Math.round(percentile(sortedProbe, 0.5)),
    probeP90Ms: Math.round(percentile(sortedProbe, 0.9)),
    listWindowsP50Ms: Math.round(percentile(sortedWin, 0.5)),
    listWindowsP90Ms: Math.round(percentile(sortedWin, 0.9)),
    maxStallMs: Math.round(gaps.maxStallMs),
    p99GapMs: Math.round(gaps.p99GapMs ?? 0),
  };
}

if (implArg) {
  // 子进程：量完就把结果作为最后一行 JSON 打出来（父进程解析）
  const result = await measure(implArg);
  console.log(JSON.stringify(result));
} else {
  if (process.platform !== 'win32') {
    console.log('这个探针只在 Windows 上有意义（其它平台没有对应实现）');
    process.exit(0);
  }
  const rows = [];
  for (const impl of ['powershell', 'native']) {
    try {
      rows.push(await runChild(impl));
    } catch (err) {
      rows.push({ impl, error: String(err?.message || err).slice(0, 200) });
    }
  }
  const pad = (v, w = 12) => String(v ?? '—').padStart(w);
  console.log('\n桌面层卡顿探针（SPEC-PERF-V1 §5.6 阶段 A）\n');
  console.log(`  ${'实现'.padEnd(12)}${pad('首调')}${pad('探针 p50')}${pad('探针 p90')}${pad('窗口 p50')}${pad('窗口 p90')}${pad('最大卡顿')}`);
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${String(r.impl).padEnd(12)} 失败：${r.error}`);
      continue;
    }
    console.log(
      `  ${String(r.impl).padEnd(12)}${pad(`${r.firstCallMs ?? '—'} ms`)}`
      + `${pad(`${r.probeP50Ms} ms`)}${pad(`${r.probeP90Ms} ms`)}`
      + `${pad(`${r.listWindowsP50Ms} ms`)}${pad(`${r.listWindowsP90Ms} ms`)}${pad(`${r.maxStallMs} ms`)}`,
    );
  }
  const native = rows.find((r) => r.impl === 'native');
  const ps = rows.find((r) => r.impl === 'powershell');
  if (native && ps && !native.error && !ps.error) {
    const speedup = (ps.probeP50Ms / Math.max(1, native.probeP50Ms)).toFixed(1);
    console.log(`\n  探针加速：${speedup}×（目标 p50 ≤ 40 ms，窗口 ≤ 60 ms，卡顿 ≤ 50 ms）`);
    console.log(`  门槛：探针 ${native.probeP50Ms <= 40 ? '✅' : '❌'}`
      + ` · 窗口 ${native.listWindowsP50Ms <= 60 ? '✅' : '❌'}`
      + ` · 卡顿 ${native.maxStallMs <= 50 ? '✅' : '❌'}`);
  }
  console.log('');
}
