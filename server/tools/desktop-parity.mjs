#!/usr/bin/env node
/**
 * 口径对拍：PowerShell 实现 vs 原生助手（SPEC-PERF-V1 §5.5）。
 *
 *   node tools/desktop-parity.mjs
 *
 * 为什么必须有这一步：原生实现最容易出的不是"报错"，而是**静默的口径漂移** ——
 *   · 没声明 DPI 感知 → 125% 缩放下窗口矩形小一圈（2048x1152 而不是 2560x1440）；
 *   · 用 `GetWindowRect` 而不是 DWM 扩展边框 → 右边/下边多出阴影，截图裁偏；
 *   · 坐标拿逻辑像素去点物理像素的靶子 → 整体偏 20%。
 * 这些都不会报错，用户只会看到"点偏了""截歪了"。
 *
 * 做法：同一个进程里分两次跑（`helperState` 是进程内缓存，所以要分进程），
 * 各自 dump 一份 JSON，再在这里逐项比较、给出误差。
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const implArg = (args.find((a) => a.startsWith('--impl=')) || '').split('=')[1] || '';
const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));

/** 子进程：按某个实现 dump 一份观测结果。 */
async function snapshot(impl) {
  process.env.ORBIS_DESKTOP_WIN_IMPL = impl;
  const helper = await import(src('desktop-helper-win.js'));
  helper.resetHelperState();
  const di = await import(src('desktop-input-win.js'));
  const obs = await import(src('desktop-observe.js'));

  const env = di.probeEnvironment();
  const cursor = di.cursorPosition();
  const fg = di.foregroundTitle();
  const windows = obs.listWindows({ limit: 10 });
  return {
    impl,
    mode: helper.helperState().mode,
    env: env.ok ? { screen: env.screen, dpi: env.dpi, session: env.session } : { error: env.code },
    cursor: cursor.ok ? { x: cursor.x, y: cursor.y } : { error: cursor.code },
    foreground: fg.ok ? { title: fg.title } : { error: fg.code },
    windows: windows.ok
      ? windows.windows.map((w) => ({
        title: w.title, app: w.app, class: w.class, pid: w.pid,
        x: w.x, y: w.y, width: w.width, height: w.height,
      }))
      : { error: windows.error },
  };
}

function runChild(impl) {
  const self = path.join(import.meta.dirname, 'desktop-parity.mjs');
  const out = execFileSync(process.execPath, [self, `--impl=${impl}`], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ORBIS_DESKTOP_WIN_IMPL: impl },
    windowsHide: true,
  });
  return JSON.parse(String(out).trim().split('\n').filter(Boolean).pop() || '{}');
}

if (implArg) {
  const snap = await snapshot(implArg);
  console.log(JSON.stringify(snap));
} else {
  if (process.platform !== 'win32') {
    console.log('口径对拍只在 Windows 上有意义');
    process.exit(0);
  }
  const ps = runChild('powershell');
  const native = runChild('native');
  const lines = [];
  const ok = (cond) => (cond ? '✅' : '❌');

  lines.push('\n桌面口径对拍（PowerShell vs 原生助手）\n');
  lines.push(`  PowerShell 实际走：${ps.mode} / 原生实际走：${native.mode}`);

  // 1) 屏幕矩形与 DPI：必须逐项相等（这个差一个像素就说明 DPI 感知出了问题）
  const sameScreen = JSON.stringify(ps.env.screen) === JSON.stringify(native.env.screen);
  lines.push(`  ${ok(sameScreen)} 虚拟屏  PowerShell ${JSON.stringify(ps.env.screen)}`
    + ` / native ${JSON.stringify(native.env.screen)}`);
  lines.push(`  ${ok(ps.env.dpi === native.env.dpi)} DPI      PowerShell ${ps.env.dpi} / native ${native.env.dpi}`);
  lines.push(`  ${ok(ps.env.session === native.env.session)} 会话     `
    + `PowerShell ${ps.env.session} / native ${native.env.session}`);

  // 2) 光标：可能被别的程序挪动，给 24px 容差
  const dcx = Math.abs((ps.cursor.x ?? 0) - (native.cursor.x ?? 0));
  const dcy = Math.abs((ps.cursor.y ?? 0) - (native.cursor.y ?? 0));
  lines.push(`  ${ok(dcx <= 24 && dcy <= 24)} 光标     `
    + `PowerShell (${ps.cursor.x},${ps.cursor.y}) / native (${native.cursor.x},${native.cursor.y}) 差 (${dcx},${dcy})`);

  // 3) 前台标题：同一瞬间可能切换（用户自己点了窗口），只比较前缀
  const sameFg = String(ps.foreground.title ?? '') === String(native.foreground.title ?? '');
  lines.push(`  ${ok(sameFg)} 前台标题  ${JSON.stringify(ps.foreground.title)} / ${JSON.stringify(native.foreground.title)}`);

  // 4) 窗口列表：按 (app,title) 对齐，比矩形
  const keyOf = (w) => `${w.app}|${w.title}|${w.class}`;
  const nativeByKey = new Map((native.windows ?? []).map((w) => [keyOf(w), w]));
  let matched = 0;
  let maxDelta = 0;
  const missing = [];
  for (const w of ps.windows ?? []) {
    const other = nativeByKey.get(keyOf(w));
    if (!other) {
      missing.push(`${w.app} · ${w.title || w.class}`);
      continue;
    }
    matched += 1;
    maxDelta = Math.max(maxDelta,
      Math.abs(w.x - other.x), Math.abs(w.y - other.y),
      Math.abs(w.width - other.width), Math.abs(w.height - other.height));
  }
  const psCount = (ps.windows ?? []).length;
  const nativeCount = (native.windows ?? []).length;
  lines.push(`  ${ok(matched === psCount && psCount === nativeCount)} 窗口     `
    + `PowerShell ${psCount} 个 / native ${nativeCount} 个，按 app+title+class 对齐 ${matched} 个，`
    + `最大矩形误差 ${maxDelta}px`);
  if (missing.length) {
    lines.push(`     只出现在 PowerShell 侧：${missing.slice(0, 5).join('；')}`);
  }

  const allOk = sameScreen && ps.env.dpi === native.env.dpi && ps.env.session === native.env.session
    && dcx <= 24 && dcy <= 24 && sameFg && matched === psCount && psCount === nativeCount && maxDelta <= 2;
  lines.push(`\n  结论：${allOk ? '口径一致 ✅' : '有差异，见上面 ❌'}`);
  lines.push('  说明：光标 24px 容差与移动复核一致；窗口矩形允许 ≤2px（DWM 与 GetWindowRect 的边界差）\n');
  console.log(lines.join('\n'));
  process.exit(allOk ? 0 : 1);
}
