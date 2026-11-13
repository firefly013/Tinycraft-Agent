/**
 * 落地水反射（MLG water bucket）。
 *
 * 形式借自 @nxg-org/mineflayer-common-sense 的 "physicsTick → detect → respond"：
 * 检测是身体每 tick 的事，动作本身仍然是一个反射（有优先级、抢身体、可被记录）。
 *
 * 两条硬要求（实测踩出来的）：
 *   1. 保命反射期间**冻结身体**：清控制状态、停寻路/挖掘，否则被打断的动作会继续推人。
 *   2. 放水要**每 tick 高频重发**：只发一次经常因为朝向/时序被服务器丢掉；检测到还在掉
 *      就一直发，直到水真的出现。look/activate 都直接写包（同步），不等 promise。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => any };

/** 落差超过这个值才会摔伤（第 4 格起）。 */
export const MIN_MLG_FALL = 3.6;
/** 离落点多近开始泼水（格）。 */
export const MLG_REACH = 5;

const LANDING_BOXES = new Set(['block']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitTicks = async (bot: any, ticks: number): Promise<void> => {
  try {
    await bot.waitForTicks(ticks);
  } catch {
    await sleep(50 * ticks);
  }
};

const itemNamed = (bot: any, names: readonly string[]): any | null => {
  try {
    const items = (bot.inventory?.items?.() ?? []) as Array<{ name?: string }>;
    return items.find((item) => typeof item?.name === 'string' && names.includes(item.name)) ?? null;
  } catch {
    return null;
  }
};

const blockAt = (bot: any, position: { x: number; y: number; z: number }): any | null => {
  try {
    return bot.blockAt(new Vec3(position.x, position.y, position.z));
  } catch {
    return null;
  }
};

/** 落点：脚下投影范围内、y 最高的那个"第一块实心方块"。 */
export function findLandingBlock(bot: any): any | null {
  const entity = bot?.entity;
  if (entity?.position == null) return null;
  const pos = entity.position;
  const half = Math.max(0.1, Number(entity.width ?? 0.6) / 2 - 0.01);
  const x0 = Math.floor(pos.x - half);
  const x1 = Math.floor(pos.x + half);
  const z0 = Math.floor(pos.z - half);
  const z1 = Math.floor(pos.z + half);
  const minY = Number(bot?.game?.minY ?? -64);
  let best: any | null = null;
  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      for (let y = Math.floor(pos.y); y >= minY; y -= 1) {
        const block = blockAt(bot, { x, y, z });
        if (block == null) continue; // 未加载的段跳过，别整列放弃
        const name = String(block.name ?? '');
        if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'water' || name === 'lava') continue;
        if (!LANDING_BOXES.has(String(block.boundingBox ?? ''))) continue;
        if (best == null || block.position.y > best.position.y) best = block;
        break;
      }
    }
  }
  if (best == null) return null;
  if (best.position.y + 1 >= pos.y) return null; // 已经站在上面，不算坠落
  return best;
}

/** 现在需不需要落地水：正在掉、够高、没入水、背包里有水桶、落点找得到。 */
export function needsMlg(bot: any): boolean {
  const entity = bot?.entity;
  if (entity?.position == null) return false;
  if (entity.isInWater === true) return false;
  const vy = Number(entity.velocity?.y ?? 0);
  if (!(vy < -0.8)) return false;
  if (itemNamed(bot, ['water_bucket']) == null) return false;
  const landing = findLandingBlock(bot);
  if (landing == null) return false;
  if (isSoftLanding(landing)) return false; // 树叶/干草堆/黏液块…落上去本来就不掉血
  return entity.position.y - (landing.position.y + 1) > MIN_MLG_FALL;
}

/** 落在这些东西上不摔伤，不值得浪费水桶。 */
function isSoftLanding(block: any): boolean {
  const name = String(block?.name ?? '');
  return (
    name.endsWith('_leaves') ||
    name === 'hay_block' ||
    name === 'cobweb' ||
    name === 'slime_block' ||
    name === 'honey_block' ||
    name === 'powder_snow' ||
    name === 'sweet_berry_bush' ||
    name === 'scaffolding'
  );
}

/** 只有水源方块（metadata 0）能用桶收；流动水收不了。 */
const isWaterSource = (block: any): boolean => {
  const name = String(block?.name ?? '');
  return (name === 'water' || name === 'flowing_water') && Number(block?.metadata ?? 1) === 0;
};

