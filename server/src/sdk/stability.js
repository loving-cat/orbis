/**
 * SDK 导出的**稳定档位**（路线图 §4 T2.9）。单一事实源。
 *
 * 三档的含义见 `docs/SDK-STABILITY.md`，一句话：
 *   · `stable`   —— 承诺不破坏：改名/改语义要「一版弃用、一版删除」；
 *   · `beta`     —— 会在 minor 里动，但一定写 CHANGELOG 并给迁移说明；
 *   · `internal` —— 随时可改，宿主不该用（兼容别名、派生层、内部构件）。
 *
 * ★ 为什么要有这张表：`sdk-contract.snapshot.json` 会把每个导出的档位一起锁定，
 *   于是"加了个导出但没想清楚算哪档"会在 CI 上红 —— 默认值 `internal` 只是
 *   兜底，**新增导出必须显式出现在这张表里**（`tests/sdk-contract.mjs` 会查）。
 *
 * ★ 改档位 = 改契约：往下降（stable → internal）必须走弃用流程，
 *   往上升（internal → stable）没有成本，但也得在快照里留下记录。
 */

/** 允许的档位 */
export const STABILITY_LEVELS = Object.freeze(['stable', 'beta', 'internal']);

/**
 * 导出名 → 档位。
 *
 * 按名字而不是按入口：同一个名字在 `.` / `/sdk` / `/capabilities` 里必须是同一档，
 * 否则"从哪个入口 import"会变成语义差异，那是没人能记住的坑。
 */
export const SDK_STABILITY = Object.freeze({
  // ---------------------------------------------------------------- stable
  /** 起一个 runtime：整个 SDK 的主入口 */
  createOrbisRuntime: 'stable',
  /** 连一个已经在跑的服务端 */
  createOrbisClient: 'stable',
  /** 定义工具（宿主扩展能力的唯一正路） */
  defineTool: 'stable',
  /** typebox 的 schema 构造器；`defineTool` 的 parameters 要它 */
  Type: 'stable',
  /** 错误契约：类型 + 枚举 + 三个翻译函数 */
  OrbisError: 'stable',
  ORBIS_ERROR_CODES: 'stable',
  orbisError: 'stable',
  isOrbisError: 'stable',
  asOrbisError: 'stable',
  /** 品牌常量（界面上拿它显示名字，不从字符串里抄） */
  BRAND_NAME: 'stable',
  BRAND_SLUG: 'stable',

  // ---------------------------------------------------------------- beta
  /** 低阶构件：能自己拼一套 runtime，但参数会比 `createOrbisRuntime` 更常动 */
  createConfig: 'beta',
  createBus: 'beta',
  createStore: 'beta',
  createModelGroupStore: 'beta',
  /** client 的类本体（宿主一般用工厂函数，直接 new 的人少） */
  OrbisClient: 'beta',
  /** 能力清单：结构会随能力增加而变，宿主应只用 `TOOL_SPECS` / `auditCapabilities` 这类查询 */
  ACTIONS: 'beta',
  ACTION: 'beta',
  TOOL_SPECS: 'beta',
  auditCapabilities: 'beta',

  // ---------------------------------------------------------------- internal
  /** 兼容别名（Phase 3 清债时删）：留着是为了 1.7 的宿主不炸，不是给新代码用的 */
  createPiBotRuntime: 'internal',
  createPiBotClient: 'internal',
  PiBotClient: 'internal',
  /** 服务层的装配入口：签名随内部服务调整 */
  createServices: 'internal',
  /** `/capabilities` 入口的派生层：由 `capabilities.js` 自动算出，宿主不该硬编码 */
  CHIEF_ONLY_ACTIONS: 'internal',
  CHIEF_ONLY_TOOLS: 'internal',
  COORDINATION_TOOLS: 'internal',
  GATED_ACTIONS: 'internal',
  LEAD_EXTRA_BUILTINS: 'internal',
  MIGRATION_WITHHELD: 'internal',
  MUTATING_TOOLS: 'internal',
  OPAQUE_SCRIPT_TOOLS: 'internal',
  READONLY_ALLOW: 'internal',
  SECOND_FACTOR_TOOLS: 'internal',
  SECURITY_CONFIG_TOOLS: 'internal',
  TOOLS: 'internal',
  actionForTool: 'internal',
  actionInfo: 'internal',
  actionsForTools: 'internal',
  deriveMigrationActions: 'internal',
  isIrreversible: 'internal',
  isJarvisApprovalCall: 'internal',
  migrationScopeOf: 'internal',
  needsSecondFactor: 'internal',
  needsTarget: 'internal',
  riskOf: 'internal',
  snapshotEvidence: 'internal',
  targetsForTool: 'internal',
});

/**
 * 查某个导出的档位。没登记的按 `internal` 算（fail-closed：宁可比实际承诺少，
 * 也不要让没想清楚的导出被当成 stable 用起来）。
 */
export function stabilityOf(name) {
  const tier = SDK_STABILITY[name];
  return STABILITY_LEVELS.includes(tier) ? tier : 'internal';
}

/** 内省用：哪些导出还没登记档位（契约测试拿它报错） */
export function missingStability(names) {
  return [...names].filter((name) => SDK_STABILITY[name] === undefined).sort();
}
