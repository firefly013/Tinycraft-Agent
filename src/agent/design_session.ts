/**
 * 一次真实的设计会话：第二个 pi-durable Harness + 一组窄工具。
 *
 * 窄工具是刻意的：架构师只能写脚本、编译、看结果、查蓝图、交卷。
 * 它不需要通用文件系统或 shell——施工和仓库不是它的职责。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  mcBuild: McBuild;
  mc: () => string | null;
  hooks?: readonly HookRegistration[];
}

/** 架构师看到的世界。 */
const ARCHITECT_PROMPT = [
  '你是 Minecraft 建筑架构师。你的产物是一份能通过自检的蓝图，不是聊天。',
  '',
  '工作目录：当前蓝图目录。里面只有两个文件归你：script.js（你写）与 plan.schem（编译产物）。',
  '',
  '工具：',
  '- writeScript / readScript：写/读 script.js。',
  '- runBuild：用 mc-build 编译并自检，返回尺寸、格数、SELFCHECK 结论、ASCII 侧影与预览图路径。',
  '- listBlueprints：看已有蓝图，可复用的直接 pasteSchem 进你的脚本。',
  '- finish：交卷。summary 一句话说清建了什么；tags 逗号分隔；reusable 表示这值得复用。',
  '',
  '规则：',
  '1. 至少编译一次；SELFCHECK 有 error 就不能 finish。',
  '2. 用 ASCII 侧影和事实栏检查形状：四面有没有门窗、屋顶有没有塌、比例对不对。',
  '3. 方块名必须真实（mc-build 不静默兜底）；目标版本由工具传入，不要自己猜。',
  '4. 复用已有蓝图：builder.pasteSchem(\'../<id>/plan.schem\', x, y, z)。',
  '5. 不要在脚本里用 Math.random()/Date.now()；要随机用 builder.randomAt(x,y,z)。',
  '',
  'mc-build 速查：',
  '  fill(x1,y1,z1,x2,y2,z2,type)  实心长方体，终点不包含',
  '  set / get / walls / line / terrain / flattenArea',
  '  drawRoofBounds / drawPyramid / drawPolyRoof / setDoor / drawSpiralStairs / drawHanging',
  '  drawSphere / drawEllipsoid / drawCylinder / drawTorus / drawPolygon / drawBezier',
  '  drawText / drawImage / importMesh / pasteSchem / setSign',
  '  defineComponent(name, buildFn, meta) / placeComponent(name, x, y, z, params)',
  '  beginGroup(name) / endGroup() / randomAt(x,y,z) / pickAt(x,y,z,items)',
  '方块状态可写 \'oak_stairs?facing=east\'，L2 会补全其余属性。',
].join('\n');

interface FinishPayload {
  summary: string;
  tags: string;
  reusable: boolean;
}

function textResult(text: string): { output: [{ type: 'text'; text: string }] } {
  return { output: [{ type: 'text' as const, text }] };
}

function buildReport(summary: BuildSummary): string {
  const { size, blocks, paletteSize, selfcheck } = summary;
  const head = `编译成功：${size.x}x${size.y}x${size.z} · ${blocks} 格 · palette ${paletteSize}`;
  if (selfcheck == null) return head;
  const check = selfcheck.ok ? 'SELFCHECK OK' : `SELFCHECK FAIL（${selfcheck.errors} 个 error）`;
  const ascii = selfcheck.asciiPath == null ? '' : readAscii(selfcheck.asciiPath);
  return `${head}\n${check}${ascii === '' ? '' : `\n\n${ascii}`}`;
}

function readAscii(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= 6000 ? text : `${text.slice(0, 6000)}\n……（ASCII 太长，截断）`;
  } catch {
    return '';
  }
}

export function createDesignSession(deps: DesignSessionDeps): DesignSession {
  return {
    async run(input: DesignInput): Promise<DesignResult | null> {
      const dir = input.blueprintDir;
      const scriptPath = join(dir, 'script.js');
      const schemPath = join(dir, 'plan.schem');
      const state: { lastBuild: BuildSummary | null; finished: FinishPayload | null } = { lastBuild: null, finished: null };

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
          name: 'runBuild',
          description: '编译 script.js 并自检，返回结论、ASCII 与预览路径。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => {
            const mc = deps.mc();
            if (mc == null) return textResult('还不知道目标 MC 版本，不能编译');
            const outcome = await deps.mcBuild.build('script.js', 'plan.schem', { mc, cwd: dir });
            if (!outcome.ok) {
              const detail = (outcome.stderr || outcome.stdout || '').trim().slice(0, 3000);
              return textResult(`编译失败（退出码 ${outcome.code}）：\n${detail}`);
            }
            state.lastBuild = outcome.summary;
            return textResult(buildReport(outcome.summary));
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
              .map((blueprint) => `${blueprint.id} ${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z}${blueprint.reusable ? ' 可复用' : ''}`);
            return textResult(lines.join('\n'));
          },
        }),
        defineTool({
          name: 'finish',
          description: '交卷：summary + tags + 是否可复用。SELFCHECK 通过之前不要调用。',
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
            if (state.lastBuild == null) return textResult('还没成功编译过，先 runBuild。');
            if (state.lastBuild.selfcheck != null && !state.lastBuild.selfcheck.ok) {
              return textResult('SELFCHECK 还没通过，先改脚本。');
            }
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
        systemPrompt: () => ARCHITECT_PROMPT,
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

