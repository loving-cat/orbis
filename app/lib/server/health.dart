import 'dart:convert';
import 'dart:typed_data';

/// 健康响应正文的原始字节上限。
const maxHealthResponseBytes = 64 * 1024;

/// 读取有大小上限的 UTF8 正文；超限立即停止消费并返回 null。
Future<String?> readHealthResponseBody(Stream<List<int>> chunks) async {
  final bytes = BytesBuilder();
  await for (final chunk in chunks) {
    if (chunk.length > maxHealthResponseBytes - bytes.length) return null;
    bytes.add(chunk);
  }
  return utf8.decode(bytes.takeBytes());
}

/// 校验本机服务端健康响应：成功标记与非空的服务名称、版本缺一不可。
bool isOrbisHealthResponse(String body) {
  try {
    final value = jsonDecode(body);
    if (value is! Map<String, dynamic>) return false;
    final name = value['serverName'];
    final version = value['version'];
    return value['ok'] == true &&
        name is String &&
        name.trim().isNotEmpty &&
        version is String &&
        version.trim().isNotEmpty;
  } on FormatException {
    return false;
  }
}

/// 服务端要不要本机请求也带 token（`/health` 的 `auth` 字段）。
///
/// 服务器模式（服务端设了 `ORBIS_TOKEN`，旧名 `ORBIS_TOKEN` 也认）回 `token`；本机部署回 `local`。
/// 旧版服务端没有这个字段，按 `local` 处理。
bool healthRequiresToken(String body) {
  try {
    final value = jsonDecode(body);
    return value is Map<String, dynamic> && value['auth'] == 'token';
  } on FormatException {
    return false;
  }
}

/// 服务端的「待迁移」状态（`/health` 的 `needsMigration` / 两个目录）。
///
/// 服务端发现「1.7 旧目录有数据、新目录还没有」时会以**待迁移模式**启动：
/// 它只回 `/health`，不建空库、不生成密钥与证书。这时 App 不该让用户进到
/// 一页空聊天里以为数据丢了，而要把命令摆在他面前。
class MigrationStatus {
  const MigrationStatus({
    required this.needed,
    this.legacyDataDir = '',
    this.targetDataDir = '',
  });

  final bool needed;
  final String legacyDataDir;
  final String targetDataDir;

  static const none = MigrationStatus(needed: false);

  /// 可以直接粘进终端的迁移命令（两个路径都加引号：Windows 上有空格）。
  String get migrateCommand {
    final from = legacyDataDir.isEmpty ? '' : '--from "$legacyDataDir" ';
    final to = targetDataDir.isEmpty ? '' : '--to "$targetDataDir"';
    return 'orbis migrate $from$to'.trim();
  }

  static MigrationStatus fromHealth(String body) {
    try {
      final value = jsonDecode(body);
      if (value is! Map<String, dynamic>) return none;
      final needed = value['needsMigration'] == true;
      if (!needed) return none;
      final legacy = value['legacyDataDir'];
      final target = value['targetDataDir'];
      return MigrationStatus(
        needed: true,
        legacyDataDir: legacy is String ? legacy : '',
        targetDataDir: target is String ? target : '',
      );
    } on FormatException {
      return none;
    }
  }
}
