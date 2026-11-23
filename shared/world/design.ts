/**
 * **设计过的世界**(手工设计图,不是随机噪声)。
 *
 * ## 为什么需要这个文件
 *
 * 现状(defect-as-baseline):`play.ts` 装配出来的世界里,地形**一格都没写** ——
 * 玩家看到的那点绿色是一块默认平台 + 一片海,`WorldSim` 的群系是**整图一个**
 * `biomeName`(默认 `MEADOW`,见 `world_sim.ts` 的字段注释「本仓没有每格群系」)。
 * 于是「地图小、没设计、一堆像素块」是**结构性**的,不是调色问题:
 *
 *   1. 没有区域划分 ⇒ 走到哪都是同一种地面;
 *   2. 没有道路/地标 ⇒ 没有「该往哪走」的信息;
 *   3. 没有内容点 ⇒ 刷出来的怪与物件是均匀撒的,不是「这里有矿丘、那里是遗迹」。
 *
 * 本文件把「设计」落成**纯数据 + 一次盖章**(`applyWorldDesign`),它是:
 *
 *   - **确定性**:同一个 `size` 必然产出同一张图(无 `Math.random`、无时间);
 *   - **可机检**:返回 `DesignReport`(各区格数 / 道路格数 / 地标数 / 出生点),
 *     供判据直接断言,而不是靠看图;
 *   - **只用已核实的内容 id**:`BaseFluid`(tile.ts)、`Elevation`(tile.ts)、
 *     地砖 301~330(`chunk.ts#FLOOR_PALETTE`,经 `floorSlotOfId` 转槽位)、
 *     家具/建筑 id(shared/constants/items.ts)。
 *
 * ## 图层口径(踩过的坑)
 *
 *   - `floor` 写的是**槽位号**(0 = 无铺装,1..30 = 地砖 301..330),不是物品 id。
 *     ⇒ 一律经 `floorSlotOfId()` 换算,绝不手写槽位数字。
 *   - `base` 是 `BaseFluid`(0 VOID / 1 GRASS / 2 DIRT / 3 GOLD_SAND / 4 ROCK /
 *     5 SHALLOW_WATER / 6 HOT_SPRING / 7 SLIME / 8 LAVA / 9 CHOCO)。
 *   - `elev` 是 `Elevation`,渲染 z = `[-1,0,1,2][elev]`。
 *     ⚠️ **出生点区域必须留在 `elev = GROUND`**:玩家出生 z 与地面 z 不一致时,
 *     表现是「人卡在抬高的台子里」—— 所以中央营地刻意**不抬高**,
 *     靠地砖(红砖广场)而不是靠高度做出「广场」。
 *
 * ## 与渲染的关系(同一条根因的另一半)
 *
 * 客户端地形原本**只按海拔层**着色(`client/src/stage/terrain_vcolor.ts` 的
 * `ELEV_BASE_RGB`,4 色)。所以本文件铺出来的 `base` / `floor` 要看得见,
 * 必须同时有顶面材质调色板(`topColorOf`)。两边一起才叫「世界能看」。
 */

import { BaseFluid, Elevation, type TileFields } from '../types/tile.ts';

/* ═══════════ 地砖「槽位 ↔ 物品 id」换算(本文件自持一份)═══════════
 *
 * ⚠️ 这里**故意**与 `server/src/world/chunk.ts#floorSlotOfId` 各写一份:
 * 那份在 `server/**` 里,而本文件放在 `shared/**` 是为了让**客户端**也能用
 * 同一张设计图(`client/src/stage/design_world.ts`)—— 客户端不 import server。
 *
 * 两份实现会不会漂移?会 —— 所以有一条**交叉判据**把它们钉在一起:
 * `tests/WS-FND-181-world-design.test.ts` 对 id 0..400 逐个断言两个函数同值。
 * 这是「两处各写一份 + 断言钉住」,不是「两套真相」。
 *
 * 规则(与 `chunk.ts#FLOOR_PALETTE` 逐字对应):
 *   槽位 0      = 无铺装(裸地)
 *   槽位 1..30  = 物品 301..330
 *   槽位 31..63 = 314(自定义像素地毯)的变体槽
 */
export const FLOOR_SLOT_TO_ID_MIN = 301;
export const FLOOR_SLOT_BASE_COUNT = 30;
export const FLOOR_UGC_ID = 314;
export const FLOOR_UGC_FIRST = 31;
export const FLOOR_SLOT_MASK = 0x3f;

