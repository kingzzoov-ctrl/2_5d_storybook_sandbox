/**
 * 预警圈圆心 —— 从**权威状态**取,不从相机 / `pan` 取。
 *
 * ## 为什么单独一个模块(它是为了「可测」才被拆出来的)
 *
 * 验收判据「**预警圈圆心 == 权威玩家位置**」的**本体**在 `three/boot.ts` 里
 * (那里才拿得到 `bossActive`、相机、渲染循环)。而 `boot.ts` 的闭包含三方 `three`,
 * **Node 里 import 不了** —— 实测全仓没有任何测试 import `three/` 下任何文件。
 * ⇒ 判据若落在 boot.ts 上,**结构上不可测**。
 *
 * ∴ 把「状态 → 圆心」这半抽成**纯函数**放这里:只依赖 `shared/types/wire.ts`,
 *   零三方、零 DOM、零 `three` ⇒ 可被 `tests/WS-12.test.ts` 直接 import 并断言。
 *   boot.ts 那边只剩一个**调用点**(那半只能靠源码文本断言,显式标注为弱判据)。
 *
 * ## 为什么不能从 `pan` 取(这是 S1 删掉的那两行)
 *
 * `pan` 是**相机平移**:拖拽(WASD)与 `teleport` 都会改它,它可以**离开玩家**。
 * 而圆心必须钉在**服务端裁决的玩家位置**上 —— 两者语义不同。
 * 接线前 `boot.ts` 写的是 `playerGx = pan.x; playerGy = pan.y;`,
 * 那是「把相机当玩家」,所以 S1 先删掉了它(否则同帧覆盖任何权威值)。
 */

import type { RoomState } from '../../../shared/types/wire.ts';

/** 预警圈圆心(世界格)。 */
export interface TelegraphCenter {
  cx: number;
  cy: number;
}

/**
 * 取**本地玩家**的权威位置,作为预警圈圆心。
 *
 * ## 空输入的语义(★ 显式定义,并且在 WS-12 里被断言)
 *
 * 返回 `null` —— 三种情况都返回它:
 *   1. `state.players` 为空(阶段 3 刚连上、**第一帧还没到**)
 *   2. `localPlayerId` 为空串(还没握手拿到自己的 id)
 *   3. `players` 里有玩家,但**没有** `localPlayerId` 这个 id(自己死了/掉线/被移出)
 *
 * ## 为什么返回 `null` 而不是 `{cx:0, cy:0}`
 *
 * `{0,0}` 是**世界原点**,是一个**看起来合法的错误位置** ⇒
 * 调用方会照画一个预警圈在角落上一帧,表现为「画面跳一下」,
 * 而**没有任何东西会报错**。`null` 把「不知道」与「位置是 0,0」分开,
 * 强迫调用方显式决定(见 `boot.ts` 的用法:保持上一帧的已知位置)。
 *
 * ## 为什么必须有 `localPlayerId` 参数(不能"自己挑一个")
 *
 * 房间里可能有很多玩家。圆心是**本地玩家**的,不是"第一个玩家"的。
 * 不做 fallback:悄悄挑 `players[0]` 会在多人房里把圆心钉到**别人**头上,
 * 而那同样**不会报错**。id 由握手拿(见 `session.ts` 的 `hello` 帧)。
 *
 * ## 为什么**没有** `if (state.players.length === 0)` 这一行
 *
 * 初版写过它,后来删了 —— 因为它**事实上是死代码**:
 * `[].find(pred)` 恒返回 `undefined`,与「`p === undefined` ⇒ `null`」同结果。
 * 穷举验证(玩家数 0–3 × localId 3 种 = 12 组):有无这一行**输出完全相同**。
 * ⇒ 留着它会给人"它守住了空态"的错觉,而真正守住空态的是下面那个 `undefined` 分支
 *   (由 WS-12 的空态用例钉住,不是靠注释)。
 * ⇒ ⚠️ 但 `localPlayerId === ''` 那一行**不是**冗余的,别顺手删:
 *   若某个玩家 id 恰为空串,`find` 会**匹配**它 —— 早退阻止了这种误认。
 */
export function telegraphCenterOf(state: RoomState, localPlayerId: string): TelegraphCenter | null {
  if (localPlayerId === '') return null;
  const p = state.players.find((x) => x.id === localPlayerId);
  if (p === undefined) return null;
  return { cx: p.x, cy: p.y };
}
