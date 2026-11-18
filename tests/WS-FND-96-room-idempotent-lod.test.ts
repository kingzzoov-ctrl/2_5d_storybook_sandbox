/**
 * WS-FND-96 —— 房间系统**幂等边界**(P2-3)+ 客户端 **LOD 合并顺序语义**(P2-13 / P3-1)。
 *
 * 这两条审计登记项的共同形状是「**看起来对,顺序不定**」:
 *
 *   · 牧场/炼金/百货的结算都是纯函数,**重复调用就重复出账**(慢帧重入、报文重放、
 *     上层重试都到同一个函数)—— 而门禁只调用一次,所以一直绿。
 *   · `aLodMerge` 与顶点色/法线的合并顺序此前**没有任何一处文字或判据**规定:
 *     「先合并再着色」与「先着色再合并(平均)」在平坦地形上逐像素相同,
 *     只有在块内 z 不一致时才分叉 ⇒ 顺序不定时,缺陷不可见。
 *
 * 每条判据都成对写(正面 + 负对照),另有三处**注入验证**(把实现改成错的形态,
 * 断言必须变红),见下表。
 *
 * | # | 判据 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- |
 * | 1 | 幂等键的**规范形态**:`房间@DAY:n` / `房间@ORDER:id`,非法输入 `null` | `settleKeyOf` 去掉 `Math.trunc` / 不 trim 房间名 |
 * | 2 | 占键:首次成功;重复**拒且不改账**(`seenAt` 仍是首次的时刻) | `claimSettlement` 在重复分支里覆盖 `claims.set` |
 * | 3 | 牧场:同一 `(ECO_RANCH, day)` 第二次拒、`lastRanch` 不动;负对照 `settleRanchDay` 连调两次**都出账**;`days=0` **不占**该日 | `settleRanchDayOnce` 先占键再判 `days>0` / 直接转调 `settleRanchDay` |
 * | 4 | 炼金:同一订单号第二次拒且 `craftCount` 仍 1;负对照 `brewInLab` 连调两次 ⇒ 2 | `brewInLabOnce` 漏掉 `settlementSeenAt` 预检 |
 * | 5 | 百货:同一订单号只扣一次库存;失败(库存不足)**不占**订单号,补货后同单号仍可成交 | `buyOnce` 在 `buy` 失败时也占键 |
 * | 6 | **注入**:漏掉房间前缀的键会让两个房间撞键(负对照正好撞上) | 键里去掉 `room` 前缀 |
 * | 7 | 真实几何(LOD0/1/3 × 平坦/台阶)每个面都自洽:颜色 = `faceColor(层(块z), 朝向)`、法线只由朝向定 | `chunk_geometry` 用「某格 z」着色 |
 * | 8 | 两档 LOD:平坦 ⇒ 颜色逐位相同;台阶 ⇒ 颜色**按主导 z 规则**变(不是平均) | 合并块 z 用「块内首格」而不是「最高格」 |
 * | 9 | **负对照**:两块颜色的平均值**不在调色板**里 ⇒ `lodPaletteOf === null`、`lodFaceSemantics !== null` | 先着色再合并 |
 * | 10 | `aLodMerge` 必须与该几何**真实使用**的 merge 一致(用面数交叉验算) | 装配时传错 lod / 几何与属性各读一个 lod |
 *
 * ## 断言右侧一律是**字面量**
 *
 * `'ECO_RANCH@DAY:7'` / `256` / `64` / `2` 都手写;只有「契约本身」(调色板色、层号)
 * 才引用被测模块的导出口(`faceColor` / `elevLayerOfZ`),因为它们**就是**规格。
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import {
  SETTLEMENT_ROOMS,
  claimSettlement,
  createSettlementLedger,
  settleKeyOf,
  settlementKeyCount,
  settlementSeenAt,
  type SettlementLedger,
  type SettlementScope,
} from '../server/src/systems/idempotency.ts';
import {
  settleRanchDay,
  settleRanchDayOnce,
  type RanchAnimal,
  type RanchDayResult,
  type RanchOnceOutcome,
} from '../server/src/systems/ranch.ts';
import { buy, buyOnce, type BuyOnceOutcome, type BuyResult, type PriceTable } from '../server/src/systems/depot.ts';
import {
  brewInLab,
  brewInLabOnce,
  createRoomSystemsState,
  settleRanch,
  settleRanchOnce,
  type BrewOnceOutcome,
  type RoomSystemsState,
} from '../server/src/systems/wiring.ts';
import { galleryEntryOf } from '../server/src/systems/alchemy_lab.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import { CHUNK_SIZE, type ChunkInput } from '../client/src/stage/tile_mesh.ts';
import { emitChunkGeometry, type ChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  LOD_MERGE_ORDER,
  elevLayerOfZ,
  faceColor,
  lodFaceSemantics,
  lodPaletteOf,
  lodTwoLevelDelta,
  mergedZOfFace,
  type FaceColor,
  type LodFaceSample,
} from '../client/src/stage/terrain_vcolor.ts';
import { assembleChunkGeometry } from '../client/src/three/compat.ts';
import { Elevation, packTile } from '../shared/types/tile.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 非空键(判据里不该出现 `null`;真出现了要报「键非法」而不是静默比较)。 */
function keyOf(roomKey: string, scope: SettlementScope): string {
  const k = settleKeyOf(roomKey, scope);
  if (k === null) throw new Error(`键非法:${roomKey} / ${JSON.stringify(scope)}`);
  return k;
}

