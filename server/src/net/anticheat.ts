/**
 * WS-07 · 服务端权威反作弊(零依赖核心)。
 *
 * 原则:客户端的一切输入都视为「**申请**」,不是「事实」。四类校验:
 *   1. 坐标跳变 —— 单帧位移不得超过 `maxSpeed(移速加成上限) × DT × 容差`。
 *   2. 移速上限 —— 单位时间平均移速,窗口式检测(防单帧合法、累计超速)。
 *   3. 攻速上限 —— 攻击间隔不得小于武器基线间隔 × (1 - 攻速加成上限)。
 *   4. 物品栏一致性 —— 物品总量守恒(消耗必须有来源,产出必须落账)。
 *
 * ⚠️ 第 1~3 类的「加成」**取自客户端声明**(装备/料理/冰面),服务端只把它**钳到上限**,
 * 不自行核算该玩家应有多少加成 —— 因为服务端目前没有装备数据(见 `MoveIntent.speedMul`
 * 与 `docs/WS-07-net-persist.md` §7)。故上限会随声明抬高;收敛它需先让服务端知道装备
 * (`CR-14 U2`)。服务端强制的是**声明的合法性**(非法值不得让检查失效),不是声明的大小。
 *
 * 处置:轻则**静默拒绝**(把请求回退到权威值,不打断同伴游戏),
 * 重则**累计违规分**触发 kick。所有裁决写 `room_events`。
 */

import { BASE_MOVE_SPEED, DT, TICK_HZ } from '../../../shared/types/physics.ts';

/* ═══════════════════════════ 1. 阈值表 ═══════════════════════════ */

/**
 * 移速加成上限。来源:手册 §3.9/§3.10 的可叠加加速项取上界并留余量 ——
 *   249 行进小军鼓 +25% · 601 甜莓果茶 +15% · 729 夜影吸血蝙蝠斗篷 移速 +10% ·
 *   619 冰面 +40% · 622 水中 +30% · 724 滚翻冷却(不改速度) ·
 *   叠罗汉 `carrierSpeedMul` 只减不增 · 230 缩小药水 0.3 倍(减速)。
 * 最坏正向叠加 1.25 × 1.15 × 1.10 × 1.40 = 2.21;再给 1.15 的余量 → 2.55。
 *
 * 注:手册 `719` 无移速、`731` 是攻防,两者均与本值无关 —— 早期把它们并写作移速出处
 * 是**引用标错**(数值 1.10 一直是对的),已修正为手册 `729`。
 */
export const MAX_SPEED_BONUS_MUL = 2.55;

/**
 * 坐标跳变的**单帧**容差:网络抖动下的补偿量,再宽会放过瞬移。
 *
 * ⚠️ **与 `SPEED_WINDOW_TOLERANCE`(1.25)语义不同,不要因为数值接近而合并。**
 *   - `TELEPORT_SLACK`  —— **单帧**抖动补偿。语义是「某一帧突然多走一点」,
 *     分母是**一帧**,只用于 `dist > allowed` 这一处。
 *   - `SPEED_WINDOW_TOLERANCE` —— **持续**超速容忍。语义是「一整秒里平均快了
 *     一点」,分母是**20 帧窗口**,只用于窗口均速比较。
 *
 * 两者可推导出一个容易误读的结论:`1.6 > 1.25` ⇒ **持续以「单帧上界」的速度
 * 行走会被窗口抓住**。这不是矛盾,而是设计意图:
 * 单帧可以抖(1.6),但不能**一直**抖(1.25)。实测(WS-07,120 帧):
 *   · 1.00× / 0.90× 合法         ⇒ 0 拒、0 分(不误伤);
 *   · 1.25× 合法(5.63 格/秒)    ⇒ 0 拒、0 分(**恰在容差边界也不误伤**);
 *   · 1.30× 合法(5.85 格/秒)    ⇒ 第 20 帧判 SPEED;
 *   · 2.00× 合法(9.00 格/秒)    ⇒ 第 1 帧判 TELEPORT;
 *   · 2.55× **且声明** `speedMul:2.55` ⇒ 0 拒(满加成合法,不误伤);
 *     同样 2.55× 却声明 `speedMul:1`   ⇒ 第 1 帧判 TELEPORT(真超速)。
 *   ⇒ 判据是「位移与**声明**的加成是否自洽」,不是绝对速度。
 */
export const TELEPORT_SLACK = 1.6;

/**
 * 窗口式移速检测:窗口长度与窗口内允许的平均超速比例。
 * ⚠️ 与 `TELEPORT_SLACK`(1.6)语义不同,见上。
 */
export const SPEED_WINDOW_TICKS = 20; // 1 秒
export const SPEED_WINDOW_TOLERANCE = 1.25;

