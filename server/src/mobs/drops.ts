/**
 * WS-FND-98 · mob 掉落判定(纯函数 + **确定性**随机)。
 *
 * ## 这个模块解决什么
 * 手册 §4.2 给了每只野怪的掉落**清单与件数**,但 `shared/constants/mobs.ts` 的
 * `drops: Record<number, number>` 里**没有概率维** —— 于是「稀有材料」与「必掉材料」
 * 在数据上长得一模一样。本模块把两件事分开,并给出唯一一处判定实现:
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `drops[itemId]` | **件数**(手册写 `×N` 的那个 N) |
 * | `dropChance?[itemId]` | **概率**(0,1];**缺省 = 必掉**) |
 *
 * ## 判定口径(全部可判定)
 *   1 **必掉项仍必掉**:`chance` 缺省 / `>= 1` ⇒ `roll ∈ [0,1)` 恒小于它 ⇒ **每次都掉**。
 *   2 **同种子可复现**:随机数是 `(seed, mobId, itemId)` 的**纯函数**
 *     (`fnv1a32`,与内容指纹 / 存档 checksum 同族)→ 同种子同怪同物品 ⇒ 同结果,
 *     且**不依赖调用顺序**(不是流式 RNG,不存在「谁先抽谁影响谁」)。
 *   3 **长期频率 ≈ 概率**:`roll` 在 `[0,1)` 上近似均匀 ⇒ `P(drop) = chance`。
 *   4 非法输入**拒绝**而不是污染:
 *     - `chance` 非有限 / `<= 0` ⇒ 该物品**不掉**(fail-closed,不许静默变成必掉);
 *     - `chance` 非有限 / `<= 0` ⇒ 该物品**不掉**(fail-closed,不许静默变成必掉);
 *     - `chance > 1` ⇒ 钳到 1(必掉);
 *     - 未知 `mobId` ⇒ 空掉落(不抛错,调用方在受击/击杀热路径上);
 *     - `seed` 非有限 ⇒ 按 `0` 处理(仍是确定值,不是 `NaN` 随机)。
 * ## 不引入新依赖
 * 随机源是本文件内的 FNV-1a 32 位哈希(**6 行**),不引第三方 RNG,也不用 `Math.random()`
 * (它**不可复现**,判据就没法写)。
 *
 * ⚠️ 这里**故意不**复用 `content/registry.ts` 里的那份 `fnv1a32`:
 * `tests/WS-FND-01.ts#FND1-T43-1` 钉着一条可达性事实 —— registry.ts 的**生产引用者必须
 * 全不可达**(「被一个也不可达的模块引用」不等于「已接」)。本模块经 `world_sim.ts` 是**可达**的,
 * 一旦 import 它,那条判据立刻红。代价是 6 行同族哈希,换来的是不动一条既有架构判据。
 */
import { MOB_BY_ID, type MobDropRow } from '../../../shared/constants/mobs.ts';

/**
 * FNV-1a 32 位(与 `content/registry.ts#fnv1a32` / 存档 checksum **同族**,见文件头为什么抄这 6 行)。
 * 返回 8 位十六进制串。
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 缺省概率 = **必掉**(手册没写概率的项)。 */
export const MANDATORY_DROP_CHANCE = 1;

/** 掉落的**数据侧**一行:件数 + 概率。 */
export interface MobDropEntry {
  itemId: number;
  /** 件数(手册 `×N`;缺省 1) */
  count: number;
  /** 概率(0,1];1 = 必掉) */
  chance: number;
}

/** 判定后**真的掉出来**的一行(概率项没抽中就不在返回数组里)。 */
export interface MobDropResult {
  itemId: number;
  count: number;
  /** 本次判定用的概率(回执,便于判据与调试:不是「掉了所以是 1」) */
  chance: number;
  /** 本次的 roll(∈[0,1)),可判定地解释「为什么掉了 / 没掉」 */
  roll: number;
}

/* ══════════════════ 1. 概率与件数的归一(唯一入口) ══════════════════ */

/**
 * 取某只怪的某个掉落物的**概率**(0,1]。
 *
 * 归一规则(全部 fail-closed):缺省键 ⇒ `MANDATORY_DROP_CHANCE`(必掉);
 * 非有限 / `<= 0` ⇒ `0`(**不掉** —— 非法值不许被读成必掉);`> 1` ⇒ 钳到 `1`。
 */
export function mobDropChanceOf(mobId: string, itemId: number): number {
  const row = MOB_BY_ID.get(mobId) as MobDropRow | undefined;
  const raw = row?.dropChance?.[itemId];
  if (raw === undefined) return MANDATORY_DROP_CHANCE;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1 ? 1 : raw;
}

/** 件数:手册的 `×N`。非有限 / 小数 / `< 1` ⇒ 1(「必掉列写了就是至少 1 件」,同 Boss 战利品口径)。 */
export function mobDropCountOf(mobId: string, itemId: number): number {
  const row = MOB_BY_ID.get(mobId) as MobDropRow | undefined;
  const raw = row?.drops?.[itemId];
  if (raw === undefined || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
}

/**
 * 掉落的**数据侧清单**(按 itemId 升序 ⇒ 顺序与对象键序无关,判定可复盘)。
 * 未知 mobId ⇒ 空数组。
 */
export function mobDropTableOf(mobId: string): readonly MobDropEntry[] {
  const row = MOB_BY_ID.get(mobId) as MobDropRow | undefined;
  if (row === undefined) return [];
  return Object.keys(row.drops)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((itemId) => ({
      itemId,
      count: mobDropCountOf(mobId, itemId),
      chance: mobDropChanceOf(mobId, itemId),
    }));
}

/* ══════════════════ 2. 确定性 roll ══════════════════ */

/** `seed` 归一:非有限 ⇒ 0(仍是确定值)。 */
function safeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) : 0;
}

/**
 * `(seed, mobId, itemId)` 的确定 roll ∈ `[0,1)`。
 *
 * 三个输入全进哈希 ⇒ 同一只怪的不同物品**各有独立**的 roll(不会「抽中一件就全中」),
 * 同一物品在不同世界种子下不同。**纯函数**:没有内部状态,调用顺序无影响。
 */
export function mobDropRoll(seed: number, mobId: string, itemId: number): number {
  /* 0x100000000 = 2^32:`hash32` 的值域是 [0, 2^32) ⇒ 商恰在 [0,1)。 */
  return parseInt(hash32(`${safeSeed(seed)}|${mobId}|${itemId}`), 16) / 0x100000000;
}

/**
 * 判定一次击杀的掉落。**同种子可复现**、必掉项恒在、概率项按 `chance` 抽。
 *
 * 返回顺序 = `mobDropTableOf` 的顺序(itemId 升序),便于逐位比对。
 */
export function rollMobDrops(mobId: string, seed: number): MobDropResult[] {
  const out: MobDropResult[] = [];
  for (const entry of mobDropTableOf(mobId)) {
    const roll = mobDropRoll(seed, mobId, entry.itemId);
    if (entry.chance >= 1 || roll < entry.chance) {
      out.push({ itemId: entry.itemId, count: entry.count, chance: entry.chance, roll });
    }
  }
  return out;
}

/** 判定结果的**物品 id 集合**(判定用的最简形状,判据主要读它)。 */
export function rolledDropIds(mobId: string, seed: number): number[] {
  return rollMobDrops(mobId, seed).map((d) => d.itemId);
}
