/**
 * WS-FND-119 —— 三个房间系统「进料口」的**动作侧校验**(纯函数,零 IO)。
 *
 * ## 为什么有这个文件(第六轮实测 P0)
 *
 * `WorldSim` 的三个写入口在 `server/**` 内**零调用**,唯一调用方是 `tests/**`:
 *
 * ```
 * setRanchPets   圈养名单 —— 恒空 ⇒ settleRanchIfDayChanged 每慢帧空跑(牧场无产出)
 * plantCrop      耕地作物 —— 恒空 ⇒ advanceRoomSystems 的温室分支连入参都不建
 * setSortFilters 429 过滤 —— 恒空 ⇒ sortHarvest 恒返 -1(分拣道恒 -1)
 * ```
 *
 * ⇒ 校验全绿、回执全对、世界里**什么都没发生**(本仓「实现完整、生产零消费」家族
 * 的第 11 例)。修法**只在动作层**:把三个入口接到真实动作路径上
 * (`BREED_TAME` 的 `RANCH` 子操作 / `PLACE_AUTOMATION` 的播种与 429 分支)。
 *
 * 判定:本文件(无 IO、无时钟、不看世界);**世界写入仍是 `WorldSim` 的那一个方法**
 * (`setRanchPets` / `plantCrop` / `setSortFilters`)—— 这里不改写它们的实现,
 * 只回答「这个请求合不合法、合进去之后名单长什么样」。
 *
 * ## 数字纪律:一切阈值都来自既有出处(**本文件不新造平衡数字**)
 *
 * | 数 | 出处 |
 * | :--- | :--- |
 * | 谁能进牧场 | `ranch.ts` 的 `RANCH_PRODUCE_BY_SPECIES`(手册 529 点名的两种) |
 * | 亲和下限 | `ranch.ts` 的 `RANCH_AFFINITY_MIN` |
 * | 哪些物品能播种 | 内容表 `note` 自称「耕地播种收获 / 耕种收获」的条目(见 `SOWABLE_ITEM_IDS`) |
 * | 道号语义 | `greenhouse.ts` 的 `SortFilter.lane`(负数是 `SORT_PASS_THROUGH` 的语义 ⇒ 过滤规则不许用) |
 *
 * ⚠️ 「哪些种子能种」用的是**内容表自己的措辞**,不是本文件编的一张作物表:
 *   `SOWABLE_ITEM_IDS` 每次加载时从 `ITEM_LIST` 的 `note` 现算(当前命中
 *   #123 黄金小麦 / #126 爆裂火椒 —— 全表只有这两条写了「播种/耕种」)。
 *   内容表将来若有了正式的 `sowable` 标记,`SOWABLE_NOTE_MARKERS` 就该退役 ——
 *   而不是在这里再加一张手写名单。
 */

import { ITEM_LIST } from '../../../shared/constants/items.ts';
import type { SortFilter } from './greenhouse.ts';

/* ═════════════════ 0. P1 登记:本接线**不使用** `mobs/taming.ts` ═════════════════ */

/**
 * 第六轮 P1:`server/src/mobs/taming.ts` 的六个导出(`feedPet` / `tickRanch` /
 * `deployPet` …)全仓 0 import,它是 `scripts/verify.ts` 的 `UNREACHABLE_EXEMPT`
 * 成员。**本轮的接线没有用它,故白名单项保持原样**(不移除、不改 `verify.ts` ——
 * 那不在本线写域)。登记理由:
 *
 * ```
 * 1 圈养名单缺的不是「taming.ts 的实现」,而是「谁把在圈事实写进世界」;
 *   本轮补的正是那一步(BREED_TAME 的 RANCH 子操作 → setRanchPets)。
 * 2 它的容器是按玩家存的(没有世界/房间键),而 ranchPets 要的是**每房间**的
 *   一份投影 ⇒ 直接搬过来还得再造一层房间键,那是一份新设计,不是接线。
 * 3 一旦 import 它,UNREACHABLE_EXEMPT 就变成**陈旧条目**(门禁会报「白名单
 *   里的文件现在可达」),而修那条要动 scripts/verify.ts 与 README.md。
 * ```
 *
 * ⇒ 它仍然是「实现存在 + 宿主缺失」。要真正接上,需要 owner 裁决「宠物容器住哪」
 *   (房间侧一份?世界侧一份?),改完再把白名单项一并摘掉。
 */
