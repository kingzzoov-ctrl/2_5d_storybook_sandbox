/**
 * WS-09 / 35° 正交投影相机 —— 纯数学层(不 import three)。
 *
 * 设计要点:
 *  - 俯仰角固定 35°(PITCH_DEG),方位角固定 45°(AZIMUTH_DEG),因此是「正交 + 斜俯视」的 2.5D 舞台,
 *    不是真等轴测(等轴测为 30°/35.264°)。35° 让地面在纵向保有呼吸感,Z 轴拉伸感弱、绘本感强。
 *  - 世界坐标 (gx, gy, gz) 单位为「格」;gx/gy 为整数格左下角,gz 为海拔(可含小数,用于跳跃中的角色)。
 *  - 投影为线性变换,故 `project(g) - project(focus)` 与 `project(g - focus)` 等价,
 *    这一点是跟随相机与视锥包围盒推导的基础。
 *
 * 投影公式(记 k = scale × zoom,像素/格):
 *
 *   ux = (gx − gy) · cos45°
 *   uy = (gx + gy) · sin45° · sin35° − gz · cos35°
 *   sx = originX + ux · k
 *   sy = originY + uy · k
 *
 * 其中 sy 向下为正(HTML Canvas / WebGL 视口约定)。**Z 高度偏移**:
 *   ∂sy/∂gz = −cos35° · k  ⇒ 世界 Z 每升 1 格,屏幕 y 上移 cos35°·k 像素
 *   cos35° = 0.8191520442889918(与 k 无关的常数因子)
 *
 * 眨眼读法:一格高度 ≈ 0.819 格「屏幕纵向量」,所以 Z=2 的高台在屏幕上只抬 1.638 格,
 * 视觉上不会把画面顶穿;这也是本项目选 35° 而不是 60° 的原因。
 */

/** 俯仰角(度):相机与水平面夹角 */
export const PITCH_DEG = 35;
/** 方位角(度):绕 Z 轴旋转,45° 得到经典 2.5D 菱形地平线 */
export const AZIMUTH_DEG = 45;

export const DEG2RAD = Math.PI / 180;

export const COS_PITCH = Math.cos(PITCH_DEG * DEG2RAD);
export const SIN_PITCH = Math.sin(PITCH_DEG * DEG2RAD);
export const COS_AZ = Math.cos(AZIMUTH_DEG * DEG2RAD);
export const SIN_AZ = Math.sin(AZIMUTH_DEG * DEG2RAD);

/** 1 格地面在 zoom=1 时的基准像素宽度(16px 像素画风) */
export const TILE_PX = 16;

/** 单格地面在屏幕纵向占用的像素系数:(1,1)→(0,0) 的方向 */
export const GROUND_Y_PER_CELL = SIN_AZ * SIN_PITCH;

/** Z 高度屏幕偏移系数:每升 1 格,屏幕 y 上移 COS_PITCH 格(乘 k 得像素) */
export const Z_Y_PER_LEVEL = COS_PITCH;

/**
 * 反投影在「同一海拔平面」上唯一:正交投影丢失了沿视线的一条自由度,
 * 因此反投影必须指定 gz(等价于指定落在哪一层地砖上)。
 */
export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface GridPoint {
  gx: number;
  gy: number;
}

export interface IsoCamera {
  /** zoom=1 时每格像素数 */
  scale: number;
  /** 缩放倍率 */
  zoom: number;
  viewportW: number;
  viewportH: number;
  /** 相机对准的格坐标(含海拔) */
  focusX: number;
  focusY: number;
  focusZ: number;
  /** focus 投影到屏幕的像素位置 */
  originX: number;
  originY: number;
}

/** 缩放档位:0.5× 全局俯视观景 → 2× 贴脸看像素画 */
export const zoomLevels: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
export const ZOOM_LEVELS = zoomLevels;

export function pixelScale(cam: IsoCamera): number {
  return cam.scale * cam.zoom;
}

