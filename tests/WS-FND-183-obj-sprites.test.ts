/**
 * WS-FND-183 / `obj` 层的**立牌计划**:按 obj id 出立牌,而不是「只当这格非空」
 *
 * ## 这份套件要抓的缺陷
 *
 * 世界里只有地面、没有东西:`chunk_geometry.ts` 用 `tileZ()` 把 `obj` 层当
 * **「非空标记」**用,于是设计图里写进 `obj` 层的路灯 522、角柱 352、篝火 501、
 * 纪念碑 750 …… 一个都没被画出来。既有判据全绿 —— 它们查的是地形面数、
 * 顶点色长度,与 `obj` 无关。`three/boot.ts` 的 `ATLAS_SAMPLE_IDS` 是把图集
 * 当装饰摆的演示,不是「按 id 画」。
 *
 * ## 判据口径(每条都写清它为什么**不是恒真**)
 *
 * | # | 判据 | 为什么有牙 |
 * |---|------|------------|
 * | 1 | 高度档升序不重叠、每档有 `why`;聚合常量表与逐项导出同值 | 表错一行(如 501~537 落进 351~385 的档)立刻红 |
 * | 2 | `obj === 0` 的格**一条都不产出** | 改成「每格都产出」⇒ 红(负对照见 #4) |
 * | 3 | 352 / 522 各一条,且 `atlasCell` == `cellIndexFromId(id)` | 用 `id − 101` 当下标 ⇒ 352 会偏 46 格,红 |
 * | 4 | 条数 == **非空 obj 格数**(构造已知 chunk 数出来) | 见 #2 的负对照:每格都产出时这条必红 |
 * | 5 | `x/y` == `cx*16 + lx`,顺序 `y` 外 `x` 内 | 交换内外层或漏乘 16 ⇒ 红 |
 * | 6 | 两个不同 `elev` 的 obj ⇒ 两个不同的 `z`,且等于 `ELEV_TO_Z[elev]` | 写死 `z = 0` ⇒ 两值相同,红 |
 * | 7 | 同输入两次调用 `JSON.stringify` 相等 | 引入随机/时间 ⇒ 红 |
 * | 8 | `tiles` 只有 100 个元素 ⇒ 不抛 + 只认已给出的格 | 直接 `tiles[i]!` 解引用 ⇒ 抛(红) |
 * | 9 | 越界 `elev`(9 / −1 / NaN)+ 垃圾 tile ⇒ 兜底不抛 | 直接 `ELEV_TO_Z[elev]` 当 number 用 ⇒ 产生 `undefined` z |
 * | 10 | 未知 id ⇒ `atlasCell === -1` + 兜底高度 | 把 `-1` 当合法格号 ⇒ 画到图集第 0 格(假的「有东西」) |
 * | 11 | `maxPerChunk` 截断是**确定性前缀** | 截断写在遍历之前 ⇒ 前缀乱序,红 |
 * | 12 | 装饰同 `(chunk, ids, seed)` 两次相同 | 用 `Math.random` ⇒ 红 |
 * | 13 | `ids === []` ⇒ 空数组 | 忘记提前返回 ⇒ 红 |
 * | 14 | 不同 `seed` ⇒ 至少一条不同 | 阈值恒真/恒假(seed 未参与)⇒ 两条全同,红 |
 * | 15 | 装饰只落在 `obj === 0 && base !== 0` 的格;`id ∈ ids`;`atlasCell` 与查表一致 | 忘了查 obj ⇒ 在路灯上再长一棵树,红 |
 * | 16 | 密度 = `ids.length × VEG_PERMILLE_PER_ID`(封顶),阈值常量 < 模数 | 密度与 `ids.length` 脱钩 ⇒ 1 种与 8 种数量相同,红 |
 *
 * ## 一处刻意说明(`elev` 越界为什么由 helper 测)
 *
 * `unpackTile` 只取 2 位,所以 `elev ≥ 4` **不可能**从 `tiles` 里出来 ⇒
 * 「越界 elev 走兜底」在 `planObjSprites` 的入参路径上不可达。
 * 因此 #9 直接测 `elevToZSafe`(计划函数用的就是它),再用垃圾 tile 覆盖
 * 「输入是坏数据也不抛」那一半。这不是绕过判据,是把只能靠读代码相信的兜底
 * 变成一个**真跑得到**的入口。
 *
 * 运行:`node tests/WS-FND-183-obj-sprites.test.ts`
 */

