/**
 * 冻结层:**新玩家起始背包**(WS-FND-155)。
 *
 * 与 `items.ts` 的关系:本文件**不含**任何新物品 id —— 每一件都是 `items.ts`
 * 里已有的条目,靠 `ITEM_BY_ID` 交叉校验(见 `planStartingInventory`)。新增
 * 物品一律进 `items.ts`(那里是唯一 ID 事实源),本表只挑「发哪几件、各几份」。
 *
 * ## 依据:内容表里**最低阶可造物**的配方(逐条可查)
 *
 * ```
 * 201 暖松石刃斧   recipe {101:2, 106:2}  station 502  全自然材料 ⇒ 全表最低阶的工具
 * 203 矿工十字石镐 recipe {101:2, 106:3}  station 502  同阶,但多吃一份石材
 * 205 改地水渠木铲 recipe {101:2, 155:1}  station 502  要 155 黄铜锭(半成品)⇒ 已是第二阶
 * 160 结实风草绳   recipe {118:2}         station 502
 * 711 初心冒险者木剑 recipe {101:4, 160:1} station 502  第二阶:必须先出 160
 * ```
 *
 * 「最低阶」的判法是**配方里的材料档位**,不是价值分:201 / 203 的配方只含
 * `ItemCategory.NATURAL`(101 / 106),而 205 起就要求半成品(155)。
 *
 * ## 这份起始包为什么是**保守**的
 *
 * ```
 * 101 暖松原木 ×2   —— 201 的配方原料(recipe 里写着 2 份)
 * 106 云母圆石 ×2   —— 201 的配方原料(同理 2 份)
 * 118 柔韧风草 ×2   —— 160 结实风草绳 {118:2} 的原料;160 是 711 木剑的必需件
 * 201 暖松石刃斧 ×1 —— 「一件基础工具」:让新玩家**立刻**能斧/镐类动作,
 *                      而不是先凑齐材料再合成一次
 * ```
 *
 * 三个刻意的「不给」:
 *   · 不给半成品(151 / 155 / 160):那会替玩家跳过「第一次合成」这件事;
 *   · 不给成品建材(351 墙 / 301 耕地):一份换不来任何闭环;
 *   · 不给食物 / 消耗品:回血与增益是**玩法选择**,不是入场语义。
 *
 * ## 件数与容量
 *
 * 合计 **7 件**(2+2+2+1)≤ **1 级容量 8 格**。
 * ⚠️ 那个 8 **不在本文件里重复实现** —— 容量的唯一出处是成长档案的
 * `carrySlots`(`progression.statsAtLevel` 派生,读口见 `net/room.ts`
 * 的 `carryCapacityOf` / `WorldSim.carrySlotsOf`)。本表只声明**要发什么**,
 * 「装不装得下」由调用方把**实得容量**传进来判(超了就按下面的顺序截断)。
 *
 * ## 数组顺序 = 优先级(截断从尾部开始)
 *
 * 先保底料(能自己造第二份 201)再保工具;容量不够时丢的是**表尾**那几件。
 * 判据只做一件事:发出去的件数之和 ≤ 容量,丢掉的逐条进回执(`truncated`)。
 */

import { ITEM_BY_ID } from './items.ts';

/** 起始背包的一项(`itemId` 必须在 `items.ts` 里存在)。 */
export interface StartingInventoryEntry {
  readonly itemId: number;
  readonly count: number;
}

/**
 * 起始背包表(顺序 = 发放优先级,见文件头「数组顺序」)。
 *
 * ⚠️ 改这里的任何一行都会改「新玩家开局有什么」—— 这是**平衡性改动**,
 * 不是接线;改完必须让 `tests/WS-FND-155-starting-inventory.test.ts` 继续绿
 * (它逐条断言:件数合法 / 每件都在内容表里 / 合计 ≤ 1 级容量 / 截断按前缀走)。
 */
export const STARTING_INVENTORY: readonly StartingInventoryEntry[] = [
  /* 1 201 暖松石刃斧的配方原料(`items.ts` 里 recipe {101:2, 106:2})。 */
  { itemId: 101, count: 2 },
  { itemId: 106, count: 2 },
  /* 2 `160 结实风草绳 {118:2}` 的原料 —— 它是 `711 初心冒险者木剑 {101:4,160:1}` 的必需件。 */
  { itemId: 118, count: 2 },
  /* 3 一件基础工具:最低阶工具(配方只含自然材料)本身。 */
  { itemId: 201, count: 1 },
];

