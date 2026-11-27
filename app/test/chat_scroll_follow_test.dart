import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/chat_scroll_follow.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

final _room = Room(
  id: 'fixture-room',
  name: '验证会话',
  kind: 'dm',
  botIds: const [],
);

Msg _message(int index, {String? text, String? roomId}) => Msg(
  id: 'fixture-$index',
  roomId: roomId ?? _room.id,
  authorType: 'user',
  authorName: '验证用户',
  text: text ?? '验证消息 $index',
  status: 'done',
  createdAt: index + 1,
);

class _ChatState extends AppState {
  _ChatState({this.delayedLoad}) {
    rooms = [_room];
  }

  final Completer<List<Msg>>? delayedLoad;

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {
    if (delayedLoad != null && !messages.containsKey(roomId)) {
      replace(roomId, await delayedLoad!.future);
    }
  }

  void replace(String roomId, List<Msg> list) {
    messages[roomId] = list;
    notifyListeners();
  }
}

Future<void> _frames(WidgetTester tester, [int count = 20]) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

Future<void> _showChat(
  WidgetTester tester,
  _ChatState state, {
  Room? room,
  TargetPlatform? platform,
}) async {
  final selected = room ?? _room;
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        theme: platform == null ? null : ThemeData(platform: platform),
        home: ChatScreen(key: ValueKey(selected.id), room: selected),
      ),
    ),
  );
}

ScrollController _controller(WidgetTester tester) =>
    tester.widget<ListView>(find.byType(ListView).first).controller!;

void _expectAtBottom(WidgetTester tester) {
  final position = _controller(tester).position;
  expect(position.maxScrollExtent - position.pixels, lessThanOrEqualTo(1));
}


/// 一条流式中的 bot 消息（并发吐字用的是它）。
Msg _streaming(int index, String text) => Msg(
  id: 'stream-$index',
  roomId: _room.id,
  authorType: 'bot',
  authorId: 'bot-$index',
  authorName: '成员 $index',
  text: text,
  status: 'streaming',
  createdAt: 1000 + index,
);

/// 把某条流式消息换成长一点的内容（模拟"换行 → 气泡长高"）。
void _grow(_ChatState state, int index, int round) {
  final list = state.messages[_room.id]!;
  state.replace(_room.id, [
    for (final m in list)
      if (m.id == 'stream-$index')
        _streaming(index, '${m.text}\n第 $round 行：${'内容' * 14}')
      else
        m,
  ]);
}