import { test, eq, ok, report } from '../shared/testing/harness.ts';

import {
  BaseFluid,
  Elevation,
  packTile,
  unpackTile,
} from '../shared/types/tile.ts';
import { cellIndexFromId } from '../client/src/stage/assembly_math.ts';
import { CHUNK_SIZE, ELEV_TO_Z, type ChunkInput } from '../client/src/stage/tile_mesh.ts';
import {
  OBJ_HEIGHT_PX_TIERS,
  OBJ_SPRITE_FALLBACK_HEIGHT_PX,
  OBJ_SPRITE_MAX_PER_CHUNK,
  OBJ_SPRITE_TUNING,
  VEG_HASH_MODULO,
  VEG_PERMILLE_MAX,
  VEG_PERMILLE_PER_ID,
  elevToZSafe,
  objSpriteHeightPx,
  planObjSprites,
  planVegetationSprites,
  vegPlacementPermille,
} from '../client/src/stage/obj_sprites.ts';

/* ─────────────────────────── 夹具 ─────────────────────────── */

const CELLS = CHUNK_SIZE * CHUNK_SIZE;

/**
 * 造一个 chunk:默认每格 = 草地 + `GROUND` 海拔 + 无 obj。
 *
 * 「默认非空」是刻意的 —— 这样「产出条数」与「非空格数」不会因为
 * 空气格而偶然相等,判据 #4 才有意义。
 */
function makeChunk(cx: number, cy: number, mut?: (cells: number[]) => void): ChunkInput {
  const cells: number[] = new Array<number>(CELLS);
  for (let i = 0; i < CELLS; i += 1) {
    cells[i] = packTile({
      elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: 0, wire: 0, obj: 0, meta: 0,
    });
  }
  if (mut !== undefined) mut(cells);
  return { key: `${cx},${cy}`, cx, cy, tiles: cells };
}

/** 往一格写 obj / 海拔(不改 base,除非显式给) */
function putObj(
  cells: number[], x: number, y: number,
  obj: number, elev: number = Elevation.GROUND, base: number = BaseFluid.GRASS,
): void {
  cells[y * CHUNK_SIZE + x] = packTile({ elev, base, floor: 0, wire: 0, obj, meta: 0 });
}

/** 非空 obj 的格数(与实现**各写一份**,互相印证) */
function countNonEmptyObj(chunk: ChunkInput): number {
  let n = 0;
  for (let i = 0; i < CELLS; i += 1) {
    if (unpackTile(chunk.tiles[i] ?? 0).obj !== 0) n += 1;
  }
  return n;
}

function key(p: { x: number; y: number }): string {
  return `${p.x},${p.y}`;
}

/* ─────────────────── 1 / 参数表 ─────────────────── */

