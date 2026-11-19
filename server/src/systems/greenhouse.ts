/**
 * WS-FND-75 / 【自动物流温室】(`AUTO_GREENHOUSE`)的系统 —— 纯函数,零 IO。
 *
 * ## 为什么有这个文件
 *
 * 手册 §3.8 与内容表的三件识别件说的是同一句话:
 *   · `375 阳光温室玻璃顶` —— 「**全天候透光**」;
 *   · `426 旋转自动洒水器` —— 「接通水源或**每早自动旋转**,将周围 **5×5** 耕地全部浇湿」;
 *   · `429 智能分拣交叉带` —— 「设定过滤物品 ID,将……材料**自动分流**进不同储物箱」。
 *
 * 而 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.AUTO_GREENHOUSE` 此前写着
 * 「需物流系统 ⇒ 未实装」。⇒ 本文件把那三条承诺拆成三个可判定的纯函数:
 * **这格今天长多少 / 早上浇到哪几格 / 收下来的东西分到哪条道**。
 *
 * ## 与「露天」的差别只在这里
 *
 * 温室增益的**唯一**可观测差别是:夜里、暴风雨里,露天作物生长归零,
 * 温室照长。这条差别是本模块存在的理由 —— 也是判据的负对照
 * (夜里:温室照长而露天不长)。
 *
 * ⚠️ 本文件**不判定**「现在是不是夜里」:昼夜边界只有一处
 * (`wiring/components.ts` 的 `isNight(hour)`),这里只接受一个已判好的
 * `night: boolean`。同理 `weather` 由世界侧的天气状态喂进来。
 */

import { ITEM_LIST } from '../../../shared/constants/items.ts';

/**
 * 本实现在 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 里登记的身份。
 * `module` 是仓库相对路径(判据用 `existsSync` 核它真的存在)。
 */
export const GREENHOUSE_SYSTEM = Object.freeze({
  roomKey: 'AUTO_GREENHOUSE',
  module: 'server/src/systems/greenhouse.ts',
  entry: 'cellGrowth',
});

/** 天气枚举(不可擦除语法禁止 `enum`,用 `as const` 对象 —— 全仓同写法)。 */
export const Weather = {
  CLEAR: 'CLEAR',
  RAIN: 'RAIN',
  STORM: 'STORM',
} as const;
export type Weather = (typeof Weather)[keyof typeof Weather];

/**
 * 露天生长的光照判定:**夜里一定是黑**;白天阴雨仍有散射光,**只有暴风雨**
 * 才把露天的光照判成不成立。
 *
 * 为什么只对 `STORM` 关门:这是**二值判定**,不是"雨天打个 0.6 折"——
 * 一旦引入倍率,就必须编一个天气强度表,而内容表里没有那样一张表。
 */
export const OUTDOOR_BLOCKING_WEATHER: readonly Weather[] = Object.freeze([Weather.STORM]);

/** 田间持水量下限(**浇水判定**,不是生长速度倍率):低于它 = 这格没浇透。 */
export const GREENHOUSE_MIN_MOISTURE = 0.35;

/** 自动洒水器的覆盖半径(格):`2` ⇒ 5×5(内容表 426 的字面量「周围 5×5」)。 */
export const SPRINKLER_REACH = 2;

/** 自动洒水把土壤浇到多少:浇透 = 1.0(田间持水量满)。 */
export const SPRINKLER_MOISTURE = 1;

/** 一格耕地上的作物。 */
export interface CropCell {
  cropId: number;
  /** 从播种到成熟需要几天(`> 0`;非正数视为坏数据)。 */
  matureDays: number;
  /** 当前土壤含水量 0..1。 */
  moisture: number;
  /** 已积累的生长进度 0..1(0 = 刚播种,1 = 成熟);省略 = 0。 */
  progress?: number;
}

/** 一格的当日生长输入。 */
export interface CellGrowthInput {
  cell: CropCell;
  /** 现在是不是夜里(由 `isNight(hour)` 判好之后传进来)。 */
  night: boolean;
  weather: Weather;
  /** 这格是否在温室里(房间识别结果)。 */
  inGreenhouse: boolean;
  /** 温室里有洒水器(426)且通水 —— 温室里没有它就没有"自动洒水"。 */
  sprinkler: boolean;
}

