/**
 * task-70 读档恢复的**跨层集成测试**(契约 `TASK47-LAYER-WIRING-CONTRACT.md` §9)。
 *
 * ## 为什么必须跨层、且只走 `assemble()`
 *
 * 本仓的「8 例测试全绿 + 生产零消费」共同形态是:**测试手动装配,生产没装**。
 * ⇒ 故本文件只用 `assemble()`(唯一被断言覆盖的生产装配入口),
 *   绝不 `rt.worldSaveHost = sim`。
 *
 * ## 覆盖的验收
 *
 * ```
 * 1 `loadReconnectSnapshot` 有**真调用点**        ⇒ T5(断链判据:≥3 处且含真调用)
 * 2 恢复后**两侧一致**(权威 与 投影)          ⇒ T3
 * 3 ★ 反向注入:改脏 state ⇒ 下一帧被权威覆盖  ⇒ T4
 * 4 `driver.sqlite.ts` + `memory_db.ts` 进可达闭包 ⇒ T0 + T2
 * 5 每消一条欠账配套一条跨层集成测试            ⇒ 本文件
 * ```
 *
 * ⚠️ 验收 2 的判据**必须同时断言两侧** —— 只断言投影会被「直写 state」骗过
 * (那样投影对,而权威没恢复;下次重连就丢了)。
 */
import { readFileSync } from 'node:fs';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { assemble } from '../server/src/index.ts';
import {
  migrate, createUser, RoomRole,
  saveReconnectSnapshot, loadReconnectSnapshot, upsertRoomPlayer,
} from '../server/src/db/repo.ts';
import { encodeFull, decodePacket } from '../shared/net/delta.ts';
import { EntityKind } from '../shared/types/wire.ts';

const T0 = 1_700_000_000_000;

/**
 * 一份干净的库(用户已建)。
 *
 * ⚠️ **不建房间** —— `RoomRuntime` 的构造器自己会 `createRoom`
 * (room.ts:804-815),重复建会抛「房间已存在」。我第一版在这里建了,
 * 于是 11 条全红、而报错看起来像"装配失败"(其实是我夹具的错)。
 */
function freshDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: 'u_owner', displayName: '房主', nowMs: T0 });
  createUser(db, { id: 'p1', displayName: '甲', nowMs: T0 });
  return db;
}

/** 生产路径装配(与 `index.ts` 的 rtOpts 同参)。 */
function boot(db: MemoryDb) {
  return assemble({ roomId: 'room_a', ownerId: 'u_owner', db, sizeCells: 8 });
}

/**
 * 把权威设成 30 级 / 535 血 / 位置 (7,9),返回该玩家当前的**投影快照字节**。
 *
 * ## ★ 必须走 `restoreFromProfile`(而不是直接 `syncMaxHp(535)`)
 *
 * 我第一版直接 `host.syncMaxHp('p1', 535)`,结果 `step()` 后权威又被**打回 100**。
 * 原因不是缺陷,是**正确行为**:
 * ```
 * progresses 里没有 p1 的档案 ⇒ levelOf('p1') = 1
 * ⇒ 每帧 projectAllPlayers 用 statsAtLevel(1).maxHp = 100 调 syncMaxHp
 * ⇒ 策略 C 把 hp 从 535 钳回 100
 * ```
 * ⇒ 即:**等级是上限的唯一来源**,`maxHp` 不能脱离 `level` 单独设。
 *   这正是本任务要接的那条链路 —— 故夹具也必须走同一条路,
 *   否则测的是「我手写的值」而非「系统的行为」(陷阱 74:测试替身不忠实)。
 */
function seedAndSnapshot(
  host: ReturnType<typeof boot>['host'],
  rt: ReturnType<typeof boot>['runtime'],
  weaponId?: number,
): Uint8Array {
  const applied = host.restoreFromProfile?.('p1', {
    level: 30, hp: 535, x: 7, y: 9, z: 0,
    ...(weaponId === undefined ? {} : { weaponId }),
  });
  ok(applied !== undefined && applied >= 1, 'seed:restoreFromProfile 生效(夹具走生产通路)');
  rt.step();
  return encodeFull(rt.state, rt.state.meta.tick).bytes;
}

