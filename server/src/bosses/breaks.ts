/**
 * WS-05:八条「沙盒机关破防」的可判定布尔实现。
 *
 * 设计原则:每条破防都是**纯函数 → boolean**,输入是可观测的沙盒状态
 * (地形 ID、机关通电、投掷物、玩家协作人数……),不依赖任何文字描述。
 *
 * 因此每条都能被 `tests/WS-05.test.ts` 直接断言「满足 → true」「差一个条件 → false」。
 */

import { BOSS_BY_ID } from '../../../shared/constants/bosses.ts';
import { BOSS_LIST } from '../../../shared/constants/bosses.ts';
import type { BossState } from './phases.ts';
import { applyBreak, type BossClone } from './phases.ts';

/* ─────────────── 机关物品 ID(引用 shared/constants/items.ts) ─────────────── */

export const BREAK_ITEM = {
  /** 228 定时痒痒炸弹果:点燃后 3 秒爆炸,120 点破甲爆破伤害。 */
  BOMB_FRUIT: 228,
  /** 324 倒刺荆棘地垫(可作为喂食替代物)。 */
  THORN_MAT: 324,
  /** 315 镜面极滑冰砖:μ=0.98。 */
  ICE_BRICK: 315,
  /** 359 黑曜石防爆城墙:反震眩晕。 */
  OBSIDIAN_WALL: 359,
  /** 251 黄金凯旋小号:震散幻影分身。 */
  TRUMPET: 251,
  /** 419 32音高八音盒音符砖(等效破幻)。 */
  NOTE_BLOCK: 419,
  /** 224 灵巧飞索钩爪。 */
  HOOK: 224,
  /** 241 双向拔河大麻绳。 */
  ROPE: 241,
  /** 318 高弹果冻蹦床砖。 */
  TRAMPOLINE: 318,
  /** 608 小肥鸡咯咯浓汤(黑暗料理:变身菇)。 */
  DARK_CUISINE: 608,
  /** 127 幻彩变身菇。 */
  MUSHROOM: 127,
  /** 440 八人云海探险飞艇。 */
  AIRSHIP: 440,
  /** 159 四色魔能线芯。 */
  WIRE_CORE: 159,
  /** 207 四色电路扳手。 */
  WRENCH: 207,
} as const;

/** 冰砖摩擦系数(冻结物品表 315 note 原文 μ=0.98)。 */
export const ICE_MU = 0.98;
/** 黑曜石城墙诱发的眩晕窗口(秒)。 */
export const OBSIDIAN_WALL_STUN_SEC = 6.0;
/** 巨蟹紫晶壳的基础减伤(冻结 Boss 表 P1 原文 90%)。 */
export const CRAB_SHELL_DR = 0.90;
/** 巨蟹失控判定:冰面滑行距离阈值(格)。 */
export const CRAB_UNCONTROLLED_DISTANCE = 4.0;
/** 巨蟹撞墙速度阈值(格/秒):低于此值只是擦碰,不碎壳。 */
export const CRAB_SHATTER_SPEED = 8.0;

/** 拔河所需最少人数与合力阈值。 */
export const PULL_MIN_PLAYERS = 2;
export const PULL_MAX_PLAYERS = 4;
export const PULL_FORCE_PER_PLAYER = 1.0;
export const PULL_FORCE_THRESHOLD = 2.0;
/** 拔河判定窗口(秒):必须同窗口内共同发力。 */
export const PULL_COOP_WINDOW_SEC = 1.0;

/** 云鲸背脊寄生雷晶数量与击破窗口。 */
export const WHALE_CRYSTAL_COUNT = 3;
export const WHALE_CRYSTAL_WINDOW_SEC = 6.0;

/** 克洛诺斯时间护盾需要的四色电路齐备数。 */
export const CHRONOS_CIRCUIT_COUNT = 4;

/* ═════════════ 1. 果冻国王:投弹喂食破防 ═════════════ */

export interface JellyBreakInput {
  /** 当前阶段下标(2 = P3 巨口吸气)。 */
  phaseIndex: number;
  /** 吸气机制是否正在生效(预警中,未结算)。 */
  suctionActive: boolean;
  /** 投喂物 ID。 */
  feedItem: number;
  /** 投喂物是否已点燃(炸弹果需点燃)。 */
  lit: boolean;
  /** 投喂物到王口的距离(格)。 */
  distanceToMouth: number;
  /** 王口吸附半径(格)。 */
  mouthRadius: number;
}

