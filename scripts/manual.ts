/**
 * 手动驱动：不接模型，只连 Minecraft。用来先验身体，不烧 token。
 *
 *   node scripts/manual.ts --port 51234 [--host 127.0.0.1] [--user ManualBot] [--version 1.21.11]
 *
 * 命令：
 *   snapshot                          拍一张当前快照
 *   tools                             列出工具名
 *   scan                              扫一次（会打出反射接管事件）
 *   say <文字>                        在公聊里说一句
 *   reflex <名字>                     手动跑一次反射（combat / eat）
 *   <工具名> <JSON 参数>              直接调工具，例如 mineBlock {"x":10,"y":64,"z":3}
 *   quit                              断开并退出
 */
import { createInterface } from 'node:readline';
import { CATALOG } from '../src/body/catalog.ts';
import { createBody } from '../src/body/index.ts';
import { checkArgs } from '../src/shared/tools.ts';

/** 这 12 个工具里只有 9 个由身体实现；其余三个是装配层的本地工具。 */
const LOCAL_TOOLS = new Set(['Say', 'Stop', 'UpdateGoal']);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.env[`MC_${name.toUpperCase()}`];
}

const port = Number(arg('port') ?? process.env.MC_PORT);
if (!Number.isFinite(port) || port <= 0) {
  console.error('需要 --port（或 MC_PORT）：对局域网开放显示的端口');
  process.exit(1);
}

const body = createBody({
  host: arg('host') ?? '127.0.0.1',
  port,
  username: arg('user') ?? 'ManualBot',
  ...(arg('version') == null ? {} : { version: arg('version') }),
  goal: () => null,
  onEvent: (event) => {
    console.log(`[L${event.level}] ${event.type}  ${event.text}`);
  },
});

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'body> ' });

async function run(line: string): Promise<void> {
  const text = line.trim();
  if (text === '') return;
  if (text === 'quit') {
    body.close();
    rl.close();
    process.exit(0);
  }
  if (text === 'snapshot') {
    console.log(body.snapshot());
    return;
  }
  if (text === 'tools') {
    console.log(
      CATALOG.filter((tool) => !LOCAL_TOOLS.has(tool.name))
        .map((tool) => tool.name)
        .join('、'),
    );
    return;
  }
  if (text === 'scan') {
    body.scan();
    return;
  }
  if (text.startsWith('say ')) {
    (body.raw() as { chat?: (message: string) => void } | null)?.chat?.(text.slice(4));
    return;
  }
  if (text.startsWith('reflex ')) {
    await body.reflex(text.slice(7).trim(), new AbortController().signal);
    return;
  }

  const space = text.indexOf(' ');
  const name = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? '{}' : text.slice(space + 1).trim() || '{}';
  const declaration = CATALOG.find((tool) => tool.name === name);
  if (declaration == null || LOCAL_TOOLS.has(name)) {
    console.log(`身体没有这个动作：${name}；输入 tools 看列表`);
    return;
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rest) as Record<string, unknown>;
  } catch {
    console.log(`参数要 JSON，例如 ${name} {"x":1,"y":2,"z":3}`);
    return;
  }
  const checked = checkArgs(declaration, args);
  if (!checked.ok) {
    console.log(`参数不对：${checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`);
    return;
  }
  const result = await body.execute(name, checked.args, {
    signal: new AbortController().signal,
    resume: undefined,
    checkpoint: () => {},
  });
  console.log(result.text);
}

// 命令串行执行：readline 不会等你；直接并发会让两个动作抢身体。
let chain: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  chain = chain
    .then(() => run(line))
    .catch((error: unknown) => console.log(`执行失败：${error instanceof Error ? error.message : String(error)}`))
    .finally(() => rl.prompt());
});

console.log(`连 ${arg('host') ?? '127.0.0.1'}:${port} 中…… 输入 snapshot 看快照，tools 看工具`);
