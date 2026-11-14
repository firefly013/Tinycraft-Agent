/**
 * 外部监控 / 控制器：轮询 admin 口的 /status 与 /logs，实时打印；卡住时发 /stop 兜底。
 *
 * 用法：node scripts/monitor.ts --port 39002 [--interval 2000] [--stuck 600]
 */
import { appendFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] != null ? args[index + 1]! : fallback;
};
const port = Number(argOf('port', '39002'));
const interval = Math.max(500, Number(argOf('interval', '2000')));
const stuckSec = Math.max(60, Number(argOf('stuck', '600')));
const base = `http://127.0.0.1:${port}`;
const logDir = argOf('logdir', `bots/${process.env.BOT ?? 'agent'}/logs`);
mkdirSync(logDir, { recursive: true });
const logFile = `${logDir}/monitor.log`;

interface Status {
  uptimeSec: number;
  describe: string;
  action: string | null;
  vision: string;
  budget: { used: number; limit: number } | null;
}

const stamp = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const out = (line: string): void => {
  console.log(line);
  try {
    appendFileSync(logFile, line + '\n');
  } catch {
    // 监控日志写不进去不影响主流程。
  }
};

const getJson = async <T>(path: string): Promise<T | null> => {
  try {
    const response = await fetch(base + path);
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
};
const post = async (path: string, body: unknown = {}): Promise<unknown> => {
  try {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch {
    return null;
  }
};

const parseLine = (raw: string): string | null => {
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    const mod = String(event.mod ?? '?');
    const level = String(event.level ?? 'info');
    if (mod === 'request' || level === 'debug') return null;
    const bits: string[] = [];
    for (const key of ['event', 'state', 'tool', 'stopReason', 'kind', 'detail', 'error', 'percent']) {
      if (event[key] != null) bits.push(`${key}=${String(event[key])}`);
    }
    const text = typeof event.text === 'string' ? event.text : '';
    return `  ${mod}/${level}: ${bits.join(' ')}${text === '' ? '' : ' · ' + text.slice(0, 160)}`;
  } catch {
    return null;
  }
};

let lastSeen = '';
let lastAction = 'idle';
let lastActionAt = Date.now();
let lastStopAt = 0;
let polls = 0;
let stops = 0;
let budgetWarned = false;

const tick = async (): Promise<void> => {
  const status = await getJson<Status>('/status');
  if (status == null) {
    out(`[${stamp()}] admin 口没响应（agent 还没起或已退出）`);
    return;
  }
  polls += 1;
  const action = status.action ?? 'idle';
  if (action !== lastAction) {
    lastAction = action;
    lastActionAt = Date.now();
  }
  const held = Math.round((Date.now() - lastActionAt) / 1000);
  const budget =
    status.budget == null ? 'budget=?' : `used=${status.budget.used.toLocaleString('en-US')}/${status.budget.limit.toLocaleString('en-US')}`;
  out(`[${stamp()}] ${status.describe}${status.action == null ? '' : ` | ${status.action} (${held}s)`} | ${budget} | up=${status.uptimeSec}s`);

  const logs = await getJson<{ lines: string[] }>('/logs?tail=200');
  if (logs != null) {
    const lines = logs.lines ?? [];
    const start = lastSeen === '' ? Math.max(0, lines.length - 3) : Math.max(0, lines.indexOf(lastSeen) + 1);
    for (let index = start; index < lines.length; index += 1) {
      const raw = lines[index] ?? '';
      lastSeen = raw;
      const text = parseLine(raw);
      if (text != null) out(text);
    }
  }

  // 外部控制器兜底：动作持续超过阈值还在跑 → Stop（动作自己的硬上限是 8 分钟）。
  if (status.action != null && held > stuckSec && Date.now() - lastStopAt > 60_000) {
    lastStopAt = Date.now();
    stops += 1;
    out(`[${stamp()}] ⚠ 动作卡了 ${held}s：POST /stop`);
    await post('/stop');
  }
  if (!budgetWarned && status.budget != null && status.budget.limit > 0 && status.budget.used / status.budget.limit > 0.9) {
    budgetWarned = true;
    out(`[${stamp()}] ⚠ token 预算已用 ${((status.budget.used / status.budget.limit) * 100).toFixed(1)}%`);
  }
};

out(`[监控] ${base}，每 ${interval}ms；卡住阈值 ${stuckSec}s；日志 ${logFile}`);
process.on('SIGINT', () => {
  out(`[监控] 退出：${polls} 次轮询，${stops} 次自动 Stop`);
  process.exit(0);
});
for (;;) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, interval));
}
