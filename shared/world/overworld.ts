/**
 * 主世界生成器:512×512 的「晨曦群岛」。
 *
 * 一张确定性的大陆:中央是晨曦镇,八个群系围着它铺开,河从高地流向海,
 * 一圈环路加八条放射路把镇子、各群系的营地和深处的 Boss 祭坛连起来。
 * 生成只依赖坐标与固定种子 ⇒ 服务端与每个客户端各算一遍,得到同一张图。
 *
 * 生成顺序(后一步建立在前一步之上,顺序不能换):
 * ```text
 * 1 海岸与群系    极角谐波 + 噪声定陆地;带噪声扭曲的加权 Voronoi 定群系
 * 2 地势          各群系按自己的规则抬台地 / 围山 / 起丘,再做一次中值滤波去毛刺
 * 3 水            河沿折线下切并留出河岸;湖、熔岩池、巧克力池
 * 4 场地          镇子、八个营地、八座祭坛:先整平,再盖东西,盖过的格子上锁
 * 5 路            沿折线铺路;遇水架栈桥;沿路把高差整理成「一次一层」,落差处放台阶
 * 6 资源与点缀    按群系撒树 / 矿 / 作物;挡路的物件互不相邻,林子里永远有路可走
 * ```
 * 结果缓存在模块里(`overworld()`),重复调用不重算。
 */

import { BaseFluid, Elevation, packTile } from '../types/tile.ts';
import { fbm, hash2 } from './noise.ts';
import { Landmark } from './landmarks.ts';
import { canEnter, isDeepWater, isSolidObj, type CellView } from './passable.ts';

/** 世界边长(格)。 */
export const WORLD_SIZE = 512;
/** 世界中心(镇广场喷泉所在格)。 */
export const WORLD_CENTER = WORLD_SIZE / 2;

const N = WORLD_SIZE;
const C = WORLD_CENTER;

/* ───────────────────────── 区域与群系 ───────────────────────── */

/** 一个区域的静态说明。 */
export interface RegionDef {
  id: string;
  name: string;
  /** 群系键,与 `server/src/mobs/spawner.ts#BIOME_SPAWN` 逐字对齐 */
  biome: string;
  /** 一句话设计意图 */
  intent: string;
}

/** 区域表;下标就是 `Overworld.region` 里存的值。 */
export const REGION_DEFS: readonly RegionDef[] = [
  { id: 'town', name: '晨曦镇', biome: 'MEADOW', intent: '家:红砖广场、喷泉、工坊街与集市,所有路从这里出发。' },
  { id: 'meadow', name: '晨曦草甸', biome: 'MEADOW', intent: '新手区:松林、浆果丛与缓丘,第一把斧子和第一只野猪都在这里。' },
  { id: 'valley', name: '金秋河谷', biome: 'VALLEY', intent: '田园:沿河的麦田与桃林,黏土在河岸,河狸在水边。' },
  { id: 'sakura', name: '绯樱高地', biome: 'SAKURA', intent: '台地:樱花林与温泉,石阶上去,神社在最高处。' },
  { id: 'bamboo', name: '翠竹林', biome: 'SAKURA', intent: '密林:成片青竹与隐士小筑,狸猫藏在里面。' },
  { id: 'cavern', name: '萤光溶洞', biome: 'CAVERN', intent: '环山围出的洞谷:菌树发光,矿脉由浅入深,熔岩在最里面。' },
  { id: 'oasis', name: '星沙绿洲', biome: 'OASIS', intent: '沙海:沙丘、仙人掌与一片湖,金字塔立在东边。' },
  { id: 'dessert', name: '甜点奇境', biome: 'DESSERT', intent: '糖果地:威化树、巧克力池与三层蛋糕山。' },
  { id: 'skysea', name: '浮空云海', biome: 'SKYSEA', intent: '最高的台地:云团铺地,棉花与星辰碎片,飞艇停在码头。' },
  { id: 'ruins', name: '发条遗迹', biome: 'RUINS', intent: '终点:石柱、齿轮残骸与阶梯神殿,时间巨像睡在上面。' },
  { id: 'islet', name: '灯塔岛', biome: 'OASIS', intent: '东海上的小岛:一座灯塔,一条长栈桥。' },
];

/** `Overworld.region` 里表示「海」的值。 */
export const REGION_SEA = 255;

const REGION_INDEX: Readonly<Record<string, number>> = Object.fromEntries(REGION_DEFS.map((r, i) => [r.id, i]));
const RG = {
  town: REGION_INDEX['town']!, meadow: REGION_INDEX['meadow']!, valley: REGION_INDEX['valley']!,
  sakura: REGION_INDEX['sakura']!, bamboo: REGION_INDEX['bamboo']!, cavern: REGION_INDEX['cavern']!,
  oasis: REGION_INDEX['oasis']!, dessert: REGION_INDEX['dessert']!, skysea: REGION_INDEX['skysea']!,
  ruins: REGION_INDEX['ruins']!, islet: REGION_INDEX['islet']!,
};

/** 群系种子点:陆地上每格归最近的那个(距离乘 `w`,`w` 越小地盘越大)。 */
const BIOME_SEEDS: readonly { region: number; x: number; y: number; w: number }[] = [
  { region: RG.meadow, x: 256, y: 262, w: 0.78 },
  { region: RG.valley, x: 112, y: 264, w: 1 },
  { region: RG.bamboo, x: 120, y: 118, w: 1 },
  { region: RG.sakura, x: 264, y: 98, w: 1 },
  { region: RG.skysea, x: 402, y: 112, w: 1 },
  { region: RG.oasis, x: 418, y: 258, w: 1 },
  { region: RG.ruins, x: 392, y: 392, w: 0.92 },
  { region: RG.dessert, x: 268, y: 426, w: 1 },
  { region: RG.cavern, x: 120, y: 400, w: 1 },
];

/** 镇区半径(格):这一圈内归 `town`,不刷野怪也不撒野生资源。 */
export const TOWN_RADIUS = 40;

/** 出生点(镇广场,喷泉南侧)。 */
export const SPAWN_POINT: Readonly<{ x: number; y: number }> = { x: C, y: C + 4 };

/* ───────────────────────── 场地 ───────────────────────── */

export type SiteKind = 'town' | 'outpost' | 'altar' | 'landmark';

/** 世界上一处有名字的地方。 */
export interface OverworldSite {
  id: string;
  name: string;
  kind: SiteKind;
  /** 所在区域 id */
  region: string;
  x: number;
  y: number;
}

/** 营地:每个群系一处,有篝火、箱子、任务板和一两位常住的人。 */
const OUTPOSTS: readonly { id: string; name: string; region: number; x: number; y: number }[] = [
  { id: 'valley_farm', name: '金穗农庄', region: RG.valley, x: 150, y: 266 },
  { id: 'bamboo_hut', name: '听竹小筑', region: RG.bamboo, x: 146, y: 150 },
  { id: 'sakura_inn', name: '绯樱汤屋', region: RG.sakura, x: 262, y: 138 },
  { id: 'skysea_dock', name: '云海码头', region: RG.skysea, x: 380, y: 142 },
  { id: 'oasis_bazaar', name: '星沙集市', region: RG.oasis, x: 388, y: 262 },
  { id: 'ruins_camp', name: '发条考古营', region: RG.ruins, x: 370, y: 364 },
  { id: 'dessert_house', name: '姜饼糖屋', region: RG.dessert, x: 276, y: 394 },
  { id: 'cavern_camp', name: '矿工营地', region: RG.cavern, x: 166, y: 368 },
];