import { RANCH_AFFINITY_MIN, RANCH_PRODUCE_BY_SPECIES, type RanchAnimal } from './ranch.ts';

/* ═════════════════ 1. 动作层能对世界要到的三个写口 ═════════════════ */

/**
 * 三个**写口**(运行期由 `WorldSim` 提供;`createHost()` 直接把 `WorldSim` 实例
 * 交出去,所以 `ctx.host` 就是它)。
 *
 * ## 为什么是「局部窄类型 + 全部可选」
 *
 * 正式契约是 `net/room.ts` 的 `WorldSaveHost`,**本线不改它**(不在写域)⇒
 * 照 `actions/place_automation.ts` 的 `SizeCapableHost` / `actions/sleep.ts` 的
 * `roomEffectOf` 同一先例:用局部窄类型**读**运行期真的有的那几个成员。
 *
 * ⚠️ 全可选是刻意的:老宿主 / 手搓 `ctx` 桩没有这些成员。此时调用方必须
 *   **显式**回 `NOT_IMPLEMENTED`(零副作用),不许「没有写口就当作写成功」——
 *   那正是本文件要消灭的静默形态。
 */
export interface RoomSystemsPort {
  /** 圈养名单(整份覆盖;权威在 `mobs/taming.ts` 的在圈标记,这里是投影)。 */
  setRanchPets?(animals: readonly RanchAnimal[]): void;
  /** 当前圈养名单(拷贝)。 */
  ranchPets?(): RanchAnimal[];
  /** 播种:只有耕地(内容表 301)上能种,判定的世界侧在 `WorldSim.plantCrop`。 */
  plantCrop?(x: number, y: number, cropId: number, matureDays?: number): { ok: boolean; reason: string };
  /** 某一格的作物(`undefined` = 空地);`matureDays` 给回执用(天数从世界读回)。 */
  cropAt?(x: number, y: number): { cropId: number; matureDays?: number } | undefined;
  /** 429 的过滤规则(整份覆盖;空 = 一切 `-1` 原样留在带上)。 */
  setSortFilters?(filters: readonly SortFilter[]): void;
  /** 当前过滤规则(拷贝)。 */
  sortFilters?(): SortFilter[];
}

/**
 * 把 `ctx.host` 读成写口(不是第二份实现,也不伪造能力:成员缺就是缺)。
 *
 * `host: unknown` 是为了让本文件**不 import `net/room.ts`** —— 那会把
 * `systems/** → net/**` 的依赖方向打开(本仓 systems 层只吃 `shared/**` 与自身)。
 */
export function roomSystemsPortOf(host: unknown): RoomSystemsPort | null {
  if (host === null || typeof host !== 'object') return null;
  return host as RoomSystemsPort;
}

/* ═════════════════ 2. 牧场:谁能进圈 ═════════════════ */

/** 一次进料的结论。`ok === false` ⇒ `next` 与入参**逐字段相同**(零副作用)。 */
export interface IntakeOutcome<T> {
  ok: boolean;
  /** 人读理由(成功时是「做了什么」)。 */
  reason: string;
  /** 合进去之后的那一份(**新数组**;失败时与原内容逐字段相同)。 */
  next: T;
}

/** 要进牧场的一只宠物:`petId` 是**去重键**(同一只宠物进两次只算一只)。 */
export interface RanchIntakePet {
  petId: string;
  speciesId: string;
  /** 亲和度 0..1(由调用方按既有阈值换算好;本文件只钳制与校验)。 */
  affinity: number;
}

/** 手册 529 点名的牧场物种(键序 = `ranch.ts` 的登记序)。 */
const RANCH_SPECIES: readonly string[] = Object.keys(RANCH_PRODUCE_BY_SPECIES);

