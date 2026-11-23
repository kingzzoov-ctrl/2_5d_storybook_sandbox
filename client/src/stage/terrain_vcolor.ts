/**
 * WS-09 U2 / 地形**顶点色** —— 渲染不再依赖纹理图集。
 *
 * ## 为什么弃用纹理图集
 *
 * 早先地形靠 `uAlbedo` 图集 + UV:每种地砖在 1024×1024 图集里占一格,
 * 于是「加一种地砖」= 「重画图集 + 重算 UV + 重传纹理」三件事同时发生。
 * 本仓地砖种类在 U10 裁决后**扩到 u16**(>64 种),图集网格随之变成
 * 64×64 格 → 单图集 4096×4096 纹理,显存与采样都不可接受。
 *
 * 顶点色把「材质基色」搬进顶点属性:
 *   - 每个顶点 3 个 float(RGB),长度恒等于 `顶点数 × 3`;
 *   - 加一种地砖只需在 `ELEV_BASE_RGB` / 调色表里加一行,不碰任何纹理;
 *   - 与 `chunk_geometry` 的顶点写出**同源**:颜色在 `pushVertex` 处一起写,
 *     不存在「几何更新了、颜色忘更新」的错位。
 *
 * ## 为什么顶面按**材质**着色(WS-FND-180)
 *
 * 早先顶面的颜色只有一个来源:`faceColor(elevLayerOfZ(z), true)` —— 顶点色是**海拔层**
 * 的函数,而海拔层只有 4 个值。于是 1024×1024 的世界在屏幕上只有 **4 色**:草地、
 * 金沙滩、浅水、熔岩、冰砖、榻榻米……全是同一块绿/灰/蓝 —— 「这块地表面是什么」
 * 在画面上不存在,而判据仍然全绿(长度、值域、没有采样器都查不出语义丢失)。
 *
 * 材质本来就带在格子里(`shared/types/tile.ts` 的 `unpackTile`):
 *   - `base`(**BaseFluid**)     = 地表本身是什么(草/土/金沙/岩/浅水/温泉/黏液/熔岩/巧克力);
 *   - `floor`(6 位**槽位号**)  = 表面铺了什么铺装(槽位 1..30 ↔ 地砖物品 301..330,
 *                                槽位 31..63 = UGC 像素地毯变体;语义见
 *                                `server/src/world/chunk.ts` 的 `FLOOR_PALETTE` /
 *                                `floorSlotOfId`。客户端不 import server,故本文件独立持表)。
 * ⇒ 顶面改成 `topColorOf(层, base, floor)`:**铺装优先,其次地表,最后才回落海拔层**
 *   (表与取值顺序见下方 `BASE_TOP_RGB` / `FLOOR_TOP_RGB` / `topColorOf`)。
 *
 * 侧面**不变**:侧面朝水平方向,看到的是地层剖面(土/岩)与块间高差,与「表面铺了什么」
 * 无关,仍走 `faceColor(层, false)`。也就是说,**海拔层色并没有被废掉**,它从「顶面唯一
 * 来源」退成「侧面的颜色 + 顶面的兜底」。
 *
 * ## 判据口径(写在这里,因为判据就是本文件的产品规格)
 *
 *   1. `colors.length === vertexCount × TERRAIN_COLOR_COMPONENTS`(=3);
 *   2. 每个分量 ∈ [0, 1](越界即 NaN/负值/过曝,GPU 会静默截断而肉眼很难发现);
 *   3. **[WS-FND-193 反转]** 片元源码**必须**含 `sampler2D` + `texture2D`
 *      (`terrainShaderSamplesTexture() === true`),但采样**必须**被 `uAtlasReady`
 *      门控(`terrainAtlasSamplingGated() === true`),且 `vColor` 仍参与输出。
 *      为什么撤、原文为什么立、新的四条判据,见下方「WS-FND-193 契约反转」一节。
 *
 * ## 为什么不写 4 分量(RGBA)
 *
 * 透明由材质/染色 uniform 负责,顶点 alpha 恒为 1 只会多占 33% 带宽。
 * `TERRAIN_COLOR_COMPONENTS` 是**唯一**的分量数事实源:谁都别写死 3。
 */
/*
 * ─────────── WS-FND-193:契约反转(顶面采样图集,顶点色**仍是材质基色**)───────────
 *
 * ## 原文为什么立(WS-09 U2;其中仍然成立的部分继续有效)
 *
 * 立在两件事上:(1) 「加一种地砖 = 重画图集 + 重算 UV + 重传纹理」;
 * (2) U10 裁决后地砖种类扩到 u16(>64)⇒ 图集网格 64×64 ⇒ 单纹理 4096×4096,
 * 显存与采样都不可接受。
 * 这两条**没有被推翻**,所以顶点色路径本身**不许删**:
 *   · 顶点色今天仍是**材质基色**(`topColorOf`:铺装 > 地表 > 海拔层兜底),
 *     仍是 `TERRAIN_COLOR_COMPONENTS = 3` 的唯一事实源;
 *   · 加一种铺装仍然只需在 `FLOOR_TOP_SLOTS` 里加一行,不碰任何纹理。
 *
 * ## 现在为什么撤(owner 2026-11-19:「还是一堆色块,需要贴图」)
 *
 * 撤掉的只是**原判据 3**(「片元源码不得含采样器」),不是顶点色:
 *   · (1) 在本仓**不成立**:图集 `atlas_sprites.png` 是**运行时 fetch** 的成品资源
 *     (`assets/atlas_sprites.json` 的 358 帧),30 张地砖(物品 301..330)的格子
 *     **本来就在里面**(号段表见 `assembly_math.ATLAS_ID_SEGMENTS`,与
 *     `shared/contracts/FREEZE.md` 的物品号段逐段吻合)。这次接线**没有重画一像素、
 *     没有重传一张图**,只多了一个采样器;
 *   · (2) 是**推测的未来**:当前实测图集是 20×18 = 360 格(`ATLAS_COLS`/`ATLAS_ROWS`)。
 *     为一个推测的未来放弃当下可见的纹理,换来的是「整张地形的顶面只有 38 种纯色」
 *     (WS-FND-180 之后材质表去重后的色数)—— 那正是 owner 说的「一堆色块」;
 *   · 顶点色**不能**替代纹理(反之亦然):顶点色回答「这块地是什么材质」,
 *     纹理回答「这块地的表面长什么样」。
 *
 * ## 新判据(逐条可测;实现在 `terrainShaderSamplesTexture` / `terrainAtlasSamplingGated`)
 *
 *   1. `terrainShaderSamplesTexture() === true`:片元源码**必须**含 `sampler2D` +
 *      `texture2D`。反过来 —— 把采样器删掉现在会红:那是退回纯色块。
 *   2. `terrainAtlasSamplingGated() === true`:`texture2D` 调用**必须**被
 *      `if (uAtlasReady > 0.5 ...)` 包住。图集是**运行时 fetch** 的,首帧一定还没有;
 *      无门控的无条件采样这一帧拿到的是**未绑定纹理** ⇒ 地形整片变黑,且不报错。
 *      ⇒ 门控是「图集没到 ⇒ 退回纯顶点色」这条退化路径的**唯一**实现点。
 *   3. 顶点色三件套**一条都没放宽**:分量数仍是 3、值域仍是 [0,1]、长度仍等于
 *      `顶点数 × 3`(`validateVertexColors`),且 `vColor` 仍参与片元输出。
 *   4. 只对**顶面**采样(`vNormal.z > 0.5`):侧面是地层剖面,与「表面铺了什么」无关
 *      —— 与「侧面只按海拔层着色」是同一句语义(见 `topColorOf`)。
 *
 * ## 乘法口径(为什么是 `vColor * tex * 2.0`)
 *
 * 图素当**明暗调制图**用。乘 2 不是随手写的:图集中间调约 0.5,乘 2 后 ≈ 1.0
 * ⇒ 中灰图素处的地面亮度**等于改前的纯顶点色**(不整体变暗/变亮),亮图素提亮、
 * 暗图素压暗:纹理是「加在材质色上的细节」,材质语义仍由顶点色表达。
 *
 * 纹理**不设** `colorSpace = SRGBColorSpace`(与 `boot.ts` 的立牌路径刻意相反):
 * 立牌图是**成品色**,必须解码;这里图素是**乘数**,要与顶点色(同一空间)相乘,
 * 解码成线性会把整片地形压暗约 2.2 次方。设置点见
 * `three/stage_assembly.ts#bindTerrainAtlas`。
 */

import { cellIndexFromId } from './assembly_math.ts';

/** 顶点色分量数(RGB)。唯一事实源 —— 装配层与判据都读它。 */
export const TERRAIN_COLOR_COMPONENTS = 3;

