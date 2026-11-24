/**
 * WS-FND-129 —— 物品真值层的**容量/按件**判据 + 箱子的生产注册。
 *
 * ## 本套件守的五件事(逐条对着本轮实测)
 *
 * | # | 判据 | 修前的病 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | db 模式:连发 20 次 +1 **累到容量上限**;基准 = 已落盘 + 房间账 | `beforeTotal` 取自 `totalItemsOf(db)`,而 `ai_item_instances` 全仓**零生产写入口** ⇒ 基准恒 0 ⇒ 20 次全放行(账面 20 > 容量 8 也不拒),单批 ≥9 反被误判 `OVERFLOW` | 把 `authoritativeItemTotal` 改回 `return totalItemsOf(this.db, userId)`(FND129-1 第 2/3 行) |
 * | 2 | 注入验证:库里的**已落盘** 5 件真的占容量(只塞得进 3 件) | 同上(「有库就只读库」把另一本账当不存在) | 把 `+ local` 删掉(FND129-2 第 3 行) |
 * | 3 | 坏 `quantity` 行(NaN)不得让 `after > capacity` 恒 false | `reduce((s,r) => s + r.quantity)` 遇坏行 ⇒ `NaN` ⇒ 容量闸/负库存闸**同时静默失效** | 把 `totalItemsOf` 改回裸 `reduce`(FND129-3 第 3/5/6 行) |
 * | 4 | 入口按件判据:扣 5 而只有 2 件 ⇒ `ITEM_NEGATIVE`,且件数**不夹零** | `checkInventory` 只判总量 ⇒ 放行,写账路径 `Math.max(0, ...)` **静默夹零**(凭空消耗 3 件) | 删掉汇点里的 `beforeByItem:`(FND129-5/6 全红) |
 * | 5 | 箱子:世界侧放着箱子块 ⇒ `OPEN_CHEST` / `USE_OWN_CHEST` 真的开得了 | `registerChest` 全仓**零生产调用点** ⇒ 线上恒 INVALID「不是箱子」 | 删掉 `runChestAction` 里的 `registerChest(roomId, x, y)`(FND129-9/11 红) |
 * | 6 | 容器**件数**上界(24 档 × 8 件),超出即拒且零副作用 | `count` 是客户端自报正整数,同一 `itemId` 可堆任意件(只受背包约束) | 删掉 `inChest + count > CHEST_MAX_ITEMS` 那一段(FND129-13 第 5/6 行) |
 *
 * ## 判据纪律(与 WS-FND-105/115 同一套)
 *
 * ```
 * 1 每条都能失败:负对照 / 注入验证各至少一次(「跑过了」不算数)
 * 2 行为判据优先:能真跑一次生产装配(assemble)+ 真世界,就不 grep 源码
 * 3 文本判据只锁「接线」那一段(纯函数测不到的地方),且必须自带**负对照**
 * 4 断言右侧一律是**字面量**(不取被测模块的常量),否则就是「用一个值断言它自己」
 * ```
 *
 * ## 夹具的诚实边界
 *
 * - 背包/容器的件数上界用的是**真断言 8**(Lv1 `8 + (level-1)`),不是抄来的常数;
 * - 第 3 条用**未迁移**的内存库注入坏行:注入的是**行的形状**,不是引擎语义
 *   (真实 SQLite 是动态类型,`'abc'` 落进 INTEGER 列是文本,`CHECK (quantity >= 0)`
 *   对它成立 ⇒ 该行真的存得进去;MemoryDb 的 CHECK 解析更严,会先拒);
 * - 第 15 条只钉地面物品的**守恒后果**(按 `itemId` 聚合的读口),不钉 `id` 是否唯一:
 *   那一维在 `sim/world_sim.ts:dropItem`(不在本套件的改动集内),见该条注释。
 *
 * 运行:`node tests/WS-FND-129-inventory-integrity.test.ts`
 */
import { carryItemCapacity, ITEMS_PER_CARRY_SLOT } from '../server/src/combat/progression.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import type { RoomRuntime, WorldSaveHost } from '../server/src/net/room.ts';
import {
  checkInventory, createAcState, InventoryReject,
} from '../server/src/net/anticheat.ts';
import {
  CHEST_MAX_ITEMS, CHEST_SLOTS, ownChestContents, publicChestContents,
} from '../server/src/net/actions/open_chest.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import {
  EquipSlot, addItemInstance, badQuantityRowCount, createUser, listItems, migrate,
  resetBadQuantityRowCount, totalItemsOf,
} from '../server/src/db/repo.ts';
import type { ItemInstanceRecord } from '../server/src/db/repo.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 读仓库内文件(只读)。 */
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/* ───────────────────────── 内容层锚点(字面量取自冻结表) ───────────────────────── */