/**
 * 把一只宠物合进圈养名单。
 *
 * ```
 * speciesId 不是手册点名的两种       ⇒ 拒(内容表里有它也不收:529 只写羊与水豚)
 * petId 空串 / affinity 非有限        ⇒ 拒(先把坏的报文挡住)
 * affinity < RANCH_AFFINITY_MIN      ⇒ 拒(ranch.ts 的自动进食阈值,同一把尺子)
 * 同一 petId 已在名单里              ⇒ 就地更新(不新增一行:否则反复「送进牧场」
 *                                       会把同一只羊剪成 N 只,N 倍产出)
 * 否则                               ⇒ 追加一行
 * ```
 *
 * ★ 负对照的地基:任何一条不过都**不改**名单(返回的 `next` 与入参等长),
 *   于是「被拒的进料」在世界上完全不可见 —— 与 `ranch.ts` 的
 *   「没有饲料 ⇒ 不产出」同一姿态。
 */
export function addPetToRanch(
  roster: readonly RanchAnimal[],
  pet: RanchIntakePet,
): IntakeOutcome<RanchAnimal[]> {
  const next: RanchAnimal[] = roster.map((a) => ({ ...a }));
  const speciesId = typeof pet.speciesId === 'string' ? pet.speciesId : '';
  if (!RANCH_SPECIES.includes(speciesId)) {
    return {
      ok: false,
      reason: `${speciesId || '(空)'} 不进牧场 —— 手册 529 点名的只有 ${RANCH_SPECIES.join(' / ')}`,
      next,
    };
  }
  const petId = typeof pet.petId === 'string' ? pet.petId.trim() : '';
  if (petId === '') {
    return { ok: false, reason: '需要 petId(非空字符串)⇒ 否则同一只宠物会被算成多只', next };
  }
  const affinity = Number.isFinite(pet.affinity) ? Math.min(1, Math.max(0, pet.affinity)) : NaN;
  if (!Number.isFinite(affinity)) {
    return { ok: false, reason: `亲和度非法(${String(pet.affinity)})⇒ 不进牧场`, next };
  }
  if (affinity < RANCH_AFFINITY_MIN) {
    return {
      ok: false,
      reason: `亲和 ${affinity} 未达 ${RANCH_AFFINITY_MIN}(ranch.ts 的自动进食阈值)⇒ 还没养熟,不进牧场`,
      next,
    };
  }
  const row: RanchAnimal = { petId, speciesId, affinity };
  const at = next.findIndex((a) => a.petId === petId);
  if (at >= 0) {
    next[at] = row;
    return { ok: true, reason: `宠物 ${petId} 已在圈里 ⇒ 更新为 ${speciesId}@${affinity}(不新增一行)`, next };
  }
  next.push(row);
  return { ok: true, reason: `宠物 ${petId} 进牧场(${speciesId}@${affinity});圈里共 ${next.length} 只`, next };
}

/* ═════════════════ 3. 429 智能分拣:过滤规则 ═════════════════ */

/** 要登记的一条过滤规则(`lane` = 道号,`itemIds` = 分到这道的那几件)。 */
export interface SortFilterIntake {
  lane: number;
  itemIds: readonly number[];
}

/** 内容表里的合法物品 id(拒绝「编号空投」,同 `actions/material.ts`)。 */
const ITEM_ID_SET: ReadonlySet<number> = new Set(ITEM_LIST.map((i) => i.id));

/**
 * 把一条过滤规则合进 429 的规则表。
 *
 * ```
 * lane 不是整数 / 负数        ⇒ 拒(`-1` 是 SORT_PASS_THROUGH 的语义,不是道号)
 * itemIds 空 / 含非整数 / 不在内容表 ⇒ 拒(不按名字换算、不猜 id)
 * 同一 lane 已有规则         ⇒ 就地替换(429 是「这一道收哪几件」,不是追加多份)
 * 否则                      ⇒ 追加
 * ```
 *
 * ★ 顺序即语义:`sortHarvest` 走「第一条命中」,所以**替换**而不是覆盖整表 ——
 *   别的道号的规则必须原样保留(多台 429 各管一道)。
 */
