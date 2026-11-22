/**
 * SDK 示例冒烟（路线图 §4 T2.8）：`examples/sdk/*.mjs` 每个都**真跑一遍**。
 *   node tests/sdk-examples.mjs
 *
 * ## 这个文件守什么
 *
 * 示例是最容易腐烂的文档：SDK 改了签名、改了事件名，`docs/` 不会报错，
 * 但复制示例的人会撞墙。所以每个示例都在 CI 里跑，跑不通就红。
 *
 * 约定：
 *   · 每个示例用**全新的临时工作目录**（示例会把状态写到 `./.orbis-demo`）；
 *   · 示例默认走离线桩，所以这里不需要 API key、不联网；
 *   · 有超时（一个示例卡住不能拖死整个 CI）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname;
const serverDir = path.join(here, '..');
const examplesDir = path.join(serverDir, 'examples', 'sdk');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-sdk-examples-'));

/** 示例清单（顺序 = README 里的顺序） */
const EXAMPLES = [
  '01-minimal.mjs',
  '02-custom-model.mjs',
  '03-tools.mjs',
  '04-department.mjs',
  '05-events.mjs',
  '06-lessons.mjs',
  '07-injection.mjs',
];

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.message || err}`);
    fail++;
  }
}

/** 每个示例共用的环境：把 HOME / 数据目录都圈在临时目录里，绝不碰用户真实数据 */
function runExample(file) {
  const cwd = path.join(root, file.replace('.mjs', ''));
  fs.mkdirSync(cwd, { recursive: true });
  const env = {
    ...process.env,
    HOME: path.join(cwd, 'home'),
    ORBIS_HOME: path.join(cwd, 'home-data'),
    ORBIS_WORKSPACE: path.join(cwd, 'workspace'),
    ORBIS_PROBE: '0',
    ORBIS_LESSON_REFLECT: '0',
    // 示例不该联网；真要联网的（02 的 live 模式）由环境变量显式打开
    ORBIS_EXAMPLE_LIVE: '',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const res = spawnSync(process.execPath, [path.join(examplesDir, file)], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { res, cwd };
}

for (const file of EXAMPLES) {
  test(`${file} 能跑通（离线桩，退出码 0）`, () => {
    const { res } = runExample(file);
    assert.equal(res.error, undefined, `${file} 启动失败：${res.error?.message ?? ''}`);
    assert.equal(
      res.status,
      0,
      `${file} 退出码 ${res.status}\n--- stderr ---\n${(res.stderr ?? '').slice(-1500)}\n--- stdout ---\n${(res.stdout ?? '').slice(-1500)}`,
    );
    assert.ok((res.stdout ?? '').trim().length > 0, `${file} 没有任何输出 —— 示例不该静默跑完`);
  });
}

test('示例 01 的产物落在临时目录里（不是仓库）', () => {
  const { cwd } = runExample('01-minimal.mjs');
  assert.ok(fs.existsSync(path.join(cwd, '.orbis-demo')), '示例应该把状态写在 ./orbis-demo 下');
});

test('离线桩的文档还在（它是示例的一部分）', () => {
  assert.ok(fs.existsSync(path.join(examplesDir, 'README.md')), 'examples/sdk/README.md 缺失');
  assert.ok(fs.existsSync(path.join(examplesDir, '_offline.mjs')), 'examples/sdk/_offline.mjs 缺失');
});

console.log(`\nsdk-examples: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