/** 顶点色在几何上的属性名 */
export const TERRAIN_COLOR_ATTRIBUTE = 'color';

/**
 * 图集 UV 在几何上的属性名(WS-FND-193)。
 *
 * ★ 与 `TERRAIN_COLOR_ATTRIBUTE` 同一做法:名字只此一处事实源 —— 装配层
 *   (`three/stage_assembly.buildChunkGeometry`)与判据都读它,谁都不写第二份字面量。
 *   ⚠️ 这个名字**必须**是 `uv`:three 在非 raw 路径注入的内建属性就叫 `uv`
 *   (`THREE_MANAGED_ATTRIBUTES` 里有它),改名会让 raw / managed 两条路对不上。
 */
export const TERRAIN_UV_ATTRIBUTE = 'uv';

/** 一个顶点的颜色(0..1 线性空间) */
export interface FaceColor {
  r: number;
  g: number;
  b: number;
}

/**
 * 四层地质基色,下标 = `Elevation`(0 DEEP / 1 GROUND / 2 PLATFORM / 3 CLIFF)。
 *
 * 取值刻意避开纯色:纯 (1,1,1) 在顶点色路径上会与「未写入」不可区分
 * (`Float32Array` 默认 0 是全黑,而全白是最高亮度,两者都能被盲眼看过去),
 * 因此每层都落在中间调,任一层漏写都会在判据 2 之外被「层间颜色相同」抓住。
 */
export const ELEV_BASE_RGB: readonly FaceColor[] = [
  { r: 0.24, g: 0.36, b: 0.52 }, /* DEEP     深水 */
  { r: 0.42, g: 0.62, b: 0.36 }, /* GROUND   草地 */
  { r: 0.62, g: 0.58, b: 0.46 }, /* PLATFORM 木台 */
  { r: 0.56, g: 0.52, b: 0.54 }, /* CLIFF    石崖 */
];

/*
 * ─────────────── WS-FND-180:顶面材质色(两张表)───────────────
 *
 * ## 为什么顶面不能再只按海拔层着色(现状 = 一堆 4 色色块)
 *
 * `faceColor(层, true)` 的取值只有 **4** 个(DEEP/GROUND/PLATFORM/CLIFF),于是顶面
 * 只有 4 种颜色:草地、金沙滩、熔岩、冰砖、榻榻米……在画面上全都同色 ——
 * 「这块地表面铺了什么」这件事在渲染里**根本不存在**,而所有判据仍然全绿
 * (顶点色长度对、值域对、没有采样器)。这是「判据查形状、不查语义」的典型漏面。
 *
 * 格子本来就把材质带在单元里(`shared/types/tile.ts` 的 `unpackTile`):
 *   - `base`(BaseFluid)   = 地表本身是什么  ⇒ `BASE_TOP_RGB`,10 个取值;
 *   - `floor`(6 位**槽位**) = 表面铺了什么铺装 ⇒ `FLOOR_TOP_RGB`,64 个槽位。
 * 两者都是**每格**的数据,LOD0(近处)逐格精确,LOD>0 时取合并块的主导格(近似,见
 * `chunk_geometry.collectCells`)。
 *
 * ## 三张表的分工(别把「海拔层色」当成「地表材质色」用)
 *
 *   `ELEV_BASE_RGB`   海拔层 × 4     —— **侧面**仍用它(`faceColor`)
 *   `BASE_TOP_RGB`    地表材质 × 10  —— 顶面第二优先
 *   `FLOOR_TOP_RGB`   铺装槽位 × 64  —— 顶面第一优先(`null` = 无铺装)
 *
 * 顶面取值顺序由 `topColorOf` 唯一实现;侧面**不改**,因为侧面看到的是地层剖面
 * (土/岩),不是「表面铺了什么」,而且它与块间高度差绑定,与铺装无关。
 */

/**
 * **顶面地表基色**,下标 = `BaseFluid`(`shared/types/tile.ts`):
 *   0 VOID / 1 GRASS / 2 DIRT / 3 GOLD_SAND / 4 ROCK
 *   5 SHALLOW_WATER / 6 HOT_SPRING / 7 SLIME / 8 LAVA / 9 CHOCO
 *
 * 下标 0(VOID)刻意取 GRASS **同值**:它是兜底项 —— 一个格子里只放了物体、没写
 * `base` 时,顶面落回草地色,而不是「第 0 号材质」的怪色。
 * 取值全部落在中间调,理由与 `ELEV_BASE_RGB` 相同(纯黑/纯白会与「漏写」混淆)。
 */
export const BASE_TOP_RGB: readonly FaceColor[] = [
  { r: 0.42, g: 0.62, b: 0.36 }, /* 0 VOID          兜底:与 GROUND 同值 */
  { r: 0.42, g: 0.62, b: 0.36 }, /* 1 GRASS         草地 */
  { r: 0.55, g: 0.42, b: 0.30 }, /* 2 DIRT          泥土 */
  { r: 0.82, g: 0.74, b: 0.46 }, /* 3 GOLD_SAND     金沙滩 */
  { r: 0.56, g: 0.52, b: 0.54 }, /* 4 ROCK          岩石 */
  { r: 0.24, g: 0.36, b: 0.52 }, /* 5 SHALLOW_WATER 浅水 */
  { r: 0.62, g: 0.72, b: 0.78 }, /* 6 HOT_SPRING    温泉 */
  { r: 0.42, g: 0.70, b: 0.34 }, /* 7 SLIME         黏液 */
  { r: 0.85, g: 0.35, b: 0.16 }, /* 8 LAVA          熔岩 */
  { r: 0.45, g: 0.30, b: 0.22 }, /* 9 CHOCO         巧克力 */
];

/**
 * 槽位 1..30 的顶面铺装色。下标 = **槽位号**;注释里的数字是它对应的地砖物品 ID
 * (槽位 = 物品 ID − 300)。
 *
 * 语义对齐 `server/src/world/chunk.ts` 的 `FLOOR_PALETTE` / `floorSlotOfId`
 * (0 = 无铺装;1..30 ↔ 301..330;31..63 = UGC 像素地毯变体的槽)。客户端**不** import
 * server,所以这张表在客户端独立存在 —— **下标即槽位**,不做任何物品 ID 判断。
 *
 * 槽位 0 = 无铺装 ⇒ `null`(回落 `base`,而不是「某种黑色铺装」)。
 */
const FLOOR_TOP_SLOTS: readonly (FaceColor | null)[] = [
  null,                          /*  0 无铺装(裸地) */
  { r: 0.48, g: 0.36, b: 0.26 }, /*  1 301 耕地 */
  { r: 0.60, g: 0.62, b: 0.56 }, /*  2 302 鹅卵石径 */
  { r: 0.66, g: 0.50, b: 0.32 }, /*  3 303 木地板 */
  { r: 0.72, g: 0.76, b: 0.50 }, /*  4 304 榻榻米 */
  { r: 0.62, g: 0.34, b: 0.28 }, /*  5 305 红砖广场 */
  { r: 0.86, g: 0.86, b: 0.88 }, /*  6 306 大理石 */
  { r: 0.30, g: 0.30, b: 0.34 }, /*  7 307 棋盘砖 */
  { r: 0.88, g: 0.62, b: 0.72 }, /*  8 308 花瓣地毯 */
  { r: 0.36, g: 0.42, b: 0.60 }, /*  9 309 星光夜路 */
  { r: 0.58, g: 0.44, b: 0.30 }, /* 10 310 浮木栈桥 */
  { r: 0.76, g: 0.62, b: 0.40 }, /* 11 311 威化砖 */
  { r: 0.34, g: 0.68, b: 0.32 }, /* 12 312 球场草皮 */
  { r: 0.72, g: 0.28, b: 0.24 }, /* 13 313 塑胶跑道 */
  { r: 0.62, g: 0.62, b: 0.62 }, /* 14 314 像素地毯 */
  { r: 0.72, g: 0.86, b: 0.94 }, /* 15 315 冰砖 */
  { r: 0.36, g: 0.30, b: 0.44 }, /* 16 316 减速沼泽 */
  { r: 0.90, g: 0.72, b: 0.20 }, /* 17 317 加速带 */
  { r: 0.55, g: 0.85, b: 0.75 }, /* 18 318 蹦床 */
  { r: 0.50, g: 0.50, b: 0.42 }, /* 19 319 落穴草席 */
  { r: 0.75, g: 0.35, b: 0.15 }, /* 20 320 火炭砖 */
  { r: 0.60, g: 0.55, b: 0.70 }, /* 21 321 旋转盘 */
  { r: 0.85, g: 0.65, b: 0.20 }, /* 22 322 蜂蜜毯 */
  { r: 0.78, g: 0.70, b: 0.45 }, /* 23 323 流沙砖 */
  { r: 0.35, g: 0.28, b: 0.30 }, /* 24 324 荆棘垫 */
  { r: 0.75, g: 0.40, b: 0.80 }, /* 25 325 迪斯科灯砖 */
  { r: 0.45, g: 0.65, b: 0.85 }, /* 26 326 传送砖 A */
  { r: 0.50, g: 0.70, b: 0.90 }, /* 27 327 传送砖 B */
  { r: 0.45, g: 0.45, b: 0.50 }, /* 28 328 直轨 */
  { r: 0.45, g: 0.45, b: 0.50 }, /* 29 329 弯轨 */
  { r: 0.55, g: 0.50, b: 0.45 }, /* 30 330 制动轨 */
];

