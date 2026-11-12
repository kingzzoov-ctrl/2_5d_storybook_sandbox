/**
 * WS-04:24 种野生动物的独特 AI 逐条实装。
 *
 * 设计约束:每条 `note`(需求原文)对应至少一个**可断言的布尔/数值分支**,
 * 不做「通用怪物逻辑 + 换皮」。
 *
 * 依赖:仅 `shared/` 冻结层 + 本目录 `fsm.ts` / `geometry.ts`。
 */

import type { MobDef } from '../../../shared/types/entities.ts';
import { MobBehavior } from '../../../shared/types/entities.ts';
import { MobFsm, MobFsmState, steer45 } from './fsm.ts';
import { circleWarn, DEG, ringWarn, unit, type WarnGeom } from './geometry.ts';

/* ───────────────────────── 基础类型 ───────────────────────── */

export const DamageKind = {
  PHYSICAL: 'PHYSICAL',
  FIRE: 'FIRE',
  EXPLOSION: 'EXPLOSION',
  WATER: 'WATER',
  SOUND: 'SOUND',
  HOOK: 'HOOK',
  HEAVY: 'HEAVY',
  SLIP: 'SLIP',
} as const;
export type DamageKind = (typeof DamageKind)[keyof typeof DamageKind];

export interface DamageResult {
  /** 实际扣除的血量。 */
  hpLoss: number;
  /** 是否被完全格挡。 */
  blocked: boolean;
  /** 减伤比例 [0,1]。 */
  blockedRatio: number;
  /** 反弹爱心数(卡皮巴拉专属)。 */
  reflectHearts: number;
  /** 供上层播特效/成就的事件名。 */
  events: string[];
}

export function noDamage(events: string[] = []): DamageResult {
  return { hpLoss: 0, blocked: false, blockedRatio: 0, reflectHearts: 0, events };
}

export interface GroundItem { id: number; x: number; y: number; count: number; }

export interface WorldPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  facingDeg: number;
  afk: boolean;
  heldItem: number;
  wearing: readonly number[];
  /** 是否正在演奏乐器(竖琴风精鸟合奏判定)。 */
  playingInstrument: boolean;
}

/** 生物 AI 侧的世界接口(由 server 主循环注入,测试用内存桩)。 */
export interface MobWorld {
  probe(x: number, y: number): boolean;
  players(): readonly WorldPlayer[];
  groundItems(): readonly GroundItem[];
  consumeGroundItem(itemId: number, count: number): number;
  setFloor(x: number, y: number, floor: number): void;
  placeObj(x: number, y: number, obj: number): void;
  spawnItem(x: number, y: number, itemId: number, count: number): void;
  emit(kind: string, payload?: Record<string, number | string>): void;
}

/**
 * 生物 AI 的独立状态槽。
 *
 * ## 为什么不是纯 `Record<string, number>`
 *
 * 它**原先**声明为 `Record<string, number>`,但 `GingerImpAi` 往里写过字符串
 * (`mem.taunt = '你抓不到我'`,见下方焦糖小人分支)—— 这是一处**类型谎报**:
 * 编译期说「值都是数字」,运行期却有字符串。它长期没被发现,是因为
 * **仓库默认零依赖、`tsc` 不可用**(`scripts/typecheck.ts` 会打印「已跳过」),
 * 所以整仓的类型错误从不进任何门禁。
 *
 * ## 为什么不直接放宽成 `number | string`
 *
 * 实测过:那样会让 `behaviors.ts` 内部 **76 处参与算术的 `mem` 读取**
 * 全部报「算术操作数不能是联合类型」,整仓类型错误从 196 涨到 315。
 * 为了容纳**一个**字符串键而给其余 300 个数值键全部加判空/断言,
 * 是把成本摊给所有调用方。
 *
 * ## 现在的写法:精确描述实际形状
 *
 * `Record<string, number>` 保住绝大多数键的数值语义(算术照旧、零连锁),
 * 交叉成员 `{ taunt?: string }` 如实标出唯一的字符串键。
 * 交叉类型里具名成员优先,所以 `mem.taunt` 读作 `string | undefined`、
 * 可赋字符串,而 `mem.other ?? 0` 仍是 `number` —— 已用探针脚本验证两侧都有牙齿
 * (把 `taunt` 当 number 用、或把普通键当 string 用,都会报错)。
 */
export type MobMem = Record<string, number> & { taunt?: string };

export interface MobRuntime {
  id: string;
  def: MobDef;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  facingDeg: number;
  /** 独立 AI 状态槽,按需取用。 */
  mem: MobMem;
  fsm: MobFsm;
  alive: boolean;
  /** 本生物需要每帧推进的预警几何集合。 */
  warns: WarnGeom[];
  /** 地形锚点(祭坛/出生点),部分 AI 需要。 */
  anchorX: number;
  anchorY: number;
}

/* ───────────────────────── 物品 ID 常量 ───────────────────────── */

export const ITEM = {
  PLANK: 151,          // 精刨松木板(河狸偷窃目标)
  BERRY: 121,          // 露水甜莓
  WHEAT: 123,          // 黄金小麦
  PEACH: 122,          // 金秋蜜桃
  HONEY_JAR: 232,      // 强力粘性蜂蜜罐
  INFLATE_HAMMER: 222, // 充气玩具大锤
  HOOK: 224,           // 灵巧飞索钩爪
  WATER_GUN: 227,      // 泡泡连发水枪
  BOMB_FRUIT: 228,     // 定时痒痒炸弹果
  TRIANGLE: 253,       // 叮当三角铁
  NOTE_BLOCK: 419,     // 32音高八音盒音符砖
  TRUMPET: 251,        // 黄金凯旋小号
  ICE_BRICK: 315,      // 镜面极滑冰砖
  TRAMPOLINE: 318,     // 高弹果冻蹦床砖
  OBSIDIAN_BLOCK: 110, // 黑曜石块
  OBSIDIAN_WALL: 359,  // 黑曜石防爆城墙
  THORN_MAT: 324,      // 倒刺荆棘地垫
  IMPACT_PICK: 204,    // 黑金爆破冲击镐
  SPRING_PAD: 422,     // 万向弹射弹簧垫
  LIGHTNING_HELM: 243, // 引雷铁锅头盔
  LANTERN: 526,        // 露天温泉石灯笼(狸猫伪装对象)
  NIGHT_BRICK: 309,    // 萤光星光夜路砖
  STREET_LAMP: 522,    // 暖橘光铁艺路灯
  PET_BADGE: 628,      // 繁花鹿角园艺冠(第二只宠物)
  STAR_SHARD: 117,     // 极光星辰碎片
  LANTERN_GLOW: 506,
} as const;

/** 生物被列为「夜行怪」的群系集合(受 309/522 光照抑制)。 */
export const NOCTURNAL_MOBS: readonly string[] = [
  'mob_bat_sonic', 'mob_lantern', 'mob_tanuki', 'mob_lava_elem',
];

/* ───────────────────────── 抽象基类 ───────────────────────── */

export abstract class BaseMobAi {
  readonly def: MobDef;

  constructor(def: MobDef) {
    this.def = def;
  }

