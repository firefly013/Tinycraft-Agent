import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSessionStoragePath,
  createBuildSession,
  listBuildSessions,
  readBuildSession,
  recoverInterruptedSessions,
  writeBuildSession,
} from '../src/agent/build_sessions.ts';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'tc-build-sessions-'));
}

test('会话元数据：创建、原子更新、按 ID 读取与列出', () => {
  const dir = root();
  const session = createBuildSession(dir, { blueprintId: 'tower-abcd', brief: '一座塔' });
  assert.match(session.sessionId, /^session-[0-9a-f]{8}$/);
  assert.equal(session.blueprintId, 'tower-abcd');
  assert.equal(session.state, 'running');
  assert.equal(session.revision, 0);
  assert.equal(buildSessionStoragePath(dir, session.sessionId), join(dir, session.sessionId, 'conversation.db'));
  assert.ok(existsSync(join(dir, session.sessionId, 'meta.json')));

  writeBuildSession(dir, {
    ...session,
    state: 'awaiting_review',
    revision: 1,
    lastDelivery: {
      summary: '完成',
      tags: ['tower'],
      reusable: true,
      size: { x: 5, y: 9, z: 5 },
      blocks: 120,
      materials: { stone: 120 },
      revision: 1,
    },
  });
  const loaded = readBuildSession(dir, session.sessionId);
  assert.equal(loaded?.state, 'awaiting_review');
  assert.equal(loaded?.revision, 1);
  assert.equal(loaded?.lastDelivery?.summary, '完成');
  assert.deepEqual(listBuildSessions(dir).map((item) => item.sessionId), [session.sessionId]);
  rmSync(dir, { recursive: true, force: true });
});

test('进程重启恢复：没有活动任务的 running 会话变为 failed', () => {
  const dir = root();
  const session = createBuildSession(dir, { blueprintId: 'tower-abcd', brief: '一座塔' });
  const recovered = recoverInterruptedSessions(dir, new Set());
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'failed');
  assert.match(recovered[0].lastError ?? '', /进程重启/);
  assert.equal(readBuildSession(dir, session.sessionId)?.state, 'failed');
  rmSync(dir, { recursive: true, force: true });
});
