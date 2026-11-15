/**
 * WS-FND-27 —— **储物箱**(`OPEN_CHEST` / `USE_OWN_CHEST`)。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md` 把这两个动作归为「缺一个**容器模型**」:
 * 公共箱是**共享**模型(同房间任何人打开的是同一份),私有箱是**按玩家**的容器。
 * 补上模型之前两个动作只会回 `NOT_IMPLEMENTED` —— 也就是说「存东西 / 取东西」
 * 这条玩法链在线上**根本不存在**。
 *
 * ## 钉的不是「回了 OK」,而是**两侧账都对得上**
 *
 * 每次取放都同时动两处:**容器**(本模块内的箱子内容)与**背包**(经
 * `ctx.applyInventory`,反作弊的总量守恒与凭证链都在那条路上)。故每条断言都要求
 * **两侧同时**正确 —— 只验一侧会漏掉本仓记过的那类缺陷
 * ("扣了东西没进箱" / "凭空多出一件" / "失败了却留下半个动作")。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 放入公共箱 ⇒ 背包减 **且** 容器加;另一玩家看到同一份 | 把 `public` 改成按玩家一份 |
 * | 2 | 从公共箱取 ⇒ 容器减 **且** 背包加 | 去掉 `grantItemSource`(会被反作弊按凭空产出拒) |
 * | 3 | 私有箱:A 放的 B 拿不到 | 抽屉键去掉 `userId`(共用一份) |
 * | 4 | 数量非法 / 不是箱子 ⇒ `INVALID` 且两侧不变 | 校验挪到写之后 |
 * | 5 | 权限不足(guest)⇒ `PERMISSION` | 去掉动作里的 `authorize` |
 * | 6 | 容量满时放入 ⇒ 失败且容器不变 | 容量检查改成恒 false |
 * | 7 | 往返守恒:存→取回到原值 | 任一侧漏改 |
 *
 * ⚠️ 本套件**不能**证明的东西(接线**没有**做到,别当成做到了):
 *   1 箱内内容**不上 wire** ⇒ 客户端暂时看不到箱里的东西 —— 下面读的是
 *     容器**在服务端**的状态(`publicChestContents` / `ownChestContents`)与只读回执,
 *     不是「客户端收到的东西」;
 *   2 容器状态**不持久化** ⇒ 只活在进程内存里,房间重建即空;
 *   3 世界里**没有**真实箱子实体 ⇒ 箱子由 `registerChest()`(**测试**在这里用)登记。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';
import { RoomRole } from '../server/src/db/repo.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import {
  ownChestContents,
  publicChestContents,
  registerChest,
} from '../server/src/net/actions/open_chest.ts';

/** 测试用物品:`101 暖松原木`(冻结内容表里的木材)。 */
const LOG = 101;
/** 压根不存在的物品 id —— 用于验明「编号空投」被拒。 */
const GHOST_ID = 999999;

/** 箱子那一格。世界里没有真实箱子实体,格子由测试自己挑。 */
const CX = 3;
const CY = 4;

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  roomId: string;
};

/** 每个房间一个**唯一 id** ⇒ 容器模型按 `roomId` 隔离,测试之间不互相污染。 */
let roomSeq = 0;
/** `seed` 的来源凭证序号(凭证集合是 Set,用递增后缀避免复用时误判)。 */
let seedSeq = 0;

/**
 * 建一个**真装配**出来的房间(`assemble()`,`mock` 一律不手搓)。
 *
 * 角色安排:`p1` 是房主(OWNER,有 `publicStorage`);`p2` 先以 MEMBER 进房,
 * 再被房主升为 ADMIN —— 因为 `PERMISSION_MATRIX` 里 **MEMBER 没有 `publicStorage`**,
 * 不升它就没法让它开公共箱(那会测成权限,而不是共享模型)。
 */
function makeRoom(deps: { withGuest?: boolean } = {}): Room {
  roomSeq += 1;
  const roomId = `r_chest_${roomSeq}`;
  const a = assemble({
    roomId,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 16,
    /* `mobs: false`:本套件不测世界,不想让自发改刷的怪参与。 */
    mobs: false,
    rng: mulberry32(11),
  });
  const rt = a.runtime;
  rt.join({ userId: 'p1' }); // OWNER
  rt.join({ userId: 'p2' }); // MEMBER
  const promoted = rt.setMemberRole('p1', 'p2', RoomRole.ADMIN);
  ok(promoted.ok, '测试前置:p2 应能升为 ADMIN(否则它没有 publicStorage)');
  if (deps.withGuest) rt.join({ userId: 'g', asGuest: true });
  registerChest(roomId, CX, CY);
  return { rt, roomId };
}

