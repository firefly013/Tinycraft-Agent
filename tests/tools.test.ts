import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs } from '../src/shared/tools.ts';
import type { ToolDeclaration } from '../src/shared/tools.ts';
import { runnerTools } from '../src/agent/loop.ts';

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

test('注册给模型的工具没有输出长度上限', () => {
  const [tool] = runnerTools({ tool: async () => ({ text: 'ok' }) }, [MINE]);
  assert.equal(tool?.outputLimits?.maxBytes, Infinity);
  assert.equal(tool?.outputLimits?.maxLines, Infinity);
});

test('工具回执同时保留文本与图片', async () => {
  const [tool] = runnerTools({
    tool: async () => ({ text: '审稿报告', images: [{ data: 'aW1n', mimeType: 'image/png' }] }),
  }, [MINE]);
  const result = await tool!.execute({ x: 1, y: 2, z: 3 }, {} as never, {} as never);
  const output = result.output ?? [];
  assert.deepEqual(output.map((part) => part.type), ['text', 'image']);
  assert.equal(output[1].type === 'image' ? output[1].data : '', 'aW1n');
});