/** 物品 id → 槽位(0 = 无铺装)。 */
export function floorSlotOfId(id: number): number {
  if (!Number.isFinite(id) || id <= 0) return 0;
  const i = Math.floor(id);
  if (i >= FLOOR_SLOT_TO_ID_MIN && i < FLOOR_SLOT_TO_ID_MIN + FLOOR_SLOT_BASE_COUNT) {
    return i - FLOOR_SLOT_TO_ID_MIN + 1;
  }
  if (i === FLOOR_UGC_ID) return FLOOR_UGC_FIRST;
  return 0;
}

/** 槽位 → 物品 id(0 槽位与越界都回 0 = 无铺装)。 */
export function floorIdOfSlot(slot: number): number {
  if (!Number.isFinite(slot)) return 0;
  const s = Math.trunc(slot) & FLOOR_SLOT_MASK;
  if (s >= 1 && s <= FLOOR_SLOT_BASE_COUNT) return FLOOR_SLOT_TO_ID_MIN + s - 1;
  if (s >= FLOOR_UGC_FIRST) return FLOOR_UGC_ID;
  return 0;
}

/* ═══════════════════════ 1. 设计常量 ═══════════════════════ */

/** 设计图边长(格)。96 太小(走两步就到边),512 太重(建面/存档)。 */
export const DESIGN_SIZE = 192;

/** 世界中心(格坐标)。出生点与中央营地都挂在这里。 */
export const DESIGN_CENTER = Math.floor(DESIGN_SIZE / 2);

/**
 * 海岸线半径函数(极角 → 半径,单位:格)。
 *
 * 三个谐波叠加 ⇒ 海湾与岬角,**不是圆**;取值范围 68..88,
 * 上限 88 < 96 − 2 保证四周始终留一圈海,下限 68 保证所有区域(≤61)都在陆地上。
 */
export function coastRadius(theta: number): number {
  return 78
    + 5 * Math.cos(3 * theta + 0.7)
    + 3 * Math.cos(5 * theta - 1.1)
    + 2 * Math.cos(7 * theta + 2.2);
}

/** 沙滩带宽度(格,自海岸线向内)。 */
export const BEACH_BAND = 6;

/** 环形主干道半径带(格):38~40 共 3 格宽。 */
export const RING_INNER = 38;
export const RING_OUTER = 40;

/** 道路允许的最长跨海栈桥长度(格)。超过就不再铺 —— 免得把路画到海对面。 */
export const PIER_MAX = 14;

/* ═══════════════════════ 2. 区域表(设计本体) ═══════════════════════ */

/**
 * 一个区域的**静态**规格。位置/形状是命令式的(见 `applyWorldDesign`),
 * 这里只声明「这块地是什么料、什么颜色、干什么用」。
 *
 * `floorItemId = 0` 表示**不铺装**(顶面颜色回落 `base`)。
 */
export interface RegionSpec {
  /** 稳定标识(kebab,判据与文档都引用它)。 */
  id: string;
  /** 中文名。 */
  name: string;
  /** 地表材质(`BaseFluid`)。 */
  base: number;
  /** 地砖物品 id(301~330),0 = 裸地。 */
  floorItemId: number;
  /** 海拔层(`Elevation`)。 */
  elev: number;
  /** 设计意图(一句话,为什么这块地存在)。 */
  intent: string;
}

/**
 * 11 个区域。颜色列是**实测值**(`BASE_TOP_RGB` / `FLOOR_TOP_RGB`,见
 * `client/src/stage/terrain_vcolor.ts`),两两 RGB 距离足够大 ⇒ 截图能分辨。
 */
