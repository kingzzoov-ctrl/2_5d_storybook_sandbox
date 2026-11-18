/**
 * WS-FND-32 —— **`PLACE_AUTOMATION`(自动化件放置)接线**。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md:103` 那一行的原文:
 * ```
 * | `PLACE_AUTOMATION` | 缺自动化件实体与放置校验;`wiring/` 有电路求值,但没有「放置」这一步 |
 * ```
 * 接线前它只回 `NOT_IMPLEMENTED`(`actions/place_automation.ts` 的占位)。
 *
 * ## 本套件钉的是**第二段**,而不是第一段
 *
 * 接线后能断言的是:`kind` 是不是**已注册的逻辑件种类**、格子是不是空的、
 * 谁有没有权限、以及「谁在哪个房间的哪一格放了什么」变成一条**可查的事实**。
 * ⚠️ 第一段(自动化件**世界实体**)**仍未被补齐** —— 本套件**不**声称
 *   `wiring/graph.ts` 会因此开始求值,也**不**声称世界侧看得见这些件:
 *   没有任何一处把本登记表接进 `WorldSim.wiring`(见被测文件开头)。
 *   本文件的命题因此是「**登记 + 可查**」,不是「放下去就通电」。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 空格 + 已注册 kind ⇒ `OK` + `effect`(kind/坐标/时刻)且登记可查 | 回 OK 却不写登记表 / `effect` 缺字段 |
 * | 2 | 同格再放 ⇒ `INVALID`,原记录一字不动 | 允许覆盖 / 拒绝路径顺手改写记录 |
 * | 3 | 未知 kind ⇒ `INVALID`(判据 = `hasComponentKind`) | 换成自造白名单 / 不判种类 |
 * | 4 | 坐标非法(负 / 小数 / NaN / 缺失 / 越界)⇒ `INVALID` 且零登记 | 去掉 `Number.isInteger` 或上下界判定 |
 * | 5 | 越权(GUEST 无 `wiring` 位)⇒ `PERMISSION` 且零登记 | 去掉处理器里的 `authorize` / 闸写在参数校验之后 |
 * | 6 | 跨房间隔离:两个 `roomId` 的同坐标互不可见 | 登记表不按 `roomId` 分桶 |
 * | 7 | 世界里已有物件的格子不可覆盖 | 只看登记表、不看世界 obj 层 |
 * | 8 | 读回的是**副本** | 查询函数直接返回内部对象 |
 *
 * ## 用**真装配**
 *
 * `assemble()` 造出运行时,动作走 `rt.dispatchAction`(不手搓 `ActionContext`),
 * 夹具照 `tests/WS-FND-20-material-loop.test.ts`;两个客户端的写法参考
 * `tests/WS-FND-25-craft.test.ts` 与 `tests/WS-FND-30-town.test.ts`。
 * 角色不手写:`ownerId` 与 `join({ asGuest })` 的既有判定决定谁带 `wiring` 位
 * (`net/room.ts:1273` 的 `authorize` ⇒ `ACTION_PERMISSION.PLACE_AUTOMATION = 'wiring'`)。
 *
 * ## ⚠️ 刻意的写法,别当成笔误
 *
 * 断言右侧一律用**字面量**(`5` / `'LOGISTICS_CONVEYOR'` / `5_000_000`),
 * **不**取被测模块导出的常量 —— 那样两侧同源(实现与期望一起漂 ⇒ 恒真),
 * 门禁 `--strict-taut` 抓的正是它(`tests/WS-FND-30-town.test.ts` 同款处理)。
 * 种类名的正/反例都来自**同一个判据** `hasComponentKind`,本文件不自造名单。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';
import { hasComponentKind } from '../server/src/wiring/graph.ts';
import {
  clearPlacementRegistry,
  placementAt,
  placementsOfRoom,
  setPlacementClock,
} from '../server/src/net/actions/place_automation.ts';

/* ───────────────────────── 夹具 ───────────────────────── */

/** 假时钟(ms):`placedAtMs` 与回执都走它,判据不依赖真实时间。 */
let now = 5_000_000;
setPlacementClock(() => now);

