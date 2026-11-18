/**
 * WS-03 / 208 魔法描图卷轴:矩形框选 → 压缩蓝图码 → 材料清单 → 飞砖接力队列。
 *
 * 蓝图码格式(纯文本,可贴进聊天框):
 *   "BP1:<w>x<h>:<payload>"
 *   payload = base64( RLE 三元组流 ),三元组 = [value:varint][run:varint]
 *   varint  = 7-bit 小端续位编码,高位 1 表示后续字节继续
 *   value   = **宽单元值**(`shared/types/tile.ts#wideCellValue`:lo + hi×2^32,
 *             u16 地砖 + u16 物体 ID,含四色暗线位)
 *
 * 尺寸:**任意 w × h**(下限 16、上限 128)。裁决 2026-11-17 · D-19 起
 * `BLUEPRINT_SIZE = 16` 只是**默认值**,不再是对尺寸的断言。
 *
 * 因为自建房屋中同质区域极大(整面墙、整片地板),RLE 后的三元组通常只有
 * 30~120 组,16×16 蓝图码长度稳定落在 100~400 字符区间。floor/obj 超出
 * 32 位字宽时高位字非 0,单个游程值最多 7 字节(旧版 ≤ 5 字节),
 * 但**同样 ID 范围内的旧码字节不变**。
 *
 * 本文件只依赖 `node:*` 与冻结层符号。
 */

import { ITEM_BY_ID, itemName, itemValue } from '../../../shared/constants/items.ts';
import {
  FLOOR_WORD_MASK, OBJ_WORD_MASK, fieldsFromWideValue, packTile, unpackTile, wideCellValue,
} from '../../../shared/types/tile.ts';
import { TileGrid, type TileGridLike } from './grid.ts';
/* 地板槽位 → ID 的唯一事实源(WS-01),不得在本地重写偏移 */
import { floorIdOfSlot } from '../world/chunk.ts';

/**
 * 208 描图卷轴的**默认**框选边长(格)。
 * 裁决 2026-11-17 · D-19 解除了「必须恰好 16×16」的定长假设:
 * 现在支持任意 `w × h`,下限仍是 16(既有判据 WT-03-37 未撤销)。
 */
export const BLUEPRINT_SIZE = 16;
/** 默认 16×16 场景的格数(256)。非默认尺寸用 `blueprintCellCount(bp)`。 */
export const BLUEPRINT_CELLS = BLUEPRINT_SIZE * BLUEPRINT_SIZE;
/** 框选下限:单边 16 格。 */
export const BLUEPRINT_MIN_SIZE = 16;
/**
 * 框选上限:单边 128 格(16384 格/张)。
 *
 * 为什么不真是「任意」:蓝图码是**贴进聊天框的文本**,接力队列又是**每格一个
 * `RelayTask`** ⇒ 无上限时一张 512×512 蓝图就是 26 万个任务的数组。上限只挡
 * 病态输入,不挡玩法(8 人并发铺 128×128 已是极端用例)。
 */
export const BLUEPRINT_MAX_SIZE = 128;
/** 单张蓝图格数上限(16384)。 */
export const BLUEPRINT_MAX_CELLS = BLUEPRINT_MAX_SIZE * BLUEPRINT_MAX_SIZE;
/**
 * 单个游程(RLE `run`)的**具名上界** —— 与单张蓝图格数上限同值。
 *
 * 为什么必须单独有一个名字:`readVarint` 是 7-bit 续位编码,8 字节就能
 * 解出 ~2^49 级的数。解码侧若「先 `for (k < run) cells.push(...)` 展开、
 * 再判格数是否超过尺寸」,那段守卫**永远等不到执行** —— 一张 16×16 的
 * 短码(`BP1:16x16:` + 几个字节)就足以挂死/爆内存(实测:`run = 5×10^14`)。
 * 上界取 `BLUEPRINT_MAX_CELLS`:合法游程不可能比整张蓝图还长,
 * 所以这个下刀处**不误伤任何**由编码器产出的码。
 */
export const MAX_RUN_CELLS = BLUEPRINT_MAX_CELLS;
/** 蓝图码魔数前缀。 */
export const BLUEPRINT_MAGIC = 'BP1';