const LOG = 101;       /* 暖松原木 */
const PLANK = 151;     /* 精刨松木板 —— 不是箱子(负对照用) */
const FEATHER = 733;   /* 复苏天使羽毛笔 */
const STORAGE_CHEST = 513; /* 分类图标储物箱(内容层 tags 含「储物」) */
const CLOUD_CHEST = 514;   /* 跨房共享云端保险箱(同上) */

/** 箱子格 —— 与 WS-FND-27 用同一格:在 `CHEST_REACH`(5)之内。 */
const CX = 3;
const CY = 4;
/** 箱子旁边**在射程内**的两格:(2,4) 放一块木板,(3,3) 留空。 */
const PLANK_X = 2;
const PLANK_Y = 4;
const EMPTY_X = 3;
const EMPTY_Y = 3;

/* ───────────────────────── 夹具 ───────────────────────── */

/**
 * 世界侧能力(**只声明用到的**)—— 与 WS-FND-62 同一手法:测试要断言的是
 * 世界内部可观测的状态,而 `net/room.ts` 不认识模拟层。
 */
interface SimHandle {
  dropItem(x: number, y: number, itemId: number, count: number): void;
  groundItemsNear(
    x: number, y: number, radius: number,
  ): { itemId: number; count: number; x: number; y: number; dist: number }[];
  consumeGroundItem(itemId: number, count: number, nearX?: number, nearY?: number, radius?: number): number;
  setCell(x: number, y: number, fields: { obj?: number }): void;
  blockAt(x: number, y: number): number;
}

const simOf = (host: WorldSaveHost): SimHandle => host as unknown as SimHandle;

let roomSeq = 0;
type Room = { rt: RoomRuntime; sim: SimHandle; roomId: string };

/**
 * 把 **WS-FND-155 的起始背包**从账上清掉,回到「空手 Lv.1」的起点。
 *
 * 为什么本套件需要它:155 之后**每个新入场的玩家**都会带一份 7 件的起始包
 * (占容量!),而本套件测的是「容量上界 / 守恒 / 整批零副作用」这些
 * **以空背包为前提**的判据 ⇒ 不清掉,`+8` 那一批会因为 `7+8 > 8` 直接被
 * `ITEM_OVERFLOW` 拒(实测 10 条红),而那是**前提变了**,不是判据坏了。
 *
 * 清账走生产同一条路(负 delta 的 ops:不需要产出凭证)——
 * 不是绕过容量闸,而是**用**它:清完总量真的回到 0。
 */
function clearStartingPack(rt: RoomRuntime, userId: string): void {
  const ops = rt.authoritativeItemIds(userId)
    .map((itemId) => ({ itemId, delta: -rt.authoritativeItemCount(userId, itemId) }))
    .filter((op) => op.delta !== 0);
  if (ops.length === 0) return;
  const r = rt.applyInventory(userId, { ops });
  ok(r.allowed, `前置:清空起始背包必须放行(被拒 ${r.rejectCode ?? '?'})`);
  eq(rt.authoritativeItemTotal(userId), 0, '前置:清完账上真的是 0 件');
}

/** 建一个**真装配**出来的房间(不手搓 `rtOpts` —— 那会绕开 `assemble()` 的接线)。 */
function makeRoom(o: { db?: MemoryDb | null } = {}): Room {
  roomSeq += 1;
  const roomId = `r_fnd129_${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 16,
    /* 本套件不测生物 AI:关掉免得自发改刷干扰地面/箱子的账。 */
    mobs: false,
    db: o.db ?? null,
  });
  a.runtime.join({ userId: 'p1' }); // OWNER:既有 `publicStorage` 也有 `baseline`
  /* ★ WS-FND-155:`join` 现在会发一份起始背包(7 件)⇒ 本套件要的是**空手**起点。 */
  clearStartingPack(a.runtime, 'p1');
  return { rt: a.runtime, sim: simOf(a.host), roomId };
}

/** 一份**迁移过**的内存库 + 一个真用户行(`rooms.owner_id` / `room_players` 要它)。 */
function freshDb(ownerId = 'p1'): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: ownerId, displayName: 'A', nowMs: 1000 });
  return db;
}

let seedSeq = 0;
/** 走**生产同一条路**把东西塞进背包(先铸凭证,再 `applyInventory`)。 */
function seed(rt: RoomRuntime, userId: string, itemId: number, n: number): void {
  seedSeq += 1;
  const src = `seed129:${userId}:${itemId}:${n}:${seedSeq}`;
  rt.grantItemSource(userId, src);
  const r = rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `前置:应能塞进 ${n} 件 #${itemId}(被拒 ${r.rejectCode ?? '?'})`);
}

