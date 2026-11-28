/**
 * 蓝图目录：一个任务一个目录，目录名就是 id。
 *
 * 这里只做文件系统：建目录、写 meta、按条件检索。不认识模型、不认识身体，
 * 也不管设计任务跑没跑完——那是 architect 的事。
 *
 * 布局（`<root>` 默认 `bots/<name>/build/blueprints`）：
 *   <root>/<id>/script.js      可重编译的源脚本
 *   <root>/<id>/plan.schem     施工输入
 *   <root>/<id>/meta.json      身份与元数据
 *   <root>/<id>/*.png          六视图预览（由 mc-build 产出）
 *   <root>/<id>/ascii.txt      ASCII 侧影（给看不了图的调用方）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface BlueprintSize {
  x: number;
  y: number;
  z: number;
}

export interface BlueprintMeta {
  id: string;
  /** 主模型给的原始需求，返工时也用它。 */
  brief: string;
  tags: string[];
  /** 值得被别的蓝图复用；由架构师在 finish 时显式标注。 */
  reusable: boolean;
  size: BlueprintSize;
  /** 非空气方块数。 */
  blocks: number;
  /** 方块状态 → 数量。 */
  materials: Record<string, number>;
  /** 编译时的目标 MC 版本；null = 未知。 */
  mc: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Blueprint extends BlueprintMeta {
  dir: string;
}

export interface BlueprintQuery {
  reusable?: boolean;
  tag?: string;
  maxSize?: number;
  text?: string;
}

/** `<botDir>/build/blueprints`。botDir 形如 `bots/alice`。 */
export function blueprintRoot(botDir: string): string {
  return join(botDir, 'build', 'blueprints');
}

/** brief → 可读 slug：只留 ascii 字母数字，压成连字符；中文 brief 退回 `build`。 */
export function slugify(brief: string): string {
  const slug = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'build' : slug;
}

/** `slug-xxxx`；撞名就再摇一次。目录本身是唯一真源。 */
export function newBlueprintId(root: string, brief: string): string {
  const slug = slugify(brief);
  for (;;) {
    const id = `${slug}-${randomBytes(2).toString('hex')}`;
    if (!existsSync(join(root, id))) return id;
  }
}

export function blueprintDir(root: string, id: string): string {
  return join(root, id);
}

/** 新建目录与 meta；不覆盖已存在的 id。 */
export function createBlueprint(root: string, brief: string, options: { mc?: string | null } = {}): Blueprint {
  const id = newBlueprintId(root, brief);
  const dir = blueprintDir(root, id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: BlueprintMeta = {
    id,
    brief,
    tags: [],
    reusable: false,
    size: { x: 0, y: 0, z: 0 },
    blocks: 0,
    materials: {},
    mc: options.mc ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(dir, meta);
  return { ...meta, dir };
}

/** 写 meta；先写临时文件再改名，避免半截 JSON。 */
export function writeMeta(dir: string, meta: BlueprintMeta): void {
  const target = join(dir, 'meta.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, target);
}

/** 读一个蓝图；目录不存在或 meta 坏了都返回 null（调用方负责报错措辞）。 */
export function readBlueprint(root: string, id: string): Blueprint | null {
  const dir = blueprintDir(root, id);
  const path = join(dir, 'meta.json');
  if (!existsSync(path)) return null;
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')) as BlueprintMeta;
    if (typeof meta.id !== 'string' || meta.id !== id) return null;
    return { ...meta, dir };
  } catch {
    return null;
  }
}

/** 局部更新并落盘；返回更新后的蓝图，找不到就 null。 */
export function updateBlueprint(root: string, id: string, patch: Partial<Omit<BlueprintMeta, 'id'>>): Blueprint | null {
  const current = readBlueprint(root, id);
  if (current == null) return null;
  const { dir, ...meta } = current;
  const next: BlueprintMeta = { ...meta, ...patch, id, updatedAt: new Date().toISOString() };
  writeMeta(dir, next);
  return { ...next, dir };
}

/** 列出全部蓝图，按创建时间倒序；查询条件之间是与关系。 */
export function listBlueprints(root: string, query: BlueprintQuery = {}): Blueprint[] {
  if (!existsSync(root)) return [];
  const found: Blueprint[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const blueprint = readBlueprint(root, entry.name);
    if (blueprint == null) continue;
    if (query.reusable != null && blueprint.reusable !== query.reusable) continue;
    if (query.tag != null && !blueprint.tags.includes(query.tag)) continue;
    if (query.maxSize != null && Math.max(blueprint.size.x, blueprint.size.y, blueprint.size.z) > query.maxSize) continue;
    if (query.text != null) {
      const haystack = `${blueprint.id} ${blueprint.brief} ${blueprint.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(query.text.toLowerCase())) continue;
    }
    found.push(blueprint);
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 一行摘要：`id 16x8x16 · 320 格 · tags`。 */
export function describeBlueprint(blueprint: BlueprintMeta): string {
  const { x, y, z } = blueprint.size;
  const size = x === 0 && y === 0 && z === 0 ? '未编译' : `${x}x${y}x${z}`;
  const tags = blueprint.tags.length === 0 ? '' : ` · ${blueprint.tags.join(',')}`;
  const reusable = blueprint.reusable ? ' · 可复用' : '';
  return `${blueprint.id} ${size} · ${blueprint.blocks} 格${tags}${reusable}`;
}
