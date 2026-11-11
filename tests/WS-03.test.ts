/**
 * WS-03 验收测试:Auto-Tile、BFS 闭合房间、9 种动态房间配方、208 蓝图卷轴、飞砖接力。
 *
 * 运行:`node tests/WS-03.test.ts`(或 `node scripts/verify.ts --only WS-03`)
 * 零依赖,仅用 `shared/testing/harness.ts` 与 `node:*`。
 */

import { eq, near, ok, report, test, includes } from '../shared/testing/harness.ts';
import { packTile, unpackTile, setWire, WireColor } from '../shared/types/tile.ts';
import { ITEM_BY_ID, itemName } from '../shared/constants/items.ts';
import { ROOM_RECIPES } from '../shared/constants/bosses.ts';

import { TileGrid } from '../server/src/build/grid.ts';
import {
  AutoTileKind,
  DEFAULT_AUTOTILE_CONFIG,
  autoTileAll,
  canTraverse,
  classifyMask,
  isAutoTileable,
  isBarrier,
  maskOf,
  resolveAutoTile,
  resolveRotation,
  sampleMask,
  BRIDGE_IDS,
  EDGE_GUARD_IDS,
  HIGH_LOW_IDS,
  ONE_WAY_IDS,
  STAIR_IDS,
  WALL_IDS,
  DOOR_IDS,
} from '../server/src/build/autotile.ts';
import {
  ALL_REQUIRED_IDS,
  DEFAULT_SCAN_OPTIONS,
  NORMALIZED_RECIPES,
  RoomRejectReason,
  floodRoom,
  identifyAllRooms,
  identifyRoom,
  isRecognizable,
  placeInRoom,
  punchHole,
  scanRooms,
  scoreRoom,
  stampBoxRoom,
} from '../server/src/build/rooms.ts';
import {
  BLUEPRINT_CELLS,
  BLUEPRINT_SIZE,
  RelayQueue,
  RelayTaskState,
  blueprintCode,
  blueprintSolidCells,
  buildRelayQueue,
  captureBlueprint,
  decodeBlueprint,
  encodeBlueprint,
  expandMaterials,
  flightDurationMs,
  floorItemId,
  relayWorkload,
} from '../server/src/build/blueprint.ts';
import {
  buildWireView,
  danglingEnds,
  serializeWireView,
  canLayWire,
  LayWireResult,
  wireCellAt,
  WIRE_LABEL,
} from '../server/src/build/wiring_view.ts';

/* ══════════════════ 公共夹具 ══════════════════ */

const WALL = 352; /* 复古红砖承重墙 */
const FLOOR = 6;  /* 地砖 ID,映射到物品 306 */

/** 造一间 7×7 小屋(内部 5×5 = 25 格)。返回网格与锚点。 */
function makeHouse(opts: {
  w?: number;
  h?: number;
  doorCols?: number[];
  punchAt?: { x: number; y: number };
  punchList?: { x: number; y: number }[];
  items?: { x: number; y: number; id: number }[];
} = {}): { grid: TileGrid; ax: number; ay: number; room: ReturnType<typeof floodRoom> } {
  const w = opts.w ?? 7;
  const h = opts.h ?? 7;
  const grid = new TileGrid(24, 24);
  stampBoxRoom(grid, {
    x: 2,
    y: 2,
    w,
    h,
    wallId: WALL,
    floorId: FLOOR,
    doorAtCol: opts.doorCols && opts.doorCols.length > 0 ? opts.doorCols[0] : -1,
    extraDoorAtCols: opts.doorCols ? opts.doorCols.slice(1) : [],
  });
  if (opts.punchAt) punchHole(grid, opts.punchAt.x, opts.punchAt.y);
  for (const p of opts.punchList ?? []) punchHole(grid, p.x, p.y);
  for (const it of opts.items ?? []) placeInRoom(grid, it.x, it.y, it.id);
  const ax = 3;
  const ay = 3;
  return { grid, ax, ay, room: floodRoom(grid, ax, ay, DEFAULT_SCAN_OPTIONS) };
}

/** 在 7×7 小屋内部摆好一组物品(按行优先依次落位)。 */
function houseWith(items: readonly number[]): ReturnType<typeof floodRoom> {
  const slots: { x: number; y: number; id: number }[] = [];
  const inner = 5;
  for (let i = 0; i < items.length; i += 1) {
    slots.push({ x: 3 + (i % inner), y: 3 + Math.floor(i / inner), id: items[i] });
  }
  return makeHouse({ items: slots }).room;
}

/* ══════════════════ 1. Auto-Tile:穷举 16 种掩码 ══════════════════ */

/** 期望分类表:下标即掩码,值即分类。 */
const EXPECTED_KIND: readonly AutoTileKind[] = [
  AutoTileKind.NONE,      /* 0  ---- */
  AutoTileKind.END,       /* 1  N--- */
  AutoTileKind.END,       /* 2  -E-- */
  AutoTileKind.CORNER,    /* 3  NE-- */
  AutoTileKind.END,       /* 4  --S- */
  AutoTileKind.STRAIGHT,  /* 5  N-S- */
  AutoTileKind.CORNER,    /* 6  -ES- */
  AutoTileKind.TEE,       /* 7  NES- */
  AutoTileKind.END,       /* 8  ---W */
  AutoTileKind.CORNER,    /* 9  N--W */
  AutoTileKind.STRAIGHT,  /* 10 -E-W */
  AutoTileKind.TEE,       /* 11 NE-W */
  AutoTileKind.CORNER,    /* 12 --SW */
  AutoTileKind.TEE,       /* 13 N-SW */
  AutoTileKind.TEE,       /* 14 -ESW */
  AutoTileKind.CROSS,     /* 15 NESW */
];

test('WT-03-01 穷举 16 种邻接掩码 → 分类逐项正确', () => {
  for (let m = 0; m < 16; m += 1) {
    eq(classifyMask(m), EXPECTED_KIND[m], `掩码 ${m.toString(2).padStart(4, '0')} 分类不符:`);
  }
});

test('WT-03-02 穷举 16 种掩码 → 邻居数与分类自洽', () => {
  for (let m = 0; m < 16; m += 1) {
    let bits = 0;
    for (let b = 0; b < 4; b += 1) if ((m & (1 << b)) !== 0) bits += 1;
    const kind = classifyMask(m);
    if (bits === 0) eq(kind, AutoTileKind.NONE, '0 邻接应为 NONE');
    else if (bits === 1) eq(kind, AutoTileKind.END, '1 邻接应为 END');
    else if (bits === 4) eq(kind, AutoTileKind.CROSS, '4 邻接应为 CROSS');
    else if (bits === 3) eq(kind, AutoTileKind.TEE, '3 邻接应为 TEE');
    else ok(kind === AutoTileKind.CORNER || kind === AutoTileKind.STRAIGHT, '2 邻接只能是 CORNER/STRAIGHT');
  }
});

