/**
 * WS-FND-137 — **每帧成本**(第九轮实测的五处「同一个对象每帧重造」)。
 *
 * ## 修的是什么(与判据的对应)
 *
 * ```text
 * 1 P1 delta.ts:672   每实体 `listOf(prev,kind).find(...)` 全表查找 ⇒ O(n²)/帧
 *                     ⇒ id→实体 索引(每次编码建一次) + 计数器 idMapLookups
 * 2 P2 delta.ts       `roomToFlat` 每帧新建扁平对象 / `stats.changedFields` 每帧 map
 *                     ⇒ 复用槽(flatAllocs=0)+ 惰性物化(changedFieldsMaterialized=0)
 * 3 P2 world_sim.ts   `syncPlayers` 每快帧重建 list / mobPlayers(filter+map)
 *                     ⇒ 数组复用 + 元素对象池(syncPlayerObjectAllocs 稳态不涨)
 * 4 P2 anticheat.ts   `move()` 每次 `log.slice(-512)` + `s.violations` 只进不出
 *                     ⇒ 房间流水环形缓冲(有界 + 保序)+ 单玩家违规有界窗口
 * 5 P2 entity_sprites `planEntitySprites` 每帧建数组/对象/sort ⇒ 复用槽版本
 *    boot.ts           再 `new Set` + `[...entitySprites]` 全量拷贝 + 三遍 countByKind
 *                     ⇒ 复用 Set / 直接迭代 Map / 单遍 countByKinds
 * ```
 *
 * ## 判据纪律(与 WS-FND-130 / WS-FND-128 同一套)
 *
 * ```text
 * · 每条判据都带**负对照**:计数器必须被证明是「活的」——
 *   否则「编码侧 0 次全表查找」可能只是因为它恒 0(死字段);
 * · 关键判据带**注入验证**:把复用点/环形点拔掉,判据必须转假;
 * · 期望值写字面量(不在期望槽位引用本仓常量),避免「上游一改就跟着过」。
 * ```
 *
 * 运行:`node tests/WS-FND-137-frame-cost.test.ts`
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyPacket,
  decodePacket,
  encodeDelta,
  encodePerf,
  resetEncodePerf,
  roomToFlat,
} from '../shared/net/delta.ts';
import {
  EntityKind,
  cloneRoomState,
  createBossState,
  createPlayerState,
  createRoomState,
  createWildlifeState,
  type RoomState,
} from '../server/src/net/schema.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  AntiCheatRoom,
  DEFAULT_LIMITS,
  VIOLATION_KEEP_PER_PLAYER,
  VIOLATION_LOG_CAPACITY,
  ViolationKind,
  checkMove,
  createAcState,
} from '../server/src/net/anticheat.ts';
import {
  countByKind,
  countByKinds,
  planEntitySprites,
  planEntitySpritesInto,
  resetSpritePlanCounters,
  spritePlanSpecAllocs,
  type EntitySpriteSpec,
} from '../client/src/stage/entity_sprites.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

function player(id: string, x: number, y: number) {
  return createPlayerState(id, {
    name: id, level: 10, hp: 100, maxHp: 100, x, y, z: 0,
    dir: 0, stateFlag: 0, weaponId: 0, aiWeaponRecipeHash: '',
    heldItemId: 0, carryingEntityId: '',
  });
}

/** `nPlayers` 个玩家 + `nWild` 只生物 + `nBoss` 个 boss 的合法房间状态(id 固定 p0.. / w0.. / b0..)。 */
function bigState(nPlayers: number, nWild: number, nBoss: number, roomId = 'room_alpha'): RoomState {
  const s = createRoomState(roomId);
  s.meta.tick = 100;
  for (let i = 0; i < nPlayers; i += 1) s.players.push(player(`p${i}`, 1 + i, 2 + (i % 40)));
  for (let i = 0; i < nWild; i += 1) {
    s.wildlife.push(createWildlifeState(`w${i}`, {
      mobId: 'mob_meadow_piglet', x: 3 + i, y: 4 + (i % 40), z: 0, fsm: 0, hp: 30, maxHp: 30,
    }));
  }
  for (let i = 0; i < nBoss; i += 1) {
    s.bosses.push(createBossState(`b${i}`, {
      bossId: 'boss_demo', phase: 1, hp: 500, maxHp: 500,
      telegraphShape: 1, telegraphX: 5, telegraphY: 6, telegraphR: 3, telegraphEndTick: 999,
    }));
  }
  return s;
}

