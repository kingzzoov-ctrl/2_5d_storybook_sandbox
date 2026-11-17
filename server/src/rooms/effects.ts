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
 *
 * ## `hasMealBuff` → `mealMul`:谁传、在谁身上生效、今天到哪一步
 *
 * 大餐乘区是本文件里**唯一需要调用方喂一个「玩家身上有什么」的事实**的效果 ——
 * 其余效果只看「站在哪个房间」,房外的世界状态一概不需要。
 *
 * · **谁传**:`WorldSim` 的慢帧房间效果推进(`server/src/sim/world_sim.ts` 的
 *   `tickRoomEffects`,那里持有玩家的 `FoodBuff` 表)按玩家身上的料理 buff 算出
 *   `hasMealBuff` 再喂进来。本文件刻意**不 import `cooking.ts`** —— 那会让
 *   「房间效果」依赖「料理/战斗」,而这里只需要一个**已经判好的事实**。
 *   ⚠️ **调用方必须传**:`undefined` 与 `false` 在本文件里同义 ⇒
 *   漏传**不报错**,只让乘区**静默**恒 `1.0`(判据
 *   `tests/WS-FND-47-meal-mul.test.ts` 第 4 条专门钉这个"漏传的显式后果")。
 * · **在谁身上生效**:`stepRoomEffects` 只**返回** `mealMul`;把它记进
 *   `WorldSim.lastRoomEffects` 是调用方的事。乘区最终乘在**该玩家的攻击 /
 *   生命上限**上(手册 §3.8:「Boss 战前全团 +40% 攻击/生命上限大餐」)。
 * · **今天到哪一步**:本文件**已**返回 `mealMul`(纯函数,判据有牙);
 *   `WorldSim` 侧**尚未**传 `hasMealBuff`、`lastRoomEffects` 里**尚未**有
 *   `mealMul` ⇒ **生产路径上乘区恒 `1.0`**。即:判据有牙、接线未完成。
 */

import { RANCH_SYSTEM } from '../systems/ranch.ts';
import { GREENHOUSE_SYSTEM } from '../systems/greenhouse.ts';
import { ALCHEMY_LAB_SYSTEM } from '../systems/alchemy_lab.ts';
import { DEPOT_SYSTEM } from '../systems/depot.ts';

/**
 * 一个「系统解锁」房间的实现登记:模块路径 + 接线方要调的那个入口。
 *
 * ## 为什么这不是一张字符串表
 *
 * 这四个 `SYSTEM_UNLOCK` 房间此前在 `ROOM_EFFECT_DECISION` 里只写了一句
 * 「⇒ 未实装」——**文字**。文字不可判定:模块改名、文件被删、入口函数不存在,
 * 那句话照样在那儿,门禁照样绿。
 *
 * ⇒ 现在每个系统在自己的模块里导出一个 `*_SYSTEM` 常量(`module` = 仓库相对
 * 路径、`entry` = 入口函数名),本文件把它们**真的 import 进来**登记成一张表:
 *   · `implementedBy` 由这张表派生(单一事实源,不会两处漂移);
 *   · 判据可以核「文件真的存在」「入口函数真的导出」;
 *   · 这四个模块因此是**生产可达**的(不是只被测试引用的孤儿)。
 */
export interface RoomSystemImpl {
  roomKey: string;
  module: string;
  entry: string;
}

/** `SYSTEM_UNLOCK` 四种房间 → 实现落点。 */
export const ROOM_SYSTEM_IMPL: Readonly<Record<string, RoomSystemImpl>> = Object.freeze({
  ECO_RANCH: RANCH_SYSTEM,
  ALCHEMY_LAB: ALCHEMY_LAB_SYSTEM,
  AUTO_GREENHOUSE: GREENHOUSE_SYSTEM,
  CLOUD_DEPOT: DEPOT_SYSTEM,
});

