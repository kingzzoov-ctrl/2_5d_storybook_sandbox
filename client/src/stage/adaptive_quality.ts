/**
 * 自适应渲染分辨率:帧率持续偏低就把像素比降一档。
 *
 * 实测(同一画面、390 宽触屏视口):像素比 2 ⇒ 18–21 FPS,像素比 1 ⇒ 44–48 FPS,
 * 场景只有几十个 draw call ⇒ 瓶颈是像素填充,不是几何或绘制调用。
 * 手机屏的设备像素比常是 3,而 `boot` 此前固定取 min(dpr, 2),弱机上直接卡。
 *
 * 只降不升:升回去会让帧率在两档之间来回抖。纯函数,node 里可直接断言。
 */

/** 像素比的档位,从高到低。 */
export const PIXEL_RATIO_STEPS: readonly number[] = [2, 1.5, 1.25, 1];
/** 低于它算「卡」。 */
export const LOW_FPS = 30;
/** 连续几个统计窗口都卡才降档(启动加载期的低帧率不该触发)。 */
export const LOW_WINDOWS = 2;

export interface QualityStep {
  ratio: number;
  /** 连续低帧率窗口数(降档后清零) */
  lowStreak: number;
}

/**
 * 喂一个统计窗口的帧率,返回新的像素比与连续低帧窗口数。
 * `fps` 非有限或 ≤ 0(页面在后台 / 还没统计出来)⇒ 不动,也不累计。
 */
export function adaptPixelRatio(current: number, fps: number, lowStreak: number): QualityStep {
  if (!Number.isFinite(fps) || fps <= 0) return { ratio: current, lowStreak };
  if (fps >= LOW_FPS) return { ratio: current, lowStreak: 0 };
  const streak = lowStreak + 1;
  if (streak < LOW_WINDOWS) return { ratio: current, lowStreak: streak };
  const lower = PIXEL_RATIO_STEPS.find((r) => r < current - 1e-9);
  return { ratio: lower === undefined ? current : lower, lowStreak: 0 };
}
