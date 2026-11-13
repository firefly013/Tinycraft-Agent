/**
 * 原语实现：一次只做一件事，做完报事实。
 *
 * 这里只碰 mineflayer；`any` 是刻意的——插件（pathfinder / collectblock）的
 * 类型是运行时挂载的，这层只用到很薄的一个切面。业务判断一律不写在这。
 *
 * 取消与续做都走 `ActionContext`：signal 一 abort 就停；能数得清的活
 * （目前是 collectBlock）在执行中上报检查点，被打断后从断点继续。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';
import { withAbort, type ActionContext } from '../shared/body.ts';
import { weaponDamage } from './combat.ts';
import { closeContainer, findCraftingTable } from './crafting.ts';
import { nearestBlocks, nearestBlocksLoaded } from './ores.ts';
import { markDiscarded, pickupDrops } from './pickup.ts';

// CJS 互操作：pathfinder 的 `module.exports = {…}` 无法被 Node ESM 静态识别，
// 命名 import 在运行时会炸，所以统一走 createRequire。
const require = createRequire(import.meta.url);

interface GoalsModule {
  GoalNear: new (x: number, y: number, z: number, range?: number) => unknown;
  GoalFollow: new (entity: unknown, range?: number) => unknown;
}

const { goals } = require('mineflayer-pathfinder') as { goals: GoalsModule };
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => any };

export interface PrimitiveDeps {
  /** 最大自由度寻路配置（可挖、可放、可垫柱）；spawn 之后才构造，用 getter 取。 */
  movements?: () => MovementProfile | null;
  /** 单个原语的超时（毫秒），默认 120 秒；测试会调小。 */
  timeoutMs?: number;
}

/** 一个身体原语：参数已校验，失败就抛错或回一段事实。 */
export interface Primitive {
  (args: Record<string, unknown>, context: ActionContext): Promise<string>;
  /**
   * **有序停机的清理钩子**（可选）：把动作留在外部世界里的状态收回来。
   *
   * 调用方保证：清理期间身体锁还在这条动作身上、且给一个有超时的 signal。
   * 实现必须幂等、不抛；没有检查点/没有留下现场时返回空字符串。
   */
  stop?: (context: ActionContext, checkpoint: unknown) => Promise<string>;
}

