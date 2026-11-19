/**
 * WS-FND-77 · 四个房间系统 + 料理 3 字段的**世界侧单一装配点**。
 *
 * ## 这个文件补的是哪一段(「实现完整、生产零消费」的第 10 例)
 *
 * `server/src/systems/{ranch,greenhouse,alchemy_lab,depot}.ts` 是全绿的**纯函数**,
 * `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 也已把四条登记成「已实装」,
 * 但**没有任何生产代码调用它们**:
 *
 * ```
 * settleRanchDay      调用点:测试
 * cellGrowth          调用点:测试
 * brewAndRecord       调用点:测试
 * buy                 调用点:测试
 * ```
 *
 * ⇒ 玩家盖出牧场/温室/炼金室/百货店,手册承诺的事**一件都不发生**,而门禁全绿。
 *
 * ## 为什么所有接线都挤在**这一个文件**
 *
 * 「四系统各自散在 `world_sim.tick()` 里各写一段」是本仓反复踩的形态:
 * 同一件事的入口越多,漏一个就静默失效一次(`tickRoomEffects` / `tickLogisticsStep`
 * 都是先例)。⇒ 本文件是**唯一的**装配点:
 *
 * ```
 * WorldSim.advanceRoomSystems(dayFraction)   ← 慢帧每天调用一次
 *   └─ growCrops()       温室:浇水的早上 + 这格今天长多少 + 成熟即按 429 分拣
 * WorldSim.settleRanchIfDayChanged()         ← 跨日(慢帧)
 *   └─ settleRanch()     牧场:谁在圈里 × 槽里有多少饲料 ⇒ 毛团 / 温泉橘
 * WorldSim.brewAtFurnace(actorId, ids)       ← net/actions/use_alchemy_furnace.ts
 *   └─ brewInLab()       炼金:首创冠名 + 537 陈列投影
 * WorldSim.purchaseQuote / purchaseCommit    ← net/actions/buy_item.ts
 *   └─ depot.buy()       百货:定价/库存/零副作用(见 depot.ts 的纪律)
 * ```
 *
 * ## 数字纪律(**本文件是最大的风险点**)
 *
 * | 数 | 来源 |
 * | :--- | :--- |
 * | 成熟天数 | **内容表没有** ⇒ 常量 `CROP_MATURE_DAYS` + **待平衡**注释(不编平衡表) |
 * | 洒水覆盖 | `greenhouse.ts` 的 `SPRINKLER_REACH`(426 的字面量「5×5」) |
 * | 牧场饲料 / 产出 | `ranch.ts`(`tameItem` / 每只每天 1 份) |
 * | 定价 | `depot.ts`(内容表没有 `price` ⇒ 一切**无定价**,本文件不补价) |
 *
 * ⚠️ 本文件**不 import `mobs/taming.ts`**:它是 `scripts/verify.ts` 的
 *   `UNREACHABLE_EXEMPT` 成员(`taming.ts` 的宠物容器尚未接线)。一旦从这里
 *   import 它,那条白名单就变成**陈旧条目**(门禁会报「白名单里的文件现在可达」),
 *   而 `scripts/verify.ts` 不在本线写域。⇒ 圈养名单由世界侧注入
 *   (`WorldSim.setRanchPets`),唯一的权威仍是 `taming.ts:PetRecord.inRanch`。
 *
 * ## ★ WS-FND-125(第七轮实测):收获链路的两处「半截」
 *
 * ```txt
 * P0  成熟即 delete + harvest.push ⇒ 产物只活在内存(地面/背包/428/430 都拿不到)
 *     ⇒ 现在成熟必须**交付**:产物 id 由 `greenhouse.ts:cropProductIdOf` 定,
 *        交给 `GrowInput.deliverHarvest`(世界侧注入,落到 `mobGround` 或背包);
 *        世界没接住 ⇒ `landed: 'NONE'` + `unlanded`,**账与世界不许不一致**。
 * P1  分拣拿 `cell.cropId` 当产物 id ⇒ 429 过滤表按产物写永远不命中
 *     ⇒ 现在分拣用产物 id(未登记的作物退回「收的就是它自己」这一老口径)。
 * ```
 *
 * ⚠️ `deliverHarvest` 目前由世界侧接线(`sim/world_sim.ts` **不在本线写域**,
 *   它正被另一条线改)⇒ 缺口由 `unlanded` 计数**出声**,不会静默。
 *   判据:`tests/WS-FND-125-systems-chain.ts`(FND125-2/3/4 用注入桩钉机制)。
 */

