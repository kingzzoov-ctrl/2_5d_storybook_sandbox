/**
 * WS-09 / 背包分类视图 —— 纯数据层(不 import three)。
 *
 * 按 `ItemCategory`(12 类)分页展示,支持搜索、排序、格子↔物品 ID 双射。
 *
 * ## 容量与布局(WS-FND-02:容量**不再**等于内容数量)
 *
 * 曾经的写法是 `INVENTORY_SLOTS = TOTAL_ITEM_COUNT`,把「背包能装多少」和
 * 「内容表有多少」绑成一个数。后果是加一件物品会同时踩三个坑:
 *   1. `SLOTS = 330` 时 `330 / 16 = 20.625` 行 —— **半行**,网格最后一行残缺;
 *   2. 行数不再是整数,依赖行数的布局取整全部错位;
 *   3. `SLOTS_PER_PAGE` 曾等于 320,320 件时正好 1 页 ⇒ **分页代码路径从未被执行**;
 *      加到 330 件时页数突然变 2,潜伏的分页 bug 才第一次暴露。
 *
 * 现在容量**由布局反推**:`行数 = ceil(内容数 / 每行格数) + 固定余量`,
 * `容量 = 行数 × 每行格数` ⇒ 恒为每行格数的整数倍,半行在数学上不可能出现。
 * 余量行还让小批量扩容(±16 件以内)完全不改变行数与既有槽位。
 *
 * 分页同样**主动降级**:`SLOTS_PER_PAGE` 明显小于容量,日常测试就会走到分页路径,
 * 而不是等到某次扩容才首次执行。
 *
 * 三条硬规则:
 *  1. **容量断言**:`INVENTORY_SLOTS % SLOTS_PER_ROW === 0` 且 `>= TOTAL_ITEM_COUNT`;
 *  2. **ID 双射**:`slotOf(itemId)` 与 `itemAt(slot)` 互为逆,不依赖 Map 顺序;
 *  3. **分类计数闭合**:Σ 各分类 itemCount === TOTAL_ITEM_COUNT(否则说明有物品 category 不在 12 类里)。
 */

import {
  ITEM_LIST,
  ITEM_TABLES,
  TOTAL_ITEM_COUNT,
  itemName,
  itemTags,
  itemValue,
} from '../../../shared/constants/items.ts';
import { ItemCategory, type ItemDef } from '../../../shared/types/entities.ts';

/** 每行 16 格(与 16×16 Chunk 呼应,UI 网格整齐) */
export const SLOTS_PER_ROW = 16;

/** 容量余量行数:内容扩到 +16 件以内时行数不变,既有槽位保持稳定 */
export const INVENTORY_SPARE_ROWS = 1;

/** 每页行数(10 行 = 160 格,刻意小于总容量,让分页路径日常被走到) */
export const SLOTS_PER_PAGE_ROWS = 10;

/** 一页显示的格子数 = 160。**严格小于** `INVENTORY_SLOTS`,分页非退化。 */
export const SLOTS_PER_PAGE = SLOTS_PER_ROW * SLOTS_PER_PAGE_ROWS;

/** 布局推导结果(纯数据,便于测试喂任意 count) */
export interface SlotLayout {
  /** 内容所需的行数(向上取整) */
  contentRows: number;
  /** 含余量的总行数 */
  rows: number;
  /** 总格数 = `rows × slotsPerRow`,恒为 `slotsPerRow` 的整数倍 */
  slots: number;
  /** 每页行数 */
  pageRows: number;
  /** 每页格数 */
  pageSlots: number;
  /** 总页数(至少 1) */
  pageCount: number;
  /** `slots` 是否为每行格数的整数倍(无半行) */
  rowAligned: boolean;
  /** 容量是否装得下全部内容 */
  fits: boolean;
}

/**
 * 由「内容数量」推导「可容纳的布局」—— **纯函数**,不读任何模块常量。
 *
 * 这是整个解耦的核心:容量是**输出**,内容数量只是**输入**。
 * 测试可直接喂 `count = 330 / 336 / 100000` 验证布局规则性,无需改动真实常量。
 *
 * @param count       内容件数(<=0 时按 1 行处理)
 * @param slotsPerRow 每行格数(<=0 时按 1 处理,避免除零)
 * @param spareRows   固定余量行数
 * @param pageRows    每页行数
 */
