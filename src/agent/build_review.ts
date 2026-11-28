/**
 * 主模型建筑审稿：重新编译当前脚本，汇总 SELFCHECK、check、ASCII 与六视角 PNG。
 * 主模型不修改脚本；不满意时通过 SendToSubagent 打回。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { McBuild } from '../body/mcbuild.ts';
import type { ToolOutcome } from '../shared/tools.ts';
import { readBlueprint } from './blueprints.ts';

export interface BuildReviewDeps {
  blueprintsRoot: string;
  blueprintId: string;
  sessionId: string;
  revision: number;
  mcBuild: McBuild;
  mc: () => string | null;
  vision: boolean;
  /** 可选：完整 preview 参数数组，用于裁剪、透视、标尺、分组高亮等细节审查。 */
  previewArgs?: readonly string[];
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error(`${label} 输出不是 JSON：${error instanceof Error ? error.message : String(error)}\n${stdout}`);
  }
}

function textFile(path: string | null | undefined): string {
  return path != null && existsSync(path) ? readFileSync(path, 'utf8') : '（没有对应文件）';
}

function within(root: string, target: string): boolean {
  const full = resolve(root, target);
  return full === root || full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export async function reviewBuild(deps: BuildReviewDeps): Promise<ToolOutcome> {
  const meta = readBlueprint(deps.blueprintsRoot, deps.blueprintId);
  if (meta == null) return { text: `审稿失败：没有这个蓝图：${deps.blueprintId}` };
  const mc = deps.mc();
  if (mc == null) return { text: '审稿失败：还不知道目标 Minecraft 版本' };
  const dir = meta.dir;

  const built = await deps.mcBuild.run(['build', 'script.js', '-o', 'plan.schem', '--mc', mc, '--json'], dir);
  if (built.code !== 0) {
    return { text: `审稿失败：编译退出码 ${built.code}\n${built.stderr || built.stdout}` };
  }

  let summary: {
    size?: { x: number; y: number; z: number };
    nonAir?: number;
    paletteSize?: number;
    warnings?: string[];
    selfcheck?: {
      ok?: boolean;
      errors?: unknown[];
      warnings?: unknown[];
      images?: { view?: string; path?: string }[];
      asciiPath?: string;
      planPath?: string;
    } | null;
  };
  try {
    summary = parseJson(built.stdout, 'mc-build build') as typeof summary;
  } catch (error: unknown) {
    return { text: `审稿失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const checked = await deps.mcBuild.run(['check', 'plan.schem', '--json'], dir);
  let checkText: string;
  if (checked.code === 0) {
    checkText = checked.stdout;
  } else {
    checkText = `check 退出码 ${checked.code}\n${checked.stderr || checked.stdout}`;
  }

  const selfcheck = summary.selfcheck ?? null;
  const images = selfcheck?.images ?? [];
  let detailText = '';
  let detailPath: string | null = null;
  if (deps.previewArgs != null) {
    const args = [...deps.previewArgs];
    if (args[0] !== 'preview') return { text: '审稿失败：详细预览只允许 preview 子命令' };
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-o' || arg === '--out') {
        const value = args[++i];
        if (value == null || !within(dir, value)) return { text: `审稿失败：预览输出路径越界：${value ?? '（缺路径）'}` };
        detailPath = resolve(dir, value);
      } else if (!arg.startsWith('-') && /[\\/]|\.(schem|png)$/i.test(arg) && !within(dir, arg)) {
        return { text: `审稿失败：预览输入路径越界：${arg}` };
      }
    }
    const preview = await deps.mcBuild.run(args, dir);
    detailText = `详细预览（退出码 ${preview.code}）：\n${preview.stdout}${preview.stderr === '' ? '' : `\n[stderr]\n${preview.stderr}`}`;
  }
  const lines = [
    `建筑审稿：${deps.sessionId} revision ${deps.revision} / ${meta.id}`,
    `原始需求：${meta.brief}`,
    `标签：${meta.tags.join(', ') || '（无）'}`,
    `可复用：${meta.reusable ? '是' : '否'}`,
    `尺寸：${summary.size ? `${summary.size.x}x${summary.size.y}x${summary.size.z}` : '未知'}`,
    `非空气方块：${summary.nonAir ?? meta.blocks}`,
    `palette：${summary.paletteSize ?? '未知'}`,
    `材料：${JSON.stringify(meta.materials, null, 2)}`,
    '',
    `SELFCHECK ${selfcheck == null ? '未返回' : selfcheck.ok === true ? 'OK' : 'FAIL'}`,
    `错误：${JSON.stringify(selfcheck?.errors ?? [], null, 2)}`,
    `警告：${JSON.stringify(selfcheck?.warnings ?? summary.warnings ?? [], null, 2)}`,
    '',
    'CHECK：',
    checkText,
    '',
    'ASCII 侧影：',
    textFile(selfcheck?.asciiPath ?? join(dir, 'plan.ascii.txt')),
    '',
    'ASCII 平面图：',
    textFile(selfcheck?.planPath ?? join(dir, 'plan.ascii-plan.txt')),
    ...(detailText === '' ? [] : ['', detailText]),
    '',
    '图片：',
    ...images.map((image) => image.path ?? `（${image.view ?? 'unknown'} 没有路径）`),
    ...(detailPath == null ? [] : [detailPath]),
  ];

  const outputImages: { data: string; mimeType: string }[] = [];
  if (deps.vision) {
    for (const image of images) {
      if (image.path == null || !existsSync(image.path)) continue;
      outputImages.push({ data: readFileSync(image.path).toString('base64'), mimeType: 'image/png' });
    }
    if (detailPath != null && existsSync(detailPath)) {
      outputImages.push({ data: readFileSync(detailPath).toString('base64'), mimeType: 'image/png' });
    }
  }
  return { text: lines.join('\n'), ...(outputImages.length === 0 ? {} : { images: outputImages }) };
}
