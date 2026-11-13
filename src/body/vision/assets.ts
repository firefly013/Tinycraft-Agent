/**
 * prismarine-viewer 的实体贴图资源。
 *
 * viewer 的实体模型固定按 **1.16.4** 取贴图（`Entity.js` 里写死），而
 * prismarine-viewer 1.33.0 只自带 1.15.2 及更早的实体目录；1.16.4+ 的实体
 * 贴图缺失时 `loadImage` 会抛未处理 rejection，真机上一有僵尸就杀进程。
 *
 * 仓库里因此带了一份 1.16.4 实体贴图（`assets/prismarine-viewer/textures/1.16.4`），
 * 启动时如果 node_modules 里缺就复制过去。它是数据资产，不是代码。
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** viewer 的 Entity.js 写死的实体贴图版本。 */
export const VIEWER_ENTITY_VERSION = '1.16.4';
/** 判断实体贴图是否真的完整的哨兵文件。 */
const SENTINEL = join('entity', 'zombie', 'zombie.png');

export interface EnsureResult {
  ok: boolean;
  copied: boolean;
  target: string;
  error?: string;
}

export interface EnsureOptions {
  /** 仓库根目录；默认从本文件向上三级（src/body/vision → 根）。 */
  repoRoot?: string;
  /** 测试注入：node_modules/prismarine-viewer/public/textures 根。 */
  texturesRoot?: string;
}

/** 确保 viewer 能找到 1.16.4 实体贴图；缺失则从仓库 assets 复制。 */
export function ensureViewerEntityTextures(options: EnsureOptions = {}): EnsureResult {
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  const source = join(repoRoot, 'assets', 'prismarine-viewer', 'textures', VIEWER_ENTITY_VERSION);
  const target =
    options.texturesRoot ?? join(repoRoot, 'node_modules', 'prismarine-viewer', 'public', 'textures', VIEWER_ENTITY_VERSION);
  try {
    if (existsSync(join(target, SENTINEL))) {
      return { ok: true, copied: false, target };
    }
    if (!existsSync(join(source, SENTINEL))) {
      return {
        ok: false,
        copied: false,
        target,
        error: `缺少实体贴图资产：${join(source, SENTINEL)}。仓库 assets/prismarine-viewer/textures/1.16.4 必须存在。`,
      };
    }
    cpSync(source, target, { recursive: true });
    return { ok: true, copied: true, target };
  } catch (error: unknown) {
    return { ok: false, copied: false, target, error: error instanceof Error ? error.message : String(error) };
  }
}
