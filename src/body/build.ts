/**
 * 建造原语：把一份施工计划真的执行掉。
 *
 * 两种执行器共用同一份 `.schem`：
 *   - command：`/fill` + `/setblock`，需要 op，几秒钟完成；
 *   - place：以玩家身份逐块放置（规划器 + pathfinder），慢，但不需要权限。
 *
 * 检查点：
 *   - command：`{ mode: 'command', index }`，index = 已发完的批次数；
 *   - place：`{ mode: 'place', index }`，index = 已完成的步骤数。
 * 两种重放都安全：命令是 replace 语义，放置前会核对世界。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { ActionContext } from '../shared/body.ts';
import type { McBuild, EmitPlan } from './mcbuild.ts';
import { planBuild, isAirState, itemForState } from './build_planner.ts';
import type { PlacementStep, WorldView } from './build_planner.ts';
import { alreadyThere, createPlaceBot } from './place_bot.ts';
import type { PlaceOps } from './place_bot.ts';
import { appendUndo, clearUndo, readUndo, readUndoMode, resetUndo } from './undo.ts';
import type { UndoRecord } from './undo.ts';
import type { Primitive } from './primitives.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => unknown };

/**
 * 探测 op：`/seed` 是权限等级 2 的命令。
 * 回执是 `Seed: …` 说明有权限；`You do not have permission` 说明没有；
 * 超时按“没有”处理——退回逐块放置是安全的。
 */
export function probeOp(bot: AnyBot, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      bot.removeListener?.('message', on);
      resolve(value);
    };
    const on = (raw: unknown): void => {
      const text = String((raw as { toString?: () => string })?.toString?.() ?? raw);
      if (/^Seed: /.test(text)) finish(true);
      else if (/permission/i.test(text)) finish(false);
    };
    bot.on('message', on);
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      bot.chat('/seed');
    } catch {
      finish(false);
    }
  });
}

/** 命令被服务器拒绝时的回执前缀（原版 1.21.4 实测措辞）。 */
const COMMAND_ERRORS = [
  'You do not have permission',
  'Unknown or incomplete command',
  'That position is not loaded',
  'Could not set the block',
  'Unable to place block',
  'No block was found',
  'Expected whitespace',
  'Invalid block state',
];

export interface BuildDeps {
  /** 蓝图根目录（`bots/<name>/build/blueprints` 的绝对路径）。 */
  blueprintsRoot: string;
  mcBuild: McBuild;
  /** 目标 MC 版本；null 表示还不知道，执行器会拒绝施工。 */
  mc: () => string | null;
  /** 每批命令数，默认 10。 */
  batchSize?: number;
  /** 两条命令之间的间隔，默认 50ms。 */
  throttleMs?: number;
  /** 真实放置器；不给就用 mineflayer 适配器（测试注入假实现）。 */
  placeOps?: PlaceOps;
}

interface CommandCheckpoint {
  mode: 'command';
  index: number;
}

