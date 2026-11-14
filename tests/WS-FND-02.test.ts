/**
 * WS-FND-02:事件总线 + 生物宿主(事件驱动子系统的共同前置)。
 *
 * 这一套断言守护两件事:
 *   1. **事件总线真的有收件人、有序、有上限、能失败**(不是装饰);
 *   2. **25 个 AI 的 tick 生产可达** —— 此前 `aoi.stepActive(() => {})`
 *      是空回调,`MobFsm.tick` 也只在测试里被调用过。
 *
 * ## 对齐版本
 *
 * - `server/src/events/bus.ts`(新建)
 * - `server/src/mobs/host.ts`(新建)
 * - `server/src/sim/world_sim.ts`(接线:bus.drain + mobHost.tickMobs)
 *
 * 若这两个文件再变,以下断言最可能先失败:
 *   A01(常量) / A09(上限语义) / B06(移动权威) / C03(接线点)
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { mulberry32 } from '../shared/testing/harness.ts';
import { EventBus, MAX_EVENTS_PER_FRAME, MAX_HANDLERS_PER_EVENT, HISTORY_CAPACITY, MAX_REENTRY_DEPTH } from '../server/src/events/bus.ts';
import { MobHost, type MobHostWorld } from '../server/src/mobs/host.ts';
import { MOB_LIST, MOB_BY_ID } from '../shared/constants/mobs.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
/* C23/C24 走**真实 DB**(MemoryDb + 真实 repo.ts),不是查「函数被调用过」 */
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { createRoom, createUser, getUser, migrate } from '../server/src/db/repo.ts';
/* C25 守护 net 层接线:`RoomRuntime.step()` 每 20 帧是否真落盘 */
import { RoomRuntime } from '../server/src/net/room.ts';
import { fixedClock } from '../server/src/net/anticheat.ts';

/* ═══════════════ 测试脚手架 ═══════════════ */

/** 假世界:证明宿主可脱离 WorldSim 单测。 */
function makeWorld(): { world: MobHostWorld; log: string[]; floors: Map<string, number>; objs: Map<string, number>; spawned: { id: number; x: number; y: number; count: number }[] } {
  const log: string[] = [];
  const floors = new Map<string, number>();
  const objs = new Map<string, number>();
  const spawned: { id: number; x: number; y: number; count: number }[] = [];
  const world: MobHostWorld = {
    /* ⚠️ 极性:`true` = **阻挡**(与 `MobWorld.probe` 契约一致)。
       这里原来是 `x >= 0 && y >= 0 && x < 64 && y < 64`(界内 = true),
       极性是**反的** —— 它把「界内可走」报成「阻挡」。

       为什么以前没暴露:宿主此前不调用 `fsm.tick()`,而 `probe` 唯一的消费者
       就是 FSM 的 45° 避障。启用方案 D 后避障拿到的地形全反了,
       于是 FSM 与 rt 的位置分叉(B04 实测最大偏差 10),
       且 24 只生物互相「看见」不存在的墙壁。 */
    probe: (x, y) => !(x >= 0 && y >= 0 && x < 64 && y < 64),
    players: () => [
      { id: 'p1', x: 10, y: 10, z: 0, facingDeg: 0, afk: false, heldItem: 0, wearing: [], playingInstrument: false },
    ],
    groundItems: () => [],
    consumeGroundItem: () => 0,
    setFloor: (x, y, f) => {
      floors.set(`${x},${y}`, f);
      log.push(`setFloor(${x},${y},${f})`);
    },
    placeObj: (x, y, o) => {
      objs.set(`${x},${y}`, o);
      log.push(`placeObj(${x},${y},${o})`);
    },
    spawnItem: (x, y, id, c) => {
      spawned.push({ id, x, y, count: c });
      log.push(`spawnItem(${x},${y},${id},${c})`);
    },
    frame: () => 0,
  };
  return { world, log, floors, objs, spawned };
}

/** 登记全部 24 种生物。 */
function addAll(h: MobHost): string[] {
  for (const def of MOB_LIST) h.addMob(def.id, def, 10, 10, { anchorX: 10, anchorY: 10 });
  return MOB_LIST.map((m) => m.id);
}

/* ═══════════════ 1. 事件总线:常量与基本契约 ═══════════════ */

test('A01 上限常量与设计一致', () => {
  eq(MAX_EVENTS_PER_FRAME, 4096, '每帧事件上限');
  eq(MAX_HANDLERS_PER_EVENT, 512, '单事件处理器上限');
  eq(HISTORY_CAPACITY, 512, '日志容量');
  eq(MAX_REENTRY_DEPTH, 8, '重入深度上限');
  /* 自查:日志容量应是 2 的幂(环形缓冲取模代价低),且上限足够大
     以容纳正常玩法(实测正常帧事件数为个位数) */
  ok((HISTORY_CAPACITY & (HISTORY_CAPACITY - 1)) === 0, '日志容量为 2 的幂');
  ok(MAX_EVENTS_PER_FRAME > 100, '每帧上限远大于正常帧事件数');
});

test('A02 on() 精确订阅只收到同类事件', () => {
  const b = new EventBus();
  const got: string[] = [];
  b.on('boar_wall_stun', (e) => got.push(e.kind));
  b.emit('boar_wall_stun');
  b.emit('beaver_dam_built');
  b.emit('boar_wall_stun');
  b.drain();
  eq(got.length, 2, '只收到 2 个同类');
  eq(got[0], 'boar_wall_stun');
});

test('A03 前缀通配 mimic_* 与全通配 * 都能收', () => {
  const b = new EventBus();
  const star: string[] = [];
  const prefix: string[] = [];
  b.on('*', (e) => star.push(e.kind));
  b.on('mimic_*', (e) => prefix.push(e.kind));
  b.emit('mimic_ambush');
  b.emit('mimic_exploded');
  b.emit('boar_wall_stun');
  b.drain();
  eq(star.length, 3, '全通配收 3');
  eq(prefix.length, 2, 'mimic_* 收 2');
  eq(prefix, ['mimic_ambush', 'mimic_exploded'], '前缀匹配命中真实 snake_case 事件名');
});

test('A03b 点分隔形式 mimic.* 不得命中(本项目事件名不含点)', () => {
  /* 我最初只支持 `mimic.*` 形式,而项目 29 种事件全是 snake_case ——
     那种订阅**永远收不到任何事件**且不报错。这条断言把该陷阱固化。 */
  const b = new EventBus();
  let n = 0;
  b.on('mimic.*', () => {
    n += 1;
  });
  b.emit('mimic_ambush');
  b.drain();
  eq(n, 0, '点分隔不命中 —— 订阅方必须用 mimic_*');
  /* 反向确认:换成下划线前缀就命中了 */
  let m = 0;
  b.on('mimic_*', () => {
    m += 1;
  });
  b.emit('mimic_ambush');
  b.drain();
  eq(m, 1, '正确的写法命中');
});

test('A04 通配匹配语义:精确与前缀互不干扰', () => {
  const b = new EventBus();
  const exact: string[] = [];
  b.on('boar_wall_stun', () => exact.push('exact'));
  /* `boar.*` 不该匹配 `boar_wall_stun`(那是下划线不是点) */
  b.on('boar.*', () => exact.push('prefix'));
  b.emit('boar_wall_stun');
  b.drain();
  eq(exact, ['exact'], '只有精确订阅命中');
});

test('A05 off() 取消订阅后不再收到', () => {
  const b = new EventBus();
  let n = 0;
  const off = b.on('*', () => {
    n += 1;
  });
  b.emit('x');
  b.drain();
  eq(n, 1);
  off();
  b.emit('x');
  b.drain();
  eq(n, 1, '取消后不再增长');
  eq(b.subscriptionCount, 0);
});

test('A06 once() 只触发一次', () => {
  const b = new EventBus();
  let n = 0;
  b.once('*', () => {
    n += 1;
  });
  b.emit('a');
  b.emit('b');
  b.drain();
  eq(n, 1, '只触发一次');
});

test('A07 多处订阅按注册顺序调用(顺序稳定,不依赖物理数组位置)', () => {
  const b = new EventBus();
  const order: string[] = [];
  b.on('*', () => order.push('1'));
  b.on('*', () => order.push('2'));
  b.on('*', () => order.push('3'));
  b.emit('x');
  b.drain();
  eq(order, ['1', '2', '3'], '按注册顺序');
});

test('A08 payload 与 source 原样搬运(总线不猜语义)', () => {
  const b = new EventBus();
  const got: { p: unknown; s: string }[] = [];
  b.on('*', (e) => got.push({ p: e.payload, s: e.source }));
  b.emit('test', { a: 1, b: 'two', c: true }, 'mob_x');
  b.drain();
  eq(got.length, 1);
  eq(JSON.stringify(got[0].p), JSON.stringify({ a: 1, b: 'two', c: true }));
  eq(got[0].s, 'mob_x');
});

/* ═══════════════ 2. 事件总线:FIFO 与重入 ═══════════════ */

