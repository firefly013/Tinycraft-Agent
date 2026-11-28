import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcBuild } from '../src/body/mcbuild.ts';
import type { RunResult } from '../src/body/mcbuild.ts';

const CHECKS = '/tmp/blueprint';
const SCHEM = '/tmp/blueprint/plan.schem';

function fakeRun(result: RunResult): { calls: string[][]; cwds: string[]; run: (argv: string[], cwd: string) => Promise<RunResult> } {
  const calls: string[][] = [];
  const cwds: string[] = [];
  return {
    calls,
    cwds,
    run: async (argv, cwd) => {
      calls.push(argv);
      cwds.push(cwd);
      return result;
    },
  };
}

test('build：参数、cwd、JSON 解析都对', async () => {
  const summary = {
    out: SCHEM,
    size: { x: 5, y: 4, z: 5 },
    origin: { x: 0, y: 0, z: 0 },
    dataVersion: 4189,
    nonAir: 42,
    paletteSize: 3,
    warnings: ['w'],
    selfcheck: { ok: true, errors: 0, asciiPath: '/tmp/blueprint/house.ascii.txt', images: [] },
  };
  const fake = fakeRun({ code: 0, stdout: JSON.stringify(summary), stderr: 'note' });
  const mc = createMcBuild({ dir: '/repo/mc-build', run: fake.run });
  const outcome = await mc.build('script.js', 'plan.schem', { mc: '1.21.4', cwd: CHECKS });

  assert.deepEqual(fake.calls[0], ['build', 'script.js', '-o', 'plan.schem', '--mc', '1.21.4', '--json']);
  assert.deepEqual(fake.cwds, [CHECKS]);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.summary.schem, SCHEM);
  assert.equal(outcome.summary.blocks, 42);
  assert.equal(outcome.summary.selfcheck?.asciiPath, '/tmp/blueprint/house.ascii.txt');
  assert.equal(outcome.summary.stderr, 'note');
});

test('build 失败：不抛异常，原样带回 stdout/stderr 与退出码', async () => {
  const fake = fakeRun({ code: 1, stdout: 'partial', stderr: 'boom' });
  const mc = createMcBuild({ dir: '/repo/mc-build', run: fake.run });
  const outcome = await mc.build('script.js', 'plan.schem', { mc: '1.21.4', cwd: CHECKS });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 1);
  assert.equal(outcome.stderr, 'boom');
});

test('build 成功但输出不是 JSON：错误信息保留完整输出', async () => {
  const stdout = `${'x'.repeat(500)}END-MARKER`;
  const fake = fakeRun({ code: 0, stdout, stderr: '' });
  const mc = createMcBuild({ dir: '/repo/mc-build', run: fake.run });
  await assert.rejects(
    () => mc.build('script.js', 'plan.schem', { mc: '1.21.4', cwd: CHECKS }),
    (error: unknown) => error instanceof Error && error.message.includes('END-MARKER'),
  );
});

test('emit：默认不带 --clear-air，显式要求才带', async () => {
  const plan = {
    size: { x: 2, y: 1, z: 2 },
    origin: { x: 10, y: 20, z: 30 },
    commands: ['/setblock 10 20 30 minecraft:stone replace'],
    blocks: [{ x: 10, y: 20, z: 30, state: 'minecraft:stone' }],
    stats: {
      cells: 4,
      nonAir: 1,
      states: 1,
      fills: 0,
      setblocks: 1,
      entities: 0,
      commands: 1,
      maxCommandLength: 40,
      tooLong: 0,
    },
    forceload: { x1: 10, z1: 30, x2: 11, z2: 31 },
    tooLong: [],
  };
  const fake = fakeRun({ code: 0, stdout: JSON.stringify(plan), stderr: '' });
  const mc = createMcBuild({ dir: '/repo/mc-build', run: fake.run });

  await mc.emit(SCHEM, { x: 10, y: 20, z: 30 }, { cwd: CHECKS });
  assert.deepEqual(fake.calls[0], ['emit', SCHEM, '--origin', '10,20,30', '--json']);

  await mc.emit(SCHEM, { x: 10, y: 20, z: 30 }, { cwd: CHECKS, clearAir: true });
  assert.ok(fake.calls[1].includes('--clear-air'));
});

test('emit 失败（stdout 为空）：ok=false，不尝试解析', async () => {
  const fake = fakeRun({ code: 1, stdout: '', stderr: '读 .schem 失败' });
  const mc = createMcBuild({ dir: '/repo/mc-build', run: fake.run });
  const outcome = await mc.emit(SCHEM, { x: 0, y: 0, z: 0 }, { cwd: CHECKS });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /读 \.schem 失败/);
});

test('mc-build 不存在：默认执行器直接拒绝', async () => {
  const mc = createMcBuild({ dir: '/definitely/not/here' });
  await assert.rejects(() => mc.build('script.js', 'plan.schem', { mc: '1.21.4', cwd: CHECKS }), /mc-build 不存在/);
});
