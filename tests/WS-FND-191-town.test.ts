/**
 * WS-FND-191 —— **营地里真的有座小镇**(`shared/world/town.ts`)。
 *
 * ## 为什么有这一套
 *
 * 世界里此前**只有广场,没有城镇**:`design.ts` 把营地铺成
 * 「红砖地砖 + 中心大理石 + 一圈地标物件」,而 `shared/constants/items.ts` 里
 * 的墙体/门窗/屋顶(351~385)与家具(501~537)**一件都没进世界**。
 * 于是「有城镇」这条愿景无法验收 —— 没有判据能说清「房子长什么样」。
 *
 * 本套件守的就是**「房子长什么样」**:每座房子的墙圈、门、窗、屋顶按**坐标验算**
 * (不是数个数、不是抽样),再加一条街与一个市场角。
 *
 * ## 逐条判据与它改坏哪里会红
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 两次调用 `JSON.stringify` 相同(= 默认参数) | 引入 `Math.random` / 时间 / 顺序不稳的 Map |
 * | 2 | 每个 `obj` 都在 `ITEM_BY_ID` 里(逐条)+ `why` 非空 | 写一个不存在的 id |
 * | 3 | 每条都在营地矩形内(`±12`) | 布局越界(压到广场外的草地) |
 * | 4 | 没有一条落在 8×8 大理石上 | 房子摆到广场圆心 |
 * | 5 | 与 `TOWN_RESERVED` 零交集(逐条) | **删掉 `planTown` 的 reserved 过滤** ⇒ 必红(见 14 的实证) |
 * | 6 | `TOWN_RESERVED` 逐格等于 `design.ts` 在营地里真盖的立牌 | 清单漏格/多格(它会变成"保护空气") |
 * | 7 | ≥ 4 座房子:实心 3×4 + 圈上恰一个门(363) + 圈上其余是墙/窗 + 内圈全屋顶件 + 门窗正对 | 墙圈缺口、门丢了、屋顶种到圈上 |
 * | 8 | 门开在贴街那一侧的墙上,且门外那一格是街轴且无立牌 | 门朝墙(开不出去) |
 * | 9 | 街:门只在 `x=87/89` 两列 + 街轴 `x=88` 零立牌(可走的走廊) | 房子摆到街轴上 ⇒ 街被自己堵死 |
 * | 10 | 市场角含 516 + 513,相邻,且在房屋以北(街北口) | 市场角被摆到别处 |
 * | 11 | `length <= TOWN_MAX_PLACEMENTS`,且上限自身有下界 48 / 上界 288 | 上限被调大到失去意义 |
 * | 12 | 坐标是无重复整数格 | 同一格压两件 / 小数坐标 |
 * | 13 | `townFootprint()` == 规划的包围盒,且在营地内 | 范围函数与规划漂移 |
 * | 14 | 街灯在 `y=106` 那一排**只剩东侧一盏**(西侧那格是既有 513 储物箱) | 剔除段失效(缺口被填上) |
 * | 15 | `half=6` 是默认规划的子集;`half=1` ⇒ 空数组(不抛) | 裁边语义变成"重排布局" |
 * | 16 | 平移到无人区(40,40):结构同样成立、不与既有地标相交、`TOWN_PLAZA_CENTER === DESIGN_CENTER` | 布局写死成绝对坐标 / 常量漂了 |
 *
 * ## 有牙实证(反向)
 *
 * 把 `planTown()` 里「(b) 既有地标」那一行删掉 ⇒ `FND191-5 与 TOWN_RESERVED 零交集`
 * 与 `FND191-14 剔口` 同时变红(实测见本轮汇报);还原后 16/16 通过。
 *
 * ## 本套件**证不了**的
 *
 * 证不了「看起来像一座房子」:没有渲染通道,只能证结构(墙圈/门/窗/屋顶在坐标上成立)。
 * 真正的体验验收要看截图(玩家屏幕上多出来的东西)。
 */

