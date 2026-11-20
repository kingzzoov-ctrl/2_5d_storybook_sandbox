/**
 * WS-FND-164 —— 世界存档:chunk 脏页落库 + 重启读回 + 归档回滚(★ B1 审计 P0)
 *
 * ## 缺陷形态(修前实测)
 *
 * ```text
 * repo.saveChunk / saveChunkBatch / loadChunk   生产 **0 调用**
 * ⇒ 关掉 host 再起:地形与玩家建造(E 拆 / Q 放 / 铺砖 / 上屋顶)全丢,
 *   世界回到按 seed 的空场,而库里 users / rooms 那几行还在 ——
 *   「自动存档成功」这句话在**地形**这一维上是空的;
 * reset_world 的归档行(room_world_archives)也只写不读 ⇒ 回执里的
 *   `archive: 'ARCHIVED'` 没有任何生产路径能把它取回来。
 * ```
 *
 * ## 判据结构(与 `WS-FND-150` / `-163` 同纪律)
 *
 * ```text
 * 1 从**生产入口**出发:`createHost()` 造 host + `saveToDb()` 存档 —— 不手写夹具
 * 2 「逐格一致」比的是三张表的**每一位**:packed 单元 / roofs / fluid.amount
 * 3 每条正判据都配负对照:未改动块不写 · 缺块回退 · 漂移拒写 · 没有存档不读
 * 4 真库往返用**两个句柄**(写完关掉再新开),证明「落了盘」而不是读了写缓存
 * ```
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { createHost } from '../server/src/index.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { openNodeSqlite } from '../server/src/db/driver.sqlite.ts';
import {
  CHUNK_ROOFS_TABLE,
  migrate,
  createUser,
  createRoom,
  countRoomChunks,
  loadWorldState,
  saveChunkRoofs,
  loadChunkRoofs,
  readWorldPersistenceSql,
  checksumOf,
  type DbLike,
} from '../server/src/db/repo.ts';
import { Chunk, encodeRoofRle, FLOOR_ID_MIN } from '../server/src/world/chunk.ts';
import { packFluidAmounts, readFluidAmounts } from '../server/src/world/fluid.ts';

const ROOM = 'room_p164';
const SEED = 20261201;
const SIZE = 64;
const T0 = 1_700_000_000_000;

/**
 * 世界存档迁移的**正确** checksum = DDL 全文的 FNV-1a(库层同一个函数算的)。
 * 放在文件顶部:`test()` 是**立刻执行**的(harness 不排队),底部声明的 `const`
 * 在测试体内会踩 TDZ —— 实测踩过一次,故这里显式写在最前面。
 */
const GOOD_CHECKSUM = checksumOf(readWorldPersistenceSql());

/** 造一个「有房主 + 房间」的库并跑基线迁移(与生产装配同一前提)。 */
function freshDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, T0);
  createUser(db, { id: 'u_owner', displayName: 'owner', nowMs: T0 });
  createRoom(db, { id: ROOM, ownerId: 'u_owner', worldSeed: SEED, nowMs: T0 });
  return db;
}

/** 生产入口:与 `assemble()` / `resolveRoomHost()` 走同一个 `createHost`。 */
function host(db: DbLike | null, worldSeed = SEED): WorldSim {
  return createHost({ roomId: ROOM, worldSeed, sizeCells: SIZE, mobs: false }, db as DbLike | null) as unknown as WorldSim;
}

/** 世界的**逐格**指纹:packed 单元 / roofs / 水位三张表全量展开。 */
function snap(sim: WorldSim): { cells: string; roofs: string; fluid: string; chunkKeys: string } {
  const keys = [...sim.grid.chunks.keys()].sort();
  const cells: number[] = [];
  const roofs: number[] = [];
  for (const k of keys) {
    const c = sim.grid.chunks.get(k) as Chunk;
    for (let i = 0; i < 256; i += 1) {
      cells.push(c.cells[i]);
      roofs.push(c.roofs[i]);
    }
  }
  const fluid: number[] = [];
  for (let y = 0; y < sim.fluid.height; y += 1) {
    for (let x = 0; x < sim.fluid.width; x += 1) fluid.push(sim.fluid.amountAt(x, y));
  }
  return { cells: cells.join(','), roofs: roofs.join(','), fluid: fluid.join(','), chunkKeys: keys.join(' ') };
}

