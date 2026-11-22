/**
 * WS-FND-181 —— **世界是设计过的**(`shared/world/design.ts`)。
 *
 * ## 为什么有这一套
 *
 * owner 的原话:「你做的根本不是游戏,就是一堆像素块,地图也小,也没设计」。
 * 查下去是**三件独立的事实**叠在一起(不是调色问题):
 *
 * ```text
 * 1 客户端画的是 `client/src/three/boot.ts` 里的 `makeDemoWorld()` ——
 *   本地硬编码的 64×64 正弦起伏 + 一条正弦河,地板槽位 `1+(gx+gy)%3` 循环。
 *   服务器世界**根本不过 WS**(`shared/net/delta.ts` 的 `chunkWireBytes` /
 *   `diffChunkVersions` 至今只有单测在用)⇒ 你在屏幕上看到的永远不是服务器那张图。
 * 2 地形顶点色只按**海拔层**取色(`terrain_vcolor.ELEV_BASE_RGB`,4 色),
 *   `base`(草/沙/岩/水)与 `floor`(路/广场/砖)不进颜色路径 ⇒ 再好的地表也看不出来。
 * 3 服务器世界本身**一格都没写过**(`play.ts` 只 `assemble({sizeCells, mobs})`),
 *   群系是整图一个 `biomeName`。
 * ```
 *
 * 本套件守第 3 件的修法:设计图**存在、自洽、可机检**。第 1、2 件由
 * `client/src/stage/design_world.ts` 与 `WS-FND-180`(顶点色材质调色板)守。
 *
 * ## 逐条的注入靶子
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 11 个区**都真的盖了格**(格数 ≥ 45) | 删掉某个 `disc()/rect()` |
 * | 2 | 出生点 = 大理石(306)+ `elev=GROUND`(**不许抬高**) | 把营地改成 `PLATFORM` ⇒ 玩家卡在台子里 |
 * | 3 | 每个区的一个代表格 = 该区声明的 `base/floor/elev` | 抄错一个常量 |
 * | 4 | 主干道 / 栈桥 / 地标格数有下界;广场中心不许被路盖 | 去掉环路、栈桥,或让主路穿过广场 |
 * | 5 | 地表材质**种类数** ≥ 5(base)/ ≥ 8(地砖) | 把所有区都铺成同一种地砖 |
 * | 6 | **连通性**:出生点走得到每个陆上区的代表点 | 把路画断 / 把区丢进海里 |
 * | 7 | 温泉眼是水(`HOT_SPRING`)且**不可站**;`regionAt` 认得出 | 把它当地板铺 / `regionAt` 顺序错 |
 * | 8 | 槽位换算与 `server/src/world/chunk.ts` **逐值一致**(0..400) | 两份实现漂移 |
 * | 9 | **接线**:`createHost()` 在 `restoreWorldFromDb` **之前**盖图 | 反过来 ⇒ 每次开服推平玩家改过的地形 |
 * | 10 | **接线**:`play.ts` 的 `--world design` 真的透传 `design: true` + 边长 192 | 删掉那一行 ⇒ 图又变回空世界 |
 * | 11 | **接线**:客户端 `boot.ts` 走 `buildDesignChunks()`,`makeDemoWorld()` 只在 catch 里 | 改回去 ⇒ 屏幕上是另一张图 |
 * | 12 | 客户端切块:12×12=144 块、面数在 `FACE_BUDGET` 内 | 边长改回 96 ⇒ 与服务器不一致 |
 * | 13 | 海岸线有三个谐波(不是圆) | 把 `coastRadius` 改成常数 |
 */

import {
  applyWorldDesign, REGIONS, DESIGN_SIZE, DESIGN_CENTER, regionAt, coastRadius,
  floorSlotOfId as sharedSlotOfId, floorIdOfSlot as sharedIdOfSlot, type DesignWriter,
} from '../shared/world/design.ts';
import {
  floorSlotOfId as chunkSlotOfId, floorIdOfSlot as chunkIdOfSlot,
} from '../server/src/world/chunk.ts';
import { CHUNK_SIZE, FACE_BUDGET, buildChunkQuads } from '../client/src/stage/tile_mesh.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import { buildDesignChunks, DESIGN_WORLD_CELLS } from '../client/src/stage/design_world.ts';
import { packTile, unpackTile, BaseFluid, Elevation } from '../shared/types/tile.ts';
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';

/* ─────────── 内存桩:一次盖章,后面所有断言都读这份 ─────────── */

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

