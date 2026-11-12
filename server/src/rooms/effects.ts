/**
 * WS-03 / **房间效果消费点**(手册 §3.8 的 9 种动态房间增益)。
 *
 * ## 这个文件存在的理由
 *
 * `build/rooms.ts` 的 BFS 房间识别实现完整、单测全绿;task-36 又把
 * `identifyAllRooms` 接到了 `WorldSim` 慢帧,`rooms()` 能识别出
 * `ALCHEMY_LAB`(score=108)。**但没有任何游戏逻辑消费识别结果** ——
 * 实测全仓 `.rooms()` 只出现在 `tests/WS-03.test.ts`。
 *
 * 后果:玩家盖出【森系茶歇卧室】(核心件 517)站进去,**血量不回复**;
 * 盖出【露天温泉馆】(526)不加上限;盖出【大师锻造房】(503+504)不解锁锻造。
 * 手册给每种房间都写了明确增益,**一条都没实现** —— 而门禁全绿。
 *
 * ⇒ 本文件是「识别结果 → 玩家身上的可观测效果」这一步。
 *
 * ## 设计约束
 *
 * 1. **只做纯函数 + 显式状态**:不碰网络、不读时钟、不引 `WorldSim`
 *    (避免循环依赖),`WorldSim` 慢帧把「本帧玩家在哪、房里有什么」喂进来。
 * 2. **不新增冻结层字段**:9 种房间的增益全部在服务端派生,`shared/**` 零改动。
 * 3. **增益随离开撤销**,不是「进过一次永久生效」—— 这是房间效果与一次性解锁
 *    的本质区别(WELL 断言 WT-03-64/65 的负对照钉住它)。
 */

/** 房内每秒恢复的 HP(手册:【森系茶歇卧室】躺上去每秒 15 HP)。 */
export const BEDROOM_HEAL_PER_SEC = 15;

/** 温泉的生命上限倍率(手册:战前泡澡获 20 分钟生命上限 +30%)。 */
export const ONSEN_MAX_HP_MUL = 1.3;

/**
 * 温泉增益的**持续秒数**(手册「20 分钟」= 1200 秒)。
 *
 * 刻意在**离开温泉后**才开始倒计时:手册说的是「泡澡**获**20 分钟」,
 * 即泡完带走 20 分钟的加成。而「站在水里」本身是即时生效的 ——
 * 两者都需要,否则「泡一下就走」拿不到任何东西。
 */
export const ONSEN_BUFF_SEC = 1200;

/** 一个玩家的房间效果状态(由 `WorldSim` 按玩家持有)。 */
export interface RoomEffectState {
  /** 温泉剩余秒数(>0 时 maxHp 按 `ONSEN_MAX_HP_MUL` 放大) */
  onsenSec: number;
  /** 本帧是否站在温泉里 */
  inOnsen: boolean;
  /** 本帧是否站在卧室里 */
  inBedroom: boolean;
  /** 本帧是否站在锻造房里 */
  inForge: boolean;
}

export function createRoomEffectState(): RoomEffectState {
  return { onsenSec: 0, inOnsen: false, inBedroom: false, inForge: false };
}

/** 一帧的输入:玩家在哪、所站格属于哪个房间。 */
export interface RoomEffectInput {
  /** 玩家所在格所处的房间 key;不在任何房间内为 null。 */
  roomKey: string | null;
  /** 本帧时长(秒)。 */
  dt: number;
}

/** 一帧的输出:本帧应施加的效果 + 新的状态。 */
export interface RoomEffectResult {
  state: RoomEffectState;
  /** 本帧应恢复的 HP(已按 `dt` 折算) */
  healHp: number;
  /** 生命上限倍率(1.0 表示无加成) */
  maxHpMul: number;
  /** 是否解锁中高级锻造 */
  forgeUnlocked: boolean;
}

/**
 * 由状态派生**有效生命上限倍率**。
 *
 * 单独导出而不是让调用方各写一遍:倍率是「玩家身上的可观测事实」,
 * 查询(`effectiveMaxHp`)与推进(`stepRoomEffects`)必须用**同一个函数**
 * 得出同一个数。上一次我在这里留了两份实现(判定散在 `WorldSim` 里
 * 又判一遍 `inOnsen || onsenSec > 0`),靠故障注入才发现是死字段。
 */
export function maxHpMulOf(st: RoomEffectState): number {
  return st.inOnsen || st.onsenSec > 0 ? ONSEN_MAX_HP_MUL : 1.0;
}

/**
 * 推进一个玩家的房间效果一帧。
 *
 * ## 为什么 maxHp 用**倍率**而不是直接改 `PlayerVitals.maxHp`
 *
 * `vitals.ts` 的注释明说 `maxHp` 是**构造期常量**,`importVitals` 刻意
 * **不信任存档里的 maxHp**。若房间效果直接写 `maxHp`,会与那条不变量冲突:
 * 存档往返一次 maxHp 就被固化,离开温泉也回不去。
 *
 * ⇒ 这里只**派生**倍率,由调用方决定怎么用(vitals 上的 `maxHp` 保持基准值,
 * 派生值单独暴露)。这样「离开即撤销」是天然成立的,不需要反向记账。
 */
export function stepRoomEffects(st: RoomEffectState, input: RoomEffectInput): RoomEffectResult {
  const dt = input.dt;
  const key = input.roomKey;

  const inOnsen = key === 'SAKURA_ONSEN';
  const inBedroom = key === 'COZY_BEDROOM';
  const inForge = key === 'FORGE_MASTER';

  /*
   * 温泉计时:站在水里时**重置**为满时长(手册:泡澡获 20 分钟);
   * 不在水里时递减。两条都必须在 —— 只递减则「泡一下」拿不到时长,
   * 只重置则离开后永不失效。
   */
  let onsenSec = st.onsenSec;
  if (inOnsen) {
    onsenSec = ONSEN_BUFF_SEC;
  } else if (onsenSec > 0) {
    onsenSec = Math.max(0, onsenSec - dt);
  }

  return {
    state: { onsenSec, inOnsen, inBedroom, inForge },
    /* 卧室回血:按 dt 折算,帧率无关。 */
    healHp: inBedroom ? BEDROOM_HEAL_PER_SEC * dt : 0,
    /* 生命上限倍率:站在温泉里 **或** 泡澡增益未过期都生效。 */
    maxHpMul: maxHpMulOf({ onsenSec, inOnsen, inBedroom, inForge }),
    forgeUnlocked: inForge,
  };
}

/**
 * 判断某坐标落在哪个房间内。
 *
 * ## 为什么按格判定而不是「点到矩形距离」
 *
 * 房间形状**不必是矩形**(`fooRoom` 用泛洪取内部格),而 `bbox` 是外接矩形。
 * 用 `bbox` 判定会把「L 形房间凹进去那块的房外空间」也算作房内 ——
 * 玩家站在房子外面贴着墙,却拿到卧室回血。
 *
 * 因此按**格集合**判定。`cells` 由 `RoomIdentity` 携带(见 `build/rooms.ts`
 * 的 `RoomInfo.cells`,识别结果里必须一并保留)。
 */
export function roomAtCell(
  rooms: readonly { key: string | null; cells: readonly { x: number; y: number }[] }[],
  x: number,
  y: number,
): string | null {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  for (const r of rooms) {
    if (r.key === null) continue;
    for (const c of r.cells) {
      if (c.x === gx && c.y === gy) return r.key;
    }
  }
  return null;
}
