/** 能直接吃的东西。不在表里的不自动吃（蜂蜜瓶、迷之炖菜这类先不碰）。 */
const FOODS: ReadonlySet<string> = new Set([
  'bread',
  'apple',
  'golden_apple',
  'enchanted_golden_apple',
  'carrot',
  'golden_carrot',
  'baked_potato',
  'melon_slice',
  'sweet_berries',
  'cookie',
  'pumpkin_pie',
  'dried_kelp',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'cooked_salmon',
  'cooked_cod',
  // 生肉（除了生鸡肉）：打猎直接掉这些，饥荒时能顶一阵。
  'beef',
  'porkchop',
  'mutton',
  'rabbit',
]);

export function isFood(name: string): boolean {
  return FOODS.has(name.replace(/^minecraft:/, ''));
}