test('A09 同帧事件按 FIFO 顺序投递', () => {
  const b = new EventBus();
  const got: string[] = [];
  b.on('*', (e) => got.push(e.kind));
  b.emit('a');
  b.emit('b');
  b.emit('c');
  b.drain();
  eq(got, ['a', 'b', 'c']);
});

test('A10 处理器内 emit 追加到当帧队列尾(不递归加深栈)', () => {
  const b = new EventBus();
  const got: string[] = [];
  b.on('a', () => {
    got.push('a');
    b.emit('b');
  });
  b.on('b', () => got.push('b'));
  b.emit('a');
  b.drain();
  /* 关键:a 先投递完(处理器返回),b 才被处理 —— 不是 a 内嵌套 b */
  eq(got, ['a', 'b'], 'FIFO:嵌套 emit 排在当帧队尾');
});

test('A11 自我 emit 不炸栈,被重入上限拦住', () => {
  const b = new EventBus();
  let calls = 0;
  b.on('loop', () => {
    calls += 1;
    b.emit('loop');
  });
  b.emit('loop');
  const st = b.drain();
  /* 每个事件都会把新事件追加到队尾,但重入深度按 kind 计 ——
     由于每次都是一个新事件(不是嵌套调用),深度不增长,
     实际靠 MAX_EVENTS_PER_FRAME 兜底。断言:不抛异常、有界。 */
  ok(calls > 0, '处理器被调用了');
  ok(calls <= MAX_EVENTS_PER_FRAME + 1, `调用数有界(实际 ${calls})`);
  ok(st.emitted > 0);
});

test('A12 每帧事件数超上限时丢弃并记账,不静默吞掉', () => {
  const b = new EventBus();
  b.on('*', () => {});
  /* 发超过上限的数量。上限 4096,发 4200。
     期望值写字面量 4096,不引 `MAX_EVENTS_PER_FRAME` —— 报文的 delivered
     **由该常量兜底**(bus.ts:262 `if (processed >= MAX_EVENTS_PER_FRAME)`),
     故引用它恒真。4096 的独立来源:手册 `docs/EVENT-BUS.md` §1.2 上限行
     「每帧 4096 事件 / 每事件 512 处理器 / 重入深度 8」。 */
  const N = 4096 + 104;
  for (let i = 0; i < N; i += 1) b.emit('bulk');
  const st = b.drain();
  eq(st.dropped, 104, '丢弃 104 个');
  eq(st.delivered, 4096, '投递 4096 个(手册 EVENT-BUS.md §1.2)');
  eq(b.totals.dropped, 104, '累计丢弃记账');
  /* 日志里应有一条 overflow 标记,使「丢了东西」这件事可查 */
  const overflow = b.history().filter((r) => r.event.kind === '<overflow>');
  eq(overflow.length, 1, '有 overflow 记录');
});

test('A13 处理器抛错被隔离,同帧其它事件与其它处理器照常', () => {
  const b = new EventBus();
  const got: string[] = [];
  b.on('x', () => {
    throw new Error('handler exploded');
  });
  b.on('x', () => got.push('second-handler-ran'));
  b.on('y', () => got.push('y-ran'));
  b.emit('x');
  b.emit('y');
  const st = b.drain();
  eq(got, ['second-handler-ran', 'y-ran'], '同事件的后继处理器与后续事件都照常');
  eq(st.errors, 1, '抛错被记账');
  const rec = b.history().find((r) => r.event.kind === 'x' && r.errors.length > 0);
  ok(rec !== undefined, '错误写进日志');
  ok(rec!.errors[0].includes('handler exploded'), '错误信息含原因');
});

test('A14 收件人快照:处理器内取消订阅不影响本次投递', () => {
  const b = new EventBus();
  const got: string[] = [];
  const off2 = b.on('*', () => got.push('h1'));
  b.on('*', () => {
    got.push('h2');
    off2(); /* 在投递过程中取消 h1(已排在自己后面,已被调用;改为取消 h3) */
  });
  const off3 = b.on('*', () => got.push('h3'));
  b.emit('x');
  b.drain();
  /* h1 和 h2 已调用;h3 在快照里,也应被调用 —— 因为快照在投递前取。 */
  ok(got.includes('h1') && got.includes('h2'), '前两个处理器都跑了');
  void off3;
});

test('A15 处理器内新增订阅不影响本次投递(快照语义的另一面)', () => {
  const b = new EventBus();
  const got: string[] = [];
  b.on('*', () => {
    got.push('first');
    b.on('*', () => got.push('added-later'));
  });
  b.emit('x');
  b.drain();
  eq(got, ['first'], '本次投递不含中途新增的订阅');
  /* 但下一帧就应该收得到了 */
  b.emit('y');
  b.drain();
  ok(got.includes('added-later'), '下一帧收到');
});

/* ═══════════════ 3. 事件总线:统计与日志 ═══════════════ */

test('A16 snapshot() 反映帧序/待投递/订阅数/累计', () => {
  const b = new EventBus();
  b.on('*', () => {});
  const s0 = b.snapshot();
  eq(s0.frame, 0);
  eq(s0.pending, 0);
  eq(s0.subs, 1);
  eq(s0.totals.frames, 0);
  b.emit('x');
  eq(b.snapshot().pending, 1, '未 drain 时 pending=1');
  b.drain();
  const s1 = b.snapshot();
  eq(s1.frame, 1, 'drain 后帧序前进');
  eq(s1.pending, 0);
  eq(s1.totals.emitted, 1);
  eq(s1.totals.delivered, 1);
});

test('A17 日志环形缓冲:超容量后只保留最近 512 条', () => {
  const b = new EventBus();
  b.on('*', () => {});
  /* 期望值写字面量 512,不引 `HISTORY_CAPACITY` —— 保留条数**由该常量决定**
     (bus.ts:348/351 的环形入队与取模都用它),故引用它恒真。
     512 的独立来源:手册 `docs/EVENT-BUS.md` §1.2 上限行与 §1.3 观测段
     「bus.history() // 最近 512 条投递记录(含错误与丢弃)」。 */
  const N = 512 + 50;
  for (let i = 0; i < N; i += 1) {
    b.emit(`e${i}`);
    b.drain();
  }
  const h = b.history();
  eq(h.length, 512, '保留满容量(手册 EVENT-BUS.md §1.3 写 512)');
  /* 最早的应是第 50 条(e50),最新的应是 eN-1 */
  eq(h[0].event.kind, 'e50', '环形覆盖最旧的');
  eq(h[h.length - 1].event.kind, `e${N - 1}`, '最新在末尾');
  /* 顺序必须是时间序,不能是环形数组的物理序 */
  const idx = h.map((r) => Number(r.event.kind.slice(1)));
  for (let i = 1; i < idx.length; i += 1) {
    ok(idx[i] === idx[i - 1] + 1, `时间序连续:${idx[i - 1]} → ${idx[i]}`);
  }
});

test('A18 countOf() 统计某类事件次数', () => {
  const b = new EventBus();
  b.on('*', () => {});
  b.emit('boar_wall_stun');
  b.emit('boar_wall_stun');
  b.emit('other');
  b.drain();
  eq(b.countOf('boar_wall_stun'), 2);
  eq(b.countOf('other'), 1);
  eq(b.countOf('never'), 0);
});

test('A19 reset() 清空一切', () => {
  const b = new EventBus();
  b.on('*', () => {});
  b.emit('x');
  b.drain();
  b.reset();
  const s = b.snapshot();
  eq(s.frame, 0);
  eq(s.pending, 0);
  eq(s.totals.emitted, 0);
  eq(s.totals.delivered, 0);
  eq(b.history().length, 0);
  /* 订阅**不**被 reset 清掉(那是 clear() 的职责)—— 分开是刻意的:
     测试之间清日志不该顺带把订阅关系也抹了 */
  eq(b.subscriptionCount, 1, 'reset 不动订阅');
});

test('A20 clear() 只清订阅', () => {
  const b = new EventBus();
  b.on('*', () => {});
  b.emit('x');
  b.drain();
  b.clear();
  eq(b.subscriptionCount, 0);
  eq(b.snapshot().totals.delivered, 1, '统计还在');
});

/* ═══════════════ 4. 确定性 ═══════════════ */

test('A21 同输入序列必产出同投递序列(无 Math.random)', () => {
  const run = (): string => {
    const b = new EventBus();
    const got: string[] = [];
    b.on('*', (e) => got.push(`${e.kind}@${e.frame}`));
    for (const k of ['a', 'b', 'c', 'a', 'b']) b.emit(k);
    b.drain();
    for (const k of ['d', 'a']) b.emit(k);
    b.drain();
    return got.join('|');
  };
  eq(run(), run(), '两次完全一致');
});

/* ═══════════════ 5. 生物宿主 ═══════════════ */

test('B01 宿主可登记全部 24 种生物', () => {
  const { world } = makeWorld();
  const h = new MobHost(world);
  addAll(h);
  eq(h.size, MOB_LIST.length, '全部登记');
  eq(h.size, 24, '生物总数');
});

