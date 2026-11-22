/**
 * 一个 bot 的完整装配：会话 + 装配线 + 身体 + 投递 + 三个本地工具。
 *
 * 身体是注入的（真机是 mineflayer，测试是假的）；这里只负责接线，
 * 不放任何判断。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { GenerationTask, hook } from '@earendil-works/pi-durable';
import type { Conversation, HookRegistration, ModelRef, Storage } from '@earendil-works/pi-durable';
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai';
import { CATALOG } from '../body/catalog.ts';
import type { CompactionSettings } from '@earendil-works/pi-durable';
import { assertUniquePriorities } from '../core/reflex.ts';
import type { ReflexSpec } from '../core/reflex.ts';
import type { TraceNote } from '../core/trace.ts';
import type { Body } from '../shared/body.ts';
import { createIntakeDeps } from './bridge.ts';
import { GoalDoc } from './goal.ts';
import { createRequestLog, loggingHooks } from './log.ts';
import type { Logger } from './log.ts';
import { runnerTools } from './loop.ts';
import { Runner } from './runner.ts';
import { openRuntime } from './runtime.ts';

const MAX_CHAT_CHARS = 256;

/** 模型正文直接进公聊：按行/256 字符（Minecraft 聊天上限）切块，空行丢掉，不吞内容。 */
export function splitChatText(text: string): string[] {
  const chunks: string[] = [];
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    for (let i = 0; i < line.length; i += MAX_CHAT_CHARS) {
      chunks.push(line.slice(i, i + MAX_CHAT_CHARS));
    }
  }
  return chunks;
}

/** 单一目标：出现在快照里，也由 UpdateGoal 写入。 */
export interface GoalStore {
  value: string | null;
}

export interface BodyWithReflex extends Body {
  snapshot(): string;
  /** 每轮现拍一张（base64 JPEG）；返回 null 就只给文本。 */
  captureBase64?: () => Promise<string | null>;
  /** 反射执行体；不给就只跑模型在环（v0）。 */
  reflex?: (name: string, signal: AbortSignal) => Promise<void>;
}

/** 建筑：设计任务的外壳与蓝图查询；不配就是没有这 6 个工具。 */
export interface BuildingBridge {
  design(brief: string, tags?: string): string;
  rework(blueprint: string, notes: string): string;
  cancel(task: string): boolean;
  list(query?: string): string;
}

/** 建筑相关的 6 个工具：没配置建筑时整组不交给模型。 */
export const BUILDING_TOOLS: ReadonlySet<string> = new Set([
  'DesignBuild',
  'ReworkDesign',
  'CancelDesign',
  'ListBlueprints',
  'BuildAt',
  'UndoBuild',
]);

export interface BaselineOptions {
  models: Models;
  model: ModelRef;
  /** 思考等级；off 关闭思考模式。 */
  thinkingLevel?: ModelThinkingLevel;
  storage: Storage;
  /** 身体。必须能出每轮快照；有反射的话顺便提供执行体。 */
  body: BodyWithReflex;
  systemPrompt: string;
  goal: GoalStore;
  /** 把一句话发到游戏公聊（模型正文自动公聊用）。 */
  say: (text: string) => void;
  /** 每次工具调用时回调（用于在聊天框逐条打印）。 */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** 反射表。空数组表示没装反射。 */
  reflexes?: readonly ReflexSpec[];
  /** 建筑：设计任务与蓝图查询；不给就隐藏这 6 个工具。 */
  building?: BuildingBridge;
  /** 控制面转移的观测出口（TRACE=1 时接到日志）。 */
  onTrace?: (note: TraceNote) => void;
  /** 结构化日志。不给就完全不打日志（测试默认）。 */
  logger?: Logger;
  /** 交给模型的工具名子集（小模型/精简模式）；不给就是全部 CATALOG。 */
  tools?: readonly string[];
  /** 单条工具回执的字符上限；不给用 Runner 默认（20k）。 */
  maxToolOutputChars?: number;
  /** 上下文压缩策略；不给用 pi-durable 默认。 */
  compaction?: CompactionSettings;
  /** 公聊长度上限（每个回复只发第一行、最多这么多字）；不给就不限。小模型防刷屏。 */
  chatMaxChars?: number;
  /** 每轮强制模型调用工具（required）；默认 auto。小模型靠这个不再"只回文字"。 */
  toolChoice?: 'auto' | 'required';
  /** 额外 hook（Token 预算等）；由装配方注入，不改变工具面。 */
  extraHooks?: readonly HookRegistration[];
}

/**
 * provider 请求体的 `tool_choice` 注入。
 *
 * pi-durable 的 stream 设置不透传 toolChoice，但兼容接口都认请求体里的 `tool_choice`
 * （硅基流动实测 required / 指定函数 / none 都是 200）。只在有工具时注入：
 * 压缩/摘要请求没有工具，带 required 会被上游 400。
 */
export function withToolChoice(payload: unknown, choice: 'auto' | 'required'): unknown {
  if (choice === 'auto') return undefined;
  if (payload == null || typeof payload !== 'object') return undefined;
  const body = payload as { tools?: unknown };
  if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined;
  return { ...body, tool_choice: choice };
}

export interface Baseline {
  runner: Runner;
  conversation: Conversation;
  /** 真正交给模型注册表的工具名；用于自检与测试。 */
  toolNames: readonly string[];
  /** 起一轮：发一条用户消息。 */
  kick(content: string): Promise<void>;
  close(): Promise<void>;
}

