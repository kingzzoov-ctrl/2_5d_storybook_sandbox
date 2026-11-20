/**
 * WS-04:群系刷怪、光照抑制与城镇安全区护盾。
 *
 * 规则:
 *  - 每群系独立维护「软上限 / 硬上限 / 刷新密度(只/区块)」;
 *  - `309 萤光星光夜路砖` 所在格:敌对野怪**不能在此格刷新**(且夜间发光半径 1 格内也抑制);
 *  - `522 暖橘光铁艺路灯` 半径 5 格内:不刷新敌对「夜行」怪;
 *  - 城镇安全区:半径 24 格内不刷怪,并对区内玩家施加护盾(免疫野生怪直接伤害)。
 *
 * ## 安全区半径是**可注入**的(`MODIFY_TOWN` 的世界侧读口)
 *
 * `TOWN_SAFE_RADIUS = 24` 仍是**默认值 / 内容口径的锚**(出厂城镇半径),但它**不再**
 * 被直接当成判定半径:判定一律走 `townSafeRadiusFor(roomId)` ——
 * 「先问 provider(`setTownRadiusProvider` 装的 `(roomId) => number`);拿不到 /
 * 非法(负数 / `NaN` / 非有限 / 非数字 / `0`) / 抛错 ⇒ 退回 `TOWN_SAFE_RADIUS`」。
 * provider 由**世界侧**在装配期装上,典型实现是 `MODIFY_TOWN` 的**只读**适配器
 * `modify_town.ts` 的 `townSafeRadiusProvider(roomId) = townConfigOf(roomId).safeRadius`。
 *
 * ⚠️ 本模块**只消费**半径,**不校验**上下界(`MIN_TOWN_RADIUS..MAX_TOWN_RADIUS` 是
 *   `modify_town.ts` 的事):这里只做「是不是一个正的有限数」这一个**类型级**守卫,
 *   免得把配置层的不变量抄成第二份(抄了就会分叉)。
 *
 * ⚠️ **世界侧接线(主线做,本模块不改 `world_sim.ts`)**:把房间号喂进判定的那一行在
 *   `server/src/sim/world_sim.ts` 的 `spawnWorld()`(今天约 r4266-4273 的返回对象)——
 *   在该 `SpawnWorld` 字面量里加 `roomId: () => <本房间号>`,并在装配期调一次
 *   `setTownRadiusProvider(townSafeRadiusProvider)`。
 *   本模块**不** import `modify_town.ts`(会成环):只提供插槽,适配器由调用方接。
 *   `SpawnWorld.roomId` 缺席 ⇒ 与历史行为逐字节一致(默认 24,零回归)。
 */

import { Biome } from '../../../shared/types/entities.ts';
import { CHUNK_SIZE } from '../../../shared/types/tile.ts';
import { MOB_BY_ID, MOB_LIST, mobsByBiome } from '../../../shared/constants/mobs.ts';
import type { MobDef } from '../../../shared/types/entities.ts';
import { MobBehavior } from '../../../shared/types/entities.ts';

/* ─────────────── 光照抑制常数的出处 ─────────────── */

/** `309 萤光星光夜路砖`:阻止敌对野怪在其上刷新。 */
export const NIGHT_BRICK_ID = 309;
/** `522 暖橘光铁艺路灯`:半径 5 格不刷夜行怪(物品 note 原文)。 */
export const STREET_LAMP_ID = 522;
export const STREET_LAMP_RADIUS = 5;
/** 夜路砖的微光抑制半径(格),取 1 格防贴脸刷怪。 */
export const NIGHT_BRICK_RADIUS = 1;

/*
 * 城镇安全区半径(格)= 24。
 *
 * ⚠️ **与 `shared/types/entities.ts#SHARE_EXP_RADIUS`(经验共享半径 24)/
 * `bosses/raid.ts#RAID_PARTICIPATION_RADIUS`(祭坛参与判定 24)**数值相同、语义不同**:
 * 这一条管「刷怪抑制 + 安全区护盾」,那两条管「经验分给谁 / 谁算参与者」。
 * ⇒ 不合并来源、不互相替代(`tests/WS-FND-30` FND30-5 钉的就是本值 24)。
 */