/** 试一次产出(不 assert,交给调用方统计)。 */
function tryProduce(rt: RoomRuntime, userId: string, itemId: number): { allowed: boolean; rejectCode?: string } {
  seedSeq += 1;
  const src = `produce129:${userId}:${itemId}:${seedSeq}`;
  rt.grantItemSource(userId, src);
  return rt.applyInventory(userId, { ops: [{ itemId, delta: 1, source: src }] });
}

/** 往箱子里存 / 从箱子里取(`count` 正 = 存,负 = 取)。 */
function chestAct(rt: RoomRuntime, action: RoomAction, itemId: number, count: number) {
  return rt.dispatchAction('p1', action, { x: CX, y: CY, itemId, count });
}

const chestTotal = (roomId: string): number =>
  (publicChestContents(roomId, CX, CY) ?? []).reduce((s, x) => s + x.count, 0);

const stackCount = (roomId: string): number => (publicChestContents(roomId, CX, CY) ?? []).length;

/* ═════════════════ 1. P1:db 模式的基准必须与写入路径同源 ═════════════════ */

test('FND129-1 ★★ db 模式:连发 20 次 +1 会**累到容量上限**(修前全部放行)', () => {
  /* 怎么变红:把 `authoritativeItemTotal` 改回「有 db 就只读库」
     ⇒ 基准恒 0 ⇒ 20 次全部 allowed,第 2/3 行红且 total 会是 20。 */
  const db = freshDb();
  const { rt } = makeRoom({ db });

  /* 前提(如实记录修前的起点):db 侧一行都没有 —— 全仓**没有**把 ops 写进
     `ai_item_instances` 的生产路径(`addItemInstance` 只有测试调用)。 */
  eq(totalItemsOf(db, 'p1'), 0, '前提:库里 0 件');

  let allowed = 0;
  const codes: (string | undefined)[] = [];
  const cap = rt.carryCapacityOf('p1');
  for (let i = 0; i < cap + 12; i += 1) {
    const r = tryProduce(rt, 'p1', LOG);
    if (r.allowed) allowed += 1;
    else codes.push(r.rejectCode);
  }

  eq(cap, carryItemCapacity(8), '前提:Lv1 = 8 个负重格');
  eq(allowed, cap, '★ 只有前 cap 件进得来 —— 修前基准恒 0 ⇒ 多出来的 12 件也**全部**放行');
  eq(codes[0], InventoryReject.OVERFLOW, '★ 超出的第一次起按 OVERFLOW 拒(不是 BURST/别的抢先)');
  eq(rt.authoritativeItemTotal('p1'), cap, '★ 权威总量停在容量上限(修前会是 cap + 12)');
  eq(totalItemsOf(db, 'p1'), 0, 'db 侧仍没有行 ⇒ 修的是**基准来源**,不是「偷偷写库」');
});