export interface BlueprintCell {
  /** 物体 ID(**u16**,0 = 空)。落位到 32 位世界格时只保留低 12 位。 */
  obj: number;
  /** 地砖 ID(**u16**,0 = 无铺装)。落位到 32 位世界格时只保留低 6 位。 */
  floor: number;
  /** 海拔(Bits 0..1) */
  elev: number;
  /** 四色暗线位(Bits 12..15)—— 裁决 4.1 U7:蓝图允许带暗线,原样保留 */
  wire: number;
  /** 运行态 + 朝向(Bits 28..31) */
  meta: number;
}

export interface Blueprint {
  w: number;
  h: number;
  /** 行主序,w×h 个格,下标 y*w+x */
  cells: BlueprintCell[];
  /** 源世界左上角坐标(仅用于日志,不参与编码) */
  originX: number;
  originY: number;
}

export interface MaterialLine {
  id: number;
  name: string;
  /** 需要数量 */
  count: number;
  /** 单件价值分 */
  unitValue: number;
  /** count × unitValue */
  totalValue: number;
}

export interface MaterialManifest {
  /** 逐项材料,按 ID 升序 */
  lines: MaterialLine[];
  /** 材料种类数 */
  kinds: number;
  /** 总件数(所有 count 之和) */
  totalCount: number;
  /** 总价值分 */
  totalValue: number;
  /** 物件数(非地板) */
  objectCount: number;
  /** 地板格数 */
  floorCount: number;
}

/* ─────────────────── varint + base64 ─────────────────── */

/**
 * 写一个 varint。
 *
 * ⚠️ **不能用 32 位运算实现**(旧版写的是 `n >>>= 7`):宽单元值最大 46 位,
 * `>>>` 会把它悄悄截成 32 位 ⇒ 大 ID 静默丢高位、蓝图码照样「成功」。
 * 这里全程整数除法;在 0 .. 2^32−1 上两种写法产生的**字节完全相同**
 * (7 位分组一致),所以旧蓝图码不受影响。
 */
function pushVarint(out: number[], v: number): void {
  if (!Number.isFinite(v) || v < 0 || Math.trunc(v) !== v) {
    throw new Error(`蓝图码编码失败:非法游程值 ${v}`);
  }
  let n = Math.trunc(v);
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

interface Cursor { i: number; buf: readonly number[]; }

/** 读一个 varint(与 `pushVarint` 对称,支持到 46 位)。 */
function readVarint(c: Cursor): number {
  let shift = 0;
  let result = 0;
  for (;;) {
    if (c.i >= c.buf.length) throw new Error('蓝图码截断:varint 不完整');
    if (shift > 42) throw new Error('蓝图码损坏:varint 过长');
    const b = c.buf[c.i];
    c.i += 1;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return result;
    shift += 7;
  }
}

/** 字节数组 → base64(自实现,避免依赖 Buffer 的编码差异)。 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: readonly number[]): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8) | (bytes[i + 2] & 0xff);
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += B64_ALPHABET[(n >>> 6) & 0x3f];
    out += B64_ALPHABET[n & 0x3f];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] & 0xff) << 16;
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += '==';
  } else if (rest === 2) {
    const n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8);
    out += B64_ALPHABET[(n >>> 18) & 0x3f];
    out += B64_ALPHABET[(n >>> 12) & 0x3f];
    out += B64_ALPHABET[(n >>> 6) & 0x3f];
    out += '=';
  }
  return out;
}

export function fromBase64(text: string): number[] {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`蓝图码含非法字符:${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return out;
}

/* ─────────────────── 编码 / 解码 ─────────────────── */

/**
 * 蓝图格 → 游程值(**宽单元**:u16 地砖 + u16 物体 ID,裁决 2026-11-17 · D-19)。
 *
 * 32 位单元格装不下 u16+u16,故用 `shared/types/tile.ts#wideCellValue()`
 * (lo + hi × 2^32)。当 floor ≤ 63 且 obj ≤ 4095 时高位字为 0,
 * 该值与旧版 `packTile(...)` 的返回值**完全相同** ⇒ 旧蓝图码仍可解码。
 */
function cellToValue(c: BlueprintCell): number {
  return wideCellValue({ elev: c.elev, base: 0, floor: c.floor, wire: c.wire, obj: c.obj, meta: c.meta });
}

/** 游程值 → 蓝图格。四色暗线位原样保留(裁决 4.1 U7:蓝图允许带暗线)。 */
function valueToCell(v: number): BlueprintCell {
  const f = fieldsFromWideValue(v);
  return { obj: f.obj, floor: f.floor, elev: f.elev, wire: f.wire, meta: f.meta };
}

/**
 * 从世界框选 `w × h` 生成蓝图(越界部分按空处理)。
 *
 * 尺寸自 D-19 起不再定长:16×16 只是**默认值**。下限 16 保留
 * (既有判据 WT-03-37 未撤销),上限 `BLUEPRINT_MAX_SIZE`。
 */
export function captureBlueprint(
  grid: TileGrid,
  originX: number,
  originY: number,
  w: number = BLUEPRINT_SIZE,
  h: number = BLUEPRINT_SIZE,
): Blueprint {
  if (!Number.isInteger(w) || !Number.isInteger(h)
    || w < BLUEPRINT_MIN_SIZE || h < BLUEPRINT_MIN_SIZE
    || w > BLUEPRINT_MAX_SIZE || h > BLUEPRINT_MAX_SIZE
    || w * h > BLUEPRINT_MAX_CELLS) {
    throw new Error(
      `208 描图卷轴框选须在 ${BLUEPRINT_MIN_SIZE}×${BLUEPRINT_MIN_SIZE}`
      + ` ~ ${BLUEPRINT_MAX_SIZE}×${BLUEPRINT_MAX_SIZE} 之间,收到 ${w}×${h}`,
    );
  }
  const cells: BlueprintCell[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const f = unpackTile(grid.get(originX + x, originY + y));
      cells.push({ obj: f.obj, floor: f.floor, elev: f.elev, wire: f.wire, meta: f.meta });
    }
  }
  return { w, h, cells, originX, originY };
}