/** 祭坛:每个群系深处一座。`mound` 是祭坛脚下那座台子的两层半径(0 = 不另起台)。 */
const ALTARS: readonly {
  id: string; name: string; region: number; x: number; y: number;
  mound: readonly [number, number]; floor: number; from: string;
}[] = [
  { id: 'altar_meadow', name: '草甸祭坛', region: RG.meadow, x: 212, y: 312, mound: [12, 0], floor: 302, from: 'town' },
  { id: 'altar_valley', name: '河谷祭坛', region: RG.valley, x: 84, y: 270, mound: [0, 0], floor: 303, from: 'valley_farm' },
  { id: 'altar_sakura', name: '绯樱神社', region: RG.sakura, x: 282, y: 72, mound: [0, 9], floor: 306, from: 'sakura_inn' },
  { id: 'altar_cavern', name: '溶洞核心', region: RG.cavern, x: 104, y: 416, mound: [0, 0], floor: 309, from: 'cavern_camp' },
  { id: 'altar_oasis', name: '金字塔顶', region: RG.oasis, x: 440, y: 276, mound: [14, 9], floor: 305, from: 'oasis_bazaar' },
  { id: 'altar_dessert', name: '蛋糕山顶', region: RG.dessert, x: 306, y: 440, mound: [15, 9], floor: 311, from: 'dessert_house' },
  { id: 'altar_skysea', name: '云顶祭台', region: RG.skysea, x: 412, y: 100, mound: [0, 0], floor: 306, from: 'skysea_dock' },
  { id: 'altar_ruins', name: '时间神殿', region: RG.ruins, x: 402, y: 396, mound: [12, 8], floor: 307, from: 'ruins_camp' },
];

/** 灯塔岛(东海)。 */
const ISLET = { x: 492, y: 250, r: 8 };

/** NPC 站位(格)。键是 `server/src/npc/defs.ts` 的 NPC id;生成器保证这些格子空着、且在陆地上。 */
export const NPC_SPOTS: Readonly<Record<string, { x: number; y: number }>> = (() => {
  const at = (id: string, dx: number, dy: number): { x: number; y: number } => {
    const o = OUTPOSTS.find((s) => s.id === id)!;
    return { x: o.x + dx, y: o.y + dy };
  };
  return {
    npc_mayor: { x: C + 2, y: C + 5 },
    npc_carpenter: { x: C - 13, y: C - 4 },
    npc_smith: { x: C - 15, y: C + 4 },
    npc_cook: { x: C + 15, y: C - 4 },
    npc_merchant: { x: C + 16, y: C + 7 },
    npc_alchemist: { x: C + 14, y: C + 19 },
    npc_farmer: at('valley_farm', -2, 2),
    npc_fisher: at('valley_farm', 3, 2),
    npc_hermit: at('bamboo_hut', -2, 2),
    npc_innkeeper: at('sakura_inn', -2, 2),
    npc_miko: at('sakura_inn', 3, 2),
    npc_captain: at('skysea_dock', -2, 2),
    npc_caravan: at('oasis_bazaar', -2, 2),
    npc_tamer: at('oasis_bazaar', 3, 2),
    npc_ruins_guard: at('ruins_camp', -2, 2),
    npc_scholar: at('ruins_camp', 3, 2),
    npc_baker: at('dessert_house', -2, 2),
    npc_miner: at('cavern_camp', -2, 2),
    npc_geologist: at('cavern_camp', 3, 2),
  };
})();

/* ───────────────────────── 生成结果 ───────────────────────── */

export interface OverworldStats {
  landCells: number;
  seaCells: number;
  roadCells: number;
  bridgeCells: number;
  stairCells: number;
  objCells: number;
  /** 每个区域的格数(下标 = 区域下标) */
  regionCells: number[];
}

export interface Overworld {
  size: number;
  /** 每格一个 `packTile` 值,行主序 */
  tiles: Uint32Array;
  /** 每格的区域下标(`REGION_SEA` = 海) */
  region: Uint8Array;
  /** 路面格(含栈桥)= 1 */
  road: Uint8Array;
  sites: readonly OverworldSite[];
  stats: OverworldStats;
}

/* ───────────────────────── 生成器 ───────────────────────── */

const DEEP = Elevation.DEEP;
const GROUND = Elevation.GROUND;
const PLATFORM = Elevation.PLATFORM;
const CLIFF = Elevation.CLIFF;
const { GRASS, DIRT, GOLD_SAND, ROCK, SHALLOW_WATER, HOT_SPRING, LAVA, CHOCO } = BaseFluid;

/** 地砖物品 id → FLOOR 槽位(301..330 ↔ 1..30;与 `design.ts#floorSlotOfId` 同一规则)。 */
function slotOf(floorItemId: number): number {
  return floorItemId >= 301 && floorItemId <= 330 ? floorItemId - 300 : 0;
}

class Builder {
  readonly elev = new Uint8Array(N * N);
  readonly base = new Uint8Array(N * N);
  readonly floor = new Uint8Array(N * N);
  readonly obj = new Uint16Array(N * N);
  readonly region = new Uint8Array(N * N).fill(REGION_SEA);
  /** 到所属区域边界(群系边界或海岸,取近者)的近似距离 */
  readonly inland = new Float32Array(N * N);
  /** 0 = 自由;1 = 场地/路面(不撒资源);2 = 建筑(路也不许改) */
  readonly lock = new Uint8Array(N * N);
  readonly road = new Uint8Array(N * N);
  bridgeCells = 0;

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < N && y < N;
  }

  isWater(i: number): boolean {
    return this.elev[i] === DEEP && this.base[i]! >= SHALLOW_WATER;
  }

  isLand(x: number, y: number): boolean {
    if (!this.inside(x, y)) return false;
    const i = y * N + x;
    return this.region[i] !== REGION_SEA && !this.isWater(i);
  }

  /** 放一个物件并上锁(建筑级:路不会把它铲掉)。 */
  place(x: number, y: number, obj: number): void {
    if (!this.inside(x, y)) return;
    const i = y * N + x;
    this.obj[i] = obj;
    this.lock[i] = 2;
  }

  /** 铺一格地砖并标成场地。 */
  pave(x: number, y: number, floorItemId: number): void {
    if (!this.inside(x, y)) return;
    const i = y * N + x;
    if (this.region[i] === REGION_SEA) return;
    this.floor[i] = slotOf(floorItemId);
    if (this.lock[i] === 0) this.lock[i] = 1;
  }

  /** 把一个圆整平到指定高度;圆内的水填成陆地,物件清掉,标成场地。 */
  flatten(cx: number, cy: number, r: number, elev: number, base: number): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
        if (!this.inside(x, y) || Math.hypot(x - cx, y - cy) > r) continue;
        const i = y * N + x;
        if (this.region[i] === REGION_SEA) continue;
        this.elev[i] = elev;
        if (this.isWater(i) || this.base[i]! >= SHALLOW_WATER) this.base[i] = base;
        this.obj[i] = 0;
        this.floor[i] = 0;
        if (this.lock[i] === 0) this.lock[i] = 1;
      }
    }
  }

  /**
   * 盖一栋房子:一圈墙,朝 `door` 那一面正中开门,其余长边正中开窗,里面是屋顶。
   * 房子进不去(屋顶格与墙都挡路),它是街景,不是房间。
   */
  house(x0: number, y0: number, w: number, h: number, wall: number, roof: number, door: 'n' | 's' | 'e' | 'w'): void {
    const x1 = x0 + w - 1;
    const y1 = y0 + h - 1;
    const mx = x0 + Math.floor(w / 2);
    const my = y0 + Math.floor(h / 2);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (!this.inside(x, y)) continue;
        const i = y * N + x;
        this.elev[i] = this.elev[y0 * N + x0]!;
        this.floor[i] = 0;
        const ring = x === x0 || x === x1 || y === y0 || y === y1;
        if (!ring) { this.place(x, y, roof); continue; }
        const isDoor = (door === 'n' && y === y0 && x === mx) || (door === 's' && y === y1 && x === mx)
          || (door === 'w' && x === x0 && y === my) || (door === 'e' && x === x1 && y === my);
        const corner = (x === x0 || x === x1) && (y === y0 || y === y1);
        const isWindow = !corner && !isDoor && ((y === y0 || y === y1) ? x === mx : y === my);
        this.place(x, y, isDoor ? 363 : isWindow ? 370 : wall);
      }
    }
    /* 屋顶上一只烟囱(内部够大才放)。 */
    if (w >= 4 && h >= 4) this.place(x1 - 1, y0 + 1, 384);
  }
}

