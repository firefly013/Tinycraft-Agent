/**
 * Token 预算：按 provider 每次终态响应累计，持久化到 state/token-budget.json。
 *
 * 为什么放在 hook 而不是日志里：日志是旁路，预算必须是硬约束；累计值要跨
 * 进程重启存活，所以落盘。达到上限后主进程退出，supervisor 看门狗
 * 也会读同一个文件做第二道停机。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GenerationTask, hook } from '@earendil-works/pi-durable';
import type { HookRegistration } from '@earendil-works/pi-durable';

export const DEFAULT_TOKEN_BUDGET = 30_000_000;

export interface TokenBudgetState {
  used: number;
  limit: number;
  updatedAt: number;
  exhausted: boolean;
}

export interface TokenBudgetOptions {
  statePath: string;
  limit?: number;
  /** 达到上限时调用一次；主进程在这里落停机标记并退出。 */
  onExhausted?: () => void;
  /** 每次有 usage 时调用（实时监控出口）。 */
  onUpdate?: (state: TokenBudgetState) => void;
}

export interface TokenBudget {
  hook: HookRegistration;
  snapshot(): TokenBudgetState;
}

function readState(path: string): TokenBudgetState | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TokenBudgetState>;
    if (typeof raw.used !== 'number' || !Number.isFinite(raw.used)) return null;
    return {
      used: Math.max(0, Math.floor(raw.used)),
      // limit = 0 表示不限（只统计用量，不做硬停）。
      limit: typeof raw.limit === 'number' && raw.limit >= 0 ? Math.floor(raw.limit) : DEFAULT_TOKEN_BUDGET,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      exhausted: raw.exhausted === true,
    };
  } catch {
    return null;
  }
}

function writeState(path: string, state: TokenBudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

function tokenCount(message: { usage?: { totalTokens?: number; input?: number; output?: number } }): number {
  const usage = message.usage;
  if (usage == null) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    return Math.max(0, Math.floor(usage.totalTokens));
  }
  const input = typeof usage.input === 'number' && Number.isFinite(usage.input) ? usage.input : 0;
  const output = typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : 0;
  return Math.max(0, Math.floor(input + output));
}

export function createTokenBudget(options: TokenBudgetOptions): TokenBudget {
  // limit = 0 表示不限：只统计用量，不做硬停。
  const limit = options.limit == null ? DEFAULT_TOKEN_BUDGET : Math.max(0, Math.floor(options.limit));
  const previous = readState(options.statePath);
  const state: TokenBudgetState = previous == null
    ? { used: 0, limit, updatedAt: Date.now(), exhausted: false }
    : { ...previous, limit, updatedAt: Date.now() };
  state.exhausted = limit > 0 && state.used >= state.limit;
  writeState(options.statePath, state);

  let exhaustedCalled = false;
  const checkExhausted = (): void => {
    if (state.limit <= 0 || state.used < state.limit) return;
    state.exhausted = true;
    writeState(options.statePath, state);
    if (exhaustedCalled) return;
    exhaustedCalled = true;
    options.onExhausted?.();
  };

  const budgetHook = hook(GenerationTask, {
    afterResponse: (message) => {
      const tokens = tokenCount(message as { usage?: { totalTokens?: number; input?: number; output?: number } });
      if (tokens <= 0) return undefined;
      state.used += tokens;
      state.updatedAt = Date.now();
      state.exhausted = state.limit > 0 && state.used >= state.limit;
      writeState(options.statePath, state);
      options.onUpdate?.({ ...state });
      checkExhausted();
      return undefined;
    },
  });

  return {
    hook: budgetHook,
    snapshot: () => ({ ...state }),
  };
}