export const REGIONS: readonly RegionSpec[] = [
  {
    id: 'camp', name: '中央营地', base: BaseFluid.GRASS, floorItemId: 305, elev: Elevation.GROUND,
    intent: '出生点:红砖广场 + 工作台一条街,玩家睁眼就知道「这里是家」。',
  },
  {
    id: 'meadow', name: '草原', base: BaseFluid.GRASS, floorItemId: 0, elev: Elevation.GROUND,
    intent: '采集起点:草绿开阔地,小径穿场,草绳/风草产地。',
  },
  {
    id: 'grove', name: '竹林', base: BaseFluid.GRASS, floorItemId: 312, elev: Elevation.GROUND,
    intent: '木材产地:深绿草皮区分于草原,让「换了一个地方」肉眼可见。',
  },
  {
    id: 'farm', name: '农田', base: BaseFluid.DIRT, floorItemId: 301, elev: Elevation.GROUND,
    intent: '生产循环起点:土褐色耕地 + 灌溉渠,播种/收获的固定场地。',
  },
  {
    id: 'mine', name: '矿丘', base: BaseFluid.ROCK, floorItemId: 0, elev: Elevation.GROUND,
    intent: '资源与地标:灰色岩丘(中心抬高成山),一条铁轨通到丘口。',
  },
  {
    id: 'ruins', name: '遗迹', base: BaseFluid.ROCK, floorItemId: 306, elev: Elevation.GROUND,
    intent: '终点感:近白大理石广场 + 棋盘祭坛,主线最后一站。',
  },
  {
    id: 'lake', name: '湖与泉', base: BaseFluid.SHALLOW_WATER, floorItemId: 0, elev: Elevation.DEEP,
    intent: '水面地形:深蓝湖心 + 青白温泉眼,栈桥横跨。',
  },
  {
    id: 'spring', name: '温泉眼', base: BaseFluid.HOT_SPRING, floorItemId: 0, elev: Elevation.DEEP,
    intent: '湖心独有的一小片青白水面,给湖一个「记得住」的点。',
  },
  {
    id: 'track', name: '竞速场', base: BaseFluid.DIRT, floorItemId: 313, elev: Elevation.GROUND,
    intent: '玩点:红色塑胶跑道环 + 草皮内场,不用怪也能玩的地方。',
  },
  {
    id: 'marsh', name: '沼泽', base: BaseFluid.DIRT, floorItemId: 316, elev: Elevation.GROUND,
    intent: '风险地形:紫色减速泥沼,绕路或吃减速,给地图一个「别乱走」。',
  },
  {
    id: 'highland', name: '高地', base: BaseFluid.ROCK, floorItemId: 0, elev: Elevation.GROUND,
    intent: '视野点:北侧抬高的岩台,爬上去能一眼看到营地与环路。',
  },
  {
    id: 'dunes', name: '沙丘', base: BaseFluid.GOLD_SAND, floorItemId: 0, elev: Elevation.GROUND,
    intent: '沙漠群系:金沙丘,挖琉璃石英砂的地方,也是沙蝎的地盘。',
  },
];


// 每个区的**群系**(键 = `REGIONS[].id`)。键必须与 `server/src/mobs/spawner.ts#BIOME_SPAWN`
// 的键**逐字**一致 —— 写错不会报错,spawner 会 `?? MEADOW` 静默兜底,症状是「全图的怪变成同一批」。
export const REGION_BIOME: Readonly<Record<string, string>> = {
  camp: 'MEADOW',
  meadow: 'MEADOW',
  grove: 'SAKURA',
  farm: 'VALLEY',
  mine: 'CAVERN',
  ruins: 'RUINS',
  lake: 'OASIS',
  spring: 'OASIS',
  dunes: 'DESSERT',
  track: 'MEADOW',
  marsh: 'VALLEY',
  highland: 'SKYSEA',
};

// 八个群系的键(与 `BIOME_SPAWN` 逐字一致)。判据 `WS-FND-181` 断言**每个键都被用到** ——
// 否则那个群系的野生物永远不会出现在世界上,而"少了几只怪"没人会发现。
export const BIOME_KEYS: readonly string[] = [
  'MEADOW', 'VALLEY', 'SAKURA', 'CAVERN', 'OASIS', 'DESSERT', 'SKYSEA', 'RUINS',
];
/* ═══════════════════════ 3. 写入接口(窄接口,便于单测) ═══════════════════════ */

/**
 * 盖章只要三个能力。刻意**不**收 `WorldSim` 整个对象:
 * 判据可以用一个 20 行的内存桩来验「设计图长什么样」,不需要起完整模拟。
 */
export interface DesignWriter {
  readonly sizeCells: number;
  setCell(x: number, y: number, fields: Partial<TileFields>): void;
  fillRect(x0: number, y0: number, x1: number, y1: number, fields: Partial<TileFields>): number;
}

/** 各区实际盖了多少格(用于判据「11 个区都真的存在」)。 */
export interface RegionCount {
  id: string;
  name: string;
  cells: number;
}