test('WT-03-03 四向转角自动拼接:旋转量正确且四向转角各一', () => {
  eq(resolveRotation(maskOf(true, true, false, false)), 0, '北+东 = 0 号转角');
  eq(resolveRotation(maskOf(false, true, true, false)), 1, '东+南 = 1 号转角');
  eq(resolveRotation(maskOf(false, false, true, true)), 2, '南+西 = 2 号转角');
  eq(resolveRotation(maskOf(true, false, false, true)), 3, '西+北 = 3 号转角');
  const rots = new Set([
    resolveRotation(maskOf(true, true, false, false)),
    resolveRotation(maskOf(false, true, true, false)),
    resolveRotation(maskOf(false, false, true, true)),
    resolveRotation(maskOf(true, false, false, true)),
  ]);
  eq(rots.size, 4, '四个转角应映射到四个不同旋转量');
});

test('WT-03-04 直墙两种朝向:南北 0 号、东西 1 号', () => {
  eq(resolveRotation(maskOf(true, false, true, false)), 0, '南北直墙 rotation=0');
  eq(resolveRotation(maskOf(false, true, false, true)), 1, '东西直墙 rotation=1');
  eq(resolveRotation(0), 0, 'NONE 无旋转');
  eq(resolveRotation(0b1111), 0, 'CROSS 无旋转');
});

test('WT-03-05 精灵索引表可配:默认恒等,转角变体按旋转偏移', () => {
  const r = resolveAutoTile(maskOf(true, true, false, false));
  eq(r.spriteIndex, 3 + 0, '掩码 3 转角、rotation=0 → 精灵 3');
  const r2 = resolveAutoTile(maskOf(false, true, true, false));
  eq(r2.spriteIndex, 6 + 1, '掩码 6 转角、rotation=1 → 精灵 7');
  const custom = { spriteTable: Array.from({ length: 16 }, (_v, i) => 100 + i), cornerVariants: 4, straightVariants: 2 };
  eq(resolveAutoTile(3, custom).spriteIndex, 103, '自定义表:转角基址 103');
  eq(resolveAutoTile(6, custom).spriteIndex, 107, '自定义表:转角 106 + 旋转 1 = 107');
});

test('WT-03-06 稀疏网格采样:越界邻居一律不连接(边界墙不外连)', () => {
  const g = new TileGrid(3, 3);
  g.setObj(0, 0, WALL);
  g.setObj(1, 0, WALL);
  const mCorner = sampleMask(g, 0, 0, () => true);
  eq(mCorner, maskOf(false, true, false, false), '角落墙只有东方邻居');
  const mEdge = sampleMask(g, 1, 0, () => true);
  eq(mEdge, maskOf(false, false, false, true), '边缘墙只有西方邻居');
});

test('WT-03-07 整图 Auto-Tile:一行墙体掩码与分类逐格正确', () => {
  const g = new TileGrid(10, 6);
  for (let x = 2; x <= 6; x += 1) g.setObj(x, 3, WALL);
  const cells = autoTileAll(g, () => true);
  eq(cells.length, 5, '应产出 5 个可拼接格');
  eq(cells[0].kind, AutoTileKind.END, '最左是端点');
  eq(cells[0].rotation, 1, '最左端点的邻居在东方 → rotation=1');
  eq(cells[0].connects.east, true, '最左端点只连东侧');
  eq(cells[4].kind, AutoTileKind.END, '最右是端点');
  eq(cells[4].rotation, 3, '最右端点的邻居在西方 → rotation=3');
  for (let i = 1; i <= 3; i += 1) {
    eq(cells[i].kind, AutoTileKind.STRAIGHT, `第 ${i} 格是直墙`);
    eq(cells[i].rotation, 1, `第 ${i} 格为东西向直墙`);
  }
});

test('WT-03-07b 垂直墙体:端点朝北/南,直墙为南北向', () => {
  const g = new TileGrid(6, 10);
  for (let y = 2; y <= 6; y += 1) g.setObj(3, y, WALL);
  const cells = autoTileAll(g, () => true);
  eq(cells.length, 5, '5 格垂墙');
  eq(cells[0].rotation, 2, '最上端点邻居在南方 → rotation=2');
  eq(cells[4].rotation, 0, '最下端点邻居在北方 → rotation=0');
  eq(cells[2].kind, AutoTileKind.STRAIGHT, '中间是直墙');
  eq(cells[2].rotation, 0, '南北直墙 rotation=0');
});

test('WT-03-08 十字路口墙体:中心判为 CROSS,四臂判为 TEE 或 END', () => {
  const g = new TileGrid(9, 9);
  g.setObj(4, 4, WALL);
  g.setObj(4, 3, WALL);
  g.setObj(4, 5, WALL);
  g.setObj(3, 4, WALL);
  g.setObj(5, 4, WALL);
  eq(resolveAutoTile(sampleMask(g, 4, 4, () => true)).kind, AutoTileKind.CROSS, '中心应为十字');
  eq(resolveAutoTile(sampleMask(g, 4, 3, () => true)).kind, AutoTileKind.END, '北臂端点是 END');
  eq(resolveAutoTile(sampleMask(g, 3, 4, () => true)).kind, AutoTileKind.END, '西臂端点是 END');
});

test('WT-03-09 可拼接构件集合覆盖 §3.6 墙体/窗/屋顶/栏杆', () => {
  for (const id of WALL_IDS) ok(isAutoTileable(id), `墙体 ${id} 应可拼接`);
  for (const id of [370, 371, 372, 373, 374, 375, 376, 380, 381, 383, 385]) {
    ok(isAutoTileable(id), `构件 ${id} 应可拼接`);
  }
  ok(!isAutoTileable(377), '阶梯 377 不参与拼接');
  ok(!isAutoTileable(382), '滑索 382 不参与拼接');
  ok(!isAutoTileable(401), '电路件 401 不参与拼接');
});

/* ══════════════════ 2. §3.6 高低差走位 377~385 ══════════════════ */

test('WT-03-10 阶梯 377/378 允许 Z↔Z+1,跨 2 级拒绝', () => {
  for (const id of STAIR_IDS) {
    const up = canTraverse({ objId: id, fromElev: 0, toElev: 1, targetIsFluid: false, isPlayer: true });
    ok(up.allowed, `阶梯 ${id} 应可上行`);
    eq(up.resultElev, 1, '上行后海拔 +1');
    const down = canTraverse({ objId: id, fromElev: 2, toElev: 1, targetIsFluid: false, isPlayer: true });
    ok(down.allowed, `阶梯 ${id} 应可下行`);
  }
  const over = canTraverse({ objId: 377, fromElev: 0, toElev: 2, targetIsFluid: false, isPlayer: true });
  ok(!over.allowed, '跨 2 级应拒绝');
  eq(over.reason, 'STAIR_DZ_OVERFLOW', '拒绝原因应为 STAIR_DZ_OVERFLOW');
});

