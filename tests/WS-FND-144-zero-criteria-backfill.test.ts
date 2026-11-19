/**
 * WS-FND-144 —— **零判据回填**(第十轮覆盖矩阵「完全没有判据但仍在生产路径上」档)。
 *
 * ## 为什么有这套件
 *
 * 第十轮矩阵把 2290 个导出分成三档:真行为 1222 / 只有符号判据 10 / **完全没有 979**
 * (其中 260 个仍挂在生产路径上)。本套件只补该清单里**风险最高的 8 项**,不铺开。
 *
 * ```
 * 1 db/repo.ts:492    setPartyMode            持久层写口,生产每个模式切换都过它
 * 2 db/repo.ts:1003   saveRoomMobMem          UPDATE 的 0 行 ≠ 抛错 ⇒ 静默不落地
 *   db/repo.ts:1024   loadRoomMobMem          存档是**外部输入**,解析必须容错
 * 3 net/anticheat.ts:428   decayScore         踢出延迟 = 阈值/衰减率,缓不缓得住全靠它
 * 4 net/anticheat.ts:478   snapshotMoveWindow 第九轮 P1:世界拒收后必须**一起**回滚
 *   net/anticheat.ts:494   restoreMoveWindow
 * 5 net/anticheat.ts:849   previewAttack      AntiCheatRoom 本体有判据,但**攻击与回滚
 *   net/anticheat.ts:879   commitAttack       路径**(判定→结算→提交)零直调判据
 * 7 mobs/spawner.ts:324    MobSpawner          刷新器的上限/软上限衰减/安全区整体判据
 * 8 world/chunk.ts:456     assertRoofId        值域闸只有**源码文本**判据(WS-FND-116),
 *                                              ⇒ 读口(decodeRoofRle)从未真跑过
 * ```
 *
 * ## 刻意跳过的两项(理由可复核,不是漏做)
 *
 * | # | 目标 | 为何跳过 |
 * | - | ---- | -------- |
 * | 6 | `combat/vitals.ts:1197 resolveStrikes` | **S 线已补**:`tests/WS-FND-142` 的 `FND142-12` 已真 import + 12 条断言(命中/圆外/z 容差/去重键/多攻击者/无敌帧/mul/冻结入参纯函数)。本条**不重复**。 |
 * | 8 | `world/chunk.ts:456 assertRoofId` | 未转真判据(WS-FND-116 FND116-2 是**扫源码文本** `/into\[o\] = assertRoofId\(/`),⇒ **本文件补真调**。 |
 *
 * ## 判据形态纪律(与本仓既有约定一致)
 *
 * 每条都**调真函数 + 断后果**,并配**负对照**(该拒的必须拒:非法输入 / 边界 / 重复调用),
 * 不写「符号存在」式断言。特别地:
 * ```
 * · 判定与提交分离 ⇒ 必须断言「拒绝时水位**不动**」,否则冷却被白占(WS-FND-135 P3)
 * · 快照/回滚 ⇒ 必须断言「只回滚窗口与水位,**不**回滚 score / violations」
 * · 值域闸 ⇒ 必须断言「越界**抛**」且**不半截写入**(读口先判后写)
 * · 0 影响行 ≠ 静默成功 ⇒ 必须断言「房间不存在 ⇒ 0」,而不是抛错或假装写成功
 * ```
 */
import { eq, near, ok, report, test } from '../shared/testing/harness.ts';
import {
  PartyMode,
  createRoom,
  createUser,
  getRoom,
  loadRoomMobMem,
  migrate,
  saveRoomMobMem,
  setPartyMode,
} from '../server/src/db/repo.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import {
  BASE_ATTACK_INTERVAL_S,
  DEFAULT_LIMITS,
  MAX_ATTACK_SPEED_BONUS,
  VIOLATION_SCORE_DECAY_PER_TICK,
  VIOLATION_SCORE_KICK,
  VIOLATION_WEIGHT,
  ViolationKind,
  advanceServerClock,
  checkAttack,
  checkMove,
  commitAttack,
  createAcState,
  decayScore,
  previewAttack,
  restoreMoveWindow,
  snapshotMoveWindow,
} from '../server/src/net/anticheat.ts';
import {
  BIOME_SPAWN,
  GLOBAL_MOB_CAP,
  MobSpawner,
  type SpawnWorld,
  decideSpawn,
  SpawnReject,
} from '../server/src/mobs/spawner.ts';
import {
  ROOF_BITS,
  ROOF_ID_MAX,
  assertRoofId,
  decodeRoofRle,
  encodeRoofRle,
} from '../server/src/world/chunk.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 迁移 + 一个用户 + 两间房(`r1` / `r2`)。返回内存库。 */
function mkDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  createRoom(db, { id: 'r2', ownerId: 'u1', nowMs: 1000 });
  return db;
}

/** 断言「必须抛」,且 `test` 回调里的断言失败不会被这里的 catch 吞掉。 */
function expectThrow(fn: () => void, contains: string, msg: string): void {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  ok(threw, `${msg} —— 实得:**没有抛**`);
  const err = caught as Error;
  ok(
    err.message.includes(contains),
    `${msg} —— 理由应含 ${JSON.stringify(contains)},实得 ${JSON.stringify(err.message)}`,
  );
}

/** 断言「必须是 RangeError 且理由含关键片段」(值域闸的归因形状)。 */
function expectRange(fn: () => void, contains: string, msg: string): void {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  ok(threw, `${msg} —— 实得:**没有抛**`);
  ok(caught instanceof RangeError, `${msg} —— 期望 RangeError,实得 ${String(caught)}`);
  const m = (caught as RangeError).message;
  ok(m.includes(contains), `${msg} —— 理由应含 ${JSON.stringify(contains)},实得 ${JSON.stringify(m)}`);
}

