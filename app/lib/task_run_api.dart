/// TaskRun HTTP API：只封装协议，不持状态。
library;

import 'api.dart';
import 'task_run_models.dart';

class TaskRunApiException implements Exception {
  TaskRunApiException(this.message, {this.status, this.code});
  final String message;
  final int? status;
  final String? code;

  @override
  String toString() => message;
}

class TaskRunApi {
  TaskRunApi(this.api);

  final Api api;

  Future<Map<String, dynamic>> page({String? scope, int? limit, String? cursor}) async {
    final query = <String, String>{
      if (scope != null) 'scope': scope,
      if (limit != null) 'limit': limit.toString(),
      if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
    };
    return api.get('/api/task-runs', query: query.isEmpty ? null : query);
  }

  Future<List<TaskRun>> list({bool includeDone = true, String? scope, int? limit}) async {
    final query = <String, String>{
      if (!includeDone) 'done': '0',
      if (scope != null) 'scope': scope,
      if (limit != null) 'limit': limit.toString(),
    };
    final body = await api.get('/api/task-runs', query: query.isEmpty ? null : query);
    final tasks = (body['tasks'] as List?) ?? const [];
    return tasks
        .whereType<Map>()
        .map((raw) => TaskRun.fromJson(raw.cast<String, dynamic>()))
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> snapshot(String id, {int? since}) async {
    return api.get('/api/task-runs/$id', query: since == null ? null : {'since': '$since'});
  }

  /// 单任务完整快照（含 waterfall / telemetry / blackboard）。
  ///
  /// ★ 与 `snapshot()` 打同一个接口，但明确要求详情字段：列表与 WS 推送
  ///   都不带这些，只有这里拿到才能把全景刷新出来。
  Future<TaskRun?> fetchDetail(String id) async {
    final body = await api.get('/api/task-runs/$id');
    final raw = body['taskRun'];
    if (raw is! Map) return null;
    return TaskRun.fromJson(raw.cast<String, dynamic>());
  }

  Future<Map<String, dynamic>> control({
    required TaskRun task,
    required String type,
    required String commandId,
    int? expectedRevision,
    String? ref,
    String? text,
    String? decision,
    String? reason,
    int? extraRuns,
    int? extraTokens,
    String? childTaskRunId,
  }) async {
    return api.post('/api/task-runs/${task.id}/control', {
      'type': type,
      'commandId': commandId,
      'expectedRevision': expectedRevision ?? task.revision,
      if (ref != null) 'ref': ref,
      if (text != null) 'text': text,
      if (decision != null) 'decision': decision,
      if (reason != null) 'reason': reason,
      if (extraRuns != null) 'extraRuns': extraRuns,
      if (extraTokens != null) 'extraTokens': extraTokens,
      if (childTaskRunId != null) 'childTaskRunId': childTaskRunId,
    });
  }
}