/** 最大自由度的 pathfinder 配置。GoTo 是核心移动工具，不能因为“不想乱挖”而 NoPath。 */
export interface MovementProfile {
  reach: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 超时不只是"不再等"：到点必须 abort 底层操作（stopDigging / pathfinder.stop），
 * 否则回执已经返回、锁已经释放，身体却还在动。
 */
function bounded<T>(
  work: Promise<T>,
  context: ActionContext,
  onAbort: (() => void) | undefined,
  timeoutMs: number,
  timeoutText: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const onOuter = (): void => {
      stop(new Error('aborted'));
    };
    const cleanup = (): void => {
      if (timer != null) clearTimeout(timer);
      context.signal.removeEventListener('abort', onOuter);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stop = (error: Error): void => {
      try {
        onAbort?.();
      } catch {
        // 停不下来也照样按取消/超时处理。
      }
      finish(() => reject(error));
    };
    if (context.signal.aborted) {
      stop(new Error('aborted'));
      return;
    }
    timer = setTimeout(() => stop(new Error(timeoutText)), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    context.signal.addEventListener('abort', onOuter, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** `withAbort` 的 ActionContext 薄壳：body 侧到处在用 context，省得处处写 `.signal`。 */
function abortable<T>(work: Promise<T>, context: ActionContext, onAbort?: () => void): Promise<T> {
  return withAbort(work, context.signal, onAbort);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 右键容器会打开窗口：没有搬运工具时，开着窗口只会让后续背包操作点错窗口。 */

/** 从背包里挑伤害最高的剑；没有剑返回 null。 */
export function pickWeapon(items: readonly { name: string }[]): string | null {
  let best: string | null = null;
  let bestDamage = 0;
  for (const item of items) {
    const key = item.name.replace(/^minecraft:/, '');
    if (!key.endsWith('_sword')) continue;
    const damage = weaponDamage(key);
    if (damage > bestDamage) {
      best = item.name;
      bestDamage = damage;
    }
  }
  return best;
}

/** 停掉 custom-pvp 的近战/远程两个模块。 */
function stopPvp(bot: any): void {
  try {
    bot?.swordpvp?.stop?.();
  } catch {
    // best-effort
  }
  try {
    bot?.bowpvp?.stop?.();
  } catch {
    // best-effort
  }
}

/** 看实体（拿不到位置就跳过）。 */
function lookAtEntity(bot: any, entity: any): void {
  try {
    const position = entity?.position;
    if (position == null) return;
    void bot.lookAt(position.offset(0, 1.5, 0), true)?.catch?.(() => undefined);
  } catch {
    // 视觉是锦上添花：看不了也照常打。
  }
}

/** 燃料：煤/木炭按 8 个算，木板/原木按 1.5 个算。 */
const FUEL_YIELD: Readonly<Record<string, number>> = { coal: 8, charcoal: 8 };

function fuelCountFor(name: string, want: number): number {
  return Math.min(64, Math.max(1, Math.ceil(want / (FUEL_YIELD[name] ?? 1.5))));
}

/* ── 挖矿/采集的公共内部逻辑（旧项目真机事故换来的，不是装饰） ── */

/** 读不到方块数据时的兜底：至少让常见矿石按掉落物记账。 */
const BLOCK_DROP_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  coal_ore: ['coal'],
  deepslate_coal_ore: ['coal'],
  iron_ore: ['raw_iron'],
  deepslate_iron_ore: ['raw_iron'],
  copper_ore: ['raw_copper'],
  deepslate_copper_ore: ['raw_copper'],
  gold_ore: ['raw_gold'],
  deepslate_gold_ore: ['raw_gold'],
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  nether_quartz_ore: ['quartz'],
  nether_gold_ore: ['gold_nugget'],
  gravel: ['flint', 'gravel'],
  grass_block: ['dirt'],
  stone: ['cobblestone'],
  deepslate: ['cobbled_deepslate'],
};

/** 这个方块被挖掉后掉什么（用于按掉落物计数，而不是按方块名计数）。 */
export function blockDropNames(bot: any, blockName: string): string[] {
  const names = new Set<string>();
  try {
    const block = bot?.registry?.blocksByName?.[blockName];
    const drops: unknown = block?.drops;
    if (Array.isArray(drops)) {
      for (const entry of drops as any[]) {
        const drop = entry?.drop ?? entry;
        const id = typeof drop === 'number' ? drop : drop?.id;
        const name = id != null ? bot?.registry?.items?.[id]?.name : null;
        if (typeof name === 'string' && name !== '') names.add(name);
      }
    }
  } catch {
    // 读不到方块数据就走兜底。
  }
  if (names.size === 0) {
    for (const fallback of BLOCK_DROP_FALLBACK[blockName] ?? [blockName]) names.add(fallback);
  }
  return [...names];
}

/** 背包里某物品的总数。 */
export function countInventory(bot: any, name: string): number {
  try {
    return (bot?.inventory?.items?.() ?? [])
      .filter((entry: any) => entry?.name === name)
      .reduce((sum: number, entry: any) => sum + Number(entry?.count ?? 0), 0);
  } catch {
    return 0;
  }
}

/** 这个原料"能拿到多少"：背包里有算有；没有但能用背包里的东西现做也算一点。 */
function ingredientPotential(bot: any, name: string, need: number, table: any, depth: number): number {
  const have = countInventory(bot, name);
  if (have >= need) return need * 2;
  if (have > 0) return Math.min(have, need);
  if (depth <= 0) return 0;
  const def = bot.registry?.itemsByName?.[name];
  if (def == null) return 0;
  for (const recipe of discoverRecipes(bot, def.id, table)) {
    const deltas = Array.isArray(recipe?.delta) ? (recipe.delta as Array<{ id?: unknown; count?: unknown }>) : [];
    const sources = deltas.filter((delta) => Number(delta?.count) < 0);
    if (sources.length === 0) continue;
    const allFromInventory = sources.every((delta) => {
      const sourceName = bot.registry?.items?.[Number(delta?.id)]?.name;
      return typeof sourceName === 'string' && countInventory(bot, sourceName) > 0;
    });
    if (allFromInventory) return 1;
  }
  return 0;
}

/**
 * 竖直挖下去（深目标专用）：只在自己这一柱往下，逐格检查水/岩浆。
 *
 * pathfinder 的"斜着挖"会撞进局部水层（实测掉进密封水洞后出不来），
 * 所以深目标改成先走到一个干柱子，再竖着往下挖。
 */
async function descendShaft(
  bot: any,
  context: any,
  targetY: number,
  timeoutMs: number,
): Promise<{ ok: boolean; message: string }> {
  const deadline = Date.now() + timeoutMs;
  let steps = 0;
  while (Date.now() < deadline && !context.signal.aborted) {
    const here = bot.entity.position;
    const feetY = Math.floor(here.y);
    if (feetY <= targetY) return { ok: true, message: `已经到 y=${feetY}` };
    const colX = Math.floor(here.x);
    const colZ = Math.floor(here.z);
    const below = bot.blockAt(new Vec3(colX, feetY - 1, colZ));
    if (below == null) return { ok: false, message: `(${colX},${feetY - 1},${colZ}) 没加载` };
    if (isWaterBlockName(String(below.name)) || below.name === 'lava' || below.name === 'flowing_lava') {
      return { ok: false, message: `脚下是 ${below.name}（y=${feetY - 1}）` };
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const side = bot.blockAt(new Vec3(colX + dx, feetY - 1, colZ + dz));
      if (side != null && (isWaterBlockName(String(side.name)) || side.name === 'lava' || side.name === 'flowing_lava')) {
        return { ok: false, message: `旁边有 ${side.name}（y=${feetY - 1}）` };
      }
    }
    if (below.name !== 'air' && below.name !== 'cave_air') {
      await ensureHarvestTool(bot, below);
      await bounded(bot.dig(below), context, () => bot.stopDigging?.(), 10_000, `挖 (${colX},${feetY - 1},${colZ}) 超时`);
      steps += 1;
    }
    for (let i = 0; i < 15; i += 1) {
      await sleep(100);
      if (Math.floor(bot.entity.position.y) < feetY) break;
      if (context.signal.aborted) break;
    }
    if (steps > 500) return { ok: false, message: `挖了 500 层还没到 y=${targetY}` };
  }
  if (context.signal.aborted) return { ok: false, message: '被打断了' };
  return { ok: false, message: `挖到 y=${Math.floor(bot.entity.position.y)}，还没到 ${targetY}` };
}

/** 这个方块是不是水（水源/流动水）。 */
function isWaterBlockName(name: string): boolean {
  return name === 'water' || name === 'flowing_water';
}

/** 找附近"往下这段没有水"的柱子（只看脚下 24 格，扫太深会拖垮 blockAt）。 */
function findDryColumn(bot: any, origin: { x: number; y: number; z: number }, maxRadius = 16): { x: number; z: number } | null {
  const ox = Math.floor(origin.x);
  const oz = Math.floor(origin.z);
  const yTop = Math.floor(origin.y) - 2;
  const yBottom = yTop - 24;
  const dryColumn = (x: number, z: number): boolean => {
    for (let y = yTop; y >= yBottom; y -= 4) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block == null) return false;
      if (isWaterBlockName(String(block.name))) return false;
    }
    return true;
  };
  if (dryColumn(ox, oz)) return { x: ox, z: oz };
  for (let radius = 8; radius <= maxRadius; radius += 8) {
    const candidates: Array<{ x: number; z: number }> = [];
    for (let dx = -radius; dx <= radius; dx += 8) {
      for (let dz = -radius; dz <= radius; dz += 8) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        candidates.push({ x: ox + dx, z: oz + dz });
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - ox, a.z - oz) - Math.hypot(b.x - ox, b.z - oz));
    for (const candidate of candidates) if (dryColumn(candidate.x, candidate.z)) return candidate;
  }
  return null;
}

/** 合成失败时给模型一句能行动的话：缺什么料、是不是需要工作台。 */
function diagnoseCraftFailure(bot: any, itemId: number, count: number, table: any): string {
  const all = discoverRecipes(bot, itemId, true); // 传 true 只做诊断：绕过"需要工作台"的过滤
  if (all.length === 0) return '没有这个物品的合成配方';
  const recipe = pickRecipe(bot, all, count, table) ?? all[0];
  const times = Math.max(1, Math.ceil(count / Math.max(1, Number(recipe?.result?.count ?? 1))));
  const missing: string[] = [];
  for (const delta of Array.isArray(recipe?.delta) ? recipe.delta : []) {
    const deltaCount = Number(delta?.count);
    if (!(deltaCount < 0)) continue;
    const name = bot.registry?.items?.[Number(delta?.id)]?.name;
    if (typeof name !== 'string') continue;
    const need = -deltaCount * times;
    const have = countInventory(bot, name);
    if (have < need) missing.push(`${name}×${need - have}`);
  }
  if (missing.length > 0) return `材料不够，缺 ${missing.join('、')}`;
  if (table == null) return '材料够了，但需要工作台：先 craft crafting_table（工具会自动放）或者 placeBlock 放一个';
  return '材料够了但没合成成功，再试一次';
}
/** 这个配方需要多少原料已经"够"（按次数 times 算）；用来在多个同族配方里挑可行的那个。 */
function recipeReadiness(bot: any, recipe: any, times: number, table: any): number {
  let score = 0;
  for (const delta of Array.isArray(recipe?.delta) ? recipe.delta : []) {
    const count = Number(delta?.count);
    if (!(count < 0)) continue;
    const name = bot.registry?.items?.[Number(delta?.id)]?.name;
    if (typeof name !== 'string') continue;
    score += ingredientPotential(bot, name, -count * times, table, 1);
  }
  return score;
}

/** 同族配方有多个变体（不同木头/材料）：挑原料最够的那个，别闭眼拿第一个。 */
function pickRecipe(bot: any, recipes: readonly any[], times: number, table: any): any | null {
  if (recipes.length === 0) return null;
  let best = recipes[0];
  let bestScore = recipeReadiness(bot, best, times, table);
  for (const recipe of recipes.slice(1)) {
    const score = recipeReadiness(bot, recipe, times, table);
    if (score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  }
  return best;
}
/** 拿配方时不要求"材料已经够"：recipesFor 在材料不足时返回空，规划就无从谈起。 */
function discoverRecipes(bot: any, itemId: number, table: any): any[] {
  try {
    if (typeof bot.recipesAll === 'function') return (bot.recipesAll(itemId, null, table) as any[]) ?? [];
  } catch {
    // 退回 recipesFor。
  }
  try {
    return (bot.recipesFor(itemId, null, 1, table) as any[]) ?? [];
  } catch {
    return [];
  }
}
/**
 * **材料缺可合成的中间件就先补**（木板/木棍这类）。
 *
 * 4B 小模型不会自己规划"先把原木做成木板"，会卡在「材料不够」里空转；
 * 这一步把"配方依赖"收进工具层，深度上限 3（木棍→木板→原木），失败不抛。
 */
async function ensureCraftMaterials(
  bot: any,
  itemId: number,
  times: number,
  table: any,
  context: ActionContext,
  depth: number,
  notes: string[],
): Promise<void> {
  if (depth > 3 || context.signal.aborted) return;
  const recipes = discoverRecipes(bot, itemId, table);
  if (recipes.length === 0) return;
  // 两遍：第二遍补"被下游合成消耗掉的上游材料"（例如做木棍用掉木板后，主配方又缺木板）。
  for (let pass = 0; pass < 2; pass += 1) {
  const recipe = pickRecipe(bot, recipes, times, table);
  if (recipe == null) return;
  const delta = Array.isArray(recipe.delta) ? (recipe.delta as Array<{ id?: unknown; count?: unknown }>) : [];
  for (const entry of delta) {
    const count = Number(entry?.count);
    if (!(count < 0)) continue;
    const need = -count * times;
    const id = Number(entry?.id);
    const name = bot.registry?.items?.[id]?.name;
    if (typeof name !== 'string') continue;
    const have = countInventory(bot, name);
    if (have >= need) continue;
    const subRecipes = discoverRecipes(bot, id, table);
    const probe = pickRecipe(bot, subRecipes, 1, table);
    if (probe == null) continue; // 原料（原木/圆石）：做不了，交给主流程报错
    const perCraft = Math.max(1, Number(probe.result?.count ?? 1));
    const needTimes = Math.ceil((need - have) / perCraft);
    const subRecipe = pickRecipe(bot, subRecipes, needTimes, table) ?? probe;
    await ensureCraftMaterials(bot, id, needTimes, table, context, depth + 1, notes);
    if (context.signal.aborted) return;
    const before = countInventory(bot, name);
    await bot.craft(subRecipe, needTimes, table);
    // 连着两次 2×2 合成时服务器窗口状态还没同步，紧接着的合成会"吃掉一个材料但不出产物"。
    await sleep(300);
    const after = countInventory(bot, name);
    if (after > before && notes.length < 4) notes.push(`${name} ${before}→${after}`);
  }
  }
}
/** 当前主手是否真的能收获这个方块。读不到就当"不知道"，交给 dig 自己试。 */
function canHarvestWith(bot: any, block: any): boolean {
  try {
    if (typeof block?.canHarvest !== 'function') return true;
    const held = bot?.heldItem;
    if (held == null) return block.canHarvest(0) === true;
    return block.canHarvest(held.type) === true;
  } catch {
    return true;
  }
}

/**
 * 先换上能收获它的工具。
 *
 * 旧项目里 `mineBlock` 最致命的坑就是裸 `bot.dig`：手上拿着剑/泥土挖铁矿，
 * 服务器不给掉落，模型却以为挖到了。这里优先用 mineflayer-tool 的
 * `equipForBlock`（collectBlock 插件会加载它），再自己按 harvestTools 兜底。
 */
async function ensureHarvestTool(bot: any, block: any): Promise<void> {
  if (bot?.game?.gameMode === 'creative') return;
  try {
    if (bot?.tool?.equipForBlock != null) {
      await bot.tool.equipForBlock(block, { requireHarvest: true });
      if (canHarvestWith(bot, block)) return;
    }
  } catch {
    // 换不上继续走下面的手工兜底。
  }
  try {
    const harvest = block?.harvestTools;
    if (harvest == null) return;
    const ids = new Set<number>(Object.keys(harvest).map(Number));
    const item = bot.inventory.items().find((entry: any) => ids.has(Number(entry.type)));
    if (item != null && bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');
  } catch {
    // 没工具就交给调用方按 planDig 报错。
  }
}

/** 挖自己的落脚点会连人一起掉下去（旧项目下界岩下面就是岩浆）。 */
function isFootingBlock(position: { x: number; y: number; z: number } | null | undefined, target: { x: number; y: number; z: number }): boolean {
  const fx = Math.floor(Number(position?.x));
  const fy = Math.floor(Number(position?.y));
  const fz = Math.floor(Number(position?.z));
  const tx = Math.floor(Number(target.x));
  const ty = Math.floor(Number(target.y));
  const tz = Math.floor(Number(target.z));
  if (![fx, fy, fz, tx, ty, tz].every(Number.isFinite)) return false;
  return tx === fx && tz === fz && (ty === fy || ty === fy - 1);
}

/** 挖之前裁决：force=false 时必须能拿到掉落；force=true 只求挖开。 */
function planDig(bot: any, block: any, force: boolean): { ok: boolean; note: string } {
  if (force || bot?.game?.gameMode === 'creative' || canHarvestWith(bot, block)) return { ok: true, note: '' };
  return {
    ok: false,
    note: `手上没有能收获 ${block.name} 的工具（当前是 ${bot?.heldItem?.name ?? '空手'}）；去背包换工具，或者用 force:true 只求挖开。`,
  };
}

/** 挖/采集之后把附近的掉落物捡起来；失败不影响主结果。 */
/** 按名字/类型找攻击目标（旧 attack 的 target/type 语义）。 */
function resolveAttackTarget(
  bot: any,
  target: string,
  type: string | undefined,
): { entity: any | null; message: string } {
  const raw = target.trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && bot.entities[Math.floor(numeric)] != null) {
    const byId = bot.entities[Math.floor(numeric)];
    return { entity: byId, message: `锁定实体 #${Math.floor(numeric)} ${byId.name ?? ''}` };
  }
  const known = (Object.values(bot.entities ?? {}) as any[]).filter((entity) => {
    if (entity == null || entity === bot.entity || entity.isValid === false) return false;
    if (type === 'player' && entity.type !== 'player') return false;
    if (type === 'entity' && entity.type !== 'mob' && entity.type !== 'animal') return false;
    const name = String(entity.name ?? '').toLowerCase();
    const username = String(entity.username ?? '').toLowerCase();
    const wanted = raw.toLowerCase();
    return name === wanted || username === wanted || name.includes(wanted) || username.includes(wanted);
  });
  const self = bot.entity?.position;
  known.sort((a, b) => {
    const da = self == null ? Infinity : a.position.distanceTo(self);
    const db = self == null ? Infinity : b.position.distanceTo(self);
    return da - db;
  });
  const entity = known[0];
  return entity == null
    ? { entity: null, message: `附近没找到 ${raw}${type == null ? '' : `（${type}）`}` }
    : { entity, message: `锁定 ${entity.name ?? '实体'}${entity.username == null ? '' : `（${entity.username}）`}` };
}

/** 按物品类型决定装备到哪个部位（旧 equip 的 bodyPartForItem 简化版）。 */
function bodyPartForItem(name: string): 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' {
  const key = name.replace(/^minecraft:/, '');
  if (key.endsWith('_helmet') || key === 'turtle_helmet' || key === 'carved_pumpkin') return 'head';
  if (key.endsWith('_chestplate') || key === 'elytra') return 'torso';
  if (key.endsWith('_leggings')) return 'legs';
  if (key.endsWith('_boots')) return 'feet';
  if (key === 'shield') return 'off-hand';
  return 'hand';
}

/* ── 容器工具（存储）：inspect 看 / loot 全拿 / take 拿指定 / put 存指定 ── */

const CONTAINER_BLOCK_NAMES = [
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'hopper',
  'dispenser',
  'dropper',
  'brewing_stand',
  'crafting_table',
  'enchanting_table',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'shulker_box',
];
const FURNACE_BLOCK_NAMES = new Set(['furnace', 'lit_furnace', 'blast_furnace', 'lit_blast_furnace', 'smoker', 'lit_smoker']);

/** 熔炉三个槽的显示名。槽是**按名字**读写的，不是按索引——所以熔炉不归 container 管。 */
const FURNACE_SLOT_LABELS: Record<string, string> = { input: '原料槽', fuel: '燃料槽', output: '产物槽' };

function slotLabel(slot: string): string {
  return FURNACE_SLOT_LABELS[slot] ?? '槽';
}

function itemText(item: any): string {
  return item == null ? '空' : `${item.name}×${item.count}`;
}

/** 找熔炉：给了 coords 就查那个方块，否则找 4 格内；都不是熔炉族就报清楚。 */
function findFurnaceBlock(bot: any, coords: unknown): any | string {
  const parsed = parseCoords(coords);
  if (parsed != null) {
    const block = bot.blockAt(new Vec3(parsed.x, parsed.y, parsed.z));
    if (block == null) return `(${parsed.x},${parsed.y},${parsed.z}) 看不到方块`;
    if (!FURNACE_BLOCK_NAMES.has(String(block.name ?? ''))) {
      return `(${parsed.x},${parsed.y},${parsed.z}) 是 ${String(block.name)}，不是熔炉`;
    }
    return block;
  }
  const ids = [
    ...new Set(
      [...FURNACE_BLOCK_NAMES]
        .map((name) => bot.registry?.blocksByName?.[name]?.id)
        .filter((id: unknown): id is number => typeof id === 'number'),
    ),
  ];
  const block = bot.findBlock({ matching: ids, maxDistance: 4 });
  return block ?? '附近 4 格没有熔炉：先 goTo 过去，或者 placeBlock 放一个';
}

/** 把背包里的方块放到脚边（第一个能放的位置）；放不成就返回 null。 */
async function placeBlockAdjacent(bot: any, itemName: string, context: ActionContext): Promise<any | null> {
  const item = bot.inventory.items().find((entry: any) => entry?.name === itemName);
  if (item == null) return null;
  const base = bot.entity?.position?.floored?.();
  if (base == null) return null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const ground = bot.blockAt(new Vec3(base.x + dx, base.y - 1, base.z + dz));
    const above = bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz));
    if (ground == null || ground.name === 'air' || above == null || above.name !== 'air') continue;
    try {
      await bot.equip(item, 'hand');
      await abortable(bot.placeBlock(ground, new Vec3(0, 1, 0)), context);
      await sleep(200);
      return bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz)) ?? null;
    } catch {
      // 换个位置再试。
    }
  }
  // 四面都被占（矿洞/树冠里很常见）：挖掉脚边一块墙，腾出位置再放。
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const cell = bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz));
    const ground = bot.blockAt(new Vec3(base.x + dx, base.y - 1, base.z + dz));
    if (cell == null || ground == null) continue;
    if (cell.boundingBox !== 'block' || ground.boundingBox !== 'block') continue;
    try {
      await abortable(bot.dig(cell), context);
      await sleep(250);
      await bot.equip(item, 'hand');
      await abortable(bot.placeBlock(ground, new Vec3(0, 1, 0)), context);
      await sleep(200);
      return bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz)) ?? null;
    } catch {
      // 这块挖不动就换下一块。
    }
  }
  return null;
}

