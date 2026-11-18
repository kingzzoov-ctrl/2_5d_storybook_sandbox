/**
 * `RESET_WORLD` —— **世界重置**。
 *
 * ## 落点为什么这么写(裁决与证据:`docs/TASK-97-world-reset-ruling.md`)
 *
 * 世界**不属于** `RoomRuntime`:它由装配层造好、以 `WorldSaveHost` 交进来
 * (`room.ts:310` 声明契约,`index.ts:241` 造、`:264` 赋值)。所以重置只能是
 * **宿主能力**,不是编排层自己 `new` 一个世界 —— 那会让「谁持有世界」出现两个答案,
 * 正是本仓反复防的那类两份实现。
 *
 * ⇒ 本文件是这条路的**动作层那一半**:权限 / 报文 / **能力缺失** / 回执。
 *    宿主那一半(`WorldSim.resetWorld`)已于 **D-06** 落地(见 `world_sim.ts` 的
 *    `resetWorld`,做法 = 同一实例 + 换新子系统,in-place rebuild);能力**仍然可选**,
 *    缺能力时走「能力缺失 ⇒ **显式** `NOT_IMPLEMENTED`」分支 —— 那是**如实**回执,不是占位。
 *
 * ## 报文契约 `{ seed: number, confirm: true }`
 *
 * - `seed` **必填**(有限整数):不拿房间的 `worldSeed` 兜底、不猜默认值 ——
 *   本仓纪律是缺项**显式**拒绝(见 `types.ts:31` 的"不猜默认值");
 * - `confirm: true` **必填**:破坏性动作不许因为「少写一个字段」就执行;
 * - 其余键本动作**不读**(报文里可能混着别的动作的字段),但 `confirm` 不是 `true` 一律拒。
 *
 * ## 判决顺序(每一步失败都**零副作用**)
 *
 * 1 `authorize`(`RESET_WORLD` 的权限位是 `destructive`,仅 OWNER)⇒ `PERMISSION`;
 * 2 `confirm === true` 且 `seed` 是有限整数 ⇒ 否则 `INVALID`;
 * 3 `host === null`(本房间没有模拟层)⇒ `NOT_IMPLEMENTED`(与 `material.ts` 同契约);
 * 4 `host.resetWorld` **不存在**(宿主没实现)⇒ `NOT_IMPLEMENTED` + 可读理由;
 * 5 调它:`applied: true` ⇒ `OK` + `effect`;`applied: false` ⇒ `NOT_IMPLEMENTED` + 宿主给的理由
 *   (「能力在、这次没成」不是客户端的错,也不是成功)。
 *
 * ## 归档回执(D-06)
 *
 * owner 已裁(`docs/DECISIONS.md` **D-06**):重置的存档政策 = **归档**
 * (世界按新 seed 在内存重建,旧世界存成一份可回滚快照行)。
 * 归档**写入**发生在宿主/DB 侧(`db/repo.ts:archiveWorldSnapshot`),
 * 本动作只做一件事:**把"归档发生了没有"如实写进 `effect`**。
 *
 * `effect.archive` 是**三态字符串**(刻意不是布尔):
 *   * `'ARCHIVED'`   —— 宿主报告旧世界已归档,并给出 `archiveId` / `archiveBytes`;
 *   * `'NOT_ARCHIVED'` —— 宿主**明确**说这次没归档;
 *   * `'UNREPORTED'` —— 宿主没报告这个字段(老宿主)。
 * 三者不能合并:把"没报告"写成"没归档"就是**把不确定说成确定**,
 * 客户端会据此认为"旧世界已经没了"。
 *
 * ## 裁剪回执(D-19 第 5 条)
 *
 * 旧世界快照超过 1 MiB 时,归档侧不再失败,而是按 chunk 规则裁剪
 * (`world/archive.ts:planChunkTrim`:玩家建造 > 活动 > 原始地形)。裁过之后
 * `archiveBytes` 仍是**真正落库的字节数**(不是裁剪前的),所以「归档了多大一份」
 * 这一项不会说谎;但只报字节数会让客户端以为旧世界完整 —— 于是再报三项:
 *
 *   * `effect.archiveTrim` = `'TRIMMED'` / `'INTACT'` / `'UNREPORTED'`(**三态**,
 *     同 `archive` 的理由:宿主没报告 ≠ 没裁);
 *   * `effect.archiveDroppedChunks` / `effect.archiveDroppedBytes` —— **被裁掉多少**;
 *   * `effect.archiveTrimReason` —— **为什么裁**(人类可读,含「被裁块不可回滚」)。
 *
 * ⚠️ 只有 `archive === 'ARCHIVED'` 时才谈裁剪:没归档就没有「裁过」可言,
 *    此时**不写**这三项(写了会让"没归档"看起来像"归档但裁了")。
 * ⚠️ 这三项来自**宿主上报**(`WorldResetHostResult.archiveTrim`);今天
 *    `world_sim.ts` / `index.ts` 还没有把它接出来 ⇒ 生产里通常是
 *    `'UNREPORTED'`。这是**边界**,不是"已经接通"。
 *
 * ## ⚠️ 本动作**不做**的事(边界,别当成已实现)
 *
 * - **不做客户端重新握手**:换世界之后客户端手里的 chunk / 实体全是旧的,而今天
 *   没有任何「请重新握手 / 重拉快照」的下发路径 ⇒ **即使宿主真的重置了,客户端也留着旧世界**;
 * - **不做归档本身**:归档写入在宿主/DB 侧(D-06 已裁"归档",落地见 `db/repo.ts` §13);
 *   本文件不 import 任何 DB 模块 —— 动作层不认识存档格式;
 * - **不做"回滚到上一版"**:读口(`listWorldArchives` / `loadWorldArchive`)已就绪,
 *   但回滚**写入**没有裁决(回滚要不要先归档当前世界?算不算一次新的 `RESET_WORLD`?);
 * - **不改房间的 `worldSeed`**:它是房间参数(由 `RoomRuntimeOptions` 给);改它等于写
 *   第二份"世界身份",与「谁是权威」冲突。
 */
