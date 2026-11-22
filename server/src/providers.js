/**
 * 额外 provider 注册。
 *
 * pi 的 provider 有两种来源：
 *   1. ~/.pi/agent/models.json（静态声明，ModelRuntime.create() 能直接看到）
 *   2. 扩展运行时注册（比如 cline-provider 扩展），只有宿主 CLI 进程里才有
 *
 * Orbis server 是独立进程，拿不到第 2 种，所以这里自己注册一份。
 * 优先级：<server>/orbis.config.json（兼容 pi-bot.config.json） > 自动从扩展配置文件导入。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config as defaultConfig } from './config.js';
import { modelGroups as defaultModelGroups } from './model-groups.js';
import { readJson, log } from './util.js';
import { noticeBrandDeprecation } from './brand.js';

function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
}

/**
 * 镜像 ~/.pi/agent/extensions/cline-provider/index.ts 的 MODELS 定义。
 * 那边改了这里也要跟着改（成本/上下文/thinkingLevelMap 的取值需与那边一致）。
 */
function clineProviderConfig(cfg) {
  const model = (id, name, input, cost) => ({
    id,
    name,
    reasoning: true,
    thinkingLevelMap: {
      off: 'minimal',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    },
    input,
    cost,
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
    },
  });

  return {
    name: 'ClinePass',
    baseUrl: cfg.baseUrl || 'https://api.cline.bot/api/v1',
    apiKey: cfg.apiKey,
    api: 'openai-completions',
    authHeader: true,
    models: [
      model('cline-pass/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', ['text', 'image'], {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
        cacheWrite: 0,
      }),
      model('cline-pass/deepseek-v4-pro', 'DeepSeek V4 Pro', ['text'], {
        input: 1.32,
        output: 3.96,
        cacheRead: 0.044,
        cacheWrite: 0,
      }),
    ],
  };
}

/**
 * 挑第一个存在的本地 provider 配置文件（读旧写新，顺序见 loadExtraProviders 里那段注释）。
 *
 * 单独一个函数是为了能单测"迁移完之后到底读的是哪一份" —— 这件事出过错：
 * 提示说 migrate 会复制，而读取只认安装目录，等于复制了没人读。
 *
 * @param {{dataDir?:string, pkgRoot?:string}} cfg
 * @returns {string|null}
 */
export function pickLocalConfigFile(cfg = {}) {
  const NEW = 'orbis.config.json';
  const OLD = 'pi-bot.config.json';
  const dirs = [cfg.dataDir, cfg.pkgRoot].filter(Boolean);
  // ★ 顺序是**目录优先**：每个目录里先新名再旧名，然后才去下一个目录。
  //   反过来（所有目录的新名都排在旧名前）会得到一个很怪的结果：
  //   用户目录里明明有（更近的）旧名配置，却被安装目录里那份远的新名压住。
  //   优先级本意是"用户覆盖部署方"。
  for (const dir of dirs) {
    const file = path.join(dir, NEW);
    if (fs.existsSync(file)) return file;
    const legacy = path.join(dir, OLD);
    if (!fs.existsSync(legacy)) continue;
    noticeBrandDeprecation({
      kind: 'file',
      from: OLD,
      to: NEW,
      hint: '把文件改成新名字即可（内容不用动）；`orbis migrate` 会顺带复制一份',
    });
    return legacy;
  }
  return null;
}

/** 返回 { providerId: ProviderConfigInput } */
export function loadExtraProviders({
  config: cfg = defaultConfig,
  modelGroups: mg = defaultModelGroups,
  agentDir = null,
  includeHost = true,
} = {}) {
  const out = {};
  const resolvedAgentDir = agentDir || defaultAgentDir();

  if (includeHost !== false) {
    // 1) 部署方自带的 provider 配置
    //
    // 查找顺序（先用户目录、后安装目录 —— 用户的覆盖部署方的）：
    //   <dataDir>/orbis.config.json → <dataDir>/pi-bot.config.json
    //   → <pkgRoot>/orbis.config.json → <pkgRoot>/pi-bot.config.json
    //
    // ★ 为什么 dataDir 排前面：`orbis migrate` 把旧配置复制成
    //   `<dataDir>/orbis.config.json`，只看 pkgRoot 的话等于"搬过来了却不认"。
    //   安装目录那份留给"部署方预置"。
    const localFile = pickLocalConfigFile(cfg);
    const local = localFile ? readJson(localFile, null) : null;
    if (local?.providers && typeof local.providers === 'object') {
      Object.assign(out, local.providers);
      log(`📦 从 ${path.basename(localFile)} 载入 ${Object.keys(local.providers).length} 个 provider`);
    }

    // 2) 自动导入 cline 扩展的 key（没被 1) 覆盖时）
    const clineCfg = readJson(path.join(resolvedAgentDir, 'cline-provider', 'config.json'), null);
    if (!out.cline && clineCfg?.apiKey) {
      out.cline = clineProviderConfig(clineCfg);
      log('📦 自动导入 cline 扩展的 ClinePass provider');
    }

    // 2.5) 把本机 cline 那套带成一个「正在用」的模型组（App 里能看见、不可删）
    if (clineCfg?.apiKey) {
      const p = clineProviderConfig(clineCfg);
      mg.seedBuiltin({
        id: 'local_cline',
        name: '本机 cline（正在用）',
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        api: p.api,
        models: p.models.map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        })),
      });
    }
  }

  // 3) 用户在设置里自己加的模型组（优先级最低 —— 前面两种是"部署方"配的，
  //    这一种是"使用者"配的，同名时让前者说了算）
  const custom = mg.toProviderConfigs();
  for (const [id, pcfg] of Object.entries(custom)) {
    if (!out[id]) out[id] = pcfg;
  }
  if (Object.keys(custom).length) {
    log(`📦 载入 ${Object.keys(custom).length} 个自定义模型组`);
  }

  return out;
}

/** pi settings.json 里用户选的默认模型 */
export function settingsDefaultModel({ agentDir = null, includeHost = true } = {}) {
  if (includeHost === false) return null;
  const resolvedAgentDir = agentDir || defaultAgentDir();
  const settings = readJson(path.join(resolvedAgentDir, 'settings.json'), null);
  return settings?.defaultModel ?? null;
}