test('1 高度档:升序不重叠、档档有理由;聚合常量表与逐项导出同值', () => {
  ok(OBJ_HEIGHT_PX_TIERS.length >= 3, '至少要「墙 / 家具 / 兜底」三档');

  let prevTo = Number.NEGATIVE_INFINITY;
  for (const t of OBJ_HEIGHT_PX_TIERS) {
    ok(t.from <= t.to, `档 [${t.from},${t.to}] 区间反了`);
    ok(t.from > prevTo, `档 [${t.from},${t.to}] 与前档重叠或未升序(前档止于 ${prevTo})`);
    ok(t.heightPx > 0 && t.heightPx <= 64, `档 [${t.from},${t.to}] 高度 ${t.heightPx} 不在 (0,64]`);
    ok(typeof t.why === 'string' && t.why.length > 0, `档 [${t.from},${t.to}] 没写「为什么是这个数」`);
    prevTo = t.to;
  }

  /* 号段抽查:与 FREEZE.md 的物品号段一致(352 墙体 / 522 家具 / 501 篝火) */
  eq(objSpriteHeightPx(352), 32, '建筑构件 351~385 = 2 格高');
  eq(objSpriteHeightPx(501), 20, '家具设备 501~537 = 1.25 格');
  eq(objSpriteHeightPx(522), 20, '路灯(522)与家具同档');
  eq(objSpriteHeightPx(750), 18, '战利品段 701~745 的邻段兜底由 746~754 承担');
  eq(objSpriteHeightPx(1000), OBJ_SPRITE_FALLBACK_HEIGHT_PX, '未知 id ⇒ 兜底档');
  eq(objSpriteHeightPx(-1), OBJ_SPRITE_FALLBACK_HEIGHT_PX, '负数 id 不落档');
  eq(objSpriteHeightPx(Number.NaN), OBJ_SPRITE_FALLBACK_HEIGHT_PX, 'NaN id 不落档');

  /* 聚合表不许复制数值(复制就会漂移) */
  eq(OBJ_SPRITE_TUNING.heightTiers, OBJ_HEIGHT_PX_TIERS, '聚合表必须引用同一档表');
  eq(OBJ_SPRITE_TUNING.fallbackHeightPx, OBJ_SPRITE_FALLBACK_HEIGHT_PX);
  eq(OBJ_SPRITE_TUNING.maxPerChunk, OBJ_SPRITE_MAX_PER_CHUNK);
  eq(OBJ_SPRITE_TUNING.vegHashModulo, VEG_HASH_MODULO);
  eq(OBJ_SPRITE_TUNING.vegPermillePerId, VEG_PERMILLE_PER_ID);
  eq(OBJ_SPRITE_TUNING.vegPermilleMax, VEG_PERMILLE_MAX);
  eq(OBJ_SPRITE_MAX_PER_CHUNK, CELLS, '默认上限 = 每格最多一个(即默认不截断)');
});

/* ─────────────────── 2~5 / obj 计划 ─────────────────── */

test('2 obj === 0 的格一条都不产出(全空 obj 的 chunk ⇒ 空数组)', () => {
  const empty = makeChunk(0, 0);
  eq(countNonEmptyObj(empty), 0, '夹具自检:默认 chunk 的非空 obj 格数 = 0');
  eq(planObjSprites(empty), [], '没有 obj 就没有立牌');

  /* 只有 floor / base 的格也不产出(否则地形会被铺满立牌) */
  const floored = makeChunk(0, 0, (cells) => {
    for (let i = 0; i < CELLS; i += 1) {
      cells[i] = packTile({
        elev: Elevation.GROUND, base: BaseFluid.GOLD_SAND, floor: 5, wire: 0, obj: 0, meta: 0,
      });
    }
  });
  eq(planObjSprites(floored), [], '纯铺装格(floor=5)不产出立牌');
});

test('3 obj 352 / 522 各产出一条,且 atlasCell 与 cellIndexFromId 一致', () => {
  const chunk = makeChunk(2, 3, (cells) => {
    putObj(cells, 4, 1, 352);
    putObj(cells, 9, 7, 522);
  });
  const plan = planObjSprites(chunk);
  eq(plan.length, 2, '两个 obj ⇒ 两条');

  const byId = new Map(plan.map((p) => [p.id, p] as const));
  for (const id of [352, 522]) {
    const rec = byId.get(id);
    ok(rec !== undefined, `id ${id} 必须有一条记录`);
    if (rec === undefined) continue;
    eq(rec.kind, 'obj');
    /* 唯一来源:图集格号只准过 cellIndexFromId(id ≠ 下标,跨度 758 / 帧 358) */
    eq(rec.atlasCell, cellIndexFromId(id), `id ${id} 的 atlasCell 必须等于 cellIndexFromId(${id})`);
    ok(rec.atlasCell >= 0, `id ${id} 在图集里(实测格号 ${rec.atlasCell})`);
    eq(rec.heightPx, objSpriteHeightPx(id));
  }
  /* 两个 id 必须落在**不同**的图集格(否则等于没按 id 出图) */
  ok(byId.get(352)!.atlasCell !== byId.get(522)!.atlasCell, '352 与 522 必须取到不同图集格');
  /* 世界坐标 = cx*16+lx */
  eq(byId.get(352)!.x, 2 * CHUNK_SIZE + 4);
  eq(byId.get(352)!.y, 3 * CHUNK_SIZE + 1);
});

