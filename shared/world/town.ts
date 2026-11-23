/**
 * **营地里的「小镇」平面图** —— 纯函数模块:零 `import`、零随机、零时间依赖。
 *
 * ## 为什么需要它
 *
 * 世界里此前**只有广场,没有城镇**:`shared/world/design.ts` 只把营地铺成
 * 「24×24 红砖地砖 305 + 中心 8×8 大理石 306 + 一圈地标物件」,所以
 * 建筑构件(墙体 351~385)与家具(501~537)在 `shared/constants/items.ts` 里
 * **数据齐全、世界里一件都没用**。玩家睁眼看到的是一片空地加几个立牌,
 * 愿景里「有城镇」这一条(V6)因此只完成了一半。
 *
 * 本模块把「城镇」落成**一张手放的平面图**:
 *
 *   - 6 座房子(每座 = 矩形墙圈 + 朝街的一个门 + 内圈屋顶 + 一个烟囱);
 *   - 一条南北向的**街**(两侧各一列房屋门面,街轴中央零立牌 ⇒ 真的走得通);
 *   - 一个**市场角**(513 储物箱 + 516 任务板 + 522 街灯,摆在街北口);
 *   - 街灯 522 沿街两列,在既有地标处**留缺口**(先算后剔,见下)。
 *
 * ## 平面图(世界格坐标;x 只画到 91,右边 92..107 是广场东半 + 大理石中心)
 *
 * ```text
 *   x →   84 85 86 87 88 89 90 91
 * y 84     #  .  .  .  .  .  .  .     # = 既有地标(角柱 352),本模块跳过
 * y 85     .  B  T  L  .  .  .  .     B 513 储物箱 / T 516 任务板 / L 522 街灯
 * y 86     .  .  .  L  .  L  .  .     ← 街北口两盏灯
 * y 87     .  H  H  H  s  H  H  H     H 墙(351 原木 / 352 红砖)
 * y 88     .  w  r  d  s  d  r  w     d 门(363,朝街)/ w 窗(370,后墙正对门)
 * y 89     .  H  c  H  s  H  c  H     r 屋顶(372 红瓦 / 373 茅草)/ c 烟囱(384)
 * y 90     .  H  H  H  s  H  H  H     s 街轴(本模块在 x=88 上零立牌)
 * y 91     .  .  .  L  .  L  .  .     . 空地(广场红砖 305,本模块不动 floor 层)
 * y 92     .  H  H  H  s  H  H  H
 * y 93     .  w  r  d  s  d  r  w     屋 2 / 屋 5(中排)
 * y 94     .  H  c  H  s  H  c  H
 * y 95     .  H  H  H  s  H  H  H
 * y 96     .  .  .  L  .  L  .  .
 * y 97     .  H  H  H  s  H  H  H
 * y 98     .  w  r  d  s  d  r  w     屋 3 / 屋 6(南排)
 * y 99     .  H  c  H  s  H  c  H
 * y 100    .  H  H  H  s  H  H  H
 * y 101    .  .  .  L  .  L  .  .
 * y 102    .  .  .  .  .  .  .  .
 * y 103    .  .  .  .  .  .  .  .     (行 102~105:街南口的一片空地)
 * y 104    .  .  .  .  .  .  .  .
 * y 105    .  .  .  .  .  .  .  .
 * y 106    .  .  .  #  .  L  #  .     # = 既有地标(87 储物箱 / 90 高炉);x=87 那一盏灯被剔除
 * y 107    #  .  .  .  .  .  .  .     # = 既有地标(角柱 352)
 * ```
 *
 * ## 两条结构不变量(判据 `tests/WS-FND-191-town.test.ts` 按坐标验算,不是数个数)
 *
 *   1. **房子**:占地是 3×4 的实心矩形;墙圈上恰好一个门(363),门贴 `facing`
 *      那一侧的墙(朝街);后墙正对门的那一格是观景窗(370);圈上其余是墙
 *      (351/352);内圈 2 格是屋顶(372/373),最后一格是烟囱(384)。
 *   2. **街**:街轴列(`cx − 8` = 88)在整条街上**零立牌** ⇒ 从街北口走到街南口
 *      不会被自己的规划堵住。
 *
 * ## 先算后剔(为什么不是「随机挪一格」)
 *
 * `planTown()` 先把**完整意图**算出来(所有房子 + 所有街灯 + 市场角),
 * 再用**三个确定性的谓词**过滤:
 *
 *   1. 出 `[cx − half, cx + half − 1]` 的格子(裁边,两个轴同区间);
 *   2. `TOWN_RESERVED` 里已有的地标格 —— 这些位置是 `design.ts` 的 `LANDMARKS`
 *      写的实物(纪念碑 750 / 篝火 501 / 加工一条街的 502~506·513·516 / 四角 352),
 *      压上去 = 覆盖既有内容;
 *   3. 广场中心 8×8 大理石(`[cx − 4, cx + 3]`,见 `design.ts` 4.3 的第二个循环)。
 *
 * **取舍写清楚**:大理石是**广场自己的** ⇒ 跟着 `opts.center` 走(广场挪了,
 * 它的圆心大理石跟着挪);`TOWN_RESERVED` 是**世界里既有的实物** ⇒ 绝对坐标,
 * 永不跟着 `opts.center` 走。
 *
 * 实测被剔掉的正是**街南口西侧那一盏灯**:它的意图坐标是 `(cx − 9, cy + 10)`
 * = `(87, 106)`,而 `design.ts` 的 `513 储物箱` 就在那一格上。
 * ⚠️ 本规划器**不给**「挪一格」的兜底 —— 挪去 (86,106) 看起来更圆满,但那是
 * 猜调用方的意图;剔掉之后缺口本身也是可读信息(街灯列在既有地标处断了)。
 *
 * ## 密度上限(为什么 `TOWN_MAX_PLACEMENTS` 存在)
 *
 * `obj` 层每一条 = `client/src/stage/obj_sprites.ts` 里**一个立牌实例**
 * (接线后按图集格合批,实例总数受 `PROP_INSTANCE_BUDGET = 16384` 约束)。
 * 整份规划的实测条数是 **84**(6 房 × 12 + 9 灯 + 市场 3),上限取 96:
 *
 *   - 下限锚在结构上:4 座房(判据要求的最少座数)× 12 = 48 ⇒ 上限必须 > 48;
 *   - 上限锚在「别把营地铺满」上:营地 24×24 = 576 格,96 是它的 1/6;
 *   - 96 相对实测 84 留 ~14% 余量,接线方加两三件家具不用改常量。
 *
 * ## 本模块不做什么
 *
 *   - **不写 `floor` 层**:街道的地砖(如 302 鹅卵石)由接线方决定 ——
 *     本模块只产出 `obj` 层(item id + 坐标 + 为什么)。
 *   - **不 import 任何东西**(含 `items.ts` 与 `design.ts`):
 *     `design.ts` 会反过来调 `planTown()` ⇒ 互相 import 会成环;
 *     id 的存在性由判据逐条对 `ITEM_BY_ID` 断言,常量重复由判据钉住
 *     (`TOWN_PLAZA_CENTER` ↔ `DESIGN_CENTER`,与 `floorSlotOfId` 的两份实现同款手法)。
 */

