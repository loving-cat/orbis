import 'dart:math' as math;

import 'package:flutter/gestures.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../highlight.dart';
import '../l10n/l10n.dart';
import '../markdown_inline.dart';
import '../theme.dart';
import 'toast.dart';
import 'blob_avatar.dart';
import 'md_quote.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Markdown 渲染（面向 agent 输出，流式友好）。
///
/// 支持：标题、有序/无序列表、引用、分割线、GFM 表格、围栏代码块（带语言标签+复制）、
/// 行内 code / 粗体 / 斜体 / 删除线 / 链接。
/// 流式输出时未闭合的 ``` 也能正常渲染。
class MdText extends StatefulWidget {
  const MdText(
    this.text, {
    super.key,
    this.style,
    this.mono,
    this.selectable = true,
    this.compact = false,
    this.mentions = const [],
    this.onMentionTap,
    this.onLinkTap,
    this.linkColor,
    this.mentionOf,
    this.streamingCursorColor,
    this.streamingCursorPulse,
  });

  final String text;
  final TextStyle? style;
  final TextStyle? mono;
  final bool selectable;
  final bool compact;

  /// 气泡背景上的链接颜色；省略时使用当前主题，引用内使用主题链接色。
  final Color? linkColor;

  /// 流式输出尾标颜色（非 null 时不拼接进原始 Markdown 字符串，直接画在末块末尾）。
  final Color? streamingCursorColor;

  /// 光标闪烁动画：只驱动末尾那个 `▍`，**不**触发 [MdText] 重建。
  final Animation<double>? streamingCursorPulse;

  /// 要高亮的名字（不含 @）—— 部门成员。agent 之间用 @ 派活，高亮后一眼看得出谁被点名了。
  final List<String> mentions;

  /// 点 @提及 时回调（参数是去掉 @ 和 emoji 的纯名字）。
  /// 传了就把提及变成可点链接（跳到那个 bot 的私聊），不传则只是高亮。
  final void Function(String name)? onMentionTap;

  /// 点普通链接时回调（参数是原始 url）。
  ///
  /// 不传就维持原行为：交给系统浏览器。传了的话由调用方决定去哪 ——
  /// 首页把它接到右侧内置浏览器栏（用户定的：链接全部走内置）。
  final void Function(String url)? onLinkTap;

  /// 把 @ 的名字映射成 chip 要用的信息（种子 + 一句话简介）。
  /// 传了的话，鼠标悬在 @ 上会浮出一张小卡。
  final MentionInfo? Function(String name)? mentionOf;

  @override
  State<MdText> createState() => _MdTextState();
}

class _MdTextState extends State<MdText> {
  final Map<String, TapGestureRecognizerHandle> _links = {};

  // ★ 解析结果按文本缓存，供**历史气泡**整屏重建时复用。
  //
  //   每次 build 都跑一遍 _parse(widget.text) 是纯重复劳动：
  //   历史消息的文本永远不变，而整屏重建（别的房间来消息、切换面板宽度
  //   等等）会让所有可见气泡重新解析一遍 Markdown。
  //
  //   ★ 对正在流式输出那条几乎无收益：文本每帧都变，缓存永远不命中，
  //     每帧仍是 O(L) 解析。那条的开销靠"只让它单独刷新"来控制
  //     （见 chat_screen 里流式气泡的 ValueListenableBuilder），
  //     这里只负责把历史气泡的重复解析消掉。
  //
  //   ★ 缓存失效只认「文本是否变化」这一个条件（在 _blocksFor 里比）。
  //     不额外挂 didUpdateWidget 做主动清空 —— 那是同一判据的重复实现，
  //     两处同时存在反而要求以后改判据时必须同步改两次。
  //     不做更细的脏检查是因为：Markdown 的渲染还取决于 style/mono 等参数，
  //     但那些变化会重建 State 或由父级重新布局，块结构本身只由文本决定。
  String? _parsedFor;
  List<_Block> _blocksCache = const [];

  /// 流式增量解析的游标（SPEC-PERF-V1 §7.2 第 1 条）。
  final _IncrementalMarkdown _incremental = _IncrementalMarkdown();

  /// 已闭合稳定块的 Widget 缓存（§7.2 第 2 条）。
  ///
  /// 流式追加时只有**最后一块**在变，前面的块每帧重建纯属浪费：
  /// 那就是"帧开销随消息长度线性增长"的来源。
  List<Widget> _stableWidgets = const [];
  String _widgetKey = '';

  List<_Block> _blocksFor(String text) {
    if (text != _parsedFor) {
      _blocksCache = _incremental.blocksFor(text);
      _parsedFor = text;
    }
    return _blocksCache;
  }

