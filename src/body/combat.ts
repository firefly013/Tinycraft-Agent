/**
 * 战力评估：纯函数。把"我"和"眼前的怪"折算成两条时间线，给出 打 / 跑 / 不管。
 *
 *   ttk  我杀光它们要几秒 = Σ敌血 / 我的 DPS
 *   ttd  它们杀我要几秒 = 我的有效血 / 它们的 DPS
 *
 * 判决是 `ttd > margin × ttk`。它等价于比较"战力值"，但拆开之后每一项都有
 * 物理意义，回执里能逐项写清楚。
 *
 * 边界：苦力怕（爆炸是二值事件）、不认识的怪、血太少 —— 一律跑，不赌。
 */

export interface MobProfile {
  hp: number;
  /** 单次伤害。 */
  damage: number;
  /** 两次攻击间隔（秒）。 */
  intervalSec: number;
  /** 爆炸是二值事件，不适用时间线模型。 */
  explosive?: boolean;
  /** 杀了能拿食物（牛羊猪鸡兔等）。 */
  food?: boolean;
}

/** 兜底表（普通难度）。只用于"眼前是什么、大概多强"的估算，不追求逐版本精确。 */
export const MOB_PROFILES: Readonly<Record<string, MobProfile>> = Object.freeze({
  // ── 主世界怪物 ──
  zombie: { hp: 20, damage: 3, intervalSec: 1.0 },
  husk: { hp: 20, damage: 3, intervalSec: 1.0 },
  drowned: { hp: 20, damage: 3, intervalSec: 1.0 },
  zombie_villager: { hp: 20, damage: 3, intervalSec: 1.0 },
  skeleton: { hp: 20, damage: 3, intervalSec: 2.0 },
  stray: { hp: 20, damage: 3, intervalSec: 2.0 },
  bogged: { hp: 16, damage: 2, intervalSec: 2.0 },
  wither_skeleton: { hp: 20, damage: 4, intervalSec: 1.0 },
  spider: { hp: 16, damage: 2, intervalSec: 1.0 },
  cave_spider: { hp: 12, damage: 2, intervalSec: 1.0 },
  silverfish: { hp: 8, damage: 1, intervalSec: 1.0 },
  endermite: { hp: 8, damage: 2, intervalSec: 1.0 },
  slime: { hp: 16, damage: 2, intervalSec: 1.0 },
  magma_cube: { hp: 16, damage: 4, intervalSec: 1.0 },
  creeper: { hp: 20, damage: 0, intervalSec: 0, explosive: true },
  witch: { hp: 26, damage: 0, intervalSec: 0 },
  phantom: { hp: 20, damage: 3, intervalSec: 2.0 },
  guardian: { hp: 30, damage: 4, intervalSec: 2.0 },
  elder_guardian: { hp: 80, damage: 6, intervalSec: 2.0 },
  shulker: { hp: 30, damage: 4, intervalSec: 2.0 },
  pillager: { hp: 24, damage: 3, intervalSec: 2.0 },
  vindicator: { hp: 24, damage: 5, intervalSec: 1.0 },
  evoker: { hp: 24, damage: 5, intervalSec: 2.0 },
  illusioner: { hp: 32, damage: 3, intervalSec: 2.0 },
  vex: { hp: 14, damage: 4, intervalSec: 1.0 },
  ravager: { hp: 100, damage: 12, intervalSec: 2.0 },
  warden: { hp: 500, damage: 30, intervalSec: 2.0 },
  // ── 下界 ──
  blaze: { hp: 20, damage: 6, intervalSec: 1.0 },
  ghast: { hp: 10, damage: 17, intervalSec: 3.0 },
  hoglin: { hp: 40, damage: 6, intervalSec: 1.0 },
  zoglin: { hp: 40, damage: 6, intervalSec: 1.0 },
  piglin_brute: { hp: 50, damage: 8, intervalSec: 1.0 },
  // ── Boss ──
  wither: { hp: 300, damage: 8, intervalSec: 2.0 },
  ender_dragon: { hp: 200, damage: 12, intervalSec: 2.0 },
  // ── 食物动物：不还手，杀了掉肉 ──
  cow: { hp: 10, damage: 0, intervalSec: 0, food: true },
  mooshroom: { hp: 10, damage: 0, intervalSec: 0, food: true },
  pig: { hp: 10, damage: 0, intervalSec: 0, food: true },
  sheep: { hp: 8, damage: 0, intervalSec: 0, food: true },
  chicken: { hp: 4, damage: 0, intervalSec: 0, food: true },
  rabbit: { hp: 3, damage: 0, intervalSec: 0, food: true },
  cod: { hp: 3, damage: 0, intervalSec: 0, food: true },
  salmon: { hp: 3, damage: 0, intervalSec: 0, food: true },
});