import {
  cellGrowth,
  cropProductIdOf,
  HARVEST_YIELD,
  morningMoisture,
  sortHarvest,
  type SortFilter,
  type Weather,
} from './greenhouse.ts';
import {
  settleRanchDay,
  settleRanchDayOnce,
  resolveItemByName,
  type RanchAnimal,
  type RanchDayResult,
  type RanchOnceOutcome,
} from './ranch.ts';
import {
  brewAndRecord,
  createGallery,
  type BrewInput,
  type BrewOutcome,
  type Gallery,
  type GalleryEntry,
} from './alchemy_lab.ts';
import {
  SETTLEMENT_ROOMS,
  claimSettlement,
  createSettlementLedger,
  settleKeyOf,
  settlementSeenAt,
  type SettlementLedger,
} from './idempotency.ts';

/**
 * 一格耕地的作物状态(**世界侧持有的最小可判定形状**)。
 *
 * 与 `greenhouse.ts` 的 `CropCell` 逐字段同名:`CropCell` 是**入参**形状
 * (它不知道自己在哪一格),本结构多了坐标 —— 两者不做翻译层,
 * 直接 `{...cell}` 就能喂给 `cellGrowth`(翻译层本身是漏字段的地方)。
 */
export interface CropCellState {
  x: number;
  y: number;
  cropId: number;
  /** 从播种到成熟需要几天(播种时给定;`<= 0` 视为坏数据 ⇒ 不生长)。 */
  matureDays: number;
  /** 当前土壤含水量 0..1。 */
  moisture: number;
  /** 已积累的生长进度 0..1。 */
  progress: number;
}

/**
 * 作物成熟天数的**默认值**。
 *
 * ⚠️ **常量 + 待平衡**:内容表(`shared/constants/items.ts`)里**没有**任何作物的
 * 成熟天数,手册 §3.8 也只写「耕地播种收获」。编一张「各作物几天成熟」的表
 * 就是发明平衡数字 ⇒ 这里只留一个中性锚(4 天 = 每天 1/4 进度,与
 * `tests/WS-FND-75` FND75-8 手算的 0.25 同口径),**待 owner 裁决后**
 * 由内容表接管。播种时也可以显式传 `matureDays` 覆盖它。
 */
export const CROP_MATURE_DAYS = 4;

/** 一格耕地的键(`x,y`,与 `WorldGrid` 的 chunk 键同风格)。 */
export function cropKey(x: number, y: number): string {
  return `${Math.floor(x)},${Math.floor(y)}`;
}

/** 一份产物交给世界之后的去向(`NONE` = 世界没接住,不假装落进去了)。 */
export const HarvestLanding = {
  GROUND: 'GROUND',
  INVENTORY: 'INVENTORY',
  NONE: 'NONE',
} as const;
export type HarvestLanding = (typeof HarvestLanding)[keyof typeof HarvestLanding];

/**
 * 交给世界的**那一份产物**(落货口的入参)。
 *
 * `productId` 由「作物 → 产物」映射决定(`greenhouse.ts:cropProductIdOf`);
 * `null` = 内容表没有这件作物的产物 ⇒ 世界侧**无货可落**(不许自己编 id)。
 */
export interface HarvestDelivery {
  x: number;
  y: number;
  cropId: number;
  productId: number | null;
  count: number;
  /** 分拣结果:`-1` = 没命中任何过滤规则(不从带上分出去)。 */
  lane: number;
}

/**
 * 一次「成熟并收下来」的账:哪一格、什么作物/产物、429 把它分到哪条道、
 * 以及**它真的落到哪里去了**。
 *
 * ★ 第七轮 P0:修前这张账是收获链路的**终点**(`st.harvest.push(row)` 之后
 *   再没有任何一步),于是「收获」= 作物被删掉、产物只活在这个数组里。
 *   现在每一行都是**一次真实交付的回执**(`landed` 由世界侧回报);
 *   `landed: 'NONE'` 的行是**没落地的欠账**,与 `GrowResult.unlanded` 同源。
 */
