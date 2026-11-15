/**
 * 管理类动作:`SET_MEMBER_ROLE` / `KICK_MEMBER` / `SET_ROOM_ACCESS` /
 * `SET_PARTY_MODE` / `CLOSE_ROOM`。
 *
 * ## 只搬不改
 *
 * 五个处理器体逐字搬自 `RoomRuntime.dispatchAction` 的 `switch`(仅 `this.` → `ctx.`)。
 * 回执的 `kind` / `reason` 文本 / `effect` 字段名**一个字都没动** ——
 * `tests/WS-07`(ACT-1 / ACT-3)与 `tests/WS-FND-18`(FND18-4)、`tests/WS-FND-21`
 * (FND21-2)钉的正是那些字面内容。
 *
 * ## 为什么这里**不**判权限(这是刻意的分工,别"顺手补上")
 *
 * 下面四个宿主方法(`setMemberRole` / `kick` / `setAccess` / `setPartyModeBy`)
 * **各自第一行就是 `authorize(...)`**。处理器若再判一次,就长出**第二份权限实现**
 * —— 本仓 1 号病根(陷阱 31 / 41)。⇒ 只管调用宿主方法,再把它的返回值翻译成回执。
 *
 * ⚠️ 唯一例外是 `CLOSE_ROOM`:`close()` 是**生命周期方法**,还被 `onDispose` /
 *   `reapEvictions` 调用 ⇒ 它**不能**自带权限闸,闸必须写在这里。这个不对称是刻意的。
 *
 * ⚠️ 三个「失败」处理器走 `ctx.classifyFailure(...)`,不是自己看 `reason` 文本里
 *   有没有「无权」:那是本仓点名的「判据退化成读文本」形态(见 `classifyFailure` 的注释)。
 *
 * ⚠️ 这里用 `ctx.action` 而不是 `RoomAction.CLOSE_ROOM`:注册表按动作名分派,
 *   二者**同一个值**;好处是本文件**不需要**运行期 import `room.ts` ——
 *   否则 `room.ts → actions/*` 与 `actions/* → room.ts` 立刻成环(只剩类型 import,不成环)。
 */
import type { ActionContext, ActionHandler } from './types.ts';

/** `SET_MEMBER_ROLE`:改成员角色。宿主方法自带闸。 */
export const setMemberRole: ActionHandler = (ctx: ActionContext) => {
  const targetId = ctx.payload.targetId;
  const role = ctx.payload.role;
  if (typeof targetId !== 'string' || role === undefined) {
    return { ok: false, kind: 'INVALID', reason: '需要 targetId 与 role' };
  }
  const r = ctx.setMemberRole(ctx.actorId, targetId, role);
  return r.ok
    ? { ok: true, kind: 'OK', effect: { targetId, role: String(role) } }
    : ctx.classifyFailure(ctx.actorId, ctx.action, r.reason);
};

/** `KICK_MEMBER`:踢人。宿主方法自带闸。 */
export const kick: ActionHandler = (ctx: ActionContext) => {
  const targetId = ctx.payload.targetId;
  if (typeof targetId !== 'string') {
    return { ok: false, kind: 'INVALID', reason: '需要 targetId' };
  }
  const r = ctx.kick(ctx.actorId, targetId);
  return r.ok
    ? { ok: true, kind: 'OK', effect: { targetId } }
    : ctx.classifyFailure(ctx.actorId, ctx.action, r.reason);
};

/** `SET_ROOM_ACCESS`:改访问模式。宿主方法自带闸。 */
export const setRoomAccess: ActionHandler = (ctx: ActionContext) => {
  const mode = ctx.payload.mode;
  if (mode === undefined) return { ok: false, kind: 'INVALID', reason: '需要 mode' };
  const r = ctx.setAccess(ctx.actorId, mode, ctx.payload.passwordHash ?? null);
  return r.ok
    ? { ok: true, kind: 'OK', effect: { mode: String(mode) } }
    : ctx.classifyFailure(ctx.actorId, ctx.action, r.reason);
};

/** `SET_PARTY_MODE`:改派对模式。宿主方法自带闸。 */
export const setPartyMode: ActionHandler = (ctx: ActionContext) => {
  const mode = ctx.payload.partyMode;
  if (mode === undefined) return { ok: false, kind: 'INVALID', reason: '需要 partyMode' };
  const r = ctx.setPartyModeBy(ctx.actorId, mode);
  return r.ok
    ? { ok: true, kind: 'OK', effect: { partyMode: String(mode) } }
    : ctx.classifyFailure(ctx.actorId, ctx.action, r.reason);
};

/**
 * `CLOSE_ROOM`:关房。
 *
 * ★ 唯一的例外:`close()` 不自带闸(见本文开头)⇒ 闸在这里。
 * ⚠️ `ctx.status` 必须在 `close()` **之后**读 —— 它是 getter,不是快照
 *   (`effect: { status: 'CLOSED' }`)。
 */
export const closeRoom: ActionHandler = (ctx: ActionContext) => {
  const gate = ctx.authorize(ctx.actorId, ctx.action);
  if (!gate.allowed) return { ok: false, kind: 'PERMISSION', reason: gate.reason };
  const done = ctx.close();
  if (!done) return { ok: false, kind: 'ROOM_CLOSED', reason: '房间已不是 OPEN' };
  return { ok: true, kind: 'OK', effect: { status: String(ctx.status) } };
};