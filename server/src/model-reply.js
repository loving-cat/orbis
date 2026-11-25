/**
 * 模型失败分类、可展示错误与空回复恢复；不输出接口原文或连接凭据。
 *
 * ★ 返回对象里除了给人看的 `.error`，还有 `code` 与 `detail`（脱敏技术摘要）：
 *   诊断面板与 `server.log` 都靠这两项才能说出「到底是 400 参数不支持、还是
 *   中转站 502」。只分类不给细节，用户就永远卡在「接口详情已隐藏」上。
 */
export function modelFailure(error) {
  const classified = classifyFailure(error);
  return {
    ...classified,
    code: String(error?.code ?? error?.cause?.code ?? '').trim(),
    detail: formatFailureDetail(error),
  };
}

function classifyFailure(error) {
  const raw = typeof error === 'string' ? error : String(error?.message ?? error?.errorMessage ?? '');
  const status = Number(error?.status ?? error?.statusCode) || Number(raw.match(/\b(400|401|402|403|404|408|429|500|502|503|504)\b/)?.[1]) || null;
  // ★ 超时**必须排在 aborted 之前**。
  //
  //   SDK / undici 的超时错误长得就是中止的样子：
  //     `TimeoutError: The operation was aborted due to timeout`
  //   以前先匹配 `aborted`，于是「上游超时」被归成「用户终止」
  //   → `aborted: true, error: '已终止'` → T6 护栏（不可恢复快停）直接把它判死，
  //   连一次重试都不给。超时是**上游问题**，必须走重试/退避那条路。
  const name = String(error?.name ?? '');
  if (name === 'TimeoutError'
    || /timeout|timed out|超时|超过.{0,8}未完成/i.test(raw)
    || status === 408 || status === 504) {
    return { status, auth: false, timedOut: true, error: '模型请求超时，已停止等待，请稍后重试。' };
  }
  // 真正的中止只认**结构化信号**或明确的中文说法。
  // ★ 不再用宽泛的 `aborted` / `cancelled` 正则：上游断流的文案就长这样
  //   （`Stream aborted by upstream`），把它当"用户终止"会让一次网络抖动
  //   变成"这一单被用户取消了"，而且再也不重试。
  const structuredAbort = name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.stopReason === 'aborted';
  if (structuredAbort || /已(?:按你的要求)?(?:终止|中止)|用户已终止/i.test(raw)) {
    return { status: null, auth: false, aborted: true, error: '已终止' };
  }
  if (status === 401 || /unauthorized|invalid[ _-]?(?:api[ _-]?)?key|authentication[ _-]?(?:failed|error)/i.test(raw)) {
    return { status: 401, auth: true, error: '模型请求认证失败（HTTP 401），请检查模型组凭据与接口认证配置。' };
  }
  // ★ 402 / 配额不足：这不是临时故障，重试只会继续烧钱（还可能把 key 用到欠费）。
  //   单独给一个 quota 标记，上层据此说人话并熔断，而不是当 transient 反复重试。
  if (status === 402 || /insufficient_quota|quota exceeded|billing hard limit|arrears|余额不足|额度不足|欠费/i.test(raw)) {
    return { status: status || 402, auth: false, quota: true, error: '该接口配额或余额不足，请检查用量或切换备用密钥。' };
  }
  if (status === 403 || /forbidden|permission[ _-]denied/i.test(raw)) {
    return { status: 403, auth: true, error: '模型请求被拒绝（HTTP 403），请检查账号及模型访问权限。' };
  }
  if (status === 429) return { status, auth: false, error: '模型请求被限流（HTTP 429），请稍后重试。' };
  if (/context.?length|context.?window|maximum.?context|too many tokens/i.test(raw)) {
    return { status, auth: false, error: '模型接口报告上下文超限，请核实容量配置或压缩会话。' };
  }
  if (/timeout|timed out|超时|超过.*未完成/i.test(raw) || status === 408 || status === 504) {
    // ★ timedOut 是运行失败事实，不是用户取消 —— 上层据此区分停止原因
    return { status, auth: false, timedOut: true, error: '模型请求超时，已停止等待，请稍后重试。' };
  }
  return { status, auth: false, error: status
    ? `模型请求失败（HTTP ${status}），请检查接口配置或稍后重试。`
    : '模型请求失败，接口详情已隐藏，请检查服务端或模型接口日志。' };
}

/**
 * 给模型失败文案补上"哪条链路"，方便用户立刻定位该改哪里。
 *
 * 典型现场：同一个群里有 5 个 bot，其中一个换到新模型就能跑，另外两个
 * 还在老模型组上被限流；用户看到几条一模一样的红字「模型请求失败」，
 * 根本不知道是哪个模型、哪条链路出的问题，于是只会反复"再切一次模型"。
 */

/**
 * 把错误对象整理成**能排障**的一行技术摘要（Mac 实机 UX-4）。
 *
 * 要的是这四样，别的都别写进来：
 *   · HTTP 状态（`status` / `statusCode`）；
 *   · 网络/链路错误码（`ECONNRESET` / `UND_ERR_HEADERS_TIMEOUT` / `ENOTFOUND`…）；
 *   · `cause` 链上的一层（`fetch failed` 的真实原因常在这里）；
 *   · 上游响应体里的 `error.type` / `error.message`（中转站 502、模型名错、
 *     思考参数不支持这些都在这里）。
 *
 * 输出前统一过 [redactDiagnostic]：Bearer / sk-… / api_key=… / token 一律打码。
 *
 * @param {any} error
 * @returns {string} ≤500 字符；没有可用信息时返回空串
 */
