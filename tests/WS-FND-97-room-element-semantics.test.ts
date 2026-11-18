/**
 * WS-FND-97 —— **房间 → 元素**的语义映射(owner 裁决:「元素抗性按房间语义分元素」)。
 *
 * ## 这个套件钉什么
 *
 * `server/src/rooms/effects.ts` 的 `ROOM_ELEMENT_RESIST` 此前**只有一行**
 * (`SAKURA_ONSEN → ICE`),另外 8 种房间没有元素归属 —— 于是「元素抗性按房间语义」
 * 这件事在数据上根本不成立:盖出锻造房 / 温室站进去,抗性表里没有任何来源,而门禁全绿。
 *
 * owner 裁决(2026-11-18):**给各房间按其语义映射元素**(温泉 / 火炉 → FIRE、
 * 冷库 / 冰窖 → ICE、温室 / 牧场 → EARTH、水相关 → WATER …;以 `ROOM_RECIPES` 的
 * 语义为准)。本套件把裁决落成判据,并钉住两条**不许**:
 *
 *   1. **不发明元素**:表里每个元素都必须在 `ELEMENTS` 里。
 *      ⚠️ 仓库的元素表(`server/src/combat/weapons.ts:24-34`)只有
 *      `NONE / FIRE / ICE / LIGHTNING / LIGHT / SLIME` —— **没有 `EARTH` / `WATER`**。
 *      写一个表外元素 = 抗性表里多一个**永远没人读**的键(伤害侧的 `element`
 *      只可能是那 6 个之一),这正是「静默 no-op」那一类缺陷。
 *   2. **不许顺手给所有房间加抗性**:语义元素在元素表里没有对应项的房间
 *      (`ECO_RANCH` 的「土 / 农」)与本来就无语义元素的房间(画廊 / 卧室 / 商店)
 *      一律**不登记**,`roomElementResistOf` 必须返回 `null`。
 *
 * ## 值是哪来的
 *
 * 数值**仍无内容来源**(逐处核过:`ROOM_RECIPES` 的 bonus、`FOOD_PARAM_SLOTS` 的 6 槽、
 * `ArmorDef` 都没有可结算的抗性字段)⇒ 保持具名「待平衡」默认
 * (`PENDING_ELEMENT_RESIST_MUL = 0.5`),owner 给了真内容就**整行替换**。
 *
 * ## 生产调用点(世界编排层,本任务**不改**)
 *
 * 房间效果是**慢帧**产物,唯一调用点是 `server/src/sim/world_sim.ts` 的
 * `tickRoomEffects()`(L4033:`pushRoomElementResist(this.vitals, id, key)`)。
 * FND97-6 用 `roomAtCell` 走的就是那条链的等价路径 —— 本套件只换**数据**(房间 → 元素),
 * 不新增接线。
 *
 * ## 断言纪律
 *
 * 期望值一律用**字面量**(`'FIRE'` / `'LIGHT'` / `0.5` / `12` / `6`),不取被测模块的
 * 导出常量;判据自己的房间 → 元素**期望表**也手写一遍(拿 `ROOM_ELEMENT_RESIST` 当
 * 期望值就是同义反复 —— 表写错时两边一起错)。每条判据都有负对照,并逐条做了注入验证
 * (见文件末「注入验证」一节)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { VitalsSystem } from '../server/src/combat/vitals.ts';
import { ELEMENTS, type Element } from '../server/src/combat/weapons.ts';
import { ROOM_RECIPES } from '../shared/constants/bosses.ts';
import {
  ROOM_ELEMENT_RESIST,
  roomElementResistOf,
  pushRoomElementResist,
  roomAtCell,
  type ElementResistSink,
} from '../server/src/rooms/effects.ts';

/** 4 级生物的基础伤害 = 6 + 2×(4−1) = 12(与 `WS-FND-93` FND93-1 同一算式,写死)。 */
const BASE_HIT_12 = 12;