export interface HarvestRow extends HarvestDelivery {
  /** 这一份产物落到哪里去了(`NONE` = 世界没接住,账上如实记)。 */
  landed: HarvestLanding;
}

/** 四系统在世界侧的全部状态(**一个对象**,便于一次性重置/审阅)。 */
export interface RoomSystemsState {
  /** 耕地格:`"x,y"` → 作物。 */
  crops: Map<string, CropCellState>;
  /** 537 陈列馆(炼金首创)。 */
  gallery: Gallery;
  /** 圈养名单(**权威在 `mobs/taming.ts:PetRecord.inRanch`,此处是投影**)。 */
  ranchPets: RanchAnimal[];
  /** 最近一次牧场日结的回执(`null` = 还没结过)。 */
  lastRanch: RanchDayResult | null;
  /** 最近一次炼金的首创行(`null` = 还没炼过)。 */
  lastBrew: GalleryEntry | null;
  /**
   * ★ WS-FND-96:三个房间系统的**幂等台账**(键 → 首次成功结算的时刻)。
   *
   * 与 `gallery` / `harvest` 同住一个状态对象,于是「重置房间系统」时不会漏掉它
   * (`createRoomSystemsState()` 给一张空表)—— 漏掉的后果是重启后所有订单被当成
   * 重放而永久拒付。
   */
  settled: SettlementLedger;
  /**
   * 累计收下来的作物 = **交付台账**(按成熟顺序;`sortHarvest` 已判过道)。
   *
   * ★ WS-FND-125:每行都是一次**真实交付**(`landed` 由世界回报),所以
   *   「账上有几行」与「世界上多了几件货」是同一件事(没落地的那些记 `NONE`
   *   并同时进 `GrowResult.unlanded`,两处同源)。
   */
  harvest: HarvestRow[];
  /** 429 的过滤规则(世界侧配置;空 = 一切 `-1` 原样留在带上)。 */
  sortFilters: SortFilter[];
  /** 累计长大过几次(可观测:说明 `cellGrowth` 真的被调用过)。 */
  growthTicks: number;
}

/** 空状态(每次返回新对象 —— 共享单例会被第一次写入污染)。 */
export function createRoomSystemsState(): RoomSystemsState {
  return {
    crops: new Map<string, CropCellState>(),
    gallery: createGallery(),
    ranchPets: [],
    lastRanch: null,
    lastBrew: null,
    settled: createSettlementLedger(),
    harvest: [],
    sortFilters: [],
    growthTicks: 0,
  };
}

/**
 * 播种(耕地格 → 作物)。
 *
 * 只校验**可判定**的三件事:坐标有限、`cropId` 是正整数、成熟天数是正数。
 * 「这块地是不是耕地(301 肥沃农田耕地)」由**调用方**判 —— 本函数不认识地形
 * (它是纯函数;世界里那一格真伪由 `WorldSim.plantCrop` 用 `blockAt`/`grid` 判)。
 */
export function plantCrop(
  st: RoomSystemsState,
  x: number,
  y: number,
  cropId: number,
  matureDays: number = CROP_MATURE_DAYS,
): { ok: boolean; reason: string } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: `坐标非法(${x},${y})` };
  }
  if (!Number.isInteger(cropId) || cropId <= 0) {
    return { ok: false, reason: `作物 id 非法(${cropId})` };
  }
  if (!Number.isFinite(matureDays) || matureDays <= 0) {
    return { ok: false, reason: `成熟天数必须为正(${matureDays})` };
  }
  const key = cropKey(x, y);
  if (st.crops.has(key)) {
    return { ok: false, reason: `这一格已经有作物(#${st.crops.get(key)!.cropId})` };
  }
  st.crops.set(key, {
    x: Math.floor(x),
    y: Math.floor(y),
    cropId,
    matureDays,
    /* 播种即浇一次水:耕地刚开垦(`301` 的字面量「靠近水源自动变湿润」),
       之后每天的水分由 `morningMoisture` 决定。 */
    moisture: 1,
    progress: 0,
  });
  return { ok: true, reason: '已播种' };
}

