/**
 * 身体契约。
 *
 * 一次执行带三样东西：
 *   signal     —— 取消的唯一通道
 *   resume     —— 上次被打断时存下的检查点（第一次执行是 undefined）
 *   checkpoint —— 执行中上报进度；被抢占时会被存下来，续做时原样送回来
 *
 * 它比 agent 低一层，所以类型放在这里，body 不需要反向 import agent。
 */
export interface ActionContext {
  readonly signal: AbortSignal;
  /** 上次被打断时存的检查点；第一次执行是 undefined。 */
  readonly resume: unknown;
  /** 执行中上报进度（只对数得清的工具有效，比如"已经收了几个"）。 */
  checkpoint(value: unknown): void;
}

export interface Body {
  execute(name: string, args: Record<string, unknown>, context: ActionContext): Promise<{ text: string }>;
  /**
   * **有序停机的清理钩子**：只有登记了清理的动作才有，返回值是收拾结果（人话）。
   *
   * 它和 `execute` 的 abort 分工不同：abort 让动作**松手**（停寻路/停挖/关窗口），
   * cleanup 把动作留在外部世界里的状态**收回来**（比如把熔炉清空）。
   * 调用方保证：清理期间身体锁还在这条动作身上，且有自己的超时信号。
   */
  stop?(name: string, context: ActionContext, checkpoint: unknown): Promise<string>;
}

/**
 * 把一段可能立刻返回、也可能跑很久的操作接到取消信号上。
 *
 * 取消时先调 `onAbort`（停掉底层动作，比如 `stopDigging` / `pathfinder.stop`），
 * 再以 `aborted` 拒绝——否则回执已经返回、锁已经释放，身体却还在动。
 */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  const abortWork = (): void => {
    try {
      onAbort?.();
    } catch {
      // 停不下来也照样按取消处理。
    }
  };
  if (signal.aborted) {
    abortWork();
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      abortWork();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}