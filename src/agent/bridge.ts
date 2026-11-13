/**
 * IntakeDeps ↔ pi-durable 会话。
 *
 *   submit → 一次输入。`whenBusy: steer`：请求在飞时插到工具轮之后，空闲就开一轮。
 *   write  → 一条只记录、不唤醒的 entry（带 model 视图，下一次请求能看到）。
 *   abort  → 打断当前 run。
 *
 * 注意 submit **只等准入**，不等整轮答完——否则投递泵会被一整轮堵住。
 * 返回的 `settled` 给 intake 用来判断何时清在途批次。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Conversation } from '@earendil-works/pi-durable';
import type { IntakeDeps } from '../core/intake.ts';

export const EVENT_ENTRY_KIND = 'mc.event';

export interface BridgeHooks {
  /** 投递出错（写失败、提交失败）：不要静默吞掉。 */
  onError?: (error: unknown) => void;
}

export function createIntakeDeps(conversation: Conversation, hooks: BridgeHooks = {}): IntakeDeps {
  const context = BACKGROUND_CONTEXT;
  return {
    submit: async (text) => {
      const submission = await conversation.submit(
        { type: 'input', content: text, whenBusy: 'steer' },
        context,
      );
      const settled = submission.wait(context);
      // 不在这里调 requestFinished：请求标志只由 beforeRequest/afterResponse 驱动。
      void settled.catch(() => undefined);
      return { settled };
    },
    write: async (_events, text) => {
      await conversation.submit(
        {
          type: 'write',
          entry: {
            kind: EVENT_ENTRY_KIND,
            data: { text },
            model: [{ role: 'user', content: text, timestamp: Date.now() }],
          },
        },
        context,
      );
    },
    abort: async () => {
      await conversation.abort(context);
    },
    ...(hooks.onError == null ? {} : { onError: hooks.onError }),
  };
}
