/**
 * **NPC 头上的任务记号**(纯函数 / 零 DOM / 零 three / 零 import ⇒ `node` 里可直接断言)。
 *
 * ## 它补的是哪一格
 *
 * `client/src/ui/npc_panel.ts` 管的是「跟他说完话之后面板上写什么」;本文件管**走近之前**
 * 那一眼:谁头上有 `!`(有事找你)、谁头上有 `?`(去交任务)、谁只有 `·`(没事)。
 * 三个记号与老 RPG 的口径一致(`available → !`、`completed → ?`),玩家不用先跑一圈问话。
 *
 * ## 输出是什么、不是什么
 *
 * 输出是**位置 + 记号**的平铺列表(「要画什么」),不是立牌对象、不是 DOM、不进 three:
 * 站位/朝向/LOD 预算由接线侧(`client/src/three/**`)决定,这里只保证
 * ```text
 * 顺序确定:按 y 升序,再按 x 升序,最后按 id(同一帧两次调用逐字相同)
 * 记号确定:三种状态三个符号;不认识的状态一律 '·'(不猜)
 * ```
 *
 * ## 兜底
 *
 * - `npcs` 不是数组 / 是 `null` ⇒ `[]`(**不是** `undefined`:调用方直接 `for...of`);
 * - 单条记录坏了(缺 `id` / `x`、`y` 不是有限数)⇒ **跳过这一条**,不让一个坏记录
 *   把整帧的排序搅成 `NaN` 比较(那会让顺序随实现随机);
 * - `statusOf` 抛错 / 不是函数 ⇒ 按 `'none'`(画 `·`),不把异常抛进渲染循环。
 */

/** 头上的记号:`!` 有事找你 / `?` 可以交 / `·` 没事。 */
export type QuestMarker = '!' | '?' | '·';

/** `statusOf` 的返回值(与服务端 `dialogue.ts#QuestStatus` 同值 + 一个 `'none'`)。 */
export type QuestMarkerStatus = 'available' | 'accepted' | 'completed' | 'none';

/** 一个 NPC 的位置(`id` 与 `server/src/npc/defs.ts#NPCS[].id` 同值)。 */
export interface QuestMarkerNpc {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** 一条「谁头上画什么」的记录。 */
export interface QuestMarkerPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly marker: QuestMarker;
}

/** 有事找你(与服务端 `available` 对应)。 */
export const QUEST_MARKER_AVAILABLE: QuestMarker = '!';
/** 去交任务(与服务端 `completed` 对应:已封账,该去找他领奖/回话)。 */
export const QUEST_MARKER_COMPLETED: QuestMarker = '?';
/** 其它一切(`accepted` / `none` / 不认识)。 */
export const QUEST_MARKER_OTHER: QuestMarker = '·';

/**
 * 状态 → 记号。
 *
 * ⚠️ 两张映射**不许对调**(`available → !`、`completed → ?` 是老 RPG 的公共约定):
 * `tests/WS-FND-192-npc-panel.test.ts` 的 FND192-12 钉住它,文件头「有牙实证」记着
 * 对调后变红的真实输出。
 */
export function markerOf(status: unknown): QuestMarker {
  if (status === 'available') return QUEST_MARKER_AVAILABLE;
  if (status === 'completed') return QUEST_MARKER_COMPLETED;
  return QUEST_MARKER_OTHER;
}

/** 调 `statusOf` 并保证不抛:不是函数 / 抛错 / 返回垃圾 ⇒ `'none'`。 */
function safeStatusOf(fn: unknown, npcId: string): unknown {
  if (typeof fn !== 'function') return 'none';
  try {
    return (fn as (id: string) => unknown)(npcId);
  } catch {
    /* 账本读坏了 ⇒ 画「没事」,而不是让整帧 NPC 记号消失(见文件头「兜底」)。 */
    return 'none';
  }
}

/** id 的确定性次序(坐标相同时的最后一档,免得顺序依赖引擎的排序稳定性)。 */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * NPC 列表 + 「他有没有事」→ 该画哪些记号。
 *
 * @param npcs      NPC 位置(只读;入参**不被修改**,输出是新数组)。
 * @param statusOf  `npcId → 状态`;不认识 / 抛错都按 `'none'` 处理。
 *
 * 空输入 ⇒ `[]`;顺序:按 `y` 升序 → `x` 升序 → `id`(判据 FND192-13)。
 */
export function questMarkers(
  npcs: readonly QuestMarkerNpc[],
  statusOf: (npcId: string) => QuestMarkerStatus,
): QuestMarkerPlacement[] {
  const list = Array.isArray(npcs) ? npcs : [];
  const out: QuestMarkerPlacement[] = [];
  for (const npc of list) {
    /* 坏记录跳过(见文件头):`x`/`y` 不是有限数就排不了序,留着只会让顺序变得随机。 */
    if (npc === null || typeof npc !== 'object') continue;
    const id = typeof npc.id === 'string' ? npc.id : '';
    if (id === '') continue;
    if (typeof npc.x !== 'number' || !Number.isFinite(npc.x)) continue;
    if (typeof npc.y !== 'number' || !Number.isFinite(npc.y)) continue;
    out.push({ id, x: npc.x, y: npc.y, marker: markerOf(safeStatusOf(statusOf, id)) });
  }
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x) || byId(a.id, b.id));
  return out;
}