export const TOWN_SAFE_RADIUS = 24;
/** 安全区护盾吸收比例(100% 免疫野生怪伤害)。 */
export const SAFE_SHIELD_MULT = 1.0;
/*
 * ─────────────── 安全区半径:可注入提供者 ───────────────
 *
 * 为什么是**函数插槽**而不是把 `TOWN_SAFE_RADIUS` 改成 `let`:
 *   1 `let` 只能是**一份全局标量**,而城镇配置是 **per-room** 的
 *     (`modify_town.ts` 的 `Map<roomId, TownConfig>`)⇒ 半径必须能按 `roomId` 取;
 *   2 提供者让依赖**单向**:本模块不认识 `modify_town`,由调用方把适配器塞进来
 *     (否则 `spawner ↔ modify_town` 成环);
 *   3 判据可装一个返回 8 / 40 的假提供者,不动任何真配置就能钉住边界。
 */
/** 半径提供者:给房间号,回半径。返回值**不做上下界校验**(那是 `modify_town.ts` 的事)。 */
export type TownRadiusProvider = (roomId: string) => number;

/** 当前装的提供者。`null` = 没装 ⇒ 一律用默认 `TOWN_SAFE_RADIUS`。 */
let townRadiusProvider: TownRadiusProvider | null = null;

/**
 * 装 / 卸半径提供者。传 `null` 卸掉(恢复默认 24)。
 *
 * **立即生效**:判定每次调用都现读本插槽,不需要重建世界 / 刷新器(判据 6)。
 */
export function setTownRadiusProvider(fn: TownRadiusProvider | null): void {
  townRadiusProvider = fn;
}

/**
 * 半径的**唯一读取口**:先问 provider,拿不到 / 非法 / 抛错 ⇒ 退回 `TOWN_SAFE_RADIUS`。
 *
 * 口径(逐条对着判据):
 *   - 没装 provider ⇒ 默认(判据 1);
 *   - provider 返回有限的正数 ⇒ 用它(判据 2 / 3);
 *   - 返回 负数 / `NaN` / `Infinity` / 非数字 / `0` ⇒ **退回默认**(判据 4)。
 *     `0` 也退:半径 0 = 「安全区永远为空」,与默认 24 相比是**静默改变世界规则**;
 *     宁可用出厂值,也不让一个越界配置把护盾悄悄关掉。
 *     ⚠️ 这里**只**守卫「正的有限数」,**不**抄 `MIN_TOWN_RADIUS..MAX_TOWN_RADIUS`:
 *     区间是配置层的裁决,判定层再判一次就是**第二份标准**。
 *   - provider **抛错** ⇒ **吞掉并退回默认**(判据 5)。理由:本函数跑在 2Hz 刷怪慢帧里,
 *     一次抛错会打断**整个**世界步进而**不只是一次刷新**;而半径是内容 / 配置细节,
 *     它坏掉时应退回出厂值,而不是把进程带崩。
 */