/** 两个指纹的**第一处**差异(报在断言消息里,不然「不一致」不可定位)。 */
function firstDiff(a: string, b: string): string {
  const x = a.split(',');
  const y = b.split(',');
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x[i] !== y[i]) return `第 ${i} 个值:${x[i] ?? '(缺)'} vs ${y[i] ?? '(缺)'}`;
  }
  return '';
}

/**
 * 把库包一层:指定那一块地形的 `tiles_blob` **看起来是坏的**(注入用,不改库)。
 *
 * 为什么要注入而不是直接 `db.insert` 一行坏 blob:DDL 的
 * `CHECK (length(tiles_blob) = 1024)` 在两个后端都真会被执行(实测 MemoryDb
 * 直接抛 `CHECK constraint failed`)⇒「库里有一行坏字节」这条路**在正常写入下
 * 不可达**,但它在**旧版本 / 手工改库 / 磁盘损坏**下是可达的,而读侧必须扛得住。
 */
function withBadChunkBlob(db: MemoryDb, cx: number, cy: number): DbLike {
  const base = db as unknown as DbLike;
  return {
    exec: (sql: string) => base.exec(sql),
    insert: (table: string, row: Record<string, unknown>) => base.insert(table, row),
    update: (table: string, key: Record<string, string | number>, patch: Record<string, unknown>) => base.update(table, key, patch),
    delete: (table: string, key: Record<string, string | number>) => base.delete(table, key),
    get: (table: string, key: Record<string, string | number>) => {
      const row = base.get(table, key);
      if (table === 'room_chunks' && Number(key.chunk_x) === cx && Number(key.chunk_y) === cy && row !== undefined) {
        return { ...row, tiles_blob: new Uint8Array(512) };
      }
      return row;
    },
    select: (table: string, where?: Record<string, string | number>, limit?: number, orderBy?: { column: string; dir: 'asc' | 'desc' }) =>
      base.select(table, where, limit, orderBy),
    count: (table?: string) => base.count(table),
    transaction: <T,>(fn: () => T) => base.transaction(fn),
  } as unknown as DbLike;
}

/** 一片有玩家建造痕迹的地形(拆 / 放 / 铺地砖 / 屋顶 / 挖低 / 水)。 */
function buildScene(sim: WorldSim): { wall: [number, number]; roof: [number, number]; water: [number, number] } {
  sim.grid.setCell(10, 10, { obj: 351 });          /* Q 放一块墙 */
  sim.grid.setFloor(11, 10, FLOOR_ID_MIN + 3);     /* 铺地砖(301+3) */
  sim.grid.setRoof(12, 10, 372);                   /* 上屋顶 */
  sim.grid.setCell(13, 10, { elev: 0, base: 3 });  /* 挖低 */
  sim.grid.setCell(10, 11, { wire: 5 });           /* 四色暗线 */
  sim.grid.setCell(20, 20, { obj: 401, meta: 2 }); /* 家具 + 朝向 */
  sim.grid.setCell(33, 33, { elev: 3 });           /* 高台(跨到第 2 块 chunk) */
  sim.fluid.addWater(11, 11, 700);
  sim.fluid.addWater(40, 40, 250);
  return { wall: [10, 10], roof: [12, 10], water: [11, 11] };
}

/* ══════════ 1 存 → 关掉 host → 新 host 读回 → 逐格一致 ══════════ */

test('P164-1 存盘后新 host 读回:packed 单元逐格一致(地形不再按 seed 重生成)', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  const before = snap(a);
  const rep = a.saveToDb(db, ROOM, T0 + 1);
  ok(rep.chunksSaved > 0, `第一次存档必须写出脏块(实得 ${rep.chunksSaved})`);

  /* 「关掉 host」= 丢掉这个实例:新起一个(同一个库、同一个房间、同一个 seed)。 */
  const b = host(db);
  const after = snap(b);
  eq(before.cells, after.cells, `逐格不一致:${firstDiff(before.cells, after.cells)}`);
  eq(before.chunkKeys, after.chunkKeys, '块集合(哪些 chunk 存在)也必须一致');
});

