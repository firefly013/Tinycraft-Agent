import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  applyDotEnv,
  resolveThinkingLevel,
  loadBot,
  loadDotEnv,
  loadProvider,
  openProvider,
  readBotText,
  resolveInitMessage,
  resolveSystemPrompt,
} from '../src/agent/config.ts';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'baseline-config-'));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('供应商配置：每个供应商一个文件，按模块/工厂动态加载', async () => {
  const root = makeRoot();
  try {
    write(
      join(root, 'providers', 'faux.json'),
      JSON.stringify({
        id: 'faux',
        module: '@earendil-works/pi-ai/providers/faux',
        factory: 'fauxProvider',
        defaultModel: 'faux-model',
      }),
    );
    const config = loadProvider(root, 'faux');
    assert.equal(config.defaultModel, 'faux-model');
    const opened = await openProvider(config, 'faux');
    assert.equal(opened.providerId, 'faux');
    assert.ok(opened.models != null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('供应商配置：缺文件、缺工厂、id 不符都明确报错', async () => {
  const root = makeRoot();
  try {
    assert.throws(() => loadProvider(root, 'nope'), /不存在/);

    write(join(root, 'providers', 'bad.json'), JSON.stringify({ module: 'node:fs', factory: 'nope' }));
    await assert.rejects(openProvider(loadProvider(root, 'bad'), 'bad'), /没有导出工厂/);

    write(
      join(root, 'providers', 'faux.json'),
      JSON.stringify({ module: '@earendil-works/pi-ai/providers/faux', factory: 'fauxProvider' }),
    );
    await assert.rejects(openProvider(loadProvider(root, 'faux'), 'other'), /id 是 faux/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bot 配置：目录是身份，引用供应商模型，提示词/人设/出生消息按文件解析', () => {
  const root = makeRoot();
  try {
    write(
      join(root, 'bots', 'alice', 'bot.json'),
      JSON.stringify({
        provider: 'deepseek',
        model: 'deepseek-flash',
        systemPromptFile: 'prompt.md',
        initMessageFile: 'init.md',
        personaFile: 'persona.md',
        mc: { port: 25565, username: 'Alice' },
        thinking: 'off',
        vision: true,
      }),
    );
    write(join(root, 'bots', 'alice', 'prompt.md'), '你是 Alice');
    write(join(root, 'bots', 'alice', 'init.md'), '起床');
    write(join(root, 'bots', 'alice', 'persona.md'), '一只猫');

    const bot = loadBot(root, 'alice');
    assert.equal(bot.dir, 'bots/alice');
    assert.equal(bot.config.provider, 'deepseek');
    assert.equal(bot.config.model, 'deepseek-flash');
    assert.equal(bot.config.mc?.port, 25565);
    assert.equal(bot.config.thinking, 'off');
    assert.equal(readBotText(bot, 'prompt.md', root), '你是 Alice');

    // 环境变量最优先；没有环境变量就用文件；人设永远追加在最后。
    assert.equal(resolveSystemPrompt(bot, root, '默认', '环境提示'), '环境提示\n\n## 人设\n一只猫');
    assert.equal(resolveSystemPrompt(bot, root, '默认', undefined), '你是 Alice\n\n## 人设\n一只猫');
    assert.equal(resolveInitMessage(bot, root, '默认', undefined), '起床');
    assert.equal(resolveInitMessage(bot, root, '默认', '环境消息'), '环境消息');

    // 显式配置了文件但文件不存在：报错，不静默。
    assert.throws(() => readBotText(bot, 'missing.md', root), /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有 bot.json：空配置，全部走默认/环境变量', () => {
  const root = makeRoot();
  try {
    const bot = loadBot(root, 'nobody');
    assert.deepEqual(bot.config, {});
    assert.equal(resolveSystemPrompt(bot, root, '默认', undefined), '默认');
    assert.equal(resolveInitMessage(bot, root, '默认', undefined), '默认');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.env：解析 KEY=VALUE，环境变量优先不被覆盖', () => {
  const root = makeRoot();
  try {
    write(
      join(root, '.env'),
      ['# comment', 'BASELINE_ENV_TEST=from-file', 'QUOTED="hello world"', "SINGLE='x'", ''].join('\n'),
    );
    const vars = loadDotEnv(join(root, '.env'));
    assert.equal(vars.BASELINE_ENV_TEST, 'from-file');
    assert.equal(vars.QUOTED, 'hello world');
    assert.equal(vars.SINGLE, 'x');

    delete process.env.BASELINE_ENV_TEST;
    applyDotEnv(root);
    assert.equal(process.env.BASELINE_ENV_TEST, 'from-file');
    process.env.BASELINE_ENV_TEST = 'from-env';
    applyDotEnv(root);
    assert.equal(process.env.BASELINE_ENV_TEST, 'from-env', '环境变量优先');
    delete process.env.BASELINE_ENV_TEST;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('思考等级：环境变量优先，默认 off，非法值报错', () => {
  assert.equal(resolveThinkingLevel({}, undefined), 'off');
  assert.equal(resolveThinkingLevel({ thinking: 'high' }, undefined), 'high');
  assert.equal(resolveThinkingLevel({ thinking: 'high' }, 'low'), 'low', '环境变量优先');
  assert.throws(() => resolveThinkingLevel({}, 'turbo'), /无效的 thinking/);
});
