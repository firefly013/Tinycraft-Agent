import test from 'node:test';
import assert from 'node:assert/strict';
import { makePrimitives, pickWeapon } from '../src/body/primitives.ts';
import type { ActionContext } from '../src/shared/body.ts';

function context(): { ctx: ActionContext; aborter: AbortController; checkpoints: unknown[] } {
  const aborter = new AbortController();
  const checkpoints: unknown[] = [];
  return {
    aborter,
    checkpoints,
    ctx: { signal: aborter.signal, checkpoint: (value) => checkpoints.push(value) },
  };
}

function baseBot(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    registry: {
      itemsByName: { oak_planks: { id: 5 }, crafting_table: { id: 58 } },
      blocksByName: { crafting_table: { id: 58 }, iron_ore: { id: 15 } },
    },
    inventory: { items: () => [], slots: [] },
    ...overrides,
  };
}

test('选武器：挑伤害最高的剑，别的都不算', () => {
  assert.equal(pickWeapon([]), null);
  assert.equal(pickWeapon([{ name: 'dirt' }, { name: 'iron_pickaxe' }]), null);
  assert.equal(pickWeapon([{ name: 'wooden_sword' }, { name: 'iron_sword' }]), 'iron_sword');
  assert.equal(
    pickWeapon([{ name: 'minecraft:diamond_sword' }, { name: 'netherite_sword' }]),
    'netherite_sword',
  );
});

test('合成：附近有工作台就直接用', async () => {
  const captured: Array<{ count: number; table: unknown }> = [];
  const inventory: Array<{ name: string; count: number }> = [];
  const bot = baseBot({
    inventory: { items: () => inventory, slots: [] },
    findBlock: () => ({ name: 'crafting_table' }),
    recipesFor: (_id: unknown, _meta: unknown, _n: unknown, table: unknown) =>
      table == null ? [] : [{ id: 'recipe' }],
    craft: async (_recipe: unknown, count: number, table: unknown) => {
      captured.push({ count, table });
      inventory.push({ name: 'oak_planks', count: 4 });
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();

  const text = await prims.craft?.({ item: 'oak_planks', count: 4 }, ctx);
  assert.match(text ?? '', /^合成了 oak_planks×4/);
  assert.equal(captured[0]?.count, 4);
  assert.notEqual(captured[0]?.table, null);
});

test('合成：服务器延迟入包时等产物真的出现', async () => {
  const inventory: Array<{ name: string; count: number }> = [];
  const bot = baseBot({
    inventory: { items: () => inventory, slots: [] },
    findBlock: () => ({ name: 'crafting_table' }),
    recipesFor: () => [{ result: { count: 1 } }],
    craft: async () => {
      setTimeout(() => inventory.push({ name: 'oak_planks', count: 4 }), 80);
    },
  });
  const prims = makePrimitives(bot);
  const text = await prims.craft?.({ item: 'oak_planks', count: 4 }, context().ctx);
  assert.match(text ?? '', /^合成了 oak_planks×4/);
});

test('合成：动作结束但产物没进背包，明确报失败而不是“合成了”', async () => {
  const bot = baseBot({
    findBlock: () => ({ name: 'crafting_table' }),
    recipesFor: () => [{ result: { count: 1 } }],
    craft: async () => {},
  });
  const prims = makePrimitives(bot);
  const text = await prims.craft?.({ item: 'oak_planks', count: 1 }, context().ctx);
  assert.match(text ?? '', /^合成失败/);
  assert.match(text ?? '', /没有增加/);
  assert.doesNotMatch(text ?? '', /^合成了/);
});

test('合成：没材料也没工作台，回执说清楚', async () => {
  const bot = baseBot({ findBlock: () => null, recipesFor: () => [] });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  assert.match((await prims.craft?.({ item: 'oak_planks' }, ctx)) ?? '', /做不出 oak_planks：/);
});

test('合成：缺木板/木棍时先在工具层补材料（4B 模型不会自己规划）', async () => {
  const inventory: Array<{ name: string; count: number; slot: number }> = [{ name: 'oak_log', count: 4, slot: 36 }];
  const itemNames: Record<number, string> = { 1: 'oak_log', 2: 'oak_planks', 3: 'stick', 4: 'wooden_pickaxe' };
  const items: Record<number, { name: string }> = {};
  for (const [id, name] of Object.entries(itemNames)) items[Number(id)] = { name };
  const recipes: Record<number, any[]> = {
    2: [{ delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], result: { id: 2, count: 4 } }],
    3: [{ delta: [{ id: 2, count: -2 }, { id: 3, count: 4 }], result: { id: 3, count: 4 } }],
    4: [{ delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 4, count: 1 }], result: { id: 4, count: 1 } }],
  };
  const craft = async (recipe: any, times: number): Promise<void> => {
    for (const delta of recipe.delta as Array<{ id: number; count: number }>) {
      const name = itemNames[delta.id]!;
      const entry = inventory.find((candidate) => candidate.name === name);
      if (entry == null) inventory.push({ name, count: delta.count * times, slot: 40 });
      else entry.count += delta.count * times;
    }
    for (let index = inventory.length - 1; index >= 0; index -= 1) {
      if (inventory[index]!.count <= 0) inventory.splice(index, 1);
    }
  };
  const bot = baseBot({
    registry: { items, itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 }, stick: { id: 3 }, wooden_pickaxe: { id: 4 } }, blocksByName: {} },
    inventory: { items: () => inventory, slots: [] },
    recipesFor: (id: number) => recipes[id] ?? [],
    craft,
    findBlock: () => null,
  });
  const prims = makePrimitives(bot);
  const text = await prims.craft?.({ item: 'wooden_pickaxe' }, context().ctx);
  assert.match(text ?? '', /合成了 wooden_pickaxe×1/);
  assert.match(text ?? '', /自动补材料/);
  assert.equal(inventory.find((entry) => entry.name === 'wooden_pickaxe')?.count, 1);
});
test('合成：recipesFor 因材料不足返回空时，用 recipesAll 规划并补料', async () => {
  const inventory: Array<{ name: string; count: number; slot: number }> = [{ name: 'oak_log', count: 4, slot: 36 }];
  const itemNames: Record<number, string> = { 1: 'oak_log', 2: 'oak_planks', 3: 'stick', 4: 'wooden_pickaxe' };
  const items: Record<number, { name: string }> = {};
  for (const [id, name] of Object.entries(itemNames)) items[Number(id)] = { name };
  const recipes: Record<number, any[]> = {
    2: [{ delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], result: { id: 2, count: 4 } }],
    3: [{ delta: [{ id: 2, count: -2 }, { id: 3, count: 4 }], result: { id: 3, count: 4 } }],
    4: [{ delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 4, count: 1 }], result: { id: 4, count: 1 } }],
  };
  const craft = async (recipe: any, times: number): Promise<void> => {
    for (const delta of recipe.delta as Array<{ id: number; count: number }>) {
      const name = itemNames[delta.id]!;
      const entry = inventory.find((candidate) => candidate.name === name);
      if (entry == null) inventory.push({ name, count: delta.count * times, slot: 40 });
      else entry.count += delta.count * times;
    }
    for (let index = inventory.length - 1; index >= 0; index -= 1) {
      if (inventory[index]!.count <= 0) inventory.splice(index, 1);
    }
  };
  // 和真 mineflayer 一样：recipesFor 只在材料够时返回配方；recipesAll 永远返回。
  const countOf = (name: string): number =>
    inventory.filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
  const materialOk = (recipe: any): boolean =>
    (recipe.delta as Array<{ id: number; count: number }>).every((delta) => countOf(itemNames[delta.id]!) + delta.count >= 0);
  const bot = baseBot({
    registry: {
      items,
      itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 }, stick: { id: 3 }, wooden_pickaxe: { id: 4 } },
      blocksByName: {},
    },
    inventory: { items: () => inventory, slots: [] },
    recipesFor: (id: number) => (recipes[id] ?? []).filter(materialOk),
    recipesAll: (id: number) => recipes[id] ?? [],
    craft,
    findBlock: () => null,
  });
  const prims = makePrimitives(bot);
  const text = await prims.craft?.({ item: 'wooden_pickaxe' }, context().ctx);
  assert.match(text ?? '', /合成了 wooden_pickaxe×1/);
  assert.match(text ?? '', /自动补材料/);
});
test('收集：数量不放大，正好挖要的个数', async () => {
  let dug = 0;
  const items: Array<{ name: string; count: number }> = [];
  let requested = 0;
  let scanRadius = 0;
  const blocks = [
    { name: 'iron_ore', position: { x: 1, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 2, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 3, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 4, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 5, y: 64, z: 0 } },
  ];
  const bot = baseBot({
    findBlocks: (options: { count: number; maxDistance: number }) => {
      requested = options.count;
      scanRadius = options.maxDistance;
      return blocks.map((block) => block.position).slice(0, options.count);
    },
    blockAt: (pos: { x: number; y: number; z: number }) => blocks.find((block) => block.position.x === pos.x) ?? null,
    inventory: { items: () => items, slots: [] },
    pathfinder: { setMovements: () => {}, goto: async () => {}, stop: () => {} },
    dig: async () => {
      dug += 1;
      items.push({ name: 'raw_iron', count: 1 });
    },
  });
  const prims = makePrimitives(bot);
  const { ctx, checkpoints } = context();

  const text = await prims.collectBlock?.({ type: 'iron_ore', count: 2, radius: 64 }, ctx);
  assert.equal(requested, 2, 'findBlocks 的 count 必须就是要的数量');
  assert.equal(scanRadius, 64, 'radius 必须传给 findBlocks');
  assert.equal(dug, 2);
  assert.match(text ?? '', /累计 2\/2/);
  assert.deepEqual(checkpoints, [{ got: 1 }, { got: 2 }]);
});