export function createCamera(viewportW: number, viewportH: number, scale = TILE_PX): IsoCamera {
  const w = Math.max(1, Math.floor(viewportW));
  const h = Math.max(1, Math.floor(viewportH));
  return {
    scale: scale > 0 ? scale : TILE_PX,
    zoom: 1,
    viewportW: w,
    viewportH: h,
    focusX: 0,
    focusY: 0,
    focusZ: 0,
    originX: w / 2,
    /* 纵向 0.55:上方多留 5% 给屋顶与 Boss 血条,下方给地面装饰 */
    originY: h * 0.55,
  };
}

export function cloneCamera(cam: IsoCamera): IsoCamera {
  return { ...cam };
}

/** 世界(格) → 屏幕(像素) */
export function projectGridToScreen(gx: number, gy: number, gz: number, cam: IsoCamera): ProjectedPoint {
  const k = pixelScale(cam);
  const dx = gx - cam.focusX;
  const dy = gy - cam.focusY;
  const dz = gz - cam.focusZ;
  const ux = (dx - dy) * COS_AZ;
  const uy = (dx + dy) * GROUND_Y_PER_CELL - dz * Z_Y_PER_LEVEL;
  return { x: cam.originX + ux * k, y: cam.originY + uy * k };
}

/** 屏幕(像素) → 世界(格),必须指定 gz 所在的水平面 */
export function unprojectScreenToGrid(sx: number, sy: number, cam: IsoCamera, gz: number): GridPoint {
  const k = pixelScale(cam);
  const ux = (sx - cam.originX) / k;
  const uy = (sy - cam.originY) / k;
  /* ux = (dx − dy)·cos45° */
  const diff = ux / COS_AZ;
  /* uy = (dx + dy)·sin45°·sin35° − dz·cos35° */
  const sum = (uy + (gz - cam.focusZ) * Z_Y_PER_LEVEL) / GROUND_Y_PER_CELL;
  const dx = (sum + diff) / 2;
  const dy = (sum - diff) / 2;
  return { gx: cam.focusX + dx, gy: cam.focusY + dy };
}

/** 地面平面(gz=0)上的反投影,拾取最常用入口 */
export function unprojectToGround(sx: number, sy: number, cam: IsoCamera): GridPoint {
  return unprojectScreenToGrid(sx, sy, cam, 0);
}

/**
 * Z 高度屏幕偏移(以「屏幕格」为单位,再乘 k 得像素)。
 * 世界 Z 每升 1 格 → 屏幕 y 偏移 −cos35° 格(向上为负)。
 */
export function zScreenOffset(dz: number): number {
  return -dz * Z_Y_PER_LEVEL;
}

/** Z 高度屏幕偏移(像素) */
export function zScreenOffsetPx(dz: number, cam: IsoCamera): number {
  return -dz * Z_Y_PER_LEVEL * pixelScale(cam);
}

/** 地面每走 1 格(gx+gy 各 1)屏幕纵向偏移(像素),便于 UI 对齐格线 */
export function groundScreenStepPx(cam: IsoCamera): number {
  return GROUND_Y_PER_CELL * pixelScale(cam);
}

/** 绘制排序深度:画家算法,先画远处(gx+gy 小、gz 小) */
export function isoDepth(gx: number, gy: number, gz: number): number {
  return gx + gy + gz * 0.5;
}

/** 视口在当前相机下的世界 AABB(用于分块视锥剔除),含 Z 高度抬升带来的纵向扩张 */
export interface ViewBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function viewBounds(cam: IsoCamera, zMin: number, zMax: number): ViewBounds {
  const k = pixelScale(cam);
  const halfW = Math.max(cam.originX, cam.viewportW - cam.originX) / k;
  const halfH = Math.max(cam.originY, cam.viewportH - cam.originY) / k;
  const zPad =
    Math.max(Math.abs(zMin - cam.focusZ), Math.abs(zMax - cam.focusZ)) * Z_Y_PER_LEVEL;
  /* |dx − dy| 上限 */
  const spanDiff = halfW / COS_AZ;
  /* |dx + dy| 上限(纵向多了 Z 抬升的余量) */
  const spanSum = (halfH + zPad) / GROUND_Y_PER_CELL;
  const ext = (spanDiff + spanSum) / 2;
  return {
    minX: cam.focusX - ext,
    maxX: cam.focusX + ext,
    minY: cam.focusY - ext,
    maxY: cam.focusY + ext,
  };
}

