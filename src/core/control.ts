/**
 * 控制面：唯一回答"现在谁可以动身体"的地方。
 *
 * 纯函数、无 I/O、无定时器、不认识领域。全部状态：
 *   谁在动身体   = body
 *   结果是否过期 = epoch
 *   被打断的动作 = pendingResume（含检查点）
 *
 * 抢占与续做不是新机制，是这台机器的两条转移。
 * 第三条是**让位**：标了 `yieldToModel` 的反射（拾取）在模型要动手时立刻退出。
 */
import type { TraceNote } from './trace.ts';

export type ResumePolicy = 'auto' | 'checkpoint' | 'manual';

export interface BodyLock {
  by: 'model' | 'reflex';
  name: string;
  /** 只有 reflex 有意义；model 恒为 0。 */
  priority: number;
  args: unknown;
  startedAt: number;
  /** 能不能被更高优先级的反射抢走。 */
  interruptible: boolean;
  /** 模型动作被抢占后怎么续；反射恒为 manual。 */
  policy: ResumePolicy;
  /** 执行中上报的检查点；控制面不解包。 */
  checkpoint?: unknown;
  /**
   * 模型要动手时立刻让位。只有"填充活动"（拾取）该开：
   * 它在模型思考的窗口里用身体，模型一发动作就退出来。
   */
  yieldToModel?: boolean;
}

/** 被打断的模型动作：一个字段，不是一套机制。 */
export interface PendingResume {
  tool: string;
  args: unknown;
  /** auto 时为空；checkpoint 时是身体上报的进度。 */
  checkpoint?: unknown;
  policy: ResumePolicy;
  at: number;
}

export interface ControlState {
  /** 唯一计数器：回执过期判定。 */
  epoch: number;
  /** 身体锁。 */
  body: BodyLock | null;
  pendingResume: PendingResume | null;
}

export function initialState(): ControlState {
  return { epoch: 0, body: null, pendingResume: null };
}

export type Effect =
  | { kind: 'cancel-action' }
  /** 让位给模型：把正在跑的那个反射打断。 */
  | { kind: 'cancel-reflex' }
  | { kind: 'resume'; tool: string; args: unknown; checkpoint?: unknown }
  | { kind: 'resolve-tool'; text: string };

export type Input =
  | { kind: 'claim-model'; tool: string; args: unknown; policy?: ResumePolicy }
  | { kind: 'claim-reflex'; name: string; priority: number; interruptible?: boolean; yieldToModel?: boolean }
  | { kind: 'checkpoint'; value: unknown }
  | { kind: 'reflex-done'; name: string }
  | { kind: 'action-done'; epoch: number }
  | { kind: 'stop' };

export interface Reduction {
  state: ControlState;
  effects: Effect[];
  /** 这次转移生效了吗；`rejected` 时看 trace 的 detail。 */
  outcome: 'applied' | 'rejected';
  trace: TraceNote;
}

const note = (t: number, kind: string, detail: string): TraceNote => ({ t, kind, detail });

const reject = (state: ControlState, now: number, detail: string): Reduction => ({
  state,
  effects: [],
  outcome: 'rejected',
  trace: note(now, 'busy', detail),
});