/**
 * 判据自己的**期望映射**(字面量)。
 *
 * 依据(房间名 + 核心件名,见 `ROOM_RECIPES` / `items.ts`):
 *   · FORGE_MASTER     —— 503 `矮人鼓风高炉` + 504 `大师秘银铁砧台` ⇒ 高炉 / 熔炉 = 火;
 *   · COZY_CANTEEN     —— 506 `八人欢聚大汤锅` + 可选 508 `红砖果木披萨炉` ⇒ 灶火 / 烤炉;
 *   · SAKURA_ONSEN     —— 526 `露天温泉石灯笼` + 可选 109 `白玉温泉石` ⇒ 热水 / 地热
 *                        (owner 裁决原话「温泉/火炉→FIRE」;此前登记的是 `ICE`);
 *   · ALCHEMY_LAB      —— 536 `【AI核心】万物奇想炼金炉`(= `ALCHEMY_FURNACE_ID`)⇒ 炼金炉;
 *   · AUTO_GREENHOUSE  —— 375 `阳光温室玻璃顶` + bonus「全天候透光」⇒ 阳光。
 *                        ⚠️ owner 示例写「温室 → EARTH」,但元素表里**没有 EARTH**
 *                        ⇒ 落到内容里真实存在的 `LIGHT`(而**不是**发明 `EARTH`)。
 */
const EXPECTED_ELEMENT: Readonly<Record<string, string>> = {
  FORGE_MASTER: 'FIRE',
  COZY_CANTEEN: 'FIRE',
  SAKURA_ONSEN: 'FIRE',
  ALCHEMY_LAB: 'FIRE',
  AUTO_GREENHOUSE: 'LIGHT',
};

/**
 * 必须**不登记**的房间(⇒ `roomElementResistOf` 返回 `null`)。
 *
 * · `ECO_RANCH`    —— 语义元素是土 / 农(owner 示例作 `EARTH`),元素表里没有它;
 * · `ART_GALLERY`  —— 展示类;
 * · `COZY_BEDROOM` —— 休憩类;
 * · `CLOUD_DEPOT`  —— 商店类。
 */
const MUST_BE_UNREGISTERED: readonly string[] = ['ECO_RANCH', 'ART_GALLERY', 'COZY_BEDROOM', 'CLOUD_DEPOT'];

/** 记录每一次写入的假 sink(**只在本文件第 5 条里用**,其余判据一律用真 `VitalsSystem`)。 */
function makeCountingSink(): { sink: ElementResistSink; calls: { element: string; mul: number }[] } {
  const calls: { element: string; mul: number }[] = [];
  return {
    calls,
    sink: {
      setElementResist(_playerId: string, element: string, mul: number): boolean {
        calls.push({ element, mul });
        return true;
      },
    },
  };
}

/* ═════════════════ FND97-1 覆盖性 + 每房间元素 ═════════════════ */

test('FND97-1 ★★ 每个房间按语义给元素:登记集合 == 期望集合,元素全在 ELEMENTS 里,9 种房间一个不漏', () => {
  const recipeKeys: string[] = ROOM_RECIPES.map((r) => r.key as string).slice().sort();
  /* 前置:对着冻结层核 —— 手册加了第 10 种房间,本表必须跟着做决定。 */
  eq(recipeKeys.length, 9, '前置:`ROOM_RECIPES` 应为 9 种');

  /* 期望表里的 key 必须都是**真房间**(防「凭空造房间」)。 */
  for (const key of Object.keys(EXPECTED_ELEMENT)) {
    ok(recipeKeys.includes(key), `★ 期望表里的 ${key} 必须是 ROOM_RECIPES 的房间`);
  }
  for (const key of MUST_BE_UNREGISTERED) {
    ok(recipeKeys.includes(key), `★ 判据里的 ${key} 必须是 ROOM_RECIPES 的房间`);
  }

  /* 登记集合 == 期望集合(双向:少一个 / 多一个都红)。 */
  eq(
    Object.keys(ROOM_ELEMENT_RESIST).slice().sort(),
    Object.keys(EXPECTED_ELEMENT).slice().sort(),
    '★ 登记的房间集合必须与期望一致(不多不少)',
  );

  /* 逐房间:元素对 + 数值仍是待平衡默认 + 元素在元素表里。 */
  for (const [key, element] of Object.entries(EXPECTED_ELEMENT)) {
    const e = roomElementResistOf(key);
    eq(e === null ? null : e.element, element, `★ ${key} 的语义元素`);
    eq(e === null ? null : e.mul, 0.5, `★ ${key} 的数值仍是待平衡默认 0.5(owner 未给内容值)`);
    ok(e !== null && ELEMENTS.includes(e.element as Element), `★ ${key} 的元素必须在 ELEMENTS 里(不发明元素)`);
  }

  /* 负对照:「分元素」得真分出不止一种 —— 全表同一个元素 = 这条裁决没落地。 */
  const distinct = new Set(Object.values(ROOM_ELEMENT_RESIST).map((e) => e.element));
  ok(distinct.size >= 2, `★ 表里至少要有两种元素(实测 ${distinct.size})`);
  /* 负对照:也不能「全都登记」——必须留得下 null(见 FND97-2)。 */
  ok(
    recipeKeys.length - Object.keys(ROOM_ELEMENT_RESIST).length >= 2,
    '★ 未登记的房间至少要留 2 个(不许顺手给所有房间都加一点)',
  );
});

