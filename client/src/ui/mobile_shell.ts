/**
 * ★ WS-FND-166:**手机浏览器的"外壳"契约** —— 纯逻辑、零 DOM(可在 node 里断言)。
 *
 * ## 两件在真机上一定会咬人的事
 *
 * ```
 * 1 iOS / Android 长按画布 ⇒ 弹原生菜单(contextmenu) + 选中文本(selectstart)
 *   ⇒ 面板被一层蓝色选区盖住、摇杆拖到一半弹出菜单。用户以为"游戏卡了"。
 * 2 prefers-reduced-motion 只覆盖了摇杆(`ui/joystick_ui.ts`),面板的
 *   打开动画(淡入 + 上移)照旧播 ⇒ 前庭敏感用户仍然被晃。
 * ```
 *
 * 判定都在这里:手势抑制注册的是**哪几个事件**、面板淡入的 alpha 怎么算。
 * 事件绑定的薄壳在 `main.ts`(装配根)。
 */

/** 需要被抑制的原生手势事件(顺序即注册顺序) */
export const SUPPRESSED_GESTURES = ['contextmenu', 'selectstart', 'dragstart'] as const;
export type SuppressedGesture = (typeof SUPPRESSED_GESTURES)[number];

/**
 * 能被本模块注册监听的目标。
 *
 * 只要 `addEventListener` 的结构就够(`window` / `document` 都满足)——
 * 于是判据可以喂一个**假目标**进去,逐条检查"注册了哪几个事件、有没有 preventDefault"。
 */
export interface GestureTarget {
  addEventListener(type: string, fn: (ev: { preventDefault(): void }) => void): void;
  removeEventListener?(type: string, fn: (ev: { preventDefault(): void }) => void): void;
}

/**
 * 抑制原生手势(返回**卸载函数**)。
 *
 * ⚠️ 只对这三个事件 `preventDefault` —— 不是"把整页的默认行为全关掉":
 * 指针事件、键盘、滚动都照旧(它们由各自的处理器负责)。
 * 触屏上的"长按选中/长按弹菜单"因此不再打断操作。
 */
export function suppressNativeGestures(target: GestureTarget): () => void {
  for (const type of SUPPRESSED_GESTURES) target.addEventListener(type, gestureHandler);
  return () => {
    for (const type of SUPPRESSED_GESTURES) target.removeEventListener?.(type, gestureHandler);
  };
}

/**
 * 抑制器本身(唯一的那个 handler)。
 *
 * 单独导出是给**判据**用的:喂一个假目标注册完,再逐条驱动这个 handler,
 * 就能证明「它真的 `preventDefault`」—— 否则那句 `ev.preventDefault()`
 * 在 node 里谁都没执行过(与"只 import 不断言"是同一形态)。
 */
export const gestureHandler = (ev: { preventDefault(): void }): void => { ev.preventDefault(); };

/** 面板淡入的最淡值(0.35 = 面板从"半透明"浮现,不是从"看不见"开始) */
export const PANEL_ALPHA_MIN = 0.35;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * ★ 面板覆盖层的 **alpha** —— `prefers-reduced-motion` 也在这一处生效。
 *
 * ```
 * reduceMotion = true   ⇒ 恒 1(直接出现,不淡入、不上移)
 * 其余                  ⇒ 0.35 + 0.65 × clamp01(openProgress)
 * ```
 * 为什么不是"把动画时长改小":`reduced-motion` 要的是**没有运动**;
 * 缩短时长仍然在动。而 alpha 只在 0.35→1 之间(位置不动)—— 那是可接受的降级。
 *
 * 负对照:`openProgress = NaN` / 越界值一律夹到 `[0,1]`,
 * 否则 `globalAlpha = NaN` 会让整个面板**消失**,而控制台一句话都不说。
 */
export function panelAnimAlpha(openProgress: number, reduceMotion: boolean): number {
  if (reduceMotion) return 1;
  return PANEL_ALPHA_MIN + (1 - PANEL_ALPHA_MIN) * clamp01(openProgress);
}

/** `matchMedia` 的最小结构(判据可以喂一个假的 view) */
export interface MediaView {
  matchMedia?: (query: string) => { matches: boolean };
}

/** 是否请求"减少动效"(拿不到 `matchMedia` 时**当 false**:默认保留动效,不静默改变观感) */
export function prefersReducedMotion(view: MediaView | null | undefined): boolean {
  if (view === null || view === undefined) return false;
  const mm = view.matchMedia;
  if (typeof mm !== 'function') return false;
  try {
    return mm.call(view, '(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    /* 某些嵌入环境的 matchMedia 会对未知查询抛错 —— 那不该把启动打挂 */
    return false;
  }
}