/**
 * WS-FND-92 —— **动作闸的负对照面**:箱子存取的距离闸 + 放置自动化件的扣件闸。
 *
 * ## 这个套件为什么存在
 *
 * `docs/AUDIT-W34.md:82`(P2-8)与 `:108`(R8)记的是同一条:
 * ```
 * | P2-8 | P2 | 箱子存取不比距离:`server/src/net/actions/open_chest.ts`(容器模型) | 登记 |
 * R8 箱子存取不比距离:能远程开箱(需要先知道坐标)……修法要先定交互半径常量。
 * ```
 * 即「服务端**有**权威位置,却不拿它判距离」——知道坐标就能隔着地图开箱 / 存取。
 * 同一族的第二条:自动化件是**实物**(冻结层 401~440),而 `PLACE_AUTOMATION`
 * 只看 `kind` 是不是已注册种类、**不扣任何东西** ⇒ 一件 428 定向物流传送带
 * 可以无限放。
 *
 * owner 已裁的两件都落在本套件:箱子按 `CHEST_REACH` 判距离;放置必须真扣件。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 站在箱子旁 ⇒ 存入两侧账都对(背包 −2 / 容器 +2) | 距离闸判反/拿不到位置也拒 |
 * | 2 | **隔房**(超距)存取 ⇒ `INVALID` 且两侧零变化;走近同一请求 ⇒ OK | 去掉 `hostPositionOf` 那段 / 把 `>` 写成 `<` |
 * | 3 | 半径边界:5.6 格拒、4.9 格放 | `CHEST_REACH` 改成 4(或更大) |
 * | 4 | `USE_OWN_CHEST` 走**同一条**闸(私有抽屉不豁免) | 把闸写进 `PUBLIC_CHEST` 那一支 |
 * | 5 | 判序:权限先于距离(GUEST 远距 ⇒ `PERMISSION`,同一个人用 baseline 动作才是 `INVALID`) | 距离闸挪到 `authorize` 之前 |
 * | 6 | 不持有 `spec.id` ⇒ 拒 + 零登记 + 背包不变;持有 ⇒ OK(负对照) | 去掉扣件那一段 |
 * | 7 | 扣减与回执一致:扣的、回执里的、账面少的都是 `428`;别的件一件不动 | 回执重新查表 / 用固定 id 扣 |
 * | 8 | 持有**别的**件不能放(负对照:换成对的件就能放) | 扣「背包里第一件」而不是 `spec.id` |
 * | 9 | 被拒的放置**不扣件**(格子被占 ⇒ 一件不少);换空格才扣到 0 | 扣件挪到占用检查之前 |
 * | 10 | 拿不到权威位置(玩家不在世界里)⇒ 拒,不当作「就在旁边」 | 把 `at === null` 当成放行 |
 *
 * ## ⚠️ 本套件**不能**证明的东西(别当成做到了)
 *
 *   1 距离闸**不是**视线闸:格与格之间有没有墙它不判(`world/vision.ts` 才有,
 *     R5 记了「接视线要在热路径跑 O(格)」⇒ 今天没接);
 *   2 箱子内容**不上 wire**、容器状态**不持久化**、世界里**没有**真实箱子实体
 *     (箱子由 `registerChest()` 登记,与 WS-FND-27 同一份边界);
 *   3 放置仍然只到「登记 + 可查」——「放下去就通电」没有(见被测文件开头)。
 *
 * ## ⚠️ 刻意的写法,别当成笔误
 *
 * 断言右侧一律用**字面量**(`428` / `10.5` / `5.6`),**不**取被测模块导出的常量
 * (`CHEST_REACH` / `CHEST_SLOTS`)—— 那样两侧同源,实现与期望一起漂 ⇒ 恒真,
 * 门禁 `--strict-taut` 抓的正是它(`tests/WS-FND-32-automation.test.ts` 同款处理)。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';
import {
  ownChestContents,
  publicChestContents,
  registerChest,
} from '../server/src/net/actions/open_chest.ts';
import {
  clearPlacementRegistry,
  placementAt,
  placementsOfRoom,
  setPlacementClock,
} from '../server/src/net/actions/place_automation.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

/** 假时钟(ms):放置回执的 `placedAtMs` 走它,判据不依赖真实时间。 */
let now = 92_000_000;
setPlacementClock(() => now);