/** `WorldSim` 的**读**视图(私有字段按结构读,只读不注入 —— 与 WS-FND-11 同一手法)。 */
type SimView = {
  mobPlayers: { id: string; x: number; y: number; afk: boolean; wearing: readonly number[] }[];
  syncPlayerObjectAllocs: number;
};
function view(sim: WorldSim): SimView {
  return sim as unknown as SimView;
}

/* ═════════════════════ 1. delta.ts:P1 每实体全表查找 ═════════════════════ */

test('FND137-1 P1 每实体全表查找 ⇒ 每次编码一次 id 索引(查表次数 = next 侧实体数)', () => {
  const prev = bigState(200, 50, 3);
  const next = cloneRoomState(prev);
  next.players[0].x += 1;
  next.wildlife[0].x += 1;
  next.bosses[0].telegraphR += 1;

  resetEncodePerf();
  const d = encodeDelta(prev, next, 101);

  eq(encodePerf.idMapBuilds, 1, '每次带 prev 的编码只建 1 次索引');
  eq(encodePerf.idMapLookups, 253, '查表次数 = next 侧实体数(200 + 50 + 3)');
  eq(encodePerf.linearIdLookups, 0, '★ 编码侧一次全表线性查找都没有');
  /* 修前形态的成本(每次全表扫描的行数):200² + 50² + 3²。
     写死字面量,不用本仓常量 —— 否则「上游一改就跟着过」。 */
  ok(encodePerf.idMapLookups < 42509 / 100,
    `查表 ${encodePerf.idMapLookups} 应比修前的 42509 行扫描低两个数量级`);
  eq(d.stats.removed.length, 0, '没有任何实体被删');
});

test('FND137-2 P1 尸体(prev 有 / next 无)不参与 upsert 配对', () => {
  const prev = bigState(60, 0, 0);
  const next = createRoomState('room_alpha');
  next.meta.tick = 101;
  for (let i = 0; i < 5; i += 1) next.players.push(player(`p${i}`, 9, 9));

  resetEncodePerf();
  const d = encodeDelta(prev, next, 101);

  eq(d.stats.removed.length, 55, '删除段报 55 条(60 - 5)');
  eq(d.stats.removed[0].kind, EntityKind.PLAYER, '删除条目带 kind');
  eq(encodePerf.idMapLookups, 5, '★ 只对 next 侧的 5 个实体查表 —— 55 具尸体 0 次配对');
});

test('FND137-3 ★ 索引的 clear() 不能漏(负对照:泄漏会吞掉新增实体的字段)', () => {
  /* 编码 A:prev 与 next 完全一致(60 个 id,0 变更)。
     ⚠️ 必须先 reset —— 计数器是**累积**的,不清零会把前面用例的查表数算进来。 */
  const base = bigState(60, 0, 0);
  resetEncodePerf();
  encodeDelta(base, cloneRoomState(base), 200);
  const afterA = encodePerf.idMapLookups;
  eq(afterA, 60, '前置:编码 A 的查表 = 60 次(next 侧 60 个实体)');

  /* 编码 B:prev 只含前 5 个 id,next 含全部 60 个 ⇒ 后 55 个是**新增**,
     它们必须整条 upsert(mask = 全字段)。若索引没 clear(),上一帧的 55 条
     会被当成本帧的 prev(字段完全相同)⇒ mask 0 ⇒ 这 55 条**整包消失**。 */
  const thin = createRoomState('room_alpha');
  thin.meta.tick = 201;
  /* ⚠️ 这 5 个必须与 next 侧**同 id 但字段值不同** —— 否则它们本来就"没变",
     期望值会从 60 悄悄变成 59(第一版就是这么写错的)。 */
  for (let i = 0; i < 5; i += 1) thin.players.push(player(`p${i}`, 100 + i, 100));
  resetEncodePerf();
  const d = encodeDelta(thin, base, 201);
  eq(d.stats.changedFields.length, 60, '★ 60 条 upsert 一条不少(索引泄漏会只剩 5 条)');
  eq(encodePerf.idMapLookups, 60, '查表 60 次 = next 侧实体数');
  eq(encodePerf.idMapBuilds, 1, '而索引只建 1 次(不是每次查表重建一遍)');
});

