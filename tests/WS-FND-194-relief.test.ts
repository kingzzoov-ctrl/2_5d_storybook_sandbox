/**
 * WS-FND-194 —— **地形有起伏**(台地 / 崖壁 / 河谷,`shared/world/design.ts`)。
 *
 * ## 为什么有这一套
 *
 * owner 看完设计世界之后的原话是「看起来依旧不是一个世界」。查下去有两条**独立**成因:
 *
 * ```text
 * 1 顶面贴图:地形顶点色只按海拔层取 4 色 ⇒ 草/沙/岩/水/砖在画面上同色(WS-FND-180 在修);
 * 2 地形本身:192×192 的最终格分布是
 *      DEEP 18104 / GROUND 18384 / PLATFORM 298 / CLIFF 78
 *    ⇒ 陆地 18760 格里只有 376 格(2.0%)不是平地 —— 一片 z = 0 的平板。
 * ```
 *
 * 本套件守第 2 条:台地(PLATFORM,z = +1)、崖壁(CLIFF,z = +2)、河谷(DEEP,z = −1)
 * 必须**成规模、成系统**,而且**不许把任何区封死**。
 *
 * ## 口径(先写死,再断言)
 *
 *   - 「陆地」= `elev !== DEEP` 的格 ⇒ 分子 = `PLATFORM + CLIFF`,分母 = 全部陆地格;
 *   - 「可走」= 与 `WS-FND-181` FND181-6 **同一条**规则:`CLIFF` 是墙,水面(`DEEP`)
 *     只有铺了东西(`floor != 0`:栈桥/桥)才可走;
 *   - 「河道连续」= `riverCenterline()` 逐格必须是 `DEEP`(轴对齐折线 ⇒ 逐格步进无跳格)。
 *
 * ## 逐条的注入靶子(改坏哪里会红)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 陆地非平地占比 ≥ 15%(改前实测 2.0%) | 去掉台地/崖壁那几遍 |
 * | 2 | 报告新增 4 个起伏字段,且量级与逐格读回一致 | 记账漏加 / 台地没盖 |
 * | 3 | 出生点仍是 `GROUND` + 大理石(不抬高) | 把营地抬成 PLATFORM ⇒ 人卡在台子里 |
 * | 4 | 营地 84..108 零 PLATFORM/CLIFF | 台地压到广场/镇上 |
 * | 5 | 出生点 BFS 走得到 10 个陆上区代表点 | 崖壁围满一圈 / 把区丢进海里 |
 * | 6 | 沿河心线逐格都是河床(**不许断点**) | 河道挖成「每隔一格」/ 被主路压平后不补桥 |
 * | 7 | 河头在海里、河口在湖里、沙洲是可走缓坡 | 河道画到陆地里 / 沙洲做成墙 |
 * | 8 | 草原/竹林/遗迹/农田/沼泽/沙丘**各自**都有抬升 | 只抬一处、其余照旧平地 |
 * | 9 | 每处台地的**台面整块可走上去** | 把扇形崖壁改成整圈(封死山地) |
 * | 10 | 河道上「两侧都是主路」的格子必须铺桥 | 去掉补桥那一遍 ⇒ 环路/主路被河切断 |
 * | 11 | 两次盖章逐格相同(确定性) | 引入随机 |
 */

import {
  applyWorldDesign, DESIGN_SIZE, DESIGN_CENTER, MOUNDS, riverCenterline, riverBankCells,
  riverChannelCells, regionAt, coastRadius, floorSlotOfId, type DesignWriter,
} from '../shared/world/design.ts';
import { packTile, unpackTile, BaseFluid, Elevation } from '../shared/types/tile.ts';
import { eq, ok, report, test } from '../shared/testing/harness.ts';

/* ─────────── 内存桩:一次盖章,后面所有断言都读这份(与 WS-FND-181 同形)─────────── */

const size = DESIGN_SIZE;
const tiles = new Int32Array(size * size).fill(-1);