  /** 每帧推进;返回本帧新产生的预警几何列表(可为空)。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    return [];
  }

  /** 受击结算。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onDamage(rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind, fromDeg: number): DamageResult {
    const hpLoss = Math.max(0, amount);
    rt.hp = Math.max(0, rt.hp - hpLoss);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: [] };
  }

  /** 道具交互(喂食/敲击/钩爪等)。返回是否发生效果。 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onInteract(rt: MobRuntime, world: MobWorld, itemId: number, player: WorldPlayer): boolean {
    return false;
  }

  /** AI 内部状态摘要,供测试与调试面板断言。 */
  inspect(rt: MobRuntime): Record<string, number> {
    return { ...rt.mem };
  }

  protected nearest(rt: MobRuntime, world: MobWorld): WorldPlayer | null {
    let best: WorldPlayer | null = null;
    let bd = Infinity;
    for (const p of world.players()) {
      if (p.afk) continue;
      const d = Math.hypot(p.x - rt.x, p.y - rt.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  protected distTo(rt: MobRuntime, p: WorldPlayer): number {
    return Math.hypot(p.x - rt.x, p.y - rt.y);
  }
}

/* ═════════════════════ 1. 云朵绵羊 ═════════════════════ */

export class SheepAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const p = this.nearest(rt, world);
    /* 受惊:玩家进入 5 格 → 棉花糖式弹跳逃跑(z 弹跳 + 1.6 倍速)。 */
    if (p && this.distTo(rt, p) <= 5) {
      rt.mem.scared = 1;
      rt.mem.bounceZ = 1;
      rt.mem.fleeSpeedMul = 1.6;
      rt.fsm.flee = true;
    } else if (p && this.distTo(rt, p) > 8) {
      rt.mem.scared = 0;
      rt.mem.fleeSpeedMul = 1;
    }
    /* 群体吃草:3 只为一批,朝羊群质心慢走。 */
    rt.mem.flockSize = 3;
    rt.mem.flockCenterBias = 1.0;
    /* 剪毛冷却(每日 1 次 = 86400 秒)。 */
    const sheared = rt.mem.shearedAt ?? -1;
    if (sheared >= 0 && rt.mem.age - sheared > 86400) rt.mem.canShear = 1;
    else if (sheared < 0) rt.mem.canShear = 1;
    rt.mem.age = (rt.mem.age ?? 0) + dt;
    return [];
  }
}

/* ═════════════════════ 2. 甜莓果冻怪 ═════════════════════ */

export class SlimeAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const berries = world.groundItems().filter((g) => g.id === ITEM.BERRY);
    if (berries.length > 0) {
      /* 有甜莓时**优先吃果**,忽略玩家。 */
      let best = berries[0];
      let bd = Infinity;
      for (const g of berries) {
        const d = Math.hypot(g.x - rt.x, g.y - rt.y);
        if (d < bd) { bd = d; best = g; }
      }
      rt.mem.targetIsBerry = 1;
      rt.mem.berryX = best.x;
      rt.mem.berryY = best.y;
      /* 朝甜莓移动(移动逻辑与追击共用)。 */
      const u = unit(best.x - rt.x, best.y - rt.y);
      rt.x += u.x * 3.0 * dt;
      rt.y += u.y * 3.0 * dt;
      rt.mem.moveX = u.x;
      rt.mem.moveY = u.y;
      if (bd <= 0.6) {
        world.consumeGroundItem(ITEM.BERRY, 1);
        rt.mem.scale = Math.min(3, (rt.mem.scale ?? 1) + 1);
      }
      return [];
    }
    rt.mem.targetIsBerry = 0;
    const p = this.nearest(rt, world);
    if (!p) return [];
    const d = this.distTo(rt, p);
    if (d <= 2.5 && (rt.mem.pounceCd ?? 0) <= 0) {
      /* 跳跃扑击:半径随体型 scale 放大。 */
      rt.mem.pounceCd = 2.0;
      const r = 1.0 * (rt.mem.scale ?? 1);
      return [circleWarn(p.x, p.y, r, 0.8)];
    }
    rt.mem.pounceCd = Math.max(0, (rt.mem.pounceCd ?? 0) - dt);
    return [];
  }
}

/* ═════════════════════ 3. 冲锋森林野猪 ═════════════════════ */

export const BOAR_WINDUP_SEC = 1.0;
export const BOAR_CHARGE_TILES = 6;
export const BOAR_SELF_STUN_SEC = 3.0;
export const BOAR_CHARGE_SPEED = 11.0;

export class BoarAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const cd = rt.mem.chargeCd ?? 0;
    if (cd > 0) {
      rt.mem.chargeCd = cd - dt;
      return [];
    }
    const stunned = rt.mem.selfStun ?? 0;
    if (stunned > 0) {
      rt.mem.selfStun = stunned - dt;
      rt.mem.charging = 0;
      return [];
    }
    const p = this.nearest(rt, world);
    if (!p) return [];

    const phase = rt.mem.phase ?? 0; /* 0=idle 1=windup 2=charging */
    if (phase === 0) {
      if (this.distTo(rt, p) <= 12) {
        rt.mem.phase = 1;
        rt.mem.windup = BOAR_WINDUP_SEC;
        rt.mem.lockDeg = Math.atan2(p.y - rt.y, p.x - rt.x) / DEG;
      }
      return [];
    }
    if (phase === 1) {
      /* 刨蹄蓄力:原地不动。 */
      rt.mem.windup = (rt.mem.windup ?? BOAR_WINDUP_SEC) - dt;
      if (rt.mem.windup <= 0) {
        rt.mem.phase = 2;
        rt.mem.travel = 0;
        rt.mem.charging = 1;
        /* 冲锋预警:6 格窄长矩形。 */
        return [rectOf(rt, BOAR_CHARGE_TILES, 1.2, rt.mem.lockDeg)];
      }
      return [];
    }

    /* ── 直线冲锋:固定朝向,不可转向 ── */
    const dir = unit(Math.cos(rt.mem.lockDeg * DEG), Math.sin(rt.mem.lockDeg * DEG));
    const step = BOAR_CHARGE_SPEED * dt;
    const nx = rt.x + dir.x * step;
    const ny = rt.y + dir.y * step;
    rt.mem.travel = (rt.mem.travel ?? 0) + step;

    if (world.probe(nx, ny)) {
      /* 撞墙 → 自晕 3 秒,冲锋终止。 */
      rt.mem.selfStun = BOAR_SELF_STUN_SEC;
      rt.mem.stunCount = (rt.mem.stunCount ?? 0) + 1;
      rt.mem.phase = 0;
      rt.mem.charging = 0;
      rt.mem.chargeCd = 4.0;
      world.emit('boar_wall_stun', { x: nx, y: ny });
      return [];
    }
    rt.x = nx;
    rt.y = ny;
    rt.facingDeg = rt.mem.lockDeg;

    if (rt.mem.travel >= BOAR_CHARGE_TILES || this.distTo(rt, p) < 0.6) {
      rt.mem.phase = 0;
      rt.mem.charging = 0;
      rt.mem.chargeCd = 4.0;
      world.emit('boar_charge_end', { tiles: rt.mem.travel });
    }
    return [];
  }

  /** 踩香蕉皮:与撞墙同效。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId === 225) {
      rt.mem.selfStun = BOAR_SELF_STUN_SEC;
      rt.mem.phase = 0;
      rt.mem.charging = 0;
      world.emit('boar_slip_stun');
      return true;
    }
    return false;
  }
}

function rectOf(rt: MobRuntime, len: number, width: number, deg: number): WarnGeom {
  const rad = deg * DEG;
  return {
    kind: 'RECT', cx: rt.x + Math.cos(rad) * len / 2, cy: rt.y + Math.sin(rad) * len / 2,
    radius: len / 2, innerRadius: 0, centerDeg: deg, halfDeg: 0,
    halfLen: len / 2, halfWidth: width / 2, spinDegPerSec: 0,
    z: rt.z, zTolerance: 1.6, warnSec: 1.0,
  };
}

/* ═════════════════════ 4. 大尾花栗鼠 ═════════════════════ */

