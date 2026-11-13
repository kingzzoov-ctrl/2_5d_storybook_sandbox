/**
 * WS-07 · 20Hz 状态协议 ——「**线上格式**」的唯一定义处(shared 层)。
 *
 * ## 这个文件为什么在 shared/ 而不是 server/src/net/
 *
 * 它承载的是**客户端与服务端都必须认同**的东西:字段表、字段类型、定点定标、
 * 实体种类判别、状态结构。客户端解码收到的字节**必须**用同一份表,
 * 否则两侧各自抄一份就会漂移。所以它属于 shared,不属于任何一侧。
 *
 * 判据不是「谁 import 它」,而是「**谁必须用它解释收到的字节**」。
 * 按这条判据,以下符号归本文件:
 *   · 线上格式:FieldType / FIELD_TYPE_BYTES / POS_SCALE / quantizePos /
 *     dequantizePos / FieldSpec / FIELD_TABLE / WILDLIFE_FIELD_TABLE /
 *     BOSS_FIELD_TABLE / ROOM_FIELD_TABLE / tableFor / EntityKind /
 *     ENTITY_KIND_LABEL / chunkKey / serializeChunkVersions / parseChunkVersions
 *   · 状态结构(客户端要装得下):PlayerState / WildlifeState / BossState /
 *     RoomMetaState / RoomState / cloneRoomState
 *   · 位压缩的词表(客户端要把 u8 解成语义):StateFlagIndex / STATE_FLAG_NAMES /
 *     FsmIndex / FSM_NAMES / TelegraphShape
 *
 * ⚠️ **不在这里**的(留在 `server/src/net/schema.ts`,共 16 个):
 *   `createPlayerState` / `createWildlifeState` / `createBossState` / `createRoomState`
 *   / `upsert*` / `remove*` / `bumpChunkVersion` / `fullMask` / `validateFieldTable`
 *   / `fieldBytes` / `entityPayloadBytes` / `MAX_FIELDS_PER_TABLE`
 *   ⇒ 这些是**服务端状态管理**(建实体、改容器、算掩码、CI 自检、带宽估算),
 *     客户端不做这些事 ⇒ 留在 server。
 *
 * ## 来源
 *
 * 本文件内容**逐字**自 `server/src/net/schema.ts` 上移(CR-24 裁决 (b)),
 * 并按实测消费者切分。上移后 `schema.ts` 用 `export * from` 转发本文件,
 * **不重新定义任何符号** —— 编译期转发只有**一份实现**,
 * 两个地址指向同一绑定 ⇒ 内容不可能漂移(由引用相等断言守住)。
 *
 * 单位:坐标 = 格(协议上按 1/1024 格定点量化);时间 = 秒;血量 = 整数 HP。
 */

import { BodyState } from './physics.ts';
import { MobFsmState } from './entities.ts';

/* ═══════════════════════════ 1. 字段类型与字节宽度 ═══════════════════════════ */

/**
 * 协议字段类型。每一种都在 `FIELD_TYPE_BYTES` 里给出**线上字节数**,文档 §5 带宽估算
 * 与 §6 帧预算都以这张表为唯一依据。
 *
 *  - `pos`     : int32 小端,单位 1/1024 格。精度 0.0009766 格,远低于 0.05 格校正阈值。
 *  - `u8` / `u16` / `u32` : 无符号定长整数。
 *  - `i16`     : int16,用于 -1..3 的 Z 层(实际用 pos,保留作扩展)。
 *  - `str`     : u8 长度前缀 + UTF-8。id / name / entityId 用这个。
 *  - `hash`    : 同 `str`,但语义是 `recipeHash()` 的排序拼接串(如 `116_125_712`)。
 */
