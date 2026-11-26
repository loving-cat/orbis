/// 候选经验「一键采纳」卡（C5）。
///
/// ## 要解决的问题
///
/// 复盘产出的候选经验一直躺在设置页里等用户自己去找 —— 而用户根本不知道
/// 它生成了。于是「经验库」长期是空的，SIM-Lite 的闭环断在最后一厘米。
///
/// 这里把它搬到用户眼前：房间侧栏顶部一张紧凑卡，看到就能一键采纳或忽略。
///
/// ## 三条刻意的取舍
///
/// 1. **0 条即 0 像素**：没有候选时返回 `SizedBox.shrink()`，
///    绝不给侧栏凭空加一段空白（会顶掉下面任务面板的位置）。
/// 2. **没有证据不能采纳**：服务端是 fail-closed 的（无证据不许启用），
///    所以这里直接禁用按钮并说明原因 —— 让用户点了才被拒是最差的体验。
/// 3. **最多两条**：侧栏是常驻区域，超过两条就变成噪音，用「还有 N 条」收口。
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';

class LessonAdoptionBanner extends StatelessWidget {
  const LessonAdoptionBanner({
    super.key,
    required this.roomId,
    this.maxItems = 2,
  });

  final String roomId;
  final int maxItems;

  /// 这个房间优先、其次全局；只取候选态。
  static List<LibraryLesson> candidatesFor(
    AppState state, {
    required String roomId,
    int maxItems = 2,
  }) {
    final all = state.lessons.where((l) => l.status == 'candidate').toList(growable: false);
    final scoped = all.where((l) => l.roomId == roomId).toList(growable: false);
    final rest = all.where((l) => l.roomId != roomId).toList(growable: false);
    final ordered = [...scoped, ...rest];
    return ordered.take(maxItems).toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final all = state.lessons.where((l) => l.status == 'candidate').toList(growable: false);
        if (all.isEmpty) return const SizedBox.shrink();
        final shown = candidatesFor(state, roomId: roomId, maxItems: maxItems);
        final more = all.length - shown.length;
        return Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(LucideIcons.sparkles, size: 13, color: PB.accent),
                  const SizedBox(width: 6),
                  Text('可以采纳的经验',
                      style: TextStyle(
                          fontSize: PB.fsXs, fontWeight: FontWeight.w600, color: PB.textSecondary)),
                  if (more > 0) ...[
                    const SizedBox(width: 6),
                    Text('还有 $more 条',
                        style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
                  ],
                ],
              ),
              for (final lesson in shown)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: _LessonCard(
                    lesson: lesson,
                    onAdopt: () async {
                      final error = await state.setLessonStatus(lesson.id, 'active');
                      if (context.mounted) _toast(context, error ?? '已采纳，下轮起生效');
                    },
                    onIgnore: () async {
                      final error = await state.rejectLesson(lesson.id);
                      if (context.mounted) _toast(context, error ?? '已忽略');
                    },
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  static void _toast(BuildContext context, String text) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;
    messenger.showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 2)));
  }
}

class _LessonCard extends StatelessWidget {
  const _LessonCard({required this.lesson, required this.onAdopt, required this.onIgnore});

  final LibraryLesson lesson;
  final Future<void> Function() onAdopt;
  final Future<void> Function() onIgnore;

  /// 没有证据时不许采纳（与服务端的 fail-closed 校验一致）。
  bool get _hasEvidence =>
      lesson.evidence.any((e) => e.quote.trim().isNotEmpty);

  String get _evidenceQuote {
    for (final e in lesson.evidence) {
      if (e.quote.trim().isNotEmpty) return e.quote.trim();
    }
    return '';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: PB.borderTertiary.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('情境：${lesson.cue}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary)),
          const SizedBox(height: 2),
          Text('做法：${lesson.lesson}',
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                  fontSize: PB.fsSm, fontWeight: FontWeight.w600, color: PB.textPrimary)),
          const SizedBox(height: 3),
          if (_hasEvidence)
            Text('证据：「$_evidenceQuote」',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary))
          else
            Text('这条没有证据原话，暂不能采纳（补上证据再说）',
                style: TextStyle(fontSize: PB.fsXs, color: PB.warn)),
          const SizedBox(height: 6),
          Row(
            children: [
              FilledButton(
                onPressed: _hasEvidence ? () => onAdopt() : null,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  textStyle: TextStyle(fontSize: PB.fsXs),
                ),
                child: const Text('一键采纳'),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () => onIgnore(),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  textStyle: TextStyle(fontSize: PB.fsXs),
                ),
                child: Text('忽略', style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