/**
 * 破防条件(设计手册:「P3 吸气时点燃一颗定时痒痒炸弹果(或抱起荆棘地垫)
 * 顺着吸力扔进它嘴里」)。
 *
 * 全部满足才为 true:
 *  ① 处于 P3 吸气阶段;② 吸气机制正在生效(未结算);③ 吸附半径内;
 *  ④ 喂食物是炸弹果或荆棘地垫;⑤ 炸弹果必须已点燃(荆棘地垫无需点燃)。
 */
export function jellyBreakReady(i: JellyBreakInput): boolean {
  if (i.phaseIndex !== 2) return false;
  if (!i.suctionActive) return false;
  if (!(i.distanceToMouth <= i.mouthRadius)) return false;
  if (i.feedItem === BREAK_ITEM.BOMB_FRUIT) return i.lit;
  if (i.feedItem === BREAK_ITEM.THORN_MAT) return true;
  return false;
}

/* ═════════════ 2. 机甲河狸:开闸放水冲坝 ═════════════ */

export interface BeaverBreakInput {
  /** P2 战场中央已有木坝。 */
  damPresent: boolean;
  /** 上游引水渠是否完整铺通(任意一格缺失即断路)。 */
  channelIntact: boolean;
  /** 电动升降拦水闸门是否已拉下拉杆放水。 */
  gateOpened: boolean;
  /** 水是否真的到达坝体(地形高度:上游必须高于坝体)。 */
  upstreamHigher: boolean;
}

/**
 * 破防条件(设计手册:「提前在河道上游修好引水渠与电动升降拦水闸门,
 * 拉下拉杆放洪水倾泻而下」)。
 *
 * 四项全真 → 冲垮木坝 + 短路漏电瘫痪。
 * **关键边界:渠道缺一格(channelIntact=false)或未开闸 → 不破防。**
 */
export function beaverBreakReady(i: BeaverBreakInput): boolean {
  return i.damPresent && i.channelIntact && i.gateOpened && i.upstreamHigher;
}

/* ═════════════ 3. 妖狐:乐团奏乐破隐 ═════════════ */

export interface FoxBreakInput {
  /** 场上分身的 `isReal` 标记(1 真 3 假)。 */
  clones: readonly BossClone[];
  /** 玩家手持/吹奏的乐器 ID(251 小号;音符砖 419 走电路路径)。 */
  instrumentItem: number;
  /** 若走电路路径:音符砖是否通电并奏出正确音高序列。 */
  noteCircuitOn: boolean;
  /** 乐器是否处于可用状态(未被沉默/冷却)。 */
  instrumentReady: boolean;
}

/**
 * 破防条件(设计手册:「吹响黄金凯旋小号(或敲响八音盒音符砖电路),
 * 声波直接震碎所有假分身」)。
 *
 * 两条等价路径,任一成立即破防:
 *  - 路径 A:手持小号且乐器可用;
 *  - 路径 B:音符砖电路通电奏出指定音高序列。
 * **必须存在分身(`clones.length > 0`),否则不成立。**
 */
export function foxBreakReady(i: FoxBreakInput): boolean {
  if (i.clones.length === 0) return false;
  const trump = i.instrumentItem === BREAK_ITEM.TRUMPET && i.instrumentReady;
  const circuit = i.noteCircuitOn;
  return trump || circuit;
}

/** 破幻后残留的真身(用于「震碎所有假分身」断言)。 */
export function survivorsAfterFoxBreak(clones: readonly BossClone[]): BossClone[] {
  return clones.filter((c) => c.isReal);
}

/** 假分身数量。 */
export function fakeCloneCount(clones: readonly BossClone[]): number {
  return clones.filter((c) => !c.isReal).length;
}

/* ═════════════ 4. 巨蟹:冰砖溜蟹撞黑曜石墙 ═════════════ */