test('T0 装配:assemble({db}) 给出 host 与 db,且 restoreFromProfile **未被结构裁掉**', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  ok(runtime.db !== null, 'runtime.db 非 null(验收 4 的前半)');
  ok(runtime.worldSaveHost !== null, 'runtime.worldSaveHost 由 assemble 赋值(不是手动)');
  /* ★ 通路存在性:接口忘了声明该方法时,`host.restoreFromProfile` 在**类型上**
     不存在(结构裁掉),而运行期还在 —— 故运行期也要断言一次。 */
  ok(typeof runtime.worldSaveHost?.restoreFromProfile === 'function',
    'host 暴露 restoreFromProfile(通路存在)');
  ok(typeof host.restoreFromProfile === 'function', '装配产物的 host 本身有该方法');
});

test('T1 权威 30 级 / 535 血 ⇒ maxHpForLevel=535,且投影跟上', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  const derived = host.maxHpForLevel?.('p1', 30);
  eq(derived, 535, 'maxHpForLevel(30) = 535(唯一算子 statsAtLevel)');
  seedAndSnapshot(host, runtime);
  eq(host.vitalsOf?.('p1')?.maxHp, 535, '权威 maxHp = 535');
  eq(host.vitalsOf?.('p1')?.hp, 535, '权威 hp = 535');
  const p = runtime.state.players.find((x) => x.id === 'p1')!;
  eq(p.maxHp, 535, '投影 maxHp = 535');
  eq(p.level, 30, '投影 level = 30');
});

test('T2 ★ blob 里**有** level=30(方案的地基),而 users 表装不下 535', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  const blob = seedAndSnapshot(host, runtime);

  const pkt = decodePacket(blob);
  const row = pkt.upserts.find((u) => u.kind === EntityKind.PLAYER && u.id === 'p1');
  ok(row !== undefined, 'blob 里有 p1 的行');
  eq(row?.fields.level, 30, '★ blob 里 level = 30(level 的唯一持久化处)');
  eq(row?.fields.maxHp, 535, '★ blob 里 maxHp = 535');

  /* 反证:同一条生产路径落库,users 的 hp 被钳住 */
  const rep = host.saveToDb(db, 'room_a', T0);
  ok(rep.hpSaved >= 1, 'saveToDb 报 hp 已保存');
  const u = db.get('users', { id: 'p1' })!;
  eq(u.hp, 100, '★ users.hp 被钳成 100(saveVitalsToUsers 只传 hp、上限取建号值)');
  eq(u.level, 1, '★ users.level 未被权威回写(仍是建号的 1)—— 故 level 只能靠 blob');
});

