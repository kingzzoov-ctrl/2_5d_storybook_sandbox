/**
 * WS-FND-11 —— **打盹(afk)跨层接通**断言(task-74)。
 *
 * ## 这个套件为什么存在
 *
 * 本仓第 101 条陷阱:`WorldSim` 里 `afk` 字段的**三个生产者全写死 `false`**
 * ⇒ `afk` 恒 false ⇒ 三条玩法规则**静默失效**:
 * ```
 * mobs/aoi.ts:62                 if (p.afk) continue;   打盹者仍提供 AOI 唤醒能量
 * mobs/behaviors.ts:196          if (p.afk) continue;   生物仍追打打盹者
 * combat/progression.ts:326/350  afkMul                 打盹者仍全额分经验(手册 §4.1:0.3)
 * ```
 * **而它们各自的单元测试都是绿的** —— 因为那些测试自己造夹具
 * (`aoi.setPlayers([{afk:true}])`),测的是「给它 true 会跳过」,
 * **从来没人测「true 从哪来」**。
 *
 * ## 它和既有套件的形态差别(本文件唯一的价值)
 *
 * `tests/WS-04.test.ts` 用 `setPlayers([{afk:true}])` 验证「这个函数认得 afk」。
 * 命题是:
 *
 *     「仓库里的 afk 通路能不能工作」          ← 已被覆盖
 *
 * 本套件的命题是不同的另一句:
 *
 *     「生产里**真值被接上了**没有」            ← 此前零覆盖
 *
 * ⇒ 所以本文件里**不允许出现** `sim.setPlayerAfk(...)` 直接调用来伪造通路,
 *   一切运行时都必须由 `server/src/index.ts` 的 `assemble()` 产出,
 *   且打盹由**房间侧**的 `RoomRuntime.setAfk` 注入 —— 即生产用的那条路径。
 *   若有一天 `assemble()` 不再装 host,或 `setAfk` 不再推送,下面的断言会红。
 *
 * ## ⚠️ 两侧都要断(只断一侧会被「直写 state」骗过)
 *
 * 这是 task-70 的 T3 立的纪律:只断言「房间记住了」不够 ——
 * 房间自己那份 `afkSinceMs` 恒真,与模拟层无关。
 * 只断言「模拟层跳过了」也不够 —— 直接 `setPlayerAfk` 就能造出来。
 * ⇒ 必须**同时**断「房间态」与「模拟层投影」,且注入必须从房间发起。
 *
 * ## ⚠️ 本套件**不断言**「生产里 afk 会变成 true」
 *
 * 实测:生产里**没有任何触发源**会把玩家设成打盹 ——
 * `setAfk` 生产调用点 0 处;客户端 0 处 `visibilitychange`/`blur`;
 * `room.colyseus.ts` 的 4 条 `onMessage` 里没有 afk 通道。
 * ⇒ 本套件证明的是「**通路已接通**」,不是「功能已可用」。
 *   那是**另一条欠账**(缺触发源,需客户端新消息通道),已在报告里单列。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble, createHost } from '../server/src/index.ts';
/* task-84:上面那条「连接态 vs 玩法」的判据已改为**行为判据**,
   需要一个真世界来跑「只开玩法态、看连接态是否被点亮」。 */
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { AccessMode } from '../server/src/db/repo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 固定时钟 —— 消除时间不确定性(与 WS-07 / FND-09 同一做法)。 */
const fixedClock = (t = 1_700_000_000_000): { nowMs: () => number } => ({ nowMs: () => t });

/**
 * 读一个源文件并抹掉注释,返回**代码态**文本。
 *
 * ## ⚠️ 剥行注释的正则必须带 `(^|[^:])` 前缀
 *
 * 不加前缀的话,`//` 在 **URL 里**(如 `https://…`)也会被当成注释起点 ⇒
 * 该行从那里被截断 ⇒ 后面的**真代码一起丢掉** ⇒ 源码判据静默失效。
 * 本仓把这条形态登记为判据审计的检测器 B
 * (`scripts/judgement_audit.ts` 的 `NEEDLE_LINE_COMMENT`),
 * 未登记的命中会拦门禁。
 *
 * ⇒ 抽成一个函数,既让**三处调用点只有一份实现**(它们此前各自写了一行,
 *   于是同一个缺陷要在三个地方各修一次),也把这条纪律钉在一处。
 */