function acceptedRanch(out: RanchOnceOutcome): RanchDayResult {
  if (!out.accepted) throw new Error(`期望结算,实际被拒:${out.reason}`);
  return out.result;
}

function acceptedBrew(out: BrewOnceOutcome): { first: boolean; craftCount: number } {
  if (!out.accepted) throw new Error(`期望炼出,实际被拒:${out.reason}`);
  return { first: out.outcome.first, craftCount: out.outcome.entry.craftCount };
}

function acceptedBuy(out: BuyOnceOutcome): BuyResult {
  if (!out.accepted) throw new Error(`期望成交,实际被拒:${out.reason}`);
  return out.result;
}

/** 牧场日结的一只达标绵羊(饲料 = 内容表 `tameItem` 123 黄金小麦)。 */
const SHEEP: readonly RanchAnimal[] = [{ speciesId: 'mob_sheep', affinity: 0.9 }];
const SHEEP_FEED: Readonly<Record<number, number>> = { 123: 4 };

/** 内容表前两件物品 —— 炼金炉要 2~4 件且都必须查得到。 */
const BREW_IDS: readonly number[] = [ITEM_LIST[0].id, ITEM_LIST[1].id];

/** 一张**喂进来的**价格表(内容表今天没有 `price`;无定价路径另有判据)。 */
const PRICE: PriceTable = Object.freeze({ 704: 10 });

/** 测试自造 Chunk:`tiles` 要**可写**(契约是 `ArrayLike<number>`,只读索引签名)。 */
type TestChunk = ChunkInput & { tiles: Uint32Array };

function emptyTiles(): Uint32Array {
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({ elev: Elevation.GROUND, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 }));
  return tiles;
}

/** 16×16 全同海拔层(平坦地形:两档 LOD 的块 z 必然相同)。 */
function flatChunk(): TestChunk {
  return { key: 'c_flat', cx: 0, cy: 0, tiles: emptyTiles() };
}

/**
 * 台阶地形:只有 (0,0) 一格抬到 CLIFF(z = 2),其余 GROUND(z = 0)。
 *
 * ⇒ LOD0 里 (1,0) 的顶面是层 1(z=0),而 LOD1 里覆盖 (0..1, 0..1) 的那个合并块
 *   主导 z = 2 ⇒ 层 3。这正是「颜色允许随 LOD 变,但只能按主导 z 规则变」的样本。
 */
function steppedChunk(): TestChunk {
  const tiles = emptyTiles();
  tiles[0] = packTile({ elev: Elevation.CLIFF, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 });
  return { key: 'c_step', cx: 0, cy: 0, tiles };
}

/** 把几何按**面**(每 4 个顶点一个 quad)切成 LOD 采样。 */
function facesOf(g: ChunkGeometry): LodFaceSample[] {
  const out: LodFaceSample[] = [];
  for (let f = 0; f < g.faceCount; f += 1) {
    const base = f * 4;
    const vertZ: number[] = [];
    for (let k = 0; k < 4; k += 1) vertZ.push(g.positions[(base + k) * 3 + 2]);
    out.push({
      vertZ,
      normal: { x: g.normals[base * 3], y: g.normals[base * 3 + 1], z: g.normals[base * 3 + 2] },
      color: { r: g.colors[base * 3], g: g.colors[base * 3 + 1], b: g.colors[base * 3 + 2] },
    });
  }
  return out;
}

function isTopFace(f: LodFaceSample): boolean {
  return Math.abs(f.normal.z - 1) <= 1e-6;
}

function sameColor(a: FaceColor, b: FaceColor): boolean {
  return Math.abs(a.r - b.r) <= 1e-6 && Math.abs(a.g - b.g) <= 1e-6 && Math.abs(a.b - b.b) <= 1e-6;
}

/* ═════════════════ 1. 幂等键:规范形态 + 非法输入 ═════════════════ */