/** 手搓 `SpawnWorld`:只填 `decideSpawn` 会问的那五口。 */
function stubWorld(over: Partial<SpawnWorld> = {}): SpawnWorld {
  return {
    objAt: () => 0,
    floorAt: () => 0,
    blocked: () => false,
    townCenter: () => ({ x: 1000, y: 1000 }),
    isNight: () => false,
    ...over,
  };
}

/* ═══════════════ 1. db/repo.ts:492 setPartyMode ═══════════════ */

test('FND144-1 setPartyMode:四个合法模式都真的落库;未知房间 ⇒ 0 行;DDL 与代码清单同源', () => {
  const db = mkDb();
  const before = getRoom(db, 'r1');
  eq(before?.party_mode, PartyMode.NONE, '前置:建房默认 NONE');

  /* 正对照:模式写进去 + `last_active_at` 一并推进(这就是它叫 set 而不是 settle 的原因)。 */
  eq(setPartyMode(db, 'r1', PartyMode.JELLY_BALL, 2000), 1, 'UPDATE 影响 1 行');
  eq(getRoom(db, 'r1')?.party_mode, PartyMode.JELLY_BALL, '★ 模式真的写进 rooms.party_mode');
  eq(getRoom(db, 'r1')?.last_active_at, 2000, '★ 活动时间同步推进(否则房间会被误判沉睡)');

  /* ★ 与 DDL 的 CHECK 逐值对照:`PartyMode` 的每个值都必须被 schema.sql 收下。
     这条是 `schema.sql:82` 那次漂移(代码 4 值 / DDL 缺一)的常驻判据。 */
  const modes = Object.values(PartyMode);
  eq(modes, ['NONE', 'BRIDGE_CTF', 'JELLY_BALL', 'CROWN_BR', 'PAINT_WAR'], '锚点:代码侧 5 个模式(写死字面量,与实现不同源)');
  for (const m of modes) {
    setPartyMode(db, 'r1', m, 2000);
    eq(getRoom(db, 'r1')?.party_mode, m, `★ DDL 与代码同源:${m} 必须能被写入`);
  }

  /* 负对照 1:未知房间 ⇒ 影响行数 **0**(刻意不抛:调用方据此断言「确实落地了」)。 */
  eq(setPartyMode(db, 'nope', PartyMode.PAINT_WAR, 3000), 0, '★ 房间不存在 ⇒ 0,不抛也不假装成功');

  /* 负对照 2:跨房间隔离 —— 改 r1 不许动 r2。 */
  eq(getRoom(db, 'r2')?.party_mode, PartyMode.NONE, '★ r2 仍是 NONE(没有「全表 UPDATE」)');
  eq(getRoom(db, 'r2')?.last_active_at, 1000, 'r2 的活动时间也没被动');

  /* 负对照 3:DDL 之外的字符串必须被库拒(而不是写进去再让读侧崩)。 */
  expectThrow(
    () => setPartyMode(db, 'r1', 'NOPE' as unknown as PartyMode, 4000),
    'CHECK constraint failed',
    '★ 非法模式必须被 DDL CHECK 拒',
  );
  eq(getRoom(db, 'r1')?.party_mode, PartyMode.PAINT_WAR, '★ 被拒之后值不变(校验在写入之前)');

  /* 重复调用:幂等于值、但不幂等于时间戳(每次都是「刚刚活跃」)。 */
  eq(setPartyMode(db, 'r1', PartyMode.PAINT_WAR, 5000), 1, '重复设同一模式照样影响 1 行');
  eq(getRoom(db, 'r1')?.party_mode, PartyMode.PAINT_WAR, '值稳定');
  eq(getRoom(db, 'r1')?.last_active_at, 5000, '时间戳取最后一次');
});

/* ═══════════ 2. db/repo.ts:1003/1024 save / loadRoomMobMem ═══════════ */

test('FND144-2 saveRoomMobMem → loadRoomMobMem:原样往返;未知房间 ⇒ 0 行 / 空记忆', () => {
  const db = mkDb();

  /* 新建房没有被 save 过 ⇒ 读回空记忆(DDL DEFAULT '{}')。 */
  eq(loadRoomMobMem(db, 'r1'), {}, '前置:新房间没有生物记忆');

  const mem = {
    'mob_boar#1': { hp: 12, mode: 'IDLE', patrolX: 3.5 },
    'mob_sheep#7': { hp: 1, mode: 'GRAZE', hungry: true },
  };
  eq(saveRoomMobMem(db, 'r1', mem, 2000), 1, 'UPDATE 影响 1 行');
  eq(loadRoomMobMem(db, 'r1'), mem, '★ 往返逐字段一致(含布尔与小数)');
  eq(getRoom(db, 'r1')?.last_active_at, 2000, '存档同时刷新活动时间');

  /* 覆盖写:第二次 save 是**替换**而不是合并(否则已消失的生物记忆会永远滞留)。 */
  eq(saveRoomMobMem(db, 'r1', { 'mob_boar#1': { hp: 3 } }, 3000), 1, '二次 save 影响 1 行');
  eq(loadRoomMobMem(db, 'r1'), { 'mob_boar#1': { hp: 3 } }, '★ 后一次 save 整体替换(r2 那种「旧键残留」= 幽灵 AI)');
  eq((db.get('rooms', { id: 'r2' }) as { mob_mem_json?: string } | undefined)?.mob_mem_json, '{}', '★ 负对照:r2 一字未动');

  /* 负对照 1:未知房间 —— 写不进去(0 行),读回空。 */
  eq(saveRoomMobMem(db, 'nope', mem, 4000), 0, '★ 房间不存在 ⇒ 影响 0 行(不抛,把事实交回调用方)');
  eq(loadRoomMobMem(db, 'nope'), {}, '★ 读不存在的房间 ⇒ {}');

  /* 负对照 2:空记忆往返仍是空(不是 null / 不是 undefined)。 */
  eq(saveRoomMobMem(db, 'r1', {}, 5000), 1, '空记忆也能落库');
  eq(loadRoomMobMem(db, 'r1'), {}, '★ 空记忆读回 {}');
});

