/**
 * WS-01 · 地形位压缩引擎验收测试。
 * 运行:`node tests/WS-01.test.ts`
 */

import { test, ok, eq, near, inRange, report } from '../shared/testing/harness.ts';
import {
  CHUNK_SIZE, CHUNK_CELLS, CHUNK_BYTES, Elevation, BaseFluid, WireColor,
  packTile, unpackTile, withField, hasWire, setWire, metaState, faceDir,
} from '../shared/types/tile.ts';
import {
  Chunk, idx, inChunkBounds, worldToChunk, chunkKey, popcount32,
  FLOOR_PALETTE, FLOOR_SLOT_MASK, FLOOR_META, FLOOR_DEFAULT_MU, BARE_GROUND_MU,
  FLOOR_MU_BY_SLOT, FLOOR_BURN_BY_SLOT, VERTICAL_STACK, EMPTY_TILE,
  FLOOR_SPEED_MUL_BY_SLOT, SPEED_MUL_DEFAULT, speedMulOfSlot,
  floorIdOfSlot, floorSlotOfId, muOfSlot, floorMu, floorMeta,
  ROOF_META, ROOF_CAPABLE, isRoofId, roofAlphaOf, roofSpanOf,
  encodeRoofRle, decodeRoofRle, DIRTY_WORDS, DIRTY_BYTES,
} from '../server/src/world/chunk.ts';
import {
  WorldGrid, digToDeep, isCanalIntake, findCanalIntakes, DIR_VECTORS, DIR_NAMES, CanalResult,
} from '../server/src/world/grid.ts';
import {
  FluidField, FluidKind, fluidKindOfBase, baseOfFluidKind, VISCOSITY_FLOW,
  CAP, PHASE_MIN_AMOUNT, OBSIDIAN_ID, PUMICE_ID, FLUID_CELL_BUDGET,
  makeSealedPool, FLUID_FRAME_SECONDS,
} from '../server/src/world/fluid.ts';

/* ═════════════════ 1. 位压缩往返(20 组穷举 + 边界) ═════════════════ */

test('位压缩六字段往返一致,且无符号位污染', () => {
  let bad = 0;
  for (let i = 0; i < 20000; i += 1) {
    const f = {
      elev: i % 4,
      base: (i * 3) % 16,
      floor: (i * 7) % 64,
      wire: (i * 5) % 16,
      obj: (i * 137) % 4096,
      meta: (i * 11) % 16,
    };
    const v = packTile(f);
    if (v < 0 || v > 0xffffffff) { bad += 1; continue; }
    const u = unpackTile(v);
    if (u.elev !== f.elev || u.base !== f.base || u.floor !== f.floor
      || u.wire !== f.wire || u.obj !== f.obj || u.meta !== f.meta) bad += 1;
  }
  eq(bad, 0, '20000 组往返错误数');
});

test('单字段改写不影响其它字段', () => {
  const v = packTile({ elev: 3, base: 4, floor: 63, wire: 15, obj: 4094, meta: 15 });
  const b = withField(v, 'obj', 0);
  const u = unpackTile(b);
  eq(u.obj, 0, 'obj 改写');
  eq(u.elev, 3, 'elev 未被波及');
  eq(u.floor, 63, 'floor 未被波及');
  eq(u.meta, 15, 'meta 未被波及');
});

test('FLOOR 层是 6 位槽位:地砖物品 ID 必须经调色板映射', () => {
  /* 这是全模块最容易写错的地方:315 装不进 6 位,只有槽位 15 能装进去 */
  eq(FLOOR_SLOT_MASK, 0x3f, '槽位掩码应为 6 位');
  ok(301 > FLOOR_SLOT_MASK, '物品 ID 301 超过 6 位上界');
  eq(floorSlotOfId(301), 1, '301 → 槽位 1');
  eq(floorSlotOfId(315), 15, '315 → 槽位 15');
  eq(floorSlotOfId(330), 30, '330 → 槽位 30');
  eq(floorIdOfSlot(15), 315, '槽位 15 → 315');
  eq(floorIdOfSlot(0), 0, '槽位 0 → 无铺装');
  eq(FLOOR_PALETTE.length, 64, '调色板 64 项');
  /* 槽位 31~63 给 UGC 像素地毯 314 */
  eq(floorIdOfSlot(31), 314, 'UGC 首槽 → 314');
  eq(floorIdOfSlot(63), 314, 'UGC 末槽 → 314');
  /* 30 种地砖 301~330 全部可映射 */
  for (let id = 301; id <= 330; id += 1) {
    const s = floorSlotOfId(id);
    if (s === 0 || floorIdOfSlot(s) !== id) throw new Error(`地砖 ${id} 槽位映射断裂`);
  }
});

/* ═════════════════ 2. Chunk 读写与越界 ═════════════════ */

test('Chunk 构造:256 格 Uint32Array 且初始为空格', () => {
  const c = new Chunk(0, 0);
  eq(c.cells.length, 256, '网格容量');
  eq(c.cells.length * 4, CHUNK_BYTES, '字节数 = 1024');
  eq(CHUNK_CELLS, 256, '冻结层 CHUNK_CELLS');
  eq(c.get(0, 0), EMPTY_TILE, '左上角为空格');
  eq(c.get(15, 15), EMPTY_TILE, '右下角为空格');
  eq(c.getRoof(0, 0), 0, '屋顶层初始为空');
});

test('get/set/withCell 与索引公式一致', () => {
  const c = new Chunk(2, -3);
  eq(idx(0, 0), 0, 'idx(0,0)');
  eq(idx(15, 0), 15, 'idx(15,0)');
  eq(idx(0, 1), 16, 'idx(0,1) 换行');
  eq(idx(15, 15), 255, 'idx(15,15)');
  c.set(3, 7, { elev: Elevation.PLATFORM, base: BaseFluid.GOLD_SAND, floor: 5 });
  const f = c.getFields(3, 7);
  eq(f.elev, Elevation.PLATFORM, 'elev 写入');
  eq(f.base, BaseFluid.GOLD_SAND, 'base 写入');
  eq(f.floor, 5, 'floor 写入');
  c.withCell(3, 7, 'obj', 536);
  eq(c.getFields(3, 7).obj, 536, 'withCell 单字段');
  eq(c.getFields(3, 7).elev, Elevation.PLATFORM, 'withCell 不破坏其它字段');
});

test('setFloor 按物品 ID 落槽位,muAt 走预计算表', () => {
  const c = new Chunk(0, 0);
  c.setFloor(1, 1, 315);
  eq(c.floorSlotAt(1, 1), 15, '315 落在槽位 15');
  eq(c.floorIdAt(1, 1), 315, '读回 315');
  near(c.muAt(1, 1), 0.98, 1e-12, '冰砖 μ');
  c.setFloor(2, 2, 316);
  near(c.muAt(2, 2), 0.40, 1e-12, '沼泽砖 μ');
  c.setFloor(3, 3, 322);
  near(c.muAt(3, 3), 0.35, 1e-12, '蜂蜜毯 μ');
  c.setFloor(4, 4, 328);
  near(c.muAt(4, 4), 0.90, 1e-12, '铁轨 μ');
  /* 裸地(槽位 0,未铺装)μ = 0.72。手册 §3.5 未给裸地行(它只列 301~330),
     故按**设计基线**钉死。写死字面量,不引 `BARE_GROUND_MU` —— 引了就是同义反复。 */
  near(c.muAt(9, 9), 0.72, 1e-12, '裸地 μ = 0.72(设计基线,手册未给)');
});