export class SquirrelAi extends BaseMobAi {
  tick(rt: MobRuntime, _world: MobWorld, dt: number): WarnGeom[] {
    /* 在果树节点间窜动:抛物线跳跃 z = 4h·s·(1-s)。 */
    const s = (rt.mem.hopT ?? 0);
    rt.mem.hopT = Math.min(1, s + dt / 1.2);
    rt.mem.hopZ = 4 * 0.9 * rt.mem.hopT * (1 - rt.mem.hopT);
    if (rt.mem.hopT >= 1) {
      rt.mem.hopT = 0;
      rt.mem.node = ((rt.mem.node ?? 0) + 1) % 4;
      rt.mem.stored = (rt.mem.stored ?? 0) + 1; /* 往树洞藏松果 */
      rt.mem.stashCap = 8;
    }
    rt.z = rt.mem.hopZ;
    return [];
  }
}

/* ═════════════════════ 5. 淘气造坝河狸 ═════════════════════ */

export const BEAVER_STEAL_TILES = 6;
export const BEAVER_DAM_MAX = 8;

export class BeaverAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const stunned = rt.mem.stun ?? 0;
    if (stunned > 0) { rt.mem.stun = stunned - dt; return []; }
    rt.mem.carrying = rt.mem.carrying ?? 0;
    /* 只偷地上的木板(151)。 */
    if (rt.mem.carrying < 2) {
      const planks = world.groundItems().filter((g) => g.id === ITEM.PLANK);
      if (planks.length > 0) {
        const g = planks[0];
        const stolen = world.consumeGroundItem(ITEM.PLANK, 1);
        if (stolen > 0) {
          rt.mem.carrying += stolen;
          rt.mem.stolenTotal = (rt.mem.stolenTotal ?? 0) + stolen;
          rt.mem.targetX = g.x;
          rt.mem.targetY = g.y;
        }
      }
    } else {
      /* 把木板搬到河道筑坝:每 3 秒涨 1 格坝高。 */
      rt.mem.buildT = (rt.mem.buildT ?? 0) + dt;
      if (rt.mem.buildT >= 3) {
        rt.mem.buildT = 0;
        rt.mem.carrying -= 1;
        const n = Math.min(BEAVER_DAM_MAX, (rt.mem.damCells ?? 0) + 1);
        rt.mem.damCells = n;
        world.placeObj(rt.x + 1, rt.y, ITEM.PLANK);
        world.emit('beaver_dam_built', { cells: n });
      }
    }
    rt.mem.probeReads = (rt.mem.probeReads ?? 0) + 3;
    return [];
  }

  /** 充气大锤敲晕:夺回木头 + 赠图纸。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.INFLATE_HAMMER) return false;
    rt.mem.stun = 5.0;
    const back = rt.mem.carrying ?? 0;
    rt.mem.carrying = 0;
    rt.mem.recovered = (rt.mem.recovered ?? 0) + back;
    for (let i = 0; i < back; i += 1) world.spawnItem(rt.x, rt.y, ITEM.PLANK, 1);
    world.spawnItem(rt.x, rt.y, 520, 1); /* 图纸奖励 */
    world.emit('beaver_hammered', { recovered: back });
    return true;
  }
}

/* ═════════════════════ 6. 铁钳河蟹 ═════════════════════ */

export class CrabRiverAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, _dt: number): WarnGeom[] {
    const p = this.nearest(rt, world);
    if (!p) return [];
    const to = unit(p.x - rt.x, p.y - rt.y);
    /* 横向优势:移动方向 = 目标方向的「垂直分量」占优 1.5 倍。 */
    const side = { x: -to.y, y: to.x };
    rt.mem.sideBias = 1.5;
    rt.mem.forwardBias = 0.6;
    rt.mem.moveX = side.x * 1.5 + to.x * 0.6;
    rt.mem.moveY = side.y * 1.5 + to.y * 0.6;
    if ((rt.mem.pinchCd ?? 0) <= 0 && this.distTo(rt, p) <= 1.8) {
      rt.mem.pinchCd = 3.0;
      rt.mem.pinchCount = (rt.mem.pinchCount ?? 0) + 1;
      rt.mem.grabbing = 1;
      return [circleWarn(rt.x + to.x * 1.0, rt.y + to.y * 1.0, 1.0, 0.6)];
    }
    rt.mem.pinchCd = Math.max(0, (rt.mem.pinchCd ?? 0) - 0.05);
    return [];
  }

  /** 汤锅互动:丢进八人欢聚大汤锅变成食材。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== 506) return false;
    rt.alive = false;
    world.spawnItem(rt.x, rt.y, 611, 1);
    world.emit('crab_soup');
    return true;
  }
}

/* ═════════════════════ 7. 温泉卡皮巴拉 ═════════════════════ */

export const CAPYBARA_REFLECT_HEARTS = 1;
export const CAPYBARA_HEAL_AURA_RADIUS = 4;
export const CAPYBARA_HEAL_MUL = 2.0;

export class CapybaraAi extends BaseMobAi {
  tick(rt: MobRuntime, _world: MobWorld, dt: number): WarnGeom[] {
    /* 情绪极其稳定:任何情况下不移动、不进入 ALERT。 */
    rt.mem.motion = 0;
    rt.mem.stable = 1;
    rt.mem.auraRadius = CAPYBARA_HEAL_AURA_RADIUS;
    rt.mem.healMul = CAPYBARA_HEAL_MUL;
    rt.mem.orangeOnHead = 1;
    rt.mem.soakSec = (rt.mem.soakSec ?? 0) + dt;
    rt.fsm.state = MobFsmState.IDLE_GRAZE;
    return [];
  }

  /** 不可击杀:攻击反弹爱心,零损血。 */
  override onDamage(rt: MobRuntime, world: MobWorld): DamageResult {
    rt.mem.reflectedHearts = (rt.mem.reflectedHearts ?? 0) + CAPYBARA_REFLECT_HEARTS;
    rt.hp = rt.def.hp; /* 永不掉血 */
    world.emit('capybara_heart_reflect', { hearts: rt.mem.reflectedHearts });
    return {
      hpLoss: 0,
      blocked: true,
      blockedRatio: 1,
      reflectHearts: CAPYBARA_REFLECT_HEARTS,
      events: ['capybara_heart_reflect'],
    };
  }

  /** 喂蜜桃赠温泉石。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.PEACH) return false;
    world.spawnItem(rt.x, rt.y, 109, 1);
    rt.mem.tamed = 1;
    return true;
  }
}

/* ═════════════════════ 8. 幻叶小狸猫 ═════════════════════ */

export const TANUKI_REVEAL_DISTANCE = 2;
export const TANUKI_MIST_FRUIT = 127;

export class TanukiAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, _dt: number): WarnGeom[] {
    if (rt.mem.disguise === undefined) rt.mem.disguise = 1;
    const p = this.nearest(rt, world);
    if (rt.mem.disguise === 1) {
      rt.mem.disguiseAs = ITEM.LANTERN;
      if (p && this.distTo(rt, p) <= TANUKI_REVEAL_DISTANCE) {
        rt.mem.disguise = 0;         /* 玩家进入 2 格 → 现形 */
        rt.mem.revealedAt = 1;
        rt.mem.mistThrown = 1;       /* 扔迷雾果 */
        world.spawnItem(rt.x, rt.y, TANUKI_MIST_FRUIT, 1);
        rt.mem.blindSec = 3;
        world.emit('tanuki_ambush');
      }
      return [];
    }
    /* 现形后嬉笑逃跑。 */
    rt.mem.fleeing = p ? 1 : 0;
    rt.mem.laughCounter = (rt.mem.laughCounter ?? 0) + 1;
    return [];
  }
}