test('FND144-3 loadRoomMobMem 容错:坏 JSON / 非对象 / 非对象条目各走降级,绝不让整间房读不回来', () => {
  const db = mkDb();

  /* 负对照 1:非法 JSON ⇒ {} (不抛)。存档是外部输入,截断/手改都可能发生。 */
  db.update('rooms', { id: 'r1' }, { mob_mem_json: '{不是 JSON' });
  eq(loadRoomMobMem(db, 'r1'), {}, '★ 坏 JSON ⇒ 空记忆(不是抛错 —— 一个坏字段不该拖垮整间房)');

  /* 负对照 2:JSON 合法但顶层是数组 ⇒ {}(mem 的契约是 map,不是 list)。 */
  db.update('rooms', { id: 'r1' }, { mob_mem_json: '[]' });
  eq(loadRoomMobMem(db, 'r1'), {}, '★ 顶层数组 ⇒ 空记忆');

  /* 负对照 3:JSON `null` ⇒ 空。 */
  db.update('rooms', { id: 'r1' }, { mob_mem_json: 'null' });
  eq(loadRoomMobMem(db, 'r1'), {}, '★ 顶层 null ⇒ 空记忆');

  /* 负对照 4:空串 ⇒ 空(短路在 JSON.parse 之前)。 */
  db.update('rooms', { id: 'r1' }, { mob_mem_json: '' });
  eq(loadRoomMobMem(db, 'r1'), {}, '★ 空串 ⇒ 空记忆');

  /* ★ 逐条过滤:非 plain object 的条目单独丢弃,合法条目**照常保留**。
     这条比「整段丢弃」更严:坏一条不该让同房间别的生物失忆。 */
  db.update('rooms', { id: 'r1' }, {
    mob_mem_json: JSON.stringify({ a: 1, b: { hp: 5 }, c: null, d: [1, 2], e: { hp: 9 } }),
  });
  eq(loadRoomMobMem(db, 'r1'), { b: { hp: 5 }, e: { hp: 9 } },
    '★ 只留 plain object:数值 / null / 数组被逐条滤掉,合法条目不受牵连');

  /* 负对照 5:读出的对象不与库里的 JSON 共享引用(改它不该「改到存档」)。 */
  const first = loadRoomMobMem(db, 'r1');
  first.b.hp = -1;
  eq(loadRoomMobMem(db, 'r1').b, { hp: 5 }, '★ 返回的是副本:改返回值不污染存档');
});

/* ═══════════════ 3. net/anticheat.ts:428 decayScore ═══════════════ */

test('FND144-4 decayScore:扣到 0 即止(不为负)、返回值即新分、踢出闩锁不被衰减抹掉', () => {
  eq(VIOLATION_SCORE_DECAY_PER_TICK, 0.02, '锚点:每帧衰减 0.02(手册/阈值表)');
  eq(VIOLATION_SCORE_KICK, 12, '锚点:12 分即踢出');

  const s = createAcState('p1', 0);
  eq(s.score, 0, '前置:新玩家 0 分');

  /* 正对照:0 分衰减后仍是 0(不是 -0.02)。 */
  eq(decayScore(s), 0, '★ 0 分不会被衰减成负数(否则「偶发抖动」会变成负分返还)');
  eq(s.score, 0, '字段与返回值一致');

  /* 正对照:0.05 → 0.03,返回值就是写回的那个数(调用方不必再读一次字段)。 */
  s.score = 0.05;
  const once = decayScore(s);
  near(once, 0.03, 1e-12, '0.05 扣 0.02 = 0.03');
  eq(once, s.score, '★ 返回值 === s.score(不是扣之前的旧值)');

  /* 负对照 1:不足一个衰减量 ⇒ 夹到 0,不为负。 */
  s.score = 0.01;
  eq(decayScore(s), 0, '★ 0.01 < 0.02 ⇒ 夹到 0,而不是 -0.01');

  /* 负对照 2:大量重复调用(长在线)⇒ 单调不增且全程 ≥ 0。 */
  s.score = 5;
  let prev = s.score;
  for (let i = 0; i < 1000; i += 1) {
    const now = decayScore(s);
    ok(now >= 0, `第 ${i + 1} 次衰减后为负:${now}`);
    ok(now <= prev + 1e-12, `第 ${i + 1} 次衰减后**变大**了:${prev} → ${now}`);
    prev = now;
  }
  eq(s.score, 0, '★ 251 次以上必然归零(5 / 0.02);1000 次仍恰为 0');

  /* ★ 负对照 3(核心):`kicked` 是闩锁,衰减**不**解除它。
     否则「攒到 12 分被踢」的玩家只要在线熬若干秒就自动解封。 */
  const k = createAcState('p2', 0);
  for (let i = 0; i < 3; i += 1) {
    const v = checkMove(k, { tick: 1, x: 100, y: 0, z: 0 });
    eq(v.allowed, false, `第 ${i + 1} 次瞬移被拒`);
    eq(v.violation?.kind, ViolationKind.TELEPORT, '拒因是 TELEPORT');
  }
  eq(k.score, 3 * VIOLATION_WEIGHT.TELEPORT, '3 次瞬移 = 3 × 4 = 12 分');
  eq(k.kicked, true, '★ 攒到阈值 ⇒ 已标记踢出');
  for (let i = 0; i < 600; i += 1) decayScore(k);
  ok(k.score < 1e-9, `★ 衰减把分扣光(浮点残留 ${k.score})`);
  eq(k.kicked, true, '★★ 但 kicked 仍是 true —— 衰减清的是**分数**,不是**事实**');
  eq(k.violations.length, 3, '★ 违规流水也不被衰减删掉(那是归因证据)');
});

