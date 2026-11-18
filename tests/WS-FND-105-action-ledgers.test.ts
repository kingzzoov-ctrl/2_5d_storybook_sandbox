/**
 * WS-FND-105 —— 动作层**五本侧账/令牌**的修复判据(审计实测 5 条)。
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | `BUY_ITEM` 同帧第二单**不再被判重放**;显式 `orderId` 重发仍按重放拒 | `purchaseCommit` 只传 `actorId` ⇒ 键退化成 `actor#item#frame` | 去掉 `orderId`(FND105-1 第 1/2 行) |
 * | 2 | 负对照:同帧**两个玩家**买同一件 ⇒ 键不同、各成交一次 | 同上(键少了维) | 把 `actorId` 从 opts 里删掉 |
 * | 3 | `USE_ALCHEMY_FURNACE` 重放 ⇒ **零副作用**(不扣料/不出第二炉/不再 `brewAtFurnace`) | 判重发生在 `spend`+`gain` **之后** | 把 `claimFurnaceOrder` 挪回 `brew` 之前 |
 * | 4 | 炼金预占在**失败后释放**:同单号补齐条件仍可炼 | 先占键再判成败会把订单锁死 | 删掉 `releaseFurnaceOrder(...)` |
 * | 5 | 正向发放失败 ⇒ 产物/取出的**凭证被撤销**(撤销后那张串不再是合法来源) | `bindItemSource` 之后 `!gain.allowed` 直接返回 | 删掉 `unbindItemSource(...)` |
 * | 6 | 退回**失败**要进回执(`use_item` / `place_block`),且退回凭证一并撤销 | `ctx.applyInventory` 的返回值被丢 | 把 `refund()` 改回 `void` |
 * | 7 | `RESET_WORLD` 成功 ⇒ 本房间三本侧账(箱子/放置/宠物)清空,**另一个房间不动** | 三个模块级 Map 全仓 0 个回收点 | 删掉 `forgetRoomSideLedgers` 那一段 |
 * | 8 | 负对照:`resetWorld` 回 `applied:false` ⇒ 侧账**一本都不动** | 同上(回收必须挂在成功回执路径) | 把回收提到 `if (!r.applied)` 之前 |
 * | 9 | 真实 `RoomRuntime`:登记过的令牌**就是**合法来源;`revokeItemSource` 撤掉后同一张串被拒 | 令牌只增不减(P3) | 删掉 `RoomRuntime.revokeItemSource` |
 *
 * ## 夹具的诚实边界
 *
 * 判据 1~8 用**手搓 `ctx`**(动作层的单元面):`applyInventory` 的闸按
 * `anticheat.checkInventory` 的同一条规则实现 —— **正 delta 必须带一张已登记的
 * 来源串**(无凭证 ⇒ `ITEM_FROM_NOTHING`),负 delta 必须够件。它不是那份实现的
 * 复制品:真闸的验签/一次性/tick 绑定在 `WS-FND-87` 里钉,本文件第 9 条又用
 * **真 `RoomRuntime`** 把「撤销」这一条在真闸上复核一次。
 *
 * 运行:`node tests/WS-FND-105-action-ledgers.test.ts`
 */
