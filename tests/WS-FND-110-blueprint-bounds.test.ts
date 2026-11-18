/**
 * WS-FND-110 —— 第四轮实测的**五处边界缺陷**的判据(蓝图码 3 条 + 布线视图 2 条 + 房间配方 2 条
 * + 接力/审计 2 条)。
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | 蓝图码里 `run = 5×10^14` ⇒ **立刻抛**「超出尺寸上界」;合法码照常解 | `decodeBlueprint` 先展开游程、后判格数 ⇒ **一张小码就能挂死/爆内存** | `blueprint.ts` 把上界判断移回 `for (k < run) cells.push(...)` **之后** |
 * | 2 | `run = MAX_RUN_CELLS`(=16384)合法、`+1` 非法 | 上界必须是**具名**常量,且不误伤 128×128 的合法单游程 | 把 `MAX_RUN_CELLS` 调成 `BLUEPRINT_MAX_CELLS / 2` |
 * | 3 | 空蓝图在**编码入口**被拒(格数 ≠ 尺寸);旧 `run=0` 码解码仍抛 | encode 空 cells 产 `run=0` ⇒ 报错指向解码器,根因在编码入口 | 删掉 `encodeBlueprint` 的 `cells.length !== w*h` 校验 |
 * | 4 | `overlapCells` = **格**口径(3 色格只算 1 格) | 字段文档写「两色以上重叠的格数」,实现返回 Σ(色数−1);本地计数成死代码 | `wiring_view.ts` 改回 `Math.max(0, perColorWiredCells - wiredCells)` |
 * | 5 | `serializeWireView` 对 >255 的游程**分段发**(512 宽一行不丢格) | `Math.min(run, 255)` 直接丢掉溢出格 ⇒ 反序列化错位、丢线且不报错 | 删掉 `emit` 的分段循环,恢复 `Math.min(run, MAX_WIRE_RUN)` |
 * | 6 | 地砖层(304)与围合环(357)里的配方可选件**真的能命中** | 只数「内部非 barrier 的 OBJ 层」⇒ SAKURA_ONSEN / ECO_RANCH 可选加分恒 0 | `rooms.ts` 的 `inventory` 只留 `objects` |
 * | 7 | 接力选项非法值 ⇒ **入口抛**;合法值照常派活 | `buildRelayQueue` 的 `void options` + `Math.max(1, …)` 静默夹取 / `perBuilderParallel ≤ 0` 永不派活 | 删掉 `assertRelayOptions` 的两处调用 |
 * | 8 | 数据审计的「房间配方数」不再硬编码 8(与表内 9 条恒冲突) | 期望值钉死字面量 8 ⇒ 这一项**恒判 UNKNOWN**(空壳判据) | `scripts/data-conformance.ts` 写回 `ROOM_RECIPES.length === 8` |
 *
 * ## 诚实边界(必须读)
 *
 * `ROOM_RECIPES` 里的**纯材料类**可选件(109 白玉温泉石 / 155 黄铜锭 / 158 精密发条齿轮)
 * 不进任何 tile 层(它们是 N/R 类材料,不是可放置构件),因此「按层修正」在原理上
 * 覆盖不到它们 —— 那要改 `shared/constants/bosses.ts` 的配方条目,而该表被内容指纹
 * (`contentFingerprints().bosses/modes`)+ `tests/WS-05` / `tests/WS-FND-06` 冻结,
 * 不在本文件(与 `build/**`)的可裁决范围。
 *   ⇒ 本文件钉的是**同一处缺陷里能钉的那一半**:可选件在 OBJ / FLOOR / 围合环三层里
 *      都必须能被数到(304 与 357 就是改前**恒不命中**的两条),以及负对照
 *      「没铺那种地砖 / 没用那种墙 ⇒ 不命中」。
 *
 * 运行:`node tests/WS-FND-110-blueprint-bounds.test.ts`
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, includes, report } from '../shared/testing/harness.ts';
import { packTile, setWire, WireColor } from '../shared/types/tile.ts';
import { TileGrid } from '../server/src/build/grid.ts';
import {
  BLUEPRINT_MAX_CELLS, MAX_RUN_CELLS, blueprintCode, captureBlueprint, decodeBlueprint,
  encodeBlueprint, buildRelayQueue, RelayQueue, RelayTaskState,
  toBase64, DEFAULT_RELAY_OPTIONS,
} from '../server/src/build/blueprint.ts';
import {
  MAX_WIRE_RUN, buildWireView, serializeWireView,
} from '../server/src/build/wiring_view.ts';
import {
  DEFAULT_SCAN_OPTIONS, NORMALIZED_RECIPES, floodRoom, identifyRoom, placeInRoom, scoreRoom,
  stampBoxRoom,
} from '../server/src/build/rooms.ts';
import { ROOM_RECIPES } from '../shared/constants/bosses.ts';
import { floorSlotOfId } from '../server/src/world/chunk.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ══════════════════ 夹具 ══════════════════ */

