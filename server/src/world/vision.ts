/**
 * 视线遮挡(D2)—— **纯函数**,零运行时依赖。
 *
 * ## 这个模块补的是什么
 *
 * `docs/DAMAGE-LOOP.md` D2 的原文:「生物攻击**不检查视线**:隔着 1 格墙也能打中」,
 * 落点写着「需在 `resolveStrikes` 里加射线遮挡判定」。
 * 但全仓此前**没有任何视线函数**(`grep 'lineOfSight|hasLineOfSight|losClear'` = 0 处)
 * ⇒ 不是「判定写错了」,而是「这条判定根本不存在」。
 *
 * ## 为什么是独立的纯函数模块,而不是塞进 `resolveStrikes`
 *
 * | 塞进 `resolveStrikes` | 独立纯函数 |
 * | :--- | :--- |
 * | `resolveStrikes` 要变成「纯几何 + 需要读地形」 | 几何仍保持纯;遮挡是可注入的谓词 |
 * | 只能靠整世界做断言 | 2×2 的假地形就能判死每一条分支 |
 * | 生物 AI 想复用就得 import 结算层 | AI 可以只 import 判定 |
 *
 * ⇒ 本模块**只认 `solid(x, y)` 这个谓词**,不认 `WorldGrid`、不认 chunk、不认人群
 * (`world_sim` 传 `(x, y) => this.grid.isSolidAt(x, y)` 进来)。这样「地形是什么」
 * 只有一个权威(`WorldGrid.isSolidAt`),本模块不制造第二份。
 *
 * ## 算法:格中心 → 格中心的 **supercover DDA**(阿曼纳蒂斯-伍)
 *
 * 不采样固定步长(如每 0.1 格取一个点)的理由:步长决定遮挡判定,而「步长多小算对」
 * 没有答案 —— 步长 0.1 时 1 格厚的墙可能被跨过(取决于相位),表现为
 * 「同一堵墙有时挡、有时不挡」。DDA 走的是**被线段穿过的每一个格**,
 * 与浮点相位无关 ⇒ 判定可复现。
 *
 * ## 三条刻意的 fail-open / fail-closed 取舍
 *
 * ```
 * 1 起点格是实心  ⇒ 直接放行(返回 true)
 *    理由:生物被卡在墙里时,若判「看不见任何人」,它连自救都做不到,
 *    而且这种状态本身是上游缺陷 —— 让伤害照常发生比让战斗静默停摆好诊断。
 * 2 终点格是实心  ⇒ 放行(玩家站在墙里时同理;那不是本判定的职责)
 * 3 中途格是实心  ⇒ **挡住**(唯一的 fail-closed 分支)
 * ```
 *
 * 换言之:**只有「中间隔着东西」才挡**,这正是 D2 要修的那一件事。
 */

/** 视线判定用的地形谓词:`(格坐标) => 是否实心`。 */
export type SolidAt = (x: number, y: number) => boolean;

/**
 * 一次视线判定里**最多**走过的格数(防病态输入的保底)。
 *
 * 正常场景用不到:本仓世界边长 64 格,最长对角线 90 格。
 * 它存在的意义是「不让一个荒谬坐标把循环拖成 CPU 尖峰」——
 * 与 `checkMove` 的 6.0 值域门同族:判据自己必须先有界。
 */
export const LOS_MAX_CELLS = 512;

/**
 * 判断从 `(x0, y0)` 到 `(x1, y1)` 的**直线**是否被实心格挡住。
 *
 * @param solid 地形谓词(`true` = 该格实心/不可穿透)
 * @returns `true` = 视线通畅(没被挡);`false` = 中途有遮挡
 *
 * 非有限输入(NaN / Infinity)⇒ 返回 `true`(放行)。理由与起点实心同族:
 * 坐标坏掉是**上游**的问题,在这里判成「看不见」会让缺陷伪装成平衡问题
 * (`docs/DAMAGE-LOOP.md` 反复记的「症状名 ≠ 成因名」)。
 */