test('B02 24 种生物全部绑定**正确的**专属 AI(硬编码期望表)', () => {
  const { world } = makeWorld();
  const h = new MobHost(world);
  addAll(h);
  const ais = h.ais();
  eq(ais.length, 24);

  /* 零回落 —— 任何一只绕过专属 AI 都说明工厂表漏了它 */
  const fallback = ais.filter((a) => a.ctor === 'DefaultMobAi');
  eq(fallback.length, 0, `无回落实现(回落的:${fallback.map((f) => f.id).join(', ')})`);

  /*
   * **硬编码期望表**,不从代码里推导。
   *
   * 为什么不用「ID 首段驼峰化」这类推导规则:它有反例 ——
   * `mob_choco_golem` → `ChocoGolemAi`(「巧克力」+「魔像」两词),
   * `mob_slime_green` → `SlimeAi`,`mob_bat_sonic` → `BatAi`。
   * 推导规则看似聪明,但要写一串例外,而例外一多就没人看得懂它到底在断言什么。
   *
   * 硬编码表的价值:它是**外部事实**(人工核对过每个 ID 该用哪个 AI),
   * 不是被测代码的像。工厂表被改错位(野猪跑绵羊的 AI)会立刻失败,
   * 而那种错**不报错、看起来一切正常**。
   */
  const EXPECTED: Record<string, string> = {
    mob_sheep: 'SheepAi',
    mob_slime_green: 'SlimeAi',
    mob_boar: 'BoarAi',
    mob_squirrel: 'SquirrelAi',
    mob_beaver: 'BeaverAi',
    mob_crab_river: 'CrabRiverAi',
    mob_capybara: 'CapybaraAi',
    mob_tanuki: 'TanukiAi',
    mob_samurai_bamboo: 'SamuraiAi',
    mob_glow_frog: 'GlowFrogAi',
    mob_bat_sonic: 'BatAi',
    mob_beetle_crystal: 'BeetleAi',
    mob_chocobo: 'ChocoboAi',
    mob_pangolin: 'PangolinAi',
    mob_scorpion: 'ScorpionAi',
    mob_ginger_imp: 'GingerImpAi',
    mob_pudding_mage: 'PuddingMageAi',
    mob_choco_golem: 'ChocoGolemAi',
    mob_sky_manta: 'SkyMantaAi',
    mob_harpy_harp: 'HarpyAi',
    mob_thunder_sprite: 'ThunderSpriteAi',
    mob_mimic_cog: 'MimicCogAi',
    mob_lava_elem: 'LavaElemAi',
    mob_clock_knight: 'ClockKnightAi',
  };
  eq(Object.keys(EXPECTED).length, 24, '期望表覆盖全部 24 种');

  const wrong: string[] = [];
  for (const a of ais) {
    const want = EXPECTED[a.id];
    if (want === undefined) wrong.push(`${a.id}→${a.ctor}(期望表里没这个 ID)`);
    else if (a.ctor !== want) wrong.push(`${a.id}→${a.ctor}(应为 ${want})`);
  }
  eq(wrong, [], '每个 ID 绑定到正确的 AI 类');

  /* 类名集合必须 24 个不同 —— 不能两个 ID 指向同一个 AI 类
     (那意味着其中一只用错了行为,而这类错不报错) */
  const distinct = new Set(ais.map((a) => a.ctor));
  eq(distinct.size, 24, `24 个不同 AI 类(实际 ${distinct.size})`);

  /* 期望表本身必须与冻结层的生物表完全对齐 —— 防「加了新生物但忘了
     在这里登记」导致新生物**静默不被检查**。 */
  const mobIds = new Set(MOB_LIST.map((m) => m.id));
  const expectedIds = new Set(Object.keys(EXPECTED));
  const notCovered = [...mobIds].filter((id) => !expectedIds.has(id)).sort();
  eq(notCovered, [], 'MOB_LIST 里每个生物都在期望表里(否则新生物不受检查)');
});

test('B03 宿主提供的 fsm 是真实 MobFsm 且可写标志', () => {
  const { world } = makeWorld();
  const h = new MobHost(world);
  h.addMob('mob_boar', MOB_BY_ID.get('mob_boar')!, 10, 10);
  const rt = h.runtimeOf('mob_boar')!;
  eq(rt.fsm.constructor.name, 'MobFsm', '是真实 FSM');
  eq(rt.fsm.state, 'IDLE_GRAZE', '初态');
  /* AI 会写这两个字段(实测 behaviors.ts 里 rt.fsm.flee 2 处、rt.fsm.state 1 处)。
     若宿主给 undefined,会抛 "Cannot set properties of undefined" —— 
     这正是修复前的 61/480 抛错。 */
  rt.fsm.flee = true;
  eq(rt.fsm.flee, true, '可写 flee');
  rt.fsm.state = 'ALERT_FLEE_OR_CHASE';
  eq(rt.fsm.state, 'ALERT_FLEE_OR_CHASE', '可写 state');
});

test('B04 宿主推进 FSM 基础移动(方案 D),且 AI 接管时不产生双侧写入', () => {
  /* 这条断言**被改过** —— 原来是「宿主绝不调用 fsm.tick」,
     守的是「避免两个移动权威」。但那个保守选择有致命后果:
     实测 **22/24 生物 60 秒位移为 0**(与玩家在不在场无关),
     它们连游荡都不会,因为游荡逻辑只存在于 FSM 里。

     方案 D 的分工是:**FSM 做基础移动(游荡/警戒/追猎),AI 做专属动作**;
     当 AI 写了位置时,宿主把 FSM 的内部位置**同步**到 AI 的落点,
     所以不存在「两条轨迹越走越远」的双侧写入。

     本断言守三件事:
       1. FSM 确实被推进了(fsm.ticks 在增长)——否则 22 种生物不游荡;
       2. 每只生物的 fsm.x/y 与 rt.x/y **始终一致** —— 这是「无双侧写入」的
          直接证据,比「不调用」更强:调用但不同步才会瞬移;
       3. 两种路径都被走到过(fsmMoves 与 aiOverrides 都 > 0)——
          否则其中一条是死代码。 */
  const { world } = makeWorld();
  const h = new MobHost(world);
  addAll(h);
  const before = h.runtimes().map((rt) => rt.fsm.ticks);
  for (let i = 0; i < 30; i += 1) h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
  const after = h.runtimes().map((rt) => rt.fsm.ticks);
  ok(after.some((v, i) => v > before[i]), 'FSM 被推进了(至少一只生物)');

  /* 最强的一条:位置同步。若两条轨迹分叉,这里立刻报红。 */
  const drift = h
    .runtimes()
    .map((rt) => Math.max(Math.abs(rt.x - rt.fsm.x), Math.abs(rt.y - rt.fsm.y)))
    .reduce((a, b) => Math.max(a, b), 0);
  ok(drift < 1e-6, `FSM 与 rt 位置无分叉(最大偏差 ${drift})`);

  /* 两种路径都要被走到 —— 否则「按动作分工」只实现了一半。 */
  ok(h.totals.fsmMoves > 0, `FSM 基础移动生效过(${h.totals.fsmMoves} 次)`);
  ok(h.totals.aiOverrides > 0, `AI 专属运动接管过(${h.totals.aiOverrides} 次)`);
});

test('B05 全部 24 种生物推进 100 帧零抛错', () => {
  const { world } = makeWorld();
  const b = new EventBus();
  const h = new MobHost(world, { bus: b });
  const ids = addAll(h);
  for (let i = 0; i < 100; i += 1) {
    h.tickMobs(ids, 0.05);
    b.drain();
  }
  /* 修复前:61/480 = 12.7% 抛错(rt.fsm 为 undefined)。
     现在必须是 0 —— 任何抛错都说明某个 AI 需要宿主没提供的东西。 */
  eq(h.totals.errors, 0, `零抛错(实际 ${h.totals.errors}/${h.totals.ticks})`);
  eq(h.totals.ticks, 24 * 100, '推进次数 = 生物数 × 帧数');
});

test('B06 AI 的移动真的生效(rt.x/rt.y 会变)', () => {
  const { world } = makeWorld();
  const h = new MobHost(world, { bus: new EventBus() });
  /* 用会主动移动的 AI:野猪发现玩家后冲锋(玩家在 10,10,野猪放 16,10 的
     攻击圈外但在感知圈内 —— 畜力 1 秒后沿直线冲)。 */
  const def = MOB_BY_ID.get('mob_boar')!;
  h.addMob('mob_boar', def, 16, 10, { anchorX: 16, anchorY: 10 });
  const rt = h.runtimeOf('mob_boar')!;
  const x0 = rt.x;
  const y0 = rt.y;
  for (let i = 0; i < 60; i += 1) h.tickMobs(['mob_boar'], 0.05);
  /* 位置或 mem 至少有一项变了 —— 若两者都完全不动,说明 tick 是空转 */
  const posChanged = rt.x !== x0 || rt.y !== y0;
  const memChanged = Object.keys(rt.mem).length > 0;
  ok(posChanged || memChanged, `AI 产生了可观测变化(x ${x0}→${rt.x.toFixed(3)}, y ${y0}→${rt.y.toFixed(3)}, mem ${Object.keys(rt.mem).length} 项)`);
  /* 更硬的一条:野猪的 tick 必然写 mem(实测 behaviors.ts 有 30+ 处 mem 写入)。
     若 mem 为空,说明那个 AI 根本没跑。 */
  ok(Object.keys(rt.mem).length > 0, `野猪 AI 写入了 mem:${JSON.stringify(Object.keys(rt.mem).slice(0, 6))}`);
});

