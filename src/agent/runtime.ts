/**
 * 装配：storage + models + 扩展 → 一个可驱动的会话。
 *
 * v0-a 用 MemoryStorage；落盘换成 sqlite 是同一个接口（下一轮接）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import type { CompactionSettings } from '@earendil-works/pi-durable';
import type {
  Conversation,
  HarnessOptions,
  HookRegistration,
  ModelRef,
  PromptSection,
  Storage,
  ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai';
import { systemSection, tailHook } from './loop.ts';

export interface RuntimeOptions {
  models: Models;
  model: ModelRef;
  /** 思考等级；`off` 关闭思考模式。不给就用 pi-durable 的默认。 */
  thinkingLevel?: ModelThinkingLevel;
  storage: Storage;
  systemPrompt: () => string;
  /** 每轮尾巴（世界快照 / 目标）。不给就没有动态尾巴。 */
  tail?: () => string;
  /** 每轮现拍一张（base64 JPEG）；拍不到返回 null 就只给文本。 */
  image?: () => Promise<string | null>;
  tools?: readonly ToolRegistration[];
  /** 额外 hook（请求标志、日志）。 */
  hooks?: readonly HookRegistration[];
  /** 上下文压缩策略（小上下文模型要更早压缩）；不给用 pi-durable 默认。 */
  compaction?: CompactionSettings;
  /** 执行环境（编码工具需要；不给则这些工具执行时报错）。 */
  env?: HarnessOptions['env'];
  /** 扩展名，只影响日志与选择。 */
  name?: string;
}

export interface AgentRuntime {
  harness: Harness;
  conversation: Conversation;
  close(): Promise<void>;
}

export async function openRuntime(options: RuntimeOptions): Promise<AgentRuntime> {
  const sections: PromptSection[] = [systemSection(options.systemPrompt)];
  const hooks: HookRegistration[] = [
    ...(options.tail == null ? [] : [tailHook(options.tail, options.image)]),
    ...(options.hooks ?? []),
  ];

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: options.name ?? 'baseline',
      sections,
      hooks,
      tools: options.tools ?? [],
    }),
  );

  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      ...(options.env == null ? {} : { env: options.env }),
    },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: options.model,
      ...(options.thinkingLevel == null ? {} : { thinkingLevel: options.thinkingLevel }),
    },
  });

  return {
    harness,
    conversation,
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