/** 找熔炉；附近没有但背包里有，就自己放一个（小模型不会算"该放在哪一格"）。 */
async function findOrPlaceFurnace(
  bot: any,
  coords: unknown,
  context: ActionContext,
): Promise<any | string> {
  const found = findFurnaceBlock(bot, coords);
  if (typeof found !== 'string') return found;
  if (parseCoords(coords) != null) return found;
  const placed = await placeBlockAdjacent(bot, 'furnace', context);
  if (placed != null && FURNACE_BLOCK_NAMES.has(String(placed.name ?? ''))) return placed;
  return found;
}
function parseCoords(raw: unknown): { x: number; y: number; z: number } | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
  return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
}

function parseItemSpec(raw: unknown): Array<{ name: string; count: number | null }> {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [nameRaw, countRaw] = part.split(':');
      const name = String(nameRaw ?? '').replace(/^minecraft:/, '').trim();
      const count = countRaw == null || countRaw.trim() === '' ? null : Math.max(1, Math.floor(Number(countRaw)));
      return { name, count: Number.isFinite(count) ? count : null };
    })
    .filter((entry) => entry.name !== '');
}

function findContainerBlock(bot: any, args: Record<string, unknown>): any | string {
  const coords = parseCoords(args.coords);
  if (coords != null) {
    const block = bot.blockAt(new Vec3(coords.x, coords.y, coords.z));
    if (block == null) return `(${coords.x},${coords.y},${coords.z}) 看不到方块`;
    if (FURNACE_BLOCK_NAMES.has(String(block.name ?? ''))) {
      return `(${coords.x},${coords.y},${coords.z}) 是熔炉：用 furnace 工具（read / put / take / smelt）`;
    }
    return block;
  }
  const ids = [
    ...new Set(
      CONTAINER_BLOCK_NAMES.map((name) => bot.registry?.blocksByName?.[name]?.id).filter(
        (id: unknown): id is number => typeof id === 'number',
      ),
    ),
  ];
  const block = bot.findBlock({ matching: ids, maxDistance: 4 });
  return block ?? '附近 4 格没有容器：先 goTo 过去，或在参数里给 coords';
}

async function openContainerWindow(bot: any, block: any, context: ActionContext): Promise<any> {
  const name = String(block.name ?? '');
  return bounded(bot.openContainer(block), context, undefined, 10_000, `打开 ${name} 超过 10 秒`);
}

function containerItems(win: any): any[] {
  try {
    const items = typeof win?.containerItems === 'function' ? win.containerItems() : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function formatContainerItems(items: readonly any[]): string {
  if (items.length === 0) return '空';
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item?.name == null) continue;
    counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 1));
  }
  return [...counts.entries()].map(([name, count]) => `${name}×${count}`).join('、');
}

async function withdrawMatching(win: any, bot: any, spec: Array<{ name: string; count: number | null }>, context: ActionContext): Promise<string[]> {
  const done: string[] = [];
  const wanted = spec.length > 0 ? spec : null;
  for (const item of containerItems(win)) {
    if (item?.name == null) continue;
    const match = wanted?.find((entry) => entry.name === item.name || item.name.includes(entry.name));
    if (wanted != null && match == null) continue;
    const count = Math.min(Number(item.count ?? 1), match?.count ?? Number(item.count ?? 1));
    if (!(count > 0)) continue;
    await bounded(win.withdraw(item.type, null, count), context, undefined, 10_000, `从容器取 ${item.name} 超过 10 秒`);
    done.push(`${item.name}×${count}`);
  }
  return done;
}

async function depositMatching(win: any, bot: any, spec: Array<{ name: string; count: number | null }>, context: ActionContext): Promise<string[]> {
  const done: string[] = [];
  if (spec.length === 0) return done;
  for (const entry of spec) {
    const item = bot.inventory.items().find((candidate: any) => candidate.name === entry.name);
    if (item == null) continue;
    const count = Math.min(Number(item.count ?? 1), entry.count ?? Number(item.count ?? 1));
    if (!(count > 0)) continue;
    await bounded(win.deposit(item.type, null, count), context, undefined, 10_000, `往容器放 ${item.name} 超过 10 秒`);
    done.push(`${item.name}×${count}`);
  }
  return done;
}

