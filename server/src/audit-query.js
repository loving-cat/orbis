/**
 * 授权审计的**检索**（纯逻辑：不读盘、不改状态、不依赖 store）。
 *
 * 规格 §5.5 要求留痕「授权引用、发起者、实际执行角色、目标摘要、结果」，
 * `grant-gate` 一直在记；但**记了没法查**等于没有 —— 这一层补的就是"查"：
 * 按房间、按 Bot、按动作、按结果、按时间窗过滤，并给出分页与汇总。
 *
 * 三条设计取舍：
 *
 *   1. **过滤在内存里做**：审计是 `state.grantAudit` 里的一个数组（上限
 *      `MAX_AUDIT` 条），一年也到不了十万。为它建索引/上 SQLite 是过度设计，
 *      而且会把"审计"变成第二个需要迁移的数据源。
 *   2. **时间窗闭区间 + 毫秒**：`from` / `to` 都是毫秒时间戳（含端点）。
 *      给字符串（ISO）也认，省得调用方自己转。
 *   3. **非法过滤值不静默忽略**：`from > to`、`limit` 非正数这类直接报错，
 *      而不是"查出来是空的"——空结果会让人以为真的没有审计记录。
 */

/** 一次最多返回多少条（防止调用方一次拉爆界面） */
export const AUDIT_QUERY_MAX_LIMIT = 200;
/** 默认每页条数 */
export const AUDIT_QUERY_DEFAULT_LIMIT = 50;

/** 把毫秒时间戳 / ISO 字符串 / Date 统一成毫秒；不认识就返回 null */
export function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '') return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLimit(limit, fallback = AUDIT_QUERY_DEFAULT_LIMIT) {
  if (limit === undefined || limit === null || limit === '') return fallback;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error(`limit 必须是正数（给的是 ${JSON.stringify(limit)}）`), {
      code: 'AUDIT_QUERY_INVALID',
    });
  }
  return Math.min(Math.floor(n), AUDIT_QUERY_MAX_LIMIT);
}

function normalizeOffset(offset) {
  if (offset === undefined || offset === null || offset === '') return 0;
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`offset 必须是非负数（给的是 ${JSON.stringify(offset)}）`), {
      code: 'AUDIT_QUERY_INVALID',
    });
  }
  return Math.floor(n);
}

/**
 * 一条审计是否符合过滤条件。
 *
 * `roomId` 对**老记录**是缺的（1.7 之前没有这个字段）——那种记录只有在
 * 不按房间过滤时才出现。这是有意的：宁可少给，也不要把别的房间的记录算进来。
 */
export function matchesAudit(entry, filter = {}) {
  if (!entry || typeof entry !== 'object') return false;
  const { roomId, botId, action, result, code, grantId, fromMs = null, toMs = null } = filter;
  if (roomId && entry.roomId !== roomId) return false;
  if (botId && entry.botId !== botId) return false;
  if (action && entry.action !== action) return false;
  if (result && entry.result !== result) return false;
  if (code && entry.code !== code) return false;
  if (grantId && entry.grantId !== grantId) return false;
  const at = toMillis(entry.at);
  if (fromMs !== null && (at === null || at < fromMs)) return false;
  if (toMs !== null && (at === null || at > toMs)) return false;
  return true;
}

/**
 * 过滤 + 排序，返回**全部命中**（不分页）。`queryAudit` 与 `summarizeAudit`
 * 的入参口径靠它统一 —— 汇总要的是"所有命中的",不是当前这一页。
 */
export function filterAudit(list, filter = {}) {
  const { fromMs, toMs } = resolveWindow(filter);
  const effective = {
    roomId: filter.roomId, botId: filter.botId, action: filter.action, result: filter.result,
    code: filter.code, grantId: filter.grantId, fromMs, toMs,
  };
  const order = filter.order === 'asc' ? 'asc' : 'desc';
  const hits = (Array.isArray(list) ? list : []).filter((entry) => matchesAudit(entry, effective));
  // 按时间排；没有 at 的老记录排在最后（而不是被当成 1970 混在最前面）
  hits.sort((a, b) => {
    const at = toMillis(a.at);
    const bt = toMillis(b.at);
    const delta = (at ?? Number.NEGATIVE_INFINITY) - (bt ?? Number.NEGATIVE_INFINITY);
    return order === 'asc' ? delta : -delta;
  });
  return { hits, fromMs, toMs, order };
}