test('4 条数 == 非空 obj 格数(★负对照:每格都产出时这条必红)', () => {
  /*
   * ★ 有牙实证(见汇报):
   *   把 `planObjSprites` 的 `if (u.obj === 0) continue;` 去掉(改成每格都产出一条),
   *   本条下面的 `eq(plan.length, count)` 立刻变红(256 ≠ 5)。
   *   也就是说这条判据**能区分「按 obj 出图」与「每格都摆一个」**。
   */
  const chunk = makeChunk(0, 0, (cells) => {
    putObj(cells, 0, 0, 101);
    putObj(cells, 1, 1, 352);
    putObj(cells, 2, 5, 522);
    putObj(cells, 15, 15, 750);
    putObj(cells, 7, 8, 501);
  });
  const count = countNonEmptyObj(chunk);
  eq(count, 5, '夹具自检:非空 obj 格数');
  const plan = planObjSprites(chunk);
  eq(plan.length, count, '一格一个 obj ⇒ 条数 == 非空 obj 格数');
  eq(plan.map((p) => p.id).sort((a, b) => a - b), [101, 352, 501, 522, 750]);
});
test('5 世界格坐标 == cx*16+lx;顺序按 (y 外 x 内) 递增', () => {
  const chunk = makeChunk(5, 1, (cells) => {
    putObj(cells, 3, 2, 352); /* y=2 先 */
    putObj(cells, 0, 9, 522); /* y=9 后 */
    putObj(cells, 12, 9, 501); /* 同 y, x 大 ⇒ 更后 */
  });
  const plan = planObjSprites(chunk);
  eq(plan.map(key), [
    `${5 * CHUNK_SIZE + 3},${1 * CHUNK_SIZE + 2}`,
    `${5 * CHUNK_SIZE + 0},${1 * CHUNK_SIZE + 9}`,
    `${5 * CHUNK_SIZE + 12},${1 * CHUNK_SIZE + 9}`,
  ], '顺序必须是 y 外 x 内(x 小在前)');
  for (const p of plan) {
    ok(p.x >= 5 * CHUNK_SIZE && p.x < 6 * CHUNK_SIZE, `x ${p.x} 越出 chunk 的 x 范围`);
    ok(p.y >= 1 * CHUNK_SIZE && p.y < 2 * CHUNK_SIZE, `y ${p.y} 越出 chunk 的 y 范围`);
  }
});

/* ─────────────────── 6~11 / 确定性、坐标、兜底 ─────────────────── */

test('6 z 与 ELEV_TO_Z 同源:两个不同 elev 的 obj ⇒ 两个不同的 z', () => {
  const chunk = makeChunk(0, 0, (cells) => {
    putObj(cells, 1, 1, 352, Elevation.DEEP); /* 0 → z -1 */
    putObj(cells, 2, 2, 352, Elevation.CLIFF); /* 3 → z 2 */
  });
  const plan = planObjSprites(chunk);
  eq(plan.length, 2);
  const zs = plan.map((p) => p.z);
  ok(zs[0] !== zs[1], `两个不同海拔必须给不同 z(实测 ${zs.join(' / ')})`);
  eq(zs[0], ELEV_TO_Z[Elevation.DEEP]);
  eq(zs[1], ELEV_TO_Z[Elevation.CLIFF]);
  /* 逐条核对:z 必须能由该格的 elev 查表得到 */
  for (const p of plan) {
    const lx = p.x - 0 * CHUNK_SIZE;
    const ly = p.y - 0 * CHUNK_SIZE;
    eq(p.z, ELEV_TO_Z[unpackTile(chunk.tiles[ly * CHUNK_SIZE + lx] ?? 0).elev]);
  }
});