/**
 * 自报 `tick` 相对**水位**允许的单包最大超前量(帧)。它是**斜率**限制,不是配额。
 *
 * ## 两个水位,两种含义(原名 `s.lastTick` 被两侧共写,是失明的病根)
 *
 * - `s.lastTick`  —— **服务端时钟**水位。只由 `AntiCheatRoom.tick()` 每帧推进。
 * - `s.lastMoveTick` —— **客户端申报**水位。只由被接受的移动推进。
 *
 * `claimedTick = min(intent.tick, lastMoveTick + MAX, lastTick + MAX)`。
 * 夹取点仍在 `checkMove` 入口**一处**(下游一律用 `claimedTick`),
 * 调用方不再重复夹取(J13 形态)。
 *
 * ## 为什么单靠 `MAX` 不够:同一帧可重复兑现额度
 *
 * 原实现 `dtTicks = Math.max(1, claimedTick - s.lastTick)` 有两处病:
 *
 * 1. **下界 `max(1, …)`**:`dtTicks` 永不为 0 ⇒ 报文条数**线性放大**总额度。
 * 2. **夹取点被客户端推动**:`s.lastTick` 由 `checkMove` 自己写,
 *    于是「额度上限」和「已用额度」是同一个字段 —— 每包都把上限往前推一格,
 *    再兑现一格。服务端帧号 `10` 时连发 50 包,每包 `0.918` 格,**全部放行、违规分 0**。
 *
 * 实测(WS-07 `E17` 族,均以真实 20Hz 帧推进):
 *   · 修复前:同一 tick 连发 20 包 ⇒ **20 包全放行、18.36 格、违规分 0**。
 *   · 修复后:同一 tick 连发 20 包 ⇒ **1 包放行、19 包被拒、0.918 格、违规分 76**
 *     (40 包时 39 拒 / 156 分),超过 3 次拒绝即达踢出阈值。
 *
 * 因此额度必须锚在**攻击者推不动的锁**上 —— 即服务端时钟 `lastTick`,
 * 而不是客户端也能写的字段。
 *
 * ## 为什么是「叠加」而不是「替换」(task-51 J13:两层都要,职责不同)
 *
 * 两层**不是**同一职责的两种写法,各自有**独立可测**的失效后果
 * (用工作区源码做单点手术生成副本,同一攻击形状实测):
 *
 * - 只删**服务端时钟封顶** ⇒ 同一帧内「逐包递进声称 tick」的放行量从
 *   **11 包 / 10.098 格**涨到 **19 包 / 17.442 格**(层级关系:此时单帧总额度
 *   不再与 `lastTick` 挂钩,只剩窗口检查兜底)。即**斜率层单独无法限制
 *   「一帧里能兑现多少」** —— 报文条数重新成为吞吐放大器。
 * - 只删**斜率封顶** ⇒ 玩家静默 200 帧后,单包声称 `tick:1e9` 可把整段积压
 *   一次兑现:**二分实测单包最大放行 144.15 格**(两层都在时同一输入只放行
 *   0.918 格,差 **157 倍**;其余更大的输入被判 TELEPORT)。
 *   即**时钟层单独无法限制「单包能跳多远」**,一包即可跨过任何墙体。
 *
 * 结论:**任何一层都不是另一层的冗余**,删任一层都不安全;
 * 故取 `Math.min` 保留两项,而不是「用一个替换另一个」。
 * (对照:`dtTicks` 的下界必须同时为 0,见下。)
 *
 * ## 取值 1(不是 20,也不是 5)
 *
 * 取 `SPEED_WINDOW_TICKS`(20)时单包额度 `0.918×20 = 18.36` 格 —— 而单包位移
 * **没有路径碰撞检测**(`applyMove` 只校验起终点欧氏距离,不查 `WorldGrid.isSolidAt`),
 * 18.36 格足以跨过任何墙体/陷阱/Boss 预警区。`1` ⇒ 单包 `0.918` 格,
 * 单包跨不过 1 格墙(0.918 < 1.0)。RTT 抖动由「服务端时钟水位」承担(它按真实
 * 流逝帧数放行),不需要靠放大 `MAX` 来补。
 *
 * ## ⚠️ 残留(如实记录,本修复**没有**根治这一条)
 *
 * 上面的「跨不过墙」是**单包**性质。本修复把额度锚在服务端时钟上,
 * 但时钟是**按帧**推进的,于是攻击者只要**静默若干帧**换取积压,
 * 再在**同一帧内**连发,就能把积压一次兑现:
 *
 *   静默 T 帧 ⇒ 可用额度 B = T + 1(帧);同帧内连发 K 包时
 *   超出 B 的包被拒 ⇒ 分数 = 4×拒(TELEPORT)或 3×拒(SPEED)。
 *
 * 实测(静默 19 帧 + 同帧连发 22 包):**放行 19 包 / 拒 3 条(全为 SPEED,权重 3)/
 * 违规分 9.0 < 12 ⇒ 未被踢出**,单帧位移 **17.442 格** ⇒ 可越过 10 格墙。
 *
 * 但它是**一次性的位置可达优势,不是移速优势** —— 这一点必须说清,否则会
 * 把它误报成「可以一直超速」:
 *   · **立刻重复**该循环 ⇒ **第 2 轮即被踢出**(累计分 74.6,实测);
 *   · **等分数衰减归零再爆**(0.02/帧 ⇒ 9 分需 450 帧)⇒ 稳态
 *     **0.712 格/秒 = 合法裸装 4.5 的 0.16 倍**,比合法玩法**更慢**。
 *
 * 与修复前的定性差别(这是本任务的实质交付):
 *   · 修复前:同一形状 **20 包全放行 / 18.36 格 / 违规分恒 0** ⇒
 *     零代价、无界、可无限重复;
 *   · 修复后:单帧位移**有界**(≤ B × 0.918)、超出部分**必留违规流水并记分**、
 *     重复即踢。残留收窄为「一次穿墙」,不再是「零代价无限瞬移」。
 *
 * 根治需要两件事之一(均**不在本文件职责内**):
 *   1. **入站报文限速**(会话/传输层):同一帧内进站报文数有上限,
 *      则「静默 + 连发」不可用 —— 这是最直接的修法;
 *   2. **路径碰撞检测**(`applyMove` 对整段位移做 ray/path 检查):
 *      则「单帧累计多包」即使发生也跨不过墙。
 *
 * 本文件只能保证:**每条报文**的位移上界正确、额度不被客户端自己推动、
 * 违规分不再恒 0。WS-07 `E17e` 把这个残留**钉成断言**:
 * 一旦有人真正根治(限速或路径检查),该断言会变红,提示更新。
 *
 * 代价(如实记录):丢包 ≥2 帧时,客户端那一包的位移超过 1 帧额度 ⇒ 被拒并回退。
 * ⚠️ 实测 HEAD 与修复版在同一丢包输入上**拒绝次数/拒因/违规分逐格相同**
 * (1% 丢包 60 秒都是 13 次 `单帧位移 1.148 格 > 上界 0.918`)——
 * 即该脆性**不是本次修复引入的**,根因是 `TELEPORT_SLACK(1.6)` 容不下 2 帧的
 * 真实位移(`4.5×2.55×0.05×2 = 1.1475 > 0.918`)。收紧 slack 属独立议题。
 * 这是刻意的**失效关闭**取向 —— 客户端会自行重新对齐,而多走一点是不可撤销的
 * 权威状态污染。真正的补偿应放在传输层(入站报文限速 + 客户端插值补帧),
 * 不在本函数职责内。
 *
 * 诚实客户端不受影响:mul=1(0.225 格/帧)与 mul=2.55(0.5737 格/帧)
 * 各跑 60 秒 **0 拒绝 / 0 分 / 未踢出**(实测)。
 *
 * 详见 `docs/GUARD-AUDIT.md` 与 WS-07 的 `E14` / `E17` 族用例。
 */