const rep = applyWorldDesign(stub, { size });
const at = (x: number, y: number) => unpackTile(tiles[y * size + x]!);

/* ─────────── 1 十一个区都真的存在 ─────────── */

test('FND181-1 11 个区都盖了格(没有一个空区)', () => {
  eq(REGIONS.length, 11, '`REGIONS` 的区数');
  eq(rep.regions.length, 11, '报告里的区数');
  for (const r of rep.regions) {
    ok(r.cells > 0, `区 ${r.id}(${r.name})格数应为正,实际 ${r.cells}`);
  }
  /* 下界:最小的温泉眼 π·4²≈50 格。
     ⚠️ 这里的格数是「绘制尝试数」,后画的区会覆盖先画的(见 `applyWorldDesign`
     的图层顺序)⇒ 它不是「最终落在这一区的格数」,只用来证明**这个区真的被画了**。 */
  const smallest = rep.regions.reduce((a, b) => (a.cells <= b.cells ? a : b));
  ok(smallest.cells >= 45, `最小区的格数应 ≥ 45,实际 ${smallest.id}=${smallest.cells}`);
});

/* ─────────── 2 出生点:大理石圆 + **不抬高** ─────────── */

test('FND181-2 出生点是广场中心大理石,且与地面同高(不抬高)', () => {
  const s = at(DESIGN_CENTER, DESIGN_CENTER);
  eq(rep.spawn.x, DESIGN_CENTER, '报告的出生点 x');
  eq(rep.spawn.y, DESIGN_CENTER, '报告的出生点 y');
  eq(s.floor, sharedSlotOfId(306), '出生点是 306 纯白大理石砖');
  /* ⚠️ 这条是**安全判据**:营地抬高(PLATFORM)会让出生 z 与地面 z 不一致,
     表现是「人卡在台子里」—— 它不报错、只表现为走不动。 */
  eq(s.elev, Elevation.GROUND, '营地必须留在 GROUND(不许抬高)');
  ok(regionAt(DESIGN_CENTER, DESIGN_CENTER) === 'camp', '出生点属于 camp 区');
});

/* ─────────── 3 每个区的代表格 = 声明值 ─────────── */

test('FND181-3 每个区的代表格与声明一致', () => {
  /* 有抬高层的区(矿丘/高地)代表格取**台下沿**(丘心是 CLIFF,`spec.elev` 说的是外环)。 */
  const probes: readonly { id: string; x: number; y: number }[] = [
    { id: 'camp', x: 88, y: 88 },
    { id: 'meadow', x: 64, y: 64 },
    { id: 'grove', x: 128, y: 64 },
    { id: 'farm', x: 100, y: 130 },
    { id: 'mine', x: 64, y: 140 },
    { id: 'ruins', x: 128, y: 124 },
    { id: 'lake', x: 145, y: 74 },
    { id: 'spring', x: 138, y: 66 },
    { id: 'track', x: 52, y: 63 },
    { id: 'marsh', x: 38, y: 93 },
    { id: 'highland', x: 80, y: 58 },
  ];
  for (const p of probes) {
    const spec = REGIONS.find((r) => r.id === p.id);
    ok(spec !== undefined, `区 ${p.id} 在 REGIONS 里`);
    if (spec === undefined) continue;
    const u = at(p.x, p.y);
    eq(u.base, spec.base, `${p.id} 代表格 base(${p.x},${p.y})`);
    eq(u.elev, spec.elev, `${p.id} 代表格 elev(${p.x},${p.y})`);
    if (spec.floorItemId !== 0) {
      eq(u.floor, sharedSlotOfId(spec.floorItemId), `${p.id} 代表格 floor = ${spec.floorItemId}`);
    }
    eq(regionAt(p.x, p.y), p.id, `regionAt(${p.x},${p.y}) 应认出 ${p.id}`);
  }
});

/* ─────────── 4 道路 / 栈桥 / 地标有下界 ─────────── */

test('FND181-4 主干道、栈桥、地标都真的铺出来了,且不许压掉广场中心', () => {
  ok(rep.roadCells > 1000, `主干道格数应 > 1000,实际 ${rep.roadCells}`);
  ok(rep.pierCells > 100, `跨海栈桥格数应 > 100,实际 ${rep.pierCells}`);
  ok(rep.landmarkCells >= 80, `地标格数应 ≥ 80(13 个地标 + 沿路灯),实际 ${rep.landmarkCells}`);
  eq(at(57, 96).floor, sharedSlotOfId(309), '西侧环路上铺的是 309 萤光星光夜路砖');
  eq(at(96, 20).floor, sharedSlotOfId(310), '北侧伸出海岸那段是 310 水上浮木栈桥');
  /* 主路**不许**从广场正中穿过:那会把大理石圆心盖成路面(改前实测就是这样)。 */
  eq(at(DESIGN_CENTER, DESIGN_CENTER).floor, sharedSlotOfId(306),
    '广场中心仍是 306 大理石');
  eq(at(DESIGN_CENTER, DESIGN_CENTER).obj, 0, '广场中心没有路灯压在地标上');
});