import {
  planTown, townFootprint, TOWN_RESERVED, TOWN_MAX_PLACEMENTS,
  TOWN_PLAZA_CENTER, TOWN_CAMP_HALF, type TownPlacement,
} from '../shared/world/town.ts';
import { applyWorldDesign, DESIGN_CENTER, DESIGN_SIZE, type DesignWriter } from '../shared/world/design.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { packTile, unpackTile } from '../shared/types/tile.ts';
import { eq, inRange, ok, report, test } from '../shared/testing/harness.ts';

/* ═══════════ 判据**自己**声明「房子由什么构成」(不引用被测常量的定义)═══════════
 *
 * 为什么在这里硬编码 id,而不是 import `town.ts` 的私有 id 常量:
 * 那样写就是同义反复 —— 实现把门改成一面墙,判据跟着改,永远绿。
 * 这里写的是「一座房子应当由哪些件组成」这条**独立**的契约。 */

/** 墙圈允许的件:351 暖松原木圆墙 / 352 复古红砖承重墙。 */
const WALL_IDS: readonly number[] = [351, 352];
/** 墙上允许的窗:370 暖阳木框观景窗(带 `墙体` tag,"嵌入墙体中")。 */
const WINDOW_IDS: readonly number[] = [370];
/** 门:363 温馨圆拱小木门(1×1)/ 364 迎宾双开雕花门(2×1,本规划未用 —— 会在圈上留两个门格)。 */
const DOOR_IDS: readonly number[] = [363, 364];
/** 屋顶件:372 暖红陶瓦斜屋顶 / 373 森林茅草厚屋顶 / 384 屋顶炊烟小烟囱(带 `屋顶` tag)。 */
const ROOF_IDS: readonly number[] = [372, 373, 384];
/** 房子占地里允许出现的全部件。 */
const BUILDING_IDS: readonly number[] = [...WALL_IDS, ...WINDOW_IDS, ...DOOR_IDS, ...ROOF_IDS];

/** 市场角两件(任务板 / 储物箱)。 */
const BOARD_ID = 516;
const CHEST_ID = 513;
/** 街灯。 */
const LAMP_ID = 522;

/** 街轴列(x)—— 西侧房屋门在 87、东侧在 89 ⇒ 中间那一列就是街。 */
const STREET_X = DESIGN_CENTER - 8;
/** 街西/街东的**门面列**(判据 9 用它证明"两侧各一列门面")。 */
const FACADE_WEST_X = DESIGN_CENTER - 9;
const FACADE_EAST_X = DESIGN_CENTER - 7;
/** 营地矩形(与 `design.ts` 的 `campHalf = 12` 同口径:`[c−12, c+11]`)。 */
const CAMP = {
  x0: DESIGN_CENTER - TOWN_CAMP_HALF, y0: DESIGN_CENTER - TOWN_CAMP_HALF,
  x1: DESIGN_CENTER + TOWN_CAMP_HALF - 1, y1: DESIGN_CENTER + TOWN_CAMP_HALF - 1,
};
/** 广场中心 8×8 大理石(`design.ts` 4.3 的第二个循环:`[c−4, c+3]`)。 */
const MARBLE = {
  x0: DESIGN_CENTER - 4, y0: DESIGN_CENTER - 4,
  x1: DESIGN_CENTER + 3, y1: DESIGN_CENTER + 3,
};

/** 一格坐标 → 稳定键(判据里到处用它做集合运算)。 */
function cls(x: number, y: number): string {
  return `${x},${y}`;
}

/** 默认规划(所有判据都读它)。 */
const plan = planTown();

/* ─────────── 内存桩:把 `design.ts` 盖一遍,反查「营地里既有的立牌」 ─────────── */

const size = DESIGN_SIZE;
const tiles = new Int32Array(size * size).fill(-1);
const stub: DesignWriter = {
  sizeCells: size,
  setCell(x: number, y: number, fields): void {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * size + x;
    const cur = tiles[i] === -1
      ? { elev: 0, base: 0, floor: 0, wire: 0, obj: 0, meta: 0 }
      : unpackTile(tiles[i]!);
    tiles[i] = packTile({ ...cur, ...fields });
  },
  fillRect(x0, y0, x1, y1, fields): number {
    let n = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) { this.setCell(x, y, fields); n += 1; }
    }
    return n;
  },
};
applyWorldDesign(stub, { size });

