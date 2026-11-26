/// C5：集群全景的模型（详情接口 `GET /api/task-runs/:id` 才下发）。
///
/// 单独一个文件而不是塞进 `task_run_models.dart`：那一份已经很长，
/// 而这里全是「只读明细」—— 列表接口根本不带，用不着跟基础模型一起加载。
/// 由 `task_run_models.dart` 原样 re-export，外部 import 路径不变。
library;

double _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  return double.tryParse('${value ?? ''}') ?? 0;
}

int _asInt(Object? value, [int fallback = 0]) {
  if (value is num) return value.toInt();
  return int.tryParse('${value ?? ''}') ?? fallback;
}

String _asString(Object? value, [String fallback = '']) {
  final text = value == null ? '' : '$value';
  return text.isEmpty ? fallback : text;
}

List<String> _asStringList(Object? raw) => ((raw as List?) ?? const [])
    .map((x) => '$x'.trim())
    .where((x) => x.isNotEmpty)
    .toList(growable: false);

/// Critic 复核摘要（C2）。没复核过就是 null。
class TaskRunCriticSummary {
  const TaskRunCriticSummary({
    this.verdict,
    this.rounds = 0,
    this.maxRounds,
    this.reviewerModel,
    this.defects = const [],
  });

  final String? verdict;
  final int rounds;
  final int? maxRounds;
  final String? reviewerModel;
  final List<String> defects;

  bool get passed => verdict == 'passed';
  bool get failed => verdict == 'failed';

  factory TaskRunCriticSummary.fromJson(Map<String, dynamic> json) => TaskRunCriticSummary(
        verdict: json['verdict'] == null ? null : _asString(json['verdict']),
        rounds: _asInt(json['rounds']),
        maxRounds: json['maxRounds'] == null ? null : _asInt(json['maxRounds']),
        reviewerModel: json['reviewerModel'] == null ? null : _asString(json['reviewerModel']),
        defects: _asStringList(json['defects']),
      );
}

/// Worktree 摘要（C4）。
class TaskRunWorktreeSummary {
  const TaskRunWorktreeSummary({
    required this.status,
    this.branch,
    this.mergedHead,
    this.conflictFiles = const [],
    this.filesCount = 0,
  });

  final String status;
  final String? branch;
  final String? mergedHead;
  final List<String> conflictFiles;
  final int filesCount;

  bool get merged => status == 'merged';
  bool get conflicted => status == 'conflict';
  bool get preservedDirtyMain => status == 'preserved_dirty_main';

  factory TaskRunWorktreeSummary.fromJson(Map<String, dynamic> json) => TaskRunWorktreeSummary(
        status: _asString(json['status'], 'active'),
        branch: json['branch'] == null ? null : _asString(json['branch']),
        mergedHead: json['mergedHead'] == null ? null : _asString(json['mergedHead']),
        conflictFiles: _asStringList(json['conflictFiles']),
        filesCount: _asInt(json['filesCount']),
      );
}

/// 一个子任务在瀑布流里的一条。
class TaskRunWaterfallItem {
  const TaskRunWaterfallItem({
    required this.id,
    required this.title,
    required this.botId,
    required this.botName,
    required this.state,
    required this.stateText,
    required this.phase,
    this.queuedAt,
    this.startedAt,
    this.endedAt,
    this.durationMs,
    this.queuedOffsetMs,
    this.offsetMs,
    this.dependsOn = const [],
    this.waitingOn = const [],
    this.waitingCheckpoint = false,
    this.checkpointApproved = false,
    this.waitingPlanSteps = const [],
    this.cloned = false,
    this.cloneId,
    this.tier,
    this.model,
    this.critic,
    this.worktree,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.totalTokens = 0,
    this.costUsd,
  });

  final String id;
  final String title;
  final String botId;
  final String botName;
  final String state;
  final String stateText;
  final String phase;

  /// 建档（开始排队）的时刻。排队到开跑之间那段是「等」，不是在干活。
  final int? queuedAt;

  /// 第一次真正派出去执行的时刻；还没开跑为 null。
  final int? startedAt;
  final int? endedAt;

