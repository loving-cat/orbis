import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/streaming_markdown_view.dart';

/// 流式输出期间也要能拖选复制。
///
/// ## 现场
///
/// 气泡还没写完时正文不可选中（`StreamingMarkdownView` 的两条流式分支都写死了
/// `selectable: false`）—— 用户想把「已经出来的半截结论」贴给同事，拖不动，
/// 只能等它写完整条消息。而流式恰恰是最想"先看一半"的时候。
///
/// 修法：把 `selectable` 做成参数（默认 true）并透传给 `MdText`；
/// 分页/光标那些节流逻辑保持不变。`selectable: false` 仍可显式关掉（例如极窄屏）。
void main() {
  setUp(() {
    // 关掉节流，让测试直接走"整段渲染"的分支（两条分支都已透传 selectable）
    StreamingMarkdownView.pacingEnabled = false;
  });

  Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

  testWidgets('流式中：正文可选中（MdText 走 SelectionArea），光标仍在', (tester) async {
    await tester.pumpWidget(wrap(
      const StreamingMarkdownView('这是一段还没写完的结论，先选一半试试', streaming: true),
    ));
    await tester.pump();

    expect(find.byType(SelectionArea), findsOneWidget,
        reason: '流式期间必须可拖选（用户要能把半截结论复制出去）');
    expect(find.textContaining('还没写完'), findsWidgets);
  });

  testWidgets('写完后同样可选中（回归：别只修流式那一半）', (tester) async {
    await tester.pumpWidget(wrap(
      const StreamingMarkdownView('已经写完了的结论', streaming: false),
    ));
    await tester.pump();
    expect(find.byType(SelectionArea), findsOneWidget);
  });

  testWidgets('显式 selectable: false 仍然能关掉选择', (tester) async {
    await tester.pumpWidget(wrap(
      const StreamingMarkdownView('不要选我', streaming: true, selectable: false),
    ));
    await tester.pump();
    expect(find.byType(SelectionArea), findsNothing);
  });
}
