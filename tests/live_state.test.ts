import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSnapshot, snapshotFromBot } from '../src/body/live_state.ts';

function blockAt(position: { x: number; y: number; z: number }): {
  name: string;
  light: number;
  skyLight: number;
  biome: { name: string };
  transparent: boolean;
} {
  const key = `${position.x},${position.y},${position.z}`;
  const special: Record<string, string> = {
    '8,62,-1': 'iron_ore',
    '9,62,-1': 'stone',
    '20,62,-1': 'lava',
    '10,64,-3': 'grass_block',
  };
  const name = special[key] ?? 'air';
  return { name, light: 0, skyLight: 15, biome: { name: 'plains' }, transparent: name === 'air' };
}

function fakeBot(): any {
  const slots: any[] = new Array(46).fill(null);
  slots[5] = { name: 'diamond_helmet', count: 1, slot: 5 };
  slots[36] = { name: 'oak_log', count: 3, slot: 36 };
  slots[37] = { name: 'stone', count: 12, slot: 37 };
  slots[44] = { name: 'cooked_beef', count: 2, slot: 44 };
  return {
    username: 'Bot',
    entity: {
      id: 1,
      position: { x: 10.4, y: 64, z: -3.2 },
      yaw: 0.5,
      pitch: -0.2,
      velocity: { x: 0.1, y: 0, z: 0.2 },
      onGround: true,
      height: 1.62,
      metadata: [],
      effects: [{ id: 1, amplifier: 0, duration: 200 }],
    },
    health: 18,
    food: 17,
    foodSaturation: 4.2,
    experience: { level: 7, progress: 0.3 },
    inventory: { slots },
    heldItem: { name: 'iron_pickaxe', count: 1, durabilityUsed: 20, maxDurability: 250, ...{ slot: 0 } },
    quickBarSlot: 0,
    game: { dimension: 'minecraft:overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000, day: 3 },
    isRaining: false,
    currentWindow: null,
    registry: {
      itemsByName: { iron_pickaxe: { maxDurability: 250 } },
      effects: { '1': { id: 1, displayName: 'Speed' } },
    },
    getControlState: () => false,
    blockAt,
    entities: {
      '1': { id: 1, name: 'Bot', position: { x: 10.4, y: 64, z: -3.2 } },
      '5': { id: 5, name: 'zombie', position: { x: 13, y: 64, z: -3 } },
      '9': { id: 9, name: 'item', displayName: 'oak_log', position: { x: 11, y: 64, z: -4 } },
      '11': { id: 11, name: 'cow', position: { x: 12, y: 64, z: -4 } },
    },
  };
}

test('快照字段：身体/装备/背包/位置/环境/实体/方块/当前动作', () => {
  const state = snapshotFromBot(fakeBot(), '砍三棵树', 'mineBlock（工具，已经 3.2 秒）');

  assert.equal(state.body.health, 18);
  assert.equal(state.body.food, 17);
  assert.equal(state.body.saturation, 4.2);
  assert.equal(state.body.xpLevel, 7);
  assert.equal(state.body.onGround, true);
  assert.equal(state.body.effects[0], 'Speed I 10s');

  assert.equal(state.held.mainHand, 'iron_pickaxex1');
  assert.equal(state.held.mainHandDurabilityMax, 250);
  assert.equal(state.held.mainHandDurabilityUsed, 20);
  assert.deepEqual(state.held.armor, ['diamond_helmetx1']);

  assert.ok(state.backpack.items.includes('*[36]oak_logx3'), '快捷栏当前格标 *');
  assert.ok(state.backpack.items.includes('[37]stonex12'));
  assert.ok(state.backpack.items.includes('[5]diamond_helmetx1'), '护甲槽也要列出来');
  assert.equal(state.backpack.freeSlots != null, true);

  assert.equal(state.position.dimension, 'minecraft:overworld');
  assert.equal(state.position.biome, 'plains');
  assert.equal(state.position.speed, 4.47);

  assert.equal(state.environment.day, 3);
  assert.equal(state.environment.timeOfDay, 6000);
  assert.equal(state.environment.weather, 'Clear');

  const entityNames = state.entities.map((entity) => entity.name);
  assert.ok(entityNames.includes('zombie'));
  assert.ok(entityNames.includes('oak_log'), '掉落物用 displayName，不是 item#id');

  assert.ok(state.blocks.some((block) => block.name === 'iron_ore'));

  const zombie = state.entities.find((entity) => entity.name === 'zombie');
  const cow = state.entities.find((entity) => entity.name === 'cow');
  assert.equal(zombie?.power, 6, '僵尸战力 = 3 伤害/秒 × 20 血 / 10');
  assert.equal(cow?.power, undefined, '食物动物没有威胁值');
  assert.equal(state.entitiesPower, 6, '总战力只算敌对实体');
  assert.equal(state.selfPower, 8, '铁镐不算剑伤害（4）× 18 血 + 3 点护甲 / 10');

  assert.equal(state.meta.currentAction, 'mineBlock（工具，已经 3.2 秒）');
  assert.equal(state.meta.gamemode, 'survival');
  assert.equal(state.goal, '砍三棵树');
});

test('感知明细超过 16 条时全部保留，不做聚合截断', () => {
  const bot = fakeBot();
  delete bot.entities['5'];
  for (let i = 0; i < 20; i++) {
    bot.entities[String(100 + i)] = { id: 100 + i, name: 'zombie', position: { x: 10 + i, y: 64, z: -3 } };
  }
  const baseAt = bot.blockAt;
  bot.blockAt = (pos: { x: number; y: number; z: number }) => {
    if (pos.x >= 10 && pos.x < 30 && pos.y === 64 && pos.z === -3) return { ...baseAt(pos), name: 'iron_ore' };
    return baseAt(pos);
  };
  const state = snapshotFromBot(bot, null, null);
  assert.equal(state.entities.filter((entity: { name: string }) => entity.name === 'zombie').length, 20);
  assert.equal(state.blocks.filter((block: { name: string }) => block.name === 'iron_ore').length, 21);
  const text = renderSnapshot(state);
  assert.match(text, /zombie#119/);
  assert.equal((text.match(/iron_ore，距离/g) ?? []).length, 21);
});

test('同名关键方块也保留每一处坐标，不做合并省略', () => {
  const bot = fakeBot();
  const baseAt = bot.blockAt;
  bot.blockAt = (pos: { x: number; y: number; z: number }) => {
    if ((pos.x === 8 || pos.x === 9) && pos.y === 62 && pos.z === -1) return { ...baseAt(pos), name: 'iron_ore' };
    return baseAt(pos);
  };
  const text = renderSnapshot(snapshotFromBot(bot, null, null));
  assert.match(text, /iron_ore，距离 [\d.]+ 格，坐标 \(8, 62, -1\)/);
  assert.match(text, /iron_ore，距离 [\d.]+ 格，坐标 \(9, 62, -1\)/);
});

test('液体扫描：报告最近的水/岩浆源方块，跳过流动液体', () => {
  const bot = fakeBot();
  bot.registry.blocksByName = { water: { id: 9 }, lava: { id: 11 } };
  const flowing = { name: 'water', position: { x: -50, y: -39, z: 20 }, getProperties: () => ({ level: 3 }) };
  const source = { name: 'water', position: { x: -50, y: -40, z: 20 }, getProperties: () => ({ level: 0 }) };
  const lava = { name: 'lava', position: { x: -45, y: -44, z: 22 }, getProperties: () => ({ level: 0 }) };
  bot.findBlocks = ({ matching }: { matching: number[] }) => {
    if (matching[0] === 9) return [flowing.position, source.position];
    if (matching[0] === 11) return [lava.position];
    return [];
  };
  const baseAt = bot.blockAt;
  bot.blockAt = (pos: { x: number; y: number; z: number }) => {
    if (pos.x === -50 && pos.z === 20) return pos.y === -39 ? flowing : source;
    if (pos.x === -45 && pos.z === 22) return lava;
    return baseAt(pos);
  };
  const text = renderSnapshot(snapshotFromBot(bot, null, null));
  assert.match(text, /寻找液体/);
  assert.match(text, /水 最近 [\d.]+ 格 \(-50, -40, 20\)/);
  assert.match(text, /岩浆 最近 [\d.]+ 格 \(-45, -44, 22\)/);
});

test('渲染：模型能看到的关键行都在', () => {
  const text = renderSnapshot(snapshotFromBot(fakeBot(), '砍三棵树', null));
  assert.match(text, /## 世界快照/);
  assert.match(text, /身体：血量 18\/20/);
  assert.match(text, /装备：手持 iron_pickaxe×1，耐久 20\/250/);
  assert.match(text, /耐久 20\/250（92%）/);
  assert.match(text, /护甲 diamond_helmet×1/);
  assert.match(text, /背包：空位 33/);
  assert.match(text, /朝向 29°\/-11°/);
  assert.match(text, /环境：第 3 天/);
  assert.match(text, /zombie#5/);
  assert.match(text, /敌对总战力 6/);
  assert.match(text, /战力 6/);
  assert.match(text, /身体：.*战力 8/);
  assert.ok(text.length <= 800, `快照渲染 ${text.length} 字符，超出预算 800`);
  assert.match(text, /iron_ore，距离 4.1 格，坐标 \(8, 62, -1\)/);
  assert.match(text, /动作 idle/);
  assert.match(text, /截图：无/);
});

test('截图引用：有图时渲染拍摄时间与这一帧的朝向', () => {
  const vision = {
    lastScreenshot: { file: 'screenshot_x', takenAt: Date.now() - 3000 },
    lastFrameView: { yaw: 0, pitch: -1.5 },
    lastFrameColor: null,
  };
  const state = snapshotFromBot(fakeBot(), null, null, vision);
  assert.equal(state.screenshot.ref?.file, 'screenshot_x');
  const text = renderSnapshot(state);
  assert.match(text, /截图：screenshot_x/);
  assert.match(text, /低头 86°，朝北/);
});

test('空 bot 也返回完整结构，不抛错', () => {
  const state = snapshotFromBot({}, null);
  assert.equal(state.body.health, null);
  assert.deepEqual(state.entities, []);
  assert.equal(state.backpack.synced, true);
  assert.match(renderSnapshot(state), /## 世界快照/);
});

