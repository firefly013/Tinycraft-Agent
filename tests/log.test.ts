import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { Message } from '@earendil-works/pi-ai';
import { startBaseline } from '../src/agent/bot.ts';
import { createLogger, createRequestLog, startMemorySampler } from '../src/agent/log.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'baseline-log-'));
}

test('结构化日志：一行一个 JSON，带时间/级别/模块', () => {
  const logger = createLogger({ dir: tempDir(), now: () => new Date('2026-01-02T03:04:05Z') });
  logger.with('provider').info({ model: 'x', tokens: 3 });

  const lines = readFileSync(logger.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record.level, 'info');
  assert.equal(record.mod, 'provider');
  assert.equal(record.model, 'x');
  assert.equal(record.tokens, 3);
  assert.equal(record.ts, '2026-01-02T03:04:05.000Z');
});

test('结构化日志：超长字段截断，行仍然可解析', () => {
  const logger = createLogger({ dir: tempDir() });
  logger.info({ big: 'x'.repeat(5_000) });

  const record = JSON.parse(readFileSync(logger.file, 'utf8').trim()) as Record<string, string>;
  assert.ok(record.big != null);
  assert.ok(record.big.length < 5_000);
  assert.match(record.big, /…\[\+3000\]/);
});

test('请求日志：同一页每次覆盖，round 累加；压缩翻页换新文件', () => {
  const log = createRequestLog({
    dir: tempDir(),
    tools: () => ['a', 'b'],
    now: () => new Date('2026-01-02T03:04:05Z'),
  });
  const messages = [{ role: 'user', content: 'hi', timestamp: 0 } satisfies Message];

  log.writeRequest(messages);
  const first = readFileSync(log.file, 'utf8');
  assert.match(first, /# round 1/);
  assert.match(first, /# page 1/);
  assert.match(first, /# tools a, b/);
  assert.match(first, /\[user\] hi/);

  log.writeRequest(messages);
  const overwritten = readFileSync(log.file, 'utf8');
  assert.match(overwritten, /# round 2/);
  assert.equal(overwritten.includes('# round 1'), false, '同一页应被覆盖，不是追加');

  log.nextPage();
  assert.equal(log.page, 2);
  assert.ok(log.file.endsWith('request-002.log'));
  log.writeRequest(messages);
  assert.match(readFileSync(log.file, 'utf8'), /# round 1/);
});

test('请求日志：system 的 sections 也要落盘（模型实际看到的提示词）', () => {
  const log = createRequestLog({ dir: tempDir(), tools: () => [] });
  log.writeRequest([
    { role: 'system', content: 'base', sections: { system: '你是一个机器人' }, timestamp: 0 } as unknown as Message,
  ]);

  const text = readFileSync(log.file, 'utf8');
  assert.match(text, /\[section:system\]/);
  assert.match(text, /你是一个机器人/);
});

test('端到端：一次请求写出请求快照与 provider 终态日志', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const dir = tempDir();
  const logger = createLogger({ dir });

  const baseline = await startBaseline({
    models,
    model: { provider: 'faux', modelId: faux.getModel().id },
    storage: new MemoryStorage(),
    body: { snapshot: () => '## 世界快照', execute: async () => ({ text: 'ok' }) },
    systemPrompt: '你是机器人。',
    goal: { value: null },
    say: () => {},
    logger,
  });

  faux.setResponses([fauxAssistantMessage('好')]);
  await baseline.kick('你好');
  await baseline.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await baseline.close();

  const request = readFileSync(join(dir, 'request-001.log'), 'utf8');
  assert.match(request, /# page 1/);
  assert.match(request, /\[user\] 你好/);
  assert.match(request, /\[system\]/);

  const agent = readFileSync(logger.file, 'utf8');
  assert.match(agent, /"mod":"provider"/);
  assert.match(agent, /"stopReason":"stop"/);
});

test('内存采样：定时落一行 memory，停止后不再写', async () => {
  const logger = createLogger({ dir: tempDir() });
  const stop = startMemorySampler(logger, 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();

  const records = readFileSync(logger.file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const memory = records.filter((record) => record.mod === 'memory');
  assert.ok(memory.length > 0);
  assert.equal(typeof memory[0]?.rssMb, 'number');
});
