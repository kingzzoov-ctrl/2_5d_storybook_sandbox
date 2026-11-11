/**
 * WS-FND-04:玩家生命值 —— 生物攻击的结算目标。
 *
 * ## 为什么这是缺的那一层
 *
 * 实测确认的链路断点:
 *
 * | 事实 | 后果 |
 * | :--- | :--- |
 * | `MobWorld` 接口**没有**任何「伤害玩家」的方法 | 16 只敌对/捣蛋生物的攻击无处结算 |
 * | `WorldPlayer` **没有** `hp` 字段 | 玩家血量从未存在过 |
 * | `world_sim.ts` 里 `hp` 出现 **0** 次、`damage` 出现 **0** 次 | 编排层没有任何生命值概念 |
 * | 25 个 AI 里的 `rt.hp` **全是生物自己**的血 | 没有一处改玩家血量 |
 * | AI 产出的预警几何(`WarnGeom`,带 `radius`/`warnSec`/`z`)在生产真的产生(400 帧 220 个) | 但**没有任何地方结算它们** |
 *
 * 也就是说:**AI 已经告诉我们「将要打哪里、打多大范围、多久后生效」,
 * 只是没人去结算。** `resolveTelegraphHit(g, px, py, pz, t)` 是 WS-04 提供的
 * 现成纯函数,所以这一层**不需要改 `MobWorld` 接口**,只需在编排层:
 *
 * 1. 给玩家一个 `hp`;
 * 2. 每帧拿活跃生物的 `warns` 与玩家位置做判定;
 * 3. 命中后扣血并发出事件。
 *
 * ## 设计要点
 *
 * **不改冻结层**:`WorldPlayer` 是 `behaviors.ts`(WS-04)的接口。
 * 加 `hp` 字段会让 WS-04 的 55 条断言与它的假 `MobWorld` 全部要改。
 * 所以玩家血量由**编排层**持有(`PlayerVitals`),`WorldPlayer` 视图不带血量
 * —— 这也符合职责:AI 只需要知道「玩家在哪、在做什么」,不需要知道剩多少血。
 *
 * **预警到期才结算,不是碰到就打**:`WarnGeom.warnSec` 是预警时长,
 * AI 造它的时候就决定了「多久后生效」。这给了玩家反应窗口,是手册
 * §4.2 的明确设计(TELEGRAPH_ATTACK 三态机的一部分)。
 */

import type { WarnGeom } from '../mobs/geometry.ts';

/* ═══════════════════════ 1. 常量 ═══════════════════════ */

/**
 * 玩家初始最大生命值。
 *
 * 取 100:手册未硬性规定玩家血量(它规定的是伤害公式),而 100 使
 * 「一刀掉多少」与百分比直觉一致。生物伤害量级见 `MOB_HIT_*`。
 */
export const PLAYER_BASE_HP = 100;

/**
 * 生物一次攻击的基础伤害(按其等级缩放)。
 *
 * 公式:`MobHit = round(MOB_HIT_BASE + MOB_HIT_PER_LEVEL × (level − 1))`
 *
 * 取 `BASE = 6`、`PER_LEVEL = 2`:
 *   - 1 级绵羊(不攻击)~ 2 级果冻怪 → 8
 *   - 4 级野猪 → 12
 *   - 8 级(取最高级生物)→ 20
 *
 * 与手册的平衡意图一致:敌对生物单次打掉玩家 8%~20% 血量,
 * 即「被围攻 5~12 次倒下」——给了逃跑窗口,但站着不动会死。
 */
export const MOB_HIT_BASE = 6;
/** 每高 1 级增加的伤害。 */
export const MOB_HIT_PER_LEVEL = 2;

/**
 * 生物攻击玩家时的**命中宽容半径**(格)。
 *
 * `WarnGeom.radius` 已是 AI 定的范围,这里额外加一点宽容,
 * 避免「明明站在圈内边缘却判定未命中」的挫败感。取 0.25(玩家半径的一半以下)。
 *
 * 用「半径 + 宽容」而非「严格 insideWarn」:后者在圆边缘会有
 * 浮点边界导致的时有时无,而玩家无法感知差 1 厘米的区别。
 */
export const MOB_HIT_RADIUS_SLACK = 0.25;

/** 受击后的无敌时长(秒)。防止同一帧多个预警重复打中同一玩家。 */
export const PLAYER_IFRAME_SEC = 0.35;

