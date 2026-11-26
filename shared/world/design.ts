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
/* ★ w98:城镇平面图(纯函数,只产出 obj 层)。判定在 `town.ts` + `WS-FND-191`(16 条),
   这里只把它的结果**盖进世界** —— 改前这条数据没有生产调用点,世界上没有任何房子。 */
import { planTown } from './town.ts';

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

/**
 * 城镇主街的**纵轴 x**(格)。与 `shared/world/town.ts#planTown` 里那条街同一条
 * (它按 `dx = −8` 相对中心排房屋)⇒ 这里也写成相对量,别写死 88。
 * 判据 `WS-FND-191` 会断言街轴那一列**没有立牌**(否则街心被房子堵住)。
 */
export const TOWN_STREET_X = DESIGN_CENTER - 8;

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

/* ═══════ 2b. 起伏:台地 / 丘陵 / 崖壁 / 河谷(手放,不是噪声)═══════
 *
 * ## 为什么必须有这一节(改前 = 一片平板)
 *
 * 改前逐格实测(192×192,盖完图之后数格):
 *
 * ```text
 * DEEP 18104 / GROUND 18384 / PLATFORM 298 / CLIFF 78
 * ⇒ 陆地 18760 格里只有 376 格(2.0%)不是平地 —— 起伏只集中在高地与矿丘两处。
 * ```
 *
 * 也就是说「地面」98% 是同一层 z = 0 的平板。owner 说的「看起来依旧不是一个
 * 世界」有一半是**这个**(另一半是顶面贴图)。
 *
 * ## 口径(与判据 `WS-FND-194` 同源,写在这里因为口径就是规格)
 *
 *   - 台地/丘陵 = `PLATFORM`(z = +1);
 *   - 崖壁      = `CLIFF`(z = +2);
 *   - 河谷/河床 = `DEEP`(z = −1),两侧各一格沙洲(可走的缓坡,不是墙)。
 *
 * ⚠️ **崖壁只做扇形/单面,从不围满一圈**:`CLIFF` 在连通性判据里是**墙**
 * (`WS-FND-181` FND181-6 与 `WS-FND-194` 第 3 条都把它当墙)⇒ 围满一圈等于把那
 * 块地封死:玩家走不上去、判据当场变红。这不是"顺手",是**必须留的通行口**。
 *
 * 角度约定:**0 = +x(东),π/2 = +y(本仓 y 轴朝下 ⇒ 南)**,`from..to` 逆时针。
 */

/** 台地/丘陵:一个圆台面 + 可选的**扇形崖壁**。 */
export interface MoundSpec {
  id: string;
  name: string;
  /** 台面圆心(格)。 */
  cx: number;
  cy: number;
  /** 台面半径(格)。 */
  r: number;
  /** 台面地表材质(`BaseFluid`)。 */
  base: number;
  /** 台面地砖物品 id(0 = 裸地)。 */
  floorItemId: number;
  /** 崖壁扇区:`from`..`to`(弧度)+ `inner`(崖壁内半径,一般 r−2..r−3)。 */
  cliff?: { from: number; to: number; inner: number };
  /** 设计意图(一句话)。 */
  intent: string;
}

/**
 * 8 处台地/丘陵。位置全部**手放**,并且逐条避开三样东西:
 *
 *   1. 营地 84..108(出生点必须与地面同高 —— 见文件头);
 *   2. `WS-FND-181` FND181-3 / FND181-6 的**探针格**(代表格语义不许被抬高改掉);
 *   3. 主路的十字带(全场 x∈[94,97] 与 y∈[94,97]:主路会把它压回 GROUND)。
 *
 * 高地(80,48)与矿丘(64,128)改前就有台地;这里给草原/竹林/沼泽/沙丘各加抬升,
 * 农田与遗迹是矩形台地(见 `TERRACES`)。
 */
