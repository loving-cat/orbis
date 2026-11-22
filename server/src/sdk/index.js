/**
 * Orbis 进程内 Agent SDK 门面。
 *
 * 对标 `@earendil-works/pi-coding-agent` 的可嵌入用法：
 *   const rt = await createOrbisRuntime({ dataDir, workspace, modelGroups: [...] });
 *   rt.onEvent((ev) => ...);
 *   const res = await rt.askMain('帮我整理项目结构');
 *   await rt.dispose();
 *
 * 特点：
 *   · 仅 import 本模块不会读写默认全局 `~/.local/share/pi-bot` 或 `state.json`；
 *   · 同一 Node 进程可并行创建多个互不串状态、互不抢总线的独立 runtime；
 *   · 底层仍复用唯一一条骨架：`Config + Store + Bus + GrantGate + PiRunner + Services`。
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { BRAND_NAME, BRAND_SLUG } from '../brand.js';
import { createConfig, isConfigObject } from '../config.js';
import { createBus } from '../bus.js';
import { createStore } from '../store.js';
import { createModelGroupStore } from '../model-groups.js';
import { loadOrCreateKey } from '../secrets.js';
import { PiRunner } from '../pi-runner.js';
import { createGrantGate } from '../grant-gate.js';
import { ensureLegacyGrant } from '../migration-grants.js';
import { createAutomationScheduler } from '../automations.js';
import { createServices } from '../services/index.js';
import { createTaskHost } from '../bootstrap/task-host.js';
import { createTaskCommands } from '../tasks/task-commands.js';
import { ACTION } from '../grants.js';
import { ACTIONS, TOOL_SPECS, auditCapabilities } from '../capabilities.js';
import { selectLessonsFor, lessonsPromptLines } from '../lessons.js';
import {
  ORBIS_ERROR_CODES as ORBIS_CODE,
  OrbisError,
  orbisError,
  isOrbisError,
  asOrbisError,
} from './errors.js';
import {
  OrbisClient,
  createOrbisClient,
  PiBotClient,
  createPiBotClient,
} from './client.js';
import { clearSettleTimers } from '../runner/run-settled.js';

/**
 * 构造一个 runtime 的选项（T2.2 类型约定）。
 *
 * ★ 这里是**同一份契约的第二份写法**（第一份是 docs/SDK.md 的表格）。
 *   两份都必须改：文档给不会读 d.ts 的人，typedef 给 IDE 与 `tsc --noEmit`。
 *   `tests/sdk-injection.mjs` 把每一类都搂了一遍 —— 改契约而没改类型
 *   会在 examples 的 `tsc --noEmit` 上暴露。
 *
 * @typedef {object} OrbisRuntimeOptions
 * @property {string} [dataDir] 数据目录（默认跟随 `ORBIS_HOME` / 平台用户目录）
 * @property {string} [workspace] 工作目录（bot 读写文件、执行命令的根）
 * @property {string} [userName] 界面上“那个人”的名字
 * @property {Record<string, any>} [config] `createConfig()` 的整份配置，或按字段覆盖
 * @property {import('../store.js').Store} [store] Store 实现；`memory: true` 的不落盘
 * @property {object} [bus] 共享事件总线（传了 store 时应当就是 `store.bus`）
 * @property {object} [modelGroupStore] 注入模型组存储
 * @property {object} [modelRuntime] 已建好的模型运行时实例（跳过自建）
 * @property {() => Promise<object>} [modelRuntimeFactory] 自己造模型运行时的工厂
 * @property {object} [sessionApi] 底层 pi 会话 API 的注入点（测试与高级宿主用）
 * @property {(defaults: Record<string, any>) => object} [resourceLoader] 资源加载器工厂，每次建会话调一次
 * @property {object[]} [customTools] 追加的工具对象（`defineTool` 产出）
 * @property {string[]} [tools] 追加启用的内置工具名
 * @property {string} [secretsKey] 连接凭据加密密钥（不传则从 dataDir 读取/新建）
 * @property {Record<string, any>} [policy] 全局策略覆盖（`{ dangerous: 'deny' }` = 只读）
 * @property {object[]} [modelGroups] 要 upsert 的模型组
 * @property {string} [defaultModel] 默认模型 slug（`provider/id`）
 * @property {boolean} [memory] 全内存模式：不建目录、不落盘
 * @property {boolean|string} [runStatsFile] 运行统计文件；`false` / `''` = 不落盘
 * @property {boolean} [taskIntake] 接单功能开关
 * @property {boolean} [enableAutomations] 是否启动定时任务调度器
 * @property {boolean} [installGrantGate] 是否装授权门（默认装）
 * @property {boolean} [inheritHostProviders] 是否继承宿主 pi 的 provider
 * @property {boolean} [autoProbe] 是否自动探活模型端点
 * @property {boolean} [lessonReflect] 是否开启经验复盘
 */

