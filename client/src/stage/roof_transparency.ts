/**
 * WS-09 / 屋顶连通域与淡入淡出 —— 纯逻辑层(不 import three)。
 *
 * 需求(手册 §3.6 屋顶条目):「角色走入室内时整片连通屋顶自动变透明」。
 * 关键词是**整片连通**:不是逐格淡出(那样屋顶会碎成一块块补丁),
 * 而是先做 4-邻域 flood fill 把屋顶分片,同一片共用一个 alpha。
 *
 * 实现约束:
 *  - 必须用**显式栈迭代**,不能递归 —— 一片 200×200 的屋顶递归深度可达 40000,栈会炸;
 *  - 只能 4-邻域,不能 8-邻域 —— 8-邻域会把「对角相接的两栋房子」并成一片,
 *    造成隔壁屋顶跟着变透明(经典视觉 bug),见 tests 的 diagonal 用例;
 *  - 分片结果用 Int32Array 标签图,重建条件 = 网格版本号变化。
 */

import { unpackTile } from '../../../shared/types/tile.ts';

/** §3.6 中带「屋顶」语义的物品 ID(372~376 斜顶/茅草/尖塔/温室/花架,384 烟囱同样遮光) */
export const ROOF_ITEM_IDS: readonly number[] = [372, 373, 374, 375, 376, 384];

/** 淡出到的最低不透明度:留一点影子让玩家仍能感知屋顶轮廓 */
export const ROOF_MIN_ALPHA = 0.15;

/** 单次淡入/淡出时长(秒) */
export const ROOF_FADE_SEC = 0.22;

/** 4-邻域偏移:北/东/南/西 */
export const NEIGHBOR4_DX: readonly number[] = [0, 1, 0, -1];
export const NEIGHBOR4_DY: readonly number[] = [-1, 0, 1, 0];

export interface RoofMask {
  width: number;
  height: number;
  /** 长度 width×height,1 = 屋顶格 */
  mask: Uint8Array;
  /** 屋顶格总数 */
  roofCells: number;
}

export interface RoofComponents {
  labels: Int32Array;
  count: number;
  /** 每个连通域的格数,下标 = label */
  sizes: number[];
  /** 每个连通域的最小外接框 [minX, minY, maxX, maxY] */
  bounds: number[][];
}

export function isRoofTile(tile: number): boolean {
  const u = unpackTile(tile);
  return ROOF_ITEM_IDS.includes(u.obj);
}

/** 由 32-bit 单元网格构建屋顶掩码(仅 obj 层,海拔 Z=2 视为屋顶层) */
export function buildRoofMask(tiles: ArrayLike<number>, width: number, height: number): RoofMask {
  const w = Math.max(0, Math.trunc(width));
  const h = Math.max(0, Math.trunc(height));
  const mask = new Uint8Array(w * h);
  let roofCells = 0;
  for (let i = 0; i < w * h && i < tiles.length; i += 1) {
    if (isRoofTile(tiles[i])) {
      mask[i] = 1;
      roofCells += 1;
    }
  }
  return { width: w, height: h, mask, roofCells };
}

/**
 * 4-邻域连通域标记(显式栈,迭代版 flood fill)。
 * 复杂度 O(w·h):每格最多入栈一次。
 */
