/**
 * WS-07 · Colyseus Room 薄装配层。
 *
 * **不被任何测试 import。** 它把 Colyseus 的生命周期回调原样转发给
 * `RoomRuntime`(`./room.ts`,零依赖),因此所有业务逻辑都能在无 colyseus
 * 环境下被单测覆盖。这里的代码量刻意压到最小:
 *
 *   onCreate  → new RoomRuntime(...)  + RoomSchema
 *   onJoin    → runtime.join()        → 回发全量/断线快照
 *   onLeave   → runtime.disconnect() / runtime.leave()
 *   setSimulationInterval(50ms) → runtime.step() → schema.syncFrom()
 *
 * 关键:**20Hz 差量由我们自己的 delta.ts 负责**,Colyseus 的自动 patch 只当
 * 兜底(通过 `schema.syncFrom` 写值,由 Colyseus 决定是否下发)。
 * 之所以要两套并存:我们的 delta.ts 支持零依赖单测与精确字节预算,
 * 而 Colyseus 的 patch 支持其 WebSocket 层的可靠有序通道。
 */

import { Room, Client } from 'colyseus';
import { RoomSchema, BossSchema, PlayerSchema, WildlifeSchema, assertSchemaReady } from './schema.colyseus.ts';
import { RoomRuntime, RoomRegistry, type RoomRuntimeOptions, type WorldSaveHost } from './room.ts';
import { DT } from '../../../shared/types/physics.ts';
import { AccessMode } from '../db/repo.ts';
import type { DbLike } from '../db/repo.ts';

/**
 * **单通道开关(默认关闭 Colyseus patch 同步)。**
 *
 * `true`  = 双通道:`schema.syncFrom()` 写入 Schema,由 Colyseus 自动 patch 下发,
 *           同时我方也 `broadcast('delta', …)`。
 * `false` = 单通道:Schema 仅作为 **Room 元数据容器**(存 roomId / tick / 成员容器),
 *           所有实体同步只走自研 `delta.ts`。
 *
 * 关闭理由:双通道 = **双倍带宽**(16 人 692B/帧 ≈ 13.52 kB/s 已占满合理区间),
 * 且两套 diff 语义在边界情况(实体瞬间增删、Chunk 版本跳变)会互相覆盖 —— 
 * Colyseus 的 patch 与我们的字段级 diff 对「同一帧该发什么」的判断并不等价。
 *
 * 保留装配代码而不物理删除:将来若要做 `reconnection` 快照校验、
 * 或把 Schema 当作服务端状态自省的可视化出口,可以再开。
 */
export const USE_COLYSEUS_PATCH = false;

/**
 * Colyseus 自动 patch 是否应启用。
 * 统一在这里判断,避免各处散落 `if (USE_COLYSEUS_PATCH)`。
 */
export function patchEnabled(): boolean {
  return USE_COLYSEUS_PATCH;
}

export interface NetPersistRoomOptions {
  clock: { nowMs: () => number };
  db: DbLike | null;
  registryOwnerId: string;
  /**
   * 世界源(US2 装配位)。**由调用方构造**并传进来。
   *
   * ## 为什么类型是 `WorldSaveHost` 而不是具体的模拟层
   *
   * `WorldSaveHost` 是 `room.ts` 里的**结构化接口**(只声明房间用到的方法),
   * 所以这里引用它**不引入任何新的依赖边** —— `room.colyseus.ts` 本就
   * `import './room.ts'`。若改成 import `WorldSim` 类型,就等于在装配层
   * 硬绑模拟层,并把 `scripts/backlog.ts` 的 US2 探针**误报为已开**。
   *
   * ## ⚠️ 目前**没有生产调用方构造它**
   *
   * `server/src/index.ts` **不存在**(`gameServerConfig` 的 docstring 说
   * 「由 server/src/index.ts 调用」,但该文件全仓不存在)。
   * ⇒ 本参数**通了,但生产里传的是 `undefined`** ⇒ `host` 保持 null。
   * ## 这**不算**「接线完成**」**:契约已正确 + 有装配位,**但没人构造 host**。
   * 补法是新建 `server/src/index.ts`(既有缺口,非本任务引入)。
   */
  host?: WorldSaveHost | null;
}

export type RoomCreateOptions = {
  roomId?: string;
  name?: string;
  accessMode?: AccessMode;
  passwordHash?: string | null;
  maxPlayers?: number;
  worldSeed?: number;
};

