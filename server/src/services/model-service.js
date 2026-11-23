/**
 * 模型组、默认模型与快决策路由（Jev）领域服务（SDK / HTTP / Jarvis 工具共用）。
 *
 * 所有对外返回值都自动做 Key 脱敏（masked / hasApiKey），
 * 并支持在聊天触发时自动将参数里出现过的明文 Key 在聊天记录原地打码。
 */
import { modelGroups as defaultModelGroups, testModelGroup, maskKey } from '../model-groups.js';
import { jevProbe } from '../jev-client.js';
import { endpointTarget } from '../model-endpoints.js';
import { recordFailure } from '../diagnostics-log.js';

export function publicDecision(d = {}) {
  const { apiKey, ...rest } = d;
  return {
    ...rest,
    hasApiKey: Boolean(String(apiKey || '').trim()),
    keyMasked: maskKey(d.apiKey),
  };
}

export function createModelService({ store, runner = null, modelGroups = defaultModelGroups }) {
  return {
    list() {
      const groups = modelGroups.listPublic();
      const d = store.decision();
      return {
        defaultModel: store.defaultModel(),
        activeDefaultModel: runner?.modelLabel?.() ?? null,
        modelGroups: groups,
        decision: publicDecision(d),
      };
    },

    async upsertGroup(input = {}, { awaitRefresh = true, redactRoomId = null } = {}) {
      if (redactRoomId && typeof store.redactRoomSecrets === 'function') {
        const rawKeys = [
          input.apiKey,
          ...(Array.isArray(input.endpoints) ? input.endpoints.map((e) => e?.apiKey) : []),
        ].filter(Boolean);
        if (rawKeys.length) store.redactRoomSecrets(redactRoomId, rawKeys);
      }

      const r = modelGroups.upsert(input);
      if (r.error) {
        return { ok: false, status: 400, code: 'MODEL_GROUP_INVALID', error: r.error };
      }
      const pub = r.group.toPublic();
      let total = null;
      if (typeof runner?.applyModelGroupChange === 'function') {
        if (awaitRefresh) {
          total = await runner.applyModelGroupChange(pub.id);
        } else {
          void runner.applyModelGroupChange(pub.id).catch(() => {});
        }
      }
      return { ok: true, group: pub, rawGroup: r.group, total };
    },

    async removeGroup(id, { awaitRefresh = false } = {}) {
      const cleanId = String(id ?? '').trim();
      const removed = modelGroups.remove(cleanId);
      if (!removed) {
        return { ok: false, status: 404, code: 'MODEL_GROUP_NOT_FOUND', error: '模型组不存在或属于内置保护组' };
      }
      if (typeof runner?.applyModelGroupChange === 'function') {
        if (awaitRefresh) {
          await runner.applyModelGroupChange(cleanId);
        } else {
          void runner.applyModelGroupChange(cleanId).catch(() => {});
        }
      }
      return { ok: true, id: cleanId };
    },

    async testGroup(input = {}, { redactRoomId = null } = {}) {
      if (redactRoomId && input.apiKey && typeof store.redactRoomSecrets === 'function') {
        store.redactRoomSecrets(redactRoomId, [input.apiKey]);
      }
      const saved = input.id ? modelGroups.get(input.id) : null;
      // ★ 换目标时绝不复用已保存的凭据。
      //
      //   调用方显式传了 baseUrl 且和已保存的目标不是同一台服务器（规范化后比较，
      //   见 model-endpoints 的 endpointTarget），说明这次请求要去别处：
      //   把 saved.apiKey 带过去，等于用户点一次「测试连接」就把密钥交给那台机器。
      const askedBaseUrl = String(input.baseUrl ?? '').trim();
      const savedBaseUrl = String(saved?.baseUrl ?? '').trim();
      // ★ 只要显式给了新地址，就必须**证明**它和已保存目标是同一台：
      //   没有保存过地址（savedBaseUrl 为空）时不能当成"同一个" —— 那是"没得比"，
      //   不是"比过了相等"。规范化失败（endpointTarget 为 null）同理。
      const askedTarget = askedBaseUrl ? endpointTarget(askedBaseUrl) : null;
      const sameTarget = !askedBaseUrl
        || (Boolean(savedBaseUrl) && askedTarget !== null
          && askedTarget === endpointTarget(savedBaseUrl));
      const baseUrl = askedBaseUrl || savedBaseUrl;
      const model = input.model || saved?.models?.[0]?.id;
      const result = await testModelGroup({
        baseUrl,
        apiKey: input.apiKey || (sameTarget ? saved?.apiKey : ''),
        api: input.api || saved?.api,
        model,
      });
      // 「测试连接」失败也要进诊断日志：用户看到的那句话通常只有"HTTP 502"，
      // 真正的原因（中转站挂了 / 模型名错）在 detail 里（Mac 实机 UX-4）。
      if (result && result.ok === false) {
        recordFailure(null, {
          phase: 'test',
          roomId: '',
          botId: '',
          botName: '',
          model: `${model ?? ''} · ${baseUrl}`,
          status: result.status ?? null,
          code: result.code ?? '',
          summary: result.error ?? '模型组测试失败',
          detail: result.detail ?? result.error ?? '',
          ms: result.ms ?? null,
        });
      }
      return result;
    },

    async setDefaultModel(slug = '') {
      const clean = String(slug ?? '').trim();
      if (typeof runner?.setDefaultModel === 'function') {
        const res = await runner.setDefaultModel(clean);
        if (!res.ok) {
          return { ok: false, status: 400, code: 'MODEL_NOT_FOUND', error: res.error || '切换默认模型失败' };
        }
        return { ok: true, model: res.model ?? null };
      }
      const saved = store.setDefaultModel(clean);
      return { ok: true, model: saved ?? null };
    },

    getDecision() {
      return publicDecision(store.decision());
    },

    updateDecision(patch = {}, { redactRoomId = null } = {}) {
      if (redactRoomId && patch.apiKey && typeof store.redactRoomSecrets === 'function') {
        store.redactRoomSecrets(redactRoomId, [patch.apiKey]);
      }
      const next = store.updateDecision(patch ?? {});
      return { ok: true, decision: publicDecision(next), raw: next };
    },

    async probeDecision(input = {}) {
      const cfg = store.decision();
      const savedMode = cfg.mode === 'custom' ? 'custom' : 'typesafe';
      const mode = input.mode === 'custom' || savedMode === 'custom' ? 'custom' : 'typesafe';
      const askedBaseUrl = mode === 'custom' ? String(input.baseUrl ?? '').trim() : '';
      const savedBaseUrl = savedMode === 'custom' ? String(cfg.baseUrl ?? '').trim() : '';
      // ★ 同 testGroup，还要多一条：**跨模式不复用**。
      //   已保存的是 typesafe（地址为空、key 是 typesafe 的），现在用
      //   `mode: 'custom'` + 新地址去探测 —— 这台新服务器和 typesafe 毫无关系，
      //   把它当成"没换目标"就会把 typesafe 的 key 发给一个陌生地址。
      const crossMode = mode !== savedMode;
      const askedTarget = askedBaseUrl ? endpointTarget(askedBaseUrl) : null;
      const sameTarget = !crossMode && (
        !askedBaseUrl
          || (Boolean(savedBaseUrl) && askedTarget !== null
            && askedTarget === endpointTarget(savedBaseUrl))
      );
      return jevProbe({
        baseUrl: mode === 'custom' ? (askedBaseUrl || savedBaseUrl) : 'https://api.typesafe.ai',
        apiKey: input.apiKey || (sameTarget ? cfg.apiKey : ''),
      });
    },
  };
}
