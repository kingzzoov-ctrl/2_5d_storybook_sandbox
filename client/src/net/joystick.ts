/**
 * WS-FND-58 · **虚拟摇杆 → 方向向量**(纯逻辑,零 DOM)。
 *
 * ## 为什么这一层必须与 DOM 分开
 *
 * D-08(owner,2026-11-16)裁定:这是**手机游戏**,**主输入是虚拟摇杆**;
 * WASD 只作桌面/调试兼容。摇杆的真身是一串 `pointermove` 坐标 ——
 * 而「坐标 → 方向」这一步是本模块唯一的**判定**,它要是住在事件回调里,
 * 就等于把判定放进一个 node 里跑不到的地方(本仓的旧形态:注释说它被拦了,
 * 但**一条会变红的断言都没有**)。
 * ⇒ 判定在 `stickVector`(纯函数),DOM 绑定是 `main.ts` 里的薄壳。
 *
 * ## 坐标约定(**与 `net/input.ts` 逐字一致**)
 *
 * ```
 * 屏幕/指针 y 向下        → 本模块输出也用 y 向下(格坐标,不是数学坐标)
 * 手指在基点**上方** dy<0  ⇒ moveY = -1(往北走)
 * 手指在基点**右方** dx>0  ⇒ moveX = +1(往东走)
 * ```
 * 摇杆的 dx/dy 本来就是**屏幕像素**(y 向下),格坐标也是 y 向下 ⇒ 直通,不翻符号。
 * 反过来的写法(翻 y)不会抛错,表现是「往上推,角色往下走」。
 *
 * ## 单入口 ⇒ 一条断言,两个世界
 *
 * `stickVector` 只回答三件事:方向、推力、死区。
 * ```ts
 * stickVector({dx: 300, dy: 400}, {maxRadius: 100})  // ⇒ {x:0.6, y:0.8, magnitude:100}
 *                     ↑ 原始像素              ↑ 手柄半径
 * ```
 * 其余(state machine / 与键盘合并)都建在它上面:`AnalogStick` 只存**基点与当前点**,
 * `mergeCmd` 只做**优先级**(摇杆压 WASD)。
 */

import type { InputCmd } from './prediction.ts';

/**
 * 死区 —— **手柄半径的比例**(不是像素,也不是格)。
 *
 * 用比例而不是像素:同一份代码要跑在 320px 宽的手柄与 96px 的浮窗上,
 * 像素死区会让「小屏上根本推不动」。0.19 的来历:手指抖动的直径约为
 * 拇指托直径的 1/10 ⇒ 半径方向 5% 是纯抖动,19% 留出手指**有意**轻推的余量。
 */
export const JOYSTICK_DEAD_ZONE = 0.19;

/** 默认手柄半径(归一化单位)。生产用像素时由调用方传,见 `STICK_RADIUS_PX`。 */
export const JOYSTICK_MAX_RADIUS = 1;

/**
 * 生产默认手柄半径(像素)—— 触屏拇指轨迹的经验值。
 *
 * ⚠️ 它只影响**手感**(推到满速要多远),不影响判定:
 * 判定全在归一化之后做 ⇒ 改这个数不会让任何断言变红,只会让操作变钝/变敏感。
 */
export const STICK_RADIUS_PX = 64;

/** 摇杆基点之外的**偏移**(与手柄半径**同单位**;触屏上是像素)。 */
export interface StickPoint {
  dx: number;
  dy: number;
}

export interface StickOptions {
  /** 死区,手柄半径的比例(默认 `JOYSTICK_DEAD_ZONE`)。 */
  deadZone?: number;
  /** 手柄最大半径(默认 `JOYSTICK_MAX_RADIUS`)。 */
  maxRadius?: number;
}

/**
 * 摇杆读数。
 *
 * ```ts
 * x, y       归一化方向分量 ∈ [-1,1];两者的模 = 推力比例(0..1)
 * magnitude  截断后的**原始长度**(与输入 dx/dy 同单位,≤ maxRadius)
 * ```
 * 为什么两个都留:方向是**给移动**的(`InputCmd.moveX/moveY`),
 * 长度是**给手感/UI**的(画手柄上的摇杆帽、将来折算速度倍率)。
 * 只留一个的话,另一方迟早被某个调用点重新算一遍(第二份实现)。
 */
export interface StickVector {
  x: number;
  y: number;
  magnitude: number;
}

/** 零向量 —— 每次返回**新对象**(共享常量会被下游就地改坏)。 */
function zero(): StickVector {
  return { x: 0, y: 0, magnitude: 0 };
}

