/**
 * WS-09 / 染色覆盖通道 —— 纯状态层(不 import three)。
 *
 * 对应 209「32色气压染色枪」:对准任意墙体、屋顶、家具、宠物甚至队友喷涂改色。
 *
 * **本模块存在的唯一理由,是让「染色不重建材质」成为可测试的不变量。**
 *
 * 常见错误实现是:每喷一次色就 `new MeshStandardMaterial({color: tint})`。
 * 后果非常具体:一面墙被反复喷 32 次 → 32 个材质实例 → 每实例一次 shader program
 * 编译 + uniform 上传,32 面墙就能把 draw call 顶到 1000+,而 GPU 其实只做了换色这一件事。
 *
 * 正确做法(与 `shaders.ts` 的 `dye_overlay` 配套):
 *  - **材质 id 恒定**:`materialKey(surface)` 只由「基础材质 + UV 变体 + 动态标记」决定,与 tint 无关;
 *  - **染色数据进 uniform**:`uDyeTint` + `uDyeMaskRect` + `uDyeStrength`,一张纹理、一次绑定;
 *  - **32 色是索引不是颜色**:网络同步只传 6 bit(0..31 + 哨兵),端上查表还原;
 *  - **按连通域合并**:同一片墙(与屋顶连通域同一套分片)共用一个 tint slot,
 *    所以喷一整面墙是 1 次 uniform 更新,不是 256 次。
 *
 * 数据规模:一个 1024×1024 世界最多 4096 个 Chunk,每 Chunk 记录 1 个 tint 索引 +
 * 1 个 mask 矩形 = 6 个 float ≈ 24B,可全量常驻显存。
 */

import { unpackTile } from '../../../shared/types/tile.ts';

/** 32 色调色盘(与 UI 的 `PALETTE_32` 同源;这里保留十六进制字符串,装配层转 RGB) */
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

export const DYE_PALETTE_SIZE = DYE_PALETTE.length;

/** 未染色哨兵值 */
export const NO_DYE = -1;

/** 17 个可染色表面类别(手册:墙体/屋顶/家具/宠物/队友…) */
export const DyeSurfaceKind = {
  WALL: 'WALL',
  ROOF: 'ROOF',
  FLOOR: 'FLOOR',
  DOOR: 'DOOR',
  WINDOW: 'WINDOW',
  FURNITURE: 'FURNITURE',
  DEVICE: 'DEVICE',
  VEHICLE: 'VEHICLE',
  PET: 'PET',
  TEAMMATE: 'TEAMMATE',
  BANNER: 'BANNER',
  CARPET: 'CARPET',
  CLOAK: 'CLOAK',
  FRAME: 'FRAME',
  STATUE: 'STATUE',
  BRIDGE: 'BRIDGE',
  MISC: 'MISC',
} as const;
export type DyeSurfaceKind = (typeof DyeSurfaceKind)[keyof typeof DyeSurfaceKind];

export const DYE_SURFACE_KINDS: readonly DyeSurfaceKind[] = [
  'WALL', 'ROOF', 'FLOOR', 'DOOR', 'WINDOW', 'FURNITURE', 'DEVICE', 'VEHICLE',
  'PET', 'TEAMMATE', 'BANNER', 'CARPET', 'CLOAK', 'FRAME', 'STATUE', 'BRIDGE', 'MISC',
];

/**
 * 表面键。**材质 id 就由它决定,tint 不参与** ——
 * 这正是「染色不改材质 id」的实现口径。
 */
export interface SurfaceKey {
  kind: DyeSurfaceKind;
  /** UV 变体(拼接朝向/磨损档/朝向帧),决定 UV 布局 */
  uvVariant: number;
  /** 稳定性标记:0 = 静态(可静态合批),1 = 动态(角色/宠物) */
  dynamic: number;
}

/** 材质键:唯一决定一个 GPU material 实例 */
export function materialKey(k: SurfaceKey): string {
  return `${k.kind}#${Math.trunc(k.uvVariant)}#${Math.trunc(k.dynamic)}`;
}

/** UV 变体数量上界:每类表面最多 16 个变体,再多应该合并到图集 */
export const MAX_UV_VARIANTS = 16;

/** 校验表面键合法 */
export function isValidSurfaceKey(k: SurfaceKey): boolean {
  if (!DYE_SURFACE_KINDS.includes(k.kind)) return false;
  if (!Number.isInteger(k.uvVariant) || k.uvVariant < 0 || k.uvVariant >= MAX_UV_VARIANTS) return false;
  if (k.dynamic !== 0 && k.dynamic !== 1) return false;
  return true;
}