test('T3 ★★ 冷启动读档:两侧一致(验收 2)', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  const blob = seedAndSnapshot(host, runtime);
  saveReconnectSnapshot(db, 'room_a', 'p1', blob, T0);

  /* 换一个**全新**运行时(同一份 db)—— 模拟服务重启后玩家重进 */
  const { host: h2, runtime: rt2 } = boot(db);
  const joined = rt2.join({ userId: 'p1', asGuest: false });
  ok(joined.ok, 'p1 join(带存档)成功');

  /* 验收 1:恢复路径**真的跑了**(不是只有调用点) */
  ok(rt2.lastRestoreApplied !== null && rt2.lastRestoreApplied >= 1,
    `★ restoreFromProfile 生效玩家数 = ${rt2.lastRestoreApplied}(>0 ⇒ 真生效)`);
  eq(rt2.lastRestoreError, null, '无解码错误');
  ok(rt2.members.get('p1')?.restoredFrom != null, '会话记下恢复坐标(可区分"恢复成功"与"没有存档")');

  /* ★★ 两侧一致:权威与投影都要对 */
  eq(h2.vitalsOf?.('p1')?.maxHp, 535, '★ 权威 maxHp = 535');
  eq(h2.vitalsOf?.('p1')?.hp, 535, '★ 权威 hp = 535');
  const p = rt2.state.players.find((x) => x.id === 'p1')!;
  eq(p.maxHp, 535, '★★ 投影 maxHp = 535(只断言一侧会被"直写 state"骗过)');
  eq(p.hp, 535, '★★ 投影 hp = 535');
  eq(p.level, 30, '★★ 投影 level = 30');
  /* 位置:blob 里是 (7,9),恢复后刚体应在 (7,9) */
  const pose = h2.playerPosition?.('p1');
  ok(Math.abs((pose?.x ?? 0) - 7) < 0.001, `权威 x = 7(实得 ${pose?.x})`);
  ok(Math.abs((pose?.y ?? 0) - 9) < 0.001, `权威 y = 9(实得 ${pose?.y})`);

  /* 下一帧投影仍稳(未被弹回) */
  rt2.step();
  const p2 = rt2.state.players.find((x) => x.id === 'p1')!;
  eq(p2.maxHp, 535, '下一帧投影后 maxHp 仍 535');
  eq(p2.level, 30, '下一帧投影后 level 仍 30');
});

test('T3b ★ 存储位置口径:恢复的是**位置**而非 blob 的原始值(刚体可能被推开)', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  const blob = seedAndSnapshot(host, runtime);
  saveReconnectSnapshot(db, 'room_a', 'p1', blob, T0);

  const { host: h2, runtime: rt2 } = boot(db);
  rt2.join({ userId: 'p1', asGuest: false });
  /* 恢复后反作弊播种坐标应等于**刚体**坐标 —— 否则第一次移动被判瞬移 */
  const pose = h2.playerPosition?.('p1');
  const sess = rt2.members.get('p1')!;
  eq(sess.restoredFrom, { x: pose?.x, y: pose?.y },
    '会话里的恢复坐标 = 权威刚体坐标(反作弊与刚体同源)');
});

test('T4 ★★★ 反向注入:改脏投影 ⇒ 下一帧被**权威**覆盖(验收 3)', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  seedAndSnapshot(host, runtime);
  eq(runtime.state.players.find((x) => x.id === 'p1')!.hp, 535, '注入前投影 = 535');
  /* 模拟"有人在别处直写 state" */
  runtime.state.players.find((x) => x.id === 'p1')!.hp = 77;
  eq(runtime.state.players.find((x) => x.id === 'p1')!.hp, 77, '已把投影改脏成 77');

  runtime.step();
  eq(runtime.state.players.find((x) => x.id === 'p1')!.hp, 535,
    '★★ 下一帧被权威值覆盖 ⇒ 单向投影成立(state 不是权威)');
});

