import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CATALOG } from '../src/body/catalog.ts';
import { REFLEXES } from '../src/body/reflexes.ts';
import { initialState } from '../src/core/control.ts';
import { assertUniquePriorities } from '../src/core/reflex.ts';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/');

test('core 不认识领域', () => {
  const domain = /minecraft|mineflayer|mc\.|iron_ore|diamond_ore|nether/i;
  for (const file of walk(join(ROOT, 'src/core'))) {
    assert.ok(!domain.test(readFileSync(file, 'utf8')), `${rel(file)} 出现了领域词`);
  }
});

test('core 只 import core 自己或 node:', () => {
  const pattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const file of walk(join(ROOT, 'src/core'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const spec = match[1] as string;
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `${rel(file)} import 了 ${spec}`);
    }
  }
});

test('工具面：14 个，文案 ≤ 1800 字符', () => {
  assert.equal(CATALOG.length, 14);
  let chars = 0;
  for (const tool of CATALOG) {
    chars += tool.description.length;
    for (const param of Object.values(tool.params ?? {})) chars += param.description?.length ?? 0;
  }
  assert.ok(chars <= 1800, `工具文案 ${chars} 字符，超过 1800`);
});

test('控制面顶层字段 ≤ 3（身体锁 + 被打断的动作 + 代次）', () => {
  const state = initialState();
  const top = Object.keys(state).length;
  assert.ok(top <= 3, `控制面顶层字段 ${top} 个，超过 3`);
  assert.deepEqual(Object.keys(state).sort(), ['body', 'epoch', 'pendingResume']);
});

test('反射表：优先级唯一，每条都有名字与匹配类型', () => {
  assertUniquePriorities(REFLEXES);
  for (const reflex of REFLEXES) {
    assert.ok(reflex.name.length > 0);
    assert.ok(reflex.types.length > 0, `${reflex.name} 没有匹配类型`);
  }
});
