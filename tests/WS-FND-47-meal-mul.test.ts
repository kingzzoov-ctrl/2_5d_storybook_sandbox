/**
 * WS-FND-47 —— **大餐乘区**(`CANTEEN_MEAL_MUL`)的判据。
 *
 * 运行:`node tests/WS-FND-47-meal-mul.test.ts`
 *
 * ## 这个套件要钉的是什么
 *
 * `server/src/rooms/effects.ts` 的 `stepRoomEffects` 会算一个 `mealMul`
 * (手册 §3.8【欢聚大锅食堂】:「Boss 战前全团 **+40%** 攻击/生命上限大餐」)。
 * 但**算出来 ≠ 用上**:
 *
 * ```
 * 触发条件是「在食堂 **且** 带着料理 buff」——
 * 后半条在本函数**之外**(它不该 import cooking.ts),
 * 只能由调用方喂进来(`RoomEffectInput.hasMealBuff`)。
 * 调用方不传 ⇒ undefined ⇒ 乘区恒 1.0,**而且不报错**(静默失效)。
 * ```
 *
 * ⇒ 四条分支(食堂×buff / 食堂×空手 / 别处×buff / **漏传**)各钉一条,
 * 再核它**不打扰**既有效果(卧室回血、温泉上限),以及它是**每帧派生**的。
 *
 * ## 断言口径(为什么右侧全是字面量)
 *
 * 右侧**不** import `CANTEEN_MEAL_MUL` / `BEDROOM_HEAL_PER_SEC` / `ONSEN_MAX_HP_MUL`
 * 这些实现常量 —— 拿被测模块的常量核被测模块的行为是同义反复
 * (`scripts/verify.ts` 的 `--strict-taut` 判它"自证"):把 1.4 改成 1.0,
 * 断言会跟着一起变绿,一条都不红。这里的数字全部来自**手册字面量**。
 */

import { eq, ok, report, test } from '../shared/testing/harness.ts';

import { ROOM_RECIPES } from '../shared/constants/bosses.ts';
import {
  createRoomEffectState,
  maxHpMulOf,
  stepRoomEffects,
  type RoomEffectInput,
} from '../server/src/rooms/effects.ts';

/**
 * 手册 §3.8 的字面量锚点:+40% ⇒ `1.4`。
 *
 * 全文件 `1.4` **只出现在这里一次**(FND47-1 里当场锚一次),其余断言引用本常量 ——
 * 免得 `1.4` 散落各处,将来手抖写成 `1.3` 时断言自己成了噪声源。
 */
const MEAL_MUL_MANUAL = 1.4;

/**
 * 造一帧输入。`hasMealBuff` **不传时字段真的不存在**
 * (不是传 `undefined`):FND47-4 要的正是"漏传"这个形态。
 */
function frame(roomKey: string | null, dt: number, hasMealBuff?: boolean): RoomEffectInput {
  return hasMealBuff === undefined
    ? { roomKey, dt }
    : { roomKey, dt, hasMealBuff };
}

/* ═══════════ 1. 乘区的四条分支 ═══════════ */

test('FND47-1 食堂 **且** 带料理 buff ⇒ 1.4(手册 §3.8 的 +40%)', () => {
  /* 出处:手册 §3.8【欢聚大锅食堂】「Boss 战前全团 +40% 攻击/生命上限大餐」。
     变红条件:实现把触发条件写丢 —— 只看房间、只看 buff、或压根恒 1.0。 */
  eq(MEAL_MUL_MANUAL, 1.4, '锚:本文件里 1.4 只此一处(手册 +40% 的字面量)');

  const eat = stepRoomEffects(createRoomEffectState(), frame('COZY_CANTEEN', 0.5, true));
  eq(eat.mealMul, MEAL_MUL_MANUAL, '食堂 + 带料理 buff ⇒ 大餐乘区生效');
  /* 状态里要留下"在食堂"—— 它是下一帧 `st` 的一部分,不能被乘区吃掉 */
  eq(eat.state.inCanteen, true, '状态里应记下"在食堂"');
});

