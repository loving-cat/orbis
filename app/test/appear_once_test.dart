// 「第一次上屏才播动画」这条约定必须**不重建子树**（Mac 实机：整屏抽搐）。
//
// 以前的写法是第二次 build 把 `_Appear` 换成 `KeyedSubtree` —— widget 类型一变，
// Flutter 直接卸载重建子树（流式 Markdown / 选区 / 浮层全重来）。
// 现在永远返回 `AppearOnce`，只把 `animate` 置 false。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/appear_once.dart';

/// 探针：State 实例登记进静态列表，用来断言"没被销毁重建"。
class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  static final List<_ProbeState> created = <_ProbeState>[];

  @override
  void initState() {
    super.initState();
    created.add(this);
  }

  @override
  Widget build(BuildContext context) => const SizedBox(height: 24, width: 24);
}

Widget _host({required bool animate, Key? key}) => MaterialApp(
  home: Scaffold(
    body: AppearOnce(
      key: key ?? const ValueKey('m1'),
      animate: animate,
      child: const _Probe(),
    ),
  ),
);

void main() {
  setUp(() => _ProbeState.created.clear());

  testWidgets('★ 从 animate=true 切到 false：子树 State 是同一个实例（没有重建）', (tester) async {
    await tester.pumpWidget(_host(animate: true));
    expect(_ProbeState.created.length, 1, reason: '第一次上屏应当建一次');

    await tester.pump(const Duration(milliseconds: 300)); // 动画跑完
    // 第二次 build：只把 animate 改成 false（模拟"已经出现过的消息"）
    await tester.pumpWidget(_host(animate: false));
    expect(
      _ProbeState.created.length,
      1,
      reason: '★ widget 类型必须保持一致，否则子树会被卸载重建',
    );
  });

  testWidgets('animate=false 时不启动 Ticker（没有位移动画）', (tester) async {
    await tester.pumpWidget(_host(animate: false));
    expect(tester.binding.transientCallbackCount, 0, reason: '已经上过屏的消息不该再有动画');
    // 不透明度直接到 1：位置不抖
    final transform = tester.widget<Transform>(
      find.ancestor(of: find.byType(_Probe), matching: find.byType(Transform)).first,
    );
    expect(transform.transform.getTranslation().y, 0);
  });

  testWidgets('animate=true 时确实会播一次（透明度从 0 到 1）', (tester) async {
    await tester.pumpWidget(_host(animate: true));
    expect(tester.binding.transientCallbackCount, greaterThan(0), reason: '第一次应当有动画');
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.binding.transientCallbackCount, 0, reason: '动画结束后不该再占 Ticker');
  });
}
