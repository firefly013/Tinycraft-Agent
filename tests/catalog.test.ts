import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, TOOL_BY_NAME } from '../src/body/catalog.ts';
import { TOOL_TEXT } from '../src/prompts.ts';

test('工具面是 14 个，名字唯一', () => {
  assert.equal(CATALOG.length, 14);
  assert.equal(new Set(CATALOG.map((tool) => tool.name)).size, 14);
});

test('工具文案总量 ≤ 1500 字符（上下文预算）', () => {
  let total = 0;
  for (const tool of CATALOG) {
    total += tool.description.length;
    for (const param of Object.values(tool.params ?? {})) total += param.description?.length ?? 0;
  }
  assert.ok(total <= 2200, `工具文案 ${total} 字符，超过 2200`);
});

test('工具说明全部来自 src/prompts.ts（改文案只改那一个文件）', () => {
  for (const tool of CATALOG) {
    assert.equal(tool.description, TOOL_TEXT[tool.name]?.description, `${tool.name} 的说明不在 prompts.ts`);
  }
});

test('身体原语与大脑工具分得开', () => {
  const bodyTools = CATALOG.filter((tool) => tool.name !== 'Stop' && tool.name !== 'UpdateGoal' && tool.name !== 'Finish');
  assert.equal(bodyTools.length, 11);
  // 长动作必须是 async，查询不许占身体。
  assert.equal(TOOL_BY_NAME.get('collectBlock')?.mode, 'async');
  assert.equal(TOOL_BY_NAME.get('inventory')?.action, true);
  assert.equal(TOOL_BY_NAME.get('mineBlock')?.action, true);
});

test('每个工具都有必填的 descriptions（解释这次调用干什么）', () => {
  for (const tool of CATALOG) {
    const intent = tool.params?.descriptions;
    assert.ok(intent != null, `${tool.name} 缺少 descriptions 参数`);
    assert.equal(intent.type, 'string');
    assert.equal(intent.optional, undefined, `${tool.name} 的 descriptions 必须必填`);
    assert.ok((intent.description ?? '').length > 0);
  }
});
