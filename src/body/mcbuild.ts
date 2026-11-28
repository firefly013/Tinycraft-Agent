/**
 * `mc-build` CLI 适配：只做子进程调用与 JSON 解析。
 *
 * 不实现任何建筑逻辑，也不猜版本：`--mc` 永远由调用方给。mc-build 是独立项目，
 * 这里只依赖它公开的命令行契约（`build` / `emit` 的 `--json` 输出）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (argv: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

export interface McBuildOptions {
  /** mc-build 仓库根目录（里面有 src/cli.mjs）。 */
  dir: string;
  /** Node 可执行文件；默认当前进程。 */
  node?: string;
  timeoutMs?: number;
  /** 测试注入：替换子进程调用。 */
  run?: RunCli;
}

export interface BuildSummary {
  schem: string;
  size: { x: number; y: number; z: number };
  origin: { x: number; y: number; z: number };
  dataVersion: number;
  blocks: number;
  paletteSize: number;
  warnings: string[];
  selfcheck: {
    ok: boolean;
    errors: number;
    asciiPath: string | null;
    images: unknown;
  } | null;
  stderr: string;
}

export type BuildOutcome = { ok: true; summary: BuildSummary } | { ok: false; code: number; stdout: string; stderr: string };

export interface EmitBlock {
  x: number;
  y: number;
  z: number;
  state: string;
  entity?: string;
}

export interface EmitPlan {
  size: { x: number; y: number; z: number };
  origin: { x: number; y: number; z: number };
  commands: string[];
  blocks: EmitBlock[];
  stats: {
    cells: number;
    nonAir: number;
    states: number;
    fills: number;
    setblocks: number;
    entities: number;
    commands: number;
    maxCommandLength: number;
    tooLong: number;
  };
  forceload: { x1: number; z1: number; x2: number; z2: number };
  tooLong: string[];
}

export type EmitOutcome = { ok: true; plan: EmitPlan } | { ok: false; code: number; stdout: string; stderr: string };

export type McBuild = ReturnType<typeof createMcBuild>;

function spawnRun(node: string, cli: string, argv: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      node,
      [cli, ...argv],
      { cwd, timeout: timeoutMs, maxBuffer: Infinity, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error == null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

function parseJson<T>(stdout: string, label: string): T {
  const text = stdout.trim();
  if (text === '') throw new Error(`${label} 没有输出 JSON`);
  try {
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    throw new Error(`${label} 的输出不是 JSON（${error instanceof Error ? error.message : String(error)}）：${text}`);
  }
}

export function createMcBuild(options: McBuildOptions) {
  const dir = options.dir;
  const cli = join(dir, 'src', 'cli.mjs');
  const node = options.node ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const run: RunCli =
    options.run ??
    ((argv, cwd, timeout) => {
      if (!existsSync(cli)) throw new Error(`mc-build 不存在：${cli}（检查 MC_BUILD_DIR）`);
      return spawnRun(node, cli, argv, cwd, timeout);
    });

  return {
    dir,

    /** 通用入口：只负责起子进程，不认识参数。给架构师直接驱动 mc-build 用。 */
    run(argv: readonly string[], cwd: string): Promise<RunResult> {
      return run([...argv], cwd, timeoutMs);
    },

    /**
     * 编译脚本并自检。
     *
     * `--mc` 由调用方给；返回的文件路径是绝对路径（mc-build 把 `-o` 解析成绝对路径）。
     */
    async build(script: string, out: string, opts: { mc: string; cwd: string }): Promise<BuildOutcome> {
      const result = await run(['build', script, '-o', out, '--mc', opts.mc, '--json'], opts.cwd, timeoutMs);
      if (result.code !== 0) {
        return { ok: false, code: result.code, stdout: result.stdout, stderr: result.stderr };
      }
      const summary = parseJson<{
        out: string;
        size: { x: number; y: number; z: number };
        origin: { x: number; y: number; z: number };
        dataVersion: number;
        nonAir: number;
        paletteSize: number;
        warnings: string[];
        selfcheck: { ok: boolean; errors: number; asciiPath: string | null; images: unknown } | null;
      }>(result.stdout, 'mc-build build');
      return {
        ok: true,
        summary: {
          schem: summary.out,
          size: summary.size,
          origin: summary.origin,
          dataVersion: summary.dataVersion,
          blocks: summary.nonAir,
          paletteSize: summary.paletteSize,
          warnings: summary.warnings ?? [],
          selfcheck: summary.selfcheck,
          stderr: result.stderr,
        },
      };
    },

    /** `.schem` → 命令 + 方块清单。`tooLong` 非空时 `ok` 仍为 true，由调用方决定。 */
    async emit(
      schem: string,
      origin: { x: number; y: number; z: number },
      opts: { cwd: string; clearAir?: boolean },
    ): Promise<EmitOutcome> {
      const argv = ['emit', schem, '--origin', `${origin.x},${origin.y},${origin.z}`, '--json'];
      if (opts.clearAir === true) argv.push('--clear-air');
      const result = await run(argv, opts.cwd, timeoutMs);
      if (result.stdout.trim() === '') {
        return { ok: false, code: result.code, stdout: result.stdout, stderr: result.stderr };
      }
      const plan = parseJson<EmitPlan>(result.stdout, 'mc-build emit');
      return { ok: true, plan };
    },
  };
}