test('越界写入与读取必须抛 RangeError', () => {
  const c = new Chunk(0, 0);
  const cases: [string, () => unknown][] = [
    ['get(-1,0)', () => c.get(-1, 0)],
    ['get(16,0)', () => c.get(16, 0)],
    ['set(0,16)', () => c.set(0, 16, {})],
    ['withCell(16,16)', () => c.withCell(16, 16, 'obj', 1)],
    ['setRoof(-1,-1)', () => c.setRoof(-1, -1, 1)],
    ['getRoof(0,16)', () => c.getRoof(0, 16)],
    ['markDirty(16,0)', () => c.markDirty(16, 0)],
  ];
  for (const [name, fn] of cases) {
    let threw = false;
    try { fn(); } catch (e) { threw = e instanceof RangeError; }
    ok(threw, `${name} 应抛 RangeError`);
  }
  ok(!inChunkBounds(16, 0), 'inChunkBounds(16,0) = false');
  ok(inChunkBounds(15, 15), 'inChunkBounds(15,15) = true');
});

/* ═════════════════ 3. 脏格位图 ═════════════════ */

test('脏格位图:标记、查询、逐格清除', () => {
  const c = new Chunk(0, 0);
  eq(c.dirtyCount, 0, '初始无脏格');
  eq(DIRTY_WORDS, 8, '8 个 32 位字 = 256 位');
  eq(DIRTY_BYTES, 32, '32 字节');
  c.setFloor(0, 0, 315);
  ok(c.isDirty(0, 0), '(0,0) 被标脏');
  eq(c.dirtyCount, 1, '脏格计数 1');
  c.setFloor(15, 15, 316);
  ok(c.isDirty(15, 15), '(15,15) 被标脏');
  eq(c.dirtyCount, 2, '脏格计数 2');
  ok((c.dirty[7] & (1 << 31)) !== 0, '位 255 落在第 7 个字最高位');
  c.clearDirtyAt(0, 0);
  ok(!c.isDirty(0, 0), '(0,0) 脏位已清');
  ok(c.isDirty(15, 15), '(15,15) 仍脏');
  eq(c.dirtyCount, 1, '清除后计数 1');
  c.clearDirty();
  eq(c.dirtyCount, 0, '全清后计数 0');
  eq(c.dirty[0] | c.dirty[7], 0, '位图清零');
});

test('重复写同一格只置一次脏位', () => {
  const c = new Chunk(0, 0);
  c.setFloor(4, 4, 315);
  const v1 = c.version;
  c.setFloor(4, 4, 315);
  eq(c.dirtyCount, 1, '仍只有 1 个脏格');
  eq(c.version, v1, '值未变则版本号不动');
  c.setFloor(4, 4, 316);
  ok(c.version > v1, '值变化则版本号递增');
});

test('dirtyCells 位扫描遍历的格集合与 enforcing 一致', () => {
  const c = new Chunk(0, 0);
  const marks = [0, 1, 17, 63, 64, 128, 200, 255];
  for (const i of marks) c.setFloor(i & 15, i >>> 4, 303);
  const seen: number[] = [];
  for (const d of c.dirtyCells()) seen.push(idx(d.x, d.y));
  seen.sort((a, b) => a - b);
  eq(seen.length, marks.length, '遍历数量');
  eq(seen.join(','), marks.join(','), '遍历集合');
  eq(c.dirtyCount, marks.length, 'dirtyCount 与遍历一致');
  for (const m of marks) ok(popcount32(m) >= 0, `popcount32(${m}) 可调用`);
  eq(popcount32(0xffffffff), 32, 'popcount 全 1');
  eq(popcount32(0), 0, 'popcount 全 0');
});

test('dirtyBits 展开成 32 字节小端位图', () => {
  const c = new Chunk(0, 0);
  c.setFloor(0, 0, 301);
  c.setFloor(7, 2, 301);
  const bits = c.dirtyBits();
  eq(bits.length, 32, '位图字节数');
  eq(bits[0] & 1, 1, '格 0 的位是 1');
  eq((bits[39 >> 3] >> (39 & 7)) & 1, 1, '格 39 的位是 1');
  eq((bits[1] >> 1) & 1, 0, '格 9 未置位');
});

/* ═════════════════ 4. 1024 字节序列化 ═════════════════ */

test('serialize 恰好 1024 字节,deserialize 往返逐格一致', () => {
  const c = new Chunk(3, -2);
  for (let i = 0; i < 256; i += 1) {
    c.set(i & 15, i >>> 4, {
      elev: i % 4, base: (i * 3) % 16, floor: (i * 7) % 64,
      wire: (i * 5) % 16, obj: (i * 137) % 4096, meta: (i * 11) % 16,
    });
  }
  const buf = c.serialize();
  eq(buf.length, CHUNK_BYTES, '序列化长度');
  eq(buf.length, 1024, '必须恰好 1024');
  eq(Chunk.SERIALIZE_BYTES, 1024, '常数一致');

  const back = Chunk.deserialize(buf.buffer.slice(0) as ArrayBuffer);
  for (let i = 0; i < 256; i += 1) {
    eq(back.get(i & 15, i >>> 4), c.get(i & 15, i >>> 4), `格 ${i} 往返一致`);
  }
  eq(back.cells.length, 256, '恢复后容量');

  /* 只读前 1024 字节:尾部追加垃圾不影响 */
  const padded = new Uint8Array(1400);
  padded.set(buf, 0);
  padded.fill(0xab, 1024);
  const back2 = Chunk.deserialize(padded);
  eq(back2.get(5, 5), c.get(5, 5), '带尾部填充仍能正确解析');

  /* 缓冲不足必须抛错 */
  let threw = false;
  try { Chunk.deserialize(new Uint8Array(1023)); } catch (e) { threw = e instanceof RangeError; }
  ok(threw, '1023 字节应抛 RangeError');
});

test('snapshot 扩展格式能保住屋顶层与位图', () => {
  const c = new Chunk(0, 0);
  c.setRoof(2, 3, 372);
  c.setRoof(9, 9, 375);
  c.setFloor(2, 3, 315);
  c.markWet(2, 3);
  c.markLava(9, 9);
  const snap = c.serializeSnapshot();
  ok(snap.length >= CHUNK_BYTES, '快照不小于 1KB');
  const back = Chunk.deserializeSnapshot(snap);
  eq(back.cx, 0, 'cx 保留');
  eq(back.cy, 0, 'cy 保留');
  eq(back.getRoof(2, 3), 372, '屋顶 372 保留');
  eq(back.getRoof(9, 9), 375, '屋顶 375 保留');
  eq(back.getRoof(1, 1), 0, '未设屋顶为空');
  near(back.muAt(2, 3), 0.98, 1e-12, '地砖保留');
  eq(back.dirtyCount, c.dirtyCount, '脏格数保留');
  ok((back.wet[idx(2, 3) >>> 5] & (1 << (idx(2, 3) & 31))) !== 0, '进水台账保留');
  ok((back.lava[idx(9, 9) >>> 5] & (1 << (idx(9, 9) & 31))) !== 0, '熔岩台账保留');
});

test('屋顶层 RLE 编解码往返', () => {
  const a = new Uint16Array(256);
  a[10] = 372; a[11] = 372; a[200] = 384;
  const enc = encodeRoofRle(a);
  const dec = new Uint16Array(256);
  decodeRoofRle(enc, dec);
  eq(dec[10], 372, '第 10 格');
  eq(dec[11], 372, '第 11 格');
  eq(dec[200], 384, '第 200 格');
  eq(dec[0], 0, '第 0 格');
  eq(dec[255], 0, '第 255 格');
  const empty = encodeRoofRle(new Uint16Array(256));
  ok(empty.length <= 4, `全空屋顶 RLE 应极短,实际 ${empty.length}`);
});