export function addSortFilter(
  filters: readonly SortFilter[],
  filter: SortFilterIntake,
): IntakeOutcome<SortFilter[]> {
  const next: SortFilter[] = filters.map((f) => ({ lane: f.lane, itemIds: [...f.itemIds] }));
  const lane = filter.lane;
  if (!Number.isInteger(lane) || lane < 0) {
    return {
      ok: false,
      reason: `道号必须是非负整数(实测 ${String(lane)};负数是 sortHarvest 的「不分拣」语义,不能当道号)`,
      next,
    };
  }
  const itemIds: number[] = [];
  for (const raw of filter.itemIds) {
    if (!Number.isInteger(raw) || raw <= 0) {
      return { ok: false, reason: `过滤物品必须是正整数物品 id(实测 ${String(raw)})`, next };
    }
    if (!ITEM_ID_SET.has(raw)) {
      return { ok: false, reason: `物品 ${raw} 不在冻结内容表里 ⇒ 定不出这一道收什么`, next };
    }
    if (!itemIds.includes(raw)) itemIds.push(raw);
  }
  if (itemIds.length === 0) {
    return { ok: false, reason: '需要至少一件过滤物品(itemIds 为空 ⇒ 这一道什么都收不到)', next };
  }
  itemIds.sort((a, b) => a - b);
  const at = next.findIndex((f) => f.lane === lane);
  const row: SortFilter = { lane, itemIds };
  if (at >= 0) {
    next[at] = row;
    return { ok: true, reason: `第 ${lane} 道已有规则 ⇒ 替换为 [${itemIds.join(',')}]`, next };
  }
  next.push(row);
  return { ok: true, reason: `登记第 ${lane} 道 ⇒ [${itemIds.join(',')}];共 ${next.length} 条规则`, next };
}

/* ═════════════════ 4. 温室:哪些物品能播种 ═════════════════ */

/**
 * 内容表里「这是一颗种子」的措辞。
 *
 * 为什么不用标签:内容表**没有**「种子」这个 tag(`种子` 只出现在 #210 园艺剪的
 * note 里,那是工具不是作物);唯一写「这块地能种下它」的地方就是
 * `note` 的「耕地播种收获 / 耕种收获」两句。⇒ 本表按那两句现算,
 * 命中集合见 `SOWABLE_ITEM_IDS`。
 */
export const SOWABLE_NOTE_MARKERS: readonly string[] = Object.freeze(['播种', '耕种']);

/**
 * 能播种的物品 id(模块加载时从内容表现算一次)。
 *
 * ⚠️ 它不是手写名单:改内容表那一行 note ⇒ 这里跟着变。判据
 *   (`tests/WS-FND-119`)同时钉「命中的那几件能种」与「别的东西不能种」,
 *   于是「表一变、名单跟着变」是可观测的,而不是两张表各说各话。
 */
export const SOWABLE_ITEM_IDS: ReadonlySet<number> = new Set(
  ITEM_LIST.filter((i) => SOWABLE_NOTE_MARKERS.some((m) => (i.note ?? '').includes(m))).map((i) => i.id),
);

/**
 * 这件物品能不能当种子;不能 ⇒ 给出理由(不是布尔,因为拒绝理由要能说清
 * 「不在内容表」与「在表里但不是种子」的区别 —— 两者对玩家是不同的答案)。
 */
export function sowableReasonOf(itemId: number): string | null {
  if (!Number.isInteger(itemId) || itemId <= 0) return `物品 id 非法(${itemId})`;
  if (!ITEM_ID_SET.has(itemId)) return `物品 ${itemId} 不在冻结内容表里`;
  if (!SOWABLE_ITEM_IDS.has(itemId)) {
    return `物品 ${itemId} 不是可播种的种子(内容表 note 里没有「${SOWABLE_NOTE_MARKERS.join('/')}」)`;
  }
  return null;
}