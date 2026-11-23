import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'open_file.dart';

enum AttachmentOpenPhase { idle, opening, handedOff, failed }

/// 一次附件打开的状态；进行中忽略重复请求，销毁后不再通知界面。
///
/// ★ 结果状态会自动复位（默认 `handedOff` 3s / `failed` 6s）：预览页顶栏曾把
///   「已交给系统程序」当成常驻文本钉在那里，永远不消失，还把顶栏撑变形。
///   现在这里自己收尾，界面只需要在 [message] 非空时提示一次。
class AttachmentOpenController extends ChangeNotifier {
  AttachmentOpenController({
    required this.operation,
    this.handedOffDelay = const Duration(seconds: 3),
    this.failedDelay = const Duration(seconds: 6),
  });

  final Future<String?> Function() operation;

  /// `handedOff` 之后多久回到 idle。
  final Duration handedOffDelay;

  /// `failed` 之后多久回到 idle。
  final Duration failedDelay;

  AttachmentOpenPhase phase = AttachmentOpenPhase.idle;
  String? error;
  bool _disposed = false;
  Timer? _resetTimer;

  bool get opening => phase == AttachmentOpenPhase.opening;

  String? get message => switch (phase) {
    AttachmentOpenPhase.idle => null,
    AttachmentOpenPhase.opening => '正在打开…',
    AttachmentOpenPhase.handedOff => '已交给系统程序',
    AttachmentOpenPhase.failed => error ?? '打开失败，请重试。',
  };

  Future<void> open() async {
    if (_disposed || opening) return;
    // 再点一次：上一次的复位计时器作废，否则它会在新一轮里把状态打回 idle
    _resetTimer?.cancel();
    _resetTimer = null;
    phase = AttachmentOpenPhase.opening;
    error = null;
    notifyListeners();
    String? failure;
    try {
      failure = await operation();
    } catch (_) {
      failure = '打开失败，请重试。';
    }
    if (_disposed) return;
    error = failure;
    phase = failure == null
        ? AttachmentOpenPhase.handedOff
        : AttachmentOpenPhase.failed;
    notifyListeners();
    // 提示自己会走：定时回到 idle，界面不用记"什么时候该清掉这句话"
    _scheduleReset(phase == AttachmentOpenPhase.handedOff ? handedOffDelay : failedDelay);
  }

  void _scheduleReset(Duration delay) {
    _resetTimer?.cancel();
    _resetTimer = Timer(delay, () {
      _resetTimer = null;
      if (_disposed || phase == AttachmentOpenPhase.opening) return;
      phase = AttachmentOpenPhase.idle;
      error = null;
      notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    // ★ 必须取消：悬空 Timer 会在测试里报 "A Timer is still pending"，
    //   在真机上则是一次无意义的 notifyListeners。
    _resetTimer?.cancel();
    _resetTimer = null;
    super.dispose();
  }
}

final Map<String, Future<String?>> _pendingOpens = {};

/// 同一附件的并发打开共用一次下载与系统调用。
Future<String?> openAttachmentFile({
  required String name,
  required String url,
}) {
  final key = '$url\u0000$name';
  final pending = _pendingOpens[key];
  if (pending != null) return pending;
  late Future<String?> request;
  request = _downloadAndOpen(name: name, url: url).whenComplete(() {
    if (identical(_pendingOpens[key], request)) _pendingOpens.remove(key);
  });
  _pendingOpens[key] = request;
  return request;
}

/// 完整读取附件并交给系统程序；成功不代表系统程序已读取内容。
Future<String?> _downloadAndOpen({
  required String name,
  required String url,
}) async {
  try {
    final response = await http
        .get(Uri.parse(url))
        .timeout(const Duration(seconds: 120));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return '打开失败：下载返回 HTTP ${response.statusCode}，请重试。';
    }
    return await openWithSystemApp(
      name: name,
      bytes: response.bodyBytes,
      tempDir: attachmentTempDir(),
    );
  } on TimeoutException {
    return '打开失败：下载超时，请重试。';
  } catch (_) {
    return '打开失败：无法下载附件，请检查连接后重试。';
  }
}
