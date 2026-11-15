/**
 * `ATTACK` —— **尚无执行层**(且**刻意**如此)。
 *
 * ⚠️ `ATTACK` **不走 `action` 通道**:它经 `onMessage('attack')` →
 *   `RoomRuntime.applyAttack()` → 世界层结算(结算值走 `attackResult` 回执)。
 *   ⇒ 这里回 `NOT_IMPLEMENTED` 的意思是「**别从这里发**」,不是「还没做」。
 *   接线前先读 `docs/TASK-96-action-landing-gaps.md` 第一节。
 *
 * 回执与拆分前的 `default:` 分支**逐字相同**;若哪天真要走本通道,只改本文件。
 */
import { notImplemented } from './not-implemented.ts';
import type { ActionHandler } from './types.ts';

export const attack: ActionHandler = (ctx) => notImplemented(ctx.action);