function readCode(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 拿到装配产物背后的 `WorldSim`(结构化访问,不 import 模拟层类型)。
 *
 * 只用于**读**断言与喂 `addPlayer` —— **不用**来注入 afk
 * (注入必须走房间,见文件头)。
 */
type SimView = {
  addPlayer(id: string, x: number, y: number): void;
  isPlayerAfk(id: string): boolean;
  readonly afkPlayerCount: number;
  readonly aoi: { readonly activeMobs: Set<string>; update(): { woke: string[]; slept: string[] } };
  mobPlayers: { id: string; afk: boolean }[];
  playerPosition(id: string): { x: number; y: number } | null;
};

const simOf = (host: WorldSaveHost): SimView => host as unknown as SimView;

/** 让一个玩家真正存在于模拟层。 */
function materialize(host: WorldSaveHost, runtime: RoomRuntime, id: string, x = 5, y = 5): void {
  /* ⚠️ `join()` 内部**已经**调 `host.addPlayer`(room.ts 的 task-58 段),
     所以这里**不要**再手工调一次 —— 重复 spawn 会把刚体位置重置回出生点,
     是「测试自己补齐编排层该做的事」的另一副面孔。
     坐标改走房间侧认可的入口,保持与生产同源。 */
  runtime.join({ userId: id, passwordHash: null, asGuest: true });
  (host as unknown as { setPlayerPos(id: string, x: number, y: number): void })
    .setPlayerPos(id, x, y);
}

/* ═══════════ 1. 契约面:同步口必须在接口上声明(否则被结构化裁掉) ═══════════ */

test('FND11-1 WorldSaveHost 声明了 setPlayerAfk(否则被 createHost 结构性裁掉)', () => {
  /* 这条是 task-70 实测出的形态:`WorldSim` **有**而接口**没声明**的成员,
     会被 `createHost` 的返回类型标注裁掉 ⇒ 房间侧 `typeof host.setPlayerAfk`
     **在编译期恒假**(不是运行期)⇒ 「能力存在而通路缺失」。
     ⇒ 用**源码文本**断言声明存在,因为类型层的事实在运行期看不见。
     ⚠️ 读**代码态**(剥注释):声明必须真在代码里,注释里提一句不算 ——
        否则会重演「判据的口径比事实宽,注释伪装成代码」那类假绿。 */
  const src = readCode('server/src/net/room.ts');
  const iface = /export interface WorldSaveHost \{([\s\S]*?)\n\}/.exec(src);
  ok(iface !== null, 'room.ts 里应能找到 WorldSaveHost 接口');
  ok(/setPlayerAfk\?\(/.test(iface?.[1] ?? ''), 'WorldSaveHost 应声明可选方法 setPlayerAfk');

  /* 运行期对照:装配产出的 host 上它真的可调。 */
  const { host } = assemble({ roomId: 'r11a', ownerId: 'o', clock: fixedClock(), sizeCells: 16 });
  eq(typeof host.setPlayerAfk, 'function', '装配产出物上 setPlayerAfk 应是函数');
});

test('FND11-2 WorldSim 的三处 afk 生产者不再写字面量 false(源码判据)', () => {
  /* 为什么要读源码:`afk: false` 是**字面量**,一旦某处被改回去,
     只有真跑到那条支路才会暴露(settleKill 要击杀、playerById 要按 ID 取)。
     ⇒ 静态判据在这里是**必要的补充**,不是偷懒。
     同时断言残留计数为 0 —— 免得只修两处漏一处。 */
  const code = readCode('server/src/sim/world_sim.ts');
  const literal = [...code.matchAll(/\bafk\s*:\s*false\b/g)];
  eq(literal.length, 0, `world_sim.ts 不应再有 afk: false 字面量(残留 ${literal.length} 处)`);
  const truthy = [...code.matchAll(/\bafk\s*:\s*this\.afkPlayers\.has\(/g)];
  eq(truthy.length, 3, `三处生产者都应读真值(实测 ${truthy.length} 处)`);
});

/* ═══════════ 2. ★ 核心:跨层接通(只走 assemble,注入从房间发起) ═══════════ */

test('FND11-3 房间 setAfk 推送到模拟层:AOI 列表不含它,且真值可读', () => {
  const { host, runtime } = assemble({
    roomId: 'r11b', ownerId: 'o', clock: fixedClock(), sizeCells: 32,
  });
  materialize(host, runtime, 'p1');
  const sim = simOf(host);

  /* ── 基线:未打盹时它在 AOI 玩家列表里(先钉起点,防假绿) ── */
  eq(sim.isPlayerAfk('p1'), false, '基线:未打盹应为 false');
  eq(sim.afkPlayerCount, 0, '基线:打盹计数应为 0');

  /* ── 注入:从**房间侧**发起(不是 sim.setPlayerAfk) ── */
  eq(runtime.setAfk('p1', true), true, 'setAfk 对在线成员应返回 true');

  /* ── 侧 A:模拟层真值 ── */
  eq(sim.isPlayerAfk('p1'), true, '★ 房间 setAfk 后模拟层真值应为 true');
  eq(sim.afkPlayerCount, 1, '★ 打盹计数应为 1');

  /* ── 侧 B:派生投影(AOI 唤醒源)── */
  const aoiPlayers = (sim as unknown as { players: { id: string; afk: boolean }[] }).players;
  const inAoi = aoiPlayers.find((p) => p.id === 'p1');
  ok(inAoi !== undefined, '玩家应出现在 AOI 源列表里(AOI 自己过滤 afk)');
  eq(inAoi?.afk, true, '★ AOI 源列表里该玩家的 afk 应为 true');

  /* ── 侧 B':AI 视图(第二个投影,独立于 AOI)── */
  const inMob = sim.mobPlayers.find((p) => p.id === 'p1');
  ok(inMob !== undefined, '玩家应出现在生物 AI 玩家视图里');
  eq(inMob?.afk, true, '★ AI 视图里该玩家的 afk 应为 true');
});

test('FND11-4 取消打盹后两侧一起复原(不是单向粘住的)', () => {
  /* 只测「置 true」会漏掉「取消无效」—— 那会让打盹变成**不可逆**,
     表现是「回来玩了但永远只拿 30% 经验」。 */
  const { host, runtime } = assemble({
    roomId: 'r11c', ownerId: 'o', clock: fixedClock(), sizeCells: 32,
  });
  materialize(host, runtime, 'p1');
  const sim = simOf(host);

  runtime.setAfk('p1', true);
  eq(sim.isPlayerAfk('p1'), true, '置真后应为 true');
  eq(runtime.setAfk('p1', false), true, '取消打盹应返回 true');
  eq(sim.isPlayerAfk('p1'), false, '★ 取消后模拟层真值应回到 false');
  eq(sim.afkPlayerCount, 0, '★ 取消后计数应回到 0');
  eq(sim.mobPlayers.find((p) => p.id === 'p1')?.afk, false, '★ AI 视图应一并复原');
});

test('FND11-5 打盹真的改变 AOI 唤醒结论(isInsideAoi 层面,不只是字段)', () => {
  /* 前面几条断的是「字段值为 true」。这条断**行为**:
     手册 §2.4「打盹玩家不提供唤醒能量」—— 即 `isInsideAoi` 应返回 false。
     否则「字段对了但没人读」与「没接线」不可区分(那正是本仓反复的病根)。 */
  const { host, runtime } = assemble({
    roomId: 'r11d', ownerId: 'o', clock: fixedClock(), sizeCells: 32,
  });
  materialize(host, runtime, 'p1', 0, 0);
  const sim = simOf(host);

  /* 唤醒判定读的是 AOI 自己的**过滤后**列表(setPlayers 里 filter(!afk))。
     这里直接读那份列表会看不到被过滤的行 —— 故断言它的**长度差**。 */
  const before = (sim as unknown as { players: { id: string }[] }).players.length;
  runtime.setAfk('p1', true);
  const afterRaw = (sim as unknown as { players: { id: string }[] }).players;
  eq(afterRaw.length, before, '源列表长度不变(AOI 在 setPlayers 内部过滤)');
  const filtered = afterRaw.filter((p) => !(p as { afk: boolean }).afk);
  eq(filtered.length, 0, '★ 过滤后 AOI 的唤醒源应为空(打盹者不提供唤醒能量)');
});

/* ═══════════ 3. ★ 负对照:未装配 / 未接线的真实形态 ═══════════ */

test('FND11-6 负对照:不带 host 的运行时设打盹,不会崩但也有通路缺失', () => {
  /* 这一份复现「`assemble()` 存在之前」的生产形态(与 FND9-7 同构)。
     此处 `setAfk` 仍应正常更新**房间态** —— 通路缺失不该影响房间自己的语义。 */
  const rt = new RoomRuntime({
    roomId: 'room_noafk', ownerId: 'o', clock: fixedClock(), accessMode: AccessMode.PUBLIC,
  }, null);
  rt.join({ userId: 'p1', passwordHash: null, asGuest: true });
  eq(rt.worldSaveHost, null, '未装 host 的运行时该字段应为 null');

  eq(rt.setAfk('p1', true), true, '房间态的打盹仍应生效(通路缺失不影响房间语义)');
  const member = [...(rt as unknown as { members: Map<string, { afkSinceMs: number | null }> })
    .members.values()][0];
  ok(member?.afkSinceMs !== null, '★ 房间侧 afkSinceMs 应被写入(证明房间态独立成立)');
});

test('FND11-7 负对照:未登记的玩家推打盹 → 模拟层拒绝(不积累残留)', () => {
  /* 房间成员与模拟层玩家**不是同一集合**。`join()` 内部会调 `host.addPlayer`
     (room.ts 的 task-58 段,实测 join 后 `playerPosition` 由 null 变 {0.5,0.5}),
     所以「房间成员」通常同时也在世界侧。
     但**并非总是** —— 世界源没实现 `addPlayer`(可选契约)、或玩家已被
     `removePlayer` 而房间态还在时,两者就会错开。
     ⇒ 故模拟层侧的 `setPlayerAfk` 必须**自己**校验登记状态,而不是信任调用方。
     不校验的表现:`afkPlayers` 积累从未存在过的 ID,而它的消费者只有投影,
     残留**没有任何可观测后果** —— 属于最难查的一类。
     ⚠️ 本断言直接调模拟层的方法:它测的就是**模拟层自己的闸门**,
        与「通路是否接通」是两件不同的事(FND11-3 测后者)。 */
  const { host, runtime } = assemble({
    roomId: 'r11e', ownerId: 'o', clock: fixedClock(), sizeCells: 16,
  });
  /* 让房间侧真的有一个成员,但它**不进世界**:用一个世界源没登记过的 ID。
     先 `join` 一个**别的**玩家,保证房间非空(排除「房间空」这个干扰因素)。 */
  runtime.join({ userId: 'p_real', passwordHash: null, asGuest: true });
  const sim = simOf(host);

  /* 世界侧未登记 ⇒ 拒绝,且不产生残留。 */
  eq(sim.setPlayerAfk('never_registered', true), false, '★ 未登记玩家应被模拟层拒绝');
  eq(sim.afkPlayerCount, 0, '★ 计数不应被污染');

  /* 对照:登记过的玩家被接受 —— 证明上一条不是「恒返回 false」的假断言。 */
  eq(sim.setPlayerAfk('p_real', true), true, '对照:已登记玩家应被接受');
  eq(sim.afkPlayerCount, 1, '对照:接受后计数应为 1');
});

test('FND11-8 重复推同一状态是幂等的(不会每次都报变更)', () => {
  const { host, runtime } = assemble({
    roomId: 'r11f', ownerId: 'o', clock: fixedClock(), sizeCells: 16,
  });
  materialize(host, runtime, 'p1');
  const sim = simOf(host);

  eq(runtime.setAfk('p1', true), true);
  eq(sim.setPlayerAfk('p1', true), false, '重复置真应返回 false(幂等)');
  eq(sim.setPlayerAfk('p1', false), true, '置假应返回 true(真的变了)');
  eq(sim.setPlayerAfk('p1', false), false, '重复置假应返回 false');
});

test('FND11-9 离场会清掉打盹标记(重进不继承上一轮的状态)', () => {
  /* 与 `roomEffects` 同一类残留:`removePlayer` 不清标记的话,
     重新加入的同名玩家一进场就是打盹态 —— 表现是
     「刚上线就不提供 AOI 唤醒能量、还只拿 30% 经验」。 */
  const { host, runtime } = assemble({
    roomId: 'r11g', ownerId: 'o', clock: fixedClock(), sizeCells: 16,
  });
  materialize(host, runtime, 'p1');
  const sim = simOf(host);

  runtime.setAfk('p1', true);
  eq(sim.isPlayerAfk('p1'), true, '置真后应为 true');

  (sim as unknown as { removePlayer(id: string): boolean }).removePlayer('p1');
  eq(sim.isPlayerAfk('p1'), false, '★ 离场后标记应被清掉');
  eq(sim.afkPlayerCount, 0, '★ 计数应回到 0');
});

/* ═══════════ 4. 与 social/afk.ts 的「同名异义」界限 ═══════════ */

test('FND11-10 本通路与 social/afk.ts 的 tickAfk 是两件事(不合并)', () => {
  /* 两个都叫 afk,但:
       MemberPresence.AFK  = **连接态**(打盹者仍 connected、仍占席位)
       social/afk.tickAfk = **玩法**(切后台 5 秒打盹、按 DOZE_AFTER_SEC 攒露水)
     ⇒ 若将来有人把两者合并,「打盹」会变成需要露水系统才能成立,
       而房间成员态**不该**依赖一个玩法模块。
     用源码判据钉住:本通路不 import social/afk.ts。
     ⚠️ 必须**先剥注释**再查 —— 我第一版直接查原文,
        结果被我自己写在 `afkPlayers` docblock 里的
        同一句话判红。
        ⇒ **判据的口径比事实宽时,注释会伪装成代码**。
        这与 `setAfk` 的 `pushAfkToHost` 断言同一纪律。
     ⚠️ 名字本身也**不写进被测文件**:`world_sim.ts` 的 docblock 里
        连那两个函数名都不提,因为 `tests/WS-11.test.ts` 有一条判据
        正是靠「该文件不含那些标识符」来断「玩法模块仍未接线」。 */
  const simSrc = readCode('server/src/sim/world_sim.ts');
  const roomSrc = readCode('server/src/net/room.ts');
  /* ── task-84:缺口 A 接线后,本组的判据从「有没有 import」改为「两件事有没有合并」 ──
   *
   * ⚠️ 原文是 `ok(!/social\/afk\.ts/.test(simSrc), 'world_sim.ts 不应 import …')`。
   * 接线后 `world_sim.ts` **确实** import 了它(玩法要每帧驱动打盹攒露水),
   * ⇒ 那句 `!` 变红。**但本组的命题不是「永不许 import」**,而是
   * 「**连接态与玩法不得合并**」(见本 test 的标题与上面第 291-295 行)。
   * ⇒ 原判据只是当年**用来表达**那个命题的**代理指标**;
   *   现在真正的命题可以直接判了,故换成**行为判据**。
   *
   * 为什么不能只把 `!` 删掉:删掉等于「连接态与玩法不合并」这件事**失去守卫** ——
   * 而那正是 Lead 记的「避开检测器 ≠ 补上覆盖」。 */
  ok(/social\/afk\.ts/.test(simSrc),
    'world_sim.ts 现在 import social/afk.ts(缺口 A:玩法由模拟层每帧驱动)');
  /* ★ 真守卫(行为):两条通路**各自独立**。
     若将来有人把「连接态」与「玩法态」合并(例如让 setPlayerAfk 顺手记打盹、
     或让连线态从露水状态派生),下面三条里必然有一条红。 */
  {
    const sim = new WorldSim({ sizeCells: 8, rng: () => 0.5, combatRng: () => 0.5 });
    /* 只开**玩法态**(打盹),不碰连接态。 */
    sim.setPlayerDozing('p1', 0);
    eq(sim.dozingCount(), 1, '打盹玩法态已登记 p1');
    /* 反向:连接态**不该**因此被点亮 —— 这正是「两件事」的判据。 */
    eq(sim.afkPlayerCount, 0, '★ 打盹**不**让连接态计数变化 ⇒ 两条通路独立,未合并');
    eq(sim.isPlayerAfk('p1'), false, '★ 打盹**不**使 isPlayerAfk 为真 ⇒ 未合并');
  }
  /* room.ts 那条**保持**:它钉的是「net 层不得依赖玩法模块」这个架构约束。 */
  ok(!/social\/afk\.ts/.test(roomSrc),
    'room.ts 仍不 import social/afk.ts —— 驱动在 sim 层(WS-11 §8 禁用耦合:'
    + '方向必须 net/sim → 玩法;此处若需要 import,说明方向反了)');
  /* 反向:那条通路确实存在,且确实有打盹玩法常量 —— 证明「两件事」成立。 */
  const afkSrc = readFileSync(join(ROOT, 'server/src/social/afk.ts'), 'utf8');
  ok(/export const DOZE_AFTER_SEC/.test(afkSrc), 'social/afk.ts 应有玩法常量 DOZE_AFTER_SEC');
  ok(/export function tickAfk/.test(afkSrc), 'social/afk.ts 应有 tickAfk');
  /* 以及:本通路的真值来自房间的成员态概念,判据是这个名字在 room.ts 里存在。 */
  ok(/MemberPresence/.test(roomSrc), 'room.ts 应有 MemberPresence(连接态真值的载体)');
});

/* ═══════════ 5. 装配入口的 host 上确实有这个口(生产可达性) ═══════════ */

test('FND11-11 createHost 产出的 host 上 setPlayerAfk 可达(与 assemble 一致)', () => {
  /* `createHost` 是 `assemble` 内部用的那个函数 —— 单独测它,
     免得有人只在 assemble 里补了转发而 createHost 的返回类型没收窄。 */
  const host = createHost({ sizeCells: 16 });
  eq(typeof host.setPlayerAfk, 'function', 'createHost 产出的 host 上应有 setPlayerAfk');
  eq(host.setPlayerAfk?.('never', true), false, '未登记玩家应返回 false');
});

test('FND11-12 不回退:room.ts 的 setAfk 内确实调用了推送(源码判据)', () => {
  /* 这条防的是「有人把 pushAfkToHost 的调用删了,而测试因为别处补了
     手动 setPlayerAfk 而照绿」。断言调用**存在**且指向私有推送方法。 */
  const code = readCode('server/src/net/room.ts');
  const body = /setAfk\(userId: string, afk: boolean\): boolean \{([\s\S]*?)\n  \}/.exec(code);
  ok(body !== null, '应能找到 setAfk 的方法体');
  ok(/pushAfkToHost\s*\(/.test(body?.[1] ?? ''), '★ setAfk 内应调用 pushAfkToHost');
  ok(/typeof\s+host\.setPlayerAfk\s*===\s*'function'/.test(code),
    '推送处应写成 typeof 判函数(与 removePlayer 同一纪律),而不是 if (host.x)');
});

/* ═══════════ 6. ★ 墓碑防护:断言「生产触发源仍为 0」这个事实 ═══════════ */

test('FND11-13 ★ 墓碑防护:生产里仍无人调 setAfk(补上触发源时本断言必须红)', () => {
  /* ## 这条断言存在的唯一理由
   *
   * 本任务修的是**通路**,不是**触发源** —— 实测生产里没有任何东西
   * 会把 `afk` 变成 `true`(见文件头「本套件不断言什么」一节)。
   * ⇒ 若只写「注入 AFK ⇒ aoi 不含它」当验收,那么接线做完就绿,
   *   而**生产行为一字未变**(afk 仍恒 false)
   * ⇒ 那条断言就成了一口**墓碑**(陷阱 71):把缺陷状态编码成期望值,自己永远绿。
   *
   * ⇒ 故必须**同时**钉住「触发源仍为 0」这个**事实**。
   *   它的价值不在「现在绿」,而在**将来红**:
   *   一旦有人补上客户端打盹通道 / 服务端超时推断,
   *   本断言会红 ⇒ 强制他去更新文档与「未做项」标注
   *   ⇒ 那时「通路已通」才第一次等于「功能可用」。
   *
   * ⚠️ 这条**是故意**把「当前缺陷状态」写成期望值的 —— 与陷阱 71 的区别在于:
   *   陷阱 71 的墓碑**没有出路**(它假装缺陷是正确行为);
   *   本断言**自带出路**(它明说「补上就该红,并去改文档」)。
   */
  /* 1 生产侧 `setAfk` 的调用点仍为 0(只算生产目录,不算测试)。 */
  const prodFiles = [
    'server/src/net/room.ts',
    'server/src/net/room.colyseus.ts',
    'server/src/index.ts',
    'server/src/sim/world_sim.ts',
    'server/src/sim/demo.ts',
  ];
  let prodCalls = 0;
  for (const f of prodFiles) {
    const code = readCode(f);
    /* 排除定义本身(`setAfk(userId: string, afk: boolean) {`),只数调用。 */
    const calls = [...code.matchAll(/setAfk\s*\(/g)].length;
    const defs = [...code.matchAll(/setAfk\s*\(userId:\s*string/g)].length;
    prodCalls += calls - defs;
  }
  eq(prodCalls, 0,
    '★ 生产里 `setAfk` 的调用点应仍为 0(实测已知:无人触发打盹)。'
    + '若你刚补上了触发源 —— 恭喜,请同步更新本测试与 docs/ARCH-GAPS.md 的「未做项」');

  /* 2 客户端侧仍无「切后台」信号 —— 那是触发源最可能的落点。 */
  const clientCodes = readCode('client/src/net/session.ts');
  ok(!/visibilitychange|document\.hidden/.test(clientCodes),
    '★ 客户端仍无切后台信号(补上后本断言必须红,并去摘未做项)');

  /* 3 消息通道仍无 afk 通道(room.colyseus.ts 的 onMessage 全部通道名)。 */
  const rcCode = readCode('server/src/net/room.colyseus.ts');
  const channels = [...rcCode.matchAll(/onMessage\(\s*'([^']+)'/g)].map((m) => m[1]);
  ok(channels.length > 0, '应能解析出 onMessage 通道名(否则本判据失效,需改为别的形态)');
  ok(!channels.includes('afk') && !channels.includes('background'),
    `★ 消息面应仍无 afk/background 通道(实测 ${channels.join('/')})`);
  /* 反向对照:证明解析真的读到了东西(不是空集恒真)。 */
  ok(channels.includes('move') && channels.includes('attack'),
    '对照:应解析出已知的 move/attack 通道,证明上一条不是空集假绿');
});

/* ═══════════ 7. ★ 第二个消费者:`afkMul` 真的改变经验结算(行为判据) ═══════════ */

/** 跑一次「击杀 → 经验结算」,返回该玩家拿到的总经验。 */
function expFromKill(afk: boolean): number {
  const { host, runtime } = assemble({
    roomId: `r11exp_${afk ? 'afk' : 'awake'}`, ownerId: 'o', clock: fixedClock(), sizeCells: 32,
  });
  const sim = host as unknown as {
    addMob(id: string, biome: string, x: number, y: number): void;
    damageMob(mobId: string, amount: number, kind: string, fromDeg: number): unknown;
    progressOf(id: string): { totalExp: number };
    setPlayerAfk(id: string, afk: boolean): boolean;
  };
  runtime.join({ userId: 'p1', passwordHash: null, asGuest: true });
  /* 从**房间侧**注入(与 FND11-3 同一纪律,不直调模拟层)。 */
  runtime.setAfk('p1', afk);
  /* 击杀点 (1,1) 与玩家 (0.5,0.5) 的距离远小于 SHARE_RADIUS=24。 */
  sim.addMob('mob_sheep', 'plains', 1, 1);
  /* `damageMob(mobId, amount, kind, fromDeg)` —— 环境伤害直接给数,
     是**全部**生物伤害的唯一收口(玩家普攻也走它)。 */
  sim.damageMob('mob_sheep', 99_999, 'PHYSICAL', 0);
  return sim.progressOf('p1').totalExp;
}

test('FND11-14 ★ 打盹只拿 30% 经验(第二个消费者,端到端行为判据)', () => {
  /* 这条是 task-74 验收里「且 progression 的 afkMul 对它生效」那一半。
     为什么**必须**单独测 AOI 之外:两条消费者走**完全不同的投影** ——
       aoi 读的是 `this.players`(`syncPlayers` 第一处生产者)
       progression 读的是 `participants`(`settleKill` 里的第三处生产者)
     ⇒ 只测 AOI 会漏掉 settleKill 那一处(注入 B 的 3 红里就**没有**这条)。
     手册 §4.1 / `shared/types/entities.ts`:`AFK_EXP_RATIO = 0.3`。 */
  const awake = expFromKill(false);
  const afk = expFromKill(true);

  ok(awake > 0, `对照:清醒玩家击杀应拿到经验(实测 ${awake})`);
  ok(afk > 0, `打盹玩家仍应拿到**部分**经验(0.3 倍,不是 0;实测 ${afk})`);
  ok(afk < awake, `★ 打盹应少于清醒(实测 清醒 ${awake} / 打盹 ${afk})`);
  /* 比值判据:0.3 经逐次取整后会落在 0.3 的一格内。
     用区间而不是等号 —— 这段是**整数经验**,小样例必然有取整误差
     (实测 15 → 5 = 0.333)。 */
  const ratio = afk / awake;
  ok(ratio >= 0.3 && ratio < 0.5,
    `★ 比值应落在 0.3 附近(实测 ${ratio.toFixed(3)},期望 [0.3, 0.5))`);
  /* 反向对照:若 `afk` 真是恒 false,两者必然**相等** —— 这条把它变成红。 */
  ok(awake !== afk, '★ 若 afk 恒 false,两者会相等 ⇒ 本断言即变红');
});

report('WS-FND-11');