test('FND47-2 食堂 + 空手 ⇒ 1.0(手册说的是「大餐」,不是「站进去就送」)', () => {
  /* 变红条件:只要 `roomKey === 'COZY_CANTEEN'` 就给 +40% ⇒
     玩家空手站在食堂里白拿 —— 那与手册「大餐」是**两条**规则。 */
  const empty = stepRoomEffects(createRoomEffectState(), frame('COZY_CANTEEN', 0.5, false));
  eq(empty.mealMul, 1.0, '★ 不带料理 buff ⇒ 空手站在食堂里**不给** +40%');
  eq(empty.state.inCanteen, true, '他确实在食堂里 —— 乘区照样是 1.0');
});

test('FND47-3 非食堂 + 带 buff ⇒ 1.0(对着冻结层的 9 种房间逐一核)', () => {
  /* 变红条件:乘区被写成"带 buff 就给"(漏掉房间条件)⇒ 全地图 +40%。 */
  for (const r of ROOM_RECIPES) {
    if (r.key === 'COZY_CANTEEN') continue;
    const one = stepRoomEffects(createRoomEffectState(), frame(r.key, 0.5, true));
    eq(one.mealMul, 1.0, `房间 ${r.key} 不是食堂 ⇒ 乘区不生效(带 buff 也一样)`);
  }
  /* 房外同样不生效(负对照:不能靠"没有房间 key"蒙对) */
  const nowhere = stepRoomEffects(createRoomEffectState(), frame(null, 0.5, true));
  eq(nowhere.mealMul, 1.0, '不在任何房间 ⇒ 乘区不生效');
});

test('FND47-4 ★ 漏传 hasMealBuff ⇒ 1.0(这是"漏传"的**显式后果**)', () => {
  /* 变红条件(两种方向都要红):
       1 实现把"不传"当真值 ⇒ 漏传的调用方**静默**白拿 +40%(最坏形态);
       2 有人删掉这一条 ⇒ "漏传的后果"重新变成没有判据的事实。
     ⚠️ 断言的是**后果**,不是鼓励不传 —— 调用方必须传,见 effects.ts 文件头。 */
  const forgotten = stepRoomEffects(createRoomEffectState(), { roomKey: 'COZY_CANTEEN', dt: 0.5 });
  eq(forgotten.mealMul, 1.0, '★ 漏传 = 按"没有 buff"处理 ⇒ 乘区恒 1.0(且**不抛错**)');

  /* 与显式传 `false` **逐字段等价** —— "漏传"与"没有 buff"在实现里是同一件事。
     这一条同时说明:它不是"默认给个慷慨的缺省值",而是"缺省即无"。 */
  const explicitFalse = stepRoomEffects(
    createRoomEffectState(),
    { roomKey: 'COZY_CANTEEN', dt: 0.5, hasMealBuff: false },
  );
  eq(forgotten, explicitFalse, '漏传 与 显式 false 必须逐字段相同');
});

/* ═══════════ 2. 接上乘区不能改坏既有效果 ═══════════ */

test('FND47-5 与既有效果并存:逐字段核(回血 / 打盹 / 上限 / 锻造一个不动)', () => {
  /* 变红条件:为了暴露 `mealMul` 而动了 `healHp` / `maxHpMul` / `napping` /
     `forgeUnlocked` —— 那是**回归**,不是新功能。 */
  const bed = stepRoomEffects(createRoomEffectState(), frame('COZY_BEDROOM', 0.5, true));
  eq(bed.healHp, 7.5, '卧室回血 = 15 HP/s × 0.5s(手册:每秒 15 HP)');
  eq(bed.napping, true, '卧室打盹不受乘区影响');
  eq(bed.maxHpMul, 1.0, '不在温泉 ⇒ 上限倍率 1.0');
  eq(bed.forgeUnlocked, false, '不在锻造房 ⇒ 不解锁锻造');
  eq(bed.mealMul, 1.0, '不在食堂 ⇒ 乘区 1.0(带着 buff 也一样)');

  const onsen = stepRoomEffects(createRoomEffectState(), frame('SAKURA_ONSEN', 0.5, true));
  eq(onsen.maxHpMul, 1.3, '温泉上限 ×1.3(手册:+30%)');
  eq(maxHpMulOf(onsen.state), 1.3, '查询口与推进口同源(同一个数)');
  eq(onsen.mealMul, 1.0, '温泉不叠加乘区');

  /* 食堂里那一帧:只有 `mealMul` 被点亮,其余四项与"不在任何房间"完全一致 */
  const eat = stepRoomEffects(createRoomEffectState(), frame('COZY_CANTEEN', 0.5, true));
  const none = stepRoomEffects(createRoomEffectState(), frame(null, 0.5, true));
  eq(eat.healHp, none.healHp, '食堂不回血(与房外同值)');
  eq(eat.napping, none.napping, '食堂不打盹(与房外同值)');
  eq(eat.maxHpMul, none.maxHpMul, '食堂不加上限 —— 乘区是**另一个**字段');
  eq(eat.forgeUnlocked, none.forgeUnlocked, '食堂不解锁锻造(与房外同值)');
  eq(eat.healHp, 0, '食堂回血应为 0');
  eq(eat.maxHpMul, 1.0, '食堂上限倍率应为 1.0');
  ok(eat.mealMul !== none.mealMul, '唯一被点亮的差异就是乘区');
});