test('P164-2 roof 层逐格一致(屋顶不在 32 位单元里,单独一列存)', () => {
  const db = freshDb();
  const a = host(db);
  a.grid.setRoof(12, 10, 372);
  a.grid.setRoof(13, 10, 375);
  a.grid.setRoof(14, 10, 384);
  a.grid.setRoof(12, 10, 0);   /* 拆一个:清空也要能被存下来 */
  const before = snap(a);
  a.saveToDb(db, ROOM, T0 + 1);
  const after = snap(host(db));
  eq(before.roofs, after.roofs, `屋顶层不一致:${firstDiff(before.roofs, after.roofs)}`);
  ok(before.roofs.includes('375'), '正对照:该块确实有非零屋顶(否则这条断言是空转)');
});

test('P164-3 物件层(obj)逐格一致 —— 玩家建造的墙 / 家具都还在', () => {
  const db = freshDb();
  const a = host(db);
  const marks = buildScene(a);
  a.saveToDb(db, ROOM, T0 + 1);
  const b = host(db);
  eq(b.grid.objIdAt(marks.wall[0], marks.wall[1]), 351, '墙(351)必须读回来');
  eq(b.grid.objIdAt(20, 20), 401, '家具(401)必须读回来');
  const d = firstDiff(snap(a).cells, snap(b).cells);
  eq(d, '', `整图 packed 单元必须逐格一致(${d})`);
});

test('P164-4 流体逐格一致(水位表单独一行,按房间而不是按块)', () => {
  const db = freshDb();
  const a = host(db);
  const m = buildScene(a);
  const before = snap(a);
  const rep = a.saveToDb(db, ROOM, T0 + 1);
  ok(rep.worldStateRow === 1, '世界状态行必须写(水位跟着它走)');
  ok(rep.worldStateBytes > 0, '本次必须带上了水位表(状态行含水位字节)');
  const b = host(db);
  const after = snap(b);
  eq(before.fluid, after.fluid, `水位不一致:${firstDiff(before.fluid, after.fluid)}`);
  eq(b.fluid.amountAt(m.water[0], m.water[1]), 700, '那一格的水量必须是 700 毫格');
});

/* ══════════ 2 未改动块不写(成本 = 与改动量成正比)══════════ */

test('P164-5 空闲世界存档零字节;改一格只写一块(负对照:全量 = 块数 × 1027B)', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  const first = a.saveToDb(db, ROOM, T0 + 1);
  const rowsAfterFirst = countRoomChunks(db, ROOM) + db.select(CHUNK_ROOFS_TABLE, { room_id: ROOM }).length;
  ok(first.chunksSaved > 0 && first.chunksSaved <= first.totalChunks, '第一次是脏页写,不该超过块总数');

  /* 什么都没动 ⇒ 一个字节都不写(水位签名没变、没有脏块)。 */
  const idle = a.saveToDb(db, ROOM, T0 + 2);
  eq(idle.chunksSaved, 0, '空闲存档不许写地形块');
  eq(idle.chunkBytes, 0, '空闲存档地形字节必须为 0');
  eq(idle.worldStateRow, 0, '空闲存档连状态行都不该写');
  eq(countRoomChunks(db, ROOM) + db.select(CHUNK_ROOFS_TABLE, { room_id: ROOM }).length, rowsAfterFirst, '库里的行数不该变');
  eq(a.dirtyChunkCount(), 0, '存档之后脏块必须归零');

  /* 负对照:只改一格 ⇒ 只有那**一块**被写(不是一个字节不写,也不是全图)。 */
  a.grid.setCell(50, 50, { obj: 355 });
  eq(a.dirtyChunkCount(), 1, '一格写入只应让**一块**变脏');
  const one = a.saveToDb(db, ROOM, T0 + 3);
  eq(one.chunksSaved, 1, '只写一块');
  eq(one.chunkBytes, 1024, '一块正好 1024 字节');
  ok(one.roofsBytes >= 1, '屋顶层每块至少 1 字节(全空块的零游程)');
  eq(one.totalChunks, first.totalChunks + 1, '(50,50) 落在第 4 块 ⇒ 块总数 +1(不是凭空多出来的)');
  ok(one.chunkBytes < one.totalChunks * 1024, '单块改动必须**小于**全量(这就是脏页存档的意义)');
});

/* ══════════ 3 缺块回退 + 坏行不拖垮启动 ══════════ */

