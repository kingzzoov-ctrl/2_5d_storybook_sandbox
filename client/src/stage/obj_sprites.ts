/**
 * WS-FND-183 / `obj` 层的**立牌计划** —— 纯函数,零三方依赖,可在 node 里直接测。
 *
 * ## 要修的是什么
 *
 * `chunk_geometry.ts` 把格子的 `obj` 层**只当「这格非空」**来判建面
 * (`tileZ()`:三个字段全 0 才是空气),于是 `obj` 层除了「让格子不是空的」以外
 * **不产生任何可见物**:服务器世界与设计图(`shared/world/design.ts`)里写进去的
 * 路灯 522、角柱/承重墙 352、篝火 501、纪念碑 750 …… 玩家一个都看不到。
 * 这不是「画错了」,是**从来没被画过** —— 而既有判据全绿,因为它们查的是
 * 地形面数、顶点色长度这些**与 `obj` 无关**的量。
 *
 * `three/boot.ts` 里那几块立牌(`ATLAS_SAMPLE_IDS = [101,111,152,304]`)是
 * **把图集当装饰摆**的演示,不是「按 obj id 画」;本模块补的是后者。
 *
 * ## 职责边界(为什么是纯函数 + 为什么不放 boot.ts)
 *
 * 本文件只产出**计划**(每条 = 一格该摆什么、摆在哪、多高),不碰 three、不碰 DOM。
 * 摆到场景里是装配层的事(`three/**` 才允许 import three,见 `assembly_math.ts` 的分层不变量)。
 * 这样「按 id 出立牌」这条规则可以被测试直接驱动,而不是只能靠截图看。
 *
 * ## 三处口径**必须复用**,不许各写一份
 *
 * | 量 | 唯一来源 | 各写一份的下场 |
 * |----|----------|----------------|
 * | 海拔 → 世界 z | `tile_mesh.ELEV_TO_Z` | 立牌与地形面**不在同一层**:立牌悬空或埋进地里 |
 * | id → 图集格 | `assembly_math.cellIndexFromId` | id 不是下标(跨度 758 / 帧 358,缺 400)⇒ 静默错位 97 格 |
 * | 世界格坐标 | `chunk.cx * CHUNK_SIZE + lx` | 与 `chunk_geometry` 的恒等映射脱节,整块偏移 |
 *
 * ## 不抛异常(逐条兜底)
 *
 * 高频路径:一个 chunk 256 格、一帧可能几十个 chunk。任何一条记录抛异常都会
 * 打断整帧,而「少画一个路灯」是可接受的降级。所以:
 *   - `tiles` 长度不足 256 ⇒ 缺的格按 `0`(空气)算,不越界读;
 *   - `elev` 越界或非整数 ⇒ `elevToZSafe` 回落到地平面 `0`;
 *   - 未知 id ⇒ `atlasCell = -1`(**`cellIndexFromId` 的原样返回值**,表示「图集里没有这一格」)
 *     + 高度走兜底档;是否跳过由装配层决定,**不在纯函数里偷偷丢记录**。
 */

import { unpackTile } from '../../../shared/types/tile.ts';

import { cellIndexFromId } from './assembly_math.ts';
import { CHUNK_CELLS, CHUNK_SIZE, ELEV_TO_Z, type ChunkInput } from './tile_mesh.ts';

/* ───────────────────────────── 数据结构 ───────────────────────────── */

/**
 * 一条立牌记录。字段全部是**世界单位/像素**的原值,不含任何引擎对象:
 * 装配层拿到后只需要「取图集那一格 + 按 pixelScale 缩放」。
 */
export interface ObjSpriteInput {
  /** `obj` = 物品表的 id(区块 `obj` 层);`vegetation` = 不属于物品表的装饰(树/草) */
  kind: 'obj' | 'vegetation';
  /** 物品 id(`kind: 'obj'`)或装饰 id(`kind: 'vegetation'`) */
  id: number;
  /** 世界格坐标 x = `chunk.cx * CHUNK_SIZE + 块内 x`(恒等映射,1 格 = 1 世界单位) */
  x: number;
  /** 世界格坐标 y */
  y: number;
  /** 该格的世界 z(`ELEV_TO_Z[elev]`)—— 立牌踩在**这一格的地面**上,不是脚底相对高度 */
  z: number;
  /** 图集 row-major 格号;**`-1` = 图集里没有这个 id** */
  atlasCell: number;
  /** 立牌高度(屏幕像素),装配层按 `billboardScale(heightPx, cam)` 缩放 */
  heightPx: number;
}