  /// 影响块渲染外观的全部输入 —— 任一变化都必须让块缓存整体失效。
  String _widgetCacheKey(BuildContext context, TextStyle base, TextStyle code, int generation) {
    final colors = PB.colors(context);
    return [
      base.hashCode,
      code.hashCode,
      widget.mono.hashCode,
      widget.linkColor?.toARGB32() ?? 0,
      // ★ 用**值签名**而不是 `mentions.hashCode`：父级每帧传一个新的字面量列表
      //   （内容一样、对象不同）时，引用哈希每次都变 → 缓存每帧失效、退化成全量重建。
      widget.mentions.join(String.fromCharCode(0)),
      widget.compact ? 1 : 0,
      // 前缀重置（编辑/回滚）也必须让缓存整体失效
      generation,
      colors.accent.toARGB32(),
      Theme.of(context).brightness.index,
      // 流式结束 false→true：可选中渲染是**另一棵树**，必须失效
      widget.selectable ? 1 : 0,
      // 系统字号/缩放变了同样要重建，否则字号不跟系统走
      MediaQuery.textScalerOf(context).scale(100),
    ].join('|');
  }

  @override
  void dispose() {
    for (final h in _links.values) {
      h.dispose();
    }
    super.dispose();
  }

  TapGestureRecognizerHandle _recognizer(String url) {
    final handler = widget.onLinkTap;
    if (handler != null) {
      return _links.putIfAbsent(
        'link:$url',
        () => TapGestureRecognizerHandle.custom(() => handler(url)),
      );
    }
    return _links.putIfAbsent(url, () => TapGestureRecognizerHandle(url));
  }

  /// 网址的"点一下复制"识别器。
  ///
  /// 行内代码里的 localhost 地址（http://127.0.0.1:8765/ 这种）点开也没用，
  /// 目的是把地址拿走 —— 点一下直接复制，比先拖选再 ⌘C 快得多。
  TapGestureRecognizerHandle _copyUrlRecognizer(String url) {
    return _links.putIfAbsent(
      'copy:$url',
      () => TapGestureRecognizerHandle.custom(() {
        Clipboard.setData(ClipboardData(text: url));
        toast(context, L10n.s(context).t('copy.link'));
      }),
    );
  }

  TapGestureRecognizerHandle _copyEmailRecognizer(String email) {
    return _links.putIfAbsent(
      'email:$email',
      () => TapGestureRecognizerHandle.custom(() async {
        try {
          await Clipboard.setData(ClipboardData(text: email));
          if (mounted)
            toast(
              context,
              L10n.s(context).t('copy.email'),
              kind: ToastKind.success,
            );
        } catch (_) {
          if (mounted)
            toast(
              context,
              L10n.s(context).t('copy.failed'),
              kind: ToastKind.error,
            );
        }
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final base = widget.style ?? theme.textTheme.bodyMedium!;
    final code =
        widget.mono ??
        base.copyWith(
          fontFamily: PB.monoFamily,
          fontFamilyFallback: PB.monoFallback,
          fontSize: (base.fontSize ?? 14) - 1,
          height: 1.45,
          color: PB.textPrimary,
        );

    final blocks = _blocksFor(widget.text);
    final cursorColor = widget.streamingCursorColor;
    // ★ 缓存键必须把所有影响**渲染外观**的东西都算进来，少一个就会
    //   在"开了选中复制 / 系统改了字号 / 换主题"之后复用一批旧配置画出来的 widget：
    //   表现是选中不了、字号不跟系统走，而且不报错。
    // ★ 前缀重置（编辑/回滚/换条）时必须整体失效：块结构可能完全不同，
    //   复用旧消息的 widget 会在界面上残留上一版正文。
    final generation = _incremental.generation;
    final key = _widgetCacheKey(context, base, code, generation);
    final stableCount = _incremental.stableCount.clamp(0, blocks.length);
    // ★ 带光标的末块**永不进缓存**：它每帧都在变（追加字 / 光标动画），
    //   缓存它会把光标字符固化进正文（空白尾再追加内容的场景尤其明显）。

    final stableLimit = cursorColor != null
        ? math.min(stableCount, math.max(0, blocks.length - 1))
        : stableCount;
    if (key != _widgetKey) {
      _stableWidgets = const [];
      _widgetKey = key;
    }
    final children = <Widget>[];
    if (blocks.isEmpty && cursorColor != null) {
      children.add(_StreamingCursor(
        color: cursorColor,
        style: base,
        pulse: widget.streamingCursorPulse,
      ));
    } else {
      // 已缓存的稳定块：实例直接复用（Flutter 会跳过完全相同的 widget 子树）
      final reuse = math.min(stableLimit, _stableWidgets.length);
      for (var i = 0; i < reuse; i += 1) {
        children.add(_stableWidgets[i]);
      }
      final nextStable = <Widget>[..._stableWidgets.take(reuse)];
      for (var i = children.length; i < blocks.length; i += 1) {
        final w = _renderBlock(
          context,
          blocks[i],
          base,
          code,
          cursorColor: i == blocks.length - 1 ? cursorColor : null,
          cursorPulse: i == blocks.length - 1 ? widget.streamingCursorPulse : null,
        );
        children.add(w);
        // ★ 必须**追加**到已有缓存，不能整体替换：一次新闭合 2 段以上时，
        //   替换会把已经在缓存里的前几段丢掉 —— 界面上表现为第 1 段凭空消失、
        //   后面的段落前移并重复渲染。
        if (i < stableLimit) nextStable.add(w);
      }
      if (nextStable.length != _stableWidgets.length || nextStable.isNotEmpty) {
        _stableWidgets = nextStable;
      }
    }

    final body = children.length == 1
        ? children.first
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < children.length; i++)
                Padding(
                  // ★ 块之间的呼吸：8 → 14。
                  //   消息里通常是"一句话 + 列表 + 一句话"这种结构，块挤在一起
                  //   读起来像一堵墙；拉开之后每一块才是独立的一段。
                  //   compact 的那档也跟着放宽（4 → 8），但保持明显更紧。
                  padding: EdgeInsets.only(
                    top: i == 0 ? 0 : (widget.compact ? 8 : 14),
                  ),
                  child: children[i],
                ),
            ],
          );
    if (!widget.selectable) return body;
    // ★ 整个消息**只有一个** SelectionArea。
    //
    //   每个段落/列表项/表格单元格各自一个 SelectionArea 时，拖动选择
    //   跨行会各选各的，复制出来断成一截一截。收成一个之后，
    //   整条消息可以一次拖选、⌘C/Ctrl+C 复制。
    return SelectionArea(child: body);
  }

