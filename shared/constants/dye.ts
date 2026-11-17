/**
 * 染色(209 32 色气压染色枪)的距离衰减曲线 —— 进冻结层。
 *
 * ## 授权
 *
 * owner 2026-11-17 授权「冻结层解锁」(`docs/RULINGS-DRAFT.md` 4.3 U5
 * 「染色衰减曲线**进冻结层**」),登记见 `shared/contracts/FREEZE.md` 的 D-19 条。
 *
 * ## 曲线形态的出处
 *
 * `docs/WS-09-client-render.md` §U5 的对照表里,`sprayAttenuation` 的距离衰减
 * 写的是 **线性**;「喷枪距离越远越淡」也写在 `client/src/stage/dye_overlay.ts`
 * 的 `strength` 字段注释里(0..1)。本文件把这两处口径固化成可断言的函数。
 *
 * ## ⚠️ 不定射程
 *
 * 手册**没有给出射程数值**,所以本文件不发明一个:射程由调用方作为 `range`
 * 传进来(单位:格)。本文件只钉两件事:
 *   - **端点**:`dist = 0 → 1`、`dist = range → 0`;
 *   - **单调**:随 `dist` 单调不增(线性,故严格递减)。
 */

/** 支持的衰减曲线形态。 */
export const DyeAttenuation = {
  /** 线性:`1 − dist / range`(WS-09 §U5 口径) */
  LINEAR: 'linear',
} as const;
export type DyeAttenuation = (typeof DyeAttenuation)[keyof typeof DyeAttenuation];

/** 当前启用的曲线形态(与 `dyeAttenuation()` 的实现绑定)。 */
export const DYE_ATTENUATION_KIND: DyeAttenuation = DyeAttenuation.LINEAR;

/**
 * 距离 → 染色强度(0..1)。
 *
 * @param dist  喷枪到表面的距离(格);≤ 0 视为贴身
 * @param range 射程(格),由调用方给 —— 冻结层不发明射程数值
 *
 * 边界:
 *   - `range ≤ 0` 或非有限 ⇒ 强度恒 `1`(退化射程不该把颜色抹成 0);
 *   - `dist` 非有限 ⇒ `0`(渲染路径不能因一个坏值抛错断帧);
 *   - `dist ≥ range` ⇒ `0`(射程外不上色)。
 */
export function dyeAttenuation(dist: number, range: number): number {
  if (!Number.isFinite(range) || range <= 0) return 1;
  if (!Number.isFinite(dist)) return 0;
  if (dist <= 0) return 1;
  if (dist >= range) return 0;
  return 1 - dist / range;
}