/* ───────────────────── 参数表(高度档 + 密度档,集中一处)───────────────────── */

/** 一档 id 区间 → 一个高度(像素) */
export interface ObjHeightTier {
  /** 区间起点(含) */
  from: number;
  /** 区间终点(含) */
  to: number;
  /** 立牌高度(屏幕像素) */
  heightPx: number;
  /** 这一档为什么是这个高度(给下一个读表的人,不给编译器) */
  why: string;
}

/**
 * 立牌高度档表 —— **按 id 区间分档**。
 *
 * 区间不是随手划的:与 `shared/contracts/FREEZE.md:112` 的物品号段**逐段一致**
 * (图集 `id_101..id_858` 就是照这些号段出的图,见 `assembly_math.ATLAS_ID_SEGMENTS`)。
 * ⇒ 新增物品只要落在既有号段里,高度自动正确;真正需要人工判断的只有
 * 「这个号段的东西整体该多高」。
 *
 * ## 数值口径:1 格 = `TILE_PX = 16` 屏幕像素
 *
 * `iso_camera.TILE_PX = 16`,而 `billboardScale(heightPx, cam) = heightPx / pixelScale(cam)`
 * (`assembly_math.ts`)⇒ **heightPx 就是屏幕像素**,16px = 一格高。各档理由:
 *
 * - **8px(半格)地砖 301~330**:地砖本该走 `floor` 层;若有人把地砖放进 `obj` 层,
 *   画半格高既不遮地形也不像一堵墙 —— 比「默认 16px」更接近它实际是什么。
 * - **12px(0.75 格)自然产物 101~130**:蘑菇/浆果/贝壳这类贴地小物,比一格矮,
 *   与玩家立牌(`entity_sprites.SPRITE_HEIGHT_PX.player = 28`)拉开层次。
 * - **32px(2 格)建筑构件 351~385**:墙/门/窗/栏杆要围出「一层楼」的空间感;
 *   1 格高会在等轴测下被地形顶面吃掉,看不出是墙。
 * - **20px(1.25 格)家具设备 501~537**:桌椅/箱子/篝火的自然体量 —— 比人矮、比地面物件高。
 * - **16px(1 格)兜底**:取 `TILE_PX`,即「一格那么大」的默认体量,
 *   与 `entity_sprites.SPRITE_HEIGHT_PX.prop = 16` 同值(同类东西不该有两个默认高度)。
 *
 * 表**按 from 升序**排,但 `objSpriteHeightPx` 是线性扫描、不依赖顺序 ⇒
 * 以后插一行不会因为忘了重排而静默失配。
 */
export const OBJ_HEIGHT_PX_TIERS: readonly ObjHeightTier[] = [
  { from: 101, to: 130, heightPx: 12, why: '自然采集物(贴地小物)' },
  { from: 151, to: 170, heightPx: 14, why: '半成品(木条/铁锭,略高于贴地物)' },
  { from: 201, to: 218, heightPx: 14, why: '工具(与半成品同档,便于堆叠时视觉齐平)' },
  { from: 221, to: 255, heightPx: 14, why: '整蛊玩具(同上)' },
  { from: 301, to: 330, heightPx: 8, why: '地砖:本应走 floor 层,放 obj 层时画半格高' },
  { from: 351, to: 385, heightPx: 32, why: '建筑构件:墙体/门窗要围出 2 格高的一层楼' },
  { from: 401, to: 440, heightPx: 18, why: '电路物流竞技:轨道/传送带略高于一格' },
  { from: 501, to: 537, heightPx: 20, why: '家具设备:桌椅/箱子/篝火,比人矮比地物高' },
  { from: 601, to: 630, heightPx: 16, why: '料理时装:盘装菜/衣服,一格' },
  { from: 701, to: 745, heightPx: 18, why: '战利品/武器/护甲/祭品:立起来的兵器比一格高一点' },
  { from: 746, to: 754, heightPx: 18, why: '手册补录(牧场产出等):沿用 701 段体量' },
  { from: 801, to: 806, heightPx: 20, why: '首领/建筑级展示件' },
  { from: 811, to: 834, heightPx: 20, why: '同上(811~834 号段)' },
  { from: 851, to: 858, heightPx: 24, why: '大型装置:比家具再高一档' },
];

