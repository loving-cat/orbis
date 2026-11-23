/**
 * Orbis server 配置。
 *
 * 全部可用 `ORBIS_*` 环境变量覆盖；默认使用平台对应的用户数据目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAND_NAME, noticeBrandDeprecation, readBrandEnv } from './brand.js';
import {
  NEEDS_MIGRATION_MARKER, migrateLegacyData, migratedWorkspace, repairSessionRefs, SERVER_BOOT,
} from './data-migration.js';

const pkgRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * `createConfig()` 产出的对象上的不可枚举标记（T2.3 注入点）。
 *
 * ★ 为什么需要它：`createOrbisRuntime({ config })` 要能区分两种传法 ——
 *   · `{ dataDir, userName }` 这种**字段覆盖**（1.0 起的老行为，不能变）；
 *   · `createConfig({...})` 出来的**整份配置**（宿主自己算好再交进来）。
 *   两者都是普通对象，靠形状猜必然猜错（覆盖对象也可能正好带 dataDir）。
 *   用 `Symbol.for` 是为了跨包副本也认（宿主和 server 各自 `npm i` 时 Symbol 仍相等）。
 */
export const CONFIG_BRAND = Symbol.for('orbis.config');

/** 这个值是不是 `createConfig()` 产出的一整份配置 */
export function isConfigObject(value) {
  return Boolean(value && typeof value === 'object' && value[CONFIG_BRAND] === true);
}

/**
 * 用户数据目录：与安装位置无关，重装/换目录不影响数据。
 *
 * Windows 为 %LOCALAPPDATA%\Orbis\data，macOS 为
 * ~/Library/Application Support/Orbis/data，Linux 为
 * $XDG_DATA_HOME/Orbis/data。
 */
// 目录名与平台根的纯规则在 user-dirs.js（那边没有副作用，migrate 命令也用同一份）
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, userDataBaseDir } from './user-dirs.js';

/**
 * 选一个目录名：`orbis` 优先；2.0 起不再沿用 1.7 的旧目录 ——
 * 发现旧数据时由启动护栏给出 `orbis migrate` 指引（见 noticeLegacyDataIfAny）。
 *
 * ★ 为什么不自动迁移：迁移一旦半途失败（磁盘满、权限、进程被结束），
 *   用户看到的是“我的聊天记录全没了”。沿用旧目录零风险，想换的用户
 *   可以手动搬（见 docs/WINDOWS.md 的升级说明）。
 *
 * 命中旧目录时发一次弃用提醒（1.7.1）：不提醒的话，用户到 2.0 才会
 * 发现程序突然不看旧目录了。
 */
export function resolveHomeDir(base) {
  // ★ 2.0（C2）：**不再回退旧目录**。旧目录有数据时由启动护栏
  //   （`noticeLegacyDataIfAny`）大声给出 `orbis migrate` 指引，
  //   而不是让服务端悄悄读旧目录、或者悄悄建一个空库。
  return path.join(base, HOME_DIR_NAME);
}

/**
 * 启动护栏：旧数据目录里有真数据、而新目录还没有 → **大声**给出 `orbis migrate` 指引。
 *
 * 2.0 删掉了旧目录回退（C2）。没有这条护栏，从 1.7 升上来的用户会看到一个
 * **空的家**：聊天记录、任务、证书全"消失"，而服务端还会很配合地建出一套新空库 ——
 * 那是最坏的一种失败：不报错，用户以为数据没了。
 *
 * 三条要求：
 *   · **绝不静默**：日志里两条真实路径 + 一行可复制执行的命令；
 *   · **不阻止启动**：全新安装/故意换目录的人不该被挡在门外；
 *   · 顺带落一个 `.needs-migration.json`，界面（/health）与诊断脚本能据此提示。
 *
 * @param {{home:string, log?:(m:string)=>void}} opts `home` = 本次要用的数据目录
 * @returns {string|null} 发现旧数据时返回旧目录路径（否则 null）
 */