export function computeSlotLayout(
  count: number,
  slotsPerRow: number,
  spareRows: number,
  pageRows: number = SLOTS_PER_PAGE_ROWS,
): SlotLayout {
  const spr = Math.max(1, Math.trunc(slotsPerRow));
  const spare = Math.max(0, Math.trunc(spareRows));
  const pr = Math.max(1, Math.trunc(pageRows));
  const n = Math.max(0, Math.trunc(count));
  const contentRows = Math.ceil(n / spr);
  const rows = Math.max(1, contentRows + spare);
  const slots = rows * spr;
  const pageSlots = spr * pr;
  const pageCount = Math.max(1, Math.ceil(slots / pageSlots));
  return {
    contentRows,
    rows,
    slots,
    pageRows: pr,
    pageSlots,
    pageCount,
    rowAligned: slots % spr === 0,
    fits: slots >= n,
  };
}

/**
 * 当前内容表对应的布局。
 * `TOTAL_ITEM_COUNT = 320` ⇒ `contentRows = 20`、`rows = 21`、`slots = 336`、`pageCount = 3`。
 */
export const INVENTORY_LAYOUT: SlotLayout = computeSlotLayout(
  TOTAL_ITEM_COUNT,
  SLOTS_PER_ROW,
  INVENTORY_SPARE_ROWS,
);

/** 背包总行数(含余量行)= 21 */
export const INVENTORY_ROWS = INVENTORY_LAYOUT.rows;

/**
 * 背包总格数 = 336。
 *
 * 注意它**不再等于** `TOTAL_ITEM_COUNT`(320):容量由 21 行 × 16 格决定,
 * 内容数量只影响行数下界。336 是 16 的整数倍,永无半行。
 */
export const INVENTORY_SLOTS = INVENTORY_LAYOUT.slots;

/**
 * 背包**容量**能铺满的总页数 = ceil(336 / 160) = 3。
 *
 * 与 `buildView().pageCount` 的区别(两者都合法,含义不同):
 *  - `INVENTORY_PAGE_COUNT` 是**容量页数**,由布局决定,是页数的**上界**;
 *  - `buildView().pageCount` 是**内容页数**,由过滤后剩多少件决定,永远 `<= INVENTORY_PAGE_COUNT`。
 *
 * 用内容页数而不是容量页数来渲染,是为了让「筛选后只剩 15 件」时不显示 2 个空页;
 * 容量页数则用于校验分页逻辑本身非退化(≥2),二者不能混用。
 */
export const INVENTORY_PAGE_COUNT = INVENTORY_LAYOUT.pageCount;

/** 12 个分类的固定展示顺序(与手册 §3 分表顺序一致) */
export const CATEGORY_ORDER: readonly string[] = [
  ItemCategory.NATURAL,
  ItemCategory.REFINED,
  ItemCategory.TOOL,
  ItemCategory.PRANK_TOY,
  ItemCategory.FLOOR,
  ItemCategory.BUILDING,
  ItemCategory.AUTOMATION,
  ItemCategory.FURNITURE,
  ItemCategory.FOOD,
  ItemCategory.WEARABLE,
  ItemCategory.COMBAT,
  ItemCategory.AI_CRAFTED,
];

/** 分类中文名(UI 页签) */
export const CATEGORY_LABEL: Record<string, string> = {
  NATURAL: '自然矿物',
  REFINED: '半成品',
  TOOL: '工具专精',
  PRANK_TOY: '整蛊玩具',
  FLOOR: '地表铺装',
  BUILDING: '建筑构件',
  AUTOMATION: '电路物流',
  FURNITURE: '家具设备',
  FOOD: '料理时装',
  WEARABLE: '时装头饰',
  COMBAT: '战斗祭品',
  AI_CRAFTED: '炼金造物',
};

/** 分类配色(UI 页签底色),与 RARITY_LABEL 的色名体系一致 */
export const CATEGORY_COLOR: Record<string, string> = {
  NATURAL: '#7FBF6A',
  REFINED: '#C9A227',
  TOOL: '#8C8C94',
  PRANK_TOY: '#E8654F',
  FLOOR: '#6FA8DC',
  BUILDING: '#B98A5A',
  AUTOMATION: '#5FC9C1',
  FURNITURE: '#A9744F',
  FOOD: '#F09BB4',
  WEARABLE: '#B58BE0',
  COMBAT: '#D9534F',
  AI_CRAFTED: '#FFD34D',
};

