/**
 * 身体：连接、事件、快照、命令分发。
 *
 * 单进程里它就是一个模块，不是子进程。只做三件事：
 *   1. 连接（mineflayer）；
 *   2. 把原生回调翻译成事件（等级由生产者定：chat L3、扣血 L2、死亡 L4）；
 *   3. 把工具名分发到原语。
 *
 * 不做任何判断：不拦截、不筛选、不替模型决定。
 */
import { createRequire } from 'node:module';
import type { ActionContext, Body } from '../shared/body.ts';
import type { Kind, Level, LogEvent } from '../core/events.ts';
import { CHAT_REPEAT_MAX, CHAT_REPEAT_WINDOW_MS, classifyChat } from '../core/chat.ts';
import { assessCombat, armorPoints, combatPower, mobPower, scanTargets } from './combat.ts';
import { isFood } from './food.ts';
import { makePrimitives } from './primitives.ts';
import { mlgWithWater, needsMlg } from './mlg.ts';
import { DROWN_TICKS, isHeadUnderwater, swimUp } from './drown.ts';
import type { MovementProfile, Primitive } from './primitives.ts';
import { renderSnapshot, snapshotFromBot } from './live_state.ts';
import { COMBAT_REFLEX, DROWN_REFLEX, EAT_REFLEX, MLG_REFLEX, PICKUP_REFLEX } from './reflexes.ts';
import {
  PICKUP_GIVE_UP_MS,
  PICKUP_HARD_MS,
  PICKUP_INTERVAL_MS,
  PICKUP_RADIUS,
  PICKUP_THREAT_RADIUS,
  PICKUP_TIMEOUT_MS,
  nearbyDrops,
  pickupDrops,
} from './pickup.ts';

// CJS 互操作：mineflayer 及其插件是 `module.exports`，命名 import 在 Node ESM
// 下运行时不可靠，统一走 createRequire。
const require = createRequire(import.meta.url);
const mineflayer = require('mineflayer') as { createBot(options: Record<string, unknown>): AnyBot };
const pathfinder = (require('mineflayer-pathfinder') as { pathfinder: (bot: AnyBot) => void }).pathfinder;
const collectBlock = (require('mineflayer-collectblock') as { plugin: (bot: AnyBot) => void }).plugin;
const customPvpModule = require('@nxg-org/mineflayer-custom-pvp') as {
  default?: (bot: AnyBot) => void;
};
const customPvp = customPvpModule.default ?? (customPvpModule as unknown as (bot: AnyBot) => void);
const Movements = (require('mineflayer-pathfinder') as { Movements: new (bot: AnyBot) => AnyMovements }).Movements;

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyBot = any;
type AnyMovements = any;

export interface BodyOptions {
  host: string;
  port: number;
  /** MC 里的用户名。 */
  username: string;
  /** Bot 目录名（bots/<botName>/）；默认跟 MC 用户名一致。配置/日志/截图都归这个目录。 */
  botName?: string;
  version?: string;
  auth?: 'offline' | 'microsoft';
  /** 模型的目标（会进每轮快照）。 */
  goal: () => string | null;
  /** 当前控制面动作（给快照的 currentAction；不提供就是 null）。 */
  action?: () => string | null;
  /** 是否开启视觉（截图）。默认关；缺依赖或拍不到图时自动退化为纯文本。 */
  vision?: boolean;
  /** 快照只渲染这些段落（给上下文小的模型做精简）；不给就全渲染。 */
  snapshotSections?: readonly string[];
  /** 自动战斗开关（KillAura 与危险提醒）；默认开。手动 attack 工具不受影响。 */
  combat?: boolean;
  /** 产出一条事件，由装配方接到 Runner.notify。 */
  onEvent: (event: LogEvent) => void;
  /** 断线后多久重连（毫秒），默认 2000。 */
  reconnectDelayMs?: number;
  /** 测试注入：造一个新 bot。默认 mineflayer.createBot。 */
  createBot?: () => AnyBot;
}

export type VisionState = 'off' | 'loading' | 'on' | 'failed';