/** 盖章结果的**可机检**账本。 */
export interface DesignReport {
  size: number;
  /** 每格都被写过一次(海面)。 */
  cells: number;
  landCells: number;
  seaCells: number;
  beachCells: number;
  /** 主干道格数(环路 + 四条主路)。 */
  roadCells: number;
  /** 跨海栈桥格数。 */
  pierCells: number;
  /** 地标物件数(`obj` 层)。 */
  landmarkCells: number;
  /** 出生点(世界格坐标)。 */
  spawn: { x: number; y: number };
  /** 每个区的实际格数(按 `REGIONS` 顺序)。 */
  regions: RegionCount[];
  /** 用了哪些地砖物品 id(判据用它证明「地表不止一种」)。 */
  floorItemIds: number[];
}

/** 报告里的 `floorItemIds` 按数值升序去重。 */
function sortedUnique(xs: readonly number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/* ═══════════════════════ 4. 盖章 ═══════════════════════ */

/** 陆地掩码:`1` = 陆地。构造一次,后续所有 pass 都查它。 */
function buildLandMask(size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy);
      mask[y * size + x] = r <= coastRadius(Math.atan2(dy, dx)) ? 1 : 0;
    }
  }
  return mask;
}

/**
 * 把设计图盖到世界上。**幂等**:对同一个 writer 连盖两次结果相同。
 *
 * `opts.size` 只影响海的边界与中心位置;区域/道路的**相对布局**按 `size/2` 缩放中心,
 * 但绝对半径是设计常量(192 格的尺度上量好的)—— 传别的 size 是「换边框」,
 * 不是「换设计」。
 */
