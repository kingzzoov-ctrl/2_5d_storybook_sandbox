/**
 * D-08 第二步 · **虚拟摇杆的屏幕形态**(纯 DOM,零 three)。
 *
 * ## 为什么要有这个文件
 *
 * D-08(owner,2026-11-16)裁:主输入 = 手机虚拟摇杆。判定层
 * (`net/joystick.ts` 的 `stickVector` / `AnalogStick`)已绿,但屏幕上**没有手柄** ——
 * 玩家的手指按下去,画面里什么也不出现,于是"摇杆是主输入"在手机上表现为
 * "推着屏幕乱走"。判定再对,看不见就等于没有。
 *
 * ## 分层(本文件不碰的东西)
 *
 * ```
 * net/joystick.ts   判定:死区 / 截断 / 方向     ← 已绿,零 DOM,本文件**只读常量**
 * ui/joystick_ui.ts 绘制:底盘 + 摇杆帽          ← 本文件,零 three、零 server、零构建
 * main.ts           接线:落指 show → 拖 moveTo → 抬手 hide
 * ```
 *
 * ## 设计契约(改样式前先读这一段)
 *
 * **任务**:让拇指落下的一瞬间,**看不见的东西变成看得见的东西** ——
 * 底盘出现在手指底下(浮动摇杆,不留固定位置),帽跟着推力走,抬手即消失。
 *
 * **色板**(照抄 `client/index.html` 与 `three/boot.ts` 的 `makeHud`,不另起一套):
 * ```
 * 深底    #121a2b  /  rgba(18,24,38,·)
 * 主字    #e8eefc
 * 次字    #8fa6c8
 * 强调    #a8f0c8(薄荷:与 #status 的"已连上"同一个色)
 * 描边    rgba(120,150,210,.28)
 * ```
 *
 * **尺寸**(单位 px,8 的节奏):
 * ```
 * 推程  64  = STICK_RADIUS_PX ← 与逻辑层同一个数(满舵距离)
 * 帽径  44  (KNOB_RADIUS_PX = 22)
 * 底盘  172 = 2×(64+22)       ← 帽推到极限**正好贴住盘边**,不出圈
 * 死区圈 24.3 = 2×0.19×64     ← 把"死区"画出来:小抖动帽不动,是可解释的
 * 留白  8   = BASE_MARGIN_PX  ← 底盘整体被夹进视口,边缘落指不会被顶出屏幕
 * ```
 *
 * **动效**(只承载状态变化,不做装饰):
 * ```
 * 出现  160ms cubic-bezier(.34,1.56,.64,1)   scale .72→1 + opacity 0→1(轻微过冲)
 * 消失  120ms cubic-bezier(.4,0,1,1)         scale →.9 + opacity →0
 * 帽位移 0ms —— **直接赋值**,不加过渡
 * ```
 *
 * ## Do / Don't
 * ```
 * Do   帽用 transform 位移(合成层,拖动时不动 layout)
 * Do   抬手**立刻**把帽归位(推力=0 必须看得见),底盘再淡出
 * Do   prefers-reduced-motion ⇒ 出现/消失都不做过渡
 * Do   整层 pointer-events:none —— 手柄不能吃掉本该给画布的指针事件
 * Don't 用 `transition: all`;Don't 给帽的 translate 加过渡(手指会"拖不动")
 * Don't 把帽的位移上限写成另一个数(必须与逻辑层同一个 STICK_RADIUS_PX)
 * Don't 在构造里碰 document(测试环境无 DOM,import 必须不抛)
 * Don't 用 overflow:hidden 掩盖帽跑出底盘 —— 靠几何:`BASE = TRAVEL + KNOB`
 * ```
 */

import { JOYSTICK_DEAD_ZONE, STICK_RADIUS_PX } from '../net/joystick.ts';

/** 摇杆帽半径(px)。44px 直径 ≈ 成人拇指肚,是能看清、又不挡视线的档位。 */
export const KNOB_RADIUS_PX = 22;

