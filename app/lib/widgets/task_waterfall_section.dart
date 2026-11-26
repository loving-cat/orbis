/// 集群全景：Token/费用仪表盘 + 子任务瀑布流 + 共享黑板（C5）。
///
/// 只做展示与回调：数据来自 `GET /api/task-runs/:id` 的 `waterfall / telemetry /
/// blackboard`（由 `TaskRunController.fetchDetail` 拉取），放行走
/// `approveCheckpoint` 控制通道。
///
/// ## 三条刻意的取舍
///
/// 1. **没有单价就不显示价格**：`estimatedCostUsd == null` 时整块价格区不渲染 ——
///    编一个假价格会让用户照着它做决策。
/// 2. **进度条防越界**：所有比例都 clamp 到 `[0,1]`，除零返回 null（服务端
///    也可能给 null），绝不出现宽度为负或超过 100% 的条。
/// 3. **0 条即 0 像素**：没有瀑布流/没有黑板时直接 `SizedBox.shrink()`，
///    不给详情弹窗凭空加高度。
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../task_bot_name.dart';
import '../task_run_models.dart';
import '../scope.dart';
import '../theme.dart';

class TaskWaterfallSection extends StatefulWidget {
  const TaskWaterfallSection({
    super.key,
    required this.task,
    this.onApproveCheckpoint,
  });

  final TaskRun task;

  /// 用户点「放行」：传子任务 id。
  final Future<void> Function(String childTaskRunId)? onApproveCheckpoint;

  @override
  State<TaskWaterfallSection> createState() => _TaskWaterfallSectionState();
}

class _TaskWaterfallSectionState extends State<TaskWaterfallSection> {
  final Set<String> _expanded = <String>{};
  bool _showUsage = false;
  bool _showBlackboard = true;

  @override
  Widget build(BuildContext context) {
    final task = widget.task;
    final waterfall = task.waterfall;
    final telemetry = task.telemetry;
    final blackboard = task.blackboard;
    final hasAny = (waterfall != null && waterfall.items.isNotEmpty) ||
        (telemetry != null && telemetry.totalTokens > 0) ||
        blackboard.isNotEmpty;
    if (!hasAny) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (telemetry != null && telemetry.totalTokens > 0)
          _TelemetryCard(
            telemetry: telemetry,
            showUsage: _showUsage,
            onToggleUsage: () => setState(() => _showUsage = !_showUsage),
          ),
        if (waterfall != null && waterfall.items.isNotEmpty) ...[
          const SizedBox(height: 12),
          _WaterfallList(
            waterfall: waterfall,
            task: task,
            expanded: _expanded,
            onToggle: (id) => setState(() {
              if (!_expanded.add(id)) _expanded.remove(id);
            }),
            onApproveCheckpoint: widget.onApproveCheckpoint,
          ),
        ],
        if (blackboard.isNotEmpty) ...[
          const SizedBox(height: 10),
          _BlackboardCard(
            entries: blackboard,
            open: _showBlackboard,
            onToggle: () => setState(() => _showBlackboard = !_showBlackboard),
          ),
        ],
      ],
    );
  }
}

/// 千分位：`12,345`。
String formatTokens(int value) {
  final text = value.abs().toString();
  final buffer = StringBuffer();
  for (var i = 0; i < text.length; i++) {
    if (i > 0 && (text.length - i) % 3 == 0) buffer.write(',');
    buffer.write(text[i]);
  }
  return (value < 0 ? '-' : '') + buffer.toString();
}

/// 费用：`$0.0123`（超过 1 美元保留两位）。**没有价格时返回 null**。
String? formatCost(double? value) {
  if (value == null || value.isNaN || value.isInfinite) return null;
  if (value >= 1) return '\$${value.toStringAsFixed(2)}';
  if (value <= 0) return '\$0';
  return '\$${value.toStringAsFixed(4)}';
}

