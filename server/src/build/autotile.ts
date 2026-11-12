/**
 * WS-03 / 墙体四向 Auto-Tile 拼接 + 351~385 建筑构件通行规则。
 *
 * 邻接位掩码约定(与 `Dir` 对齐):
 *   bit0 = 北(1)  bit1 = 东(2)  bit2 = 南(4)  bit3 = 西(8)
 * 因此掩码取值 0..15,共 16 种组合,一一对应一张墙体精灵。
 *
 * 分类规则(设计手册 §3.6「四向转角自动拼接」):
 *   0 个邻居           → NONE     (孤立柱,无拼接)
 *   1 个邻居           → END      (端点墙)
 *   2 个相邻邻居       → CORNER   (转角,需旋转)
 *   2 个对向邻居       → STRAIGHT (直墙,需旋转)
 *   3 个邻居           → TEE      (丁字/T 字形)
 *   4 个邻居           → CROSS    (十字)
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { OBJ_MASK } from '../../../shared/types/tile.ts';
import { type TileGridLike } from './grid.ts';

/** 四向掩码单 bit 常量。 */
export const MASK_N = 0b0001;
export const MASK_E = 0b0010;
export const MASK_S = 0b0100;
export const MASK_W = 0b1000;

/** 拼接分类(枚举替代:as const 对象 + 联合类型)。 */
export const AutoTileKind = {
  NONE: 'NONE',
  END: 'END',
  CORNER: 'CORNER',
  STRAIGHT: 'STRAIGHT',
  TEE: 'TEE',
  CROSS: 'CROSS',
} as const;
export type AutoTileKind = (typeof AutoTileKind)[keyof typeof AutoTileKind];

export interface AutoTileResult {
  /** 原始邻接位掩码 0..15 */
  mask: number;
  /** 分类 */
  kind: AutoTileKind;
  /** 精灵索引(0..15 基础表,或转角变体表偏移后的值) */
  spriteIndex: number;
  /** 旋转四分之一圈数 0..3,供渲染层顺时针旋转 */
  rotation: number;
  /** 解码后的四向连接状态 */
  connects: { north: boolean; east: boolean; south: boolean; west: boolean };
}

export interface AutoTileConfig {
  /** 16 项精灵索引表:mask → 精灵索引。默认恒等(0..15)。 */
  spriteTable: readonly number[];
  /** 转角精灵变体数:设为 4 时 CORNER 会按 rotation 偏移 `spriteTable[mask] + rotation`。 */
  cornerVariants: number;
  /** 直墙变体数:设为 2 时 STRAIGHT 会按 rotation 偏移。 */
  straightVariants: number;
}

/** 默认 16 项精灵表:直接以掩码为图集下标(4×4 图集,行=北向,列=东向)。 */
export const DEFAULT_SPRITE_TABLE: readonly number[] = Object.freeze(
  Array.from({ length: 16 }, (_v, i) => i),
);

export const DEFAULT_AUTOTILE_CONFIG: AutoTileConfig = {
  spriteTable: DEFAULT_SPRITE_TABLE,
  cornerVariants: 4,
  straightVariants: 2,
};

/** 邻居数量 → 分类(只看 bit 数,再区分相邻/对向)。 */
const POPCOUNT_TABLE: readonly number[] = Object.freeze(
  Array.from({ length: 16 }, (_v, m) => {
    let n = 0;
    for (let b = 0; b < 4; b += 1) if ((m & (1 << b)) !== 0) n += 1;
    return n;
  }),
);

/** 位掩码 → 分类。纯函数,16 种输入穷举覆盖。 */
export function classifyMask(mask: number): AutoTileKind {
  const m = mask & 0b1111;
  const n = POPCOUNT_TABLE[m];
  if (n === 0) return AutoTileKind.NONE;
  if (n === 1) return AutoTileKind.END;
  if (n === 3) return AutoTileKind.TEE;
  if (n === 4) return AutoTileKind.CROSS;
  /* n === 2:相邻 → CORNER,对向 → STRAIGHT */
  const adjacent = (m & MASK_N) !== 0 && (m & MASK_E) !== 0
    || (m & MASK_E) !== 0 && (m & MASK_S) !== 0
    || (m & MASK_S) !== 0 && (m & MASK_W) !== 0
    || (m & MASK_W) !== 0 && (m & MASK_N) !== 0;
  return adjacent ? AutoTileKind.CORNER : AutoTileKind.STRAIGHT;
}