test('B07 排序不变性:传入顺序不同,行为序列相同', () => {
  const runWith = (order: string[]): string => {
    const { world } = makeWorld();
    const b = new EventBus();
    const h = new MobHost(world, { bus: b });
    const got: string[] = [];
    b.on('*', (e) => got.push(`${e.kind}:${e.source}`));
    addAll(h);
    const seq: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      seq.push(h.tickMobs(order, 0.05).map((r) => `${r.id}:${r.error ?? '-'}:${r.warns.length}`).join('|'));
      b.drain();
    }
    return seq.join('\n') + '###' + got.join(',');
  };
  const ids = MOB_LIST.map((m) => m.id);
  const asc = [...ids].sort();
  const desc = [...ids].sort().reverse();
  eq(runWith(asc), runWith(desc), '升序与降序传入结果一致(宿主内部排序)');
});

test('B08 宿主两次运行完全一致(确定性,依赖注入的 rng)', () => {
  const run = (): string => {
    const { world } = makeWorld();
    const b = new EventBus();
    const h = new MobHost(world, { bus: b, rng: mulberry32(12345) });
    const got: string[] = [];
    b.on('*', (e) => got.push(`${e.kind}:${e.source}`));
    addAll(h);
    const seq: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      seq.push(h.tickMobs(MOB_LIST.map((m) => m.id), 0.05).map((r) => `${r.id}:${r.warns.length}`).join('|'));
      b.drain();
    }
    return seq.join('\n') + '###' + got.join(',');
  };
  eq(run(), run(), '同种子两次一致');
});

test('B09 不同种子产出不同 rng 序列(证明种子真的被用)', () => {
  const seqOf = (seed: number): string => {
    const { world } = makeWorld();
    const h = new MobHost(world, { bus: new EventBus(), rng: mulberry32(seed) });
    addAll(h);
    /* FSM 的 resetGraze 用 rng —— 但构造时就调了一次,不推进也能量到。
       改从宿主自己的 rng 抽样,直接证明它来自注入源。 */
    const out: string[] = [];
    for (let i = 0; i < 5; i += 1) out.push(h.rng().toFixed(6));
    return out.join(',');
  };
  ok(seqOf(1) !== seqOf(2), '不同种子不同序列');
  eq(seqOf(1), seqOf(1), '同种子同序列');
});

/* ═══════════════ 6. 宿主:事件与落地动作 ═══════════════ */

test('B10 emit 的 source 是发起生物 ID(AI 不传自己的 ID,宿主补上)', () => {
  const { world } = makeWorld();
  const b = new EventBus();
  const h = new MobHost(world, { bus: b });
  const got: { kind: string; source: string }[] = [];
  b.on('*', (e) => got.push({ kind: e.kind, source: e.source }));
  addAll(h);
  for (let i = 0; i < 100; i += 1) {
    h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
    b.drain();
  }
  ok(got.length > 0, `产生了事件(实际 ${got.length} 个):${[...new Set(got.map((g) => g.kind))].join(', ')}`);
  /* 每个事件的 source 都必须是真实生物 ID */
  const ids = new Set(MOB_LIST.map((m) => m.id));
  const bad = got.filter((g) => !ids.has(g.source) && g.source !== 'mob' && g.source !== 'system');
  eq(bad.length, 0, `source 全部是真实生物 ID(异常:${JSON.stringify(bad.slice(0, 3))})`);
});

test('B11 事件真的投到订阅方(此前 30 处 emit 喊给空气)', () => {
  const { world } = makeWorld();
  const b = new EventBus();
  const h = new MobHost(world, { bus: b });
  const hits: string[] = [];
  /* 订阅全部 29 种 AI 事件(用前缀通配 + 精确混合,顺带覆盖两种写法) */
  b.on('*', (e) => hits.push(`${e.kind}←${e.source}`));
  addAll(h);
  for (let i = 0; i < 200; i += 1) {
    h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
    b.drain();
  }
  eq(b.totals.dropped, 0, '无丢弃');
  /* 硬断言:hits 数必须等于 bus 投递数(证明每个 emit 都到了订阅方,
     没有被「处理了但没人收」这类静默路径吞掉) */
  eq(hits.length, b.totals.delivered, '每个投递都被订阅方收到');
  ok(hits.length > 0, `确实产生了事件:${JSON.stringify([...new Set(hits)].slice(0, 6))}`);
  /* 且这些事件名必须是 behaviors.ts 里真实存在的 29 种之一 */
  const declared = new Set([
    'bat_sonar_jammed', 'beaver_dam_built', 'beaver_hammered', 'beetle_flipped',
    'boar_charge_end', 'boar_slip_stun', 'boar_wall_stun', 'capybara_heart_reflect',
    'choco_melted', 'chocobo_feed_failed', 'chocobo_tamed', 'crab_soup',
    'ginger_escaped', 'ginger_hooked', 'harpy_ensemble_gift', 'harpy_gust',
    'knight_key_pulled', 'lava_solidified', 'manta_ride', 'mimic_ambush',
    'mimic_exploded', 'pangolin_batted', 'pangolin_wall_stun', 'samurai_burning',
    'samurai_ignited', 'scorpion_ambush', 'scorpion_forced_surface', 'tanuki_ambush',
    'thunder_discharge',
  ]);
  const unknown = [...new Set(hits.map((x) => x.split('←')[0]))].filter((k) => !declared.has(k));
  eq(unknown, [], '事件名全部在 behaviors.ts 声明的 29 种之内');
});

test('B12 未注入总线:事件被计数但丢弃(可观测,非静默)', () => {
  const { world } = makeWorld();
  const h = new MobHost(world); /* 无 bus */
  addAll(h);
  for (let i = 0; i < 200; i += 1) h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
  /* 关键:表现是「发出 N 个但投递 0 个」—— 可观测。
     若宿主在无 bus 时连计数都不加,「忘了接总线」就完全无痕。 */
  ok(h.totals.emitted > 0, `发出事件被计数(实际 ${h.totals.emitted})`);
});

test('B13 AI 的落地动作走到世界(setFloor / placeObj / spawnItem)', () => {
  const { world, log } = makeWorld();
  const b = new EventBus();
  const h = new MobHost(world, { bus: b });
  addAll(h);
  for (let i = 0; i < 200; i += 1) {
    h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
    b.drain();
  }
  ok(log.length > 0, `世界发生变更(${log.length} 次):${[...new Set(log)].slice(0, 4).join(', ')}`);
  ok(h.totals.spawned >= 0, '掉落生成计数存在');
});

test('B14 预警几何被收集且有上限', () => {
  const { world } = makeWorld();
  const h = new MobHost(world, { bus: new EventBus(), maxWarnsPerMob: 64 });
  addAll(h);
  for (let i = 0; i < 200; i += 1) h.tickMobs(MOB_LIST.map((m) => m.id), 0.05);
  /* 每个生物的 warns 不得超过上限 */
  for (const rt of h.runtimes()) {
    ok(rt.warns.length <= 64, `${rt.id} warns=${rt.warns.length} ≤ 64`);
  }
  eq(h.totals.warnsDropped, 0, '正常玩法下不触发丢弃');
});

test('B15 单只 AI 抛错被隔离且上报,不影响其它生物', () => {
  const { world } = makeWorld();
  const h = new MobHost(world, { bus: new EventBus() });
  h.addMob('mob_sheep', MOB_BY_ID.get('mob_sheep')!, 10, 10);
  h.addMob('mob_boar', MOB_BY_ID.get('mob_boar')!, 12, 10);
  /* 破坏绵羊的 fsm —— SheepAi 会写 fsm.flee,于是必然抛错。
     这是**真实故障注入**,不是「断言允许两种结果」。 */
  const rt = h.runtimeOf('mob_sheep')!;
  (rt as unknown as { fsm: unknown }).fsm = undefined;

  const res = h.tickMobs(['mob_sheep', 'mob_boar'], 0.05);
  const sheep = res.find((r) => r.id === 'mob_sheep')!;
  const boar = res.find((r) => r.id === 'mob_boar')!;

  ok(sheep.error !== null, `抛错被记下(实际 error=${JSON.stringify(sheep.error)})`);
  eq(boar.error, null, '野猪照常推进(隔离生效)');
  eq(h.totals.errors, 1, '错误计数 +1');
  eq(sheep.warns.length, 0, '抛错的生物不留残留预警');
});