export const MOUNDS: readonly MoundSpec[] = [
  {
    id: 'meadow-mesa', name: '草原台地', cx: 74, cy: 74, r: 13,
    base: BaseFluid.GRASS, floorItemId: 0,
    cliff: { from: -2.50, to: -1.40, inner: 10 },
    intent: '草原里的一台:出营地北墙就能爬上去,台上能一眼看回广场。崖壁在北面(远处),上坡口朝营地。',
  },
  {
    id: 'meadow-knoll', name: '草原矮丘', cx: 46, cy: 54, r: 7,
    base: BaseFluid.GRASS, floorItemId: 0,
    intent: '西北开阔草地上的矮丘:给「往西北走半天都是平的」那段路一个起伏。',
  },
  {
    id: 'grove-mesa', name: '竹丘', cx: 120, cy: 54, r: 10,
    base: BaseFluid.GRASS, floorItemId: 312,
    cliff: { from: 0.45, to: 1.55, inner: 7 },
    intent: '竹林(深绿草皮 312)抬起的一台:西北是缓坡,东南面是竹崖 —— 竹林不再是一块平色块。',
  },
  {
    id: 'marsh-mesa', name: '泥沼台地', cx: 34, cy: 99, r: 6,
    base: BaseFluid.DIRT, floorItemId: 316,
    cliff: { from: 2.40, to: 3.40, inner: 4 },
    intent: '沼泽里的一块干台(紫泥 316):西面朝海是泥崖,东面坡道走得上去 —— 沼泽里的一处落脚点。',
  },
  {
    id: 'dunes-crest', name: '沙丘主峰', cx: 89, cy: 151, r: 7,
    base: BaseFluid.GOLD_SAND, floorItemId: 0,
    cliff: { from: 1.20, to: 2.20, inner: 5 },
    intent: '沙漠的沙丘主峰:南面被风削成沙崖,北面是缓坡 ⇒ 沙丘有正面也有背面。',
  },
  {
    id: 'dunes-crest-2', name: '沙丘副峰', cx: 105, cy: 154, r: 6,
    base: BaseFluid.GOLD_SAND, floorItemId: 0,
    intent: '主峰东侧的小沙丘:两峰之间留一道可走的风口,不是一堵沙墙。',
  },
  {
    id: 'east-ridge', name: '东岭', cx: 117, cy: 80, r: 8,
    base: BaseFluid.ROCK, floorItemId: 0,
    cliff: { from: -0.40, to: 0.95, inner: 6 },
    intent: '营地与湖之间的岩岭:登上去能同时看到广场与湖面,东面是岩壁挡住直接下山。',
  },
  {
    id: 'south-ridge', name: '矿丘北岭', cx: 85, cy: 120, r: 8,
    base: BaseFluid.ROCK, floorItemId: 0,
    cliff: { from: -2.00, to: -0.85, inner: 5 },
    intent: '矿丘与农田之间的岩岭:把西南角从「两块孤岛」连成一片台地;北面岩壁,南面接农田。',
  },
];

/** 梯田/台基:矩形抬升。`bands` = 行带,**带与带之间留沟**(农田的灌溉渠就是这么留下的)。 */
export interface TerraceSpec {
  id: string;
  name: string;
  /** 列范围(含)。 */
  x0: number;
  x1: number;
  /** 行带 `[y0, y1][]`(含);带与带之间的行**不动**(⇒ 沟渠还在原位)。 */
  bands: readonly (readonly [number, number])[];
  base: number;
  floorItemId: number;
  /** 把**第一行 / 最后一行**做成崖壁(挡土墙);缺省 = 整块都是台面。 */
  cliffRow?: 'first' | 'last';
  intent: string;
}

export const TERRACES: readonly TerraceSpec[] = [
  {
    id: 'farm-terrace', name: '农田梯田',
    x0: 80, x1: 106,
    /* 三条畦面:132..134 / 136..138 / 140;131、135、139 是**留出来**的灌溉渠(浅水)。 */
    bands: [[132, 134], [136, 138], [140, 140]],
    base: BaseFluid.DIRT, floorItemId: 301,
    intent: '农田抬成三级畦面,灌溉渠留在低处 ⇒ 从田埂上看得出一层一层,而不是一块土色。',
  },
  {
    id: 'ruins-terrace', name: '遗迹台基',
    x0: 119, x1: 137,
    bands: [[131, 138]],
    base: BaseFluid.ROCK, floorItemId: 306,
    cliffRow: 'last',
    intent: '遗迹广场的南半抬成一层台基(大理石 306),最南一行是挡土崖 —— 祭坛与传送砖留在台下,台基不压它们。',
  },
];