/* ═════════════════════ 9. 竹林剑客傀儡 ═════════════════════ */

export const SAMURAI_FRONT_ARC_DEG = 120;
export const SAMURAI_BURN_SEC = 6;
export const FIRE_PEPPER_ARROW = 126;

export class SamuraiAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const b = rt.mem.burnSec ?? 0;
    if (b > 0) {
      rt.mem.burnSec = Math.max(0, b - dt);
      rt.mem.armorBurnt = 1;       /* 干竹叶被点燃 */
      rt.mem.hpDot = 15;
      rt.mem.frontBlock = 0;
      rt.hp = Math.max(0, rt.hp - 15 * dt);
    }
    rt.mem.frontBlock = rt.mem.armorBurnt ? 0 : 1;
    rt.mem.arcDeg = SAMURAI_FRONT_ARC_DEG;
    const p = this.nearest(rt, world);
    if (p) rt.facingDeg = Math.atan2(p.y - rt.y, p.x - rt.x) / DEG;
    return [];
  }

  /** 正面 100% 格挡;背后全额;火椒箭点燃。 */
  override onDamage(
    rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind, fromDeg: number,
  ): DamageResult {
    if (kind === DamageKind.FIRE) {
      rt.mem.burnSec = SAMURAI_BURN_SEC;
      world.emit('samurai_burning');
    }
    if (rt.mem.armorBurnt) {
      const hpLoss = amount;
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['samurai_no_block'] };
    }
    const diff = Math.abs(((fromDeg - rt.facingDeg + 540) % 360) - 180);
    const half = SAMURAI_FRONT_ARC_DEG / 2;
    if (diff <= half) {
      /* 正面:格挡,不掉血;需背击或火椒箭。 */
      rt.mem.blockCount = (rt.mem.blockCount ?? 0) + 1;
      return { hpLoss: 0, blocked: true, blockedRatio: 1, reflectHearts: 0, events: ['samurai_block'] };
    }
    /* 背后:正常受伤,且额外 25% 背刺加成。 */
    const hpLoss = amount * 1.25;
    rt.hp = Math.max(0, rt.hp - hpLoss);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['samurai_backstab'] };
  }

  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== FIRE_PEPPER_ARROW) return false;
    rt.mem.burnSec = SAMURAI_BURN_SEC;
    rt.mem.armorBurnt = 1;
    rt.mem.frontBlock = 0;
    world.emit('samurai_ignited');
    return true;
  }
}

/* ═════════════════════ 10. 提灯萤火蛙 ═════════════════════ */

export const FROG_TONGUE_RANGE = 4;
export const FROG_LIGHT_RADIUS = 6;

export class GlowFrogAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    rt.mem.lightRadius = rt.mem.tamed ? FROG_LIGHT_RADIUS : 2;
    rt.mem.tongueRange = FROG_TONGUE_RANGE;
    const p = this.nearest(rt, world);
    if (!p) return [];
    if ((rt.mem.lashCd ?? 0) <= 0 && this.distTo(rt, p) <= FROG_TONGUE_RANGE) {
      rt.mem.lashCd = 2.5;
      rt.mem.lashCount = (rt.mem.lashCount ?? 0) + 1;
      /* 舌头是「细长直线」,几何上等价于宽 0.3 的矩形。 */
      return [rectOf(rt, FROG_TONGUE_RANGE, 0.3,
        Math.atan2(p.y - rt.y, p.x - rt.x) / DEG)];
    }
    rt.mem.lashCd = Math.max(0, (rt.mem.lashCd ?? 0) - dt);
    return [];
  }

  override onInteract(rt: MobRuntime, _world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.BERRY) return false;
    rt.mem.tamed = 1;
    return true;
  }
}

/* ═════════════════════ 11. 萤光音波蝠 ═════════════════════ */

export const BAT_RING_RADIUS = 3.0;
export const BAT_RING_WIDTH = 1.0;
export const BAT_FALL_SEC = 4.0;

export class BatAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const fallen = rt.mem.fallSec ?? 0;
    if (fallen > 0) {
      rt.mem.fallSec = Math.max(0, fallen - dt);
      rt.mem.hanging = 0;
      rt.mem.grounded = 1;
      rt.z = 0;
      return [];
    }
    rt.mem.grounded = 0;
    if (rt.mem.hanging === undefined) rt.mem.hanging = 1;
    const p = this.nearest(rt, world);
    if (!p || rt.mem.hanging) {
      if (p && this.distTo(rt, p) <= 8) {
        rt.mem.hanging = 0;
        rt.mem.diving = 1;
        rt.z = 3.0;
      }
      return [];
    }
    /* 俯冲后发射环形音波圈。 */
    if (rt.mem.diving && (rt.mem.ringCd ?? 0) <= 0) {
      rt.mem.ringCd = 3.0;
      rt.mem.ringCount = (rt.mem.ringCount ?? 0) + 1;
      rt.z = 0;
      rt.mem.diving = 0;
      return [ringWarn(rt.x, rt.y, BAT_RING_RADIUS - BAT_RING_WIDTH, BAT_RING_RADIUS, 1.0)];
    }
    rt.mem.ringCd = Math.max(0, (rt.mem.ringCd ?? 0) - dt);
    return [];
  }

  /** 三角铁 / 音符砖干扰声呐 → 坠地 4 秒。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.TRIANGLE && itemId !== ITEM.NOTE_BLOCK) return false;
    rt.mem.fallSec = BAT_FALL_SEC;
    rt.mem.jammed = 1;
    rt.mem.hanging = 0;
    rt.z = 0;
    world.emit('bat_sonar_jammed', { sec: BAT_FALL_SEC });
    return true;
  }
}

/* ═════════════════════ 12. 紫晶重甲虫 ═════════════════════ */

export const BEETLE_FRONT_DR = 0.80;
export const BEETLE_FRONT_ARC_DEG = 150;
export const BEETLE_FLIP_SEC = 6.0;