export function lineOfSight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  solid: SolidAt,
): boolean {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return true;
  }
  const cx0 = Math.floor(x0);
  const cy0 = Math.floor(y0);
  const cx1 = Math.floor(x1);
  const cy1 = Math.floor(y1);
  /* 同一格:没有「中途」可言 ⇒ 放行(贴身接触不该被判成遮挡)。 */
  if (cx0 === cx1 && cy0 === cy1) return true;

  /* 起点/终点在实心格里 ⇒ 放行(见文件头的三条取舍)。 */
  if (solid(cx0, cy0) || solid(cx1, cy1)) return true;

  /* ── supercover DDA:沿线段推进,逐个格检查 ──
     `stepX/stepY` = 前进方向;`tMaxX/tMaxY` = 到下一个格边界的参数距离;
     `tDeltaX/tDeltaY` = 跨一整格所需的参数距离。 */
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  /* 到「下一条格线」的距离(以参数 t ∈ [0,1] 计,端点归一化为 1)。 */
  const nextGridX = stepX > 0 ? cx0 + 1 : cx0;
  const nextGridY = stepY > 0 ? cy0 + 1 : cy0;
  let tMaxX = stepX === 0 ? Number.POSITIVE_INFINITY : (nextGridX - x0) / dx;
  let tMaxY = stepY === 0 ? Number.POSITIVE_INFINITY : (nextGridY - y0) / dy;

  let cx = cx0;
  let cy = cy0;
  let walked = 0;
  while (walked < LOS_MAX_CELLS) {
    walked += 1;
    /* 1 选中「先跨哪一条格线」(相等时同时跨 —— supercover 的角点情形) */
    const crossX = tMaxX <= tMaxY;
    const crossY = tMaxY <= tMaxX;
    if (crossX) {
      cx += stepX;
      tMaxX += tDeltaX;
    }
    if (crossY) {
      cy += stepY;
      tMaxY += tDeltaY;
    }
    /* 2 到了终点格 ⇒ 通畅(终点格本身的实心性已在上面放行过) */
    if (cx === cx1 && cy === cy1) return true;
    /* 3 中途格实心 ⇒ 挡住 */
    if (solid(cx, cy)) return false;
  }
  /* 走出上界(病态输入)⇒ 放行,理由同文件头的 fail-open。 */
  return true;
}

/**
 * `lineOfSight` 的**反向读法**:`true` = 被挡住。
 *
 * 为什么两个都导出:调用点是「先算出遮挡再决定是否丢弃这次攻击」,
 * 写 `if (losBlocked(...))` 比写 `if (!lineOfSight(...))` 少一次反直觉的取反
 * ——本仓有过「取反取错,于是遮挡逻辑把一切都挡住」的记录(陷阱形态)。
 * ⚠️ 它是**唯一实现**的包装:不许在这里再写一遍 DDA。
 */
export function losBlocked(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  solid: SolidAt,
): boolean {
  return !lineOfSight(x0, y0, x1, y1, solid);
}

/**
 * 用**间距采样**做的兜底判定(与 DDA 同语义,不做 supercover)。
 *
 * 存在的唯一理由:当谓词是**连续场**(如流体/烟雾)而非格时,`lineOfSight` 的
 * 「逐格」语义不适用。本仓当前没有这样的调用方(生产只用 `lineOfSight`),
 * 故它**不是**第二份实现,而是不同输入域的另一条路。
 *
 * @param stepCells 采样间距(格),必须 > 0;非法值退回 0.25
 */
export function losClear(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  solid: SolidAt,
  stepCells = 0.25,
): boolean {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return true;
  }
  const step = Number.isFinite(stepCells) && stepCells > 0 ? stepCells : 0.25;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.min(LOS_MAX_CELLS * 4, Math.max(1, Math.ceil(dist / step)));
  const sx = x0;
  const sy = y0;
  /* 端点**都跳过**:起点/终点的实心性按文件头的取舍放行。 */
  for (let i = 1; i < n; i += 1) {
    const t = i / n;
    const px = Math.floor(sx + (x1 - sx) * t);
    const py = Math.floor(sy + (y1 - sy) * t);
    if (px === Math.floor(x0) && py === Math.floor(y0)) continue;
    if (px === Math.floor(x1) && py === Math.floor(y1)) continue;
    if (solid(px, py)) return false;
  }
  return true;
}