test('P164-6 缺块回退生成:行被删 ⇒ 该块按默认格,其余块照旧;坏字节只影响那一块', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  a.saveToDb(db, ROOM, T0 + 1);
  const before = snap(a);
  const total = a.grid.chunks.size;
  ok(total >= 2, `场景必须跨至少 2 块(实得 ${total})`);

  /* 删掉 (0,0) 那一块的**地形行**(屋顶行留着)—— 「库里有行」这件事就不再成立。 */
  eq(db.delete('room_chunks', { room_id: ROOM, chunk_x: 0, chunk_y: 0 }), 1, '删掉一行地形');

  const b = host(db);
  const r = b.restoreWorldFromDb(db, ROOM);
  eq(r.applied, true, '其余块还在 ⇒ 仍然算读回成功');
  eq(r.chunksLoaded, total - 1, '读回的块数 = 库里的行数');
  eq(r.chunksMissing, 0, '「行不存在」不是坏块(它是「缺块」,走回退生成)');
  eq(b.grid.objIdAt(10, 10), 0, '缺掉的那一块按默认格(obj = 0)');
  eq(b.grid.objIdAt(20, 20), 401, '其它块的内容一个都不许丢(负对照:整体回退)');

  /* 负对照 2:坏字节(长度不是 1024)⇒ 只那一块计入 missing,host 照样起得来。
     ⚠️ 不用 `db.insert` 插坏行 —— DDL 的 `length(tiles_blob) = 1024` 在两个后端
     都真会被执行(实测 MemoryDb 抛 `CHECK constraint failed`),所以走**注入**:
     「库里有一行坏字节」在正常写入下不可达,但在旧版本 / 手工改库 / 磁盘损坏下可达。 */
  const broken = withBadChunkBlob(db, 2, 2);
  const c = host(broken);
  const r2 = c.restoreWorldFromDb(broken, ROOM);
  eq(r2.applied, true, '坏一行不拖垮整次读档');
  eq(r2.chunksMissing, 1, '坏字节必须**计数**,不能静默当成「那里本来什么都没有」');
  eq(c.grid.objIdAt(20, 20), 401, '好块仍然读回来');
  ok(before.cells.length > 0, '正对照:上面那份指纹非空');
});

/* ══════════ 4 脏标记语义 ══════════ */

test('P164-7 脏标记:读回来的块是干净的;写入置脏;存档清脏;负对照同值写入不置脏', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  a.saveToDb(db, ROOM, T0 + 1);

  const b = host(db);
  eq(b.dirtyChunkCount(), 0, '刚读回来的块不该被判成脏(否则每 30 秒重写全图)');

  b.grid.setCell(5, 5, { obj: 351 });
  eq(b.dirtyChunkCount(), 1, '真实写入 ⇒ 脏');

  /* 负对照:往同一格写同一个值 ⇒ `writeCell` 见值没变,不该置脏。 */
  const beforeVersion = b.grid.getChunk(0, 0)?.version ?? -1;
  b.grid.setCell(5, 5, { obj: 351 });
  eq(b.grid.getChunk(0, 0)?.version, beforeVersion, '同值写入不该推进 version');

  const rep = b.saveToDb(db, ROOM, T0 + 2);
  eq(rep.chunksSaved, 1, '只写这一块');
  eq(b.dirtyChunkCount(), 0, '写完必须清脏');

  /* 负对照:`clearDirty()`(网络增量用的逐格位图)清掉**不等于**存档水位归零。 */
  b.grid.setCell(6, 6, { obj: 352 });
  b.grid.clearAllDirty();
  eq(b.dirtyChunkCount(), 1, '位图清了,存档水位还在 ⇒ 仍然要写(两者粒度不同)');
});

/* ══════════ 5 归档可读回(回滚路径)══════════ */

