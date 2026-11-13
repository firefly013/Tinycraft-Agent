/**
 * 单一目标：存在会话文档里，重启不丢。
 *
 * 目标是模型写给自己的持久意图，也是每轮快照的一部分——所以它必须落盘，
 * 不能只是进程内存。
 */
import { defineDoc } from '@earendil-works/pi-durable';

export const GoalDoc = defineDoc<{ goal: string | null }>({
  kind: 'baseline.goal',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ goal: null }),
  checkpointWhen: () => false,
});
