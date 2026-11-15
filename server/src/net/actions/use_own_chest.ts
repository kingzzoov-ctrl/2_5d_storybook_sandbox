/**
 * `USE_OWN_CHEST` —— 打开**自己**的储物箱(按玩家隔离)。
 *
 * 它与 `OPEN_CHEST` 的区别**只有一处**:动的是哪一份容器。
 *   · `OPEN_CHEST`    动那一格的**公共**内容 —— 全房共享一份(见 `open_chest.ts` 的 `PUBLIC_CHEST`);
 *   · `USE_OWN_CHEST` 动那一格里**该玩家自己**的私有抽屉 —— 别人看不到也拿不到
 *     (`ownChestContainers(actorId)` 只给出 `actorId` 自己的数组,结构上拿不到别人的)。
 *
 * 「别人看不到、也拿不到」不是一句约定,而是**入口形状**决定的:抽屉是
 * `Map<userId, ItemStack[]>`,解析函数只接受一个 `actorId`,没有任何参数能让
 * 调用方指定「看谁的」。
 *
 * 权限位是 `baseline`(见 `ACTION_PERMISSION`)⇒ 只要在房里就能用,这正是
 * `OPEN_CHEST`(要求 `publicStorage`)与它的**权限对照**。
 *
 * ⚠️ 本文件不自己实现取放:容器模型与事务顺序**唯一**在 `open_chest.ts`
 *   (`runChestAction` + `ChestContainers`)。这里只剩「选哪个容器」这一件事。
 * ⚠️ 边界(与 `open_chest.ts` 同一份,别当成做到了):
 *   箱内内容**不上 wire**、容器状态**不持久化**、世界里**没有**真实箱子实体
 *   (箱子由 `registerChest()` 登记)。
 */
import { ownChestContainers, runChestAction } from './open_chest.ts';
import type { ActionHandler } from './types.ts';

export const useOwnChest: ActionHandler = (ctx) => runChestAction(ctx, ownChestContainers(ctx.actorId));
