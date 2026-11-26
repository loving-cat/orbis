/**
 * 建会话（执行层）：把一个 bot 在某房间里"跑起来"需要的全部准备工作。
 *
 * 这里最容易出错的地方不是代码复杂，而是**配置的来路**：
 * 模型来自用户自己配的模型组、工具集受部门规矩限制、上下文预算三层回退、
 * 系统提示跟着用户名和规矩走 —— 任何一条接错，表现都是"跑不起来"或"跑错东西"，
 * 而且很难从界面看出来。
 *
 * 会话池（缓存、pending 去重、LRU 驱逐）留在 runner 里：那是"怎么复用"，
 * 这里是"怎么造出来"。造完交回去。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createBashTool,
  createPowerShellTool,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { config as defaultConfig, resourceOptions } from './config.js';
import { readBrandEnv } from './brand.js';
import { store as defaultStore } from './store.js';
import { preferencesPromptLines } from './preferences.js';
import { isDelegatingLead, isRoomLead, isReadonlyPolicy, readonlyToolAllowed, toolsForRole, customToolsForRole, roleConfigurationKey } from './role-tools.js';
import { executionModeOf } from './exec-mode.js';
import { applyCompactionBudget, withCapacity } from './context-budget.js';
import { buildAppendSystemPrompt } from './system-prompt.js';
import { buildSandboxedShellTools, setMcpCounter, setSandboxProbe } from './sandboxed-shell.js';
import { probeSandbox } from './sandbox.js';
import { buildChiefTools, buildCommonTools } from './tools.js';
import { buildIntakeTools, intakeEnabled } from './coordination/intake-tool.js';
import { buildReportTool } from './tasks/task-report-tool.js';
import { buildMemberTaskTool, buildCheckpointApproveTool } from './tasks/task-member-tool.js';
import { buildPlanTool } from './tasks/task-plan-tool.js';
import { buildBlackboardTool } from './tasks/task-blackboard-tool.js';
import { buildGitTools } from './git-tools.js';
import { buildExpertReviewTool } from './tasks/task-expert-tool.js';
import { buildTaskInsightTools } from './coordination/task-insight-tool.js';
import { createPolicyExtension } from './policy-hook.js';
import { createMcpExtension, mcpSectionForPrompt } from './mcp-hook.js';
import { capabilityGuideForPrompt } from './mcp-capability.js';
import { log } from './util.js';
import { menuEntries } from './model-menu.js';
import { modelCatalogSection } from './model-dispatch.js';

/**
 * 这个 bot 用哪个模型、哪个思考档位。
 *
 * 纯函数：把"挑了谁"的判断从建会话那一大坨里拎出来，好单测。
 *   · 没单独设模型 → 用全局默认
 *   · 这个模型的这个档位**已知会吐空**（档位矩阵探出来的）→ 换一个能用的
 */
export function pickModelAndThinking({
  bot = {},
  botModel = null,
  fallbackModel = null,
  safeLevel = null,
  modelLabel = '',
} = {}) {
  const model = botModel ?? fallbackModel ?? null;
  let thinking = bot.thinking || null;
  if (thinking && safeLevel) {
    const slug = botModel ? `${botModel.provider}/${botModel.id}` : modelLabel;
    thinking = safeLevel(slug, thinking) ?? thinking;
  }
  return { model, thinking };
}

/**
 * @param {object} deps
 * @param {object} deps.runner      PiRunner 实例（工具要回调它，比如发图 / 派活）
 * @param {object} deps.health      模型探活（档位安全值）
 * @param {(slug:string)=>any} deps.resolveModel
 * @param {()=>string} deps.modelLabel
 * @param {object} [deps.sessionApi] 会话SDK适配器，默认使用生产实现。
 */