export function noticeLegacyDataIfAny({ home, base = userDataBaseDir(), log = () => {} } = {}) {
  try {
    const legacyDir = path.join(base, LEGACY_HOME_DIR_NAME, 'data');
    if (!fs.existsSync(path.join(legacyDir, 'state.json'))) return null;
    if (fs.existsSync(path.join(home, 'state.json'))) return null;
    log([
      '',
      '[Orbis] ⚠️  发现 1.7 的数据，但新目录里还没有：',
      `          旧：${legacyDir}`,
      `          新：${home}`,
      '        2.0 不再自动读旧目录。请先停掉服务端，然后运行：',
      `          orbis migrate --from "${legacyDir}" --to "${home}"`,
      '        （只复制、不删除；旧目录原样保留，确认没问题后再自己删）',
      '',
    ].join(os.EOL));
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, NEEDS_MIGRATION_MARKER),
        JSON.stringify({ from: legacyDir, to: home, at: new Date().toISOString() }, null, 2),
      );
    } catch { /* 标记写不进去不影响主流程，日志已经给过了 */ }
    return legacyDir;
  } catch {
    return null;
  }
}

function userDataDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(resolveHomeDir(process.env.LOCALAPPDATA), 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(resolveHomeDir(path.join(os.homedir(), 'Library', 'Application Support')), 'data');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(resolveHomeDir(base), 'data');
}

/**
 * 构造实例级配置（无模块级全局副作用，供 SDK / 多实例宿主使用）。
 *
 * `dataDir` / `workspace` 优先取显式入参，否则读 `env` 或平台用户数据目录。
 * 只有显式传 `serverBoot: true` 且未指定 `dataDir` 时才做旧目录迁移与修复。
 */
