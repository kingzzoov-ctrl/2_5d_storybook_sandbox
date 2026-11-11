/**
 * WS-11 · 35 种整蛊玩具全数据化表(设计手册 §3.4,物品 ID 221 ~ 255)
 *
 * 每一项统一携带 7 个字段:
 *   `trigger`      触发条件
 *   `radius`       作用半径(格)
 *   `impulse`      冲量(格/秒)
 *   `stunSec`      眩晕秒数
 *   `morphSec`     变形/持续状态秒数
 *   `allyEffect`   对队友的差异化效果
 *   `enemyEffect`  对野生怪物的差异化效果
 *
 * 设计铁律:
 *  - 队友侧一律零伤害(手册 §6.2「互坑但不痛」),只做位移/状态;
 *  - 怪物侧才有真实伤害或控制;
 *  - 218 工程安全帽(和平盾)的免疫裁定由 `prank/immunity.ts` 统一负责。
 *
 * 本文件只消费 `shared/constants/items.ts` 作为名称事实源,名称不在此处硬编码副本。
 */

import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

export const PRANK_TOY_ID_MIN = 221;
export const PRANK_TOY_ID_MAX = 255;
/** 221..255 是连续 35 个 ID。 */
export const PRANK_TOY_COUNT = PRANK_TOY_ID_MAX - PRANK_TOY_ID_MIN + 1;

export const TOY_TRIGGER = {
  /** 手持挥击 */
  SWING: 'SWING',
  /** 投掷落地 */
  THROW: 'THROW',
  /** 布置陷阱后由触碰触发 */
  PLACE: 'PLACE',
  /** 手持持续生效 */
  HELD: 'HELD',
  /** 穿戴后被动态触发 */
  WORN: 'WORN',
  /** 主动吹奏 / 敲击 */
  PLAY: 'PLAY',
  /** 使用后进入持续模式 */
  USE: 'USE',
} as const;
export type ToyTrigger = (typeof TOY_TRIGGER)[keyof typeof TOY_TRIGGER];

/** 状态标记:与冻结层 `BodyState` 的 7 态语义对齐并扩展。 */
export const TOY_STATE_FLAG = {
  NONE: 'NONE',
  SLIPPING: 'SLIPPING',
  STUNNED: 'STUNNED',
  BUBBLED: 'BUBBLED',
  FROZEN: 'FROZEN',
  GHOST_BUBBLE: 'GHOST_BUBBLE',
  AFK_SHIELD: 'AFK_SHIELD',
  MORPHED: 'MORPHED',
  FLOATING: 'FLOATING',
  GLUED: 'GLUED',
  CAMOUFLAGED: 'CAMOUFLAGED',
  SHRUNK: 'SHRUNK',
  GIANT: 'GIANT',
  BLINDED: 'BLINDED',
} as const;
export type ToyStateFlag = (typeof TOY_STATE_FLAG)[keyof typeof TOY_STATE_FLAG];

export interface ToyEffect {
  /** 打上的状态标记 */
  flag: ToyStateFlag;
  /** 位移距离(格),0 表示原地 */
  moveTiles: number;
  /** 对队友伤害:整蛊玩具恒为 0 */
  allyDamage: number;
  /** 对怪物伤害 */
  enemyDamage: number;
  /** 是否进入可被夺回 / 可救援窗口 */
  rescueWindow: boolean;
  /** 机制说明(手册原句摘要) */
  note: string;
}

export interface PrankToyDef {
  id: number;
  name: string;
  trigger: ToyTrigger;
  /** 作用半径(格) */
  radius: number;
  /** 冲量(格/秒) */
  impulse: number;
  /** 眩晕秒数 */
  stunSec: number;
  /** 变形 / 状态持续秒数 */
  morphSec: number;
  allyEffect: ToyEffect;
  enemyEffect: ToyEffect;
}

