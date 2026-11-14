/**
 * WS-FND-17 —— **档 C 三项的判据**(9 种房间增益 / 料理 buff 消费点 / 三件死道具裁决)。
 *
 * ## 为什么单独一个套件
 *
 * 这三项此前在 `COMPLETION-CRITERIA.md` 的档 C 里是三个 `[ ]`,而它们的共同形状是:
 * **内容/识别都在跑,效果一条都没有** —— 门禁全绿,玩家什么都感觉不到。
 *
 * ```
 * 9 种房间   识别链路完整(`build/rooms.ts` 的 BFS + ROOM_RECIPES 评分),效果只实现了 3 种
 * 料理 buff  `cooking.ts` 的 FoodBuff 有 11 个 statMods 字段,合并函数 mergeFoodBuffs
 *            存在 —— 但**没有生产消费者**
 * 三件死道具 733/435/227 有定义、有配方、有手册说明,生产里零消费点
 * ```
 *
 * ⇒ 本套件把三件事各自钉成**可断言**的:
 * ```
 * 1 每种房间都有一条**决定**(覆盖性对着冻结层的 ROOM_RECIPES 核)
 * 2 料理 buff 的字段真的流到消费点(合并 → 大餐乘区)
 * 3 三件死道具仍在冻结内容表里,且「未实装」是**显式**的
 * ```
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';

import { ROOM_RECIPES } from '../shared/constants/bosses.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import {
  ROOM_EFFECT_DECISION,
  createRoomEffectState,
  maxHpMulOf,
  stepRoomEffects,
} from '../server/src/rooms/effects.ts';
import { mergeFoodBuffs, type FoodBuff } from '../server/src/combat/cooking.ts';
import { DEAD_ITEMS } from '../scripts/dead_items.ts';

/**
 * 造一个完整的 `FoodBuff`。**11 个 statMods 字段一个不少** ——
 * 少写字段会被 `Partial` 掩盖(而"哪几个字段真的被消费"正是本套件要问的问题)。
 */
const mkBuff = (over: Partial<FoodBuff['statMods']>, key = 'meal'): FoodBuff => ({
  key,
  sourceItemId: 601,
  branch: 'NORMAL',
  durationSec: 600,
  remainingSec: 600,
  stacks: 1,
  statMods: {
    atkMul: 1,
    hpFlat: 0,
    defFlat: 0,
    moveMul: 1,
    critRate: 0,
    critDmg: 1,
    gravityMul: 1,
    muOverride: 0,
    jumpMul: 1,
    gatherMul: 1,
    expMul: 1,
    ...over,
  },
  flags: {},
});

/* ═══════════ 1. 9 种房间:每一种都要有一条决定 ═══════════ */

test('FND17-1 冻结层的 9 种房间**每一种**都有裁决(加了第 10 种就红)', () => {
  /* 变红条件:手册/内容表新增一种房间,而 effects.ts 没给它一条决定
     —— 那正是「识别在跑、效果没有」的复发形态。 */
  eq(ROOM_RECIPES.length, 9, '冻结层的动态房间种类数(手册 §3.8)');
  const missing: string[] = [];
  const empty: string[] = [];
  for (const r of ROOM_RECIPES) {
    const d = ROOM_EFFECT_DECISION[r.key];
    if (d === undefined) missing.push(r.key);
    else if (d.purpose.trim().length === 0) empty.push(r.key);
  }
  eq(missing.join(','), '', `每种房间都必须有裁决,缺:${missing.join(',') || '无'}`);
  eq(empty.join(','), '', '裁决必须写明 purpose(空字符串等于没写)');
  /* 反过来:表里不许有内容表里不存在的 key(否则是死条目) */
  const keys = new Set<string>(ROOM_RECIPES.map((r) => r.key));
  const extra = Object.keys(ROOM_EFFECT_DECISION).filter((k) => !keys.has(k));
  eq(extra.join(','), '', `裁决表里有内容表不存在的 key:${extra.join(',') || '无'}`);
});

test('FND17-2 决定要**如实分类**:数值增益才叫 PLAYER_NUMERIC', () => {
  /* 变红条件:把"未实装的系统解锁"标成 PLAYER_NUMERIC 来充数
     —— 那是**过度声称**:读者会以为站进去就有数值。 */
  const kinds = Object.entries(ROOM_EFFECT_DECISION)
    .reduce<Record<string, number>>((acc, [, v]) => {
      acc[v.kind] = (acc[v.kind] ?? 0) + 1;
      return acc;
    }, {});
  eq(kinds['PLAYER_NUMERIC'], 4, '数值增益:锻造房 / 食堂 / 卧室 / 温泉');
  eq(kinds['DISPLAY_ONLY'], 1, '纯展示:画廊');
  eq(kinds['SYSTEM_UNLOCK'], 4, '系统解锁(仓库里还没有那些系统):牧场 / 炼金室 / 温室 / 百货店');
  /* 非数值的条目必须写明**缺什么**,而不是只写一句能力描述 */
  for (const [key, d] of Object.entries(ROOM_EFFECT_DECISION)) {
    if (d.kind === 'PLAYER_NUMERIC') continue;
    ok(/未实装|不产生玩家数值/.test(d.purpose), `${key} 的 purpose 应写明「未实装」或「不产生数值」`);
  }
});

/* ═══════════ 2. 料理 buff 的字段真的流到消费点 ═══════════ */