/** Colyseus 房。所有业务都委托给 `runtime`。 */
export class NetPersistRoom extends Room<RoomSchema> {
  private runtime!: RoomRuntime;
  private deps!: NetPersistRoomOptions;
  private lastBroadcastState: ReturnType<RoomRuntime['cloneState']> | null = null;

  override onCreate(options: RoomCreateOptions): void {
    assertSchemaReady();
    this.maxClients = Math.min(16, Math.max(1, options.maxPlayers ?? 16));
    this.setState(new RoomSchema());

    /* 单通道:关掉 Colyseus 的自动 patch 定时器。
     * `patchRate = null` 是 Colyseus 关闭状态自动同步的官方开关 ——
     * 之后 Schema 的变更仍会记录,但不会周期性下发。 */
    if (!patchEnabled()) {
      this.patchRate = null;
    } else {
      this.patchRate = DT * 1000;
    }

    const roomId = options.roomId ?? this.roomId;
    const rtOpts: RoomRuntimeOptions = {
      roomId,
      ownerId: this.deps?.registryOwnerId ?? 'u_owner',
      clock: this.deps?.clock ?? { nowMs: () => Date.now() },
      name: options.name,
      accessMode: options.accessMode ?? AccessMode.PUBLIC,
      passwordHash: options.passwordHash ?? null,
      maxPlayers: this.maxClients,
      worldSeed: options.worldSeed,
      /* US2 装配位:世界源经构造参传入。
         ⚠️ `this.deps?.host ?? null` —— 今天 `server/src/index.ts` 不存在,
         所以 `deps` 由谁注入仍是开的;此处**通了但传 null**。
         不谎报:null 时 `saveToDb`/`levelOf`/`attackMobAuthorized` 三处
         整段跳过(由 `tests/WS-07.ts` 的 K1 断言钉住)。 */
      host: this.deps?.host ?? null,
    };
    this.runtime = new RoomRuntime(rtOpts, this.deps?.db ?? null);

    /* 20Hz 权威帧。 */
    this.setSimulationInterval(() => this.stepTick(), DT * 1000);
  }

  /** 注入时钟 / 数据库(由 index.ts 在创建房间前调用)。 */
  withDeps(deps: NetPersistRoomOptions): this {
    this.deps = deps;
    return this;
  }

  override onJoin(client: Client, options: { passwordHash?: string; asGuest?: boolean }): void {
    const res = this.runtime.join({
      userId: client.sessionId,
      passwordHash: options.passwordHash ?? null,
      asGuest: options.asGuest ?? false,
    });
    if (!res.ok) {
      client.leave(4000, res.reason ?? 'join rejected');
      return;
    }
    /* 入场报文:全量快照(重连时是逐字节一致的恢复快照)。 */
    if (res.snapshot) client.send('snapshot', res.snapshot);
    this.schema().syncFrom(this.runtime.cloneState());
  }

  override onLeave(client: Client, consented?: boolean): void {
    /* 主动退房直接回收;异常断开保留 30 秒宽限。 */
    if (consented) this.runtime.leave(client.sessionId);
    else this.runtime.disconnect(client.sessionId);
  }

  override onDispose(): void {
    this.runtime.close();
  }

  /** 每帧:推进权威世界 + 发差量 + 落审计。 */
  private stepTick(): void {
    const packet = this.runtime.step(this.lastBroadcastState);
    this.lastBroadcastState = this.runtime.cloneState();

    /* 单通道:只发自研 delta。 */
    if (packet.length > 0) this.broadcast('delta', packet);

    /* Schema 始终与权威状态保持同步 —— 这一步**无条件执行**。
     * 是否把它的变更下发到网络,由 `patchRate` 决定(见 onCreate):
     * 单通道模式下 `patchRate = null`,于是 Schema 只作为服务端自省
     * 与调试出口,不产生任何下行流量。 */
    this.schema().syncFrom(this.lastBroadcastState);

    const violations = this.runtime.drainViolations();
    if (violations.length > 0) {
      for (const v of violations) {
        this.runtime.db?.insert('room_events', {
          id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
          room_id: this.runtime.id,
          tick: v.tick,
          kind: `AC_${v.kind}`,
          actor_id: v.playerId,
          payload_json: JSON.stringify({ detail: v.detail, weight: v.weight }),
          created_at: v.tick,
        });
      }
    }
  }

