/**
 * 日志：结构化 agent 日志 + 请求快照 + 生命周期 hooks。
 *
 * 三样东西：
 *   1. `agent-YYYYMMDD.log`：一行一个 JSON，级别/模块/字段截断；同步写盘，
 *      崩了最后几行也还在；写不进去绝不拖垮 agent。
 *   2. `request-<页>.log`：模型这次**实际收到的消息列**。每次请求覆盖当前页，
 *      上下文压缩时翻页（新一代上下文 = 新文件）。
 *   3. hooks：provider 终态（stopReason / errorMessage / usage）、上下文压缩。
 *
 * 另外每 60 秒记一行 `memory`：RSS/heap。OOM 被杀时 stderr 通常什么都没有，
 * 这一行是唯一能看出"崩之前内存在涨"的证据。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompactionTask, GenerationTask, hook } from '@earendil-works/pi-durable';
import type { HookRegistration } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 单条字段的序列化上限：日志要能读，不能把一行撑成几 MB。 */
export const FIELD_LIMIT = 2_000;

export interface LoggerOptions {
  /** 落盘目录，通常是 `./bots/<name>/logs`。 */
  dir: string;
  /** 注入时钟（测试用）。 */
  now?: () => Date;
  /** 注入 stdout 镜像（测试用；默认 warn/error 走 console）。 */
  mirror?: (level: LogLevel, line: string) => void;
}

export interface ModuleLogger {
  debug(data?: Record<string, unknown>): void;
  info(data?: Record<string, unknown>): void;
  warn(data?: Record<string, unknown>): void;
  error(data?: Record<string, unknown>): void;
}

export interface Logger extends ModuleLogger {
  /** 固定模块名，省得每行都写一遍。 */
  with(mod: string): ModuleLogger;
  /** 当前落盘目录与文件（诊断用）。 */
  readonly dir: string;
  readonly file: string;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 压成一行可读的短文本；过长截断，序列化不了退成字符串。 */
function short(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= FIELD_LIMIT ? value : `${value.slice(0, FIELD_LIMIT)}…[+${value.length - FIELD_LIMIT}]`;
  }
  let text: string;
  try {
    const json = JSON.stringify(value);
    if (json == null) return String(value);
    text = json;
  } catch {
    return '[unserializable]';
  }
  return text.length <= FIELD_LIMIT ? value : `${text.slice(0, FIELD_LIMIT)}…[+${text.length - FIELD_LIMIT}]`;
}

function dayStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date());
  const mirror =
    options.mirror ??
    ((level: LogLevel, line: string): void => {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
    });

  const file = join(options.dir, `agent-${dayStamp(now())}.log`);
  let ready = false;

  const write = (level: LogLevel, mod: string, data?: Record<string, unknown>): void => {
    const record: Record<string, unknown> = { ts: now().toISOString(), level, mod };
    for (const [key, value] of Object.entries(data ?? {})) record[key] = short(value);
    const line = JSON.stringify(record);
    try {
      if (!ready) {
        mkdirSync(options.dir, { recursive: true });
        ready = true;
      }
      appendFileSync(file, `${line}\n`);
    } catch (error: unknown) {
      // 日志是旁路：写不进去只说一声，不拖垮 agent。
      if (!ready) {
        ready = true;
        console.error('agent log unavailable:', describeError(error));
      }
    }
    if (level === 'warn' || level === 'error') mirror(level, `[${level}] ${mod} ${line}`);
  };

  const at = (mod: string): ModuleLogger => ({
    debug: (data) => write('debug', mod, data),
    info: (data) => write('info', mod, data),
    warn: (data) => write('warn', mod, data),
    error: (data) => write('error', mod, data),
  });

  return { ...at('root'), with: at, dir: options.dir, file };
}

// ── 请求快照：一页 = 一代上下文 ──

function pageFile(dir: string, page: number): string {
  return join(dir, `request-${String(page).padStart(3, '0')}.log`);
}