/** 这一格的作物(没有 ⇒ `undefined`)。 */
export function cropAt(st: RoomSystemsState, x: number, y: number): CropCellState | undefined {
  return st.crops.get(cropKey(x, y));
}

/** 一帧(或一天的一部分)的温室输入。 */
export interface GrowInput {
  /**
   * 这一帧推进了**多少天**(0..1 之间为一次慢帧;`1` = 整整一天)。
   *
   * 为什么用「天的一部分」而不是秒:`cellGrowth` 的口径是
   * `1 / matureDays` **每天**,再乘 `dayFraction` 就不会引入第二个速率常数。
   * 慢帧调用传 `SIM_SLOW_DT / WORLD_DAY_SEC`,判据传 `1`(一天)——
   * 两者走的是**同一个实现**。
   */
  dayFraction: number;
  /** 现在是不是夜里(世界侧 `isNightAtHour(hourOfDay())` 判好再传)。 */
  night: boolean;
  /** 天气(世界侧持有的天气状态;缺省 CLEAR)。 */
  weather: Weather;
  /** 该格是否在温室里(`AUTO_GREENHOUSE` 房间识别结果)。 */
  isGreenhouse(x: number, y: number): boolean;
  /** 该格是否在「通水的自动洒水器(426)」覆盖范围内。 */
  /** 该格是否在「通水的自动洒水器(426)」覆盖范围内。 */
  hasSprinkler(x: number, y: number): boolean;
  /**
   * 产物**落货口**(世界侧注入):把这一份产物真的写进世界。
   *
   * - `'GROUND'`   已落到地面 / `'INVENTORY'` 已进背包 ⇒ 账上记 `landed`;
   * - `'NONE'`     世界收不下 ⇒ 记 `unlanded`(绝不假装落进去了);
   * - **缺省**(老调用方 / 纯函数判据)⇒ `'NONE'`:成熟仍会摘走作物并记账,
   *   但账上写明「这一份没落地」—— 于是「产物只进内存」是**可观测**的,
   *   而不是修前那种「账上是好消息、世界是空的」。
   */
  deliverHarvest?(h: HarvestDelivery): HarvestLanding;
}

/** 一次温室推进的回执。 */
export interface GrowResult {
  /** 今天真的长了(或该长)的格数。 */
  grown: number;
  /** 本帧成熟并被收下来的作物(带 429 分拣道号与**落地去向**)。 */
  matured: HarvestRow[];
  /** 本帧成熟、但**没能落进世界**的份数(`> 0` ⇒ 那一份只存在于收获账里)。 */
  unlanded: number;
  /** 每一份没落地的理由(坐标 / 作物 / 为什么落不下)。 */
  unlandedReasons: string[];
}

/**
 * 温室推进:**早上浇水 → 这格今天长多少 → 成熟即按 429 分拣收下**。
 *
 * ```
 * 水分 = morningMoisture(温室内有洒水器 ⇒ 浇到 1;否则维持原值)
 * 生长 = cellGrowth(...).growthPerDay × dayFraction
 * 成熟 = progress + 生长 ≥ 1
 *   ⇒ 作物→产物(`greenhouse.ts:cropProductIdOf`)→ 道号 = sortHarvest(产物 id, filters)
 *   ⇒ 交给落货口 `deliverHarvest`(世界侧注入)⇒ 记 `landed` / `unlanded`
 * ```
 *
 * ★ WS-FND-125(P0):修前到这里就结束了 —— `st.harvest.push(row)` 是链路的**终点**,
 *   作物被删掉而产物只活在数组里(地面没有、背包没有、428/430 都抓不到)。
 *   现在「摘走」与「交付」是同一件事:`landed` 由世界回报,`unlanded` 把没接住的
 *   那一份**摆到账上**(而不是静默消失)。
 *
 * ⚠️ 成熟判据**在这里**(而不是直接用 `cellGrowth` 的 `ready`):后者按
 *   「整整一天」算,而本函数要支持 `dayFraction < 1` 的慢帧。`dayFraction === 1`
 *   时两者逐位相同(判据用手算的 1/2、1/4 把这一点钉住)。
 *
 * ★ 负对照:露天 + 夜里 ⇒ `growthPerDay = 0` ⇒ `matured` 恒空
 *   (温室的「全天候透光」是唯一的差别,见 `greenhouse.ts` 文件头)。
 */
