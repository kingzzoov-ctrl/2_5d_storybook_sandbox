/**
 * WS-FND-41 —— 让 `BREED_TAME` 的宠物**被世界看见**:归属登记的**只读查询**。
 *
 * ## 这条欠账的现状(实测,不是推测)
 *
 * ```
 * 归属 / 好感住  server/src/net/actions/breed_tame.ts 的 ROOM_PETS(Map)
 * 世界侧读者    world_sim.ts:4329 listWildlife() 把 tameOwnerId **硬编码 `''`**
 *                ⇒ room.ts:1914 projectWildlife() 经 room.ts:1925 投影进 state.wildlife
 *                ⇒ 客户端/AI 看到的永远是「野生」
 * ```
 * `docs/TASK-96-action-landing-gaps.md:72` 把这条记为「宠物不是真生物实体,不写
 * `WildlifeState`」;`.pi/goal/*宠物接世界*` 要求「`tameOwnerId` 有真正的写入者 +
 * 一条断言证明驯服后世界侧能看到主人」。
 *
 * ## 本套件钉什么 / **不**钉什么
 *
 * 本套件钉**动作层这一半**:`breed_tame.ts` 现在把「宠物 → 主人」做成一份**可被投影
 * 取走的权威登记**,并提供只读查询 `tameOwnerOf(roomId, petId)`
 * (`string | null`)/ `tamedPetsOfRoom(roomId)`(副本数组)。
 *
 * ⚠️ **不**钉「`state.wildlife` 真的写进去了」 —— 那一行接线在**别的文件**
 *   (`room.ts:1925` / `world_sim.ts:4344`,均不在本轮写域,见 `breed_tame.ts` 文件头
 *   「世界侧今天还看不见」)。本套件证明的是:**世界侧那一行需要的值,这里查得到、
 *   且语义正确**(已驯服 / 未驯服 / 幂等 / 只读)。
 *
 * ## 判据(逐条对应任务书)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 驯服成功 ⇒ `tameOwnerOf` 读到主人 | 驯服不记 `ownerId` / 查询读错键 |
 * | 2 | 同一只被**第二个人**驯服 ⇒ 明确拒绝且主人不变 | TAME 里删掉「已有主人 ⇒ 拒绝」 |
 * | 3 | 喂食 / 繁殖**不改变**归属 | 喂食或繁殖顺手改 `ownerId` |
 * | 4 | 已被驯服的宠物被**他人**再驯服 ⇒ 拒绝 | 同上(第二次驯服覆盖 `ownerId`) |
 * | 5 | 查询返回**副本**(改返回值不改内部) | 查询直接返回内部对象/数组 |
 * | 6 | 未驯服 / 不存在 ⇒ `null`(**不是** `undefined`) | 用 `?.` 串到最后返回 `undefined` |
 * | 7 | 只读查询**无副作用**(两次相同、内部逐字段不变) | 查询走会 materialize 的 helper |
 *
 * ## 为什么**直调** handler,而不是 `assemble()`
 *
 * 任务书允许直调导出(不必真装配),而本套件的对象是**查询语义**,与房间权限/背包
 * 守恒无关 ⇒ 手工给出最小 `ActionContext`(见 `makeCtx`),只实现 handler 真正用到的
 * 那几个成员(`authorize` / `payload` / `state.roomId` / `actorId` / `applyInventory`)。
 * 与 `WS-FND-29-tame`(真装配、走 `rt.dispatchAction`)互补,不是替代。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { RoomAction, type ActionOutcome, type ActionPayload } from '../server/src/net/room.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { createRoomState } from '../server/src/net/schema.ts';
import { RoomStatus } from '../server/src/db/repo.ts';
import { tameableMobs } from '../shared/constants/mobs.ts';
import {
  AFFECTION_REQUIRED, breedTame, forgetRoom, petsOfRoom,
  tameOwnerOf, tamedPetsOfRoom,
} from '../server/src/net/actions/breed_tame.ts';

/** 测试用的食物:`123 黄金小麦`(冻结内容表里的谷物;注释里就写它是驯服食物)。 */
const FOOD = 123;