export const MAX_MOVE_CATCHUP_TICKS = 1;

/**
 * 攻速上限。
 *  - 基线:近战轻剑 0.40s/次(711 普攻三连)。
 *  - 允许的最快:0.40 / (1 + 1.00) = 0.20s —— 覆盖 714 双刀 + 249 军鼓 +25%
 *    + 627 炮台 +35%(只对炮台,不叠加到近战)+ 1220 帧近战限流。
 * 取 1.0 作为攻速加成上限。
 */
export const BASE_ATTACK_INTERVAL_S = 0.4;
export const MAX_ATTACK_SPEED_BONUS = 1.0;

/** 单帧最多允许消耗/产出的物品总量(防「一帧刷满背包」)。 */
export const MAX_ITEM_DELTA_PER_TICK = 64;

/** 违规分:达到即踢出。 */
export const VIOLATION_SCORE_KICK = 12;
export const VIOLATION_SCORE_DECAY_PER_TICK = 0.02;

export const ViolationKind = {
  TELEPORT: 'TELEPORT',
  SPEED: 'SPEED',
  ATTACK_RATE: 'ATTACK_RATE',
  INVENTORY: 'INVENTORY',
} as const;
export type ViolationKind = (typeof ViolationKind)[keyof typeof ViolationKind];

export const VIOLATION_WEIGHT: Readonly<Record<ViolationKind, number>> = {
  TELEPORT: 4,
  SPEED: 3,
  ATTACK_RATE: 2,
  INVENTORY: 5,
};

/* ═══════════════════════════ 2. 可注入时钟 ═══════════════════════════ */

export interface Clock {
  nowMs(): number;
}

/**
 * 可注入时钟。
 *
 * 返回的对象**同时**是一个合法 `Clock`(自带 `nowMs`)与一个控制器
 * (`advance` / `set`)。两种调用风格因此都成立:
 * ```ts
 * const clock = fixedClock(0);           clock.advance(60_000); clock.nowMs();
 * const { clock: c, advance } = fixedClock(0);
 * ```
 * 这样测试里不会因为「传外壳还是传内核」而写出两种不兼容的用法。
 */
export type FixedClock = Clock & {
  advance: (ms: number) => number;
  set: (ms: number) => number;
  /** 自指,兼容解构写法。 */
  clock: Clock;
};

export function fixedClock(startMs: number): FixedClock {
  let t = startMs;
  const self: FixedClock = {
    nowMs: () => t,
    advance: (ms: number) => { t += ms; return t; },
    set: (ms: number) => { t = ms; return t; },
    clock: undefined as unknown as Clock,
  };
  self.clock = self;
  return self;
}

/* ═══════════════════════════ 3. 裁决结果 ═══════════════════════════ */

export interface Violation {
  kind: ViolationKind;
  tick: number;
  playerId: string;
  detail: string;
  weight: number;
}

export interface Verdict {
  allowed: boolean;
  /** 拒绝时给客户端的权威值(用于静默回退)。 */
  corrected?: { x: number; y: number; z: number };
  violation?: Violation;
}

export interface AntiCheatLimits {
  maxSpeedBonusMul: number;
  teleportSlack: number;
  speedWindowTicks: number;
  speedWindowTolerance: number;
  baseAttackIntervalS: number;
  maxAttackSpeedBonus: number;
  maxItemDeltaPerTick: number;
  /**
   * 自报 `tick` 相对 `s.lastTick` 的最大追帧幅度。
   * 见 `MAX_MOVE_CATCHUP_TICKS` —— 它是**单帧位移上界的放大系数**,
   * 因此必须夹住,否则报一个大 `tick` 即可放行任意位移。
   */
  maxMoveCatchupTicks: number;
}

export const DEFAULT_LIMITS: AntiCheatLimits = {
  maxSpeedBonusMul: MAX_SPEED_BONUS_MUL,
  teleportSlack: TELEPORT_SLACK,
  speedWindowTicks: SPEED_WINDOW_TICKS,
  speedWindowTolerance: SPEED_WINDOW_TOLERANCE,
  baseAttackIntervalS: BASE_ATTACK_INTERVAL_S,
  maxAttackSpeedBonus: MAX_ATTACK_SPEED_BONUS,
  maxItemDeltaPerTick: MAX_ITEM_DELTA_PER_TICK,
  maxMoveCatchupTicks: MAX_MOVE_CATCHUP_TICKS,
};

/* ═══════════════════════════ 4. 每玩家校验器 ═══════════════════════════ */

export interface MoveIntent {
  tick: number;
  x: number;
  y: number;
  z: number;
  /**
   * 客户端声明的移速倍率(装备/料理)。
   *
   * ⚠️ **服务端不自行核算这个值 —— 只把它钳到上限**(见 §7「一律钳到上限,不自证」)。
   * 服务端目前**没有**装备数据可据以独立算出「该玩家应该多快」:`PlayerState` 只有
   * `weaponId`、无装备槽,`room.ts` 也不保存穿戴状态,`statsAtLevel` 不含任何速度字段。
   *
   * 因此这是**已声明的设计取舍,不是「服务端已核对过」**:上限会随声明抬高
   * (声明 `2.55` 时约基线的 3.19 倍),且绕过装备前置。
   *
   * 要收敛这里就得让服务端真正知道装备(CR-14 U2 的另一条路:加装备槽 + 服务端速度模型),
   * 在那之前**不要**把本注释写成「已比对」—— 那与 §7 口径矛盾,会误导后来者以为这里安全。
   *
   * 唯一被服务端强制的是**值的合法性**:非数字/`NaN` 声明不会让检查失效
   * (见 `sanitizeMul`),而不是「声明的大小」。
   */
  speedMul?: number;
}