/** 一条立牌级的规划记录:世界格坐标 + 物品 id + 为什么摆在这里。 */
export interface TownPlacement {
  /** 世界格坐标 x(格,不是像素、不是块内偏移)。 */
  x: number;
  /** 世界格坐标 y。 */
  y: number;
  /** `shared/constants/items.ts` 里的物品 id(`obj` 层的值)。 */
  obj: number;
  /** 为什么这一格摆这个(给人读的证据,判据断言它非空)。 */
  why: string;
}

/**
 * 广场中心(世界格坐标)。
 *
 * ⚠️ 与 `design.ts` 的 `DESIGN_CENTER` **同值(96)**,这里是**第二份**,
 * 且刻意不 import:`design.ts` 会调 `planTown()` ⇒ 互相 import 成环。
 * 两份由判据 `WS-FND-191` 钉死(`TOWN_PLAZA_CENTER === DESIGN_CENTER`)。
 */
export const TOWN_PLAZA_CENTER = 96;

/** 营地矩形半径:营地 = `[center − half, center + half − 1]`(两个轴同区间,24×24,与 `design.ts` 的 `campHalf` 同口径)。 */
export const TOWN_CAMP_HALF = 12;

/**
 * 一次 `planTown()` 最多能产出多少条 `obj` 规划(密度上限)。
 *
 * 理由见文件头「密度上限」:每条 = 一个立牌实例,营地只有 576 格。
 */
export const TOWN_MAX_PLACEMENTS = 96;

