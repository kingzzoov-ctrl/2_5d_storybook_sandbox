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
/* ★ 等级上界必须**从冻结层内容派生**(裁决 5),不许在本文件里手写数字。
   import 的是**内容表**本身,不是"抄一个数过来" —— 见 `CONTENT_MAX_MOB_LEVEL`。 */
import { MOB_LIST } from '../../../shared/constants/mobs.ts';
import { BOSS_LIST } from '../../../shared/constants/bosses.ts';

/* ═══════════════════════ 1. 常量 ═══════════════════════ */

/**
 * 玩家最大生命值的**缺省(兜底)**,**不是权威**。
 *
 * ## ★ 裁决(ARCH-GAPS「未决」第 1 条,已下):权威只在 `progression`
 *
 * ```
 * 权威      PlayerProgress.maxHp  =  statsAtLevel(level).maxHp   ← 唯一真相源
 * 落点      VitalsSystem.syncMaxHp(id, derivedMaxHp)             ← 逐玩家写入
 * 本常量    「还没进入成长系统 / 还没同步过等级」时的初始值        ← 降级为缺省
 * ```
 * ⇒ 等级 30 的权威上限**不是**本常量,而是派生值(当前内容 = 535)。
 * ⇒ 温泉「+30% 生命上限」这类乘区**乘在派生值上**:`WorldSim.maxHpForLevel`
 *   (上限的**唯一**算子)先算 `statsAtLevel(level).maxHp + hpFlat`,再套
 *   `maxHpMulOf`,结果经 `syncMaxHp` 落到 `v.maxHp` —— 不乘在本常量上。
 *
 * ## 为什么仍保留 100
 *
 * 取 100:手册未硬性规定玩家血量(它规定的是伤害公式),而 100 使
 * 「一刀掉多少」与百分比直觉一致。生物伤害量级见 `MOB_HIT_*`。
 * 它同时是 `new VitalsSystem()` 无参时的值 —— 测试夹具与 `demo` 都靠它。
 */
export const PLAYER_BASE_HP = 100;

/**
 * 冻结层内容里**生物等级的上界**(派生值,不是手写常量)。
 *
 * ## 为什么派生,而不是直接写 30
 *
 * 它是 `mobHitDamage` 的**上界口径**:手写数字的唯一后果是
 * 「下一个人加了更高级的生物,伤害上界却还是旧值」——
 * 这种漂移**不报错**,只会在某天悄悄把合法伤害钳掉(或放过荒谬值)。
 * 派生自 `MOB_LIST` / `BOSS_LIST` 的 `level` 字段 ⇒ 改内容即改上界。
 *
 * 实测(当前内容):`MOB_LIST` 24 项 level 1..25、`BOSS_LIST` 8 项 level 5..30
 * ⇒ 本值 = 30。`tests/WS-10.test.ts` 有一条断言把这个值钉住 ——
 * 内容改动时它会红,提醒你复核这里的口径(而不是让口径悄悄过期)。
 */
export const CONTENT_MAX_MOB_LEVEL = Math.max(
  ...MOB_LIST.map((m) => m.level),
  ...BOSS_LIST.map((b) => b.level),
);

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

/**
 * 上次受伤后多久开始回血(秒)。
 */
export const PLAYER_REGEN_DELAY_SEC = 6.0;

/* ═════════════════ 1b. 元素抗性 / 致盲(D4 / D5)═════════════════ */

/**
 * **无抗性**时的元素折算系数(乘 1 = 原样)。
 *
 * ## 为什么缺省是 1.0 而不是别的
 *
 * 抗性表是**逐元素**的乘区:`raw = mobHitDamage(level, mul) × resistMul`。
 * 缺省 1.0 使「没有登记抗性的玩家」与**修前逐字段相同** —— 这是 D4 接入
 * 时唯一安全的缺省:否则老玩家凭空吃到一个没被裁决过的减伤。
 */
export const ELEMENT_RESIST_NEUTRAL = 1.0;

/**
 * 元素抗性系数的合法上界(乘区,不是加值)。
 *
 * 语义:`0` = 完全免疫该元素,`1` = 无抗性,`>1` = 易伤。
 * 上界取 2.0(易伤至多翻倍)—— 与 `MAX_CRIT_DMG = 3.0` 同族:给一个宽松的
 * **设计上界**,让「荒谬值」被夹住而不是流进血量。下界取 0(免疫是合法状态)。
 */
export const MAX_ELEMENT_RESIST_MUL = 2.0;

