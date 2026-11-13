/**
 * 事件投递。
 *
 * 只有两个独立标志：**身体动作是否忙**在控制面，**模型请求是否在飞**在这里。
 * L3 的整流只看请求标志：`requestInFlight` 为 true 时只攒；请求一结束
 * （afterResponse）立刻把攒下的整批一次性 submit。
 *
 * 等级只决定"叫模型多用力"，不决定身体：
 *   2 写记录，不唤醒
 *   3 请求空闲就立刻整批 submit；请求在飞就整流，等 requestFinished 一起带走
 *   4 abort → 撤回在途批次 → 立刻 submit
 *   5 基线设计不唤醒：只写记录；身体由反射层接管
 */
import { batchText, isValidLevel, LEVEL } from './events.ts';
import type { LogEvent } from './events.ts';

export type EventAction = 'written' | 'steer' | 'preempt' | 'emergency';

/** submit 的落定凭据：提交成功但还没落定时，inFlight 先留着给 abort 撤回。 */
export interface SubmitReceipt {
  settled?: Promise<unknown>;
}

export interface IntakeDeps {
  /** 把一批事件作为一次引导提交发给模型。 */
  submit(text: string): Promise<SubmitReceipt | void>;
  /** 只记录、不唤醒。 */
  write(events: readonly LogEvent[], text: string): Promise<void>;
  /** 打断当前 provider 请求。 */
  abort(): Promise<void>;
  onEvent?: (event: LogEvent, action: EventAction) => void;
  onError?: (error: unknown) => void;
}

export class EventIntake {
  private deps: IntakeDeps | null = null;
  /** 优先通道：L4/L5。 */
  private urgent: LogEvent[] = [];
  /** 普通通道：L2/L3。 */
  private normal: LogEvent[] = [];
  /** 只记录的一批。 */
  private writes: LogEvent[] = [];
  /** 要唤醒的一批。 */
  private wake: LogEvent[] = [];
  /** 有攒着的 L3。 */
  private needsRequest = false;
  /**
   * 唯一的请求标志：有一次 provider 请求正在飞。
   * `beforeRequest` 置 true，`afterResponse` 置 false——**不是**整个 run 结束。
   */
  private requestInFlight = false;
  /** 已提交、还没落定的一批：abort 会撤回它。 */
  private inFlight: LogEvent[] | null = null;
  private pump: Promise<void> | null = null;
  /** 本次泵里 write 失败过：不要在同一轮里紧循环重试。 */
  private writeFailed = false;
  /** 当前是否被反射持有身体；期间 L3/L4 只排队，不唤醒。 */
  private reflexActive = 0;
  private readonly deferred: LogEvent[] = [];

  /** 必须先接上运行时（Runner 构造时就 attach；不缓冲 attach 之前的事件）。 */
  attach(deps: IntakeDeps): void {
    if (this.deps != null) throw new Error('EventIntake 已经接上运行时，不能重复接');
    this.deps = deps;
  }

  /** 同步接收一条事件：接收时不产生任何副作用，处理排进泵里。 */
  notify(event: LogEvent): void {
    const deps = this.deps;
    if (deps == null) return;
    // 等级 1 是保留空位：不 throw（这里在回调里被就地调用），但绝不静默收下。
    if (!isValidLevel(event.level)) {
      this.reportError(deps, new RangeError(`非法事件等级 ${String(event.level)}（1 是保留空位）：${event.type}`));
      return;
    }
    // 反射持有身体时，普通聊天/系统事件先排队；反射结束后再交付。
    // L4 也不能在这个窗口里打断安全反射（例如落地水）。
    if (this.reflexActive > 0 && (event.level === LEVEL.WAKE || event.level === LEVEL.PREEMPT)) {
      this.deferred.push(event);
      return;
    }
    if (event.level >= LEVEL.PREEMPT) this.urgent.push(event);
    else this.normal.push(event);
    void this.start(deps);
  }

  /** 反射开始持有身体：期间 L3/L4 都先排队，避免模型被叫醒去终止安全反射。 */
  reflexStarted(): void {
    this.reflexActive += 1;
  }

  /** 反射全部结束：把排队的事件按原顺序重新投递。 */
  reflexFinished(): void {
    this.reflexActive = Math.max(0, this.reflexActive - 1);
    if (this.reflexActive > 0) return;
    const pending = this.deferred.splice(0);
    for (const event of pending) this.notify(event);
    // 反射期间被撤回的唤醒批不会自己发出去：这里补一脚。
    const deps = this.deps;
    if (deps != null && this.needsRequest) void this.start(deps);
  }

  /**
   * 掐掉正在生成的那一轮，**不写记录、不唤醒**。
   *
   * 给静默事件用：反射接管身体后，模型这一轮的结论必然是撞 busy，
   * 让它说完只是白烧 token。只在真的有请求在飞时才动（空闲时 abort 没有意义）。
   */
  async interrupt(): Promise<void> {
    const deps = this.deps;
    if (deps == null || !this.requestInFlight) return;
    try {
      await this.settle();
      await this.abortAndWithdraw(deps);
    } catch (error: unknown) {
      this.reportError(deps, error);
    }
  }

  /** 一次 provider 请求开始：请求标志占用，这期间 L3 只攒不发。 */
  requestStarted(): void {
    this.requestInFlight = true;
  }

