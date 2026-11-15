/**
 * 装配线：工具调用 ↔ 控制面 ↔ 身体；事件 ↔ 反射层 ↔ 投递。
 *
 * 只有这里同时认识「工具、身体、反射」；core 不认识它们。
 *
 * 动作工具统一契约（旧项目的标准）：
 *   调用 → 控制面 claim → 立刻返回 accepted（后台跑）
 *        → 完成/失败 → 一条 L3 Tool 事件送回模型
 * 同一动作重复下发 → accepted“已经在做”，不重复执行、不排队；
 * 别的动作占着身体 → 直接回 busy（不排队，排队会制造第二遍执行）。
 *
 * 被反射抢占：
 *   claim-reflex → cancel-action（abort 身体）→ 反射跑完 → resume（带检查点）
 *   → 身体从断点继续 → 最终只报一条完成事件，附被打断次数。
 */
import { describe as describeControl, initialState, reduce as reduceControl } from '../core/control.ts';
import type { ControlState, Effect, Input, ResumePolicy } from '../core/control.ts';
import { EventIntake } from '../core/intake.ts';
import type { IntakeDeps } from '../core/intake.ts';
import { selectReflex } from '../core/reflex.ts';
import type { ReflexSpec } from '../core/reflex.ts';
import { Trace } from '../core/trace.ts';
import type { TraceNote } from '../core/trace.ts';
import type { LogEvent } from '../core/events.ts';
import type { ActionContext, Body } from '../shared/body.ts';
import { checkArgs } from '../shared/tools.ts';
import type { ToolDeclaration, ToolOutcome } from '../shared/tools.ts';

export type { ActionContext, Body } from '../shared/body.ts';

/** 任何动作回执的硬上限：谁生成字符串，谁就必须被截断。 */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** Stop 等动作收手的上限；超过就不等了（清理照做，但会说明）。 */
const STOP_SETTLE_MS = 2_000;
/** 清理本身的上限。 */
const STOP_CLEANUP_MS = 5_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
/** 单次动作执行的硬上限。旧项目是 8.5 分钟；先对齐到 8 分钟。 */
export const ACTION_HARD_TIMEOUT_MS = 8 * 60_000;

