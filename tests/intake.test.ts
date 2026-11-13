import test from 'node:test';
import assert from 'node:assert/strict';
import { EventIntake } from '../src/core/intake.ts';
import type { IntakeDeps } from '../src/core/intake.ts';
import type { Kind, Level, LogEvent } from '../src/core/events.ts';

const event = (type: string, level: Level, text = type): LogEvent => ({
  type,
  kind: 'World' as Kind,
  level,
  payload: {},
  text,
  ts: 0,
});

function harness(): {
  intake: EventIntake;
  submits: string[];
  writes: string[];
  actions: string[];
  errors: string[];
  aborts: () => number;
} {
  const intake = new EventIntake();
  const submits: string[] = [];
  const writes: string[] = [];
  const actions: string[] = [];
  const errors: string[] = [];
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
    onEvent: (item, action) => actions.push(`${item.type}:${action}`),
    onError: (error) => errors.push(String(error)),
  };
  intake.attach(deps);
  return { intake, submits, writes, actions, errors, aborts: () => aborts };
}

test('L2 只写记录，不唤醒', async () => {
  const h = harness();
  h.intake.notify(event('inventory.changed', 2, '背包变了'));
  await h.intake.settle();
  assert.deepEqual(h.writes, ['背包变了']);
  assert.deepEqual(h.submits, []);
  assert.deepEqual(h.actions, ['inventory.changed:written']);
});

test('L3 空闲：立刻发一次请求', async () => {
  const h = harness();
  h.intake.notify(event('player.chat', 3, '来砍树'));
  await h.intake.settle();
  assert.deepEqual(h.submits, ['来砍树']);
});

test('L3 整流：请求在飞时只攒，本轮结束一起带走', async () => {
  const h = harness();
  h.intake.requestStarted();
  h.intake.notify(event('a', 3));
  h.intake.notify(event('b', 3));
  await h.intake.settle();
  assert.deepEqual(h.submits, []);
  h.intake.requestFinished();
  await h.intake.settle();
  assert.deepEqual(h.submits, ['a\n\nb']);
});

test('L4 生成中：打断请求并重开', async () => {
  const h = harness();
  h.intake.requestStarted();
  h.intake.notify(event('self.death', 4, '你死了'));
  await h.intake.settle();
  assert.equal(h.aborts(), 1);
  assert.deepEqual(h.submits, ['你死了']);
  assert.deepEqual(h.actions, ['self.death:preempt']);
});

test('L5 生成中：打断请求但**不唤醒**，只写记录', async () => {
  const h = harness();
  h.intake.requestStarted();
  h.intake.notify(event('reflex.engage', 5, '落地水接管身体'));
  await h.intake.settle();
  assert.equal(h.aborts(), 1);
  assert.deepEqual(h.submits, []);
  assert.deepEqual(h.writes, ['落地水接管身体']);
  assert.deepEqual(h.actions, ['reflex.engage:emergency']);
});

test('L5 空闲：abort 是空操作，不唤醒、只写记录', async () => {
  const h = harness();
  h.intake.notify(event('reflex.engage', 5, '落地水接管身体'));
  await h.intake.settle();
  assert.equal(h.aborts(), 1, 'L5 一律尝试 abort；空闲时由运行时当空操作');
  assert.deepEqual(h.submits, []);
  assert.deepEqual(h.writes, ['落地水接管身体']);
});

test('断线不唤醒：L5 只记录，重连 L3 才是唯一一次唤醒', async () => {
  const h = harness();
  h.intake.requestStarted();
  h.intake.notify(event('system.disconnected', 5, '和服务器断开了，2 秒后重连'));
  await h.intake.settle();
  h.intake.requestFinished();
  await h.intake.settle();
  assert.deepEqual(h.submits, [], '断线时身体不在了：叫醒模型它也只能等');
  assert.deepEqual(h.writes, ['和服务器断开了，2 秒后重连']);

  h.intake.notify(event('system.reconnected', 3, '重连回来了，看一眼四周再继续'));
  await h.intake.settle();
  assert.deepEqual(h.submits, ['重连回来了，看一眼四周再继续'], '身体可用了才叫醒，且只叫一次');
});

test('L4 请求在飞时：立即 abort 打断，并立刻投递（不等 run 结束）', async () => {
  const h = harness();
  h.intake.requestStarted();
  h.intake.notify(event('self.death', 4, '你死了'));
  await h.intake.settle();
  assert.equal(h.aborts(), 1);
  assert.deepEqual(h.submits, ['你死了']);
  assert.deepEqual(h.actions, ['self.death:preempt']);
});