export interface EncodeStats {
  code: string;
  bytes: number;
  runs: number;
  /** 压缩率 = 编码字节 / 原始 32-bit 字节 */
  ratio: number;
}

/** 蓝图 → 蓝图码(RLE + varint + base64)。 */
export function encodeBlueprint(bp: Blueprint): EncodeStats {
  /*
   * 入口校验(**必须在编码之前**):格数必须与尺寸相符。
   *
   * 放行 `cells: []` 会走进「循环体一次都不执行」的分支 —— `run` 停在初值 0,
   * 于是吐出一段 `(value, run=0)` 三元组,而解码侧把它读成
   * 「蓝图码损坏:游程长度为 0」:**报错指向解码器,根因在编码入口**。
   * 0 格蓝图本来也不可能是框选结果(尺寸下限 16 ⇒ 至少 256 格),
   * 所以这里直接拒,而不是「编出一段注定解不开的码」。
   */
  if (!Number.isInteger(bp.w) || !Number.isInteger(bp.h) || bp.w <= 0 || bp.h <= 0) {
    throw new Error(`蓝图尺寸非法:${bp.w}×${bp.h}`);
  }
  if (bp.cells.length !== bp.w * bp.h) {
    throw new Error(
      `蓝图格数与尺寸不符:${bp.cells.length} 格 vs ${bp.w}×${bp.h} = ${bp.w * bp.h} 格`,
    );
  }
  const bytes: number[] = [];
  let runs = 0;
  /* 上面已断言 `cells.length === w*h ≥ 1` ⇒ 首格必然存在(不再是「空 cells 兜底值」) */
  let prev = cellToValue(bp.cells[0]);
  let run = 0;
  for (const c of bp.cells) {
    const v = cellToValue(c);
    if (v === prev) {
      run += 1;
      continue;
    }
    pushVarint(bytes, prev);
    pushVarint(bytes, run);
    runs += 1;
    prev = v;
    run = 1;
  }
  pushVarint(bytes, prev);
  pushVarint(bytes, run);
  runs += 1;
  const payload = toBase64(bytes);
  return {
    code: `${BLUEPRINT_MAGIC}:${bp.w}x${bp.h}:${payload}`,
    bytes: bytes.length,
    runs,
    ratio: bytes.length / (bp.cells.length * 4),
  };
}