  Widget _renderBlock(
    BuildContext context,
    _Block block,
    TextStyle base,
    TextStyle code, {
    Color? cursorColor,
    Animation<double>? cursorPulse,
  }) {
    switch (block) {
      case _Heading(:final level, :final text):
        final size = switch (level) {
          1 => PB.fsXxl - 2,
          2 => PB.fsXl,
          3 => PB.fsLg + 1,
          _ => PB.fsBase + 0.5,
        };
        return Padding(
          padding: EdgeInsets.only(top: level <= 2 ? 6 : 3, bottom: 1),
          child: _rich(
            text,
            base.copyWith(
              fontSize: size,
              fontWeight: FontWeight.w600,
              height: 1.35,
            ),
            code,
            cursorColor: cursorColor,
          ),
        );

      case _Hr():
        final line = Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Container(height: 1, color: PB.borderTertiary),
        );
        if (cursorColor == null) return line;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            line,
            _StreamingCursor(color: cursorColor, style: base, pulse: cursorPulse),
          ],
        );

      case _Code(:final language, :final code_):
        return _CodeBlock(
          language: language,
          code: code_,
          style: code,
          cursorColor: cursorColor,
          cursorPulse: cursorPulse,
        );

      case _Quote(:final text):
        return MarkdownQuote(
          text: markdownInlineText(text, mentions: widget.mentions),
          child: _rich(
            text,
            base.copyWith(color: PB.colors(context).quoteText, height: 1.6),
            code,
            quote: true,
            cursorColor: cursorColor,
          ),
        );

      case _ListBlock(:final items):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < items.length; i++)
              Padding(
                padding: EdgeInsets.only(
                  left: items[i].indent * 16.0,
                  top: 2,
                  bottom: 2,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: items[i].ordered ? 22 : 16,
                      child: Text(
                        items[i].ordered ? items[i].marker : '•',
                        style: base.copyWith(
                          color: PB.textTertiary,
                          height: 1.5,
                        ),
                      ),
                    ),
                    Expanded(
                      child: _rich(
                        items[i].text,
                        base,
                        code,
                        cursorColor:
                            i == items.length - 1 ? cursorColor : null,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );

      case _Table(:final header, :final rows):
        final table = _TableView(
          header: header,
          rows: rows,
          base: base,
          renderInline: _rich,
        );
        if (cursorColor == null) return table;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            table,
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: _StreamingCursor(color: cursorColor, style: base, pulse: cursorPulse),
            ),
          ],
        );

      case _Para(:final text):
        return _rich(text, base, code, cursorColor: cursorColor, cursorPulse: cursorPulse);
    }
  }

  Widget _rich(
    String source,
    TextStyle base,
    TextStyle code, {
    bool quote = false,
    Color? cursorColor,
    Animation<double>? cursorPulse,
  }) {
    final spans = _inline(
      source,
      base,
      code,
      linkColor: quote ? PB.colors(context).link : widget.linkColor,
    );
    if (cursorColor != null) {
      // ★ 用 WidgetSpan 而不是 TextSpan：光标是**独立小部件**，
      //   闪烁动画只重绘它自己（不带 baseline 对齐会改变行高/换行行为，
      //   所以 alignment/baseline 显式给上，语义与原来的文字光标一致）。
      spans.add(WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: _StreamingCursor(color: cursorColor, style: base, pulse: cursorPulse),
      ));
    }
    // 选中交给最外层那一个 SelectionArea（见 build），这里只画文本。
    // 不用 SelectableText.rich：它不支持 WidgetSpan，而 @提及 要画头像 chip。
    return Text.rich(TextSpan(children: spans, style: base));
  }

  List<InlineSpan> _inline(
    String source,
    TextStyle base,
    TextStyle code, {
    Color? linkColor,
  }) {
    final spans = <InlineSpan>[];
    final colors = PB.colors(context);
    for (final token in markdownInlineTokens(
      source,
      mentions: widget.mentions,
    )) {
      switch (token.kind) {
        case MarkdownInlineKind.plain:
          spans.add(TextSpan(text: token.text));
        case MarkdownInlineKind.code:
          spans.add(
            TextSpan(
              text: token.text,
              // ★ 半透明：不透明底会盖掉选区高亮（见 PB.bgInlineCode 的注释）
              style: code.copyWith(backgroundColor: PB.bgInlineCode),
              recognizer: RegExp(r'^https?://').hasMatch(token.text)
                  ? _copyUrlRecognizer(token.text).value
                  : null,
            ),
          );
        case MarkdownInlineKind.strong:
        case MarkdownInlineKind.strike:
        case MarkdownInlineKind.emphasis:
          final style = switch (token.kind) {
            MarkdownInlineKind.strong => base.copyWith(
              fontWeight: FontWeight.w700,
            ),
            MarkdownInlineKind.strike => base.copyWith(
              decoration: TextDecoration.lineThrough,
              color: PB.textTertiary,
            ),
            _ => base.copyWith(fontStyle: FontStyle.italic),
          };
          spans.add(
            TextSpan(
              style: style,
              children: _inline(token.text, style, code, linkColor: linkColor),
            ),
          );
        case MarkdownInlineKind.link:
          spans.add(
            TextSpan(
              text: token.text,
              style: base.copyWith(
                color: linkColor ?? colors.link,
                decoration: TextDecoration.underline,
              ),
              recognizer: _recognizer(token.target!).value,
            ),
          );
        case MarkdownInlineKind.url:
        case MarkdownInlineKind.email:
          spans.add(
            TextSpan(
              text: token.text,
              style: base.copyWith(color: linkColor ?? colors.link),
              recognizer: token.kind == MarkdownInlineKind.email
                  ? _copyEmailRecognizer(token.text).value
                  : _copyUrlRecognizer(token.text).value,
            ),
          );
        case MarkdownInlineKind.mention:
          final onTap = widget.onMentionTap;
          spans.add(
            WidgetSpan(
              alignment: PlaceholderAlignment.middle,
              child: _MentionChip(
                name: token.text,
                info: widget.mentionOf?.call(token.text),
                onTap: onTap == null ? null : () => onTap(token.text),
              ),
            ),
          );
      }
    }
    return spans;
  }
}

