/**
 * 外部控制器：起 agent 子进程，轮询 admin 口，异常重启 / 卡死 Stop / 预算兜底。
 *
 * 用法：node scripts/supervise.ts --port 39002 [--stuck 600] [--restart-limit 8]
 * 环境变量原样传给子进程（BOT / ADMIN_PORT / TOOLS / ... 由启动命令给）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] != null ? args[index + 1]! : fallback;
};
const port = Number(argOf('port', '39002'));
const stuckSec = Math.max(60, Number(argOf('stuck', '600')));
const restartLimit = Math.max(1, Number(argOf('restart-limit', '8')));
const base = `http://127.0.0.1:${port}`;
const logDir = argOf('logdir', `bots/${process.env.BOT ?? 'agent'}/logs`);
mkdirSync(logDir, { recursive: true });
const logFile = `${logDir}/supervisor.log`;

const log = (line: string): void => {
  const text = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`;
  console.log(text);
  try {
    appendFileSync(logFile, text + '\n');
  } catch {
    // 日志写不进去不影响主流程。
  }
};

interface Status {
  describe: string;
  action: string | null;
  budget: { used: number; limit: number; exhausted: boolean } | null;
}

const getStatus = async (): Promise<Status | null> => {
  try {
    const response = await fetch(base + '/status');
    return response.ok ? ((await response.json()) as Status) : null;
  } catch {
    return null;
  }
};
const post = async (path: string, body: unknown = {}): Promise<void> => {
  try {
    await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // 控制口不通就算了。
  }
};

let child: ChildProcess | null = null;
let restarts = 0;
let lastRestartAt = 0;
let lastOkAt = Date.now();
let lastAction = 'idle';
let lastActionAt = Date.now();
let lastStopAt = 0;
let stopped = false;
let lastUsed = -1;
let lastUsedAt = Date.now();
let lastProdAt = 0;

const start = (): void => {
  child = spawn(process.execPath, ['src/main.ts'], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk: Buffer) => appendFileSync(`${logDir}/agent-console.log`, chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendFileSync(`${logDir}/agent-console.err.log`, chunk));
  child.on('exit', (code) => {
    log(`agent 退出 code=${String(code)}`);
    child = null;
  });
  log(`agent 已启动 pid=${String(child.pid)}`);
};

start();

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  if (stopped) continue;
  const status = await getStatus();
  if (status == null) {
    if (Date.now() - lastOkAt > 90_000) {
      log('admin 口 90 秒没响应：重启 agent');
      (child as ChildProcess | null)?.kill('SIGKILL');
      child = null;
      restarts += 1;
      if (restarts > restartLimit) {
        log(`连续重启 ${restarts} 次，放弃`);
        stopped = true;
        continue;
      }
      lastRestartAt = Date.now();
      start();
      lastOkAt = Date.now();
    }
    continue;
  }
  lastOkAt = Date.now();
  const actionText = status.action == null ? '空闲' : String(status.action);
  const busy = !/^(空闲|idle)/.test(actionText);
  const actionName = busy ? actionText.split('（')[0]! : '空闲';
  if (actionName !== lastAction || !busy) {
    lastAction = actionName;
    lastActionAt = Date.now();
    if (busy) log(`动作变化：${actionName}`);
  }
  const held = Math.round((Date.now() - lastActionAt) / 1000);
  // 空转检测：模型可能只回一段文字、没调工具（小模型常见），这时没人叫醒它。
  // 用 budget.used 是否变化判断它还在干活；空闲超过 90 秒就注入一条「继续」。
  if (status.budget != null && status.budget.used !== lastUsed) {
    lastUsed = status.budget.used;
    lastUsedAt = Date.now();
  }
  const idleSec = Math.round((Date.now() - lastUsedAt) / 1000);
  if (!busy && idleSec > 90 && Date.now() - lastProdAt > 120_000 && !stopped) {
    lastProdAt = Date.now();
    log(`空闲 ${idleSec}s、没有新请求：注入「继续」`);
    await post('/message', { text: '继续：按清单做下一个动作。只发一个工具，不要长篇解释。' });
  }
  if (busy && held > stuckSec && Date.now() - lastStopAt > 60_000) {
    lastStopAt = Date.now();
    log(`⚠ 动作卡了 ${held}s（${actionName}）：POST /stop`);
    await post('/stop');
  }
  if (status.budget != null && status.budget.limit > 0 && status.budget.used / status.budget.limit > 0.99) {
    log('⚠ token 预算耗尽：停止');
    stopped = true;
    (child as ChildProcess | null)?.kill('SIGKILL');
    child = null;
  }
  if (child == null && !stopped && Date.now() - lastRestartAt > 15_000) {
    restarts += 1;
    if (restarts > restartLimit) {
      log(`重启 ${restarts} 次仍失败，放弃`);
      stopped = true;
      continue;
    }
    log(`agent 不在了：第 ${restarts} 次重启`);
    lastRestartAt = Date.now();
    start();
  }
}