test('FND137-4 ★ 负对照:linearIdLookups 是活的(落地侧仍走全表查找)', () => {
  const prev = bigState(40, 0, 0);
  const next = cloneRoomState(prev);
  next.players[3].x += 1;

  resetEncodePerf();
  const d = encodeDelta(prev, next, 102);
  eq(encodePerf.linearIdLookups, 0, '★ 编码一次 ⇔ 0 次全表查找');

  const applied = applyPacket(prev, decodePacket(d.bytes));
  eq(applied.players.length, 40, '落地后玩家数不变(行数守恒)');
  eq(applied.players[3].x, next.players[3].x, '落地真的应用了那条变更');
  ok(encodePerf.linearIdLookups > 0,
    '★ 负对照:收包并落地 ⇒ 计数器必须动(否则「编码侧 0 次」是死字段,不是判据)');
});

/* ═════════════════════ 2. delta.ts:P2 重复分配 ═════════════════════ */

test('FND137-5 P2 房间级扁平对象复用(稳态 0 新建,内容仍逐字段正确)', () => {
  const prev = bigState(3, 0, 0);
  const next = cloneRoomState(prev);
  next.meta.scoreA = 7;

  resetEncodePerf();
  for (let f = 0; f < 10; f += 1) {
    next.meta.tick = 300 + f;
    encodeDelta(prev, next, 300 + f);
  }
  eq(encodePerf.flatAllocs, 0, '10 帧编码不新建任何扁平对象');
  eq(encodePerf.flatReuses, 20, '每帧 2 次复用(prev 槽 + next 槽)');

  /* 内容正确性:复用槽必须把 5 个房间字段都覆写进去(漏写会「继承上一帧的值」)。 */
  const d = encodeDelta(prev, next, 310);
  const ch = d.stats.changedFields.find((c) => c.kind === EntityKind.ROOM);
  ok(ch !== undefined, 'scoreA 变了 ⇒ 房间级必须有一条 upsert');
  ok(ch!.fields.includes('scoreA'), `房间级字段应含 scoreA(实际 ${ch!.fields.join(',')})`);

  /* ★ 负对照:公开的 roomToFlat 仍会新建(它被解码/外部调用方用)。 */
  resetEncodePerf();
  roomToFlat(next);
  eq(encodePerf.flatAllocs, 1, '★ 负对照:roomToFlat 计 1 次新建(说明计数器不是死的)');
  eq(encodePerf.flatReuses, 1, '并复用 1 次(同一个槽)');
});

test('FND137-6 P2 changedFields 惰性化:不读不花,读了逐字段不变', () => {
  const prev = bigState(5, 2, 0);
  const next = cloneRoomState(prev);
  next.players[1].x += 1;
  next.players[1].y += 1;
  next.wildlife[0].hp -= 1;

  resetEncodePerf();
  const d = encodeDelta(prev, next, 103);
  eq(encodePerf.changedFieldsMaterialized, 0, '★ 生产路径只取 .bytes ⇒ 一次都不物化');

  const ch = d.stats.changedFields;
  eq(encodePerf.changedFieldsMaterialized, 1, '读一次 ⇒ 物化一次');
  eq(ch.length, 2, '两个实体有变更(p1 / w0)');
  eq(ch[0].id, 'p1');
  eq(ch[0].kind, EntityKind.PLAYER);
  eq(ch[0].fields.slice().sort(), ['x', 'y'], '只列出真变了的两个字段');
  eq(ch[1].id, 'w0');
  eq(ch[1].fields, ['hp'], '生物只改了 hp');
  ok(d.stats.changedFields === ch, '★ 再读一次拿到**同一份**(缓存,不是每次新造)');
  eq(encodePerf.changedFieldsMaterialized, 1, '读两次仍只物化一次');

  /* ★ 负对照:没有变更的差量,物化出来必须是空的(惰性化没改变语义)。 */
  resetEncodePerf();
  const noop = encodeDelta(prev, prev, 104);
  eq(noop.stats.changedFields.length, 0, '★ 负对照:prev === next ⇒ 0 条变更');
  eq(noop.stats.removed.length, 0, '且 0 条删除');
});

