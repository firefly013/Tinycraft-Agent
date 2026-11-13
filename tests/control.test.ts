import test from 'node:test';
import assert from 'node:assert/strict';
import { describe as describeState, initialState, reduce } from '../src/core/control.ts';
import type { ControlState, Input, Reduction } from '../src/core/control.ts';

const NOW = 1_000_000;

function run(input: Input, from: ControlState = initialState(), now = NOW): Reduction {
  return reduce(from, input, now);
}

function model(tool = 'mineBlock', args: unknown = {}, policy: 'auto' | 'checkpoint' | 'manual' = 'auto'): ControlState {
  return run({ kind: 'claim-model', tool, args, policy }).state;
}

test('模型认领空闲身体', () => {
  const r = run({ kind: 'claim-model', tool: 'mineBlock', args: { x: 1 } });
  assert.equal(r.outcome, 'applied');
  assert.equal(r.state.body?.by, 'model');
  assert.deepEqual(r.effects, []);
  assert.equal(r.trace.kind, 'claim');
});

test('身体忙时再认领：拒绝，不排队、不顶替', () => {
  const busy = model();
  const r = reduce(busy, { kind: 'claim-model', tool: 'goTo', args: {} }, NOW + 5);
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.state, busy);
  assert.deepEqual(r.effects, []);
});

test('反射认领空闲身体', () => {
  const r = run({ kind: 'claim-reflex', name: 'combat', priority: 30 });
  assert.equal(r.outcome, 'applied');
  assert.equal(r.state.body?.by, 'reflex');
});

