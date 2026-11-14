/**
 * WS-07 · Colyseus Room 薄装配层。
 *
 * **业务逻辑不在这里。** 它把 Colyseus 的生命周期回调原样转发给
 * `RoomRuntime`(`./room.ts`,零依赖),因此所有业务逻辑都能在无 colyseus
 * 环境下被单测覆盖。这里的代码量刻意压到最小:
 *
 *   onCreate  → new RoomRuntime(...)  + RoomSchema + **registerHandlers()**
 *   onJoin    → runtime.join()        → 回发全量/断线快照
 *   onLeave   → runtime.disconnect() / runtime.leave()
 *   setSimulationInterval(50ms) → runtime.step() → schema.syncFrom()
 *
 * ✅ 本文件自 2026-11-14(task-95)起**可被 Node 直接加载**
 *   (装饰器 → `defineTypes`、CJS 命名导入 → 默认导出/`import type`),
 *   并由 `tests/WS-FND-12-wiring-paths.test.ts` 的 FND12-8 实测 import + 断言
 *   4 条 handler 在 `onCreate` 里真的被注册。此前它**谁也没法 import**。
 *
 * 关键:**20Hz 差量由我们自己的 delta.ts 负责**,Colyseus 的自动 patch 只当
 * 兜底(通过 `schema.syncFrom` 写值,由 Colyseus 决定是否下发)。
 * 之所以要两套并存:我们的 delta.ts 支持零依赖单测与精确字节预算,
 * 而 Colyseus 的 patch 支持其 WebSocket 层的可靠有序通道。
 */

import colyseusPkg from 'colyseus';
import type { Client, Room as ColyseusRoom } from 'colyseus';
import { RoomSchema, BossSchema, PlayerSchema, WildlifeSchema, assertSchemaReady } from './schema.colyseus.ts';
import { RoomRuntime, RoomRegistry, type RoomRuntimeOptions, type WorldSaveHost } from './room.ts';
import { DT } from '../../../shared/types/physics.ts';
import { AccessMode } from '../db/repo.ts';
import type { DbLike } from '../db/repo.ts';

/**
 * `Room` 的**运行时值**只能从默认导出上取(`colyseus` 是 CommonJS,根入口没有命名导出):
 * ```
 * import { Room, Client } from 'colyseus'   ✗ SyntaxError: Named export 'Room' not found
 * import * as ns from 'colyseus'            ✗ 实测只有 4 个键,ns.Room === undefined
 * import pkg from 'colyseus'                ✓ 实测 47 个键,typeof pkg.Room === 'function'
 * ```
 * 而 `Client` **连默认导出上都没有运行时值**(实测 `pkg.Client === undefined`;
 * `@colyseus/core/build/index.d.ts` 只有 `export { type Client, ... }`)
 * ⇒ 它只能是 `import type`(运行时擦除),**不能**改写成解构。
 * ⇒ 两者写法不同不是风格问题,是「该符号有没有运行时值」的差别。
 */
