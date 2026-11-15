import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner, MAX_TOOL_OUTPUT_CHARS, clampToolOutput } from '../src/agent/runner.ts';
import type { Body } from '../src/shared/body.ts';
import type { ActionContext } from '../src/shared/body.ts';
import type { IntakeDeps } from '../src/core/intake.ts';
import type { LogEvent } from '../src/core/events.ts';
import type { ReflexSpec } from '../src/core/reflex.ts';
import type { ToolDeclaration } from '../src/shared/tools.ts';

const TOOLS: readonly ToolDeclaration[] = [
  { name: 'mineBlock', description: '挖一格', mode: 'async', action: true, params: { x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } } },
  { name: 'collectBlock', description: '收矿', mode: 'async', action: true, params: { type: { type: 'string' } } },
  { name: 'goTo', description: '走过去', mode: 'async', action: true, params: { x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } } },
  { name: 'attack', description: '打实体', mode: 'async', action: true, params: { entityId: { type: 'int' } } },
];

const COMBAT: ReflexSpec = { name: 'combat', priority: 30, interruptible: true, types: ['hostile'] };
const FALL: ReflexSpec = { name: 'landing_water', priority: 100, interruptible: false, types: ['fall'] };

const event = (type: string, level: 2 | 3 | 4 | 5 = 5): LogEvent => ({ type, kind: 'World', level, payload: {}, text: type, ts: 0 });

class FakeBody implements Body {
  calls: Array<{ name: string; args: Record<string, unknown>; checkpoint: unknown }> = [];
  cancels = 0;
  /** 哪些动作登记了续做钩子（真实身体里是原语上的 resume 函数）。 */
  resumable = new Set<string>(['collectBlock', 'goTo', 'smelt', 'attack']);
  /** 有序停机的清理钩子被调用的记录。 */
  stopCalls: Array<{ name: string; checkpoint: unknown }> = [];
  stopText = '';
  private context: ActionContext | null = null;
  private pending: { resolve: (value: { text: string }) => void; reject: (error: Error) => void } | null = null;

  async stop(name: string, _context: ActionContext, checkpoint: unknown): Promise<string> {
    this.stopCalls.push({ name, checkpoint });
    return this.stopText;
  }

  canResume(name: string): boolean {
    return this.resumable.has(name);
  }