export interface PlayerAntiCheatState {
  id: string;
  lastX: number;
  lastY: number;
  lastZ: number;
  /**
   * **服务端时钟**水位:房间真实走到第几帧。只由 `AntiCheatRoom.tick()` 推进。
   *
   * ⚠️ **不要**在这里写客户端申报值(见 `MAX_MOVE_CATCHUP_TICKS` 的
   * 「两个水位,两种含义」)。它此前被 `checkMove` 与 `tick()` **两侧共写**,
   * 于是「额度上限」和「已用额度」成了同一个字段 —— 攻击者每包都把上限往前推,
   * 再兑现一包,单帧可灌满任意位移。它是反作弊失明的病根,故拆成两个字段。
   */
  lastTick: number;
  /**
   * **客户端申报**水位:被兑现到的最大自报帧号。只由 `checkMove` 推进,且**单调**。
   *
   * 额度 = `claimedTick - lastMoveTick`,故**报同一个 tick 第二次拿不到额度** ——
   * 这正是「同一 tick 可重复兑现」的闸门。
   */
  lastMoveTick: number;
  /** 环形窗口:最近 N 帧的位置与时间,用于窗口式移速检测。 */
  window: { tick: number; x: number; y: number }[];
  /** 上次成功攻击的 tick。 */
  lastAttackTick: number;
  score: number;
  violations: Violation[];
  kicked: boolean;
}

export function createAcState(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
  return {
    id,
    lastX: x, lastY: y, lastZ: z,
    /* 两个水位都对齐到进入时刻(tick 由 `join` 传入 `state.meta.tick`)。
       若只对齐时钟而让申报水位留在 0,玩家可在同一帧内连发 N 包
       「追平」这段积压 ⇒ 开局即兑现 N 帧额度。两边同起点则无积压。 */
    lastTick: tick,
    lastMoveTick: tick,
    window: [{ tick, x, y }],
    lastAttackTick: -9999,
    score: 0,
    violations: [],
    kicked: false,
  };
}

function record(s: PlayerAntiCheatState, v: Violation): void {
  s.violations.push(v);
  s.score += v.weight;
  if (s.score >= VIOLATION_SCORE_KICK) s.kicked = true;
}

/** 每帧末的分数衰减,让偶发抖动不会攒成踢出。 */
export function decayScore(s: PlayerAntiCheatState): number {
  s.score = Math.max(0, s.score - VIOLATION_SCORE_DECAY_PER_TICK);
  return s.score;
}

/**
 * 推进单个玩家的**服务端时钟**水位到 `tick`(单调)。
 *
 * `s.lastTick` 只能经这一处写入 —— 它是「同一帧内重复兑现额度」的闸门,
 * 一旦允许别处(尤其是 `checkMove`)写它,闸门就归攻击者控制
 * (见 `MAX_MOVE_CATCHUP_TICKS`)。`AntiCheatRoom.tick()` 循环调用本函数,
 * 调用方与测试共用**同一份**推进逻辑,不另写第二份。
 */
export function advanceServerClock(s: PlayerAntiCheatState, tick: number): void {
  s.lastTick = Math.max(s.lastTick, tick);
}

/**
 * 把客户端声明的加成**一律化为有界的有限数**。
 *
 * ## 为什么必须有这一步(WR-14 U2-b,真缺陷)
 *
 * 声明值会被喂进 `Math.min/Math.max` 算阈值,而 `Math.max(0, {})` = **`NaN`** ——
 * 之后 `dist > NaN`、`since < NaN` **恒为 `false`**,于是
 * **瞬移 / 窗口均速 / 攻速三道检查同时静默失效**:
 * 单帧跳 200 格会被**直接放行**。
 *
 * 这条路经**真实可达**:`{"speedMul":{}}` / `{"speedMul":"abc"}` 经 JSON 反序列化
 * 即进入 `room.colyseus.ts` 的 `onMessage`;TS 的 `speedMul?: number`
 * **只是编译期标注,不产生运行时校验**,拦不住。
 *
 * ## 兜底为什么取 `fallback`(「未声明」默认值)而不是 0
 *
 * 取 `0` 会让 `allowed = 0`,把该玩家的**每一次**移动都判成瞬移 ——
 * 等于用一个坏输入把自己锁死(自我拒绝服务)。取 `fallback` 则退化为
 * 「没有声明加成」,该玩家仍按基线正常移动。
 *
 * 兜底**不构成放水面**:声明一个合法的上限值(如 `2.55`)得到的结果与兜底完全相同,
 * 作弊者没有动机发非法值;而非法值不再让任何检查失效。
 *
 * ## 为什么只对 `NaN` / `-Infinity` 兜底,而 `+Infinity` 仍旧钳到 `max`
 *
 * `+Infinity` 经 `Math.min` 本来就被钳到 `max` —— 这是**安全**的(等于「申请最大加成」),
 * 属于既有正确行为,不该改;改了反而是无谓回归。
 * 真正有害的只有两个:`NaN` 让比较恒 false(绕过),`-Infinity` 钳成 `0` 会锁死自己。
 */
function sanitizeMul(declared: unknown, fallback: number, max: number): number {
  if (typeof declared !== 'number') return fallback;
  if (Number.isNaN(declared) || declared === Number.NEGATIVE_INFINITY) return fallback;
  return Math.min(Math.max(0, declared), max);
}