/// 链接点击：包一层，避免在 build 里到处 new recognizer
/// 点击手势的封装：把 recognizer 的创建/释放收在一起，
/// 避免在 build 里到处 new（每次 rebuild 都 new 一个不释放 = 内存泄漏）。
class TapGestureRecognizerHandle {
  /// 打开外部链接（失败就复制到剪贴板）
  TapGestureRecognizerHandle(String url)
    : value = (TapGestureRecognizer()
        ..onTap = () async {
          final uri = Uri.tryParse(url);
          if (uri == null) return;
          try {
            await launchUrl(uri, mode: LaunchMode.externalApplication);
          } catch (_) {
            await Clipboard.setData(ClipboardData(text: url));
          }
        });

  /// 任意回调（@提及 跳私聊、点引用气泡等都用这个）
  TapGestureRecognizerHandle.custom(VoidCallback onTap)
    : value = (TapGestureRecognizer()..onTap = onTap);

  final TapGestureRecognizer value;

  void dispose() => value.dispose();
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

sealed class _Block {
  const _Block();
}

class _Heading extends _Block {
  const _Heading(this.level, this.text);
  final int level;
  final String text;
}

class _Para extends _Block {
  const _Para(this.text);
  final String text;
}

class _Code extends _Block {
  const _Code(this.language, this.code_, this.closed);
  final String language;
  final String code_;
  final bool closed;
}

class _Hr extends _Block {
  const _Hr();
}

class _Quote extends _Block {
  const _Quote(this.text);
  final String text;
}

class _ListItem {
  const _ListItem(this.indent, this.marker, this.text, this.ordered);
  final int indent;
  final String marker;
  final String text;
  final bool ordered;
}

class _ListBlock extends _Block {
  const _ListBlock(this.items);
  final List<_ListItem> items;
}

class _Table extends _Block {
  const _Table(this.header, this.rows);
  final List<String> header;
  final List<List<String>> rows;
}

final _fence = RegExp(r'^\s*```(.*)$');
final _fenceEnd = RegExp(r'^\s*```\s*$');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _hr = RegExp(r'^\s*(-{3,}|\*{3,}|_{3,})\s*$');
final _quote = RegExp(r'^\s*>\s?');
final _listItem = RegExp(r'^(\s*)([-*+]|\d+[.)])\s+(.*)$');
final _tableSep = RegExp(r'^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$');

List<String> _splitRow(String line) {
  var s = line.trim();
  if (s.startsWith('|')) s = s.substring(1);
  if (s.endsWith('|')) s = s.substring(0, s.length - 1);
  return s.split('|').map((c) => c.trim()).toList();
}

/// 流式增量解析：只重解析「还没闭合」的尾巴。
///
/// ## 为什么可以这样切
///
/// `_parse` 是逐行分块的状态机，但它在**代码围栏之外的连续空行**处状态完全清空
/// （段落 flush、列表/引用/表格都已经收口）。所以对文本里的某个位置 offset：
///
/// ```
/// parse(full) == parse(full[0..offset]) + parse(full[offset..])
/// ```
///
/// 只要 offset 落在「围栏外、且是连续两个换行之后」。
///
/// ## 三条不能错的细节
///
/// 1. **末尾单个换行符不是空行**：`split` 之后会多出一个空尾串，
///    把它当空行就会把「下一行还没写完的围栏/表格」提前当成闭合 ——
///    offset 切在半个块中间，增量结果与整段解析对不上（属性测试守着这条）。
/// 2. **必须识别围栏**：代码围栏里的空行不是块边界。
/// 3. **前缀不成立就整段重来**（编辑、回滚、换条消息），不做"猜测式"修补。
class _IncrementalMarkdown {
  String _src = '';
  int _offset = 0;
  List<_Block> _stable = const [];