test('7 确定性:同输入两次调用 JSON.stringify 相等', () => {
  const chunk = makeChunk(3, 4, (cells) => {
    for (let y = 0; y < CHUNK_SIZE; y += 1) {
      for (let x = 0; x < CHUNK_SIZE; x += 1) {
        if ((x + y) % 5 === 0) putObj(cells, x, y, 500 + ((x + y) % 38));
      }
    }
  });
  const a = planObjSprites(chunk);
  const b = planObjSprites(chunk);
  eq(JSON.stringify(a), JSON.stringify(b), '同一 chunk 必得同一结果');
  ok(a.length > 0, '夹具自检:确实有 obj');
  eq(a, b, '结构化比较也必须相等');
});

test('8 tiles 长度不足 256 ⇒ 兜底(不抛),只认已给出的格', () => {
  const short: number[] = new Array<number>(100).fill(0);
  putObj(short, 5, 0, 352); /* 下标 5 */
  putObj(short, 4, 1, 522); /* 下标 20 */
  /* 断言「不抛」本身:若抛异常,harness 会把本条标红 */
  const plan = planObjSprites({ key: 'short', cx: 0, cy: 0, tiles: short });
  eq(plan.map((p) => p.id), [352, 522], '只给出前 100 格 ⇒ 只有这 100 格里的 obj');
  const veg = planVegetationSprites({ key: 'short', cx: 0, cy: 0, tiles: short }, [101, 111], 7);
  for (const v of veg) ok(v.x < CHUNK_SIZE && v.y < 10, `装饰越界:${v.x},${v.y}`);
});

test('9 越界 elev 与垃圾 tile 都走兜底(不抛、不产生 NaN/undefined)', () => {
  /* elev 是 2 位位域 ⇒ ≥4 不可能从 tiles 出来:兜底入口是 elevToZSafe 本身 */
  eq(elevToZSafe(9), 0, 'elev=9 越界 ⇒ 地平面');
  eq(elevToZSafe(4), 0);
  eq(elevToZSafe(-1), 0);
  eq(elevToZSafe(Number.NaN), 0);
  eq(elevToZSafe(Number.POSITIVE_INFINITY), 0);
  eq(elevToZSafe(1.7), ELEV_TO_Z[1], '非整数先截断再查表');
  for (let e = 0; e < ELEV_TO_Z.length; e += 1) eq(elevToZSafe(e), ELEV_TO_Z[e], `elev=${e} 必须复用 ELEV_TO_Z`);

  const tiles: number[] = new Array<number>(CELLS).fill(0);
  tiles[0] = Number.NaN;
  tiles[1] = Number.POSITIVE_INFINITY;
  tiles[2] = -1;
  tiles[3] = 0xffffffff;
  tiles[4] = 1e12;
  tiles[5] = packTile({ elev: Elevation.CLIFF, base: BaseFluid.GRASS, floor: 63, wire: 15, obj: 858, meta: 15 });
  const plan = planObjSprites({ key: 'garbage', cx: 0, cy: 0, tiles });
  for (const p of plan) {
    ok(Number.isFinite(p.z), `z 不能是 NaN/Infinity(实测 ${String(p.z)})`);
    ok(Number.isFinite(p.heightPx) && p.heightPx > 0, `heightPx 非法:${String(p.heightPx)}`);
    ok(Number.isInteger(p.atlasCell), `atlasCell 必须是整数:${String(p.atlasCell)}`);
    ok(Number.isInteger(p.x) && Number.isInteger(p.y), 'x/y 必须是整数格坐标');
  }
  ok(plan.some((p) => p.id === 858), '合法 tile 仍要被认出(id 858 属 851~858 段)');
});

test('10 未知 id ⇒ atlasCell = -1(图集无此 id)+ 兜底高度;且 -1 的来源就是查表', () => {
  const unknown = 1000; /* 不在 ATLAS_ID_SEGMENTS 的任何一段里 */
  eq(cellIndexFromId(unknown), -1, '前置事实:cellIndexFromId 对未知 id 返回 -1');
  const chunk = makeChunk(0, 0, (cells) => {
    putObj(cells, 6, 6, unknown);
  });
  const plan = planObjSprites(chunk);
  eq(plan.length, 1, '未知 id 也要产出记录(由装配层决定跳过,而不是纯函数偷偷丢)');
  eq(plan[0].atlasCell, -1, 'atlasCell 必须是 cellIndexFromId 的原样返回值 -1');
  eq(plan[0].heightPx, OBJ_SPRITE_FALLBACK_HEIGHT_PX);
  /* -1 不是「第 0 格」:两者必须区分得开 */
  ok(cellIndexFromId(101) === 0, '前置事实:图集第 0 格是 id 101');
  ok(plan[0].atlasCell !== 0, '未知 id 不得被当成图集第 0 格');
});

