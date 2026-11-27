import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 复现 app.log 里刷了几百次的那条崩溃（2.0 rc.1，Windows 桌面端）：
///
///   Null check operator used on a null value
///   #0 RenderObject.getTransformTo (object.dart:3699)   ← owner!.rootNode!
///   #1 RenderBox.localToGlobal  (box.dart:3114)
///   #2 _BlobAvatarState._followPointer (blob_avatar.dart:259)
///   #3 ChangeNotifier.notifyListeners  ← AvatarLife.pointer 通知
///
/// 成因：`AvatarLife.pointer` 是**全局** ValueNotifier。头像悬停时订阅、
/// dispose 时才退订。而 render object 的"有效生命周期"比 State 短 ——
/// 整个 View 被摘掉（窗口重建 / 缩放 / DPI 或显示器切换 / 最小化恢复）时，
/// RenderBox 已经不在 render tree 里，但 size 还是缓存值、指针通知照发，
/// 于是照样跑进 `localToGlobal`。
///
/// 关键：`hasSize` 拦不住这件事 —— detach 不会清 size。必须判 `attached`
/// （以及 owner 的 rootNode，那才是 getTransformTo 里真正解引用的东西）。
void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = null;
  });
  tearDown(() {
    AvatarLife.pointer.value = null;
    BlobAvatar.animationsEnabled = true;
  });

  testWidgets('头像 render object 已 detach 时，指针通知不得抛异常', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            // hovered: true → 订阅 AvatarLife.pointer（_startFollow 里 addListener）
            child: BlobAvatar(
              seed: 'detached',
              color: Colors.blue,
              hovered: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 16));

    // 正常路径先跑一次，确认订阅确实生效
    AvatarLife.pointer.value = const Offset(10, 20);
    await tester.pump();
    expect(tester.takeException(), isNull);

    // 把整个 view 摘掉：头像的 RenderBox 变 detached
    final view = tester.binding.renderViews.first;
    final owner = view.owner!;
    owner.rootNode = null;

    final box = tester.renderObject<RenderBox>(find.byType(BlobAvatar));
    expect(box.hasSize, isTrue, reason: 'size 是缓存值，detach 之后仍是 true —— hasSize 判不住');
    expect(box.attached, isFalse, reason: '这条才是真正该判的条件');

    // 鼠标动一下 → 所有订阅者收到通知 → _followPointer
    AvatarLife.pointer.value = const Offset(33, 44);
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'detached 的 box 上算 localToGlobal 会抛');

    // 再动一次，排除"第一次碰巧没抛"
    AvatarLife.pointer.value = const Offset(55, 66);
    await tester.pump();
    expect(tester.takeException(), isNull);

    // 恢复，确认没把树弄坏
    owner.rootNode = view;
    AvatarLife.pointer.value = const Offset(30, 40);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