  /// 已闭合（不会再变）的块数 —— 块 Widget 缓存只对前缀这部分有效。
  int get stableCount => _stable.length;

  int _generation = 0;

  /// 前缀重置次数：每次「整段重来」+1，块 Widget 缓存据此整体失效。
  int get generation => _generation;

  List<_Block> blocksFor(String text) {
    // 不是「上一段的前缀」：编辑/回滚/换消息，整段重来
    if (!text.startsWith(_src)) {
      // 编辑 / 回滚 / 换条消息：块结构可能完全不同，缓存必须整体失效
      _generation += 1;
      _src = text;
      _offset = _stableStart(text);
      _stable = _parse(text.substring(0, _offset));
      return [..._stable, ..._parse(text.substring(_offset))];
    }
    // 前缀成立：只把新变成"稳定"的那一段追加进来（从旧 offset 起扫，O(tail)）
    final next = _stableStart(text, startFrom: _offset);
    if (next > _offset) {
      _stable = [..._stable, ..._parse(text.substring(_offset, next))];
      _offset = next;
    }
    _src = text;
    return [..._stable, ..._parse(text.substring(_offset))];
  }

  /// 最后一个「围栏外、连续空行之后」的位置。
  ///
  /// 只看 text 本身（不依赖增量状态），保证同一个文本永远得到同一个切点。
  static int _stableStart(String text, {int startFrom = 0}) {
    // ★ 从 startFrom 开始扫：前缀成立时不再每帧从 0 扫全篇（那和整段解析一样贵）。
    //   startFrom 永远是"围栏外的稳定边界"，所以这里可以从 inFence=false 起算。
    var from = startFrom < 0 ? 0 : (startFrom > text.length ? text.length : startFrom);
    var inFence = false;
    var offset = from;
    var lineStart = from;
    for (var i = from; i < text.length; i += 1) {
      if (text.codeUnitAt(i) != 0x0A) continue;
      final line = text.substring(lineStart, i);
      // ★ 围栏的开/关必须与 `_parse` 逐字对齐：
      //   _parse 先试开围栏（`_fence`），只有已在一段围栏里才试关（`_fenceEnd`）。
      //   原来这里用 `inFence = !inFence` 一刀切，遇到 ``` 与 ``` 混排、
      //   或者围栏行里带语言标注时会算出与解析器不同的状态。
      if (!inFence && _fence.hasMatch(line)) {
        inFence = true;
      } else if (inFence && _fenceEnd.hasMatch(line)) {
        inFence = false;
      } else if (!inFence && line.trim().isEmpty && i + 1 < text.length) {
        // 真空行、且后面还有内容：前面的块才闭合。
        // 「末尾单个换行」产生的空尾串后面没有内容，绝不能当边界。
        offset = i + 1;
      }
      lineStart = i + 1;
    }
    return offset;
  }
}

/// 测试入口：把块结构压成一个确定性的字符串（属性测试拿它逐块对拍）。
///
/// 用「类型 + 关键内容」而不是 `toString()`：块类型都是私有类，默认 toString
/// 只会打印实例地址，那样的「相等」什么也证明不了。
@visibleForTesting
// ignore: library_private_types_in_public_api
String debugBlocksSignature(List<_Block> blocks) {
  final parts = <String>[];
  for (final b in blocks) {
    switch (b) {
      case _Heading(:final level, :final text):
        parts.add('H$level:${text.length}:$text');
      case _Para(:final text):
        parts.add('P:${text.length}:$text');
      case _Code(:final language, :final code_, :final closed):
        // ★ 必须比内容，不只比长度：增量切错时长度可能正好相同（换行/空行互换），
        //   那样的"相等"会让属性测试放过一个真实回归。
        parts.add('C${closed ? '1' : '0'}:$language:${code_.length}:$code_');
      case _Hr():
        parts.add('HR');
      case _Quote(:final text):
        parts.add('Q:${text.length}:$text');
      case _ListBlock(:final items):
        parts.add('L:${items.map((i) => '${i.indent}/${i.marker}/${i.text}').join(',')}');
      case _Table(:final header, :final rows):
        parts.add('T:${header.join(',')}|${rows.map((r) => r.join(',')).join(';')}');
    }
  }
  return parts.join(String.fromCharCode(10));
}

/// 测试入口：走增量解析器（与 [MdText] 内部用的是同一个实现）。
@visibleForTesting
// ignore: library_private_types_in_public_api
List<_Block> debugParseIncremental(List<String> chunks) {
  final it = _IncrementalMarkdown();
  var text = '';
  var blocks = <_Block>[];
  for (final chunk in chunks) {
    text += chunk;
    blocks = it.blocksFor(text);
  }
  return blocks;
}

/// 测试入口：整段解析（对照用）。
@visibleForTesting
// ignore: library_private_types_in_public_api
List<_Block> debugParseFull(String src) => _parse(src);

List<_Block> _parse(String src) {
  final lines = src.split('\n');
  final blocks = <_Block>[];
  final para = <String>[];
  var i = 0;

  void flush() {
    if (para.isEmpty) return;
    blocks.add(_Para(para.join('\n')));
    para.clear();
  }

  while (i < lines.length) {
    final line = lines[i];

    final fence = _fence.firstMatch(line);
    if (fence != null) {
      flush();
      final language = fence.group(1)!.trim();
      final buf = <String>[];
      var closed = false;
      i++;
      while (i < lines.length) {
        if (_fenceEnd.hasMatch(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.add(lines[i]);
        i++;
      }
      blocks.add(_Code(language, buf.join('\n'), closed));
      continue;
    }

    final heading = _heading.firstMatch(line);
    if (heading != null) {
      flush();
      blocks.add(_Heading(heading.group(1)!.length, heading.group(2)!.trim()));
      i++;
      continue;
    }

    if (_hr.hasMatch(line)) {
      flush();
      blocks.add(const _Hr());
      i++;
      continue;
    }

    // GFM 表格：当前行有 |，下一行是分隔行
    if (line.contains('|') &&
        i + 1 < lines.length &&
        _tableSep.hasMatch(lines[i + 1])) {
      flush();
      final header = _splitRow(line);
      final rows = <List<String>>[];
      i += 2;
      while (i < lines.length &&
          lines[i].contains('|') &&
          lines[i].trim().isNotEmpty) {
        rows.add(_splitRow(lines[i]));
        i++;
      }
      blocks.add(_Table(header, rows));
      continue;
    }

    if (_quote.hasMatch(line)) {
      flush();
      final buf = <String>[];
      while (i < lines.length && _quote.hasMatch(lines[i])) {
        buf.add(lines[i].replaceFirst(_quote, ''));
        i++;
      }
      blocks.add(_Quote(buf.join('\n')));
      continue;
    }

    final item = _listItem.firstMatch(line);
    if (item != null) {
      flush();
      final items = <_ListItem>[];
      while (i < lines.length) {
        final m = _listItem.firstMatch(lines[i]);
        if (m == null) break;
        items.add(
          _ListItem(
            (m.group(1)!.length / 2).floor(),
            m.group(2)!,
            m.group(3)!,
            RegExp(r'\d').hasMatch(m.group(2)!),
          ),
        );
        i++;
      }
      blocks.add(_ListBlock(items));
      continue;
    }

    if (line.trim().isEmpty) {
      flush();
      i++;
      continue;
    }

    para.add(line);
    i++;
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// 代码块 / 表格
// ---------------------------------------------------------------------------

/// 语法着色的调色板。
///
/// 只用设计系统里已有的令牌（不另造颜色）—— 聊天窗口里代码块不该比正文更花。
/// 未知/纯文本不染色，交给基础样式（也就是"看起来没高亮"，但那是对的）。
TextStyle? _syntaxStyle(BuildContext context, TokKind kind, TextStyle base) {
  final colors = PB.colors(context);
  switch (kind) {
    case TokKind.keyword:
      return base.copyWith(color: colors.accent, fontWeight: FontWeight.w500);
    case TokKind.str:
      return base.copyWith(color: PB.success);
    case TokKind.comment:
      return base.copyWith(
        color: PB.textQuaternary,
        fontStyle: FontStyle.italic,
      );
    case TokKind.number:
      return base.copyWith(color: colors.accentBright);
    case TokKind.type:
      return base.copyWith(color: PB.textPrimary, fontWeight: FontWeight.w500);
    case TokKind.fn:
      return base.copyWith(color: colors.accentBright);
    case TokKind.punct:
    case TokKind.plain:
      return null;
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({
    required this.language,
    required this.code,
    required this.style,
    this.cursorColor,
    this.cursorPulse,
  });

  final String language;
  final String code;
  final TextStyle style;
  final Color? cursorColor;
  final Animation<double>? cursorPulse;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: PB.bgApp,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 6, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language.isEmpty ? 'code' : language,
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: PB.textQuaternary,
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                    ),
                  ),
                ),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    toast(
                      context,
                      L10n.s(context).t('copy.code'),
                      kind: ToastKind.success,
                    );
                  },
                  borderRadius: BorderRadius.circular(PB.rSm),
                  child: Padding(
                    padding: EdgeInsets.all(5),
                    child: Icon(
                      LucideIcons.copy,
                      size: 13,
                      color: PB.textQuaternary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              // 自己写的小分词器上色（见 lib/highlight.dart）：
              // 认不出的语言一律当纯文本，绝不猜。
              child: Text.rich(
                TextSpan(
                  children: [
                    for (final t in highlightCode(code.trimRight(), language))
                      TextSpan(
                        text: t.text,
                        style: _syntaxStyle(context, t.kind, style),
                      ),
                    if (cursorColor != null)
                      TextSpan(
                        text: '▍',
                        style: style.copyWith(color: cursorColor),
                      ),
                  ],
                ),
                style: style,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TableView extends StatelessWidget {
  const _TableView({
    required this.header,
    required this.rows,
    required this.base,
    required this.renderInline,
  });

  final List<String> header;
  final List<List<String>> rows;
  final TextStyle base;
  final Widget Function(String, TextStyle, TextStyle) renderInline;

  // ★ 表格内边距取 14 / 11：横向 10 / 纵向 7 时两行字几乎贴在一起，
  //   密表看不动。
  static const double _padH = 14;
  static const double _padV = 11;

  /// 单列能压到的最窄宽度（再窄就没法读了）
  static const double _minCol = 54;

  @override
  Widget build(BuildContext context) {
    // 列数按表头来；数据行多出来的空单元格直接丢掉，不要在右边留一空列
    var columns = header.length;
    for (final r in rows) {
      var n = r.length;
      while (n > 0 && r[n - 1].trim().isEmpty) {
        n--;
      }
      if (n > columns) columns = n;
    }
    if (columns == 0) return const SizedBox.shrink();

    final headStyle = base.copyWith(
      fontWeight: FontWeight.w600,
      fontSize: PB.fsXs,
    );
    final bodyStyle = base.copyWith(fontSize: PB.fsXs);

    // 先量出每列的“自然宽度”（取该列最长那格，不换行时的宽度）
    final natural = List<double>.filled(columns, _minCol);
    for (var c = 0; c < columns; c++) {
      for (var r = -1; r < rows.length; r++) {
        final t = r < 0
            ? (c < header.length ? header[c] : '')
            : (c < rows[r].length ? rows[r][c] : '');
        if (t.trim().isEmpty) continue;
        final tp = TextPainter(
          text: TextSpan(text: t, style: r < 0 ? headStyle : bodyStyle),
          textDirection: TextDirection.ltr,
          maxLines: 1,
        )..layout();
        final w = tp.width + _padH * 2;
        if (w > natural[c]) natural[c] = w;
      }
    }

    return LayoutBuilder(
      builder: (context, c) {
        final avail = c.maxWidth.isFinite ? c.maxWidth : 600.0;

        // 列太多（比如 6 列 x 84px），气泡里怎么分都读不了 → 才允许横向滚
        final minReadable = columns * 84.0;
        if (minReadable > avail) {
          final w = minReadable / columns;
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: minReadable,
              child: _build(
                columns,
                {for (var i = 0; i < columns; i++) i: FixedColumnWidth(w)},
                headStyle,
                bodyStyle,
              ),
            ),
          );
        }

        // ★ 弹性布局：按各列“自然宽度”的比例分配整个可用宽度。
        //   FlexColumnWidth 的总和永远等于可用宽度，所以表格一定撑满气泡；
        //   短列（“项”“序号”）按内容窄，长列（“方案”“说明”）拿到剩下的全部宽度。
        //   单列上限 55%：防止一列超长文本把别的列挤成一条缝。
        final cap = avail * 0.55;
        final flex = [
          for (final w in natural)
            w.clamp(_minCol, cap < _minCol ? _minCol : cap),
        ];
        return _build(
          columns,
          {for (var i = 0; i < columns; i++) i: FlexColumnWidth(flex[i])},
          headStyle,
          bodyStyle,
        );
      },
    );
  }

  Widget _build(
    int columns,
    Map<int, TableColumnWidth> widths,
    TextStyle headStyle,
    TextStyle bodyStyle,
  ) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        border: Border.all(color: PB.borderTertiary),
        borderRadius: BorderRadius.circular(PB.rLg),
      ),
      child: Table(
        columnWidths: widths,
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        border: TableBorder.symmetric(
          inside: BorderSide(color: PB.borderTertiary),
        ),
        children: [
          TableRow(
            decoration: BoxDecoration(
              color: PB.bgActive.withValues(alpha: 0.5),
            ),
            children: [
              for (var c = 0; c < columns; c++)
                _cell(c < header.length ? header[c] : '', headStyle),
            ],
          ),
          for (var r = 0; r < rows.length; r++)
            TableRow(
              decoration: r.isOdd
                  ? BoxDecoration(color: PB.bgActive.withValues(alpha: 0.22))
                  : null,
              children: [
                for (var c = 0; c < columns; c++)
                  _cell(c < rows[r].length ? rows[r][c] : '', bodyStyle),
              ],
            ),
        ],
      ),
    );
  }

  Widget _cell(String text, TextStyle style) {
    // 单元格也要走行内 markdown：模型很爱在单元格里写 **加粗** 和 `代码`
    return TableCell(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: _padH, vertical: _padV),
        child: text.trim().isEmpty
            ? const SizedBox(height: 22)
            : renderInline(
                text,
                style,
                style.copyWith(
                  fontFamily: PB.monoFamily,
                  fontFamilyFallback: PB.monoFallback,
                  fontSize: style.fontSize,
                ),
              ),
      ),
    );
  }
}

