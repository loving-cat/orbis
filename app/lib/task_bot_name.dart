/// 任务面板里的「这是谁」统一从这一处解析。
///
/// ## 为什么需要它
///
/// 用户原话：「任务面板里涉及其他 Bot 的时候，很多时候显示的不是真实 name，
/// 而是 botId / 一串数字。」
///
/// 名字有三条来路，任何一条单独用都会露怯：
///   · 服务端投影里的 `nameOf(id)` —— 只在服务端认得这只 bot 时才有值；
///   · 落盘的 `memberName` / `participants[].name` —— 老数据里可能就是 botId；
///   · 干脆没有名字，只有 id。
///
/// 所以统一按四步走：
///   1. `botId` 能在本地花名册里查到 → 用它的 `name`（最权威，改名后立刻生效）；
///   2. `name` 本身是一个已知 botId（历史数据把 id 存进了名字列）→ 翻译成 `name`；
///   3. 否则用非空的 `name`（服务端给的原值，可能是真名也可能是「未指定」）；
///   4. 最后退回 `botId`（总比空白强，至少能对上是谁）。
library;

import 'app_state.dart';

/// 解析任务面板里要展示的 Bot 名字（只读 `state.bots`，可在任意展示位复用）。
String resolveTaskBotName(AppState state, {String? botId, String? name}) {
  final id = (botId ?? '').trim();
  if (id.isNotEmpty) {
    final hit = state.botById(id);
    final real = (hit?.name ?? '').trim();
    if (real.isNotEmpty) return real;
  }
  final raw = (name ?? '').trim();
  if (raw.isNotEmpty) {
    // 老数据：名字这一列存的是 botId。能翻译就翻译，翻译不了就原样显示。
    final byId = state.botById(raw);
    final real = (byId?.name ?? '').trim();
    if (real.isNotEmpty) return real;
    return raw;
  }
  return id;
}