/** 35 项全量表:ID 与冻结层 §3.4(221~255)逐行对应。 */
const TOY_ROWS: readonly PrankToyDef[] = [
  {
    id: 221, name: '', trigger: TOY_TRIGGER.SWING, radius: 1.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '举起队友(含打盹 / 钓鱼中),可扔进河里;配合叠罗汉把人举到 Z=3.4 采高台果实。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '举起被砸晕的小怪扔向怪群当炮弹,落地时对周围造成撞击。' },
  },
  {
    id: 222, name: '', trigger: TOY_TRIGGER.SWING, radius: 1.4, impulse: 8, stunSec: 2.5, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 2, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对队友 0 伤害,只施加 8 格/秒击退冲量;也可敲晕偷木板河狸夺回材料。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 2, allyDamage: 0, enemyDamage: 30, rescueWindow: true, note: '把滚石穿山甲或糖球像打棒球一样反抽回去,命中后进入夺回窗口。' },
  },
  {
    id: 223, name: '', trigger: TOY_TRIGGER.SWING, radius: 4.0, impulse: 6, stunSec: 1.0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 3, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '直线弹出 4 格隔河顶人下水,不造成伤害。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 3, allyDamage: 0, enemyDamage: 45, rescueWindow: false, note: '把小怪推下悬崖,落水后进入溺水减速。' },
  },
  {
    id: 224, name: '', trigger: TOY_TRIGGER.USE, radius: 6.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 6, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '把抢到皇冠的朋友拽到面前;也可拉出红圈倒地队友。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '勾住云海鲸王背鳍登背作战;拔下发条重骑背后的钥匙令其瘫痪。' },
  },
  {
    id: 225, name: '', trigger: TOY_TRIGGER.PLACE, radius: 0.8, impulse: 0, stunSec: 1.2, morphSec: 5,
    allyEffect: { flag: TOY_STATE_FLAG.SLIPPING, moveTiles: 5, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '踩中极速打滑 5 格后撞墙眩晕 1.2 秒;和平盾免疫。' },
    enemyEffect: { flag: TOY_STATE_FLAG.SLIPPING, moveTiles: 5, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '冲锋中的精英怪与 Boss 同样打滑 5 格,撞墙自晕,可连锁堆叠。' },
  },
  {
    id: 226, name: '', trigger: TOY_TRIGGER.USE, radius: 1.0, impulse: 0, stunSec: 0, morphSec: 8,
    allyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '绑在队友背上让他飘到 Z=2 蹬腿呼救,无法主动下落。' },
    enemyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '让近战怪飘到空中打不到人,零伤亡控场。' },
  },
  {
    id: 227, name: '', trigger: TOY_TRIGGER.HELD, radius: 5.0, impulse: 0, stunSec: 0, morphSec: 6,
    allyEffect: { flag: TOY_STATE_FLAG.BUBBLED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '连射队友 3 发装进大泡泡随风乱飘;扑灭高炉火苗只需持续 0.5 秒。' },
    enemyEffect: { flag: TOY_STATE_FLAG.BUBBLED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '浇灭火灵护盾,对火属性怪造成破盾硬直。' },
  },
  {
    id: 228, name: '', trigger: TOY_TRIGGER.THROW, radius: 2.5, impulse: 4, stunSec: 0.5, morphSec: 3,
    allyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 2, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '点燃后 3 秒爆炸,不毁玩家建筑,只把队友炸飞翻滚。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 2, allyDamage: 0, enemyDamage: 120, rescueWindow: false, note: '对野生怪物 120 点破甲爆破伤害。' },
  },
  {
    id: 229, name: '', trigger: TOY_TRIGGER.SWING, radius: 4.0, impulse: 0, stunSec: 0, morphSec: 10,
    allyEffect: { flag: TOY_STATE_FLAG.MORPHED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '把队友变成无害小肥鸡或小绵羊 10 秒;和平盾免疫。' },
    enemyEffect: { flag: TOY_STATE_FLAG.MORPHED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '把精英怪变成 10 秒无威胁动物,可趁机集体输出。' },
  },
  {
    id: 230, name: '', trigger: TOY_TRIGGER.USE, radius: 0.5, impulse: 0, stunSec: 0, morphSec: 15,
    allyEffect: { flag: TOY_STATE_FLAG.SHRUNK, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '缩小为 0.3 倍,移速暴增且能钻进隐藏洞口。' },
    enemyEffect: { flag: TOY_STATE_FLAG.SHRUNK, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '怪物缩小后攻击力减半。' },
  },
  {
    id: 231, name: '', trigger: TOY_TRIGGER.USE, radius: 0.5, impulse: 0, stunSec: 0, morphSec: 15,
    allyEffect: { flag: TOY_STATE_FLAG.GIANT, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '体积 2.0 倍,生命上限与近战冲击力翻倍,Boss 战前排肉盾。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '纯团队增益,对怪物无直接效果。' },
  },
  {
    id: 232, name: '', trigger: TOY_TRIGGER.THROW, radius: 1.5, impulse: 0, stunSec: 0, morphSec: 8,
    allyEffect: { flag: TOY_STATE_FLAG.GLUED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '砸碎形成 3×3 蜂蜜滩,队友陷入也会减速 70%,可被队友拉出。' },
    enemyEffect: { flag: TOY_STATE_FLAG.GLUED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '大幅减缓高速 Boss、小偷河狸与跑酷对手 70% 移速。' },
  },
  {
    id: 233, name: '', trigger: TOY_TRIGGER.THROW, radius: 1.0, impulse: 0, stunSec: 0, morphSec: 3,
    allyEffect: { flag: TOY_STATE_FLAG.FROZEN, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '把队友冻成冰雕 3 秒;和平盾免疫。被大锤敲一下会高速滑出去撞飞一排怪物。' },
    enemyEffect: { flag: TOY_STATE_FLAG.FROZEN, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '怪物冻成冰雕 3 秒,可被 222 大锤当保龄球推出连撞。' },
  },
  {
    id: 234, name: '', trigger: TOY_TRIGGER.PLACE, radius: 1.0, impulse: 12, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 3, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '丢在奔跑的队友面前把他弹进水沟;也能自己踩上去跳上高台。' },
    enemyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 3, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '把冲锋野猪弹飞 3 格打断其冲锋。' },
  },
  {
    id: 235, name: '', trigger: TOY_TRIGGER.PLACE, radius: 2.0, impulse: 8, stunSec: 1.0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 3, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '贪心的朋友打开时直接被弹簧拳套揍飞 3 格。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 3, allyDamage: 0, enemyDamage: 60, rescueWindow: false, note: '对偷东西的哥布林与发条伪装宝箱造成反制击飞。' },
  },
  {
    id: 236, name: '', trigger: TOY_TRIGGER.PLACE, radius: 1.5, impulse: 6, stunSec: 0, morphSec: 2,
    allyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 1, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '朋友一坐上去发出响亮「噗」声并被彩虹烟雾弹射到半空。' },
    enemyEffect: { flag: TOY_STATE_FLAG.BLINDED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '烟雾使怪物短暂失去锁定能力。' },
  },
  {
    id: 237, name: '', trigger: TOY_TRIGGER.THROW, radius: 1.0, impulse: 0, stunSec: 0, morphSec: 3,
    allyEffect: { flag: TOY_STATE_FLAG.BLINDED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '涂色对战道具,糊住队友视线 3 秒,同时给地砖上色计分。' },
    enemyEffect: { flag: TOY_STATE_FLAG.BLINDED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '砸中 Boss 眼睛可糊住其视线,使其攻击偏离方向。' },
  },
  {
    id: 238, name: '', trigger: TOY_TRIGGER.USE, radius: 4.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 4, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '助跑撑杆越过 4 格宽的河流或 Boss 激光网。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '纯位移道具,对怪物无效果。' },
  },
  {
    id: 239, name: '', trigger: TOY_TRIGGER.WORN, radius: 0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.FLOATING, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '连按跳跃键慢速飞越深渊或躲避地面岩浆喷发。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果。' },
  },
  {
    id: 240, name: '', trigger: TOY_TRIGGER.THROW, radius: 6.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '刮到队友只会滑稽地旋转一下,不掉血。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 20, rescueWindow: false, note: '同时刮中直线上多只怪物吸引仇恨并飞回手中。' },
  },
  {
    id: 241, name: '', trigger: TOY_TRIGGER.USE, radius: 3.0, impulse: 10, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.GLUED, moveTiles: 1, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '好友间拔河比赛,输的一方被拽倒 1 格。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '多人狩猎时套住巨型 Boss 脚踝将其拉倒在地。' },
  },
  {
    id: 242, name: '', trigger: TOY_TRIGGER.PLAY, radius: 8.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '发出环形声波震醒打瞌睡的队友(清除 AFK_SHIELD)。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '强制吸引周围 8 格内怪物仇恨,保护脆皮队友。' },
  },
  {
    id: 243, name: '', trigger: TOY_TRIGGER.WORN, radius: 3.0, impulse: 0, stunSec: 1.5, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '雷雨天会把自己也电成爆炸头并麻痹 1.5 秒。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 0, allyDamage: 0, enemyDamage: 90, rescueWindow: false, note: '吸引闪电劈下,对周围 3 格内怪物造成感电麻痹与伤害。' },
  },
  {
    id: 244, name: '', trigger: TOY_TRIGGER.WORN, radius: 0, impulse: 0, stunSec: 0, morphSec: 20,
    allyEffect: { flag: TOY_STATE_FLAG.CAMOUFLAGED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '套上后野生怪物不会主动攻击你,可悄悄摸到 Boss 身后放炸弹。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '伪装对 Boss 无效,Boss 仍会锁定你。' },
  },
  {
    id: 245, name: '', trigger: TOY_TRIGGER.PLAY, radius: 4.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.BLINDED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '发射绚丽烟花,糊花队友视线但绝不造成伤害。' },
    enemyEffect: { flag: TOY_STATE_FLAG.BLINDED, moveTiles: 0, allyDamage: 0, enemyDamage: 35, rescueWindow: false, note: '吓退夜晚怕光的暗影小怪。' },
  },
  {
    id: 246, name: '', trigger: TOY_TRIGGER.PLAY, radius: 6.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '为周围 6 格内队友提供每秒 +5 HP 的持续恢复光环。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果。' },
  },
  {
    id: 247, name: '', trigger: TOY_TRIGGER.PLAY, radius: 6.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '周围队友采集效率与技能冷却缩减 +20%。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果。' },
  },
  {
    id: 248, name: '', trigger: TOY_TRIGGER.PLAY, radius: 6.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '为周围队友附加夜间照明与魔法抗性护盾。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果。' },
  },
  {
    id: 249, name: '', trigger: TOY_TRIGGER.PLAY, radius: 5.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '周围队友移动速度与攻击速度同步 +25%。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果。' },
  },
  {
    id: 250, name: '', trigger: TOY_TRIGGER.PLAY, radius: 4.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '安抚狂暴的野生动物,使其进入可喂食驯化状态。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '安抚而非伤害,是零暴力驯养路径。' },
  },
  {
    id: 251, name: '', trigger: TOY_TRIGGER.PLAY, radius: 8.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '为全队提升 15% 暴击率。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '音波震散妖狐 Boss 的幻影分身。' },
  },
  {
    id: 252, name: '', trigger: TOY_TRIGGER.PLAY, radius: 7.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '低音环绕队友,无负面效果。' },
    enemyEffect: { flag: TOY_STATE_FLAG.GLUED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '低沉音波让周围敌对怪物的移动与攻击速度降低 30%。' },
  },
  {
    id: 253, name: '', trigger: TOY_TRIGGER.PLAY, radius: 24.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '在小地图上向全房队友发送高亮集结信号。' },
    enemyEffect: { flag: TOY_STATE_FLAG.STUNNED, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '干扰音波蝠声呐使其坠地(对应 WS-04 生物机制)。' },
  },
  {
    id: 254, name: '', trigger: TOY_TRIGGER.PLAY, radius: 7.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '队友普通攻击附带连锁小闪电特效。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 25, rescueWindow: false, note: '连锁闪电追加少量魔法伤害。' },
  },
  {
    id: 255, name: '', trigger: TOY_TRIGGER.PLAY, radius: 32.0, impulse: 0, stunSec: 0, morphSec: 0,
    allyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '吹响后立即在当前位置召集全房玩家开启造桥跑酷或抢皇冠小游戏。' },
    enemyEffect: { flag: TOY_STATE_FLAG.NONE, moveTiles: 0, allyDamage: 0, enemyDamage: 0, rescueWindow: false, note: '对怪物无效果,属纯社交 / 竞技道具。' },
  },
];