test('WT-03-11 吊桥 380 / 拱桥 381 跨流体且海拔不变', () => {
  for (const id of BRIDGE_IDS) {
    const r = canTraverse({ objId: id, fromElev: 1, toElev: 1, targetIsFluid: true, isPlayer: true });
    ok(r.allowed, `桥 ${id} 应可跨流体`);
    eq(r.resultElev, 1, '桥上海拔保持出发值');
    ok(r.speedMul > 0, '桥有正速度乘数');
  }
  eq(canTraverse({ objId: 380, fromElev: 1, toElev: 1, targetIsFluid: true, isPlayer: true }).speedMul, 0.9, '吊桥减速 0.9');
});

test('WT-03-12 滑索 382 只允许高→低,逆向与平层拒绝', () => {
  for (const id of ONE_WAY_IDS) {
    ok(canTraverse({ objId: id, fromElev: 2, toElev: 1, targetIsFluid: false, isPlayer: true }).allowed, '滑索应允许下行');
    const flat = canTraverse({ objId: id, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
    ok(!flat.allowed, '滑索不允许平层');
    eq(flat.reason, 'ZIPLINE_NEEDS_DROP', '拒绝原因 ZIPLINE_NEEDS_DROP');
    ok(!canTraverse({ objId: id, fromElev: 0, toElev: 1, targetIsFluid: false, isPlayer: true }).allowed, '滑索不允许上行');
  }
});

test('WT-03-13 护栏与烟囱不阻挡水平移动', () => {
  for (const id of EDGE_GUARD_IDS) {
    const r = canTraverse({ objId: id, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
    ok(r.allowed, `护栏 ${id} 不阻挡移动`);
    eq(r.reason, 'EDGE_GUARD', '护栏原因码');
  }
  const chimney = canTraverse({ objId: 384, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
  ok(chimney.allowed, '烟囱 384 为装饰,可穿过');
  eq(chimney.reason, 'CHIMNEY_DECOR', '烟囱原因码');
});

test('WT-03-14 墙体/关门阻挡玩家与怪物,暗道墙 362 只放行玩家', () => {
  const wall = canTraverse({ objId: 352, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
  ok(!wall.allowed, '承重墙应阻挡玩家');
  eq(wall.reason, 'BLOCKED_SOLID', '墙体拒绝原因');
  const door = canTraverse({ objId: 363, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
  ok(!door.allowed, '关闭的木门应阻挡玩家');
  const passPlayer = canTraverse({ objId: 362, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: true });
  ok(passPlayer.allowed, '暗道墙放行玩家');
  eq(passPlayer.reason, 'PASS_THROUGH', '暗道墙原因码');
  const passMob = canTraverse({ objId: 362, fromElev: 1, toElev: 1, targetIsFluid: false, isPlayer: false });
  ok(!passMob.allowed, '暗道墙不放行怪物');
});

test('WT-03-15 高低差构件清单恰为 377~385 九项', () => {
  eq(HIGH_LOW_IDS.length, 9, '高低差构件应为 9 项');
  eq(HIGH_LOW_IDS[0], 377, '起始 377');
  eq(HIGH_LOW_IDS[8], 385, '结束 385');
  for (const id of HIGH_LOW_IDS) ok(ITEM_BY_ID.has(id), `构件 ${id} 必须在冻结层配表中`);
});

/* ══════════════════ 3. BFS 闭合房间检测 ══════════════════ */

test('WT-03-16 完全闭合的 7×7 小屋被正确识别', () => {
  const { room } = makeHouse();
  ok(room.closed, '完全闭合应判为房间');
  eq(room.reject, RoomRejectReason.NONE, '无拒绝原因');
  eq(room.area, 25, '内部面积应为 5×5 = 25 格');
  eq(room.bbox.w, 5, '内部外接矩形宽 5(不含墙)');
  eq(room.bbox.h, 5, '内部外接矩形高 5(不含墙)');
  eq(room.outerBBox.w, 7, '含围合的外接矩形宽 7');
  eq(room.outerBBox.h, 7, '含围合的外接矩形高 7');
  eq(room.boundaryLeak, false, '不应触到世界边界');
  eq(room.wallCount, 24, '7×7 房间一圈应是 24 格墙(含四角)');
  near(room.fill, 1.0, 1e-9, '矩形房间的填充率应为 1');
});

test('WT-03-17 缺一个角(漏墙)被拒绝为 BOUNDARY_LEAK', () => {
  /* 7×7 外框 x,y ∈ [2,8];挖掉西墙紧贴西北角的那一格 (2,3) */
  const { room } = makeHouse({ punchAt: { x: 2, y: 3 } });
  ok(!room.closed, '漏墙不应判为闭合房间');
  eq(room.reject, RoomRejectReason.BOUNDARY_LEAK, '拒绝原因应为 BOUNDARY_LEAK');
  ok(room.boundaryLeak, '应标记 boundaryLeak');
  ok(room.area > 25, `漏墙后泛洪面积应超过 25,实际 ${room.area}`);
});

test('WT-03-17b 四角全缺的破屋被拒绝,三角形缺角同样拒绝', () => {
  const allFourCorners = makeHouse({
    punchList: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 2, y: 8 }, { x: 8, y: 8 }],
  });
  /* 仅四个角:四邻域泛洪仍被墙挡住,属于「视觉缺角但不漏」 */
  ok(allFourCorners.room.closed, '仅缺四个对角墙仍可围住(4 邻域语义)');
  /* 再挖一格正交相邻的墙 → 必然泄漏 */
  const leaky = makeHouse({
    punchList: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 2, y: 3 }],
  });
  ok(!leaky.room.closed, '正交墙体缺格后必须判为不闭合');
  eq(leaky.room.reject, RoomRejectReason.BOUNDARY_LEAK, '拒绝原因 BOUNDARY_LEAK');
});

test('WT-03-18 缺侧墙中间格同样被拒绝(非角落漏墙)', () => {
  const { room } = makeHouse({ punchAt: { x: 5, y: 2 } });
  ok(!room.closed, '侧墙开洞应判为不闭合');
  eq(room.reject, RoomRejectReason.BOUNDARY_LEAK, '拒绝原因 BOUNDARY_LEAK');
});

test('WT-03-19 有两扇门的小屋:门计入围合,仍识别为房间且 doorCount=2', () => {
  const { room } = makeHouse({ doorCols: [1, 3] });
  ok(room.closed, '门是围合构件,房间仍闭合');
  eq(room.doorCount, 2, '应统计到 2 扇门');
  eq(room.area, 25, '门不改变内部面积');
});

test('WT-03-20 面积超过 100 格上限 → AREA_OVERFLOW,上报面积钉死 101', () => {
  const g = new TileGrid(40, 40);
  /* 外框 22×22,内部 20×20 = 400 格 > 100 */
  stampBoxRoom(g, { x: 1, y: 1, w: 22, h: 22, wallId: WALL, floorId: FLOOR, doorAtCol: -1, extraDoorAtCols: [] });
  const room = floodRoom(g, 2, 2, DEFAULT_SCAN_OPTIONS);
  ok(!room.closed, '超大空间不应判为房间');
  eq(room.reject, RoomRejectReason.AREA_OVERFLOW, '拒绝原因 AREA_OVERFLOW');
  eq(room.area, DEFAULT_SCAN_OPTIONS.maxArea + 1, '上报面积应钉死在 101');
  eq(room.boundaryLeak, false, '围住的大房间不应标记为泄漏');
  ok(room.probedCells > room.area, `探测格数 ${room.probedCells} 应大于上报面积`);
  ok(room.probedCells <= DEFAULT_SCAN_OPTIONS.leakProbeCells + 1, '探测格数受 leakProbeCells 上界约束');
});

test('WT-03-20b 未围合的 400 格旷野 → BOUNDARY_LEAK,与 AREA_OVERFLOW 互斥', () => {
  const g = new TileGrid(40, 40);
  const room = floodRoom(g, 20, 20, DEFAULT_SCAN_OPTIONS);
  eq(room.reject, RoomRejectReason.BOUNDARY_LEAK, '无墙旷野应为 BOUNDARY_LEAK');
  eq(room.boundaryLeak, true, '应标记泄漏');
  ok(room.reject !== RoomRejectReason.AREA_OVERFLOW, '不得与 AREA_OVERFLOW 混淆');
  eq(room.wallCount, 0, '旷野里没有围合构件');
});

test('WT-03-21 锚点落在围合构件上 → ANCHOR_IS_BARRIER', () => {
  const { grid } = makeHouse();
  const room = floodRoom(grid, 2, 2, DEFAULT_SCAN_OPTIONS);
  eq(room.reject, RoomRejectReason.ANCHOR_IS_BARRIER, '锚点在墙上应直接拒绝');
  ok(!room.closed, '不得判为房间');
});

test('WT-03-22 细长走廊(长宽比 21:1)→ ASPECT_TOO_LONG', () => {
  const g = new TileGrid(30, 30);
  /* 1×21 内部:外框 3×23 */
  stampBoxRoom(g, { x: 1, y: 1, w: 3, h: 23, wallId: WALL, floorId: FLOOR, doorAtCol: -1, extraDoorAtCols: [] });
  const room = floodRoom(g, 2, 2, DEFAULT_SCAN_OPTIONS);
  ok(!room.closed, '细长走廊不应判为房间');
  eq(room.reject, RoomRejectReason.ASPECT_TOO_LONG, '拒绝原因 ASPECT_TOO_LONG');
});

test('WT-03-23 房间内部物体与地砖统计准确', () => {
  const room = houseWith([503, 504, 503]);
  eq(room.objects.get(503), 2, '物品 503 应记 2 件');
  eq(room.objects.get(504), 1, '物品 504 应记 1 件');
  eq(room.floorSet.size, 1, '只有 1 种地砖');
  ok(room.floorSet.has(FLOOR), `地砖集合应含 ${FLOOR}`);
});

test('WT-03-24 scanRooms 全场扫描:只产出 1 个闭合房间', () => {
  const { grid } = makeHouse();
  const rooms = scanRooms(grid, DEFAULT_SCAN_OPTIONS);
  const closed = rooms.filter((r) => r.closed);
  eq(closed.length, 1, '应恰好识别出 1 个闭合房间');
  eq(closed[0].area, 25, '该房间面积 25');
});

/* ══════════════════ 4. 9 种 ROOM_RECIPES 正例 + 反例 ══════════════════ */

test('WT-03-25 消费冻结层 ROOM_RECIPES:9 种配方全部读入且必需件非空', () => {
  eq(NORMALIZED_RECIPES.length, 9, 'ROOM_RECIPES 应为 9 种');
  eq(NORMALIZED_RECIPES.length, ROOM_RECIPES.length, '归一化后条数不变');
  for (const r of NORMALIZED_RECIPES) {
    ok(r.required.length >= 1, `配方 ${r.key} 必需件不应为空`);
    ok(r.name.length > 0, `配方 ${r.key} 应有名称`);
    for (const id of r.required) ok(ITEM_BY_ID.has(id), `${r.key} 必需件 ${id} 必须在配表中`);
    for (const id of r.optional) ok(ITEM_BY_ID.has(id), `${r.key} 可选件 ${id} 必须在配表中`);
  }
  ok(ALL_REQUIRED_IDS.length >= 9, '必需件并集应覆盖全部配方');
});

/* 9 组正例:只摆该配方的必需件,断言识别为它自己。 */
const POSITIVE_CASES: readonly { key: string; name: string; items: number[] }[] = NORMALIZED_RECIPES.map((r) => ({
  key: r.key,
  name: r.name,
  items: [...r.required],
}));

for (const c of POSITIVE_CASES) {
  test(`WT-03-26-${c.key} 正例:${c.name} 必需件齐备 → 识别成功`, () => {
    const room = houseWith(c.items);
    const id = identifyRoom(room);
    eq(id.key, c.key, `应识别为 ${c.key}`);
    eq(id.displayName, c.name, '房间名应取配方名');
    ok(id.score >= 100, `必需件满分档,得分应 ≥100,实际 ${id.score}`);
    const self = id.matches.find((m) => m.key === c.key);
    ok(self !== undefined, '应包含自身配方评分');
    ok(self!.matched, '自身配方必须 matched');
    eq(self!.missingRequired.length, 0, '不应有缺失必需件');
  });
}

/* 9 组反例:抽掉该配方的最后一个必需件,断言该配方 matched=false。 */
for (const c of NORMALIZED_RECIPES) {
  test(`WT-03-27-${c.key} 反例:${c.name} 缺必需件 → 拒绝识别`, () => {
    const partial = c.required.slice(0, -1);
    const room = houseWith(partial);
    const m = scoreRoom(room, c);
    ok(!m.matched, `${c.key} 缺件不应 matched`);
    includes(m.missingRequired, c.required[c.required.length - 1], '缺失清单应含被抽掉的必需件');
  });
}

test('WT-03-28 无可识别核心件的空房间 → key 为 null 且名为「未命名空间」', () => {
  const room = houseWith([]);
  const id = identifyRoom(room);
  eq(id.key, null, '空房间无法识别任何配方');
  eq(id.displayName, '未命名空间', '默认名');
  eq(id.score, 0, '分数为 0');
  eq(id.matches.length, 9, '仍应对 9 种配方全部评分');
  ok(id.matches.every((m) => !m.matched), '全部配方均应未命中');
});

test('WT-03-28b 未闭合房间不参与评分:matches 为空、key 为 null', () => {
  const { room } = makeHouse({ punchAt: { x: 2, y: 3 } });
  ok(!room.closed, '前提:该房间未闭合');
  eq(isRecognizable(room), false, 'isRecognizable 应返回 false');
  const id = identifyRoom(room);
  eq(id.key, null, '未闭合房间不得命中任何配方');
  eq(id.matches.length, 0, '未闭合房间不做任何配方评分');
  /* 即使内部摆满了某配方的必需件,也不得被识别 */
  const filled = houseWith([503, 504]);
  const brokenWithCore = makeHouse({
    punchAt: { x: 2, y: 3 },
    items: [{ x: 3, y: 3, id: 503 }, { x: 4, y: 3, id: 504 }],
  });
  ok(filled.closed, '对照组:闭合时应识别');
  eq(identifyRoom(filled).key, 'FORGE_MASTER', '对照组识别成功');
  eq(identifyRoom(brokenWithCore.room).key, null, '漏墙房间即使有核心件也不得识别');
});

test('WT-03-29 可选件加分:满分必需件下加可选件得分更高', () => {
  const base = identifyRoom(houseWith([503, 504]));
  const withOptional = identifyRoom(houseWith([503, 504, 155, 158]));
  ok(withOptional.score > base.score, `可选件应加分:${withOptional.score} > ${base.score}`);
  const self = withOptional.matches.find((m) => m.key === 'FORGE_MASTER')!;
  eq(self.hitOptional.length, 2, '应命中 2 个可选件');
  eq(self.score, 100 + 2 * 5 + 5 + 3, '100 + 10 可选 + 5 甜点区 + 3 围合');
});

test('WT-03-30 误判防护:另一配方的必需件不会命中本配方', () => {
  const room = houseWith([536, 537]);
  const forge = scoreRoom(room, NORMALIZED_RECIPES.find((r) => r.key === 'FORGE_MASTER')!);
  ok(!forge.matched, '炼金实验室的件不应命中大师锻造房');
  const id = identifyRoom(room);
  eq(id.key, 'ALCHEMY_LAB', '应正确识别为奇想炼金实验室');
});

test('WT-03-31 双配方竞争:摆两组必需件时取分数最高者,平手取配方顺序靠前者', () => {
  const room = houseWith([503, 504, 517]);
  const id = identifyRoom(room);
  ok(id.key === 'FORGE_MASTER' || id.key === 'COZY_BEDROOM', '应命中的两个候选之一');
  const a = id.matches.find((m) => m.key === 'FORGE_MASTER')!;
  const b = id.matches.find((m) => m.key === 'COZY_BEDROOM')!;
  ok(a.matched && b.matched, '两者都应 matched');
  if (a.score === b.score) eq(id.key, 'FORGE_MASTER', '平手时取配方顺序靠前者');
  else eq(id.key, a.score > b.score ? 'FORGE_MASTER' : 'COZY_BEDROOM', '取分数高者');
});

test('WT-03-32 identifyAllRooms:闭合房间才参与识别,漏墙房间被过滤', () => {
  const { grid } = makeHouse();
  const ids = identifyAllRooms(grid, DEFAULT_SCAN_OPTIONS);
  eq(ids.length, 1, '只有 1 个闭合房间参与识别');
  /* 挖掉西墙紧贴西北角的正交相邻格 → 真正的漏墙(仅挖对角墙角不会漏) */
  const broken = makeHouse({ punchAt: { x: 2, y: 3 } });
  ok(!broken.room.closed, '前提:该世界确实漏墙');
  eq(broken.room.reject, RoomRejectReason.BOUNDARY_LEAK, '前提:拒绝原因是 BOUNDARY_LEAK');
  const scanned = scanRooms(broken.grid, DEFAULT_SCAN_OPTIONS);
  ok(scanned.length >= 1, '扫描仍会产出候选(用于诊断与 UI 提示)');
  ok(scanned.every((r) => !isRecognizable(r)), '全部候选均不可识别');
  eq(identifyAllRooms(broken.grid, DEFAULT_SCAN_OPTIONS).length, 0, '漏墙房间不应参与识别');
});

test('WT-03-33 温室配方:屋顶构件 375 属屋顶族,不破坏围合', () => {
  ok(isBarrier(375) === false, '375 温室玻璃顶不计入围合');
  const room = houseWith([375]);
  ok(room.closed, '含温室顶的房间仍应闭合');
  eq(identifyRoom(room).key, 'AUTO_GREENHOUSE', '应识别为自动物流温室');
  ok(room.roofed, '应标记房间有屋顶');
});

test('WT-03-34 半高篱笆 357 由 sealSemiOpen 开关决定是否计入围合', () => {
  const g = new TileGrid(12, 12);
  stampBoxRoom(g, { x: 1, y: 1, w: 7, h: 7, wallId: 357, floorId: FLOOR, doorAtCol: -1, extraDoorAtCols: [] });
  const sealed = floodRoom(g, 2, 2, { ...DEFAULT_SCAN_OPTIONS, sealSemiOpen: true });
  eq(sealed.closed, true, 'sealSemiOpen=true 时篱笆构成闭合牧场');
  const open = floodRoom(g, 2, 2, { ...DEFAULT_SCAN_OPTIONS, sealSemiOpen: false });
  eq(open.closed, false, 'sealSemiOpen=false 时篱笆不封闭,泛洪泄漏');
  eq(open.reject, RoomRejectReason.BOUNDARY_LEAK, '不封闭时原因为 BOUNDARY_LEAK');
});

test('WT-03-35 门/窗构件归属区间正确', () => {
  eq(DOOR_IDS[0], 363, '门窗区间起点 363');
  eq(DOOR_IDS[DOOR_IDS.length - 1], 369, '门窗区间终点 369');
  eq(WALL_IDS[0], 351, '墙体区间起点 351');
  eq(WALL_IDS[WALL_IDS.length - 1], 362, '墙体区间终点 362');
  eq(isBarrier(370), true, '观景窗计入围合');
  eq(isBarrier(371), true, '传菜窗口计入围合');
});

/* ══════════════════ 5. 208 蓝图卷轴:框选 → 蓝图码 → 往返 ══════════════════ */

/** 造一个 16×16 的框选场景:7×7 小屋 + 几件家具 + 一段暗线。 */
function makeBlueprintScene(): TileGrid {
  const g = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  stampBoxRoom(g, { x: 2, y: 2, w: 7, h: 7, wallId: WALL, floorId: FLOOR, doorAtCol: 1, extraDoorAtCols: [3] });
  placeInRoom(g, 4, 4, 504);
  placeInRoom(g, 5, 4, 503);
  placeInRoom(g, 6, 5, 517);
  placeInRoom(g, 4, 6, 511);
  for (let x = 3; x <= 7; x += 1) {
    const v = setWire(g.get(x, 9), WireColor.RED, true);
    const w2 = setWire(v, WireColor.BLUE, x % 2 === 0);
    g.set(x, 9, w2);
  }
  /* 屋顶铺一圈 */
  for (let x = 2; x <= 8; x += 1) {
    for (let y = 2; y <= 8; y += 1) {
      if (x === 2 || y === 2 || x === 8 || y === 8) placeInRoom(g, x, y, 372);
    }
  }
  return g;
}

test('WT-03-36 框选 16×16 生成蓝图:尺寸与格数正确', () => {
  const g = makeBlueprintScene();
  const bp = captureBlueprint(g, 0, 0);
  eq(bp.w, BLUEPRINT_SIZE, '宽 16');
  eq(bp.h, BLUEPRINT_SIZE, '高 16');
  eq(bp.cells.length, BLUEPRINT_CELLS, '共 256 格');
  const solid = blueprintSolidCells(bp);
  ok(solid.length > 20, `非空格应超过 20,实际 ${solid.length}`);
});

test('WT-03-37 只接受 16×16 框选,其它尺寸抛错', () => {
  const g = makeBlueprintScene();
  let threw = false;
  try {
    captureBlueprint(g, 0, 0, 8, 8);
  } catch (err) {
    threw = true;
    ok(String(err).includes('16'), '错误信息应提到 16');
  }
  ok(threw, '非 16×16 框选必须报错');
});

test('WT-03-38 蓝图码 round-trip:256 格全字段一致', () => {
  const g = makeBlueprintScene();
  const bp = captureBlueprint(g, 0, 0);
  const code = blueprintCode(bp);
  ok(code.startsWith('BP1:16x16:'), '蓝图码应有 BP1 魔数与前缀尺寸');
  const back = decodeBlueprint(code);
  eq(back.w, bp.w, '宽一致');
  eq(back.h, bp.h, '高一致');
  eq(back.cells.length, bp.cells.length, '格数一致');
  let diff = 0;
  for (let i = 0; i < bp.cells.length; i += 1) {
    const a = bp.cells[i];
    const b = back.cells[i];
    if (a.obj !== b.obj || a.floor !== b.floor || a.elev !== b.elev || a.wire !== b.wire || a.meta !== b.meta) diff += 1;
  }
  eq(diff, 0, 'round-trip 不应有任何字段差异');
});

test('WT-03-39 蓝图码压缩率:RLE 后字节数远小于原始 1024 字节', () => {
  const g = makeBlueprintScene();
  const bp = captureBlueprint(g, 0, 0);
  const enc = encodeBlueprint(bp);
  ok(enc.bytes < 256 * 4, `编码字节 ${enc.bytes} 应小于原始 1024`);
  ok(enc.runs < 256, `游程段数 ${enc.runs} 应少于 256`);
  ok(enc.code.length < 800, `蓝图码长度 ${enc.code.length} 应小于 800 字符`);
  ok(enc.ratio < 0.25, `压缩率 ${enc.ratio} 应优于此`);
});

test('WT-03-40 蓝图码抗损坏:魔数错误/尺寸错误/字符非法分别抛错', () => {
  const good = blueprintCode(captureBlueprint(makeBlueprintScene(), 0, 0));
  for (const bad of ['BP2:16x16:AAAA', 'BP1:8x8:AAAA', 'BP1:16x16:@#$%', 'BP1:16x16', '']) {
    let threw = false;
    try {
      decodeBlueprint(bad);
    } catch {
      threw = true;
    }
    ok(threw, `损坏码 "${bad}" 必须抛错,好码长度 ${good.length}`);
  }
});

test('WT-03-41 全空蓝图也能往返(边界:256 个 0)', () => {
  const g = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  const bp = captureBlueprint(g, 0, 0);
  const enc = encodeBlueprint(bp);
  eq(enc.runs, 1, '全空只需 1 个游程');
  const back = decodeBlueprint(enc.code);
  eq(back.cells.length, BLUEPRINT_CELLS, '解出 256 格');
  ok(back.cells.every((c) => c.obj === 0 && c.floor === 0), '全部为空');
});

test('WT-03-42 材料清单展开:墙体 352 展开为其配方红砖 153', () => {
  const g = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  placeInRoom(g, 3, 3, 352);
  placeInRoom(g, 4, 3, 352);
  placeInRoom(g, 5, 3, 352);
  const bp = captureBlueprint(g, 0, 0);
  const m = expandMaterials(bp);
  const brick = m.lines.find((l) => l.id === 153);
  ok(brick !== undefined, '应展开出红砖 153');
  eq(brick!.count, 3, '3 面墙应需 3 块红砖');
  eq(brick!.name, itemName(153), '名称取自冻结层');
  eq(brick!.totalValue, brick!.unitValue * 3, '总价值 = 单价 × 数量');
  eq(m.objectCount, 3, '统计到 3 个物件');
});

test('WT-03-43 材料清单:地板按 300+floor 映射计入', () => {
  const g = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  const f = unpackTile(0);
  f.floor = FLOOR;
  for (let x = 2; x <= 5; x += 1) g.set(x, 2, packTile(f));
  const bp = captureBlueprint(g, 0, 0);
  const m = expandMaterials(bp);
  eq(m.floorCount, 4, '4 格地板');
  const line = m.lines.find((l) => l.id === floorItemId(FLOOR));
  ok(line !== undefined, `${floorItemId(FLOOR)} 应出现在清单中`);
  eq(line!.count, 4, '地砖数量 4');
});

test('WT-03-43b 地板槽位→物品 ID 必须委派 WS-01,全 64 槽位无幽灵 ID', () => {
  /*
   * 唯一事实源是 `world/chunk.ts#floorIdOfSlot`(内部走 FLOOR_PALETTE)。
   * 建造层若本地重写 `300 + floor`,槽位 ≥31 会产出物品表里不存在的 ID:
   *   槽位 31 → 331(不存在)  而正确值是 314(UGC 像素地毯)
   * 原测试只用 FLOOR=6,恰好落在两处一致的 1..30 区间,抓不到这个缺陷。
   */
  for (let s = 1; s <= 63; s += 1) {
    const id = floorItemId(s);
    ok(id > 0, `槽位 ${s} 应产出有效物品 ID,实际 ${id}`);
    ok(ITEM_BY_ID.has(id),
      `槽位 ${s} 产出的物品 ID ${id} 必须存在于物品表(幽灵 ID 会让 UI 显示空白)`);
  }
  eq(floorItemId(0), 0, '槽位 0 表示无铺装');
  eq(floorItemId(-1), 0, '负槽位回落 0');

  /* 前 30 槽是地砖 301..330 */
  eq(floorItemId(1), 301, '槽位 1 → 301');
  eq(floorItemId(30), 330, '槽位 30 → 330');

  /* 槽位 31..63 是 UGC 地毯,全部映射到 314 */
  eq(floorItemId(31), 314, '槽位 31 → UGC 地毯 314(不是 331)');
  eq(floorItemId(40), 314, '槽位 40 → UGC 地毯 314(不是 340)');
  eq(floorItemId(63), 314, '槽位 63 → UGC 地毯 314(不是 363)');

  /* 极端值不得抛错 */
  ok(floorItemId(999) >= 0, '越界槽位不得抛错');
  ok(floorItemId(1.7) >= 0, '小数槽位不得抛错');
});

test('WT-03-44 材料清单:暗线超过 16 格追加四色电路扳手 207', () => {
  const g = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  for (let i = 0; i < 20; i += 1) {
    const x = i % BLUEPRINT_SIZE;
    const y = Math.floor(i / BLUEPRINT_SIZE);
    g.set(x, y, setWire(g.get(x, y), WireColor.GREEN, true));
  }
  const bp = captureBlueprint(g, 0, 0);
  const m = expandMaterials(bp);
  const tool = m.lines.find((l) => l.id === 207);
  ok(tool !== undefined, '应需要四色电路扳手 207');
  eq(tool!.count, Math.ceil(20 / 16), '20 格线 → 2 把扳手');
});

test('WT-03-45 材料清单:材料按 ID 升序输出且件数守恒', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const m = expandMaterials(bp);
  ok(m.lines.length > 0, '清单非空');
  for (let i = 1; i < m.lines.length; i += 1) {
    ok(m.lines[i - 1].id < m.lines[i].id, '清单必须按 ID 严格升序');
  }
  eq(m.kinds, m.lines.length, 'kinds 等于行数');
  eq(m.totalCount, m.lines.reduce((s, l) => s + l.count, 0), '总件数守恒');
  eq(m.totalValue, m.lines.reduce((s, l) => s + l.totalValue, 0), '总价值守恒');
});

/* ══════════════════ 6. 飞砖接力队列 ══════════════════ */

test('WT-03-46 接力队列:256 格全部入队且序号连续', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const q = buildRelayQueue(bp);
  eq(q.length, BLUEPRINT_CELLS, '应生成 256 个任务');
  for (let i = 0; i < q.length; i += 1) eq(q[i].seq, i, '序号必须连续从 0 起');
  ok(q.every((t) => t.state === RelayTaskState.PENDING), '初始全部 PENDING');
  ok(q.every((t) => t.owner === null), '初始无归属');
});

test('WT-03-47 接力排序:墙体先立、屋顶最后铺', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const q = buildRelayQueue(bp);
  const firstRoof = q.findIndex((t) => t.obj >= 372 && t.obj <= 376);
  const lastWall = q.map((t) => t.obj >= 351 && t.obj <= 362).lastIndexOf(true);
  ok(firstRoof > lastWall, `屋顶首个任务下标 ${firstRoof} 应晚于最后一堵墙 ${lastWall}`);
});

test('WT-03-48 接力推进:8 人并行,全部任务最终 PLACED', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const tasks = buildRelayQueue(bp);
  const builders = Array.from({ length: 8 }, (_v, i) => ({ id: `P${i + 1}`, x: 0, y: 0, speedMul: 1 }));
  const q = new RelayQueue(tasks, builders);
  const r = q.drain(50);
  eq(q.progress(), 1, '进度应为 100%');
  eq(r.placed, BLUEPRINT_CELLS, '应放置全部 256 格');
  ok(tasks.every((t) => t.state === RelayTaskState.PLACED), '无遗留任务');
});

test('WT-03-49 接力分工:8 人严格轮转,负载差恒 ≤ 1', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const tasks = buildRelayQueue(bp);
  const builders = Array.from({ length: 8 }, (_v, i) => ({ id: `P${i + 1}`, x: 0, y: 0, speedMul: 1 }));
  const q = new RelayQueue(tasks, builders);
  q.drain(50);
  const load = relayWorkload(tasks);
  eq(load.size, 8, '8 人应全部有活');
  const counts = builders.map((b) => load.get(b.id) ?? 0);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  /* 256 条 / 8 人 = 每人恰好 32 条 */
  eq(min, 32, `每人应恰好 32 条,实际 ${counts.join(',')}`);
  eq(max, 32, '不应有人多拿');
  ok(max - min <= 1, `负载差 ${max - min} 应 ≤ 1(实际 ${counts.join(',')})`);
  ok(max <= Math.ceil(tasks.length / 8), `最大负载 ${max} 不得超过 ceil(N/8) = ${Math.ceil(tasks.length / 8)}`);
  /* 派发是确定性的:i 条归 active[i % k] */
  for (const t of tasks) eq(t.owner, builders[t.seq % 8].id, `第 ${t.seq} 条应派给 P${(t.seq % 8) + 1}`);
});

test('WT-03-49b 非整除条目数:257 条 → 33,32,32,...,差 ≤1', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const base = buildRelayQueue(bp);
  /* 追加一条人工任务模拟非整除 */
  const tasks = [...base, { ...base[0], seq: base.length, cellIndex: 0, state: RelayTaskState.PENDING, owner: null }];
  const builders = Array.from({ length: 8 }, (_v, i) => ({ id: `P${i + 1}`, x: 0, y: 0, speedMul: 1 }));
  const q = new RelayQueue(tasks, builders);
  q.drain(50);
  const load = relayWorkload(tasks);
  const counts = builders.map((b) => load.get(b.id) ?? 0);
  eq(counts[0], 33, '首位应多拿 1 条');
  eq(Math.max(...counts) - Math.min(...counts), 1, '差值恰为 1');
  eq(counts.reduce((a, b) => a + b, 0), 257, '总数守恒');
});