import { test, ok, eq, mulberry32, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { ItemSourcePurpose, parseItemSourceToken } from '../server/src/net/anticheat.ts';
import { bindItemSource, unbindItemSource } from '../server/src/net/actions/item_source.ts';
import { publicChestContents, registerChest, CHEST_SLOTS } from '../server/src/net/actions/open_chest.ts';
import { placementAt } from '../server/src/net/actions/place_automation.ts';
import { petsOfRoom } from '../server/src/net/actions/breed_tame.ts';
import { ALCHEMY_LAB_ROOM_KEY } from '../server/src/net/actions/use_alchemy_furnace.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import type { ActionOutcome } from '../server/src/net/room.ts';
import { tameableMobs } from '../shared/constants/mobs.ts';

/* ───────────────────────── 内容层锚点(字面量取自冻结表) ───────────────────────── */

const SAND = 108;     /* 琉璃石英砂:165 陶瓷空药水瓶的唯一材料 */
const BOTTLE = 165;   /* 产物,`output: 3` */
const LOG = 101;      /* 暖松原木(建材) */
const FEATHER = 733;  /* 复苏天使羽毛笔(道具) */
const CONVEYOR_ID = 428;          /* `LOGISTICS_CONVEYOR` 的实物 id */
const CONVEYOR_KIND = 'LOGISTICS_CONVEYOR';

/* ───────────────────────── 夹具 1:手搓 ctx(动作层单元面) ───────────────────────── */

type Op = { itemId: number; delta: number; source?: string };
type Batch = { ops: Op[]; allowed: boolean; rejectCode?: string };

type Rig = {
  ctx: ActionContext;
  state: { roomId: string; meta: { tick: number } };
  counts: Map<number, number>;
  sources: Set<string>;
  revoked: string[];
  batches: Batch[];
  limits: { denyPositive: number; denyNegative: number; capacity: number };
};

type RigOptions = {
  roomId?: string;
  tick?: number;
  actorId?: string;
  owns?: Record<number, number>;
  capacity?: number;
  host?: Record<string, unknown> | null;
  position?: { x: number; y: number } | null;
};

/**
 * 手搓一个 `ActionContext`。
 *
 * `applyInventory` 的规则与 `anticheat.checkInventory` 的**关键那条**一致:
 * 正 delta 必须带一张**已登记**的来源串,负 delta 必须够件,总量不得超容量。
 * 另有两个**注入开关**(`denyPositive` / `denyNegative`)—— 它们让「发放被拒」
 * 「扣料被拒」这两条失败支路可以被精确触发,而不必靠容量去凑。
 */
function makeRig(o: RigOptions = {}): Rig {
  const roomId = o.roomId ?? 'wsfnd105_room';
  const tick = o.tick ?? 5;
  const actorId = o.actorId ?? 'p1';
  const counts = new Map<number, number>(Object.entries(o.owns ?? {}).map(([k, v]) => [Number(k), v]));
  const sources = new Set<string>();
  const revoked: string[] = [];
  const batches: Batch[] = [];
  const limits = { denyPositive: 0, denyNegative: 0, capacity: o.capacity ?? 99 };

  const apply = (ops: readonly Op[]): { allowed: boolean; rejectCode?: string } => {
    const batch: Batch = { ops: ops.map((x) => ({ ...x })), allowed: false };
    batches.push(batch);
    let net = 0;
    for (const op of ops) {
      if (!Number.isInteger(op.delta)) {
        batch.rejectCode = 'MALFORMED';
        return { allowed: false, rejectCode: 'MALFORMED' };
      }
      if (op.delta > 0) {
        if (limits.denyPositive > 0) {
          limits.denyPositive -= 1;
          batch.rejectCode = 'ITEM_OVERFLOW';
          return { allowed: false, rejectCode: 'ITEM_OVERFLOW' };
        }
        if (op.source === undefined || !sources.has(op.source)) {
          batch.rejectCode = 'ITEM_FROM_NOTHING';
          return { allowed: false, rejectCode: 'ITEM_FROM_NOTHING' };
        }
      } else if (op.delta < 0) {
        if (limits.denyNegative > 0) {
          limits.denyNegative -= 1;
          batch.rejectCode = 'NEGATIVE';
          return { allowed: false, rejectCode: 'NEGATIVE' };
        }
        if ((counts.get(op.itemId) ?? 0) < -op.delta) {
          batch.rejectCode = 'NEGATIVE';
          return { allowed: false, rejectCode: 'NEGATIVE' };
        }
      }
      net += op.delta;
    }
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (total + net > limits.capacity) {
      batch.rejectCode = 'ITEM_OVERFLOW';
      return { allowed: false, rejectCode: 'ITEM_OVERFLOW' };
    }
    for (const op of ops) {
      if (op.delta === 0) continue;
      const next = (counts.get(op.itemId) ?? 0) + op.delta;
      if (next === 0) counts.delete(op.itemId);
      else counts.set(op.itemId, next);
    }
    batch.allowed = true;
    return { allowed: true };
  };

  const state = { roomId, meta: { tick } };
  const ctx = {
    actorId,
    action: RoomAction.BUY_ITEM,
    payload: {},
    state,
    host: o.host ?? null,
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' }),
    materialsOf: () => null,
    hostPositionOf: () => o.position ?? null,
    applyInventory: (_userId: string, input: { ops: readonly Op[] }) => apply(input.ops),
    grantItemSource: (_userId: string, source: string) => { sources.add(source); },
    /* ★ 被测的那一口:动作层只能经 `unbindItemSource` 调它。 */
    revokeItemSource: (_userId: string, source: string) => { sources.delete(source); revoked.push(source); },
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
    itemCountOf: (_userId: string, itemId: number) => counts.get(itemId) ?? 0,
    itemIdsOf: () => [...counts.keys()],
  } as unknown as ActionContext;

  return { ctx, state, counts, sources, revoked, batches, limits };
}

/**
 * 发一次动作:`payload` 每次都是新对象,`state` 引用保持不变
 * (订单序号与炼金预占都按 `ctx.state` 的对象身份分桶 —— 同一个 rig 必须共享它)。
 */
function disp(rig: Rig, action: RoomAction, payload: Record<string, unknown> = {}): ActionOutcome {
  const ctx = { ...rig.ctx, action, payload } as unknown as ActionContext;
  return dispatchOf(action)(ctx);
}

/** 动作名 → 处理器(与 `ACTION_HANDLERS` 用的是**同一批导出**;这里只做名字映射)。 */
function dispatchOf(action: RoomAction): (ctx: ActionContext) => ActionOutcome {
  const table: Partial<Record<RoomAction, (ctx: ActionContext) => ActionOutcome>> = {
    [RoomAction.BUY_ITEM]: BUY,
    [RoomAction.USE_ALCHEMY_FURNACE]: BREW,
    [RoomAction.OPEN_CHEST]: OPEN,
    [RoomAction.USE_ITEM]: USE,
    [RoomAction.PLACE_BLOCK]: PLACE,
    [RoomAction.PLACE_AUTOMATION]: AUTOMATE,
    [RoomAction.BREED_TAME]: TAME,
    [RoomAction.RESET_WORLD]: RESET,
  };
  const fn = table[action];
  if (fn === undefined) throw new Error(`本套件没有登记动作 ${action}`);
  return fn;
}

const effectOf = (out: ActionOutcome): Record<string, string | number | boolean> =>
  (out.effect ?? {}) as Record<string, string | number | boolean>;

/* 处理器以**值**导入(与 action_table 同一批模块);上面 `dispatchOf` 只做名字→函数。 */
import { buyItem as BUY } from '../server/src/net/actions/buy_item.ts';
import { useAlchemyFurnace as BREW } from '../server/src/net/actions/use_alchemy_furnace.ts';
import { openChest as OPEN } from '../server/src/net/actions/open_chest.ts';
import { useItem as USE } from '../server/src/net/actions/use_item.ts';
import { placeBlock as PLACE } from '../server/src/net/actions/material.ts';
import { placeAutomation as AUTOMATE } from '../server/src/net/actions/place_automation.ts';
import { breedTame as TAME } from '../server/src/net/actions/breed_tame.ts';
import { resetWorld as RESET } from '../server/src/net/actions/reset_world.ts';

/* ─────────────────── 夹具 2:假世界源(与生产同语义的最小面) ─────────────────── */

/** 百货摊位:**幂等键 = `orderId`**(与 `WorldSim.purchaseCommit` 同一语义)。 */
function makeDepot(initial: Record<number, number>): {
  host: Record<string, unknown>;
  stock: Record<number, number>;
  orders: string[];
} {
  const stock: Record<number, number> = { ...initial };
  const orders: string[] = [];
  const settled = new Set<string>();
  const host = {
    purchaseQuote: (itemId: number, qty: number) => {
      const have = stock[itemId] ?? 0;
      if (have < qty) {
        return { ok: false, reason: `库存不足:只剩 ${have} 件`, cost: 0, stock: { ...stock } };
      }
      return { ok: true, reason: '成交', cost: 10 * qty, stock: { ...stock, [itemId]: have - qty } };
    },
    purchaseCommit: (itemId: number, qty: number, opts?: { actorId?: string; orderId?: string }) => {
      const orderId = opts?.orderId ?? '';
      orders.push(orderId);
      const have = stock[itemId] ?? 0;
      if (settled.has(orderId)) {
        return { ok: false, cost: 0, reason: `幂等键 ${orderId} 已结算过 ⇒ 拒绝`, replayed: true, stockOfItem: have };
      }
      if (have < qty) {
        return { ok: false, cost: 0, reason: '库存不足', replayed: false, stockOfItem: have };
      }
      settled.add(orderId);
      stock[itemId] = have - qty;
      if (stock[itemId] === 0) delete stock[itemId];
      return { ok: true, cost: 10 * qty, reason: '成交', replayed: false, stockOfItem: stock[itemId] ?? 0 };
    },
  };
  return { host, stock, orders };
}

/** 炼金台:记录每次 `brewAtFurnace` 的订单号(判据用它证明「没有第二次」)。 */
function makeFurnace(actorId: string): { host: Record<string, unknown>; brews: string[] } {
  const brews: string[] = [];
  const host = {
    lastRoomEffects: [{ playerId: actorId, roomKey: ALCHEMY_LAB_ROOM_KEY }],
    brewAtFurnace: (who: string, ids: readonly number[], opts?: { orderId?: string }) => {
      brews.push(opts?.orderId ?? `${who}#${ids.join('_')}`);
      return {
        ok: true,
        first: brews.length === 1,
        entry: {
          recipeHash: 'h', discovererName: who, itemName: 'x', itemCategory: 'y',
          craftCount: brews.length, firstAt: 0, schemaJson: '{}',
        },
        display: [],
      };
    },
  };
  return { host, brews };
}

/** 物质层桩:只用来让 `placeBlock` 走到「世界拒绝 ⇒ 退回」那条支路。 */
function makeMaterials(place: { ok: boolean; reason?: string }): { api: Record<string, unknown> } {
  const api = {
    blockAt: () => 0,
    placeBlock: () => (place.ok ? { ok: true } : { ok: false, reason: place.reason ?? '被拒' }),
    dropItem: () => undefined,
    groundItemsNear: () => [],
    breakBlock: () => ({ ok: false, reason: '本套件不用拆块' }),
    takeGroundItemNear: () => false,
  };
  return { api };
}

/** rig 的 `applyInventory`(判据要问「这张串还能不能用」)。 */
type ApplyFn = (userId: string, input: { ops: readonly Op[] }) => { allowed: boolean; rejectCode?: string };
const applyVia = (rig: Rig, ops: readonly Op[]): { allowed: boolean; rejectCode?: string } =>
  (rig.ctx as unknown as { applyInventory: ApplyFn }).applyInventory('p1', { ops });

/* ═════════════════════════ 1. BUY_ITEM:同帧多单 ═════════════════════════ */

test('FND105-1 BUY_ITEM 同一帧的第二单不再被判重放;显式 orderId 重发仍被拒', () => {
  /* 注入:只传 `{ actorId }`(不传 `orderId`)⇒ 世界侧键退化成 `actor#item#frame`
     ⇒ 第二单 `replayed:true` ⇒ 第 3 行红。 */
  const depot = makeDepot({ [LOG]: 5 });
  const rig = makeRig({ roomId: 'wsfnd105_buy', tick: 9, host: depot.host });

  const first = disp(rig, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1 });
  const second = disp(rig, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1 });

  eq(first.ok, true, `第一单应成交(实测 ${first.kind} / ${first.reason ?? '-'})`);
  eq(second.ok, true, `★ 同帧第二单也必须成交(修前被判重放;实测 ${second.kind} / ${second.reason ?? '-'})`);
  eq(depot.orders.length, 2, '两单各提交一次');
  ok(depot.orders[0] !== depot.orders[1],
    `★ 两单的幂等键必须不同(实测 ${depot.orders.join(' / ')})`);
  eq(depot.stock[LOG], 3, '★ 两单各扣一件库存');
  eq(rig.counts.get(LOG), 2, '背包真的 +2');
  eq(effectOf(first).orderId, depot.orders[0], '回执如实带本单的键');

  /* 负对照:显式 orderId 重发 ⇒ 世界侧按重放拒,库存与背包都只算一次。 */
  const a = disp(rig, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1, orderId: 'ORD-A' });
  eq(a.ok, true, `带显式订单号的第一单应成交(实测 ${a.reason ?? '-'})`);
  const replay = disp(rig, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1, orderId: 'ORD-A' });
  eq(replay.ok, false, '★ 同一单号重发必须被拒(第 1 条修法不许把幂等弄丢)');
  eq(replay.kind, 'INVALID', '拒因分类是状态问题');
  ok((replay.reason ?? '').includes('已结算'), `理由要指到重放(实测:${replay.reason ?? '-'})`);
  eq(depot.stock[LOG], 2, '★ 重放不得再扣库存');
  eq(rig.counts.get(LOG), 3, '背包也没有多出来(先入包再退回,净值不变)');
});

