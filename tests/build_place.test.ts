import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuildPrimitives } from '../src/body/build.ts';
import type { PlaceOps, Pos } from '../src/body/place_bot.ts';
import type { EmitBlock, EmitPlan } from '../src/body/mcbuild.ts';

const AIR = 'minecraft:air';
const key = (pos: Pos): string => `${pos.x},${pos.y},${pos.z}`;

function planOfBlocks(blocks: EmitBlock[]): EmitPlan {
  return {
    size: { x: 3, y: 3, z: 3 },
    origin: { x: 0, y: 0, z: 0 },
    commands: [],
    blocks,
    stats: {
      cells: 27,
      nonAir: blocks.length,
      states: 1,
      fills: 0,
      setblocks: 0,
      entities: 0,
      commands: 0,
      maxCommandLength: 0,
      tooLong: 0,
    },
    forceload: { x1: 0, z1: 0, x2: 2, z2: 2 },
    tooLong: [],
  };
}

function makeOps(initial: Record<string, string>, inventory: Record<string, number>) {
  const cells = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  let failPlace = false;
  const ops: PlaceOps = {
    stateAt: (pos) => (cells.has(key(pos)) ? (cells.get(key(pos)) as string) : AIR),
    solidAt: (pos) => {
      const state = cells.get(key(pos));
      return state != null && state !== AIR && !state.includes('water');
    },
    inventory: () => inventory,
    dig: async (pos) => {
      calls.push(`dig ${key(pos)}`);
      cells.set(key(pos), AIR);
    },
    equip: async (item) => {
      calls.push(`equip ${item}`);
    },
    reach: async (pos) => {
      calls.push(`reach ${key(pos)}`);
    },
    place: async (pos, state) => {
      calls.push(`place ${key(pos)}`);
      if (failPlace) throw new Error('够不着');
      cells.set(key(pos), state);
    },
    stop: () => {},
  };
  return { ops, cells, calls, fail: () => (failPlace = true) };
}

function setup(plan: EmitPlan, world: Record<string, string>, inventory: Record<string, number> = { stone: 99 }) {
  const root = mkdtempSync(join(tmpdir(), 'tc-place-'));
  const dir = join(root, 'tower');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.schem'), 'x');
  const fake = makeOps(world, inventory);
  const checkpoints: unknown[] = [];
  const primitives = createBuildPrimitives({} as never, {
    blueprintsRoot: root,
    mcBuild: {
      dir: '/mc-build',
      build: async () => {
        throw new Error('not used');
      },
      emit: async () => ({ ok: true, plan }),
    },
    mc: () => '1.21.4',
    placeOps: fake.ops,
    throttleMs: 0,
  });
  const context = {
    signal: new AbortController().signal,
    checkpoint: (value: unknown) => checkpoints.push(value),
  };
  return {
    fake,
    checkpoints,
    build: (args: Record<string, unknown> = {}) =>
      primitives.BuildAt({ blueprint: 'tower', x: 0, y: 0, z: 0, ...args }, context),
    resume: (checkpoint: unknown) =>
      primitives.BuildAt.resume!({ blueprint: 'tower', x: 0, y: 0, z: 0 }, context, checkpoint),
    undo: (args: Record<string, unknown> = {}) => primitives.UndoBuild({ blueprint: 'tower', ...args }, context),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('真实执行器：空地上放一块，按 place 顺序执行并核对状态', async () => {
  const env = setup(planOfBlocks([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }]), { '0,0,0': 'minecraft:stone' });
  const text = await env.build();
  assert.match(text, /施工完成：计划 1 步，放置 1/);
  assert.deepEqual(env.fake.calls, ['equip stone', 'reach 0,1,0', 'place 0,1,0']);
  assert.equal(env.fake.cells.get('0,1,0'), 'minecraft:stone');
  assert.deepEqual(env.checkpoints, [{ mode: 'place', index: 1 }]);
  env.cleanup();
});

test('真实执行器：规划阶段已经满足的方块不生成步骤', async () => {
  const env = setup(planOfBlocks([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }]), {
    '0,0,0': 'minecraft:stone',
    '0,1,0': 'minecraft:stone',
  });
  const text = await env.build();
  assert.match(text, /计划 0 步，放置 0/);
  assert.deepEqual(env.fake.calls, []);
  assert.deepEqual(env.checkpoints, []);
  env.cleanup();
});