/* ═════════════════ 5. 五层垂直数据栈 ═════════════════ */

test('垂直数据栈 7 层的位宽与上界自洽', () => {
  eq(VERTICAL_STACK.length, 7, '7 层(6 层入 32 位 + ROOF 旁路)');
  let bits = 0;
  for (const s of VERTICAL_STACK) {
    if (s.layer === 'ROOF') continue;
    eq(s.max, (1 << s.bits) - 1, `${s.layer} 上界 = 2^${s.bits}-1`);
    bits += s.bits;
  }
  eq(bits, 32, '入位图的 6 层共 32 位');
  eq(VERTICAL_STACK.filter((s) => s.layer === 'ROOF').length, 1, 'ROOF 只有一层');
});

test('layer() 统一读口与直接读字段一致', () => {
  const c = new Chunk(0, 0);
  c.set(6, 8, { elev: 2, base: 8, floor: 7, wire: 3, obj: 1234, meta: 0b1101 });
  const f = c.getFields(6, 8);
  eq(c.layer(6, 8, 'ELEV'), f.elev, 'ELEV');
  eq(c.layer(6, 8, 'BASE'), f.base, 'BASE');
  eq(c.layer(6, 8, 'FLOOR'), f.floor, 'FLOOR');
  eq(c.layer(6, 8, 'WIRE'), f.wire, 'WIRE');
  eq(c.layer(6, 8, 'OBJ'), f.obj, 'OBJ');
  eq(c.layer(6, 8, 'META'), f.meta, 'META');
  eq(c.layer(6, 8, 'ROOF'), 0, 'ROOF 默认空');
  eq(metaState(c.get(6, 8)), 0b01, 'metaState 取低 2 位');
  eq(faceDir(c.get(6, 8)), 0b11, 'faceDir 取高 2 位');
});

test('四色暗线读写走冻结层 setWire/hasWire', () => {
  const c = new Chunk(0, 0);
  const v = c.get(1, 2);
  eq(hasWire(v, WireColor.RED), false, '初始无线');
  /* setWire 返回的是**整片 32-bit**,必须用 setPacked 落盘 */
  c.setPacked(1, 2, setWire(setWire(v, WireColor.RED, true), WireColor.GREEN, true));
  const nv = c.get(1, 2);
  eq(hasWire(nv, WireColor.RED), true, '红线接通');
  eq(hasWire(nv, WireColor.GREEN), true, '绿线接通');
  eq(hasWire(nv, WireColor.BLUE), false, '蓝线断开');
  eq(hasWire(nv, WireColor.YELLOW), false, '黄线断开');
  eq(c.getFields(1, 2).wire, 9, '四色低位掩码 = 1|8 = 9');
  eq(c.getFields(1, 2).elev, Elevation.GROUND, 'elev 未被污染');
});

test('withCell 收字段原值,setPacked 收整片:两条路径结果一致', () => {
  const a = new Chunk(0, 0);
  const b = new Chunk(0, 0);
  /* 路径 1:自己算好字段原值 */
  a.withCell(1, 2, 'wire', 9);
  /* 路径 2:用冻结层纯函数算出整片 */
  b.setPacked(1, 2, setWire(setWire(b.get(1, 2), WireColor.RED, true), WireColor.GREEN, true));
  eq(a.get(1, 2), b.get(1, 2), '两条路径必须得到同一个 packed 值');
  eq(hasWire(a.get(1, 2), WireColor.RED), hasWire(b.get(1, 2), WireColor.RED), '红线一致');
  eq(hasWire(a.get(1, 2), WireColor.GREEN), hasWire(b.get(1, 2), WireColor.GREEN), '绿线一致');
  /* 反例固化:把整片当字段原值传会污染低位 —— 这正是首版的 bug */
  const bad = new Chunk(0, 0);
  const packed = setWire(setWire(bad.get(3, 3), WireColor.RED, true), WireColor.GREEN, true);
  bad.withCell(3, 3, 'wire', packed);
  eq(bad.getFields(3, 3).wire, packed & 0xf, 'withCell 只取低 4 位(故不能传整片)');
  ok(bad.get(3, 3) !== packed, '错误用法产生的值确实与整片不同');
});

/* ═════════════════ 6. 屋顶进入判定 ═════════════════ */

test('屋顶进入判定:自身格、水平投影、非屋顶构件', () => {
  const c = new Chunk(0, 0);
  c.setRoof(5, 5, 372);           /* span 3 的陶瓦斜屋顶 */
  near(roofAlphaOf(372), 0.25, 1e-12, '372 α');
  eq(roofSpanOf(372), 3, '372 span');
  near(c.roofAlphaUnder(5, 5), 0.25, 1e-12, '自身格生效');
  near(c.roofAlphaUnder(4, 5), 0.25, 1e-12, '左侧投影覆盖');
  near(c.roofAlphaUnder(6, 5), 0.25, 1e-12, '右侧投影覆盖');
  near(c.roofAlphaUnder(3, 5), 1.0, 1e-12, '超出 span 不受影响');
  near(c.roofAlphaUnder(5, 6), 1.0, 1e-12, '纵向不覆盖');

  const c2 = new Chunk(0, 0);
  c2.setRoof(5, 5, 374);          /* 尖塔顶 span 1,不自动透明 */
  near(c2.roofAlphaUnder(5, 5), 1.0, 1e-12, '尖塔顶自身也不透明');
  ok(c2.roofCovers(5, 5), '尖塔顶仍然算「有屋顶」');
  near(c2.roofAlphaUnder(4, 5), 1.0, 1e-12, '尖塔顶不覆盖邻格');

  ok(isRoofId(372) && isRoofId(375) && isRoofId(384), '屋顶白名单');
  ok(!isRoofId(355), '玻璃墙 355 不是屋顶');
  ok(!isRoofId(351), '原木墙 351 不是屋顶');
  eq(ROOF_CAPABLE.size, 6, '屋顶白名单 6 项');
  eq(ROOF_META.size, 6, '屋顶配表 6 项');
});

test('屋顶与 OBJ 互不干扰(同一格可同时有壁炉与屋顶)', () => {
  const c = new Chunk(0, 0);
  c.set(7, 7, { obj: 502 });      /* 屋里放一个高炉 */
  c.setRoof(7, 7, 373);
  eq(c.getFields(7, 7).obj, 502, 'OBJ 层保有家具');
  eq(c.getRoof(7, 7), 373, '屋顶旁路层独立');
  near(c.roofAlphaUnder(7, 7), 0.30, 1e-12, '茅草顶 α');
});

/* ═════════════════ 7. 配表完整性(μ 必须建表并标注来源) ═════════════════ */