export function applyWorldDesign(w: DesignWriter, opts: { size?: number } = {}): DesignReport {
  const size = Math.max(64, Math.trunc(opts.size ?? w.sizeCells ?? DESIGN_SIZE));
  const c = size / 2;
  const mask = buildLandMask(size);

  const inRange = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size;
  const isLand = (x: number, y: number): boolean => {
    const i = y * size + x;
    return i >= 0 && i < mask.length && mask[i] === 1;
  };
  const radiusOf = (x: number, y: number): { r: number; th: number } => {
    const dx = x + 0.5 - c;
    const dy = y + 0.5 - c;
    return { r: Math.hypot(dx, dy), th: Math.atan2(dy, dx) };
  };

  /** 统计用。 */
  let cells = 0;
  let landCells = 0;
  let seaCells = 0;
  let beachCells = 0;
  let roadCells = 0;
  let pierCells = 0;
  let landmarkCells = 0;
  const perRegion = new Map<string, number>();
  const floorIds = new Set<number>();

  /** 写一格并按需记账。`land:false` 允许写海(栈桥)。 */
  const put = (x: number, y: number, fields: Partial<TileFields>): void => {
    if (!inRange(x, y)) return;
    w.setCell(x, y, fields);
    if (fields.floor !== undefined && fields.floor !== 0) {
      const id = floorIdOfSlot(fields.floor);
      if (id !== 0) floorIds.add(id);
    }
  };

  const markRegion = (id: string): void => {
    perRegion.set(id, (perRegion.get(id) ?? 0) + 1);
  };

  /* ── 4.1 海:整图先铺一层浅水(elev = DEEP ⇒ z = −1)──
     为什么整图先写一遍:不写的话没动过的格子是「空」(obj/floor/base 全 0),
     `tile_mesh.tileZ` 会把它们当空气**不建面** ⇒ 世界的边界看得到「虚空缺口」。 */
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      put(x, y, { elev: Elevation.DEEP, base: BaseFluid.SHALLOW_WATER, floor: 0, obj: 0 });
      cells += 1;
      seaCells += 1;
    }
  }

  /* ── 4.2 陆地:海岸线内全部抬到 GROUND,草皮打底 ──
     沙滩带(自海岸线向内 BEACH_BAND 格)换成金沙 —— 第 1 种地表色。 */
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isLand(x, y)) continue;
      const { r, th } = radiusOf(x, y);
      const beach = r > coastRadius(th) - BEACH_BAND;
      put(x, y, {
        elev: Elevation.GROUND,
        base: beach ? BaseFluid.GOLD_SAND : BaseFluid.GRASS,
        floor: 0,
      });
      landCells += 1;
      seaCells -= 1;
      if (beach) beachCells += 1;
    }
  }

  /* ── 4.3 中央营地:24×24 红砖广场(第 2 种地表色)──
     刻意**不抬高**(elev 留 GROUND),理由见文件头:出生点与地面同高。 */
  const campHalf = 12;
  /** 营地矩形(24×24,含边界)。主路与路灯都要**避开它内部** —— 广场是终点。 */
  const inCamp = (x: number, y: number): boolean =>
    x >= DESIGN_CENTER - campHalf && x <= DESIGN_CENTER + campHalf - 1
    && y >= DESIGN_CENTER - campHalf && y <= DESIGN_CENTER + campHalf - 1;
  for (let y = DESIGN_CENTER - campHalf; y <= DESIGN_CENTER + campHalf - 1; y += 1) {
    for (let x = DESIGN_CENTER - campHalf; x <= DESIGN_CENTER + campHalf - 1; x += 1) {
      if (!isLand(x, y)) continue;
      put(x, y, { elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: floorSlotOfId(305) });
      markRegion('camp');
    }
  }
  /* 广场中心 8×8 纯白大理石(第 3 种色):广场的「圆心」,一眼认得出。 */
  for (let y = DESIGN_CENTER - 4; y <= DESIGN_CENTER + 3; y += 1) {
    for (let x = DESIGN_CENTER - 4; x <= DESIGN_CENTER + 3; x += 1) {
      if (!isLand(x, y)) continue;
      put(x, y, { floor: floorSlotOfId(306) });
    }
  }

  /* ── 4.4 11 个区域 ──
     形状**手放**(圆盘 / 矩形 / 环),位置全部落在半径 ≤ 61 的陆地上
     (海岸线最小半径 68 ⇒ 留 ≥ 7 格余量,不会被海切掉)。
     ⚠️ **后画的覆盖先画的**:嵌套层(温泉眼盖湖心、抬高层盖丘体、内场盖跑道)
     靠的正是这个顺序 —— 早先这里用同一个 `mask` 数组既当「陆地」又当
     「已被区域占用」,`isLand()` 只认 `=== 1`,于是第二遍画到已占用格时
     **整块被跳过**(实测:温泉眼 0 格、矿丘抬高层 / 高地崖层 / 竞速场内场全空)。
     陆地掩码只读、覆盖靠顺序,才是对的。 */
  const disc = (id: string, cx: number, cy: number, rad: number, spec: RegionSpec): void => {
    const slot = spec.floorItemId === 0 ? 0 : floorSlotOfId(spec.floorItemId);
    for (let y = cy - rad; y <= cy + rad; y += 1) {
      for (let x = cx - rad; x <= cx + rad; x += 1) {
        if (!inRange(x, y)) continue;
        if (Math.hypot(x - cx, y - cy) > rad) continue;
        if (!isLand(x, y)) continue;
        put(x, y, { elev: spec.elev, base: spec.base, floor: slot });
        markRegion(id);
      }
    }
  };
  const rect = (id: string, x0: number, y0: number, x1: number, y1: number, spec: RegionSpec): void => {
    const slot = spec.floorItemId === 0 ? 0 : floorSlotOfId(spec.floorItemId);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (!inRange(x, y) || !isLand(x, y)) continue;
        put(x, y, { elev: spec.elev, base: spec.base, floor: slot });
        markRegion(id);
      }
    }
  };
  const spec = (id: string): RegionSpec => {
    const s = REGIONS.find((r) => r.id === id);
    if (s === undefined) throw new Error(`未知区域 ${id}`);
    return s;
  };
  /* ── 区域绘制顺序 = 图层顺序:先铺「底」,后画「嵌进去的」──
     沼泽最先(它要给草原/跑道让位,只留一道楔形),遗迹最后(它离路最远)。 */

  /* 沼泽(西):紫色减速泥沼,夹在竞速场与海岸之间 —— 想抄近路去西边就得吃减速。 */
  rect('marsh', 30, 84, 46, 102, spec('marsh'));
  /* 草原(西北):草绿开阔地 + 一条鹅卵石小径穿场。 */
  disc('meadow', 64, 64, 16, spec('meadow'));
  for (let x = 64 - 16; x <= 64 + 16; x += 1) {
    for (let d = -1; d <= 1; d += 1) {
      if (Math.abs(x - 64) <= 16) put(x, 64 + d, { floor: floorSlotOfId(302) });
    }
  }
  /* 竹林(东北):深绿草皮(312),与草原的草绿区分开。 */
  disc('grove', 128, 64, 14, spec('grove'));
  /* 竞速场(西偏北):红色跑道环(313)+ 草皮内场(312)。
     ⚠️ 圆心**不在中轴**(52,72 而不是 48,96):主路沿 y=96 走,
     圆心压在中轴上会被 3 格宽的主路从正中劈开(实测:内场整条被路盖掉)。 */
  disc('track', 52, 72, 11, spec('track'));
  disc('track', 52, 72, 6, { ...spec('track'), floorItemId: 312 });
  /* 高地(北偏西):抬高的岩台(PLATFORM)与崖顶(CLIFF)。同样避开中轴(x=96 是主路)。 */
  disc('highland', 80, 48, 10, spec('highland'));
  disc('highland', 80, 48, 7, { ...spec('highland'), elev: Elevation.PLATFORM });
  disc('highland', 80, 48, 3, { ...spec('highland'), elev: Elevation.CLIFF });
  /* 矿丘(西南):灰岩圆丘 —— 外环 GROUND、中环 PLATFORM、丘心 CLIFF。 */
  disc('mine', 64, 128, 14, spec('mine'));
  disc('mine', 64, 128, 9, { ...spec('mine'), elev: Elevation.PLATFORM });
  disc('mine', 64, 128, 4, { ...spec('mine'), elev: Elevation.CLIFF });
  /* 丘口:一条 3 格宽铁轨自西侧通到丘口(抬高圆的半径 9 外沿在 x≈55),
     再往里就是抬成山的丘体 —— 玩家看到的是「一条铁轨领我上山」。 */
  for (let x = 64 - 16; x <= 55; x += 1) {
    for (let d = -1; d <= 1; d += 1) put(x, 128 + d, { elev: Elevation.GROUND, base: BaseFluid.ROCK, floor: floorSlotOfId(328) });
  }
  /* 农田(南偏东,挨着矿丘东侧):土褐耕地,横向三条灌溉渠(浅水 = 蓝色)。 */
  rect('farm', 80, 128, 106, 140, spec('farm'));
  for (const y of [131, 135, 139]) {
    for (let x = 80; x <= 106; x += 1) put(x, y, { base: BaseFluid.SHALLOW_WATER, elev: Elevation.GROUND });
  }
  // 沙丘(南偏东):金沙丘。**沙漠群系**的落点 —— 不给它一块地,`DESSERT` 的野生物
  // 就永远不会出现在世界上(24 种野生物里有几只只属于沙漠)。
  rect('dunes', 86, 146, 108, 158, spec('dunes'));
  /* 湖(东北偏东):深蓝水面;湖心偏北一团温泉眼(青白);一条 3 格宽木栈道横跨湖面。
     ⚠️ 湖心刻意**不在中轴**上:主路沿 y=96 横穿,压在中轴上会把温泉眼整条盖掉
     (实测:温泉眼格数 49 → 被路盖成路面)。 */
  disc('lake', 138, 74, 12, spec('lake'));
  disc('spring', 138, 66, 4, spec('spring'));
  for (let x = 138 - 12; x <= 138 + 12; x += 1) {
    if (Math.hypot(x - 138, 0) > 11) continue;
    for (let d = -1; d <= 1; d += 1) {
      put(x, 74 + d, { elev: Elevation.DEEP, base: BaseFluid.SHALLOW_WATER, floor: floorSlotOfId(310) });
    }
  }
  /* 遗迹(东南):近白大理石广场 + 棋盘祭坛 + 传送砖 A。 */
  rect('ruins', 118, 118, 138, 138, spec('ruins'));
  for (let y = 126; y <= 130; y += 1) {
    for (let x = 126; x <= 130; x += 1) put(x, y, { floor: floorSlotOfId(307) });
  }
  put(128, 128, { floor: floorSlotOfId(326) });
  /* 营地北侧再补一圈石径,把「广场 → 主路」的过渡做出来。 */
  for (let y = DESIGN_CENTER - campHalf; y <= DESIGN_CENTER + campHalf; y += 1) {
    for (let x = DESIGN_CENTER - campHalf; x <= DESIGN_CENTER + campHalf; x += 1) {
      if (!inRange(x, y)) continue;
      const edge = x === DESIGN_CENTER - campHalf || x === DESIGN_CENTER + campHalf
        || y === DESIGN_CENTER - campHalf || y === DESIGN_CENTER + campHalf;
      if (!edge) continue;
      if (!isLand(x, y)) continue;
      put(x, y, { floor: floorSlotOfId(302) });
    }
  }

  /* ── 4.5 道路:环路(半径 38~40)+ 四条主路 ──
     地砖 309「萤光星光夜路砖」:它自带「夜间发光并阻止野怪刷新」(items.ts note)
     ⇒ 用主干道把 11 个区串起来,同时给玩家一条**夜里也安全**的动线。 */
  const roadSlot = floorSlotOfId(309);
  const pierTargets: { x: number; y: number }[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const { r, th } = radiusOf(x, y);
      const onRing = r >= RING_INNER && r <= RING_OUTER;
      const onSpoke = (Math.abs(x + 0.5 - c) <= 1.5 || Math.abs(y + 0.5 - c) <= 1.5);
      /* 主路**不进广场内部**:营地是终点、不是通过点。不跳的话四条主路会从
         广场正中穿过去,把中心那 8×8 大理石圆(以及纪念碑/篝火)整块盖成路面
         —— 实测 (96,96) 的本该是大理石,却成了星光夜路砖 + 一盏路灯。 */
      if (inCamp(x, y)) continue;
      if (!onRing && !onSpoke) continue;
      /* 主路只在陆地上画;伸出海岸的那一段改成栈桥(见下),再远就不再铺 ——
         免得把路一直画到海对面(地图边界之外)。 */
      if (!isLand(x, y)) {
        if (onSpoke && r <= coastRadius(th) + PIER_MAX) pierTargets.push({ x, y });
        continue;
      }
      put(x, y, { elev: Elevation.GROUND, base: BaseFluid.DIRT, floor: roadSlot });
      roadCells += 1;
    }
  }
  /* 栈桥:主路伸出海岸的那一段铺水上浮木(310),到 PIER_MAX 为止。 */
  for (const p of pierTargets) {
    put(p.x, p.y, { elev: Elevation.DEEP, base: BaseFluid.SHALLOW_WATER, floor: floorSlotOfId(310) });
    pierCells += 1;
  }

  /* ── 4.6 地标(OBJ 层):不是装饰,是**玩法点** ──
     物件层同时决定「挡不挡路」(`grid.isSolidAt` 投影到流体场),
     所以这里只放**真的该挡路/该交互**的东西,不撒花瓣。 */
  const landmark = (x: number, y: number, objId: number): void => {
    if (!inRange(x, y)) return;
    w.setCell(x, y, { obj: objId });
    landmarkCells += 1;
  };
  const LANDMARKS: readonly { x: number; y: number; obj: number; why: string }[] = [
    /* 纯金通关纪念碑:主线终点物,站在广场中心就能看到。 */
    { x: DESIGN_CENTER, y: DESIGN_CENTER - 7, obj: 750, why: '通关纪念碑' },
    /* 暖心篝火茶座:治疗与重生点(家具 note:治疗/重生)。 */
    { x: DESIGN_CENTER, y: DESIGN_CENTER + 7, obj: 501, why: '篝火/重生' },
    /* 加工一条街:木工 → 高炉 → 铁砧 → 染缸 → 汤锅,玩家睁眼就有活干。 */
    { x: DESIGN_CENTER - 6, y: DESIGN_CENTER + 10, obj: 502, why: '木工台' },
    { x: DESIGN_CENTER - 3, y: DESIGN_CENTER + 10, obj: 503, why: '高炉' },
    { x: DESIGN_CENTER, y: DESIGN_CENTER + 10, obj: 504, why: '铁砧' },
    { x: DESIGN_CENTER + 3, y: DESIGN_CENTER + 10, obj: 505, why: '染缸' },
    { x: DESIGN_CENTER + 6, y: DESIGN_CENTER + 10, obj: 506, why: '大汤锅' },
    /* 仓储与任务:储物箱 + 任务板。 */
    { x: DESIGN_CENTER - 9, y: DESIGN_CENTER + 10, obj: 513, why: '储物箱' },
    { x: DESIGN_CENTER + 9, y: DESIGN_CENTER + 10, obj: 516, why: '任务板' },
    /* 广场四角的承重墙:广场边界是**能撞到的**,不是画上去的红线。 */
    { x: DESIGN_CENTER - campHalf, y: DESIGN_CENTER - campHalf, obj: 352, why: '角柱' },
    { x: DESIGN_CENTER + campHalf - 1, y: DESIGN_CENTER - campHalf, obj: 352, why: '角柱' },
    { x: DESIGN_CENTER - campHalf, y: DESIGN_CENTER + campHalf - 1, obj: 352, why: '角柱' },
    { x: DESIGN_CENTER + campHalf - 1, y: DESIGN_CENTER + campHalf - 1, obj: 352, why: '角柱' },
  ];
  for (const l of LANDMARKS) landmark(l.x, l.y, l.obj);
  /* 路灯(522):沿环路与主路每 12 格一盏 —— 灯本身也「驱怪」(items.ts note),
     于是主干道从「一条路」变成「一条有灯的路」。 */
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      if (((x + y) % 12) !== 0) continue;
      const { r } = radiusOf(x, y);
      const onRing = r >= RING_INNER && r <= RING_OUTER;
      const onSpoke = Math.abs(x + 0.5 - c) <= 1.5 || Math.abs(y + 0.5 - c) <= 1.5;
      /* 营地内部不铺路(广场是终点,不是通过点)。 */
      if (inCamp(x, y)) continue;
      if (!onRing && !onSpoke) continue;
      if (!isLand(x, y)) continue;
      /* 别盖掉地标格。 */
      const nearLandmark = LANDMARKS.some((l) => l.x === x && l.y === y);
      if (nearLandmark) continue;
      landmark(x, y, 522);
    }
  }

  /* ── 4.7 全集:所有地砖 slot 都经 `floorSlotOfId` 换算,这里只做去重统计 ── */
  const regionOrder: RegionCount[] = REGIONS.map((r) => ({
    id: r.id,
    name: r.name,
    cells: perRegion.get(r.id) ?? 0,
  }));

  return {
    size,
    cells,
    landCells,
    seaCells,
    beachCells,
    roadCells,
    pierCells,
    landmarkCells,
    spawn: { x: DESIGN_CENTER, y: DESIGN_CENTER },
    regions: regionOrder,
    floorItemIds: sortedUnique([...floorIds]),
  };
}

