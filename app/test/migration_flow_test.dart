// 「待迁移」的早退与重新检查（P1-4）。
//
// ★ 这个文件**只放纯 test()**：一旦出现 testWidgets，flutter_test 会把 HttpClient
//   换成固定 400 的假实现，真 HTTP 就不会发生了。所以这里起真的本地 HttpServer 喂 /health。
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/server/health.dart';

class _State extends AppState {}

Map<String, dynamic> _health({
  bool needed = true,
  String legacy = '/old/legacy/data',
  String target = '/new/orbis/data',
  String auth = 'local',
}) => {
  'ok': true,
  'serverName': 'Orbis',
  'version': '2.0.0',
  'auth': auth,
  'needsMigration': needed,
  'legacyDataDir': needed ? legacy : '',
  'targetDataDir': target,
};

Future<HttpServer> _serve(Map<String, dynamic> Function() body) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((req) async {
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(body()));
    await req.response.close();
  });
  return server;
}

void main() {
  test('★ connectLocal 检测到待迁移 → 早退（不进 refresh，不碰 prefs）', () async {
    final server = await _serve(() => _health(needed: true));
    addTearDown(server.close);
    final state = _State();
    addTearDown(state.dispose);

    await state.connectLocal(url: 'http://127.0.0.1:${server.port}');

    expect(state.migrationNeeded, isTrue);
    expect(state.link, LinkState.offline, reason: '待迁移时不该假装连上了');
    expect(state.rooms, isEmpty);
    expect(state.migrationStatus.legacyDataDir, '/old/legacy/data');
    // 早退的实证：如果继续走 refresh()/prefs，这个纯 Dart 测试会抛
    // MissingPluginException（SharedPreferences 没有实现）。
  });

  test('★ recheckMigration（远程）：needsMigration 变 false → 返回 true', () async {
    var needed = true;
    final server = await _serve(() => _health(needed: needed, auth: 'token'));
    addTearDown(server.close);
    final state = _State()..serverUrl = 'http://127.0.0.1:${server.port}';
    addTearDown(state.dispose);

    expect(await state.recheckMigration(), isFalse, reason: '还没迁完');
    needed = false;
    expect(await state.recheckMigration(), isTrue, reason: '迁完后要能进入正常界面');
    expect(state.migrationNeeded, isFalse);
  });

  test('★ runAutoMigration：定位不到内置服务端时返回可读错误（不抛）', () async {
    final state = _State()
      ..localMode = true
      ..migrationStatus = const MigrationStatus(
        needed: true,
        legacyDataDir: '/old/legacy/data',
        targetDataDir: '/new/orbis/data',
      );
    addTearDown(state.dispose);
    final err = await state.runAutoMigration();
    expect(err, isNotEmpty, reason: '失败必须把原因交回界面');
  });

  test('runAutoMigration：不需要迁移时直接返回空串（幂等，不误跑）', () async {
    final state = _State();
    addTearDown(state.dispose);
    expect(await state.runAutoMigration(), isEmpty);
  });

  test('recheckMigration：连不上时按"不需要迁移"处理（不把用户锁在阻断页）', () async {
    final state = _State()..serverUrl = 'http://127.0.0.1:1';
    addTearDown(state.dispose);
    expect(await state.recheckMigration(), isTrue);
    expect(state.migrationNeeded, isFalse);
  });
}
