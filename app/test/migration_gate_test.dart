// 「先迁移数据」阻断页：路径与命令必须真的显示出来。
//
// 用户从 1.7 升上来，最怕的是"点开之后一片空白，以为数据没了"。
// 这一页要做的只有一件事：把两条真实路径与一行可复制的命令摆出来。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/migration_gate.dart';
import 'package:pi_bot/server/health.dart';

class _State extends AppState {}

void main() {
  testWidgets('★ 显示旧/新路径与可复制命令（不是一页空白）', (tester) async {
    final state = _State()
      ..migrationStatus = const MigrationStatus(
        needed: true,
        legacyDataDir: '/old/legacy/data',
        targetDataDir: '/new/orbis/data',
      );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: MigrationGateScreen()),
      ),
    );
    await tester.pump();

    expect(find.textContaining('先迁移数据'), findsOneWidget);
    // 路径在「目录行」和「命令」里各出现一次
    expect(find.textContaining('/old/legacy/data'), findsWidgets);
    expect(find.textContaining('/new/orbis/data'), findsWidgets);
    expect(
      find.textContaining('orbis migrate --from "/old/legacy/data"'),
      findsOneWidget,
    );
    expect(find.textContaining('workspace'), findsWidgets, reason: '要提醒旧目录仍然不能删');
    expect(find.textContaining('我已手动迁移'), findsOneWidget, reason: '要有「重新检查」入口');
  });

  testWidgets('★ 桌面本机模式：主按钮是「一键迁移并重启」', (tester) async {
    final state = _State()
      ..localMode = true
      ..migrationStatus = const MigrationStatus(
        needed: true,
        legacyDataDir: '/old/legacy/data',
        targetDataDir: '/new/orbis/data',
        command: '"node" "index.js" migrate --from "/old/legacy/data" --to "/new/orbis/data"',
      );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: MigrationGateScreen()),
      ),
    );
    await tester.pump();

    expect(find.text('一键迁移并重启'), findsOneWidget, reason: '桌面用户要能一键跑（没有 orbis 在 PATH 上）');
    expect(find.text('复制'), findsWidgets);
    expect(find.textContaining('我已手动迁移'), findsOneWidget);
    expect(find.textContaining('"node" "index.js" migrate'), findsOneWidget);
  });

  testWidgets('recheckMigration 在没有连接时什么都不做（返回 false，不抛）', (tester) async {
    final state = _State()
      ..migrationStatus = const MigrationStatus(needed: true);
    addTearDown(state.dispose);
    expect(await state.recheckMigration(), isFalse);
  });
}
