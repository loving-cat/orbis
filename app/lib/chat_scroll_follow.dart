import 'package:flutter/rendering.dart' show ScrollDirection;
import 'package:flutter/scheduler.dart' show SchedulerBinding, SchedulerPhase;
import 'package:flutter/widgets.dart';

/// 聊天列表的追底调度；用户离开底部时取消旧任务，布局变化按帧收敛。
class ChatScrollFollow {
  ChatScrollFollow(
    this.controller, {
    required this.onFollowingChanged,
    this.nearBottom = 140,
    this.maxFrames = 10,
  }) {
    controller.addListener(_onOffsetChanged);
    // ★ 同帧贴底时 `correctPixels` **不会** notifyListeners（它是布局期的事），
    //   于是 `_lastPixels` 会停在旧值。等用户随后轻轻上滚时，
    //   `delta = pixels - _lastPixels` 会被算成正数 → 追底被延迟撤销（像被拽住一样）。
    //   所以纠偏发生时同步一次基准值。
    if (controller is StickyBottomScrollController) {
      (controller as StickyBottomScrollController).onPixelsCorrected = _syncPixels;
    }
  }

  /// 把「上次像素」对齐到当前真实偏移（纠偏/布局后调用）。
  void _syncPixels(ScrollPosition position) {
    _lastPosition = position;
    _lastPixels = position.pixels;
  }

  final ScrollController controller;
  final ValueChanged<bool> onFollowingChanged;
  final double nearBottom;
  final int maxFrames;

  /// 离底部多近算「还在底部」。
  ///
  /// 回弹、像素取整都会让 pixels 与 maxScrollExtent 差几个像素，
  /// 用 <= 1 这种精确相等来判就会把正常抖动误判成"用户往上翻了"。
  static const double _bottomSlack = 24;

  bool get following => _following;

  /// 现在允许「同帧贴底」纠偏吗。
  ///
  /// 与 `handleNotification` 的追底判据同源，但要更严：正在拖滚动条、
  /// 有 `animateTo` 在跑、拖拽松手后待恢复 —— 这三种情况下 layout 期纠偏
  /// 会和用户的滚动/动画抢位置。
  bool get stickToBottom =>
      _following && !_externalDragging && _animatedGeneration == null && !_resumeAfterDrag;

  bool _following = true;
  bool _disposed = false;
  bool _active = false;
  bool _jumping = false;
  bool _resumeAfterDrag = false;
  bool _externalDragging = false;
  /// 这一帧已经排了一次补跳（多路流式同时长高时只跳一次）。
  bool _frameQueued = false;
  int _generation = 0;
  int? _animatedGeneration;
  ScrollPosition? _lastPosition;
  double? _lastPixels;

  /// 外部滚动条拖拽期间暂停自动追底，防止松手前抢夺位置。
  void setExternalDragging(bool active) {
    if (_disposed || _externalDragging == active) return;
    _externalDragging = active;
    if (active) pause();
  }