/** 熔炉烧炼一整轮：校验参数 → 找炉 → 放燃料和原料 → 等产物 → 取走。 */
async function smeltInFurnace(
  bot: any,
  args: Record<string, unknown>,
  context: ActionContext,
  timeoutMs: number,
): Promise<string> {
  const spec = parseItemSpec(args.items);
  if (spec.length !== 1) return 'smelt 需要 items：一种原料，例如 "iron_ore:5"';
  const entry = spec[0];
  const want = Math.min(64, Math.max(1, entry.count ?? 1));
  const input = bot.registry?.itemsByName?.[entry.name];
  if (input == null) return `没有叫 ${entry.name} 的物品`;
  const fuelName = String(args.fuel ?? '')
    .replace(/^minecraft:/, '')
    .trim();
  if (fuelName === '') return 'smelt 需要 fuel：燃料名，比如 coal、charcoal、oak_planks';
  const fuel = bot.inventory.items().find((candidate: any) => candidate.name === fuelName);
  if (fuel == null) return `背包里没有燃料 ${fuelName}`;
  const fuelId = bot.registry?.itemsByName?.[fuelName]?.id ?? fuel.type;
  // 被打断后回来续做：检查点里有熔炉坐标就回现场；没有就重新找。
  const resume = context.resume as { furnace?: { x: number; y: number; z: number } } | null | undefined;
  const resumeAt = resume?.furnace ?? null;
  const block = resumeAt != null ? await walkBackToFurnace(bot, resumeAt, context) : await findOrPlaceFurnace(bot, args.coords, context);
  if (typeof block === 'string') return block;
  const where =
    block.position == null
      ? String(block.name ?? '熔炉')
      : `${block.name} @(${block.position.x},${block.position.y},${block.position.z})`;
  // **预写日志**：先记下现场，再动炉子。Stop 的清理和抢占后的续做都靠它找回来。
  if (resumeAt == null && block.position != null) {
    context.checkpoint({
      op: 'smelt',
      furnace: { x: block.position.x, y: block.position.y, z: block.position.z },
      item: entry.name,
      want,
      fuel: fuelName,
    });
  }
  let win: any = null;
  try {
    win = await bounded(bot.openFurnace(block), context, undefined, 10_000, `打开 ${where} 超过 10 秒`);
    if (resumeAt != null) {
      // 按观测继续，不重放：槽里还有料就不重复投，缺什么补什么。
      if (win.inputItem() == null) await win.putInput(input.id, null, want);
      if (win.fuelItem() == null) await win.putFuel(fuelId, null, fuelCountFor(fuelName, want));
    } else {
      await win.putFuel(fuelId, null, fuelCountFor(fuelName, want));
      await win.putInput(input.id, null, want);
    }
    const deadline = Date.now() + timeoutMs;
    while (!context.signal.aborted && Date.now() < deadline) {
      const output = win.outputItem();
      if (output != null && (output.count >= want || win.inputItem() == null)) break;
      await sleep(500);
    }
    if (context.signal.aborted) return `烧炼 ${entry.name} 被打断（熔炉窗口已关）`;
    const output = win.outputItem();
    if (output == null) return `投入 ${want} 个 ${entry.name}，但输出槽是空的（燃料或时间不够）`;
    const got = output.count;
    const gotName = output.name;
    await win.takeOutput();
    return `烧出 ${got} 个 ${gotName}（投入 ${want} 个 ${entry.name}）`;
  } catch (error: unknown) {
    if (context.signal.aborted) return `烧炼 ${entry.name} 被打断（熔炉窗口已关）`;
    return `烧炼 ${entry.name} 失败：${errorText(error)}`;
  } finally {
    try {
      win?.close?.();
    } catch {
      // 关不掉不影响主流程。
    }
  }
}
/** 回到熔炉旁：已经在 3 格内就直接用，否则寻路过去。返回方块或人话错误。 */
async function walkBackToFurnace(
  bot: any,
  at: { x: number; y: number; z: number },
  context: ActionContext,
): Promise<any | string> {
  const block = bot.blockAt(new Vec3(at.x, at.y, at.z));
  const usable = block != null && FURNACE_BLOCK_NAMES.has(String(block.name ?? ''));
  const position = bot.entity?.position;
  const distance =
    position == null ? 0 : Math.hypot(position.x - at.x, position.y - at.y, position.z - at.z);
  if (usable && distance <= 3) return block;
  if (typeof bot.pathfinder?.goto !== 'function') return '回不到熔炉：没有寻路';
  try {
    await bounded(
      bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, 2)),
      context,
      () => bot.pathfinder?.stop?.(),
      15_000,
      '走回熔炉超时',
    );
  } catch (error: unknown) {
    if (context.signal.aborted) return '回熔炉被中断了';
    return `回不到熔炉：${errorText(error)}`;
  }
  const back = bot.blockAt(new Vec3(at.x, at.y, at.z));
  if (back == null || !FURNACE_BLOCK_NAMES.has(String(back.name ?? ''))) {
    return `(${at.x},${at.y},${at.z}) 已经不是熔炉了`;
  }
  return back;
}

/**
 * **有序停机的清理**：把熔炉三个槽里的东西都取回背包（产物 → 原料 → 燃料），再关窗。
 *
 * 只有 `smelt` 会写检查点（它会把东西留在炉子里）；手动 put/take 不写，所以 Stop
 * 不会去动用户故意存进去的东西。
 */