export function formatFailureDetail(error) {
  const parts = [];
  const status = Number(error?.status ?? error?.statusCode) || null;
  if (status) parts.push(`HTTP ${status}`);

  const code = String(error?.code ?? error?.errno ?? '').trim();
  if (code) parts.push(`code=${code}`);

  const cause = error?.cause;
  if (cause && typeof cause === 'object') {
    const causeCode = String(cause.code ?? '').trim();
    if (causeCode && causeCode !== code) parts.push(`cause=${causeCode}`);
    const causeMsg = String(cause.message ?? '').trim();
    if (causeMsg && causeMsg !== String(error?.message ?? '').trim()) parts.push(causeMsg);
  }

  // 上游返回体：不同 SDK 包法不一样，能取到哪种算哪种
  const upstream = error?.response?.data?.error
    ?? error?.response?.error
    ?? error?.body?.error
    ?? error?.data?.error
    ?? error?.errorPayload;
  if (upstream && typeof upstream === 'object') {
    const type = String(upstream.type ?? upstream.code ?? '').trim();
    const msg = String(upstream.message ?? upstream.msg ?? '').trim();
    if (type) parts.push(`upstream=${type}`);
    if (msg) parts.push(msg);
  } else if (typeof upstream === 'string' && upstream.trim()) {
    parts.push(upstream.trim());
  }

  const message = String(error?.message ?? error?.errorMessage ?? (typeof error === 'string' ? error : '') ?? '').trim();
  if (message && !parts.some((p) => p.includes(message))) parts.push(message);

  return redactDiagnostic(parts.join(' · ')).slice(0, 500);
}

/**
 * 诊断文本的脱敏。宁可多打码：这段文本会进 App、进日志、可能被用户贴到公开 issue。
 *
 * @param {string} value
 * @returns {string}
 */
export function redactDiagnostic(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{4,}/g, 'sk-[REDACTED]')
    // api_key=xxx / api-key: xxx / token":"xxx"
    .replace(/((?:api[_-]?key|x-api-key|access[_-]?token|token|secret|password|password)\s*["']?\s*[:=]\s*["']?)([^\s"',;}]{3,})/gi, '$1[REDACTED]')
    .replace(/\b(?:authorization)\b\s*[:=]\s*\S+/gi, 'authorization: [REDACTED]')
    .slice(0, 1000);
}
export function withModelHint(message, model) {
  const text = String(message ?? '').trim();
  const slug = String(model ?? '').trim();
  if (!text || !slug) return text;
  if (text.includes(slug)) return text;
  return `${text}（当前模型：${slug}）`;
}

export function assistantFailure(message) {
  if (message?.role !== 'assistant') return null;
  if (message.stopReason === 'aborted') return modelFailure({ name: 'AbortError' });
  if (!message.errorMessage && message.stopReason !== 'error') return null;
  return modelFailure(message.errorMessage || message);
}

export function replyText(message) {
  return (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

/** 只使用本轮选中模型与原默认模型，不扩大到其它已配置线路。 */
export function fallbackModels(selected, defaultModel) {
  const seen = new Set();
  return [selected, defaultModel].filter((model) => {
    if (!model?.provider || !model?.id) return false;
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 已有明确错误时直接返回；仅对真正空回复执行一次催促和限定模型的文本补答。 */
export async function recoverModelReply({ failure, nudge, readText, readFailure, complete, models,
  signal, isCancelled = () => false }) {
  const cancellation = () => signal?.aborted || isCancelled()
    ? modelFailure({ name: 'AbortError' }) : null;
  const stopped = (failure) => ({ text: '', failure, recovered: false });
  let cancelled = cancellation();
  if (cancelled) return stopped(cancelled);
  if (failure) return { text: '', failure, recovered: false };
  let lastFailure = null;
  try {
    await nudge(signal);
    cancelled = cancellation();
    if (cancelled) return stopped(cancelled);
    lastFailure = readFailure();
    if (lastFailure) return { text: '', failure: lastFailure, recovered: false };
    const text = readText().trim();
    if (text) return { text, failure: null, recovered: true };
  } catch (error) {
    lastFailure = cancellation() ?? modelFailure(error);
    if (lastFailure.auth || lastFailure.aborted || signal?.aborted) return stopped(lastFailure);
  }
  for (const model of models) {
    cancelled = cancellation();
    if (cancelled) return stopped(cancelled);
    try {
      const reply = await complete(model, signal);
      cancelled = cancellation();
      if (cancelled) return stopped(cancelled);
      const error = assistantFailure(reply);
      if (error) {
        lastFailure = error;
        if (error.auth || error.aborted) break;
        continue;
      }
      const text = replyText(reply).trim();
      if (text) return { text, failure: null, recovered: true };
    } catch (error) {
      lastFailure = cancellation() ?? modelFailure(error);
      if (lastFailure.auth || lastFailure.aborted || signal?.aborted) break;
    }
  }
  return { text: '', failure: lastFailure, recovered: false };
}