test('地砖 μ 配表覆盖 301~330,缺项回落 0.75', () => {
  eq(FLOOR_META.size, 30, '30 种地砖全部建表');
  for (let id = 301; id <= 330; id += 1) {
    ok(FLOOR_META.has(id), `地砖 ${id} 必须在配表中`);
  }
  /* 手册原文点名的四个数值 */
  near(FLOOR_META.get(315)!.mu, 0.98, 1e-12, '315 冰砖 = 0.98');
  near(FLOOR_META.get(316)!.mu, 0.40, 1e-12, '316 沼泽 = 0.40');
  near(FLOOR_META.get(322)!.mu, 0.35, 1e-12, '322 蜂蜜 = 0.35');
  near(FLOOR_META.get(328)!.mu, 0.90, 1e-12, '328 铁轨 = 0.90');
  /* 每一条都有 surface 分类与 note 出处(配表内逐一注释) */
  for (const [id, m] of FLOOR_META) {
    ok(typeof m.surface === 'string' && m.surface.length > 0, `地砖 ${id} 缺 surface 分类`);
    ok(Number.isFinite(m.mu) && m.mu > 0 && m.mu <= 1, `地砖 ${id} μ 非法`);
  }
  /* 未登记的物品 ID 走默认值。
     期望值写**字面量 0.75**,不写 `FLOOR_DEFAULT_MU` —— 那是被测代码自己的常量,
     引它进来等于同义反复:常量改成 0.2 两侧同步移动,断言数学上无法失败。
     手册 §3.5 未给「未登记地砖」的 μ(它只列了 301~330 共 30 行),
     故此处以**设计基线**钉死当前值。 */
  near(floorMu(999), 0.75, 1e-12, '未登记地砖 = 0.75(设计基线,手册未给)');
  near(floorMeta(999).mu, 0.75, 1e-12, 'floorMeta 默认 μ = 0.75(设计基线)');
  eq(FLOOR_META.get(320)!.burnPerSec, 15, '320 火炭每秒 15 伤害');
  eq(FLOOR_META.get(324)!.burnPerSec, 0, '324 荆棘走另一条伤害通道');
  eq(FLOOR_META.get(315)!.surface, 'ICE', '315 是冰面大类');
});

/* 手册 §3.5 表(L200 表头 / L202~L231 数据行)逐行抄录:
   ID → [μ, 移速修正%]。这是**外部判据**,不从 FLOOR_META 反推 ——
   否则改配表时两侧一起变,断言永远通过。
   2026-11 对照审计发现代码 μ 曾与手册有 24/30 处不符,故在此逐行钉死。 */
const HANDBOOK_FLOOR: readonly [number, number, number, number][] = [
  /* id,  μ,   移速%,  手册行 */
  [301, 0.75, 100, 202], [302, 0.75, 115, 203], [303, 0.75, 110, 204],
  [304, 0.75, 110, 205], [305, 0.75, 115, 206], [306, 0.78, 115, 207],
  [307, 0.75, 110, 208], [308, 0.75, 110, 209], [309, 0.75, 115, 210],
  [310, 0.75, 110, 211], [311, 0.75, 110, 212], [312, 0.76, 115, 213],
  [313, 0.72, 125, 214], [314, 0.75, 110, 215], [315, 0.98, 130, 216],
  [316, 0.40, 45, 217], [317, 0.85, 200, 218], [318, 0.80, 100, 219],
  [319, 0.75, 100, 220], [320, 0.75, 135, 221], [321, 0.80, 100, 222],
  [322, 0.35, 40, 223], [323, 0.65, 80, 224], [324, 0.60, 70, 225],
  [325, 0.75, 115, 226], [326, 0.75, 100, 227], [327, 0.75, 100, 228],
  [328, 0.90, 100, 229], [329, 0.90, 100, 230], [330, 0.95, 180, 231],
];

test('地砖 μ 与移速修正 30 项逐行等于手册 §3.5(L202~L231)', () => {
  eq(HANDBOOK_FLOOR.length, 30, '手册行数');
  eq(FLOOR_META.size, 30, '配表条数');
  for (const [id, mu, pct, line] of HANDBOOK_FLOOR) {
    const m = FLOOR_META.get(id);
    ok(m !== undefined, `地砖 ${id} 必须在配表中`);
    near(m!.mu, mu, 1e-12, `#${id} μ(手册 L${line})`);
    near(m!.speedMul, pct / 100, 1e-12, `#${id} 移速修正 ${pct}%(手册 L${line})`);
  }
});

test('移速修正快查表:64 槽位与配表对拍,缺省 100%', () => {
  eq(FLOOR_SPEED_MUL_BY_SLOT.length, 64, '64 槽位');
  eq(SPEED_MUL_DEFAULT, 1.0, '缺省 = 100%');
  for (let slot = 0; slot < 64; slot += 1) {
    const id = FLOOR_PALETTE[slot];
    const expect = slot === 0
      ? SPEED_MUL_DEFAULT
      : (FLOOR_META.get(id)?.speedMul ?? SPEED_MUL_DEFAULT);
    near(FLOOR_SPEED_MUL_BY_SLOT[slot], expect, 1e-12, `槽位 ${slot} 移速`);
    near(speedMulOfSlot(slot), expect, 1e-12, `speedMulOfSlot(${slot})`);
  }
  /* 极值点:317 是 ×2.0、316 是 ×0.45,分处两端 */
  near(speedMulOfSlot(floorSlotOfId(317)), 2.0, 1e-12, '317 加速带 200%');
  near(speedMulOfSlot(floorSlotOfId(316)), 0.45, 1e-12, '316 沼泽 45%');
});

test('μ 预计算表与配表逐项对拍', () => {
  /* 本循环是**接线测试**:验证槽位表确实由 `FLOOR_PALETTE` + `FLOOR_META` 推出。
     两侧同源,所以它证明不了任何**数值**正确性 —— 数值由下方字面量断言钉住。 */
  for (let slot = 0; slot < 64; slot += 1) {
    const id = FLOOR_PALETTE[slot];
    const expect = slot === 0 ? BARE_GROUND_MU : (FLOOR_META.get(id)?.mu ?? FLOOR_DEFAULT_MU);
    near(FLOOR_MU_BY_SLOT[slot], expect, 1e-12, `槽位 ${slot} μ`);
    near(muOfSlot(slot), expect, 1e-12, `muOfSlot(${slot})`);
  }
  /* 槽位 0 = 裸地。写死字面量 0.72,不写 `BARE_GROUND_MU`:
     引被测常量会让这条断言在常量被改成任何值时都通过。 */
  eq(FLOOR_MU_BY_SLOT[0], 0.72, '槽位 0 用裸地 μ = 0.72(设计基线,手册未给)');
  eq(BARE_GROUND_MU, 0.72, 'BARE_GROUND_MU 本身 = 0.72(设计基线)');
  eq(FLOOR_DEFAULT_MU, 0.75, 'FLOOR_DEFAULT_MU 本身 = 0.75(设计基线,手册未给)');
  eq(FLOOR_BURN_BY_SLOT[floorSlotOfId(320)], 15, '灼烧表 320');
  eq(FLOOR_BURN_BY_SLOT[0], 0, '裸地不烧');
});

/* ═════════════════ 8. WorldGrid 与引水渠 ═════════════════ */

test('WorldGrid 分片延迟创建与统计', () => {
  const g = new WorldGrid();
  eq(g.chunks.size, 0, '初始无分片');
  eq(g.floorIdAt(100, 100), 0, '未生成分片返回虚空格');
  eq(g.chunks.size, 0, '查询不产生分片');
  g.ensureChunk(0, 0);
  g.ensureChunk(1, -1);
  eq(g.chunks.size, 2, '两个分片');
  eq(chunkKey(1, -1), '1:-1', '分片键格式');
  ok(g.hasChunk(1, -1), 'hasChunk 命中');
  g.setFloor(3, 3, 317);
  eq(g.floorIdAt(3, 3), 317, '世界格读写');
  eq(g.objIdAt(3, 3), 0, 'OBJ 初始空');
  const st = g.stats();
  eq(st.chunks, 2, '统计分片数');
  eq(st.cells, 512, '统计格数');
  eq(st.cellBytes, 2048, '打包字节 512×4');
  ok(st.instanceBytes > 0, '实例字节为正');
  /* 跨分片坐标一致性 */
  g.setFloor(16, 0, 315);
  eq(g.floorIdAt(16, 0), 315, '(16,0) 落在分片 (1,0)');
  eq(g.floorIdAt(0, 0), 0, '邻格不受影响');
});

