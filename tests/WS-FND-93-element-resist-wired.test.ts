/**
 * WS-FND-93 —— **D4 玩家侧元素抗性的生产写入点**(把 `vitals.setElementResist` 接上)。
 *
 * ## 这个套件钉什么
 *
 * 修前实测(`docs/AUDIT-W34.md` P2-1/P2-2):抗性表在 `combat/vitals.ts` 里可写可读
 * (`setElementResist` / `elementResistOf`),读侧也早就接上(`applyHit` 的 `element`
 * 参数),但**写入侧生产调用点 = 0** ⇒ 元素抗性整条链是 **no-op**(不是错值)。
 *
 * 修法:`server/src/rooms/effects.ts` 新增
 *   · `ROOM_ELEMENT_RESIST`(房间 → 元素抗性的**数据来源**)、
 *   · `roomElementResistOf`(纯查询:`null` = 没有来源 ⇒ 必须清空)、
 *   · `pushRoomElementResist`(**唯一的推送口**:单点 / 可重入 / 有清空路径)。
 *
 * ## 抗性从哪来、值是哪来的(判据要写清,故写在这里)
 *
 * **来源**:房间效果(手册 §3.8 的动态房间),表在 `rooms/effects.ts`。
 * **值**:⚠️ **既有内容表里没有这个数**(逐处核过:`ROOM_RECIPES` 9 种房间的 bonus、
 * `FOOD_PARAM_SLOTS` 料理 6 槽、`items.ts` 的 248 星光卡林巴琴 + `ArmorDef`
 * 全都没有可结算的元素抗性字段)⇒ 按裁决口径登记一条**具名·待平衡**的默认
 * (`PENDING_ELEMENT_RESIST_MUL = 0.5`),元素归属(`FIRE`,灶火 / 热水 —— 按现行映射
 * `SAKURA_ONSEN → FIRE`)同样**待 owner 裁决**。
 * 列表/数值都不是平衡裁决;owner 给了真内容就替换 `ROOM_ELEMENT_RESIST` 里那一行。
 *
 * ## 生产调用点(世界编排层,本任务**不改**)
 *
 * 房间效果是**慢帧**产物,唯一调用点是 `server/src/sim/world_sim.ts` 的
 * `tickRoomEffects()`(逐玩家 `roomAtCell(...)` 定位房间之后)。FND93-6 用
 * `roomAtCell` 走的就是那条链的等价路径;接线见任务报告给出的「文件:行 + 2 行改法」。
 *
 * ## 断言纪律
 *
 * 右侧一律用**字面量**(12 / 6 / 0.5 / 1 / 2),不取被测模块的导出常量 ——
 * 期望值取自被测模块就是同义反复。每条判据都有**负对照**,且逐条做了**注入验证**
 * (见文件末「注入验证」一节)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { VitalsSystem } from '../server/src/combat/vitals.ts';
import { ELEMENTS, type Element } from '../server/src/combat/weapons.ts';
import {
  ROOM_EFFECT_DECISION,
  ROOM_ELEMENT_RESIST,
  roomElementResistOf,
  pushRoomElementResist,
  roomAtCell,
} from '../server/src/rooms/effects.ts';

/** 4 级生物的基础伤害 = 6 + 2×(4−1) = 12(与 `WS-FND-71` FND71-9 同一算式,写死)。 */
const BASE_HIT_12 = 12;

/* ═════════════════ FND93-1 生产写入:减半 ═════════════════ */

test('FND93-1 ★★ D4 生产写入:站进温泉 ⇒ 抗性真的落到 vitals,同一次 FIRE 伤害减半', () => {
  const v = new VitalsSystem();
  v.register('p1');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, BASE_HIT_12, '基线:没推抗性 ⇒ 12');

  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '★ 推送必须被接受');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 抗性真的进了 vitals(0.5)—— 修前这里恒 1.0');

  const hit = v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE');
  eq(hit.rawBeforeResist, BASE_HIT_12, '折算前仍是 12');
  eq(hit.resistMul, 0.5, '★ 本次结算读到的系数是 0.5(不是默认的 1.0)');
  eq(hit.rawDamage, 6, '★★ 同一次 FIRE 伤害 12 × 0.5 = 6(修前:写入侧零调用 ⇒ 恒 12)');
});