/* ═══════ 4. net/anticheat.ts:478/494 snapshot / restoreMoveWindow ═══════ */

test('FND144-5 snapshot/restoreMoveWindow:世界拒收后整组回滚;深拷贝;不碰 score', () => {
  const s = createAcState('p1', 0, 0, 0);
  eq(snapshotMoveWindow(s), { lastX: 0, lastY: 0, lastZ: 0, lastMoveTick: 0, window: [{ tick: 0, x: 0, y: 0 }] },
    '前置:快照就是 `checkMove` 会改动的那五项,窗口逐点拷贝');

  /* 真调用:一次合法移动会把三件事一起推进。 */
  advanceServerClock(s, 1);
  eq(checkMove(s, { tick: 1, x: 0.01, y: 0, z: 0 }).allowed, true, '前置:小步移动被放行');
  eq(s.lastX, 0.01, '水位推进到申报坐标');
  eq(s.lastMoveTick, 1, '申报水位推进');
  eq(s.window.length, 2, '窗口入队一帧');

  const snap = snapshotMoveWindow(s);
  /* 再来一步 —— 模拟「世界拒收」前的推进。 */
  advanceServerClock(s, 2);
  eq(checkMove(s, { tick: 2, x: 0.02, y: 0, z: 0 }).allowed, true, '第二步也放行');
  eq(s.window.length, 3, '窗口 3 帧');

  /* ★ 核心:回滚到「第二步之前」,三者必须**一起**回到原值。 */
  restoreMoveWindow(s, snap);
  eq(s.lastX, 0.01, '★ lastX 回滚');
  eq(s.lastY, 0, '★ lastY 回滚');
  eq(s.lastZ, 0, '★ lastZ 回滚');
  eq(s.lastMoveTick, 1, '★ lastMoveTick 回滚');
  eq(s.window, [{ tick: 0, x: 0, y: 0 }, { tick: 1, x: 0.01, y: 0 }], '★ 窗口回滚(不是残留 3 帧)');

  /* ★ 行为后果:同一个意图**重放**仍然合法 ⇒ 水位真的回退了,不是「假回滚」。 */
  const replay = checkMove(s, { tick: 2, x: 0.02, y: 0, z: 0 });
  eq(replay.allowed, true, '★ 回滚后重放这一步仍放行(修前:窗口已推到幻影坐标 ⇒ 合法玩家被误判)');
  eq(s.window.length, 3, '重放只入队一帧(不是 4)');

  /* ★ 负对照 1:深拷贝 —— 窗口是逐点新对象,与状态不共享引用。
     共享引用会被 `checkMove` 里的 `shift()` 悄悄改掉,快照于是自我失效。 */
  const s2 = createAcState('p2', 3, 1, 2);
  const sn = snapshotMoveWindow(s2);
  ok(sn.window !== s2.window, '★ 窗口是另一个数组');
  ok(sn.window[0] !== s2.window[0], '★ 元素也是新对象(不是同一个引用)');
  sn.window[0].x = 999;
  eq(s2.window[0].x, 1, '★ 改快照不改状态');
  s2.window[0].y = 777;
  eq(sn.window[0].y, 2, '★ 改状态不改快照');
  restoreMoveWindow(s2, sn);
  ok(s2.window !== sn.window, 'restore 也是拷贝写入(不是把快照数组塞回去)');
  sn.window[0].x = -5;
  eq(s2.window[0].x, 999, '★ restore 之后改快照仍不改状态');

  /* ★ 负对照 2:回滚**不含** score / violations(那是判定的事实,不是位置事实)。 */
  const s3 = createAcState('p3', 0, 0, 0);
  eq(checkMove(s3, { tick: 1, x: 100, y: 0, z: 0 }).allowed, false, '前置:一次瞬移被拒');
  eq(s3.score, VIOLATION_WEIGHT.TELEPORT, '前置:记 4 分');
  eq(s3.violations.length, 1, '前置:流水 1 条');
  const sn3 = snapshotMoveWindow(s3);
  eq(sn3.window, [{ tick: 0, x: 0, y: 0 }], '前置:被拒的包**没有**入队(判定失败不改窗口)');
  advanceServerClock(s3, 2);
  eq(checkMove(s3, { tick: 2, x: 0.01, y: 0, z: 0 }).allowed, true, '前置:合法移动推进窗口');
  eq(s3.window.length, 2, '前置:窗口 2 帧');
  restoreMoveWindow(s3, sn3);
  eq(s3.window.length, 1, '★ 窗口回滚');
  eq(s3.score, VIOLATION_WEIGHT.TELEPORT, '★★ score **不**回滚(否则「回滚」= 洗白违规)');
  eq(s3.violations.length, 1, '★★ violations 同样保留');

  /* 负对照 3:重复回滚幂等 —— 不会把窗口越滚越短/越长。 */
  restoreMoveWindow(s3, sn3);
  restoreMoveWindow(s3, sn3);
  eq(s3.window, [{ tick: 0, x: 0, y: 0 }], '★ 三次回滚结果相同(幂等)');
});

