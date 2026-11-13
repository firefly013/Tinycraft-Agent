/**
 * 反射层：只排"谁先跑"，不裁决"该不该"。
 *
 * 过滤器在前（类型匹配），排序在后（priority）；抢不抢得动由 Runner 按
 * `interruptible` 与 `priority` 决定——这一层不持有运行时状态。
 */

export interface ReflexSpec {
  name: string;
  /** 越大越先。 */
  priority: number;
  /** 能不能被更高优先级抢走。 */
  interruptible: boolean;
  /**
   * 模型动作可以抢它。
   *
   * 只给"身体空闲时的填充活动"开（拾取）；安全反射（战斗/进食）不许开——
   * 模型一个 goTo 把它踩掉，是安全问题。
   */
  yieldToModel?: boolean;
  types: readonly string[];
}

export interface ActiveReflex {
  name: string;
  priority: number;
}

export type ReflexVerdict = { kind: 'run'; spec: ReflexSpec } | { kind: 'ignore'; reason: string };

/** 事件类型 → 该跑哪个反射。`active` 是当前占着身体的反射。 */
export function selectReflex(
  specs: readonly ReflexSpec[],
  type: string,
  active: ActiveReflex | null,
): ReflexVerdict {
  let top: ReflexSpec | null = null;
  for (const spec of specs) {
    if (!spec.types.includes(type)) continue;
    if (top == null || spec.priority > top.priority) top = spec;
  }
  if (top == null) return { kind: 'ignore', reason: `没有反射接 ${type}` };
  if (active == null) return { kind: 'run', spec: top };
  if (active.name === top.name) return { kind: 'ignore', reason: `${top.name} 已经在跑` };
  if (top.priority > active.priority) return { kind: 'run', spec: top };
  return { kind: 'ignore', reason: `${top.name}(${top.priority}) 让给 ${active.name}(${active.priority})` };
}

/** 优先级与名字都必须唯一：重复了说明"谁先""谁结束"已经说不清。 */
export function assertUniquePriorities(specs: readonly ReflexSpec[]): void {
  const byPriority = new Map<number, string>();
  const names = new Set<string>();
  for (const spec of specs) {
    const other = byPriority.get(spec.priority);
    if (other != null) throw new Error(`反射优先级重复：${other} 与 ${spec.name} 都是 ${spec.priority}`);
    byPriority.set(spec.priority, spec.name);
    if (names.has(spec.name)) throw new Error(`反射名字重复：${spec.name}`);
    names.add(spec.name);
  }
}
