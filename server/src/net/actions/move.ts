/**
 * `MOVE` —— **尚无执行层**(且**刻意**如此)。
 *
 * ⚠️ `MOVE` **不走 `action` 通道**:它经 `onMessage('move')` →
 *   `RoomRuntime.applyMove()` → 世界层执行(`tests/WS-07` 钉着行为)。
 *   ⇒ 这里回 `NOT_IMPLEMENTED` 的意思是「**别从这里发**」,不是「还没做」。
 *   接线前先读 `docs/TASK-96-action-landing-gaps.md` 第一节。
 *
 * 回执与拆分前的 `default:` 分支**逐字相同**;若哪天真要走本通道,只改本文件
 * (13 个未接动作各占一个模块 ⇒ 并行接线时文件互斥)。
 */
import { notImplemented } from './not-implemented.ts';
import type { ActionHandler } from './types.ts';

export const move: ActionHandler = (ctx) => notImplemented(ctx.action);
