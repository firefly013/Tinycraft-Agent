/**
 * 一次真实的设计会话：第二个 pi-durable Harness + 一组窄工具。
 *
 * 架构师不“重新发明” mc-build 的接口：它拿一个 `runMcBuild(args)`，把
 * build / preview / check / assets 原样透传。这样 mc-build 的每一种能力
 * （任意相机、裁剪、透视、标尺、分组审计、构件扫描）都直接可用，
 * 也不会随 mc-build 增加参数而过时。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage, defineTool } from '@earendil-works/pi-durable';
import type { HookRegistration, ModelRef, ToolRegistration } from '@earendil-works/pi-durable';
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai';
import type { BuildSummary, McBuild } from '../body/mcbuild.ts';
import { listBlueprints } from './blueprints.ts';
import type { DesignInput, DesignResult, DesignSession } from './architect.ts';
import { openRuntime } from './runtime.ts';

export interface DesignSessionDeps {
  models: Models;
  model: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  blueprintsRoot: string;
  /** 允许架构师读写的根目录（`bots/<name>/build`）。 */
  workspaceRoot: string;
  mcBuild: McBuild;
  mc: () => string | null;
  hooks?: readonly HookRegistration[];
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 架构师看到的世界。 */
function architectPrompt(vision: boolean): string {
  return [
    '你是 Minecraft 建筑架构师。你的产物是一份能通过自检的蓝图，不是聊天。',
    '',
    '工作目录：当前蓝图目录。script.js 与 plan.schem 归你；其它产物（png / ascii）也写在这里。',
    '',
    '工具：',
    '- writeScript / readScript：写/读 script.js（整份覆盖）。',
    '- runMcBuild(args)：直接调用 mc-build CLI，参数原样透传。只允许 build / preview / check / assets。',
    '    例：["build","script.js","-o","plan.schem","--mc","1.21.4","--views","main,south,top","--json"]',
    '    例：["preview","plan.schem","-o","door.png","--crop","2,0,2,6,4,6","--persp","--ascii"]',
    '    例：["check","plan.schem","--json"]',
    '    例：["assets",".","--json"]',
    '- listBlueprints(query?)：我们自己的蓝图库（含 reusable 标记）。',
    vision ? '- viewImage(path)：把生成的 PNG 读进上下文，真的看一眼。' : '- （本次模型不支持图片输入，用 --ascii 与事实栏判断。）',
    '- finish(summary,tags,reusable)：交卷；内部会重新编译并校验 SELFCHECK。',
    '',
    'mc-build 能力速查：',
    '  build   --mc VERSION --views a,b,c --group-report --timeout MS --json',
    '  preview --view NAME | --azimuth D --elevation D | --eye x,y,z --target x,y,z',
    '          --crop x0,y0,z0,x1,y1,z1 --persp [--fov D] --zoom N --ruler [STEP]',
    '          --orbit N --highlight-group NAME --highlight-unconnected --ascii',
    '  check   [--json]        逐条校验 palette',
    '  assets  <dir> [--json]  扫构件库（defineComponent）与 .schem 成品',
    '',
    'Builder API（脚本里）：fill/set/get/walls/line/terrain/flattenArea；',
    '  drawRoofBounds/drawPyramid/drawPolyRoof/setDoor/drawSpiralStairs/drawHanging；',
    '  drawSphere/drawEllipsoid/drawCylinder/drawTorus/drawPolygon/drawBezier；',
    '  drawText/drawImage/importMesh/pasteSchem/setSign；',
    '  defineComponent/placeComponent/beginGroup/endGroup/randomAt/pickAt。',
    '方块状态可写 \'oak_stairs?facing=east\'，L2 会补全其余属性。',
    '',
    '工作方式（重要）：',
    '1. 先写脚本并 build。用 --views 只挑你要看的立面，别每次都渲全部。',
    '2. 读 SELFCHECK 的坐标簇：悬空、不连通、楼梯无支撑。用 preview --crop 放大问题区域，',
    '   用 --persp 看空间感，用 --ruler 看大场地，用 --ascii 拿文本侧影。',
    '3. 有图片能力就 viewImage 看 PNG；没有就靠 ASCII 与事实栏。',
    '4. 复杂构件先 assets 扫已有蓝图/构件库，能 pasteSchem/use 就不重写。',
    '5. finish 之前自检必须通过；finish 会再编译一次，失败就不算交卷。',
    '6. 小建筑 3~6 次 build 内收尾；大建筑可以多，但每次 build 要解决一个具体问题，不要无限打磨。',
  ].join('\n');
}

