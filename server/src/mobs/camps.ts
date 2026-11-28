/**
 * WS-FND-201:野怪营地 —— 怪住在哪、住多少、多凶。
 *
 * ## 修前是什么样(2026-11-27 真浏览器实测,`combat_run3`)
 * 主世界的怪由 `WorldSim.trySpawnOne` 在**随机一名玩家身边 13..34 格的环带**里现刷,
 * 怪的「家」就是刷出来的那一格,追击又没有离家距离限制 ⇒ **怪没有地盘**:
 * 一级玩家刚走出镇子 54 格,身边已经围了野猪和史莱姆,几秒倒地,复活回出生点,再走一遍还是这样。
 * 这不是数值问题,是「怪没有地方可待」。
 *
 * ## 营地是什么
 * 一个营地 = 一个圆心(怪的「家」)+ 半径(怪只刷在圆里的落脚格上)+ 拴绳(怪追人追到离圆心
 * 多远就放弃、回家)+ 一份常驻名单(哪几种、各几只)。名单按**危险层**分,层由「离最近的
 * 安全点多远」定:
 *
 * ```text
 * 层  离安全点        名单(同群系里按物种 level 升序:最温顺 → 最凶)
 * 0   < 56 格         最温顺 ×3
 * 1   56..80          最温顺 ×2 + 次温顺 ×2
 * 2   ≥ 80            最温顺 ×1 + 次温顺 ×1 + 最凶 ×2
 * ```
 *
 * 「安全点」= 镇心 + 各群系的营地(有人常驻的地方)。草甸:绵羊(1) → 史莱姆(2) → 野猪(4),
 * 所以一级玩家出镇先遇到绵羊,走远了才碰到会咬人的。
 *
 * ⚠️ 「温顺 → 凶」**只按 `level` 排**,不去手标哪种算温顺:群系里新增物种时自动落到合适的层,
 *   不会有人忘了改这张表而让野猪蹲在镇门口。
 * ⚠️ 层只由距离定,**不做「某区没有巢穴就把最远的一处升级」的补丁**:那会让两头野猪的营地
 *   出现在离镇 78 格的地方,与「离安全点近的只放温顺怪」互相打架。某区真的没有巢穴 ⇒ 去调距离阈值。
 * ⚠️ 夜行怪(`NOCTURNAL_MOBS`)按物种照常排名:白天它们的名额补不上(刷怪器的夜行门不放行),
 *   天黑才补。这是既有规则(WS-FND-153),营地不绕过它。
 * ⚠️ 本模块是**纯函数**:只读主世界地图,不碰模拟层;同一张图永远得到同一批营地
 *   (抽签用格坐标的哈希,不用随机数,也不引入第二个 PRNG)。
 *
 * ## 为什么不要求「整圆每格都走得到」(第一版就栽在这)
 * 第一版把「整圆每格都在出生点可达集合里」当硬条件:真实地图上只有草甸、绿洲、云海三个区摆得出营地,
 * 河谷、樱花、竹林、溶洞、甜点、遗迹**一处都没有**。半径 6 的圆有 113 格,圆里只要有一棵树、一根石柱、
 * 一格断崖就整圆作废。探针 `camp_why2` 量到:这六个区候选圆里「圆内可走占比」的中位数都在 0.9 左右或更高。
 * 所以改成**度量**:圆心必须是空地且出生点走得到,圆不跨区、不含深水,再要求落脚格
 * (可走、没物件、不是路、与圆心同高)占比 ≥ `CAMP_FREE_MIN`;刷怪只在这些落脚格里抽,
 * 所以不会刷进树里、水里或悬崖上。
 */

import {
  REGION_DEFS, SPAWN_POINT, WORLD_CENTER, overworldCell, walkableFrom, type Overworld,
} from '../../../shared/world/overworld.ts';
import { isDeepWater } from '../../../shared/world/passable.ts';
import { spawnableMobs } from './spawner.ts';

/** 危险层:0 温顺 / 1 普通 / 2 巢穴。 */
export type CampTier = 0 | 1 | 2;

/** 营地名单里的一行:这种怪常驻几只。 */
export interface CampSlot {
  mobId: string;
  count: number;
}

export interface MobCamp {
  /** 全局唯一:`camp_<区域 id>_<序号>`。 */
  id: string;
  tier: CampTier;
  /** 所在区域 id(`REGION_DEFS[].id`)。 */
  region: string;
  /** 刷怪配表的群系键(`BIOME_SPAWN` 的键)。 */
  biome: string;
  /** 圆心(格心坐标,即整数格 +0.5)= 营地里每只怪的「家」。 */
  x: number;
  y: number;
  /** 营地圆的半径(格):怪只刷在这个圆里。 */
  radius: number;
  /** 拴绳(格):怪离**圆心**超过这么远就放弃追击、回家。 */
  leash: number;
  /** 常驻名单。 */
  roster: readonly CampSlot[];
  /** 怪能落脚的格(整数格坐标):可走、没物件、不是路、与圆心同高。刷怪只在这些格里抽。 */
  cells: readonly (readonly [number, number])[];
}