/** 不认识的怪：按注册表 category 兜底。只兜 Hostile——不认识的 Passive 不乱打。 */
const UNKNOWN_HOSTILE: MobProfile = { hp: 20, damage: 3, intervalSec: 1.0 };

/** 剑的伤害（未附魔）。手上不是剑时按 4 算。 */
const WEAPON_DAMAGE: Readonly<Record<string, number>> = {
  wooden_sword: 4,
  stone_sword: 5,
  iron_sword: 6,
  golden_sword: 4,
  diamond_sword: 7,
  netherite_sword: 8,
};

/** 各部位护甲点数（与原版一致）。身上没有就按 0。 */
const ARMOR_POINTS: Readonly<Record<string, number>> = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
  turtle_helmet: 2,
};

/** 四个护甲槽（头/胸/腿/脚）→ 护甲点数。 */
export function armorPoints(slots: readonly (string | null | undefined)[]): number {
  let total = 0;
  for (const name of slots) {
    if (name == null) continue;
    total += ARMOR_POINTS[name.replace(/^minecraft:/, '')] ?? 0;
  }
  return total;
}

/** 打到多稳才上：ttd 至少是 ttk 的 1.5 倍。 */
const SAFETY_MARGIN = 1.5;

export interface CombatSelf {
  health: number;
  /** 护甲点数（0–20）。每点减 4% 伤害，最多 80%。 */
  armor?: number;
  /** 手上武器名字（用来查伤害）。 */
  weapon?: string | null;
}

export interface MobSighting {
  id: number;
  name: string;
  distance: number;
  position: { x: number; y: number; z: number };
  hp: number;
  damage: number;
  intervalSec: number;
  explosive: boolean;
  /** hostile = 会还手；food = 食物动物（不还手）。缺省按 hostile 处理。 */
  kind?: 'hostile' | 'food';
}

/** 从 bot 的实体表里扫生物所需的最小接口（假 bot 也能用）。 */
export interface ScanBotLike {
  entity?: { id?: number; position?: { x: number; y: number; z: number } };
  entities?: Record<string, { id: number; name?: string; position?: { x: number; y: number; z: number } }>;
  /** mineflayer 的注册表：不认识的生物按 category 兜底（只兜 Hostile）。 */
  registry?: { entitiesByName?: Record<string, { category?: unknown } | undefined> };
}

/** 从 bot 的实体表里扫出所有认识的生物（怪物 + 食物动物；中立怪跳过）。 */
export function scanTargets(bot: ScanBotLike, radius = 16): MobSighting[] {
  const self = bot.entity?.position;
  const selfId = bot.entity?.id;
  if (self == null) return [];
  const out: MobSighting[] = [];
  for (const raw of Object.values(bot.entities ?? {})) {
    if (raw == null || raw.id === selfId || raw.name == null || raw.position == null) continue;
    const category = bot.registry?.entitiesByName?.[raw.name]?.category;
    const isUnknownHostile = typeof category === 'string' && category.toLowerCase() === 'hostile';
    const profile = MOB_PROFILES[raw.name] ?? (isUnknownHostile ? UNKNOWN_HOSTILE : null);
    if (profile == null) continue;
    const distance = Math.hypot(raw.position.x - self.x, raw.position.y - self.y, raw.position.z - self.z);
    if (distance > radius) continue;
    out.push({
      id: raw.id,
      name: raw.name,
      distance,
      position: raw.position,
      hp: profile.hp,
      damage: profile.damage,
      intervalSec: profile.intervalSec,
      explosive: profile.explosive === true,
      kind: profile.food === true ? 'food' : 'hostile',
    });
  }
  return out.sort((a, b) => a.distance - b.distance);
}