/** 蓝图码 → 蓝图(严格校验,失败抛错便于测试断言)。 */
export function decodeBlueprint(code: string): Blueprint {
  const parts = code.trim().split(':');
  if (parts.length !== 3) throw new Error('蓝图码格式错误:缺少 3 段');
  const [magic, size, payload] = parts;
  if (magic !== BLUEPRINT_MAGIC) throw new Error(`蓝图码魔数不符:${magic}`);
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) throw new Error(`蓝图码尺寸段非法:${size}`);
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isInteger(w) || !Number.isInteger(h)
    || w < BLUEPRINT_MIN_SIZE || h < BLUEPRINT_MIN_SIZE
    || w > BLUEPRINT_MAX_SIZE || h > BLUEPRINT_MAX_SIZE
    || w * h > BLUEPRINT_MAX_CELLS) {
    throw new Error(
      `蓝图尺寸 ${w}×${h} 超出 208 卷轴能力`
      + `(单边 ${BLUEPRINT_MIN_SIZE}..${BLUEPRINT_MAX_SIZE})`,
    );
  }
  const cells: BlueprintCell[] = [];
  const expected = w * h;
  /*
   * ⚠️ **游程上界必须在展开之前判**。展开是 `for (k < run) cells.push(...)`,
   * 而 `readVarint` 能解出 ~2^49 级的 run(8 字节 `\xff` 续位)。
   * 旧写法「先展开、再判 `cells.length > w*h`」让守卫永远等不到执行:
   * 一张 16×16 的短码就能让 `cells` 涨到 5×10^14 格 ⇒ 挂死 / OOM,
   * 攻击者不需要大 payload,只需要一个小 run 字段。
   *   ⇒ 两个上界都判:`run` 自身的具名上限(`MAX_RUN_CELLS`)
   *      与「累计格数不得超过 `w*h`」。任一越界立刻抛,内存占用恒为 O(w*h)。
   */
  const bytes = fromBase64(payload);
  const cursor: Cursor = { i: 0, buf: bytes };
  while (cursor.i < bytes.length) {
    const v = readVarint(cursor);
    const run = readVarint(cursor);
    if (run === 0) throw new Error('蓝图码损坏:游程长度为 0');
    if (run > MAX_RUN_CELLS || cells.length + run > expected) {
      throw new Error(
        `蓝图码损坏:游程长度 ${run} 超出尺寸上界`
        + `(单游程 ≤ ${MAX_RUN_CELLS},累计 ≤ ${expected},已解 ${cells.length})`,
      );
    }
    for (let k = 0; k < run; k += 1) cells.push(valueToCell(v));
  }
  if (cells.length !== w * h) {
    throw new Error(`蓝图码不完整:解出 ${cells.length} 格,期望 ${w * h}`);
  }
  return { w, h, cells, originX: 0, originY: 0 };
}

/** round-trip 便捷入口。 */
export function blueprintCode(bp: Blueprint): string {
  return encodeBlueprint(bp).code;
}

/* ─────────────────── 材料清单展开 ─────────────────── */

/**
 * 材料清单展开规则:
 *  - 每个非空 `obj` 格按该物品自身的 `recipe` 展开成原材料;无配方(自然/掉落件)则按 1 件自身计;
 *  - 地板格按地砖物品 ID(floor + 300 映射区间 301~330)计 1 件;
 *  - 同类材料累加,输出按 ID 升序。
 *
 * **地板槽位 → 物品 ID 必须委派 WS-01 的 `floorIdOfSlot()`**:
 * 线性关系 `itemId = 300 + floor` 只在槽位 1..30(地砖 301..330)成立;
 * 槽位 31..63 是 UGC 像素地毯,全部映射到 314。此处若本地重写偏移,
 * 槽位 ≥31 会产出 331..363 这类**物品表里不存在的幽灵 ID**。
 */
export const FLOOR_ID_OFFSET = 300;