test('等级 1 是非法协议：记录错误并丢弃', async () => {
  const h = harness();
  h.intake.notify(event('weird', 1 as Level));
  await h.intake.settle();
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.submits, []);
});

test('泵在提交等待期间新到的事件，也会被这一轮带走', async () => {
  const intake = new EventIntake();
  const submits: string[] = [];
  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  intake.attach({
    submit: async (text) => {
      submits.push(text);
      if (submits.length === 1) await gate;
    },
    write: async () => {},
    abort: async () => {},
  });

  intake.notify(event('a', 3));
  await new Promise((resolve) => setTimeout(resolve, 0));
  intake.notify(event('b', 3));
  openGate();
  await intake.settle();

  assert.deepEqual(submits, ['a', 'b']);
});

test('write 持续失败不会紧循环：一轮只试一次', async () => {
  const intake = new EventIntake();
  let attempts = 0;
  const errors: unknown[] = [];
  intake.attach({
    submit: async () => {},
    write: async () => {
      attempts += 1;
      throw new Error('disk full');
    },
    abort: async () => {},
    onError: (error) => errors.push(error),
  });

  intake.notify(event('a', 2));
  await intake.settle();
  assert.equal(attempts, 1, '同一轮里不许重试');
  assert.equal(errors.length, 1);

  intake.notify(event('b', 2));
  await intake.settle();
  assert.equal(attempts, 2, '下一条事件触发一次重试');
});

test('abort 失败：请求相位恢复，触发它的事件不丢', async () => {
  const intake = new EventIntake();
  const submits: string[] = [];
  const errors: unknown[] = [];
  let failAbort = true;
  intake.attach({
    submit: async (text) => {
      submits.push(text);
    },
    write: async () => {},
    abort: async () => {
      if (failAbort) throw new Error('abort failed');
    },
    onError: (error) => errors.push(error),
  });

  intake.requestStarted(); // 正在生成
  intake.notify(event('death', 4));
  await intake.settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(submits, ['death'], 'abort 失败也不能丢事件');

  failAbort = false;
  intake.notify(event('chat', 3));
  await intake.settle();
  assert.deepEqual(submits, ['death', 'chat'], '相位恢复后 L3 能正常唤醒');
});

test('提交失败不丢唤醒：攒着的会跟下一次事件一起走', async () => {
  const intake = new EventIntake();
  const submits: string[] = [];
  const errors: string[] = [];
  let fail = true;
  intake.attach({
    submit: async (text) => {
      if (fail) throw new Error('boom');
      submits.push(text);
    },
    write: async () => {},
    abort: async () => {},
    onError: (error) => errors.push(String(error)),
  });

  intake.notify(event('a', 3));
  await intake.settle();
  assert.equal(errors.length, 1);
  assert.deepEqual(submits, []);

  fail = false;
  intake.notify(event('b', 3));
  await intake.settle();
  assert.deepEqual(submits, ['a\n\nb']);
});

test('反射期间 L3 排队，反射结束后一次交付', async () => {
  const h = harness();
  h.intake.reflexStarted();
  h.intake.notify(event('player.chat', 3, '来砍树'));
  await h.intake.settle();
  assert.deepEqual(h.submits, []);
  h.intake.reflexFinished();
  await h.intake.settle();
  assert.deepEqual(h.submits, ['来砍树']);
});

test('interrupt：掐掉在飞请求并放掉标志，后续 L3 不会被永久扣住', async () => {
  const h = harness();
  h.intake.requestStarted();
  await h.intake.interrupt();
  assert.equal(h.aborts(), 1);
  assert.deepEqual(h.submits, [], '打断本身不唤醒');
  h.intake.notify(event('player.chat', 3, '在吗'));
  await h.intake.settle();
  assert.deepEqual(h.submits, ['在吗'], '标志已释放，L3 能正常唤醒');
});

test('interrupt：空闲时是空操作（不 abort）', async () => {
  const h = harness();
  await h.intake.interrupt();
  assert.equal(h.aborts(), 0);
  assert.deepEqual(h.submits, []);
});

test('反射期间 L4 不打断，结束后才交付', async () => {
  const h = harness();
  h.intake.reflexStarted();
  h.intake.requestStarted();
  h.intake.notify(event('self.death', 4, '你死了'));
  await h.intake.settle();
  assert.equal(h.aborts(), 0, '反射期间不能 abort 安全反射');
  assert.deepEqual(h.submits, []);
  h.intake.reflexFinished();
  await h.intake.settle();
  assert.equal(h.aborts(), 1);
  assert.deepEqual(h.submits, ['你死了']);
});