/**
 * ★ 主判据:**触摸偏移 → 归一化方向 + 死区 + 半径截断**。
 *
 * 三种情形,三种返回值:
 * ```
 * 1 死区内(r ≤ deadZone×maxRadius) ⇒ 精确零向量(不是"很小的向量")
 *   理由:死区的作用是**抹掉抖动**;返回 0.02 的向量会让角色以 0.2 速/秒爬行,
 *   而那种「按着不动却在动」只表现为"手感怪",不会报错。
 * 2 超过手柄半径              ⇒ 方向不变,幅值**恰为** maxRadius(截断,不是归一化丢弃)
 *   理由:超程是**常态**(拇指会推出手柄)。丢弃方向 = 角色停住;
 *   按方向匀速 = 想要的"满舵"。
 * 3 两者之间                  ⇒ 线性(推力 = 距离/半径,不是二值开关)
 * ```
 * 非法输入(`NaN` / `Infinity` / `maxRadius <= 0`)一律**零向量**:
 * 让 NaN 流下去的话,`predictStep` 会把 NaN 加进位置,而位置一旦是 NaN
 * 就再也回不来(表现是"角色消失",不是"报错")。
 */
export function stickVector(offset: StickPoint, opts: StickOptions = {}): StickVector {
  const maxRadius = opts.maxRadius ?? JOYSTICK_MAX_RADIUS;
  const deadZone = opts.deadZone ?? JOYSTICK_DEAD_ZONE;
  const r = Math.hypot(offset.dx, offset.dy);
  if (!Number.isFinite(r) || !Number.isFinite(maxRadius) || !(maxRadius > 0)) return zero();
  /* 边界取**死区内侧**:`r === deadAbs` 视为没推。取哪一侧都可以,
     但必须**写死一侧** —— 否则同一条判据在两端各有一个"看起来对"的答案。 */
  if (r <= deadZone * maxRadius) return zero();
  const magnitude = Math.min(r, maxRadius);
  /* 单位方向 × 推力比例;写成 (dx/r)*magnitude/maxRadius 的两步式,
     避免 r 与 magnitude 相除时的二次舍入。 */
  const push = magnitude / maxRadius;
  return { x: (offset.dx / r) * push, y: (offset.dy / r) * push, magnitude };
}

/**
 * 摇杆状态机(基点 + 当前触点)。**不碰 DOM**:传进来的是数字。
 *
 * 为什么要"基点"而不是"相对屏幕中心":手机上的拇指落点由**手指**决定,
 * 不是由画面决定 —— 落点即基点(浮动摇杆),否则拇指要先去找一个固定位置。
 * 这条也是判据:`begin(x,y)` 之后 `(x,y)` 处读出的向量必须是**零**(刚按下不算推)。
 */
export class AnalogStick {
  private readonly opts: StickOptions;
  private down = false;
  private originX = 0;
  private originY = 0;
  private curX = 0;
  private curY = 0;

  constructor(opts: StickOptions = {}) {
    this.opts = opts;
  }

  /** 手指落下:设基点,当前点与之重合(⇒ 向量为零)。 */
  begin(x: number, y: number): void {
    this.down = true;
    this.originX = x;
    this.originY = y;
    this.curX = x;
    this.curY = y;
  }

  /** 手指移动(未 `begin` 时忽略 —— 指针事件可能乱序,不能因此凭空推一下)。 */
  moveTo(x: number, y: number): void {
    if (!this.down) return;
    this.curX = x;
    this.curY = y;
  }

  /** 手指抬起 / 取消:回到零向量(`magnitude === 0`)。 */
  end(): void {
    this.down = false;
    this.curX = this.originX;
    this.curY = this.originY;
  }

  get active(): boolean {
    return this.down;
  }

  /** 基点(画手柄 UI 用)。 */
  get origin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  /** 当前触点(画摇杆帽用)。 */
  get knob(): { x: number; y: number } {
    return { x: this.curX, y: this.curY };
  }

  /** 当前读数;没按下时**恒为零向量**(不是"最后那一下")。 */
  vector(): StickVector {
    if (!this.down) return zero();
    return stickVector({ dx: this.curX - this.originX, dy: this.curY - this.originY }, this.opts);
  }
}

/**
 * ★ 优先级:D-08 说摇杆是**主**输入,WASD 是桌面兼容。
 *
 * 所以合并规则只有一条:**摇杆推了(幅值 > 0)就用摇杆,否则回落到键盘**。
 * ```
 * 推着摇杆 + 按着 W  ⇒ 摇杆方向(不是两者相加)
 * 松开摇杆 + 按着 W  ⇒ W 的方向(桌面/调试照常)
 * ```
 * 为什么**不相加**:相加会让"摇杆往东 + WASD 往北"走出东北 45°,
 * 而玩家的意图是把手从摇杆上抬起、改按键盘 —— 两个输入源同时生效时,
 * 谁的手感都不对,且没有任何东西会报错。
 *
 * `seq` / `jump` **一律由键盘那份给**(`base`):`seq` 的单调性是
 * `ackedSeq` 回执的地基,合并时不许产生跳跃(见 `input.ts` 的 `nextCmd` 注释)。
 */
export function mergeCmd(base: InputCmd, stick: StickVector): InputCmd {
  if (!(stick.magnitude > 0)) return base;
  return { ...base, moveX: stick.x, moveY: stick.y };
}