export interface CrabSlideInput {
  /** 巨蟹脚下地砖 ID。 */
  floorUnder: number;
  /** 巨蟹当前水平速度(格/秒)。 */
  speed: number;
  /** 本轮滑行已发生的位移(格)。 */
  slidDistance: number;
  /** 前进方向上撞到的方块 ID(0 表示无阻挡)。 */
  obstacleAhead: number;
  /** 上一次结算时的壳减伤(0.90 为完好)。 */
  shellDr: number;
}

export interface CrabSlideResult {
  /** 是否处于失控打滑状态。 */
  uncontrolled: boolean;
  /** 是否撞击黑曜石墙并碎壳。 */
  shattered: boolean;
  /** 结算后的壳减伤。 */
  shellDrAfter: number;
  /** 眩晕窗口(秒)。 */
  stunSec: number;
}

/**
 * 破防判定(设计手册:「巨蟹冲上冰面失控打滑,高速撞墙震碎自己的紫晶外壳」)。
 *
 * 判定链:
 *  ① 失控 = 地砖是 315 冰砖 **且** μ=0.98(冻结常量)**且** 已滑行 ≥ 4 格;
 *  ② 碎壳 = 失控 **且** 前方是 359 黑曜石防爆城墙 **且** 速度 ≥ 8.0 格/秒;
 *  ③ 碎壳后 `shellDr` 从 0.90 → 0(防御从 90% 减伤降到 0);
 *  ④ 眩晕窗口恒为 6 秒(与 `BREAK_STUN_SEC` 一致)。
 */
export function crabSlideBreak(i: CrabSlideInput): CrabSlideResult {
  const uncontrolled = i.floorUnder === BREAK_ITEM.ICE_BRICK
    && ICE_MU >= 0.98
    && i.slidDistance >= CRAB_UNCONTROLLED_DISTANCE;
  const shattered = uncontrolled
    && i.obstacleAhead === BREAK_ITEM.OBSIDIAN_WALL
    && i.speed >= CRAB_SHATTER_SPEED;
  return {
    uncontrolled,
    shattered,
    shellDrAfter: shattered ? 0 : i.shellDr,
    stunSec: shattered ? OBSIDIAN_WALL_STUN_SEC : 0,
  };
}

/* ═════════════ 5. 法老蝎:多人拔河拽出沙面 ═════════════ */

export interface PullInput {
  /** 同一协作窗口内、勾住尾针的玩家各自施加的拉力(单位化,每人最多 1.0)。 */
  forces: readonly number[];
  /** 各玩家的钩爪/麻绳是否挂稳。 */
  anchored: readonly boolean[];
  /** 玩家是否与尾针方向近似共线(否则只是侧拉,拽不出来)。 */
  aligned: readonly boolean[];
}

export interface PullResult {
  ok: boolean;
  /** 有效拉力合力。 */
  totalForce: number;
  /** 参与人数(挂稳且共线)。 */
  pullers: number;
  reason: string;
}

/**
 * 破防判定(设计手册:「2~4 名玩家同时抛出灵巧飞索钩爪(或双向拔河大麻绳)
 * 勾住黄金尾针合力往后拉」)。
 *
 * 有效拉力只统计「已挂稳 **且** 与尾针共线」的玩家;
 * 需要 `2 ≤ 人数 ≤ 4` 且合力 ≥ 2.0。
 * **单人或三人中有一人未挂稳 → 不成立。**
 */
export function pullBreakReady(i: PullInput): PullResult {
  let total = 0;
  let n = 0;
  for (let k = 0; k < i.forces.length; k += 1) {
    if (!i.anchored[k]) continue;
    if (!i.aligned[k]) continue;
    total += Math.min(PULL_FORCE_PER_PLAYER, Math.max(0, i.forces[k]));
    n += 1;
  }
  if (n < PULL_MIN_PLAYERS) return { ok: false, totalForce: total, pullers: n, reason: 'too_few' };
  if (n > PULL_MAX_PLAYERS) return { ok: false, totalForce: total, pullers: n, reason: 'too_many' };
  if (total < PULL_FORCE_THRESHOLD) return { ok: false, totalForce: total, pullers: n, reason: 'force_low' };
  return { ok: true, totalForce: total, pullers: n, reason: 'pulled_out' };
}