/** 未知 id / 落不进任何档时的兜底高度(像素)= 1 格 */
export const OBJ_SPRITE_FALLBACK_HEIGHT_PX = 16;

/**
 * 一个 chunk 最多产出的立牌数。
 *
 * `CHUNK_SIZE² = 256` = 「每格最多一个」,即**默认不截断**:
 * 截断必须是调用方显式的性能取舍,不能是我埋在默认值里的行为
 * (被默认值悄悄丢掉的立牌是最难查的那种 bug)。
 */
export const OBJ_SPRITE_MAX_PER_CHUNK = CHUNK_CELLS;

/** 装饰哈希取值的模数(把 32 位哈希折进 `[0, MODULO)` 再与阈值比) */
export const VEG_HASH_MODULO = 1000;

/**
 * 每多一种可选装饰 id,允许的每格放置率(千分比)。
 *
 * ⇒ **密度 = `ids.length` × 本常量**,上限 `VEG_PERMILLE_MAX`。
 * 这样「调用方传几个 id」与「阈值常量」两个旋钮都真的参与密度:
 * 传 1 种树 ⇒ 1.5%,传 8 种(树/草/花/石…)⇒ 12%。理由:种类越多说明这一片
 * 越像「有植被的地貌」而不是「偶尔一棵树」,但**不能无限涨** ——
 * 空地全被立牌盖住就看不出地形了,12% 是「看得出来是同一片草地,但明显有东西」的量级。
 */
export const VEG_PERMILLE_PER_ID = 15;

/** 每格放置率上限(千分比)= 12% */
export const VEG_PERMILLE_MAX = 120;

/**
 * 装饰摆放的**全部可调参数集中一处**(高度档 + 密度档)。
 *
 * 为什么还要一份聚合:调参时只该看一个地方。逐项导出的常量(上面那些)
 * 供代码引用,本对象供「读一份表就看见全部旋钮」与参数自检用;
 * 两者由 `OBJ_HEIGHT_PX_TIERS` / `OBJ_SPRITE_FALLBACK_HEIGHT_PX` / `VEG_*` 反向引用,不复制数值
 * (复制就会漂移:改了表忘了改对象,门禁也看不出)。
 */
export const OBJ_SPRITE_TUNING = {
  /** `obj !== 0` 的立牌高度档(像素) */
  heightTiers: OBJ_HEIGHT_PX_TIERS,
  /** 未知 id 的兜底高度(像素) */
  fallbackHeightPx: OBJ_SPRITE_FALLBACK_HEIGHT_PX,
  /** 一个 chunk 的立牌上限 */
  maxPerChunk: OBJ_SPRITE_MAX_PER_CHUNK,
  /** 装饰哈希模数 */
  vegHashModulo: VEG_HASH_MODULO,
  /** 每种装饰 id 贡献的千分比密度 */
  vegPermillePerId: VEG_PERMILLE_PER_ID,
  /** 千分比密度上限 */
  vegPermilleMax: VEG_PERMILLE_MAX,
} as const;

/* ───────────────────── 两个共用的兜底(可单独测)───────────────────── */

/**
 * `elev`(0..3 的位域取值)→ 世界 z,**复用 `ELEV_TO_Z`**;越界/非数 ⇒ `0`(地平面)。
 *
 * 为什么单独导出:`unpackTile` 只取 2 位,所以 `elev ≥ 4` **不可能**从 `tiles` 里出来 ——
 * 也就是说这条兜底在 `planObjSprites` 的入参路径上**不可达**。
 * 把它抽成一个可直接调用的纯函数,兜底才有一个能被真跑到的入口
 * (否则「越界不抛」只能靠读代码相信)。
 */