/** 名称从冻结层事实源回填,杜绝两处字符串漂移。 */
export const PRANK_TOYS: readonly PrankToyDef[] = TOY_ROWS.map((row) => {
  const def = ITEM_BY_ID.get(row.id);
  if (!def) throw new Error(`整蛊玩具表引用了不存在的物品 ID ${row.id}`);
  return { ...row, name: def.name };
});

export const PRANK_TOY_BY_ID: ReadonlyMap<number, PrankToyDef> = new Map(PRANK_TOYS.map((t) => [t.id, t]));

export function toyOf(id: number): PrankToyDef {
  const t = PRANK_TOY_BY_ID.get(id);
  if (!t) throw new Error(`未收录的整蛊玩具 ${id}`);
  return t;
}

/** 表内全部 ID(升序)。 */
export function toyIds(): number[] {
  return PRANK_TOYS.map((t) => t.id);
}

/** ID 集合自检:必须与 [221..255] 完全一致(连续 35 个)。 */
export function assertToyIdSetClosed(toys: readonly PrankToyDef[] = PRANK_TOYS): void {
  const ids = toys.map((t) => t.id);
  if (ids.length !== PRANK_TOY_COUNT) throw new Error(`整蛊玩具数量 ${ids.length} 不等于 ${PRANK_TOY_COUNT}`);
  if (new Set(ids).size !== ids.length) throw new Error('整蛊玩具 ID 存在重复');
  const expect = new Set<number>();
  for (let i = PRANK_TOY_ID_MIN; i <= PRANK_TOY_ID_MAX; i += 1) expect.add(i);
  for (const id of ids) {
    if (!expect.delete(id)) throw new Error(`整蛊玩具 ID ${id} 越界或重复`);
  }
  if (expect.size > 0) throw new Error(`整蛊玩具缺失 ID:${[...expect].join(',')}`);
}

