import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_REPEAT_MAX, classifyChat, isCommandFeedback } from '../src/core/chat.ts';

test('玩家说话：L3 唤醒、要求回一句', () => {
  const d = classifyChat({ username: 'Steve', message: '你在干什么', selfName: 'BaselineBot' });
  assert.equal(d.level, 3);
  assert.equal(d.expectReply, true);
  assert.equal(d.addressed, true);
  assert.match(d.text, /玩家 Steve 对你说：你在干什么/);
  assert.match(d.text, /先用一句文字回应（会自动进公聊）/);
});

test('急停词也统一 L3：不再有聊天 L4 启发式', () => {
  const d = classifyChat({ username: 'Steve', message: '停！危险', selfName: 'BaselineBot' });
  assert.equal(d.level, 3);
  assert.equal(d.expectReply, true);
});

test('私聊：同样 L3，并注明私聊', () => {
  const d = classifyChat({ username: 'Steve', message: '过来一下', selfName: 'BaselineBot', whisper: true });
  assert.equal(d.level, 3);
  assert.match(d.text, /私聊/);
});

test('服务器/命令回执：不是聊天，直接丢', () => {
  assert.equal(isCommandFeedback('Teleported Steve to 0, 64, 0'), true);
  assert.equal(isCommandFeedback('Set the time to 1000'), true);
  assert.equal(isCommandFeedback('你在干什么'), false);
  const d = classifyChat({ username: 'Steve', message: 'Teleported Steve to 0, 64, 0', selfName: 'BaselineBot' });
  assert.equal(d.drop, true);
});

test('同一句话重复刷屏：超过阈值后丢掉', () => {
  const d = classifyChat({
    username: 'builder',
    message: 'Successfully filled 15 block(s)',
    selfName: 'BaselineBot',
    repeatCount: CHAT_REPEAT_MAX,
  });
  assert.equal(d.drop, true);
});
