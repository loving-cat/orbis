import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/launcher.dart';

/// 2.0 起状态目录名**固定**是新名字。
///
/// 和服务端 `server/src/config.js` 的 `resolveHomeDir` 必须同一套策略（只认新目录，
/// 旧目录靠 `orbis migrate` 复制）。两边不一致会出现
/// 「App 日志在新目录、服务端数据在旧目录」的分叉。
void main() {
  group('状态目录名判定', () {
    test('两个都不存在 → 用新名 orbis', () {
      final name = resolveStateDirName(
        '/base',
        exists: (_) => false,
      );
      expect(name, 'orbis');
    });

    test('★ 只有旧目录存在 → 仍用 orbis（2.0 不再沿用旧目录）', () {
      final name = resolveStateDirName(
        '/base',
        // legacy-guard-ok: 回归用例说明
        exists: (p) => p.endsWith('pi-bot'),
      );
      expect(name, 'orbis', reason: '服务端数据已经在新目录，App 不能还留在旧目录');
    });

    test('旧目录存在但有新目录 → 用新名（已经迁过就按新的走）', () {
      final name = resolveStateDirName('/base', exists: (_) => true);
      expect(name, 'orbis');
    });

    test('只有新目录存在 → 用新名', () {
      final name = resolveStateDirName(
        '/base',
        exists: (p) => p.endsWith('orbis'),
      );
      expect(name, 'orbis');
    });

    test('判存在性时抛异常 → 不崩，按新名走', () {
      final name = resolveStateDirName(
        '/base',
        exists: (_) => throw StateError('boom'),
      );
      expect(name, 'orbis');
    });

    test('判存在性根本不会被调用（固定用新名，不再看旧目录）', () {
      final seen = <String>[];
      final name = resolveStateDirName(
        '/base',
        exists: (p) {
          seen.add(p);
          return true;
        },
      );
      expect(name, 'orbis');
      expect(seen, isEmpty, reason: '2.0 不再用目录存在性做判断');
    });
  });

  test('品牌常量与服务端保持一致（改一处必须改两处）', () {
    // 服务端 server/src/config.js：
    //   HOME_DIR_NAME = 'orbis'；LEGACY_HOME_DIR_NAME = 'pi-bot'
    expect(stateDirNameNew, 'orbis');
    expect(stateDirNameLegacy, 'pi-bot');
  });
}