export function reduce(state: ControlState, input: Input, now: number): Reduction {
  switch (input.kind) {
    case 'claim-model': {
      if (state.body != null) {
        const holder = state.body;
        // 让位反射（拾取）：模型要动手就让给它。前提是没有等着续做的模型动作——
        // 有的话那个动作会永远等不到续做，所以先让反射跑完。
        if (holder.by === 'reflex' && holder.yieldToModel === true && state.pendingResume == null) {
          const body: BodyLock = {
            by: 'model',
            name: input.tool,
            priority: 0,
            args: input.args,
            startedAt: now,
            interruptible: true,
            policy: input.policy ?? 'auto',
          };
          return {
            state: { ...state, body },
            effects: [{ kind: 'cancel-reflex' }],
            outcome: 'applied',
            trace: note(now, 'claim', `model ${input.tool} ← ${holder.name}（让位）`),
          };
        }
        return reject(state, now, `model ${input.tool} 被拒：身体是 ${holder.by} ${holder.name}`);
      }
      const body: BodyLock = {
        by: 'model',
        name: input.tool,
        priority: 0,
        args: input.args,
        startedAt: now,
        interruptible: true,
        policy: input.policy ?? 'auto',
      };
      return {
        state: { ...state, body },
        effects: [],
        outcome: 'applied',
        trace: note(now, 'claim', `model ${input.tool}`),
      };
    }

    case 'claim-reflex': {
      const next: BodyLock = {
        by: 'reflex',
        name: input.name,
        priority: input.priority,
        args: null,
        startedAt: now,
        interruptible: input.interruptible ?? true,
        policy: 'manual',
        ...(input.yieldToModel === true ? { yieldToModel: true } : {}),
      };
      const holder = state.body;
      if (holder == null) {
        return {
          state: { ...state, body: next },
          effects: [],
          outcome: 'applied',
          trace: note(now, 'reflex', `${input.name}(prio ${input.priority})`),
        };
      }
      if (holder.by === 'model') {
        const pendingResume: PendingResume | null =
          holder.policy === 'manual'
            ? null
            : {
                tool: holder.name,
                args: holder.args,
                ...(holder.policy === 'checkpoint' && holder.checkpoint !== undefined
                  ? { checkpoint: holder.checkpoint }
                  : {}),
                policy: holder.policy,
                at: now,
              };
        return {
          state: { ...state, body: next, pendingResume },
          effects: [{ kind: 'cancel-action' }],
          outcome: 'applied',
          trace: note(
            now,
            'preempt',
            `${input.name}(prio ${input.priority}) ← model ${holder.name}${pendingResume == null ? '（不续做）' : '（存续做）'}`,
          ),
        };
      }
      if (input.priority > holder.priority && holder.interruptible) {
        return {
          state: { ...state, body: next },
          effects: [{ kind: 'cancel-action' }],
          outcome: 'applied',
          trace: note(now, 'preempt', `${input.name}(${input.priority}) ← ${holder.name}(${holder.priority})`),
        };
      }
      return reject(state, now, `${input.name}(${input.priority}) 让给 ${holder.name}(${holder.priority})`);
    }

    case 'checkpoint': {
      if (state.body == null || state.body.by !== 'model') {
        return reject(state, now, 'checkpoint：没有模型动作');
      }
      return {
        state: { ...state, body: { ...state.body, checkpoint: input.value } },
        effects: [],
        outcome: 'applied',
        trace: note(now, 'checkpoint', state.body.name),
      };
    }

    case 'reflex-done': {
      const holder = state.body;
      if (holder == null || holder.by !== 'reflex' || holder.name !== input.name) {
        return reject(state, now, `reflex-done ${input.name} 没有在跑`);
      }
      const pending = state.pendingResume;
      if (pending == null) {
        return {
          state: { ...state, body: null },
          effects: [],
          outcome: 'applied',
          trace: note(now, 'release', `${input.name} 结束，身体空闲`),
        };
      }
      const body: BodyLock = {
        by: 'model',
        name: pending.tool,
        priority: 0,
        args: pending.args,
        startedAt: now,
        interruptible: true,
        policy: pending.policy,
        ...(pending.checkpoint === undefined ? {} : { checkpoint: pending.checkpoint }),
      };
      const resume: Effect =
        pending.checkpoint === undefined
          ? { kind: 'resume', tool: pending.tool, args: pending.args }
          : { kind: 'resume', tool: pending.tool, args: pending.args, checkpoint: pending.checkpoint };
      return {
        state: { ...state, body, pendingResume: null },
        effects: [resume],
        outcome: 'applied',
        trace: note(now, 'resume', `${pending.tool}（${pending.checkpoint === undefined ? '重新开始' : '从检查点续做'}）`),
      };
    }

    case 'action-done': {
      if (input.epoch !== state.epoch) {
        return reject(state, now, `epoch ${input.epoch} 的结果丢弃（当前 ${state.epoch}）`);
      }
      const holder = state.body;
      if (holder == null || holder.by !== 'model') {
        return reject(state, now, '没有模型动作，结果丢弃');
      }
      return {
        state: { ...state, body: null },
        effects: [],
        outcome: 'applied',
        trace: note(now, 'done', holder.name),
      };
    }

    case 'stop': {
      const holder = state.body;
      return {
        state: { ...state, epoch: state.epoch + 1, body: null, pendingResume: null },
        effects: [
          { kind: 'cancel-action' },
          { kind: 'resolve-tool', text: '已 Stop' },
        ],
        outcome: 'applied',
        trace: note(now, 'stop', holder == null ? '空闲，空操作' : `打断 ${holder.by} ${holder.name}`),
      };
    }

    default: {
      const never: never = input;
      throw new Error(`未知输入：${JSON.stringify(never)}`);
    }
  }
}

/** 一行人类可读的状态。看不出来就是 bug。 */
export function describe(state: ControlState, now = Date.now()): string {
  const seconds = (startedAt: number): string => ((now - startedAt) / 1000).toFixed(1);
  const body =
    state.body == null
      ? 'idle'
      : `${state.body.by}:${state.body.name}(${seconds(state.body.startedAt)}s${state.body.by === 'reflex' ? `, prio ${state.body.priority}` : ''})`;
  const resume = state.pendingResume == null
    ? ''
    : ` resume=${state.pendingResume.tool}(${state.pendingResume.policy}${state.pendingResume.checkpoint === undefined ? '' : ', 有检查点'})`;
  return `body=${body}${resume} epoch=${state.epoch}`;
}