/** 每个用例开始前:清空登记表 + 归零假时钟(防模块级状态跨用例泄漏)。 */
function reset(): void {
  clearPlacementRegistry();
  now = 92_000_000;
}

/** 箱子那一格(世界里没有真实箱子实体,格子由测试自己挑)。 */
const CX = 10;
const CY = 10;

/** 测试用物品:`101 暖松原木`(冻结内容表里的木材);`428` = 定向物流传送带。 */
const LOG = 101;
const CONVEYOR = 428;
const CONVEYOR_KIND = 'LOGISTICS_CONVEYOR';

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  roomId: string;
  /** 世界源上本套件只用两处:摆玩家到指定坐标(权威位置)、把他从世界里摘掉。 */
  sim: {
    addPlayer(id: string, x: number, y: number): void;
    removePlayer(id: string): boolean;
  };
};

/** 每个房间一个**唯一 id** ⇒ 容器模型与登记表都按 `roomId` 隔离。 */
let roomSeq = 0;
/** `seed` 的来源凭证序号(凭证集合是 Set,用递增后缀避免复用时误判)。 */
let seedSeq = 0;

/**
 * 建一个**真装配**出来的房间(动作走 `rt.dispatchAction`,不手搓 `ActionContext`),
 * 并把 `p1`(房主)、可选访客 `g` 摆到给定坐标。
 *
 * `ownerId: 'p1'` ⇒ `p1` 是 OWNER:箱子那一半要 `publicStorage`、
 * 放置那一半要 `wiring`,只有房主两个都有(见 `ACTION_PERMISSION`)。
 */
function makeRoom(role: 'OWNER' | 'GUEST' = 'OWNER'): Room {
  roomSeq += 1;
  const roomId = `r_gate_${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: role === 'OWNER' ? 'p1' : 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* `mobs: false`:本套件不想让自发改刷的怪参与(第三个「东西」会让失败难归因)。 */
    mobs: false,
    rng: mulberry32(92),
  });
  a.runtime.join({ userId: 'p1', asGuest: role === 'GUEST' });
  const sim = a.host as unknown as Room['sim'];
  /* 权威位置由测试**显式**摆:距离闸读的就是它(`physics.bodies`)。 */
  sim.addPlayer('p1', 10.5, 10.5);
  registerChest(roomId, CX, CY);
  return { rt: a.runtime, roomId, sim };
}

/** 背包**权威**件数(`RoomRuntime.authoritativeItemCount`)。 */
const stock = (room: Room, userId: string, itemId: number): number =>
  room.rt.authoritativeItemCount(userId, itemId);

/** 背包**权威**总量。 */
const total = (room: Room, userId: string): number => room.rt.authoritativeItemTotal(userId);

/**
 * 塞东西进背包 —— 走**生产同一条路**(先 `grantItemSource` 再 `applyInventory`)。
 * 不走后门(不直接改总量):那样测出来的闭环是假的。
 */
function seed(room: Room, userId: string, itemId: number, n: number): void {
  seedSeq += 1;
  const src = `seed:${itemId}:${n}:${seedSeq}`;
  room.rt.grantItemSource(userId, src);
  const r = room.rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒 ${r.rejectCode ?? ''})`);
}

const actAs = (
  room: Room,
  userId: string,
  action: RoomAction,
  payload: Record<string, unknown> = {},
): ActionOutcome => room.rt.dispatchAction(userId, action, payload);

const act = (room: Room, action: RoomAction, payload: Record<string, unknown> = {}): ActionOutcome =>
  actAs(room, 'p1', action, payload);

/** 取回执里的 `effect`(★ 值域已放宽为 `EffectRecord`;这里只读标量 ⇒ 显式窄化)。 */
const eff = (r: ActionOutcome): Record<string, string | number | boolean> =>
  (r.effect ?? {}) as Record<string, string | number | boolean>;

/* ───────────────────────── 1 ───────────────────────── */