/** 海岸崖壁:沿一段极角把沙滩整条抬成 `CLIFF`(临海崖)。段与段之间**留通行口**。 */
export interface SeaCliffSpec {
  id: string;
  name: string;
  /** 极角区间(弧度,世界中心为原点;0 = 东,π/2 = 南)。 */
  from: number;
  to: number;
  base: number;
  /** 自海岸线向内的宽度(格,≤ `BEACH_BAND`)。 */
  width: number;
  intent: string;
}

/**
 * 三段海岸崖壁。**故意避开四个主路方向**(0 / ±π/2 / π)⇒ 每一段沙滩都还留着
 * 一条从主路下来的通行口,海岸仍然是可以下去的地方(栈桥的陆地侧不会被堵)。
 */
export const SEA_CLIFFS: readonly SeaCliffSpec[] = [
  {
    id: 'ne-sea-cliff', name: '东北海岸崖', from: -1.15, to: -0.35,
    base: BaseFluid.ROCK, width: 5,
    intent: '东北岸:崖顶能俯瞰海面,沙滩在这里变成岩岸 —— 海岸线本身有高低了。',
  },
  {
    id: 'se-sea-cliff', name: '东南海岸崖', from: 0.35, to: 1.15,
    base: BaseFluid.ROCK, width: 5,
    intent: '东南岸:遗迹与沙丘之间的岩岸,把「去东南角」变成一段有落差的路。',
  },
  {
    id: 'sw-sea-cliff', name: '西南海岸崖', from: 2.05, to: 2.80,
    base: BaseFluid.ROCK, width: 5,
    intent: '西南岸:矿丘背后的岩岸 —— 从丘顶看下去,海是掉下去的而不是平平铺开的。',
  },
];

/* ── 河谷:手放的轴对齐折线(便于判据逐格断言「连续」)── */

/**
 * 河谷中心线的折线顶点(格)。**每段只沿一个轴走** —— 这样「河道连续」可以逐格断言:
 * 沿折线每次前进 1 格,那一格必须仍是河床(`WS-FND-194` 第 4 条)。
 *
 * 走向(手放,不是随机):自西岸海面 (20,112) 上陆 → 沿 y = 112 东流(营地南墙以南 4 格)
 * → 在 x = 110 北折(营地东墙以东 2 格)→ 东折到 x = 118 → 沿 x = 118 北上到 y = 84
 * → 东折进湖 (136,84):**河口**。
 *
 * ⚠️ 河道宽 3 格(±1)、沙洲再各 1 格(±2)⇒ **每一格河床都必须满足 x ≥ 109 或 y ≥ 109**
 * (营地是 84..107 的方块,`inCamp` 会把切进去的河格挡掉)。实测:早先把纵向段放在
 * x = 100,河道从营地东南角穿过去,被挡掉 4 格 ⇒ 河道断点,`WS-FND-194` 第 4 条当场变红。
 * 这也是为什么 `riverCenterline()` 必须**逐格**断言 —— 靠肉眼看折线看不出这 4 格。
 */
export const RIVER_PATH: readonly { x: number; y: number }[] = [
  { x: 20, y: 112 },
  { x: 110, y: 112 },
  { x: 110, y: 106 },
  { x: 118, y: 106 },
  { x: 118, y: 84 },
  { x: 136, y: 84 },
];