test('反射抢占模型：checkpoint 策略存下进度', () => {
  const claimed = reduce(model('collectBlock', { type: 'iron_ore' }, 'checkpoint'), { kind: 'checkpoint', value: { got: 3 } }, NOW).state;
  const r = reduce(claimed, { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW + 2000);
  assert.equal(r.outcome, 'applied');
  assert.equal(r.state.body?.name, 'combat');
  assert.deepEqual(r.state.pendingResume, {
    tool: 'collectBlock',
    args: { type: 'iron_ore' },
    checkpoint: { got: 3 },
    policy: 'checkpoint',
    at: NOW + 2000,
  });
  assert.deepEqual(r.effects, [{ kind: 'cancel-action' }]);
});

test('auto 策略不传检查点（重新开始）', () => {
  const claimed = reduce(model('mineBlock', {}, 'auto'), { kind: 'checkpoint', value: { got: 1 } }, NOW).state;
  const preempted = reduce(claimed, { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW + 1).state;
  assert.equal(preempted.pendingResume?.checkpoint, undefined);

  const r = reduce(preempted, { kind: 'reflex-done', name: 'combat' }, NOW + 9);
  assert.deepEqual(r.effects, [{ kind: 'resume', tool: 'mineBlock', args: {} }]);
  assert.match(r.trace.detail, /重新开始/);
});

test('checkpoint 策略续做：检查点原样送回去', () => {
  const claimed = reduce(model('collectBlock', { type: 'iron_ore' }, 'checkpoint'), { kind: 'checkpoint', value: { got: 3 } }, NOW).state;
  const preempted = reduce(claimed, { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW + 1_000).state;
  const r = reduce(preempted, { kind: 'reflex-done', name: 'combat' }, NOW + 8_000);

  assert.equal(r.state.body?.by, 'model');
  assert.equal(r.state.pendingResume, null);
  assert.deepEqual(r.effects, [
    { kind: 'resume', tool: 'collectBlock', args: { type: 'iron_ore' }, checkpoint: { got: 3 } },
  ]);
  assert.match(r.trace.detail, /从检查点续做/);
});

test('manual 策略：被抢占后不续做', () => {
  const manual = reduce(initialState(), { kind: 'claim-model', tool: 'mineTunnel', args: {}, policy: 'manual' }, NOW).state;
  const preempted = reduce(manual, { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW + 1).state;
  assert.equal(preempted.pendingResume, null);
  const done = reduce(preempted, { kind: 'reflex-done', name: 'combat' }, NOW + 2);
  assert.equal(done.state.body, null);
  assert.deepEqual(done.effects, []);
});

test('让位反射（拾取）被模型动作抢占：拿身体、发 cancel-reflex', () => {
  const pickup = run({ kind: 'claim-reflex', name: 'pickup', priority: 10, yieldToModel: true }).state;
  const r = reduce(pickup, { kind: 'claim-model', tool: 'mineBlock', args: { x: 1 } }, NOW + 5);
  assert.equal(r.outcome, 'applied');
  assert.equal(r.state.body?.by, 'model');
  assert.equal(r.state.body?.name, 'mineBlock');
  assert.deepEqual(r.effects, [{ kind: 'cancel-reflex' }]);
});

test('不让位的反射仍然拒模型动作（战斗/进食）', () => {
  const combat = run({ kind: 'claim-reflex', name: 'combat', priority: 30 }).state;
  const r = reduce(combat, { kind: 'claim-model', tool: 'mineBlock', args: {} }, NOW + 5);
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.state.body?.name, 'combat');
});

test('有等着续做的模型动作时不让位（否则它永远等不到续做）', () => {
  const goto = model('goTo', {}, 'auto');
  const pickup = reduce(goto, { kind: 'claim-reflex', name: 'pickup', priority: 10, yieldToModel: true }, NOW + 1).state;
  assert.notEqual(pickup.pendingResume, null);
  const r = reduce(pickup, { kind: 'claim-model', tool: 'mineBlock', args: {} }, NOW + 2);
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.state.body?.name, 'pickup');
});

test('反射抢反射：优先级高的能抢，低的被拒', () => {
  const combat = run({ kind: 'claim-reflex', name: 'combat', priority: 30 }).state;
  const landing = reduce(combat, { kind: 'claim-reflex', name: 'landing_water', priority: 100 }, NOW + 1);
  assert.equal(landing.outcome, 'applied');
  assert.equal(landing.state.body?.name, 'landing_water');

  const low = reduce(landing.state, { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW + 2);
  assert.equal(low.outcome, 'rejected');
  assert.equal(low.state.body?.name, 'landing_water');
});

test('不可中断的反射抢不动', () => {
  const landing = run({ kind: 'claim-reflex', name: 'landing_water', priority: 100, interruptible: false }).state;
  const r = reduce(landing, { kind: 'claim-reflex', name: 'drowning', priority: 90 }, NOW + 1);
  assert.equal(r.outcome, 'rejected');
  assert.equal(r.state.body?.name, 'landing_water');
});

test('Stop：作废代次、清续做、打断动作', () => {
  const claimed = reduce(model(), { kind: 'claim-reflex', name: 'combat', priority: 30 }, NOW).state;
  const r = reduce(claimed, { kind: 'stop' }, NOW + 1);
  assert.equal(r.state.epoch, claimed.epoch + 1);
  assert.equal(r.state.body, null);
  assert.equal(r.state.pendingResume, null);
  assert.deepEqual(r.effects.map((effect) => effect.kind), ['cancel-action', 'resolve-tool']);
});

test('过期的动作结果被丢弃，不改状态', () => {
  const claimed = model();
  const stale = reduce(claimed, { kind: 'action-done', epoch: claimed.epoch - 1 }, NOW + 1);
  assert.equal(stale.outcome, 'rejected');
  assert.equal(stale.state.body?.name, 'mineBlock');

  const ok = reduce(claimed, { kind: 'action-done', epoch: claimed.epoch }, NOW + 1);
  assert.equal(ok.outcome, 'applied');
  assert.equal(ok.state.body, null);
});

test('检查点只写在模型动作上', () => {
  const claimed = model();
  const r = reduce(claimed, { kind: 'checkpoint', value: { got: 1 } }, NOW + 1);
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(r.state.body?.checkpoint, { got: 1 });

  const ignored = reduce(initialState(), { kind: 'checkpoint', value: 1 }, NOW);
  assert.equal(ignored.outcome, 'rejected');
});

test('describe 一行能读', () => {
  const claimed = model();
  assert.equal(describeState(claimed, NOW + 3200), 'body=model:mineBlock(3.2s) epoch=0');

  const reflex = run({ kind: 'claim-reflex', name: 'landing_water', priority: 100 }).state;
  assert.equal(describeState(reflex, NOW + 500), 'body=reflex:landing_water(0.5s, prio 100) epoch=0');
});
