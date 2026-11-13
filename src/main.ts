/**
 * 入口：读配置 → 连 Minecraft → 起一个 bot。
 *
 * 配置分两层（环境变量可临时覆盖，优先级见 README）：
 *   providers/<id>.json      供应商：用 pi-ai 的哪个 provider 模块/工厂、默认模型
 *   bots/<name>/bot.json     这个 Bot：引用供应商的哪个模型、系统提示词文件、人设文件、MC 连接
 *
 * 环境变量：
 *   BOT            选哪个 Bot 目录（默认取 MC_USERNAME，再默认 BaselineBot）
 *   MC_HOST / MC_PORT / MC_USERNAME / MC_AUTH / MC_VERSION   Bot 配置没写时用
 *   MODEL_PROVIDER / MODEL_ID     bot.json 没写时用
 *   DEEPSEEK_API_KEY 等          由对应 provider 自己读
 *   SYSTEM_PROMPT / INIT_MESSAGE  覆盖 Bot 的文件（最高优先级）
 *   CONFIG_ROOT    配置/人设从哪个目录读（自我修复时指向主仓库；默认当前目录）
 *   TRACE=1        把控制面每次转移打到控制台
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { INIT_MESSAGE, SYSTEM_PROMPT } from './prompts.ts';
import { startAdmin } from './agent/admin.ts';
import type { AdminServer } from './agent/admin.ts';
import { createTokenBudget, DEFAULT_TOKEN_BUDGET } from './agent/budget.ts';
import { startBaseline } from './agent/bot.ts';
import type { Baseline } from './agent/bot.ts';
import {
  applyDotEnv,
  loadBot,
  loadProvider,
  openProvider,
  resolveInitMessage,
  resolveSystemPrompt,
  resolveThinkingLevel,
} from './agent/config.ts';
import { createLogger, startMemorySampler } from './agent/log.ts';
import type { Runner } from './agent/runner.ts';
import { createBody } from './body/index.ts';
import type { GameBody } from './body/index.ts';
import { REFLEXES } from './body/reflexes.ts';
import type { LogEvent } from './core/events.ts';
/** 聊天框播报用：工具名 + 参数；Minecraft 单条聊天有长度上限，截断。 */
const TOOL_CHAT_MAX = 230;
function formatToolCall(name: string, args: Record<string, unknown>): string {
  let detail = '';
  try {
    detail = JSON.stringify(args ?? {});
  } catch {
    detail = '{}';
  }
  const line = '[tool] ' + name + (detail === '{}' ? '' : ' ' + detail);
  return line.length <= TOOL_CHAT_MAX ? line : line.slice(0, TOOL_CHAT_MAX - 1) + '…';
}


const env = process.env;
const root = process.cwd();
// 自我修复跑在 worktree 里，但配置/人设留在主仓库：CONFIG_ROOT 指向主仓库。
const configRoot = env.CONFIG_ROOT ?? root;
// .env 是本地文件（gitignore），环境变量优先级更高。
applyDotEnv(configRoot);

// Bot 目录就是身份：bot.json、会话、日志、截图都在 bots/<name>/ 下。
const botName = env.BOT ?? env.MC_USERNAME ?? 'BaselineBot';
const bot = loadBot(configRoot, botName);

// 供应商：Bot 引用哪个就用哪个；每个供应商一个 providers/<id>.json。
const providerId = bot.config.provider ?? env.MODEL_PROVIDER ?? 'deepseek';
const providerConfig = loadProvider(configRoot, providerId);
const modelId = bot.config.model ?? env.MODEL_ID ?? providerConfig.defaultModel;
if (modelId == null || modelId === '') {
  console.error(`供应商 ${providerId} 没有 defaultModel，Bot ${botName} 也没写 model。`);
  process.exit(1);
}
if (providerConfig.models != null && !providerConfig.models.includes(modelId)) {
  console.warn(`[config] 供应商 ${providerId} 的模型列表里没有 ${modelId}，仍按配置尝试。`);
}
const { models } = await openProvider(providerConfig, providerId, configRoot);