/* ═════════════════ FND97-2 未登记 ⇒ null ═════════════════ */

test('FND97-2 ★★ 未登记的房间一律 null:牧场 / 画廊 / 卧室 / 商店站进去 ⇒ 零抗性', () => {
  const v = new VitalsSystem();
  v.register('p1');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '前置:一点抗性都没有(中性 1.0)');

  for (const key of MUST_BE_UNREGISTERED) {
    eq(roomElementResistOf(key), null, `★ ${key} 必须不登记(语义元素不在元素表里 / 无语义元素)`);
    eq(pushRoomElementResist(v, 'p1', key), true, `${key}:推送仍成功(写的是中性值)`);
    eq(v.elementResistOf('p1', 'FIRE'), 1, `★ ${key}:FIRE 没被顺手写成 0.5`);
    eq(v.elementResistOf('p1', 'ICE'), 1, `★ ${key}:ICE 同理`);
    eq(v.elementResistOf('p1', 'LIGHT'), 1, `★ ${key}:LIGHT 同理`);
  }

  eq(roomElementResistOf(null), null, '不在任何房间 ⇒ null');
  eq(roomElementResistOf('NOT_A_ROOM'), null, '不存在的房间 key ⇒ null(不是抛错)');
});

/* ═════════════════ FND97-3 不串味 ═════════════════ */

test('FND97-3 ★★ 不串味:站 A 房只有 A 房的元素吃抗性;别的元素、别的玩家原样', () => {
  const v = new VitalsSystem();
  v.register('p1');
  v.register('p2');

  eq(pushRoomElementResist(v, 'p1', 'FORGE_MASTER'), true, '前置:p1 进锻造房');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★★ 锻造房(高炉)⇒ FIRE 抗性真的落进 vitals');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, 6, '★★ 同一次 FIRE 伤害 12 × 0.5 = 6');

  /* 元素维度:除 FIRE 外的每个元素都必须原值(逐个列,不用推导出来的集合)。 */
  const others: readonly Element[] = ['NONE', 'ICE', 'LIGHTNING', 'LIGHT', 'SLIME'];
  for (const el of others) {
    eq(v.elementResistOf('p1', el), 1, `★ 站在锻造房不该给 ${el} 抗性`);
    eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, el).rawDamage, BASE_HIT_12, `★ ${el} 伤害原样 12`);
  }

  /* 玩家维度:抗性只落在被推送的那个玩家身上。 */
  eq(v.elementResistOf('p2', 'FIRE'), 1, '★ p2 没进房 ⇒ 中性');
  eq(v.applyHit('m', 'p2', 4, 1.0, 0, 0, 'FIRE').rawDamage, BASE_HIT_12, '★ p2 的 FIRE 伤害原样 12');

  /* 另一间 FIRE 房:同元素 = 同一份抗性(不叠加、也不串到 LIGHT 去)。 */
  eq(pushRoomElementResist(v, 'p1', 'COZY_CANTEEN'), true, '前置:移到食堂');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 食堂(灶火)同样是 FIRE ⇒ 0.5(不是叠成 0.25)');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★ 食堂不给 LIGHT 抗性(相邻元素没被顺手写上)');

  /* 全表元素逐个核:除当前来源外一律中性(FND97-2 之外的**已登记**房间也要判)。 */
  eq(pushRoomElementResist(v, 'p1', 'ALCHEMY_LAB'), true, '前置:移到炼金实验室');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 炼金炉同样是 FIRE');
  eq(v.elementResistOf('p1', 'SLIME'), 1, '★ 与火同族的 SLIME 也没被顺手写上');
});

