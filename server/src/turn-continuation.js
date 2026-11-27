/**
 * 回合收尾判定（纯函数，无 IO）：这一轮是「真的做完 / 真的需要用户」，
 * 还是「半路停下来问一句、等人点头」。
 *
 * ## 为什么需要它
 *
 * 模型（尤其是一些国产模型）有个很顽固的习惯：干到一半用一句
 * 「需要我继续吗？」「接下来我会修改 X。」收尾，然后这一轮就结束了。
 * 用户不在旁边盯着，长任务就停在那里 —— 这是「长任务总是停下来问用户」的主因之一。
 *
 * 光靠提示词压不住（提示词里早就写了「不要问要不要继续」）。所以在回合收尾处
 * 加一道**续跑守卫**（相当于 Claude Code 的 Stop hook）：判定这是「半路停下来问」，
 * 就在同一个会话里追加一句「继续执行」，有上限。
 *
 * ## 边界（宁可少催，不能乱催）
 *
 *   · 只对「干活的回合」生效：受管任务，或者这一轮动过工具。纯聊天的提问原样留着；
 *   · 用户明确要求「先问我 / 等我确认 / 先别动」→ 守卫关闭；
 *   · 「做完了，要不要顺便再做点别的？」这种**附加提议**：正文里已经说做完了就不催
 *     （否则会去做用户没要的事）；
 *   · 被催了以后**仍然只回文字、没动任何工具** → 说明它真的需要用户，不再催；
 *   · 不可逆操作、要账号密码这类事，催促文案里明确允许它停下来说明。
 *
 * ## 时间片续段
 *
 * 单轮执行到点（软截止）时，执行器会请模型收尾并写进度。非受管会话（私聊/群聊）
 * 没有推进器帮它续跑，所以约定一个标记 `CONTINUE_MARKER`：还没做完就在最后写它，
 * 执行器看到就自动接着跑下一段（有上限）。受管任务由推进器按「让出」续跑，不需要标记。
 */
import { ASK_FIRST_PATTERNS } from './tasks/task-autonomy.js';

/** 「还没做完，下一段接着做」的标记（只在收尾通知后才认）。 */
export const CONTINUE_MARKER = '【未完待续】';

/** 自动续段时追加在气泡里的说明（给用户看：不是卡住了，是接着做）。 */
export const CONTINUE_NOTE = '_（这一段时间用完了，接着做下一段…）_';

/** 续跑守卫催促时追加在气泡里的说明。 */
export const NUDGE_NOTE = '_（自动继续：不用等确认）_';

/** 「要不要继续 / 下一步要不要做」——明确是在问能不能接着干。 */
const CONTINUE_PERMISSION = [
  /要不要(?:我)?(?:继续|接着|开始|动手|执行|往下|进行|做下一|把剩下|处理剩下)/,
  /需不需要(?:我)?(?:继续|接着|往下)/,
  /是否(?:需要)?(?:继续|接着|开始|执行|进行下一|往下)/,
  /(?:可以|能|要|需要)(?:我)?(?:继续|接着|开始|往下)(?:做|干|执行|进行|处理)?[^。！？\n]{0,24}[吗嘛么][？?]?/,
  /需要我(?:继续|接着|往下|开始)[^。！？\n]{0,30}[吗嘛么]/,
  /(?:你|您)(?:看|觉得)?(?:要|需要|想)(?:我)?(?:继续|接着|往下)/,
  /(?:等|等待)(?:你|您)的?(?:确认|回复|指示|决定|反馈|答复|批准)/,
  /(?:确认|同意|批准)(?:后|之后|以后)我(?:再|就|会|马上)/,
  /如果(?:你|您)(?:同意|确认|没问题|觉得可以|觉得没问题|ok|OK)[，,]?\s*(?:我|就)/,
  /请(?:你|您)?(?:确认|告诉我|决定|指示)[^。\n]{0,24}(?:是否|要不要|继续|下一步)/,
  /\b(?:shall|should) i (?:proceed|continue|go ahead|start)\b/i,
  /\bwant me to (?:continue|proceed|go ahead|keep going)\b/i,
];

