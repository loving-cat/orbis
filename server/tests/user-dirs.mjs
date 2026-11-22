/**
 * 用户数据目录的纯规则（`server/src/user-dirs.js`）。
 *   node tests/user-dirs.mjs
 *
 * 为什么要单独一个文件：`config.js` 一 import 就建目录，没法在"只想知道路径"的
 * 场景里用它；而 `orbis migrate` 必须和服务端算出**同一个**目录，否则迁移工具
 * 会往一个没人读的地方搬。这里锁的就是那份平台规则。
 */
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, userDataBaseDir, userDataPaths,
} from '../src/user-dirs.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
    fail++;
  }
}

test('组件名：新名字 orbis、旧名字仍可识别（迁移要用）', () => {
  assert.equal(HOME_DIR_NAME, 'orbis');
  assert.equal(LEGACY_HOME_DIR_NAME, 'pi-bot');
});

test('Windows：用 LOCALAPPDATA；缺失时回落到家目录（不抛）', () => {
  const base = userDataBaseDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' }, homedir: 'C:\\Users\\you' });
  assert.equal(base, 'C:\\Users\\you\\AppData\\Local');
  const fallback = userDataBaseDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\you' });
  assert.equal(fallback, path.join('C:\\Users\\you', 'AppData', 'Local'));
});

test('macOS：~/Library/Application Support', () => {
  const base = userDataBaseDir({ platform: 'darwin', env: {}, homedir: '/Users/you' });
  assert.equal(base, path.join('/Users/you', 'Library', 'Application Support'));
});

test('Linux：XDG_DATA_HOME 优先，否则 ~/.local/share', () => {
  assert.equal(userDataBaseDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homedir: '/home/you' }), path.join('/data'));
  assert.equal(
    userDataBaseDir({ platform: 'linux', env: {}, homedir: '/home/you' }),
    path.join('/home/you', '.local', 'share'),
  );
});

test('新旧数据目录：<根>/<名字>/data，两级都要对（迁移搬的是 data 那一层）', () => {
  const p = userDataPaths({ platform: 'linux', env: {}, homedir: '/home/you' });
  const base = path.join('/home/you', '.local', 'share');
  assert.equal(p.base, base);
  assert.equal(p.legacyHome, path.join(base, 'pi-bot'));
  assert.equal(p.targetHome, path.join(base, 'orbis'));
  assert.equal(p.legacy, path.join(base, 'pi-bot', 'data'));
  assert.equal(p.target, path.join(base, 'orbis', 'data'));
});

test('两个路径互不包含（迁移工具会拒绝父子目录，这里先保证默认值不会撞上）', () => {
  for (const opts of [
    { platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, homedir: 'C:\\Users\\you' },
    { platform: 'darwin', env: {}, homedir: '/Users/you' },
    { platform: 'linux', env: {}, homedir: '/home/you' },
  ]) {
    const p = userDataPaths(opts);
    assert.notEqual(p.legacy, p.target);
    assert.equal(p.target.startsWith(p.legacy + path.sep), false);
    assert.equal(p.legacy.startsWith(p.target + path.sep), false);
  }
});

console.log(`\nuser-dirs: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
