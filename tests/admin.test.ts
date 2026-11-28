import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdmin } from '../src/agent/admin.ts';
import type { AdminServer } from '../src/agent/admin.ts';

function tempLog(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'baseline-admin-')), 'agent.log');
  writeFileSync(file, 'line-1\nline-2\nline-3\n');
  return file;
}

async function serve(overrides: { token?: string; sent?: string[]; stopped?: string[] } = {}): Promise<{
  server: AdminServer;
  sent: string[];
  stopped: string[];
}> {
  const sent = overrides.sent ?? [];
  const stopped = overrides.stopped ?? [];
  const server = await startAdmin({
    port: 0,
    ...(overrides.token == null ? {} : { token: overrides.token }),
    username: 'Bot',
    describe: () => 'body=idle epoch=0',
    action: () => '空闲',
    vision: () => 'off',
    trace: () => ['+0.0s claim model mineBlock'],
    screenshot: () => ({ file: 'screenshot_x', takenAt: 123 }),
    logFile: tempLog(),
    message: async (text) => {
      sent.push(text);
    },
    stop: () => {
      stopped.push('stop');
      return '已打断 mineBlock';
    },
  });
  return { server, sent, stopped };
}

test('状态口：带 token 才能读，返回 describe/动作/截图/trace', async () => {
  const { server, ...rest } = await serve({ token: 'secret' });
  void rest;
  try {
    const denied = await fetch(`${server.url}/status`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${server.url}/status`, { headers: { 'x-admin-token': 'secret' } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.username, 'Bot');
    assert.equal(body.describe, 'body=idle epoch=0');
    assert.equal(body.action, '空闲');
    assert.equal(body.vision, 'off');
    assert.deepEqual(body.screenshot, { file: 'screenshot_x', takenAt: 123 });
    assert.deepEqual(body.trace, ['+0.0s claim model mineBlock']);
  } finally {
    await server.close();
  }
});

test('日志口：超过 500 行时仍返回全部行', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'baseline-admin-full-')), 'agent.log');
  writeFileSync(file, Array.from({ length: 501 }, (_, i) => `line-${i}`).join('\n'));
  const server = await startAdmin({
    port: 0,
    username: 'Bot',
    describe: () => 'body=idle',
    action: () => '空闲',
    vision: () => 'off',
    trace: () => [],
    screenshot: () => null,
    logFile: file,
    message: async () => {},
    stop: () => '停',
  });
  try {
    const response = await fetch(`${server.url}/logs?tail=9999`);
    const body = (await response.json()) as { lines: string[] };
    assert.equal(body.lines.length, 501);
    assert.equal(body.lines[0], 'line-0');
    assert.equal(body.lines.at(-1), 'line-500');
  } finally {
    await server.close();
  }
});

test('发消息：注入一条用户消息；空文本/坏 JSON 拒绝', async () => {
  const sent: string[] = [];
  const { server } = await serve({ sent });
  try {
    const ok = await fetch(`${server.url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '回来挖矿' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(sent, ['回来挖矿']);

    const empty = await fetch(`${server.url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);

    const bad = await fetch(`${server.url}/message`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('Stop：打断当前动作并返回回执', async () => {
  const stopped: string[] = [];
  const { server } = await serve({ stopped });
  try {
    const response = await fetch(`${server.url}/stop`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.result, '已打断 mineBlock');
    assert.deepEqual(stopped, ['stop']);
  } finally {
    await server.close();
  }
});

test('日志：tail 返回文件末尾若干行', async () => {
  const { server } = await serve();
  try {
    const response = await fetch(`${server.url}/logs?tail=2`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { lines: string[] };
    assert.deepEqual(body.lines, ['line-2', 'line-3']);
  } finally {
    await server.close();
  }
});

test('未知路径：404', async () => {
  const { server } = await serve();
  try {
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
  } finally {
    await server.close();
  }
});