export interface DyeEntry {
  surfaceKey: string;
  /** 调色盘索引 0..31;NO_DYE = 未染色 */
  tintIndex: number;
  /** 覆盖矩形(x, y, w, h),UV 空间 */
  maskRect: { x: number; y: number; w: number; h: number };
  /** 染色强度 0..1(喷枪距离越远越淡) */
  strength: number;
  /** 最后一次染色时间(秒),用于做「未干」高光 */
  lastDyeSec: number;
}

export interface DyeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次喷色的结果 */
export interface SprayResult {
  /** 命中表面数 */
  surfaces: number;
  /** 实际发生颜色变化的表面数 */
  changed: number;
  /** 是否命中「队友」类别(触发整蛊反馈) */
  hitTeammate: boolean;
}

/**
 * 染色通道:管理所有已染色表面的 uniform 状态。
 *
 * 关键 `spray` 语义:
 *  - 同一表面反复喷同一色 + 同矩形 → `changed` 不增长(幂等,避免无意义的 uniform 脏标记);
 *  - **任何情况下都不新增材质实例**:`materialInstances` 只随 `registerSurface` 增长;
 *  - 同色 `maskRect` 取并集,因此「补喷一小块」不会拆出第二份材质。
 */
export class DyeChannel {
  private entries: Map<string, DyeEntry>;
  private registeredMaterials: Set<string>;
  private dirtyKeys: Set<string>;

  constructor() {
    this.entries = new Map();
    this.registeredMaterials = new Set();
    this.dirtyKeys = new Set();
  }

  /** 已注册的材质实例数(必须只随场景中的表面数量增长,与染色次数无关) */
  get materialInstances(): number {
    return this.registeredMaterials.size;
  }

  get dyedSurfaceCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.tintIndex !== NO_DYE) n += 1;
    return n;
  }

  get dirtyCount(): number {
    return this.dirtyKeys.size;
  }

  /** 注册一个表面(场景加载时调用一次) */
  registerSurface(k: SurfaceKey): string {
    const key = materialKey(k);
    this.registeredMaterials.add(key);
    if (!this.entries.has(key)) {
      this.entries.set(key, {
        surfaceKey: key,
        tintIndex: NO_DYE,
        maskRect: { x: 0, y: 0, w: 1, h: 1 },
        strength: 0,
        lastDyeSec: 0,
      });
    }
    return key;
  }

  /** 注销表面(拆除建筑时) */
  unregisterSurface(k: SurfaceKey): boolean {
    const key = materialKey(k);
    this.registeredMaterials.delete(key);
    this.dirtyKeys.delete(key);
    return this.entries.delete(key);
  }

  /** 取当前染色状态;未注册返回 null */
  get(k: SurfaceKey): DyeEntry | null {
    return this.entries.get(materialKey(k)) ?? null;
  }

  /**
   * 喷色:更新 tint/mask/strength,**不触碰材质集合**。
   * 复杂度 O(1)。
   */
  spray(k: SurfaceKey, tintIndex: number, rect: DyeRect, strength = 1, nowSec = 0): SprayResult {
    const key = this.registerSurface(k);
    const e = this.entries.get(key) as DyeEntry;
    const t = Math.trunc(tintIndex);
    const tint = t >= 0 && t < DYE_PALETTE_SIZE ? t : NO_DYE;
    const s = Math.min(1, Math.max(0, strength));

    const sameColor = e.tintIndex === tint;
    const merged = sameColor ? unionRect(e.maskRect, rect) : normalizeRect(rect);

    const changed = !sameColor
      || merged.x !== e.maskRect.x || merged.y !== e.maskRect.y
      || merged.w !== e.maskRect.w || merged.h !== e.maskRect.h
      || Math.abs(s - e.strength) > 1e-9;

    e.tintIndex = tint;
    e.maskRect = merged;
    e.strength = s;
    e.lastDyeSec = nowSec;
    if (changed) this.dirtyKeys.add(key);

    return {
      surfaces: 1,
      changed: changed ? 1 : 0,
      hitTeammate: k.kind === 'TEAMMATE',
    };
  }

  /** 批量喷色(整片墙:调用方传一个连通域的表面列表) */
  sprayMany(keys: readonly SurfaceKey[], tintIndex: number, rect: DyeRect, strength = 1, nowSec = 0): SprayResult {
    let surfaces = 0;
    let changed = 0;
    let hitTeammate = false;
    for (const k of keys) {
      const r = this.spray(k, tintIndex, rect, strength, nowSec);
      surfaces += r.surfaces;
      changed += r.changed;
      if (r.hitTeammate) hitTeammate = true;
    }
    return { surfaces, changed, hitTeammate };
  }

  /** 洗掉某表面的染色(回到未染色) */
  clear(surface: SurfaceKey): boolean {
    const key = materialKey(surface);
    const e = this.entries.get(key);
    if (!e || e.tintIndex === NO_DYE) return false;
    e.tintIndex = NO_DYE;
    e.strength = 0;
    e.maskRect = { x: 0, y: 0, w: 1, h: 1 };
    this.dirtyKeys.add(key);
    return true;
  }

  /** 取出脏表面并清空脏标记(装配层每帧调用一次上传 uniform) */
  flushDirty(): DyeEntry[] {
    const out: DyeEntry[] = [];
    for (const key of this.dirtyKeys) {
      const e = this.entries.get(key);
      if (e) out.push(e);
    }
    this.dirtyKeys.clear();
    return out;
  }

  /** 导出可上 GPU 的紧凑数组:每个表面 [tintIndex, strength, x, y, w, h] × 6 float */
  exportUniformArray(): Float32Array {
    const list = [...this.entries.values()];
    const out = new Float32Array(list.length * 6);
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      out[i * 6] = e.tintIndex;
      out[i * 6 + 1] = e.strength;
      out[i * 6 + 2] = e.maskRect.x;
      out[i * 6 + 3] = e.maskRect.y;
      out[i * 6 + 4] = e.maskRect.w;
      out[i * 6 + 5] = e.maskRect.h;
    }
    return out;
  }

  /** 网络同步:6 bit 打包(低 5 位色号 + 0x3f 作为「未染色」哨兵) */
  static packTint(tintIndex: number): number {
    return tintIndex < 0 ? 0x3f : tintIndex & 0x1f;
  }

  static unpackTint(bits: number): number {
    const b = bits & 0x3f;
    return b === 0x3f ? NO_DYE : b & 0x1f;
  }

  /** 调色盘索引 → 十六进制色 */
  static colorOf(tintIndex: number): string {
    const i = Math.trunc(tintIndex);
    return i >= 0 && i < DYE_PALETTE_SIZE ? DYE_PALETTE[i] : '#FFFFFF';
  }
}