test('worldToChunk 处理负数坐标', () => {
  eq(JSON.stringify(worldToChunk(0, 0)), JSON.stringify({ cx: 0, cy: 0, lx: 0, ly: 0 }), '(0,0)');
  eq(JSON.stringify(worldToChunk(15, 15)), JSON.stringify({ cx: 0, cy: 0, lx: 15, ly: 15 }), '(15,15)');
  eq(JSON.stringify(worldToChunk(16, 16)), JSON.stringify({ cx: 1, cy: 1, lx: 0, ly: 0 }), '(16,16)');
  eq(JSON.stringify(worldToChunk(-1, -1)), JSON.stringify({ cx: -1, cy: -1, lx: 15, ly: 15 }), '(-1,-1)');
  eq(JSON.stringify(worldToChunk(-16, 5)), JSON.stringify({ cx: -1, cy: 0, lx: 0, ly: 5 }), '(-16,5)');
});

test('引水渠:挖低 Z0 形成 Z-1 并判定汇水口', () => {
  const g = new WorldGrid();
  g.ensureChunk(0, 0);
  /* 先把 (5,5) 附近铺成水面:基底浅水 + Z0 */
  for (let y = 3; y <= 7; y += 1) {
    for (let x = 3; x <= 7; x += 1) {
      g.setCell(x, y, { elev: Elevation.GROUND, base: BaseFluid.SHALLOW_WATER });
    }
  }
  eq(isCanalIntake(g, 5, 5), false, 'Z0 水面自身不是汇水口');
  eq(digToDeep(g, 5, 5), CanalResult.DUG, '挖低成功');
  eq(g.elevAt(5, 5), Elevation.DEEP, '海拔降到 Z-1');
  eq(digToDeep(g, 5, 5), CanalResult.ALREADY_DEEP, '重复挖返回已深');
  const intakes = findCanalIntakes(g, 0, 0);
  eq(intakes.length, 1, '恰好 1 个汇水口');
  eq(intakes[0].x, 5, '汇水口 x');
  eq(intakes[0].y, 5, '汇水口 y');
  /* 被实心 OBJ 挡住则挖不动 */
  g.setCell(9, 9, { obj: 359 });
  eq(digToDeep(g, 9, 9), CanalResult.BLOCKED, '黑曜石墙上挖不动');
  eq(DIR_VECTORS.length, 4, '四方向');
  eq(DIR_NAMES[0], '北', '方向命名');
  eq(DIR_VECTORS[1].x, 1, '东为 +x');
  eq(DIR_VECTORS[3].x, -1, '西为 -x');
});

/* ═════════════════ 9. 流体:守恒(核心验收) ═════════════════ */

test('水体守恒:密封水池跑 2000 个 2Hz 帧,总量误差 <1%', () => {
  const f = makeSealedPool(32, 32, 400);
  const before = f.total();
  const expected = before;
  ok(before > 0, '池中有水');
  eq(FLUID_FRAME_SECONDS, 0.5, '2Hz 帧长 0.5s');

  /* 真的跑 2000 帧(= 1000 秒模拟时间) */
  let maxDrift = 0;
  for (let i = 0; i < 2000; i += 1) {
    f.step();
    const now = f.total() + f.totalConsumedByPhase;
    const drift = Math.abs(now - expected) / expected;
    if (drift > maxDrift) maxDrift = drift;
  }
  const after = f.total();
  const err = Math.abs(after + f.totalConsumedByPhase - before) / before;
  ok(err < 0.01, `守恒误差 ${(err * 100).toFixed(6)}% 必须 <1%`);
  eq(after + f.totalConsumedByPhase, before, '整数域下守恒误差必须精确为 0 毫格');
  eq(f.totalConsumedByPhase, 0, '密封池无相变,销毁量为 0');
  eq(maxDrift, 0, '逐帧漂移恒为 0');
});

test('水体守恒:带熔岩相变的水池,总账仍然守恒', () => {
  const f = new FluidField(8, 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const wall = x === 0 || y === 0 || x === 7 || y === 7;
      const i = f.index(x, y);
      f.solid[i] = wall ? 1 : 0;
      f.base[i] = wall ? BaseFluid.ROCK : BaseFluid.VOID;
      f.elev[i] = Elevation.GROUND;
    }
  }
  /* 左半边倒水,右半边铺熔岩 */
  let injected = 0;
  for (let y = 1; y <= 6; y += 1) {
    for (let x = 1; x <= 3; x += 1) injected += f.addWater(x, y, 500, BaseFluid.SHALLOW_WATER);
    for (let x = 5; x <= 6; x += 1) f.setCell(x, y, { base: BaseFluid.LAVA, amount: 400 });
  }
  const waterAtStart = f.totalsByKind().WATER;
  const lavaAtStart = f.totalsByKind().LAVA;
  eq(waterAtStart, injected, '注入水量与水量账一致');
  ok(lavaAtStart > 0, '熔岩初始存在');
  /* 初始总量 = 水 + 熔岩,不是只有水 */
  const startTotal = f.total();
  eq(startTotal, injected + lavaAtStart, '初始总量 = 水 + 熔岩');
  eq(f.grandTotal(), startTotal, '初始总账 = 初始总量');

  for (let i = 0; i < 400; i += 1) f.step();

  /* 守恒不变量:现存 + 销毁水 + 销毁熔岩 === 初始总量 */
  const grand = f.grandTotal();
  const err = Math.abs(grand - startTotal) / startTotal;
  ok(err < 0.01, `含相变时总账误差 ${(err * 100).toFixed(6)}% 必须 <1%`);
  eq(grand, startTotal, '总账精确守恒(整数域误差 0)');
  ok(f.totalConsumedByPhase > 0, '相变确实销毁了水量');
  ok(f.totalConsumedLava > 0, '相变确实销毁了熔岩量');
  /* 水量单独也守恒:现存水 + 销毁水 === 初始水(熔岩不会变成水) */
  const waterNow = f.totalsByKind().WATER + f.totalsByKind().HOT_SPRING + f.totalsByKind().SLIME;
  eq(waterNow + f.totalConsumedByPhase, waterAtStart, '水量账单独闭合');
});

test('水体守恒:纯水量口径(无熔岩)同样精确', () => {
  const f = new FluidField(8, 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const wall = x === 0 || y === 0 || x === 7 || y === 7;
      const i = f.index(x, y);
      f.solid[i] = wall ? 1 : 0;
      f.base[i] = wall ? BaseFluid.ROCK : BaseFluid.VOID;
      f.elev[i] = Elevation.GROUND;
    }
  }
  let injected = 0;
  for (let y = 1; y <= 6; y += 1) {
    for (let x = 1; x <= 6; x += 1) injected += f.addWater(x, y, 500, BaseFluid.SHALLOW_WATER);
  }
  eq(f.total(), injected, '注入量一致');
  eq(f.totalConsumedLava, 0, '无熔岩');
  for (let i = 0; i < 500; i += 1) f.step();
  eq(f.total(), injected, '纯水跑 500 帧后总量不变');
  eq(f.totalConsumedByPhase, 0, '无相变');
});

