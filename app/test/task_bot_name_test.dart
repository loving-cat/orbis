// 任务面板里的「这是谁」：解析规则的单测。
//
// 用户原话：「任务面板里涉及其他 Bot 的时候，很多时候显示的不是真实 name，
// 而是 botId / 一串数字。」四条来路（id → name → name 其实是 id → 原值）都在
// `resolveTaskBotName` 里，这里逐条钉住，免得以后有人在某个展示位又直接用 name。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/task_bot_name.dart';

class _State extends AppState {}

void main() {
  late _State state;
  setUp(() {
    state = _State()
      ..bots = [
        Bot(id: 'b_main', name: '主控', role: 'main'),
        Bot(id: 'b_ops', name: '运维工程师'),
        Bot(id: 'b_fin', name: '财务建模师'),
      ];
  });
  tearDown(() => state.dispose());

  test('botId 命中花名册 → 用真实名字（最权威，改名后立刻生效）', () {
    expect(
      resolveTaskBotName(state, botId: 'b_ops', name: '运维工程师（旧名）'),
      '运维工程师',
    );
  });

  test('★ name 本身是 botId（老数据把 id 存进了名字列）→ 翻译成真名', () {
    expect(resolveTaskBotName(state, name: 'b_fin'), '财务建模师');
  });

  test('只有 name、且不是 id → 原样返回', () {
    expect(resolveTaskBotName(state, name: '竞品研究员'), '竞品研究员');
  });

  test('id 查不到（bot 已删/换了机器）→ 退回名字', () {
    expect(
      resolveTaskBotName(state, botId: 'b_gone', name: '前任同事'),
      '前任同事',
    );
  });

  test('id 与 name 都查不到 → 最后退回 id（总比空白强）', () {
    expect(resolveTaskBotName(state, botId: 'b_gone', name: 'b_gone'), 'b_gone');
  });

  test('两列都空 / null → 空串（调用方据此决定要不要显示这一行）', () {
    expect(resolveTaskBotName(state), '');
    expect(resolveTaskBotName(state, botId: '', name: '   '), '');
  });

  test('首尾空白被清掉，不会渲染出「负责人： 」这种空行', () {
    expect(resolveTaskBotName(state, botId: ' b_ops '), '运维工程师');
  });
}
