/**
 * WS-FND-25 —— **通用合成**(`CRAFT`)。
 *
 * ## 这个套件为什么存在
 *
 * `docs/TASK-96-action-landing-gaps.md` 第三节记的缺口原文:
 * ``` » `cooking.ts` 有 `cookSoup`(料理站),但**通用合成**没有入口:
 *    缺「配方 → 材料扣减 → 产物」的事务性写入 «
 * ```
 * 接线前 `CRAFT` 回 `NOT_IMPLEMENTED`,于是「游戏内真的能合成」在线上不存在:
 * 配方只在客户端 `recipe_tree.ts` 里算得出来,服务端**一件材料都不会扣**。
 *
 * ## 本套件钉的是**事务**,不是"回了 OK"
 *
 * 一次合成同时动两处:材料(-N)与产物(+M),而它们都在**同一条**权威路径
 * (`applyInventory`:总量守恒 + 凭证链)上。故每条断言都要求两侧同时成立 ——
 * 只验一侧会漏掉本仓记过的那类缺陷("扣了材料没给产物" / "凭空产出" /
 * "产物收不下就把材料吞了")。
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 材料够 ⇒ 成功;材料 -N、产物 +1,`effect.consumed` 可见明细 | 去掉扣减那次 `applyInventory` / 扣减不走权威路径 |
 * | 2 | 材料不够 ⇒ `INVALID` **且背包一点没动** | 先扣材料再查配方(半步事务) |
 * | 3 | 产物收不下(容量)⇒ 材料**退回**,背包回到合成前 | 去掉 `craft-refund` 分支 |
 * | 4 | 不存在的产物 id / 无配方产物 ⇒ `INVALID` | 不查内容表就照 `have` 扣 |
 * | 5 | 越权(GUEST)⇒ `PERMISSION` 且背包不动 | 去掉处理器里的 `authorize` |
 * | 6 | `#245` 用 **103/126 + 任一染料(168)** 合成成功(CR-17 留白槽) | 把留白槽硬编回 166 |
 * | 7 | 客户端自报明细**不能**凭空造物(总量不够 ⇒ 扣减整批被拒) | 扣减绕开 `applyInventory` |
 * | 8 | 产出件数取内容层 `output`(`151` = 1 材料 → 2 件) | 写死 `+1` |
 *
 * ⚠️ 夹具照 `tests/WS-FND-20-material-loop.test.ts`:真装配(`assemble()`)+
 *   `rt.grantItemSource` / `rt.applyInventory` 做前置(不走后门改总量),
 *   权威读数用 `RoomRuntime.authoritativeItemTotal` / `carryCapacityOf`。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionOutcome } from '../server/src/net/room.ts';
import { matchRecipeByTags } from '../shared/constants/items.ts';

/** 一次合成的回执摘要(`effect` 的声明值类型只有基本类型 ⇒ 这里显式窄化读明细)。 */
type CraftEffect = { itemId: number; produced: number; consumed: Record<number, number> };

type Room = { rt: ReturnType<typeof assemble>['runtime'] };