export interface InventorySlot {
  /** 0 .. INVENTORY_SLOTS−1(容量 336;下标 ≥ 内容数者为空格) */
  slot: number;
  row: number;
  col: number;
  item: ItemDef;
  /** 排序/过滤时是否可见 */
  visible: boolean;
}

export interface CategoryBucket {
  category: string;
  label: string;
  color: string;
  /** 该分类全部物品的 ID */
  itemIds: number[];
  /** 该分类占用的格子索引 */
  slots: number[];
  firstSlot: number;
}

export interface InventoryView {
  slots: InventorySlot[];
  buckets: CategoryBucket[];
  /** 当前激活分类,null / 'ALL' 表示全部 */
  activeCategory: string | null;
  query: string;
  /** 当前页(0 起) */
  page: number;
  pageCount: number;
  /** 过滤后可见格子数 */
  visibleCount: number;
}

/* ───────────────────── 索引构建 ───────────────────── */

/** 物品 ID → 背包格位(稳定:按 ITEM_LIST 顺序) */
const SLOT_OF: Map<number, number> = new Map();
for (let i = 0; i < ITEM_LIST.length; i += 1) SLOT_OF.set(ITEM_LIST[i].id, i);

export function slotOf(itemId: number): number {
  const s = SLOT_OF.get(itemId);
  return s === undefined ? -1 : s;
}

/**
 * 格位 → 物品。
 *
 * 上界取 `min(容量, 内容数)`:容量(336)大于内容数(320)是**设计目标**而非错误,
 * 多出来的 16 个空格合法存在但无物品,返回 null。这样「容量 ≥ 内容数」的余量
 * 才真的能被 UI 画成空格,而不是越界。
 */
export function itemAt(slot: number): ItemDef | null {
  if (!Number.isInteger(slot) || slot < 0) return null;
  if (slot >= INVENTORY_SLOTS || slot >= ITEM_LIST.length) return null;
  return ITEM_LIST[slot];
}

/** 某格位是否为「容量内的空格」(扩容余量),供 UI 画空槽 */
export function isEmptySlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SLOTS && itemAt(slot) === null;
}

export function categoryOf(itemId: number): string | null {
  const s = slotOf(itemId);
  return s < 0 ? null : ITEM_LIST[s].category;
}

/** 构建 12 个分类桶;计数不闭合时抛错(开发期早失败) */
export function buildBuckets(): CategoryBucket[] {
  const map = new Map<string, CategoryBucket>();
  const ensure = (c: string): CategoryBucket => {
    let b = map.get(c);
    if (!b) {
      b = {
        category: c,
        label: CATEGORY_LABEL[c] ?? c,
        color: CATEGORY_COLOR[c] ?? '#888888',
        itemIds: [],
        slots: [],
        firstSlot: -1,
      };
      map.set(c, b);
    }
    return b;
  };
  for (const c of CATEGORY_ORDER) ensure(c);

  for (let i = 0; i < ITEM_LIST.length; i += 1) {
    const it = ITEM_LIST[i];
    const b = ensure(it.category);
    if (b.firstSlot < 0) b.firstSlot = i;
    b.itemIds.push(it.id);
    b.slots.push(i);
  }

  const out: CategoryBucket[] = [];
  let sum = 0;
  for (const c of CATEGORY_ORDER) {
    const b = map.get(c);
    if (!b) continue;
    sum += b.itemIds.length;
    out.push(b);
  }
  if (sum !== TOTAL_ITEM_COUNT) {
    throw new Error(`分类计数不闭合:Σ=${sum} ≠ ${TOTAL_ITEM_COUNT}(有物品 category 不在 12 类中)`);
  }
  return out;
}

/** 分类桶缓存(模块级常量计算一次) */
export const BUCKETS: readonly CategoryBucket[] = buildBuckets();

export function bucketOf(category: string): CategoryBucket | null {
  return BUCKETS.find((b) => b.category === category) ?? null;
}

export function categoryCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of BUCKETS) out[b.category] = b.itemIds.length;
  return out;
}

/** 十大分表(手册 §3.1~§3.10)与 12 分类的交叉索引,供文档与 UI 页签副标题 */
export function tableOf(itemId: number): { key: string; title: string } | null {
  for (const t of ITEM_TABLES) {
    if (itemId >= t.range[0] && itemId <= t.range[1]) return { key: t.key, title: t.title };
  }
  return null;
}

