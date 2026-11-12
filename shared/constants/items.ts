/**
 * 冻结层:320 项全量物品配表(设计手册 §3.1 ~ §3.10 逐行落地)。
 *
 * 这是全仓库唯一的 ID 事实源。任何模块引用物品一律通过 `ITEM_BY_ID` / `ITEM_LIST`,
 * 不得自行硬编码名称。表格 ID 与手册完全对齐(101~745,共 320 项)。
 *
 * 价值分 V 的标定规则(手册 §5.3 只给了少量锚点,其余按锚点插值):
 *   锚点:寒铁金属锭 V=45  ·  秘银魔导锭 V=85  ·  Boss 遗物 V=250
 *   标定原则:V(半成品) ≈ 原料 V 之和 × 1.15;V(成品) ≈ 结构复杂度 × 材料档位。
 */

import { ItemCategory, type ItemDef } from '../types/entities.ts';

export type { ItemDef };

const N = ItemCategory.NATURAL;
const R = ItemCategory.REFINED;
const T = ItemCategory.TOOL;
const P = ItemCategory.PRANK_TOY;
const F = ItemCategory.FLOOR;
const B = ItemCategory.BUILDING;
const A = ItemCategory.AUTOMATION;
const U = ItemCategory.FURNITURE;
const G = ItemCategory.FOOD;
const W = ItemCategory.WEARABLE;
const C = ItemCategory.COMBAT;

/* ─────────────────────────── §3.1 自然采集与奇幻矿物 101 ~ 130 (30 项) ─────────────────────────── */

const NATURAL: ItemDef[] = [
  { id: 101, name: '暖松原木', category: N, tags: ['木材', '燃料', '形态:长柄'], value: 10, note: '晨曦草甸砍伐摇摆松树。锯成木板、制作基础工具柄、篝火添柴。' },
  { id: 102, name: '绯樱原木', category: N, tags: ['木材', '芳香', '治愈'], value: 22, note: '绯樱高地多人合砍樱花树。制作日式障子门、樱花家具、治愈系法器。' },
  { id: 103, name: '翠玉青竹', category: N, tags: ['木材', '弹性', '中空', '形态:管状'], value: 20, note: '绯樱高地砍伐竹林。制作竹筒水车、吹箭筒、引水竹管、撑杆跳竹竿。' },
  { id: 104, name: '夜光菌木', category: N, tags: ['木材', '发光', '魔导'], value: 28, note: '萤光溶洞砍伐巨型蘑菇树。制作免通电自发光家具、法杖杆。' },
  { id: 105, name: '焦糖威化木', category: N, tags: ['木材', '甜食', '诱饵'], value: 35, note: '甜点奇境砍伐巧克力树。建造糖果屋墙体、制作诱捕果冻怪的香甜武器。' },
  { id: 106, name: '云母圆石', category: N, tags: ['石材', '坚硬', '钝器'], value: 12, note: '草甸与河谷敲击青苔卵石。铺设石板路、砌石墙、建造熔炉与石拱桥。' },
  { id: 107, name: '河畔红黏土', category: N, tags: ['陶土', '可塑', '容器'], value: 15, note: '用水渠铲挖掘浅水河床。烧制红砖、屋顶红瓦、花盆、储物陶罐。' },
  { id: 108, name: '琉璃石英砂', category: N, tags: ['沙材', '透明', '折射'], value: 25, note: '星沙绿洲挖掘沙丘。高炉烧制成全透明玻璃幕墙、天窗、光学棱镜。' },
  { id: 109, name: '白玉温泉石', category: N, tags: ['石材', '保温', '恢复'], value: 30, note: '绯樱高地温泉眼周边开采。砌筑人工温泉池壁(使普通水转化为温泉水)。' },
  { id: 110, name: '黑曜石块', category: N, tags: ['石材', '抗爆', '锋利'], value: 55, note: '引普通水浇灭熔岩自然凝结。制作防爆墙、高暴击黑金武器、暗影传送门框。' },
  { id: 111, name: '多孔浮石', category: N, tags: ['石材', '浮力', '轻盈'], value: 40, note: '引温泉水接触熔岩凝结。可直接铺设在深水表面搭建漂浮水上平台。' },
  { id: 112, name: '黄铜矿石', category: N, tags: ['金属', '导电', '机械'], value: 25, note: '地下溶洞浅层与发条遗迹开采。冶炼黄铜锭,制作机械臂、齿轮、蒸汽火车零件。' },
  { id: 113, name: '寒铁矿石', category: N, tags: ['金属', '坚固', '锋利'], value: 40, note: '地下溶洞中层矿脉开采。冶炼寒铁锭,制作铁砧、铁轨、重型护甲与武器。' },
  { id: 114, name: '秘银矿石', category: N, tags: ['金属', '轻盈', '魔导'], value: 70, note: '地下溶洞深层矿脉开采。冶炼秘银锭,制作大师级武器、飞艇螺旋桨。' },
  { id: 115, name: '曜金矿石', category: N, tags: ['金属', '华贵', '暴击'], value: 85, note: '沙漠绿洲地下金字塔遗迹开采。冶炼曜金锭,制作金皇冠、暴击饰品、豪华吊灯。' },
  { id: 116, name: '萤光魔晶簇', category: N, tags: ['魔能', '发光', '导电', '激光'], value: 50, note: '萤光溶洞晶石矿脉开采。提炼四色魔能电线、法杖核心、自动水车动力核。' },
  { id: 117, name: '极光星辰碎片', category: N, tags: ['魔能', '浮空', '陨星'], value: 120, note: '夜晚浮空云海随机坠落拾取。锻造毕业级星辰装备、点亮跨房热气球核心引擎。' },
  { id: 118, name: '柔韧风草', category: N, tags: ['纤维', '捆绑'], value: 8, note: '晨曦草甸割除高草丛。搓成草绳、编织草席、制作茅草屋顶与捕虫网。' },
  { id: 119, name: '云朵棉花', category: N, tags: ['纤维', '蓬松', '浮力'], value: 25, note: '浮空云海采集或剪云朵绵羊。制作软床、飘飘气球、法师长袍、时装披风。' },
  { id: 120, name: '幻彩蚕丝', category: N, tags: ['纤维', '丝滑', '韧性'], value: 45, note: '果园桑树饲养彩蚕产出。织造高闪避轻甲、高级画布、热气球彩绘伞面。' },
  { id: 121, name: '露水甜莓', category: N, tags: ['水果', '香甜', '恢复'], value: 10, note: '草甸浆果灌木采摘。直接食用回血、榨汁、驯服草甸小动物、调红染料。' },
  { id: 122, name: '金秋蜜桃', category: N, tags: ['水果', '恢复', '护盾'], value: 18, note: '金秋河谷桃树采摘。制作回血蜜桃派、驯服河狸木匠与温泉水豚。' },
  { id: 123, name: '黄金小麦', category: N, tags: ['谷物', '饱腹'], value: 14, note: '河谷耕地播种收获。磨制面粉、烤面包、驯服并繁殖云朵绵羊与陆行鸟。' },
  { id: 124, name: '弹簧跳跳菇', category: N, tags: ['菌类', '高弹', '击退'], value: 32, note: '溶洞与甜点奇境采摘。合成弹射弹簧垫、打造充气玩具大锤、熬跳高汤。' },
  { id: 125, name: '滑溜香蕉', category: N, tags: ['水果', '极滑', '摔跤'], value: 28, note: '星沙绿洲边缘香蕉树采摘。吃完获【滑溜溜香蕉皮】,投入炼金炉赋予“打滑”词条。' },
  { id: 126, name: '爆裂火椒', category: N, tags: ['蔬果', '辛辣', '爆炸', '火焰'], value: 38, note: '星沙绿洲耕种收获。制作定时痒痒炸弹果、火焰箭矢、喷火加速大锅汤。' },
  { id: 127, name: '幻彩变身菇', category: N, tags: ['菌类', '变形', '致幻'], value: 50, note: '雨天森林草地随机刷新。制作变身吹箭、投入炼金炉赋予“命中变形”词条。' },
  { id: 128, name: '粘性皇家蜂蜜', category: N, tags: ['甜食', '强粘性', '减速'], value: 42, note: '果园野生蜂箱采集。制作粘性减速地垫、蜂蜜罐投掷物、召唤果冻王祭品。' },
  { id: 129, name: '冰晶薄荷叶', category: N, tags: ['草药', '冰冻', '寒冷'], value: 45, note: '高海拔云海边缘采集。制作冰霜雪球、冰冻箭矢、铺设镜面滑冰砖。' },
  { id: 130, name: '梦境露水', category: N, tags: ['精华', '催熟', '混沌催化剂'], value: 60, note: '切后台打盹或给打盹队友摸头。催熟作物、在炼金炉中提升神品变异率(β_dew=0.15)。' },
];

/* ─────────────────────────── §3.2 半成品加工材料与工业元件 151 ~ 170 (20 项) ─────────────────────────── */

const REFINED: ItemDef[] = [
  { id: 151, name: '精刨松木板', category: R, tags: ['木材', '板材', '手持'], value: 16, recipe: { 101: 1 }, output: 2, station: 502, note: '木工切木机加工。建造木屋墙体、地板、木箱、基础木盾。' },
  { id: 152, name: '绯樱香木板', category: R, tags: ['木材', '板材', '芳香'], value: 34, recipe: { 102: 1 }, output: 2, station: 502, note: '建造日式和风建筑、猎弓弓身、乐器共鸣箱。' },
  { id: 153, name: '窑烧红砖块', category: R, tags: ['石材', '砖', '耐火'], value: 34, recipe: { 107: 2 }, station: 503, note: '砌筑红砖墙、壁炉、面包烤炉、拱桥桥墩。' },
  { id: 154, name: '全透琉璃板', category: R, tags: ['沙材', '透明', '折射'], value: 54, recipe: { 108: 2 }, station: 503, note: '制作全透明玻璃幕墙、温室天窗、生态缸外壁。' },
  { id: 155, name: '黄铜金属锭', category: R, tags: ['金属', '导电', '机械'], value: 32, recipe: { 112: 2, 101: 1 }, station: 503, note: '锻造齿轮、导线扳手、黄铜武器、铜管乐器。' },
  { id: 156, name: '寒铁金属锭', category: R, tags: ['金属', '坚固', '锋利'], value: 45, recipe: { 113: 2, 101: 1 }, station: 503, note: '锻造铁轨、寒铁武器、重型锁子甲、飞索钩爪。' },
  { id: 157, name: '秘银魔导锭', category: R, tags: ['金属', '轻盈', '魔导'], value: 85, recipe: { 114: 2, 116: 1 }, station: 503, note: '锻造秘银武器、机械臂、云海飞艇引擎、传送阵。' },
  { id: 158, name: '精密发条齿轮', category: R, tags: ['机械', '金属', '精密'], value: 40, recipe: { 155: 1 }, output: 2, station: 504, note: '组装定向传送带、360°旋转推杆、连弩机关。' },
  { id: 159, name: '四色魔能线芯', category: R, tags: ['魔导', '导电', '线材'], value: 90, recipe: { 116: 1, 155: 1 }, output: 10, station: 504, note: '铺设地面下隐藏的红/蓝/黄/绿四色逻辑电路网。' },
  { id: 160, name: '结实风草绳', category: R, tags: ['纤维', '绳', '捆绑'], value: 18, recipe: { 118: 2 }, station: 502, note: '制作吊桥、拔河麻绳、气球捆绳、弓弦与驯兽套索。' },
  { id: 161, name: '蓬松云朵布', category: R, tags: ['纤维', '布', '蓬松'], value: 52, recipe: { 119: 2 }, station: 502, note: '制作画布、地毯、沙发软垫、法师布甲、飞艇气囊。' },
  { id: 162, name: '高弹果冻胶', category: R, tags: ['甜食', '高弹', '胶体'], value: 44, recipe: { 124: 1, 121: 1 }, station: 505, note: '制作果冻蹦床砖、充气玩具、果冻足球内核。' },
  { id: 163, name: '麦香精面粉', category: R, tags: ['谷物', '粉末', '食材'], value: 30, recipe: { 123: 2 }, station: 509, note: '制作面包、披萨饼底、果酱派、Boss召唤布丁。' },
  { id: 164, name: '甜莓浓缩果酱', category: R, tags: ['水果', '食材', '恢复'], value: 32, recipe: { 121: 3 }, station: 509, note: '涂抹制作加速甜点、合成瞬回生命药水。' },
  { id: 165, name: '陶瓷空药水瓶', category: R, tags: ['陶土', '药水瓶', '容器'], value: 30, recipe: { 108: 1 }, output: 3, station: 503, note: '灌装生命恢复药水、缩小/巨人药水、染色颜料水球。' },
  { id: 166, name: '绯红植物染料', category: R, tags: ['染料', '颜料', '容器'], value: 22, recipe: { 121: 2 }, station: 505, note: '供染色喷枪与 16×16 像素画架使用的红色系颜料。' },
  { id: 167, name: '琥珀阳光染料', category: R, tags: ['染料', '颜料', '容器'], value: 34, recipe: { 123: 1, 122: 1 }, station: 505, note: '供染色喷枪与像素画架使用的暖黄/橙色系颜料。' },
  { id: 168, name: '翡翠森林染料', category: R, tags: ['染料', '颜料', '容器'], value: 48, recipe: { 118: 2, 103: 1 }, station: 505, note: '供染色喷枪与像素画架使用的翠绿色系颜料。' },
  { id: 169, name: '星夜霓虹染料', category: R, tags: ['染料', '发光', '颜料'], value: 95, recipe: { 116: 1, 129: 1 }, station: 505, note: '带有夜间自发光效果的青蓝/紫罗兰荧光颜料。' },
  { id: 170, name: '空白描图纸卷', category: R, tags: ['纤维', '纸张', '卷轴'], value: 40, recipe: { 118: 3, 163: 1 }, station: 502, note: '结合梦境露水制作【魔法描图卷轴】以保存玩家建筑。' },
];