  /** 客户端输入:移动 / 攻击 / 物品。**只有这些入口**能改权威状态。 */
  private registerHandlers(): void {
    this.onMessage('move', (client, msg: { tick: number; x: number; y: number; z: number; speedMul?: number }) => {
      const verdict = this.runtime.applyMove(client.sessionId, msg);
      if (!verdict.allowed) client.send('correct', verdict.corrected ?? null);
    });
    /* ⚠️ 报文里**只接受「打谁」**(mobId)与客户端的攻速声明。
       `level` / `wearing` / `weaponId` / `comboMul` 一律由服务端从权威档案
       派生(`applyAttack` → `attackMobAuthorized` 的签名里根本没有它们);
       报文若仍带这四个字段会被**忽略**(不是报错:老客户端仍能连)。
       这与 `inventory` 通道同一形态(见 CR-14 U1)。 */
    this.onMessage('attack', (client, msg: { claimedBonus?: number; mobId?: string }) => {
      const verdict = this.runtime.applyAttack(
        client.sessionId,
        msg?.claimedBonus ?? 0,
        typeof msg?.mobId === 'string' ? msg.mobId : undefined,
      );
      if (!verdict.allowed) {
        client.send('reject', { kind: 'ATTACK' });
        return;
      }
      /* 成功回执:接线前这里**什么都不发**(空成功路径)。
         回执形态参照 `reject` / `correct` 的既有做法(单通道 + 小对象),
         带上真实结算值,让客户端能据此播伤害数字而**不必自己算一遍**。 */
      const rep = this.runtime.lastAttackReport;
      if (rep === null) {
        /* 反作弊放行但没有世界/没有目标 —— 不谎报命中。 */
        client.send('attackResult', { resolved: false });
        return;
      }
      client.send('attackResult', {
        resolved: rep.hit,
        mobId: rep.mobId,
        outcome: rep.outcome,
        hpLoss: rep.hpLoss,
        finalDamage: rep.finalDamage,
        outOfReach: rep.outOfReach,
        dodged: rep.dodged,
      });
    });
    /* ⚠️ 报文里**只接受 ops**。`allowedSources` / `capacity` / `beforeTotal`
       一律由服务端在 `RoomRuntime.applyInventory` 内派生 —— 它们曾是
       客户端字段,那等于让客户端决定自己的判据(见 CR-14 U1)。
       报文里若仍带这三个字段,会被**忽略**(不是报错:老客户端仍能连)。 */
    this.onMessage('inventory', (client, msg: {
      ops: { itemId: number; delta: number; source?: string }[];
    }) => {
      const r = this.runtime.applyInventory(client.sessionId, { ops: msg.ops });
      if (!r.allowed) client.send('reject', { kind: 'INVENTORY' });
    });
    this.onMessage('action', (client, msg: { action: Parameters<RoomRuntime['authorize']>[1] }) => {
      const gate = this.runtime.authorize(client.sessionId, msg.action);
      if (!gate.allowed) client.send('reject', { kind: 'PERMISSION', reason: gate.reason });
    });
  }

  private schema(): RoomSchema {
    return this.state as RoomSchema;
  }
}

/**
 * 注册到 Colyseus 的服务端入口辅助(由 `server/src/index.ts` 调用 ——
 * ⚠️ 该文件**当前不存在**,见 `NetPersistRoomOptions.host` 的说明)。
 *
 * ⚠️ `deps` 在这里**无法转交给房间**:`server.define` 只登记构造器,
 * 实例化时由 Colyseus 调 `onCreate`,没有任何地方能把 `deps` 递给它。
 * 原实现因此写了 `void deps`(**丢弃**)。保留这个参数是给将来
 * `index.ts` 一个统一注入点,但**它现在确实什么都没做** ——
 * 不写 `void deps` 会让读者以为它被用上了。
 * 真正的注入路径是 `room.withDeps(deps)`(见那里的注释)。
 */
export function gameServerConfig(deps: NetPersistRoomOptions): {
  initializeGameServer: (server: { define: (name: string, handler: unknown) => void }) => void;
  /** 原样回传,便于 `index.ts` 调 `withDeps` —— 目前无调用方。 */
  deps: NetPersistRoomOptions;
} {
  return {
    initializeGameServer: (server) => {
      server.define('net_persist_room', NetPersistRoom as unknown as new () => unknown);
    },
    deps,
  };
}

export { RoomRegistry, PlayerSchema, WildlifeSchema, BossSchema, RoomSchema };