test('收集：从检查点续做，只补剩下的', async () => {
  let dug = 0;
  const items: Array<{ name: string; count: number }> = [];
  let requested = 0;
  const blocks = [
    { name: 'iron_ore', position: { x: 1, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 2, y: 64, z: 0 } },
    { name: 'iron_ore', position: { x: 3, y: 64, z: 0 } },
  ];
  const bot = baseBot({
    findBlocks: (options: { count: number }) => {
      requested = options.count;
      return blocks.map((block) => block.position).slice(0, options.count);
    },
    blockAt: (pos: { x: number; y: number; z: number }) => blocks.find((block) => block.position.x === pos.x) ?? null,
    inventory: { items: () => items, slots: [] },
    pathfinder: { setMovements: () => {}, goto: async () => {}, stop: () => {} },
    dig: async () => {
      dug += 1;
      items.push({ name: 'raw_iron', count: 1 });
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();

  const text = await prims.collectBlock?.resume?.({ type: 'iron_ore', count: 4 }, ctx, { got: 2 });
  assert.equal(requested, 2, '已经收了 2 个，只找剩下的 2 个');
  assert.equal(dug, 2);
  assert.match(text ?? '', /累计 4\/4/);
});

test('furnace：smelt 放燃料和原料，等产物并取出', async () => {
  const calls: string[] = [];
  let taken = 0;
  const furnaceWindow = {
    inputItem: () => null,
    outputItem: () => (taken === 0 ? { name: 'iron_ingot', count: 3 } : null),
    putFuel: async (_id: number, _meta: unknown, count: number) => {
      calls.push(`fuel:${count}`);
    },
    putInput: async (_id: number, _meta: unknown, count: number) => {
      calls.push(`input:${count}`);
    },
    takeOutput: async () => {
      taken += 1;
      calls.push('take');
    },
    close: () => {
      calls.push('close');
    },
  };
  const bot = baseBot({
    registry: {
      itemsByName: { iron_ore: { id: 15 }, coal: { id: 263 } },
      blocksByName: { furnace: { id: 61 } },
    },
    findBlock: () => ({ name: 'furnace' }),
    openFurnace: async () => furnaceWindow,
    inventory: { items: () => [{ name: 'coal', count: 5, slot: 1 }], slots: [] },
  });
  const prims = makePrimitives(bot);

  const text = await prims.furnace?.({ op: 'smelt', items: 'iron_ore:3', fuel: 'coal' }, context().ctx);
  assert.match(text ?? '', /烧出 3 个 iron_ingot/);
  assert.ok(calls.includes('fuel:1'), '3 个铁用 1 块煤就够');
  assert.ok(calls.includes('input:3'));
  assert.ok(calls.includes('take'));
  assert.ok(calls.includes('close'));
});

test('furnace：read 一次给三个槽，并说清能不能烧', async () => {
  const furnaceWindow = {
    inputItem: () => ({ name: 'iron_ore', count: 5 }),
    fuelItem: () => ({ name: 'coal', count: 8 }),
    outputItem: () => null,
    close: () => {},
  };
  const bot = baseBot({
    registry: { blocksByName: { furnace: { id: 61 } } },
    findBlock: () => ({ name: 'furnace' }),
    openFurnace: async () => furnaceWindow,
  });
  const prims = makePrimitives(bot);
  const text = await prims.furnace?.({ op: 'read' }, context().ctx);
  assert.match(text ?? '', /原料槽 iron_ore×5/);
  assert.match(text ?? '', /燃料槽 coal×8/);
  assert.match(text ?? '', /产物槽 空/);
  assert.match(text ?? '', /可以烧/);
});

test('furnace：put 写到指定槽，take 从指定槽取', async () => {
  const calls: string[] = [];
  const furnaceWindow = {
    inputItem: () => null,
    fuelItem: () => null,
    outputItem: () => null,
    putInput: async (_id: number, _meta: unknown, count: number) => {
      calls.push(`input:${count}`);
    },
    putFuel: async (_id: number, _meta: unknown, count: number) => {
      calls.push(`fuel:${count}`);
    },
    takeOutput: async () => {
      calls.push('take-out');
    },
    close: () => {},
  };
  const bot = baseBot({
    registry: { blocksByName: { furnace: { id: 61 } } },
    findBlock: () => ({ name: 'furnace' }),
    openFurnace: async () => furnaceWindow,
    inventory: { items: () => [{ name: 'coal', count: 5, type: 263, slot: 1 }], slots: [] },
  });
  const prims = makePrimitives(bot);
  const ctx = context().ctx;

  const put = await prims.furnace?.({ op: 'put', slot: 'fuel', items: 'coal:3' }, ctx);
  assert.match(put ?? '', /放入燃料槽：coal×3/);
  assert.deepEqual(calls, ['fuel:3']);

  const take = await prims.furnace?.({ op: 'take', slot: 'output' }, ctx);
  assert.match(take ?? '', /产物槽是空的/);
  assert.deepEqual(calls, ['fuel:3']);
});

test('furnace：参数不对就拒绝，不去开窗口', async () => {
  const prims = makePrimitives(baseBot());
  const ctx = context().ctx;
  assert.match((await prims.furnace?.({ op: 'eat' }, ctx)) ?? '', /furnace 的 op 只能是/);
  assert.match((await prims.furnace?.({ op: 'put', items: 'coal:1' }, ctx)) ?? '', /put 需要 slot/);
  assert.match((await prims.furnace?.({ op: 'take', slot: 'top' }, ctx)) ?? '', /slot 只能是/);
});

test('furnace：旁边没有熔炉就给清楚回执', async () => {
  const bot = baseBot({
    registry: { itemsByName: { iron_ore: { id: 15 }, coal: { id: 263 } }, blocksByName: {} },
    findBlock: () => null,
    inventory: { items: () => [{ name: 'coal', count: 5, slot: 1 }], slots: [] },
  });
  const prims = makePrimitives(bot);
  const text = await prims.furnace?.({ op: 'smelt', items: 'iron_ore:1', fuel: 'coal' }, context().ctx);
  assert.match(text ?? '', /没有熔炉/);
});

test('furnace：smelt 不填燃料直接拒绝', async () => {
  const bot = baseBot({
    registry: { itemsByName: { iron_ore: { id: 15 }, coal: { id: 263 } }, blocksByName: { furnace: { id: 61 } } },
    findBlock: () => ({ name: 'furnace' }),
  });
  const prims = makePrimitives(bot);
  const text = await prims.furnace?.({ op: 'smelt', items: 'iron_ore:1' }, context().ctx);
  assert.match(text ?? '', /smelt 需要 fuel/);
});
test('furnace stop：把三个槽都收回背包（产物 → 原料 → 燃料）', async () => {
  const calls: string[] = [];
  const window = {
    outputItem: () => ({ name: 'iron_ingot', count: 3 }),
    inputItem: () => ({ name: 'iron_ore', count: 2 }),
    fuelItem: () => ({ name: 'coal', count: 7 }),
    takeOutput: async () => {
      calls.push('output');
    },
    takeInput: async () => {
      calls.push('input');
    },
    takeFuel: async () => {
      calls.push('fuel');
    },
    close: () => {
      calls.push('close');
    },
  };
  const bot = baseBot({
    blockAt: () => ({ name: 'furnace', position: { x: 1, y: 64, z: 0 } }),
    openFurnace: async () => window,
  });
  const prims = makePrimitives(bot);
  const text = await prims.furnace!.stop!(context().ctx, { op: 'smelt', furnace: { x: 1, y: 64, z: 0 } });
  assert.match(text, /熔炉已清空/);
  assert.match(text, /iron_ingot×3/);
  assert.match(text, /iron_ore×2/);
  assert.match(text, /coal×7/);
  assert.deepEqual(calls.slice(0, 3), ['output', 'input', 'fuel']);
  assert.equal(calls.at(-1), 'close');
});

test('furnace stop：不碰 put 留下的东西；没有检查点时什么都不做', async () => {
  const prims = makePrimitives(baseBot({ blockAt: () => null }));
  const ctx = context().ctx;
  assert.equal(await prims.furnace!.stop!(ctx, { op: 'put', furnace: { x: 1, y: 64, z: 0 } }), '');
  assert.equal(await prims.furnace!.stop!(ctx, undefined), '');
});

test('furnace smelt：从检查点回来，按观测补料并继续', async () => {
  const calls: string[] = [];
  let input: any = null;
  let fuel: any = { name: 'coal', count: 2 };
  let burned = false;
  const window = {
    inputItem: () => input,
    fuelItem: () => fuel,
    outputItem: () => (burned ? { name: 'iron_ingot', count: 3 } : null),
    putInput: async (_id: number, _meta: unknown, count: number) => {
      calls.push(`input:${count}`);
      input = { name: 'iron_ore', count };
      burned = true;
    },
    putFuel: async () => {
      calls.push('fuel');
    },
    takeOutput: async () => {
      calls.push('take');
    },
    close: () => {},
  };
  const bot = baseBot({
    registry: { itemsByName: { iron_ore: { id: 15 }, coal: { id: 263 } }, blocksByName: {} },
    blockAt: () => ({ name: 'furnace', position: { x: 1, y: 64, z: 0 } }),
    openFurnace: async () => window,
    inventory: { items: () => [{ name: 'coal', count: 5, slot: 1 }], slots: [] },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.furnace?.resume?.({ op: 'smelt', items: 'iron_ore:3', fuel: 'coal' }, ctx, {
    op: 'smelt',
    furnace: { x: 1, y: 64, z: 0 },
  });
  assert.match(text ?? '', /烧出 3 个 iron_ingot/);
  assert.deepEqual(calls.filter((c) => c === 'fuel'), [], '燃料槽还有就不重复投');
  assert.ok(calls.includes('input:3'), '原料槽空了才补');
  assert.ok(calls.includes('take'));
});

test('挖方块：先自动换上能收获的工具，再 dig', async () => {
  const events: string[] = [];
  let held = { name: 'dirt', type: 3, slot: 36 };
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({
      name: 'iron_ore',
      position: { x: 1, y: 64, z: 0 },
      canHarvest: (type: number) => type === 1,
    }),
    heldItem: held,
    tool: {
      equipForBlock: async () => {
        events.push('equip');
        held = { name: 'stone_pickaxe', type: 1, slot: 37 };
        bot.heldItem = held;
      },
    },
    inventory: { items: () => [held], slots: [] },
    lookAt: async () => {},
    dig: async () => {
      events.push('dig');
    },
    pathfinder: { setMovements: () => {}, stop: () => {} },
    entities: {},
  });
  const prims = makePrimitives(bot);
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, context().ctx);
  assert.deepEqual(events, ['equip', 'dig'], '必须先换工具再挖');
  assert.match(text ?? '', /挖掉了 iron_ore/);
});

test('挖方块：没有能收获的工具时，要掉落就拒绝挖', async () => {
  let dug = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({
      name: 'iron_ore',
      position: { x: 1, y: 64, z: 0 },
      canHarvest: () => false,
      harvestTools: { 1: true },
    }),
    heldItem: null,
    inventory: { items: () => [], slots: [] },
    lookAt: async () => {},
    dig: async () => {
      dug = true;
    },
    pathfinder: { setMovements: () => {}, stop: () => {} },
    entities: {},
  });
  const prims = makePrimitives(bot);
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, context().ctx);
  assert.match(text ?? '', /没有能收获 iron_ore 的工具/);
  assert.equal(dug, false, '要掉落时不能裸挖');
});

