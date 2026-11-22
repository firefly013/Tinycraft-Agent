/**
 * 建造规划器：蓝图方块 + 世界现状 → 有序的放置步骤。
 *
 * 纯函数：不碰 mineflayer、不碰文件、不发命令。执行器只负责照着步骤做，
 * 所以“放哪、靠哪一面、要不要先挖、缺什么材料”这些判断都能离线测试。
 *
 * 排序：从下往上。同一层按 z、x 排——先有地基，再有墙，最后才是屋顶。
 */
import type { EmitBlock } from './mcbuild.ts';

export interface WorldCell {
  /** 方块状态串，形如 `minecraft:oak_stairs[facing=east]`。 */
  state: string;
  solid: boolean;
}

export interface WorldView {
  /** null = 这个坐标还没加载，规划器不猜。 */
  at(x: number, y: number, z: number): WorldCell | null;
}

export interface PlacementStep {
  x: number;
  y: number;
  z: number;
  state: string;
  item: string;
  /** 目标位置现有方块不同，要先挖掉。 */
  clear: boolean;
  /** 依附的实心邻格——执行器要走到能点到这一面的位置。 */
  face: { x: number; y: number; z: number };
}

export interface SkippedBlock {
  x: number;
  y: number;
  z: number;
  state: string;
  reason: string;
}

export interface MissingItem {
  item: string;
  need: number;
  have: number;
}

export interface BuildPlan {
  steps: PlacementStep[];
  skipped: SkippedBlock[];
  missing: MissingItem[];
  counts: {
    /** 蓝图里的方块数。 */
    planned: number;
    /** 需要放的（不含已经对的）。 */
    toPlace: number;
    /** 需要先挖的。 */
    toDig: number;
    /** 已经符合、跳过不做的。 */
    satisfied: number;
    skipped: number;
    missing: number;
  };
}

export interface BuildPlanOptions {
  world: WorldView;
  /** 背包：物品 id → 数量。 */
  inventory: Record<string, number>;
  /** 目标位置这个方块能不能挖；默认非空气、非液体都能挖。 */
  diggable?: (cell: WorldCell) => boolean;
}

const AIR = new Set(['minecraft:air', 'air', 'minecraft:cave_air', 'minecraft:void_air']);
const LIQUID = new Set(['minecraft:water', 'water', 'minecraft:lava', 'lava']);

export function isAirState(state: string): boolean {
  return AIR.has(state) || AIR.has(`minecraft:${state}`);
}

function parseState(state: string): { name: string; props: Record<string, string> } {
  const text = state.replace(/^minecraft:/, '');
  const open = text.indexOf('[');
  if (open < 0) return { name: text, props: {} };
  const props: Record<string, string> = {};
  const body = text.slice(open + 1, text.endsWith(']') ? -1 : undefined);
  for (const pair of body.split(',')) {
    const [key, value] = pair.split('=');
    if (key != null && value != null) props[key] = value;
  }
  return { name: text.slice(0, open), props };
}

/**
 * 现有状态是否已经满足目标状态。
 *
 * 目标里写了的属性必须一致；目标没写的属性不比较（游戏会补默认值，比如楼梯的
 * `half` / `shape`，emit 出来的状态串通常只带 `facing`）。
 */
export function satisfiesState(actual: string, target: string): boolean {
  const a = parseState(actual);
  const t = parseState(target);
  if (a.name !== t.name) return false;
  return Object.entries(t.props).every(([key, value]) => a.props[key] === value);
}

/** 墙面/挂墙变体：物品和方块不同名，这里只列真实会遇到的。 */
const ITEM_ALIASES: Readonly<Record<string, string>> = {
  'redstone_wall_torch': 'redstone_torch',
  'soul_wall_torch': 'soul_torch',
  'wall_torch': 'torch',
};

/** 方块状态串 → 物品 id（去掉命名空间与属性）。 */
export function itemForState(state: string): string {
  const name = state.replace(/^minecraft:/, '').split('[')[0];
  if (ITEM_ALIASES[name] != null) return ITEM_ALIASES[name];
  // oak_wall_sign → oak_sign；oak_wall_banner → oak_banner
  if (name.endsWith('_wall_sign')) return `${name.slice(0, -'_wall_sign'.length)}_sign`;
  if (name.endsWith('_wall_banner')) return `${name.slice(0, -'_wall_banner'.length)}_banner`;
  return name;
}

const NEIGHBORS: readonly { x: number; y: number; z: number }[] = [
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
];

function defaultDiggable(cell: WorldCell): boolean {
  if (AIR.has(cell.state)) return true;
  if (LIQUID.has(cell.state)) return false;
  return !cell.state.includes('bedrock');
}

/** 蓝图方块 → 建造计划。`blocks` 来自 `mc-build emit` 的方块清单（世界坐标）。 */
export function planBuild(blocks: readonly EmitBlock[], options: BuildPlanOptions): BuildPlan {
  const diggable = options.diggable ?? defaultDiggable;
  const required = new Map<string, number>();
  const steps: PlacementStep[] = [];
  const skipped: SkippedBlock[] = [];
  let satisfied = 0;
  let toDig = 0;

  const ordered = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);

  for (const block of ordered) {
    const current = options.world.at(block.x, block.y, block.z);
    if (current == null) {
      skipped.push({ x: block.x, y: block.y, z: block.z, state: block.state, reason: '区块未加载' });
      continue;
    }
    if (satisfiesState(current.state, block.state)) {
      satisfied += 1;
      continue;
    }
    if (!AIR.has(current.state) && !diggable(current)) {
      skipped.push({ x: block.x, y: block.y, z: block.z, state: block.state, reason: `现有方块不可挖：${current.state}` });
      continue;
    }

    const faceIndex = NEIGHBORS.map((delta) => options.world.at(block.x + delta.x, block.y + delta.y, block.z + delta.z)).findIndex(
      (cell) => cell != null && cell.solid,
    );
    if (faceIndex < 0) {
      skipped.push({ x: block.x, y: block.y, z: block.z, state: block.state, reason: '没有可依附的实心面' });
      continue;
    }

    const item = itemForState(block.state);
    required.set(item, (required.get(item) ?? 0) + 1);

    const clear = !AIR.has(current.state);
    if (clear) toDig += 1;
    const delta = NEIGHBORS[faceIndex];
    steps.push({
      x: block.x,
      y: block.y,
      z: block.z,
      state: block.state,
      item,
      clear,
      face: { x: block.x + delta.x, y: block.y + delta.y, z: block.z + delta.z },
    });
  }

  const missing: MissingItem[] = [];
  for (const [item, need] of required) {
    const have = options.inventory[item] ?? 0;
    if (need > have) missing.push({ item, need, have });
  }

  return {
    steps,
    skipped,
    missing,
    counts: {
      planned: blocks.length,
      toPlace: steps.length,
      toDig,
      satisfied,
      skipped: skipped.length,
      missing: missing.reduce((sum, entry) => sum + (entry.need - entry.have), 0),
    },
  };
}
