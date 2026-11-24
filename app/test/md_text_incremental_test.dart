// 流式增量解析的属性测试（SPEC-PERF-V1 §7.3）。
//
// 核心不变量：
//
//     parse(full) == stableBlocks + parse(tail)
//
// 只要切点落在「围栏外、且是连续空行之后」。这里用随机文本 + 随机切点反复验证：
// 一旦切点落进半块（比如把末尾单个换行当空行、或无视围栏），增量结果就会和
// 整段解析对不上 —— 那正是界面上"流式时表格突然散架"的成因。
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/md_text.dart';

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
        out.add(('- 要点$i ${emoji[rnd.nextInt(emoji.length)]}\n- 第二条 $i\n- 第三条'));
        break;
      case 2:
        out.add('> 引用 $i\n> 第二行');
        break;
      case 3:
        out.add('| 列A | 列B |\n| --- | --- |\n| $i | 值$i |');
        break;
      case 4:
        // 围栏里故意放空行：它**不是**块边界
        out.add('```dart\nfinal a$i = $i;\n\nprint(a$i);\n```');
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
  return out.join(rnd.nextBool() ? '\n\n' : '\n');
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
  test('属性：随机文本 + 随机切点，增量解析与整段解析逐块相等', () {
    final rnd = Random(20261124);
    for (var round = 0; round < 60; round += 1) {
      final doc = _randomDoc(rnd, blocks: 1 + rnd.nextInt(8));
      final chunks = _chunks(doc, rnd);
      final incremental = debugBlocksSignature(debugParseIncremental(chunks));
      final full = debugBlocksSignature(debugParseFull(doc));
      expect(incremental, full, reason: '第 $round 轮不一致；chunks=${chunks.length}\n$doc');
    }
  });

  test('前缀成立时只解析尾巴（结果不变）', () {
    const base = '# 标题\n\n第一段\n\n';
    final tail = '```js\nlet x = 1;\n\nlet y = 2;\n```';
    final inc = debugBlocksSignature(debugParseIncremental([base + tail]));
    final full = debugBlocksSignature(debugParseFull(base + tail));
    expect(inc, full);
  });

  test('末尾单个换行不算稳定边界（下一行还会续写）', () {
    // 只到 "| 列A |" 这一行时，表格还没成形；切点若停在它后面的换行，
    // 增量解析会把半行缓存成块，后续追加就对不上。
    final steps = ['| 列A |', ' 列B |', '\n', '| --- | --- |\n', '| 1 | 2 |\n'];
    final inc = debugBlocksSignature(debugParseIncremental(steps));
    final full = debugBlocksSignature(debugParseFull(steps.join()));
    expect(inc, full);
  });

  test('围栏里的空行不是块边界', () {
    final steps = ['```\n', 'a\n', '\n', 'b\n', '```\n', '之后\n'];
    final inc = debugBlocksSignature(debugParseIncremental(steps));
    final full = debugBlocksSignature(debugParseFull(steps.join()));
    expect(inc, full);
  });

  test('编辑（前缀不成立）时回退整段解析', () {
    final first = '# 标题\n\n第一段\n';
    final edited = '# 标题\n\n第一段改了\n';
    debugParseIncremental([first]); // 先喂一版
    final inc = debugBlocksSignature(debugParseIncremental([edited]));
    final full = debugBlocksSignature(debugParseFull(edited));
    expect(inc, full, reason: '不是前缀关系时必须整段重来');
  });

  test('emoji 代理对切在中间也不炸', () {
    final text = '🙂🚀👍🏽 中文混合 emoji 👨‍👩‍👧 结束';
    final chunks = <String>[];
    for (final unit in text.split('')) {
      chunks.add(unit);
    }
    // 按 UTF-16 逐个码元切会切开代理对：解析器不该抛异常
    expect(() => debugParseIncremental(chunks), returnsNormally);
    final inc = debugBlocksSignature(debugParseIncremental(chunks));
    final full = debugBlocksSignature(debugParseFull(text));
    expect(inc, full);
  });
}