  /** 一次 provider 请求结束：释放标志；有攒着的 L3 就立刻整批发出去。 */
  requestFinished(): void {
    this.requestInFlight = false;
    const deps = this.deps;
    if (deps != null && this.needsRequest) void this.start(deps);
  }

  /** 等当前排队的投递落定。 */
  async settle(): Promise<void> {
    while (this.pump != null) await this.pump;
  }

  private start(deps: IntakeDeps): Promise<void> {
    if (this.pump == null) {
      this.pump = Promise.resolve().then(async () => {
        this.writeFailed = false;
        // 泵要一直排空到队列真的空：drain 里 await submit 期间新到的事件
        // 也必须被这一轮带走，否则它会一直躺着等下一条事件。
        do {
          await this.drain(deps);
        } while (!this.writeFailed && this.urgent.length + this.normal.length + this.writes.length > 0);
        this.pump = null;
      });
    }
    return this.pump;
  }

  /** 观测钩子自己抛错不能打死投递泵。 */
  private reportError(deps: IntakeDeps, error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // 吞掉：这里的职责是让泵活着。
    }
  }

  private async drain(deps: IntakeDeps): Promise<void> {
    for (;;) {
      const event = this.urgent.shift() ?? this.normal.shift();
      if (event === undefined) break;
      try {
        await this.handle(event, deps);
      } catch (error: unknown) {
        this.reportError(deps, error);
      }
    }
    try {
      await this.flushWrites(deps);
    } catch (error: unknown) {
      this.reportError(deps, error);
    }
    try {
      await this.flushWake(deps);
    } catch (error: unknown) {
      this.reportError(deps, error);
    }
  }

  private async handle(event: LogEvent, deps: IntakeDeps): Promise<void> {
    switch (event.level) {
      case LEVEL.STATE: {
        this.writes.push(event);
        deps.onEvent?.(event, 'written');
        return;
      }
      case LEVEL.WAKE: {
        this.wake.push(event);
        this.needsRequest = true;
        deps.onEvent?.(event, 'steer');
        return;
      }
      case LEVEL.PREEMPT: {
        // 先把事件收进待投批，再 abort：abort 抛错时事件也不能丢。
        this.wake.push(event);
        this.needsRequest = true;
        await this.abortAndWithdraw(deps);
        await this.flushWake(deps, true);
        deps.onEvent?.(event, 'preempt');
        return;
      }
      case LEVEL.EMERGENCY: {
        // 基线设计：L5 不唤醒模型，只写记录；身体由反射层接管。
        this.writes.push(event);
        await this.abortAndWithdraw(deps);
        deps.onEvent?.(event, 'emergency');
        return;
      }
      default: {
        this.reportError(deps, new Error(`未知等级 ${String(event.level)}`));
      }
    }
  }

  /**
   * 打断：撤回在途批次 + abort()。和旧项目一致，**不判断请求是否在生成**：
   * 请求标志只负责整流，L4/L5 该打断就打断。
   */
  private async abortAndWithdraw(deps: IntakeDeps): Promise<void> {
    const withdrawn = this.inFlight;
    if (withdrawn != null) {
      this.inFlight = null;
      this.wake.unshift(...withdrawn);
      // 撤回来的是一批**唤醒**：不恢复标记的话，它们要等下一个 L3 才发得出去。
      this.needsRequest = true;
    }
    try {
      await deps.abort();
      // 被打断的这一轮**不会**再走 afterResponse（框架把它记成 aborted），
      // 标志必须在这里放掉；否则之后所有 L3 都会被永久扣住，模型再也醒不过来。
      this.requestInFlight = false;
    } catch (error: unknown) {
      // abort 失败说明当前这次打断没成功；把标志放开，后续 L3 不能永久卡住。
      this.requestInFlight = false;
      throw error;
    }
  }

  /** 只记录、不唤醒的一批一次写完。 */
  private async flushWrites(deps: IntakeDeps): Promise<void> {
    if (this.writes.length === 0) return;
    const batch = this.writes;
    this.writes = [];
    try {
      await deps.write(batch, batchText(batch));
    } catch (error: unknown) {
      this.writeFailed = true;
      this.writes.unshift(...batch);
      throw error;
    }
  }

  /**
   * 请求标志释放后的那一发：把攒下的整批一次性提交。
   * `force` 只给 L4/L5：请求在飞也要发（那是"打断立刻插入"）。
   */
  private async flushWake(deps: IntakeDeps, force = false): Promise<void> {
    // 反射持有身体期间不投递唤醒——那正是"不该清醒"的窗口。
    if (!force && (this.requestInFlight || this.reflexActive > 0 || !this.needsRequest)) return;
    if (this.wake.length === 0) return;
    const batch = this.wake;
    this.wake = [];
    this.needsRequest = false;
    this.inFlight = batch;
    try {
      const receipt = await deps.submit(batchText(batch));
      if (receipt != null && receipt.settled != null) {
        // 落定之后才清 inFlight：这期间 abort 还能把这一批撤回。
        const clear = (): void => {
          if (this.inFlight === batch) this.inFlight = null;
        };
        void receipt.settled.then(clear, clear);
      } else {
        this.inFlight = null;
      }
    } catch (error: unknown) {
      // 提交失败：这一批放回去，并且恢复"该唤醒"的标记。
      this.inFlight = null;
      this.wake.unshift(...batch);
      this.needsRequest = true;
      throw error;
    }
  }
}