/** 内容层第 i 个可驯服生物的 id(名单不足 i+1 条时抛)。 */
function tameableId(i: number): string {
  const d = tameableMobs()[i];
  if (d === undefined) throw new Error(`内容层「可驯服生物」名单不足 ${i + 1} 条`);
  return d.id;
}
const MOB_A = tameableId(0);
const MOB_B = tameableId(1);

/** 一个玩家的背包(只用来判「扣 1 件」够不够,不做守恒)。 */
type Bag = Map<number, number>;

/**
 * 最小 `ActionContext` —— **只**实现 `breedTame` 真正会碰的成员。
 *
 * 其余成员照接口给不触发的桩:它们从不被 `breed_tame.ts` 调到(那是别的动作的路径),
 * 写在这里只是为了让对象**结构化满足** `ActionContext`(不 cast,类型检查是真的)。
 */
function makeCtx(
  roomId: string,
  actorId: string,
  payload: Record<string, unknown>,
  bag: Bag,
): ActionContext {
  return {
    actorId,
    action: RoomAction.BREED_TAME,
    payload: payload as ActionPayload,
    state: createRoomState(roomId),
    host: null,
    status: RoomStatus.OPEN,
    authorize: () => ({ allowed: true }),
    classifyFailure: () => ({ ok: false, kind: 'INVALID' as const, reason: 'test-stub' }),
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: (_userId, input) => {
      /* 只有「扣 1 件」这一步会走到这里 ⇒ 按「够不够」判成败即可。 */
      for (const op of input.ops) {
        if (op.delta < 0 && (bag.get(op.itemId) ?? 0) + op.delta < 0) {
          return { allowed: false, afterTotal: bag.get(op.itemId) ?? 0, rejectCode: 'ITEM_NEGATIVE' };
        }
      }
      for (const op of input.ops) bag.set(op.itemId, (bag.get(op.itemId) ?? 0) + op.delta);
      let afterTotal = 0;
      for (const n of bag.values()) afterTotal += n;
      return { allowed: true, afterTotal };
    },
    grantItemSource: () => {},
    setMemberRole: () => ({ ok: false }),
    kick: () => ({ ok: false }),
    setAccess: () => ({ ok: false }),
    setPartyModeBy: () => ({ ok: false }),
    close: () => false,
  };
}

const feed = (roomId: string, actor: string, petId: string, mobId: string, bag: Bag): ActionOutcome =>
  breedTame(makeCtx(roomId, actor, { op: 'FEED', petId, mobId, itemId: FOOD }, bag));
const tame = (roomId: string, actor: string, petId: string, bag: Bag): ActionOutcome =>
  breedTame(makeCtx(roomId, actor, { op: 'TAME', petId }, bag));
const breed = (roomId: string, actor: string, petId: string, mateId: string, bag: Bag): ActionOutcome =>
  breedTame(makeCtx(roomId, actor, { op: 'BREED', petId, mateId }, bag));