/**
 * 四向转角自动拼接的旋转量(四分之一圈,顺时针)。
 *  - END:邻居在北→0、东→1、南→2、西→3(端点朝邻居方向)
 *  - CORNER:NE→0、ES→1、SW→2、WN→3(以「缺口朝东北」为基准图)
 *  - STRAIGHT:NS→0、EW→1
 *  - TEE:以「缺哪一向」为编号 —— 缺北→0、缺东→1、缺南→2、缺西→3
 *  - NONE / CROSS:恒 0
 */
export function resolveRotation(mask: number): number {
  const m = mask & 0b1111;
  const kind = classifyMask(m);
  if (kind === AutoTileKind.END) {
    if (m === MASK_N) return 0;
    if (m === MASK_E) return 1;
    if (m === MASK_S) return 2;
    if (m === MASK_W) return 3;
  }
  if (kind === AutoTileKind.CORNER) {
    if (m === (MASK_N | MASK_E)) return 0;
    if (m === (MASK_E | MASK_S)) return 1;
    if (m === (MASK_S | MASK_W)) return 2;
    if (m === (MASK_W | MASK_N)) return 3;
  }
  if (kind === AutoTileKind.STRAIGHT) {
    if (m === (MASK_N | MASK_S)) return 0;
    if (m === (MASK_E | MASK_W)) return 1;
  }
  if (kind === AutoTileKind.TEE) {
    if ((m & MASK_N) === 0) return 0;
    if ((m & MASK_E) === 0) return 1;
    if ((m & MASK_S) === 0) return 2;
    if ((m & MASK_W) === 0) return 3;
  }
  return 0;
}

/** 掩码 → 完整 Auto-Tile 结果(精灵索引 + 分类 + 旋转)。 */
export function resolveAutoTile(mask: number, cfg: AutoTileConfig = DEFAULT_AUTOTILE_CONFIG): AutoTileResult {
  const m = mask & 0b1111;
  const kind = classifyMask(m);
  const rotation = resolveRotation(m);
  const base = cfg.spriteTable[m] ?? m;
  let spriteIndex = base;
  if (kind === AutoTileKind.CORNER && cfg.cornerVariants > 1) {
    spriteIndex = base + (rotation % cfg.cornerVariants);
  } else if (kind === AutoTileKind.STRAIGHT && cfg.straightVariants > 1) {
    spriteIndex = base + (rotation % cfg.straightVariants);
  }
  return {
    mask: m,
    kind,
    spriteIndex,
    rotation,
    connects: {
      north: (m & MASK_N) !== 0,
      east: (m & MASK_E) !== 0,
      south: (m & MASK_S) !== 0,
      west: (m & MASK_W) !== 0,
    },
  };
}

/** 从四邻接布尔值合成掩码。 */
export function maskOf(n: boolean, e: boolean, s: boolean, w: boolean): number {
  return ((n ? MASK_N : 0) | (e ? MASK_E : 0) | (s ? MASK_S : 0) | (w ? MASK_W : 0)) & 0b1111;
}

/**
 * 按谓词采样四邻域,得到 (x,y) 处的掩码。
 * 谓词签名 `(objId: number, x: number, y: number) => boolean`;
 * 越界邻居一律视为「不连接」,保证边界墙不会错误连到世界外。
 */
export function sampleMask(
  grid: TileGridLike,
  x: number,
  y: number,
  isSame: (objId: number, x: number, y: number) => boolean,
): number {
  const near = (dx: number, dy: number): boolean => {
    const nx = x + dx;
    const ny = y + dy;
    if (!grid.inBounds(nx, ny)) return false;
    const id = (grid.get(nx, ny) & OBJ_MASK) >>> 16;
    if (id === 0) return false;
    return isSame(id, nx, ny);
  };
  return maskOf(near(0, -1), near(1, 0), near(0, 1), near(-1, 0));
}

/** 单体 Auto-Tile:直接在网格上取 (x,y) 的结果。 */
export function autoTileAt(
  grid: TileGridLike,
  x: number,
  y: number,
  isSame: (objId: number, x: number, y: number) => boolean,
  cfg: AutoTileConfig = DEFAULT_AUTOTILE_CONFIG,
): AutoTileResult {
  return resolveAutoTile(sampleMask(grid, x, y, isSame), cfg);
}

export interface AutoTileCell extends AutoTileResult {
  x: number;
  y: number;
}

