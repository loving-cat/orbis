/**
 * 用户数据目录的**纯计算**（不建目录、不读盘、无模块级副作用）。
 *
 * 为什么单独拆出来：`config.js` 一被 import 就会顺手建目录（`createConfig` 默认
 * `ensureDirs: true`），而 `orbis migrate` 只是想知道"旧目录在哪、新目录在哪"，
 * 不该因此建出半个数据目录来。两边共用同一份平台规则，才不会出现
 * "迁移工具算出来的目录和服务端实际用的不是同一个"。
 */
import os from 'node:os';
import path from 'node:path';

/**
 * 本组件在用户目录下的文件夹名。
 *
 * 2026-11-19 品牌统一：新装用 `orbis`，但**老用户的数据还在旧名字的目录下**。
 */
export const HOME_DIR_NAME = 'orbis';
// @remove-2.0 2.0 起把旧目录回退整段删掉（届时给用户一次"手动重命名目录"的说明）
export const LEGACY_HOME_DIR_NAME = 'pi-bot';

/**
 * 平台约定的"用户数据根"（不含本组件的文件夹名）。
 *
 * @param {{platform?:string, env?:Record<string,string|undefined>, homedir?:string}} [opts]
 */
export function userDataBaseDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    // 没有 LOCALAPPDATA 的极端环境（服务账户/精简镜像）退回家目录，不要抛
    return path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'));
  }
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support');
  }
  return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'));
}

/**
 * 新旧两个**数据目录**（`dataDir` 本身，不是它的父目录）。
 *
 * 布局是 `<平台数据根>/<组件名>/data/`（`state.json`、`rooms/`、`workspace/` 都在里面）。
 * 也就是说改名的是**父目录**那一级，`data` 这一级不变 ——
 * 迁移工具和服务端必须用同一份规则，否则会各搬各的。
 *
 * @returns {{base:string, legacy:string, target:string, legacyHome:string, targetHome:string}}
 */
export function userDataPaths(opts = {}) {
  const base = userDataBaseDir(opts);
  const legacyHome = path.join(base, LEGACY_HOME_DIR_NAME);
  const targetHome = path.join(base, HOME_DIR_NAME);
  return {
    base,
    legacyHome,
    targetHome,
    legacy: path.join(legacyHome, 'data'),
    target: path.join(targetHome, 'data'),
  };
}