test('向下优先与水平扩散:有限水量最终铺平', () => {
  const f = new FluidField(9, 9);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const wall = x === 0 || y === 0 || x === 8 || y === 8;
      const i = f.index(x, y);
      f.solid[i] = wall ? 1 : 0;
      f.base[i] = wall ? BaseFluid.ROCK : BaseFluid.SHALLOW_WATER;
      f.elev[i] = Elevation.GROUND;
    }
  }
  f.setCell(4, 1, { amount: CAP });
  const total0 = f.total();
  /* 向下优先:第 2 行应当先被灌满 */
  f.step();
  ok(f.amountAt(4, 2) > 0, '水优先向下流');
  for (let i = 0; i < 200; i += 1) f.step();
  const spread = [];
  for (let y = 1; y <= 4; y += 1) {
    for (let x = 1; x <= 4; x += 1) spread.push(f.amountAt(x, y));
  }
  const nonZero = spread.filter((v) => v > 0).length;
  ok(nonZero > 6, `水应当铺开,实际湿润 ${nonZero} 格`);
  eq(f.total(), total0, '铺平过程不改变总量');
});

test('单帧处理格数上界:预算截断但守恒不受影响', () => {
  ok(FLUID_CELL_BUDGET > 0, '预算为正');
  eq(FLUID_CELL_BUDGET, 1024, '默认预算 1024 格/帧');
  const f = makeSealedPool(64, 64, 200);
  const before = f.total();
  const r = f.step(256);
  eq(r.processed, 256, '被预算精确截断到 256');
  eq(r.truncated, true, '标记为截断');
  eq(f.total(), before, '截断不影响守恒');
  const r2 = f.step();
  eq(r2.processed, 1024, '默认预算服务 1024 格');
  eq(r2.truncated, true, '4096 格 > 1024,仍然截断');
  const small = makeSealedPool(16, 16, 200);
  const r3 = small.step();
  eq(r3.processed, 256, '小于预算时处理全部格');
  eq(r3.truncated, false, '未截断');
  /* 游标轮转让公平性成立:连续 4 帧应覆盖全部 4096 格 */
  const big = makeSealedPool(64, 64, 200);
  let sum = 0;
  for (let i = 0; i < 4; i += 1) sum += big.step().processed;
  eq(sum, 4096, '4 帧覆盖全图');
});

/* ═════════════════ 10. 流体:相变 ═════════════════ */

test('熔岩遇水凝结为黑曜石 110', () => {
  eq(OBSIDIAN_ID, 110, '黑曜石 ID');
  eq(PUMICE_ID, 111, '多孔浮石 ID');
  eq(PHASE_MIN_AMOUNT, 50, '相变最小水量');
  const f = new FluidField(4, 2);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: 600 });
  f.setCell(1, 0, { base: BaseFluid.LAVA, amount: 600 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  const r = f.step();
  eq(r.phaseChanges, 1, '发生 1 次相变');
  eq(r.consumedByPhase, 600, '销毁 600 毫格水');
  eq(f.kindAt(0, 0), FluidKind.NONE, '水侧已凝固');
  eq(f.kindAt(1, 0), FluidKind.NONE, '熔岩侧已凝固');
  const products = f.drainPhaseProducts();
  eq(products.length, 2, '两格都产出方块');
  eq(products[0].obj, 110, '产物是黑曜石');
  eq(products[1].obj, 110, '产物是黑曜石');
  eq(f.amountAt(0, 0), 0, '水量清空');
});

test('温泉水遇熔岩凝结为多孔浮石 111', () => {
  const f = new FluidField(4, 2);
  f.setCell(0, 0, { base: BaseFluid.HOT_SPRING, amount: 600 });
  f.setCell(1, 0, { base: BaseFluid.LAVA, amount: 600 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.step();
  const products = f.drainPhaseProducts();
  eq(products.length, 2, '两格都产出');
  eq(products[0].obj, 111, '产物是多孔浮石');
  eq(products[1].obj, 111, '产物是多孔浮石');
});

test('水量不足时不触发相变(一滴水灭不了熔岩)', () => {
  const f = new FluidField(4, 2);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: PHASE_MIN_AMOUNT - 1 });
  f.setCell(1, 0, { base: BaseFluid.LAVA, amount: 600 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true });
  const r = f.step();
  eq(r.phaseChanges, 0, '不触发相变');
  eq(f.kindAt(1, 0), FluidKind.LAVA, '熔岩仍在');
});

test('异类流体不混合:水不会注入粘液格,粘液也不会被冲走', () => {
  /* 水与粘液相邻但不反应,检验「异类不混」这条纯输运规则 */
  const f = new FluidField(4, 1);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: 900 });
  f.setCell(1, 0, { base: BaseFluid.SLIME, amount: 100 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  const w0 = f.amountAt(0, 0);
  const s0 = f.amountAt(1, 0);
  for (let i = 0; i < 20; i += 1) f.step();
  eq(f.amountAt(0, 0), w0, '水量未流入粘液格');
  eq(f.amountAt(1, 0), s0, '粘液量未被挤走');
  eq(f.kindAt(0, 0), FluidKind.WATER, '水侧种类不变');
  eq(f.kindAt(1, 0), FluidKind.SLIME, '粘液侧种类不变');
  eq(f.total(), w0 + s0, '总量不变');
});

test('水与熔岩相邻:不混合,而是走相变路径', () => {
  const f = new FluidField(4, 1);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: 900 });
  f.setCell(1, 0, { base: BaseFluid.LAVA, amount: 100 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  const start = f.total();
  f.step();
  /* 相变把两格都凝固,而不是把水量倒进熔岩格 */
  eq(f.kindAt(0, 0), FluidKind.NONE, '水侧已凝固');
  eq(f.kindAt(1, 0), FluidKind.NONE, '熔岩侧已凝固');
  eq(f.amountAt(0, 0), 0, '水量清零');
  eq(f.amountAt(1, 0), 0, '熔岩量清零');
  const products = f.drainPhaseProducts();
  eq(products.length, 2, '两格各产出一块');
  /* 期望值写**字面量 110**,不引 `OBSIDIAN_ID`。
     fluid.ts 的相变产物**直接取自该常量**(`const product = ... : OBSIDIAN_ID`),
     故引用它会让期望值随实现漂移 —— 把常量改成任何值这条都恒真(实测注入 110→999 仍绿)。
     110 取自设计基线(黑曜石物品 ID),常量本身另由 :664 `eq(OBSIDIAN_ID, 110)` 锚定。 */
  for (const p of products) eq(p.obj, 110, '产物是黑曜石 110');
  eq(f.grandTotal(), start, '总账仍然守恒');
});

test('水量低于阈值时不与熔岩反应(一滴水灭不了熔岩)', () => {
  const f = new FluidField(4, 1);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: PHASE_MIN_AMOUNT - 1 });
  f.setCell(1, 0, { base: BaseFluid.LAVA, amount: 100 });
  f.setCell(2, 0, { base: BaseFluid.ROCK, solid: true });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true });
  const r = f.step();
  eq(r.phaseChanges, 0, '不触发相变');
  eq(f.kindAt(1, 0), FluidKind.LAVA, '熔岩仍在');
  eq(f.kindAt(0, 0), FluidKind.WATER, '水仍在');
  eq(f.amountAt(0, 0), PHASE_MIN_AMOUNT - 1, '水量未变');
});