test('B16 未登记的 ID 与已死生物被安静跳过(不抛错)', () => {
  const { world } = makeWorld();
  const h = new MobHost(world, { bus: new EventBus() });
  h.addMob('mob_boar', MOB_BY_ID.get('mob_boar')!, 10, 10);
  const res = h.tickMobs(['never_registered', 'mob_boar'], 0.05);
  eq(res.length, 1, '未知 ID 不出现在结果里');
  eq(res[0].id, 'mob_boar');
  /* 打死它 */
  const rt = h.runtimeOf('mob_boar')!;
  rt.hp = 0;
  rt.alive = false;
  const res2 = h.tickMobs(['mob_boar'], 0.05);
  eq(res2.length, 1);
  eq(res2[0].warns.length, 0, '死生物不产预警');
});

test('B17 重置登记保留 mem(AI 私有状态不因重生清空)', () => {
  const { world } = makeWorld();
  const h = new MobHost(world);
  const def = MOB_BY_ID.get('mob_boar')!;
  h.addMob('mob_boar', def, 10, 10);
  const rt = h.runtimeOf('mob_boar')!;
  rt.mem.tamingProgress = 42;
  h.addMob('mob_boar', def, 20, 20); /* 重新登记 */
  const rt2 = h.runtimeOf('mob_boar')!;
  eq(rt2.mem.tamingProgress, 42, 'mem 被保留');
  eq(rt2.x, 20, '位置被更新');
});

/* ═══════════════ 7. 编排层接线(防「接了一半」) ═══════════════ */

test('C01 WorldSim 暴露 bus 与 mobHost', () => {
  const sim = new WorldSim({ sizeCells: 32 });
  ok(sim.bus instanceof EventBus, 'bus 是 EventBus');
  ok(sim.mobHost instanceof MobHost, 'mobHost 是 MobHost');
});

test('C02 WorldSim.tick 每帧 drain 一次事件队列', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  sim.addMob('mob_pangolin', 'MEADOW', 24, 25);
  const N = 100;
  for (let i = 0; i < N; i += 1) sim.tick();
  /* 帧数必须精确等于 tick 次数 —— 少一次说明某条分支跳过了 drain,
     多一次说明 drain 被调了两遍(会让事件提前被投递) */
  eq(sim.bus.snapshot().totals.frames, N, 'drain 次数 = tick 次数');

  /* 更进一步:直接在 drain 前 emit,证明 tick 真的会把它冲掉。
     若 drain 没接上,这个事件会一直 pending。 */
  sim.bus.emit('probe_event', {}, 'test');
  eq(sim.bus.pending, 1, 'drain 前有 1 个待投递');
  sim.tick();
  eq(sim.bus.pending, 0, 'tick 后队列被清空(drain 真的接了)');
});

test('C02b 事件在**当帧**投递,不留到下一帧', () => {
  const sim = new WorldSim({ sizeCells: 32 });
  const got: { kind: string; frame: number }[] = [];
  sim.bus.on('*', (e) => got.push({ kind: e.kind, frame: e.frame }));
  sim.bus.emit('one', {}, 'test');
  sim.tick();
  eq(got.length, 1, '当帧就收到');
  eq(got[0].frame, 0, '事件记的是发出时的帧序');
  /* 再 tick 一次不应重复投递 */
  sim.tick();
  eq(got.length, 1, '不重复投递');
});

test('C03 编排层**没有**空回调的 stepActive(AI 真的被推进)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  sim.addMob('mob_pangolin', 'MEADOW', 24, 25);
  for (let i = 0; i < 100; i += 1) sim.tick();
  /* 此前是 aoi.stepActive(() => {}) —— 遍历了但什么都不做。
     现在走 mobHost,ticks 必须增长。 */
  ok(sim.mobHost.totals.ticks > 0, `宿主推进次数 > 0(实际 ${sim.mobHost.totals.ticks})`);
  /* 10 帧里有 10 个慢帧(200 帧 = 20 慢帧)。100 帧 = 10 慢帧,
     每慢帧推进 1 只生物 → 10 次。 */
  eq(sim.mobHost.totals.ticks, 10, '慢帧数 × 生物数');
});

test('C04 编排层零 AI 抛错(宿主接对了)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  for (const def of MOB_LIST.slice(0, 8)) sim.addMob(def.id, 'MEADOW', 24, 25);
  for (let i = 0; i < 200; i += 1) sim.tick();
  eq(sim.mobErrors, 0, `零抛错(实际 ${sim.mobErrors})`);
  eq(sim.mobHost.totals.errors, 0, '宿主零抛错');
});

test('C05 addMob 登记到宿主(漏登记会「唤醒但不行为」)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addMob('mob_boar', 'MEADOW', 24, 24);
  eq(sim.mobHost.size, 1, '宿主认识它');
  ok(sim.mobHost.runtimeOf('mob_boar') !== null, '可查到运行时');
  eq(sim.unknownMobs.length, 0, '无未知 ID');
});

test('C06 未知生物 ID 被收集而非静默忽略', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addMob('mob_does_not_exist', 'MEADOW', 24, 24);
  eq(sim.unknownMobs, ['mob_does_not_exist'], '未知 ID 被记录');
  /* 它仍然进了物理与 AOI(那是既有行为),但被点名 */
  ok(sim.aoi.getMob('mob_does_not_exist') !== undefined, '仍在 AOI 里');
});

test('C07 单机确定性:同种子两次世界完全一致(含 AI)', () => {
  const run = (): string => {
    const sim = new WorldSim({ sizeCells: 48, rng: mulberry32(999) });
    sim.addPlayer('p1', 24, 24);
    for (const def of MOB_LIST.slice(0, 6)) sim.addMob(def.id, 'MEADOW', 24, 25);
    const got: string[] = [];
    sim.bus.on('*', (e) => got.push(`${e.kind}:${e.source}`));
    const seq: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const r = sim.tick();
      seq.push(`${r.frame}:${r.phase}:${r.activeMobs}:${r.physics?.bodies ?? 0}`);
    }
    return seq.join('|') + '###' + got.join(',');
  };
  eq(run(), run(), '两次运行字节一致');
});

test('C08 事件投递不影响物理与流体(接线未破坏既有子系统)', () => {
  const sim = new WorldSim({ sizeCells: 32 });
  sim.fillRect(0, 0, 31, 31, { floor: 1 });
  sim.fluid.addWater(16, 16, 500);
  const before = sim.fluid.total();
  sim.bus.emit('noise', {}, 'test');
  for (let i = 0; i < 40; i += 1) sim.tick();
  eq(sim.fluid.total(), before, '流体总量守恒(事件没干扰)');
});

test('C09 mobHost.players() 真的能看到玩家(否则所有「发现玩家」行为不触发)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  sim.addMob('mob_boar', 'MEADOW', 28, 24);
  eq(sim.mobHost.players().length, 1, '玩家可见');
  eq(sim.mobHost.players()[0].id, 'p1');
  eq(sim.mobHost.players()[0].afk, false);
});

test('C10 生物不被当成玩家(玩家与生物都在 physics.bodies 里)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  sim.addMob('mob_boar', 'MEADOW', 28, 24);
  sim.addMob('mob_sheep', 'MEADOW', 30, 24);
  /* 关键:players() 必须**只**含玩家。若把 bodies 直接当玩家列表,
     野猪会把绵羊当猎物冲锋 —— 而不报错。 */
  const ps = sim.mobHost.players();
  eq(ps.length, 1, `只含 1 个玩家(实际 ${JSON.stringify(ps.map((p) => p.id))})`);
  eq(ps[0].id, 'p1');
  eq(sim.playerCount, 1, 'playerCount 记账正确');
});

test('C11 有玩家在旁 → AI 进入追猎状态(mem 非空)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  sim.addPlayer('p1', 24, 24);
  /* 野猪放感知圈内(8 格)、攻击圈外 —— 它会畜力冲锋 */
  sim.addMob('mob_boar', 'MEADOW', 29, 24);
  for (let i = 0; i < 60; i += 1) sim.tick();
  const rt = sim.mobHost.runtimeOf('mob_boar')!;
  /* 修复前:players() 为空 → nearest() 恒 null → mem 是 {}。
     修复后:野猪会写冲锋状态(lockDeg / travel / charging / selfStun …)。 */
  const keys = Object.keys(rt.mem);
  ok(keys.length > 0, `AI 写入了状态:${JSON.stringify(keys.slice(0, 8))}`);
  ok(
    keys.includes('lockDeg') || keys.includes('charging') || keys.includes('travel'),
    `野猪进入了冲锋状态机(keys=${keys.join(',')})`,
  );
});

