/**
 * WS-FND-75 / 【生态牧场】(`ECO_RANCH`)的**日结**系统 —— 纯函数,零 IO。
 *
 * ## 为什么有这个文件
 *
 * 手册 §3.8 与内容表 `529 牧场动物自动饲育槽` 的原句是:
 * 「圈养的云朵绵羊与水豚会**自动进食**并**每日产出**毛团/温泉橘」。
 * 而 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION.ECO_RANCH` 此前写着
 * 「需饲养与产出的日结系统,仓库里没有 ⇒ 未实装」—— 玩家盖出牧场、把动物领回家,
 * 第二天什么都拿不到,而门禁全绿。
 *
 * ⇒ 本文件就是那句承诺的**可判定实现**:一天结束时该产多少、吃多少饲料。
 *
 * ## 为什么是纯函数(不碰 `WorldSim`)
 *
 * 与 `rooms/effects.ts` 同一纪律:日结只吃「谁在圈里、亲和多少、过了几天、
 * 槽里有多少饲料」这四个事实,**不读时钟、不写世界**。谁在什么时候调它
 * (慢帧?跨日事件?)是接线方的事,不是判定的事。
 *
 * ## 全部数字的来源(不发明)
 *
 * | 事实 | 出处 |
 * | :--- | :--- |
 * | 只有云朵绵羊与水豚会进牧场 | `529` 的 `note`(冻结层) |
 * | 饲料是哪一件 | 内容表 `MobDef.tameItem`(绵羊=123 黄金小麦 / 水豚=122 金丝蜜桃) |
 * | 产出叫什么 | `529` 的 `note`:毛团 / 温泉橘 |
 * | 产出的物品 ID | **内容表按名字查**:`毛团`/`温泉橘` 目前**没有**对应物品 ⇒ 如实返回 `null` + 进 `unresolved`,**不编 ID** |
 *
 * ⚠️ 最后一条是本模块最容易被"补全"的地方:看到 `itemId: null` 的第一反应是
 * 从 101~130 里挑一个「差不多」的自然物塞进去。那是**发明内容** —— 一张
 * 内容表的事实被代码悄悄改写,而内容表本身仍然没有那两件东西。
 * 缺口就该以 `null` + `unresolved` 的形式浮在脸上。
 */

import { MOB_BY_ID } from '../../../shared/constants/mobs.ts';
import { ITEM_LIST } from '../../../shared/constants/items.ts';
import {
  SETTLEMENT_ROOMS,
  claimSettlement,
  settleKeyOf,
  settlementSeenAt,
  type SettlementLedger,
} from './idempotency.ts';

/**
 * 本实现在 `rooms/effects.ts` 的 `ROOM_EFFECT_DECISION` 里登记的身份。
 *
 * `module` 必须是**仓库相对路径**且真的存在(`tests/WS-FND-75` 用 `existsSync` 核),
 * `entry` 是接线方要调的那个函数 —— 两者一起把「已实装」变成可判定的事实。
 */
export const RANCH_SYSTEM = Object.freeze({
  roomKey: 'ECO_RANCH',
  module: 'server/src/systems/ranch.ts',
  entry: 'settleRanchDay',
});

/** 每只达标动物每天吃掉的饲料份数(1 份/天:内容表的 `tameItem` 一次一件)。 */
export const RANCH_FEED_PER_DAY = 1;

/**
 * 亲和度下限(口径 0..1):低于它 = 还没养熟 ⇒ **不进牧场**,
 * 既不消耗饲料也不产出(否则玩家把野生动物往槽里一丢就能白拿产出)。
 *
 * 取值与炼金门禁的中性亲和度同口径(0.7 = 「不倾斜」),这样两个系统对
 * 「养熟/契合」用的是同一把尺子。
 */
export const RANCH_AFFINITY_MIN = 0.7;

/** 达标动物每天各产出 1 份(日结,不按小时折算)。 */
export const RANCH_PRODUCE_PER_DAY = 1;

/**
 * 手册点名的两种产出:**按物种**给名字,不按物种给 ID。
 *
 * 名字是手册字面量,ID 是内容表的事实 —— 两者分开,内容表补上物品之后
 * `resolveItemByName` 自动就能查到,不必改本表。
 */
export const RANCH_PRODUCE_BY_SPECIES: Readonly<Record<string, string>> = Object.freeze({
  mob_sheep: '毛团',
  mob_capybara: '温泉橘',
});

