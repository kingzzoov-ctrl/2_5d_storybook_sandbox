/**
 * WS-09 / 合成台配方树 —— 纯数据层(不 import three)。
 *
 * 由冻结层 `ItemDef.recipe`(`Record<材料ID, 数量>`)反推出一棵可折叠的树。
 * 树上每个节点回答三个 UI 问题:
 *  1. **这门配方总共要几种原料、各几个**(叶子聚合);
 *  2. **卡在哪一层**(缺料时高亮最近的可采集层);
 *  3. **需要哪台加工台**(`ItemDef.station`,节点自带 stationId)。
 *
 * 实现要点:
 *  - **必须防环**:`ItemDef` 是外部配表,一旦有人写出 `A 需要 B,B 需要 A`(哪怕是手滑),
 *    朴素递归会直接把浏览器栈打穿。这里用「路径集合」做环检测,遇到环把节点标 `cyclic=true`
 *    并停止展开,同时把环路径原文返回给 UI 显示,便于定位配表错误;
 *  - **必须限深**:配方深 4 层(原木→木板→家具→多材料成品)是常态,超过 `MAX_DEPTH=8`
 *    视为异常并截断;
 *  - **必须 memo 语义**:同一材料被多条分支引用(如 101 暖松原木被 30+ 配方用到),
 *    这里用共享计数而非重复子树,避免节点数按分支爆炸。
 */

import { ITEM_BY_ID, ITEM_LIST, expandRecipe, itemName } from '../../../shared/constants/items.ts';
import type { ItemDef } from '../../../shared/types/entities.ts';
import { slotOf } from './inventory.ts';

/** 默认最大展开深度 */
export const MAX_DEPTH = 8;

/** 一次合成显示的批次上限(UI 滑块) */
export const MAX_BATCH = 64;

export interface RecipeNode {
  itemId: number;
  name: string;
  /** 该层相对根的需求数量 */
  needCount: number;
  /** 该物品自身是否有配方(false = 叶子,自然采集或掉落) */
  craftable: boolean;
  /** 加工台物品 ID;undefined = 徒手/自然 */
  stationId?: number;
  /** 子节点(材料),craftable=false 时为空数组 */
  children: RecipeNode[];
  /** 该子树累计消耗的总件数(含自身) */
  subtreeCost: number;
  /** 该子树叶子种类数 */
  leafKinds: number;
  /** 深度(根 = 0) */
  depth: number;
  /** 是否因环被截断 */
  cyclic: boolean;
  /** 是否因超深被截断 */
  truncated: boolean;
}

export interface RecipeTree {
  root: RecipeNode;
  /** 全部叶子(自然原料)ID → 总需求,已按路径累加 */
  leaves: Map<number, number>;
  /** 涉及的全部加工台 ID */
  stations: number[];
  /** 节点总数 */
  nodeCount: number;
  /** 是否检测到环 */
  hasCycle: boolean;
  /** 环路径描述(如 "101 → 151 → 101"),供 UI 报警 */
  cyclePaths: string[];
  /** 最大实际深度 */
  maxDepth: number;
}

export interface CraftCheck {
  craftable: boolean;
  /** 缺料清单:itemId → 还差几个 */
  missing: Map<number, number>;
  /** 已满足的叶子种类数 */
  satisfied: number;
  /** 总需求种类 */
  totalKinds: number;
}

/* ───────────────────── 树构建 ───────────────────── */

/**
 * 构建配方树。
 * @param itemId  根物品
 * @param batches 批次(>=1)
 * @param maxDepth 最大深度
 */
export function buildRecipeTree(itemId: number, batches = 1, maxDepth = MAX_DEPTH): RecipeTree {
  const leaves = new Map<number, number>();
  const stations = new Set<number>();
  const cyclePaths: string[] = [];
  let nodeCount = 0;
  let maxSeenDepth = 0;
  const batch = Math.max(1, Math.trunc(batches));
  const depthLimit = Math.max(1, Math.trunc(maxDepth));

  const build = (id: number, need: number, depth: number, path: readonly number[]): RecipeNode => {
    nodeCount += 1;
    if (depth > maxSeenDepth) maxSeenDepth = depth;
    const def: ItemDef | undefined = ITEM_BY_ID.get(id);
    const recipe = def?.recipe;
    const hasRecipe = !!recipe && Object.keys(recipe).length > 0;
    const node: RecipeNode = {
      itemId: id,
      name: def ? itemName(id) : `未知物品#${id}`,
      needCount: need,
      craftable: hasRecipe,
      stationId: def?.station,
      children: [],
      subtreeCost: need,
      leafKinds: 0,
      depth,
      cyclic: false,
      truncated: false,
    };
    if (def?.station !== undefined) stations.add(def.station);

    if (!hasRecipe) {
      leaves.set(id, (leaves.get(id) ?? 0) + need);
      node.leafKinds = 1;
      return node;
    }

    if (path.includes(id)) {
      node.cyclic = true;
      cyclePaths.push([...path, id].join(' → '));
      node.leafKinds = 0;
      return node;
    }
    if (depth >= depthLimit) {
      node.truncated = true;
      leaves.set(id, (leaves.get(id) ?? 0) + need);
      node.leafKinds = 1;
      return node;
    }

    const nextPath = [...path, id];
    let cost = need;
    let kinds = 0;
    for (const [matId, perUnit] of Object.entries(recipe)) {
      const mId = Number(matId);
      const child = build(mId, perUnit * need, depth + 1, nextPath);
      node.children.push(child);
      cost += child.subtreeCost;
      kinds += child.leafKinds;
    }
    node.subtreeCost = cost;
    node.leafKinds = kinds;
    return node;
  };

  const root = build(Math.trunc(itemId), batch, 0, []);
  return {
    root,
    leaves,
    stations: [...stations],
    nodeCount,
    hasCycle: cyclePaths.length > 0,
    cyclePaths,
    maxDepth: maxSeenDepth,
  };
}