test('WT-03-49c 并发上限只限制在飞数量,不改变最终归属', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const tasks = buildRelayQueue(bp);
  const builders = Array.from({ length: 8 }, (_v, i) => ({ id: `P${i + 1}`, x: 0, y: 0, speedMul: 1 }));
  const q = new RelayQueue(tasks, builders, { maxBuilders: 8, perBuilderParallel: 1 });
  q.tick(0);
  eq(tasks.filter((t) => t.state === RelayTaskState.FLYING).length, 8, '8 人各 1 块在飞');
  q.drain(50);
  const load = relayWorkload(tasks);
  const counts = builders.map((b) => load.get(b.id) ?? 0);
  eq(Math.max(...counts), 32, '并发受限也仍应每人 32 条');
});

test('WT-03-50 飞行时长:基准 400ms + 60ms/格,速度乘数生效', () => {
  eq(flightDurationMs(0), 400, '距离 0 → 400ms');
  eq(flightDurationMs(10), 1000, '距离 10 → 1000ms');
  eq(flightDurationMs(10, 2), 500, '速度 ×2 → 时长减半');
  eq(flightDurationMs(-5), 400, '负距离夹取到 0');
});

test('WT-03-51 接力回写世界:applyTo 把已放置格写进网格', () => {
  const src = makeBlueprintScene();
  const bp = captureBlueprint(src, 0, 0);
  const tasks = buildRelayQueue(bp);
  const builders = [{ id: 'P1', x: 0, y: 0, speedMul: 1 }];
  const q = new RelayQueue(tasks, builders, { maxBuilders: 1, perBuilderParallel: 2 });
  q.drain(50);
  const dst = new TileGrid(BLUEPRINT_SIZE, BLUEPRINT_SIZE);
  const n = q.applyTo(dst, 0, 0);
  eq(n, BLUEPRINT_CELLS, '回写 256 格');
  let same = true;
  for (let y = 0; y < BLUEPRINT_SIZE; y += 1) {
    for (let x = 0; x < BLUEPRINT_SIZE; x += 1) {
      const a = unpackTile(src.get(x, y));
      const b = unpackTile(dst.get(x, y));
      if (a.obj !== b.obj || a.floor !== b.floor || a.wire !== b.wire) same = false;
    }
  }
  ok(same, '回写后的网格必须与源场景逐格一致(蓝图无损重建)');
});

