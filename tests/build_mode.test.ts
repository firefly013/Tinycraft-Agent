import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuildPrimitives, probeOp } from '../src/body/build.ts';
import type { PlaceOps, Pos } from '../src/body/place_bot.ts';
import type { EmitBlock, EmitPlan } from '../src/body/mcbuild.ts';

type Listener = (event: unknown) => void;

function fakeBot(seedReply: string | null) {
  const sent: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  return {
    sent,
    chat(message: string) {
      sent.push(message);
      if (message === '/seed' && seedReply != null) setImmediate(() => emit('message', seedReply));
    },
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    removeListener(event: string, listener: Listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((item) => item !== listener),
      );
    },
    blockAt() {
      return { name: 'stone' };
    },
    emit,
  };
}

function planOfBlocks(blocks: EmitBlock[]): EmitPlan {
  return {
    size: { x: 1, y: 1, z: 1 },
    origin: { x: 0, y: 0, z: 0 },
    commands: blocks.map((block) => `/setblock ${block.x} ${block.y} ${block.z} ${block.state} replace`),
    blocks,
    stats: {
      cells: 1,
      nonAir: blocks.length,
      states: 1,
      fills: 0,
      setblocks: blocks.length,
      entities: 0,
      commands: blocks.length,
      maxCommandLength: 40,
      tooLong: 0,
    },
    forceload: { x1: 0, z1: 0, x2: 0, z2: 0 },
    tooLong: [],
  };
}

function placeOps(initial: Record<string, string>, inventory: Record<string, number>) {
  const cells = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  const key = (pos: Pos): string => `${pos.x},${pos.y},${pos.z}`;
  const ops: PlaceOps = {
    stateAt: (pos) => cells.get(key(pos)) ?? 'minecraft:air',
    solidAt: (pos) => (cells.get(key(pos)) ?? 'minecraft:air') !== 'minecraft:air',
    inventory: () => inventory,
    dig: async (pos) => {
      calls.push(`dig ${key(pos)}`);
      cells.set(key(pos), 'minecraft:air');
    },
    equip: async (item) => {
      calls.push(`equip ${item}`);
    },
    reach: async (pos) => {
      calls.push(`reach ${key(pos)}`);
    },
    place: async (pos, state) => {
      calls.push(`place ${key(pos)}`);
      cells.set(key(pos), state);
    },
    stop: () => {},
  };
  return { ops, cells, calls };
}

function setup(seedReply: string | null, plan: EmitPlan, ops?: PlaceOps) {
  const root = mkdtempSync(join(tmpdir(), 'tc-mode-'));
  const dir = join(root, 'tower');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.schem'), 'x');
  const bot = fakeBot(seedReply);
  const primitives = createBuildPrimitives(bot, {
    blueprintsRoot: root,
    mcBuild: {
      dir: '/mc-build',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      build: async () => {
        throw new Error('not used');
      },
      emit: async () => ({ ok: true, plan }),
    },
    mc: () => '1.21.4',
    throttleMs: 0,
    ...(ops == null ? {} : { placeOps: ops }),
  });
  const context = { signal: new AbortController().signal, checkpoint: () => {} };
  return {
    root,
    bot,
    build: (args: Record<string, unknown> = {}) =>
      primitives.BuildAt({ blueprint: 'tower', x: 0, y: 0, z: 0, ...args }, context),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('probeOp：/seed 回执带种子 = 有权限', async () => {
  const bot = fakeBot('Seed: 12345');
  assert.equal(await probeOp(bot, 50), true);
});

test('probeOp：权限拒绝 = 没权限；没有回执按没权限', async () => {
  assert.equal(await probeOp(fakeBot('You do not have permission to use this command'), 50), false);
  assert.equal(await probeOp(fakeBot(null), 20), false);
});

test('默认模式：有 op 走命令，不用显式选', async () => {
  const env = setup('Seed: 1', planOfBlocks([{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }]));
  const text = await env.build();
  assert.match(text, /命令模式/);
  assert.ok(env.bot.sent.some((line) => line.startsWith('/setblock')));
  env.cleanup();
});

test('默认模式：没有 op 走逐块放置', async () => {
  const ops = placeOps({ '0,-1,0': 'minecraft:stone' }, { stone: 4 });
  const env = setup(
    'You do not have permission to use this command',
    planOfBlocks([{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }]),
    ops.ops,
  );
  const text = await env.build();
  assert.match(text, /逐块放置/);
  assert.deepEqual(ops.calls, ['reach 0,0,0', 'equip stone', 'place 0,0,0']);
  env.cleanup();
});

test('显式 mode 覆盖探测：没 op 也按命令走', async () => {
  const env = setup(
    'You do not have permission to use this command',
    planOfBlocks([{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }]),
  );
  const text = await env.build({ mode: 'command' });
  assert.match(text, /命令模式/);
  assert.ok(env.bot.sent.some((line) => line.startsWith('/setblock')));
  env.cleanup();
});