/* ─────────────────────────── §3.3 生产工具与生活专精装备 201 ~ 218 (18 项) ─────────────────────────── */

const TOOLS: ItemDef[] = [
  { id: 201, name: '暖松石刃斧', category: T, tags: ['手持', '利器', '木材'], value: 30, recipe: { 101: 2, 106: 2 }, station: 502, note: '基础伐木与拆木墙;多人围砍同一棵树激活 N 人阶梯暴击。' },
  { id: 202, name: '秘银旋风斧', category: T, tags: ['手持', '利器', '木材', '魔导'], value: 180, recipe: { 157: 2, 152: 2 }, station: 504, note: '蓄力 1 秒旋转挥砍周围 3×3 格内所有树木与木桶,附带樱花粒子。' },
  { id: 203, name: '矿工十字石镐', category: T, tags: ['手持', '石材', '器械'], value: 34, recipe: { 101: 2, 106: 3 }, station: 502, note: '基础采矿与拆石墙;可在地下溶洞敲穿软岩壁。' },
  { id: 204, name: '黑金爆破冲击镐', category: T, tags: ['手持', '石材', '抗爆', '破盾'], value: 210, recipe: { 110: 2, 156: 2 }, station: 504, note: '每次挥击产生震波同时敲击前方 1×3 矿脉,且能一击敲碎晶甲类怪物的护盾。' },
  { id: 205, name: '改地水渠木铲', category: T, tags: ['手持', '陶土', '地形'], value: 40, recipe: { 101: 2, 155: 1 }, station: 502, note: '挖低 Z0 草地形成 Z-1 引水渠,或铲出草皮移植。' },
  { id: 206, name: '造山填海泥瓦刀', category: T, tags: ['手持', '石材', '地形'], value: 170, recipe: { 156: 2, 107: 4 }, station: 504, note: '消耗泥土/石块,一键将面前 2×2 平地抬升为 Z1/Z2 高台,或填平水域。' },
  { id: 207, name: '四色电路扳手', category: T, tags: ['手持', '导电', '魔导', '机关'], value: 200, recipe: { 155: 2, 159: 2 }, station: 504, note: '展开地下暗线视图,拖拽铺设四色电线,点击音符砖切换 32 种音高。' },
  { id: 208, name: '魔法描图卷轴', category: T, tags: ['卷轴', '魔导', '建筑'], value: 260, recipe: { 170: 1, 130: 2 }, station: 512, note: '框选 16×16 自建房屋生成立体施工虚影,供全房好友一键飞砖接力建造。' },
  { id: 209, name: '32色气压染色枪', category: T, tags: ['手持', '颜料', '喷枪'], value: 130, recipe: { 155: 1, 165: 2 }, station: 504, note: '对准任意墙体、屋顶、家具、驯养的宠物甚至路过的队友喷涂改色。' },
  { id: 210, name: '园艺十字嫁接剪', category: T, tags: ['手持', '利器', '园艺'], value: 165, recipe: { 156: 2, 103: 1 }, station: 504, note: '对相邻两株不同颜色的花卉使用,必定触发杂交结出稀有变异种子。' },
  { id: 211, name: '波波森灵指挥笛', category: T, tags: ['乐器', '手持', '驯兽', '魔导'], value: 150, recipe: { 103: 2, 116: 1 }, station: 504, note: '吹奏后召唤周围波波森灵或已驯服的动物跟随自己助战/收菜。' },
  { id: 212, name: '欢宴翻炒大铁铲', category: T, tags: ['手持', '厨具', '金属'], value: 140, recipe: { 156: 2, 101: 1 }, station: 504, note: '在大汤锅或高炉旁挥动可瞬间降温灭火,并使出锅料理额外增加 1 条战斗增益词条。' },
  { id: 213, name: '弹性捕虫扑网', category: T, tags: ['手持', '纤维', '捕捉'], value: 60, recipe: { 103: 2, 160: 2 }, station: 502, note: '捕捉森林里的发光萤火虫、蝴蝶、蜜蜂装入生态瓶或做炼金材料。' },
  { id: 214, name: '浮标弹射钓鱼竿', category: T, tags: ['手持', '纤维', '休闲'], value: 90, recipe: { 103: 3, 120: 2 }, station: 502, note: '在小河、温泉或云海垂钓特产鱼类、沉底装备宝箱与水生精英怪。' },
  { id: 215, name: '地下遗迹探测仪', category: T, tags: ['手持', '机械', '探测', '魔导'], value: 190, recipe: { 155: 2, 116: 2 }, station: 504, note: '手持移动时根据距离隐藏地窖/Boss祭坛的远近发出“滴滴”声光提示。' },
  { id: 216, name: '多人合力抬物扁担', category: T, tags: ['手持', '木材', '纤维', '协作'], value: 120, recipe: { 103: 4, 160: 2 }, station: 502, note: '2~4 人同时装备后可抬起超重型 Boss 战利品或整座小木屋整体搬迁。' },
  { id: 217, name: '强力磁吸拾取器', category: T, tags: ['手持', '机械', '魔导', '拾取'], value: 220, recipe: { 110: 1, 155: 2 }, station: 504, note: '自动将周围 6 格内散落的所有木头、矿石、怪物掉落物与经验球吸入背包。' },
  { id: 218, name: '工程安全帽(和平盾)', category: T, tags: ['头饰', '守护', '和平'], value: 0, note: '初始背包常驻开关。开启后头顶显示黄色安全帽,100% 免疫队友举起、大锤击退与香蕉皮。' },
];

/* ─────────────────────────── §3.4 整蛊玩具与派对比拼装备 221 ~ 255 (35 项) ─────────────────────────── */

const PRANKS: ItemDef[] = [
  { id: 221, name: '大力士举重手套', category: P, tags: ['手持', '布', '举起', '投掷'], value: 120, recipe: { 161: 2, 160: 2 }, station: 502, note: '4人叠罗汉、抱起炸弹果扔进Boss嘴里、或举起被砸晕的小怪扔向怪群;也可把钓鱼或打盹的朋友扔进河里。' },
  { id: 222, name: '充气玩具大锤', category: P, tags: ['手持', '高弹', '击退', '胶体'], value: 110, recipe: { 162: 2, 161: 2 }, station: 505, note: '对队友0伤害但施加 8 格/秒击退冲量;可把滚石穿山甲或糖球像打棒球一样反抽回去。' },
  { id: 223, name: '伸缩弹簧拳击套', category: P, tags: ['手持', '高弹', '击退', '机械'], value: 130, recipe: { 158: 2, 124: 2 }, station: 504, note: '直线弹出 4 格远的弹簧大拳头,把小怪推下悬崖或隔河顶人下水。' },
  { id: 224, name: '灵巧飞索钩爪', category: P, tags: ['手持', '金属', '绳索', '位移'], value: 160, recipe: { 156: 2, 160: 3 }, station: 504, note: '勾住云海鲸王背鳍登背作战、救出红圈队友;也可把抢到皇冠的朋友拽到面前。' },
  { id: 225, name: '滑溜溜香蕉皮', category: P, tags: ['水果', '极滑', '陷阱', '摔跤'], value: 28, note: '吃掉滑溜香蕉获得。丢在地上,队友或冲锋中的精英怪/Boss 踩中都会极速打滑 5 格撞墙眩晕。' },
  { id: 226, name: '飘飘气球捆绳', category: P, tags: ['布', '浮力', '浮空', '陷阱'], value: 95, recipe: { 161: 2, 160: 1 }, station: 502, note: '绑在近战怪身上让它飘到空中打不到人;也可绑在队友背上让他飘到 Z=2 蹬腿呼救。' },
  { id: 227, name: '泡泡连发水枪', category: P, tags: ['手持', '流体发射', '胶体', '困人'], value: 105, recipe: { 103: 2, 162: 1 }, station: 505, note: '扑灭高炉火苗、浇灭火灵护盾;连射队友 3 发将其装进大泡泡随风乱飘。' },
  { id: 228, name: '定时痒痒炸弹果', category: P, tags: ['炸弹', '爆炸', '火焰', '破盾'], value: 100, recipe: { 126: 2, 107: 1 }, station: 505, note: '点燃后 3 秒爆炸(不毁玩家建筑):对野生怪物 120 点破甲爆破伤害,也会把队友炸飞翻滚。' },
  { id: 229, name: '幻彩变身吹箭', category: P, tags: ['手持', '变形', '致幻', '管状'], value: 140, recipe: { 103: 1, 127: 1 }, station: 505, note: '吹中精英怪或队友后,使其变成无害的小肥鸡或小绵羊 10 秒。' },
  { id: 230, name: '缩小蚂蚁药水', category: P, tags: ['药水瓶', '变形', '魔导'], value: 125, recipe: { 165: 1, 116: 1 }, station: 505, note: '角色或被砸中的怪物缩小为 0.3 倍(怪物攻击力减半,玩家移速暴增且能钻进隐藏洞口)。' },
  { id: 231, name: '进击巨人药水', category: P, tags: ['药水瓶', '变形', '高弹'], value: 135, recipe: { 165: 1, 124: 2 }, station: 505, note: '角色体积放大 2.0 倍,生命上限与近战冲击力翻倍,Boss 战前排肉盾神药。' },
  { id: 232, name: '强力粘性蜂蜜罐', category: P, tags: ['甜食', '强粘性', '减速', '投掷'], value: 110, recipe: { 128: 2, 107: 1 }, station: 505, note: '砸碎形成 3×3 蜂蜜滩,大幅减缓高速移动的 Boss、小偷河狸或跑酷对手 70% 移速。' },
  { id: 233, name: '极寒冰霜雪球', category: P, tags: ['草药', '冰冻', '投掷', '滑行'], value: 145, recipe: { 129: 2, 130: 1 }, station: 505, note: '砸中怪物或队友将其冻成“冰雕”3 秒;用大锤敲一下冰雕会高速滑出去撞飞一排怪物。' },
  { id: 234, name: '便携弹簧跳板', category: P, tags: ['机关', '高弹', '地形', '垫脚'], value: 90, recipe: { 151: 2, 124: 2 }, station: 504, note: '随时丢在脚下跳上高台躲避全屏震地波;或丢在奔跑的队友面前把他弹进水沟。' },
  { id: 235, name: '伪装恶作剧宝箱', category: P, tags: ['木材', '陷阱', '伪装', '击退'], value: 150, recipe: { 151: 4, 223: 1 }, station: 504, note: '外观与金箱子一致,贪心的朋友或偷东西的哥布林打开时直接被弹簧拳套揍飞 3 格。' },
  { id: 236, name: '臭鼬彩虹屁坐垫', category: P, tags: ['家具', '胶体', '陷阱', '爆炸'], value: 100, recipe: { 162: 2, 126: 1 }, station: 505, note: '放在椅子上,朋友一坐上去就会发出响亮“噗——”声并被彩虹烟雾弹射到半空。' },
  { id: 237, name: '七彩颜料水球', category: P, tags: ['颜料', '投掷', '致盲'], value: 70, recipe: { 165: 1, 166: 1 },
   /* CR-17:手册 L178 写「任意染料×1」。166 保留为**登记代表**
      (删键会撞红写域外的 WS-FND-06 对照表),实际判定由 recipeAnyTag
      接管 ⇒ 167/168/169 均可满足。 */
   recipeAnyTag: [['染料']], station: 505, note: '涂色对战道具;砸中 Boss 眼睛可糊住其视线使其攻击偏离方向。' },
  { id: 238, name: '撑杆跳高青竹竿', category: P, tags: ['管状', '弹性', '地形', '跨越'], value: 85, recipe: { 103: 3, 160: 1 }, station: 502, note: '助跑撑杆越过 4 格宽的河流或 Boss 激光网。' },
  { id: 239, name: '竹蜻蜓飞行草帽', category: P, tags: ['头饰', '纤维', '浮空', '滞空'], value: 80, recipe: { 103: 2, 118: 3 }, station: 502, note: '连按跳跃键慢速飞越深渊或躲避地面岩浆喷发。' },
  { id: 240, name: '回旋木飞镖', category: P, tags: ['手持', '木材', '投掷', '拉怪'], value: 75, recipe: { 152: 2 }, station: 502, note: '扔出去可同时刮中直线上多只怪物吸引仇恨并飞回手中。' },
  { id: 241, name: '双向拔河大麻绳', category: P, tags: ['绳索', '捆绑', '角力', '协作'], value: 105, recipe: { 160: 6 }, station: 502, note: '好友间拔河比赛,或在多人狩猎时套住巨型 Boss 的脚踝将其拉倒在地。' },
  { id: 242, name: '大声公扩音喇叭', category: P, tags: ['乐器', '金属', '声波', '嘲讽'], value: 155, recipe: { 155: 2, 116: 1 }, station: 504, note: '发出环形声波,既震醒打瞌睡的队友,也强制吸引周围 8 格内怪物仇恨保护脆皮队友。' },
  { id: 243, name: '引雷铁锅头盔', category: P, tags: ['头饰', '金属', '导电', '雷电'], value: 175, recipe: { 156: 3 }, station: 504, note: '雷雨天吸引闪电劈下,对周围 3 格内怪物造成感电麻痹(也会把自己电成爆炸头)。' },
  { id: 244, name: '果冻怪伪装壳', category: P, tags: ['胶体', '伪装', '潜行', '颜料'], value: 140, recipe: { 162: 3, 168: 1 }, station: 505, note: '套在身上变成绿色果冻怪,野生怪物不会主动攻击你,可悄悄摸到 Boss 身后放炸弹。' },
  { id: 245, name: '手持庆典烟花筒', category: P, tags: ['管状', '爆炸', '火焰', '惊吓'], value: 95, recipe: { 103: 1, 126: 1, 166: 1 },
   /* CR-17:手册 L186 写「染料×1」。同 237,166 为登记代表。 */
   recipeAnyTag: [['染料']], station: 505, note: '发射绚丽烟花,同时能吓退夜晚怕光的暗影小怪。' },
  { id: 246, name: '阳光尤克里里', category: P, tags: ['乐器', '战歌', '治疗', '木材'], value: 160, recipe: { 152: 2, 120: 2 }, station: 502, note: '演奏时为周围 6 格内队友提供每秒 +5 HP 的持续生命恢复光环。' },
  { id: 247, name: '微风手风琴', category: P, tags: ['乐器', '战歌', '布', '效率'], value: 165, recipe: { 151: 2, 161: 2 }, station: 502, note: '演奏时让周围队友采集效率与技能冷却缩减 +20%。' },
  { id: 248, name: '星光卡林巴琴', category: P, tags: ['乐器', '战歌', '发光', '护盾'], value: 175, recipe: { 104: 2, 156: 1 }, station: 504, note: '演奏时为周围队友附加夜间照明与魔法抗性护盾。' },
  { id: 249, name: '行进小军鼓', category: P, tags: ['乐器', '战歌', '木材', '加速'], value: 130, recipe: { 101: 2, 160: 2 }, station: 502, note: '边走边敲鼓,使周围队友移动速度与攻击速度同步 +25%。' },
  { id: 250, name: '翠玉竹长笛', category: P, tags: ['乐器', '驯兽', '管状', '安抚'], value: 90, recipe: { 103: 3 }, station: 502, note: '吹奏时可安抚狂暴的野生动物,使其进入可喂食驯化状态。' },
  { id: 251, name: '黄金凯旋小号', category: P, tags: ['乐器', '战歌', '金属', '破幻'], value: 210, recipe: { 155: 3 }, station: 504, note: '吹响音波可震散妖狐 Boss 的幻影分身,并为全队提升 15% 暴击率。' },
  { id: 252, name: '醇厚大提琴', category: P, tags: ['乐器', '控制', '木材', '减速'], value: 240, recipe: { 152: 4, 120: 3 }, station: 504, note: '低沉音波让周围敌对怪物的移动与攻击速度降低 30%。' },
  { id: 253, name: '叮当三角铁', category: P, tags: ['乐器', '金属', '信号', '集结'], value: 60, recipe: { 156: 2 }, station: 504, note: '敲响后在小地图上向全房队友发送高亮集结信号(如发现野生稀有精英怪)。' },
  { id: 254, name: '魔能电音键盘', category: P, tags: ['乐器', '战歌', '魔导', '雷电'], value: 300, recipe: { 157: 2, 159: 4 }, station: 504, note: '演奏时队友的普通攻击附带连锁小闪电特效。' },
  { id: 255, name: '裁判金哨子', category: P, tags: ['乐器', '竞技', '金属', '信号'], value: 70, recipe: { 155: 1, 160: 1 }, station: 504, note: '吹响后立即在当前位置召集全房玩家开启造桥跑酷或抢皇冠小游戏。' },
];