/** 折线(带起点半径处理由调用方负责)。 */
type Pt = readonly [number, number];

/** 第 1 步:海岸与群系。 */
function shapeLand(b: Builder): void {
  const d = new Float64Array(BIOME_SEEDS.length);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x;
      const dx = x + 0.5 - C;
      const dy = y + 0.5 - C;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      /* 圆角方形(超椭圆,p = 4)的海岸:比圆多用掉地图四角,再叠谐波与噪声做出海湾与岬角。 */
      const c4 = Math.cos(th) ** 4 + Math.sin(th) ** 4;
      const coast = 198 / Math.sqrt(Math.sqrt(c4))
        + 11 * Math.cos(3 * th + 0.7) + 7 * Math.cos(5 * th - 1.1) + 5 * Math.cos(2 * th + 2.0)
        + (fbm(x / 40, y / 40, 11) - 0.5) * 38;
      let shore = coast - r;
      const islet = ISLET.r + (fbm(x / 9, y / 9, 12) - 0.5) * 4 - Math.hypot(x + 0.5 - ISLET.x, y + 0.5 - ISLET.y);
      if (shore <= 0 && islet <= 0) {
        b.elev[i] = DEEP;
        b.base[i] = SHALLOW_WATER;
        continue;
      }
      b.elev[i] = GROUND;
      b.base[i] = GRASS;
      if (shore <= 0) {
        b.region[i] = RG.islet;
        b.inland[i] = islet;
        continue;
      }
      /* 群系:带噪声扭曲的加权 Voronoi。 */
      const wx = x + (fbm(x / 52, y / 52, 21) - 0.5) * 64;
      const wy = y + (fbm(x / 52, y / 52, 22) - 0.5) * 64;
      let best = 0;
      for (let k = 0; k < BIOME_SEEDS.length; k += 1) {
        const s = BIOME_SEEDS[k]!;
        d[k] = Math.hypot(wx - s.x, wy - s.y) * s.w;
        if (d[k]! < d[best]!) best = k;
      }
      let second = Infinity;
      for (let k = 0; k < BIOME_SEEDS.length; k += 1) if (k !== best && d[k]! < second) second = d[k]!;
      const edge = (second - d[best]!) / 2;
      if (r <= TOWN_RADIUS) {
        b.region[i] = RG.town;
        shore = Math.min(shore, TOWN_RADIUS - r + 30);
      } else {
        b.region[i] = BIOME_SEEDS[best]!.region;
      }
      b.inland[i] = Math.min(edge, shore);
      /* 沙滩:溶洞与云海两段是石岸,不铺沙。 */
      const rg = b.region[i];
      if (rg !== RG.cavern && rg !== RG.skysea && shore < 4.5 + 3 * fbm(x / 12, y / 12, 37)) b.base[i] = GOLD_SAND;
    }
  }
}

/** 第 2 步:地势。 */
function shapeTerrain(b: Builder): void {
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x;
      const rg = b.region[i]!;
      if (rg === REGION_SEA) continue;
      const bd = b.inland[i]!;
      const sand = b.base[i] === GOLD_SAND;
      switch (rg) {
        case RG.meadow:
          if (!sand && bd > 9 && Math.hypot(x - C, y - C) > 58 && fbm(x / 26, y / 26, 31) > 0.68) b.elev[i] = PLATFORM;
          break;
        case RG.valley:
          if (!sand && bd > 9 && fbm(x / 30, y / 30, 32) > 0.69) b.elev[i] = PLATFORM;
          break;
        case RG.sakura:
          if (bd > 9) b.elev[i] = bd > 24 && fbm(x / 22, y / 22, 33) > 0.7 ? CLIFF : PLATFORM;
          break;
        case RG.bamboo:
          if (!sand && bd > 12 && fbm(x / 28, y / 28, 38) > 0.64) b.elev[i] = PLATFORM;
          break;
        case RG.cavern:
          b.base[i] = ROCK;
          if (bd > 3 && bd <= 10) b.elev[i] = bd > 5 && bd <= 8.5 ? CLIFF : PLATFORM;
          else if (bd > 10) {
            if (bd > 22 && fbm(x / 17, y / 17, 35) > 0.74) { b.elev[i] = DEEP; b.base[i] = LAVA; }
            else if (fbm(x / 13, y / 13, 34) > 0.74) b.elev[i] = PLATFORM;
          }
          break;
        case RG.oasis:
          b.base[i] = GOLD_SAND;
          if (bd > 8 && fbm(x / 22, y / 22, 36) > 0.7) b.elev[i] = PLATFORM;
          break;
        case RG.dessert:
          break;
        case RG.skysea:
          if (bd > 7) b.elev[i] = bd > 15 ? CLIFF : PLATFORM;
          break;
        case RG.ruins:
          if (!sand) b.base[i] = fbm(x / 15, y / 15, 39) > 0.52 ? GRASS : ROCK;
          break;
        case RG.islet:
          b.base[i] = bd < 3 ? GOLD_SAND : GRASS;
          break;
        default:
          break;
      }
    }
  }
  /* 中值滤波一遍:去掉单格的尖刺与坑(噪声阈值切出来的边缘毛刺)。 */
  const src = b.elev.slice();
  const count = [0, 0, 0, 0];
  for (let y = 1; y < N - 1; y += 1) {
    for (let x = 1; x < N - 1; x += 1) {
      const i = y * N + x;
      if (b.region[i] === REGION_SEA || b.base[i] === LAVA) continue;
      count[0] = 0; count[1] = 0; count[2] = 0; count[3] = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = i + dy * N + dx;
          /* 海与熔岩不参与投票,免得把岸边的陆地一格格啃掉。 */
          if (b.region[j] === REGION_SEA || b.base[j] === LAVA) continue;
          count[src[j]!]! += 1;
        }
      }
      let acc = 0;
      const half = (count[0]! + count[1]! + count[2]! + count[3]!) / 2;
      for (let e = 0; e < 4; e += 1) {
        acc += count[e]!;
        if (acc > half) { b.elev[i] = e; break; }
      }
    }
  }
}