test('WT-03-52 单人工头模式:并行度限制被遵守', () => {
  const bp = captureBlueprint(makeBlueprintScene(), 0, 0);
  const tasks = buildRelayQueue(bp);
  const builders = [{ id: 'P1', x: 0, y: 0, speedMul: 1 }];
  const q = new RelayQueue(tasks, builders, { maxBuilders: 1, perBuilderParallel: 1 });
  q.tick(0);
  eq(tasks.filter((t) => t.state === RelayTaskState.FLYING).length, 1, '并行度 1 时只能有 1 块在飞');
});

/* ══════════════════ 7. 四色暗线视图 207 ══════════════════ */

function makeWireScene(): TileGrid {
  const g = new TileGrid(16, 16);
  for (let x = 2; x <= 8; x += 1) g.set(x, 5, setWire(g.get(x, 5), WireColor.RED, true));
  for (let x = 2; x <= 8; x += 1) g.set(x, 7, setWire(g.get(x, 7), WireColor.BLUE, true));
  g.set(5, 6, setWire(setWire(g.get(5, 6), WireColor.RED, true), WireColor.BLUE, true));
  for (let x = 1; x <= 4; x += 1) g.set(x, 11, setWire(g.get(x, 11), WireColor.GREEN, true));
  return g;
}

