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
 *    宿主那一半(`WorldSim.resetWorld`)今天**不存在**,故生产里走的是
 *    「能力缺失 ⇒ **显式** `NOT_IMPLEMENTED`」分支 —— 那是**如实**回执,不是占位。
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
 * 4 `host.resetWorld` **不存在**(今天生产的形态)⇒ `NOT_IMPLEMENTED` + 可读理由;
 * 5 调它:`applied: true` ⇒ `OK` + `effect`;`applied: false` ⇒ `NOT_IMPLEMENTED` + 宿主给的理由
 *   (「能力在、这次没成」不是客户端的错,也不是成功)。
 *
 * ## ⚠️ 本动作**不做**的事(边界,别当成已实现)
 *
 * - **不做客户端重新握手**:换世界之后客户端手里的 chunk / 实体全是旧的,而今天
 *   没有任何「请重新握手 / 重拉快照」的下发路径 ⇒ **即使宿主真的重置了,客户端也留着旧世界**;
 * - **不动存档**:存档政策(丢弃 / 保留 / 归档)尚未裁决(`TASK-97` §4)⇒ 裁决前不许"顺手清";
 * - **不改房间的 `worldSeed`**:它是房间参数(由 `RoomRuntimeOptions` 给);改它等于写
 *   第二份"世界身份",与「谁是权威」冲突。
 */
import type { ActionOutcome, ActionPayload } from '../room.ts';
import { notImplemented } from './not-implemented.ts';
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
  const r = reset.call(host, { seed });
  if (!r.applied) {
    return {
      ok: false,
      kind: 'NOT_IMPLEMENTED',
      reason: `${ctx.action} 未生效:${r.reason ?? '宿主未说明原因'}`,
    };
  }
  return { ok: true, kind: 'OK', effect: { seed: r.seed, applied: true } };
};
