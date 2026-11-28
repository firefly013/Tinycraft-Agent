import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';
import type { Storage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { splitChatText, startBaseline, withToolChoice } from '../src/agent/bot.ts';
import type { Baseline, BuildingBridge } from '../src/agent/bot.ts';

class FakeBody {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly goal: { value: string | null };

  constructor(goal: { value: string | null }) {
    this.goal = goal;
  }

  snapshot(): string {
    return `## 世界快照\n位置 (0, 64, 0) 主世界\n目标：${this.goal.value ?? '（无）'}`;
  }

  execute(name: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.calls.push({ name, args });
    return Promise.resolve({ text: `身体执行了 ${name}` });
  }

  cancel(): void {}
}

async function setup(storage: Storage = new MemoryStorage(), building?: BuildingBridge): Promise<{
  faux: ReturnType<typeof fauxProvider>;
  body: FakeBody;
  said: string[];
  goal: { value: string | null };
  start: () => Promise<Baseline>;
}> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const said: string[] = [];
  const goal: { value: string | null } = { value: null };
  const body = new FakeBody(goal);
  const start = (): Promise<Baseline> =>
    startBaseline({
      models,
      model: { provider: 'faux', modelId: faux.getModel().id },
      storage,
      body,
      systemPrompt: '你是 Minecraft 机器人。',
      goal,
      say: (text) => said.push(text),
      ...(building == null ? {} : { building }),
    });
  return { faux, body, said, goal, start };
}

const idle = (baseline: Baseline): Promise<void> => baseline.conversation.waitForIdle(BACKGROUND_CONTEXT);

test('完整装配：模型调工具 → 身体 → 结果回模型 → 第二轮回答', async () => {
  const { faux, body, start } = await setup();
  const baseline = await start();

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('mineBlock', { x: 1, y: 2, z: 3, descriptions: '挖掉这块石头' })],
      { stopReason: 'toolUse' },
    ),
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes('身体执行了 mineBlock'));
      return fauxAssistantMessage('挖好了');
    },
  ]);

  await baseline.kick('挖一块石头');
  await idle(baseline);

  assert.equal(body.calls.length, 1);
  assert.deepEqual(body.calls[0]?.args, { x: 1, y: 2, z: 3, descriptions: '挖掉这块石头' });
  assert.equal(faux.state.callCount, 2);
  await baseline.close();
});

test('模型正文自动进公聊；Stop 在空闲时是空操作；UpdateGoal 写进快照', async () => {
  const { faux, said, goal, start } = await setup();
  const baseline = await start();

  assert.equal(await baseline.runner.toolText('Stop', { descriptions: '确认身体空闲' }), '身体空闲，没有要停的动作');
  assert.equal(await baseline.runner.toolText('UpdateGoal', { goal: '砍三棵树', descriptions: '设定砍树目标' }), '目标更新为：砍三棵树');
  assert.equal(goal.value, '砍三棵树');

  faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes('砍三棵树'), '目标应出现在每轮尾巴里');
      return fauxAssistantMessage('知道了');
    },
  ]);
  await baseline.kick('继续');
  await idle(baseline);
  assert.deepEqual(said, ['知道了'], '模型正文应该直接被发到公聊');
  await baseline.close();
});

test('身体动作失败/不存在：回执说清楚，不崩', async () => {
  const { start } = await setup();
  const baseline = await start();
  assert.match(await baseline.runner.toolText('mineBlock', {}), /参数不对/);
  assert.match(
    await baseline.runner.toolText('Stop', { descriptions: '   ' }),
    /descriptions 不能为空/,
  );
  assert.match(await baseline.runner.toolText('fly', {}), /没有这个工具/);
  await baseline.close();
});

