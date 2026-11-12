/**
 * 冻结层:八大群系野生世界 Boss 挑战机制表(设计手册 §4.3 逐行落地)。
 *
 * 血量缩放 HP(N) = HP_base × (1 + 0.65(N-1)) 见 `shared/types/entities.ts#bossScaledHp`。
 */

import { Biome, type BossDef } from '../types/entities.ts';

export type { BossDef };

export const BOSS_LIST: readonly BossDef[] = [
  {
    id: 'boss_jelly_king',
    name: '果冻国王·波波大帝',
    biome: Biome.MEADOW,
    level: 5,
    baseHp: 2500,
    summonItem: 734,
    exp: 800,
    loot: [704, 719, 727],
    phases: [
      { hpThreshold: 1.0, name: 'P1 环形果冻波', telegraph: '以自身为中心的红色圆环(半径 3.5 格,持续 0.8s)', skill: '高高跃起后落地产生向外扩散的环形果冻波,击退并减速。' },
      { hpThreshold: 0.5, name: 'P2 六分裂', telegraph: '6 只中型果冻的独立红色小圆(半径 1.2 格)', skill: '分裂成 6 只中型果冻四散逃跑,10 秒内未清完则合体回血。' },
      { hpThreshold: 0.25, name: 'P3 巨口吸气', telegraph: '从王座指向玩家的橙色锥形吸附区(45°,长度 6 格,持续 1.5s)', skill: '原地张开巨口强力吸气,试图把玩家吸进肚子里吐泡泡。' },
    ],
    breakMechanic: '【投弹喂食破防】P3 吸气时点燃一颗定时痒痒炸弹果(或抱起荆棘地垫)顺着吸力扔进它嘴里,直接把它炸翻肚皮朝天眩晕 6 秒,全队暴击输出。',
  },
  {
    id: 'boss_beaver_mecha',
    name: '机甲河狸·大坝粉碎者',
    biome: Biome.VALLEY,
    level: 10,
    baseHp: 4800,
    summonItem: 735,
    exp: 1600,
    /* ⚠️ CR-16:`loot` 保持字节级不变(它被 contentFingerprints 的 bosses 分区哈希)。
       手册 L496 的战利品列是「703 河狸钢牙×10 + 自动伐木机甲宠物图纸」:
        · 数量 10 → `lootQty`(缺省 1,故必须显式给,且与 loot 等长);
        · 「自动伐木机甲宠物图纸」→ 320 表内 0 命中,登记为 `lootAbstract`;
        · `437 叮当蒸汽小火车头` → 手册 L313 是**可造载具**,不是战利品 ⇒ 记 `lootDeviations`,
          由 rollPersonalLoot 在生产掉落里过滤掉(不删 loot,删了会动指纹)。 */
    loot: [703, 437],
    lootQty: [10, 1],
    lootAbstract: ['自动伐木机甲宠物图纸'],
    lootDeviations: [
      { itemId: 437, reason: '手册 L496 战利品列为「703×10 + 自动伐木机甲宠物图纸」;437 在 L313 是可造载具(寒铁金属锭×6+黄铜金属锭×4),非战利品' },
    ],
    phases: [
      { hpThreshold: 1.0, name: 'P1 锯木机甲冲撞', telegraph: '横贯战场的窄长红色矩形(宽 2 格,长度 12 格)', skill: '驾驶木质锯木机甲横冲直撞,沿途发射旋转圆木滚筒。' },
      { hpThreshold: 0.5, name: 'P2 筑坝龟缩', telegraph: '战场中央 5×3 的灰色木坝掩体区', skill: '在战场中央快速搭建坚固木坝,自己躲在坝后发射松果迫击炮。' },
    ],
    breakMechanic: '【开闸放水冲坝】提前在河道上游修好引水渠与电动升降拦水闸门,拉下拉杆放洪水倾泻而下,瞬间冲垮木坝并让机甲河狸短路漏电瘫痪。',
  },
  {
    id: 'boss_fox_kitsune',
    name: '千年垂枝妖狐·绯月',
    biome: Biome.SAKURA,
    level: 14,
    baseHp: 7500,
    summonItem: 736,
    exp: 2800,
    loot: [705, 720],
    phases: [
      { hpThreshold: 1.0, name: 'P1 樱花风刃', telegraph: '三道弧形红色扇形风刃(每道 30°,长 8 格)', skill: '扇出三道弧形樱花风刃,并在地面留下迷魂花阵。' },
      { hpThreshold: 0.6, name: 'P2 四分身蓄力', telegraph: '4 个分身各自的紫色蓄力圈(半径 2 格),真身耳朵会随音乐抖动', skill: '化作 4 道一模一样的妖狐分身环绕战场蓄力全屏大招。' },
    ],
    breakMechanic: '【乐团奏乐破隐】吹响黄金凯旋小号(或敲响八音盒音符砖电路),声波直接震碎所有假分身并让真身陷入陶醉定身状态。',
  },
  {
    id: 'boss_crab_kraken',
    name: '深渊晶甲巨蟹·克拉肯',
    biome: Biome.CAVERN,
    level: 18,
    baseHp: 11000,
    summonItem: 737,
    exp: 4200,
    loot: [706, 721, 728],
    phases: [
      { hpThreshold: 1.0, name: 'P1 双钳激光', telegraph: '从钳口发出的两条细长红色射线(宽 0.8 格,长 10 格)', skill: '挥舞双钳发射激光束,全身紫晶壳减免 90% 伤害。' },
      { hpThreshold: 0.45, name: 'P2 壳内弹射', telegraph: '高速移动的红色圆形碰撞预警(半径 1.2 格,拖尾)', skill: '缩进壳里在场内高速弹射横冲直撞。' },
    ],
    breakMechanic: '【冰面溜蟹 + 黑曜石撞墙】提前在祭坛周围铺一圈镜面极滑冰砖,尽头砌黑曜石防爆城墙;巨蟹冲上冰面失控打滑,高速撞墙震碎自己的紫晶外壳。',
  },
  {
    id: 'boss_scorpion_pharaoh',
    name: '黄金沙暴法老蝎',
    biome: Biome.OASIS,
    level: 21,
    baseHp: 15000,
    summonItem: 738,
    exp: 6000,
    loot: [707, 722],
    phases: [
      { hpThreshold: 1.0, name: 'P1 流沙漩涡', telegraph: '以自身为中心的橙色向心箭头区(半径 5 格,持续 2s)', skill: '召唤流沙漩涡将全员拉向中心,尾针连续戳刺。' },
      { hpThreshold: 0.5, name: 'P2 沙下潜行', telegraph: '沙面上游走的细长凸起(仅露出毒尾,无大红圈)', skill: '钻入地下仅露出一截黄金毒尾在场内快速游走偷袭。' },
    ],
    breakMechanic: '【多人拔河拽出沙面】2~4 名玩家同时抛出灵巧飞索钩爪(或双向拔河大麻绳)勾住黄金尾针合力往后拉,把它从沙地里硬生生拔出来摔个四脚朝天。',
  },
  {
    id: 'boss_ginger_troll',
    name: '暴食翻糖姜饼巨魔',
    biome: Biome.DESSERT,
    level: 24,
    baseHp: 20000,
    summonItem: 739,
    exp: 8500,
    /*
     * loot 原为 [739, 609] —— **它掉自己的祭品**,构成经济闭环:
     * 打死 → 得 739 → 再造祭品 → 再召唤,成本归零(且每次白送一件 609)。
     * 这是 8 个 Boss 里唯一的自反馈。已修,见 docs/CHANGE_REQUESTS.md CR-15。
     *
     * 替换件 613(庆典三层奶油蛋糕,V=260,tags['料理','宴会','经验','团队'])
     * 取甜点系且高价值,契合手册 L500 说的「皇家甜点主题」;
     * 手册原文的两件(城堡图纸、姜饼人随从)在 320 项表内不存在,
     * 按「抽象奖励」处理、不塞进物品表(否则破坏 320 件的内容锁)。
     */
    loot: [609, 613],
    /* CR-16:手册 L500 的战利品列是「皇家甜点主题全套城堡图纸与姜饼人随从」——
       两件在 320 表内均 0 命中 ⇒ 登记为 `lootAbstract`(CR-15 已判明它们不属物品表)。
       `609 庆典三层奶油蛋糕` 是 CR-15 给 739 自反馈换上的替代件,手册没写数量 ⇒ 1。 */
    lootQty: [1, 1],
    lootAbstract: ['皇家甜点主题全套城堡图纸', '姜饼人随从'],
    phases: [
      { hpThreshold: 1.0, name: 'P1 巧克力浆泼洒', telegraph: '大面积紫色减速沼泽预警区(半径 4 格)', skill: '泼洒大面积减速巧克力浆,投掷会滚动的巨型焦糖球。' },
      { hpThreshold: 0.5, name: 'P2 饥饿狂暴', telegraph: '指向手持食物玩家的橙色锁定圈(半径 1.5 格)', skill: '肚子饿了开始狂暴追咬手持食物的玩家。' },
    ],
    breakMechanic: '【果冻蹦床反弹 + 恶作剧料理投喂】铺设高弹果冻蹦床砖把它砸下来的巨型糖球反弹砸晕它自己;或用八人欢聚大汤锅煮一锅加了变身菇的黑暗料理喂它,让巨魔变成一只大肥鸡。',
  },
  {
    id: 'boss_sky_whale',
    name: '星穹幻彩云鲸',
    biome: Biome.SKYSEA,
    level: 27,
    baseHp: 26000,
    summonItem: 740,
    exp: 12000,
    /* ⚠️ CR-16:手册 L501 战利品列是「117 极光星辰碎片×15 + 718 极光星辰魔导师杖」。
       · 117 的数量 15 → `lootQty`;
       · `440 八人云海探险飞艇` → L316 是**可造载具**,L501 的破防手段写「全队**驾驶** 440
         飞艇贴近云鲸」—— 它是手段不是掉落 ⇒ 记 `lootDeviations` 并在生产掉落里过滤。 */
    loot: [117, 718, 440],
    lootQty: [15, 1, 1],
    lootDeviations: [
      { itemId: 440, reason: '手册 L501 战利品列为「117×15 + 718」;440 在 L316 是可造载具(秘银魔导锭×6+蓬松云朵布×10),L501 只把它当驾驶手段,非战利品' },
    ],
    phases: [
      { hpThreshold: 1.0, name: 'P1 云浪巡游', telegraph: '环绕浮空岛外围的宽环状云浪预警(环宽 3 格)', skill: '环绕浮空岛外围云海巡游,掀起云浪并降下追踪落雷。' },
      { hpThreshold: 0.55, name: 'P2 高空星河吐息', telegraph: '从 Z=2 高空指向地面的一条巨大红色扇形(60°,长 14 格)', skill: '飞升至高空 Z=2 蓄力星河吐息。' },
    ],
    breakMechanic: '【飞艇追击 + 叠罗汉登背敲晶核】全队驾驶八人云海探险飞艇贴近云鲸(或 4 人叠罗汉踩弹簧垫高高跃起)跳到背脊上,合力敲碎背上 3 颗寄生雷晶即可净化云鲸获赠星辰宝藏。',
  },
  {
    id: 'boss_chronos_colossus',
    name: '远古发条时间巨像·克洛诺斯',
    biome: Biome.RUINS,
    level: 30,
    baseHp: 38000,
    summonItem: 741,
    exp: 25000,
    /* ⚠️ CR-16:手册 L502 战利品列是「708 永动发条太阳核 + 723 克洛诺斯磁暴齿轮炮
       + 纯金通关纪念碑」。前两件 loot 已有;「纯金通关纪念碑」在 320 表内 0 命中
       ⇒ 登记为 `lootAbstract`(不塞物品表,否则破坏 320 件内容锁)。 */
    loot: [708, 723],
    lootQty: [1, 1],
    lootAbstract: ['纯金通关纪念碑'],
    phases: [
      { hpThreshold: 1.0, name: 'P1 时间激光指针', telegraph: '从中心顺时针旋转的细长红色指针(宽 1 格,长 12 格,角速度恒定)', skill: '发射 360° 顺时针旋转的时间激光指针。' },
      { hpThreshold: 0.65, name: 'P2 时间回溯护盾', telegraph: '四角红/蓝/黄/绿导电座的独立指示环 + 中央电磁脉冲塔', skill: '开启时间回溯护盾,8 秒内未切断供能则回血。' },
      { hpThreshold: 0.3, name: 'P3 地砖改写', telegraph: '全场地砖随机变为传送带与旋转推杆的预闪', skill: '全场地砖随机变为传送带与旋转推杆。' },
    ],
    breakMechanic: '【四色魔能电路联手破阵】战场四角各有 1 个红/蓝/黄/绿魔能导电座;P2 时分工用魔能机械臂或重物压住四角压力板并接通四色电线,将中央电磁脉冲塔通电激活,一举击穿时间护盾。',
  },
];