/**
 * 全图 Auto-Tile:只对满足 `isSelf` 的格产出结果,其余跳过。
 * 复杂度 O(W·H),单格常数 5 次位与 + 2 次表查,512×512 约 26 万格。
 */
export function autoTileAll(
  grid: TileGridLike,
  isSelf: (objId: number, x: number, y: number) => boolean,
  cfg: AutoTileConfig = DEFAULT_AUTOTILE_CONFIG,
): AutoTileCell[] {
  const out: AutoTileCell[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const id = (grid.get(x, y) & OBJ_MASK) >>> 16;
      if (id === 0 || !isSelf(id, x, y)) continue;
      const r = autoTileAt(grid, x, y, isSelf, cfg);
      out.push({ x, y, ...r });
    }
  }
  return out;
}

/* ═══════════════════════ 351~385 建筑构件属性与 377~385 高低差走位 ═══════════════════════ */

/**
 * 构件通行属性。
 *  - solid        : 阻挡玩家移动
 *  - blocksMob    : 阻挡野生动物/Boss
 *  - playerPass   : 玩家可主动穿越(暗道墙 362)
 *  - transparent  : 半透明/全透明,室内屋顶淡出参与
 *  - elevDelta    : 通行时的海拔变化 +1 / −1 / 0
 *  - walkable     : 可站立
 */
export interface BuildingTrait {
  id: number;
  solid: boolean;
  blocksMob: boolean;
  playerPass: boolean;
  transparent: boolean;
  elevDelta: number;
  walkable: boolean;
}

const DEFAULT_TRAIT: BuildingTrait = {
  id: 0,
  solid: true,
  blocksMob: true,
  playerPass: false,
  transparent: false,
  elevDelta: 0,
  walkable: false,
};

function trait(id: number, patch: Partial<BuildingTrait>): BuildingTrait {
  return { ...DEFAULT_TRAIT, id, ...patch };
}

/** 351~385 全 35 项建筑构件属性表(IDS 与冻结层 `ITEMS` 分表 §3.6 一致)。 */
export const BUILDING_TRAITS: ReadonlyMap<number, BuildingTrait> = new Map<number, BuildingTrait>([
  [351, trait(351, {})],
  [352, trait(352, {})],
  [353, trait(353, {})],
  [354, trait(354, { transparent: true })],
  [355, trait(355, { transparent: true })],
  [356, trait(356, { transparent: true })],
  /* 357 竹篱笆:半高围栏,可圈养却不挡视线与箭矢 */
  [357, trait(357, { solid: false, blocksMob: true, transparent: true, walkable: false })],
  [358, trait(358, { transparent: true })],
  [359, trait(359, {})],
  [360, trait(360, {})],
  /* 361 高弹软包:撞上反弹,不阻挡 */
  [361, trait(361, { solid: false, blocksMob: true })],
  /* 362 单向透视暗道:玩家可穿,怪物不可 */
  [362, trait(362, { solid: false, playerPass: true, blocksMob: true })],
  /* 363~369 门窗:默认关门状态阻挡,开门由门状态机驱动 */
  [363, trait(363, {})],
  [364, trait(364, {})],
  [365, trait(365, { solid: false, blocksMob: true })],
  [366, trait(366, { solid: false, blocksMob: true })],
  [367, trait(367, {})],
  [368, trait(368, {})],
  [369, trait(369, {})],
  /* 370~371 窗:嵌墙,不阻挡玩家(如墙则 370 视为墙体) */
  [370, trait(370, {})],
  [371, trait(371, { solid: false, blocksMob: true, transparent: true })],
  /* 372~376 屋顶:半透明,不参与碰撞,角色走入室内自动淡出 */
  [372, trait(372, { solid: false, blocksMob: false, transparent: true, walkable: true })],
  [373, trait(373, { solid: false, blocksMob: false, transparent: true, walkable: true })],
  [374, trait(374, { solid: false, blocksMob: false, transparent: true, walkable: true })],
  [375, trait(375, { solid: false, blocksMob: false, transparent: true, walkable: true })],
  [376, trait(376, { solid: false, blocksMob: false, transparent: true, walkable: true })],
  /* 377~378 阶梯:连接 Z ↔ Z+1,可站立,不阻挡 */
  [377, trait(377, { solid: false, blocksMob: false, walkable: true, elevDelta: 1 })],
  [378, trait(378, { solid: false, blocksMob: false, walkable: true, elevDelta: 1 })],
  /* 379 藤蔓梯:贴崖壁垂直攀爬 */
  [379, trait(379, { solid: false, blocksMob: false, walkable: true, elevDelta: 1 })],
  /* 380 吊桥:跨越高台,下方怪物够不到 */
  [380, trait(380, { solid: false, blocksMob: false, walkable: true })],
  /* 381 拱桥:横跨 Z=-1 河道 */
  [381, trait(381, { solid: false, blocksMob: false, walkable: true })],
  /* 382 滑索:单向高空→低空位移 */
  [382, trait(382, { solid: false, blocksMob: false, walkable: false })],
  /* 383 护栏:阻挡玩家掉下悬崖 */
  [383, trait(383, { solid: false, blocksMob: false })],
  /* 384 烟囱:屋顶装饰 */
  [384, trait(384, { solid: false, blocksMob: false, transparent: true })],
  /* 385 露台栏杆 */
  [385, trait(385, { solid: false, blocksMob: false })],
]);

