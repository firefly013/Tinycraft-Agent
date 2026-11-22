import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createArchitecture } from '../src/agent/architect.ts';
import type { DesignEvent, DesignInput, DesignResult, DesignSession } from '../src/agent/architect.ts';
import { createBlueprint, readBlueprint } from '../src/agent/blueprints.ts';

const OK: DesignResult = {
  summary: '一座小塔',
  tags: ['tower', 'stone'],
  reusable: true,
  size: { x: 5, y: 9, z: 5 },
  blocks: 120,
  materials: { stone: 120 },
};

function setup(sessionFor: (id: string) => DesignSession) {
  const base = mkdtempSync(join(tmpdir(), 'tc-arch-'));
  const root = join(base, 'blueprints');
  const events: DesignEvent[] = [];
  const architecture = createArchitecture({
    blueprintsRoot: root,
    mc: () => '1.21.4',
    createSession: sessionFor,
    onEvent: (event) => events.push(event),
  });
  return { base, root, events, architecture, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function instant(result: DesignResult | null): DesignSession {
  return { run: async () => result };
}

test('设计完成：写回 meta、发 done 事件、状态变 done', async () => {
  const env = setup(() => instant(OK));
  const task = env.architecture.start('小塔', ['tower']);
  assert.equal(task.state, 'running');
  assert.ok(existsSync(join(env.root, task.blueprintId, 'meta.json')));
  await env.architecture.settle();

  const meta = readBlueprint(env.root, task.blueprintId);
  assert.ok(meta != null);
  assert.deepEqual(meta.size, { x: 5, y: 9, z: 5 });
  assert.equal(meta.blocks, 120);
  assert.equal(meta.reusable, true);
  assert.deepEqual(meta.tags, ['tower', 'stone']);
  assert.equal(meta.mc, '1.21.4');
  assert.equal(env.architecture.list()[0].state, 'done');
  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].kind, 'done');
  assert.match(env.events[0].text, /设计完成：/);
  env.cleanup();
});

test('设计失败：不发蓝图、状态 failed、事件带原因', async () => {
  const env = setup(() => instant(null));
  const task = env.architecture.start('小塔');
  await env.architecture.settle();
  assert.equal(env.architecture.list()[0].state, 'failed');
  assert.equal(env.events[0].kind, 'failed');
  assert.match(env.events[0].text, /没有通过自检/);
  assert.equal(readBlueprint(env.root, task.blueprintId)?.blocks, 0);
  env.cleanup();
});

test('取消：abort 正在跑的会话，状态 cancelled，不发 done', async () => {
  const env = setup(() => ({
    run: (input: DesignInput) =>
      new Promise<DesignResult | null>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  }));
  const task = env.architecture.start('大教堂');
  assert.equal(env.architecture.cancel(task.taskId), true);
  await env.architecture.settle();
  assert.equal(env.architecture.list()[0].state, 'cancelled');
  assert.equal(env.events[0].kind, 'cancelled');
  assert.equal(env.architecture.cancel('nope'), false);
  env.cleanup();
});

test('返工：同一个蓝图目录、把备注交给会话、任务 id 不与原任务重复', async () => {
  const seen: (string | undefined)[] = [];
  const env = setup(() => ({
    run: async (input: DesignInput) => {
      seen.push(input.notes);
      return OK;
    },
  }));
  const blueprint = createBlueprint(env.root, '旧塔');
  const task = env.architecture.rework(blueprint.id, '屋顶换成深色木');
  assert.notEqual(task.taskId, blueprint.id);
  assert.equal(task.blueprintId, blueprint.id);
  await env.architecture.settle();
  assert.deepEqual(seen, ['屋顶换成深色木']);
  assert.equal(env.architecture.list().at(-1)?.state, 'done');
  env.cleanup();
});

test('返工不存在的蓝图：明确报错', () => {
  const env = setup(() => instant(OK));
  assert.throws(() => env.architecture.rework('missing', '改'), /没有这个蓝图/);
  env.cleanup();
});

test('并发：两个设计任务同时跑，各自完成', async () => {
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
  assert.deepEqual(
    env.architecture.list().map((task) => task.state),
    ['done', 'done'],
  );
  env.cleanup();
});
