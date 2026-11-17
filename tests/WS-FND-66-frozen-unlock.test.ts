/**
 * WS-FND-66 冻结层解锁(owner 2026-11-17 · D-19)—— 8 项一次性收口判据。
 *
 * 授权来源:`docs/DECISIONS.md`(owner 2026-11-17 冻结层解锁)+ `docs/RULINGS-DRAFT.md`
 * 4.1 U1/U7/U10、4.2 U5、4.3 U5、4.4 EXTENDING U3、4.7 EVENT-BUS U6。
 * 逐条登记在 `shared/contracts/FREEZE.md` 的「D-19 冻结层解锁记录」一节;
 * 本文件的第 9 条判据**反过来校验那份登记**——放宽而不留痕即红。
 *
 * 每一项都写成「正例 + 负对照」:只断言正例时,实现退化成恒真也看不出来。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, eq, ok, near, report } from '../shared/testing/harness.ts';

/* 1. 烹饪 6 参数槽 */
import {
  NEUTRAL_FOOD_BUFF_PARAMS, FOOD_BUFF_PARAM_KEYS, FOOD_BUFF_MUL_KEYS, FOOD_BUFF_FLAT_KEYS,
  isFoodBuffMulKey, isNeutralFoodBuffParams, mergeFoodBuffParams, withFoodBuffParams,
} from '../shared/types/cooking.ts';
import { FOOD_PARAM_SLOTS, FOOD_PARAM_SLOT_COUNT } from '../shared/constants/cooking.ts';

/* 2~5. 蓝图尺寸 / 暗线 / 地砖 u16 / 双 ID */
import {
  FLOOR_ID_BITS, FLOOR_ID_MASK, OBJ_ID_BITS, OBJ_ID_MASK, OBJ_WORD_MASK, FLOOR_WORD_MASK,
  FLOOR_HI_BITS, OBJ_HI_BITS, WIDE_HI_BITS, WIDE_HI_MASK,
  fieldsFromWideValue, isValidFloorId, isValidObjId, packTile, packTileWide, unpackTile,
  unpackTileWide, wideCellValue, type TileFields,
} from '../shared/types/tile.ts';
import { FieldType } from '../shared/types/wire.ts';
import { FIELD_TABLE } from '../shared/types/wire.ts';
import { TileGrid } from '../server/src/build/grid.ts';
import {
  BLUEPRINT_MAX_SIZE, BLUEPRINT_MIN_SIZE, BLUEPRINT_SIZE, RelayQueue, blueprintCellCount,
  blueprintCode, buildRelayQueue, captureBlueprint, decodeBlueprint,
  type Blueprint, type BlueprintCell,
} from '../server/src/build/blueprint.ts';

/* 6. 立牌 icon_size */
import {
  BaseSilhouette, DEFAULT_ICON_SIZE, ParticleAura, iconMatrixProblems, iconSizeOf,
  type VisualStyle,
} from '../shared/types/alchemy.ts';

/* 7. 染色衰减曲线 */
import { DYE_ATTENUATION_KIND, dyeAttenuation } from '../shared/constants/dye.ts';

/* 8. 事件名命名空间 */
import {
  EVENT_KINDS, EVENT_NAMESPACES, EventKind, EventNamespace, MOB_EVENT_COUNT,
  eventName, eventPattern, isKnownEventKind, isNamespacedEventName, namespaceOf,
} from '../shared/types/events.ts';
import { EventBus } from '../server/src/events/bus.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ══════════════ 1. 烹饪 6 个参数槽:中性默认 + 合并律 ══════════════ */