/**
 * 校验并**合并**外部传入的限值。
 *
 * ## ★★★ 为什么必须有这一步(CR-27:契约缺守卫 ⇒ fail-open)
 *
 * 构造器此前是 `this.limits = limits`,**对传入值不做任何检查**。
 * 于是传入非对象或**部分对象**时:
 * ```
 * limits.maxMoveCatchupTicks == undefined
 * ⇒ claimedTick = min(intent.tick, lastMoveTick + undefined, lastTick + undefined) = **NaN**
 * ⇒ dtTicks = Math.max(0, NaN) = NaN
 * ⇒ allowed = 0.36 * NaN = **NaN**
 * ⇒ `dist > NaN + 1e-9` **恒 false**  ⇒ **全部放行**
 * ```
 *
 * ## 实测(本仓复现,攻击 = `{tick:1e9, x:1e5}` 瞬移 10 万格)
 * ```
 * new AntiCheatRoom()                       ⇒ 拒绝 ✓
 * new AntiCheatRoom(DEFAULT_LIMITS)         ⇒ 拒绝 ✓
 * new AntiCheatRoom('not-an-object')        ⇒ ★ allowed=true  fail-open
 * new AntiCheatRoom({speedWindowTicks:20})  ⇒ ★ allowed=true  fail-open
 * new AntiCheatRoom(null)                   ⇒ 抛 TypeError(崩溃,非放行)
 * new AntiCheatRoom(42) / ({}) / 字段=undefined / 字段=NaN ⇒ ★ 全部 fail-open
 * ```
 *
 * ## ★ 比 Lead 描述的**更广**:不是单个字段,是**整个类型缺值域门**
 *
 * 逐字段注入 `NaN` 后,**8 个字段全部**让它负责的那道检查静默失效:
 * ```
 * maxMoveCatchupTicks  ⇒ claimedTick = NaN        ⇒ 瞬移放行
 * teleportSlack        ⇒ allowed = NaN            ⇒ 瞬移放行
 * maxSpeedBonusMul     ⇒ cap = NaN                ⇒ 瞬移放行
 * speedWindowTicks     ⇒ cutoff = NaN             ⇒ 窗口检查失效
 * speedWindowTolerance ⇒ cap = NaN                ⇒ 窗口检查失效
 * baseAttackIntervalS  ⇒ minInterval = NaN        ⇒ 同帧 10 连发全放行
 * maxAttackSpeedBonus  ⇒ bonus = NaN              ⇒ 同上
 * maxItemDeltaPerTick  ⇒ Math.abs(net) > NaN = false ⇒ 单帧刷 1000 件放行
 * ```
 * ⚠️ 测 `speedWindow*` 时我第一版探针**自己踩了坑**:攻击构造被 **TELEPORT
 *    抢先拦下**,窗口检查根本没走到 ⇒ 误判成"仍安全"。修正构造(走 1.3 倍速、
 *    声明 mul=1,恰好通过单帧而上窗口)后同样 fail-open。
 *    ⇒ 这正是本仓那条纪律:**注入物必须是缺陷本体**,打在"被别的检查抢先
 *      命中的一侧"测不出来。
 *
 * ## 定性:契约缺守卫,**不是当前可利用缺陷**
 * ```
 * 生产调用点只有 room.ts 的 `new AntiCheatRoom()`(不传参)⇒ 当前不可达。
 * 与 `mobHitDamage` 同类(ARCH-GAPS 第五层):缺守卫,非当前可利用。
 * ```
 * ⇒ 但仍要修:**一个只在"将来有人传参"时才显形的洞,永远不会被自己发现**。
 *
 * ## 取值策略:**逐字段 fail-closed 到默认值**(不是 fail-fast 抛错)
 *
 * ```
 * fail-fast(抛错)的理由:坏配置是**开发者错误**,应尽早暴露。
 * fail-closed(兜默认)的理由:反作弊在**每帧热路径**上,抛错会
 *   把「一个字段写错」升级成「房间整帧崩掉」—— 而崩溃的房间
 *   **不检查任何东西**,比"用默认限值继续检查"更不安全。
 * ⇒ 取 **fail-closed**,但**不静默**:见下面的 `limitsReported`。
 * ```
 * ⚠️ 为什么必须"不静默":兜默认若无声,就成了**又一处静默降级** ——
 *    传错字段的人永远不知道自己传错了,而限值悄悄变回默认。
 *    ⇒ 故合并结果**可读回**(`AntiCheatRoom.limits` 是合并后的值),
 *      且非法字段被记进 `limitsIssues` 供断言与诊断。
 *
 * ## 什么算非法
 * ```
 * · 整个 limits 不是对象(null / 字符串 / 数字)⇒ **整体**回退 DEFAULT_LIMITS
 * · 单字段 非 number / NaN / ±Infinity / 负数 ⇒ **该字段**回退默认
 *   (⚠️ 0 是**合法**值:它表达"零容忍",是一个真实的策略选择,不是坏值)
 * · 未知字段 ⇒ 忽略(不报错:结构化传入允许多余键)
 * ```
 */
export function mergeLimits(limits: unknown): { limits: AntiCheatLimits; issues: string[] } {
  const issues: string[] = [];
  /* 整体不是对象 ⇒ 全部回退。`null` 此前会抛 TypeError,这里一并收下。 */
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    const shown = limits === null ? 'null' : `${typeof limits} ${String(limits).slice(0, 24)}`;
    issues.push(`limits 不是对象(${shown})⇒ 全部回退 DEFAULT_LIMITS`);
    return { limits: { ...DEFAULT_LIMITS }, issues };
  }
  const src = limits as Record<string, unknown>;
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof AntiCheatLimits)[]) {
    if (!(key in src)) {
      issues.push(`${key} 缺失 ⇒ 回退默认 ${DEFAULT_LIMITS[key]}`);
      continue;
    }
    const v = src[key];
    /* ⚠️ 只接受**有限非负数**。`0` 合法(见上文);`NaN`/`±Infinity`/负数/非 number 全拒。 */
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      issues.push(`${key}=${String(v)} 非法(需有限非负数)⇒ 回退默认 ${DEFAULT_LIMITS[key]}`);
      continue;
    }
    out[key] = v;
  }
  return { limits: out, issues };
}

/**
 * 单帧允许的最大位移。
 * 位移上界 = maxSpeed(声明倍率) × DT,再乘 `teleportSlack` 补偿时钟抖动。
 *
 * 声明倍率先经 `sanitizeMul` 兜底 —— 否则非法声明会让本函数返回 `NaN`,
 * 使调用方的 `dist > allowed` 恒为 false(见 `sanitizeMul` 说明)。
 */
export function maxDisplacementPerTick(speedMul = 1, limits: AntiCheatLimits = DEFAULT_LIMITS): number {
  const mul = sanitizeMul(speedMul, 1, limits.maxSpeedBonusMul);
  return BASE_MOVE_SPEED * mul * DT * limits.teleportSlack;
}

