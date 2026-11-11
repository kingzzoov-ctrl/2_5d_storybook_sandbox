/**
 * 冻结层:八大群系 24 种野生动物生态表(设计手册 §4.2 逐行落地)。
 *
 * 生物 ID 与手册完全一致(`mob_*`),掉落物 ID 引用 `shared/constants/items.ts`。
 */

import { Biome, MobBehavior, type MobDef } from '../types/entities.ts';

export type { MobDef };

const M = Biome.MEADOW, V = Biome.VALLEY, S = Biome.SAKURA, C = Biome.CAVERN;
const O = Biome.OASIS, D = Biome.DESSERT, K = Biome.SKYSEA, R = Biome.RUINS;

export const MOB_LIST: readonly MobDef[] = [
  /* ── 1. 晨曦草甸 ── */
  {
    id: 'mob_sheep', name: '云朵绵羊', biome: M, behavior: MobBehavior.TAMEABLE,
    level: 1, hp: 60, exp: 15, tameItem: 123,
    drops: { 119: 2, 701: 1 },
    note: '成群吃草,受惊会像棉花糖一样弹跳逃跑;喂黄金小麦可驯化领回牧场(驯养每日可剪毛)。',
  },
  {
    id: 'mob_slime_green', name: '甜莓果冻怪', biome: M, behavior: MobBehavior.MISCHIEVOUS,
    level: 2, hp: 90, exp: 25,
    drops: { 162: 1, 121: 1 },
    note: '看到地上有甜莓会优先跑去吃果子变大;跳跃扑击玩家。',
  },
  {
    id: 'mob_boar', name: '冲锋森林野猪', biome: M, behavior: MobBehavior.HOSTILE,
    level: 4, hp: 180, exp: 45,
    drops: { 701: 2, 702: 2 },
    note: '发现玩家后原地刨蹄蓄力 1 秒,随后沿直线高速冲锋 6 格;引它撞墙或踩香蕉皮会自己撞晕 3 秒。',
  },

  /* ── 2. 金秋河谷 ── */
  {
    id: 'mob_squirrel', name: '大尾花栗鼠', biome: V, behavior: MobBehavior.TAMEABLE,
    level: 2, hp: 50, exp: 20, tameItem: 121,
    drops: { 101: 1 },
    note: '在果树间窜动并往树洞藏松果;喂露水甜莓可驯化为帮玩家自动捡果子的小跟班。',
  },
  {
    id: 'mob_beaver', name: '淘气造坝河狸', biome: V, behavior: MobBehavior.MISCHIEVOUS,
    level: 5, hp: 220, exp: 55,
    drops: { 703: 2, 151: 3 },
    note: '会偷偷抱走地上散落的木板去河道筑坝;用充气大锤敲晕它可夺回木头并获赠图纸。',
  },
  {
    id: 'mob_crab_river', name: '铁钳河蟹', biome: V, behavior: MobBehavior.HOSTILE,
    level: 6, hp: 260, exp: 65,
    drops: { 701: 1, 112: 1 },
    note: '横向快速移动并用大钳子夹人;被丢进八人欢聚大汤锅会直接变成美味海鲜汤食材。',
  },

  /* ── 3. 绯樱高地 ── */
  {
    id: 'mob_capybara', name: '温泉卡皮巴拉', biome: S, behavior: MobBehavior.PASSIVE_UNKILLABLE,
    level: 5, hp: 300, exp: 0, tameItem: 122,
    drops: { 109: 1 },
    note: '情绪极其稳定,头顶橘子泡在温泉里一动不动(哪怕旁边在打架也不慌);在它身边泡澡回血速度翻倍。不可击杀(攻击它会反弹爱心);喂蜜桃赠温泉石。',
  },
  {
    id: 'mob_tanuki', name: '幻叶小狸猫', biome: S, behavior: MobBehavior.MISCHIEVOUS,
    level: 8, hp: 320, exp: 85,
    drops: { 102: 1, 127: 1 },
    note: '顶着树叶伪装成普通石灯笼或宝箱,玩家靠近时突然跳出来扔迷雾果再嬉笑着逃跑。',
  },
  {
    id: 'mob_samurai_bamboo', name: '竹林剑客傀儡', biome: S, behavior: MobBehavior.HOSTILE,
    level: 10, hp: 450, exp: 110,
    drops: { 103: 4, 715: 1 },
    note: '手持青竹刀格挡正面攻击,需两名玩家一前一后夹击,或用火椒箭点燃它身上的干竹叶。',
  },

  /* ── 4. 萤光溶洞 ── */
  {
    id: 'mob_glow_frog', name: '提灯萤火蛙', biome: C, behavior: MobBehavior.TAMEABLE,
    level: 8, hp: 150, exp: 60, tameItem: 121,
    drops: { 116: 1, 124: 1 },
    note: '背部散发蓝紫微光,吐长舌头捕食洞穴飞虫;驯化后带在身边可当移动照明灯。',
  },
  {
    id: 'mob_bat_sonic', name: '萤光音波蝠', biome: C, behavior: MobBehavior.HOSTILE,
    level: 11, hp: 380, exp: 125,
    drops: { 709: 1, 113: 1 },
    note: '倒挂在洞顶,玩家经过时俯冲发射环形音波圈;敲响三角铁或音符砖可干扰其声呐使其坠地。',
  },
  {
    id: 'mob_beetle_crystal', name: '紫晶重甲虫', biome: C, behavior: MobBehavior.HOSTILE_ELITE,
    level: 14, hp: 750, exp: 200,
    drops: { 116: 3, 114: 2 },
    note: '正面甲壳免疫 80% 普通刀剑与弓箭伤害;需用爆破冲击镐敲击、或用弹簧垫把它掀翻露出肚皮暴打。',
  },

  /* ── 5. 星沙绿洲 ── */
  {
    id: 'mob_chocobo', name: '彩虹陆行鸟', biome: O, behavior: MobBehavior.MOUNT,
    level: 10, hp: 400, exp: 90, tameItem: 123,
    drops: { 119: 1 },
    note: '在沙洲极速奔跑;先用粘性蜂蜜罐粘住它的脚,再喂 3 个黄金小麦即可驯服为高速双人坐骑(掉落蓬松彩羽)。',
  },
  {
    id: 'mob_pangolin', name: '滚石穿山甲', biome: O, behavior: MobBehavior.MISCHIEVOUS,
    level: 13, hp: 600, exp: 180, tameItem: 743,
    drops: { 702: 3, 115: 1 },
    note: '缩成坚硬圆石球向玩家高速滚动撞击;看准时机挥动充气玩具大锤可把它像棒球一样反抽回去撞墙眩晕。',
  },
  {
    id: 'mob_scorpion', name: '黄金毒尾蝎', biome: O, behavior: MobBehavior.HOSTILE,
    level: 15, hp: 680, exp: 210,
    drops: { 701: 1, 108: 4 },
    note: '潜伏在沙丘下突然钻出并用尾针发射毒液球;引水淹没沙地可逼其现形。',
  },

  /* ── 6. 甜点奇境 ── */
  {
    id: 'mob_ginger_imp', name: '逃跑姜饼小人', biome: D, behavior: MobBehavior.TREASURE_TRICKSTER,
    level: 12, hp: 250, exp: 250,
    drops: { 128: 3, 130: 2 },
    note: '边跑边喊“你抓不到我”,掉满地糖果;10 秒内没抓到就会钻进糖果屋消失(需队友用飞索钩爪钩回来)。',
  },
  {
    id: 'mob_pudding_mage', name: '焦糖布丁法师', biome: D, behavior: MobBehavior.HOSTILE,
    level: 16, hp: 720, exp: 230,
    drops: { 162: 3, 105: 1 },
    note: '远程发射粘性焦糖球困住玩家,并为周围果冻怪加血。',
  },
  {
    id: 'mob_choco_golem', name: '巧克力盾卫', biome: D, behavior: MobBehavior.HOSTILE_ELITE,
    level: 18, hp: 1100, exp: 320,
    drops: { 105: 5, 603: 1 },
    note: '体型巨大的巧克力魔像;若玩家用火椒或火把攻击它,它的巧克力护甲会融化变成满地加速巧克力浆(稀有甜点食谱)。',
  },

  /* ── 7. 浮空云海 ── */
  {
    id: 'mob_sky_manta', name: '浮空云魔鬼鱼', biome: K, behavior: MobBehavior.MOUNT,
    level: 15, hp: 500, exp: 150,
    drops: { 119: 4 },
    note: '在两座云岛之间的虚空上方缓慢滑翔,玩家可直接跳到它宽大的背上搭顺风车跨岛。',
  },
  {
    id: 'mob_harpy_harp', name: '竖琴风精鸟', biome: K, behavior: MobBehavior.MISCHIEVOUS,
    level: 19, hp: 850, exp: 350,
    drops: { 117: 1, 129: 1 },
    note: '会吹起狂风把靠近悬崖边的玩家吹落云海;若玩家拿出乐器跟它对弹合奏,它会害羞地送出星辰碎片。',
  },
  {
    id: 'mob_thunder_sprite', name: '雷云闪电球', biome: K, behavior: MobBehavior.HOSTILE,
    level: 21, hp: 950, exp: 400,
    drops: { 117: 2, 159: 5 },
    note: '在空中放电链接周围金属物体;穿戴引雷铁锅头盔的队友可吸收其闪电转化为自身攻速。',
  },

  /* ── 8. 发条遗迹 ── */
  {
    id: 'mob_mimic_cog', name: '发条伪装宝箱', biome: R, behavior: MobBehavior.TREASURE_TRICKSTER,
    level: 20, hp: 900, exp: 450,
    drops: { 158: 6, 115: 3 },
    note: '混在遗迹真宝箱里,打开时亮出齿轮尖牙追着玩家咬;喂它吃定时痒痒炸弹果可直接炸开肚子爆金装。',
  },
  {
    id: 'mob_lava_elem', name: '熔炉赤焰火灵', biome: R, behavior: MobBehavior.HOSTILE,
    level: 23, hp: 1200, exp: 500,
    drops: { 710: 2, 110: 3 },
    note: '全身烈火,走过的草地全部变焦炭;队友用泡泡连发水枪或引水浇它可直接秒杀其护盾并固化为黑曜石。',
  },
  {
    id: 'mob_clock_knight', name: '远古发条重骑', biome: R, behavior: MobBehavior.HOSTILE_ELITE,
    level: 25, hp: 1800, exp: 700,
    drops: { 114: 4, 158: 8 },
    note: '背后有一把旋转的金色发条钥匙;正面极难击败,需 1 人正面吸引,队友用飞索钩爪勾住它背后的钥匙强行拔下使其断电瘫痪。',
  },
];

export const MOB_BY_ID: ReadonlyMap<string, MobDef> = new Map(MOB_LIST.map((m) => [m.id, m]));

export const TOTAL_MOB_COUNT = 24;

/** 群系 -> 生物清单,供生态刷新器与 AOI 管理器使用。 */
export function mobsByBiome(b: Biome): MobDef[] {
  return MOB_LIST.filter((m) => m.biome === b);
}

/** 可驯养生物(温顺/坐骑)。 */
export function tameableMobs(): MobDef[] {
  return MOB_LIST.filter((m) => m.tameItem !== undefined);
}

/** 需要在 AOI 唤醒时进入 FSM 的敌对单位。 */
export function hostileMobs(): MobDef[] {
  return MOB_LIST.filter(
    (m) => m.behavior === MobBehavior.HOSTILE || m.behavior === MobBehavior.HOSTILE_ELITE,
  );
}