export const FieldType = {
  POS: 'pos',
  U8: 'u8',
  U16: 'u16',
  U32: 'u32',
  I16: 'i16',
  STR: 'str',
  HASH: 'hash',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

/** 定长类型的线上字节数。变长类型按内容算。 */
export const FIELD_TYPE_BYTES: Readonly<Record<string, number>> = {
  pos: 4,
  u8: 1,
  u16: 2,
  u32: 4,
  i16: 2,
};

/** 坐标定点比例:线上 i32 / 1024 = 格。 */
export const POS_SCALE = 1024;

export function quantizePos(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const q = Math.round(v * POS_SCALE);
  if (q > 2147483647) return 2147483647;
  if (q < -2147483648) return -2147483648;
  return q;
}

export function dequantizePos(q: number): number {
  return q / POS_SCALE;
}

/* ═══════════════════════════ 2. 字段表:唯一的线上格式事实源 ═══════════════════════════ */

export interface FieldSpec {
  /** 字段在 `PlayerState` 上的属性名。 */
  key: string;
  /** 位掩码位序号,0..31。同一个表的位序号不得重复。 */
  bit: number;
  type: FieldType;
  /** 定长字节数;变长类型给「典型字节数」,实际按内容算。 */
  bytes: number;
  /** 手册/契约出处,便于审计。 */
  note: string;
}

/**
 * §7.2 PlayerSchema 全 13 字段 + 协议必需的 id/name。
 * 顺序即编码顺序,客户端与服务端必须一致 —— 任何改动都是协议版本 bump。
 */
export const FIELD_TABLE: readonly FieldSpec[] = [
  { key: 'id', bit: 0, type: FieldType.STR, bytes: 8, note: '§7.2 玩家 id;8 字符 nanoid' },
  { key: 'name', bit: 1, type: FieldType.STR, bytes: 9, note: '§7.2 昵称;len(1)+8 中文字节' },
  { key: 'level', bit: 2, type: FieldType.U8, bytes: 1, note: '§7.2 等级 1..30' },
  { key: 'hp', bit: 3, type: FieldType.U16, bytes: 2, note: '§7.2 当前 HP 0..65535' },
  { key: 'maxHp', bit: 4, type: FieldType.U16, bytes: 2, note: '§7.2 HP 上限(100+15(L-1)+护甲)' },
  { key: 'x', bit: 5, type: FieldType.POS, bytes: 4, note: '§7.2 世界 X,1/1024 格定点' },
  { key: 'y', bit: 6, type: FieldType.POS, bytes: 4, note: '§7.2 世界 Y,1/1024 格定点' },
  { key: 'z', bit: 7, type: FieldType.POS, bytes: 4, note: '§7.2 高度 Z ∈ [-1,3]' },
  { key: 'dir', bit: 8, type: FieldType.U8, bytes: 1, note: '§7.2 朝向 0=北 1=东 2=南 3=西' },
  { key: 'stateFlag', bit: 9, type: FieldType.U8, bytes: 1, note: '§7.2 BodyState 七态索引 0..6' },
  { key: 'weaponId', bit: 10, type: FieldType.U16, bytes: 2, note: '§7.2 手持武器物品 ID(0=空手)' },
  { key: 'aiWeaponRecipeHash', bit: 11, type: FieldType.HASH, bytes: 13, note: '§7.2 AI 武器配方哈希;len(1)+12' },
  { key: 'heldItemId', bit: 12, type: FieldType.U16, bytes: 2, note: '§7.2 举起/持握物品 ID(0=空)' },
  { key: 'carryingEntityId', bit: 13, type: FieldType.STR, bytes: 9, note: '§7.2 叠罗汉承载对象;len(1)+8' },
];

/** 野生动物 9 字段。 */
export const WILDLIFE_FIELD_TABLE: readonly FieldSpec[] = [
  { key: 'id', bit: 0, type: FieldType.STR, bytes: 8, note: '实体 id' },
  { key: 'mobId', bit: 1, type: FieldType.STR, bytes: 17, note: 'mobs.ts 的 mob_* 键;len(1)+16' },
  { key: 'x', bit: 2, type: FieldType.POS, bytes: 4, note: '世界 X' },
  { key: 'y', bit: 3, type: FieldType.POS, bytes: 4, note: '世界 Y' },
  { key: 'z', bit: 4, type: FieldType.POS, bytes: 4, note: '高度 Z' },
  { key: 'fsm', bit: 5, type: FieldType.U8, bytes: 1, note: 'MobFsmState 三态索引' },
  { key: 'hp', bit: 6, type: FieldType.U16, bytes: 2, note: '当前 HP' },
  { key: 'maxHp', bit: 7, type: FieldType.U16, bytes: 2, note: 'HP 上限' },
  { key: 'tameOwnerId', bit: 8, type: FieldType.STR, bytes: 9, note: '驯养归属;空串=野生' },
];

/** Boss 10 字段(含地面预警几何,手册 §4.3)。 */
export const BOSS_FIELD_TABLE: readonly FieldSpec[] = [
  { key: 'id', bit: 0, type: FieldType.STR, bytes: 8, note: 'Boss 实体 id' },
  { key: 'bossId', bit: 1, type: FieldType.STR, bytes: 17, note: 'bosses.ts 的 boss_* 键;len(1)+16' },
  { key: 'phase', bit: 2, type: FieldType.U8, bytes: 1, note: '阶段索引 0..2' },
  { key: 'hp', bit: 3, type: FieldType.U32, bytes: 4, note: '当前 HP;Boss 上限 38000 需 u32' },
  { key: 'maxHp', bit: 4, type: FieldType.U32, bytes: 4, note: '缩放后 HP 上限' },
  { key: 'telegraphShape', bit: 5, type: FieldType.U8, bytes: 1, note: '0=无 1=圆 2=扇 3=矩形 4=环' },
  { key: 'telegraphX', bit: 6, type: FieldType.POS, bytes: 4, note: '预警几何中心 X' },
  { key: 'telegraphY', bit: 7, type: FieldType.POS, bytes: 4, note: '预警几何中心 Y' },
  { key: 'telegraphR', bit: 8, type: FieldType.POS, bytes: 4, note: '预警半径/半宽' },
  { key: 'telegraphEndTick', bit: 9, type: FieldType.U32, bytes: 4, note: '预警结算帧(绝对 tick)' },
];

/**
 * 房间级 5 字段:Chunk 版本号表 + 派对模式状态。
 *
 * 注意:**世界帧号不在这张表里**。帧号每帧都变,放进字段表会让每帧都退化出一次
 * 房间级 upsert(≈ 28 字节),白白吃掉 40% 的稳态带宽。帧号由报文头的 `tick`
 * 承载,`applyPacket` 无条件用它覆盖 `meta.tick`。
 */
export const ROOM_FIELD_TABLE: readonly FieldSpec[] = [
  { key: 'chunkVersions', bit: 0, type: FieldType.STR, bytes: 24, note: '排序后的 "cx,cy:v" 串,变长' },
  { key: 'partyMode', bit: 1, type: FieldType.U8, bytes: 1, note: '0=NONE 1=BRIDGE_CTF 2=JELLY_BALL 3=CROWN_BR 4=PAINT_WAR(词表以冻结层 PARTY_MODES 为准)' },
  { key: 'partyTimer', bit: 2, type: FieldType.POS, bytes: 4, note: '派对剩余秒数' },
  { key: 'scoreA', bit: 3, type: FieldType.U16, bytes: 2, note: '红队比分 / 持冠秒数' },
  { key: 'scoreB', bit: 4, type: FieldType.U16, bytes: 2, note: '蓝队比分' },
];

/* ═══════════════════════════ 3. 位压缩词表与状态结构 ═══════════════════════════ */

/**
 * `player.stateFlag`(u8)的离线索引。
 *
 * ⚠️ 客户端**必须**用它把 u8 解成语义 —— 若各自抄一份,下标一旦不同
 * 就会出现「服务端说倒地、客户端画成冰冻」这类静默错判(CR-20 形态)。
 */
export const StateFlagIndex: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  const names = Object.values(BodyState) as string[];
  names.forEach((n, i) => { out[n] = i; });
  return out;
})();

