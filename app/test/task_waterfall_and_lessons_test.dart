import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/task_run_controller.dart';
import 'package:pi_bot/task_run_models.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/lesson_adoption_banner.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pi_bot/widgets/task_run_sheet.dart';
import 'package:pi_bot/widgets/task_waterfall_section.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 老服务端的快照（完全没有 C5 字段）：必须不抛、字段回落。
const _legacyJson = <String, dynamic>{
  'id': 'tr_1',
  'revision': 1,
  'sequence': 3,
  'storeVersion': 7,
  'state': 'running',
  'phase': 'active',
  'stateText': '执行中',
  'title': '一件老任务',
  'budget': {'maxRuns': 5, 'usedRuns': 2, 'extraRuns': 0, 'remaining': 3},
  'updatedAt': 1000,
};

/// 新详情快照（含瀑布流 / 遥测 / 黑板）。
Map<String, dynamic> detailJson() => {
      'id': 'tr_root',
      'rootTaskId': 'tr_root',
      'revision': 1,
      'sequence': 9,
      'storeVersion': 12,
      'state': 'running',
      'phase': 'active',
      'stateText': '执行中',
      'title': '并行写代码',
      'budget': {
        'maxRuns': null,
        'usedRuns': 3,
        'extraRuns': 0,
        'maxTokens': 20000,
        'usedTokens': 15000,
        'extraTokens': 0,
        'remainingTokens': 5000,
      },
      'waterfall': {
        'originAt': 1000,
        'endAt': 61000,
        'durationMs': 60000,
        'total': 3,
        'truncated': 0,
        'items': [
          {
            'id': 'k1',
            'title': '写 src/a.js',
            'botId': 'b1',
            'botName': '甲',
            'state': 'completed',
            'stateText': '已完成',
            'phase': 'done',
            'startedAt': 1000,
            'endedAt': 31000,
            'durationMs': 30000,
            'offsetMs': 0,
            'dispatch': {'cloned': true, 'cloneId': 'k1', 'tier': 'strong', 'model': 'cloud/opus'},
            'critic': {'verdict': 'passed', 'rounds': 1, 'maxRounds': 2, 'defects': []},
            'worktree': {'status': 'merged', 'branch': 'orbis/task/k1', 'mergedHead': 'abc123', 'filesCount': 2},
            'tokens': {'input': 1000, 'output': 500, 'total': 1500},
            'costUsd': null,
          },
          {
            'id': 'k2',
            'title': '写 src/b.js',
            'botId': 'b2',
            'botName': '乙',
            'state': 'queued',
            'stateText': '准备中',
            'phase': 'active',
            'offsetMs': 30000,
            'durationMs': 1000,
            'checkpointBeforeRun': true,
            'waitingCheckpoint': true,
            'dispatch': {'cloned': false, 'tier': 'fast'},
            'worktree': {
              'status': 'conflict',
              'branch': 'orbis/task/k2',
              'conflictFiles': ['src/b.js'],
              'filesCount': 0,
            },
            'tokens': {'input': 0, 'output': 0, 'total': 0},
          },
        ],
      },
      'telemetry': {
        'totalTokens': 15000,
        'inputTokens': 10000,
        'outputTokens': 5000,
        'criticTokens': 200,
        'estimatedCostUsd': null,
        'budget': {'maxTokens': 20000, 'usedTokens': 15000, 'extraTokens': 0, 'remainingTokens': 5000},
        'byBot': [
          {'botId': 'b1', 'name': '甲', 'tokens': 9000, 'runs': 2, 'clonedRuns': 1},
          {'botId': 'b2', 'name': '乙', 'tokens': 6000, 'runs': 1, 'clonedRuns': 0},
        ],
        'byModel': [
          {'model': 'cloud/opus', 'tokens': 9000, 'runs': 2},
          {'model': 'default', 'tokens': 6000, 'runs': 1},
        ],
        'counts': {
          'childrenTotal': 3,
          'childrenDone': 1,
          'clonedRuns': 1,
          'criticReworks': 1,
          'worktreeMerged': 1,
          'worktreeConflicts': 1,
          'checkpointsPending': 1,
        },
      },
      'blackboard': [
        {'kind': 'constraint', 'authorName': '甲', 'text': '金额一律用 addMoney', 'ref': null, 'at': 1},
        {'kind': 'fact', 'authorName': '系统', 'text': '已合入主仓 abc123（2 个文件）', 'ref': 'src/a.js', 'at': 2},
      ],
      'updatedAt': 2000,
    };

/// 只实现任务接口的假 Api：记录调用并返回预设响应。
class _FakeApi extends Api {
  _FakeApi() : super('http://127.0.0.1:1', 'test-token');
  final List<({String method, String path, Map<String, dynamic>? body})> calls = [];