/** 沿折线下切一条河:河面 `half` 格宽,两侧各留 2 格整平到地面层的河岸。 */
function carveRiver(b: Builder, pts: readonly Pt[], half: number, fluid: number, seed: number): void {
  for (let k = 0; k + 1 < pts.length; k += 1) {
    const [ax, ay] = pts[k]!;
    const [bx, by] = pts[k + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const steps = Math.ceil(len * 2);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const wob = (fbm((k + t) * 2.2, seed, seed) - 0.5) * 2 * Math.min(9, len / 6) * Math.sin(Math.PI * t);
      const px = ax + (bx - ax) * t + nx * wob;
      const py = ay + (by - ay) * t + ny * wob;
      const w = half + (fbm(px / 11, py / 11, seed + 3) - 0.5) * 1.6;
      const reach = Math.ceil(w + 2.5);
      for (let y = Math.floor(py) - reach; y <= Math.floor(py) + reach; y += 1) {
        for (let x = Math.floor(px) - reach; x <= Math.floor(px) + reach; x += 1) {
          if (!b.inside(x, y)) continue;
          const i = y * N + x;
          if (b.region[i] === REGION_SEA) continue;
          const dist = Math.hypot(x + 0.5 - px, y + 0.5 - py);
          if (dist <= w) {
            b.elev[i] = DEEP;
            b.base[i] = fluid;
          } else if (dist <= w + 2.5 && !b.isWater(i)) {
            b.elev[i] = GROUND;
          }
        }
      }
    }
  }
}

/** 一片带噪声边缘的湖。 */
function carveLake(b: Builder, cx: number, cy: number, r: number, fluid: number, seed: number): void {
  for (let y = Math.floor(cy - r - 5); y <= cy + r + 5; y += 1) {
    for (let x = Math.floor(cx - r - 5); x <= cx + r + 5; x += 1) {
      if (!b.inside(x, y)) continue;
      const i = y * N + x;
      if (b.region[i] === REGION_SEA) continue;
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - (fbm(x / 8, y / 8, seed) - 0.5) * 6;
      if (dist <= r) {
        b.elev[i] = DEEP;
        b.base[i] = fluid;
      } else if (dist <= r + 2.5 && !b.isWater(i)) {
        b.elev[i] = GROUND;
      }
    }
  }
}

/** 第 3 步:水。 */
function shapeWater(b: Builder): void {
  /* 晨曦河:绯樱高地脚下发源,从镇子东边流过,向南入海。 */
  carveRiver(b, [[306, 168], [312, 214], [300, 258], [298, 306], [322, 352], [342, 414], [352, 500]], 2.4, SHALLOW_WATER, 101);
  /* 金秋河:竹林边发源,穿过河谷,向西入海。 */
  carveRiver(b, [[118, 192], [102, 236], [110, 286], [90, 336], [20, 368]], 2.6, SHALLOW_WATER, 102);
  /* 巧克力溪:从巧克力池流进南海。 */
  carveRiver(b, [[244, 432], [236, 504]], 1.8, CHOCO, 103);
  carveLake(b, 244, 428, 8, CHOCO, 113);
  /* 镜湖(镇子西北)与绿洲湖。 */
  carveLake(b, 214, 226, 10, SHALLOW_WATER, 111);
  carveLake(b, 412, 236, 11, SHALLOW_WATER, 112);
}

/** 镇子。 */
function buildTown(b: Builder): void {
  b.flatten(C, C, TOWN_RADIUS + 4, GROUND, GRASS);
  /* 广场:红砖,鹅卵石收边,喷泉一圈大理石。 */
  for (let y = C - 10; y <= C + 10; y += 1) {
    for (let x = C - 10; x <= C + 10; x += 1) {
      const rim = x === C - 10 || x === C + 10 || y === C - 10 || y === C + 10;
      b.pave(x, y, rim ? 302 : Math.hypot(x - C, y - C) <= 4.5 ? 306 : 305);
    }
  }
  b.place(C, C, 528);                      /* 许愿喷泉 */
  b.place(C, C + 7, 501);                  /* 篝火茶座 */
  b.place(C + 7, C - 7, 750);              /* 纪念碑 */
  b.place(C - 3, C - 6, 520); b.place(C + 3, C - 6, 520);   /* 长椅 */
  b.place(C - 6, C + 9, 513);              /* 公共储物箱 */
  b.place(C + 6, C + 9, 516);              /* 任务板 */
  b.place(C + 9, C + 9, 534);              /* 信箱 */
  for (const [dx, dy] of [[-9, -9], [9, -9], [-9, 9], [9, 9]] as const) b.place(C + dx, C + dy, 522);

  /* 四条出镇的街:鹅卵石,每 7 格一盏灯。 */
  for (let d = 11; d <= TOWN_RADIUS; d += 1) {
    for (let k = -1; k <= 1; k += 1) {
      b.pave(C + k, C - d, 302); b.pave(C + k, C + d, 302);
      b.pave(C - d, C + k, 302); b.pave(C + d, C + k, 302);
    }
    if (d % 7 === 0) {
      b.place(C - 2, C - d, 522); b.place(C + 2, C + d, 522);
      b.place(C - d, C + 2, 522); b.place(C + d, C - 2, 522);
    }
  }

  /* 西北:镇公所(红砖红瓦);西街两侧是木工棚与铁匠铺。 */
  b.house(C - 25, C - 22, 9, 6, 352, 372, 's');
  b.house(C - 21, C - 11, 5, 4, 351, 373, 'e');
  b.place(C - 14, C - 5, 502);                             /* 木工营造台 */
  b.house(C - 23, C + 7, 5, 4, 352, 372, 'e');
  b.place(C - 14, C + 5, 503); b.place(C - 16, C + 5, 504);  /* 高炉、铁砧 */

  /* 东北:酒馆(白灰泥墙)与大汤锅;东南:集市三摊。 */
  b.house(C + 14, C - 13, 8, 5, 353, 372, 's');
  b.place(C + 14, C - 5, 506); b.place(C + 18, C - 5, 519); b.place(C + 20, C - 5, 519);
  b.place(C + 21, C - 4, 520);
  for (const dx of [14, 17, 20]) b.place(C + dx, C + 5, 515);

  /* 东南角:炼金塔(蓝尖顶)、炼金炉与染缸。 */
  b.house(C + 16, C + 12, 5, 5, 353, 374, 'w');
  b.place(C + 13, C + 20, 536); b.place(C + 22, C + 14, 505); b.place(C + 16, C + 20, 537);

  /* 西南:三户人家、一口井、一小块菜地。 */
  b.house(C - 23, C + 14, 5, 4, 351, 373, 'e');
  b.house(C - 15, C + 14, 5, 4, 353, 372, 's');
  b.house(C - 23, C + 21, 5, 4, 351, 373, 'e');
  b.place(C - 13, C + 21, Landmark.WELL);
  for (let y = C + 24; y <= C + 27; y += 1) {
    for (let x = C - 14; x <= C - 8; x += 1) {
      b.pave(x, y, 301);
      b.obj[y * N + x] = (x + y) % 2 === 0 ? 123 : 0;
    }
  }

  /* 北面:一小片花园。 */
  for (const [dx, dy] of [[-6, -14], [-4, -16], [5, -15], [7, -13], [-13, -13], [12, -15], [-8, 13], [9, 13]] as const) {
    b.place(C + dx, C + dy, Landmark.FLOWER_BED);
  }
  for (const [dx, dy] of [[-12, -24], [10, -22], [24, 4], [-30, 0], [28, -22], [-28, 30], [26, 28], [4, 30]] as const) {
    b.place(C + dx, C + dy, 101);
  }
  b.place(C + 3, C - TOWN_RADIUS + 1, Landmark.SIGNPOST);
  b.place(C - 3, C + TOWN_RADIUS - 1, Landmark.SIGNPOST);
  b.place(C + TOWN_RADIUS - 1, C + 3, Landmark.SIGNPOST);
  b.place(C - TOWN_RADIUS + 1, C - 3, Landmark.SIGNPOST);
}