/* ─────────── 5 地表材质种类数 ─────────── */

test('FND181-5 地表材质 ≥ 5 种 base / ≥ 8 种地砖(不是一整块同色)', () => {
  const bases = new Set<number>();
  const floors = new Set<number>();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = at(x, y);
      if (u.elev === Elevation.DEEP && u.floor === 0) continue; /* 开阔海面不算 */
      bases.add(u.base);
      if (u.floor !== 0) floors.add(u.floor);
    }
  }
  ok(bases.size >= 5, `陆上 base 种类应 ≥ 5,实际 ${bases.size}(${[...bases].join(',')})`);
  ok(floors.size >= 8, `用到的地砖种类应 ≥ 8,实际 ${floors.size}(${[...floors].join(',')})`);
  ok(rep.floorItemIds.length >= 8, `报告列出的地砖 id 数应 ≥ 8,实际 ${rep.floorItemIds.length}`);
});

/* ─────────── 6 连通性:出生点走得到每个区 ─────────── */

test('FND181-6 出生点有路走到每个陆上区的代表点', () => {
  const seen = new Uint8Array(size * size);
  const walkable = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const u = at(x, y);
    if (u.elev === Elevation.CLIFF) return false;      /* 崖 = 墙 */
    return u.elev !== Elevation.DEEP || u.floor !== 0; /* 水面只有栈桥能走 */
  };
  const queue: number[] = [DESIGN_CENTER * size + DESIGN_CENTER];
  seen[DESIGN_CENTER * size + DESIGN_CENTER] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head]!;
    const x = i % size;
    const y = (i - x) / size;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!walkable(nx, ny)) continue;
      const j = ny * size + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  ok(queue.length > 5000, `从出生点能走到的格数应 > 5000,实际 ${queue.length}`);

  /* 代表点:丘心/崖顶本身是墙,取台下沿;温泉是水,不在本清单里(见第 7 条)。 */
  const targets: readonly { id: string; x: number; y: number }[] = [
    { id: 'camp', x: DESIGN_CENTER, y: DESIGN_CENTER },
    { id: 'meadow', x: 64, y: 64 },
    { id: 'grove', x: 120, y: 64 },
    { id: 'farm', x: 100, y: 130 },
    { id: 'mine', x: 64, y: 119 },
    { id: 'ruins', x: 128, y: 128 },
    { id: 'lake', x: 138, y: 74 },
    { id: 'track', x: 52, y: 72 },
    { id: 'marsh', x: 38, y: 93 },
    { id: 'highland', x: 80, y: 55 },
  ];
  for (const t of targets) {
    ok(seen[t.y * size + t.x] === 1, `从出生点走不到 ${t.id} 的代表点 (${t.x},${t.y})`);
  }
});

/* ─────────── 7 温泉眼是水,不是地板 ─────────── */

test('FND181-7 温泉眼是水(HOT_SPRING)且不可站', () => {
  const s = at(138, 66);
  eq(s.base, BaseFluid.HOT_SPRING, '温泉眼的 base');
  eq(s.elev, Elevation.DEEP, '温泉眼在水面高度(z=-1)');
  eq(s.floor, 0, '温泉眼没有铺装');
  eq(regionAt(138, 66), 'spring', 'regionAt 认得出温泉眼(顺序必须是绘制顺序的倒序)');
  eq(regionAt(145, 74), 'lake', 'regionAt 认得出湖');
});

/* ─────────── 8 槽位换算与 chunk.ts 逐值一致 ─────────── */

test('FND181-8 槽位换算与 server/src/world/chunk.ts 逐值一致(0..400)', () => {
  for (let id = 0; id <= 400; id += 1) {
    eq(sharedSlotOfId(id), chunkSlotOfId(id), `id=${id} 的槽位换算`);
  }
  for (let slot = 0; slot <= 64; slot += 1) {
    eq(sharedIdOfSlot(slot), chunkIdOfSlot(slot), `slot=${slot} 的物品 id 换算`);
  }
});