test('FND96-1 幂等键规范形态:房间进键、日取整、非法输入一律 null', () => {
  /* 两种形态的**字面量**(判据不拿函数自己断言自己) */
  eq(keyOf('ECO_RANCH', { kind: 'DAY', day: 7 }), 'ECO_RANCH@DAY:7');
  eq(keyOf('ALCHEMY_LAB', { kind: 'ORDER', orderId: 'A-1' }), 'ALCHEMY_LAB@ORDER:A-1');
  eq(keyOf('CLOUD_DEPOT', { kind: 'ORDER', orderId: 'A-1' }), 'CLOUD_DEPOT@ORDER:A-1');

  /* 归一:房间名去空白、日向下取整、订单号去空白 */
  eq(keyOf('  ECO_RANCH  ', { kind: 'DAY', day: 7 }), 'ECO_RANCH@DAY:7', '房间名应 trim');
  eq(keyOf('ECO_RANCH', { kind: 'DAY', day: 3.9 }), 'ECO_RANCH@DAY:3', '日应向下取整');
  eq(keyOf('CLOUD_DEPOT', { kind: 'ORDER', orderId: ' A ' }), 'CLOUD_DEPOT@ORDER:A', '订单号应 trim');

  /* 非法输入:不猜、不兜底 */
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: -1 }), null, '负天数非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: Number.NaN }), null, 'NaN 天数非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'DAY', day: Number.POSITIVE_INFINITY }), null, '∞ 天数非法');
  eq(settleKeyOf('ECO_RANCH', { kind: 'ORDER', orderId: '   ' }), null, '纯空白订单号非法');
  eq(settleKeyOf('   ', { kind: 'DAY', day: 0 }), null, '空房间名非法');

  /* ★ 房间必须进键:同一订单号在两个房间给**不同**键(否则互相误判成重放) */
  const ranchOrder = keyOf('ECO_RANCH', { kind: 'ORDER', orderId: '7' });
  const depotOrder = keyOf('CLOUD_DEPOT', { kind: 'ORDER', orderId: '7' });
  ok(ranchOrder !== depotOrder, '两个房间的同一订单号不得压成同一个键');
  eq(ranchOrder, 'ECO_RANCH@ORDER:7');
  eq(depotOrder, 'CLOUD_DEPOT@ORDER:7');
  /* 三个房间的字面量与 rooms/effects.ts 的 ROOM_SYSTEM_IMPL 键一致 */
  eq([SETTLEMENT_ROOMS.ECO_RANCH, SETTLEMENT_ROOMS.ALCHEMY_LAB, SETTLEMENT_ROOMS.CLOUD_DEPOT],
    ['ECO_RANCH', 'ALCHEMY_LAB', 'CLOUD_DEPOT']);
});

/* ═════════════════ 2. 占键:首次成功 / 重复拒且不改账 ═════════════════ */

test('FND96-2 占键:第二次拒且**台账一位不动**(seenAt 仍是首次的时刻)', () => {
  const ledger: SettlementLedger = createSettlementLedger();
  eq(settlementKeyCount(ledger), 0, '空台账不得有键');

  const first = claimSettlement(ledger, 'ECO_RANCH@DAY:0', 9);
  ok(first.ok, '首次必须成功');
  if (!first.ok) return;
  eq(first.at, 9);

  const again = claimSettlement(ledger, 'ECO_RANCH@DAY:0', 99);
  eq(again.ok, false, '同一键第二次必须被拒');
  if (again.ok) return;
  eq(again.seenAt, 9, '拒绝时要报**首次**的时刻,不是本次的 99');
  eq(settlementSeenAt(ledger, 'ECO_RANCH@DAY:0'), 9, '重复不得覆盖台账里的时刻');
  eq(settlementKeyCount(ledger), 1, '重复不得让台账变大');
  eq(settlementSeenAt(ledger, 'ECO_RANCH@DAY:1'), undefined, '没占过的日 ⇒ undefined(不是 0)');
});

/* ═════════════════ 3. 牧场日结幂等(+ 负对照 + 0 天)═════════════════ */