export function elevToZSafe(elev: number): number {
  const n = Number.isFinite(elev) ? Math.trunc(elev) : Number.NaN;
  const z = ELEV_TO_Z[n];
  return typeof z === 'number' ? z : 0;
}

/** id → 立牌高度(像素)。落不进任何档 ⇒ 兜底档,不抛。 */
export function objSpriteHeightPx(id: number): number {
  if (!Number.isFinite(id)) return OBJ_SPRITE_FALLBACK_HEIGHT_PX;
  for (const t of OBJ_HEIGHT_PX_TIERS) {
    if (id >= t.from && id <= t.to) return t.heightPx;
  }
  return OBJ_SPRITE_FALLBACK_HEIGHT_PX;
}

/** 上限归一:`undefined` ⇒ 默认值;非有限/负数 ⇒ 0(什么都不画,而不是 `NaN` 比较全 false) */
function normalizeCap(maxPerChunk: number | undefined): number {
  if (maxPerChunk === undefined) return OBJ_SPRITE_MAX_PER_CHUNK;
  if (!Number.isFinite(maxPerChunk)) return 0;
  return Math.max(0, Math.trunc(maxPerChunk));
}
/* ───────────────────── obj 层立牌计划 ───────────────────── */

/**
 * 一个 chunk 里 `obj !== 0` 的格子 → 立牌列表。
 *
 * ## 判据
 *  - **只对 `obj !== 0` 产出**。`obj === 0`(空格、纯地形格、只有 `floor` 的铺装格)
 *    一条都不产出 —— 这是本函数与「每格都摆一个」的分界线,也是测试里那条
 *    「数量 == 非空 obj 格数」的牙。
 *  - 顺序:`y` 外、`x` 内(与 `tile_mesh.dominantZGrid` /
 *    `chunk_geometry.dominantMaterialGrid` 同一扫描顺序),于是同一 chunk 必得同一数组。
 *  - 每格**一条**(一格一个 obj;`meta` 朝向不进计划 —— 朝向属于装配层的图集帧选择)。
 *  - 不抛异常:`tiles` 不足 256 ⇒ 缺格按空气;`elev` 越界 ⇒ `elevToZSafe` 兜底;
 *    未知 id ⇒ `atlasCell = -1` + 兜底高度。
 */