/** 队友侧零伤害不变量。 */
export function assertAllyZeroDamage(toys: readonly PrankToyDef[] = PRANK_TOYS): void {
  const bad = toys.filter((t) => t.allyEffect.allyDamage !== 0).map((t) => t.id);
  if (bad.length > 0) throw new Error(`整蛊玩具对队友产生了伤害:${bad.join(',')}`);
}

/** 字段完整性不变量:radius / impulse / 时长必须是非负有限数。 */
export function assertToyFieldsSane(toys: readonly PrankToyDef[] = PRANK_TOYS): void {
  for (const t of toys) {
    for (const [k, v] of [
      ['radius', t.radius], ['impulse', t.impulse], ['stunSec', t.stunSec], ['morphSec', t.morphSec],
    ] as [string, number][]) {
      if (!Number.isFinite(v) || v < 0) throw new Error(`整蛊玩具 #${t.id} 的 ${k} 非法:${v}`);
    }
    if (!t.name) throw new Error(`整蛊玩具 #${t.id} 缺名称`);
    if (!t.allyEffect.note || !t.enemyEffect.note) throw new Error(`整蛊玩具 #${t.id} 缺效果说明`);
  }
}

/* ══════════════════ 具体物理喜剧事件 ══════════════════ */

/** 225 香蕉皮:滑行 5 格后撞墙眩晕。 */
export const BANANA_SLIDE_TILES = 5;
export const BANANA_SLIDE_STUN_SEC = 1.2;
/** 极滑摩擦系数(与 610 滑冰奶昔 μ=0.96 同档)。 */
export const BANANA_MU = 0.96;