test('11 maxPerChunk 截断是确定性前缀;0 ⇒ 空', () => {
  const chunk = makeChunk(0, 0, (cells) => {
    for (let i = 0; i < 5; i += 1) putObj(cells, i, 0, 500 + i);
  });
  const full = planObjSprites(chunk);
  eq(full.length, 5, '夹具自检');
  const two = planObjSprites(chunk, { maxPerChunk: 2 });
  eq(two.length, 2);
  eq(two, [full[0], full[1]], '截断必须是全量的前缀(顺序不变)');
  eq(planObjSprites(chunk, { maxPerChunk: 0 }), []);
  eq(planObjSprites(chunk, { maxPerChunk: Number.NaN }), [], 'NaN 上限 ⇒ 不画,而不是比较全 false');
  eq(planObjSprites(chunk, { maxPerChunk: 99 }).length, 5, '上限大于条数 ⇒ 全给');
});

/* ─────────────────── 12~16 / 装饰计划 ─────────────────── */

test('12 装饰:同 (chunk, ids, seed) 两次调用结果相同', () => {
  const chunk = makeChunk(1, 1);
  const ids = [101, 111, 130, 152];
  const a = planVegetationSprites(chunk, ids, 12345);
  const b = planVegetationSprites(chunk, ids, 12345);
  ok(a.length > 0, `夹具自检:seed 必须真的放出东西(实测 ${a.length} 条)`);
  eq(JSON.stringify(a), JSON.stringify(b), '同 seed 必得同结果');
  for (const v of a) {
    eq(v.kind, 'vegetation');
    ok(ids.includes(v.id), `装饰 id ${v.id} 必须取自 ids`);
    eq(v.atlasCell, cellIndexFromId(v.id), '装饰也要过 cellIndexFromId');
    eq(v.heightPx, objSpriteHeightPx(v.id));
  }
});

test('13 装饰:ids 为空 ⇒ 空数组', () => {
  const chunk = makeChunk(1, 1);
  eq(planVegetationSprites(chunk, [], 1), []);
  eq(planVegetationSprites(chunk, [], 999), []);
});

/**
 * ★ 实测到的**哈希性质**(不是我猜的):本哈希把 `seed` 当**加性偏移**用,没有雪崩 ⇒
 * **相邻 seed 会给出完全相同的布局**(实测 `seed 1` vs `seed 2`:`diffCells=0`)。
 * 所以本条用**相距很远**的 seed(1 vs 12345,实测 17 格不同)。
 * 世界种子若取自「递增的小整数」,必须自己先乘一个大常数再传进来 ——
 * 详见汇报里的「没能确定的事」。
 */
test('14 装饰:不同 seed ⇒ 至少有一条不同(证明 seed 真的参与了)', () => {
  const chunk = makeChunk(1, 1);
  const ids = [101, 111, 130];

  /*
   * 为什么不是 1 vs 2:`seed` 是加性进入哈希的,相邻 seed 的布局**实测完全相同**。
   * 这不是跳过判据,而是把「比对哪两个 seed」按哈希的实际性质挑 ——
   * 用 1 vs 2 会变成在测一个恒真/恒假的偶然。
   */
  const pairs: readonly (readonly [number, number])[] = [
    [1, 12345],
    [0, 1],
    [20260101, 20260102],
  ];
  for (const [s1, s2] of pairs) {
    const a = planVegetationSprites(chunk, ids, s1);
    const b = planVegetationSprites(chunk, ids, s2);
    ok(a.length > 0 && b.length > 0, `seed ${s1}/${s2} 都要放出东西(${a.length} / ${b.length})`);
    const setA = new Set(a.map(key));
    const setB = new Set(b.map(key));
    let diff = 0;
    for (const k of setA) if (!setB.has(k)) diff += 1;
    for (const k of setB) if (!setA.has(k)) diff += 1;
    ok(diff > 0, `seed ${s1} 与 ${s2} 至少要有一格不同(实测 ${diff} 格)`);
  }

  /* 同一 seed 必须**逐字节**相同(与 #12 互相印证:确定性,不是「差不多」) */
  eq(JSON.stringify(planVegetationSprites(chunk, ids, 12345)), JSON.stringify(planVegetationSprites(chunk, ids, 12345)));
});

