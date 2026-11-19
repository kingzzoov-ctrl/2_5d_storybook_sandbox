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
/* ═══════════════════ 32 色调色盘(全仓唯一的一份声明)═══════════════════ */

/**
 * 32 色染色枪 / 像素画架共用的调色盘(8 个色相 × 4 档明度,绘本风低饱和高亮)。
 *
 * ## 为什么搬到这里(第九轮实测:两份逐字节相同的副本)
 *
 * 改版前 `client/src/ui/pixel_easel.ts` 的 `PALETTE_32` 与
 * `client/src/stage/dye_overlay.ts` 的 `DYE_PALETTE` 是**两份 32 行字面量**,
 * 逐字节相同 —— 于是「画架画的第 7 号色」与「染色枪喷的第 7 号色」可以各自漂移,
 * 而两边都"看起来合理"(调色盘不是一个数,漂一格不会报错)。
 * 现在**只有这一份**:两侧都必须是同一批绑定(判据按 `===` 钉引用,不是按文本相等)。
 *
 * 索引语义(与改版前一致):
 *   - 索引 0 固定近白(`#FFFDF7`),玩家可从空白直接上色;
 *   - 索引 31 近黑(`#8A5433` 为末档棕),用于描边;
 *   - 「透明 / 未染色」**不占调色盘索引**:画架用 `-1`,
 *     染色通道用 `NO_DYE = -1`(见 `client/src/stage/dye_overlay.ts`)。
 */
export const DYE_PALETTE: readonly string[] = [
  '#FFFDF7', '#F5E7D0', '#E9D3B0', '#D8B98C',
  '#F7B7C6', '#EE8CA6', '#D76388', '#B03F6C',
  '#FBD9A0', '#F5B96B', '#E0913C', '#B96A22',
  '#D8EFA8', '#A9D97C', '#7CB855', '#4E8C39',
  '#A8E6E0', '#6EC9C4', '#43A0A4', '#2A7178',
  '#A9C8F5', '#7BA3E8', '#4F76CC', '#2E4C96',
  '#D3B8F0', '#B08BE0', '#875FC2', '#5B3C90',
  '#F0C9A8', '#D9A17C', '#B87A55', '#8A5433',
];

/**
 * 调色盘色数 = 32。**「32」这个数在全仓只有这一处声明。**
 *
 * 改版前它有三个副本:`client/src/ui/pixel_easel.ts` 的 `PALETTE_SIZE = 32`、
 * `client/src/stage/dye_overlay.ts` 的 `DYE_PALETTE_SIZE = DYE_PALETTE.length`、
 * `server/src/party/scoring.ts` 的 `DYE_PALETTE_SIZE = 32`(染色计分槽数)。
 * 三处口径相同、来源不同 ⇒ 加一种颜色的那天必然只改到其中一两处。
 * 现在三处**都只是本常量的转发**(`client/src/ui/pixel_easel.ts#PALETTE_SIZE` /
 * `client/src/stage/dye_overlay.ts#DYE_PALETTE_SIZE` /
 * `server/src/party/scoring.ts#DYE_PALETTE_SIZE`),由 `tests/WS-FND-136` 逐处钉住。
 */
export const DYE_PALETTE_SIZE = DYE_PALETTE.length;