/** 高低差构件 ID 集合(§3.6 377~385)。 */
export const HIGH_LOW_IDS: readonly number[] = Object.freeze([377, 378, 379, 380, 381, 382, 383, 384, 385]);

/** 阶梯类(允许 z 与 z+1 双向走位)。 */
export const STAIR_IDS: readonly number[] = Object.freeze([377, 378, 379]);
/** 桥类(跨越低海拔障碍,海拔保持不变)。 */
export const BRIDGE_IDS: readonly number[] = Object.freeze([380, 381]);
/** 单向位移件(只允许高→低)。 */
export const ONE_WAY_IDS: readonly number[] = Object.freeze([382]);
/** 边缘防护件(阻挡坠落但不阻挡移动)。 */
export const EDGE_GUARD_IDS: readonly number[] = Object.freeze([383, 385]);

export interface TraverseQuery {
  /** 落脚目标格的构件 ID(0 表示空地) */
  objId: number;
  /** 出发海拔 Z */
  fromElev: number;
  /** 目标格海拔 Z */
  toElev: number;
  /** 目标格是否被水流/熔岩占据(来自 `BaseFluid`) */
  targetIsFluid: boolean;
  /** 实体类型:玩家可穿暗道墙,怪物不可 */
  isPlayer: boolean;
}

export interface TraverseVerdict {
  allowed: boolean;
  /** 到达目标格后的海拔 */
  resultElev: number;
  /** 移动速度乘数(阶梯/吊桥有减速) */
  speedMul: number;
  /** 拒绝原因代码 */
  reason: string;
}

const DENY = (reason: string): TraverseVerdict => ({ allowed: false, resultElev: 0, speedMul: 0, reason });

/**
 * 377~385 高低差通行判定。
 * 规则要点:
 *  1. 阶梯 377/378/379 只允许 |ΔZ| ≤ 1,且任意方向均可上下;
 *  2. 吊桥 380 / 拱桥 381 跨越被流体占据的格,海拔保持出发值;
 *  3. 滑索 382 只允许 fromElev > toElev(高→低),逆向拒绝;
 *  4. 护栏 383/385 不阻挡水平移动,只在下落判定时提供 1 次拦截(由 moved 层处理);
 *  5. 烟囱 384 为屋顶装饰,不参与走位,允许穿越;
 *  6. 其它实心构件(墙体/门)一律阻挡。
 */
