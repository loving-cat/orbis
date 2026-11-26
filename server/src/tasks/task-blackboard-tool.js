/**
 * 共享黑板工具：负责人与成员都能把「决定 / 约束 / 事实」写进根任务的同一块黑板。
 *
 * ## 为什么是工具而不是自动摘要
 *
 * 系统能自动落的只有**交付事实**（谁交了什么东西、在哪个路径）—— 那是确定性的。
 * 但真正决定后续做法对不对的往往是另外几件事：
 *   · 「金额一律用 addMoney，不许浮点相加」（约束）
 *   · 「先交首批 100 条，剩下的按批次」（决定）
 *   · 「对方数据里那列日期是 UTC」（事实）
 * 这些只有当事人知道，所以给一个显式入口，一次写清、全组自动看到。
 *
 * ## 边界（防越权串写）
 *
 * 写入的根任务来自 `readManagedSubmission`（当前受管执行的真实归属），
 * **不接受调用方指定任务 id**：成员在部门 A 的任务里写不进部门 B 的黑板。
 * 条数与字数上限在 `task-blackboard.js`（纯逻辑），这里不重复。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readManagedSubmission, SUBMISSION } from '../coordination/task-context.js';
import { appendEntry, renderBlackboard, BLACKBOARD_KINDS, BLACKBOARD_LIMITS } from './task-blackboard.js';

const error = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 构造「记到共享黑板」工具。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store 应用 store
 * @param {string} p.roomId
 * @param {string} p.botId
 */
export function buildBlackboardTool({ runner, store, roomId, botId }) {
  const taskRuns = store.taskRuns;
  return defineTool({
    name: 'task_blackboard',
    label: '记到共享黑板',
    description:
      '把一条**对整件事都有用**的决定、约束或事实记到大家共用的黑板上（跨成员、跨轮次都在）。' +
      '例：口径与规范（约束）、已定下的取舍（决定）、关键数据事实（事实）、重要文件位置（引用）。' +
      `最多保留 ${BLACKBOARD_LIMITS.maxEntries} 条（超过先淘汰最旧的普通条目），单条 ≤ ${BLACKBOARD_LIMITS.maxTextChars} 字。` +
      '写一次，后面所有成员开工时都会自动看到；不要把只跟自己这一份活有关的细节写进来。',
    parameters: Type.Object({
      kind: Type.Union(
        BLACKBOARD_KINDS.map((k) => Type.Literal(k)),
        { description: '约束=不许怎么做；决定=已经定下来的取舍；事实=客观情况；引用=重要文件/链接' },
      ),
      text: Type.String({ description: `一句话写清（≤${BLACKBOARD_LIMITS.maxTextChars} 字）` }),
      ref: Type.Optional(
        Type.String({ description: `相关文件路径 / 章节 / 链接（≤${BLACKBOARD_LIMITS.maxRefChars} 字）` }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const submission = readManagedSubmission({ runner, taskRuns, roomId, botId });
      if (submission.kind === SUBMISSION.invalid) {
        return error(`现在不能写黑板：${submission.text}`);
      }
      if (submission.kind !== SUBMISSION.managed) {
        return error('当前没有受管任务，不能写共享黑板。');
      }
      // ★ 只按受管上下文里的根任务写 —— 调用方不能指定目标，越权串写在结构上就不成立。
      const rootId = submission.rootTaskId ?? submission.taskRunId;
      if (!rootId) return error('找不到这件事的根任务，不能写黑板。');
      const loaded = taskRuns.read(rootId);
      const root = loaded?.status === 'found' ? loaded.taskRun : null;
      if (!root) return error('根任务不存在，不能写黑板。');

      const entry = {
        kind: String(params?.kind ?? 'fact'),
        text: String(params?.text ?? ''),
        ref: String(params?.ref ?? ''),
        authorBotId: botId,
        authorName: String(store.getBot?.(botId)?.name ?? ''),
        taskRunId: submission.taskRunId ?? null,
        at: Date.now(),
      };
      let result = null;
      const out = await taskRuns.mutate(rootId, {
        mutate: (cur) => {
          if (!cur) return null;
          const next = appendEntry(cur.blackboard, entry, { now: entry.at });
          result = next;
          if (!next.added) return null;
          return { ...cur, blackboard: next.blackboard, updatedAt: entry.at };
        },
      });
      if (!out?.ok) return error(`黑板没写进去：${out?.text ?? out?.code ?? '未知原因'}`);
      if (result?.duplicate) {
        return {
          content: [{ type: 'text', text: '黑板里已经有同样的一条了，没有重复写入。' }],
          details: { duplicate: true, entry: result.entry },
        };
      }
      const board = renderBlackboard(result?.blackboard ?? root.blackboard);
      return {
        content: [{
          type: 'text',
          text: `已记到共享黑板（全组可见）：\n${board}`,
        }],
        details: { entry: result?.entry ?? null, evicted: result?.evicted ?? [] },
      };
    },
  });
}