/* ─────────── 9 接线:在 restoreWorldFromDb **之前** ─────────── */

test('FND181-9 createHost 在 restoreWorldFromDb 之前盖图', () => {
  const src = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
  const applyAt = src.indexOf('applyWorldDesign(sim');
  const restoreAt = src.indexOf('sim.restoreWorldFromDb(');
  ok(applyAt > 0, 'index.ts 里应当有 `applyWorldDesign(sim` 这一行');
  ok(restoreAt > 0, 'index.ts 里应当有 `sim.restoreWorldFromDb(` 这一行');
  ok(applyAt < restoreAt,
    '盖图必须在读档**之前** —— 反过来就是「每次开服把玩家改过的地形推平」');
  ok(src.includes('if (deps.design === true)'),
    '盖图必须由 `deps.design === true` 把关(缺省不许铺 —— 与改前逐字不变)');
});

/* ─────────── 10 接线:play.ts 的 --world ─────────── */

test('FND181-10 play.ts 的 --world design 真的透传', () => {
  const src = readFileSync(new URL('../scripts/play.ts', import.meta.url), 'utf8');
  ok(/strArg\('world', 'plain'\)/.test(src), '`--world` 的缺省必须是 plain(与改前一致)');
  ok(src.includes('design: WORLD_KEY === \'design\''), 'assemble 必须收到 design 开关');
  ok(src.includes('WORLD_KEY === \'design\' ? DESIGN_SIZE : 96'),
    'design 模式的边长缺省必须是 DESIGN_SIZE(192,手放区坐标的尺度)');
});

/* ─────────── 11 接线:客户端画同一张图 ─────────── */

test('FND181-11 客户端画的是设计世界,不是 demo 世界', () => {
  const src = readFileSync(new URL('../client/src/three/boot.ts', import.meta.url), 'utf8');
  ok(src.includes('buildDesignChunks()'), 'boot.ts 必须调 `buildDesignChunks()`');
  ok(src.includes('isoCam.focusX = DESIGN_WORLD_CELLS / 2'),
    '相机焦点必须跟世界边长走(否则视野停在角落)');
  /* 只在**地形那一段**里比先后 —— 顶部 import 里 `makeDemoWorld` 天然靠前,
     拿全文比会把「正确的回落」判成红。 */
  const bodyAt = src.indexOf('const chunks');
  ok(bodyAt > 0, '找不到地形那一段(`const chunks`)');
  const body = src.slice(bodyAt);
  const designAt = body.indexOf('buildDesignChunks()');
  const demoAt = body.indexOf('makeDemoWorld()');
  ok(designAt >= 0, '地形那一段必须调 `buildDesignChunks()`');
  ok(demoAt > designAt, '`makeDemoWorld()` 只能作为**回落**出现在设计图之后');
  ok(body.includes("console.error('[terrain]"), '回落必须留痕,不许静默');
});

/* ─────────── 12 客户端切块:块数与面数预算 ─────────── */

test('FND181-12 客户端切块 = 12×12 块,面数在预算内', () => {
  eq(DESIGN_WORLD_CELLS, DESIGN_SIZE, '客户端世界边长与服务器同一常量');
  const chunks = buildDesignChunks();
  const perSide = DESIGN_SIZE / CHUNK_SIZE;
  eq(chunks.length, perSide * perSide, `块数应为 ${perSide}×${perSide}`);
  let faces = 0;
  let nonEmpty = 0;
  for (const c of chunks) {
    faces += buildChunkQuads(c, 0).faceCount;
    for (let i = 0; i < c.tiles.length; i += 1) if (c.tiles[i] !== 0) nonEmpty += 1;
  }
  ok(nonEmpty > 30000, `有内容的格数应 > 30000,实际 ${nonEmpty}`);
  ok(faces < FACE_BUDGET, `整图面数必须 < 预算 ${FACE_BUDGET},实际 ${faces}`);
  const again = buildDesignChunks();
  eq(again.length, chunks.length, '两次切块块数一致(纯函数)');
  eq(again[0]!.key, '0,0', '第一块 key');
  ok(at(0, 0).base === BaseFluid.SHALLOW_WATER || at(0, 0).base === BaseFluid.VOID,
    '角落是海(设计图四周留了一圈海)');
});

/* ─────────── 13 海岸线是设计出来的,不是圆 ─────────── */