/** 一格的当日生长输出。 */
export interface CellGrowthResult {
  /** 光照成立?露天 = 白天且非暴风雨;温室 = 恒成立(全天候透光)。 */
  lightOk: boolean;
  /** 这格今天是否浇透了。 */
  watered: boolean;
  /** 今天长了多少(0..1 的进度分量);`0` = 今天完全没长。 */
  growthPerDay: number;
  /** 今天结束时是否成熟(进度 ≥ 1)。 */
  ready: boolean;
  /** 人读的理由(为什么长/不长)。 */
  reason: string;
}

/**
 * 这格作物**今天该长多少**。
 *
 * ```
 * 光照:温室 ⇒ 恒 true(375 全天候透光)
 *       露天 ⇒ !night 且 weather ∉ {STORM}
 * 浇水:温室 + 洒水器 ⇒ true(426 每早浇湿 5×5)
 *       否则            ⇒ moisture ≥ 0.35
 * 生长:光照 ∧ 浇水 ⇒ (1 / matureDays) 每天;否则 0
 * ```
 *
 * 归一化成长速度(`1 / matureDays`)而不是「每株每秒 +X 点」:成熟天数来自
 * 作物定义,是**规则**,不是平衡数字 —— 本模块不引入任何"生长速率"常数。
 */
export function cellGrowth(input: CellGrowthInput): CellGrowthResult {
  const { cell } = input;
  const matureDays = cell.matureDays;

  if (!Number.isFinite(matureDays) || matureDays <= 0) {
    return {
      lightOk: false,
      watered: false,
      growthPerDay: 0,
      ready: false,
      reason: `作物 ${cell.cropId} 的成熟天数非法(${matureDays}) ⇒ 不生长`,
    };
  }

  const lightOk = input.inGreenhouse
    ? true
    : !input.night && !OUTDOOR_BLOCKING_WEATHER.includes(input.weather);

  const watered = input.inGreenhouse && input.sprinkler
    ? true
    : cell.moisture >= GREENHOUSE_MIN_MOISTURE;

  const growthPerDay = lightOk && watered ? 1 / matureDays : 0;

  const progress = Number.isFinite(cell.progress as number) ? (cell.progress as number) : 0;
  const after = progress + growthPerDay;
  const ready = after >= 1 - 1e-9;

  let reason: string;
  if (growthPerDay > 0) {
    reason = input.inGreenhouse
      ? '温室:全天候透光 + 已浇透 ⇒ 按成熟天数匀速生长'
      : '露天:白天有光 + 已浇透 ⇒ 正常生长';
  } else if (!lightOk) {
    reason = input.night
      ? '露天且夜里 ⇒ 没有光照,今天不长(温室不受影响)'
      : `露天且天气 ${input.weather} ⇒ 光照不成立,今天不长`;
  } else {
    reason = `土壤含水量 ${cell.moisture} 低于 ${GREENHOUSE_MIN_MOISTURE} ⇒ 没浇透,今天不长`;
  }

  return { lightOk, watered, growthPerDay, ready, reason };
}

/**
 * 早上这一格的水分:温室里有洒水器 ⇒ 浇到满;否则**维持原值**
 * (本模块不建模蒸发 —— 编一个"每天蒸发多少"就是凭空造平衡数字)。
 */
export function morningMoisture(input: {
  moisture: number;
  inGreenhouse: boolean;
  sprinkler: boolean;
}): number {
  if (input.inGreenhouse && input.sprinkler) return SPRINKLER_MOISTURE;
  const m = input.moisture;
  return Number.isFinite(m) ? m : 0;
}

/**
 * 自动洒水器**每早**浇到哪几格:以 (cx, cy) 为中心的 5×5。
 *
 * 期望值可以手算:行数 2·2+1 = 5、列数 5、合计 25 格。
 */
export function sprinklerCells(cx: number, cy: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return out;
  const bx = Math.round(cx);
  const by = Math.round(cy);
  for (let dy = -SPRINKLER_REACH; dy <= SPRINKLER_REACH; dy += 1) {
    for (let dx = -SPRINKLER_REACH; dx <= SPRINKLER_REACH; dx += 1) {
      out.push({ x: bx + dx, y: by + dy });
    }
  }
  return out;
}

/** 分拣带上的一条过滤规则(429):「设定过滤物品 ID ⇒ 分流进这一条道」。 */
export interface SortFilter {
  /** 道号(0 = 左 / 1 = 前 / 2 = 右,与 `wiring/logistics.ts` 的三路同口径)。 */
  lane: number;
  itemIds: readonly number[];
}