test('挖方块：force 允许只求挖开', async () => {
  let dug = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({
      name: 'iron_ore',
      position: { x: 1, y: 64, z: 0 },
      canHarvest: () => false,
      harvestTools: { 1: true },
    }),
    heldItem: null,
    inventory: { items: () => [], slots: [] },
    lookAt: async () => {},
    dig: async () => {
      dug = true;
    },
    pathfinder: { setMovements: () => {}, stop: () => {} },
    entities: {},
  });
  const prims = makePrimitives(bot);
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0, force: true }, context().ctx);
  assert.equal(dug, true);
  assert.match(text ?? '', /force/);
});

test('挖方块：不挖自己脚下的承重方块', async () => {
  let dug = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone', position: { x: 0, y: 63, z: 0 } }),
    heldItem: null,
    inventory: { items: () => [], slots: [] },
    lookAt: async () => {},
    dig: async () => {
      dug = true;
    },
  });
  const prims = makePrimitives(bot);
  const text = await prims.mineBlock?.({ x: 0, y: 63, z: 0 }, context().ctx);
  assert.match(text ?? '', /脚下的承重方块/);
  assert.equal(dug, false);
});
test('挖方块：太远够不着就不挖', async () => {
  let dug = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone', position: { x: 100, y: 64, z: 0 } }),
    dig: async () => {
      dug = true;
    },
    lookAt: async () => {},
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();

  const text = await prims.mineBlock?.({ x: 100, y: 64, z: 0 }, ctx);
  assert.match(text ?? '', /太远够不着/);
  assert.equal(dug, false, '够不着就不该调用 dig');
});

