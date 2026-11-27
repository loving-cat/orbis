import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

/// 系统消息（`authorType == 'system'`）不能冒充 Bot 发言。
///
/// ## 现场（rc.3 真机）
///
/// 群里负责人在跑任务时用户补发消息，服务端写了一条「叫停回执」，`authorType: 'system'`
/// 但带着 `authorId = 负责人.id`。聊天窗里判 `authorBot` 时看的是 `authorType == 'bot'`，
/// 而传给 `_MessageRow` 的却是 `bot: state.botById(msg.authorId)` —— 于是这条回执被画成
/// **负责人的气泡 + 头像 + 「负责人」徽章**，正文是「已让评测负责人停下」。
/// 用户看到的就是「评测负责人：已让评测负责人停下」这种自相矛盾的画面。
///
/// 修法两头一起：服务端系统回执不再填 `authorId`；App 这边 system 消息走独立轻提示条，
/// 压根不查 Bot、不贴头衔。
void main() {
  Msg systemMsg({
    String authorName = '叫停回执',
    String text = '已让评测负责人停下，按你的新要求重来。',
    String? authorId = 'b_lead',
  }) =>
      Msg(
        id: 'm_sys',
        roomId: 'r_g',
        authorType: 'system',
        authorId: authorId,
        authorName: authorName,
        text: text,
        status: 'done',
        createdAt: DateTime.now().millisecondsSinceEpoch,
      );

  testWidgets('系统消息渲染成轻提示条：显示文本，不画 Bot 头像、不贴「负责人」徽章', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 600,
            child: SystemNotice(msg: systemMsg()),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('已让评测负责人停下，按你的新要求重来。'), findsOneWidget,
        reason: '系统消息的正文要显示出来');
    expect(find.text('叫停回执'), findsOneWidget, reason: '带上来源标签，用户才知道是谁在说话');

    // 不画 Bot 头像：SystemNotice 里不应该出现任何头像组件
    expect(find.byType(BlobAvatar), findsNothing);

    // 不贴头衔/徽章
    expect(find.text('负责人'), findsNothing);
    expect(find.text('评测负责人'), findsNothing);

    // 正文可选中复制（桌面端拖选 / 移动端长按）
    expect(find.byType(SelectableText), findsOneWidget,
        reason: '系统回执里常带任务名与原因，用户要能选中复制');
  });

  testWidgets('系统消息不因 authorId 命中负责人而被当成 Bot 气泡', (tester) async {
    // 这条的 authorId 故意等于负责人：旧代码就是靠这个把回执画成负责人发言的
    final msg = systemMsg(authorId: 'b_lead', authorName: '系统提示',
        text: '评测负责人 正在整理上下文，压缩完成后会自动按你的新要求继续，无需重复发送。');
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: SystemNotice(msg: msg))),
    );
    await tester.pump();

    expect(find.textContaining('正在整理上下文'), findsOneWidget);
    expect(find.text('系统提示'), findsOneWidget);
    // 只有一条提示条，不是 Bot 气泡（Bot 气泡会带 BlobAvatar / 名字胶囊）
    expect(find.byType(SystemNotice), findsOneWidget);
  });

  test('chat_screen：system 消息走独立分支，且不再用 msg.authorId 直接查 Bot', () {
    final src = File('lib/screens/chat_screen.dart').readAsStringSync();
    expect(
      src.contains("if (msg.authorType == 'system') return SystemNotice(msg: msg);"),
      isTrue,
      reason: 'build() 里必须有独立的 system 分支',
    );
    expect(
      src.contains('bot: authorBot'),
      isTrue,
      reason: '传给 _MessageRow 的必须是按 authorType 判过的 authorBot',
    );
    expect(
      RegExp(r'bot: state\.botById\(\s*msg\.authorId,?\s*\)').hasMatch(src),
      isFalse,
      reason: '不能再直接拿 msg.authorId 查 Bot（system 消息会被画成 Bot 本人）',
    );
    expect(
      RegExp(r'isLead:\s*room\.isGroup &&\s*authorBot != null').hasMatch(src),
      isTrue,
      reason: '「负责人」徽章也必须先确认这是真 Bot 发言',
    );
  });
}