/* ═════════════ 6. 姜饼巨魔:蹦床反弹 + 黑暗料理投喂 ═════════════ */

export interface GingerBreakInput {
  /** 路径 A:场上铺有 318 高弹果冻蹦床砖。 */
  trampolinePlaced: boolean;
  /** 路径 A:巨魔砸下的巨型糖球是否被蹦床原路反弹命中面部。 */
  sugarBallRebounded: boolean;
  /** 路径 B:是否已投喂 608 黑暗料理(含 127 幻彩变身菇的大锅汤)。 */
  darkCuisineFed: boolean;
  /** 路径 B:料理中确实含变身菇。 */
  containsMushroom: boolean;
  /** 目标是否处于暴食/投喂可接受状态(张嘴阶段)。 */
  mouthOpen: boolean;
}

/**
 * 破防判定(设计手册:「用高弹果冻蹦床砖把它砸下来的巨型糖球反弹砸晕它自己;
 * 或用八人欢聚大汤锅煮一锅加了变身菇的黑暗料理喂它」)。
 *
 * 两条并行路径,任一成立:
 *  - A:蹦床已铺 **且** 糖球被原路反弹;
 *  - B:料理已投喂 **且** 含变身菇 **且** 巨魔正处于张嘴阶段。
 */
export function gingerBreakReady(i: GingerBreakInput): boolean {
  const pathA = i.trampolinePlaced && i.sugarBallRebounded;
  const pathB = i.darkCuisineFed && i.containsMushroom && i.mouthOpen;
  return pathA || pathB;
}

/* ═════════════ 7. 云鲸:飞艇/叠罗汉登背敲雷晶 ═════════════ */

export interface WhaleBreakInput {
  /** 背脊上 3 颗寄生雷晶,是否已被敲碎。 */
  crystalBroken: readonly boolean[];
  /** 玩家以何种方式登上背脊:'AIRSHIP' | 'STACK' | 'NONE'。 */
  boardingMethod: string;
  /** 叠罗汉层数(路径 B 需要 4 层)。 */
  stackDepth: number;
  /** 3 颗雷晶是否在同一个 6 秒窗口内被击破。 */
  withinWindow: boolean;
}

/**
 * 破防判定(设计手册:「全队驾驶八人云海探险飞艇贴近云鲸(或 4 人叠罗汉踩弹簧垫
 * 高高跃起)跳到背脊上,合力敲碎背上 3 颗寄生雷晶」)。
 *
 * 三个条件同时满足:
 *  ① 登背方式合法:飞艇,或叠罗汉达到 4 层(`CARRY_MAX_DEPTH`);
 *  ② **3 颗雷晶全部击破**(`every` —— 敲碎 2 颗不算);
 *  ③ 全部发生在 6 秒窗口内。
 */
export function whaleBreakReady(i: WhaleBreakInput): boolean {
  const boarded = i.boardingMethod === 'AIRSHIP'
    || (i.boardingMethod === 'STACK' && i.stackDepth >= 4);
  if (!boarded) return false;
  if (i.crystalBroken.length !== WHALE_CRYSTAL_COUNT) return false;
  if (!i.crystalBroken.every(Boolean)) return false;
  return i.withinWindow;
}

/** 已击破雷晶数。 */
export function brokenCrystalCount(i: WhaleBreakInput): number {
  return i.crystalBroken.filter(Boolean).length;
}

/* ═════════════ 8. 克洛诺斯:四角四色电路通电破盾 ═════════════ */

export interface ChronosBreakInput {
  /** 四角导电座是否被压住/接通,顺序 [红, 蓝, 黄, 绿]。 */
  circuitsOn: readonly boolean[];
  /** 四角压力板是否均被压住。 */
  platesPressed: readonly boolean[];
  /** 中央电磁脉冲塔是否已通电激活。 */
  towerPowered: boolean;
  /** 时间护盾是否仍在生效。 */
  shieldActive: boolean;
}

export interface ChronosBreakResult {
  ok: boolean;
  /** 已接通的电路数 0..4。 */
  circuitsCount: number;
  /** 缺失的颜色名。 */
  missing: string[];
  reason: string;
}

export const CIRCUIT_COLORS: readonly string[] = ['RED', 'BLUE', 'YELLOW', 'GREEN'];