/** 找离 reference 最近的水源（优先放水点那格）。 */
const findWaterSource = (bot: any, reference: { x: number; y: number; z: number }, radius: number): any | null => {
  let best: any | null = null;
  let bestDistance = Infinity;
  for (let x = Math.floor(reference.x) - radius; x <= Math.floor(reference.x) + radius; x += 1) {
    for (let y = Math.floor(reference.y) - radius; y <= Math.floor(reference.y) + radius; y += 1) {
      for (let z = Math.floor(reference.z) - radius; z <= Math.floor(reference.z) + radius; z += 1) {
        const block = blockAt(bot, { x, y, z });
        if (!isWaterSource(block)) continue;
        const distance = Math.hypot(block.position.x + 0.5 - reference.x, block.position.y + 0.5 - reference.y, block.position.z + 0.5 - reference.z);
        if (distance < bestDistance) {
          best = block;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
};

/** 落地后把水收回来：等站稳 → 找水源 → 装备桶 → 看准 → 用桶；失败重试。 */
async function pickUpWater(bot: any, placement: { x: number; y: number; z: number } | null, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  // 落地/入水稳定再收，否则 look/use 会撞上还在下落的身体。
  while (Date.now() < deadline) {
    const entity = bot.entity;
    if (entity == null) return false;
    if (entity.onGround === true || entity.isInWater === true) break;
    await sleep(80);
  }
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt += 1) {
    if (signal?.aborted) return false;
    const reference = placement ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 };
    const source = findWaterSource(bot, reference, 3);
    if (source == null) return true; // 没有水了：已经收好了
    const empty = itemNamed(bot, ['bucket']);
    if (empty == null) return false;
    try {
      await bot.equip(empty, 'hand');
    } catch {
      await sleep(100);
      continue;
    }
    try {
      await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
    } catch {
      // 看不过去也接着用桶，下一轮再对准。
    }
    try {
      bot.activateItem();
    } catch {
      // 这一轮发不出去就重试。
    }
    await sleep(150);
  }
  const reference = placement ?? bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return findWaterSource(bot, reference, 3) == null;
}

/**
 * 对准目标（不等 promise）。
 *
 * 用 bon.look(..., force=true)：它同步更新 entity.yaw/pitch，包由 physics 下一 tick 发出；
 * 自己 client.write('look') 在 1.21.3+ 需要 MovementFlags，手写容易错。
 * 每 tick 都调 + 每 tick activateItem，靠高频重发保证"有一次朝对了"。
 */
function lookAtFast(bot: any, target: { x: number; y: number; z: number }): void {
  try {
    const entity = bot.entity;
    if (entity?.position == null) return;
    const eyeY = Number(entity.eyeHeight ?? 1.62);
    const dx = target.x - entity.position.x;
    const dy = target.y - (entity.position.y + eyeY);
    const dz = target.z - entity.position.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    void bot.look?.(yaw, pitch, true);
  } catch {
    // 换下一 tick 再对准。
  }
}

/** 冻结身体：保命反射期间不许别的动作继续推人。 */
export function freezeBody(bot: any): void {
  try {
    bot.clearControlStates?.();
  } catch {
    // 没有控制器就算了。
  }
  try {
    bot.pathfinder?.stop?.();
  } catch {
    // 没有寻路就算了。
  }
  try {
    bot.stopDigging?.();
  } catch {
    // 没在挖就算了。
  }
  try {
    bot.physics?.clearControlStates?.();
  } catch {
    // 没有 physics 就算了。
  }
}

/**
 * 执行一次落地水。返回是否真的泼出去了（不是"尝试过"）。
 *
 * 每 tick：冻结身体 → 对准落点 → activateItem()（同步发包）。水出现后落地、收水。
 */
export async function mlgWithWater(bot: any, signal?: AbortSignal): Promise<boolean> {
  if (needsMlg(bot) === false) return false;
  const bucket = itemNamed(bot, ['water_bucket']);
  if (bucket == null) return false;
  freezeBody(bot);
  try {
    await bot.equip(bucket, 'hand');
  } catch {
    return false;
  }
  freezeBody(bot);
  let placed = false;
  let placement: { x: number; y: number; z: number } | null = null;
  const deadline = Date.now() + 8_000;
  while (!signal?.aborted && Date.now() < deadline) {
    const entity = bot.entity;
    if (entity == null) break;
    if (entity.isInWater === true) break;
    if (Number(entity.velocity?.y ?? 0) > -0.2) break;
    freezeBody(bot);
    const landing = findLandingBlock(bot);
    if (landing == null) break;
    const above = entity.position.y - (landing.position.y + 1);
    if (above <= MLG_REACH) {
      lookAtFast(bot, { x: landing.position.x + 0.5, y: landing.position.y + 1, z: landing.position.z + 0.5 });
      try {
        bot.activateItem();
        placed = true;
        if (placement == null) placement = { x: landing.position.x, y: landing.position.y + 1, z: landing.position.z };
      } catch {
        // 这一 tick 发不出去，下一 tick 继续。
      }
      await sleep(30);
      if (findWaterSource(bot, landing.position, 2) != null) break;
    }
    await waitTicks(bot, 1);
  }
  if (!placed) return false;
  // 落地 → 收水（把水桶拿回来，别丢在坑里）。
  await pickUpWater(bot, placement, signal);
  return true;
}