test('FND129-2 ★★ 注入验证:db 里**已落盘**的件数真的占容量(两账相加,不是「有库就只读库」)', () => {
  /* 怎么变红:把 `authoritativeItemTotal` 里的 `+ local` 删掉
     ⇒ 基准恒 5 ⇒ 下面「只塞得进 3 件」会变成 8 件。 */
  const db = freshDb();
  const row: ItemInstanceRecord = {
    instance_id: 'i129-1',
    owner_id: 'p1',
    recipe_hash: null,
    slot: EquipSlot.BAG,
    quantity: 5,
    equipped: 0,
    stats_json: '{}',
    bound_room_id: null,
    created_at: 0,
    updated_at: 0,
  };
  addItemInstance(db, row);
  eq(totalItemsOf(db, 'p1'), 5, '前提:库里有 5 件已落盘');

  const withDb = makeRoom({ db });
  eq(withDb.rt.authoritativeItemTotal('p1'), 5, '★ 基准 = 已落盘 5 + 本房间账 0');

  const cap = withDb.rt.carryCapacityOf('p1');
  let allowedWithDb = 0;
  for (let i = 0; i < cap; i += 1) {
    if (tryProduce(withDb.rt, 'p1', LOG).allowed) allowedWithDb += 1;
  }
  eq(allowedWithDb, cap - 5, '★ 库里的 5 件占着容量 ⇒ 只塞得进 cap-5 件');
  eq(withDb.rt.authoritativeItemTotal('p1'), cap, '两账同源:总量 = 库 5 + 房 (cap-5)');

  /* 负对照:同一个世界、同一批 ops,库里**没有**那 5 件 ⇒ 8 件全进得来。
     若上面那 3 件不是「库里 5 件」造成的,这一条会与它相同。 */
  const noDb = makeRoom();
  let allowedNoDb = 0;
  for (let i = 0; i < cap; i += 1) {
    if (tryProduce(noDb.rt, 'p1', LOG).allowed) allowedNoDb += 1;
  }
  eq(allowedNoDb, cap, '负对照:没有已落盘基线 ⇒ cap 件全进得来');
});

test('FND129-3 ★★ 坏 quantity 行(NaN)不得让容量闸失效(比较对 NaN 恒 false)', () => {
  /* 怎么变红:把 `totalItemsOf` 改回 `reduce((s,r) => s + r.quantity, 0)`
     ⇒ 第 3 行得 NaN、第 5/6 行红。 */
  resetBadQuantityRowCount();
  eq(badQuantityRowCount(), 0, '前提:坏行计数已清零');

  /* 未迁移的内存库 ⇒ 不强制 `CHECK (quantity >= 0)`。
     注入的是**行的形状**(真实 SQLite 是动态类型,文本落进 INTEGER 列照样存得进去),
     不是引擎语义。 */
  const db = new MemoryDb();
  db.insert('users', { id: 'p1' });
  const base = {
    owner_id: 'p1', recipe_hash: null, slot: EquipSlot.BAG, equipped: 0,
    stats_json: '{}', bound_room_id: null, created_at: 0, updated_at: 0,
  };
  addItemInstance(db, { ...base, instance_id: 'good', quantity: 3 } as ItemInstanceRecord);
  addItemInstance(db, { ...base, instance_id: 'bad', quantity: NaN } as ItemInstanceRecord);

  eq(listItems(db, 'p1').length, 2, '前提:两行都在');
  eq(totalItemsOf(db, 'p1'), 3, '★ 只累加有限非负的行 ⇒ 3(不是 NaN)');
  eq(badQuantityRowCount(), 1, '★ 坏行**可观测**(跳过不是静默行为)');

  /* 注入验证:旧口径在同一批行上得到 NaN,而守恒判定是**比较**。 */
  const naive = listItems(db, 'p1').reduce((s, r) => s + r.quantity, 0);
  eq(Number.isNaN(naive), true, '★ 旧口径(裸 reduce)在同一批行上 = NaN');
  eq(naive > 8, false, '★ 而 `after > capacity` 对 NaN 恒 false ⇒ 容量闸静默失效(修前形态)');
  eq(totalItemsOf(db, 'p1') + 6 > 8, true, '★ 修后:3 + 6 > 8 ⇒ 同一个判据判得出来');
});

test('FND129-4 ★ 接线判据:汇点四个入参全部由服务端派生(含按件账)', () => {
  /* 怎么变红:删掉 `applyInventory` 里的 `beforeByItem:` 那一行 ⇒ 第 2 行红;
     把 `authoritativeItemTotal` 改回「有库就只读库」⇒ 第 6 行红。 */
  const roomSrc = read('server/src/net/room.ts');

  const sink = /this\.ac\.inventory\(userId, \{([\s\S]*?)\n    \}\);/.exec(roomSrc);
  ok(sink !== null, '能找到唯一汇点 `this.ac.inventory(userId, { ... })` 的实参');
  const args = sink?.[1] ?? '';
  for (const field of [
    'allowedSources: this.grantedSourcesFor(',
    'beforeTotal: this.authoritativeItemTotal(',
    'beforeByItem: new Map(this.itemCounts',
    'capacity: this.carryCapacityOf(',
  ]) {
    ok(args.includes(field), `汇点必须有服务端派生的 \`${field}\``);
  }
  /* 负对照:客户端取值 / 编造的字段扫不到(证明上面不是恒真)。 */
  ok(!args.includes('beforeTotal: input.beforeTotal'), '负对照:实参里不得出现客户端取值');
  ok(!args.includes('ghostField129'), '负对照:不存在的字段扫不到');

  const tot = /authoritativeItemTotal\(userId: string\): number \{([\s\S]*?)\n  \}/.exec(roomSrc);
  ok(tot !== null, '能找到 `authoritativeItemTotal` 的方法体');
  const body = tot?.[1] ?? '';
  ok(body.includes('totalItemsOf(this.db, userId) + local'),
    '★ 基准 = 已落盘**加**本房间账(不是「有库就只读库」)');
  ok(!/return totalItemsOf\(this\.db, userId\);/.test(body),
    '负对照:不得退回「有库就只读库」那一支');
});

