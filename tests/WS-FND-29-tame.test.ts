/**
 * WS-FND-29 —— `BREED_TAME`(投喂 / 驯服 / 繁殖)的动作层判据。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md` 给 `BREED_TAME` 那一行的诊断是:
 * ```
 * | `BREED_TAME` | `mobs/taming.ts` 存在但为 **orphan**:缺宠物容器与驯服交互
 *                 (`feedPet` 零生产调用) |
 * ```
 * ⇒ 接线前的实测形态是:`RoomAction.BREED_TAME` **有**(`room.ts:126`)、
 *   `ACTION_PERMISSION.BREED_TAME = 'baseline'` **有**(`room.ts:183`)、
 *   而**执行层没有**(`notImplemented`)—— 玩家发这个动作只会拿到
 *   「尚无执行层」。本套件钉的是它现在**真的**会发生什么。
 *
 * ## 用**真装配**:`assemble()` + `rt.dispatchAction`(同 `tests/WS-FND-20`)
 *
 * 不手搓 `rtOpts`(那会绕开 `assemble()`),也不直接调 handler:
 * 权限闸 / 失败分类 / 背包闸都是**房间**那一侧的,绕过它们测出来的闭环是假的。
 * 夹具照抄 `WS-FND-20` 的 `seed()`(先 `grantItemSource` 再 `applyInventory`)
 * 与「读权威总量(`authoritativeItemTotal`),不读自己记的数」。
 *
 * ## 逐条对应的判据(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 有食物 ⇒ 投喂成功:背包 -1 **且** 好感 +1 | 去掉 `applyInventory` 那一次消耗 / 好感不记 |
 * | 2 | 没有那件食物 ⇒ `INVALID`,**两侧都不变** | 先改宠物状态再扣背包 |
 * | 3 | 好感不够 ⇒ 拒绝;够了 ⇒ 成功并记下主人 | 驯服不看好感阈值 |
 * | 4 | 已被别人驯服 ⇒ 明确拒绝,主人不变 | 第二次驯服直接覆盖 `ownerId` |
 * | 5 | 两只达标 ⇒ 产生繁殖记录,**零物品产出、零生物实体** | 繁殖里偷偷 `applyInventory(+n)` |
 * | 6 | 失败路径两侧都不变(半步事务对照) | 校验排在写入之后 |
 * | 7 | 不在房里 ⇒ `PERMISSION`;GUEST ⇒ 能投喂(`baseline`) | 去掉动作里的 `authorize` / 把权限位当 `build` |
 * | 8 | 不是可驯服生物 ⇒ 拒绝,且**不留下宠物记录** | 首次投喂不查内容层名单 |
 * | 9 | 不在冻结内容表里的物品 id 一律不认,一点不扣 | 去掉 `ITEM_ID_SET` 检查 |
 * | 10 | 别人的宠物不能被投喂(归属是硬约束) | 投喂不看 `ownerId` |
 *
 * ## 本套件**不能**证明的两件事(说清楚,而不是让读者以为覆盖了)
 *
 * ```
 * 1 「宠物」不是**真生物实体**:它只是本模块 Map 里的一条记录 ——
 *   世界里没有 wildlife 实体被生成/改归属(world_sim.ts 一个字没动,
 *   本套件 FND29-5 只断言 `state.wildlife` 条数**没变**,不是"变了"）。
 * 2 「该物种吃哪件食物」**不在**判定里:`MobDef.tameItem` 是内容层的事实,
 *   而读它会让 `tests/WS-04` 的事实快照变红(理由见 `breed_tame.ts` 文件头)。
 *   ⇒ 本套件只验「那一件在不在背包里」,不验「它在不在该物种的食谱里」。
 * ```
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome, type ActionPayload } from '../server/src/net/room.ts';
import { MOB_LIST, tameableMobs } from '../shared/constants/mobs.ts';
import {
  AFFECTION_REQUIRED, breedRecordsOfRoom, petsOfRoom,
} from '../server/src/net/actions/breed_tame.ts';

/** 测试用的食物:`123 黄金小麦`(冻结内容表里的谷物)。 */
const FOOD = 123;
/** 压根不存在的物品 id —— 用于验明「编号空投」被拒。 */
const GHOST_ITEM = 999999;