export function townSafeRadiusFor(roomId: string): number {
  const fn = townRadiusProvider;
  if (fn === null) return TOWN_SAFE_RADIUS;
  let raw: unknown;
  try {
    raw = fn(roomId);
  } catch {
    return TOWN_SAFE_RADIUS;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return TOWN_SAFE_RADIUS;
  return raw;
}

export interface BiomeSpawnConfig {
  /** 软上限:达到后刷新概率减半。 */
  softCap: number;
  /** 硬上限:达到后完全停止刷新。 */
  hardCap: number;
  /** 每区块期望只数(密度)。 */
  perChunk: number;
  /** 刷新检查周期(秒),2Hz 低频帧驱动。 */
  intervalSec: number;
}

/**
 * 群系刷新配表(设计手册 §4.2 生态密度)。
 *
 * 密度与群系战斗强度正相关:草甸 0.6 只/区块 → 遗迹 1.4 只/区块。
 */
export const BIOME_SPAWN: Record<string, BiomeSpawnConfig> = {
  MEADOW: { softCap: 8, hardCap: 14, perChunk: 0.6, intervalSec: 8 },
  VALLEY: { softCap: 8, hardCap: 14, perChunk: 0.7, intervalSec: 8 },
  SAKURA: { softCap: 9, hardCap: 16, perChunk: 0.8, intervalSec: 8 },
  CAVERN: { softCap: 7, hardCap: 12, perChunk: 0.7, intervalSec: 10 },
  OASIS: { softCap: 9, hardCap: 15, perChunk: 0.9, intervalSec: 8 },
  DESSERT: { softCap: 8, hardCap: 13, perChunk: 0.8, intervalSec: 10 },
  SKYSEA: { softCap: 5, hardCap: 9, perChunk: 0.5, intervalSec: 12 },
  RUINS: { softCap: 10, hardCap: 18, perChunk: 1.4, intervalSec: 8 },
};

/** 全局野生怪硬上限。 */
export const GLOBAL_MOB_CAP = 200;

/** 夜行怪:仅在夜间刷新,且受路灯抑制。 */
export const NOCTURNAL: ReadonlySet<string> = new Set([
  'mob_bat_sonic', 'mob_tanuki', 'mob_lava_elem', 'mob_scorpion', 'mob_thunder_sprite',
]);
/** 昼行怪 = `NOCTURNAL` 之外的全部(判据用它做反例,不新立名单)。 */
export function isNocturnal(mobId: string): boolean {
  return NOCTURNAL.has(mobId);
}

/**
 * **昼夜适配的唯一一处**(★ WS-FND-153):这个物种此刻允许刷新吗?
 *
 * - 昼行怪:`true`(昼夜都刷,昼夜不改变它的概率);
 * - 夜行怪:只在 `night === true` 时 `true`(白天由 `decideSpawn` 判 `DAYLIGHT`)。
 *
 * ⚠️ 这里**不含任何数值**:刷不刷的**速率**仍然来自内容表(`BIOME_SPAWN.perChunk` ×
 * `intervalSec`,见 `spawnsPerCheck`),`night` 只决定「这一枪能不能打出去」。
 * 「夜里刷得更多」是**名额在夜里被让给夜行怪**的结果,不是另加的倍率。
 */
export function nightGateAllows(mobId: string, night: boolean): boolean {
  return !isNocturnal(mobId) || night;
}
export const SpawnReject = {
  OK: 'OK',
  HARD_CAP: 'HARD_CAP',
  SOFT_DAMPED: 'SOFT_DAMPED',
  NIGHT_BRICK: 'NIGHT_BRICK',
  STREET_LAMP: 'STREET_LAMP',
  SAFE_ZONE: 'SAFE_ZONE',
  GLOBAL_CAP: 'GLOBAL_CAP',
  DAYLIGHT: 'DAYLIGHT',
  OBSTRUCTED: 'OBSTRUCTED',
} as const;
export type SpawnReject = (typeof SpawnReject)[keyof typeof SpawnReject];

export interface SpawnWorld {
  /** 该坐标的 obj 层 ID(用于识别路灯/夜路砖/汤锅等)。 */
  objAt(x: number, y: number): number;
  /** 该坐标的地砖 ID(309 是地砖层)。 */
  floorAt(x: number, y: number): number;
  /** 该坐标是否被实体阻挡。 */
  blocked(x: number, y: number): boolean;
  /** 城镇中心。 */
  townCenter(): { x: number; y: number };
  /** 是否夜间。 */
  isNight(): boolean;
  /**
   * 本世界的房间号(**可选**)。给了 ⇒ 安全区半径走 per-room 配置(`MODIFY_TOWN`),
   * 并**立即生效**;不给 ⇒ 与历史行为逐字节一致(默认 `TOWN_SAFE_RADIUS` = 24)。
   */
  roomId?(): string;
}

export interface SpawnContext {
  biome: string;
  x: number;
  y: number;
  /** 该群系当前存活数。 */
  biomeCount: number;
  /** 全局当前存活数。 */
  globalCount: number;
  mobId: string;
}

/** 光照抑制判定:`true` 表示该点被光源覆盖,禁止刷新。 */
export function lightSuppressed(world: SpawnWorld, x: number, y: number): { suppressed: boolean; reason: SpawnReject } {
  /* ── 309 夜路砖:本格直接抑制(半径 1 格) ── */
  for (let dx = -NIGHT_BRICK_RADIUS; dx <= NIGHT_BRICK_RADIUS; dx += 1) {
    for (let dy = -NIGHT_BRICK_RADIUS; dy <= NIGHT_BRICK_RADIUS; dy += 1) {
      if (world.floorAt(Math.round(x) + dx, Math.round(y) + dy) === NIGHT_BRICK_ID) {
        return { suppressed: true, reason: SpawnReject.NIGHT_BRICK };
      }
    }
  }
  /* ── 522 路灯:半径 5 格圆形抑制 ── */
  const r2 = STREET_LAMP_RADIUS * STREET_LAMP_RADIUS;
  const c = Math.ceil(STREET_LAMP_RADIUS);
  const bx = Math.round(x);
  const by = Math.round(y);
  for (let dx = -c; dx <= c; dx += 1) {
    for (let dy = -c; dy <= c; dy += 1) {
      if (dx * dx + dy * dy > r2) continue;
      if (world.objAt(bx + dx, by + dy) === STREET_LAMP_ID) {
        return { suppressed: true, reason: SpawnReject.STREET_LAMP };
      }
    }
  }
  return { suppressed: false, reason: SpawnReject.OK };
}

/**
 * 纯几何:某点是否落在以 `(cx, cy)` 为心、`radius` 为半径的安全圆内(含边界)。
 *
 * 这是安全区判定的**唯一事实源**;`inSafeZone` 与 `bosses/raid.ts` 的祭坛校验
 * 共用本函数,避免「刷怪说在区间外、召唤说在区间内」的双标准。
 *
 * 容差 `1e-9`:恰好 24.000000000 格判为区内,24+1e-6 判为区外。
 */
export function isInsideSafeRadius(
  x: number, y: number, cx: number, cy: number, radius: number = TOWN_SAFE_RADIUS,
): boolean {
  const dx = x - cx;
  const dy = y - cy;
  const r = radius * (1 + 1e-9);
  return dx * dx + dy * dy <= r * r;
}

/** 城镇安全区判定(世界查询版)。半径走 `townSafeRadiusFor`(见文件头「可注入」一节)。 */
export function inSafeZone(world: SpawnWorld, x: number, y: number): boolean {
  const t = world.townCenter();
  /* 世界给了房间号 ⇒ 按该房间的配置取半径;没给 ⇒ 默认 24(与历史行为逐字节一致)。 */
  const roomId = world.roomId?.();
  const radius = roomId === undefined ? TOWN_SAFE_RADIUS : townSafeRadiusFor(roomId);
  return isInsideSafeRadius(x, y, t.x, t.y, radius);
}

/**
 * 一次刷新点决策(纯函数,便于穷举断言)。
 *
 * 判定顺序(短路,成本从低到高):
 *   1. 全局硬上限 200
 *   2. 城镇安全区(半径来自配置,默认 24 格)
 *   3. 群系硬上限 → 软上限(概率减半)
 *   4. 地形阻挡
 *   5. 光照抑制(夜路砖 / 路灯) —— 最贵,放最后
 *   6. 夜行怪白天不刷
 */
export function decideSpawn(
  ctx: SpawnContext, world: SpawnWorld, roll: number,
): { spawn: boolean; reason: SpawnReject } {
  if (ctx.globalCount >= GLOBAL_MOB_CAP) return { spawn: false, reason: SpawnReject.GLOBAL_CAP };
  if (inSafeZone(world, ctx.x, ctx.y)) return { spawn: false, reason: SpawnReject.SAFE_ZONE };

  const cfg = BIOME_SPAWN[ctx.biome] ?? BIOME_SPAWN.MEADOW;
  if (ctx.biomeCount >= cfg.hardCap) return { spawn: false, reason: SpawnReject.HARD_CAP };
  if (ctx.biomeCount >= cfg.softCap && roll < 0.5) {
    return { spawn: false, reason: SpawnReject.SOFT_DAMPED };
  }
  if (world.blocked(ctx.x, ctx.y)) return { spawn: false, reason: SpawnReject.OBSTRUCTED };

  const light = lightSuppressed(world, ctx.x, ctx.y);
  if (light.suppressed) return { spawn: false, reason: light.reason };

  /* ★ WS-FND-153:昼夜适配只在这一处问 `world.isNight()`,而它的答案来自世界钟
     (`WorldSim.isNightNow()` ⇒ `hourOfDay()` ⇒ `NIGHT_WINDOW`)。判定顺序不变:
     夜行门仍放在最贵的光照抑制之后(白天先按光照/名额短路,与修前一致)。 */
  if (!nightGateAllows(ctx.mobId, world.isNight())) {
    return { spawn: false, reason: SpawnReject.DAYLIGHT };
  }
  return { spawn: true, reason: SpawnReject.OK };
}

/** 安全区护盾:区内玩家受到野生怪伤害时吸收。 */
export function safeZoneShield(world: SpawnWorld, x: number, y: number, incoming: number): number {
  if (!inSafeZone(world, x, y)) return incoming;
  return incoming * (1 - SAFE_SHIELD_MULT);
}

/**
 * 城镇安全区护盾的**唯一对外入口**:仅对玩家生效。
 *
 * Lead 裁决 3 第二/三行:
 *   - 玩家在安全区内 → 全额吸收(手册 `535 岛主领地守护图腾` 原文,受益方是玩家)
 *   - Boss 在安全区内 → **不吸收**。怪进安全区说明玩家引怪失误,
 *     不能因此让 Boss 无敌。
 *
 * **`isBoss` 必须是显式参数,且不给默认值。** 理由:
 * `SAFE_SHIELD_MULT = 1.0` 使本函数对怪一旦误用即为「完全免伤」——
 * 这类「沉默失效」语义错误(不报错、数值直接变 0)最难排查,
 * 因此把约束放在**签名层面**强制,而不是依赖调用方自觉。
 * 若将来有人加默认值 `isBoss = false`,则 Boss 会静默获得无敌;
 * `W4-53` 用 `fn.length === 5` 锁死元数,堵住这条退化路径。
 *
 * `damage.ts`(WS-06)基于 `TargetProfile`/`AttackInput` 抽象,不含 `SpawnWorld`
 * 依赖,故本入口落在 `spawner.ts`,由伤害管线在调用 `applyDamage` 后按其返回值缩放。
 */
export function applySafeZoneShield(
  world: SpawnWorld, x: number, y: number, incoming: number, isBoss: boolean,
): number {
  /* 关键短路:显式判 Boss,不依赖调用顺序或外部约定。 */
  if (isBoss) return incoming;
  return safeZoneShield(world, x, y, incoming);
}

/** 该群系可刷新的生物列表(剔除 `PASSIVE_UNKILLABLE`,卡皮巴拉走专属事件刷新)。 */
export function spawnableMobs(biome: string): MobDef[] {
  const b = biome as Biome;
  return mobsByBiome(b).filter((m) => m.behavior !== MobBehavior.PASSIVE_UNKILLABLE);
}

/** 每区块期望刷新数按 16×16 区块折算成每次检查的 spawn 数。 */
export function spawnsPerCheck(biome: string): number {
  const cfg = BIOME_SPAWN[biome] ?? BIOME_SPAWN.MEADOW;
  const chunkArea = CHUNK_SIZE * CHUNK_SIZE;
  return (cfg.perChunk / chunkArea) * (cfg.intervalSec * 2);
}

export interface SpawnerState {
  biomeCounts: Map<string, number>;
  globalCount: number;
}

/** 刷新器:维护计数并做上限裁剪。 */
export class MobSpawner {
  readonly state: SpawnerState = { biomeCounts: new Map<string, number>(), globalCount: 0 };

  add(biome: string, n = 1): boolean {
    if (this.state.globalCount + n > GLOBAL_MOB_CAP) return false;
    const cfg = BIOME_SPAWN[biome] ?? BIOME_SPAWN.MEADOW;
    const cur = this.state.biomeCounts.get(biome) ?? 0;
    if (cur + n > cfg.hardCap) return false;
    this.state.biomeCounts.set(biome, cur + n);
    this.state.globalCount += n;
    return true;
  }

  /**
   * 退回计数(与 `add` 对称)。
   *
   * ## ★ WS-FND-140(P2):只退「本群系真的记过的账」
   *
   * 修前是 `globalCount = max(0, globalCount - n)` 的**无条件**扣减,而 `add`
   * 在触 `hardCap` / `GLOBAL_MOB_CAP` 时**直接返回 false 且一个数都不记**
   * (`addMob` 却照样登记)⇒ 那些「没被计过数的尸体」被收掉时,扣的是**别的
   * 群系 / 别的存活怪的额度**。实测形态:MEADOW 记满 14、RUINS 记了 10,
   * 再超额登记 100 只 MEADOW;清尸时前 14 次把 global 从 24 扣到 10,后 86 次
   * 继续扣到 0 —— 此刻 RUINS 那 10 只**还活着**,计数却归零 ⇒ 可越过 hardCap
   * 再刷(`decideSpawn` 只看计数)。
   *
   * 现在扣减量 = `min(当前本群系计数, n)`,并且**群系与全局同步扣同一个数**
   * (全局那一步不再单独夹 0)。由此得到不变量
   * `globalCount === Σ biomeCounts`,「群系没记过账 ⇒ no-op」。
   * `FND135-2` 的「100 只 / 计数 ≤14」恰好只覆盖**单群系**,差额被夹取掩盖;
   * 暴露它需要跨群系夹具 —— 见 `tests/WS-FND-140`。
   */
  remove(biome: string, n = 1): void {
    const cur = this.state.biomeCounts.get(biome) ?? 0;
    if (cur <= 0) return;
    const dec = Math.min(cur, Math.max(0, n));
    if (dec === 0) return;
    this.state.biomeCounts.set(biome, cur - dec);
    this.state.globalCount = Math.max(0, this.state.globalCount - dec);
  }

  canSpawn(ctx: SpawnContext, world: SpawnWorld, roll: number): boolean {
    return decideSpawn(ctx, world, roll).spawn;
  }
}

/** 生态稳定性自检:每个群系至少 1 种可刷怪。 */
export function biomeCoverage(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of Object.keys(BIOME_SPAWN)) out[b] = spawnableMobs(b).length;
  return out;
}