/**
 * `design.ts#LANDMARKS` 已经占住的格子(**绝对世界坐标**,逐格对应如下)。
 *
 * 规划器**永远**跳过这些格;这份清单是判据的输入,不是装饰 ——
 * 没有它,「城镇不压既有地标」这条就只能靠人看截图。
 *
 * ```text
 * (96,89)             750 纯金通关纪念碑(广场中心北 7)
 * (96,103)            501 暖心篝火茶座(广场中心南 7)
 * (87,106)(90,106)(93,106)(96,106)(99,106)(102,106)(105,106)
 *                     502 木工台 / 503 高炉 / 504 铁砧 / 505 染缸 / 506 大汤锅 / 513 储物箱 / 516 任务板
 * (84,84)(107,84)(84,107)(107,107)
 *                     352 复古红砖承重墙(广场四角柱)
 * ```
 */
export const TOWN_RESERVED: readonly { x: number; y: number }[] = [
  { x: 96, y: 89 },   /* 750 纪念碑 */
  { x: 96, y: 103 },  /* 501 篝火 */
  { x: 87, y: 106 },  /* 513 储物箱 */
  { x: 90, y: 106 },  /* 502 木工台 */
  { x: 93, y: 106 },  /* 503 高炉 */
  { x: 96, y: 106 },  /* 504 铁砧 */
  { x: 99, y: 106 },  /* 505 染缸 */
  { x: 102, y: 106 }, /* 506 大汤锅 */
  { x: 105, y: 106 }, /* 516 任务板 */
  { x: 84, y: 84 },   /* 352 角柱 */
  { x: 107, y: 84 },  /* 352 角柱 */
  { x: 84, y: 107 },  /* 352 角柱 */
  { x: 107, y: 107 }, /* 352 角柱 */
];

/* ═══════════════ 内容 id(全部来自 `shared/constants/items.ts`)═══════════════
 * 号段:建筑构件 351~385、家具 501~537。判据逐条对 `ITEM_BY_ID` 断言它们真实存在。
 * 本模块不 import items.ts(见文件头),所以这里只写数字。 */

/** 351 暖松原木圆墙(墙圈,中排/南排)。 */
const WALL_WOOD = 351;
/** 352 复古红砖承重墙(墙圈,北排 —— 与广场的红砖地砖同色系)。 */
const WALL_BRICK = 352;
/** 363 温馨圆拱小木门(1×1,朝街的缺口)。 */
const DOOR = 363;
/** 370 暖阳木框观景窗(嵌入墙体,挂在后墙正对门那一格)。 */
const WINDOW = 370;
/** 372 暖红陶瓦斜屋顶(北排红砖屋)。 */
const ROOF_BRICK = 372;
/** 373 森林茅草厚屋顶(中排/南排原木屋)。 */
const ROOF_THATCH = 373;
/** 384 屋顶炊烟小烟囱(屋顶件,每座屋一格)。 */
const CHIMNEY = 384;
/** 522 暖橘光铁艺路灯(街灯)。 */
const LAMP = 522;
/** 516 小镇悬赏与任务板(市场角)。 */
const BOARD = 516;
/** 513 分类图标储物箱(市场角)。 */
const CHEST = 513;

/** 一格物品 id 用的 `x,y` 键(过滤用;不用对象键以免序不稳)。 */
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** 一座房子的手放规格(世界格坐标;由 `planTown` 从「相对中心偏移」算出来)。 */
interface HouseSpec {
  /** 门面朝向:门开在街的哪一侧(街轴在房子之间)。 */
  facing: 'east' | 'west';
  /** 占地左上角。 */
  x0: number;
  y0: number;
  /** 占地宽高(本布局固定 3×4:内圈因此是 1 列 × 2 行)。 */
  w: number;
  h: number;
  /** 墙圈材质。 */
  wall: number;
  /** 墙材质的中文名(写进 `why`)。 */
  wallName: string;
  /** 屋顶材质。 */
  roof: number;
  /** 屋顶材质的中文名(写进 `why`)。 */
  roofName: string;
  /** 这一座的名字(写进 `why`,判据与截图对账用)。 */
  name: string;
}

