/**
 * 纯单测统一入口（不需要起服务端、不需要网络）。
 *   node tests/all.mjs
 *
 * 集成测试（smoke/org/steer/attach）需要先起服务端，单独跑：见 README。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TESTS = [
  'model-config',
  'model-thinking',
  'version',
  'pi-args',
  'console-inherit',
  'closing-turn',
  'transcript-budget',
  'skills',
  'lessons',
  'chief-summary',
  'chief-summary-flow',
  'lessons-sim-lite',
  'lesson-injection',
  'lesson-reflect',
  'lessons-invariants',
  'site-draft',
  'merge-messages',
  'local-capabilities',
  'mcp',
  'mcp-capability',
  'ego-browser',
  'attachment-delete',
  'relay-safety',
  'boot-failure',
  'sites',
  'secrets',
  'retry-policy',
  'retry-transient',
  'update-check',
  'update-checker',
  'session-resources',
  'relay-frames',
  'unit',
  'tasks',
  'task-projection',
  'auth-device-token',
  'credential-target-reuse',
  'task-plan-tool',
  'task-supervisor',
  'task-commands',
  'task-budget',
  'task-reduce',
  'run-managed-attempt',
  'task-controls',
  'task-file-claims',
  'capabilities',
  'exec-mode',
  'reclamation',
  'desktop-lease',
  'desktop-takeover',
  'desktop-input',
  'desktop-input-mac',
  'desktop-tools',
  'overrides',
  'action-catalog',
  'template-grants',
  'grants',
  'desktop-observe',
  'http-admin',
  'git-ops',
  'confirm',
  'git-push-flow',
  'admin-view',
  'security-p0',
  'security-shell',
  'mcp-tool-registry',
  'mcp-attach-keeps-memory',
  'mcp-presets',
  'reply-bot-guard',
  'dm-greeting',
  'session-signature',
  'automations',
  'uploads',
  'approvals',
  'hooks',
  'shell-policy',
  'shell-bypass-regress',
  'policy-hook',
  'readonly-regress',
  'role-tools',
  'shells',
  'child-env-typed',
  'local-nonce',
  'sandbox',
  'sandbox-win',
  'change-watch',
  'artifacts',
  'dm',
  'progress-senders',
  'progress-flow',
  'ask-guard',
  'ask-card',
  'auth',
  'discovery',
  'pair-request',
  'tls',
  'pair-request-http',
  'device-revoke',
  'disk',
  'room-lock',
  'group-cursor',
  'abort-placeholder',
  'data-migration',
  'server-mode',
  'model-health',
  'net-guard',
  'security-regress',
  'relay-openstream',
  'ssrf-regress',
  'secrets-regress',
  'local-csrf',
  'mcp-credential-target',
  'render-html',
  'memory-policy',
  'memory-prompt',
  'memory-sanitize',
  'policy-version',
  'run-slots',
  'compact-retry',
  'decision-router',
  'model-recommend',
  'decision-settings',
  'model-health-forget',
  'circuit-breaker',
  'model-endpoints',
  'model-store-isolation',
  'decision-mode',
  'skills-once',
  'skills-compaction-reset',
  'compact-threshold',
  'context-overhead',
  'onboarding',
  'onboarding-route',
  'desktop-island',
  'desktop-island-win',
  'desktop-island-tools',
  'grant-context',
  'desktop-settings-route',
  'island-login',
  'repo-trust',
  'task-grant-reclaim',
  'repo-lock',
  'grant-request',
  'grant-reconcile',
  'delegated-delivery',
  'preferences',
  'grant-generation',
  'headless-browser',
  'duplex-router',
  'live-work-snapshot',
  'full-duplex',
  'jarvis-mode',
  'sdk-runtime',
  'sdk-errors',
  'sdk-lifecycle',
  'sdk-injection',
  'sdk-examples',
  'sdk-session-format',
  'audit-query',
  'department-preview',
  'migrate-home',
  'pending-migration',
  'config-no-dirs',
  'turn-step-settle',
  'group-round-dispatch',
  'diagnostics-log',
  'group-stream-order',
  'talk-failure-diagnostics',
  'user-dirs',
  'storage-retention',
  'storage-housekeeping',
  'sdk-contract',
  'brand',
  'brand-deprecation',
  'task-title',
  'tasks/legacy-task-migration',
  'opening-reply',
  'pass-marker',
  'model-failure-hint',
  'runner-modular',
  'task-admission',
  'task-request-gate',
  'task-verification',
  'task-run-store',
  'task-intake-e2e',
  // 长任务：分段续跑、续跑守卫、两档停滞、默认自主
  'turn-continuation',
  'long-task-turn',
  'long-task-supervisor',
  'long-task-parallel',
  'long-task-guardrails',
  // 受控子任务 DAG（dependsOn + checkpoint）与根任务共享黑板（2.0 集群 C1）
  'long-task-dag-blackboard',
  // 独立评审 / 质检回路（2.0 集群 C2）
  'long-task-critic',
  // 同角色临时分身 + 任务难度模型分档（2.0 集群 C3）
  'long-task-clone-tier',
  // 并发编码的 Git worktree 隔离与合入（2.0 集群 C4）
  'long-task-worktree',
  // 集群全景投影 + 候选经验通知（2.0 集群 C5）
  'long-task-waterfall-lessons',
  // 长度上限截断止血 + 高水位压缩补盲 + 小窗口技能预算（真机 3b）
  'turn-length-truncation',
  // 技能注入真的接线（复审 P0：skillBudget 未声明导致静默 ReferenceError）
  'skill-injection-live',
  // 熔断按模型隔离：404 一次即熔断 / 同组不连坐 / C2-C3 选模（GA 接入层）
  'model-breaker-scope',
  // 接单假设折叠 / ask_user 默认不阻塞 / 群聊续段
  'task-intake-assumptions',
  'ask-user-default',
  'group-continuation',
  // 上游故障不丢活：分钟级退避续派 / 可恢复阻塞 / 重启审计续跑
  'group-retry',
  'long-task-upstream',
  'long-task-failfast',
  'long-task-restart',
  // 运行统计埋点 + 只读性能报告（SPEC-PERF-V1 M1-b）
  'perf-report',
  // Windows 桌面助手（SPEC-PERF-V1 P1-2 阶段 A）：契约 + 回退
  'desktop-helper-win',
  // 流式期间不重写 state.json（SPEC-PERF-V1 §8 / P2-4）
  'store-state-dirty',
];

let failed = 0;
const rows = [];
for (const name of TESTS) {
  const file = path.join(process.cwd(), 'tests', `${name}.mjs`);
  const res = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const ok = res.status === 0;
  if (!ok) failed++;
  const tail = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  rows.push(`${ok ? '✓' : '✗'} ${name.padEnd(16)} ${tail}`);
  if (!ok) {
    // 把子文件里带 ✗ 的行打出来：CI 日志只留最后一行的话，
    // 根本看不出是哪一个用例红的（排查一次要重跑一轮）。
    const detail = (res.stdout || '')
      .split(/\r?\n/)
      .filter((line) => line.includes('✗') && !line.includes('通过'))
      .slice(0, 5);
    if (detail.length) rows.push(detail.map((line) => `    ${line.trim()}`).join('\n'));
  }
  if (!ok && res.stderr) rows.push(res.stderr.trim().split(/\r?\n/).slice(-3).join('\n'));
}

console.log('\n================ 全部纯单测 ================');
console.log(rows.join('\n'));
console.log(`\n${TESTS.length - failed}/${TESTS.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);