/* ═════════════════════════ 2. 负对照:两个玩家同帧 ═════════════════════════ */

test('FND105-2 负对照:同一帧两个玩家买同一件 ⇒ 键不同、各自成交', () => {
  /* 注入:把 `actorId` 从 opts 里删掉 ⇒ 退化键 `#item#frame` 撞同一把 ⇒ 第二个玩家红。 */
  const depot = makeDepot({ [LOG]: 5 });
  const rigA = makeRig({ roomId: 'wsfnd105_two', tick: 3, actorId: 'p1', host: depot.host });
  const rigB = makeRig({ roomId: 'wsfnd105_two', tick: 3, actorId: 'p2', host: depot.host });

  const a = disp(rigA, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1 });
  const b = disp(rigB, RoomAction.BUY_ITEM, { itemId: LOG, qty: 1 });
  eq(a.ok, true, `p1 应成交(实测 ${a.reason ?? '-'})`);
  eq(b.ok, true, `★ p2 也必须成交(实测 ${b.reason ?? '-'})`);
  eq(depot.orders.length, 2);
  ok(depot.orders[0] !== depot.orders[1], `★ 两个人的键必须不同(${depot.orders.join(' / ')})`);
  eq(depot.stock[LOG], 3, '两单各扣一件');
  eq(rigA.counts.get(LOG), 1, 'p1 背包 +1');
  eq(rigB.counts.get(LOG), 1, 'p2 背包 +1');
});