test('WS-FND-66-1 烹饪 6 参数槽:中性默认是单位元,不是平衡数字', () => {
  /* 6 个槽一个不多一个不少 */
  eq(FOOD_BUFF_PARAM_KEYS.length, 6, '应有 6 个参数槽');
  eq([...FOOD_BUFF_PARAM_KEYS], ['defFlat', 'moveMul', 'gravityMul', 'jumpMul', 'gatherMul', 'expMul'], '槽名与顺序');
  eq(FOOD_BUFF_FLAT_KEYS.length + FOOD_BUFF_MUL_KEYS.length, 6, 'flat + mul 覆盖全部槽');

  /* 中性值:平加 0 / 倍率 1 */
  eq(NEUTRAL_FOOD_BUFF_PARAMS.defFlat, 0, 'defFlat 中性 = 0');
  eq(NEUTRAL_FOOD_BUFF_PARAMS.moveMul, 1, 'moveMul 中性 = 1');
  eq(NEUTRAL_FOOD_BUFF_PARAMS.gravityMul, 1, 'gravityMul 中性 = 1');
  eq(NEUTRAL_FOOD_BUFF_PARAMS.jumpMul, 1, 'jumpMul 中性 = 1');
  eq(NEUTRAL_FOOD_BUFF_PARAMS.gatherMul, 1, 'gatherMul 中性 = 1');
  eq(NEUTRAL_FOOD_BUFF_PARAMS.expMul, 1, 'expMul 中性 = 1');
  eq(isNeutralFoodBuffParams(NEUTRAL_FOOD_BUFF_PARAMS), true, '中性自身判定为中性');

  /* 局部覆盖:没写的槽补中性(缺省不能变 NaN/undefined) */
  const one = withFoodBuffParams({ moveMul: 1.2 });
  eq(one.moveMul, 1.2, '显式给的槽生效');
  eq(one.defFlat, 0, '未给的 flat 槽补 0');
  eq(one.expMul, 1, '未给的 mul 槽补 1');
  eq(isNeutralFoodBuffParams(withFoodBuffParams({})), true, '空覆盖 = 中性');

  /* 合并律:flat 相加、mul 相乘 */
  const a = withFoodBuffParams({ defFlat: 3, moveMul: 2 });
  const b = withFoodBuffParams({ defFlat: 4, moveMul: 3 });
  const m = mergeFoodBuffParams(a, b);
  eq(m.defFlat, 7, 'flat 相加:3 + 4');
  eq(m.moveMul, 6, 'mul 相乘:2 × 3');
  eq(m.expMul, 1, '未涉及槽保持中性');

  /* 中性元的表现:与中性合并恒等于对方(这才是「0/1 是单位元」的证据) */
  eq(mergeFoodBuffParams(a, NEUTRAL_FOOD_BUFF_PARAMS), a, 'a ⊕ 中性 = a');
  eq(mergeFoodBuffParams(NEUTRAL_FOOD_BUFF_PARAMS, a), a, '中性 ⊕ a = a');
  eq(isNeutralFoodBuffParams(mergeFoodBuffParams(NEUTRAL_FOOD_BUFF_PARAMS, NEUTRAL_FOOD_BUFF_PARAMS)), true,
    '中性 ⊕ 中性 = 中性');

  /* 结合律:多份 buff 与合并顺序无关(否则 buff 顺序会改数值) */
  const c = withFoodBuffParams({ defFlat: 5, moveMul: 1.5, expMul: 2 });
  eq(
    mergeFoodBuffParams(mergeFoodBuffParams(a, b), c),
    mergeFoodBuffParams(a, mergeFoodBuffParams(b, c)),
    '合并律满足结合律',
  );

  /* 内容表逐槽比对:表里只能有中性值,且每条都写明「待平衡」 */
  eq(FOOD_PARAM_SLOTS.length, FOOD_PARAM_SLOT_COUNT, '内容表条数 = 6');
  eq(FOOD_PARAM_SLOT_COUNT, FOOD_BUFF_PARAM_KEYS.length, '内容表条数 = 参数槽数');
  for (const slot of FOOD_PARAM_SLOTS) {
    eq(slot.neutral, NEUTRAL_FOOD_BUFF_PARAMS[slot.key], `内容表 ${slot.key} 中性值必须与代码一致`);
    eq(slot.kind, isFoodBuffMulKey(slot.key) ? 'mul' : 'flat', `内容表 ${slot.key} 合并律`);
    ok(slot.note.includes('待平衡'), `内容表 ${slot.key} 必须标注「待平衡」(手册未给数值,不许发明)`);
  }
});