export function createConfig(overrides = {}) {
  const {
    env = process.env,
    serverBoot = false,
    ensureDirs = true,
    home: overrideHome,
    dataDir: overrideDataDir,
    workspace: overrideWorkspace,
    ...scalarOverrides
  } = overrides;

  /** 本次启动是否执行了数据迁移（未迁移为 null） */
  let migratedFrom = null;

  const home = overrideDataDir
    ? path.resolve(overrideDataDir)
    : overrideHome
      ? path.resolve(overrideHome)
      : readBrandEnv(env, 'HOME')
        ? path.resolve(readBrandEnv(env, 'HOME'))
        : userDataDir();

  // ⇩ 必须在 store 读 state.json 之前跑（store 在它自己的模块加载时就读）。
  //   迁移和修复都只是文件操作，失败不能挡住启动。
  //
  // ★ 只在「真的要起服务端」且未覆盖 dataDir 时动数据：
  //   index.js 在导入 server-main 之前调用 markServerBoot()。
  //   否则任何 import 了 config 的脚本（诊断、维护、一次性检查）都会改写用户的 state.json。
  //   用进程内的标记而不是环境变量：ORBIS_* / PI_BOT_* 会被子进程继承（见 child-env.js）， —— legacy-guard-ok: 讲为什么不用环境变量
  //   bot 的 shell 里再跑一个导入 config 的脚本也会触发。
  /** 旧数据目录里发现真实数据、但新目录还没有（启动护栏会大声提示） */
  let legacyDataDir = null;
  const warn = (msg) => console.warn(msg);
  if (serverBoot === true && !overrideDataDir) {
    try {
      // ★ 只有“没显式指定 ORBIS_HOME”时才算“默认安装位置”：
      //   用户自己指了一个目录（多实例 / 诊断 / 容器）时，旧目录跟这次启动**无关** ——
      //   提示他去迁移、甚至往那个 home 写 `.needs-migration.json`，都是误伤。
      if (!readBrandEnv(env, 'HOME')) {
        const legacy = path.join(pkgRoot, 'data');
        if (migrateLegacyData({ legacy, target: home, log: warn }).migrated) migratedFrom = legacy;
        legacyDataDir = noticeLegacyDataIfAny({ home, log: warn });
      }
      // state.json 里指向数据目录之外的会话文件，每次启动改回 <数据目录>/sessions。
      repairSessionRefs({ dataDir: home, log: warn });
    } catch (err) {
      console.warn('[config] 数据迁移/修复失败（继续启动，旧目录未动）：', err?.message || err);
    }
  }

  const dataDir = home;
  // 优先级：显式入参 > 环境变量 > 迁移时记下的旧工作目录（没复制，继续用）> <数据目录>/workspace
  const wsEnv = readBrandEnv(env, 'WORKSPACE');
  const workspace = overrideWorkspace
    ? path.resolve(overrideWorkspace)
    : wsEnv
      ? path.resolve(wsEnv)
      : (migratedWorkspace(home, { log: warn }) ?? path.join(home, 'workspace'));

  if (ensureDirs !== false) {
    for (const dir of [home, dataDir, workspace, path.join(dataDir, 'rooms'), path.join(dataDir, 'sessions')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const tools = (readBrandEnv(env, 'TOOLS') || 'read,write,edit,ls,find,grep,bash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const built = {
    // 服务进程实例：客户端用它隔离旧连接/旧服务回包
    serverInstanceId: randomUUID(),
    pkgRoot,
    home,
    dataDir,
    workspace,
    /** 本次启动是否从旧目录迁移而来（未迁移为 null） */
    migratedFrom,
    /**
     * 旧目录有数据、新目录还没有时的旧目录路径。
     *
     * ★ 必须在这里显式列出来（不能只靠上面那个 let）—— `built` 是这个函数唯一的出口，
     *   漏写一行字段，`/health` 的 `needsMigration` 就永远是 false，界面也就永远不会提醒。
     */
    legacyDataDir,
    host: readBrandEnv(env, 'HOST') || '0.0.0.0',
    port: Number(readBrandEnv(env, 'PORT') || 8787),
    serverName: readBrandEnv(env, 'NAME') || BRAND_NAME,
    discoveryEnabled: readBrandEnv(env, 'DISCOVERY') !== '0',
    tlsEnabled: readBrandEnv(env, 'TLS') !== '0',
    tlsPort: Number(readBrandEnv(env, 'TLS_PORT') || 8443),
    discoveryPort: Number(readBrandEnv(env, 'DISCOVERY_PORT') || 8788),
    staticToken: readBrandEnv(env, 'TOKEN') || null,
    trustLocal: readBrandEnv(env, 'TRUST_LOCAL')
      ? readBrandEnv(env, 'TRUST_LOCAL') === '1'
      : !readBrandEnv(env, 'TOKEN'),
    allowedHosts: (readBrandEnv(env, 'ALLOWED_HOSTS') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    model: readBrandEnv(env, 'MODEL') || null,
    thinking: readBrandEnv(env, 'THINKING') || 'medium',
    tools,
    maxMessagesPerRoom: Number(readBrandEnv(env, 'MAX_MESSAGES') || 500),
    autoProbe: readBrandEnv(env, 'PROBE') !== '0',
    pairTtlMs: Number(readBrandEnv(env, 'PAIR_TTL_MS') || 10 * 60 * 1000),
    lessonReflect: readBrandEnv(env, 'LESSON_REFLECT') !== '0',
    autoAttachArtifacts: readBrandEnv(env, 'AUTO_ATTACH_FILES') !== '0',
    autoAttachImages: readBrandEnv(env, 'AUTO_ATTACH') !== '0',
    groupBusyWaitMs: Number(readBrandEnv(env, 'GROUP_BUSY_WAIT_MS') || 120_000),
    heartbeatMs: Number(readBrandEnv(env, 'HEARTBEAT_MS') || 15_000),
    stallMs: Number(readBrandEnv(env, 'STALL_MS') || 360_000),
    maxSessions: Number(readBrandEnv(env, 'MAX_SESSIONS') || 40),
    maxConcurrentRuns: Number(readBrandEnv(env, 'MAX_CONCURRENT_RUNS') || 0),
    runSlotReserve: Number(readBrandEnv(env, 'RUN_SLOT_RESERVE') ?? 1),
    runSlotWaitMs: Number(readBrandEnv(env, 'RUN_SLOT_WAIT_MS') || 0),
    backgroundConcurrency: Number(readBrandEnv(env, 'BACKGROUND_CONCURRENCY') ?? 1),
    backgroundSlotWaitMs: Number(readBrandEnv(env, 'BACKGROUND_SLOT_WAIT_MS') ?? 30_000),
    chiefTools: (readBrandEnv(env, 'CHIEF_TOOLS') || 'read,write,edit,ls,find,grep,bash').split(',').map((s) => s.trim()).filter(Boolean),
    leadTools: (readBrandEnv(env, 'LEAD_TOOLS') || 'read,write,edit,ls,find,grep,bash').split(',').map((s) => s.trim()).filter(Boolean),
    searchUrl: readBrandEnv(env, 'SEARCH_URL') || null,
    searchKey: readBrandEnv(env, 'SEARCH_KEY') || null,
    reserveTokens: Number(readBrandEnv(env, 'RESERVE_TOKENS') || 0) || null,
    keepRecentTokens: Number(readBrandEnv(env, 'KEEP_RECENT_TOKENS') || 0) || 60_000,
    compactAtPercent: Number(readBrandEnv(env, 'COMPACT_AT_PERCENT') || 0.6),
    autoCompact: readBrandEnv(env, 'AUTO_COMPACT') !== '0',
    fullDuplex: readBrandEnv(env, 'FULL_DUPLEX') !== '0',
    jarvisMode: readBrandEnv(env, 'JARVIS') !== '0',
    memoryRecursive: readBrandEnv(env, 'MEMORY_RECURSIVE') !== '0',
    runTimeoutMs: Number(readBrandEnv(env, 'RUN_TIMEOUT_MS') || 10 * 60 * 1000),
    hostname: os.hostname(),
    // os.userInfo() 在没有 /etc/passwd 的容器里会抛（任意 UID 跑镜像很常见）——
    // 只 import 一下 库 不该让进程崩掉，所以兜住。
    userName: readBrandEnv(env, 'USER_NAME') || safeUserName() || '我',
  };

  for (const [k, v] of Object.entries(scalarOverrides)) {
    if (v !== undefined) built[k] = v;
  }
  // 不可枚举：写 state.json / 打日志 / JSON.stringify(cfg) 都不该看见这个符号
  Object.defineProperty(built, CONFIG_BRAND, { value: true, enumerable: false });
  return built;
}

/**
 * 默认导出的**实例配置**。
 *
 * ★ `ensureDirs: false`：光 import 配置模块（SDK / 诊断脚本 / 单元测试）不该在
 *   用户家里建 `orbis/data`、`workspace` 这些目录。真正起服务时由
 *   `server-main.js` 负责建（它有明确的启动边界）。
 */
export const config = createConfig({
  env: process.env,
  serverBoot: globalThis[SERVER_BOOT] === true,
  ensureDirs: false,
});

/** `os.userInfo()` 的安全包装：拿不到（容器 / 任意 UID）就返回空串。 */
function safeUserName() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

export function describeConfig(cfg = config) {
  return {
    serverName: cfg.serverName,
    port: cfg.port,
    home: cfg.home,
    dataDir: cfg.dataDir,
    migratedFrom: cfg.migratedFrom,
    workspace: cfg.workspace,
    model: cfg.model ?? '(pi 默认)',
    thinking: cfg.thinking,
    tools: cfg.tools.join(','),
    auth: cfg.staticToken ? 'static-token' : 'pairing-code',
    trustLocal: cfg.trustLocal,
  };
}

/**
 * bot 会话要加载哪些 pi 侧资源。
 *
 * **默认全关。** 那些资源是给终端里的 pi 用的：
 *   · 扩展（extensions/）：会起子进程（派子 agent、MCP 客户端、弹窗），
 *   · MCP 服务（mcp.json）：每个会话拉一堆 python/node 进程，
 *   · skills / 提示模板：是给终端 agent 的提示词，bot 用不上。
 * bot 需要的是"模型 + 这里给的工具"，多一样都是隐患：占资源、塞满提示词、
 * 几十个 bot 并存时互相打架。要开就用环境变量单独开。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{noExtensions:boolean,noMcp:boolean,noSkills:boolean,noPromptTemplates:boolean}}
 */
export function resourceSwitches(env = process.env) {
  const on = (v) => v === '1';
  return {
    noExtensions: !on(readBrandEnv(env, 'EXTENSIONS')),
    noMcp: !on(readBrandEnv(env, 'MCP')),
    noSkills: !on(readBrandEnv(env, 'SKILLS')),
    noPromptTemplates: !on(readBrandEnv(env, 'SKILLS')),
  };
}

/** 本次启动生效的开关 */
export const resourceOptions = resourceSwitches();
