/**
 * WS-FND-20 —— **物质闭环**(放置 / 破坏 / 丢弃 / 拾取)。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96` 把 22 个 `RoomAction` 逐个归类后,这四个是「有相邻机制、
 * 缺中间一环」里最基础的一组:
 *
 * ```
 * PLACE_BLOCK / BREAK_BLOCK / DROP_ITEM / PICKUP_ITEM   ← 2026-11-14 接线
 * ```
 * 接线前它们显式 `NOT_IMPLEMENTED`,于是「建造 / 拆掉 / 丢东西 / 捡东西」
 * 这条**最基本的玩法闭环**在线上不存在:世界里没有玩家改过的格,
 * 背包里的数字也只能从别处来。
 *
 * ## 本套件钉的不是"回了 OK",而是**两侧账都对得上**
 *
 * 每个动作都同时动两处:**世界**(obj 层 / 地面掉落物)与**背包**(经
 * `applyInventory`,反作弊的总量守恒与凭证链都在那条路上)。故本文件
 * 每条断言都要求**两侧同时**正确 —— 只验一侧会漏掉本仓记过的那类缺陷
 * ("扣了东西没放下" / "凭空多出一个块" / "背包 +1 而地上那件还在")。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 放置:世界多一个 obj **且** 背包少一件 | 去掉 `applyInventory` 那次消耗 |
 * | 2 | 放置失败 ⇒ 背包**退回**那件 | 去掉 `place-refund` 分支 |
 * | 3 | 破坏:obj 清掉 **且** 东西进背包 | 去掉 `grantItemSource`(会被反作弊拒) |
 * | 4 | 拆空格 ⇒ 显式拒绝 | `breakBlock` 改成永远 `ok:true` |
 * | 5 | 空背包放不出块(不凭空造物) | 消耗改成不看 `allowed` |
 * | 6 | 丢弃:地面**真的**多一堆 | `dropItem` 改成空操作 |
 * | 7 | 拾取:地面少一件 **且** 背包多一件 | 先加背包再扣地面(会造复制品) |
 * | 8 | 附近没有就拒绝 | `takeGroundItemNear` 改成恒 `true` |
 * | 9 | 越权 → `PERMISSION`(不是 INVALID) | 去掉动作里的 `authorize` |
 * | 10 | 往返守恒:放→拆 回到原值 | 任一侧漏改 |
 * | 11 | 不在内容表里的 id 一律不认 | 去掉 `ITEM_ID_SET` 检查 |
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';

/** 测试用的建材 id:`101 暖松原木`(冻结内容表里的木材)。 */
const LOG = 101;
/** 压根不存在的物品 id —— 用于验明"编号空投"被拒。 */
const GHOST_ID = 999999;

type GroundNear = { itemId: number; count: number; x: number; y: number; dist: number };

type SimLike = {
  addPlayer(id: string, x: number, y: number): void;
  materials(): {
    blockAt(x: number, y: number): number;
    groundItemsNear(x: number, y: number, radius: number): GroundNear[];
  };
};

/** `authoritativeItemTotal` 是房间的私有方法 —— 这里只为**读**它而窄化(不改行为)。 */
type TotalLike = { authoritativeItemTotal(userId: string): number };

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  sim: SimLike;
  total: TotalLike;
  /** 玩家被放在这里(见 `makeRoom`)。 */
  at: { x: number; y: number };
};