/// 毫秒 → `1.2s` / `1分05秒`。
String formatDuration(int? ms) {
  if (ms == null || ms <= 0) return '—';
  if (ms < 1000) return '${ms}ms';
  final seconds = ms / 1000;
  if (seconds < 60) return '${seconds.toStringAsFixed(1)}s';
  final m = (seconds / 60).floor();
  final s = (seconds % 60).round();
  return '$m分${s.toString().padLeft(2, '0')}秒';
}

class _TelemetryCard extends StatelessWidget {
  const _TelemetryCard({
    required this.telemetry,
    required this.showUsage,
    required this.onToggleUsage,
  });

  final TaskRunTelemetry telemetry;
  final bool showUsage;
  final VoidCallback onToggleUsage;

  @override
  Widget build(BuildContext context) {
    final ratio = telemetry.budgetRatio;
    final near = ratio != null && ratio >= 0.85;
    final cost = formatCost(telemetry.estimatedCostUsd);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: PB.borderTertiary.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.gauge, size: 13, color: PB.textTertiary),
              const SizedBox(width: 6),
              Text('Token 与费用',
                  style: TextStyle(fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textSecondary)),
              const Spacer(),
              Text('${formatTokens(telemetry.totalTokens)} tokens',
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    fontWeight: FontWeight.w700,
                    color: near ? PB.warn : PB.textPrimary,
                  )),
            ],
          ),
          const SizedBox(height: 6),
          Text('输入 ${formatTokens(telemetry.inputTokens)} · 输出 ${formatTokens(telemetry.outputTokens)}'
              '${telemetry.criticTokens > 0 ? ' · 其中复核 ${formatTokens(telemetry.criticTokens)}' : ''}',
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
          if (ratio != null) ...[
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: ratio,
                minHeight: 6,
                backgroundColor: PB.borderSecondary,
                valueColor: AlwaysStoppedAnimation<Color>(near ? PB.warn : PB.accent),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '已用 ${formatTokens(telemetry.usedTokens ?? 0)} / ${formatTokens(telemetry.maxTokens ?? 0)}'
              '${(telemetry.remainingTokens ?? 0) <= 0 ? ' · 额度已用尽' : ' · 剩余 ${formatTokens(telemetry.remainingTokens ?? 0)}'}',
              style: TextStyle(fontSize: PB.fsXs, color: near ? PB.warn : PB.textTertiary),
            ),
          ],
          if (cost != null) ...[
            const SizedBox(height: 6),
            Text('估算费用 $cost（按已配置单价）',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
          ],
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              if (telemetry.clonedRuns > 0) _pill('分身 ${telemetry.clonedRuns}', PB.accent),
              if (telemetry.criticReworks > 0) _pill('复核返工 ${telemetry.criticReworks}', PB.warn),
              if (telemetry.worktreeMerged > 0) _pill('已合入 ${telemetry.worktreeMerged}', PB.success),
              if (telemetry.worktreeConflicts > 0) _pill('冲突 ${telemetry.worktreeConflicts}', PB.danger),
              if (telemetry.checkpointsPending > 0) _pill('等把关 ${telemetry.checkpointsPending}', PB.warn),
              _pill('${telemetry.childrenDone}/${telemetry.childrenTotal} 份已收口', PB.textTertiary),
            ],
          ),
          if (telemetry.byBot.isNotEmpty || telemetry.byModel.isNotEmpty) ...[
            const SizedBox(height: 4),
            InkWell(
              onTap: onToggleUsage,
              borderRadius: BorderRadius.circular(4),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(showUsage ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                        size: 12, color: PB.textTertiary),
                    const SizedBox(width: 4),
                    Text(showUsage ? '收起消耗明细' : '按成员 / 模型看消耗',
                        style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
                  ],
                ),
              ),
            ),
            if (showUsage) ...[
              const SizedBox(height: 6),
              if (telemetry.byBot.isNotEmpty) _usageBlock('按成员', telemetry.byBot),
              if (telemetry.byModel.isNotEmpty) _usageBlock('按模型', telemetry.byModel),
            ],
          ],
        ],
      ),
    );
  }

  Widget _usageBlock(String title, List<TaskRunUsageRow> rows) {
    final max = rows.first.tokens <= 0 ? 1 : rows.first.tokens;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
          for (final row in rows)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Row(
                children: [
                  SizedBox(
                    width: 110,
                    child: Text(row.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary)),
                  ),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(2),
                      child: LinearProgressIndicator(
                        value: (row.tokens / max).clamp(0.0, 1.0),
                        minHeight: 5,
                        backgroundColor: PB.borderSecondary,
                        valueColor: const AlwaysStoppedAnimation<Color>(PB.accent),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text('${formatTokens(row.tokens)}${row.clonedRuns > 0 ? ' · 分身${row.clonedRuns}' : ''}',
                      style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _pill(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(text, style: TextStyle(fontSize: PB.fsXs - 1, color: color, fontWeight: FontWeight.w600)),
      );
}

class _WaterfallList extends StatelessWidget {
  const _WaterfallList({
    required this.waterfall,
    required this.task,
    required this.expanded,
    required this.onToggle,
    this.onApproveCheckpoint,
  });

  final TaskRunWaterfall waterfall;
  final TaskRun task;
  final Set<String> expanded;
  final void Function(String id) onToggle;
  final Future<void> Function(String childTaskRunId)? onApproveCheckpoint;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.gitBranch, size: 13, color: PB.textTertiary),
            const SizedBox(width: 6),
            Text('执行瀑布流',
                style: TextStyle(fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textSecondary)),
            const SizedBox(width: 6),
            Text('总时长 ${formatDuration(waterfall.durationMs)}',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
            if (waterfall.truncated > 0) ...[
              const SizedBox(width: 6),
              Text('（还有 ${waterfall.truncated} 条未显示）',
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
            ],
          ],
        ),
        const SizedBox(height: 6),
        for (final item in waterfall.items)
          _WaterfallRow(
            item: item,
            span: waterfall.spanOf(item),
            name: resolveTaskBotName(state, botId: item.botId, name: item.botName),
            expanded: expanded.contains(item.id),
            onToggle: () => onToggle(item.id),
            onApproveCheckpoint: onApproveCheckpoint,
          ),
      ],
    );
  }
}

