/*
 * Live State 的**共享契约**：数据结构 + 渲染纯函数。
 *
 * 采样在身体侧（`body/live_state.ts`：读 mineflayer bot，产出一份 LiveState），
 * 渲染在大脑侧（把快照拼成给模型看的文本块）。两边只共用这一份类型和渲染器——
 * 文本必须逐字一致，所以渲染器不能各写一份。
 *
 * 本文件不许 import 身体或大脑的任何实现。
 */
export interface ScreenshotRef {
  file: string;
  takenAt: number;
}

export interface LiveBody {
  health: number | null;
  food: number | null;
  saturation: number | null;
  oxygen: number | null;
  xpLevel: number | null;
  xpProgress: number | null;
  pose: string | null;
  onGround: boolean | null;
  /** 药水效果，形如 `strength II 45s`；空数组=身上没有任何效果。 */
  effects: string[];
}

export interface LiveHeld {
  /** **背包数据是否已经同步过**：false = 刚重连、还没收到背包包，空/空手都不可信。 */
  synced?: boolean;
  mainHand: string | null;
  offHand: string | null;
  armor: string[];
  /** 主手剩余耐久比例 0~1；空手或无耐久物品为 null。 */
  mainHandDurability: number | null;
  /**
   * 主手耐久的**原始读数**（已用 NBT damage / 上限），用来诊断也用来显示。
   *
   * 模型报过"耐久剩余 0%"但工具明显没坏（挖了 36 格），而 `prismarine-item` 的
   * `durabilityUsed` 是 getter，读不到 NBT 时会退化成 0 或 max，容易把"读不到"
   * 说成"快报废"。绝对数摆出来（`耐久 37/251`）比百分比更抗歧义：模型不用自己
   * 乘上限就知道还能挖几格；上限读不到时也能一眼看出是读数问题。
   */
  mainHandDurabilityUsed: number | null;
  mainHandDurabilityMax: number | null;
  /**
   * 读到过一个**无效**的耐久上限（真机 `stone_pickaxe max=1`）。
   *
   * 只用于诚实标注：渲染时绝不把那个假数字印出来（模型会把 `max=1` 当成
   * "总耐久 1 次"），但也不能假装什么都没读到——所以要能说
   * "上限读不到（读到的值无效，已忽略）——算不出剩余"。
   */
  mainHandDurabilityMaxInvalid?: boolean;
}

export interface LiveBackpack {
  /** 同 `LiveHeld.synced`：false = 还没同步，禁止把 items=[] 读成"背包空了"。 */
  synced?: boolean;
  freeSlots: number | null;
  items: string[];
}

export interface LivePosition {
  x: number | null;
  y: number | null;
  z: number | null;
  yaw: number | null;
  pitch: number | null;
  dimension: string | null;
  biome: string | null;
  /** 水平速度（格/秒，粗估）；站着不动是 0。 */
  speed: number | null;
}

export interface LiveEnvironment {
  timeOfDay: number | null;
  weather: 'Clear' | 'Rain' | 'Thunderstorm' | 'Unknown';
  light: number | null;
  /** 客户端光照读数是快照，可能过期——可信度必须诚实标注。 */
  lightConfidence: 'high' | 'unknown';
  /** 游戏内第几天（time.day）。 */
  day: number | null;
}

export interface LiveEntity {
  id: number;
  name: string;
  kind: string | null;
  distance: number;
  x: number;
  y: number;
  z: number;
  health: number | null;
  /**
   * 这只敌对生物的战斗力（每秒伤害 × 血量 / 10；苦力怕固定 100）。
   * 食物动物、中立怪、掉落物没有威胁值 → undefined（不渲染）。
   */
  power?: number;
  /**
   * 实体的一句话附加信息（村民职业 `Farmer L2`、婴儿 `baby`）。
   *
   * 原来是 `!entities` 工具独有的，模型非调那个工具不可——而它就在
   * 快照里却不说自己是干什么的。搬过来后那个工具再无独有价值。
   * 用**可选**字段且非村民一律 `undefined`：快照的结构断言（toEqual）
   * 会忽略 undefined，加了字段也不破坏既有测试。
   */
  tag?: string;
}

