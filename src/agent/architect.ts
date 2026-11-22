/**
 * 架构师调度：把「设计一次建筑」当成一个后台任务。
 *
 * 这里只管生命周期：建蓝图目录、起会话、收集结果、写 meta、发事件、取消、并发。
 * 真正的模型会话在 `design_session.ts`，测试用假会话替换。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BlueprintMeta } from './blueprints.ts';
import { createBlueprint, readBlueprint, updateBlueprint } from './blueprints.ts';

export interface DesignResult {
  /** 给主模型看的一句话结论。 */
  summary: string;
  tags: string[];
  reusable: boolean;
  size: { x: number; y: number; z: number };
  blocks: number;
  materials: Record<string, number>;
}

export interface DesignInput {
  blueprintDir: string;
  blueprintId: string;
  brief: string;
  notes?: string;
  signal: AbortSignal;
}

export interface DesignSession {
  run(input: DesignInput): Promise<DesignResult | null>;
  close?(): Promise<void>;
}

export interface DesignEvent {
  kind: 'done' | 'failed' | 'cancelled';
  taskId: string;
  blueprintId: string;
  text: string;
}

export interface ArchitectureOptions {
  /** 蓝图根目录（`bots/<name>/build/blueprints`）。 */
  blueprintsRoot: string;
  /** 目标 MC 版本。 */
  mc: () => string | null;
  createSession: (blueprintId: string) => DesignSession;
  onEvent: (event: DesignEvent) => void;
}

export interface DesignTaskView {
  taskId: string;
  blueprintId: string;
  brief: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  elapsedMs: number;
}

interface TaskState extends DesignTaskView {
  controller: AbortController;
  session: DesignSession;
}

export interface Architecture {
  start(brief: string, tags?: readonly string[]): DesignTaskView;
  rework(blueprintId: string, notes: string): DesignTaskView;
  cancel(taskId: string): boolean;
  list(): DesignTaskView[];
  /** 等所有任务结束（测试与停机用）。 */
  settle(): Promise<void>;
}

function parseTags(tags: readonly string[] | undefined): string[] {
  if (tags == null) return [];
  const out: string[] = [];
  for (const tag of tags) {
    for (const part of tag.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

function view(task: TaskState, now = Date.now()): DesignTaskView {
  return {
    taskId: task.taskId,
    blueprintId: task.blueprintId,
    brief: task.brief,
    state: task.state,
    startedAt: task.startedAt,
    elapsedMs: now - task.startedAt,
  };
}

export function createArchitecture(options: ArchitectureOptions): Architecture {
  const tasks = new Map<string, TaskState>();
  const running = new Set<Promise<void>>();

  const runTask = (task: TaskState): void => {
    const work = (async () => {
      try {        const result = await task.session.run({
          blueprintDir: join(options.blueprintsRoot, task.blueprintId),
          blueprintId: task.blueprintId,
          brief: task.brief,
          ...(task.taskId === task.blueprintId ? {} : {}),
          signal: task.controller.signal,
        });
        if (task.controller.signal.aborted) {
          task.state = 'cancelled';
          options.onEvent({ kind: 'cancelled', taskId: task.taskId, blueprintId: task.blueprintId, text: `已取消 ${task.taskId}` });
          return;
        }
        if (result == null) {
          task.state = 'failed';
          options.onEvent({
            kind: 'failed',
            taskId: task.taskId,
            blueprintId: task.blueprintId,
            text: `设计失败：${task.taskId} 没有通过自检，蓝图未产出（脚本留在目录里）`,
          });
          return;
        }
        const updated = updateBlueprint(options.blueprintsRoot, task.blueprintId, {
          tags: result.tags,
          reusable: result.reusable,
          size: result.size,
          blocks: result.blocks,
          materials: result.materials,
          mc: options.mc(),
        });
        if (updated == null) throw new Error(`蓝图 ${task.blueprintId} 的 meta 写不进去`);
        task.state = 'done';
        options.onEvent({
          kind: 'done',
          taskId: task.taskId,
          blueprintId: task.blueprintId,
          text: doneText(updated, result),
        });
      } catch (error: unknown) {
        task.state = task.controller.signal.aborted ? 'cancelled' : 'failed';
        const reason = error instanceof Error ? error.message : String(error);
        options.onEvent({
          kind: task.state === 'cancelled' ? 'cancelled' : 'failed',
          taskId: task.taskId,
          blueprintId: task.blueprintId,
          text: task.state === 'cancelled' ? `已取消 ${task.taskId}` : `设计失败：${task.taskId}（${reason}）`,
        });
      } finally {
        try {
          await task.session.close?.();
        } catch {
          // 关闭失败不改变任务结论。
        }
      }
    })();
    running.add(work);
    void work.finally(() => running.delete(work));
  };

  return {
    start(brief, tags) {
      const blueprint = createBlueprint(options.blueprintsRoot, brief, { mc: options.mc() });
      updateBlueprint(options.blueprintsRoot, blueprint.id, { tags: parseTags(tags) });
      const task: TaskState = {
        taskId: blueprint.id,
        blueprintId: blueprint.id,
        brief,
        state: 'running',
        startedAt: Date.now(),
        elapsedMs: 0,
        controller: new AbortController(),
        session: options.createSession(blueprint.id),
      };
      tasks.set(task.taskId, task);
      runTask(task);
      return view(task);
    },

    rework(blueprintId, notes) {
      const existing = readBlueprint(options.blueprintsRoot, blueprintId);
      if (existing == null) throw new Error(`没有这个蓝图：${blueprintId}`);
      if ([...tasks.values()].some((task) => task.blueprintId === blueprintId && task.state === 'running')) {
        throw new Error(`蓝图 ${blueprintId} 正在改，等它跑完`);
      }
      const task: TaskState = {
        taskId: `${blueprintId}~${Date.now().toString(36)}`,
        blueprintId,
        brief: existing.brief,
        state: 'running',
        startedAt: Date.now(),
        elapsedMs: 0,
        controller: new AbortController(),
        session: options.createSession(blueprintId),
      };
      tasks.set(task.taskId, task);
      // 返工：把备注当成本次输入；brief 仍然是原始的。
      const original = task.session.run.bind(task.session);
      task.session = {
        run: (input) => original({ ...input, notes }),
        ...(task.session.close == null ? {} : { close: () => task.session.close!() }),
      };
      runTask(task);
      return view(task);
    },

    cancel(taskId) {
      const task = tasks.get(taskId);
      if (task == null || task.state !== 'running') return false;
      task.controller.abort();
      task.state = 'cancelled';
      return true;
    },

    list() {
      return [...tasks.values()].map((task) => view(task));
    },

    async settle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}

function doneText(meta: BlueprintMeta, result: DesignResult): string {
  const { x, y, z } = result.size;
  const tags = result.tags.length === 0 ? '' : ` · ${result.tags.join(',')}`;
  const reusable = result.reusable ? ' · 可复用' : '';
  return (
    `设计完成：${meta.id} ${x}x${y}x${z} · ${result.blocks} 格${tags}${reusable}\n` +
    `${result.summary}\n` +
    `目录：${join('build', 'blueprints', meta.id)}`
  );
}

/** 蓝图目录是否存在（给返工/施工做前置检查）。 */
export function blueprintExists(root: string, id: string): boolean {
  return existsSync(join(root, id, 'plan.schem'));
}
