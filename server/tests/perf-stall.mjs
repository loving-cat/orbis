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

/**
 * 附件解析的卡顿探针（§6.3）：合成 6 万行 xlsx + 1.25 MB PDF，
 * 量「主线程内联解析」与「走线程池」的事件循环最大卡顿。
 *
 * 用同一个文件、同一套 5 ms 探针，两次分别跑：
 *   inline  —— 直接调 parseFileInline()（等价于改动前的行为）
 *   pool    —— 调 extractText()（现在走 worker）
 */
async function measureExtract() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Orbis-perf-extract-'));

  // 6 万行 xlsx（立项实测内联卡 1066 ms）
  const rows = [];
  for (let i = 0; i < 60_000; i += 1) rows.push([i, `名称${i}`, i * 1.5, `${(i % 100) / 10}%`]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '数据');
  const xlsx = path.join(dir, 'big.xlsx');
  XLSX.writeFile(wb, xlsx);
  const xlsxMb = +(fs.statSync(xlsx).size / 1024 / 1024).toFixed(1);

  const { parseFileInline, extractText } = await import(src('extract.js'));
  const { disposeExtractPool } = await import(src('extract-pool.js'));

  // ★ 一次 tick 让探针把"刚刚被堵了多久"记下来：
  //   同步解析期间定时器根本不会触发，测完立刻 stop() 会读到 0（假的好看数字）。
  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  const probe = startStallProbe();
  const t0 = performance.now();
  await parseFileInline(xlsx);
  const inlineMs = performance.now() - t0;
  await yieldTick();
  const inlineStall = probe.stop();

  // 让事件循环喘一口，再量池化那条路
  await new Promise((r) => setTimeout(r, 50));

  // 首次调用要付 worker 启动成本（加载 xlsx / pdf / mammoth / cheerio ≈ 数百 ms），
  // 之后是稳态。两个数都要报，否则"线程池更慢"是个假结论。
  const cold0 = performance.now();
  await extractText(xlsx);
  const coldMs = performance.now() - cold0;

  const probe2 = startStallProbe();
  const t1 = performance.now();
  await extractText(xlsx);
  const poolMs = performance.now() - t1;
  await yieldTick();
  const poolStall = probe2.stop();
  await disposeExtractPool();
  fs.rmSync(dir, { recursive: true, force: true });

  return {
    fileMb: xlsxMb,
    inlineMs: Math.round(inlineMs),
    inlineStallMs: Math.round(inlineStall.maxStallMs),
    coldMs: Math.round(coldMs),
    poolMs: Math.round(poolMs),
    poolStallMs: Math.round(poolStall.maxStallMs),
  };
}

if (implArg === 'extract') {
  const out = await measureExtract();
  console.log(JSON.stringify(out));
} else if (implArg) {
  // 子进程：量完就把结果作为最后一行 JSON 打出来（父进程解析）
  const result = await measure(implArg);
  console.log(JSON.stringify(result));
} else {
  if (process.platform !== 'win32') {
    console.log('这个探针只在 Windows 上有意义（其它平台没有对应实现）');
    process.exit(0);
  }
  const rows = [];
  // 附件解析探针（§6.3）：单独一个子进程，避免把上一阶段的状态带进去
  const extract = await (async () => {
    try {
      return await runChild('extract');
    } catch (err) {
      return { error: String(err?.message || err).slice(0, 200) };
    }
  })();
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

  // ---- 附件解析（§6.3）：内联 vs 线程池
  if (extract && !extract.error) {
    console.log(`
附件解析（合成 ${extract.fileMb} MB / 6 万行 xlsx）
`);
    console.log(`  ${'实现'.padEnd(12)}${pad('解析耗时')}${pad('最大卡顿')}`);
    console.log(`  ${'内联（旧）'.padEnd(12)}${pad(`${extract.inlineMs} ms`)}${pad(`${extract.inlineStallMs} ms`)}`);
    console.log(`  ${'线程池(首次)'.padEnd(12)}${pad(`${extract.coldMs} ms`)}${pad('—')}`);
    console.log(`  ${'线程池(稳态)'.padEnd(12)}${pad(`${extract.poolMs} ms`)}${pad(`${extract.poolStallMs} ms`)}`);
    const overhead = extract.inlineMs > 0
      ? Math.round(((extract.poolMs - extract.inlineMs) / extract.inlineMs) * 100) : 0;
    console.log(`
  稳态总耗时变化：${overhead >= 0 ? '+' : ''}${overhead}%（目标 ≤ +20%）`
      + ` · 卡顿 ${extract.poolStallMs <= 50 ? '✅' : '❌'}（目标 ≤ 50 ms）`);
    console.log('  注：首次调用的额外成本是 worker 启动（加载 xlsx/pdf/mammoth/cheerio），只付一次。');
  } else if (extract?.error) {
    console.log(`
附件解析探针失败：${extract.error}`);
  }
  console.log('');
}