/**
 * 槽位 31..63 = 314 的 UGC 像素地毯变体,共用一个颜色
 * (与 server 侧 `FLOOR_UGC_FIRST` / `FLOOR_UGC_LAST` 同口径)。
 */
const FLOOR_TOP_UGC_RGB: FaceColor = { r: 0.62, g: 0.62, b: 0.62 };
const FLOOR_TOP_UGC_FIRST = 31;
const FLOOR_TOP_UGC_LAST = 63;

/** 槽位号位宽 = 6 位(`shared/types/tile.ts` 的 `FLOOR_WORD_BITS`)⇒ 槽位 0..63 */
const FLOOR_SLOT_COUNT = 64;

/**
 * **顶面铺装色表**:长度恒为 `FLOOR_SLOT_COUNT`(=64),下标 = `floor` 槽位,
 * `null` = 该槽位「无铺装色」(槽位 0 与所有未定义槽位)⇒ 回落 `base`。
 *
 * 长度 64 本身是判据(它必须与 6 位槽位空间一一对应;表短一格就会出现
 * 「槽位 63 的世界里没有颜色」这种只在 UGC 地毯上可见的洞)。
 */
export const FLOOR_TOP_RGB: readonly (FaceColor | null)[] = (() => {
  const arr = new Array<FaceColor | null>(FLOOR_SLOT_COUNT).fill(null);
  for (let s = 0; s < FLOOR_TOP_SLOTS.length; s += 1) arr[s] = FLOOR_TOP_SLOTS[s] ?? null;
  for (let s = FLOOR_TOP_UGC_FIRST; s <= FLOOR_TOP_UGC_LAST; s += 1) arr[s] = FLOOR_TOP_UGC_RGB;
  return arr;
})();

/* ═══════════ WS-FND-193:材质 → 图集格(顶面到底采样哪一格地砖)═══════════
 *
 * ## 为什么必须过 `cellIndexFromId`,不能自己算
 *
 * 图集是 358 帧的**成品图**,不是按 `BaseFluid` / 槽位号排的:帧名是 `id_101..id_858`
 * (跨度 758,缺 400 个 ID,压缩成 13 段)。地砖那一段是 `301..330`,它的**首格号是
 * 103** —— 若按 `id - 101` 算会得到 200,贴出来的图整体错位(实测:那会落到
 * 「整蛊玩具」段)。⇒ 从槽位到格号**必须**走 `assembly_math.cellIndexFromId`;
 * 本文件**不写**第二份号段表(重复迟早漂,漂的表现是「地砖贴错图」,而颜色仍然
 * 是对的 —— 那种缺陷只有眼睛能发现)。
 *
 * ## 兜底:为什么是「一格兜底」而不是「退回纯顶点色」(二选一,这里选前者)
 *
 * 三种情况拿不到格子:
 *   1. `floor = 0`(裸地)—— 图集里**没有**按 `BaseFluid` 出的地面帧
 *      (101-130 段是自然**物件**:原木/浮石/木板,不是草地/沙地/岩石);
 *   2. 槽位 31..63 = UGC 像素地毯变体 —— 美术来自**服务器生成的像素纹理**,
 *      不在 `atlas_sprites.png` 里;
 *   3. 任何算不出格号的坏值(非整数 / 越界 / 未知 id)。
 * 这三者统一走 `TERRAIN_ATLAS_FALLBACK_CELL`(一格**低饱和**铺装)。
 * 为什么不退回纯顶点色:**同一个 chunk 里既有贴图面也有纯色面,接缝会形成一圈比
 * 色块更难看的纯色边框**;统一兜底 ⇒ 整片地形都有纹理,材质语义仍由顶点色表达。
 * 兜底格**必须导出**:判据要断言它的具体格号(见 `tests/WS-FND-193`)。
 */

/** 地砖**物品 ID** 与铺装槽位的关系:槽位 = 物品 ID − `FLOOR_ID_BASE` */
export const FLOOR_ID_BASE = 300;

/** 图集里有美术的**最大**铺装槽位(= 地砖 330);31..63 是 UGC 变体,图集里没有 */
const FLOOR_PAVED_SLOT_MAX = FLOOR_TOP_SLOTS.length - 1;

/**
 * 兜底用的地砖物品 ID = **302 鹅卵石径**。
 *
 * 为什么是它:兜底要盖住草地/金沙/岩石/水/熔岩等**所有**底色,所以必须**低饱和**,
 * 否则「乘上去」会把材质色带偏(拿红砖当兜底 ⇒ 草地变红草)。
 * 鹅卵石径是图集地砖里最中性的一张;乘 2.0 后中灰图素 ≈ 原色,材质语义仍由顶点色定。
 */
export const TERRAIN_ATLAS_FALLBACK_ID = 302;

/** 兜底格号 = `cellIndexFromId(302)` = **104**(列 4 行 5);判据把它钉成字面量 */
export const TERRAIN_ATLAS_FALLBACK_CELL: number = cellIndexFromId(TERRAIN_ATLAS_FALLBACK_ID);

/** 铺装槽位 → 图集格号;**没有格子(≤0 / UGC 变体 / 越界 / 坏值)⇒ `-1`** */
export function terrainAtlasCellForFloorSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > FLOOR_PAVED_SLOT_MAX) return -1;
  return cellIndexFromId(FLOOR_ID_BASE + slot);
}

/**
 * 一个顶面的**图集格号** —— 顶面贴图的唯一算法源。
 *
 * ★ 与 `topColorOf` 的优先级**必须一致**(铺装优先;`base` 没有地面帧 ⇒ 兜底):
 *   颜色说「红砖广场」而纹理贴「球场草皮」就是两条口径漂了,而这种漂在画面上只
 *   表现为「颜色和图案对不上」,长度/值域判据一条都查不出来。
 * ★ 不抛:坏值(`NaN` / 非整数 / 未知 id)一律兜底(与 `topColorOf` 同族语义)。
 *   `base` 目前不参与选格(见上面的兜底说明),参数保留是为了与 `topColorOf` 同形 ——
 *   图集哪天补了地面帧,只改本函数体,不改任何调用点。
 */
export function terrainAtlasCellOf(base: number, floorSlot: number): number {
  void base;
  const paved = terrainAtlasCellForFloorSlot(floorSlot);
  if (paved >= 0) return paved;
  return TERRAIN_ATLAS_FALLBACK_CELL;
}

/** 顶面亮度因子(朝上,受光最多) */
export const TOP_FACE_SHADE = 1;

/**
 * 侧面亮度因子。固定光向来自左上前方,四个侧面共用同一个系数 ——
 * 本仓是像素画风格,**不做**逐法线兰伯特(那会在相邻侧面之间产生肉眼可见的
 * 亮度跳变,破坏「同一块地形一个色」的观感)。
 */
export const SIDE_FACE_SHADE = 0.82;