/* ══════════════ 2. 蓝图 >16×16:去掉定长假设 ══════════════ */

/** 17×17 场景:7×7 小屋 + 家具 + 一段暗线(尺寸刻意非 16 的整数倍)。 */
function scene17(): TileGrid {
  const g = new TileGrid(17, 17);
  const wall = packTile({ elev: 1, base: 0, floor: 6, wire: 0, obj: 352, meta: 0 });
  const floorOnly = packTile({ elev: 1, base: 0, floor: 6, wire: 0, obj: 0, meta: 0 });
  for (let x = 2; x <= 8; x += 1) {
    g.set(x, 2, wall);
    g.set(x, 8, wall);
    g.set(x, 5, packTile({ elev: 1, base: 0, floor: 6, wire: 0, obj: 504, meta: 0 }));
  }
  for (let y = 3; y <= 7; y += 1) {
    g.set(2, y, wall);
    g.set(8, y, wall);
    for (let x = 3; x <= 7; x += 1) g.set(x, y, floorOnly);
  }
  for (let x = 3; x <= 7; x += 1) {
    g.set(x, 9, packTile({ elev: 1, base: 0, floor: 0, wire: x % 2 === 0 ? 3 : 1, obj: 0, meta: 0 }));
  }
  g.set(15, 15, packTile({ elev: 2, base: 0, floor: 12, wire: 5, obj: 511, meta: 6 }));
  return g;
}

test('WS-FND-66-2 17×17 蓝图:可框、可编码、可跨中继落地', () => {
  const g = scene17();
  const bp = captureBlueprint(g, 0, 0, 17, 17);
  eq(bp.w, 17, '宽 17(不再被定长 16 拦住)');
  eq(bp.h, 17, '高 17');
  eq(bp.cells.length, 289, '17×17 = 289 格');
  eq(blueprintCellCount(bp), 289, 'blueprintCellCount = w × h');
  eq(BLUEPRINT_SIZE, 16, 'BLUEPRINT_SIZE 仍是默认值 16(不是被删,是被降级为默认)');

  /* 编解码 round-trip */
  const code = blueprintCode(bp);
  ok(code.startsWith('BP1:17x17:'), `蓝图码尺寸段应写 17x17,实际 ${code.slice(0, 12)}`);
  const back = decodeBlueprint(code);
  eq(back.w, 17, '解出宽 17');
  eq(back.h, 17, '解出高 17');
  eq(back.cells, bp.cells, '17×17 全字段 round-trip');

  /* 中继队列:289 格 → 289 任务 → 全部放置 → 回写网格逐格一致 */
  const tasks = buildRelayQueue(bp);
  eq(tasks.length, 289, '每格一个接力任务');
  const builders = [
    { id: 'p1', x: 0, y: 0, speedMul: 1 },
    { id: 'p2', x: 16, y: 16, speedMul: 1.5 },
    { id: 'p3', x: 8, y: 8, speedMul: 1 },
  ];
  const q = new RelayQueue(tasks, builders);
  const drained = q.drain();
  eq(drained.placed, 289, '中继把 289 格全部放置');
  eq(q.progress(), 1, '进度 = 1');
  const dst = new TileGrid(17, 17);
  eq(q.applyTo(dst, 0, 0), 289, '回写 289 格');
  let cellDiff = 0;
  for (let y = 0; y < 17; y += 1) {
    for (let x = 0; x < 17; x += 1) {
      if (unpackTile(dst.get(x, y)).obj !== unpackTile(g.get(x, y)).obj) cellDiff += 1;
      if (unpackTile(dst.get(x, y)).floor !== unpackTile(g.get(x, y)).floor) cellDiff += 1;
      if (unpackTile(dst.get(x, y)).wire !== unpackTile(g.get(x, y)).wire) cellDiff += 1;
      if (unpackTile(dst.get(x, y)).elev !== unpackTile(g.get(x, y)).elev) cellDiff += 1;
      if (unpackTile(dst.get(x, y)).meta !== unpackTile(g.get(x, y)).meta) cellDiff += 1;
    }
  }
  eq(cellDiff, 0, '跨中继落地后逐格一致(蓝图无损重建)');

  /* 负对照:下限没被一起放掉(WS-03 的 WT-03-37 仍在),上限也真的挡住 */
  eq(BLUEPRINT_MIN_SIZE, 16, '下限仍是 16');
  eq(BLUEPRINT_MAX_SIZE, 128, '上限 128 单边');
  let threwSmall = false;
  try {
    captureBlueprint(g, 0, 0, 8, 8);
  } catch (err) {
    threwSmall = true;
    ok(String(err).includes('16'), `8×8 的错误信息应提到下限 16,实际 ${String(err)}`);
  }
  ok(threwSmall, '8×8 必须抛错(下限 16 未撤销)');
  let threwBig = false;
  try {
    captureBlueprint(g, 0, 0, 129, 129);
  } catch {
    threwBig = true;
  }
  ok(threwBig, '129×129 必须抛错(超出上限)');
  let threwDecode = false;
  try {
    decodeBlueprint('BP1:8x8:AAAA');
  } catch {
    threwDecode = true;
  }
  ok(threwDecode, '解码 8×8 必须抛错(与捕获同一口径)');
});

