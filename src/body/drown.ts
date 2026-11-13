/**
 * 溺水反射。
 *
 * **不用 `bot.oxygenLevel`**：这一版 mineflayer/prismarine 对 1.21.4 的玩家
 * `air_supply` 元数据解析是坏的——实测在岸上读 18、下水后是 -4…-18 来回跳，
 * `oxygenLevel = round(air/15)` 永远是 0/-0。所以改为自己判：
 *
 *   1. **眼睛那格是不是水**（`blockAt(pos + eyeHeight)`），最可靠的"在水下"信号；
 *   2. 自己在水下**数 tick**（20/s，满氧约 300 tick = 15 秒），到 150 tick 就先动；
 *   3. 数 tick 之外再看**血量有没有掉**——真淹到掉血时立刻触发，不靠计时器。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';
import { freezeBody } from './mlg.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => any };

/** 在水下待够这么多 tick（约 5 秒）就先往上走：满氧 15 秒，但下水前可能已经憋了一半。 */
export const DROWN_TICKS = 100;

const WATER_NAMES = new Set(['water', 'flowing_water']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitTicks = async (bot: any, ticks: number): Promise<void> => {
  try {
    await bot.waitForTicks(ticks);
  } catch {
    await sleep(50 * ticks);
  }
};

const blockAt = (bot: any, position: { x: number; y: number; z: number }): any | null => {
  try {
    return bot.blockAt(new Vec3(position.x, position.y, position.z));
  } catch {
    return null;
  }
};

/** 眼睛（头部）所在的方块。 */
export function headBlock(bot: any): any | null {
  const entity = bot?.entity;
  if (entity?.position == null) return null;
  const eye = Number(entity.eyeHeight ?? 1.62);
  return blockAt(bot, { x: entity.position.x, y: entity.position.y + eye, z: entity.position.z });
}

export function isHeadUnderwater(bot: any): boolean {
  const name = String(headBlock(bot)?.name ?? '');
  return WATER_NAMES.has(name);
}

/**
 * 往上走：按住跳跃键（水里会上升），顶上是实心方块就挖开。
 *
 * 身体已经被反射抢到手，这里自己清控制状态——不要等模型/旧动作的按键。
 */
export async function swimUp(bot: any, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  try {
    bot.pathfinder?.stop?.();
  } catch {
    // 没有寻路就算了。
  }
  let surfaced = false;
  while (!signal?.aborted && Date.now() < deadline) {
    if (!isHeadUnderwater(bot)) {
      surfaced = true;
      break;
    }
    // 头顶正上方是实心方块（冰面/石头/泥土）：挖开再上升。
    try {
      const entity = bot.entity;
      const eye = Number(entity.eyeHeight ?? 1.62);
      const above = blockAt(bot, { x: entity.position.x, y: entity.position.y + eye + 1, z: entity.position.z });
      if (above != null && String(above.boundingBox ?? '') === 'block') {
        try {
          await bot.dig(above, true);
        } catch {
          // 挖不动就继续按跳跃，下一轮再试。
        }
        await waitTicks(bot, 1);
        continue;
      }
    } catch {
      // 读不到方块就当头顶是水。
    }
    try {
      bot.clearControlStates?.();
      bot.setControlState('jump', true);
    } catch {
      // 没有控制器就算了。
    }
    await waitTicks(bot, 1);
  }
  try {
    bot.setControlState('jump', false);
    bot.clearControlStates?.();
  } catch {
    // 清不掉也不影响。
  }
  freezeBody(bot);
  return surfaced;
}
