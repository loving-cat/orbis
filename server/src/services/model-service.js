/**
 * 模型组、默认模型与快决策路由（Jev）领域服务（SDK / HTTP / Jarvis 工具共用）。
 *
 * 所有对外返回值都自动做 Key 脱敏（masked / hasApiKey），
 * 并支持在聊天触发时自动将参数里出现过的明文 Key 在聊天记录原地打码。
 */
import { modelGroups as defaultModelGroups, testModelGroup, maskKey } from '../model-groups.js';
import { jevProbe } from '../jev-client.js';
import { endpointTarget } from '../model-endpoints.js';

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
      const sameTarget = !askedBaseUrl || !savedBaseUrl
        || endpointTarget(askedBaseUrl) === endpointTarget(savedBaseUrl);
      return testModelGroup({
        baseUrl: askedBaseUrl || savedBaseUrl,
        apiKey: input.apiKey || (sameTarget ? saved?.apiKey : ''),
        api: input.api || saved?.api,
        model: input.model || saved?.models?.[0]?.id,
      });
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
      const mode = input.mode === 'custom' || cfg.mode === 'custom' ? 'custom' : 'typesafe';
      const askedBaseUrl = mode === 'custom' ? String(input.baseUrl ?? '').trim() : '';
      const savedBaseUrl = mode === 'custom' ? String(cfg.baseUrl ?? '').trim() : '';
      // ★ 同 testGroup：自己填一个新地址去「试一下」时，不能顺手把已保存的密钥发过去。
      const sameTarget = !askedBaseUrl || !savedBaseUrl
        || endpointTarget(askedBaseUrl) === endpointTarget(savedBaseUrl);
      return jevProbe({
        baseUrl: mode === 'custom' ? (askedBaseUrl || savedBaseUrl) : 'https://api.typesafe.ai',
        apiKey: input.apiKey || (sameTarget ? cfg.apiKey : ''),
      });
    },
  };
}
