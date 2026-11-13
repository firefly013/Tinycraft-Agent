/**
 * 全局自动拾取的策略、丢弃物免疫和唯一的拾取执行体。
 *
 * 三个调用方（自动拾取反射、挖矿/采集/攻击后的局部拾取）都必须走这里，
 * 不允许再各写一套扫描 + 寻路。
 */
import { createRequire } from 'node:module';
import { withAbort, type ActionContext } from '../shared/body.ts';

/** 只捡这么近的掉落物（格）。 */
export const PICKUP_RADIUS = 8;
/** 两次拾取尝试之间的最小间隔（毫秒）。 */
export const PICKUP_INTERVAL_MS = 1_500;
/** 走过去捡的超时（毫秒）。 */
export const PICKUP_TIMEOUT_MS = 12_000;
/** 拾取反射的硬上限（毫秒）：超过就 abort，别把身体锁死。 */
export const PICKUP_HARD_MS = 25_000;
/** 连续失败后静默这么久（毫秒）。 */
export const PICKUP_GIVE_UP_MS = 60_000;
/** 敌对生物在这个距离内不启动拾取（格）。 */
export const PICKUP_THREAT_RADIUS = 16;
/** 刚被 discard 扔掉的东西，多久之内不要去捡（毫秒）。 */
export const DISCARD_IGNORE_MS = 180_000;
/** discard 免疫的空间半径（格）。 */
export const DISCARD_IGNORE_RADIUS = 2.5;

interface DiscardRecord {
  x: number;
  y: number;
  z: number;
  at: number;
}

const discarded: DiscardRecord[] = [];

/** 模型主动丢东西后调用：落点附近一段时间内不自动捡。 */
export function markDiscarded(position: { x: number; y: number; z: number } | null | undefined, now = Date.now()): void {
  if (position == null) return;
  discarded.push({ x: position.x, y: position.y, z: position.z, at: now });
  const cutoff = now - DISCARD_IGNORE_MS;
  while (discarded.length > 0 && discarded[0]!.at < cutoff) discarded.shift();
}

/** 这个掉落物是不是刚被模型主动扔掉的（按落点半径 + 时间窗）。 */
export function isDiscarded(position: { x: number; y: number; z: number } | null | undefined, now = Date.now()): boolean {
  if (position == null) return false;
  const cutoff = now - DISCARD_IGNORE_MS;
  return discarded.some(
    (record) =>
      record.at >= cutoff &&
      Math.hypot(record.x - position.x, record.y - position.y, record.z - position.z) <= DISCARD_IGNORE_RADIUS,
  );
}

/** 附近可捡的掉落物实体（最近优先）。 */
export function nearbyDrops(
  bot: { entities?: Record<string, unknown>; entity?: { position?: { x: number; y: number; z: number } } },
  radius = PICKUP_RADIUS,
  now = Date.now(),
): Array<{ entity: any; position: { x: number; y: number; z: number }; distance: number }> {
  const self = bot.entity?.position;
  if (self == null) return [];
  return (Object.values(bot.entities ?? {}) as any[])
    .filter((entity) => entity?.name === 'item' && entity.position != null && !isDiscarded(entity.position, now))
    .map((entity) => ({
      entity,
      position: entity.position as { x: number; y: number; z: number },
      distance: Math.hypot(entity.position.x - self.x, entity.position.y - self.y, entity.position.z - self.z),
    }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/** 拾取执行的参数。 */
export interface PickupOptions {
  /** 只捡这个半径内的掉落物（格）。 */
  radius?: number;
  /** 总的拾取预算（毫秒）。 */
  budgetMs?: number;
  /** 最多尝试捡几件。 */
  maxItems?: number;
  /** 走到掉落物旁边的 GoalNear 半径。 */
  range?: number;
  /** 单次寻路的硬超时（毫秒）；pathfinder 有时永不 resolve。 */
  gotoTimeoutMs?: number;
  /** 到位后等实体消失的时间（毫秒）。 */
  waitMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



/**
 * 唯一的拾取执行体：扫描最近的掉落物 → 寻路靠近 → 等实体消失 → 下一件。
 *
 * 自动拾取反射走默认参数；挖矿/采集/攻击后的局部拾取传更小的预算。
 * 取消信号、退避、丢弃物免疫都在这一层，调用方不重复实现。
 */
export async function pickupDrops(
  bot: any,
  context: ActionContext,
  options: PickupOptions = {},
): Promise<number> {
  const radius = options.radius ?? PICKUP_RADIUS;
  const budgetMs = options.budgetMs ?? 5_000;
  const maxItems = options.maxItems ?? 8;
  const range = options.range ?? 0.8;
  const waitMs = options.waitMs ?? 800;
  const require = createRequire(import.meta.url);
  const { goals } = require('mineflayer-pathfinder') as {
    goals: { GoalNear: new (x: number, y: number, z: number, range?: number) => unknown };
  };

  const deadline = Date.now() + budgetMs;
  let picked = 0;
  let failures = 0;
  for (let iter = 0; iter < maxItems; iter += 1) {
    if (context.signal.aborted || Date.now() >= deadline) break;
    const nearest = nearbyDrops(bot, radius)[0];
    if (nearest == null) break;
    let gotoTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const gotoPromise = bot.pathfinder.goto(
        new goals.GoalNear(nearest.position.x, nearest.position.y, nearest.position.z, range),
      ) as Promise<unknown>;
      // pathfinder 的 goto 有时会永远不 resolve（目标不可达/物理卡住）：加硬超时，
      // 否则反射会把身体锁死（真机出现过 pickup 403 秒不动）。
      const gotoLimit = Math.max(200, Math.min(options.gotoTimeoutMs ?? 8_000, Math.max(200, deadline - Date.now())));
      const timedOut = new Promise<never>((_, reject) => {
        gotoTimer = setTimeout(() => {
          try {
            bot.pathfinder?.stop?.();
          } catch {
            // 停不下来也要让 promise 落地。
          }
          reject(new Error('pickup goto timeout'));
        }, gotoLimit);
      });
      await Promise.race([
        withAbort(gotoPromise, context.signal, () => bot.pathfinder?.stop?.()),
        timedOut,
      ]);
      const id = nearest.entity?.id;
      const goneDeadline = Date.now() + waitMs;
      if (id != null) {
        while (Date.now() < goneDeadline && !context.signal.aborted && bot.entities?.[id] != null) {
          await sleep(100);
        }
      }
      if (id == null || bot.entities?.[id] == null) picked += 1;
      else failures += 1;
    } catch {
      if (context.signal.aborted) break;
      failures += 1;
    } finally {
      if (gotoTimer != null) clearTimeout(gotoTimer);
    }
    if (failures >= 3) break;
  }
  return picked;
}