test('FND17-3 料理 buff 的 7 个关键字段经合并后**可达**(不是死字段)', () => {
  /* 变红条件:`mergeFoodBuffs` 丢掉字段,或字段名拼错 ⇒ 下游读不到。
     ⚠️ 这里问的是「字段有没有到」,不是「数值对不对」(那是 WS-10-E 的事)。 */
  const merged = mergeFoodBuffs([
    mkBuff({ atkMul: 1.4, hpFlat: 40, defFlat: 5, moveMul: 1.2 }, 'a'),
    mkBuff({ critRate: 0.1, critDmg: 1.5, expMul: 1.3 }, 'b'),
  ]);
  const expect7: Array<[string, number]> = [
    ['atkMul', 1.4], ['hpFlat', 40], ['defFlat', 5], ['moveMul', 1.2],
    ['critRate', 0.1], ['critDmg', 1.5], ['expMul', 1.3],
  ];
  for (const [k, v] of expect7) {
    const got = (merged as unknown as Record<string, number>)[k];
    ok(typeof got === 'number', `${k} 应出现在合并结果里(实测 ${String(got)})`);
    ok(Math.abs(got - v) < 1e-9, `${k} 应原样透传,期望 ${v} / 实测 ${got}`);
  }
});

test('FND17-4 ★ 大餐乘区:食堂 **且** 带料理 buff 才生效(空手站进去不给)', () => {
  /* 变红条件:
       1 只要站在食堂就给 +40% ⇒ 玩家空手白拿(与手册「大餐」不符);
       2 带了 buff 也不给 ⇒ 消费点没接上,**料理 buff 的字段又变成死数据**。 */
  const eat = stepRoomEffects(createRoomEffectState(), {
    roomKey: 'COZY_CANTEEN', dt: 0.05, hasMealBuff: true,
  });
  /* ⚠️ 断言写**手册字面量 1.4**,不写 `CANTEEN_MEAL_MUL`(实现的常量)——
     拿实现的常量核实现的行为会被同义反复检测器判为**自证**(实测抓到了这一条)。 */
  eq(eat.mealMul, 1.4, '食堂 + 带料理 buff ⇒ 大餐乘区生效(手册 1.4)');
  eq(eat.state.inCanteen, true, '状态里应记下"在食堂"');

  const empty = stepRoomEffects(createRoomEffectState(), {
    roomKey: 'COZY_CANTEEN', dt: 0.05, hasMealBuff: false,
  });
  eq(empty.mealMul, 1.0, '★ 空手站在食堂里**不给**(手册说的是大餐)');

  const away = stepRoomEffects(createRoomEffectState(), {
    roomKey: 'SAKURA_ONSEN', dt: 0.05, hasMealBuff: true,
  });
  eq(away.mealMul, 1.0, '不在食堂 ⇒ 不生效(带着 buff 也一样)');
});

test('FND17-5 卧室「打盹」与回血**同源**;温泉离场后倍率仍在(负对照)', () => {
  /* 变红条件:打盹与回血各判一次 ⇒ 两份实现迟早分叉(手册把两者写在同一句里)。 */
  const nap = stepRoomEffects(createRoomEffectState(), { roomKey: 'COZY_BEDROOM', dt: 0.5 });
  eq(nap.napping, true, '在卧室应进入打盹');
  ok(nap.healHp > 0, `在卧室应回血(实测 ${nap.healHp})`);
  const out = stepRoomEffects(createRoomEffectState(), { roomKey: null, dt: 0.5 });
  eq(out.napping, false, '不在卧室不该打盹');
  eq(out.healHp, 0, '不在卧室不该回血');

  /* 温泉:站着时重置为满时长;离开后**倍率仍在**(手册:泡完带走 20 分钟) */
  const soak = stepRoomEffects(createRoomEffectState(), { roomKey: 'SAKURA_ONSEN', dt: 0.05 });
  eq(maxHpMulOf(soak.state), 1.3, '站在温泉里应加上限');
  const after = stepRoomEffects(soak.state, { roomKey: null, dt: 60 });
  ok(after.state.onsenSec > 0, '离开 60 秒后剩余时长仍应 > 0');
  eq(after.maxHpMul, 1.3, '离开后倍率应仍在(倒计时未走完)');
});

/* ═══════════ 3. 三件死道具:保留 + 显式未实装 ═══════════ */

test('FND17-6 三件死道具仍在冻结内容表里,且「未实装」是显式的', () => {
  /* 变红条件:
       1 有人从 `shared/constants/items.ts` 删掉 733/435/227 ⇒ 内容锁报警 + 存档失效;
       2 有人把它们标成 `implemented: true` 而没补消费点 ⇒ 过度声称。 */
  const ids = [733, 435, 227];
  const inTable = new Set(ITEM_LIST.map((i) => i.id));
  for (const id of ids) {
    ok(inTable.has(id), `冻结内容表里应仍有 ${id}(不许为「没实装」而删内容)`);
  }
  eq(DEAD_ITEMS.length, 3, '裁决表应恰有 3 条');
  const decided = DEAD_ITEMS.map((d) => d.id).sort((a, b) => a - b);
  eq(decided.join(','), ids.slice().sort((a, b) => a - b).join(','), '三件都要有裁决');
  for (const d of DEAD_ITEMS) {
    ok(d.reason.trim().length >= 20, `${d.id} 的 reason 必须写清「缺什么」(不能是 TODO)`);
    if (d.implemented) {
      ok(d.consumer !== null && d.consumer.trim().length > 0,
        `${d.id} 标成已实装就必须给出消费点位置`);
    } else {
      eq(d.consumer, null, `${d.id} 未实装时不该有 consumer`);
    }
  }
});

report('WS-FND-17');
