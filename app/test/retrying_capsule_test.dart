import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/activity_monitor.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 上游重试 / 临时换模型的胶囊展示（SPEC-PERF-V1 §4.2 c/d）。
///
/// 守三件事：
///   1. `bot.retrying` 只进临时态，**绝不写进消息历史**；
///   2. 胶囊文案短（不撑爆 200px），Tooltip 说清「换了谁」；
///   3. `msg.done` / `msg.error` / `typing:false` 一定清掉，不留过期的「上游不稳」。

final room = Room(id: 'rx', name: '重试会话', kind: 'dm', botIds: const []);

class _State extends AppState {
  _State({List<Msg> msgs = const []}) {
    rooms = [room];
    bots = [
      Bot(id: 'b1', name: '商业研究主管', emoji: '📊', persona: ''),
    ];
    messages[room.id] = List.of(msgs);
  }

  @override
  Future<void> loadMessages(String roomId, {bool force = false}) async {}
}

Msg liveMsg({String status = 'streaming'}) => Msg(
  id: 'm1',
  roomId: room.id,
  authorType: 'bot',
  authorId: 'b1',
  authorName: '商业研究主管',
  text: '正在整理',
  status: status,
  createdAt: 1000,
);

Map<String, dynamic> msgJson({String status = 'done'}) => {
  'id': 'm1',
  'roomId': room.id,
  'authorType': 'bot',
  'authorId': 'b1',
  'authorName': '商业研究主管',
  'text': '做完了',
  'status': status,
  'createdAt': 1000,
};

Widget monitor(AppState state) => AppScope(
  state: state,
  child: MaterialApp(
    home: Scaffold(
      body: SizedBox(
        width: 900,
        child: ActivityMonitor(roomId: room.id, needsUser: false, streaming: false),
      ),
    ),
  ),
);

void main() {
  setUp(() {
    SharedPreferencesStub.init();
    BlobAvatar.animationsEnabled = false;
  });
  tearDown(() => BlobAvatar.animationsEnabled = true);

  group('文案', () {
    test('普通重试 → 上游不稳 · 第 N 次重试（短文案）', () {
      expect(retryActivityVerb({'attempt': 2}), '上游不稳 · 第 2 次重试');
      expect(retryActivityVerb({'attempt': 2}).length <= 16, isTrue,
          reason: '胶囊有 200px 上限，不能写长');
      expect(retryActivityVerb(null), '');
      expect(retryActivityVerb({}), '');
    });

    test('已切备用 → 只说「已切备用模型」，Tooltip 才带模型名', () {
      expect(retryActivityVerb({'attempt': 3, 'switchedTo': '丙 · 备线'}), '已切备用模型');
      final tip = retryTooltip({'attempt': 3, 'switchedTo': '丙 · 备线'});
      expect(tip.contains('丙 · 备线'), isTrue);
      expect(tip.contains('不会改你的模型配置'), isTrue);
      expect(tip.contains('http'), isFalse, reason: '不能泄露 endpoint');
    });

    test('普通重试的 Tooltip 带次数与等待', () {
      final tip = retryTooltip({'attempt': 2, 'delayMs': 4000});
      expect(tip.contains('第 2 次重试'), isTrue);
      expect(tip.contains('4 秒'), isTrue);
    });
  });

  group('状态（纯临时态，不碰消息）', () {
    test('bot.retrying 更新状态且不写入消息历史', () {
      final s = _State();
      s.handleFrameForTest({
        't': 'bot.retrying',
        'roomId': room.id,
        'botId': 'b1',
        'attempt': 2,
        'delayMs': 3000,
        'kind': 'transient',
      });
      final info = s.retryingOf(room.id, 'b1');
      expect(info, isNotNull);
      expect(info!['attempt'], 2);
      expect(info['delayMs'], 3000);
      expect(info['switchedTo'], isNull);
      expect(s.messages[room.id], isEmpty, reason: '重试态绝不能变成一条消息');
      s.dispose();
    });

    test('bot.retrying 带 switchedTo 时记下备用模型名', () {
      final s = _State();
      s.handleFrameForTest({
        't': 'bot.retrying',
        'roomId': room.id,
        'botId': 'b1',
        'attempt': 3,
        'delayMs': 0,
        'kind': 'breaker-open',
        'switchedTo': '丙 · 备线',
      });
      expect(s.retryingOf(room.id, 'b1')!['switchedTo'], '丙 · 备线');
      s.dispose();
    });

    test('★ msg.done / msg.error / typing:false 都清掉重试态', () {
      final retry = {
        't': 'bot.retrying',
        'roomId': room.id,
        'botId': 'b1',
        'attempt': 1,
        'delayMs': 2000,
        'kind': 'sdk-retry',
      };

      final a = _State(msgs: [liveMsg()]);
      a.handleFrameForTest(retry);
      expect(a.retryingOf(room.id, 'b1'), isNotNull);
      a.handleFrameForTest({'t': 'msg.done', 'msg': msgJson()});
      expect(a.retryingOf(room.id, 'b1'), isNull, reason: '收口后不能挂着过期的重试态');
      a.dispose();

      final b = _State(msgs: [liveMsg()]);
      b.handleFrameForTest(retry);
      b.handleFrameForTest({
        't': 'msg.error',
        'roomId': room.id,
        'msgId': 'm1',
        'error': '上游挂了',
      });
      expect(b.retryingOf(room.id, 'b1'), isNull);
      b.dispose();

      final c = _State(msgs: [liveMsg()]);
      c.handleFrameForTest(retry);
      c.handleFrameForTest({
        't': 'typing',
        'roomId': room.id,
        'botId': 'b1',
        'active': false,
        'lane': 'work',
      });
      expect(c.retryingOf(room.id, 'b1'), isNull);
      c.dispose();
    });
  });

  group('胶囊展示', () {
    testWidgets('★ 重试中文案优先于「正在思考」', (tester) async {
      final state = _State(msgs: [liveMsg()]);
      state.handleFrameForTest({
        't': 'bot.retrying',
        'roomId': room.id,
        'botId': 'b1',
        'attempt': 2,
        'delayMs': 3000,
        'kind': 'transient',
      });
      await tester.pumpWidget(monitor(state));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('上游不稳 · 第 2 次重试'), findsOneWidget);
      expect(find.textContaining('正在思考'), findsNothing, reason: '重试态优先');
      state.dispose();
    });

    testWidgets('★ 已切备用模型 + Tooltip 带模型名；清空后胶囊消失', (tester) async {
      final state = _State(msgs: [liveMsg()]);
      state.handleFrameForTest({
        't': 'bot.retrying',
        'roomId': room.id,
        'botId': 'b1',
        'attempt': 3,
        'delayMs': 0,
        'kind': 'breaker-open',
        'switchedTo': '丙 · 备线',
      });
      await tester.pumpWidget(monitor(state));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.textContaining('已切备用模型'), findsOneWidget);
      final tips = tester
          .widgetList<Tooltip>(find.byType(Tooltip))
          .map((t) => t.message ?? '')
          .join('\n');
      expect(tips.contains('丙 · 备线'), isTrue, reason: 'Tooltip 要能说清换到了谁');

      // 终态到达 → 临时态清空 → 胶囊消失
      state.handleFrameForTest({
        't': 'typing',
        'roomId': room.id,
        'botId': 'b1',
        'active': false,
        'lane': 'work',
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.textContaining('已切备用模型'), findsNothing);
      state.dispose();
    });
  });
}

/// 这个仓库里 AppState 需要 shared_preferences；只给最小可用桩。
class SharedPreferencesStub {
  static void init() {}
}
