import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';

/// 「数据还没迁移」的阻断页。
///
/// 用户从 1.7 升上来、先打开 2.0 时会看到它：服务端这次只以**待迁移模式**在跑
/// （不建库、不生成密钥与证书），进去只能看到一页空聊天。
/// 与其让人以为"数据丢了"，不如把两条真实路径和一行可复制的命令摆在面前。
class MigrationGateScreen extends StatelessWidget {
  const MigrationGateScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final strings = L10n.s(context);
    final status = state.migrationStatus;
    final command = status.migrateCommand;

    return Scaffold(
      backgroundColor: PB.bgPane,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    const Icon(Icons.drive_file_move_outline, size: 22),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        strings.t('migrate.title'),
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  strings.t('migrate.body'),
                  style: TextStyle(fontSize: 13, color: PB.textSecondary, height: 1.6),
                ),
                const SizedBox(height: 16),
                _PathLine(
                  label: strings.t('migrate.oldDir'),
                  value: status.legacyDataDir.isEmpty ? '—' : status.legacyDataDir,
                ),
                const SizedBox(height: 6),
                _PathLine(
                  label: strings.t('migrate.newDir'),
                  value: status.targetDataDir.isEmpty ? '—' : status.targetDataDir,
                ),
                const SizedBox(height: 16),
                Text(
                  strings.t('migrate.step'),
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 6),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: PB.bgElevated,
                    borderRadius: BorderRadius.circular(PB.rLg),
                    border: Border.all(color: PB.borderSecondary),
                  ),
                  child: SelectableText(
                    command,
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      icon: const Icon(Icons.copy, size: 16),
                      label: Text(strings.t('common.copy')),
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: command));
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(strings.t('migrate.copied'))),
                        );
                      },
                    ),
                    FilledButton.icon(
                      icon: const Icon(Icons.refresh, size: 16),
                      label: Text(strings.t('migrate.recheck')),
                      onPressed: () async {
                        final ok = await state.recheckMigration();
                        if (!context.mounted || ok) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(strings.t('migrate.stillNeeded'))),
                        );
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text(
                  strings.t('migrate.workspace'),
                  style: TextStyle(fontSize: 12, color: PB.textTertiary, height: 1.6),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PathLine extends StatelessWidget {
  const _PathLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 92,
          child: Text(
            label,
            style: TextStyle(fontSize: 12, color: PB.textTertiary),
          ),
        ),
        Expanded(
          child: SelectableText(
            value,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
          ),
        ),
      ],
    );
  }
}