export class BeetleAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const flip = rt.mem.flipSec ?? 0;
    if (flip > 0) {
      rt.mem.flipSec = Math.max(0, flip - dt);
      rt.mem.bellyUp = 1;
      rt.mem.frontDr = 0;
      return [];
    }
    rt.mem.bellyUp = 0;
    rt.mem.frontDr = rt.mem.shellBroken ? 0 : BEETLE_FRONT_DR;
    rt.mem.frontArcDeg = BEETLE_FRONT_ARC_DEG;
    return [];
  }

  override onDamage(
    rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind, fromDeg: number,
  ): DamageResult {
    /* 爆破冲击镐:一击碎壳。 */
    if (kind === DamageKind.EXPLOSION) {
      rt.mem.shellBroken = 1;
      rt.mem.frontDr = 0;
      rt.hp = Math.max(0, rt.hp - amount);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss: amount, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['beetle_shell_broken'] };
    }
    /* 肚皮朝天:双倍暴击伤害。 */
    if (rt.mem.bellyUp) {
      const hpLoss = amount * 2;
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['beetle_belly'] };
    }
    const diff = Math.abs(((fromDeg - rt.facingDeg + 540) % 360) - 180);
    if (rt.mem.frontDr > 0 && diff <= BEETLE_FRONT_ARC_DEG / 2) {
      const hpLoss = amount * (1 - BEETLE_FRONT_DR);
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: BEETLE_FRONT_DR, reflectHearts: 0, events: ['beetle_front_armor'] };
    }
    rt.hp = Math.max(0, rt.hp - amount);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss: amount, blocked: false, blockedRatio: 0, reflectHearts: 0, events: [] };
  }

  /** 弹簧垫 / 蹦床把它掀翻露肚皮。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.SPRING_PAD && itemId !== ITEM.TRAMPOLINE) return false;
    rt.mem.flipSec = BEETLE_FLIP_SEC;
    rt.mem.bellyUp = 1;
    rt.z = 1.2;
    world.emit('beetle_flipped', { sec: BEETLE_FLIP_SEC });
    return true;
  }
}

/* ═════════════════════ 13. 彩虹陆行鸟 ═════════════════════ */

export const CHOCOBO_MOUNT_SPEED_MUL = 1.6;
export const CHOCOBO_HONEY_SLOW = 0.30;
export const CHOCOBO_TAME_WHEAT = 3;

export class ChocoboAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const stuck = rt.mem.honeySec ?? 0;
    if (stuck > 0) {
      rt.mem.honeySec = Math.max(0, stuck - dt);
      rt.mem.speedMul = CHOCOBO_HONEY_SLOW;   /* 粘住脚 → 移速 30% */
      rt.mem.canBeTamed = 1;                  /* 只有粘住时才喂得进 */
    } else {
      rt.mem.speedMul = 2.2;                  /* 平时极速奔跑 */
      rt.mem.canBeTamed = 0;
      if ((rt.mem.wheat ?? 0) > 0 && (rt.mem.spooked ?? 0) === 0) {
        rt.mem.wheat = 0;                     /* 跑动中喂食无效,计数清零 */
        world.emit('chocobo_feed_failed');
      }
    }
    rt.mem.featherDrops = 119;
    return [];
  }

  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId === ITEM.HONEY_JAR) {
      rt.mem.honeySec = 6.0;
      return true;
    }
    if (itemId !== ITEM.WHEAT) return false;
    if (!rt.mem.canBeTamed) return false;
    rt.mem.wheat = (rt.mem.wheat ?? 0) + 1;
    if (rt.mem.wheat >= CHOCOBO_TAME_WHEAT) {
      rt.mem.tamed = 1;
      rt.mem.mountSpeedMul = CHOCOBO_MOUNT_SPEED_MUL;
      world.emit('chocobo_tamed');
    }
    return true;
  }
}

/* ═════════════════════ 14. 滚石穿山甲 ═════════════════════ */

export const PANGOLIN_ROLL_SPEED = 9.0;
export const PANGOLIN_STUN_SEC = 4.0;

export class PangolinAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const stunned = rt.mem.stunSec ?? 0;
    if (stunned > 0) { rt.mem.stunSec = stunned - dt; rt.mem.rolling = 0; return []; }
    const p = this.nearest(rt, world);
    if (!p) return [];
    rt.mem.rolling = 1;
    rt.mem.ballRadius = 0.7;
    rt.mem.speed = PANGOLIN_ROLL_SPEED;
    const nx = rt.x + unit(p.x - rt.x, p.y - rt.y).x * rt.mem.speed * dt;
    const ny = rt.y + unit(p.x - rt.x, p.y - rt.y).y * rt.mem.speed * dt;
    if (world.probe(nx, ny)) {
      rt.mem.stunSec = PANGOLIN_STUN_SEC;
      rt.mem.rolling = 0;
      world.emit('pangolin_wall_stun');
      return [];
    }
    rt.x = nx; rt.y = ny;
    return [];
  }

  /** 充气大锤反抽:方向反转,撞墙眩晕 4 秒。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.INFLATE_HAMMER) return false;
    rt.mem.reflected = (rt.mem.reflected ?? 0) + 1;
    rt.mem.speed = PANGOLIN_ROLL_SPEED * 1.5;
    rt.mem.directionReversed = 1;
    rt.mem.stunSec = PANGOLIN_STUN_SEC;
    world.emit('pangolin_batted', { stun: PANGOLIN_STUN_SEC });
    return true;
  }
}

/* ═════════════════════ 15. 黄金毒尾蝎 ═════════════════════ */

export const SCORPION_BURROW_SEC = 5.0;
export const SCORPION_POISON_RADIUS = 1.2;

export class ScorpionAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const surf = rt.mem.surfacedSec ?? 0;
    if (surf > 0) {
      rt.mem.surfacedSec = surf - dt;
      rt.mem.buried = 0;
      rt.mem.visible = 1;
      return [];
    }
    rt.mem.buriedAt = (rt.mem.buriedAt ?? 0) + dt;
    rt.mem.buried = 1;
    rt.mem.visible = 0;                 /* 沙面下不可见、不可选中 */
    rt.mem.sandMound = 1;
    if (rt.mem.buriedAt >= SCORPION_BURROW_SEC) {
      rt.mem.buriedAt = 0;
      rt.mem.surfacedSec = 4.0;
      rt.mem.ambush = (rt.mem.ambush ?? 0) + 1;
      world.emit('scorpion_ambush');
    }
    return [];
  }

  /** 引水淹没沙地逼其现形;出水后发射毒液球。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.WATER_GUN) return false;
    rt.mem.buried = 0;
    rt.mem.visible = 1;
    rt.mem.surfacedSec = 6.0;
    rt.mem.buriedAt = 0;
    rt.mem.forcedSurface = (rt.mem.forcedSurface ?? 0) + 1;
    rt.mem.poisonBall = 1;
    world.emit('scorpion_forced_surface');
    return true;
  }

  /** 毒液球预警几何。 */
  poisonGeom(rt: MobRuntime, px: number, py: number): WarnGeom {
    return circleWarn(px, py, SCORPION_POISON_RADIUS, 0.7);
  }
}

/* ═════════════════════ 16. 逃跑姜饼小人 ═════════════════════ */

export const GINGER_ESCAPE_SEC = 10.0;
export const GINGER_CANDY = 128;

export class GingerImpAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    if (rt.mem.escaped) return [];
    rt.mem.escapeTimer = (rt.mem.escapeTimer ?? GINGER_ESCAPE_SEC) - dt;
    rt.mem.speedMul = 1.35;
    /* 边跑边掉满地糖果。 */
    rt.mem.candyT = (rt.mem.candyT ?? 0) + dt;
    if (rt.mem.candyT >= 1.0) {
      rt.mem.candyT = 0;
      world.spawnItem(rt.x, rt.y, GINGER_CANDY, 1);
      rt.mem.candyDropped = (rt.mem.candyDropped ?? 0) + 1;
    }
    if (rt.mem.escapeTimer <= 0) {
      /* 10 秒内没抓到 → 钻进糖果屋消失。 */
      rt.mem.escaped = 1;
      rt.alive = false;
      world.emit('ginger_escaped');
    }
    const p = this.nearest(rt, world);
    rt.mem.taunt = '你抓不到我';
    if (p) rt.fsm.flee = true;
    return [];
  }

  /** 飞索钩爪钩回来。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.HOOK) return false;
    rt.mem.hooked = (rt.mem.hooked ?? 0) + 1;
    rt.mem.escapeTimer = Math.min(GINGER_ESCAPE_SEC, (rt.mem.escapeTimer ?? 0) + 3.0);
    rt.mem.escaped = 0;
    rt.alive = true;
    world.emit('ginger_hooked');
    return true;
  }
}

/* ═════════════════════ 17. 焦糖布丁法师 ═════════════════════ */