const mkStub = (buf: Int32Array): DesignWriter => ({
  sizeCells: size,
  setCell(x: number, y: number, fields): void {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * size + x;
    const cur = buf[i] === -1
      ? { elev: 0, base: 0, floor: 0, wire: 0, obj: 0, meta: 0 }
      : unpackTile(buf[i]!);
    buf[i] = packTile({ ...cur, ...fields });
  },
  fillRect(x0, y0, x1, y1, fields): number {
    let n = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        this.setCell(x, y, fields);
        n += 1;
      }
    }
    return n;
  },
});

const rep = applyWorldDesign(mkStub(tiles), { size });
/** 读回最终格(与报告里的「写入尝试数」区分开:主路会把台地压回 GROUND)。 */
const at = (x: number, y: number) => unpackTile(tiles[y * size + x]!);

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/* ─────────── 全场统计 + BFS:一次算好,后面几条直接用 ─────────── */

const elevCount = [0, 0, 0, 0];
let solidCells = 0;
let reliefCells = 0;
const reliefByRegion = new Map<string, { p: number; c: number }>();
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const u = at(x, y);
    elevCount[u.elev] = (elevCount[u.elev] ?? 0) + 1;
    if (u.elev === Elevation.DEEP) continue;
    solidCells += 1;
    if (u.elev === Elevation.GROUND) continue;
    reliefCells += 1;
    const id = regionAt(x, y);
    if (id === null) continue;
    const cur = reliefByRegion.get(id) ?? { p: 0, c: 0 };
    if (u.elev === Elevation.PLATFORM) cur.p += 1;
    else cur.c += 1;
    reliefByRegion.set(id, cur);
  }
}

const reachable = new Uint8Array(size * size);
{
  const start = DESIGN_CENTER * size + DESIGN_CENTER;
  const queue = [start];
  reachable[start] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const i = queue[head]!;
    const x = i % size;
    const y = (i - x) / size;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const u = at(nx, ny);
      if (u.elev === Elevation.CLIFF) continue;                 /* 崖 = 墙 */
      if (u.elev === Elevation.DEEP && u.floor === 0) continue;  /* 水面只有桥能走 */
      const j = ny * size + nx;
      if (reachable[j] === 1) continue;
      reachable[j] = 1;
      queue.push(j);
    }
  }
}

/* ─────────── 1 起伏规模:陆地非平地 ≥ 15% ─────────── */

test('FND194-1 陆地非平地占比 ≥ 15%(改前实测 2.0%)', () => {
  const pct = (reliefCells / solidCells) * 100;
  /* ⚠️ 这条是整套的方向盘:改前 376/18760 = 2.0%,「一片平板」就是这么来的。 */
  ok(pct >= 15, `陆地非平地占比应 ≥ 15%,实际 ${pct.toFixed(2)}%(${reliefCells}/${solidCells})`);
  ok(reliefCells >= 2500, `起伏格数应 ≥ 2500,实际 ${reliefCells}`);
  ok(elevCount[Elevation.PLATFORM]! >= 1200,
    `PLATFORM 格数应 ≥ 1200(改前 298),实际 ${elevCount[Elevation.PLATFORM]}`);
  ok(elevCount[Elevation.CLIFF]! >= 600,
    `CLIFF 格数应 ≥ 600(改前 78),实际 ${elevCount[Elevation.CLIFF]}`);
});

/* ─────────── 2 报告的起伏字段 ─────────── */

