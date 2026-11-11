/**
 * WS-05:八大 Boss 的阶段性技能状态机与预警几何生成。
 *
 * 本模块只做「招式 → 几何 + 时序」的可判定建模,不含掉落与召唤(见 `raid.ts`)
 * 与破防判定(见 `breaks.ts`)。
 *
 * 五类预警几何全部落在 `mobs/geometry.ts` 内核上:圆 / 扇 / 矩形 / 环 / 旋转指针。
 */

import { BOSS_BY_ID } from '../../../shared/constants/bosses.ts';
import type { BossDef } from '../../../shared/types/entities.ts';
import { bossScaledHp } from '../../../shared/types/entities.ts';
import {
  circleWarn, rectWarn, ringWarn, sectorWarn, pointerWarn, DEG,
  angleToDeg, type WarnGeom,
} from '../mobs/geometry.ts';

/* ─────────────── 运行时状态 ─────────────── */

export interface BossClone { id: number; x: number; y: number; isReal: boolean; chargeSec: number; }

export interface BossState {
  bossId: string;
  def: BossDef;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  z: number;
  /** 当前阶段下标(0 基,对应 `def.phases`)。 */
  phaseIndex: number;
  /** 当前阶段已持续秒数。 */
  phaseSec: number;
  /** 本阶段下一次施法倒计时。 */
  castCd: number;
  /** 破防后的眩晕/瘫痪剩余秒数。 */
  stunnedSec: number;
  /** 时间护盾剩余秒数(仅克洛诺斯 P2)。 */
  shieldSec: number;
  shieldHp: number;
  /** 阶段内累计回血量(护盾未破时回血)。 */
  healedBack: number;
  /** 分身(仅妖狐 P2)。 */
  clones: BossClone[];
  /** 破防是否已达成。 */
  breakAchieved: boolean;
  /** 破防窗口内的全队暴击加成(倍率增量)。 */
  critBonus: number;
  /** 累计释放的技能次数,便于断言。 */
  casts: number;
  /** 指针当前角(仅克洛诺斯 P1)。 */
  pointerDeg: number;
}

/* ─────────────── 参数配表 ─────────────── */

/** 破防后的眩晕窗口(秒)与全队暴击加成。设计手册 §4.3 各条破防原文。 */
export const BREAK_STUN_SEC: Record<string, number> = {
  boss_jelly_king: 6,        /* 「炸翻肚皮朝天眩晕 6 秒」 */
  boss_beaver_mecha: 6,      /* 「短路漏电瘫痪」 */
  boss_fox_kitsune: 5,       /* 「陶醉定身状态」 */
  boss_crab_kraken: 6,       /* 「震碎紫晶外壳」 */
  boss_scorpion_pharaoh: 6,  /* 「四脚朝天」 */
  boss_ginger_troll: 8,      /* 「变成一只大肥鸡」 */
  boss_sky_whale: 8,         /* 「净化云鲸」 */
  boss_chronos_colossus: 6,  /* 「一举击穿时间护盾」 */
};

/** 破防窗口内的全队暴击加成(倍率增量)。 */
export const BREAK_CRIT_BONUS = 1.00;

/** 克洛诺斯时间护盾窗口:8 秒内未切断供能则回血。 */
export const TIME_SHIELD_SEC = 8.0;
/** 护盾未破时的回血比例(回到阶段起点血量)。 */
export const TIME_SHIELD_HEAL_RATIO = 0.20;

/** 妖狐 P2 分身数量。 */
export const FOX_CLONE_COUNT = 4;
/** 果冻王 P2 分裂数量。 */
export const JELLY_SPLIT_COUNT = 6;

/** 各阶段的施法间隔(秒),按 Boss 强度递增。 */
export const CAST_INTERVAL_SEC: Record<string, number[]> = {
  boss_jelly_king: [4.0, 5.0, 6.0],
  boss_beaver_mecha: [4.5, 5.0],
  boss_fox_kitsune: [4.0, 6.0],
  boss_crab_kraken: [4.0, 3.0],
  boss_scorpion_pharaoh: [4.5, 3.5],
  boss_ginger_troll: [5.0, 4.0],
  boss_sky_whale: [5.0, 6.0],
  boss_chronos_colossus: [3.5, 5.0, 4.0],
};

/* ─────────────── 阶段判定 ─────────────── */

