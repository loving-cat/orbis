/**
 * 心跳看门狗：让"我还活着"这件事可观测，让"卡死了"这件事被发现。
 *
 * 独立成模块便于单独测试：它判断的是"这一轮是不是已经死了"，
 * 判错了要么白杀一轮、要么永远转圈。
 *
 * 核心是一个**可以直接调的 tick()**：测试不用等定时器，也不用 sleep，
 * 想验"多久算失联"就直接喂不同的时间戳。
 *
 * 只做三件事：
 *   1. 还在跑的会话，按间隔报一次心跳（含"最后一次动静是多久前"）；
 *   2. 超过阈值没动静的 → 判为中断，交给调用方收尾（onStall）；
 *   3. 同一个会话只判一次（stallNotified），不然每 15 秒都会报一遍。
 *
 * ## 两档阈值（长任务）
 *
 * "没动静"要分清是谁没动静：
 *   · 模型在想/在说 → `stallMs`（默认 6 分钟）没有任何事件就是真卡了；
 *   · 有工具正在执行（`entry.toolsRunning > 0`）→ `toolStallMs`（默认 15 分钟）。
 *
 * 为什么工具要单独一档：构建、测试、安装依赖这类命令常常**安静地**跑很久
 * （很多测试框架只在最后打印结果）。按 6 分钟一刀切，跑 7 分钟的测试
 * 就会被判"心跳断了"——任务在正常干活，却被看门狗打断。
 * 工具如果一直有输出（`tool_execution_update`），执行器会持续刷新进展时间，
 * 根本走不到阈值；第二档只兜"安静但没死"的命令。
 */
import { log } from './util.js';

export function createWatchdog({
  sessions,
  heartbeatMs = 15_000,
  stallMs = 360_000,
  /** 有工具在执行时的阈值；小于 stallMs 时按 stallMs 算（只放宽、不收紧） */
  toolStallMs = 900_000,
  emit = () => {},
  onStall = () => {},
  now = () => Date.now(),
  logger = log,
} = {}) {
  /** 这个会话此刻适用的阈值 */
  const limitFor = (entry) => (Number(entry?.toolsRunning) > 0
    ? Math.max(stallMs, Number(toolStallMs) || 0)
    : stallMs);
  /** 定时器（一个进程一个就够） */
  let timer = null;

  /** 跑一遍：报心跳 + 判失联。抽出来是为了能单测（不依赖定时器） */
  function tick() {
    const nowMs = now();
    for (const [key, entry] of sessions) {
      if (!entry.busy) continue;
      const sep = key.indexOf(':');
      const roomId = key.slice(0, sep);
      const botId = key.slice(sep + 1);
      // 没有任何进展记录时，拿它开始的时间当基准；再没有就当"刚刚"
      const ageMs = nowMs - (entry.progressAt ?? entry.startedAt ?? nowMs);

      emit({
        t: 'bot.heartbeat',
        roomId,
        botId,
        ageMs,
        startedAt: entry.startedAt ?? null,
      });

      if (ageMs < limitFor(entry) || entry.stallNotified) continue;
      // 先标记再上报：上报里会 abort 这一轮，而 abort 也是异步的，
      // 中间这段时间要是又 tick 一次，就会重复上报两条"这单断了"。
      entry.stallNotified = true;
      onStall({ roomId, botId, entry, ageMs });
    }
  }

  function start() {
    if (timer) return false;
    const every = Math.max(5_000, heartbeatMs);
    timer = setInterval(tick, every);
    // 别因为这个定时器把进程吊着不退
    timer.unref?.();
    logger(
      `💓 心跳看门狗已启动：每 ${Math.round(every / 1000)}s 报一次，` +
        `超过 ${Math.round(stallMs / 1000)}s 没动静就判为中断并上报组长` +
        `（有工具在执行时放宽到 ${Math.round(Math.max(stallMs, Number(toolStallMs) || 0) / 1000)}s）`,
    );
    return true;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, get running() { return Boolean(timer); } };
}

/**
 * 心跳断了之后要做的收尾。
 *
 * 和看门狗分开：一个是"发现"，一个是"处理"。处理要动 store、要 abort 会话、
 * 要上报组长 —— 那些都是副作用，放一起就没法单测了。
 */
export function stallCleanup({ store, logger = log } = {}) {
  return ({ roomId, botId, entry, ageMs }) => {
    const bot = store.getBot(botId);
    const secs = Math.round(ageMs / 1000);
    logger(`💔 ${bot?.name ?? botId} 已经 ${secs}s 没动静 —— 判为中断，收尾并上报`);

    // ① 把这一轮捣掉（它已经没动静了）
    entry.session?.abort?.().catch?.(() => {});

    // ② 正在写的那条消息得收尾 —— 不收的话客户端永远转圈
    const msgId = entry.liveMsgId;
    if (msgId) {
      const msg = store.getMessage(roomId, msgId);
      store.updateMessage(
        roomId,
        msgId,
        {
          status: 'error',
          error: `心跳断了：${secs} 秒没动静，这一轮已中断`,
          steps: (msg?.steps ?? []).map((s) =>
            s?.status === 'running'
              ? { ...s, status: 'error', error: '心跳断了，这一步中断' }
              : s,
          ),
        },
        { silent: false },
      );
    }
    return { roomId, botId, secs };
  };
}