  /// 从开跑到结束（没结束的算到服务端的此刻）；没开跑为 null。
  final int? durationMs;

  /// 排队起点相对整棵树起点的偏移。
  final int? queuedOffsetMs;

  /// 开跑时刻相对整棵树起点的偏移（服务端算好，客户端画条用）；没开跑为 null。
  final int? offsetMs;
  final List<String> dependsOn;
  final List<String> waitingOn;
  final bool waitingCheckpoint;
  final bool checkpointApproved;

  /// 被计划挂起：在等计划里还没派出去的第 N 条（此时「等把关」不是在等审产物）。
  final List<int> waitingPlanSteps;

  /// 真的开跑过（有执行条可画）。
  bool get started => offsetMs != null;

  /// 这一路是不是临时分身（C3）。
  final bool cloned;
  final String? cloneId;

  /// 难度档位（fast / standard / strong）。
  final String? tier;

  /// 实际执行的模型（分档/临时切换才非空）。
  final String? model;
  final TaskRunCriticSummary? critic;
  final TaskRunWorktreeSummary? worktree;
  final int inputTokens;
  final int outputTokens;
  final int totalTokens;

  /// 估算费用：服务端没有单价时为 null —— 界面就不显示，绝不瞎编。
  final double? costUsd;

  bool get hasTokens => totalTokens > 0;

  /// 要不要给「展开」按钮：有缺陷或有冲突文件才值得展开。
  bool get hasDetails =>
      (critic?.defects.isNotEmpty ?? false) || (worktree?.conflictFiles.isNotEmpty ?? false);