/** 一处营地:整平、铺一小片地、篝火、箱子、任务板、四盏灯,再加各自的特色。 */
function buildOutpost(b: Builder, o: (typeof OUTPOSTS)[number]): void {
  const { x: cx, y: cy } = o;
  const here = b.elev[cy * N + cx]!;
  const level = here === DEEP ? GROUND : here;
  const ground = o.region === RG.oasis ? GOLD_SAND : o.region === RG.cavern ? ROCK : GRASS;
  b.flatten(cx, cy, 12, level, ground);
  const paving = o.region === RG.sakura || o.region === RG.skysea ? 306
    : o.region === RG.ruins ? 307 : o.region === RG.dessert ? 311 : 302;
  for (let y = cy - 5; y <= cy + 5; y += 1) {
    for (let x = cx - 5; x <= cx + 5; x += 1) {
      if (Math.hypot(x - cx, y - cy) <= 5.3) b.pave(x, y, paving);
    }
  }
  b.place(cx, cy, 501);
  b.place(cx - 4, cy + 4, 513);
  b.place(cx + 4, cy + 4, 516);
  for (const [dx, dy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]] as const) b.place(cx + dx, cy + dy, 522);

  switch (o.id) {
    case 'valley_farm': {
      b.house(cx - 9, cy - 9, 6, 4, 351, 373, 's');
      b.place(cx + 5, cy - 7, 509);                              /* 水车磨坊 */
      b.place(cx + 8, cy - 2, 529);                              /* 饲育槽 */
      b.place(cx + 8, cy + 1, Landmark.HAY_BALE); b.place(cx + 9, cy + 3, Landmark.HAY_BALE);
      /* 一片麦田,中间一条灌溉渠。 */
      for (let y = cy + 8; y <= cy + 11; y += 1) {
        for (let x = cx - 8; x <= cx + 8; x += 1) {
          if (!b.inside(x, y) || b.region[y * N + x] === REGION_SEA) continue;
          const i = y * N + x;
          b.elev[i] = level; b.obj[i] = 0;
          if (y === cy + 10) { b.base[i] = SHALLOW_WATER; b.floor[i] = 0; b.lock[i] = 1; continue; }
          b.base[i] = DIRT;
          b.pave(x, y, 301);
          if ((x * 7 + y * 3) % 5 !== 0) b.obj[i] = 123;
        }
      }
      break;
    }
    case 'bamboo_hut':
      b.house(cx - 9, cy - 9, 5, 4, 354, 373, 's');
      for (let k = -3; k <= 3; k += 1) if (k !== 0) b.place(cx + k, cy - 8, 357);
      b.place(cx + 7, cy - 3, Landmark.STONE_LANTERN);
      break;
    case 'sakura_inn': {
      b.house(cx - 10, cy - 10, 8, 5, 354, 372, 's');
      b.place(cx + 1, cy - 7, Landmark.TORII);
      /* 三眼温泉:浅水,可以走进去泡。 */
      for (const [px, py] of [[cx + 7, cy - 6], [cx + 9, cy - 1], [cx + 7, cy + 8]] as const) {
        for (let y = py - 2; y <= py + 2; y += 1) {
          for (let x = px - 2; x <= px + 2; x += 1) {
            if (Math.hypot(x - px, y - py) > 2.3 || !b.inside(x, y)) continue;
            const i = y * N + x;
            b.base[i] = HOT_SPRING; b.floor[i] = 0; b.obj[i] = 0; b.lock[i] = 1;
          }
        }
        b.place(px + 3, py - 1, 526);
      }
      break;
    }
    case 'skysea_dock':
      b.house(cx - 9, cy - 9, 5, 4, 353, 374, 's');
      b.place(cx + 7, cy - 6, 440);                              /* 云海探险飞艇 */
      b.place(cx + 8, cy + 2, Landmark.CLOUD_PUFF); b.place(cx - 8, cy + 3, Landmark.CLOUD_PUFF);
      break;
    case 'oasis_bazaar':
      b.place(cx - 8, cy - 7, Landmark.TENT); b.place(cx - 5, cy - 8, Landmark.TENT); b.place(cx + 7, cy - 7, Landmark.TENT);
      for (const dx of [-3, 0, 3]) b.place(cx + dx, cy - 7, 515);
      b.place(cx + 7, cy + 1, Landmark.WELL);
      b.place(cx - 8, cy + 1, 125); b.place(cx + 9, cy - 3, 125);
      break;
    case 'ruins_camp':
      b.place(cx - 8, cy - 7, Landmark.TENT); b.place(cx + 7, cy - 7, Landmark.TENT);
      b.place(cx, cy - 7, 512);                                  /* 制图桌 */
      b.place(cx - 8, cy + 2, Landmark.PILLAR); b.place(cx + 8, cy + 2, Landmark.PILLAR);
      b.place(cx + 3, cy - 8, Landmark.GEAR_WRECK);
      break;
    case 'dessert_house':
      b.house(cx - 9, cy - 10, 6, 5, 360, 372, 's');
      b.place(cx + 5, cy - 7, 508);                              /* 披萨炉 */
      b.place(cx + 8, cy - 3, Landmark.LOLLIPOP); b.place(cx - 8, cy + 2, Landmark.CANDY_CANE);
      b.place(cx + 8, cy + 2, Landmark.CANDY_CANE);
      break;
    case 'cavern_camp':
      b.place(cx - 8, cy - 7, Landmark.TENT); b.place(cx - 5, cy - 8, Landmark.TENT);
      b.place(cx + 5, cy - 7, 503); b.place(cx + 7, cy - 7, 504);
      b.place(cx + 8, cy + 1, Landmark.STALAGMITE);
      break;
    default:
      break;
  }
}

/** 一座祭坛:需要的话先起一座两层的台,再整出圆形场地,正中放祭坛,四角点灯。 */
function buildAltar(b: Builder, a: (typeof ALTARS)[number]): void {
  const { x: cx, y: cy } = a;
  const [r1, r2] = a.mound;
  const ground = a.region === RG.oasis ? GOLD_SAND : a.region === RG.cavern || a.region === RG.ruins ? ROCK : GRASS;
  /* 方台(金字塔 / 神殿)用切比雪夫距离,其余用圆。 */
  const square = a.region === RG.oasis || a.region === RG.ruins;
  const within = (x: number, y: number, r: number): boolean =>
    (square ? Math.max(Math.abs(x - cx), Math.abs(y - cy)) : Math.hypot(x - cx, y - cy)) <= r;
  const reach = Math.max(r1, r2, 10) + 3;
  let top = b.elev[cy * N + cx]!;
  if (top === DEEP) top = GROUND;
  if (r1 > 0 || r2 > 0) {
    top = r2 > 0 ? CLIFF : PLATFORM;
    for (let y = cy - reach; y <= cy + reach; y += 1) {
      for (let x = cx - reach; x <= cx + reach; x += 1) {
        if (!b.inside(x, y) || b.region[y * N + x] === REGION_SEA) continue;
        const i = y * N + x;
        const level = r2 > 0 && within(x, y, r2) ? CLIFF : r1 > 0 && within(x, y, r1) ? PLATFORM : -1;
        if (level < 0) {
          /* 台脚外一圈整平到地面层,免得台子贴着别的陡坎。 */
          if (r1 > 0 && within(x, y, r1 + 3) && b.elev[i]! > GROUND) b.elev[i] = GROUND;
          continue;
        }
        b.elev[i] = level;
        if (b.base[i]! >= SHALLOW_WATER) b.base[i] = ground;
        b.obj[i] = 0;
        b.lock[i] = 1;
      }
    }
  }
  const arena = r2 > 0 ? r2 - 1 : r1 > 0 ? r1 - 2 : 9;
  if (r1 === 0 && r2 === 0) b.flatten(cx, cy, arena + 1, top, ground);
  for (let y = cy - arena; y <= cy + arena; y += 1) {
    for (let x = cx - arena; x <= cx + arena; x += 1) {
      if (!within(x, y, arena)) continue;
      const ring = within(x, y, arena) && !within(x, y, arena - 2);
      const core = within(x, y, 2);
      if (ring || core) b.pave(x, y, a.floor);
      else if (b.inside(x, y) && b.lock[y * N + x] === 0) b.lock[y * N + x] = 1;
    }
  }
  b.place(cx, cy, Landmark.ALTAR);
  const k = Math.max(3, arena - 3);
  for (const [dx, dy] of [[-k, -k], [k, -k], [-k, k], [k, k]] as const) b.place(cx + dx, cy + dy, 522);
  if (a.region === RG.sakura) { b.place(cx, cy + arena - 1, Landmark.TORII); }
  if (a.region === RG.ruins) {
    for (const [dx, dy] of [[-arena + 1, 0], [arena - 1, 0], [0, -arena + 1]] as const) b.place(cx + dx, cy + dy, Landmark.PILLAR);
  }
}