class _WaterfallRow extends StatelessWidget {
  const _WaterfallRow({
    required this.item,
    required this.span,
    required this.name,
    required this.expanded,
    required this.onToggle,
    this.onApproveCheckpoint,
  });

  final TaskRunWaterfallItem item;
  final ({double left, double width}) span;
  final String name;
  final bool expanded;
  final VoidCallback onToggle;
  final Future<void> Function(String childTaskRunId)? onApproveCheckpoint;

  Color get _stateColor {
    if (item.phase == 'done') return PB.success;
    if (item.phase == 'needs_user') return PB.warn;
    if (item.phase == 'paused') return PB.textTertiary;
    return PB.accent;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: _stateColor, shape: BoxShape.circle),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  name.isEmpty ? '未指派' : name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textPrimary),
                ),
              ),
              const SizedBox(width: 6),
              Text(item.stateText, style: TextStyle(fontSize: PB.fsXs, color: _stateColor)),
              const SizedBox(width: 6),
              Text(formatDuration(item.durationMs),
                  style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
              if (item.totalTokens > 0) ...[
                const SizedBox(width: 6),
                Text('${formatTokens(item.totalTokens)} tok',
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
              ],
              const Spacer(),
              if (item.waitingCheckpoint && onApproveCheckpoint != null)
                TextButton(
                  onPressed: () => onApproveCheckpoint!(item.id),
                  style: TextButton.styleFrom(
                    minimumSize: const Size(0, 26),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text('放行', style: TextStyle(fontSize: PB.fsXs, color: PB.accent)),
                ),
              if (item.hasDetails)
                IconButton(
                  onPressed: onToggle,
                  iconSize: 14,
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                  icon: Icon(expanded ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                      color: PB.textTertiary),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 甘特条：左偏移 + 宽度都来自服务端算好的相对值（已 clamp）
                LayoutBuilder(
                  builder: (context, constraints) {
                    final width = constraints.maxWidth * span.width;
                    return Stack(
                      children: [
                        Container(
                          height: 6,
                          decoration: BoxDecoration(
                            color: PB.borderSecondary.withValues(alpha: 0.5),
                            borderRadius: BorderRadius.circular(3),
                          ),
                        ),
                        Positioned(
                          left: constraints.maxWidth * span.left,
                          child: Container(
                            height: 6,
                            width: width < 3 ? 3 : width,
                            decoration: BoxDecoration(
                              color: _stateColor,
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                        ),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 5,
                  runSpacing: 3,
                  children: [
                    if (item.cloned) _badge('分身', PB.accent),
                    if ((item.tier ?? '').isNotEmpty && item.tier != 'standard')
                      _badge(item.tier!, item.tier == 'strong' ? PB.warn : PB.success),
                    if (item.critic != null)
                      item.critic!.failed
                          ? _badge('复核×${item.critic!.rounds}', PB.danger)
                          : (item.critic!.passed ? _badge('复核✓', PB.success) : _badge('复核', PB.textTertiary)),
                    if (item.worktree != null) _worktreeBadge(item.worktree!),
                    if (item.waitingOn.isNotEmpty)
                      _badge('等前置 ${item.waitingOn.length}', PB.textTertiary),
                    if (item.waitingCheckpoint) _badge('等把关', PB.warn),
                  ],
                ),
                if (expanded && item.hasDetails) ...[
                  const SizedBox(height: 4),
                  if (item.critic?.defects.isNotEmpty ?? false)
                    for (final defect in item.critic!.defects)
                      Text('· 复核缺陷：$defect',
                          style: TextStyle(fontSize: PB.fsXs, color: PB.danger)),
                  if (item.worktree?.conflictFiles.isNotEmpty ?? false) ...[
                    Text('· 冲突文件：${item.worktree!.conflictFiles.join('、')}',
                        style: TextStyle(fontSize: PB.fsXs, color: PB.danger)),
                    if ((item.worktree?.branch ?? '').isNotEmpty)
                      Text('· 已保留分支 ${item.worktree!.branch}',
                          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
                  ],
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _worktreeBadge(TaskRunWorktreeSummary worktree) {
    if (worktree.merged) {
      return _badge('已合入${worktree.filesCount > 0 ? ' ${worktree.filesCount} 文件' : ''}', PB.success);
    }
    if (worktree.conflicted) return _badge('冲突', PB.danger);
    if (worktree.preservedDirtyMain) return _badge('主仓脏保留', PB.warn);
    if (worktree.status == 'noop') return _badge('无改动', PB.textTertiary);
    return _badge('隔离中', PB.accent);
  }

  Widget _badge(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(text, style: TextStyle(fontSize: PB.fsXs - 1, color: color, fontWeight: FontWeight.w600)),
      );
}

class _BlackboardCard extends StatelessWidget {
  const _BlackboardCard({required this.entries, required this.open, required this.onToggle});

  final List<TaskRunBlackboardEntry> entries;
  final bool open;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: onToggle,
          borderRadius: BorderRadius.circular(4),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                Icon(open ? LucideIcons.chevronDown : LucideIcons.chevronRight,
                    size: 12, color: PB.textTertiary),
                const SizedBox(width: 4),
                Icon(LucideIcons.clipboardList, size: 12, color: PB.textTertiary),
                const SizedBox(width: 4),
                Text('共享黑板（${entries.length}）',
                    style: TextStyle(fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textSecondary)),
              ],
            ),
          ),
        ),
        if (open)
          for (final entry in entries)
            Padding(
              padding: const EdgeInsets.only(top: 3, left: 16),
              child: Text(
                '· ${entry.kindLabel}｜${entry.authorName ?? '系统'}：${entry.text}'
                '${(entry.ref ?? '').isEmpty ? '' : '（${entry.ref}）'}',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
              ),
            ),
      ],
    );
  }
}
