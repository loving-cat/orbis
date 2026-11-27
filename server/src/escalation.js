import { pickEscalationHost as pickHost } from './util.js';
import { isDelegatingLead } from './role-tools.js';
/**
 * 出事了往上抬：把"这单断了"告诉该知道的人，并请它重新安排。
 *
 * "该谁知晓"的规则在 util.js
 * （pickEscalationHost：部门里的活先找组长，没有组长就找主控）；
 * 这里负责**怎么抬**：在哪儿说、说什么、怎么把对方叫醒。
 *
 * 叫醒这一步不能省：只往群里留一条消息，对方是不会自己动起来的 ——
 * 用户看到的就是"报了个回执，然后没下文"。
 *
 * @param {object} deps
 * @param {object} deps.store
 * @param {(roomId:string, botId:string, text:string, opts:object)=>Promise<any>} deps.run
 *        叫醒对方用的执行器（就是 runner.run）
 * @param {(msg:string, err:any)=>void} [deps.onError]
 */
export function createEscalator({ store, run, onError = () => {} }) {
  return async function escalate({
    roomId,
    fromBotId,
    reason,
    task = '',
    attempts = 0,
    why = '',
    prefer = 'lead',
  }) {
    const room = store.getRoom(roomId);
    const chief = store.mainBot();
    const target = pickHost({
      roomKind: room?.kind,
      leadBotId: room?.leadBotId ?? null,
      fromBotId,
      chiefId: chief?.id ?? null,
      prefer,
    });
    if (!target.hostId) return null;

    const host = store.getBot(target.hostId);
    if (!host) return null;
    // 组长：就在群里说（用户也看得见"这单断了"）；主控：在它的私聊里说
    const inRoom = target.role === 'lead' ? roomId : (store.ensureDm(host.id)?.id ?? null);
    if (!inRoom) return null;

    const note = buildEscalationNote({
      store, fromBotId, reason, task, attempts, why,
      delegateOnly: isDelegatingLead(store.getRoom(inRoom), host),
    });
    // ★ 两条文案必须分开（真机）：以前同一份 `note` 既写进用户能看见的房间消息，
    //   又当 prompt 喂给模型 —— 于是写给 Bot 的内部指令（600 字原任务、处理步骤、
    //   「不要悄悄把活接下…」）原样弹在聊天窗口里。人只看“谁断了 / 为什么 / 谁接”。
    const summary = buildEscalationSummary({ store, fromBotId, hostName: host.name, reason });
    store.appendMessage({
      roomId: inRoom,
      authorType: 'system',
      authorId: host.id,
      authorName: '中断回执',
      text: summary,
      status: 'done',
      meta: { via: 'escalate', aboutBotId: fromBotId },
    });

    // 光留一条消息它不会自己动 —— 顺手叫醒它，让它当场重新安排
    run(inRoom, host.id, `【系统】${note}`, {
      skipUserMessage: true,
      timeoutMs: 300_000,
    }).catch((err) => onError('叫醒失败', err));

    return { hostId: host.id, roomId: inRoom };
  };
}

/** 构造失败回执文本；delegateOnly 时第三步改为向用户说明阻塞并等待决定。 */
export function buildEscalationNote({ store, fromBotId, reason, task = '', attempts = 0, why = '', delegateOnly = false }) {
  const from = store?.getBot?.(fromBotId);
  const name = from?.name ?? fromBotId;
  const lines = [`[这单断了] ${name}：${reason}`];
  if (attempts) lines.push(`（试了 ${attempts} 次${why ? `，${why}` : ''}）`);
  if (task) lines.push('', `原任务：${String(task).slice(0, 600)}`);
  lines.push(
    '',
    '请按这个顺序处理：',
    `1. 先 @ ${name} 再派一次，把要求说得更具体（做什么 / 交什么 / 怎么算完成）。`,
    '2. 还不行就 @ 另一个同事接手，并说明是谁没完成。',
    // ★ 两种角色都是“自己上”，差别只在**要不要先问用户**：
    //   部门负责人有人可派，所以先派；实在没人能接时自己接，并说明原因。
    //   主控没有人可派（它自己就是最后一环），所以直接接。
    //
    //   原来负责人的分支写的是“等待用户决定，不自行执行”—— 实测后果是：
    //   部门里唯一能干活的成员挂了，这活就永远停在那里等用户，而用户
    //   根本不知道发生了什么。产品的目标是帮人推进任务，不是把人变成审批员。
    delegateOnly
      ? '3. 没有成员能接时，**你自己上** —— 但要在群里说明「因为 X 没完成，这活我接手了」，'
        + '并在交付时把原本该它做的那部分标出来。'
      : '3. 实在没人能接，你自己上 —— 但**必须在群里说明你接手了、因为谁没完成**。',
    '★ 不要悄悄把活接下：用户会以为全员都交付了，掉链子的事故就被掩盖了。',
  );
  return lines.join('\n');
}

/**
 * 构造**给人看**的中断回执（一行）。
 *
 * ★ 为什么必须和 `buildEscalationNote` 拆开：那份 note 是写给主控/负责人看的内部指令
 *   （原任务全文、1/2/3 处理步骤、「不要悄悄把活接下」），以前它同时被当成房间消息
 *   写进用户能看见的群/私聊 —— 用户会直接看到一整段写给 Bot 的提示词，
 *   看上去像系统故障，也看不出“现在到底谁在处理”。
 *
 *   人只需要三个事实：谁的活断了、为什么断（压成一行短原因）、现在转给谁。
 *   具体怎么重派是给模型看的，不进正文。
 *
 * @param {object} p
 * @param {object} p.store
 * @param {string} p.fromBotId 活断在谁身上
 * @param {string} [p.hostName] 接手的人
 * @param {string} [p.reason] 中断原因（可含长文本，这里只取一行短摘要）
 * @returns {string} 一行人类可读的状态提示
 */
export function buildEscalationSummary({ store, fromBotId, hostName = '', reason = '' }) {
  const fromName = store?.getBot?.(fromBotId)?.name ?? fromBotId;
  // 压成一行：换行/连续空白折叠，超过 60 字截断 —— 完整原因在模型那边的 note 里
  const flat = String(reason ?? '').replace(/\s+/g, ' ').trim();
  const short = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  const host = String(hostName ?? '').trim();
  return `「${fromName}」的任务中断${short ? `（${short}）` : ''}，已转交${host ? `「${host}」` : '给负责人'}重新处理。`;
}
