import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/avatar_life.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 复现 rc.2 启动时那一条（2026-11-27T18:00:24，`app.log:1191`）：
///
///   #0 RenderSliverMultiBoxAdaptor.childMainAxisPosition  (sliver_multi_box_adaptor.dart:660)
///   #1 RenderSliverHelpers.applyPaintTransformForBoxChild (sliver.dart:1965)
///   #2 RenderSliverMultiBoxAdaptor.applyPaintTransform    (sliver_multi_box_adaptor.dart:688)
///   #3 RenderObject.getTransformTo                        (object.dart:3730)
///   #4 RenderBox.localToGlobal                            (box.dart:3114)
///   #5 _BlobAvatarState._followPointer                    (blob_avatar.dart:294)
///   #6 _BlobAvatarState._startFollow                      (blob_avatar.dart:349)
///   #7 _BlobAvatarState._syncFollow                       (blob_avatar.dart:375)
///   #8 _BlobAvatarState.didUpdateWidget                   (blob_avatar.dart:405)
///
/// 与 rc.1 修掉的那条（`!attached` / `owner.rootNode == null`）**不是同一个入口**：
/// 这次 box 明明 attached、`hasSize` 也过了，但算全局坐标这件事发生在
/// **build / layout 阶段**（`SliverMultiBoxAdaptor._createOrObtainChild` →
/// `invokeLayoutCallback` → `buildScope` → `didUpdateWidget`），
/// 那时祖先 sliver 还没给子节点写 `layoutOffset`（`childScrollAxisPosition`
/// 里是 `childScrollOffset(child)!`），或者祖先 RenderTransform 还没 size。
///
/// 所以判据不是「有没有抛异常」——换父那一刻本身会有一个合法的 hasSize 断言。
/// 要精确断言的是：**没有任何一条错误的栈里含 `_BlobAvatarState._followPointer`**。
void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = true;
    AvatarLife.pointer.value = const Offset(120, 90);
  });
  tearDown(() {
    AvatarLife.pointer.value = null;
    BlobAvatar.animationsEnabled = true;
  });

  testWidgets('layout 阶段的 build 里翻悬停态，不得在 _followPointer 里算全局坐标', (tester) async {
    final key = GlobalKey();
    final caught = <String>[];
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      caught.add('${details.exceptionAsString()}\n${details.stack ?? ''}');
    };

    Widget frame({required bool left, required bool hovered}) {
      final avatar = BlobAvatar(
        key: key,
        seed: 'sliver-layout',
        color: Colors.blue,
        hovered: hovered,
      );
      final list = CustomScrollView(
        slivers: <Widget>[
          const SliverToBoxAdapter(child: SizedBox(height: 40)),
          SliverList(delegate: SliverChildListDelegate(<Widget>[avatar])),
        ],
      );
      return MaterialApp(
        home: Row(
          children: <Widget>[
            Expanded(child: left ? list : const SizedBox()),
            Expanded(child: left ? const SizedBox() : list),
          ],
        ),
      );
    }

    // 第一帧：头像在左侧列表，已 layout。
    await tester.pumpWidget(frame(left: true, hovered: false));
    await tester.pump(const Duration(milliseconds: 16));
    caught.clear();

    // 第二帧：GlobalKey 把头像搬到右侧**另一个** sliver，同一次 rebuild 里
    // 把 hovered 从 false 翻成 true → didUpdateWidget → _syncFollow
    // → _startFollow → _followPointer()。此时新父正在 layout 中。
    await tester.pumpWidget(frame(left: false, hovered: true));

    final followCrashes = caught
        .where((e) => e.contains('_BlobAvatarState._followPointer'))
        .toList();
    caught.clear();
    FlutterError.onError = previous;

    expect(
      followCrashes,
      isEmpty,
      reason:
          'build/layout 阶段（祖先 sliver 还没写 layoutOffset、祖先还没 size）'
          '不能算全局坐标；应等 post-frame：\n${followCrashes.join('\n---\n')}',
    );

    // 布局跑完之后，正常跟随仍然要工作（不能靠"永远不跟随"蒙过去）。
    await tester.pump(const Duration(milliseconds: 16));
    tester.takeException();
    AvatarLife.pointer.value = const Offset(300, 200);
    await tester.pump(const Duration(milliseconds: 16));
    expect(tester.takeException(), isNull);
  });
}
