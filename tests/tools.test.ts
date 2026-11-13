import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs } from '../src/shared/tools.ts';
import type { ToolDeclaration } from '../src/shared/tools.ts';

const MINE: ToolDeclaration = {
  name: 'mineBlock',
  description: '挖掉一格方块',
  mode: 'sync',
  action: true,
  params: {
    x: { type: 'int' },
    y: { type: 'int' },
    z: { type: 'int' },
    force: { type: 'boolean', optional: true },
  },
};

test('参数合法：通过', () => {
  const result = checkArgs(MINE, { x: 1, y: 2, z: 3, force: true });
  assert.equal(result.ok, true);
});

test('可选参数缺省不算错', () => {
  assert.equal(checkArgs(MINE, { x: 1, y: 2, z: 3 }).ok, true);
});

test('拼错参数名：报错说清是哪一个', () => {
  const result = checkArgs(MINE, { x: 1, y: 2, zz: 3 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.issues.map((issue) => issue.path).sort(), ['z', 'zz']);
  }
});

test('缺必填参数：报错', () => {
  const result = checkArgs(MINE, { x: 1, y: 2 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.path, 'z');
});

test('类型不对：int 不收小数，float 收', () => {
  const count: ToolDeclaration = {
    name: 'n',
    description: '',
    mode: 'sync',
    action: true,
    params: { n: { type: 'int' } },
  };
  assert.equal(checkArgs(count, { n: 1.5 }).ok, false);
  assert.equal(checkArgs(count, { n: 2 }).ok, true);

  const amount: ToolDeclaration = { ...count, params: { n: { type: 'float' } } };
  assert.equal(checkArgs(amount, { n: 1.5 }).ok, true);
});