/** 河床半宽(格)⇒ 河道宽 2×1+1 = 3 格。 */
export const RIVER_HALF_WIDTH = 1;
/** 河岸沙洲半宽(格):2 格以内减掉河床 = 沙洲带。 */
export const RIVER_BANK_WIDTH = 2;
/** 桥面地砖(= 跨海栈桥同一种水上浮木 310;`walkable` 口径里「水面 + 有铺装」可走)。 */
export const RIVER_BRIDGE_FLOOR_ID = 310;

/**
 * 河谷中心线上的**每一格**(1 格宽)。轴对齐 ⇒ 逐格步进不会跳格。
 * 这就是「河道连续」的机检口径:沿它走一遍,每一格都必须是河床。
 */
export function riverCenterline(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [{ ...RIVER_PATH[0]! }];
  for (let i = 1; i < RIVER_PATH.length; i += 1) {
    const a = RIVER_PATH[i - 1]!;
    const b = RIVER_PATH[i]!;
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    if (dx !== 0 && dy !== 0) throw new Error('RIVER_PATH 每段必须轴对齐(只沿一个轴走)');
    if (dx === 0 && dy === 0) continue;
    let x = a.x;
    let y = a.y;
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      out.push({ x, y });
    }
  }
  return out;
}

/** 河床(宽 `2*RIVER_HALF_WIDTH+1` 格,含折角处补齐的格)。 */
export function riverChannelCells(): { x: number; y: number }[] {
  return bandAroundCenterline(RIVER_HALF_WIDTH);
}

/** 河岸沙洲(宽 `2*RIVER_BANK_WIDTH+1` 格**减掉**河床)。 */
export function riverBankCells(): { x: number; y: number }[] {
  const bed = new Set(bandAroundCenterline(RIVER_HALF_WIDTH).map((p) => p.y * 4096 + p.x));
  return bandAroundCenterline(RIVER_BANK_WIDTH).filter((p) => !bed.has(p.y * 4096 + p.x));
}

/**
 * 中心线两侧 `half` 格的地带。
 *
 * ⚠️ 折角格要**两个轴的偏移都发一遍**(只发一个轴会在拐角漏掉斜角格 ——
 * 那种漏格在截图上是「河中间一小块岸」,在判据上就是河道断点)。
 */
