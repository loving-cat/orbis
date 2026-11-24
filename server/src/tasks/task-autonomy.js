/**
 * 任务自主推进标记：接单后是「一直干到有结果」，还是「每到关口先问我」。
 *
 * ## 为什么需要它
 *
 * 多 Agent 系统最常见的挫败感是：用户把一件事交出去，
 * 团队干到一半停下来问「要不要继续？」—— 用户还得再回一句，
 * 一件事变成十次对话；长任务更是一夜醒来发现它停在第二步等确认。
 *
 * 自主推进的任务会：
 *   · 不再因为「需要用户确认是否继续」而停下；
 *   · 验收不通过时自己补做再交，而不是等用户回话；
 *   · 只有真正做不下去（缺外部信息/需要账号/不可逆操作）才停下来问。
 *
 * ## 判定原则（长任务改造后）
 *
 * **默认自主**：用户把活交出来，本来期望的就是「做完为止」。
 * 用户明确说了「先问我 / 每一步都报给我 / 等我确认再动手」才改成逐步确认。
 * 不可逆、花钱、对外发布这几类动作另有审批/确认闸门兜底，不靠这个开关。
 *
 * 想退回旧行为（只有明确授权才自主）：`ORBIS_TASK_AUTONOMY=0`。
 */
import { readBrandEnv } from '../brand.js';

/** 明确表示「自己搞定、别问我」的说法。 */
const AUTONOMY_PATTERNS = [
  /一直\s*(?:干|做|跑|推)?\s*(?:到|出)\s*(?:有)?\s*(?:结果|完成|做完)/,
  /(?:做|干|跑)\s*到\s*(?:有)?\s*(?:结果|完|完成)/,
  /不用\s*(?:再\s*)?问\s*我/,
  /不要\s*(?:再\s*)?问\s*我/,
  /别\s*(?:再\s*)?问\s*我/,
  /自己\s*(?:给|拿|出)\s*(?:个)?\s*(?:结果|结论|方案)/,
  /你们\s*(?:自己)?\s*(?:决定|判断|搞定|看着办)/,
  /直到\s*(?:做完|完成|出结果)/,
  /(?:全权|自行)\s*(?:处理|推进)/,
  /不需要\s*(?:我)?\s*(?:确认|批准|点头)/,
];

/**
 * 反过来：明确要求「先问我」的说法，优先级更高。
 *
 * ★ 「跟我 / 和我」必须后接沟通类动词才算。
 *   以前 `(先|要)(问|跟|和)我` 会把「要和我的代码风格一致」也当成「先问我」——
 *   默认自主以后，这种误判会让任务无端退回逐步确认。
 */
const ASK_FIRST_PATTERNS = [
  /先\s*问\s*(?:一下|一声)?\s*我/,
  /(?:要|得|需要)\s*问\s*(?:过)?\s*我/,
  /(?:先|要|得)\s*(?:跟|和)\s*我\s*(?:确认|商量|说一?声|讲一?下|汇报|同步|报告|沟通|对一?下)/,
  /(?:等|等?待)\s*我\s*(?:确认|批准|点头|同意)/,
  /不要\s*(?:自己|擅自)\s*(?:决定|动手)/,
  /(?:每|逐)\s*(?:一)?步\s*(?:都)?\s*(?:要|先)?\s*(?:报|问|确认)/,
  /先\s*(?:给|让)\s*我\s*(?:看|确认|过目|审)/,
  /(?:确认|同意|批准)\s*(?:之?后|了)\s*再\s*(?:做|动手|执行|开始|改)/,
];

/**
 * 从一段用户输入里识别**明确的**说法（不含默认值）。
 *
 * @param {string} text
 * @returns {{autonomous:boolean, reason:string}} reason 为空表示两种说法都没出现
 */
export function detectAutonomy(text) {
  const body = String(text ?? '');
  if (!body.trim()) return { autonomous: false, reason: '' };
  // 明确要求逐步汇报/先问，优先于自主授权
  for (const re of ASK_FIRST_PATTERNS) {
    if (re.test(body)) return { autonomous: false, reason: '用户要求先确认：' + (body.match(re)?.[0] ?? '') };
  }
  for (const re of AUTONOMY_PATTERNS) {
    const hit = body.match(re);
    if (hit) return { autonomous: true, reason: '用户授权自主推进：' + hit[0] };
  }
  return { autonomous: false, reason: '' };
}

/** 环境开关：默认自主；`ORBIS_TASK_AUTONOMY=0/false/off` 退回「只有明确授权才自主」。 */
export function autonomyByDefault(env = process.env) {
  const raw = readBrandEnv(env, 'TASK_AUTONOMY');
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * 新任务最终用哪种推进方式。
 *
 * 顺序：明确「先问我」→ 逐步确认；明确「做完为止」→ 自主；都没说 → 默认（自主）。
 *
 * @param {string} text 用户原话
 * @param {object} [opts]
 * @param {boolean} [opts.defaultAutonomous] 不传则读环境开关
 * @returns {{autonomous:boolean, reason:string}}
 */
export function resolveAutonomy(text, { defaultAutonomous = autonomyByDefault() } = {}) {
  const explicit = detectAutonomy(text);
  if (explicit.reason) return explicit;
  return defaultAutonomous
    ? { autonomous: true, reason: '默认自主推进（没有要求先确认）' }
    : { autonomous: false, reason: '' };
}

export { AUTONOMY_PATTERNS, ASK_FIRST_PATTERNS };
