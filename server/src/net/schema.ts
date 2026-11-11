/**
 * WS-07 · 20Hz 状态 Schema ——「纯数据结构 + 字段表」零依赖核心。
 *
 * 为什么不用 `@colyseus/schema` 直接写在这个文件里:
 *   - `tests/WS-07.test.ts` 必须零外部依赖(不得 import colyseus),否则在没装
 *     `colyseus` 的机器上 `node tests/WS-07.test.ts` 直接 ENOENT 模块;
 *   - 因此本文件只放**可序列化的纯对象结构**与**字段表常量 FIELD_TABLE**;
 *     真正的 `Schema` 子类(带 `@type` 装饰器)放在 `schema.colyseus.ts`,
 *     它 import 本文件的 FIELD_TABLE 逐字段生成 —— 两份定义只有一个事实源,
 *     字段漂移在编译期就暴露(schema.colyseus.ts 用 FIELD_TABLE 做穷举断言)。
 *
 * 编码/解码在 `delta.ts`;这里只描述「有什么字段、什么类型、占多少字节」。
 *
 * 单位:坐标 = 格(协议上按 1/1024 格定点量化);时间 = 秒;血量 = 整数 HP。
 */

import { BodyState } from '../../../shared/types/physics.ts';
import { MobFsmState } from '../../../shared/types/entities.ts';

/* ═══════════════════════════ 1. 字段类型与字节宽度 ═══════════════════════════ */

/**
 * 协议字段类型。每一种都在 `FIELD_BYTES` 里给出**线上字节数**,文档 §5 带宽估算
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

/** 定长类型的线上字节数。变长类型见 `FIELD_BYTES` 的注释列。 */
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
  /** 定长字节数;变长类型给「典型字节数」,实际按内容算(见 `fieldBytes`)。 */
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

/** Boss 9 字段(含地面预警几何,手册 §4.3)。 */
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
  { key: 'partyMode', bit: 1, type: FieldType.U8, bytes: 1, note: '0=NONE 1=BRIDGE_FLAG 2=JELLY_BALL 3=CROWN_RUN 4=PAINT_WAR' },
  { key: 'partyTimer', bit: 2, type: FieldType.POS, bytes: 4, note: '派对剩余秒数' },
  { key: 'scoreA', bit: 3, type: FieldType.U16, bytes: 2, note: '红队比分 / 持冠秒数' },
  { key: 'scoreB', bit: 4, type: FieldType.U16, bytes: 2, note: '蓝队比分' },
];

/** 一张表能表达的最大字段数(掩码用 u32)。 */
export const MAX_FIELDS_PER_TABLE = 32;

/* ═══════════════════════════ 3. 运行时状态结构 ═══════════════════════════ */

export const StateFlagIndex: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  const names = Object.values(BodyState) as string[];
  names.forEach((n, i) => { out[n] = i; });
  return out;
})();

export const STATE_FLAG_NAMES: readonly string[] = Object.values(BodyState) as string[];

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

/* ═══════════════════════════ 4. 构造与默认值 ═══════════════════════════ */

export function createPlayerState(id: string, patch: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id,
    level: 1,
    hp: 100,
    maxHp: 100,
    x: 0, y: 0, z: 0,
    dir: 0,
    stateFlag: 0,
    weaponId: 0,
    aiWeaponRecipeHash: '',
    heldItemId: 0,
    carryingEntityId: '',
    ...patch,
  };
}

export function createWildlifeState(id: string, patch: Partial<WildlifeState> = {}): WildlifeState {
  return {
    id,
    mobId: 'mob_meadow_piglet',
    x: 0, y: 0, z: 0,
    fsm: 0,
    hp: 30,
    maxHp: 30,
    tameOwnerId: '',
    ...patch,
  };
}

export function createBossState(id: string, patch: Partial<BossState> = {}): BossState {
  return {
    id,
    bossId: 'boss_jelly_king',
    phase: 0,
    hp: 2500,
    maxHp: 2500,
    telegraphShape: TelegraphShape.NONE,
    telegraphX: 0, telegraphY: 0, telegraphR: 0,
    telegraphEndTick: 0,
    ...patch,
  };
}

export function createRoomState(roomId: string): RoomState {
  return {
    roomId,
    meta: { tick: 0, chunkVersions: {}, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 },
    players: [],
    wildlife: [],
    bosses: [],
  };
}

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