/* ═════════════════════════ 3. 炼金:判重前移 ═════════════════════════ */

test('FND105-3 USE_ALCHEMY_FURNACE 同一单号重放 ⇒ 零副作用(不扣料 / 不出第二炉)', () => {
  /* 注入:把判重挪回 `brewAtFurnace` 之前(修前的顺序 = spend → gain → brew)⇒
     重放会再扣一次料、再发一次产物 ⇒ 第 6/7/8 行红。 */
  const furnace = makeFurnace('p1');
  const rig = makeRig({ roomId: 'wsfnd105_brew', tick: 12, host: furnace.host, owns: { [SAND]: 4 } });
  const payload = { itemId: BOTTLE, orderId: 'ORD-1' };

  const first = disp(rig, RoomAction.USE_ALCHEMY_FURNACE, payload);
  eq(first.ok, true, `前置:第一炉应成功(实测 ${first.kind} / ${first.reason ?? '-'})`);
  eq(rig.counts.get(SAND), 3, '前置:扣掉 1 件材料');
  eq(rig.counts.get(BOTTLE), 3, '前置:产出 3 瓶');
  eq(rig.batches.length, 2, '前置:一次炼制 = 扣料 + 发产物 两批 ops');

  const replay = disp(rig, RoomAction.USE_ALCHEMY_FURNACE, payload);
  eq(replay.ok, false, '★ 同一单号重放必须被拒');
  eq(replay.kind, 'INVALID', '重放是状态问题(INVALID),不是越权');
  ok((replay.reason ?? '').includes('结算过'), `理由要指到「已结算」(实测:${replay.reason ?? '-'})`);
  eq(rig.batches.length, 2, '★ 判重前移:重放**一批 ops 都没提交**(修前这里会多 2 批)');
  eq(rig.counts.get(SAND), 3, '★ 材料一件都没再扣');
  eq(rig.counts.get(BOTTLE), 3, '★ 没有第二炉');
  eq(furnace.brews.length, 1, '★ 世界侧只被叫过一次(修前第二次也会被叫,只是被世界侧拒)');
});