/* ═════════════════ 3. world_sim.ts:P2 每快帧重建 ═════════════════ */

test('FND137-7 P2 syncPlayers 稳态 0 分配,位置/afk 投影仍逐帧刷新', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.addPlayer('p1', 4, 5);
  sim.addPlayer('p2', 6, 7);
  const v = view(sim);

  sim.tick();                       /* 预热:第一帧建池 */
  const warm = v.syncPlayerObjectAllocs;
  ok(warm >= 2, `前置:预热帧建了 ${warm} 个投影元素对象(AoiPlayer + WorldPlayer)`);

  for (let i = 0; i < 5; i += 1) sim.tick();
  eq(v.syncPlayerObjectAllocs, warm, '★ 名册不变的 5 个快帧:一个新对象都没建');

  /* 行为不变 1:位置投影仍与权威同源(池化靠覆写,不靠新对象)。 */
  const before = v.mobPlayers.find((p) => p.id === 'p1')!.x;
  sim.setPlayerPos('p1', 9, 5);
  eq(v.mobPlayers.find((p) => p.id === 'p1')!.x, 9, 'setPlayerPos 立刻反映到 mobPlayers');
  ok(before !== 9, '前置:位置确实变了');

  /* 行为不变 2:`afk` 必须**每帧覆写** —— 复用对象最容易在这里「继承上一帧的值」。 */
  sim.setPlayerAfk('p2', true);
  eq(v.mobPlayers.find((p) => p.id === 'p2')!.afk, true, '★ 打盹真值立刻投影');
  sim.tick();
  eq(v.mobPlayers.find((p) => p.id === 'p2')!.afk, true, 'tick 后仍为真(没被覆写成上一帧的值)');
  sim.setPlayerAfk('p2', false);
  eq(v.mobPlayers.find((p) => p.id === 'p2')!.afk, false, '★ 取消打盹也立刻投影(else 支路必须写 afk)');
});

test('FND137-8 P2 投影元素对象**复用**(身份不变)+ 新增刚体恰好 +2', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.addPlayer('p1', 4, 5);
  const v = view(sim);
  sim.tick();

  const first = v.mobPlayers[0];
  sim.tick();
  const again = v.mobPlayers.find((p) => p.id === 'p1');
  ok(first === again, '★ 同一个 id 的投影元素对象跨帧是**同一个对象**(池化的直接证据)');

  /* ★ 负对照:新增一个刚体 ⇒ 恰好新建 2 个元素对象(AoiPlayer + WorldPlayer),
     证明「稳态 0 分配」不是「永不再分配」的假象。 */
  const before = v.syncPlayerObjectAllocs;
  sim.addPlayer('p9', 8, 9);
  eq(v.syncPlayerObjectAllocs, before + 2, '★ 负对照:一个新玩家 ⇒ +2 个元素对象');

  /* 生物不冒充玩家:mobPlayers 只含 playerIds 里的 id。 */
  sim.addMob('mob_boar', 'meadow', 10, 10);
  sim.tick();
  ok(v.mobPlayers.every((p) => p.id === 'p1' || p.id === 'p9'),
    `mobPlayers 必须只含玩家(实际 ${v.mobPlayers.map((p) => p.id).join(',')})`);
});