test('P164-8 归档往返:重置 → 按归档句柄读回 → 逐格回到重置前(含 roof / 流体)', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  a.saveToDb(db, ROOM, T0 + 1);
  const before = snap(a);

  const reset = a.resetWorld({ seed: SEED + 7, nowMs: T0 + 2 });
  eq(reset.applied, true, '重置必须生效');
  ok(reset.archive !== null, `重置必须留下归档行(archiveError=${String(reset.archiveError)})`);
  const archiveId = reset.archive?.id ?? '';
  ok(archiveId.length > 0, '归档句柄非空');
  eq(a.grid.objIdAt(10, 10), 0, '负对照:重置之后旧世界确实没了');

  const back = a.restoreWorldFromArchive(db, archiveId, { nowMs: T0 + 3 });
  eq(back.ok, true, `归档必须读得回来(${String(back.reason)}`);
  eq(back.resaved, true, '回滚之后存档必须按新世界重写(否则重启会读到旧存档)');
  const after = snap(a);
  eq(before.cells, after.cells, `回滚后的地形必须逐格回到归档前:${firstDiff(before.cells, after.cells)}`);
  eq(before.roofs, after.roofs, `回滚后的屋顶层必须逐格一致:${firstDiff(before.roofs, after.roofs)}`);
  eq(before.fluid, after.fluid, `回滚后的水位必须逐格一致:${firstDiff(before.fluid, after.fluid)}`);

  /* 而且**关掉 host 再读回**仍然是这一份(回滚结果落了盘)。 */
  const c = host(db, SEED + 7);
  eq(snap(c).cells, before.cells, '回滚后的世界必须已经落盘');
});

test('P164-9 负对照:库里没有本房间的存档 ⇒ applied:false + reason no-save,世界不变', () => {
  const db = freshDb();
  const a = host(db);
  a.grid.setCell(7, 7, { obj: 351 });
  const before = snap(a);
  const r = a.restoreWorldFromDb(db, ROOM);
  eq(r.applied, false, '没有存档就不该"恢复"');
  eq(r.reason, 'no-save', `理由必须可判(实得 ${r.reason})`);
  eq(snap(a).cells, before.cells, '拒绝时世界一字未改');
  /* 负对照 2:没有库 ⇒ no-db(不是崩溃)。 */
  const r2 = host(null).restoreWorldFromDb(null, ROOM);
  eq(r2.applied, false, '没有库 ⇒ 不恢复');
  eq(r2.reason, 'no-db', `实得 ${r2.reason}`);
});

/* ══════════ 6 迁移漂移 ⇒ 拒写;世代更换 ⇒ 清旧代 ══════════ */

test('P164-10 负对照:世界存档迁移 checksum 漂移 ⇒ 存档**抛错**且不写一行', () => {
  const db = freshDb();
  const a = host(db);
  a.saveToDb(db, ROOM, T0 + 1);
  const rows = countRoomChunks(db, ROOM);
  a.grid.setCell(8, 8, { obj: 351 });

  /* 篡改登记行的 checksum(= DDL 被改过而库里的表没跟着改)。 */
  db.update('schema_migrations', { version: 5 }, { checksum: 'fnv1a:deadbeef' });
  let threw = false;
  try { a.saveToDb(db, ROOM, T0 + 2); } catch { threw = true; }
  eq(threw, true, '漂移必须拒写(不静默降级)');
  eq(countRoomChunks(db, ROOM), rows, '拒写时地形行数一个都不许多');
  ok(a.dirtyChunkCount() > 0, '拒写之后脏块仍在(下一轮还要写,不许假装存过)');

  /* 负对照:checksum 修回正确值 ⇒ 立刻能写。 */
  const good = db.select('schema_migrations', { version: 5 })[0]?.checksum;
  ok(typeof good === 'string' && good.startsWith('fnv1a:deadbeef'), '篡改确实生效了(否则上面那条是空转)');
  db.update('schema_migrations', { version: 5 }, { checksum: GOOD_CHECKSUM });
  const rep = a.saveToDb(db, ROOM, T0 + 3);
  eq(rep.chunksSaved, 1, '修回之后那一块立刻落库');
});