test('FND96-3 牧场:同一 (ECO_RANCH, day) 只成功一次;负对照裸函数连调两次都出账', () => {
  const ledger = createSettlementLedger();
  const a = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 7 });
  const ra = acceptedRanch(a);
  eq(ra.days, 1);
  eq(ra.produce.length, 1, '达标绵羊应产出 1 行');
  eq(ra.feedConsumed, [{ itemId: 123, count: 1 }], '1 天吃 1 份 123');
  const keysAfterFirstDay = settlementKeyCount(ledger);
  eq(keysAfterFirstDay, 1);

  const b = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 7 });
  eq(b.accepted, false, '同一天第二次必须被拒');
  if (b.accepted) return;
  eq(b.replayed, true);
  eq(b.result, null, '被拒时账必须是空的(null),不能给一份「算过但没落」的回执');
  eq(b.key, 'ECO_RANCH@DAY:7');
  eq(settlementKeyCount(ledger), keysAfterFirstDay, '重放不得新增键');

  const c = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 8 });
  ok(c.accepted, '换一天必须能结');
  eq(settlementKeyCount(ledger), 2);

  /* ★ 负对照:裸纯函数没有任何记忆 ⇒ 连调两次**两次都出账**(这是本函数存在的理由) */
  const naked1 = settleRanchDay({ animals: SHEEP, feed: SHEEP_FEED, days: 1 });
  const naked2 = settleRanchDay({ animals: SHEEP, feed: SHEEP_FEED, days: 1 });
  eq(naked1.feedConsumed, [{ itemId: 123, count: 1 }], '负对照:第一次出账');
  eq(naked2.feedConsumed, [{ itemId: 123, count: 1 }], '负对照:第二次**照样**出账');
  eq(naked2.produce.length, 1, '负对照:第二次照样产出');

  /* 世界侧封装:被拒时 lastRanch 仍是那天成功的那份回执 */
  const st: RoomSystemsState = createRoomSystemsState();
  const okOnce = settleRanchOnce(st, 3, SHEEP, SHEEP_FEED, 1);
  const receipt = acceptedRanch(okOnce);
  ok(st.lastRanch === receipt, '成功时 lastRanch 指向这份回执');
  const replay = settleRanchOnce(st, 3, SHEEP, SHEEP_FEED, 1);
  eq(replay.accepted, false);
  ok(st.lastRanch === receipt, '重放不得改写 lastRanch(回执仍是那一天的)');
  /* 负对照:裸封装连调两次会各写一次回执,且两次都出账 */
  const st2: RoomSystemsState = createRoomSystemsState();
  const r1 = settleRanch(st2, SHEEP, SHEEP_FEED, 1);
  const r2 = settleRanch(st2, SHEEP, SHEEP_FEED, 1);
  eq([r1.feedConsumed.length, r2.feedConsumed.length], [1, 1], '负对照:裸封装两次各出一份账');
});

test('FND96-3b 牧场:结算天数为 0 ⇒ 拒且**不占**该日;非法日 ⇒ 键为 null', () => {
  const ledger = createSettlementLedger();
  const zero = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 0, day: 3 });
  eq(zero.accepted, false, '0 天没有账可结');
  if (zero.accepted) return;
  eq(zero.replayed, false, '0 天不是「重放」,而是「无可结」');
  eq(zero.result, null);
  eq(settlementKeyCount(ledger), 0, '0 天**不得**占用结算日(否则这一天被永久占掉)');

  /* 同一天随后真的过了一天 ⇒ 仍然结得出来 */
  const later = settleRanchDayOnce(ledger, { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: 3 });
  ok(later.accepted, '0 天没占键 ⇒ 同一天随后仍能结');
  eq(settlementKeyCount(ledger), 1);

  const bad = settleRanchDayOnce(createSettlementLedger(), { animals: SHEEP, feed: SHEEP_FEED, days: 1, day: -2 });
  eq(bad.accepted, false);
  if (bad.accepted) return;
  eq(bad.key, null, '非法日连键都造不出来');
  ok(bad.reason.includes('结算日非法'), `原因要指到结算日:${bad.reason}`);
});

/* ═════════════════ 4. 炼金幂等(+ 负对照)═════════════════ */