/** 真装配:生产入口 `assemble()`(不手搓 rtOpts —— 那会绕开 `assemble()`)。 */
function makeRoom(asGuest = false): Room {
  const a = assemble({
    roomId: 'r_craft',
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: 24,
    /* 本套件只测合成,不想让自发改刷的怪参与(它们会让失败信息难以归因)。 */
    mobs: false,
    rng: mulberry32(11),
  });
  a.runtime.join({ userId: 'p1', asGuest });
  /* ★ WS-FND-155:入场会发起始背包(7 件,占容量)⇒ 本套件的判据以「空背包」为前提,先清掉。 */
  for (const id of a.runtime.authoritativeItemIds('p1')) a.runtime.applyInventory('p1', { ops: [{ itemId: id, delta: -a.runtime.authoritativeItemCount('p1', id) }] });
  /* ★ D-11(2026-11-16):本套件的样例 `#245` 是 **505 高级锻造台**出的件 ⇒ 按裁决,
     未解锁时 `CRAFT` 必须拒。所以夹具要把"已解锁"这个事实**如实**建立起来:
     解锁的唯一产出点是 room effects(`stepRoomEffects`),这里推一慢帧建记录,再置真
     —— 不另造第二个开关(那样就成了两份实现)。 */
  const sim = a.host as unknown as {
    advance(n: number): void;
    roomEffectOf(id: string): { inForge: boolean } | null;
  };
  sim.advance(60);
  const roomState = sim.roomEffectOf('p1');
  if (roomState !== null) roomState.inForge = true;
  return { rt: a.runtime };
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

/** 权威总量(房间的方法,不是 host —— `host` 没有这个读数)。 */
const total = (rt: Room['rt']): number => rt.authoritativeItemTotal('p1');

const disp = (rt: Room['rt'], payload: Record<string, unknown>): ActionOutcome =>
  rt.dispatchAction('p1', RoomAction.CRAFT, payload);

/** 取出成功回执的 `effect`;顺手钉住「OK 必须带 effect」。 */
function effectOf(r: ActionOutcome, label: string): CraftEffect {
  ok(r.ok, `${label}:应成功(实测 kind=${r.kind} reason=${r.reason ?? '-'})`);
  eq(r.kind, 'OK', `${label}:成功路径必须是 OK`);
  const e = r.effect as unknown as CraftEffect | undefined;
  ok(e !== undefined, `${label}:★ \`OK\` 必须带 effect(不留"回 OK 却无副作用")`);
  return e as CraftEffect;
}

/* ───────────────────────── 1 ───────────────────────── */

test('FND25-1 材料够 ⇒ 成功:材料 -N、产物 +1(两侧都走权威路径)', () => {
  const { rt } = makeRoom();
  /* #245 手持庆典烟花筒 = 103 翠玉青竹×1 + 126 爆裂火椒×1 + 任意染料×1 */
  seed(rt, 103, 1);
  seed(rt, 126, 1);
  seed(rt, 166, 1);
  eq(total(rt), 3, '前置:背包 3 件(正好是这条配方的 3 件材料)');

  const eff = effectOf(disp(rt, { itemId: 245, have: { 103: 1, 126: 1, 166: 1 } }), '合成 #245');
  eq(eff.itemId, 245, 'effect 里带产物 id');
  eq(eff.produced, 1, '245 没有 output ⇒ 默认 1 件');
  eq(eff.consumed, { 103: 1, 126: 1, 166: 1 }, '★ effect 里能看到**扣了哪几件**');
  eq(total(rt), 1, '★ 两侧都对:3 件材料 -3、烟花筒 +1 ⇒ 总量 1');

  /* 材料**真的**离开了权威库存(不是只在回执里说说):同一份 have 再合成一次,
     权威总量只剩 1、不够再扣 3 件 ⇒ 扣减整批被反作弊拒。 */
  const again = disp(rt, { itemId: 245, have: { 103: 1, 126: 1, 166: 1 } });
  eq(again.ok, false, '第二份:材料已经不在背包里了');
  eq(again.kind, 'INVALID', '缺料应归为 INVALID(不是 PERMISSION)');
  eq(total(rt), 1, '★ 被拒时总量不动(扣减走的是 `applyInventory` 的守恒路)');
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND25-2 材料不够 ⇒ INVALID,且背包**一点没动**(半步事务的对照)', () => {
  const { rt } = makeRoom();
  seed(rt, 103, 1);
  seed(rt, 126, 1); /* 少一件染料 */
  eq(total(rt), 2, '前置:2 件材料');

  const r = disp(rt, { itemId: 245, have: { 103: 1, 126: 1 } });
  eq(r.ok, false, '缺料不能成功');
  eq(r.kind, 'INVALID', '★ 材料不足是 INVALID(参数/状态不对),不是 PERMISSION');
  ok(
    String(r.reason ?? '').includes('材料不足'),
    `拒绝原因应说清是材料不足(实测 ${r.reason ?? '-'})`,
  );
  eq(total(rt), 2,
    '★ 背包一点没动 —— 若"先扣材料、再校验配方",这里会只剩 0 件且玩家没拿到产物');
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND25-3 产物收不下(容量)⇒ 材料**退回**,背包回到合成前', () => {
  const { rt } = makeRoom();
  /* 容量来自等级(`carryCapacityOf`),不写死数字 —— 升级改动不会让这条失效。 */
  const cap = rt.carryCapacityOf('p1');
  seed(rt, 101, cap);
  eq(total(rt), cap, `前置:背包撑到容量边界(${cap} 件)`);

  /* #151 精刨松木板 = 101×1 → **2 件**(`output: 2`)⇒ 扣 1 件后总量 cap-1,
     再 +2 ⇒ cap+1 > cap ⇒ 反作弊按 ITEM_OVERFLOW 拒产物。 */
  const r = disp(rt, { itemId: 151, have: { 101: cap } });
  eq(r.ok, false, '收不下产物时不能"扣了材料就算成功"');
  eq(r.kind, 'INVALID', '容量不足是 INVALID');
  ok(String(r.reason ?? '').includes('退回'),
    `原因应说明材料已退回(实测 ${r.reason ?? '-'})`);
  eq(total(rt), cap,
    '★ 材料退回:背包回到合成前 —— 若退回路不存在,这里会是 cap-1(材料被吞了)');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND25-4 不存在的产物 id / 无配方产物 ⇒ INVALID(拒绝发生在消耗之前)', () => {
  const { rt } = makeRoom();
  seed(rt, 103, 1);
  eq(total(rt), 1, '前置:背包 1 件');

  const ghost = disp(rt, { itemId: 999999, have: { 103: 1 } });
  eq(ghost.ok, false, '不存在的物品 id 不能合成');
  eq(ghost.kind, 'INVALID', '应是 INVALID');
  ok(String(ghost.reason ?? '').includes('不在冻结内容表'),
    `原因应指出 id 不在内容表(实测 ${ghost.reason ?? '-'})`);

  /* 内容表里有、但**没有配方**的(101 暖松原木是自然采集)同样不是可合成产物。 */
  const raw = disp(rt, { itemId: 101, have: { 103: 1 } });
  eq(raw.ok, false, '无配方的物品不能"合成"');
  eq(raw.kind, 'INVALID', '应是 INVALID');

  eq(total(rt), 1, '★ 两次拒绝都没动背包(校验在消耗之前)');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND25-5 越权:GUEST 合成不了,分类是 PERMISSION 且背包不动', () => {
  const { rt } = makeRoom(true);
  seed(rt, 103, 1);
  seed(rt, 126, 1);
  seed(rt, 166, 1);
  eq(total(rt), 3, '前置:GUEST 背包里**真的**有齐料(否则测的就不是权限)');

  const r = disp(rt, { itemId: 245, have: { 103: 1, 126: 1, 166: 1 } });
  eq(r.ok, false, 'GUEST 不能合成');
  eq(r.kind, 'PERMISSION',
    '★ 必须归类为 PERMISSION(不是 INVALID —— 否则"越权"与"参数错"混成一个值)');
  eq(r.effect, undefined, '被拒时没有 effect');
  eq(total(rt), 3, '★ 被拒后背包一点没动(闸在消耗之前)');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND25-6 #245 真实样例:103/126 + 任一染料(168)合成成功', () => {
  const { rt } = makeRoom();
  /* 先钉「这条配方真的可达」:留白槽按 **tag** 判,167/168/169 都能顶替登记的 166
     (CR-17;客户端 `recipe_tree.ts` 与这里共用同一套判据)。 */
  const probe = matchRecipeByTags(245, { 103: 1, 126: 1, 168: 1 });
  eq(probe.ok, true, '★ 内容层实测:245 用 168 翡翠森林染料可满足(不是只能造出 166)');
  eq(probe.consumed, { 103: 1, 126: 1, 168: 1 }, '留白槽选中的是**背包里那件**染料');

  seed(rt, 103, 1);
  seed(rt, 126, 1);
  seed(rt, 168, 1);

  const eff = effectOf(disp(rt, { itemId: 245, have: { 103: 1, 126: 1, 168: 1 } }), '#245 真样例');
  eq(eff.itemId, 245, '产物是烟花筒');
  eq(eff.consumed, { 103: 1, 126: 1, 168: 1 }, '★ 扣的是 103/126/168(不是登记代表 166)');
  eq(total(rt), 1, '3 件材料 -3、烟花筒 +1 ⇒ 总量 1');
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND25-7 客户端自报明细**不能**凭空造物(总量不够 ⇒ 扣减整批被拒)', () => {
  const { rt } = makeRoom();
  seed(rt, 103, 1);
  seed(rt, 126, 1);
  eq(total(rt), 2, '前置:权威总量 2 件');

  /* `have` 谎称有 3 件(含一件背包里根本没有的 166)⇒ 配方判定会通过,
     但扣减整批要过权威总量:2-3 = -1 ⇒ 反作弊按 ITEM_NEGATIVE 整批拒。 */
  const r = disp(rt, { itemId: 245, have: { 103: 1, 126: 1, 166: 1 } });
  eq(r.ok, false, '★ 自报明细不能凭空造物');
  eq(r.kind, 'INVALID', '被守恒层拒绝 ⇒ INVALID');
  /* ★ 2026-11-17:文案变了 —— 同一条守恒闸现在报「材料不足:…(背包余量不足)」,
     原因从「扣减被拒」改成了指认**缺料**本身。判据(自报明细不能凭空造物)不变。 */
  ok(String(r.reason ?? '').includes('材料不足'),
    `原因应指出材料不足(实测 ${r.reason ?? '-'})`);
  eq(total(rt), 2, '★ 总量不动(扣了不存在的东西不可能成功)');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND25-8 产出件数取内容层 output(151 = 1 材料 → 2 件)', () => {
  const { rt } = makeRoom();
  seed(rt, 101, 1);
  const eff = effectOf(disp(rt, { itemId: 151, have: { 101: 1 } }), '#151 精刨松木板');
  eq(eff.produced, 2, '★ `output: 2` 必须生效(写死 +1 会红;它也是 FND25-3 溢出的成因)');
  eq(total(rt), 2, '1 件原木 -1、木板 +2 ⇒ 总量 2');
});

report('WS-FND-25');