test('FND92-1 合法路径:站在箱子旁 ⇒ 存入两侧账都对(背包 −2 / 容器 +2)', () => {
  reset();
  const room = makeRoom();
  /* `p1` 摆在 (10.5, 10.5):到箱格 (10,10) 的距离 = 0.707 格 ⇒ 闸内。 */
  seed(room, 'p1', LOG, 3);

  const r = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 2 });
  eq(r.ok, true, `★ 距离闸不该拦住站在箱子旁的玩家(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  eq(total(room, 'p1'), 1, '★ 背包真的少 2 件');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 2 }], '★ 容器真的多 2 件');

  /* 只读打开(不带 itemId)也在闸内 ⇒ 照常回内容摘要。 */
  const seen = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY });
  eq(seen.ok, true, `打开看也应在闸内通过(实测 kind=${seen.kind} reason=${seen.reason ?? '-'})`);
  eq(seen.effect?.total, 2, '★ 只读回执报到箱里那 2 件');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND92-2 ★负对照 隔房(超距)存取被拒,走近同一请求才成功', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', LOG, 2);

  /* 把玩家挪到 (10+9, 10+9):到箱格距离 = 12.728 格 ≫ 闸宽 ⇒ 「隔着大半个房间开箱」。 */
  room.sim.addPlayer('p1', CX + 9, CY + 9);
  const farStore = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(farStore.ok, false, '★ 超距不能存');
  eq(farStore.kind, 'INVALID',
    '★ 必须归为 INVALID(距离是**状态**问题;归 PERMISSION 会与越权混成一个值)');
  ok(typeof farStore.reason === 'string' && farStore.reason.length > 0, '拒绝必须带原因');

  /* 只读打开同样要过闸(否则「远程看箱」这条信息泄露还在)。 */
  const farSeen = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY });
  eq(farSeen.ok, false, '★ 超距连「只看」都不行');
  eq(farSeen.kind, 'INVALID', '应被归为 INVALID');
  eq(farSeen.effect, undefined, '拒绝回执不带 effect(没有内容可泄露)');

  eq(publicChestContents(room.roomId, CX, CY), [], '★ 容器一个字都没动');
  eq(stock(room, 'p1', LOG), 2, '★ 背包也一件没少(零副作用)');

  /* 负对照:同一个玩家、同一个请求,只是**走到箱子跟前** ⇒ 成功。
     它排除了「上面失败是因为这个请求本身不合法」的解释。 */
  room.sim.addPlayer('p1', 10.5, 10.5);
  const near = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(near.ok, true, `负对照:走近了就该成功(实测 kind=${near.kind} reason=${near.reason ?? '-'})`);
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 1 }], '这时容器才 +1');
  eq(stock(room, 'p1', LOG), 1, '这时背包才 −1');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND92-3 半径边界:5.6 格拒、4.9 格放(闸宽就是那一个数)', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', LOG, 2);

  /* ⚠️ 断言用的是**字面量坐标**,不是 `CHEST_REACH`:两侧同源就是恒真。 */
  room.sim.addPlayer('p1', CX + 5.6, CY);
  const out = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(out.ok, false, '★ 5.6 格在闸外 ⇒ 拒');
  eq(out.kind, 'INVALID', '应被归为 INVALID');
  eq(stock(room, 'p1', LOG), 2, '★ 被拒后背包不变');

  room.sim.addPlayer('p1', CX + 4.9, CY);
  const inn = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(inn.ok, true,
    `★ 4.9 格在闸内 ⇒ 放(实测 kind=${inn.kind} reason=${inn.reason ?? '-'})`);
  eq(stock(room, 'p1', LOG), 1, '★ 这时才扣 1 件');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND92-4 USE_OWN_CHEST 走同一条闸:超距拒、近距放,且不碰公共箱', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', LOG, 2);

  room.sim.addPlayer('p1', CX + 9, CY + 9);
  const far = act(room, RoomAction.USE_OWN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(far.ok, false, '★ 私有箱不豁免距离(同一台引擎 `runChestAction`)');
  eq(far.kind, 'INVALID', '应被归为 INVALID');
  eq(ownChestContents(room.roomId, CX, CY, 'p1'), [], '★ 被拒后私有抽屉没被建出来(懒建不留痕)');
  eq(stock(room, 'p1', LOG), 2, '★ 背包一件没少');

  /* 负对照:走近 ⇒ 私有抽屉照常写入(证明上面拒的是**距离**,不是私有箱坏了)。 */
  room.sim.addPlayer('p1', 10.5, 10.5);
  const near = act(room, RoomAction.USE_OWN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(near.ok, true, `负对照:走近就该成功(实测 kind=${near.kind} reason=${near.reason ?? '-'})`);
  eq(ownChestContents(room.roomId, CX, CY, 'p1'), [{ itemId: LOG, count: 1 }], '★ 抽屉里有 1 件');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 私有抽屉不碰公共箱');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND92-5 判序:权限先于距离(GUEST 远距 ⇒ PERMISSION,不是「太远」)', () => {
  reset();
  const room = makeRoom('GUEST');
  room.rt.join({ userId: 'g', asGuest: true });
  /* `g` 摆到超距处:两个闸都会拒 ⇒ 谁在前面决定 kind。 */
  room.sim.addPlayer('g', CX + 9, CY + 9);

  const denied = actAs(room, 'g', RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(denied.ok, false, 'GUEST 不能开公共箱');
  eq(denied.kind, 'PERMISSION',
    '★ 必须是 PERMISSION —— 权限闸在距离闸**之前**(反过来这里会变成 INVALID)');

  /* 负对照:同一个 GUEST、同一格、同样的超距,换 baseline 动作 ⇒ 变成 INVALID
     ⇒ 证明「太远」这条真的独立存在,只是排在权限后面。 */
  const own = actAs(room, 'g', RoomAction.USE_OWN_CHEST, { x: CX, y: CY });
  eq(own.ok, false, 'GUEST 私有箱是 baseline ⇒ 这一层放行');
  eq(own.kind, 'INVALID', '★ 于是拒它的是**距离闸**(kind 与上面不同)');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 两条都被拒后容器零变化');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND92-6 ★负对照 不持有件不能放;持有之后才登记', () => {
  reset();
  const room = makeRoom();
  eq(placementsOfRoom(room.roomId).size, 0, '前置:该房间还没有任何登记');

  const denied = act(room, RoomAction.PLACE_AUTOMATION, { x: 5, y: 5, kind: CONVEYOR_KIND });
  eq(denied.ok, false, '★ 背包里没有 428 ⇒ 不能放 428');
  eq(denied.kind, 'INVALID', '这是状态问题(INVALID),不是 PERMISSION / NOT_IMPLEMENTED');
  ok(typeof denied.reason === 'string' && denied.reason.length > 0, '拒绝必须带原因');
  eq(placementAt(room.roomId, 5, 5), null, '★ 被拒后那一格没登记');
  eq(placementsOfRoom(room.roomId).size, 0, '★ 登记表仍是空的');
  eq(total(room, 'p1'), 0, '★ 背包也没动');

  /* 负对照:真的持有那一件(428)⇒ 同一个请求成功,且登记可查。 */
  seed(room, 'p1', CONVEYOR, 1);
  const allowed = act(room, RoomAction.PLACE_AUTOMATION, { x: 5, y: 5, kind: CONVEYOR_KIND });
  eq(allowed.ok, true, `负对照:持有就该能放(实测 kind=${allowed.kind} reason=${allowed.reason ?? '-'})`);
  eq(allowed.kind, 'OK', '成功路径必须是 OK');
  eq(placementAt(room.roomId, 5, 5)?.kind, CONVEYOR_KIND, '★ 登记可查');
  eq(placementsOfRoom(room.roomId).size, 1, '这时才有 1 条登记');
  eq(stock(room, 'p1', CONVEYOR), 0, '★ 那一件真的被扣掉');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND92-7 扣减与回执一致:扣的、回执里的、账面少的都是 428;别的件不动', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', CONVEYOR, 2);
  seed(room, 'p1', LOG, 1);

  const r = act(room, RoomAction.PLACE_AUTOMATION, { x: 6, y: 6, kind: CONVEYOR_KIND });
  eq(r.kind, 'OK', `放置应成功(实测 reason=${r.reason ?? '-'})`);
  eq(eff(r).itemId, 428,
    '★ 回执里的 itemId 必须就是**扣掉的那一件**的冻结层编号(字面量,不取被测常量)');
  eq(stock(room, 'p1', CONVEYOR), 1, '★ 428 从 2 件变 1 件 —— 与回执同一个数');
  eq(stock(room, 'p1', LOG), 1, '★ 别的件(101)一件都没动');

  /* 负对照:再放一件到另一格 ⇒ 只再扣 1 件(不是「清空」也不是「不扣」)。 */
  const r2 = act(room, RoomAction.PLACE_AUTOMATION, { x: 7, y: 7, kind: CONVEYOR_KIND });
  eq(r2.kind, 'OK', `第二件也应能放(实测 reason=${r2.reason ?? '-'})`);
  eq(stock(room, 'p1', CONVEYOR), 0, '★ 第二件扣完正好 0');
  eq(placementsOfRoom(room.roomId).size, 2, '两格各 1 条登记');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND92-8 ★负对照 持有**别的**件不能放(扣的是 spec.id,不是背包里随手一件)', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', LOG, 3);

  const denied = act(room, RoomAction.PLACE_AUTOMATION, { x: 8, y: 8, kind: CONVEYOR_KIND });
  eq(denied.ok, false, '★ 背包里有 101 ×3,但那不是 428 ⇒ 不能放传送带');
  eq(denied.kind, 'INVALID', '应被归为 INVALID');
  eq(stock(room, 'p1', LOG), 3, '★ 别的件一件没被扣(扣错件正是本条要钉的)');
  eq(placementAt(room.roomId, 8, 8), null, '★ 零登记');

  /* 负对照:把**对的**那一件塞进去 ⇒ 同一个请求成功。 */
  seed(room, 'p1', CONVEYOR, 1);
  const allowed = act(room, RoomAction.PLACE_AUTOMATION, { x: 8, y: 8, kind: CONVEYOR_KIND });
  eq(allowed.kind, 'OK', `负对照:补上 428 就该能放(实测 reason=${allowed.reason ?? '-'})`);
  eq(stock(room, 'p1', LOG), 3, '★ 101 仍然一件没动');
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND92-9 被拒的放置不扣件(格子被占 ⇒ 一件不少),换空格才扣到 0', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', CONVEYOR, 2);

  const first = act(room, RoomAction.PLACE_AUTOMATION, { x: 9, y: 9, kind: CONVEYOR_KIND });
  eq(first.kind, 'OK', `前置:第一次放置应成功(实测 reason=${first.reason ?? '-'})`);
  eq(stock(room, 'p1', CONVEYOR), 1, '前置:扣掉 1 件');

  /* 同一格再放:占用检查必须**先于**扣件(否则每次失败都白吞一件)。 */
  const again = act(room, RoomAction.PLACE_AUTOMATION, { x: 9, y: 9, kind: CONVEYOR_KIND });
  eq(again.ok, false, '同一格不能放第二件');
  eq(again.kind, 'INVALID', '应被归为 INVALID');
  eq(stock(room, 'p1', CONVEYOR), 1, '★ 被拒的这一次**没有**再扣一件(零副作用)');
  eq(placementAt(room.roomId, 9, 9)?.kind, CONVEYOR_KIND, '★ 原来那件还在,没被覆盖');
  eq(placementsOfRoom(room.roomId).size, 1, '★ 拒绝路径不新增登记');

  /* 负对照:换一个空格 ⇒ 这时才真的扣到 0(证明上面不是「扣件坏了」)。 */
  const other = act(room, RoomAction.PLACE_AUTOMATION, { x: 4, y: 4, kind: CONVEYOR_KIND });
  eq(other.kind, 'OK', `负对照:空格应能放(实测 reason=${other.reason ?? '-'})`);
  eq(stock(room, 'p1', CONVEYOR), 0, '★ 这一件扣完正好 0');
});

/* ───────────────────────── 10 ───────────────────────── */

test('FND92-10 拿不到权威位置 ⇒ 拒(fail-closed,不当作「就在旁边」)', () => {
  reset();
  const room = makeRoom();
  seed(room, 'p1', LOG, 2);

  /* 把刚体从世界里摘掉 ⇒ `hostPositionOf` 变 `null`(不是 (0,0)!)。 */
  ok(room.sim.removePlayer('p1'), '前置:玩家应能从世界里摘掉');
  const r = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(r.ok, false,
    '★ 拿不到权威位置就不能存取 —— 「不知道他在哪」不等于「他就在箱子旁」');
  eq(r.kind, 'INVALID', '应被归为 INVALID(与 DROP_ITEM / PICKUP_ITEM 同口径)');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 容器零变化');
  eq(stock(room, 'p1', LOG), 2, '★ 背包零变化');

  /* 负对照:把刚体放回箱子旁 ⇒ 同一个请求成功(证明上面拒的是「位置不可知」)。 */
  room.sim.addPlayer('p1', 10.5, 10.5);
  const back = act(room, RoomAction.OPEN_CHEST, { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(back.ok, true, `负对照:位置回来了就该成功(实测 kind=${back.kind} reason=${back.reason ?? '-'})`);
  eq(stock(room, 'p1', LOG), 1, '★ 这时才扣 1 件');
});

report('WS-FND-92');