export const STATE_FLAG_NAMES: readonly string[] = Object.values(BodyState) as string[];

/** `wildlife.fsm`(u8)的离线索引。同 StateFlagIndex 的理由。 */
export const FsmIndex: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  const names = Object.values(MobFsmState) as string[];
  names.forEach((n, i) => { out[n] = i; });
  return out;
})();

export const FSM_NAMES: readonly string[] = Object.values(MobFsmState) as string[];

export interface PlayerState {
  id: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  z: number;
  dir: number;
  stateFlag: number;
  weaponId: number;
  aiWeaponRecipeHash: string;
  heldItemId: number;
  carryingEntityId: string;
}

export interface WildlifeState {
  id: string;
  mobId: string;
  x: number;
  y: number;
  z: number;
  fsm: number;
  hp: number;
  maxHp: number;
  tameOwnerId: string;
}

/**
 * `boss.telegraphShape`(u8)的取值 —— **线上格式**(wire)。
 *
 * ## ⚠️ 与 `client/src/ui/boss_hud.ts` 的同名符号的关系(task-79 实测订正)
 *
 * 那一个 `TelegraphShape` 的成员是 **字符串**:
 * `{CIRCLE:'CIRCLE', ANNULUS:'ANNULUS', CONE:'CONE', LINE:'LINE', CROSS:'CROSS'}`
 * —— 即「渲染用的五种几何」,**不是下标表**。
 *
 * ⇒ **二者类型不相交(number vs string),不存在「下标冲突」**。
 *   旧注释写「它是 `{CIRCLE:0, ANNULUS:1, ...}` —— 5 个下标全部与这里不同」
 *   **是错的、且从未成立**:`git log -S "ANNULUS: 1"` 全仓历史 0 命中,
 *   `boss_hud.ts` 自首个提交 `d10a59f` 起就是字符串。
 *
 * ⇒ 实测的**真实**关系:
 *   · 生产代码里把本文件的数字赋给 `boss_hud` 的 `shape` 字段的位置:**0 处**
 *     (而 string/number 不相交,真去赋值会被类型检查挡住)
 *   · 客户端读 `telegraphShape` 的位置:**0 处**(客户端预警圈由
 *     `boot.ts` 的本地常量驱动,`shape: 'ANNULUS'` 硬编码)
 *   · 对 `TELEGRAPH_SHAPES` 做数字下标的位置:**0 处**
 *
 * ## 但**协议缺口是真的**(不是下标冲突,是**词表覆盖不到**)
 *
 * 两侧不是「同一概念的两套编号」,而是**两套不同的形状词汇**:
 *   · 仅 wire  : NONE / SECTOR / RECT / RING
 *   · 仅 client: ANNULUS / CONE / LINE / CROSS
 *   · 两侧同名: CIRCLE —— 语义也相同(都是「实心圆」),这是唯一真同义的一对
 *
 * ⇒ SECTOR 对 CONE、RECT 对 LINE、RING 对 ANNULUS 是**语义对应但拼写不同**,
 *   中间**缺一层显式映射**。这才是接线时要补的东西 —— 一个
 *   `wire 数字 → 客户端 shape 字符串` 的转换函数,而不是「统一编号」。
 *
 * ## 何时必须补
 *
 * 当客户端开始**从协议读** `boss.telegraphShape` 时。此前不补是安全的,
 * 因为客户端目前完全不听这个字段(见上「0 处」)。
 */
