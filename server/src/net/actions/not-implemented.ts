/**
 * 「尚无执行层」这一条回执的**唯一**出处。
 *
 * 22 个动作里当前有 13 个还没有执行层(`MOVE` / `ATTACK` 是**刻意**不走 `action`
 * 通道,见 `docs/TASK-96-action-landing-gaps.md` 第一节)。它们的回执文本必须
 * 与拆分前**逐字相同**,因此做成一个构造器,而不是 13 个模块各写一遍模板串
 * (两份文本就是两份事实,迟早会漂)。
 *
 * ⚠️ 理由文本**逐字**沿用 `dispatchAction` 的 `default:` 分支(2026-11-14 原文):
 * ```ts
 * `动作 ${action} 尚无执行层(授权存在、执行不存在 —— 见 docs/TASK-94)`
 * ```
 * 搬代码不该改字:客户端与 `tests/WS-07`(ACT-2)/ `tests/WS-FND-18`(FND18-2)
 * / `tests/WS-FND-21`(FND21-3)看到的是同一句话。
 */
import type { ActionOutcome, RoomAction } from '../room.ts';

/** 未接线动作的标准回执:显式说「尚无执行层」,绝不静默成功。 */
export function notImplemented(action: RoomAction): ActionOutcome {
  return {
    ok: false,
    kind: 'NOT_IMPLEMENTED',
    reason: `动作 ${action} 尚无执行层(授权存在、执行不存在 —— 见 docs/TASK-94)`,
  };
}