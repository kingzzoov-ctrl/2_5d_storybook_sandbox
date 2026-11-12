/**
 * WS-05:祭坛召唤、人数血量缩放与个人独立掉落(Personal Loot)。
 *
 * 依赖冻结层:`shared/constants/bosses.ts`(8 个 Boss 定义)、
 * `shared/types/entities.ts#bossScaledHp`。
 */

import { BOSS_BY_ID, BOSS_LIST } from '../../../shared/constants/bosses.ts';
import { bossScaledHp } from '../../../shared/types/entities.ts';
import type { BossDef } from '../../../shared/types/entities.ts';
import { isInsideSafeRadius } from '../mobs/spawner.ts';
import { createBossState, type BossState } from './phases.ts';

/* ─────────────── 召唤祭品 ─────────────── */

/**
 * Boss → 召唤祭品 ID。冻结层已给出,这里只做**冻结校验与反查**,
 * 数值本体不与手册产生第二事实源。
 */
export const SUMMON_ITEM_BY_BOSS: ReadonlyMap<string, number> = new Map(
  BOSS_LIST.map((b) => [b.id, b.summonItem]),
);

/** 祭品 ID → Boss ID(反查,供祭坛方块判定)。 */
export const BOSS_BY_SUMMON_ITEM: ReadonlyMap<number, string> = new Map(
  BOSS_LIST.map((b) => [b.summonItem, b.id]),
);

/** 祭品 ID 段:734-741,与手册 §3.10 完全一致。 */
export const SUMMON_ITEM_MIN = 734;
export const SUMMON_ITEM_MAX = 741;

/** 召唤要求:同屏最少/最多人数。 */
export const RAID_MIN_PLAYERS = 1;
export const RAID_MAX_PLAYERS = 16;
/** 祭坛周围玩家参与判定半径(格):与经验共享半径一致。 */
export const RAID_PARTICIPATION_RADIUS = 24;

export const SummonReject = {
  OK: 'OK',
  UNKNOWN_BOSS: 'UNKNOWN_BOSS',
  WRONG_ITEM: 'WRONG_ITEM',
  NO_ALTAR: 'NO_ALTAR',
  /** 祭坛落在城镇安全区内 —— 与 `mobs/spawner.ts#SpawnReject.SAFE_ZONE` 同一字符串。 */
  SAFE_ZONE: 'SAFE_ZONE',
  TOO_MANY_PLAYERS: 'TOO_MANY_PLAYERS',
  BOSS_ALIVE: 'BOSS_ALIVE',
  /**
   * 祭品库存不足 —— **只在所有其它校验都通过之后**才可能返回。
   *
   * 见 `summonBossWithOffering`:顺序是「先全量校验,再扣除」,
   * 绝不「先扣再发现不够」。
   */
  NO_OFFERING: 'NO_OFFERING',
} as const;
export type SummonReject = (typeof SummonReject)[keyof typeof SummonReject];

export interface SummonRequest {
  bossId: string;
  /** 玩家投放到祭坛上的物品 ID。 */
  itemId: number;
  /** 是否存在激活的祭坛方块。 */
  hasAltar: boolean;
  /** 祭坛方块坐标(格),用于安全区判定。 */
  altarX: number;
  altarY: number;
  /** 城镇中心坐标(格)。 */
  townCenterX: number;
  townCenterY: number;
  /** 祭坛半径内的人数。 */
  playerCount: number;
  /** 该 Boss 是否已在场内存活。 */
  alreadyAlive: boolean;
}

export interface SummonResult {
  ok: boolean;
  reason: SummonReject;
  state?: BossState;
  /** 缩放后血量。 */
  scaledHp: number;
}

/**
 * 祭坛召唤。
 *
 * 拒绝顺序(短路,由廉价到昂贵):未知 Boss → 祭坛缺失 → **祭坛在城镇安全区内** →
 * 祭品不匹配 → 人数越界 → 已有同 Boss 存活。
 *
 * **安全区规则(Lead 裁决 3)**:祭坛落在安全区内 → 召唤失败。
 * 安全区禁刷怪(`spawner.ts` 的 `SpawnReject.SAFE_ZONE`),Boss 也是怪,同规则;
 * 判定复用 `isInsideSafeRadius`,与刷怪路径共享同一事实源,杜绝双标准。
 */