test('WT-03-53 布线视图:四色分层与逐色格数准确', () => {
  const view = buildWireView(makeWireScene());
  eq(view.layers.length, 4, '应有 4 个颜色层');
  eq(view.layers[WireColor.RED].cells.length, 8, '红线 8 格');
  eq(view.layers[WireColor.BLUE].cells.length, 8, '蓝线 8 格');
  eq(view.layers[WireColor.GREEN].cells.length, 4, '绿线 4 格');
  eq(view.layers[WireColor.YELLOW].cells.length, 0, '黄线 0 格');
  eq(view.perColorCount[WireColor.RED], 8, '逐色计数与格子数一致');
});

test('WT-03-54 布线视图:连通分量数量与大小降序', () => {
  const view = buildWireView(makeWireScene());
  const green = view.layers[WireColor.GREEN];
  eq(green.networkCount, 1, '绿线是 1 个网络');
  eq(green.componentSizes[0], 4, '该网络 4 格');
  const blue = view.layers[WireColor.BLUE];
  eq(blue.networkCount, 1, '蓝线通过 (5,6) 与横线连通成 1 个网络');
  for (const layer of view.layers) {
    for (let i = 1; i < layer.componentSizes.length; i += 1) {
      ok(layer.componentSizes[i - 1] >= layer.componentSizes[i], '分量大小应降序');
    }
  }
});