/**
 * 这个房间的系统**是否已实装**:登记表里有它、且模块路径与入口都不是空串。
 *
 * ⚠️ 它只回答「有没有落点」,不回答「落点接进世界了没有」—— 后者要看
 * `WorldSim` 的调用点(见各系统文件头的接线说明)。
 */
export function isRoomSystemImplemented(roomKey: string): boolean {
  const impl = ROOM_SYSTEM_IMPL[roomKey];
  return impl !== undefined && impl.module.length > 0 && impl.entry.length > 0;
}
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

/**
 * 手册 §3.8 的 **9 种动态房间 —— 每一种都必须在这里有一条决定**。
 *
 * ## 为什么需要这张表(而不是「实现了 3 种就算数」)
 *
 * `shared/constants/bosses.ts` 的 `ROOM_RECIPES` 有 **9** 条(冻结层,不可改)。
 * 而本文件此前只处理了其中 **3** 条的数值效果(温泉 / 卧室 / 锻造房),
 * 另外 6 条**没有任何读者** —— 玩家盖出【欢聚大锅食堂】站进去,说明书承诺的
 * 「Boss 战前全团 +40% 大餐」不会发生,而**门禁全绿、也不报错**。
 *
 * ⇒ 这张表把「另外 6 条怎么办」从**沉默**变成**决定**:
 *   · `PLAYER_NUMERIC` —— 有可观测数值,本文件实现它;
 *   · `SYSTEM_UNLOCK`  —— 它的 bonus 是**解锁一个系统**(商店/物流/炼金/饲养)。
 *     这四个系统的实装落在 `server/src/systems/**`,由 `ROOM_SYSTEM_IMPL` 登记、
 *     `implementedBy` 指路;房间本身**不产生玩家数值**(数值都在系统的纯函数里)。
 *   · `DISPLAY_ONLY`   —— 它本来就不产生玩家数值(画廊展示)。
 *
 * ⚠️ 判据是**覆盖性**,且对着**冻结层**核:`tests/WS-FND-17` 断言
 *    `ROOM_RECIPES` 的每个 key 都在这张表里。⇒ 将来手册加了第 10 种房间,
 *    这里会**当场红**,而不是悄悄多一条没人处理的 key。
 */