const Room: typeof ColyseusRoom = colyseusPkg.Room;

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
  /**
   * 房主(玩家)id —— 喂给 `RoomRuntimeOptions.ownerId`,用于权限判定。
   *
   * ★ task-76 订正:本字段**此前叫 `registryOwnerId`**,已改名为 `ownerId`。
   *
   * ## 为什么改名:同一语义字段不能有两个名字
   *
   * 两条装配路径都在给**同一个契约字段** `RoomRuntimeOptions.ownerId` 赋值:
   * ```
   * A 路 index.ts:191        ownerId: deps.ownerId ?? 'u_owner'
   * B 路 room.colyseus.ts    ownerId: this.deps?.registryOwnerId ?? 'u_owner'
   *                                              ^^^^^^^^^^^^^^^ 名字不同
   * ```
   * 判据是「同一语义字段,两个来源,必有一处是错的 —— 除非它们本就是两件事」。
   * 实测它们**就是同一件事**,三条证据:
   * ```
   * 1 两者最终都落进 `new RoomRuntime(rtOpts, …)` 的同一个键 `ownerId`
   *   (room.ts:277 声明;room.ts:825 `this.ownerId = opts.ownerId`);
   * 2 该值用途唯一:room.ts:966 `input.userId === this.ownerId` ⇒ 判 OWNER 角色,
   *   以及 :1187/:1202 的两条「不能改房主 / 不能踢房主」—— 都是**玩家**身份;
   * 3 `bootstrap()`(room.ts:2151-2156)拿 ownerId 去 `createUser(db, {id: ownerId})`
   *   ⇒ 它就是一个**用户 id**,不是「注册表的运维者」。
   * ```
   * ## 为什么 `registryOwnerId` 是**误导**而非「另一种说法」
   * ```
   * `RoomRegistry` 自身**没有** ownerId 字段 —— 它的 options 只有
   *   clock / db / onEvict(room.ts:2076-2081),内部存 Map<string, RoomRuntime>;
   * ownerId 是 `registry.create({roomId, ownerId})` 的**入参**,
   *   随即原样转交 RoomRuntime ⇒ 它始终是**房间的** ownerId。
   * ```
   * ⇒ 名字里的 `registry` 暗示「注册表层特有的 owner」,而**并不存在**那样东西。
   *   全仓 `registryOwnerId` 只有 2 处(本文件的声明与使用),`withDeps` 调用点 0 处
   *   ⇒ 改名不触及任何调用方(零风险),且让两条路的字段名**逐字相等** ——
   *   这正是 FND9-9 对 `rtOpts` 键集要求的同一条纪律。
   */
  ownerId: string;
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
   * ## ⚠️ 目前**没有生产调用方构造它**(task-76 订正:此段此前说错了)
   *
   * 此段原文写「`server/src/index.ts` **不存在**」—— **那句早已过期**:
   * `index.ts` 已由 task-57 补出(`createHost` / `assemble` / `createServer`)。
   * 但**结论仍然成立**,而且理由变了 —— 这是本条最值得记住的地方:
   *
   * ```
   * task-57 之前:index.ts 不存在 ⇒ 没有任何东西能构造 host
   * task-57 之后:index.ts 存在,但它**不经过本文件** ——
   *              它自己 `new RoomRuntime(rtOpts, db)`(index.ts:181),
   *              与本文件是**两条平行的装配路径**
   * ```
   *
   * ⇒ 故本参数在生产里**依然**是 `undefined` ⇒ `host` 依然保持 null。
   *   本文件的 `deps` 只由 `withDeps(deps)` 注入,而全仓 `withDeps`
   *   的调用点 **0 处**(唯一疑似是 L272 的注释)。
   *
   * ⇒ ★ 教训:一句「因为 X 所以 Y」里,**X 会过期而 Y 未必过期**。
   *   只删过期的 X 而不复核 Y,会把一条仍然正确的警告连带删掉。
   *   正确做法是**换掉论据并保留结论**(如上)。
   *
   * ## 这**不算**「接线完成」:契约已正确 + 有装配位,**但没人构造 host**。
   * 补法是在部署层调 `room.withDeps({ ...deps, host })`,
   * 或让本文件改为复用 `index.ts` 的 `assemble()`(见 `docs/TASK47-*` 的 CR 待裁)。
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
     *
     * ★ task-76 实测订正:`this.patchRate = null` **关不掉**。
     *   此前这里写的是**直接赋属性**,并注释说它是「官方开关」—— 两句都不对。
     *
     * ## 实测(读 @colyseus/core 0.15.57 的 build/Room.js)
     *
     * ```
     * constructor L84       this.setPatchRate(this.patchRate)   ← patchRate 默认 50ms
     *                       ⇒ setPatchRate 内部 setInterval(broadcastPatch, 50)
     * setPatchRate  L177    this.patchRate = milliseconds;
     *               L179    if (this._patchInterval) { clearInterval(...); _patchInterval = undefined }
     *               L183    if (ms !== null && ms !== 0) { _patchInterval = setInterval(...) }
     * broadcastPatch L267   **完全不读 this.patchRate**
     * ```
     *
     * ⇒ 「关掉」这件事**只发生在 `setPatchRate` 内部的 clearInterval**。
     *   直接写 `this.patchRate = null` 只是改了个**没有被读的字段**,
     *   构造器建的那个 50ms 定时器**继续跑**,照旧周期性调 `broadcastPatch()`。
     *
     * ## 运行期证据(探针 `_t76_timer.ts`,子类覆写 `broadcastPatch` 计数)
     *
     * ```
     * A 组 直接赋 patchRate = null    : 260ms 内 broadcastPatch 被调 4 次  ★ 没关掉
     * B 组 setPatchRate(null)(官方)   : 260ms 内被调 0 次                  ✓ 真关掉
     * C 组 完全不碰(默认 50ms)       : 260ms 内被调 4 次  ← 与 A 组同值
     * ```
     *
     * ⇒ C 组与 A 组**同为 4 次**是这条证据的关键:它说明 A 组的定时器
     *   与「根本没关」的运行状态**无法区分**。若不实测,只看 `patchRate` 字段
     *   变没变(它确实变成了 null),会得出「已关闭」的相反结论。
     *
     * ⇒ 故这里改为调用官方关闭入口 `setPatchRate(null)`。 */
    if (!patchEnabled()) {
      this.setPatchRate(null);
    } else {
      this.setPatchRate(DT * 1000);
    }

    const roomId = options.roomId ?? this.roomId;
    const rtOpts: RoomRuntimeOptions = {
      roomId,
      ownerId: this.deps?.ownerId ?? 'u_owner',
      clock: this.deps?.clock ?? { nowMs: () => Date.now() },
      name: options.name,
      accessMode: options.accessMode ?? AccessMode.PUBLIC,
      passwordHash: options.passwordHash ?? null,
      maxPlayers: this.maxClients,
      worldSeed: options.worldSeed,
      /* US2 装配位:世界源经构造参传入。
         ⚠️ `this.deps?.host ?? null` —— `deps` 全仓**无人注入**
         (grep withDeps ⇒ 调用点 0),故生产里此处**恒为 null**。
         (task-76 订正:原注释把原因写成「index.ts 不存在」,该文件已存在;
          但结论成立,因为 index.ts 走的是**另一条**装配路径,不经本文件。)
         不谎报:null 时 `saveToDb`/`levelOf`/`attackMobAuthorized` 三处
         整段跳过(由 `tests/WS-07.test.ts` 的 K1 断言钉住)。 */
      host: this.deps?.host ?? null,
    };
    this.runtime = new RoomRuntime(rtOpts, this.deps?.db ?? null);

    /* ★ 报文入口的**唯一**注册点(task-95 补)。
     *
     * 位置的理由(两句话都是硬条件,不是风格):
     *  1 必须在 `this.runtime` 建好**之后** —— 4 条 handler 的第一句都是
     *    `this.runtime.<fn>(...)`,注册时虽不读它,但**收到报文时**必读;
     *  2 必须在**第一次可能收到报文之前** —— Colyseus 只在该房 `onCreate`
     *    返回之后才会把客户端交给它(先是 `onJoin`,再是任意 `onMessage`)。
     *    放在这里 ⇒ 早于 `onJoin`、早于任何报文;若挪到 `onJoin` 里,
     *    重连/并发入场时先到的那条报文会被**静默丢弃**(onMessage 无 handler
     *    时 Colyseus 不报错)。
     *
     * ⚠️ 为什么值得专门写这段:实测本方法此前**全仓 0 调用点**(仅 :316 的声明)
     *    ⇒ 4 条 handler 从未注册 ⇒ 玩家按得动、客户端也发得出去,
     *    但服务端**永远收不到** move / attack / inventory / action。
     *    而「不可加载」掩盖了这件事 —— 文件加载不了,讨论 handler 注册无从谈起。 */
    this.registerHandlers();

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
     *
     * 是否把它的变更下发到网络,由 patch **定时器**决定(见 onCreate):
     * 单通道模式下已调 `setPatchRate(null)` 把定时器清掉,于是 Schema 只作为
     * 服务端自省与调试出口,不产生任何下行流量。
     * ⚠️ task-76 订正:此处原写「由 `patchRate` 决定」并据此认为赋值即可 ——
     *   实测 `broadcastPatch()` **不读** `patchRate`(见 onCreate 的长注释),
     *   真正决定「有没有定时器」的是 `_patchInterval`。
     *   ⇒ 措辞按**机制**写,不按字段名写。 */
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
    /* ── action:授权 → 执行 → **回执**(2026-11-14 接线)──
     *
     * ## 此前形态(实测)
     * ```
     * authorize(...) ⇒ !allowed ⇒ send('reject')
     * ⇒ allowed === true 时**零执行、零回执、零日志**(成功分支为空)
     * ```
     * ⇒ 22 个 `RoomAction` 长期「授权存在、执行不存在」;玩家按了没反应,
     *   而且**没有任何一处**能看出原因 —— 连 `else` 都没有。
     *
     * ## 现在
     * 执行落到 `RoomRuntime.dispatchAction()`(它负责把宿主方法的返回值
     * 翻译成 `ActionOutcome`,并对未实现的动作用 `NOT_IMPLEMENTED` **显式**拒绝)。
     * 本 handler 只做一件事:**把结果变成回执**。
     *
     * ★ 成功**也**发回执(`actionResult { ok: true, effect }`)。
     *   这不是冗余流量,而是消灭「静默成功」的唯一办法:
     *   没有回执时,「执行了」与「什么都没发生」在客户端**不可区分**。
     * ★ 失败带 `kind` —— 否则「无权」与「这个动作还没实现」在客户端又混成一件事,
     *   而那正是本次修复要消灭的那类混淆。 */
    this.onMessage('action', (client, msg: {
      action: Parameters<RoomRuntime['authorize']>[1];
      payload?: Parameters<RoomRuntime['dispatchAction']>[2];
    }) => {
      const out = this.runtime.dispatchAction(client.sessionId, msg.action, msg.payload ?? {});
      if (out.ok) {
        client.send('actionResult', { ok: true, action: msg.action, effect: out.effect ?? null });
        return;
      }
      client.send('reject', { kind: out.kind, action: msg.action, reason: out.reason ?? null });
    });
  }

  private schema(): RoomSchema {
    return this.state as RoomSchema;
  }
}