/**
 * 致盲时**视野半径**的倍率(D5 的「视野」那一半)。
 *
 * ## 为什么这个数需要一个名字与出处
 *
 * 「致盲要影响视野」是 D5 的要求,但手册没有给倍率。取 0.5 的理由是它
 * **可被观测**:视野半径恰好减半 ⇒ 断言能用「减半」这个关系而不是某个绝对值
 * 钉住它(绝对值会随 AOI 半径改动而漂)。改这个数需要一次玩法裁决。
 */
export const BLIND_VIEW_MUL = 0.5;
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
  /**
   * 致盲**剩余秒数**(D5)。>0 ⇒ 命中与视野按 `vitals.ts` 的两处口径折算。
   *
   * 与 `mobs/behaviors.ts` 的 `rt.mem.blindSec` **不是同一份**:那是**生物**
   * 被致盲(它的 AI 读自己的 mem),这里存**玩家**的状态。两者同名同义、不同主体
   * ——正是 D5 记录的缺口:此前只有生物那一侧存在。
   */
  blindSec: number;
  /**
   * 被 Boss 技能**定住**的剩余秒数(D3:冻结/麻痹)。
   *
   * 与 `blindSec` 分开的理由与 `blindSec` 和生物 `mem.blindSec` 分开同理:
   * 「看不见」与「动不了」是两个机制,合成一个字段就再也分不开。
   */
  stunnedSec: number;
}