/** 校验一次移动意图。 */
export function checkMove(
  s: PlayerAntiCheatState,
  intent: MoveIntent,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
  maxZ = 3,
): Verdict {
  /* ── 6.0 值域门:非有限值一律拒绝 ──
   *
   * `Math.max(0, {})` / `Math.max(0, "abc")` / 字段缺失 ⇒ `NaN`,而
   * **`NaN` 的任何比较恒为 `false`** ⇒ 下面的 `dist > allowed + 1e-9` 会静默失效。
   * 与 `sanitizeMul` 兜底 `speedMul` 是**同一族的坑**(CR-14 U2-b),只是这里
   * 落在坐标与自报帧号上。
   *
   * `+Infinity` 现在**碰巧**被拦(`Infinity > 0.36` 为真)—— 那是巧合,不是设计:
   * 它靠的是比较运算符的行为,一旦上界算式的形态变化就会失守。
   * 故这里用 `Number.isFinite` 显式判定,不依赖「比较恰好为真」。
   *
   * 实测(WS-07 `E09` 族):若不设此门,`{x: NaN}` 与 `{}`(字段缺失)
   * 都能让一条报文**无条件放行**,且被写进 `s.lastX` ⇒ 下一条报文
   * 的 `dist` 仍是 `NaN` ⇒ 反作弊在该玩家身上持续失明。
   */
  if (
    !Number.isFinite(intent.tick) || !Number.isFinite(intent.x)
    || !Number.isFinite(intent.y) || !Number.isFinite(intent.z)
  ) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: Number.isFinite(intent.tick) ? intent.tick : s.lastTick,
      playerId: s.id,
      detail: `非有限坐标/帧号被拒:tick=${intent.tick} x=${intent.x} y=${intent.y} z=${intent.z}`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return {
      allowed: false,
      corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
      violation: v,
    };
  }

  /* ── 6.0b 帧号:两个水位,一处夹取 ──
   *
   * `MoveIntent.tick` 是客户端自报值(CR-14 U1 同族:客户端输入一律是「申请」)。
   * 它同时决定两件事:单包位移额度(`dtTicks` **线性放大**上界)与窗口检查的
   * 时间轴。原实现把它们都挂在 `s.lastTick` 一个字段上,而该字段**同时被
   * `checkMove` 和 `tick()` 写** ⇒ 「上限」和「已用」是同一个量,攻击者每包把
   * 上限往前推一格再兑现一格,单帧即可灌满任意位移(实测 20 包 18.36 格、0 分)。
   *
   * 现在拆成两个单调水位,各自只有一个写者:
   *
   *   claimedTick = min(intent.tick, s.lastMoveTick + MAX, s.lastTick + MAX)
   *                 └ 自报值        └ 斜率:单包不能跳太远  └ **服务端时钟:硬上限**
   *
   * ⚠️ **此处是唯一夹取点**。`claimedTick` 在下游被使用多过一处
   * (跳变检查、窗口入队、`cutoff`、`spanTicks`、回写水位),
   * 逐处夹取**漏掉任何一处都会让整条检查失明** —— 所以夹在入口,
   * 之后**一律使用 `claimedTick`**,不再引用 `intent.tick`。
   * 调用方(`room.ts` / `room.colyseus.ts`)**不再重复夹取** ——
   * 两侧都夹会重演「两份等效实现」(task-51 J13 形态)。
   *
   * `s.lastTick` 是 `AntiCheatRoom.tick()` 每帧写入的服务端帧号,攻击者
   * **发报文改不动它**,所以它是「同一帧内重复兑现」的闸门:
   * 同一帧内 `lastMoveTick` 最多被推到 `lastTick + MAX` 就再也拿不到额度。
   */
  const claimedTick = Math.min(
    intent.tick,
    s.lastMoveTick + limits.maxMoveCatchupTicks,
    s.lastTick + limits.maxMoveCatchupTicks,
  );
  /* 额度 = 自报水位之上的增量,**下界 0 而非 1**。
   *
   * 原式 `Math.max(1, …)` 的下界是「每包至少兑现 1 帧」——
   * 报文条数因而**线性放大**总位移:同一 tick 连发 50 包 = 45.9 格且违规分恒 0。
   * 改为 0 后,重复/回退的帧号拿不到额度:位移为 0 的重复包仍放行(心跳无害),
   * 而带位移的重复包被判坐标跳变。
   *
   * 这**故意改变了**「报旧帧仍按 1 帧放行」的旧行为 ——
   * 旧行为正是漏洞的一半,保留它等于保留一半缺口。WS-07 `E14e` 已按新语义重写。
   */
  const dtTicks = Math.max(0, claimedTick - s.lastMoveTick);
  const dist = Math.hypot(intent.x - s.lastX, intent.y - s.lastY);
  const dz = Math.abs(intent.z - s.lastZ);
  const allowed = maxDisplacementPerTick(intent.speedMul ?? 1, limits) * dtTicks;

  /* ── 6.1 坐标跳变 ── */
  if (dist > allowed + 1e-9) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: claimedTick,
      playerId: s.id,
      detail: `单帧位移 ${dist.toFixed(3)} 格 > 上界 ${allowed.toFixed(3)}`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return {
      allowed: false,
      corrected: { x: s.lastX, y: s.lastY, z: s.lastZ },
      violation: v,
    };
  }
  if (intent.z < -1 - 1e-9 || intent.z > maxZ + 1e-9) {
    const v: Violation = {
      kind: ViolationKind.TELEPORT,
      tick: claimedTick,
      playerId: s.id,
      detail: `Z=${intent.z} 越界 [-1, ${maxZ}]`,
      weight: VIOLATION_WEIGHT.TELEPORT,
    };
    record(s, v);
    return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
  }
  void dz;

  /* ── 6.2 窗口式移速 ── */
  s.window.push({ tick: claimedTick, x: intent.x, y: intent.y });
  const cutoff = claimedTick - limits.speedWindowTicks;
  while (s.window.length > 2 && s.window[0].tick < cutoff) s.window.shift();

  const first = s.window[0];
  const spanTicks = claimedTick - first.tick;
  if (spanTicks >= limits.speedWindowTicks) {
    const path = pathLength(s.window);
    const spanS = spanTicks * DT;
    const observed = path / spanS;
    const cap = BASE_MOVE_SPEED * sanitizeMul(intent.speedMul ?? 1, 1, limits.maxSpeedBonusMul)
      * limits.speedWindowTolerance;
    if (observed > cap + 1e-9) {
      const v: Violation = {
        kind: ViolationKind.SPEED,
        tick: claimedTick,
        playerId: s.id,
        detail: `窗口均速 ${observed.toFixed(2)} 格/秒 > 上限 ${cap.toFixed(2)}`,
        weight: VIOLATION_WEIGHT.SPEED,
      };
      record(s, v);
      return { allowed: false, corrected: { x: s.lastX, y: s.lastY, z: s.lastZ }, violation: v };
    }
  }

  s.lastX = intent.x;
  s.lastY = intent.y;
  s.lastZ = intent.z;
  /* 只推进**客户端申报**水位,且单调。绝不碰 `s.lastTick`(服务端时钟)——
     那正是原实现被客户端推着走、越推额度越大的病灶。
     `Math.max` 保证回退的 tick 不会把水位拉回去(否则连发「tick 在 1 与 0 之间
     跳动」的报文可反复重置水位,每包重新拿到 MAX 额度)。 */
  s.lastMoveTick = Math.max(s.lastMoveTick, claimedTick);
  return { allowed: true };
}