export const ROOM_EFFECT_DECISION: Readonly<Record<string, {
  kind: 'PLAYER_NUMERIC' | 'SYSTEM_UNLOCK' | 'DISPLAY_ONLY';
  /** 该房间的增益内容(PLAYER_NUMERIC)或解锁的系统 + 实现落点。 */
  purpose: string;
  /**
   * 实现落点 = **仓库相对路径**;由 `ROOM_SYSTEM_IMPL` 派生。
   *
   * 只有 `SYSTEM_UNLOCK` 的四种有(数值/展示类房间的效果就在本文件里,
   * 不需要指路)。判据 `tests/WS-FND-75-room-systems.test.ts` 核它
   * 非空、文件存在、入口函数真的导出。
   */
  implementedBy?: string;
}>> = Object.freeze({
  FORGE_MASTER: { kind: 'PLAYER_NUMERIC', purpose: '解锁中高级武器护甲与魔能电路锻造(`forgeUnlocked`)' },
  COZY_CANTEEN: { kind: 'PLAYER_NUMERIC', purpose: '大餐:站内**且带着料理 buff** 时攻击 / 生命上限 ×1.4(见 `CANTEEN_MEAL_MUL`)' },
  COZY_BEDROOM: { kind: 'PLAYER_NUMERIC', purpose: '每秒回 15 HP(`BEDROOM_HEAL_PER_SEC`)+ 打盹状态(`napping`)' },
  SAKURA_ONSEN: { kind: 'PLAYER_NUMERIC', purpose: '泡澡获 20 分钟生命上限 ×1.3(`ONSEN_MAX_HP_MUL` / `ONSEN_BUFF_SEC`)' },
  ECO_RANCH: { kind: 'SYSTEM_UNLOCK', implementedBy: ROOM_SYSTEM_IMPL.ECO_RANCH.module, purpose: '圈养动物自动进食 + 每日产出毛团/温泉橘 ⇒ 已实装:`server/src/systems/ranch.ts` 的 `settleRanchDay` / `canAutoFeed`(日结);系统解锁本身**不产生玩家数值** —— 产出在系统的纯函数里' },
  ART_GALLERY: { kind: 'DISPLAY_ONLY', purpose: '像素画作与自定义纹章**展示** —— 按手册不产生玩家数值' },
  ALCHEMY_LAB: { kind: 'SYSTEM_UNLOCK', implementedBy: ROOM_SYSTEM_IMPL.ALCHEMY_LAB.module, purpose: '自由炼金 + 全服首创冠名陈列 ⇒ 已实装:`server/src/systems/alchemy_lab.ts` 的 `brewAndRecord`(复用 `alchemy/degrade.ts` 的确定性降级,不联网)+ `firstDiscovererOf` / `galleryOrder`;系统解锁本身**不产生玩家数值**' },
  AUTO_GREENHOUSE: { kind: 'SYSTEM_UNLOCK', implementedBy: ROOM_SYSTEM_IMPL.AUTO_GREENHOUSE.module, purpose: '全天候透光 + 自动洒水与分拣物流 ⇒ 已实装:`server/src/systems/greenhouse.ts` 的 `cellGrowth`(夜/暴风雨照长)/ `morningMoisture` / `sprinklerCells`(5×5)/ `sortHarvest`;系统解锁本身**不产生玩家数值**' },
  CLOUD_DEPOT: { kind: 'SYSTEM_UNLOCK', implementedBy: ROOM_SYSTEM_IMPL.CLOUD_DEPOT.module, purpose: '上架稀有材料与奇物 + 购买结算 ⇒ 已实装:`server/src/systems/depot.ts` 的 `listable` / `buy`;价格只取内容表,内容表没有 `price` 就照实返回「无定价」(**不发明价格**);系统解锁本身**不产生玩家数值**' },
});

/**
 * 【欢聚大锅食堂】的大餐倍率(手册:「Boss 战前全团 +40% 攻击/生命上限大餐」)。
 *
 * ⚠️ 触发条件是**站里 + 带着料理 buff**,不是"站里就给":手册说的是**大餐**
 *    —— 而大餐是 `cooking.ts` 的产物。这条区分很重要:否则玩家空手站在食堂里
 *    就能白拿 +40%,而那是另一条规则。
 */
export const CANTEEN_MEAL_MUL = 1.4;

/** 一个玩家的房间效果状态(由 `WorldSim` 按玩家持有)。 */
export interface RoomEffectState {
  /** 温泉剩余秒数(>0 时 maxHp 按 `ONSEN_MAX_HP_MUL` 放大) */
  onsenSec: number;
  /** 本帧是否站在温泉里 */
  inOnsen: boolean;
  /** 本帧是否站在卧室里 */
  inBedroom: boolean;
  /** 本帧是否站在锻造房里 */
  /** 本帧是否站在锻造房里 */
  inForge: boolean;
  /** 本帧是否站在食堂里(【欢聚大锅食堂】) */
  inCanteen: boolean;
}

export function createRoomEffectState(): RoomEffectState {
  return {
    onsenSec: 0, inOnsen: false, inBedroom: false, inForge: false, inCanteen: false,
  };
}