/** 设计图在营地里真实盖下的立牌格(既有地标)。 */
function designedObjCellsInCamp(): string[] {
  const out: string[] = [];
  for (let y = CAMP.y0; y <= CAMP.y1; y += 1) {
    for (let x = CAMP.x0; x <= CAMP.x1; x += 1) {
      if (unpackTile(tiles[y * size + x]!).obj !== 0) out.push(cls(x, y));
    }
  }
  return out.sort();
}

/* ═══════════ 结构检查器:按坐标把「房子」连通域拆出来(判据 7/8/16 共用)═══════════ */

interface HouseShape {
  x0: number; y0: number; x1: number; y1: number;
  /** 占地全部格(升序)。 */
  cells: TownPlacement[];
  /** 墙圈(占地外圈)。 */
  ring: TownPlacement[];
  /** 内圈(被墙圈围住的格 = 屋顶行)。 */
  interior: TownPlacement[];
}

/**
 * 把规划里的**建筑件**按 4-邻接连通域切开 ⇒ 每个连通域 = 一座房子。
 *
 * ⚠️ 这是"按坐标验算"而不是"数个数":连通域的形状/边框/内圈全部由坐标算出,
 * 缺一格、多一格、墙圈被灯串起来都会改变结果。
 */
function housesOf(p: readonly TownPlacement[]): HouseShape[] {
  const at = new Map<string, TownPlacement>();
  const building = p.filter((q) => BUILDING_IDS.includes(q.obj));
  for (const q of building) at.set(cls(q.x, q.y), q);

  const seen = new Set<string>();
  const out: HouseShape[] = [];
  const steps: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const start of building) {
    if (seen.has(cls(start.x, start.y))) continue;
    seen.add(cls(start.x, start.y));
    const stack: TownPlacement[] = [start];
    const cells: TownPlacement[] = [];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      cells.push(cur);
      for (const s of steps) {
        const k = cls(cur.x + s[0], cur.y + s[1]);
        const nxt = at.get(k);
        if (nxt === undefined || seen.has(k)) continue;
        seen.add(k);
        stack.push(nxt);
      }
    }
    cells.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const x0 = Math.min(...cells.map((c) => c.x));
    const x1 = Math.max(...cells.map((c) => c.x));
    const y0 = Math.min(...cells.map((c) => c.y));
    const y1 = Math.max(...cells.map((c) => c.y));
    const onRing = (c: TownPlacement): boolean => c.x === x0 || c.x === x1 || c.y === y0 || c.y === y1;
    out.push({
      x0, y0, x1, y1, cells,
      ring: cells.filter(onRing),
      interior: cells.filter((c) => !onRing(c)),
    });
  }
  return out;
}

/** 判据 7:房子结构。返回连通域,供 8/9/10/16 复用。 */
function checkHouseStructure(label: string, p: readonly TownPlacement[]): HouseShape[] {
  const houses = housesOf(p);
  ok(houses.length >= 4, `${label}:至少要 4 座房子(矩形墙圈),实际 ${houses.length} 座`);
  for (const h of houses) {
    const w = h.x1 - h.x0 + 1;
    const hh = h.y1 - h.y0 + 1;
    const where = `屋(${h.x0},${h.y0})~(${h.x1},${h.y1})`;
    eq(h.cells.length, w * hh, `${label} ${where} 占地必须是**实心**矩形(每一格都有件);缺口 = 房子丢了构件`);
    eq(w, 3, `${label} ${where} 宽`);
    eq(hh, 4, `${label} ${where} 高`);
    eq(h.ring.length, 2 * w + 2 * hh - 4, `${label} ${where} 墙圈格数`);

    /* 圈上恰好一个门 —— 这一条就是「有一个朝街的缺口当门」。 */
    const doors = h.ring.filter((c) => DOOR_IDS.includes(c.obj));
    eq(doors.length, 1, `${label} ${where} 墙圈上必须**恰好**一个门(363/364),实际 ${doors.length} 个`);
    const door = doors[0];
    for (const c of h.ring) {
      if (DOOR_IDS.includes(c.obj)) continue;
      ok(WALL_IDS.includes(c.obj) || WINDOW_IDS.includes(c.obj),
        `${label} ${where} 圈上除了那一个门,只允许墙(351/352)或窗(370);(${c.x},${c.y}) 是 ${c.obj}`);
    }
    /* 圈上恰好一扇窗,且**正对着门**(在对面那面墙上、同一行)。 */
    const wins = h.ring.filter((c) => WINDOW_IDS.includes(c.obj));
    eq(wins.length, 1, `${label} ${where} 墙圈上应有一扇窗(370),实际 ${wins.length} 扇`);
    const win = wins[0];
    eq(win.y, door.y, `${label} ${where} 窗必须与门同一行(正对)`);
    ok((win.x === h.x0 && door.x === h.x1) || (win.x === h.x1 && door.x === h.x0),
      `${label} ${where} 窗必须在门的**对面**那面墙上(窗 x=${win.x} / 门 x=${door.x})`);
    /* 内圈全是屋顶件。 */
    eq(h.interior.length, w * hh - (2 * w + 2 * hh - 4), `${label} ${where} 内圈格数`);
    ok(h.interior.length >= 1, `${label} ${where} 内圈必须有屋顶行`);
    for (const c of h.interior) {
      ok(ROOF_IDS.includes(c.obj),
        `${label} ${where} 内圈只允许屋顶件(372/373/384);(${c.x},${c.y}) 是 ${c.obj}`);
    }
  }
  return houses;
}