test('真实执行器：目标位置有别的方块，先挖再放', async () => {
  const env = setup(planOfBlocks([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }]), {
    '0,0,0': 'minecraft:stone',
    '0,1,0': 'minecraft:dirt',
  });
  await env.build();
  assert.deepEqual(env.fake.calls.slice(0, 2), ['dig 0,1,0', 'equip stone']);
  env.cleanup();
});

test('真实执行器：材料不足时不开工，报缺口', async () => {
  const env = setup(
    planOfBlocks([
      { x: 0, y: 1, z: 0, state: 'minecraft:stone' },
      { x: 1, y: 1, z: 0, state: 'minecraft:stone' },
    ]),
    { '0,0,0': 'minecraft:stone', '1,0,0': 'minecraft:stone' },
    { stone: 1 },
  );
  const text = await env.build();
  assert.match(text, /材料不足，未开工/);
  assert.match(text, /stone 需要 2，只有 1/);
  assert.deepEqual(env.fake.calls, []);
  env.cleanup();
});

test('真实执行器：单块失败跳过，连续 10 块才整体停', async () => {
  const blocks = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 1, z: 0, state: 'minecraft:stone' }));
  const world: Record<string, string> = {};
  for (let i = 0; i < 12; i++) world[`${i},0,0`] = 'minecraft:stone';
  const env = setup(planOfBlocks(blocks), world);
  env.fake.fail();
  const text = await env.build();
  assert.match(text, /施工中断：连续失败 10 块/);
  assert.match(text, /够不着/);
  assert.equal(env.fake.calls.filter((call) => call.startsWith('place')).length, 10);
  env.cleanup();
});

test('真实执行器：续做从检查点的步骤继续，不重放前面的', async () => {
  const blocks = Array.from({ length: 3 }, (_, i) => ({ x: i, y: 1, z: 0, state: 'minecraft:stone' }));
  const world: Record<string, string> = { '0,0,0': 'minecraft:stone', '1,0,0': 'minecraft:stone', '2,0,0': 'minecraft:stone' };
  const env = setup(planOfBlocks(blocks), world);
  const text = await env.resume({ mode: 'place', index: 2 });
  assert.match(text, /放置 1/);
  assert.deepEqual(env.fake.calls.filter((call) => call.startsWith('place')), ['place 2,1,0']);
  env.cleanup();
});

test('撤销：按快照把挖掉的方块放回去、把新放的方块挖掉', async () => {
  const env = setup(
    planOfBlocks([
      { x: 0, y: 1, z: 0, state: 'minecraft:stone' },
      { x: 1, y: 1, z: 0, state: 'minecraft:stone' },
    ]),
    { '0,0,0': 'minecraft:stone', '1,0,0': 'minecraft:stone', '0,1,0': 'minecraft:dirt' },
    { stone: 9, dirt: 9 },
  );
  await env.build();
  assert.equal(env.fake.cells.get('0,1,0'), 'minecraft:stone');
  assert.equal(env.fake.cells.get('1,1,0'), 'minecraft:stone');

  const text = await env.undo();
  assert.match(text, /还原完成/);
  assert.equal(env.fake.cells.get('0,1,0'), 'minecraft:dirt');
  assert.equal(env.fake.cells.get('1,1,0'), 'minecraft:air');
  env.cleanup();
});

test('撤销：没有快照时明确说没有现场', async () => {
  const env = setup(planOfBlocks([]), {});
  const text = await env.undo();
  assert.match(text, /没有可还原的现场/);
  env.cleanup();
});
