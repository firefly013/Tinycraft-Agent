/**
 * 工具声明：模型看到的与身体实现的唯一契约。
 *
 * 动作类工具（action=true）的执行契约统一由 Runner 保证：
 *   调用立刻 accepted 并**结束本轮 run**（`terminate`），完成/失败以 L3 Tool
 *   事件回来再叫醒模型。没有 terminate 的话，框架会在回执之后再问模型一次，
 *   模型只能在一个信息为零的回合里轮询或重发——这是撞锁的来源。
 * `mode` 只保留给历史声明/查询工具，动作路径不再区分 sync/async。
 *
 * 续做策略是声明上的数据；控制面只存不透明检查点，不认识工具。
 */

export type ToolMode = 'sync' | 'async';

/** 一次工具调用的结果：给模型看的文本 + 是否就此结束本轮。 */
export interface ToolOutcome {
  text: string;
  /**
   * true = 这一轮到此为止，不要再向模型发下一次请求。
   *
   * 只给"动作已下达、身体在跑"的回执：模型该睡，完成事件会再叫醒它。
   * 参数错误 / 身体忙 / 查询类结果一律不发 terminate——那些信息模型现在就要用。
   */
  terminate?: boolean;
}

/** 动作被抢占后怎么续：auto 重新开始 / checkpoint 从上报的进度续 / manual 不续。 */
export type ResumePolicy = 'auto' | 'checkpoint' | 'manual';

export interface ToolParam {
  type: 'string' | 'int' | 'float' | 'boolean';
  description?: string;
  optional?: boolean;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  mode: ToolMode;
  /** 动作类要占身体通道；查询类不占。 */
  action: boolean;
  params?: Record<string, ToolParam>;
  /** 被抢占后怎么续。缺省 auto。 */
  resume?: ResumePolicy;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type Validation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; issues: ValidationIssue[] };

/**
 * 只校验输入，不裁决意图。
 *
 * 参数名拼错、类型不对、少必填 —— 报错，模型能自己修。
 * "该不该挖这块石头"不在这里，也不在任何别的地方。
 */
export function checkArgs(declaration: ToolDeclaration, args: Record<string, unknown> | null | undefined): Validation {
  const given: Record<string, unknown> = args ?? {};
  const params = declaration.params ?? {};
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(given)) {
    if (!(key in params)) issues.push({ path: key, message: '没有这个参数' });
  }
  for (const [key, param] of Object.entries(params)) {
    const value = given[key];
    if (value === undefined || value === null) {
      if (param.optional !== true) issues.push({ path: key, message: '缺少必填参数' });
      continue;
    }
    if (!matchesType(param.type, value)) {
      issues.push({ path: key, message: `要 ${param.type}，给的是 ${typeof value}` });
    }
  }

  return issues.length === 0 ? { ok: true, args: given } : { ok: false, issues };
}

function matchesType(type: ToolParam['type'], value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return false;
  }
}