/* ───────────────────── 过滤与排序 ───────────────────── */

export interface FilterOptions {
  category?: string | null;
  query?: string;
  tag?: string;
  minValue?: number;
}

/** 关键词匹配:命中中文名、ID 字符串、任一词条或说明 */
export function matchesQuery(item: ItemDef, query: string): boolean {
  const q = (query ?? '').trim().toLowerCase();
  if (q === '') return true;
  if (String(item.id) === q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  for (const t of item.tags) if (t.toLowerCase().includes(q)) return true;
  return item.note.toLowerCase().includes(q);
}

export function filterItems(opts: FilterOptions = {}): InventorySlot[] {
  const cat = opts.category && opts.category !== 'ALL' ? opts.category : null;
  const q = opts.query ?? '';
  const tag = opts.tag ?? '';
  const minV = opts.minValue ?? Number.NEGATIVE_INFINITY;
  const out: InventorySlot[] = [];
  for (let i = 0; i < ITEM_LIST.length; i += 1) {
    const item = ITEM_LIST[i];
    const ok = (!cat || item.category === cat)
      && matchesQuery(item, q)
      && (!tag || item.tags.includes(tag))
      && item.value >= minV;
    if (!ok) continue;
    out.push({
      slot: i,
      row: Math.floor(i / SLOTS_PER_ROW),
      col: i % SLOTS_PER_ROW,
      item,
      visible: true,
    });
  }
  return out;
}

/** 排序键:0=格位 1=ID 2=价值降序 3=名称 4=分类 */
export const SortKey = {
  SLOT: 0,
  ID: 1,
  VALUE_DESC: 2,
  NAME: 3,
  CATEGORY: 4,
} as const;
export type SortKey = (typeof SortKey)[keyof typeof SortKey];

export function sortSlots(slots: readonly InventorySlot[], key: SortKey): InventorySlot[] {
  const out = [...slots];
  out.sort((a, b) => {
    if (key === SortKey.ID) return a.item.id - b.item.id;
    if (key === SortKey.VALUE_DESC) return b.item.value - a.item.value || a.item.id - b.item.id;
    if (key === SortKey.NAME) return a.item.name.localeCompare(b.item.name, 'zh-Hans-CN');
    if (key === SortKey.CATEGORY) {
      const ca = CATEGORY_ORDER.indexOf(a.item.category);
      const cb = CATEGORY_ORDER.indexOf(b.item.category);
      return ca - cb || a.item.id - b.item.id;
    }
    return a.slot - b.slot;
  });
  return out;
}

/**
 * 生成整页视图。复杂度 O(320)。
 */
export function buildView(opts: FilterOptions & { sort?: SortKey; page?: number } = {}): InventoryView {
  const filtered = sortSlots(filterItems(opts), opts.sort ?? SortKey.SLOT);
  const pageCount = Math.max(1, Math.ceil(filtered.length / SLOTS_PER_PAGE));
  const rawPage = Math.trunc(opts.page ?? 0);
  const page = Math.min(pageCount - 1, Math.max(0, rawPage));
  const slice = filtered.slice(page * SLOTS_PER_PAGE, (page + 1) * SLOTS_PER_PAGE);
  return {
    slots: slice,
    buckets: [...BUCKETS],
    activeCategory: opts.category ?? null,
    query: opts.query ?? '',
    page,
    pageCount,
    visibleCount: filtered.length,
  };
}

/** 格子内容摘要(悬停提示) */
export function slotTooltip(itemId: number): string {
  const s = slotOf(itemId);
  if (s < 0) return `未知物品#${itemId}`;
  const it = ITEM_LIST[s];
  const t = tableOf(it.id);
  return `#${it.id} ${itemName(it.id)}|分类:${CATEGORY_LABEL[it.category] ?? it.category}`
    + `|价值:${itemValue(it.id)}|词条:${itemTags(it.id).join('、')}`
    + (t ? `|手册:§${t.key} ${t.title}` : '')
    + `|${it.note}`;
}

/** 背包占用比例(与 entities.statsAtLevel 的 carrySlots 对齐) */
export function usedSlotRatio(filled: number): number {
  return Math.max(0, Math.min(1, filled / INVENTORY_SLOTS));
}