/** 全表生物数(供文档一致性校验)。 */
export const SPAWNER_MOB_TOTAL = MOB_LIST.length;

/* ═══════════ 生物 id 的**两层**:实例 id 与物种 id ═══════════ */

/**
 * 实例 id 与物种 id 的分隔符。
 *
 * ## 为什么要分两层(★ 拆掉的是一条**当前契约的限制**)
 *
 * 原先 `addMob(id, ...)` 拿**同一个字符串**同时当实例 id 与 `MOB_BY_ID` 的查表键,
 * 于是「两只 `mob_sheep`」会在物理 / AOI / 宿主登记里撞成同一个键 ——
 * 世界侧只能**按物种去重**(每物种最多 1 只),`BIOME_SPAWN.hardCap` 永远达不到。
 *
 * 现在:实例 id = `` `${物种 id}#序号` ``(**序号单调递增、永不复用**),
 * 物种 id 仍然是内容表的键。两层之间的换算**只有下面三处导出**:
 * 任何地方再写一次"按 `#` 切一刀"就是第二份实现。
 *
 * ⚠️ 序号**不许复用**:复用会让"新刷的那只"继承死掉那只的击杀账(`killLedger` 按实例 id 去重)
 * ⇒ 经验被静默吞掉。所以序号来自世界侧的单调计数器,不是"当前存活数 + 1"。
 */