function bandAroundCenterline(half: number): { x: number; y: number }[] {
  const line = riverCenterline();
  const seen = new Set<number>();
  const out: { x: number; y: number }[] = [];
  const push = (x: number, y: number): void => {
    const key = y * 4096 + x;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };
  for (let i = 0; i < line.length; i += 1) {
    const p = line[i]!;
    const next = line[Math.min(i + 1, line.length - 1)]!;
    const prev = line[Math.max(i - 1, 0)]!;
    const dx = next.x - p.x + (p.x - prev.x);
    const dy = next.y - p.y + (p.y - prev.y);
    if (dx !== 0) for (let k = -half; k <= half; k += 1) push(p.x, p.y + k);
    if (dy !== 0) for (let k = -half; k <= half; k += 1) push(p.x + k, p.y);
  }
  return out;
}
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
  /**
   * ★ w99(起伏):台地格数 / 崖壁格数 / 河床格数 / 桥上格数。
   *
   * ⚠️ 与 `landCells` 等既有字段同一口径 —— 它们是**盖章时写入的格数**
   * (短时间内可以被后一遍覆盖,例如主路会把台地压回 GROUND)。
   * 判据要「最终落到世界上的格数」时,从 writer 读回来数(WORKBOOK `WS-FND-194`)。
   */
  platformCells: number;
  cliffCells: number;
  riverCells: number;
  bridgeCells: number;
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
  /* ★ w99:起伏/河谷的记账(与既有字段同一口径:盖章时写入的格数)。 */
  let platformCells = 0;
  let cliffCells = 0;
  let riverCells = 0;
  let bridgeCells = 0;
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
        /* ★ w99:区自带的抬升层(高地/矿丘的中环与丘心)也要记账 —— 否则
           `platformCells` 只算新加的台地,与逐格读回的量级对不上。 */
        if (spec.elev === Elevation.PLATFORM) platformCells += 1;
        else if (spec.elev === Elevation.CLIFF) cliffCells += 1;
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
        if (spec.elev === Elevation.PLATFORM) platformCells += 1;
        else if (spec.elev === Elevation.CLIFF) cliffCells += 1;
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

  /* ── 4.4b 台地与丘陵(PLATFORM)+ 扇形崖壁(CLIFF)──
     顺序理由:在 11 个区**之后** ⇒ 台地盖过区表面(与高地/矿丘同一做法);
     在道路与河谷**之前** ⇒ 主路会从台上切出一条可走的通道,河谷会从台上切出河谷。 */
  /**
   * 角度是否落在 `[from, to]`(逆时针,跨度必须 < 2π)。折到 [0, 2π) 再比 ⇒ 负角也认。
   */
  const inArc = (a: number, from: number, to: number): boolean => {
    const span = to - from;
    const rel = (((a - from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return rel <= span;
  };
  const mound = (m: MoundSpec): void => {
    const slot = m.floorItemId === 0 ? 0 : floorSlotOfId(m.floorItemId);
    for (let y = m.cy - m.r; y <= m.cy + m.r; y += 1) {
      for (let x = m.cx - m.r; x <= m.cx + m.r; x += 1) {
        if (!inRange(x, y) || !isLand(x, y)) continue;
        const d = Math.hypot(x - m.cx, y - m.cy);
        if (d > m.r) continue;
        const c = m.cliff;
        const walled = c !== undefined && d >= c.inner
          && inArc(Math.atan2(y - m.cy, x - m.cx), c.from, c.to);
        put(x, y, {
          elev: walled ? Elevation.CLIFF : Elevation.PLATFORM,
          base: m.base,
          floor: slot,
        });
        if (walled) cliffCells += 1;
        else platformCells += 1;
      }
    }
  };
  for (const m of MOUNDS) mound(m);

  /* ── 4.4c 梯田 / 台基(矩形抬升)──
     `bands` 的行带之间**不动** ⇒ 农田那三条灌溉渠(131/135/139)留在低处。 */
  const terrace = (t: TerraceSpec): void => {
    const slot = t.floorItemId === 0 ? 0 : floorSlotOfId(t.floorItemId);
    for (let bi = 0; bi < t.bands.length; bi += 1) {
      const band = t.bands[bi]!;
      for (let y = band[0]; y <= band[1]; y += 1) {
        for (let x = t.x0; x <= t.x1; x += 1) {
          if (!inRange(x, y) || !isLand(x, y)) continue;
          const wall = (t.cliffRow === 'last' && bi === t.bands.length - 1 && y === band[1])
            || (t.cliffRow === 'first' && bi === 0 && y === band[0]);
          put(x, y, {
            elev: wall ? Elevation.CLIFF : Elevation.PLATFORM,
            base: t.base,
            floor: slot,
          });
          if (wall) cliffCells += 1;
          else platformCells += 1;
        }
      }
    }
  };
  for (const t of TERRACES) terrace(t);

  /* ── 4.4d 海岸崖壁:沿几段极角把沙滩整条抬成 CLIFF(临海崖)──
     段与段之间**留通行口**(角度刻意避开 0/±π/2/π 四个主路方向)⇒ 海岸仍然
     下得去,栈桥的陆地侧也不会被崖壁堵住。 */
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isLand(x, y)) continue;
      const { r, th } = radiusOf(x, y);
      const coast = coastRadius(th);
      if (r <= coast - BEACH_BAND) continue;
      for (const sc of SEA_CLIFFS) {
        if (r < coast - sc.width) continue;
        if (!inArc(th, sc.from, sc.to)) continue;
        put(x, y, { elev: Elevation.CLIFF, base: sc.base, floor: 0 });
        cliffCells += 1;
        break;
      }
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

  /* ── 4.5b 河谷:沿手放折线挖一条**连续**低洼带 ──
     为什么放在道路**之后**:道路(4.5)会把河道上的路面压回 GROUND ⇒ 河道出现断点
     (`WS-FND-194` 第 4 条要的就是这种断点)。所以这里在道路之后再挖一遍,
     并把「被道路压过的河格」补成**木桥**(310)—— 桥面 `elev = DEEP` 且 `floor != 0`,
     在连通性口径里**可走**(与跨海栈桥同一条规则)⇒ 环路与四条主路不会断。
     河岸(2 格内的沙洲)是 `GROUND` 缓坡:它**不是墙**,只是把河谷的界线画出来。 */
  /** 是不是主路格(环路带 / 十字带,营地除外)。桥与河岸都按它让路。 */
  const isRoadCell = (x: number, y: number): boolean => {
    if (inCamp(x, y)) return false;
    const { r } = radiusOf(x, y);
    if (r >= RING_INNER && r <= RING_OUTER) return true;
    return Math.abs(x + 0.5 - c) <= 1.5 || Math.abs(y + 0.5 - c) <= 1.5;
  };
  /* 营地 + 1 格外扩:河岸沙洲**不许**盖到广场那圈石径(它落在 83/84/107/108 上)。
     河道本身不走这里(见 `RIVER_PATH` 的 ⚠️),所以这不是「挡河道」而是「挡沙洲」。 */
  const nearCamp = (x: number, y: number): boolean =>
    x >= DESIGN_CENTER - campHalf - 1 && x <= DESIGN_CENTER + campHalf
    && y >= DESIGN_CENTER - campHalf - 1 && y <= DESIGN_CENTER + campHalf;
  const riverChannel = riverChannelCells();
  for (const p of riverChannel) {
    if (!inRange(p.x, p.y) || inCamp(p.x, p.y)) continue;
    put(p.x, p.y, { elev: Elevation.DEEP, base: BaseFluid.SHALLOW_WATER, floor: 0 });
    riverCells += 1;
  }
  /* 桥:河道上凡是主路经过的格 ⇒ 木桥(可走)。主路因此从桥上过河,不是被河切断。 */
  for (const p of riverChannel) {
    if (!inRange(p.x, p.y) || inCamp(p.x, p.y)) continue;
    if (!isLand(p.x, p.y) || !isRoadCell(p.x, p.y)) continue;
    put(p.x, p.y, {
      elev: Elevation.DEEP,
      base: BaseFluid.SHALLOW_WATER,
      floor: floorSlotOfId(RIVER_BRIDGE_FLOOR_ID),
    });
    bridgeCells += 1;
  }
  /* 河岸沙洲:只在陆地上,且**不压任何主路格**(压了会在地面上留一段断头的路面)。 */
  for (const p of riverBankCells()) {
    if (!inRange(p.x, p.y) || nearCamp(p.x, p.y)) continue;
    if (!isLand(p.x, p.y) || isRoadCell(p.x, p.y)) continue;
    put(p.x, p.y, { elev: Elevation.GROUND, base: BaseFluid.GOLD_SAND, floor: 0 });
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

  /* ── 4.6b ★ w98:**城镇**(6 座房子 + 一条街 + 市场角)──
     数据在 `shared/world/town.ts#planTown()`(16 条判据守结构:墙圈 3×4 / 圈上恰一门 /
     窗在门对面 / 内圈屋顶 / 与上面那 13 个地标**零交集**)。这里只做两件事:铺街、立牌。
     ⚠️ 城镇必须盖在 `LANDMARKS` **之后** —— 反过来房子会把纪念碑/篝火压掉。 */
  for (let y = DESIGN_CENTER - campHalf; y <= DESIGN_CENTER + campHalf - 1; y += 1) {
    /* 街轴 x = 88(`planTown` 的 dx = −8 就是这条街);铺鹅卵石径,让它在地面上读得出是"街"。 */
    put(TOWN_STREET_X, y, { floor: floorSlotOfId(302) });
  }
  for (const p of planTown({ center: { x: DESIGN_CENTER, y: DESIGN_CENTER }, half: campHalf })) {
    landmark(p.x, p.y, p.obj);
  }
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
    platformCells,
    cliffCells,
    riverCells,
    bridgeCells,
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
