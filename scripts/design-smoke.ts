#!/usr/bin/env node
/**
 * 架构师端到端冒烟：真实模型 + 真实 mc-build，不连 Minecraft。
 *
 * 环境变量：
 *   SMOKE_PROVIDER=opencode-go   providers/<id>.json
 *   SMOKE_MODEL=<model id>       默认用 provider 的 defaultModel
 *   SMOKE_BRIEF=...              设计需求或打回意见
 *   SMOKE_SESSION_ID=...         可选；恢复同一会话继续设计
 *   MC_BUILD_DIR=../mc-build
 *   BOT=BaselineBot
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyDotEnv, loadProvider, openProvider } from '../src/agent/config.ts';
import { createArchitecture } from '../src/agent/architect.ts';
import type { DesignEvent } from '../src/agent/architect.ts';
import { createDesignSession } from '../src/agent/design_session.ts';
import { buildSessionStoragePath } from '../src/agent/build_sessions.ts';
import { readBlueprint } from '../src/agent/blueprints.ts';
import { createMcBuild } from '../src/body/mcbuild.ts';

const env = process.env;
const root = resolve('bots', env.BOT ?? 'BaselineBot');
applyDotEnv(root);
applyDotEnv(process.cwd());

const providerId = env.SMOKE_PROVIDER ?? 'opencode-go';
const providerConfig = loadProvider(process.cwd(), providerId);
const modelId = env.SMOKE_MODEL ?? providerConfig.defaultModel;
if (modelId == null || modelId === '') throw new Error(`provider ${providerId} 没有 defaultModel`);
const { models } = await openProvider(providerConfig, providerId, process.cwd());

const mcBuildDir = resolve(env.MC_BUILD_DIR ?? resolve(process.cwd(), '..', 'mc-build'));
const mcBuild = createMcBuild({ dir: mcBuildDir });
const mc = env.MC_VERSION ?? '1.21.4';
const blueprintsRoot = resolve(root, 'build', 'blueprints');
const sessionsRoot = resolve(root, 'build', 'sessions');
mkdirSync(blueprintsRoot, { recursive: true });
mkdirSync(sessionsRoot, { recursive: true });

const events: DesignEvent[] = [];
const architecture = createArchitecture({
  blueprintsRoot,
  sessionsRoot,
  mc: () => mc,
  createSession: (sessionId) =>
    createDesignSession({
      models,
      model: { provider: providerId, modelId },
      blueprintsRoot,
      storagePath: buildSessionStoragePath(sessionsRoot, sessionId),
      sessionId,
      workspaceRoot: resolve(root, 'build'),
      mcBuild,
      mc: () => mc,
    }),
  onEvent: (event) => {
    events.push(event);
    console.log(`[${event.kind}] ${event.text}`);
  },
});

const brief = env.SMOKE_BRIEF ?? '一座 3x3 的石头小屋，墙高 3，开一扇门和两个窗，屋顶用木台阶';
const task = env.SMOKE_SESSION_ID == null
  ? architecture.start(brief, ['smoke'])
  : architecture.send(env.SMOKE_SESSION_ID, brief);
console.log(`设计${env.SMOKE_SESSION_ID == null ? '开始' : '继续'}：${task.sessionId} / ${task.blueprintId}（${brief}）`);

const timeout = new Promise<void>((resolve) => setTimeout(resolve, Number(env.SMOKE_TIMEOUT_MS ?? 600_000)));
await Promise.race([architecture.settle(), timeout]);

const meta = readBlueprint(blueprintsRoot, task.blueprintId);
if (events.length === 0) {
  console.error('SMOKE FAIL：设计任务没有结束（超时或卡住）');
  process.exit(1);
}
if (events[0].kind !== 'done' || meta == null || meta.blocks === 0) {
  console.error(`SMOKE FAIL：${events[0].kind}`);
  process.exit(1);
}
console.log(
  `SMOKE OK：${meta.id} ${meta.size.x}x${meta.size.y}x${meta.size.z} · ${meta.blocks} 格 · ` +
    `tags=${meta.tags.join(',') || '-'} · reusable=${meta.reusable}`,
);
process.exit(0);