export function planObjSprites(chunk: ChunkInput, opts?: { maxPerChunk?: number }): ObjSpriteInput[] {
  const cap = normalizeCap(opts?.maxPerChunk);
  const out: ObjSpriteInput[] = [];
  if (cap === 0) return out;

  const originX = chunk.cx * CHUNK_SIZE;
  const originY = chunk.cy * CHUNK_SIZE;

  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      /* 长度不足 256 时不越界:`?? 0` 把缺格当空气(不抛) */
      const tile = chunk.tiles[y * CHUNK_SIZE + x] ?? 0;
      const u = unpackTile(tile);
      if (u.obj === 0) continue;
      out.push({
        kind: 'obj',
        id: u.obj,
        x: originX + x,
        y: originY + y,
        z: elevToZSafe(u.elev),
        /* 唯一来源:`assembly_math.cellIndexFromId`(id ≠ 下标);未知 id ⇒ -1 */
        atlasCell: cellIndexFromId(u.obj),
        heightPx: objSpriteHeightPx(u.obj),
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/* ───────────────────── 装饰(树/草)计划 ───────────────────── */

/**
 * 确定性哈希:`(seed + x·73856093) ^ (y·19349663)`,结果按 `>>> 0` 取无符号 32 位。
 *
 * 两个常数是常用的「大素数散列」系数(深度的乘数不同 ⇒ x/y 不会互相抵消)。
 * 我**没有用随机数发生器**:这里要的是「同一 (x, y, seed) 永远同一个值」,
 * 不需要序列,也不该有跨调用状态(有状态就会让「同输入两次调用」不相等)。
 * JS 的 `^` 会先 `ToInt32`,乘出来的 7.5e10 级中间值因此被确定性地绕回 ——
 * 平台无关、版本无关,这正是「确定性」需要的性质。
 *
 * ⚠️ **实测性质(必须知道的坑)**:`seed` 是**加性**进入哈希的,没有雪崩 ⇒
 * **相邻 seed 给出几乎相同的布局**(实测 `seed=1` vs `seed=2` 在 16×16 全草地 chunk 上
 * **逐条相同**;`1` vs `3` 只差 2 格)。⇒ 世界种子**不许**直接用「自增小整数」,
 * 取用前先乘一个大常数(例如 `Math.imul(seed, 0x9e3779b1)`)再传进来;
 * 判据见 `tests/WS-FND-183` 用例 14(它按这条性质挑了相距很远的 seed,
 * 并把「相邻 seed 相同」这个事实写在注释里,不是悄悄绕开)。
 */
export function vegetationHash(x: number, y: number, seed: number): number {
  return ((seed + x * 73856093) ^ (y * 19349663)) >>> 0;
}

/**
 * 放置率(千分比)= `min(VEG_PERMILLE_MAX, VEG_PERMILLE_PER_ID × ids.length)`,
 * `ids` 为空时 0。**密度与「传了几种装饰」挂钩**,见 `VEG_PERMILLE_PER_ID` 的说明。
 */
export function vegPlacementPermille(idCount: number): number {
  const n = Number.isFinite(idCount) ? Math.max(0, Math.trunc(idCount)) : 0;
  return Math.min(VEG_PERMILLE_MAX, VEG_PERMILLE_PER_ID * n);
}

/**
 * 装饰立牌:对**没有 `obj` 的空地格**(`obj === 0` 且 `base !== 0`,即「有地表、但没东西」)
 * 按确定性哈希决定是否放一株、放 `ids` 里的哪一个。
 *
 * ## 为什么装饰要另走一条路,而不是塞进物品表
 *
 * 树/草丛这类东西**不在物品表里**(`shared/constants/items.ts` 的 358 个 id 全是可合成/可放置的物品),
 * 而它们又必须铺满整张地图 ⇒ 不可能由服务器逐格写进 `obj` 层。
 * ⇒ 客户端按 seed 生成:世界种子决定「哪里长树」,同一 seed 处处一致(可截图回归、可多人同图)。
 *
 * ## 判据
 *  - 只落在 `obj === 0 && base !== 0` 的格(不盖住路灯/篝火,也不落在虚空/流体的空 base 上);
 *  - `id` 必取自 `ids`;`ids` 为空 ⇒ **空数组**(不是「画不出来但照样解引用」);
 *  - 同一 `(chunk, ids, seed)` 必得同一结果,顺序仍是 `y` 外 `x` 内;
 *  - 哈希取模决定「放不放」,哈希高位决定「哪一种」—— 两件事用同一个哈希的不同位段,
 *    避免「能放的地方永远只长同一种」(那会让整张图看起来只有一棵树的复制品)。
 */
export function planVegetationSprites(
  chunk: ChunkInput,
  ids: readonly number[],
  seed: number,
): ObjSpriteInput[] {
  const out: ObjSpriteInput[] = [];
  if (ids.length === 0) return out;

  const permille = vegPlacementPermille(ids.length);
  if (permille === 0) return out;

  const originX = chunk.cx * CHUNK_SIZE;
  const originY = chunk.cy * CHUNK_SIZE;

  for (let y = 0; y < CHUNK_SIZE; y += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const tile = chunk.tiles[y * CHUNK_SIZE + x] ?? 0;
      const u = unpackTile(tile);
      if (u.obj !== 0) continue;
      if (u.base === 0) continue;
      const h = vegetationHash(x, y, seed);
      if (h % VEG_HASH_MODULO >= permille) continue;
      const pick = ids[Math.floor(h / VEG_HASH_MODULO) % ids.length]!;
      out.push({
        kind: 'vegetation',
        id: pick,
        x: originX + x,
        y: originY + y,
        z: elevToZSafe(u.elev),
        atlasCell: cellIndexFromId(pick),
        heightPx: objSpriteHeightPx(pick),
      });
    }
  }
  return out;
}