/** 营地圆的半径(格)。 */
export const CAMP_RADIUS = 6;
/** 营地圆心离镇心至少这么远:镇区半径 40 + 余量 ⇒ 营地不压进镇子,最长的拴绳(20)也够不着 24 格的安全区(`tests/WS-FND-201` 逐营地钉着)。 */
export const CAMP_MIN_TOWN_DIST = 46;
/** 营地圆心离任何场地(营地 NPC、祭坛、灯塔)至少这么远:怪不蹲在有人的地方,也不堵祭坛。 */
export const CAMP_MIN_SITE_DIST = 30;
/** 两处营地圆心至少隔这么远。 */
export const CAMP_MIN_GAP = 38;
/** 一个区每这么多可达格摊一处营地(至少 2 处,至多 `CAMP_MAX_PER_REGION` 处)。 */
export const CAMP_AREA_PER = 1800;
export const CAMP_MAX_PER_REGION = 12;
/** 层的分界:离最近安全点的距离(格)。 */
export const CAMP_TIER1_MIN_DIST = 56;
export const CAMP_TIER2_MIN_DIST = 80;
/** 各层的拴绳(格,从圆心量起):越凶的营地,怪追得越远。 */
export const CAMP_LEASH: readonly [number, number, number] = [12, 16, 20];
/** 营地圆里至少这么大比例的格子是落脚格,怪才有地方站。 */
export const CAMP_FREE_MIN = 0.7;
/** 候选圆心的网格步长(格):每 3 格取一个点试,够密又不贵。 */
const CAMP_GRID_STEP = 3;

/* ── 运行参数(`WorldSim` 的营地补员读它们)── */

/**
 * 玩家离营地圆心不超过这么远(格),营地才补员。
 * ⚠️ 必须小于「`CAMP_MIN_TOWN_DIST` 减去出生点离镇心的距离」⇒ 站在出生点永远唤醒不了任何营地:
 *   「镇里一只怪都不刷」由几何保证,不靠安全区护盾兜底(`tests/WS-FND-201` 钉着这条不等式)。
 */
export const CAMP_WAKE_DIST = 38;
/** 营地里某个名额的怪死了(被打死 / 自己消失)之后,隔这么多秒才补一只。 */
export const CAMP_RESPAWN_SEC = 45;
/** 补员的落点离任何玩家至少这么远(格):怪不在眼皮底下凭空冒出来。 */
export const CAMP_SPAWN_MIN_PLAYER_DIST = 10;
/** 补一只怪时最多试几个落点(落点被占 / 离玩家太近 / 刷怪器不放行就换一个)。 */
export const CAMP_SPAWN_TRIES = 6;

/**
 * 每层的名单构成:下标 = 物种在群系里按 level 升序的名次,值 = 只数。
 * 群系里物种不够名次时,落到最后一种上(樱花只有 2 种:巢穴里第二种占 3 只)。
 */
const CAMP_COMPOSITION: readonly (readonly number[])[] = [[3], [2, 2], [1, 1, 2]];

/** 某群系某一层的常驻名单。 */
export function campRoster(biome: string, tier: CampTier): CampSlot[] {
  const ladder = spawnableMobs(biome).slice().sort((a, b) => a.level - b.level);
  const out = new Map<string, number>();
  CAMP_COMPOSITION[tier]!.forEach((n, rank) => {
    const m = ladder[Math.min(rank, ladder.length - 1)];
    if (m !== undefined) out.set(m.id, (out.get(m.id) ?? 0) + n);
  });
  return [...out].map(([mobId, count]) => ({ mobId, count }));
}

/** 营地里的一个名额:名单里的每一只怪占一个名额,名额记着此刻是哪只怪占着、最早什么时候能补。 */
export interface CampSeat {
  /** 这个名额刷哪个物种(`MOB_BY_ID` 的键)。 */
  mobId: string;
  /** 占着名额的怪的实例 id;`null` = 空着。 */
  id: string | null;
  /** 最早哪一帧可以补:打死之后要等 `CAMP_RESPAWN_SEC`;从没刷过 / 撤场之后为 0 = 随时。 */
  readyAt: number;
}

/** 按营地名单摊成名额,每个营地一组,下标与 `camps` 一一对应;`null`(世界不用营地)⇒ 没有名额。 */
export function campSeatsOf(camps: readonly MobCamp[] | null): CampSeat[][] {
  if (camps === null) return [];
  return camps.map((c) => c.roster.flatMap(
    (r) => Array.from({ length: r.count }, (): CampSeat => ({ mobId: r.mobId, id: null, readyAt: 0 })),
  ));
}

/** 确定性「抽签」:同一格永远同一个数 ∈ [0,1)。 */
function cellRoll(x: number, y: number): number {
  let v = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ 0x5eed;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

function nearestDist(x: number, y: number, pts: readonly { x: number; y: number }[]): number {
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(x - p.x, y - p.y));
  return best;
}

