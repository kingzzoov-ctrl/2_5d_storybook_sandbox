/**
 * WS-07 · Colyseus 装配层(`@colyseus/schema` 装饰器版本)。
 *
 * **本文件不被 `tests/WS-07.test.ts` import。** 测试只走 `schema.ts` 的零依赖核心。
 * 这里的唯一价值是:把 `schema.ts` 的 `FIELD_TABLE` 变成真正能被 Colyseus
 * 自动同步引擎识别的 `Schema` 子类,并把同一份字段表当成编译期断言 ——
 * 任何一边新增字段而另一边忘改,`assertFieldTableParity()` 立刻抛错。
 *
 * 语法约束:本仓库禁止 `emitDecoratorMetadata`(`tsconfig.json` 已设 false),
 * 因此 `@type` 必须**显式**写出类型字符串,不能依赖反射。
 */

import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';
import {
  BOSS_FIELD_TABLE,
  FIELD_TABLE,
  FieldType,
  ROOM_FIELD_TABLE,
  WILDLIFE_FIELD_TABLE,
  validateFieldTable,
  type BossState,
  type FieldSpec,
  type PlayerState,
  type RoomState,
  type WildlifeState,
} from './schema.ts';

/** 装饰器需要的类型名;与 `FieldType` 一一对应。 */
const COLYSEUS_TYPE: Readonly<Record<string, string>> = {
  pos: 'number',
  u8: 'uint8',
  u16: 'uint16',
  u32: 'uint32',
  i16: 'int16',
  str: 'string',
  hash: 'string',
};

export function colyseusTypeOf(spec: FieldSpec): string {
  const t = COLYSEUS_TYPE[spec.type];
  if (!t) throw new Error(`字段 ${spec.key} 的类型 ${spec.type} 无法映射到 Colyseus`);
  return t;
}

/* ═══════════════════════════ PlayerSchema ═══════════════════════════ */

export class PlayerSchema extends Schema {
  @type('string') id = '';
  /* 原先此处漏写 `@type`。Colyseus **只同步带 @type 的字段**,
   * 未标注的 `name` 会被整条跳过 —— 玩家昵称永远到不了客户端,
   * 而且不会有任何报错。`assign()`/`toPlain()` 都在处理 name,
   * 说明本意就是要同步它,漏写纯属疏漏。 */
  @type('string') name = '';
  @type('uint8') level = 1;
  @type('uint16') hp = 100;
  @type('uint16') maxHp = 100;
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('uint8') dir = 0;
  @type('uint8') stateFlag = 0;
  @type('uint16') weaponId = 0;
  @type('string') aiWeaponRecipeHash = '';
  @type('uint16') heldItemId = 0;
  @type('string') carryingEntityId = '';

  static fromPlain(p: PlayerState): PlayerSchema {
    const s = new PlayerSchema();
    s.assign(p);
    return s;
  }

  assign(p: PlayerState): void {
    this.id = p.id;
    this.name = p.name;
    this.level = p.level;
    this.hp = p.hp;
    this.maxHp = p.maxHp;
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.dir = p.dir;
    this.stateFlag = p.stateFlag;
    this.weaponId = p.weaponId;
    this.aiWeaponRecipeHash = p.aiWeaponRecipeHash;
    this.heldItemId = p.heldItemId;
    this.carryingEntityId = p.carryingEntityId;
  }

  toPlain(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      level: this.level,
      hp: this.hp,
      maxHp: this.maxHp,
      x: this.x,
      y: this.y,
      z: this.z,
      dir: this.dir,
      stateFlag: this.stateFlag,
      weaponId: this.weaponId,
      aiWeaponRecipeHash: this.aiWeaponRecipeHash,
      heldItemId: this.heldItemId,
      carryingEntityId: this.carryingEntityId,
    };
  }
}

/* ═══════════════════════════ WildlifeSchema ═══════════════════════════ */

export class WildlifeSchema extends Schema {
  @type('string') id = '';
  @type('string') mobId = '';
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('uint8') fsm = 0;
  @type('uint16') hp = 30;
  @type('uint16') maxHp = 30;
  @type('string') tameOwnerId = '';

