/**
 * 最小外部管理口：只绑 127.0.0.1，默认关。
 *
 * 用途：外面看一眼状态 / 日志 / 最近截图，或者塞一句话给它、让它停下。
 * 不做鉴权体系：可选一个 `ADMIN_TOKEN` 头，够本机开发用。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

export interface AdminOptions {
  /** 0 = 随机端口（测试用）。 */
  port: number;
  host?: string;
  token?: string;
  username: string;
  describe: () => string;
  action: () => string | null;
  /** 视觉状态（off / loading / on / failed）。 */
  vision: () => string;
  trace: () => readonly string[];
  screenshot: () => { file: string; takenAt: number } | null;
  /** Token 预算快照（used/limit/exhausted）；不给就不显示。 */
  budget?: () => unknown;
  /** 当前 agent 日志文件。 */
  logFile: string;
  /** 注入一条用户消息（等价于有人跟它说话）。 */
  message: (text: string) => Promise<void>;
  /** 有序停机：等动作把现场收拾完再返回回执。 */
  stop: () => string | Promise<string>;
}

export interface AdminServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface Reply {
  status: number;
  json: unknown;
}

const MAX_BODY = 64 * 1024;
const MAX_TAIL = 500;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function tailLines(file: string, count: number): string[] {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    return lines.slice(-Math.min(Math.max(count, 1), MAX_TAIL));
  } catch {
    return [];
  }
}

export function startAdmin(options: AdminOptions): Promise<AdminServer> {
  const host = options.host ?? '127.0.0.1';
  const startedAt = Date.now();

  const authorized = (request: IncomingMessage): boolean =>
    options.token == null || request.headers['x-admin-token'] === options.token;

  const handle = async (request: IncomingMessage): Promise<Reply> => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (!authorized(request)) return { status: 401, json: { error: 'unauthorized' } };

    if (request.method === 'GET' && url.pathname === '/status') {
      return {
        status: 200,
        json: {
          username: options.username,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          describe: options.describe(),
          action: options.action(),
          vision: options.vision(),
          screenshot: options.screenshot(),
          budget: options.budget?.() ?? null,
          trace: options.trace().slice(-30),
        },
      };
    }

    if (request.method === 'GET' && url.pathname === '/logs') {
      const tail = Number(url.searchParams.get('tail') ?? 50);
      return { status: 200, json: { file: options.logFile, lines: tailLines(options.logFile, Number.isFinite(tail) ? tail : 50) } };
    }

    if (request.method === 'POST' && url.pathname === '/message') {
      let payload: { text?: unknown };
      try {
        payload = JSON.parse(await readBody(request)) as { text?: unknown };
      } catch {
        return { status: 400, json: { error: 'body must be JSON: {"text":"..."}' } };
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (text === '') return { status: 400, json: { error: 'text is required' } };
      await options.message(text);
      return { status: 200, json: { ok: true } };
    }

    if (request.method === 'POST' && url.pathname === '/stop') {
      return { status: 200, json: { ok: true, result: await options.stop() } };
    }

    return { status: 404, json: { error: 'not found' } };
  };

  const server: Server = createServer((request, response: ServerResponse) => {
    void handle(request)
      .then((reply) => {
        response.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(reply.json));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });

  return new Promise<AdminServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address != null ? address.port : options.port;
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