/**
 * 由血量比例求当前阶段下标。
 *
 * 语义:`hpThreshold` 是「进入该阶段的血量百分比阈值」,`1.0` 表示开局。
 * 取**最后一个**满足 `hpRatio <= hpThreshold + eps` 的阶段。
 * 阈值按 `def.phases` 给定顺序递减,故等价于「越过下一档即切阶段」。
 *
 * 边界:`hpRatio === 0.5` 对果冻王 → 进 P2(不再停在 P1);`hpRatio === 0` → 末阶段。
 */
export function phaseIndexFor(def: BossDef, hpRatio: number): number {
  const eps = 1e-9;
  let idx = 0;
  for (let i = 0; i < def.phases.length; i += 1) {
    if (hpRatio <= def.phases[i].hpThreshold + eps) idx = i;
  }
  return idx;
}

/** 当前阶段的名称(供 UI 与日志)。 */
export function phaseName(state: BossState): string {
  return state.def.phases[Math.min(state.phaseIndex, state.def.phases.length - 1)].name;
}

/* ─────────────── 状态构造 ─────────────── */

export function createBossState(bossId: string, players: number): BossState {
  const def = BOSS_BY_ID.get(bossId);
  if (!def) throw new Error(`未知 Boss:${bossId}`);
  const maxHp = bossScaledHp(def.baseHp, players);
  return {
    bossId,
    def,
    hp: maxHp,
    maxHp,
    x: 0,
    y: 0,
    z: 0,
    phaseIndex: 0,
    phaseSec: 0,
    castCd: CAST_INTERVAL_SEC[bossId]?.[0] ?? 4,
    stunnedSec: 0,
    shieldSec: 0,
    shieldHp: 0,
    healedBack: 0,
    clones: [],
    breakAchieved: false,
    critBonus: 0,
    casts: 0,
    pointerDeg: 0,
  };
}

/* ─────────────── 预警几何生成(逐 Boss 逐阶段) ─────────────── */

/**
 * 生成当前阶段的预警几何。
 *
 * `t` 为 BOSS 全局时间(秒),仅旋转指针类使用。
 * 返回空数组表示本阶段无独立地面几何(或已被眩晕打断)。
 */
