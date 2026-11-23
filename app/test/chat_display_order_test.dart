import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';

Msg _m(
  String id, {
  bool streaming = false,
  String text = '',
  List<String> attachmentIds = const [],
  String? error,
}) => Msg(
  id: id,
  roomId: 'r1',
  authorType: 'bot',
  authorName: 'bot',
  text: text,
  status: streaming ? 'streaming' : 'done',
  attachments: [
    for (final a in attachmentIds)
      Attachment(id: a, name: '$a.bin', mime: 'application/octet-stream', size: 1, kind: 'file'),
  ],
  error: error,
  createdAt: 1,
);

void main() {
  test('★ 纯思考空占位不再混进可见列表（思考态由 ActivityMonitor 显示）', () {
    final ordered = displayOrderMsgs([
      _m('a', streaming: true), // 还在想：不该出现
      _m('b', text: '已经产出的大段内容'),
      _m('c', streaming: true), // 还在想：不该出现
      _m('d', text: '另一条完成内容'),
      _m('e', streaming: true, text: '开始输出了'), // 有正文 → 留着
      _m('f', streaming: true, attachmentIds: const ['att1']), // 有附件 → 留着
      _m('g', streaming: true, error: '模型请求失败'), // 有报错 → 留着
    ]);
    expect(ordered.map((m) => m.id).toList(), ['b', 'd', 'e', 'f', 'g']);
    // 顺序本身不再被打乱：过滤只删除，不重排
    expect(ordered.length, lessThan(7));
  });

  test('整屏都是鬼影占位 → 可见列表为空（渲染成 0 高度，不占位置）', () {
    final ordered = displayOrderMsgs([
      _m('a', streaming: true),
      _m('b', streaming: true),
    ]);
    expect(ordered, isEmpty);
  });

  test('没有鬼影占位时保持原顺序（不再把任何消息挪到末尾）', () {
    final ordered = displayOrderMsgs([
      _m('x', streaming: true, text: '一'),
      _m('y', text: '二'),
      _m('z', streaming: true, text: '三'),
    ]);
    expect(ordered.map((m) => m.id).toList(), ['x', 'y', 'z']);
  });
}