/** 没命中任何过滤规则时的返回值:**不从分拣带出去**。 */
export const SORT_PASS_THROUGH = -1;

/**
 * 收获的这格产物**该被分拣到哪**:第一条包含该物品 ID 的过滤规则的 `lane`;
 * 一条都没命中 ⇒ `SORT_PASS_THROUGH`(-1,原样留在带上 / 进默认箱)。
 *
 * 为什么"第一条命中"而不是"最后一条":429 的原句是「设定过滤物品 ID ⇒
 * 分流进不同储物箱」,同一条带上的规则按**安装顺序**生效;后装的规则
 * 覆盖先装的会让同一件的去向取决于装配历史,是那种"两台客户端各说各话"
 * 的来源。
 */
export function sortHarvest(itemId: number, filters: readonly SortFilter[]): number {
  if (!Number.isInteger(itemId) || itemId <= 0) return SORT_PASS_THROUGH;
  for (const f of filters) {
    if (!Number.isFinite(f.lane)) continue;
    if (f.itemIds.includes(itemId)) return f.lane;
  }
  return SORT_PASS_THROUGH;
}

/* ═══════════ 作物 → 产物(429 的过滤表写的是**产物** id)═══════════ */

/**
 * 一格作物收一次给几件。
 *
 * ⚠️ **中性锚 + 待平衡**:内容表与手册 §3.8 都只写「耕地播种收获」,
 *   没有任何产量数字。一格一株收 1 件是唯一不含平衡假设的口径(1:1),
 *   与 `CROP_MATURE_DAYS = 4` 同一姿态:**待 owner 裁决后由内容表接管**。
 */
export const HARVEST_YIELD = 1;

/**
 * 作物(播种的那件物品)→ **产物名**(手册/内容表的字面量,不是 id)。
 *
 * ## 这个表修的是什么(第七轮实测 P1)
 *
 * 修前 `systems/wiring.ts` 直接拿 `cell.cropId` 去 `sortHarvest`,于是
 * 「作物 id」与「产物 id」被当成同一个东西:玩家在 429 上按**产物**写过滤规则
 * (内容表里作物与产物本可以是两件东西)永远不命中,分拣链看起来接好了、
 * 实际一条规则都不生效。
 *
 * ## 口径(照 `ranch.ts:78` 的 `RANCH_PRODUCE_BY_SPECIES` 同一姿态)
 *
 * 名字是**内容表的字面量**,ID 由内容表查(`cropProductIdOf`)——
 * 表里没有这件东西就返回 `null`(如实浮缺口,不编 id)。名字与 id 分开之后,
 * 内容表将来补一件「某作物的产物」,只改这里一行,分拣/落地自动跟上。
 *
 * 当前只登记内容表 `note` 自称「耕地播种收获 / 耕种收获」的两种
 * (`intake.ts` 的 `SOWABLE_ITEM_IDS` 现算集合 = {123, 126}):
 * `123 黄金小麦` → 收获的仍是黄金小麦;`126 爆裂火椒` → 收获的仍是爆裂火椒。
 * ⇒ **今天是恒等映射**,但它是**一件事实的落点**,不是「id 就是 id」的隐式假设:
 *   未登记的第 3 种作物返回 `null`(负对照见 `tests/WS-FND-125`)。
 */
export const CROP_PRODUCT_NAME_BY_CROP: Readonly<Record<number, string>> = Object.freeze({
  123: '黄金小麦',
  126: '爆裂火椒',
});

/** 内容表的「名字 → ID」索引(模块加载时建一次,与 `ranch.ts:84` 同源)。 */
const ITEM_ID_BY_NAME: ReadonlyMap<string, number> = new Map(ITEM_LIST.map((i) => [i.name, i.id]));

/** 该作物收获的产物**名**;没登记 ⇒ `null`。 */
export function cropProductNameOf(cropId: number): string | null {
  if (!Number.isInteger(cropId)) return null;
  return CROP_PRODUCT_NAME_BY_CROP[cropId] ?? null;
}

/**
 * 该作物收获的产物**物品 id**;内容表里没有这件东西(或该作物没登记)⇒ `null`。
 *
 * ★ 唯一允许的产物 id 来源 —— 不查内容表就不许有 id(同 `ranch.ts:91`)。
 */
export function cropProductIdOf(cropId: number): number | null {
  const name = cropProductNameOf(cropId);
  return name === null ? null : (ITEM_ID_BY_NAME.get(name) ?? null);
}