import 'package:flutter/material.dart';

/// 消息「第一次上屏」的入场动画（240ms / 8px 上浮）。
///
/// ## 为什么单独成组件
///
/// 并发群聊里列表会频繁重排、重建。以前这里靠"第二次 build 换成
/// `KeyedSubtree`"来避免重播动画 —— 类型一变，Flutter 就把整棵子树卸载重建：
/// 流式 Markdown、选区、浮层全部重新 init，输入/滚动跟着抖。
///
/// 现在的约定：**永远是同一个 widget 类型 + 同一把 key**，只是把 [animate]
/// 置为 false —— 内部直接定妆（0 Ticker、不播位移动画），子树原封不动。
class AppearOnce extends StatefulWidget {
  const AppearOnce({super.key, required this.child, this.animate = true});

  final Widget child;

  /// false = 已经上过屏：直接呈现，不播动画也不启动 Ticker。
  final bool animate;

  @override
  State<AppearOnce> createState() => _AppearOnceState();
}

class _AppearOnceState extends State<AppearOnce>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 240),
  );

  // ★ CurvedAnimation 只建一次（在 build 里 new 会每次重建都挂一个新监听且不释放）。
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _c,
    curve: Curves.easeOutCubic,
  );

  @override
  void initState() {
    super.initState();
    if (!widget.animate) {
      _c.value = 1;
      return;
    }
    _c.forward();
  }

  @override
  void didUpdateWidget(AppearOnce oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 绝不因为重建而重播：这条动画只在「第一次上屏」有意义。
    if (!widget.animate && _c.value != 1) _c.value = 1;
  }

  @override
  void dispose() {
    _curve.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _curve,
      child: AnimatedBuilder(
        animation: _curve,
        builder: (context, child) => Transform.translate(
          offset: Offset(0, (1 - _curve.value) * 8),
          child: child,
        ),
        child: widget.child,
      ),
    );
  }
}