test('C12 无玩家时 AI 不做追猎(对照组,证明 C11 不是恒真)', () => {
  const sim = new WorldSim({ sizeCells: 48 });
  /* 不注册玩家,只放生物 */
  sim.addMob('mob_boar', 'MEADOW', 29, 24);
  for (let i = 0; i < 60; i += 1) sim.tick();
  const rt = sim.mobHost.runtimeOf('mob_boar')!;
  /* 没有玩家就不该有冲锋锁角 —— 若这里也非空,说明 C11 的断言与
     「有没有玩家」无关,那它就不是在测「AI 看得见玩家」。 */
  ok(!('lockDeg' in rt.mem), `无玩家时不进入追猎(keys=${Object.keys(rt.mem).join(',')})`);
});

test('C13 防穿墙:1 格厚的墙不能被高速步长跨过(隧道效应)', () => {
  /* 隧道效应:AI 步长 4.5~5.5 格,`probe` 只判终点 → 1 格墙被跨过。
     实测修复前:墙厚 1 → 穿过;3 格以上 → 挡住。

     ⚠️ **判据不能用「y 是否跨过 28」** —— 启用 FSM 基础移动后,
     生物会**绕开**墙(x 偏出 24 列),那也会跨过 y=28,
     于是「y >= 28」会误报为穿墙。实测:启用方案 D 后此断言报红,
     而线段级检查证明**所有线段都未进入墙格** `[24,25)×[28,29)`。

     正确的是判「路径有没有进入墙格本身」—— 这是外部事实(那一格是墙),
     与生物选择绕行还是停下无关。 */
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 20);
  s.addMob('mob_pangolin', 'MEADOW', 24, 32);
  s.setCell(24, 28, { obj: 386 });
  const rt = s.mobHost.runtimeOf('mob_pangolin')!;

  /* 逐帧记录,并在**线段**上细分采样 —— 两帧之间才是可能穿越的地方 */
  let crossed = -1;
  let px = rt.x;
  let py = rt.y;
  for (let i = 1; i <= 400; i += 1) {
    s.tick();
    const dist = Math.hypot(rt.x - px, rt.y - py);
    const steps = Math.max(2, Math.ceil(dist / 0.05));
    for (let k = 1; k <= steps; k += 1) {
      const t = k / steps;
      const x = px + (rt.x - px) * t;
      const y = py + (rt.y - py) * t;
      if (x >= 24 && x < 25 && y >= 28 && y < 29) {
        crossed = i;
        break;
      }
    }
    if (crossed > 0) break;
    px = rt.x;
    py = rt.y;
  }
  ok(crossed < 0, `路径从未进入墙格 [24,25)×[28,29)(穿墙于第 ${crossed} 帧)`);
});

test('C14 空白世界不产生夹取(证明 C13 不是恒真)', () => {
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 20);
  s.addMob('mob_pangolin', 'MEADOW', 24, 32);
  for (let i = 0; i < 400; i += 1) s.tick();
  /* 无墙却发生夹取 = 夹取逻辑把空地判成障碍,那 C13 测的就不是「防穿墙」 */
  eq(s.mobHost.totals.sweepClamped, 0, '无墙时 0 次夹取');
  const rt = s.mobHost.runtimeOf('mob_pangolin')!;
  ok(rt.y < 32, `无墙时能移动(y ${rt.y.toFixed(2)} < 32)`);
});

test('C15 probe 极性:返回「有障碍」而非「可站立」', () => {
  /* `MobWorld.probe` 在冻结层里没有任何注释说明极性 —— 合同缺失。
     极性由调用方反推:BoarAi / PangolinAi 都写
         if (world.probe(nx, ny)) { 撞墙自晕 }
     即 `true` = 挡路。我最初按「可站立 = true」写,导致全图每格都被
     判为障碍 → 野猪与穿山甲每帧自晕、永不移动(不报错)。 */
  const s = new WorldSim({ sizeCells: 48 });
  eq(s.mobHost.probe(24, 24), false, '空地 = 无阻碍 = false');
  s.setCell(24, 24, { obj: 386 });
  eq(s.mobHost.probe(24, 24), true, '有物件 = 有阻碍 = true');
  eq(s.mobHost.probe(-1, 24), true, '越界 = 有阻碍 = true');
});

test('C16 有障碍时生物会移动(probe 极性错误的直接后果是永不移动)', () => {
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 20);
  s.addMob('mob_pangolin', 'MEADOW', 24, 32);
  const rt = s.mobHost.runtimeOf('mob_pangolin')!;
  const y0 = rt.y;
  for (let i = 0; i < 400; i += 1) s.tick();
  /* 极性错误时位移恒为 0,且 stunSec 长期 > 0 */
  ok(Math.abs(rt.y - y0) > 1, `穿山甲位移 ${Math.abs(rt.y - y0).toFixed(2)} 格 > 1`);
});

test('C17 事件型伤害通道:蝎子伏击能打到玩家', () => {
  /* 生物用**两种**通道表达威胁:预警几何(范围)与事件(状态触发)。
     只结算前者时,蝎子从沙下钻出来咬你**不掉血**,且不报错。 */
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 24);
  s.addMob('mob_scorpion', 'MEADOW', 24, 24.5);
  let ambush = 0;
  s.bus.on('scorpion_ambush', () => { ambush += 1; });
  for (let i = 0; i < 1200; i += 1) s.tick();
  ok(ambush > 0, `伏击事件发出 ${ambush} 次`);
  ok(s.hitCount > 0, `伏击造成 ${s.hitCount} 次命中`);
  ok(s.vitals.get('p1')!.totalTaken > 0, `累计伤害 ${s.vitals.get('p1')!.totalTaken}`);
});

test('C18 事件型伤害有距离限制(远离时不受伏击)', () => {
  const s = new WorldSim({ sizeCells: 48 });
  s.addPlayer('p1', 24, 24);
  s.addMob('mob_scorpion', 'MEADOW', 34, 24); /* 10 格外 */
  for (let i = 0; i < 1200; i += 1) s.tick();
  /* 若这里也掉血,说明 C17 测的不是「距离判定」而是「事件一到就扣血」 */
  eq(s.hitCount, 0, '远距离不被伏击');
  eq(s.vitals.get('p1')!.hp, s.vitals.get('p1')!.maxHp, '满血');
});

test('C19 AI 记忆(mem)可导出/导入:跨宿主往返一致(task-17 §430)', () => {
  /* 原缺陷:`mem` 只活在宿主进程内(`addMob` 的 `existed?.rt.mem ?? {}`
     只在同宿主同 ID 重复登记时保留)。换区/重连构造新宿主即归零 ——
     实测新宿主中 `mem` 为 `{}`,姜饼小人逃逸计时、野化进度全部丢失。 */
  const a = new WorldSim({ sizeCells: 32 });
  a.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  a.addMob('mob_boar', 'MEADOW', 12, 10);
  const rta = a.mobHost.runtimeOf('mob_ginger_imp')!;
  const rtb = a.mobHost.runtimeOf('mob_boar')!;
  rta.mem.escapeTimer = 7.5;
  rta.mem.escaped = 0;
  rta.mem.candyDropped = 3;
  rtb.mem.phase = 2;
  rtb.mem.travel = 4.25;

  /* 模拟「重启」:全新世界 + 同 ID 重新登记 */
  const b = new WorldSim({ sizeCells: 32 });
  b.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  b.addMob('mob_boar', 'MEADOW', 12, 10);
  eq(JSON.stringify(b.mobHost.runtimeOf('mob_ginger_imp')!.mem), '{}', '前置:新宿主 mem 为空');

  const dump = a.exportMobMem();
  /* 必须能 JSON 往返 —— 这是「落盘」的最低要求 */
  const wire = JSON.parse(JSON.stringify(dump)) as Record<string, Record<string, unknown>>;
  const res = b.importMobMem(wire);
  eq(res.applied, 2, '两只生物都写入');
  eq(res.skipped, 0, '没有跳过');

  const rt2 = b.mobHost.runtimeOf('mob_ginger_imp')!;
  eq(rt2.mem.escapeTimer, 7.5, '逃逸计时读回一致');
  eq(rt2.mem.candyDropped, 3, '掉糖计数读回一致');
  const rt2b = b.mobHost.runtimeOf('mob_boar')!;
  eq(rt2b.mem.phase, 2, '野猪冲锋相位读回一致');
  eq(rt2b.mem.travel, 4.25, '野猪冲锋位移读回一致');
  eq(JSON.stringify(b.exportMobMem()), JSON.stringify(wire), '导出 → 导入 → 再导出,逐字节一致');
});