export interface GameBody extends Body {
  /** 当前的每轮快照文本。 */
  snapshot(): string;
  /** 视觉状态：off 没开 / loading 依赖加载中 / on 可用 / failed 加载失败。 */
  visionState(): VisionState;
  /** 现拍一张（base64 JPEG）；视觉关闭/没就绪时返回 null。 */
  captureBase64(): Promise<string | null>;
  /** 最近一张截图的文件名与拍摄时间（给外部管理口看）。 */
  lastScreenshot(): { file: string; takenAt: number } | null;
  /** 手动扫一次怪（真机每秒自动扫；测试手动触发）。 */
  scan(): void;
  /** 反射执行体：抢到身体之后真正去干活；被更高优先级抢占时 signal 会 abort。 */
  reflex(name: string, signal: AbortSignal): Promise<void>;
  /** 等出生（插件与世界都就绪）：给启动流程用。 */
  whenSpawned(): Promise<void>;
  /** 原始 bot，调试用。 */
  raw(): unknown;
  close(): void;
}

/** 反射内部调原语用的上下文：没有续做、检查点为空。 */
function reflexContext(signal: AbortSignal): ActionContext {
  return { signal, resume: undefined, checkpoint: () => {} };
}

/**
 * 最大自由度的 pathfinder 配置。
 *
 * GoTo 是核心移动工具，必须能挖穿、垫柱、跳远、从竖井/地下出来；
 * 不再保留“赶路不许挖”的第二套配置——那正是地下 NoPath 的根因。
 * 自由度的硬边界是**不掉血**：下落最多 3 格（MC 从第 4 格才开始摔伤），
 * 并避开岩浆、火、仙人掌、甜浆果、岩浆块等伤害方块；不做无碰撞自由移动。
 */
function createMovements(bot: AnyBot): MovementProfile | null {
  try {
    const reach = new Movements(bot);
    reach.canDig = true;
    reach.digCost = 1; // 挖也是合法路径，不再为省工具而绕死路
    reach.placeCost = 1;
    reach.allow1by1towers = true; // 出竖井/上地表
    reach.allowParkour = true;
    reach.allowSprinting = true;
    reach.allowFreeMotion = false; // 不穿墙；否则不是寻路
    reach.maxDropDown = 3; // 3 格落差不摔伤（第 4 格起才掉血）；掉血时 goTo 还有硬停
    reach.infiniteLiquidDropdownDistance = true; // 落水不摔伤

    // 背包里常见的方块都允许当垫脚石，避免“有方块但 pathfinder 不知道”
    const scaffoldingNames = [
      'dirt', 'cobblestone', 'stone', 'netherrack', 'deepslate', 'cobbled_deepslate',
      'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'basalt', 'blackstone',
      'sand', 'gravel', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
      'crimson_planks', 'warped_planks', 'snow_block', 'clay', 'mossy_cobblestone',
    ];
    for (const name of scaffoldingNames) {
      const item = bot.registry?.itemsByName?.[name];
      if (item?.id != null) reach.scafoldingBlocks.push(item.id);
    }

    // 除了默认的岩浆/火/蛛网，再避开一切常见伤害方块。
    for (const name of [
      'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow',
      'campfire', 'soul_campfire', 'pointed_dripstone',
    ]) {
      const block = bot.registry?.blocksByName?.[name];
      if (block?.id != null) reach.blocksToAvoid.add(block.id);
    }

    // A* 默认只思考 5 秒；长距离/复杂洞穴里会假性 NoPath。给核心工具足够预算。
    if (bot.pathfinder != null) {
      bot.pathfinder.thinkTimeout = Math.max(Number(bot.pathfinder.thinkTimeout) || 0, 20_000);
      bot.pathfinder.searchRadius = -1;
    }
    bot.collectBlock.movements = reach;
    bot.pathfinder.setMovements(reach);
    return { reach };
  } catch {
    return null;
  }
}