test('FND144-6 restoreMoveWindow 是**逐字回写**,不做单调夹取 ⇒ 只能用「本次移动前」那一份', () => {
  const s = createAcState('p1', 0, 0, 0);
  const oldSnap = snapshotMoveWindow(s); /* tick 0 */
  /* ⚠️ `checkMove` 的额度同时受**服务端时钟**夹取(`maxMoveCatchupTicks = 1`),
     所以每一步都要先像 `AntiCheatRoom.tick()` 那样推进 `s.lastTick` —— 否则第二个包
     的 `dtTicks` 恒为 0,连合法小步都会被判瞬移。这也是本套件第一次跑红的原因。 */
  for (let t = 1; t <= 9; t += 1) {
    advanceServerClock(s, t);
    eq(checkMove(s, { tick: t, x: t * 0.01, y: 0, z: 0 }).allowed, true, `第 ${t} 步放行`);
  }
  eq(s.lastMoveTick, 9, '前置:水位到 9');
  eq(s.window.length, 10, '前置:窗口 10 帧');

  /* 负对照 0:此刻再申报**已经用过**的 tick 1,拿不到额度 ⇒ 带位移即拒。 */
  const reused = checkMove(s, { tick: 1, x: 0.05, y: 0, z: 0 });
  eq(reused.allowed, false, '★ 用过的 tick 拿不到额度(dtTicks = 0)⇒ 带位移必须拒');
  eq(reused.violation?.kind, ViolationKind.TELEPORT, '拒因 TELEPORT(位移非零但额度为 0)');

  restoreMoveWindow(s, oldSnap);
  eq(s.lastMoveTick, 0, '★ 回写到快照里的 0(不是「夹到不低于当前」——那是另一份语义)');
  eq(s.window.length, 1, '窗口也回到 1 帧');
  eq(s.lastTick, 9, '★ 服务端时钟**不在**快照里(restore 只回滚「已用额度」,不动时钟)');

  /* 后果:陈旧快照把额度真的还了回去 —— 同一条报文、同一个 tick,
     回滚前被拒,回滚后**放行**。这就是「快照必须取自本次移动前」的硬理由。 */
  const replayed = checkMove(s, { tick: 1, x: 0.05, y: 0, z: 0 });
  eq(replayed.allowed, true,
    '★★ 同一报文同一 tick:回滚到陈旧快照后重新放行 ⇒ 陈旧快照 = 把额度还给攻击者');
  eq(s.lastMoveTick, 1, '重放后水位才回到 1');
});

/* ═══════ 5. net/anticheat.ts:849/879 previewAttack / commitAttack ═══════ */

test('FND144-7 previewAttack 不推进水位;commitAttack 才推进且单调;拒绝绝不提交', () => {
  const s = createAcState('p1', 0);
  eq(s.lastAttackTick, -9999, '前置:开局哨兵值(远早于任何真实 tick)');

  /* ★ 核心:判定放行后水位**不动** —— 结算成不成功还不知道。 */
  eq(previewAttack(s, 100).allowed, true, '首次攻击放行');
  eq(s.lastAttackTick, -9999, '★★ preview 不推进 lastAttackTick(修前是先提交后结算,8 帧白占)');
  eq(s.score, 0, '放行不记违规');

  /* 负对照:没提交 ⇒ 再来一次仍放行。这是「两步分离」的代价,必须显式钉住:
     调用方漏掉 commit ⇒ 攻速闸形同虚设。 */
  eq(previewAttack(s, 100).allowed, true, '★ 未提交 ⇒ 重复判定仍放行(所以 commit 是**必需**的第二步)');
  eq(s.violations.length, 0, '两次放行都不产生流水');

  commitAttack(s, 100);
  eq(s.lastAttackTick, 100, '★ commit 才把水位推到本次 tick');

  /* 负对照 1:间隔不够 ⇒ 拒,且**水位不动**(否则连点两次被拒会让水位越推越远)。 */
  const bad = previewAttack(s, 101);
  eq(bad.allowed, false, '★ 1 帧 < 8 帧 ⇒ 拒');
  eq(bad.violation?.kind, ViolationKind.ATTACK_RATE, `拒因应为 ATTACK_RATE(实测 ${String(bad.violation?.kind)})`);
  eq(bad.violation?.weight, VIOLATION_WEIGHT.ATTACK_RATE, '权重取自唯一阈值表');
  ok((bad.violation?.detail ?? '').includes('攻击间隔'), `理由要能定位,实际 ${JSON.stringify(bad.violation?.detail)}`);
  eq(s.score, VIOLATION_WEIGHT.ATTACK_RATE, '★ 违规照记(ATTACK_RATE 是事实,与结算成不成功无关)');
  eq(s.lastAttackTick, 100, '★★ 被拒后水位仍是 100(拒绝不提交)');

  /* 负对照 2:边界含等号 —— 恰好 8 帧放行,少一点点就拒。 */
  eq(BASE_ATTACK_INTERVAL_S, 0.4, '锚点:基线 0.4s = 8 帧 @20Hz');
  const b = createAcState('p2', 0);
  commitAttack(b, 0);
  eq(previewAttack(b, 8).allowed, true, '★ 恰好 8 帧 ⇒ 放行(边界是「≥」)');
  eq(previewAttack(b, 7.999).allowed, false, '★★ 差 0.001 帧 ⇒ 拒(边界不是「>」)');
  eq(b.lastAttackTick, 0, '两次都只判定,水位没动');

  /* 负对照 3:单调 —— 申报一个更小的 tick 不许把水位往回拉。 */
  const m = createAcState('p3', 0);
  commitAttack(m, 100);
  eq(m.lastAttackTick, 100, '前置:水位 100');
  commitAttack(m, 50);
  eq(m.lastAttackTick, 100, '★★ 回退申报不许把水位拉回去(否则申报小 tick 即可重置冷却)');
  commitAttack(m, 200);
  eq(m.lastAttackTick, 200, '前进正常');

  /* 负对照 4:水位只由 commit 写 —— 连续 commit 同一 tick 是幂等的。 */
  const i = createAcState('p4', 0);
  commitAttack(i, 40);
  commitAttack(i, 40);
  commitAttack(i, 40);
  eq(i.lastAttackTick, 40, '★ 同 tick 重复提交不动(幂等)');
  eq(previewAttack(i, 48).allowed, true, '满 8 帧放行');
  eq(previewAttack(i, 47.99).allowed, false, '不足 8 帧仍拒');
});