/// @ 提及 chip 要用的信息。
class MentionInfo {
  const MentionInfo({required this.seed, this.subtitle, this.emoji});

  /// 稳定种子（一般是 botId）—— 颜色按它算，保证和花名册/头像一致
  final String seed;

  /// 一句话简介（职位/在做什么），悬停卡里显示
  final String? subtitle;
  final String? emoji;
}

/// 回复气泡里的「@某人」—— 小头像 + 名字。
///
/// 比纯文字高亮多花不了几个像素，但一眼就能认出是谁；一串 @ 排在一起时差别很明显。
///
/// **只做一件事：点一下跳到那个人的私聊。**
/// 曾经在它上面挂过悬停信息卡，结果：
///   · 卡片浮出来挡住旁边正在读的字
///   · 鼠标移上去变手型，看着像"可以拖"
///   · 而它比点击只多了"提前看到一句话简介"这点信息 —— 不划算
/// 所以去掉了。要看他是谁，点进去就是了。
/// 流式光标：**独立小部件**，闪烁只重绘它自己（SPEC-PERF-V1 §7.2 第 3 条）。
///
/// 为什么不是把 `▍` 拼进正文：那样光标颜色一变（每帧的闪烁相位）就得重建
/// 整条 `MdText` —— 长消息上等于每帧全量重排。做成叶节点之后，
/// 稳定块走缓存、光标走自己的动画，`MdText.build` 一帧都不必跑。
///
/// 换行语义：在 `Text.rich` 里用 WidgetSpan + baseline 对齐，
/// 与原来的 `TextSpan('▍')` 完全一致（不会把光标挤到下一行或改变行高）。
class _StreamingCursor extends StatelessWidget {
  const _StreamingCursor({required this.color, required this.style, this.pulse});