/* ══════════════ 3+4+8. 暗线 wire、u16 地砖、双 ID u16 一起走编解码 ══════════════ */

/**
 * 造一张带满「宽 ID + 暗线」的 16×16 蓝图。
 *
 * 为什么每格都不同:`encodeBlueprint` 是 RLE,同质格会被合并成一个游程 ——
 * 若只放一两格特殊值,其余全 0,则「丢了一位」很可能仍被游程掩盖。
 */
function wideBlueprint(): Blueprint {
  const cells: BlueprintCell[] = [];
  for (let i = 0; i < 16 * 16; i += 1) {
    cells.push({
      obj: i % 2 === 0 ? 0 : (i * 4099) % 65536,
      floor: i % 3 === 0 ? 65535 : (i % 3 === 1 ? 65 + (i % 200) : (i * 7) % 64),
      elev: i % 4,
      wire: i % 16,
      meta: (i * 5) % 16,
    });
  }
  return { w: 16, h: 16, cells, originX: 0, originY: 0 };
}

test('WS-FND-66-3 蓝图带暗线:wire 位 round-trip(裁决 4.1 U7)', () => {
  const bp = wideBlueprint();
  const back = decodeBlueprint(blueprintCode(bp));
  eq(back.cells.length, bp.cells.length, '格数一致');
  let wireDiff = 0;
  let wired = 0;
  for (let i = 0; i < bp.cells.length; i += 1) {
    if (back.cells[i].wire !== bp.cells[i].wire) wireDiff += 1;
    if (bp.cells[i].wire !== 0) wired += 1;
  }
  eq(wireDiff, 0, 'wire 位一个都不许丢');
  ok(wired > 200, `样本里应有大量带暗线格,实际 ${wired}`);
  /* 四色位逐位独立:0b1111 必须原样回来,而不是被 clamp 成 1 */
  const all = { w: 16, h: 16, originX: 0, originY: 0, cells: Array.from({ length: 256 }, (_, i) => ({
    obj: 0, floor: 0, elev: 0, wire: i % 16, meta: 0,
  })) } as Blueprint;
  const wireBack = decodeBlueprint(blueprintCode(all));
  let missing = 0;
  for (let w = 0; w < 16; w += 1) {
    if (!wireBack.cells.some((c) => c.wire === w)) missing += 1;
  }
  eq(missing, 0, '16 种 wire 组合都必须能原样解出');
});

