import test from 'node:test';
import assert from 'node:assert/strict';
import { createBody, wireBody } from '../src/body/index.ts';
import type { BodyOptions, GameBody } from '../src/body/index.ts';
import type { LogEvent } from '../src/core/events.ts';

interface Raw {
  bot: any;
  fire: (name: string, ...args: unknown[]) => void;
  plugins: unknown[];
  moves: Array<{ x: number; y: number; z: number }>;
  equipped: string[];
  killed: string[];
}

function makePos(x: number, y: number, z: number): any {
  const p: any = { x, y, z };
  p.distanceTo = (o: { x: number; y: number; z: number }): number => Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z);
  p.offset = (dx: number, dy: number, dz: number): any => makePos(p.x + dx, p.y + dy, p.z + dz);
  p.floored = (): any => makePos(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  return p;
}

function makeRawBot(): Raw {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const plugins: unknown[] = [];
  const moves: Array<{ x: number; y: number; z: number }> = [];
  const equipped: string[] = [];
  const killed: string[] = [];
  const slots: Array<{ name: string; count: number; slot: number } | null> = new Array(46).fill(null);
  slots[36] = { name: 'dirt', count: 3, slot: 36 };
  slots[38] = { name: 'bread', count: 2, slot: 38 };
  let nextDropId = 100;
  const bot = {
    username: 'Bot',
    quitCalled: false,
    health: 20,
    food: 19,
    consumed: 0,
    entity: { id: 1, position: makePos(0, 64, 0) },
    heldItem: { name: 'iron_sword' },
    game: { dimension: 'minecraft:overworld' },
    equipped,
    moves,
    inventory: {
      items: () => [
        { name: 'dirt', count: 3, slot: 36 },
        { name: 'bread', count: 2, slot: 38 },
      ],
      slots,
    },
    entities: {
      '1': { id: 1, name: 'Bot', position: makePos(0, 64, 0) },
      '7': { id: 7, name: 'zombie', position: makePos(3, 64, 0) },
    },
    pathfinder: {
      goto: async (goal: unknown) => {
        const near = goal as { x?: number; y?: number; z?: number };
        if (typeof near.x === 'number') {
          moves.push({ x: near.x, y: Number(near.y ?? 0), z: near.z ?? 0 });
          // 走到掉落物旁边就算捡起来了（假 bot 只在测试里模拟这一步）。
          for (const [key, entity] of Object.entries(bot.entities as Record<string, any>)) {
            if (entity.name !== 'item' || entity.position == null) continue;
            const d = Math.hypot(entity.position.x - near.x, entity.position.y - Number(near.y ?? 0), entity.position.z - (near.z ?? 0));
            if (d <= 1.5) delete (bot.entities as Record<string, unknown>)[key];
          }
        }
      },
      stop: () => {},
      setMovements: () => {},
    },
    findBlocks: (options: { matching: (block: unknown) => boolean; count: number }) => {
      const candidates = [
        { name: 'iron_ore', position: { x: 5, y: 62, z: 0 } },
        { name: 'stone', position: { x: 6, y: 62, z: 0 } },
      ];
      return candidates
        .filter((block) => options.matching(block))
        .map((block) => block.position)
        .slice(0, options.count);
    },
    equip: async (item: { name: string }) => {
      equipped.push(item.name);
    },
    attack: async (entity: { id: number; name?: string; position?: { x: number; y: number; z: number } }) => {
      const name = entity.name;
      killed.push(String(name));
      delete (bot.entities as Record<string, unknown>)[String(entity.id)];
      // 打动物掉一块肉，落在旁边，等 KillAura 去捡。
      if (name === 'cow' || name === 'pig' || name === 'sheep' || name === 'chicken' || name === 'rabbit') {
        nextDropId += 1;
        const position = makePos(entity.position?.x ?? 0, entity.position?.y ?? 64, entity.position?.z ?? 0);
        (bot.entities as Record<string, unknown>)[String(nextDropId)] = { id: nextDropId, name: 'item', displayName: 'beef', position };
      }
    },
    lookAt: async () => {},
    blockAt: (position: { x: number; y: number; z: number }) => ({ name: 'iron_ore', position }),
    consume: async () => {
      bot.consumed += 1;
    },
    loadPlugin: (plugin: unknown) => {
      plugins.push(plugin);
    },
    on: (name: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    quit: () => {
      bot.quitCalled = true;
    },
  };
  return {
    bot,
    plugins,
    moves,
    equipped,
    killed,
    fire: (name: string, ...args: unknown[]) => {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
  };
}

function wired(extra: Partial<BodyOptions> = {}): { raw: Raw; body: GameBody; events: LogEvent[] } {
  const raw = makeRawBot();
  const events: LogEvent[] = [];
  const body = wireBody(raw.bot, {
    host: '127.0.0.1',
    port: 25565,
    username: 'Bot',
    goal: () => '砍三棵树',
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { raw, body, events };
}

test('接线：三个插件装上（pathfinder / custom-pvp / collectblock），事件按等级翻译', () => {
  const { raw, body, events } = wired();
  assert.equal(raw.plugins.length, 3, 'pathfinder、custom-pvp、collectblock 都要装');
  assert.equal(body.visionState(), 'off', '测试默认不开视觉');

  raw.fire('chat', 'Steve', '在吗');
  raw.fire('chat', 'Bot', '我自己说的话');
  raw.fire('health');
  raw.fire('death');
  raw.fire('spawn'); // 首次出生不算重生
  raw.fire('spawn'); // 第二次出生
  raw.fire('kicked', 'server closed');

  assert.deepEqual(
    events.map((event) => [event.type, event.level]),
    [
      ['player.chat', 3],
      ['self.health', 2],
      ['self.death', 5],
      ['self.respawn', 3],
      ['system.kicked', 5],
    ],
  );
  assert.match(events[0]?.text ?? '', /玩家 Steve 对你说：在吗/);
  assert.match(events[2]?.text ?? '', /你死了/);
  assert.match(events[3]?.text ?? '', /重生了，上次死亡在 \(0, 64, 0\)/, '重生叫醒时带上死亡坐标');
});

test('视觉：spawn 之前不初始化相机（不再构造时读 bot.entity）', () => {
  const raw = makeRawBot();
  const body = wireBody(raw.bot, {
    host: '127.0.0.1',
    port: 25565,
    username: 'Bot',
    goal: () => '砍三棵树',
    vision: true,
    onEvent: () => {},
  });
  assert.equal(body.visionState(), 'loading', '出生前只等待，不碰 bot.entity');
  body.close();
});

test('快照：背包、附近实体、目标都在', () => {
  const { body } = wired();
  const text = body.snapshot();
  assert.match(text, /位置：\(0, 64, 0\)/);
  assert.match(text, /\[36\]dirt×3/);
  assert.match(text, /iron_ore/);
  assert.match(text, /zombie#7/);
  assert.match(text, /目标：砍三棵树/);
});

test('分发：快照走 snapshot()，未知动作给清楚的回执', async () => {
  const { body } = wired();
  const ctx = { signal: new AbortController().signal, checkpoint: () => {} };
  assert.match(body.snapshot(), /## 世界快照/);
  assert.match((await body.execute('fly', {}, ctx)).text, /身体没有这个动作：fly/);
});

test('客户端报错：不崩，只记录（L2，不唤醒）', () => {
  const { raw, events } = wired();
  events.length = 0;
  raw.fire('error', new Error('socket hang up'));
  const errors = events.filter((event) => event.type === 'system.error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.level, 2);
  assert.match(errors[0]?.text ?? '', /socket hang up/);
});

test('close 真的断开连接', () => {
  const { raw, body } = wired();
  body.close();
  assert.equal(raw.bot.quitCalled, true);
});

test('扫描：只是扫描不发事件，真该动手时才发 L5，且 3 秒内不重复', () => {
  const { body, events } = wired();
  events.length = 0;
  body.scan();
  const engages = events.filter((event) => event.type === 'reflex.engage');
  assert.equal(engages.length, 1);
  assert.equal(engages[0]?.level, 5);
  assert.deepEqual((engages[0]?.payload as { reflex: string }).reflex, 'combat');
  assert.equal(engages[0]?.silent, true, '自动战斗事件对模型静默');

  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.engage').length, 1, '节流：不重复喊');
});

test('低血遇到怪：只发 L3 危险提醒，不强制逃跑、不抢身体', () => {
  const { raw, body, events } = wired();
  raw.bot.health = 4; // 低血 → 打不过
  events.length = 0;

  body.scan();

  const danger = events.filter((event) => event.type === 'danger.nearby');
  assert.equal(danger.length, 1, '应该发一条危险提醒');
  assert.equal(danger[0]?.level, 3, '危险提醒是 L3：空闲叫醒，忙就整流，不抢身体');
  assert.match(danger[0]?.text ?? '', /身体没动/);
  assert.equal(events.filter((event) => event.type === 'reflex.engage').length, 0, '不该触发战斗反射');
});

test('KillAura 打到一半发现打不过：停手 + L3 提醒，不追着送', async () => {
  const { raw, body, events } = wired();
  raw.bot.health = 4;
  events.length = 0;

  await body.reflex('combat', new AbortController().signal);

  assert.deepEqual(raw.killed, [], '不该继续攻击');
  assert.equal(raw.moves.length, 0, '不做无效的 10 格逃跑');
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 1);
  assert.equal(events.filter((event) => event.type === 'danger.nearby')[0]?.level, 3);
});

test('扫描：有敌人时按战斗力从高到低排进事件', () => {
  const { raw, body, events } = wired();
  raw.bot.entities['11'] = { id: 11, name: 'cow', position: makePos(6, 64, 0) };
  events.length = 0;

  body.scan();

  const engage = events.filter((event) => event.type === 'reflex.engage');
  assert.equal(engage.length, 1);
  assert.equal((engage[0]?.payload as { action?: string } | undefined)?.action, 'engage');
  const text = engage[0]?.text ?? '';
  assert.match(text, /zombie\(6\)/, '僵尸是唯一值得打的目标');
  assert.doesNotMatch(text, /cow\(0\)/, '食物动物不自动接管身体');
});

test('扫描：只有食物动物时也接管（狩猎补给）', () => {
  const { raw, body, events } = wired();
  delete raw.bot.entities['7'];
  raw.bot.entities['11'] = { id: 11, name: 'cow', position: makePos(6, 64, 0) };
  raw.bot.inventory.items = () => [{ name: 'bread', count: 10, slot: 38 }];
  events.length = 0;

  body.scan();

  const engage = events.filter((event) => event.type === 'reflex.engage');
  assert.equal(engage.length, 1, '同层有食物动物就该打');
  assert.match(engage[0]?.text ?? '', /cow/);
});

test('KillAura：见啥打啥，按目标战斗力从高到低，杀完捡掉落', async () => {
  const { raw, body } = wired();
  raw.bot.entities['11'] = { id: 11, name: 'cow', position: makePos(6, 64, 0) };
  raw.bot.entities['12'] = { id: 12, name: 'skeleton', position: makePos(4, 64, 0) };
  // 两个怪一起上要打得过：给假 bot 穿满钻石甲（护甲 20 点 → 有效血 5 倍）。
  raw.bot.inventory.slots[5] = { name: 'diamond_helmet', count: 1, slot: 5 };
  raw.bot.inventory.slots[6] = { name: 'diamond_chestplate', count: 1, slot: 6 };
  raw.bot.inventory.slots[7] = { name: 'diamond_leggings', count: 1, slot: 7 };
  raw.bot.inventory.slots[8] = { name: 'diamond_boots', count: 1, slot: 8 };

  await body.reflex('combat', new AbortController().signal);

  assert.deepEqual(raw.killed, ['zombie', 'skeleton', 'cow'], '先打战力 6 的僵尸，再打 3 的骷髅，最后打 0 的牛');
  assert.ok(raw.moves.length >= 1, '杀完应该走去捡掉落');
  const drops = Object.entries(raw.bot.entities).filter(([, entity]) => (entity as { name?: string }).name === 'item');
  assert.deepEqual(drops, [], '掉落物应该被捡掉');
});

test('KillAura：信号已打断就立即返回，不碰任何生物', async () => {
  const { raw, body } = wired();
  const aborter = new AbortController();
  aborter.abort();

  await body.reflex('combat', aborter.signal);

  assert.equal((raw.bot.entities['7'] as { name?: string }).name, 'zombie');
});

test('进食反射：血少且饱食不够 → 发 L5；执行体真的去吃；5 秒内不重复', async () => {
  const { raw, body, events } = wired();
  raw.bot.health = 10;
  raw.bot.food = 10;
  events.length = 0;

  body.scan();
  const eats = events.filter((event) => event.type === 'reflex.eat');
  assert.equal(eats.length, 1);
  assert.equal(eats[0]?.level, 5);
  assert.deepEqual((eats[0]?.payload as { reflex: string }).reflex, 'eat');

  await body.reflex('eat', new AbortController().signal);
  assert.deepEqual(raw.equipped, ['bread'], '吃之前要先把食物换到手上');
  assert.equal(raw.bot.consumed, 1);

  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.eat').length, 1, '节流：不重复喊');
});

test('吃饱了不发进食事件', () => {
  const { raw, body, events } = wired();
  raw.bot.health = 10;
  raw.bot.food = 19; // 饱食够，能自然回血 → 不用吃
  events.length = 0;
  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.eat').length, 0);
});

test('战斗开关：combat:false 不扫描、不接管，手动 attack 仍可用', async () => {
  const { raw, body, events } = wired({ combat: false });
  events.length = 0;

  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.engage').length, 0, '关掉后不自动战斗');
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 0, '关掉后也不发危险提醒');

  await body.reflex('combat', new AbortController().signal);
  assert.deepEqual(raw.killed, [], '反射不接管身体');

  // 手动攻击不受开关影响。
  await body.execute('attack', { entityId: 7 }, { signal: new AbortController().signal, checkpoint: () => {} });
  assert.deepEqual(raw.killed, ['zombie'], '手动 attack 仍然生效');
});

test('危险提醒：进入时提醒一次；抖一下不算脱离，持续脱离 30 秒才复位', () => {
  const { raw, body, events } = wired();
  raw.bot.health = 4;
  events.length = 0;

  body.scan();
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 1);
  body.scan();
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 1, '危险持续时不重复提醒');

  // 状态抖一下（怪走开又回来）不该再叫醒模型。
  raw.bot.health = 20;
  body.scan();
  raw.bot.health = 4;
  body.scan();
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 1, '抖动不复位');

  // 连续 30 次扫描都不危险，才算真的脱离。
  raw.bot.health = 20;
  for (let i = 0; i < 30; i += 1) body.scan();
  raw.bot.health = 4;
  body.scan();
  assert.equal(events.filter((event) => event.type === 'danger.nearby').length, 2, '真脱离后再进入才再提醒');
});

test('进食提醒：边缘触发，吃了/不饿之后才允许再提醒', () => {
  const { raw, body, events } = wired();
  raw.bot.health = 10;
  raw.bot.food = 10;
  events.length = 0;

  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.eat').length, 1);
  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.eat').length, 1, '饿着不重复喊');

  raw.bot.food = 20; // 不饿了 → 重置
  body.scan();
  raw.bot.food = 10;
  body.scan();
  assert.equal(events.filter((event) => event.type === 'reflex.eat').length, 2, '再次饿才再提醒');
});

test('血量事件节流：短时间内多次变化只写一条', () => {
  const { raw, events } = wired();
  events.length = 0;
  raw.fire('health');
  raw.fire('health');
  raw.fire('health');
  assert.equal(events.filter((event) => event.type === 'self.health').length, 1);
});

test('断线：在飞的动作被拒绝，身体锁不会卡住', async () => {
  const raws: Raw[] = [];
  const body = createBody({
    host: '127.0.0.1',
    port: 25565,
    username: 'Bot',
    goal: () => null,
    onEvent: () => {},
    reconnectDelayMs: 5,
    createBot: () => {
      const raw = makeRawBot();
      raw.bot.dig = () => new Promise(() => {});
      raw.bot.blockAt = () => ({ name: 'stone', position: { x: 1, y: 63, z: 0 } });
      raw.bot.lookAt = async () => {};
      raw.bot.stopDigging = () => {};
      raws.push(raw);
      return raw.bot;
    },
  });

  const pending = body.execute(
    'mineBlock',
    { x: 1, y: 63, z: 0 },
    { signal: new AbortController().signal, checkpoint: () => {} },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  raws[0]?.fire('end');

  await assert.rejects(pending, /disconnected/);
  body.close();
});

test('断线：发事件并自动重连，对外还是同一个 body', async () => {
  const raws: Raw[] = [];
  const events: LogEvent[] = [];
  const body = createBody({
    host: '127.0.0.1',
    port: 25565,
    username: 'Bot',
    goal: () => null,
    onEvent: (event) => events.push(event),
    reconnectDelayMs: 5,
    createBot: () => {
      const raw = makeRawBot();
      raws.push(raw);
      return raw.bot;
    },
  });

  assert.equal(raws.length, 1);
  const first = body.raw();
  raws[0]?.fire('end');

  assert.ok(events.some((event) => event.type === 'system.disconnected' && event.level === 5));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(raws.length, 2, '应该重连一次');
  assert.notEqual(body.raw(), first, '对外封装下换了新 bot');
  raws[1]?.fire('spawn'); // 重连后的 L3 要等新生出生再发
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    events.some((event) => event.type === 'system.reconnected' && event.level === 3),
    '重连要叫醒模型一次',
  );
  body.close();
});

test('全局自动拾取：空闲时发静默 L5，反射走过去捡起掉落物', async () => {
  const { raw, body, events } = wired();
  delete (raw.bot.entities as Record<string, any>)['7']; // 附近无威胁才自动捡
  (raw.bot.entities as Record<string, any>)['200'] = {
    id: 200,
    name: 'item',
    displayName: 'beef',
    position: makePos(2, 64, 0),
  };
  events.length = 0;
  body.scan();
  const trigger = events.find((event) => event.type === 'item.drop.nearby');
  assert.ok(trigger != null, '应该有自动拾取触发事件');
  assert.equal(trigger.level, 5);
  assert.equal(trigger.silent, true, '自动拾取对模型无感');

  const controller = new AbortController();
  await body.reflex('pickup', controller.signal);
  assert.equal((raw.bot.entities as Record<string, any>)['200'], undefined, '掉落物应被捡走');
  body.close();
});

test('落地水：下坠 + 水桶 → 发 reflex.mlg（L5、静默），落地后重新武装', () => {
  const { raw, body, events } = wired();
  events.length = 0;
  raw.bot.health = 20;
  raw.bot.entity.position = makePos(0.5, 80, 0.5);
  raw.bot.entity.velocity = { x: 0, y: -2.4, z: 0 };
  raw.bot.entity.isInWater = false;
  raw.bot.entity.width = 0.6;
  raw.bot.entity.eyeHeight = 1.62;
  raw.bot.game.minY = -64;
  raw.bot.inventory.items = () => [{ name: 'water_bucket', count: 1, slot: 36 }];
  raw.bot.blockAt = (position: { y: number }) => ({
    name: position.y === 60 ? 'stone' : 'air',
    position,
    boundingBox: position.y === 60 ? 'block' : 'empty',
  });

  raw.fire('physicsTick');
  const mlg = events.filter((event) => event.type === 'reflex.mlg');
  assert.equal(mlg.length, 1);
  assert.equal(mlg[0]?.level, 5);
  assert.deepEqual((mlg[0]?.payload as { reflex: string }).reflex, 'mlg');
  assert.equal(mlg[0]?.silent, true, '落地水对模型静默');

  raw.fire('physicsTick');
  assert.equal(events.filter((event) => event.type === 'reflex.mlg').length, 1, '同一次下坠不重复喊');

  raw.bot.entity.velocity = { x: 0, y: -0.1, z: 0 };
  raw.fire('physicsTick');
  raw.bot.entity.velocity = { x: 0, y: -2.4, z: 0 };
  raw.fire('physicsTick');
  assert.equal(events.filter((event) => event.type === 'reflex.mlg').length, 2, '落地后再掉会重新触发');
  body.close();
});