import type { ActionOutcome, ActionPayload } from '../room.ts';
import { notImplemented } from './not-implemented.ts';
/* ★ 三本模块级侧账 + 炼金订单预占的回收口(见 `forgetRoomSideLedgers`)。 */
import { forgetChests } from './open_chest.ts';
import { forgetPlacements } from './place_automation.ts';
import { forgetRoom } from './breed_tame.ts';
import { forgetFurnaceClaims } from './use_alchemy_furnace.ts';
import type { ActionContext, ActionHandler } from './types.ts';

/** 本动作的报文(`seed` / `confirm` 尚未写进 `ActionPayload` ⇒ 局部窄化)。 */
type ResetWorldPayload = ActionPayload & { seed?: unknown; confirm?: unknown };

/** 取有限整数;不是 ⇒ `null`(**不**做字符串转换,不猜默认值)。 */
function intField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}

/** 能力缺失:宿主没有 `resetWorld`(今天生产就是这一种)。 */
function capabilityMissing(ctx: ActionContext): ActionOutcome {
  return {
    ok: false,
    kind: 'NOT_IMPLEMENTED',
    reason:
      `${ctx.action} 的宿主不支持世界重置(WorldSaveHost.resetWorld 无实现者`
      + ' —— 见 docs/TASK-97-world-reset-ruling.md)',
  };
}

/**
 * 宿主 `resetWorld` 的回执形状 —— **动作层只读这一份**。
 *
 * 前三个字段是 TASK-97 R1 的原始契约;`archive` / `archiveError` 是 D-06(归档)加的那一条。
 * 宿主侧的对应契约(建议写进 `room.ts` 的 `WorldSaveHost`)与此**逐字同形**。
 */