/**
 * 地板槽位 → 物品 ID。
 *
 * 唯一事实源是 `world/chunk.ts#floorIdOfSlot`(内部走 `FLOOR_PALETTE`)。
 * 本函数只做「0 表示无铺装」的语义包装,不重写映射。
 */
export function floorItemId(floor: number): number {
  const f = floor | 0;
  if (f <= 0) return 0;
  return floorIdOfSlot(f);
}

export interface ManifestOptions {
  /** 是否把每个物件展开为其合成配方原料(默认 true) */
  expandRecipes: boolean;
  /** 是否统计地板 */
  includeFloors: boolean;
  /** 是否把暗线布设计入「四色电路扳手」消耗(每 16 格 1 把) */
  includeWiringTool: boolean;
}

export const DEFAULT_MANIFEST_OPTIONS: ManifestOptions = {
  expandRecipes: true,
  includeFloors: true,
  includeWiringTool: true,
};

/** 四色电路扳手 207:每 16 格暗线消耗 1 把。 */
export const WIRE_TOOL_ID = 207;
export const WIRE_CELLS_PER_TOOL = 16;

export function expandMaterials(bp: Blueprint, options: ManifestOptions = DEFAULT_MANIFEST_OPTIONS): MaterialManifest {
  const acc = new Map<number, number>();
  const add = (id: number, n: number): void => {
    if (id <= 0 || n <= 0) return;
    acc.set(id, (acc.get(id) ?? 0) + n);
  };

  let objectCount = 0;
  let floorCount = 0;
  let wireCells = 0;

  for (const c of bp.cells) {
    if (c.obj !== 0) {
      objectCount += 1;
      const def = ITEM_BY_ID.get(c.obj);
      if (options.expandRecipes && def?.recipe) {
        for (const [k, v] of Object.entries(def.recipe)) add(Number(k), v);
      } else {
        add(c.obj, 1);
      }
    }
    if (c.floor !== 0) {
      floorCount += 1;
      if (options.includeFloors) add(floorItemId(c.floor), 1);
    }
    if (c.wire !== 0) wireCells += 1;
  }

  if (options.includeWiringTool && wireCells > 0) {
    add(WIRE_TOOL_ID, Math.ceil(wireCells / WIRE_CELLS_PER_TOOL));
  }

  const lines: MaterialLine[] = [...acc.entries()]
    .map(([id, count]) => {
      const unitValue = itemValue(id);
      return { id, name: itemName(id), count, unitValue, totalValue: unitValue * count };
    })
    .sort((a, b) => a.id - b.id);

  return {
    lines,
    kinds: lines.length,
    totalCount: lines.reduce((s, l) => s + l.count, 0),
    totalValue: lines.reduce((s, l) => s + l.totalValue, 0),
    objectCount,
    floorCount,
  };
}

/* ─────────────────── 飞砖接力队列 ─────────────────── */

export const RelayTaskState = {
  PENDING: 'PENDING',
  FLYING: 'FLYING',
  PLACED: 'PLACED',
} as const;
export type RelayTaskState = (typeof RelayTaskState)[keyof typeof RelayTaskState];

export interface RelayTask {
  seq: number;
  /** 目标格在蓝图内的下标 */
  cellIndex: number;
  /** 蓝图内相对坐标 */
  lx: number;
  ly: number;
  obj: number;
  floor: number;
  elev: number;
  wire: number;
  meta: number;
  state: RelayTaskState;
  /** 认领该任务的玩家 ID */
  owner: string | null;
  /** 任务开始飞行的时间戳(ms) */
  startedAt: number;
  /** 材料是否已投喂成功 */
  materialFed: boolean;
}

/** 每块飞砖的飞行时长(ms):距离越远越久,基准 400ms + 60ms/格。 */
export const BRICK_FLIGHT_BASE_MS = 400;
export const BRICK_FLIGHT_PER_CELL_MS = 60;

export interface RelayQueueOptions {
  /** 接力人数上限(房主 + 好友),手册建议 1~8 人 */
  maxBuilders: number;
  /** 每人同时在飞的砖数上限 */
  perBuilderParallel: number;
}