/* ═════════════════════════ 4. 炼金:预占在失败后释放 ═════════════════════════ */

test('FND105-4 炼金预占在失败后释放:同单号补齐条件后仍能炼', () => {
  /* 注入:删掉 `releaseFurnaceOrder(...)` ⇒ 第一次失败占住单号 ⇒ 第二次被当重放 ⇒ 第 3 行红。 */
  const furnace = makeFurnace('p1');
  const rig = makeRig({ roomId: 'wsfnd105_brew_rel', tick: 20, host: furnace.host, owns: { [SAND]: 4 } });
  rig.limits.denyNegative = 1; /* 第一次「扣料」被拒 */
  const payload = { itemId: BOTTLE, orderId: 'ORD-R' };

  const first = disp(rig, RoomAction.USE_ALCHEMY_FURNACE, payload);
  eq(first.ok, false, '前置:扣料被拒 ⇒ 整笔失败');
  eq(first.kind, 'INVALID');
  ok((first.reason ?? '').includes('材料扣减被拒'), `理由要指到扣料(实测:${first.reason ?? '-'})`);
  eq(rig.counts.get(SAND), 4, '前置:零副作用');
  eq(furnace.brews.length, 0, '前置:一炉都没记');

  const retry = disp(rig, RoomAction.USE_ALCHEMY_FURNACE, payload);
  eq(retry.ok, true, `★ 失败必须释放预占(否则同单号被永久锁死;实测 ${retry.kind} / ${retry.reason ?? '-'})`);
  eq(furnace.brews.length, 1, '世界侧只记一炉');
  eq(rig.counts.get(BOTTLE), 3, '产物进包');
});

