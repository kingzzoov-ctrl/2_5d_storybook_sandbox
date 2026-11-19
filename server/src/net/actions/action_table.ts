/**
 * **动作 → 处理器**的唯一一张表(`RoomAction` **24** 个动作的**执行层归属**)。
 *
 * ## 为什么是 `Readonly<Record<RoomAction, ActionHandler>>` 而不是手搓 `switch`
 *
 * 这张表有**编译期完整性**:`RoomAction` 增一个成员而这里没登记 ⇒ tsc 报缺键;
 * 键名打错 ⇒ tsc 报多键。`switch` + `default:` 两样都给不了 ——
 * 漏一个 `case` 只会在运行期安静地掉进 `default`(正是 `tests/WS-FND-18` FND18-1
 * 要逐个归类的那种缺口,它只能**事后**发现)。⇒ 把「必须作决定」提前到编译期。
 *
 * ## 文件互斥(为什么每个动作各占一个模块)
 *
 * 24 个动作**全部已登记**;其中 22 个各有真实现(`admin.ts` 5 个 / `material.ts` 4 个
 * 按**族**分文件,其余 15 个各占一个模块:`craft.ts` / `sleep.ts` / ...)。
 * 余下 2 个 —— `MOVE` / `ATTACK` —— 仍回 `NOT_IMPLEMENTED`(见下方 ★)。
 * ⇒ 改某个动作时**只改它自己那个文件**,本文件与 `room.ts` 一个字都不用动。
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
import { useItem } from './use_item.ts';
import { buyItem } from './buy_item.ts';

/**
 * 24 个动作的执行层。键序与 `RoomAction` 的声明序一致(便于逐行对表)。
 *
 * ★ 「接线缺口」的历史清单见 `docs/TASK-96-action-landing-gaps.md`(当时记的 13 处未接线,
 *   现已全部接线);今天仍回 `NOT_IMPLEMENTED` 的只剩 `MOVE` / `ATTACK`,这是**刻意**的
 *   (它们走专用报文通道,`move.ts` / `attack.ts` 上方各有说明),不是「还没做」。
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
  USE_ITEM: useItem,
  /* ★ WS-FND-77 A-4:百货店购买(515)。此前 `systems/depot.ts:buy` 只有测试在调。 */
  BUY_ITEM: buyItem,
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