/* ═══════════════════════════ 1 确定性 ═══════════════════════════ */

test('FND191-1 确定性:两次调用逐字节相同,且默认参数 = 显式默认', () => {
  const a = planTown();
  const b = planTown();
  eq(JSON.stringify(a), JSON.stringify(b), '两次 planTown() 必须完全相同(无 Math.random / 无时间)');
  eq(JSON.stringify(planTown(undefined)), JSON.stringify(a), 'planTown(undefined) = 默认');
  eq(
    JSON.stringify(planTown({ center: { x: DESIGN_CENTER, y: DESIGN_CENTER }, half: TOWN_CAMP_HALF })),
    JSON.stringify(a),
    '显式传默认值必须与不传相同',
  );
  ok(a.length > 0, '默认规划不能为空');
});

/* ═══════════════════════════ 2 内容 id 真实存在 ═══════════════════════════ */

test('FND191-2 每个 obj 都在 ITEM_BY_ID 里(逐条),且 why 非空', () => {
  for (const p of plan) {
    const def = ITEM_BY_ID.get(p.obj);
    ok(def !== undefined, `(${p.x},${p.y}) 的 obj=${p.obj} 不在 shared/constants/items.ts 里`);
    ok(p.why.length > 0, `(${p.x},${p.y}) 的 why 不能为空 —— 规划必须说清为什么摆在这里`);
  }
  /* 用到的 id 集合 = 城镇的"构件清单":出现新 id 就得在这里登记(它是有意为之还是漏改)。 */
  const used = [...new Set(plan.map((p) => p.obj))].sort((x, y) => x - y);
  eq(used, [
    351, 352, 363, 370, 372, 373, 384, 513, 516, 522,
  ], '城镇用到的物品 id 集合(墙/窗/门/屋顶/烟囱/储物箱/任务板/路灯)');
});

/* ═══════════════════════════ 3 营地矩形内 ═══════════════════════════ */

test('FND191-3 每条都在营地矩形内(|x−96| ≤ 12 且 |y−96| ≤ 12)', () => {
  ok(plan.length > 0, '规划不能为空');
  for (const p of plan) {
    ok(Math.abs(p.x - DESIGN_CENTER) <= TOWN_CAMP_HALF, `(${p.x},${p.y}) 的 x 超出营地(|x−96| > 12)`);
    ok(Math.abs(p.y - DESIGN_CENTER) <= TOWN_CAMP_HALF, `(${p.x},${p.y}) 的 y 超出营地(|y−96| > 12)`);
    inRange(p.x, CAMP.x0, CAMP.x1, `(${p.x},${p.y}) 的 x 超出营地矩形 `);
    inRange(p.y, CAMP.y0, CAMP.y1, `(${p.x},${p.y}) 的 y 超出营地矩形 `);
  }
});