export function growCrops(st: RoomSystemsState, input: GrowInput): GrowResult {
  const out: GrowResult = { grown: 0, matured: [], unlanded: 0, unlandedReasons: [] };
  const frac = Number.isFinite(input.dayFraction) ? input.dayFraction : 0;
  if (frac <= 0 || st.crops.size === 0) return out;

  for (const [key, cell] of [...st.crops]) {
    const inGreenhouse = input.isGreenhouse(cell.x, cell.y);
    const sprinkler = input.hasSprinkler(cell.x, cell.y);
    /* 早上浇水(`morningMoisture` 是幂等的:不在温室/没有洒水器 ⇒ 原值)。 */
    const moisture = morningMoisture({ moisture: cell.moisture, inGreenhouse, sprinkler });
    const r = cellGrowth({
      cell: {
        cropId: cell.cropId,
        matureDays: cell.matureDays,
        moisture,
        progress: cell.progress,
      },
      night: input.night,
      weather: input.weather,
      inGreenhouse,
      sprinkler,
    });
    const grown = r.growthPerDay * frac;
    if (grown > 0) out.grown += 1;
    const progress = cell.progress + grown;
    if (progress >= 1 - 1e-9) {
      /* 成熟:从耕地上摘走,并按 429 的过滤规则分道;产物由下面交给世界。 */
      st.crops.delete(key);
      /* ★ 产物 id 由「作物 → 产物」映射决定(内容表查名字),**不是** `cropId`:
         否则 429 的过滤表按产物 id 写就永远不命中(见 greenhouse.ts 该表头)。 */
      const productId = cropProductIdOf(cell.cropId);
      /* 没登记产物的作物:退回「收获的就是它自己」这一口径(`sortHarvest` 的
         既有语义 —— 判据 WS-FND-77 的露水甜莓就是这种)。 */
      const sortId = productId === null ? cell.cropId : productId;
      const delivery: HarvestDelivery = {
        x: cell.x,
        y: cell.y,
        cropId: cell.cropId,
        productId,
        count: HARVEST_YIELD,
        lane: sortHarvest(sortId, st.sortFilters),
      };
      /* ★ P0 修点:产物**真的落进世界**(落货口由世界侧注入;没有产物 id 的
         作物无处可落,如实记 `unlanded`,不编一件物品出来)。 */
      const landed: HarvestLanding = productId === null
        ? 'NONE'
        : (input.deliverHarvest !== undefined ? input.deliverHarvest(delivery) : 'NONE');
      if (landed === 'NONE') {
        out.unlanded += 1;
        out.unlandedReasons.push(`(${cell.x},${cell.y}) 作物 #${cell.cropId}:`
          + (productId === null
            ? '内容表没有这件作物的产物(`greenhouse.ts:CROP_PRODUCT_NAME_BY_CROP`)'
            : '世界没有落货口 `deliverHarvest`'));
      }
      const row: HarvestRow = { ...delivery, landed };
      st.harvest.push(row);
      out.matured.push(row);
      continue;
    }
    st.crops.set(key, { ...cell, moisture, progress });
  }
  if (out.grown > 0) st.growthTicks += 1;
  return out;
}

/**
 * 牧场日结(**薄封装**,唯一实现在 `ranch.ts`,这里只记账)。
 *
 * 为什么需要这一层:世界侧持有的是「圈养名单投影 + 地面上的饲料」,
 * 而 `settleRanchDay` 是纯函数;把「调用 + 记回执」放在这里,
 * `WorldSim` 就只有**一个**调用点(不做第二份结算)。
 */
export function settleRanch(
  st: RoomSystemsState,
  animals: readonly RanchAnimal[],
  feed: Readonly<Record<number, number>>,
  days: number,
): RanchDayResult {
  const r = settleRanchDay({ animals, feed, days });
  st.lastRanch = r;
  return r;
}

/**
 * **幂等**日结(WS-FND-96 / 审计 P2-3):同一个 `(ECO_RANCH, day)` 只成功一次。
 *
 * 与 `settleRanch` 的唯一差别:多一张台账(`st.settled`)。重放时
 * **不写** `st.lastRanch`(回执仍是那一天成功的那份),饲料与产出都不动 ——
 * 世界侧把 `accepted: false` 当成「这一拍没有牧场账」整笔跳过。
 *
 * @param day 房间内的第几天(0 起);**幂等键的一维**,由调用方喂(不读时钟)
 */