  final Color color;
  final TextStyle style;
  final Animation<double>? pulse;

  @override
  Widget build(BuildContext context) {
    final glyph = Text('▍', style: style.copyWith(color: color));
    final animation = pulse;
    if (animation == null) return glyph;
    return AnimatedBuilder(
      animation: animation,
      // child 是静态的：每帧只重建这层 Opacity，不碰 MdText
      builder: (context, child) => Opacity(
        opacity: 0.28 + animation.value * 0.67,
        child: child,
      ),
      child: glyph,
    );
  }
}

class _MentionChip extends StatelessWidget {
  const _MentionChip({required this.name, this.info, this.onTap});

  final String name;
  final MentionInfo? info;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final seed = info?.seed ?? name;
    final color = PB.colorFor(seed);
    final chip = Container(
      padding: const EdgeInsets.fromLTRB(3, 2, 7, 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(PB.rFull),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          BlobAvatar(seed: seed, color: color, size: 15, animate: false),
          const SizedBox(width: 5),
          Text(
            name,
            style: TextStyle(
              fontSize: PB.fsXs,
              fontWeight: FontWeight.w600,
              color: PB.textPrimary,
              height: 1.1,
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return chip;
    return GestureDetector(
      onTap: onTap,
      // 普通箭头：这里只是"点一下"，不该给出"能拖"的暗示
      child: MouseRegion(cursor: SystemMouseCursors.basic, child: chip),
    );
  }
}
