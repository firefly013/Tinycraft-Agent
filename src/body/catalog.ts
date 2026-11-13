/**
 * 14 个工具：模型看到的全部能力面。
 *
 * 名字沿用旧仓库（模型已经学会）；**说明文字全部在 `src/prompts.ts`**，
 * 这里只留结构：名字、占不占身体、续做策略、参数类型。
 *
 * 动作工具的执行契约由 Runner 统一保证：**调用立刻 accepted，完成以 L3 Tool
 * 事件回报**。`mode` 字段只保留给历史查询/本地工具语义，动作工具一律异步。
 *
 * 续做策略：只有明确标了 `auto`/`checkpoint` 的会机械续做，其余默认 `manual`。
 * 有副作用的动作（mineBlock/placeBlock/inventory/attack…）不允许被抢占后自动重放。
 */
import { TOOL_TEXT } from '../prompts.ts';
import type { ToolDeclaration } from '../shared/tools.ts';

/** 只有结构；description 由 prompts.ts 填。 */
type Declaration = Omit<ToolDeclaration, 'description'>;

const DECLARATIONS: readonly Declaration[] = [
  {
    name: 'goTo',
    mode: 'async',
    action: true,
    resume: 'auto',
    params: { x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } },
  },
  {
    name: 'mineBlock',
    mode: 'async',
    action: true,
    // 有副作用：抢到一半被打断不自动重放。
    resume: 'manual',
    params: {
      x: { type: 'int' },
      y: { type: 'int' },
      z: { type: 'int' },
      force: { type: 'boolean', optional: true },
    },
  },
  {
    name: 'collectBlock',
    mode: 'async',
    action: true,
    resume: 'checkpoint',
    params: {
      type: { type: 'string' },
      count: { type: 'int', optional: true },
      radius: { type: 'int', optional: true },
      scope: { type: 'string', optional: true },
    },
  },
  {
    name: 'placeBlock',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: { type: { type: 'string' }, x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } },
  },
  {
    name: 'placeHere',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: { type: { type: 'string' } },
  },
  {
    name: 'container',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: {
      op: { type: 'string' },
      items: { type: 'string', optional: true },
      type: { type: 'string', optional: true },
      coords: { type: 'string', optional: true },
    },
  },
  {
    name: 'useBlock',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: { x: { type: 'int' }, y: { type: 'int' }, z: { type: 'int' } },
  },
  {
    name: 'craft',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: { item: { type: 'string' }, count: { type: 'int', optional: true } },
  },
  {
    name: 'furnace',
    mode: 'async',
    action: true,
    // 只对 smelt 有效（它写检查点）；put 被续做时只回一句"不确定，先看一眼"。
    resume: 'checkpoint',
    params: {
      op: { type: 'string' },
      slot: { type: 'string', optional: true },
      items: { type: 'string', optional: true },
      fuel: { type: 'string', optional: true },
      coords: { type: 'string', optional: true },
    },
  },
  {
    name: 'attack',
    mode: 'async',
    action: true,
    resume: 'manual',
    params: {
      entityId: { type: 'int', optional: true },
      target: { type: 'string', optional: true },
      type: { type: 'string', optional: true },
    },
  },
  {
    name: 'inventory',
    mode: 'sync',
    action: true,
    resume: 'manual',
    params: {
      op: { type: 'string' },
      slot: { type: 'int', optional: true },
      count: { type: 'int', optional: true },
    },
  },
  { name: 'Finish', mode: 'sync', action: false },
  { name: 'Stop', mode: 'sync', action: false },
  {
    name: 'UpdateGoal',
    mode: 'sync',
    action: false,
    params: { goal: { type: 'string' } },
  },
];

/** 把 prompts.ts 里的文字贴到结构上。 */
function withText(declaration: Declaration): ToolDeclaration {
  const text = TOOL_TEXT[declaration.name];
  if (text == null) throw new Error(`工具 ${declaration.name} 缺提示词（src/prompts.ts）`);
  const params =
    declaration.params == null
      ? undefined
      : Object.fromEntries(
          Object.entries(declaration.params).map(([key, param]) => [
            key,
            text.params?.[key] == null ? param : { ...param, description: text.params[key] },
          ]),
        );
  return { ...declaration, description: text.description, ...(params == null ? {} : { params }) };
}

/** 所有模型可见工具都必须带这个参数：解释这一次调用是为了干什么。 */
export const TOOL_INTENT_PARAM_DESCRIPTION =
  '必填；用一句话说明这一次调用是为了干什么（人会看，也会进工具调用日志）';

/** 给每个工具补上 descriptions 参数，保证“每次调用都解释目的”是契约而不是自觉。 */
function withIntent(declaration: ToolDeclaration): ToolDeclaration {
  return {
    ...declaration,
    params: {
      ...(declaration.params ?? {}),
      descriptions: { type: 'string', description: TOOL_INTENT_PARAM_DESCRIPTION },
    },
  };
}

export const CATALOG: readonly ToolDeclaration[] = DECLARATIONS.map(withText).map(withIntent);

export const TOOL_BY_NAME = new Map(CATALOG.map((tool) => [tool.name, tool]));