test('FND194-2 报告新增四个起伏字段,量级与逐格读回一致', () => {
  /* 既有字段(landCells/seaCells/... )由 WS-FND-181 守;这里只钉**新增**字段。 */
  ok(rep.platformCells >= 1500, `platformCells 应 ≥ 1500,实际 ${rep.platformCells}`);
  ok(rep.cliffCells >= 700, `cliffCells 应 ≥ 700,实际 ${rep.cliffCells}`);
  ok(rep.riverCells >= 300, `riverCells 应 ≥ 300,实际 ${rep.riverCells}`);
  ok(rep.bridgeCells >= 8, `bridgeCells 应 ≥ 8(三条主路各是 3~4 格宽的桥),实际 ${rep.bridgeCells}`);
  /* 报告是**写入尝试数**:后画的那几遍(主路压平台地)会改掉一部分 ⇒ 逐格读回
     不会**多于**报告值。两边都给出来,谁也不能被单独改掉。 */
  ok(elevCount[Elevation.PLATFORM]! <= rep.platformCells,
    `逐格读回的 PLATFORM(${elevCount[Elevation.PLATFORM]})不许超过报告值(${rep.platformCells})`);
  ok(elevCount[Elevation.CLIFF]! <= rep.cliffCells,
    `逐格读回的 CLIFF(${elevCount[Elevation.CLIFF]})不许超过报告值(${rep.cliffCells})`);
  eq(rep.size, DESIGN_SIZE, '报告边长');
  eq(rep.regions.length, 12, '既有字段 regions 仍在(12 个区)');
  ok(rep.landmarkCells > 0 && rep.roadCells > 0 && rep.pierCells > 0,
    '既有字段 landmarkCells / roadCells / pierCells 都还在');
});

/* ─────────── 3 出生点必须与地面同高 ─────────── */

test('FND194-3 出生点仍是 GROUND + 大理石(没被台地抬起来)', () => {
  const s = at(DESIGN_CENTER, DESIGN_CENTER);
  eq(s.elev, Elevation.GROUND, '出生点必须留在 GROUND(抬起来 ⇒ 玩家卡在台子里)');
  eq(s.floor, floorSlotOfId(306), '出生点是 306 纯白大理石');
  eq(regionAt(DESIGN_CENTER, DESIGN_CENTER), 'camp', '出生点仍属于 camp 区');
});

/* ─────────── 4 营地 / 镇上绝对安全 ─────────── */

test('FND194-4 营地与镇上(84..108)零 PLATFORM / 零 CLIFF', () => {
  const bad: string[] = [];
  for (let y = DESIGN_CENTER - 12; y <= DESIGN_CENTER + 12; y += 1) {
    for (let x = DESIGN_CENTER - 12; x <= DESIGN_CENTER + 12; x += 1) {
      const u = at(x, y);
      if (u.elev === Elevation.PLATFORM || u.elev === Elevation.CLIFF) {
        bad.push(`(${x},${y})e${u.elev}`);
      }
    }
  }
  eq(bad.length, 0, `营地 84..108 里不许有抬升(实测:${bad.slice(0, 8).join(' ')})`);
});

/* ─────────── 5 连通性:抬升不许把任何区封死 ─────────── */

test('FND194-5 出生点 BFS 能走到 10 个陆上区的代表点', () => {
  /* 代表点**沿用 WS-FND-181 FND181-6 的那一套**(丘心/崖顶本身是墙 ⇒ 取台下沿;
     温泉与湖心是水 ⇒ 不在清单里;沙丘不在这 10 个点内,另由第 8 条覆盖)。 */
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
    ok(reachable[t.y * size + t.x] === 1,
      `从出生点走不到 ${t.id} 的代表点 (${t.x},${t.y}) —— 崖壁把区封死了?`);
  }
  let walkableCells = 0;
  for (let i = 0; i < reachable.length; i += 1) walkableCells += reachable[i]!;
  /* 下界按「海岸崖 + 台地崖壁」吃掉的那部分留余量:改前 18954,现在 17606。 */
  ok(walkableCells > 16000, `从出生点能走到的格数应 > 16000,实际 ${walkableCells}`);
});

/* ─────────── 6 河道连续 ─────────── */