/* ═════════════════ FND93-2 不串味 ═════════════════ */

test('FND93-2 ★ D4 不串味:只有登记的那个元素吃抗性;别的元素、别的玩家原样', () => {
  const v = new VitalsSystem();
  v.register('p1');
  v.register('p2');
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '前置:p1 进温泉馆');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '前置:p1 有 FIRE 抗性');

  /* 元素维度:没登记的元素一律原值(修前/修后都该是 12)。 */
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'ICE').rawDamage, BASE_HIT_12, '★ ICE 不吃 FIRE 抗性');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'LIGHTNING').rawDamage, BASE_HIT_12, '★ LIGHTNING 不吃');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'NONE').rawDamage, BASE_HIT_12, '★ 无属性攻击不吃');
  eq(v.elementResistOf('p1', 'ICE'), 1, '★ 相邻元素没被顺手写成 0.5(全程逐元素)');

  /* 玩家维度:抗性只落在被推送的那个玩家身上。 */
  eq(v.applyHit('m', 'p2', 4, 1.0, 0, 0, 'FIRE').rawDamage, BASE_HIT_12, '★ p2 没进房 ⇒ 原值');
  eq(v.elementResistOf('p2', 'FIRE'), 1, '★ p2 的抗性表是空的');
});

/* ═════════════════ FND93-3 清空路径 ═════════════════ */

test('FND93-3 ★★ D4 清空路径:走出房间(或房间没登记)⇒ 抗性撤销、伤害恢复 12', () => {
  const v = new VitalsSystem();
  v.register('p1');
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '前置:进房');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '前置:抗性在身');

  eq(pushRoomElementResist(v, 'p1', null), true, '★ 不在任何房间 ⇒ 推送仍成功(写的是中性值)');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★★ 离开房间 ⇒ 抗性被撤销(回到中性 1.0)—— 清空路径');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, BASE_HIT_12, '★★ 去掉来源后同一次 FIRE 伤害恢复 12');

  /* 负对照:未登记抗性的房间同样清空(不是「只有 `null` 才清」)。 */
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '前置:再进房');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '前置:抗性又回来了');
  eq(pushRoomElementResist(v, 'p1', 'ART_GALLERY'), true, '未登记抗性的房间 ⇒ 也是推中性值');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★ 站进别的房间也得撤销(不许顺手给所有房间加抗性)');
});

/* ═════════════════ FND93-4 非法值被拒 ═════════════════ */

test('FND93-4 ★★ D4 非法抗性被拒:NaN/Infinity 不写入、旧值不污染;推送如实上报拒绝', () => {
  const v = new VitalsSystem();
  v.register('p1');
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '前置:0.5 在身');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '前置:0.5 在身');

  eq(v.setElementResist('p1', 'FIRE', Number.NaN), false, '★ NaN 被拒(唯一守卫在 vitals)');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 被拒之后旧值不变');
  eq(v.setElementResist('p1', 'FIRE', Number.POSITIVE_INFINITY), false, '★ Infinity 同样被拒');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 旧值仍不变');
  eq(v.setElementResist('p1', 'FIRE', 99), true, '超上界 ⇒ 接受');
  eq(v.elementResistOf('p1', 'FIRE'), 2, '★ 夹到上界 2.0(不是 99)');

  /* 推送侧:表里出现非法值时**如实上报 false**,且不污染已写入的值。 */
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN'), true, '前置:复位到 0.5');
  const badTable = { SAKURA_ONSEN: { element: 'FIRE', mul: Number.NaN } };
  eq(pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN', badTable), false, '★★ 非法值 ⇒ 推送返回 false(拒绝可见,不是静默成功)');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★★ 非法值没有污染旧抗性');

  /* 生产表本身:每个值都要是 [0,2] 内的有限数(否则下游只会静默拒)。 */
  for (const [room, e] of Object.entries(ROOM_ELEMENT_RESIST)) {
    ok(Number.isFinite(e.mul) && e.mul >= 0 && e.mul <= 2, `★ 生产表 ${room} 的 mul 应为 [0,2] 内有限数(实得 ${String(e.mul)})`);
    ok(ELEMENTS.includes(e.element as Element), `★ 生产表 ${room} 的元素必须是元素表里的键(实得 ${e.element})`);
  }
});