/** 布置一座房子:墙圈(含一个门/一个窗)+ 内圈屋顶(含一个烟囱)。 */
function housePlacements(spec: HouseSpec): TownPlacement[] {
  const { x0, y0, w, h } = spec;
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  /** 贴街那一侧的墙列 = 门所在列;对面那列 = 后墙,挂窗。 */
  const doorX = spec.facing === 'east' ? x1 : x0;
  const backX = spec.facing === 'east' ? x0 : x1;
  /** 门开在墙圈的「北起第二行」——1 格门在 4 行高的墙上居中偏上,不压角。 */
  const doorY = y0 + 1;

  const out: TownPlacement[] = [];
  /* 1 墙圈(外围一圈格子,扫描序 y 外 x 内 ⇒ 同一份规格必得同一个数组)。 */
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const onRing = x === x0 || x === x1 || y === y0 || y === y1;
      if (!onRing) continue;
      if (x === doorX && y === doorY) {
        out.push({ x, y, obj: DOOR, why: `${spec.name} 朝街的缺口:门 ${DOOR}(1×1 圆拱小木门),开在街侧墙列 x=${doorX}` });
        continue;
      }
      if (x === backX && y === doorY) {
        out.push({ x, y, obj: WINDOW, why: `${spec.name} 后墙观景窗 ${WINDOW}(嵌入墙体),正对门 (${doorX},${doorY})` });
        continue;
      }
      out.push({ x, y, obj: spec.wall, why: `${spec.name} 墙圈 ${spec.wall}(${spec.wallName})` });
    }
  }
  /* 2 内圈屋顶:前排铺瓦,最后一格换烟囱(384 是屋顶件,不是另起一格)。 */
  for (let y = y0 + 1; y <= y1 - 1; y += 1) {
    for (let x = x0 + 1; x <= x1 - 1; x += 1) {
      if (y === y1 - 1) {
        out.push({ x, y, obj: CHIMNEY, why: `${spec.name} 屋顶烟囱 ${CHIMNEY}(后排屋顶上)` });
        continue;
      }
      out.push({ x, y, obj: spec.roof, why: `${spec.name} 屋顶行 ${spec.roof}(${spec.roofName})` });
    }
  }
  return out;
}

/**
 * 规划营地里的城镇(**全部手放常量**,无 `Math.random`、无时间)。
 *
 * `opts.center` = 广场中心(默认 `TOWN_PLAZA_CENTER` = 96);
 * `opts.half` = 营地半径(默认 `TOWN_CAMP_HALF` = 12 ⇒ 24×24)。
 *
 * 返回值的排序是 `(y, x, obj)` 升序 —— 与规格书写顺序无关,
 * 于是「同一份布局必得同一个数组」不依赖我以后有没有重排代码。
 *
 * ⚠️ `half < 12` 时规划会被**裁边**:谓词只按坐标剔格,不修形状 ⇒
 * 可能出现「半座房子」。本模块只保证**默认营地(24×24)下结构成立**;
 * 修形 = 猜调用方的意图,不做。
 */