/** 世界 z(−1..2)→ 地质层下标(0..3);越界夹紧 */
export function elevLayerOfZ(z: number): number {
  switch (Math.round(z)) {
    case -1: return 0;
    case 0: return 1;
    case 1: return 2;
    case 2: return 3;
    default: return z < 0 ? 0 : 3;
  }
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** 取某层某朝向面的颜色(唯一算法源:基色 × 亮度因子,分量夹紧到 [0,1]) */
export function faceColor(layer: number, isTop: boolean): FaceColor {
  const i = Math.max(0, Math.min(ELEV_BASE_RGB.length - 1, Math.trunc(layer)));
  const base = ELEV_BASE_RGB[i];
  const shade = isTop ? TOP_FACE_SHADE : SIDE_FACE_SHADE;
  return {
    r: clamp01(base.r * shade),
    g: clamp01(base.g * shade),
    b: clamp01(base.b * shade),
  };
}

/*
 * ─────────────── WS-FND-180:顶面材质色(取值函数)───────────────
 *
 * 顶面颜色不再只由海拔层决定(那样全世界只有 4 色,见文件顶部注释),而是:
 *
 *     铺装(FLOOR_TOP_RGB 槽位) > 地表(BASE_TOP_RGB / BaseFluid) > 海拔层(兜底)
 *
 * 侧面**不变**:它看到的是地层剖面(土/岩),不是「表面铺了什么」,仍走 faceColor。
 */

/**
 * 一个**顶面**的颜色 —— 顶面着色的唯一算法源。
 *
 * 优先级(与「这块地表面是什么」这个语义一致):
 *   1. 有铺装(`floorSlot` 是 0..63 的整数,且该槽位在 `FLOOR_TOP_RGB` 里有定义)⇒ 铺装色;
 *   2. 否则 `base` 是 0..9 的整数 ⇒ `BASE_TOP_RGB[base]`;
 *   3. 再否则回落 `faceColor(elevLayer, true)`(`TOP_FACE_SHADE` = 1,与旧口径逐位一致;
 *      层号非有限时先归到 0 —— 见函数末尾的注释)。
 *
 * ★ `base` / `floorSlot` 非法(非整数 / 越界 / NaN / Infinity)一律走**回落**:
 *   不抛异常、不产生 NaN。它们直接来自存档与网络,一个坏格子不该让整块地形画不出来
 *   (与 `packTile` 的「坏 ID 归 0」同一族语义;高频路径不能因一格坏数据断帧)。
 * ★ 每次都返回**新对象**(与 `faceColor` 同契约):调用方拿到的是值,不是共享常量本身 ——
 *   否则谁把结果原地改一改,整张调色表就被写脏了。
 */
export function topColorOf(elevLayer: number, base: number, floorSlot: number): FaceColor {
  if (Number.isInteger(floorSlot) && floorSlot >= 0 && floorSlot < FLOOR_TOP_RGB.length) {
    const paved = FLOOR_TOP_RGB[floorSlot];
    if (paved !== undefined && paved !== null) return { r: paved.r, g: paved.g, b: paved.b };
  }
  if (Number.isInteger(base) && base >= 0 && base < BASE_TOP_RGB.length) {
    const soil = BASE_TOP_RGB[base];
    if (soil !== undefined) return { r: soil.r, g: soil.g, b: soil.b };
  }
  /*
   * 层号非有限(NaN)时 `faceColor` 里的数组下标会变成 NaN ⇒ 取到 undefined ⇒
   * 抛 `Cannot read properties of undefined`。层号本应来自 `elevLayerOfZ`(必然 0..3),
   * 这里把「坏层号」与「坏 base/floor」同等看待:归到 0(DEEP),不抛异常。
   */
  return faceColor(Number.isFinite(elevLayer) ? elevLayer : 0, true);
}

/**
 * **顶面材质表**的成员反查:RGB → 表里的那一项;不在表里 ⇒ `null`(与 `lodPaletteOf` 同形)。
 *
 * 表 = `BASE_TOP_RGB`(10 项)∪ `FLOOR_TOP_RGB` 的已定义槽位(63 个:1..30 各一色、
 * 31..63 共一色)。去重后 **38** 个不同色(VOID/GRASS 同值、直轨/弯轨同值、
 * 像素地毯与 UGC 同值 —— 计数以去重为准)。
 * 它是「顶面色合法吗」的判据口径(见 `lodFaceSemantics`),也是「插值/平均可判定」的依据:
 * 平均值一般**不在**这张表里。
 *
 * ⚠️ 与 `lodPaletteOf`(海拔层 × 朝向的 8 色)是**两张不重叠的表** ——
 * 逐项比对无一相同(自检在 `tests/WS-FND-180-terrain-material-palette.test.ts`),
 * 所以「一个色落在哪条着色路径上」是可判定的,不是靠肉眼分工。
 */
export function topMaterialPaletteOf(rgb: FaceColor, eps = 1e-6): FaceColor | null {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= eps;
  for (const c of BASE_TOP_RGB) {
    if (close(c.r, rgb.r) && close(c.g, rgb.g) && close(c.b, rgb.b)) return { r: c.r, g: c.g, b: c.b };
  }
  for (const c of FLOOR_TOP_RGB) {
    if (c !== null && close(c.r, rgb.r) && close(c.g, rgb.g) && close(c.b, rgb.b)) {
      return { r: c.r, g: c.g, b: c.b };
    }
  }
  return null;
}

/** 把颜色写到顶点色数组的第 `vertexIndex` 个顶点上 */
export function writeVertexColor(colors: Float32Array, vertexIndex: number, c: FaceColor): void {
  const o = vertexIndex * TERRAIN_COLOR_COMPONENTS;
  colors[o] = c.r;
  colors[o + 1] = c.g;
  colors[o + 2] = c.b;
}

/**
 * 顶点色自检。返回 `null` 表示合法;否则返回**具体**原因。
 *
 * 为什么单独做成函数而不是散在断言里:与 `validateChunkGeometry` 同构,
 * 让装配层(每帧)与测试(门禁)跑**同一份**检查,避免「测试查的是一套、
 * 运行时走的是另一套」。
 */
export function validateVertexColors(colors: Float32Array, vertexCount: number): string | null {
  const expected = vertexCount * TERRAIN_COLOR_COMPONENTS;
  if (colors.length !== expected) {
    return `顶点色长度 ${colors.length} ≠ 顶点数 ${vertexCount} × ${TERRAIN_COLOR_COMPONENTS} = ${expected}`;
  }
  for (let i = 0; i < colors.length; i += 1) {
    const v = colors[i];
    if (!Number.isFinite(v)) return `顶点色分量 [${i}] 非有限值(${String(v)})`;
    if (v < 0 || v > 1) return `顶点色分量 [${i}] = ${v} 超出 [0,1]`;
  }
  return null;
}

/* ────────── 顶点色着色器(材质基色;**顶面另采样图集**,见 WS-FND-193)────────── */

/**
 * three 在**非 raw**(`ShaderMaterial`)路径里**自动注入**的顶点属性。
 *
 * `position` / `normal` / `uv` 是无条件注入的;`color` 在 `material.vertexColors === true`
 * (`#define USE_COLOR`)时注入。
 *
 * ★ WS-FND-89:这份表存在的唯一理由是**判据能查重** —— 自定义源码里再声明一次
 *   这些名字,GLSL 就是「redefinition of 'position'」,编译失败 ⇒ 整个地形画不出来,
 *   而 node 侧的判据(长度、值域、没有采样器)照样全绿。实测就发生过。
 */
export const THREE_MANAGED_ATTRIBUTES: readonly string[] = ['position', 'normal', 'uv', 'color'];

/**
 * 顶点着色器(**自包含**版:配 `RawShaderMaterial`)。
 *
 * 只用 `position` / `normal` / `color` 三个属性;矩阵 uniform 与仓内既有 shader
 * 用四个属性:`position` / `normal` / `color`(材质基色)+ `uv`(**图集格坐标**,
 * WS-FND-193);矩阵 uniform 与仓内既有 shader
 *
 * ★ 为什么 `precision` 与三个 `attribute` 都必须写在这里:`RawShaderMaterial`
 *   **不做任何注入**(连默认浮点精度都没有)。three 只在 `ShaderMaterial` 路径上
 *   注入 `attribute vec3 position/normal/uv`(开 `vertexColors` 还注入 `color`),
 *   所以同一份源码**绝不能**再喂给 `ShaderMaterial` —— 那就是同名重定义。
 *   非 raw 路径请用 `TERRAIN_VCOLOR_VERT_MANAGED`(内建声明已剥离,见文件末尾)。
 */
export const TERRAIN_VCOLOR_VERT = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec3 color;
attribute vec2 uv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vColor = color;
  vNormal = normal;
  vUv = uv;
  gl_Position = uProjection * uView * uModel * vec4(position, 1.0);
}
`;

/**
 * 片元着色器:顶点色(**材质基色**)× 图集图素(明暗调制)× 固定光向的兰伯特近似。
 *
 * ★ WS-FND-193 新契约(旧契约「不出现任何采样器」已**撤**,理由见文件顶部):
 *   必须采样 `uAtlas`,但**必须**被 `uAtlasReady` 门控 —— 图集是运行时 fetch 的,
 *   首帧一定还没有;无门控的无条件采样在那一帧拿到未绑定纹理 ⇒ 整片变黑。
 *   只对顶面采样(侧面是地层剖面,与「表面铺了什么」无关)。
 *
 * `precision` 显式写出:配 `RawShaderMaterial` 时 three 不注入默认精度。
 * 非 raw 路径上 three 也会注入一行同样的声明 —— 重复设定默认精度是**合法**的
 * (与重复声明 `attribute` 不同),所以两条路径可以共用同一份片元源码。
 */
export const TERRAIN_VCOLOR_FRAG = `
precision highp float;
uniform float uAmbient;
uniform sampler2D uAtlas;
uniform float uAtlasReady;
varying vec3 vColor;
varying vec3 vNormal;
varying vec2 vUv;
const vec3 LIGHT_DIR = vec3(0.4082482, -0.4082482, 0.8164965);
void main() {
  /*
   * 顶点色仍是**材质基色**(WS-FND-180);图集图素是加在它上面的**明暗细节**:
   * 乘 2.0 让中灰图素 ≈ 原色(见文件顶部的「乘法口径」)。
   * uAtlasReady = 0(首帧 / 图集 fetch 失败)⇒ 这一支不执行,输出就是纯顶点色。
   */
  vec3 albedo = vColor;
  if (uAtlasReady > 0.5 && vNormal.z > 0.5) {
    vec3 tex = texture2D(uAtlas, vUv).rgb;
    albedo = clamp(vColor * tex * 2.0, 0.0, 1.0);
  }
  float ndl = max(dot(normalize(vNormal), LIGHT_DIR), 0.0);
  vec3 lit = albedo * (uAmbient + (1.0 - uAmbient) * ndl);
  gl_FragColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}
