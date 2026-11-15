/**
 * **动作 → 处理器**的唯一一张表(`RoomAction` 22 个动作的**执行层归属**)。
 *
 * ## 为什么是 `Readonly<Record<RoomAction, ActionHandler>>` 而不是手搓 `switch`
 *
 * 这张表有**编译期完整性**:`RoomAction` 增一个成员而这里没登记 ⇒ tsc 报缺键;
 * 键名打错 ⇒ tsc 报多键。`switch` + `default:` 两样都给不了 ——
 * 漏一个 `case` 只会在运行期安静地掉进 `default`(正是 `tests/WS-FND-18` FND18-1
 * 要逐个归类的那种缺口,它只能**事后**发现)。⇒ 把「必须作决定」提前到编译期。
 *
 * ## 文件互斥(为什么 13 个未接动作各占一个模块)
 *
 * 9 个已接动作按**族**分在 `admin.ts`(5)/ `material.ts`(4);
 * 尚未接线的 13 个各占一个模块(`move.ts` / `craft.ts` / …),在这里只登记**引用**。
 * ⇒ 后续接线某个动作时,**只改它自己那个文件**(把 `notImplemented` 换成真实现),
 *   本文件与 `room.ts` 一个字都不用动 ⇒ 13 个动作可以真正并行接线,互不冲突。
 *
 * ## 没有循环 import
 *
 * `room.ts` → 本文件 → 各动作模块;**动作模块对 `room.ts` 只有 `import type`**
 * (类型在运行期被擦除)⇒ 运行时依赖图是 DAG,没有环。故本文件可以在**模块顶层**
 * 构建这张表,不需要惰性初始化。
 *
 * ⚠️ 这也是 `admin.ts` / `material.ts` 里用 `ctx.action` 而**不**写
 *   `RoomAction.CLOSE_ROOM` 的全部理由:运行期值 import 会把 DAG 变成环。
 */
import type { RoomAction } from '../room.ts';
import type { ActionHandler } from './types.ts';

import { closeRoom, kick, setMemberRole, setPartyMode, setRoomAccess } from './admin.ts';
import { breakBlock, dropItem, pickupItem, placeBlock } from './material.ts';
import { move } from './move.ts';
import { attack } from './attack.ts';
import { craft } from './craft.ts';
import { useAlchemyFurnace } from './use_alchemy_furnace.ts';
import { openChest } from './open_chest.ts';
import { useOwnChest } from './use_own_chest.ts';
import { sleep } from './sleep.ts';
import { startParty } from './start_party.ts';
import { resetWorld } from './reset_world.ts';
import { modifyTown } from './modify_town.ts';
import { placeAutomation } from './place_automation.ts';
import { wireEdit } from './wire_edit.ts';
import { breedTame } from './breed_tame.ts';

/**
 * 22 个动作的执行层。键序与 `RoomAction` 的声明序一致(便于逐行对表)。
 *
 * ★ 「已接线 / 未接线」的归属说明见 `docs/TASK-96-action-landing-gaps.md`;
 *   其中 `MOVE` / `ATTACK` 回 `NOT_IMPLEMENTED` 是**刻意**的(它们走专用报文通道)。
 */
export const ACTION_HANDLERS: Readonly<Record<RoomAction, ActionHandler>> = {
  MOVE: move,
  ATTACK: attack,
  PLACE_BLOCK: placeBlock,
  BREAK_BLOCK: breakBlock,
  PICKUP_ITEM: pickupItem,
  DROP_ITEM: dropItem,
  CRAFT: craft,
  USE_ALCHEMY_FURNACE: useAlchemyFurnace,
  OPEN_CHEST: openChest,
  USE_OWN_CHEST: useOwnChest,
  SLEEP: sleep,
  START_PARTY: startParty,
  SET_ROOM_ACCESS: setRoomAccess,
  SET_PARTY_MODE: setPartyMode,
  KICK_MEMBER: kick,
  SET_MEMBER_ROLE: setMemberRole,
  RESET_WORLD: resetWorld,
  CLOSE_ROOM: closeRoom,
  MODIFY_TOWN: modifyTown,
  PLACE_AUTOMATION: placeAutomation,
  WIRE_EDIT: wireEdit,
  BREED_TAME: breedTame,
};

/**
 * 查表。
 *
 * ⚠️ 返回类型**必须**含 `undefined`:运行期 `action` 来自报文,可能是**任意字符串**
 *   (`tests/WS-FND-21` FND21-3 就发 `NO_SUCH_ACTION_NAME`)。
 *   表类型是完整的 `Record<RoomAction, …>`(编译期完整性),但运行期按
 *   `Record<string, …>` 读 —— 不能按类型"撒谎说一定有"。
 */
export function lookupActionHandler(action: RoomAction): ActionHandler | undefined {
  return (ACTION_HANDLERS as Readonly<Record<string, ActionHandler | undefined>>)[action];
}