/** 「需要我顺便……吗」——附加提议。做完了才问的话不该催（会做用户没要的事）。 */
const OFFER = [
  /需要我[^。！？\n]{1,40}[吗嘛么]/,
  /要(?:不要)?我(?:再|顺便|帮你|帮您)[^。！？\n]{0,40}[吗嘛么]?/,
  /(?:还|再)?需要(?:我)?(?:做|帮|整理|生成|导出|补充)[^。！？\n]{0,30}[吗嘛么]/,
  /\b(?:do|would) you (?:want|like) me to\b/i,
  /\blet me know if you(?:'d| would)? like\b/i,
];

/** 正文里明确说「做完了」。 */
const COMPLETED = [
  /(?:已经|已|都)(?:全部)?(?:完成|做完|改好|搞定|处理完|修好|交付)/,
  /(?:全部|都|整体)(?:完成|做完|搞定)了/,
  /完成了[。！!]/,
  /\b(?:all )?done\b/i,
  /✅\s*(?:完成|done)/i,
];

/** 只报了计划、没动手：结尾是「接下来我会……」「我现在开始……」。 */
const PLAN_ONLY_TAIL = [
  /(?:接下来|下一步|然后|随后|稍后)[，,]?\s*(?:我)?(?:会|将|要|准备|打算|就|马上|这就)[^。！？\n]{0,60}[。.!！]?\s*$/,
  /我(?:现在|马上|这就|立即|立刻|接着|先)(?:就)?(?:开始|去|来|动手|着手)[^。！？\n]{0,60}[。.!！…]?\s*$/,
  /\b(?:next|now),? i(?:'ll| will| am going to)\b[^.!?\n]{0,80}[.!]?\s*$/i,
];

/**
 * 结尾明确说明「因为不可逆 / 高风险而停下」。
 *
 * ★ 必须和 `nudgePrompt` 自己的规则对齐：那边写着「只有遇到不可逆的操作（删数据、
 *   对外发布、花钱）才停下来说明原因」，这边却把「删数据不可逆，我不擅自动手，
 *   等你确认」当成"半途停下来问"去催 —— 自相矛盾，真机上就是因此让一个只查资料的
 *   Bot 突然开始写代码、补测试。
 */
const IRREVERSIBLE_STOP = [
  /不可逆/,
  /删(?:除|掉)?数据/,
  /不擅自动手/,
  /高风险/,
  /需要(?:你|您)(?:授权|拍板|确认再)/,
];

/** 结尾在「等你确认后我再派活 / 再动手」—— 只是提议，不是干到一半撂挑子。 */
const DEFER_TO_USER = [
  /(?:你|您)(?:确认|同意|拍板)[^。！？]{0,12}(?:再|才|之后|以后|后)(?:派|动手|执行|开始|安排|处理)/,
  /再派给/,
  /待(?:你|您)(?:确认|同意)(?:后|之后)/,
];

/** 纯提问 / 概念解释的句式（结尾）。 */
const QUESTION_TAIL = /(?:是什么|什么意思|啥意思|为什么|为啥|怎么回事|区别是什么|有啥用)[？?\s]*$/;
/** 句首就是疑问词（「为什么会超时」这种不带问号的也算纯提问）。 */
const QUESTION_START = /^(?:为什么|为啥|是什么|什么意思|啥意思|怎么回事|区别是什么|有啥用|有什么(?:用|区别))/;
/** 明确的「动手」动词：出现任何一个就说明用户不只是问问。 */
const ACTION_WORDS = /修|改|写|做|加|删|清|跑|建|实现|优化|帮我/;

/**
 * 用户原话只是提问 / 要解释，还是明确让干活？
 *
 * ★ 为什么需要：非受管会话里 `workTurn: true`（它查过资料）就足以让守卫催它「继续执行」。
 *   用户问「孤儿房间文件是什么？」，Bot 查完文件给了完整解释、顺口提了句「要不要顺手
 *   清理，等你确认」—— 守卫把后半句当"停下来问"，逼它自己动手改代码补测试。
 *
 * @param {string} userText 用户这一轮的原话
 * @returns {boolean}
 */
export function isPureQuestion(userText) {
  const text = String(userText ?? '').trim();
  if (!text) return false;
  if (QUESTION_TAIL.test(text)) return true;
  // 「为什么会超时」没写问号也算提问；但同一句里出现「帮我改」就不算
  if (QUESTION_START.test(text) && !ACTION_WORDS.test(text)) return true;
  return /[？?]\s*$/.test(text) && !ACTION_WORDS.test(text);
}

/** 用户明确要先确认、或者叫它先停一下。 */
const HOLD = [
  /先别(?:动|做|改|跑|继续)/,
  /先(?:停|等)(?:一下|一等|下|等)?/,
  /等我(?:确认|看看|看一下|回来|消息|通知)/,
  // ★ 裸的 `/暂停/` 会误命中业务描述（「基金暂停申购」「服务已暂停」「这个功能暂停了」），
  //   结果是续跑守卫被一句不相干的话关掉，活就停在半路没人催。
  //   收紧成「对着它说的指令句」：暂停必须出现在句首（或紧跟 先/请/麻烦），
  //   后面只能是语气词 / 明确的「推进、执行、动手、任务」，再跟标点或结尾。
  /(?:^|[\s，,。！!；;、])(?:先|请|麻烦|你)?\s*暂停(?:\s*(?:一下|下|一会|会儿|一等|推进|执行|动手|任务|吧|啦|啊))?\s*(?:[，,。！!；;、]|$)/,
];

/**
 * 用户是不是要求了「先问我 / 先停」（命中则续跑守卫关闭）。
 *
 * @param {...string} texts 用户原话、插话
 * @returns {boolean}
 */
export function wantsAskFirst(...texts) {
  const body = texts.flat().map((t) => String(t ?? '')).join('\n');
  if (!body.trim()) return false;
  return ASK_FIRST_PATTERNS.some((re) => re.test(body)) || HOLD.some((re) => re.test(body));
}

/**
 * 判定这一轮的收尾属于哪一类。
 *
 * @param {string} text 这一轮最后一条回复的正文
 * @returns {{kind:'continue_permission'|'plan_only'|'offer'|'question'|'none', hit:string}}
 */
export function classifyTurnEnding(text) {
  const body = String(text ?? '').trim();
  if (!body) return { kind: 'none', hit: '' };
  // 只看结尾一段：前文里引用的「要不要继续」（比如复述用户的话）不算
  const tail = body.slice(-320);
  for (const re of CONTINUE_PERMISSION) {
    const m = tail.match(re);
    if (m) return { kind: 'continue_permission', hit: m[0] };
  }
  for (const re of PLAN_ONLY_TAIL) {
    const m = tail.match(re);
    if (m) return { kind: 'plan_only', hit: m[0] };
  }
  for (const re of OFFER) {
    const m = tail.match(re);
    if (m) return { kind: 'offer', hit: m[0] };
  }
  if (/[？?]\s*[）)」』"']?\s*$/.test(tail.slice(-60))) return { kind: 'question', hit: tail.slice(-40) };
  return { kind: 'none', hit: '' };
}

/** 正文里是否说了「做完了」。 */
export function claimsCompleted(text) {
  const body = String(text ?? '');
  return COMPLETED.some((re) => re.test(body));
}

/**
 * 该不该在这一轮收尾时催它继续。
 *
 * @param {object} p
 * @param {string} p.text 最后一条回复正文
 * @param {string} [p.userPrompt] 用户这一轮的原话（判「纯提问」用）
 * @param {boolean} p.managed 受管任务执行（有任务账本）
 * @param {boolean} p.workTurn 这一轮动过工具（在干活，而不是聊天）
 * @param {boolean} [p.completed] 已申请完成（受管 apply_completion）
 * @param {boolean} [p.waiting] 已登记合法等待（审批/输入/依赖/弹了询问卡片）
 * @param {boolean} [p.askFirst] 用户要求先确认
 * @param {number} [p.nudges] 这一轮已经催过几次
 * @param {number} [p.max] 最多催几次
 * @param {boolean} [p.actedSinceNudge] 上次催促后它有没有真的动手（调过工具）
 * @returns {{nudge:boolean, kind:string, why:string}}
 */
export function shouldNudge({
  text = '', userPrompt = '', managed = false, workTurn = false, completed = false, waiting = false,
  askFirst = false, nudges = 0, max = 2, actedSinceNudge = true,
} = {}) {
  const no = (why, kind = 'none') => ({ nudge: false, kind, why });
  if (completed) return no('已申请完成');
  if (waiting) return no('在等合法的外部条件');
  if (askFirst) return no('用户要求先确认');
  if (nudges >= Math.max(0, Number(max) || 0)) return no('催促次数已用完');
  if (nudges > 0 && !actedSinceNudge) return no('催了以后仍只回文字：它是真的需要用户');
  if (!managed && !workTurn) return no('纯聊天回合：提问原样留着');

  // ★ 结尾自己说了「不可逆 / 高风险 / 等你授权」：它就是该停在这儿（与 nudgePrompt 对齐）
  const tail = String(text ?? '').slice(-160);
  if (IRREVERSIBLE_STOP.some((re) => re.test(tail))) {
    return no('结尾说明是不可逆/高风险，等用户确认', 'irreversible');
  }
  if (!managed) {
    // ★ 用户只是在问「是什么 / 为什么」：查完资料给出解释就是完成，不许硬逼它动手
    if (isPureQuestion(userPrompt)) return no('用户原话是提问，不该被催成动手', 'pure_question');
    // ★ 只是提议「你确认后我再派给某某」：没有未完成的执行动作，不催
    if (DEFER_TO_USER.some((re) => re.test(tail))) {
      return no('结尾在等用户确认后再派活/动手', 'defer_to_user');
    }
  }

  const ending = classifyTurnEnding(text);
  if (ending.kind === 'continue_permission' || ending.kind === 'plan_only') {
    return { nudge: true, kind: ending.kind, why: ending.hit };
  }
  if (ending.kind === 'offer' || ending.kind === 'question') {
    // 做完了才问「要不要顺便……」：不催，免得去做用户没要的事
    if (claimsCompleted(text) && !managed) return no('做完后的附加提议', ending.kind);
    return { nudge: true, kind: ending.kind, why: ending.hit };
  }
  // 受管任务：没申请完成、没登记等待就收手了 —— 催一次「做完就交付，没做完就继续」
  if (managed) return { nudge: true, kind: 'managed_unfinished', why: '没有申请完成也没有登记等待' };
  return no('正常收尾');
}

/**
 * 催促文案。
 *
 * @param {string} kind shouldNudge 给出的类别
 * @param {{managed?:boolean}} [opts]
 */
export function nudgePrompt(kind, { managed = false } = {}) {
  const head = kind === 'plan_only'
    ? '【系统】你刚才说了接下来要做什么，但还没动手 —— 现在就去做，不用等确认。'
    : '【系统】继续执行，不要停下来问「要不要继续」。';
  const lines = [
    head,
    '拿不准的地方按最合理的做法推进，把你做的假设记下来、在最后的汇报里列出来（用户随时可以插话纠正）。',
    '只有遇到不可逆的操作（删数据、对外发布、花钱）、或者需要只有用户才能给的东西（账号密码、授权、原始数据）时，才停下来说明原因。',
  ];
  if (kind === 'offer' || kind === 'question') {
    lines.push('如果原来交代的事其实已经全部做完，就直接给出最终结果，不要追加用户没要求的事。');
  }
  if (managed) {
    lines.push('如果这件事已经全部做完，用 task_report 报 apply_completion 交付（evidence 写清交付的文件）；还没做完就接着做。');
  }
  return lines.join('\n');
}

/**
 * 软截止时的收尾通知（steer 进去，在当前工具跑完、下一次调模型之前送达）。
 *
 * @param {{managed?:boolean, reason?:'time'|'steps', canContinue?:boolean}} [opts]
 *   canContinue=false：这个会话不会自动续段（例如 SDK 默认），就不教它写续段标记
 */
export function wrapUpPrompt({ managed = false, reason = 'time', canContinue = true } = {}) {
  const head = reason === 'steps'
    ? '【系统·分段】这一段的步数快用完了。'
    : '【系统·分段】这一段的执行时间快用完了。';
  if (managed) {
    return [
      head + '系统会自动接着排下一段，不会中断任务，也不需要问用户。',
      '请：① 把手上正在做的这一步收个尾（不要再开新的大步骤）；',
      '② 用 task_report 报 progress：done 写已经完成的，unmet 写还剩什么，note 写下一段从哪继续；',
      '③ 用一两句话说明进度。',
      '如果其实已经全部做完，就照常用 task_report 报 apply_completion 交付。',
    ].join('\n');
  }
  if (!canContinue) {
    return head + '请把手上正在做的这一步收个尾（不要再开新的大步骤），'
      + '然后用几句话写清：已经完成了什么、还剩什么没做。';
  }
  return [
    head + '请把手上正在做的这一步收个尾（不要再开新的大步骤），然后用几句话写清：已经完成了什么、下一段从哪继续。',
    `如果整件事还没做完，最后单独一行写「${CONTINUE_MARKER}」—— 系统会自动让你接着做下一段，不需要问用户。`,
    '如果已经全部做完，就直接给最终结果，不要写这个标记。',
  ].join('\n');
}

/**
 * 非受管会话自动续段时发给模型的话。
 *
 * @param {{n?:number, max?:number}} [opts] 第几段 / 最多几段
 */
export function continuationPrompt({ n = 1, max = 0 } = {}) {
  return [
    `【系统·续段${max ? ` ${n}/${max}` : ''}】接着上一段继续做。`,
    '你的会话记录里有上一段的完整过程：先花一两步核对现状（文件、进程、做到哪了），然后从断点继续；',
    '不要从头再来，也不要重复已经做完的步骤（尤其是会产生副作用的操作）。',
    `还没做完、这一段又到点了，就照旧在最后单独一行写「${CONTINUE_MARKER}」；做完了就直接给最终结果。`,
  ].join('\n');
}

/**
 * 从收尾正文里取出续段标记。
 *
 * @param {string} text
 * @returns {{wanted:boolean, text:string}} text 已去掉标记
 */
export function extractContinuation(text) {
  const body = String(text ?? '');
  if (!body.includes(CONTINUE_MARKER)) return { wanted: false, text: body };
  const cleaned = body.split(CONTINUE_MARKER).join('').replace(/\n{3,}/g, '\n\n').trim();
  return { wanted: true, text: cleaned };
}