test('FND137-9 P2 池缓冲不就地清空 `setMobPlayers` 传入的数组(外部数组不受污染)', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false });
  sim.addPlayer('p1', 4, 5);
  const v = view(sim);

  const injected = [{
    id: 'p1', x: 1, y: 2, z: 0, facingDeg: 0, afk: false,
    heldItem: 712, wearing: [712], playingInstrument: false,
  }];
  sim.setMobPlayers(injected);
  eq(v.mobPlayers, injected, '灌入后这一份就是当前视图(装配层入口语义)');

  sim.tick();
  eq(injected.length, 1, '★ tick 后调用方的数组**没有被就地清空**(len 仍是 1)');
  eq(injected[0].wearing, [712], '★ 且内容未被抹掉(池缓冲是另一份数组)');
  ok(v.mobPlayers !== injected, 'tick 后视图指回池缓冲,而不是复用调用方的数组');
});

/* ═══════════════ 4. anticheat.ts:P2 流水无界 + 每次 slice ═══════════════ */

test('FND137-10 P2 房间违规流水改环形:有界 + 保序 + 丢弃可数', () => {
  eq(VIOLATION_LOG_CAPACITY, 512, '容量口径与修前的 slice(-512) 同值');
  const ac = new AntiCheatRoom();
  let pushes = 0;
  for (let i = 0; i < 700; i += 1) {
    const id = `p${i}`;
    ac.join(id, 0, 0, 0, 0);
    const verdict = ac.move({ playerId: id, tick: 1, x: 5000, y: 0, z: 0 }, 3);
    eq(verdict.allowed, false, `瞬移到 5000 格必须被拒(${id})`);
    pushes += ac.get(id)!.violations.length;
  }
  ok(pushes >= 700, `前置:至少压了 700 条违规(实际 ${pushes})`);

  const log = ac.violations();
  eq(log.length, 512, '★ 流水恒被截到 512 条(环形,不是无界增长)');
  eq(ac.droppedViolations, pushes - 512, '★ 被覆写丢弃的条数可数(= 总写入 − 留存)');
  eq(ac.countByKind(ViolationKind.TELEPORT), 512, '按 kind 计数口径不变');

  /* 保序:留下的必须是**最后** 512 条,且最早在前(playerId 单调不减)。 */
  const idx = log.map((x) => Number(x.playerId.slice(1)));
  let monotone = true;
  for (let i = 1; i < idx.length; i += 1) if (idx[i] < idx[i - 1]) monotone = false;
  ok(monotone, '★ 快照按时间顺序(最早在前)—— 环形缓冲的物理顺序不能泄漏到读侧');
  ok(idx[idx.length - 1] === 699, `最后一条应是 p699(实际 p${idx[idx.length - 1]})`);
  ok(idx[0] > 0, `最早那条已被环覆盖掉(实际 p${idx[0]})`);
});

test('FND137-11 P2 单玩家违规数组有界(只进不出 ⇒ 有界窗口)', () => {
  eq(VIOLATION_KEEP_PER_PLAYER, 256, '单玩家窗口 256 条');

  const s = createAcState('flood', 0, 0, 0, 0);
  for (let i = 0; i < 400; i += 1) {
    checkMove(s, { tick: 1, x: 5000, y: 0, z: 0 }, DEFAULT_LIMITS, 3);
  }
  eq(s.violations.length, 256,
    '★ 400 次违规之后仍是 256 条(修前会一路涨到 400 条;常量与「256」的锚在上一条断言)');

  /* ★ 负对照:少量违规时**一条都不裁**(行为与修前相同)。 */
  const few = createAcState('few', 0, 0, 0, 0);
  checkMove(few, { tick: 1, x: 5000, y: 0, z: 0 }, DEFAULT_LIMITS, 3);
  eq(few.violations.length, 1, '★ 负对照:一次违规仍只留 1 条');
  eq(few.violations[0].kind, ViolationKind.TELEPORT, '且 kind 不变');
});

/* ═══════════ 5. entity_sprites.ts / boot.ts:P2 客户端每帧重建 ═══════════ */