export async function startBaseline(options: BaselineOptions): Promise<Baseline> {
  // 反射表是配置：优先级重复会让"谁先跑"说不清，启动时就炸掉。
  if (options.reflexes != null) assertUniquePriorities(options.reflexes);
  let runner: Runner | null = null;

  // 请求标志：整流只看 provider 请求是否在飞。
  //   一次 assistant 响应结束（afterResponse）就是投递边界；
  //   不能挂 afterRun——工具连招可以让一个 run 持续很久，L3 会永远攒着。
  const requestHooks = hook(GenerationTask, {
    beforeRequest: () => {
      runner?.requestStarted();
      return undefined;
    },
    afterResponse: () => {
      runner?.requestFinished();
      return undefined;
    },
  });

  // tool_choice=required：让模型每轮必须调工具（4B 经常只回一段文字就不动了）。
  const toolChoiceHook = hook(GenerationTask, {
    beforeProviderRequest: ({ payload }) => {
      const replaced = withToolChoice(payload, options.toolChoice ?? 'auto');
      return replaced === undefined ? undefined : { payload: replaced };
    },
  });

  const chatHook = hook(GenerationTask, {
    afterResponse: (message) => {
      if (message.stopReason === 'error' || message.errorMessage != null) return undefined;
      const text = Array.isArray(message.content)
        ? message.content
            .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : typeof message.content === 'string'
          ? message.content
          : '';
      const maxChars = options.chatMaxChars ?? null;
      const spoken =
        maxChars == null
          ? text
          : (text.split('\n').find((line) => line.trim() !== '') ?? '').slice(0, maxChars);
      for (const chunk of splitChatText(spoken)) {
        try {
          options.say(chunk);
        } catch {
          // 公聊失败不影响动作/回合。
        }
      }
      return undefined;
    },
  });

  const declared =
    options.tools == null
      ? CATALOG.filter((tool) => options.building != null || !BUILDING_TOOLS.has(tool.name))
      : CATALOG.filter(
          (tool) => options.tools!.includes(tool.name) && (options.building != null || !BUILDING_TOOLS.has(tool.name)),
        );
  const tools = [
    ...runnerTools(
      {
        tool: (name, args) => (runner == null ? Promise.resolve({ text: '还没准备好' }) : runner.tool(name, args)),
      },
      declared,
    ),
  ];

  const runtime = await openRuntime({
    models: options.models,
    model: options.model,
    ...(options.thinkingLevel == null ? {} : { thinkingLevel: options.thinkingLevel }),
    storage: options.storage,
    systemPrompt: () => options.systemPrompt,
    tail: () => options.body.snapshot(),
    ...(options.body.captureBase64 == null ? {} : { image: options.body.captureBase64 }),
    tools,
    ...(options.compaction == null ? {} : { compaction: options.compaction }),
    hooks: [
      requestHooks,
      toolChoiceHook,
      chatHook,
      ...(options.extraHooks ?? []),
      ...(options.logger == null
        ? []
        : loggingHooks({
            logger: options.logger,
            requestLog: createRequestLog({
              dir: options.logger.dir,
              tools: () => [
                ...declared.map((tool) => tool.name),
              ],
            }),
          })),
    ],
  });

  // 从文档里恢复目标：重启后模型还记得自己要干什么。
  const saved = await runtime.harness.snapshot(GoalDoc, runtime.conversation.id, BACKGROUND_CONTEXT);
  if (saved != null && saved.goal != null) options.goal.value = saved.goal;

  const bodyReflex = options.body.reflex;
  const runReflex =
    bodyReflex == null ? undefined : (name: string, signal: AbortSignal) => bodyReflex(name, signal);

  runner = new Runner({
    tools: declared,
    ...(options.maxToolOutputChars == null ? {} : { maxToolOutputChars: options.maxToolOutputChars }),
    body: options.body,
    deps: createIntakeDeps(runtime.conversation, {
      onError: (error) => console.error('[投递]', error),
    }),
    ...(options.reflexes == null ? {} : { reflexes: options.reflexes }),
    ...(runReflex == null ? {} : { runReflex }),
    ...(options.onToolCall == null ? {} : { onToolCall: options.onToolCall }),
    ...(options.onTrace == null ? {} : { onTrace: options.onTrace }),
    localTools: {
      ...(options.building == null
        ? {}
        : {
            DesignBuild: (args: Record<string, unknown>) => ({
              text: options.building!.design(String(args.brief), args.tags == null ? undefined : String(args.tags)),
              terminate: true,
            }),
            ReworkDesign: (args: Record<string, unknown>) => ({
              text: options.building!.rework(String(args.blueprint), String(args.notes)),
              terminate: true,
            }),
            CancelDesign: (args: Record<string, unknown>) =>
              options.building!.cancel(String(args.task))
                ? `已取消设计任务 ${String(args.task)}`
                : `没有在跑的设计任务：${String(args.task)}`,
            ListBlueprints: (args: Record<string, unknown>) =>
              options.building!.list(args.query == null ? undefined : String(args.query)),
          }),
      Finish: () => ({ text: '本轮结束：没有动作。等下一次事件或定时唤醒再继续。', terminate: true }),
      Stop: () => runner?.stop() ?? '还没准备好',
      UpdateGoal: async (args) => {
        const goal = String(args.goal);
        options.goal.value = goal;
        await runtime.conversation.commit(async (tx) => {
          (await tx.doc(GoalDoc, runtime.conversation.id)).goal = goal;
        }, BACKGROUND_CONTEXT);
        return `目标更新为：${goal}`;
      },
    },
  });

  return {
    runner,
    conversation: runtime.conversation,
    toolNames: tools.map((tool) => tool.name),
    kick: async (content) => {
      await runtime.conversation.submit({ type: 'input', content, whenBusy: 'steer' }, BACKGROUND_CONTEXT);
    },
    close: () => runtime.close(),
  };
}