type WorldResetHostResult = {
  applied: boolean;
  seed: number;
  reason?: string;
  /**
   * 旧世界归档回执(由 `db/repo.ts:archiveWorldSnapshot` 的返回值投影而来):
   * `{...}` = 已归档;`null` = 明确没归档;缺键 = **没报告**(三种状态,见文件头)。
   */
  archive?: { id: string; seed: number; archived_at: number; bytes: number } | null;
  /** 归档失败的原因(归档没成不该让回执看起来一切正常)。 */
  archiveError?: string;
  /**
   * **裁剪报告**(D-19 第 5 条,宿主可选上报):快照超 1 MiB 时归档侧按 chunk
   * 规则裁过,宿主可以把「裁了几块 / 多少字节 / 为什么」原样递上来。
   *
   * 字段刻意全是 `unknown`:动作层**只做校验**,不替宿主猜类型
   * (猜错就是「把不确定说成确定」)。缺键 ⇒ `effect.archiveTrim = 'UNREPORTED'`。
   */
  archiveTrim?: {
    droppedChunks?: unknown;
    droppedBytes?: unknown;
    reason?: unknown;
  } | null;
};

/** `effect.archive` 的三种取值。"没报告"与"没归档"必须分开,理由见文件头。 */
const ARCHIVED = 'ARCHIVED';
const NOT_ARCHIVED = 'NOT_ARCHIVED';
const UNREPORTED = 'UNREPORTED';

/** 裁剪的两种**已报告**取值(第三态复用 `UNREPORTED`)。 */
const TRIMMED = 'TRIMMED';
const INTACT = 'INTACT';

/** 取非负整数字段;不是 ⇒ `null`(半截报告当成**没报告**,不猜)。**/
function countField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : null;
}

/**
 * 宿主的回执 ⇒ `effect`。
 *
 * 只**加**归档那几项:`seed` / `applied` 的口径一个字不改
 * (`tests/WS-FND-34` FND34-1 盯的就是 `effect.seed` 是**实际生效**的种子)。
 */
function resetEffect(r: WorldResetHostResult): Record<string, string | number | boolean> {
  const effect: Record<string, string | number | boolean> = { seed: r.seed, applied: true };
  const archive = r.archive;
  if (archive !== null && typeof archive === 'object') {
    effect.archive = ARCHIVED;
    effect.archiveId = String(archive.id);
    effect.archiveSeed = Number(archive.seed);
    /* ★ 仍是**真正落库**的字节数(裁过就是裁后的) —— 这一项不许换成"原始大小"。 */
    effect.archiveBytes = Number(archive.bytes);
    effect.archivedAt = Number(archive.archived_at);
    /* 裁剪报告只在**归档成立**时才有意义(见文件头)。 */
    const trim = r.archiveTrim;
    if (trim !== null && typeof trim === 'object') {
      const droppedChunks = countField(trim.droppedChunks);
      const droppedBytes = countField(trim.droppedBytes);
      if (droppedChunks === null || droppedBytes === null) {
        /* 半截报告 = 没报告:缺一项就分不清"没裁"与"裁了但没说清"。 */
        effect.archiveTrim = UNREPORTED;
      } else {
        effect.archiveTrim = droppedChunks > 0 ? TRIMMED : INTACT;
        effect.archiveDroppedChunks = droppedChunks;
        effect.archiveDroppedBytes = droppedBytes;
        if (typeof trim.reason === 'string' && trim.reason.length > 0) {
          effect.archiveTrimReason = trim.reason;
        }
      }
    } else {
      effect.archiveTrim = UNREPORTED;
    }
  } else if (archive === null) {
    effect.archive = NOT_ARCHIVED;
  } else {
    effect.archive = UNREPORTED;
  }
  if (typeof r.archiveError === 'string' && r.archiveError.length > 0) {
    effect.archiveError = r.archiveError;
  }
  return effect;
}

/** 侧账名(回执里逐项列出;字符串常量避免把名字散在文案里)。 */
const LEDGER_CHESTS = 'chests';
const LEDGER_PLACEMENTS = 'placements';
const LEDGER_PETS = 'pets';
const LEDGER_FURNACE_ORDERS = 'furnaceOrders';

