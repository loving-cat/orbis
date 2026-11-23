// 任务卡与任务详情里的「谁在跟 / 负责人 / 分工计划」必须显示真实 Bot 名。
//
// 用户原话：「任务面板里涉及其他 Bot 的时候，很多时候显示的不是真实 name，
// 而是 botId / 一串数字。」
//
// 这里盯的是**渲染结果**：即使服务端下发的 `name` 为空、或者老数据把 botId
// 塞进了 name/owner 列，界面上也不能出现 `b_xxx`。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/task_run_models.dart';
import 'package:pi_bot/widgets/task_run_card.dart';
import 'package:pi_bot/widgets/task_run_sheet.dart';

class _State extends AppState {}

_State _newState() => _State()
  ..bots = [
    Bot(id: 'b_main', name: '主控', role: 'main'),
    Bot(id: 'b_ops', name: '运维工程师'),
    Bot(id: 'b_fin', name: '财务建模师'),
  ];

Map<String, dynamic> _taskJson() => {
  'id': 'tr_1',
  'roomId': 'r_1',
  'rootTaskId': 'tr_1',
  'parentTaskId': null,
  'revision': 1,
  'sequence': 1,
  'storeVersion': 1,
  'state': 'running',
  'stateText': '执行中',
  'title': '发布 2.0',
  'scope': '',
  'deliverables': <String>[],
  'verificationCount': 0,
  'unmet': <String>[],
  'blockedReason': '',
  'phase': 'active',
  // 服务端 `nameOf` 没查到时名字就是空的 —— 负责人不能因此整条消失
  'leadBotId': 'b_main',
  'leadBotName': '',
  'childrenSummary': {
    'total': 2,
    'done': 0,
    'running': 2,
    'waiting': 0,
    'participants': [
      // 服务端没解析到名字（只有 id）
      {'botId': 'b_ops', 'name': '', 'state': 'running', 'done': false},
      // 老数据：名字列里存的是 botId
      {'botId': 'b_fin', 'name': 'b_fin', 'state': 'running', 'done': false},
    ],
  },
  'plan': {
    'steps': [
      // 老数据：owner 直接就是 memberBotId
      {'index': 1, 'title': '把服务发上去', 'owner': 'b_ops'},
      // 新数据：owner 是真名，同时带 ownerBotId
      {'index': 2, 'title': '核对账单', 'owner': '财务建模师', 'ownerBotId': 'b_fin'},
    ],
    'at': 1,
    'revision': 1,
  },
  'budget': {'maxRuns': null, 'remaining': null},
  'result': {'prepared': false, 'delivered': false},
  'updatedAt': 1,
};

Future<void> _pumpCard(WidgetTester tester, AppState state,
    {bool withScope = true, String Function(String id)? nameOf}) async {
  final card = TaskRunCard(
    task: TaskRun.fromJson(_taskJson()),
    nameOf: nameOf,
    onOpen: null,
  );
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: withScope
            ? AppScope(state: state, child: card)
            : card,
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('★ 任务卡：参与者 name 为空但 botId 可解析 → 显示真实名字', (tester) async {
    final state = _newState();
    addTearDown(state.dispose);
    await _pumpCard(tester, state);
    expect(find.textContaining('运维工程师、财务建模师 在跟'), findsOneWidget);
    expect(find.textContaining('b_ops'), findsNothing);
    expect(find.textContaining('b_fin'), findsNothing);
  });

  testWidgets('任务卡：显式 nameOf 优先（调用方自己知道名字时不必依赖 AppScope）', (tester) async {
    final state = _newState();
    addTearDown(state.dispose);
    await _pumpCard(tester, state, withScope: false, nameOf: (id) => id == 'b_ops' ? '值班小哥' : '');
    expect(find.textContaining('值班小哥'), findsOneWidget);
    expect(find.textContaining('b_ops'), findsNothing);
  });

  testWidgets('任务卡：没有 AppScope 也没有 nameOf 时保持原样（不崩、不吞已有名字）', (tester) async {
    final state = _newState();
    addTearDown(state.dispose);
    final task = TaskRun.fromJson({
      ..._taskJson(),
      'childrenSummary': {
        'total': 1,
        'done': 0,
        'running': 1,
        'waiting': 0,
        'participants': [
          {'botId': 'b_ops', 'name': '运维工程师', 'state': 'running', 'done': false},
        ],
      },
    });
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: TaskRunCard(task: task))));
    await tester.pump();
    expect(find.textContaining('运维工程师 在跟'), findsOneWidget);
  });

  testWidgets('★ 任务详情：负责人只剩 id、参与者为空、计划里 owner 是 botId 时都显示真名', (tester) async {
    final state = _newState();
    addTearDown(state.dispose);
    state.taskRuns.applyHello({
      'server': {'serverInstanceId': 's1'},
      'taskRuns': [_taskJson()],
      'recentTaskRuns': <Map<String, dynamic>>[],
      'taskRunMeta': {'activeCount': 1, 'activeComplete': true, 'activeLimit': 200},
    });
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(
            body: TaskRunDetailInline(state: state, taskRunId: 'tr_1'),
          ),
        ),
      ),
    );
    await tester.pump();

    // 负责人：leadBotName 为空但 leadBotId 认得出 → 显示名字，不整条丢掉
    expect(find.textContaining('负责人：主控'), findsOneWidget);
    // 参与者：一个 name 为空、一个把 botId 存进了名字列 → 都翻译成真名
    expect(find.text('· 运维工程师　在做'), findsOneWidget);
    expect(find.text('· 财务建模师　在做'), findsOneWidget);
    // 分工计划：老数据 owner 是 botId → 显示「运维工程师：把服务发上去」
    expect(find.text('运维工程师：把服务发上去'), findsOneWidget);
    expect(find.text('财务建模师：核对账单'), findsOneWidget);

    // 界面上任何地方都不该出现裸 botId
    for (final id in ['b_main', 'b_ops', 'b_fin']) {
      expect(find.textContaining(id), findsNothing, reason: '详情页露出了 $id');
    }
  });
}
