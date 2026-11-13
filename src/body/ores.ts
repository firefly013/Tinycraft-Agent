/**
 * 方块扫描：矿石别名与"最近的 N 个目标方块"。
 *
 * 单独一层是因为 mineflayer 的 findBlocks 会先用 palette 预检调 matching
 * （此时 block 没有 position），所以这里只按名字扫，坐标拿到后再补名字。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 方块 id 别名：同一类矿的深板岩变体。 */
const ORE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  gold_ore: ['gold_ore', 'deepslate_gold_ore'],
  copper_ore: ['copper_ore', 'deepslate_copper_ore'],
  coal_ore: ['coal_ore', 'deepslate_coal_ore'],
  diamond_ore: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone_ore: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis_ore: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald_ore: ['emerald_ore', 'deepslate_emerald_ore'],
};

function blockIds(bot: any, name: string): number[] {
  const names = ORE_ALIASES[name] ?? [name];
  return names
    .map((item) => bot.registry?.blocksByName?.[item]?.id)
    .filter((id: unknown): id is number => typeof id === 'number');
}

/** 最近的 count 个目标方块（数量与会话约定一致，不放大）。 */
export function nearestBlocks(bot: any, name: string, count: number, radius = 32): any[] {
  const ids = blockIds(bot, name);
  if (ids.length === 0) return [];
  const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count });
  return positions.map((pos: { x: number; y: number; z: number }) => bot.blockAt(pos)).filter((block: any) => block != null);
}

/**
 * 扫描**所有已加载区块**里的目标方块（不受距离上限限制）。
 *
 * findBlocks 是以机器人为中心的固定半径搜索，超出半径的已加载区块不会看；
 * 这里改成按列遍历：按水平距离由近到远，用 section palette 预检跳过不可能命中的段，
 * 只对可能命中的段逐格读 stateId。返回最近的 count 个方块。
 */
export function nearestBlocksLoaded(bot: any, name: string, count: number): any[] {
  const ids = new Set(blockIds(bot, name));
  if (ids.size === 0) return [];
  const self = bot.entity?.position;
  if (self == null) return [];
  const columns: Array<{ chunkX: number; chunkZ: number; column: any }> =
    typeof bot.world?.getColumns === 'function' ? bot.world.getColumns() : [];
  if (columns.length === 0) return [];

  const blocksByStateId = bot.registry?.blocksByStateId ?? {};
  const minY = Number(bot.game?.minY ?? -64);

  const ordered = columns
    .map((entry) => {
      const cx = Number(entry.chunkX);
      const cz = Number(entry.chunkZ);
      const centerX = cx * 16 + 8;
      const centerZ = cz * 16 + 8;
      return {
        entry,
        cx,
        cz,
        distance: Math.hypot(centerX - self.x, centerZ - self.z),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const found: Array<{ position: { x: number; y: number; z: number }; distance: number }> = [];
  for (const { entry, cx, cz, distance } of ordered) {
    // 已有 count 个，且这一列最近的点都不比最远的那个更近：不用再扫更远的列。
    if (found.length >= count) {
      found.sort((a, b) => a.distance - b.distance);
      if (distance > found[count - 1].distance) break;
    }
    const column = entry.column;
    const sections = column?.sections ?? [];
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (section == null) continue;
      const palette: number[] = Array.isArray(section.palette) ? section.palette : [];
      if (palette.length > 0 && !palette.some((stateId) => ids.has(Number(blocksByStateId[stateId]?.id)))) {
        continue;
      }
      const baseY = minY + index * 16;
      for (let dx = 0; dx < 16; dx += 1) {
        for (let dy = 0; dy < 16; dy += 1) {
          for (let dz = 0; dz < 16; dz += 1) {
            const position = { x: cx * 16 + dx, y: baseY + dy, z: cz * 16 + dz };
            let stateId: number;
            try {
              stateId = Number(column.getBlockStateId(position));
            } catch {
              continue;
            }
            const id = Number(blocksByStateId[stateId]?.id);
            if (!ids.has(id)) continue;
            found.push({
              position,
              distance: Math.hypot(position.x - self.x, position.y - self.y, position.z - self.z),
            });
          }
        }
      }
    }
  }

  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map((item) => bot.blockAt(item.position))
    .filter((block: any) => block != null);
}