/** 视口四角在地面上的世界坐标(用于调试绘制与拾取) */
export function viewCorners(cam: IsoCamera): GridPoint[] {
  const pts: GridPoint[] = [];
  const xs = [0, cam.viewportW, cam.viewportW, 0];
  const ys = [0, 0, cam.viewportH, cam.viewportH];
  for (let i = 0; i < 4; i += 1) pts.push(unprojectScreenToGrid(xs[i], ys[i], cam, cam.focusZ));
  return pts;
}

/* ────────────────────────── 跟随与缩放 ────────────────────────── */

export interface FollowConfig {
  worldMinX: number;
  worldMinY: number;
  worldMaxX: number;
  worldMaxY: number;
  /** 边缘留白:相机聚焦点不得进入世界边界 pad 格以内 */
  edgePadCells: number;
  /** 死区半径:玩家在此半径内移动时相机完全不动,避免抖动 */
  deadzoneCells: number;
  /** 平滑时间常数(秒),越大越拖 */
  smoothing: number;
}

export const DEFAULT_FOLLOW: FollowConfig = {
  worldMinX: 0,
  worldMinY: 0,
  worldMaxX: 1024,
  worldMaxY: 1024,
  edgePadCells: 8,
  deadzoneCells: 2,
  smoothing: 0.12,
};

function clampToBand(v: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * 跟随相机:死区 + 指数平滑 + 世界边界夹紧,帧率无关。
 * 纯函数:返回新相机对象,不修改入参。
 */
export function followCamera(
  cam: IsoCamera,
  playerX: number,
  playerY: number,
  dt: number,
  cfg: FollowConfig = DEFAULT_FOLLOW,
): IsoCamera {
  const half = Math.max(0, cfg.deadzoneCells);
  let tx = cam.focusX;
  let ty = cam.focusY;
  if (playerX > cam.focusX + half) tx = playerX - half;
  else if (playerX < cam.focusX - half) tx = playerX + half;
  if (playerY > cam.focusY + half) ty = playerY - half;
  else if (playerY < cam.focusY - half) ty = playerY + half;

  const step = dt > 0 ? 1 - Math.exp(-dt / Math.max(1e-4, cfg.smoothing)) : 1;
  const nx = cam.focusX + (tx - cam.focusX) * step;
  const ny = cam.focusY + (ty - cam.focusY) * step;

  return {
    ...cam,
    focusX: clampToBand(nx, cfg.worldMinX + cfg.edgePadCells, cfg.worldMaxX - cfg.edgePadCells),
    focusY: clampToBand(ny, cfg.worldMinY + cfg.edgePadCells, cfg.worldMaxY - cfg.edgePadCells),
  };
}

/** 就近取缩放档位 */
export function snapZoom(zoom: number): number {
  let best = zoomLevels[0];
  let bestErr = Number.POSITIVE_INFINITY;
  for (const z of zoomLevels) {
    const err = Math.abs(z - zoom);
    if (err < bestErr) {
      bestErr = err;
      best = z;
    }
  }
  return best;
}

/** 缩放档位步进:dir=+1 放大,dir=-1 缩小;越界保持端点 */
export function stepZoom(cam: IsoCamera, dir: number): IsoCamera {
  const cur = snapZoom(cam.zoom);
  const i = zoomLevels.indexOf(cur);
  const next = Math.min(zoomLevels.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)));
  return { ...cam, zoom: zoomLevels[next] };
}

/** 世界坐标 → 该缩放下的像素可点区域(UI 命中测试用) */
export function screenHitTest(
  sx: number,
  sy: number,
  cam: IsoCamera,
  gz: number,
): { gx: number; gy: number; cellX: number; cellY: number } {
  const p = unprojectScreenToGrid(sx, sy, cam, gz);
  return { gx: p.gx, gy: p.gy, cellX: Math.floor(p.gx), cellY: Math.floor(p.gy) };
}