/** 喂到达标(AFFECTION_REQUIRED 次);任一口失败即在前置上失败。 */
function feedToTame(roomId: string, actor: string, petId: string, mobId: string, bag: Bag): void {
  for (let i = 0; i < AFFECTION_REQUIRED; i += 1) {
    const r = feed(roomId, actor, petId, mobId, bag);
    ok(r.ok, `前置:喂 ${petId} 第 ${i + 1} 口应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  }
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND41-1 驯服成功 ⇒ tameOwnerOf 读到主人(世界侧那一行的数据源)', () => {
  const roomId = 'r_41_1';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 3]]);
  eq(tameOwnerOf(roomId, 'pet:a'), null, '前置:还没记录 ⇒ null');

  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  const r = tame(roomId, 'p1', 'pet:a', bag);
  eq(r.ok, true, `达标后驯服应成功(kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', '成功路径必须是 OK');
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 查询读到的就是主人(投影层要的就是这个值)');
  eq(tamedPetsOfRoom(roomId), [{ petId: 'pet:a', ownerId: 'p1' }], '★ 批量查询同样列出这一条');
  forgetRoom(roomId);
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND41-2 同一只宠物被第二个人驯服 ⇒ 明确拒绝,主人不变', () => {
  const roomId = 'r_41_2';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 3]]);
  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  eq(tame(roomId, 'p1', 'pet:a', bag).ok, true, '前置:p1 驯服成功');
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '前置:主人是 p1');

  const again = tame(roomId, 'p2', 'pet:a', bag);
  eq(again.ok, false, '★ 第二个人不能驯服已达标的同一只宠物');
  eq(again.kind, 'INVALID', '应归为 INVALID(状态不对,不是权限)');
  ok(typeof again.reason === 'string' && again.reason.length > 0, '拒绝必须带原因');
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 主人**没被**覆盖(静默改主是最坏的失败)');
  eq(tamedPetsOfRoom(roomId), [{ petId: 'pet:a', ownerId: 'p1' }], '★ 批量查询里也只有 p1 这一条');
  forgetRoom(roomId);
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND41-3 喂食 / 繁殖**不改变**归属', () => {
  const roomId = 'r_41_3';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 8]]);
  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  eq(tame(roomId, 'p1', 'pet:a', bag).ok, true, '前置:驯服 pet:a');
  feedToTame(roomId, 'p1', 'pet:b', MOB_B, bag);
  eq(tame(roomId, 'p1', 'pet:b', bag).ok, true, '前置:驯服 pet:b');
  const ownersBefore = tamedPetsOfRoom(roomId);
  eq(ownersBefore, [{ petId: 'pet:a', ownerId: 'p1' }, { petId: 'pet:b', ownerId: 'p1' }],
    '前置:两只都归 p1');

  /* 再喂一口(主人是自己 ⇒ 允许)⇒ 归属必须原样。 */
  eq(feed(roomId, 'p1', 'pet:a', MOB_A, bag).ok, true, '前置:已驯服的宠物再喂一口应成功');
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 喂食**不**改归属');

  /* 繁殖 ⇒ 归属必须原样(繁殖只登记记录,不动 owner)。 */
  const b = breed(roomId, 'p1', 'pet:a', 'pet:b', bag);
  eq(b.ok, true, `前置:繁殖应成功(kind=${b.kind} reason=${b.reason ?? '-'})`);
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 繁殖后 pet:a 归属不变');
  eq(tameOwnerOf(roomId, 'pet:b'), 'p1', '★ 繁殖后 pet:b 归属不变');
  eq(tamedPetsOfRoom(roomId), ownersBefore, '★ 归属清单与喂食/繁殖前逐字段一致');
  forgetRoom(roomId);
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND41-4 已被驯服的宠物被**他人**再驯服 ⇒ 拒绝(主人恒为第一个驯服者)', () => {
  const roomId = 'r_41_4';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 3]]);
  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  eq(tame(roomId, 'p1', 'pet:a', bag).ok, true, '前置:p1 先驯服');

  /* 他人**两次**尝试都被拒 —— 是「一直拒绝」,不是「只有第一次拒」。 */
  for (let i = 0; i < 2; i += 1) {
    const r = tame(roomId, 'p2', 'pet:a', bag);
    eq(r.ok, false, `★ p2 第 ${i + 1} 次再驯服必须被拒`);
    eq(r.kind, 'INVALID', '应是 INVALID');
  }
  /* 先驯服者本人再驯一次也被拒:状态是「已有主人」,与是谁无关。 */
  const self = tame(roomId, 'p1', 'pet:a', bag);
  eq(self.ok, false, '★ 同一主人重复驯服同样拒绝(不静默成功)');
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 主人始终是第一个驯服者 p1');
  eq(tamedPetsOfRoom(roomId).length, 1, '★ 同一只宠物永远只有一条归属记录');
  forgetRoom(roomId);
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND41-5 查询返回**副本**:改返回值不影响内部', () => {
  const roomId = 'r_41_5';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 3]]);
  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  eq(tame(roomId, 'p1', 'pet:a', bag).ok, true, '前置:驯服');

  const snap = tamedPetsOfRoom(roomId);
  eq(snap.length, 1, '前置:一条归属');
  /* 破坏性地改返回的数组与元素。 */
  snap[0].ownerId = 'HACK';
  snap.push({ petId: 'pet:evil', ownerId: 'HACK' });
  eq(snap.length, 2, '前置:返回数组确实可写(证明它是一份真副本,不是只读引用)');

  /* 内部必须毫发无伤。 */
  eq(tameOwnerOf(roomId, 'pet:a'), 'p1', '★ 改元素不回写内部归属');
  eq(tamedPetsOfRoom(roomId), [{ petId: 'pet:a', ownerId: 'p1' }], '★ 重新查询仍是原始快照');
  eq(tameOwnerOf(roomId, 'pet:evil'), null, '★ 往返回数组里塞的假宠物不存在');
  eq(typeof tameOwnerOf(roomId, 'pet:a'), 'string', '★ 单查返回基本类型(外部无从改写)');
  forgetRoom(roomId);
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND41-6 未驯服 / 不存在 ⇒ null(**不是** undefined)', () => {
  const roomId = 'r_41_6';
  forgetRoom(roomId);
  const bag: Bag = new Map([[FOOD, 3]]);

  /* (a) 房间里压根没有这条记录。 */
  const none = tameOwnerOf(roomId, 'pet:ghost');
  eq(none, null, '★ 没有记录 ⇒ null');
  eq(none === undefined, false, '★ 绝不能是 undefined(否则调用方无法区分「未驯服」与「查错」)');

  /* (b) 有记录但还没驯服(喂了一口,好感 1/3)。 */
  eq(feed(roomId, 'p1', 'pet:a', MOB_A, bag).ok, true, '前置:喂一口');
  const untamed = tameOwnerOf(roomId, 'pet:a');
  eq(untamed, null, '★ 有记录但无主 ⇒ null');
  eq(untamed === undefined, false, '★ 同样不是 undefined');
  eq(tamedPetsOfRoom(roomId), [], '★ 未驯服的宠物不出现在有主清单里');
  forgetRoom(roomId);
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND41-7 只读查询**无副作用**(两次相同、内部逐字段不变)', () => {
  const roomId = 'r_41_7';
  forgetRoom(roomId);
  /* 4 件:pet:a 喂满 3 口 + pet:b 一口(不进其驯服流程,只为留下「有记录但无主」)。 */
  const bag: Bag = new Map([[FOOD, 4]]);
  feedToTame(roomId, 'p1', 'pet:a', MOB_A, bag);
  eq(tame(roomId, 'p1', 'pet:a', bag).ok, true, '前置:驯服 pet:a');
  /* 一只「有记录但未驯服」的宠物一起入镜 —— 它的字段最容易被查询顺手改。 */
  eq(feed(roomId, 'p1', 'pet:b', MOB_B, bag).ok, true, '前置:pet:b 未驯服');

  const before = petsOfRoom(roomId);
  const a1 = tameOwnerOf(roomId, 'pet:a');
  const b1 = tameOwnerOf(roomId, 'pet:b');
  const list1 = tamedPetsOfRoom(roomId);
  const a2 = tameOwnerOf(roomId, 'pet:a');
  const b2 = tameOwnerOf(roomId, 'pet:b');
  const list2 = tamedPetsOfRoom(roomId);

  eq(a1, 'p1', '★ 第一次查 pet:a ⇒ p1');
  eq(a2, a1, '★ 同一查询两次结果相同(幂等 / 不消费登记)');
  eq(b1, null, '★ pet:b 未驯服 ⇒ null');
  eq(b2, b1, '★ 未驯服同样幂等');
  eq(list2, list1, '★ 批量查询两次结构相同');
  eq(petsOfRoom(roomId), before, '★ 内部逐字段不变(查询没有回写)');

  /* 对**不存在**的房间问也不留痕:不能因为问一次就 materialize 出一份空登记。 */
  const ghost = 'r_41_7_ghost';
  forgetRoom(ghost);
  eq(tameOwnerOf(ghost, 'x'), null, '不存在的房间 ⇒ null');
  eq(tamedPetsOfRoom(ghost), [], '不存在的房间 ⇒ 空清单');
  eq(petsOfRoom(ghost), [], '★ 查询**没有**创建空登记(不 materialize)');
  forgetRoom(ghost);
  forgetRoom(roomId);
});

report('WS-FND-41');