test('WS-FND-66-4 地砖 >64 种:u16 round-trip(裁决 4.1 U10)', () => {
  eq(FLOOR_ID_BITS, 16, '地砖 ID 位宽 = 16');
  eq(FLOOR_ID_MASK, 65535, '地砖 ID 掩码 = 0xffff');
  eq(isValidFloorId(65535), true, '65535 合法');
  eq(isValidFloorId(65536), false, '65536 非法');

  /* 100 种地砖(> 64)逐个 round-trip:宽单元与单值编解码两条路都要对 */
  let bad = 0;
  for (let f = 0; f < 100; f += 1) {
    const fields: TileFields = { elev: 1, base: 0, floor: f, wire: 5, obj: 7, meta: 2 };
    if (unpackTileWide(packTileWide(fields)).floor !== f) bad += 1;
    if (fieldsFromWideValue(wideCellValue(fields)).floor !== f) bad += 1;
    if (f <= 63 && packTileWide(fields).hi !== 0) bad += 1;
  }
  eq(bad, 0, '0..99 共 100 种地砖 round-trip(低位路径必须与旧 32 位字一致)');

  /* 端点值 */
  for (const f of [64, 65, 127, 128, 255, 256, 1000, 4095, 4096, 65535]) {
    const fields: TileFields = { elev: 2, base: 3, floor: f, wire: 9, obj: 500, meta: 1 };
    eq(unpackTileWide(packTileWide(fields)).floor, f, `floor=${f} 宽单元 round-trip`);
    eq(fieldsFromWideValue(wideCellValue(fields)).floor, f, `floor=${f} 单值 round-trip`);
  }

  /* 负对照:旧 32 位字真的装不下 —— 否则「扩 u16」是空话 */
  const big = packTile({ elev: 1, base: 0, floor: 300, wire: 0, obj: 0, meta: 0 });
  eq(unpackTile(big).floor, 300 & FLOOR_WORD_MASK, '32 位字里 floor 仍按 6 位截断');
  ok(unpackTile(big).floor !== 300, '32 位字确实装不下 floor=300(所以必须走宽单元)');

  /* 蓝图码里 65 / 300 / 65535 都能拿回来 */
  const bp: Blueprint = {
    w: 16, h: 16, originX: 0, originY: 0,
    cells: Array.from({ length: 256 }, (_, i) => ({
      obj: 0, floor: i % 4 === 0 ? 65 : i % 4 === 1 ? 300 : i % 4 === 2 ? 65535 : 0, elev: 1, wire: 0, meta: 0,
    })),
  };
  const back = decodeBlueprint(blueprintCode(bp));
  eq(back.cells.map((c) => c.floor), bp.cells.map((c) => c.floor), 'u16 地砖穿过蓝图码无损');
});

