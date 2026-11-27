import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/md_text.dart';

/// 收集 RichText 里所有带背景色的 span（行内代码就是靠 style.backgroundColor 上色的）。
List<TextSpan> _bgSpans(WidgetTester tester) {
  final out = <TextSpan>[];
  void walk(InlineSpan span) {
    if (span is TextSpan) {
      if (span.style?.backgroundColor != null) out.add(span);
      for (final child in span.children ?? const <InlineSpan>[]) {
        walk(child);
      }
    }
  }

  for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
    walk(rich.text);
  }
  return out;
}

void main() {
  testWidgets('★ 整条消息只有一个 SelectionArea（跨段拖选 + ⌘C 复制）', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: MdText(
            '第一段内容\n\n第二段内容\n\n- 列表一\n- 列表二\n\n| A | B |\n| - | - |\n| 1 | 2 |',
          ),
        ),
      ),
    );
    await tester.pump();

    // 每个段落/列表项/表格单元格各一个 SelectionArea 会让选中断成多截。
    expect(find.byType(SelectionArea), findsOneWidget);
  });

  testWidgets('★ 行内代码底色必须半透明：否则拖选蓝色高亮被整块盖死（深/浅两套）', (tester) async {
    // Flutter 的 RenderParagraph 绘制顺序是「选区高亮 → TextStyle 背景 → 文字」，
    // 行内代码如果用不透明实色底（原来的 PB.bgActive），跨过它的选区就看不见了。
    final before = pbColorMode.value;
    addTearDown(() => pbColorMode.value = before);

    for (final mode in [PBColorMode.dark, PBColorMode.light]) {
      pbColorMode.value = mode;
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: MdText('前面 `inline code` 后面')),
        ),
      );
      await tester.pump();

      final codes = _bgSpans(tester);
      expect(codes, isNotEmpty, reason: '$mode：行内代码应当有自己的底色（否则完全看不出是代码）');
      for (final span in codes) {
        final bg = span.style!.backgroundColor!;
        expect(bg.a, lessThan(1.0), reason: '$mode：行内代码底色必须是半透明，才能让选区透出来');
        expect(bg.a, greaterThan(0.0), reason: '$mode：也不能透明到看不见');
      }

      // 顺带钉住深浅两套色值本身（改动时能立刻看到差异）
      expect(PB.bgInlineCode.a, lessThan(1.0));
    }
  });
}