test('WT-03-55 布线视图:重叠格统计与孤立线头提示', () => {
  const view = buildWireView(makeWireScene());
  eq(view.overlapCells, 1, '只有 (5,6) 是双色重叠');

  /*
   * 去重判据:对全部颜色层做 Set<globalIndex> 并集后取 size,不做手工加减。
   * 本场景:红横线 y=5 共 7 格 + 重叠格 (5,6) = 8;
   *         蓝横线 y=7 共 7 格 + 重叠格 (5,6) = 8;绿线 4 格。
   * 并集 = 8 + 8 + 4 − 1(重叠格只算一次) = 19;
   * 逐色计数之和 = 8 + 8 + 4 = 20(重叠格在每个颜色层里各出现一次)。
   * 因此 `wiredCells`(格口径)与 `perColorWiredCells`(色·格口径)本就差 1,
   * 二者都必须能被独立复算,不允许用「−1+1」这类凑数式修正。
   */
  const W = view.width;
  const union = new Set<number>();
  for (const layer of view.layers) {
    for (const c of layer.cells) union.add(c.y * W + c.x);
  }
  eq(union.size, 19, 'Set 并集口径应为 19 格');
  eq(view.wiredCells, union.size, 'wiredCells 必须严格等于四色格并集大小');
  eq(view.perColorWiredCells, 20, '色·格口径之和 = 8 + 8 + 4 = 20');
  eq(
    view.perColorWiredCells,
    view.perColorCount[WireColor.RED] + view.perColorCount[WireColor.BLUE]
      + view.perColorCount[WireColor.YELLOW] + view.perColorCount[WireColor.GREEN],
    'perColorWiredCells 必须等于逐色计数之和',
  );
  eq(view.perColorWiredCells - view.wiredCells, view.overlapCells, '两个口径的差值恰好是重叠格数');

  /*
   * 孤立线头(度数 ≤ 1 的格):
   *   红线:横排 (2,5) 与 (8,5) 两个端点 + 竖出的 (5,6) = 3 个;
   *   蓝线:横排 (2,7) 与 (8,7) 两个端点 + 竖出的 (5,6) = 3 个;
   *   绿线:(1,11) 与 (4,11) = 2 个。
   * 合计 8 —— 重叠格 (5,6) 在红蓝两层里各算一次,这正是「色·格」口径。
   */
  eq(danglingEnds(view), 8, '红 3 + 蓝 3 + 绿 2 = 8 个线头');
  const redLayer = view.layers[WireColor.RED];
  eq(redLayer.cells.length, 8, '红线格数(含重叠格)');
  ok(view.perColorCount[WireColor.YELLOW] === 0, '黄线未布');
  eq(view.layers[WireColor.BLUE].cells.length, 8, '蓝线格数(含重叠格)');
  eq(view.layers[WireColor.GREEN].cells.length, 4, '绿线格数');
});

