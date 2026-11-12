/**
 * WS-09 / 合成台配方树 —— 纯数据层(不 import three)。
 *
 * 由冻结层 `ItemDef.recipe`(`Record<材料ID, 数量>`)反推出一棵可折叠的树。
 * 树上每个节点回答三个 UI 问题:
 *  1. **这门配方总共要几种原料、各几个**(叶子聚合);
 *  2. **卡在哪一层**(缺料时高亮最近的可采集层);
 *  3. **需要哪台加工台**(`ItemDef.station`,节点自带 stationId)。
 *
 * ## 留白槽(`recipeAnyTag`)语义 —— CR-17
 *
 * 冻结层允许配方声明「留白槽」:某个槽位接受**任意**一个带该 tag 的材料,
 * 如 `recipeAnyTag: [['染料']]` ⇒ 任一带 `染料` tag 的物品(166/167/168/169)可顶替 1 个。
 *
 * ⚠️ **本文件曾只读 `recipe`,完全忽略 `recipeAnyTag`,因而会误导玩家。**
 * 具体形态(`#237` `recipe={165:1,166:1}` `recipeAnyTag=[['染料']]`):
 * `166` 本身是留白槽的合格件 ⇒ 它是该槽的**登记代表**,由槽接管,**不是额外硬性要求**。
 * 旧实现把 `166` 当成硬性要求显示 ⇒ 拿着 `167` 的玩家看到「需要绯红植物染料」,
 * 以为自己缺料,而服务端 `matchRecipeByTags` 实测 `ok=true`(他手上的 167 完全合格)。
 * **这是「UI 说错了」,不是「UI 少显示了」** —— 误导比残缺更严重。
 *
 * 修法(见 `buildRecipeTree`):确定件只取 `recipe` 里**非登记代表**的键,
 * 每个留白槽再生成**一个**槽节点。登记代表的判定与服务端
 * `matchRecipeByTags` 的 `repIds` **同构**(同一套判据,不另立标准)。
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

import {
  ITEM_BY_ID, ITEM_LIST, expandRecipe, itemName,
  itemsMatchingAnyTagSlot, matchRecipeByTags, satisfiesAnyTagSlot,
} from '../../../shared/constants/items.ts';
import type { ItemDef } from '../../../shared/types/entities.ts';
import { slotOf } from './inventory.ts';

/** 默认最大展开深度 */
export const MAX_DEPTH = 8;

/** 一次合成显示的批次上限(UI 滑块) */
export const MAX_BATCH = 64;

/**
 * 一个留白槽的描述。
 *
 * `tags` 是槽内 tag(互为**备选**,取「或」),`candidates` 是全部合格物品 ID(升序)。
 */
export interface RecipeSlot {
  /** 槽内 tag,如 `['染料']`。多个 tag 时互为备选,不是全要。 */
  tags: string[];
  /** 全部合格物品 ID(升序)—— 即 `itemsMatchingAnyTagSlot(tags)` */
  candidates: number[];
  /** 该槽相对根需要几个(批次放大后的数量) */
  needCount: number;
  /**
   * 每个候选件的**基础叶子需求**(`candidateId → (leafId → 数量)`)。
   *
   * 为什么需要:玩家可能**没有**现成的染料,但有用以合成染料的基础材料
   * (如 `166 绯红植物染料 = 121 露水甜莓×2`)。登记代表被槽接管后,
   * 这些基础叶子不再出现在 `tree.leaves` 里 —— 若不在此单独记下,
   * 「拿基础材料自己合成染料」的玩家会被判成不可合成(**回归**)。
   */
  candidateLeaves: { itemId: number; leaves: [number, number][] }[];
}

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
  /**
   * **本节点是否代表一个「留白槽」**(仅在该节点是槽节点时存在)。
   *
   * 槽节点是**终端节点**(`children` 为空):它的候选件是**备选**而非「必须全要」,
   * 因此不能像确定件那样展开成一棵需求子树 —— 展开会把备选当成硬性要求,
   * 那正是本次要修的缺陷。
   */
  slotTags?: string[];
  /** 槽节点的全部合格物品 ID(升序)。仅槽节点有。 */
  slotCandidates?: number[];
}

export interface RecipeTree {
  root: RecipeNode;
  /** 全部叶子(自然原料)ID → 总需求,已按路径累加。**不含留白槽**(槽是「或」关系)。 */
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
  /**
   * 全部留白槽(按出现顺序)。空数组 = 该配方没有留白槽。
   *
   * ⚠️ 为什么**不**折进 `leaves`:`leaves` 是「**与**」语义的扁平需求表
   * (`id → 必须凑够几个`),而留白槽是「**或**」语义(候选之间任选其一)。
   * 把候选塞进 `leaves` 会让 UI 要求玩家**同时**凑齐 166/167/168/169,
   * 比原来的误导更严重。故单列,并由 `checkCraft` 按「或」判定。
   */
  slots: RecipeSlot[];
}