export function skillWarnGeoms(state: BossState, target: { x: number; y: number }, t = 0): WarnGeom[] {
  if (state.stunnedSec > 0) return [];
  const out: WarnGeom[] = [];
  const ax = state.x;
  const ay = state.y;
  const toTarget = angleToDeg(ax, ay, target.x, target.y);

  switch (state.bossId) {
    /* ── 1. 果冻国王 ── */
    case 'boss_jelly_king': {
      if (state.phaseIndex === 0) {
        /* P1 环形果冻波:中心环带 [2.5, 3.5],持续 0.8s。 */
        out.push(ringWarn(ax, ay, 2.5, 3.5, 0.8));
      } else if (state.phaseIndex === 1) {
        /* P2 六分裂:6 只中型果冻的独立红色小圆(半径 1.2),等分六边形。 */
        for (let i = 0; i < JELLY_SPLIT_COUNT; i += 1) {
          const a = (i / JELLY_SPLIT_COUNT) * Math.PI * 2;
          out.push(circleWarn(ax + Math.cos(a) * 2.5, ay + Math.sin(a) * 2.5, 1.2, 0.8));
        }
      } else {
        /* P3 巨口吸气:45° 锥形吸附区,长度 6,持续 1.5s。 */
        out.push(sectorWarn(ax, ay, 6, toTarget, 22.5, 1.5));
      }
      break;
    }

    /* ── 2. 机甲河狸 ── */
    case 'boss_beaver_mecha': {
      if (state.phaseIndex === 0) {
        /* P1 横贯战场的窄长红色矩形:宽 2,长 12。 */
        out.push(rectWarn(ax, ay, 6, 1, toTarget, 1.0));
      } else {
        /* P2 中央 5×3 木坝掩体区。 */
        out.push(rectWarn(ax, ay, 2.5, 1.5, 0, 0.8));
      }
      break;
    }

    /* ── 3. 妖狐 ── */
    case 'boss_fox_kitsune': {
      if (state.phaseIndex === 0) {
        /* P1 三道弧形风刃:每道 30°,长 8,互隔 25°。 */
        for (let i = -1; i <= 1; i += 1) {
          out.push(sectorWarn(ax, ay, 8, toTarget + i * 25, 15, 0.9));
        }
      } else {
        /* P2 四个分身的紫色蓄力圈(半径 2)。 */
        for (let i = 0; i < FOX_CLONE_COUNT; i += 1) {
          const a = (i / FOX_CLONE_COUNT) * Math.PI * 2;
          out.push(circleWarn(ax + Math.cos(a) * 6, ay + Math.sin(a) * 6, 2, 1.0));
        }
      }
      break;
    }

    /* ── 4. 巨蟹 ── */
    case 'boss_crab_kraken': {
      if (state.phaseIndex === 0) {
        /* P1 双钳激光:两条细长射线,宽 0.8,长 10,左右各偏 20°。 */
        out.push(rectWarn(
          ax + Math.cos((toTarget - 20) * DEG) * 5,
          ay + Math.sin((toTarget - 20) * DEG) * 5,
          5, 0.4, toTarget - 20, 0.5,
        ));
        out.push(rectWarn(
          ax + Math.cos((toTarget + 20) * DEG) * 5,
          ay + Math.sin((toTarget + 20) * DEG) * 5,
          5, 0.4, toTarget + 20, 0.5,
        ));
      } else {
        /* P2 壳内弹射:高速移动的圆形碰撞预警(半径 1.2,拖尾)。 */
        out.push(circleWarn(ax, ay, 1.2, 0.4));
      }
      break;
    }

    /* ── 5. 法老蝎 ── */
    case 'boss_scorpion_pharaoh': {
      if (state.phaseIndex === 0) {
        /* P1 流沙漩涡:向心吸附区,半径 5,持续 2s。 */
        const g = circleWarn(ax, ay, 5, 2.0);
        out.push(g);
      } else {
        /* P2 沙下潜行:仅露毒尾的细长凸起(无大红圈)。 */
        out.push(rectWarn(ax, ay, 1.6, 0.35, toTarget, 0.3));
      }
      break;
    }

    /* ── 6. 姜饼巨魔 ── */
    case 'boss_ginger_troll': {
      if (state.phaseIndex === 0) {
        /* P1 巧克力浆泼洒:大面积减速沼泽,半径 4。 */
        out.push(circleWarn(target.x, target.y, 4, 1.2));
      } else {
        /* P2 饥饿狂暴:指向手持食物玩家的橙色锁定圈(半径 1.5)。 */
        out.push(circleWarn(target.x, target.y, 1.5, 0.9));
      }
      break;
    }

    /* ── 7. 云鲸 ── */
    case 'boss_sky_whale': {
      if (state.phaseIndex === 0) {
        /* P1 环绕浮空岛外围的宽环状云浪:环宽 3 格。 */
        out.push(ringWarn(ax, ay, 9, 12, 1.0));
      } else {
        /* P2 高空 Z=2 的 60° 巨大扇形,长 14。 */
        const g = sectorWarn(ax, ay, 14, toTarget, 30, 1.5);
        g.z = 2;
        g.zTolerance = 1.6;
        out.push(g);
      }
      break;
    }

    /* ── 8. 克洛诺斯 ── */
    case 'boss_chronos_colossus': {
      if (state.phaseIndex === 0) {
        /* P1 从中心顺时针旋转的细长指针:宽 1,长 12,角速度 30°/s。 */
        out.push(pointerWarn(ax, ay, 12, 1, state.pointerDeg, 30, 0.5));
      } else if (state.phaseIndex === 1) {
        /* P2 四角导电座的独立指示环(半径 1.5)+ 中央电磁脉冲塔(半径 2.5)。 */
        const corners: [number, number][] = [[-8, -8], [8, -8], [8, 8], [-8, 8]];
        for (const [dx, dy] of corners) out.push(ringWarn(ax + dx, ay + dy, 0.8, 1.5, 0.8));
        out.push(circleWarn(ax, ay, 2.5, 0.8));
      } else {
        /* P3 地砖改写:全场预闪,覆盖 24×24 战场。 */
        out.push(rectWarn(ax, ay, 12, 12, 0, 0.6));
      }
      break;
    }

    default:
      break;
  }
  return out;
}

/* ─────────────── 每帧推进 ─────────────── */

export interface BossTickInput {
  target: { x: number; y: number };
  /** BOSS 全局时间,用于指针旋转角度。 */
  t: number;
}

/**
 * 推进 BOSS 状态一帧。
 *
 * 职责:
 *  1. 眩晕/瘫痪倒计时,期间不施法、阶段不推进;
 *  2. 依据当前血量比例切换阶段(切阶段重置施法倒计时与指针角);
 *  3. P2 时间护盾倒计时;窗口结束未破防则回血(受 `TIME_SHIELD_HEAL_RATIO` 约束);
 *  4. 施法冷却到点则 `casts += 1` 并重置冷却。
 *
 * @returns 本帧是否切换了阶段
 */