const SPRITE_SRC = {
  players: [
    { id: 'me', x: 1, y: 2 },
    { id: 'p2', name: '队友', x: 3, y: 4, hp: 5, maxHp: 9 },
  ],
  wildlife: [
    { id: 'w1', mobId: 'mob_boar', x: 5, y: 6 },
    { id: 'w2', x: 7, y: 8, tameOwnerId: 'p2' },
  ],
};

test('FND137-12 P2 立牌计划复用槽:稳态 0 新建 + 与公开版本逐字段一致', () => {
  const buf: EntitySpriteSpec[] = [];
  resetSpritePlanCounters();
  const a = planEntitySpritesInto(buf, SPRITE_SRC, 'me');
  const afterFirst = spritePlanSpecAllocs;
  eq(a.length, 3, '本地玩家不在计划里;2 远端(1 玩家 + 1 宠) + 1 怪 = 3');

  const b = planEntitySpritesInto(buf, SPRITE_SRC, 'me');
  eq(spritePlanSpecAllocs, afterFirst, '★ 同一份快照第二次调用:0 次新建');
  ok(a[0] === b[0], '★ 槽对象身份不变(复用,不是「看起来一样的新对象」)');
  /* ── 公开版本(返回新数组)行为未变:每次调用都完整分配一份 ──
     ⚠️ 必须把它的分配**记账**后再验负对照,否则「计数器涨了」会被误读成复用失效。 */
  const beforePublished = spritePlanSpecAllocs;
  const published = planEntitySprites(SPRITE_SRC, 'me');
  eq(published, a, '逐字段与复用槽版本一致(公开路径未被改动)');
  ok(published[0] !== a[0], '公开版本仍返回新对象(不会被复用缓冲改掉)');
  eq(spritePlanSpecAllocs, beforePublished + 3, '公开版本每次建 3 个(修前口径,未变)');

  /* ★ 负对照:多一个实体 ⇒ 恰好新建 1 个 spec。 */
  const widened = { ...SPRITE_SRC, wildlife: [...SPRITE_SRC.wildlife, { id: 'w3', x: 9, y: 9 }] };
  const beforeWiden = spritePlanSpecAllocs;
  planEntitySpritesInto(buf, widened, 'me');
  eq(spritePlanSpecAllocs, beforeWiden + 1, '★ 负对照:新增 1 个实体恰好新建 1 个 spec');
  eq(buf.length, 4, '计划条数跟着涨');
});

test('FND137-13 P2 立牌计划退化为空时槽位被正确截断(不会有幽灵 spec)', () => {
  const buf: EntitySpriteSpec[] = [];
  planEntitySpritesInto(buf, SPRITE_SRC, 'me');
  eq(buf.length, 3, '前置:3 条');
  const shrunk = planEntitySpritesInto(buf, { players: [], wildlife: [] }, 'me');
  eq(shrunk.length, 0, '★ 空快照 ⇒ 计划清空(长度截断,不留上一帧的残留)');
  const bad = planEntitySpritesInto(buf, { players: [{ id: 'x', x: Number.NaN, y: 1 }] }, 'me');
  eq(bad.length, 0, '★ 坐标坏 ⇒ 不画(不是摆到 0,0 —— 与修前同口径)');
});

test('FND137-14 P2 三类一遍数完,且与逐类计数口径一致', () => {
  const specs = planEntitySprites(SPRITE_SRC, 'me');
  const one = countByKinds(specs);
  eq(one.player, countByKind(specs, 'player'), 'player 口径一致');
  eq(one.mob, countByKind(specs, 'mob'), 'mob 口径一致');
  eq(one.pet, countByKind(specs, 'pet'), 'pet 口径一致');
  eq(one.player + one.mob + one.pet, specs.length, '三类之和 = 总数');

  /* ★ 负对照:空计划三类都是 0(单遍统计不能漏掉空输入)。 */
  eq(countByKinds([]), { player: 0, mob: 0, pet: 0 }, '★ 负对照:空计划');
});

