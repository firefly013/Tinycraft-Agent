/**
 * 反射表：优先级与匹配的事件类型。
 *
 * 优先级必须唯一（谁先跑要说得清）；执行体住在身体里（`body.reflex(name)`）。
 * 这张表是单一真源：装配层、身体、门禁测试都读它——包括名字常量，
 * 别在别处再写一遍字符串。
 */
import type { ReflexSpec } from '../core/reflex.ts';

export const MLG_REFLEX = 'mlg';
export const COMBAT_REFLEX = 'combat';
export const EAT_REFLEX = 'eat';
export const PICKUP_REFLEX = 'pickup';

export const REFLEXES: readonly ReflexSpec[] = [
  // 落地水：最高优先级——摔死不能等，也不能被模型动作踩掉。
  // 触发条件是"正在掉 + 够高 + 背包有 water_bucket"，由身体每 tick 检测。
  { name: MLG_REFLEX, priority: 40, interruptible: false, types: ['reflex.mlg'] },
  // 战斗：只在身体扫描判定"该动手"时收到 reflex.engage（L5），所以优先级不高。
  { name: COMBAT_REFLEX, priority: 30, interruptible: true, types: ['reflex.engage'] },
  // 进食：低血自动吃。优先级低于战斗——打架时抢身体只会被伤害打断，没意义。
  { name: EAT_REFLEX, priority: 20, interruptible: true, types: ['reflex.eat'] },
  // 拾取：最低优先级，身体空闲时才由扫描触发；可被任何反射抢占，
  // 且 `yieldToModel`——模型一发动作它就让位（它只是模型思考时的填充活动）。
  { name: PICKUP_REFLEX, priority: 10, interruptible: true, yieldToModel: true, types: ['item.drop.nearby'] },
];