async function cleanFurnaceOnStop(bot: any, context: ActionContext, checkpoint: unknown): Promise<string> {
  const saved = checkpoint as { op?: string; furnace?: { x: number; y: number; z: number } } | null | undefined;
  // 只有 smelt 会往炉子里投料；put/take 是模型故意的存取，不能被 Stop 清掉。
  if (saved?.op !== 'smelt' || saved.furnace == null) return '';
  const at = saved.furnace;
  const block = await walkBackToFurnace(bot, at, context);
  if (typeof block === 'string') return `熔炉没清：${block}`;
  const taken: string[] = [];
  let win: any = null;
  try {
    win = await bounded(bot.openFurnace(block), context, undefined, 3_000, '打开熔炉超时');
    const takeOne = async (slot: 'output' | 'input' | 'fuel'): Promise<void> => {
      const item = typeof win?.[`${slot}Item`] === 'function' ? win[`${slot}Item`]() : null;
      const take = slot === 'output' ? win.takeOutput : slot === 'input' ? win.takeInput : win.takeFuel;
      if (item == null || typeof take !== 'function') return;
      try {
        await bounded(take.call(win), context, undefined, 3_000, `取${slotLabel(slot)}超时`);
        taken.push(`${item.name}×${item.count}`);
      } catch {
        // 单个槽取不出来就继续取别的；超时/断线会由外层 context 收口。
      }
    };
    await takeOne('output');
    await takeOne('input');
    await takeOne('fuel');
    return taken.length > 0 ? `熔炉已清空（取回 ${taken.join('、')}）` : '熔炉已经是空的';
  } catch (error: unknown) {
    return `熔炉没清完：${errorText(error)}`;
  } finally {
    try {
      win?.close?.();
    } catch {
      // 关不掉不影响主流程。
    }
  }
}
/** 造齐身体原语。Stop / UpdateGoal 不在这里（它们不属于身体）。 */
export function makePrimitives(bot: any, deps: PrimitiveDeps = {}): Record<string, Primitive> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const prims: Record<string, Primitive> = {
    goTo: async (args, context) => {
      const x = Number(args.x);
      const y = Number(args.y);
      const z = Number(args.z);
      const movementSet = deps.movements?.() ?? null;
      if (movementSet != null) bot.pathfinder.setMovements(movementSet.reach);
      const start = bot.entity.position;
      const startText = `(${Math.floor(start.x)},${Math.floor(start.y)},${Math.floor(start.z)})`;
      // 挖到地下水时自动横向换位置再往下（最多换 2 次）：小模型不会自己改坐标。
      let targetX = x;
      let targetZ = z;
      let relocations = 0;
      // 地下/洞穴里挖出来可能比普通走路慢很多；GoTo 是核心工具，给足预算。
      const goToTimeoutMs = Math.max(timeoutMs, 240_000);
      // 深目标（比如从地表下到 y=-59）A* 搜索量很大：20 秒 thinkTimeout 会超时，
      // 而 mineflayer-pathfinder 的 goto() 在"空路径"时是**静默 resolve**（不报错），
      // 表现为"走两步就说到不了"。深目标临时把搜索预算调大，结束后还原。
      const deepTarget = Math.abs(y - start.y) > 24;
      const previousThinkTimeout = bot.pathfinder?.thinkTimeout;
      if (deepTarget && bot.pathfinder != null) {
        bot.pathfinder.thinkTimeout = Math.max(Number(bot.pathfinder.thinkTimeout) || 0, 60_000);
        bot.pathfinder.searchRadius = -1;
      }
      // 深目标：下潜前先确认"往下这段"没有地下水，有就换到附近的干柱子再挖。
      // 等真挖到水里再换就晚了（会被淹进洞穴里出不来）。
      if (deepTarget) {
        const dry = findDryColumn(bot, bot.entity.position, y);
        if (dry != null) {
          targetX = dry.x;
          targetZ = dry.z;
        }
      }
      const deadline = Date.now() + goToTimeoutMs;
      // 长距离分段，避免一次 A* 搜索超时（类似 Baritone 的分段推进）。
      // 深目标不分段：分段目标会落在实心岩层里，A* 经常直接判"无路"（静默 resolve），
      // 反而不如一次搜到最终点；代价是预算要给足。
      let segment = deepTarget ? 1e9 : 24;
      let lastError = '';
      let stalls = 0;
      let waterHit = false;
      const startHealth = Number(bot.health ?? 20);
      let lastHealth = startHealth;
      let healthDropped = false;
      const healthTimer = setInterval(() => {
        const health = Number(bot.health);
        if (Number.isFinite(health)) {
          // 单次小磕碰（≤2 点）不中止：深目标要挖很久，血量包偶尔也会抖一下；
          // 累计掉 3 点以上才认为危险，避免"20 → 20"这种假中止。
          if (health <= startHealth - 3) {
            healthDropped = true;
            try {
              bot.pathfinder.stop();
              bot.stopDigging?.();
            } catch {
              // 停手失败也继续退出，不能继续掉血。
            }
          }
          lastHealth = health;
        }
        // 深目标挖到水里：不等 drown 反射来抢（它一抢就打断当前这段寻路，
        // goTo 永远走不到"换位置"的分支）。这里先把这段寻路停掉，让主循环换位置。
        if (deepTarget && bot.entity?.isInWater === true) {
          const current = bot.entity?.position;
          if (current != null && Math.hypot(current.x - targetX, current.y - y, current.z - targetZ) > 6) {
            waterHit = true;
            try {
              bot.pathfinder.stop();
            } catch {
              // 停不下来就等下一轮。
            }
          }
        }
      }, 100);
      const stopForHealth = (): boolean => healthDropped;

      const cleanupDeep = (): void => {
        clearInterval(healthTimer);
        if (deepTarget && bot.pathfinder != null && previousThinkTimeout != null) {
          bot.pathfinder.thinkTimeout = previousThinkTimeout;
        }
      };

      // 深目标：先走到目标 x/z（当前高度），再竖直逐格下挖；遇水/岩浆就横挪再试。
      if (deepTarget && !context.signal.aborted) {
        let lastFailure = '';
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (context.signal.aborted) break;
          const here = bot.entity.position;
          if (Math.hypot(here.x - targetX, here.z - targetZ) > 3) {
            try {
              await bounded(
                bot.pathfinder.goto(new goals.GoalNear(targetX, Math.round(here.y), targetZ, 2)),
                context,
                () => bot.pathfinder.stop(),
                45_000,
                '走到目标上方超时',
              );
            } catch (error: unknown) {
              if (context.signal.aborted) throw error;
              lastFailure = errorText(error);
            }
            continue;
          }
          const result = await descendShaft(bot, context, y, Math.min(goToTimeoutMs, 420_000));
          const now = bot.entity.position;
          if (result.ok || now.y <= y + 1.5) {
            cleanupDeep();
            return `从 ${startText} 到了 (${Math.floor(now.x)},${Math.floor(now.y)},${Math.floor(now.z)})，目标是 (${Math.floor(now.x)},${y},${Math.floor(now.z)})`;
          }
          if (context.signal.aborted) break;
          lastFailure = result.message;
          targetX = Math.floor(now.x) + (attempt % 2 === 0 ? 8 : -8);
          targetZ = Math.floor(now.z) + (attempt % 2 === 0 ? 8 : -8);
        }
        cleanupDeep();
        return `没走到 (${x},${y},${z})：${lastFailure === '' ? '往下挖没有成功' : `往下挖遇到 ${lastFailure}`}；换了 4 处位置都不行，先 goTo 到别处再挖。`;
      }

      const distTo = (position: { x: number; y: number; z: number }): number =>
        Math.hypot(position.x - targetX, position.y - y, position.z - targetZ);

      try {
        while (!context.signal.aborted && Date.now() < deadline) {
          const current = bot.entity.position;
          const remaining = distTo(current);
          if (remaining <= 1.5) break;
          if (segment < 2) break;
          if (stopForHealth()) break;
          // 深目标挖穿地下水层：越挖越湿，drown 反射会反复把身体抢回去。
          // 先自己换个位置再挖（小模型不会改坐标），换两次还不行才报错。
          if (deepTarget && remaining > 6 && (waterHit || bot.entity?.isInWater === true)) {
            waterHit = false;
            if (relocations < 2) {
              relocations += 1;
              // 优先换到附近"往下这段没水"的柱子；找不到再左右盲挪。
              const dry = findDryColumn(bot, current, y);
              const offset = relocations % 2 === 1 ? 24 : -24;
              targetX = dry != null ? dry.x : Math.round(current.x) + offset;
              targetZ = dry != null ? dry.z : Math.round(current.z);
              stalls = 0;
              segment = 1e9;
              try {
                bot.pathfinder.stop();
              } catch {
                // 停不下来也继续换目标。
              }
              continue;
            }
            return `没走到 (${targetX},${y},${targetZ})：往下挖穿到地下水（y≈${Math.round(current.y)}），继续会反复被淹死。先 goTo 横向 20-30 格换个位置，再从那里往下挖。`;
          }

          const step = Math.min(segment, remaining);
          const fraction = step / remaining;
          const target =
            remaining <= segment
              ? { x: targetX, y, z: targetZ }
              : {
                  x: Math.floor(current.x + (targetX - current.x) * fraction),
                  y: Math.floor(current.y + (y - current.y) * fraction),
                  z: Math.floor(current.z + (targetZ - current.z) * fraction),
                };
          const budget = Math.max(500, Math.min(deepTarget ? 420_000 : 60_000, deadline - Date.now()));
          try {
            await bounded(
              bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)),
              context,
              () => bot.pathfinder.stop(),
              budget,
              `分段寻路 ${Math.round(budget / 1000)} 秒还没到`,
            );
            // 分段成功但实际没靠近（卡住/被挡）：缩小分段再试。
            if (distTo(bot.entity.position) >= remaining - 0.5) {
              stalls += 1;
              segment = Math.max(2, Math.floor(segment / 2));
              if (stalls >= 4) break;
            } else {
              stalls = 0;
            }
          } catch (error: unknown) {
            if (context.signal.aborted) throw error;
            if (healthDropped) break;
            // 自己主动停的（挖到水）：回循环顶部换位置，不要在这里 break。
            if (waterHit) continue;
            lastError = errorText(error);
            // 目标本身就是最终点且失败：没有更多分段可试。
            if (remaining <= segment) break;
            // 长距离分段失败：缩小段长再试。
            stalls += 1;
            segment = Math.max(2, Math.floor(segment / 2));
            if (stalls >= 4) break;
          }
        }
      } catch (error: unknown) {
        return context.signal.aborted
          ? `去 (${targetX},${y},${targetZ}) 的路上被打断了`
          : `没走到 (${targetX},${y},${targetZ})：${errorText(error)}`;
      } finally {
        clearInterval(healthTimer);
        if (deepTarget && bot.pathfinder != null && previousThinkTimeout != null) {
          bot.pathfinder.thinkTimeout = previousThinkTimeout;
        }
      }

      if (healthDropped || Number(bot.health) < startHealth - 1) {
        return `中止 goTo：去 (${targetX},${y},${targetZ}) 的路上掉血了（${startHealth} → ${Math.round(Number(bot.health ?? 0))}），已停手，不再继续走。`;
      }

      const now = bot.entity.position;
      const nowText = `(${Math.floor(now.x)},${Math.floor(now.y)},${Math.floor(now.z)})`;
      const left = distTo(now);
      if (left > 1.5) {
        return `没走到 (${targetX},${y},${targetZ})：从 ${startText} 到 ${nowText}，还差 ${left.toFixed(1)} 格${lastError === '' ? '' : `（${lastError}）`}`;
      }
      return `从 ${startText} 到了 ${nowText}，目标是 (${targetX},${y},${targetZ})`;
    },

    mineBlock: async (args, context) => {
      const position = new Vec3(Number(args.x), Number(args.y), Number(args.z));
      const block = bot.blockAt(position);
      if (block == null) return `(${position.x},${position.y},${position.z}) 看不到（区块没加载或超出范围）`;
      if (block.name === 'air') return `(${position.x},${position.y},${position.z}) 已经是空气`;
      if (block.diggable === false) return `${block.name} 挖不动（需要工具或根本不可破坏）`;
      if (isFootingBlock(bot.entity?.position, block.position)) {
        return `没有挖 ${block.name}（${position.x},${position.y},${position.z}）：它是你脚下的承重方块，挖了会掉下去。`;
      }

      // mineflayer 的 dig 只等本地计时，不校验距离：服务器因超距不破坏时
      // 本地会假装挖掉并 resolve。先挡掉明显够不着的目标。
      const eye = bot.entity?.position;
      if (eye != null) {
        const reach = Math.hypot(position.x + 0.5 - eye.x, position.y + 0.5 - eye.y, position.z + 0.5 - eye.z);
        if (reach > 4.5) return `离 (${position.x},${position.y},${position.z}) 有 ${reach.toFixed(1)} 格，太远够不着；先 goTo 过去`;
      }

      const force = args.force === true;
      // **先换上能收获它的工具**：裸 dig 用错工具会"挖掉但没掉落"。
      await ensureHarvestTool(bot, block);
      const plan = planDig(bot, block, force);
      if (!plan.ok) return plan.note;

      try {
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bounded(
          bot.dig(block),
          context,
          () => bot.stopDigging?.(),
          timeoutMs,
          `挖 ${timeoutSeconds} 秒还没挖开`,
        );
      } catch (error: unknown) {
        if (context.signal.aborted) return `挖 ${block.name} 被中断了`;
        return `没挖动 ${block.name}（${position.x},${position.y},${position.z}）：${errorText(error)}`;
      }
      const picked = await pickupDrops(bot, context);
      return `挖掉了 ${block.name}（${position.x},${position.y},${position.z}${force ? '，force' : ''}），手上是 ${bot.heldItem?.name ?? '空手'}${picked > 0 ? `，捡了 ${picked} 处掉落物` : ''}`;
    },

    placeBlock: async (args, context) => {
      const name = String(args.type);
      const position = new Vec3(Number(args.x), Number(args.y), Number(args.z));
      const target = bot.blockAt(position);
      if (target == null) return `(${position.x},${position.y},${position.z}) 看不到（区块没加载）`;
      const replaceable =
        target.boundingBox === 'empty' ||
        ['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass'].includes(String(target.name));
      if (!replaceable) return `(${position.x},${position.y},${position.z}) 已经有 ${target.name}，不能再放`;

      const key = name.replace(/^minecraft:/, '');
      const item = bot.inventory
        .items()
        .find((entry: any) => entry.name === name || entry.name === key);
      if (item == null) return `背包里没有 ${name}`;

      // 找可依附的面：优先脚下，其次四周，最后头顶。只对“实心方块”放。
      const offsets: Array<{ dx: number; dy: number; dz: number; face: any }> = [
        { dx: 0, dy: -1, dz: 0, face: new Vec3(0, 1, 0) },
        { dx: 0, dy: 1, dz: 0, face: new Vec3(0, -1, 0) },
        { dx: -1, dy: 0, dz: 0, face: new Vec3(1, 0, 0) },
        { dx: 1, dy: 0, dz: 0, face: new Vec3(-1, 0, 0) },
        { dx: 0, dy: 0, dz: -1, face: new Vec3(0, 0, 1) },
        { dx: 0, dy: 0, dz: 1, face: new Vec3(0, 0, -1) },
      ];
      const found = offsets
        .map((offset) => {
          const ref = bot.blockAt(new Vec3(position.x + offset.dx, position.y + offset.dy, position.z + offset.dz));
          return ref == null ? null : { ref, face: offset.face };
        })
        .find((entry) => entry != null && entry.ref.name !== 'air' && entry.ref.boundingBox === 'block');
      if (found == null) return `(${position.x},${position.y},${position.z}) 周围没有可依附的实心方块，放不了 ${name}`;

      try {
        await bot.equip(item, 'hand');
        await abortable(bot.placeBlock(found.ref, found.face), context, () => bot.stopDigging?.());
      } catch (error: unknown) {
        if (context.signal.aborted) return `放 ${name} 被中断了`;
        return `没放成 ${name}：${errorText(error)}`;
      }
      // 回读：放置是服务器仲裁的，本地 resolve 不等于真的放下。
      const after = bot.blockAt(position);
      const actual = after?.name ?? '未知';
      if (after == null || (actual !== name && actual !== key)) {
        return `尝试把 ${name} 放到 (${position.x},${position.y},${position.z})，但回读是 ${actual}`;
      }
      return `在 (${position.x},${position.y},${position.z}) 放了 ${name}（回读 ${actual}）`;
    },

    useBlock: async (args, context) => {
      const position = new Vec3(Number(args.x), Number(args.y), Number(args.z));
      const block = bot.blockAt(position);
      if (block == null) return `(${position.x},${position.y},${position.z}) 看不到（区块没加载或超出范围）`;
      // 打开的容器窗口要立刻关掉：否则后续背包操作会点到容器里。
      const closeOpened = (window: any): void => {
        try {
          bot.closeWindow(window);
        } catch {
          // 关不掉也不影响。
        }
      };
      if (typeof bot.once === 'function') bot.once('windowOpen', closeOpened);
      try {
        await abortable(bot.activateBlock(block), context);
      } catch (error: unknown) {
        if (context.signal.aborted) return `右键 ${block.name} 被中断了`;
        return `右键 ${block.name} 失败：${errorText(error)}`;
      } finally {
        closeContainer(bot);
      }
      return `右键了 ${block.name}（${position.x},${position.y},${position.z}）`;
    },

    collectBlock: async (args, context) => {
      const name = String(args.type).replace(/^minecraft:/, '');
      const want = Math.min(64, Math.max(1, Number(args.count ?? 1)));
      const scope = String(args.scope ?? 'near');
      if (scope !== 'near' && scope !== 'loaded') return 'collectBlock 的 scope 只能是 near（默认，按半径扫）或 loaded（扫所有已加载区块）';
      const loadedScope = scope === 'loaded';
      const radius = Math.max(8, Math.min(128, Math.floor(Number(args.radius ?? 32) || 32)));
      const prior = Number((context.resume as { got?: number } | undefined)?.got ?? 0);
      const remaining = Math.max(0, want - prior);
      if (remaining === 0) return `收集 ${name}：已经够了（${prior}/${want}）`;
      const targets = loadedScope
        ? nearestBlocksLoaded(bot, name, remaining)
        : nearestBlocks(bot, name, remaining, radius);
      if (targets.length === 0) {
        return prior > 0
          ? `收集 ${name}：已经收了 ${prior} 个，附近没有更多了`
          : loadedScope
            ? `已加载区块内没找到 ${name}`
            : `附近 ${radius} 格内没找到 ${name}（只扫描已加载区块）`;
      }

      // **不把寻路+挖矿+捡起全交给 collectblock 插件**：真机上插件对“石头”
      // 目标会把 pathfinder 拖成内存炸弹（1GB/20 秒，进程 OOM 退出）。这里
      // 自己走：通常步行靠近 → 换收获工具 → dig → 捡；每一步都有超时/取消。
      // 水里挖矿会被 drown 反射反复打断，掉落还会沉水里：先把人挪到干的地方。
      if (bot.entity?.isInWater === true) {
        return `收集 ${name}：你正在水里，先 goTo 到干的岸上，再从那里挖。`;
      }
      // 紧挨着水的方块先跳过：挖开等于自己放水淹自己。
      const dryTargets = targets.filter((target: any) => {
        const block = bot.blockAt(target.position);
        if (block == null) return false;
        if (isWaterBlockName(String(block.name))) return false;
        for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          const base = block.position;
          const neighborPos = typeof base?.offset === 'function' ? base.offset(dx, dy, dz) : new Vec3(base.x + dx, base.y + dy, base.z + dz);
          const neighbor = bot.blockAt(neighborPos);
          if (neighbor != null && isWaterBlockName(String(neighbor.name))) return false;
        }
        return true;
      });
      if (dryTargets.length === 0) {
        return `收集 ${name}：附近 ${targets.length} 个目标都紧挨着地下水（挖开会被淹），先 goTo 到别处再挖。`;
      }
      const safeTargets = dryTargets;
      const dropNames = blockDropNames(bot, name);
      const countDrops = (): number => dropNames.reduce((sum, drop) => sum + countInventory(bot, drop), 0);
      const before = countDrops();
      let got = prior;
      const movementSet = deps.movements?.() ?? null;
      if (movementSet != null) bot.pathfinder.setMovements(movementSet.reach);
      try {
        await bounded(
          (async () => {
            for (const target of safeTargets) {
              if (context.signal.aborted || got >= want) break;
              const block = bot.blockAt(target.position);
              if (block == null || block.name === 'air') continue;
              try {
                await bounded(
                  bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1.5)),
                  context,
                  () => bot.pathfinder.stop?.(),
                  30_000,
                  `走向 ${name} 超过 30 秒`,
                );
              } catch {
                if (context.signal.aborted) throw new Error('aborted');
                continue; // 够不着就换下一个目标
              }
              await ensureHarvestTool(bot, block);
              const plan = planDig(bot, block, false);
              if (!plan.ok) throw new Error(plan.note);
              try {
                await bounded(
                  bot.dig(block),
                  context,
                  () => bot.stopDigging?.(),
                  timeoutMs,
                  `挖 ${name} 超过 ${timeoutSeconds} 秒`,
                );
              } catch {
                if (context.signal.aborted) throw new Error('aborted');
                continue;
              }
              await pickupDrops(bot, context, { radius: 6, budgetMs: 2_000 });
              got = Math.max(got, prior + (countDrops() - before));
              context.checkpoint({ got });
            }
          })(),
          context,
          () => {
            bot.collectBlock?.cancelTask?.();
            bot.pathfinder.stop?.();
            bot.stopDigging?.();
          },
          6 * 60_000,
          `收集 ${name} 超过 6 分钟`,
        );
      } catch (error: unknown) {
        if (context.signal.aborted) return `收集 ${name} 被打断（进度 ${got}/${want} 已上报）`;
        return `收集 ${name} 失败：${errorText(error)}（进度 ${got}/${want}）`;
      } finally {
        if (movementSet != null) bot.pathfinder.setMovements(movementSet.reach);
      }
      const finalGot = Math.max(got, prior + (countDrops() - before));
      if (finalGot !== got) context.checkpoint({ got: finalGot });
      const picked = await pickupDrops(bot, context);
      const drops = dropNames.join('、');
      return `收集 ${name}：掉了 ${drops}，本次新增 ${Math.max(0, finalGot - prior)} 个，累计 ${finalGot}/${want}${picked > 0 ? `，捡了 ${picked} 处掉落物` : ''}`;
    },

    placeHere: async (args, context) => {
      const name = String(args.type).replace(/^minecraft:/, '');
      const pos = bot.entity?.position;
      if (pos == null) return '读不到当前位置，放不了';
      const cell = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
      const target = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
      if (target == null) return `(${cell.x},${cell.y},${cell.z}) 看不到方块`;
      const replaceable =
        target.boundingBox === 'empty' ||
        ['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass'].includes(String(target.name));
      if (!replaceable) return `脚下 (${cell.x},${cell.y},${cell.z}) 已经有 ${target.name}，放不了 ${name}`;
      const reference = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z));
      if (reference == null || reference.name === 'air' || reference.boundingBox !== 'block') {
        return `脚下 (${cell.x},${cell.y},${cell.z}) 下方没有可依附的实心方块，放不了 ${name}`;
      }
      const item = bot.inventory.items().find((entry: any) => entry.name === name);
      if (item == null) return `背包里没有 ${name}`;
      try {
        await bot.equip(item, 'hand');
        await bounded(bot.placeBlock(reference, new Vec3(0, 1, 0)), context, () => bot.stopDigging?.(), 10_000, `放 ${name} 超过 10 秒`);
      } catch (error: unknown) {
        if (context.signal.aborted) return `放 ${name} 被中断了`;
        return `没放成 ${name}：${errorText(error)}`;
      }
      const after = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
      const actual = after?.name ?? '未知';
      return `尝试在脚下 (${cell.x},${cell.y},${cell.z}) 放 ${name}，回读是 ${actual}（身体所在格，服务器可能拒绝）`;
    },

    container: async (args, context) => {
      const op = String(args.op ?? '');
      if (!['inspect', 'loot', 'take', 'put'].includes(op)) {
        return 'container 的 op 只能是 inspect / loot / take / put';
      }
      const block = findContainerBlock(bot, args);
      if (typeof block === 'string') return block;
      let win: any = null;
      try {
        win = await openContainerWindow(bot, block, context);
        const where = `${block.name} @(${block.position.x},${block.position.y},${block.position.z})`;
        if (op === 'inspect') {
          return `${where} 的内容：${formatContainerItems(containerItems(win))}`;
        }
        if (op === 'loot') {
          const done = await withdrawMatching(win, bot, [], context);
          return `${where} 取走：${done.length > 0 ? done.join('、') : '没有可取的物品'}；剩余：${formatContainerItems(containerItems(win))}`;
        }
        if (op === 'take') {
          const spec = parseItemSpec(args.items);
          if (spec.length === 0) return 'take 需要 items，例如 "iron_ingot:5, dirt"';
          const done = await withdrawMatching(win, bot, spec, context);
          return `${where} 取走：${done.length > 0 ? done.join('、') : '没找到指定物品'}；剩余：${formatContainerItems(containerItems(win))}`;
        }
        if (op === 'put') {
          const spec = parseItemSpec(args.items);
          if (spec.length === 0) return 'put 需要 items，例如 "iron_ore:5, coal"';
          const done = await depositMatching(win, bot, spec, context);
          return `${where} 放入：${done.length > 0 ? done.join('、') : '背包里没有指定物品'}；容器现在是：${formatContainerItems(containerItems(win))}`;
        }
        // 上面四个 op 已经各自 return；这行只为让类型收窄，不会执行。
        return 'container 的 op 只能是 inspect / loot / take / put';
      } catch (error: unknown) {
        if (context.signal.aborted) return `容器操作 ${op} 被中断了`;
        return `容器操作 ${op} 失败：${errorText(error)}`;
      } finally {
        try {
          win?.close?.();
        } catch {
          // 关不掉不影响主流程。
        }
      }
    },

    craft: async (args, context) => {
      const name = String(args.item).replace(/^minecraft:/, '');
      const count = Math.max(1, Number(args.count ?? 1));
      const item = bot.registry?.itemsByName?.[name];
      if (item == null) {
        // 小模型常把名字写成复数/近似词：给一个候选，别让它在一个错名字上反复撞。
        const stem = name.replace(/s$/, '');
        const candidates = Object.keys(bot.registry?.itemsByName ?? {})
          .filter((candidate) => stem.length >= 3 && candidate.includes(stem))
          .slice(0, 3);
        return `没有叫 ${name} 的物品${candidates.length > 0 ? `；是不是 ${candidates.join(' / ')}？` : ''}`;
      }
      const before = countInventory(bot, name);
      // 没有工作台也没带工作台：先做一个（2×2 不需要工作台），findCraftingTable 会把它放下。
      const tableItemName = 'crafting_table';
      if (name !== tableItemName) {
        const hasTableItem = (() => {
          try {
            return bot.inventory.items().some((entry: any) => entry?.name === tableItemName);
          } catch {
            return false;
          }
        })();
        const tableBlockId = bot.registry?.blocksByName?.[tableItemName]?.id;
        const tableNearby = (() => {
          try {
            return tableBlockId != null && bot.findBlock({ matching: tableBlockId, maxDistance: 4 }) != null;
          } catch {
            return false;
          }
        })();
        const tableDef = bot.registry?.itemsByName?.[tableItemName];
        if (!hasTableItem && !tableNearby && tableDef != null) {
          const tableRecipes = discoverRecipes(bot, tableDef.id, null);
          if (tableRecipes.length > 0) {
            try {
              await ensureCraftMaterials(bot, tableDef.id, 1, null, context, 0, []);
              const tableRecipe = pickRecipe(bot, tableRecipes, 1, null);
              if (tableRecipe != null) await bot.craft(tableRecipe, 1, null);
            } catch {
              // 做不出来就按"没有工作台"处理，下面照常报错。
            }
          }
        }
      }
      const placeTable = (reference: any): Promise<void> =>
        abortable(bot.placeBlock(reference, new Vec3(0, 1, 0)), context);
      let table = await findCraftingTable(bot, placeTable);
      if (table == null && typeof bot.pathfinder?.goto === 'function') {
        // 附近 16 格内有工作台就自己走过去：小模型不会规划"先走到工作台再合成"。
        const tableId = bot.registry?.blocksByName?.crafting_table?.id;
        const nearby = tableId == null ? null : bot.findBlock({ matching: tableId, maxDistance: 16 });
        if (nearby != null) {
          try {
            await bounded(
              bot.pathfinder.goto(new goals.GoalNear(nearby.position.x, nearby.position.y, nearby.position.z, 2)),
              context,
              () => bot.pathfinder?.stop?.(),
              20_000,
              '走向工作台超时',
            );
          } catch {
            // 走不到就按"没有工作台"处理。
          }
          if (!context.signal.aborted) table = await findCraftingTable(bot, placeTable);
        }
      }
      // 先把缺的中间材料（木板/木棍）补出来：4B 模型不会自己规划这一步。
      const prepared: string[] = [];
      try {
        await ensureCraftMaterials(bot, item.id, count, table, context, 0, prepared);
      } catch {
        // 补材料失败不阻断主流程。
      }
      let recipes = bot.recipesFor(item.id, null, 1, table);
      if (recipes.length === 0) {
        // 背包/界面刚变化时 mineflayer 的配方缓存会晚一拍：等一下再算一次。
        await sleep(100);
        recipes = bot.recipesFor(item.id, null, 1, table);
      }
      if (recipes.length === 0) {
        return `做不出 ${name}：${diagnoseCraftFailure(bot, item.id, count, table)}`;
      }
      // mineflayer 的 craft 参数是"合成次数"，不是产出个数：一个配方产 4 个就只做 1 次。
      const picked = pickRecipe(bot, recipes, count, table) ?? recipes[0];
      const perCraft = Math.max(1, Number(picked?.result?.count ?? 1));
      const times = Math.ceil(count / perCraft);
      try {
        await bounded(
          bot.craft(picked, times, table),
          context,
          undefined,
          timeoutMs,
          `合成 ${timeoutSeconds} 秒还没完成`,
        );
      } catch (error: unknown) {
        if (context.signal.aborted) return `合成 ${name} 被中断了`;
        return `合成 ${name} 失败：${errorText(error)}`;
      }
      // 回执必须以后背包里的产物为准：mineflayer 的 craft resolve 只代表动作结束，
      // 不代表服务器已经把产物放进背包（曾出现“回执成功、材料没了、产物没有”）。
      const expected = times * perCraft;
      const verifyDeadline = Date.now() + 5_000;
      let after = before;
      while (Date.now() < verifyDeadline) {
        after = countInventory(bot, name);
        // 等足额再判：服务器入包可能晚一拍，早判会把"做了两次"报成"只做了一次"。
        if (after - before >= expected) break;
        await sleep(50);
      }
      const delta = after - before;
      if (delta <= 0) {
        return `合成失败：动作结束了，但背包里 ${name} 没有增加（${before} → ${after}）。材料可能已被消耗，先看本轮快照里的背包确认，再决定是否重试。`;
      }
      if (delta < expected) {
        return `合成不完整：期望 ${name}×${expected}，背包只从 ${before} 增到 ${after}（+${delta}）。先看本轮快照里的背包确认剩余材料。`;
      }
      const preparedNote = prepared.length > 0 ? `（自动补材料：${prepared.join('、')}）` : '';
      return `合成了 ${name}×${delta}；背包里 ${name} 从 ${before} 个变成 ${after} 个${preparedNote}`;
    },

    furnace: async (args, context) => {
      const op = String(args.op ?? '');
      if (!['read', 'put', 'take', 'smelt'].includes(op)) return 'furnace 的 op 只能是 read / put / take / smelt';
      if (op === 'smelt') return smeltInFurnace(bot, args, context, timeoutMs);
      // take 不给 slot 时取产物槽（最常见的诉求）；put 必须点名 input/fuel。
      // 参数校验放在找方块之前：参数错了就不该去开窗口。
      const slot = String(args.slot ?? (op === 'take' ? 'output' : ''));
      if (op === 'put' && slot !== 'input' && slot !== 'fuel') return 'put 需要 slot：input（原料槽）或 fuel（燃料槽）；产物槽只能取';
      if (op === 'take' && slot !== 'input' && slot !== 'fuel' && slot !== 'output') return 'take 的 slot 只能是 input / fuel / output';
      const block = await findOrPlaceFurnace(bot, args.coords, context);
      if (typeof block === 'string') return block;
      const where =
        block.position == null
          ? String(block.name ?? '熔炉')
          : `${block.name} @(${block.position.x},${block.position.y},${block.position.z})`;
      // put 会被自动续做；但"放了几份"没法从炉子外面确认，所以不重放——先让模型看一眼。
      if (op === 'put' && context.resume != null) {
        return '这一轮被打断了，不确定放进去几份：先用 furnace read 看一眼，再决定要不要补';
      }
      if (op === 'put' && block.position != null) {
        context.checkpoint({ op: 'put', furnace: { x: block.position.x, y: block.position.y, z: block.position.z } });
      }
      let win: any = null;
      try {
        win = await bounded(bot.openFurnace(block), context, undefined, 10_000, `打开 ${where} 超过 10 秒`);
        const readSlot = (name: string): any => {
          try {
            return win?.[`${name}Item`]?.() ?? null;
          } catch {
            return null;
          }
        };
        if (op === 'read') {
          const bits = ['input', 'fuel', 'output'].map((name) => `${slotLabel(name)} ${itemText(readSlot(name))}`);
          const ready = readSlot('input') != null && readSlot('fuel') != null;
          return `${where}：${bits.join('；')}${ready ? '；原料和燃料都有，可以烧' : ''}`;
        }
        if (op === 'put') {
          const spec = parseItemSpec(args.items);
          if (spec.length === 0) return 'put 需要 items，例如 "coal:8"';
          const done: string[] = [];
          for (const entry of spec) {
            const item = bot.inventory.items().find((candidate: any) => candidate.name === entry.name);
            if (item == null) continue;
            const count = Math.min(Number(item.count ?? 1), entry.count ?? Number(item.count ?? 1));
            if (!(count > 0)) continue;
            const put = slot === 'input' ? win.putInput : win.putFuel;
            if (typeof put !== 'function') return `${where} 这个窗口不支持写入${slotLabel(slot)}`;
            await bounded(
              put.call(win, item.type, null, count),
              context,
              undefined,
              10_000,
              `往${slotLabel(slot)}放 ${entry.name} 超过 10 秒`,
            );
            done.push(`${entry.name}×${count}`);
          }
          return `${where} 放入${slotLabel(slot)}：${done.length > 0 ? done.join('、') : '背包里没有指定物品'}`;
        }
        // op === 'take'
        const take = slot === 'output' ? win.takeOutput : slot === 'input' ? win.takeInput : win.takeFuel;
        const before = readSlot(slot);
        if (before == null) return `${where}${slotLabel(slot)}是空的`;
        if (typeof take !== 'function') return `${where} 这个窗口不支持取${slotLabel(slot)}`;
        await bounded(take.call(win), context, undefined, 10_000, `取${slotLabel(slot)}超过 10 秒`);
        return `从 ${where} 取走${slotLabel(slot)} ${itemText(before)}`;
      } catch (error: unknown) {
        if (context.signal.aborted) return `熔炉 ${op} 被中断了`;
        return `熔炉 ${op} 失败：${errorText(error)}`;
      } finally {
        try {
          win?.close?.();
        } catch {
          // 关不掉不影响主流程。
        }
      }
    },
    attack: async (args, context) => {
      // 旧 attack 的 target/type 语义：可以按实体 id、名字、类型选目标。
      const rawId = Number(args.entityId);
      let target: any | null = null;
      let lockedText = '';
      if (Number.isFinite(rawId)) {
        target = bot.entities[rawId] ?? null;
        lockedText = target == null ? `看不到实体 #${rawId}` : `锁定实体 #${rawId} ${target.name ?? ''}`;
      } else if (typeof args.target === 'string' && args.target.trim() !== '') {
        const resolved = resolveAttackTarget(bot, args.target, typeof args.type === 'string' ? args.type : undefined);
        target = resolved.entity;
        lockedText = resolved.message;
      } else {
        return 'attack 需要 entityId，或者 target（实体名字/类型）';
      }
      if (target == null) return lockedText;

      const targetKey = String(target.id ?? '');
      const name = target.name ?? targetKey;
      const movementSet = deps.movements?.() ?? null;
      if (movementSet != null) bot.pathfinder.setMovements(movementSet.reach);

      // 先换最好的剑：空手砍怪等于给怪送时间。
      const best = pickWeapon(bot.inventory.items());
      if (best != null && bot.heldItem?.name !== best) {
        const item = bot.inventory.items().find((entry: any) => entry.name === best);
        if (item != null) await bot.equip(item, 'hand').catch(() => undefined);
      }

      // custom-pvp 全套：swordpvp 近战 + bowpvp 远程都已加载；攻击入口走 swordpvp。
      const pvp = (bot as any).swordpvp;
      let pvpStarted = false;
      if (pvp?.attack != null) {
        try {
          if (bot.heldItem?.name) pvp.weaponOfChoice = bot.heldItem.name;
          await pvp.attack(target);
          pvpStarted = true;
        } catch (error: unknown) {
          // 插件起不来就退回基础近战，不让一次攻击直接失败。
          pvpStarted = false;
        }
      }

      try {
        const deadline = Date.now() + 90_000;
        let goneStreak = 0;
        let teleports = 0;
        let killed = false;
        while (Date.now() < deadline && !context.signal.aborted) {
          const current = (bot.entities as any)[targetKey];
          const health = Number(current?.health);
          if (Number.isFinite(health) && health <= 0) {
            killed = true;
            break;
          }
          if (current == null || current.isValid === false) {
            goneStreak += 1;
            // 瞬移出扫描范围不是死：连续 2 轮都看不到才算击杀。
            if (goneStreak >= 2) {
              killed = true;
              break;
            }
          } else {
            if (goneStreak > 0) teleports += 1;
            goneStreak = 0;
            if (!pvpStarted) {
              // 没有 custom-pvp 的基础近战路径。
              if (bot.entity.position.distanceTo(current.position) > 3) {
                await abortable(bot.pathfinder.goto(new goals.GoalFollow(current, 2)), context, () =>
                  bot.pathfinder.stop(),
                ).catch(() => undefined);
              }
              lookAtEntity(bot, current);
              await bot.attack(current).catch(() => undefined);
            }
          }
          await sleep(pvpStarted ? 500 : 600);
        }
        if (context.signal.aborted) return `打 ${name}#${targetKey} 被打断`;
        if (!killed) return `打了 ${name}#${targetKey} 90 秒，它还活着`;
        const picked = await pickupDrops(bot, context);
        const via = pvpStarted ? 'custom-pvp' : '基础近战';
        const teleportNote = teleports > 0 ? `（它中途瞬移了 ${teleports} 次）` : '';
        return `${lockedText}；用 ${via} 打死了 ${name}#${targetKey}${teleportNote}${picked > 0 ? `，捡了 ${picked} 处掉落物` : ''}`;
      } finally {
        // 无论完成、超时还是被抢占，都要把 pvp 的追击/自动攻击停掉。
        stopPvp(bot);
      }
    },

    inventory: async (args, context) => {
      const op = String(args.op ?? '');
      if (op !== 'equip' && op !== 'consume' && op !== 'discard') {
        return `不认识的背包操作：${op}（能用的有 equip / consume / discard；背包每轮都在快照里）`;
      }
      // 先关掉可能开着的容器窗口，否则点的是容器槽位而不是背包。
      closeContainer(bot);

      // equip 用槽位号（快照里的 [n]）或物品名；没给清楚就明确报错，
      // 不要默默"清空主手"——小模型常把槽位写进 descriptions，会被这个坑到。
      let slot = Number(args.slot);
      let item = Number.isFinite(slot) ? bot.inventory.slots[slot] : null;
      const wantedName =
        typeof (args.item ?? args.name) === 'string'
          ? String(args.item ?? args.name).replace(/^minecraft:/, '')
          : '';
      if (item == null && wantedName !== '') {
        item = bot.inventory.items().find((entry: any) => entry?.name === wantedName) ?? null;
        slot = Number(item?.slot);
      }
      if (op === 'equip' && item == null && wantedName === '') {
        // 不指定物品 = 把背包里的盔甲整套穿上：小模型经常记不住 slot 参数，
        // 让它用最省事的写法拿到正确结果。
        const worn: string[] = [];
        for (const suffix of ['_helmet', '_chestplate', '_leggings', '_boots']) {
          const gear = bot.inventory.items().find((entry: any) => typeof entry?.name === 'string' && entry.name.endsWith(suffix));
          if (gear == null) continue;
          try {
            await bot.equip(gear, bodyPartForItem(String(gear.name)));
            worn.push(String(gear.name));
          } catch {
            // 穿不上就试下一件。
          }
        }
        return worn.length > 0 ? `穿上了：${worn.join('、')}` : '背包里没有可穿的盔甲（头盔/胸甲/护腿/靴子）';
      }
      if (op === 'equip' && item == null) {
        return `背包里没有 ${wantedName}（用快照里物品名和 [n] 槽位号再试）`;
      }
      if (item == null) return `背包槽位 ${String(args.slot)} 没有东西（槽位号见每轮快照里物品前面的 [n]）`;
      try {
        if (op === 'equip') {
          const part = bodyPartForItem(String(item.name));
          if (part === 'hand' && Number(bot.heldItem?.slot) === slot) {
            return `[${slot}] ${item.name} 已经拿在手上，不用再换`;
          }
          await bot.equip(item, part);
          const where =
            part === 'head' ? '头上' : part === 'torso' ? '身上' : part === 'legs' ? '腿上' : part === 'feet' ? '脚上' : part === 'off-hand' ? '副手' : '手上';
          return `把 [${slot}] ${item.name} 装备到了${where}`;
        }
        if (op === 'consume') {
          await bot.equip(item, 'hand');
          await abortable(bot.consume(), context);
          return `吃/喝了 [${slot}] ${item.name}`;
        }
        // discard：默认整叠；给了 count 就只丢指定数量。
        const have = Math.max(1, Number(item.count ?? 1));
        const wanted = args.count == null ? have : Math.max(1, Math.min(have, Math.floor(Number(args.count))));
        if (wanted >= have) {
          await abortable(bot.tossStack(item), context);
          markDiscarded(bot.entity?.position);
          return `丢掉了 [${slot}] ${item.name}×${have}`;
        }
        if (typeof bot.clickWindow !== 'function') {
          return `[${slot}] ${item.name} 有 ${have} 个，这个客户端不支持只丢 ${wanted} 个；整叠没动`;
        }
        await abortable(
          (async () => {
            await bot.clickWindow(slot, 0, 0);
            for (let i = 0; i < wanted; i += 1) await bot.clickWindow(-999, 1, 0);
            await bot.clickWindow(slot, 0, 0);
          })(),
          context,
        );
        markDiscarded(bot.entity?.position);
        return `从 [${slot}] 丢了 ${wanted} 个 ${item.name}（原来 ${have} 个）`;
      } catch (error: unknown) {
        if (context.signal.aborted) return `${op} [${item.slot}] ${item.name} 被中断了`;
        return `${op} [${item.slot}] ${item.name} 失败：${errorText(error)}`;
      }
    },
  };
  // 有序停机的清理钩子：只有"会把东西留在外部世界"的动作需要它。
  prims.furnace.stop = (context, checkpoint) => cleanFurnaceOnStop(bot, context, checkpoint);
  return prims;
}
