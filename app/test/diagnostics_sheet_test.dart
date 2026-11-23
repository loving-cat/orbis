// 诊断日志面板（Mac 实机 UX-4）：数据进来后两个 Tab 都要看得见东西。
//
// 用注入的 loader 而不是真 HTTP：flutter_test 的 HttpClient 被替换成固定 400，
// 真网络在 widget 测试里根本不会发生（这条在 bootstrap 里就写着了）。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/diagnostics_sheet.dart';

Future<Map<String, dynamic>?> _fakeLoading({int limit = 100}) async => {
  'modelErrors': [
    {
      'ts': 1700000000000,
      'phase': 'turn',
      'roomId': 'r1',
      'roomName': '研发部',
      'botId': 'b1',
      'botName': '编码手',
      'model': 'provider/model-a',
      'status': 502,
      'code': 'ECONNRESET',
      'summary': '模型请求失败（HTTP 502）',
      'detail': 'HTTP 502 · code=ECONNRESET · upstream=bad_gateway',
      'ms': 900,
    },
  ],
  'serverLogTail': ['[12:00:00] 服务端启动', '[12:00:01] model failed'],
  'logPath': '/tmp/orbis/server.log',
};

Future<void> _pumpUntil(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 20; i += 1) {
    await tester.pump(const Duration(milliseconds: 40));
    if (finder.evaluate().isNotEmpty) return;
  }
  fail('等不到：$finder');
}

Future<void> _open(
  WidgetTester tester, {
  DiagnosticsLoader? loader,
}) async {
  final state = AppState();
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showDiagnosticsSheet(context, loader: loader),
              child: const Text('打开'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开'));
  await tester.pump();
}

void main() {
  testWidgets('★ 模型异常 Tab：房间/Bot/模型/状态码/错误码与脱敏详情', (tester) async {
    await _open(tester, loader: _fakeLoading);
    await _pumpUntil(tester, find.text('模型请求异常'));

    expect(find.textContaining('研发部'), findsWidgets);
    expect(find.textContaining('HTTP 502'), findsWidgets);
    expect(find.textContaining('ECONNRESET'), findsWidgets);
    expect(find.textContaining('provider/model-a'), findsWidgets);

    // 展开脱敏上游详情
    await tester.ensureVisible(find.text('展开脱敏上游详情').first);
    await tester.tap(find.text('展开脱敏上游详情').first);
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.textContaining('upstream=bad_gateway'), findsWidgets);
  });

  testWidgets('★ 服务端日志 Tab：server.log 尾部与路径', (tester) async {
    await _open(tester, loader: _fakeLoading);
    await _pumpUntil(tester, find.text('服务端日志'));
    await tester.tap(find.widgetWithText(Tab, '服务端日志'));
    await tester.pumpAndSettle();
    expect(find.textContaining('model failed'), findsWidgets);
    expect(find.textContaining('server.log'), findsWidgets);
  });

  testWidgets('没有任何记录时给两句人话（不是一片空白）', (tester) async {
    await _open(
      tester,
      loader: ({int limit = 100}) async => {
        'modelErrors': <Map<String, dynamic>>[],
        'serverLogTail': <String>[],
        'logPath': '',
      },
    );
    await _pumpUntil(tester, find.text('还没有记录到模型请求异常'));
    await tester.tap(find.widgetWithText(Tab, '服务端日志'));
    await tester.pumpAndSettle();
    expect(find.textContaining('server.log'), findsWidgets);
  });
}