/**
 * 世界格坐标 → 该格**设计上**属于哪个区(未落在任何区 ⇒ `null`)。
 *
 * ⚠️ 这是**设计意图**查询,不是「这一格现在是什么」的查询:主路会从区域上穿过
 * (后画的优先),所以 `regionAt(68,68)` 返回 `'meadow'`,而那一格实际铺的是
 * 星光夜路砖。要「现在是什么」就去读世界本身。
 */
/**
 * 世界格坐标 → **群系键**(`BIOME_SPAWN` 的键)。未落在任何区 ⇒ `null`。
 *
 * 调用方(刷怪)对 `null` 的处置应当是 `?? 'MEADOW'` —— 与 `spawner.ts` 既有的兜底同源。
 * 本函数**只读设计意图**(`regionAt` + `REGION_BIOME`),不读世界:想知道"这一格现在
 * 到底铺了什么",去读世界本身。
 */
export function biomeAt(x: number, y: number): string | null {
  const id = regionAt(x, y);
  if (id === null) return null;
  return REGION_BIOME[id] ?? null;
}

export function regionAt(x: number, y: number): string | null {
  const r = (cx: number, cy: number, rad: number): boolean => Math.hypot(x - cx, y - cy) <= rad;
  const inRect = (x0: number, y0: number, x1: number, y1: number): boolean =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;
  /* ⚠️ **顺序 = 绘制顺序的倒序**(后画的盖先画的)。
     早先这里是「声明顺序」(camp/meadow/grove/…),于是 `grove` 的圆
     (128,64,r14)先把 (138,66) 抢走 ⇒ `regionAt` 永远返回 'grove',
     温泉眼/湖心查不到自己的区(实测 FND181-7 红)。 */
  if (inRect(DESIGN_CENTER - 12, DESIGN_CENTER - 12, DESIGN_CENTER + 11, DESIGN_CENTER + 11)) return 'camp';
  if (r(138, 66, 4)) return 'spring';
  if (r(138, 74, 12)) return 'lake';
  if (inRect(86, 146, 108, 158)) return 'dunes';
  if (inRect(118, 118, 138, 138)) return 'ruins';
  if (inRect(80, 128, 106, 140)) return 'farm';
  if (r(64, 128, 14)) return 'mine';
  if (r(80, 48, 10)) return 'highland';
  if (r(52, 72, 11)) return 'track';
  if (r(128, 64, 14)) return 'grove';
  if (r(64, 64, 16)) return 'meadow';
  if (inRect(30, 84, 46, 102)) return 'marsh';
  return null;
}