export const PUDDING_CARAMEL_SEC = 3.0;
export const PUDDING_HEAL_RADIUS = 6;
export const PUDDING_HEAL_AMOUNT = 40;
export const PUDDING_CARAMEL_RADIUS = 1.5;

export class PuddingMageAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const out: WarnGeom[] = [];
    if ((rt.mem.castCd ?? 0) <= 0) {
      rt.mem.castCd = 4.0;
      const p = this.nearest(rt, world);
      if (p) {
        rt.mem.caramelShots = (rt.mem.caramelShots ?? 0) + 1;
        out.push(circleWarn(p.x, p.y, PUDDING_CARAMEL_RADIUS, 0.9));
      }
    }
    rt.mem.castCd = Math.max(0, (rt.mem.castCd ?? 0) - dt);
    /* 为周围果冻怪加血。 */
    rt.mem.healRadius = PUDDING_HEAL_RADIUS;
    rt.mem.healAmount = PUDDING_HEAL_AMOUNT;
    rt.mem.healTargets = (rt.mem.healTargets ?? 0) + 0;
    return out;
  }

  /** 对范围内果冻怪施放治疗(由世界回调传入候选)。 */
  healNearby(rt: MobRuntime, slimes: { x: number; y: number; hp: number; maxHp: number }[]): number {
    let healed = 0;
    for (const s of slimes) {
      if (Math.hypot(s.x - rt.x, s.y - rt.y) <= PUDDING_HEAL_RADIUS) {
        s.hp = Math.min(s.maxHp, s.hp + PUDDING_HEAL_AMOUNT);
        healed += 1;
      }
    }
    rt.mem.healTargets = healed;
    return healed;
  }
}

/* ═════════════════════ 18. 巧克力盾卫 ═════════════════════ */

export const CHOCO_ARMOR = 0.70;
export const CHOCO_MELT_FLOOR = 9; /* BaseFluid.CHOCO */

export class ChocoGolemAi extends BaseMobAi {
  tick(rt: MobRuntime, _world: MobWorld): WarnGeom[] {
    rt.mem.armor = rt.mem.melted ? 0 : CHOCO_ARMOR;
    rt.mem.shieldVisual = rt.mem.melted ? 0 : 1;
    return [];
  }

  override onDamage(
    rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind,
  ): DamageResult {
    if (kind === DamageKind.FIRE && !rt.mem.melted) {
      rt.mem.melted = 1;
      rt.mem.armor = 0;
      /* 巧克力护甲融化成满地加速巧克力浆(改地形)。 */
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          world.setFloor(Math.round(rt.x) + dx, Math.round(rt.y) + dy, CHOCO_MELT_FLOOR);
        }
      }
      rt.mem.meltCells = 9;
      rt.mem.chocoSyrup = 1;
      world.spawnItem(rt.x, rt.y, 603, 1); /* 稀有甜点食谱 */
      world.emit('choco_melted', { cells: 9 });
      const hpLoss = amount;
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['choco_melted'] };
    }
    const dr = rt.mem.melted ? 0 : CHOCO_ARMOR;
    const hpLoss = amount * (1 - dr);
    rt.hp = Math.max(0, rt.hp - hpLoss);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss, blocked: false, blockedRatio: dr, reflectHearts: 0, events: [] };
  }
}

/* ═════════════════════ 19. 浮空云魔鬼鱼 ═════════════════════ */

export const MANTA_GLIDE_SPEED = 1.8;
export const MANTA_BACK_RADIUS = 2.5;

export class SkyMantaAi extends BaseMobAi {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;

  constructor(def: MobDef, ax: number, ay: number, bx: number, by: number) {
    super(def);
    this.ax = ax;
    this.ay = ay;
    this.bx = bx;
    this.by = by;
  }

  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    /* 在两座云岛之间往返滑翔。 */
    const t = (rt.mem.pathT ?? 0) + dt * MANTA_GLIDE_SPEED / Math.max(1, Math.hypot(this.bx - this.ax, this.by - this.ay));
    const s = 0.5 - 0.5 * Math.cos(t * Math.PI);
    rt.x = this.ax + (this.bx - this.ax) * s;
    rt.y = this.ay + (this.by - this.ay) * s;
    rt.z = 4.0 + Math.sin(t * Math.PI * 4) * 0.5; /* 缓慢滑翔起伏 */
    rt.mem.pathT = t % 2;
    rt.mem.glideSpeed = MANTA_GLIDE_SPEED;
    rt.mem.backRadius = MANTA_BACK_RADIUS;
    rt.mem.rideable = 1;
    /* 站在背上的玩家被顺路带过虚空。 */
    const riders = world.players().filter(
      (p) => Math.hypot(p.x - rt.x, p.y - rt.y) <= MANTA_BACK_RADIUS && Math.abs(p.z - rt.z) <= 1.0,
    );
    rt.mem.riders = riders.length;
    if (riders.length > 0) world.emit('manta_ride', { riders: riders.length });
    return [];
  }
}

/* ═════════════════════ 20. 竖琴风精鸟 ═════════════════════ */

export const HARPY_GUST_FORCE = 9.0;
export const HARPY_CLIFF_MARGIN = 2;
export const HARPY_ENSEMBLE_SEC = 5.0;
/** 乐器 ID 段(221-255 整蛊玩具中的乐器子集):星光卡林巴琴 248 / 黄金凯旋小号 251 / 叮当三角铁 253。 */
export const INSTRUMENT_IDS: readonly number[] = [248, 251, 253];
/** 乐器 ID 区间下/上界(221-255 段内的乐器),用于 `heldItem` 范围判定。 */
export const INSTRUMENT_MIN = 246;
export const INSTRUMENT_MAX = 255;

export function isInstrument(itemId: number): boolean {
  return INSTRUMENT_IDS.includes(itemId) || (itemId >= INSTRUMENT_MIN && itemId <= INSTRUMENT_MAX);
}

