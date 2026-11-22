import test from 'node:test';
import assert from 'node:assert/strict';

import { itemForState, planBuild } from '../src/body/build_planner.ts';
import type { WorldCell, WorldView } from '../src/body/build_planner.ts';

const AIR: WorldCell = { state: 'minecraft:air', solid: false };
const STONE: WorldCell = { state: 'minecraft:stone', solid: true };

/** 默认全是空气；cells 里给的坐标覆盖。 */
function airWorld(cells: Record<string, WorldCell | undefined> = {}): WorldView {
  return {
    at(x, y, z) {
      const key = `${x},${y},${z}`;
      return key in cells ? (cells[key] ?? null) : AIR;
    },
  };
}

test('单块放在石头上：依附面是下面，不用先挖', () => {
  const plan = planBuild([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }], {
    world: airWorld({ '0,0,0': STONE, '0,1,0': AIR }),
    inventory: { stone: 1 },
  });
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].face, { x: 0, y: 0, z: 0 });
  assert.equal(plan.steps[0].clear, false);
  assert.equal(plan.steps[0].item, 'stone');
  assert.equal(plan.counts.toDig, 0);
});

test('已经是目标状态：不算要放，记 satisfied', () => {
  const plan = planBuild([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }], {
    world: airWorld({ '0,0,0': STONE, '0,1,0': STONE }),
    inventory: {},
  });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.counts.satisfied, 1);
  assert.deepEqual(plan.missing, []);
});

test('现有方块不同且可挖：标记 clear，计入 toDig', () => {
  const dirt: WorldCell = { state: 'minecraft:dirt', solid: true };
  const plan = planBuild([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }], {
    world: airWorld({ '0,0,0': STONE, '0,1,0': dirt }),
    inventory: { stone: 1 },
  });
  assert.equal(plan.steps[0].clear, true);
  assert.equal(plan.counts.toDig, 1);
});

test('不可挖的方块：跳过并说明原因', () => {
  const bedrock: WorldCell = { state: 'minecraft:bedrock', solid: true };
  const plan = planBuild([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }], {
    world: airWorld({ '0,0,0': STONE, '0,1,0': bedrock }),
    inventory: { stone: 1 },
  });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /不可挖/);
});

test('四周全是空气：没有依附面，跳过', () => {
  const plan = planBuild([{ x: 0, y: 5, z: 0, state: 'minecraft:stone' }], {
    world: airWorld(),
    inventory: { stone: 1 },
  });
  assert.equal(plan.steps.length, 0);
  assert.match(plan.skipped[0].reason, /依附/);
});

test('未加载的坐标：不猜，跳过', () => {
  const world: WorldView = { at: () => null };
  const plan = planBuild([{ x: 0, y: 1, z: 0, state: 'minecraft:stone' }], {
    world,
    inventory: { stone: 1 },
  });
  assert.equal(plan.steps.length, 0);
  assert.match(plan.skipped[0].reason, /未加载/);
});

test('材料不足：按物品汇总 need / have，并给出缺口总数', () => {
  const plan = planBuild(
    [
      { x: 0, y: 1, z: 0, state: 'minecraft:stone' },
      { x: 1, y: 1, z: 0, state: 'minecraft:stone' },
    ],
    {
      world: airWorld({ '0,0,0': STONE, '1,0,0': STONE }),
      inventory: { stone: 1 },
    },
  );
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.missing, [{ item: 'stone', need: 2, have: 1 }]);
  assert.equal(plan.counts.missing, 1);
});

test('步骤从下往上排，同层按 z、x', () => {
  const plan = planBuild(
    [
      { x: 0, y: 2, z: 0, state: 'minecraft:stone' },
      { x: 1, y: 1, z: 1, state: 'minecraft:stone' },
      { x: 0, y: 1, z: 1, state: 'minecraft:stone' },
    ],
    {
      world: airWorld({ '0,0,0': STONE, '1,0,0': STONE, '1,0,1': STONE, '0,0,1': STONE, '0,1,0': STONE }),
      inventory: { stone: 3 },
    },
  );
  assert.deepEqual(
    plan.steps.map((step) => `${step.y}:${step.z}:${step.x}`),
    ['1:1:0', '1:1:1', '2:0:0'],
  );
});

test('方块状态 → 物品：去掉命名空间与属性，处理挂墙变体', () => {
  assert.equal(itemForState('minecraft:oak_stairs[facing=east,half=bottom]'), 'oak_stairs');
  assert.equal(itemForState('minecraft:wall_torch[facing=south]'), 'torch');
  assert.equal(itemForState('minecraft:redstone_wall_torch[facing=west]'), 'redstone_torch');
  assert.equal(itemForState('minecraft:oak_wall_sign'), 'oak_sign');
  assert.equal(itemForState('minecraft:oak_wall_banner'), 'oak_banner');
  assert.equal(itemForState('minecraft:stone'), 'stone');
});