/** 第 4 步:场地。 */
function buildSites(b: Builder): OverworldSite[] {
  const sites: OverworldSite[] = [];
  buildTown(b);
  sites.push({ id: 'town', name: '晨曦镇', kind: 'town', region: 'town', x: C, y: C });
  for (const a of ALTARS) {
    buildAltar(b, a);
    sites.push({ id: a.id, name: a.name, kind: 'altar', region: REGION_DEFS[a.region]!.id, x: a.x, y: a.y });
  }
  for (const o of OUTPOSTS) {
    buildOutpost(b, o);
    sites.push({ id: o.id, name: o.name, kind: 'outpost', region: REGION_DEFS[o.region]!.id, x: o.x, y: o.y });
  }
  /* 灯塔岛。 */
  b.flatten(ISLET.x, ISLET.y, 4, GROUND, GRASS);
  b.place(ISLET.x, ISLET.y - 1, Landmark.LIGHTHOUSE);
  b.place(ISLET.x + 2, ISLET.y + 2, 513);
  sites.push({ id: 'lighthouse', name: '灯塔岛', kind: 'landmark', region: 'islet', x: ISLET.x, y: ISLET.y });
  /* NPC 站位:空出来并上锁(不撒资源、不被路面物件占用)。 */
  for (const p of Object.values(NPC_SPOTS)) {
    const i = p.y * N + p.x;
    b.obj[i] = 0;
    if (b.lock[i] === 0) b.lock[i] = 1;
  }
  return sites;
}

interface RoadSpec {
  pts: readonly Pt[];
  /** 半宽(格):1.5 = 三格宽的大路,1 = 两格宽的小径 */
  half: number;
  /** 路面地砖(0 = 土路) */
  floor: number;
  seed: number;
}

/** 把折线走成一串四连通的格子(带一点左右摆动,两端不摆)。 */
function centerline(spec: RoadSpec): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const push = (x: number, y: number): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === x && last.y === y) return;
    /* 斜着走的那一步补一格拐角,保证四连通(台阶判定只看上下左右)。 */
    if (last !== undefined && last.x !== x && last.y !== y) out.push({ x: last.x, y });
    out.push({ x, y });
  };
  for (let k = 0; k + 1 < spec.pts.length; k += 1) {
    const [ax, ay] = spec.pts[k]!;
    const [bx, by] = spec.pts[k + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const steps = Math.ceil(len * 3);
    const amp = Math.min(7, len / 9);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const wob = (fbm((k + t) * 2.6, spec.seed, spec.seed) - 0.5) * 2 * amp * Math.sin(Math.PI * t);
      push(Math.floor(ax + (bx - ax) * t + nx * wob), Math.floor(ay + (by - ay) * t + ny * wob));
    }
  }
  return out;
}

/** 沿路的高度剖面:抹掉窄的凸起与凹坑,再限制成「一次一层、每层至少走三格」。 */
function roadProfile(b: Builder, line: readonly { x: number; y: number }[]): { level: Uint8Array; bridge: Uint8Array } {
  const n = line.length;
  const raw = new Uint8Array(n);
  const bridge = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = line[i]!;
    const j = c.y * N + c.x;
    if (!b.inside(c.x, c.y) || b.region[j] === REGION_SEA || b.isWater(j)) {
      bridge[i] = 1;
      raw[i] = GROUND;
    } else {
      raw[i] = b.elev[j]! === DEEP ? GROUND : b.elev[j]!;
    }
  }
  const W = 5;
  const eroded = new Uint8Array(n);
  const opened = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    let m = 3;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k += 1) m = Math.min(m, raw[k]!);
    eroded[i] = m;
  }
  for (let i = 0; i < n; i += 1) {
    let m = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k += 1) m = Math.max(m, eroded[k]!);
    opened[i] = Math.min(m, raw[i]!);
  }
  const level = new Uint8Array(n);
  let cur = opened[0]!;
  let run = 3;
  for (let i = 0; i < n; i += 1) {
    const want = opened[i]!;
    if (want !== cur && run >= 3 && bridge[i] === 0) {
      cur += want > cur ? 1 : -1;
      run = 0;
    }
    level[i] = cur;
    run += 1;
  }
  return { level, bridge };
}

/** 铺一条路。 */
function paveRoad(b: Builder, spec: RoadSpec): void {
  const line = centerline(spec);
  if (line.length === 0) return;
  const { level, bridge } = roadProfile(b, line);
  const reach = Math.ceil(spec.half);
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    for (let y = c.y - reach; y <= c.y + reach; y += 1) {
      for (let x = c.x - reach; x <= c.x + reach; x += 1) {
        if (!b.inside(x, y) || Math.hypot(x - c.x, y - c.y) > spec.half) continue;
        const j = y * N + x;
        if (b.lock[j] === 2) continue;
        const water = b.region[j] === REGION_SEA || b.isWater(j);
        if (water) {
          /* 水面:只在桥段铺栈桥,岸边的水不动。 */
          if (bridge[i] === 0) continue;
          if (b.floor[j] !== slotOf(310)) b.bridgeCells += 1;
          b.floor[j] = slotOf(310);
          b.obj[j] = 0;
          b.road[j] = 1;
          b.lock[j] = 1;
          continue;
        }
        /* 场地里(广场、营地、祭坛)不改地面,只记成路,保证连通。 */
        if (b.lock[j] === 1 && b.road[j] === 0 && b.floor[j] !== 0) { b.road[j] = 1; continue; }
        b.elev[j] = bridge[i] === 1 ? GROUND : level[i]!;
        b.obj[j] = 0;
        if (spec.floor !== 0) b.floor[j] = slotOf(spec.floor);
        else { b.floor[j] = 0; b.base[j] = b.base[j] === GOLD_SAND ? GOLD_SAND : DIRT; }
        b.road[j] = 1;
        b.lock[j] = 1;
      }
    }
  }
}