export function upsertPlayer(s: RoomState, p: PlayerState): PlayerState {
  const i = s.players.findIndex((x) => x.id === p.id);
  if (i === -1) { s.players.push({ ...p }); return s.players[s.players.length - 1]; }
  s.players[i] = { ...p };
  return s.players[i];
}

export function removePlayer(s: RoomState, id: string): boolean {
  const i = s.players.findIndex((x) => x.id === id);
  if (i === -1) return false;
  s.players.splice(i, 1);
  return true;
}

export function upsertWildlife(s: RoomState, w: WildlifeState): WildlifeState {
  const i = s.wildlife.findIndex((x) => x.id === w.id);
  if (i === -1) { s.wildlife.push({ ...w }); return s.wildlife[s.wildlife.length - 1]; }
  s.wildlife[i] = { ...w };
  return s.wildlife[i];
}

export function removeWildlife(s: RoomState, id: string): boolean {
  const i = s.wildlife.findIndex((x) => x.id === id);
  if (i === -1) return false;
  s.wildlife.splice(i, 1);
  return true;
}

export function upsertBoss(s: RoomState, b: BossState): BossState {
  const i = s.bosses.findIndex((x) => x.id === b.id);
  if (i === -1) { s.bosses.push({ ...b }); return s.bosses[s.bosses.length - 1]; }
  s.bosses[i] = { ...b };
  return s.bosses[i];
}

export function removeBoss(s: RoomState, id: string): boolean {
  const i = s.bosses.findIndex((x) => x.id === id);
  if (i === -1) return false;
  s.bosses.splice(i, 1);
  return true;
}

/** Chunk 版本号键:`cx,cy`。 */
export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export function bumpChunkVersion(s: RoomState, cx: number, cy: number): number {
  const k = chunkKey(cx, cy);
  const v = (s.meta.chunkVersions[k] ?? 0) + 1;
  s.meta.chunkVersions[k] = v;
  return v;
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

/** 取某张表的字段规格,按 bit 升序。 */
export function tableFor(kind: EntityKind): readonly FieldSpec[] {
  switch (kind) {
    case EntityKind.ROOM: return ROOM_FIELD_TABLE;
    case EntityKind.PLAYER: return FIELD_TABLE;
    case EntityKind.WILDLIFE: return WILDLIFE_FIELD_TABLE;
    case EntityKind.BOSS: return BOSS_FIELD_TABLE;
    default: throw new Error(`未知实体种类:${kind}`);
  }
}

/** 所有表的全字段掩码(用于 spawn)。 */
export function fullMask(kind: EntityKind): number {
  let m = 0;
  for (const f of tableFor(kind)) m |= (1 << f.bit) >>> 0;
  return m >>> 0;
}

/** 校验字段表本身的一致性:bit 不重复、bit < 32、key 不重复。 */
export function validateFieldTable(t: readonly FieldSpec[]): string[] {
  const errs: string[] = [];
  const bits = new Set<number>();
  const keys = new Set<string>();
  for (const f of t) {
    if (f.bit < 0 || f.bit >= MAX_FIELDS_PER_TABLE) errs.push(`${f.key}: bit=${f.bit} 越界`);
    if (bits.has(f.bit)) errs.push(`${f.key}: bit=${f.bit} 重复`);
    if (keys.has(f.key)) errs.push(`${f.key}: key 重复`);
    bits.add(f.bit);
    keys.add(f.key);
  }
  const ordered = t.every((f, i) => i === 0 || t[i - 1].bit < f.bit);
  if (!ordered) errs.push('字段表未按 bit 升序排列');
  return errs;
}

/** 单字段的典型线上字节数(变长字段按表里的典型值)。 */
export function fieldBytes(kind: EntityKind, key: string): number {
  const f = tableFor(kind).find((x) => x.key === key);
  if (!f) throw new Error(`${ENTITY_KIND_LABEL[kind] ?? kind}.${key} 不在字段表中`);
  return f.bytes;
}

/** 一个实体「全字段」的典型字节数(不含 op/id/掩码开销)。 */
export function entityPayloadBytes(kind: EntityKind): number {
  return tableFor(kind).reduce((s, f) => s + f.bytes, 0);
}