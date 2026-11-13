import test from 'node:test';
import assert from 'node:assert/strict';
import { MOB_PROFILES, armorPoints, assessCombat, combatPower, mobPower, scanTargets } from '../src/body/combat.ts';
import type { MobSighting } from '../src/body/combat.ts';

function mob(name: string, overrides: Partial<MobSighting> = {}): MobSighting {
  return {
    id: 1,
    name,
    distance: 5,
    position: { x: 5, y: 64, z: 0 },
    hp: 20,
    damage: 3,
    intervalSec: 1,
    explosive: false,
    ...overrides,
  };
}

test('没有怪：不管', () => {
  assert.equal(assessCombat({ health: 20 }, []).action, 'ignore');
});

test('一只僵尸 + 铁剑：打得过', () => {
  const plan = assessCombat({ health: 20, weapon: 'iron_sword' }, [mob('zombie')]);
  assert.equal(plan.action, 'engage');
  assert.ok(plan.ttk < plan.ttd);
});

test('一只僵尸 + 空手：不划算，撤', () => {
  const plan = assessCombat({ health: 20, weapon: null }, [mob('zombie')]);
  assert.equal(plan.action, 'flee');
});

test('三只僵尸 + 铁剑：撤', () => {
  const plan = assessCombat({ health: 20, weapon: 'iron_sword' }, [mob('zombie'), mob('zombie', { id: 2 }), mob('zombie', { id: 3 })]);
  assert.equal(plan.action, 'flee');
});

test('食物动物：不还手，直接判打', () => {
  const cow = mob('cow', { hp: 10, damage: 0, intervalSec: 0, kind: 'food' });
  assert.equal(assessCombat({ health: 20, weapon: null }, [cow]).action, 'engage');
  assert.match(assessCombat({ health: 20, weapon: null }, [cow]).reason, /食物动物/);
});

test('扫描：食物动物与怪物分开标记，中立怪跳过', () => {
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {
      '1': { id: 1, name: 'Bot', position: { x: 0, y: 64, z: 0 } },
      '7': { id: 7, name: 'zombie', position: { x: 3, y: 64, z: 0 } },
      '11': { id: 11, name: 'cow', position: { x: 5, y: 64, z: 0 } },
      '12': { id: 12, name: 'enderman', position: { x: 4, y: 64, z: 0 } },
    },
  };
  const targets = scanTargets(bot);
  assert.deepEqual(targets.map((target) => [target.name, target.kind]), [
    ['zombie', 'hostile'],
    ['cow', 'food'],
  ]);
  assert.deepEqual(scanTargets(bot).filter((target) => target.kind !== 'food').map((target) => target.name), ['zombie']);
});

test('扫描：表里没写的新怪按注册表 category 兜底（Hostile 才打）', () => {
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {
      '1': { id: 1, name: 'Bot', position: { x: 0, y: 64, z: 0 } },
      '20': { id: 20, name: 'creaking', position: { x: 3, y: 64, z: 0 } },
      '21': { id: 21, name: 'penguin', position: { x: 4, y: 64, z: 0 } },
    },
    registry: {
      entitiesByName: {
        creaking: { category: 'Hostile' },
        penguin: { category: 'Passive' },
      },
    },
  };
  assert.deepEqual(scanTargets(bot).map((target) => target.name), ['creaking']);
});

test('怪物表覆盖常见怪物与食物动物', () => {
  for (const name of [
    'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
    'spider', 'cave_spider', 'silverfish', 'endermite', 'slime', 'magma_cube',
    'creeper', 'witch', 'phantom', 'guardian', 'elder_guardian', 'shulker',
    'pillager', 'vindicator', 'evoker', 'illusioner', 'vex', 'ravager', 'warden',
    'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'wither', 'ender_dragon',
    'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'cod', 'salmon',
  ]) {
    assert.ok(MOB_PROFILES[name] != null, `怪物表缺 ${name}`);
  }
  assert.equal(MOB_PROFILES['cow']?.food, true);
  assert.equal(MOB_PROFILES['creeper']?.explosive, true);
});

test('战斗力：武器越好、护甲越厚，数值越高', () => {
  assert.ok(combatPower({ health: 20, weapon: null }) < combatPower({ health: 20, weapon: 'iron_sword' }));
  assert.ok(
    combatPower({ health: 20, weapon: 'iron_sword' }) <
      combatPower({ health: 20, weapon: 'iron_sword', armor: 15 }),
  );
});

test('目标战力：僵尸 > 骷髅 > 牛；苦力怕单独最高', () => {
  const zombie = mob('zombie', { hp: 20, damage: 3, intervalSec: 1 });
  const skeleton = mob('skeleton', { hp: 20, damage: 3, intervalSec: 2 });
  const cow = mob('cow', { hp: 10, damage: 0, intervalSec: 0, kind: 'food' });
  assert.ok(mobPower(zombie) > mobPower(skeleton));
  assert.ok(mobPower(skeleton) > mobPower(cow));
  assert.equal(mobPower(mob('creeper', { explosive: true })), 100);
});

test('苦力怕：不拼，跑', () => {  const plan = assessCombat({ health: 20, weapon: 'diamond_sword' }, [mob('creeper', { explosive: true, damage: 0, intervalSec: 0 })]);
  assert.equal(plan.action, 'flee');
  assert.match(plan.reason, /苦力怕/);
});

test('血太少：先撤', () => {
  const plan = assessCombat({ health: 4, weapon: 'diamond_sword' }, [mob('zombie')]);
  assert.equal(plan.action, 'flee');
  assert.match(plan.reason, /血/);
});

test('护甲点数：认四个槽，也认带命名空间的名字', () => {
  assert.equal(armorPoints([]), 0);
  assert.equal(armorPoints(['iron_helmet', 'iron_chestplate']), 8);
  assert.equal(armorPoints(['minecraft:diamond_boots', null]), 3);
});

test('铁护甲让空手也能打一只僵尸', () => {
  assert.equal(assessCombat({ health: 20, weapon: null }, [mob('zombie')]).action, 'flee');
  assert.equal(assessCombat({ health: 20, weapon: null, armor: 8 }, [mob('zombie')]).action, 'engage');
});

test('满甲有效血是 5 倍（不是 1.8 倍）', () => {
  // 20 点甲减 80% 伤害：空手打一只僵尸，td 从 6.7s 变 33s。
  const plan = assessCombat({ health: 20, weapon: null, armor: 20 }, [mob('zombie')]);
  assert.equal(plan.action, 'engage');
  assert.ok(plan.ttd > 30, `tdd 应该约 33s，实际 ${plan.ttd}`);
});

test('扫描：只报会主动打我的怪，排除自己与太远的', () => {
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {
      '1': { id: 1, name: 'bot', position: { x: 0, y: 64, z: 0 } },
      '2': { id: 2, name: 'zombie', position: { x: 3, y: 64, z: 0 } },
      '3': { id: 3, name: 'chicken', position: { x: 1, y: 64, z: 0 } },
      '4': { id: 4, name: 'skeleton', position: { x: 40, y: 64, z: 0 } },
      '5': { id: 5, name: 'enderman', position: { x: 2, y: 64, z: 0 } },
    },
  };
  const hostiles = scanTargets(bot, 16).filter((target) => target.kind !== 'food');
  assert.deepEqual(hostiles.map((target) => target.name), ['zombie']);
  assert.equal(hostiles[0]?.id, 2);
  assert.equal(hostiles[0]?.distance, 3);
});