/* ═════════════════ FND93-5 可重入 + 数据是唯一出处 ═════════════════ */

test('FND93-5 ★ D4 可重入幂等:连推不叠加;未登记房间一律无抗性(表是唯一出处)', () => {
  const v = new VitalsSystem();
  v.register('p1');
  pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN');
  pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN');
  pushRoomElementResist(v, 'p1', 'SAKURA_ONSEN');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 连推 3 次仍是 0.5(幂等;叠加的话会是 0.125)');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, 6, '★ 伤害仍是减半,没有越走越强');

  /* 覆盖性:9 种房间的登记里,**只有**登记过的那个给抗性,其余必须 null。 */
  const registered = new Set(Object.keys(ROOM_ELEMENT_RESIST));
  let uncheckedRooms = 0;
  for (const roomKey of Object.keys(ROOM_EFFECT_DECISION)) {
    if (registered.has(roomKey)) continue;
    eq(roomElementResistOf(roomKey), null, `★ ${roomKey} 没登记抗性 ⇒ null(不许顺手加)`);
    uncheckedRooms += 1;
  }
  ok(uncheckedRooms >= 4, `★ 应核到 4 种以上「无抗性」房间(实测 ${uncheckedRooms})`);
  eq(roomElementResistOf(null), null, '不在任何房间 ⇒ null');
  eq(roomElementResistOf('NOT_A_ROOM'), null, '不存在的房间 key ⇒ null(不是抛错)');
});

/* ═════════════════ FND93-6 来源链 ═════════════════ */

test('FND93-6 ★★ D4 来源链:房间定位(`roomAtCell`)→ 推送 —— 生产调用点的等价路径', () => {
  const v = new VitalsSystem();
  v.register('p1');
  /* `WorldSim.tickRoomEffects` 每慢帧做的事:按刚体坐标定位房间 → 推抗性。 */
  const rooms = [{ key: 'SAKURA_ONSEN', cells: [{ x: 5, y: 5 }, { x: 6, y: 5 }] }];
  const inside = roomAtCell(rooms, 5.5, 5.5);
  eq(inside, 'SAKURA_ONSEN', '前置:站在温泉格上');
  eq(pushRoomElementResist(v, 'p1', inside), true, '★ 按定位结果推送成功');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, 6, '★ 房内的 FIRE 伤害减半');

  const outside = roomAtCell(rooms, 20.5, 5.5);
  eq(outside, null, '前置:房外的格不属于任何房间');
  eq(pushRoomElementResist(v, 'p1', outside), true, '★ 房外推送成功(推中性值)');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★ 走出房 ⇒ 撤销(同一条链的两个方向都判)');
});

report('WS-FND-93-element-resist-wired');

/*
 * ═════════════════ 注入验证(每条判据都能红,不是装饰)═════════════════
 *
 * 注入都打在 `server/src/rooms/effects.ts`(被测的生产代码)上,改完即跑本套件、
 * 跑完立刻还原(实测 `effects.ts` 复原后与注入前 sha 相同):
 *
 * | # | 注入 | 结果 |
 * | :--- | :--- | :--- |
 * | M1 | `PENDING_ELEMENT_RESIST_MUL` 0.5 → 0.9 | **0/6**(FND93-1 期望 0.5 实得 0.9;FND93-6 期望 6 实得 11) |
 * | M2 | 删掉清空路径(`if (!isSource) continue;`,不再写中性值) | **4/6**(FND93-3「离开房间 ⇒ 撤销」期望 1 实得 0.5;FND93-6 同) |
 * | M3 | 表里多登记一个房间 `ART_GALLERY`(顺手给所有房间加抗性) | **5/6**(FND93-5「核到 4 种无抗性房间」实得 3) |
 * | M4 | 元素写错(`FIRE` → `ICE`) | **0/6**(FND93-1/2/6 的 FIRE 伤害不再减半) |
 * | M5 | 抗性被当加值再乘一次(`src.mul * src.mul`) | **0/6**(FND93-1 期望 0.5 实得 0.25;FND93-5 幂等条红) |
 * | M6 | 吞掉拒绝(`sink.setElementResist(...)` 不看返回值) | **5/6**(FND93-4「非法值 ⇒ 推送返回 false」期望 false 实得 true) |
 */
