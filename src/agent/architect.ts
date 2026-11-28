/**
 * 建筑子模型会话调度。
 *
 * 会话元数据持久化，真正的模型运行时按需打开/关闭；这里只保留活动运行句柄。
 * 主模型通过稳定 Session ID 打回意见，同一蓝图逐 revision 交付。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BlueprintMeta } from './blueprints.ts';
import { createBlueprint, readBlueprint, updateBlueprint } from './blueprints.ts';
import type { BuildDelivery, BuildSessionMeta } from './build_sessions.ts';
import {
  createBuildSession,
  listBuildSessions,
  readBuildSession,
  recoverInterruptedSessions,
  writeBuildSession,
} from './build_sessions.ts';

export type { BuildDelivery } from './build_sessions.ts';

export interface DesignInput {
  sessionId: string;
  blueprintDir: string;
  blueprintId: string;
  brief: string;
  /** 本次追加给子模型的输入：首次是 brief，后续是主模型审稿意见。 */
  message: string;
  /** 本次尝试交付的 revision。 */
  revision: number;
  signal: AbortSignal;
}

export interface DesignSession {
  run(input: DesignInput): Promise<BuildDelivery | null>;
  close?(): Promise<void>;
}

export interface DesignEvent {
  kind: 'done' | 'failed' | 'cancelled';
  sessionId: string;
  blueprintId: string;
  revision: number;
  text: string;
}

export interface ArchitectureOptions {
  blueprintsRoot: string;
  sessionsRoot: string;
  mc: () => string | null;
  createSession: (sessionId: string, blueprintId: string) => DesignSession;
  onEvent: (event: DesignEvent) => void;
}

export interface DesignTaskView {
  sessionId: string;
  blueprintId: string;
  brief: string;
  state: BuildSessionMeta['state'];
  revision: number;
}

export interface Architecture {
  start(brief: string, tags?: readonly string[]): DesignTaskView;
  send(sessionId: string, message: string): DesignTaskView;
  accept(sessionId: string): boolean;
  cancel(sessionId: string): boolean;
  get(sessionId: string): BuildSessionMeta | null;
  list(): DesignTaskView[];
  settle(): Promise<void>;
}

interface ActiveRun {
  controller: AbortController;
  work: Promise<void>;
}

function parseTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    for (const part of tag.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

function view(meta: BuildSessionMeta): DesignTaskView {
  return {
    sessionId: meta.sessionId,
    blueprintId: meta.blueprintId,
    brief: meta.brief,
    state: meta.state,
    revision: meta.revision,
  };
}

export function createArchitecture(options: ArchitectureOptions): Architecture {
  const active = new Map<string, ActiveRun>();
  recoverInterruptedSessions(options.sessionsRoot, new Set());

  const run = (initial: BuildSessionMeta, message: string): DesignTaskView => {
    const revision = initial.revision + 1;
    const running = writeBuildSession(options.sessionsRoot, {
      ...initial,
      state: 'running',
      lastError: undefined,
    });
    const controller = new AbortController();
    const session = options.createSession(running.sessionId, running.blueprintId);
    const work = (async (): Promise<void> => {
      try {
        const result = await session.run({
          sessionId: running.sessionId,
          blueprintDir: join(options.blueprintsRoot, running.blueprintId),
          blueprintId: running.blueprintId,
          brief: running.brief,
          message,
          revision,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          writeBuildSession(options.sessionsRoot, { ...running, state: 'cancelled' });
          options.onEvent({
            kind: 'cancelled',
            sessionId: running.sessionId,
            blueprintId: running.blueprintId,
            revision,
            text: `已取消会话 ${running.sessionId}`,
          });
          return;
        }
        if (result == null) {
          writeBuildSession(options.sessionsRoot, {
            ...running,
            state: 'failed',
            lastError: '没有通过自检，蓝图未产出',
          });
          options.onEvent({
            kind: 'failed',
            sessionId: running.sessionId,
            blueprintId: running.blueprintId,
            revision,
            text: `设计失败：${running.sessionId} 没有通过自检，蓝图未产出（脚本留在目录里）`,
          });
          return;
        }
        const delivery: BuildDelivery = { ...result, revision };
        const updated = updateBlueprint(options.blueprintsRoot, running.blueprintId, {
          tags: delivery.tags,
          reusable: delivery.reusable,
          size: delivery.size,
          blocks: delivery.blocks,
          materials: delivery.materials,
          mc: options.mc(),
        });
        if (updated == null) throw new Error(`蓝图 ${running.blueprintId} 的 meta 写不进去`);
        writeBuildSession(options.sessionsRoot, {
          ...running,
          state: 'awaiting_review',
          revision,
          lastDelivery: delivery,
          lastError: undefined,
        });
        options.onEvent({
          kind: 'done',
          sessionId: running.sessionId,
          blueprintId: running.blueprintId,
          revision,
          text: doneText(updated, delivery, running.sessionId),
        });
      } catch (error: unknown) {
        const cancelled = controller.signal.aborted;
        const reason = error instanceof Error ? error.message : String(error);
        writeBuildSession(options.sessionsRoot, {
          ...running,
          state: cancelled ? 'cancelled' : 'failed',
          lastError: reason,
        });
        options.onEvent({
          kind: cancelled ? 'cancelled' : 'failed',
          sessionId: running.sessionId,
          blueprintId: running.blueprintId,
          revision,
          text: cancelled ? `已取消会话 ${running.sessionId}` : `设计失败：${running.sessionId}（${reason}）`,
        });
      } finally {
        try {
          await session.close?.();
        } catch {
          // 关闭失败不改变交付结论。
        }
      }
    })();
    active.set(running.sessionId, { controller, work });
    void work.finally(() => active.delete(running.sessionId));
    return view(running);
  };

  return {
    start(brief, tags) {
      const blueprint = createBlueprint(options.blueprintsRoot, brief, { mc: options.mc() });
      updateBlueprint(options.blueprintsRoot, blueprint.id, { tags: parseTags(tags) });
      const session = createBuildSession(options.sessionsRoot, { blueprintId: blueprint.id, brief });
      return run(session, brief);
    },

    send(sessionId, message) {
      const session = readBuildSession(options.sessionsRoot, sessionId);
      if (session == null) throw new Error(`没有这个会话：${sessionId}`);
      if (active.has(sessionId) || session.state === 'running') throw new Error(`会话 ${sessionId} 正在运行`);
      if (session.state === 'cancelled') throw new Error(`会话 ${sessionId} 已取消`);
      if (message.trim() === '') throw new Error('打回意见不能为空');
      return run(session, message);
    },

    accept(sessionId) {
      const session = readBuildSession(options.sessionsRoot, sessionId);
      if (session == null) throw new Error(`没有这个会话：${sessionId}`);
      if (session.state !== 'awaiting_review') return false;
      writeBuildSession(options.sessionsRoot, { ...session, state: 'accepted' });
      return true;
    },

    cancel(sessionId) {
      const current = active.get(sessionId);
      if (current == null) return false;
      current.controller.abort();
      return true;
    },

    get(sessionId) {
      return readBuildSession(options.sessionsRoot, sessionId);
    },

    list() {
      return listBuildSessions(options.sessionsRoot).map(view);
    },

    async settle() {
      while (active.size > 0) await Promise.all([...active.values()].map((item) => item.work));
    },
  };
}

function doneText(meta: BlueprintMeta, delivery: BuildDelivery, sessionId: string): string {
  const { x, y, z } = delivery.size;
  const tags = delivery.tags.length === 0 ? '' : ` · ${delivery.tags.join(',')}`;
  const reusable = delivery.reusable ? ' · 可复用' : '';
  return (
    `设计完成：会话 ${sessionId} revision ${delivery.revision} ${x}x${y}x${z} · ${delivery.blocks} 格${tags}${reusable}\n` +
    `${delivery.summary}\n` +
    `目录：build/blueprints/${meta.id}`
  );
}

/** 蓝图目录是否存在（给施工做前置检查）。 */
export function blueprintExists(root: string, id: string): boolean {
  return existsSync(join(root, id, 'plan.schem'));
}
