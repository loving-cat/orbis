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
import { assistantFailure, replyText } from '../model-reply.js';
import { fallbackModeFrom, isLocalEndpoint, providerOfSlug } from '../runner/model-fallback.js';
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

/**
 * 从模型组里摊平出候选。
 *
 * ★ 三个字段必须补全，否则「本地/公网」判定会与生产真实数据错位：
 *   · 真实 `ModelGroup` **没有 `.provider` 字段**（只有 api / baseUrl / endpoints），
 *     provider 只能从 `resolveModel(slug)` 或 slug 前缀取；
 *   · 一个组可能有多个 `endpoints`，`isLocalEndpoint` 只看单个 baseUrl，
 *     所以这里预先算好 `local`（任一端点/主地址是本地即算本地）；
 *   · 顺带透传 `endpoints`，让调用方能复核。
 */
export function criticCandidatesOf(modelGroups, { resolveModel = null } = {}) {
  const groups = typeof modelGroups?.list === 'function' ? modelGroups.list() : [];
  const out = [];
  for (const group of groups ?? []) {
    if (!group || group.enabled === false) continue;
    const endpoints = Array.isArray(group.endpoints) ? group.endpoints : [];
    for (const entry of group.menuEntries?.() ?? []) {
      for (const slug of entry.slugs ?? []) {
        const resolved = typeof resolveModel === 'function' ? (resolveModel(slug) ?? null) : null;
        const provider = String(resolved?.provider ?? '').trim() || providerOfSlug(slug);
        const baseUrl = String(resolved?.baseUrl ?? group.baseUrl ?? '').trim();
        const local = [
          { provider, model: slug, id: resolved?.id ?? '', baseUrl },
          ...endpoints.map((ep) => ({ provider, model: slug, baseUrl: ep?.baseUrl })),
        ].some((probe) => isLocalEndpoint(probe));
        out.push({
          slug,
          label: entry.label,
          groupId: group.id,
          provider,
          baseUrl,
          endpoints: endpoints.map((ep) => ep?.baseUrl).filter(Boolean),
          local,
          enabled: true,
        });
      }
    }
  }
  return out;
}

/**
 * 执行者的模型描述（用于本地隔离与「换一个模型」判定）。
 *
 * ★ 三条都要：
 *   1. `bot.model` 为空时（用默认模型的常见情形）回落读 `runner.modelLabel()` /
 *      `runner.model` —— 只看 `bot.model` 会把「默认模型是 ollama」看成「没有模型」，
 *      于是本地执行者被允许换到云端评审；
 *   2. provider 优先取 `resolveModel(slug)`，其次 slug 前缀（真实 ModelGroup 没有 provider 字段）；
 *   3. 把所有 `endpoints[].baseUrl` 一起纳入本地判定（主地址公网 + 备用地址局域网也算本地）。
 */