export interface BananaSlideResult {
  slidTiles: number;
  hitWall: boolean;
  stunnedSec: number;
}

/**
 * 香蕉皮打滑解算:无论摩擦多小,位移上限固定 5 格(手册原句);
 * 若可滑距离 < 5 格,则中途撞墙并以 STUNNED 收尾。
 * @param freeRunTiles 从落点到最近墙面的可用距离(格)
 */
export function resolveBananaSlide(freeRunTiles: number): BananaSlideResult {
  const free = Math.max(0, freeRunTiles);
  const slid = Math.min(BANANA_SLIDE_TILES, free);
  /* 墙面落在 5 格滑程之内(含正好 5 格)⇒ 滑满后撞墙,以眩晕收尾。 */
  const hitWall = free <= BANANA_SLIDE_TILES;
  return { slidTiles: slid, hitWall, stunnedSec: hitWall ? BANANA_SLIDE_STUN_SEC : 0 };
}

/** 227 泡泡连发水枪:连射 3 发把目标装进大泡泡。 */
export const BUBBLE_HITS_TO_TRAP = 3;
export const BUBBLE_DRIFT_SEC = 6;
/** 泡泡三连上限:同一目标最多被连续困 3 次。 */
export const BUBBLE_STACK_LIMIT = 3;