/* ═════════════════════════ 5. 正向失败 ⇒ 撤销凭证 ═════════════════════════ */

test('FND105-5 正向发放失败 ⇒ 产物/取出的凭证被撤销(那张串不再可用)', () => {
  /* 注入:删掉 `unbindItemSource(ctx, src)` ⇒ `revoked` 为空、那张串仍是合法来源
     ⇒ 第 5/8 行红。 */
  const furnace = makeFurnace('p1');
  const rig = makeRig({ roomId: 'wsfnd105_tok_brew', tick: 30, host: furnace.host, owns: { [SAND]: 4 } });
  rig.limits.denyPositive = 1; /* 产物发放被拒 */

  const out = disp(rig, RoomAction.USE_ALCHEMY_FURNACE, { itemId: BOTTLE, orderId: 'ORD-T' });
  eq(out.ok, false, '前置:产物收不下 ⇒ 失败');
  eq(rig.counts.get(SAND), 4, '材料已退回');
  eq(rig.counts.get(BOTTLE), undefined, '没有产物');
  eq(rig.revoked.length, 1, '★ 产物凭证必须被撤销(修前它留到 tick 末)');
  const token = parseItemSourceToken(rig.revoked[0]);
  eq(token?.itemId, BOTTLE, '★ 撤的是产物那张(令牌绑 itemId)');
  eq(rig.sources.has(rig.revoked[0]), false, '撤销后它不再是「已登记来源」');
  const reuse = applyVia(rig, [{ itemId: BOTTLE, delta: 1, source: rig.revoked[0] }]);
  eq(reuse.allowed, false, '★ 拿撤销过的串当来源必须被拒');
  eq(reuse.rejectCode, 'ITEM_FROM_NOTHING', '拒因是「凭空产出」');

  /* (b) OPEN_CHEST 取出:背包收不下 ⇒ 放回箱子 + 撤销取出凭证。 */
  const roomId = 'wsfnd105_tok_chest';
  const rig2 = makeRig({ roomId, tick: 31, owns: { [LOG]: 1 }, position: { x: 1, y: 1 } });
  registerChest(roomId, 1, 1);
  const stored = disp(rig2, RoomAction.OPEN_CHEST, { x: 1, y: 1, itemId: LOG, count: 1 });
  eq(stored.ok, true, `前置:存入应成功(实测 ${stored.reason ?? '-'})`);
  eq(publicChestContents(roomId, 1, 1), [{ itemId: LOG, count: 1 }], `箱子里有 1 件(上限 ${CHEST_SLOTS} 档)`);
  rig2.limits.denyPositive = 1; /* 取出的正向发放被拒 */
  const take = disp(rig2, RoomAction.OPEN_CHEST, { x: 1, y: 1, itemId: LOG, count: -1 });
  eq(take.ok, false, '前置:收不下 ⇒ 失败');
  eq(publicChestContents(roomId, 1, 1), [{ itemId: LOG, count: 1 }], '东西放回箱子');
  eq(rig2.revoked.length, 1, '★ 取出凭证被撤销');
  eq(parseItemSourceToken(rig2.revoked[0])?.itemId, LOG, '撤的是取出那一件');
});

/* ═════════════════════════ 6. 退回失败进回执 ═════════════════════════ */

