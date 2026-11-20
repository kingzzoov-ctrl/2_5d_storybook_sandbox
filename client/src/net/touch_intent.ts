/**
 * ★ WS-FND-166:**「轻点 = 攻击」的判定** —— 纯逻辑、零 DOM(可在 node 里断言)。
 *
 * ## 修的是什么(真机实测)
 *
 * 攻击只挂在 `mousedown`(`main.ts`),而虚拟摇杆的 `pointerdown` 对**每一次触摸**
 * 都 `preventDefault()` ⇒ 浏览器不再补发兼容的 `mousedown` ⇒
 * **手机上永远打不出攻击**,而控制台一句话都不说。
 *
 * 现在触屏有三条出口,判定都在这里:
 * ```
 * 1 屏幕上的「攻」按钮        ← 确定性入口,不依赖手势(a11y 也走它)
 * 2 轻点(点一下不拖)        ← 本文件判定:落指→抬指的时长与位移都在阈值内
 * 3 拖动                      ← 移动,不算攻击(否则"想走路却挥刀")
 * ```
 *
 * ## 为什么判定不能留在事件回调里
 *
 * 「多久算长按 / 挪多远算拖动」是**手感契约**;写进回调就没人测得到,
 * 而它坏掉的表现是「手机上有时打不出来」—— 那种形态在 CI 里永远是绿的。
 *
 * ## 阈值从哪来
 *
 * `TAP_MAX_MS = 260`:iOS 的长按阈值约 500ms、双击间隔约 300ms;260 落在
 * 「有意的点」与「按住想拖」之间。`TAP_MAX_TRAVEL_PX = 12`:比摇杆死区
 * (`0.19 × 64 ≈ 12.2px`)略小 —— 手指的抖动算轻点,有意的推杆算拖动。
 */

/** 轻点的最长按压时长(ms) */
export const TAP_MAX_MS = 260;
/** 轻点的最大位移(px)—— 与摇杆死区同量级 */
export const TAP_MAX_TRAVEL_PX = 12;

export interface TapInput {
  /** 落指 → 抬指(ms) */
  durationMs: number;
  /** 落指 → 抬指的最大位移(px) */
  travelPx: number;
}

export interface TapVerdict {
  /** `true` = 这一下算攻击 */
  attack: boolean;
  /** 人读的理由(进 HUD / 自检口径;不许是空串) */
  reason: string;
}

/**
 * 判定一次触摸是不是「轻点攻击」。
 *
 * 四种情形,四种**都说得出话**的返回值:
 * ```
 * 拖动过(travel > TAP_MAX_TRAVEL_PX)  ⇒ 不是攻击(这是移动)
 * 按太久(duration > TAP_MAX_MS)       ⇒ 不是攻击(这是长按)
 * 读数非法(NaN / 负时长)              ⇒ 不是攻击(**不**因为读数坏了就挥刀)
 * 其余                                ⇒ 攻击
 * ```
 * 负对照的意义:非法读数若判成"攻击",会变成「来电挂断那一刻白挥一刀」。
 */
export function tapAttackVerdict(input: TapInput): TapVerdict {
  const t = input.durationMs;
  const d = input.travelPx;
  if (!Number.isFinite(t) || !Number.isFinite(d)) {
    return { attack: false, reason: '轻点判定:读数非法(不攻击)' };
  }
  if (t < 0 || d < 0) {
    return { attack: false, reason: '轻点判定:读数非法(负值,不攻击)' };
  }
  if (d > TAP_MAX_TRAVEL_PX) {
    return { attack: false, reason: `拖动 ${d.toFixed(0)}px ⇒ 移动(不攻击)` };
  }
  if (t > TAP_MAX_MS) {
    return { attack: false, reason: `按住 ${t.toFixed(0)}ms ⇒ 长按(不攻击)` };
  }
  return { attack: true, reason: `轻点 ${t.toFixed(0)}ms / ${d.toFixed(0)}px ⇒ 攻击` };
}