test('P164-11 世代更换:reset 后存档清掉旧世代并写新 seed;重启采用**库里的**seed', () => {
  const db = freshDb();
  const a = host(db);
  buildScene(a);
  a.saveToDb(db, ROOM, T0 + 1);
  eq(loadWorldState(db, ROOM)?.seed, SEED, '写下的 seed 是这一代的');

  const newSeed = SEED + 99;
  a.resetWorld({ seed: newSeed, nowMs: T0 + 2 });
  /* 新世代里再建一块 —— 否则「新世代按全量写」这句话在空世界上是空转的。 */
  a.grid.setCell(1, 1, { obj: 353 });
  const rep = a.saveToDb(db, ROOM, T0 + 3);
  ok(rep.generationWiped > 0, `换世代必须清掉旧行(实得 ${rep.generationWiped})`);
  eq(rep.chunksSaved, 1, '新世代只有一块脏块(旧代那一批全被清掉)');
  eq(rep.chunksSaved, rep.totalChunks, '新世代按**全量**写:脏块数 = 块总数(旧行不参与)');
  eq(loadWorldState(db, ROOM)?.seed, newSeed, '状态行跟着换成新 seed');
  eq(countRoomChunks(db, ROOM), 1, '库里只剩下新世代的行');

  /* 重启:房间配置里的 seed 仍是旧的(reset_world 刻意不改它)⇒ 采用库里的那一代。
     ⚠️ 这里先造一个**没有库**的 host 再手动读档:`createHost(db)` 自己已经读过一次,
     第二次读档的 `seedAdopted` 恒为 false(种子那时已经被 adopt 过)—— 实测踩过一次。
     createHost 那一侧由下面的 `c2` 单独钉。 */
  const b = host(null, SEED);
  const r = b.restoreWorldFromDb(db, ROOM);
  eq(r.seedAdopted, true, '必须如实报告「采用了库里的 seed」');
  eq(r.storedSeed, newSeed, '库里那一代的 seed');
  eq(r.chunksLoaded, 1, '新世代那一块按块读回');
  eq(b.grid.objIdAt(1, 1), 353, '新世代的内容在');
  eq(b.grid.objIdAt(10, 10), 0, '负对照:重置前的墙**不许**回来');

  /* createHost 那一侧:同一个库 + 旧配置种子 ⇒ 世界身份必须已经是库里的新种子。 */
  const c2 = host(db, SEED);
  eq(c2.worldSeed, newSeed, 'createHost 也采用库里的 seed(而不是配置里那个旧的)');
  eq(c2.grid.objIdAt(1, 1), 353, 'createHost 读回的是新世代的内容');
});

/* ══════════ 7 存储层边界(编码 / 上限 / 拒收)══════════ */

test('P164-12 成本账:空闲一轮 0 字节;单块 1024B;全量 = 块数 × (1024 + 屋顶 RLE)', () => {
  const db = freshDb();
  const a = host(db);
  /* 第一次:空世界 + 从没存过 ⇒ 只写状态行(0 块地形)。 */
  const rep0 = a.saveToDb(db, ROOM, T0 + 1);
  eq(rep0.chunksSaved, 0, '负对照:空世界没有脏块');
  eq(rep0.chunkBytes + rep0.roofsBytes, 0, '空世界地形 + 屋顶 = 0 字节');
  eq(rep0.worldStateRow, 1, '状态行(身份 + 水位)第一次必须写');
  eq(rep0.totalChunks, 0, '空世界 0 块');

  /* 建 3 块(3 个不同 chunk)⇒ 第一次存档是全量口径。 */
  a.grid.setCell(1, 1, { obj: 351 });
  a.grid.setCell(20, 20, { obj: 351 });
  a.grid.setCell(40, 40, { obj: 351 });
  const first = a.saveToDb(db, ROOM, T0 + 2);
  eq(first.totalChunks, 3, '3 块');
  eq(first.chunksSaved, 3, '第一次把 3 块全写(全量)');
  const fullBytes = first.chunkBytes + first.roofsBytes;
  ok(fullBytes >= 3 * 1024, `全量一次 ≥ 3KB(实得 ${fullBytes})`);

  /* 空闲一轮:0 字节(没有脏块 + 水位签名没变)。 */
  const idle = a.saveToDb(db, ROOM, T0 + 3);
  eq(idle.chunkBytes + idle.roofsBytes, 0, '空闲一轮 0 字节');
  eq(idle.worldStateRow, 0, '空闲一轮连状态行都不写');

  /* 改一格:只写那一块 ⇒ 与全量的比值就是稳态节省倍数。 */
  a.grid.setCell(2, 2, { obj: 351 });
  const one = a.saveToDb(db, ROOM, T0 + 4);
  eq(one.chunksSaved, 1, '只写一块');
  eq(one.chunkBytes, 1024, '一块 = 1024 字节');
  ok(one.roofsBytes >= 1 && one.roofsBytes <= 4096, `屋顶 RLE 在 [1,4096] 内(实得 ${one.roofsBytes})`);
  ok(one.chunkBytes < fullBytes, '单块改动 < 全量(3 块)');
});

