import assert from 'node:assert/strict';
import test from 'node:test';
import { DROWN_TICKS, headBlock, isHeadUnderwater } from '../src/body/drown.ts';

function makeBot(options: { position?: { x: number; y: number; z: number }; water?: boolean }): any {
  return {
    entity: {
      position: options.position ?? { x: 0.5, y: 64, z: 0.5 },
      eyeHeight: 1.62,
    },
    blockAt: (position: { y: number }) => ({
      name: options.water && Math.floor(position.y) === 65 ? 'water' : 'air',
      position,
      boundingBox: 'empty',
    }),
  };
}

test('溺水：眼睛那格是水才算在水下', () => {
  assert.equal(isHeadUnderwater(makeBot({ water: true })), true);
  assert.equal(isHeadUnderwater(makeBot({ water: false })), false);
});

test('溺水：头露出水面就不算（wading）', () => {
  const bot = makeBot({ position: { x: 0.5, y: 63, z: 0.5 }, water: true });
  // y=63 时眼睛在 64.62 → 方块 y=64，不在 water 判定里
  assert.equal(isHeadUnderwater(bot), false);
});

test('溺水：读不到方块时不误判', () => {
  const bot: any = { entity: { position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62 }, blockAt: () => null };
  assert.equal(headBlock(bot), null);
  assert.equal(isHeadUnderwater(bot), false);
});

test('溺水：阈值是 100 tick（约 5 秒），留足余量', () => {
  assert.equal(DROWN_TICKS, 100);
});