function renderMessage(message: Message): string {
  const text =
    typeof message.content === 'string'
      ? message.content
      : (() => {
          try {
            return JSON.stringify(message.content) ?? 'null';
          } catch {
            return '[unserializable]';
          }
        })();
  const lines: string[] = [`[${String(message.role)}] ${text.replace(/\n/g, '\n  ')}`];
  // 系统消息的提示词正文在 sections 里，不在 content：只打 content 会看到空的 [system]。
  const sections = (message as { sections?: Record<string, string | null> }).sections;
  for (const [key, value] of Object.entries(sections ?? {})) {
    lines.push(`  [section:${key}]`);
    if (value == null) {
      lines.push('    (removed)');
      continue;
    }
    for (const line of value.split('\n')) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

export interface RequestLogOptions {
  dir: string;
  /** 当前工具名列表，写进日志头。 */
  tools: () => readonly string[];
  now?: () => Date;
}

export interface RequestLog {
  /** 写一代上下文（**覆盖写**当前页）。 */
  writeRequest(messages: readonly Message[]): void;
  /** 翻页：发生上下文压缩，下一代上下文开始。 */
  nextPage(): void;
  readonly page: number;
  readonly file: string;
}

export function createRequestLog(options: RequestLogOptions): RequestLog {
  const now = options.now ?? ((): Date => new Date());
  let page = 1;
  let round = 0;
  return {
    get page(): number {
      return page;
    },
    get file(): string {
      return pageFile(options.dir, page);
    },
    writeRequest(messages: readonly Message[]): void {
      round += 1;
      const header = [
        `# request at ${now().toISOString()}`,
        `# round ${round}`,
        `# page ${page}`,
        `# tools ${options.tools().join(', ')}`,
      ].join('\n');
      const body = messages.map(renderMessage).join('\n\n');
      try {
        mkdirSync(options.dir, { recursive: true });
        writeFileSync(this.file, `${header}\n\n${body}\n`);
      } catch (error: unknown) {
        // 旁路，不拖垮 agent。
        console.error('request log write failed:', describeError(error));
      }
    },
    nextPage(): void {
      page += 1;
      round = 0;
    },
  };
}

// ── 生命周期 hooks ──

export interface LoggingHooksOptions {
  logger: Logger;
  requestLog: RequestLog;
}

export function loggingHooks(options: LoggingHooksOptions): HookRegistration[] {
  const provider = options.logger.with('provider');
  const compact = options.logger.with('compact');
  return [
    hook(GenerationTask, {
      beforeRequest: (request) => {
        options.requestLog.writeRequest(request.messages);
        return undefined;
      },
      afterResponse: (message) => {
        const failed = message.stopReason === 'error' || message.errorMessage != null;
        const data: Record<string, unknown> = {
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          inputTokens: message.usage?.input ?? null,
          outputTokens: message.usage?.output ?? null,
          totalTokens: message.usage?.totalTokens ?? null,
          error: message.errorMessage ?? null,
          content: Array.isArray(message.content) ? message.content.map((part) => part.type) : typeof message.content,
        };
        if (failed) provider.error(data);
        else provider.info(data);
        return undefined;
      },
    }),
    hook(CompactionTask, {
      beforeCompact: (compaction) => {
        options.requestLog.nextPage();
        compact.info({
          reason: compaction.reason,
          entriesReplaced: compaction.entries.length,
          messagesSummarized: compaction.messages.length,
          firstKept: compaction.firstKept,
        });
        return undefined;
      },
    }),
  ];
}

/** 每 60 秒记一行内存；返回停止函数。定时器 unref，不会吊住进程。 */
export function startMemorySampler(logger: Logger, intervalMs = 60_000): () => void {
  const log = logger.with('memory');
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    log.info({
      rssMb: Math.round(usage.rss / 1024 / 1024),
      heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
      externalMb: Math.round(usage.external / 1024 / 1024),
    });
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