export interface BubbleRuntime {
  targetId: string;
  hits: number;
  trapped: boolean;
  /** 已被困次数(三连计数) */
  chain: number;
  driftSec: number;
}

export function createBubble(targetId: string): BubbleRuntime {
  return { targetId, hits: 0, trapped: false, chain: 0, driftSec: 0 };
}

export interface BubbleHitResult {
  hits: number;
  trapped: boolean;
  chain: number;
  driftSec: number;
  note: string;
}

/** 命中一发泡泡;第 3 发装进大泡泡。已困时再命中只延长漂浮时间。 */
export function hitBubble(b: BubbleRuntime): BubbleHitResult {
  if (b.trapped) {
    b.driftSec += BUBBLE_DRIFT_SEC;
    return { hits: b.hits, trapped: true, chain: b.chain, driftSec: b.driftSec, note: '已被困,延长漂浮' };
  }
  b.hits += 1;
  if (b.hits >= BUBBLE_HITS_TO_TRAP) {
    b.trapped = true;
    b.driftSec = BUBBLE_DRIFT_SEC;
    b.chain += 1;
    b.hits = 0;
    return { hits: BUBBLE_HITS_TO_TRAP, trapped: true, chain: b.chain, driftSec: b.driftSec, note: '装入大泡泡随风乱飘' };
  }
  return { hits: b.hits, trapped: false, chain: b.chain, driftSec: b.driftSec, note: `泡泡命中 ${b.hits}/${BUBBLE_HITS_TO_TRAP}` };
}

/** 233 雪球:冰冻 3 秒。 */
export const SNOWBALL_FREEZE_SEC = 3;

export interface SnowballResult {
  frozenSec: number;
  /** 是否可被 222 大锤推出当保龄球 */
  slidOnHammer: boolean;
}

export function resolveSnowball(targetIsMonster: boolean): SnowballResult {
  return { frozenSec: SNOWBALL_FREEZE_SEC, slidOnHammer: targetIsMonster };
}

/** 228 炸弹果。 */
export const BOMB_FUSE_SEC = 3;
export const BOMB_ENEMY_DAMAGE = 120;

/** 230 / 231 药水倍率。 */
export const SHRINK_SCALE = 0.3;
export const GIANT_SCALE = 2.0;

/** 232 蜂蜜滩减速比例。 */
export const HONEY_SLOW_RATIO = 0.7;

/** 241 拔河拉力上限(格/秒)。 */
export const TUG_IMPULSE = 10;

/** 218 和平盾物品 ID(免疫裁定见 `prank/immunity.ts`)。 */
export const SAFE_SHIELD_ITEM_ID = 218;

/* ══════════════════ 自伤(self-inflicted)独立结算路径 ══════════════════
 *
 * 语义边界(Lead 裁决 U10):
 *   和平盾的语义是「免疫**队友**施加的物理整蛊」,自伤不属于此列。
 *   因此自伤**不走** `resolveShield`,和平盾开与关都不影响自伤结果。
 *
 * 但自伤必须带两层「不自锁」保护,避免玩家用道具把自己逼进死角:
 *   ① HP 硬顶:自伤后的 HP 不得低于 max(1, SELF_DAMAGE_HP_FLOOR_RATIO × maxHp);
 *   ② 永不触发幽灵泡泡倒地:自伤不会把玩家送进待救援状态。
 */