/* ─────────────────────────── §3.5 地表铺装与特殊物理机关地板 301 ~ 330 (30 项) ─────────────────────────── */

const FLOORS: ItemDef[] = [
  { id: 301, name: '肥沃农田耕地', category: F, tags: ['地砖', '农业', '湿润'], value: 6, recipe: { 107: 1 }, station: 502, note: '用锄头开垦草地获得;靠近水源 3 格内自动变为深色湿润耕地。' },
  { id: 302, name: '青苔鹅卵石径', category: F, tags: ['地砖', '石材', '园林'], value: 8, recipe: { 106: 1 }, station: 502, note: '基础园林小路,自动根据相邻小路平滑拼接边缘。' },
  { id: 303, name: '暖松人字木地板', category: F, tags: ['地砖', '木材', '室内'], value: 10, recipe: { 151: 1 }, station: 502, note: '温馨室内基础木地板,踩踏发出柔和木板声。' },
  { id: 304, name: '绯樱榻榻米席', category: F, tags: ['地砖', '纤维', '和风'], value: 14, recipe: { 118: 2 }, station: 502, note: '和风室内铺装,坐下打盹回血与攒露水速度额外 +20%。' },
  { id: 305, name: '复古红砖广场砖', category: F, tags: ['地砖', '砖', '广场'], value: 12, recipe: { 153: 1 }, station: 503, note: '适合铺设城镇中心广场与集市街道。' },
  { id: 306, name: '纯白大理石砖', category: F, tags: ['地砖', '石材', '华贵'], value: 22, recipe: { 106: 2 }, station: 503, note: '高雅画廊与圣殿地面,反光柔和。' },
  { id: 307, name: '黑白国际象棋砖', category: F, tags: ['地砖', '石材', '棋类'], value: 20, recipe: { 106: 1, 110: 1 }, station: 503, note: '交替铺设可直接在地上和朋友用棋子雕塑下真人国际象棋或五子棋。' },
  { id: 308, name: '樱花花瓣地毯', category: F, tags: ['地砖', '纤维', '花瓣'], value: 16, recipe: { 102: 1, 118: 1 }, station: 502, note: '走过时会惊起一串随风飘散的粉红花瓣粒子。' },
  { id: 309, name: '萤光星光夜路砖', category: F, tags: ['地砖', '发光', '驱怪'], value: 30, recipe: { 116: 1, 106: 1 }, station: 503, note: '白天吸收阳光,夜晚自动发出柔和蓝紫微光并阻止敌对野怪在上面刷新。' },
  { id: 310, name: '水上浮木栈桥', category: F, tags: ['地砖', '木材', '浮力'], value: 18, recipe: { 151: 2 }, station: 502, note: '可直接铺设在 Z=-1 的河流与湖面上,架设跨水通道。' },
  { id: 311, name: '华夫威化饼干砖', category: F, tags: ['地砖', '甜食', '木材'], value: 24, recipe: { 105: 1 }, station: 502, note: '甜点风格地板,搭配巧克力墙使用。' },
  { id: 312, name: '绿茵足球场草皮', category: F, tags: ['地砖', '草坪', '竞技'], value: 15, recipe: { 118: 2, 107: 1 }, station: 502, note: '带有清晰的白色边线与中圈纹理,专为自建 4v4 球场设计。' },
  { id: 313, name: '塑胶跑道计速砖', category: F, tags: ['地砖', '加速', '竞技'], value: 26, recipe: { 162: 1, 107: 1 }, station: 505, note: '带有白色跑道线,供玩家铺设环岛马拉松与风筝 Boss 跑道。' },
  { id: 314, name: '自定义像素地毯', category: F, tags: ['地砖', '布', 'UGC'], value: 28, recipe: { 161: 1 }, station: 511, note: '直接渲染玩家在 16×16 像素画架上手绘的图案,支持多块无缝拼成巨幅地画。' },
  { id: 315, name: '镜面极滑冰砖', category: F, tags: ['地砖', '极滑', '冰冻', '滑行'], value: 40, recipe: { 129: 2, 108: 1 }, station: 503, note: 'μ=0.98 极度打滑!把冲锋的野猪或晶甲巨蟹引到冰砖上,它会刹不住车一头撞在石墙上眩晕破甲。' },
  { id: 316, name: '紫泥减速沼泽砖', category: F, tags: ['地砖', '减速', '粘性'], value: 34, recipe: { 107: 2, 128: 1 }, station: 505, note: 'μ=0.40 踩上去深陷泥潭寸步难行,铺在 Boss 祭坛外围可大幅限制近战怪物追击速度。' },
  { id: 317, name: '单向狂飙加速带', category: F, tags: ['地砖', '加速', '机关'], value: 55, recipe: { 158: 2, 162: 1 }, station: 504, note: '地面有动态流动的金色箭头,踩上瞬间沿箭头方向施加 10 格/秒推力。' },
  { id: 318, name: '高弹果冻蹦床砖', category: F, tags: ['地砖', '高弹', '反弹'], value: 46, recipe: { 162: 2 }, station: 505, note: '踩上去垂直弹跳直达 Z=2,且能将 Boss 砸向地面的巨型投掷物原路反弹。' },
  { id: 319, name: '伪装落穴草席', category: F, tags: ['地砖', '陷阱', '伪装'], value: 32, recipe: { 118: 3 }, station: 502, note: '玩家或野生怪物踩上去 0.4 秒后咔嚓碎裂掉进下方水沟或捕兽坑。' },
  { id: 320, name: '炙热烫脚火炭砖', category: F, tags: ['地砖', '火焰', '灼烧'], value: 36, recipe: { 126: 1, 110: 1 }, station: 503, note: '踩上去的队友会捂屁股狂跳;野生怪物每秒受 15 点灼烧伤害。' },
  { id: 321, name: '眩晕旋转圆盘砖', category: F, tags: ['地砖', '眩晕', '机关'], value: 48, recipe: { 158: 1, 106: 1 }, station: 504, note: '站上去每秒自动将角色或怪物的朝向旋转 180°,让怪物晕头转向打偏攻击。' },
  { id: 322, name: '强粘蜂蜜减速毯', category: F, tags: ['地砖', '强粘性', '减速'], value: 42, recipe: { 128: 2 }, station: 505, note: 'μ=0.35 粘住经过的怪物或玩家脚底,使其在 2 秒内无法跳跃或冲锋。' },
  { id: 323, name: '流沙向心漩涡砖', category: F, tags: ['地砖', '聚怪', '漩涡'], value: 50, recipe: { 108: 2, 107: 1 }, station: 505, note: '持续将周围 2 格内的怪物、玩家和掉落物缓慢吸向漩涡中心。' },
  { id: 324, name: '倒刺荆棘地垫', category: F, tags: ['地砖', '流血', '陷阱'], value: 38, recipe: { 118: 2, 110: 1 }, station: 505, note: '对踩过的野生怪物每秒造成 20 点流血伤害,对队友仅造成原地小跳掉手牌。' },
  { id: 325, name: '迪斯科变色灯砖', category: F, tags: ['地砖', '发光', '氛围'], value: 44, recipe: { 116: 1, 108: 1 }, station: 503, note: '每踩一下自动在 8 种霓虹色彩间切换,多人同时蹦迪触发彩球光效。' },
  { id: 326, name: '双子星传送地砖 A', category: F, tags: ['地砖', '传送', '魔导'], value: 65, recipe: { 157: 1, 116: 1 }, station: 504, note: '站在上面 1 秒后瞬间传送至同房间配对的【传送地砖 B】(Boss 战紧急逃生通道)。' },
  { id: 327, name: '双子星传送地砖 B', category: F, tags: ['地砖', '传送', '魔导'], value: 65, recipe: { 157: 1, 116: 1 }, station: 504, note: '与传送地砖 A 双向互通(加装电路开关后可控制开启/关闭)。' },
  { id: 328, name: '矿车笔直铁轨', category: F, tags: ['地砖', '铁轨', '载具'], value: 30, recipe: { 156: 1 }, station: 504, note: '供蒸汽小火车与单人矿车高速滑行;高速矿车撞击路上野怪可造成高额冲撞伤害。' },
  { id: 329, name: '矿车转弯与爬坡轨', category: F, tags: ['地砖', '铁轨', '载具'], value: 34, recipe: { 156: 1, 158: 1 }, station: 504, note: '连接不同方向或不同海拔高度(Z ↔ Z+1)的铁轨。' },
  { id: 330, name: '矿车制动加速轨', category: F, tags: ['地砖', '铁轨', '加速', '机关'], value: 60, recipe: { 156: 2, 158: 2 }, station: 504, note: '通电时为经过的矿车提供全速推力;断电时作为刹车轨让矿车稳稳停靠。' },
];

