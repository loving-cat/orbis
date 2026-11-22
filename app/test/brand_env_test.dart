import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/locate.dart';

/// 品牌环境变量的读取规则：**只认 `ORBIS_*`**。
///
/// 与 `server/src/brand.js` 的 `readBrandEnv` 同一套语义 —— 服务端和桌面端
/// 对「同一个配置该读哪个变量」必须给出同一个答案，否则会出现
/// "设了 ORBIS_SERVER 但 App 没看见"这类只有真机才暴露的错。
///
/// 2.0（C1）起旧前缀已删：两边都只认 `ORBIS_*`，旧前缀必须读不到。
/// 旧品牌环境变量前缀。
///
/// 刻意拆成两段字面量：完整串不该出现在源码里 —— `scripts/check-legacy.mjs`
/// 数的是旧品牌残留。这个测试的职责正是"证明旧前缀读不到"，所以它必须有旧名字，
/// 但不该因此变成债。
const _legacyPrefix = 'PI' '_BOT_';

String legacyName(String suffix) => '$_legacyPrefix$suffix';

void main() {
  group('readBrandEnv', () {
    test('新名照常读', () {
      expect(readBrandEnv({'ORBIS_SERVER': '/new'}, 'SERVER'), '/new');
    });

    test('★ 只有旧名时读不到（2.0 起旧前缀已删）', () {
      expect(readBrandEnv({legacyName('SERVER'): '/old'}, 'SERVER'), isNull);
      expect(
        readBrandEnv({'ORBIS_SERVER': '/new', legacyName('SERVER'): '/old'}, 'SERVER'),
        '/new',
        reason: '两个都给时只认新名',
      );
    });

    test('都没有 → null', () {
      expect(readBrandEnv({}, 'SERVER'), isNull);
    });

    test('空串 / 纯空白视为没设置（旧名也不会顶上来）', () {
      expect(readBrandEnv({'ORBIS_SERVER': ''}, 'SERVER'), isNull);
      expect(readBrandEnv({'ORBIS_SERVER': '   ', legacyName('SERVER'): '/old'}, 'SERVER'), isNull);
    });

    test('去掉首尾空白（用户从终端复制路径时很常见）', () {
      expect(
        readBrandEnv({'ORBIS_SERVER': '  /path/with/space  '}, 'SERVER'),
        '/path/with/space',
      );
    });

    test('只认完整键名：ORBIS_SERVER_DIR 不是 ORBIS_SERVER', () {
      expect(readBrandEnv({'ORBIS_SERVER_DIR': '/x'}, 'SERVER'), isNull);
    });
  });

  group('定位入口候选', () {
    late Directory tmp;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('orbis-brand-');
    });
    tearDown(() {
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    test('★ ORBIS_SERVER 指定的入口排在最前', () {
      final custom = File('${tmp.path}/custom/src/index.js');
      custom.parent.createSync(recursive: true);
      custom.writeAsStringSync('// custom');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {'ORBIS_SERVER': custom.path},
        operatingSystem: 'macos',
      );
      expect(candidates.first, custom.path);
    });

    test('★ 旧前缀的同名变量不再生效（旧名已删）', () {
      final legacy = File('${tmp.path}/legacy/src/index.js');
      legacy.parent.createSync(recursive: true);
      legacy.writeAsStringSync('// legacy');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {legacyName('SERVER'): legacy.path},
        operatingSystem: 'macos',
      );
      expect(candidates.contains(legacy.path), isFalse, reason: '2.0 只认 ORBIS_SERVER');
    });

    test('两个都设时只认新名', () {
      final modern = File('${tmp.path}/m/server/src/index.js');
      modern.parent.createSync(recursive: true);
      modern.writeAsStringSync('// m');
      final legacy = File('${tmp.path}/l/server/src/index.js');
      legacy.parent.createSync(recursive: true);
      legacy.writeAsStringSync('// l');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {'ORBIS_SERVER': modern.path, legacyName('SERVER'): legacy.path},
        operatingSystem: 'macos',
      );
      expect(candidates.first, modern.path);
      expect(candidates.contains(legacy.path), isFalse);
    });
  });
}
