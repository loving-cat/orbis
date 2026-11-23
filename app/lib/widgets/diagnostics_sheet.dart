import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../l10n/l10n.dart';
import '../scope.dart';
import '../theme.dart';

/// 后台诊断日志面板（Mac 实机 UX-4）。
///
/// 两个 Tab：
///   1. **模型请求异常**：时间 / Bot·房间 / 模型 / HTTP 与网络错误码 / 耗时 /
///      可展开可复制的脱敏上游报错 —— 一眼看清是中转站 502、模型名错，还是思考参数不支持；
///   2. **服务端日志**：`server.log` 尾部（手机端也能看），一键刷新 / 复制。
///
/// 为什么要做在 App 里：气泡上写着「请检查服务端日志」，而手机用户根本打不开
/// 那个文件；桌面端打开也只看得到「接口详情已隐藏」。排障必须闭环。
/// 拉取诊断数据的入口（可注入：widget 测试里给的假实现）。
typedef DiagnosticsLoader = Future<Map<String, dynamic>?> Function({int limit});

/// 默认实现：走只读接口 `GET /api/diagnostics/logs`。
Future<Map<String, dynamic>?> fetchDiagnostics(AppState state, {int limit = 100}) async =>
    state.api?.get('/api/diagnostics/logs', query: {'limit': '$limit'});

Future<void> showDiagnosticsSheet(
  BuildContext context, {
  int initialTab = 0,
  DiagnosticsLoader? loader,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: PB.bgPane,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (context) => FractionallySizedBox(
      heightFactor: 0.86,
      child: _DiagnosticsPanel(
        initialTab: initialTab,
        loader: loader,
      ),
    ),
  );
}

class _DiagnosticsPanel extends StatefulWidget {
  const _DiagnosticsPanel({required this.initialTab, this.loader});

  final int initialTab;

  /// 为空时用 [fetchDiagnostics]（真接口）；测试注入假实现。
  final DiagnosticsLoader? loader;

  @override
  State<_DiagnosticsPanel> createState() => _DiagnosticsPanelState();
}

class _DiagnosticsPanelState extends State<_DiagnosticsPanel>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(
    length: 2,
    vsync: this,
    initialIndex: widget.initialTab.clamp(0, 1),
  );
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _modelErrors = const [];
  List<String> _serverLog = const [];
  String _logPath = '';

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // ★ 不能在 initState 里读 AppScope（那时还没挂上）；第一次依赖变化再拉数据。
    if (_started) return;
    _started = true;
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final state = AppScope.read(context);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final loader = widget.loader ?? (({int limit = 100}) => fetchDiagnostics(state, limit: limit));
      final body = await loader(limit: 100);
      if (!mounted) return;
      setState(() {
        _modelErrors = ((body?['modelErrors'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList(growable: false);
        _serverLog = ((body?['serverLogTail'] as List?) ?? const [])
            .map((e) => '$e')
            .toList(growable: false);
        _logPath = '${body?['logPath'] ?? ''}';
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String get _copyText {
    final buffer = StringBuffer();
    for (final item in _modelErrors) {
      buffer.writeln(
        '[${_time(item['ts'])}] ${item['phase']} · ${item['roomName']} / ${item['botName']}'
        ' · ${item['model']} · ${item['status'] ?? '-'} · ${item['summary']}',
      );
      buffer.writeln('    ${item['detail'] ?? ''}');
    }
    buffer.writeln('--- server.log ($_logPath) ---');
    buffer.writeAll(_serverLog, '\n');
    return buffer.toString();
  }

  static String _time(Object? value) {
    final ts = value is num ? value.toInt() : int.tryParse('$value') ?? 0;
    if (ts <= 0) return '-';
    final dt = DateTime.fromMillisecondsSinceEpoch(ts);
    String two(int v) => v.toString().padLeft(2, '0');
    return '${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}:${two(dt.second)}';
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
          child: Row(
            children: [
              const Icon(LucideIcons.scrollText, size: 16),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  strings.t('diag.title'),
                  style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                ),
              ),
              IconButton(
                tooltip: strings.t('diag.refresh'),
                onPressed: _loading ? null : _load,
                icon: const Icon(LucideIcons.refreshCw, size: 16),
                visualDensity: VisualDensity.compact,
              ),
              IconButton(
                tooltip: strings.t('common.copy'),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: _copyText));
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(strings.t('diag.copied'))),
                  );
                },
                icon: const Icon(LucideIcons.copy, size: 16),
                visualDensity: VisualDensity.compact,
              ),
              IconButton(
                tooltip: strings.t('diag.close'),
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(LucideIcons.x, size: 16),
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
        ),
        TabBar(
          controller: _tabs,
          labelColor: PB.colors(context).accentBright,
          unselectedLabelColor: PB.textTertiary,
          tabs: [
            Tab(text: strings.t('diag.tabModel')),
            Tab(text: strings.t('diag.tabServer')),
          ],
        ),
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(_error!, style: TextStyle(fontSize: PB.fsXs, color: PB.danger)),
          ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _ModelErrorList(items: _modelErrors, time: _time),
              _ServerLogView(lines: _serverLog, logPath: _logPath),
            ],
          ),
        ),
      ],
    );
  }
}

