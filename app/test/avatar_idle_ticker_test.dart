import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 空闲空转的**机制**回归：`transientCallbackCount` 就是"当前有几个 Ticker
/// 在逐帧要帧"，比 CPU 百分比精确（CPU 会被光栅线程和核心数稀释）。
///
/// 已知边界（本测试只钉住 idle 这一侧）：
///   · `AvatarMood.idle` 的头像空闲 6s 后 `_sleep()` → 0 个 Ticker ✅
///   · `AvatarMood.busy / speaking`（`isActiveWork`）**永不休眠** ——
///     `_wake()` 里 `if (widget.mood.isActiveWork) return;` 直接跳过了挂
///     `_settleTimer`，`_wobble` 的 `repeat()` 就一直转到这个 widget 被拆掉。
///     实测 6 个 busy 头像 = **12 个常驻 Ticker**。这是有意记下的现状，
///     修掉时把下面那条 `busyTickers` 的注释和这个说明一起改。
void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = null;
  });
  tearDown(() {
    AvatarLife.pointer.value = null;
    BlobAvatar.animationsEnabled = true;
  });

  Future<int> tickersAfterIdle(
    WidgetTester tester,
    AvatarMood mood, {
    int count = 6,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: <Widget>[
              for (var i = 0; i < count; i++)
                BlobAvatar(seed: 'idle-$i', color: Colors.blue, mood: mood),
            ],
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 16));
    // 空闲 10 秒（AvatarLife.settleAfter = 6s，该睡的早睡了）
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 320));
    }
    return tester.binding.transientCallbackCount;
  }

  testWidgets('空闲头像静下来之后一个 Ticker 都不留', (tester) async {
    final idle = await tickersAfterIdle(tester, AvatarMood.idle);
    expect(idle, 0, reason: 'idle 头像 6s 无交互后必须停表，否则桌面端会一直烧帧');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(tester.binding.transientCallbackCount, 0);
  });
}