test('FND144-8 攻速加成:NaN / 非数值 / -Inf 必须回落「未声明」,**不许 fail-open**', () => {
  eq(MAX_ATTACK_SPEED_BONUS, 1.0, '锚点:攻速加成上限 1.0(2× 攻速)');

  const s = createAcState('p1', 0);
  commitAttack(s, 0);

  /* 正对照:满加成 ⇒ 间隔减半到 4 帧。 */
  eq(previewAttack(s, 4, MAX_ATTACK_SPEED_BONUS).allowed, true, '满加成 ⇒ 4 帧即可');
  eq(previewAttack(s, 3.99, MAX_ATTACK_SPEED_BONUS).allowed, false, '负对照:3.99 帧仍不够');
  eq(previewAttack(s, 5, 5).allowed, true, '超上限的声明被钳到 1.0(仍是 4 帧)');

  /* ★★ 核心负对照:非法声明不许让 `minInterval` 变 NaN。
     `since < NaN` 恒 false ⇒ 同帧 10 连发全放行(CR-14 U2-b 的原形态)。 */
  eq(previewAttack(s, 4, Number.NaN).allowed, false,
    '★★ NaN 加成 ⇒ 回落「未声明」= 8 帧 ⇒ 4 帧必须拒(否则整道闸静默失效)');
  eq(previewAttack(s, 4, 'abc' as unknown as number).allowed, false,
    '★ 字符串声明 ⇒ 同样回落(TS 标注不产生运行时校验)');
  eq(previewAttack(s, 4, Number.NEGATIVE_INFINITY).allowed, false,
    '★ −Inf ⇒ 回落,不夹成 0(夹 0 = allowed 0 ⇒ 每次移动都判瞬移,自我锁死)');
  eq(previewAttack(s, 4, Number.POSITIVE_INFINITY).allowed, true,
    '★ +Inf ⇒ 钳到上限(「申请最大加成」是安全的,与既有行为一致)');

  /* 非法声明产生的拒必须**归因到 ATTACK_RATE**(不是别处),且分数照记。 */
  eq(s.violations.length, 4, '4 次被拒(3.99 / NaN / 字符串 / −Inf)');
  eq(s.score, 4 * VIOLATION_WEIGHT.ATTACK_RATE, '每次 2 分,共 8 分');
  eq(s.lastAttackTick, 0, '★ 全程水位仍是 0(判定不提交)');

  /* 负对照:注入自定义 limits ⇒ 阈值真的从注入值算,不是硬编码。 */
  const L = { ...DEFAULT_LIMITS, baseAttackIntervalS: 1.0, maxAttackSpeedBonus: 0 };
  const c = createAcState('p2', 0);
  commitAttack(c, 0);
  eq(previewAttack(c, 19, 0, L).allowed, false, '★ 1.0s @20Hz = 20 帧:19 帧不够');
  eq(previewAttack(c, 20, 0, L).allowed, true, '★ 20 帧放行(阈值随注入的 limits 走)');
  eq(previewAttack(c, 20, 1.0, L).allowed, true, 'maxAttackSpeedBonus = 0 ⇒ 加成被钳成 0,不影响 20 帧判定');

  /* 合体形态 `checkAttack`:放行即提交,拒绝不提交 —— 攻击/回滚路径的对照基准。 */
  const k = createAcState('p3', 0);
  eq(checkAttack(k, 100).allowed, true, '合体形态放行');
  eq(k.lastAttackTick, 100, '★ checkAttack 放行后**立即**提交(它就是给「判定即生效」的调用方用的)');
  const kd = checkAttack(k, 101);
  eq(kd.allowed, false, '紧接着的一次被拒');
  eq(k.lastAttackTick, 100, '★★ 拒绝不提交 ⇒ 下一次合法攻击的冷却不会被白占');
});

/* ═══════════════ 7. mobs/spawner.ts:324 MobSpawner ═══════════════ */