export function createSessionBuilder({
  runner, health, resolveModel, modelLabel,
  config: scopedConfig = null,
  store: scopedStore = null,
  bus: scopedBus = null,
  /** 宿主提供的资源加载器工厂（T2.3）：`(defaults) => loader`；不传就取 runner 上的 */
  resourceLoaderFactory: loaderFactoryArg = null,
  /** 宿主追加的工具对象（defineTool 产出）；挂在角色工具之后 */
  extraCustomTools: extraToolsArg = null,
  /** 宿主追加启用名的内置工具；去重后并进启用清单 */
  extraToolNames: extraToolNamesArg = null,
  sessionApi = {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    createBashTool,
    createPowerShellTool,
    getAgentDir,
  },
}) {
  const config = scopedConfig ?? runner?.config ?? defaultConfig;
  const store = scopedStore ?? runner?.store ?? defaultStore;
  const bus = scopedBus ?? runner?.bus ?? null;
  const {
    DefaultResourceLoader,
    SessionManager,
    createAgentSession,
    createBashTool,
    createPowerShellTool,
    getAgentDir,
  } = sessionApi;

  // ★ T2.3：注入点从**参数**或 **runner** 上取（两个建会话的地方都只传 runner，
  //   免得两处各抄一遍展开、慢慢长歪）。参数优先，方便单测直接指定。
  const resourceLoaderFactory = loaderFactoryArg ?? runner?.resourceLoaderFactory ?? null;
  const extraCustomTools = extraToolsArg ?? runner?.extraCustomTools ?? [];
  const extraToolNames = extraToolNamesArg ?? runner?.extraToolNames ?? [];

  // 注入依赖（不用模块顶层 import，避免 store ↔ session-factory 循环依赖）
  setSandboxProbe(probeSandbox);
  setMcpCounter((botId) => {
    try { return store.mcpServersFor(botId).length; } catch { return 0; }
  });

  /**
   * 建一个会话。
   *
   * @param {string} roomId
   * @param {string} botId
   * @param {{reportTool?: boolean}} [opts]
   *   `reportTool`：这次会话要不要带受管阶段报告工具。
   *   只有受管执行才需要 —— 普通调用拿到它也没有消费者。
   */
  /**
   * 把用户覆盖盖到 bot 记录上（只碰白名单字段）。
   *
   * 为什么要单独一个函数：这是**唯一**允许"覆盖影响行为"的地方。
   * 散在别处就会出现"我以为改了人设、其实没生效"或者反过来的情况。
   */
  function applyBotOverride(bot, override) {
    if (!override || !override.values) return bot;
    const merged = { ...bot };
    for (const [key, value] of Object.entries(override.values)) {
      if (value === undefined || value === null) continue;
      merged[key] = value;
    }
    return merged;
  }

  return async function buildSession(roomId, botId, opts = {}) {
    const isTalkLane = opts.talkLane === true;
    /**
     * 独立评审（Critic）通道。
     *
     * 与全双工旁路 Talk 用同一套隔离思路，但更严：
     *   · 纯内存会话（`SessionManager.inMemory`）：不落盘、不碰执行者的 JSONL；
     *   · 只给四个只读查阅工具（read/ls/find/grep）：没有写、没有 shell、没有 git 写、
     *     没有 MCP、没有宿主 customTools；
     *   · 策略层 `dangerous: 'deny'` 兜底（与 Talk 一样过 policy-hook）。
     * 为什仇不能复用执行者的会话：只要历史里有它自己写的产物与自我解释，
     * “独立评审”就退化成“复述执行者的话”。
     */
    const isCriticLane = opts.criticLane === true;
    /** 两条隔离通道共用的“只读 + 纯内存”开关。 */
    const isolatedLane = isTalkLane || isCriticLane;
    const wantsReportTool = !isolatedLane && opts.reportTool === true;
    const stored = store.getBot(botId);
    if (!stored) throw new Error(`找不到 bot ${botId}`);

    // ★ 用户自定义覆盖（规格 §13.1 第②层）：人设/模型/技能这些"软配置"
    //   在**用的时候**合成，不在存的时候合并。
    //
    //   这样模板升级只改模板，用户改过的东西还在；而且"这个值是谁定的"
    //   随时查得到（`sources`）。合并进 bot 记录会让两件事都做不到。
    //
    //   注意覆盖**只允许白名单字段**（见 overrides.js），所以这里不可能被
    //   用来改 mcpServers / role 这类能扩权的字段。
    const bot = applyBotOverride(stored, store.botOverride(botId));

    // ★ 一次性回退会话（SPEC-PERF-V1 §4.2 d）：指定别的模型、且**不落盘**。
    //   跨 provider 绝不能复用原会话文件（等于把 A 家的 tool-call 历史喂给 B 家），
    //   所以这里只能走内存会话；`bot.model` 一个字节都不改。
    const modelOverride = opts.modelOverride ? resolveModel(opts.modelOverride) : null;
    const persistSession = opts.persist !== false;
    const sessionDir = path.join(config.dataDir, 'sessions');
    // ★ 内存模式（T2.3）：store 说了不落盘，会话文件也不能偷偷开一个。
    //   否则“传内存 store 时零磁盘写入”只在 mock 的 SessionManager 下成立 ——
    //   真实运行时会先 create 出 `sessions/<room>-<bot>.json`，再写 transcript。
    const inMemorySession = isolatedLane || store.memory === true || !persistSession;
    const savedFile = inMemorySession ? null : store.sessionFileFor(roomId, botId);
    // 旁路 Talk / 内存模式会话强制纯内存隔离，绝不与后台 Work 并发读写同一磁盘会话文件
    const sessionManager = inMemorySession
      ? (typeof SessionManager.inMemory === 'function'
          ? SessionManager.inMemory(config.workspace)
          : {})
      : (savedFile && fs.existsSync(savedFile)
          ? SessionManager.open(savedFile)
          : SessionManager.create(config.workspace, sessionDir));

    const isChief = bot.role === 'main';
    const room = store.getRoom(roomId);
    const isDeptLead = isDelegatingLead(room, bot);
    const policy = store.policy();
    const effectivePolicy = isolatedLane ? { ...policy, dangerous: 'deny' } : policy;
    const roleKey = roleConfigurationKey(room, bot);
    // isMain 决定要不要给 ask_user（主控不给 —— 它直接跟用户对话，不弹卡片）
    const commonTools = buildCommonTools({ runner, roomId, botId, isMain: isChief, store, config, bus });
    // ★ 受管阶段报告工具：真的注册进 SDK，模型才能调用。
    //   收集器由 runner 按「房间:Bot」挂，工具 execute 时取当前那个。
    const reportTools = wantsReportTool
      ? [buildReportTool({ collect: (input) => runner.collectReport?.(roomId, botId, input) })]
      : [];
    // 负责人派活工具：只有受管执行时注册，成员用不了（执行体里再核一次）
    // ★ 负责人先列计划、再按计划派活。
    //   正常团队是「先有分工方案，再照着分发」；没有计划的派活是
    //   一次性的，出了偏差没人知道该对齐到哪里。
    const memberTools = wantsReportTool && isDeptLead
      ? [
        buildPlanTool({ runner, store, roomId, botId }),
        buildMemberTaskTool({ runner, store, roomId, botId }),
        // ★ 放行 checkpoint：只有本部门负责人能调（工具内部再核一次真实角色）
        buildCheckpointApproveTool({ runner, store, roomId, botId }),
      ]
      : [];
    // ★ 共享黑板：**负责人与成员都要能用** ——
    //   约束/决定往往是无意中发现的（"这列日期是 UTC"），只给负责人等于丢一半。
    //   写入的根任务由受管上下文决定，成员跨任务写不进去。
    const blackboardTools = wantsReportTool
      ? [buildBlackboardTool({ runner, store, roomId, botId })]
      : [];
    // 验收能力与派工能力分开：单成员部门仍可有真实负责人做专业验收，只是不能派工。
    const expertTools = wantsReportTool && isRoomLead(room, botId)
      ? [buildExpertReviewTool({ runner, store, roomId, botId })]
      : [];

    // ★ Git：负责人对自己的任务有 git 权限（用户 2026-11-14 的产品要求），
    //   主控也有（它在根目录调度整机）。执行 Bot 不给 ——
    //   规格 §5.3「执行 Bot 不能自批、转授或修改策略」，
    //   而提交是"把改动落成事实"，那一步该由负责人核对后做。
    //
    //   能力边界在 git-ops.js 的白名单里（只有 status/diff/log/show/branches/add/commit），
    //   push/merge/reset/clean 在那张表里根本没有。
    const gitTools = !isolatedLane && (isChief || isDeptLead)
      ? buildGitTools({ runner, store, roomId, botId, config })
      : [];

    // ★ 接单与任务进度工具：结合宿主实例开关决定是否注册（SDK 轻量模式默认关）。
    const intakeOn = Boolean(runner?.taskIntakeEnabled ?? intakeEnabled());
    const intakeTools =
      !isolatedLane && isChief && intakeOn
        ? buildIntakeTools({
            runner, store, roomId, botId, health,
            requestScopeOf: () => runner.currentRequestScope?.(roomId, botId) ?? null,
          })
        : [];

    // 自然进度/改版：主控在本轮理解里读任务权威状态或沿原任务升版。
    const insightTools = !isolatedLane && isChief && intakeOn
      ? buildTaskInsightTools({ runner, store, roomId, botId })
      : [];

    const modelGroups = runner?.modelGroups ?? null;
    const roleCustomTools = isolatedLane
      ? []
      : customToolsForRole([
          ...commonTools,
          ...reportTools,
          ...memberTools,
          ...blackboardTools,
          ...expertTools,
          ...gitTools,
          ...intakeTools,
          ...insightTools,
          ...(isChief ? buildChiefTools({ runner, health, roomId, botId, store, config, bus, modelGroups }) : []),
          // 宿主追加的工具要**过同一道** role 过滤：否则往一个只读角色的会话里
          // 塞一个写工具，就是绕开了策略层
          ...extraCustomTools,
        ], { room, bot, policy });
    const customTools = roleCustomTools;


    // 角色能力与行为策略共同决定内置工具；旁路 Talk 仅保留只读查阅能力。
    const rawBaseTools = toolsForRole({
      isChief,
      isDeptLead,
      chiefTools: config.chiefTools,
      leadTools: config.leadTools,
      memberTools: config.tools,
      policy: effectivePolicy,
    });
    // ★ 宿主追加的启用名也要过 policy：只读会话里凭空多出 bash 就是绕过策略。
    //   角色白名单不管（那是“默认给什么”，宿主显式点名就是“我确实要这个”）。
    const hostToolNames = isReadonlyPolicy(effectivePolicy)
      ? extraToolNames.filter((name) => readonlyToolAllowed(name))
      : extraToolNames;
    const baseTools = isolatedLane
      ? rawBaseTools.filter((t) => ['read', 'ls', 'find', 'grep'].includes(t))
      : [...rawBaseTools, ...hostToolNames.filter((name) => !rawBaseTools.includes(name))];

    // 隔离通道不起沙箱 shell 工具，避免任何命令执行开销
    const shellTools = isolatedLane
      ? []
      : buildSandboxedShellTools({
          bot,
          workDir: config.workspace,
          dataDir: config.dataDir,
          tools: baseTools,
          mcpCount: store.mcpServersFor(botId).length,
          config,
          pi: { createBashTool, createPowerShellTool },
        });

    // ★ 执行模式（规格 §8）—— **必须在这里算**，因为只有这里知道
    //   命令工具到底换没换成沙箱版。算晚了（或者干脆不传）就变成
    //   “授权上写了 mode、运行时根本不看”，§8 整节形同虚设。
    const execMode = executionModeOf({ bot, sandboxedToolNames: shellTools.map((t) => t.name) });

    const baseAppendPrompt = buildAppendSystemPrompt(bot, {
      userName: store.userName(),
      // ★ 用户的习惯（规格 spec-intent-and-habits-v1.md §3）：只放 strong、最多 5 条。
      preferenceLines: preferencesPromptLines(store.preferences()),
      // 部门规矩跟着会话走：工具集和提示都是建会话时定的，规矩变了会作废重建
      policy: effectivePolicy,
      // MCP 清单只给主控：它要知道有哪些能力可以派给成员。
      mcpLines: !isolatedLane && isChief
        ? [mcpSectionForPrompt({ store }), capabilityGuideForPrompt(store.mcpLibrary())]
            .filter(Boolean)
            .join('\n\n')
        : '',

      modelLines: !isolatedLane && isChief ? modelCatalogSection(menuEntries(modelGroups ?? undefined), health) : '',
    });

    const talkAppendPrompt = isTalkLane
      ? `${baseAppendPrompt}\n\n## 全双工快速旁路通道规则\n` +
        '当前处于「边干活边回话」的旁路只读通道：后台工作会话仍在继续执行，' +
        '请直接结合实时工作台快照与上下文，用 1～4 句自然口吻快速回答用户问题或确认已记下补充要求；' +
        '禁止在当前旁路里声称执行了写文件、跑命令或改任务状态，也不要生硬复述快照格式。'
      : baseAppendPrompt;

    /**
     * 独立评审（Critic）的附加规则。
     *
     * ★ 这里必须把「不许信自述、必须自己读文件」写死：评审员的上下文里
     *   本来就只有任务目标与产物路径，但它仍然可能根据经验“推测”文件内容。
     *   同时告知它只有只读工具 —— 它就不会把力气花在“想写个脚本验证”上。
     */
    const criticAppendPrompt = isCriticLane
      ? `${baseAppendPrompt}\n\n## 独立评审（Critic）通道规则\n` +
        '你是一个**只读**的独立评审员，不参与执行，也不能修改任何东西。' +
        '你只有 read / ls / find / grep 四个工具：要看结论就亲自打开产物，' +
        '不要根据路径名、执行者的自述或自己的想象猜测内容。' +
        '评审只看两件事：任务目标与验收条件是否真的达到，以及全组黑板上约束/决定有没有被违反。' +
        '结论必须按要求的 JSON 对象输出，不得附加解释文字。'
      : talkAppendPrompt;

    /**
     * 资源加载器的全套默认参数（老代码就是直接内联传的）。
     *
     * ★ T2.3 注入点：拆成变量是为了让 `resourceLoaderFactory` 拿到**一模一样的参数**
     *   再决定怎么造。宿主常见的两种用法：
     *   · `(d) => new MyLoader({ ...d, additionalSkillPaths: [...] })` —— 只是加料；
     *   · `(d) => fakeLoader` —— 测试里彻底不读盘（reload 仍然会被调用）。
     */
    const loaderDefaults = {
      cwd: config.workspace,
      agentDir: getAgentDir(),
      // 旁路 Talk 不挂载 MCP，保留策略钩子兜底只读
      extensionFactories: [
        createPolicyExtension({
          roomId,
          bot,
          grantGate: runner.grantGate ?? null,
          mode: execMode,
          talkLane: isolatedLane,
          config,
          store,
          bus,
          managedContextOf: () => runner.currentTaskContext?.(roomId, bot.id) ?? null,
          onBlocked: (approval, info) => runner.notePolicyBlocked?.(roomId, bot.id, approval, info),
        }),
        ...(isolatedLane ? [] : [createMcpExtension({ botId, roomId, store })]),
      ],
      extensionsOverride: (base) => {
        const needles = (readBrandEnv(process.env, 'DISABLED_EXTENSIONS') ?? 'context-mode')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        if (!needles.length) return base;
        return {
          ...base,
          extensions: base.extensions.filter((ext) => {
            const where = `${ext.path ?? ''} ${ext.resolvedPath ?? ''}`;
            return !needles.some((needle) => where.includes(needle));
          }),
        };
      },
      appendSystemPrompt: criticAppendPrompt,
      ...resourceOptions,
      ...(isolatedLane || isDeptLead || isReadonlyPolicy(effectivePolicy)
        ? { noExtensions: true, noMcp: true }
        : {}),
    };

    const resourceLoader = typeof resourceLoaderFactory === 'function'
      ? await resourceLoaderFactory(loaderDefaults)
      : new DefaultResourceLoader(loaderDefaults);
    await resourceLoader.reload();

    const botModel = modelOverride ?? (bot.model ? resolveModel(bot.model) : null);
    const picked = pickModelAndThinking({
      bot,
      botModel,
      fallbackModel: runner.model,
      safeLevel: (slug, level) => health?.safeLevel(slug, level),
      modelLabel: modelLabel(),
    });
    if (isTalkLane && picked.thinking && picked.thinking !== 'off') {
      const talkThinking = String(readBrandEnv(process.env, 'TALK_THINKING') ?? 'low').trim();
      if (talkThinking) picked.thinking = talkThinking;
    }

    const options = {
      cwd: config.workspace,
      sessionManager,
      resourceLoader,
      // 沙箱版 shell 工具与内置同名，放在后面即可覆盖
      tools: [...baseTools, ...customTools.map((t) => t.name), ...shellTools.map((t) => t.name)],
      customTools: [...customTools, ...shellTools],
      // ★★★ 把 runner 的 model runtime 传进去。
      modelRuntime: runner.modelRuntime,
    };
    // 容量覆盖：bot 上设过的 contextWindow / maxTokens 盖在模型自带值之上
    if (picked.model) options.model = withCapacity(picked.model, bot);
    if (picked.thinking) options.thinkingLevel = picked.thinking;

    const { session, modelFallbackMessage } = await createAgentSession(options);
    if (modelFallbackMessage) log(`[${bot.name}] 模型回退：${modelFallbackMessage}`);

    applyCompactionBudget(session, bot);

    if (!isolatedLane && session.sessionFile && session.sessionFile !== savedFile) {
      store.setSessionFile(roomId, botId, session.sessionFile);
    }
    log(
      `${isCriticLane ? '[critic] ' : isTalkLane ? '[talk] ' : ''}会话就绪 ${roomId} · ${bot.emoji ?? ''}${bot.name} → ` +
        `${path.basename(session.sessionFile ?? '(内存)')}`,
    );
    return {
      session,
      bot,
      configurationCurrent: () => roleKey ===
        roleConfigurationKey(store.getRoom(roomId), store.getBot(botId)),
    };
  };
}