export const DEFAULT_RELAY_OPTIONS: RelayQueueOptions = {
  maxBuilders: 8,
  perBuilderParallel: 2,
};
/**
 * 接力选项的**入口校验** —— 全局只此一处实现(`buildRelayQueue` 与
 * `RelayQueue` 构造函数都走它)。
 *
 * ## 为什么必须显式拒绝,而不是夹取/容忍
 *
 * 旧写法对两个字段各有一套**静默**的坏行为,而且方向相反:
 * ```ts
 * builders.slice(0, Math.max(1, options.maxBuilders))  // 0 / 负值 ⇒ 悄悄抬成 1
 * if (flyingCount(b.id) >= options.perBuilderParallel) continue;
 *                                                       // 0 / 负值 ⇒ 恒成立
 *                                                       // ⇒ 永不派活、drain() 空转
 * ```
 * 也就是 `{maxBuilders: 0, perBuilderParallel: 0}` 这种配置**不报错**:
 * 前者被改写、后者让整个接力队列一条任务都不发(`remaining` 永远 > 0)。
 * 调用方(派对模式 / 自定义难度)拿到的是「接力功能静默失效」,
 * 而日志里一个异常都没有 ⇒ 只能靠人肉读代码发现。
 *   ⇒ 改成**当场抛**:上限必须是 ≥1 的整数。默认值 `DEFAULT_RELAY_OPTIONS`
 *      合法,既有调用点行为不变。
 */
function assertRelayOptions(options: RelayQueueOptions): void {
  if (!Number.isInteger(options.maxBuilders) || options.maxBuilders < 1) {
    throw new Error(`接力人数上限必须是 ≥1 的整数,收到 ${options.maxBuilders}`);
  }
  if (!Number.isInteger(options.perBuilderParallel) || options.perBuilderParallel < 1) {
    throw new Error(`每人并行在飞上限必须是 ≥1 的整数,收到 ${options.perBuilderParallel}`);
  }
}

/**

/**
 * 飞砖接力队列:把蓝图拆成「每格一个任务」,按「先下后上、先外后内」排序。
 *
 * 排序理由:屋顶(372~376)必须最后铺,否则会遮挡内部施工的虚影预览;
 * 墙体优先立起,让接力队伍能看到房间轮廓。
 */
export function buildRelayQueue(bp: Blueprint, options: RelayQueueOptions = DEFAULT_RELAY_OPTIONS): RelayTask[] {
  /*
   * 入口校验。本函数**自己不消费** options(排队顺序与人数无关,归属由
   * `RelayQueue` 构造时一次算定),但旧代码用一句 `void options;` 把这事实
   * 写成了「参数收下就不用管」—— 于是非法配置从这里一路静默通过,
   * 直到 `RelayQueue` 里才以「夹取 / 永不派活」两种静默形态爆出来。
   *   ⇒ 校验放在**最早**的入口:一张非法配置不该先造出 N 个任务再报错。
   */
  assertRelayOptions(options);
  const tasks: RelayTask[] = [];
  const cellCount = bp.cells.length;
  for (let i = 0; i < cellCount; i += 1) {
    const c = bp.cells[i];
    tasks.push({
      seq: 0,
      cellIndex: i,
      lx: i % bp.w,
      ly: Math.floor(i / bp.w),
      obj: c.obj,
      floor: c.floor,
      elev: c.elev,
      wire: c.wire,
      meta: c.meta,
      state: RelayTaskState.PENDING,
      owner: null,
      startedAt: 0,
      materialFed: false,
    });
  }
  /* 阶段权重:墙体(351~362)= 1,门窗(363~371)= 2,家具/电路(≥500 或 4xx)= 3,屋顶(372~376)= 4 */
  const stageOf = (obj: number): number => {
    if (obj === 0) return 0;
    if (obj >= 351 && obj <= 362) return 1;
    if (obj >= 363 && obj <= 371) return 2;
    if (obj >= 372 && obj <= 376) return 4;
    return 3;
  };
  tasks.sort((a, b) => {
    const sa = stageOf(a.obj);
    const sb = stageOf(b.obj);
    if (sa !== sb) return sa - sb;
    if (a.ly !== b.ly) return a.ly - b.ly;
    return a.lx - b.lx;
  });
  for (let i = 0; i < tasks.length; i += 1) tasks[i].seq = i;
  void options;
  return tasks;
}