export interface LiveBlock {
  name: string;
  distance: number;
  x: number;
  y: number;
  z: number;
}

export interface LiveScreenshot {
  ref: ScreenshotRef | null;
  /** 为 null 表示没有可用截图，这里写原因。 */
  unavailableReason: string | null;
  /**
   * **这一帧自己的朝向**（拍摄那一刻记录的，弧度）。
   *
   * 必须是"这一帧"的，不能是"现在身体朝哪"——真机事故：快照文字说"朝天空（pitch −88°）"、
   * 图里却是水平隧道 ⇒ bot 正确地不信图、把一张好画面丢掉。`null`/缺失 ⇒ 回执**什么都不说**，
   * 绝不拿当前朝向顶替。
   */
  view?: { yaw: number | null; pitch: number | null } | null;
  /**
   * **这一帧的颜色统计**（渲染后按像素量 `|R−G|+|G−B|`，0~510）。
   *
   * 真机 overnight_b：同一会话里颜色时有时无；而**判据曾经用平均彩度、结论错了**——
   * 灰墙为主的画面平均只有 2.72，可正前方一大片橙褐铁矿、左下角红棕花岗岩明明有颜色。
   * 所以判据是**彩色像素占比（尾部）**：`colouredFraction`（彩度 ≥24 的占比）< 2% 才判灰；
   * `p95` 看尾部强度；`mean` 只作次要数字，但**写进消息**让说法可核对。
   *
   * 这是**独立事实**，不能混进"可不可信"：丢颜色的图**认方块可以**，只是**别靠颜色认材质**。
   * `null`/缺失 ⇒ 没测 ⇒ 回执不提名。
   */
  color?: { mean: number; p95: number; colouredFraction: number; grayscale: boolean } | null;
}

export interface LiveMeta {
  gamemode: string | null;
  openScreen: string | null;
  currentAction: string | null;
  /** 潜行/疾跑等控制状态；null 表示普通站立。 */
  posture: string | null;
}

export interface LiveState {
  body: LiveBody;
  held: LiveHeld;
  backpack: LiveBackpack;
  position: LivePosition;
  environment: LiveEnvironment;
  entities: LiveEntity[];
  /** 感知范围内所有敌对实体的战力总和（食物/中立不算）。 */
  entitiesPower: number;
  /** 我自己当前的战斗力（同样的口径：每秒伤害 × 有效血 / 10），方便和上面比较。 */
  selfPower: number;
  blocks: LiveBlock[];
  /** 全已加载区块里最近的水、岩浆（没有就不列），给造黑曜石/找液体指路。 */
  fluids: LiveBlock[];
  screenshot: LiveScreenshot;
  goal: string | null;
  meta: LiveMeta;
}

/** 感知半径（格）；半径内全部返回，不截断明细。 */
export const PERCEPTION_RADIUS = 32;

/**
 * 主手耐久比例：1 = 全新，0 = 报废；读不到就 null。
 *
 * **必须钳到 [0,1]**。mineflayer 的 `durabilityUsed`（NBT Damage）可能大于
 * mcData 给的 `maxDurability`，直接算 `1 - used/max` 会得到负数——模型侧
 * 看到的就是 `Held: stone_pickaxe (durability -300%)` 这种鬼话（它还据此
 * 反馈过 bug）；更糟的是负值会让 `tool.durability_low` 永远处于触发态。
 *
 * `edges.ts` 也用它——两处必须是同一个算法，否则快照和边缘检测会各说各话。
 */
export function durabilityFraction(used: unknown, max: unknown): number | null {
  const u = num(used);
  const m = num(max);
  if (u == null || m == null || m <= 0) return null;
  // **`max <= 1` 说明读到的不是耐久上限**。模型真机把这条根因挖出来了：
  // "耐久原始读数 used=35 max=1（明显错）"——1 是**堆叠上限 stackSize**。
  // 于是 `1 - 35/1` 被钳成 0，快照显示"耐久剩余 0%"、`tool.durability_low`
  // 反复误报（白白唤醒请求）。读不到就说读不到，不要瞎报。
  if (m <= 1) return null;
  return Math.min(1, Math.max(0, 1 - u / m));
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function dist3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/** 罗盘八向：-Z 北、+Z 南、-X 西、+X 东（与 Minecraft 一致）。 */
export function compassOf(dx: number, dz: number): string {
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const idx = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][idx] as string;
}