/* ═════════════════ FND97-4 清空路径 ═════════════════ */

test('FND97-4 ★★ 清空路径:出房 / 进未登记房 / 房不存在 ⇒ 抗性撤销,伤害回到 12', () => {
  const v = new VitalsSystem();
  v.register('p1');

  eq(pushRoomElementResist(v, 'p1', 'AUTO_GREENHOUSE'), true, '前置:进温室');
  eq(v.elementResistOf('p1', 'LIGHT'), 0.5, '前置:LIGHT 抗性在身');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '前置:FIRE 中性(温室不是火房)');

  eq(pushRoomElementResist(v, 'p1', null), true, '★ 走出房间 ⇒ 推送仍成功(写的是中性值)');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★★ 出房 ⇒ LIGHT 被撤销(回到中性 1.0)');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'LIGHT').rawDamage, BASE_HIT_12, '★★ 撤销后同一次 LIGHT 伤害恢复 12');

  /* 负对照 1:未登记的房间同样清空(不是「只有 null 才清」)。 */
  eq(pushRoomElementResist(v, 'p1', 'FORGE_MASTER'), true, '前置:再进锻造房');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '前置:FIRE 又回来了');
  eq(pushRoomElementResist(v, 'p1', 'ECO_RANCH'), true, '★ 走进未登记的牧场 ⇒ 也是推中性值');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★★ 未登记房间也得撤销(不许顺手给所有房间加抗性)');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★ LIGHT 仍是中性');

  /* 负对照 2:根本不存在的房间 key(玩家还没盖出任何房)也走同一条清空路径。 */
  eq(pushRoomElementResist(v, 'p1', 'PRIVATE_PLAYER_BASE'), true, '★ 不存在的房间 key ⇒ 中性值');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★ 仍是中性');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★ 仍是中性(逐元素都清)');
});

/* ═════════════════ FND97-5 换房即换元素 + 每元素只写一次 ═════════════════ */

test('FND97-5 ★★ 换房即换元素;同元素的多个房间共用一个键,每元素每帧只许写一次', () => {
  const { sink, calls } = makeCountingSink();

  eq(pushRoomElementResist(sink, 'p1', 'FORGE_MASTER'), true, '前置:进锻造房');
  eq(
    calls.filter((c) => c.element === 'FIRE').length,
    1,
    '★★ 表里 4 个 FIRE 房 ⇒ 每帧 FIRE 只许写 1 次(逐行写会写 4 次)',
  );
  eq(calls.filter((c) => c.element === 'FIRE')[0].mul, 0.5, '★ 写的是来源那一份 0.5');
  eq(calls.filter((c) => c.mul !== 1).length, 1, '★★ 一次推送里只有 1 个元素拿到非中性值(不串味)');
  eq(calls.map((c) => c.element).slice().sort(), ['FIRE', 'LIGHT'], '★ 推送面 = 表里的元素集合 {FIRE, LIGHT}');

  /* 换房:FIRE 回中性、LIGHT 生效 —— 同一帧里两个方向都写。 */
  calls.length = 0;
  eq(pushRoomElementResist(sink, 'p1', 'AUTO_GREENHOUSE'), true, '前置:移到温室');
  eq(calls.find((c) => c.element === 'FIRE')?.mul, 1, '★★ 换房后 FIRE 被撤销(写中性)');
  eq(calls.find((c) => c.element === 'LIGHT')?.mul, 0.5, '★★ 换房后 LIGHT 生效');
  eq(calls.length, 2, '★ 两个元素各写一次(不多不少)');

  /* 幂等:连推 3 次仍是同一个数(叠加的话会越走越远)。 */
  const v = new VitalsSystem();
  v.register('p1');
  for (let i = 0; i < 3; i += 1) pushRoomElementResist(v, 'p1', 'COZY_CANTEEN');
  eq(v.elementResistOf('p1', 'FIRE'), 0.5, '★ 连推 3 次仍是 0.5(幂等;叠加会是 0.125)');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★ 连推 3 次也不会给 LIGHT 写东西');
});