/** 飞砖飞行时长(ms):由接力的两名玩家间的曼哈顿距离决定。 */
export function flightDurationMs(dist: number, buildSpeedMul = 1): number {
  const d = Math.max(0, dist);
  const raw = BRICK_FLIGHT_BASE_MS + d * BRICK_FLIGHT_PER_CELL_MS;
  return Math.round(raw / Math.max(0.1, buildSpeedMul));
}

export interface RelayBuilder {
  id: string;
  /** 当前位置(世界格),用于估算飞行时长 */
  x: number;
  y: number;
  /** 建造速度乘数(专精加成) */
  speedMul: number;
}

export interface RelayTickResult {
  /** 本次 tick 新完成放置的任务 */
  placed: RelayTask[];
  /** 本次 tick 新派发的任务 */
  assigned: RelayTask[];
  /** 是否还有未完成任务 */
  remaining: number;
}

/**
 * 接力推进器:每个 tick 给空闲玩家派活,并把飞行时间到的任务标记为已放置。
 *
 * 派发规则(**确定性轮转**,不是贪心也不是按材料重量):
 *   - 构造时就把「任务 i 归谁」钉死为 `active[i % k]`,即第 i 条按 index 取模派给第 i%k 人;
 *   - 因此 N 条任务分给 k 人时,每人恰好 `floor(N/k)` 或 `ceil(N/k)` 条,负载差恒 ≤ 1;
 *   - `perBuilderParallel` 只是**并发在飞上限**(防止一人手上同时飞 40 块),不影响最终归属;
 *   - 256 条 / 8 人 = 每人 32 条;257 条 / 8 人 = 33,32,32,32,32,32,32,32。
 */
export class RelayQueue {
  tasks: RelayTask[];
  builders: RelayBuilder[];
  options: RelayQueueOptions;
  /** 任务 seq → 预定归属玩家 ID(构造时一次算定) */
  readonly plan: Map<number, string>;
  private cursor: number;

  constructor(tasks: RelayTask[], builders: RelayBuilder[], options: RelayQueueOptions = DEFAULT_RELAY_OPTIONS) {
    /* 非法上限**当场拒**(见 `assertRelayOptions`):此处不再 `Math.max(1, ...)` 静默夹取 */
    assertRelayOptions(options);
    this.tasks = tasks;
    this.builders = builders;
    this.options = options;
    this.cursor = 0;
    this.plan = new Map<number, string>();
    const active = builders.slice(0, options.maxBuilders);
    if (active.length > 0) {
      for (let i = 0; i < tasks.length; i += 1) {
        this.plan.set(tasks[i].seq, active[i % active.length].id);
      }
    }
  }

  private flyingCount(builderId: string): number {
    let n = 0;
    for (const t of this.tasks) if (t.state === RelayTaskState.FLYING && t.owner === builderId) n += 1;
    return n;
  }