export function settleRanchOnce(
  st: RoomSystemsState,
  day: number,
  animals: readonly RanchAnimal[],
  feed: Readonly<Record<number, number>>,
  days: number,
): RanchOnceOutcome {
  const out = settleRanchDayOnce(st.settled, { animals, feed, days, day });
  if (out.accepted) st.lastRanch = out.result;
  return out;
}

/**
 * 产出物的物品 id(**内容表是唯一事实源**;表里没有 ⇒ `null`)。
 *
 * 转发 `ranch.ts` 的 `resolveItemByName`,而不是自己建一张
 * 「毛团 = 某 id」的表 —— 那张表正是「补全缺口」的入口(见 ranch.ts:27-32)。
 */
export function producedItemIdOf(name: string): number | null {
  return resolveItemByName(name);
}

/** 炼金(薄封装:唯一实现在 `alchemy_lab.ts`)。 */
export function brewInLab(st: RoomSystemsState, input: BrewInput): BrewOutcome {
  const out = brewAndRecord(st.gallery, input);
  if (out.ok) {
    st.gallery = out.gallery;
    st.lastBrew = out.entry;
  }
  return out;
}

/** 带**订单号**的炼金输入(订单号 = 调用方给的权威身份;同一单只出一次账)。 */
export interface BrewOrderInput extends BrewInput {
  orderId: string;
}

/**
 * 幂等炼金的结果。`accepted: false` ⇒ **陈列馆逐字段不变**(没有新行、没有
 * `craftCount + 1`),`st.lastBrew` 也仍是上一次成功的那行。
 */
export type BrewOnceOutcome =
  | { accepted: true; key: string; outcome: Extract<BrewOutcome, { ok: true }> }
  | { accepted: false; key: string | null; replayed: boolean; reason: string };

/**
 * **幂等**炼金(WS-FND-96 / 审计 P2-3):同一个 `(ALCHEMY_LAB, 订单号)` 只成功一次。
 *
 * ★ 与 `brewInLab` 的差别正是审计登记的那一条:`brewInLab` 重复调用会把
 *   `craftCount` **再加一**(`alchemy_lab.ts` 的 `existing !== undefined` 分支 ——
 *   那是「玩家真的又炼了一次」的语义),而**报文重放 / 客户端重发**不是又炼了一次
 *   ⇒ 重放必须被拒,且陈列馆逐字段不变。
 *
 * ★ 纪律 2(`idempotency.ts` 文件头):只有 `brewAndRecord` 真的成功才占键,
 *   材料不合法等失败**不占**订单号 —— 修好材料后用同一单号重试仍然成功。
 */
export function brewInLabOnce(st: RoomSystemsState, input: BrewOrderInput): BrewOnceOutcome {
  const key = settleKeyOf(SETTLEMENT_ROOMS.ALCHEMY_LAB, { kind: 'ORDER', orderId: input.orderId });
  if (key === null) {
    return {
      accepted: false,
      key: null,
      replayed: false,
      reason: `订单号非法(${JSON.stringify(input.orderId)})⇒ 无法判重,不炼`,
    };
  }
  const seenAt = settlementSeenAt(st.settled, key);
  if (seenAt !== undefined) {
    return {
      accepted: false,
      key,
      replayed: true,
      reason: `订单 ${input.orderId} 已在 ${seenAt} 结算过(幂等键 ${key})⇒ 拒绝,陈列不变`,
    };
  }
  const out = brewAndRecord(st.gallery, input);
  if (!out.ok) {
    return { accepted: false, key, replayed: false, reason: out.reason };
  }
  /* 先占键再落状态:两件事都不抛,顺序只影响「万一占键失败时别写脏馆」。 */
  const claim = claimSettlement(st.settled, key, input.at);
  if (!claim.ok) {
    return { accepted: false, key, replayed: true, reason: claim.reason };
  }
  st.gallery = out.gallery;
  st.lastBrew = out.entry;
  return { accepted: true, key, outcome: out };
}

