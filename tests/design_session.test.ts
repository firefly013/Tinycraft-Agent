import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { GenerationTask, ToolTask, hook } from '@earendil-works/pi-durable';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { createBlueprint } from '../src/agent/blueprints.ts';
import { createDesignSession } from '../src/agent/design_session.ts';
import type { McBuild } from '../src/body/mcbuild.ts';
import type { DesignInput } from '../src/agent/architect.ts';

function fakeMcBuild(): McBuild {
  return {
    dir: '/mc-build',
    run: async () => ({ code: 0, stdout: 'OK build → plan.schem', stderr: '' }),
    build: async () => ({
      ok: true,
      summary: {
        schem: '/tmp/plan.schem',
        size: { x: 1, y: 1, z: 1 },
        origin: { x: 0, y: 0, z: 0 },
        dataVersion: 4189,
        blocks: 1,
        paletteSize: 2,
        warnings: [],
        selfcheck: { ok: true, errors: 0, asciiPath: null, images: [] },
        stderr: '',
      },
    }),
    emit: async () => ({
      ok: true,
      plan: {
        size: { x: 1, y: 1, z: 1 },
        origin: { x: 0, y: 0, z: 0 },
        commands: [],
        blocks: [{ x: 0, y: 0, z: 0, state: 'minecraft:stone' }],
        stats: {
          cells: 1,
          nonAir: 1,
          states: 1,
          fills: 0,
          setblocks: 1,
          entities: 0,
          commands: 0,
          maxCommandLength: 0,
          tooLong: 0,
        },
        forceload: { x1: 0, z1: 0, x2: 0, z2: 0 },
        tooLong: [],
      },
    }),
  };
}

test('设计会话：写脚本 → 编译 → 交卷，产出尺寸/材料/标签', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tc-design-'));
  const root = join(base, 'blueprints');
  const blueprint = createBlueprint(root, '小塔', { mc: '1.21.4' });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('writeScript', { content: "builder.set(0, 0, 0, 'stone');" })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage(
      [
        fauxToolCall('runMcBuild', {
          args: ['build', 'script.js', '-o', 'plan.schem', '--mc', '1.21.4', '--views', 'top,south', '--json'],
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxToolCall('finish', { summary: '一个石头方块', tags: 'stone, test', reusable: true })], {
      stopReason: 'toolUse',
    }),
  ]);

  const session = createDesignSession({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    blueprintsRoot: root,
    workspaceRoot: base,
    mcBuild: fakeMcBuild(),
    mc: () => '1.21.4',
  });
  const input: DesignInput = {
    blueprintDir: blueprint.dir,
    blueprintId: blueprint.id,
    brief: '放一块石头',
    signal: new AbortController().signal,
  };
  const result = await session.run(input);
  assert.ok(result != null);
  assert.equal(result.summary, '一个石头方块');
  assert.deepEqual(result.tags, ['stone', 'test']);
  assert.equal(result.reusable, true);
  assert.deepEqual(result.size, { x: 1, y: 1, z: 1 });
  assert.deepEqual(result.materials, { stone: 1 });
  rmSync(base, { recursive: true, force: true });
});

test('设计会话：不确定时先查 CLI 教程，并能完整拿到教程输出', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tc-design-tutorial-'));
  const root = join(base, 'blueprints');
  const blueprint = createBlueprint(root, '查教程', { mc: '1.21.4' });
  const tutorial = 'overview  概览\nbuild  编译\npreview  相机';
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let seen = '';
  let promptSeen = false;

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('runMcBuild', { args: ['tutorial', '--list'] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('writeScript', { content: "builder.set(0, 0, 0, 'stone');" })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('finish', { summary: '完成', tags: '', reusable: false })], { stopReason: 'toolUse' }),
  ]);

  const session = createDesignSession({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    blueprintsRoot: root,
    workspaceRoot: base,
    mcBuild: { ...fakeMcBuild(), run: async () => ({ code: 0, stdout: tutorial, stderr: '' }) },
    mc: () => '1.21.4',
    hooks: [
      hook(GenerationTask, { beforeRequest: (request) => { promptSeen = JSON.stringify(request.messages).includes('先查教程'); return undefined; } }),
      hook(ToolTask, { afterTool: (call, result) => { if (call.name === 'runMcBuild') seen = result.output?.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''; return undefined; } }),
    ],
  });
  const result = await session.run({
    blueprintDir: blueprint.dir,
    blueprintId: blueprint.id,
    brief: '测试教程查询',
    signal: new AbortController().signal,
  });
  assert.ok(result != null);
  assert.equal(promptSeen, true, '系统提示必须要求不确定时先查教程');
  assert.ok(seen.includes(tutorial));
  rmSync(base, { recursive: true, force: true });
});

test('设计会话：mc-build 的 stdout/stderr 超过旧上限仍完整返回', async () => {
  const base = mkdtempSync(join(tmpdir(), 'tc-design-full-'));
  const root = join(base, 'blueprints');
  const blueprint = createBlueprint(root, '长输出', { mc: '1.21.4' });
  const stdout = 'a'.repeat(13_000);
  const stderr = 'b'.repeat(5_000);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let seen = '';

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('writeScript', { content: "builder.set(0, 0, 0, 'stone');" })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('runMcBuild', { args: ['build', 'script.js', '-o', 'plan.schem', '--json'] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('finish', { summary: '完成', tags: '', reusable: false })], { stopReason: 'toolUse' }),
  ]);

  const session = createDesignSession({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    blueprintsRoot: root,
    workspaceRoot: base,
    mcBuild: { ...fakeMcBuild(), run: async () => ({ code: 0, stdout, stderr }) },
    mc: () => '1.21.4',
    hooks: [hook(ToolTask, { afterTool: (call, result) => { if (call.name === 'runMcBuild') seen = result.output?.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''; return undefined; } })],
  });
  const result = await session.run({
    blueprintDir: blueprint.dir,
    blueprintId: blueprint.id,
    brief: '测试长输出',
    signal: new AbortController().signal,
  });
  assert.ok(result != null);
  assert.ok(seen.includes(stdout));
  assert.ok(seen.includes(stderr));
  rmSync(base, { recursive: true, force: true });
});