  tick(now: number): RelayTickResult {
    const assigned: RelayTask[] = [];
    const placed: RelayTask[] = [];

    /* 1. 结算已到时的任务 */
    for (const t of this.tasks) {
      if (t.state !== RelayTaskState.FLYING) continue;
      const b = this.builders.find((x) => x.id === t.owner);
      const dist = b ? Math.abs(b.x - t.lx) + Math.abs(b.y - t.ly) : 0;
      const dur = flightDurationMs(dist, b?.speedMul ?? 1);
      if (now - t.startedAt >= dur) {
        t.state = RelayTaskState.PLACED;
        t.materialFed = true;
        placed.push(t);
      }
    }

    /* 2. 派发:按预定归属走,只受并发上限约束 */
    /* 构造时已校验过上限(≥1)⇒ 这里直接切,不再 `Math.max(1, ...)` 掩盖非法值 */
    const active = this.builders.slice(0, this.options.maxBuilders);
    if (active.length > 0) {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const b of active) {
          if (this.flyingCount(b.id) >= this.options.perBuilderParallel) continue;
          /* 该玩家名下第一条还没派出去的任务 */
          let next: RelayTask | undefined;
          for (const t of this.tasks) {
            if (t.state !== RelayTaskState.PENDING) continue;
            if (this.plan.get(t.seq) !== b.id) continue;
            next = t;
            break;
          }
          if (!next) continue;
          next.state = RelayTaskState.FLYING;
          next.owner = b.id;
          next.startedAt = now;
          assigned.push(next);
          progressed = true;
        }
      }
    }

    return {
      placed,
      assigned,
      remaining: this.tasks.filter((t) => t.state !== RelayTaskState.PLACED).length,
    };
  }

  /** 一次性跑完(测试与「瞬时完成」调试用)。 */
  drain(stepMs = 50, maxSteps = 100000): { steps: number; placed: number } {
    let now = 0;
    let steps = 0;
    let placed = 0;
    while (steps < maxSteps) {
      const r = this.tick(now);
      placed += r.placed.length;
      steps += 1;
      if (r.remaining === 0) break;
      now += stepMs;
    }
    return { steps, placed };
  }

  /** 把已放置的任务写回世界网格(蓝图坐标系 + 偏移)。 */
  applyTo(grid: TileGridLike, ox: number, oy: number): number {
    let n = 0;
    for (const t of this.tasks) {
      if (t.state !== RelayTaskState.PLACED) continue;
      const f = unpackTile(grid.get(ox + t.lx, oy + t.ly));
      /*
       * 32 位世界格只能装 ID 的**低位部分**:`FLOOR_WORD_MASK`(6 位)/
       * `OBJ_WORD_MASK`(12 位)就是「一个世界格装得下的宽度」。u16 高位在
       * 蓝图码里完整保留,落位到 32 位世界格时按位宽截断 —— 这是**登记过的
       * 边界**(见 `shared/contracts/FREEZE.md` D-19 条:世界格/存档扩宽
       * 归 WS-01 / WS-07,不在本批)。
       */
      f.obj = t.obj & OBJ_WORD_MASK;
      f.floor = t.floor & FLOOR_WORD_MASK;
      f.elev = t.elev & 0x3;
      f.wire = t.wire & 0xf;
      f.meta = t.meta & 0xf;
      grid.set(ox + t.lx, oy + t.ly, packTile(f));
      n += 1;
    }
    return n;
  }

  /** 当前进度 0..1。 */
  progress(): number {
    if (this.tasks.length === 0) return 1;
    const done = this.tasks.filter((t) => t.state === RelayTaskState.PLACED).length;
    return done / this.tasks.length;
  }
}

/** 分工统计:每个玩家被分到多少块(用于 UI 侧显示接力进度条)。 */
export function relayWorkload(tasks: readonly RelayTask[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner) continue;
    m.set(t.owner, (m.get(t.owner) ?? 0) + 1);
  }
  return m;
}

/**
 * 默认 16×16 场景的格数(恒定 256),供 UI 显示。
 * 非默认尺寸请用 `blueprintCellCount(bp)` —— 尺寸自 D-19 起不再是一个常量。
 */
export const BLUEPRINT_CELL_COUNT = BLUEPRINT_CELLS;

/** 蓝图实际格数 `w × h`。 */
export function blueprintCellCount(bp: Blueprint): number {
  return bp.w * bp.h;
}

/** 从蓝图取出非空格坐标清单(材料投喂的遍历顺序)。 */
export function blueprintSolidCells(bp: Blueprint): { lx: number; ly: number; obj: number }[] {
  const out: { lx: number; ly: number; obj: number }[] = [];
  for (let i = 0; i < bp.cells.length; i += 1) {
    const c = bp.cells[i];
    if (c.obj === 0) continue;
    out.push({ lx: i % bp.w, ly: Math.floor(i / bp.w), obj: c.obj });
  }
  return out;
}

/** 供房间检测复用:蓝图 → 独立网格。 */
export function blueprintToGrid(bp: Blueprint): TileGrid {
  const g = new TileGrid(bp.w, bp.h);
  for (let i = 0; i < bp.cells.length; i += 1) {
    const c = bp.cells[i];
    g.set(i % bp.w, Math.floor(i / bp.w), cellToValue(c));
  }
  return g;
}