test('FND194-6 河谷连续:沿河心线逐格都是河床(没有断点)', () => {
  const line = riverCenterline();
  ok(line.length >= 140, `河心线长度应 ≥ 140 格,实际 ${line.length}`);
  const gaps: string[] = [];
  for (const p of line) {
    const u = at(p.x, p.y);
    if (u.elev === Elevation.DEEP) continue;
    gaps.push(`(${p.x},${p.y})e${u.elev}`);
  }
  eq(gaps.length, 0, `河道在 ${gaps.length} 处断掉:${gaps.slice(0, 10).join(' ')}`);
  /* 相邻两格必须 4 邻接(轴对齐折线 ⇒ 不许出现跳格)。 */
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    eq(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, `河心线第 ${i} 格与前一格不相邻`);
  }
});

/* ─────────── 7 河的两头 ─────────── */

test('FND194-7 河头在海里、河口在湖里、沙洲是可走的缓坡', () => {
  const line = riverCenterline();
  const head = line[0]!;
  const mouth = line[line.length - 1]!;

  const headU = at(head.x, head.y);
  eq(headU.elev, Elevation.DEEP, '河头在水面高度');
  const dx = head.x + 0.5 - size / 2;
  const dy = head.y + 0.5 - size / 2;
  ok(Math.hypot(dx, dy) > coastRadius(Math.atan2(dy, dx)),
    `河头 (${head.x},${head.y}) 必须在海岸线外(入海口在海里)`);
  eq(regionAt(head.x, head.y), null, '入海口不属于任何区');

  const mouthU = at(mouth.x, mouth.y);
  eq(mouthU.elev, Elevation.DEEP, '河口在水面高度');
  eq(regionAt(mouth.x, mouth.y), 'lake', '河口必须落在湖里(河的尽头是湖)');

  /* 沙洲:河道两侧的沙地,**可走的缓坡**(GOLD_SAND + GROUND),不是墙。 */
  ok(riverBankCells().length > 100, `河岸沙洲应 > 100 格,实际 ${riverBankCells().length}`);
  let bankGround = 0;
  let bankWalkable = 0;
  for (const p of riverBankCells()) {
    const u = at(p.x, p.y);
    if (u.elev === Elevation.GROUND && u.base === BaseFluid.GOLD_SAND) bankGround += 1;
    if (reachable[p.y * size + p.x] === 1) bankWalkable += 1;
  }
  ok(bankGround > 100, `沙洲里落地的格数应 > 100,实际 ${bankGround}`);
  ok(bankWalkable > 100, `沙洲必须能走(不是墙),实际可达 ${bankWalkable}`);
});

/* ─────────── 8 每个区都拿到了抬升 ─────────── */

test('FND194-8 草原/竹林/遗迹/农田/沼泽/沙丘各自都有成规模的抬升', () => {
  /* 阈值 = 实测值的一半左右(实测见下表),只为「这块地被抬过」,不锁死具体布局。 */
  const need: readonly { id: string; min: number; why: string }[] = [
    { id: 'meadow', min: 80, why: '草原台地 74,74 r13' },
    { id: 'grove', min: 60, why: '竹丘 120,54 r10' },
    { id: 'ruins', min: 60, why: '遗迹台基 119..137 × 131..138' },
    { id: 'farm', min: 60, why: '农田梯田 80..106 三条畦面' },
    { id: 'marsh', min: 20, why: '泥沼台地 34,99 r6' },
    { id: 'dunes', min: 60, why: '沙丘主峰 89,151 r7 + 副峰 105,154 r6' },
    { id: 'highland', min: 80, why: '改前就有的高地台地(不许被顺手删掉)' },
    { id: 'mine', min: 120, why: '改前就有的矿丘台地(不许被顺手删掉)' },
  ];
  for (const n of need) {
    const c = reliefByRegion.get(n.id) ?? { p: 0, c: 0 };
    ok(c.p + c.c >= n.min,
      `区 ${n.id} 的抬升格数应 ≥ ${n.min},实际 ${c.p + c.c}(PLATFORM ${c.p} / CLIFF ${c.c})—— ${n.why}`);
  }
  /* 反向:营地**一个抬升格都不许有**(它是出生点与广场)。 */
  const camp = reliefByRegion.get('camp') ?? { p: 0, c: 0 };
  eq(camp.p + camp.c, 0, '营地不许有任何抬升');
});