/* ═══════════════════════════ 4 不压广场中心大理石 ═══════════════════════════ */

test('FND191-4 没有一条落在广场中心 8×8 大理石上(两种口径都判)', () => {
  for (const p of plan) {
    ok(!(Math.abs(p.x - DESIGN_CENTER) < 4 && Math.abs(p.y - DESIGN_CENTER) < 4),
      `(${p.x},${p.y}) 落在广场中心(|dx|<4 && |dy|<4)`);
    ok(!(p.x >= MARBLE.x0 && p.x <= MARBLE.x1 && p.y >= MARBLE.y0 && p.y <= MARBLE.y1),
      `(${p.x},${p.y}) 落在 design.ts 实际铺的大理石 ${MARBLE.x0}..${MARBLE.x1} 上`);
  }
});

/* ═══════════════════════════ 5 与既有地标零交集 ═══════════════════════════ */

test('FND191-5 与 TOWN_RESERVED 零交集(逐条)', () => {
  ok(TOWN_RESERVED.length > 0, 'TOWN_RESERVED 不能是空表(否则这条判据保护的是空气)');
  const reserved = new Set(TOWN_RESERVED.map((r) => cls(r.x, r.y)));
  for (const p of plan) {
    ok(!reserved.has(cls(p.x, p.y)),
      `(${p.x},${p.y}) obj=${p.obj} 与既有地标撞格 —— 会盖掉 design.ts 的 LANDMARKS`);
  }
});

/* ═══════════════════════════ 6 TOWN_RESERVED 与设计图逐格一致 ═══════════════════════════ */

test('FND191-6 TOWN_RESERVED 逐格等于 design.ts 在营地里真盖的立牌', () => {
  /* ★ w98:设计图现在**也**盖城镇(`design.ts` 在 `LANDMARKS` 之后调 `planTown()`),
     所以「design.ts 在营地里真盖的立牌」= 地标 + 城镇。本判据要验的是**地标那一份**,
     ⇒ 把城镇自己的格减掉。不减的话,「接线成功」会被误判成「TOWN_RESERVED 漏保护」。 */
  const townOwn = new Set(plan.map((p) => cls(p.x, p.y)));
  const designed = designedObjCellsInCamp().filter((k) => !townOwn.has(k));
  const declared = TOWN_RESERVED.map((r) => cls(r.x, r.y)).sort();
  eq(declared, designed,
    'TOWN_RESERVED 必须与 design.ts 的 LANDMARKS 在营地内的实际格**逐格相同**;少一格 = 漏保护,多一格 = 白占地方');
  /* 反向:默认规划不得出现任何设计图已占的格(与判据 5 同义,但从"设计图真值"这一侧再算一遍)。 */
  const occupied = new Set(designed);
  for (const p of plan) ok(!occupied.has(cls(p.x, p.y)), `(${p.x},${p.y}) 压在既有立牌上`);
});

/* ═══════════════════════════ 7 房子结构 ═══════════════════════════ */

test('FND191-7 每座房子结构成立:实心 3×4 + 圈上恰一门 + 内圈屋顶行', () => {
  const houses = checkHouseStructure('默认营地', plan);
  eq(houses.length, 6, '街道两侧各 3 座 —— 连通域应恰好 6 座(每座 3×4)');
  /* 两排材质要真的不同:否则"北排红砖 / 中南北排原木"只是注释。 */
  const wallSets = houses.map((h) => [...new Set(h.ring.filter((c) => WALL_IDS.includes(c.obj)).map((c) => c.obj))].sort());
  const brick = wallSets.filter((s) => eq0(s, [352])).length;
  const wood = wallSets.filter((s) => eq0(s, [351])).length;
  eq(brick, 2, '北排两座用 352 复古红砖承重墙');
  eq(wood, 4, '中/南排四座用 351 暖松原木圆墙');
});

/** 小工具:数组是否等于 `want`(仅本文件内部用,错误信息由调用处给)。 */
function eq0(got: readonly number[], want: readonly number[]): boolean {
  return got.length === want.length && got.every((v, i) => v === want[i]);
}