/* ─────────────────────────── §3.6 建筑墙体、门窗、屋顶与高低差构件 351 ~ 385 (35 项) ─────────────────────────── */

const BUILDINGS: ItemDef[] = [
  { id: 351, name: '暖松原木圆墙', category: B, tags: ['墙体', '木材', '建筑'], value: 12, recipe: { 101: 1 }, station: 502, note: '森林小木屋质感,四向转角自动拼接。' },
  { id: 352, name: '复古红砖承重墙', category: B, tags: ['墙体', '砖', '建筑'], value: 22, recipe: { 153: 1 }, station: 503, note: '欧式庄园与工坊风格,坚固厚重。' },
  { id: 353, name: '奶油白灰泥墙', category: B, tags: ['墙体', '石材', '可染色'], value: 18, recipe: { 106: 1, 107: 1 }, station: 502, note: '地中海绘本小镇风,最适合用染色喷枪涂刷成马卡龙色。' },
  { id: 354, name: '日式障子纸格墙', category: B, tags: ['墙体', '木材', '透光'], value: 34, recipe: { 152: 1, 118: 1 }, station: 502, note: '透出屋内温暖橘光,搭配温泉旅馆绝佳。' },
  { id: 355, name: '全透明落地玻璃墙', category: B, tags: ['墙体', '透明', '玻璃'], value: 58, recipe: { 154: 1 }, station: 503, note: '建造阳光花房、怪物生态观察室与百货橱窗必备。' },
  { id: 356, name: '哥特彩绘花窗墙', category: B, tags: ['墙体', '玻璃', '颜料'], value: 80, recipe: { 154: 1, 166: 2 },
   /* CR-17:手册 L242 写「任意染料×2」—— 是**两个独立留白槽**,
      不是一个槽放大倍数。这样「只带 1 个染料」会被正确判为不足。 */
   recipeAnyTag: [['染料'], ['染料']], station: 503, note: '阳光照射下会在室内地面投射出绚丽的彩色光斑。' },
  { id: 357, name: '翠竹编织篱笆墙', category: B, tags: ['墙体', '管状', '半高', '围栏'], value: 26, recipe: { 103: 2 }, station: 502, note: '半高透气围栏,可圈养驯服的云朵绵羊与陆行鸟(弓箭与水枪可隔着篱笆射击)。' },
  { id: 358, name: '盛开花藤绿植墙', category: B, tags: ['墙体', '纤维', '花卉', '邀宠'], value: 30, recipe: { 118: 2, 121: 1 }, station: 502, note: '随微风摇摆的鲜花拱墙,自然吸引蝴蝶与蜜蜂生成。' },
  { id: 359, name: '黑曜石防爆城墙', category: B, tags: ['墙体', '抗爆', '反震'], value: 62, recipe: { 110: 1 }, station: 503, note: '免疫一切 Boss 冲撞破坏,且能将撞上来的【深渊晶甲巨蟹】反震眩晕。' },
  { id: 360, name: '焦糖威化巧克力墙', category: B, tags: ['墙体', '甜食', '诱饵'], value: 38, recipe: { 105: 1 }, station: 502, note: '甜点屋专属墙体,会吸引附近的果冻怪主动跑来啃墙从而聚怪。' },
  { id: 361, name: '高弹软包防撞墙', category: B, tags: ['墙体', '布', '高弹', '反弹'], value: 60, recipe: { 161: 1, 162: 1 }, station: 505, note: '撞上去的果冻球、滑行的玩家或翻滚的穿山甲怪会以 100% 速度弹性反弹。' },
  { id: 362, name: '单向透视暗道墙', category: B, tags: ['墙体', '木材', '伪装', '潜行'], value: 70, recipe: { 151: 1, 127: 1 }, station: 505, note: '外观是实心砖墙,但玩家可直接穿墙躲避怪物追击(怪物无法穿过)。' },
  { id: 363, name: '温馨圆拱小木门', category: B, tags: ['门窗', '木材', '门'], value: 32, recipe: { 151: 2 }, station: 502, note: '玩家靠近可手动推开/关上,野生怪物无法开门。' },
  { id: 364, name: '迎宾双开雕花门', category: B, tags: ['门窗', '木材', '门', '2×1'], value: 88, recipe: { 152: 3, 155: 1 }, station: 504, note: '占地 2×1 的气派大门,适合餐馆与冒险者公会大厅。' },
  { id: 365, name: '自动感应平移玻璃门', category: B, tags: ['门窗', '玻璃', '自动', '门'], value: 96, recipe: { 154: 2, 116: 1 }, station: 504, note: '仅对玩家、森灵与已驯服宠物自动感应开启,将野生怪物挡在门外。' },
  { id: 366, name: '单向通行旋转栅门', category: B, tags: ['门窗', '金属', '单向', '门'], value: 84, recipe: { 156: 2 }, station: 504, note: '只允许从 A 侧走向 B 侧,可把野生怪物引诱进包围圈后让它出不来。' },
  { id: 367, name: '四位数字密码铁门', category: B, tags: ['门窗', '金属', '密码', '门'], value: 140, recipe: { 156: 3, 158: 2 }, station: 504, note: '房主可设定 4 位密码,或连接电路与门,解谜成功才开启。' },
  { id: 368, name: '多人合力千斤石门', category: B, tags: ['门窗', '石材', '协作', '门'], value: 120, recipe: { 106: 6, 156: 2 }, station: 504, note: '必须 3 名以上玩家同时站在门前按住互动键才能推开(常用于远古 Boss 地宫入口)。' },
  { id: 369, name: '投币收费检票闸门', category: B, tags: ['门窗', '金属', '收费', '门'], value: 110, recipe: { 155: 2, 158: 1 }, station: 504, note: '访客需投入房主指定的物品才放行 1 次。' },
  { id: 370, name: '暖阳木框观景窗', category: B, tags: ['墙体', '木材', '玻璃', '窗'], value: 44, recipe: { 151: 1, 154: 1 }, station: 503, note: '嵌入墙体中,夜晚向外透出室内暖光。' },
  { id: 371, name: '传菜与射击窗口墙', category: B, tags: ['墙体', '木材', '窗口'], value: 40, recipe: { 151: 2 }, station: 502, note: '怪物过不来,但玩家可以隔着窗口递菜,或用猎弓/法杖安全射击窗外的怪物。' },
  { id: 372, name: '暖红陶瓦斜屋顶', category: B, tags: ['屋顶', '砖', '半透明'], value: 26, recipe: { 153: 1 }, station: 503, note: '经典绘本红屋顶,角色走入室内时整片连通屋顶自动变透明。' },
  { id: 373, name: '森林茅草厚屋顶', category: B, tags: ['屋顶', '纤维', '半透明'], value: 20, recipe: { 118: 2 }, station: 502, note: '质朴童话风,雨天边缘会有晶莹雨滴滑落特效。' },
  { id: 374, name: '蔚蓝童话尖塔顶', category: B, tags: ['屋顶', '石材', '装饰'], value: 90, recipe: { 106: 1, 169: 1 }, station: 504, note: '城堡高塔专属尖顶,顶部自带随风转动的风向标。' },
  { id: 375, name: '阳光温室玻璃顶', category: B, tags: ['屋顶', '玻璃', '透光', '温室'], value: 62, recipe: { 154: 1 }, station: 503, note: '全天候透光,触发“自动物流温室”房间识别的必要条件。' },
  { id: 376, name: '紫藤花架凉亭顶', category: B, tags: ['屋顶', '管状', '半透光'], value: 56, recipe: { 103: 1, 102: 1 }, station: 502, note: '半透光花藤顶,地面会投下斑驳晃动的树影。' },
  { id: 377, name: '宽敞原木斜坡阶梯', category: B, tags: ['高低差', '木材', '阶梯'], value: 30, recipe: { 151: 2 }, station: 502, note: '连接海拔 Z 与 Z+1,支持玩家与小推车平顺上下。' },
  { id: 378, name: '雕刻青石台阶', category: B, tags: ['高低差', '石材', '阶梯'], value: 28, recipe: { 106: 2 }, station: 503, note: '稳重的石质阶梯,适合山城与神殿入口。' },
  { id: 379, name: '垂直攀爬藤蔓梯', category: B, tags: ['高低差', '纤维', '攀爬'], value: 26, recipe: { 160: 2 }, station: 502, note: '贴在 Z1/Z2 悬崖侧壁上,玩家可爬上高台居高临下用弓箭射击地面野怪。' },
  { id: 380, name: '跨高台摇晃吊桥', category: B, tags: ['高低差', '木材', '绳索', '桥'], value: 66, recipe: { 151: 2, 160: 2 }, station: 502, note: '架设在两座高台之间,下方地面怪物无法够到桥上的玩家。' },
  { id: 381, name: '青石圆拱跨河桥', category: B, tags: ['高低差', '石材', '桥'], value: 64, recipe: { 106: 4 }, station: 503, note: '横跨 Z=-1 河道,船只或漂流的木头可从拱洞流过。' },
  { id: 382, name: '高空飞跃滑索柱', category: B, tags: ['高低差', '金属', '绳索', '位移'], value: 130, recipe: { 156: 2, 160: 2 }, station: 504, note: '在 Boss 战场两端架设滑索,可在 Boss 释放全屏大招时抓滑轮极速横穿战场。' },
  { id: 383, name: '悬崖防摔木护栏', category: B, tags: ['边缘', '木材', '护栏'], value: 14, recipe: { 151: 1 }, station: 502, note: '安装在高台边缘,防止自己走路掉下悬崖。' },
  { id: 384, name: '屋顶炊烟小烟囱', category: B, tags: ['屋顶', '砖', '装饰'], value: 42, recipe: { 153: 2 }, station: 503, note: '安装在屋顶上,只要屋内壁炉或汤锅在运转就会冒出可爱的云朵状白烟。' },
  { id: 385, name: '二层雕花露台栏杆', category: B, tags: ['边缘', '木材', '装饰'], value: 36, recipe: { 152: 1 }, station: 502, note: '在高台打造露天咖啡座与观景阳台的精致围栏。' },
];

/* ─────────────────────────── §3.7 魔能电路、自动化物流与游乐场竞技设施 401 ~ 440 (40 项) ─────────────────────────── */