/** 自伤后 HP 相对 maxHp 的下限比例。 */
export const SELF_DAMAGE_HP_FLOOR_RATIO = 0.15;

/** 243 引雷铁锅头盔:自伤感电麻痹时长(秒)。 */
export const HELMET_SELF_PARALYZE_SEC = 1.5;
/** 243 引雷铁锅头盔:自伤掉血数值(与对怪物 90 点伤害区分)。 */
export const HELMET_SELF_DAMAGE = 45;

/** 自伤 HP 硬顶:`max(1, ceil(0.15 × maxHp))`。 */
export function selfDamageHpFloor(maxHp: number): number {
  const hp = Number.isFinite(maxHp) && maxHp > 0 ? maxHp : 1;
  return Math.max(1, Math.ceil(SELF_DAMAGE_HP_FLOOR_RATIO * hp));
}

/** 玩家在自伤路径下的最小战斗状态(见 `shared/types/physics.ts` 的 7 态)。 */
export const SELF_DAMAGE_STATE = {
  /** 自伤只允许打到 STUNNED(感电麻痹) */
  STUNNED: 'STUNNED',
  /** 禁止到达的待救援态 */
  GHOST_BUBBLE: 'GHOST_BUBBLE',
} as const;

export interface SelfDamageOutcome {
  /** 自伤后的 HP */
  hp: number;
  /** 实际扣除的 HP */
  dealt: number;
  /** 是否被 HP 硬顶截断 */
  clamped: boolean;
  /** 自伤后状态:只可能是 STUNNED,绝不 GHOST_BUBBLE */
  state: string;
  /** 感电麻痹秒数 */
  paralyzedSec: number;
  /** 是否触发幽灵泡泡倒地:自伤路径恒为 false */
  ghostBubble: boolean;
  /** 是否被和平盾拦截:自伤路径恒为 false */
  shielded: boolean;
}

/**
 * 自伤结算(独立于和平盾)。
 *
 * **不接收 `shieldOn` 参数**——签名本身就是「自伤不受和平盾影响」的契约。
 * 队友施加的整蛊载荷请走 `immunity.resolveShield(..., 'ALLY')`。
 *
 * HP 下限语义:`selfDamageHpFloor(maxHp)` 是一道**地板**,不是治疗。
 *   - 自伤后 HP 不会低于地板;
 *   - 但若玩家本来就已经在地板以下(例如被 Boss 打到残血),自伤既不继续扣、
 *     也不会把他「治」回地板 —— 只锁在原值。避免「被自己电一下反而回血」的荒谬。
 *
 * @param hp 当前 HP
 * @param maxHp 最大 HP(用于 HP 硬顶)
 * @param rawDamage 原始自伤数值
 */
export function applySelfDamage(hp: number, maxHp: number, rawDamage: number): SelfDamageOutcome {
  const floor = selfDamageHpFloor(maxHp);
  const cur = Math.max(0, hp);
  const raw = Math.max(0, rawDamage);
  const afterRaw = cur - raw;
  const clamped = afterRaw < floor;
  /* 地板与「不回血」取交集:min(cur, floor) 是当前允许的最低落点 */
  const next = clamped ? Math.min(cur, floor) : afterRaw;
  return {
    hp: next,
    dealt: cur - next,
    clamped,
    /* 自伤只产生感电麻痹,永不到 GHOST_BUBBLE */
    state: SELF_DAMAGE_STATE.STUNNED,
    paralyzedSec: HELMET_SELF_PARALYZE_SEC,
    ghostBubble: false,
    shielded: false,
  };
}

/**
 * 243 引雷铁锅头盔:雷雨天被自己吸引的闪电命中。
 *
 * 自伤 + 1.5 秒感电麻痹;HP 硬顶 15%;绝不触发幽灵泡泡;
 * 和平盾开与关结果完全一致(不读取任何盾状态)。
 */
export function resolveHelmetSelfStrike(hp: number, maxHp: number): SelfDamageOutcome {
  return applySelfDamage(hp, maxHp, HELMET_SELF_DAMAGE);
}

assertToyIdSetClosed();
assertAllyZeroDamage();
assertToyFieldsSane();