/** 第 5 步:路。返回放下的台阶数。 */
function buildRoads(b: Builder): number {
  const site = (id: string): Pt => {
    if (id === 'town') return [C, C];
    const o = OUTPOSTS.find((s) => s.id === id) ?? ALTARS.find((s) => s.id === id)!;
    return [o.x, o.y];
  };
  const T = TOWN_RADIUS;
  const main = (pts: readonly Pt[], seed: number): RoadSpec => ({ pts, half: 1.5, floor: 0, seed });
  const trail = (pts: readonly Pt[], seed: number): RoadSpec => ({ pts, half: 1.05, floor: 0, seed });
  const roads: RoadSpec[] = [
    /* 四条放射路(接在镇子四条街的尽头)与去溶洞的西南路。 */
    main([[C - T, C], [204, 260], site('valley_farm')], 201),
    main([[C, C - T], [260, 186], site('sakura_inn')], 202),
    main([[C + T, C], [334, 258], site('oasis_bazaar')], 203),
    main([[C, C + T], [264, 336], site('dessert_house')], 204),
    main([[C - 28, C + 28], [200, 322], site('cavern_camp')], 205),
    /* 环路。 */
    main([site('valley_farm'), [142, 208], site('bamboo_hut')], 211),
    main([site('bamboo_hut'), [204, 134], site('sakura_inn')], 212),
    main([site('sakura_inn'), [322, 134], site('skysea_dock')], 213),
    main([site('skysea_dock'), [392, 202], site('oasis_bazaar')], 214),
    main([site('oasis_bazaar'), [392, 318], site('ruins_camp')], 215),
    main([site('ruins_camp'), [328, 392], site('dessert_house')], 216),
    main([site('dessert_house'), [222, 388], site('cavern_camp')], 217),
    main([site('cavern_camp'), [152, 318], site('valley_farm')], 218),
    /* 镇子西南角到西南路的一小段连接。 */
    main([[C - 10, C + 10], [C - 28, C + 28]], 219),
    /* 灯塔栈桥。 */
    trail([site('oasis_bazaar'), [440, 244], [ISLET.x - 3, ISLET.y]], 221),
  ];
  /* 通往各祭坛的小径。 */
  ALTARS.forEach((a, k) => {
    const from = site(a.from);
    const start: Pt = a.from === 'town' ? [C - 20, C + 28] : from;
    roads.push(trail([start, [a.x, a.y]], 231 + k));
  });
  for (const r of roads) paveRoad(b, r);

  /* 台阶:路面格的上下左右有高一层的路面格 ⇒ 这一格放台阶。 */
  let stairs = 0;
  for (let y = 1; y < N - 1; y += 1) {
    for (let x = 1; x < N - 1; x += 1) {
      const i = y * N + x;
      if (b.road[i] === 0 || b.lock[i] === 2 || b.isWater(i)) continue;
      const e = b.elev[i]!;
      for (const j of [i - 1, i + 1, i - N, i + N]) {
        if (b.road[j] === 1 && !b.isWater(j) && b.elev[j] === e + 1) {
          b.obj[i] = b.region[i] === RG.meadow || b.region[i] === RG.valley || b.region[i] === RG.bamboo ? 377 : 378;
          stairs += 1;
          break;
        }
      }
    }
  }
  return stairs;
}

/** 一条撒布规则:`mask` 给出噪声门槛时只在门槛以上的片区生效。 */
interface Scatter {
  obj: number;
  p: number;
  mask?: { scale: number; seed: number; min: number; p: number };
  /** 只在这些高度层出现 */
  elev?: readonly number[];
  /** 离流体不超过这么多格才出现 */
  nearFluid?: { fluid: number; dist: number };
  /** 离区域边界至少这么远 */
  inland?: number;
  /** 只在这种基底上 */
  base?: number;
}

const SCATTER: Readonly<Record<number, readonly Scatter[]>> = {
  [RG.town]: [
    { obj: Landmark.FLOWER_BED, p: 0.012 },
    { obj: 121, p: 0.006 },
  ],
  [RG.meadow]: [
    { obj: 101, p: 0.02, mask: { scale: 36, seed: 41, min: 0.56, p: 0.42 } },
    { obj: 121, p: 0.012, mask: { scale: 20, seed: 42, min: 0.58, p: 0.12 } },
    { obj: 118, p: 0.04, mask: { scale: 14, seed: 43, min: 0.52, p: 0.3 } },
    { obj: 106, p: 0.012 },
    { obj: Landmark.FLOWER_BED, p: 0.012, mask: { scale: 16, seed: 44, min: 0.6, p: 0.1 } },
    { obj: Landmark.STUMP, p: 0.003 },
    { obj: 112, p: 0.02, elev: [PLATFORM] },
  ],
  [RG.valley]: [
    { obj: 107, p: 0.3, nearFluid: { fluid: SHALLOW_WATER, dist: 2 } },
    { obj: 122, p: 0.008, mask: { scale: 30, seed: 51, min: 0.6, p: 0.3 } },
    { obj: 123, p: 0.0, mask: { scale: 18, seed: 52, min: 0.64, p: 0.5 } },
    { obj: 101, p: 0.05 },
    { obj: 120, p: 0.012 },
    { obj: 118, p: 0.06 },
    { obj: 121, p: 0.01 },
    { obj: 106, p: 0.008 },
    { obj: Landmark.HAY_BALE, p: 0.003 },
  ],
  [RG.sakura]: [
    { obj: 109, p: 0.3, nearFluid: { fluid: HOT_SPRING, dist: 3 } },
    { obj: 102, p: 0.04, mask: { scale: 32, seed: 61, min: 0.5, p: 0.36 } },
    { obj: 118, p: 0.04 },
    { obj: Landmark.FLOWER_BED, p: 0.03 },
    { obj: 106, p: 0.01 },
    { obj: 109, p: 0.006 },
    { obj: 127, p: 0.004 },
    { obj: Landmark.STONE_LANTERN, p: 0.003 },
  ],
  [RG.bamboo]: [
    { obj: 103, p: 0.06, mask: { scale: 28, seed: 62, min: 0.45, p: 0.46 } },
    { obj: 118, p: 0.08 },
    { obj: 106, p: 0.01 },
    { obj: 127, p: 0.005 },
    { obj: 124, p: 0.006 },
  ],
  [RG.cavern]: [
    { obj: 110, p: 0.3, nearFluid: { fluid: LAVA, dist: 2 } },
    { obj: 111, p: 0.08, nearFluid: { fluid: LAVA, dist: 4 } },
    { obj: 104, p: 0.03, mask: { scale: 26, seed: 71, min: 0.55, p: 0.25 }, elev: [GROUND] },
    { obj: 116, p: 0.006, mask: { scale: 16, seed: 72, min: 0.66, p: 0.2 }, elev: [GROUND] },
    { obj: 114, p: 0.008, inland: 30, elev: [GROUND] },
    { obj: 113, p: 0.016, inland: 18, elev: [GROUND] },
    { obj: 112, p: 0.02 },
    { obj: 124, p: 0.03, elev: [GROUND] },
    { obj: Landmark.STALAGMITE, p: 0.022 },
    { obj: 106, p: 0.02 },
  ],
  [RG.oasis]: [
    { obj: 125, p: 0.22, nearFluid: { fluid: SHALLOW_WATER, dist: 7 } },
    { obj: 126, p: 0.01, mask: { scale: 18, seed: 81, min: 0.62, p: 0.14 } },
    { obj: 108, p: 0.03 },
    { obj: Landmark.CACTUS, p: 0.012 },
    { obj: 115, p: 0.03, elev: [PLATFORM, CLIFF] },
    { obj: 106, p: 0.006 },
  ],
  [RG.dessert]: [
    { obj: 105, p: 0.04, mask: { scale: 30, seed: 91, min: 0.5, p: 0.3 } },
    { obj: Landmark.LOLLIPOP, p: 0.02 },
    { obj: Landmark.CANDY_CANE, p: 0.012 },
    { obj: 124, p: 0.03 },
    { obj: 121, p: 0.02 },
    { obj: 128, p: 0.008 },
  ],
  [RG.skysea]: [
    { obj: 119, p: 0.05, mask: { scale: 18, seed: 95, min: 0.55, p: 0.3 }, elev: [PLATFORM, CLIFF] },
    { obj: 117, p: 0.008, elev: [CLIFF] },
    { obj: Landmark.CLOUD_PUFF, p: 0.035, elev: [PLATFORM, CLIFF] },
    { obj: 129, p: 0.035 },
    { obj: 106, p: 0.012, elev: [GROUND] },
    { obj: 118, p: 0.04, elev: [GROUND] },
  ],
  [RG.ruins]: [
    { obj: Landmark.PILLAR, p: 0.02 },
    { obj: Landmark.GEAR_WRECK, p: 0.008 },
    { obj: 112, p: 0.02 },
    { obj: 110, p: 0.008 },
    { obj: 116, p: 0.008 },
    { obj: 118, p: 0.03, base: GRASS },
    { obj: 130, p: 0.004 },
    { obj: 106, p: 0.01 },
  ],
  [RG.islet]: [
    { obj: 125, p: 0.08 },
    { obj: 108, p: 0.04 },
    { obj: 117, p: 0.02 },
  ],
};