const AUTOMATION: ItemDef[] = [
  { id: 401, name: '轻触木质压力板', category: A, tags: ['传感器', '木材', '高弹'], value: 26, recipe: { 151: 1, 124: 1 }, station: 504, note: '任何玩家、野生动物或掉落物压在上面时输出高电平 1,离开归 0。' },
  { id: 402, name: '双人重物压力板', category: A, tags: ['传感器', '金属', '重物'], value: 70, recipe: { 156: 2, 124: 1 }, station: 504, note: '必须 2 名以上玩家同时站立(或巨型 Boss 踩上去)才输出 1。' },
  { id: 403, name: '双态机械拉杆', category: A, tags: ['传感器', '木材', '开关'], value: 30, recipe: { 101: 1, 155: 1 }, station: 504, note: '玩家点击切换常开 1 / 常闭 0,控制工厂总电源或困怪笼开关。' },
  { id: 404, name: '瞬时脉冲按钮', category: A, tags: ['传感器', '石材', '导电'], value: 44, recipe: { 106: 1, 159: 1 }, station: 504, note: '按下后输出 0.5 秒高电平随后自动弹回。' },
  { id: 405, name: '昼夜星光感光器', category: A, tags: ['传感器', '玻璃', '魔导', '昼夜'], value: 95, recipe: { 154: 1, 116: 1 }, station: 504, note: '夜晚自动输出 1,可自动升起城镇外围的升降隐藏机关墙阻挡夜间野怪进村。' },
  { id: 406, name: '河道水位传感器', category: A, tags: ['传感器', '金属', '浮力', '流体'], value: 66, recipe: { 155: 1, 111: 1 }, station: 504, note: '当所在格有水体漫入时输出 1。' },
  { id: 407, name: '红外激光绊线柱', category: A, tags: ['传感器', '魔导', '激光', '陷阱'], value: 190, recipe: { 157: 1, 116: 2 }, station: 504, note: '野生动物或 Boss 穿过红光瞬间输出脉冲信号,自动触发一排连弩或弹簧陷阱。' },
  { id: 408, name: '共鸣音高传感器', category: A, tags: ['传感器', '音乐', '管状', '魔导'], value: 120, recipe: { 103: 2, 116: 1 }, station: 504, note: '设定指定音高(如 Do-Mi-Sol),只有玩家在旁边用乐器弹出该音符时才开门。' },
  { id: 409, name: '仓库满载传感器', category: A, tags: ['传感器', '木材', '导电'], value: 48, recipe: { 151: 1, 159: 1 }, station: 504, note: '贴在储物箱旁,当箱子装满时输出 1。' },
  { id: 410, name: '红蓝计分球门框', category: A, tags: ['竞技', '金属', '布', '计分'], value: 210, recipe: { 156: 4, 161: 2 }, station: 504, note: '占地 3×1;当果冻足球滚入时输出信号、全房播报比分并重置球的位置。' },
  { id: 411, name: '跑酷起点发令门', category: A, tags: ['竞技', '木材', '导电', '计时'], value: 130, recipe: { 152: 2, 159: 2 }, station: 504, note: '通电或裁判吹哨时门栏降下,为穿过的每名玩家开启毫秒级个人计时器。' },
  { id: 412, name: '跑酷终点领奖台', category: A, tags: ['竞技', '石材', '金属', '计时'], value: 180, recipe: { 115: 2, 106: 2 }, station: 504, note: '玩家冲上领奖台瞬间停止计时,在全房头顶滚动播报前三名通关耗时。' },
  { id: 413, name: '可调延时继电器', category: A, tags: ['逻辑控制', '金属', '精密'], value: 60, recipe: { 155: 1, 158: 1 }, station: 504, note: '点击可切换延迟 0.2s / 0.5s / 1.0s / 2.0s 后向下一节点传递信号。' },
  { id: 414, name: '魔能逻辑与门 (AND)', category: A, tags: ['逻辑控制', '金属', '导电', '魔导'], value: 110, recipe: { 155: 1, 159: 2 }, station: 504, note: '仅当连接的红线与蓝线同时为 1 时,向黄线输出 1。' },
  { id: 415, name: '魔能逻辑非门 (NOT)', category: A, tags: ['逻辑控制', '金属', '导电', '魔导'], value: 95, recipe: { 155: 1, 159: 1 }, station: 504, note: '输入 0 时输出 1,输入 1 时输出 0。' },
  { id: 416, name: '随机轮盘分流器', category: A, tags: ['逻辑控制', '精密', '导电', '随机'], value: 140, recipe: { 158: 2, 159: 2 }, station: 504, note: '收到信号时随机向东、南、西三路中的一路输出信号。' },
  { id: 417, name: '0-99 翻页计数器', category: A, tags: ['逻辑显示', '金属', '木材', '计分'], value: 120, recipe: { 156: 2, 151: 2 }, station: 504, note: '每次收到脉冲数字 +1,可在球场或刷怪塔旁实时统计击杀数/比分。' },
  { id: 418, name: '无线信号发射塔', category: A, tags: ['跨区控制', '魔导', '金属', '遥控'], value: 340, recipe: { 157: 1, 117: 1 }, station: 504, note: '将信号无线广播至同房间相同频道(1~8频道)的接收器。' },
  { id: 419, name: '32音高八音盒音符砖', category: A, tags: ['执行器', '音乐', '木材', '魔导'], value: 90, recipe: { 152: 1, 116: 1 }, station: 504, note: '通电或踩踏时播放设定音高(含木琴/钢琴/八音盒/合成器 4 种音色)。' },
  { id: 420, name: '16色RGB像素灯箱', category: A, tags: ['执行器', '发光', '玻璃', '魔导'], value: 100, recipe: { 154: 1, 116: 1 }, station: 504, note: '通电点亮,用扳手切换 16 种颜色。' },
  { id: 421, name: '升降隐藏机关墙', category: A, tags: ['执行器', '石材', '精密', '困怪'], value: 160, recipe: { 106: 2, 158: 1 }, station: 504, note: '通电沉入地下,断电升起——把野怪引诱进房间后拉拉杆瞬间升起四面墙困住它。' },
  { id: 422, name: '万向弹射弹簧垫', category: A, tags: ['执行器', '金属', '高弹', '抛射'], value: 130, recipe: { 156: 1, 124: 2 }, station: 504, note: '将上方的玩家、炸弹果或中小型野生怪物向设定方向抛射 5 格远。' },
  { id: 423, name: '360°大风车旋转推杆', category: A, tags: ['执行器', '木材', '精密', '击退'], value: 190, recipe: { 101: 4, 158: 2 }, station: 504, note: '通电后长达 3 格的横杆持续旋转,既能扫飞跑酷玩家,也能做成全自动旋转打怪绞肉机。' },
  { id: 424, name: '伸缩推拉活塞臂', category: A, tags: ['执行器', '金属', '木材', '推拉'], value: 120, recipe: { 155: 2, 151: 1 }, station: 504, note: '通电时向前伸出 1 格推动方块、箱子或把怪物推下高台。' },
  { id: 425, name: '自动泡泡连弩炮台', category: A, tags: ['防御执行', '管状', '精密', '炮台'], value: 260, recipe: { 103: 2, 158: 2 }, station: 504, note: '通电或装填箭矢后,自动瞄准半径 7 格内的敌对野生动物发射泡泡或木箭。' },
  { id: 426, name: '旋转自动洒水器', category: A, tags: ['农业物流', '金属', '管状', '流体'], value: 90, recipe: { 155: 2, 103: 1 }, station: 504, note: '接通水源或每早自动旋转,将周围 5×5 耕地全部浇湿。' },
  { id: 427, name: '电动升降拦水闸门', category: A, tags: ['水利控制', '金属', '精密', '水闸'], value: 150, recipe: { 156: 2, 158: 1 }, station: 504, note: '安装在 Z=-1 河道中,通电开闸放水冲毁【机甲河狸 Boss】的木坝或浇灭熔岩怪。' },
  { id: 428, name: '定向物流传送带', category: A, tags: ['自动化', '金属', '胶体', '物流'], value: 80, recipe: { 156: 1, 162: 1 }, station: 504, note: '每秒将掉落在上面的战利品、矿石或站在上面的怪物平稳运往下一格。' },
  { id: 429, name: '智能分拣交叉带', category: A, tags: ['自动化', '金属', '精密', '分拣'], value: 130, recipe: { 155: 1, 158: 1 }, station: 504, note: '设定过滤物品 ID,将怪物掉落的材料自动分流进不同储物箱。' },
  { id: 430, name: '魔能抓取机械臂', category: A, tags: ['自动化', '魔导', '精密', '抓取'], value: 280, recipe: { 157: 1, 158: 2 }, station: 504, note: '自动抓取地面掉落物或箱内物品,放入熔炉、汤锅或装填进防御炮台。' },
  { id: 431, name: '自动采矿钻头机', category: A, tags: ['自动化', '金属', '魔导', '采矿'], value: 320, recipe: { 156: 4, 116: 2 }, station: 504, note: '架设在矿脉格旁,在风车动力网覆盖下每 10 秒自动产出一块对应矿石。' },
  { id: 432, name: '庆典烟花发射座', category: A, tags: ['氛围执行', '砖', '爆炸', '烟花'], value: 110, recipe: { 153: 2, 126: 2 }, station: 505, note: '通电时向高空连发 5 枚绚丽礼花。' },
  { id: 433, name: '巨型果冻足球生成座', category: A, tags: ['竞技', '胶体', '石材', '生成'], value: 170, recipe: { 162: 4, 106: 2 }, station: 505, note: '点击或通电在底座上刷出一颗弹性极佳的大果冻球。' },
  { id: 434, name: '争夺战金皇冠底座', category: A, tags: ['竞技', '金属', '布', '荣誉'], value: 300, recipe: { 115: 3, 161: 1 }, station: 504, note: '开启 3 分钟“抢皇冠大逃杀”,实时统计每名玩家持冠秒数。' },
  { id: 435, name: '四色队伍出生复活旗', category: A, tags: ['竞技', '木材', '布', '复活'], value: 100, recipe: { 151: 2, 161: 2 }, station: 502, note: '可切换红/蓝/黄/绿四队归属,比赛或 Boss 战期间倒地的玩家可在旗帜旁复活。' },
  { id: 436, name: '派对裁判控制哨台', category: A, tags: ['竞技核心', '木材', '金属', '裁判'], value: 250, recipe: { 152: 4, 155: 2 }, station: 504, note: '一键开启“造桥跑酷赛 / 4v4 果冻球 / 抢皇冠 / 涂色战”。' },
  { id: 437, name: '叮当蒸汽小火车头', category: A, tags: ['载具', '金属', '铁轨', '碾压'], value: 340, recipe: { 156: 6, 155: 4 }, station: 504, note: '沿轨道高速行驶,撞击铁轨上的野生怪物可直接造成 150 点碾压击飞伤害。' },
  { id: 438, name: '观光与货运矿车厢', category: A, tags: ['载具', '金属', '木材', '铁轨'], value: 160, recipe: { 156: 3, 151: 2 }, station: 504, note: '挂在火车头后,队友可坐在移动的车厢上用弓箭/法杖对沿途 Boss 进行移动射击。' },
  { id: 439, name: '双人天鹅脚踏船', category: A, tags: ['载具', '木材', '布', '水上'], value: 150, recipe: { 151: 4, 161: 2 }, station: 502, note: '放入湖泊与运河中,2 人同乘水上巡游与垂钓。' },
  { id: 440, name: '八人云海探险飞艇', category: A, tags: ['载具', '魔导', '布', '飞行'], value: 520, recipe: { 157: 6, 161: 10 }, station: 504, note: '支持最多 8 名玩家同时登船,追击【星穹幻彩云鲸 Boss】或去其他房间串门。' },
];

/* ─────────────────────────── §3.8 工坊生产设备、室内外家具与动态房间核心件 501 ~ 537 (37 项) ─────────────────────────── */