/** 一次生物攻击的结算结果。 */
export interface MobHitResult {
  /** 目标玩家 ID。 */
  playerId: string;
  /** 攻击者生物 ID。 */
  attackerId: string;
  /**
   * 抗性**折算前**的伤害(= `mobHitDamage(level, mul)`)。
   *
   * 保留它是为了让「抗性到底改了多少」可被断言,而不是只能看见折算后的 `rawDamage`。
   */
  rawBeforeResist: number;
  /** 本次结算用的元素(D4)。 */
  element: string;
  /** 该元素对该玩家的抗性系数(1.0 = 无抗性)。 */
  resistMul: number;
  /** 原始伤害(元素抗性折算**后**)。 */
  rawDamage: number;
  /** 实际扣除的血量(0 表示被无敌/已倒下挡掉)。 */
  applied: number;
  /** 是否被无敌帧挡下。 */
  blockedByIframe: boolean;
  /** 是否因此倒下。 */
  downed: boolean;
  /** 命中时玩家位置与预警中心距离(诊断用)。 */
  distance: number;
  /**
   * 本次结算**真的施加**的击退量(格/秒,D1)。
   *
   * 0 = 没施加(未命中 / 被无敌帧挡下 / 已倒下 / 上游没给击退量)。
   * 由编排层据此写回 `PhysicsBody`(`physics.applyImpulse`)——
   * **本模块不碰物理**:那是编排层的职责(`vitals.ts` 只做生命值)。
   */
  knockbackPerSec: number;
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
 *
 * ## ★ 上界(裁决 5):等级被钳进 `[1, CONTENT_MAX_MOB_LEVEL]`
 *
 * ### 为什么必须在这里钳
 *
 * 本函数是**所有**生物伤害的唯一产出口:`applyHit`(预警几何通道)与
 * `resolveStrikes`(编排层批量结算)都只从这里取 `raw`。修前的实测
 * (`docs/ARCH-GAPS.md` 第五层):
 * ```
 * mobHitDamage(1e9)  ⇒ 2000000004   ← 荒谬值经 raw 流进三个字段:
 *   v.totalTaken += raw        (累计统计)
 *   this.totals.damage += raw  (帧统计)
 *   base.applied = raw         (★ 对外返回值:网络差量 / 客户端 / 存档)
 * ```
 * ⇒ 在这里钳一次,三个字段**同时**有界 —— 这比在三个写入点各钳一次好:
 * 三份实现日后必然漂移(本仓陷阱 31/41),而这里只有一处口径。
 *
 * ### 阈值为什么不写 30
 *
 * 上界取 `CONTENT_MAX_MOB_LEVEL`(从 `MOB_LIST` / `BOSS_LIST` 派生)。
 * 硬编码 30 的失败模式是**静默过期**:内容加了 35 级生物后,合法伤害
 * 会被悄悄钳掉而不报错。
 *
 * ### 三档口径(与 `sanitizeComboMul` 同族:拒绝与夹取必须可区分)
 *
 * ```
 * 合法 1..上界   ⇒ 原样
 * 有限越界 ≤0    ⇒ 1;  > 上界 ⇒ 上界(夹取)
 * +Infinity      ⇒ 上界(夹取)
 * 非数字 / NaN   ⇒ 1(拒绝)
 * ```
 * 最后一条是**顺带堵住的一个真洞**:修前 `mobHitDamage({})` = `NaN`
 * (`Math.max(1, NaN)` 返回 `NaN`),而 `NaN` 经 `raw` 写进 `v.hp` 后
 * `hp === 0` 恒 false ⇒ 玩家**既不死也回不了血**(与 task-51 修掉的
 * 「生物 HP 被 NaN 永久污染」同一形态,只是发生在 vitals 侧)。
 */
export function mobHitDamage(level: number, mul = 1.0): number {
  const lv = clampMobLevel(level);
  /* ★ 荒谬**乘数**的第二道门:`mul` 是公开入参(任何调用方都能传),
     与等级同族 —— `mobHitDamage(5, NaN)` 修前返回 `NaN`。
     口径与 `sanitizeComboMul` 一致:**非有限 ⇒ 拒绝**(退回 1.0),
     而不是夹取到某个上界 —— 「乘数不可信」时唯一安全的默认是「不加成」。
     ⇒ 本函数的输出**恒为有限数**(≥1),这是三个外流字段有界的前提。 */
  const m = Number.isFinite(mul) ? mul : 1.0;
  const base = MOB_HIT_BASE + MOB_HIT_PER_LEVEL * (lv - 1);
  return Math.max(1, Math.round(base * m));
}

/**
 * 把等级收进 `[1, CONTENT_MAX_MOB_LEVEL]`(见 `mobHitDamage` 的三档口径)。
 *
 * ⚠️ 单独成函数只为一件事:让「上界从内容派生」这条口径**只有一个实现**。
 */
function clampMobLevel(level: number): number {
  /* `Math.trunc` 对非法值给出判别式:`{}` / `NaN` ⇒ NaN,`Infinity` ⇒ Infinity。
     故 `Number.isNaN` 这一步**不是可选的** —— `Math.max(1, NaN)` 传播 NaN。 */
  const trunc = Math.trunc(level);
  if (Number.isNaN(trunc)) return 1;
  return Math.min(CONTENT_MAX_MOB_LEVEL, Math.max(1, trunc));
}

/**
 * 单次生物攻击伤害的**上界**(= 内容最大等级处的伤害)。
 *
 * 它是裁决 5 里「阈值口径」的可断言形态:
 * ```
 * MOB_HIT_MAX_DAMAGE === mobHitDamage(CONTENT_MAX_MOB_LEVEL)
 * ```
 * 断言它,就能钉住「`raw` 的荒谬值被吸收」这件事 —— 而不是只钉住某次调用的数字。
 * ⚠️ 事件型攻击(`EVENT_STRIKE_RULES`)可带 `mul > 1`,故它**不是**`raw` 的绝对值上界,
 * 而是「合法等级上限处的基础伤害」。荒谬**等级**造成的荒谬伤害由它兜住。
 */
export const MOB_HIT_MAX_DAMAGE = mobHitDamage(CONTENT_MAX_MOB_LEVEL);

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
  /**
   * **逐元素**抗性表(D4):playerId → (element → 系数)。
   *
   * 缺省键 = 无抗性(1.0)。与 `players` 分开存:它是**装备/天赋派生**的量
   * (调用方通过 `setElementResist` 写入),不属于「生命状态」本身。
   */
  private readonly resists = new Map<string, Map<string, number>>();
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
      blindSec: 0,
      stunnedSec: 0,
    };
    this.players.set(id, v);
    return v;
  }

  /**
   * 登记/覆盖某玩家对某**元素**的抗性系数(D4)。
   *
   * ## 为什么是「逐元素」的一张表,不是构造器参数
   *
   * 抗性是**元素 × 玩家**两维的量(火抗 0.5 不代表冰抗 0.5),
   * 而 `maxHp` 那种构造器参数只能表达「一个数」(与 `syncMaxHp` 的存在理由同族)。
   *
   * ## 三档口径(与 `mobHitDamage` / `sanitizeComboMul` 同族)
   *
   * ```
   * 合法 [0, MAX_ELEMENT_RESIST_MUL] ⇒ 原样(夹取)
   * 非有限(NaN / Infinity / 非数字)  ⇒ 拒绝,返回 false,**不写入**
   * ```
   * 「拒绝」而不是「夹取」的理由:一个 NaN 抗性会让 `raw` 变 NaN ⇒ 血量被永久污染
   * (本仓已踩过两次,见 `mobHitDamage` 的注释)。宁可保持旧值。
   *
   * @returns 是否写入(便于调用方/断言区分「拒绝」与「写了个相同的值」)
   */
  setElementResist(playerId: string, element: string, mul: number): boolean {
    if (!Number.isFinite(mul)) return false;
    const key = String(element);
    const cur = this.resists.get(playerId);
    const next = Math.min(MAX_ELEMENT_RESIST_MUL, Math.max(0, mul));
    if (cur) cur.set(key, next);
    else this.resists.set(playerId, new Map([[key, next]]));
    return true;
  }

  /**
   * 某玩家对某**元素**的抗性系数(D4 的读口)。
   *
   * 未登记 ⇒ `ELEMENT_RESIST_NEUTRAL`(1.0,原样)。**不改任何状态。**
   */
  elementResistOf(playerId: string, element: string): number {
    return this.resists.get(playerId)?.get(String(element)) ?? ELEMENT_RESIST_NEUTRAL;
  }

  /**
   * 给玩家施加**致盲**(D5)。
   *
   * 语义:取**较大**的剩余秒数(不叠加,不续杯 —— 与 `live_bubble` 的
   * 「被困期间再打不会重新计时」同一裁决)。非法秒数(NaN / 负 / 非数字)⇒
   * 不施加,返回 0。
   *
   * @returns 施加后的剩余秒数(便于动作层/断言读回)
   */
  applyBlind(playerId: string, sec: number): number {
    const v = this.players.get(playerId);
    if (!v) return 0;
    if (!Number.isFinite(sec) || sec <= 0) return v.blindSec;
    v.blindSec = Math.max(v.blindSec, sec);
    return v.blindSec;
  }

  /** 致盲剩余秒数(0 = 未致盲)。**不改任何状态。** */
  blindOf(playerId: string): number {
    return this.players.get(playerId)?.blindSec ?? 0;
  }

  /**
   * 给玩家施加**定身/冰冻**(D3:Boss 技能对玩家的特殊效果)。
   *
   * 语义与 `applyBlind` 逐条同构(取较大值、不续杯、非法值不施加),
   * 因为它们回答的是同一类问题:「这个状态还要持续多久」。
   * 分开的只有**字段** —— 谁在读它(`applyPlayerMove` 读 `stunnedSec`,
   * 攻击/视野读 `blindSec`)决定了两者不能合并。
   */
  applyStun(playerId: string, sec: number): number {
    const v = this.players.get(playerId);
    if (!v) return 0;
    if (!Number.isFinite(sec) || sec <= 0) return v.stunnedSec;
    v.stunnedSec = Math.max(v.stunnedSec, sec);
    return v.stunnedSec;
  }

  /** 定身剩余秒数(0 = 能动)。**不改任何状态。** */
  stunOf(playerId: string): number {
    return this.players.get(playerId)?.stunnedSec ?? 0;
  }

  /**
   * **已算好**的伤害直接落账(D3:PvP 与 Boss 技能)。
   *
   * ## 为什么不能复用 `applyHit`
   *
   * `applyHit` 的入参是 `(level, mul)` —— 它**自己算**伤害(`mobHitDamage`)。
   * PvP 的伤害来自八步公式(`computeDamage` 的 `finalDamage`,已含暴击/护甲/元素)。
   * 若把 `finalDamage` 反解成 `mul` 再喂给 `applyHit`,就是**用一条公式近似另一条**
   * —— 数字看起来对,实则每次都差一点,而且没人能看出是哪一步差的。
   *
   * ⇒ 本方法只负责「扣血的那一段」:同一个 `downed` 闸、同一批字段、同一个无敌帧。
   */
  applyDamage(
    playerId: string,
    amount: number,
    opts: { ignoreIframe?: boolean } = {},
  ): { applied: number; blockedByIframe: boolean; downed: boolean } {
    const none = { applied: 0, blockedByIframe: false, downed: false };
    const v = this.players.get(playerId);
    if (!v) return none;
    if (v.downed) return none;
    if (!Number.isFinite(amount) || amount <= 0) return none;
    if (v.iframeSec > 0 && opts.ignoreIframe !== true) {
      this.totals.blocked += 1;
      return { applied: 0, blockedByIframe: true, downed: false };
    }
    const applied = Math.round(amount);
    v.hp = Math.max(0, v.hp - applied);
    v.iframeSec = PLAYER_IFRAME_SEC;
    v.sinceHurtSec = 0;
    v.totalTaken += applied;
    v.hitCount += 1;
    let downed = false;
    if (v.hp === 0) {
      v.downed = true;
      downed = true;
      this.totals.downed += 1;
    }
    this.totals.hits += 1;
    this.totals.damage += applied;
    return { applied, blockedByIframe: false, downed };
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

  /**
   * 复活(满血)。
   *
   * ## `invulnSec` 参数(task-64)
   *
   * **此前这里无条件 `v.iframeSec = 0`** —— 复活后玩家**没有任何宽限无敌**,
   * 起手就会被下一拳打死。实测(修前):复活后第 1 拳 `applied=14`(期望 0)。
   *
   * 根因不是「忘了写无敌」,而是**无敌有两套,写错了那一套**:
   * ```
   * downedStates[i].invulnSec   ← revive.ts 把 MANUAL_REVIVE_INVULN / FEATHER_INVULN 写进这里
   *                              ⚠️ 而读它的 isInvulnerable() 生产 0 调用 ⇒ **到不了玩家身上**
   * vitals[i].iframeSec        ← 受击判定真正读的是这个(vitals.ts:397 / world_sim.ts:2718)
   *                              ⚠️ 而 revive() 把它显式置 0 ⇒ 反方向抹掉
   * ```
   * ⇒ 所以修法是**把复活的无敌写进活的那一套**(本参数),而不是给死的那套加递减。
   *
   * 默认 `0` = 保持原语义(重连/读档导入 HP 时不该给无敌帧)。
   *
   * ## W1 钳制(契约 `US2-GATEWAY-CONTRACT.md` §2.4 —— **唯一选址在此**)
   *
   * **此前这里是 `v.hp = hp ?? v.maxHp`,完全不钳制。** 实测三个反例:
   * ```
   * revive('p1', 535)  ⇒ hp=535,而 maxHp=100   ⇒ hp > maxHp   ★ W1 本体
   * revive('p1', -5)   ⇒ hp=-5                 ⇒ 负血
   * revive('p1', NaN)  ⇒ hp=NaN                ⇒ **所有后续比较恒 false**
   * ```
   * 第三条最危险:与 `checkMove` 的 6.0 值域门同族 —— `NaN` 会静默穿过
   * 每一个 `hp > 0` / `hp < maxHp` 判断,玩家既不死也回不了血。
   *
   * ## ★ 契约给的表达式有一个洞,这里补上(不改契约,只落实它的要求)
   *
   * 契约原文 `Math.min(v.maxHp, Math.max(1, hp ?? v.maxHp))` ——
   * **`Math.max(1, NaN)` 返回 `NaN`**(`Math.max` 遇 `NaN` 传播)。
   * ⇒ 若照抄,`revive(id, NaN)` 仍然是 `NaN`,洞没补上。
   * 故 `Number.isFinite` 这一步**不是可选的**。
   *
   * ## ★★ 下界是 **0** 而非 1(契约 §2.4.1 订正后的结论)
   *
   * 契约初版写 `Math.max(1, ...)`,理由是「复活后 hp=0 会立刻再次 downed,是个死循环入口」。
   * **那条理由机制错**,三条实测:
   * ```
   * ① revive(0) 后 hp=0 downed=false;推进 400 帧 hp 被 regen 抬到 20 ⇒ 不自动倒
   *    (真正置 downed 的只有本文件被打到 0 的那一处,`revive` 自己置 false 且不检查 hp)
   * ② hp=0 起手 → 一拳: applied=6 hp=0 downed=true
   *    hp=1 起手 → 一拳: applied=6 hp=0 downed=true   ← **逐字段完全相同**
   *    ⇒ 下界 1 达成不了它声明的目的(一级生物一拳 6 点,1 血和 0 血都是一拳倒)
   * ③ REVIVE_HP_RATIO=0.5 ⇒ 复活路径传进来的 hpAfter 最小值是 **50**
   *    ⇒ 下界在复活语义下**从未被触发过**
   * ```
   * ⇒ 下界 1 的唯一真实效果是**改掉读档语义**:`importVitals`(world_sim.ts:2462)
   *   把 hp 钳到 `[0, maxHp]` 后交给本函数,于是存档里的 0 HP 被悄悄改成 1
   *   ⇒ 实测打破 `WS-FND-02` C22「0 HP 保留」。
   * ⇒ 故取 **0**:与读档语义一致,且不伤任何东西(复活路径落不到地板)。
   *
   * ## ★ 两个**独立**机制,不要混成一个
   *
   * ```
   * 甲  Number.isFinite(want) ? want : v.maxHp   →  堵 NaN
   * 乙  Math.max(0, safe)                        →  管负值落点
   * ```
   * W1 的两个病根(`hp > maxHp`、`NaN`)floor=0 一样治得住 ——
   * 因为 NaN 由甲兜底,与乙无关。真不变量是 `0 ≤ hp ≤ maxHp`。
   *
   * ## 为什么钳制**只**在这里(不在 `revive.ts`,也不在 `importVitals`)
   *
   * 裁决 4(ARCH-GAPS「未决」第 4 条,已下):本函数是**公开入口**
   * (`world_sim.revivePlayer` / `tickDowned` / `importVitals` 都汇到它),
   * ⇒ 钳在调用方只能防住**一个**调用方,而 `revive(id, 任意 hp)` 是公开签名。
   * `revive.ts` 只负责算期望值 `hpAfter` 并传入。
   *
   * ```
   * 修前   world_sim.importVitals 自带一份 `Math.min(v.maxHp, row.hp)`
   *        ⇒ 同一入口的两条路径口径不同(读档有钳、revive 没有)
   * 修后   **那份实现已摘除**,读档直接传原始 hp 进来,由本函数统一钳
   *        ⇒ 真不变量 `0 ≤ hp ≤ maxHp` 只有一处实现
   * ```
   * 两侧都钳 = **两份实现**,日后改上限口径必然漂移(本仓陷阱 31/41 已踩过多次)。
   */
  revive(id: string, hp?: number, invulnSec = 0): boolean {
    const v = this.players.get(id);
    if (!v) return false;
    /* ★ 两步分开,不可合并成 `Math.max(0, hp ?? v.maxHp)`:
     *   `Math.max` 遇 NaN 传播 ⇒ 合并后 NaN 会原样穿过。 */
    const want = hp ?? v.maxHp;
    const safe = Number.isFinite(want) ? want : v.maxHp;
    v.hp = Math.min(v.maxHp, Math.max(0, safe));
    v.downed = false;
    v.iframeSec = Math.max(0, invulnSec);
    v.sinceHurtSec = PLAYER_REGEN_DELAY_SEC;
    /* ★ D5:复活 = 一次「重新开始」,致盲必须一并清掉。
       不清的话:在迷雾里被救起来仍然是瞎的(玩家会以为复活没生效),
       而且 `blindSec` 没有任何其它清零路径 ⇒ 会跟着这个玩家一辈子。 */
    v.blindSec = 0;
    /* D3 同源:定身也是「复活后重置」的一部分 —— 否则被救起来还动不了。 */
    v.stunnedSec = 0;
    return true;
  }

  /**
   * 把某个玩家的生命上限同步到**派生值**(契约 `US2-GATEWAY-CONTRACT.md` §2.1)。
   *
   * ## ★ 为什么必须是「逐玩家」而不是构造器参数
   *
   * `VitalsSystem.maxHp` 是**构造器参数,被所有玩家共享**(实测:同一实例里
   * `register('p1')` 与 `register('p2')` 拿到同一个 `maxHp`)。
   * ⇒ 「按等级各自派生」**装不进**构造器 —— 那只能表达一个等级。
   * ⇒ 唯一正确形态是逐玩家改 `v.maxHp`(`get()` 返回同一引用,可直接改字段)。
   *
   * ## 职责边界(契约 §1)
   *
   * 本方法**不查表、不 import progression**。派生值 `derivedMaxHp` 由**调用方**
   * 传入。理由:若这里 `import { statsAtLevel } from './progression.ts'` 去自己算,
   * `vitals` 就成了**第二个等级权威** —— 与 `progression` 冲突,
   * 正是契约 §1 「`VitalsSystem` 不负责等级派生」要防的。
   *
   * ## ★ hp 的取舍策略:**C(只抬/降上限,hp 绝对值不变)**,且**收在函数内部**
   *
   * ```
   * A 补满差额  ⇒ 升级即回满血
   * B 按同比例  ⇒ hp *= derived/old
   * C 只改上限  ⇒ hp 绝对值不变        ← 契约取此
   * ```
   * 取 C 的**唯一**理由:它是三个里**唯一不给玩家凭空回血**的。
   * A 会与「温泉 +30% 生命上限」叠加出「升级顺带回血」的玩法后果,
   * 而那是**玩法裁决**,不是接线能定的(契约 §10 未决 1)。
   *
   * ⚠️ 策略**必须收在这里**,不得散到调用方 —— 日后裁决改成 A/B 时只需动这一处。
   * 故下面**只有** `Math.min` 钳制,**没有**任何按比例/补差的分支。
   *
   * ## ⚠️ 必须钳 `hp`(否则降级再造一个 W1)
   *
   * ```
   * 降到 Lv.1:derived=100,而 hp 可能是 535
   * ⇒ 不钳 ⇒ hp(535) > maxHp(100) ⇒ **W1 的镜像**,由本函数亲手制造
   * ```
   *
   * @param id 玩家
   * @param derivedMaxHp 由 `progression.statsAtLevel(level).maxHp` 得到的派生上限
   * @returns 是否发生了变更(便于调用方避免同帧重复投影)
   */
  syncMaxHp(id: string, derivedMaxHp: number): boolean {
    const v = this.players.get(id);
    if (!v) return false;
    /* 派生值本身不可信时**拒绝写入** —— 与 revive 同族:NaN 上限会让
     * `hp <= maxHp` 恒 false,比不更新更糟。 */
    if (!Number.isFinite(derivedMaxHp)) return false;
    /* 上限地板取 1(与 hp 的 0 不同):`maxHp = 0` 会让任何 hp 都 `> maxHp`,
     * 且 `stepTimers` 的 `hp < maxHp` 恒 false ⇒ 回血永久失效。
     * 上限为 0 是「无意义的活人」,不是合法状态。 */
    const next = Math.max(1, derivedMaxHp);
    const changed = next !== v.maxHp || v.hp > next;
    v.maxHp = next;
    /* 策略 C:只钳,不补、不按比例。唯一写 hp 的动机是「不许超过上限」。 */
    if (v.hp > next) v.hp = next;
    return changed;
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
   *
   * ## 参数扩张(D1 / D4)—— 两个都是**可选**,缺省行为与修前逐字段相同
   *
   * ```
   * knockback = 0         ⇒ 不产生击退(与 D1 之前完全一致)
   * element   = 'NONE'    ⇒ 抗性系数 1.0 ⇒ raw 与修前逐字段相同
   * ```
   *
   * ★ `knockback` 的单位是**格/秒**(与 `damage.ts` 第 8 步的
   * `DamageResult.knockbackImpulse` 同量纲),取值由调用方从**内容层**
   * (`WEAPONS[].knockback` / 无武器缺省)决定 —— 本模块不发明数值,
   * 只负责「这次到底施加了多少」的**记账**(`MobHitResult.knockbackPerSec`)。
   * 写回 `PhysicsBody` 的是编排层(`world_sim.resolveMobStrikes` 的
   * `physics.applyImpulse`):生命值与物理是两个域,本模块不碰物理。
   *
   * ★ `element` 走**抗性乘区**:`raw = round(mobHitDamage(level, mul) × resist)`。
   * 下界取 1 与 `mobHitDamage` 同一口径(一次命中至少 1 点)——
   * 抗性 0(完全免疫)也能把伤害压到 0 吗?**不能**,那样「免疫」就变成了
   * 「无敌」;免疫请走 `takenMul` 那条路(`damage.ts` 的语义)。
   */
  applyHit(
    attackerId: string,
    playerId: string,
    level: number,
    mul = 1.0,
    distance = 0,
    knockback = 0,
    element = 'NONE',
  ): MobHitResult {
    const v = this.players.get(playerId);
    const beforeResist = mobHitDamage(level, mul);
    const resistMul = this.elementResistOf(playerId, element);
    const raw = Math.max(1, Math.round(beforeResist * resistMul));
    const base: MobHitResult = {
      playerId,
      attackerId,
      rawBeforeResist: beforeResist,
      element: String(element),
      resistMul,
      rawDamage: raw,
      applied: 0,
      blockedByIframe: false,
      downed: false,
      distance,
      knockbackPerSec: 0,
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

    /* ★ 三个字段都有界(裁决 5)——
       上界由 `mobHitDamage` 的**单一**钳制点保证(等级钳进内容上界、
       非有限乘数被拒)。这里**故意不再钳一次**:在三个写入点各钳一次 =
       三份实现,日后必然漂移,且会掩盖上游钳制失效(本仓陷阱 31/41)。
       实测链条(`tests/WS-10.test.ts` 逐条断言)见 `mobHitDamage` 的注释。 */
    v.hp = Math.max(0, v.hp - raw);          /* 已钳在 0(HP 侧) */
    v.iframeSec = PLAYER_IFRAME_SEC;
    v.sinceHurtSec = 0;
    v.totalTaken += raw;                     /* ★ 累计统计:有界(修前吸收 2e9) */
    v.hitCount += 1;
    base.applied = raw;                      /* ★ **对外返回值**:有界(修前外流 2e9) */
    base.applied = raw;                      /* ★ **对外返回值**:有界(修前外流 2e9) */
    /* ★ D1 击退记账:`0` = 上游没给 / 值非法 ⇒ 不产生击退。
       `Number.isFinite` 不是为了好看:`knockback` 是公开入参,`NaN` 经
       `applyImpulse` 会把刚体速度永久污染成 NaN(`ensureFinite` 会复位,
       但那是一次**静默的**降级)。 */
    base.knockbackPerSec = Number.isFinite(knockback) && knockback > 0 ? knockback : 0;
    if (v.hp === 0) {
      v.downed = true;
      base.downed = true;
      this.totals.downed += 1;
    }
    this.totals.hits += 1;
    this.totals.damage += raw;               /* ★ 帧统计:有界 */
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
      /* ★ D5:致盲倒计时。放在「未倒下」分支里:倒下的玩家**冻结**状态
         (他被救护后 `revive` 会清零,见那里的注释)。 */
      if (v.blindSec > 0) v.blindSec = Math.max(0, v.blindSec - dt);
      if (v.stunnedSec > 0) v.stunnedSec = Math.max(0, v.stunnedSec - dt);
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
 * 事件型**致盲**(D5 的生产侧来源)。
 *
 * ## 为什么它必须在这里,而不是在玩家输入层
 *
 * D5 的原文:「`tanuki_ambush` 的致盲效果只有 `mem.blindSec`,玩家侧无对应状态」。
 * 修法不是给玩家加一个字段就完 —— 那样字段**永远没有写入者**。
 * 生产者已经存在:`mobs/behaviors.ts:542` 的 `rt.mem.blindSec = 3` 与
 * `world.emit('tanuki_ambush')`。缺的是**消费者**:把这条事件结算到玩家身上。
 *
 * ## 数值出处(不新造)
 *
 * ```
 * sec    = 3     ← 与 AI 写进 rt.mem 的同一个数(behaviors.ts:542)
 * radius = 2.0   ← 与既有事件通道 `scorpion_ambush` 同半径(同一张表的既有值)
 * ```
 */
export const EVENT_BLIND_RULES: readonly { kind: string; radius: number; sec: number }[] = [
  { kind: 'tanuki_ambush', radius: 2.0, sec: 3.0 },
];

/**
 * 从一帧的事件里提取「致盲型」事件(与 `collectEventStrikes` 同一形状)。
 *
 * 与伤害通道分开的理由:`tanuki_ambush` 是**零伤害**事件,若塞进
 * `EVENT_STRIKE_RULES` 就会以「0 伤害的命中」形式污染 `hitCount`/`lastHits`
 * (玩家会看到「被打中 0 点」的反馈)。它是**状态**事件,不是伤害事件。
 */
export function collectEventBlinds(
  events: readonly { source: string; kind: string }[],
  posOf: (id: string) => { x: number; y: number } | null,
): { attackerId: string; warn: WarnGeom; sec: number }[] {
  const out: { attackerId: string; warn: WarnGeom; sec: number }[] = [];
  for (const e of events) {
    const rule = EVENT_BLIND_RULES.find((r) => r.kind === e.kind);
    if (rule === undefined) continue;
    const pos = posOf(e.source);
    if (pos === null) continue;
    out.push({
      attackerId: e.source,
      sec: rule.sec,
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
    });
  }
  return out;
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
  /**
   * 本次攻击的**元素**(D4)。缺省 `'NONE'` ⇒ 抗性系数 1.0 ⇒ 与修前同值。
   *
   * ⚠️ 抗性**不在这里折算**:本函数是**纯几何**判定(它拿不到 `VitalsSystem`),
   * 折算的唯一落点是 `VitalsSystem.applyHit`。在这里再乘一次 = 两份实现。
   */
  element?: string;
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
        rawBeforeResist: raw,
        element: s.element ?? 'NONE',
        resistMul: ELEMENT_RESIST_NEUTRAL,
        rawDamage: raw,
        applied: isIframe ? 0 : raw,
        blockedByIframe: isIframe,
        downed: false, /* 由 VitalsSystem 判定 */
        distance: Math.hypot(p.x - s.warn.cx, p.y - s.warn.cy),
        /* 击退由编排层写回物理 —— 本函数不产生冲量(见 `PendingStrike.element` 的注释)。 */
        knockbackPerSec: 0,
      });
    }
  }
  return { results, warnsChecked: checked };
}