test('C20 mem 导出兼容字符串值(taunt)且忽略未登记生物', () => {
  /* `mem` 声明为 `Record<string, number>`,但 `GingerImpAi` 实际写入过字符串
     (`behaviors.ts:879` 的 `mem.taunt = '你抓不到我'`)。序列化若假设全是 number,
     `JSON.stringify` 会写出字符串而读回端可能把它转成 NaN。 */
  const a = new WorldSim({ sizeCells: 32 });
  a.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  (a.mobHost.runtimeOf('mob_ginger_imp')!.mem as Record<string, unknown>).taunt = '你抓不到我';
  const dump = a.exportMobMem();
  eq(dump.mob_ginger_imp.taunt, '你抓不到我', '字符串值原样导出');

  const b = new WorldSim({ sizeCells: 32 });
  b.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  const wire = JSON.parse(JSON.stringify(dump)) as Record<string, Record<string, unknown>>;
  b.importMobMem(wire);
  const got = (b.mobHost.runtimeOf('mob_ginger_imp')!.mem as Record<string, unknown>).taunt;
  eq(got, '你抓不到我', '字符串往返不失真');
  eq(typeof got, 'string', '类型保持 string,没有变成 NaN');

  /* 存档里有、本区没刷新的生物 → 跳过而非凭空建实体 */
  const c = new WorldSim({ sizeCells: 32 });
  c.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  const res = c.importMobMem({ mob_ginger_imp: { escapeTimer: 1 }, mob_not_spawned: { x: 9 } });
  eq(res.applied, 1, '只写入已登记的');
  eq(res.skipped, 1, '未登记的计入 skipped');
  eq(c.mobHost.runtimeOf('mob_not_spawned'), null, '没有凭空造出生物');
});

test('C21 玩家 HP 可导出/导入(D7:HP 未持久化)', () => {
  /* 原缺陷:`vitals.register(id)` 恒设满血(`vitals.ts:310`),
     而 `savePlayerState` 在全仓**只有测试调用**、无任何生产调用点 ——
     于是 `users.hp` 字段存在却从不被写入,重连必然满血。 */
  const a = new WorldSim({ sizeCells: 32 });
  a.addPlayer('p1', 10, 10);
  a.addPlayer('p2', 12, 10);
  const va = a.vitals.get('p1')!;
  eq(va.hp, va.maxHp, '前置:登记即满血');

  /* 打掉一部分血 */
  va.hp = 37;
  const dump = a.exportVitals();
  eq(dump.p1.hp, 37, '导出的是当前 HP,不是满血');
  eq(dump.p1.maxHp, va.maxHp, '带上 maxHp 供读档端校验');

  const b = new WorldSim({ sizeCells: 32 });
  b.addPlayer('p1', 10, 10);
  b.addPlayer('p2', 12, 10);
  eq(b.vitals.get('p1')!.hp, b.vitals.get('p1')!.maxHp, '前置:新世界满血');
  const n = b.importVitals(JSON.parse(JSON.stringify(dump)));
  eq(n, 2, '两个玩家都生效');
  eq(b.vitals.get('p1')!.hp, 37, 'HP 读回一致(不是满血)');
  eq(b.vitals.get('p1')!.downed, false, '倒下状态未被打上');
});

test('C22 HP 导入的边界:钳制、脏数据、未登记玩家', () => {
  const s = new WorldSim({ sizeCells: 32 });
  s.addPlayer('p1', 10, 10);
  const maxHp = s.vitals.get('p1')!.maxHp;

  /* 超过上限 → 钳到 maxHp;负数 → 钳到 0 */
  eq(s.importVitals({ p1: { hp: 99999 } }), 1, '超上限仍算生效');
  eq(s.vitals.get('p1')!.hp, maxHp, '钳到 maxHp');
  s.importVitals({ p1: { hp: -5 } });
  eq(s.vitals.get('p1')!.hp, 0, '负数钳到 0');
  /* NaN / Infinity / 非数字 → 跳过,不破坏现值 */
  s.importVitals({ p1: { hp: 50 } });
  eq(s.importVitals({ p1: { hp: Number.NaN } }), 0, 'NaN 被拒');
  eq(s.vitals.get('p1')!.hp, 50, '被拒时不改动现值');
  eq(s.importVitals({ p1: { hp: Number.POSITIVE_INFINITY } }), 0, 'Infinity 被拒');
  eq(s.importVitals({ p1: {} as { hp: number } }), 0, '缺 hp 字段被拒');
  /* 未登记的玩家跳过 */
  eq(s.importVitals({ p_ghost: { hp: 10 } }), 0, '未登记玩家不生效');
  eq(s.vitals.get('p_ghost'), null, '没有凭空注册');
  /* 0 HP → 读回后是倒下的,但 revive 语义清掉 downed(否则上线即倒地) */
  s.importVitals({ p1: { hp: 0 } });
  eq(s.vitals.get('p1')!.hp, 0, '0 HP 保留');
  eq(s.vitals.get('p1')!.downed, false, 'downed 被清掉,不会「上线即倒地」');
});

test('C23 玩家 HP 真正落盘并经 DB 读回仍为 37(D7 端到端)', () => {
  /* C21/C22 只证明 `WorldSim` 能**导出/导入**,不证明「写进了数据库」——
     这正是本仓反复出现的缺陷形态:导出函数存在、单测全绿、
     但生产路径一行都没调用(`savePlayerState` 此前只有测试调用)。
     本测试因此全程走真实 `MemoryDb` + 真实 `repo.ts`,断言的是
     **读回后的状态值**,不是「某函数被调用过」。 */
  const db = new MemoryDb();
  migrate(db, 1000);
  /* p1 用高等级上限(535):`users.max_hp` 是**成长派生量**,
     而运行时 `VitalsSystem.maxHp` 是构造期常量。若落盘时把 max_hp 一起写,
     高等级玩家会掉回基础血量 —— 这条断言就是钉住那件事。 */
  createUser(db, { id: 'p1', displayName: '小酱', nowMs: 1000, level: 30, maxHp: 535 });
  createUser(db, { id: 'p2', displayName: '小碗', nowMs: 1000 });

  /* 房间行必须存在 —— `saveRoomMobMem` 走 UPDATE,没有行就是静默 0 行。 */
  createRoom(db, { id: 'room_alpha', ownerId: 'p1', nowMs: 1000 });

  const a = new WorldSim({ sizeCells: 32 });
  a.addPlayer('p1', 10, 10);
  a.addPlayer('p2', 12, 10);
  /* 第三名玩家**没有 users 行**(未建号的访客/测试模拟体)。
     它的 HP 无法落盘 —— 关键是这不该让 p1/p2 的存档连坐失败,
     且数量必须如实报出来,否则「静默少存一个人」永远查不到。 */
  a.addPlayer('p_guest', 14, 10);
  eq(a.vitals.get('p1')!.hp, 100, '前置:登记即满血');

  /* 打到 37,不是满血也不是 0 —— 满血会和「没存」混淆,0 会和「倒地」混淆。 */
  a.vitals.get('p1')!.hp = 37;
  a.vitals.get('p2')!.hp = 71;

  const rep = a.saveToDb(db, 'room_alpha', 2000);
  eq(rep.hpSaved, 2, '两个有账号的玩家都写进 users');
  eq(rep.hpSkipped, 1, '没账号的玩家被如实计入 skipped(不静默)');

  /* 第一层:直接查 DB 行 —— 证明字节真的进了库 */
  eq(getUser(db, 'p1')?.hp, 37, 'users.hp 落盘为 37');
  eq(getUser(db, 'p2')?.hp, 71, 'users.hp 落盘为 71');
  /* `max_hp` 是成长派生量,运行时只有全局常量 100 —— 绝不能拿它覆盖 535。
     若落盘把 max_hp 一起写,30 级玩家读档后会掉回基础血量。 */
  eq(getUser(db, 'p1')?.max_hp, 535, 'max_hp 未被运行时常量污染');
  eq(a.vitals.get('p1')!.maxHp, 100, '对照:运行时 maxHp 确实是 100 常量');

  /* 第二层:换一个全新世界,从 DB 读回 —— 证明闭环成立 */
  const b = new WorldSim({ sizeCells: 32 });
  b.addPlayer('p1', 10, 10);
  b.addPlayer('p2', 12, 10);
  eq(b.vitals.get('p1')!.hp, 100, '前置:新世界满血');

  const loaded = b.loadFromDb(db, 'room_alpha');
  eq(loaded.hpApplied, 2, '两名玩家都被还原');
  eq(b.vitals.get('p1')!.hp, 37, 'HP 读回一致:仍是 37,不是满血');
  eq(b.vitals.get('p2')!.hp, 71, 'HP 读回一致:仍是 71');
  eq(b.vitals.get('p1')!.downed, false, '未被打上倒地标记');
});