/** 留头留尾截断；明说截掉多少，不悄悄吞内容。 */
export function clampToolOutput(text: string, limit: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const keep = Math.max(200, Math.floor(limit * 0.45));
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n……内容太长，中间截掉了 ${dropped.toLocaleString('en-US')} 个字符……\n\n${tail}`;
}

export interface RunnerOptions {
  tools: readonly ToolDeclaration[];
  body: Body;
  /** 投递出口（装配层注入）。 */
  deps: IntakeDeps;
  reflexes?: readonly ReflexSpec[];
  /** 反射实现：抢到身体之后真正去干活；被更高优先级抢占时 signal 会 abort。 */
  runReflex?: (name: string, signal: AbortSignal) => Promise<void>;
  /** 每次模型工具调用开始时回调（用于在聊天框里逐条打印）。 */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** 不占身体、也不进身体的动作：Finish / Stop / UpdateGoal；可以返回 terminate 来结束本轮。 */
  localTools?: Readonly<Record<string, (args: Record<string, unknown>) => string | ToolOutcome | Promise<string | ToolOutcome>>>;
  /** 每条控制面转移的回调（TRACE=1 时接到日志）。 */
  onTrace?: (note: TraceNote) => void;
  /** 单条工具回执上限（字符）；不给用 20k。小模型上下文小，会调小。 */
  maxToolOutputChars?: number;
  now?: () => number;
}

interface ActiveCall {
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  epoch: number;
  policy: ResumePolicy;
  /** 第几次执行（被抢占后重开一次 +1）。过期结果靠它作废。 */
  attempt: number;
  interrupted: boolean;
  interrupts: number;
  interruptMs: number;
  interruptedAt: number;
  controller: AbortController;
  /** 这一次执行的 promise（runAndDeliver）：Stop 要等它真的收手。 */
  settled: Promise<void>;
  /** 续做时给身体的检查点。 */
  resumeFrom: unknown;
  /** 这次执行是不是"续做"（走 body.resume 而不是 body.execute）。 */
  resuming: boolean;
  /** 本次执行是否被硬超时中止。 */
  timedOut: boolean;
  hardTimer: NodeJS.Timeout | null;
}

export class Runner {
  private readonly tools: Map<string, ToolDeclaration>;
  private readonly body: Body;
  private readonly intake: EventIntake;
  private readonly reflexes: readonly ReflexSpec[];
  private readonly runReflexImpl: ((name: string, signal: AbortSignal) => Promise<void>) | null;
  private readonly onToolCall: ((name: string, args: Record<string, unknown>) => void) | null;
  private readonly localTools: Readonly<
    Record<string, (args: Record<string, unknown>) => string | ToolOutcome | Promise<string | ToolOutcome>>
  >;
  private readonly onTrace: ((note: TraceNote) => void) | null;
  private readonly nowMs: () => number;
  private readonly maxToolOutputChars: number;
  private readonly trace: Trace;
  private state: ControlState = initialState();
  private active: ActiveCall | null = null;
  /** 所有在跑的反射（可能不止一个：被抢的那个要等它真的收手）。 */
  private readonly reflexWorks = new Set<Promise<void>>();
  /** 有序停机清理中：这段时间不再让反射抢身体。 */
  private stopping = false;
  private reflexAbort: AbortController | null = null;
  private callSeq = 0;

  constructor(options: RunnerOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.body = options.body;
    this.intake = new EventIntake();
    this.intake.attach(options.deps);
    this.reflexes = options.reflexes ?? [];
    this.runReflexImpl = options.runReflex ?? null;
    this.onToolCall = options.onToolCall ?? null;
    this.localTools = options.localTools ?? {};
    this.onTrace = options.onTrace ?? null;
    this.nowMs = options.now ?? Date.now;
    this.maxToolOutputChars = options.maxToolOutputChars ?? MAX_TOOL_OUTPUT_CHARS;
    this.trace = new Trace(500, this.nowMs());
  }

  /** 模型调用一个工具。`terminate` = 这一轮到此结束，不要再问模型。 */
  async tool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const declaration = this.tools.get(name);
    if (declaration == null) return { text: `没有这个工具：${name}` };
    // 观测钩子：每次调用都通知（不参与执行逻辑，失败也不影响工具）。
    try {
      this.onToolCall?.(name, args);
    } catch {
      // 打印失败不能拖垮工具。
    }
    const checked = checkArgs(declaration, args);
    if (!checked.ok) {
      return { text: `参数不对：${checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}` };
    }
    // descriptions 是“这次调用要干什么”的解释：有就必须是真话，空字符串不接受。
    const intent = checked.args.descriptions;
    if (intent !== undefined && (typeof intent !== 'string' || intent.trim() === '')) {
      return { text: '参数不对：descriptions 不能为空，用一句话说明这次调用是为了干什么。' };
    }

    // 本地工具（Finish / Stop / UpdateGoal）不占身体：同步立即返回，结果模型现在就要用。
    if (!declaration.action) {
      const local = this.localTools[name];
      if (local == null) return { text: `没有这个本地工具：${name}` };
      const result = await local(checked.args);
      if (typeof result === 'string') return { text: clampToolOutput(result, this.maxToolOutputChars) };
      return {
        text: clampToolOutput(result.text, this.maxToolOutputChars),
        ...(result.terminate === true ? { terminate: true } : {}),
      };
    }

    // 同一动作已经在跑：幂等，重复下发不再执行一遍；那条动作完成时会叫醒模型。
    const holder = this.state.body;
    if (holder != null && holder.by === 'model' && holder.name === name) {
      const seconds = Math.max(0, Math.round((this.nowMs() - holder.startedAt) / 1000));
      return {
        text: `accepted：${name} 已经在跑（已经 ${seconds} 秒），不重复执行；完成会用 Tool 事件回报。`,
        terminate: true,
      };
    }

    // 续做能力由身体侧登记（有 resume 钩子才可续）；没有就等同于原来的 manual。
    const resumable = this.body.canResume?.(name) === true;
    const claim = {
      kind: 'claim-model' as const,
      tool: name,
      args: checked.args,
      policy: resumable ? ('checkpoint' as const) : ('manual' as const),
    };
    const reduction = this.reduce(claim);
    if (reduction.outcome !== 'applied') {
      const now = this.state.body;
      if (now == null) return { text: `没抢到身体：${reduction.trace.detail}` };
      const seconds = Math.max(0, Math.round((this.nowMs() - now.startedAt) / 1000));
      return {
        text: `身体正忙：${now.by === 'reflex' ? `反射 ${now.name}` : now.name} 还在跑，已经 ${seconds} 秒；等它完成或先 Stop。`,
        // 占着身体的是模型自己的动作：它完成时**一定**有 tool.done 叫醒模型，
        // 这一轮不必再空转。占着的是反射则相反——反射结束不保证有唤醒，
        // 模型必须现在拿到这条信息（它能决定 Stop 或先说话）。
        ...(now.by === 'model' ? { terminate: true } : {}),
      };
    }

    const call: ActiveCall = {
      tool: name,
      args: checked.args,
      callId: `${name}#${++this.callSeq}`,
      epoch: this.state.epoch,
      policy: resumable ? 'checkpoint' : 'manual',
      attempt: 0,
      interrupted: false,
      interrupts: 0,
      interruptMs: 0,
      interruptedAt: 0,
      controller: new AbortController(),
      settled: Promise.resolve(),
      resumeFrom: undefined,
      resuming: false,
      timedOut: false,
      hardTimer: null,
    };
    this.active = call;

    // 统一异步：动作在后台跑，结果以后以 L3 Tool 事件回来。
    call.settled = this.runAndDeliver(call);
    // **terminate**：命令已下达、身体在跑，模型该睡——完成事件会再叫醒它。
    // 不 terminate 的话框架会立刻再问一次，模型只能在一个信息为零的回合里轮询。
    return {
      text: `accepted：${name}（${call.callId} 已在后台开始；完成后会用 Tool 事件回报）`,
      terminate: true,
    };
  }

  /** 只要文本（脚本/测试用）；模型路径用 `tool()`，它还会带回 terminate。 */
  async toolText(name: string, args: Record<string, unknown>): Promise<string> {
    return (await this.tool(name, args)).text;
  }

  /** 一条事件进来：先给反射层（它可能抢占），再投递（L5 写记录、不唤醒）。 */
  notify(event: LogEvent): void {
    // 身体没了：正在跑的动作和反射都必须停，锁不能留着。
    if (event.type === 'system.disconnected') {
      this.cancelActive();
      this.reflexAbort?.abort();
      this.active = null;
      this.reduce({ kind: 'stop' });
    }
    if (event.type === 'system.reconnected') {
      // 重连事件本身照常进投递；动作状态由后续工具调用重新认领。
    }
    const verdict = selectReflex(this.reflexes, event.type, this.activeReflex());
    // 停机清理期间不放反射进来：清理要独占身体，抢进来就是两只手抢同一副身体。
    if (verdict.kind === 'run' && !this.stopping) this.startReflex(verdict.spec);
    // 静默事件不唤醒模型，但会写进上下文：模型下一轮能看到反射做过什么。
    if (event.silent === true) {
      // 反射一旦真的接管了身体，模型正在生成的那一轮就该掐掉——它的结论必然是
      // 撞 busy。没抢到（被更高级反射占着）就什么都不动。
      const claimed = verdict.kind === 'run' && this.activeReflex()?.name === verdict.spec.name;
      if (claimed) void this.intake.interrupt();
      this.intake.notify(event);
      return;
    }
    this.intake.notify(event);
  }

  /**
   * 模型 Stop：**有序停机**。
   *
   * 顺序：反射收手 → 模型动作收手（abort + 等 settle）→ 跑动作的清理钩子
   * （身体锁还在这条动作身上）→ 才放锁。回执带清理结果，模型可以直接回复玩家。
   */
  async stop(): Promise<string> {
    // 反射占着身体：先让它真的收手。可续做的模型动作会被 reflex-done 自动续起来，
    // 下面按"模型动作在跑"走完整协议。
    if (this.activeReflex() != null) {
      this.reflexAbort?.abort();
      try {
        await this.settleReflexes();
      } catch {
        // 反射收尾失败也要继续停机。
      }
    }
    const call = this.active;
    if (call == null) {
      this.reduce({ kind: 'stop' });
      return '身体空闲，没有要停的动作';
    }
    const holder = this.state.body;
    if (holder == null || holder.by !== 'model') {
      // 动作已被抢占、且策略不续做：没有留下要清理的现场。
      this.reduce({ kind: 'stop' });
      return `已停止 ${call.tool}`;
    }
    const checkpoint = holder.checkpoint;
    this.stopping = true;
    this.cancelActive();
    try {
      // 等动作真的收手：它的 finally 会关窗口、停寻路。
      await Promise.race([call.settled, delay(STOP_SETTLE_MS)]);
      if (this.active !== call || this.state.body?.by !== 'model') {
        // 极小概率：abort 之前它自己完成了。
        return `已停止 ${call.tool}（动作已经完成）`;
      }
      const cleanup = await this.cleanup(call, checkpoint);
      return cleanup === '' ? `已停止 ${call.tool}` : `已停止 ${call.tool}；${cleanup}`;
    } finally {
      this.stopping = false;
      this.reduce({ kind: 'stop' });
    }
  }

  /** 跑动作登记的清理钩子；有界、绝不抛。 */
  private async cleanup(call: ActiveCall, checkpoint: unknown): Promise<string> {
    const stop = this.body.stop;
    if (typeof stop !== 'function') return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STOP_CLEANUP_MS);
    (timer as { unref?: () => void }).unref?.();
    try {
      const text = await stop.call(
        this.body,
        call.tool,
        { signal: controller.signal, checkpoint: () => {} },
        checkpoint,
      );
      if (!controller.signal.aborted) return typeof text === 'string' ? text : '';
      return typeof text === 'string' && text !== '' ? `${text}（清理超时，可能没收拾干净）` : '清理超时，现场没收拾干净';
    } catch (error: unknown) {
      return `清理失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 请求标志：由 generation hooks 驱动（只表示 provider 请求是否在飞） ──

  requestStarted(): void {
    this.intake.requestStarted();
  }

  requestFinished(): void {
    this.intake.requestFinished();
  }

  /** 等所有反射（包括被抢占、还在收手的）真的结束。 */
  async settleReflexes(): Promise<void> {
    while (this.reflexWorks.size > 0) await Promise.all([...this.reflexWorks]);
  }

  /** 等投递落定。 */
  async settleDelivery(): Promise<void> {
    await this.intake.settle();
  }

  get control(): ControlState {
    return this.state;
  }

  get traceLines(): string[] {
    return this.trace.lines();
  }

  describe(): string {
    return describeControl(this.state, this.nowMs());
  }

  /** 给每轮快照用的"当前动作"一句话。 */
  actionSummary(): string | null {
    const body = this.state.body;
    if (body == null) return '空闲';
    const seconds = ((this.nowMs() - body.startedAt) / 1000).toFixed(1);
    return `${body.name}（${body.by === 'reflex' ? '反射' : '工具'}，已经 ${seconds} 秒）`;
  }

  private reduce(input: Input) {
    const reduction = reduceControl(this.state, input, this.nowMs());
    this.state = reduction.state;
    this.trace.push(reduction.trace);
    try {
      this.onTrace?.(reduction.trace);
    } catch {
      // 观测钩子不能影响状态机。
    }
    this.applyEffects(reduction.effects);
    return reduction;
  }

  private applyEffects(effects: readonly Effect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'cancel-action':
          this.cancelActive();
          break;
        case 'cancel-reflex':
          // 让位给模型：打断正在跑的反射，它的 finally 会自己收尾。
          this.reflexAbort?.abort();
          break;
        case 'resume':
          this.resumeActive(effect.args, effect.checkpoint);
          break;
        case 'resolve-tool':
          // 动作工具已经异步返回 accepted，这里只清掉当前调用。
          this.active = null;
          break;
      }
    }
  }

  private context(call: ActiveCall, attempt: number): ActionContext {
    return {
      signal: call.controller.signal,
      checkpoint: (value: unknown) => {
        // 过期执行的进度不能写进新一轮：attempt 也必须是当前这次。
        if (this.active !== call || call.attempt !== attempt) return;
        this.reduce({ kind: 'checkpoint', value });
      },
    };
  }

  private armHardTimer(call: ActiveCall, controller: AbortController): void {
    call.hardTimer = setTimeout(() => {
      call.timedOut = true;
      controller.abort();
    }, ACTION_HARD_TIMEOUT_MS);
    (call.hardTimer as { unref?: () => void }).unref?.();
  }

  private clearHardTimer(call: ActiveCall): void {
    if (call.hardTimer != null) clearTimeout(call.hardTimer);
    call.hardTimer = null;
  }

  private cancelActive(): void {
    const call = this.active;
    if (call == null || call.interrupted) return;
    call.interrupted = true;
    call.interrupts += 1;
    call.interruptedAt = this.nowMs();
    call.controller.abort();
  }

  private resumeActive(args: unknown, checkpoint: unknown): void {
    const call = this.active;
    if (call == null) return;
    call.resuming = true;
    call.interrupted = false;
    if (args != null && typeof args === 'object') call.args = args as Record<string, unknown>;
    call.resumeFrom = checkpoint;
    call.interruptMs += Math.max(0, this.nowMs() - call.interruptedAt);
    call.controller = new AbortController();
    call.timedOut = false;
    call.settled = this.runAndDeliver(call);
  }

  /** 异步动作的完成出口：只发一条 L3 Tool 事件。 */
  private deliverToolDone(call: ActiveCall, text: string): void {
    this.notify({
      type: 'tool.done',
      kind: 'Tool',
      level: 3,
      payload: { tool: call.tool, callId: call.callId },
      text: `${call.tool} 完成：${text}`,
      ts: this.nowMs(),
    });
  }

  private async runAndDeliver(call: ActiveCall): Promise<void> {
    const text = await this.execute(call);
    if (text == null) return; // 被抢占，等续做；或已被 Stop/断线
    if (this.active !== call) return;
    this.active = null;
    this.deliverToolDone(call, call.timedOut ? `动作超过 ${Math.round(ACTION_HARD_TIMEOUT_MS / 60_000)} 分钟，已强制中止` : text);
  }

  private async execute(call: ActiveCall): Promise<string | null> {
    const attempt = ++call.attempt;
    this.armHardTimer(call, call.controller);
    try {
      const result =
        call.resuming && typeof this.body.resume === 'function'
          ? {
              text: await this.body.resume(
                call.tool,
                call.args,
                this.context(call, attempt),
                call.resumeFrom,
              ),
            }
          : await this.body.execute(call.tool, call.args, this.context(call, attempt));
      if (call.interrupted || call.attempt !== attempt) return null;
      return this.finish(call, result.text);
    } catch (error: unknown) {
      if (call.interrupted || call.attempt !== attempt) return null;
      if (call.timedOut) return this.finish(call, '动作超时，已强制中止');
      return this.finish(call, `执行出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.clearHardTimer(call);
    }
  }

  private finish(call: ActiveCall, text: string): string {
    let note = '';
    if (call.interrupts > 0) {
      const how = call.resumeFrom === undefined ? '已重新开始' : '已从断点续做';
      note = `\n（中途被打断 ${call.interrupts} 次，共 ${Math.round(call.interruptMs)}ms，${how}）`;
    }
    const reduction = this.reduce({ kind: 'action-done', epoch: call.epoch });
    const body = reduction.outcome !== 'applied' ? `${reduction.trace.detail}：` : '';
    return clampToolOutput(`${body}${text}${note}`, this.maxToolOutputChars);
  }

  // ── 反射层：同一时刻只跑一个；高优先级可以抢低优先级 ──

  private activeReflex(): ReflexSpec | null {
    const body = this.state.body;
    if (body == null || body.by !== 'reflex') return null;
    return this.reflexes.find((spec) => spec.name === body.name) ?? null;
  }

  private startReflex(spec: ReflexSpec): void {
    const active = this.activeReflex();
    if (this.reflexWorks.size > 0) {
      if (active == null || !active.interruptible || spec.priority <= active.priority) return;
      this.reflexAbort?.abort();
    }
    const work = this.runReflex(spec);
    this.reflexWorks.add(work);
    void work
      .finally(() => {
        this.reflexWorks.delete(work);
      })
      .catch(() => {
        // runReflex 内部已有兜底；这里防 finally 阶段出现未处理 rejection。
      });
  }

  private async runReflex(spec: ReflexSpec): Promise<void> {
    const reduction = this.reduce({
      kind: 'claim-reflex',
      name: spec.name,
      priority: spec.priority,
      interruptible: spec.interruptible,
      ...(spec.yieldToModel === true ? { yieldToModel: true } : {}),
    });
    if (reduction.outcome !== 'applied') return;

    // 反射持有身体期间，L3/L4 先排队，避免模型被叫醒抢走/终止安全反射。
    this.intake.reflexStarted();

    const controller = new AbortController();
    this.reflexAbort = controller;
    try {
      await this.runReflexImpl?.(spec.name, controller.signal);
    } catch {
      // 反射失败不能拖垮装配线；它自己应该把失败写成事件。
    } finally {
      if (this.reflexAbort === controller) this.reflexAbort = null;
      // 信号被 abort = 它已经被抢走了（更高优先级反射 / 模型要动手 / Stop / 断线），
      // 身体早就不属于它了：再发 reflex-done 只会被"没有在跑"拒绝，把轨迹弄脏。
      if (!controller.signal.aborted) this.reduce({ kind: 'reflex-done', name: spec.name });
      // manual 策略：不续做，给模型一条明确的完成事件。
      if (this.active != null && this.state.body == null && this.state.pendingResume == null) {
        const call = this.active;
        this.active = null;
        this.deliverToolDone(call, `被 ${spec.name} 打断，未续做`);
      }
      // 所有反射都结束后才放行排队的 L3/L4。
      this.intake.reflexFinished();
    }
  }
}