export const TelegraphShape = {
  NONE: 0,
  CIRCLE: 1,
  SECTOR: 2,
  RECT: 3,
  RING: 4,
} as const;
export type TelegraphShape = (typeof TelegraphShape)[keyof typeof TelegraphShape];

export interface BossState {
  id: string;
  bossId: string;
  phase: number;
  hp: number;
  maxHp: number;
  telegraphShape: number;
  telegraphX: number;
  telegraphY: number;
  telegraphR: number;
  telegraphEndTick: number;
}

export interface RoomMetaState {
  tick: number;
  chunkVersions: Record<string, number>;
  partyMode: number;
  partyTimer: number;
  scoreA: number;
  scoreB: number;
}

export interface RoomState {
  roomId: string;
  meta: RoomMetaState;
  players: PlayerState[];
  wildlife: WildlifeState[];
  bosses: BossState[];
}

/** 实体种类判别字节。0 保留为「非法」。 */
export const EntityKind = {
  ROOM: 1,
  PLAYER: 2,
  WILDLIFE: 3,
  BOSS: 4,
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const ENTITY_KIND_LABEL: Readonly<Record<number, string>> = {
  1: 'room',
  2: 'player',
  3: 'wildlife',
  4: 'boss',
};

/** 深拷贝:差量编码的 `prev` 快照必须是值拷贝,否则「引用即变更」会让 diff 永远为空。 */
export function cloneRoomState(s: RoomState): RoomState {
  return {
    roomId: s.roomId,
    meta: { ...s.meta, chunkVersions: { ...s.meta.chunkVersions } },
    players: s.players.map((p) => ({ ...p })),
    wildlife: s.wildlife.map((w) => ({ ...w })),
    bosses: s.bosses.map((b) => ({ ...b })),
  };
}

/* ═══════════════════════════ 4. Chunk 版本号编解码 ═══════════════════════════ */

/** Chunk 版本号键:`cx,cy`。 */
export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

/** 把 chunkVersions 拍成确定性字符串(键排序),供 diff 比较与线上传输。 */
export function serializeChunkVersions(map: Record<string, number>): string {
  return Object.keys(map)
    .sort()
    .map((k) => `${k}:${map[k]}`)
    .join(';');
}

export function parseChunkVersions(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!text) return out;
  for (const part of text.split(';')) {
    if (!part) continue;
    const idx = part.lastIndexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = Number(part.slice(idx + 1));
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/* ═══════════════════════════ 5. 字段表辅助 ═══════════════════════════ */

/**
 * 取某张表的字段规格,按 bit 升序。
 *
 * ⚠️ 它是四张字段表的**唯一可达入口** —— 直接引用计数看不出这层
 * (四张表在编码器体内「0 次直接引用」,但经它返回全部可达)。
 */
export function tableFor(kind: EntityKind): readonly FieldSpec[] {
  switch (kind) {
    case EntityKind.ROOM: return ROOM_FIELD_TABLE;
    case EntityKind.PLAYER: return FIELD_TABLE;
    case EntityKind.WILDLIFE: return WILDLIFE_FIELD_TABLE;
    case EntityKind.BOSS: return BOSS_FIELD_TABLE;
    default: throw new Error(`未知实体种类:${kind}`);
  }
}