/** 内容层名单里第 i 个可驯服生物的 id。取不到就抛(名单空了说明内容层变了)。 */
function tameableId(i: number): string {
  const d = tameableMobs()[i];
  if (d === undefined) throw new Error(`内容层「可驯服生物」名单不足 ${i + 1} 条`);
  return d.id;
}
const MOB_A = tameableId(0);
const MOB_B = tameableId(1);

/** `authoritativeItemTotal` 是房间的公开方法;这里只为**读**它而窄化(不改行为)。 */
type TotalLike = { authoritativeItemTotal(userId: string): number };

type Room = {
  rt: ReturnType<typeof assemble>['runtime'];
  total: TotalLike;
  roomId: string;
};

function makeRoom(roomId: string, extraMembers: readonly string[] = []): Room {
  const a = assemble({
    roomId,
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    /* `mobs: false`:本套件测动作层,不想让自发改刷的怪参与 ——
       它们会变成「第三个东西」,让失败信息难以归因(同 WS-FND-20)。 */
    mobs: false,
    rng: mulberry32(29),
  });
  a.runtime.join({ userId: 'p1' });
  for (const u of extraMembers) a.runtime.join({ userId: u });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const u of ['p1', ...extraMembers]) {
    for (const id of a.runtime.authoritativeItemIds(u)) a.runtime.applyInventory(u, { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount(u, id) }] });
  }
  return { rt: a.runtime, total: a.runtime as unknown as TotalLike, roomId };
}

/**
 * 塞东西进背包 —— 走**生产同一条路**(先给凭证再入包),不走后门改总量。
 * 直接改总量测出来的闭环是假的(同 `WS-FND-20` 的 `seed`)。
 */
function seed(rt: Room['rt'], userId: string, itemId: number, n: number): void {
  const src = `seed:${userId}:${itemId}:${n}`;
  rt.grantItemSource(userId, src);
  const r = rt.applyInventory(userId, { ops: [{ itemId, delta: n, source: src }] });
  ok(r.allowed, `测试前置:应能塞进 ${n} 件 ${itemId}(被拒说明容量/守恒层先坏了)`);
}

/**
 * 发一次 `BREED_TAME`。
 *
 * `op` / `petId` / `mobId` / `mateId` 不在 `ActionPayload` 的字段表里(那条接口属于
 * 别的动作)⇒ 这里显式收窄一次。**只在这一处**收窄:测试与生产模块看到的是同一个
 * 报文形状(契约见 `breed_tame.ts` 文件头)。
 */
function tame(
  rt: Room['rt'],
  userId: string,
  payload: Record<string, unknown>,
): ActionOutcome {
  return rt.dispatchAction(userId, RoomAction.BREED_TAME, payload as unknown as ActionPayload);
}

const feed = (rt: Room['rt'], userId: string, petId: string, mobId: string, itemId = FOOD) =>
  tame(rt, userId, { op: 'FEED', petId, mobId, itemId });
const tameOp = (rt: Room['rt'], userId: string, petId: string) =>
  tame(rt, userId, { op: 'TAME', petId });
const breedOp = (rt: Room['rt'], userId: string, petId: string, mateId: string) =>
  tame(rt, userId, { op: 'BREED', petId, mateId });

/** 逐字取回执的 `effect`(★ 值域已放宽为 `EffectRecord`;断言处按需窄化到标量表)。 */
function effectOf(r: ActionOutcome): Record<string, string | number | boolean> {
  return (r.effect ?? {}) as Record<string, string | number | boolean>;
}