/**
 * 帽的推程上限(px)—— **就是逻辑层的满舵距离**。
 *
 * ⚠️ 这个常量必须等于 `STICK_RADIUS_PX`(同一条赋值,不是两个 64):
 * 帽推到圈边 = 满舵,玩家才有"我推到底了"的确定性;若视觉推程小于逻辑推程,
 * 表现是"推到边了却只有 6 成速",而**没有任何东西会报错**。
 */
export const STICK_TRAVEL_PX = STICK_RADIUS_PX;

/**
 * 底盘半径 = 推程 + 帽半径 ⇒ 帽推到极限时**正好贴住盘边**。
 *
 * 这一行就是"帽不许飞出圈"的**机械**保证:不需要 overflow 裁剪
 * (`ui/joystick_ui.ts` 里没有任何 hidden),几何本身成立
 * (`tests/WS-FND-60-joystick-ui.test.ts` FND60-7 钉住)。
 */
export const STICK_BASE_RADIUS_PX = STICK_TRAVEL_PX + KNOB_RADIUS_PX;

/** 底盘离视口边缘的最小留白(px)。8 = 8px 节奏的基准格。 */
export const BASE_MARGIN_PX = 8;

/** 死区半径(px)—— 由**逻辑层的比例**算出,不另存一个像素数。 */
export const DEAD_ZONE_RADIUS_PX = JOYSTICK_DEAD_ZONE * STICK_TRAVEL_PX;

export interface Vec2 {
  x: number;
  y: number;
}

/** 零向量(每次新对象:共享常量会被下游就地改坏)。 */
function zero2(): Vec2 {
  return { x: 0, y: 0 };
}

/**
 * ★ 纯函数:**手指相对基点的偏移 → 摇杆帽的位移**(夹取 + 死区)。
 *
 * 与 `net/joystick.ts` 的 `stickVector` **同口径、同单位**(像素),但**不同用途**:
 * ```
 * stickVector → 归一化方向 + 推力     (给移动)
 * knobOffset  → 帽相对基点的像素     (给绘制)
 * ```
 * 两者必须同口径,否则玩家看到"帽推到底了"却在以半速走 —— 视觉在说谎,且不报错。
 *
 * 三种情形:
 * ```
 * 1 r ≤ deadZone×radius  ⇒ 精确 {x:0,y:0}(帽不动:小抖动不该让帽颤)
 * 2 r >  radius          ⇒ 方向不变,幅值**恰为** radius(夹取,不是归一化丢弃)
 * 3 之间                  ⇒ 原样返回(不缩、不抬)
 * ```
 * 非法输入(`NaN` / `Infinity` / `radius <= 0`)一律**零向量**:
 * `NaN` 一旦写进 `style.transform`,底盘的帽会整个消失或跑到左上角,
 * 而控制台**一句话都不说**。
 */
export function knobOffset(
  dx: number,
  dy: number,
  radius: number,
  deadZone: number = JOYSTICK_DEAD_ZONE,
): Vec2 {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return zero2();
  if (!Number.isFinite(radius) || !(radius > 0)) return zero2();
  const r = Math.hypot(dx, dy);
  if (!Number.isFinite(r)) return zero2();
  const dead = Number.isFinite(deadZone) && deadZone > 0 ? deadZone : 0;
  /* 边界取**死区内侧**(与 `stickVector` 逐字同一条:`r <= dead` 视为没推)。 */
  if (r <= dead * radius) return zero2();
  const clamped = r > radius ? radius : r;
  const scale = clamped / r;
  /* r <= radius 时 scale === 1 ⇒ 原样返回(方向与长度都不做二次舍入)。 */
  return { x: dx * scale, y: dy * scale };
}

/**
 * ★ 纯函数:**落指点 → 底盘圆心**(夹进视口)。
 *
 * 浮动摇杆的基点由**手指**决定,所以它会落在屏幕最边上一格 ——
 * 那时若照原样画,底盘有一半在屏幕外("推程圈"缺一段,玩家会以为手柄坏了)。
 * ⇒ 把圆心夹进"半径 + 留白"的矩形里。
 *
 * 视口比底盘还窄(极窄分屏)时:**居中**,而不是把上下界夹成一条线
 * (`Math.min(Math.max(...))` 在 `lo > hi` 时会返回 `lo` ⇒ 底盘又跑出去)。
 */