// MC 连接：Bot 配置 > 环境变量 > 默认。
const host = bot.config.mc?.host ?? env.MC_HOST ?? '127.0.0.1';
const port = Number(bot.config.mc?.port ?? env.MC_PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error(`缺少 MC_PORT：Bot ${botName} 的 bot.json 里没写 mc.port，环境变量也没有。`);
  process.exit(1);
}
const username = bot.config.mc?.username ?? env.MC_USERNAME ?? botName;
const version = bot.config.mc?.version ?? env.MC_VERSION;
const auth = bot.config.mc?.auth ?? (env.MC_AUTH === 'microsoft' ? 'microsoft' : 'offline');
const vision = bot.config.vision ?? env.VISION !== '0';
const combat = bot.config.combat ?? env.COMBAT !== '0';
// 小模型上下文控制：工具子集 / 回执上限 / 精简快照 / 压缩阈值。
// 这些开关只影响"模型看到多少"，不改变控制面。
const toolSubset = (env.TOOLS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');
const toolOutputChars = Number(env.TOOL_OUTPUT_CHARS);
const maxToolOutputChars =
  Number.isFinite(toolOutputChars) && toolOutputChars > 0 ? Math.floor(toolOutputChars) : null;
// 小模型防"只回文字不调工具"：provider 请求体强制 tool_choice=required（无工具时自动跳过）。
const toolChoice = env.TOOL_CHOICE === 'required' ? 'required' : 'auto';
const SNAPSHOT_PROFILES: Record<string, readonly string[]> = {
  // 小模型：只留"能直接变成动作"的段落，省掉装备耐久/天气/截图。
  small: ['body', 'position', 'backpack', 'blocks', 'entities', 'goal', 'meta'],
};
const snapshotSections =
  env.SNAPSHOT != null
    ? SNAPSHOT_PROFILES[env.SNAPSHOT] ?? null
    : env.SNAPSHOT_SECTIONS == null
      ? null
      : env.SNAPSHOT_SECTIONS.split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
const numEnv = (name: string, fallback: number): number => {
  const raw = Number(env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
};
const compaction =
  env.COMPACT === 'off'
    ? { enabled: false }
    : {
        enabled: true,
        reserveTokens: numEnv('COMPACT_RESERVE_TOKENS', 4_096),
        keepRecentTokens: numEnv('COMPACT_KEEP_RECENT_TOKENS', 8_000),
        backgroundTokens: numEnv('COMPACT_BACKGROUND_TOKENS', 0),
      };// 在游戏聊天框里逐条打印模型工具调用（默认关，避免吵）。
const toolChat = bot.config.toolChat ?? env.TOOL_CHAT === '1';
const chatMaxChars = bot.config.chatMaxChars ?? (env.CHAT_MAX_CHARS == null ? undefined : Number(env.CHAT_MAX_CHARS));
let thinkingLevel;
try {
  thinkingLevel = resolveThinkingLevel(bot.config, env.THINKING);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const verbose = env.TRACE === '1';

// 提示词：环境变量 > Bot 文件 > 内置；人设文件有内容就追加在后面（ST 角色卡预留）。
const systemPrompt = resolveSystemPrompt(bot, configRoot, SYSTEM_PROMPT, env.SYSTEM_PROMPT);
const initMessage = resolveInitMessage(bot, configRoot, INIT_MESSAGE, env.INIT_MESSAGE);

const prompt = systemPrompt;

// 结构化日志：bots/<name>/logs/agent-YYYYMMDD.log + request-<页>.log
const logger = createLogger({ dir: `./${bot.dir}/logs` });
logger
  .with('boot')
  .info({ bot: botName, host, port, username, provider: providerId, model: modelId, thinking: thinkingLevel, vision, combat });

// Token 预算：跨进程重启持久化；达到上限写停机标记并退出，supervisor 也会看同一文件。
const rawBudget = Number(env.TOKEN_BUDGET ?? DEFAULT_TOKEN_BUDGET);
const tokenLimit = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : DEFAULT_TOKEN_BUDGET;
const budgetStatePath = resolve('state', 'token-budget.json');
const budgetStopPath = resolve('state', 'token-budget-exhausted');
const budget = createTokenBudget({
  statePath: budgetStatePath,
  limit: tokenLimit,
  onUpdate: (state) => {
    const percent = ((state.used / state.limit) * 100).toFixed(2);
    console.log(`[budget] ${state.used.toLocaleString()} / ${state.limit.toLocaleString()} tokens（${percent}%）`);
    logger.with('budget').info({ used: state.used, limit: state.limit, percent });
  },
  onExhausted: () => {
    try {
      mkdirSync(dirname(budgetStopPath), { recursive: true });
      writeFileSync(budgetStopPath, `${new Date().toISOString()}\n`);
    } catch {
      // 停机标记写失败也要退出。
    }
    console.error(`[budget] Token 预算耗尽（${tokenLimit.toLocaleString()}），停止 Bot。`);
    setTimeout(() => process.exit(0), 1000);
  },
});
if (budget.snapshot().used >= tokenLimit) {
  try {
    mkdirSync(dirname(budgetStopPath), { recursive: true });
    writeFileSync(budgetStopPath, `${new Date().toISOString()}\n`);
  } catch {
    // ignore
  }
  console.error(`[budget] 启动时预算已耗尽：${budget.snapshot().used.toLocaleString()} / ${tokenLimit.toLocaleString()}`);
  process.exit(0);
}

const goal = { value: null as string | null };
const dbPath = `./${bot.dir}/session.db`;
mkdirSync(dirname(dbPath), { recursive: true });
const storage = await openNodeSqliteStorage(dbPath);

// 身体的事件先收着：装配线建好之后统一转发。
const inbox: LogEvent[] = [];
let notify: ((event: LogEvent) => void) | null = null;
// 控制面在 baseline 之后才有；快照的 currentAction 用闭包延后取。
let runnerRef: Runner | null = null;
const body = createBody({
  host,
  port,
  username,
  botName,
  ...(version == null ? {} : { version }),
  auth,
  goal: () => goal.value,
  action: () => runnerRef?.actionSummary() ?? null,
  vision,
  combat,
  ...(snapshotSections == null ? {} : { snapshotSections }),
  onEvent: (event) => {
    if (notify == null) inbox.push(event);
    else notify(event);
  },
});

const say = (text: string): void => {
  // 公聊走身体的原始 bot；身体没接上就丢了，不影响动作。
  try {
    const rawBot = body.raw() as { chat?: (message: string) => void } | null;
    rawBot?.chat?.(text);
  } catch {
    // 聊天失败不影响动作。
  }
};

const baseline: Baseline = await startBaseline({
  models,
  model: { provider: providerId, modelId },
  thinkingLevel,
  storage,
  body,
  systemPrompt: prompt,
  goal,
  reflexes: REFLEXES,
  ...(toolSubset.length === 0 ? {} : { tools: toolSubset }),
  ...(maxToolOutputChars == null ? {} : { maxToolOutputChars }),
  compaction,
  onTrace: (note) => {
    logger.with('trace').debug({ kind: note.kind, detail: note.detail });
    if (verbose) console.log(`[控制面] ${note.kind.padEnd(9)} ${note.detail}`);
  },
  ...(toolChat
    ? { onToolCall: (name: string, callArgs: Record<string, unknown>) => say(formatToolCall(name, callArgs)) }
    : {}),
  logger,
  say,
  ...(chatMaxChars == null ? {} : { chatMaxChars }),
  ...(toolChoice === 'auto' ? {} : { toolChoice }),
  extraHooks: [budget.hook],
});

notify = (event) => baseline.runner.notify(event);
runnerRef = baseline.runner;
for (const event of inbox.splice(0)) notify(event);

// 内存采样：OOM 被杀时 stderr 通常没有线索，这一行能看出崩之前内存在涨。
const stopMemory = startMemorySampler(logger);

// 外部管理口：默认关；ADMIN_PORT 打开，只绑 127.0.0.1。
// 在等出生之前就开，这样连不上 MC 时也能从外部看状态/日志。
let admin: AdminServer | null = null;
const adminPort = Number(env.ADMIN_PORT);
if (Number.isFinite(adminPort) && adminPort > 0) {
  admin = await startAdmin({
    port: adminPort,
    ...(env.ADMIN_TOKEN == null ? {} : { token: env.ADMIN_TOKEN }),
    username: botName,
    describe: () => baseline.runner.describe(),
    action: () => baseline.runner.actionSummary(),
    vision: () => body.visionState(),
    trace: () => baseline.runner.traceLines,
    screenshot: () => body.lastScreenshot(),
    budget: () => budget.snapshot(),
    logFile: logger.file,
    message: (text) => baseline.kick(text),
    stop: () => baseline.runner.stop(),
  });
  console.log(`[admin] ${admin.url}${env.ADMIN_TOKEN == null ? '' : '（需要 x-admin-token）'}`);
}

// 等待出生：插件、区块、实体都就绪之后才叫模型。login 就设置 entity，不能用它判断。
async function waitSpawn(timeoutMs: number): Promise<void> {
  await Promise.race([
    body.whenSpawned(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

await waitSpawn(30_000);
const kickoff = initMessage;
await baseline.kick(kickoff);
console.log(
  `[${botName}] ${username} 已连上 ${host}:${port}，供应商 ${providerId}/${modelId}，会话在 ${dbPath}${verbose ? '（TRACE 已开）' : ''}`,
);
logger.with('boot').info({ event: 'vision', state: body.visionState() });
console.log(`[vision] ${body.visionState()}${body.visionState() === 'off' ? '（VISION=0）' : ''}`);

const shutdown = async (): Promise<void> => {
  stopMemory();
  await admin?.close();
  logger.with('boot').info({ event: 'shutdown', session: dbPath });
  console.log(`\n[${username}] ${baseline.runner.describe()}`);
  for (const line of baseline.runner.traceLines.slice(-40)) console.log(`  ${line}`);
  body.close();
  await baseline.close();
  await storage.close?.(BACKGROUND_CONTEXT);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