/* ═════════════════ 2. P2:入口的按件判据 ═════════════════ */

test('FND129-5 ★★ 扣 5 件而只有 2 件 ⇒ ITEM_NEGATIVE,件数**不夹零**', () => {
  /* 怎么变红:删掉汇点里的 `beforeByItem:` ⇒ 第 2 行红;
     把写账路径的 `next > 0 ? next : 0` 之外再夹一次 ⇒ 第 4 行红。 */
  const { rt } = makeRoom();
  /* ★ 关键:先塞 **5 件另一个物品**,让**总量**足够 —— 否则 `2 - 5 < 0` 会被总量那一支
     抢先拒,测出来的就不是按件判据(注入实测:删掉 `beforeByItem` 时本条必须红)。 */
  seed(rt, 'p1', LOG, 5);
  seed(rt, 'p1', FEATHER, 2);
  eq(rt.authoritativeItemTotal('p1'), 7, '前提:总量 7 件(扣 5 之后仍 ≥ 0)');
  eq(rt.authoritativeItemCount('p1', FEATHER), 2, '前提:733 真的只有 2 件');

  const r = rt.applyInventory('p1', { ops: [{ itemId: FEATHER, delta: -5 }] });
  eq(r.allowed, false, '★ 总量够、这一件不够 ⇒ 仍必须拒(修前只判总量 ⇒ 放行)');
  eq(r.rejectCode, InventoryReject.NEGATIVE, '拒因 ITEM_NEGATIVE');
  eq(rt.authoritativeItemCount('p1', FEATHER), 2, '★ 件数**不夹零**(修前被夹成 0 ⇒ 凭空消耗 3 件)');
  eq(rt.authoritativeItemTotal('p1'), 7, '整批拒绝 ⇒ 总量一个字没动');
});

test('FND129-6 ★★ 注入验证(A/B):拿掉按件账 ⇒ 同一条报文被放行', () => {
  /* 这一条就是「删掉 beforeByItem 那一行」的后果,在**函数口**上单独复现一次,
     从而证明 FND129-5 的「拒」是那一维干的,不是别的检查抢先命中。 */
  const ops = [{ itemId: FEATHER, delta: -5 }];
  const legacy = checkInventory(createAcState('p1'), {
    tick: 1, ops, allowedSources: new Set<string>(), beforeTotal: 10, capacity: 100,
  });
  eq(legacy.allowed, true, '★ 旧口径(只有总量)会放行 —— 凭空消耗 3 件,零违规');

  const withItem = checkInventory(createAcState('p1'), {
    tick: 1, ops, allowedSources: new Set<string>(), beforeTotal: 10, capacity: 100,
    beforeByItem: new Map([[FEATHER, 2]]),
  });
  eq(withItem.allowed, false, '同一份输入 + 按件账 ⇒ 拒(唯一差别就是这一维)');
  eq(withItem.rejectCode, InventoryReject.NEGATIVE, '拒因 NEGATIVE(不是 MALFORMED 之类抢先)');

  /* 负对照:件数够的时候仍然放行 —— 证明不是「一有 beforeByItem 就拒」。 */
  const enough = checkInventory(createAcState('p1'), {
    tick: 1, ops, allowedSources: new Set<string>(), beforeTotal: 10, capacity: 100,
    beforeByItem: new Map([[FEATHER, 5]]),
  });
  eq(enough.allowed, true, '负对照:恰好 5 件 ⇒ 放行');
});