export const BOSS_BY_ID: ReadonlyMap<string, BossDef> = new Map(BOSS_LIST.map((b) => [b.id, b]));

export const TOTAL_BOSS_COUNT = 8;

/** 四大同屏竞技模式(设计手册 §6.3),供派对照料台与裁判哨台驱动。 */
export const PARTY_MODES = [
  { key: 'BRIDGE_CTF', name: '边建边坑·造桥夺旗赛', players: '2~12', buildSec: 15, raceSec: 30, note: '前 15 秒全员抽盲盒摆陷阱,后 30 秒冲刺过河夺旗。' },
  { key: 'JELLY_BALL', name: '4v4 果冻球大乱斗', players: '4~16', buildSec: 0, raceSec: 180, note: '铺满镜面极滑冰砖与高弹软包防撞墙的自建球场。' },
  { key: 'CROWN_BR', name: '金皇冠全镇大逃杀', players: '3~16', buildSec: 0, raceSec: 180, note: '抢夺唯一金皇冠,先积满 60 秒者获胜。' },
  { key: 'PAINT_WAR', name: '圈地涂色大作战', players: '2~12', buildSec: 0, raceSec: 120, note: '用染色枪与颜料水球涂地,限时 120 秒占地面积最多者胜。' },
] as const;

/** 动态房间识别配方(设计手册 §3.8 核心件标注)。 */
export const ROOM_RECIPES = [
  { key: 'FORGE_MASTER', name: '大师锻造房', required: [503, 504], optional: [155, 158], bonus: '解锁中高级武器护甲与魔能电路锻造。' },
  { key: 'COZY_CANTEEN', name: '欢聚大锅食堂', required: [506, 519], optional: [507, 508, 513], bonus: 'Boss 战前全团 +40% 攻击/生命上限大餐。' },
  { key: 'ART_GALLERY', name: '绘本艺术画廊', required: [505, 511], optional: [524, 525], bonus: '像素画作与自定义纹章展示。' },
  { key: 'COZY_BEDROOM', name: '森系茶歇卧室', required: [517], optional: [518, 520, 521], bonus: '每秒恢复 15 HP 并进入打盹状态。' },
  { key: 'SAKURA_ONSEN', name: '绯樱露天温泉馆', required: [526], optional: [109, 304], bonus: '战前泡澡获 20 分钟生命上限 +30%。' },
  { key: 'ECO_RANCH', name: '生态牧场', required: [529], optional: [357, 360], bonus: '圈养动物自动进食并每日产出毛团/温泉橘。' },
  { key: 'ALCHEMY_LAB', name: '奇想炼金实验室', required: [536, 537], optional: [505, 512], bonus: '解锁大模型自由炼金与全服首创冠名陈列。' },
  { key: 'AUTO_GREENHOUSE', name: '自动物流温室', required: [375], optional: [426, 428, 430], bonus: '全天候透光 + 自动洒水与分拣物流。' },
  { key: 'CLOUD_DEPOT', name: '云端跨服百货店', required: [515], optional: [513, 534], bonus: '上架稀有材料与 AI 炼金奇物供游客购买。' },
] as const;