/* ═══════════════════════════ 8 门朝街 ═══════════════════════════ */

test('FND191-8 门开在贴街那一侧的墙上,门外那一格是街且无立牌', () => {
  const houses = checkHouseStructure('门朝街', plan);
  const solid = new Set(plan.map((p) => cls(p.x, p.y)));
  for (const h of houses) {
    const door = h.ring.filter((c) => DOOR_IDS.includes(c.obj))[0];
    ok(door.x === h.x1 || door.x === h.x0,
      `屋(${h.x0},${h.y0}) 的门 (${door.x},${door.y}) 不在贴街的墙列上(应贴 x=${h.x0} 或 x=${h.x1})`);
    const outX = door.x === h.x1 ? door.x + 1 : door.x - 1;
    eq(outX, STREET_X, `屋(${h.x0},${h.y0}) 门外那一格应落在街轴 x=${STREET_X},实际 ${outX}`);
    ok(!solid.has(cls(outX, door.y)), `门外那一格 (${outX},${door.y}) 不能有立牌 —— 门要开得出去`);
  }
});

/* ═══════════════════════════ 9 街 ═══════════════════════════ */

test('FND191-9 街成立:两侧各一列门面 + 街轴零立牌(可走的走廊)', () => {
  const doors = plan.filter((p) => DOOR_IDS.includes(p.obj));
  ok(doors.length >= 4, `门上至少 4 个(≥4 座房子),实际 ${doors.length}`);
  const cols = [...new Set(doors.map((d) => d.x))].sort((a, b) => a - b);
  eq(cols, [FACADE_WEST_X, FACADE_EAST_X],
    `门只应出现在街西(x=${FACADE_WEST_X})与街东(x=${FACADE_EAST_X})两列门面`);
  ok(doors.some((d) => d.x === FACADE_WEST_X) && doors.some((d) => d.x === FACADE_EAST_X),
    '街的两侧各要有房屋门面(不能只有一边)');
  /* 街轴:两侧门面之间那一列必须**零立牌**,否则街被自己的规划堵死。 */
  const onAxis = plan.filter((p) => p.x === STREET_X);
  eq(onAxis.length, 0, `街轴 x=${STREET_X} 上不能有立牌,实际 ${onAxis.length} 条:`
    + onAxis.slice(0, 4).map((p) => `(${p.x},${p.y})=${p.obj}`).join(' '));
});

/* ═══════════════════════════ 10 市场角 ═══════════════════════════ */

test('FND191-10 市场角含 516 任务板与 513 储物箱,相邻且在街北口', () => {
  const board = plan.filter((p) => p.obj === BOARD_ID);
  const chest = plan.filter((p) => p.obj === CHEST_ID);
  eq(board.length, 1, `市场角应有 1 块 ${BOARD_ID} 任务板`);
  eq(chest.length, 1, `市场角应有 1 个 ${CHEST_ID} 储物箱`);
  const b = board[0];
  const c = chest[0];
  ok(Math.abs(b.x - c.x) <= 1 && Math.abs(b.y - c.y) <= 1,
    `任务板 (${b.x},${b.y}) 与储物箱 (${c.x},${c.y}) 必须挨着 —— "一个角"不能摊成两地`);
  const houses = housesOf(plan);
  const northMost = Math.min(...houses.map((h) => h.y0));
  ok(b.y < northMost && c.y < northMost,
    `市场角必须在房屋以北(街北口):房屋最北 y=${northMost},市场 y=${b.y}/${c.y}`);
  ok(Math.abs(b.x - STREET_X) <= 3 && Math.abs(c.x - STREET_X) <= 3,
    '市场角要挂在街口(离街轴 3 格内),不能飘到广场另一头');
  /* 市场角那一带的立牌必须认得出来(其它件只允许是街灯)。 */
  for (const p of plan.filter((q) => q.y === b.y)) {
    ok(p.obj === BOARD_ID || p.obj === CHEST_ID || p.obj === LAMP_ID,
      `市场角那一行 (${p.x},${p.y}) 出现了非市场件 ${p.obj}`);
  }
});

/* ═══════════════════════════ 11 密度上限 ═══════════════════════════ */