test('T5 断链判据:loadReconnectSnapshot 有真调用点(验收 1)', () => {
  const src = readFileSync(new URL('../server/src/net/room.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] as string).includes('loadReconnectSnapshot')) hits.push(i + 1);
  }
  ok(hits.length >= 3, `★ 出现处 ≥ 3(实得 ${hits.length},行号 ${hits.join(',')})`);
  ok(/loadReconnectSnapshot\(\s*this\.db/.test(src),
    '★ 含一次**真调用**(`loadReconnectSnapshot(this.db, ...)`)—— 不是只有 import');
});

test('T6 反向注入:去掉登记 ⇒ 恢复**静默失效**(证明 addPlayer 必须先于读档)', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  const blob = seedAndSnapshot(host, runtime);
  saveReconnectSnapshot(db, 'room_a', 'p1', blob, T0);

  /* 用一个**裸** WorldSim(不经过房间的 addPlayer),先 join 再恢复:
     若 restoreFromProfile 内部忘了 addPlayer,hp 会灌不进去。 */
  const { runtime: rt2 } = boot(db);
  const r = rt2.join({ userId: 'p1', asGuest: false });
  ok(r.ok, 'join 成功');
  /* 断言:内部自己登记了(不需外部先 addPlayer) */
  ok(rt2.lastRestoreApplied !== null && rt2.lastRestoreApplied >= 1,
    'restoreFromProfile **自己**先登记 ⇒ 不依赖外部调用顺序(对未登记玩家也生效)');
});

test('T7 无存档路径不产生假错误(首次进入是常态,不是缺陷)', () => {
  const db = freshDb();
  const { runtime } = boot(db);
  const r = runtime.join({ userId: 'p1', asGuest: false });
  ok(r.ok, '首次 join 成功');
  eq(runtime.lastRestoreError, null, '★ 无存档**不记**为错误(否则"读坏了"与"首次进入"不可区分)');
  eq(runtime.members.get('p1')?.restoredFrom, undefined, '无存档 ⇒ 会话无恢复坐标');
});

test('T8 坏存档被记成**错误**而非静默(与"无存档"区分开)', () => {
  const db = freshDb();
  /* ⚠️ 两个前提都要满足:
     1 `room_players.room_id → rooms.id` 是**外键**(实测约束名)⇒ 房间必须先存在。
        房间由 `RoomRuntime` 构造器建 ⇒ 先 boot 一次。
     2 `saveReconnectSnapshot` 走 `db.update` ⇒ 行必须**先存在**,
        否则 update 影响 0 行、`loadReconnectSnapshot` 返回 undefined
        ⇒ 表现为"没有存档",测不到我想要的"坏存档"。 */
  const { runtime: rt0 } = boot(db);
  rt0.join({ userId: 'p1', asGuest: false });
  const n = saveReconnectSnapshot(db, 'room_a', 'p1', new Uint8Array([99, 99, 99, 99]), T0);
  eq(n, 1, '坏字节已写进那一行(update 命中 1 行)');

  /* 再装配一个**新的**运行时,让它读到那份坏字节 */
  const { runtime } = boot(db);
  const r = runtime.join({ userId: 'p1', asGuest: false });
  ok(r.ok, '坏存档不阻断 join(正常进入)');
  ok(runtime.lastRestoreError !== null, '★ 坏存档**被记成错误**(可断言,不是静默)');
  console.log('      记录:' + String(runtime.lastRestoreError).slice(0, 76));
});

test('T9 落地:loadReconnectSnapshot 从 import-only 变成有生产消费者', () => {
  /* 这条是"欠账消掉"的结构性证据:repo.ts 的定义有 server/src 内的真调用者。 */
  const roomSrc = readFileSync(new URL('../server/src/net/room.ts', import.meta.url), 'utf8');
  const idx = roomSrc.indexOf('loadReconnectSnapshot(this.db');
  ok(idx > 0, '★ room.ts 里有 `loadReconnectSnapshot(this.db` 的真调用');
  /* 而它原来只在 L1830 被 re-export */
  const reExport = /export \{[^}]*loadReconnectSnapshot[^}]*\}/.test(roomSrc);
  ok(reExport, 're-export 仍在(向后兼容),但**不再**只有它');
});

/* ══════════ ★ 以下两条是**负向验证抓出来的覆盖缺口**(2026-11-13)══════════
 *
 * 我第一版的 11 条测试在 9 条注入中**放过 2 条**:
 * ```
 * I3 去掉 room 侧的 `addPlayer`,测试仍绿  ⇒ 因为 restoreFromProfile **自己**也登记
 *    ⇒ 即:「room 侧 addPlayer 先于读档」这条**当时没有任何断言**。
 * I9 sim:武器写进 heldItem(而非 wearing),测试仍绿
 *    ⇒ 即:武器往返这条**完全没测**(契约 §2.1 的 weaponId 字段形同虚设)。
 * ```
 * ⇒ 两条都是**真实缺口**,补如下。
 * ★ 教训:11/11 通过不代表覆盖了 11 件事。
 *   判据不是"测试有多少条",而是"**打坏被测的东西,它会不会红**"。
 */

