/**
 * 任务阶段提示词与交付摘要（纯文本，无 IO）。
 *
 * 负责人分三个阶段：规划派活、验收补派、最终交付。提示词只说阶段职责、
 * 目标与已有成果，不泄露内部实现细节；交付摘要用确定性文本，不调用模型。
 *
 * ## 两块必需件的注入点
 *
 * 受控 DAG 与共享黑板的价值全在「自动出现在提示词里」：
 *   · 成员开工时能看到**前置的交付**（上游产物路径 + 摘要）与**全组黑板**；
 *   · 负责人每一轮都能看到黑板与**待放行的 checkpoint** 清单。
 * 不注入的话，前置产物与全组约束等于不存在，成员会把同一件事重做一遍。
 * 两份注入都走纯函数（`collectUpstreamContext` / `renderBlackboard`），
 * 且只在该出现的时候出现（没有前置 / 黑板空就一个字都不加）。
 */
import {
  collectUpstreamContext, pendingCheckpointKids, planStepBindings, planStepNote, planWaitingSteps,
} from './task-dag.js';
import { renderBlackboard } from './task-blackboard.js';
import { renderCriticFeedback } from './task-critic.js';
import { worktreePromptNote } from './task-worktree-policy.js';
export const LEAD_PHASE = Object.freeze({
  plan: 'plan',
  verify: 'verify',
  deliver: 'deliver',
});

/**
 * 返工清单（独立复核未通过时注入）。
 *
 * ★ 只注入**属于当前版本**的那一份：改版后旧缺陷不再适用，
 *   继续贴旧清单会让执行者去修已经不存在的问题。
 *
 * @param {object|null} taskRun
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
export function criticFeedbackBlock(taskRun, { maxChars = 1200 } = {}) {
  const feedback = taskRun?.criticFeedback ?? null;
  if (!feedback || !Array.isArray(feedback.defects) || !feedback.defects.length) return '';
  if (Number(feedback.revision) !== Number(taskRun?.revision)) return '';
  return renderCriticFeedback(feedback, { maxChars });
}

/** 计划条目在这一刻的状态（按派活时的认领规则，与调度同一份 `planStepBindings`）。 */
function planStepStatus(kid) {
  if (!kid) return '还没派出去';
  if (kid.state === 'completed') return '已完成';
  if (planWaitingSteps(kid).length) return '已派出，挂着等前面的条目派出';
  return '已派出';
}

/**
 * 负责人每轮读到的那份计划：条目 + 依赖/把关说明 + 派出状态。
 *
 * 没有计划返回空串（调用方据此不加这一段）。
 *
 * @param {Array<object>|undefined} steps
 * @param {Array<object>} children 同父同版本的子任务
 * @returns {string}
 */
export function planBlock(steps, children = []) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const bound = planStepBindings(steps, children);
  return '已经定下的分工（按这个执行，缺哪条补哪条）：\n'
    + steps.map((s, i) => {
      const note = planStepNote(s, i);
      return (i + 1) + '. ' + (s.memberName ?? '') + '：' + (s.task ?? '')
        + (note ? '［' + note + '］' : '')
        + '（' + planStepStatus(bound.get(i + 1)) + '）';
    }).join('\n');
}

/**
 * 负责人阶段提示词。
 *
 * @param {object} p
 * @param {string} p.phase 见 LEAD_PHASE
 * @param {object} p.taskRun
 * @param {string} [p.extra]
 * @param {Array<object>} [p.children] 同父同版本的子任务（算待放行的 checkpoint 用）
 * @param {object} [p.blackboard] 根任务共享黑板（不传就读 `taskRun.blackboard`）
 * @param {Function} [p.nameOf] botId → 名字
 * @returns {string}
 */