test('FND129-7 ★ 批内运行视图:同一批 [+3,-5] 拒、[+5,-5] 过', () => {
  /* 怎么变红:把 `byItem` 换成「只读一次初始值」(不逐条推进)⇒ 第 2 行红。 */
  const { rt } = makeRoom();
  /* 让**总量**足够(5 件),把总量判据排除掉 —— 否则 `0 + (-2) < 0` 会被它抢先拒。 */
  seed(rt, 'p1', LOG, 5);

  rt.grantItemSource('p1', 'batch129a');
  const bad = rt.applyInventory('p1', {
    ops: [{ itemId: PLANK, delta: 3, source: 'batch129a' }, { itemId: PLANK, delta: -5 }],
  });
  eq(bad.allowed, false, '★ 批内先加 3 再扣 5 ⇒ 按**当时**的件数判 ⇒ 拒(总量够也拒)');

  rt.grantItemSource('p1', 'batch129b');
  const good = rt.applyInventory('p1', {
    ops: [{ itemId: PLANK, delta: 5, source: 'batch129b' }, { itemId: PLANK, delta: -5 }],
  });
  eq(good.allowed, true, '负对照:先加 5 再扣 5 ⇒ 件数够 ⇒ 放行');
  eq(rt.authoritativeItemCount('p1', PLANK), 0, '净 0 ⇒ 账不动');
  eq(rt.authoritativeItemTotal('p1'), 5, '总量仍是那 5 件(批内净 0)');
});

test('FND129-8 ★ 合法扣减仍放行;扣光后再扣被拒(不夹零)', () => {
  const { rt } = makeRoom();
  seed(rt, 'p1', LOG, 3);
  eq(rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: -3 }] }).allowed, true,
    '合法扣减应放行(按件判据不得误伤)');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '扣光');

  const again = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: -1 }] });
  eq(again.allowed, false, '负对照:账上 0 件 ⇒ 再扣被拒');
  eq(again.rejectCode, InventoryReject.NEGATIVE, '拒因 NEGATIVE');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '账仍是 0(没有凭空多也没有负数)');
});

/* ═════════════════ 3. P2:箱子的生产注册 ═════════════════ */

test('FND129-9 ★★ 世界侧放着箱子块 ⇒ OPEN_CHEST 真的开得了(修前恒 INVALID)', () => {
  /* 怎么变红:删掉 `runChestAction` 里的 `registerChest(roomId, x, y)` ⇒ 第 3 行红
     (INVALID「不是箱子」)。 */
  const { rt, sim, roomId } = makeRoom();
  sim.setCell(CX, CY, { obj: STORAGE_CHEST });
  eq(sim.blockAt(CX, CY), 513, '前提:世界里那一格真的有箱子块');

  seed(rt, 'p1', LOG, 2);
  const put = chestAct(rt, RoomAction.OPEN_CHEST, LOG, 1);
  eq(put.ok, true,
    `★ 世界侧的箱子块 ⇒ 立即可开(修前 INVALID「不是箱子」;实测 kind=${put.kind} reason=${put.reason ?? '-'})`);
  eq(publicChestContents(roomId, CX, CY), [{ itemId: LOG, count: 1 }], '公共箱真有 1 件');

  const look = chestAct(rt, RoomAction.OPEN_CHEST, LOG, 1);
  eq(look.ok, true, '再存一次仍走同一条路(登记是幂等的)');
  eq(chestTotal(roomId), 2, '箱里 2 件');
  eq(rt.authoritativeItemCount('p1', LOG), 0, '背包那 2 件都扣掉了');
});

test('FND129-10 ★ 负对照:不是箱子块的格子仍然 INVALID(不能「有块就是箱子」)', () => {
  const { rt, sim, roomId } = makeRoom();
  sim.setCell(CX, CY, { obj: STORAGE_CHEST });
  sim.setCell(CX - 1, CY, { obj: PLANK }); /* (2,4):在射程内,但那是木板 */
  seed(rt, 'p1', LOG, 2);

  const onPlank = rt.dispatchAction('p1', RoomAction.OPEN_CHEST, { x: CX - 1, y: CY, itemId: LOG, count: 1 });
  eq(onPlank.ok, false, '★ 有块但**不是箱子** ⇒ 拒(判据是内容表的箱子 id,不是「有 obj」)');
  eq(onPlank.kind, 'INVALID', '归因 INVALID');
  eq(publicChestContents(roomId, CX - 1, CY), null, '★ 失败**不留登记**(那一格仍不是箱子)');
  eq(rt.authoritativeItemCount('p1', LOG), 2, '失败零副作用:背包没被扣');

  const empty = rt.dispatchAction('p1', RoomAction.OPEN_CHEST, { x: EMPTY_X, y: EMPTY_Y });
  eq(empty.ok, false, '负对照:空格 ⇒ 拒');
});