  /// 追底请求：**每帧最多一次** `jumpTo(maxScrollExtent)`。
  ///
  /// ★ 并发流式时两路（或多路）气泡交替长高，会连续触发 ScrollMetricsNotification。
  ///   以前每一路都排一轮 10 帧补跳，两路互相把偏移抢来抢去 —— 表现就是上下抽搐。
  ///   现在同一帧内的所有请求合批成一次跳转，下一帧再按新的 maxScrollExtent 收敛。
  void request() {
    if (_disposed || !_following || _frameQueued) return;
    _frameQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _frameQueued = false;
      if (_disposed || !_following) return;
      if (!controller.hasClients) return;
      final position = controller.position;
      if (!position.hasContentDimensions) return;
      if ((position.maxScrollExtent - position.pixels).abs() <= 1) return;
      _jumping = true;
      try {
        position.jumpTo(position.maxScrollExtent);
      } finally {
        _jumping = false;
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  /// 显式发送或回到底部时恢复跟随，动画完成后继续校准懒列表高度。
  void resume({bool animate = false}) {
    if (_disposed) return;
    _setFollowing(true);
    _start(animate: animate);
  }

  /// 取消尚未执行的补跳；手势或外部滚动负责中止正在运行的滚动活动。
  void pause() {
    if (_disposed) return;
    _generation++;
    _active = false;
    _animatedGeneration = null;
    _resumeAfterDrag = false;
    _setFollowing(false);
  }

  /// 仅处理本列表的滚动通知，嵌套预览与横向列表不改变跟随意图。
  bool handleNotification(Notification notification) {
    if (_disposed || _externalDragging) return false;
    if (notification is ScrollMetricsNotification && notification.depth == 0) {
      // ★ 只有「本来就在底部、正在跟随」时才追底。
      //
      //   原来这里无条件 request()：只要内容变高就排一轮 10 帧的 jumpTo。
      //   流式输出时内容每几十毫秒长高一次 —— 于是每帧都在把列表拽回底部，
      //   滚动条滑块跟着反复重算重绘，快速滑动时就是明显的抽搐。
      //
      //   而且用户正在往上翻的时候，这个跳转还在跟他的滚动手势较劲：
      //   一滑就被拽回底部。加 following 判定后两件事一起解决。
      // 同帧贴底已经改过 pixels：先把基准同步过来，再决定要不要兜底 request()
      if (controller.hasClients) _syncPixels(controller.position);
      if (_following) request();
    } else if (notification is ScrollNotification && notification.depth == 0) {
      if (notification is ScrollStartNotification &&
          notification.dragDetails != null) {
        final distanceToBottom =
            (notification.metrics.maxScrollExtent - notification.metrics.pixels)
                .abs();
        final wasAtBottom = _following && distanceToBottom <= _bottomSlack;
        // ★ 在底部起手时不要立刻 pause。
        //
        //   ScrollStartNotification 只说明"手指按下了"，还不知道用户
        //   要往上翻还是继续留在底部看新消息。老代码无条件 pause()，
        //   于是手指一沾上（哪怕是在最底部继续往下拉）"回到底部"
        //   箭头就冒出来 —— 用户明明没往上翻。
        //   在底部起手时保持跟随；真往上翻，_onOffsetChanged 会停掉。
        if (!wasAtBottom) pause();
        _resumeAfterDrag = wasAtBottom;
      } else if (notification is UserScrollNotification &&
          notification.direction == ScrollDirection.forward) {
        pause();
      } else if (notification is ScrollEndNotification) {
        final restore = _resumeAfterDrag;
        _resumeAfterDrag = false;
        if (restore &&
            (notification.metrics.maxScrollExtent - notification.metrics.pixels)
                    .abs() <=
                1) {
          resume();
        }
      }
    }
    return false;
  }

  void _setFollowing(bool value) {
    if (_following == value) return;
    _following = value;
    onFollowingChanged(value);
  }

  void _onOffsetChanged() {
    if (_disposed || !controller.hasClients) return;
    final position = controller.position;
    final previous = identical(position, _lastPosition) ? _lastPixels : null;
    _lastPosition = position;
    _lastPixels = position.pixels;
    if (_externalDragging || _jumping || previous == null) return;
    if (WidgetsBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      return;
    }

    final delta = position.pixels - previous;
    final remaining = position.maxScrollExtent - position.pixels;
    if (delta < -0.5 && remaining > 1) {
      pause();
    } else if (_animatedGeneration == null && delta.abs() > 0.5) {
      if (remaining > nearBottom) {
        pause();
      } else if (delta > 0) {
        _setFollowing(true);
      }
    }
  }

  void _start({required bool animate}) {
    if (_disposed || !_following || _active) return;
    _active = true;
    _schedule(_generation, maxFrames, animate);
  }

  bool _current(int generation) =>
      !_disposed && _following && generation == _generation;

  void _schedule(int generation, int remaining, bool animate) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _step(generation, remaining, animate);
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _step(int generation, int remaining, bool animate) async {
    if (!_current(generation)) return;
    if (!controller.hasClients || remaining <= 0) {
      _active = false;
      return;
    }
    final position = controller.position;
    _lastPosition = position;
    _lastPixels = position.pixels;
    if (!position.hasContentDimensions) {
      _schedule(generation, remaining - 1, animate);
      return;
    }
    if ((position.maxScrollExtent - position.pixels).abs() <= 1) {
      _active = false;
      return;
    }

    if (animate) {
      _animatedGeneration = generation;
      try {
        await position.animateTo(
          position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      } finally {
        if (_animatedGeneration == generation) _animatedGeneration = null;
      }
      if (!_current(generation)) return;
    } else {
      _jumping = true;
      try {
        position.jumpTo(position.maxScrollExtent);
      } finally {
        _jumping = false;
      }
    }
    if (_current(generation)) {
      _schedule(generation, remaining - 1, false);
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    controller.removeListener(_onOffsetChanged);
    // ★ 控制器可能在 ChatScrollFollow 之后才销毁（房间切换时列表先走）：
    //   撤掉回调，别让它在布局期把像素同步到一个已经 dispose 的对象上。
    if (controller is StickyBottomScrollController) {
      (controller as StickyBottomScrollController).onPixelsCorrected = null;
    }
  }
}

/// 追底用的滚动控制器：**在布局期**就把偏移贴到新的 `maxScrollExtent`。
///
/// ## 为什么需要它（真机：并发多 Bot 流式时整块聊天区上下抽搐）
///
/// `ListView` 是正向顶部锚定的（`reverse: false`）。气泡换行长高时：
///
///   第 N 帧   —— 新内容把下方气泡向下顶一截（`maxScrollExtent` 变大，`pixels` 没变）
///   第 N+1 帧 —— `ChatScrollFollow.request()` 的 post-frame `jumpTo` 才把整屏拽回底部
///
/// 一帧的「先下顶、再上拽」单独看几乎察觉不到；但两路 Bot 同时流式、交替换行时，
/// 这个锯齿会以每秒十几次的频率出现 —— 用户看到的是整块聊天区在抖。
///
/// ## 怎么消除
///
/// `RenderViewport` 每次布局结束都会调 `applyContentDimensions(min, max)`，
/// 返回值是「这个偏移对新尺寸还成立吗」。返回 `false` 时视口会用纠正后的
/// 偏移**在同一帧内**再排一次（`RenderViewportBase.performLayout` 的 do/while）。
/// 所以在这里 `correctPixels(max)` 再 `return false`，就等于「本帧绘制前已经贴底」，
/// 根本不会出现先下顶的那一帧。
///
/// ## 四条不变量（缺一条就会变成"抢用户的滚动"）
///
///   1. 只在**追底状态**下纠偏（`shouldStickToBottom`，由 `ChatScrollFollow` 注入：
///      用户上翻 / 正在拖滚动条 / 有动画在进行 / 拖拽后待恢复 → 一律不纠偏）；
///   2. 用户手势进行中（`DragScrollActivity` / `BallisticScrollActivity`）绝不纠偏；
///   3. 只有**上一帧本来就在底部附近**才纠偏 —— 懒列表首次加载长历史时
///      `maxScrollExtent` 会突然跳很大，不能借机把用户拽到底；
///   4. 单次布局 pass 最多纠偏 `maxCorrectionsPerLayout` 次（默认 2），
///      防止「懒加载高度波动 → 纠偏 → 又变高」在帧内死循环。
class StickyBottomScrollController extends ScrollController {
  StickyBottomScrollController({
    this.shouldStickToBottom,
    this.bottomSlack = 24,
    this.maxCorrectionsPerLayout = 2,
  });

  /// 现在该不该贴底（由 `ChatScrollFollow` 提供，读的是它自己的状态机）。
  final bool Function()? shouldStickToBottom;

  /// 「上一帧算在底部」的容差（像素）。
  final double bottomSlack;

  /// 单次布局 pass 内最多纠偏几次（防懒加载高度波动引起死循环）。
  final int maxCorrectionsPerLayout;

  /// 纠偏发生时的回调（用来同步 `ChatScrollFollow._lastPixels`）。
  void Function(ScrollPosition position)? onPixelsCorrected;

  /// 同帧纠偏累计次数（测试用它区分「真的在布局期贴底」与「靠下一帧 jumpTo 补」）。
  int corrections = 0;

  bool get _stick => shouldStickToBottom?.call() ?? false;

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) {
    return _StickyBottomScrollPosition(
      physics: physics,
      context: context,
      oldPosition: oldPosition,
      controller: this,
    );
  }
}

class _StickyBottomScrollPosition extends ScrollPositionWithSingleContext {
  _StickyBottomScrollPosition({
    required super.physics,
    required super.context,
    super.oldPosition,
    required this.controller,
  });

  final StickyBottomScrollController controller;

  double? _prevMaxScrollExtent;
  int _corrections = 0;
  bool _resetScheduled = false;

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    final previous = _prevMaxScrollExtent;
    _prevMaxScrollExtent = maxScrollExtent;
    // 框架自己还要再排一次（比如纠正后越界）：先让它补，别在这里叠加纠偏
    if (!super.applyContentDimensions(minScrollExtent, maxScrollExtent)) return false;
    if (!hasPixels || !controller._stick) return true;
    if (_corrections >= controller.maxCorrectionsPerLayout) return true;
    // 已经贴底（或内容比视口还短）→ 无事可做
    if (maxScrollExtent <= pixels + 0.5) return true;
    // 用户手势进行中：绝不抢
    final activity = this.activity;
    if (activity is DragScrollActivity || activity is BallisticScrollActivity) return true;
    // 上一帧不在底部附近（首次加载 / 用户上翻过）：不纠偏
    if (previous != null && (previous - pixels).abs() > controller.bottomSlack) return true;

    _corrections += 1;
    // 计数在**帧后**归零：同一帧内的多次布局算一次 pass
    if (!_resetScheduled) {
      _resetScheduled = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _resetScheduled = false;
        _corrections = 0;
      });
    }
    correctPixels(maxScrollExtent);
    controller.corrections += 1;
    controller.onPixelsCorrected?.call(this);
    // ★ 关键：false = 「我这个偏移不对，请用新偏移再排一次」。
    //   RenderViewport 会在**本帧绘制前**重排，于是不会出现「先下顶一帧」。
    return false;
  }

  @override
  bool applyViewportDimension(double viewportDimension) {
    // 视口尺寸变了 = 新的一次布局，帧内计数清零
    _corrections = 0;
    return super.applyViewportDimension(viewportDimension);
  }
}
