#!/usr/bin/env node
/**
 * 建筑端到端冒烟：真服务器、真 mineflayer、真 mc-build、真施工与撤销。
 *
 * 前置：
 *   · 一个 1.21.4 服务器在跑；
 *   · bot 用户名是 op（默认 ProtoCraft，对应 ops.json）；
 *   · mc-build 仓库路径可用。
 *
 * 环境变量：
 *   MC_HOST=127.0.0.1  MC_PORT=25600  MC_USERNAME=ProtoCraft  MC_VERSION=1.21.4
 *   MC_BUILD_DIR=../mc-build  BOT=BaselineBot
 *   SMOKE_ORIGIN=500,100,500
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBlueprint, updateBlueprint } from '../src/agent/blueprints.ts';
import { createBuildPrimitives } from '../src/body/build.ts';
import { createMcBuild } from '../src/body/mcbuild.ts';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const mineflayer = require('mineflayer') as any;
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => any };
const pathfinderModule = require('mineflayer-pathfinder') as {
  pathfinder: (bot: any) => void;
  Movements: new (bot: any) => any;
};

const env = process.env;
const host = env.MC_HOST ?? '127.0.0.1';
const port = Number(env.MC_PORT ?? 25600);
const username = env.MC_USERNAME ?? 'ProtoCraft';
const version = env.MC_VERSION ?? '1.21.4';
const botName = env.BOT ?? 'BaselineBot';
const mcBuildDir = resolve(env.MC_BUILD_DIR ?? join(process.cwd(), '..', 'mc-build'));
const configuredOrigin = env.SMOKE_ORIGIN == null ? null : env.SMOKE_ORIGIN.split(',').map(Number);
if (configuredOrigin != null && (configuredOrigin.length !== 3 || !configuredOrigin.every(Number.isInteger))) {
  throw new Error('SMOKE_ORIGIN 要 x,y,z');
}

function fail(message: string): never {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

const blueprintsRoot = resolve('bots', botName, 'build', 'blueprints');
mkdirSync(blueprintsRoot, { recursive: true });
const blueprint = createBlueprint(blueprintsRoot, 'smoke cabin', { mc: version });
writeFileSync(join(blueprint.dir, 'script.js'), [
  "builder.fill(0, 0, 0, 3, 1, 3, 'stone');",
  "builder.walls(0, 1, 0, 3, 2, 3, 'oak_planks');",
].join('\n'));

const mcBuild = createMcBuild({ dir: mcBuildDir });
const built = await mcBuild.build('script.js', 'plan.schem', { mc: version, cwd: blueprint.dir });
if (!built.ok) fail(`编译失败（${built.code}）：${built.stderr}`);
updateBlueprint(blueprintsRoot, blueprint.id, {
  size: built.summary.size,
  blocks: built.summary.blocks,
  materials: {},
});
console.log(`编译 OK：${blueprint.id} ${built.summary.size.x}x${built.summary.size.y}x${built.summary.size.z}`);

const bot: any = mineflayer.createBot({ host, port, username, auth: 'offline', version });
bot.on('error', (error: unknown) => console.error('[bot]', error));
await new Promise<void>((ok, bad) => {
  bot.once('spawn', () => ok());
  bot.once('error', bad);
  setTimeout(() => bad(new Error('等出生超时')), 30_000);
});
// 建在 bot 旁边：客户端只缓存视野内的区块，建在远处会读到 null。
if (typeof bot.waitForChunksToLoad === 'function') await bot.waitForChunksToLoad();
await new Promise((resolve) => setTimeout(resolve, 500));
// 真机里这些插件由身体装配；冒烟直接起一个最小可放置的身体。
pathfinderModule.pathfinder(bot);
const movements = new pathfinderModule.Movements(bot);
movements.canDig = true;
movements.allow1by1towers = true;
bot.pathfinder.setMovements(movements);
const position = bot.entity.position;
const origin: number[] = configuredOrigin ?? [Math.floor(position.x) + 4, Math.floor(position.y), Math.floor(position.z)];
console.log(`[${username}] 已出生，开始施工 ${origin.join(',')}`);

const primitives = createBuildPrimitives(bot, {
  blueprintsRoot,
  mcBuild,
  mc: () => version,
  throttleMs: 120,
});
const context = { signal: new AbortController().signal, checkpoint: () => {} };

const at = (x: number, y: number, z: number): string => {
  const block = bot.blockAt(new Vec3(x, y, z), false);
  return block == null ? 'null' : String(block.name);
};
const before = at(origin[0], origin[1], origin[2]);

const placed = await primitives.BuildAt(
  {
    blueprint: blueprint.id,
    x: origin[0],
    y: origin[1],
    z: origin[2],
    ...(env.SMOKE_MODE == null ? {} : { mode: env.SMOKE_MODE }),
  },
  context,
);
console.log(placed);
if (!placed.startsWith('施工完成')) fail(`施工没完成：${placed}`);
const floor = at(origin[0], origin[1], origin[2]);
if (floor !== 'stone') fail(`原点应该是 stone，实际是 ${floor}`);

const undone = await primitives.UndoBuild({ blueprint: blueprint.id }, context);
console.log(undone);
const after = at(origin[0], origin[1], origin[2]);
if (after !== before) fail(`撤销后应该是 ${before}，实际是 ${after}`);

if (env.SMOKE_PLACE === '1') {
  // 真实放置：给材料、搭一个支撑面，再用默认的 place 模式放一块。
  const spot = bot.entity.position;
  const target = [Math.floor(spot.x) + 2, Math.floor(spot.y), Math.floor(spot.z)];
  bot.chat(`/setblock ${target[0]} ${target[1] - 1} ${target[2]} minecraft:stone`);
  bot.chat(`/setblock ${target[0]} ${target[1]} ${target[2]} minecraft:air`);
  bot.chat(`/give ${username} minecraft:stone 16`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const one = createBlueprint(blueprintsRoot, 'smoke single block', { mc: version });
  writeFileSync(join(one.dir, 'script.js'), "builder.set(0, 0, 0, 'stone');");
  const tiny = await mcBuild.build('script.js', 'plan.schem', { mc: version, cwd: one.dir });
  if (!tiny.ok) fail(`单块蓝图编译失败：${tiny.stderr}`);
  const placedByHand = await primitives.BuildAt(
    { blueprint: one.id, x: target[0], y: target[1], z: target[2], mode: 'place' },
    context,
  );
  console.log(placedByHand);
  if (!placedByHand.startsWith('施工完成')) fail(`真实放置没完成：${placedByHand}`);
  const got = at(target[0], target[1], target[2]);
  if (got !== 'stone') fail(`真实放置后应该是 stone，实际是 ${got}`);
}


console.log('SMOKE OK：编译 → 命令施工 → 撤销，全链路通过');
bot.quit();
process.exit(0);