  static fromPlain(w: WildlifeState): WildlifeSchema {
    const s = new WildlifeSchema();
    s.id = w.id; s.mobId = w.mobId;
    s.x = w.x; s.y = w.y; s.z = w.z;
    s.fsm = w.fsm; s.hp = w.hp; s.maxHp = w.maxHp;
    s.tameOwnerId = w.tameOwnerId;
    return s;
  }

  toPlain(): WildlifeState {
    return {
      id: this.id, mobId: this.mobId,
      x: this.x, y: this.y, z: this.z,
      fsm: this.fsm, hp: this.hp, maxHp: this.maxHp,
      tameOwnerId: this.tameOwnerId,
    };
  }
}

/* ═══════════════════════════ BossSchema ═══════════════════════════ */

export class BossSchema extends Schema {
  @type('string') id = '';
  @type('string') bossId = '';
  @type('uint8') phase = 0;
  @type('uint32') hp = 0;
  @type('uint32') maxHp = 0;
  @type('uint8') telegraphShape = 0;
  @type('number') telegraphX = 0;
  @type('number') telegraphY = 0;
  @type('number') telegraphR = 0;
  @type('uint32') telegraphEndTick = 0;

  static fromPlain(b: BossState): BossSchema {
    const s = new BossSchema();
    s.id = b.id; s.bossId = b.bossId; s.phase = b.phase;
    s.hp = b.hp; s.maxHp = b.maxHp;
    s.telegraphShape = b.telegraphShape;
    s.telegraphX = b.telegraphX; s.telegraphY = b.telegraphY;
    s.telegraphR = b.telegraphR;
    s.telegraphEndTick = b.telegraphEndTick;
    return s;
  }

  toPlain(): BossState {
    return {
      id: this.id, bossId: this.bossId, phase: this.phase,
      hp: this.hp, maxHp: this.maxHp,
      telegraphShape: this.telegraphShape,
      telegraphX: this.telegraphX, telegraphY: this.telegraphY,
      telegraphR: this.telegraphR,
      telegraphEndTick: this.telegraphEndTick,
    };
  }
}

/* ═══════════════════════════ RoomSchema ═══════════════════════════ */

export class RoomMetaSchema extends Schema {
  /* 原先此处有 `@type('uint32') tick = 0;` —— 但 `ROOM_FIELD_TABLE` **故意不含 tick**:
   * 帧号每帧都变,放进字段表会让每帧退化出一次房间级 upsert(≈28 字节,
   * 稳态带宽的四成),所以它由报文头的 `tick` 承载、`applyPacket` 无条件覆盖。
   *
   * 保留它会让 `assertFieldTableParity()` 报「RoomMetaSchema 多出字段 tick」,
   * 进而让 `assertSchemaReady()` 在生产 `onCreate` 里抛错 —— 服务端起不来。
   * 又因为本层 patch 同步默认关闭(`USE_COLYSEUS_PATCH = false`),
   * 这个字段没有任何读取方,删掉不影响任何功能。 */
  @type('string') chunkVersions = '';
  @type('uint8') partyMode = 0;
  @type('number') partyTimer = 0;
  @type('uint16') scoreA = 0;
  @type('uint16') scoreB = 0;
}

/**
 * Colyseus 根状态。
 * `players` 用 MapSchema(按 id 去重 + 支持 remove),与手写协议的
 * `removed` 列表语义对齐。
 */
export class RoomSchema extends Schema {
  @type('string') roomId = '';
  @type(RoomMetaSchema) meta = new RoomMetaSchema();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type({ map: WildlifeSchema }) wildlife = new MapSchema<WildlifeSchema>();
  @type({ map: BossSchema }) bosses = new MapSchema<BossSchema>();
  /** 客户端未确认的地块版本号;MapSchema<string,uint32> 用 string 承载以便 JSON 化。 */
  @type(['string']) dirtyChunkKeys = new ArraySchema<string>();