test('水与熔岩被实心岩隔开时不反应', () => {
  const f = new FluidField(5, 1);
  f.setCell(0, 0, { base: BaseFluid.SHALLOW_WATER, amount: 900 });
  f.setCell(1, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(2, 0, { base: BaseFluid.LAVA, amount: 900 });
  f.setCell(3, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  f.setCell(4, 0, { base: BaseFluid.ROCK, solid: true, amount: 0 });
  const start = f.total();
  const r = f.step();
  eq(r.phaseChanges, 0, '隔墙不反应');
  eq(f.total(), start, '总量不变');
});

test('流体种类与基底层 ID 双向映射闭合', () => {
  eq(fluidKindOfBase(BaseFluid.SHALLOW_WATER), FluidKind.WATER, '浅水 → WATER');
  eq(fluidKindOfBase(BaseFluid.HOT_SPRING), FluidKind.HOT_SPRING, '温泉 → HOT_SPRING');
  eq(fluidKindOfBase(BaseFluid.SLIME), FluidKind.SLIME, '粘液 → SLIME');
  eq(fluidKindOfBase(BaseFluid.LAVA), FluidKind.LAVA, '熔岩 → LAVA');
  eq(fluidKindOfBase(BaseFluid.GRASS), FluidKind.NONE, '草地 → NONE');
  eq(fluidKindOfBase(BaseFluid.VOID), FluidKind.NONE, '虚空 → NONE');
  const kinds = [FluidKind.WATER, FluidKind.HOT_SPRING, FluidKind.SLIME, FluidKind.LAVA] as const;
  for (const k of kinds) eq(fluidKindOfBase(baseOfFluidKind(k)), k, `${k} 往返一致`);
  ok(VISCOSITY_FLOW.SLIME < VISCOSITY_FLOW.LAVA, '粘液比熔岩更粘');
  ok(VISCOSITY_FLOW.LAVA < VISCOSITY_FLOW.WATER, '熔岩比水更粘');
  eq(VISCOSITY_FLOW.WATER, 1.0, '默认水粘度 1.0');
});

/* ═════════════════ 11. FluidField 边界与异常 ═════════════════ */

test('FluidField 构造参数校验与越界保护', () => {
  let threw = 0;
  for (const [w, h] of [[0, 4], [4, 0], [-1, 4], [2.5, 4]]) {
    try { new FluidField(w, h); } catch (e) { if (e instanceof RangeError) threw += 1; }
  }
  eq(threw, 4, '非法尺寸全部抛 RangeError');
  const f = new FluidField(4, 4);
  eq(f.amountAt(-1, 0), 0, '越界读取返回 0');
  eq(f.amountAt(99, 99), 0, '远越界返回 0');
  eq(f.kindAt(99, 99), FluidKind.NONE, '越界种类为 NONE');
  eq(f.addWater(-1, -1, 100), 0, '越界注入返回 0');
  let setThrew = false;
  try { f.setCell(4, 0, { amount: 1 }); } catch (e) { setThrew = e instanceof RangeError; }
  ok(setThrew, '越界 setCell 抛 RangeError');
  let stepThrew = false;
  try { f.step(0); } catch (e) { stepThrew = e instanceof RangeError; }
  ok(stepThrew, '预算 0 抛 RangeError');
});

test('注入水量受容量钳制,不会溢出 CAP', () => {
  eq(CAP, 1000, '单位容量 1000 毫格');
  const f = new FluidField(2, 2);
  const put1 = f.addWater(0, 0, 700);
  eq(put1, 700, '第一次注入 700');
  const put2 = f.addWater(0, 0, 700);
  eq(put2, 300, '只接受剩余 300');
  eq(f.amountAt(0, 0), CAP, '钳制到 CAP');
  const put3 = f.addWater(0, 0, 100);
  eq(put3, 0, '已满则注入 0');
  eq(f.totalTiles(), 1, '1000 毫格 = 1 整格');
  f.setCell(1, 0, { solid: true });
  eq(f.addWater(1, 0, 500), 0, '实心格不接受注入');
});

test('流体克隆隔离:改副本不影响原件', () => {
  const f = makeSealedPool(8, 8, 300);
  const c = f.clone();
  const before = f.total();
  c.step(16);
  c.setCell(1, 1, { amount: 1 });
  eq(f.total(), before, '原件总量不受副本影响');
  eq(f.amountAt(1, 1), 300, '原件格值不受影响');
});

/* ═════════════════ 12. 内存上界(算数字) ═════════════════ */

test('1GB 内存下的 chunk 常驻上界可算且经得起验证', () => {
  /* 单分片常驻:1024B 打包 + 512B 屋顶 + 3×32B 位图 = 1632B */
  const perChunk = Chunk.RESIDENT_BYTES;
  eq(perChunk, 1024 + 512 + 96, '单分片常驻字节');
  const c = new Chunk(0, 0);
  eq(c.byteSize(), perChunk, '实例自报字节与常数一致');
  eq(c.cells.byteLength, 1024, 'cells 字节');
  eq(c.roofs.byteLength, 512, 'roofs 字节');
  eq(c.dirty.byteLength + c.wet.byteLength + c.lava.byteLength, 96, '三张位图字节');

  /* 视距半径 R 分片 → (2R+1)² 个分片 */
  const budget = 1024 * 1024 * 1024;          /* 1GB */
  const terrainShare = budget * 0.25;         /* 地形最多占 1/4 = 256MB */
  const maxChunks = Math.floor(terrainShare / perChunk);
  eq(maxChunks, Math.floor((256 * 1024 * 1024) / 1632), '常驻分片数上界');
  ok(maxChunks >= 160000, `分片上界 ${maxChunks} 应远超 16 人视距需求`);

  /* 16 人 + 40 野怪 + 1 Boss 同屏:R=2 时 25 个分片 */
  const r = 2;
  const visible = (2 * r + 1) ** 2;
  eq(visible, 25, '视距 5×5 = 25 分片');
  const resident = visible * perChunk;
  ok(resident < 64 * 1024, `25 分片仅 ${resident}B,远低于 1GB`);
  eq(resident, 40800, '25 分片常驻 40800 字节');

  /* 实体上界:16+40+1 = 57 个 DynamicBody,每个 < 512B → < 30KB */
  const entities = 16 + 40 + 1;
  eq(entities, 57, '同屏实体数');
  ok(entities * 512 < 64 * 1024, '实体内存远小于 1GB');

  /* 一半内存留给流体网格:每格 4+1+1+1 = 7 字节 */
  const fluidShare = budget * 0.5;
  const fluidCells = Math.floor(fluidShare / 7);
  ok(fluidCells > 7e7, `流体网格可覆盖 ${fluidCells} 格`);
});

/* ═════════════════ 13. 性能实测(为文档提供真实数字) ═════════════════ */

test('序列化 4096 分片的总耗时可接受(性能下限)', () => {
  const chunks: Chunk[] = [];
  for (let i = 0; i < 256; i += 1) chunks.push(new Chunk(i, 0));
  const t0 = performance.now();
  let bytes = 0;
  for (let round = 0; round < 16; round += 1) {
    for (const c of chunks) bytes += c.serialize().length;
  }
  const ms = performance.now() - t0;
  eq(bytes, 256 * 16 * 1024, '序列化总字节');
  ok(ms < 3000, `4096 次序列化耗时 ${ms.toFixed(1)}ms 应在预算内`);
});

test('流体 2Hz 单帧耗时实测', () => {
  const f = makeSealedPool(128, 128, 500);
  /* 预热 */
  for (let i = 0; i < 20; i += 1) f.step();
  const t0 = performance.now();
  const frames = 200;
  for (let i = 0; i < frames; i += 1) f.step();
  const per = (performance.now() - t0) / frames;
  ok(per < 50, `16384 格全图的 2Hz 单帧耗时 ${per.toFixed(3)}ms 应远小于 500ms 预算`);
  ok(Number.isFinite(per), '耗时有限');
});

test('流体扩散不随世界面积变慢(活跃格追踪)', () => {
  /* 这是本文件最重要的一条**外部事实**断言。
   *
   * 纯游标轮询下,一格被访问的间隔 = `n / budget` 慢帧,于是水的扩散速度
   * 与世界面积成反比。实测代价:
   *   64×64  → 从 y=2 铺到 y=27 需 39 秒
   *   128×128 → 同一物理距离需 **2268 秒(38 分钟)**
   * 表现是「大世界里倒一桶水,水几乎不动」—— 玩家会认为流体坏了。
   *
   * 注意这**不是** CPU 问题:512×512 每步仅 0.99ms,只占慢帧预算的 0.2%。
   * 所以「调大预算」治不了它,瓶颈是**访问顺序**。
   *
   * 判据用「同一物理距离的耗时」+「四个世界结果一致」,两者都是外部事实,
   * 不依赖任何实现常量。 */
  const measure = (side: number): { frames: number; deepest: number } => {
    const f = new FluidField(side, side);
    const cx = Math.floor(side / 2);
    for (let x = cx - 20; x <= cx + 20; x += 1) for (let y = 2; y < 6; y += 1) f.addWater(x, y, 800);
    let frames = 0;
    for (let s = 0; s < 600; s += 1) {
      f.step();
      frames += 1;
      if (f.amountAt(cx, 27) > 0) break;
    }
    let deepest = -1;
    for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
      if (f.amountAt(x, y) > 0) deepest = Math.max(deepest, y);
    }
    return { frames, deepest };
  };

  const small = measure(64);
  const large = measure(512);
  const huge = measure(1024);

  ok(small.frames < 300, `64×64 在 300 帧内到达 y=27(实际 ${small.frames})`);
  /* 大世界不得超过小世界的 3 倍 —— 一旦退回纯轮询,这个比值会是 16~256 倍 */
  ok(
    large.frames <= small.frames * 3,
    `512×512 不显著慢于 64×64(${large.frames} vs ${small.frames},上限 3 倍)`,
  );
  ok(
    huge.frames <= small.frames * 3,
    `1024×1024 不显著慢于 64×64(${huge.frames} vs ${small.frames})`,
  );
  /* 结果也要一致:世界大了不该让水铺得更浅或更深 */
  ok(
    Math.abs(large.deepest - small.deepest) <= 4,
    `512×512 的最深水位与 64×64 接近(${large.deepest} vs ${small.deepest})`,
  );
});

test('活跃格追踪不冻结水:平衡后注入新水仍会流动', () => {
  /* 这条守的是修「尺寸耦合」时**引入过**的一个真 bug:
   * 活跃格用 `Set` 按插入顺序遍历,当集合大小超过预算时,
   * 排在后面的格永远轮不到 —— 于是在已平衡的水池旁注入新水,
   * `moved` 恒为 0、水**原地不动**。这不是平衡,是停顿。
   * 实测:注入 500 毫格后 5 帧内邻格毫无变化。 */
  const f = new FluidField(64, 64);
  for (let x = 12; x <= 52; x += 1) for (let y = 2; y < 6; y += 1) f.addWater(x, y, 800);
  for (let s = 0; s < 2000; s += 1) f.step();
  /* 长跑后活跃集合已积累上千格 —— 这正是当时的触发条件。
     不断言「已完全平衡」:2000 帧时 moved 仍可能非 0(水还在缓慢铺平),
     那是正常物理过程,与本次要守的 bug 无关。 */
  ok(f.activeCount > 100, `活跃格已积累(${f.activeCount}),足以触发当时的 bug`);

  /* 在空白处注入新水 —— 它必须立刻流起来。
     修复前:注入 500 毫格后 moved 恒为 0、邻格毫无变化。 */
  const y0 = 50;
  f.addWater(32, y0, 500);
  const r1 = f.step();
  ok(r1.moved > 0, `注入新水后 moved > 0(实际 ${r1.moved})`);
  ok(f.amountAt(32, y0 + 1) > 0, `水已扩散到邻格(实际 ${f.amountAt(32, y0 + 1)})`);
  /* 连跑几帧确认是持续流动,而不是「动了 1 毫格就算过」 */
  let movedSum = r1.moved;
  for (let s = 0; s < 4; s += 1) movedSum += f.step().moved;
  ok(movedSum > r1.moved, `后续帧持续流动(累计 ${movedSum})`);
});

test('相变不因活跃格优化而漏检(静止的水也算)', () => {
  /* `phasePass` 只扫活跃格(这是消除最后一个 O(世界面积) 的关键),
   * 正确性依赖「任何 amount>0 的格都留在活跃集合里」这条不变量。
   * 一旦摘除时判错,「静止的水紧挨熔岩」将**永不触发相变** —— 且不报错。 */
  const f = new FluidField(6, 3);
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) f.setCell(x, y, { base: BaseFluid.SHALLOW_WATER, amount: 1000 });
    for (let x = 3; x < 6; x += 1) f.setCell(x, y, { base: BaseFluid.LAVA, amount: 1000 });
  }
  const init = f.total();
  const r = f.step();
  ok(r.phaseChanges > 0, `静止水也触发相变(实际 ${r.phaseChanges} 次)`);
  eq(
    f.total() + f.totalConsumedByPhase + f.totalConsumedLava,
    init,
    '相变账本闭合',
  );

  /* 更严:水先静置到完全平衡(脱离任何流动),再从旁边注入熔岩 */
  const g = new FluidField(8, 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
    g.setCell(x, y, { base: BaseFluid.SHALLOW_WATER, amount: 1000 });
  }
  for (let s = 0; s < 300; s += 1) g.step();
  for (let y = 0; y < 4; y += 1) g.setCell(4, y, { base: BaseFluid.LAVA, amount: 1000 });
  const init2 = g.total();
  let ph = 0;
  for (let s = 0; s < 5; s += 1) ph += g.step().phaseChanges;
  ok(ph > 0, `静置后注入熔岩仍触发相变(实际 ${ph} 次)`);
  eq(g.total() + g.totalConsumedByPhase + g.totalConsumedLava, init2, '静置场景账本闭合');

  /* 最严:被实心完全包围的水(无法流动,最容易脱离活跃集合) */
  const h = new FluidField(6, 6);
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) h.setCell(x, y, { base: BaseFluid.ROCK, solid: true });
  h.setCell(2, 2, { base: BaseFluid.SHALLOW_WATER, amount: 1000, solid: false });
  for (let s = 0; s < 100; s += 1) h.step();
  h.setCell(3, 2, { base: BaseFluid.LAVA, amount: 1000, solid: false });
  let ph2 = 0;
  for (let s = 0; s < 5; s += 1) ph2 += h.step().phaseChanges;
  ok(ph2 > 0, `被实心包围的水仍能触发相变(实际 ${ph2} 次)`);
});

test('流体单步成本不随世界面积增长(稀疏场景)', () => {
  /* 修复前:512×512 稀疏 0.99ms、1024×1024 稀疏 3.0ms ——
   * 因为 `phasePass` 每帧无条件扫全图找「水+熔岩接触面」。
   * 修复后三段循环都只遍历活跃格,成本应正比于**湿区面积**。
   * 用「大世界不超过小世界 3 倍」作判据,避免断言绝对耗时(机器相关)。 */
  const bench = (side: number): number => {
    const f = new FluidField(side, side);
    const c = Math.floor(side / 2);
    for (let x = c - 2; x <= c + 2; x += 1) for (let y = c - 2; y <= c + 2; y += 1) f.addWater(x, y, 100);
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) f.step();
    return (performance.now() - t0) / 200;
  };
  const small = bench(64);
  const large = bench(1024);
  ok(
    large <= Math.max(small * 3, 0.5),
    `1024×1024 稀疏场景不比 64×64 慢 3 倍以上(${large.toFixed(4)} vs ${small.toFixed(4)}ms)`,
  );
});

report('WS-01');