test('FND96-4 炼金:同一订单号第二次拒且 craftCount 仍 1;负对照 brewInLab 连调两次 ⇒ 2', () => {
  const st: RoomSystemsState = createRoomSystemsState();
  const input = (orderId: string) => ({
    itemIds: BREW_IDS,
    affinity: 0.7,
    suggestedSLogic: 0.9,
    discovererName: 'p1',
    at: 5,
    orderId,
  });

  const first = acceptedBrew(brewInLabOnce(st, input('ORD-X')));
  eq(first.first, true, '首单应是首创');
  eq(first.craftCount, 1);
  const keysAfterFirstBrew = settlementKeyCount(st.settled);
  eq(keysAfterFirstBrew, 1);
  const craftAfterFirst = galleryEntryOf(st.gallery, BREW_IDS)?.craftCount;
  eq(craftAfterFirst, 1);

  const replay = brewInLabOnce(st, input('ORD-X'));
  eq(replay.accepted, false, '同一订单号第二次必须被拒');
  if (replay.accepted) return;
  eq(replay.replayed, true);
  eq(replay.key, `ALCHEMY_LAB@ORDER:ORD-X`);
  eq(galleryEntryOf(st.gallery, BREW_IDS)?.craftCount, craftAfterFirst, '重放不得把 craftCount 再加一');
  eq(st.lastBrew?.craftCount, 1, 'lastBrew 仍是首单那一行');
  eq(settlementKeyCount(st.settled), keysAfterFirstBrew, '重放不得新增键');

  /* 换一张订单号 ⇒ 真的又炼了一次(既有语义保留) */
  const second = acceptedBrew(brewInLabOnce(st, input('ORD-Y')));
  eq(second.first, false, '同配方第二次不是首创');
  eq(second.craftCount, 2);

  /* 失败不占订单号:材料只有 1 件 ⇒ 被拒,键表不变;补齐后同单号仍可炼 */
  const st2: RoomSystemsState = createRoomSystemsState();
  const bad = brewInLabOnce(st2, { ...input('ORD-Z'), itemIds: [BREW_IDS[0]] });
  eq(bad.accepted, false);
  eq(settlementKeyCount(st2.settled), 0, '失败的合成不得占用订单号');
  const retry = brewInLabOnce(st2, input('ORD-Z'));
  ok(retry.accepted, '修好材料后用同一单号重试必须成功');
  eq(settlementKeyCount(st2.settled), 1);

  /* ★ 负对照:不带台账的 brewInLab 连调两次 ⇒ craftCount = 2(重复出账) */
  const st3: RoomSystemsState = createRoomSystemsState();
  const b1 = brewInLab(st3, { itemIds: BREW_IDS, affinity: 0.7, suggestedSLogic: 0.9, discovererName: 'p1', at: 5 });
  const b2 = brewInLab(st3, { itemIds: BREW_IDS, affinity: 0.7, suggestedSLogic: 0.9, discovererName: 'p1', at: 5 });
  ok(b1.ok && b2.ok, '负对照:两次都成功');
  eq(b1.ok ? b1.entry.craftCount : -1, 1);
  eq(b2.ok ? b2.entry.craftCount : -1, 2, '负对照:第二次把 craftCount 又加了一');
});

/* ═════════════════ 5. 百货购买幂等(+ 失败不占键)═════════════════ */

test('FND96-5 百货:同一订单号只扣一次库存;失败不占订单号,补货后同单号仍成交', () => {
  const ledger = createSettlementLedger();
  let stock: Record<number, number> = { 704: 5 };

  const first = acceptedBuy(buyOnce(ledger, { itemId: 704, qty: 1, stock, table: PRICE, orderId: 'ORD-A' }));
  eq(first.cost, 10, '成本 = 单价 10 × 1');
  stock = first.stock;
  const stockAfterFirst = stock[704];
  eq(stockAfterFirst, 4, '首单扣 1 件');
  const keysAfterFirstBuy = settlementKeyCount(ledger);
  eq(keysAfterFirstBuy, 1);

  const replay = buyOnce(ledger, { itemId: 704, qty: 1, stock, table: PRICE, orderId: 'ORD-A' });
  eq(replay.accepted, false, '同一订单号第二次必须被拒');
  if (replay.accepted) return;
  eq(replay.replayed, true);
  eq(replay.result, null, '被拒时不得给出「算过的库存」');
  eq(stock[704], stockAfterFirst, '重放不得再扣库存');
  eq(settlementKeyCount(ledger), keysAfterFirstBuy, '重放不得新增键');

  const other = acceptedBuy(buyOnce(ledger, { itemId: 704, qty: 2, stock, table: PRICE, orderId: 'ORD-B' }));
  stock = other.stock;
  eq(stock[704], 2, '换一张订单号 ⇒ 真的再扣 2 件');
  const keysAfterTwoOrders = settlementKeyCount(ledger);
  eq(keysAfterTwoOrders, 2);

  /* 失败(库存不足)**不占**订单号 */
  const broke = buyOnce(ledger, { itemId: 704, qty: 9, stock, table: PRICE, orderId: 'ORD-C' });
  eq(broke.accepted, false);
  if (broke.accepted) return;
  eq(broke.replayed, false, '库存不足不是重放');
  ok(broke.reason.includes('库存不足'), `原因要指到库存:${broke.reason}`);
  eq(settlementKeyCount(ledger), keysAfterTwoOrders, '失败不得占用订单号');
  const restocked = acceptedBuy(buyOnce(ledger, { itemId: 704, qty: 9, stock: { 704: 9 }, table: PRICE, orderId: 'ORD-C' }));
  eq(restocked.stock[704], undefined, '补货后同单号成交:9 件全买走 ⇒ 该键从库存里删掉');
  const keysAfterRestock = settlementKeyCount(ledger);
  eq(keysAfterRestock, 3);

  /* 无定价(内容表今天没有 price)同样不占键 */
  const unpriced = buyOnce(ledger, { itemId: 704, qty: 1, stock: { 704: 3 }, orderId: 'ORD-D' });
  eq(unpriced.accepted, false);
  if (unpriced.accepted) return;
  eq(settlementKeyCount(ledger), keysAfterRestock, '无定价不得占用订单号');

  /* ★ 负对照:不带台账的 buy 连调两次、各自把回执写回库存 ⇒ 扣两次 */
  let nakedStock: Record<number, number> = { 704: 3 };
  const n1 = buy({ itemId: 704, qty: 1, stock: nakedStock, table: PRICE });
  nakedStock = n1.stock;
  const n2 = buy({ itemId: 704, qty: 1, stock: nakedStock, table: PRICE });
  nakedStock = n2.stock;
  eq(nakedStock[704], 1, '负对照:同一笔重放被裸 buy 扣了两次');
});