/** 每个用例开始前:清空登记表 + 归零假时钟(防模块级状态跨用例泄漏)。 */
function reset(): void {
  clearPlacementRegistry();
  now = 5_000_000;
}

type RoomRole = 'OWNER' | 'GUEST';

/** 世界物质层里本套件只读一处:那一格有没有物件。 */
type SimLike = { materials(): { blockAt(x: number, y: number): number } };

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  roomId: string;
  sim: SimLike;
};

/** 房间号逐个递增:即使 `reset()` 漏了,两个用例也不会互相踩登记。 */
let roomSeq = 0;

/**
 * 建一个**真装配**的房间,`p1` 按 `role` 入座。
 *
 * `ownerId` 跟着角色走(`net/room.ts:1067`):`OWNER` ⇒ `p1` 就是房主(带 `wiring` 位);
 * `GUEST` ⇒ 房主另有其人,`p1` 只能拿到 GUEST(无 `wiring` 位)。
 */
function makeRoom(role: RoomRole = 'OWNER'): Room {
  roomSeq += 1;
  const roomId = `r_auto${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: role === 'OWNER' ? 'p1' : 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* 本套件测的是放置登记,不想让自发改刷的怪参与(它们会变成第三个「东西」,
       让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(23),
  });
  a.runtime.join({ userId: 'p1', asGuest: role === 'GUEST' });
  return { rt: a.runtime, roomId, sim: a.host as unknown as SimLike };
}

/**
 * 派一次 `PLACE_AUTOMATION`(默认由 `p1` 发起)。
 * 派一次 `PLACE_AUTOMATION`(指定发起者)。
 * ⚠️ 载荷先收成 `Record<string, unknown>` 再传:因为 `kind` 还没写进
 * `ActionPayload`(`net/room.ts:828`),直接写字面量会被 TS 的「多余属性」检查拒
 * (`TS2353`)。这与被测动作自己用局部窄类型读 `kind` 是同一件事的两面。
 */
const dispAs = (
  rt: Room['rt'],
  actorId: string,
  payload: Record<string, unknown>,
): ActionOutcome => rt.dispatchAction(actorId, RoomAction.PLACE_AUTOMATION, payload);

/** 派一次 `PLACE_AUTOMATION`(`p1` 发起)。 */
const disp = (rt: Room['rt'], payload: Record<string, unknown>): ActionOutcome =>
  dispAs(rt, 'p1', payload);

/** 取回执里的 `effect`(★ 值域已放宽为 `EffectRecord`;这里只读标量 ⇒ 显式窄化)。 */
const eff = (r: ActionOutcome): Record<string, string | number | boolean> =>
  (r.effect ?? {}) as Record<string, string | number | boolean>;

/**
 * 给 `p1` 播种 `n` 件 `itemId` —— **放置是要扣件的**(`place_automation.ts` 第 6 步
 * 按注册表的 `spec.id` 查按件权威账,账面 < 1 ⇒ `INVALID`),所以每个「应成功」的
 * 放置点都得先备货。
 *
 * 走生产同一条路:服务端 `grantItemSource` 先登记来源串,再正向 `applyInventory`
 * (与 FND32-7 给 101 播种的写法逐字同款)。`seed:` 前缀的旧口径串**只可能**由
 * 服务端注入(`net/anticheat.ts:990` 那条注释),不是客户端可达面。
 */
function seedHeld(rt: Room['rt'], itemId: number, n = 1): void {
  const src = `seed:${itemId}:${n}`;
  rt.grantItemSource('p1', src);
  const r = rt.applyInventory('p1', { ops: [{ itemId, delta: n, source: src }] });
  ok(
    r.allowed,
    `前置:给 p1 播种 ${n} 件 ${itemId} 应成功(被拒说明守恒/容量层先坏了:${r.rejectCode ?? '被拒'})`,
  );
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND32-1 空格 + 已注册 kind ⇒ OK,`effect` 带 kind/坐标/时刻,且登记可查', () => {
  reset();
  const { rt, roomId, sim } = makeRoom();
  /* 428 定向物流传送带:401~440 里的一个**真**种类。 */
  const KIND = 'LOGISTICS_CONVEYOR';
  ok(hasComponentKind(KIND), '前置:这个种类必须在 wiring 的注册表里(否则本断言测不到东西)');
  eq(sim.materials().blockAt(5, 5), 0, '前置:目标格在世界里是空的');
  eq(placementsOfRoom(roomId).size, 0, '前置:该房间还没有任何登记');

  /* ★ 放置要扣件:先给 p1 播种 1 件 428(定向物流传送带),否则第 6 步按账面 0 拒。 */
  seedHeld(rt, 428);
  const r = disp(rt, { x: 5, y: 5, kind: KIND });
  eq(r.ok, true, `放置应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK(接线前这里是 NOT_IMPLEMENTED)');

  const e = eff(r);
  eq(e.kind, KIND, '★ `effect` 必须带 kind');
  eq(e.x, 5, '★ `effect` 必须带坐标 x');
  eq(e.y, 5, '★ `effect` 必须带坐标 y');
  eq(e.placedAtMs, 5_000_000, '★ `effect` 必须带时刻 —— 且它来自注入的假钟,不是墙钟');
  eq(e.itemId, 428, '顺带带上冻结层编号(401~440 的那一个)');

  const rec = placementAt(roomId, 5, 5);
  ok(rec !== null, '★ `placementAt` 必须读得到这条登记');
  eq(rec!.kind, KIND, '登记里的种类');
  eq(rec!.placedBy, 'p1', '登记里的放置者');
  eq(rec!.placedAtMs, 5_000_000, '登记里的时刻');
  eq(placementsOfRoom(roomId).size, 1, '★ 该房间应恰好有 1 条登记');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND32-2 同一格再放 ⇒ INVALID,且原记录一字不动(不可覆盖)', () => {
  reset();
  const { rt, roomId } = makeRoom();
  /* ★ 第一次放置要扣件 ⇒ 播种 410(ARENA_GOAL_FRAME)。第二次(LOGIC_AND)不播种:
     它必须先被第 5a 步「这一格已有自动化件」拒掉,播种反而会掩盖判序。 */
  seedHeld(rt, 410);
  const first = disp(rt, { x: 6, y: 6, kind: 'ARENA_GOAL_FRAME' });
  eq(first.kind, 'OK', `前置:第一次放置应成功(实测 reason=${first.reason ?? '-'})`);

  /* 推进假时钟:若拒绝路径也写状态,记录里的时刻会跟着变。 */
  now = 6_000_000;
  const again = disp(rt, { x: 6, y: 6, kind: 'LOGIC_AND' });
  eq(again.ok, false, '同一格不能放第二件');
  eq(again.kind, 'INVALID', '应归为 INVALID(状态冲突,不是权限问题)');
  ok(typeof again.reason === 'string' && again.reason.length > 0, '拒绝必须带原因');

  const rec = placementAt(roomId, 6, 6);
  ok(rec !== null, '原来那条记录必须还在');
  eq(rec!.kind, 'ARENA_GOAL_FRAME', '★ 原来那件还在(没被后一件覆盖)');
  eq(rec!.placedAtMs, 5_000_000, '★ 原记录的时刻没被改写');
  eq(rec!.placedBy, 'p1', '★ 原记录的放置者没被改写');
  eq(placementsOfRoom(roomId).size, 1, '★ 拒绝路径不新增记录');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND32-3 未知 kind ⇒ INVALID(判据是注册表,不是本文件自造的名单)', () => {
  reset();
  const { rt, roomId } = makeRoom();
  /* 反例与正例都走**同一个判据** `hasComponentKind`,本文件不另列白名单。 */
  const GHOST = 'SENSOR_NO_SUCH_THING';
  eq(hasComponentKind(GHOST), false, '前置:这个名字确实没被注册');
  eq(hasComponentKind('SENSOR_LEVER'), true, '正对照:已注册的种类应为 true');

  const r = disp(rt, { x: 7, y: 7, kind: GHOST });
  eq(r.ok, false, '未知种类不能放置');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(placementsOfRoom(roomId).size, 0, '★ 被拒后零登记');
  eq(placementAt(roomId, 7, 7), null, '★ 那一格也没登记');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND32-4 坐标非法(负 / 小数 / NaN / 缺失 / 越界)⇒ INVALID 且不写状态', () => {
  reset();
  const { rt, roomId } = makeRoom();
  const KIND = 'LOGIC_NOT';
  const cases: Array<[number, number, string]> = [
    [-1, 5, '负 x'],
    [5, -1, '负 y'],
    [1.5, 5, '小数 x'],
    [5, 1.5, '小数 y'],
    [Number.NaN, 5, 'NaN x'],
    [5, Number.NaN, 'NaN y'],
    [undefined as unknown as number, 5, '缺 x'],
    [5, undefined as unknown as number, '缺 y'],
    [9999, 5, '远超任何世界尺寸的 x'],
    [5, 9999, '远超任何世界尺寸的 y'],
  ];
  for (const [x, y, label] of cases) {
    const r = disp(rt, { x, y, kind: KIND });
    eq(r.ok, false, `${label}:不该成功`);
    eq(r.kind, 'INVALID', `${label}:应是 INVALID(实测 reason=${r.reason ?? '-'})`);
  }
  eq(placementsOfRoom(roomId).size, 0, '★ 全部被拒后零登记');

  /* 负对照:同一格用合法整数坐标就成功 —— 证明上面拒绝的是**坐标**,不是这个动作本身。 */
  /* ★ 负对照那一次是**真的**放置 ⇒ 先播种 415(否则它被「账面 0 件」拒掉,
     负对照就退化成「又在测同一个拒绝」,证不出坐标是被拒的原因)。 */
  seedHeld(rt, 415);
  const good = disp(rt, { x: 5, y: 5, kind: KIND });
  eq(good.kind, 'OK', `负对照:合法坐标应成功(实测 reason=${good.reason ?? '-'})`);
  eq(placementsOfRoom(roomId).size, 1, '负对照:这时才有 1 条登记');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND32-5 越权(GUEST 没有 wiring 位)⇒ PERMISSION 且不写状态', () => {
  reset();
  const { rt, roomId } = makeRoom('OWNER');
  /* `p1` 是房主(OWNER);`g1` 按访客进来(GUEST 无 `wiring` 位)。 */
  rt.join({ userId: 'g1', asGuest: true });

  const denied = dispAs(rt, 'g1', { x: 8, y: 8, kind: 'LOGIC_AND' });
  eq(denied.ok, false, 'GUEST 不能放自动化件');
  eq(denied.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 否则「越权」与「参数错」混成一个值)');
  eq(placementsOfRoom(roomId).size, 0, '★ 越权被拒后零状态');
  eq(placementAt(roomId, 8, 8), null, '★ 那一格没登记');

  /* ★ 房主那一次也是真的放置 ⇒ 先播种 414。 */
  seedHeld(rt, 414);
  /* 负对照:同一格让带 `wiring` 位的房主放 ⇒ OK
     (证明上面失败的是**权限**,不是这个动作本身)。 */
  const allowed = disp(rt, { x: 8, y: 8, kind: 'LOGIC_AND' });
  eq(allowed.kind, 'OK', `负对照:房主应能放(实测 reason=${allowed.reason ?? '-'})`);
  eq(placementsOfRoom(roomId).size, 1, '负对照之后才有 1 条登记');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND32-6 跨房间隔离:两个 roomId 的同坐标互不可见', () => {
  reset();
  const a = makeRoom();
  const b = makeRoom();
  ok(a.roomId !== b.roomId, '前置:两个房间号不同');

  /* ★ ACT_RGB_LAMP ⇒ 播种 420。 */
  seedHeld(a.rt, 420);
  const ra = disp(a.rt, { x: 9, y: 9, kind: 'ACT_RGB_LAMP' });
  eq(ra.kind, 'OK', `房间 A 放置应成功(实测 reason=${ra.reason ?? '-'})`);

  eq(placementAt(a.roomId, 9, 9) !== null, true, '★ 房间 A 自己看得到');
  eq(placementAt(b.roomId, 9, 9), null, '★ 房间 B 看不见 A 的登记(同坐标)');
  eq(placementsOfRoom(b.roomId).size, 0, '★ B 的登记表是空的');

  /* 房间 B 在同一格放**另一件**:不该被 A 的记录挡住。 */
  /* ★ 房间 B 的 LOGIC_SPLITTER ⇒ 播种 416(两个房间各扣各的,不共用一件)。 */
  seedHeld(b.rt, 416);
  const rb = disp(b.rt, { x: 9, y: 9, kind: 'LOGIC_SPLITTER' });
  eq(rb.kind, 'OK', `房间 B 同坐标放置应成功(实测 reason=${rb.reason ?? '-'})`);
  eq(placementAt(b.roomId, 9, 9)!.kind, 'LOGIC_SPLITTER', '★ B 那一格是 B 放的那件');
  eq(placementAt(a.roomId, 9, 9)!.kind, 'ACT_RGB_LAMP', '★ A 那一格仍是 A 放的那件');
  eq(placementsOfRoom(a.roomId).size, 1, 'A 仍是 1 条');
  eq(placementsOfRoom(b.roomId).size, 1, 'B 也是 1 条');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND32-7 世界里已有物件的格子不可覆盖(登记表与 obj 层都算「非空」)', () => {
  reset();
  const { rt, roomId, sim } = makeRoom();
  /* 先用 `PLACE_BLOCK` 在世界里占住那一格 —— 走生产同一条路(先给凭证再入背包)。 */
  const LOG = 101;
  const src = 'seed:101:1';
  rt.grantItemSource('p1', src);
  const seeded = rt.applyInventory('p1', { ops: [{ itemId: LOG, delta: 1, source: src }] });
  ok(seeded.allowed, '前置:应能把 1 件建材放进背包(被拒说明容量/守恒层先坏了)');

  const blk = rt.dispatchAction('p1', RoomAction.PLACE_BLOCK, { x: 9, y: 5, itemId: LOG });
  eq(blk.kind, 'OK', `前置:放块应成功(实测 reason=${blk.reason ?? '-'})`);
  eq(sim.materials().blockAt(9, 5), LOG, '前置:那一格在世界里真的有物件了');

  const r = disp(rt, { x: 9, y: 5, kind: 'LOGIC_AND' });
  eq(r.ok, false, '被世界物件占着的格子不能放自动化件(覆盖 = 凭空拆掉别人的东西)');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(placementsOfRoom(roomId).size, 0, '★ 被拒后零登记');
  eq(sim.materials().blockAt(9, 5), LOG, '★ 世界那一格也没变(本动作根本不写世界)');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND32-8 读回的是**副本**:改它不会影响登记表(唯一写者是本动作)', () => {
  reset();
  const { rt, roomId } = makeRoom();
  /* ★ 放置要扣件:`place_automation.ts` 第 6 步按 `spec.id` 查按件权威账 ⇒ 先播种 418。 */
  seedHeld(rt, 418);
  const r = disp(rt, { x: 4, y: 7, kind: 'WIRELESS_LINK' });
  eq(r.kind, 'OK', `前置:放置应成功(实测 reason=${r.reason ?? '-'})`);

  const rec = placementAt(roomId, 4, 7);
  ok(rec !== null, '前置:应读得到了');
  (rec as unknown as { kind: string }).kind = 'HACKED';
  eq(placementAt(roomId, 4, 7)!.kind, 'WIRELESS_LINK', '★ 登记表没被外部改动');

  const all = placementsOfRoom(roomId);
  const only = all.get('4,7');
  ok(only !== undefined, '★ `placementsOfRoom` 的键是格子键 "x,y"');
  (only as unknown as { placedBy: string }).placedBy = 'HACKER';
  eq(placementAt(roomId, 4, 7)!.placedBy, 'p1', '★ 整体读回也是副本');
});

report('WS-FND-32');