export function canTraverse(q: TraverseQuery): TraverseVerdict {
  const id = q.objId | 0;
  const dz = q.toElev - q.fromElev;

  if (id === 0) {
    /* 空地:允许平层,拒绝跨越 2 级以上落差 */
    if (dz > 1) return DENY('CLIFF_UP');
    if (dz < -1) return DENY('CLIFF_DOWN');
    return { allowed: true, resultElev: q.toElev, speedMul: 1, reason: 'EMPTY' };
  }

  if (BRIDGE_IDS.includes(id)) {
    /* 桥:跨越流体,海拔不变 */
    return { allowed: true, resultElev: q.fromElev, speedMul: id === 380 ? 0.9 : 1, reason: 'BRIDGE' };
  }

  if (STAIR_IDS.includes(id)) {
    if (Math.abs(dz) > 1) return DENY('STAIR_DZ_OVERFLOW');
    const speedMul = id === 379 ? 0.6 : 0.85;
    return { allowed: true, resultElev: q.toElev, speedMul, reason: 'STAIR' };
  }

  if (ONE_WAY_IDS.includes(id)) {
    if (dz >= 0) return DENY('ZIPLINE_NEEDS_DROP');
    return { allowed: true, resultElev: q.toElev, speedMul: 3.0, reason: 'ZIPLINE' };
  }

  if (id === 384) {
    /* 烟囱:装饰,可穿过 */
    return { allowed: true, resultElev: q.fromElev, speedMul: 1, reason: 'CHIMNEY_DECOR' };
  }

  if (EDGE_GUARD_IDS.includes(id)) {
    return { allowed: true, resultElev: q.fromElev, speedMul: 1, reason: 'EDGE_GUARD' };
  }

  const t = BUILDING_TRAITS.get(id);
  if (!t) {
    /* 非 §3.6 构件(电路/家具等)→ 视为可站立但不阻挡,由各自子系统裁决 */
    return { allowed: true, resultElev: q.toElev, speedMul: 1, reason: 'NON_BUILDING' };
  }
  if (t.playerPass && q.isPlayer) {
    return { allowed: true, resultElev: q.toElev, speedMul: 1, reason: 'PASS_THROUGH' };
  }
  if (!t.solid && !t.blocksMob) {
    return { allowed: true, resultElev: q.toElev, speedMul: 1, reason: 'NON_SOLID' };
  }
  if (!t.solid && q.isPlayer) {
    return { allowed: true, resultElev: q.toElev, speedMul: 1, reason: 'PLAYER_OPEN' };
  }
  return DENY(t.blocksMob ? 'BLOCKED_SOLID' : 'BLOCKED');
}

/** §3.6 墙体层构件 ID 区间(351~362)。 */
export const WALL_IDS: readonly number[] = Object.freeze(
  Array.from({ length: 12 }, (_v, i) => 351 + i),
);
/** §3.6 门窗构件 ID 区间(363~369),可开启但仍计入围合。 */
export const DOOR_IDS: readonly number[] = Object.freeze(
  Array.from({ length: 7 }, (_v, i) => 363 + i),
);
/** §3.6 窗类构件(370 观景窗 / 371 传菜窗口),嵌墙不破围合。 */
export const WINDOW_IDS: readonly number[] = Object.freeze([370, 371]);
/** §3.6 屋顶构件 ID 区间(372~376),不参与围合判定。 */
export const ROOF_IDS: readonly number[] = Object.freeze(
  Array.from({ length: 5 }, (_v, i) => 372 + i),
);

export function isWall(objId: number): boolean {
  const id = objId | 0;
  return id >= 351 && id <= 362;
}

export function isDoor(objId: number): boolean {
  const id = objId | 0;
  return id >= 363 && id <= 369;
}

export function isWindow(objId: number): boolean {
  const id = objId | 0;
  return id === 370 || id === 371;
}

export function isRoof(objId: number): boolean {
  const id = objId | 0;
  return id >= 372 && id <= 376;
}

/**
 * 围合构件判定:BFS 房间检测中「可以把内外隔开」的格。
 *  - 351~371 全部计入(墙 / 门 / 窗);
 *  - 357 翠竹篱笆属半高围栏,由 `sealSemiOpen` 开关决定是否计入(默认计入,生态牧场需要);
 *  - 屋顶 372~376 与高低差构件 377~385 一律不计入(它们在房间之上或只是通行件)。
 */
export function isBarrier(objId: number, sealSemiOpen = true): boolean {
  const id = objId | 0;
  if (id === 357) return sealSemiOpen;
  return id >= 351 && id <= 371;
}

/** 该构件是否与相邻同类构件自动拼接(墙体 + 篱笆 + 屋顶 + 桥)。 */
export function isAutoTileable(objId: number): boolean {
  const id = objId | 0;
  if (id >= 351 && id <= 362) return true; /* 墙体 */
  if (id === 370 || id === 371) return true; /* 窗 */
  if (id >= 372 && id <= 376) return true; /* 屋顶 */
  if (id === 380 || id === 381 || id === 383 || id === 385) return true; /* 桥与栏杆 */
  return false;
}

/** 默认同类判定:同 ID 才拼接(墙体纹理族按 tag 分组时可替换)。 */
export function sameIdPredicate(objId: number, x: number, y: number): boolean {
  void x;
  void y;
  return objId !== 0;
}