/* ═════════════════ 6. 注入验证:漏掉房间前缀会撞键 ═════════════════ */

test('FND96-6 注入:键里不带房间前缀 ⇒ 两个房间撞键(负对照正好撞上);带上则互不影响', () => {
  /* 注入形态:手工造一个**丢掉**房间前缀的键,当作两个房间共用 */
  const naive = createSettlementLedger();
  const naiveKey = '@ORDER:7';
  ok(claimSettlement(naive, naiveKey, 1).ok, '牧场先结算');
  const clash = claimSettlement(naive, naiveKey, 2);
  eq(clash.ok, false, '注入后:百货的同一订单号被**误判成重放**');
  if (clash.ok) return;
  eq(clash.seenAt, 1, '误判时它报的还是牧场那次');

  /* 正解:带房间前缀 ⇒ 两次都成功 */
  const good = createSettlementLedger();
  ok(claimSettlement(good, keyOf('ECO_RANCH', { kind: 'ORDER', orderId: '7' }), 1).ok);
  ok(claimSettlement(good, keyOf('CLOUD_DEPOT', { kind: 'ORDER', orderId: '7' }), 2).ok,
    '不同房间的同一订单号必须各自成功');
  eq(settlementKeyCount(good), 2);
  /* 同一房间**内部**仍然只准成功一次(前缀不是去重的反例) */
  eq(claimSettlement(good, keyOf('ECO_RANCH', { kind: 'ORDER', orderId: '7' }), 3).ok, false);
});

/* ═════════════════ 7. 真实几何:每个面都必须自洽 ═════════════════ */

test('FND96-7 真实几何 LOD0/1/3(平坦 + 台阶):每面的颜色与法线都符合「先合并再着色」', () => {
  const cases: readonly (readonly [string, TestChunk])[] = [
    ['平坦', flatChunk()],
    ['台阶', steppedChunk()],
  ];
  let checked = 0;
  for (const [name, chunk] of cases) {
    for (const lod of [0, 1, 3]) {
      const g = emitChunkGeometry(chunk, lod);
      const faces = facesOf(g);
      ok(faces.length > 0, `${name} LOD${lod} 必须有面`);
      for (const f of faces) {
        const err = lodFaceSemantics(f);
        eq(err, null, `${name} LOD${lod} 块z=${mergedZOfFace(f.vertZ)} 面自洽:`);
        checked += 1;
      }
    }
  }
  ok(checked > 0, '一个面都没查 ⇒ 判据是恒真的');
  /* 平坦地形:顶面颜色 = 层 1 的亮档(字面量:GROUND 基色 × TOP_FACE_SHADE) */
  const flatTop = facesOf(emitChunkGeometry(flatChunk(), 0)).find((f) => isTopFace(f));
  ok(flatTop !== undefined, '平坦地形必须有顶面');
  if (flatTop === undefined) return;
  eq(lodPaletteOf(flatTop.color), { layer: 1, isTop: true }, '平坦地形顶面 = GROUND 亮档');
  near(flatTop.color.r, 0.42, 1e-6, 'GROUND 顶面 r');
  near(flatTop.color.g, 0.62, 1e-6, 'GROUND 顶面 g');
  near(flatTop.color.b, 0.36, 1e-6, 'GROUND 顶面 b');
});

/* ═════════════════ 8. 两档 LOD:一致 / 按规则变化 ═════════════════ */