  factory TaskRunWaterfallItem.fromJson(Map<String, dynamic> json) {
    final dispatch = json['dispatch'] is Map
        ? (json['dispatch'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final tokens = json['tokens'] is Map
        ? (json['tokens'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    return TaskRunWaterfallItem(
      id: _asString(json['id']),
      title: _asString(json['title']),
      botId: _asString(json['botId']),
      botName: _asString(json['botName']),
      state: _asString(json['state'], 'unknown'),
      stateText: _asString(json['stateText'], '未知'),
      phase: _asString(json['phase'], 'active'),
      queuedAt: json['queuedAt'] == null ? null : _asInt(json['queuedAt']),
      startedAt: json['startedAt'] == null ? null : _asInt(json['startedAt']),
      endedAt: json['endedAt'] == null ? null : _asInt(json['endedAt']),
      durationMs: json['durationMs'] == null ? null : _asInt(json['durationMs']),
      queuedOffsetMs: json['queuedOffsetMs'] == null ? null : _asInt(json['queuedOffsetMs']),
      offsetMs: json['offsetMs'] == null ? null : _asInt(json['offsetMs']),
      dependsOn: _asStringList(json['dependsOn']),
      waitingOn: _asStringList(json['waitingOn']),
      waitingCheckpoint: json['waitingCheckpoint'] == true,
      checkpointApproved: json['checkpointApproved'] == true,
      waitingPlanSteps: ((json['waitingPlanSteps'] as List?) ?? const [])
          .map((x) => _asInt(x))
          .where((n) => n > 0)
          .toList(growable: false),
      cloned: dispatch['cloned'] == true,
      cloneId: dispatch['cloneId'] == null ? null : _asString(dispatch['cloneId']),
      tier: dispatch['tier'] == null ? null : _asString(dispatch['tier']),
      model: dispatch['model'] == null ? null : _asString(dispatch['model']),
      critic: json['critic'] is Map
          ? TaskRunCriticSummary.fromJson((json['critic'] as Map).cast<String, dynamic>())
          : null,
      worktree: json['worktree'] is Map
          ? TaskRunWorktreeSummary.fromJson((json['worktree'] as Map).cast<String, dynamic>())
          : null,
      inputTokens: _asInt(tokens['input']),
      outputTokens: _asInt(tokens['output']),
      totalTokens: _asInt(tokens['total']),
      costUsd: json['costUsd'] == null ? null : _asDouble(json['costUsd']),
    );
  }
}

/// 按成员 / 按模型的消耗行。
class TaskRunUsageRow {
  const TaskRunUsageRow({
    required this.label,
    required this.tokens,
    this.runs = 0,
    this.clonedRuns = 0,
  });

  final String label;
  final int tokens;
  final int runs;
  final int clonedRuns;

  factory TaskRunUsageRow.fromBot(Map<String, dynamic> json) => TaskRunUsageRow(
        label: _asString(json['name'], _asString(json['botId'])),
        tokens: _asInt(json['tokens']),
        runs: _asInt(json['runs']),
        clonedRuns: _asInt(json['clonedRuns']),
      );

  factory TaskRunUsageRow.fromModel(Map<String, dynamic> json) => TaskRunUsageRow(
        label: _asString(json['model'], 'default'),
        tokens: _asInt(json['tokens']),
        runs: _asInt(json['runs']),
      );
}

/// 整棵树的遥测汇总。
class TaskRunTelemetry {
  const TaskRunTelemetry({
    this.totalTokens = 0,
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.criticTokens = 0,
    this.estimatedCostUsd,
    this.maxTokens,
    this.usedTokens,
    this.remainingTokens,
    this.byBot = const [],
    this.byModel = const [],
    this.childrenTotal = 0,
    this.childrenDone = 0,
    this.clonedRuns = 0,
    this.criticReworks = 0,
    this.worktreeMerged = 0,
    this.worktreeConflicts = 0,
    this.checkpointsPending = 0,
  });

  final int totalTokens;
  final int inputTokens;
  final int outputTokens;
  final int criticTokens;

  /// 无单价时为 null —— 界面不显示价格。
  final double? estimatedCostUsd;
  final int? maxTokens;
  final int? usedTokens;
  final int? remainingTokens;
  final List<TaskRunUsageRow> byBot;
  final List<TaskRunUsageRow> byModel;
  final int childrenTotal;
  final int childrenDone;
  final int clonedRuns;
  final int criticReworks;
  final int worktreeMerged;
  final int worktreeConflicts;
  final int checkpointsPending;

  /// 有没有设 token 上限（没设＝不限，不是剩 0）。
  bool get hasBudget => maxTokens != null && maxTokens! > 0;

  /// 预算用量比例（0..1）：没设上限时返回 null（界面画「不限」而不是满格）。
  double? get budgetRatio {
    final max = maxTokens;
    if (max == null || max <= 0) return null;
    final used = usedTokens ?? 0;
    final ratio = used / max;
    if (ratio.isNaN || ratio.isInfinite) return null;
    return ratio.clamp(0.0, 1.0).toDouble();
  }

  factory TaskRunTelemetry.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const TaskRunTelemetry();
    final budget = json['budget'] is Map
        ? (json['budget'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final counts = json['counts'] is Map
        ? (json['counts'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    List<TaskRunUsageRow> rows(dynamic raw, TaskRunUsageRow Function(Map<String, dynamic>) make) =>
        ((raw as List?) ?? const [])
            .whereType<Map>()
            .map((m) => make(m.cast<String, dynamic>()))
            .toList(growable: false);
    return TaskRunTelemetry(
      totalTokens: _asInt(json['totalTokens']),
      inputTokens: _asInt(json['inputTokens']),
      outputTokens: _asInt(json['outputTokens']),
      criticTokens: _asInt(json['criticTokens']),
      estimatedCostUsd: json['estimatedCostUsd'] == null ? null : _asDouble(json['estimatedCostUsd']),
      maxTokens: budget['maxTokens'] == null ? null : _asInt(budget['maxTokens']),
      usedTokens: budget['usedTokens'] == null ? null : _asInt(budget['usedTokens']),
      remainingTokens: budget['remainingTokens'] == null ? null : _asInt(budget['remainingTokens']),
      byBot: rows(json['byBot'], TaskRunUsageRow.fromBot),
      byModel: rows(json['byModel'], TaskRunUsageRow.fromModel),
      childrenTotal: _asInt(counts['childrenTotal']),
      childrenDone: _asInt(counts['childrenDone']),
      clonedRuns: _asInt(counts['clonedRuns']),
      criticReworks: _asInt(counts['criticReworks']),
      worktreeMerged: _asInt(counts['worktreeMerged']),
      worktreeConflicts: _asInt(counts['worktreeConflicts']),
      checkpointsPending: _asInt(counts['checkpointsPending']),
    );
  }
}

/// 全组共享黑板的一条（客户端安全摘要）。
class TaskRunBlackboardEntry {
  const TaskRunBlackboardEntry({
    required this.kind,
    required this.text,
    this.authorName,
    this.ref,
    this.at,
  });

  final String kind;
  final String text;
  final String? authorName;
  final String? ref;
  final int? at;

  String get kindLabel => const {
        'constraint': '约束',
        'decision': '决定',
        'artifact': '产物',
        'fact': '事实',
      }[kind] ?? '事实';

  factory TaskRunBlackboardEntry.fromJson(Map<String, dynamic> json) => TaskRunBlackboardEntry(
        kind: _asString(json['kind'], 'fact'),
        text: _asString(json['text']),
        authorName: json['authorName'] == null ? null : _asString(json['authorName']),
        ref: json['ref'] == null ? null : _asString(json['ref']),
        at: json['at'] == null ? null : _asInt(json['at']),
      );
}

/// 整棵树的瀑布流。
class TaskRunWaterfall {
  const TaskRunWaterfall({
    this.originAt,
    this.endAt,
    this.durationMs,
    this.items = const [],
    this.total = 0,
    this.truncated = 0,
  });

  final int? originAt;
  final int? endAt;
  final int? durationMs;
  final List<TaskRunWaterfallItem> items;
  final int total;
  final int truncated;

  bool get isEmpty => items.isEmpty;

  /// 排队等待那一段在整棵树里的相对区间（建档 → 开跑；没开跑的等到时间轴末端）。
  ///
  /// 没有建档时间、或者建完马上就开跑（等待段不到 1%）时返回 null —— 不画。
  ({double left, double width})? waitSpanOf(TaskRunWaterfallItem item) {
    final span = durationMs;
    final queued = item.queuedOffsetMs;
    if (span == null || span <= 0 || queued == null) return null;
    final end = (item.offsetMs ?? span).toDouble();
    final left = (queued / span).clamp(0.0, 1.0).toDouble();
    final right = (end / span).clamp(0.0, 1.0).toDouble();
    if (right - left < 0.01) return null;
    return (left: left, width: right - left);
  }

  /// 某条在整棵树里的相对区间（0..1，已做边界保护：除零、越界、负宽）。
  ///
  /// 只对开跑过的条有意义（[TaskRunWaterfallItem.started]）；没开跑的条只画 [waitSpanOf]。
  ({double left, double width}) spanOf(TaskRunWaterfallItem item) {
    const minWidth = 0.02;
    final span = durationMs;
    if (span == null || span <= 0) return (left: 0.0, width: 1.0);
    final start = (item.offsetMs ?? 0).toDouble();
    final duration = (item.durationMs ?? 0).toDouble();
    // ★ 两个边界都要管：
    //   · left 最多到 `1 - minWidth`（否则条子会从右边界外开始画）；
    //   · width 至少 minWidth、最多 `1 - left`（否则条子会溢出容器）。
    final left = (start / span).clamp(0.0, 1.0 - minWidth).toDouble();
    final room = 1.0 - left;
    final width = (duration / span).clamp(minWidth, room < minWidth ? minWidth : room).toDouble();
    return (left: left, width: width);
  }

  factory TaskRunWaterfall.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const TaskRunWaterfall();
    return TaskRunWaterfall(
      originAt: json['originAt'] == null ? null : _asInt(json['originAt']),
      endAt: json['endAt'] == null ? null : _asInt(json['endAt']),
      durationMs: json['durationMs'] == null ? null : _asInt(json['durationMs']),
      items: ((json['items'] as List?) ?? const [])
          .whereType<Map>()
          .map((m) => TaskRunWaterfallItem.fromJson(m.cast<String, dynamic>()))
          .toList(growable: false),
      total: _asInt(json['total']),
      truncated: _asInt(json['truncated']),
    );
  }
}