test('FND181-13 海岸线有三个谐波(不是圆)', () => {
  const rs: number[] = [];
  for (let i = 0; i < 64; i += 1) rs.push(coastRadius((i / 64) * Math.PI * 2));
  const lo = Math.min(...rs);
  const hi = Math.max(...rs);
  ok(hi - lo > 10, `海岸半径的起伏应 > 10 格(实测 ${(hi - lo).toFixed(1)})`);
  ok(hi < size / 2 - 2, `海岸最大半径 ${hi.toFixed(1)} 必须小于半个世界(${size / 2})`);
  ok(rep.landCells > 10000 && rep.seaCells > 10000, '陆地与海都要有相当面积');
  ok(rep.beachCells > 500, `沙滩环 > 500 格,实际 ${rep.beachCells}`);
});
test('FND181-16 HUD 的地形规模读真实块列表,不是 demo 常量', () => {
  const src = readFileSync(new URL('../client/src/three/boot.ts', import.meta.url), 'utf8');
  ok(src.includes('makeHud(container, { cells: worldCells, chunks: chunks.length })'),
    'HUD 必须收到真实的世界规模');
  ok(src.includes('const worldCells = chunks.length === 0'),
    '世界边长必须由 chunk 列表算出来');
  ok(!/地形 \$\{WORLD_CELLS\}/.test(src),
    '不许再用 `WORLD_CELLS` 拼地形标签(改前实测:世界 192×192,UI 报「64×64 格 / 16 chunk」)');
});

/* ─────────── 14 出生点:设计图必须把玩家送进广场,而不是海里 ─────────── */

test('FND181-14 出生点跟着设计图走(缺省与改前逐字一致)', () => {
  /* 为什么这条**必须有行为断言**:改前 `room.spawnPoint()` 恒为 `0.5 + n*1.5`,
     即地图原点。而设计图的原点是**海**(海岸线最小半径 68)⇒ 玩家出生在水里,
     广场在 96 格外。实测过一次(浏览器 HUD 坐标 `0.5, 0.5`、世界里全是水),
     而当时**没有一条判据会红** —— 源码接线断言也拦不住「偏移量算错」。 */
  const mk = (spawnOrigin?: { x: number; y: number }) => new RoomRuntime({
    roomId: 'fnd181-spawn',
    ownerId: 'u_host',
    clock: { nowMs: () => 0 },
    ...(spawnOrigin === undefined ? {} : { spawnOrigin }),
  }, null);

  /* 负对照:不给 spawnOrigin ⇒ 必须还是 (0.5, 0.5)(与改前逐字不变)。 */
  const plain = mk();
  plain.join({ userId: 'u_plain' });
  const p0 = plain.state.players[0]!;
  eq(p0.x, 0.5, '缺省出生点 x(与改前逐字一致)');
  eq(p0.y, 0.5, '缺省出生点 y(与改前逐字一致)');

  /* 设计图:出生点 = 广场中心 (96.5, 96.5),且那一格必须是**大理石**、不是水。 */
  const designed = mk({ x: DESIGN_CENTER, y: DESIGN_CENTER });
  designed.join({ userId: 'u_designed' });
  const p1 = designed.state.players[0]!;
  eq(p1.x, DESIGN_CENTER + 0.5, '设计图出生点 x');
  eq(p1.y, DESIGN_CENTER + 0.5, '设计图出生点 y');
  const cell = at(Math.floor(p1.x), Math.floor(p1.y));
  eq(cell.floor, sharedSlotOfId(306), '出生点那一格是广场中心大理石');
  ok(cell.elev !== Elevation.DEEP, '出生点**不在水里**(elev 不是 DEEP)');
});

test('FND181-15 装配层把设计图的出生原点接到房间上', () => {
  const idx = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
  ok(idx.includes('spawnOrigin: deps.design === true ? { x: DESIGN_CENTER, y: DESIGN_CENTER } : undefined'),
    '`assemble()` 必须按 `deps.design` 把出生原点传进 rtOpts');
  const room = readFileSync(new URL('../server/src/net/room.ts', import.meta.url), 'utf8');
  ok(room.includes('const o = this.spawnOrigin;'), '`spawnPoint()` 必须读 `spawnOrigin`');
  ok(room.includes('spawnOrigin?: { x: number; y: number };'), '`RoomRuntimeOptions` 必须有这个键');
  /* 键集两侧一致(FND9-9 守的就是这条;这里反向钉一次,免得只改一侧)。 */
  const colyseus = readFileSync(new URL('../server/src/net/room.colyseus.ts', import.meta.url), 'utf8');
  ok(colyseus.includes('spawnOrigin: undefined,'), 'B 路 rtOpts 必须显式列出同一个键');
});
report('WS-FND-181');