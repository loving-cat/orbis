// 右侧边栏「运行参数」里改思考等级：必须点了就停住，不能抽搐。
//
// 用户原话：「右侧边栏点击修改模型思考等级时抽搐一下」。
// 两个原因：改等级走 `_patch` 会把 `_saving` 置 true → 滑条变灰；
// 而 `value` 还是服务端回显前的旧值 → 滑条先弹回旧档。
// 现在用乐观值 + 请求序号：点下去当帧就在新档位，回显到了才交还权威值。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/bot_run_section.dart';
import 'package:pi_bot/widgets/thinking_slider.dart';

/// 保存挂在一个闸门上，测「HTTP 还没回来」的那几帧。
class _SlowState extends AppState {
  _SlowState() {
    bots = [Bot(id: 'b1', name: '运维工程师', thinking: 'low', role: 'main')];
  }

  final Completer<void> gate = Completer<void>();
  final List<Map<String, dynamic>> patches = [];

  @override
  Future<void> updateBot(String botId, Map<String, dynamic> patch) async {
    patches.add(Map.of(patch));
    await gate.future;
    final thinking = patch['thinking'] as String?;
    if (thinking == null) return;
    // 模拟服务端已保存：本地花名册换成新档位（真实实现走 applyBotUpdate + refresh）
    bots = [
      for (final b in bots)
        if (b.id == botId)
          Bot(id: b.id, name: b.name, role: b.role, model: b.model, thinking: thinking)
        else
          b,
    ];
    notifyListeners();
  }
}

Future<void> _pump(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(900, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: AnimatedBuilder(
                animation: state,
                builder: (context, _) => BotRunSection(bot: state.botById('b1')!),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

ThinkingSlider _slider(WidgetTester tester) =>
    tester.widget<ThinkingSlider>(find.byType(ThinkingSlider));

void main() {
  testWidgets('★ 点了就停在新档位：HTTP 未返回前不弹回、不变灰，返回后仍稳定', (tester) async {
    final state = _SlowState();
    addTearDown(state.dispose);
    await _pump(tester, state);
    expect(_slider(tester).value, 'low');
    expect(_slider(tester).enabled, isTrue);

    final rect = tester.getRect(find.byType(ThinkingSlider));
    await tester.tapAt(Offset(rect.right - 2, rect.center.dy));
    await tester.pump(); // 只推进一帧：HTTP 还没回来

    expect(state.patches, [
      {'thinking': 'max'},
    ], reason: '点一下就该发一次保存');
    expect(_slider(tester).value, 'max', reason: '乐观值必须当帧生效，不能等回显');
    expect(_slider(tester).enabled, isTrue, reason: '改思考等级不能把滑条置灰');

    // 中间再推几帧（回显仍未到），不能弹回旧档
    await tester.pump(const Duration(milliseconds: 16));
    expect(_slider(tester).value, 'max');

    // 服务端回来了：还是 max，且乐观值已经交还给权威值（不会来回跳）
    state.gate.complete();
    await tester.pump();
    await tester.pump();
    expect(_slider(tester).value, 'max');
    expect(_slider(tester).enabled, isTrue);
  });

  testWidgets('★ 连续点击 last-write-wins：只认最后一次，中途不回滚', (tester) async {
    final state = _SlowState();
    addTearDown(state.dispose);
    await _pump(tester, state);
    final rect = tester.getRect(find.byType(ThinkingSlider));

    // 先点最左（off），立刻再点最右（max），两次都没返回
    await tester.tapAt(Offset(rect.left + 2, rect.center.dy));
    await tester.pump();
    expect(_slider(tester).value, 'off');
    await tester.tapAt(Offset(rect.right - 2, rect.center.dy));
    await tester.pump();
    expect(_slider(tester).value, 'max');

    state.gate.complete();
    await tester.pump();
    await tester.pump();

    // 最后生效的是 max；前一次请求的「成功回执」不许把滑条拽回 off
    expect(state.patches.map((p) => p['thinking']).toList(), ['off', 'max']);
    expect(_slider(tester).value, 'max');
    expect(state.bots.first.thinking, 'max');
  });

  testWidgets('保存失败时回滚到原档位并提示（不把乐观值留在界面上）', (tester) async {
    final state = _FailingState();
    addTearDown(state.dispose);
    await _pump(tester, state);

    final rect = tester.getRect(find.byType(ThinkingSlider));
    await tester.tapAt(Offset(rect.right - 2, rect.center.dy));
    await tester.pump();
    expect(_slider(tester).value, 'max', reason: '点下去先本地生效');

    // 失败回来：回滚到权威值，并把原因留给提示
    await tester.pump(const Duration(milliseconds: 60));
    await tester.pump();
    expect(state.lastError, isNotNull);
    expect(_slider(tester).value, 'low', reason: '没保存成功必须回到原档位');
  });
}

/// 保存直接失败（服务端拒绝），本地花名册不变。
class _FailingState extends AppState {
  _FailingState() {
    bots = [Bot(id: 'b1', name: '运维工程师', thinking: 'low', role: 'main')];
  }

  @override
  Future<void> updateBot(String botId, Map<String, dynamic> patch) async {
    // 真实保存总有一两个帧的往返：这里留出同样的窗口，才能验「先乐观、失败再回滚」
    await Future<void>.delayed(const Duration(milliseconds: 50));
    lastError = '保存失败（测试）';
  }
}