export function placeBase(
  x: number,
  y: number,
  radius: number,
  viewWidth: number,
  viewHeight: number,
  margin: number = BASE_MARGIN_PX,
): Vec2 {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const m = Number.isFinite(margin) && margin > 0 ? margin : 0;
  const cx = Number.isFinite(x) ? x : 0;
  const cy = Number.isFinite(y) ? y : 0;
  const w = Number.isFinite(viewWidth) ? viewWidth : 0;
  const h = Number.isFinite(viewHeight) ? viewHeight : 0;
  const loX = r + m;
  const hiX = w - r - m;
  const loY = r + m;
  const hiY = h - r - m;
  return {
    x: hiX >= loX ? Math.min(Math.max(cx, loX), hiX) : w / 2,
    y: hiY >= loY ? Math.min(Math.max(cy, loY), hiY) : h / 2,
  };
}

/* ─────────────────────────── 样式(内联字符串,零构建)───────────────────────────
   ⚠️ 不建 `.css` 文件:客户端是"vite + 直接 `<script type=module> src=main.ts`",
   一个额外样式表就多一条打包/路径假设,而 `three/boot.ts` 的 `makeHud` 早就
   用 `style.cssText` 立好了先例(色板也在那里)。 */

const S_LAYER = 'position:absolute;inset:0;z-index:25;pointer-events:none;'
  + 'contain:layout style;';

const S_BASE = `position:absolute;left:0;top:0;width:${STICK_BASE_RADIUS_PX * 2}px;`
  + `height:${STICK_BASE_RADIUS_PX * 2}px;border-radius:50%;display:none;opacity:0;`
  + 'background:radial-gradient(circle at 50% 42%,'
  + 'rgba(34,50,78,.56) 0%,rgba(16,24,38,.44) 62%,rgba(10,16,26,.26) 100%);'
  + 'border:1px solid rgba(120,150,210,.30);'
  + 'box-shadow:inset 0 0 26px rgba(120,170,255,.12),0 6px 20px rgba(3,8,16,.38);'
  + 'transform-origin:50% 50%;transform:scale(.72);will-change:opacity,transform;';

/** 满舵圈(虚线):圈边 = 推到底。虚线而不是实线 —— 它是"标尺",不是"边界框"。 */
const S_TRAVEL_RING = `position:absolute;border-radius:50%;`
  + `left:${STICK_BASE_RADIUS_PX - STICK_TRAVEL_PX}px;`
  + `top:${STICK_BASE_RADIUS_PX - STICK_TRAVEL_PX}px;`
  + `width:${STICK_TRAVEL_PX * 2}px;height:${STICK_TRAVEL_PX * 2}px;`
  + 'border:1px dashed rgba(168,240,200,.22);';

/** 死区圈(实心淡薄荷):解释"为什么小动作没用",把判据画成看得见的东西。 */
const S_DEAD_RING = `position:absolute;border-radius:50%;`
  + `left:${STICK_BASE_RADIUS_PX - DEAD_ZONE_RADIUS_PX}px;`
  + `top:${STICK_BASE_RADIUS_PX - DEAD_ZONE_RADIUS_PX}px;`
  + `width:${DEAD_ZONE_RADIUS_PX * 2}px;height:${DEAD_ZONE_RADIUS_PX * 2}px;`
  + 'background:rgba(168,240,200,.10);border:1px solid rgba(168,240,200,.26);';