test('WS-FND-66-5 双 ID 宽度统一 U16:物体 ID 12 位 → 16 位(裁决 4.4 EXTENDING U3)', () => {
  eq(OBJ_ID_BITS, 16, '物体 ID 位宽 = 16');
  eq(OBJ_ID_MASK, 65535, '物体 ID 掩码 = 0xffff');
  eq(OBJ_WORD_MASK, 0xfff, '32 位字里仍是 12 位(既有格式不变)');
  eq(OBJ_HI_BITS, 4, '宽单元高位字里 OBJ 占 4 位');
  eq(FLOOR_HI_BITS, 10, '宽单元高位字里 FLOOR 占 10 位');
  eq(WIDE_HI_BITS, 14, '高位字共 14 位');
  eq(WIDE_HI_MASK, (1 << WIDE_HI_BITS) - 1, '高位字掩码与位宽自洽');
  eq(isValidObjId(65535), true, '65535 合法');
  eq(isValidObjId(-1), false, '负数非法');

  /* 12 → 16 位的分界点必须真的过去 */
  for (const o of [0, 1, 4094, 4095, 4096, 4097, 5000, 32768, 65535]) {
    const fields: TileFields = { elev: 0, base: 0, floor: 0, wire: 0, obj: o, meta: 0 };
    eq(unpackTileWide(packTileWide(fields)).obj, o, `obj=${o} 宽单元 round-trip`);
    eq(fieldsFromWideValue(wideCellValue(fields)).obj, o, `obj=${o} 单值 round-trip`);
  }
  const legacy = packTile({ elev: 0, base: 0, floor: 0, wire: 0, obj: 5000, meta: 0 });
  eq(unpackTile(legacy).obj, 5000 & OBJ_WORD_MASK, '32 位字里 obj 仍按 12 位截断');

  /* 跨层锚定:网络层 `heldItemId` 也是 u16 —— 「双 ID」两边同宽 */
  const held = FIELD_TABLE.find((f) => f.key === 'heldItemId');
  ok(held !== undefined, '共享协议表里应有 heldItemId');
  eq(held!.type, FieldType.U16, 'heldItemId 线上类型 u16');
  eq(held!.bytes * 8, OBJ_ID_BITS, 'heldItemId 线上位宽 = 物体 ID 位宽 = 16');

  /* 蓝图码里 4096 / 65535 都能原样回来 */
  const bp: Blueprint = {
    w: 16, h: 16, originX: 0, originY: 0,
    cells: Array.from({ length: 256 }, (_, i) => ({
      obj: [0, 4095, 4096, 65535][i % 4], floor: 0, elev: 1, wire: 0, meta: 0,
    })),
  };
  eq(decodeBlueprint(blueprintCode(bp)).cells.map((c) => c.obj), bp.cells.map((c) => c.obj),
    'u16 物体 ID 穿过蓝图码无损');
});

/* ══════════════ 6. 立牌 icon_size(裁决 4.2 U5) ══════════════ */

/** 立一张 `w × h` 的立牌字符矩阵。 */
function iconRows(w: number, h: number): string[] {
  return Array.from({ length: h }, () => 'W'.repeat(w));
}

function styleWith(w: number, h: number, iconSize?: { w: number; h: number }): VisualStyle {
  const style: VisualStyle = {
    base_silhouette: BaseSilhouette.SWORD,
    primary_color_hex: '#ffcc00',
    secondary_color_hex: '#336699',
    outline_color_hex: '#111111',
    particle_aura: ParticleAura.NONE,
    pixel_icon_16x16: iconRows(w, h),
  };
  if (iconSize) style.icon_size = iconSize;
  return style;
}

test('WS-FND-66-6 立牌支持非 16×16:32×16 可放', () => {
  eq(DEFAULT_ICON_SIZE, { w: 16, h: 16 }, '缺省立牌仍是 16×16');
  eq(DEFAULT_ICON_SIZE.w, 16, '缺省宽 16');
  eq(DEFAULT_ICON_SIZE.h, 16, '缺省高 16');

  /* 既有基线不能被破坏:16×16 且不带 icon_size */
  const base16 = styleWith(16, 16);
  eq(iconSizeOf(base16), { w: 16, h: 16 }, '不带 icon_size ⇒ 16×16');
  eq(iconMatrixProblems(base16), [], '16×16 立牌必须照旧通过');

  /* 新解锁:32×16 */
  const tall32 = styleWith(32, 16, { w: 32, h: 16 });
  eq(iconSizeOf(tall32), { w: 32, h: 16 }, 'icon_size 生效');
  eq(iconMatrixProblems(tall32), [], '32×16 立牌必须通过');

  /* 负对照一:不给 icon_size 时 32 宽矩阵不通过(证明字段承重,不是摆设) */
  const noSize = styleWith(32, 16);
  ok(iconMatrixProblems(noSize).length > 0, '32 宽矩阵 + 缺省 16×16 ⇒ 必须报错');
  ok(iconMatrixProblems(noSize).some((p) => p.startsWith('ROW_WIDTH')), '报的应是行宽问题');

  /* 负对照二:给了 32×16 但矩阵还是 16 宽,也必须报错 */
  const mismatch = styleWith(16, 16, { w: 32, h: 16 });
  ok(iconMatrixProblems(mismatch).length > 0, 'icon_size 与矩阵不一致 ⇒ 必须报错');

  /* 负对照三:尺寸非法不许静默通过 */
  ok(iconMatrixProblems(styleWith(16, 16, { w: 0, h: 16 })).length > 0, '0 宽必须报错');
});

