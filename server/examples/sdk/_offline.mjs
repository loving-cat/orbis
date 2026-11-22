/**
 * 示例用的**离线桩**：没有 API key、不联网，也能把 `examples/sdk/*` 真跑一遍。
 *
 * 为什么示例里要带桩：
 *   · 示例是给人复制到自己项目里的，但 CI 也要能跑（要真的检到「这行 API 变了没」）；
 *   · 真实模型需要一个 key，CI 里没有 —— 于是每个示例默认走这里的桩，
 *     需要真跑的时候按各示例里的注释换掉两行即可（`modelRuntimeFactory` / `sessionApi`）。
 *
 * ★ 这不是 SDK 的一部分，只是示例的脚手架：删掉它不影响你把示例搬走。
 */

/** 一个最小的模型运行时：只认识 `offline/demo-1`，不联网。 */
export function offlineModelRuntime() {
  const models = [{ provider: 'offline', id: 'demo-1', contextWindow: 128_000, reasoning: false }];
  return {
    registerProvider() {},
    unregisterProvider() {},
    getModels: () => models,
    getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id) ?? null,
    async getAvailable() {
      return models;
    },
    async completeSimple() {
      return { content: [{ type: 'text', text: '{}' }] };
    },
  };
}

/** 给 `createOrbisRuntime({ modelRuntimeFactory })` 用 */
export const offlineModelRuntimeFactory = async () => offlineModelRuntime();

/**
 * 一个最小的会话 API 桩：`prompt()` 回一句固定的话，并按真 pi 的形状发事件。
 *
 * 真跑的时候把这整个函数从参数里去掉即可 —— 那时用的是
 * `@earendil-works/pi-coding-agent` 自己的 `createAgentSession`。
 */
export function offlineSessionApi() {
  class OfflineResourceLoader {
    constructor(options) {
      this.options = options;
    }
    async reload() {}
  }
  const tool = (name) => ({ name, description: `offline ${name}`, parameters: {}, async execute() { return { content: [] }; } });
  const api = {
    DefaultResourceLoader: OfflineResourceLoader,
    SessionManager: { inMemory: () => ({}), create: () => ({}), open: () => ({}) },
    createBashTool: () => tool('bash'),
    createPowerShellTool: () => tool('powershell'),
    getAgentDir: () => '.orbis-demo/agent',
    async createAgentSession(options = {}) {
      // 示例里要能“看到到底交了什么进去”：只记录，不改行为
      api.lastSessionOptions = options;
      const listeners = new Set();
      const messages = [];
      const emit = (ev) => {
        for (const fn of [...listeners]) fn(ev);
      };
      const session = {
        messages,
        state: { messages },
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        dispose() {
          listeners.clear();
        },
        async abort() {},
        async steer(text) {
          return this.prompt(text);
        },
        async followUp(text) {
          return this.prompt(text);
        },
        getContextUsage() {
          return { tokens: 12, contextWindow: 128_000, percent: 0.1 };
        },
        async prompt(text) {
          emit({ type: 'message_start', message: { role: 'assistant' } });
          const reply = { role: 'assistant', content: [{ type: 'text', text: `（离线桩）收到：${text}` }], usage: { input: 8, output: 8, totalTokens: 16 } };
          messages.push(reply);
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply.content[0].text } });
          emit({ type: 'message_end', message: reply });
          emit({ type: 'turn_end' });
          emit({ type: 'agent_end' });
        },
      };
      return { session };
    },
  };
  return api;
}

/**
 * 每个示例共用的选项：把状态放在当前目录下的 `.orbis-demo/`。
 * CI 会在临时目录里跑示例，所以这些相对路径不会污染仓库。
 */
export function demoOptions(extra = {}) {
  return {
    dataDir: '.orbis-demo/state',
    workspace: '.orbis-demo/workspace',
    userName: 'Alice',
    defaultModel: 'offline/demo-1',
    // 离线桩假装有一个模型组：否则启动日志会一边说“默认模型 offline/demo-1”、
    // 一边提示“还没有可用的模型”，读起来自相矛盾。真跑时换成你自己的 provider。
    modelGroups: [
      {
        name: 'offline',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: '', // 离线桩不联网，不需要 key（真跑时换成你自己的）
        api: 'openai-completions',
        models: [{ id: 'demo-1', contextWindow: 128000, maxTokens: 8192 }],
      },
    ],
    modelRuntimeFactory: offlineModelRuntimeFactory,
    sessionApi: offlineSessionApi(),
    ...extra,
  };
}