/** 内容表的「名字 → ID」索引(只在模块加载时建一次)。 */
const ITEM_ID_BY_NAME: ReadonlyMap<string, number> = new Map(ITEM_LIST.map((i) => [i.name, i.id]));

/**
 * 按**内容表原名**查物品 ID;内容表没有这件东西就返回 `null`。
 *
 * 唯一允许的产出 ID 来源 —— 不查就不许有 ID。
 */
export function resolveItemByName(name: string): number | null {
  return ITEM_ID_BY_NAME.get(name) ?? null;
}

/** 圈养中的一只动物:物种 id + 亲和度(0..1)。 */
export interface RanchAnimal {
  speciesId: string;
  affinity: number;
}

/** 日结的一行产出。`itemId === null` ⇒ 内容表还没有这件物品(见 `unresolved`)。 */
export interface RanchProduceRow {
  speciesId: string;
  name: string;
  itemId: number | null;
  count: number;
}

/** 日结的一行饲料消耗。 */
export interface RanchFeedRow {
  itemId: number;
  count: number;
}

/** 一次日结的输入:圈里有哪些动物、槽里有多少饲料(物品 ID → 件数)、过了几天。 */
export interface RanchDayInput {
  animals: readonly RanchAnimal[];
  feed: Readonly<Record<number, number>>;
  days: number;
}

/** 一次日结的输出。 */
export interface RanchDayResult {
  /** 实际结算的天数(向下取整、负数归零)。 */
  days: number;
  /** 每只动物的产出(按输入顺序,不合并)。 */
  produce: readonly RanchProduceRow[];
  /** 饲料消耗(按物品 ID 聚合)。 */
  feedConsumed: readonly RanchFeedRow[];
  /** 至少吃到一天饲料的动物数。 */
  fedCount: number;
  /** 有「饿肚子的一天」的动物数(含完全没吃到)。 */
  starvedCount: number;
  /** 被跳过的动物数(未知物种 / 不该进牧场 / 亲和不足 / 物种没定饲料)。 */
  skippedCount: number;
  /** 产出名在内容表里查不到 ID 的(去重、保持首次出现顺序)。 */
  unresolved: readonly string[];
  /** 人读的说明(每条都说清是哪只动物、为什么)。 */
  notes: readonly string[];
}

/** 该物种吃什么(内容表 `tameItem`);内容表没定义就 `null`。 */
export function feedItemOf(speciesId: string): number | null {
  const def = MOB_BY_ID.get(speciesId);
  return def?.tameItem ?? null;
}

/**
 * 「圈养动物**自动进食**」的判定 —— 三件事同时成立才叫自动进食:
 *
 * 1. 物种在内容表里(否则不知道吃什么);
 * 2. 该物种**进牧场**(手册只点名云朵绵羊与水豚);
 * 3. 亲和达标 **且** 槽里至少有一天的饲料。
 *
 * 它被 `settleRanchDay` 复用,也被判定直接调用 —— 两处必须是**同一份**逻辑。
 */
export function canAutoFeed(animal: RanchAnimal, feed: Readonly<Record<number, number>>): boolean {
  if (MOB_BY_ID.get(animal.speciesId) === undefined) return false;
  if (RANCH_PRODUCE_BY_SPECIES[animal.speciesId] === undefined) return false;
  if (!(animal.affinity >= RANCH_AFFINITY_MIN)) return false;
  const feedId = feedItemOf(animal.speciesId);
  if (feedId === null) return false;
  const have = feed[feedId] ?? 0;
  return Number.isFinite(have) && have >= RANCH_FEED_PER_DAY;
}

/**
 * 牧场日结:过了 `days` 天之后,吃掉多少饲料、产出多少毛团/温泉橘。
 *
 * ## 结算规则(每只动物独立)
 *
 * ```
 * 亲和 < 0.7            ⇒ 跳过(还没养熟),不进食、不产出
 * 物种不在手册点名的两种 ⇒ 跳过(内容表的牧场只养绵羊与水豚)
 * 饲料 not(tameItem)   ⇒ 跳过(不知道喂什么)
 * 否则                  ⇒ 能吃几天 = min(天数, floor(饲料件数 / 每天份数))
 *                         消耗 = 能吃几天 × 每天份数
 *                         产出 = 能吃几天 × 每天产出
 * ```
 *
 * ★ 「没有饲料 ⇒ 不产出」是**负对照**的地基:饲料不足时,产出**减少而不是
 *   变成负债**,也不会拿空气喂动物(`fedDays = 0` ⇒ 该动物连产出条目都没有)。
 */
