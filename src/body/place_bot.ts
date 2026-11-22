/**
 * 真实放置器的适配层：把 mineflayer 的零碎 API 收成几个动作。
 *
 * 执行器只依赖这个接口，所以排序、跳过、检查点这些逻辑可以用假 bot 测。
 */
import { createRequire } from 'node:module';
import { satisfiesState } from './build_planner.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => AnyVec };
const { GoalNear, GoalPlaceBlock } = require('mineflayer-pathfinder') as {
  GoalNear: new (pos: AnyVec, range: number) => unknown;
  GoalPlaceBlock: new (pos: AnyVec, world: unknown, options: Record<string, unknown>) => unknown;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyVec = any;
type AnyBot = any;
type AnyBlock = any;

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export interface PlaceOps {
  /** 现有方块状态；null = 区块未加载。 */
  stateAt(pos: Pos): string | null;
  solidAt(pos: Pos): boolean;
  inventory(): Record<string, number>;
  dig(pos: Pos): Promise<void>;
  equip(item: string): Promise<void>;
  /** 走到能点到这个位置的地方（pathfinder）。 */
  reach(pos: Pos): Promise<void>;
  place(pos: Pos, state: string): Promise<void>;
  /** 中断在飞的寻路。 */
  stop(): void;
}

/** mineflayer block → 与 emit 同构的状态串。 */
export function stateOf(block: AnyBlock): string {
  const name = String(block?.name ?? 'air');
  const props = typeof block?.getProperties === 'function' ? (block.getProperties() as Record<string, unknown>) : {};
  const keys = Object.keys(props).sort();
  if (keys.length === 0) return name;
  return `${name}[${keys.map((key) => `${key}=${String(props[key])}`).join(',')}]`;
}

const DIRS: readonly Pos[] = [
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
];

/** 从状态里取出朝向；lookAt 用。 */
function facingVector(state: string): Pos | null {
  if (/facing=east/.test(state)) return { x: 1, y: 0, z: 0 };
  if (/facing=west/.test(state)) return { x: -1, y: 0, z: 0 };
  if (/facing=south/.test(state)) return { x: 0, y: 0, z: 1 };
  if (/facing=north/.test(state)) return { x: 0, y: 0, z: -1 };
  if (/facing=up/.test(state)) return { x: 0, y: 1, z: 0 };
  if (/facing=down/.test(state)) return { x: 0, y: -1, z: 0 };
  return null;
}

/** 面向属性决定该从哪一面贴：axis=x 的木头要从侧面放，不能从顶上放。 */
function preferredDir(state: string): Pos | null {
  const axis = /axis=(\w+)/.exec(state)?.[1];
  if (axis === 'x') return { x: 1, y: 0, z: 0 };
  if (axis === 'z') return { x: 0, y: 0, z: 1 };
  if (axis === 'y') return { x: 0, y: 1, z: 0 };
  return null;
}

export function createPlaceBot(bot: AnyBot): PlaceOps {
  const vec = (pos: Pos): AnyVec => new Vec3(pos.x, pos.y, pos.z);
  const blockAt = (pos: Pos): AnyBlock => bot.blockAt(vec(pos), false);

  return {
    stateAt(pos) {
      const block = blockAt(pos);
      if (block == null) return null;
      return stateOf(block);
    },
    solidAt(pos) {
      const block = blockAt(pos);
      return block != null && block.boundingBox === 'block';
    },
    inventory() {
      const counts: Record<string, number> = {};
      for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count;
      return counts;
    },
    async dig(pos) {
      const block = blockAt(pos);
      if (block != null && block.boundingBox != null) await bot.dig(block, true);
    },
    async equip(item) {
      const found = bot.inventory.items().find((entry: AnyBlock) => entry.name === item);
      if (found == null) throw new Error(`背包里没有 ${item}`);
      await bot.equip(found, 'hand');
    },
    async reach(pos) {
      const target = vec(pos);
      try {
        await bot.pathfinder.goto(new GoalPlaceBlock(target, bot.world, { range: 3 }));
      } catch {
        await bot.pathfinder.goto(new GoalNear(target, 3));
      }
    },
    async place(pos, state) {
      const target = vec(pos);
      const preferred = preferredDir(state);
      const order = preferred == null ? DIRS : [preferred, ...DIRS.filter((dir) => dir !== preferred)];
      for (const dir of order) {
        const relative = vec(dir);
        const ref = bot.blockAt(target.plus(relative), false);
        if (ref == null || ref.boundingBox !== 'block') continue;
        const look = facingVector(state);
        if (look != null) {
          await bot.lookAt(target.plus(vec(look)).offset(0.5, 0.5, 0.5), true);
        }
        await bot.placeBlock(ref, relative.scaled(-1));
        return;
      }
      throw new Error('没有可依附的实心面');
    },
    stop() {
      bot.pathfinder.stop();
    },
  };
}

/** 现有状态是否已经满足目标。给执行器做“续做前先核对世界”。 */
export function alreadyThere(actual: string | null, target: string): boolean {
  return actual != null && satisfiesState(actual, target);
}
