import assert from 'node:assert/strict';
import test from 'node:test';
import { findLandingBlock, needsMlg } from '../src/body/mlg.ts';

interface FakeBlock {
  name: string;
  position: { x: number; y: number; z: number };
  boundingBox: string;
}

const AIR = 'empty';

function makeBot(options: {
  position?: { x: number; y: number; z: number };
  velocityY?: number;
  inWater?: boolean;
  items?: string[];
  blocks?: Map<string, string>;
}): any {
  const blocks = options.blocks ?? new Map<string, string>();
  const items = (options.items ?? []).map((name, index) => ({ name, count: 1, slot: 36 + index }));
  return {
    entity: {
      position: options.position ?? { x: 0.5, y: 20, z: 0.5 },
      velocity: { x: 0, y: options.velocityY ?? -1.2, z: 0 },
      width: 0.6,
      isInWater: options.inWater ?? false,
    },
    game: { minY: -64 },
    inventory: { items: () => items },
    blockAt: (position: { x: number; y: number; z: number }): FakeBlock | null => {
      const key = `${position.x},${position.y},${position.z}`;
      const name = blocks.get(key);
      if (name == null) {
        // 没写的就是空气，但只在一定范围内返回，模拟未加载区块返回 null。
        if (position.y < -10) return null;
        return { name: 'air', position, boundingBox: AIR };
      }
      return { name, position, boundingBox: name === 'air' ? AIR : 'block' };
    },
  };
}

test('落地水：找到脚下最高的实心落点', () => {
  const blocks = new Map<string, string>();
  for (let y = 10; y < 20; y += 1) blocks.set(`0,${y},0`, 'air');
  blocks.set('0,9,0', 'stone');
  const bot = makeBot({ blocks });
  const landing = findLandingBlock(bot);
  assert.equal(landing?.position.y, 9);
});

test('落地水：水不算落点，继续往下找石头', () => {
  const blocks = new Map<string, string>();
  blocks.set('0,12,0', 'water');
  blocks.set('0,9,0', 'stone');
  const bot = makeBot({ blocks });
  assert.equal(findLandingBlock(bot)?.position.y, 9);
});

test('落地水：够高 + 有水桶才触发', () => {
  const blocks = new Map<string, string>();
  blocks.set('0,9,0', 'stone');
  assert.equal(needsMlg(makeBot({ blocks, items: ['water_bucket'] })), true);
  assert.equal(needsMlg(makeBot({ blocks, items: ['bucket'] })), false);
});

test('落地水：落差不够、已入水、不在下落都不触发', () => {
  const near = new Map<string, string>();
  near.set('0,17,0', 'stone');
  assert.equal(needsMlg(makeBot({ blocks: near, items: ['water_bucket'] })), false);

  const blocks = new Map<string, string>();
  blocks.set('0,9,0', 'stone');
  assert.equal(needsMlg(makeBot({ blocks, items: ['water_bucket'], inWater: true })), false);
  assert.equal(needsMlg(makeBot({ blocks, items: ['water_bucket'], velocityY: -0.2 })), false);
});
