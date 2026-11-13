import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenBudget } from '../src/agent/budget.ts';
import { GenerationTask } from '@earendil-works/pi-durable';

function hookOf(budget: ReturnType<typeof createTokenBudget>): (message: any) => unknown {
  const handlers = (budget.hook as unknown as {
    handlers: { afterResponse: (message: any) => unknown };
  }).handlers;
  return handlers.afterResponse;
}

test('Token 预算：按 totalTokens 累加并实时落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-budget-'));
  try {
    const path = join(dir, 'token-budget.json');
    const updates: number[] = [];
    const budget = createTokenBudget({ statePath: path, limit: 1000, onUpdate: (s) => updates.push(s.used) });
    const after = hookOf(budget);
    after({ usage: { totalTokens: 120 } });
    after({ usage: { totalTokens: 80 } });
    assert.equal(budget.snapshot().used, 200);
    assert.deepEqual(updates, [120, 200]);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).used, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Token 预算：跨重启保留累计值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-budget-'));
  try {
    const path = join(dir, 'token-budget.json');
    const first = createTokenBudget({ statePath: path, limit: 1000 });
    hookOf(first)({ usage: { totalTokens: 300 } });
    const second = createTokenBudget({ statePath: path, limit: 1000 });
    assert.equal(second.snapshot().used, 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Token 预算：达到上限只回调一次并标记 exhausted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-budget-'));
  try {
    const path = join(dir, 'token-budget.json');
    let hits = 0;
    const budget = createTokenBudget({ statePath: path, limit: 100, onExhausted: () => { hits += 1; } });
    const after = hookOf(budget);
    after({ usage: { totalTokens: 60 } });
    after({ usage: { totalTokens: 60 } });
    after({ usage: { totalTokens: 10 } });
    assert.equal(hits, 1);
    assert.equal(budget.snapshot().used, 130);
    assert.equal(budget.snapshot().exhausted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Token 预算：limit=0 表示不限，只统计不硬停', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-budget-'));
  try {
    const path = join(dir, 'token-budget.json');
    let hits = 0;
    const budget = createTokenBudget({ statePath: path, limit: 0, onExhausted: () => { hits += 1; } });
    const after = hookOf(budget);
    after({ usage: { totalTokens: 10_000_000 } });
    after({ usage: { totalTokens: 10_000_000 } });
    assert.equal(hits, 0);
    assert.equal(budget.snapshot().limit, 0);
    assert.equal(budget.snapshot().exhausted, false);
    assert.equal(budget.snapshot().used, 20_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