test('T10 ★ 武器往返:blob 的 weaponId ⇒ wearing ⇒ weaponOf 投影(补 I9 缺口)', () => {
  const db = freshDb();
  const { host, runtime } = boot(db);
  runtime.join({ userId: 'p1', asGuest: false });
  /* 711 是实测存在的轻剑(`weapons.ts:246`)。 */
  const WID = 711;
  const blob = seedAndSnapshot(host, runtime, WID);

  /* 权威侧:weaponOf 必须读得到 —— 它按「wearing 里不在 ARMOR_BY_ID 的第一个 id」判 */
  eq(host.weaponOf?.('p1'), WID, '★ 权威 weaponOf = 711(⇒ 写进了 wearing,不是 heldItem)');
  const p = runtime.state.players.find((x) => x.id === 'p1')!;
  eq(p.weaponId, WID, '★ 投影 weaponId = 711');

  /* blob 里也带上了它 ⇒ 冷启动能恢复 */
  const pkt = decodePacket(blob);
  const row = pkt.upserts.find((u) => u.kind === EntityKind.PLAYER && u.id === 'p1');
  eq(row?.fields.weaponId, WID, '★ blob 里 weaponId = 711(可持久化)');

  /* 冷启动:新运行时读同一份存档 */
  saveReconnectSnapshot(db, 'room_a', 'p1', blob, T0);
  const { host: h2, runtime: rt2 } = boot(db);
  rt2.join({ userId: 'p1', asGuest: false });
  eq(h2.weaponOf?.('p1'), WID, '★★ 冷启动后权威 weaponOf = 711(端到端往返)');
  eq(rt2.state.players.find((x) => x.id === 'p1')?.weaponId, WID, '★★ 冷启动后投影 weaponId = 711');
});

test('T11 ★ room 侧确实先登记再读档(补 I3 缺口)', () => {
  /* ## 为什么要有这条
   * `restoreFromProfile` 内部**也**会 `addPlayer`(为了让它对未登记玩家也生效)。
   * ⇒ 于是「room 侧有没有先登记」**在行为上观察不到** —— 去掉它测试照样绿。
   * ⇒ 但两者**不是**冗余:
   * ```
   * room 侧 addPlayer 用**房间出生点**播种刚体与反作弊
   * sim 侧 addPlayer 用**档案坐标**
   * ⇒ 少了 room 侧那次,ac 的播种坐标来自 body(.x/.y),
   *   而 body 是房间算的出生点 —— 恢复后 ac 与刚体**不同源**
   * ⇒ 第一次移动被判瞬移(契约 §4.1.2 记的 13.649 格)
   * ```
   * ⇒ 判据:结构性地检查**顺序**(源码文本),而不是靠行为(行为查不出)。
   *   ⚠️ 这正是「行为断言查不出的事,只能用结构断言兜」的场合;
   *      代价是它测的是**源码形态**而非运行结果 —— 明知而取,故写明。 */
  const src = readFileSync(new URL('../server/src/net/room.ts', import.meta.url), 'utf8');
  const addIdx = src.indexOf('host.addPlayer(input.userId, body?.x ?? 0, body?.y ?? 0)');
  const restoreIdx = src.indexOf('restoreFromSnapshot(host, input.userId)');
  ok(addIdx > 0, 'room.ts 里有 `host.addPlayer(input.userId, body?.x ...)` 的调用');
  ok(restoreIdx > 0, 'room.ts 里有 `restoreFromSnapshot(host, input.userId)` 的调用');
  ok(addIdx < restoreIdx,
    `★ 登记(${addIdx})必须先于读档(${restoreIdx})—— 顺序反了会让 ac 与刚体不同源`);
});

report('WS-FND-10-restore');