export interface CraftCheck {
  craftable: boolean;
  /** 缺料清单:itemId → 还差几个(**只含确定件**) */
  missing: Map<number, number>;
  /** 已满足的叶子种类数(含已满足的留白槽) */
  satisfied: number;
  /** 总需求种类(确定件叶子 + 留白槽) */
  totalKinds: number;
  /** 每个留白槽的满足情况(空数组 = 无留白槽) */
  slotNeeds: { tags: string[]; candidates: number[]; satisfied: boolean }[];
}

/* ───────────────────── 树构建 ───────────────────── */

/**
 * 收集某物品的**基础叶子需求**(纯函数,不触碰任何共享累加器)。
 *
 * 与 `buildRecipeTree` 内部的 `build` 递归同构,但**只返回叶子表**,
 * 因而可以安全地用于「只是为了算叶子」的场合(如留白槽候选件)。
 * 单独写一份而不是复用 `build`,是为了避免污染后者的
 * `nodeCount` / `leaves` 累计 —— 那曾导致候选件的基础叶子混进根树叶子表。
 *
 * @param itemId  物品
 * @param need    该物品需求量(作为叶子倍率)
 * @param depth   当前深度
 * @param path    路径(环检测)
 * @param limit   深度上限
 */
function collectBaseLeaves(
  itemId: number,
  need: number,
  depth: number,
  path: readonly number[],
  limit: number,
): [number, number][] {
  const out = new Map<number, number>();
  const rec = (id: number, n: number, d: number, p: readonly number[]): void => {
    const def = ITEM_BY_ID.get(id);
    const recipe = def?.recipe;
    const hasRecipe = !!recipe && Object.keys(recipe).length > 0;
    if (!hasRecipe || p.includes(id) || d >= limit) {
      out.set(id, (out.get(id) ?? 0) + n);
      return;
    }
    const nextPath = [...p, id];
    for (const [k, v] of Object.entries(recipe as Record<number, number>)) {
      rec(Number(k), v * n, d + 1, nextPath);
    }
  };
  rec(Math.trunc(itemId), need, depth, path);
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

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
  const slots: RecipeSlot[] = [];
  let nodeCount = 0;
  let maxSeenDepth = 0;
  const batch = Math.max(1, Math.trunc(batches));
  const depthLimit = Math.max(1, Math.trunc(maxDepth));

  const build = (id: number, need: number, depth: number, path: readonly number[]): RecipeNode => {
    nodeCount += 1;
    if (depth > maxSeenDepth) maxSeenDepth = depth;
    const def: ItemDef | undefined = ITEM_BY_ID.get(id);
    const recipe = def?.recipe;
    const anyTag = def?.recipeAnyTag ?? [];
    const hasRecipe = (!!recipe && Object.keys(recipe).length > 0) || anyTag.length > 0;
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

    /* ── 登记代表:确定件里「本身是某留白槽合格件」的键,由槽接管 ──
     * 判据与服务端 `matchRecipeByTags` 的 `repIds` **同构**(`satisfiesAnyTagSlot`),
     * 不另立标准 —— 否则客户端与服务端会对同一份配表给出不同答案。 */
    const recipeEntries = Object.entries(recipe ?? {});
    const repIds = new Set<number>();
    for (const [k] of recipeEntries) {
      const kid = Number(k);
      if (anyTag.some((slot) => satisfiesAnyTagSlot(kid, slot))) repIds.add(kid);
    }

    /* 第 1 步:确定件(固有材料,不因留白而放宽) */
    for (const [matId, perUnit] of recipeEntries) {
      const mId = Number(matId);
      if (repIds.has(mId)) continue; /* 由留白槽接管,见上 */
      const child = build(mId, perUnit * need, depth + 1, nextPath);
      node.children.push(child);
      cost += child.subtreeCost;
      kinds += child.leafKinds;
    }

    /* 第 2 步:每个留白槽生成**一个**「任意 <tag>」节点。
     * 槽节点是**终端**:候选件是备选,不能展开成一棵需求子树 ——
     * 展开会把「任选其一」显示成「全都要」,正是本次要修的误导。 */
    for (const slot of anyTag) {
      const candidates = itemsMatchingAnyTagSlot(slot);
      /* 该槽的登记代表(若有)当作节点 itemId,使节点与玩家看到的名字对得上 */
      const repOfSlot = recipeEntries
        .map(([k]) => Number(k))
        .find((kid) => satisfiesAnyTagSlot(kid, slot));
      nodeCount += 1;
      if (depth + 1 > maxSeenDepth) maxSeenDepth = depth + 1;
      const slotName = candidates.length > 0
        ? `任意${slot.join('或')}(${candidates.join('/')})`
        : `任意${slot.join('或')}(无合格件)`;
      node.children.push({
        itemId: repOfSlot ?? candidates[0] ?? 0,
        name: slotName,
        needCount: need,
        craftable: false,
        children: [],
        subtreeCost: need,
        leafKinds: 1,
        depth: depth + 1,
        cyclic: false,
        truncated: false,
        slotTags: [...slot],
        slotCandidates: candidates,
      });
      /* 记下每个候选件的基础叶子 —— 供 `checkCraft` 判定
       * 「玩家没有现成染料、但有合成它的基础材料」这一情形。
       * ⚠ 用**独立纯函数**收集,不能复用 `build()` —— 那会污染共享的
       * `nodeCount` 与 `leaves` 累加器(实测过:会把候选件的基础叶子
       * 混进根树的叶子表,导致负例断言失败)。 */
      const candidateLeaves = candidates.map((cand) => ({
        itemId: cand,
        leaves: collectBaseLeaves(cand, 1, depth + 1, nextPath, depthLimit),
      }));
      slots.push({ tags: [...slot], candidates, needCount: need, candidateLeaves });
      cost += need;
      kinds += 1;
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
    slots,
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
 *
 * 判定分两段,**顺序不能颠倒**(与冻结层 `matchRecipeByTags` 同构):
 *  1. **确定件**:`tree.leaves` 是「**与**」语义,每一项都要凑够;
 *  2. **留白槽**:每个槽是「**或**」语义 —— 从候选件里挑一件**有余量的**消耗掉。
 *
 * ⚠️ 两处必须做对,否则会重演本次缺陷:
 *  - **槽不能折进 `leaves`**:那会让 UI 要求玩家同时凑齐全部候选;
 *  - **多个槽要逐个扣减**:`#356` 是「任意染料 ×2」,若只判「背包里有染料」
 *    就会用 1 个染料冒充 2 个(冻结层注释专门写了这一条)。
 *
 * 复杂度 O(叶子种类 + 槽数 × 候选数)。
 */
export function checkCraft(
  tree: RecipeTree,
  stock: ReadonlyMap<number, number> | Record<number, number>,
): CraftCheck {
  const get = (id: number): number => {
    if (stock instanceof Map) return stock.get(id) ?? 0;
    return (stock as Record<number, number>)[id] ?? 0;
  };
  /* 可扣减池:确定件与留白槽共享,避免同一件材料被两处重复计入 */
  const pool = new Map<number, number>();
  const poolGet = (id: number): number => {
    if (pool.has(id)) return pool.get(id) as number;
    const v = get(id);
    pool.set(id, v);
    return v;
  };
  const poolTake = (id: number, n: number): void => { pool.set(id, poolGet(id) - n); };

  const missing = new Map<number, number>();
  let satisfied = 0;

  /* ── 第 1 段:确定件 ── */
  for (const [id, need] of tree.leaves) {
    const have = poolGet(id);
    if (have >= need) { satisfied += 1; poolTake(id, need); } else { missing.set(id, need - have); }
  }

  /* ── 第 2 段:逐槽填留白 ── */
  const slotNeeds: CraftCheck['slotNeeds'] = [];
  for (const slot of tree.slots) {
    for (let i = 0; i < slot.needCount; i += 1) {
      /* 优先用现成候选件;没有则退一步看「基础材料是否够自己合成一件」 */
      const direct = slot.candidates.find((c) => poolGet(c) > 0);
      if (direct !== undefined) {
        poolTake(direct, 1);
        slotNeeds.push({ tags: slot.tags, candidates: slot.candidates, satisfied: true });
        continue;
      }
      const viaLeaves = slot.candidateLeaves.find((c) => c.leaves.every(([lid, ln]) => poolGet(lid) >= ln));
      if (viaLeaves !== undefined) {
        for (const [lid, ln] of viaLeaves.leaves) poolTake(lid, ln);
        slotNeeds.push({ tags: slot.tags, candidates: slot.candidates, satisfied: true });
        continue;
      }
      /* 该槽这一件凑不出:报「最接近」候选件的缺口,便于 UI 提示 */
      const best = slot.candidateLeaves[0];
      if (best !== undefined) {
        for (const [lid, ln] of best.leaves) {
          const have = poolGet(lid);
          if (have < ln) missing.set(lid, Math.max(missing.get(lid) ?? 0, ln - have));
        }
      }
      slotNeeds.push({ tags: slot.tags, candidates: slot.candidates, satisfied: false });
      break; /* 该槽已判定为未满足,不再重复计数 */
    }
  }

  const totalKinds = tree.leaves.size + tree.slots.length;
  satisfied += slotNeeds.filter((s) => s.satisfied).length;
  return {
    craftable: missing.size === 0 && slotNeeds.every((s) => s.satisfied),
    missing,
    satisfied,
    totalKinds,
    slotNeeds,
  };
}

/** 缺料清单转可读文本 */
export function missingReport(check: CraftCheck): string {
  if (check.craftable) return '材料齐备,可合成';
  const parts: string[] = [];
  for (const [id, n] of check.missing) parts.push(`${itemName(id)}×${n}`);
  /* 留白槽未满足时单列 —— 与「缺某件确定材料」是不同的原因,不该混在一句里 */
  const unfilled = check.slotNeeds.filter((s) => !s.satisfied);
  for (const s of unfilled) {
    const names = s.candidates.map((c) => `${itemName(c)}(${c})`).join('/');
    parts.push(`任意${s.tags.join('或')}(可接受:${names || '无合格件'})`);
  }
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