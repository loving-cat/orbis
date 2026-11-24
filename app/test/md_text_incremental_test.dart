// 流式增量解析 + 稳定块复用的回归测试（SPEC-PERF-V1 §7.2 / §7.3）。
//
// 两条不变量：
//
//     parse(full) == stableBlocks + parse(tail)      （切点只在围栏外空行后）
//     stableCount 个块的 Widget 实例跨帧 identical    （流式追加不重建前缀）
//
// 一旦切点落进半块（把末尾单个换行当空行、或无视围栏嵌套），增量结果就会和整段
// 解析对不上 —— 那正是界面上"流式时表格突然散架"的成因。
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/md_text.dart';

final _nl = String.fromCharCode(10);

/// 生成一段"像消息"的 Markdown：标题、列表、引用、表格、围栏、CJK、emoji。
String _randomDoc(Random rnd, {int blocks = 6}) {
  final out = <String>[];
  const emoji = ['🙂', '🚀', '🧪', '👍🏽', '👨‍👩‍👧'];
  for (var i = 0; i < blocks; i += 1) {
    switch (rnd.nextInt(7)) {
      case 0:
        out.add('${'#' * (1 + rnd.nextInt(3))} 标题$i');
        break;
      case 1:
        out.add('- 要点$i ${emoji[rnd.nextInt(emoji.length)]}$_nl- 第二条 $i$_nl- 第三条');
        break;
      case 2:
        out.add('> 引用 $i$_nl> 第二行');
        break;
      case 3:
        out.add('| 列A | 列B |$_nl| --- | --- |$_nl| $i | 值$i |');
        break;
      case 4:
        // 围栏里故意放空行：它**不是**块边界
        out.add(<String>['```dart', 'final a$i = $i;', '', 'print(a$i);', '```'].join(_nl));
        break;
      case 5:
        out.add('段落 $i：中文、emoji ${emoji[rnd.nextInt(emoji.length)]}、'
            '`inline code`、**加粗**、[链接](https://example.com/$i)');
        break;
      default:
        out.add('单行 $i');
        break;
    }
  }
  return out.join(rnd.nextBool() ? '$_nl$_nl' : _nl);
}

/// 在随机位置切成若干段（模拟流式吐字）。
List<String> _chunks(String text, Random rnd) {
  final chunks = <String>[];
  var i = 0;
  while (i < text.length) {
    final step = 1 + rnd.nextInt(max(1, text.length ~/ 8));
    final end = min(text.length, i + step);
    chunks.add(text.substring(i, end));
    i = end;
  }
  return chunks;
}

void main() {
  // ---- 解析层 ----
  test('属性：随机文本 + 随机切点，增量解析与整段解析逐块相等', () {
    final rnd = Random(20261124);
    for (var round = 0; round < 60; round += 1) {
      final doc = _randomDoc(rnd, blocks: 1 + rnd.nextInt(8));
      final chunks = _chunks(doc, rnd);
      final incremental = debugBlocksSignature(debugParseIncremental(chunks));
      final full = debugBlocksSignature(debugParseFull(doc));
      expect(incremental, full, reason: '第 $round 轮不一致；chunks=${chunks.length}');
    }
  });

  test('前缀成立时只解析尾巴（结果不变）', () {
    final base = '# 标题$_nl$_nl第一段$_nl$_nl';
    final tail = <String>['```js', 'let x = 1;', '', 'let y = 2;', '```'].join(_nl);
    final inc = debugBlocksSignature(debugParseIncremental([base + tail]));
    final full = debugBlocksSignature(debugParseFull(base + tail));
    expect(inc, full);
  });

  test('末尾单个换行不算稳定边界（下一行还会续写）', () {
    final steps = ['| 列A |', ' 列B |', _nl, '| --- | --- |$_nl', '| 1 | 2 |$_nl'];
    final inc = debugBlocksSignature(debugParseIncremental(steps));
    final full = debugBlocksSignature(debugParseFull(steps.join()));
    expect(inc, full);
  });

  test('围栏里的空行不是块边界', () {
    final steps = ['```$_nl', 'a$_nl', _nl, 'b$_nl', '```$_nl', '之后$_nl'];
    final inc = debugBlocksSignature(debugParseIncremental(steps));
    final full = debugBlocksSignature(debugParseFull(steps.join()));
    expect(inc, full);
  });

  test('围栏里嵌套围栏 + 空行：增量与整段解析一致', () {
    // 外层 markdown 围栏里再写一段 python：开关判定必须与 _parse 一致，
    // 否则外层被内层提前关掉，后面的空行被当成块边界 → 切在半个块中间。
    final steps = [
      '```markdown$_nl',
      '# 示例$_nl',
      '```python$_nl',
      'print(1)$_nl',
      '```$_nl',
      _nl,
      '正文继续$_nl',
      '```$_nl',
      '收尾$_nl',
    ];
    final inc = debugBlocksSignature(debugParseIncremental(steps));
    final full = debugBlocksSignature(debugParseFull(steps.join()));
    expect(inc, full);
  });

  test('编辑（前缀不成立）时回退整段解析', () {
    final first = '# 标题$_nl$_nl第一段$_nl';
    final edited = '# 标题$_nl$_nl第一段改了$_nl';
    debugParseIncremental([first]);
    final inc = debugBlocksSignature(debugParseIncremental([edited]));
    final full = debugBlocksSignature(debugParseFull(edited));
    expect(inc, full);
  });

  test('emoji 代理对切在中间也不炸', () {
    final text = '🙂🚀👍🏽 中文混合 emoji 👨‍👩‍👧 结束';
    final chunks = text.split('');
    expect(() => debugParseIncremental(chunks), returnsNormally);
    final inc = debugBlocksSignature(debugParseIncremental(chunks));
    final full = debugBlocksSignature(debugParseFull(text));
    expect(inc, full);
  });

  // ---- Widget 层（§7.2 第 2 条：稳定块复用 + 配置变化失效） ----

  Future<List<Text>> pumpMd(
    WidgetTester tester,
    String text, {
    bool selectable = false,
    double scale = 1.0,
  }) async {
    await tester.pumpWidget(MaterialApp(
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: SingleChildScrollView(child: MdText(text, selectable: selectable)),
        ),
      ),
    ));
    await tester.pump();
    return tester.widgetList<Text>(find.byType(Text)).toList();
  }

  testWidgets('流式追加时前面稳定块的 Widget 实例被复用（identical）', (tester) async {
    final first = '# 标题$_nl$_nl第一段$_nl$_nl正在写的第二段';
    final before = await pumpMd(tester, first);
    final after = await pumpMd(tester, '$first，又多了几个字');
    expect(after.length >= 2, true);
    expect(identical(before[0], after[0]), true, reason: '标题块应复用同一个 Widget 实例');
    expect(identical(before[1], after[1]), true, reason: '第一段应复用同一个 Widget 实例');
  });

  testWidgets('selectable 由 false 切 true：缓存失效并换成可选中渲染', (tester) async {
    final text = '# 标题$_nl$_nl第一段';
    final before = await pumpMd(tester, text);
    expect(find.byType(SelectionArea), findsNothing);

    final after = await pumpMd(tester, text, selectable: true);
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(identical(before[0], after[0]), false, reason: '换了渲染树，块缓存必须整体失效');
  });

  testWidgets('系统字号变化时缓存同样失效', (tester) async {
    final text = '# 标题$_nl$_nl第一段';
    final before = await pumpMd(tester, text);
    final after = await pumpMd(tester, text, scale: 1.5);
    expect(identical(before[0], after[0]), false, reason: 'textScaler 变了必须重建');
  });
}