test('FND105-6 退回失败必须写进回执,且退回凭证一并撤销', () => {
  /* 注入:把 `refund()` 改回 `void`(丢掉返回值)⇒ 回执写「已退回」而东西真的没了
     ⇒ 第 3/7 行红。 */
  const useHost = { useItem: () => ({ applied: false, consume: true, reason: '超出使用距离' }) };
  const rig = makeRig({ roomId: 'wsfnd105_refund_use', tick: 40, host: useHost, owns: { [FEATHER]: 1 } });
  rig.limits.denyPositive = 1; /* 退回(+1)被拒 */
  const out = disp(rig, RoomAction.USE_ITEM, { itemId: FEATHER });
  eq(out.ok, false, '前置:世界侧未生效 ⇒ 失败');
  ok((out.reason ?? '').includes('退回也被拒'),
    `★ 退回失败必须进回执(实测:${out.reason ?? '-'})`);
  eq(rig.revoked.length, 1, '退回凭证也撤销');
  eq(rig.sources.size, 0, '本 tick 不留下未被用掉的来源');

  /* (b) PLACE_BLOCK:世界拒绝放下 ⇒ 退回;退回被拒同样写进理由。 */
  const mat = makeMaterials({ ok: false, reason: '这一格已被占用' });
  const rig2 = makeRig({ roomId: 'wsfnd105_refund_place', tick: 41, owns: { [LOG]: 1 } });
  (rig2.ctx as unknown as { materialsOf: () => unknown }).materialsOf = () => mat.api;
  rig2.limits.denyPositive = 1;
  const placed = disp(rig2, RoomAction.PLACE_BLOCK, { x: 2, y: 2, itemId: LOG });
  eq(placed.ok, false, '前置:世界拒绝放下 ⇒ 失败');
  ok((placed.reason ?? '').includes('这一格已被占用'), `世界给的理由要原样带上(实测:${placed.reason ?? '-'})`);
  ok((placed.reason ?? '').includes('退回也被拒'), `★ 退回失败必须进回执(实测:${placed.reason ?? '-'})`);
  eq(rig2.revoked.length, 1, '退回凭证撤销');
});

/* ═════════════════════════ 7. RESET_WORLD:回收侧账 ═════════════════════════ */

test('FND105-7 RESET_WORLD 成功 ⇒ 本房间三本侧账清空,另一个房间不动', () => {
  /* 注入:删掉 `forgetRoomSideLedgers(ctx)` 那一段 ⇒ 箱子/放置/宠物都还在 ⇒ 第 4/5/6 行红。 */
  const roomA = 'wsfnd105_reset_a';
  const roomB = 'wsfnd105_reset_b';
  const mob = tameableMobs()[0];
  ok(mob !== undefined, '前置:内容层应有可驯服生物');

  const rigA = makeRig({
    roomId: roomA, tick: 50, owns: { [LOG]: 3, [CONVEYOR_ID]: 1 }, position: { x: 1, y: 1 },
    host: { resetWorld: () => ({ applied: true, seed: 777, archive: null }) },
  });
  registerChest(roomA, 1, 1);
  eq(disp(rigA, RoomAction.OPEN_CHEST, { x: 1, y: 1, itemId: LOG, count: 1 }).ok, true, '前置:存入箱');
  eq(disp(rigA, RoomAction.PLACE_AUTOMATION, { x: 3, y: 4, kind: CONVEYOR_KIND }).ok, true, '前置:放置登记');
  eq(disp(rigA, RoomAction.BREED_TAME, { op: 'FEED', petId: 'pet-a', mobId: mob.id, itemId: LOG }).ok, true,
    '前置:宠物登记');

  const roomBRig = makeRig({ roomId: roomB, tick: 50, owns: { [LOG]: 1 }, position: { x: 1, y: 1 } });
  registerChest(roomB, 1, 1);
  eq(disp(roomBRig, RoomAction.OPEN_CHEST, { x: 1, y: 1, itemId: LOG, count: 1 }).ok, true,
    '前置:另一个房间的箱子');

  eq(publicChestContents(roomA, 1, 1), [{ itemId: LOG, count: 1 }], '前置:A 的箱子里有 1 件');
  ok(placementAt(roomA, 3, 4) !== null, '前置:A 的放置登记在');
  eq(petsOfRoom(roomA).length, 1, '前置:A 有一只宠物');

  const reset = disp(rigA, RoomAction.RESET_WORLD, { seed: 777, confirm: true });
  eq(reset.ok, true, `重置应成功(实测 ${reset.kind} / ${reset.reason ?? '-'})`);
  const cleared = String(effectOf(reset).sideLedgersCleared ?? '');
  ok(cleared.includes('chests') && cleared.includes('placements') && cleared.includes('pets'),
    `★ 回执要如实列出清了哪几本侧账(实测:${cleared === '' ? '∅' : cleared})`);

  eq(publicChestContents(roomA, 1, 1), null, '★ A 的箱子账已清(旧箱里的东西不再是「不需要产出的来源」)');
  eq(placementAt(roomA, 3, 4), null, '★ A 的放置登记已清');
  eq(petsOfRoom(roomA), [], '★ A 的宠物归属已清');
  eq(publicChestContents(roomB, 1, 1), [{ itemId: LOG, count: 1 }],
    '★ 只清本房间:另一个房间的箱子一件不少');
});

