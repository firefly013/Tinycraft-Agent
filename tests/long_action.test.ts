import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { startBaseline } from '../src/agent/bot.ts';
import type { ReflexSpec } from '../src/core/reflex.ts';
import type { LogEvent } from '../src/core/events.ts';
import type { ActionContext } from '../src/shared/body.ts';

class AsyncBody {
  calls = 0;
  resumes: unknown[] = [];
  private context: ActionContext | null = null;
  private last: { resolve: (value: { text: string }) => void; reject: (error: Error) => void } | null = null;

  snapshot(): string {
    return '## 世界快照\n位置 (0, 64, 0) 主世界';
  }

  execute(_name: string, _args: Record<string, unknown>, context: ActionContext): Promise<{ text: string }> {
    this.calls += 1;
    this.context = context;
    // 只报一次进度：被抢占后应该从 {got:1} 继续。
    context.checkpoint({ got: 1 });
    return this.track(context);
  }

  canResume(): boolean {
    return true;
  }

  async resume(
    _name: string,
    _args: Record<string, unknown>,
    context: ActionContext,
    checkpoint: unknown,
  ): Promise<string> {
    this.calls += 1;
    this.resumes.push(checkpoint);
    this.context = context;
    const result = await this.track(context);
    return result.text;
  }

  private track(context: ActionContext): Promise<{ text: string }> {
    return new Promise((resolve, reject) => {
      this.last = { resolve, reject };
      context.signal.addEventListener(
        'abort',
        () => {
          this.last = null;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  /** 战斗反射：装 20ms，被打断就提前收手。 */
  reflex(_name: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 20);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  finish(text: string): void {
    this.last?.resolve({ text });
    this.last = null;
  }
}

const hostile = (): LogEvent => ({ type: 'hostile', kind: 'World', level: 5, payload: {}, text: '两只僵尸靠近', ts: 0 });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await sleep(10);
  }
}

test('长动作被反射打断：从检查点续做，完成事件叫醒模型一次', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const body = new AsyncBody();
  const reflexes: readonly ReflexSpec[] = [
    { name: 'combat', priority: 30, interruptible: true, types: ['hostile'] },
  ];

  const baseline = await startBaseline({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    storage: new MemoryStorage(),
    body,
    systemPrompt: '你是机器人。',
    goal: { value: null },
    say: () => {},
    reflexes,
  });

  // 第一轮：模型发起长动作，拿到 accepted；accepted 直接结束本轮，不再空转。
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('collectBlock', { type: 'iron_ore', count: 4, descriptions: '挖 4 个铁' })],
      { stopReason: 'toolUse' },
    ),
  ]);
  await baseline.kick('挖 4 个铁');
  await baseline.conversation.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(faux.state.callCount, 1, 'accepted 即结束本轮：不再空转一轮');
  assert.equal(body.calls, 1, '长动作应该在后台跑');

  // 反射抢占：取消身体 → 战斗 20ms → 从检查点续做。
  baseline.runner.notify(hostile());
  await baseline.runner.settleReflexes();
  assert.equal(body.calls, 2, '被抢占后应重新执行');
  assert.deepEqual(body.resumes[0], { got: 1 }, '续做要带上检查点');

  // 长动作完成：结果以 L3 事件回来，模型被叫醒一次。
  faux.setResponses([
    (context) => {
      const messages = JSON.stringify(context.messages);
      assert.ok(messages.includes('收了 4 个铁'), '完成结果应到模型');
      assert.ok(messages.includes('已从断点续做'), '续做事实应写进回执');
      return fauxAssistantMessage('收到');
    },
  ]);
  body.finish('收了 4 个铁');
  await waitFor(() => faux.state.callCount === 2);
  await baseline.conversation.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(faux.state.callCount, 2, '完成事件只叫醒一次');
  await baseline.close();
});