test('FND191-11 密度上限:规划条数 ≤ TOWN_MAX_PLACEMENTS,且上限自身有上下界', () => {
  ok(plan.length <= TOWN_MAX_PLACEMENTS,
    `规划条数 ${plan.length} 超过上限 ${TOWN_MAX_PLACEMENTS}(每条 = 一个立牌实例)`);
  /* 上限必须有**下界**:至少要容得下 4 座房子(判据要的最少座数)× 12 条结构。 */
  ok(TOWN_MAX_PLACEMENTS >= 4 * 12, `上限 ${TOWN_MAX_PLACEMENTS} 太小:容不下 4 座房子(4×12)`);
  /* 上限必须有**上界**:营地 24×24 = 576 格,上限不许大到"把营地铺满"。 */
  const campCells = (CAMP.x1 - CAMP.x0 + 1) * (CAMP.y1 - CAMP.y0 + 1);
  ok(TOWN_MAX_PLACEMENTS <= campCells / 2,
    `上限 ${TOWN_MAX_PLACEMENTS} 已超过营地格数(${campCells})的一半 —— 那样的上限等于没有上限`);
  ok(plan.length >= 4 * 12, `规划只有 ${plan.length} 条:比 4 座房子的结构量还少`);
});

/* ═══════════════════════════ 12 无重复、整数格 ═══════════════════════════ */

test('FND191-12 坐标是无重复的整数格(同一格不能压两件)', () => {
  const keys = plan.map((p) => cls(p.x, p.y));
  eq(new Set(keys).size, keys.length, '同一格出现了两条规划(obj 层一格只能有一个 id)');
  for (const p of plan) {
    ok(Number.isInteger(p.x) && Number.isInteger(p.y), `(${p.x},${p.y}) 必须是整数格坐标`);
    ok(Number.isInteger(p.obj) && p.obj > 0, `(${p.x},${p.y}) 的 obj=${p.obj} 必须是正整数 id`);
  }
});

/* ═══════════════════════════ 13 townFootprint ═══════════════════════════ */

test('FND191-13 townFootprint() = 默认规划的包围盒,且在营地矩形内', () => {
  const fp = townFootprint();
  eq(fp.x0, Math.min(...plan.map((p) => p.x)), 'footprint.x0');
  eq(fp.y0, Math.min(...plan.map((p) => p.y)), 'footprint.y0');
  eq(fp.x1, Math.max(...plan.map((p) => p.x)), 'footprint.x1');
  eq(fp.y1, Math.max(...plan.map((p) => p.y)), 'footprint.y1');
  inRange(fp.x0, CAMP.x0, CAMP.x1, 'footprint.x0 在营地内 ');
  inRange(fp.x1, CAMP.x0, CAMP.x1, 'footprint.x1 在营地内 ');
  inRange(fp.y0, CAMP.y0, CAMP.y1, 'footprint.y0 在营地内 ');
  inRange(fp.y1, CAMP.y0, CAMP.y1, 'footprint.y1 在营地内 ');
  ok(fp.x1 >= fp.x0 && fp.y1 >= fp.y0, 'footprint 必须是正常区间(x0 ≤ x1)');
  /* 城镇是**西半**的一座镇:它的东边界不许伸进大理石列。 */
  ok(fp.x1 < MARBLE.x0, `城镇东边界 ${fp.x1} 压到了大理石列(从 ${MARBLE.x0} 起)`);
});

/* ═══════════════════════════ 14 剔除断口(先算后剔的签名) ═══════════════════════════ */

