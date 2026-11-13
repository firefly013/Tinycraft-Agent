/**
 * viewer 的实体模型补丁。
 *
 * prismarine-viewer 1.33 的 `entities.json` 里 zombie/husk/drowned/zombie_villager
 * 的模型在本机 THREE 0.128 + 当前渲染链下会塌成一个方块（骨骼/UV 与该版本不兼容）。
 * 它们本来就是玩家骨架，直接复用 `player` 的 geometry（保留自己的贴图路径）即可
 * 正常渲染。纯数据补丁，不改 Entity.js。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const COMPATIBLE_GEOMETRY = ['zombie', 'husk', 'drowned', 'zombie_villager'];

/** 把已知坏掉的实体模型换成 player 骨架；返回被替换的名字。 */
export function patchViewerEntityModels(): string[] {
  try {
    const models = require('prismarine-viewer/viewer/lib/entity/entities.json') as Record<string, any>;
    const player = models.player?.geometry;
    if (player == null) return [];
    const patched: string[] = [];
    for (const name of COMPATIBLE_GEOMETRY) {
      const model = models[name];
      if (model == null || model.geometry === player) continue;
      model.geometry = JSON.parse(JSON.stringify(player));
      patched.push(name);
    }
    return patched;
  } catch {
    // 补丁失败不影响截图链：只是这些 mob 继续是方块。
    return [];
  }
}