test('收集：方块没真的消失就不算收到', async () => {
  const blocks = [{ name: 'iron_ore', position: { x: 1, y: 64, z: 0 } }];
  const bot = baseBot({
    findBlocks: (options: { count: number }) => blocks.map((block) => block.position).slice(0, options.count),
    blockAt: (pos: { x: number }) => blocks.find((block) => block.position.x === pos.x) ?? null,
    collectBlock: { collect: async () => {}, cancelTask: async () => {} },
    pathfinder: { setMovements: () => {}, goto: async () => {}, stop: () => {} },
    dig: async () => {},
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();

  const text = await prims.collectBlock?.({ type: 'iron_ore', count: 1 }, ctx);
  assert.match(text ?? '', /本次新增 0 个/);
});

test('合成：count 是产出个数，配方一次产 4 个就只合成 1 次', async () => {
  const times: number[] = [];
  const inventory: Array<{ name: string; count: number }> = [];
  const bot = baseBot({
    inventory: { items: () => inventory, slots: [] },
    findBlock: () => ({ name: 'crafting_table' }),
    recipesFor: () => [{ result: { count: 4 } }],
    craft: async (_recipe: unknown, count: number) => {
      times.push(count);
      inventory.push({ name: 'oak_planks', count: count * 4 });
    },
  });
  const prims = makePrimitives(bot);

  const text = await prims.craft?.({ item: 'oak_planks', count: 4 }, context().ctx);
  assert.match(text ?? '', /合成了 oak_planks×4/);
  await prims.craft?.({ item: 'oak_planks', count: 6 }, context().ctx);
  assert.deepEqual(times, [1, 2], '4 个 = 1 次；6 个 = 2 次');
});

test('挖方块：取消真的停手', async () => {
  let stopped = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone', position: { x: 1, y: 64, z: 0 } }),
    lookAt: async () => {},
    dig: () => new Promise(() => {}),
    stopDigging: () => {
      stopped = true;
    },
    heldItem: null,
  });
  const prims = makePrimitives(bot);
  const { ctx, aborter } = context();

  const pending = prims.mineBlock?.({ x: 1, y: 64, z: 0 }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  aborter.abort();
  assert.match((await pending) ?? '', /被中断/);
  assert.equal(stopped, true, '取消时应该调用 stopDigging');
});

test('挖方块：超时也停手，不只是不再等', async () => {
  let stopped = false;
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'stone', position: { x: 1, y: 64, z: 0 } }),
    lookAt: async () => {},
    dig: () => new Promise(() => {}),
    stopDigging: () => {
      stopped = true;
    },
    heldItem: null,
  });
  const prims = makePrimitives(bot, { timeoutMs: 10 });
  const { ctx } = context();

  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, ctx);
  assert.match(text ?? '', /还没挖开/);
  assert.equal(stopped, true, '超时必须 abort 底层操作');
});

