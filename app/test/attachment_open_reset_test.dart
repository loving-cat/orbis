// 附件「用系统应用打开」的两条实机问题：
//   1. 状态永远不消失（顶栏被一句常驻文本撑变形、还叠出两层提示）；
//   2. 关闭页面时留下悬空 Timer。
//
// 第一条现在由 controller 自己定时复位 + 界面只 toast 一次来保证。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/attachment_external_open.dart';
import 'package:pi_bot/attachment_preview_request.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/attachment_actions.dart';

AttachmentOpenController _ctl({
  String? failure,
  int opMs = 0,
  Duration handedOffDelay = const Duration(milliseconds: 20),
  Duration failedDelay = const Duration(milliseconds: 20),
}) => AttachmentOpenController(
  operation: () async {
    if (opMs > 0) await Future<void>.delayed(Duration(milliseconds: opMs));
    return failure;
  },
  handedOffDelay: handedOffDelay,
  failedDelay: failedDelay,
);

void main() {
  test('★ handedOff 之后自动回到 idle（提示不会永久钉住）', () async {
    final c = _ctl();
    addTearDown(c.dispose);
    await c.open();
    expect(c.phase, AttachmentOpenPhase.handedOff);
    expect(c.message, '已交给系统程序');

    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(c.phase, AttachmentOpenPhase.idle, reason: '应当自动复位');
    expect(c.message, isNull);
  });

  test('failed 也会复位（错误同样不该常驻）', () async {
    final c = _ctl(failure: '打开失败：下载超时，请重试。');
    addTearDown(c.dispose);
    await c.open();
    expect(c.phase, AttachmentOpenPhase.failed);
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(c.phase, AttachmentOpenPhase.idle);
    expect(c.error, isNull);
  });

  test('★ dispose 会取消计时器（不留悬空 Timer，也不再 notify）', () async {
    final c = _ctl(handedOffDelay: const Duration(milliseconds: 30));
    var notified = 0;
    c.addListener(() => notified++);
    await c.open();
    final before = notified;
    c.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(notified, before, reason: 'dispose 之后不该再 notifyListeners');
    expect(c.phase, AttachmentOpenPhase.handedOff, reason: '已销毁，状态不该再被计时器改');
  });

  test('再次 open 会重置计时器（上一轮的复位不会把新一轮打回 idle）', () async {
    final c = _ctl(opMs: 20, handedOffDelay: const Duration(milliseconds: 40));
    addTearDown(c.dispose);
    await c.open(); // handedOff at ~20ms，计时器 40ms 后复位（~60ms）
    await Future<void>.delayed(const Duration(milliseconds: 30)); // ~50ms：仍 handedOff
    await c.open(); // 重新打开：旧计时器必须作废
    expect(c.phase, AttachmentOpenPhase.handedOff);
    await Future<void>.delayed(const Duration(milliseconds: 30)); // ~100ms
    // 若旧计时器没取消，这里已经被打回 idle 了；新计时器要到 ~40ms 后才复位
    expect(c.phase, AttachmentOpenPhase.handedOff);
  });

  testWidgets('★ 打开成功后不再把文本钉死在顶栏（只有 toast 一闪）', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          appBar: AppBar(
            actions: [
              AttachmentActionButtons(
                request: AttachmentPreviewRequest(
                  file: Attachment(
                    id: 'a1',
                    name: 'report.pdf',
                    mime: 'application/pdf',
                    size: 1,
                    kind: 'file',
                  ),
                  sourceUrl: 'http://127.0.0.1/x',
                ),
                openOperation: () async => null,
              ),
            ],
          ),
        ),
      ),
    );
    // 顶栏高度正常（一行图标，没有被文本撑高）
    final barHeight = tester.getSize(find.byType(AppBar)).height;
    expect(barHeight, lessThanOrEqualTo(80), reason: '顶栏不该被提示文本撑高');

    await tester.tap(find.byType(IconButton).last);
    await tester.pump(); // 触发 opening
    await tester.pump(const Duration(milliseconds: 50)); // 完成 → toast
    expect(find.text('已交给系统程序'), findsWidgets, reason: '结果应当有一次轻提示');

    // 等 toast 自己走掉（成功 toast 2.4s；再给一段退出动画）
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('已交给系统程序'), findsNothing, reason: '不许永久停留在顶栏上');
  });
}
