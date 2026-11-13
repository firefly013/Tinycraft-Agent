import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ensureViewerEntityTextures, VIEWER_ENTITY_VERSION } from '../src/body/vision/assets.ts';

test('实体贴图缺失时从仓库 assets 复制；已存在时跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-assets-'));
  try {
    const source = join(root, 'assets', 'prismarine-viewer', 'textures', VIEWER_ENTITY_VERSION);
    mkdirSync(join(source, 'entity', 'zombie'), { recursive: true });
    writeFileSync(join(source, 'entity', 'zombie', 'zombie.png'), 'png');
    const texturesRoot = join(root, 'node_modules', 'prismarine-viewer', 'public', 'textures', VIEWER_ENTITY_VERSION);

    const first = ensureViewerEntityTextures({ repoRoot: root, texturesRoot });
    assert.equal(first.ok, true);
    assert.equal(first.copied, true);
    assert.equal(existsSync(join(texturesRoot, 'entity', 'zombie', 'zombie.png')), true);

    const second = ensureViewerEntityTextures({ repoRoot: root, texturesRoot });
    assert.equal(second.ok, true);
    assert.equal(second.copied, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺资产时明确报错，不静默返回空', () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-assets-missing-'));
  try {
    const result = ensureViewerEntityTextures({ repoRoot: root, texturesRoot: join(root, 'target') });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /缺少实体贴图资产/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('实体模型补丁：zombie 系列复用 player 骨架', async () => {
  const { patchViewerEntityModels } = await import('../src/body/vision/entity_models.ts');
  const patched = patchViewerEntityModels();
  assert.ok(patched.includes('zombie'));
  const get = createRequire(import.meta.url);
  const models = get('../node_modules/prismarine-viewer/viewer/lib/entity/entities.json');
  assert.deepEqual(
    models.zombie.geometry.default.bones.map((b: { name: string }) => b.name),
    models.player.geometry.default.bones.map((b: { name: string }) => b.name),
  );
});