export function planTown(opts: { center?: { x: number; y: number }; half?: number } = {}): TownPlacement[] {
  const cx = Math.trunc(opts.center?.x ?? TOWN_PLAZA_CENTER);
  const cy = Math.trunc(opts.center?.y ?? TOWN_PLAZA_CENTER);
  const half = Math.max(1, Math.trunc(opts.half ?? TOWN_CAMP_HALF));

  /* ── 1 先算:完整意图(相对中心的偏移全部写在这里;改这里 = 改城镇平面图)── */
  /** 三排房屋的左上角 y 偏移(每排 4 行高 ⇒ 排间天然留 1 行横巷)。 */
  const ROW_DY: readonly number[] = [-9, -4, 1];
  /** 每排的名字与材质:北排红砖(372 红瓦),中/南排原木(373 茅草)。 */
  const ROW_STYLE: readonly { rowName: string; wall: number; wallName: string; roof: number; roofName: string }[] = [
    { rowName: '北排', wall: WALL_BRICK, wallName: '复古红砖承重墙', roof: ROOF_BRICK, roofName: '暖红陶瓦斜屋顶' },
    { rowName: '中排', wall: WALL_WOOD, wallName: '暖松原木圆墙', roof: ROOF_THATCH, roofName: '森林茅草厚屋顶' },
    { rowName: '南排', wall: WALL_WOOD, wallName: '暖松原木圆墙', roof: ROOF_THATCH, roofName: '森林茅草厚屋顶' },
  ];
  /** 街轴相对中心的 x 偏移(街轴列 = `cx − 8` = 88;本模块在这一列上零立牌)。 */
  const STREET_DX = -8;
  /** 街西侧房屋(x0 = cx − 11,占 3 列 = 85~87)与街东侧房屋(x0 = cx − 7,占 3 列 = 89~91)。 */
  const WEST_DX = -11;
  const EAST_DX = -7;
  /** 市场角三件(街北口那一行,从左到右:储物箱 / 任务板 / 街灯)。 */
  const MARKET_DY = -11;
  const MARKET_X: readonly { dx: number; obj: number; why: string }[] = [
    { dx: -11, obj: CHEST, why: `市场角 ${CHEST} 分类图标储物箱(24 格,摆在街北口西端)` },
    { dx: -10, obj: BOARD, why: `市场角 ${BOARD} 小镇悬赏与任务板(每日刷 3 个全房悬赏)` },
    { dx: -9, obj: LAMP, why: `市场角 ${LAMP} 街灯(照市场角,也把野怪挡在营地外)` },
  ];
  /** 街灯两列(x = cx − 9 / cx − 7,即街轴左右各一列)与五行(y = cy − 10 / −5 / 0 / +5 / +10)。 */
  const LAMP_DX: readonly number[] = [-9, -7];
  const LAMP_DY: readonly number[] = [-10, -5, 0, 5, 10];
  const LAMP_NAME: readonly string[] = ['街北口', '第一横巷口', '第二横巷口', '街南段', '街南口(与既有加工一条街同一行)'];

  const all: TownPlacement[] = [];

  for (let r = 0; r < ROW_DY.length; r += 1) {
    const style = ROW_STYLE[r];
    const y0 = cy + ROW_DY[r];
    const name = (side: string): string => `${style.rowName}${style.wall === WALL_BRICK ? '红砖屋' : '原木屋'}(${side})`;
    /* 街西那一座:门开在自己东墙(x0 + 2 = 街西列),面向街轴(+x 方向)。 */
    all.push(...housePlacements({
      facing: 'east',
      x0: cx + WEST_DX, y0, w: 3, h: 4,
      wall: style.wall, wallName: style.wallName, roof: style.roof, roofName: style.roofName,
      name: name('街西'),
    }));
    /* 街东那一座:门开在自己西墙(街东列),面向街轴(−x 方向)。 */
    all.push(...housePlacements({
      facing: 'west',
      x0: cx + EAST_DX, y0, w: 3, h: 4,
      wall: style.wall, wallName: style.wallName, roof: style.roof, roofName: style.roofName,
      name: name('街东'),
    }));
  }

  /* 街灯:两列 × 五行 = 10 盏意图(其中 1 盏与既有地标撞格,由第 2 步剔掉)。 */
  for (let i = 0; i < LAMP_DY.length; i += 1) {
    for (const dx of LAMP_DX) {
      all.push({
        x: cx + dx,
        y: cy + LAMP_DY[i],
        obj: LAMP,
        why: `街灯 ${LAMP}(${LAMP_NAME[i]},街${dx === -9 ? '西' : '东'}侧第 ${i + 1} 盏)—— 街轴在 x=${cx + STREET_DX}`,
      });
    }
  }

  /* 市场角:街北口那一行的三件。 */
  for (const m of MARKET_X) {
    all.push({ x: cx + m.dx, y: cy + MARKET_DY, obj: m.obj, why: m.why });
  }

  /* ── 2 后剔:三个确定性谓词(出界 / 既有地标 / 广场中心大理石)── */
  const reserved = new Set(TOWN_RESERVED.map((p) => cellKey(p.x, p.y)));
  const kept = all.filter((p) => {
    /* (a) 出营地(裁边) */
    if (p.x < cx - half || p.x > cx + half - 1) return false;
    if (p.y < cy - half || p.y > cy + half - 1) return false;
    /* (b) 既有地标(绝对坐标) */
    if (reserved.has(cellKey(p.x, p.y))) return false;
    /* (c) 广场中心 8×8 大理石(跟广场中心走) */
    if (p.x >= cx - 4 && p.x <= cx + 3 && p.y >= cy - 4 && p.y <= cy + 3) return false;
    return true;
  });

  /* ── 3 排序:与规格顺序解耦,同一份布局必得同一个数组 ── */
  kept.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.obj - b.obj));
  return kept;
}

/**
 * 城镇范围(默认规划的包围盒),供判据与后续「城镇范围」查询用。
 *
 * 空规划(例如 `half` 小到什么都放不下)⇒ 退化为中心一格,而**不是**
 * `x0 > x1` 的空区间:后者要求每个调用方都记得先判一次,是更容易出错的形态。
 */
export function townFootprint(): { x0: number; y0: number; x1: number; y1: number } {
  const plan = planTown();
  if (plan.length === 0) {
    return { x0: TOWN_PLAZA_CENTER, y0: TOWN_PLAZA_CENTER, x1: TOWN_PLAZA_CENTER, y1: TOWN_PLAZA_CENTER };
  }
  let x0 = plan[0].x;
  let y0 = plan[0].y;
  let x1 = plan[0].x;
  let y1 = plan[0].y;
  for (const p of plan) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}