function makeRoom(sizeCells = 48, asGuest = false): Room {
  const a = assemble({
    roomId: 'r_mat',
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells,
    /* `mobs: false`:本套件测物质层,不想让自发改刷的怪参与(它们会变成
       第三个"东西",让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(5),
  });
  a.runtime.join({ userId: 'p1', asGuest });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of a.runtime.authoritativeItemIds('p1')) a.runtime.applyInventory('p1', { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount('p1', id) }] });
  const sim = a.host as unknown as SimLike;
  /* 世界侧要"认识"这个玩家:`playerPosition` 读的是**物理刚体**,
     而刚体由 `addPlayer` 建。生产路径里它由第一次 `applyMove` 建 ——
     这里直接建,是为了让每条断言只测物质层本身。 */
  const at = { x: 4.5, y: 4.5 };
  sim.addPlayer('p1', at.x, at.y);
  /* ⚠️ 总量读的是**房间**(`RoomRuntime.authoritativeItemTotal`),不是 host ——
     我第一版写成 `a.host`,于是 11 条里 9 条报 "not a function"
     (剩下 2 条恰好不读总量,把这个错误掩盖了一层)。 */
  return { rt: a.runtime, sim, total: a.runtime as unknown as TotalLike, at };
}

/**
 * 塞东西进背包 —— 走**生产同一条路**:先 `grantItemSource` 再 `applyInventory`。
 * 不走后门(不直接改总量):那样测出来的闭环是假的。
 */
function seed(rt: Room['rt'], itemId: number, n: number): void {
  const src = `seed:${itemId}:${n}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒说明容量/守恒层先坏了)`);
}

const disp = (rt: Room['rt'], action: RoomAction, payload: Record<string, unknown> = {}) =>
  rt.dispatchAction('p1', action, payload);

/* ───────────────────────── 1 ───────────────────────── */

test('FND20-1 放置:世界多一个 obj,背包少一件(两侧同时成立)', () => {
  const { rt, sim, total } = makeRoom();
  seed(rt, LOG, 3);
  eq(total.authoritativeItemTotal('p1'), 3, '前置:背包 3 件');
  eq(sim.materials().blockAt(10, 10), 0, '前置:目标格是空的');

  const r = disp(rt, RoomAction.PLACE_BLOCK, { x: 10, y: 10, itemId: LOG });
  eq(r.ok, true, `放置应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  ok(r.effect !== undefined, '★ `OK` 必须带 effect(不留"回 OK 却无副作用")');

  eq(sim.materials().blockAt(10, 10), LOG, '★ 世界里那一格真的变成这个 obj');
  eq(total.authoritativeItemTotal('p1'), 2, '★ 背包真的少了一件(只改世界不改背包 = 凭空造物)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND20-2 放置失败 ⇒ 背包**退回**那件(不做"扣了东西没放下")', () => {
  const { rt, sim, total } = makeRoom();
  seed(rt, LOG, 2);
  disp(rt, RoomAction.PLACE_BLOCK, { x: 10, y: 10, itemId: LOG });
  eq(total.authoritativeItemTotal('p1'), 1, '前置:放了一块后剩 1 件');

  const again = disp(rt, RoomAction.PLACE_BLOCK, { x: 10, y: 10, itemId: LOG });
  eq(again.ok, false, '同一格不能放第二次');
  eq(again.kind, 'INVALID', '应被归为 INVALID(参数/状态不对,不是权限问题)');
  eq(sim.materials().blockAt(10, 10), LOG, '原来那个块还在(没被覆盖)');
  eq(total.authoritativeItemTotal('p1'), 1,
    '★ 被拒之后背包必须**回到 1** —— 若退回路不存在,这里会是 0(东西被吞了)');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND20-3 破坏:obj 清掉,东西进背包(掉落有凭证)', () => {
  const { rt, sim, total } = makeRoom();
  seed(rt, LOG, 1);
  disp(rt, RoomAction.PLACE_BLOCK, { x: 12, y: 12, itemId: LOG });
  eq(total.authoritativeItemTotal('p1'), 0, '前置:放完就没东西了');

  const r = disp(rt, RoomAction.BREAK_BLOCK, { x: 12, y: 12 });
  eq(r.ok, true, `破坏应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(sim.materials().blockAt(12, 12), 0, '★ 世界里那一格真的空了');
  eq(total.authoritativeItemTotal('p1'), 1,
    '★ 拆下来的东西进了背包(**没有凭证的话反作弊会按"凭空产出"拒**,这里就会是 0)');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND20-4 拆空格必须显式拒绝(不给"拆空气"的静默成功)', () => {
  const { rt, sim } = makeRoom();
  const r = disp(rt, RoomAction.BREAK_BLOCK, { x: 20, y: 20 });
  eq(r.ok, false, '空格上不能"拆出东西"');
  eq(r.kind, 'INVALID', '应是 INVALID');
  ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带原因');
  eq(sim.materials().blockAt(20, 20), 0, '世界没变');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND20-5 空背包放不出块(反作弊那条闸真的在岗)', () => {
  const { rt, sim, total } = makeRoom();
  eq(total.authoritativeItemTotal('p1'), 0, '前置:空背包');
  const r = disp(rt, RoomAction.PLACE_BLOCK, { x: 6, y: 6, itemId: LOG });
  eq(r.ok, false, '没有的东西不能放');
  eq(r.kind, 'INVALID', '应是 INVALID(不是权限问题)');
  eq(sim.materials().blockAt(6, 6), 0,
    '★ 世界也没变 —— 若消耗那一步不看 `allowed`,这里会出现一个凭空多出来的块');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND20-6 丢弃:地面真的多一堆,背包真的少', () => {
  const { rt, sim, total, at } = makeRoom();
  seed(rt, LOG, 5);
  const r = disp(rt, RoomAction.DROP_ITEM, { itemId: LOG, count: 2 });
  eq(r.ok, true, `丢弃应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(total.authoritativeItemTotal('p1'), 3, '★ 背包少了 2 件');
  const near = sim.materials().groundItemsNear(at.x, at.y, 2);
  const pile = near.find((g) => g.itemId === LOG);
  ok(pile !== undefined, '★ 地面**真的**多了一堆(否则东西被吞了)');
  eq(pile!.count, 2, '堆里有 2 件');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND20-7 拾取:地面少一件,背包多一件(两侧同时)', () => {
  const { rt, sim, total, at } = makeRoom();
  seed(rt, LOG, 4);
  disp(rt, RoomAction.DROP_ITEM, { itemId: LOG, count: 2 });
  eq(total.authoritativeItemTotal('p1'), 2, '前置:丢完剩 2');

  const r = disp(rt, RoomAction.PICKUP_ITEM, { itemId: LOG });
  eq(r.ok, true, `拾取应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(total.authoritativeItemTotal('p1'), 3, '★ 背包多了一件');
  const pile = sim.materials().groundItemsNear(at.x, at.y, 2).find((g) => g.itemId === LOG);
  ok(pile !== undefined && pile.count === 1,
    `★ 地面那堆必须变成 1(实测 ${pile === undefined ? '整堆没了' : pile.count})`
    + ' —— 若先加背包再扣地面,这里会同时"背包 +1 而地上还是 2"');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND20-8 附近没有就拒绝(拾取不能凭空产出)', () => {
  const { rt, total } = makeRoom();
  seed(rt, LOG, 2);
  const r = disp(rt, RoomAction.PICKUP_ITEM, { itemId: LOG });
  eq(r.ok, false, '地上没有这东西时不能"捡"到');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(total.authoritativeItemTotal('p1'), 2, '★ 背包不变(不能凭空 +1)');
});

/* ───────────────────────── 8b ───────────────────────── */

test('FND20-8b 拾取不给 itemId ⇒ 捡离玩家最近的一件;给了就只捡那一种;地上没东西仍拒', () => {
  const { rt, sim, total, at } = makeRoom();
  seed(rt, LOG, 4);
  disp(rt, RoomAction.DROP_ITEM, { itemId: LOG, count: 2 });
  eq(total.authoritativeItemTotal('p1'), 2, '前置:丢完剩 2');

  const r = disp(rt, RoomAction.PICKUP_ITEM, {});
  eq(r.ok, true, `★ 不给 itemId 也能捡(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.effect?.itemId, LOG, '回执带回实际捡起的物品 id');
  eq(total.authoritativeItemTotal('p1'), 3, '背包 +1');
  const pile = sim.materials().groundItemsNear(at.x, at.y, 2).find((g) => g.itemId === LOG);
  eq(pile?.count, 1, '地面那堆 -1');

  const wrong = disp(rt, RoomAction.PICKUP_ITEM, { itemId: 999 });
  eq(wrong.ok, false, '★ 给了 itemId 就只捡那一种:地上没有 ⇒ 拒');
  const bad = disp(rt, RoomAction.PICKUP_ITEM, { itemId: 'x' });
  eq(bad.ok, false, 'itemId 不是数字 ⇒ 拒(不退化成捡最近一件)');
  eq(total.authoritativeItemTotal('p1'), 3, '两次拒绝都没动背包');

  disp(rt, RoomAction.PICKUP_ITEM, {});
  const empty = disp(rt, RoomAction.PICKUP_ITEM, {});
  eq(empty.ok, false, '★ 地上捡空了 ⇒ 拒(不能凭空产出)');
  eq(total.authoritativeItemTotal('p1'), 4, '总共捡回 2 件');
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND20-9 越权:GUEST 做不了建造,且分类是 PERMISSION', () => {
  const { rt, sim } = makeRoom(48, true);
  const place = disp(rt, RoomAction.PLACE_BLOCK, { x: 8, y: 8, itemId: LOG });
  eq(place.ok, false, 'GUEST 不能放置');
  eq(place.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 否则"越权"与"参数错"混成一个值)');
  const brk = disp(rt, RoomAction.BREAK_BLOCK, { x: 8, y: 8 });
  eq(brk.ok, false, 'GUEST 不能破坏');
  eq(brk.kind, 'PERMISSION', '★ 同上');
  eq(sim.materials().blockAt(8, 8), 0, '★ 被拒后世界零变化');
});

/* ───────────────────────── 10 ───────────────────────── */

test('FND20-10 往返守恒:放一块再拆掉,背包回到原值', () => {
  const { rt, sim, total } = makeRoom();
  seed(rt, LOG, 1);
  const before = total.authoritativeItemTotal('p1');

  disp(rt, RoomAction.PLACE_BLOCK, { x: 14, y: 9, itemId: LOG });
  eq(total.authoritativeItemTotal('p1'), before - 1, '放之后少 1');
  disp(rt, RoomAction.BREAK_BLOCK, { x: 14, y: 9 });
  eq(total.authoritativeItemTotal('p1'), before, '★ 拆回来之后必须回到原值(两侧都没漏改)');
  eq(sim.materials().blockAt(14, 9), 0, '世界也回到原样');
});

/* ───────────────────────── 11 ───────────────────────── */

test('FND20-11 不在冻结内容表里的 id 一律不认(编号空投)', () => {
  const { rt, sim, total } = makeRoom();
  seed(rt, LOG, 1);
  const r = disp(rt, RoomAction.PLACE_BLOCK, { x: 9, y: 9, itemId: GHOST_ID });
  eq(r.ok, false, '不存在的物品 id 不能放置');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(sim.materials().blockAt(9, 9), 0, '世界没变');
  eq(total.authoritativeItemTotal('p1'), 1, '★ 背包也没被扣(拒绝发生在消耗之前)');
});

report('WS-FND-20');