export const KEY_BLOCKS: readonly string[] = Object.freeze([
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
  'chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest',
  'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'enchanting_table',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'brewing_stand', 'beacon',
  'bedrock', 'spawner', 'trial_spawner', 'bed',
  // **通关路线上的三个关键方块。** 真机上黑曜石下界门就在 1.9 米外，快照里却
  // 只列铜矿/煤矿，模型据此判断"门不在附近"并去质疑队友坐标（Feedback #28）。
  // 要塞的 nether_bricks、末地传送门框 end_portal_frame 同理：看不见就等于没有。
  'obsidian', 'nether_bricks', 'end_portal_frame',
]);

/**
 * KEY_BLOCKS 的集合视图：热路径上每个有名字的方块都要查一次（每轮约 27 万次
 * 迭代），线性 `Array.includes` 扫 38 个字符串太浪费。对外仍导出数组，契约不变。
 */
export const KEY_BLOCK_SET: ReadonlySet<string> = new Set(KEY_BLOCKS);

/**
 * 把逐格清单聚成"我总共有几个"：`[12]oak_logx16` + `[9]oak_logx4` → `oak_logx20`。
 *
 * 旧 `!inventory` 给的正是这个聚合（模型问"我有几个木头"时，让它把 36 格
 * 心算一遍是找错）。搬进快照后那个工具再无独有价值。
 * 名字里出现 `x数字` 只在末尾认一次（mc 物品名不会以 x+数字结尾）。
 */