/**
 * 饥饿/自然恢复:每秒钟回复的血量(仅在未被攻击时)。
 *
 * 取 1.0:受伤后约 100 秒回满 —— 慢到不鼓励站着硬抗,快到不用回城。
 */
export const PLAYER_REGEN_PER_SEC = 1.0;

/** 上次受伤后多久开始回血(秒)。 */
export const PLAYER_REGEN_DELAY_SEC = 6.0;

/* ═══════════════════════ 2. 类型 ═══════════════════════ */

/** 一个玩家的生命状态。 */
export interface PlayerVitals {
  id: string;
  hp: number;
  maxHp: number;
  /** 无敌剩余秒数(>0 时不受伤)。 */
  iframeSec: number;
  /** 距上次受伤的秒数(用于回血延迟)。 */
  sinceHurtSec: number;
  /** 累计受到的伤害(观测用)。 */
  totalTaken: number;
  /** 累计被命中次数。 */
  hitCount: number;
  /** 是否已倒下。 */
  downed: boolean;
}

/** 一次生物攻击的结算结果。 */
export interface MobHitResult {
  /** 目标玩家 ID。 */
  playerId: string;
  /** 攻击者生物 ID。 */
  attackerId: string;
  /** 原始伤害(按等级算出的)。 */
  rawDamage: number;
  /** 实际扣除的血量(0 表示被无敌/已倒下挡掉)。 */
  applied: number;
  /** 是否被无敌帧挡下。 */
  blockedByIframe: boolean;
  /** 是否因此倒下。 */
  downed: boolean;
  /** 命中时玩家位置与预警中心距离(诊断用)。 */
  distance: number;
}

/** 一帧的结算统计。 */
export interface VitalsFrameStats {
  /** 检查了多少个预警几何。 */
  warnsChecked: number;
  /** 命中的次数。 */
  hits: number;
  /** 被无敌帧挡下的次数。 */
  blocked: number;
  /** 本帧对玩家造成的总伤害。 */
  totalDamage: number;
  /** 本帧倒下的玩家数。 */
  downed: number;
}

/* ═══════════════════════ 3. 计算 ═══════════════════════ */

/**
 * 按生物等级算出它的一次攻击伤害。
 *
 * **纯函数,不读生物状态**:这样测试可以直接断言数值,不必构造生物。
 * 与手册的 `bossScaledHp` 同一思路 —— 等级是唯一的缩放维度。
 */
export function mobHitDamage(level: number, mul = 1.0): number {
  const lv = Math.max(1, Math.trunc(level));
  const base = MOB_HIT_BASE + MOB_HIT_PER_LEVEL * (lv - 1);
  return Math.max(1, Math.round(base * mul));
}

/**
 * 判断一个预警几何是否命中某玩家。
 *
 * 判定分两步:
 *   1. **平面**:按 `WarnGeom.kind` 用对应几何判玩家 (x,y) 是否在内,
 *      外向半径放宽 `MOB_HIT_RADIUS_SLACK` 以吸收浮点边界;
 *   2. **高度**:玩家的 `z` 必须落在 `[z − zTolerance, z + zTolerance]`。
 *      这一条使「云鲸高空吐息」打不到地面玩家,而「站在台上」能被打到。
 *
 * **`SECTOR` 与 `RECT` 是带方向的**,必须用 `centerDeg` 旋转后再判。
 * 我最初按**轴对齐**判 RECT(`|dx| <= halfWidth && |dy| <= halfLen`)——
 * 那是错的:野猪的冲锋走廊实测 `centerDeg = 26.57°`,玩家明明站在冲锋
 * 路径上(距中心 0.76 格)却被判未命中,于是「野猪冲过来了但不疼」。
 * 轴对齐只是在 `centerDeg = 0/90/180/270` 时偶然正确。
 */
