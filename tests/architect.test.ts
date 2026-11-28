import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createArchitecture } from '../src/agent/architect.ts';
import type { BuildDelivery } from '../src/agent/build_sessions.ts';
import type { DesignEvent, DesignInput, DesignSession } from '../src/agent/architect.ts';
import { readBlueprint } from '../src/agent/blueprints.ts';
import { readBuildSession } from '../src/agent/build_sessions.ts';

const OK: BuildDelivery = {
  summary: '一座小塔',
  tags: ['tower', 'stone'],
  reusable: true,
  size: { x: 5, y: 9, z: 5 },
  blocks: 120,
  materials: { stone: 120 },
  revision: 1,
};

function setup(sessionFor: (sessionId: string, blueprintId: string) => DesignSession) {
  const base = mkdtempSync(join(tmpdir(), 'tc-arch-'));
  const blueprintsRoot = join(base, 'blueprints');
  const sessionsRoot = join(base, 'sessions');
  const events: DesignEvent[] = [];
  const architecture = createArchitecture({
    blueprintsRoot,
    sessionsRoot,
    mc: () => '1.21.4',
    createSession: sessionFor,
    onEvent: (event) => events.push(event),
  });
  return { base, blueprintsRoot, sessionsRoot, events, architecture, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function instant(result: BuildDelivery | null): DesignSession {
  return { run: async () => result };
}

test('设计交付：稳定 Session ID、awaiting_review、revision 1、done 事件带 ID', async () => {
  const env = setup(() => instant(OK));
  const task = env.architecture.start('小塔', ['tower']);
  assert.match(task.sessionId, /^session-/);
  assert.equal(task.state, 'running');
  await env.architecture.settle();

  const meta = readBlueprint(env.blueprintsRoot, task.blueprintId);
  assert.ok(meta != null);
  assert.deepEqual(meta.size, { x: 5, y: 9, z: 5 });
  assert.equal(meta.blocks, 120);
  const session = readBuildSession(env.sessionsRoot, task.sessionId);
  assert.equal(session?.state, 'awaiting_review');
  assert.equal(session?.revision, 1);
  assert.equal(session?.lastDelivery?.summary, '一座小塔');
  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].kind, 'done');
  assert.equal(env.events[0].sessionId, task.sessionId);
  assert.equal(env.events[0].revision, 1);
  env.cleanup();
});

test('设计失败：状态 failed，事件带原因，不增加 revision', async () => {
  const env = setup(() => instant(null));
  const task = env.architecture.start('小塔');
  await env.architecture.settle();
  const session = readBuildSession(env.sessionsRoot, task.sessionId);
  assert.equal(session?.state, 'failed');
  assert.equal(session?.revision, 0);
  assert.equal(env.events[0].kind, 'failed');
  assert.match(env.events[0].text, /没有通过自检/);
  env.cleanup();
});

test('取消：abort 正在跑的会话，状态 cancelled，不发 done', async () => {
  const env = setup(() => ({
    run: (input: DesignInput) =>
      new Promise<BuildDelivery | null>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  }));
  const task = env.architecture.start('大教堂');
  assert.equal(env.architecture.cancel(task.sessionId), true);
  await env.architecture.settle();
  assert.equal(readBuildSession(env.sessionsRoot, task.sessionId)?.state, 'cancelled');
  assert.equal(env.events[0].kind, 'cancelled');
  assert.equal(env.architecture.cancel('nope'), false);
  env.cleanup();
});

test('打回：同一 Session ID 重开，revision 递增，意见追加到原会话', async () => {
  const calls: Array<{ sessionId: string; blueprintId: string; message: string; revision: number }> = [];
  const env = setup((sessionId, blueprintId) => ({
    run: async (input: DesignInput) => {
      calls.push({ sessionId, blueprintId, message: input.message, revision: input.revision });
      return { ...OK, summary: `第${input.revision}版`, revision: input.revision };
    },
  }));
  const first = env.architecture.start('旧塔');
  await env.architecture.settle();
  const second = env.architecture.send(first.sessionId, '屋顶换成深色木');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.blueprintId, first.blueprintId);
  assert.equal(second.state, 'running');
  await env.architecture.settle();

  assert.deepEqual(calls.map((call) => call.message), ['旧塔', '屋顶换成深色木']);
  assert.deepEqual(calls.map((call) => call.revision), [1, 2]);
  assert.ok(calls.every((call) => call.sessionId === first.sessionId && call.blueprintId === first.blueprintId));
  const session = readBuildSession(env.sessionsRoot, first.sessionId);
  assert.equal(session?.state, 'awaiting_review');
  assert.equal(session?.revision, 2);
  assert.equal(session?.lastDelivery?.summary, '第2版');
  env.cleanup();
});

test('运行中打回拒绝；接受只允许 awaiting_review', async () => {
  let release: (() => void) | undefined;
  const env = setup(() => ({ run: async () => { await new Promise<void>((resolve) => { release = resolve; }); return OK; } }));
  const task = env.architecture.start('塔');
  assert.throws(() => env.architecture.send(task.sessionId, '改'), /正在运行/);
  release?.();
  await env.architecture.settle();
  assert.equal(env.architecture.accept(task.sessionId), true);
  assert.equal(readBuildSession(env.sessionsRoot, task.sessionId)?.state, 'accepted');
  assert.equal(env.architecture.accept(task.sessionId), false);
  env.cleanup();
});

test('打回不存在或不存在的会话：明确报错', () => {
  const env = setup(() => instant(OK));
  assert.throws(() => env.architecture.send('missing', '改'), /没有这个会话/);
  assert.throws(() => env.architecture.accept('missing'), /没有这个会话/);
  env.cleanup();
});

test('并发：两个会话同时跑，各自完成', async () => {
  let active = 0;
  let peak = 0;
  const env = setup(() => ({
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return OK;
    },
  }));
  env.architecture.start('塔 A');
  env.architecture.start('塔 B');
  await env.architecture.settle();
  assert.equal(peak, 2);
  assert.deepEqual(env.architecture.list().map((task) => task.state), ['awaiting_review', 'awaiting_review']);
  env.cleanup();
});
