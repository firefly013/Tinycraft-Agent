import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openRuntime } from '../src/agent/runtime.ts';
import { createIntakeDeps } from '../src/agent/bridge.ts';
import { runnerTools } from '../src/agent/loop.ts';
import { Runner } from '../src/agent/runner.ts';
import type { Body } from '../src/agent/runner.ts';
import type { ToolDeclaration } from '../src/shared/tools.ts';

async function setup(): Promise<{
  runtime: Awaited<ReturnType<typeof openRuntime>>;
  faux: ReturnType<typeof fauxProvider>;
  models: ReturnType<typeof createModels>;
}> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await openRuntime({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    storage: new MemoryStorage(),
    systemPrompt: () => '你是 Minecraft 机器人。',
    tail: () => '## 世界快照\n位置 (0,64,0)',
  });
  return { runtime, faux, models };
}

test('尾巴带图：有截图时作为 image part 附在请求里', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await openRuntime({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    storage: new MemoryStorage(),
    systemPrompt: () => '你是机器人。',
    tail: () => '## 世界快照\n位置 (0,64,0)',
    image: async () => 'QUJD',
  });

  let last: any = null;
  faux.setResponses([
    (context: any) => {
      last = context.messages[context.messages.length - 1];
      return fauxAssistantMessage('收到');
    },
  ]);
  await (await runtime.conversation.submit({ type: 'input', content: '你好' }, BACKGROUND_CONTEXT)).wait(
    BACKGROUND_CONTEXT,
  );

  assert.ok(Array.isArray(last.content), '有图时 content 应该是消息数组');
  const image = last.content.find((part: { type: string }) => part.type === 'image');
  assert.equal(image?.data, 'QUJD');
  assert.equal(image?.mimeType, 'image/jpeg');
  const text = last.content.find((part: { type: string }) => part.type === 'text');
  assert.match(text?.text ?? '', /## 世界快照/);
  await runtime.close();
});

test('faux 模型答一句话：一整轮跑通', async () => {
  const { runtime, faux } = await setup();
  faux.setResponses([fauxAssistantMessage('你好，我是机器人')]);
  const settled = await (
    await runtime.conversation.submit({ type: 'input', content: '你好' }, BACKGROUND_CONTEXT)
  ).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done');
  assert.equal(faux.state.callCount, 1);
  await runtime.close();
});

test('动态尾巴作为最后一条 user 消息送达（但不落 transcript）', async () => {
  const { runtime, faux } = await setup();
  faux.setResponses([
    (context) => {
      const last = context.messages.at(-1);
      assert.ok(JSON.stringify(last).includes('世界快照'), '最后一条消息应是世界快照');
      return fauxAssistantMessage('看到了');
    },
  ]);
  const settled = await (
    await runtime.conversation.submit({ type: 'input', content: '现在在哪' }, BACKGROUND_CONTEXT)
  ).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done');
  await runtime.close();
});

test('L2 写入：不唤醒模型，但下一次请求看得到', async () => {
  const { runtime, faux } = await setup();
  const deps = createIntakeDeps(runtime.conversation);

  faux.setResponses([fauxAssistantMessage('第一轮完成')]);
  await (await runtime.conversation.submit({ type: 'input', content: '开始' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(faux.state.callCount, 1);

  await deps.write([], '背包里多了 3 个圆石');
  assert.equal(faux.state.callCount, 1, '写入不许叫醒模型');

  faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes('背包里多了 3 个圆石'), '写入应进下一轮上下文');
      return fauxAssistantMessage('收到');
    },
  ]);
  await (await runtime.conversation.submit({ type: 'input', content: '继续' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(faux.state.callCount, 2);
  await runtime.close();
});

class ImmediateBody implements Body {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  execute(name: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.calls.push({ name, args });
    return Promise.resolve({ text: `挖掉了 (${String(args.x)},${String(args.y)},${String(args.z)})` });
  }

  cancel(): void {}
}

test('端到端：模型调工具 → 控制面 → 身体 → 结果回模型 → 第二轮回答', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const declarations: readonly ToolDeclaration[] = [
    {
      name: 'mineBlock',
      description: '挖一格方块',
      mode: 'sync',
      action: true,
      params: { x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } },
    },
  ];

  const body = new ImmediateBody();
  let runner: Runner | null = null;

  const runtime = await openRuntime({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    storage: new MemoryStorage(),
    systemPrompt: () => '你是一个 Minecraft 机器人。',
    tools: runnerTools(
      {
        tool: (name, args) => (runner == null ? Promise.resolve({ text: '还没准备好' }) : runner.tool(name, args)),
      },
      declarations,
    ),
  });
  runner = new Runner({ tools: declarations, body, deps: createIntakeDeps(runtime.conversation) });

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('mineBlock', { x: 1, y: 2, z: 3 })], { stopReason: 'toolUse' }),
    (context) => {
      assert.ok(
        JSON.stringify(context.messages).includes('挖掉了 (1,2,3)'),
        '工具结果应回到模型上下文',
      );
      return fauxAssistantMessage('挖完了，还挖吗？');
    },
  ]);

  const settled = await (
    await runtime.conversation.submit({ type: 'input', content: '挖一块石头' }, BACKGROUND_CONTEXT)
  ).wait(BACKGROUND_CONTEXT);

  assert.equal(settled.status, 'done');
  assert.equal(body.calls.length, 1);
  assert.equal(body.calls[0]?.name, 'mineBlock');
  assert.deepEqual(body.calls[0]?.args, { x: 1, y: 2, z: 3 });
  // accepted 结束了第一轮；完成事件开第二轮，等它落定再断言。
  for (let i = 0; i < 200 && faux.state.callCount < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(faux.state.callCount, 2);
  assert.match(runner.describe(), /body=idle/);
  await runtime.close();
});