/* ══════════════ 7. 染色距离衰减曲线(裁决 4.3 U5) ══════════════ */

test('WS-FND-66-7 染色衰减曲线:端点 1→0、随距离单调不增', () => {
  eq(DYE_ATTENUATION_KIND, 'linear', '曲线形态为线性(WS-09 §U5 口径)');

  /* 端点值:贴身满强度、射程处归零 */
  for (const range of [1, 3.5, 8, 12]) {
    eq(dyeAttenuation(0, range), 1, `range=${range} 时 dist=0 → 1`);
    eq(dyeAttenuation(range, range), 0, `range=${range} 时 dist=range → 0`);
  }
  near(dyeAttenuation(4, 8), 0.5, 1e-12, 'range=8 时中点 = 0.5');

  /* 边界 */
  eq(dyeAttenuation(-3, 8), 1, '负距离按贴身处理');
  eq(dyeAttenuation(100, 8), 0, '射程外为 0');
  eq(dyeAttenuation(0, 0), 1, '退化射程(0)不该把颜色抹成 0');
  eq(dyeAttenuation(Number.NaN, 8), 0, '非有限距离 → 0(渲染不能断帧)');

  /* 单调:0 .. 2×range 采样,必须逐点不增 */
  let rise = 0;
  let prev = dyeAttenuation(0, 8);
  for (let d = 0.25; d <= 16; d += 0.25) {
    const cur = dyeAttenuation(d, 8);
    if (cur > prev) rise += 1;
    ok(cur >= 0 && cur <= 1, `强度必须落在 0..1,dist=${d} 得到 ${cur}`);
    prev = cur;
  }
  eq(rise, 0, '曲线单调不增(一次回升都不许有)');
});

/* ══════════════ 8. 事件名命名空间(裁决 4.7 EVENT-BUS U6) ══════════════ */

