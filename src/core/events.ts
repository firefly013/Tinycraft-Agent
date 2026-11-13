/**
 * 事件词表。
 *
 * 等级只回答"要用多大力气把模型叫来看一眼"，不决定谁来处理：
 *   2 只记录 / 3 唤醒 / 4 打断请求并唤醒 / 5 打断动作与请求、交给反射层、不唤醒。
 *
 * 等级 5 的定义里**没有**"重新叫醒模型"这一条。
 */

export const LEVEL = Object.freeze({
  UNUSED: 1,
  STATE: 2,
  WAKE: 3,
  PREEMPT: 4,
  EMERGENCY: 5,
} as const);

export type Level = 2 | 3 | 4 | 5;

/** 等级 1 是保留空位：任何一条 1 都是协议错误，不是"更弱的记账档"。 */
export function isValidLevel(value: number): value is Level {
  return Number.isInteger(value) && value >= LEVEL.STATE && value <= LEVEL.EMERGENCY;
}

export type Kind = 'User' | 'World' | 'Tool' | 'Model';

/** 一条事件。`type` 是处理的匹配键，也是两侧唯一的共同词汇。 */
export interface LogEvent {
  type: string;
  kind: Kind;
  level: Level;
  /** 原始载荷：坐标、数量这类结构化信息不改写。 */
  payload: unknown;
  /** 给模型看的文本。 */
  text: string;
  /**
   * 只用于内部触发（例如交给反射层），不进模型上下文。
   * 模型无感的自动行为靠它：事件照常参与匹配，但不写进请求。
   */
  silent?: boolean;
  /** 发生时刻（毫秒）。 */
  ts: number;
}

/** 一批事件给模型看的正文：一条一段。 */
export function batchText(events: readonly LogEvent[]): string {
  return events.map((event) => event.text).join('\n\n');
}