/** 一次规划的结果(纯数据,不含任何副作用)。 */
export interface StartingInventoryPlan {
  /** `true` = 这份计划可以**原样**发放;`false` = 一个都不发(见 `reason`)。 */
  readonly ok: boolean;
  /** 真的发下去的(按表序;容量不够时最后一项可能是**部分**的)。 */
  readonly granted: readonly StartingInventoryEntry[];
  /** 因容量被丢掉的(逐条如实列出,便于回执与断言)。 */
  readonly truncated: readonly StartingInventoryEntry[];
  /** `granted` 的件数合计。 */
  readonly total: number;
  /** 这次规划用的容量(调用方给的**实得**容量,不是本文件猜的)。 */
  readonly capacity: number;
  readonly reason: string;
}

/**
 * 把起始背包表**规划**成一份可执行的发放计划(纯函数,零副作用)。
 *
 * ## 三条判定,顺序固定
 *
 * ```text
 * 1 容量合法      必须是 ≥1 的有限整数。否则 fail-closed:一个都不发 ——
 *                 「容量读不出来」不等于「容量无限」,也不等于「0 格」。
 * 2 内容合法      每一项 itemId 必须在 `items.ts` 的 ITEM_BY_ID 里、count ≥1。
 *                 任何一条坏 ⇒ **整批不发**(不给半份,也不跳过坏的那条继续发)——
 *                 跳过坏条会把「表的错」伪装成「少发一件」,而那没人看得出来。
 * 3 按优先级截断  从表头往表尾装,装得下就整项装;装不下时**先装到容量为止**
 *                 (部分发放),其后全部进 `truncated`。
 * ```
 *
 * ⚠️ 「部分发放」是刻意的:表中同一项拆两半没有任何语义损失(件数是量词),
 * 而「一超过容量就整项丢」会让末位那件常常永远发不出去。
 *
 * @param capacity **实得**容量(调用方从成长档案 / 等级读出来,见文件头)。
 * @param entries  默认 = 冻结表 `STARTING_INVENTORY`;显式传入只为判据注入。
 */
export function planStartingInventory(
  capacity: number,
  entries: readonly StartingInventoryEntry[] = STARTING_INVENTORY,
): StartingInventoryPlan {
  const refuse = (reason: string): StartingInventoryPlan => ({
    ok: false,
    granted: [],
    truncated: [...entries],
    total: 0,
    capacity,
    reason,
  });

  /* 1 容量:坏参数 ⇒ 一个都不发(fail-closed)。 */
  if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity < 1) {
    return refuse(
      `容量非法(${String(capacity)})—— 起始背包需要 ≥1 的整数容量;一个都不发(fail-closed)`,
    );
  }

  /* 2 内容:逐条查冻结内容表与件数。 */
  for (const e of entries) {
    if (!Number.isInteger(e.itemId) || !ITEM_BY_ID.has(e.itemId)) {
      return refuse(`起始背包表里的 #${String(e.itemId)} 不在冻结内容表 items.ts 里 ⇒ 整批不发`);
    }
    if (!Number.isInteger(e.count) || e.count < 1) {
      return refuse(`起始背包表里 #${e.itemId} 的件数非法(${String(e.count)})⇒ 整批不发`);
    }
  }

  /* 3 按优先级装到容量为止。 */
  const granted: StartingInventoryEntry[] = [];
  const truncated: StartingInventoryEntry[] = [];
  let total = 0;
  for (const e of entries) {
    const room = capacity - total;
    if (room <= 0) {
      truncated.push({ itemId: e.itemId, count: e.count });
      continue;
    }
    if (e.count <= room) {
      granted.push({ itemId: e.itemId, count: e.count });
      total += e.count;
      continue;
    }
    granted.push({ itemId: e.itemId, count: room });
    total += room;
    truncated.push({ itemId: e.itemId, count: e.count - room });
  }

  const wanted = entries.reduce((n, e) => n + e.count, 0);
  const reason = truncated.length === 0
    ? `装得下:${granted.length} 项 / ${total} 件 ≤ 容量 ${capacity}`
    : `装不下(表内共 ${wanted} 件 > 容量 ${capacity})⇒ 按优先级截断:发 ${total} 件,`
      + `丢 ${truncated.map((t) => `#${t.itemId}×${t.count}`).join('、')}`;
  return { ok: true, granted, truncated, total, capacity, reason };
}