/**
 * ## ★ 旧世界的**侧账**回收(审计 P2:三个模块级 Map 修前全仓 0 个回收点)
 *
 * 这三本账住在动作层的模块级 Map 里(`chestsByRoom` / `PLACEMENTS` / `ROOM_PETS`),
 * 而 `RESET_WORLD` 修前**只**重建世界:箱子里那 12 件、那一格放置的自动化件、
 * 那一只宠物的归属全都还停在**已被换掉的旧世界**上。前两者尤其严重 ——
 * 「旧箱里的物品」在重置后取出来就是一份**不需要产出**的来源(箱子账本说它存在,
 * 而世界里它从未被生产过)。
 *
 * ⇒ 宿主回执说 `applied: true` 之后,按 **本房间** 把这几本账丢掉:
 *   · `forgetChests` / `forgetPlacements` / `forgetRoom` 都只 `delete(roomId)`
 *     —— 另一个房间的箱子/登记/宠物与这次重置无关(判据里那条隔离钉的就是它);
 *   · `forgetFurnaceClaims` 清的是**本房间实例**的订单预占(`ctx.state` 身份),
 *     世界侧 `roomSystemsState.settled` 已随重建换掉,留着它就等于让新世界继续
 *     拒掉旧世界用过的单号。
 *
 * ⚠️ 这是**回收**,不是「重置的回滚」:清掉的侧账**不可恢复**,与归档快照无关
 *   (归档只存世界本体,见 `db/repo.ts` §13)。
 *
 * @returns 真的清了哪几本(回执用;`roomId` 拿不到时只有订单预占那一本)
 */
function forgetRoomSideLedgers(ctx: ActionContext): string[] {
  const state = ctx.state as unknown as { roomId?: unknown } | null | undefined;
  const raw = state?.roomId;
  const roomId = typeof raw === 'string' ? raw.trim() : '';
  const cleared: string[] = [];
  if (roomId !== '') {
    forgetChests(roomId);
    forgetPlacements(roomId);
    forgetRoom(roomId);
    cleared.push(LEDGER_CHESTS, LEDGER_PLACEMENTS, LEDGER_PETS);
  }
  forgetFurnaceClaims(ctx.state);
  cleared.push(LEDGER_FURNACE_ORDERS);
  return cleared;
}

export const resetWorld: ActionHandler = (ctx) => {
  /* 1 权限闸:**第一行**,拒绝路径零副作用。 */
  const verdict = ctx.authorize(ctx.actorId, ctx.action);
  if (!verdict.allowed) {
    return ctx.classifyFailure(ctx.actorId, ctx.action, verdict.reason);
  }

  const p = ctx.payload as ResetWorldPayload;
  /* 2 显式确认 —— 破坏性动作不许"少写一个字段就执行"。 */
  if (p.confirm !== true) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 需要显式确认(confirm: true)—— 这是破坏性动作`,
    };
  }
  const seed = intField(p.seed);
  if (seed === null) {
    return {
      ok: false,
      kind: 'INVALID',
      reason: `${ctx.action} 需要 seed(有限整数)—— 不猜默认值`,
    };
  }

  /* 3 本房间没有模拟层。 */
  const host = ctx.host;
  if (host === null) {
    return notImplemented(ctx.action);
  }
  /* 4 宿主没有这个能力。 */
  const reset = host.resetWorld;
  if (typeof reset !== 'function') {
    return capabilityMissing(ctx);
  }
  /* 5 交给宿主,只如实转述它**实际生效**的语义(`this` 用 call 绑回宿主)。 */
  const r = reset.call(host, { seed }) as WorldResetHostResult;
  if (!r.applied) {
    return {
      ok: false,
      kind: 'NOT_IMPLEMENTED',
      reason: `${ctx.action} 未生效:${r.reason ?? '宿主未说明原因'}`,
    };
  }
  /* 6 ★ **旧世界的侧账一起丢掉**(审计 P2:三个模块级 Map 修前全仓 0 个回收点)。
     世界已经按新种子重建,而箱子里的东西 / 放置登记 / 宠物归属还停在旧世界 ——
     那会让「重置后从箱子里取出 12 件」变成一份**不需要产出**的来源。
     只清**本房间**(判据里那条「另一个房间的箱子仍在」钉的就是它)。 */
  const cleared = forgetRoomSideLedgers(ctx);
  const effect = resetEffect(r);
  /* 回执如实带上「清了哪几本侧账」:清没清是可判定事实,不该只活在服务端内存里。 */
  if (cleared.length > 0) effect.sideLedgersCleared = cleared.join(',');
  return { ok: true, kind: 'OK', effect };
};