/** 递归收集某目录下的 `.ts` 文件(absolute path)。 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('WS-FND-66-8 事件名命名空间:29 种、与发送侧双向一致、作用域内 0 裸名', () => {
  eq(MOB_EVENT_COUNT, 29, '裁决口径 29 种');
  eq(Object.keys(EventKind).length, 29, 'as const 表 29 个键');
  eq(EVENT_KINDS.length, 29, '有序清单 29 项');
  eq(new Set(EVENT_KINDS).size, 29, '清单无重复');
  eq([...EVENT_KINDS], Object.values(EventKind), '清单与有名字面量逐项相同(两份数据不许漂)');

  /* 反向扫发送侧:表 ≠ 实际 emit 即红(这才是「命名空间不是文档」的证据) */
  const behaviorsSrc = readFileSync(join(ROOT, 'server/src/mobs/behaviors.ts'), 'utf8');
  const emitted = new Set(
    [...behaviorsSrc.matchAll(/world\.emit\('([a-z0-9_]+)'/g)].map((m) => m[1]),
  );
  eq(emitted.size, 29, `behaviors.ts 里应恰好 emit 29 种,实际 ${emitted.size}`);
  for (const kind of emitted) {
    ok(isKnownEventKind(kind), `${kind} 在 behaviors.ts 里 emit,却未进 EventKind 表(加事件必须同步登记)`);
  }
  for (const kind of EVENT_KINDS) {
    ok(emitted.has(kind), `${kind} 在表里,但 behaviors.ts 不再 emit 它(死条目)`);
  }

  /* 命名空间前缀与 EventBus 的前缀通配语义一致 */
  eq(eventName(EventNamespace.MOB, 'crab_soup'), 'mob_crab_soup', '前缀化名字');
  eq(eventPattern(EventNamespace.MOB), 'mob_*', '前缀通配模式');
  eq(namespaceOf('crab_soup'), 'mob', '已登记事件的作用域');
  eq(namespaceOf('cook_done'), null, '未登记事件返回 null(不静默当成 mob)');
  eq(isNamespacedEventName('mob_crab_soup'), true, '前缀化名字可识别');
  eq(isNamespacedEventName('crab_soup'), false, '扁平名字不算前缀化');
  eq([...EVENT_NAMESPACES].length, 7, '7 个作用域');

  const bus = new EventBus();
  const got: string[] = [];
  bus.on(eventPattern(EventNamespace.MOB), (e) => got.push(e.kind));
  bus.emit('crab_soup');
  bus.emit(eventName(EventNamespace.MOB, 'crab_soup'));
  bus.emit(eventName(EventNamespace.BUILD, 'crab_soup'));
  bus.drain();
  eq(got, ['mob_crab_soup'], '`mob_*` 只接住前缀化的那一条(与 bus.ts 的 matches 语义对齐)');

  /* 作用域内 0 裸名:shared/** 与 server/src/build/** 的 .ts 里不得再出现裸事件名字面量 */
  const scopeFiles = [
    ...tsFiles(join(ROOT, 'shared')),
    ...tsFiles(join(ROOT, 'server/src/build')),
  ].filter((p) => relative(ROOT, p).replace(/\\/g, '/') !== 'shared/types/events.ts');
  ok(scopeFiles.length > 10, `应扫到多个文件,实际 ${scopeFiles.length}`);
  const hits: string[] = [];
  for (const file of scopeFiles) {
    const text = readFileSync(file, 'utf8');
    for (const kind of EVENT_KINDS) {
      if (text.includes(`'${kind}'`) || text.includes(`"${kind}"`)) {
        hits.push(`${relative(ROOT, file)} → ${kind}`);
      }
    }
  }
  eq(hits, [], 'shared/** 与 server/src/build/** 不得再有裸事件名字符串(必须走 EventKind)');
});

/* ══════════════ 9. 解锁必须留痕(不许静默放宽) ══════════════ */

test('WS-FND-66-9 FREEZE.md 逐条登记:放宽了什么、为什么、哪条裁决授权', () => {
  const md = readFileSync(join(ROOT, 'shared/contracts/FREEZE.md'), 'utf8');
  ok(md.includes('D-19'), 'FREEZE.md 必须有 D-19 解锁记录条目');
  ok(md.includes('2026-11-17'), '必须写明授权日期');
  ok(md.includes('RULINGS-DRAFT'), '每条放宽必须指向裁决出处');

  /* 8 项逐个点名:任何一项放宽但没写进 FREEZE.md ⇒ 红 */
  const required: [string, string][] = [
    ['defFlat', '烹饪 defFlat'],
    ['moveMul', '烹饪 moveMul'],
    ['gravityMul', '烹饪 gravityMul'],
    ['jumpMul', '烹饪 jumpMul'],
    ['gatherMul', '烹饪 gatherMul'],
    ['expMul', '烹饪 expMul'],
    ['17×17', '蓝图 >16×16'],
    ['wire', '蓝图暗线'],
    ['u16', '地砖 / 双 ID 扩到 u16'],
    ['icon_size', '立牌尺寸'],
    ['染色', '染色衰减曲线'],
    ['事件名命名空间', '事件名命名空间'],
  ];
  for (const [token, what] of required) {
    ok(md.includes(token), `FREEZE.md 缺少 ${what} 的登记(关键词 ${token})`);
  }

  /* 边界也要写清楚,而不是只写「已放宽」 */
  ok(md.includes('BLUEPRINT_MAX_SIZE') || md.includes('128'), '蓝图上限必须写明');
  ok(md.includes('边界'), '解放宽边界的段落');
  ok(statSync(join(ROOT, 'shared/contracts/FREEZE.md')).size > 8000, 'FREEZE.md 应因此变长(不是只加一行)');
});

report('WS-FND-66');