const FURNITURE: ItemDef[] = [
  { id: 501, name: '暖心篝火茶座', category: U, tags: ['家具', '木材', '石材', '治疗', '重生'], value: 90, recipe: { 101: 10, 106: 8 }, station: 502, note: '城镇初始重生与回血核心;周围 4 格每秒恢复 5 HP,打盹攒露水速度翻倍。' },
  { id: 502, name: '森系木工营造台', category: U, tags: ['家具', '木材', '加工台'], value: 60, recipe: { 101: 6 }, station: 502, note: '解锁木板加工、基础墙体门窗、木质家具与初级木制武器合成。' },
  { id: 503, name: '矮人鼓风高炉', category: U, tags: ['家具', '石材', '陶土', '加工台', '炉'], value: 150, recipe: { 106: 12, 107: 8 }, station: 502, note: '冶炼金属锭、烧制红砖与玻璃(【大师锻造房】核心件)。' },
  { id: 504, name: '大师秘银铁砧台', category: U, tags: ['家具', '金属', '加工台', '锻造'], value: 240, recipe: { 156: 6, 101: 2 }, station: 502, note: '锻造中高级武器护甲、发条齿轮与魔能电路(【大师锻造房】核心件)。' },
  { id: 505, name: '炼金调色染缸', category: U, tags: ['家具', '木材', '陶土', '加工台', '颜料'], value: 130, recipe: { 151: 6, 107: 4 }, station: 502, note: '熬制恢复药水、果冻胶、调配 32 色染料(【绘本艺术画廊】核心件)。' },
  { id: 506, name: '八人欢聚大汤锅', category: U, tags: ['家具', '金属', '砖', '加工台', '料理'], value: 200, recipe: { 156: 6, 153: 6 }, station: 504, note: '【欢聚大锅食堂】核心件;Boss 战前全房一起投料煮出全团 +40% 攻击/生命上限大餐。' },
  { id: 507, name: '胡闹切菜传菜台', category: U, tags: ['家具', '木材', '金属', '加工台', '料理'], value: 110, recipe: { 152: 4, 156: 1 }, station: 502, note: '玩家把打猎获得的野味与果蔬扔上台面,切好后直接扔进大汤锅。' },
  { id: 508, name: '红砖果木披萨炉', category: U, tags: ['家具', '砖', '木材', '加工台', '炉'], value: 160, recipe: { 153: 10, 101: 4 }, station: 503, note: '烘烤战前增益面包、蜜桃果酱派与加速披萨。' },
  { id: 509, name: '叮当果汁水车磨坊', category: U, tags: ['家具', '木材', '精密', '水力', '加工台'], value: 210, recipe: { 151: 12, 158: 4 }, station: 504, note: '需紧贴浅水河道建造;利用水力自动磨面粉、榨甜莓果酱。' },
  { id: 510, name: '波波森灵小木屋', category: U, tags: ['家具', '木材', '纤维', '自动采摘', '森灵'], value: 180, recipe: { 151: 10, 118: 10 }, station: 502, note: '绑定 1 只波波森灵,自动替玩家打理周围 9×9 范围内的浇水、收菜或喂养驯化动物。' },
  { id: 511, name: '16×16 绘本像素画架', category: U, tags: ['家具', '木材', '布', 'UGC', '画架'], value: 140, recipe: { 152: 3, 161: 2 }, station: 502, note: '【绘本艺术画廊】核心件;手绘 16×16 像素图案,生成自定义盾牌纹章与旗帜。' },
  { id: 512, name: '魔法描图制图桌', category: U, tags: ['家具', '木材', '魔导', '蓝图'], value: 230, recipe: { 152: 4, 116: 2 }, station: 504, note: '管理和导出玩家用【魔法描图卷轴】保存的建筑蓝图码。' },
  { id: 513, name: '分类图标储物箱', category: U, tags: ['家具', '木材', '储物', '24格'], value: 70, recipe: { 151: 4 }, station: 502, note: '提供 24 格存储空间,箱子正面自动显示里面存放最多那件物品的卡通图标。' },
  { id: 514, name: '跨房共享云端保险箱', category: U, tags: ['家具', '抗爆', '储物', '跨房'], value: 380, recipe: { 110: 4, 117: 1 }, station: 504, note: '存放在里面的个人毕业武器与装备,在去任何好友房间助战打 Boss 时均可直接取出。' },
  { id: 515, name: '无人自助售货摊', category: U, tags: ['家具', '木材', '布', '交易'], value: 170, recipe: { 152: 6, 161: 2 }, station: 502, note: '【云端跨服百货店】核心件;上架自己爆出的稀有 Boss 材料或 AI 炼金奇物供游客购买。' },
  { id: 516, name: '小镇悬赏与任务板', category: U, tags: ['家具', '木材', '纤维', '任务'], value: 120, recipe: { 151: 4, 118: 2 }, station: 502, note: '每日自动刷新 3 个“全房合作狩猎悬赏”。' },
  { id: 517, name: '云端软绵绵单人床', category: U, tags: ['家具', '木材', '布', '睡眠'], value: 180, recipe: { 151: 4, 161: 3 }, station: 502, note: '【森系茶歇卧室】核心件;躺上去每秒快速恢复 15 HP 并进入打盹状态。' },
  { id: 518, name: '双层上下铺木床', category: U, tags: ['家具', '木材', '布', '睡眠'], value: 300, recipe: { 151: 8, 161: 6 }, station: 502, note: '可同时睡上下两名玩家,节省卧室面积。' },
  { id: 519, name: '欢聚拼接长餐桌', category: U, tags: ['家具', '木材', '桌', '拼接'], value: 100, recipe: { 152: 4 }, station: 502, note: '【欢聚大锅食堂】核心件;多张桌子放在一起自动拼接成超长宴会桌。' },
  { id: 520, name: '软垫小木椅 / 吧台凳', category: U, tags: ['家具', '木材', '布', '座椅'], value: 60, recipe: { 151: 2, 161: 1 }, station: 502, note: '玩家坐下休息回精力。' },
  { id: 521, name: '树懒摇晃吊床', category: U, tags: ['家具', '绳索', '布', '悬挂'], value: 130, recipe: { 160: 4, 161: 2 }, station: 502, note: '挂在两棵树之间,躺上去随微风悠闲摇摆。' },
  { id: 522, name: '暖橘光铁艺路灯', category: U, tags: ['家具', '金属', '发光', '驱怪'], value: 110, recipe: { 156: 2, 116: 1 }, station: 504, note: '夜晚散发半径 5 格暖光,且光圈内不会自然刷新敌对夜行怪物。' },
  { id: 523, name: '萤火虫玻璃生态瓶', category: U, tags: ['家具', '玻璃', '发光', '装饰'], value: 90, recipe: { 154: 1, 163: 0 }, station: 503, note: '摆在桌面上发出灵动微光(需捕捉的萤火虫 ×1)。' },
  { id: 524, name: '绘本艺术展示画框', category: U, tags: ['家具', '木材', 'UGC', '装饰'], value: 80, recipe: { 152: 2 }, station: 502, note: '挂在墙上展示玩家的 16×16 像素画作。' },
  { id: 525, name: '武器与盔甲展示架', category: U, tags: ['家具', '木材', '金属', '展示'], value: 150, recipe: { 151: 3, 156: 1 }, station: 504, note: '将打 Boss 或 AI 炼金造出的传奇武器穿在木偶架上陈列展示。' },
  { id: 526, name: '露天温泉石灯笼', category: U, tags: ['家具', '石材', '发光', '温泉'], value: 140, recipe: { 109: 3, 116: 1 }, station: 504, note: '摆在温泉水池边,激活【绯樱露天温泉馆】识别(战前泡澡获 20 分钟生命上限 +30%)。' },
  { id: 527, name: '复古黑胶留声机', category: U, tags: ['家具', '金属', '音乐', '装饰'], value: 170, recipe: { 155: 2, 152: 2 }, station: 504, note: '播放已录制的八音盒曲目或 Boss 战激昂交响曲。' },
  { id: 528, name: '三层许愿音乐喷泉', category: U, tags: ['家具', '石材', '音乐', '天气'], value: 500, recipe: { 109: 12, 117: 2 }, station: 504, note: '小镇广场地标;投掷露水可许愿改变全岛天气。' },
  { id: 529, name: '牧场动物自动饲育槽', category: U, tags: ['家具', '木材', '谷物', '饲育'], value: 160, recipe: { 151: 4, 123: 4 }, station: 502, note: '【生态牧场】识别件;圈养的云朵绵羊与水豚会自动进食并每日产出毛团/温泉橘。' },
  { id: 530, name: '游乐园旋转木马', category: U, tags: ['家具', '木材', '精密', '游乐'], value: 420, recipe: { 152: 15, 158: 6 }, station: 504, note: '通电后伴随八音盒旋律旋转,最多支持 6 名玩家同时骑乘。' },
  { id: 531, name: 'Boss 荣耀战利品金雕像', category: U, tags: ['家具', '金属', '荣誉', '雕像'], value: 450, note: '击败任意群系 Boss 必定掉落图纸。在小镇广场竖立已被全房击败的 Boss 纯金Q版雕像。' },
  { id: 532, name: '拳击测力稻草人靶', category: U, tags: ['家具', '谷物', '木材', '训练'], value: 90, recipe: { 123: 4, 101: 2 }, station: 502, note: '被武器或技能攻击时实时飘出伤害数字与秒伤(DPS)统计。' },
  { id: 533, name: '换装与词条重铸魔镜', category: U, tags: ['家具', '玻璃', '魔导', '重铸'], value: 280, recipe: { 154: 2, 116: 2 }, station: 504, note: '消耗梦境露水为武器与护甲洗练随机属性词条,或更换时装外观。' },
  { id: 534, name: '迎宾点赞留言信箱', category: U, tags: ['家具', '木材', '颜料', '社交'], value: 90, recipe: { 151: 3, 166: 1 }, station: 502, note: '供来访或离线接力的好友留下贴纸贺卡与礼物。' },
  { id: 535, name: '岛主领地守护图腾', category: U, tags: ['家具', '石材', '魔导', '权限'], value: 320, recipe: { 106: 10, 116: 4 }, station: 504, note: '管理全房间权限矩阵,并开启/关闭“城镇安全区免怪侵扰护盾”。' },
  { id: 536, name: '【AI核心】万物奇想炼金炉', category: U, tags: ['家具', '魔导', '炼金', 'AI'], value: 600, recipe: { 157: 4, 116: 4, 130: 2 }, station: 504, note: '自由放入任意 2~4 件非蓝图物品,调用大模型 + 特定属性算法生成全新奇物(手册第五章)。' },
  { id: 537, name: '全服奇物发现博物架', category: U, tags: ['家具', '木材', '玻璃', 'AI', '展示'], value: 220, recipe: { 152: 4, 154: 2 }, station: 504, note: '【奇想炼金实验室】房间识别件;自动陈列本房间玩家“全服首次合成”的 AI 造物并展示冠名证书。' },
];

/* ─────────────────────────── §3.9 多人欢聚料理与搞怪时装/头饰 601 ~ 630 (30 项) ─────────────────────────── */

const FOODS: ItemDef[] = [
  { id: 601, name: '暖心甜莓果茶', category: G, tags: ['料理', '饮品', '恢复'], value: 24, recipe: { 121: 2 }, station: 506, note: '立即恢复 40 HP,移动速度 +15%,持续 10 分钟。' },
  { id: 602, name: '黄金麦香厚吐司', category: G, tags: ['料理', '饱腹', '增益'], value: 34, recipe: { 163: 2 }, station: 508, note: '最大生命值 +30,伐木与采矿速度 +20%,持续 10 分钟。' },
  { id: 603, name: '绯樱蜜桃果酱派', category: G, tags: ['料理', '暴击', '掉落'], value: 130, recipe: { 163: 2, 122: 2, 164: 1 }, station: 508, note: '暴击率 +15%,采集与打怪掉落物数量有 35% 几率翻倍。' },
  { id: 604, name: '星光萤火蘑菇汤', category: G, tags: ['料理', '大锅汤品', '发光', '跳跃'], value: 120, recipe: { 104: 1, 124: 2, 121: 2 }, station: 506, note: '全房饮用者全身散发柔和夜光,跳跃高度 +50% 且免疫跌落眩晕。' },
  { id: 605, name: '大力水手海鲜烩', category: G, tags: ['料理', '大锅汤品', '攻击', '举投'], value: 160, recipe: { 701: 2, 123: 2, 121: 2 }, station: 506, note: '近战攻击力 +25%,举起队友或炸弹果时移速不衰减且投掷距离 +3 格。' },
  { id: 606, name: '龙息爆辣烤肉排', category: G, tags: ['料理', '狩猎', '火焰', '免疫冰冻'], value: 180, recipe: { 701: 2, 126: 2 }, station: 508, note: '每次武器攻击附带 15 点火焰灼烧伤害,且免疫冰冻状态,持续 15 分钟。' },
  { id: 607, name: '喷火彩虹屁咖喱(恶作剧锅)', category: G, tags: ['整蛊料理', '大锅汤品', '火焰', '失控'], value: 150, note: '大汤锅煲汤时有人混入爆裂火椒×2。+25% 攻击力,同时每走三步喷出一串彩虹火苗向前失控冲刺 2 格(还会烧到身后的怪)。' },
  { id: 608, name: '小肥鸡咯咯浓汤(恶作剧锅)', category: G, tags: ['整蛊料理', '大锅汤品', '变形'], value: 150, note: '大汤锅煲汤时有人混入幻彩变身菇×1。全房间喝汤的人集体变成圆滚滚的小肥鸡 60 秒(可以用鸡喙集体啄 Boss)。' },
  { id: 609, name: '气球肚皮漂浮饮(恶作剧锅)', category: G, tags: ['整蛊料理', '大锅汤品', '浮空', '重力'], value: 140, note: '大汤锅煲汤时有人混入蓬松云朵布/棉花×2。角色肚子变圆、重力降低 70%,轻轻一跳就能飘在半空躲开地面怪物围攻。' },
  { id: 610, name: '滑溜溜溜冰奶昔(恶作剧锅)', category: G, tags: ['整蛊料理', '大锅汤品', '极滑', '滑行'], value: 120, note: '大汤锅煲汤时有人混入滑溜香蕉×2。脚底自带滑冰效果(μ=0.96),全队边滑冰边砍 Boss,场面极其失控欢乐。' },
  { id: 611, name: '大嗓门回声果冻(恶作剧锅)', category: G, tags: ['整蛊料理', '大锅汤品', '音乐', '放大'], value: 110, note: '大汤锅煲汤时有人混入弹簧跳跳菇×3。聊天文字放大抖动,且每次挥剑都发出清脆的八音盒音效。' },
  { id: 612, name: '冰爽薄荷净化饮', category: G, tags: ['料理', '药饮', '净化', '恢复'], value: 110, recipe: { 129: 2, 121: 1 }, station: 505, note: '立即恢复 80 HP 并解除滑倒、中毒、变身、灼烧等一切负面/整蛊状态。' },
  { id: 613, name: '庆典三层奶油蛋糕', category: G, tags: ['料理', '宴会', '经验', '团队'], value: 260, recipe: { 163: 4, 121: 4, 128: 2 }, station: 508, note: '摆在地上供 8 人分食,全队获得 20 分钟经验获取 +30% 增益。' },
  { id: 614, name: '森林百果驯兽饼干', category: G, tags: ['驯养道具', '料理', '甜食'], value: 70, recipe: { 163: 1, 121: 2, 128: 1 }, station: 508, note: '喂给野生温顺动物或残血被击败的精英小怪,可直接将其驯化为跟随宠物。' },
  { id: 615, name: '森灵最爱彩虹糖', category: G, tags: ['驯养道具', '饲料', '甜食'], value: 66, recipe: { 128: 1, 121: 2 }, station: 505, note: '喂给波波森灵后,该森灵在接下来 30 分钟内收菜与协助捡战利品效率翻倍。' },
  { id: 616, name: '田园宽檐大草帽', category: W, tags: ['头饰', '纤维', '防御'], value: 40, recipe: { 118: 4 }, station: 502, note: '防御 +2,阳光下阴影柔和。' },
  { id: 617, name: '矿工探照灯泡帽', category: W, tags: ['头饰', '金属', '发光', '照明'], value: 100, recipe: { 155: 2, 116: 1 }, station: 504, note: '防御 +5,在地下溶洞或夜晚自动照亮角色正前方 6 格扇形区域。' },
  { id: 618, name: '小黄鸭游泳圈', category: W, tags: ['腰饰', '胶体', '颜料', '水战'], value: 90, recipe: { 162: 2, 167: 1 }, station: 505, note: '穿戴后可在 Z=-1 深水区自由游泳并挥剑水战。' },
  { id: 619, name: '溜冰鞋与护膝套', category: W, tags: ['鞋饰', '金属', '布', '滑行'], value: 110, recipe: { 156: 2, 161: 1 }, station: 504, note: '站在【镜面极滑冰砖】上不再失控打滑,且冰面移速 +40%。' },
  { id: 620, name: '青蛙弹簧跳跳鞋', category: W, tags: ['鞋饰', '高弹', '布', '跳跃'], value: 120, recipe: { 124: 2, 161: 2 }, station: 505, note: '平地可直接跳上 Z=1 一层高台,且踩在怪物头顶可触发“超级玛丽式踩头二段跳”。' },
  { id: 621, name: '云朵天使小翅膀', category: W, tags: ['背饰', '布', '滑翔', '浮空'], value: 240, recipe: { 161: 6, 117: 1 }, station: 504, note: '免疫高处坠落眩晕,支持在空中滑翔跨越深渊。' },
  { id: 622, name: '呆萌鲨鱼鳍泳帽', category: W, tags: ['头饰', '布', '颜料', '游泳'], value: 100, recipe: { 161: 3, 169: 1 }, station: 505, note: '水中移速 +30%,游泳时只露出一截鲨鱼背鳍。' },
  { id: 623, name: '摇晃弹簧大便帽', category: W, tags: ['头饰', '陶土', '高弹', '搞怪'], value: 60, recipe: { 107: 2, 124: 1 }, station: 505, note: '跑步时头顶软胶造型夸张摇晃,吸引野生果冻怪追着你跑。' },
  { id: 624, name: '招财进宝猫耳箍', category: W, tags: ['头饰', '布', '金属', '掉落'], value: 150, recipe: { 161: 2, 115: 1 }, station: 504, note: '击败野生动物时金币与稀有材料掉落率 +15%。' },
  { id: 625, name: '皇家金皇冠(永久纪念)', category: W, tags: ['头饰', '荣誉', '全属性'], value: 400, note: '在【金皇冠大逃杀】中累计获胜 5 次解锁。全属性 +5%,头顶常驻闪亮星芒特效。' },
  { id: 626, name: '金牌大厨高高帽', category: W, tags: ['头饰', '专精', '料理'], value: 200, note: '欢宴大厨专精达到 5 级解锁。烹饪出的料理持续时间翻倍。' },
  { id: 627, name: '发条目镜工程师帽', category: W, tags: ['头饰', '专精', '炮台'], value: 200, note: '魔能工程师专精达到 5 级解锁。角色放置的【自动泡泡连弩炮台】射速 +35%。' },
  { id: 628, name: '繁花鹿角园艺冠', category: W, tags: ['头饰', '专精', '宠物'], value: 200, note: '生态园艺师专精达到 5 级解锁。可同时携带 2 只已驯服的野生动物宠物出战。' },
  { id: 629, name: '贝雷帽与调色板', category: W, tags: ['头饰', '专精', '颜料'], value: 200, note: '绘本画师专精达到 5 级解锁。使用染色喷枪时不消耗染料。' },
  { id: 630, name: '自定义像素印花披风', category: W, tags: ['背饰', '布', 'UGC', '防御'], value: 220, recipe: { 161: 4, 120: 2 }, station: 511, note: '防御 +8,背面实时展示玩家手绘的 16×16 像素图案(战队统一披风)。' },
];