test('FND137-15 boot.ts 每帧不再整表拷贝 / 不再每帧新建 Set(注入验证)', () => {
  const src = readFileSync(join(ROOT, 'client/src/three/boot.ts'), 'utf8');
  const start = src.indexOf('const reconcileEntitySprites = (): void => {');
  ok(start > 0, '前置:找得到 reconcileEntitySprites');

  /* 取出该函数体(自函数头到结束的 `  };`)。
     ⚠️ 必须**先去注释**再判:函数体里的说明文字正引用着被禁掉的写法
     (`不再 \`[...entitySprites]\` 每帧整表拷一份`)—— 拿原始文本去 `includes`
     会让判据恒假(第一版就是这么被自己的注释打败的)。
     去注释的手法与 `tests/WS-FND-11` 的 `readCode` 同一套。 */
  const end = src.indexOf('\n  };', start);
  ok(end > start, '前置:找得到函数末尾');
  const body = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const detector = (code: string): boolean => (
    code.includes('planEntitySprites(authority.state, authority.localPlayerId)')
    && code.includes('spriteSeen.clear()')
    && code.includes('countByKinds(specs)')
    && !code.includes('[...entitySprites]')
    && !code.includes('new Set')
  );
  ok(detector(body), '计划 → 复用缓冲 / 键集合复用 / 单遍统计,且不再整表拷贝');

  /* ── 注入验证:拔掉任一复用点,判据必须转假 ── */
  ok(!detector(body.replace('planEntitySprites(authority.state, authority.localPlayerId)', '[]')),
    '★ 注入(调用点被掏空)后判据必须转假');
  ok(!detector(body.replace('spriteSeen.clear()', '')),
    '★ 注入(键集合不再复用)后判据必须转假');
  ok(!detector(body.replace('countByKinds(specs)', 'countByKind(specs, "mob")')),
    '★ 注入(退回逐类多遍统计)后判据必须转假');
  ok(!detector(`${body}\n    const ghost = [...entitySprites];`),
    '★ 注入(塞回整表拷贝)后判据必须转假');
  ok(!detector(`${body}\n    const ghost = new Set<string>();`),
    '★ 注入(塞回每帧新建 Set)后判据必须转假');

  /* ── 调用形状仍被 WS-FND-126 的注入探针钉住(改动不得让它转假) ── */
  ok(src.includes('planEntitySprites(authority.state, authority.localPlayerId)'),
    '★ 调用点字面量仍在(tests/WS-FND-126 的 FND126-7 靠它做注入验证)');
  ok(src.includes('planEntitySpritesInto(spritePlan, state, localPlayerId)'),
    '★ 而它只是一层包装:真正的实现在复用槽版本上');
});

/* ═════════════ 6. 汇总:一帧编码的稳态分配面不随帧增长 ═════════════ */

test('FND137-16 一帧编码的稳态分配面:与实体数同阶的「每帧新建」全部消失', () => {
  const prev = bigState(120, 30, 2);
  const next = cloneRoomState(prev);
  next.players[5].x += 1;

  resetEncodePerf();
  encodeDelta(prev, next, 400);
  const flatAfter1 = encodePerf.flatAllocs;
  const buildsAfter1 = encodePerf.idMapBuilds;
  eq(flatAfter1, 0, '第一帧就没有新建扁平对象');
  eq(buildsAfter1, 1, '第一帧建 1 次索引');

  for (let f = 1; f <= 5; f += 1) {
    next.meta.tick = 400 + f;
    encodeDelta(prev, next, 400 + f);
  }
  eq(encodePerf.flatAllocs, flatAfter1, '★ 扁平对象分配**不随帧增长**');
  eq(encodePerf.idMapBuilds, buildsAfter1 + 5, '★ 索引每帧 1 次(常数,与实体数无关)');
  eq(encodePerf.changedFieldsMaterialized, 0, '★ 6 帧里 changedFields 一次都没物化');
  eq(encodePerf.linearIdLookups, 0, '★ 6 帧里 0 次全表线性查找');
});

report('WS-FND-137');
