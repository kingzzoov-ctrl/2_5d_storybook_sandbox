/**
 * `net/actions/` 的公共形状:**动作处理器**与它拿到的 **`ActionContext`**。
 *
 * ## 为什么要 `ActionContext` 而不是把 `RoomRuntime` 交给处理器
 *
 * 处理器需要的东西只有两类:宿主的**行为**(`setMemberRole` / `kick` / `applyInventory` /
 * `grantItemSource` / `authorize` …)与**这一次分派**的入参(`actorId` / `action` / `payload`)。
 * 把它们显式列进本接口,而不是传整个运行时:
 *
 *   1 处理器**碰不到**运行时的私有态 —— `classifyFailure` / `materialsOf` /
 *     `hostPositionOf` 仍是 `room.ts` 的 `private`,只以**绑定后的函数**形式出现在这里;
 *   2 「一个动作模块能用到什么」看本接口即可,不必通读 `room.ts`。
 *
 * ⚠️ 这些成员**只是转交**,不是第二份实现:每个的函数体都是 `room.ts` 里的那**一个**。
 *   在这里多写一份判定(尤其是权限判定)就是本仓反复点名的「两份实现」。
 *
 * ⚠️ `status` 必须是**活读**(`get`),不能是快照值:`CLOSE_ROOM` 的回执要在 `close()`
 *   **之后**读它(`effect: { status: 'CLOSED' }`);若在装配时取一次值,回执会谎报 `OPEN`。
 */
import type { AccessMode, PartyMode, RoomRole, RoomStatus } from '../../db/repo.ts';
import type { InventoryCheckResult, InventoryOp } from '../anticheat.ts';
import type { RoomState } from '../schema.ts';
import type { ActionOutcome, ActionPayload, RoomAction, WorldSaveHost } from '../room.ts';

/** 一次动作分派交给处理器的全部上下文。 */
export interface ActionContext {
  /** 发起本次动作的玩家。 */
  readonly actorId: string;
  /** 本次分派的动作名(= 注册表里的键)。失败分类要原样带它。 */
  readonly action: RoomAction;
  /** 报文参数。缺项由各处理器**显式**拒绝(不猜默认值)。 */
  readonly payload: ActionPayload;
  /** 房间快照。现行处理器只读;后续动作(如 `MODIFY_TOWN`)要用它。 */
  readonly state: RoomState;
  /** 世界存档源;`null` = 本房间没有模拟层。 */
  readonly host: WorldSaveHost | null;
  /** 房间状态。**活读**(见文件头),`CLOSE_ROOM` 依赖这一点。 */
  readonly status: RoomStatus;

  /** 权限裁决 —— 就是 `RoomRuntime.authorize`(越权返回 false 且**不产生副作用**)。 */
  authorize(
    userId: string,
    action: RoomAction,
  ): { allowed: boolean; reason?: string; role?: RoomRole };

  /** 失败分类 —— 就是 `RoomRuntime.classifyFailure`(只在失败路径上问一次 `authorize`)。 */
  classifyFailure(
    actorId: string,
    action: RoomAction,
    reason: string | undefined,
  ): ActionOutcome;

  /** 世界的物质层;没有世界源时 `null`(见 `RoomRuntime.materialsOf`)。 */
  materialsOf(): ReturnType<WorldSaveHost['materials']> | null;

  /**
   * 玩家的**权威位置**;拿不到 `null`(见 `RoomRuntime.hostPositionOf`)。
   *
   * ★ 2026-11-18(第五轮 P3):`z` 必须声明。修前这里是 `{ x, y }`,而实现
   * (`host.playerPosition()` → `DynamicBody`)返回的是 `{ x, y, z }` ——
   * 结构类型会**静默丢掉** `z`:
   * ```
   * const at = ctx.hostPositionOf(id);  // 类型上 at.z 不存在
   * ⇒ 想用高度的动作(流体浮沉 / 跳跃 / 叠层判定)只能再 `as` 一次,
   *   而漏掉它的表现是「平面距离永远正确、高度永远 0」——不报错。
   * ```
   * 现在 `z` 是可选(`?`):老宿主的 `playerPosition` 不返回 z 时它确实是
   * `undefined` —— 与「z = 0」是两件事,消费方必须自己区分。
   */
  hostPositionOf(userId: string): { x: number; y: number; z?: number } | null;

  /** 背包增减的**唯一**入口(总量守恒与凭证链都在那条路上)。 */
  applyInventory(
    userId: string,
    input: { ops: readonly InventoryOp[] },
  ): InventoryCheckResult;

  /**
   * 授予一个合法产出凭证(**登记**这一步,不产生令牌)。
   *
   * ⚠️ 动作层**不要**直接传裸字符串:用 `actions/item_source.ts` 的
   *   `bindItemSource(ctx, itemId, purpose)` —— 它铸的令牌绑定
   *   `(actorId, itemId, 用途, tick)` 且一次性;裸字符串只留给测试夹具。
   */
  grantItemSource(userId: string, source: string): void;

  /**
   * **撤销**一张已登记的产出凭证(正向 `applyInventory` 被拒时调用)。
   *
   * ⚠️ 动作层**不要**直接调它:用 `actions/item_source.ts` 的
   *   `unbindItemSource(ctx, token)` —— 它绑的就是 `bindItemSource` 铸出来的那张,
   *   调用点因此不会退化成「撤错串」。
   *
   * 可选:手搓 `ctx` 的测试桩没有它 ⇒ `unbindItemSource` 回 `false` 表示
   * 「这条链没接撤销口」,而不是静默当作撤销成功。
   */
  revokeItemSource?(userId: string, source: string): void;
  /** 角色变更;宿主方法**自带**权限闸。 */
  setMemberRole(actorId: string, targetId: string, role: RoomRole): { ok: boolean; reason?: string };
  /** 踢人;宿主方法**自带**权限闸。 */
  kick(actorId: string, targetId: string): { ok: boolean; reason?: string };
  /** 改访问模式;宿主方法**自带**权限闸。 */
  setAccess(
    actorId: string,
    mode: AccessMode,
    passwordHash: string | null,
  ): { ok: boolean; reason?: string };
  /** 改派对模式;宿主方法**自带**权限闸。 */
  setPartyModeBy(actorId: string, mode: PartyMode): { ok: boolean; reason?: string };
  /** 关房。**不自带**闸(生命周期方法)⇒ 闸由 `CLOSE_ROOM` 处理器自己判。 */
  close(): boolean;
}

/**
 * 一个动作的执行层。
 *
 * ⚠️ 契约与 `RoomRuntime.dispatchAction` 完全一致,只是被拆成「一个动作一支函数」:
 *   成功 ⇒ `kind: 'OK'` **且带 `effect`**(`tests/WS-FND-18` FND18-3 盯着);
 *   失败 ⇒ `kind` **如其实**(`PERMISSION` / `INVALID` / `NOT_IMPLEMENTED` / `ROOM_CLOSED`);
 *   未实现 ⇒ `NOT_IMPLEMENTED` + 理由(见 `not-implemented.ts`)。
 */
export type ActionHandler = (ctx: ActionContext) => ActionOutcome;