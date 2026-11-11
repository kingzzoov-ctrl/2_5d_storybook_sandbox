/**
 * WS-04:群系刷怪、光照抑制与城镇安全区护盾。
 *
 * 规则:
 *  - 每群系独立维护「软上限 / 硬上限 / 刷新密度(只/区块)」;
 *  - `309 萤光星光夜路砖` 所在格:敌对野怪**不能在此格刷新**(且夜间发光半径 1 格内也抑制);
 *  - `522 暖橘光铁艺路灯` 半径 5 格内:不刷新敌对「夜行」怪;
 *  - 城镇安全区:半径 24 格内不刷怪,并对区内玩家施加护盾(免疫野生怪直接伤害)。
 */

import { Biome } from '../../../shared/types/entities.ts';
import { CHUNK_SIZE } from '../../../shared/types/tile.ts';
import { MOB_LIST, mobsByBiome } from '../../../shared/constants/mobs.ts';
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

/** 城镇安全区半径(格)。 */
export const TOWN_SAFE_RADIUS = 24;
/** 安全区护盾吸收比例(100% 免疫野生怪伤害)。 */
export const SAFE_SHIELD_MULT = 1.0;

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

/** 城镇安全区判定(世界查询版)。 */
export function inSafeZone(world: SpawnWorld, x: number, y: number): boolean {
  const t = world.townCenter();
  return isInsideSafeRadius(x, y, t.x, t.y);
}

/**
 * 一次刷新点决策(纯函数,便于穷举断言)。
 *
 * 判定顺序(短路,成本从低到高):
 *   1. 全局硬上限 200
 *   2. 城镇安全区(24 格)
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

  if (NOCTURNAL.has(ctx.mobId) && !world.isNight()) {
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

  remove(biome: string, n = 1): void {
    const cur = this.state.biomeCounts.get(biome) ?? 0;
    const next = Math.max(0, cur - n);
    this.state.biomeCounts.set(biome, next);
    this.state.globalCount = Math.max(0, this.state.globalCount - n);
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