/** 把插件、事件、快照、分发接到一个 bot 上（真机与假 bot 共用）。 */
export function wireBody(bot: AnyBot, options: BodyOptions): GameBody {
  bot.loadPlugin(pathfinder);
  // custom-pvp：同时装上 swordpvp（近战）与 bowpvp（远程）。
  try {
    bot.loadPlugin(customPvp);
  } catch (error: unknown) {
    console.warn('[pvp] custom-pvp 加载失败，攻击会退回基础近战：', error instanceof Error ? error.message : String(error));
  }
  bot.loadPlugin(collectBlock);

  const emit = (
    type: string,
    kind: Kind,
    level: Level,
    text: string,
    payload: unknown = {},
    silent = false,
  ): void => {
    options.onEvent({ type, kind, level, payload, text, ...(silent ? { silent } : {}), ts: Date.now() });
  };

  // Movements 依赖 registry 与插件注入，必须等 spawn 之后才构造；
  // 之前同步构造 100% 失败并被 catch 吞掉。
  let movements: MovementProfile | null = null;
  const initMovements = (): void => {
    if (movements != null) return;
    // 注册表都没有（假 bot / 插件未注入）就不算失败，等下次需要时再试。
    if (bot.registry == null) return;
    movements = createMovements(bot);
    if (movements == null) {
      emit('system.error', 'World', 2, '两套 Movements 初始化失败：寻路会用默认配置（可能乱挖）');
    }
  };

  let spawned = false;
  const spawnWaiters: Array<() => void> = [];
  const onSpawn = (): void => {
    spawned = true;
    initMovements();
    startVision();
    for (const resolve of spawnWaiters.splice(0)) resolve();
  };
  if (typeof bot.once === 'function') bot.once('spawn', onSpawn);
  else if (typeof bot.on === 'function') bot.on('spawn', onSpawn);

  // 视觉：**等出生后**再动态加载。相机初始化第一行就读 `bot.entity.position`，
  // 在 wireBody 里提前构造会在 spawn 前失败（曾导致截图一直没生效）。
  interface VisionLike {
    camera?: { once?: (event: string, listener: () => void) => unknown };
    lastScreenshot: unknown;
    lastFrameView: unknown;
    lastFrameColor: unknown;
    captureBase64(): Promise<string | null>;
  }
  let vision: VisionLike | null = null;
  let visionState: VisionState = options.vision === true ? 'loading' : 'off';

  function startVision(): void {
    if (options.vision !== true || visionState !== 'loading') return;
    const dir = `./bots/${options.botName ?? options.username}/screenshots`;
    void import('./vision/vision_interpreter.ts')
      .then(({ VisionInterpreter }) => {
        if (visionState !== 'loading') return;
        try {
          const interpreter = new VisionInterpreter({ bot, dir });
          const camera = interpreter.camera as {
            once?: (event: string, listener: () => void) => unknown;
          };
          vision = interpreter as unknown as VisionLike;
          camera.once?.('ready', () => {
            visionState = 'on';
            console.log(`[vision] 相机就绪：${dir}`);
          });
          camera.once?.('failed', () => {
            visionState = 'failed';
            vision = null;
            console.warn('[vision] 相机初始化失败，截图链退化为纯文本。');
          });
        } catch (error: unknown) {
          visionState = 'failed';
          console.warn('[vision] 初始化失败：', error instanceof Error ? error.message : String(error));
        }
      })
      .catch((error: unknown) => {
        visionState = 'failed';
        console.warn('[vision] 依赖不可用：', error instanceof Error ? error.message : String(error));
      });
  }

  const snapshot = (): string =>
    renderSnapshot(snapshotFromBot(bot, options.goal(), options.action?.() ?? null, vision), options.snapshotSections);
  const primitives: Record<string, Primitive> = makePrimitives(bot, { movements: () => movements });
  const runPrimitive = async (
    name: string,
    args: Record<string, unknown>,
    context: ActionContext,
  ): Promise<string> => {
    const primitive = primitives[name];
    return primitive == null ? `身体没有这个动作：${name}` : primitive(args, context);
  };

  // 聊天判级：身体只转发，classifyChat 决定 L2/L3/L4 与是否丢弃。
  const chatRepeat = new Map<string, { count: number; windowStart: number }>();
  const handleChat = (username: string, message: string, whisper: boolean): void => {
    if (username === bot.username || message === '') return;
    const key = `${username}\u0000${message}`;
    const now = Date.now();
    const seen = chatRepeat.get(key);
    let repeatCount = 0;
    if (seen != null && now - seen.windowStart < CHAT_REPEAT_WINDOW_MS) {
      repeatCount = seen.count;
      seen.count += 1;
    } else {
      chatRepeat.set(key, { count: 1, windowStart: now });
    }
    const decision = classifyChat({
      username,
      message,
      selfName: String(bot.username ?? options.username),
      whisper,
      repeatCount,
    });
    if (decision.drop === true) return;
    emit('player.chat', 'User', decision.level, decision.text, {
      username,
      message,
      whisper,
      expectReply: decision.expectReply,
    });
  };
  bot.on('chat', (username: string, message: string) => handleChat(username, message, false));
  bot.on('whisper', (username: string, message: string) => handleChat(username, message, true));
  /** 血量事件的节流：挨打时每次变化都写一条会刷屏，至少隔 2 秒。 */
  const HEALTH_EVENT_MIN_MS = 2000;
  let lastHealthEventAt = 0;
  bot.on('health', () => {
    const now = Date.now();
    if (now - lastHealthEventAt < HEALTH_EVENT_MIN_MS) return;
    lastHealthEventAt = now;
    emit('self.health', 'World', 2, `血量 ${Math.round(bot.health)}/20，饱食 ${Math.round(bot.food)}/20`);
  });
  /** 最近一次死亡的位置：重生时一起告诉模型。 */
  let lastDeath: { x: number; y: number; z: number } | null = null;
  bot.on('death', () => {
    const pos = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
    lastDeath = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    // 死亡瞬间身体不可用：打断在飞的动作/请求 + 记录，**不唤醒**。
    // 重生（下面那条 L3）才是模型能做事的时候，届时代价与坐标一起给。
    emit('self.death', 'World', 5, `你死了，掉落物在 (${lastDeath.x},${lastDeath.y},${lastDeath.z})`);
  });
  let firstSpawnSeen = false;
  bot.on('spawn', () => {
    // 首次出生不是"重生"；同一连接里第二次出生起才是。
    if (!firstSpawnSeen) {
      firstSpawnSeen = true;
      return;
    }
    const where = lastDeath == null ? '' : `，上次死亡在 (${lastDeath.x}, ${lastDeath.y}, ${lastDeath.z})，掉落物可能还在那`;
    lastDeath = null;
    emit('self.respawn', 'World', 3, `重生了${where}`);
  });
  // 被踢/出错时身体已经不可用：打断在飞的动作和请求，但**不唤醒模型**——
  // 重连成功会发 L3，那才是能做事的时候。
  bot.on('kicked', (reason: unknown) => {
    emit('system.kicked', 'World', 5, `被踢下线：${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  });
  // EventEmitter 的 error 不接会直接抛出去杀进程。只记录不唤醒：客户端错误模型无从处置。
  bot.on('error', (error: unknown) => {
    emit('system.error', 'World', 2, `客户端出错：${error instanceof Error ? error.message : String(error)}`);
  });

  const combatSelf = (): { health: number; weapon: string | null; armor: number } => {
    const armorSlots = (bot.inventory?.slots ?? []).slice(5, 9).map((item: { name?: string } | null) => item?.name ?? null);
    return {
      health: Number(bot.health ?? 20),
      weapon: (bot.heldItem?.name as string | undefined) ?? null,
      armor: armorPoints(armorSlots),
    };
  };

  // 每秒扫一次，但只有状态变化才发事件（边缘触发），不按秒刷。
  const ENGAGE_COOLDOWN_MS = 3000;
  /** 一次 KillAura 最多连续打多久：太长会把排队的模型动作也拖住。 */
  const KILLAURA_MAX_MS = 30_000;
  /** 硬上限：比循环上限多 5 秒，让还在跑的 attack/pathfinder 真的被 abort。 */
  const KILLAURA_HARD_MS = KILLAURA_MAX_MS + 5_000;
  const DROP_PICKUP_MS = 5000;
  /** 自动战斗开关：false 时 KillAura 与危险提醒都不发；手动 attack 工具仍可用。 */
  const combatEnabled = options.combat !== false;
  let lastEngageAt = 0;
  /** 反射在跑时扫描不再发 engage——否则一场仗每 3 秒往上下文写一条。 */
  let combatReflexRunning = false;
  /**
   * 危险提醒：进入危险发一次；要连续这么多次扫描都不危险才算脱离。
   *
   * 边缘触发本身是对的，但"危险"会抖（怪走两步又回来），一抖就再叫醒模型一次。
   * 同一次危险不需要第二个提醒——身体本来就没动，决定权在模型手里。
   */
  const DANGER_CLEAR_SCANS = 30;
  let dangerActive = false;
  let dangerClearScans = 0;
  /** 进食提醒边缘触发：饿着只提醒一次，不饿了再重置。 */
  let eatSignaled = false;


  const orderText = (targets: readonly ReturnType<typeof scanTargets>[number][]): string =>
    [...targets]
      .sort((a, b) => mobPower(b) - mobPower(a) || a.distance - b.distance)
      .slice(0, 4)
      .map((target) => `${target.name}(${mobPower(target)})`)
      .join('、');

  const dangerText = (
    self: ReturnType<typeof combatSelf>,
    hostiles: ReturnType<typeof scanTargets>,
    plan: ReturnType<typeof assessCombat>,
    suffix: string,
  ): string => `危险：${plan.reason}；我战力 ${combatPower(self)}，敌方 ${orderText(hostiles)}。${suffix}`;

  const signalDanger = (
    self: ReturnType<typeof combatSelf>,
    hostiles: ReturnType<typeof scanTargets>,
    plan: ReturnType<typeof assessCombat>,
    suffix = '身体没动，你定：拉开距离/吃东西/换路。',
  ): void => {
    if (!combatEnabled || dangerActive) return;
    dangerActive = true;
    dangerClearScans = 0;
    emit('danger.nearby', 'World', 3, dangerText(self, hostiles, plan, suffix), {
      action: 'flee',
      ttk: plan.ttk,
      ttd: plan.ttd,
    });
  };

  const scanCombat = (): void => {
    if (!combatEnabled || combatReflexRunning) return;
    const targets = scanTargets(bot, 16);
    const hostiles = targets.filter((target) => target.kind !== 'food');
    const self = combatSelf();
    const plan = hostiles.length > 0 ? assessCombat(self, hostiles) : null;

    // 打不过：只提醒一次（进入危险才发），身体不动。
    if (plan?.action === 'flee') {
      dangerClearScans = 0;
      signalDanger(self, hostiles, plan);
      return;
    }
    // 脱离危险要连续 30 秒（扫描 1 秒一次）都不危险才算数，避免抖动反复唤醒。
    if (dangerActive) {
      dangerClearScans += 1;
      if (dangerClearScans >= DANGER_CLEAR_SCANS) {
        dangerActive = false;
        dangerClearScans = 0;
      }
    }
    // 没有敌对目标就不接管身体：食物动物（水里的鱼、牛猪羊）由模型的 attack 工具显式去打。
    // 自动追鱼会把模型的动作挤掉十几秒，在深海迁徙时等于卡死。
    if (hostiles.length === 0) return;
    const engageable = hostiles;

    const now = Date.now();
    if (now - lastEngageAt < ENGAGE_COOLDOWN_MS) return;
    lastEngageAt = now;
    emit(
      'reflex.engage',
      'World',
      5,
      `战斗接管：${plan?.reason ?? `${engageable.length} 个近处目标，见啥打啥`}；我战力 ${combatPower(self)}，目标 ${orderText(engageable)}`,
      { reflex: COMBAT_REFLEX, action: plan?.action ?? 'engage' },
      // 静默事件：只用来触发反射，不写进模型上下文——自动打怪对模型无感。
      true,
    );
  };

  const findFood = (): { slot: number; name: string } | null => {
    const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string; slot: number }>;
    const food = items.find((item) => isFood(item.name));
    return food == null ? null : { slot: food.slot, name: food.name };
  };

  const scanEat = (): void => {
    const health = Number(bot.health ?? 20);
    const food = Number(bot.food ?? 20);
    // 自然回血要饱食 ≥18：血少且饱食不够时才吃；饿到 6 以下无条件吃。
    const hungry = (health < 14 && food < 18) || food <= 6;
    if (!hungry) {
      eatSignaled = false;
      return;
    }
    if (eatSignaled) return;
    const item = findFood();
    if (item == null) return;
    eatSignaled = true;
    emit('reflex.eat', 'World', 5, `进食反射要接管：血 ${Math.round(health)}、饱食 ${Math.round(food)}，背包有 ${item.name}`, {
      reflex: EAT_REFLEX,
      food: item.name,
    });
  };

  /* ── 全局自动拾取：身体空闲 + 附近无威胁时，自己走过去捡掉落物 ── */
  let lastPickupAt = 0;
  let pickupSuppressedUntil = 0;
  let pickupSignaled = false;

  const scanPickup = (): void => {
    const current = options.action?.() ?? null;
    // 模型/反射正在用身体时不抢；等它空下来再捡。
    if (current != null && current !== '空闲') return;
    const now = Date.now();
    if (now < pickupSuppressedUntil) return;
    if (now - lastPickupAt < PICKUP_INTERVAL_MS) return;
    const hostiles = scanTargets(bot, PICKUP_THREAT_RADIUS).filter((target) => target.kind !== 'food');
    if (hostiles.length > 0) {
      pickupSignaled = false;
      return;
    }
    const drops = nearbyDrops(bot, PICKUP_RADIUS, now);
    if (drops.length === 0) {
      pickupSignaled = false;
      return;
    }
    if (pickupSignaled) return;
    pickupSignaled = true;
    lastPickupAt = now;
    emit(
      'item.drop.nearby',
      'World',
      5,
      `自动拾取接管：附近 ${drops.length} 件掉落物，走过去捡起来`,
      { reflex: PICKUP_REFLEX, count: drops.length },
      // 静默：自动拾取对模型无感，不写上下文、不唤醒。
      true,
    );
  };

  const scan = (): void => {
    scanCombat();
    scanEat();
    scanPickup();
  };
  const scanTimer = setInterval(scan, 1000);
  (scanTimer as { unref?: () => void }).unref?.();

  /* ── 落地水：每 tick 检测"要摔死了"，触发最高优先级反射 ── */
  let mlgSignaled = false;
  const checkFalling = (): void => {
    const entity = bot.entity;
    if (entity == null) return;
    if (Number(entity.velocity?.y ?? 0) > -0.8 || entity.isInWater === true) {
      mlgSignaled = false;
      return;
    }
    if (mlgSignaled) return;
    if (!needsMlg(bot)) return;
    mlgSignaled = true;
    // L5：打断在飞的动作、不叫醒模型——摔死这件事模型来不及处理。
    emit('reflex.mlg', 'World', 5, '高空坠落：用水桶落地', { reflex: MLG_REFLEX }, true);
  };
  bot.on('physicsTick', checkFalling);

  /* ── 溺水：水下数 tick；掉血立刻触发。不用 bot.oxygenLevel（这版元数据是坏的） ── */
  let submergedTicks = 0;
  let drownSignaled = false;
  let submergedStartHealth = Number(bot.health ?? 20);
  const checkDrowning = (): void => {
    if (bot.entity == null) return;
    if (!isHeadUnderwater(bot)) {
      submergedTicks = 0;
      drownSignaled = false;
      return;
    }
    if (submergedTicks === 0) submergedStartHealth = Number(bot.health ?? 20);
    submergedTicks += 1;
    if (drownSignaled) return;
    const healthDropped = Number(bot.health ?? 20) < submergedStartHealth - 0.5;
    if (submergedTicks < DROWN_TICKS && !healthDropped) return;
    drownSignaled = true;
    emit('reflex.drown', 'World', 5, '在水下待太久：往上浮', { reflex: DROWN_REFLEX }, true);
  };
  bot.on('physicsTick', checkDrowning);

  const runKillAura = async (context: ActionContext): Promise<void> => {
    // KillAura：见啥打啥，按目标战斗力从高到低；每杀一只顺手捡掉落。
    const deadline = Date.now() + KILLAURA_MAX_MS;
    while (!context.signal.aborted && Date.now() < deadline) {
      const targets = scanTargets(bot, 16);
      if (targets.length === 0) {
        await pickupDrops(bot, context, { radius: 12, budgetMs: DROP_PICKUP_MS });
        return;
      }
      const hostiles = targets.filter((target) => target.kind !== 'food');
      if (hostiles.length > 0) {
        const plan = assessCombat(combatSelf(), hostiles);
        // 打到一半发现打不过：停手 + 提醒，不再做"逃 10 格"这种无效动作。
        if (plan.action === 'flee') {
          signalDanger(combatSelf(), hostiles, plan, '停手了，你定怎么处理。');
          return;
        }
      }
      const target = [...targets].sort((a, b) => mobPower(b) - mobPower(a) || a.distance - b.distance)[0];
      if (target == null) return;
      await runPrimitive('attack', { entityId: target.id }, context);
      await pickupDrops(bot, context, { radius: 12, budgetMs: DROP_PICKUP_MS });
    }
  };

  const reflex = async (name: string, signal: AbortSignal): Promise<void> => {
    const context = reflexContext(signal);
    if (name === DROWN_REFLEX) {
      try {
        await swimUp(bot, signal);
      } finally {
        drownSignaled = false;
        submergedTicks = 0;
      }
      return;
    }
    if (name === MLG_REFLEX) {
      try {
        await mlgWithWater(bot, signal);
      } finally {
        mlgSignaled = false;
      }
      return;
    }
    if (name === EAT_REFLEX) {
      const food = findFood();
      if (food != null) await runPrimitive('inventory', { op: 'consume', slot: food.slot }, context);
      return;
    }
    if (name === PICKUP_REFLEX) {
      // 硬上限：pathfinder 卡住时 pickupDrops 里的单次超时可能被绕过，
      // 反射本身再兜一层，别把身体锁死（真机出现过 pickup 403 秒不动）。
      const pickupAbort = new AbortController();
      const forwardAbort = (): void => pickupAbort.abort();
      if (signal.aborted) pickupAbort.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
      const hardTimer = setTimeout(() => pickupAbort.abort(), PICKUP_HARD_MS);
      (hardTimer as { unref?: () => void }).unref?.();
      let picked = 0;
      try {
        picked = await pickupDrops(bot, reflexContext(pickupAbort.signal), {
          radius: PICKUP_RADIUS,
          budgetMs: PICKUP_TIMEOUT_MS,
          maxItems: 16,
          range: 0.5,
        });
      } finally {
        clearTimeout(hardTimer);
        signal.removeEventListener('abort', forwardAbort);
      }
      pickupSignaled = false;
      lastPickupAt = Date.now();
      // 有东西捡不到/没捡完：静默一会儿，别每 1.5 秒试一次。
      if (!picked || nearbyDrops(bot, PICKUP_RADIUS).length > 0) pickupSuppressedUntil = Date.now() + PICKUP_GIVE_UP_MS;
      return;
    }
    if (name !== COMBAT_REFLEX || !combatEnabled) return;
    if (combatReflexRunning) return;
    combatReflexRunning = true;
    // 硬超时：attack 里的 pathfinder.goto 可能卡住（真机对着水里的羊卡了 113 秒），
    // 只靠循环条件兜不住，必须让底层 context.signal 真的 abort。
    const combatAbort = new AbortController();
    const forwardAbort = (): void => combatAbort.abort();
    if (signal.aborted) combatAbort.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
    const hardTimer = setTimeout(() => combatAbort.abort(), KILLAURA_HARD_MS);
    (hardTimer as { unref?: () => void }).unref?.();
    try {
      await runKillAura(reflexContext(combatAbort.signal));
    } finally {
      clearTimeout(hardTimer);
      signal.removeEventListener('abort', forwardAbort);
      combatReflexRunning = false;
    }
  };
  return {
    execute: async (name, args, context) => ({ text: await runPrimitive(name, args, context) }),
    // 有序停机：只有登记了清理钩子的动作返回收拾结果；没有就是空字符串。
    stop: async (name, context, checkpoint) => {
      const primitive = primitives[name];
      const stop = primitive?.stop;
      if (typeof stop !== 'function') return '';
      return stop.call(primitive, context, checkpoint);
    },
    snapshot,
    visionState: () => visionState,
    captureBase64: async () => (vision == null ? null : vision.captureBase64()),
    lastScreenshot: () => {
      const shot = vision?.lastScreenshot as { file?: unknown; takenAt?: unknown } | null | undefined;
      return shot != null && typeof shot.file === 'string' && typeof shot.takenAt === 'number'
        ? { file: shot.file, takenAt: shot.takenAt }
        : null;
    },
    scan,
    reflex,
    whenSpawned: () => (spawned ? Promise.resolve() : new Promise<void>((resolve) => spawnWaiters.push(resolve))),
    raw: () => bot,
    close: () => {
      clearInterval(scanTimer);
      bot.quit();
    },
  };
}

/**
 * 连上 Minecraft，断线自动重连。
 *
 * 对外始终是同一个 GameBody（Runner 拿着它），里面换 bot。
 */
export function createBody(options: BodyOptions): GameBody {
  const factory =
    options.createBot ??
    (() =>
      mineflayer.createBot({
        host: options.host,
        port: options.port,
        username: options.username,
        ...(options.version == null ? {} : { version: options.version }),
        auth: options.auth ?? 'offline',
      }));

  let inner: GameBody | null = null;
  let closed = false;
  let attempts = 0;
  /** 断线时在飞的动作必须被拒绝：否则身体锁会一直卡着，重连后干不了活。 */
  const pendingCalls = new Set<(error: Error) => void>();

  const connect = (): void => {
    const bot: AnyBot = factory();
    // 服务器挂掉/连接被拒时原始客户端会 emit 'error'；这里先挂一个兜底监听，
    // 否则 EventEmitter 会把进程直接抛死（wireBody 的日志监听之前也有窗口期）。
    bot.on('error', () => {});
    try {
      (bot as any)._client?.on?.('error', () => {});
    } catch {
      // 假 bot 没有 _client。
    }
    const body = wireBody(bot, options);
    const reconnected = attempts > 0;
    attempts += 1;
    bot.on('end', () => {
      body.close();
      inner = null;
      for (const reject of pendingCalls) reject(new Error('disconnected'));
      pendingCalls.clear();
      if (closed) return;
      // L5 = 打断在飞的动作/请求 + 只记录、**不唤醒**：身体已经不在了，
      // 叫醒模型它也只能拿到"身体正在重连"。重连成功那条 L3 再叫它。
      options.onEvent({
        type: 'system.disconnected',
        kind: 'World',
        level: 5,
        payload: {},
        text: `和服务器断开了，${((options.reconnectDelayMs ?? 2000) / 1000).toFixed(1)} 秒后重连`,
        ts: Date.now(),
      });
      setTimeout(() => {
        if (!closed) connect();
      }, options.reconnectDelayMs ?? 2000);
    });
    inner = body;
    if (reconnected) {
      // 断线期间模型可能已经闲着：重连要叫醒它一次，否则它会一直等。
      // 但必须等新生出生、插件注入完再叫——出生前发 L3 会让模型对着空世界行动。
      const announce = (): void => {
        options.onEvent({
          type: 'system.reconnected',
          kind: 'World',
          level: 3,
          payload: {},
          text: '重连回来了，看一眼四周再继续。',
          ts: Date.now(),
        });
      };
      if (typeof bot.once === 'function') bot.once('spawn', announce);
      else if (typeof bot.on === 'function') bot.on('spawn', announce);
    }
  };
  connect();

  return {
    execute: async (name, args, context) => {
      if (inner == null) return { text: '身体正在重连，等一下再试' };
      const call = inner.execute(name, args, context);
      return new Promise<{ text: string }>((resolve, reject) => {
        const rejectOnDisconnect = (error: Error): void => reject(error);
        pendingCalls.add(rejectOnDisconnect);
        call.then(
          (value) => {
            pendingCalls.delete(rejectOnDisconnect);
            resolve(value);
          },
          (error: unknown) => {
            pendingCalls.delete(rejectOnDisconnect);
            reject(error);
          },
        );
      });
    },
    snapshot: () => (inner == null ? '## 世界快照\n（身体正在重连）' : inner.snapshot()),
    visionState: () => (inner == null ? 'failed' : inner.visionState()),
    captureBase64: async () => (inner == null ? null : inner.captureBase64()),
    lastScreenshot: () => (inner == null ? null : inner.lastScreenshot()),
    scan: () => inner?.scan(),
    reflex: async (name, signal) => {
      if (inner != null) await inner.reflex(name, signal);
    },
    whenSpawned: () => (inner == null ? Promise.resolve() : inner.whenSpawned()),
    raw: () => inner?.raw() ?? null,
    close: () => {
      closed = true;
      inner?.close();
    },
  };
}