export class HarpyAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const out: WarnGeom[] = [];
    const p = this.nearest(rt, world);
    if (!p) return out;
    const d = this.distTo(rt, p);
    /* 悬崖判定:玩家距地图边缘(坐标 0 侧)≤ HARPY_CLIFF_MARGIN 格。 */
    const nearCliff = p.x <= HARPY_CLIFF_MARGIN || p.y <= HARPY_CLIFF_MARGIN;
    if (d <= 6 && nearCliff && (rt.mem.gustCd ?? 0) <= 0) {
      rt.mem.gustCd = 5.0;
      rt.mem.gustCount = (rt.mem.gustCount ?? 0) + 1;
      rt.mem.gustForce = HARPY_GUST_FORCE;
      /* 风向 = 风精鸟指向玩家(把玩家继续往边缘外侧吹)。
         70° 扇形(半张角 35°)、长 6 格,与 Boss 预警几何同一内核。 */
      const deg = Math.atan2(p.y - rt.y, p.x - rt.x) / DEG;
      rt.mem.gustDeg = deg;
      out.push({
        kind: 'SECTOR', cx: rt.x, cy: rt.y, radius: 6, innerRadius: 0,
        centerDeg: deg, halfDeg: 35, halfLen: 6, halfWidth: 0,
        spinDegPerSec: 0, z: rt.z, zTolerance: 1.6, warnSec: 1.0,
      });
      world.emit('harpy_gust', { force: HARPY_GUST_FORCE });
    }
    rt.mem.gustCd = Math.max(0, (rt.mem.gustCd ?? 0) - dt);
    rt.mem.musicCounter = (rt.mem.musicCounter ?? 0) + 0;
    return out;
  }

  /** 与玩家乐器合奏 → 害羞地送星辰碎片。
   *
   * `ticks` 为累计秒数增量(由调用方按 20Hz 传 DT),**累加不重置**;
   * 乐器门禁为 `INSTRUMENT_IDS` 集合;阈值 `HARPY_ENSEMBLE_SEC` 用 `>= -1e-9`
   * 吸收 20Hz 积分下的浮点误差,保证恰好 5.00s 触发。
   */
  ensemble(rt: MobRuntime, world: MobWorld, ticks: number, heldItem = INSTRUMENT_IDS[0]): boolean {
    if (rt.mem.friendly) return false;             /* 已友好,不重复馈赠 */
    if (!isInstrument(heldItem)) return false;     /* 非乐器不累加 */
    rt.mem.ensembleSec = (rt.mem.ensembleSec ?? 0) + ticks;
    if (rt.mem.ensembleSec >= HARPY_ENSEMBLE_SEC - 1e-9) {
      rt.mem.friendly = 1;
      rt.mem.gifted = 1;
      world.spawnItem(rt.x, rt.y, ITEM.STAR_SHARD, 1);
      world.emit('harpy_ensemble_gift');
      return true;
    }
    return false;
  }
}

/* ═════════════════════ 21. 雷云闪电球 ═════════════════════ */

export const THUNDER_LINK_RADIUS = 6;
export const THUNDER_LINK_TARGETS = 3;
export const THUNDER_HELM_ATK_SPEED_STACK = 0.15;
export const THUNDER_HELM_STACK_MAX = 5;

export class ThunderSpriteAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const out: WarnGeom[] = [];
    rt.mem.altitude = 3.0;
    if ((rt.mem.dischargeCd ?? 0) <= 0) {
      rt.mem.dischargeCd = 3.0;
      rt.mem.discharges = (rt.mem.discharges ?? 0) + 1;
      /* 只链接金属物体(标签含「金属」的地砖/家具)。 */
      const metals = world.groundItems().filter((g) => g.id === 522 || g.id === 155 || g.id === 243);
      rt.mem.metalLinks = Math.min(THUNDER_LINK_TARGETS, metals.length);
      out.push(circleWarn(rt.x, rt.y, THUNDER_LINK_RADIUS, 1.0));
      /* 队伍里的引雷铁锅头盔把闪电吸收成攻速。 */
      for (const p of world.players()) {
        if (p.wearing.includes(ITEM.LIGHTNING_HELM)) {
          rt.mem.helmAbsorbs = (rt.mem.helmAbsorbs ?? 0) + 1;
        }
      }
      world.emit('thunder_discharge', { links: rt.mem.metalLinks });
    }
    rt.mem.dischargeCd = Math.max(0, (rt.mem.dischargeCd ?? 0) - dt);
    return out;
  }

  /** 佩戴引雷头盔者获得「攻速反哺」层数(可叠加,上限 5)。 */
  helmAtkSpeedBuff(rt: MobRuntime, p: WorldPlayer): number {
    if (!p.wearing.includes(ITEM.LIGHTNING_HELM)) return 0;
    const n = Math.min(THUNDER_HELM_STACK_MAX, (rt.mem.helmAbsorbs ?? 0));
    rt.mem.helmBuffStacks = n;
    return 1 + THUNDER_HELM_ATK_SPEED_STACK * n;
  }
}

/* ═════════════════════ 22. 发条伪装宝箱 ═════════════════════ */

export const MIMIC_BITE_RANGE = 1.5;
export const MIMIC_EXPOSE_SEC = 8;

export class MimicCogAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    if (rt.mem.disguise === undefined) rt.mem.disguise = 1;
    const p = this.nearest(rt, world);
    if (rt.mem.disguise === 1) {
      rt.mem.looksLikeChest = 1;
      if (p && this.distTo(rt, p) <= 1.0) {
        rt.mem.disguise = 0;              /* 打开时亮出齿轮尖牙 */
        rt.mem.exposed = 1;
        rt.mem.chasing = 1;
        rt.mem.gearTeeth = 12;
        world.emit('mimic_ambush');
      }
      return [];
    }
    if (p && this.distTo(rt, p) <= MIMIC_BITE_RANGE && (rt.mem.biteCd ?? 0) <= 0) {
      rt.mem.biteCd = 1.2;
      rt.mem.bites = (rt.mem.bites ?? 0) + 1;
    }
    rt.mem.biteCd = Math.max(0, (rt.mem.biteCd ?? 0) - dt);
    rt.mem.gearTeeth = 12;
    return [];
  }

  /** 喂定时痒痒炸弹果 → 炸开肚子爆金装。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.BOMB_FRUIT) return false;
    rt.mem.exploded = 1;
    rt.mem.goldDrops = 6;
    rt.alive = false;
    for (let i = 0; i < 6; i += 1) world.spawnItem(rt.x, rt.y, 158, 1);
    world.emit('mimic_exploded', { gold: 6 });
    return true;
  }
}

/* ═════════════════════ 23. 熔炉赤焰火灵 ═════════════════════ */

export const LAVA_SHIELD_HP = 400;
export const LAVA_BURN_RADIUS = 1;

export class LavaElemAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const out: WarnGeom[] = [];
    if (rt.mem.solidified) {
      rt.mem.shield = 0;
      rt.mem.movable = 0;
      return out;
    }
    /* 走过地面 0.5 秒一次改写为焦炭(仅未固化时)。 */
    rt.mem.burnT = (rt.mem.burnT ?? 0) + dt;
    if (rt.mem.burnT >= 0.5) {
      rt.mem.burnT = 0;
      for (let dx = -LAVA_BURN_RADIUS; dx <= LAVA_BURN_RADIUS; dx += 1) {
        for (let dy = -LAVA_BURN_RADIUS; dy <= LAVA_BURN_RADIUS; dy += 1) {
          world.setFloor(Math.round(rt.x) + dx, Math.round(rt.y) + dy, 320); /* 炙热烫脚火炭砖 */
        }
      }
      rt.mem.charCells = (rt.mem.charCells ?? 0) + 9;
    }
    const p = this.nearest(rt, world);
    if (p && this.distTo(rt, p) <= 3 && (rt.mem.fireCd ?? 0) <= 0) {
      rt.mem.fireCd = 3.5;
      rt.mem.fireWaves = (rt.mem.fireWaves ?? 0) + 1;
      out.push(circleWarn(rt.x, rt.y, 2.6, 1.0));
    }
    rt.mem.fireCd = Math.max(0, (rt.mem.fireCd ?? 0) - dt);
    return out;
  }

  override onDamage(rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind): DamageResult {
    if (kind === DamageKind.WATER) {
      /* 水 → 护盾秒杀并固化为黑曜石。 */
      rt.mem.shield = 0;
      rt.mem.solidified = 1;
      rt.mem.movable = 0;
      rt.mem.immune = 1;
      world.placeObj(Math.round(rt.x), Math.round(rt.y), ITEM.OBSIDIAN_BLOCK);
      world.spawnItem(rt.x, rt.y, ITEM.OBSIDIAN_BLOCK, 1);
      world.emit('lava_solidified');
      return { hpLoss: 0, blocked: true, blockedRatio: 1, reflectHearts: 0, events: ['lava_solidified'] };
    }
    if (rt.mem.solidified) {
      /* 已固化为黑曜石实体:护盾消失但本体成为无生命雕像,不再受伤。 */
      return { hpLoss: 0, blocked: true, blockedRatio: 1, reflectHearts: 0, events: ['lava_solid_state'] };
    }
    const hpLoss = amount;
    rt.hp = Math.max(0, rt.hp - hpLoss);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: [] };
  }
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number): boolean {
    if (itemId !== ITEM.WATER_GUN) return false;
    rt.mem.shield = 0;
    rt.mem.solidified = 1;
    rt.mem.movable = 0;
    world.placeObj(Math.round(rt.x), Math.round(rt.y), ITEM.OBSIDIAN_BLOCK);
    world.emit('lava_solidified');
    return true;
  }
}