/**
 * 注册到 Colyseus 的服务端入口辅助(**全仓无调用方**)。
 *
 * ⚠️ task-76 订正:原文写「由 `server/src/index.ts` 调用 —— 该文件**当前不存在**」。
 * 两句**都已过期**:`index.ts` 已由 task-57 补出;而它**并不调用本函数**
 * (它直接 `new RoomRuntime(...)`,即 A 路)。⇒ 本函数仍无调用方,
 * 但原因从「没人写调用者」变成了「**有两条路,而选中的是另一条**」。
 *
 * ⚠️ `deps` 在这里**无法转交给房间**:`server.define` 只登记构造器,
 * 实例化时由 Colyseus 调 `onCreate`,没有任何地方能把 `deps` 递给它。
 * 原实现因此写了 `void deps`(**丢弃**)。保留这个参数是给将来
 * 一个统一注入点,但**它现在确实什么都没做** ——
 * 不写 `void deps` 会让读者以为它被用上了。
 * 真正的注入路径是 `room.withDeps(deps)`(见那里的注释)。
 *
 * ⚠️ 而 `withDeps` 本身也**无调用方** ⇒ 两条路合起来说明:
 *    **host 在 B 路恒为 null 的根因是「整条 B 路无人装配」**,
 *    不是「少了一行转发」。详见 `docs/TASK47-*` 与 `NetPersistRoomOptions.host`。
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