test('FND96-8 两档 LOD:平坦 ⇒ 颜色与法线逐位相同;台阶 ⇒ 颜色只按主导 z 规则变', () => {
  /* 平坦:块 z 在两档下都是 0 ⇒ 颜色与法线必须逐位相同 */
  const flat0 = facesOf(emitChunkGeometry(flatChunk(), 0)).find(isTopFace);
  const flat1 = facesOf(emitChunkGeometry(flatChunk(), 1)).find(isTopFace);
  ok(flat0 !== undefined && flat1 !== undefined, '平坦地形两档都要有顶面');
  if (flat0 === undefined || flat1 === undefined) return;
  eq(lodTwoLevelDelta(flat0, flat1), null, '平坦地形两档:必须一致');
  ok(sameColor(flat0.color, flat1.color), '块 z 相同 ⇒ 顶点色逐位相同');
  eq([flat1.normal.x, flat1.normal.y, flat1.normal.z], [flat0.normal.x, flat0.normal.y, flat0.normal.z],
    '法线只由朝向定 ⇒ 两档逐位相同');

  /* 台阶:LOD0 的 (1,0) 是 GROUND(z=0),LOD1 覆盖它的合并块主导 z = 2 ⇒ 允许变色,但按规则 */
  const step0 = facesOf(emitChunkGeometry(steppedChunk(), 0));
  const step1 = facesOf(emitChunkGeometry(steppedChunk(), 1));
  const lowTop = step0.find((f) => isTopFace(f) && mergedZOfFace(f.vertZ) === 0);
  const highTop = step1.find((f) => isTopFace(f) && mergedZOfFace(f.vertZ) === 2);
  ok(lowTop !== undefined, 'LOD0 要有 z=0 的顶面');
  ok(highTop !== undefined, 'LOD1 的合并块主导 z 应为 2(块内最高非空 z)');
  if (lowTop === undefined || highTop === undefined) return;
  eq(lodTwoLevelDelta(lowTop, highTop), null, '块 z 变了 ⇒ 颜色按 faceColor(层(新块z), 朝向) 变');
  ok(!sameColor(lowTop.color, highTop.color), '这一对确实是「颜色变了」的样本(不是退化对照)');
  eq(lodPaletteOf(lowTop.color), { layer: 1, isTop: true }, 'LOD0 的 z=0 顶面是层 1 亮档');
  eq(lodPaletteOf(highTop.color), { layer: 3, isTop: true }, 'LOD1 合并块的 z=2 顶面是层 3 亮档');
  /* 颜色**必须**等于用合并块 z 算出来的那个值(不是两格颜色的平均) */
  const want = faceColor(elevLayerOfZ(2), true);
  near(highTop.color.r, want.r, 1e-6, '合并块色 r');
  near(highTop.color.g, want.g, 1e-6, '合并块色 g');
  near(highTop.color.b, want.b, 1e-6, '合并块色 b');
  /* 负对照:把 LOD1 的合并色换成"两块平均" ⇒ 判据必须红 */
  const avg: FaceColor = {
    r: (lowTop.color.r + highTop.color.r) / 2,
    g: (lowTop.color.g + highTop.color.g) / 2,
    b: (lowTop.color.b + highTop.color.b) / 2,
  };
  const averaged: LodFaceSample = { vertZ: highTop.vertZ, normal: highTop.normal, color: avg };
  ok(lodFaceSemantics(averaged) !== null, '负对照:平均色不得通过面级自检');
  ok(lodTwoLevelDelta(lowTop, averaged) !== null, '负对照:两档对照必须拒绝平均色');
});

/* ═════════════════ 9. LOD 负对照 + 两处注入 ═════════════════ */

