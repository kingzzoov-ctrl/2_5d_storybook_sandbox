/**
 * WS-07 · 20Hz 状态 Schema ——**服务端状态管理**部分。
 *
 * ## 这个文件现在只剩什么
 *
 * 「线上格式」(字段表 / 字段类型 / 定点定标 / 位压缩词表 / 状态结构)
 * 已按 CR-24 裁决上移到 `shared/types/wire.ts` —— 因为**客户端解码也必须用同一份**。
 *
 * 留在这里的是**只有服务端才做**的事(共 16 个导出):
 *   · 构造器:`createPlayerState` / `createWildlifeState` / `createBossState` / `createRoomState`
 *   · 容器写操作:`upsert*` / `remove*` / `bumpChunkVersion`
 *   · 掩码与自检:`fullMask` / `validateFieldTable` / `MAX_FIELDS_PER_TABLE`
 *   · 带宽估算:`fieldBytes` / `entityPayloadBytes`
 * 判据不是「谁 import 它」,而是「**客户端是否需要用它解释收到的字节**」——
 * 以上没有一个客户端需要,所以留下。
 *
 * ## ⚠️ 转发规则(硬约束,由引用相等断言守住)
 *
 * 下面那行 `export * from '../../../shared/types/wire.ts'` 是**唯一**允许的转发形式。
 * **不得在本文件重新定义任何一个已上移的符号**(不得写 `export const FIELD_TABLE = ...`)。
 *
 * 为什么这条区别重要:
 *   · `export * from` = **编译期转发** ⇒ 只有**一份实现**,两个地址指向同一绑定
 *     ⇒ 内容永远同步,**结构上不可能漂移**
 *   · 「两份实现」= 两处各写一遍 ⇒ 可以各自被改 ⇒ 才会漂移(这才是 CR-20)
 * ⇒ 重导出**不是** CR-20,是它的反面。但它必须靠断言守住,
 *   否则有人补一个 `export const X = ...` 覆盖同名,就悄悄变成了两份实现。
 *
 * 守住它的断言在 `tests/WS-07.test.ts`:
 *   逐符号 `ok(schema[k] === shared[k], ...)` —— **引用相等**证明只有一份实现。
 *
 * 单位:坐标 = 格(协议上按 1/1024 格定点量化);时间 = 秒;血量 = 整数 HP。
 */

/* ── 唯一允许的转发形式:编译期转发,不重新定义 ── */
export * from '../../../shared/types/wire.ts';

/* ── 本地使用需要显式 import(`export *` 不把名字带进本文件作用域)── */
import {
  tableFor,
  chunkKey,
  ENTITY_KIND_LABEL,
  TelegraphShape,
  type EntityKind,
  type FieldSpec,
  type PlayerState,
  type WildlifeState,
  type BossState,
  type RoomState,
} from '../../../shared/types/wire.ts';

/* ═══════════════════════════ 1. 掩码与自检常量 ═══════════════════════════ */

/** 一张表能表达的最大字段数(掩码用 u32)。 */
export const MAX_FIELDS_PER_TABLE = 32;

/* ═══════════════════════════ 2. 构造与默认值 ═══════════════════════════ */

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

/* ═══════════════════════════ 3. 容器写操作(纯服务端) ═══════════════════════════ */

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

export function bumpChunkVersion(s: RoomState, cx: number, cy: number): number {
  const k = chunkKey(cx, cy);
  const v = (s.meta.chunkVersions[k] ?? 0) + 1;
  s.meta.chunkVersions[k] = v;
  return v;
}

/* ═══════════════════════════ 4. 字段表辅助 ═══════════════════════════ */

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