/**
 * 负责人持续推进器：事件驱动的内部推进、子任务调度与恢复。
 *
 * 编排顺序（每次从持久记录重新检查）：
 *   祖先/本任务取消或暂停 → 版本 → 结果未知核验 → 在途子任务 → 权限/根预算 →
 *   验收（仅合法状态）→ 下一步/等待 → 执行一步（预留/启动/登记/调用/结算）。
 *
 * 复用：判定在 task-next-action，控制在 task-controls，提示在 task-prompts，
 * 执行一步在 run-managed-attempt，恢复分类用 TaskRunStore 既有静态方法。
 */
import { EVENT, STATE, STOP } from './task-contract.js';
import { reduceTaskRun } from './task-reduce.js';
import { NEXT, planNextAction, progressSignature } from './task-next-action.js';
import { verifyTaskRun } from './task-verification.js';
import { remainingRuns } from './task-budget.js';
import { TaskRunStore } from './task-run-store.js';
import { runManagedAttempt } from './run-managed-attempt.js';
import { decideRetry, isUpstreamTransient } from '../retry-policy.js';
import {
  CONTROL, applyControl, reconcileEarlyControls, descendants as descendantsOf,
} from './task-controls.js';
import { childrenOf } from './task-subtasks.js';
import {
  DEP_STATUS, dependencyStatus, isWaitingOnlyOnCheckpoints, pendingCheckpointKids,
  readyDownstreamOf, upstreamFailedIds,
} from './task-dag.js';
import { appendEntry, artifactEntryOf } from './task-blackboard.js';
import { approveCheckpoint as approveCheckpointIn, approveCheckpointsOf as approveCheckpointsOfIn } from './task-checkpoint.js';
import { classifyNonRetriableFailure, nonRetriableOf, handBackBlockedBy } from './task-guardrails.js';
import { fileClaimList, pickBlockingClaim, claimsOverlap } from './task-file-claims.js';
import { decideRecovery, RECOVERY_STAGE } from './task-recovery.js';
import { LEAD_PHASE, buildLeadPrompt, buildMemberPrompt, buildDeliverySummary, continuationNote } from './task-prompts.js';
import {
  CRITIC_MODE, MAX_CRITIC_REWORKS, buildCriticPrompt, criticTargetKeyOf, latestSettledAttempt,
  pendingExpertConditions, resolveCriticMode, shouldRunCritic,
} from './task-critic.js';
import { tokenCountOf } from './task-budget.js';
import { reserveRootBudget, refundRootBudget, settleRootBudget, extendRootBudget } from './task-budget-coordinator.js';

const PAUSED = new Set([STATE.paused_user, STATE.paused_budget]);
/** 与既有 retry-policy 的瞬时故障上限一致。 */
const MAX_TRANSIENT_ATTEMPTS = 10;
/**
 * 自主任务连续失败多少次后停下来。
 *
 * 用户说「一直干到有结果」不等于「无限重试」：同一个错误反复重试只会烧时间。
 */
/** 没配置时的并发默认值：保守取 4，实际会按部门人数覆盖。 */
const DEFAULT_CONCURRENCY = 4;
/**
 * 这些结果出现时，那次执行肯定已经结算 → 根上的名额真的空出来了。
 *
 * ★ 不能把 `retry_scheduled` 也算进来：名额满而让出的任务本来就是
 *   `retry_scheduled`，算进来会让两个等待者互相唤醒到死循环。
 */
const SLOT_FREED = new Set(['completed', 'done', 'cancelled']);

const AUTONOMY_RETRY_LIMIT = 3;

/**
 * 自主任务里「成员的分工全部受阻 → 交回负责人重新安排」最多几次。
 *
 * 交回一次，负责人能换人、拆小、或自己上手；反复交回仍不成，
 * 就不是安排问题而是真卡住了（缺权限/缺外部条件），如实阻塞给用户看。
 */
const MAX_CHILD_HANDBACKS = 2;

/** 步数用尽让出后，隔多久继续推进（避免原地空转，又不让任务停住）。 */
const YIELD_RESUME_MS = 1_000;

/** 自主重试之间的间隔：给执行器一点时间从上次失败里恢复。 */
const AUTONOMY_RETRY_MS = 5_000;

/**
 * 上游瞬时故障（429 / 5xx / 熔断 / 网络瞬断）的**分钟级**阶梯退避。
 *
 * 快速重试（1.5–12 秒，最多 10 次）只够穿过一次抽风；上游限流是分钟级的事。
 * 以前快速重试用尽就落「阻塞」等用户 —— 用户看到的是一次普通的限流把整件事判死。
 */
const UPSTREAM_LADDER_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 900_000]);

/** 累计上游退避上限：超过这个时长就不该再「等一等」，如实阻塞给用户看。 */
const MAX_UPSTREAM_WAIT_MS = 2 * 60 * 60 * 1000;

/** 上游退避的累计状态挂在任务上（推进器重启也不丢）。 */
const UPSTREAM_STATE_KEY = 'upstreamWait';

/** 会话忙时的等待基数：执行器可能还在同房间跑上一波，等它空出来。 */
const BUSY_RETRY_MS = 15_000;

/**
 * 文件被占时的重试间隔。
 *
 * 比 BUSY_RETRY_MS 短：占用的持有者是真的在写文件，一次写入通常几十秒内结束；
 * 等 15 秒会让排队显得像卡住，而 5 秒只是多几次无副作用的到点唤醒。
 */
const CLAIM_RETRY_MS = 5_000;

/**
 * 哪些状态算「持有文件占用」。
 *
 * 只算**真在写**的和即将接着写的：排队（queued）不算 ——
 * 两个排队任务互相看到对方的占用就会互相等死，而它们都还没动过文件。
 * 受阻/暂停也不算：它们停在半路，此刻不会写，先让别的活过去；
 * 重新推进时会重新拿到占用。
 */
const CLAIM_HOLDING_STATES = new Set([
  STATE.running,
  STATE.verifying,
  STATE.waiting_approval,
  STATE.waiting_input,
  STATE.waiting_dependency,
]);

/** 任务声明的文件占用（旧记录可能是未规范化的写法，读时再洗一遍）。 */
function claimFilesOf(run) {
  if (!Array.isArray(run?.fileClaims) || !run.fileClaims.length) return [];
  return fileClaimList(run.fileClaims).files;
}

/** 永久受阻：不会自己再动的那种（可恢复阻塞 / 排队中都不算）。 */
function permanentlyBlocked(run) {
  return Boolean(run) && run.state === STATE.blocked && !run.recoverableBlock;
}

/**
 * 这个子任务算不算「停住了」（父任务不能干等它）。
 *
 * 判定三选一，任一成立即停住：
 *   · 自己永久受阻；
 *   · 自己的依赖里有人已永久失败 / 被取消（upstream_failed）—— 它永远不会启动；
 *   · 已被取消。
 *
 * ★ 少了第二条就是死等现场：成员 A 永久受阻，C `dependsOn: [A]` 还停在
 *   queued，旧码的 `stuck.every(blocked)` 于是恒为 false，父任务永远不结收。
 */
function isStuckLike(kid, allKids) {
  if (!kid) return false;
  if (kid.state === STATE.cancelled) return true;
  if (permanentlyBlocked(kid)) return true;
  return dependencyStatus(kid, allKids) === DEP_STATUS.upstream_failed;
}

/** 这次失败是不是「目标会话还在忙」——受管执行可以等，不能判成永久失败。 */
function isBusyOutcome(raw) {
  if (!raw) return false;
  const text = String(raw.error ?? raw.text ?? '');
  return raw.code === 'SESSION_BUSY' || /already processing|正在处理|在忙|会话正在忙/i.test(text);
}

/**
 * 独立评审（Critic）基础设施出错后的重试间隔。
 *
 * 评审员也是远端模型：超时 / 429 / 掉线都可能。这不是「交付不合格」，
 * 所以不扣返工额度、不伪造通过 —— 只是稍后重跑一次。
 */
const CRITIC_RETRY_MS = 30_000;

/**
 * 同一目标下评审连续失败几次就停下等人工。
 *
 * 没有这个上限时，一个永远不可用的评审模型会把任务永远停在「验收中」。
 */
const MAX_CRITIC_ERRORS = 3;

/**
 * @param {object} p
 * @param {object} p.taskRuns
 * @param {Function} p.execute
 * @param {Function} [p.executeMember]
 * @param {Function} [p.inspectOutcome] 只读核验未知结果
 * @param {Function} [p.verify]
 * @param {Function} [p.criticReview] 独立评审执行器（不注入 = 永不跑 Critic）
 * @param {string} [p.criticMode] off | auto | all（不传按 ORBIS_CRITIC_REVIEW）
 * @param {number} [p.maxCriticReworks] 同一目标版本内允许的评审轮数上限
 * @param {object} [p.access]
 * @param {Function} [p.abortInflight] 取消本任务在途执行（必须按任务/版本定位）
 * @param {()=>number} [p.clock]
 * @param {Function} [p.log]
 * @param {number} [p.maxStallRounds] 连续几轮**既没推进目标、也没干任何活**就阻塞（防空转）
 * @param {number} [p.maxMilestoneRounds] 连续几轮**在干活但目标始终没推进**就阻塞（长任务兜底）
 * @param {number} [p.maxSteps] 单次排空的步数上限；用尽是让出，不是停住
 */