export function summonBoss(req: SummonRequest): SummonResult {
  const def = BOSS_BY_ID.get(req.bossId);
  if (!def) return { ok: false, reason: SummonReject.UNKNOWN_BOSS, scaledHp: 0 };
  if (!req.hasAltar) return { ok: false, reason: SummonReject.NO_ALTAR, scaledHp: 0 };
  if (isInsideSafeRadius(req.altarX, req.altarY, req.townCenterX, req.townCenterY)) {
    return { ok: false, reason: SummonReject.SAFE_ZONE, scaledHp: 0 };
  }
  if (req.itemId !== def.summonItem) {
    return { ok: false, reason: SummonReject.WRONG_ITEM, scaledHp: 0 };
  }
  if (req.playerCount < RAID_MIN_PLAYERS || req.playerCount > RAID_MAX_PLAYERS) {
    return { ok: false, reason: SummonReject.TOO_MANY_PLAYERS, scaledHp: 0 };
  }
  if (req.alreadyAlive) return { ok: false, reason: SummonReject.BOSS_ALIVE, scaledHp: 0 };
  const state = createBossState(req.bossId, req.playerCount);
  return { ok: true, reason: SummonReject.OK, state, scaledHp: state.maxHp };
}

/* ─────────────── 祭品消耗(owner 裁决 D-03)─────────────── */

/**
 * 祭品库存端口 —— 把「有多少 / 扣一个」这两件事注入进来,
 * 让 `summonBoss` 系列保持**纯函数**、可被 node 零依赖测试。
 *
 * ## 为什么用端口而不是直接 import `db/repo.ts`
 *
 * `server/src/bosses/` 现有三个文件(`raid`/`phases`/`breaks`)**全部只依赖冻结层**,
 * 不碰数据库。改成直接 import repo 会把 Boss 战逻辑与存储层焊死:
 * 测试要建 db、迁移、造用户才能测一次召唤,而且 `bosses/` 会多出一条
 * 「业务 → 存储」的硬依赖。端口注入让两侧各自可测。
 *
 * 生产装配时传 `consumeItem` 的适配器;测试里传一个内存计数闭包即可。
 */
export interface OfferingPort {
  /** 玩家当前持有多少个该祭品 */
  countOf: (ownerId: string, itemId: number) => number;
  /**
   * 扣除 `n` 个。**必须原子且全成功或全不动**:
   * 返回 `false` 表示库存不足且**未扣除任何东西**。
   * (`db/repo.ts#consumeItem` 正是这个语义:数量不足返回 false 且不写库。)
   */
  consume: (ownerId: string, itemId: number, n: number) => boolean;
}

/** 召唤请求 + 祭品归属。 */
export interface SummonWithOfferingRequest extends SummonRequest {
  /** 谁在献祭 —— 祭品从这个玩家的库存里扣 */
  ownerId: string;
}

/** 召唤结果 + 是否真的扣了祭品。 */
export interface SummonWithOfferingResult extends SummonResult {
  /** 本次是否扣除了祭品。失败路径**恒为 false** */
  offeringConsumed: boolean;
}

/**
 * 祭坛召唤(**含祭品消耗**)。
 *
 * ## 顺序是这条链路的全部要点
 *
 * ```
 * 1. summonBoss() 全量校验(未知 Boss / 无祭坛 / 安全区 / 祭品不匹配 /
 *    人数越界 / 同 Boss 存活)
 * 2. 校验全过 → 再查库存 countOf
 * 3. 库存够 → consume 扣 1
 * 4. consume 返回 false(并发下被别人先扣走)→ 按 NO_OFFERING 失败,**召唤不成立**
 * ```
 *
 * **绝不能反过来「先扣再发现不够」**:那会在失败时留下已经扣掉的祭品,
 * 玩家丢东西而 Boss 没出来,而且这种状态一旦持久化就无法自动区分
 * 「玩家本来就没有祭品」和「服务端扣错了」。
 *
 * ## `consume` 返回 false 时为什么还要单独判一次
 *
 * 第 2 步的 `countOf` 与第 3 步的 `consume` 之间不是原子的(两玩家同时献祭)。
 * `countOf` 只是**廉价预检**,真正的判据是 `consume` 的返回值 ——
 * 所以第 4 步必须存在,否则并发下会出现「校验说有、扣的时候没了、却仍然召唤成功」。
 */
export function summonBossWithOffering(
  req: SummonWithOfferingRequest,
  port: OfferingPort,
): SummonWithOfferingResult {
  /* ① 全量校验先行 —— 任何失败都在**扣东西之前**返回 */
  const base = summonBoss(req);
  if (!base.ok) return { ...base, offeringConsumed: false };

  /* ② 预检:没有祭品就不必再动库存 */
  if (port.countOf(req.ownerId, req.itemId) < 1) {
    return { ok: false, reason: SummonReject.NO_OFFERING, scaledHp: 0, offeringConsumed: false };
  }

  /* ③ 真扣 —— 返回值是**唯一**判据 */
  if (!port.consume(req.ownerId, req.itemId, 1)) {
    return { ok: false, reason: SummonReject.NO_OFFERING, scaledHp: 0, offeringConsumed: false };
  }

  /* ④ 扣成功 ⇒ 召唤成立 */
  return { ...base, offeringConsumed: true };
}