/* ═════════════════ FND97-6 来源链 ═════════════════ */

test('FND97-6 ★★ 来源链:房间定位(`roomAtCell`)→ 推送 —— 生产调用点的等价路径', () => {
  const v = new VitalsSystem();
  v.register('p1');
  const rooms = [
    { key: 'FORGE_MASTER', cells: [{ x: 5, y: 5 }] },
    { key: 'AUTO_GREENHOUSE', cells: [{ x: 9, y: 5 }] },
  ];

  const inForge = roomAtCell(rooms, 5.5, 5.5);
  eq(inForge, 'FORGE_MASTER', '前置:站在锻造房格上');
  eq(pushRoomElementResist(v, 'p1', inForge), true, '★ 按定位结果推送成功');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'FIRE').rawDamage, 6, '★ 房内 FIRE 伤害减半');

  const inGreenhouse = roomAtCell(rooms, 9.5, 5.5);
  eq(inGreenhouse, 'AUTO_GREENHOUSE', '前置:站在温室格上');
  eq(pushRoomElementResist(v, 'p1', inGreenhouse), true, '★ 换房推送成功');
  eq(v.elementResistOf('p1', 'FIRE'), 1, '★★ 换房 ⇒ 上一间房的 FIRE 撤销');
  eq(v.elementResistOf('p1', 'LIGHT'), 0.5, '★★ 温室 ⇒ LIGHT 生效');
  eq(v.applyHit('m', 'p1', 4, 1.0, 0, 0, 'LIGHT').rawDamage, 6, '★ 房内 LIGHT 伤害减半');

  const outside = roomAtCell(rooms, 20.5, 5.5);
  eq(outside, null, '前置:房外的格不属于任何房间');
  eq(pushRoomElementResist(v, 'p1', outside), true, '★ 房外推送成功(中性值)');
  eq(v.elementResistOf('p1', 'LIGHT'), 1, '★ 走出房 ⇒ 撤销(同一条链的两个方向都判)');
});

report('WS-FND-97-room-element-semantics');

/*
 * ═════════════════ 注入验证(每条判据都能红,不是装饰)═════════════════
 *
 * 注入都打在 `server/src/rooms/effects.ts`(被测的生产代码)上,改完即跑本套件、
 * 跑完立刻还原(实测 `effects.ts` 复原后与注入前 sha 相同):
 *
 * | # | 注入 | 结果(实跑,6 条判据里通过几条) |
 * | :--- | :--- | :--- |
 * | M1 | `SAKURA_ONSEN` 的元素 `FIRE` → `ICE`(退回裁决前的老值) | **4/6** 通过(红:FND97-1 / 5) |
 * | M2 | `AUTO_GREENHOUSE` 的元素 `LIGHT` → `FIRE`(写错元素) | **2/6** 通过(红:FND97-1 / 4 / 5 / 6) |
 * | M3 | 表里多登记一行 `ECO_RANCH: { element: 'FIRE', … }`(顺手全给) | **3/6** 通过(红:FND97-1 / 2 / 4) |
 * | M4 | 挪掉清空路径(非来源元素 `continue`,不再写中性值) | **3/6** 通过(红:FND97-4 / 5 / 6) |
 * | M5 | 逐行写回(不去重:4 个 FIRE 房 ⇒ FIRE 被写 4 次) | **5/6** 通过(红:FND97-5) |
 * | M6 | `PENDING_ELEMENT_RESIST_MUL` 0.5 → 0.9 | **1/6** 通过(红:FND97-1 / 3 / 4 / 5 / 6) |
 *
 * 两条最该看的:**M3(多登记一个房间)与 M5(同一元素写多遍)** 都不会抛错、也不会让
 * 「拆分/接线」那类判据红 —— 只可能是「语义映射」这一层出错。M5 尤其:**逐行写
 * 在功能上看不出毛病**(元素值仍对),只有数写入次数的那一条能发现它。
 */