function pathLength(win: readonly { x: number; y: number }[]): number {
  let d = 0;
  for (let i = 1; i < win.length; i += 1) {
    d += Math.hypot(win[i].x - win[i - 1].x, win[i].y - win[i - 1].y);
  }
  return d;
}

/**
 * 校验一次攻击。
 * 最小间隔 = `baseAttackIntervalS / (1 + 攻速加成)`;加成被服务端上限钳制。
 *
 * ⚠️ 「钳制」≠「核算」:声明 `1.0` 即拿满 2× 攻速且**不需要任何装备前置**
 * (CR-14 U2 的已知取舍)。服务端**不**核对声明是否与持有物相符 ——
 * 它没有装备数据可核。见 `MoveIntent.speedMul` 注释与 §7。
 */
export function checkAttack(
  s: PlayerAntiCheatState,
  tick: number,
  claimedAttackSpeedBonus = 0,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): Verdict {
  const bonus = sanitizeMul(claimedAttackSpeedBonus, 0, limits.maxAttackSpeedBonus);
  const minIntervalTicks = (limits.baseAttackIntervalS / (1 + bonus)) * TICK_HZ;
  const since = tick - s.lastAttackTick;
  if (since < minIntervalTicks - 1e-9) {
    const v: Violation = {
      kind: ViolationKind.ATTACK_RATE,
      tick,
      playerId: s.id,
      detail: `攻击间隔 ${since.toFixed(2)} 帧 < 最小 ${minIntervalTicks.toFixed(2)} 帧`,
      weight: VIOLATION_WEIGHT.ATTACK_RATE,
    };
    record(s, v);
    return { allowed: false, violation: v };
  }
  s.lastAttackTick = tick;
  return { allowed: true };
}

/* ═══════════════════════════ 5. 物品栏一致性 ═══════════════════════════ */

export interface InventoryOp {
  itemId: number;
  /** 正数 = 获得,负数 = 消耗。 */
  delta: number;
  /** 来源凭证:合成配方哈希 / 掉落实体 id / 采集点 id。无凭证的产出直接拒。 */
  source?: string;
}

export interface InventoryCheckInput {
  tick: number;
  ops: readonly InventoryOp[];
  /** 服务端认可的「可产出集合」:本次 tick 内合法的掉落/合成产物 id。 */
  allowedSources: ReadonlySet<string>;
  /** 当前背包总量(用于总量守恒)。 */
  beforeTotal: number;
  capacity: number;
}

/**
 * 拒因码。每个码对应一条**可判定的守恒律**,便于把违规流水做成指标。
 */
export const InventoryReject = {
  /** 产出没有服务端认可的来源凭证 —— 凭空产出。 */
  FROM_NOTHING: 'ITEM_FROM_NOTHING',
  /** 单帧净变化超过 `MAX_ITEM_DELTA_PER_TICK`。 */
  BURST: 'ITEM_BURST',
  /** 扣减后总量为负 —— 消耗了不存在的东西。 */
  NEGATIVE: 'ITEM_NEGATIVE',
  /** 超出背包容量。 */
  OVERFLOW: 'ITEM_OVERFLOW',
  /** 增量不是整数(浮点刷物品的典型手法)。 */
  FRACTIONAL: 'ITEM_FRACTIONAL',
  /**
   * `ops` 本身不是合法操作数组 —— 报文里它是**纯客户端值**,
   * 而 TS 的 `readonly InventoryOp[]` 只是**编译期声明**,运行时不做任何检查。
   */
  MALFORMED: 'ITEM_MALFORMED',
} as const;
export type InventoryReject = (typeof InventoryReject)[keyof typeof InventoryReject];

const INVENTORY_REJECT_LABEL: Readonly<Record<string, string>> = {
  ITEM_FROM_NOTHING: '凭空产出',
  ITEM_BURST: '单帧脉冲',
  ITEM_NEGATIVE: '总量为负',
  ITEM_OVERFLOW: '容量溢出',
  ITEM_FRACTIONAL: '非整数增量',
  ITEM_MALFORMED: '操作数组格式非法',
};

export interface InventoryCheckResult {
  allowed: boolean;
  afterTotal: number;
  violation?: Violation;
  rejectCode?: InventoryReject;
}

/**
 * 物品栏一致性:
 *  a) 单帧净变化量绝对值 ≤ MAX_ITEM_DELTA_PER_TICK;
 *  b) 任何**产出**(delta > 0)必须带服务端认可的 source;
 *  c) 消耗后的总量不得为负,且不得超过容量 —— 即「总和守恒」。
 *
 * 检查顺序刻意把**凭证**放在最前:凭空产出是最严重的一类,不应被
 * 后面的量级检查抢先命中而失去归因。
 */