type AnyBot = {
  chat(message: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  blockAt?(position: unknown): { name?: string; getProperties?: () => Record<string, unknown> } | null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 从蓝图目录里拿到 `.schem` 的绝对路径；不存在就抛。 */
function schematicPath(deps: BuildDeps, id: string): { dir: string; schem: string } {
  const dir = join(deps.blueprintsRoot, id);
  const schem = join(dir, 'plan.schem');
  if (!existsSync(schem)) throw new Error(`蓝图 ${id} 没有 plan.schem（${schem}）`);
  return { dir, schem };
}

function describePlan(plan: EmitPlan): string {
  const { stats } = plan;
  return `${plan.size.x}x${plan.size.y}x${plan.size.z} · ${stats.nonAir} 格 · ${stats.commands} 条命令`;
}

/** 每 64 个区块一块地 forceload：原版一条 `/forceload` 最多 256 个区块。 */
function forceloadCommands(plan: EmitPlan): string[] {
  const commands: string[] = [];
  const { x1, z1, x2, z2 } = plan.forceload;
  const tile = 15;
  for (let x = x1; x <= x2; x += tile) {
    for (let z = z1; z <= z2; z += tile) {
      commands.push(`/forceload add ${x} ${z} ${Math.min(x + tile, x2)} ${Math.min(z + tile, z2)}`);
    }
  }
  return commands;
}

/** 撤掉同一批区块。 */
function unforceloadCommands(plan: EmitPlan): string[] {
  const commands: string[] = [];
  const { x1, z1, x2, z2 } = plan.forceload;
  const tile = 15;
  for (let x = x1; x <= x2; x += tile) {
    for (let z = z1; z <= z2; z += tile) {
      commands.push(`/forceload remove ${x} ${z} ${Math.min(x + tile, x2)} ${Math.min(z + tile, z2)}`);
    }
  }
  return commands;
}

async function emitPlan(deps: BuildDeps, id: string, origin: { x: number; y: number; z: number }, clearAir: boolean): Promise<EmitPlan> {
  const { dir, schem } = schematicPath(deps, id);
  const outcome = await deps.mcBuild.emit(schem, origin, { cwd: dir, clearAir });
  if (!outcome.ok) {
    const detail = (outcome.stderr || outcome.stdout || '').trim();
    throw new Error(`施工计划失败：${detail === '' ? `mc-build 退出码 ${outcome.code}` : detail}`);
  }
  return outcome.plan;
}

async function runCommandPlan(
  bot: AnyBot,
  plan: EmitPlan,
  context: ActionContext,
  deps: BuildDeps,
  startBatch: number,
  snapshot: () => void,
): Promise<string> {
  if (plan.stats.tooLong > 0) {
    throw new Error(`有 ${plan.stats.tooLong} 条命令超过 256 字符，服务器会拒绝；先拆小蓝图`);
  }
  const batchSize = deps.batchSize ?? 10;
  const throttle = deps.throttleMs ?? 50;
  const batches = chunk(plan.commands, batchSize);

  let failure: string | null = null;
  const onMessage = (raw: unknown): void => {
    const text = String((raw as { toString?: () => string })?.toString?.() ?? raw);
    if (failure == null && COMMAND_ERRORS.some((prefix) => text.startsWith(prefix))) failure = text;
  };
  bot.on('message', onMessage);
  try {
    for (const command of forceloadCommands(plan)) {
      if (context.signal.aborted) throw new Error('aborted');
      bot.chat(command);
      await sleep(throttle);
    }
    // 区块加载之后才能读到原始方块；撤销快照必须在这个点做。
    await sleep(300);
    snapshot();
    let index = startBatch;
    for (; index < batches.length; index++) {
      for (const command of batches[index]) {
        if (failure != null) break;
        if (context.signal.aborted) throw new Error('aborted');
        bot.chat(command);
        await sleep(throttle);
      }
      if (failure != null) break;
      context.checkpoint({ mode: 'command', index: index + 1 } satisfies CommandCheckpoint);
    }
    if (failure != null) {
      return `施工中止：已发 ${index} / ${batches.length} 批。服务器回执：${failure}`;
    }
    // 命令是异步执行的：等一拍再抽查，否则读到的是上一帧的区块。
    await sleep(200);
    return `施工完成：${describePlan(plan)}，共 ${batches.length} 批；${verifySample(bot, plan)}（命令模式）`;
  } finally {
    for (const command of unforceloadCommands(plan)) {
      try {
        bot.chat(command);
      } catch {
        // 清理失败不改变施工结果。
      }
    }
    bot.removeListener?.('message', onMessage);
  }
}

/** 命令施工的撤销：用 /setblock 逐格恢复，不依赖背包材料。 */
async function runCommandUndo(
  bot: AnyBot,
  records: readonly UndoRecord[],
  context: ActionContext,
  deps: BuildDeps,
): Promise<string> {
  const throttle = deps.throttleMs ?? 50;
  const xs = records.map((record) => record.x);
  const zs = records.map((record) => record.z);
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const z1 = Math.min(...zs);
  const z2 = Math.max(...zs);
  const tile = 15;
  const load: string[] = [];
  for (let x = x1; x <= x2; x += tile) {
    for (let z = z1; z <= z2; z += tile) {
      load.push(`/forceload add ${x} ${z} ${Math.min(x + tile, x2)} ${Math.min(z + tile, z2)}`);
    }
  }
  try {
    for (const command of load) {
      if (context.signal.aborted) throw new Error('aborted');
      bot.chat(command);
      await sleep(throttle);
    }
    await sleep(300);
    for (const record of records) {
      if (context.signal.aborted) throw new Error('aborted');
      const state = record.state.includes(':') ? record.state : `minecraft:${record.state}`;
      bot.chat(`/setblock ${record.x} ${record.y} ${record.z} ${state} replace`);
      await sleep(throttle);
    }
    await sleep(200);
  } finally {
    for (const command of load) {
      try {
        bot.chat(command.replace('/forceload add', '/forceload remove'));
      } catch {
        // 清理失败不改变还原结果。
      }
    }
  }
  return `还原完成：${records.length} 格（命令）`;
}

/** 抽查全部非空气格：名字对得上就算过；对不上给数量，不逐格刷屏。 */
function verifySample(bot: AnyBot, plan: EmitPlan): string {
  if (typeof bot.blockAt !== 'function') return '跳过抽查（假 bot 没有 blockAt）';
  const nonAir = plan.blocks.filter((block) => block.state !== 'minecraft:air');
  const sample = nonAir;
  let mismatch = 0;
  for (const block of sample) {
    const found = bot.blockAt(new Vec3(block.x, block.y, block.z));
    const expected = block.state.replace(/^minecraft:/, '').split('[')[0];
    if (found == null || found.name !== expected) mismatch += 1;
  }
  return mismatch === 0 ? `抽查 ${sample.length} 格全部对上` : `抽查 ${sample.length} 格，有 ${mismatch} 格对不上`;
}

function worldView(ops: PlaceOps): WorldView {
  return {
    at(x, y, z) {
      const state = ops.stateAt({ x, y, z });
      if (state == null) return null;
      return { state, solid: ops.solidAt({ x, y, z }) };
    },
  };
}

/** 逐块放置：单块失败跳过，连续 10 块失败整体停（设计 Q25）。 */
async function runPlacePlan(
  ops: PlaceOps,
  steps: readonly PlacementStep[],
  context: ActionContext,
  start: number,
  record: (pos: { x: number; y: number; z: number }, state: string) => void,
): Promise<string> {
  let placed = 0;
  let skipped = 0;
  let consecutive = 0;
  const details: string[] = [];

  for (let index = start; index < steps.length; index++) {
    if (context.signal.aborted) throw new Error('aborted');
    const step = steps[index];
    const current = ops.stateAt(step);
    if (alreadyThere(current, step.state)) {
      context.checkpoint({ mode: 'place', index: index + 1 });
      continue;
    }
    if (current != null) record(step, current);
    try {
      if (step.clear) await ops.dig(step);
      await ops.reach(step);
      // 走到位再拿物品：pathfinder 移动时会换手持槽，先装备会被它覆盖。
      await ops.equip(step.item);
      await ops.place(step, step.state);
      if (!alreadyThere(ops.stateAt(step), step.state)) throw new Error('放完状态不符');
      placed += 1;
      consecutive = 0;
    } catch (error: unknown) {
      skipped += 1;
      consecutive += 1;
      const reason = error instanceof Error ? error.message : String(error);
      details.push(`(${step.x},${step.y},${step.z}) ${reason}`);
    }
    context.checkpoint({ mode: 'place', index: index + 1 });
    if (consecutive >= 10) {
      const head = `施工中断：连续失败 ${consecutive} 块。已放置 ${placed}，跳过 ${skipped}。`;
      return details.length === 0 ? head : `${head}\n${details.join('\n')}`;
    }
  }

  const head = `施工完成：计划 ${steps.length} 步，放置 ${placed}，跳过 ${skipped}（逐块放置）`;
  return details.length === 0 ? head : `${head}\n跳过明细：\n${details.join('\n')}`;
}

/** 建造原语。 */
export function createBuildPrimitives(bot: AnyBot, deps: BuildDeps): Record<string, Primitive> {
  const ops = deps.placeOps ?? createPlaceBot(bot);
  /** 探测一次、记住结果；重连会重建原语，所以不会带着旧权限跑。 */
  let opState: boolean | null = null;
  const hasOp = async (): Promise<boolean> => {
    if (typeof bot?.chat !== 'function' || typeof bot?.on !== 'function') return false;
    if (opState == null) opState = await probeOp(bot);
    return opState;
  };

  const execute = async (args: Record<string, unknown>, context: ActionContext, start: number): Promise<string> => {
    const version = deps.mc();
    if (version == null) throw new Error('不知道目标 MC 版本：在 bot.json 写 mc.version，或先连上服务器');
    if (!existsSync(deps.blueprintsRoot)) throw new Error(`蓝图目录不存在：${deps.blueprintsRoot}`);

    const id = String(args.blueprint ?? '');
    if (id === '') throw new Error('缺少 blueprint（蓝图 id）');
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    if (![x, y, z].every(Number.isInteger)) throw new Error('x/y/z 必须是整数');

    const requested = args.mode === 'command' ? 'command' : args.mode === 'place' ? 'place' : null;
    const mode = requested ?? ((await hasOp()) ? 'command' : 'place');
    const plan = await emitPlan(deps, id, { x, y, z }, mode === 'command' && args.clearAir === true);

    const dir = join(deps.blueprintsRoot, id);
    resetUndo(dir, mode);
    const seen = new Set<string>();
    const record = (pos: { x: number; y: number; z: number }, state: string): void => {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (seen.has(key)) return;
      seen.add(key);
      appendUndo(dir, { x: pos.x, y: pos.y, z: pos.z, state });
    };

    const snapshot = (): void => {
      for (const block of plan.blocks) {
        const current = ops.stateAt(block);
        if (current != null && current !== block.state) record(block, current);
      }
    };

    if (mode === 'command') return runCommandPlan(bot, plan, context, deps, start, snapshot);

    const build = planBuild(plan.blocks, { world: worldView(ops), inventory: ops.inventory() });
    if (build.missing.length > 0) {
      const lines = build.missing.map((entry) => `${entry.item} 需要 ${entry.need}，只有 ${entry.have}`);
      return `材料不足，未开工：\n${lines.join('\n')}`;
    }
    const stop = (): void => ops.stop();
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      return await runPlacePlan(ops, build.steps, context, Math.min(start, build.steps.length), record);
    } finally {
      context.signal.removeEventListener('abort', stop);
    }
  };

  const BuildAt = (args: Record<string, unknown>, context: ActionContext): Promise<string> => execute(args, context, 0);
  const resume = (args: Record<string, unknown>, context: ActionContext, checkpoint: unknown): Promise<string> => {
    const index =
      typeof (checkpoint as { index?: unknown })?.index === 'number' ? Number((checkpoint as { index: number }).index) : 0;
    return execute(args, context, index);
  };

  const UndoBuild = async (args: Record<string, unknown>, context: ActionContext): Promise<string> => {
    const id = String(args.blueprint ?? '');
    if (id === '') throw new Error('缺少 blueprint（蓝图 id）');
    const dir = join(deps.blueprintsRoot, id);
    const records = readUndo(dir);
    if (records.length === 0) return `没有可还原的现场：${id}`;

    const mode = readUndoMode(dir);
    if (mode === 'command') {
      const text = await runCommandUndo(bot, records, context, deps);
      clearUndo(dir);
      return text;
    }

    const stop = (): void => ops.stop();
    context.signal.addEventListener('abort', stop, { once: true });
    let restored = 0;
    let skipped = 0;
    try {
      for (const record of records.reverse()) {
        if (context.signal.aborted) throw new Error('aborted');
        try {
          const current = ops.stateAt(record);
          if (isAirState(record.state)) {
            if (current != null && !isAirState(current)) await ops.dig(record);
          } else {
            if (current != null && alreadyThere(current, record.state)) continue;
            if (current != null && !isAirState(current)) await ops.dig(record);
            await ops.equip(itemForState(record.state));
            await ops.reach(record);
            await ops.place(record, record.state);
          }
          restored += 1;
        } catch {
          skipped += 1;
        }
      }
    } finally {
      context.signal.removeEventListener('abort', stop);
    }
    clearUndo(dir);
    return `还原完成：${restored} 格，跳过 ${skipped}`;
  };

  return {
    BuildAt: Object.assign(BuildAt, { resume }) as Primitive,
    UndoBuild: UndoBuild as Primitive,
  };
}