_ChatState _cached() =>
    _ChatState()..messages[_room.id] = List.generate(60, _message);

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('缓存长会话首次挂载后显示最新消息', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);

    expect(_controller(tester).position.maxScrollExtent, greaterThan(1000));
    _expectAtBottom(tester);
    expect(find.text('验证消息 59'), findsOneWidget);
  });

  testWidgets('空会话异步加载历史后首次追底', (tester) async {
    final loaded = Completer<List<Msg>>();
    final state = _ChatState(delayedLoad: loaded);
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await tester.pump();
    expect(find.byType(ListView), findsNothing);

    loaded.complete(List.generate(60, _message));
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.text('验证消息 59'), findsOneWidget);
  });

  testWidgets('补跳期间上翻会取消旧任务，新消息不抢回底部', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    _controller(tester).jumpTo(0);
    await _frames(tester, 5);
    expect(_controller(tester).offset, 0);

    state.replace(_room.id, [...state.messages[_room.id]!, _message(61)]);
    await _frames(tester);
    expect(_controller(tester).offset, 0);
  });

  testWidgets('手动回到近底部恢复跟随并清除未读提示', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    expect(find.byTooltip('回到最新（下面还有 1 条）'), findsOneWidget);

    scroll.jumpTo(scroll.position.maxScrollExtent - 50);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.byTooltip('回到最新（下面还有 1 条）'), findsNothing);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(61)]);
    await _frames(tester);
    _expectAtBottom(tester);
  });

  testWidgets('回到最新按钮恢复追底，动画被上翻打断后不再补跳', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await _frames(tester);
    _expectAtBottom(tester);

    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(scroll.offset, greaterThan(0));
    scroll.jumpTo(0);
    await _frames(tester);
    expect(scroll.offset, 0);
  });

  testWidgets('用户拖动上翻可以中断动画追底', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    final scroll = _controller(tester);
    scroll.jumpTo(0);
    await tester.pump();
    await tester.tap(find.byTooltip('回到最新'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(scroll.offset, greaterThan(0));
    await tester.drag(find.byType(ListView).first, const Offset(0, 300));
    await _frames(tester);
    expect(scroll.position.maxScrollExtent - scroll.offset, greaterThan(140));
    expect(find.byTooltip('回到最新'), findsOneWidget);
  });

  testWidgets('没有拖拽信息的滚轮上翻也取消待执行补跳', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    await tester.sendEventToBinding(
      PointerScrollEvent(
        position: tester.getCenter(find.byType(ListView).first),
        scrollDelta: const Offset(0, -300),
      ),
    );
    final afterWheel = _controller(tester).offset;
    await _frames(tester);
    expect(_controller(tester).offset, afterWheel);
    expect(
      _controller(tester).position.maxScrollExtent - afterWheel,
      greaterThan(140),
    );
    expect(find.byTooltip('回到最新'), findsOneWidget);
  });

  for (final platform in [TargetPlatform.windows, TargetPlatform.macOS]) {
    testWidgets('${platform.name} 底部继续向下拖动后仍跟随新消息', (tester) async {
      final state = _cached();
      addTearDown(state.dispose);
      await _showChat(tester, state, platform: platform);
      await _frames(tester);
      final scroll = _controller(tester);
      expect(
        scroll.position.physics,
        platform == TargetPlatform.windows
            ? isA<ClampingScrollPhysics>()
            : isA<BouncingScrollPhysics>(),
      );
      await tester.drag(find.byType(ListView).first, const Offset(0, -250));
      await _frames(tester);
      _expectAtBottom(tester);

      state.replace(_room.id, [
        ...state.messages[_room.id]!,
        _message(60, text: '新的长回复\n' * 15),
      ]);
      await _frames(tester);
      _expectAtBottom(tester);
      expect(find.byTooltip('回到最新'), findsNothing);
    });

    testWidgets('${platform.name} 小幅上翻结束不恢复跟随', (tester) async {
      final state = _cached();
      addTearDown(state.dispose);
      await _showChat(tester, state, platform: platform);
      await _frames(tester);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(ListView).first),
      );
      await gesture.moveBy(const Offset(0, 70));
      await tester.pump(const Duration(seconds: 1));
      await gesture.up();
      await _frames(tester);
      final scroll = _controller(tester);
      final away = scroll.position.maxScrollExtent - scroll.offset;
      expect(away, greaterThan(1));
      expect(away, lessThan(140));
      final afterUser = scroll.offset;

      state.replace(_room.id, [
        ...state.messages[_room.id]!,
        _message(60, text: '另一条长回复\n' * 15),
      ]);
      await _frames(tester);
      expect(scroll.offset, afterUser);
    });
  }


  for (final platform in [TargetPlatform.windows, TargetPlatform.macOS]) {
    testWidgets('${platform.name} 底部继续下滑时箭头不闪', (tester) async {
      final state = _cached();
      addTearDown(state.dispose);
      await _showChat(tester, state, platform: platform);
      await _frames(tester);
      _expectAtBottom(tester);
      // 在底部时不该有箭头
      expect(find.byTooltip('回到最新'), findsNothing);

      // ★ 直接在底部继续往下拖：BouncingScrollPhysics 会先拉伸再回弹，
      //   老代码会把回弹当成"用户往上翻"，于是箭头闪一下。
      //   逐帧检查 —— 只看结束状态会漏掉这一闪。
      final gesture = await tester.startGesture(
        tester.getCenter(find.byType(ListView).first),
      );
      var flashed = false;
      for (var i = 0; i < 8; i++) {
        await gesture.moveBy(const Offset(0, -40));
        await tester.pump(const Duration(milliseconds: 16));
        if (find.byTooltip('回到最新').evaluate().isNotEmpty) {
          flashed = true;
        }
      }
      await gesture.up();
      await _frames(tester);

      expect(flashed, isFalse, reason: '在底部继续下滑时不该出现回到最新按钮');
      expect(find.byTooltip('回到最新'), findsNothing);
      _expectAtBottom(tester);
    });
  }


  testWidgets('不同高度消息与正文增减后仍保持跟随', (tester) async {
    final state = _ChatState()
      ..messages[_room.id] = List.generate(
        100,
        (index) => _message(
          index,
          text: index < 60 ? '短消息 $index' : ('较长消息 $index\n' * 10),
        ),
      );
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester, 30);
    _expectAtBottom(tester);

    final previous = state.messages[_room.id]!;
    state.replace(_room.id, [
      ...previous.take(previous.length - 1),
      _message(99, text: '流式新增正文\n' * 35),
    ]);
    await _frames(tester);
    _expectAtBottom(tester);
    state.replace(_room.id, [
      ...previous.take(previous.length - 1),
      _message(99, text: '收起的正文'),
    ]);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(find.byTooltip('回到最新'), findsNothing);
  });

  testWidgets('有待执行回调时切房间或销毁不会操作旧列表', (tester) async {
    final state = _cached();
    final second = Room(
      id: 'fixture-second',
      name: '第二会话',
      kind: 'dm',
      botIds: const [],
    );
    state.rooms = [_room, second];
    state.messages[second.id] = List.generate(
      70,
      (index) => _message(index, roomId: second.id),
    );
    addTearDown(state.dispose);
    await _showChat(tester, state);
    state.replace(_room.id, [...state.messages[_room.id]!, _message(60)]);
    await tester.pump();
    await _showChat(tester, state, room: second);
    await _frames(tester);
    _expectAtBottom(tester);
    expect(tester.takeException(), isNull);

    state.replace(second.id, [
      ...state.messages[second.id]!,
      _message(70, roomId: second.id),
    ]);
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    await _frames(tester);
    expect(tester.takeException(), isNull);
  });

  // -------------------------------------------------------------------------
  // 同帧贴底（真机：并发多 Bot 流式时整块聊天区上下抽搐）
  // -------------------------------------------------------------------------

  testWidgets('★ 两路并发流式交替增高：单次 pump 之后底部零滞后（不是先下顶、下一帧才上拽）', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    _expectAtBottom(tester);

    // 两路并发吐字（各自一条 streaming 气泡）
    state.replace(_room.id, [
      ...state.messages[_room.id]!,
      _streaming(0, '甲：正在整理数据'),
      _streaming(1, '乙：正在核对口径'),
    ]);
    await _frames(tester, 3);
    _expectAtBottom(tester);

    // ★ 必须是"同帧贴底"的控制器：普通 ScrollController 只能靠下一帧
    //   post-frame 的 jumpTo 补，那一帧里内容是下顶的（真机就是那个锯齿）。
    final controller = _controller(tester);
    expect(controller, isA<StickyBottomScrollController>(),
        reason: '聊天列表必须用同帧贴底的控制器');
    final sticky = controller as StickyBottomScrollController;
    final before = sticky.corrections;

    // 交替长高：每次只 pump **一帧**，就必须已经贴底
    for (var round = 0; round < 8; round++) {
      _grow(state, round.isEven ? 0 : 1, round);
      await tester.pump();
      final position = _controller(tester).position;
      expect(
        position.maxScrollExtent - position.pixels,
        lessThanOrEqualTo(1),
        reason: '第 $round 次增高后单帧内没有贴底：还差 '
            '${(position.maxScrollExtent - position.pixels).toStringAsFixed(1)}px',
      );
    }
    // 布局期真的纠偏过（不是靠下一帧 jumpTo 凑出来的 0）
    expect(sticky.corrections, greaterThan(before),
        reason: '这 8 次增高里应当至少有一次是布局期贴底的');
  });

  testWidgets('★ 用户上翻离开底部后，两路流式继续增高绝不把人拽回底部', (tester) async {
    final state = _cached();
    addTearDown(state.dispose);
    await _showChat(tester, state);
    await _frames(tester);
    _expectAtBottom(tester);

    state.replace(_room.id, [
      ...state.messages[_room.id]!,
      _streaming(0, '甲：正在整理数据'),
      _streaming(1, '乙：正在核对口径'),
    ]);
    await _frames(tester, 3);

    // 用户往上翻（内容往下走 = pixels 变小）
    await tester.drag(find.byType(ListView).first, const Offset(0, 400));
    await _frames(tester, 3);
    final before = _controller(tester).position.pixels;
    expect(
      _controller(tester).position.maxScrollExtent - before,
      greaterThan(1),
      reason: '这一步要真的离开底部，否则用例没有意义',
    );

    // 两路继续交替长高：绝不能触发同帧纠偏把人拽下去
    for (var round = 0; round < 8; round++) {
      _grow(state, round.isEven ? 0 : 1, round);
      await tester.pump();
      final position = _controller(tester).position;
      expect(
        (position.pixels - before).abs(),
        lessThanOrEqualTo(1),
        reason: '用户上翻后位置被抢走了 ${(position.pixels - before).toStringAsFixed(1)}px',
      );
    }
    expect(find.byTooltip('回到最新'), findsOneWidget, reason: '离开底部应显示回到最新');
  });
}
