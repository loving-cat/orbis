/**
 * 任务阶段提示词与交付摘要（纯文本，无 IO）。
 *
 * 负责人分三个阶段：规划派活、验收补派、最终交付。提示词只说阶段职责、
 * 目标与已有成果，不泄露内部实现细节；交付摘要用确定性文本，不调用模型。
 */
export const LEAD_PHASE = Object.freeze({
  plan: 'plan',
  verify: 'verify',
  deliver: 'deliver',
});

/**
 * 负责人阶段提示词。
 *
 * @param {object} p
 * @param {string} p.phase 见 LEAD_PHASE
 * @param {object} p.taskRun
 * @param {string} [p.extra]
 * @returns {string}
 */
export function buildLeadPrompt({ phase, taskRun, extra = '' } = {}) {
  const goal = taskRun?.goal ?? {};
  // 私聊 direct：主控亲自干，没有部门、没有成员可派
  const solo = taskRun?.owner?.roomKind === 'dm';
  const lines = [
    `任务目标：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
    (taskRun?.inputs ?? []).length ? '用户补充：' + taskRun.inputs.slice(-3).map((x) => String(x.text ?? '')).filter(Boolean).join('；') : '',
    // 已有计划：每轮都读一遍，按它对齐全场，而不是每轮重新想。
    (taskRun?.plan?.steps ?? []).length
      ? '已经定下的分工（按这个执行，缺哪条补哪条）：\n'
        + taskRun.plan.steps
          .map((s, i) => (i + 1) + '. ' + (s.memberName ?? '') + '：' + (s.task ?? ''))
          .join('\n')
      : '',
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
 * @param {object} p
 * @param {object} p.childTaskRun
 * @param {object} [p.parentTaskRun]
 * @returns {string}
 */
export function buildMemberPrompt({ childTaskRun, parentTaskRun, autonomous = false } = {}) {
  const goal = childTaskRun?.goal ?? {};
  const lines = [
    `你被分配的子任务：${goal.requirement ?? ''}`,
    goal.scope ? `范围：${goal.scope}` : '',
    (goal.deliverables ?? []).length ? `交付物：${goal.deliverables.join('、')}` : '',
  ].filter(Boolean);
  if (parentTaskRun?.goal?.requirement) {
    lines.push(`所属目标：${parentTaskRun.goal.requirement}`);
  }
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