class _ModelErrorList extends StatelessWidget {
  const _ModelErrorList({required this.items, required this.time});

  final List<Map<String, dynamic>> items;
  final String Function(Object?) time;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    if (items.isEmpty) {
      return Center(
        child: Text(
          strings.t('diag.emptyModel'),
          style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 20),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final item = items[index];
        final status = item['status'];
        final code = '${item['code'] ?? ''}';
        return Container(
          padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
          decoration: BoxDecoration(
            color: PB.bgElevated,
            borderRadius: BorderRadius.circular(PB.rLg),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    time(item['ts']),
                    style: TextStyle(fontFamily: PB.monoFamily, fontSize: PB.fsXxs, color: PB.textQuaternary),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${item['roomName'] ?? ''} · ${item['botName'] ?? ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: PB.fsXs, color: PB.textSecondary),
                    ),
                  ),
                  if (status != null)
                    Text(
                      'HTTP $status',
                      style: TextStyle(fontSize: PB.fsXxs, color: PB.danger),
                    ),
                  if (code.isNotEmpty) ...[
                    const SizedBox(width: 6),
                    Text(code, style: TextStyle(fontSize: PB.fsXxs, color: PB.warn)),
                  ],
                ],
              ),
              const SizedBox(height: 3),
              Text(
                '${item['model'] ?? ''}${item['ms'] != null ? ' · ${item['ms']}ms' : ''}',
                style: TextStyle(fontFamily: PB.monoFamily, fontSize: PB.fsXxs, color: PB.textQuaternary),
              ),
              const SizedBox(height: 4),
              Text(
                '${item['summary'] ?? ''}',
                style: TextStyle(fontSize: PB.fsXs, color: PB.textPrimary, height: 1.5),
              ),
              // ★ 裸 ExpansionTile 在带背景的 Container 里会触发 ListTile 的
              //   "ink 可能看不见" 断言；包一层透明 Material 就正常了。
              Material(
                type: MaterialType.transparency,
                child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                dense: true,
                title: Text(
                  strings.t('diag.showDetail'),
                  style: TextStyle(fontSize: PB.fsXxs, color: PB.textTertiary),
                ),
                children: [
                  SelectableText(
                    '${item['detail'] ?? ''}',
                    style: TextStyle(
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                      fontSize: PB.fsXxs,
                      color: PB.textSecondary,
                      height: 1.5,
                    ),
                  ),
                ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _ServerLogView extends StatelessWidget {
  const _ServerLogView({required this.lines, required this.logPath});

  final List<String> lines;
  final String logPath;

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (logPath.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
            child: SelectableText(
              logPath,
              style: TextStyle(fontFamily: PB.monoFamily, fontSize: PB.fsXxs, color: PB.textQuaternary),
            ),
          ),
        Expanded(
          child: lines.isEmpty
              ? Center(
                  child: Text(
                    strings.t('diag.emptyServer'),
                    style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                  ),
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(14, 8, 14, 20),
                  child: SelectableText(
                    lines.join('\n'),
                    style: TextStyle(
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                      fontSize: PB.fsXxs,
                      color: PB.textSecondary,
                      height: 1.5,
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}