export function labelRoofComponents(mask: RoofMask): RoofComponents {
  const { width: w, height: h, mask: m } = mask;
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const bounds: number[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < w * h; start += 1) {
    if (m[start] !== 1 || labels[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    stack.push(start);
    labels[start] = id;

    while (stack.length > 0) {
      const cur = stack.pop() as number;
      const x = cur % w;
      const y = (cur - x) / w;
      size += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let d = 0; d < 4; d += 1) {
        const nx = x + NEIGHBOR4_DX[d];
        const ny = y + NEIGHBOR4_DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (m[ni] !== 1 || labels[ni] !== -1) continue;
        labels[ni] = id;
        stack.push(ni);
      }
    }

    sizes.push(size);
    bounds.push([minX, minY, maxX, maxY]);
  }

  return { labels, count: sizes.length, sizes, bounds };
}

/** 查某格所属连通域,非屋顶返回 −1 */
export function componentAt(c: RoofComponents, x: number, y: number, width: number): number {
  if (x < 0 || y < 0) return -1;
  const i = y * width + x;
  if (i < 0 || i >= c.labels.length) return -1;
  return c.labels[i];
}

/* ───────────────────────────── 淡入淡出 ───────────────────────────── */

/** 平滑阶跃 t²(3−2t),末端一阶导为 0,避免 alpha 突变被眼睛抓到 */
export function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * 由「淡出量」求不透明度 —— **全模块唯一的 alpha 公式源**。
 * @param fade 0 = 完全不透明,1 = 淡到 ROOF_MIN_ALPHA
 */
export function fadeAlpha(fade: number): number {
  return 1 - (1 - ROOF_MIN_ALPHA) * smoothstep01(fade);
}

/**
 * 屋顶不透明度曲线(过渡两端点)。
 * @param t       过渡进度 0..1(0 = 刚触发,1 = 过渡完成)
 * @param entering true = 玩家进入(0 时不透明 → 1 时最低);false = 离开(0 时最低 → 1 时不透明)
 * @returns alpha ∈ [ROOF_MIN_ALPHA, 1]
 */
export function roofAlpha(t: number, entering: boolean): number {
  return fadeAlpha(entering ? t : 1 - t);
}

export interface RoofFadeState {
  component: number;
  /**
   * 淡出量:0 = 完全不透明,1 = 完全淡到 ROOF_MIN_ALPHA。
   *
   * 注意语义是「淡出量」而**不是**「过渡进度」:两者在 `entering=false` 时值相同、
   * 含义相反。若把它当成过渡进度(即 `roofAlpha(progress, entering)`),则
   * 「刚建图、玩家从未进入过」的初始状态 `{progress:0, entering:false}` 会被解释成
   * 「离开过渡已完成」,整片屋顶一开始就以 0.15 的近乎全透明渲染 —— 这正是此前的缺陷。
   * 统一按淡出量解释后,初始状态自然为 alpha 1。
   */
  progress: number;
  /** 目标方向:true = 目标为淡出,false = 目标为恢复不透明 */
  entering: boolean;
}

/**
 * 推进单条淡入淡出状态,返回新状态(纯函数)。
 *
 * 注意不能写成 `progress + (target−progress > 0 ? step : −step)`:当 progress 已等于
 * target 时该式会立刻反向越过目标,产生**逐帧抖动的锯齿**,屋顶看起来像在闪。
 * 正确做法是把增量夹在 [0, |target−progress|] 区间内,到点即停。
 */
export function advanceFade(state: RoofFadeState, dt: number, fadeSec = ROOF_FADE_SEC): RoofFadeState {
  const step = fadeSec <= 0 ? 1 : Math.abs(dt) / fadeSec;
  const target = state.entering ? 1 : 0;
  const delta = target - state.progress;
  if (Math.abs(delta) <= 1e-9) {
    return { component: state.component, entering: state.entering, progress: target };
  }
  const move = Math.min(Math.abs(delta), step) * Math.sign(delta);
  const next = Math.min(1, Math.max(0, state.progress + move));
  return { component: state.component, entering: state.entering, progress: next };
}

/**
 * 屋顶透明管理器:维护「当前玩家所在连通域」与每条分片的淡入淡出进度。
 *
 * 关键行为:
 *  - 玩家跨片移动时,旧片回落、新片淡出,两者可同时处于中间态(不闪烁);
 *  - 玩家站在两片屋顶的缝隙格上(非屋顶格)时,activeComponent = −1,全部回落;
 *  - `update` 只遍历 count 个分片,复杂度 O(components) 而非 O(cells)。
 */
export class RoofTransparencyManager {
  private fades: RoofFadeState[];
  private active: number;
  private components: RoofComponents | null;
  private width: number;
  private version: number;
  private builtVersion: number;

  constructor() {
    this.fades = [];
    this.active = -1;
    this.components = null;
    this.width = 0;
    this.version = 0;
    this.builtVersion = -1;
  }

  get activeComponent(): number {
    return this.active;
  }

  get componentCount(): number {
    return this.components ? this.components.count : 0;
  }

  get versionTag(): number {
    return this.version;
  }

  /** 网格被编辑后调用:版本号 +1,下次重建时对比 */
  markDirty(): void {
    this.version += 1;
  }

  get needsRebuild(): boolean {
    return this.builtVersion !== this.version;
  }

  /** 重建连通域(纯计算,不碰 GPU) */
  rebuild(mask: RoofMask): RoofComponents {
    this.components = labelRoofComponents(mask);
    this.width = mask.width;
    this.fades = [];
    for (let i = 0; i < this.components.count; i += 1) {
      this.fades.push({ component: i, progress: 0, entering: false });
    }
    this.builtVersion = this.version;
    return this.components;
  }

  /** 玩家移动:更新激活分片,返回是否发生了变化 */
  setPlayerCell(gx: number, gy: number): boolean {
    if (!this.components) return false;
    const id = componentAt(this.components, Math.floor(gx), Math.floor(gy), this.width);
    if (id === this.active) return false;
    this.active = id;
    for (const f of this.fades) {
      const shouldEnter = id >= 0 && f.component === id;
      if (f.entering !== shouldEnter) f.entering = shouldEnter;
    }
    return true;
  }

  /** 推进所有分片的淡入淡出 */
  update(dt: number): void {
    for (let i = 0; i < this.fades.length; i += 1) this.fades[i] = advanceFade(this.fades[i], dt);
  }

  /** 取某分片当前 alpha;未建图或越界返回 1(不透明,安全默认) */
  alphaOf(component: number): number {
    if (component < 0 || component >= this.fades.length) return 1;
    return fadeAlpha(this.fades[component].progress);
  }

  /** 导出供 shader 上传的 alpha 数组(长度 = 分片数) */
  alphaArray(): Float32Array {
    const out = new Float32Array(this.fades.length);
    for (let i = 0; i < this.fades.length; i += 1) out[i] = this.alphaOf(i);
    return out;
  }

  /** 是否已完成过渡(用于跳过无效 draw call) */
  isIdle(): boolean {
    for (const f of this.fades) {
      const target = f.entering ? 1 : 0;
      if (Math.abs(f.progress - target) > 1e-6) return false;
    }
    return true;
  }
}

/** 一次性便捷函数:从网格直接算出「玩家所在片的 alpha 数组」 */
export function computeRoofAlpha(
  tiles: ArrayLike<number>,
  width: number,
  height: number,
  playerX: number,
  playerY: number,
): { components: RoofComponents; active: number; alphas: number[] } {
  const mask = buildRoofMask(tiles, width, height);
  const components = labelRoofComponents(mask);
  const active = componentAt(components, Math.floor(playerX), Math.floor(playerY), mask.width);
  const alphas: number[] = [];
  for (let i = 0; i < components.count; i += 1) alphas.push(i === active ? ROOF_MIN_ALPHA : 1);
  return { components, active, alphas };
}