/* ─────────────────────────── §3.10 怪物战利品、战斗武器、护甲与 Boss 召唤祭品 701 ~ 745 (45 项) ─────────────────────────── */

const COMBAT: ItemDef[] = [
  { id: 701, name: '鲜嫩野味肉块', category: C, tags: ['狩猎掉落', '食材', '肉类'], value: 30, note: '击杀野猪、沙蝎、甲虫等野生动物通用掉落。烤肉与熬制加攻大锅汤的核心肉材。' },
  { id: 702, name: '坚韧野兽毛皮', category: C, tags: ['狩猎掉落', '皮革', '护甲材料'], value: 45, note: '击杀森林野猪、穿山甲等野生动物掉落。缝制轻便皮甲、猎人箭袋与战鼓鼓面。' },
  { id: 703, name: '河狸钢牙切片', category: C, tags: ['狩猎掉落', '金属', '锋利', '破甲'], value: 120, note: '击败淘气造坝河狸掉落。锻造高破甲锯齿武器与高级伐木锯。' },
  { id: 704, name: '果冻王凝露皇冠', category: C, tags: ['Boss遗物', '魔导', '高弹'], value: 250, note: '击败【草甸Boss:果冻国王】必定掉落。锻造果冻王传奇武器与高弹果冻护甲的核心遗物。' },
  { id: 705, name: '千年绯樱妖木心', category: C, tags: ['Boss遗物', '木材', '治愈'], value: 250, note: '击败【绯樱Boss:千年垂枝妖狐】必定掉落。蕴含生机魔力,用于锻造落英法杖与全团回血图腾。' },
  { id: 706, name: '深渊紫晶重甲壳', category: C, tags: ['Boss遗物', '石材', '反伤', '抗爆'], value: 250, note: '击败【溶洞Boss:深渊晶甲巨蟹】必定掉落。坚不可摧的紫晶壳,用于锻造反伤重盾与破城重锤。' },
  { id: 707, name: '黄金法老毒尾针', category: C, tags: ['Boss遗物', '金属', '剧毒', '破甲'], value: 250, note: '击败【绿洲Boss:黄金沙暴法老蝎】必定掉落。用于锻造附带流沙漩涡与剧毒词条的传奇刺剑与长弓。' },
  { id: 708, name: '永动发条太阳核', category: C, tags: ['Boss遗物', '机械', '魔导', '终极动力'], value: 250, note: '击败【遗迹Boss:远古发条时间巨像】掉落。终极魔导动力源,用于锻造磁暴齿轮炮与时停怀表。' },
  { id: 709, name: '萤光蝙蝠超声波翼', category: C, tags: ['狩猎掉落', '飞行', '声波', '魔导'], value: 110, note: '击败溶洞萤光蝙蝠掉落。制作吸血披风、夜间暴击饰品与滑翔翼。' },
  { id: 710, name: '熔岩炽热火灵核', category: C, tags: ['狩猎掉落', '火焰', '魔导', '燃料'], value: 130, note: '击败地下熔岩火灵掉落。免燃料永久加热高炉,或锻造烈焰附魔武器。' },
  { id: 711, name: '初心冒险者木剑', category: C, tags: ['武器', '近战轻剑', '木材'], value: 60, recipe: { 101: 4, 160: 1 }, station: 502, note: 'ATK +12;普攻三连挥砍,主动技 [Q] 旋风斩:旋转一圈击退周围小怪。' },
  { id: 712, name: '寒铁骑士阔剑', category: C, tags: ['武器', '近战重剑', '金属', '破盾'], value: 210, recipe: { 156: 5, 702: 2 }, station: 504, note: 'ATK +28;主动技 [Q] 破盾重劈:向前跃起猛劈地面,震晕 2×3 格内敌人 1.5 秒。' },
  { id: 713, name: '黑曜石烈焰巨剑', category: C, tags: ['武器', '近战重剑', '火焰', '锋利'], value: 380, recipe: { 110: 6, 710: 2 }, station: 504, note: 'ATK +48;挥砍自带火焰刀光,主动技 [Q] 熔岩裂地斩:向前发出一道 6 格远的火浪。' },
  { id: 714, name: '秘银疾风双刃', category: C, tags: ['武器', '近战双刀', '金属', '敏捷'], value: 320, recipe: { 157: 4, 703: 2 }, station: 504, note: 'ATK +38,攻速极快;主动技 [Q] 幻影突袭:化作残影向前穿梭 5 格并抓起路径上 1 只眩晕小怪扔向远处。' },
  { id: 715, name: '翠玉青竹连珠弓', category: C, tags: ['武器', '远程猎弓', '管状', '纤维'], value: 130, recipe: { 103: 4, 160: 2 }, station: 502, note: 'ATK +18;支持移动蓄力射击,主动技 [Q] 三连散射:扇形射出 3 支竹箭。' },
  { id: 716, name: '秘银追星神弓', category: C, tags: ['武器', '远程猎弓', '金属', '穿透'], value: 420, recipe: { 157: 4, 120: 3, 116: 2 }, station: 504, note: 'ATK +42;箭矢穿透 2 个目标,主动技 [Q] 箭雨天降:在目标 4×4 区域降下持续 3 秒的星光箭雨。' },
  { id: 717, name: '晨露新芽魔杖', category: C, tags: ['武器', '元素法杖', '木材', '治疗'], value: 150, recipe: { 104: 3, 116: 2 }, station: 504, note: 'MATK +20;发射自动微追踪的星光弹,主动技 [Q] 治愈春风圈:为周围 5 格内所有队友恢复 60 HP。' },
  { id: 718, name: '极光星辰魔导师杖', category: C, tags: ['武器', '元素法杖', '魔能', '陨星'], value: 520, recipe: { 117: 3, 157: 3 }, station: 504, note: 'MATK +52;主动技 [Q] 陨石星落:1 秒预警后召唤一颗Q版彩色流星砸向怪群,造成巨额范围伤害与弹飞。' },
  { id: 719, name: '【Boss传奇】果冻王弹跳皇冠锤', category: C, tags: ['武器', '传奇重锤', 'Boss遗物', '高弹'], value: 460, recipe: { 704: 1, 156: 4 }, station: 504, note: 'ATK +40,击退 +200%;主动技 [Q] 果冻王泰山压顶:高高跃起至 Z=3 猛砸地面,召唤 4 只友好小果冻帮全队咬怪。' },
  { id: 720, name: '【Boss传奇】绯月落英吹雪扇', category: C, tags: ['武器', '传奇法器', 'Boss遗物', '治疗'], value: 470, recipe: { 705: 1, 152: 4 }, station: 504, note: 'MATK +46;普攻扇出三道回旋樱花风刃,主动技 [Q] 落英幻境:全队获得 5 秒花瓣护盾(吸收伤害并移速 +40%)。' },
  { id: 721, name: '【Boss传奇】深渊紫晶破城盾锤', category: C, tags: ['武器', '传奇盾武', 'Boss遗物', '反伤'], value: 500, recipe: { 706: 1, 110: 4 }, station: 504, note: 'ATK +45,DEF +35;按住技能键架起绝对防御紫晶盾,将 Boss 的冲撞与弹幕 100% 反弹回去。' },
  { id: 722, name: '【Boss传奇】法老流沙毒刺枪', category: C, tags: ['武器', '传奇长枪', 'Boss遗物', '聚怪'], value: 510, recipe: { 707: 1, 115: 4 }, station: 504, note: 'ATK +50;攻击附带中毒破甲,主动技 [Q] 流沙星璇:在枪尖生成流沙漩涡把周围 5 格怪物全部聚拢到一起供队友群殴。' },
  { id: 723, name: '【Boss传奇】克洛诺斯磁暴齿轮炮', category: C, tags: ['武器', '传奇重炮', 'Boss遗物', '雷电'], value: 650, recipe: { 708: 1, 158: 8 }, station: 504, note: 'ATK +65;发射在怪物之间弹射 5 次的金色电弧齿轮,主动技 [Q] 时间凝滞力场:展开 6×6 钟表结界,冻结圈内所有怪物与弹幕 3 秒。' },
  { id: 724, name: '森之游侠软皮甲', category: C, tags: ['护甲', '皮革', '闪避'], value: 180, recipe: { 702: 4, 160: 2 }, station: 504, note: 'HP上限 +40,DEF +8,闪避率 +10%;轻便灵活,翻滚冷却缩减 20%。' },
  { id: 725, name: '寒铁重装骑士甲', category: C, tags: ['护甲', '金属', '重甲'], value: 300, recipe: { 156: 6, 161: 2 }, station: 504, note: 'HP上限 +100,DEF +22;受击硬直减半,最适合在前面顶住 Boss 吸引仇恨。' },
  { id: 726, name: '秘银星辉魔导袍', category: C, tags: ['护甲', '金属', '布', '冷却缩减'], value: 380, recipe: { 157: 4, 120: 4 }, station: 504, note: 'HP上限 +60,DEF +14,技能冷却 -25%;释放治疗或护盾技能时范围扩大 50%。' },
  { id: 727, name: '【Boss传奇】果冻王Q弹软糖甲', category: C, tags: ['护甲', '传奇', 'Boss遗物', '高弹'], value: 480, recipe: { 704: 1, 162: 6 }, station: 504, note: 'HP上限 +120,DEF +18;被动:受到近战攻击时,直接把攻击你的怪物像皮球一样弹飞 4 格。' },
  { id: 728, name: '【Boss传奇】紫晶荆棘反伤甲', category: C, tags: ['护甲', '传奇', 'Boss遗物', '反伤'], value: 540, recipe: { 706: 1, 156: 6 }, station: 504, note: 'HP上限 +160,DEF +32;被动:减免 30% 伤害,并将所受伤害的 150% 化作紫晶尖刺反伤周围敌人。' },
  { id: 729, name: '夜影吸血蝙蝠斗篷', category: C, tags: ['背饰', '奇物', '吸血', '飞行'], value: 260, recipe: { 709: 2, 161: 3 }, station: 504, note: '移速 +10%;每次武器或技能命中野生怪物时,恢复自身 3 HP。' },
  { id: 730, name: '疾风二段跳羽戒', category: C, tags: ['饰品', '奇物', '敏捷', '位移'], value: 330, recipe: { 117: 1, 157: 2 }, station: 504, note: '允许角色在空中额外进行一次翻滚冲刺或二段跳,轻松越过 Boss 激光环。' },
  { id: 731, name: '同伴共鸣友爱徽章', category: C, tags: ['饰品', '团队', '光环', '精华'], value: 290, recipe: { 115: 2, 130: 3 }, station: 504, note: '周围 8 格内每有 1 名同房间队友,自身攻击力与防御力各提升 +5%(最高叠加至 +40%)。' },
  { id: 732, name: '甜莓瞬回生命药水', category: C, tags: ['药水瓶', '消耗品', '恢复'], value: 70, recipe: { 165: 1, 164: 1 }, station: 505, note: '饮用后瞬间恢复 100 HP(冷却 8 秒);也可直接扔向残血队友触发范围溅射治疗。' },
  { id: 733, name: '复苏天使羽毛笔', category: C, tags: ['团战消耗', '布', '复活', '精华'], value: 190, recipe: { 119: 2, 130: 1 }, station: 505, note: '扔向变成“幽灵泡泡”倒地的队友,哪怕隔着 6 格远也能瞬间将其满血复活并赋予 3 秒无敌。' },
  { id: 734, name: '【祭品】皇家十倍甜莓布丁', category: C, tags: ['Boss召唤', '祭品', '甜食', '草甸'], value: 340, recipe: { 121: 20, 128: 5, 163: 5 }, station: 508, note: '放置在晨曦草甸祭坛上,召唤【草甸Boss:果冻国王·波波大帝】。' },
  { id: 735, name: '【祭品】黄金香脆松木图腾', category: C, tags: ['Boss召唤', '祭品', '木材', '河谷'], value: 380, recipe: { 101: 30, 122: 10, 155: 4 }, station: 504, note: '放置在金秋河谷祭坛上,召唤【河谷Boss:巨型机甲河狸·大坝粉碎者】。' },
  { id: 736, name: '【祭品】绯月千年祈愿御币', category: C, tags: ['Boss召唤', '祭品', '木材', '绯樱'], value: 430, recipe: { 102: 20, 120: 5, 130: 5 }, station: 504, note: '放置在绯樱高地神社祭坛上,召唤【绯樱Boss:千年垂枝妖狐·绯月】。' },
  { id: 737, name: '【祭品】共鸣深渊紫晶核', category: C, tags: ['Boss召唤', '祭品', '魔导', '溶洞'], value: 470, recipe: { 116: 15, 156: 10 }, station: 504, note: '放置在地下溶洞核心祭坛上,召唤【溶洞Boss:深渊晶甲巨蟹·克拉肯】。' },
  { id: 738, name: '【祭品】太阳神金甲虫圣杯', category: C, tags: ['Boss召唤', '祭品', '金属', '绿洲'], value: 520, recipe: { 115: 10, 108: 20, 126: 10 }, station: 504, note: '放置在沙漠金字塔祭坛上,召唤【绿洲Boss:黄金沙暴法老蝎】。' },
  { id: 739, name: '【祭品】皇家焦糖彩虹姜饼屋', category: C, tags: ['Boss召唤', '祭品', '甜食', '甜点'], value: 540, recipe: { 105: 20, 162: 10, 128: 5 }, station: 505, note: '放置在甜点奇境祭坛上,召唤【甜点Boss:暴食翻糖姜饼巨魔】。' },
  { id: 740, name: '【祭品】星穹唤鲸八音海螺', category: C, tags: ['Boss召唤', '祭品', '魔能', '云海'], value: 600, recipe: { 117: 8, 119: 20 }, station: 504, note: '在浮空云海码头吹响,召唤【云海Boss:星穹幻彩云鲸】。' },
  { id: 741, name: '【祭品】古老黄金上弦发条钥', category: C, tags: ['Boss召唤', '祭品', '机械', '遗迹'], value: 720, recipe: { 158: 20, 157: 10, 110: 10 }, station: 504, note: '插入发条遗迹中央钟盘,唤醒终极 Boss【远古发条时间巨像·克洛诺斯】。' },
  { id: 742, name: '宠物牵引红丝带', category: C, tags: ['驯养工具', '纤维', '宠物'], value: 70, recipe: { 120: 2, 166: 1 }, station: 505, note: '给已驯化的野生动物系上蝴蝶结,可命令其“跟随出战”、“留守牧场”或“帮忙背 8 格物品”。' },
  { id: 743, name: '云朵陆行鸟骑乘鞍', category: C, tags: ['坐骑装备', '皮革', '金属', '骑乘'], value: 200, recipe: { 702: 4, 155: 2 }, station: 504, note: '给驯服的【彩虹陆行鸟】或【滚石穿山甲】装上后,玩家可直接骑乘狂奔(移速 +60%)。' },
  { id: 744, name: '怪物图鉴照相机', category: C, tags: ['收集工具', '金属', '玻璃', '魔导'], value: 230, recipe: { 155: 2, 154: 2, 116: 1 }, station: 504, note: '给野生动物或正在放技能的 Boss 拍照收录进全房共享【生态绘本图鉴】,全房永久获得对该怪物的伤害加成 +10%。' },
  { id: 745, name: '怪物生态诱捕笼', category: C, tags: ['沙盒机关', '金属', '木材', '捕捉'], value: 160, recipe: { 156: 4, 151: 4 }, station: 504, note: '放在地上装入甜莓诱饵;野生小怪走进笼子吃果子时自动落锁将其活捉,可连笼子一起抱回自建动物园展示。' },
];

