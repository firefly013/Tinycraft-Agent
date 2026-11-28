/**
 * 建筑子模型会话的持久元数据。
 *
 * 对话与工具状态由 pi-durable 的 SQLite 存储负责；这里只保存可查询的生命周期、
 * revision 和最近一次交付。元数据用临时文件 + rename 原子写入。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BuildSessionState = 'running' | 'awaiting_review' | 'accepted' | 'failed' | 'cancelled';

export interface BuildDelivery {
  summary: string;
  tags: string[];
  reusable: boolean;
  size: { x: number; y: number; z: number };
  blocks: number;
  materials: Record<string, number>;
  revision: number;
}

export interface BuildSessionMeta {
  sessionId: string;
  blueprintId: string;
  brief: string;
  state: BuildSessionState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastDelivery?: BuildDelivery;
  lastError?: string;
}

function sessionDir(root: string, sessionId: string): string {
  return join(root, sessionId);
}

function metaPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), 'meta.json');
}

export function buildSessionStoragePath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), 'conversation.db');
}

export function createBuildSession(root: string, input: { blueprintId: string; brief: string }): BuildSessionMeta {
  for (;;) {
    const sessionId = `session-${randomBytes(4).toString('hex')}`;
    const dir = sessionDir(root, sessionId);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta: BuildSessionMeta = {
      sessionId,
      blueprintId: input.blueprintId,
      brief: input.brief,
      state: 'running',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    writeBuildSession(root, meta);
    return meta;
  }
}

export function readBuildSession(root: string, sessionId: string): BuildSessionMeta | null {
  try {
    const meta = JSON.parse(readFileSync(metaPath(root, sessionId), 'utf8')) as BuildSessionMeta;
    return meta.sessionId === sessionId && typeof meta.blueprintId === 'string' ? meta : null;
  } catch {
    return null;
  }
}

export function writeBuildSession(root: string, meta: BuildSessionMeta): BuildSessionMeta {
  const next = { ...meta, updatedAt: new Date().toISOString() };
  const target = metaPath(root, meta.sessionId);
  mkdirSync(join(root, meta.sessionId), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, target);
  return next;
}

export function listBuildSessions(root: string): BuildSessionMeta[] {
  if (!existsSync(root)) return [];
  const found: BuildSessionMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readBuildSession(root, entry.name);
    if (meta != null) found.push(meta);
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 进程重启后，没有活动运行句柄的 running 会话只能标记为失败。 */
export function recoverInterruptedSessions(root: string, active: ReadonlySet<string>): BuildSessionMeta[] {
  const recovered: BuildSessionMeta[] = [];
  for (const meta of listBuildSessions(root)) {
    if (meta.state !== 'running' || active.has(meta.sessionId)) continue;
    recovered.push(writeBuildSession(root, { ...meta, state: 'failed', lastError: '进程重启，任务中断' }));
  }
  return recovered;
}