test('FND129-11 ★ USE_OWN_CHEST 同样随世界侧注册;公共/私有两本账仍隔离', () => {
  const { rt, sim, roomId } = makeRoom();
  sim.setCell(CX, CY, { obj: CLOUD_CHEST });
  seed(rt, 'p1', LOG, 2);

  const own = chestAct(rt, RoomAction.USE_OWN_CHEST, LOG, 2);
  eq(own.ok, true, `★ 私有抽屉也随世界侧箱子块注册(kind=${own.kind} reason=${own.reason ?? '-'})`);
  eq(ownChestContents(roomId, CX, CY, 'p1'), [{ itemId: LOG, count: 2 }], '抽屉里 2 件');
  eq(publicChestContents(roomId, CX, CY), [], '★ 公共箱**一件都没有**(隔离仍成立)');
});

test('FND129-12 ★ 接线判据:`registerChest` 有**生产调用点**(修前只有测试调用)', () => {
  const openSrc = read('server/src/net/actions/open_chest.ts');
  /* 只数**调用行**(缩进开头),不数 `export function registerChest(` 定义,
     也不数文档里提到的 `registerChest()`。 */
  const callLines = openSrc.split('\n').filter((l) => /^\s+registerChest\(/.test(l));
  eq(callLines.length, 1, '★ `open_chest.ts` 里恰有 1 处**生产调用** `registerChest(...)`(修前 0 处)');
  eq(callLines[0]?.trim(), 'registerChest(roomId, x, y);', '调用形态:按 (roomId, x, y) 登记');

  /* 负对照:同一个扫描器扫不到编造的名字(否则它可能恒真)。 */
  const ghost = openSrc.split('\n').filter((l) => /^\s+registerChestZzz\(/.test(l));
  eq(ghost.length, 0, '负对照:编造的名字扫不到');

  ok(openSrc.includes("tags.includes('储物')"),
    '箱子 id 集来自**内容表**标签,不是手写 513/514(第二份事实源会漂)');
});

/* ═════════════════ 4. P2:容器的件数上界 ═════════════════ */

test('FND129-13 ★★ 存到件数上界后拒,且那 1 件**不被吞**;取出方向不判上界', () => {
  /* 怎么变红:删掉 `inChest + count > CHEST_MAX_ITEMS` 那一段 ⇒ 第 5/6 行红。 */
  eq(CHEST_SLOTS, 24, '档数上界:内容层 513 的「24 格存储空间」');
  eq(CHEST_MAX_ITEMS, 24 * ITEMS_PER_CARRY_SLOT, '★ 件数上界 = 24 档 × 每格件数(一档与背包一格装得一样多)');

  const { rt, sim, roomId } = makeRoom();
  sim.setCell(CX, CY, { obj: STORAGE_CHEST });

  /* 每轮「塞 n 存 n」(n ≤ 40:单帧净变化有上限),把箱子填到上界差 1 件。 */
  const MAX = CHEST_MAX_ITEMS;
  let stored = 0;
  while (stored < MAX - 1) {
    const n = Math.min(40, MAX - 1 - stored);
    seed(rt, 'p1', LOG, n);
    const r = chestAct(rt, RoomAction.OPEN_CHEST, LOG, n);
    ok(r.ok, `前置:存 ${n} 件应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
    stored += n;
  }
  eq(chestTotal(roomId), MAX - 1, '前提:箱里差 1 件到上界');

  seed(rt, 'p1', LOG, 1);
  eq(chestAct(rt, RoomAction.OPEN_CHEST, LOG, 1).ok, true, '边界值**本身合法**(≤ 上界)');
  eq(chestTotal(roomId), MAX, '箱里正好到上界');

  seed(rt, 'p1', LOG, 1);
  const over = chestAct(rt, RoomAction.OPEN_CHEST, LOG, 1);
  eq(over.ok, false, '★ 上界 + 1 ⇒ 拒(修前同一 itemId 可无限堆)');
  eq(over.kind, 'INVALID', '归因 INVALID');
  eq(chestTotal(roomId), MAX, '★ 容器没变');
  eq(rt.authoritativeItemCount('p1', LOG), 1, '★ 那 1 件**没被吞**(判在扣背包之前 ⇒ 零副作用)');

  const take = chestAct(rt, RoomAction.OPEN_CHEST, LOG, -1);
  eq(take.ok, true, '负对照:取出方向**不**判件数上界(满了仍取得出来)');
  eq(chestTotal(roomId), MAX - 1, '取走后差 1 件到上界');
});

test('FND129-14 ★ 负对照:档数上界与件数上界**正交**(同一 itemId 不占新档)', () => {
  const { rt, sim, roomId } = makeRoom();
  sim.setCell(CX, CY, { obj: STORAGE_CHEST });

  const ids = ITEM_LIST.slice(0, 24).map((i) => i.id);
  eq(ids.length, 24, '前提:内容表至少 24 项');
  for (const id of ids) {
    seed(rt, 'p1', id, 1);
    const r = chestAct(rt, RoomAction.OPEN_CHEST, id, 1);
    ok(r.ok, `前置:存 #${id} 应成功(kind=${r.kind})`);
  }
  eq(stackCount(roomId), 24, '★ 24 个不同 itemId ⇒ 24 档');

  const extra = ITEM_LIST[24]?.id ?? 0;
  ok(extra > 0, '前提:内容表有第 25 项');
  seed(rt, 'p1', extra, 1);
  const full = chestAct(rt, RoomAction.OPEN_CHEST, extra, 1);
  eq(full.ok, false, '第 25 档 ⇒ 拒(档数上界仍在,没被件数上界顶掉)');
  ok(String(full.reason ?? '').includes('24'), '理由指向 24 格');

  seed(rt, 'p1', ids[0], 1);
  eq(chestAct(rt, RoomAction.OPEN_CHEST, ids[0], 1).ok, true,
    '★ 已有一档 ⇒ 仍能存(件数上界 192 之内);两道上界互不替代');
  eq(stackCount(roomId), 24, '档数仍是 24(同一 id 合并进已有那一档)');
});

/* ═════════════════ 5. P3:地面物品的守恒后果 ═════════════════ */

test('FND129-15 ★ 同格投放两次:按 itemId 聚合的读口件数守恒(不丢不重)', () => {
  /* ⚠️ 边界(如实记录):`id` 是否唯一由 `sim/world_sim.ts:dropItem` 决定
     (同一格两次 push 会得到两条 `id=151`)—— **不在本套件的改动集内**。
     本条钉的是**后果**:无论 id 是否唯一,生产读口(`groundItemsNear` /
     `consumeGroundItem`)按 `itemId` 聚合,件数既不丢也不重复计。 */
  const { sim } = makeRoom();
  const X = 6.5;
  const Y = 6.5;
  sim.dropItem(X, Y, PLANK, 2);
  sim.dropItem(X, Y, PLANK, 2);

  const sum = (): number => sim.groundItemsNear(X, Y, 1)
    .filter((p) => p.itemId === PLANK)
    .reduce((s, p) => s + p.count, 0);
  eq(sum(), 4, '★ 同格两次投放 = 4 件(两条记录或一条合并,读口都必须报 4)');
  eq(sim.consumeGroundItem(PLANK, 3, X, Y, 1), 3, '★ 真的扣得掉 3 件');
  eq(sum(), 1, '剩 1 件');
  eq(sim.consumeGroundItem(PLANK, 2, X, Y, 1), 1, '负对照:只剩 1 件 ⇒ 扣 2 只返回 1(不谎报)');
  eq(sim.consumeGroundItem(PLANK, 1, X, Y, 1), 0, '负对照:取空后返回 0');
  eq(sum(), 0, '取空后地面没有这件货');
});

test('FND129-16 ★ 报文入口**不隐藏**归因:reject 回执带拒因码', () => {
  const colySrc = read('server/src/net/room.colyseus.ts');
  ok(/client\.send\('reject', \{ kind: 'INVENTORY', code: r\.rejectCode \?\? null \}\)/.test(colySrc),
    '★ 入口把汇点给的拒因码带出去(修前一律折叠成 kind: INVENTORY)');
  ok(!/if \(!r\.allowed\) client\.send\('reject', \{ kind: 'INVENTORY' \}\)/.test(colySrc),
    '负对照:旧的折叠写法已不在');
  ok(!/code: r\.rejectCodeZzz/.test(colySrc), '负对照:编造的名字扫不到(证明上面不是恒真)');
});

report('WS-FND-129');