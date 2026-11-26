/**
 * 会话「泳道」（lane）键：同一对 `(roomId, botId)` 可以有多个并行会话。
 *
 * ## 三种后缀，各管一件事
 *
 * | 形态 | 含义 |
 * |---|---|
 * | `${room}:${bot}` | 主会话（持久化，带记忆） |
 * | `${room}:${bot}#fb` | 单轮临时切模型（永不落盘，用完即焚） |
 * | `${room}:${bot}#clone_<cloneId>` | 临时分身（永不落盘，用完即焚） |
 * | `${room}:${bot}#clone_<cloneId>#fb` | 分身 + 临时切模型（两者可叠加） |
 *
 * ## 为什么必须集中一份构造/解析
 *
 * 分身是 C3 最容易串台的地方：`sessions` / 报告收集器 / 受管上下文 /
 * `dispatching` / `managedInflight` 五处都按 key 存，任何一处自己拼字符串，
 * 就会出现「分身 A 的报告写进分身 B」「中止一个人误杀另一个人」这类事故，
 * 而它们在界面上只表现为「结果对不上」，极难排查。
 *
 * 另外 `#clone_x#fb` 这种**叠加后缀**必须能正确还原 `botId`：
 * 房间级中止（用户插话 / 终止）会从 key 里取 authorId，
 * 取成 `b_1#clone_tr_x` 就等于对着一只不存在的 bot 发消息。
 */
import { sessionKey } from './runner-utils.js';

/** 分身槽位标识。 */
export const CLONE_INFIX = '#clone_';

/** 单轮临时切模型的后缀（既有约定，`#fb` = fallback）。 */
export const FALLBACK_SUFFIX = '#fb';

/**
 * 构造泳道键。
 *
 * @param {{roomId:string, botId:string, cloneId?:string|null, modelOverride?:boolean|string|null}} p
 * @returns {string}
 */
export function sessionLaneKey({ roomId, botId, cloneId = null, modelOverride = null } = {}) {
  const base = sessionKey(roomId, botId);
  const clone = cloneId ? CLONE_INFIX + String(cloneId) : '';
  return base + clone + (modelOverride ? FALLBACK_SUFFIX : '');
}

/**
 * 解析泳道键（`#clone_...` 与 `#fb` 可叠加，顺序固定：clone 在前）。
 *
 * @param {string} key
 * @returns {{roomId:string, botId:string, cloneId:string|null, fallback:boolean}}
 */
export function parseLaneKey(key) {
  const text = String(key ?? '');
  const fallback = text.endsWith(FALLBACK_SUFFIX);
  const body = fallback ? text.slice(0, -FALLBACK_SUFFIX.length) : text;
  const at = body.lastIndexOf(CLONE_INFIX);
  const head = at >= 0 ? body.slice(0, at) : body;
  const cloneId = at >= 0 ? body.slice(at + CLONE_INFIX.length) || null : null;
  const sep = head.indexOf(':');
  return {
    roomId: sep >= 0 ? head.slice(0, sep) : head,
    botId: sep >= 0 ? head.slice(sep + 1) : '',
    cloneId,
    fallback,
  };
}

/** 这个键是不是分身泳道。 */
export function isCloneLane(key) {
  return parseLaneKey(key).cloneId !== null;
}

/**
 * 从泳道键还原**真实 botId**（剥掉 `#clone_…` / `#fb` 后缀）。
 *
 * @param {string} roomId
 * @param {string} key
 * @returns {string}
 */
export function baseBotIdOfKey(roomId, key) {
  const text = String(key ?? '');
  const prefix = String(roomId ?? '') + ':';
  const rest = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  const at = rest.indexOf('#');
  return at >= 0 ? rest.slice(0, at) : rest;
}

/**
 * 释放一个泳道会话：摘掉、退订、dispose。
 *
 * ★ 三步缺一不可：内存会话不落盘，但订阅与工具回调会一直挂着，
 *   分身又是「同时开好几个」，漏一个就是稳定的内存/监听器泄漏。
 *
 * @param {object} runner
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function releaseLaneSession(runner, key) {
  try {
    const entry = runner?.sessions?.get?.(key) ?? null;
    runner?.sessions?.delete?.(key);
    try { entry?.unsubscribe?.(); } catch {}
    try { await entry?.session?.dispose?.(); } catch {}
  } catch {
    // 已经没了就不管：释放路径不能反过来把执行搞挂
  }
}

/**
 * 一轮执行结束时收拾自己的泳道。
 *
 * 主会话：什么都不用做（持久化会话留在池里，带记忆）。
 * `#fb`：只清临时模型会话（既有行为）。
 * 分身：整条泳道用完即焚。
 */
export function releaseTurnLane(runner, { roomId, botId, cloneId = null, modelOverride = null, entry = null } = {}) {
  if (cloneId) {
    return releaseLaneSession(runner, sessionLaneKey({ roomId, botId, cloneId, modelOverride }));
  }
  if (modelOverride) {
    return releaseLaneSession(runner, sessionLaneKey({ roomId, botId, modelOverride }));
  }
  void entry;
  return Promise.resolve();
}