test('custom-pvp：攻击走 swordpvp，并停掉插件', async () => {
  let stopCalls = 0;
  let attackCalls = 0;
  const target: any = { id: 7, name: 'zombie', isValid: true, health: 10, position: { x: 1, y: 64, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: { 7: target },
    inventory: { items: () => [{ name: 'stone_sword', type: 272, slot: 36 }], slots: [] },
    heldItem: { name: 'stone_sword', type: 272, slot: 36 },
    pathfinder: { setMovements: () => {}, stop: () => {} },
    swordpvp: {
      weaponOfChoice: 'sword',
      attack: async () => {
        attackCalls += 1;
        target.health = 0;
      },
      stop: () => {
        stopCalls += 1;
      },
    },
    bowpvp: { stop: () => {} },
  });
  const prims = makePrimitives(bot);
  const text = await prims.attack?.({ entityId: 7 }, context().ctx);
  assert.equal(attackCalls, 1);
  assert.match(text ?? '', /custom-pvp/);
  assert.match(text ?? '', /打死了 zombie/);
  assert.ok(stopCalls >= 1, '结束后必须 stopPvp');
});

test('placeBlock：续做时目标已经放好，回执是确认而不是失败', async () => {
  const bot = baseBot({
    inventory: { items: () => [{ name: 'dirt', count: 5 }], slots: [] },
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.placeBlock?.resume?.({ type: 'dirt', x: 1, y: 64, z: 0 }, ctx, { type: 'dirt' });
  assert.match(text ?? '', /续做确认/);
  assert.match(text ?? '', /已经是 dirt/);
});

test('placeBlock：目标已经是同一方块时不说“不能再放”', async () => {
  const bot = baseBot({
    inventory: { items: () => [{ name: 'dirt', count: 5 }], slots: [] },
    blockAt: () => ({ name: 'dirt', boundingBox: 'block' }),
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.placeBlock?.({ type: 'dirt', x: 1, y: 64, z: 0 }, ctx);
  assert.match(text ?? '', /已经是 dirt，不用再放/);
  assert.doesNotMatch(text ?? '', /不能再放/);
});

test('mineBlock：自己已经泡在水里不算“挖开导致接触”，不因此拒绝', async () => {
  const stone = { name: 'stone', boundingBox: 'block', position: { x: 1, y: 64, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (pos: any) => {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      if (x === 1 && y === 64 && z === 0) return stone;
      if (x === 0 && y === 64 && z === 0) return { name: 'water', boundingBox: 'empty' }; // Bot 脚下本来就泡着
      if (y <= 63) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, ctx);
  assert.doesNotMatch(text ?? '', /流到你/);
  // 没有被液体保护挡住：要么挖了，要么是别的失败原因。
  assert.match(text ?? '', /挖掉了|没挖动|没有能收获/);
});

test('mineBlock：挖开会把水引到头上时拒绝', async () => {
  const stone = { name: 'stone', boundingBox: 'block', position: { x: 0, y: 66, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (pos: any) => {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      if (x === 0 && y === 66 && z === 0) return stone;                 // 目标
      if (x === 0 && y === 67 && z === 0) return { name: 'water', boundingBox: 'empty' }; // 上方水源
      if (y <= 63) return { name: 'stone', boundingBox: 'block' };       // 地面
      return { name: 'air', boundingBox: 'empty' };
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.({ x: 0, y: 66, z: 0 }, ctx);
  assert.match(text ?? '', /水会流到你头上/);
  assert.match(text ?? '', /会被淹/);
});

test('mineBlock：挖开会把岩浆引到脚下时拒绝', async () => {
  const stone = { name: 'stone', boundingBox: 'block', position: { x: 1, y: 64, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (pos: any) => {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      if (x === 1 && y === 64 && z === 0) return stone;                 // 目标
      if (x === 2 && y === 64 && z === 0) return { name: 'lava', boundingBox: 'empty' }; // 侧面岩浆
      if (y <= 63) return { name: 'stone', boundingBox: 'block' };       // 地面
      return { name: 'air', boundingBox: 'empty' };
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, ctx);
  assert.match(text ?? '', /岩浆会流到你脚下/);
  assert.match(text ?? '', /会烧死/);
});

test('mineBlock：水/岩浆直接拒绝，force 也不放行', async () => {
  const water = { name: 'water', boundingBox: 'empty', position: { x: 1, y: 64, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: () => water,
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0, force: true }, ctx);
  assert.match(text ?? '', /液体，挖不了/);
  assert.doesNotMatch(text ?? '', /挖掉了/);
});

test('mineBlock：基岩等不可破坏方块直接拒绝', async () => {
  const bedrock = { name: 'bedrock', boundingBox: 'block', diggable: false, position: { x: 1, y: 64, z: 0 } };
  const bot = baseBot({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: () => bedrock,
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.({ x: 1, y: 64, z: 0 }, ctx);
  assert.match(text ?? '', /不可破坏/);
});

test('收集：全是液体时直接说挖不动，不发起 dig', async () => {
  let dug = 0;
  const blocks = [{ name: 'water', position: { x: 1, y: 64, z: 0 }, boundingBox: 'empty' }];
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { itemsByName: {}, blocksByName: { water: { id: 9 } } },
    findBlocks: (options: { count: number }) => blocks.map((block) => block.position).slice(0, options.count),
    blockAt: (pos: { x: number }) => blocks.find((block) => block.position.x === pos.x) ?? null,
    inventory: { items: () => [], slots: [] },
    dig: async () => {
      dug += 1;
    },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.collectBlock?.({ type: 'water', count: 1 }, ctx);
  assert.match(text ?? '', /都挖不动/);
  assert.equal(dug, 0, '液体不应该发起 dig');
});

test('mineBlock：续做时目标已是空气，回执是确认而不是失败', async () => {
  const bot = baseBot({ blockAt: () => ({ name: 'air', boundingBox: 'empty' }) });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.mineBlock?.resume?.({ x: 1, y: 64, z: 0 }, ctx, { x: 1, y: 64, z: 0 });
  assert.match(text ?? '', /续做确认/);
  assert.match(text ?? '', /已经是空气/);
});

test('attack：续做时目标已经消失，回执是确认而不是失败', async () => {
  const bot = baseBot({ entities: {} });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const text = await prims.attack?.resume?.({ entityId: 7 }, ctx, null);
  assert.match(text ?? '', /续做确认/);
  assert.match(text ?? '', /已经不在了/);
});

test('placeHere：跳起来在脚下垫方块', async () => {
  const calls: string[] = [];
  const entity: any = { position: { x: 0.5, y: 64, z: 0.5 }, onGround: true, velocity: { y: 0 } };
  let placed = false;
  const bot = baseBot({
    entity,
    inventory: { items: () => [{ name: 'dirt', count: 4 }], slots: [] },
    blockAt: (pos: { x: number; y: number; z: number }) => {
      if (pos.y === 64) return placed ? { name: 'dirt', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
      if (pos.y > 64) return { name: 'air', boundingBox: 'empty' };
      return { name: 'stone', boundingBox: 'block' };
    },
    setControlState: (state: string, on: boolean) => {
      if (state !== 'jump') return;
      if (on) {
        entity.onGround = false;
        entity.position.y = 65.25;
        entity.velocity.y = 0;
      } else {
        calls.push('jump-off');
      }
    },
    equip: async () => {},
    placeBlock: async () => {
      placed = true;
      entity.onGround = true;
      entity.position.y = 65;
      calls.push('place');
    },
    stopDigging: () => {},
  });
  const prims = makePrimitives(bot);
  const text = await prims.placeHere?.({ type: 'dirt' }, context().ctx);
  assert.deepEqual(calls.filter((c) => c === 'place'), ['place']);
  assert.match(text ?? '', /垫了 1 格/);
});

test('container：inspect 读内容，take/put 调用 withdraw/deposit', async () => {
  let closed = 0;
  let withdrawn = 0;
  let deposited = 0;
  const window = {
    containerItems: () => [{ name: 'iron_ingot', count: 5, type: 1 }],
    withdraw: async () => { withdrawn += 1; },
    deposit: async () => { deposited += 1; },
    close: () => { closed += 1; },
  };
  const bot = baseBot({
    blockAt: () => ({ name: 'chest', position: { x: 1, y: 64, z: 0 } }),
    openContainer: async () => window,
    inventory: { items: () => [{ name: 'coal', count: 3, slot: 36 }], slots: [] },
  });
  const prims = makePrimitives(bot);
  const ctx = context().ctx;
  const inspect = await prims.container?.({ op: 'inspect', coords: '1,64,0' }, ctx);
  assert.match(inspect ?? '', /iron_ingot×5/);
  const take = await prims.container?.({ op: 'take', coords: '1,64,0', items: 'iron_ingot:2' }, ctx);
  assert.match(take ?? '', /iron_ingot×2/);
  assert.equal(withdrawn, 1);
  const put = await prims.container?.({ op: 'put', coords: '1,64,0', items: 'coal:2' }, ctx);
  assert.match(put ?? '', /coal×2/);
  assert.equal(deposited, 1);
  assert.ok(closed >= 3, '每次操作都要关窗口');
});

test('container：未知 op 直接拒绝', async () => {
  const prims = makePrimitives(baseBot());
  assert.match((await prims.container?.({ op: 'eat' }, context().ctx)) ?? '', /container 的 op 只能是/);
});

test('container：熔炉坐标被拒，并指路到 furnace 工具', async () => {
  const bot = baseBot({
    blockAt: () => ({ name: 'furnace', position: { x: 1, y: 64, z: 0 } }),
  });
  const prims = makePrimitives(bot);
  const text = await prims.container?.({ op: 'inspect', coords: '1,64,0' }, context().ctx);
  assert.match(text ?? '', /用 furnace 工具/);
});

test('goTo：使用最大自由度 movements，不退回“只走路”配置', async () => {
  let used: unknown = null;
  const position = { x: 0, y: 64, z: 0 };
  const bot: Record<string, any> = baseBot({
    entity: { position },
    pathfinder: {
      setMovements: (value: unknown) => { used = value; },
      goto: async (goal: any) => {
        position.x = goal.x;
        position.y = goal.y;
        position.z = goal.z;
      },
      stop: () => {},
    },
  });
  const marker = { kind: 'max-freedom' };
  const prims = makePrimitives(bot, {
    movements: () => ({ reach: marker }),
  });
  const text = await prims.goTo?.({ x: 5, y: 65, z: 5 }, context().ctx);
  assert.deepEqual(used, marker);
  assert.match(text ?? '', /目标/);
});

test('goTo：失败时把 pathfinder 错误原样交给模型', async () => {
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    pathfinder: {
      setMovements: () => {},
      goto: async () => { throw new Error('NoPath'); },
      stop: () => {},
    },
  });
  const prims = makePrimitives(bot);
  const text = await prims.goTo?.({ x: 5, y: 65, z: 5 }, context().ctx);
  assert.match(text ?? '', /没走到/);
  assert.match(text ?? '', /NoPath/);
});

test('goTo：向上很远也分段推进，不套用下潜逻辑', async () => {
  const position = { x: 0, y: 64, z: 0 };
  const goals: Array<{ x: number; y: number; z: number }> = [];
  const bot: Record<string, any> = baseBot({
    entity: { position },
    pathfinder: {
      setMovements: () => {},
      goto: async (goal: any) => {
        goals.push({ x: goal.x, y: goal.y, z: goal.z });
        position.x = goal.x;
        position.y = goal.y;
        position.z = goal.z;
      },
      stop: () => {},
    },
  });
  const prims = makePrimitives(bot);
  await prims.goTo?.({ x: 0, y: 120, z: 0 }, context().ctx);
  assert.ok(goals.length > 1, `向上应分段，实际 ${goals.length} 次`);
  assert.ok(goals.every((goal) => goal.y <= 120));
});

test('goTo：长距离分成多段推进，不一次 A* 搜到底', async () => {
  const position = { x: 0, y: 64, z: 0 };
  const goals: Array<{ x: number; y: number; z: number }> = [];
  const bot: Record<string, any> = baseBot({
    entity: { position },
    pathfinder: {
      setMovements: () => {},
      goto: async (goal: any) => {
        goals.push({ x: goal.x, y: goal.y, z: goal.z });
        position.x = goal.x;
        position.y = goal.y;
        position.z = goal.z;
      },
      stop: () => {},
    },
  });
  const prims = makePrimitives(bot, {
    movements: () => ({ reach: {} }),
  });
  const text = await prims.goTo?.({ x: 100, y: 64, z: 0 }, context().ctx);
  assert.match(text ?? '', /目标/);
  assert.ok(goals.length >= 3, '应该分段推进，实际 ' + goals.length + ' 次');
  assert.ok(goals[0]!.x <= 24, '第一段不应直接搜到 100：' + goals[0]!.x);
  assert.equal(position.x, 100);
});

test('goTo：路上掉血立即停手并如实回报', async () => {
  const position = { x: 0, y: 64, z: 0 };
  const bot: Record<string, any> = baseBot({
    health: 20,
    entity: { position },
    pathfinder: {
      setMovements: () => {},
      goto: async (goal: any) => {
        position.x = goal.x;
        position.y = goal.y;
        position.z = goal.z;
        bot.health = 17;
      },
      stop: () => {},
    },
  });
  const prims = makePrimitives(bot);
  const text = await prims.goTo?.({ x: 5, y: 65, z: 5 }, context().ctx);
  assert.match(text ?? '', /中止 goTo/);
  assert.match(text ?? '', /掉血/);
});

test('收集 scope=loaded：扫所有已加载区块，不受 radius 限制', async () => {
  const logId = 20;
  const logState = 100;
  const logPos = { x: 85, y: 3, z: 3 };
  const items: Array<{ name: string; count: number }> = [];
  const bot = baseBot({
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { minY: 0 },
    registry: {
      itemsByName: {},
      blocksByName: { oak_log: { id: logId } },
      blocksByStateId: { [logState]: { id: logId }, 0: { id: 0 } },
    },
    world: {
      getColumns: () => [
        {
          chunkX: 5,
          chunkZ: 0,
          column: {
            sections: [{ palette: [logState] }],
            getBlockStateId: (pos: { x: number; y: number; z: number }) =>
              pos.x === logPos.x && pos.y === logPos.y && pos.z === logPos.z ? logState : 0,
          },
        },
      ],
    },
    findBlocks: () => [],
    blockAt: (pos: { x: number; y: number; z: number }) =>
      pos.x === logPos.x && pos.y === logPos.y && pos.z === logPos.z
        ? { name: 'oak_log', position: logPos }
        : null,
    inventory: { items: () => items, slots: [] },
    pathfinder: { setMovements: () => {}, goto: async () => {}, stop: () => {} },
    dig: async () => {
      items.push({ name: 'oak_log', count: 1 });
    },
  });
  const prims = makePrimitives(bot);

  const missed = await prims.collectBlock?.({ type: 'oak_log', count: 1 }, context().ctx);
  assert.match(missed ?? '', /附近 32 格内没找到 oak_log/);

  const text = await prims.collectBlock?.({ type: 'oak_log', count: 1, scope: 'loaded' }, context().ctx);
  assert.match(text ?? '', /累计 1\/1/);
});

test('合成：物品名写错（复数）时给出候选，而不是只说没有', async () => {
  const bot = baseBot({
    registry: {
      items: { 1: { name: 'stick' }, 2: { name: 'oak_planks' } },
      itemsByName: { stick: { id: 1 }, oak_planks: { id: 2 } },
      blocksByName: {},
    },
    recipesAll: () => [],
    recipesFor: () => [],
    findBlock: () => null,
  });
  const prims = makePrimitives(bot);
  const text = (await prims.craft?.({ item: 'sticks' }, context().ctx)) ?? '';
  assert.match(text, /没有叫 sticks 的物品/);
  assert.match(text, /是不是 stick/);
});

test('合成：失败回执说清缺什么料/要不要工作台', async () => {
  const items: Record<number, { name: string }> = { 1: { name: 'oak_log' }, 2: { name: 'oak_planks' }, 3: { name: 'stick' }, 4: { name: 'wooden_pickaxe' } };
  const recipes: Record<number, any[]> = {
    2: [{ requiresTable: false, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], result: { id: 2, count: 4 } }],
    4: [{ requiresTable: true, delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 4, count: 1 }], result: { id: 4, count: 1 } }],
  };
  const bot = baseBot({
    registry: { items, itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 }, stick: { id: 3 }, wooden_pickaxe: { id: 4 } }, blocksByName: {} },
    inventory: { items: () => [], slots: [] },
    recipesFor: () => [],
    recipesAll: (id: number) => recipes[id] ?? [],
    craft: async () => {},
    findBlock: () => null,
  });
  const prims = makePrimitives(bot);
  const text = (await prims.craft?.({ item: 'wooden_pickaxe' }, context().ctx)) ?? '';
  assert.match(text, /材料不够，缺/);
  assert.match(text, /oak_planks×3/);
});

test('背包 equip：没给槽位/物品名要说清楚，不默默清空主手', async () => {
  const unequipped: string[] = [];
  const equipped: Array<{ name: string; part: string }> = [];
  const items = [{ name: 'diamond_helmet', count: 1, slot: 28, type: 1 }];
  const slots: Array<any> = [];
  slots[28] = items[0];
  const bot = baseBot({
    inventory: { items: () => items, slots },
    heldItem: { name: 'cobblestone', slot: 0 },
    unequip: async (part: string) => { unequipped.push(part); },
    equip: async (item: any, part: string) => { equipped.push({ name: item.name, part }); },
  });
  const prims = makePrimitives(bot);
  const { ctx } = context();
  const missing = (await prims.inventory?.({ op: 'equip' }, ctx)) ?? '';
  assert.match(missing, /穿上了：diamond_helmet/, '不带参数 = 把盔甲整套穿上');
  assert.deepEqual(unequipped, [], '不能默默清空主手');
  assert.deepEqual(equipped, [{ name: 'diamond_helmet', part: 'head' }]);
  const byName = (await prims.inventory?.({ op: 'equip', item: 'diamond_helmet' }, ctx)) ?? '';
  assert.match(byName, /装备到了头上/);
  assert.equal(equipped.length, 2);
  assert.deepEqual(equipped.at(-1), { name: 'diamond_helmet', part: 'head' });
  const bySlot = (await prims.inventory?.({ op: 'equip', slot: 28 }, ctx)) ?? '';
  assert.match(bySlot, /装备到了头上/);
  assert.deepEqual(equipped.at(-1), { name: 'diamond_helmet', part: 'head' });
});

test('背包 equip：背包里没有盔甲时，空调用要说清楚', async () => {
  const bot = baseBot({ inventory: { items: () => [{ name: 'cobblestone', count: 5, slot: 0 }], slots: [] } });
  const prims = makePrimitives(bot);
  const text = (await prims.inventory?.({ op: 'equip' }, context().ctx)) ?? '';
  assert.match(text, /没有可穿的盔甲/);
});