export function buildLeadPrompt({
  phase, taskRun, extra = '', children = [], blackboard = null, nameOf = null,
} = {}) {
  const goal = taskRun?.goal ?? {};
  // 私聊 direct：主控亲自干，没有部门、没有成员可派
  const solo = taskRun?.owner?.roomKind === 'dm';
  const lines = [
    `任务目标：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
    (taskRun?.inputs ?? []).length ? '用户补充：' + taskRun.inputs.slice(-3).map((x) => String(x.text ?? '')).filter(Boolean).join('；') : '',
    // 已有计划：每轮都读一遍，按它对齐全场，而不是每轮重新想。
    // ★ 每条带上依赖/把关说明与派出状态：负责人靠它知道「哪条还没派」「谁在等谁」，
    //   否则计划里的依赖只在写计划那一轮看得见，之后就只剩一句「缺哪条补哪条」。
    planBlock(taskRun?.plan?.steps, children),
    (taskRun?.progress?.unmet ?? []).length
      ? `还缺：${[].concat(taskRun.progress.unmet).slice(0, 6).join('；')}`
      : '',
  ].filter(Boolean);

  // ★ 成员受阻、被系统收回的分工：负责人必须知道，才能换人 / 拆小 / 自己上。
  //   不说的话，负责人看到的只是「还缺」，很可能原样再派给同一个人。
  const failures = Array.isArray(taskRun?.childFailures) ? taskRun.childFailures.slice(-4) : [];
  if (failures.length) {
    lines.push(
      '这些分工没完成（成员受阻，已收回交给你重新安排）：\n'
        + failures
          .map((f) => `- ${f.name || '成员'}：${String(f.requirement ?? '').slice(0, 80)}（原因：${String(f.reason ?? '未说明').slice(0, 80)}）`)
          .join('\n')
        + '\n换一个成员、把活拆小一点重新派，或者你自己上手（自己做的要说一句「这件我直接做了，因为…」）。'
        + '不要原样再派给同一个人。',
    );
  }

  // ★ 共享黑板：全组共用的事实与约束。每轮都读一遍，按它对齐 ——
  //   否则同一件事会被不同人按不同口径做一遍。
  const board = renderBlackboard(blackboard ?? taskRun?.blackboard ?? null);
  if (board) {
    lines.push(board);
    lines.push('上面是全组共用的事实与约束，按它对齐；有新的决定/约束用 task_blackboard 记下来（自动给所有人看）。');
  }

  // ★ 待放行的 checkpoint：它们停着等这一声「可以开始了」。
  //   不主动列出来的话，负责人只看到「还缺」或「推进中」，不会想到是自己没放行。
  const checkpoints = pendingCheckpointKids(children);
  // ★ 被计划挂起的（前置条目还没派出去）和真正「前置交付了等你审」的分开说：
  //   混在一起的话，负责人会去审一份根本还没有前置产物的活，然后直接放行 —— 下游抢跑。
  const held = checkpoints.filter((k) => planWaitingSteps(k).length);
  const reviewable = checkpoints.filter((k) => !planWaitingSteps(k).length);
  if (reviewable.length) {
    const detail = reviewable.map((k) => {
      const title = String(k?.goal?.requirement ?? '').slice(0, 80);
      const upstream = collectUpstreamContext(k, children, { maxChars: 400, nameOf });
      return `- ${title}（子任务 ${k.id}，设了「完成后先由你放行」，正在等你）`
        + (upstream ? '\n  ' + upstream.split('\n').join('\n  ') : '');
    }).join('\n');
    lines.push(
      '这些分工的前置已经都交付了，但设了「完成后先由你放行」，现在停着等你把关：\n'
        + detail
        + '\n审一下前置产物够不够：够就调用 approve_subtask_checkpoint 放行（放行后它会立刻自动开跑）；'
        + '不够就改派或取消这份分工。不要放着不管。',
    );
  }
  if (held.length) {
    const detail = held.map((k) => {
      const title = String(k?.goal?.requirement ?? '').slice(0, 80);
      const waits = planWaitingSteps(k)
        .map((w) => '第 ' + w.index + ' 条「' + String(w.task ?? '').slice(0, 40) + '」')
        .join('、');
      return `- ${title}（子任务 ${k.id}）：计划里它要等 ${waits}，但那几条还没派出去`;
    }).join('\n');
    lines.push(
      '这些分工按计划要等前面的条目，可那些条目还没派出去，所以它们先挂着没开跑：\n'
        + detail
        + '\n把缺的那几条派出去（派出后会自动接上依赖，前置交付了它们就自己开跑）；'
        + '确定不用等了，就用 approve_subtask_checkpoint 直接放行。',
    );
  }

  if (phase === LEAD_PHASE.plan && solo) {
    lines.push('这件事由你亲手做完：直接动手，一步一步推进到能交付为止。');
    lines.push(
      '做完用 task_report 报 apply_completion（evidence 写清交付的文件）；'
        + '还没做完就接着做，不要停下来问要不要继续，也不要只给计划就收手。',
    );
  } else if (phase === LEAD_PHASE.plan) {
    lines.push('把这件事拆成可执行的小任务，派给部门成员，交给他们去做。');
    // ★ 没有计划才催列计划；已有计划就该照着推进，不能每轮重列一遍。
    if (!(taskRun?.plan?.steps ?? []).length) {
      lines.push(
        '先把分工写成计划（用 task_plan：谁做什么、交付什么、按什么顺序），'
          + '再照着它一个一个派出去；没列计划就直接派，容易漏人或重复派。',
      );
    } else {
      lines.push('按上面这份分工推进：还没派出去的补齐，派出去的等它交回来再核对。');
    }
    // ★ @ 就是派活：系统会把正文里的 @ 解析成持久子任务，成员随后被唤醒。
    //   所以鼓励用 @ 一个一个交代；需要精确验收条件时才用 assign_member_task。
    lines.push(
      '派活方式：在正文里 @成员 一次一个，写清要它做什么、交付什么；' +
        '系统会为它建子任务并唤醒它。',
    );
    lines.push(
      '需要给出精确验收条件（格式/数量/必须附回执）时，改用 assign_member_task 建子任务。',
    );
    lines.push('不要向用户确认是否继续，也不要只给计划就停下。');
  } else if (phase === LEAD_PHASE.verify) {
    lines.push('核对已有产物是否满足验收条件：缺什么补派什么，不要直接宣布完成。');
  } else if (phase === LEAD_PHASE.deliver) {
    lines.push('验收已通过。用一两句话向主控汇报这个部门交付了什么。');
  }
  // ★ 用户授权「自己搞定」时，明确告诉负责人不要停下来问。
  //   不说这一句的话，模型会在「要不要继续」上打转，一件事变成十次对话。
  if (taskRun?.flags?.autonomous === true) {
    lines.push(AUTONOMY_RULE);
  }
  // ★ 独立复核未通过：负责人也要看得到（它要决定是补派、拆小，还是自己上）。
  const rework = criticFeedbackBlock(taskRun);
  if (rework) lines.push(rework);
  if (extra) lines.push(extra);
  return lines.join('\n');
}

/**
 * 自主推进的规矩（负责人 / 成员 / 续段共用一份，改一处全生效）。
 *
 * 核心是把「问用户」从阻塞改成不阻塞：拿不准的地方按最合理的假设推进、
 * 把假设记下来交代清楚 —— 用户随时可以插话纠正（全双工），不需要停下来等。
 */
export const AUTONOMY_RULE =
  '这件事是自主推进的：一直做到有可核验的结果为止。'
  + '不要停下来问用户「要不要继续」，也不要只给计划就收手；'
  + '拿不准的地方按最合理的做法先推进，把你做的假设记下来、在汇报里列出来（用户随时可以插话纠正）；'
  + '验收没过就自己补做再交。'
  + '只有这几种情况才停下来说明：要做不可逆的操作（删数据、对外发布、花钱）、'
  + '缺只有用户才能给的东西（账号密码、授权、原始数据），或者两个方向差别很大又没法回头。';

/**
 * 续段提示：上一段执行让出（时间片用完）或被中断（服务重启）时，
 * 告诉它从断点接着做，而不是把整件事从头再来一遍。
 *
 * 只看本任务账本里的**最后一条**尝试：让出 → 续段；其余 → 不加。
 *
 * @param {object} taskRun
 * @param {{autonomous?:boolean}} [opts]
 * @returns {string} 不需要续段时返回空串
 */
export function continuationNote(taskRun, { autonomous = false } = {}) {
  const ledger = Array.isArray(taskRun?.attempts) ? taskRun.attempts : [];
  const last = ledger[ledger.length - 1] ?? null;
  if (!last || last.state !== 'settled' || last.result?.stop !== 'yielded') return '';
  const interrupted = /中断|重启/.test(String(last.result?.reason ?? ''));
  return [
    interrupted
      ? '【续段】上一段执行被中断了（服务重启等原因），不是你出了错。'
      : '【续段】上一段执行时间用完，系统让你接着做下一段。',
    '你的会话记录里有上一段的完整过程：先花一两步核对现状（文件、进程、已完成到哪），'
      + '然后从断点继续；不要从头再来，也不要重复已经做完的步骤（尤其是会产生副作用的操作）。',
    autonomous ? '做完前不需要问用户要不要继续。' : '',
  ].filter(Boolean).join('\n');
}
/**
 * 成员执行提示词：只拿被派的那份工作，不越权改目标。
 *
 * 额外自动注入两块短上下文（都只在有内容时注入）：
 *   · `upstreamContext`：前置子任务已经交了的东西（产物路径 + 摘要）——
 *     不说的话成员会把上游刚做完的活再做一遍；
 *   · `blackboard`：根任务共享的决定/约束/事实 —— 不说的话同一件事多人多口径。
 *
 * @param {object} p
 * @param {object} p.childTaskRun
 * @param {object} [p.parentTaskRun]
 * @param {boolean} [p.autonomous]
 * @param {Array<object>} [p.siblings] 同父同版本的子任务（取前置交付用）
 * @param {object} [p.blackboard] 根任务共享黑板（不传就读 `parentTaskRun.blackboard`）
 * @param {Function} [p.nameOf] botId → 名字
 * @returns {string}
 */
export function buildMemberPrompt({
  childTaskRun, parentTaskRun, autonomous = false, siblings = [], blackboard = null, nameOf = null,
} = {}) {
  const goal = childTaskRun?.goal ?? {};
  const lines = [
    `你被分配的子任务：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
  ].filter(Boolean);
  if (parentTaskRun?.goal?.requirement) {
    lines.push(`所属目标：${parentTaskRun.goal.requirement}`);
  }
  // ★ 前置交付：ONLY 已完成的那几个（还在跑的不算）。
  const upstream = collectUpstreamContext(childTaskRun, siblings, { nameOf });
  if (upstream) lines.push(upstream);
  // ★ 全组黑板：约束/决定/事实/别人交了什么。
  const board = renderBlackboard(blackboard ?? parentTaskRun?.blackboard ?? null);
  if (board) lines.push(board);
  // ★ 还缺什么（机械验收未通过的条目）：不写的话执行者只能从上一轮的
  //   对话里自己猜哪里不对，于是改错地方、反复交同一份东西。
  const unmet = [...(childTaskRun?.progress?.unmet ?? [])].slice(0, 6);
  if (unmet.length) {
    lines.push('上一轮还差这些（逐条修掉再交）：\n' + unmet.map((u, i) => `${i + 1}. ${String(u).slice(0, 200)}`).join('\n'));
  }
  // ★ C4：在独立 worktree 里开发时要说清楚「就在当前目录改、别切分支、别 push」——
  //   不说的话模型很可能自己 checkout/push，把隔离层绕过去。
  const worktreeNote = worktreePromptNote(childTaskRun?.worktree);
  if (worktreeNote) lines.push(worktreeNote);
  // ★ 独立复核未通过：把缺陷清单原文贴进来，下一轮才能精准修而不是重做。
  const rework = criticFeedbackBlock(childTaskRun);
  if (rework) lines.push(rework);
  lines.push('做完把结果交回给负责人；不要改上级目标。');
  if (autonomous) lines.push(AUTONOMY_RULE);
  return lines.join('\n');
}

/** 交付摘要：确定性文本，不调用模型。 */
export function buildDeliverySummary(taskRun) {
  const goal = taskRun?.goal ?? {};
  const evidence = (taskRun.progress?.evidence ?? []).map((e) => e.ref).filter(Boolean);
  const lines = [`任务「${goal.requirement ?? taskRun?.id}」已验收通过。`];
  if (evidence.length) lines.push(`交付物：${evidence.slice(0, 10).join('、')}`);
  if (taskRun?.owner?.departmentId) lines.push(`交付部门：${taskRun.owner.departmentId}`);
  return lines.join('\n');
}
