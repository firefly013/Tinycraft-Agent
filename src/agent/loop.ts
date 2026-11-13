/**
 * pi-durable 原语：静态提示词、每轮尾巴、工具声明 → 注册项。
 *
 * 静态提示词走 section（只发增量，保 provider 缓存）；每轮变化的世界快照走
 * beforeRequest（只影响本次请求，不落 transcript）。
 */
import { GenerationTask, defineTool, hook, section } from '@earendil-works/pi-durable';
import type { HookRegistration, PromptSection, ToolRegistration } from '@earendil-works/pi-durable';
import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import type { ToolDeclaration, ToolOutcome } from '../shared/tools.ts';

/** 静态提示词：`tag: false` 表示原样渲染，不加 `<key>` 包裹。 */
export function systemSection(render: () => string): PromptSection {
  return section('system', render, { tag: false });
}

/**
 * 每轮请求前把动态尾巴作为最后一条 user 消息；空尾巴且没有图就不加。
 * 有图时 content 是消息数组（pi-ai 的 user content 支持 image part）。
 */
export function tailHook(tail: () => string, image?: () => Promise<string | null>): HookRegistration {
  const append = (
    request: { readonly messages: readonly Message[] },
    raw: string,
    shot: string | null,
  ): { readonly messages: readonly Message[] } | undefined => {
    const text = raw.trim();
    if (text === '' && shot == null) return undefined;
    const parts: (TextContent | ImageContent)[] = [
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...(shot == null ? [] : [{ type: 'image' as const, data: shot, mimeType: 'image/jpeg' }]),
    ];
    const content: string | (TextContent | ImageContent)[] = shot == null ? text : parts;
    return {
      messages: [...request.messages, { role: 'user', content, timestamp: Date.now() }],
    };
  };

  return hook(GenerationTask, {
    beforeRequest: async (request) => {
      // **先把这一帧拍下来，再采世界快照**：快照里的截图文件名/朝向必须是
      // 同一张图；并发执行会让快照引用上一帧。
      const shot = image == null ? null : await image().catch(() => null);
      const text = await Promise.resolve(tail());
      return append(request, text, shot);
    },
  });
}

/** 工具声明 → JSON Schema。只描述输入，别的什么都不做。 */
export function declarationSchema(declaration: ToolDeclaration): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(declaration.params ?? {})) {
    const type = param.type === 'int' ? 'integer' : param.type === 'float' ? 'number' : param.type;
    properties[name] = {
      type,
      ...(param.description == null ? {} : { description: param.description }),
    };
    if (param.optional !== true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

/** 工具执行：由装配方注入（走身体通道），返回给模型看的文本 + 是否结束本轮。 */
export type ToolRun = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

/**
 * 工具声明 → pi-durable 工具注册项。
 *
 * `terminate` 走框架的 `ToolControl`：本轮 run 到此结束、不再发下一次请求。
 * 异步动作的 accepted 回执带它，模型才真的能"发完就睡"。
 */
export function toToolRegistration(declaration: ToolDeclaration, run: ToolRun): ToolRegistration {
  return defineTool({
    name: declaration.name,
    description: declaration.description,
    parameters: declarationSchema(declaration),
    execute: async (args: unknown) => {
      const outcome = await run(declaration.name, (args ?? {}) as Record<string, unknown>);
      return {
        output: [{ type: 'text' as const, text: outcome.text }],
        ...(outcome.terminate === true ? { control: { terminate: true } } : {}),
      };
    },
  }) as unknown as ToolRegistration;
}

/** 把一批声明装成注册项：模型调工具 = 交给 Runner 的同一个入口。 */
export function runnerTools(
  runner: { tool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> },
  declarations: readonly ToolDeclaration[],
): ToolRegistration[] {
  return declarations.map((declaration) =>
    toToolRegistration(declaration, (name, args) => runner.tool(name, args)),
  );
}
