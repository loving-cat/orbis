import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';

/// 被打断的气泡不能"整条消失"。
///
/// ## 现场
///
/// 用户插话（或私聊命中 abortReplace）时，服务端以前无条件把正在流式的消息写成
/// `status: 'aborted'`；App 的 `_MessageRow.build()` 对 `isAborted` 直接
/// `SizedBox.shrink()` —— 于是 Bot **刚写出来的一大段回复当场消失**，
/// 用户只看到自己那条新消息，像是把活丢了。
///
/// 现在两头都改：
///   · App：只有**彻底没正文**的空壳才隐藏（`hidesAbortedMessage`）；
///   · Server：打断时把已吐正文（含 `liveDraft` 里未落库的那截）保住，
///     `status: 'done'` + `meta.interrupted: true`，什么都不丢。
void main() {
  Msg msg({
    required String status,
    required String text,
    Map<String, dynamic>? meta,
  }) =>
      Msg(
        id: 'm_${status}_${text.length}',
        roomId: 'r_g',
        authorType: 'bot',
        authorName: 'Bot',
        text: text,
        status: status,
        createdAt: 1,
        meta: meta,
      );

  test('终止 + 没正文的空壳 → 隐藏（用户按 Esc 留下的占位）', () {
    expect(hidesAbortedMessage(msg(status: 'aborted', text: '')), isTrue);
    expect(hidesAbortedMessage(msg(status: 'aborted', text: '   ')), isTrue);
  });

  test('★ 终止 + 有正文 → 必须渲染出来，不许消失', () {
    final m = msg(
      status: 'aborted',
      text: '已经把三个文件改完，剩下一个等确认。',
      meta: const {'interrupted': true},
    );
    expect(hidesAbortedMessage(m), isFalse, reason: '有正文就是用户唯一能看到的产物，不能藏');
  });

  test('正常完成 / 流式中都不受这条判据影响', () {
    expect(hidesAbortedMessage(msg(status: 'done', text: '好了')), isFalse);
    expect(hidesAbortedMessage(msg(status: 'streaming', text: '')), isFalse,
        reason: '流式空占位由 isGhostThinkingPlaceholder 另行处理，不走这条');
  });

  test('源码守卫：build() 里走 hidesAbortedMessage，且服务端保留正文的三条路径都在', () {
    final app = File('lib/screens/chat_screen.dart').readAsStringSync();
    expect(app.contains('if (hidesAbortedMessage(msg)) return const SizedBox.shrink();'), isTrue);
    expect(RegExp(r'if \(msg\.isAborted\) return const SizedBox\.shrink\(\);').hasMatch(app), isFalse,
        reason: '裸判 isAborted 会把有正文的气泡也藏掉');

    final orch = File('../server/src/runner/group-orchestrator.js').readAsStringSync();
    expect(orch.contains('interrupted: true'), isTrue, reason: 'interruptRoundForUser 要保住正文');
    final te = File('../server/src/runner/turn-executor.js').readAsStringSync();
    expect(te.contains('const preserved ='), isTrue, reason: '收尾 catch 不许覆写回 aborted');
  });
}