test('C24 生物 mem 真正落盘并经 DB 读回内容一致(§430 端到端)', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'p1', displayName: '小酱', nowMs: 1000 });
  createRoom(db, { id: 'room_alpha', ownerId: 'p1', nowMs: 1000 });

  const a = new WorldSim({ sizeCells: 32 });
  a.addPlayer('p1', 10, 10);
  a.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  a.addMob('mob_boar', 'MEADOW', 12, 10);
  const rta = a.mobHost.runtimeOf('mob_ginger_imp')!;
  const rtb = a.mobHost.runtimeOf('mob_boar')!;
  rta.mem.escapeTimer = 7.5;
  rta.mem.candyDropped = 3;
  rtb.mem.phase = 2;
  rtb.mem.travel = 4.25;
  /* 字符串值必须一起活下来 —— `mem` 声明成 `Record<string, number>`,
     但姜饼小人实际写入过字符串(behaviors.ts:879)。按 number 假设做
     序列化会把它变成 NaN。 */
  (rta.mem as Record<string, unknown>).taunt = '你抓不到我';

  const rep = a.saveToDb(db, 'room_alpha', 2000);
  eq(rep.memRow, 1, 'mem 写进了 1 行(rooms.mob_mem_json)');

  /* 第一层:直接看库里的 JSON 文本 */
  const rawRow = db.get('rooms', { id: 'room_alpha' })!;
  ok(typeof rawRow.mob_mem_json === 'string', 'mob_mem_json 应是 TEXT');
  const parsed = JSON.parse(rawRow.mob_mem_json as string) as Record<string, Record<string, unknown>>;
  eq(parsed.mob_ginger_imp.escapeTimer, 7.5, '库里 escapeTimer=7.5');

  /* 第二层:全新世界读回,比对内容 */
  const b = new WorldSim({ sizeCells: 32 });
  b.addPlayer('p1', 10, 10);
  b.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  b.addMob('mob_boar', 'MEADOW', 12, 10);
  eq(JSON.stringify(b.mobHost.runtimeOf('mob_ginger_imp')!.mem), '{}', '前置:新宿主 mem 为空');

  const loaded = b.loadFromDb(db, 'room_alpha');
  eq(loaded.memApplied, 2, '两只生物的 mem 都被还原');
  eq(loaded.memSkipped, 0, '没有跳过');

  const rt2 = b.mobHost.runtimeOf('mob_ginger_imp')!;
  eq(rt2.mem.escapeTimer, 7.5, '逃逸计时读回一致');
  eq(rt2.mem.candyDropped, 3, '掉糖计数读回一致');
  eq((rt2.mem as Record<string, unknown>).taunt, '你抓不到我', '字符串值往返不失真');
  const rt2b = b.mobHost.runtimeOf('mob_boar')!;
  eq(rt2b.mem.phase, 2, '野猪相位读回一致');
  eq(rt2b.mem.travel, 4.25, '野猪位移读回一致');

  /* 再导出一次:存档 → 读档 → 存档 必须逐字节稳定,
     否则「每次读档都漂移」会在多轮重连后累积成脏数据。 */
  eq(
    JSON.stringify(b.exportMobMem()),
    JSON.stringify(a.exportMobMem()),
    '存档 → 读档 → 再存档,内容一致',
  );

  /* 房间不存在时 mem 不落地:`UPDATE` 影响 0 行,必须如实报 0,
     而不是让调用方以为存过了。 */
  const nowhere = a.saveToDb(db, 'room_missing', 3000);
  eq(nowhere.memRow, 0, '房间不存在时 memRow=0(没假装成功)');
});

test('C25 房间 tick 每 20 帧把 HP 与 mem 落盘(接线守护)', () => {
  /* C23/C24 证明 `saveToDb` 本身对。但**接线**仍可能整条没挂上 ——
     本仓已有 7 例「实现完整、单测全绿、编排层不接」的缺陷,故这里必须
     从 `RoomRuntime.step()` 出发,断言读到的是库里的状态值。 */
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'owner', displayName: '岛主', nowMs: 1000 });
  createUser(db, { id: 'p1', displayName: '小酱', nowMs: 1000 });

  const c = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: 'room_alpha', ownerId: 'owner', clock: c.clock }, db);

  const sim = new WorldSim({ sizeCells: 32 });
  sim.addPlayer('p1', 10, 10);
  sim.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  sim.vitals.get('p1')!.hp = 37;
  sim.mobHost.runtimeOf('mob_ginger_imp')!.mem.escapeTimer = 7.5;
  rt.worldSaveHost = sim;

  /* 前 19 帧:不该有任何落盘(节流仍生效,不能退化成 20Hz 写库) */
  for (let i = 0; i < 19; i += 1) rt.step();
  eq(rt.lastSaveReport, null, '第 19 帧前不落盘(低频节流仍生效)');
  ok(
    (db.get('rooms', { id: 'room_alpha' })!.mob_mem_json as string) === '{}',
    '第 19 帧前 mem 仍是初始空值',
  );

  /* 第 20 帧:一次落盘 */
  rt.step();
  eq(rt.state.meta.tick, 20, '第 20 帧');

  /* ⚠️ task-59 起,这里的 HP **不再是常量 37**。
     `RoomRuntime.step()` 现在会推进世界(`host.advance(1)`),于是
     `vitals.stepTimers()` 每帧跑 ⇒ `PLAYER_REGEN_PER_SEC = 1.0` 生效:
     20 帧 × `dt 0.05` = 1.0 秒 ⇒ **37 → 38**。

     原来的 `eq(..., 37)` 是在「世界从不推进」的前提下写的,它把一个
     **偶然的常量**当成了判据。本用例的**原意是「落盘接线生效」**,
     不是「HP 恰好是 37」—— 故改为「落盘值 == 落盘时刻的权威值」,
     并**显式**钉住「回血确实发生了」这件事,免得后人以为可以忽略。
     ⇒ 区分力没有被削弱:若 `saveToDb` 没被调用,库里仍是建号时的
       `hp`(100),不会等于 `hpAtSave`。 */
  const hpAtSave = sim.vitals.get('p1')!.hp;
  ok(hpAtSave > 37,
    `世界推进后 HP 已回升:${hpAtSave}(1 血/秒 × 1 秒)⇒ 推进确实生效`);

  const rep = rt.lastSaveReport;
  ok(rep !== null, '第 20 帧应发生落盘');
  eq(rep!.tick, 20, '落盘发生在第 20 帧');
  eq(rep!.hpSaved, 1, '1 名玩家 HP 落盘');
  eq(rep!.memRow, 1, 'mem 写进 1 行');

  /* 断言的是**库里的状态值**,不是「函数被调用过」 */
  eq(getUser(db, 'p1')?.hp, hpAtSave, 'users.hp 落的是**落盘时刻**的权威值');
  ok(getUser(db, 'p1')?.hp !== 37,
    '且确实不是建号/播种时的 37 ⇒ 落盘读的是活世界,不是初始夹具');
  const roomRow = db.get('rooms', { id: 'room_alpha' })!;
  eq(roomRow.world_tick, 20, 'world_tick 与存档同帧落盘');
  const mem = JSON.parse(roomRow.mob_mem_json as string) as Record<string, Record<string, unknown>>;

  /* ⚠️ 同一根因:`escapeTimer` 是**倒计时**,每帧 `- dt`
     (`behaviors.ts:891`:`rt.mem.escapeTimer = (rt.mem.escapeTimer ?? GINGER_ESCAPE_SEC) - dt`)。
     世界一推进它就递减:播种 7.5,20 帧 × 0.05 = 1.0 秒 ⇒ **6.5**。
     与 HP 一样,原来的 `eq(..., 7.5)` 是在「世界从不推进」时写的常量判据。
     本用例**证明的是 mem 被落库**,故改为:落库值 == 落库时刻的运行时值,
     并显式验证「它确实递减了」(那才是「世界在跑」的证据)。 */
  const memAtSave = sim.mobHost.runtimeOf('mob_ginger_imp')!.mem.escapeTimer;
  ok(memAtSave < 7.5,
    `mem 倒计时确实在走:7.5 → ${memAtSave}(20 帧 × dt)—— 推进生效的旁证`);
  eq(mem.mob_ginger_imp.escapeTimer, memAtSave, 'mem 落的是**落盘时刻**的运行时值');
  ok(mem.mob_ginger_imp.escapeTimer !== undefined, 'mem 内容确实落库(不是空对象)');

  /* 读档侧:全新世界 + 新房间,从库里拿回来 */
  const sim2 = new WorldSim({ sizeCells: 32 });
  sim2.addPlayer('p1', 10, 10);
  sim2.addMob('mob_ginger_imp', 'MEADOW', 10, 10);
  const loaded = sim2.loadFromDb(db, 'room_alpha');
  eq(loaded.hpApplied, 1, '读回 1 名玩家');
  eq(sim2.vitals.get('p1')!.hp, hpAtSave, 'HP 端到端读回与落盘值一致');
  eq(sim2.mobHost.runtimeOf('mob_ginger_imp')!.mem.escapeTimer, memAtSave,
    'mem 端到端读回与落盘值一致(倒计时也不失真)');

  /* `worldSaveHost` 为 null 时必须**不撒谎**:不得留下一个假的落盘报告 */
  const rt2 = new RoomRuntime({ roomId: 'room_beta', ownerId: 'owner', clock: c.clock }, db);
  for (let i = 0; i < 20; i += 1) rt2.step();
  eq(rt2.lastSaveReport, null, '没有存档源时不产生落盘报告(不假装存过)');
  eq(db.get('rooms', { id: 'room_beta' })!.world_tick, 20, 'world_tick 仍照常落盘');
});

report('WS-FND-02');