export function executorModelOf({ runner, store, botId }) {
  const bot = store?.getBot?.(botId) ?? null;
  const resolveModel = typeof runner?.resolveModel === 'function' ? runner.resolveModel : null;
  const labelOf = () => {
    try {
      return String(runner?.modelLabel?.() ?? '').trim();
    } catch {
      return '';
    }
  };
  const runtimeModel = runner?.model ?? null;
  const runtimeSlug = runtimeModel
    ? String(runtimeModel.slug ?? `${runtimeModel.provider ?? ''}/${runtimeModel.id ?? ''}`).trim()
    : '';
  const slug = String(bot?.model ?? '').trim() || labelOf() || runtimeSlug;
  const resolved = resolveModel ? (resolveModel(slug) ?? null) : null;
  const idx = slug.indexOf('/');
  const groupId = idx > 0 ? slug.slice(0, idx) : '';
  const group = groupId && typeof runner?.modelGroups?.get === 'function' ? (runner.modelGroups.get(groupId) ?? null) : null;
  const endpoints = Array.isArray(group?.endpoints) ? group.endpoints : [];
  const provider = String(resolved?.provider ?? '').trim()
    || String(runtimeModel?.provider ?? '').trim()
    || providerOfSlug(slug);
  const baseUrl = String(resolved?.baseUrl ?? group?.baseUrl ?? '').trim();
  const model = slug;
  const local = [
    { provider, model, id: resolved?.id ?? runtimeModel?.id ?? '', baseUrl },
    ...endpoints.map((ep) => ({ provider, model, baseUrl: ep?.baseUrl })),
  ].some((probe) => isLocalEndpoint(probe));
  return {
    slug,
    label: labelOf() || slug,
    groupId,
    provider,
    baseUrl,
    endpoints: endpoints.map((ep) => ep?.baseUrl).filter(Boolean),
    model,
    local,
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

    const executorModel = executorModelOf({ runner, store, botId });
    const resolveModel = typeof runner.resolveModel === 'function' ? runner.resolveModel : null;
    const explicitModel = criticModelFromEnv();
    // 显式模型的「是不是本地」必须用与候选同一套口径解析，否则就漏掉
    // 「ORBIS_CRITIC_MODEL 指向云端，而执行者是 ollama」这种外泄路径。
    const explicitResolved = explicitModel && resolveModel ? (resolveModel(explicitModel) ?? null) : null;
    const picked = selectCriticModel({
      executorModel,
      candidates: criticCandidatesOf(runner.modelGroups, { resolveModel }),
      // ★ 与自动兜底同一条隐私/费用边界：评审员会读产物原文，「换一家审」就是把内容发给另一家
      policyMode: fallbackModeFrom(process.env),
      userLocked: store?.getBot?.(botId)?.lockModel === true,
      explicitProvider: explicitModel
        ? (String(explicitResolved?.provider ?? '').trim() || providerOfSlug(explicitModel))
        : null,
      explicitModel,
      explicitLocal: explicitModel
        ? [
          { model: explicitModel, id: explicitResolved?.id ?? '', provider: String(explicitResolved?.provider ?? '').trim() || providerOfSlug(explicitModel), baseUrl: explicitResolved?.baseUrl ?? '' },
          { model: explicitModel, baseUrl: runner.modelGroups?.get?.(providerOfSlug(explicitModel))?.baseUrl ?? '' },
        ].some((probe) => isLocalEndpoint(probe))
        : null,
      explicitResolvable: Boolean(explicitResolved),
      isBreakerOpen: (slug, groupId) => {
        try {
          const found = runner.breakerFor?.(botId, slug) ?? null;
          // ★ 优先读模型级熔断（同组里 dead 熔断、healthy 未熔断必须区分得开）
          const breaker = found?.breaker
            ?? runner.breakers?.get?.(slug)
            ?? runner.breakers?.get?.(found?.groupId ?? groupId)
            ?? null;
          return breaker?.state === 'open';
        } catch {
          return false;
        }
      },
    });

    const text = prompt ?? buildCriticPrompt({ taskRun, verification });
    const meter = new RunUsage();
    let entry = null;
    let turnBuf = '';
    let lastAssistantText = '';
    let timedOut = false;
    let failure = null;
    let sdkFailure = null;
    let timer = null;
    let unsubscribe = null;
    try {
      entry = await runner.__buildSession(roomId, botId, {
        criticLane: true,
        persist: false,
        /**
         * ★ C4：worktree 子任务的代码**还没合回主仓**。评审员必须去
         *   `worktreePath` 里读真实改动，否则它看到的是主仓（没有这些文件），
         *   于是「评审通过」与「实际交付」完全脱节。
         */
        ...(taskRun?.worktree?.worktreePath ? { workDir: taskRun.worktree.worktreePath } : {}),
        // 没有别的可用模型时退回执行者同款：`undefined` 就是"用 bot 自己的模型"
        ...(picked.slug ? { modelOverride: picked.slug } : {}),
      });
      const session = entry?.session ?? null;
      if (!session) {
        return { status: 'error', code: CRITIC_ERROR.noSession, why: '评审会话没建起来' };
      }
      // ★ 与 `turn-executor.js` 同一套读法：评审也可能先调几个只读工具再下结论
      //   （多轮 turn）。三个必须点：
      //     · `message_start`（assistant）→ 清空本轮 buffer，别把上一轮的思考当结论；
      //     · `message_update` 的 text_delta 只追加，不在这里计 usage；
      //     · `message_end`（assistant）→ 先判 SDK 静默上报的错误（429/auth/模型错），
      //       再记文本；usage **只在这里**加一次（否则 update+end 会双计）。
      unsubscribe = session.subscribe((ev) => {
        try {
          if (ev?.type === 'message_start' && ev.message?.role === 'assistant') {
            turnBuf = '';
            return;
          }
          if (ev?.type === 'message_update') {
            const inner = ev.assistantMessageEvent ?? null;
            if (inner?.type === 'text_delta') turnBuf += String(inner.delta ?? '');
            return;
          }
          if (ev?.type !== 'message_end') return;
          if (ev.message?.role !== 'assistant') return;
          meter.add(ev.message.usage);
          const bad = assistantFailure(ev.message);
          if (bad) {
            // SDK 把 429/auth/模型错误放在 stopReason/errorMessage 里，不抛异常；
            // 当成 no_output 会让人以为“评审员没说话”，实际是它根本跑不成。
            sdkFailure = {
              status: 'error',
              code: CRITIC_ERROR.promptFailed,
              why: '评审模型返回错误：' + String(bad.detail ?? bad.kind ?? bad.name ?? '未知错误').slice(0, 200),
            };
            turnBuf = '';
            return;
          }
          const finalText = replyText(ev.message) || turnBuf;
          if (String(finalText).trim()) lastAssistantText = String(finalText).trim();
          turnBuf = '';
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
    if (sdkFailure) return { ...sdkFailure, usage, reviewerModel: picked.label };
    const reply = String(lastAssistantText || turnBuf || '').trim();
    if (!reply) {
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