/**
 * 校验时间窗（闭区间），返回毫秒。
 *
 * 为什么要单独一步：`from`/`to` 可能是毫秒、ISO 字符串或 Date，还要保证
 * from ≤ to。散在两个函数里就会有一处先炸、另一处静默。
 */
export function resolveWindow(filter = {}) {
  const fromMs = toMillis(filter.from);
  const toMs = toMillis(filter.to);
  const givenFrom = filter.from !== undefined && filter.from !== null && filter.from !== '';
  const givenTo = filter.to !== undefined && filter.to !== null && filter.to !== '';
  if (givenFrom && fromMs === null) {
    throw Object.assign(new Error(`from 看不懂：${JSON.stringify(filter.from)}`), { code: 'AUDIT_QUERY_INVALID' });
  }
  if (givenTo && toMs === null) {
    throw Object.assign(new Error(`to 看不懂：${JSON.stringify(filter.to)}`), { code: 'AUDIT_QUERY_INVALID' });
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw Object.assign(new Error('from 不能晚于 to（时间窗是闭区间）'), { code: 'AUDIT_QUERY_INVALID' });
  }
  return { fromMs, toMs };
}

/**
 * 查审计。
 *
 * @param {Array<object>} list 原始审计数组（`store.state.grantAudit`）
 * @param {{roomId?:string, botId?:string, action?:string, result?:'allow'|'deny',
 *          code?:string, grantId?:string, from?:number|string|Date, to?:number|string|Date,
 *          limit?:number, offset?:number, order?:'asc'|'desc'}} [filter]
 * @returns {{total:number, items:object[], nextOffset:number|null, filter:object}}
 *   `total` 是**命中总数**（分页前），`nextOffset` 为 null 表示没有下一页。
 */
export function queryAudit(list, filter = {}) {
  const limit = normalizeLimit(filter.limit);
  const offset = normalizeOffset(filter.offset);
  const { hits, fromMs, toMs, order } = filterAudit(list, filter);

  const items = hits.slice(offset, offset + limit);
  const nextOffset = offset + limit < hits.length ? offset + limit : null;
  return {
    total: hits.length,
    items,
    nextOffset,
    filter: {
      roomId: filter.roomId ?? null,
      botId: filter.botId ?? null,
      action: filter.action ?? null,
      result: filter.result ?? null,
      code: filter.code ?? null,
      grantId: filter.grantId ?? null,
      from: fromMs,
      to: toMs,
      order,
      limit,
      offset,
    },
  };
}

/**
 * 汇总：按结果 / 动作数数，给界面一个"最近到底发生了什么"的概览。
 *
 * 为什么单独一个函数而不是让调用方自己 reduce：口径要**统一** ——
 * 比如 `deny` 里哪些码算"没资格"、哪些算"参数不合法"，散在各处就会有两种说法。
 */
export function summarizeAudit(list) {
  const entries = Array.isArray(list) ? list : [];
  const byResult = { allow: 0, deny: 0 };
  const byAction = {};
  const byCode = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const result = entry.result === 'allow' ? 'allow' : 'deny';
    byResult[result] += 1;
    const action = String(entry.action ?? '(unknown)');
    byAction[action] = (byAction[action] ?? 0) + 1;
    if (result === 'deny') {
      const code = String(entry.code ?? '(none)');
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
  }
  const lastAt = entries.reduce((max, entry) => {
    const at = toMillis(entry?.at);
    return at !== null && at > max ? at : max;
  }, 0);
  return { total: entries.length, byResult, byAction, denyByCode: byCode, lastAt };
}
