import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  blueprintRoot,
  createBlueprint,
  describeBlueprint,
  listBlueprints,
  readBlueprint,
  slugify,
  updateBlueprint,
} from '../src/agent/blueprints.ts';

function freshRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'tc-blueprints-')), 'blueprints');
}

test('蓝图根目录挂在 bot 目录下', () => {
  assert.equal(blueprintRoot('bots/alice'), join('bots/alice', 'build', 'blueprints'));
});

test('slug 只留 ascii；中文 brief 退回 build', () => {
  assert.equal(slugify('Stone Tower!'), 'stone-tower');
  assert.equal(slugify('  ---  '), 'build');
  assert.equal(slugify('建造一座石塔'), 'build');
  assert.equal(slugify('a'.repeat(60)).length, 24);
});

test('新建蓝图：目录、meta、id 格式都对', () => {
  const root = freshRoot();
  const blueprint = createBlueprint(root, 'small cabin', { mc: '1.21.4' });
  assert.match(blueprint.id, /^small-cabin-[0-9a-f]{4}$/);
  assert.ok(existsSync(join(blueprint.dir, 'meta.json')));
  assert.equal(blueprint.mc, '1.21.4');
  assert.deepEqual(blueprint.size, { x: 0, y: 0, z: 0 });
  assert.equal(blueprint.reusable, false);
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('读不存在的蓝图返回 null，坏 meta 也返回 null', () => {
  const root = freshRoot();
  assert.equal(readBlueprint(root, 'nope'), null);
  const blueprint = createBlueprint(root, 'x');
  writeFileSync(join(blueprint.dir, 'meta.json'), '{ not json');
  assert.equal(readBlueprint(root, blueprint.id), null);
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('更新 meta：patch 生效，id 不会被覆盖', () => {
  const root = freshRoot();
  const created = createBlueprint(root, 'tower');
  const updated = updateBlueprint(root, created.id, {
    size: { x: 5, y: 9, z: 5 },
    blocks: 120,
    reusable: true,
    tags: ['tower', 'stone'],
  });
  assert.ok(updated != null);
  assert.equal(updated.id, created.id);
  assert.deepEqual(updated.size, { x: 5, y: 9, z: 5 });
  assert.equal(updated.blocks, 120);
  assert.equal(updated.reusable, true);
  assert.equal(updateBlueprint(root, 'missing', { blocks: 1 }), null);
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('检索：按可复用 / tag / 文本 / 最大尺寸过滤，按创建时间倒序', () => {
  const root = freshRoot();
  const a = createBlueprint(root, 'stone tower');
  updateBlueprint(root, a.id, { size: { x: 8, y: 12, z: 8 }, reusable: true, tags: ['tower'] });
  const b = createBlueprint(root, 'window unit');
  updateBlueprint(root, b.id, { size: { x: 3, y: 3, z: 1 }, reusable: true, tags: ['window'] });
  const c = createBlueprint(root, 'temporary scaffold');
  updateBlueprint(root, c.id, { size: { x: 2, y: 2, z: 2 } });

  assert.equal(listBlueprints(root).length, 3);
  assert.deepEqual(
    listBlueprints(root, { reusable: true }).map((item) => item.id).sort(),
    [a.id, b.id].sort(),
  );
  assert.deepEqual(listBlueprints(root, { tag: 'window' }).map((item) => item.id), [b.id]);
  assert.deepEqual(listBlueprints(root, { text: 'tower' }).map((item) => item.id), [a.id]);
  assert.deepEqual(listBlueprints(root, { maxSize: 3 }).map((item) => item.id).sort(), [b.id, c.id].sort());
  rmSync(join(root, '..'), { recursive: true, force: true });
});

test('摘要一行能看出尺寸、格数、tag 与可复用', () => {
  const root = freshRoot();
  const blueprint = createBlueprint(root, 'tower');
  const updated = updateBlueprint(root, blueprint.id, {
    size: { x: 8, y: 12, z: 8 },
    blocks: 320,
    reusable: true,
    tags: ['tower'],
  });
  assert.ok(updated != null);
  assert.equal(describeBlueprint(updated), `${blueprint.id} 8x12x8 · 320 格 · tower · 可复用`);
  rmSync(join(root, '..'), { recursive: true, force: true });
});