test('FND96-9 负对照与注入:平均色不在调色板;用「某格 z」着色 / 换法线都必须红', () => {
  /* 调色板只有 8 色(4 层 × 亮/暗) */
  const palette: FaceColor[] = [];
  for (let layer = 0; layer < 4; layer += 1) {
    palette.push(faceColor(layer, true), faceColor(layer, false));
  }
  for (const c of palette) ok(lodPaletteOf(c) !== null, `调色板色必须能被反查:${JSON.stringify(c)}`);
  const mixed: FaceColor = {
    r: (faceColor(1, true).r + faceColor(3, true).r) / 2,
    g: (faceColor(1, true).g + faceColor(3, true).g) / 2,
    b: (faceColor(1, true).b + faceColor(3, true).b) / 2,
  };
  eq(lodPaletteOf(mixed), null, '★ 负对照:两层面色的平均值**不在**调色板里(先着色再合并是可判定的)');

  const topZ0: LodFaceSample = {
    vertZ: [0, 0, 0, 0],
    normal: { x: 0, y: 0, z: 1 },
    color: faceColor(elevLayerOfZ(0), true),
  };
  eq(lodFaceSemantics(topZ0), null, '正对照:z=0 顶面自洽');
  /* 注入 D:法线**是单位向量**但不在规范集(斜向 45°) */
  const skewed: LodFaceSample = { ...topZ0, normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 } };
  const errNormal = lodFaceSemantics(skewed);
  ok(errNormal !== null, '注入 D:非规范法线必须红');
  ok((errNormal ?? '').includes('规范集'), `注入 D 的红要指到规范集:${String(errNormal)}`);
  /* 注入 D2:非单位向量 —— 另一条独立的红(先于规范集判定) */
  const notUnit: LodFaceSample = { ...topZ0, normal: { x: 0.6, y: 0.6, z: 0.5 } };
  const errUnit = lodFaceSemantics(notUnit);
  ok(errUnit !== null, '注入 D2:非单位法线必须红');
  ok((errUnit ?? '').includes('单位向量'), `注入 D2 的红要指到单位向量:${String(errUnit)}`);

  /* 注入 A:用「块内另一格的 z」着色(等价于块内逐格着色)= 层号与块 z 不符 */
  const injectedLayer: LodFaceSample = { ...topZ0, color: faceColor(elevLayerOfZ(1), true) };
  const errLayer = lodFaceSemantics(injectedLayer);
  ok(errLayer !== null, '注入 A:用 z=1 的层去着 z=0 的块必须红');
  ok((errLayer ?? '').includes('颜色层'), `注入 A 的红要指到颜色层:${String(errLayer)}`);

  /* 注入 B:顶面却用侧面(暗档)颜色 —— 法线朝上,着色档却是侧面 */
  const injectedShade: LodFaceSample = { ...topZ0, color: faceColor(elevLayerOfZ(0), false) };
  const errShade = lodFaceSemantics(injectedShade);
  ok(errShade !== null, '注入 B:顶面用侧面暗档必须红');
  ok((errShade ?? '').includes('着色档与法线冲突'), `注入 B 的红要指到档位冲突:${String(errShade)}`);

  /* 注入 C:法线换成水平(侧面)而颜色仍是顶面亮档 */
  const injectedNormal: LodFaceSample = { ...topZ0, normal: { x: 0, y: 1, z: 0 } };
  ok(lodFaceSemantics(injectedNormal) !== null, '注入 C:法线与着色档必须一致');

});

/* ═════════════════ 10. 顺序常量 + aLodMerge 与几何同源 ═════════════════ */

test('FND96-10 顺序常量钉住 + aLodMerge 必须等于该几何真实使用的 merge(面数交叉验算)', () => {
  eq(LOD_MERGE_ORDER, 'MERGE_THEN_COLOR', '顺序不得被改成「先着色再合并」');
  eq(mergedZOfFace([]), Number.NEGATIVE_INFINITY, '空面 ⇒ 无块 z');
  eq(mergedZOfFace([0, 2, 0, 0]), 2, '块 z = 块内最高(与 dominantZGrid 同规则)');
  eq(lodPaletteOf(faceColor(0, true)), { layer: 0, isTop: true });
  eq(lodPaletteOf({ r: 0.5, g: 0.5, b: 0.5 }), null, '灰不在调色板里');

  /* LOD0:16×16 格全部有顶面 ⇒ 256 面;aLodMerge = 1 */
  const g0 = emitChunkGeometry(flatChunk(), 0);
  eq(g0.faceCount, 256, '平坦 LOD0 面数 = 16×16');
  const a0 = assembleChunkGeometry(g0, 0).getAttribute('aLodMerge');
  ok(a0 !== undefined, 'aLodMerge 必须被装配');
  if (a0 === undefined) return;
  eq(a0.itemSize, 1, 'aLodMerge 每顶点 1 分量');
  eq(a0.array[0], 1, 'aLodMerge(LOD0) = 1');

  /* LOD1:8×8 合并块 ⇒ 64 面;aLodMerge = 2 —— 面数与属性必须说的是同一个 merge */
  const g1 = emitChunkGeometry(flatChunk(), 1);
  eq(g1.faceCount, 64, '平坦 LOD1 面数 = 8×8(merge 2 的平方反比)');
  const a1 = assembleChunkGeometry(g1, 1).getAttribute('aLodMerge');
  ok(a1 !== undefined, 'aLodMerge 必须被装配(LOD1)');
  if (a1 === undefined) return;
  eq(a1.array[0], 2, 'aLodMerge(LOD1) = 2');
  eq(a1.count, g1.vertexCount, 'aLodMerge 一个顶点一个分量');

  /* ★ 负对照:装配时传错 lod ⇒ 属性说 1、几何却是 LOD1 的 64 面(两者必须同源) */
  const wrong = assembleChunkGeometry(g1, 0).getAttribute('aLodMerge');
  ok(wrong !== undefined, '负对照:仍会写属性');
  if (wrong === undefined) return;
  eq(wrong.array[0], 1, '负对照:传错 lod 时属性会说 1,而几何仍是上面算出的 64 面 ⇒ 两者只能来自同一个 lod');
});

report('WS-FND-96');