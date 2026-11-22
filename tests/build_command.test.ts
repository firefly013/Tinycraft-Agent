import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuildPrimitives } from '../src/body/build.ts';
import type { EmitPlan } from '../src/body/mcbuild.ts';

type Listener = (event: unknown) => void;

function fakeBot() {
  const sent: string[] = [];
  const listeners = new Map<string, Listener[]>();
  return {
    sent,
    chat(message: string) {
      sent.push(message);
    },
    on(event: string, listener: Listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    removeListener(event: string, listener: Listener) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((item) => item !== listener),
      );
    },
    blockAt() {
      return { name: 'stone' };
    },
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

function planWith(commands: string[], overrides: Partial<EmitPlan> = {}): EmitPlan {
  const blocks = commands
    .filter((command) => command.startsWith('/setblock'))
    .map((command) => {
      const parts = command.split(' ');
      return { x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]), state: parts[4] };
    });
  return {
    size: { x: 3, y: 1, z: 3 },
    origin: { x: 0, y: 0, z: 0 },
    commands,
    blocks,
    stats: {
      cells: 9,
      nonAir: blocks.length,
      states: 1,
      fills: 0,
      setblocks: blocks.length,
      entities: 0,
      commands: commands.length,
      maxCommandLength: 60,
      tooLong: 0,
    },
    forceload: { x1: 0, z1: 0, x2: 2, z2: 2 },
    tooLong: [],
    ...overrides,
  };
}

function setup(plan: EmitPlan, options: { batchSize?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tc-build-'));
  const dir = join(root, 'tower');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.schem'), 'x');
  const bot = fakeBot();
  const checkpoints: unknown[] = [];
  const primitives = createBuildPrimitives(bot, {
    blueprintsRoot: root,
    mcBuild: {
      dir: '/mc-build',
      build: async () => {
        throw new Error('not used');
      },
      emit: async () => ({ ok: true, plan }),
    },
    mc: () => '1.21.4',
    batchSize: options.batchSize ?? 10,
    throttleMs: 0,
  });
  const context = {
    signal: new AbortController().signal,
    checkpoint: (value: unknown) => checkpoints.push(value),
  };
  return {
    root,
    bot,
    checkpoints,
    build: (args: Record<string, unknown> = {}) =>
      primitives.BuildAt({ blueprint: 'tower', x: 0, y: 64, z: 0, mode: 'command', ...args }, context),
    resume: (checkpoint: unknown, args: Record<string, unknown> = {}) =>
      primitives.BuildAt.resume!({ blueprint: 'tower', x: 0, y: 64, z: 0, mode: 'command', ...args }, context, checkpoint),
    undo: (args: Record<string, unknown> = {}) => primitives.UndoBuild({ blueprint: 'tower', ...args }, context),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('命令执行器：按批发送、每批上报检查点、前后 forceload', async () => {
  const commands = Array.from({ length: 25 }, (_, i) => `/setblock ${i} 64 0 minecraft:stone replace`);
  const env = setup(planWith(commands));
  const text = await env.build();
  const setblocks = env.bot.sent.filter((line) => line.startsWith('/setblock'));
  assert.equal(setblocks.length, 25);
  assert.ok(env.bot.sent[0].startsWith('/forceload add'));
  assert.ok(env.bot.sent.at(-1)?.startsWith('/forceload remove'));
  assert.deepEqual(env.checkpoints, [
    { mode: 'command', index: 1 },
    { mode: 'command', index: 2 },
    { mode: 'command', index: 3 },
  ]);
  assert.match(text, /施工完成/);
  env.cleanup();
});

test('命令执行器：服务器回执报错就停，并带回已发批次', async () => {
  const commands = Array.from({ length: 25 }, (_, i) => `/setblock ${i} 64 0 minecraft:stone replace`);
  const env = setup(planWith(commands));
  const original = env.bot.chat.bind(env.bot);
  let setblocks = 0;
  env.bot.chat = (message: string) => {
    original(message);
    if (!message.startsWith('/setblock')) return;
    setblocks += 1;
    if (setblocks === 3) env.bot.emit('message', 'You do not have permission to do that');
  };
  const text = await env.build();
  assert.match(text, /施工中止/);
  assert.match(text, /permission/);
  assert.equal(env.bot.sent.filter((line) => line.startsWith('/setblock')).length, 3);
  env.cleanup();
});

test('命令执行器：超长命令直接拒绝，一条都不发', async () => {
  const plan = planWith(['/setblock 0 64 0 minecraft:stone replace'], {
    stats: { cells: 1, nonAir: 1, states: 1, fills: 0, setblocks: 1, entities: 0, commands: 1, maxCommandLength: 300, tooLong: 1 },
    tooLong: ['/setblock ...'],
  });
  const env = setup(plan);
  await assert.rejects(() => env.build(), /超过 256/);
  assert.equal(env.bot.sent.length, 0);
  env.cleanup();
});

test('续做：从检查点的批次接着发，不重发前面的批次', async () => {
  const commands = Array.from({ length: 25 }, (_, i) => `/setblock ${i} 64 0 minecraft:stone replace`);
  const env = setup(planWith(commands));
  await env.resume({ mode: 'command', index: 2 });
  assert.equal(env.bot.sent.filter((line) => line.startsWith('/setblock')).length, 5);
  env.cleanup();
});

test('蓝图缺 plan.schem：明确报错', async () => {
  const env = setup(planWith([]));
  await assert.rejects(() => env.build({ blueprint: 'missing' }), /没有 plan\.schem/);
  env.cleanup();
});

test('抽查：方块对不上时给出数量', async () => {
  const env = setup(planWith(['/setblock 0 64 0 minecraft:stone replace']));
  env.bot.blockAt = () => ({ name: 'dirt' });
  const text = await env.build();
  assert.match(text, /有 1 格对不上/);
  env.cleanup();
});

test('命令施工的撤销：按快照用 /setblock 逐格恢复', async () => {
  const commands = Array.from({ length: 4 }, (_, i) => `/setblock ${i} 64 0 minecraft:stone replace`);
  const env = setup(planWith(commands));
  env.bot.blockAt = () => ({ name: 'dirt' });
  await env.build();
  const text = await env.undo();
  assert.match(text, /还原完成：4 格（命令）/);
  assert.equal(env.bot.sent.filter((line) => line.includes('minecraft:dirt')).length, 4);
  env.cleanup();
});
