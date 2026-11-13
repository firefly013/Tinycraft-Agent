/**
 * 冒烟：不接 Minecraft、不接模型，把"长动作 → 被反射抢占 → 从检查点续做 → 完成"跑一遍。
 *
 *   node scripts/smoke.ts
 *
 * 每一步打印一行，最后打印控制面轨迹。失败就退出码 1。
 */
import { Runner } from '../src/agent/runner.ts';
import { CATALOG } from '../src/body/catalog.ts';
import type { ActionContext } from '../src/shared/body.ts';
import type { ReflexSpec } from '../src/core/reflex.ts';
import type { LogEvent } from '../src/core/events.ts';

const hostile = (): LogEvent => ({
  type: 'hostile',
  kind: 'World',
  level: 5,
  payload: {},
  text: '两只僵尸靠近',
  ts: Date.now(),
});

let attempts = 0;
const delivered: string[] = [];
const pending: Array<{ resolve: (value: { text: string }) => void; reject: (error: Error) => void }> = [];

const body = {
  execute: (name: string, args: Record<string, unknown>, context: ActionContext): Promise<{ text: string }> => {
    attempts += 1;
    const from = context.resume === undefined ? '无（第一次）' : JSON.stringify(context.resume);
    console.log(`   身体开始干（第 ${attempts} 次）：${name} ${JSON.stringify(args)}，续做参数 ${from}`);
    // 第一次执行到第 3 个时报一次进度——被抢占后会被存下来。
    if (attempts === 1) context.checkpoint({ got: 3 });
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      context.signal.addEventListener(
        'abort',
        () => {
          console.log('   身体收到取消，停下');
          reject(new Error('aborted'));
          pending.pop();
        },
        { once: true },
      );
    });
  },
};

const reflexes: readonly ReflexSpec[] = [{ name: 'combat', priority: 30, interruptible: true, types: ['hostile'] }];

const runner = new Runner({
  tools: CATALOG,
  body,
  deps: {
    submit: async (text) => {
      delivered.push(text);
      console.log(`   叫醒模型：${text.split('\n')[0]}`);
    },
    write: async (_events, text) => {
      delivered.push(text);
      console.log(`   只记录：${text.split('\n')[0]}`);
    },
    abort: async () => {
      console.log('   打断正在生成的请求');
    },
  },
  reflexes,
  runReflex: async (name) => {
    console.log(`   反射 ${name} 动手`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    console.log(`   反射 ${name} 收手`);
  },
});

console.log('1) 模型发起长动作（异步：立刻回 accepted，并结束本轮）');
const receipt = await runner.tool('collectBlock', { type: 'iron_ore', count: 4, descriptions: '冒烟：收 4 个铁' });
console.log(`   工具回执：${receipt.text}（terminate=${String(receipt.terminate === true)}）`);

console.log('2) 身体扫描判定该动手 → 发 L5');
runner.notify(hostile());
await runner.settleReflexes();

console.log('3) 战斗结束，从检查点续做，然后动作完成');
pending.pop()?.resolve({ text: '收了 4 个铁' });
await new Promise((resolve) => setTimeout(resolve, 30));
await runner.settleDelivery();

console.log('4) 控制面轨迹');
for (const line of runner.traceLines) console.log(`   ${line}`);
console.log(`   状态：${runner.describe()}`);

const resumedFromCheckpoint = delivered.some((text) => text.includes('收了 4 个铁') && text.includes('已从断点续做'));
const okAttempts = attempts === 2;
const okTrace = runner.traceLines.some((line) => line.includes('preempt')) && runner.traceLines.some((line) => line.includes('resume'));
// accepted 回执必须结束本轮：否则框架会立刻再问模型，模型只能空转一轮。
const okTerminate = receipt.terminate === true;
if (!okAttempts || !resumedFromCheckpoint || !okTrace || !okTerminate) {
  console.error(
    `冒烟失败：attempts=${attempts} checkpoint=${resumedFromCheckpoint} trace=${okTrace} terminate=${okTerminate}`,
  );
  process.exit(1);
}
console.log('\n冒烟通过：accepted 即结束本轮 → 抢占 → 从检查点续做 → 完成，模型只收到一次结果。');