test('目标存在会话文档里：重启后还在', async () => {
  const dbPath = join(tmpdir(), `baseline-goal-${process.pid}-${Date.now()}.db`);
  try {
    const first = await setup(await openNodeSqliteStorage(dbPath));
    const one = await first.start();
    assert.equal(await one.runner.toolText('UpdateGoal', { goal: '挖 8 个铁', descriptions: '设定挖铁目标' }), '目标更新为：挖 8 个铁');
    assert.equal(first.goal.value, '挖 8 个铁');
    await one.close();

    const second = await setup(await openNodeSqliteStorage(dbPath));
    const two = await second.start();
    assert.equal(second.goal.value, '挖 8 个铁', '重启后目标应该还在');
    assert.match(second.body.snapshot(), /目标：挖 8 个铁/, '目标应出现在每轮快照里');
    await two.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

test('模型正文切块：不丢行、不超过聊天上限', () => {
  const long = 'a'.repeat(500);
  const chunks = splitChatText(`第一行\n\n${long}\n第二行`);
  assert.equal(chunks[0], '第一行');
  assert.equal(chunks.at(-1), '第二行');
  assert.ok(chunks.every((chunk) => chunk.length <= 256));
  assert.equal(chunks.join(''), `第一行${long}第二行`);
  assert.equal(splitChatText('x'.repeat(256)).length, 1, '256 字符正好一条');
  assert.equal(splitChatText('x'.repeat(257)).length, 2, '257 字符切两条');
});

test('Finish：本地空操作工具，不占身体、不产生执行', async () => {
  const { body, start } = await setup();
  const baseline = await start();
  try {
    const text = await baseline.runner.toolText('Finish', { descriptions: '本轮没有动作' });
    assert.match(text, /本轮结束/);
    assert.equal(body.calls.length, 0, 'Finish 不该碰身体');
  } finally {
    await baseline.close();
  }
});

test('withToolChoice：只在有 tools 时注入；auto 原样不动', () => {
  const payload = { model: 'm', tools: [{ type: 'function' }] };
  assert.deepEqual(withToolChoice(payload, 'required'), { ...payload, tool_choice: 'required' });
  assert.equal(withToolChoice(payload, 'auto'), undefined);
  assert.equal(withToolChoice({ model: 'm', messages: [] }, 'required'), undefined, '没工具不注入（压缩请求）');
  assert.equal(withToolChoice(null, 'required'), undefined);
});

test('建筑：Session ID、审稿、打回、接受工具完整接线', async () => {
  const calls: string[] = [];
  const reviews: string[][] = [];
  const building: BuildingBridge = {
    design: (brief, tags) => {
      calls.push(`${brief}:${tags ?? '-'}`);
      return 'accepted：会话 session-1（蓝图 b1）已开始';
    },
    send: (sessionId, instructions) => {
      calls.push(`${sessionId}:${instructions}`);
      return 'accepted：已打回 session-1';
    },
    review: async (sessionId, previewArgs) => {
      reviews.push([...(previewArgs ?? [])]);
      return { text: `审稿 ${sessionId}`, images: [{ data: 'aW1n', mimeType: 'image/png' }] };
    },
    accept: (sessionId) => sessionId === 'session-1' ? '已接受 session-1' : '不能接受',
    cancel: (sessionId) => sessionId === 'session-1',
    list: () => 'session-1 b1 revision 1 awaiting_review',
  };
  const { start } = await setup(new MemoryStorage(), building);
  const baseline = await start();
  assert.equal(baseline.toolNames.length, 22);
  assert.match(await baseline.runner.toolText('DesignBuild', { brief: '小塔', descriptions: '设计小塔' }), /session-1/);
  assert.deepEqual(calls, ['小塔:-']);
  assert.match(await baseline.runner.toolText('SendToSubagent', { sessionId: 'session-1', instructions: '屋顶改深色', descriptions: '打回修改' }), /已打回/);
  const review = await baseline.runner.tool('ReviewBuild', { sessionId: 'session-1', descriptions: '审稿' });
  assert.match(review.text, /审稿 session-1/);
  assert.equal(review.images?.[0].data, 'aW1n');
  await baseline.runner.toolText('ReviewBuild', {
    sessionId: 'session-1',
    preview: JSON.stringify(['preview', 'plan.schem', '-o', 'detail.png', '--persp']),
    descriptions: '看细节',
  });
  assert.deepEqual(reviews.at(-1), ['preview', 'plan.schem', '-o', 'detail.png', '--persp']);
  assert.equal(await baseline.runner.toolText('AcceptBuild', { sessionId: 'session-1', descriptions: '接受' }), '已接受 session-1');
  assert.equal(await baseline.runner.toolText('CancelDesign', { sessionId: 'session-1', descriptions: '取消它' }), '已取消会话 session-1');
  assert.match(await baseline.runner.toolText('ListBlueprints', { descriptions: '看看蓝图' }), /revision 1/);
  await baseline.close();
});

test('建筑：没配置 mc-build 时，8 个建筑工具不出现在工具表里', async () => {
  const { start } = await setup();
  const baseline = await start();
  assert.equal(baseline.toolNames.length, 14);
  assert.ok(!baseline.toolNames.includes('DesignBuild'));
  assert.ok(!baseline.toolNames.includes('BuildAt'));
  await baseline.close();
});