test('FND144-9 MobSpawner.canSpawn:六道闸逐一真跑(全局/安全区/硬上限/软上限衰减/阻挡/夜行)', () => {
  eq(GLOBAL_MOB_CAP, 200, '锚点:全局硬上限 200');
  const ctx = {
    biome: 'MEADOW', x: 0, y: 0, biomeCount: 0, globalCount: 0, mobId: 'mob_boar',
  };
  const sp = new MobSpawner();
  const open = stubWorld();

  /* 正对照:空旷草地、白天、未达上限 ⇒ 刷。 */
  eq(sp.canSpawn(ctx, open, 0.9), true, '前置:空旷草地可以刷');
  eq(decideSpawn(ctx, open, 0.9), { spawn: true, reason: SpawnReject.OK }, '理由码是 OK');

  /* 闸 1:全局硬上限 —— 压过其他一切条件(短路在最前)。 */
  eq(sp.canSpawn({ ...ctx, globalCount: GLOBAL_MOB_CAP }, open, 0.9), false, '★ 全局满 ⇒ 拒');
  eq(decideSpawn({ ...ctx, globalCount: GLOBAL_MOB_CAP }, open, 0.9).reason, SpawnReject.GLOBAL_CAP,
    '★ 拒因必须是 GLOBAL_CAP(归因不能混)');
  eq(sp.canSpawn({ ...ctx, globalCount: GLOBAL_MOB_CAP - 1 }, open, 0.9), true, '负对照:199 仍可刷');

  /* 闸 2:城镇安全区(中心 24 格,含边界)。 */
  const inTown = stubWorld({ townCenter: () => ({ x: 0, y: 0 }) });
  eq(sp.canSpawn(ctx, inTown, 0.9), false, '★ 安全区内 ⇒ 拒');
  eq(decideSpawn(ctx, inTown, 0.9).reason, SpawnReject.SAFE_ZONE, '拒因 SAFE_ZONE');
  eq(sp.canSpawn({ ...ctx, x: 24, y: 0 }, inTown, 0.9), false, '★ 半径边界(24 格)仍算区内');
  eq(sp.canSpawn({ ...ctx, x: 25, y: 0 }, inTown, 0.9), true, '负对照:25 格已出区 ⇒ 可刷');

  /* 闸 3:群系硬上限。 */
  const hard = BIOME_SPAWN.MEADOW.hardCap;
  eq(hard, 14, '锚点:MEADOW hardCap = 14');
  eq(sp.canSpawn({ ...ctx, biomeCount: hard }, open, 0.9), false, '★ 达硬上限 ⇒ 拒');
  eq(decideSpawn({ ...ctx, biomeCount: hard }, open, 0.9).reason, SpawnReject.HARD_CAP, '拒因 HARD_CAP');
  eq(sp.canSpawn({ ...ctx, biomeCount: hard - 1 }, open, 0.9), true, '负对照:差 1 只仍可刷');

  /* 闸 4:软上限概率减半(roll < 0.5 才拒)。 */
  const soft = BIOME_SPAWN.MEADOW.softCap;
  eq(soft, 8, '锚点:MEADOW softCap = 8');
  eq(sp.canSpawn({ ...ctx, biomeCount: soft }, open, 0.1), false, '★ 软上限 + roll<0.5 ⇒ 拒');
  eq(decideSpawn({ ...ctx, biomeCount: soft }, open, 0.1).reason, SpawnReject.SOFT_DAMPED, '拒因 SOFT_DAMPED');
  eq(sp.canSpawn({ ...ctx, biomeCount: soft }, open, 0.5), true, '★ 负对照:roll=0.5 已不算「<0.5」⇒ 放行(只是概率减半)');
  eq(sp.canSpawn({ ...ctx, biomeCount: soft }, open, 0.9), true, '负对照:roll=0.9 放行');

  /* 闸 5:地形阻挡。 */
  const blocked = stubWorld({ blocked: () => true });
  eq(sp.canSpawn(ctx, blocked, 0.9), false, '★ 被阻挡 ⇒ 拒');
  eq(decideSpawn(ctx, blocked, 0.9).reason, SpawnReject.OBSTRUCTED, '拒因 OBSTRUCTED');

  /* 闸 6:夜行怪白天不刷(同一坐标/同一 roll,只换 mobId ⇒ 归因可分辨)。 */
  const bat = { ...ctx, mobId: 'mob_bat_sonic' };
  eq(sp.canSpawn(bat, open, 0.9), false, '★ 夜行怪白天 ⇒ 拒');
  eq(decideSpawn(bat, open, 0.9).reason, SpawnReject.DAYLIGHT, '拒因 DAYLIGHT');
  eq(sp.canSpawn(bat, stubWorld({ isNight: () => true }), 0.9), true, '★ 负对照:同一只夜晚可刷');

  /* 负对照:未知群系回落到 MEADOW 配置(但计数记在自己的 key 上)——
     所以硬上限按 MEADOW 14 判,而不是「无上限」。 */
  eq(sp.canSpawn({ ...ctx, biome: 'NO_SUCH_BIOME', biomeCount: 14 }, open, 0.9), false,
    '★ 未知群系回落 MEADOW 配置 ⇒ 14 也触硬上限');
});

test('FND144-10 MobSpawner.add:未知群系回落到 MEADOW 上限,**全局 200 是最后一道闸**', () => {
  const sp = new MobSpawner();

  /* 负对照 1:n = 0 不加也不报错(调用方传 0 是合法 no-op)。 */
  eq(sp.add('MEADOW', 0), true, 'n = 0 ⇒ 返回 true 且不改状态');
  eq(sp.state.globalCount, 0, '全局仍 0');
  eq(sp.state.biomeCounts.get('MEADOW') ?? 0, 0, '群系仍 0');

  /* 负对照 2:满额一次加满 = 边界放行,多 1 则拒。 */
  const hard = BIOME_SPAWN.MEADOW.hardCap;
  eq(sp.add('MEADOW', hard), true, '★ 一次加满 hardCap(=14)⇒ 放行');
  eq(sp.state.biomeCounts.get('MEADOW'), hard, '计数到 14');
  eq(sp.add('MEADOW', 1), false, '★ 再多 1 只 ⇒ false');
  eq(sp.state.biomeCounts.get('MEADOW'), hard, '★ 被拒时计数**不涨**(否则上限形同虚设)');

  /* 未知群系:用 MEADOW 的 hardCap,但记在自己的 key 上 —— 于是**只能**靠全局 200 兜住。 */
  const sp2 = new MobSpawner();
  for (const b of Object.keys(BIOME_SPAWN)) {
    eq(sp2.add(b, BIOME_SPAWN[b].hardCap), true, `前置:${b} 加到 hardCap`);
  }
  const sumCaps = Object.values(BIOME_SPAWN).reduce((s, c) => s + c.hardCap, 0);
  eq(sumCaps, 111, '锚点:八个群系 hardCap 合计 111(=14+14+16+12+15+13+9+18)');
  eq(sp2.state.globalCount, sumCaps, '前置:全局 = 各群系 hardCap 之和');

  const remaining = GLOBAL_MOB_CAP - sp2.state.globalCount;
  eq(remaining, 89, '前置:距全局上限还剩 89');
  let k = 0;
  while (sp2.state.globalCount + BIOME_SPAWN.MEADOW.hardCap <= GLOBAL_MOB_CAP) {
    eq(sp2.add(`GHOST_${k}`, BIOME_SPAWN.MEADOW.hardCap), true, `未知群系 GHOST_${k} 各拿 MEADOW 的额度`);
    k += 1;
  }
  eq(k, 6, '★ 未知群系能吃掉 6 × 14 = 84(⇒ 全局闸必须存在)');
  const left = GLOBAL_MOB_CAP - sp2.state.globalCount;
  eq(sp2.add('LAST', left), true, '★ 恰好补到 200 ⇒ 放行(边界含等号)');
  eq(sp2.state.globalCount, 200, '★ 全局计数 = 200(期望值写字面量,常量本身在上面另锚)');
  eq(sp2.add('LAST', 1), false, '★★ 再多 1 只 ⇒ false(全局硬上限是最后一道闸)');
  eq(sp2.state.globalCount, 200, '★ 被拒时全局计数不涨(仍是 200)');

  /* 不变量:`globalCount === Σ biomeCounts`(add 侧)。 */
  let sum = 0;
  for (const n of sp2.state.biomeCounts.values()) sum += n;
  eq(sp2.state.globalCount, sum, '★ 全局 === 各群系之和');

  /* 全局已满 ⇒ canSpawn 一律拒(接线到真判定,不停在计数器上)。 */
  eq(sp2.canSpawn({
    biome: 'MEADOW', x: 0, y: 0, biomeCount: 0, globalCount: sp2.state.globalCount, mobId: 'mob_boar',
  }, stubWorld(), 0.9), false, '★ 全局满 200 ⇒ canSpawn 直接拒');
});