  async resume(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
    checkpoint: unknown,
  ): Promise<string> {
    const result = await this.execute(name, args, context, checkpoint);
    return result.text;
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
    checkpoint?: unknown,
  ): Promise<{ text: string }> {
    this.calls.push({ name, args, checkpoint });
    this.context = context;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      context.signal.addEventListener(
        'abort',
        () => {
          this.cancels += 1;
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  report(progress: unknown): void {
    this.context?.checkpoint(progress);
  }

  finish(text: string): void {
    this.pending?.resolve({ text });
    this.pending = null;
  }
}

function harness(options: {
  reflexes?: readonly ReflexSpec[];
  runReflex?: (name: string, signal: AbortSignal) => Promise<void>;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  tools?: readonly ToolDeclaration[];
} = {}): { runner: Runner; body: FakeBody; submits: string[]; writes: string[]; aborts: () => number } {
  const body = new FakeBody();
  const submits: string[] = [];
  const writes: string[] = [];
  let aborts = 0;
  const deps: IntakeDeps = {
    submit: async (text) => {
      submits.push(text);
    },
    write: async (_events, text) => {
      writes.push(text);
    },
    abort: async () => {
      aborts += 1;
    },
  };
  const runner = new Runner({
    tools: options.tools ?? TOOLS,
    body,
    deps,
    reflexes: options.reflexes ?? [COMBAT],
    runReflex: options.runReflex ?? (async () => {}),
    ...(options.onToolCall == null ? {} : { onToolCall: options.onToolCall }),
    now: () => 1000,
  });
  return { runner, body, submits, writes, aborts: () => aborts };
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (check: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('每次工具调用都回调（聊天框逐条播报）', async () => {
  const calls: string[] = [];
  const h = harness({ onToolCall: (name, args) => calls.push(name + JSON.stringify(args)) });
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  await h.runner.toolText('mineBlock', { x: 1 }); // 参数不对也要播报
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? '', /mineBlock.*"x":1/);
  assert.match(calls[1] ?? '', /mineBlock.*"x":1/);
});

test('动作工具统一立刻 accepted；完成以 L3 Tool 事件回来', async () => {
  const h = harness();
  const accepted = await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  assert.match(accepted, /accepted/);
  assert.equal(h.body.calls.length, 1);
  h.body.finish('挖掉了石头');
  await waitFor(() => h.submits.length === 1);
  assert.match(h.submits[0] ?? '', /mineBlock 完成/);
  assert.match(h.submits[0] ?? '', /挖掉了石头/);
});

test('accepted / 被自己的动作挡住：结束本轮；参数错误不结束', async () => {
  const h = harness();
  const accepted = await h.runner.tool('mineBlock', { x: 1, y: 2, z: 3 });
  assert.equal(accepted.terminate, true, '动作已下达：模型该睡，完成事件再叫醒它');
  const again = await h.runner.tool('mineBlock', { x: 1, y: 2, z: 3 });
  assert.equal(again.terminate, true, '重复下发也要结束本轮，不能空转');
  const busy = await h.runner.tool('goTo', { x: 0, y: 64, z: 0 });
  assert.match(busy.text, /身体正忙/);
  assert.equal(busy.terminate, true, '挡路的是自己的动作：完成时一定有 tool.done 叫醒');
  const bad = await h.runner.tool('mineBlock', { x: 1 });
  assert.equal(bad.terminate, undefined, '参数错误：模型现在就要改');
});

test('身体被反射占着：busy 不结束本轮（模型要能决定 Stop 或先说话）', async () => {
  let release = (): void => {};
  const h = harness({
    runReflex: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  h.runner.notify(event('hostile'));
  await waitFor(() => h.runner.control.body?.by === 'reflex');
  const busy = await h.runner.tool('mineBlock', { x: 1, y: 2, z: 3 });
  assert.match(busy.text, /身体正忙/);
  assert.equal(busy.terminate, undefined, '反射结束不保证有唤醒，这条信息模型现在就要用');
  release();
  await h.runner.settleReflexes();
});

test('参数不对 / 未知工具：给模型能看懂的回执', async () => {
  const h = harness();
  assert.match(await h.runner.toolText('mineBlock', { x: 1 }), /参数不对/);
  assert.match(await h.runner.toolText('fly', {}), /没有这个工具/);
});

test('身体被占：别的动作直接 busy，不排队、不执行第二遍', async () => {
  const h = harness();
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  const busy = await h.runner.toolText('goTo', { x: 0, y: 64, z: 0 });
  assert.match(busy, /身体正忙/);
  assert.equal(h.body.calls.length, 1, '不能排队执行第二个动作');
});

test('同一动作重复下发：幂等 accepted，不重复执行', async () => {
  const h = harness();
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  const again = await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  assert.match(again, /accepted/);
  assert.match(again, /已经在跑/);
  assert.equal(h.body.calls.length, 1);
});

test('拾取让位：模型动作直接拿到身体（不 busy），反射被 abort', async () => {
  let reflexSignal: AbortSignal | null = null;
  const h = harness({
    reflexes: [{ name: 'pickup', priority: 10, interruptible: true, yieldToModel: true, types: ['item.drop.nearby'] }],
    runReflex: async (_name, signal) => {
      reflexSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  h.runner.notify({ ...event('item.drop.nearby'), silent: true });
  await waitFor(() => h.runner.control.body?.by === 'reflex');

  const outcome = await h.runner.tool('mineBlock', { x: 1, y: 2, z: 3 });
  assert.match(outcome.text, /accepted/, '模型动作直接生效，不再返回身体正忙');
  assert.equal(outcome.terminate, true);
  await waitFor(() => reflexSignal?.aborted === true);
  assert.equal(h.body.calls.length, 1);
  await h.runner.settleReflexes();
  assert.equal(h.runner.control.body?.by, 'model', '让位后身体归模型，反射收尾不能清掉它');
  assert.ok(
    !h.runner.traceLines.some((line) => line.includes('没有在跑')),
    '让位后反射收尾不该再发一条被拒的 reflex-done',
  );
});

test('静默反射接管：掐掉正在生成的那一轮，写进上下文但不唤醒', async () => {
  let release = (): void => {};
  const h = harness({
    runReflex: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  h.runner.requestStarted(); // 模型正在生成
  h.runner.notify({ ...event('hostile'), silent: true });
  await waitFor(() => h.aborts() === 1);
  assert.deepEqual(h.submits, [], '反射期间绝不唤醒');
  release();
  await h.runner.settleReflexes();
  await h.runner.settleDelivery();
  assert.deepEqual(h.writes, ['hostile'], '静默事件作为记录写进上下文');
});

test('静默事件：触发反射，写进上下文但不唤醒', async () => {
  const h = harness();
  h.runner.notify({ ...event('hostile'), silent: true });
  await h.runner.settleReflexes();
  await h.runner.settleDelivery();
  assert.deepEqual(h.writes, ['hostile'], '静默事件写进上下文');
  assert.deepEqual(h.submits, [], '不唤醒模型');
});

test('checkpoint 策略：被抢占后从上报的进度续做，最终只报一条完成事件', async () => {
  const h = harness();
  const accepted = await h.runner.toolText('collectBlock', { type: 'iron_ore' });
  assert.match(accepted, /accepted/);
  assert.equal(h.body.calls.length, 1);

  h.body.report({ got: 3 });
  h.runner.notify(event('hostile'));
  await waitFor(() => h.body.calls.length === 2);
  assert.equal(h.body.cancels, 1);
  assert.deepEqual(h.body.calls[1]?.checkpoint, { got: 3 }, '续做要带上检查点');

  h.body.finish('收了 8 个铁');
  await waitFor(() => h.submits.length === 1);
  assert.match(h.submits[0] ?? '', /收了 8 个铁/);
  assert.match(h.submits[0] ?? '', /已从断点续做/);
  assert.ok(h.runner.traceLines.some((line) => line.includes('preempt')));
});

test('auto 策略：被抢占后重新开始，回执不撒谎', async () => {
  const h = harness();
  await h.runner.toolText('goTo', { x: 1, y: 2, z: 3 });
  h.runner.notify(event('hostile'));
  await waitFor(() => h.body.calls.length === 2);
  assert.equal(h.body.calls[1]?.checkpoint, undefined);
  h.body.finish('走到了');
  await waitFor(() => h.submits.length === 1);
  assert.match(h.submits[0] ?? '', /走到了/);
  assert.match(h.submits[0] ?? '', /已重新开始/);
});

test('反射优先级：高优先级反射真的打断低优先级', async () => {
  const started: string[] = [];
  const signals: Record<string, AbortSignal> = {};
  const releases: Record<string, () => void> = {};
  const h = harness({
    reflexes: [COMBAT, FALL],
    runReflex: async (name, signal) => {
      started.push(name);
      signals[name] = signal;
      await new Promise<void>((resolve) => {
        releases[name] = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });

  h.runner.notify(event('hostile'));
  await tick();
  assert.deepEqual(started, ['combat']);

  h.runner.notify(event('fall'));
  await tick();
  assert.deepEqual(started, ['combat', 'landing_water']);
  assert.equal(signals.combat?.aborted, true, '低优先级反射要收到取消');

  releases.landing_water?.();
  await h.runner.settleReflexes();
  assert.ok(h.runner.traceLines.some((line) => line.includes('preempt')));
  assert.ok(
    !h.runner.traceLines.some((line) => line.includes('没有在跑')),
    '被抢的反射收尾不该再发一条被拒的 reflex-done',
  );
});

test('Stop：打断动作，不产生完成事件', async () => {
  const h = harness();
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  assert.equal(await h.runner.stop(), '已停止 mineBlock');
  assert.equal(h.body.cancels, 1);
  assert.match(h.runner.describe(), /body=idle/);
  await h.runner.settleDelivery();
  assert.deepEqual(h.submits, []);
});
test('Stop 是有序停机：先等动作收手，再跑清理钩子，回执里带结果', async () => {
  const declarations: readonly ToolDeclaration[] = [
    ...TOOLS,
    { name: 'smelt', description: '', mode: 'async', action: true, params: { item: { type: 'string' } } },
  ];
  const h = harness({ tools: declarations });
  h.body.stopText = '熔炉已清空（取回 iron_ingot×3、coal×7）';
  await h.runner.toolText('smelt', { item: 'iron_ore' });
  h.body.report({ op: 'smelt', furnace: { x: 1, y: 64, z: 0 } });

  const text = await h.runner.stop();
  assert.match(text, /已停止 smelt/);
  assert.match(text, /熔炉已清空/);
  assert.deepEqual(h.body.stopCalls, [
    { name: 'smelt', checkpoint: { op: 'smelt', furnace: { x: 1, y: 64, z: 0 } } },
  ]);
  assert.equal(h.body.cancels, 1, '清理之前动作必须已经被 abort');
  assert.match(h.runner.describe(), /body=idle/);
  await h.runner.settleDelivery();
  assert.deepEqual(h.submits, [], '有序停机不产生完成事件');
});

test('被反射抢占不是 stop：不跑清理钩子，检查点留给续做', async () => {
  const h = harness();
  await h.runner.toolText('collectBlock', { type: 'iron_ore' });
  h.body.report({ furnace: { x: 1, y: 64, z: 0 } });
  h.runner.notify(event('hostile'));
  await waitFor(() => h.body.calls.length === 2);
  assert.deepEqual(h.body.stopCalls, [], '抢占只存检查点，不清现场');
  assert.deepEqual(h.body.calls[1]?.checkpoint, { furnace: { x: 1, y: 64, z: 0 } });
});

test('manual 策略：被抢占后不续做，给一条明确的完成事件', async () => {
  const h = harness();
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  h.runner.notify(event('hostile'));
  await waitFor(() => h.submits.length === 1);
  assert.equal(h.body.calls.length, 1, 'manual 策略不重新执行');
  assert.match(h.submits[0] ?? '', /被 combat 打断，未续做/);
});

test('Stop 也打断正在跑的反射：身体同一时刻只有一个执行者', async () => {
  const signals: AbortSignal[] = [];
  const h = harness({
    runReflex: async (_name, signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  h.runner.notify(event('hostile'));
  await tick();
  assert.equal(h.runner.control.body?.by, 'reflex');

  await h.runner.stop();
  await h.runner.settleReflexes();
  assert.equal(signals[0]?.aborted, true, 'Stop 必须 abort 反射执行体');
  assert.equal(h.runner.control.body, null);
});

test('断线：在飞动作被中止，锁释放，后续动作能继续', async () => {
  const h = harness();
  await h.runner.toolText('mineBlock', { x: 1, y: 2, z: 3 });
  h.runner.notify({ type: 'system.disconnected', kind: 'World', level: 4, payload: {}, text: '断线', ts: 0 });
  assert.match(h.runner.describe(), /body=idle/);

  const accepted = await h.runner.toolText('mineBlock', { x: 2, y: 2, z: 3 });
  assert.match(accepted, /accepted/);
  assert.equal(h.body.calls.length, 2, '断线后新动作必须能认领身体');
  h.body.finish('继续挖');
  await waitFor(() => h.submits.some((line) => line.includes('继续挖')));
  assert.ok(h.submits.some((line) => line.includes('继续挖')));
});

test('KillAura 抢占模型攻击：取消 → 反射收手 → 按原参数续做', async () => {
  const h = harness({ tools: [{ ...TOOLS[3]! }] });
  await h.runner.toolText('attack', { entityId: 7 });
  assert.deepEqual(h.body.calls[0]?.args, { entityId: 7 });

  h.runner.notify(event('hostile'));
  await waitFor(() => h.body.calls.length === 2);
  assert.equal(h.body.cancels, 1, '模型攻击要被取消');
  assert.deepEqual(h.body.calls[1]?.args, { entityId: 7 }, '续做沿用原参数');
  assert.equal(h.body.calls[1]?.checkpoint, undefined, '没写检查点时续做不带数据');

  h.body.finish('打死了僵尸');
  await waitFor(() => h.submits.length === 1);
  assert.match(h.submits[0] ?? '', /打死了僵尸/);
  assert.match(h.submits[0] ?? '', /已重新开始/);
});

test('L5 事件只写记录、不唤醒', async () => {
  const h = harness();
  h.runner.notify(event('hostile'));
  await h.runner.settleReflexes();
  await h.runner.settleDelivery();
  assert.deepEqual(h.writes, ['hostile']);
  assert.deepEqual(h.submits, []);
});

test('本地工具走本地、不认领身体；没有本地实现的查询工具直接报错', async () => {
  const declarations: readonly ToolDeclaration[] = [
    { name: 'Say', description: '', mode: 'sync', action: false, params: { text: { type: 'string' } } },
    { name: 'Stop', description: '', mode: 'sync', action: false },
    { name: 'ghost', description: '', mode: 'sync', action: false },
  ];
  const body = {
    execute: async (name: string) => ({ text: `身体答：${name}` }),
  };
  let runnerRef: Runner | null = null;
  const runner = new Runner({
    tools: declarations,
    body,
    deps: { submit: async () => {}, write: async () => {}, abort: async () => {} },
    localTools: {
      Say: (args) => `说了：${String(args.text)}`,
      Stop: () => runnerRef?.stop() ?? '没准备好',
    },
    now: () => 1000,
  });
  runnerRef = runner;
  assert.equal(await runner.toolText('Say', { text: '你好' }), '说了：你好');
  assert.match(runner.describe(), /body=idle/);
  assert.match(await runner.toolText('ghost', {}), /没有这个本地工具/, '查询工具必须有本地实现');
  assert.match(runner.describe(), /body=idle/);
  assert.equal(await runner.toolText('Stop', {}), '身体空闲，没有要停的动作');
});

test('工具结果超长会留头留尾截断', () => {
  const text = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
  const clamped = clampToolOutput(text);
  assert.ok(clamped.length < text.length);
  assert.match(clamped, /中间截掉了/);
  assert.match(clamped, /^a{9000}/);
});
