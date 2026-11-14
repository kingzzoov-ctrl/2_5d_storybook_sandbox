/**
 * WASD → `InputCmd` 的**生产端**(客户端输入层,task-83 选乙)。
 *
 * ## 这个文件解决的是什么
 *
 * `net/prediction.ts` 的四族(`predictStep` / `reconcile` / `resimulate` / `pruneCmds`)
 * 一直**没有生产者**:它们要 `InputCmd`,而客户端从来没人造过 ——
 * WASD 当时驱动的是**相机平移**(`three/boot.ts` 的 `pan.x += …`)。
 * ⇒ 预测器整套在仓库里存在、有单测、却**在生产链上零引用**。
 *
 * `docs/TASK-83-wasd-three-options.md` 把这件事列成产品裁决,三个选项是:
 * ```
 * 甲  保持「WASD 只动镜头」   ⇒ 预测器永远没有输入源
 * 乙  WASD 驱**角色**         ⇒ 客户端要有输入生产者(本文件)
 * 丙  另设一套移动键          ⇒ 与手册的 WASD 冲突
 * ```
 * ⇒ **2026-11-14 定为「乙」**(外部审计 U1 同意)。
 *
 * ## 坐标约定(必须与 `three/boot.ts` 逐字一致)
 *
 * ```
 * W / ↑ ⇒ moveY = -1      A / ← ⇒ moveX = -1
 * S / ↓ ⇒ moveY = +1      D / → ⇒ moveX = +1
 * ```
 * ⚠️ 这是**格坐标**(y 向下,与 `telegraph_center.ts` / `playerGx,playerGy` 同向),
 * **不是**数学坐标。选错方向的表现是「按 W 往下走」——
 * 而它**不会**报错、也不会让任何断言变红(除非有人像这条一样把方向写进断言)。
 *
 * ## 为什么把这个纯逻辑从 DOM 里拆出来
 *
 * `attachKeyboard()` 需要一个 `KeyboardEventTarget`(浏览器里是 `window`)。
 * 但**方向映射本身**不该依赖 DOM —— 否则它在 node 里测不了,
 * 而「测不了」的下一步就是「没人测」。
 * ⇒ `dirFromPressed()` 只吃一个 `(key) => boolean`,DOM 绑定是它外面的薄壳。
 */

import type { InputCmd } from './prediction.ts';

/**
 * 键位表 —— **单一事实来源**。
 *
 * ⚠️ 键名一律用 `KeyboardEvent.key.toLowerCase()` 的形式(不是 `code`)。
 * 用 `code` 会让「同一物理键在不同布局下」表现不一致(`KeyW` vs `,`);
 * 用 `key` 的代价是非拉丁布局下 WASD 可能不成立 —— 本仓只做前者,
 * 并且**把这件事写在这里**,而不是让它成为一条没人知道的隐含前提。
 */
export const MOVE_KEYS = {
  up: ['w', 'arrowup'],
  down: ['s', 'arrowdown'],
  left: ['a', 'arrowleft'],
  right: ['d', 'arrowright'],
} as const;

/** 方向输入 —— 未归一化(归一化在 `predictStep` 内做,见 `normalizeInput`)。 */
export interface MoveDir {
  moveX: number;
  moveY: number;
}

/**
 * 由「哪些键按着」算出方向。**纯函数** —— 这是本模块唯一值得单测的部分。
 *
 * ⚠️ 斜向**不在这里归一化**:`predictStep` 自己调 `normalizeInput`,
 * 在两层各归一化一次会让「斜向不比直向快」这条性质有两个实现
 * (而两份实现迟早分叉)。这里只回答「按了哪些方向」。
 */
export function dirFromPressed(isDown: (key: string) => boolean): MoveDir {
  let moveX = 0;
  let moveY = 0;
  if (MOVE_KEYS.left.some(isDown)) moveX -= 1;
  if (MOVE_KEYS.right.some(isDown)) moveX += 1;
  if (MOVE_KEYS.up.some(isDown)) moveY -= 1;
  if (MOVE_KEYS.down.some(isDown)) moveY += 1;
  return { moveX, moveY };
}

/**
 * 输入源:维护「按下的键」并**按 tick 产出** `InputCmd`。
 *
 * `seq` **单调递增且每次产出都加一**,包括零输入的那些 tick。
 * 理由:`seq` 是「客户端命令序号」,它的用途是让服务端回执能说
 * 「我处理到第几个了」(`ackedSeq`)。若零输入时不发命令,
 * 服务端就永远不知道玩家**松手了** —— 表现为「松手后角色继续走」。
 */
export class InputSource {
  private readonly down = new Set<string>();
  private seq = 0;
  private jumpLatched = false;

  /** 按下(幂等:重复 keydown 不会重复计数 —— 浏览器会自动重复)。 */
  press(key: string): void {
    const k = key.toLowerCase();
    this.down.add(k);
    if (k === ' ' || k === 'spacebar') this.jumpLatched = true;
  }

  /** 松开。 */
  release(key: string): void {
    this.down.delete(key.toLowerCase());
  }

  /** 失焦时必须清空 —— 否则「切窗口时按着的 W」会永远生效。 */
  clear(): void {
    this.down.clear();
    this.jumpLatched = false;
  }

  /** 当前按下的键数(自检用)。 */
  get pressedCount(): number {
    return this.down.size;
  }

  /** 当前方向(不推进 seq)。 */
  dir(): MoveDir {
    return dirFromPressed((k) => this.down.has(k));
  }

  /**
   * 产出一条命令并推进 `seq`。
   * `jump` 是**锁存**的:按下空格后,恰好一条命令带 `jump: true`
   * (否则「按住空格」会在 20Hz 下每秒发 20 次跳跃)。
   */
  nextCmd(): InputCmd {
    const d = this.dir();
    const jump = this.jumpLatched;
    this.jumpLatched = false;
    this.seq += 1;
    return { seq: this.seq, moveX: d.moveX, moveY: d.moveY, jump };
  }
}

/** `attachKeyboard` 需要的最小 DOM 形状 —— 便于用假对象测(不引 DOM 类型)。 */
export interface KeyboardEventTarget {
  addEventListener(type: 'keydown' | 'keyup' | 'blur', fn: (ev: { key: string }) => void): void;
  removeEventListener(type: 'keydown' | 'keyup' | 'blur', fn: (ev: { key: string }) => void): void;
}

/**
 * 把 `InputSource` 绑到键盘。**薄壳**:只做三件事——按下 / 松开 / 失焦清空。
 *
 * 返回解绑函数(`dispose` 时调用;不绑两次监听是调用方的责任)。
 */
export function attachKeyboard(target: KeyboardEventTarget, source: InputSource): () => void {
  const onDown = (ev: { key: string }): void => source.press(ev.key);
  const onUp = (ev: { key: string }): void => source.release(ev.key);
  /* ⚠️ 失焦必须清空:否则「按住 W → 切到别的窗口 → 松手」时,
     keyup 会发给另一个窗口 ⇒ 本页的 W **永远按着** ⇒ 角色一直走。 */
  const onBlur = (): void => source.clear();
  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  target.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
    target.removeEventListener('blur', onBlur);
  };
}
