// 「待迁移」状态的解析与命令拼装（P0-2 的 App 侧）。
//
// 服务端在旧目录有数据、新目录还没有时只回 /health；用户看到的那一页
// 完全依赖这两个路径拼出来的命令，拼错就等于把人指去一个不存在的目录。
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/health.dart';

void main() {
  test('needsMigration 为 false / 缺字段 → 不需要迁移', () {
    expect(MigrationStatus.fromHealth('{"ok":true}').needed, isFalse);
    expect(
      MigrationStatus.fromHealth('{"ok":true,"needsMigration":false}').needed,
      isFalse,
    );
    expect(MigrationStatus.fromHealth('not json').needed, isFalse);
  });

  test('★ needed + 两个路径都解析出来', () {
    final s = MigrationStatus.fromHealth(
      '{"ok":true,"needsMigration":true,'
      '"legacyDataDir":"/old/legacy/data","targetDataDir":"/new/orbis/data"}',
    );
    expect(s.needed, isTrue);
    expect(s.legacyDataDir, '/old/legacy/data');
    expect(s.targetDataDir, '/new/orbis/data');
  });

  test('★ 命令带引号（Windows 路径有空格），两个路径都在', () {
    const s = MigrationStatus(
      needed: true,
      legacyDataDir: r'C:\Users\A B\AppData\Local\legacy\data',
      targetDataDir: r'C:\Users\A B\AppData\Local\orbis\data',
    );
    expect(
      s.migrateCommand,
      'orbis migrate --from "C:\\Users\\A B\\AppData\\Local\\legacy\\data" '
      '--to "C:\\Users\\A B\\AppData\\Local\\orbis\\data"',
    );
  });

  test('★ 服务端给的真实命令优先（桌面安装包没有 orbis 在 PATH 上）', () {
    const raw = r'"C:\Program Files\Orbis\orbis.exe" '
        r'"C:\Program Files\Orbis\resources\server\src\index.js" '
        r'migrate --from "C:\old" --to "C:\new"';
    final s = MigrationStatus.fromHealth(
      '{"ok":true,"needsMigration":true,'
      '"legacyDataDir":"/old","targetDataDir":"/new",'
      '"migrateCommand":${const JsonEncoder().convert(raw)}}',
    );
    expect(s.migrateCommand, raw, reason: '要原样用服务端下发的命令');
    expect(s.migrateCommand.contains('orbis.exe'), isTrue);
  });

  test('服务端没给命令时回落到旧拼接（老服务端 / CLI 安装）', () {
    final s = MigrationStatus.fromHealth(
      '{"ok":true,"needsMigration":true,'
      '"legacyDataDir":"/old","targetDataDir":"/new"}',
    );
    expect(s.migrateCommand, 'orbis migrate --from "/old" --to "/new"');
  });

  test('缺路径时不拼出半条命令（宁可不给，也不给错的）', () {
    const onlyFrom = MigrationStatus(needed: true, legacyDataDir: '/old');
    expect(onlyFrom.migrateCommand, 'orbis migrate --from "/old"');
    const empty = MigrationStatus(needed: true);
    expect(empty.migrateCommand, 'orbis migrate');
  });
}