export interface CombatPlan {
  action: 'engage' | 'flee' | 'ignore';
  /** 我杀光它们要几秒。 */
  ttk: number;
  /** 它们杀我要几秒。 */
  ttd: number;
  reason: string;
}

export function weaponDamage(weapon: string | null | undefined): number {
  if (weapon == null) return 4;
  const key = weapon.replace(/^minecraft:/, '');
  return WEAPON_DAMAGE[key] ?? 4;
}

/**
 * 战斗力：一个能横向比较的单值（越大越强）。
 *
 *   power = 每秒伤害 × 有效血 / 10
 *
 * 有效血 = 血量 / (1 - 护甲减伤)。空手 20 血 ≈ 8；铁剑 + 20 血 ≈ 12；
 * 铁剑 + 铁甲 + 20 血 ≈ 17。它不替代 ttk/ttd（那个才决定打不打），
 * 只用于回执里给模型一个"我现在大概多能打"的直观数。
 */
export function combatPower(self: CombatSelf): number {
  const dps = weaponDamage(self.weapon);
  const reduction = Math.min(0.8, Math.max(0, self.armor ?? 0) * 0.04);
  const effectiveHp = self.health / (1 - reduction);
  return Math.round((dps * effectiveHp) / 10);
}

/**
 * 单只目标的战斗力：每秒伤害 × 血量 / 10，用来排"见啥打啥"的先后顺序。
 * 食物动物伤害为 0 → 排在最后；苦力怕的威胁是二值的，单独排最前。
 */
export function mobProfilePower(profile: MobProfile): number {
  if (profile.explosive === true) return 100;
  const dps = profile.intervalSec <= 0 ? 0 : profile.damage / profile.intervalSec;
  return Math.round((dps * profile.hp) / 10 * 10) / 10;
}

export function mobPower(mob: MobSighting): number {
  return mobProfilePower({
    hp: mob.hp,
    damage: mob.damage,
    intervalSec: mob.intervalSec,
    explosive: mob.explosive,
  });
}

/**
 * `mobs` 是 `scanTargets` 的结果（按 kind 区分会还手的怪与食物动物）。
 * 只有食物动物时直接判"打"：它们不还手，打猎不需要战力比较。
 */
export function assessCombat(self: CombatSelf, mobs: readonly MobSighting[]): CombatPlan {
  const hostiles = mobs.filter((mob) => mob.kind !== 'food');
  if (hostiles.length === 0) {
    if (mobs.length === 0) {
      return { action: 'ignore', ttk: 0, ttd: Number.POSITIVE_INFINITY, reason: '眼前没有会主动打我的怪' };
    }
    const ttk = mobs.reduce((sum, mob) => sum + mob.hp, 0) / weaponDamage(self.weapon);
    return { action: 'engage', ttk, ttd: Number.POSITIVE_INFINITY, reason: `${mobs.length} 只食物动物，不还手` };
  }

  if (hostiles.some((mob) => mob.explosive)) {
    return { action: 'flee', ttk: 0, ttd: 0, reason: '苦力怕会炸，不能拼' };
  }
  if (self.health <= 6) {
    return { action: 'flee', ttk: 0, ttd: 0, reason: `自己只有 ${Math.round(self.health)} 血，先撤` };
  }

  const myDps = weaponDamage(self.weapon);
  const ttk = hostiles.reduce((sum, mob) => sum + mob.hp, 0) / myDps;
  const incomingDps = hostiles.reduce((sum, mob) => sum + (mob.intervalSec <= 0 ? 0 : mob.damage / mob.intervalSec), 0);
  // 原版护甲：每点减 4% 伤害，最多减 80%（满甲有效血 = 5 倍）。
  const reduction = Math.min(0.8, Math.max(0, self.armor ?? 0) * 0.04);
  const effectiveHp = self.health / (1 - reduction);
  const ttd = incomingDps <= 0 ? Number.POSITIVE_INFINITY : effectiveHp / incomingDps;

  const round = (value: number): number => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);
  const describe = `${hostiles.length} 只怪：我杀光要 ${round(ttk)}s，它们杀我要 ${round(ttd)}s`;

  if (ttd > ttk * SAFETY_MARGIN) return { action: 'engage', ttk, ttd, reason: describe };
  return { action: 'flee', ttk, ttd, reason: `${describe}，不划算` };
}