/** 背包**权威**总量(`RoomRuntime.authoritativeItemTotal`)。 */
const total = (room: Room, userId: string): number => room.rt.authoritativeItemTotal(userId);

/**
 * 塞东西进背包 —— 走**生产同一条路**:先 `grantItemSource` 再 `applyInventory`。
 * 不走后门(不直接改总量):那样测出来的闭环是假的。
 */
function seed(room: Room, userId: string, itemId: number, n: number): void {
  seedSeq += 1;
  const src = `seed:${itemId}:${n}:${seedSeq}`;
  room.rt.grantItemSource(userId, src);
  const r = room.rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒 ${r.rejectCode ?? ''})`);
}

const act = (
  room: Room,
  action: RoomAction,
  userId: string,
  payload: Record<string, unknown> = {},
): ActionOutcome => room.rt.dispatchAction(userId, action, payload);

/* ───────────────────────── 1 ───────────────────────── */

test('FND27-1 放入公共箱:背包减、容器加,且另一玩家看到**同一份**(共享模型)', () => {
  const room = makeRoom();
  seed(room, 'p1', LOG, 3);
  eq(total(room, 'p1'), 3, '前置:背包 3 件');

  const r = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 2 });
  eq(r.ok, true, `存入应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  ok(r.effect !== undefined, '★ `OK` 必须带 effect(不留"回 OK 却无副作用")');

  eq(total(room, 'p1'), 1, '★ 背包真的少了 2 件');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 2 }], '★ 公共箱真的多了 2 件');

  /* ★ 共享模型的关键:另一个玩家打开同一格,看到的是**同一份**。 */
  const seen = act(room, RoomAction.OPEN_CHEST, 'p2', { x: CX, y: CY });
  eq(seen.ok, true, `ADMIN 应能打开公共箱(kind=${seen.kind} reason=${seen.reason ?? '-'})`);
  eq(seen.effect?.stacks, 1, '★ p2 看到 1 档 —— 若公共箱按玩家各一份,这里会是 0');
  eq(seen.effect?.total, 2, '★ p2 看到 2 件');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 2 }], '打开只看不该改内容');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND27-2 从公共箱取:容器减、背包加(产出有凭证)', () => {
  const room = makeRoom();
  seed(room, 'p1', LOG, 3);
  act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 3 });
  eq(total(room, 'p1'), 0, '前置:全存进去了');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 3 }], '前置:箱里有 3 件');

  const r = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: -1 });
  eq(r.ok, true, `取出应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(total(room, 'p1'), 1,
    '★ 背包多了一件(**没有凭证的话反作弊会按"凭空产出"拒**,这里就会是 0)');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 2 }], '★ 容器少了一件');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND27-3 私有箱:玩家 A 放的,玩家 B 拿不到(隔离)', () => {
  const room = makeRoom();
  seed(room, 'p1', LOG, 4);

  const put = act(room, RoomAction.USE_OWN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 4 });
  eq(put.ok, true, `A 存进自己的箱子应成功(kind=${put.kind} reason=${put.reason ?? '-'})`);
  eq(ownChestContents(room.roomId, CX, CY, 'p1'), [{ itemId: LOG, count: 4 }], '★ A 的抽屉里真的有 4 件');
  eq(ownChestContents(room.roomId, CX, CY, 'p2'), [], '★ B **看不到** A 的东西(自己的抽屉是空的)');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 私有抽屉不碰公共箱');

  const steal = act(room, RoomAction.USE_OWN_CHEST, 'p2', { x: CX, y: CY, itemId: LOG, count: -1 });
  eq(steal.ok, false, '★ B 不能从 A 的抽屉里拿东西');
  eq(steal.kind, 'INVALID', '应被归为 INVALID(自己的箱子里没有这件)');
  eq(ownChestContents(room.roomId, CX, CY, 'p1'), [{ itemId: LOG, count: 4 }], '★ A 的抽屉一件不少');
  eq(total(room, 'p2'), 0, '★ B 的背包也没多 —— 两边都不留痕');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND27-4 数量非法 / 不是箱子 ⇒ INVALID,且两边都不变', () => {
  const room = makeRoom();
  seed(room, 'p1', LOG, 2);
  const before = publicChestContents(room.roomId, CX, CY);

  const zero = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 0 });
  eq(zero.ok, false, 'count=0 不是合法数量');
  eq(zero.kind, 'INVALID', '应被归为 INVALID');

  const frac = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 1.5 });
  eq(frac.ok, false, '非整数 count 应拒');
  eq(frac.kind, 'INVALID', '应被归为 INVALID');

  const ghost = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: GHOST_ID, count: 1 });
  eq(ghost.ok, false, '不在冻结内容表里的 itemId 应拒(编号空投)');
  eq(ghost.kind, 'INVALID', '应被归为 INVALID');

  /* `registerChest` 只登记了 (CX,CY):旁边那一格**不是**箱子。 */
  const notChest = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX + 9, y: CY + 9, itemId: LOG, count: 1 });
  eq(notChest.ok, false, '不是箱子的一格应拒');
  eq(notChest.kind, 'INVALID', '应被归为 INVALID');

  eq(publicChestContents(room.roomId, CX, CY), before, '★ 容器一个字都没动');
  eq(total(room, 'p1'), 2, '★ 背包也一件没少');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND27-5 权限不足(guest)对 OPEN_CHEST ⇒ PERMISSION', () => {
  const room = makeRoom({ withGuest: true });

  const r = act(room, RoomAction.OPEN_CHEST, 'g', { x: CX, y: CY, itemId: LOG, count: 1 });
  eq(r.ok, false, 'GUEST 不能开公共箱');
  eq(r.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 否则"越权"与"参数错"混成一个值)');
  ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带原因');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 被拒后容器零变化');

  /* 负对照:同一个 GUEST 用 `USE_OWN_CHEST` 是 `baseline` ⇒ 应成功。
     它排除了"上面失败只是因为 GUEST 什么都做不了"的解释。 */
  const own = act(room, RoomAction.USE_OWN_CHEST, 'g', { x: CX, y: CY });
  eq(own.ok, true, `GUEST 打开**自己**的箱子是 baseline ⇒ 应成功(kind=${own.kind} reason=${own.reason ?? '-'})`);
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND27-6 容量满时放入 ⇒ 失败且容器不变(半步事务的对照)', () => {
  const room = makeRoom();
  /* ⚠️ 断言右侧一律用**字面量**,不取被测模块的导出常量:
     `eq(ids.length, CHEST_SLOTS)` 就是 `slice(0,N).length === N`(同义反复),
     门禁的 `--strict-taut` 当场抓到。容量 24 的出处是物品 513 的"24 格"。 */
  const CHEST_CAP = 24;
  const ids = ITEM_LIST.slice(0, CHEST_CAP).map((it) => it.id);
  ok(ids.length >= CHEST_CAP,
    `前置:内容表里至少要有 ${CHEST_CAP} 个不同 id(实测 ${ids.length})`);
  for (let i = 0; i < ids.length; i += 1) {
    seed(room, 'p1', ids[i], 1);
    const r = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: ids[i], count: 1 });
    eq(r.ok, true, `前置:第 ${i + 1} 档应能存入(kind=${r.kind} reason=${r.reason ?? '-'})`);
  }
  eq(publicChestContents(room.roomId, CX, CY)?.length, CHEST_CAP, '前置:箱子正好满');
  /* 再多一个**新** id:它要占第 25 格 ⇒ 放不下。 */
  const extra = ITEM_LIST[CHEST_CAP].id;
  seed(room, 'p1', extra, 1);
  const pileBefore = total(room, 'p1');
  const full = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: extra, count: 1 });
  eq(full.ok, false, '满了就放不进新的一档');
  eq(full.kind, 'INVALID', '应被归为 INVALID');
  eq(total(room, 'p1'), pileBefore, '★ 背包没被扣(放进不去时不该吞东西 —— 半步事务的对照)');
  eq(publicChestContents(room.roomId, CX, CY)?.length, CHEST_CAP, '★ 容器也没变(仍是 24 格)');
  eq(publicChestContents(room.roomId, CX, CY)?.length, CHEST_CAP, '★ 容器也没变');

  /* 负对照:同一格里**已有一档**的仍能取出 ⇒ 证明上面拒的是**容量**,不是这一格坏了。 */
  const take = act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: ids[0], count: -1 });
  eq(take.ok, true, `已有那一档应能取出(kind=${take.kind} reason=${take.reason ?? '-'})`);
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND27-7 往返守恒:存进去再取出来,背包回到原值', () => {
  const room = makeRoom();
  seed(room, 'p1', LOG, 5);
  const before = total(room, 'p1');

  act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: 5 });
  eq(total(room, 'p1'), 0, '存完背包为空');
  eq(publicChestContents(room.roomId, CX, CY), [{ itemId: LOG, count: 5 }], '箱里有 5 件');

  act(room, RoomAction.OPEN_CHEST, 'p1', { x: CX, y: CY, itemId: LOG, count: -5 });
  eq(total(room, 'p1'), before, '★ 取回来之后必须回到原值(两侧都没漏改)');
  eq(publicChestContents(room.roomId, CX, CY), [], '★ 容器也回到空');
});

report('WS-FND-27');