export function checkInventory(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  limits: AntiCheatLimits = DEFAULT_LIMITS,
): InventoryCheckResult {
  /* ── ops 形状门(与 checkMove 的 6.0 值域门同族)──
   *
   * `ops` 是报文里**唯一**由客户端提交的部分(`room.colyseus.ts` 的
   * `onMessage('inventory')`),而调用链中间**没有任何运行时校验**:
   * `readonly InventoryOp[]` 只是 TS 编译期声明。
   *
   * 实测:`{"ops":1}` / `{"ops":{}}` / `{"ops":null}` / `{}`(字段缺失)
   * 等**一行合法 JSON** 都会让下面的 `for...of` 抛 `TypeError: input.ops
   * is not iterable` ⇒ 没有裁决对象 ⇒ 调用方的 `if (r.violation)` 拿不到
   * 任何东西,违规分不累计、踢出机制不触发。字符串虽**能**迭代,但那走的是
   * 逐字符路径,判出来的拒因码与"格式非法"完全无关 —— 归因失真。
   *
   * 故先做形状判定,再进入逐条检查:与 checkMove 一样,
   * **判据本身必须先可信**,否则后面的检查只是"恰好"生效。 */
  if (!Array.isArray(input.ops)) {
    return rejectInv(s, input, InventoryReject.MALFORMED,
      `ops 不是数组:${typeof input.ops} ${String(input.ops)}`);
  }
  let net = 0;
  for (const op of input.ops) {
    if (!op || typeof op !== 'object' || !Number.isFinite(op.itemId)) {
      return rejectInv(s, input, InventoryReject.MALFORMED,
        `操作项非法:${JSON.stringify(op)}`);
    }
    if (!Number.isInteger(op.delta)) {
      return rejectInv(s, input, InventoryReject.FRACTIONAL,
        `非整数增量 item=${op.itemId} delta=${op.delta}`);
    }
    if (op.delta > 0 && (!op.source || !input.allowedSources.has(op.source))) {
      return rejectInv(s, input, InventoryReject.FROM_NOTHING,
        `物品 ${op.itemId} 凭空产出(source=${op.source ?? '∅'} 未被服务端认可)`);
    }
    net += op.delta;
  }
  if (Math.abs(net) > limits.maxItemDeltaPerTick) {
    return rejectInv(s, input, InventoryReject.BURST,
      `单帧净变化 ${net} 超上限 ${limits.maxItemDeltaPerTick}`);
  }
  const after = input.beforeTotal + net;
  if (after < 0) {
    return rejectInv(s, input, InventoryReject.NEGATIVE,
      `消耗了不存在的东西:${input.beforeTotal}${net >= 0 ? '+' : ''}${net}=${after} < 0`);
  }
  if (after > input.capacity) {
    return rejectInv(s, input, InventoryReject.OVERFLOW,
      `总量 ${after} 超容量 ${input.capacity}`);
  }
  return { allowed: true, afterTotal: after };
}

function rejectInv(
  s: PlayerAntiCheatState,
  input: InventoryCheckInput,
  code: InventoryReject,
  detail: string,
): InventoryCheckResult {
  const v: Violation = {
    kind: ViolationKind.INVENTORY,
    tick: input.tick,
    playerId: s.id,
    detail: `[${code}] ${INVENTORY_REJECT_LABEL[code]} — ${detail}`,
    weight: VIOLATION_WEIGHT.INVENTORY,
  };
  record(s, v);
  return { allowed: false, afterTotal: input.beforeTotal, violation: v, rejectCode: code };
}

/* ═══════════════════════════ 6. 房间级汇总 ═══════════════════════════ */

export class AntiCheatRoom {
  /**
   * **合并后**的实际限值。⚠️ 构造器传入坏值时它**不是**你传进去的那个对象 ——
   * 而是逐字段回退过的安全副本(见 `mergeLimits`)。
   * 这正是「可读回」的用义:传参的人能立刻看出自己的字段没生效。
   */
  readonly limits: AntiCheatLimits;
  /**
   * 构造时发现的限值问题(空数组 = 传参完全合法)。
   *
   * ⚠️ 存在的理由:`mergeLimits` 取 fail-closed(兜默认而非抛错),
   * 那就必须**让降级可观测** —— 否则它只是又一处静默降级。
   */
  readonly limitsIssues: readonly string[];
  private states = new Map<string, PlayerAntiCheatState>();
  private log: Violation[] = [];

  constructor(limits: AntiCheatLimits | unknown = DEFAULT_LIMITS) {
    /* ★ CR-27 修复点:此前是 `this.limits = limits`(不做任何检查)
       ⇒ 部分对象/非对象会让 `maxMoveCatchupTicks` 变 `undefined`
       ⇒ `claimedTick` 变 `NaN` ⇒ `dist > NaN` 恒 false ⇒ **全部放行**。
       详见 `mergeLimits` 的实测表。 */
    const merged = mergeLimits(limits);
    this.limits = merged.limits;
    this.limitsIssues = merged.issues;
    if (merged.issues.length > 0) {
      /* 打到 stderr:配置错误属**开发者可见**的一类,不该被 20Hz 的日志淹掉。
         (与 WS-13 的 `LOAD_FAIL::` 同一取舍:失败要让门禁能看见。) */
      console.error(
        `[anticheat] 限值非法,已逐字段回退默认值(${merged.issues.length} 项):\n`
        + merged.issues.map((s) => `  · ${s}`).join('\n'),
      );
    }
  }

  join(id: string, tick = 0, x = 0, y = 0, z = 0): PlayerAntiCheatState {
    const s = createAcState(id, tick, x, y, z);
    this.states.set(id, s);
    return s;
  }

  leave(id: string): void {
    this.states.delete(id);
  }

  get(id: string): PlayerAntiCheatState | undefined {
    return this.states.get(id);
  }

  /** 每帧推进:分数衰减 + **服务端时钟水位** + 淘汰被踢的玩家状态。 */
  tick(t: number): void {
    for (const s of this.states.values()) {
      decayScore(s);
      advanceServerClock(s, t);
    }
  }

  move(intent: MoveIntent & { playerId: string }, maxZ = 3): Verdict {
    const s = this.states.get(intent.playerId);
    if (!s) return { allowed: false };
    const v = checkMove(s, intent, this.limits, maxZ);
    if (v.violation) this.log.push(v.violation);
    this.log = this.log.slice(-512);
    return v;
  }

  attack(playerId: string, tick: number, claimedBonus = 0): Verdict {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false };
    const v = checkAttack(s, tick, claimedBonus, this.limits);
    if (v.violation) this.log.push(v.violation);
    return v;
  }

  inventory(playerId: string, input: InventoryCheckInput): InventoryCheckResult {
    const s = this.states.get(playerId);
    if (!s) return { allowed: false, afterTotal: input.beforeTotal };
    const r = checkInventory(s, input, this.limits);
    if (r.violation) this.log.push(r.violation);
    return r;
  }

  /** 全部违规流水(供写入 room_events)。 */
  violations(): readonly Violation[] {
    return this.log;
  }

  countByKind(kind: ViolationKind): number {
    return this.log.filter((v) => v.kind === kind).length;
  }

  kickedPlayers(): string[] {
    return [...this.states.values()].filter((s) => s.kicked).map((s) => s.id);
  }
}
