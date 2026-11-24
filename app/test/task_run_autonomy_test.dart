// 任务详情「自主推进」开关：投影解析 + 命令通道。
//
// 纯 test 文件（不含 testWidgets）：真 HTTP 走 MockClient，见 api_client_header_test.dart
// 同样的写法。界面渲染在 task_run_autonomy_sheet_test.dart。
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/task_run_controller.dart';
import 'package:pi_bot/task_run_models.dart';

Map<String, dynamic> _json({
  String state = 'running',
  bool? autonomous,
  String? autonomyReason,
}) =>
    {
      'id': 'tr1',
      'roomId': 'r1',
      'rootTaskId': 'tr1',
      'revision': 7,
      'sequence': 1,
      'storeVersion': 3,
      'state': state,
      'title': '把调研做完',
      'scope': '',
      'deliverables': <String>[],
      'updatedAt': 1000,
      if (autonomous != null) 'autonomous': autonomous,
      if (autonomyReason != null) 'autonomyReason': autonomyReason,
    };

void main() {
  group('投影解析', () {
    test('下发了 autonomous 就照实取', () {
      final run = TaskRun.fromJson(_json(autonomous: true, autonomyReason: ''));
      expect(run.autonomous, isTrue);
      expect(run.autonomyReason, isEmpty);
    });

    test('投影里没有这个字段时按「每到关口先问你」处理', () {
      final run = TaskRun.fromJson(_json());
      expect(run.autonomous, isFalse, reason: '不该替用户猜一个更激进的值');
      expect(run.autonomyReason, isEmpty);
    });

    test('autonomyReason 原样带出来（服务端已截断）', () {
      final run = TaskRun.fromJson(_json(autonomous: false, autonomyReason: '你说过要先问我'));
      expect(run.autonomyReason, '你说过要先问我');
    });

    test('终态任务不允许再改开关', () {
      expect(TaskRun.fromJson(_json(state: 'running')).canToggleAutonomy, isTrue);
      expect(TaskRun.fromJson(_json(state: 'paused_user')).canToggleAutonomy, isTrue);
      expect(TaskRun.fromJson(_json(state: 'completed')).canToggleAutonomy, isFalse);
      expect(TaskRun.fromJson(_json(state: 'cancelled')).canToggleAutonomy, isFalse);
    });
  });

  group('控制命令', () {
    late List<http.Request> sent;

    test('开关走 /control：type=autonomy + decision=on/off + 当前 revision', () async {
      sent = <http.Request>[];
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(
          jsonEncode({'ok': true, 'taskRun': _json(autonomous: true)}),
          200,
          headers: const {'content-type': 'application/json'},
        );
      });
      final controller = TaskRunController(api: Api('http://127.0.0.1:1', 'fake-token'));
      final task = TaskRun.fromJson(_json(autonomous: false));

      await http.runWithClient(() async {
        await controller.control(task, type: 'autonomy', decision: 'on');
      }, () => client);

      expect(sent, hasLength(1));
      final req = sent.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/api/task-runs/tr1/control');
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['type'], 'autonomy');
      expect(body['decision'], 'on');
      expect(body['commandId'], isNotEmpty);
      expect(body['expectedRevision'], 7);
    });

    test('未知结果重试复用同一个 commandId（服务端按幂等回放）', () async {
      sent = <http.Request>[];
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(
          jsonEncode({'ok': true, 'taskRun': _json(autonomous: false)}),
          200,
          headers: const {'content-type': 'application/json'},
        );
      });
      final controller = TaskRunController(api: Api('http://127.0.0.1:1', 'fake-token'));
      final task = TaskRun.fromJson(_json(autonomous: true));

      await http.runWithClient(() async {
        await controller.control(task, type: 'autonomy', decision: 'off');
        await controller.retryLastControl();
      }, () => client);

      expect(sent, hasLength(2));
      final first = jsonDecode(sent[0].body) as Map<String, dynamic>;
      final second = jsonDecode(sent[1].body) as Map<String, dynamic>;
      expect(second['commandId'], first['commandId'], reason: '重试必须复用同一个命令号');
      expect(second['decision'], 'off');
    });
  });
}