export function settleRanchDay(input: RanchDayInput): RanchDayResult {
  const rawDays = Number.isFinite(input.days) ? Math.floor(input.days) : 0;
  const days = Math.max(0, rawDays);

  /* 饲料账本:只认「有限正数」的件数;`feed` 是只读入参,不改它。 */
  const stock = new Map<number, number>();
  for (const key of Object.keys(input.feed)) {
    const id = Number(key);
    const n = input.feed[id];
    if (!Number.isFinite(id) || id <= 0) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    stock.set(id, Math.floor(n));
  }

  const produce: RanchProduceRow[] = [];
  const consumed = new Map<number, number>();
  const unresolved: string[] = [];
  const notes: string[] = [];
  let fedCount = 0;
  let starvedCount = 0;
  let skippedCount = 0;

  for (const animal of input.animals) {
    const speciesId = animal.speciesId;
    if (MOB_BY_ID.get(speciesId) === undefined) {
      skippedCount += 1;
      notes.push(`${speciesId}: 内容表里没有这个物种 ⇒ 无法日结`);
      continue;
    }
    const produceName = RANCH_PRODUCE_BY_SPECIES[speciesId];
    if (produceName === undefined) {
      skippedCount += 1;
      notes.push(`${speciesId}: 手册的牧场只圈养云朵绵羊与水豚 ⇒ 不进牧场日结`);
      continue;
    }
    const feedId = feedItemOf(speciesId);
    if (feedId === null) {
      skippedCount += 1;
      notes.push(`${speciesId}: 内容表没有 tameItem ⇒ 不知道喂什么`);
      continue;
    }
    if (!(animal.affinity >= RANCH_AFFINITY_MIN)) {
      skippedCount += 1;
      notes.push(`${speciesId}: 亲和 ${animal.affinity} 未达 ${RANCH_AFFINITY_MIN} ⇒ 自动进食不成立`);
      continue;
    }

    const have = stock.get(feedId) ?? 0;
    const perDay = RANCH_FEED_PER_DAY;
    const fedDays = Math.min(days, Math.floor(have / perDay));
    if (fedDays > 0) {
      stock.set(feedId, have - fedDays * perDay);
      consumed.set(feedId, (consumed.get(feedId) ?? 0) + fedDays * perDay);
      fedCount += 1;
    }
    if (fedDays < days) {
      starvedCount += 1;
      notes.push(
        fedDays > 0
          ? `${speciesId}: 饲料只够 ${fedDays}/${days} 天 ⇒ 其余天不产出`
          : `${speciesId}: 槽里没有 ${feedId} ⇒ 不产出(既没吃到,也没产出)`,
      );
    }
    if (fedDays <= 0) continue;

    const itemId = resolveItemByName(produceName);
    if (itemId === null && !unresolved.includes(produceName)) unresolved.push(produceName);
    produce.push({
      speciesId,
      name: produceName,
      itemId,
      count: fedDays * RANCH_PRODUCE_PER_DAY,
    });
  }

  const feedConsumed: RanchFeedRow[] = [...consumed.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([itemId, count]) => ({ itemId, count }));

  return {
    days,
    produce,
    feedConsumed,
    fedCount,
    starvedCount,
    skippedCount,
    unresolved,
    notes,
  };
}

/* ═══════════ 幂等边界(WS-FND-96 / 审计 P2-3):同一 `(房间, 结算日)` 只成功一次 ═══════════ */

/**
 * 带**结算日**的日结输入。
 *
 * `day` = 房间内的第几天(0 起整数),由调用方喂 —— 本模块仍然**不读时钟**,
 * 于是「这次结算是哪一天」是入参而不是隐含状态(与 `BrewInput.at` 同口径)。
 */
export interface RanchDayKeyedInput extends RanchDayInput {
  day: number;
}

/**
 * 幂等日结的结果。
 *
 * `accepted: false` ⇒ **本次一位都没结**(`result` 恒 `null`):没有饲料被扣、
 * 没有产出被算。调用方必须整笔放弃,而不是「拿到空回执再补一次」。
 */