export function warnHitsPlayer(g: WarnGeom, px: number, py: number, pz: number): boolean {
  if (Math.abs(pz - g.z) > g.zTolerance) return false;
  const dx = px - g.cx;
  const dy = py - g.cy;
  const dist = Math.hypot(dx, dy);
  switch (g.kind) {
    case 'CIRCLE':
      return dist <= g.radius + MOB_HIT_RADIUS_SLACK;
    case 'RING':
      return (
        dist <= g.radius + MOB_HIT_RADIUS_SLACK && dist >= Math.max(0, g.innerRadius - MOB_HIT_RADIUS_SLACK)
      );
    case 'SECTOR': {
      if (dist > g.radius + MOB_HIT_RADIUS_SLACK) return false;
      return Math.abs(angleDiffDeg(headingOfPlayer(g, dx, dy), g.centerDeg)) <= g.halfDeg;
    }
    case 'RECT': {
      /* 旋转矩形:把玩家相对位置投到矩形的本地轴上再判。
         `centerDeg` 是矩形长轴方向;本地 x 沿长轴(halfLen),本地 y 垂直(halfWidth)。
         注意:矩形的「长」是 `halfLen`,「宽」是 `halfWidth` ——
         我最初把两者对调(`|dx| <= halfWidth`)会让细长走廊退化成一个小方块。 */
      const rad = (g.centerDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const localX = dx * cos + dy * sin; /* 沿长轴 */
      const localY = -dx * sin + dy * cos; /* 垂直长轴 */
      return (
        Math.abs(localX) <= g.halfLen + MOB_HIT_RADIUS_SLACK &&
        Math.abs(localY) <= g.halfWidth + MOB_HIT_RADIUS_SLACK
      );
    }
    case 'POINTER': {
      /* 指针形:从中心指向 `centerDeg`,长度 `halfLen`,横向 `halfWidth` 的射线。 */
      const rad = (g.centerDeg * Math.PI) / 180;
      const along = dx * Math.cos(rad) + dy * Math.sin(rad);
      const across = -dx * Math.sin(rad) + dy * Math.cos(rad);
      /* 背后不算命中:`along` 必须为正 */
      return (
        along >= 0 &&
        along <= g.halfLen + MOB_HIT_RADIUS_SLACK &&
        Math.abs(across) <= g.halfWidth + MOB_HIT_RADIUS_SLACK
      );
    }
    default:
      return false;
  }
}

/** 玩家相对预警中心的方位角(度,−180..180)。 */
function headingOfPlayer(g: WarnGeom, dx: number, dy: number): number {
  void g;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** 角度差归一到 −180..180。 */
function angleDiffDeg(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * 说明一个预警为何未命中。
 *
 * **必须按 `kind` 分别解释**:早先只报「距离 vs radius」,于是对 RECT
 * 会输出自相矛盾的「距离 1.056 > 半径 3」—— 一句话里数字互相打架的说法
 * 比不解释更糟:它会让人去查半径,而问题在方向。
 */
export function explainMiss(g: WarnGeom, px: number, py: number, pz: number): string {
  const dz = Math.abs(pz - g.z);
  if (dz > g.zTolerance) {
    return `高度不符:玩家 z=${pz},预警 z=${g.z} ±${g.zTolerance}(差 ${dz.toFixed(2)})`;
  }
  const dx = px - g.cx;
  const dy = py - g.cy;
  const dist = Math.hypot(dx, dy);
  switch (g.kind) {
    case 'CIRCLE':
      return `圆未命中:距离 ${dist.toFixed(3)} > 半径 ${g.radius}(+${MOB_HIT_RADIUS_SLACK})`;
    case 'RING':
      return dist > g.radius + MOB_HIT_RADIUS_SLACK
        ? `环未命中:距离 ${dist.toFixed(3)} 超出外径 ${g.radius}`
        : `环未命中:距离 ${dist.toFixed(3)} 落在内径 ${g.innerRadius} 之内(环内部是空的)`;
    case 'SECTOR': {
      const deg = headingOfPlayer(g, dx, dy);
      const diff = angleDiffDeg(deg, g.centerDeg);
      if (dist > g.radius + MOB_HIT_RADIUS_SLACK) return `扇形未命中:距离 ${dist.toFixed(3)} 超出半径 ${g.radius}`;
      return `扇形未命中:方位差 ${diff.toFixed(1)}° > 半角 ${g.halfDeg}°(玩家方位 ${deg.toFixed(1)}°,扇形朝 ${g.centerDeg.toFixed(1)}°)`;
    }
    case 'RECT': {
      const rad = (g.centerDeg * Math.PI) / 180;
      const localX = dx * Math.cos(rad) + dy * Math.sin(rad);
      const localY = -dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(localX) > g.halfLen + MOB_HIT_RADIUS_SLACK) {
        return `矩形未命中:沿长轴 ${Math.abs(localX).toFixed(3)} > 半长 ${g.halfLen}`;
      }
      return `矩形未命中:垂直长轴 ${Math.abs(localY).toFixed(3)} > 半宽 ${g.halfWidth}(玩家偏出走廊)`;
    }
    case 'POINTER': {
      const rad = (g.centerDeg * Math.PI) / 180;
      const along = dx * Math.cos(rad) + dy * Math.sin(rad);
      if (along < 0) return `指针未命中:玩家在攻击方向背后(沿轴 ${along.toFixed(3)} < 0)`;
      return `指针未命中:沿轴 ${along.toFixed(3)} > 半长 ${g.halfLen}`;
    }
    default:
      return `未知形状 ${String(g.kind)}`;
  }
}

/* ═══════════════════════ 4. 生命值系统 ═══════════════════════ */

/**
 * 玩家生命值管理器。
 *
 * 由编排层持有(`WorldSim.vitals`),与 `AoiManager` / `MobHost` 并列。
 * 不放进 `WorldPlayer`(那是 WS-04 的冻结接口)。
 */
export class VitalsSystem {
  private readonly players = new Map<string, PlayerVitals>();
  /** 一帧内已被结算过的 (attackerId, playerId) 对,防同一攻击多段命中。 */
  private readonly hitThisFrame = new Set<string>();
  private readonly maxHp: number;
  /** 累计统计。 */
  readonly totals = { hits: 0, blocked: 0, damage: 0, downed: 0, warnsChecked: 0 };

  /*
   * 不用构造器参数属性(`constructor(private readonly maxHp: number)`)——
   * Node 24 的 strip-only 模式**不支持**它(`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`),
   * 因为那会生成运行时代码而非仅擦除类型。
   * 注意 `node --check` 对它**不报错**(只做语法解析),所以这个错误
   * 只在真正 import 时才暴露 —— 与 enum / namespace 同类。
   */
  constructor(maxHp: number = PLAYER_BASE_HP) {
    this.maxHp = maxHp;
  }

  /** 登记一个玩家(满血)。 */
  register(id: string): PlayerVitals {
    const v: PlayerVitals = {
      id,
      hp: this.maxHp,
      maxHp: this.maxHp,
      iframeSec: 0,
      sinceHurtSec: PLAYER_REGEN_DELAY_SEC,
      totalTaken: 0,
      hitCount: 0,
      downed: false,
    };
    this.players.set(id, v);
    return v;
  }

  /** 移除一个玩家。 */
  unregister(id: string): boolean {
    return this.players.delete(id);
  }

  /** 取生命状态(只读用途)。 */
  get(id: string): PlayerVitals | null {
    return this.players.get(id) ?? null;
  }

  /** 全部玩家 ID(顺序稳定)。 */
  ids(): string[] {
    return [...this.players.keys()].sort();
  }

  get size(): number {
    return this.players.size;
  }

  /** 复活(满血,清无敌)。 */
  revive(id: string, hp?: number): boolean {
    const v = this.players.get(id);
    if (!v) return false;
    v.hp = hp ?? v.maxHp;
    v.downed = false;
    v.iframeSec = 0;
    v.sinceHurtSec = PLAYER_REGEN_DELAY_SEC;
    return true;
  }

  /**
   * 开始结算一帧。清空「本帧已命中」集合。
   *
   * **必须在每次结算前调用**:否则同一生物的攻击会在后续帧里
   * 因为集合残留而不再命中,表现是「第一次能打到,之后永远打不到」。
   */
  beginFrame(): void {
    this.hitThisFrame.clear();
  }

  /**
   * 结算一次攻击。
   *
   * `oncePerFrame` 的键是 `attackerId` —— 同一生物在同一帧的多个预警
   * 只算一次伤害。理由:AI 可能同时产出多个重叠几何(如雷云球的
   * 链接环 + 落雷),叠算会让伤害凭空翻倍。
   * 若确实需要多段伤害,应由 AI 用不同 `kind` 或分帧表达。
   */
  applyHit(
    attackerId: string,
    playerId: string,
    level: number,
    mul = 1.0,
    distance = 0,
  ): MobHitResult {
    const v = this.players.get(playerId);
    const raw = mobHitDamage(level, mul);
    const base: MobHitResult = {
      playerId,
      attackerId,
      rawDamage: raw,
      applied: 0,
      blockedByIframe: false,
      downed: false,
      distance,
    };
    if (!v) return base;
    if (v.downed) return base;

    /* 同一生物同一帧只打一次 */
    const key = `${attackerId}→${playerId}`;
    if (this.hitThisFrame.has(key)) return base;
    this.hitThisFrame.add(key);

    /* 无敌帧 */
    if (v.iframeSec > 0) {
      base.blockedByIframe = true;
      this.totals.blocked += 1;
      return base;
    }

    v.hp = Math.max(0, v.hp - raw);
    v.iframeSec = PLAYER_IFRAME_SEC;
    v.sinceHurtSec = 0;
    v.totalTaken += raw;
    v.hitCount += 1;
    base.applied = raw;

    if (v.hp === 0) {
      v.downed = true;
      base.downed = true;
      this.totals.downed += 1;
    }
    this.totals.hits += 1;
    this.totals.damage += raw;
    return base;
  }

  /** 治疗(料理/药水/队友技能)。 */
  heal(id: string, amount: number): number {
    const v = this.players.get(id);
    if (!v) return 0;
    if (v.downed) return 0;
    const before = v.hp;
    v.hp = Math.min(v.maxHp, v.hp + Math.max(0, amount));
    return v.hp - before;
  }

  /**
   * 推进计时器:无敌帧倒计时与延迟回血。
   *
   * 回血**在受伤后延迟 `PLAYER_REGEN_DELAY_SEC` 才开始** ——
   * 否则「被打的同一秒也在回血」会让伤害量看起来比实际小,
   * 平衡调参时会得出错误结论。
   */
  stepTimers(dt: number): void {
    for (const v of this.players.values()) {
      if (v.downed) {
        /* 倒下的玩家不回血、不走无敌;由外部复活流程处理 */
        v.iframeSec = 0;
        continue;
      }
      if (v.iframeSec > 0) v.iframeSec = Math.max(0, v.iframeSec - dt);
      v.sinceHurtSec += dt;
      if (
        v.sinceHurtSec >= PLAYER_REGEN_DELAY_SEC &&
        v.iframeSec <= 0 &&
        v.hp < v.maxHp
      ) {
        const healAmount = PLAYER_REGEN_PER_SEC * dt;
        v.hp = Math.min(v.maxHp, v.hp + healAmount);
      }
    }
  }

  /** 不可变摘要,便于写进快照。 */
  snapshot(): { players: number; hits: number; damage: number; downed: number } {
    return {
      players: this.players.size,
      hits: this.totals.hits,
      damage: Math.round(this.totals.damage),
      downed: this.totals.downed,
    };
  }
}

/* ═══════════════════════ 6. 事件型伤害通道 ═══════════════════════ */

/**
 * 生物用**事件**表达的伤害(与预警几何并列的第二条通道)。
 *
 * ## 为什么有两条通道
 *
 * 25 个 AI 的威胁表达有两种形态,实测确认:
 *
 * | 通道 | 形态 | 实例 | 触发条件 |
 * | :--- | :--- | :--- | :--- |
 * | 预警几何 | `WarnGeom`(范围 + 时长) | 野猪冲锋、岩元素火环、雷电精灵放电 | 进入攻击态 |
 * | 事件 | `emit('xxx')` | `scorpion_ambush` 伏击、`pangolin_wall_stun` 滚撞 | 状态切换 |
 *
 * 前者是「将要打这片区域」,后者是「就在此刻发生了」。两者都必须结算,
 * 否则蝎子从沙下钻出来咬你一下**不会掉血** —— 而它不报错。
 *
 * | 事件 | 伤害 | 触发半径 | 设计依据 |
 * | :--- | :--- | :--- | :--- |
 * | `scorpion_ambush` | 1.5× 等级伤害 | 2.0 | 沙下伏击是突袭,伤害高于普攻 |
 * | `pangolin_wall_stun` | 1.0× | 1.5 | 撞墙自晕,玩家若在旁被波及 |
 * | `tanuki_ambush` | 0 | — | 只扔迷雾果致盲,**无伤害**(纯捣蛋) |
 */
export const EVENT_STRIKE_RULES: readonly {
  kind: string;
  /** 伤害倍率(相对 `mobHitDamage(level)`)。 */
  mul: number;
  /** 触发半径(格),以生物自身位置为圆心。 */
  radius: number;
}[] = [
  { kind: 'scorpion_ambush', mul: 1.5, radius: 2.0 },
  { kind: 'pangolin_wall_stun', mul: 1.0, radius: 1.5 },
];

/** 按事件名查规则;无则返回 null(该事件不造成伤害)。 */
export function eventStrikeRule(kind: string): { mul: number; radius: number } | null {
  for (const r of EVENT_STRIKE_RULES) if (r.kind === kind) return { mul: r.mul, radius: r.radius };
  return null;
}

/**
 * 从一帧的 `MobTickResult` 里提取「事件型攻击」。
 *
 * 生物的位置取自宿主运行时(事件不带坐标 —— 事件名本身只表达「发生了什么」)。
 * 半径判定与预警几何共用 `MOB_HIT_RADIUS_SLACK`,使两条通道的宽容一致。
 */
export function collectEventStrikes(
  events: readonly { source: string; kind: string }[],
  posOf: (id: string) => { x: number; y: number } | null,
  levelOf: (id: string) => number,
): PendingStrike[] {
  const out: PendingStrike[] = [];
  for (const e of events) {
    const rule = eventStrikeRule(e.kind);
    if (rule === null) continue;
    const pos = posOf(e.source);
    if (pos === null) continue;
    out.push({
      attackerId: e.source,
      attackerLevel: levelOf(e.source),
      /* 事件型没有方向,造一个**圆形**几何:它不经过 `warnHitsPlayer` 的
         形状判定,只复用「半径 + 高度」两件事 —— 但为了走同一条结算路径,
         这里仍造一个合法几何,而不是给结算加分支。 */
      warn: {
        kind: 'CIRCLE',
        cx: pos.x,
        cy: pos.y,
        radius: rule.radius,
        innerRadius: 0,
        centerDeg: 0,
        halfDeg: 0,
        halfLen: 0,
        halfWidth: 0,
        spinDegPerSec: 0,
        z: 0,
        zTolerance: 1.6,
        warnSec: 0,
      },
      mul: rule.mul,
    });
  }
  return out;
}

/* ═══════════════════════ 5. 编排层结算入口 ═══════════════════════ */

/** 一个待结算的攻击:发起者 + 其预警几何。 */
export interface PendingStrike {
  attackerId: string;
  attackerLevel: number;
  warn: WarnGeom;
  /** 伤害倍率(Boss 或精英可调)。 */
  mul?: number;
}

/**
 * 把一批待结算攻击与玩家位置对照,产出命中列表。
 *
 * **纯函数**:不读全局状态、不修改入参。这样「哪个预警打中了谁」
 * 可以脱离完整世界单测,且编排层能先算出全部命中再统一提交
 * (避免「边判边改」导致后续判定读到已变的位置)。
 *
 * @param strikes 待结算的攻击
 * @param players 玩家位置(只读)
 * @param blockedKeys 本帧已用掉的 `attacker→player` 键(防重复)
 */
export function resolveStrikes(
  strikes: readonly PendingStrike[],
  players: readonly { id: string; x: number; y: number; z: number }[],
  blockedKeys?: ReadonlySet<string>,
  iframePlayers?: ReadonlySet<string>,
): { results: MobHitResult[]; warnsChecked: number } {
  const results: MobHitResult[] = [];
  const used = new Set<string>(blockedKeys ?? []);
  let checked = 0;

  for (const s of strikes) {
    checked += 1;
    for (const p of players) {
      if (!warnHitsPlayer(s.warn, p.x, p.y, p.z)) continue;
      const key = `${s.attackerId}→${p.id}`;
      if (used.has(key)) continue;
      used.add(key);
      const raw = mobHitDamage(s.attackerLevel, s.mul ?? 1.0);
      const isIframe = iframePlayers?.has(p.id) ?? false;
      results.push({
        playerId: p.id,
        attackerId: s.attackerId,
        rawDamage: raw,
        applied: isIframe ? 0 : raw,
        blockedByIframe: isIframe,
        downed: false, /* 由 VitalsSystem 判定 */
        distance: Math.hypot(p.x - s.warn.cx, p.y - s.warn.cy),
      });
    }
  }
  return { results, warnsChecked: checked };
}