export const MOB_INSTANCE_SEP = '#';

/** 生成实例 id(物种 id + 序号)。`ordinal` 必须 ≥ 1(0 会让首个实例与物种 id 同形)。 */
export function mobInstanceId(speciesId: string, ordinal: number): string {
  return `${speciesId}${MOB_INSTANCE_SEP}${Math.max(1, Math.trunc(ordinal))}`;
}

/**
 * 从实例 id 取回**物种 id**。没有序号的字符串原样返回 ——
 * 这条回退是**必需**的:测试与 `demo` 至今仍用物种 id 直接 `addMob`(同一个契约的老写法)。
 */
export function mobSpeciesId(instanceId: string): string {
  const i = instanceId.indexOf(MOB_INSTANCE_SEP);
  return i < 0 ? instanceId : instanceId.slice(0, i);
}

/**
 * **唯一**的"按 id 查物种定义"处(实例 id 与物种 id 都吃)。
 *
 * 全仓原先有 8 处 `MOB_BY_ID.get(id)`(世界侧 2 处 + 驯养层 5 处 + 宿主注册 1 处),
 * 每一处都隐含"id 就是物种 id"这个前提。拆开两层之后,任何一处漏改的表现都是
 * **静默的**:查不到 def ⇒ 生物"存在但不行为"、驯养返回 `unknown_mob`、农场不产出
 * —— 都不抛错。⇒ 收成一处。
 */
export function mobDefOf(id: string): MobDef | undefined {
  return MOB_BY_ID.get(mobSpeciesId(id));
}