/** 手写 varint(与 `blueprint.ts#pushVarint` 同构;那份刻意没导出,故测试侧自备)。 */
function varintBytes(v: number): number[] {
  const out: number[] = [];
  let n = Math.trunc(v);
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

/**
 * 手工拼一张 `w×h` 蓝图码(三元组流 = `[value][run]` 交替)。
 * 这是**攻击者视角**的入口: decoder 只信这段字节,不看编码器产出。
 */
function codeOf(w: number, h: number, triples: readonly (readonly [number, number])[]): string {
  const bytes: number[] = [];
  for (const [value, run] of triples) bytes.push(...varintBytes(value), ...varintBytes(run));
  return `BP1:${w}x${h}:${toBase64(bytes)}`;
}

/** 断言「必须抛」并且报文里含 `needle`(只断言抛会漏掉「抛错原因错了」)。 */
function throwsWith(fn: () => unknown, needle: string, msg: string): void {
  let err: unknown = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  ok(err !== null, `${msg}:必须抛出异常,实际没抛`);
  ok(
    String(err).includes(needle),
    `${msg}:报文应含「${needle}」,实际「${String(err)}」`,
  );
}

/** 无暗线的空格(所有暗线场景的基值)。 */
const BARE = packTile({ elev: 1, base: 0, floor: 0, wire: 0, obj: 0, meta: 0 });

/** 按 `serializeWireView` 的格式逐行解码,返回**每行解出的格数**(需要 width 才能切行)。 */
function wireRowCellCounts(bytes: readonly number[], width: number): number[] {
  const rows: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let cells = 0;
    while (i < bytes.length && cells < width) {
      cells += bytes[i + 1];
      i += 2;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 一间 `7×7` 盒子小屋(内部 5×5 = 25 格),墙用 `wallId`、内部地砖用槽位 `floorSlot`。
 * 不用 `stampBoxRoom` 的门参数 ⇒ 完全封闭(闭合成房间、doorCount = 0)。
 */
function boxRoom(wallId: number, floorSlot: number, items: readonly number[]): ReturnType<typeof floodRoom> {
  const g = new TileGrid(24, 24);
  stampBoxRoom(g, {
    x: 2, y: 2, w: 7, h: 7, wallId, floorId: floorSlot, doorAtCol: -1, extraDoorAtCols: [],
  });
  items.forEach((id, i) => placeInRoom(g, 4 + (i % 3), 4 + Math.floor(i / 3), id));
  return floodRoom(g, 3, 3, DEFAULT_SCAN_OPTIONS);
}

function recipe(key: string): (typeof NORMALIZED_RECIPES)[number] {
  const r = NORMALIZED_RECIPES.find((x) => x.key === key);
  if (r === undefined) throw new Error(`夹具:找不到配方 ${key}`);
  return r;
}

/* ══════════════════ 1~3. 蓝图码:游程上界与空蓝图入口 ══════════════════ */

test('FND110-1 蓝图码:超大游程在**展开前**被拒(不挂死、不 OOM)', () => {
  /*
   * `run = 5×10^14`:7 字节 varint,完全落在 `readVarint` 的合法位宽内
   * (它连 `shift > 42` 那道守卫都不触发)。旧实现会先
   * `for (k < run) cells.push(...)` —— 5×10^14 次 push,进程挂死/爆内存,
   * 而「解出格数超过尺寸」那句守卫永远等不到执行。
   *   ⇒ 本条的判据形态是「**这个测试能跑完**并且抛出指向上界的错」。
   */
  throwsWith(() => decodeBlueprint(codeOf(16, 16, [[0, 5e14]])), '超出尺寸上界', 'run=5×10^14 必须立刻抛');

  /* 负对照:run 只比尺寸大 1(16×16 ⇒ 256 格,run=257)也必须拒 */
  throwsWith(() => decodeBlueprint(codeOf(16, 16, [[0, 257]])), '超出尺寸上界', 'run=257 > 256 必须拒');

  /* 正对照:合法码照常解 —— 守卫不是「一律拒」 */
  const good = captureBlueprint(new TileGrid(16, 16), 0, 0);
  eq(decodeBlueprint(blueprintCode(good)).cells.length, 256, '合法 16×16 码仍应解出 256 格');
});

test('FND110-2 run 的**具名**上限:MAX_RUN_CELLS 合法,+1 非法(不误伤 128×128 单游程)', () => {
  eq(MAX_RUN_CELLS, BLUEPRINT_MAX_CELLS, 'MAX_RUN_CELLS 必须锚在单张蓝图格数上限(16384)上');
  eq(MAX_RUN_CELLS, 16384, '上界就是 16384(独立字面量:128×128)');

  /* 全空 128×128 ⇒ 恰好一个 16384 的游程 ⇒ 必须能解(上界不误伤合法码) */
  const big = captureBlueprint(new TileGrid(128, 128), 0, 0, 128, 128);
  eq(encodeBlueprint(big).runs, 1, '全空 128×128 只需 1 个游程');
  eq(decodeBlueprint(blueprintCode(big)).cells.length, 16384, '16384 格的单游程必须能解');

  throwsWith(
    () => decodeBlueprint(codeOf(128, 128, [[0, MAX_RUN_CELLS + 1]])),
    '超出尺寸上界',
    'run = 上界 + 1 必须拒',
  );
});

test('FND110-3 空蓝图在**编码入口**被拒(round-trip 不再断在解码器)', () => {
  const empty = { w: 16, h: 16, cells: [], originX: 0, originY: 0 };
  throwsWith(() => encodeBlueprint(empty), '格数与尺寸不符', '0 格蓝图必须在编码入口被拒');
  throwsWith(() => encodeBlueprint({ ...empty, w: 0, h: 0 }), '尺寸非法', '0×0 尺寸必须被拒');

  /* 负对照:只差 1 格也拒(不是只挡「恰好 0 格」这一种形态) */
  const bp = captureBlueprint(new TileGrid(16, 16), 0, 0);
  throwsWith(
    () => encodeBlueprint({ ...bp, cells: bp.cells.slice(0, 255) }),
    '格数与尺寸不符',
    '255 格 vs 16×16 必须被拒',
  );

  /* 负对照 2:解码侧对「run = 0」的既有损坏码仍然抛 —— 收窄的是编码入口,不是解码守卫 */
  throwsWith(() => decodeBlueprint(codeOf(16, 16, [[0, 0]])), '游程长度为 0', 'run=0 的码仍是损坏码');

  /* 正对照:合法蓝图 round-trip 完好 */
  eq(decodeBlueprint(blueprintCode(bp)).cells.length, 256, '合法蓝图 round-trip 仍完好');
});

/* ══════════════════ 4~5. 布线视图:重叠口径 + 游程分段 ══════════════════ */

test('FND110-4 overlapCells 统一到**格**口径:3 色格只算 1(负对照:无 3 色格时两口径才相等)', () => {
  const g = new TileGrid(8, 8);
  /* (1,1) 三色:红+蓝+黄;(2,2) 两色:红+蓝 */
  g.set(1, 1, setWire(setWire(setWire(BARE, WireColor.RED, true), WireColor.BLUE, true), WireColor.YELLOW, true));
  g.set(2, 2, setWire(setWire(BARE, WireColor.RED, true), WireColor.BLUE, true));
  const view = buildWireView(g);
  eq(view.wiredCells, 2, '并集口径:2 格');
  eq(view.perColorWiredCells, 5, '色·格口径:3 + 2 = 5');
  eq(view.overlapCells, 2, '★ 格口径:两格都叠了 ≥2 色 ⇒ 2(旧实现按差值给 3)');
  ok(
    view.overlapCells !== view.perColorWiredCells - view.wiredCells,
    `★ 存在 3 色格时两个口径必须**不相等**:格 ${view.overlapCells} vs 差 ${view.perColorWiredCells - view.wiredCells}`,
  );

  /* 负对照:没有 3 色格时两口径相等(WS-03 那条不变式的形态仍然成立) */
  const two = new TileGrid(8, 8);
  two.set(1, 1, setWire(setWire(BARE, WireColor.RED, true), WireColor.BLUE, true));
  const v2 = buildWireView(two);
  eq(v2.overlapCells, 1, '两色格:1');
  eq(v2.perColorWiredCells - v2.wiredCells, v2.overlapCells, '无 3 色格时差值 = 格数');

  /* 负对照 2:单色场景 ⇒ 0(不是「有线就算重叠」) */
  const one = new TileGrid(8, 8);
  one.set(1, 1, setWire(BARE, WireColor.RED, true));
  eq(buildWireView(one).overlapCells, 0, '单色不重叠 ⇒ 0');
});

test('FND110-5 serializeWireView:>255 的同值游程**分段发**,512 宽一行不丢格', () => {
  const g = new TileGrid(512, 2);
  const red = setWire(BARE, WireColor.RED, true);
  const blue = setWire(BARE, WireColor.BLUE, true);
  for (let x = 0; x < 512; x += 1) g.set(x, 0, red);
  for (let x = 0; x < 512; x += 1) g.set(x, 1, x < 300 ? red : blue);
  const view = buildWireView(g);
  eq(view.width, 512, '前提:视图宽 512(> 255)');

  const bytes = serializeWireView(view);
  for (let i = 1; i < bytes.length; i += 2) {
    ok(
      bytes[i] >= 1 && bytes[i] <= MAX_WIRE_RUN,
      `第 ${i} 字节(游程)必须在 1..${MAX_WIRE_RUN},实际 ${bytes[i]}(0 或 >255 都会让解码器错位)`,
    );
  }
  eq(
    wireRowCellCounts(bytes, view.width),
    [512, 512],
    '★ 每行解出的格数必须等于 512(旧实现 Math.min 截断 ⇒ 第一行只有 255)',
  );
  /* 精确切分:512 = 255 + 255 + 2 ⇒ 3 对;第二行 300 = 255 + 45,212 ⇒ 3 对 */
  eq(bytes.length, 12, '512 宽两行共 6 对 = 12 字节');

  /* 负对照:一行 ≤255 的场景字节数不变(分段不是「一律多吐」) */
  const small = new TileGrid(16, 1);
  for (let x = 0; x < 16; x += 1) small.set(x, 0, red);
  eq(serializeWireView(buildWireView(small)), [1, 16], '负对照:16 宽同色一行仍是 `[值, 16]`');
  eq(MAX_WIRE_RUN, 255, '游程上限就是单字节能装的 255(独立字面量)');
});

/* ══════════════════ 6~7. 房间配方的三层口径 ══════════════════ */

test('FND110-6 SAKURA_ONSEN 可选件 304(地砖层)可命中(负对照:换地砖则不得命中)', () => {
  const tatami = floorSlotOfId(304);
  eq(tatami, 4, '304 的槽位 = 4(槽位↔物品由 WS-01 的 floorIdOfSlot 定义)');

  const room = boxRoom(352, tatami, [526]);
  ok(room.closed, '前提:房间闭合');
  const onsen = recipe('SAKURA_ONSEN');
  const m = scoreRoom(room, onsen);
  ok(m.matched, '必需件 526 命中 ⇒ matched');
  includes(m.hitOptional, 304, '★ 地砖 304 必须进可选命中(旧口径只数 OBJ 层 ⇒ 恒 0)');
  ok(!m.hitOptional.includes(109), '负对照:纯材料 109 不在任何 tile 层 ⇒ 不命中(要改得改配方条目)');
  eq(m.score, 100 + 5 + 5 + 3, '100 + 可选 5 + 甜点区 5 + 围合 3');

  eq(room.objects.get(304), undefined, '★ 旧口径的读口:内部 OBJ 层里**没有** 304(改前的死因)');
  eq(room.inventory.get(304), 25, '新口径:25 格榻榻米都在场');
  eq(room.floorItems.has(304), true, 'floorItems 里是 304');
  eq(room.floorSet.has(tatami), true, 'floorSet 仍是槽位口径(4)');

  /* 负对照:同一间房换成大理石地砖(306)⇒ 304 一条都不命中 */
  const other = boxRoom(352, floorSlotOfId(306), [526]);
  const m2 = scoreRoom(other, onsen);
  eq(m2.hitOptional.length, 0, '负对照:换成 306 ⇒ 可选命中 0');
  ok((other.inventory.get(306) ?? 0) > 0, '负对照的前提:306 确实在场');
  eq(identifyRoom(other).key, 'SAKURA_ONSEN', '房间仍识别为温泉馆(识别只看必需件)');
});

test('FND110-7 ECO_RANCH 可选件 357(围合环上的半高篱笆)可命中(负对照:普通墙体不命中)', () => {
  const room = boxRoom(357, 6, [529]);
  ok(room.closed, '前提:357 半高篱笆默认计入围合(sealSemiOpen=true)');
  const ranch = recipe('ECO_RANCH');
  const m = scoreRoom(room, ranch);
  ok(m.matched, '必需件 529 命中 ⇒ matched');
  includes(m.hitOptional, 357, '★ 围合环上的 357 必须进可选命中');
  ok(!m.hitOptional.includes(360), '负对照:没铺 360 就不命中');
  eq(m.score, 100 + 5 + 5 + 3, '100 + 可选 5 + 甜点区 5 + 围合 3');

  eq(room.objects.get(357), undefined, '★ 旧口径:围合格不在 cells 里 ⇒ objects 看不到 357');
  ok((room.ringObjects.get(357) ?? 0) > 0, '新口径:ringObjects 统计到 357');
  ok((room.inventory.get(357) ?? 0) > 0, 'inventory 里也有 357');
  eq(identifyRoom(room).key, 'ECO_RANCH', '识别为生态牧场');

  /* 负对照:换成红砖墙 352 ⇒ 357/360 都不命中 */
  const brick = boxRoom(352, 6, [529]);
  eq(scoreRoom(brick, ranch).hitOptional.length, 0, '负对照:红砖墙房间 ⇒ 可选命中 0');
  ok((brick.ringObjects.get(352) ?? 0) > 0, '负对照的前提:环上统计到的确实是 352');

  /* 负对照 2:必需件齐备但不含 529 ⇒ 该配方不得 matched(三层口径没放宽必需件) */
  const lab = boxRoom(352, 6, [536, 537]);
  ok(!scoreRoom(lab, ranch).matched, '负对照:炼金房的件不得让牧场配方 matched');
});

/* ══════════════════ 8~9. 接力选项入口 + 数据审计期望值 ══════════════════ */

test('FND110-8 接力选项非法值 ⇒ **入口抛**(不再静默夹取 / 静默不派活)', () => {
  const bp = captureBlueprint(new TileGrid(16, 16), 0, 0);
  const builders = [{ id: 'p1', x: 0, y: 0, speedMul: 1 }];

  throwsWith(
    () => buildRelayQueue(bp, { maxBuilders: 0, perBuilderParallel: 1 }),
    '接力人数上限',
    'maxBuilders=0 必须抛(旧行为:被 Math.max(1, …) 悄悄抬成 1)',
  );
  throwsWith(
    () => buildRelayQueue(bp, { maxBuilders: -3, perBuilderParallel: 1 }),
    '接力人数上限',
    'maxBuilders 负值必须抛',
  );
  throwsWith(
    () => buildRelayQueue(bp, { maxBuilders: 1, perBuilderParallel: 0 }),
    '每人并行在飞上限',
    'perBuilderParallel=0 必须抛(旧行为:一条任务都不派、drain 空转)',
  );
  throwsWith(
    () => buildRelayQueue(bp, { maxBuilders: 1.5, perBuilderParallel: 1 }),
    '接力人数上限',
    '非整数上限必须抛',
  );
  throwsWith(
    () => new RelayQueue([], builders, { maxBuilders: 0, perBuilderParallel: 0 }),
    '接力人数上限',
    'RelayQueue 构造函数同样必须抛(同一条校验,不重复实现)',
  );

  /* 正对照:合法值照常工作,且并发上限真的生效 */
  eq(DEFAULT_RELAY_OPTIONS.maxBuilders >= 1 && DEFAULT_RELAY_OPTIONS.perBuilderParallel >= 1, true, '默认值本身合法');
  const tasks = buildRelayQueue(bp, { maxBuilders: 1, perBuilderParallel: 1 });
  eq(tasks.length, 256, '合法选项 ⇒ 照常 256 个任务');
  ok(tasks.every((t) => t.state === RelayTaskState.PENDING), '初始全 PENDING');
  const q = new RelayQueue(tasks, builders, { maxBuilders: 1, perBuilderParallel: 1 });
  eq(q.tick(0).assigned.length, 1, '并行 1 ⇒ 首次 tick 恰好派 1 块');
  eq(q.tick(1).assigned.length, 0, '前一块还在飞 ⇒ 第二次 tick 不再派(上限真的在管)');
});

test('FND110-9 数据审计「房间配方数」不再硬编码 8(与表内 9 条恒冲突 ⇒ 恒判 UNKNOWN)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'data-conformance.ts'), 'utf8');
  /*
   * 只看**非注释行**:注释里讨论「旧写法是字面量 8」是合法的(本仓惯例是留证),
   * 有牙齿的是**可执行代码**里还有没有那个字面量。
   */
  const codeOnly = src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join('\n');
  ok(!codeOnly.includes('ROOM_RECIPES.length === 8'), '★ 可执行代码里不得再硬编码 8(写回即红)');
  ok(src.includes("label: '动态房间配方数'"), '前置:该对照项仍在(不得整条删掉)');
  ok(src.includes('const unusable'), '★ 判据必须由表推导(表长 + 表自身可用性),不是另一个字面量');

  const rooms = ROOM_RECIPES as readonly { key: string; required: readonly number[] }[];
  eq(rooms.length, 9, 'ROOM_RECIPES 9 条(表侧事实)');
  eq(
    rooms.filter((r) => r.key.length === 0 || r.required.length < 1).length,
    0,
    '每条都有 key 与必需件 ⇒ 新判据应为 MATCH(旧版恒 UNKNOWN)',
  );
});

report('WS-FND-110');
