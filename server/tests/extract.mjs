/**
 * 文件解析自测：只造自包含的样本，不依赖本机任何私人文件。
 *
 * 想顺便测真实 PDF / Word 的话，用环境变量指路径：
 *   ORBIS_TEST_PDF=/path/to/any.pdf ORBIS_TEST_DOCX=/path/to/any.docx node tests/extract.mjs
 *
 *   node tests/extract.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { extractText, parseFileInline } from '../src/extract.js';
import { ExtractPool, disposeExtractPool } from '../src/extract-pool.js';
import { EventEmitter } from 'node:events';

const dir = path.join(process.cwd(), 'data', '_extract_test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// ---- 造样本 ----
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ['股票代码', '名称', '市值(亿)', '涨跌幅'],
    ['002920', '示例A', 1204.5, '+3.2%'],
    ['600519', '示例B', 18230.0, '-0.8%'],
  ]),
  '持仓',
);
XLSX.writeFile(wb, path.join(dir, 'sample.xlsx'));

fs.writeFileSync(path.join(dir, 'sample.md'), '# 标题\n\n- 一\n- 二\n\n```js\nconsole.log(1)\n```\n');
fs.writeFileSync(
  path.join(dir, 'sample.html'),
  '<html><head><style>body{color:red}</style><script>var a=1</script></head>' +
    '<body><h1>报告</h1><p>第一段</p><ul><li>要点A</li><li>要点B</li></ul>' +
    '<table><tr><td>1</td><td>2</td></tr></table></body></html>',
);
fs.writeFileSync(path.join(dir, 'sample.csv'), 'a,b,c\n1,2,3\n4,5,6\n');
fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify({ hello: 'world', n: 1 }));

const cases = [
  [path.join(dir, 'sample.xlsx'), 'Excel'],
  [path.join(dir, 'sample.md'), 'Markdown'],
  [path.join(dir, 'sample.html'), 'HTML'],
  [path.join(dir, 'sample.csv'), 'CSV'],
  [path.join(dir, 'sample.json'), 'JSON'],
];
if (process.env.ORBIS_TEST_PDF) cases.push([process.env.ORBIS_TEST_PDF, 'PDF（外部）']);
if (process.env.ORBIS_TEST_DOCX) cases.push([process.env.ORBIS_TEST_DOCX, 'Word（外部）']);

let ok = 0;
for (const [file, label] of cases) {
  const r = await extractText(file, { maxChars: 300 });
  console.log(`\n===== ${label} =====`);
  if (!r.ok) {
    console.log('  ✗', r.error);
    continue;
  }
  ok++;
  console.log(`  ✓ ${r.ext} ${r.chars} 字${r.truncated ? ' (截断)' : ''}`);
  console.log(
    r.text
      .split('\n')
      .slice(0, 6)
      .map((l) => `  | ${l.slice(0, 110)}`)
      .join('\n'),
  );
}
// ---- 线程池：与内联解析逐字节一致（SPEC-PERF-V1 §6.3） ----
{
  const poolCases = [
    path.join(dir, 'sample.xlsx'),
    path.join(dir, 'sample.html'),
    path.join(dir, 'sample.md'),
    path.join(dir, 'sample.csv'),
  ];
  for (const file of poolCases) {
    const viaApi = await extractText(file);      // 对外入口：大的走池、小的内联
    const inline = await parseFileInline(file);  // 同一个实现，主线程直跑
    const same = JSON.stringify(viaApi) === JSON.stringify(inline);
    ok += same ? 1 : 0;
    cases.push(file);
    console.log(`  ${same ? 'OK' : 'NG'} 对外入口 vs 内联逐字节一致：${path.basename(file)}`);
  }
}

// ---- 线程池：超时 → 终止并返回明确错误（一个坏文件不该拖死服务端） ----
{
  const pool = new ExtractPool({ timeoutMs: 800, createWorker: () => {
    const fake = new EventEmitter();
    fake.postMessage = () => {};                 // 永不回复：模拟卡死
    fake.terminate = async () => { fake.terminated = true; };
    return fake;
  } });
  const out = await pool.run({ op: 'text', filePath: path.join(dir, 'sample.xlsx') });
  const timedOut = out.ok === false && out.code === 'extract_timeout';
  ok += timedOut ? 1 : 0;
  cases.push('timeout');
  console.log(`  ${timedOut ? 'OK' : 'NG'} 超时被终止并返回明确错误（实际 ${out.code ?? 'ok'}）`);
  await pool.dispose();
}

// ---- 线程池：worker 起不来 → 如实报告不可用（调用方回退主线程） ----
{
  const pool = new ExtractPool({ createWorker: () => { throw new Error('worker 起不来'); } });
  const out = await pool.run({ op: 'text', filePath: path.join(dir, 'sample.xlsx') });
  const unavailable = out.ok === false && out.code === 'pool_unavailable';
  ok += unavailable ? 1 : 0;
  cases.push('unavailable');
  console.log(`  ${unavailable ? 'OK' : 'NG'} 起不来时如实报告不可用（实际 ${out.code ?? 'ok'}）`);
  await pool.dispose();
}

// ---- 并发回归：超时任务之后，队列里的下一个必须自动重建 worker 继续跑 ----
//
// 旧实现里 worker 超时被 terminate 之后 `slots` 空掉，`#pump()` 只 break ——
// 队列里剩下的任务永远没人取，调用方 await 到天荒地老（真机上表现为"传了个坏文件，
// 之后所有附件都解析不了"）。
{
  const pool = new ExtractPool({ size: 1, timeoutMs: 700, createWorker: () => {
    const fake = new EventEmitter();
    fake.postMessage = () => {};                 // 这一只永远不回复 → 超时
    fake.terminate = async () => { fake.terminated = true; };
    fake.ref = () => {};
    fake.unref = () => {};
    return fake;
  } });
  const first = pool.run({ op: 'text', filePath: path.join(dir, 'sample.xlsx') });
  // 超时之后换成真的 worker：验证"自动重建"这条路
  setTimeout(() => { pool.createWorker = null; }, 50);
  const second = pool.run({ op: 'text', filePath: path.join(dir, 'sample.xlsx') });

  const [a, b] = await Promise.all([first, second]);
  const timedOut = a.ok === false && a.code === 'extract_timeout';
  const recovered = b.ok === true && typeof b.value?.text === 'string' && b.value.text.length > 0;
  ok += timedOut ? 1 : 0;
  cases.push('timeout');
  console.log(`  ${timedOut ? 'OK' : 'NG'} 并发第一个任务超时（实际 ${a.code ?? 'ok'}）`);
  ok += recovered ? 1 : 0;
  cases.push('recover');
  console.log(`  ${recovered ? 'OK' : 'NG'} 队列里第二个任务自动重建 worker 并跑出结果`
    + `（实际 ${b.ok ? b.value?.text?.length + ' 字' : b.code}）`);
  await pool.dispose();
}

// ---- dispose 时在途任务必须被结算（不能悬着） ----
{
  const pool = new ExtractPool({ timeoutMs: 30_000, createWorker: () => {
    const fake = new EventEmitter();
    fake.postMessage = () => {};
    fake.terminate = async () => {};
    fake.ref = () => {};
    fake.unref = () => {};
    return fake;
  } });
  const pending = pool.run({ op: 'text', filePath: path.join(dir, 'sample.xlsx') });
  await new Promise((r) => setTimeout(r, 30));
  await pool.dispose();
  const out = await pending;
  const closed = out.ok === false && out.code === 'pool_closed';
  ok += closed ? 1 : 0;
  cases.push('dispose');
  console.log(`  ${closed ? 'OK' : 'NG'} dispose 时在途任务被结算为 pool_closed（实际 ${out.code ?? 'ok'}）`);
}

await disposeExtractPool();

console.log(`\n${ok}/${cases.length} 通过`);
process.exit(ok === cases.length ? 0 : 1);