/** 第 6 步:资源与点缀。 */
function scatter(b: Builder): void {
  /* 离各种流体的距离(只算到 7 格):多源 BFS。 */
  const fluidDist = (fluid: number, max: number): Uint8Array => {
    const dist = new Uint8Array(N * N).fill(255);
    let frontier: number[] = [];
    for (let i = 0; i < N * N; i += 1) {
      if (b.base[i] === fluid && (b.elev[i] === DEEP || fluid === HOT_SPRING)) { dist[i] = 0; frontier.push(i); }
    }
    for (let d = 1; d <= max && frontier.length > 0; d += 1) {
      const next: number[] = [];
      for (const i of frontier) {
        const x = i % N;
        for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, i - N, i + N]) {
          if (j < 0 || j >= N * N || dist[j] !== 255) continue;
          dist[j] = d;
          next.push(j);
        }
      }
      frontier = next;
    }
    return dist;
  };
  const near: Record<number, Uint8Array> = {
    [SHALLOW_WATER]: fluidDist(SHALLOW_WATER, 7),
    [HOT_SPRING]: fluidDist(HOT_SPRING, 3),
    [LAVA]: fluidDist(LAVA, 4),
  };

  /* 第一遍:每格想放什么。 */
  const want = new Uint16Array(N * N);
  for (let y = 2; y < N - 2; y += 1) {
    for (let x = 2; x < N - 2; x += 1) {
      const i = y * N + x;
      const rg = b.region[i]!;
      if (rg === REGION_SEA || b.lock[i] !== 0 || b.isWater(i) || b.floor[i] !== 0) continue;
      if (b.base[i]! >= SHALLOW_WATER) continue;
      const rules = SCATTER[rg];
      if (rules === undefined) continue;
      for (let k = 0; k < rules.length; k += 1) {
        const r = rules[k]!;
        if (r.elev !== undefined && !r.elev.includes(b.elev[i]!)) continue;
        if (r.base !== undefined && b.base[i] !== r.base) continue;
        if (r.inland !== undefined && b.inland[i]! < r.inland) continue;
        if (r.nearFluid !== undefined && near[r.nearFluid.fluid]![i]! > r.nearFluid.dist) continue;
        let p = r.p;
        if (r.mask !== undefined && fbm(x / r.mask.scale, y / r.mask.scale, r.mask.seed) > r.mask.min) p = r.mask.p;
        if (hash2(x, y, 500 + rg * 31 + k) < p) { want[i] = r.obj; break; }
      }
    }
  }
  /* 第二遍:挡路的物件只在「八邻里优先级最高」时落地 ⇒ 任意两件挡路物互不相邻。 */
  for (let y = 2; y < N - 2; y += 1) {
    for (let x = 2; x < N - 2; x += 1) {
      const i = y * N + x;
      const o = want[i]!;
      if (o === 0) continue;
      if (!isSolidObj(o)) { b.obj[i] = o; continue; }
      const pri = hash2(x, y, 777);
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const j = i + dy * N + dx;
          /* 邻格已经有挡路物(建筑、路灯旁的树…)或有更高优先级的候选 ⇒ 让。 */
          if (isSolidObj(b.obj[j]!) && b.lock[j] !== 0) { ok = false; break; }
          if (want[j] !== 0 && isSolidObj(want[j]!) && hash2(x + dx, y + dy, 777) > pri) { ok = false; break; }
        }
      }
      if (ok) b.obj[i] = o;
    }
  }
}

function generate(): Overworld {
  const b = new Builder();
  shapeLand(b);
  shapeTerrain(b);
  shapeWater(b);
  const sites = buildSites(b);
  const stairCells = buildRoads(b);
  scatter(b);

  const tiles = new Uint32Array(N * N);
  const regionCells = REGION_DEFS.map(() => 0);
  let landCells = 0;
  let seaCells = 0;
  let roadCells = 0;
  let objCells = 0;
  for (let i = 0; i < N * N; i += 1) {
    tiles[i] = packTile({ elev: b.elev[i]!, base: b.base[i]!, floor: b.floor[i]!, wire: 0, obj: b.obj[i]!, meta: 0 });
    const rg = b.region[i]!;
    if (rg === REGION_SEA) seaCells += 1;
    else { landCells += 1; regionCells[rg]! += 1; }
    if (b.road[i] === 1) roadCells += 1;
    if (b.obj[i] !== 0) objCells += 1;
  }
  return {
    size: N,
    tiles,
    region: b.region,
    road: b.road,
    sites,
    stats: { landCells, seaCells, roadCells, bridgeCells: b.bridgeCells, stairCells, objCells, regionCells },
  };
}

let cached: Overworld | null = null;

/** 主世界(首次调用时生成,之后复用同一份)。 */
export function overworld(): Overworld {
  if (cached === null) cached = generate();
  return cached;
}

/** 读主世界的一格(世界外 ⇒ `null`)。 */
export function overworldCell(ow: Overworld, x: number, y: number): CellView | null {
  if (x < 0 || y < 0 || x >= ow.size || y >= ow.size) return null;
  const v = ow.tiles[y * ow.size + x]!;
  return { elev: v & 0x3, base: (v >>> 2) & 0xf, floor: (v >>> 6) & 0x3f, obj: (v >>> 16) & 0xfff };
}

/**
 * 从 `(sx, sy)` 出发,按通行规则(`passable.ts#canEnter`,不跳、可走台阶)能走到的所有格子。
 * 返回与世界同尺寸的 0/1 数组。用于自检「每个场地都走得到」。
 */
export function walkableFrom(ow: Overworld, sx: number, sy: number): Uint8Array {
  const n = ow.size;
  const seen = new Uint8Array(n * n);
  const start = sy * n + sx;
  seen[start] = 1;
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  queue[tail] = start;
  tail += 1;
  while (head < tail) {
    const i = queue[head]!;
    head += 1;
    const x = i % n;
    const y = (i - x) / n;
    const from = overworldCell(ow, x, y)!;
    const z = (from.elev & 3) - 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const to = overworldCell(ow, x + dx, y + dy);
      if (to === null) continue;
      const j = (y + dy) * n + (x + dx);
      if (seen[j] === 1) continue;
      if (isDeepWater(from) && isDeepWater(to)) continue;      /* 不把游泳算作走路 */
      if (!canEnter(from, to, Math.max(0, z))) continue;
      seen[j] = 1;
      queue[tail] = j;
      tail += 1;
    }
  }
  return seen;
}