/**
 * 破防判定(设计手册:「战场四角各有 1 个红/蓝/黄/绿魔能导电座;
 * P2 时分工用魔能机械臂或重物压住四角压力板并接通四色电线,
 * 将中央电磁脉冲塔通电激活,一举击穿时间护盾」)。
 *
 * **必须四色齐备**:三缺一不破(核心断言)。
 * 同时要求压力板全压住、中央塔通电、且护盾仍在(护盾已消失则无需破)。
 */
export function chronosBreakReady(i: ChronosBreakInput): ChronosBreakResult {
  const missing: string[] = [];
  let count = 0;
  for (let k = 0; k < CHRONOS_CIRCUIT_COUNT; k += 1) {
    const on = Boolean(i.circuitsOn[k]) && Boolean(i.platesPressed[k]);
    if (on) count += 1;
    else missing.push(CIRCUIT_COLORS[k] ?? `#${k}`);
  }
  if (count < CHRONOS_CIRCUIT_COUNT) {
    return { ok: false, circuitsCount: count, missing, reason: 'circuit_incomplete' };
  }
  if (!i.towerPowered) {
    return { ok: false, circuitsCount: count, missing, reason: 'tower_unpowered' };
  }
  if (!i.shieldActive) {
    return { ok: false, circuitsCount: count, missing, reason: 'shield_gone' };
  }
  return { ok: true, circuitsCount: count, missing: [], reason: 'shield_pierced' };
}

/* ═════════════ 统一入口 ═════════════ */

export type BreakResult = { ok: boolean; reason: string };

/**
 * 按 Boss ID 分派到对应破防判定。
 *
 * 未登记输入类型的 Boss 返回 `ok:false, reason:'unsupported'`,
 * 保证调用方永远拿到一个确定结论而不是异常。
 */
export function evaluateBreak(bossId: string, input: unknown): BreakResult {
  switch (bossId) {
    case 'boss_jelly_king': return pass(jellyBreakReady(input as JellyBreakInput));
    case 'boss_beaver_mecha': return pass(beaverBreakReady(input as BeaverBreakInput));
    case 'boss_fox_kitsune': return pass(foxBreakReady(input as FoxBreakInput));
    case 'boss_crab_kraken': {
      const r = crabSlideBreak(input as CrabSlideInput);
      return { ok: r.shattered, reason: r.shattered ? 'shell_shattered' : 'no_shatter' };
    }
    case 'boss_scorpion_pharaoh': {
      const r = pullBreakReady(input as PullInput);
      return { ok: r.ok, reason: r.reason };
    }
    case 'boss_ginger_troll': return pass(gingerBreakReady(input as GingerBreakInput));
    case 'boss_sky_whale': return pass(whaleBreakReady(input as WhaleBreakInput));
    case 'boss_chronos_colossus': {
      const r = chronosBreakReady(input as ChronosBreakInput);
      return { ok: r.ok, reason: r.reason };
    }
    default:
      return { ok: false, reason: 'unsupported' };
  }
}

function pass(ok: boolean): BreakResult {
  return { ok, reason: ok ? 'break' : 'conditions_unmet' };
}

/**
 * 破防成功后的统一结算:套用眩晕窗口与全队暴击加成。
 *
 * 这是八条破防的**唯一收口**,避免每条各写一份时长。
 */
export function settleBreak(state: BossState, bossId: string): { stunSec: number; critBonus: number } {
  if (state.bossId !== bossId) throw new Error(`BossState(${state.bossId}) 与 bossId(${bossId}) 不一致`);
  return applyBreak(state);
}

/** 八条破防的 ID 清单(与 `BOSS_LIST` 一一对应,供覆盖度断言)。 */
export const BREAK_BOSS_IDS: readonly string[] = BOSS_LIST.map((b) => b.id);

/** 覆盖度自检:8 个 Boss 都有破防处理器。 */
export function breakCoverage(): { total: number; covered: number; missing: string[] } {
  const missing = BREAK_BOSS_IDS.filter((id) => evaluateBreak(id, {}) && !BOSS_BY_ID.has(id));
  return { total: BREAK_BOSS_IDS.length, covered: BREAK_BOSS_IDS.length - missing.length, missing };
}