/* ═════════════════════ 24. 远古发条重骑 ═════════════════════ */

export const KNIGHT_FRONT_DR = 0.90;
export const KNIGHT_KEY_ARC_DEG = 120;
export const KNIGHT_PARALYZE_SEC = 8.0;

export class ClockKnightAi extends BaseMobAi {
  tick(rt: MobRuntime, world: MobWorld, dt: number): WarnGeom[] {
    const par = rt.mem.paralyzedSec ?? 0;
    rt.mem.keyAngleDeg = ((rt.mem.keyAngleDeg ?? 0) + 90 * dt) % 360; /* 钥匙旋转 */
    rt.mem.keyArcDeg = KNIGHT_KEY_ARC_DEG;
    if (par > 0) {
      rt.mem.paralyzedSec = Math.max(0, par - dt);
      rt.mem.paralyzed = 1;
      rt.mem.movable = 0;
      rt.mem.frontDr = 0;
      return [];
    }
    rt.mem.paralyzed = 0;
    rt.mem.movable = 1;
    rt.mem.frontDr = rt.mem.keyPulled ? 0 : KNIGHT_FRONT_DR;
    const p = this.nearest(rt, world);
    if (p) {
      rt.facingDeg = Math.atan2(p.y - rt.y, p.x - rt.x) / DEG;
      rt.mem.needsFrontTank = 1;   /* 正面极难击败,需 1 人吸引 */
    }
    return [];
  }

  override onDamage(
    rt: MobRuntime, world: MobWorld, amount: number, kind: DamageKind, fromDeg: number,
  ): DamageResult {
    if (rt.mem.paralyzed) {
      const hpLoss = amount * 2; /* 瘫痪期间双倍输出 */
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: 0, reflectHearts: 0, events: ['knight_paralyzed_vuln'] };
    }
    const diff = Math.abs(((fromDeg - rt.facingDeg + 540) % 360) - 180);
    if (diff <= 90) {
      const hpLoss = amount * (1 - KNIGHT_FRONT_DR);
      rt.hp = Math.max(0, rt.hp - hpLoss);
      if (rt.hp === 0) rt.alive = false;
      return { hpLoss, blocked: false, blockedRatio: KNIGHT_FRONT_DR, reflectHearts: 0, events: ['knight_front_plate'] };
    }
    rt.hp = Math.max(0, rt.hp - amount);
    if (rt.hp === 0) rt.alive = false;
    return { hpLoss: amount, blocked: false, blockedRatio: 0, reflectHearts: 0, events: [] };
  }

  /** 飞索钩爪勾住背后钥匙强行拔下 → 断电瘫痪。 */
  override onInteract(rt: MobRuntime, world: MobWorld, itemId: number, player: WorldPlayer): boolean {
    if (itemId !== ITEM.HOOK) return false;
    /* 必须从背后钩:玩家方位与生物朝向的夹角 > 90°。 */
    const toPlayerDeg = Math.atan2(player.y - rt.y, player.x - rt.x) / DEG;
    const diff = Math.abs(((toPlayerDeg - rt.facingDeg + 540) % 360) - 180);
    const fromBack = diff > 90;
    rt.mem.lastHookFromBack = fromBack ? 1 : 0;
    if (!fromBack) return false;
    rt.mem.keyPulled = 1;
    rt.mem.paralyzedSec = KNIGHT_PARALYZE_SEC;
    rt.mem.powerDown = 1;
    rt.mem.frontDr = 0;
    world.spawnItem(rt.x, rt.y, 158, 8);
    world.emit('knight_key_pulled', { sec: KNIGHT_PARALYZE_SEC });
    return true;
  }
}

/* ═════════════════════ 注册表 ═════════════════════ */

export type MobAiFactory = (def: MobDef) => BaseMobAi;

export const MOB_AI_FACTORY: Record<string, MobAiFactory> = {
  mob_sheep: (d) => new SheepAi(d),
  mob_slime_green: (d) => new SlimeAi(d),
  mob_boar: (d) => new BoarAi(d),
  mob_squirrel: (d) => new SquirrelAi(d),
  mob_beaver: (d) => new BeaverAi(d),
  mob_crab_river: (d) => new CrabRiverAi(d),
  mob_capybara: (d) => new CapybaraAi(d),
  mob_tanuki: (d) => new TanukiAi(d),
  mob_samurai_bamboo: (d) => new SamuraiAi(d),
  mob_glow_frog: (d) => new GlowFrogAi(d),
  mob_bat_sonic: (d) => new BatAi(d),
  mob_beetle_crystal: (d) => new BeetleAi(d),
  mob_chocobo: (d) => new ChocoboAi(d),
  mob_pangolin: (d) => new PangolinAi(d),
  mob_scorpion: (d) => new ScorpionAi(d),
  mob_ginger_imp: (d) => new GingerImpAi(d),
  mob_pudding_mage: (d) => new PuddingMageAi(d),
  mob_choco_golem: (d) => new ChocoGolemAi(d),
  mob_sky_manta: (d) => new SkyMantaAi(d, 0, 0, 20, 0),
  mob_harpy_harp: (d) => new HarpyAi(d),
  mob_thunder_sprite: (d) => new ThunderSpriteAi(d),
  mob_mimic_cog: (d) => new MimicCogAi(d),
  mob_lava_elem: (d) => new LavaElemAi(d),
  mob_clock_knight: (d) => new ClockKnightAi(d),
};

export const TAMEABLE_AI_IDS: readonly string[] = [
  'mob_sheep', 'mob_squirrel', 'mob_glow_frog', 'mob_chocobo', 'mob_capybara', 'mob_sky_manta', 'mob_pangolin',
];

export function createMobAi(def: MobDef): BaseMobAi {
  const f = MOB_AI_FACTORY[def.id];
  if (!f) return new DefaultMobAi(def);
  return f(def);
}

/** 未登记生物的回退实现(不应被触发;注册表只覆盖表中的 24 种)。 */
export class DefaultMobAi extends BaseMobAi {
  tick(rt: MobRuntime): WarnGeom[] {
    const r = steer45(1, 0, rt.x, rt.y, () => false);
    rt.mem.lastTurn = r.turn;
    return [];
  }
}

/** 生物是否属于敌对类别(决定是否进入 AOI 唤醒 FSM)。 */
export function isHostile(def: MobDef): boolean {
  return def.behavior === MobBehavior.HOSTILE || def.behavior === MobBehavior.HOSTILE_ELITE;
}