/** 537 陈列投影的一行(**只读**,给网络层/客户端用). */
export interface GalleryDisplayRow {
  recipeHash: string;
  discovererName: string;
  itemName: string;
  itemCategory: string;
  craftCount: number;
  firstAt: number;
}

/**
 * 把陈列馆投影成**可广播的数组**(537「自动陈列全服首创并展示冠名证书」)。
 *
 * 排序用 `galleryOrder`(先发现先陈列),不在这里重写排序规则 ——
 * 「首创」是不变的历史,不是排行榜(见 alchemy_lab.ts:208-214)。
 */
export function galleryDisplay(st: RoomSystemsState): GalleryDisplayRow[] {
  const rows: GalleryDisplayRow[] = [];
  for (const e of st.gallery.rows.values()) {
    rows.push({
      recipeHash: e.recipeHash,
      discovererName: e.discovererName,
      itemName: e.itemName,
      itemCategory: e.itemCategory,
      craftCount: e.craftCount,
      firstAt: e.firstAt,
    });
  }
  rows.sort((a, b) => (a.firstAt !== b.firstAt
    ? a.firstAt - b.firstAt
    : (a.recipeHash < b.recipeHash ? -1 : a.recipeHash > b.recipeHash ? 1 : 0)));
  return rows;
}

/* ═══════════════ 料理 3 字段 → 物理设置口的**唯一换算点** ═══════════════ */

/** `mergeFoodBuffs` 的产物形状(只取本文件要的那四个字段)。 */
export interface FoodStatModsLike {
  moveMul: number;
  gravityMul: number;
  jumpMul: number;
  gatherMul: number;
}

/** 一个玩家要推给物理层的三个乘子;`null` = 该字段中性(要**撤掉**设置)。 */
export interface FoodPhysicsTarget {
  /** `moveMul`;`null` ⇒ `clearSpeedCap`。 */
  speedCapMul: number | null;
  /** `gravityMul`;`null` ⇒ `clearGravityMul`。 */
  gravityMul: number | null;
  /** `jumpMul`;`null` ⇒ `clearJumpMul`。 */
  jumpMul: number | null;
}

/**
 * 把 buff 合并结果换算成**物理设置口要的三个乘子**。
 *
 * ```
 * moveMul     ≠ 1 ⇒ 推上限乘子(速度上限 = BASE_MOVE_SPEED × mul,由物理层收)
 * gravityMul  ≠ 1 ⇒ 推重力乘子(609 = 0.30)
 * jumpMul     ≠ 1 ⇒ 推起跳乘子(604 = 1.50)
 * 中性 1      ⇒ null(物理层删记录,恢复「接线前」的行为)
 * ```
 *
 * ⚠️ 中性值必须是 **null 而不是 1**:物理层的三张旁表以「有没有记录」
 *   区分「中性」与「已设置」(同 `muOverride` 的中性值 0,见
 *   `WorldSim.syncFoodFriction` 的注释)。写 1 进去会让旁表永远非空,
 *   而「有没有 buff」这个可观测事实就被抹平了。
 */
export function foodPhysicsOf(mods: FoodStatModsLike): FoodPhysicsTarget {
  const pick = (v: number): number | null =>
    (Number.isFinite(v) && v > 0 && v !== 1 ? v : null);
  return {
    speedCapMul: pick(mods.moveMul),
    gravityMul: pick(mods.gravityMul),
    jumpMul: pick(mods.jumpMul),
  };
}

/**
 * 采集乘子(`gatherMul`:602「伐木与采矿速度 +20%」)。
 *
 * 为什么不在这里乘件数:`breakBlock` 一次只产出 1 件(obj id = 1 件),
 * 「+20% 的速度」在**没有采集时长**的模型里没有可乘的量纲。⇒ 世界侧只把
 * 该乘子**归属**到动作发起者(`breakBlock(x, y, actorId)` 的回执里带它),
 * 真正的件数放大要 owner 裁决(整数件数?概率双倍?)—— 见
 * `items.ts` 的 603 `dropDoubleChance` 那一族。**不编规则**。
 */
export function gatherMulOf(mods: FoodStatModsLike): number {
  const v = mods.gatherMul;
  return Number.isFinite(v) && v > 0 ? v : 1;
}