interface FinishPayload {
  summary: string;
  tags: string;
  reusable: boolean;
}

const textResult = (text: string): { output: [{ type: 'text'; text: string }] } => ({
  output: [{ type: 'text' as const, text }],
});

const clamp = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n……（截断 ${text.length - limit} 字符）`;

function within(root: string, target: string): boolean {
  const full = resolve(target);
  return full === root || full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 只允许读写的路径落在工作区里；参数里看起来像路径的都要检查。 */
function guardArgs(args: readonly string[], cwd: string, workspace: string): string | null {
  const pathLike = (value: string): boolean => /[\\/]/.test(value) || /\.(js|ts|schem|schematic|png|json|txt)$/i.test(value);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--out') {
      const value = args[++i];
      if (value == null) return '-o 缺路径';
      if (!within(workspace, resolve(cwd, value))) return `输出路径越界：${value}`;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (!pathLike(arg)) continue;
    if (!within(workspace, resolve(cwd, arg))) return `路径越界：${arg}`;
  }
  return null;
}

const ALLOWED_VERBS = new Set(['build', 'preview', 'check', 'assets']);

export function createDesignSession(deps: DesignSessionDeps): DesignSession {
  const workspace = resolve(deps.workspaceRoot);
  const vision = deps.models.getModel(deps.model.provider, deps.model.modelId)?.input.includes('image') === true;
  const debug = process.env.DESIGN_DEBUG === '1';
  const note = (text: string): void => {
    if (debug) console.error(`[architect] ${text}`);
  };

  return {
    async run(input: DesignInput): Promise<DesignResult | null> {
      const dir = resolve(input.blueprintDir);
      const scriptPath = join(dir, 'script.js');
      const schemPath = join(dir, 'plan.schem');
      const state: { lastBuild: BuildSummary | null; finished: FinishPayload | null } = {
        lastBuild: null,
        finished: null,
      };

      const tools: ToolRegistration[] = [
        defineTool({
          name: 'writeScript',
          description: '写入 script.js（整份覆盖）。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
            additionalProperties: false,
          },
          execute: async (args: unknown) => {
            const { content } = args as { content: string };
            note(`writeScript ${content.length} 字符`);
            writeFileSync(scriptPath, content);
            return textResult(`已写入 script.js（${content.length} 字符）`);
          },
        }),
        defineTool({
          name: 'readScript',
          description: '读回 script.js。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => {
            try {
              return textResult(readFileSync(scriptPath, 'utf8'));
            } catch {
              return textResult('（还没有 script.js）');
            }
          },
        }),
        defineTool({
          name: 'runMcBuild',
          description: '直接调用 mc-build：build / preview / check / assets，参数原样透传。',
          parameters: {
            type: 'object',
            properties: { args: { type: 'array', items: { type: 'string' } } },
            required: ['args'],
            additionalProperties: false,
          },
          execute: async (raw: unknown) => {
            const { args } = raw as { args: string[] };
            if (!Array.isArray(args) || args.length === 0) return textResult('args 需要一个非空数组');
            const verb = args[0];
            if (!ALLOWED_VERBS.has(verb)) return textResult(`不允许的子命令：${verb}（只能是 build / preview / check / assets）`);
            const guard = guardArgs(args, dir, workspace);
            if (guard != null) return textResult(guard);
            note(`runMcBuild ${args.join(' ')}`);
            const result = await deps.mcBuild.run(args, dir);
            note(`runMcBuild → 退出码 ${result.code}`);
            const out = clamp(result.stdout.trim(), 12_000);
            const err = clamp(result.stderr.trim(), 4_000);
            return textResult(
              `退出码 ${result.code}\n${out === '' ? '(stdout 为空)' : out}` + (err === '' ? '' : `\n[stderr]\n${err}`),
            );
          },
        }),
        defineTool({
          name: 'listBlueprints',
          description: '列出已有蓝图；可复用的可以直接 pasteSchem。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            additionalProperties: false,
          },
          execute: async (args: unknown) => {
            const { query } = args as { query?: string };
            const all = listBlueprints(deps.blueprintsRoot, query == null ? {} : { text: query });
            if (all.length === 0) return textResult('（还没有蓝图）');
            const lines = all
              .slice(0, 40)
              .map(
                (blueprint) =>
                  `${blueprint.id} ${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z} · ${blueprint.blocks} 格${blueprint.reusable ? ' 可复用' : ''}${blueprint.tags.length === 0 ? '' : ` [${blueprint.tags.join(',')}]`}`,
              );
            return textResult(lines.join('\n'));
          },
        }),
        ...(vision
          ? [
              defineTool({
                name: 'viewImage',
                description: '把生成的 PNG 读进上下文（只看工作区内的文件）。',
                parameters: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                  required: ['path'],
                  additionalProperties: false,
                },
                execute: async (args: unknown) => {
                  const { path } = args as { path: string };
                  note(`viewImage ${path}`);
                  const full = resolve(dir, path);
                  if (!within(workspace, full)) return textResult(`路径越界：${path}`);
                  try {
                    if (statSync(full).size > MAX_IMAGE_BYTES) return textResult(`图片太大：${path}`);
                    const data = readFileSync(full);
                    return {
                      output: [
                        { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/png' },
                        { type: 'text' as const, text: `${path}（${data.length} 字节）` },
                      ],
                    };
                  } catch (error: unknown) {
                    return textResult(`读不到图片：${error instanceof Error ? error.message : String(error)}`);
                  }
                },
              }),
            ]
          : []),
        defineTool({
          name: 'finish',
          description: '交卷：内部会重新编译并校验 SELFCHECK，不通过就不算完成。',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              tags: { type: 'string' },
              reusable: { type: 'boolean' },
            },
            required: ['summary', 'tags', 'reusable'],
            additionalProperties: false,
          },
          execute: async (args: unknown) => {
            note('finish（内部重新编译校验）');
            const mc = deps.mc();
            if (mc == null) return textResult('还不知道目标 MC 版本，不能交卷');
            const outcome = await deps.mcBuild.build('script.js', 'plan.schem', { mc, cwd: dir });
            if (!outcome.ok) {
              const detail = (outcome.stderr || outcome.stdout || '').trim().slice(0, 2000);
              note(`finish 失败：编译 ${outcome.code}`);
              return textResult(`交卷失败：编译没过（退出码 ${outcome.code}）\n${detail}`);
            }
            if (outcome.summary.selfcheck != null && !outcome.summary.selfcheck.ok) {
              note(`finish 失败：SELFCHECK ${outcome.summary.selfcheck.errors}`);
              return textResult(`交卷失败：SELFCHECK 还有 ${outcome.summary.selfcheck.errors} 个 error，先改脚本。`);
            }
            state.lastBuild = outcome.summary;
            const payload = args as FinishPayload;
            state.finished = {
              summary: payload.summary,
              tags: payload.tags ?? '',
              reusable: payload.reusable === true,
            };
            return {
              output: [{ type: 'text' as const, text: '收到，收工。' }],
              control: { terminate: true },
            };
          },
        }),
      ];

      const runtime = await openRuntime({
        models: deps.models,
        model: deps.model,
        ...(deps.thinkingLevel == null ? {} : { thinkingLevel: deps.thinkingLevel }),
        storage: new MemoryStorage(),
        systemPrompt: () => architectPrompt(vision),
        tools,
        hooks: deps.hooks ?? [],
        name: `architect:${input.blueprintId}`,
      });

      const abort = (): void => {
        void runtime.conversation.abort(BACKGROUND_CONTEXT);
      };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener('abort', abort, { once: true });

      try {
        const content = input.notes == null ? input.brief : `${input.brief}\n\n返工要求：${input.notes}`;
        const submission = await runtime.conversation.submit(
          { type: 'input', content, whenBusy: 'reject' },
          BACKGROUND_CONTEXT,
        );
        await submission.wait(BACKGROUND_CONTEXT);
      } finally {
        note(`会话结束：${input.blueprintId}`);
        input.signal.removeEventListener('abort', abort);
        await runtime.close();
      }

      const finished = state.finished;
      const lastBuild = state.lastBuild;
      if (finished == null || lastBuild == null || input.signal.aborted) return null;
      const plan = await deps.mcBuild.emit(schemPath, { x: 0, y: 0, z: 0 }, { cwd: dir });
      const materials: Record<string, number> = {};
      if (plan.ok) {
        for (const block of plan.plan.blocks) {
          const name = block.state.replace(/^minecraft:/, '').split('[')[0];
          materials[name] = (materials[name] ?? 0) + 1;
        }
      }
      return {
        summary: finished.summary,
        tags: finished.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
        reusable: finished.reusable,
        size: lastBuild.size,
        blocks: lastBuild.blocks,
        materials,
      };
    },
  };
}