/* ─────────────────────────── 汇总与查询索引 ─────────────────────────── */

export const ITEM_LIST: readonly ItemDef[] = [
  ...NATURAL, ...REFINED, ...TOOLS, ...PRANKS, ...FLOORS,
  ...BUILDINGS, ...AUTOMATION, ...FURNITURE, ...FOODS, ...COMBAT,
];

export const ITEM_BY_ID: ReadonlyMap<number, ItemDef> = new Map(ITEM_LIST.map((i) => [i.id, i]));

export const TOTAL_ITEM_COUNT = 320;

/** 十大分表的结构化清单,供 §3 手册章节与验证脚本核对。 */
export const ITEM_TABLES: readonly { key: string; title: string; range: [number, number]; count: number; ids: readonly number[] }[] = [
  { key: '3.1', title: '自然采集与奇幻矿物资源表', range: [101, 130], count: 30, ids: NATURAL.map((i) => i.id) },
  { key: '3.2', title: '半成品加工材料与工业元件表', range: [151, 170], count: 20, ids: REFINED.map((i) => i.id) },
  { key: '3.3', title: '生产工具与生活专精装备表', range: [201, 218], count: 18, ids: TOOLS.map((i) => i.id) },
  { key: '3.4', title: '同屏合作与整蛊玩具装备表', range: [221, 255], count: 35, ids: PRANKS.map((i) => i.id) },
  { key: '3.5', title: '地表铺装与物理机关地板表', range: [301, 330], count: 30, ids: FLOORS.map((i) => i.id) },
  { key: '3.6', title: '建筑墙体门窗屋顶与高低差构件表', range: [351, 385], count: 35, ids: BUILDINGS.map((i) => i.id) },
  { key: '3.7', title: '魔能电路自动化物流与竞技设施表', range: [401, 440], count: 40, ids: AUTOMATION.map((i) => i.id) },
  { key: '3.8', title: '工坊设备家具与动态房间核心件表', range: [501, 537], count: 37, ids: FURNITURE.map((i) => i.id) },
  { key: '3.9', title: '欢聚料理与搞怪时装头饰表', range: [601, 630], count: 30, ids: FOODS.map((i) => i.id) },
  { key: '3.10', title: '战利品武器护甲与Boss召唤祭品表', range: [701, 745], count: 45, ids: COMBAT.map((i) => i.id) },
];

export function itemName(id: number): string {
  return ITEM_BY_ID.get(id)?.name ?? `未知物品#${id}`;
}

export function itemValue(id: number): number {
  return ITEM_BY_ID.get(id)?.value ?? 0;
}

export function itemTags(id: number): string[] {
  return ITEM_BY_ID.get(id)?.tags ?? [];
}

export function expandRecipe(recipe: Record<number, number>, batches = 1): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(recipe)) out[Number(k)] = v * batches;
  return out;
}

/* ═══════════════ 「任意 X」留白槽的配方匹配(CR-17)═══════════════ */

/**
 * 单件材料能否顶替某个留白槽。
 *
 * 判据是**物品 tag** 而非 ID —— 这正是「任意染料」的语义:
 * 手册写的是类别,不是具体某一件。
 */
export function satisfiesAnyTagSlot(itemId: number, slot: readonly string[]): boolean {
  const tags = ITEM_BY_ID.get(itemId)?.tags;
  if (tags === undefined) return false;
  /* 槽内 tag 之间取「或」:写 ['染料'] 即任一带该 tag 的都行;
     写成多个 tag 时同理,它们互为备选,不是全要。 */
  return slot.some((t) => tags.includes(t));
}

/** 找出全部能满足某留白槽的物品 ID(升序)。 */
export function itemsMatchingAnyTagSlot(slot: readonly string[]): number[] {
  return ITEM_LIST.filter((i) => satisfiesAnyTagSlot(i.id, slot)).map((i) => i.id).sort((a, b) => a - b);
}

export interface RecipeMatchResult {
  ok: boolean;
  /** 未满足的原因(ok=true 时为空) */
  reason?: string;
  /** 实际被消耗的 ID -> 数量(含留白槽选中的那件) */
  consumed: Record<number, number>;
}

/**
 * 按 tag 留白匹配配方。
 *
 * `have` 是「背包里有什么」的 `ID -> 数量`。判定分两步,顺序不能颠倒:
 *   1. **先扣确定件**(`recipe`):这些是手册指名道姓的固有材料,缺一不可;
 *   2. **再逐个填留白槽**(`recipeAnyTag`):每个槽挑一件**仍有余量**的合格材料消耗 1 个。
 *
 * ⚠️ 为什么必须走 `consumed` 记账而不是简单查集合:
 *   `356` 需要「任意染料 ×2」,若只判「背包里有染料」就会**用 1 个染料冒充 2 个**。
 *   本实现按槽逐个扣减,数量不足时返回 `ok=false`。
 *
 * 注意:`recipeAnyTag` 只是**放宽**留白处,**不会**放宽固有材料 ——
 * `244 果冻怪伪装壳` 手册指名 `168 翡翠森林染料`,它没有留白槽,
 * 换成 167 依然做不出来。
 */
export function matchRecipeByTags(
  craftId: number,
  have: Record<number, number>,
): RecipeMatchResult {
  const def = ITEM_BY_ID.get(craftId);
  if (def === undefined) return { ok: false, reason: `未知产物 #${craftId}`, consumed: {} };
  if (def.recipe === undefined && def.recipeAnyTag === undefined) {
    return { ok: false, reason: `#${craftId} 没有配方`, consumed: {} };
  }

  const pool: Record<number, number> = {};
  for (const [k, v] of Object.entries(have)) {
    const n = Math.max(0, Math.trunc(v));
    if (n > 0) pool[Number(k)] = n;
  }
  const consumed: Record<number, number> = {};
  const take = (id: number, n: number): void => {
    pool[id] -= n;
    consumed[id] = (consumed[id] ?? 0) + n;
  };

  const slots = def.recipeAnyTag ?? [];
  /*
   * 确定件里那些「本身就是某个留白槽的合格件」的键,是**该槽的登记代表**,
   * 不是额外的硬性要求 —— 否则 `237` 会变成「既要有 166 又要任一带染料」,
   * 玩家拿 167 仍然做不出来,CR-17 等于没修。
   *
   * 保留这些键在 `recipe` 里的理由:WS-FND-06 的对照表与 verify.ts 的引用闭合
   * 都按 `recipe` 的现有键断言,删键会撞红**写域外**用例。
   * ⇒ 键保留(数据不变),判定时由所在槽接管(语义变对)。
   */
  const repIds = new Set<number>();
  for (const [k] of Object.entries(def.recipe ?? {})) {
    const id = Number(k);
    if (slots.some((slot) => satisfiesAnyTagSlot(id, slot))) repIds.add(id);
  }

  /* 第 1 步:确定件 —— 固有材料不因留白而放宽 */
  for (const [k, need] of Object.entries(def.recipe ?? {})) {
    const id = Number(k);
    if (repIds.has(id)) continue; /* 由留白槽接管 */
    const got = pool[id] ?? 0;
    if (got < need) {
      return {
        ok: false,
        reason: `缺 #${id}×${need - got}(需 ${need},有 ${got})`,
        consumed,
      };
    }
    take(id, need);
  }

  /* 第 2 步:逐个填留白槽,每个槽消耗 1 件合格材料 */
  for (const slot of slots) {
    const pick = itemsMatchingAnyTagSlot(slot).find((id) => (pool[id] ?? 0) > 0);
    if (pick === undefined) {
      return {
        ok: false,
        reason: `留白槽 [${slot.join('|')}] 无可用材料(背包余量不足)`,
        consumed,
      };
    }
    take(pick, 1);
  }

  return { ok: true, consumed };
}

/** 该产物的完整配方是否含因 tag 而放开的留白槽。 */
export function hasAnyTagSlot(itemId: number): boolean {
  return (ITEM_BY_ID.get(itemId)?.recipeAnyTag ?? []).length > 0;
}
