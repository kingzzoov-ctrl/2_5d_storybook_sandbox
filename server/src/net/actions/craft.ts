/**
 * `CRAFT` —— 尚无执行层。
 *
 * 拆分前它在 `dispatchAction` 的 `default:` 分支里;现在搬到这里,**回执逐字不变**。
 * 接线时**只改本文件**:把处理器体换成真实现,`action_table.ts` 与 `room.ts` 都不用动
 * (13 个未接动作各占一个模块 ⇒ 并行接线时文件互斥)。缺什么见
 * `docs/TASK-96-action-landing-gaps.md`(第三节)。
 */
import { notImplemented } from './not-implemented.ts';
import type { ActionHandler } from './types.ts';

export const craft: ActionHandler = (ctx) => notImplemented(ctx.action);
