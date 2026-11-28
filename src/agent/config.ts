/**
 * 配置：供应商一个文件，Bot 一个目录。
 *
 *   providers/<id>.json      供应商：用 pi-ai 的哪个 provider 模块/工厂、默认模型
 *   bots/<name>/bot.json     这个 Bot 引用哪个供应商的哪个模型、人设/提示词文件、MC 连接
 *
 * 目录本身就是身份：会话、日志、截图、bot.json 都在 `bots/<name>/` 下。
 * 环境变量仍然可用（优先级见 README），方便临时覆盖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import type { ModelThinkingLevel, Models } from '@earendil-works/pi-ai';

export interface ProviderConfig {
  /** 期望的 provider id；和工厂产出的 id 不一致会报错。 */
  id?: string;
  name?: string;
  /** pi-ai 的 provider 模块，例如 `@earendil-works/pi-ai/providers/deepseek`。 */
  module: string;
  /** 该模块导出的工厂函数名，例如 `deepseekProvider`。 */
  factory: string;
  defaultModel?: string;
  /** 可选：这个供应商允许的模型 id 列表；填了就校验。 */
  models?: readonly string[];
}

export interface BotConfig {
  provider?: string;
  model?: string;
  /** 思考等级；`off` 关闭思考模式。 */
  thinking?: ModelThinkingLevel;
  /** 系统提示词文件（相对 Bot 目录）。 */
  systemPromptFile?: string;
  /** 出生消息文件（相对 Bot 目录）。 */
  initMessageFile?: string;
  /** 人设文件（相对 Bot 目录）。预留 ST 角色卡；有内容就追加到系统提示词。 */
  personaFile?: string;
  mc?: {
    host?: string;
    port?: number;
    username?: string;
    version?: string;
    auth?: 'offline' | 'microsoft';
  };
  vision?: boolean;
  /** 自动战斗（KillAura/危险提醒）；默认 true。手动 attack 工具不受影响。 */
  combat?: boolean;
  /** 在游戏聊天框里逐条打印模型工具调用；默认 false（环境变量 TOOL_CHAT=1 可开）。 */
  toolChat?: boolean;
  /** 建筑：mc-build 位置与架构师模型覆盖。 */
  build?: {
    mcBuildDir?: string;
    architect?: { provider?: string; model?: string };
  };
}

export interface LoadedBot {
  name: string;
  /** 相对工作目录，例如 `bots/alice`。 */
  dir: string;
  config: BotConfig;
}

function readJson<T>(path: string, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${label} 不存在：${path}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    throw new Error(`${label} JSON 解析失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 读 `providers/<id>.json`。 */
export function loadProvider(root: string, id: string): ProviderConfig {
  const path = join(root, 'providers', `${id}.json`);
  return readJson<ProviderConfig>(path, `供应商配置 ${id}`);
}

/** 读 `bots/<name>/bot.json`；没有文件就是空配置（全部走环境变量/默认值）。 */
export function loadBot(root: string, name: string): LoadedBot {
  const dir = `bots/${name}`;
  const path = join(root, dir, 'bot.json');
  const config = existsSync(path) ? readJson<BotConfig>(path, `Bot 配置 ${name}`) : {};
  return { name, dir, config };
}

/** 读 Bot 目录下的文本文件；显式配置了但文件缺失就报错，不静默。 */
export function readBotText(bot: LoadedBot, file: string | undefined, root: string): string | null {
  if (file == null || file === '') return null;
  const path = join(root, bot.dir, file);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Bot ${bot.name} 配置的文件不存在：${path}`);
  }
}

/** 系统提示词：环境变量 > Bot 文件 > 内置；再把人设（如果有）追加在后面。 */
export function resolveSystemPrompt(
  bot: LoadedBot,
  root: string,
  fallback: string,
  envPrompt: string | undefined,
): string {
  const fromFile = readBotText(bot, bot.config.systemPromptFile, root);
  let prompt = envPrompt ?? fromFile ?? fallback;
  const persona = readBotText(bot, bot.config.personaFile, root);
  if (persona != null && persona.trim() !== '') prompt = `${prompt}\n\n## 人设\n${persona.trim()}`;
  return prompt;
}

/** 出生消息：环境变量 > Bot 文件 > 内置。 */
export function resolveInitMessage(
  bot: LoadedBot,
  root: string,
  fallback: string,
  envMessage: string | undefined,
): string {
  return envMessage ?? readBotText(bot, bot.config.initMessageFile, root) ?? fallback;
}

export { readJson };

/** 可用的思考等级（deepseek-flash 实际支持 off / low / high / max）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'] as const;

/** 思考等级：环境变量优先于 bot.json；默认 off。非法值直接报错。 */
export function resolveThinkingLevel(config: BotConfig, envThinking: string | undefined): ModelThinkingLevel {
  const raw = envThinking ?? config.thinking ?? 'off';
  if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`无效的 thinking 等级：${raw}（可选 ${THINKING_LEVELS.join('/')}）`);
  }
  return raw as ModelThinkingLevel;
}

/** 解析 `.env`：KEY=VALUE，忽略空行/注释，去掉外层引号。不碰 process.env。 */
export function loadDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const matched = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (matched == null) continue;
    const name = matched[1];
    let value = matched[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[name] = value;
  }
  return vars;
}

/** 把 `.env` 灌进 process.env；**已存在的变量不覆盖**（环境变量优先）。 */
export function applyDotEnv(root: string): void {
  for (const [name, value] of Object.entries(loadDotEnv(join(root, '.env')))) {
    if (process.env[name] == null) process.env[name] = value;
  }
}

/** 按配置动态加载 provider 模块并注册进一个 Models。 */
export async function openProvider(
  config: ProviderConfig,
  expectedId?: string,
  root: string = process.cwd(),
): Promise<{ models: Models; providerId: string; providerName: string }> {
  // `module` 可以是 npm 包（@scope/pkg），也可以是仓库里的相对路径（providers/*.ts）。
  // 相对路径按配置根目录解析——provider 配置文件里写的是仓库里的代码文件。
  const specifier =
    config.module.startsWith('.') || existsSync(resolve(root, config.module))
      ? pathToFileURL(resolve(root, config.module)).href
      : config.module;
  const loaded = (await import(specifier)) as Record<string, unknown>;
  const factory = loaded[config.factory];
  if (typeof factory !== 'function') {
    throw new Error(`供应商模块 ${config.module} 没有导出工厂 ${config.factory}`);
  }
  const built = (factory as () => unknown)();
  // deepseek 这类工厂直接返回 Provider；faux 这类返回 { provider, … } 的 wrapper。
  const provider = (built as { provider?: { id?: string; name?: string } }).provider ?? built;
  const id = (provider as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(`供应商模块 ${config.module} 的工厂没有产出带 id 的 Provider`);
  }
  if (expectedId != null && id !== expectedId) {
    throw new Error(`供应商配置文件是 ${expectedId}，但模块产出的 provider id 是 ${id}`);
  }
  const models = createModels();
  models.setProvider(provider as Parameters<typeof models.setProvider>[0]);
  const name = (provider as { name?: unknown }).name;
  return { models, providerId: id, providerName: typeof name === 'string' ? name : id };
}
