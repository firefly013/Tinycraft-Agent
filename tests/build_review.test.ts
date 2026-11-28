import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reviewBuild } from '../src/agent/build_review.ts';
import { createBlueprint, updateBlueprint } from '../src/agent/blueprints.ts';
import type { McBuild } from '../src/body/mcbuild.ts';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'tc-review-'));
  const blueprintsRoot = join(base, 'blueprints');
  const blueprint = createBlueprint(blueprintsRoot, '一座有门廊的小屋', { mc: '1.21.4' });
  updateBlueprint(blueprintsRoot, blueprint.id, {
    size: { x: 7, y: 5, z: 7 },
    blocks: 80,
    materials: { stone_bricks: 50, oak_planks: 30 },
    tags: ['house'],
    reusable: true,
  });
  writeFileSync(join(blueprint.dir, 'script.js'), "builder.fill(0,0,0,7,1,7,'stone_bricks');");
  writeFileSync(join(blueprint.dir, 'plan.schem'), 'schem');
  writeFileSync(join(blueprint.dir, 'house.ascii.txt'), '# silhouette\nSTONE');
  writeFileSync(join(blueprint.dir, 'house.ascii-plan.txt'), '# plan\nSTONE');
  const images = ['main', 'south', 'east', 'north', 'west', 'top'].map((view) => {
    const path = join(blueprint.dir, `house.${view}.png`);
    writeFileSync(path, `png-${view}`);
    return { view, path, bytes: 8, sha256: view, coverage: 1 };
  });
  const buildJson = {
    out: join(blueprint.dir, 'plan.schem'),
    size: { x: 7, y: 5, z: 7 },
    nonAir: 80,
    paletteSize: 3,
    selfcheck: { ok: true, errors: [], warnings: [], images, asciiPath: join(blueprint.dir, 'house.ascii.txt'), planPath: join(blueprint.dir, 'house.ascii-plan.txt') },
  };
  const checkJson = { ok: true, invalidCount: 0, invalid: [], nonAir: 80 };
  const mcBuild: McBuild = {
    dir: '/mc-build',
    run: async (argv) => ({ code: 0, stdout: argv[0] === 'build' ? JSON.stringify(buildJson) : JSON.stringify(checkJson), stderr: '' }),
    build: async () => { throw new Error('not used'); },
    emit: async () => { throw new Error('not used'); },
  };
  return { base, blueprintsRoot, blueprint, mcBuild };
}

test('主模型审稿：完整报告、ASCII、六视角图片', async () => {
  const env = fixture();
  const result = await reviewBuild({
    blueprintsRoot: env.blueprintsRoot,
    blueprintId: env.blueprint.id,
    sessionId: 'session-review',
    revision: 3,
    mcBuild: env.mcBuild,
    mc: () => '1.21.4',
    vision: true,
  });
  assert.match(result.text, /session-review revision 3/);
  assert.match(result.text, /一座有门廊的小屋/);
  assert.match(result.text, /stone_bricks/);
  assert.match(result.text, /SELFCHECK OK/);
  assert.match(result.text, /# silhouette/);
  assert.match(result.text, /# plan/);
  assert.match(result.text, /house\.main\.png/);
  assert.equal(result.images?.length, 6);
  assert.equal(result.images?.[0].mimeType, 'image/png');
  rmSync(env.base, { recursive: true, force: true });
});

test('主模型审稿：可追加任意 preview 参数并拿到细节图', async () => {
  const env = fixture();
  const detail = join(env.blueprint.dir, 'detail.png');
  writeFileSync(detail, 'detail-png');
  const mcBuild: McBuild = {
    ...env.mcBuild,
    run: async (argv) => {
      if (argv[0] === 'preview') return { code: 0, stdout: 'OK preview detail.png', stderr: '' };
      return env.mcBuild.run(argv, '');
    },
  };
  const result = await reviewBuild({
    blueprintsRoot: env.blueprintsRoot,
    blueprintId: env.blueprint.id,
    sessionId: 'session-review',
    revision: 3,
    mcBuild,
    mc: () => '1.21.4',
    vision: true,
    previewArgs: ['preview', 'plan.schem', '-o', 'detail.png', '--crop', '0,0,0,2,2,2', '--persp'],
  });
  assert.match(result.text, /OK preview detail\.png/);
  assert.equal(result.images?.length, 7);
  rmSync(env.base, { recursive: true, force: true });
});

test('主模型无图片能力：仍返回完整 ASCII，不附加图片', async () => {
  const env = fixture();
  const result = await reviewBuild({
    blueprintsRoot: env.blueprintsRoot,
    blueprintId: env.blueprint.id,
    sessionId: 'session-review',
    revision: 3,
    mcBuild: env.mcBuild,
    mc: () => '1.21.4',
    vision: false,
  });
  assert.match(result.text, /# silhouette/);
  assert.deepEqual(result.images ?? [], []);
  rmSync(env.base, { recursive: true, force: true });
});

test('主模型审稿：编译失败返回完整错误，不伪装成通过', async () => {
  const env = fixture();
  const result = await reviewBuild({
    blueprintsRoot: env.blueprintsRoot,
    blueprintId: env.blueprint.id,
    sessionId: 'session-review',
    revision: 3,
    mcBuild: { ...env.mcBuild, run: async () => ({ code: 1, stdout: '', stderr: '完整错误：未知方块 END' }) },
    mc: () => '1.21.4',
    vision: true,
  });
  assert.match(result.text, /审稿失败/);
  assert.match(result.text, /未知方块 END/);
  assert.deepEqual(result.images ?? [], []);
  rmSync(env.base, { recursive: true, force: true });
});
