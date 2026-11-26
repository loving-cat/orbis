/**
 * 独立评审（Critic）的执行器：开一个**只读、纯内存、干净上下文**的会话跑一轮评审。
 *
 * ## 三条硬约束（都在这里落实，不散到别处）
 *
 * 1. **上下文干净**：走 `session-factory` 的 `criticLane`（`SessionManager.inMemory`），
 *    绝不复用执行者的会话文件与对话历史 —— 否则评审员会读到执行者的自我解释，
 *    独立性当场归零。
 * 2. **只读**：`criticLane` 只给 read/ls/find/grep，策略层 `dangerous: 'deny'` 兜底。
 *    评审员不许写文件、不许跑命令 —— "评审顺手把活改了"是最难查的一类污染。
 * 3. **用完即焚**：`finally` 里 `dispose()` + 退订，防内存与监听器泄漏
 *    （内存会话不落盘，但订阅与工具回调会一直挂着）。
 *
 * ## 失败分类（关键）
 *
 * 评审员**自己**是基础设施：它超时 / 429 / 抛异常时，
 * 这既不是"交付不合格"，也不是"评审通过"。所以这里只返回 `status: 'error'`，
 * 由调用方决定重试或退回人工 —— 绝不把基础设施报错写成业务缺陷
 * （那会让执行者拿着"429 Too Many Requests"去改代码）。
 */
import { RunUsage } from '../run-stats.js';
import { buildCriticPrompt, parseCriticVerdict, selectCriticModel, criticModelFromEnv } from './task-critic.js';

/** 评审默认超时：比一次执行短得多（只读核对，不需要长时间改文件）。 */
export const CRITIC_TIMEOUT_MS = 180_000;

/** 评审失败（基础设施）的类别，调用方据此决定重试还是退回。 */
export const CRITIC_ERROR = Object.freeze({
  noSession: 'no_session',
  timeout: 'timeout',
  promptFailed: 'prompt_failed',
  noOutput: 'no_output',
});

/**
 * 评审的用量口径。
 *
 * ★ 两套形状必须都带：
 *   · `run-stats` 的 `RunUsage.snapshot()` 用 `input` / `output` / `inputTotal`；
 *   · 任务预算的 `tokenCountOf()` 只认 `inputTokens` / `outputTokens`。
 *   只带一套的后果是「评审烧了 token 但没计入根预算」—— 静默绕过 PR #43 的 `maxTokens`。
 */
export function criticUsageOf(snapshot) {
  const src = snapshot ?? {};
  const input = Number(src.inputTotal ?? src.input ?? 0) || 0;
  const output = Number(src.output ?? 0) || 0;
  return { ...src, inputTokens: input, outputTokens: output };
}

/** 从模型组里摊平出候选（slug/label/groupId/provider/baseUrl），供纯策略挑选。 */
export function criticCandidatesOf(modelGroups) {
  const groups = typeof modelGroups?.list === 'function' ? modelGroups.list() : [];
  const out = [];
  for (const group of groups ?? []) {
    if (!group || group.enabled === false) continue;
    const provider = String(group.provider ?? '');
    const baseUrl = String(group.baseUrl ?? '');
    for (const entry of group.menuEntries?.() ?? []) {
      for (const slug of entry.slugs ?? []) {
        out.push({ slug, label: entry.label, groupId: group.id, provider, baseUrl, enabled: true });
      }
    }
  }
  return out;
}

/** 执行者的模型描述（用于本地隔离与"换一个模型"判定）。 */
function executorModelOf({ store, botId, modelGroups }) {
  const bot = store?.getBot?.(botId) ?? null;
  const slug = String(bot?.model ?? '').trim();
  const idx = slug.indexOf('/');
  const groupId = idx > 0 ? slug.slice(0, idx) : '';
  const group = groupId ? modelGroups?.get?.(groupId) ?? null : null;
  return {
    slug,
    groupId,
    provider: String(group?.provider ?? ''),
    baseUrl: String(group?.baseUrl ?? ''),
  };
}

/**
 * 造一个评审执行器。
 *
 * @param {object} p
 * @param {object} p.runner PiRunner（要 `__buildSession` 与 `breakerFor`）
 * @param {object} p.store
 * @param {Function} p.routeOf 任务 → `{ roomId, botId }`
 * @param {object} [p.config]
 * @param {object} [p.health]
 * @param {()=>number} [p.clock]
 * @param {Function} [p.log]
 * @param {number} [p.timeoutMs]
 * @returns {(args:{taskRun:object, verification:object, prompt?:string}) => Promise<object>}
 */