/* ═══════════ 3. 纯函数性 / 脏输入 / 撤销 ═══════════ */

test('FND47-6 纯函数:同输入两次同输出,且不改入参、不改传入的状态', () => {
  /* 变红条件:乘区读到隐藏全局(时钟 / 随机 / 最后一帧缓存)⇒
     同一输入两次给不同的数,世界侧记账会漂。 */
  const st = createRoomEffectState();
  const stBefore = { ...st };
  const input = Object.freeze({ roomKey: 'COZY_CANTEEN', dt: 0.5, hasMealBuff: true });

  const a = stepRoomEffects(st, input);
  const b = stepRoomEffects(st, input);
  eq(a, b, '相同输入两次调用,结果应逐字段一致');
  eq(a.mealMul, MEAL_MUL_MANUAL, '两次都应是 1.4');
  eq({ ...input }, { roomKey: 'COZY_CANTEEN', dt: 0.5, hasMealBuff: true }, '入参应原样(未被改写)');
  eq(st, stBefore, '传入的状态不得被就地修改');
  ok(a.state !== st, '应返回**新**状态对象,而不是复用入参那个');
});

test('FND47-7 hasMealBuff 传非布尔 ⇒ 按"没有 buff"处理(不抛错)', () => {
  /* 变红条件:实现写成 `input.hasMealBuff ? … : …`(truthy 判定)⇒
     `1` / `'yes'` / `{}` 全都会给 +40% —— 字段类型漂了却没有任何判据。 */
  const dirty: unknown[] = [1, 0, 2, -1, 'yes', '', 'false', null, {}, [], NaN];
  for (const v of dirty) {
    const r = stepRoomEffects(
      createRoomEffectState(),
      { roomKey: 'COZY_CANTEEN', dt: 0.5, hasMealBuff: v as boolean },
    );
    eq(r.mealMul, 1.0, `非布尔 ${String(v)} 应按"没有 buff"处理(不抛错)`);
  }
  /* 唯一被认作"有 buff"的值就是 `true` 本身 */
  const onlyTrue = stepRoomEffects(
    createRoomEffectState(),
    { roomKey: 'COZY_CANTEEN', dt: 0.5, hasMealBuff: true },
  );
  eq(onlyTrue.mealMul, MEAL_MUL_MANUAL, '只有 true 触发乘区');
});

test('FND47-8 离开食堂即撤销:乘区是**每帧派生**,不是"进过一次永久生效"', () => {
  /* 变红条件:把乘区做成一次性解锁(写进 state 再读回来)⇒
     吃过大餐后走到地图任何角落都 +40%。这是房间效果与一次性解锁的本质区别。 */
  const inside = stepRoomEffects(createRoomEffectState(), frame('COZY_CANTEEN', 0.5, true));
  eq(inside.mealMul, MEAL_MUL_MANUAL, '在食堂 + 带 buff ⇒ 生效');

  const outside = stepRoomEffects(inside.state, frame(null, 0.5, true));
  eq(outside.mealMul, 1.0, '走出食堂 ⇒ 当场撤销(buff 还在身上)');

  const expired = stepRoomEffects(inside.state, frame('COZY_CANTEEN', 0.5, false));
  eq(expired.mealMul, 1.0, 'buff 到期 ⇒ 仍站在食堂里也一样撤销');
});

report('WS-FND-47');