/**
 * 用 `db/repo.ts` 风格的回调搭一个 `OfferingPort`。
 *
 * 参数是**函数**而不是 `DbLike`:本模块不 import 存储层,保持 `bosses/**`
 * 对 `node:*` 之外零依赖(`raid`/`phases`/`breaks` 三个文件此前都只依赖冻结层)。
 * 装配层把 `listItems`/`consumeItem` 包进来即可。
 *
 * ## 多实例时为什么要真的回滚
 *
 * 同一个祭品 ID 可能散在多个实例上(合成分批入库)。扣 `n` 个要跨实例,
 * 而每次 `consumeInstance` 只保证「自己这一次全成或全不动」——
 * 若第二个实例失败,第一个实例**已经被扣掉了**。
 *
 * 只写一句「失败即放弃」的注释不算数:那会留下**半扣状态**,而半扣状态
 * 又恰好是「玩家丢东西、Boss 没出来」的形态,正是本函数要防的。
 * 所以这里记下已扣明细,失败时逐条 `restoreInstance` 补回去。
 */
export function makeOfferingPort(hooks: {
  /** 列出某玩家全部实例(含 `quantity`),用于按物品 ID 汇总 */
  listOwned: (ownerId: string) => readonly { instanceId: string; itemId: number; quantity: number }[];
  /** 扣某个实例的 n 个;不足返回 false 且不改库 */
  consumeInstance: (instanceId: string, n: number) => boolean;
  /** 把已扣的 n 个补回该实例(回滚用) */
  restoreInstance: (instanceId: string, n: number) => void;
}): OfferingPort {
  return {
    countOf: (ownerId, itemId) => hooks
      .listOwned(ownerId)
      .filter((r) => r.itemId === itemId)
      .reduce((s, r) => s + r.quantity, 0),

    consume: (ownerId, itemId, n) => {
      if (n <= 0) return true;
      const rows = hooks.listOwned(ownerId).filter((r) => r.itemId === itemId && r.quantity > 0);
      const total = rows.reduce((s, r) => s + r.quantity, 0);
      if (total < n) return false;

      const applied: { instanceId: string; n: number }[] = [];
      let left = n;
      for (const r of rows) {
        if (left <= 0) break;
        const take = Math.min(left, r.quantity);
        if (!hooks.consumeInstance(r.instanceId, take)) {
          /* 半扣回滚:把此前已扣的逐条补回,再报失败 */
          for (const a of applied) hooks.restoreInstance(a.instanceId, a.n);
          return false;
        }
        applied.push({ instanceId: r.instanceId, n: take });
        left -= take;
      }
      /* 理论上到不了这里(total ≥ n 已保证);到了说明 listOwned 期间被并发改动,
         同样必须回滚,不能「扣了一部分还返回成功」。 */
      if (left > 0) {
        for (const a of applied) hooks.restoreInstance(a.instanceId, a.n);
        return false;
      }
      return true;
    },
  };
}

/* ─────────────── 人数血量缩放 ─────────────── */

export interface ScalingCurve {
  /** 每个 N 的血量。 */
  curve: number[];
  /** 是否严格单调递增。 */
  monotonic: boolean;
  /** N=1 时等于 baseHp。 */
  baseAtOne: boolean;
}

/**
 * 生成 N = 1..maxPlayers 的缩放曲线。
 *
 * 冻结公式 `bossScaledHp(baseHp, n) = round(baseHp × (1 + 0.65(n−1)))`
 * 对 n ≥ 1 恒为严格递增(斜率 0.65 × baseHp ≥ 1625 ≫ 舍入误差 0.5)。
 */
export function scalingCurve(baseHp: number, maxPlayers = 16): ScalingCurve {
  const curve: number[] = [];
  for (let n = 1; n <= maxPlayers; n += 1) curve.push(bossScaledHp(baseHp, n));
  let monotonic = true;
  for (let i = 1; i < curve.length; i += 1) {
    if (!(curve[i] > curve[i - 1])) monotonic = false;
  }
  return { curve, monotonic, baseAtOne: curve[0] === baseHp };
}