  @override
  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async {
    calls.add((method: 'get', path: path, body: null));
    return {'taskRun': detailJson()};
  }

  @override
  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic>? body, String? channel]) async {
    calls.add((method: 'post', path: path, body: body));
    return {'ok': true, 'taskRun': detailJson()};
  }

  @override
  Future<Map<String, dynamic>> patch(String path, [Map<String, dynamic>? body]) async {
    calls.add((method: 'patch', path: path, body: body));
    return {'ok': true};
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('TaskRun.fromJson 向后兼容', () {
    test('老服务端缺全部 C5 字段：不抛，回落为空/null', () {
      final run = TaskRun.fromJson(_legacyJson);
      expect(run.id, 'tr_1');
      expect(run.budget.maxRuns, 5);
      expect(run.budget.maxTokens, isNull, reason: '老快照没有 token 字段');
      expect(run.budget.hasTokenLimit, isFalse);
      expect(run.budget.tokensExhausted, isFalse, reason: '没设上限不能算用尽');
      expect(run.waterfall, isNull);
      expect(run.telemetry, isNull);
      expect(run.blackboard, isEmpty);
      expect(run.hasDetail, isFalse);
    });

    test('新详情快照：token / 瀑布流 / 遥测 / 黑板全部解析', () {
      final run = TaskRun.fromJson(detailJson());
      expect(run.budget.maxTokens, 20000);
      expect(run.budget.usedTokens, 15000);
      expect(run.budget.remainingTokens, 5000);
      expect(run.hasDetail, isTrue);

      final waterfall = run.waterfall!;
      expect(waterfall.items.length, 2);
      expect(waterfall.truncated, 0);
      expect(waterfall.durationMs, 60000);

      final a = waterfall.items.first;
      expect(a.botName, '甲');
      expect(a.cloned, isTrue);
      expect(a.tier, 'strong');
      expect(a.model, 'cloud/opus');
      expect(a.critic?.passed, isTrue);
      expect(a.worktree?.merged, isTrue);
      expect(a.totalTokens, 1500);
      expect(a.costUsd, isNull, reason: '没有单价就不是 0，而是 null');

      final b = waterfall.items.last;
      expect(b.waitingCheckpoint, isTrue);
      expect(b.worktree?.conflicted, isTrue);
      expect(b.hasDetails, isTrue, reason: '有冲突文件才值得展开');

      final telemetry = run.telemetry!;
      expect(telemetry.totalTokens, 15000);
      expect(telemetry.budgetRatio, closeTo(0.75, 0.001));
      expect(telemetry.estimatedCostUsd, isNull);
      expect(telemetry.byBot.first.label, '甲');
      expect(telemetry.byModel.first.label, 'cloud/opus');
      expect(telemetry.worktreeConflicts, 1);
      expect(telemetry.checkpointsPending, 1);

      expect(run.blackboard.length, 2);
      expect(run.blackboard.first.kind, 'constraint');

      // 甘特区间：永远落在 [0,1] 且宽度为正
      final span = waterfall.spanOf(a);
      expect(span.left, 0);
      expect(span.width, closeTo(0.5, 0.001));
      final spanB = waterfall.spanOf(b);
      expect(spanB.left, closeTo(0.5, 0.001));
      expect(spanB.width, greaterThan(0));
      expect(spanB.left + spanB.width, lessThanOrEqualTo(1.0001));
    });

    test('0 时长的树不会除零，也不出现负宽度', () {
      const waterfall = TaskRunWaterfall(durationMs: 0, items: []);
      final item = TaskRunWaterfallItem.fromJson({
        'id': 'k', 'botId': 'b', 'botName': '', 'state': 'queued',
        'stateText': '准备中', 'phase': 'active', 'offsetMs': 999, 'durationMs': 0,
      });
      final span = waterfall.spanOf(item);
      expect(span.left, 0);
      expect(span.width, 1);
    });
  });

  group('TaskWaterfallSection', () {
    Future<void> pump(
      WidgetTester tester,
      TaskRun run, {
      Future<void> Function(String id)? onApprove,
    }) async {
      final state = AppState();
      state.bots = [Bot(id: 'b1', name: '甲'), Bot(id: 'b2', name: '乙')];
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(light: false),
              home: Scaffold(
                body: SingleChildScrollView(
                  child: SizedBox(
                    width: 640,
                    child: TaskWaterfallSection(task: run, onApproveCheckpoint: onApprove),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('渲染 Token 总量、预算进度条、分身/档位/复核/冲突徽章', (tester) async {
      await pump(tester, TaskRun.fromJson(detailJson()));
      expect(find.textContaining('Token 与费用'), findsOneWidget);
      expect(find.textContaining('15,000 tokens'), findsOneWidget);
      expect(find.textContaining('输入 10,000'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsWidgets, reason: '预算进度条');
      expect(find.text('分身 1'), findsOneWidget);
      expect(find.text('复核返工 1'), findsOneWidget);
      expect(find.text('冲突 1'), findsOneWidget);
      // 子任务行 + 徽章
      expect(find.text('甲'), findsWidgets);
      expect(find.text('分身'), findsOneWidget);
      expect(find.text('strong'), findsOneWidget);
      expect(find.text('复核✓'), findsOneWidget);
      expect(find.textContaining('已合入'), findsWidgets);
      expect(find.text('冲突'), findsOneWidget);
      // 没有单价 → 不显示价格
      expect(find.textContaining('估算费用'), findsNothing);
    });

    testWidgets('等把关的子任务能点「放行」，回调收到子任务 id', (tester) async {
      final approved = <String>[];
      await pump(
        tester,
        TaskRun.fromJson(detailJson()),
        onApprove: (id) async => approved.add(id),
      );
      expect(find.text('等把关'), findsOneWidget);
      await tester.tap(find.text('放行'));
      await tester.pumpAndSettle();
      expect(approved, ['k2']);
    });

    testWidgets('展开能看到冲突文件与保留分支', (tester) async {
      await pump(tester, TaskRun.fromJson(detailJson()));
      expect(find.textContaining('冲突文件'), findsNothing);
      // 第二行（k2）有冲突文件 → 有展开按钮；点第一个可展开的箭头
      // 消耗明细开关也是一个 chevronRight（在遥测卡里），子任务行的展开键是最后一个
      final arrows = find.byIcon(LucideIcons.chevronRight);
      expect(arrows, findsWidgets);
      await tester.tap(arrows.last);
      await tester.pumpAndSettle();
      expect(find.textContaining('冲突文件：src/b.js'), findsOneWidget);
      expect(find.textContaining('已保留分支 orbis/task/k2'), findsOneWidget);
    });

    testWidgets('没有明细时 0 像素（不给详情弹窗凭空加高度）', (tester) async {
      await pump(tester, TaskRun.fromJson(_legacyJson));
      expect(find.textContaining('Token 与费用'), findsNothing);
      expect(find.textContaining('执行瀑布流'), findsNothing);
      final box = tester.getSize(find.byType(TaskWaterfallSection));
      expect(box.height, 0);
    });
  });

  group('控制器：详情与放行', () {
    test('fetchDetail 写回明细；随后的轻量快照不会把明细冲成 null', () async {
      final api = _FakeApi();
      final controller = TaskRunController(api: api);
      addTearDown(controller.dispose);
      final run = await controller.fetchDetail('tr_root');
      expect(run, isNotNull);
      expect(run!.waterfall, isNotNull);
      // 轻量快照（同一任务，无明细，版本更高）覆盖上来
      final light = Map<String, dynamic>.from(detailJson())
        ..remove('waterfall')
        ..remove('telemetry')
        ..remove('blackboard')
        ..['storeVersion'] = 13;
      controller.merge.applySnapshot({'tasks': [light]});
      final after = controller.merge.byId('tr_root')!;
      expect(after.waterfall, isNotNull, reason: '轻量推送不能把瀑布流冲掉');
      expect(after.telemetry, isNotNull);
      expect(after.blackboard, isNotEmpty);
    });

    test('approveCheckpoint 走 approve_checkpoint 并带 childTaskRunId', () async {
      final api = _FakeApi();
      final controller = TaskRunController(api: api);
      addTearDown(controller.dispose);
      final run = await controller.fetchDetail('tr_root');
      await controller.approveCheckpoint(run!, 'k2');
      final call = api.calls.last;
      expect(call.path, contains('/control'));
      expect(call.body?['type'], 'approve_checkpoint');
      expect(call.body?['childTaskRunId'], 'k2');
    });

    test('extend 支持 extraTokens；只加 token 时也带 expectedRevision', () async {
      final api = _FakeApi();
      final controller = TaskRunController(api: api);
      addTearDown(controller.dispose);
      final run = await controller.fetchDetail('tr_root');
      await controller.control(run!, type: 'extend', extraTokens: 50000);
      final call = api.calls.last;
      expect(call.body?['type'], 'extend');
      expect(call.body?['extraTokens'], 50000);
      expect(call.body?.containsKey('extraRuns'), isFalse); // 没填次数就不发这个字段
      expect(call.body?['expectedRevision'], run.revision);
    });
  });

  group('TaskRunSheet 追加额度', () {
    testWidgets('paused_budget + token 用尽：能打开并提交 extraTokens', (tester) async {
      // 详情弹窗比默认测试视口高：给一块够大的画布
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final api = _FakeApi();
      final state = AppState();
      addTearDown(state.dispose);
      state.taskRuns.bindApi(api);
      final paused = Map<String, dynamic>.from(detailJson())
        ..['state'] = 'paused_budget'
        ..['phase'] = 'paused'
        ..['stateText'] = '额度用尽'
        ..['budget'] = {
          'maxRuns': null,
          'usedRuns': 3,
          'extraRuns': 0,
          'maxTokens': 20000,
          'usedTokens': 20000,
          'extraTokens': 0,
          'remainingTokens': 0,
        };
      state.taskRuns.merge.applySnapshot({'tasks': [paused]});
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(light: false),
              home: const Scaffold(body: SizedBox.shrink()),
            ),
          ),
        ),
      );
      // 直接把详情弹窗放进树里（避免 showDialog 的命中测试干扰）
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(light: false),
              home: Scaffold(body: TaskRunSheet(state: state, taskRunId: 'tr_root')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('追加额度'), findsOneWidget, reason: 'token 用尽也要能追加');
      await tester.tap(find.text('追加额度'));
      await tester.pumpAndSettle();
      expect(find.text('增加多少 Token（可留空）'), findsOneWidget, reason: '必须能填 token');

      // 填 token 并提交
      final tokensField = find.widgetWithText(TextField, '增加多少 Token（可留空）');
      await tester.enterText(tokensField, '77777');
      await tester.tap(find.text('追加'));
      await tester.pumpAndSettle();

      final controlCalls = api.calls.where((c) => c.path.contains('/control')).toList();
      expect(controlCalls, isNotEmpty);
      expect(controlCalls.last.body?['type'], 'extend');
      expect(controlCalls.last.body?['extraTokens'], 77777);
    });
  });

  group('LessonAdoptionBanner', () {
    LibraryLesson candidate({
      String id = 'l1',
      String cue = '用户要求先给结论',
      String lesson = '先给结论再展开',
      List<LessonEvidence>? evidence,
      String roomId = 'r1',
    }) =>
        LibraryLesson(
          id: id,
          roomId: roomId,
          cue: cue,
          lesson: lesson,
          evidence: evidence ?? [LessonEvidence(quote: '先说结论')],
          status: 'candidate',
        );

    Future<AppState> pump(
      WidgetTester tester,
      List<LibraryLesson> lessons, {
      String roomId = 'r1',
    }) async {
      final state = AppState();
      state.lessons = lessons;
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(light: false),
              home: Scaffold(body: LessonAdoptionBanner(roomId: roomId)),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return state;
    }

    testWidgets('0 条候选时不占任何像素', (tester) async {
      await pump(tester, const []);
      final size = tester.getSize(find.byType(LessonAdoptionBanner));
      expect(size.height, 0);
      expect(find.textContaining('可以采纳的经验'), findsNothing);
    });

    testWidgets('展示情境 / 做法 / 证据原话', (tester) async {
      await pump(tester, [candidate()]);
      expect(find.textContaining('情境：用户要求先给结论'), findsOneWidget);
      expect(find.textContaining('做法：先给结论再展开'), findsOneWidget);
      expect(find.textContaining('证据：「先说结论」'), findsOneWidget);
      expect(find.text('一键采纳'), findsOneWidget);
      expect(find.text('忽略'), findsOneWidget);
    });

    testWidgets('一键采纳调用启用、忽略调用否决', (tester) async {
      final state = _SpyAppState();
      state.lessons = [candidate()];
      addTearDown(state.dispose);
      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(light: false),
              home: Scaffold(body: LessonAdoptionBanner(roomId: 'r1')),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('一键采纳'));
      await tester.pumpAndSettle();
      expect(state.statusCalls, [('l1', 'active')]);
      await tester.tap(find.text('忽略'));
      await tester.pumpAndSettle();
      expect(state.rejected, ['l1']);
    });

    testWidgets('无证据的候选：禁用采纳并说明原因', (tester) async {
      await pump(tester, [candidate(evidence: <LessonEvidence>[])]);
      final button = tester.widget<FilledButton>(find.widgetWithText(FilledButton, '一键采纳'));
      expect(button.onPressed, isNull); // 无证据不许采纳（与服务端 fail-closed 一致）
      expect(find.textContaining('暂不能采纳'), findsOneWidget);
    });

    testWidgets('超过 2 条只展示 2 条并提示还有几条', (tester) async {
      await pump(tester, [
        candidate(id: 'l1'),
        candidate(id: 'l2', cue: '情境二'),
        candidate(id: 'l3', cue: '情境三'),
      ]);
      expect(find.text('一键采纳'), findsNWidgets(2));
      expect(find.textContaining('还有 1 条'), findsOneWidget);
    });
  });
}

class _SpyAppState extends AppState {
  final List<(String, String)> statusCalls = [];
  final List<String> rejected = [];

  @override
  Future<String?> setLessonStatus(String id, String status) async {
    statusCalls.add((id, status));
    return null;
  }

  @override
  Future<String?> rejectLesson(String id) async {
    rejected.add(id);
    return null;
  }
}
