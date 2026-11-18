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
 *   2 **同种子可复现**:随机数是 `(seed, mobId, itemId, killKey)` 的**纯函数**
 *     (`fnv1a32`,与内容指纹 / 存档 checksum 同族)→ 同种子同怪同物品**同一次击杀** ⇒ 同结果,
 *     且**不依赖调用顺序**(不是流式 RNG,不存在「谁先抽谁影响谁」)。
 *   3 **长期频率 ≈ 概率**:`roll` 在 `[0,1)` 上近似均匀 ⇒ `P(drop) = chance`。
 *     ⚠ 这一条**只在 `killKey` 逐次不同**时成立 —— 见第 5 条。
 *   4 非法输入**拒绝**而不是污染:
 *     - `chance` 非有限 / `<= 0` ⇒ 该物品**不掉**(fail-closed,不许静默变成必掉);
 *     - `chance > 1` ⇒ 钳到 1(必掉);
 *     - 未知 `mobId` ⇒ 空掉落(不抛错,调用方在受击/击杀热路径上);
 *     - `seed` 非有限 ⇒ 按 `0` 处理(仍是确定值,不是 `NaN` 随机)。
 *   5 **击杀实例维(`killKey`)** —— 第三轮实测 **P1**:roll 只吃 `(seed, mobId, itemId)` 时,
 *     同一世界里同种怪**每次击杀**的 roll 完全相同 ⇒ `dropChance` 退化成「该物种在这个世界
 *     **必掉 / 必不掉**」(实测 0% 或 100%),与第 3 条自相矛盾。修法:调用方把**每一次击杀的
 *     唯一标识**作为 `killKey` 传进来(生产传实例 id `` `mob_species#序号` ``,见
 *     `world_sim.ts#settleKill`)⇒ 同一次击杀可复现、不同次击杀在概率上**独立**。
 *     `killKey` 缺省 / 空串 = **不启用该维**(哈希串里不追加该段,逐位等于修前口径),
 *     只留给「一个物种只判一次」的纯函数调用点。
 * ## 不引入新依赖
 * 随机源是本文件内的 FNV-1a 32 位哈希(**6 行**),外加**击杀实例维路径上的一次 32 位雪崩**
 * (`avalanche32`,6 行 —— 为什么不能省见它的 docblock),不引第三方 RNG,也不用
 * `Math.random()`(它**不可复现**,判据就没法写)。
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

/**
 * 32 位**雪崩**混合(murmur3 的 `fmix32`,6 行;与 FNV-1a 同一「自包含、不引依赖」取舍)。
 *
 * ## 为什么需要它(**实测**)
 * FNV-1a 的**末位字符**几乎不扩散:两个输入只差最后一个字符时,输出恰好差
 * `(c1 ^ c2) * 0x01000193`(mod 2^32)—— 一个与全部前缀无关的**常量**。于是
 * `mob_squirrel#8` 与 `#9` 的 roll 只差 `0.0039` 量级 ⇒ 连打 100 次同种怪会得到
 * **成段相同**的结果(实测 seed 7 呈「9 掉 / 9 不掉 / …」阶梯,seed 9 整整 100 次全不掉),
 * 「同种怪每次击杀独立」根本没成立 —— 只是把「恒掉 / 恒不掉」换成了「阶梯」。
 *
 * 故**只在带击杀实例维的那条路径上**做一次雪崩(不带 `killKey` 的旧口径逐位不变,
 * 见 `mobDropRoll`);这 6 行买到的是「逐次击杀近似独立采样」。
 */
function avalanche32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
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
 * `(seed, mobId, itemId, killKey)` 的确定 roll ∈ `[0,1)`。
 *
 * 四个输入全进哈希 ⇒ 同一只怪的不同物品**各有独立**的 roll(不会「抽中一件就全中」),
 * 同一物品在不同世界种子下不同,**同一种怪的不同次击杀也不同**(见文件头第 5 条)。
 *
 * `killKey` = **这次击杀的唯一标识**(生产传实例 id,如 `mob_squirrel#7`);缺省 / 空串
 * ⇒ 哈希串里**不追加**该段、也**不做雪崩**(逐位等于 WS-FND-98 修前的 `(seed, mobId, itemId)`
 * 口径),只留给「一个物种只判一次」的调用点。**纯函数**:没有内部状态,调用顺序无影响。
 */
export function mobDropRoll(seed: number, mobId: string, itemId: number, killKey?: string): number {
  const kill = typeof killKey === 'string' ? killKey : '';
  const base = `${safeSeed(seed)}|${mobId}|${itemId}`;
  /* 0x100000000 = 2^32:两个哈希的值域都是 [0, 2^32) ⇒ 商恰在 [0,1)。 */
  if (kill === '') return parseInt(hash32(base), 16) / 0x100000000;
  return avalanche32(parseInt(hash32(`${base}|${kill}`), 16)) / 0x100000000;
}

/**
 * 判定一次击杀的掉落。**同种子同次击杀可复现**、必掉项恒在、概率项按 `chance` 抽。
 *
 * `killKey` = **这一次击杀的唯一标识**(生产传实例 id,如 `mob_squirrel#7`)。
 * ⚠ 不传它时 roll 只吃 `(seed, mobId, itemId)`,同一世界里同种怪**每次击杀都得到同一份
 * 掉落**(退化成「该物种在这个世界必掉 / 必不掉」)—— 生产调用点必须传(见文件头第 5 条)。
 *
 * 返回顺序 = `mobDropTableOf` 的顺序(itemId 升序),便于逐位比对。
 */
export function rollMobDrops(mobId: string, seed: number, killKey?: string): MobDropResult[] {
  const out: MobDropResult[] = [];
  for (const entry of mobDropTableOf(mobId)) {
    const roll = mobDropRoll(seed, mobId, entry.itemId, killKey);
    if (entry.chance >= 1 || roll < entry.chance) {
      out.push({ itemId: entry.itemId, count: entry.count, chance: entry.chance, roll });
    }
  }
  return out;
}

/** 判定结果的**物品 id 集合**(判定用的最简形状,判据主要读它)。 */
export function rolledDropIds(mobId: string, seed: number, killKey?: string): number[] {
  return rollMobDrops(mobId, seed, killKey).map((d) => d.itemId);
}