export function tickBoss(state: BossState, dt: number, input: BossTickInput): boolean {
  /* 破防后的眩晕窗口:期间完全停摆,并持续享有全队暴击加成。 */
  if (state.stunnedSec > 0) {
    state.stunnedSec = Math.max(0, state.stunnedSec - dt);
    state.critBonus = BREAK_CRIT_BONUS;
    if (state.stunnedSec === 0) state.critBonus = 0;
    return false;
  }

  let switched = false;
  const ratio = state.maxHp === 0 ? 0 : state.hp / state.maxHp;
  const next = phaseIndexFor(state.def, ratio);
  if (next !== state.phaseIndex) {
    state.phaseIndex = next;
    state.phaseSec = 0;
    state.castCd = CAST_INTERVAL_SEC[state.bossId]?.[next] ?? 4;
    state.pointerDeg = 0;
    if (state.bossId === 'boss_fox_kitsune' && next === 1) spawnFoxClones(state);
    if (state.bossId === 'boss_chronos_colossus' && next === 1) {
      state.shieldSec = TIME_SHIELD_SEC;
      state.shieldHp = Math.round(state.maxHp * 0.15);
    }
    switched = true;
  }

  state.phaseSec += dt;
  /* P1 指针恒角速度旋转。 */
  if (state.bossId === 'boss_chronos_colossus' && state.phaseIndex === 0) {
    state.pointerDeg = (state.pointerDeg + 30 * dt) % 360;
  }
  /* 云鲸 P2 升空。 */
  if (state.bossId === 'boss_sky_whale' && state.phaseIndex === 1) state.z = 2;

  /* 时间护盾窗口。切换阶段的那一帧不递减,保证窗口严格为 TIME_SHIELD_SEC 秒。 */
  if (state.shieldSec > 0 && !switched) {
    state.shieldSec = Math.max(0, state.shieldSec - dt);
    if (state.shieldSec === 0 && !state.breakAchieved) {
      const heal = Math.round(state.maxHp * TIME_SHIELD_HEAL_RATIO);
      state.hp = Math.min(state.maxHp, state.hp + heal);
      state.healedBack += heal;
    }
  }

  state.castCd -= dt;
  if (state.castCd <= 0) {
    state.castCd = CAST_INTERVAL_SEC[state.bossId]?.[state.phaseIndex] ?? 4;
    state.casts += 1;
  }
  /* 分身蓄力推进。 */
  for (const c of state.clones) c.chargeSec += dt;
  void input;
  return switched;
}

/** 生成妖狐 4 个分身(1 真 3 假,真身耳朵随音乐抖动 → `isReal` 标记)。 */
export function spawnFoxClones(state: BossState): BossClone[] {
  state.clones = [];
  const realIdx = state.casts % FOX_CLONE_COUNT;
  for (let i = 0; i < FOX_CLONE_COUNT; i += 1) {
    const a = (i / FOX_CLONE_COUNT) * Math.PI * 2;
    state.clones.push({
      id: i,
      x: state.x + Math.cos(a) * 6,
      y: state.y + Math.sin(a) * 6,
      isReal: i === realIdx,
      chargeSec: 0,
    });
  }
  return state.clones;
}

/** 破防:施加眩晕窗口并给全队暴击加成。 */
export function applyBreak(state: BossState): { stunSec: number; critBonus: number } {
  const stunSec = BREAK_STUN_SEC[state.bossId] ?? 6;
  state.breakAchieved = true;
  state.stunnedSec = stunSec;
  state.critBonus = BREAK_CRIT_BONUS;
  state.shieldSec = 0;
  state.shieldHp = 0;
  if (state.bossId === 'boss_fox_kitsune') state.clones = [];
  return { stunSec, critBonus: BREAK_CRIT_BONUS };
}

/** 造成伤害;护盾存在时先吃护盾。 */
export function damageBoss(state: BossState, amount: number): { toShield: number; toHp: number } {
  let remain = amount;
  let toShield = 0;
  if (state.shieldHp > 0) {
    toShield = Math.min(state.shieldHp, remain);
    state.shieldHp -= toShield;
    remain -= toShield;
    if (state.shieldHp === 0) state.shieldSec = 0;
  }
  const toHp = Math.min(state.hp, remain);
  state.hp -= toHp;
  return { toShield, toHp };
}

/** 竞技场四角坐标(克洛诺斯 P2 用)。 */
export function arenaCorners(cx: number, cy: number): [number, number][] {
  return [[cx - 8, cy - 8], [cx + 8, cy - 8], [cx + 8, cy + 8], [cx - 8, cy + 8]];
}