export function aggregateTotals(items: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of items) {
    const m = /^(?:\*)?\[\d+\](.+?)x(\d+)$/.exec(raw);
    if (m == null) continue;
    const name = m[1];
    const count = Number(m[2]);
    if (typeof name !== 'string' || !Number.isFinite(count)) continue;
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}x${count}`);
}

/**
 * **仰角/俯角超过它就"画面里基本没有地面"**。
 *
 * 量化依据：MC 默认垂直视场角 ≈ 70°（半角 35°）⇒ 视线抬高超过半角，地平线就出画面、
 * 整张图只剩天空。**抬头是正数**，所以天空是 `pitch ≥ +35°`。
 */
export const SKY_PITCH_DEG = 35;
/** 超过这个俯角（**负**，因为低头是负）就是"几乎垂直向下"：只能看到脚下几格。 */
export const DOWN_PITCH_DEG = -70;

const UNKNOWN = '?';

/** 罗盘缩写换成中文方向（紧凑渲染用）。 */
function compassName(short: string): string {
  const names: Record<string, string> = {
    N: '北',
    NE: '东北',
    E: '东',
    SE: '东南',
    S: '南',
    SW: '西南',
    W: '西',
    NW: '西北',
  };
  return names[short] ?? short;
}

const DIMENSIONS: Readonly<Record<string, string>> = {
  'minecraft:overworld': '主世界',
  'minecraft:the_nether': '下界',
  'minecraft:the_end': '末地',
  overworld: '主世界',
  the_nether: '下界',
  the_end: '末地',
};

function fmt(value: number | null | undefined): string {
  if (value == null) return UNKNOWN;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/** `iron_pickaxex1` → `iron_pickaxe×1`；没有数量后缀的保持原样。 */
function itemShort(raw: string): string {
  return raw.replace(/x(\d+)$/, '×$1');
}

/** 主手耐久：`20/250（92%）`；上限读不到就标「上限?」，绝不拿假数字充数。 */
function durabilityTag(h: LiveHeld): string {
  const used = h.mainHandDurabilityUsed;
  const max = h.mainHandDurabilityMax;
  const pct = h.mainHandDurability != null ? `（${Math.round(h.mainHandDurability * 100)}%）` : '';
  if (used != null && max != null && max > 1) return `${used}/${max}${pct}`;
  if (used != null) return `已用 ${used}，上限?${h.mainHandDurabilityMaxInvalid === true ? '（读数无效）' : ''}`;
  if (max != null) return `上限 ${max}，已用?`;
  return '';
}

const WEATHER: Readonly<Record<LiveEnvironment['weather'], string>> = {
  Clear: '晴',
  Rain: '雨',
  Thunderstorm: '雷暴',
  Unknown: UNKNOWN,
};

/** 视线方向压成「朝北 / 抬头 86°，朝北」；读不到返回空串（不渲染）。 */
function viewTag(pitch: unknown, yaw: unknown): string {
  if (pitch == null || yaw == null) return '';
  const p = Number(pitch);
  const y = Number(yaw);
  if (!Number.isFinite(p) || !Number.isFinite(y)) return '';
  const deg = (p * 180) / Math.PI;
  const dir = compassName(compassOf(-Math.sin(y), -Math.cos(y)));
  if (deg >= SKY_PITCH_DEG) return `抬头 ${Math.round(deg)}°，朝${dir}`;
  if (deg <= DOWN_PITCH_DEG) return `低头 ${Math.round(Math.abs(deg))}°，朝${dir}`;
  return `朝${dir}`;
}

/** 每段渲成若干行：主体一行，实体/方块一行一个。 */
  /** 快照段落：同一份采样按固定顺序渲染，只用于提示词末尾。 */
const SECTION_RENDERERS: Readonly<Record<string, (s: LiveState) => string[]>> = {
  body: (s) => {
    const b = s.body;
    const bits = [
      `血量 ${fmt(b.health)}/20`,
      `饱食 ${fmt(b.food)}/20`,
      `饱和度 ${fmt(b.saturation)}`,
      `经验 ${fmt(b.xpLevel)}`,
      `姿势 ${b.pose ?? UNKNOWN}`,
      b.onGround == null ? '着地?' : b.onGround ? '着地' : '悬空',
      b.effects.length > 0 ? `效果 ${b.effects.join('、')}` : '无效果',
      `战力 ${s.selfPower}`,
    ];
    return [`身体：${bits.join('，')}`];
  },
  held: (s) => {
    const h = s.held;
    if (h.synced === false) return ['装备：未同步'];
    const hasDurability = h.mainHandDurabilityUsed != null || h.mainHandDurabilityMax != null;
    const main =
      h.mainHand != null && h.mainHand !== '' && h.mainHand !== 'empty'
        ? `手持 ${itemShort(h.mainHand)}${hasDurability ? `，耐久 ${durabilityTag(h)}` : ''}`
        : '手持 空';
    const off =
      h.offHand != null && h.offHand !== '' && h.offHand !== 'empty' ? `副手 ${itemShort(h.offHand)}` : '副手 空';
    const armor = h.armor.length > 0 ? `护甲 ${h.armor.map(itemShort).join('、')}` : '护甲 无';
    return [`装备：${main}；${off}；${armor}`];
  },
  backpack: (s) => {
    if (s.backpack.synced === false) return ['背包：未同步'];
    const free = s.backpack.freeSlots == null ? '空位?' : `空位 ${s.backpack.freeSlots}`;
    const items = s.backpack.items.length > 0 ? s.backpack.items.map(itemShort).join(' ') : '空';
    const lines = [`背包：${free}；${items}`];
    const totals = aggregateTotals(s.backpack.items);
    if (totals.length > 0) lines.push(`合计：${totals.map(itemShort).join(' ')}`);
    return lines;
  },
  position: (s) => {
    const p = s.position;
    const yaw = p.yaw == null ? UNKNOWN : String(Math.round((p.yaw * 180) / Math.PI));
    const pitch = p.pitch == null ? UNKNOWN : String(Math.round((p.pitch * 180) / Math.PI));
    const speed = p.speed == null ? UNKNOWN : fmt(p.speed);
    return [
      `位置：(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})，朝向 ${yaw}°/${pitch}°，速度 ${speed} 格/秒，` +
        `${DIMENSIONS[p.dimension ?? ''] ?? p.dimension ?? UNKNOWN}，${p.biome ?? UNKNOWN}`,
    ];
  },
  environment: (s) => {
    const e = s.environment;
    const light = e.light == null ? '光照?' : `光照 ${e.light}${e.lightConfidence === 'high' ? '' : '（可能过期）'}`;
    return [`环境：第 ${fmt(e.day)} 天，时间 ${fmt(e.timeOfDay)}，天气 ${WEATHER[e.weather]}，${light}`];
  },
  entities: (s) => {
    if (s.entities.length === 0) return ['实体：0 个'];
    const lines = [`实体：${s.entities.length} 个，敌对总战力 ${s.entitiesPower}`];
    for (const x of s.entities) {
      const bits = [`${x.name}#${x.id}`, `距离 ${x.distance} 格`, `坐标 (${fmt(x.x)}, ${fmt(x.y)}, ${fmt(x.z)})`];
      if (x.power != null) bits.push(`战力 ${x.power}`);
      if (x.health != null) bits.push(`血量 ${x.health}`);
      if (x.tag != null) bits.push(x.tag);
      lines.push(`  ${bits.join('，')}`);
    }
    return lines;
  },
  blocks: (s) => {
    if (s.blocks.length === 0) return ['关键方块：0 个'];
    // 同名方块合并成一行：给数量 + 最近的一处坐标；模型要动手时用最近那处。
    const groups = new Map<string, { count: number; nearest: LiveBlock }>();
    for (const block of s.blocks) {
      const found = groups.get(block.name);
      if (found == null) groups.set(block.name, { count: 1, nearest: block });
      else {
        found.count += 1;
        if (block.distance < found.nearest.distance) found.nearest = block;
      }
    }
    const ordered = [...groups.values()].sort((a, b) => a.nearest.distance - b.nearest.distance);
    const lines = [`关键方块：${s.blocks.length} 个`];
    for (const group of ordered) {
      const n = group.nearest;
      lines.push(`  ${n.name} ×${group.count}，最近 ${n.distance} 格，坐标 (${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)})`);
    }
    return lines;
  },
  fluids: (s) => {
    if (s.fluids.length === 0) return [];
    const tag = (n: string): string => (n === 'water' ? '水' : '岩浆');
    const bits = s.fluids.map(
      (f) => `${tag(f.name)} 最近 ${f.distance} 格 (${fmt(f.x)}, ${fmt(f.y)}, ${fmt(f.z)})`,
    );
    return [`寻找液体（全已加载区块）：${bits.join('；')}`];
  },
  screenshot: (s) => {
    const shot = s.screenshot;
    if (shot.ref == null) return [`截图：无（${shot.unavailableReason ?? '不可用'}）`];
    const age = Math.max(0, Math.round((Date.now() - shot.ref.takenAt) / 1000));
    const bits = [`截图：${shot.ref.file}，${age} 秒前`];
    const view = shot.view != null ? viewTag(shot.view.pitch, shot.view.yaw) : '';
    if (view !== '') bits.push(view);
    if (shot.color != null && shot.color.grayscale === true) bits.push('丢失颜色');
    return [bits.join('，')];
  },
  goal: (s) => [`目标：${s.goal == null || s.goal === '' ? '无' : s.goal}`],
  meta: (s) => {
    const m = s.meta;
    return [
      `状态：模式 ${m.gamemode ?? UNKNOWN}，界面 ${m.openScreen ?? '无'}，动作 ${m.currentAction ?? 'idle'}，姿势 ${m.posture ?? '-'}`,
    ];
  },
};

export const SNAPSHOT_SECTIONS = Object.keys(SECTION_RENDERERS);

/**
 * 把快照渲成追加在请求末尾的文本块（放最后，不破坏前缀缓存）。
 *
 * `sections` 用来给上下文小的模型做精简：只渲染选中的段落。
 */
export function renderLiveState(s: LiveState, options: { sections?: readonly string[] } = {}): string {
  const lines: string[] = [];
  for (const key of options.sections ?? SNAPSHOT_SECTIONS) {
    const render = SECTION_RENDERERS[key];
    if (render != null) lines.push(...render(s));
  }
  return lines.join('\n');
}

/** token 粗估（预算 guard，不是计费表）：CJK 一字≈1 token，ASCII≈1/4，故意往大估。 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of String(text)) tokens += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.25;
  return Math.ceil(tokens);
}