/**
 * 一个运行中的 runtime（`services` / `bots` / `rooms` 等门面是动态生成的，统一记作 any）。
 *
 * @typedef {object} OrbisRuntime
 * @property {ReturnType<typeof createConfig>} config
 * @property {import('../store.js').Store} store
 * @property {import('../model-groups.js').ModelGroupStore} modelGroups
 * @property {any} bus
 * @property {any} runner
 * @property {string} generation 本次运行的标记（事件里带，便于区分多个 runtime）
 * @property {any} services
 * @property {any} bots
 * @property {any} rooms
 * @property {any} models
 * @property {any} automations
 * @property {any} capabilities
 * @property {any} policy
 * @property {any} lessons 经验库读写（propose 永远只产 candidate）
 * @property {(fn: (ev: any) => void) => (() => void)} onEvent 订阅事件，返回退订函数
 * @property {(roomId: string, text: string, opts?: Record<string, any>) => Promise<any>} send
 * @property {(text: string, opts?: Record<string, any>) => Promise<any>} askMain
 * @property {(args: Record<string, any>) => Promise<any>} runBotOnce
 * @property {(roomId: string, opts?: Record<string, any>) => Promise<any>} abort
 * @property {(roomId: string) => Promise<any>} reset
 * @property {() => Promise<{ok: boolean, already?: boolean, failed?: object[]}>} dispose
 */

/**
 * 构造一个运行中的 runtime。
 *
 * ★ 初始化中途失败必须把已经起来的东西收回去（T2.4）：`grantGate.start()` 起的
 *   定时器、`store` 的落盘节流、`bus` 的监听……不回收的话，调用方 catch 掉异常后
 *   进程里还留着定时器（宿主的服务看起来"跑完了但退不出去"）。
 *   所以这里只负责"建"，失败清理统一在手这个包装里做（逆序）。
 *
 * @param {OrbisRuntimeOptions} [options]
 * @returns {Promise<OrbisRuntime>}
 */
export async function createOrbisRuntime(options = {}) {
  /** @type {Array<() => void>} */
  const cleanup = [];
  try {
    return await buildRuntime(options, cleanup);
  } catch (err) {
    for (const step of cleanup.reverse()) {
      try {
        step();
      } catch {
        // 回收失败不能盖住原始错误
      }
    }
    throw isOrbisError(err) ? err : asOrbisError(err);
  }
}

/**
 * 注入点①：`config`。
 *
 * `createConfig()` 产出的**整份配置**（带 `CONFIG_BRAND`）就拿它当底；否则按 1.0 起的
 * 老规矩把 `options.config` 当“字段覆盖”交给 `createConfig`。两种都还是过一遍
 * `createConfig`（只为了重新打标 + 统一补 `serverBoot: false`），返回的永远是新拷贝。
 */
function resolveConfig(options, memory) {
  const raw = options.config;
  const base = isConfigObject(raw) ? raw : (raw ?? {});
  return createConfig({
    ...base,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    autoProbe: options.autoProbe ?? base.autoProbe ?? false,
    lessonReflect: options.lessonReflect ?? base.lessonReflect ?? false,
    // ★ `defaultModel` 必须在 `runner.init()` 之前就进 config：
    //   init 里“有没有默认模型”是拿 config.model / store 里的值判的。
    //   否则宿主传了 defaultModel 的第一次启动会先打一行
    //   “没有可用模型”再转头把首选项设上 —— 用的人会以为配错了。
    ...(options.defaultModel !== undefined ? { model: options.defaultModel } : {}),
    // 内存模式连目录都不建 —— 否则“一个字节都不写盘”就只是口号
    ensureDirs: !memory,
    serverBoot: false,
  });
}