test('FND191-14 街灯在既有地标处断裂(y=106 那一排只剩东侧一盏)', () => {
  const lamps = plan.filter((p) => p.obj === LAMP_ID);
  ok(lamps.length >= 6, `街灯太少(${lamps.length} 盏),街看不出是一条街`);
  /* 完整的灯排:街西列 + 街东列各一盏。 */
  const completeRows = [86, 91, 96, 101];
  for (const y of completeRows) {
    const row = lamps.filter((l) => l.y === y).map((l) => l.x).sort((a, b) => a - b);
    eq(row, [FACADE_WEST_X, FACADE_EAST_X], `y=${y} 这一排应有两盏街灯(街西/街东)`);
  }
  /* 断口:y=106 与既有「加工一条街」同一行 ⇒ 西侧那格是 513 储物箱,那一盏灯被剔除。 */
  const south = lamps.filter((l) => l.y === 106).map((l) => l.x).sort((a, b) => a - b);
  eq(south, [FACADE_EAST_X],
    `街南口(y=106)应只剩东侧一盏 —— 西侧 (${FACADE_WEST_X},106) 是既有 513 储物箱,`
    + '那一盏被"先算后剔"剔掉;如果这里是两盏,说明剔除段失效(撞上了既有地标)');
  ok(TOWN_RESERVED.some((r) => r.x === FACADE_WEST_X && r.y === 106),
    `TOWN_RESERVED 里必须有 (${FACADE_WEST_X},106) —— 这才是上一条断口的成因,否则断口无从解释`);
  ok(!lamps.some((l) => l.y === 106 && l.x === FACADE_WEST_X), '被剔除的那一格不能被"挪一格"补回来');
});

/* ═══════════════════════════ 15 裁边语义 ═══════════════════════════ */

test('FND191-15 裁边:小 half 只按坐标剔格(不重排布局),half=1 ⇒ 空且不抛', () => {
  const small = planTown({ half: 6 });
  ok(small.length > 0, 'half=6 也要留下东西(它仍覆盖广场中心一带)');
  for (const p of small) {
    inRange(p.x, DESIGN_CENTER - 6, DESIGN_CENTER + 5, `(x,y)=(${p.x},${p.y}) 超出 half=6 的 allowed 区 x `);
    inRange(p.y, DESIGN_CENTER - 6, DESIGN_CENTER + 5, `(x,y)=(${p.x},${p.y}) 超出 half=6 的 allowed 区 y `);
  }
  const big = new Set(plan.map((p) => cls(p.x, p.y)));
  for (const p of small) {
    ok(big.has(cls(p.x, p.y)), `裁边必须是"从大规划里剔格",(${p.x},${p.y}) 不在默认规划里 ⇒ 布局被重排了`);
  }
  ok(small.length < plan.length, '裁边后条数应变少');
  eq(planTown({ half: 1 }).length, 0, 'half=1 时整个 allowed 区被广场中心大理石吃掉 ⇒ 空规划(而不是抛异常)');
});

/* ═══════════════════════════ 16 平移中心 + 常量钉住 ═══════════════════════════ */

test('FND191-16 平移到无人区:结构同样成立、不压既有地标;TOWN_PLAZA_CENTER = DESIGN_CENTER', () => {
  eq(TOWN_PLAZA_CENTER, DESIGN_CENTER,
    'TOWN_PLAZA_CENTER 必须与 design.ts 的 DESIGN_CENTER 同值(两份各写一处,由这条钉住)');
  eq(TOWN_CAMP_HALF * 2, 24, '营地矩形 24×24(与 design.ts 的 campHalf=12 同口径)');

  const moved = planTown({ center: { x: 40, y: 40 } });
  checkHouseStructure('平移中心(40,40)', moved);
  const reserved = new Set(TOWN_RESERVED.map((r) => cls(r.x, r.y)));
  for (const p of moved) {
    ok(!reserved.has(cls(p.x, p.y)), `平移后 (${p.x},${p.y}) 仍不得压在既有地标上`);
    inRange(p.x, 28, 51, '平移后 x 应在 [40−12, 40+11] ');
    inRange(p.y, 28, 51, '平移后 y 应在 [40−12, 40+11] ');
    ok(!(p.x >= 36 && p.x <= 43 && p.y >= 36 && p.y <= 43),
      `平移后 (${p.x},${p.y}) 落在(跟着广场走的)中心大理石上`);
  }
  /* 默认营地里 (87,106) 那盏灯被既有 513 储物箱剔掉;挪到无人区就没人跟它抢 ⇒ 正好多一条。 */
  eq(moved.length, plan.length + 1,
    '平移后条数应比默认多 1:默认少的那条正是被既有地标剔掉的街南口西侧路灯');
});

report('WS-FND-191');