/* ═══════════════ 8. world/chunk.ts:456 assertRoofId ═══════════════ */

test('FND144-11 assertRoofId:12 位值域的唯一口径(边界放行 / 越界抛 RangeError)', () => {
  eq(ROOF_ID_MAX, 4095, '锚点:ROOF 层 12 位 ⇒ 上界 4095');
  eq(ROOF_BITS, 12, '锚点:位宽 12');

  /* 正对照:两端都在域内,且**返回值就是入参**(它是可判定的转发,不是「校验+转换」)。 */
  eq(assertRoofId(0, 't'), 0, '下界 0 放行');
  eq(assertRoofId(4095, 't'), 4095, '★ 上界 4095 放行(边界含等号)');
  eq(assertRoofId(384, 't'), 384, '手册里的屋顶构件 ID 放行');

  /* 负对照 1:上界 +1 —— 12 位装不下。 */
  expectRange(() => assertRoofId(4096, 't'), '12 位', '★ 4096 必须抛 RangeError');
  /* 负对照 2:16 位满值(修前 `& 0xffff` 正是把它静默收下)。 */
  expectRange(() => assertRoofId(65535, 't'), '12 位', '★ 65535 必须抛(修前被 & 0xffff 放过)');
  /* 负对照 3:负数 / 非整数 / 非有限数 —— 都不是合法 ID,且不许被 `|0` 悄悄截断。 */
  expectRange(() => assertRoofId(-1, 't'), '12 位', '★ -1 必须抛');
  expectRange(() => assertRoofId(1.5, 't'), '12 位', '★ 非整数必须抛(截断会造出「合法」的假象)');
  expectRange(() => assertRoofId(Number.NaN, 't'), '12 位', '★ NaN 必须抛');
  expectRange(() => assertRoofId(Number.POSITIVE_INFINITY, 't'), '12 位', '★ Infinity 必须抛');

  /* 归因:`where` 是**真参数**,必须出现在理由里(否则不知道哪条路漏了校验)。 */
  expectRange(() => assertRoofId(4096, 'Chunk.setRoof'), 'Chunk.setRoof', '★ 理由要带调用点');
  expectRange(() => assertRoofId(4096, 'decodeRoofRle 偏移 3'), 'decodeRoofRle 偏移 3', '★ 理由要带偏移');
});

test('FND144-12 decodeRoofRle(读口)真的过 assertRoofId:越界抛且**不半截写入**', () => {
  /* 前置:空 chunk 的目标数组。 */
  const into = new Uint16Array(2);
  eq([...into], [0, 0], '前置:目标为空');

  /* 正对照:4095 走 `0xff vL vH` 非零游程 ⇒ 落进目标。 */
  decodeRoofRle(Uint8Array.from([0xff, 0xff, 0x0f]), into);
  eq(into[0], 4095, '★ 4095 正确解码(小端 0x0fff)');

  /* ★ 核心负对照:4096(0x1000)在**读口**必须抛 —— 修前 `& 0xffff` 收下,`roofAt()` 会读回 12 位之外的值。 */
  const into2 = new Uint16Array(2);
  expectRange(() => decodeRoofRle(Uint8Array.from([0xff, 0x00, 0x10]), into2), '12 位',
    '★★ 4096 必须抛(快照/回滚路径走的正是这里)');
  eq(into2[0], 0, '★★ 越界时**一格都没写**(先判后写,不留半截状态)');

  /* 负对照:65535 同样抛。 */
  expectRange(() => decodeRoofRle(Uint8Array.from([0xff, 0xff, 0xff]), new Uint16Array(1)), '12 位',
    '★ 65535 必须抛');

  /* 负对照:前一个合法值已写入、后一个越界 ⇒ 抛,且已写的那格保持原样(不做「尽力恢复」)。 */
  const into3 = new Uint16Array(3);
  expectRange(() => decodeRoofRle(Uint8Array.from([0xff, 0x01, 0x00, 0xff, 0x00, 0x10]), into3), '12 位',
    '★ 第二个值越界 ⇒ 抛');
  eq(into3[0], 1, '第一个合法值已落盘(抛点在第二个值上,不是整段先校验)');

  /* 负对照:截断的 0xff 游程 ⇒ RangeError(不许把 undefined 折成 0 伪装成「没有屋顶」)。 */
  expectRange(() => decodeRoofRle(Uint8Array.from([0xff, 0x01]), new Uint16Array(1)), '截断',
    '★ 截断游程必须抛,不许静默写 0');

  /* 往返:编码 → 解码逐格一致(编码侧 `v & 0xff` 分高低字节,解码侧再拼回)。 */
  const src = Uint16Array.from([0, 4095, 0, 7, 384, 0]);
  const back = new Uint16Array(src.length);
  decodeRoofRle(encodeRoofRle(src), back);
  eq([...back], [...src], '★ 往返逐格一致(含 0 游程与非零混排)');
});

report('WS-FND-144');