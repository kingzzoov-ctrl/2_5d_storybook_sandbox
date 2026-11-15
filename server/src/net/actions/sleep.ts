/**
 * `SLEEP` —— 尚无执行层。
 *
 * ⚠️ 别与 `RoomRuntime.sleep()` 搞混:那是**房间休眠**(空闲暂停),
 *   **不是**玩家睡觉。接线前先读 `docs/TASK-96-action-landing-gaps.md`(第三节)。
 *
 * 回执与拆分前的 `default:` 分支**逐字相同**;接线时**只改本文件**。
 */
import { notImplemented } from './not-implemented.ts';
import type { ActionHandler } from './types.ts';

export const sleep: ActionHandler = (ctx) => notImplemented(ctx.action);