/* ───────────────────── 矩形工具 ───────────────────── */

function normalizeRect(r: DyeRect): DyeRect {
  return { x: r.x, y: r.y, w: Math.max(0, r.w), h: Math.max(0, r.h) };
}

/** 矩形并集(UV 空间) */
export function unionRect(a: DyeRect, b: DyeRect): DyeRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 由格坐标求 UV 覆盖矩形(用于整片墙) */
export function uvRectOfCells(x0: number, y0: number, x1: number, y1: number, size: number): DyeRect {
  const n = Math.max(1, size);
  const ax = Math.min(x0, x1) / n;
  const ay = Math.min(y0, y1) / n;
  const bx = (Math.max(x0, x1) + 1) / n;
  const by = (Math.max(y0, y1) + 1) / n;
  return {
    x: Math.min(1, Math.max(0, ax)),
    y: Math.min(1, Math.max(0, ay)),
    w: Math.min(1, Math.max(0, bx - ax)),
    h: Math.min(1, Math.max(0, by - ay)),
  };
}

/* ───────────────────── 与冻结层的对接 ───────────────────── */

/** 哪些单元是「可染色」的:obj 层非空即可染色(墙体/屋顶/家具都有 obj ID) */
export function isDyeableTile(tile: number): boolean {
  const u = unpackTile(tile);
  return u.obj !== 0;
}

/** 喷枪射程(格)与衰减:15 格内满强度,30 格外无效 */
export const SPRAY_RANGE_NEAR = 15;
export const SPRAY_RANGE_FAR = 30;

/** 距离 → 强度衰减(线性) */
export function sprayAttenuation(distance: number): number {
  const d = Math.abs(distance);
  if (d <= SPRAY_RANGE_NEAR) return 1;
  if (d >= SPRAY_RANGE_FAR) return 0;
  return 1 - (d - SPRAY_RANGE_NEAR) / (SPRAY_RANGE_FAR - SPRAY_RANGE_NEAR);
}

/** 单次喷色的染料消耗(格数越多越费) */
export function dyeCost(surfaceCells: number): number {
  return Math.max(1, Math.ceil(Math.max(0, surfaceCells) / 16));
}

/** 调色盘 UI 网格布局:8×4 */
export const PALETTE_COLS = 8;
export const PALETTE_ROWS = 4;

export function paletteCell(index: number): { row: number; col: number } {
  const i = Math.max(0, Math.min(DYE_PALETTE_SIZE - 1, Math.trunc(index)));
  return { row: Math.floor(i / PALETTE_COLS), col: i % PALETTE_COLS };
}