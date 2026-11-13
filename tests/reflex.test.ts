import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniquePriorities, selectReflex } from '../src/core/reflex.ts';
import type { ReflexSpec } from '../src/core/reflex.ts';

const SPECS: readonly ReflexSpec[] = [
  { name: 'landing_water', priority: 100, interruptible: false, types: ['world.fall.lethal', 'reflex.engage'] },
  { name: 'drowning', priority: 90, interruptible: true, types: ['world.water.drowning', 'reflex.engage'] },
  { name: 'combat', priority: 30, interruptible: true, types: ['reflex.engage'] },
];

test('同一事件类型：优先级高的赢', () => {
  const verdict = selectReflex(SPECS, 'reflex.engage', null);
  assert.equal(verdict.kind, 'run');
  if (verdict.kind === 'run') assert.equal(verdict.spec.name, 'landing_water');
});

test('没有反射接这个类型：ignore', () => {
  assert.equal(selectReflex(SPECS, 'player.chat', null).kind, 'ignore');
});

test('当前反射优先级更高：让给它', () => {
  const same = selectReflex(SPECS, 'reflex.engage', { name: 'landing_water', priority: 100 });
  assert.equal(same.kind, 'ignore'); // 选中的还是 landing_water 自己 → 已在跑
  const lower = selectReflex(SPECS, 'world.water.drowning', { name: 'landing_water', priority: 100 });
  assert.equal(lower.kind, 'ignore'); // 溺水(90) 让给落地水(100)
});

test('当前反射优先级更低：允许尝试抢占', () => {
  const verdict = selectReflex(SPECS, 'reflex.engage', { name: 'combat', priority: 30 });
  assert.equal(verdict.kind, 'run');
  if (verdict.kind === 'run') assert.equal(verdict.spec.name, 'landing_water');
});

test('优先级必须唯一', () => {
  assert.doesNotThrow(() => assertUniquePriorities(SPECS));
  assert.throws(
    () => assertUniquePriorities([...SPECS, { name: 'dup', priority: 30, interruptible: true, types: ['x'] }]),
    /优先级重复/,
  );
});

test('名字也必须唯一（reflex-done 只按名字匹配）', () => {
  assert.throws(
    () => assertUniquePriorities([...SPECS, { name: 'combat', priority: 10, interruptible: true, types: ['x'] }]),
    /名字重复/,
  );
});