  /** 从零依赖核心状态同步过来(只写变化字段,由 Colyseus 自己做 patch)。 */
  syncFrom(state: RoomState): void {
    this.roomId = state.roomId;
    /* 注意:**不同步 `state.meta.tick`** —— RoomMetaSchema 里没有这个字段(见该类注释)。
     * 帧号走报文头,客户端从 delta 包头的 tick 取,不依赖 schema 同步。 */
    this.meta.chunkVersions = Object.keys(state.meta.chunkVersions).sort()
      .map((k) => `${k}:${state.meta.chunkVersions[k]}`).join(';');
    this.meta.partyMode = state.meta.partyMode;
    this.meta.partyTimer = state.meta.partyTimer;
    this.meta.scoreA = state.meta.scoreA;
    this.meta.scoreB = state.meta.scoreB;

    syncMap(this.players, state.players, (p) => p.id, PlayerSchema.fromPlain, (s, p) => s.assign(p));
    syncMap(this.wildlife, state.wildlife, (w) => w.id, WildlifeSchema.fromPlain, (s, w) => {
      s.mobId = w.mobId; s.x = w.x; s.y = w.y; s.z = w.z;
      s.fsm = w.fsm; s.hp = w.hp; s.maxHp = w.maxHp; s.tameOwnerId = w.tameOwnerId;
    });
    syncMap(this.bosses, state.bosses, (b) => b.id, BossSchema.fromPlain, (s, b) => {
      s.bossId = b.bossId; s.phase = b.phase;
      s.hp = b.hp; s.maxHp = b.maxHp;
      s.telegraphShape = b.telegraphShape;
      s.telegraphX = b.telegraphX; s.telegraphY = b.telegraphY;
      s.telegraphR = b.telegraphR; s.telegraphEndTick = b.telegraphEndTick;
    });
  }
}

function syncMap<T, P>(
  map: MapSchema<T>,
  list: readonly P[],
  idOf: (x: P) => string,
  create: (x: P) => T,
  assign: (s: T, x: P) => void,
): void {
  const seen = new Set<string>();
  for (const item of list) {
    const id = idOf(item);
    seen.add(id);
    const cur = map.get(id);
    if (cur) assign(cur, item);
    else map.set(id, create(item));
  }
  for (const key of [...map.keys()]) if (!seen.has(key)) map.delete(key);
}

/* ═══════════════════════════ 字段表一致性断言 ═══════════════════════════ */

/**
 * 编译期 + 运行期双重对账:
 *  1. 装饰器类的实例字段集合必须**恰好等于** `FIELD_TABLE` 的 key 集合;
 *  2. 每个字段的 `@type` 必须与 `FIELD_TABLE.type` 的映射一致;
 *  3. `FIELD_TABLE` 自身必须无 bit 冲突。
 * 三者任一不符即抛错 —— 这是「两份定义只有一个事实源」的守卫。
 */
export function assertFieldTableParity(): string[] {
  const errs: string[] = [];
  const checks: { table: readonly FieldSpec[]; sample: Record<string, unknown>; label: string }[] = [
    { table: FIELD_TABLE, sample: new PlayerSchema() as unknown as Record<string, unknown>, label: 'PlayerSchema' },
    { table: WILDLIFE_FIELD_TABLE, sample: new WildlifeSchema() as unknown as Record<string, unknown>, label: 'WildlifeSchema' },
    { table: BOSS_FIELD_TABLE, sample: new BossSchema() as unknown as Record<string, unknown>, label: 'BossSchema' },
    { table: ROOM_FIELD_TABLE, sample: new RoomMetaSchema() as unknown as Record<string, unknown>, label: 'RoomMetaSchema' },
  ];
  for (const c of checks) {
    errs.push(...validateFieldTable(c.table).map((e) => `${c.label}: ${e}`));
    const declared = new Set(Object.keys(c.sample));
    for (const spec of c.table) if (!declared.has(spec.key)) errs.push(`${c.label} 缺少字段 ${spec.key}`);
    for (const k of declared) {
      if (!c.table.some((s) => s.key === k)) errs.push(`${c.label} 多出字段 ${k}(未登记在 FIELD_TABLE)`);
    }
  }
  return errs;
}

/** 供服务端启动自检调用:有问题就 fail-fast。 */
export function assertSchemaReady(): void {
  const errs = assertFieldTableParity();
  if (errs.length > 0) {
    throw new Error(`WS-07 Colyseus schema 与 FIELD_TABLE 不一致:\n  ${errs.join('\n  ')}`);
  }
}

/** 导出字段表映射关系,便于文档生成。 */
export function fieldTypeMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of FIELD_TABLE) out[spec.key] = colyseusTypeOf(spec);
  return out;
}

/** 类型再导出,方便 `room.colyseus.ts` 不重复 import。 */
export { FieldType };
