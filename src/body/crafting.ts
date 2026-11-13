/**
 * 合成相关的小工具：工作台查找/放置、容器窗口关闭。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => any };

/** 右键容器会打开窗口：没有搬运工具时，开着窗口只会让后续背包操作点错窗口。 */
export function closeContainer(bot: any): void {
  try {
    const window = bot.currentWindow;
    if (window != null) bot.closeWindow(window);
  } catch {
    // 关不掉也不影响主流程。
  }
}

/**
 * 找一个 3×3 配方能用的工作台：附近有就用；背包里有就放一个。
 *
 * `place` 由调用方给（它知道取消信号/超时）；放下不回收（少一个真正的多步脚本）。
 */
export async function findCraftingTable(
  bot: any,
  place: (reference: any) => Promise<void>,
): Promise<any | null> {
  try {
    const blockId = bot.registry?.blocksByName?.crafting_table?.id;
    if (blockId != null) {
      const found = bot.findBlock({ matching: blockId, maxDistance: 4 });
      if (found != null) return found;
    }
  } catch {
    // 没有 findBlock（假 bot）就继续往下试放一个。
  }
  const tableItem = bot.inventory.items().find((entry: any) => entry.name === 'crafting_table');
  if (tableItem == null) return null;
  const base = bot.entity?.position?.floored?.();
  if (base == null) return null;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const ground = bot.blockAt(new Vec3(base.x + dx, base.y - 1, base.z + dz));
    const above = bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz));
    if (ground == null || ground.name === 'air' || above == null || above.name !== 'air') continue;
    try {
      await bot.equip(tableItem, 'hand');
      await place(ground);
      return bot.blockAt(new Vec3(base.x + dx, base.y, base.z + dz));
    } catch {
      return null;
    }
  }
  return null;
}