/**
 * 注入点⑤：资源加载器工厂。
 *
 * 只收**函数**（`(defaults) => loader`）。为什么不像 pi 那样直接收实例：
 * Orbis 每次建会话都重新 `new` 一个 loader（里面挂了策略扩展与 MCP 扩展，
 * 扩展是按房间/角色定制的），共享一个实例等于把上一轮的扩展捎给下一轮。
 * 传别的类型一律报错，而不是默默忽略 ——“我传了却没用”是最难查的一种问题。
 */
function resolveResourceLoader(options) {
  const raw = options.resourceLoader ?? options.resourceLoaderFactory ?? null;
  if (raw == null) return null;
  if (typeof raw !== 'function') {
    throw orbisError(
      ORBIS_CODE.E_INVALID_ARGUMENT,
      'resourceLoader 必须是函数 `(defaults) => loader`（每次会话都会调一次）',
      { received: typeof raw },
    );
  }
  return raw;
}

/**
 * 注入点⑥：工具清单。
 *
 * 只收**数组**（`customTools` 收对象、`tools` 收名字），传别的类型直接报错。
 * 为什么不默默当空数组：调用方写了 `customTools: hostTool`（忘了方括号）时，
 * “安静地什么都没挂上”比报错难查一百倍 —— 与 `resourceLoader` 一个尺度。
 */
function resolveToolList(value, label, kind) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw orbisError(ORBIS_CODE.E_INVALID_ARGUMENT, `${label} 必须是数组`, {
      received: typeof value,
    });
  }
  for (const item of value) {
    const ok = kind === 'tool'
      ? item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim() !== ''
      : typeof item === 'string' && item.trim() !== '';
    if (!ok) {
      throw orbisError(
        ORBIS_CODE.E_INVALID_ARGUMENT,
        kind === 'tool'
          ? `${label} 里每一项都必须是带 name 的工具对象（defineTool 产出）`
          : `${label} 里每一项都必须是非空工具名`,
        { index: value.indexOf(item) },
      );
    }
  }
  return value;
}

/**
 * 宿主交进来的东西**由宿主负责关**（T2.3）。
 *
 * 为什么不能“顺手都拆了”：注入的 bus 很可能被别的 runtime 一起订着，
 * `removeAllListeners()` 一下就把别人的监听全干掉了；注入的 store 也可能是
 * 宿主自己的持久层。自己建的才自己拆。
 */