/** 展开为数组(广度优先),便于 UI 虚拟滚动 */
export function flattenTree(node: RecipeNode, includeCollapsed = true): RecipeNode[] {
  const out: RecipeNode[] = [];
  const queue: RecipeNode[] = [node];
  while (queue.length > 0) {
    const cur = queue.shift() as RecipeNode;
    out.push(cur);
    if (!includeCollapsed && (cur.cyclic || cur.truncated)) continue;
    for (const c of cur.children) queue.push(c);
  }
  return out;
}

/**
 * 检查库存是否满足配方。
 * 复杂度 O(叶子种类)。
 */
export function checkCraft(
  tree: RecipeTree,
  stock: ReadonlyMap<number, number> | Record<number, number>,
): CraftCheck {
  const get = (id: number): number => {
    if (stock instanceof Map) return stock.get(id) ?? 0;
    return (stock as Record<number, number>)[id] ?? 0;
  };
  const missing = new Map<number, number>();
  let satisfied = 0;
  for (const [id, need] of tree.leaves) {
    const have = get(id);
    if (have >= need) satisfied += 1;
    else missing.set(id, need - have);
  }
  return {
    craftable: missing.size === 0,
    missing,
    satisfied,
    totalKinds: tree.leaves.size,
  };
}

/** 缺料清单转可读文本 */
export function missingReport(check: CraftCheck): string {
  if (check.craftable) return '材料齐备,可合成';
  const parts: string[] = [];
  for (const [id, n] of check.missing) parts.push(`${itemName(id)}×${n}`);
  return `缺料:${parts.join('、')}`;
}

/* ───────────────────── 反向索引:某材料被谁用 ───────────────────── */

/** 材料 ID → 引用它的成品 ID 列表(升序)。复杂度 O(物品数 × 配方项数)。 */
export function buildUsageIndex(): Map<number, number[]> {
  const idx = new Map<number, number[]>();
  for (const it of ITEM_LIST) {
    if (!it.recipe) continue;
    for (const k of Object.keys(it.recipe)) {
      const mat = Number(k);
      const arr = idx.get(mat);
      if (arr) arr.push(it.id);
      else idx.set(mat, [it.id]);
    }
  }
  for (const arr of idx.values()) arr.sort((a, b) => a - b);
  return idx;
}

export const USAGE_INDEX: ReadonlyMap<number, readonly number[]> = buildUsageIndex();

export function usedBy(itemId: number): readonly number[] {
  return USAGE_INDEX.get(itemId) ?? [];
}

/** 合成树上的可达加工台清单(UI 顶部图标条) */
export function stationList(tree: RecipeTree): { id: number; name: string }[] {
  return tree.stations.map((id) => ({ id, name: itemName(id) }));
}

/* ───────────────────── 批次换算 ───────────────────── */

/** 把叶子需求乘以批次 */
export function scaleLeaves(tree: RecipeTree, batches: number): Map<number, number> {
  const b = Math.max(1, Math.trunc(batches));
  const out = new Map<number, number>();
  for (const [id, n] of tree.leaves) out.set(id, n * b);
  return out;
}

/** 输出 `expandRecipe` 的兼容视图(冻结层函数,保持同源) */
export function expandedRecipeOf(itemId: number, batches = 1): Record<number, number> {
  const def = ITEM_BY_ID.get(itemId);
  if (!def?.recipe) return {};
  return expandRecipe(def.recipe, Math.max(1, Math.trunc(batches)));
}

/** 配方树的稳定键(可用于缓存与虚拟列表 diff) */
export function treeKey(tree: RecipeTree): string {
  const station = tree.stations.slice().sort((a, b) => a - b).join('/');
  const leaf = [...tree.leaves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}x${v}`)
    .join(',');
  return `${tree.root.itemId}|${tree.root.needCount}|${station}|${leaf}`;
}

/** 背包格位提示:配方根物品在背包中的位置 */
export function rootSlot(tree: RecipeTree): number {
  return slotOf(tree.root.itemId);
}

/** 排序后的叶子列表,供 UI 稳定渲染 */
export function sortedLeaves(tree: RecipeTree): { itemId: number; name: string; need: number }[] {
  return [...tree.leaves.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, need]) => ({ itemId: id, name: itemName(id), need }));
}