export function createTaskSupervisor({
  taskRuns,
  execute,
  executeMember = null,
  /** 只读探测：目标执行者当前是否还在跑（宿主注入）。 */
  isExecutorBusy = null,
  inspectOutcome = null,
  verify = null,
  /**
   * 独立评审执行器（Critic）。
   *
   * ★ 不注入就完全不会跑 Critic —— 这是测试零回归的边界：
   *   `createTaskSupervisor` 多了一个**可选**能力，不需要它的调用方行为不变。
   *   生产装配在 `createTaskRuntime` 里按 `ORBIS_CRITIC_REVIEW` 注入。
   */
  criticReview = null,
  criticMode = null,
  maxCriticReworks = null,
  access = null,
  abortInflight = null,
  clock = () => Date.now(),
  log = () => {},
  maxStallRounds = 2,
  /**
   * ★ 长任务的兜底上限（两档停滞判定的第二档）。
   *
   * 第一档 `maxStallRounds` 只数「什么都没发生」的轮次 —— 真在改文件、
   * 真在出产物的轮次不算停滞，否则一个要跑几十段的长任务第 2~3 段就被判死。
   * 但「每轮都写点东西、目标却从不推进」也是一种空转，所以第二档数的是
   * 「目标没推进」（缺项没减少、没有新交付、没有申请完成）的连续轮次，给得宽。
   */
  maxMilestoneRounds = 12,
  maxSteps = 32,
  /**
   * 上游退避的阶梯与上限（注入用；生产走默认值）。
   *
   * 单测里用毫秒级阶梯，不然「等 1 分钟」得真等 1 分钟。
   */
  upstreamLadder = UPSTREAM_LADDER_MS,
  maxUpstreamWaitMs = MAX_UPSTREAM_WAIT_MS,
  /**
   * 同时最多推进几个任务。
   *
   * 传数字就是硬上限；传函数则按「这个部门有多少人」现算 ——
   * 一个 6 人部门本来就能同时跑 6 份活，固定 4 会白白吊着 2 个人。
   */
  maxConcurrency = null,
  /**
   * 上游健康度探针：返回 0..1，1 表示这条路完全正常。
   * key 失效/限流时为 0，此时并发降到 1，避免失败也并发。
   */
  upstreamHealth = null,
  /** 持久变化后通知宿主（用于客户端投影）；不参与任何判定。 */
  onChanged = null,
  /**
   * 执行者 id → 名字（只用于给用户看的文案）。
   *
   * 这一层不认识 store：原来直接写 `runner.store.getBot(...)`，
   * 而 `runner` 根本不在参数里 —— 那条「子任务全部受阻」的分支
   * 一走到就抛 ReferenceError，被外层 catch 成「推进过程出错」，
   * 用户看到的是阻塞原因变成一句内部错误。
   */
  botNameOf = null,
} = {}) {
  if (!taskRuns) throw new Error('推进器需要 TaskRunStore');
  if (typeof execute !== 'function') throw new Error('推进器需要执行器');

  /** 评审档位与轮数上限：装配时定下来，不在每轮重读环境变量。 */
  const criticSetting = Object.values(CRITIC_MODE).includes(criticMode)
    ? criticMode
    : resolveCriticMode(process.env);
  const criticReworkLimit = Number.isInteger(maxCriticReworks) && maxCriticReworks >= 0
    ? maxCriticReworks
    : MAX_CRITIC_REWORKS;
  /** 真的能跑评审吗：没注入执行器 / 关了都不跑。 */
  const criticActive = typeof criticReview === 'function' && criticSetting !== CRITIC_MODE.off;

  /** 执行者名字（拿不到就退回一个中性的称呼）。 */
  function nameOfBot(botId) {
    if (typeof botNameOf !== 'function' || !botId) return '';
    try {
      return String(botNameOf(botId) ?? '');
    } catch {
      return '';
    }
  }

  /**
   * 这件事是不是「自主推进」。
   *
   * ★ 以**根任务**为准：子任务是负责人拆出来的分工，跟着整件事走。
   *   以前只看子任务自己的标记，而子任务建出来时从不带它 ——
   *   于是成员一失败，自主重试逻辑对它完全不生效，任务直接卡在受阻。
   *   用户在任务卡上切换「自主推进」时也只改根，同样要立刻作用到整棵树。
   */
  function autonomousOf(taskRun) {
    if (!taskRun) return false;
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    return (root ?? taskRun)?.flags?.autonomous === true;
  }

  /**
   * 两档停滞判定（只读，不累加）：该不该停下来让用户看一眼。
   *
   *   · 第一档 rounds：连续几轮既没推进目标、也没改动任何东西 → 真卡住了；
   *   · 第二档 milestoneRounds：连续几段一直在干活、目标却没推进 → 可能在原地打转。
   *
   * @returns {{code:string, why:string}|null}
   */
  function stallVerdict(run) {
    const stall = run?.stall ?? {};
    const rounds = Number(stall.rounds ?? 0);
    const milestoneRounds = Number(stall.milestoneRounds ?? 0);
    const stallCap = Math.max(1, Number(maxStallRounds) || 2);
    const milestoneCap = Math.max(stallCap, Number(maxMilestoneRounds) || 12);
    if (rounds >= stallCap) {
      return {
        code: 'yield_stall',
        why: '连续 ' + rounds + ' 轮既没推进目标、也没改动任何东西，像是卡住了，需要你看一下',
      };
    }
    if (milestoneRounds >= milestoneCap) {
      return {
        code: 'milestone_stall',
        why: '已经连续 ' + milestoneRounds + ' 段在干活，但目标一直没推进（缺项没减少、没有新交付、没有申请完成），'
          + '可能在原地打转，需要你看一下',
      };
    }
    return null;
  }

  const queue = new Set();
  /** 上一轮因前置条件（残留尝试/同 Bot 占用）被挡下的任务，供诊断。 */
  const blockedByPrecondition = [];
  let draining = null;
  const running = new Set();
  const inflight = new Map(); // taskRunId → 本次进程内正在执行的标识
  /** 正在推进的任务 → 那次推进的 Promise（防止同一任务被两条路径同时推进）。 */
  const advanceLocks = new Map();
  /** 内联推进子任务时，正在被用掉的 Bot（保证同一个 Bot 不并发）。 */
  const childBusyBots = new Set();
  /** 调度器（launch）正在用掉的 Bot；内联选批时要避开它（另一半互斥）。 */
  const schedulerBusyBots = new Set();
  /**
   * 因为「根并发名额已满」而让出、正在等名额的子任务。
   *
   * 名额一空（同根某个执行收口）就立刻把它们叫醒，不必傻等满 BUSY_RETRY_MS。
   * 只放本进程的 ID：进程重启后靠 retryAt 定时器兜底，最多晚 BUSY_RETRY_MS。
   */
  const slotWaiters = new Set();

  function notify(taskRunId) {
    if (!taskRunId) return;
    queue.add(taskRunId);
    schedule();
  }

  /**
   * 调度循环：**按 Bot 负载均衡地并行**。
   *
   * ## 为什么不是严格串行
   *
   * 一个部门同时有 4 份子任务、每份由不同成员做，严格串行时它们只能一个
   * 接一个跑 —— 用户看到的是「4 个人排队干各自的活」，而实际每个成员的
   * 会话是独立的，本来就能同时跑。
   *
   * ## 为什么不能无脑并行
   *
   * 同一个 Bot 只有一个会话。两个任务同时派给它，第二个会撞
   * 「Agent is already processing」。所以**同一个 Bot 同时只跑一个**，
   * 不同 Bot 各跑各的 —— 这正好就是按执行者做的负载均衡。
   *
   * 上限：maxConcurrency（默认 4），避免一次叫起太多把机器/额度打满。
   */
  /**
   * 本轮允许同时跑几个。
   *
   * 默认按「部门人数」走：部门里有几个人，就能同时有几份活在跑。
   * 理由很直接 —— 每个成员的会话互相独立，人越多能并行的事越多；
   * 固定 4 会让 6 人部门里 2 个人干等着。
   */
  /**
   * 任务的调度优先级：数字越小越先跑。
   *
   * 来源是负责人派活时的先后（子任务的 dispatchPriority）。
   * 没排过的按 0 处理，保证「没指定顺序」不会比「明确排第一」更优先。
   */
  function priorityOf(taskRun) {
    const raw = Number(taskRun?.dispatchPriority ?? 0);
    return Number.isFinite(raw) ? raw : 0;
  }

  function concurrencyBudget() {
    const raw = typeof maxConcurrency === 'function' ? maxConcurrency() : maxConcurrency;
    const n = Number(raw);
    const want = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_CONCURRENCY;
    // ★ key 不稳定时自动降级：上游被熔断还继续开新并发，
    //   只会让更多执行一起撞墙。降到 1 让排最前的先试，成功了再加回来。
    return Math.max(1, Math.floor(want * degradeFactor()));
  }

  /**
   * 上游健康度系数（1 = 正常，0 = 完全不可用）。
   *
   * 由宿主注入探针；没注入就当作正常 —— 不让可选观测卡住主流程。
   */
  function degradeFactor() {
    if (typeof upstreamHealth !== 'function') return 1;
    try {
      const v = Number(upstreamHealth());
      if (!Number.isFinite(v)) return 1;
      return Math.min(1, Math.max(0, v));
    } catch {
      return 1;
    }
  }

  /**
   * 本轮父任务最多同时推进几个子任务。
   *
   * 取「调度预算」与「根任务预算里的并发上限」中**更紧**的那个：
   *   · 根预算的 `concurrencyLimit` 是这一个根总共能同时跑几个执行，
   *     子任务都在同一个根下面，所以不能超过它；
   *   · `concurrencyBudget()` 里已经含了 `degradeFactor()` —— 上游熔断时
   *     它降回 1，这里自然跟着缩回串行，不需要另写一套判断。
   */
  function childBatchCap(taskRun) {
    const budget = concurrencyBudget();
    const rootId = taskRun?.rootTaskId ?? taskRun?.id ?? null;
    const rootRun = rootId ? read(rootId) : null;
    const hard = Number(rootRun?.budget?.concurrencyLimit);
    const rootCap = Number.isInteger(hard) && hard > 0 ? hard : null;
    return Math.max(1, rootCap === null ? budget : Math.min(budget, rootCap));
  }

  /**
   * 这一批还能不能再放进这个子任务。
   *
   * 两条硬不变量：
   *   · **同 Bot 互斥**：一个成员只有一个会话，同时派两份会撞
   *     「Agent is already processing」；
   *   · **同 tick 文件互斥**：两个子任务在同一 tick 都还没进 `running` 时，
   *     `fileClaimBlocker` 看不见对方（它只算「正在持有」的），于是两份活会同时
   *     读写同一个文件 —— 这里在选批时就按声明路径错开，重登的留到下一波。
   */
  function canBatchKid(kid, busyBots, claimedFiles) {
    const botId = kid.owner?.leadBotId ?? null;
    if (botId && (busyBots.has(botId) || childBusyBots.has(botId))) return false;
    const files = claimFilesOf(kid);
    if (files.length && claimsOverlap(files, [...claimedFiles])) return false;
    return true;
  }

  /**
   * 这个子任务现在值不值得再推一次。
   *
   * 受阻的不算「可跑」：它的 `retryAt` 还没到就不该反复重派，
   * 否则父任务会在这一轮里把同一个受阻子任务重试到步数上限。
   * 到点（或可恢复阻塞到期）的才算 —— 那时 `runTaskInner` 会先解阻再跑。
   *
   * ★ 依赖不在 `ready` 也一律不算「可跑」：
   *   · waiting         前置还在跑 —— 抢跑就会拿半份前置产物开干；
   *   · checkpoint      前置都完成了，但设了「先由负责人把关」；
   *   · upstream_failed 前置已永久受阻 —— 下游绝不启动。
   *   旧码只看 terminal/retryAt，于是 DAG 下游会被抢跑、或者在上游已死的
   *   情况下空转重试到步数上限。
   */
  function kidRunnableNow(kid, allKids = null) {
    if (terminal(kid)) return false;
    if (allKids && dependencyStatus(kid, allKids) !== DEP_STATUS.ready) return false;
    if (kid.state !== STATE.blocked) return true;
    const due = Number(kid.retryAt);
    return Number.isFinite(due) && due <= clock();
  }

  /**
   * 这个子任务的依赖此刻没就位吗。
   *
   * 调度器入口用它再挡一次：队列里可能还留着依赖就位之前的事件，
   * 而 `runTask(kid)` 不经过父任务的选批判定。
   *
   * ★ 这里按 id 直读依赖，不做全表扫：调度器的每个 tick 都会调它，
   *   `childrenOf()` 是一次 listAll 全扫，乘上队列长度会把热路径拖慢。
   */
  function depsNotReady(kid) {
    if (!kid?.parentTaskId) return false;
    const deps = Array.isArray(kid.dependsOn) ? kid.dependsOn : [];
    for (const depId of deps) {
      const dep = read(depId);
      // 读不到 / 已永久失败 / 还在推进：都不放行（checkpoint 另算一道闸）
      if (!dep || dep.state !== STATE.completed) return true;
    }
    return kid.checkpointBeforeRun === true && !kid.checkpointApprovedAt;
  }

  /**
   * 按负责人安排的优先级挑出本批子任务（最多 `cap` 个）。
   *
   * 优先级数字小的先跑；没排过的按 0，保证「没指定顺序」不会比
   * 「明确排第一」更优先。
   */
  function pickKidBatch(liveKids, cap, allKids = null) {
    const limit = Math.max(0, Math.floor(Number(cap) || 0));
    if (!limit) return [];
    // ★ 从调度器正在用掉的 Bot 起步：`canRun()` 已经会避开 `childBusyBots`（内联在用），
    //   这里补齐反向那一半 —— 内联也要避开调度器正在跑的会话，否则两条路径各看各的，
    //   同一份活会被派给同一个 Bot 两次（同一个会话只有一个，第二个必然撞）。
    const busyBots = new Set(schedulerBusyBots);
    const claimedFiles = new Set();
    const batch = [];
    const ordered = [...liveKids].sort((a, b) => priorityOf(a) - priorityOf(b));
    for (const kid of ordered) {
      if (batch.length >= limit) break;
      if (!kidRunnableNow(kid, allKids ?? liveKids)) continue;
      if (!canBatchKid(kid, busyBots, claimedFiles)) continue;
      batch.push(kid);
      const botId = kid.owner?.leadBotId ?? null;
      if (botId) busyBots.add(botId);
      for (const file of claimFilesOf(kid)) claimedFiles.add(file);
    }
    return batch;
  }

  /**
   * 内联推进一个子任务一次。
   *
   * 同 Bot 互斥的登记与释放都在这里（调度器的 `launch()` 里另有一份，两处必须
   * 用同一个 `childBusyBots` —— 否则父任务内联推进绕过了调度器的那份）。
   */
  async function runKidOnce(kid) {
    const kidBot = kid.owner?.leadBotId ?? null;
    if (kidBot && childBusyBots.has(kidBot)) return { status: 'wait', why: '成员正在别的分工上干活' };
    if (kidBot) childBusyBots.add(kidBot);
    try {
      return await runTask(kid.id);
    } finally {
      if (kidBot) childBusyBots.delete(kidBot);
    }
  }

  /**
   * 名额空出来了：把同根里等名额的子任务立刻叫醒。
   *
   * 只动「因为并发名额满而让出」的那些（`slotWaiters` 精确登记）；
   * 上游退避、文件占用、执行者忙各有自己的节奏，一律不碰。
   *
   * `justFinished` 是刚结束的那个任务：它自己也在等名额时不能叫醒自己，
   * 否则「撞门 → 让出 → 唤醒自己 → 又撞门」会变成死循环。
   */
  async function wakeSlotWaiters(taskRun, justFinished = null) {
    if (!slotWaiters.size) return 0;
    const rootId = taskRun?.rootTaskId ?? taskRun?.id ?? null;
    if (!rootId) return 0;
    let woken = 0;
    for (const id of [...slotWaiters]) {
      if (justFinished && id === justFinished) continue;
      const run = read(id);
      if (!run || terminal(run) || (run.rootTaskId ?? run.id) !== rootId) {
        if (!run || terminal(run)) slotWaiters.delete(id);
        continue;
      }
      slotWaiters.delete(id);
      // 让出时排的是 BUSY_RETRY_MS，这里直接抹掉等它到点的那段：名额已经有了。
      await patch(id, { retryAt: null });
      notify(id);
      woken += 1;
    }
    return woken;
  }

  function schedule() {
    if (draining) return;
    draining = Promise.resolve()
      .then(async () => {
        // 本轮正在跑的，按 Bot 登记：同一个 Bot 不并行。
        const active = new Map(); // taskRunId → Promise
        const busyBots = new Set();
        // 被前置条件挡住、本轮起不来的任务（不留在队列里，避免活锁）
        const deferred = [];

        const canRun = (id, taskRun) => {
          if (running.has(id)) return false;
          // ★ 已有在途尝试就别再派一次。
          //
          //   原来只查 running 集合（本进程正在推进的任务）。但一个任务
          //   可能在别的路径上刚被推进到 running 并登记了尝试，
          //   此时再 dispatch 会被状态机拒绝（执行中 不接受 dispatch），
          //   那条错误被当成永久失败，任务就被毒化成 blocked ——
          //   用户看到的是「受阻」，原因是一句内部错误串。
          const active = (taskRun?.attempts ?? []).filter((a) => a.state === 'registered');
          // ★ 只拦「本进程真在跑」的那些。崩溃/重启残留的 registered
          //   必须放行，让 runTask 走核验分支给它一个结论；
          //   否则任务被永久判为「有执行在途」，谁也不会再来结算。
          if (active.length && inflight.has(id)) return false;
          const botId = taskRun?.owner?.leadBotId ?? null;
          if (botId && busyBots.has(botId)) return false;
          // ★ 同一个 Bot 也不能跟「父任务内联推进」撞车：
          //   内联那条路用的是 `childBusyBots`，调度器只看自己的 `busyBots` ——
          //   两份各看各的，就会把同一份活派给同一个会话两次。
          if (botId && childBusyBots.has(botId)) return false;
          // ★ 受控 DAG：依赖没就位的子任务一律不放行。
          //
          //   队列里可能还留着“依赖就位前”的事件（例如上一步收尾时的
          //   `notify(kid.id)`），而调度器直接 `runTask(kid)` 会绕过父任务
          //   那条 `kidRunnableNow` 判据 —— checkpoint 岗位于是形同虚设，
          //   下游会在前置刚完成时抢跑。这里在真正的入口再挡一次（fail-closed）。
          if (taskRun?.parentTaskId && depsNotReady(taskRun)) return false;
          return true;
        };

        // ★ 名额判断统一由调用方用本轮计数做（见下面 while 循环里的 slots）。
        //
        //   原来这里也查一次 concurrencyBudget()，而它会走
        //   maxConcurrency -> concurrencyOf，每次都全量扫一遍 taskruns。
        //   每个排队项因此被扫两次（这里一次、循环里一次），一轮共 2Q 次。
        //   挪到调用方后每轮只算一次。
        const launch = (id, taskRun) => {
          const botId = taskRun?.owner?.leadBotId ?? null;
          queue.delete(id);
          running.add(id);
          if (botId) { busyBots.add(botId); schedulerBusyBots.add(botId); }
          const p = (async () => {
            let outcome = null;
            try {
              outcome = await runTask(id);
            } catch (err) {
              log('推进任务失败：', id, err?.message || err);
              // ★ 抛异常不能让任务静死。
              //
              //   原来只打一行日志：任务停在当时的中间态（常见是 verifying），
              //   retryAt / blockedAt / blockedReason 全空，idle() 却立即返回 ——
              //   宿主以为跑完了，而任务再也不会被唤醒，用户只看到「验收中」转圈。
              //   这里把它落到明确的阻塞状态并写明原因，用户能看见、能处理。
              try {
                const now = read(id);
                if (now && !['blocked', 'completed', 'cancelled'].includes(now.state)) {
                  await block(id, '推进过程出错：' + String(err?.message ?? err).slice(0, 120));
                }
              } catch {}
            } finally {
              running.delete(id);
              if (botId) { busyBots.delete(botId); schedulerBusyBots.delete(botId); }
              active.delete(id);
              // ★ 只有「真的收口了」才算名额空出来。
              //
              //   不能无条件叫醒：一个因为名额满而让出的任务，它自己的 finally
              //   就会把自己再叫醒一次 —— 名额没空，于是又撞门、又让出、又唤醒，
              //   两个等待者能这样互相唤醒到进程堆爆（实测直接 OOM）。
              if (SLOT_FREED.has(outcome?.status)) wakeSlotWaiters(taskRun, id).catch(() => {});
              // 有人空出来就继续排，不用等整批做完。
              setImmediate(() => schedule());
            }
          })();
          active.set(id, p);
          return true;
        };

        while (queue.size) {
          let launched = false;
          deferred.length = 0;
          // ★ 每轮只算一次并发预算。
          //
          //   concurrencyBudget() 会读 maxConcurrency()，而它是
          //   task-runtime 的 concurrencyOf —— 每次全量扫一遍 taskruns
          //   只为数「部门里有几个人」。原来每个排队项都要扫两次。
          //   计算语义（含 degradeFactor）完全不变，只是采样频率降低。
          const budget = concurrencyBudget();
          // 本轮剩余名额用本地计数维护。
          // active.size 本身也会随 launch 同步加一，但显式 slots 让
          // 「本轮最多放行 budget - active.size 个」成为看得见的规则，
          // 不再依赖 launch 保持同步登记这个隐含前提。
          let slots = budget - active.size;
          // ★ 按负责人安排的优先级取下一批：数字小的先跑。
          //   负责人用 assign_member_task / @ 派活时的先后就是优先级 ——
          //   他说「先交首批，别等全量」，这个顺序必须真的影响调度。
          const ordered = [...queue]
            .map((id) => ({ id, taskRun: read(id) }))
            .filter((it) => it.taskRun)
            .sort((a, b) => priorityOf(a.taskRun) - priorityOf(b.taskRun));
          for (const { id } of ordered) {
            if (slots <= 0) break;
            const taskRun = read(id);
            if (!taskRun) { queue.delete(id); continue; }
            if (!canRun(id, taskRun)) { deferred.push(id); continue; }
            // 放行一个就占一个名额
            if (launch(id, taskRun)) { launched = true; slots -= 1; }
          }
          // 读不到的（已被删/损坏）清出队列，别卡住循环
          for (const id of [...queue]) if (!read(id)) queue.delete(id);
          if (!launched) {
            // 剩下的都被「同 Bot 在跑」或并发上限挡住：等有执行结束再说。
            if (!active.size) {
              // ★ 没有任何在飞的执行，却一个也起不来 —— 说明这些任务
              //   被 canRun 永久拒绝了（典型：崩溃残留的 registered 尝试）。
              //
              //   必须先清出队列再退出，否则 finally 里看到 queue 非空又
              //   立刻 schedule()，形成纯微任务活锁：事件循环永远拿不到
              //   机会，CPU 打满、进程只能 SIGKILL。实测 95% CPU 持续 >60s。
              for (const keep of [...queue]) queue.delete(keep);
              blockedByPrecondition.push(...deferred);
              break;
            }
            await Promise.race([...active.values()]);
          }
        }
        // 让还在跑的收尾，保证 idle() 语义不变
        if (active.size) await Promise.allSettled([...active.values()]);
      })
      .finally(() => {
        draining = null;
        if (queue.size) schedule();
      });
  }

  async function idle() {
    while (draining) await draining.catch(() => {});
    return true;
  }

  function read(taskRunId) {
    const loaded = taskRuns.read(taskRunId);
    return loaded?.status === 'found' ? loaded.taskRun : null;
  }

  function allRuns() {
    const scan = taskRuns.listAll?.();
    return scan?.taskRuns ?? scan ?? [];
  }

  /** 事务内归约。旧版本结果按它自己的版本归档，不改新目标。 */
  async function settle(taskRunId, event) {
    const out = await taskRuns.mutate(taskRunId, {
      mutate: (current) => {
        if (!current) return { __reject: { ok: false, code: 'not_found', text: '任务不存在' } };
        const reduced = reduceTaskRun(current, { ...event, sequence: current.sequence + 1 });
        if (!reduced.ok) return { __reject: reduced };
        return reduced.taskRun;
      },
    });
    if (out.ok && typeof onChanged === 'function') onChanged(taskRunId);
    return out.ok ? { ok: true, taskRun: out.taskRun } : { ok: false, code: out.code, text: out.text };
  }

  async function patch(taskRunId, fields) {
    const out = await taskRuns.mutate(taskRunId, {
      mutate: (current) => (current ? { ...current, ...fields, updatedAt: clock() } : null),
    });
    if (out.ok && typeof onChanged === 'function') onChanged(taskRunId);
    return out.ok ? { ok: true } : { ok: false, text: out.text ?? out.code };
  }

  /**
   * 不可恢复的失败：立即停下，不再走自主重试 / 交回空转。
   *
   * 记 `nonRetriableBlock`（供父任务与面板判定），清掉 `retryAt` /
   * `recoverableBlock` / `nextAction`，并把原因写进 `blockedReason`：
   * 用户要看得出「已经停止自动重试」，而不是以为系统还在努力。
   */
  async function stopForNonRetriable(taskRunId, fatal, detail = '') {
    const at = clock();
    await patch(taskRunId, {
      nextAction: null, retryAt: null, recoverableBlock: null,
      nonRetriableBlock: { kind: fatal.kind, why: fatal.why, at },
    });
    const why = '不可恢复的失败（' + fatal.kind + '）：' + fatal.why
      + '。已立即停止自动重试，不会反复空转'
      + (detail ? '；原始说明：' + String(detail).slice(0, 120) : '');
    await block(taskRunId, why);
    // ★ 归约后任务通常已经是 blocked，`block()` 见到 blocked 会提前返回 ——
    //   这里直接把「为什么停」写进 flags，否则用户看到的还是上游那句原始报错。
    const now = read(taskRunId);
    if (now) {
      await patch(taskRunId, {
        flags: { ...(now.flags ?? {}), blockedAt: clock(), blockedReason: why },
      });
    }
    log('不可恢复，立即停下：', taskRunId, fatal.kind);
    return { status: 'blocked', why: 'non_retriable_' + fatal.kind, kind: fatal.kind };
  }

  /** 明确阻塞；可恢复原因单独记，便于恢复时解除。 */
  async function block(taskRunId, why, recoverable = null, retryAt = null) {
    const current = read(taskRunId);
    if (!current || [STATE.blocked, STATE.completed, STATE.cancelled].includes(current.state)) return;
    await settle(taskRunId, {
      type: EVENT.blocked, revision: current.revision, at: clock(),
      reason: String(why).slice(0, 300),
    });
    // ★ 注意：这里把 `retryAt` 清成 null 了（阻塞 = 不再自动重排）。
    //   上游可恢复阻塞需要保留到期时间，所以它显式传第三、四个参数，
    //   而不是「先 block 再 patch」—— 那种写法一旦有人重排顺序就静默失效。
    await patch(taskRunId, {
      nextAction: null,
      retryAt: Number.isFinite(retryAt) ? retryAt : null,
      ...(recoverable ? { recoverableBlock: recoverable } : {}),
    });
  }

  /**
   * 上游瞬时故障的可恢复阻塞：快速重试用尽后不判死，改排**分钟级**退避。
   *
   * 三件事必须一起做，少一件就白做：
   *   1. `recoverableBlock: 'upstream'` —— 恢复/唤醒逻辑靠它区分「等上游」与「真卡死」；
   *   2. `retryAt` —— 到点才能真正醒（且 `block()` 会把它清空，所以必须显式传）；
   *   3. 累计等待封顶 —— 等超过 2 小时就不是「上游抽风」了，如实阻塞给用户看。
   *
   * @returns {{status:'retry_scheduled'|'blocked', dueAt?:number, why:string, waitedMs:number}}
   */
  async function scheduleUpstreamRetry(taskRunId, { why = '', waitedMs = 0 } = {}) {
    const current = read(taskRunId) ?? {};
    const prev = current[UPSTREAM_STATE_KEY] ?? {};
    const attempt = Number(prev.attempt ?? 0);
    const waited = Number(prev.waitedMs ?? waitedMs ?? 0);
    const nextDelay = upstreamLadder[Math.min(attempt, upstreamLadder.length - 1)];
    if (!Number.isFinite(nextDelay) || waited + nextDelay > maxUpstreamWaitMs) {
      // 到上限：清掉累计状态，如实阻塞（不再自动排）
      const reason = `上游持续不可用（已累计等待 ${Math.round(waited / 60_000)} 分钟）：${String(why).slice(0, 120)}`;
      await block(taskRunId, reason, null);
      // block() 在「已经是 blocked」时会提前返回；而这里恰恰是常见情况
      // （上一轮就是受阻等上游）。所以清可恢复标记与到期时间必须显式落盘，
      // 否则任务会永远停在「等上游」——再也不会有人来排、也不会有人来解。
      await patch(taskRunId, {
        [UPSTREAM_STATE_KEY]: null,
        recoverableBlock: null,
        retryAt: null,
        flags: { ...(read(taskRunId)?.flags ?? {}), blockedAt: clock(), blockedReason: reason },
      });
      // ★ 父任务这时才知道「等不到了，该你自己处理」。
      //   不退避到上限的那条路上，子任务是靠「可恢复阻塞 → 恢复后自己醒」
      //   推进的；一旦转成永久阻塞，没有任何定时器会再叫醒父任务，
      //   它就会一直悬在 queued 等一个永远不来的交付。
      notifyParent(read(taskRunId) ?? { id: taskRunId });
      return { status: 'blocked', why: 'upstream_exhausted', waitedMs: waited };
    }
    const dueAt = clock() + nextDelay;
    const waitText = nextDelay < 60_000
      ? `${Math.round(nextDelay / 1000)} 秒`
      : `${Math.round(nextDelay / 60_000)} 分钟`;
    await patch(taskRunId, {
      [UPSTREAM_STATE_KEY]: { attempt: attempt + 1, waitedMs: waited + nextDelay, at: clock() },
      nextAction: null,
      // ★ 快速重试的计数**不清**：清掉的话下一次失败又能白拿 10 次快速重试，
      //   分钟级退避就永远轮不到（每轮都从「第 1 次」重新开始）。
      //   这一段真的跑通时（ok 路径）才会把 retry 清空。
    });
    const reason = `上游限流/临时故障，${waitText}后自动继续：${String(why).slice(0, 120)}`;
    const alreadyBlocked = current.state === STATE.blocked;
    // block() 里会把 retryAt 清空 —— 上游可恢复阻塞显式把到期时间传进去
    await block(taskRunId, reason, 'upstream', dueAt);
    if (alreadyBlocked) {
      // 已经 blocked 时 block() 会提前返回（不重复发 blocked 事件），
      // 但到期时间与可恢复原因必须落盘，否则定时唤醒读不到。
      await patch(taskRunId, {
        recoverableBlock: 'upstream',
        retryAt: dueAt,
        flags: { ...(read(taskRunId)?.flags ?? {}), blockedAt: clock(), blockedReason: reason },
      });
    }
    setTimer(dueAt, taskRunId);
    log(`上游退避：${taskRunId} 第 ${attempt + 1} 档，${waitText}后再试（累计 ${Math.round((waited + nextDelay) / 1000)}s）`);
    return { status: 'retry_scheduled', dueAt, why: 'upstream_backoff', waitedMs: waited + nextDelay };
  }

  function remainingOf(taskRun) {
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    if (!root?.budget) return Number.POSITIVE_INFINITY;
    if (root.budget.maxRuns === null || root.budget.maxRuns === undefined) return Number.POSITIVE_INFINITY;
    // 以账本为权威：工厂已不再写 budget.usedRuns。
    return remainingRuns(root.budget, root.attempts?.length ?? 0);
  }

  /**
   * 根上还剩多少 token 预算（不限额/没配 → Infinity）。
   *
   * 与 `remainingOf` 分开：次数以账本为权威，token 以**结算累计**
   * （`budget.usedTokens`，由根事务幂等累加）为权威 —— 两者口径不同。
   */
  function remainingTokensOf(taskRun) {
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    const max = root?.budget?.maxTokens;
    if (!Number.isInteger(max) || max <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, max - Number(root?.budget?.usedTokens ?? 0));
  }

  /**
   * 分配未用过的执行身份。
   *
   * 本任务已用 ID = 本任务账本 + 本任务本地槽 + **根上归属本任务的全部历史槽**
   * （含 refunded/settled）。已退款身份绝不复活；别的子任务的 ID 不参与互斥。
   */
  function usedAttemptIds(taskRun) {
    const used = new Set();
    for (const attempt of taskRun.attempts ?? []) used.add(attempt.attemptId);
    for (const slot of Object.values(taskRun.attemptSlots ?? {})) used.add(slot.attemptId);
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    for (const slot of Object.values(root?.attemptSlots ?? {})) {
      if (slot.taskRunId === taskRun.id) used.add(slot.attemptId);
    }
    return used;
  }

  function nextAttemptId(taskRun) {
    const used = usedAttemptIds(taskRun);
    const prefix = 'a_' + taskRun.id + '_r' + taskRun.revision + '_';
    let n = 1;
    while (used.has(prefix + n)) n += 1;
    return prefix + n;
  }

  /** 祖先暂停/取消/改版：任何下游启动前先看。 */
  function ancestorBlocked(taskRun) {
    let cur = taskRun;
    const seen = new Set();
    while (cur?.parentTaskId && !seen.has(cur.parentTaskId)) {
      seen.add(cur.parentTaskId);
      const parent = read(cur.parentTaskId);
      if (!parent) break;
      if (parent.state === STATE.cancelled) return { blocked: true, paused: false, why: '祖先任务已取消' };
      if (PAUSED.has(parent.state)) return { blocked: true, paused: true, why: '祖先任务已暂停' };
      if ((cur.parentRevision ?? parent.revision) !== parent.revision) {
        return { blocked: true, paused: false, why: '祖先目标已改版' };
      }
      cur = parent;
    }
    return { blocked: false };
  }

  /** 重启后「在途」= 已登记但本进程没有执行；这类要核验，不能当正常在途等。 */
  function isRestartUnknown(taskRun) {
    if (inflight.has(taskRun.id)) return false;
    const active = (taskRun.attempts ?? []).filter((a) => a.state === 'registered');
    if (!active.length) return false;
    return true;
  }

  async function runTask(taskRunId) {
    // ★ 同一个任务不能被两条路径同时推进。
    //
    //   父任务推进时会递归 runTask(child)，而调度器也可能同时在跑这个
    //   child（它的 notify 到了）。两边各看到一份过期快照、各派一次
    //   dispatch，第二个必然被状态机拒（执行中 不接受 dispatch），
    //   那条拒绝被当成永久失败 —— 任务就变成「受阻」，原因是内部错误串。
    //
    //   这里用 advanceLocks 做重入保护：已经在推进的，直接让调用方等它。
    if (advanceLocks.has(taskRunId)) {
      return advanceLocks.get(taskRunId);
    }
    const token = Promise.resolve().then(() => runTaskInner(taskRunId));
    advanceLocks.set(taskRunId, token);
    try {
      return await token;
    } finally {
      advanceLocks.delete(taskRunId);
    }
  }

  async function runTaskInner(taskRunId) {
    let yielded = false;
    // 本轮唤醒里已经推进过（或试过但没成）的子任务：同一轮不反复重派。
    // 上游退避/名额满/文件占用都会把子任务排到未来，反复重派只会原地空转。
    const triedKids = new Set();
    // ★ 连续无实质进展的唤醒次数上界。
    //
    //   maxSteps 只限制"一次唤醒里走多少步"，用尽后让出、下一个事件又唤醒它。
    //   如果每个事件都让它跑一轮、每轮都产出新文件但目标始终不达成，
    //   就会无界运行（实测高频事件下一直跑到进程被外部杀掉）。
    //
    //   这里用"本轮前后 progressSignature 是否变化"判定：连续 N 轮没变化
    //   就明确停下并说明原因，而不是无限重跑。
    const stallLimit = Math.max(1, Number(maxStallRounds) || 2);
    //   ★ 本轮唤醒里是否已经把「全部子任务都在等 checkpoint」交给负责人把关过。
    //     一次唤醒只交一次：否则负责人不做任何事时，循环会在 maxSteps 内
    //     把同一份清单反复丢给他。
    let checkpointPassed = false;
    // ★ 收口处主动回到顶部（让 checkpointOnly 接手）也只做一次，防死循环。
    let checkpointSkipped = false;
    for (let step = 0; step < maxSteps; step += 1) {
      const taskRun = read(taskRunId);
      if (!taskRun) return { status: 'missing' };
      if (taskRun.state === STATE.cancelled) return { status: 'cancelled' };
      if (taskRun.state === STATE.completed && taskRun.delivery) return { status: 'completed' };

      // 本人暂停：直接等待，不遍历/推进任何子任务
      if (PAUSED.has(taskRun.state)) return { status: 'wait', why: '任务暂停' };

      // ★ 依赖入口守卫：任何直接 `runTask(kid.id)` 的路径都不能绕过选批判定。
      //
      //   调度器的 `canRun` 已挡一次，但还会有别的入口（测试、面板上的
      //   “继续这一份”、以后新增的重试按钮）直接按 id 推进某个子任务 ——
      //   漏一条就是下游抢跑，或 checkpoint 形同虚设。这里在唯一的口子上再核。
      if (taskRun.parentTaskId && depsNotReady(taskRun)) {
        return { status: 'wait', why: '等待前置子任务或负责人放行' };
      }

      const ancestor = ancestorBlocked(taskRun);
      if (ancestor.blocked) {
        await patch(taskRunId, { nextAction: null });
        return ancestor.paused
          ? { status: 'wait', why: ancestor.why }
          : { status: 'cancelled', why: ancestor.why };
      }

      // 结果未知（重启后 / 已 started 未结算）：先核验
      const unknown = inflight.has(taskRun.id) ? [] : unknownOf(taskRun);
      // ★ 重启后残留的「registered」尝试，即使状态是 running 也要核验。
      //
      //   原来的条件排除了 running，而崩溃残留的表现恰恰就是
      //   state=running + 一条没结算的 registered 尝试 —— 于是它永远
      //   走不到核验分支：canRun 一直拒绝派发、runTask 又不出结论，
      //   任务静静躺在那里永远不动（修掉活锁之后暴露出来的正是这个）。
      //   inflight 里没有它，就说明本进程没在跑它，那它就是残留。
      if (unknown.length || (!inflight.has(taskRun.id) && isRestartUnknown(taskRun))) {
        const resolved = await inspectAndSettle(taskRun, {
          attemptId: unknown[0]?.attemptId ?? (taskRun.attempts ?? []).find((a) => a.state === 'registered')?.attemptId,
          slot: unknown[0] ?? null,
        });
        if (!resolved) return { status: 'blocked', why: 'unknown' };
        continue;
      }

      // 子任务
      const kids = childrenOf(taskRuns, taskRun);
      const liveKids = kids.filter((k) => !terminal(k));
      // ★ 全部未终态子任务都在等负责人放行 checkpoint → 这一轮交给负责人把关。
      //
      //   它们不是受阻、也不是在推进：它们在等一句「可以开始了」。
      //   旧行为是落到下面 return wait → 父任务停在「排队中」，而负责人
      //   从来不会被叫醒，checkpoint 就成了永久死锁。
      //   这里不入派活分支，直接落到下方的负责人步骤，提示词里会列清
      //   待审的子任务与它们的前置产物。
      //
      //   ★ 判据要拿**全部**子任务（含已完成的）：依赖状态必须能在同父全集里
      //     解析出前置，只拿未终态列表会把“前置已完成”误判成“上游不见了”。
      //   ★ 也不能只比数量：三级流水线 A → B[checkpoint] → C 里，A 完成后
      //     未终态是 [B(等放行), C(等 B)]，数量永远不相等 —— 旧判据在这里
      //     恒为 false，父任务于是永久停在排队中（审计 P1-1）。
      const checkpointOnly = liveKids.length > 0
        && !checkpointPassed
        && isWaitingOnlyOnCheckpoints(kids);
      if (checkpointOnly) {
        checkpointPassed = true;
        log('子任务都在等负责人放行 checkpoint，本轮交给负责人把关', taskRunId, liveKids.length);
      }
      if (liveKids.length && !checkpointOnly) {
        let progressed = false;
        // ★ 子任务按「受控并发」推进，不再一份一份串着来。
        //
        //   部门里 4 个人各领一份分工时，串行推进等于让他们排队上；而每个
        //   成员的会话本来就互相独立。并发度由三样东西共同决定：
        //     · `concurrencyBudget()`（部门人数；上游熔断时降回 1）；
        //     · 根预算里的 `concurrencyLimit`（同一个根总共能同时跑几个）；
        //     · 同 Bot 互斥与文件互斥（真正硬的那两条不变量）。
        const cap = childBatchCap(taskRun);
        // 本批之外已经试过的不再重复试；下一波（有进展）时才清空。
        const batch = pickKidBatch(liveKids.filter((k) => !triedKids.has(k.id)), cap, kids);
        let batchResults = [];
        if (batch.length) {
          // ★ 逐个子任务独立收尾：一个抛异常不能带走同批里别人的进度。
          batchResults = await Promise.allSettled(batch.map((kid) => runKidOnce(kid)));
        }
        for (let i = 0; i < batch.length; i += 1) {
          const kid = batch[i];
          triedKids.add(kid.id);
          const settled = batchResults[i];
          if (!settled || settled.status === 'rejected') {
            log('推进子任务失败：', kid.id, settled?.reason?.message || settled?.reason);
            continue;
          }
          const out = settled.value ?? { status: 'wait' };
          // ★ 受阻的子任务**不在这里提前返回**。
          //
          //   原来受阻和等待一样直接 return wait —— 于是下面那段
          //   「子任务全部受阻 → 说清谁卡住了」永远走不到：
          //   父任务停在「排队中」，停滞计数不涨，也没有任何人会再唤醒它。
          //   实机：调研任务的成员一次超时后受阻，根任务在「排队中」挂了 5 小时，
          //   直到用户手动取消。先看完其它子任务，再统一判定是不是全卡住了。
          //
          //   并发推进之后「等待」也一并不能提前返回：同批里另一个子任务
          //   可能正好收口，提前返回会把这一批的结果丢掉。
          if (out.status === 'blocked' || out.status === 'wait') continue;
          if (out.status === 'completed' || out.status === 'done' || out.status === 'cancelled') {
            progressed = true;
          }
        }
        // ★ 本批真的收口了 → 根名额已经空出，立刻叫醒等名额的兄弟。
        //   必须写在设 `progressed` 的循环**之后**：写在前面时 progressed 恒为
        //   false，这句永远不执行，等着名额的子任务只能傻等满 BUSY_RETRY_MS。
        if (progressed) await wakeSlotWaiters(taskRun);
        if (!progressed) {
          // ★ 本批之外还有「从没试过、现在就能跑」的子任务 → 接着下一波。
          //
          //   并发度可能小于待办数（根预算紧 / 上游降级 / 两个子任务抢同一个 Bot）。
          //   这时干等着没有任何意义：能跑的先跑，跑不上的等事件。
          const parentNow = read(taskRunId) ?? taskRun;
          const allKidsNow = childrenOf(taskRuns, parentNow);
          const pending = allKidsNow.filter((k) => !terminal(k) && !triedKids.has(k.id));
          if (pickKidBatch(pending, cap, allKidsNow).length) continue;
          // ★ 子任务全部停住时，父任务不能无限「等」。
          //
          //   原来直接 return wait：父任务永久停在 queued，停滞计数不增加，
          //   也不产生任何给用户看的结论。用户看到「准备中」却永远没有下文。
          //
          //   子任务自己受阻（blocked）不是父任务在"推进中"，
          //   而是整件事卡住了 —— 要说清是谁卡住、为什么。
          const stuck = allKidsNow.filter((k) => !terminal(k));
          // ★ 「可恢复阻塞」不算永久受阻。
          //
          //   上游退避（`recoverableBlock: 'upstream'`）中的子任务到点会自己醒，
          //   把它当成「全部受阻」会让父任务：自主模式下把还在等的分工**取消掉**
          //   交回负责人重排（等于把正在自愈的活掐死），非自主模式直接阻塞父任务。
          //   所以只要还有一个子任务在可恢复阻塞里，就老实等着它恢复。
          // ★ 子任务共享根预算：它因为 token 用尽进了 paused_budget 时，父任务也要跟着停，
          //   否则父任务会停在「排队中」傻等一个再也不会自己动起来的分工。
          //   （子任务自己先跑完 verify/deliver —— 零 token 的验收与交付照旧能做。）
          if (stuck.length && stuck.every((k) => k.state === STATE.paused_budget)) {
            const parentNow2 = read(taskRunId) ?? taskRun;
            const rootId = parentNow2.rootTaskId ?? parentNow2.id;
            const rootBudget = (rootId === parentNow2.id ? parentNow2 : read(rootId))?.budget ?? {};
            const paused = await settle(taskRunId, {
              type: EVENT.budget_exhausted, revision: parentNow2.revision, at: clock(),
              reason: `Token 预算已用尽（${rootBudget.usedTokens ?? 0}/${rootBudget.maxTokens}）`,
            });
            if (paused.ok) {
              await patch(taskRunId, { nextAction: null });
              return { status: 'paused_budget', why: 'children_tokens_exhausted' };
            }
          }
          const resumable = stuck.find((k) => k.state === STATE.blocked && k.recoverableBlock);
          if (resumable) {
            return {
              status: 'wait',
              why: '子任务在等上游恢复（可恢复阻塞）',
              child: resumable.id,
            };
          }
          // ★ 全部子任务只剩「等负责人放行」这一件事 → 不能 return wait。
          //
          //   本轮开头那道 `checkpointOnly` 看的是**进批之前**的状态，
          //   批里的活收口之后才浮出来的审批位（例如某个前置刚好的 B）
          //   会走到这里：直接 return 就让父任务停在排队中，
          //   负责人永远不会被叫醒，B 和它下游的 C 一起死锁（审计 P1-1）。
          //   不返回，回到循环顶部 —— 那里会用同一个判据把这轮交给负责人。
          if (!checkpointPassed && !checkpointSkipped && isWaitingOnlyOnCheckpoints(allKidsNow)) {
            checkpointSkipped = true;
            log('子任务只剩等放行，回到循环顶部交给负责人把关', taskRunId);
            continue;
          }
          // ★ 全部子任务都停住了（永久受阻 / 被上游拖死 / 被取消）→ 交回负责人或如实阻塞。
          //   旧码只算 `state === blocked`：一个成员永久受阻、它的下游还停在 queued 时
          //   `stuck.every(blocked)` 恒为 false，父任务于是永久死等一个永远不会启动的分工。
          if (stuck.length && stuck.every((k) => isStuckLike(k, allKidsNow))) {
            const outcome = await handBackBlockedChildren({ parentNow, stuck, allKidsNow });
            if (outcome.action === 'continue') continue;
            return outcome;
          }
          return { status: 'wait', why: '子任务推进中' };
        }
        // 有子任务收口 → 下一波重新试（名额与文件占用可能刚松开）
        triedKids.clear();
        continue;
      }

      const action = planNextAction(taskRun, {
        now: clock(), remainingRuns: remainingOf(taskRun), remainingTokens: remainingTokensOf(taskRun),
        maxStallRounds, maxMilestoneRounds, restartUnknown: false,
        // 本进程是否真在跑这条 registered 尝试；不在就是崩溃/重启残留。
        isInflight: (run) => inflight.has(run.id),
      });

      if (action.kind === NEXT.done) return { status: 'done', why: action.why };
      if (action.kind === NEXT.blocked) {
        await block(taskRunId, action.why);
        return { status: 'blocked', why: action.why };
      }
      if (action.kind === NEXT.wait) {
        const applied = await reconcileEarlyControls({ taskRuns, taskRunId, settle, patch, notify, clock });
        if (applied) continue;
        if (action.gate?.kind === 'dependency') {
          const released = await releaseDependencyFor(taskRun);
          if (released) continue;
        }
        // 等待外部条件是事件驱动，不算「没有新进展」的停滞
        return { status: 'wait', gate: action.gate ?? null, why: action.why };
      }
      if (action.kind === NEXT.pausedBudget) {
        // 说清是哪个维度用尽：token 与次数是两条独立的闸门
        const rootId = taskRun.rootTaskId ?? taskRun.id;
        const rootBudget = (rootId === taskRun.id ? taskRun : read(rootId))?.budget ?? {};
        const reason = remainingTokensOf(taskRun) <= 0 && Number.isInteger(rootBudget.maxTokens)
          ? `Token 预算已用尽（${rootBudget.usedTokens ?? 0}/${rootBudget.maxTokens}）`
          : '执行次数预算已用尽';
        const paused = await settle(taskRun.id, {
          type: EVENT.budget_exhausted, revision: taskRun.revision, at: clock(), reason,
        });
        if (paused.ok) {
          await patch(taskRun.id, { nextAction: null });
          return { status: 'paused_budget' };
        }
        await block(taskRunId, '根预算不足且无法进入预算暂停');
        return { status: 'blocked', why: 'budget' };
      }
      if (action.kind === NEXT.deliver) {
        await deliver(taskRun);
        continue;
      }
      if (action.kind === NEXT.restore) {
        const resolved = await inspectAndSettle(taskRun, { attemptId: action.attemptId, slot: null });
        if (!resolved) return { status: 'blocked', why: 'unknown' };
        continue;
      }
      if (action.kind === NEXT.verify) {
        const out = await doVerify(taskRun);
        if (out === 'rejected') {
          // 归约拒绝：不循环硬撞，按未验收继续推进
          await recordStall(taskRun);
          continue;
        }
        if (out === 'critic_blocked') return { status: 'blocked', why: 'critic_exhausted' };
        if (out === 'critic_error') {
          // ★ 评审员自身故障：不伪造通过、不扣返工额度，过一会儿重跑。
          //   不在这里 return wait 是因为“等一个不会到来的事件”＝静死；
          //   必须自己排一个到期唤醒。
          const dueAt = clock() + CRITIC_RETRY_MS;
          await patch(taskRun.id, { nextAction: null, retryAt: dueAt });
          setTimer(dueAt, taskRun.id);
          return { status: 'retry_scheduled', dueAt, why: '独立复核暂时不可用，稍后重试' };
        }
        continue;
      }

      // 重试到期但状态仍是 blocked：先按既有解除协议解除，再执行
      if (action.retry && taskRun.state === STATE.blocked) {
        const unblocked = await settle(taskRun.id, {
          type: EVENT.unblocked, revision: taskRun.revision, at: clock(), reason: '重试到期',
        });
        if (!unblocked.ok) return { status: 'blocked', why: 'unblock_failed' };
        // ★ 可恢复阻塞的记账要在解除时一起清：
        //   `recoverableBlock: 'upstream'` 留着会让启动恢复以为「还在等上游」，
        //   `retryAt` 留着会让下一轮重复判「重试到期」。
        const revived = read(taskRun.id);
        if (revived?.recoverableBlock === 'upstream') {
          await patch(taskRun.id, { recoverableBlock: null, retryAt: null });
        }
        continue;
      }

      const beforeRun = read(taskRunId) ?? taskRun;
      const beforeProgress = progressSignature(beforeRun);
      const out = await doLeadStep(taskRun, action);
      if (out.status === 'retry_scheduled' || out.status === 'paused_budget') return out;
      // 这一段真的跑通了 → 上游退避的累计清零（下次抽风重新从第一档排起）
      if (out.status === 'ok' && read(taskRun.id)?.[UPSTREAM_STATE_KEY]) {
        await patch(taskRun.id, { [UPSTREAM_STATE_KEY]: null });
      }
      // ★ 执行让出（步数上限）不是失败，但也不能在这里直接 return ——
      //   直接 return 就绕过了下面「安排续行」的收尾，任务从此停在 running，
      //   界面显示「执行中」却再也不动。让它落到循环尾部统一处理。
      if (out.status === 'yielded') break;
      if (out.status !== 'ok') return out;

      // ★ 这一步没有可观察的进展（没有新交付、没有新子任务、没有完成申请）。
      //
      //   原来会立刻 continue 再跑一次模型 —— 一次「解除阻塞」于是在同一个唤醒里
      //   连跑两三次，每次都往群里发一条完整的派工/汇报：用户看到的就是
      //   「点一次解除，群里连发三条一模一样的消息」，而且每跑一次都扣一次额度，
      //   最后才被停滞判定打回受阻。
      //
      //   这里交回事件驱动：本轮如实收手，等真实事件（用户指令、子任务交付、
      //   新工具结果）再推进。停滞计数已在 doLeadStep 里累计，所以反复无进展
      //   仍会被既有上限挡住，不会无限重试。
      const afterRun = read(taskRunId) ?? taskRun;
      // ★ 执行段让出（达到单次执行上限）是正常收尾，不是"没有产出"。
      //
      //   模型这一轮跑到步数上限就让出，本来下一轮还要继续做。
      //   原来这种情况会掉进下面的「无进展」判定被判成阻塞 ——
      //   等于每一轮正常让出都被当成失败。
      if (afterRun.state === STATE.queued || afterRun.state === STATE.running) {
        // 结算后 nextAction 已被清空，按「最后一条账本记录」判断这一步的结果。
        const ledger = afterRun.attempts ?? [];
        const attempt = ledger[ledger.length - 1] ?? null;
        // stop 存在结果里（result.stop），不直接在账本记录上
        const stopKind = attempt?.result?.stop ?? attempt?.stop ?? null;
        if (stopKind === 'yielded') {
          // ★ 让出是有上限的，但上限看的是「有没有进展」，不是「让出了几次」。
          //
          //   「让步继续」本身正确 —— 模型跑到单段上限，下一段接着做；
          //   一个长任务本来就要跑很多段。停滞计数已经在 doLeadStep 里
          //   按两档累计（有没有干活 / 目标有没有推进），这里**只读不再累加**。
          //
          //   以前这里又按签名 +1 一次，和 doLeadStep 里的那次叠成双重计数：
          //   第 2 次没有「里程碑」的让出就被判死 —— 长任务基本活不过第三段。
          const after = read(taskRunId) ?? afterRun;
          const verdict = stallVerdict(after);
          if (verdict) {
            await patch(taskRunId, { nextAction: null, retryAt: null });
            await block(taskRunId, verdict.why);
            return { status: 'blocked', why: verdict.code };
          }
          const resumeAt = clock() + YIELD_RESUME_MS;
          await patch(taskRunId, { nextAction: null, retryAt: resumeAt });
          setTimer(resumeAt, taskRunId);
          return { status: 'yielded', why: '执行段让出，已安排续行' };
        }
      }
      const afterProgress = progressSignature(afterRun);
      // 状态发生了推进（例如刚结算完进入 verifying / 拿到新门槛）也算变化：
      // 那种情况下必须继续走验收/等待分支，不能停在这里。
      const stateChanged = afterRun.state !== taskRun.state;
      if (afterProgress === beforeProgress && !stateChanged) {
        const hasKids = childrenOf(taskRuns, afterRun).some((k) => !terminal(k));
        // 有在途子任务：等它们交付，这不算停滞。
        if (hasKids) return { status: 'wait', why: '等待子任务交付' };
        // ★ 这一段真的干了活（改了文件 / 出了产物），只是还没到「可验收」：
        //   按长任务的续段处理 —— 接着推进，而不是判「没有产出」停下来问用户。
        //
        //   以前只认「新子任务 / 新交付 / 完成申请」三种进展：写代码这类活
        //   （源码不算交付物扩展名）一段没写完，就被判「负责人这一轮没有产出」。
        //   防空转交给两档停滞计数：真没干活照样会被拦住。
        if (out.didWork) {
          const verdict = stallVerdict(read(taskRunId) ?? afterRun);
          if (verdict) {
            await block(taskRunId, verdict.why);
            return { status: 'blocked', why: verdict.code };
          }
          const resumeAt = clock() + YIELD_RESUME_MS;
          await patch(taskRunId, { nextAction: null, retryAt: resumeAt });
          setTimer(resumeAt, taskRunId);
          return { status: 'ok', why: '这一段有实际改动，安排接着推进' };
        }
        // ★ 否则**明确停下**，不能返回一个「等待」了事。
        //
        //   返回 wait 会把记录留在 queued + next=dispatch，界面上就是「准备中」，
        //   可实际没有任何人会再唤醒它 —— 正是用户说的「一直卡住」。
        //   而继续原地重跑同一个指令只会再发一条一模一样的群消息、再扣一次额度。
        //
        //   所以把真实情况说清楚：这一步没有可核验的产出，等用户补充要求或明确继续。
        // 说明「下一步该做什么」，而不是只说「没有产出」。
        // 最常见的原因就是：负责人只在群里 @ 了成员，但没有建出持久子任务。
        // ★ 写了分工计划也算进展。
        //
        //   提示词明确要求负责人「先列计划再派活」，但列计划本身不产生
        //   子任务、不登记文件、也不申请完成 —— 于是「只列了计划」这一轮
        //   被判成「没有产出可核验的交付」直接阻塞，正好把系统教它的
        //   第一步当成失败。计划是真实推进，不该被罚。
        const hasPlan = (afterRun.plan?.steps ?? []).length > 0
          && (taskRun.plan?.steps ?? []).length !== (afterRun.plan?.steps ?? []).length;
        if (hasPlan) return { status: 'ok', why: '已登记分工计划' };

        // ★ 已经交付过产物，就不该按「没有产出」阻塞。
        //
        //   真实用户场景：负责人第一轮就产出了文件（evidence 1~7 份），
        //   第二轮只是接着讨论/补细节、没有新增文件 —— 签名因此不变，
        //   于是被判「负责人这一轮没有产出可核验的交付」。
        //   但他的交付早就在那儿了，任务却被判失败：
        //   用户原话「我都不知道是完成了还是失败了」。
        //
        //   有交付物时正确做法是**去验收**，而不是判它没干活。
        const delivered = (afterRun.progress?.evidence ?? []).some((e) => e.kind === 'artifact');
        if (delivered) {
          // 已有交付 → 让下一轮走验收，而不是继续催它"再产出点东西"。
          // 不伪造事件、不改状态：只把它排回队列，由 planNextAction
          // 按「有交付 → 验收」的自然路径推进。
          const resumeAt = clock() + YIELD_RESUME_MS;
          await patch(taskRunId, { nextAction: null, retryAt: resumeAt });
          setTimer(resumeAt, taskRunId);
          return { status: 'ok', why: '已有交付，安排验收' };
        }

        // ★ 刚从暂停/阻塞里恢复的那一轮，不该因「这一轮没产出」被判死。
        //
        //   用户暂停一个正在跑的任务 → 那次执行被中断（账本标 abandoned）、
        //   这一轮自然没有新交付。如果就此判「没有产出」并阻塞，
        //   用户点「继续」的后果是任务直接死掉 —— 每次暂停都会毁掉任务。
        //   恢复的第一轮应当允许它重新开始干活。
        // 判断依据：账本里存在「被中断」的尝试（暂停/阻塞/改版留下的），
        // 且这次是它之后的第一次推进 —— 允许重新开始，不当作失败。
        const ledger = afterRun.attempts ?? [];
        const hasInterrupted = ledger.some((a) => a.state === 'abandoned');
        const executedNow = ledger.some(
          (a) => a.state === 'settled' && (a.result?.stop === 'returned' || a.result?.stop === 'yielded'),
        );
        if (hasInterrupted && !executedNow) {
          return { status: 'ok', why: '检测到被中断的执行，允许重新开始' };
        }
        if (hasInterrupted && ledger.filter((a) => a.state === 'settled').length <= 1) {
          return { status: 'ok', why: '中断后首次推进，允许重新开始' };
        }
        const reason = '负责人这一轮没有产出可核验的交付（没有建子任务、没有登记文件，也没有完成申请）';
        await block(taskRunId, reason);
        return { status: 'blocked', why: 'no_progress' };
      }
    }

    // ★ 步数用尽 = 让出给**事件**，不再自己叫自己。
    //
    //   原来这里 notify(taskRunId)：等于「我这一轮用完了，立刻再跑一轮」，
    //   中间没有任何真实事件。配合停滞签名曾含产物，就构成无界自旋
    //   （实测同一任务 8 秒内执行 71 次仍在跑，而默认额度是不限额，
    //   生产上没有任何东西能拦住它）。
    //
    //   正确语义：一步做完就交回。下一次推进必须由真实事件驱动 ——
    //   子任务交付、用户指令、到期重试、执行结果回收。
    //   如果下一次没有事件，任务就该静静等着，而不是空转。
    yielded = true;
    // 让出但**保证还会被叫醒**：排一个到期重试。
    //
    //   只让出不排队 = 任务永远停在 running，用户看到「执行中」却再也不动。
    //   这是另一个方向的死法，比自旋更难发现（因为界面看起来正常）。
    //   用一个短间隔的到期唤醒，既避免原地空转，又保证推进继续。
    const resumeAt = clock() + YIELD_RESUME_MS;
    await patch(taskRunId, { nextAction: null, retryAt: resumeAt });
    const current = read(taskRunId);
    await recordStall(current ?? { id: taskRunId });
    setTimer(resumeAt, taskRunId);
    log('步数用尽，让出后 ' + YIELD_RESUME_MS + 'ms 继续', taskRunId);
    return { status: 'yielded', why: '步数上限，已安排续行' };
  }

  function terminal(run) {
    return run.state === STATE.completed || run.state === STATE.cancelled;
  }

  function unknownOf(taskRun) {
    // 占位记在根上；子任务按自己的 taskRunId 过滤。
    // 只有「已启动且结果没有落盘」才算未知；已结算的只是预算待结算。
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    const root = rootId === taskRun.id ? taskRun : read(rootId);
    return Object.values(root?.attemptSlots ?? {})
      .filter((s) => s.phase !== 'settled' && s.phase !== 'refunded' && s.startedAt)
      .filter((s) => !s.taskRunId || s.taskRunId === taskRun.id)
      .filter((s) => s.taskRunId === taskRun.id || taskRun.id === rootId)
      .filter((slot) => {
        const owner = slot.taskRunId ? read(slot.taskRunId) : taskRun;
        const attempt = (owner?.attempts ?? []).find((a) => a.attemptId === slot.attemptId);
        return attempt?.state !== 'settled';
      })
      .map((s) => ({ attemptId: s.attemptId, taskRunId: s.taskRunId, botId: s.botId ?? null, revision: s.revision ?? taskRun.revision }));
  }

  /**
   * 执行者现在忙吗 —— 由宿主注入的只读探测。
   *
   * 为什么要在**执行前**问：受管执行和用户聊天共用同一个会话；
   * 直接跑会撞上「会话正在忙」，那会被记成一次失败尝试，
   * 任务随即被判阻塞（用户看到的正是「刚开始就受阻」，而团队其实在群里正常干活）。
   */
  function executorBusy(botId, taskRun) {
    if (typeof isExecutorBusy !== 'function' || !botId) return false;
    try {
      return isExecutorBusy({ ...(taskRun?.owner ?? {}), botId, taskRun }) === true;
    } catch {
      return false;
    }
  }

  /** 执行一步：先持久（失败即止）→ 预算 → 执行 → 结算。 */
  async function doLeadStep(taskRun, action) {
    const attemptId = nextAttemptId(taskRun);
    const botId = taskRun.owner?.leadBotId ?? null;
    const isChild = Boolean(taskRun.parentTaskId);
    const parentTask = isChild ? read(taskRun.parentTaskId) : null;
    const stepExecutor = isChild && typeof executeMember === 'function' ? executeMember : execute;

    if (!botId) {
      await block(taskRun.id, '没有可执行的负责人');
      return { status: 'blocked', why: 'no_lead' };
    }

    // ★ 会话还在忙：让出一轮再来，不登记本次尝试。
    //   登记了再失败会消耗额度并落一条 failed 尝试，任务直接被判阻塞。
    if (executorBusy(botId, taskRun)) {
      const dueAt = clock() + BUSY_RETRY_MS;
      // ★ 忙等待不算失败次数（与下面 failedStop 里的忙分支一致）。
      //   累加的话，上游退避期间 retry.count 已经是 10，撞一次「执行者还在忙」
      //   就变 11，而 `task-next-action` 看到 >10 直接判「重试次数已达上限」——
      //   一次无关紧要的忙就直接把任务硬阻塞。
      await patch(taskRun.id, { nextAction: null, retryAt: dueAt });
      setTimer(dueAt, taskRun.id);
      return { status: 'retry_scheduled', dueAt, why: '执行者还在忙，稍后重派' };
    }

    // ★ 声明的文件被别人占着：同样让出一轮，不登记尝试、不扣额度。
    //
    //   两个人并行改同一个文件时，读-改-写之间没有任何锁：
    //   后写的静默覆盖先写的，而且双方都以为自己成功了。
    //   与其让它们撞完再靠人工发现，不如让后一份等一会儿 ——
    //   等的时间不计入失败次数，也不花额度。
    const claimBlock = fileClaimBlocker(taskRun);
    if (claimBlock) {
      const dueAt = clock() + CLAIM_RETRY_MS;
      await patch(taskRun.id, { nextAction: null, retryAt: dueAt });
      setTimer(dueAt, taskRun.id);
      log('文件占用排到后面：' + taskRun.id + ' → ' + claimBlock.why);
      return { status: 'retry_scheduled', dueAt, why: claimBlock.why, blockedByFile: claimBlock };
    }

    // 先持久下一步；写不进去就不许产生副作用
    const persisted = await patch(taskRun.id, {
      nextAction: {
        kind: action.kind, botId, attemptId, revision: taskRun.revision,
        phase: isChild ? 'member' : LEAD_PHASE.plan, status: 'running', at: clock(),
      },
    });
    if (!persisted.ok) {
      await block(taskRun.id, `下一步未能持久：${persisted.text}`);
      return { status: 'blocked', why: 'next_persist_failed' };
    }

    // 续段：上一段让出/中断了，告诉它从断点接着做，而不是把整件事从头再来一遍
    const resume = continuationNote(taskRun, { autonomous: autonomousOf(taskRun) });
    // ★ DAG + 共享黑板的注入：成员要看到前置交付与全组约束，
    //   负责人要看到黑板与待放行的 checkpoint（否则它们成了隐形状态）。
    const rootRun = rootRunOf(taskRun);
    const allKids = isChild ? (parentTask ? childrenOf(taskRuns, parentTask) : []) : childrenOf(taskRuns, taskRun);
    const nameOf = (id) => nameOfBot(id);
    const basePrompt = isChild
      ? buildMemberPrompt({
        childTaskRun: taskRun,
        parentTaskRun: parentTask,
        autonomous: autonomousOf(taskRun),
        siblings: allKids,
        blackboard: rootRun?.blackboard ?? null,
        nameOf,
      })
      : buildLeadPrompt({
        phase: LEAD_PHASE.plan,
        taskRun: autonomousOf(taskRun)
          ? { ...taskRun, flags: { ...(taskRun.flags ?? {}), autonomous: true } }
          : taskRun,
        children: allKids,
        blackboard: rootRun?.blackboard ?? null,
        nameOf,
      });
    const prompt = resume ? basePrompt + '\n\n' + resume : basePrompt;

    inflight.set(taskRun.id, { attemptId, revision: taskRun.revision });
    let out;
    let rawResult = null;
    try {
      out = await runManagedAttempt({
        taskRuns, taskRun, taskRunId: taskRun.id, attemptId, botId, revision: taskRun.revision, clock,
        settleEvent: (event) => settle(taskRun.id, { ...event, revision: event.revision ?? taskRun.revision }),
        execute: async ({ restoreOnly }) => {
          if (restoreOnly) return { unknown: true };
          rawResult = await stepExecutor({
            taskRun, action, attemptId, botId, revision: taskRun.revision,
            phase: isChild ? 'member' : LEAD_PHASE.plan, prompt,
          });
          return rawResult;
        },
      });
    } finally {
      inflight.delete(taskRun.id);
    }

    // ★ 把执行器的原始结果一起带下去：`runManagedAttempt` 的失败壳子只说明
    //   「这一步没成」，真正的原因（429 / 5xx / 熔断）在 rawResult 里。
    //   不带下去的话，上游限流也会被归成「执行失败」直接阻塞。
    if (!out.ok) return handleStepFailure(taskRun, { ...out, raw: rawResult });

    // 执行失败但属于可恢复的暂时故障：按既有决策排有界重试，不写成永久阻塞
    const failedStop = rawResult?.stop === STOP.failed || rawResult?.ok === false;
    // ★ 会话忙不是「做不成」：执行器可能还在同房间跑上一波。
    //   直接判阻塞会让任务在团队还在干活时就死在「受阻」，用户只能看到红字。
    if (failedStop && isBusyOutcome(rawResult) && (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
      const dueAt = clock() + BUSY_RETRY_MS;
      // ★ 忙等待不算"失败次数"。
      //
      //   retry.count 的语义是「这个任务真实失败了几次」，decideRetry 用它
      //   判断还值不值得再试。把「执行者正忙」也算进去，会让第一次真实失败
      //   就被当成第 2 次尝试、直接 exhausted，一次都不重试。
      //   忙等待只排时间，不动 count。
      await patch(taskRun.id, { nextAction: null, retryAt: dueAt });
      setTimer(dueAt, taskRun.id);
      return { status: 'retry_scheduled', dueAt, why: '执行者还在忙，稍后重派' };
    }
    if (failedStop) {
      // ★ attempt 必须取**真实已重试次数**。
      //
      //   原来读的是 nextAction.retryCount —— 那个字段全仓库没有任何地方写过，
      //   所以 attempt 恒等于 1，decideRetry 对普通失败恒返回 retry:true：
      //     · 本来只想给一次机会的失败被重试到上限（10 次），烧时间烧额度；
      //     · 后面的自主重试上限、autonomyMisses、「自主重试 N 次仍未成功」
      //       这些提示全部变成死代码 —— 用户永远看不到那句解释。
      //   retry.count 才是真正在累加的计数，用它。
      const triedTimes = (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) + 1;
      const decision = decideRetry({
        error: String(rawResult?.error ?? rawResult?.text ?? ''),
        status: rawResult?.status ?? null,
        attempt: triedTimes,
      });
      // ★ 不可恢复（鉴权/余额/配置/中止/显式 impossible）：一次都不再试
      const fatal = classifyNonRetriableFailure({
        error: String(rawResult?.error ?? rawResult?.text ?? ''),
        status: rawResult?.status ?? null,
        stop: rawResult?.stop ?? '',
        impossible: rawResult?.impossible === true,
        nonRetriable: rawResult?.nonRetriable === true,
        approvalRejected: rawResult?.approvalRejected === true,
      });
      if (fatal) {
        return stopForNonRetriable(taskRun.id, fatal, String(rawResult?.error ?? rawResult?.text ?? ''));
      }
      if (decision.retry && (taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
        const dueAt = clock() + (decision.delayMs ?? 30_000);
        await patch(taskRun.id, {
          nextAction: null,
          retryAt: dueAt,
          retry: { count: (read(taskRun.id)?.retry?.count ?? taskRun.retry?.count ?? 0) + 1, at: clock() },
        });
        setTimer(dueAt, taskRun.id);
        return { status: 'retry_scheduled', dueAt };
      }
      // 不再重试：清掉到期标记，交给状态机判定为明确失败
      await patch(taskRun.id, { retryAt: null, nextAction: null });
      // ★ 但如果是上游瞬时故障，这里不该走到「明确失败」：
      //   快速重试（最多 10 次、总时长几十秒）穿不过一次分钟级的限流。
      if (isUpstreamTransient({
        error: String(rawResult?.error ?? rawResult?.text ?? ''),
        status: rawResult?.status ?? null,
      })) {
        const scheduled = await scheduleUpstreamRetry(taskRun.id, {
          why: String(rawResult?.error ?? rawResult?.text ?? '上游不可用'),
        });
        if (scheduled.status === 'retry_scheduled') return scheduled;
        return { status: 'blocked', why: scheduled.why };
      }
    }

    // ★ 自主模式：这一轮被判定失败时，自动把它再推起来，而不是等用户点「继续」。
    //   放在这里（归约之后）是因为归约必须如实记录「这次失败了」——
    //   篡改归约结果会让账本撒谎。这里做的是**善后**：清掉阻塞事实、再排一次。
    //   上限 AUTONOMY_RETRY_LIMIT：同一个错误反复重试只会烧时间。
    {
      const nowRun = read(taskRun.id);
      if (autonomousOf(nowRun)
        && nowRun.state === STATE.blocked
        && nowRun.recoverableBlock == null
        && !nowRun.flags?.blockedByUser
        // ★ 不可恢复的失败不参与自主重试：重试 3 轮也还是同一个 401
        && nonRetriableOf(nowRun) == null) {
        const misses = (nowRun.autonomyMisses ?? 0) + 1;
        if (misses < AUTONOMY_RETRY_LIMIT) {
          await patch(taskRun.id, { autonomyMisses: misses });
          // ★ 必须走 unblock 事件把状态迁回去。
          //   只清 flags.blockedAt 是不够的：state 仍是 blocked，
          //   下一轮 planNextAction 第 93 行照样判阻塞，重试永远不会发生。
          const released = await settle(taskRun.id, {
            type: EVENT.unblocked, revision: nowRun.revision, at: clock(),
            reason: '自主推进：自动解除本轮失败阻塞',
          });
          if (!released.ok) {
            log('自主重试解除阻塞失败：', taskRun.id, released.text ?? released.code);
            return { status: 'blocked', why: released.code ?? 'unblock_failed' };
          }
          await patch(taskRun.id, {
            retryAt: clock() + AUTONOMY_RETRY_MS,
            nextAction: null,
          });
          setTimer(clock() + AUTONOMY_RETRY_MS, taskRun.id);
          log('自主模式：第 ' + misses + ' 次失败，自动重试', taskRun.id);
          return { status: 'retry_scheduled', why: 'autonomous_retry_' + misses };
        }
        // ★ 重试用尽：把真正的原因写给用户看。
        //   直接调 block() 是不行的 —— 任务此刻已经是 blocked 状态，
        //   block() 见到 blocked 会提前 return，用户看到的还是通用的
        //   「执行失败」，不知道是自主重试了三轮才放弃。
        const why = '自主重试 ' + misses + ' 次仍未成功，需要你确认下一步：'
          + String(nowRun.flags?.blockedReason ?? '').slice(0, 80);
        await patch(taskRun.id, {
          autonomyMisses: misses,
          flags: { ...(nowRun.flags ?? {}), blockedAt: clock(), blockedReason: why },
        });
        return { status: 'blocked', why: 'autonomy_exhausted', misses };
      }
    }

    const after = read(taskRun.id);
    if (after && (after.state === STATE.cancelled || after.state === STATE.paused_user)) {
      await patch(taskRun.id, { nextAction: null });
      return { status: 'cancelled', why: '执行期间被取消/暂停' };
    }


    // 这一段有没有真实干活：改了工作区文件，或者登记了产物。
    // 停滞计数据此分两档（见 bumpStall / stallVerdict）：干了活就不算「卡住」。
    const didWork = workDoneBy(rawResult);
    await patch(taskRun.id, { nextAction: null, retryAt: null, retry: null, stall: bumpStall(after ?? taskRun, { didWork }) });
    await reconcileEarlyControls({ taskRuns, taskRunId: taskRun.id, settle, patch, notify, clock });
    await releaseDependencyFor(read(taskRun.id) ?? taskRun);
    // ★ 只唤醒子任务，**绝不 notify 自己**。
    //
    //   原来这里 notify(kid.id) 后又 notify(taskRun.id) —— 等于告诉调度器
    //   「这个任务又该跑一遍」，于是 runTask 结束立刻被重新入队，
    //   配合「每轮新产物改变停滞签名」，就变成无界自旋：
    //   实测 8 秒内同一任务执行 71 次、验收 70 次仍在跑。
    //
    //   一轮推进结束后是否还要继续，由真实事件（子任务交付、用户指令、
    //   到期重试）驱动，而不是自己叫自己。
    const kidsNow = childrenOf(taskRuns, read(taskRun.id) ?? taskRun);
    for (const kid of kidsNow) {
      // ★ 只唤醒“现在真能跑”的：依赖未就位 / 等 checkpoint / 上游已死的
      //   唤了也白唤，而调度器收到唤醒后并不会重新算依赖 ——
      //   checkpoint 会被这一行绕过，下游在前置刚完成时就抢跑。
      if (!terminal(kid) && kidRunnableNow(kid, kidsNow)) notify(kid.id);
    }
    return { status: 'ok', didWork };
  }

  /**
   * 这个任务现在被谁的文件占用拦住（返回冲突说明，没有则 null）。
   *
   * ## 为什么排除自己的任务树
   *
   * 一棵树内的先后由负责人安排（父任务常年停在「等待子任务」），
   * 把祖先算成占用会让子任务永远排不到 —— 那是个自锁，不是互斥。
   *
   * ## 为什么只算「正在持有」的状态
   *
   * 排队中的任务还没动过文件；两个排队的互相看见对方的占用就会互相等死。
   * 受阻/暂停同理：它们停在半路，此刻不会写，先让别的活过去（
   * 重新推进时会重新拿到占用）。
   *
   * ## 为什么要扫全场
   *
   * 撞车的两个活往往分属不同任务树（用户提了两件事，各派一个人），
   * 只看同树等于没拦。
   */
  function fileClaimBlocker(taskRun) {
    const mine = claimFilesOf(taskRun);
    if (!mine.length) return null;
    const runs = [];
    for (const run of allRuns()) {
      if (!run || !run.id) continue;
      const files = claimFilesOf(run);
      if (!files.length) continue;
      runs.push({
        id: run.id,
        parentTaskId: run.parentTaskId ?? null,
        state: run.state,
        files,
        botName: nameOfBot(run.owner?.leadBotId),
      });
    }
    return pickBlockingClaim({
      self: { id: taskRun.id, files: mine },
      runs,
      holdingStates: CLAIM_HOLDING_STATES,
    });
  }

  /** 把一次执行失败接到既有状态机：预算暂停 / 有界重试 / 结果未知 / 阻塞。 */
  async function handleStepFailure(taskRun, out) {
    const id = taskRun.id;
    if (out.code === 'unknown_outcome') {
      await patch(id, {
        nextAction: { ...(read(id)?.nextAction ?? {}), status: 'unknown' },
        stall: bumpStall(read(id) ?? taskRun),
      });
      await block(id, '执行结果未知，需要先核验外部副作用', 'unknown_outcome');
      return { status: 'unknown' };
    }
    if (out.phase === 'settled_budget') {
      await patch(id, { nextAction: null, recoverableBlock: 'budget_settle' });
      await block(id, `根结算未落盘：${out.text ?? out.code}`);
      return { status: 'blocked', why: 'budget_settle' };
    }
    // 只有真实的额度耗尽才进入预算暂停；身份/版本/存储拒绝如实失败
    if (out.code === 'budget_exhausted' && out.phase === 'reserved') {
      await patch(id, { nextAction: null });
      const paused = await settle(id, { type: EVENT.budget_exhausted, revision: taskRun.revision, at: clock() });
      if (paused.ok) return { status: 'paused_budget' };
    }
    // ★ 并发名额满了**不是失败**：等一个正在跑的执行收口，名额自然会空出来。
    //
    //   以前这里落到下面「预留/登记阶段的生命周期拒绝 → 立即 block」：
    //   一次临时的名额占用会把子任务**永久打死成受阻** —— 用户看到
    //   「成员受阻」，而实际上什么都没错，再等一会儿就能跑。
    //   现在按「执行者还在忙」同一套处理：不 block、不累加 retry.count、
    //   不累加 stall，只排一个很快到期的重派；名额一空会被
    //   wakeSlotWaiters 立刻叫醒，不必傻等满 BUSY_RETRY_MS。
    if (out.phase === 'reserved' && out.code === 'concurrency_limit') {
      const dueAt = clock() + BUSY_RETRY_MS;
      await patch(id, { nextAction: null, retryAt: dueAt });
      slotWaiters.add(id);
      setTimer(dueAt, id);
      log('并发名额已满，排到下一轮：' + id);
      return { status: 'retry_scheduled', dueAt, why: '并发名额已满，稍后重派' };
    }
    // 预留/登记阶段的生命周期拒绝（如 already_refunded）：立即明确失败，不安排重试
    if (['reserved', 'started', 'dispatched'].includes(out.phase)) {
      await patch(id, { nextAction: null, retryAt: null });
      await block(id, out.text ?? out.code ?? '执行身份不被接受');
      return { status: 'blocked', why: out.code };
    }
    // 有界重试：只有明确 transient 才排重试；结果未知不在此列
    const cause = String(out.raw?.error ?? out.raw?.text ?? out.text ?? out.code ?? '');
    const causeStatus = out.raw?.status ?? out.status ?? null;
    const decision = decideRetry({ error: cause, status: causeStatus, attempt: (read(id)?.retry?.count ?? 0) + 1 });
    // ★ 不可恢复：不进有界重试、不进分钟级退避，直接如实停下
    const fatal = classifyNonRetriableFailure({
      error: cause,
      status: causeStatus,
      impossible: out.raw?.impossible === true || out.impossible === true,
      nonRetriable: out.raw?.nonRetriable === true || out.nonRetriable === true,
      approvalRejected: out.raw?.approvalRejected === true || out.approvalRejected === true,
    });
    if (fatal) return stopForNonRetriable(id, fatal, cause);
    if (decision.retry && (taskRun.retry?.count ?? 0) < MAX_TRANSIENT_ATTEMPTS) {
      const dueAt = clock() + (decision.delayMs ?? 30_000);
      await patch(id, {
        nextAction: null, retryAt: dueAt,
        retry: { count: (taskRun.retry?.count ?? 0) + 1, at: clock() },
      });
      await patch(id, { stall: bumpStall(read(id) ?? taskRun) });
      setTimer(dueAt, id);
      return { status: 'retry_scheduled', dueAt };
    }
    // ★ 快速重试用尽：如果是上游瞬时故障，不判死，改排分钟级退避。
    //   一次普通的限流不该把整个任务变成「需要人工确认」。
    if (isUpstreamTransient({ error: cause, status: causeStatus })) {
      // ★ 上游故障不计入模型停滞：这是「路不通」，不是「模型在原地打转」。
      //   计进去的话，一次限流就可能把停滞计数推到上限，恢复后立刻被判死。
      return scheduleUpstreamRetry(id, { why: cause || '上游不可用' });
    }
    await patch(id, { nextAction: null, retryAt: null });
    await block(id, out.text ?? out.code ?? cause ?? '执行失败');
    return { status: 'blocked', why: out.code };
  }

  /** 到期重试的唤醒（事件驱动）；由运行时按最早到期时间调度。 */
  const timers = new Map();
  /**
   * 安排一次到期唤醒。
   *
   * ★ 每个任务一个定时器，不再共用一个 'retry' key。
   *
   *   共用 key 时后设置的一定会 clearTimeout 掉先设置的：
   *   A 还有 30 秒到期、B 排了 15 秒，B 一进来就把 A 的定时器清了，
   *   A 永远等不到唤醒，停在 blocked —— 用户看到的是「任务无缘无故卡住」。
   */
  function setTimer(dueAt, taskRunId = null) {
    const delay = Math.max(0, dueAt - clock());
    const key = taskRunId ? 'retry:' + taskRunId : 'retry:*';
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      // 到点后统一扫一遍所有到期任务（不用关心是谁的定时器）
      for (const run of allRuns()) {
        if (run.retryAt && run.retryAt <= clock()) notify(run.id);
      }
    }, Math.min(delay, 2_147_483_647)));
    timers.get(key).unref?.();
  }

  /** 纯代码验收：只有状态机允许时才归约；拒绝时按未验收继续。 */
  async function doVerify(taskRun) {
    const checker = verify ?? defaultVerify;
    const verification = await checker(taskRun, { access, attemptId: null });

    // ★ 独立评审（Critic）闸门。顺序不能反：
    //   机械验收没过时 `shouldRunCritic` 恒为 false —— 先让执行者修确定性错误，
    //   这时候叫评审员只会把“文件都没写”说成“质量不行”。
    let finalVerdict = verification;
    const critic = await maybeCriticReview(taskRun, verification);
    if (critic?.kind === 'paused_budget') {
      const now = read(taskRun.id) ?? taskRun;
      const rootId = now.rootTaskId ?? now.id;
      const rootBudget = (rootId === now.id ? now : read(rootId))?.budget ?? {};
      const paused = await settle(taskRun.id, {
        type: EVENT.budget_exhausted, revision: now.revision, at: clock(),
        reason: `Token 预算已用尽（${rootBudget.usedTokens ?? 0}/${rootBudget.maxTokens}），不再启动独立复核`,
      });
      if (paused.ok) await patch(taskRun.id, { nextAction: null });
      return 'ok';
    }
    if (critic?.kind === 'error') return critic.exhausted ? 'critic_blocked' : 'critic_error';
    if (critic?.kind === 'stale') {
      // 评审期间被取消/暂停/改版：结论丢弃，不写任何脏状态。循环顶部会重读。
      log('独立评审结论已过期，丢弃', taskRun.id, critic.why ?? '');
      return 'ok';
    }
    if (critic?.kind === 'over_limit') return 'critic_blocked';
    if (critic?.kind === 'failed') {
      finalVerdict = {
        ...verification, passed: false, needsReview: [], unmet: critic.unmet ?? [],
        reason: critic.reason,
      };
    } else if (critic?.kind === 'passed') {
      // 评审记录已经落盘，重跑一次验收：这次 expert 条件应该真能过。
      const again = await checker(read(taskRun.id) ?? taskRun, { access, attemptId: null });
      finalVerdict = { ...again, reason: critic.reason ?? again.reason };
    }

    const out = await settle(taskRun.id, {
      type: EVENT.verification_finished, revision: taskRun.revision, at: clock(),
      passed: finalVerdict?.passed === true,
      unmet: finalVerdict?.unmet ?? [],
      // ★ 通过时必须给出依据，否则归约器不会接受（防「空壳完成」）。
      //   验收器没写理由时由这里补一条可核对的说明，而不是让它被拒。
      reason: String(finalVerdict?.reason ?? '').trim()
        || (finalVerdict?.passed === true ? '已按条件完成验收' : '验收未通过'),
    });
    const after = read(taskRun.id);
    // ★ 顺手清掉上一轮遗留的 `retryAt`（评审员故障重试时写下的）：
    //   不清就会让返工轮白等到期，或被误判成“重试到期”。
    if (after) await patch(taskRun.id, { stall: bumpStall(after), retryAt: null });
    if (!out.ok) {
      log('验收归约被拒：', taskRun.id, out.text ?? out.code);
      return 'rejected';
    }
    log('验收', taskRun.id, 'passed=', finalVerdict?.passed === true,
      critic ? '(' + String(critic.kind) + ')' : '');
    return 'ok';
  }

  /**
   * 机械验收全过之后，按档位跑一次独立评审，并把结论写进任务。
   *
   * 返回的 `kind` 就是调用方要做的事：
   *   · `passed`      评审通过（expert 评审记录已写入）→ 重跑验收；
   *   · `failed`      评审不通过且还有返工额度 → 按缺陷返工；
   *   · `over_limit`  返工额度用完 → 已 block；
   *   · `error`       评审员自身故障（不伪造通过、不扣返工额度）；
   *   · `stale`       评审期间任务被取消/暂停/改版 → 丢弃结论；
   *   · `paused_budget` token 预算已尽，不偷跑模型。
   */
  async function maybeCriticReview(taskRun, verification) {
    if (!criticActive) return null;
    if (!shouldRunCritic({ taskRun, verification, mode: criticSetting })) return null;
    // ★ 预算闸门：评审也要烧 token，预算不够就停在预算暂停，不能偷跑。
    if (remainingTokensOf(taskRun) <= 0) return { kind: 'paused_budget' };

    const revision = taskRun.revision;
    const targetKey = criticTargetKeyOf(taskRun);
    const attemptId = latestSettledAttempt(taskRun)?.attemptId ?? null;
    const prompt = buildCriticPrompt({
      taskRun, verification, blackboard: rootRunOf(taskRun)?.blackboard ?? null,
    });

    let result = null;
    try {
      result = await criticReview({ taskRun, verification, prompt, attemptId, targetKey });
    } catch (err) {
      result = { status: 'error', code: 'threw', why: String(err?.message ?? err) };
    }

    // ★ 花了token就是花了：先记账，再判结论是不是过期（不能因为丢弃结论就不计消耗）。
    await chargeCriticTokens(taskRun, result?.usage);

    const current = read(taskRun.id);
    if (!current) return { kind: 'stale', why: 'task_missing' };
    if (current.revision !== revision) return { kind: 'stale', why: 'revision_changed' };
    if (current.state === STATE.cancelled || PAUSED.has(current.state)) {
      return { kind: 'stale', why: current.state };
    }

    if (result?.status !== 'reviewed' || result.ok !== true) {
      // 基础设施故障 / 解析失败：都不算业务缺陷，也不扣返工额度。
      const exhausted = await noteCriticError(current, result);
      return {
        kind: 'error', exhausted,
        code: result?.code ?? (result?.ok === false ? 'parse_error' : 'unknown'),
        why: result?.why ?? result?.reason ?? '评审失败',
      };
    }

    if (result.verdict === 'passed') {
      const written = await writeCriticPassed({
        taskRun: current, verification, result, revision, targetKey, attemptId,
      });
      if (!written) return { kind: 'stale', why: 'write_skipped' };
      return { kind: 'passed', reason: '独立复核通过：' + String(result.summary ?? '').slice(0, 120) };
    }

    const rounds = Number(current.criticState?.reworkCount ?? 0) + 1;
    const written = await writeCriticFailed({
      taskRun: current, verification, result, revision, targetKey, attemptId, rounds,
    });
    if (!written) return { kind: 'stale', why: 'write_skipped' };

    // ★ 有界：到上限就停，不再自动返工（无限重做是最贵的失败模式）。
    //
    //   ★ 顺序不能反：必须**先**把这次验收收口（`verification_finished` 会清掉
    //     `flags.verifyingAt`），**再** block。只 block 不清验证位的话，
    //     任务记录仍停在「验收中」：用户手动解除阻塞后会立刻被当成
    //     待验收任务重新 verify —— `criticRequired` 的任务拿旧产出秒回
    //     同一个 blocked，等于解除阻塞这个动作根本不生效（死锁）。
    if (rounds >= criticReworkLimit) {
      const top = String(result.defects?.[0] ?? result.summary ?? '').slice(0, 160);
      const reason = `独立复核连续 ${rounds} 轮未通过（上限 ${criticReworkLimit}）：${top}`;
      await settle(taskRun.id, {
        type: EVENT.verification_finished,
        revision,
        at: clock(),
        passed: false,
        unmet: (result.defects ?? []).map((d) => '独立复核：' + d),
        reason,
      });
      await block(taskRun.id, reason);
      return { kind: 'over_limit', rounds };
    }
    return {
      kind: 'failed',
      rounds,
      unmet: (result.defects ?? []).map((d) => '独立复核：' + d),
      reason: `独立复核未通过（第 ${rounds}/${criticReworkLimit} 轮），需按缺陷返工`,
    };
  }

  /** 评审消耗的 token 计入根预算（不得绕过 PR #43 的 maxTokens 闸门）。 */
  async function chargeCriticTokens(taskRun, usage) {
    const tokens = tokenCountOf(usage);
    if (!tokens) return 0;
    const rootId = taskRun.rootTaskId ?? taskRun.id;
    await taskRuns.mutate(rootId, {
      mutate: (cur) => {
        if (!cur) return null;
        const budget = { ...(cur.budget ?? {}) };
        budget.usedTokens = Number(budget.usedTokens ?? 0) + tokens;
        return { ...cur, budget, updatedAt: clock() };
      },
    });
    return tokens;
  }

  /** 记一笔「评审员自己没跑成」（不当作业务缺陷，有限重试）。 */
  async function noteCriticError(current, result) {
    const state = current?.criticState ?? {};
    const errors = Number(state.errorCount ?? 0) + 1;
    await patch(current.id, {
      criticState: {
        ...state,
        errorCount: errors,
        lastError: String(result?.why ?? result?.reason ?? '评审失败').slice(0, 200),
        lastErrorAt: clock(),
      },
    });
    // ★ `>=` 而不是 `>`：常量说的是「连续这么多次就停」，差一就是 4 次。
    if (errors >= MAX_CRITIC_ERRORS) {
      await block(
        current.id,
        `独立复核连续 ${errors} 次无法完成（${String(result?.why ?? result?.reason ?? '未知原因').slice(0, 120)}），已停下等人工处理`,
      );
      return true;
    }
    return false;
  }

  /** 评审通过：写入 expert 评审记录（若有 expert 条件）与 criticState。 */
  async function writeCriticPassed({
    taskRun, verification, result, revision, targetKey, attemptId,
  }) {
    const conditions = pendingExpertConditions(verification);
    const out = await taskRuns.mutate(taskRun.id, {
      mutate: (cur) => {
        if (!cur) return null;
        // ★ 写事务内再核一次版本/状态：评审耗时几十秒，中途什么都可能变。
        if (cur.revision !== revision) return null;
        if (cur.state === STATE.cancelled) return null;
        const reviews = [...(cur.expertReviews ?? [])];
        for (const condition of conditions) {
          reviews.push({
            taskRunId: cur.id,
            revision,
            conditionId: condition.id,
            verdict: 'passed',
            note: ('独立复核通过：' + String(result.summary ?? '')).slice(0, 600),
            attemptId,
            source: 'critic_review',
            reviewerModel: result.reviewerModel ?? null,
            at: clock(),
          });
        }
        const prev = cur.criticState ?? {};
        return {
          ...cur,
          expertReviews: reviews.slice(-200),
          criticState: {
            ...prev,
            lastTargetKey: targetKey,
            lastPassedKey: targetKey,
            lastVerdict: 'passed',
            lastSummary: String(result.summary ?? '').slice(0, 300),
            reviewerModel: result.reviewerModel ?? null,
            rounds: Number(prev.reworkCount ?? 0),
            reworkCount: 0,
            maxRounds: criticReworkLimit,
            errorCount: 0,
            at: clock(),
          },
          // 通过之后清掉返工清单：留着会让下一轮提示词继续骂人
          criticFeedback: null,
          updatedAt: clock(),
        };
      },
    });
    return out?.ok === true && out.changed !== false;
  }

  /** 评审不通过：写入 failed 评审记录 + 返工清单 + 轮次计数。 */
  async function writeCriticFailed({
    taskRun, verification, result, revision, targetKey, attemptId, rounds,
  }) {
    const conditions = pendingExpertConditions(verification);
    const defects = (result.defects ?? []).slice(0, 8);
    const note = defects[0] ?? String(result.summary ?? '');
    const out = await taskRuns.mutate(taskRun.id, {
      mutate: (cur) => {
        if (!cur) return null;
        if (cur.revision !== revision) return null;
        if (cur.state === STATE.cancelled) return null;
        const reviews = [...(cur.expertReviews ?? [])];
        for (const condition of conditions) {
          reviews.push({
            taskRunId: cur.id,
            revision,
            conditionId: condition.id,
            verdict: 'failed',
            note: String(note ?? '').slice(0, 600),
            attemptId,
            source: 'critic_review',
            reviewerModel: result.reviewerModel ?? null,
            at: clock(),
          });
        }
        const prev = cur.criticState ?? {};
        return {
          ...cur,
          expertReviews: reviews.slice(-200),
          criticState: {
            ...prev,
            lastTargetKey: targetKey,
            lastVerdict: 'failed',
            reworkCount: rounds,
            maxRounds: criticReworkLimit,
            reviewerModel: result.reviewerModel ?? null,
            errorCount: 0,
            at: clock(),
          },
          criticFeedback: {
            revision,
            round: rounds,
            maxRounds: criticReworkLimit,
            summary: String(result.summary ?? '').slice(0, 300),
            defects,
            reviewerModel: result.reviewerModel ?? null,
            attemptId,
            at: clock(),
          },
          updatedAt: clock(),
        };
      },
    });
    return out?.ok === true && out.changed !== false;
  }

  async function defaultVerify(taskRun, opts) {
    const verification = await verifyTaskRun(taskRun, { access, taskRuns, attemptId: opts?.attemptId ?? null });
    const passed = verification.passed === true
      && (verification.unmet ?? []).length === 0
      && (verification.needsReview ?? []).length === 0
      && (verification.blocked ?? []).length === 0;
    return { ...verification, passed };
  }

  /** 结果未知：只读核验 → 归档结果 → 根结算 → 清未知；核验不了就阻塞。 */
  async function inspectAndSettle(taskRun, { attemptId, slot }) {
    if (typeof inspectOutcome !== 'function') {
      await block(taskRun.id, '执行结果未知且没有核验入口，需人工确认', 'unknown_outcome');
      return false;
    }
    const found = await inspectOutcome({ taskRun, attemptId }).catch(() => null);
    if (!found?.resolved || !found.attemptEvent) {
      await block(taskRun.id, '执行结果未知且无法核验，需人工确认', 'unknown_outcome');
      return false;
    }
    const event = found.attemptEvent;
    const attempt = event.attempt ?? event;
    const finishEvent = {
      type: EVENT.attempt_finished,
      revision: attempt.revision ?? taskRun.revision,
      at: clock(),
      attempt,
    };
    // 已登记尝试的结算不受来源限制；没登记过的才需要先按合法迁移解除阻塞
    let settled = await settle(taskRun.id, finishEvent);
    if (!settled.ok && read(taskRun.id)?.state === STATE.blocked) {
      await settle(taskRun.id, {
        type: EVENT.unblocked, revision: taskRun.revision, at: clock(), reason: '核验到结果，解除阻塞',
      });
      if (read(taskRun.id)?.state === STATE.queued) {
        await settle(taskRun.id, { type: EVENT.dispatch, attemptId: attempt.attemptId, botId: attempt.botId ?? null, revision: taskRun.revision, at: clock() });
      }
      settled = await settle(taskRun.id, finishEvent);
    }
    if (!settled.ok) {
      await block(taskRun.id, '核验结果无法结算');
      return false;
    }
    const filled = await settleRootBudget({
      store: taskRuns,
      rootTaskId: taskRun.rootTaskId ?? taskRun.id,
      taskRunId: slot?.taskRunId ?? attempt.taskRunId ?? taskRun.id,
      attemptId: attempt.attemptId ?? attemptId,
      botId: slot?.botId ?? attempt.botId ?? null,
      revision: attempt.revision ?? taskRun.revision,
      at: clock(),
    });
    if (!filled.ok) {
      await block(taskRun.id, '结果已核验但根结算未落盘，等待恢复补齐', 'budget_settle');
      return false;
    }
    await patch(taskRun.id, { nextAction: null, recoverableBlock: null, unknownBlock: null });
    const fresh = read(taskRun.id);
    if (fresh?.state === STATE.blocked) {
      await settle(taskRun.id, { type: EVENT.unblocked, revision: fresh.revision, at: clock(), reason: '结果已核验并结算' });
      await patch(taskRun.id, { recoverableBlock: null, recoveryTries: 0 });
    }
    notify(taskRun.id);
    return true;
  }

  /**
   * 核对并解除依赖门槛（共用交回路径）。
   *
   * 只认：真实子任务、parentTaskId 一致、父目标版本一致、子任务已验收完成（有交付），
   * 门槛 ref 精确等于该子任务 id。通过既有 dependency_settled 归约解除后唤醒父任务。
   */
  async function releaseDependencyFor(parentTaskRun, childId = null) {
    const parent = parentTaskRun ? read(parentTaskRun.id) ?? parentTaskRun : null;
    if (!parent) return false;
    let released = false;
    for (const gate of [...(parent.openGates ?? [])]) {
      if (gate.kind !== 'dependency') continue;
      if (!gate.ref) continue;
      if (childId && gate.ref !== childId) continue;
      const child = read(gate.ref);
      if (!child) continue;
      if (child.parentTaskId !== parent.id) continue;
      if ((child.parentRevision ?? child.revision) !== parent.revision) continue;
      if (child.state !== STATE.completed || !child.delivery) continue;
      const out = await settle(parent.id, {
        type: EVENT.dependency_settled,
        revision: parent.revision,
        at: clock(),
        dependencyTaskId: child.id,
      });
      if (!out.ok) {
        log('依赖解除被拒：', parent.id, out.text ?? out.code);
        continue;
      }
      released = true;
    }
    if (released) notify(parent.id);
    return released;
  }

  /** 子任务交付时：解除父任务对应依赖门槛，再唤醒父任务。 */
  async function releaseParentDependency(childTaskRun) {
    const parent = childTaskRun?.parentTaskId ? read(childTaskRun.parentTaskId) : null;
    if (!parent) return false;
    return releaseDependencyFor(parent, childTaskRun.id);
  }

  async function deliver(taskRun) {
    const summary = buildDeliverySummary(taskRun);
    await patch(taskRun.id, { delivery: { summary, at: clock(), revision: taskRun.revision }, nextAction: null });
    log('交付', taskRun.id, summary.slice(0, 60));
    // ★ 交付事实自动落根任务的共享黑板（纯 mutate，0 次模型调用）。
    //   后来的人开工时会直接读到“前一个人交了什么东西、在哪里”，
    //   不必靠负责人在群里转述（转述要再烧一次模型，而且会走样）。
    //
    //   ★ 必须传**刚落盘的**快照：`taskRun` 是进 deliver 之前的旧记录，
    //     它的 delivery 还是空的 —— 直接传它会让自动产物条只剩 requirement，
    //     真正的交付摘要与产物路径全丢（审计 P1-2）。
    //     读不到时退回手工拼一份内容相同的快照，不能让黑板静默降级。
    const delivered = read(taskRun.id) ?? {
      ...taskRun,
      delivery: { summary, at: clock(), revision: taskRun.revision },
    };
    await writeBlackboardArtifact(delivered);
    // 共用交回事件：先按真实证据解除父的依赖门槛，再唤醒父任务
    await releaseParentDependency(taskRun);
    notifyParent(taskRun);
    // ★ 自动接力：因它而变 `ready` 的下游立刻叫醒 ——
    //   机械验收通过就开跑，不需要负责人再跑一轮模型去“推进度”。
    await wakeReadyDownstream(taskRun);
    return summary;
  }

  /**
   * 一份交付写进根任务黑板。
   *
   * 只写子任务（根自己的交付不是“同级信息”）；`appendEntry` 自带幂等，
   * 同一份交付重复收口不会写两条。
   */
  async function writeBlackboardArtifact(taskRun) {
    if (!taskRun?.parentTaskId) return false;
    const rootId = taskRun.rootTaskId ?? taskRun.parentTaskId;
    const entry = artifactEntryOf(taskRun, { nameOf: (id) => nameOfBot(id), at: clock() });
    if (!entry) return false;
    const out = await taskRuns.mutate(rootId, {
      mutate: (cur) => {
        if (!cur) return null;
        const next = appendEntry(cur.blackboard, entry, { now: clock() });
        if (!next.added) return null;
        return { ...cur, blackboard: next.blackboard, updatedAt: clock() };
      },
    });
    if (out?.ok && typeof onChanged === 'function') onChanged(rootId);
    return out?.ok === true;
  }

  /** 同父里因这份交付而变得可跑的下游，立刻唤醒（自动接力）。 */
  async function wakeReadyDownstream(child) {
    const parentId = child?.parentTaskId;
    if (!parentId) return;
    const parent = read(parentId);
    if (!parent) return;
    const siblings = childrenOf(taskRuns, parent);
    for (const kid of readyDownstreamOf(child.id, siblings)) {
      log('下游依赖已满足，自动接力', kid.id);
      notify(kid.id);
    }
  }

  /** 子任务停住时说清楚“为什么停”，交给负责人转述用。 */
  function kidFailureReason(kid, allKidsNow) {
    if (permanentlyBlocked(kid)) return String(kid.flags?.blockedReason ?? '未说明');
    const ups = upstreamFailedIds(kid, allKidsNow);
    if (!ups.length) return String(kid.flags?.blockedReason ?? '未说明');
    const who = ups
      .map((id) => nameOfBot(allKidsNow.find((run) => run.id === id)?.owner?.leadBotId) || id)
      .join('、');
    return '上游分工没完成（' + who + '），等不到前置产物';
  }

  /**
   * 子任务全部停住了：交回负责人重排，或如实阻塞父任务。
   *
   * ## 为什么是一整块而不是三行
   *
   * “交回”要同时做三件事：把停住的分工收口（取消 + 写清原因）、把失败原因
   * 记到父任务上（负责人下一轮才看得见）、把父任务的停滞计数清零（否则
   * 刚交回一次就被判停滞）。少做任何一件，用户看到的都是「任务卡住了」。
   *
   * @returns {Promise<{action:'continue'}|{status:string, why:string}>}
   */
  async function handBackBlockedChildren({ parentNow, stuck, allKidsNow }) {
    // ★ 交回负责人也没用的那些（鉴权/余额/中止/审批/显式 impossible）：
    //   换人、拆小、重排都还是同一个死因，直接如实阻塞父任务，别空转 2 轮
    const noHandBack = handBackBlockedBy(stuck.filter(permanentlyBlocked));
    if (noHandBack) {
      await block(parentNow.id, '分工卡在不可恢复的问题上（' + noHandBack.kind + '）：'
        + String(noHandBack.why ?? '').slice(0, 120)
        + '。已跳过错峰重排，需要你处理后才能继续');
      return { status: 'blocked', why: 'children_non_retriable' };
    }
    const handBacks = Number(parentNow.childHandBacks ?? 0);
    if (autonomousOf(parentNow) && handBacks < MAX_CHILD_HANDBACKS) {
      const failures = stuck.map((kid) => ({
        taskRunId: kid.id,
        botId: kid.owner?.leadBotId ?? null,
        name: nameOfBot(kid.owner?.leadBotId) || '成员',
        requirement: String(kid.goal?.requirement ?? '').slice(0, 160),
        reason: kidFailureReason(kid, allKidsNow).slice(0, 160),
        at: clock(),
      }));
      for (const kid of stuck) {
        await settle(kid.id, {
          type: EVENT.cancelled, revision: kid.revision, at: clock(),
          // 因上游而死的那份活：说清它不是自己的错，否则负责人会去重派同一个人
          reason: permanentlyBlocked(kid)
            ? '成员受阻，交回负责人重新安排'
            : '上游分工没完成，这份活等不到前置，随上游一并收回',
        }).catch(() => null);
      }
      await patch(parentNow.id, {
        childHandBacks: handBacks + 1,
        childFailures: [...(parentNow.childFailures ?? []), ...failures].slice(-6),
        stall: null,
      });
      log('子任务全部停住，交回负责人重新安排', parentNow.id, failures.length);
      return { action: 'continue' };
    }
    const anchor = stuck.find(permanentlyBlocked) ?? stuck[0];
    const who = nameOfBot(anchor.owner?.leadBotId) || '成员';
    const downstream = stuck.filter((kid) => upstreamFailedIds(kid, allKidsNow).length);
    const why = '等在子任务上：' + who + '受阻（'
      + String(anchor.flags?.blockedReason ?? '未说明').slice(0, 80) + '）'
      + (downstream.length ? '；另有 ' + downstream.length + ' 份分工因依赖它而无法启动' : '')
      + (handBacks >= MAX_CHILD_HANDBACKS ? '；已交回负责人重新安排 ' + handBacks + ' 次仍未解决' : '');
    await block(parentNow.id, why);
    return { status: 'blocked', why: 'children_blocked' };
  }

  /** 子任务进入终态后唤醒父任务；父任务会按自己的判定继续汇总/验收。 */
  function notifyParent(taskRun) {
    const parentId = taskRun?.parentTaskId;
    if (!parentId) return;
    notify(parentId);
  }

  /** 这条任务的根记录（自己是根就返回自己）。 */
  function rootRunOf(taskRun) {
    const rootId = taskRun?.rootTaskId ?? taskRun?.id;
    if (!rootId) return null;
    return rootId === taskRun.id ? taskRun : read(rootId);
  }

  /** 放行一份等把关的子任务（账本 + 唤醒都在 `task-checkpoint.js`）。 */
  async function approveCheckpoint(childTaskRunId, opts = {}) {
    return approveCheckpointIn({
      taskRuns, childTaskRunId, notify, clock, ...opts,
    });
  }

  /** 把一个父任务下所有等把关的子任务一次放行。 */
  async function approveCheckpointsOf(parentTaskRunId, opts = {}) {
    return approveCheckpointsOfIn({
      taskRuns, parentTaskRunId, notify, clock, ...opts,
    });
  }

  async function recordStall(taskRun) {
    const current = read(taskRun.id) ?? taskRun;
    await patch(current.id, { stall: bumpStall(current) });
  }

  /** 控制入口：类型封闭、决定归一化、到达/早到/重放同一规则。 */
  async function onControl(taskRunId, control = {}) {
    return applyControl({ taskRuns, taskRunId, control, settle, patch, notify, block, clock });
  }

  async function cancelTask(taskRunId, control = {}) {
    // 在途取消：先终止本任务真实执行，再落取消状态（不用整房间 abort）
    if (typeof abortInflight === 'function') {
      await abortInflight({ taskRunId, revision: read(taskRunId)?.revision ?? null }).catch(() => {});
    }
    return onControl(taskRunId, { ...control, type: CONTROL.cancel });
  }

  async function bumpRevision(taskRunId, control = {}) {
    const result = await onControl(taskRunId, { ...control, type: CONTROL.revision });
    if (!result?.ok) return result;
    // ★ 改版就从头算：上一版的评审结论（含返工轮次、缺陷清单、已通过指纹）
    //   绑的都是旧目标，留着只会让新一轮被旧结论卡住或被旧清单误骂。
    await patch(taskRunId, { criticState: null, criticFeedback: null });
    // ★ 改版后，上一版的子任务必须收口。
    //
    //   childrenOf 按 parentRevision 过滤：父任务一改版，旧子任务立刻
    //   不再参与推进、也不再进 childrenSummary —— 但它们仍然是非终态。
    //   用户看到的是「成员还在跑，可任务列表里一个都看不到」，
    //   而且这些子任务永远不会有结论。
    //   这里显式取消它们，让状态与界面一致。
    try {
      const parent = read(taskRunId);
      if (parent) {
        const all = taskRuns.listAll?.();
        const list = all?.taskRuns ?? all ?? [];
        const stale = list.filter((run) => run.parentTaskId === parent.id
          && (run.parentRevision ?? run.revision) !== parent.revision
          && run.state !== STATE.completed && run.state !== STATE.cancelled);
        for (const kid of stale) {
          await settle(kid.id, {
            type: EVENT.cancelled, revision: kid.revision, at: clock(),
            reason: '父任务目标已改版，上一版子任务作废',
          }).catch(() => null);
        }
        if (stale.length) log('改版收口旧子任务', taskRunId, stale.length);
      }
    } catch (err) {
      log('改版收口旧子任务失败：', err?.message || err);
    }
    return result;
  }

  /** 扩额恢复：沿用既有扩展协议，唤醒等待中的任务。 */
  /**
   * 扩额恢复：额度只在根上加一次（预算协调器是唯一写入源）。
   *
   *   · 根自身预算暂停 → 用既有 resumed 协议解除；
   *   · 共享子任务不拥有独立额度，按根已追加的事实恢复；
   *   · 只解除预算暂停，不覆盖用户暂停/其他门槛。
   */
  /**
   * 扩额恢复（root 与 child 入口共用同一协议）：
   *
   *   1. 解析根，额度只在根上加一次；
   *   2. 找到共享该根、父版本有效、且处于预算暂停的等待者；
   *   3. 同步「根已追加」事实 → 各自走既有 resumed 协议解除预算暂停；
   *   4. 保留用户暂停与其他门槛；门槛之后解除时直接可用已加额度。
   */
  async function onBudgetExtended(taskRunId, { extraRuns = null, extraTokens = null } = {}) {
    const run = read(taskRunId);
    if (!run) return { ok: false, code: 'not_found' };
    const rootId = run.rootTaskId ?? run.id;

    const extended = await extendRootBudget({
      store: taskRuns, rootTaskId: rootId, extraRuns, extraTokens, at: clock(),
    });
    if (!extended.ok) return extended;
    const rootNow = read(rootId) ?? extended.taskRun;
    const sharedExtra = Number(rootNow?.budget?.extraRuns ?? extraRuns ?? 0);
    const sharedExtraTokens = Number(rootNow?.budget?.extraTokens ?? extraTokens ?? 0);

    const results = [];
    /** 恢复成功、待统一唤醒的任务（子任务在前，根在最后）。 */
    const resumedIds = [];
    const resumeBudgetPaused = async (candidate) => {
      const current = read(candidate.id);
      if (!current || current.state !== STATE.paused_budget) return null;
      if (current.id !== rootId) {
        // 父版本必须仍然有效，子任务才属于当前这一版目标
        const parent = current.parentTaskId ? read(current.parentTaskId) : null;
        if (!parent || current.parentRevision !== parent.revision) return null;
        await patch(current.id, {
          budget: {
            ...(current.budget ?? {}),
            sharedExtraRuns: sharedExtra,
            sharedExtraTokens,
          },
        });
      }
      const resumed = await settle(current.id, {
        type: EVENT.resumed, revision: current.revision, at: clock(),
      });
      results.push({ taskRunId: current.id, ok: resumed.ok, code: resumed.code ?? null });
      // ★ 这里**不能**立刻 notify：整棵树是逐个恢复的，先醒来的根会看到
      //   还在 paused_budget 的子任务，于是「全部子任务都在预算暂停」那条
      //   判定又把根暂停回去 —— 扩额按钮就变成了假的（子任务永远起不来）。
      //   统一在循环结束后一次性唤醒（子任务在内、根在最后）。
      if (resumed.ok) resumedIds.push(current.id);
      return resumed;
    };

    // 共享这个根的所有任务（含根本身）
    const candidates = allRuns().filter((item) => (item.rootTaskId ?? item.id) === rootId);
    for (const candidate of candidates) await resumeBudgetPaused(candidate);
    // 本次目标若不在候选里（例如自身就是 root 但尚未建立 rootTaskId），兜底一次
    if (!candidates.some((c) => c.id === taskRunId)) await resumeBudgetPaused(run);
    // 全部恢复完再唤醒：子任务先醒，根最后（否则根会看见还没恢复的子任务又暂停自己）
    for (const id of [...resumedIds].reverse()) notify(id);

    // ★ 追加额度只解决「钱」的问题，不替用户做「要不要继续」的决定。
    //
    //   预算暂停（paused_budget）本来就是额度造成的，加钱即恢复 —— 上面已处理。
    //   而 blocked 是任务本身卡住（执行失败/缺信息），加额度并不会让它变好；
    //   顺手解除反而掩盖了真实问题。
    //
    //   但也不能什么都不说：如果目标是 blocked，把「加了额度但任务仍受阻、
    //   需要先解除阻塞」如实告诉调用方，不要回一个空洞的 ok。
    {
      const target = read(taskRunId);
      if (target && target.state === STATE.blocked) {
        return {
          ok: true,
          budget: read(rootId)?.budget ?? null,
          resumed: results.map((r) => r.taskRunId),
          note: '额度已追加，但任务当前是「受阻」状态（原因：'
            + String(target.flags?.blockedReason ?? '未说明').slice(0, 80)
            + '）。额度不会解除阻塞，请先解除阻塞再继续。',
        };
      }
    }

    notify(rootId);
    const failed = results.find((r) => r.ok !== true);
    if (failed) return { ok: false, code: failed.code ?? 'resume_failed', results };
    return { ok: true, budget: read(rootId)?.budget ?? null, resumed: results.map((r) => r.taskRunId) };
  }

  /**
   * 重启恢复：对每个任务只按 decideRecovery 给出的一个阶段推进，逐步闭合。
   *
   * 结果未知 → 只读核验一次；结果已知 → 只补根结算；结算完成 → 清对应阻塞并唤醒。
   * 任何写入失败都累计恢复尝试并停止本轮，不反复 inspect/写盘。
   */
  async function recover() {
    const report = { released: [], unknown: [], resumed: [], settleFilled: [], blocked: [], deferred: [] };
    const all = allRuns();
    const MAX_TRIES = 3;

    for (const snapshot of all) {
      if (terminal(snapshot)) continue;
      let failed = null;
      for (let i = 0; i < 8; i += 1) {
        const run = read(snapshot.id);
        if (!run || terminal(run)) break;
        const rootId = run.rootTaskId ?? run.id;
        const root = read(rootId) ?? run;
        const { stages } = decideRecovery(run, { root, load: read, clock });
        if (!stages.length) break;
        const st = stages[0];

        if (st.stage === RECOVERY_STAGE.releaseReserved) {
          // 先保存恢复意图，再在事务内释放占位（不删唯一依据，也不用无条件 save 覆盖）
          // 顺序固定：先保存恢复意图 → 再退款（占位还在）→ 最后事务内释放占位
          await patch(run.id, { resumeIntent: 'reserved_released' });
          const refunded = await refundRootBudget({
            store: taskRuns, rootTaskId: rootId, taskRunId: st.ownerRunId ?? run.id,
            attemptId: st.attemptId, botId: st.slot?.botId ?? null,
            revision: st.slot?.revision ?? run.revision, at: clock(),
          });
          if (!refunded.ok && refunded.code !== 'nothing_to_refund') {
            failed = refunded.text ?? refunded.code;
            break;
          }
          const released = await taskRuns.mutate(run.id, {
            mutate: (current) => {
              if (!current) return null;
              const plan = TaskRunStore.releaseNotStarted(current, { at: clock() });
              return plan.changed ? plan.taskRun : null;
            },
          });
          if (!released.ok) { failed = released.text ?? released.code ?? 'release_failed'; break; }
          report.released.push({ taskRunId: st.ownerRunId ?? run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.inspectUnknown) {
          if (typeof inspectOutcome !== 'function') {
            await block(run.id, '执行结果未知且没有核验入口，需人工确认', 'unknown_outcome');
            report.blocked.push({ taskRunId: run.id, attemptId: st.attemptId, reason: 'no_inspector' });
            break;
          }
          const found = await inspectOutcome({ taskRun: run, attemptId: st.attemptId }).catch(() => null);
          if (!found?.resolved || !found.attemptEvent) {
            await block(run.id, '执行结果未知且无法核验，需人工确认', 'unknown_outcome');
            report.blocked.push({ taskRunId: run.id, attemptId: st.attemptId, reason: 'unverifiable' });
            break;
          }
          const attempt = found.attemptEvent.attempt ?? found.attemptEvent;
          const finishEvent = {
            type: EVENT.attempt_finished,
            revision: attempt.revision ?? run.revision,
            at: clock(),
            attempt,
          };
          let settled = await settle(run.id, finishEvent);
          if (!settled.ok && read(run.id)?.state === STATE.blocked) {
            await settle(run.id, {
              type: EVENT.unblocked, revision: run.revision, at: clock(), reason: '核验到结果，解除阻塞',
            });
            if (read(run.id)?.state === STATE.queued) {
              await settle(run.id, { type: EVENT.dispatch, attemptId: attempt.attemptId, botId: attempt.botId ?? null, revision: run.revision, at: clock() });
            }
            settled = await settle(run.id, finishEvent);
          }
          if (!settled.ok) { failed = settled.text ?? settled.code; break; }
          report.unknown.push({ taskRunId: run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.settleBudget) {
          const filled = await settleRootBudget({
            store: taskRuns, rootTaskId: rootId, taskRunId: st.ownerRunId ?? run.id,
            attemptId: st.attemptId, botId: st.slot?.botId ?? null,
            revision: st.slot?.revision ?? run.revision, at: clock(),
          });
          if (!filled.ok) { failed = filled.text ?? filled.code; break; }
          report.settleFilled.push({ taskRunId: st.ownerRunId ?? run.id, attemptId: st.attemptId });
          continue;
        }

        if (st.stage === RECOVERY_STAGE.deferUpstream) {
          // 上游退避还没到期：只挂定时器，不解阻也不抢跑（到期由既有唤醒链路接手）
          if (Number.isFinite(st.dueAt)) setTimer(st.dueAt, run.id);
          report.deferred.push({ taskRunId: run.id, dueAt: st.dueAt });
          break;
        }

        if (st.stage === RECOVERY_STAGE.clearBlocked) {
          const unblocked = await settle(run.id, {
            type: EVENT.unblocked, revision: run.revision, at: clock(), reason: '恢复补齐后解除阻塞',
          });
          if (!unblocked.ok) { failed = unblocked.text ?? unblocked.code; break; }
          // 与「重试到期解阻」那条路（runTask 里）对齐：可恢复标记、到期时间、恢复计数一起清。
          // 留一个过期的 retryAt，下一轮会重复判「重试到期」，甚至拿旧时间点去排新的退避。
          await patch(run.id, { recoverableBlock: null, unknownBlock: null, retryAt: null, recoveryTries: 0 });
          report.resumed.push(run.id);
          notify(run.id);
          continue;
        }

        if (st.stage === RECOVERY_STAGE.firstDispatch) {
          // 持久 next.action=dispatch + 完整 owner 证据；只唤醒既有 supervisor，不手工造 attempt。
          report.resumed.push(run.id);
          notify(run.id);
          break;
        }

        if (st.stage === RECOVERY_STAGE.resume) {
          if (run.resumeIntent) await patch(run.id, { resumeIntent: null });
          if (Number.isFinite(run.retryAt) && run.retryAt > clock()) setTimer(run.retryAt, run.id);
          report.resumed.push(run.id);
          notify(run.id);
          break;
        }
      }

      // 等待依赖的任务：恢复时唤醒一次，走共用依赖核对（child 已完成则解除并继续）
      const waiting = read(snapshot.id);
      if (waiting?.state === STATE.waiting_dependency && !failed
          && (waiting.openGates ?? []).some((g) => g.kind === 'dependency')) {
        report.resumed.push(waiting.id);
        notify(waiting.id);
      }

      if (failed) {
        const fresh = read(snapshot.id) ?? snapshot;
        const tries = (fresh.recoveryTries ?? 0) + 1;
        await patch(snapshot.id, { recoveryTries: tries });
        if (tries >= MAX_TRIES) {
          await block(snapshot.id, '恢复多次写盘失败，暂停自动恢复，需人工确认（不重放外部动作）', 'recovery_exhausted');
        }
        report.blocked.push({ taskRunId: snapshot.id, reason: 'recovery_write_failed', tries, detail: String(failed).slice(0, 120) });
      }
    }
    return report;
  }

  return {
    notify, idle, runTask, onControl, cancelTask, bumpRevision, onBudgetExtended, recover, read,
    approveCheckpoint, approveCheckpointsOf,
    descendants: (id) => descendantsOf(taskRuns, id),
    dispose() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

/**
 * 停滞计数（两档）。
 *
 *   · `milestoneRounds`：目标签名没变 +1，变了清零 —— 「目标有没有推进」；
 *   · `rounds`：签名没变**且这一段没干活**才 +1；干了活或签名变了都清零 ——
 *     「是不是真卡住了」。
 *
 * 不传 didWork（验收、失败善后等非执行路径）时两档一起按签名累计，与旧行为一致。
 *
 * @param {object} taskRun
 * @param {{didWork?:boolean}} [opts]
 */
export function bumpStall(taskRun, { didWork = false } = {}) {
  const sig = progressSignature(taskRun);
  const prev = taskRun?.stall ?? { rounds: 0, lastSignature: null, milestoneRounds: 0 };
  if (prev.lastSignature !== sig) return { rounds: 0, lastSignature: sig, milestoneRounds: 0 };
  // 旧记录没有 milestoneRounds：按 rounds 起算，别让升级后的第一轮把计数清零
  const milestoneRounds = Number(prev.milestoneRounds ?? prev.rounds ?? 0) + 1;
  const rounds = didWork ? 0 : Number(prev.rounds ?? 0) + 1;
  return { rounds, lastSignature: sig, milestoneRounds };
}

/**
 * 这一段执行有没有真实干活。
 *
 * 只认运行层观察到的事实，不认模型自己说的：
 *   · 工作区里有文件被新增/修改（执行器的 change-watch 结果 `work.files`）；
 *   · 这一段登记了产物（附件 / 交付物）。
 *
 * @param {object|null} raw 执行器原始返回
 * @returns {boolean}
 */
export function workDoneBy(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Number(raw.work?.files ?? 0) > 0) return true;
  const listed = Array.isArray(raw.attemptEvent?.attempt?.artifacts)
    ? raw.attemptEvent.attempt.artifacts
    : (Array.isArray(raw.artifacts) ? raw.artifacts : []);
  return listed.some((a) => (typeof a === 'string' ? a.trim() : a));
}

export { NEXT, LEAD_PHASE, buildLeadPrompt, buildMemberPrompt, buildDeliverySummary };