`;

/**
 * 顶点色着色器是否在采样纹理。**WS-FND-193 起必须恒为 `true`** ——
 * 判据拿它当断言,而不是拿「有没有 `uAlbedo` 字样」(别名会绕过那种检查)。
 *
 * ★ 这条在 WS-09 U2 里是 `false`(「顶点色路径不得采样纹理」),WS-FND-193 反转:
 *   顶面现在按 UV 采样地砖格,纹理是「材质色上的明暗细节」,不是替代材质色。
 *   反转的完整理由与新的四条判据写在文件顶部。谁要把它改回「不许采样」,
 *   先回答「那地形靠什么摆脱纯色块」。
 */
export function terrainShaderSamplesTexture(): boolean {
  const both = `${TERRAIN_VCOLOR_VERT}\n${TERRAIN_VCOLOR_FRAG}`;
  return /sampler2D|samplerCube|texture2D|textureCube/.test(both);
}

/**
 * 采样是否被 `uAtlasReady` **门控**(= 图集没到就退回纯顶点色)。
 *
 * ## 为什么必须与「有没有采样器」分开断言
 *
 * 「片元里有 sampler2D」只说明源码**声明**了采样器,不说明采样会被门控 ——
 * 无条件采样在首帧(图集还在 fetch)拿到的是未绑定纹理 ⇒ 地形整片变黑,
 * 不抛异常、不报错。所以**门的存在**必须单独可测。
 *
 * ## 判定口径(文本级;写清楚是为了改动时同步)
 *
 * 找到门控那一行(`if (uAtlasReady > 0.5`)与它所在块的收尾 `}`,
 * 要求 `texture2D(...)` 出现在这两者**之间**。删掉 `if`(只留采样)⇒ 找不到门 ⇒ `false`。
 * ⚠️ 改门控写法(例如换成 `if (uAtlasReady > 0.0)`)必须同步改这里的字符串与
 *    `tests/WS-FND-193` —— 那是**契约变更**,不是把判据改松。
 *
 * 默认参数就是产品源码;传参只为让判据拿「坏样本」跑同一个检测器(负对照)。
 */
export function terrainAtlasSamplingGated(src: string = TERRAIN_VCOLOR_FRAG): boolean {
  const guardAt = src.indexOf('if (uAtlasReady > 0.5');
  if (guardAt < 0) return false;
  const guardEnd = src.indexOf('}', guardAt);
  if (guardEnd < 0) return false;
  const sampleAt = src.indexOf('texture2D(');
  return sampleAt > guardAt && sampleAt < guardEnd;
}

/**
 * 从 GLSL 源码里按出现顺序抽取 `attribute <type> <name>;` 的名字(**可重复**)。
 *
 * 保留重复是有意的:「同一属性声明了两次」本身就是要抓的缺陷,去重会把它吃掉。
 */
export function parseAttributeDeclarations(src: string): string[] {
  const out: string[] = [];
  const re = /attribute\s+\w+\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
}

/**
 * 源码里**与 three 注入重名**的属性声明(去重)。
 *
 * 返回非空 ⇒ 这份源码**不能**配 `ShaderMaterial`(GLSL 重定义 ⇒ 编译失败 ⇒
 * 对象整块不显示)。它是 `TERRAIN_VCOLOR_VERT` / `TERRAIN_VCOLOR_VERT_MANAGED`
 * 两条路径的共用判据。
 */
export function duplicatedManagedAttributes(src: string): string[] {
  const managed = new Set(THREE_MANAGED_ATTRIBUTES);
  const hit = new Set<string>();
  for (const name of parseAttributeDeclarations(src)) {
    if (managed.has(name)) hit.add(name);
  }
  return [...hit];
}

/**
 * 剥掉指定名字的 `attribute` 声明行(其余原样保留)。
 *
 * 用途:把自包含源码变成 `ShaderMaterial` 版本 —— three 已经注入了那些声明,
 * 我们再声明一次就是重定义。**只删声明行**,不碰任何使用点,因此两条路径
 * 的计算逻辑必然同源(不存在「raw 版改了、managed 版忘了改」)。
 */
export function stripAttributeDeclarations(src: string, names: readonly string[]): string {
  const drop = new Set(names);
  const kept: string[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*attribute\s+\w+\s+(\w+)\s*;\s*$/.exec(line);
    if (m !== null && drop.has(m[1])) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * `ShaderMaterial`(非 raw)专用顶点源码:three 注入的内建声明已剥离。
 *
 * ★ 它不是「另一份实现」—— 由 `TERRAIN_VCOLOR_VERT` 机械派生,唯一差异是少了
 *   三行 `attribute`(three 会注入)。判据:`duplicatedManagedAttributes(THIS) === []`。
 */
export const TERRAIN_VCOLOR_VERT_MANAGED: string =
  stripAttributeDeclarations(TERRAIN_VCOLOR_VERT, THREE_MANAGED_ATTRIBUTES);

/** 顶点色着色器声明的属性名(判据用:必须含 color **与 uv** —— uv 是图集格坐标,WS-FND-193) */
export function terrainShaderAttributes(): string[] {
  return parseAttributeDeclarations(TERRAIN_VCOLOR_VERT);
}

/* ═══════ WS-FND-96 / LOD 合并 × 顶点色 × 法线:**顺序**语义(钉住,不留解释空间)═══════ */

/**
 * ★ 合并与着色的**唯一顺序**:`MERGE_THEN_COLOR` —— **先合并,再着色**。
 *
 * 管线(`tile_mesh.dominantZGrid` → `chunk_geometry.emitChunkGeometry` →
 * `three/compat.assembleChunkGeometry`)走的是这三步:
 *
 * ```
 * 1. 合并:merge×merge 格压成一个块,块的 z = 块内**最高非空** z
 *          (空块 = −∞ ⇒ 不建面)。`aLodMerge` 就是这个 merge 边长。
 * 2. 着色:侧面 `faceColor(elevLayerOfZ(块.z), false)`;顶面 `topColorOf(层, 主导格 base/floor)`
 *          —— 侧面的色只由**块 z** 决定;顶面的色由**块内主导格(最高非空 z 那一格)**的
 *          材质决定(WS-FND-180),两者都不看块内其余格 ⇒ 「块内逐格平均」是**另一种语义**,
 *          本仓不做。
 * 3. 法线:只由**面朝向**决定(顶 +Z / 侧 ±X / 侧 ±Y),与 merge 大小无关
 *          ⇒ 两档 LOD 下同一朝向的法线**逐位相同**。
 * ```
 *
 * 为什么顺序必须写死:两种顺序在**平坦地形**上逐像素相同(块内各格 z 一样 ⇒
 * 平均等于取值),只有在「块内 z 不一致」时才分叉。也就是说 —— 顺序不定的话,
 * 门禁全绿、肉眼也看不出,直到某块台阶的边缘出现一条谁都说不出原因的色带。
 *
 * ⇒ 可判定性:`lodFaceSemantics` 要求顶点色**恰好**是某张调色表的输出 —— 侧面是
 *   `faceColor(层, false)`,顶面是 `topColorOf(层, base, floor)`(WS-FND-180)。
 *   而「先着色再平均」得到的 RGB 一般**不在**任何一张表里
 *   (`lodPaletteOf` 与 `topMaterialPaletteOf` 都返回 `null`)—— 于是两种顺序**可区分**,
 *   不是风格问题。
 */
export const LOD_MERGE_ORDER = 'MERGE_THEN_COLOR';

/** 一个**面**的 LOD 采样(`emitChunkGeometry` 里一个 quad 的 4 个顶点)。 */
export interface LodFaceSample {
  /** 该面 4 个顶点的世界 z(顶面 4 个相同;侧面 2 下 2 上,上沿 = 块 z)。 */
  vertZ: readonly number[];
  /** 该面法线(本仓每面一个恒定法线,不做平滑)。 */
  normal: { x: number; y: number; z: number };
  /** 该面的顶点色(本仓每面一色)。 */
  color: FaceColor;
}

/**
 * 面的**合并后 z** = 顶点 z 的最大值。
 *
 * 与 `tile_mesh.dominantZGrid` 的「块内最高非空 z」是同一规则:
 * 顶面 4 个顶点都等于块 z;侧面下沿比块 z 低(邻块更低才建侧面),
 * 所以 `max` 恰好还原块 z —— 不需要额外把 merge 边长传进来。
 */
export function mergedZOfFace(vertZ: readonly number[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const z of vertZ) {
    if (!Number.isFinite(z)) continue;
    if (z > best) best = z;
  }
  return best;
}

/**
 * 颜色**反查**:RGB → 调色板里的 `(层, 是否顶面)`;不在调色板里 ⇒ `null`。
 *
 * 调色板 = `ELEV_BASE_RGB` 的 4 层 × `{TOP_FACE_SHADE, SIDE_FACE_SHADE}` 两档
 * (共 8 色,由 `faceColor()` 唯一产出)。`eps` 默认 1e‑6,因为顶点色经
 * `Float32Array` 落盘再读回会带上 float32 的舍入。
 *
 * ★ WS-FND-180:**顶面**材质色的反查在 `topMaterialPaletteOf`(另一张表 —— 材质表)。
 *   本函数只管「海拔层 × 朝向」这 8 色:侧面与 LOD 层模型仍用它。
 */
export function lodPaletteOf(rgb: FaceColor, eps = 1e-6): { layer: number; isTop: boolean } | null {
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= eps;
  for (let layer = 0; layer < ELEV_BASE_RGB.length; layer += 1) {
    for (const isTop of [true, false]) {
      const c = faceColor(layer, isTop);
      if (close(c.r, rgb.r) && close(c.g, rgb.g) && close(c.b, rgb.b)) return { layer, isTop };
    }
  }
  return null;
}

/**
 * **面级** LOD 语义自检:`null` = 自洽;否则返回**具体**原因。
 *
 * ```
 * 块 z = max(顶点 z)                       非法(全空)⇒ 红
 * 法线必须是单位向量且落在规范集            否则 ⇒ 红(顶 +Z / 侧 ±X±Y)
 * 色必须落在某一张调色表里                  否则 ⇒ 红(先着色再合并 / 插值会落在这里)
 * 侧面:色必须是海拔层暗档                  否则 ⇒ 红(顶面材质表的色用在了侧面上)
 * 侧面:色所属的层必须 = elevLayerOfZ(块 z)  否则 ⇒ 红(着色用了「某格」而不是「合并块」)
 * 顶面:色必须落在**顶面材质表**里           否则 ⇒ 红(旧口径「顶面 = 海拔层色」不再合法)
 * 着色档必须与法线一致                      顶面朝上 ↔ 材质表;侧面水平 ↔ 海拔层暗档
 * 顶面必须平;侧面至少 2 个顶点在块 z        否则 ⇒ 红(块内混了自己的 z 去着色)
 * ```
 *
 * ## WS-FND-180:顶面为什么换了张表(这是**契约变更**,不是放宽判据)
 *
 * 顶面色现在由格子材质决定(`chunk_geometry` 取合并块内**最高非空 z 那一格**的
 * `base`/`floor`,交给 `topColorOf` 算)。它因此**不再是** `(块 z, 朝向)` 的函数:
 * 同一个块 z 上草地与金沙是两种色,而同一个材质在 DEEP 与 CLIFF 上是同一色。
 * ⇒ 旧口径里「顶面色必须 = ELEV_BASE_RGB[层(块 z)]」这一条已**不成立**,
 *   继续留着只会把正确实现判成红的(而删掉它又等于对顶面失去检查)。
 *
 * 换成了什么(同形,色集不同):
 *   · 侧面那一支**一字未改**:仍在海拔层 8 色调色板里,仍要求「层 = elevLayerOfZ(块 z)」
 *     ⇒「用块内某格的 z 着色」现在由侧面这一支守着,它仍有牙(注入用例见 WS-FND-96);
 *   · 顶面那一支改成「必须落在 `BASE_TOP_RGB ∪ FLOOR_TOP_RGB` 里」并**去掉**层一致性检查
 *     —— 顶面色与海拔层无关(它由材质定),那条在顶面上不可判定。
 *     仍能抓的缺陷:平均值 / 插值 / 自造色 —— 它们一般**不在**材质表里。
 */
export function lodFaceSemantics(sample: LodFaceSample): string | null {
  const blockZ = mergedZOfFace(sample.vertZ);
  if (!Number.isFinite(blockZ)) {
    return `面没有有效顶点 z(${sample.vertZ.map(String).join(',')})⇒ 无块可着色`;
  }
  const { x: nx, y: ny, z: nz } = sample.normal;
  const len = Math.hypot(nx, ny, nz);
  if (!(Math.abs(len - 1) <= 1e-6)) {
    return `法线不是单位向量(${nx},${ny},${nz})|len=${len}`;
  }
  const isTopByNormal = Math.abs(nz - 1) <= 1e-6;
  const isHorizontal = Math.abs(nz) <= 1e-6
    && (Math.abs(Math.abs(nx) - 1) <= 1e-6 || Math.abs(Math.abs(ny) - 1) <= 1e-6);
  if (!isTopByNormal && !isHorizontal) {
    return `法线不在这套规范集里(顶 +Z / 侧 ±X±Y):(${nx},${ny},${nz})`;
  }
  const hit = lodPaletteOf(sample.color);              /* 海拔层 × 朝向(8 色) */
  const material = topMaterialPaletteOf(sample.color); /* 顶面材质表(WS-FND-180) */
  if (hit === null && material === null) {
    return `顶点色 (${sample.color.r},${sample.color.g},${sample.color.b}) 不在任何调色板里 `
      + '⇒ 既不是海拔层暗档(ELEV_BASE_RGB × SIDE_FACE_SHADE),也不是顶面材质表'
      + '(`topColorOf` 的输出)(先着色再合并 / 插值会落在这里)';
  }
  if (isTopByNormal) {
    if (material === null) {
      return '着色档与法线冲突:法线朝上(顶面)的色必须来自**顶面材质表**,'
        + `而 (${sample.color.r},${sample.color.g},${sample.color.b}) 不是材质色`
        + `${hit === null ? '' : `(只匹配到海拔层第 ${hit.layer} 层的亮档 = 旧口径)`}`;
    }
  } else {
    if (hit === null) {
      return '着色档与法线冲突:法线水平(侧面)却用了顶面材质表的色 '
        + `(${sample.color.r},${sample.color.g},${sample.color.b})⇒ 侧面只按海拔层着色`;
    }
    if (hit.isTop) {
      return '着色档与法线冲突:法线水平(侧面)却用了亮档色 '
        + `(${sample.color.r},${sample.color.g},${sample.color.b})`;
    }
    const wantLayer = elevLayerOfZ(blockZ);
    if (hit.layer !== wantLayer) {
      return `颜色层 ${hit.layer} ≠ 合并块 z=${blockZ} 的层 ${wantLayer} ⇒ 着色用了「某格」而不是「合并块」`;
    }
  }
  let atBlock = 0;
  for (const z of sample.vertZ) {
    if (Number.isFinite(z) && Math.abs(z - blockZ) <= 1e-9) atBlock += 1;
  }
  if (isTopByNormal && atBlock !== sample.vertZ.length) {
    return `顶面不平:只有 ${atBlock}/${sample.vertZ.length} 个顶点在块 z=${blockZ}`;
  }
  if (!isTopByNormal && atBlock < 2) {
    return `侧面上沿不足 2 个顶点在块 z=${blockZ}(实得 ${atBlock})`;
  }
  return null;
}

/**
 * **两档 LOD** 的对照判据:`null` = 符合规则;否则返回**具体**原因。
 *
 * 规则(这就是审计 P2-13 / P3-1 要的那句话):
 *
 * ```
 * 法线  —— 必须**逐位相同**(只由面朝向定,与 merge 无关)
 * 颜色  —— 块 z 相同 ⇒ 必须**逐位相同**;
 *          块 z 不同 ⇒ **允许**不同,但:侧面必须恰好是 faceColor(elevLayerOfZ(新块 z), 侧面);
 *                      顶面必须是顶面材质表里的色(由主导格材质定,不比对具体值)
 *                      (即变化只能来自「主导 z / 主导材质变了」,不能来自平均/插值)
 * ```
 *
 * ★ 负对照:把某个面的颜色换成两块颜色的平均值 ⇒ 两条都可能撞红
 *   (不在任何一张调色表里 / 不等于 faceColor 的输出),而改成「用块内某格的 z 着色」
 *   会在**侧面**的「颜色层 ≠ 块层」那条上撞红(WS-FND-180 后顶面不再按层着色,
 *   这一条只在侧面上可判定 —— 见 `lodFaceSemantics` 的注释)。
 */
export function lodTwoLevelDelta(lo: LodFaceSample, hi: LodFaceSample): string | null {
  const loErr = lodFaceSemantics(lo);
  if (loErr !== null) return `LOD0 那一面不自洽:${loErr}`;
  const hiErr = lodFaceSemantics(hi);
  if (hiErr !== null) return `LOD1 那一面不自洽:${hiErr}`;

  const loTop = Math.abs(lo.normal.z - 1) <= 1e-6;
  const hiTop = Math.abs(hi.normal.z - 1) <= 1e-6;
  if (loTop !== hiTop) {
    return '两档的面朝向不同(一顶一侧)⇒ 这不是「同一个面」的对照,判据不成立';
  }
  if (Math.abs(lo.normal.x - hi.normal.x) > 1e-6
    || Math.abs(lo.normal.y - hi.normal.y) > 1e-6
    || Math.abs(lo.normal.z - hi.normal.z) > 1e-6) {
    return `法线随 LOD 变了:(${lo.normal.x},${lo.normal.y},${lo.normal.z}) → `
      + `(${hi.normal.x},${hi.normal.y},${hi.normal.z}) —— 法线只由面朝向定,与 merge 大小无关`;
  }

  const zLo = mergedZOfFace(lo.vertZ);
  const zHi = mergedZOfFace(hi.vertZ);
  const sameColor = Math.abs(lo.color.r - hi.color.r) <= 1e-6
    && Math.abs(lo.color.g - hi.color.g) <= 1e-6
    && Math.abs(lo.color.b - hi.color.b) <= 1e-6;
  if (Math.abs(zLo - zHi) <= 1e-9) {
    if (!sameColor) {
      return `合并块 z 相同(${zLo})却给了不同颜色 `
        + `(${lo.color.r},${lo.color.g},${lo.color.b}) → (${hi.color.r},${hi.color.g},${hi.color.b})`
        + ' ⇒ 颜色不是「(块 z, 朝向)」的函数';
    }
    return null;
  }
  /*
   * ★ WS-FND-180:块 z 变了以后,两侧的规则不同 ——
   *   · 侧面:色只由 (块 z, 朝向) 定 ⇒ 必须**恰好**是 faceColor(层(新块 z), 侧面);
   *   · 顶面:色由合并块**主导格**(最高非空 z 那一格)的材质 base/floor 定,
   *     主导格换了、色当然可以换 ⇒ 这里不比对具体值,只要求它仍落在**顶面材质表**里。
   *     那句检查在函数开头对 `hi` 跑 `lodFaceSemantics` 时已经做过 ——
   *     也就是说「平均值 / 插值色」在这一步之前就已经撞红,这里没有被放宽成
   *     「顶面随便什么色都行」。缺材质信息时(`LodFaceSample` 不带 base/floor)
   *     这是唯一还成立的那条。
   */
  if (hiTop) return null;
  const want = faceColor(elevLayerOfZ(zHi), false);
  if (Math.abs(want.r - hi.color.r) > 1e-6
    || Math.abs(want.g - hi.color.g) > 1e-6
    || Math.abs(want.b - hi.color.b) > 1e-6) {
    return `块 z 从 ${zLo} 变成 ${zHi} 时,侧面颜色必须恰好是 faceColor(层 ${elevLayerOfZ(zHi)},`
      + `侧面) = (${want.r},${want.g},${want.b}),实际 `
      + `(${hi.color.r},${hi.color.g},${hi.color.b})`;
  }
  return null;
}

/* ═══════ WS-FND-101 / LOD 合并**阈值** × 顶点色**插值口径**(定死两个数)═══════ */

/**
 * 块内高差**阈值**:`Δz ≤ LOD_MERGE_MAX_DZ` 的块,才允许以它的合并色出现在粗档 LOD 上;
 * `Δz >` 阈值 ⇒ 该块在粗档上「细节被抹平」,必须被**计数出来**
 * (见 `three/count.ts` 的 `lodMergeBudget`),不许静默合并。
 *
 * ## 手算依据(为什么是 1,不是 0 也不是 2)
 *
 * ```
 * (1) 层间距恒为 1:ELEV_TO_Z = [-1, 0, 1, 2](tile_mesh.ts:29)
 *    ⇒ 相邻海拔层的世界 z 差恒为 1 ⇒ 任何块的 Δz 都是整数 ∈ {0,1,2,3},没有小数情形。
 * (2) 合并块的 z = 块内**最高**非空 z(dominantZGrid,tile_mesh.ts:133),而颜色 =
 *    faceColor(elevLayerOfZ(块z), 朝向)(本文件)⇒ 合并后这一块的色**恰好**等于
 *    「块内最高那一层」的调色板色,于是:
 *      Δz = 0 → 块内每格的色都正是它(无损);
 *      Δz = 1 → 只有最高那层是对的,低一层的格被染高一档 ⇒ 偏**恰好一行**;
 *      Δz = 2 → 偏两行,且中间那一整层(PLATFORM)在粗档上**一个面都没有**;
 *      Δz = 3 → 偏三行(0..3 全跨)。
 * (3) 一行色差的手算上限 = ELEV_BASE_RGB 相邻两行的最大分量差:
 *      DEEP(0.24,0.36,0.52) → GROUND(0.42,0.62,0.36)     = 0.26  ← 最大
 *      GROUND(0.42,0.62,0.36) → PLATFORM(0.62,0.58,0.46) = 0.20
 *      PLATFORM(0.62,0.58,0.46) → CLIFF(0.56,0.52,0.54)  = 0.08
 *    ⇒ 阈值 = 1 时合并引入的色偏差**不超过 0.26**(= 一行);
 *      阈值 = 2 时可到 0.26 + 0.20 = 0.46,已超过任意两层基色之间的差,
 *      肉眼就是一个平台整层消失。
 * (4) 面预算:16×16 的 Chunk 在 LOD1(merge = 2)是 (16/2)^2 = 64 块 = 64 个顶面;
 *    Δz ≤ 1 是台阶地形最常见的形态(单层落差)。阈值取 0 等于「只有纯平地才准合并」
 *    ⇒ LOD1 在台阶地形上退化成 LOD0(256 面),粗档 4 格/面的收益当场消失。
 * ```
 *
 * ⇒ **阈值 = 1**:最多抹掉一行色,绝不抹掉任何一整层。
 *
 * ★ 这个常量**不**改 `dominantZGrid`(它永远取块内最高 z,跨文件的账记在 tile_mesh 上)。
 *   它定的是「哪些合并算**可复现**」的判定与计数口径;几何侧的降级仍由
 *   `LOD_MERGE_SIZE` 决定 —— 两者是「降多少」与「降完还能不能复现」的关系。
 */
export const LOD_MERGE_MAX_DZ = 1;

/**
 * 顶点色在 LOD 上的**插值口径**:`STEP_BY_LAYER` —— **不插值**,按层查调色板,层间阶跃。
 *
 * ## 为什么是阶跃而不是线性插值(三条都要成立才选它)
 *
 * 1. **与 `LOD_MERGE_ORDER = 'MERGE_THEN_COLOR'` 一致**:先合并再着色 ⇒ 颜色的输入只有
 *    `(合并块 z, 朝向)` 两个量,**没有**第二个可插值的连续量(块内逐格 z 已被合并吃掉)。
 *    线性插值必须先拿块内逐格 z 去加权平均 —— 那就是 `COLOR_THEN_MERGE`,
 *    与本文件钉住的 `LOD_MERGE_ORDER` 互斥,同仓并存必然在某一块上打架。
 * 2. **两档 LOD 下同一面的颜色必须可复现**:阶跃口径下色 = `f(块 z, 朝向)` 的 8 值查表
 *    ⇒ 同一块 z 在两档 LOD 上**逐位**同色(经 `Float32Array` 落盘也不漂)。
 *    插值口径下同一个块 z 会因**块内格数与分布**不同而不同(merge 1/2/4/8 覆盖的格数
 *    分别是 1/4/16/64)⇒ 同一面在三档 LOD 上是三个色,且没有一档是「真值」。
 * 3. **可判定**:阶跃色恒落在 `ELEV_BASE_RGB × {TOP_FACE_SHADE, SIDE_FACE_SHADE}` 这 8 个
 *    调色板色里(`lodPaletteOf` 能反查);插值色一般落在调色板**之外**
 *    ⇒ 两种口径在判据上可区分,不是风格问题。
 *
 * ★ WS-FND-180 后「8 值查表」只描述**侧面**:顶面改成查**材质表**
 *   (`BASE_TOP_RGB ∪ FLOOR_TOP_RGB`,见文件顶部)。口径本身没变 ——
 *   仍是「查表、不插值」,插值色照样落在两张表之外。
 *
 * ★ 只约束**顶点色**这一层;片元里的光照(兰伯特近似)与本常量无关。
 */
export const LOD_COLOR_INTERPOLATION = 'STEP_BY_LAYER';

/** 合并判定:`MERGE` = 允许以合并色出现在粗档;`KEEP_DETAIL` = 细节被抹平,必须计数/保留 */
export type LodMergeVerdict = 'MERGE' | 'KEEP_DETAIL';

/** 一个合并块的**高差**画像(只由块内各格的 z 算出,不读几何) */
export interface LodBlockSpan {
  /** 块内**非空**格数(0 ⇒ 空块,不建面) */
  cells: number;
  /** 块内最低非空 z(空块 = +∞) */
  minZ: number;
  /** 块内最高非空 z(空块 = −∞);与 `dominantZGrid` 的块 z 同规则 */
  maxZ: number;
  /** 块内高差 `maxZ − minZ`(空块记 0:没有颜色可抹平) */
  dz: number;
}

/**
 * 块内高差画像。空单元(`-Infinity` / `NaN`)不算格 —— 与 `dominantZGrid` 里
 * 「全 0 格是空气、不抬块 z」同一条规则;否则一块里混进一个空单元就会被算成
 * 「高差无穷」,阈值判据全部误红。
 */
export function lodBlockSpan(cellZs: readonly number[]): LodBlockSpan {
  let cells = 0;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const z of cellZs) {
    if (!Number.isFinite(z)) continue;
    cells += 1;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (cells === 0) {
    return { cells: 0, minZ: Number.POSITIVE_INFINITY, maxZ: Number.NEGATIVE_INFINITY, dz: 0 };
  }
  return { cells, minZ, maxZ, dz: maxZ - minZ };
}

/**
 * 阈值判定。`threshold` 默认取 `LOD_MERGE_MAX_DZ`;**显式传入**只为让判据能
 * 「换一个阈值跑同一个块」并断言结论必须翻面(改阈值必红),不是给生产留的旋钮。
 *
 * 边界口径写死为 `<=`:**恰好等于阈值 ⇒ `MERGE`**,大于才 `KEEP_DETAIL`。
 * 差一(off-by-one)在这里就是「阈值实际是 0 还是 1」,肉眼看不出来。
 */
export function lodMergeVerdict(blockDz: number, threshold: number = LOD_MERGE_MAX_DZ): LodMergeVerdict {
  const dz = Number.isFinite(blockDz) ? Math.abs(blockDz) : Number.POSITIVE_INFINITY;
  const limit = Number.isFinite(threshold) ? Math.abs(threshold) : 0;
  return dz <= limit ? 'MERGE' : 'KEEP_DETAIL';
}

/** 一个合并块在该口径下的顶点色(以及它抹掉了多少细节) */
export interface LodBlockColor {
  /** 阶跃色 = `faceColor(层, 朝向)`;**恒**落在海拔层调色板里(WS-FND-180 后这是侧面/层模型的值) */
  color: FaceColor;
  /** `elevLayerOfZ(块 z)` —— 唯一决定颜色的那个整数 */
  layer: number;
  /** 块内高差(被抹平的层数) */
  dz: number;
  verdict: LodMergeVerdict;
}

/**
 * 合并块的**层模型**顶点色:**按层查调色板**(阶跃),不做任何插值。
 * 算法源与 `chunk_geometry` 的**侧面**着色 `faceColor(elevLayerOfZ(块z), false)` 同一个。
 *
 * ★ WS-FND-180:顶面已改由 `topColorOf(层, base, floor)` 着色(见文件顶部)。
 *   因此 `isTop = true` 时本函数给的是**海拔层亮档色** —— 它是 LOD 预算的**层模型**值,
 *   不再等于真实几何里顶面的顶点色(那个还取决于格子的 `base`/`floor`)。
 *   侧面(`isTop = false`)与真实几何仍逐位相等。
 *
 * 空块(无非空格)⇒ `null`:不建面,也就没有颜色。
 */
export function lodBlockColor(cellZs: readonly number[], isTop: boolean): LodBlockColor | null {
  const span = lodBlockSpan(cellZs);
  if (span.cells === 0) return null;
  const layer = elevLayerOfZ(span.maxZ);
  return { color: faceColor(layer, isTop), layer, dz: span.dz, verdict: lodMergeVerdict(span.dz) };
}

/**
 * 合并色对块内**每一格**的最大**行偏差**(单位 = 调色板行)。
 *
 * 阶跃口径下它恒等于 `Δz`(`elevLayerOfZ` 的层间距就是 1 个世界 z,见阈值注释第 1 条)——
 * 这条等式本身是判据:谁把 `elevLayerOfZ` 改成非线性(夹紧/取整变了),
 * 「阈值以 Δz 计」与「偏差以行计」就会脱钩。
 *
 * 返回 `null` 表示块内没有非空格(无面可查,不是 0 行)。
 */
export function lodColorDriftRows(cellZs: readonly number[]): number | null {
  const span = lodBlockSpan(cellZs);
  if (span.cells === 0) return null;
  const blockLayer = elevLayerOfZ(span.maxZ);
  let worst = 0;
  for (const z of cellZs) {
    if (!Number.isFinite(z)) continue;
    const d = Math.abs(blockLayer - elevLayerOfZ(z));
    if (d > worst) worst = d;
  }
  return worst;
}

/* ───────────── 跨块不合并(块的身份与合并域) ───────────── */

/**
 * 合并块的**身份**:`(Chunk 键, 块内 x, 块内 y)`。
 * 缺 chunk 键就无法区分「本块的 bx+1」与「东邻 Chunk 的 bx=0」:世界坐标相邻,块却不同。
 */
export interface LodBlockId {
  /** Chunk 键(`ChunkInput.key`) */
  chunk: string;
  bx: number;
  by: number;
}

/** 两块的合并关系 */
export type LodMergeScope = 'SAME_BLOCK' | 'OTHER_BLOCK' | 'CROSS_CHUNK';

/**
 * 两块是否可**合并成一个面**:
 *
 * ```
 * 同一个块              ⇒ SAME_BLOCK  —— 唯一可以共享一次合并的场合
 * 同一 Chunk 的另一个块  ⇒ OTHER_BLOCK —— 不合并(只比 z 出侧面)
 * 不同 Chunk            ⇒ CROSS_CHUNK —— 永不合并
 * ```
 *
 * ## 为什么跨块(含跨 Chunk)永不合并
 *
 * 1. `dominantZGrid` 只在**一个** Chunk 的 16×16 格内取块内最高 z;`neighborZs` 对邻块
 *    只**比** z 决定出不出侧面(`buildChunkQuads` / `neighborZs`,tile_mesh.ts:182/222),
 *    从不把邻块并进自己的块 —— 合并域就是 Chunk 边界。
 * 2. `aLodMerge` 是**每 Chunk 一份**的属性(`three/compat.ts` 的 `assembleChunkGeometry`
 *    用同一个 lod 填满整个 Chunk 的每个顶点)。若两块跨 Chunk 共享一个合并面,
 *    该面就同时属于两份 merge 不同的几何 ⇒ 顶点色/细节口径不可复现,阈值判据随之失效。
 * 3. 相邻块之间只有「谁更高」这一个关系(`nb.north < z` ⇒ 出侧面),等高就是各自独立的
 *    两个顶面 —— 拼成一个面会让「相邻块高差」这件事无处表达。
 */
export function lodMergeScope(a: LodBlockId, b: LodBlockId): LodMergeScope {
  if (a.chunk !== b.chunk) return 'CROSS_CHUNK';
  if (a.bx === b.bx && a.by === b.by) return 'SAME_BLOCK';
  return 'OTHER_BLOCK';
}

/** 两张面能否共用一个合并面:只有**同一个块内**可以;跨块(含跨 Chunk)永远不行 */
export function lodMayShareMergedFace(a: LodBlockId, b: LodBlockId): boolean {
  return lodMergeScope(a, b) === 'SAME_BLOCK';
}