/** 安全点:镇心 + 各群系营地(有人常驻的地方)。营地离它们越近越温顺。 */
export function campSafePoints(ow: Overworld): { x: number; y: number }[] {
  return [{ x: WORLD_CENTER, y: WORLD_CENTER }, ...ow.sites.filter((s) => s.kind === 'outpost')];
}

/** 离最近安全点的距离 ⇒ 危险层。 */
export function campTierOf(distToSafe: number): CampTier {
  return distToSafe >= CAMP_TIER2_MIN_DIST ? 2 : distToSafe >= CAMP_TIER1_MIN_DIST ? 1 : 0;
}

const planned = new WeakMap<Overworld, readonly MobCamp[]>();

/**
 * 在主世界上摆营地。每个陆地区域(镇和灯塔岛除外)按面积摊 2..12 处;
 * 候选圆心必须:出生点走得到、是空地、不在路上、整圆不跨区不碰深水、圆里落脚格 ≥ `CAMP_FREE_MIN`,
 * 且离镇心 ≥ `CAMP_MIN_TOWN_DIST`、离任何场地 ≥ `CAMP_MIN_SITE_DIST`、离已摆的营地 ≥ `CAMP_MIN_GAP`。
 * 结果按 `ow` 对象缓存(`overworld()` 本身是单例)。
 */
export function planCamps(ow: Overworld): readonly MobCamp[] {
  const hit = planned.get(ow);
  if (hit !== undefined) return hit;

  const n = ow.size;
  const reach = walkableFrom(ow, SPAWN_POINT.x, SPAWN_POINT.y);
  const safe = campSafePoints(ow);
  const out: MobCamp[] = [];
  /** 已摆的圆心(整数格),跨区也要互相留间距。 */
  const placed: { x: number; y: number }[] = [];

  /** 以 (x,y) 为心的圆合格 ⇒ 返回怪能落脚的格;不合格 ⇒ `null`。 */
  const freeCellsOf = (ri: number, x: number, y: number): [number, number][] | null => {
    const r = CAMP_RADIUS;
    const mid = overworldCell(ow, x, y);
    /* 圆心就是怪的「家」:必须是空地,否则回家回到一棵树里。 */
    if (mid === null || mid.obj !== 0 || ow.road[y * n + x] === 1) return null;
    const cells: [number, number][] = [];
    let total = 0;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const c = overworldCell(ow, x + dx, y + dy);
        if (c === null) return null;
        const i = (y + dy) * n + (x + dx);
        /* 跨区 / 含深水 ⇒ 整圆作废:营地不跨群系(刷怪按群系名单),也不蹲在水边。 */
        if (ow.region[i] !== ri || isDeepWater(c)) return null;
        total += 1;
        if (reach[i] === 1 && c.obj === 0 && ow.road[i] === 0 && c.elev === mid.elev) cells.push([x + dx, y + dy]);
      }
    }
    return cells.length >= total * CAMP_FREE_MIN ? cells : null;
  };

  REGION_DEFS.forEach((def, ri) => {
    if (def.id === 'town' || def.id === 'islet') return;
    let reachCells = 0;
    const cand: { x: number; y: number; roll: number }[] = [];
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = y * n + x;
        if (ow.region[i] !== ri || reach[i] !== 1) continue;
        reachCells += 1;
        if (x % CAMP_GRID_STEP === 0 && y % CAMP_GRID_STEP === 0) cand.push({ x, y, roll: cellRoll(x, y) });
      }
    }
    cand.sort((a, b) => a.roll - b.roll || a.y - b.y || a.x - b.x);
    const want = Math.min(CAMP_MAX_PER_REGION, Math.max(2, Math.round(reachCells / CAMP_AREA_PER)));

    const picked: { x: number; y: number; ds: number; cells: [number, number][] }[] = [];
    for (const c of cand) {
      if (picked.length >= want) break;
      /* 先过便宜的距离判定,最后才扫整圆。 */
      if (Math.hypot(c.x - WORLD_CENTER, c.y - WORLD_CENTER) < CAMP_MIN_TOWN_DIST) continue;
      if (ow.sites.some((s) => Math.hypot(c.x - s.x, c.y - s.y) < CAMP_MIN_SITE_DIST)) continue;
      if (placed.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < CAMP_MIN_GAP)) continue;
      const cells = freeCellsOf(ri, c.x, c.y);
      if (cells === null) continue;
      picked.push({ x: c.x, y: c.y, ds: nearestDist(c.x, c.y, safe), cells });
      placed.push({ x: c.x, y: c.y });
    }
    /* 编号按位置(自上而下、自左而右),别按抽签顺序:读起来才对得上地图。 */
    picked.sort((a, b) => a.y - b.y || a.x - b.x);

    picked.forEach((p, i) => {
      const tier = campTierOf(p.ds);
      out.push({
        id: `camp_${def.id}_${i + 1}`,
        tier,
        region: def.id,
        biome: def.biome,
        x: p.x + 0.5,
        y: p.y + 0.5,
        radius: CAMP_RADIUS,
        leash: CAMP_LEASH[tier],
        roster: campRoster(def.biome, tier),
        cells: p.cells,
      });
    });
  });

  planned.set(ow, out);
  return out;
}