/** 一帧的输入:玩家在哪、所站格属于哪个房间。 */
export interface RoomEffectInput {
  /** 玩家所在格所处的房间 key;不在任何房间内为 null。 */
  roomKey: string | null;
  /** 本帧时长(秒)。 */
  dt: number;
  /**
   * 玩家**当前是否带着料理 buff**(由调用方从他身上的 `FoodBuff` 列表算)。
   *
   * ⚠️ **调用方必须传这个字段** —— 见文件头「谁传 / 在谁身上生效 / 今天到哪一步」。
   *
   * 类型上写 `?` 只为让与它无关的调用(只想看回血/上限的房间)仍能编译,
   * **不是**"可以不传":`undefined` 与 `false` 在本文件里**同一含义**,
   * 都不触发乘区。漏传的后果是**静默**的(不抛错、门禁全绿,而玩家拿不到 +40%),
   * 这正是乘区"算完即丢"时的形态 ⇒ 判据 `tests/WS-FND-47-meal-mul.test.ts`
   * 第 4 条把"不传"钉成 `1.0`。
   *
   * 非布尔值同样按"没有 buff"处理(判定用 `=== true`),**不抛错**:这个字段是
   * 加成的**触发条件**,而"没有 buff"是完全正常的状态 —— 让一个脏输入炸掉
   * 整帧物理不值得(判据第 7 条)。
   */
  hasMealBuff?: boolean;
}

/** 一帧的输出:本帧应施加的效果 + 新的状态。 */
export interface RoomEffectResult {
  state: RoomEffectState;
  /** 本帧应恢复的 HP(已按 `dt` 折算) */
  healHp: number;
  /** 生命上限倍率(1.0 表示无加成) */
  maxHpMul: number;
  /** 本帧是否打盹(卧室。手册:「每秒恢复 15 HP **并进入打盹状态**」) */
  napping: boolean;
  /** 大餐乘区(食堂 **且** 带着料理 buff);1.0 = 无 */
  mealMul: number;
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
 * ## ★ 2026-11-16 更正:`maxHp` 乘区**在哪里套**
 *
 * 这里的 `maxHpMulOf` 只**派生倍率**;真正把它乘上去的是
 * `WorldSim.maxHpForLevel`(上限的**唯一**算子),结果经 `syncMaxHp` 写进
 * `vitals.maxHp` —— 权威上限因此是**含乘区**的(否则泡温泉时回血填不满上限:
 * 上限 130、实际钳在 100)。
 *
 * ⚠️ 本文曾写"vitals 上的 `maxHp` 保持基准值、派生值单独暴露" —— 那是上一版的实现,
 * 与本版相反。`effectiveMaxHp`(同口径读数口)与 `maxHpForLevel` 现已统一到
 * `maxHpMulOf` **一处**条件上。「离开温泉即撤销」靠的是**每帧重算**
 * (`onsenSec` 归零 ⇒ 下一次重算回到基准),不是"从不写进 vitals"。
 */
export function stepRoomEffects(st: RoomEffectState, input: RoomEffectInput): RoomEffectResult {
  const dt = input.dt;
  const key = input.roomKey;

  const inOnsen = key === 'SAKURA_ONSEN';
  const inBedroom = key === 'COZY_BEDROOM';
  const inForge = key === 'FORGE_MASTER';
  const inCanteen = key === 'COZY_CANTEEN';

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
    state: { onsenSec, inOnsen, inBedroom, inForge, inCanteen },
    /* 卧室回血:按 dt 折算,帧率无关。 */
    healHp: inBedroom ? BEDROOM_HEAL_PER_SEC * dt : 0,
    /* 打盹:与回血**同源** —— 手册把两者写在同一句里,不拆成两个判据。 */
    napping: inBedroom,
    /* 生命上限倍率:站在温泉里 **或** 泡澡增益未过期都生效。 */
    maxHpMul: maxHpMulOf({ onsenSec, inOnsen, inBedroom, inForge, inCanteen }),
    /* 大餐乘区:食堂 **且** 带着料理 buff —— 手册说的是「大餐」,
       而大餐是 `cooking.ts` 的产物 ⇒ 空手站在食堂里**不该**拿到 +40%。
       ⚠️ `hasMealBuff` 是**入参**、不是本函数能推断的事实:调用方漏传
       ⇒ 本行恒 `1.0`(静默失效,见文件头那一小节 + 判据第 4 条)。
       非 `true` 的值一律按"没有 buff":乘区是触发条件,不是校验对象。 */
    mealMul: inCanteen && input.hasMealBuff === true ? CANTEEN_MEAL_MUL : 1.0,
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