test('WT-03-56 布线视图兼容冻结层:WIRE_LABEL 四色齐全且序列化可解', () => {
  for (const c of [WireColor.RED, WireColor.BLUE, WireColor.YELLOW, WireColor.GREEN]) {
    ok(typeof WIRE_LABEL[c] === 'string' && WIRE_LABEL[c].length > 0, `颜色 ${c} 应有中文标签`);
  }
  const view = buildWireView(makeWireScene());
  const bytes = serializeWireView(view);
  eq(bytes.length % 2, 0, '序列化为 (值, 游程) 对');
  ok(bytes.length <= 16 * 16 * 2, '序列化长度上界 512');
});

test('WT-03-57 默认配置自洽:精灵表 16 项、变体数为 2 的幂', () => {
  eq(DEFAULT_AUTOTILE_CONFIG.spriteTable.length, 16, '精灵表必须 16 项');
  for (let m = 0; m < 16; m += 1) eq(DEFAULT_AUTOTILE_CONFIG.spriteTable[m], m, '默认表为恒等');
  ok(DEFAULT_AUTOTILE_CONFIG.cornerVariants === 4, '转角 4 变体');
  ok(DEFAULT_AUTOTILE_CONFIG.straightVariants === 2, '直墙 2 变体');
});

report('WS-03');