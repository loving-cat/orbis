/**
 * Orbis 品牌常量与统一环境变量读取助手。
 *
 * 将产品品牌名、默认主控标识、仓库归属与 `ORBIS_*`（1.7 的旧前缀 2.0 起不再读）
 * 的环境变量读取收口到单一真源，方便开源分发与后续演进。
 */

export const BRAND_NAME = 'Orbis';
export const BRAND_SLUG = 'orbis';
export const LEGACY_SLUG = 'pi-bot';

/**
 * 环境变量前缀。
 *
 * ★ 2.0（C1）：只认 `ORBIS_*`。1.7 的 `PI_BOT_*` 双读已删除 —— legacy-guard-ok: 讲 1.7 的历史
 *   桌面端从 1.7.0 起传的就是 `ORBIS_*`（见 `app/lib/server/options.dart`），
 *   所以删掉旧前缀不影响任何配套发布的组合。
 */
export const BRAND_ENV_PREFIX = 'ORBIS';

export const DEFAULT_MAIN_BOT_NAME = 'Orbis';
export const DEFAULT_MAIN_BOT_EMOJI = '◉';
export const DEFAULT_UPDATE_REPO = 'loving-cat/orbis';

/**
 * 弃用提醒的单一通道（1.7.1 过渡版用）。
 *
 * ## 为什么不能直接 console.warn
 *
 * `readBrandEnv` 在请求与执行热路径上被反复调用（每个请求、每轮任务都可能走一遍），
 * 直接打日志会刷爆用户日志与 CI 输出。所以这里有两层：
 *   1. **进程内按 `kind:from` 去重** —— 同一个旧变量/旧头整个进程只提醒一次；
 *   2. **可订阅、可重置** —— 单测能断言“提醒了、且只提醒一次”，不用去抓 stderr。
 *
 * 2.0 删兼容层时，这个文件里与 `legacy` 相关的分支一并删。
 */
const deprecations = new Set();
const listeners = new Set();

/** 订阅弃用事件（返回取消函数）。测试用；诊断工具也可用。 */
export function onBrandDeprecation(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 已记录的弃用项（`kind:from`），按发现顺序。 */
export function brandDeprecations() {
  return [...deprecations];
}

/** 清空“已提醒”与订阅者（测试用；正常进程生命周期内不需要调）。 */
export function resetBrandDeprecations() {
  deprecations.clear();
  listeners.clear();
}

/**
 * 记一条弃用提醒（同一 `kind:from` 整个进程只生效一次）。
 *
 * @param {{ kind: string, from: string, to: string, hint?: string }} info
 * @returns {boolean} 本次是否真的记录了（重复返回 false）
 */
export function noticeBrandDeprecation({ kind, from, to, hint = '' }) {
  const key = `${kind}:${from}`;
  if (deprecations.has(key)) return false;
  deprecations.add(key);
  for (const fn of listeners) {
    try {
      fn({ kind, from, to, hint });
    } catch { /* 订阅者自己的错误不影响调用方 */ }
  }
  console.warn(`[Orbis] 弃用提醒：${from} 将在 2.0 移除，请改用 ${to}${hint ? `（${hint}）` : ''}`);
  return true;
}

/**
 * 读 `ORBIS_<SUFFIX>`（空串视为没设）。
 *
 * 2.0 起**不再**回退旧前缀：两套名字同时在用的时候，"到底哪份生效"会变成
 * 没人能说清的事。旧前缀的删除与桌面端切换是同一次发布（1.7.0 起就只传新名）。
 */
export function readBrandEnv(env = process.env, suffix) {
  const value = env?.[`${BRAND_ENV_PREFIX}_${suffix}`];
  return value === undefined || value === '' ? undefined : value;
}