/** 全部 8 个 Boss 的缩放曲线摘要。 */
export function allScalingCurves(maxPlayers = 16): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of BOSS_LIST) out[b.id] = bossScaledHp(b.baseHp, maxPlayers);
  return out;
}

/* ─────────────── 个人独立掉落 ─────────────── */

export interface RaidParticipant {
  id: string;
  /** 是否参与了本次战斗(在参与半径内且造成过伤害)。 */
  contributed: boolean;
  /** 累计伤害,用于加权数量。 */
  damageDealt: number;
  x: number;
  y: number;
}

export interface LootEntry { itemId: number; count: number; }

/** 一个只属于某玩家的掉落光球:他人不可见、不可拾取。 */
export interface LootOrb {
  orbId: string;
  ownerId: string;
  x: number;
  y: number;
  entries: LootEntry[];
  exp: number;
  personal: true;
}

/** 掉落光球散布半径(格)。 */
export const LOOT_SCATTER_RADIUS = 2.5;

/** 确定性字符串哈希(FNV-1a 32 位),保证同一 (bossId, ownerId) 掉落可复现。 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 由种子生成可复现的 [0,1) 序列(Mulberry32,与测试桩同族)。 */
export function seededRoll(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 手册口径的「实际必掉清单」。
 *
 * ## 为什么需要这一层(CR-16)
 *
 * `BossDef.loot` 同时被 `contentFingerprints()` 的 bosses 分区哈希,
 * 所以**不能**直接改它来对齐手册。但手册与代码确实有三处偏离:
 *
 * | Boss | 偏离 |
 * | :--- | :--- |
 * | `boss_beaver_mecha` | 手册 L496 要 `703×10`;且 `437` 是 L313 的**可造载具**,不是战利品 |
 * | `boss_sky_whale` | 手册 L501 要 `117×15`;且 `440` 是 L316 的**可造载具**,只被当驾驶手段 |
 * | `boss_chronos_colossus` | 手册 L502 的「纯金通关纪念碑」在 320 表内不存在 |
 *
 * ⇒ 修法:偏离记在 `lootQty` / `lootAbstract` / `lootDeviations` 三个**附加字段**上,
 * 由本函数在**生产掉落路径**上落实。`loot` 一个字节不动、指纹不漂移,
 * 而「打河狸拿到 1 个钢牙」「打完云鲸白得一艘飞艇」这两个实际错误被真正修掉。
 *
 * 返回的 `qty` 与 `out` 逐位对应;`abstract` 是手册写了但没有 ID 的奖励原文。
 */
export function effectiveLoot(def: BossDef): { out: number[]; qty: number[]; abstract: string[] } {
  const deviations = new Set((def.lootDeviations ?? []).map((d) => d.itemId));
  const out: number[] = [];
  const qty: number[] = [];
  for (let i = 0; i < def.loot.length; i += 1) {
    const itemId = def.loot[i];
    /* 被标注为「手册里不是战利品」的件不参与掉落 —— 不删 loot,只在生产侧过滤。 */
    if (deviations.has(itemId)) continue;
    out.push(itemId);
    /* `lootQty` 与 `loot` 逐位对应;缺省 1(手册未注数量即 1 件)。 */
    qty.push(def.lootQty?.[i] ?? 1);
  }
  return { out, qty, abstract: [...(def.lootAbstract ?? [])] };
}

/**
 * 结算个人独立掉落。
 *
 * 规则:
 *  - **每位参与战斗的玩家各自获得一个独立光球**(8 人 → 8 球),
 *    光球 `personal: true` 且 `ownerId` 唯一,互不可见;
 *  - 战利品取自 `effectiveLoot(def)` —— 即 `def.loot` 剔除 `lootDeviations`
 *    标注的「手册里不是战利品」条目(见 CR-16);
 *  - 数量 = **手册数量**(`lootQty`,缺省 1)× `(1 + floor(damageShare × 2))` × `dropMul`;
 *  - 经验按 `def.exp` 全额 × 伤害份额,3 人以上套用冻结层 `PARTY_BONUS`;
 *  - 未参与者(挂机/提前离场)不产出光球。
 */
export function rollPersonalLoot(
  bossId: string,
  participants: readonly RaidParticipant[],
  opts: { partyBonus?: number; dropMul?: number } = {},
): LootOrb[] {
  const def = BOSS_BY_ID.get(bossId);
  if (!def) return [];
  const partyBonus = opts.partyBonus ?? 0;
  const dropMul = opts.dropMul ?? 1;

  const contributors = participants.filter((p) => p.contributed);
  if (contributors.length === 0) return [];
  const totalDamage = contributors.reduce((s, p) => s + Math.max(0, p.damageDealt), 0);
  const evenShare = 1 / contributors.length;

  const orbs: LootOrb[] = [];
  const eff = effectiveLoot(def);
  for (const p of contributors) {
    const share = totalDamage > 0 ? Math.max(0, p.damageDealt) / totalDamage : evenShare;
    const rng = seededRoll(fnv1a(`${bossId}|${p.id}`));
    const entries: LootEntry[] = eff.out.map((itemId, i) => {
      const base = (1 + Math.floor(share * 2)) * eff.qty[i];
      const jitter = rng() < 0.35 ? eff.qty[i] : 0; /* 35% 几率数量翻倍(烘焙派词条同源概率) */
      return { itemId, count: Math.max(eff.qty[i], Math.round((base + jitter) * dropMul)) };
    });
    const angle = rng() * Math.PI * 2;
    const radius = rng() * LOOT_SCATTER_RADIUS;
    orbs.push({
      orbId: `${bossId}:${p.id}`,
      ownerId: p.id,
      x: p.x + Math.cos(angle) * radius,
      y: p.y + Math.sin(angle) * radius,
      entries,
      exp: Math.round(def.exp * share * (1 + partyBonus)),
      personal: true,
    });
  }
  return orbs;
}

/** 某玩家能否拾取该光球(仅所有者可见可拾)。 */
export function canLoot(orb: LootOrb, playerId: string, isAfk: boolean): boolean {
  if (orb.ownerId !== playerId) return false;
  if (isAfk) return false;
  return true;
}

/** 全团光球总数 = 参与人数(用于「8 人各得一球」断言)。 */
export function orbCountFor(participants: readonly RaidParticipant[]): number {
  return participants.filter((p) => p.contributed).length;
}

/** 祭坛召唤物品与手册一致性自检:8 个 Boss → 734..741 一一映射。 */
export function summonItemCoverage(): { ids: number[]; complete: boolean } {
  const ids = BOSS_LIST.map((b) => b.summonItem).sort((a, b) => a - b);
  const expected: number[] = [];
  for (let i = SUMMON_ITEM_MIN; i <= SUMMON_ITEM_MAX; i += 1) expected.push(i);
  const complete = ids.length === expected.length && ids.every((v, i) => v === expected[i]);
  return { ids, complete };
}

/**
 * 自反馈扫描:**战利品里含自己的召唤祭品**的 Boss。
 *
 * ## 为什么这条必须单独成函数并让测试钉住
 *
 * owner 裁决 D-03 定「祭品在召唤时消耗」。这条裁决把「掉自己的祭品」
 * 从一个无害的数据巧合变成了**经济漏洞**:
 *
 * ```
 * 打死一次 → 必掉 ≥1 个 739(rollPersonalLoot 每项数最少 1)
 *         → 用 739 再造祭品
 *         → 再召唤 → 成本归零,每次还白送 609
 * ```
 *
 * 实测 8 个 Boss 里**只有** `boss_ginger_troll` 命中(`loot = [739, 609]`,
 * `summonItem = 739`)。
 *
 * ## 为什么返回数组而不是布尔
 *
 * 布尔只能表达「有/没有」。将来若有第二个 Boss 也自反馈,布尔型断言
 * 依旧只是 `false → false` 不变,看不出**多了哪一个**。
 * 返回名单后测试可以断言「恰好 1 个,且是 ginger_troll」——
 * 既锁住现状,又能在变化时报出具体名字。
 */
export function selfRecyclingBosses(list: readonly BossDef[] = BOSS_LIST): { bossId: string; itemId: number }[] {
  const out: { bossId: string; itemId: number }[] = [];
  for (const b of list) {
    if (b.loot.includes(b.summonItem)) out.push({ bossId: b.id, itemId: b.summonItem });
  }
  return out;
}

/** 全部 Boss 的战利品里,落在祭品区段 `734..741` 的项(自反馈的必要条件)。 */
export function summonItemsInLoot(list: readonly BossDef[] = BOSS_LIST): { bossId: string; itemId: number }[] {
  const out: { bossId: string; itemId: number }[] = [];
  for (const b of list) {
    for (const l of b.loot) {
      if (l >= SUMMON_ITEM_MIN && l <= SUMMON_ITEM_MAX) out.push({ bossId: b.id, itemId: l });
    }
  }
  return out;
}

/** Boss 定义查询(含阶段与破防原文,供 UI 图鉴)。 */
export function bossDef(bossId: string): BossDef | undefined {
  return BOSS_BY_ID.get(bossId);
}