async function buildRuntime(options, cleanup) {
  /** 内存模式：不建目录、不写 state/rooms/taskruns/run-stats、不申请密钥 */
  const memory = options.memory === true || options.store?.memory === true;
  const cfg = resolveConfig(options, memory);

  const injectedBus = options.bus ?? null;
  const injectedStore = options.store ?? null;

  // ②③ bus + store：两者的关系不是“两个独立注入点”，而是**同一根神经**。
  //
  //   store 发 `policy.updated` / `bot.updated` / `msg.created` 都在它自己的 bus 上；
  //   runner 与 `rt.onEvent()` 听的是 runtime 的 bus。只注入 store 却另建一条 bus，
  //   就会“一切看起来都正常，但事件永远不触发”——所以：
  //   · 只给 store：直接沿用 `store.bus`（否则 store 发的事件在另一条线上，没人听得到）；
  //   · store + bus 两条不同的：明确报错，不替调用方猜该合并还是该丢弃；
  //   · 两条都没有的（或 store 没挂 bus）：自己建一条。
  if (injectedStore?.bus && injectedBus && injectedStore.bus !== injectedBus) {
    throw orbisError(
      ORBIS_CODE.E_INVALID_ARGUMENT,
      'store.bus 与传入的 bus 不是同一条：store 发出的事件会落到另一条线上，只能给其中一个',
      { storeBusIsSame: false },
    );
  }
  const inheritedBus = injectedBus ?? injectedStore?.bus ?? null;
  const bus = inheritedBus ?? createBus();
  // 自己建的那条才清全部监听；沿用宿主的总线时只摘本 runtime 自己挂的（见 dispose）
  if (!inheritedBus) cleanup.push(() => bus.removeAllListeners());

  const secretsKey = injectedStore
    ? null
    : (options.secretsKey ?? (memory ? null : loadOrCreateKey(cfg.dataDir)));
  const store = injectedStore ?? createStore({ config: cfg, bus, dataDir: cfg.dataDir, secretsKey, memory });
  if (!injectedStore) cleanup.push(() => store.dispose());

  const injectedGroups = options.modelGroupStore ?? null;
  const modelGroups = injectedGroups ?? createModelGroupStore({ dataDir: cfg.dataDir, memory });
  if (!injectedGroups) cleanup.push(() => modelGroups.dispose?.());

  if (options.userName) {
    store.updateUserName(options.userName);
  }
  if (Array.isArray(options.modelGroups)) {
    for (const group of options.modelGroups) {
      const r = modelGroups.upsert(group);
      if (r.error) {
        throw orbisError(ORBIS_CODE.E_CONFIG_INVALID, `模型组配置不合法：${r.error}`, {
          groupId: String(group?.id ?? ''),
        });
      }
    }
  }
  if (options.policy && typeof options.policy === 'object') {
    store.updatePolicy(options.policy);
  }

  const generation = `sdk-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const taskIntake = Boolean(options.taskIntake ?? false);
  const runner = new PiRunner({
    config: cfg,
    store,
    bus,
    modelGroups,
    sessionApi: options.sessionApi ?? null,
    modelRuntimeFactory: options.modelRuntimeFactory ?? null,
    // ④ modelRuntime（实例）/ ⑤ resourceLoader（工厂）/ ⑥ tools（追加对象与启用名）
    modelRuntime: options.modelRuntime ?? null,
    resourceLoaderFactory: resolveResourceLoader(options),
    extraCustomTools: resolveToolList(options.customTools, 'customTools', 'tool'),
    extraToolNames: resolveToolList(options.tools, 'tools', 'name'),
    // 传 `''` 就是 RunStats 的“不落盘”语义
    runStatsFile: options.runStatsFile ?? (memory ? '' : undefined),
    inheritHostProviders: options.inheritHostProviders ?? false,
    taskIntake,
  });
  cleanup.push(() => runner.disposeAll());
  // 逆序执行时这条在 disposeAll 之前跑：先清待发的 run.settled 定时器
  cleanup.push(() => clearSettleTimers(runner));

  if (options.installGrantGate !== false) {
    const syncGrants = ({ botIds }) => ensureLegacyGrant({
      store,
      policy: store.policy(),
      policyRevision: store.policyVersion(),
      botIds,
      chiefBotId: store.mainBot()?.id ?? null,
      generation,
    });
    syncGrants({ botIds: store.listBots().map((b) => b.id) });
    runner.grantGate = createGrantGate({
      store,
      currentPolicyRevision: () => store.policyVersion(),
      currentGeneration: () => generation,
      syncGrants,
      bus,
    });
    runner.grantGate.start();
    cleanup.push(() => runner.grantGate?.stop?.());
    runner.grantGeneration = () => generation;
  }

  const services = createServices({ config: cfg, store, bus, runner, modelGroups });
  runner.services = services;

  await runner.init();

  if (options.defaultModel) {
    const res = await services.models.setDefaultModel(options.defaultModel);
    if (!res.ok) {
      throw orbisError(
        ORBIS_CODE.E_MODEL_UNAVAILABLE,
        res.error || `无法设置默认模型：${options.defaultModel}`,
        { requested: String(options.defaultModel) },
      );
    }
  }

  let taskHost = null;
  if (taskIntake) {
    taskHost = createTaskHost({ store, runner });
    cleanup.push(() => taskHost?.dispose?.());
    runner.taskCommands = createTaskCommands({ store, runner, taskRuns: store.taskRuns });
  }

  let scheduler = null;
  if (options.enableAutomations === true) {
    scheduler = createAutomationScheduler({
      store,
      run: (automation) => runner.runAutomation(automation),
    });
    scheduler.start();
    cleanup.push(() => scheduler?.stop?.());
  }

  let disposed = false;

  /** 本 runtime 经 `onEvent()` 挂上的监听：dispose 时逐个摘（不碰宿主自己 `bus.on` 的） */
  const sdkEventHandlers = new Set();

  /** 任何对外入口都先过这一道：已 dispose 的 runtime 不再接受新活 */
  function assertAlive() {
    if (disposed) {
      throw orbisError(ORBIS_CODE.E_DISPOSED, 'runtime 已经 dispose，不能再调用（要再用就重建一个）');
    }
  }

  /** 忙时三路分流可以显式指定的意图（与 `DUPLEX_KIND` 同值） */
  const ROUTE_INTENTS = Object.freeze(['side_reply', 'amend', 'abort_replace']);

  /**
   * 调用方给的**显式**分流意图；没给就返回 null。
   *
   * `duplexMode: 'auto'` 是界面用的"你帮我判"，在 SDK 里**不算给了意图** ——
   * SDK 不能替宿主猜（猜错就是把一整轮正在干活的活覆盖掉）。
   */
  function routeIntentOf(opts = {}) {
    const raw = String(opts?.duplexMode ?? '').trim();
    if (ROUTE_INTENTS.includes(raw)) return raw;
    if (raw === 'side') return 'side_reply';
    if (opts?.mode === 'followUp') return 'amend';
    return null;
  }

  /**
   * 忙时没有分流意图 → 直接拒绝（T2.5 的"不猜"）。
   * 只对私聊生效：群聊走的是"排队等这轮结束"，本来就不需要三路分流。
   */
  function assertRouteIfBusy(roomId, opts = {}) {
    const room = store.getRoom(roomId);
    if (!room || room.kind === 'group') return;
    const botId = runner.targetBotFor(room);
    if (!botId || !runner.isBusy(roomId, botId)) return;
    if (routeIntentOf(opts)) return;
    throw orbisError(
      ORBIS_CODE.E_BUSY_NEEDS_ROUTE,
      `bot 正在处理上一条消息：请明确分流意图（duplexMode=${ROUTE_INTENTS.join(' | ')}）`,
      { roomId, botId, options: [...ROUTE_INTENTS] },
    );
  }

  /** 给门面方法统一加"已 dispose"守卫（不想每个方法手写 assertAlive） */
  function guarded(table) {
    const out = {};
    for (const [name, fn] of Object.entries(table)) {
      if (typeof fn !== 'function') {
        out[name] = fn;
        continue;
      }
      // 异步方法返回 rejected promise，同步方法直接抛 —— 两种都带同一个 code，
      // 但不能把 `await bots.create()` 变成同步击穿。
      const asyncFn = fn.constructor?.name === 'AsyncFunction';
      out[name] = asyncFn
        ? async (...args) => {
            assertAlive();
            return fn(...args);
          }
        : (...args) => {
            assertAlive();
            return fn(...args);
          };
    }
    return out;
  }

  function onEvent(handler) {
    if (typeof handler !== 'function') return () => {};
    bus.on('event', handler);
    // ★ 记下来（T2.3）：注入的 bus 是**共享**的，`dispose()` 不能清全部监听；
    //   但不摘自己挂的那些就是真泄漏 —— 宿主的进程里每建一次 runtime
    //   就多一组永远不回调的 handler。
    sdkEventHandlers.add(handler);
    return () => {
      sdkEventHandlers.delete(handler);
      bus.off('event', handler);
    };
  }

  async function askMain(text, opts = {}) {
    assertAlive();
    const main = store.mainBot();
    if (!main) throw orbisError(ORBIS_CODE.E_NO_MAIN_BOT, '库里没有主控 bot（mainBot），初始化可能不完整');
    const dm = store.ensureDm(main.id);
    // 这里也是 prompt：主控正忙时必须让人明确说"插话 / 追加 / 推翻重来"
    assertRouteIfBusy(dm.id, opts);
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;
    const { timeoutMs: _drop, ...sendOpts } = opts;

    let doneMsg = null;
    let settled = false;
    let timer = null;
    let resolveTurn;
    let rejectTurn;
    const donePromise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    donePromise.catch(() => {});

    const onBusEvent = (ev) => {
      const evRoomId = ev?.roomId ?? ev?.msg?.roomId;
      if (settled || evRoomId !== dm.id) return;
      if (ev.t === 'msg.done' && ev.msg?.authorType === 'bot' && ev.msg?.authorId === main.id) {
        settled = true;
        doneMsg = ev.msg;
        resolveTurn(ev.msg);
      } else if (ev.t === 'msg.error') {
        settled = true;
        // 运行层把错误以事件带过来：统一翻译成契约码，别把内部 Error 形状漏给宿主
        const raw = ev.error;
        const err = asOrbisError(
          typeof raw === 'object' && raw ? raw : new Error(String(raw ?? 'mainBot 执行失败')),
          ORBIS_CODE.E_TURN_FAILED,
        );
        err.msg = ev.msg ?? null;
        rejectTurn(err);
      }
    };
    bus.on('event', onBusEvent);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectTurn(
          orbisError(ORBIS_CODE.E_TIMEOUT, `askMain 超时（>${timeoutMs}ms）`, { timeoutMs, roomId: dm.id }),
        );
      }, timeoutMs);
    }

    try {
      let sendResult;
      try {
        sendResult = await runner.send(dm.id, text, { flushMerge: true, ...sendOpts });
      } catch (err) {
        throw asOrbisError(err);
      }
      const reply = doneMsg ?? await donePromise;
      return {
        roomId: dm.id,
        userMessage: sendResult?.userMessage ?? null,
        reply,
        replyText: reply?.text ?? '',
      };
    } finally {
      bus.off('event', onBusEvent);
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 经验库门面（规格 `docs/ROADMAP-2.0.md` §5.7 的 `runtime.lessons`）。
   *
   * 全部转发给 `services.capabilities`：它和 HTTP / 界面用的是同一条路，
   * **不新建存储、不新建注入点** —— 红线 I0 管的就是这条。
   * 返回形状与 `runtime.bots` / `runtime.capabilities` 一致：读返回数组，
   * 写一律 `{ ok, ... }`（失败带 `status` / `code` / `error`）。
   *
   * `propose` 永远只产 `candidate`：即使调用方传了 `status: 'active'` 也会被改回去。
   * 审批门禁是“人点按钮”，SDK 不该有绕过去的口子；要生效必须走 `activate`
   * （它自己会校验证据、以及有没有否决 / 降级边）。
   *
   * `unreject` / `undecay` 是必备的：没有它们，宿主调了 `reject`、或遇到自动降级之后，
   * 在门面内就**再也恢复不了**（`activate` 会被守卫拦住）。
   */
  const lessons = guarded({
    list: ({ status = '' } = {}) =>
      services.capabilities.listLessons().filter((l) => !status || l.status === status),
    edges: () => services.capabilities.listLessonEdges(),
    propose: (raw = {}) => services.capabilities.addLesson({ ...raw, status: 'candidate' }),
    activate: (id) => services.capabilities.updateLesson(String(id ?? ''), { status: 'active' }),
    archive: (id) => services.capabilities.updateLesson(String(id ?? ''), { status: 'archived' }),
    remove: (id) => services.capabilities.removeLesson(String(id ?? '')),
    /** 与界面上的「记错了」同一条路：写 `user` 否决边 + 归档 */
    reject: (id) => services.capabilities.rejectLesson(String(id ?? '')),
    /** 「解除否决」：删 user 边（否则 activate 永远被守卫拦住） */
    unreject: (id) =>
      services.capabilities.removeLessonEdge({
        from: 'user',
        to: String(id ?? ''),
        type: 'contradicts',
      }),
    /** 「解除降级」：删 system 边（store 会顺手把连败计数清零） */
    undecay: (id) =>
      services.capabilities.removeLessonEdge({
        from: 'system',
        to: String(id ?? ''),
        type: 'contradicts',
      }),
    addEdge: (raw = {}) => services.capabilities.addLessonEdge(raw),
    removeEdge: (raw = {}) => services.capabilities.removeLessonEdge(raw),
    /** 按任务预览会被注入哪几条（与 `GET /api/lessons/preview` 同一套打分） */
    preview: (task, { roomId = '', modelFamily = '' } = {}) => {
      const picked = selectLessonsFor(services.capabilities.listLessons(), String(task ?? ''), {
        roomId: String(roomId ?? ''),
        modelFamily: String(modelFamily ?? ''),
        edges: services.capabilities.listLessonEdges(),
      });
      const lines = lessonsPromptLines(picked);
      return { ok: true, picked, lines, chars: lines.join('\n').length };
    },
  });

  /** 已 dispose 的 runtime 不接受新的一轮（dispose 本身幂等，见下） */
  async function send(roomId, text, opts = {}) {
    assertAlive();
    assertRouteIfBusy(roomId, opts);
    try {
      return await runner.send(roomId, text, { flushMerge: true, ...opts });
    } catch (err) {
      throw asOrbisError(err);
    }
  }

  /**
   * 拆掉这个 runtime。
   *
   * 约定（T2.4）：
   *   · **幂等**：第二次直接返回 `{ ok: true, already: true }`，不抛；
   *   · **不抛异常**：某一步拆失败也要把剩下的拆完（否则一个抛错的 dispose 会留下
   *     半个 runtime），失败明细放在返回值里；
   *   · 定时器（含待发的 `run.settled`）必须先停，否则宿主进程退不出去。
   */
  async function dispose() {
    if (disposed) return { ok: true, already: true };
    disposed = true;
    const failed = [];
    const step = (label, fn) => {
      try {
        fn();
      } catch (err) {
        failed.push({ step: label, message: String(err?.message ?? err) });
      }
    };
    step('scheduler', () => scheduler?.stop?.());
    step('taskHost', () => taskHost?.dispose?.());
    step('grantGate', () => runner.grantGate?.stop?.());
    // run.settled 的待发定时器由 SDK 层清（run-settled.js 用 WeakMap 按 runner 归组）
    step('runSettled', () => clearSettleTimers(runner));
    step('runner', () => runner.disposeAll());
    // ★ 只摘自己挂的（T2.3）：注入的 bus 上还有宿主的监听，不能 removeAllListeners
    step('sdkEventHandlers', () => {
      for (const handler of sdkEventHandlers) bus.off('event', handler);
      sdkEventHandlers.clear();
    });
    // ★ 只拆自己建的（T2.3）：注入的 store / 模型组 / bus 由宿主拥有。
    //   例如共享 bus 上还有别的 runtime 的监听，removeAllListeners 会把人家一起干掉。
    if (!injectedStore) step('store', () => store.dispose());
    if (!injectedGroups) step('modelGroups', () => modelGroups.dispose?.());
    if (!injectedBus) step('bus', () => bus.removeAllListeners());
    return failed.length ? { ok: false, already: false, failed } : { ok: true, already: false };
  }

  // 服务门面也过 assertAlive：dispose 之后再调它们等于往已经拆掉的 store 上写。
  // ★ 顶层与 `services.*` 必须**共用同一批包装对象** —— 否则宿主从
  //   `rt.services.bots` 走还是能写，两条路的行为不一致。
  const facades = {
    bots: guarded(services.bots),
    rooms: guarded(services.rooms),
    models: guarded(services.models),
    automations: guarded(services.automations),
    capabilities: guarded(services.capabilities),
    policy: guarded(services.policy),
  };

  return {
    config: cfg,
    store,
    bus,
    modelGroups,
    runner,
    generation,
    services: { ...services, ...facades },
    ...facades,
    lessons,
    send,
    askMain,
    runBotOnce: async (args) => {
      assertAlive();
      try {
        return await runner.runBotOnce(args);
      } catch (err) {
        throw asOrbisError(err);
      }
    },
    abort: async (roomId, opts = {}) => {
      assertAlive();
      try {
        return await runner.abort(roomId, opts);
      } catch (err) {
        throw asOrbisError(err);
      }
    },
    reset: async (roomId) => {
      assertAlive();
      return runner.resetRoomSessions(roomId);
    },
    onEvent: guarded({ onEvent }).onEvent,
    dispose,
  };
}

/** 向后兼容旧称 */
export const createPiBotRuntime = createOrbisRuntime;

export {
  ORBIS_ERROR_CODES,
  OrbisError,
  orbisError,
  isOrbisError,
  asOrbisError,
} from './errors.js';

export {
  defineTool,
  BRAND_NAME,
  BRAND_SLUG,
  ACTIONS,
  ACTION,
  TOOL_SPECS,
  auditCapabilities,
  createConfig,
  createBus,
  createStore,
  createModelGroupStore,
  createServices,
  OrbisClient,
  createOrbisClient,
  PiBotClient,
  createPiBotClient,
};

/**
 * 定义工具参数的 schema 构造器（`Type.Object({ ... })`）。
 *
 * 为什么不要求宿主自己去装 typebox：`defineTool()` 的参数就是 typebox 的
 * `TSchema`，而版本必须和 pi 内部那个**同一个**（两份 typebox 的 schema
 * 互不认）。从这里拿，宿主装的版本就一定对得上。
 */
export { Type } from 'typebox';