/** 某只宠物当前的记录(不存在 ⇒ 断言失败,并把房间里的全部宠物打出来)。 */
function petOf(roomId: string, petId: string): { ownerId: string | null; affection: number } {
  const all = petsOfRoom(roomId);
  const p = all.find((x) => x.petId === petId);
  ok(p !== undefined, `房间里应有宠物 ${petId} 的记录(实测:${JSON.stringify(all)})`);
  return p as { ownerId: string | null; affection: number };
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND29-1 投喂:有食物 ⇒ 背包 -1,好感 +1(两侧同时成立)', () => {
  const { rt, total, roomId } = makeRoom('r_tame_1');
  seed(rt, 'p1', FOOD, 2);
  eq(total.authoritativeItemTotal('p1'), 2, '前置:背包 2 件');

  const r = feed(rt, 'p1', 'pet:a', MOB_A);
  eq(r.ok, true, `投喂应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  eq(effectOf(r)['affection'], 1, '★ 回执里的好感是这一喂之后的数');
  eq(effectOf(r)['feeds'], 1, '回执里也带已投喂次数');
  eq(total.authoritativeItemTotal('p1'), 1,
    '★ 背包**真的**少了一件(只改宠物不改背包 = 食物白吃)');
  eq(petOf(roomId, 'pet:a').affection, 1, '★ 宠物容器里的好感真的上升了');

  /* 再喂一次:两侧账继续对得上(不是只在第一次巧合)。 */
  const r2 = feed(rt, 'p1', 'pet:a', MOB_A);
  eq(r2.ok, true, '第二喂也应成功');
  eq(total.authoritativeItemTotal('p1'), 0, '★ 背包再少一件');
  eq(petOf(roomId, 'pet:a').affection, 2, '★ 好感累加到 2');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND29-2 没有那件食物 ⇒ INVALID,且**两侧都不变**', () => {
  const { rt, total, roomId } = makeRoom('r_tame_2');
  seed(rt, 'p1', FOOD, 1);
  eq(feed(rt, 'p1', 'pet:a', MOB_A).ok, true, '前置:先喂掉那一件');
  eq(total.authoritativeItemTotal('p1'), 0, '前置:背包已空');
  eq(petOf(roomId, 'pet:a').affection, 1, '前置:好感 1');

  const r = feed(rt, 'p1', 'pet:a', MOB_A);
  eq(r.ok, false, '背包里没有那件就不能喂');
  eq(r.kind, 'INVALID', '应被归为 INVALID(状态不对,不是权限问题)');
  ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝必须带原因');
  eq(total.authoritativeItemTotal('p1'), 0,
    '★ 背包不变(不能被拒还把东西扣掉)');
  eq(petOf(roomId, 'pet:a').affection, 1,
    '★ 好感也不变 —— 若先改宠物再扣背包,这里会是 2(半步事务)');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND29-3 好感不够 ⇒ 拒绝;喂满 ⇒ 成功并记下唯一主人', () => {
  const { rt, roomId } = makeRoom('r_tame_3');
  seed(rt, 'p1', FOOD, AFFECTION_REQUIRED + 1);

  eq(feed(rt, 'p1', 'pet:a', MOB_A).ok, true, '前置:喂第一口');
  const early = tameOp(rt, 'p1', 'pet:a');
  eq(early.ok, false, '好感 1/3 时不能驯服(阈值 3 的出处:actions/breed_tame.ts 的 AFFECTION_REQUIRED;断言右侧一律用字面量,不取被测模块的导出常量 —— 否则是同义反复)');
  eq(early.kind, 'INVALID', '应是 INVALID');
  eq(petOf(roomId, 'pet:a').ownerId, null, '★ 被拒后**没有**主人(驯服没发生)');

  /* 喂到达标。 */
  for (let i = 1; i < AFFECTION_REQUIRED; i += 1) {
    eq(feed(rt, 'p1', 'pet:a', MOB_A).ok, true, `前置:第 ${i + 1} 口`);
  }
  eq(petOf(roomId, 'pet:a').affection, 3, '前置:好感达标(阈值 3)');

  const r = tameOp(rt, 'p1', 'pet:a');
  eq(r.ok, true, `达标后应能驯服(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(effectOf(r)['ownerId'], 'p1', '★ 回执里写下主人');
  eq(petOf(roomId, 'pet:a').ownerId, 'p1', '★ 容器里也记下主人');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND29-4 已被别人驯服 ⇒ 明确拒绝(同一只宠物只能有一个主人)', () => {
  const { rt, roomId } = makeRoom('r_tame_4', ['p2']);
  seed(rt, 'p1', FOOD, AFFECTION_REQUIRED);
  for (let i = 0; i < AFFECTION_REQUIRED; i += 1) feed(rt, 'p1', 'pet:a', MOB_A);
  eq(tameOp(rt, 'p1', 'pet:a').ok, true, '前置:p1 驯服成功');

  const again = tameOp(rt, 'p2', 'pet:a');
  eq(again.ok, false, '★ 第二次驯服(哪怕是别人)= 宠物干事,不能成功');
  eq(again.kind, 'INVALID', '应是 INVALID');
  ok((again.reason ?? '').includes('已是'), `拒绝要说清「已有主人」(实测:${again.reason ?? '无理由'})`);
  eq(petOf(roomId, 'pet:a').ownerId, 'p1',
    '★ 主人**没被覆盖**(静默改主是最坏的失败方式)');

  /* 同一个主人再驯一次也拒绝:状态是「已有主人」,与是谁无关。 */
  const self = tameOp(rt, 'p1', 'pet:a');
  eq(self.ok, false, '同一主人重复驯服同样拒绝(不静默成功)');
  eq(petOf(roomId, 'pet:a').ownerId, 'p1', '主人仍是 p1');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND29-5 两只达标 ⇒ 产生繁殖记录,**零物品产出、零生物实体**', () => {
  const { rt, total, roomId } = makeRoom('r_tame_5');
  seed(rt, 'p1', FOOD, AFFECTION_REQUIRED * 2);
  const wildlifeBefore = rt.state.wildlife.length;

  /* 两只宠物各自喂满并驯服(物种不同,验的是「两只」而不是「两只同类」)。 */
  for (const [petId, mobId] of [['pet:a', MOB_A], ['pet:b', MOB_B]] as const) {
    for (let i = 0; i < AFFECTION_REQUIRED; i += 1) {
      eq(feed(rt, 'p1', petId, mobId).ok, true, `前置:喂 ${petId} 第 ${i + 1} 口`);
    }
    eq(tameOp(rt, 'p1', petId).ok, true, `前置:驯服 ${petId}`);
  }
  const itemsBeforeBreed = total.authoritativeItemTotal('p1');
  eq(breedRecordsOfRoom(roomId).length, 0, '前置:还没有任何繁殖记录');

  const r = breedOp(rt, 'p1', 'pet:a', 'pet:b');
  eq(r.ok, true, `繁殖应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  const recId = String(effectOf(r)['recordId']);
  ok(recId.length > 0, '★ 回执必须给出 recordId(否则客户端不知道登记了哪一条)');

  const log = breedRecordsOfRoom(roomId);
  eq(log.length, 1, '★ 容器里**真的**多了一条繁殖记录');
  eq(log[0]!.recordId, recId, '记录 id 与回执一致');
  eq(log[0]!.petId, 'pet:a', '记录里写下父方');
  eq(log[0]!.mateId, 'pet:b', '记录里写下母方');
  eq(log[0]!.ownerId, 'p1', '记录里写下发起人');
  eq(log[0]!.parentsMobIds, [MOB_A, MOB_B], '记录里写下双亲物种');

  /* ★ 两侧都没被"顺手"改:
       物品总量不变(繁殖不产出东西 —— 产出属于别处的权威);
       wildlife 条数不变(繁殖**不**凭空生成生物实体)。 */
  eq(total.authoritativeItemTotal('p1'), itemsBeforeBreed,
    '★ 繁殖**零物品产出**(凭空 +1 会让这里不等)');
  eq(rt.state.wildlife.length, wildlifeBefore,
    '★ 繁殖**不生成生物实体**(world_sim 一个字没动)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND29-6 失败路径两侧都不变(半步事务对照:繁殖未达标)', () => {
  const { rt, total, roomId } = makeRoom('r_tame_6');
  seed(rt, 'p1', FOOD, AFFECTION_REQUIRED * 2);

  /* a 喂满并驯服;b 只喂到差一口 ⇒ 未达标但**有**记录。 */
  for (let i = 0; i < AFFECTION_REQUIRED; i += 1) feed(rt, 'p1', 'pet:a', MOB_A);
  eq(tameOp(rt, 'p1', 'pet:a').ok, true, '前置:驯服 pet:a');
  for (let i = 0; i < AFFECTION_REQUIRED - 1; i += 1) feed(rt, 'p1', 'pet:b', MOB_B);

  const itemsBefore = total.authoritativeItemTotal('p1');
  const aBefore = petOf(roomId, 'pet:a');
  const bBefore = petOf(roomId, 'pet:b');

  const r = breedOp(rt, 'p1', 'pet:a', 'pet:b');
  eq(r.ok, false, 'pet:b 好感未达标 ⇒ 不能繁殖');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(breedRecordsOfRoom(roomId).length, 0, '★ 没有留下任何繁殖记录');
  eq(total.authoritativeItemTotal('p1'), itemsBefore, '★ 背包没被碰过');
  eq(petOf(roomId, 'pet:a'), aBefore, '★ 宠物 a 的状态一字未改');
  eq(petOf(roomId, 'pet:b'), bBefore, '★ 宠物 b 的状态一字未改');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND29-7 权限:`baseline` —— GUEST 能投喂,不在房里的一律 PERMISSION', () => {
  const { rt, total } = makeRoom('r_tame_7');
  rt.join({ userId: 'g', asGuest: true });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of rt.authoritativeItemIds('g')) rt.applyInventory('g', { ops: [{ itemId: id, delta: -rt.authoritativeItemCount('g', id) }] });
  seed(rt, 'g', FOOD, 1);
  seed(rt, 'p1', FOOD, 1);

  /* `ACTION_PERMISSION.BREED_TAME = 'baseline'`,而 GUEST 也带 baseline
     (`PERMISSION_MATRIX.GUEST.baseline = true`)⇒ **能**做,只是不能建造。 */
  const g = feed(rt, 'g', 'pet:g', MOB_A);
  eq(g.ok, true, `GUEST 应能投喂(baseline;实测 kind=${g.kind} reason=${g.reason ?? '-'})`);
  eq(total.authoritativeItemTotal('g'), 0, 'GUEST 自己那件真的被吃掉了');

  /* 不在房里(`authorize` 要成员在场)⇒ PERMISSION,而且**不是** INVALID。 */
  const ghost = feed(rt, 'ghost', 'pet:x', MOB_A);
  eq(ghost.ok, false, '不在房里的玩家不能投喂');
  eq(ghost.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(与「参数/状态不对」区分开)');
  eq(petsOfRoom('r_tame_7').some((p) => p.petId === 'pet:x'), false,
    '★ 被拒之后**没有**留下宠物记录(越权不产生副作用)');
  eq(total.authoritativeItemTotal('p1'), 1, '别人的背包也没被动过');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND29-8 不是可驯服生物 ⇒ 拒绝,且不留下宠物记录', () => {
  const { rt, total, roomId } = makeRoom('r_tame_8');
  seed(rt, 'p1', FOOD, 1);
  const tameIds = new Set(tameableMobs().map((m) => m.id));
  const wild = MOB_LIST.find((m) => !tameIds.has(m.id));
  ok(wild !== undefined, '内容层应有不可驯服的生物(否则这条判据无对象)');

  const r = feed(rt, 'p1', 'pet:wild', wild!.id);
  eq(r.ok, false, `${wild!.id} 不在可驯服名单里 ⇒ 不能投喂`);
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(petsOfRoom(roomId).length, 0, '★ 没有留下宠物记录(拒绝发生在写入之前)');
  eq(total.authoritativeItemTotal('p1'), 1, '★ 背包也没被扣');
});

/* ───────────────────────── 9 ───────────────────────── */

test('FND29-9 不在冻结内容表里的物品 id 一律不认(编号空投)', () => {
  const { rt, total, roomId } = makeRoom('r_tame_9');
  seed(rt, 'p1', FOOD, 1);
  const r = feed(rt, 'p1', 'pet:a', MOB_A, GHOST_ITEM);
  eq(r.ok, false, '不存在的物品 id 不能当食物');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(total.authoritativeItemTotal('p1'), 1, '★ 一点没扣(拒绝发生在消耗之前)');
  eq(petsOfRoom(roomId).length, 0, '★ 也没有留下宠物记录');
});

/* ───────────────────────── 10 ───────────────────────── */

test('FND29-10 别人的宠物不能被投喂(归属是硬约束)', () => {
  const { rt, total, roomId } = makeRoom('r_tame_10', ['p2']);
  seed(rt, 'p1', FOOD, AFFECTION_REQUIRED);
  for (let i = 0; i < AFFECTION_REQUIRED; i += 1) feed(rt, 'p1', 'pet:a', MOB_A);
  eq(tameOp(rt, 'p1', 'pet:a').ok, true, '前置:pet:a 归 p1');
  seed(rt, 'p2', FOOD, 1);

  const r = feed(rt, 'p2', 'pet:a', MOB_A);
  eq(r.ok, false, 'p2 不能喂别人的宠物');
  eq(r.kind, 'INVALID', '应是 INVALID');
  eq(total.authoritativeItemTotal('p2'), 1, '★ p2 的食物没被吃掉');
  eq(petOf(roomId, 'pet:a').affection, 3, '★ 好感也没涨');
  eq(petOf(roomId, 'pet:a').ownerId, 'p1', '主人仍是 p1');
});

report('WS-FND-29');