/* ═════════════════════════ 8. 负对照:重置未生效 ═════════════════════════ */

test('FND105-8 负对照:resetWorld 回 applied:false ⇒ 侧账一本都不动', () => {
  /* 注入:把回收提到 `if (!r.applied)` 之前 ⇒ 没生效却清了账 ⇒ 第 4 行红。 */
  const room = 'wsfnd105_reset_fail';
  const rig = makeRig({
    roomId: room, tick: 60, owns: { [LOG]: 1 }, position: { x: 1, y: 1 },
    host: { resetWorld: () => ({ applied: false, seed: 1, reason: '世界正在结算中' }) },
  });
  registerChest(room, 1, 1);
  eq(disp(rig, RoomAction.OPEN_CHEST, { x: 1, y: 1, itemId: LOG, count: 1 }).ok, true, '前置:存入箱');
  const out = disp(rig, RoomAction.RESET_WORLD, { seed: 2, confirm: true });
  eq(out.ok, false, '宿主没生效 ⇒ 动作不能报成功');
  eq(out.kind, 'NOT_IMPLEMENTED', '「能力在、这次没成」如实归为 NOT_IMPLEMENTED');
  eq(publicChestContents(room, 1, 1), [{ itemId: LOG, count: 1 }], '★ 没生效就一本都不许清');
});

/* ═════════════════════════ 9. 真闸:登记 ⇒ 来源;撤销 ⇒ 被拒 ═════════════════════════ */

/** 一个真实的 `RoomRuntime`(走生产装配,不手搓账)。 */
let realSeq = 0;
function makeRealRoom(): ReturnType<typeof assemble>['runtime'] {
  realSeq += 1;
  const a = assemble({
    roomId: `wsfnd105_real_${realSeq}`,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 16,
    mobs: false,
    rng: mulberry32(105),
  });
  a.runtime.join({ userId: 'p1' });
  return a.runtime;
}

function realCtx(rt: ReturnType<typeof assemble>['runtime']): ActionContext {
  return {
    actorId: 'p1',
    action: RoomAction.PICKUP_ITEM,
    payload: {},
    state: rt.state,
    host: null,
    status: 'OPEN',
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (userId: string, input: { ops: readonly Op[] }) => rt.applyInventory(userId, input),
    grantItemSource: (userId: string, source: string) => rt.grantItemSource(userId, source),
    revokeItemSource: (userId: string, source: string) => rt.revokeItemSource(userId, source),
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: () => ({ ok: true }),
    setPartyModeBy: () => ({ ok: true }),
    close: () => true,
    itemCountOf: (userId: string, itemId: number) => rt.authoritativeItemCount(userId, itemId),
    itemIdsOf: (userId: string) => rt.authoritativeItemIds(userId),
  } as unknown as ActionContext;
}

test('FND105-9 真实 Runtime:登记过的令牌是合法来源;撤销之后同一张串被真闸拒', () => {
  /* 注入:删掉 `RoomRuntime.revokeItemSource` ⇒ `unbindItemSource` 回 false ⇒ 第 3/4 行红。 */
  const rt = makeRealRoom();
  const ctx = realCtx(rt);

  const used = bindItemSource(ctx, LOG, ItemSourcePurpose.PICKUP);
  const allowed = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: used }] });
  eq(allowed.allowed, true, `前置:登记过的令牌就是合法来源(实测 ${allowed.rejectCode ?? 'ok'})`);

  const token = bindItemSource(ctx, LOG, ItemSourcePurpose.PICKUP);
  eq(unbindItemSource(ctx, token), true, '撤销口必须真的接在 ctx 上(手搓桩回 false)');
  const denied = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: token }] });
  eq(denied.allowed, false, '★ 已撤销的令牌不再是来源');
  eq(denied.rejectCode, 'ITEM_FROM_NOTHING', '真闸的拒因码是「凭空产出」');
});

report('WS-FND-105');