export function createCriticReviewer({
  runner, store, routeOf, config = null, health = null,
  clock = () => Date.now(), log = () => {}, timeoutMs = CRITIC_TIMEOUT_MS,
} = {}) {
  return async function criticReview({ taskRun, verification = null, prompt = null, attemptId = null } = {}) {
    const route = typeof routeOf === 'function' ? routeOf(taskRun) : null;
    const roomId = route?.roomId ?? null;
    const botId = route?.botId ?? taskRun?.owner?.leadBotId ?? null;
    if (!roomId || !botId) {
      return { status: 'error', code: CRITIC_ERROR.noSession, why: '找不到可以跑评审的会话（任务没有可用房间/执行者）' };
    }
    if (typeof runner?.__buildSession !== 'function') {
      return { status: 'error', code: CRITIC_ERROR.noSession, why: '运行时没有会话工厂，无法开评审会话' };
    }

    const executorModel = executorModelOf({ store, botId, modelGroups: runner.modelGroups });
    const picked = selectCriticModel({
      executorModel,
      candidates: criticCandidatesOf(runner.modelGroups),
      explicitModel: criticModelFromEnv(),
      isBreakerOpen: (slug, groupId) => {
        try {
          const found = runner.breakerFor?.(botId, slug) ?? null;
          const group = found?.groupId ?? groupId;
          const breaker = runner.breakers?.get?.(group) ?? found?.breaker ?? null;
          return breaker?.state === 'open';
        } catch {
          return false;
        }
      },
    });

    const text = prompt ?? buildCriticPrompt({ taskRun, verification });
    const meter = new RunUsage();
    let entry = null;
    let reply = '';
    let timedOut = false;
    let failure = null;
    let timer = null;
    let unsubscribe = null;
    try {
      entry = await runner.__buildSession(roomId, botId, {
        criticLane: true,
        persist: false,
        // 没有别的可用模型时退回执行者同款：`undefined` 就是"用 bot 自己的模型"
        ...(picked.slug ? { modelOverride: picked.slug } : {}),
      });
      const session = entry?.session ?? null;
      if (!session) {
        return { status: 'error', code: CRITIC_ERROR.noSession, why: '评审会话没建起来' };
      }
      unsubscribe = session.subscribe((ev) => {
        try {
          if (ev?.type === 'message_end' && ev.message?.usage) meter.add(ev.message.usage);
          if (ev?.type === 'message_update') {
            const inner = ev.assistantMessageEvent ?? null;
            if (inner?.type === 'text_delta') reply += String(inner.delta ?? '');
            if (inner?.type === 'message_end' && (ev.message?.usage ?? inner.usage)) {
              meter.add(ev.message?.usage ?? inner.usage);
            }
          }
          // 有些版本的 SDK 把整条 assistant 消息放在 message_update 里
          if (ev?.type === 'message_end' && ev.message?.content) {
            const joined = (Array.isArray(ev.message.content) ? ev.message.content : [])
              .map((part) => (typeof part === 'string' ? part : String(part?.text ?? '')))
              .join('');
            if (!reply && joined) reply = joined;
          }
        } catch {
          // 事件形态变了不能影响评审本身
        }
      });
      timer = setTimeout(() => {
        timedOut = true;
        try { session.abort?.()?.catch?.(() => {}); } catch {}
      }, Math.max(5_000, Number(timeoutMs) || CRITIC_TIMEOUT_MS));
      timer.unref?.();
      try {
        await session.prompt(text);
      } finally {
        if (timer) clearTimeout(timer);
        timer = null;
      }
    } catch (err) {
      failure = {
        status: 'error',
        code: CRITIC_ERROR.promptFailed,
        why: '评审请求失败：' + String(err?.message ?? err).slice(0, 200),
      };
    } finally {
      try { unsubscribe?.(); } catch {}
      try { entry?.unsubscribe?.(); } catch {}
      try { await entry?.session?.dispose?.(); } catch {}
    }

    const usage = criticUsageOf(meter.snapshot());
    if (timedOut) {
      return {
        status: 'error',
        code: CRITIC_ERROR.timeout,
        why: `评审超时（${Math.round(Math.max(5_000, Number(timeoutMs) || CRITIC_TIMEOUT_MS) / 1000)} 秒无结论）`,
        usage,
        reviewerModel: picked.label,
      };
    }
    if (failure) return { ...failure, usage, reviewerModel: picked.label };
    if (!String(reply).trim()) {
      return {
        status: 'error',
        code: CRITIC_ERROR.noOutput,
        why: '评审员没有输出任何内容',
        usage,
        reviewerModel: picked.label,
      };
    }
    const parsed = parseCriticVerdict(reply);
    log('独立评审', taskRun?.id, parsed.verdict, 'round', String(attemptId ?? ''), 'model', picked.label);
    return {
      status: 'reviewed',
      ...parsed,
      raw: String(reply).slice(0, 4000),
      reviewerModel: picked.label,
      reviewerSlug: picked.slug ?? executorModel.slug,
      modelWhy: picked.why,
      sameAsExecutor: picked.sameAsExecutor === true,
      usage,
      at: clock(),
    };
  };
}
