/**
 * 长任务护栏（Step 3 / T6）：不可恢复错误快停。
 *
 * ## 要解决的两笔空转
 *
 * 1. **自主重试空转**：`decideRetry` 已经判 `retry: false`（401 鉴权错、
 *    402 余额不足、用户中止、模型配置缺失……），推进器却仍落进「自主模式善后」，
 *    自动 unblock 再排一轮，最多空转 `AUTONOMY_RETRY_LIMIT = 3` 次；
 * 2. **交回空转**：父任务看到子任务受阻，会「取消并交回负责人重排」，
 *    最多 `MAX_CHILD_HANDBACKS = 2` 次。子任务卡在鉴权/余额这种问题上，
 *    换人、重排、拆小都不会好 —— 3 个子任务 × 3 轮 = 9 次无意义执行。
 *
 * ## 判定原则
 *
 * - 只认**明确无歧义**的信号：`decideRetry` 的 `auth` / `quota` / `aborted`、
 *   模型配置缺失的结构化特征、执行器显式上报的 `impossible` / `nonRetriable`、
 *   审批被拒；
 * - **严禁误杀**：429 / 5xx / 网络瞬断 / `model-idle` / 空回复 /
 *   `context_length_exceeded` / 普通工具报错都必须继续按既有重试走 ——
 *   它们换一轮真有可能好，这里的误判会直接把用户的活判死。
 *
 * 纯函数，不碰存储；接线在 `task-supervisor.js` / `task-controls.js`。
 */
import { decideRetry } from '../retry-policy.js';

/** 不可恢复类别（写进 `taskRun.nonRetriableBlock.kind`）。 */
export const NON_RETRIABLE = Object.freeze({
  auth: 'auth',
  quota: 'quota',
  aborted: 'aborted',
  config: 'config',
  impossible: 'impossible',
  approvalRejected: 'approval_rejected',
});

/**
 * 这些类别**换人/重排/拆小都不会好** → 父任务跳过「交回负责人」。
 *
 * `aborted` 也在这里：用户主动终止的分工，重排只会再撞一次同样的取消。
 */
export const NO_HANDBACK_KINDS = Object.freeze(new Set([
  NON_RETRIABLE.auth,
  NON_RETRIABLE.quota,
  NON_RETRIABLE.aborted,
  NON_RETRIABLE.approvalRejected,
  NON_RETRIABLE.impossible,
]));

/**
 * 模型配置缺失的特征。
 *
 * ★ 刻意收得很窄：只认「模型不存在/没配模型」这种结构化字样。
 *   宽泛的中文正则（比如 /配置/、/失败/）会误杀真实的可重试失败。
 */
const CONFIG_PATTERN = /model[_ \-]?not[_ \-]?found|model (?:is )?not (?:available|configured)|找不到模型|模型不存在|未配置.{0,8}模型|缺少模型配置/i;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 这次失败是不是「不必再试」的。
 *
 * @param {object} p
 * @param {string} [p.error]  给用户看的错误文本（脱敏后的也可以）
 * @param {number|null} [p.status] 上游 HTTP 状态
 * @param {string} [p.stop]   执行器的 stop 原因（`failed` / `yielded` …）
 * @param {boolean} [p.impossible] 执行器明确报告「这条路走不通」
 * @param {boolean} [p.nonRetriable] 执行器明确报告「不要重试」
 * @param {boolean} [p.approvalRejected] 审批被拒
 * @returns {{kind:string, why:string, detail:string}|null} 命中返回结论，否则 null
 */
export function classifyNonRetriableFailure({
  error = '', status = null, stop = '', impossible = false, nonRetriable = false, approvalRejected = false,
} = {}) {
  // 1) 执行器/报告层显式给的结构化标志：最可信，优先于文本猜测
  if (impossible === true || nonRetriable === true) {
    return {
      kind: NON_RETRIABLE.impossible,
      why: '执行器明确报告这条路走不通，再试也不会好',
      detail: String(error ?? '').slice(0, 160),
    };
  }
  if (approvalRejected === true) {
    return {
      kind: NON_RETRIABLE.approvalRejected,
      why: '审批被拒绝，不能换工具绕过；需要你改授权或改需求',
      detail: String(error ?? '').slice(0, 160),
    };
  }

  const text = String(error ?? '');
  // 用户/宿主中止：**只认结构化信号与明确的中文说法**。
  //
  // ★ 这里不能用宽泛的 `aborted` / `cancelled` 正则：上游断流的文案就长这样
  //   （`Stream aborted by upstream`）。把它当成「用户终止」会让一次网络抖动被
  //   T6 护栏永久判死（连一次重试都不给）—— 那正是护栏要避免的误杀。
  const abortedByUser = String(stop ?? '') === 'cancelled'
    || /已(?:按你的要求)?(?:终止|中止)|用户已终止/i.test(text);
  if (abortedByUser) {
    return { kind: NON_RETRIABLE.aborted, why: '这一轮已被终止，不再自动重试', detail: text.slice(0, 160) };
  }
  if (text.trim() && CONFIG_PATTERN.test(text)) {
    return {
      kind: NON_RETRIABLE.config,
      why: '模型配置有问题（模型不存在或没配置），重试也不会好',
      detail: text.slice(0, 160),
    };
  }

  // 2) 复用既有失败分类：只认它判死且类别在清单里的
  if (!text.trim() && !Number.isFinite(Number(status))) return null;
  const decision = decideRetry({ error: text, status: status ?? null, attempt: 1 });
  if (decision.retry === false) {
    const kind = String(decision.kind ?? '');
    if (kind === NON_RETRIABLE.auth || kind === NON_RETRIABLE.quota || kind === NON_RETRIABLE.aborted) {
      return {
        kind,
        why: String(decision.why ?? '这类失败重试也不会好'),
        detail: text.slice(0, 160),
      };
    }
  }
  // 注意：`busy` / `timeout-twice` / `exhausted` 等**故意不在这里判死** ——
  // 它们属于既有重试策略的节奏，不归本护栏管。
  return null;
}

/** 这个任务上是否已经记了「不可恢复」。 */
export function nonRetriableOf(run) {
  const block = run?.nonRetriableBlock;
  if (!block || typeof block !== 'object') return null;
  if (!isNonEmptyString(block.kind)) return null;
  return block;
}

/** 这类不可恢复，交回负责人/换人有没有意义。 */
export function blocksHandBack(kind) {
  return NO_HANDBACK_KINDS.has(String(kind ?? ''));
}

/**
 * 一批受阻子任务里，有没有「交回也没用」的。
 *
 * 规则（保守）：
 *   · 全都带 `nonRetriableBlock` → 跳过交回；
 *   · 只要有一个属于 `NO_HANDBACK_KINDS`（鉴权/余额/中止/审批/显式 impossible）
 *     → 跳过交回：重排一个注定失败的分工只会再撞一次同样的墙。
 *
 * @returns {{skip:boolean, kind:string, why:string, taskRunId:string}|null}
 */
export function handBackBlockedBy(kids = []) {
  const blocked = (kids ?? []).filter((k) => nonRetriableOf(k));
  if (!blocked.length) return null;
  const all = blocked.length === (kids ?? []).filter((k) => k).length;
  const fatal = blocked.find((k) => blocksHandBack(nonRetriableOf(k)?.kind));
  if (!all && !fatal) return null;
  const picked = fatal ?? blocked[0];
  const info = nonRetriableOf(picked);
  return {
    skip: true,
    kind: String(info.kind),
    why: String(info.why ?? '不可恢复的失败'),
    taskRunId: picked.id ?? '',
  };
}