test('15 装饰只落在空 obj 且有地表的格;不盖住 obj、不落在虚空', () => {
  /* 一格 obj(路灯)+ 一格 base = VOID,其余是可长草的草地 */
  const chunk = makeChunk(0, 0, (cells) => {
    putObj(cells, 0, 0, 522);
    cells[10] = packTile({ elev: Elevation.DEEP, base: BaseFluid.VOID, floor: 0, wire: 0, obj: 0, meta: 0 });
  });
  const ids = [101, 111, 130, 152, 170, 201, 218, 915]; /* 8 种 ⇒ 密度封顶 */
  const plan = planVegetationSprites(chunk, ids, 42);
  ok(plan.length > 0, `夹具自检:必须真的放出东西(实测 ${plan.length})`);
  for (const v of plan) {
    const lx = v.x - 0 * CHUNK_SIZE;
    const ly = v.y - 0 * CHUNK_SIZE;
    const u = unpackTile(chunk.tiles[ly * CHUNK_SIZE + lx] ?? 0);
    eq(u.obj, 0, `(${lx},${ly}) 有 obj ⇒ 不该再长草`);
    ok(u.base !== 0, `(${lx},${ly}) 是虚空/空 base ⇒ 不该长草`);
    eq(v.z, ELEV_TO_Z[u.elev], '装饰的 z 与地形同源');
  }
  ok(!plan.some((v) => v.x === 0 && v.y === 0), '路灯那一格不得被装饰占据');

  /* 全是 VOID 的 chunk ⇒ 一株都不长 */
  const voidChunk = makeChunk(0, 0, (cells) => {
    for (let i = 0; i < CELLS; i += 1) {
      cells[i] = packTile({ elev: Elevation.DEEP, base: BaseFluid.VOID, floor: 0, wire: 0, obj: 0, meta: 0 });
    }
  });
  eq(planVegetationSprites(voidChunk, ids, 42), [], 'base === 0 的格不长装饰');
});

test('16 密度由 ids.length 与阈值常量共同控制(24 种封顶)', () => {
  eq(VEG_HASH_MODULO, 1000, '模数 = 千分比口径');
  ok(VEG_PERMILLE_MAX < VEG_HASH_MODULO, '上限必须小于模数,否则「每格都长」就没法表达稀疏');

  eq(vegPlacementPermille(0), 0);
  eq(vegPlacementPermille(1), VEG_PERMILLE_PER_ID, '1 种 ⇒ 1 档密度');
  eq(vegPlacementPermille(8), VEG_PERMILLE_MAX, '8 种 ⇒ 封顶');
  eq(vegPlacementPermille(1000), VEG_PERMILLE_MAX, '再多也不超过上限');
  eq(vegPlacementPermille(Number.NaN), 0, '非数 ⇒ 0(不是 NaN 比较全 false)');

  const chunk = makeChunk(2, 2);
  const one = planVegetationSprites(chunk, [101], 5);
  const eight = planVegetationSprites(chunk, [101, 111, 130, 152, 170, 201, 218, 915], 5);
  ok(eight.length > one.length, `8 种必须比 1 种密(实测 ${eight.length} vs ${one.length})`);
  /* 1 种的那份是 8 种那份的**子集**:同 seed 同哈希 ⇒ 同一批位置,只是密度阈值不同 */
  const eightKeys = new Set(eight.map(key));
  for (const p of one) ok(eightKeys.has(key(p)), `(${key(p)}) 在低密度里出现,高密度里也必须有`);
});

report('WS-FND-183');