test('P164-13 roofs_blob 边界:0 字节拒、超 4096 拒;全空屋顶层的 RLE 可写可读回', () => {
  const db = freshDb();
  const empty = new Chunk(2, 3);
  const rle = encodeRoofRle(empty.roofs);
  /* 每段零游程最多 127 格(`encodeRoofRle` 的 `n < 127`)⇒ 256 格全空 = 3 字节 */
  eq(rle.byteLength, 3, '全空屋顶层是 3 个字节(127 + 127 + 2 的零游程)');

  let threw = false;
  try { saveChunkRoofs(db, ROOM, 2, 3, new Uint8Array(0), T0); } catch { threw = true; }
  eq(threw, true, '0 字节必须拒(「忘了编码」不许被当成「没有屋顶」)');

  threw = false;
  try { saveChunkRoofs(db, ROOM, 2, 3, new Uint8Array(4097), T0); } catch { threw = true; }
  eq(threw, true, '超 4096 必须拒(不截断)');

  saveChunkRoofs(db, ROOM, 2, 3, rle, T0);
  eq(loadChunkRoofs(db, ROOM, 2, 3)?.byteLength, 3, '合法写入必须读得回来(字节逐位一致)');
  ok(loadChunkRoofs(db, ROOM, 9, 9) === undefined, '负对照:没有这一行 ⇒ undefined(不编一个空层)');
});

test('P164-14 FLV1 水位表:往返逐格一致;magic / 长度不符 ⇒ null(拒收,不猜)', () => {
  const sim = host(null);
  sim.fluid.addWater(3, 3, 800);
  sim.fluid.addWater(4, 3, 1);
  const blob = packFluidAmounts(sim.fluid);
  eq(blob.byteLength, 12 + 4 * SIZE * SIZE, '长度 = 12 + 4·w·h');
  const back = readFluidAmounts(blob);
  ok(back !== null, '合法字节必须解得开');
  eq(back?.width, SIZE, '宽');
  eq(back?.amount[3 * SIZE + 3], 800, '逐格一致(那一格)');
  eq(back?.amount[3 * SIZE + 4], 1, '逐格一致(最小的一格水也要在)');

  const bad = blob.slice();
  bad[0] = 0x00;
  ok(readFluidAmounts(bad) === null, '负对照:magic 不对 ⇒ null');
  ok(readFluidAmounts(blob.slice(0, blob.byteLength - 4)) === null, '负对照:长度不符 ⇒ null');
  ok(readFluidAmounts(new Uint8Array(4)) === null, '负对照:头都不够 ⇒ null');
});

/* ══════════ 8 真文件库:关句柄 → 新句柄 → 新 host 读回 ══════════ */

test('P164-15 真文件库跨句柄:写完关掉 → 新句柄新建 host → 逐格一致', () => {
  /* 目录名带 pid:上一次崩掉留下的库不该让这一次在 `createRoom` 上撞主键。 */
  const dir = join('.tmp', `ws-fnd-164-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'world.db');
  try {
    const db1 = openNodeSqlite(file);
    migrate(db1, T0);
    createUser(db1, { id: 'u_owner', displayName: 'owner', nowMs: T0 });
    createRoom(db1, { id: ROOM, ownerId: 'u_owner', worldSeed: SEED, nowMs: T0 });
    const a = host(db1);
    buildScene(a);
    const before = snap(a);
    a.saveToDb(db1, ROOM, T0 + 1);
    (db1 as unknown as { close?: () => void }).close?.();

    /* 新句柄 = 新进程的等价物(读自己的写缓存不算落了盘)。 */
    const db2 = openNodeSqlite(file);
    const b = host(db2);
    const after = snap(b);
    eq(before.cells, after.cells, `真库逐格一致:${firstDiff(before.cells, after.cells)}`);
    eq(before.roofs, after.roofs, `真库屋顶层一致:${firstDiff(before.roofs, after.roofs)}`);
    eq(before.fluid, after.fluid, `真库水位一致:${firstDiff(before.fluid, after.fluid)}`);
    (db2 as unknown as { close?: () => void }).close?.();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄仍在 */ }
  }
});

/* ══════════ 9 迁移登记(checksum 在上面的常量里现算)══════════ */

report('WS-FND-164');