export type RanchOnceOutcome =
  | { accepted: true; key: string; result: RanchDayResult }
  | { accepted: false; key: string | null; replayed: boolean; reason: string; result: null };

/**
 * **幂等**日结:同一个 `(ECO_RANCH, day)` **只成功一次**。
 *
 * ```
 * day 非法(-1 / NaN)                 ⇒ 拒,台账不动
 * 该 day 已在台账里(重放 / 慢帧重入)   ⇒ 拒(replayed:true),台账不动
 * 结算天数 = 0                        ⇒ 拒,**不占**该日(否则这一天被永久占掉)
 * 这一天没有任何账(无进食、无产出)     ⇒ 照常出账(accepted:true),但**不占**该日
 * 否则                                ⇒ 结算 + 占键
 * ```
 *
 * ★ 负对照:`settleRanchDay`(不带台账)连调两次**两次都出账** —— 这正是本函数
 *   存在的理由,判据用它证明「幂等是真的多了一层,而不是原有行为」。
 * ★ 「只有成功才占键」是纪律 2(见 `idempotency.ts` 文件头):`days === 0` 时不占键,
 *   于是同一天随后真的过了一天仍然结得出来。
 *
 * ★ **零产出:出账但不占键**(第三轮实测 P2):修前只按 `result.days > 0`(请求天数)判,
 *   于是「圈里没动物 / 槽里没饲料」时 `produce = []`、`feedConsumed = []`,却照样
 *   `claimSettlement` 把该日 key **占死** —— 随后补齐动物 / 饲料的那次**真**结算会被
 *   当重放拒掉,**那一天的产出永久丢失**。现在「这一天有没有账」按**实际结果**判
 *   (`feedConsumed` 与 `produce` 都空 ⇒ 无账可结),语义选「**不占键**」:照常返回
 *   `accepted:true` + 空账(调用方要的回执在世界侧就是那一天的报告),但**不写台账**
 *   ⇒ 同一天之后仍能真结算(与「天数为 0 不占键」同属纪律 2)。
 *   ★ 不改成「拒」:`WorldSim.settleRanchIfDayChanged` 的慢帧报告按 `accepted` 计数
 *     (空圈 / 没饲料的那一天也要如实报出来);改成 `accepted:false` 会让 WS-FND-77 的
 *     空槽负对照 / 跨日整数天 / 花栗鼠跳过三条一起失据。
 */
export function settleRanchDayOnce(ledger: SettlementLedger, input: RanchDayKeyedInput): RanchOnceOutcome {
  const key = settleKeyOf(SETTLEMENT_ROOMS.ECO_RANCH, { kind: 'DAY', day: input.day });
  if (key === null) {
    return {
      accepted: false,
      key: null,
      replayed: false,
      reason: `结算日非法(${String(input.day)})⇒ 不结算`,
      result: null,
    };
  }
  const seenAt = settlementSeenAt(ledger, key);
  if (seenAt !== undefined) {
    return {
      accepted: false,
      key,
      replayed: true,
      reason: `第 ${seenAt} 天已结算过(幂等键 ${key})⇒ 拒绝,饲料与产出都不动`,
      result: null,
    };
  }
  const result = settleRanchDay(input);
  if (result.days <= 0) {
    return {
      accepted: false,
      key,
      replayed: false,
      reason: '结算天数为 0 ⇒ 无账可结(不占用结算日)',
      result: null,
    };
  }
  /* ★ 零产出**出账但不占键**(第三轮实测 P2):这一拍没有任何账(无饲料被吃、无产出)
     —— 修前它照样 `claimSettlement` 把该日 key 占死,随后补齐条件的那次真结算被当重放拒。
     现在照常返回 `accepted:true` + 空账(**不写台账**)⇒ 同一天之后仍能真结算。
     为什么不是 `accepted:false`:世界侧慢帧报告按 `accepted` 计数(空圈那一天也要报),
     见函数头「零产出:出账但不占键」。 */
  if (result.feedConsumed.length === 0 && result.produce.length === 0) {
    return { accepted: true, key, result };
  }
  const claim = claimSettlement(ledger, key, input.day);
  if (!claim.ok) {
    return { accepted: false, key, replayed: true, reason: claim.reason, result: null };
  }
  return { accepted: true, key, result };
}