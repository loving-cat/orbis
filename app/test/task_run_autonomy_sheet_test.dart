// 任务详情「自主推进」开关的渲染与可点性。
//
// testWidgets 文件里不碰真 HTTP（出现 testWidgets 之后 HttpClient 恒 400），
// 命令通道在 task_run_autonomy_test.dart 里用 MockClient 验。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/task_run_sheet.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<AppState> pump(
    WidgetTester tester, {
    required String state,
    bool autonomous = false,
    String autonomyReason = '',
  }) async {
    tester.view.physicalSize = const Size(1000, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final app = AppState();
    addTearDown(app.dispose);
    app.taskRuns.applyHello({
      'taskRuns': [
        {
          'id': 'tr1',
          'roomId': 'r1',
          'rootTaskId': 'tr1',
          'revision': 3,
          'sequence': 1,
          'storeVersion': 1,
          'state': state,
          'phase': state == 'completed' || state == 'cancelled' ? 'done' : 'active',
          'title': '把调研做完',
          'scope': '',
          'deliverables': <String>[],
          'updatedAt': 1000,
          'leadBotId': 'b1',
          'leadBotName': '技术分析员',
          'autonomous': autonomous,
          'autonomyReason': autonomyReason,
        },
      ],
    });

    await tester.pumpWidget(
      AppScope(
        state: app,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(home: TaskRunSheet(state: app, taskRunId: 'tr1')),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return app;
  }

  Switch switchOf(WidgetTester tester) => tester.widget<Switch>(find.byType(Switch));

  testWidgets('自主推进开着：做完为止，不停下来问', (tester) async {
    await pump(tester, state: 'running', autonomous: true);

    expect(find.text('自主推进'), findsOneWidget);
    expect(find.text('做完为止，不停下来问'), findsOneWidget);
    expect(switchOf(tester).value, isTrue);
    expect(switchOf(tester).onChanged, isNotNull, reason: '进行中的任务要能改');
  });

  testWidgets('自主推进关着：每到关口先问你', (tester) async {
    await pump(tester, state: 'running');

    expect(find.text('自主推进'), findsOneWidget);
    expect(find.text('每到关口先问你'), findsOneWidget);
    expect(switchOf(tester).value, isFalse);
    expect(switchOf(tester).onChanged, isNotNull);
  });

  testWidgets('服务端给了原因就照实显示', (tester) async {
    await pump(tester, state: 'running', autonomyReason: '你说过要先问我');
    expect(find.text('你说过要先问我'), findsOneWidget);
  });

  testWidgets('终态任务：开关置灰不可点', (tester) async {
    await pump(tester, state: 'completed');

    expect(find.text('任务已结束，不能再改'), findsOneWidget);
    expect(switchOf(tester).onChanged, isNull, reason: '终态不该还能发命令');

    // 点一下也不该抛异常、也不该把值改掉
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(switchOf(tester).value, isFalse);
  });

  testWidgets('取消的任务同样不能改', (tester) async {
    await pump(tester, state: 'cancelled');
    expect(switchOf(tester).onChanged, isNull);
  });
}