const S_KNOB = `position:absolute;border-radius:50%;`
  + `left:${STICK_BASE_RADIUS_PX - KNOB_RADIUS_PX}px;`
  + `top:${STICK_BASE_RADIUS_PX - KNOB_RADIUS_PX}px;`
  + `width:${KNOB_RADIUS_PX * 2}px;height:${KNOB_RADIUS_PX * 2}px;`
  + 'background:radial-gradient(circle at 36% 30%,#f4fbff 0%,#cfeede 42%,'
  + '#a8f0c8 72%,#4d8f76 100%);'
  + 'border:1px solid rgba(255,255,255,.55);'
  + 'box-shadow:0 3px 10px rgba(4,10,20,.45),inset 0 1px 0 rgba(255,255,255,.75);'
  + 'transform:translate3d(0px,0px,0);will-change:transform;';

const EASE_IN = 'cubic-bezier(.34,1.56,.64,1)';
const EASE_OUT = 'cubic-bezier(.4,0,1,1)';
const ENTER_MS = 160;
const EXIT_MS = 120;

/**
 * 虚拟摇杆的 DOM 层。
 *
 * **构造时不碰 `document`** —— 所有 DOM 访问都在 `mount(el)` 里。
 * 理由是可测性:node 里 `import` 本模块必须不抛,否则
 * `tests/WS-FND-60-joystick-ui.test.ts` 连第一行都跑不到,
 * `knobOffset` 的夹取就永远没人钉。
 */
export class JoystickUI {
  private layer: HTMLDivElement | null = null;
  private base: HTMLDivElement | null = null;
  private knob: HTMLDivElement | null = null;
  private view: Window | null = null;
  private reduceMotion = false;
  private visibleFlag = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  /** 是否已经挂进 DOM(纯读,不触发任何 DOM 访问)。 */
  get mounted(): boolean {
    return this.layer !== null;
  }

  /** 底盘当前是否可见(自检口径用;不含"正在淡出"这种中间态)。 */
  get visible(): boolean {
    return this.visibleFlag;
  }

  /**
   * 把摇杆层挂到容器里。幂等(重复调用不重复建 DOM)。
   *
   * `el` 给 `#app` 而不是 `document.body`:层要跟画布同一个坐标系
   * (`#app` 是 `position:relative`),挂到 body 上时画布一旦不再是全屏就会错位。
   */
  mount(el: HTMLElement): void {
    if (this.layer !== null) return;
    if (el === null || el === undefined || typeof el.appendChild !== 'function') return;
    const doc = el.ownerDocument;
    if (doc === null || typeof doc.createElement !== 'function') return;

    const view = doc.defaultView;
    this.view = view;
    /* reduced-motion 在**挂载时**取一次:这个偏好不会在一次会话里频繁变,
       而"每次落指都问一次 matchMedia"会在 pointerdown 里多一次样式重算。 */
    this.reduceMotion = view !== null && typeof view.matchMedia === 'function'
      ? view.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

    const layer = doc.createElement('div');
    /* 纯视觉层:不进可访问性树,也不吃指针事件。
       ⚠️ 这不是"漏了 tabindex":键盘可达性由 WASD 承担(桌面兼容路径),
          摇杆是**触屏**的、不可聚焦的指示器 —— 给它 tabindex 反而会让
          Tab 停在两个空 div 上。 */
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = S_LAYER;

    const base = doc.createElement('div');
    base.style.cssText = S_BASE;

    const travelRing = doc.createElement('div');
    travelRing.style.cssText = S_TRAVEL_RING;

    const deadRing = doc.createElement('div');
    deadRing.style.cssText = S_DEAD_RING;

    const knob = doc.createElement('div');
    knob.style.cssText = S_KNOB;

    /* 顺序即层级:圈在下、帽在上(帽推到盘边时要盖住虚线圈,才显得"到位")。 */
    base.append(travelRing, deadRing, knob);
    layer.appendChild(base);
    el.appendChild(layer);

    this.layer = layer;
    this.base = base;
    this.knob = knob;
  }

