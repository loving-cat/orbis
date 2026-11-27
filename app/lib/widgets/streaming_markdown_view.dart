import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../theme.dart';
import 'blob_avatar.dart';
import 'md_text.dart';

/// 自适应流式追字渲染器：
/// - 80ms 网络分片到达之间按帧平滑吐字，避免整块文字台阶跳变；
/// - 切分自动避开 UTF-16 高代理项，绝不截断 emoji 等多码点字符；
/// - 追平后 Ticker 立即停表；测试或关闭动画开关时直接全量直出。
class StreamingMarkdownView extends StatefulWidget {
  const StreamingMarkdownView(
    this.text, {
    super.key,
    this.streaming = true,
    this.style,
    this.mono,
    this.mentions = const [],
    this.onMentionTap,
    this.onLinkTap,
    this.linkColor,
    this.mentionOf,
    /// 流式输出期间也允许拖选复制（真机反馈：没出完就选不了，想贴一半给同事做不到）
    this.selectable = true,
    @visibleForTesting this.forcePacing = false,
  });

  final String text;
  final bool streaming;
  final TextStyle? style;
  final TextStyle? mono;
  final List<String> mentions;
  final void Function(String name)? onMentionTap;
  final void Function(String url)? onLinkTap;
  final Color? linkColor;
  final MentionInfo? Function(String name)? mentionOf;
  final bool selectable;
  final bool forcePacing;

  @visibleForTesting
  static bool pacingEnabled = true;

  @override
  State<StreamingMarkdownView> createState() => _StreamingMarkdownViewState();
}

class _StreamingMarkdownViewState extends State<StreamingMarkdownView>
    with TickerProviderStateMixin {
  Ticker? _ticker;
  Duration _lastTick = Duration.zero;
  double _carry = 0;
  int _shownChars = 0;

  AnimationController? _cursorPulse;

  bool get _shouldPace {
    if (!widget.streaming ||
        !BlobAvatar.animationsActive ||
        !StreamingMarkdownView.pacingEnabled) {
      return false;
    }
    if (widget.forcePacing) return true;
    return !WidgetsBinding.instance.runtimeType.toString().contains('Test');
  }

  static int _safeCut(String text, int target) {
    var cut = target.clamp(0, text.length);
    if (cut > 0 && cut < text.length) {
      final prev = text.codeUnitAt(cut - 1);
      if (prev >= 0xD800 && prev <= 0xDBFF) {
        cut = math.min(text.length, cut + 1);
      }
    }
    return cut;
  }

  @override
  void initState() {
    super.initState();
    _syncState(initial: true);
  }

  @override
  void didUpdateWidget(StreamingMarkdownView oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncState(initial: false);
  }

  void _syncState({required bool initial}) {
    if (!_shouldPace) {
      _shownChars = widget.text.length;
      _carry = 0;
      _ticker?.stop();
      _cursorPulse?.stop();
      return;
    }

    _cursorPulse ??= AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    );
    if (!_cursorPulse!.isAnimating) {
      _cursorPulse!.repeat(reverse: true);
    }

    if (initial && widget.text.isNotEmpty) {
      // 首次挂载且已有正文时平滑起跑几个字或追赶；forcePacing 下从首字符起跑
      _shownChars = widget.forcePacing
          ? _safeCut(widget.text, math.min(4, widget.text.length))
          : widget.text.length;
    } else if (_shownChars > widget.text.length) {
      _shownChars = widget.text.length;
    }

    if (_shownChars < widget.text.length) {
      _startTicker();
    } else {
      _carry = 0;
      _ticker?.stop();
    }
  }

  void _startTicker() {
    if (!mounted || (_ticker?.isActive ?? false)) return;
    _lastTick = Duration.zero;
    (_ticker ??= createTicker(_onTick)).start();
  }

  void _onTick(Duration elapsed) {
    final dt = _lastTick == Duration.zero
        ? 1 / 60
        : (elapsed - _lastTick).inMicroseconds / 1e6;
    _lastTick = elapsed;
    if (!mounted) return;

    final targetLen = widget.text.length;
    final backlog = targetLen - _shownChars;
    if (backlog <= 0) {
      _carry = 0;
      _ticker?.stop();
      return;
    }

    final cps = math.max(55.0, backlog * 16.0);
    _carry += cps * dt.clamp(0.0, 0.1);
    final step = _carry.floor();
    if (step <= 0) return;
    _carry -= step;

    final next = _safeCut(widget.text, math.min(targetLen, _shownChars + step));
    if (next != _shownChars) {
      setState(() => _shownChars = next);
    }
    if (_shownChars >= targetLen) {
      _carry = 0;
      _ticker?.stop();
    }
  }

  @override
  void dispose() {
    _ticker?.dispose();
    _cursorPulse?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final visible = _shownChars >= widget.text.length
        ? widget.text
        : widget.text.substring(0, _safeCut(widget.text, _shownChars));

    final cursorBase = PB.colors(context).accentBright;
    if (!widget.streaming) {
      return MdText(
        visible,
        selectable: true,
        style: widget.style,
        mono: widget.mono,
        mentions: widget.mentions,
        onMentionTap: widget.onMentionTap,
        onLinkTap: widget.onLinkTap,
        linkColor: widget.linkColor,
        mentionOf: widget.mentionOf,
      );
    }

    final pulse = _cursorPulse;
    if (pulse == null || !_shouldPace) {
      return MdText(
        visible,
        selectable: widget.selectable,
        style: widget.style,
        mono: widget.mono,
        mentions: widget.mentions,
        onMentionTap: widget.onMentionTap,
        onLinkTap: widget.onLinkTap,
        linkColor: widget.linkColor,
        mentionOf: widget.mentionOf,
        streamingCursorColor: cursorBase,
      );
    }

    // ★ 不再用 AnimatedBuilder 包住整个 MdText：那等于**每帧重建整条消息**
    //   （闪烁 60 次/秒 × 消息越来长 = 流式卡顿的主因）。现在把动画交给
    //   MdText 内部的末尾光标叶节点，正文一帧都不重建。
    return MdText(
      visible,
      selectable: widget.selectable,
      style: widget.style,
      mono: widget.mono,
      mentions: widget.mentions,
      onMentionTap: widget.onMentionTap,
      onLinkTap: widget.onLinkTap,
      linkColor: widget.linkColor,
      mentionOf: widget.mentionOf,
      streamingCursorColor: cursorBase,
      streamingCursorPulse: pulse,
    );
  }
}
