import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCARD_IGNORE_MS, isDiscarded, markDiscarded, nearbyDrops, pickupDrops } from '../src/body/pickup.ts';

const bot = (items: Array<{ id: number; name: string; position: { x: number; y: number; z: number } }>, self = { x: 0, y: 64, z: 0 }) => ({
  entity: { position: self },
  entities: Object.fromEntries(items.map((item) => [item.id, item])),
});

test('nearbyDrops：只列附近的 item，按最近排序', () => {
  const b = bot([
    { id: 1, name: 'item', position: { x: 3, y: 64, z: 0 } },
    { id: 2, name: 'item', position: { x: 1, y: 64, z: 0 } },
    { id: 3, name: 'zombie', position: { x: 1, y: 64, z: 0 } },
    { id: 4, name: 'item', position: { x: 30, y: 64, z: 0 } },
  ]);
  const drops = nearbyDrops(b as never, 8);
  assert.deepEqual(drops.map((d) => d.entity.id), [2, 1]);
});

test('discard 免疫：刚扔的落点附近不自动捡，过窗口后恢复', () => {
  const drop = { x: 1, y: 64, z: 0 };
  const now = Date.now();
  markDiscarded({ x: 1.2, y: 64, z: 0 }, now);
  assert.equal(isDiscarded(drop, now + 1000), true);
  assert.equal(isDiscarded(drop, now + DISCARD_IGNORE_MS + 1), false);
  const b = bot([{ id: 9, name: 'item', position: drop }]);
  assert.equal(nearbyDrops(b as never, 8, now + 1000).length, 0);
});

test('pickupDrops：走到掉落物旁并确认实体消失才算捡到', async () => {
  const items = [{ id: 9, name: 'item', position: { x: 5, y: 64, z: 0 } }];
  const b = bot(items);
  const pathfinder = {
    goto: async () => {
      // 走到旁边，假服务器把掉落物收走
      items.length = 0;
      delete (b.entities as Record<string, unknown>)['9'];
    },
    stop: () => {},
  };
  const context = { signal: new AbortController().signal, checkpoint: () => {} };
  const picked = await pickupDrops({ ...b, pathfinder } as never, context, { budgetMs: 1000, waitMs: 100 });
  assert.equal(picked, 1);
  assert.equal(nearbyDrops({ ...b, pathfinder } as never, 8).length, 0);
});

test('pickupDrops：pathfinder 永不 resolve 时不会挂死（硬超时）', async () => {
  const items = [{ id: 9, name: 'item', position: { x: 5, y: 64, z: 0 } }];
  const b = bot(items);
  const pathfinder = { goto: () => new Promise<void>(() => {}), stop: () => {} };
  const context = { signal: new AbortController().signal, checkpoint: () => {} };
  const started = Date.now();
  const picked = await pickupDrops({ ...b, pathfinder } as never, context, {
    budgetMs: 1_000,
    gotoTimeoutMs: 50,
    waitMs: 50,
  });
  assert.equal(picked, 0);
  assert.ok(Date.now() - started < 900, `应该快速返回，实际 ${Date.now() - started}ms`);
});