  /**
   * 落指:底盘在 `(x,y)` 出现(夹进视口),帽归零。
   *
   * 重复调用(同一根手指又一次 down)只重设位置,**不重播入场动画** ——
   * 否则手指微抖时底盘会一闪一闪。
   */
  show(x: number, y: number): void {
    const base = this.base;
    if (base === null) return; /* 未挂载:静默忽略(无 DOM 环境不抛) */
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.clearHideTimer();

    const w = this.view?.innerWidth ?? 0;
    const h = this.view?.innerHeight ?? 0;
    const at = placeBase(x, y, STICK_BASE_RADIUS_PX, w, h);
    base.style.left = `${at.x - STICK_BASE_RADIUS_PX}px`;
    base.style.top = `${at.y - STICK_BASE_RADIUS_PX}px`;

    this.paintKnob(0, 0);
    base.style.display = 'block';
    this.visibleFlag = true;

    if (this.reduceMotion) {
      base.style.transition = 'none';
      base.style.opacity = '1';
      base.style.transform = 'scale(1)';
      return;
    }
    /* 入场:先落到 .72,抬到 1。**必须**先强制一帧(`offsetWidth`)——
       否则浏览器会把"display:block"和"目标 transform"合并成一次样式计算,
       过渡根本不播,而控制台一句话都不说。 */
    base.style.transition = `opacity ${ENTER_MS}ms ${EASE_IN},transform ${ENTER_MS}ms ${EASE_IN}`;
    base.style.opacity = '0';
    base.style.transform = 'scale(.72)';
    void base.offsetWidth;
    base.style.opacity = '1';
    base.style.transform = 'scale(1)';
  }

  /**
   * 手指拖到相对基点的 `(dx,dy)`(屏幕像素,y 向下)。
   *
   * 帽的位移**直接赋值、无过渡**:1:1 跟手是直接操作的全部意义,
   * 给它加 `transition` 会让帽"追"手指,手感立刻变成"黏"。
   */
  moveTo(dx: number, dy: number): void {
    if (this.knob === null || !this.visibleFlag) return;
    this.paintKnob(dx, dy);
  }

  /**
   * 抬手 / 取消:帽**立刻**归位,底盘淡出后 `display:none`。
   *
   * 用定时器兜底而不是只靠 `transitionend`:`transitionend` 在后台标签页、
   * 被 `display:none` 打断、或 reduced-motion 下**不会**发 ——
   * 那时底盘会永远停在屏幕上(且不报错)。定时器是那条确定的出口。
   */
  hide(): void {
    const base = this.base;
    if (base === null || !this.visibleFlag) return;
    this.visibleFlag = false;
    this.paintKnob(0, 0);
    this.clearHideTimer();
    if (this.reduceMotion) {
      this.finishHide();
      return;
    }
    base.style.transition = `opacity ${EXIT_MS}ms ${EASE_OUT},transform ${EXIT_MS}ms ${EASE_OUT}`;
    base.style.opacity = '0';
    base.style.transform = 'scale(.9)';
    this.hideTimer = setTimeout(() => { this.finishHide(); }, EXIT_MS + 40);
  }

  /** 拆掉 DOM(页面卸载时调)。之后 `mounted === false`,方法退化为空操作。 */
  dispose(): void {
    this.clearHideTimer();
    this.visibleFlag = false;
    const layer = this.layer;
    if (layer !== null) {
      if (typeof layer.remove === 'function') layer.remove();
      else layer.parentElement?.removeChild(layer);
    }
    this.layer = null;
    this.base = null;
    this.knob = null;
    this.view = null;
  }

  /** 把帽摆到 `knobOffset` 给出的位置(非法输入已被钳成 0,不会有 NaN 进 style)。 */
  private paintKnob(dx: number, dy: number): void {
    const knob = this.knob;
    if (knob === null) return;
    const off = knobOffset(dx, dy, STICK_TRAVEL_PX);
    knob.style.transform = `translate3d(${off.x.toFixed(2)}px,${off.y.toFixed(2)}px,0)`;
  }

  private finishHide(): void {
    this.clearHideTimer();
    const base = this.base;
    if (base === null) return;
    base.style.display = 'none';
    base.style.opacity = '0';
    base.style.transform = 'scale(.9)';
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}

/** 工厂(与 `boot()` / `createSession()` 同形:调用点不必写 `new`)。 */
export function createJoystickUI(): JoystickUI {
  return new JoystickUI();
}