/* ─────────── 9 台面必须走得上(崖壁不许围满一圈)─────────── */

test('FND194-9 每处台地的台面整块走得上去(崖壁只做扇形)', () => {
  let checked = 0;
  for (const m of MOUNDS) {
    const c = m.cliff;
    if (c === undefined) continue;
    checked += 1;
    ok(c.to - c.from < Math.PI * 2,
      `${m.id} 的崖壁扇区跨度 ${(c.to - c.from).toFixed(2)} rad 必须 < 2π(围满一圈 = 把山封死)`);
    let top = 0;
    let seenTop = 0;
    for (let y = m.cy - m.r; y <= m.cy + m.r; y += 1) {
      for (let x = m.cx - m.r; x <= m.cx + m.r; x += 1) {
        if (Math.hypot(x - m.cx, y - m.cy) >= c.inner) continue;
        if (at(x, y).elev !== Elevation.PLATFORM) continue;
        top += 1;
        if (reachable[y * size + x] === 1) seenTop += 1;
      }
    }
    ok(top >= 5, `${m.id} 的台面应 ≥ 5 格,实际 ${top}`);
    eq(seenTop, top,
      `${m.id} 的台面有 ${top - seenTop} 格走不上去 —— 崖壁把台面围住了(必须留通行口)`);
  }
  ok(checked >= 5, `带崖壁的台地应 ≥ 5 处,实际 ${checked}`);
});

/* ─────────── 10 主路跨河处必须补桥 ─────────── */

test('FND194-10 河道上「两侧都是主路」的格子必须铺桥', () => {
  /* 河道是**在道路之后**挖的(否则会被路面压平),所以被主路压过的河格必须补成
     木桥(310):`elev = DEEP` + `floor != 0` 在可走口径里算路(与跨海栈桥同规则)。
     删掉补桥那一遍 ⇒ 环路/主路在河上断头 ⇒ 这条红。 */
  const roadSlot = floorSlotOfId(309);
  const bridgeSlot = floorSlotOfId(310);
  const deadEnd: string[] = [];
  let bridgesOnCenterline = 0;
  for (const p of riverChannelCells()) {
    const u = at(p.x, p.y);
    if (u.floor === bridgeSlot) {
      ok(u.elev === Elevation.DEEP, `桥面 (${p.x},${p.y}) 必须在 DEEP 上`);
      continue;
    }
    let around = 0;
    for (const [dx, dy] of DIRS) {
      if (at(p.x + dx, p.y + dy).floor === roadSlot) around += 1;
    }
    if (around > 1) deadEnd.push(`(${p.x},${p.y})`);
  }
  eq(deadEnd.length, 0, `河上被主路穿过的水格必须补桥,实际漏了 ${deadEnd.slice(0, 10).join(' ')}`);
  for (const p of riverCenterline()) {
    if (at(p.x, p.y).floor === bridgeSlot) bridgesOnCenterline += 1;
  }
  ok(bridgesOnCenterline >= 8, `河心线上的桥面应 ≥ 8 格,实际 ${bridgesOnCenterline}`);
  /* 桥必须**可走**:这一条与 FND194-5 的 BFS 口径一致,单独再钉一次(桥=路)。 */
  ok(rep.bridgeCells >= bridgesOnCenterline,
    `报告的 bridgeCells(${rep.bridgeCells}) 不许小于河心线上的桥面数(${bridgesOnCenterline})`);
});

/* ─────────── 11 确定性 ─────────── */

test('FND194-11 两次盖章逐格相同(纯函数,没有随机)', () => {
  const again = new Int32Array(size * size).fill(-1);
  applyWorldDesign(mkStub(again), { size });
  let diff = 0;
  for (let i = 0; i < tiles.length; i += 1) {
    if (tiles[i] !== again[i]) diff += 1;
  }
  eq(diff, 0, `两次 applyWorldDesign 应有 ${diff} 格不同(要求 0)`);
});

report('WS-FND-194');
