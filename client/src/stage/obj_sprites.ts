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
 * WS-FND-190 在上面两条计划函数之上再加一层**批计划**(`planPropBatches`,见文件末尾):
 * 同一图集格的实例合成一批 ⇒ 装配层用一次 draw call 画一批,封顶口径也随之从
 * 「立牌条数」换成「实例总数」。
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

import { ATLAS_PX_PER_CELL, SPRITE_CELL_WORLD, cellIndexFromId } from './assembly_math.ts';
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

/* ═══════════════════════ 批绘制计划(WS-FND-190)═══════════════════════
 *
 * ## 要修的是什么
 *
 * 上面两条计划函数产出的**每一条立牌**,在装配层曾经对应**一个 `THREE.Sprite`**
 * ⇒ 一条立牌一次 draw call。实测世界里已有 **615 条**立牌在画,而 `three/boot.ts`
 * 的 `SPRITE_BUDGET = 600` 是按**立牌条数**封顶的 ⇒ 600 次 draw call 就是天花板,
 * 树/草只能稀疏地撒,密度再也上不去。
 *
 * 物理上正确的做法:**同一图集格的一批用一次 draw call**(`InstancedMesh`)。
 * 一批的实例矩阵在装配层一次上传,之后每批一次调用 ⇒ 封顶的口径必须从
 * 「立牌条数」换成「**实例总数**」:前者管的是 draw call(真正决定它的是**批数**),
 * 后者才是 GPU 的实际负载。
 *
 * ## 本模块负责什么、不负责什么
 *
 * 这里只产出**批计划**(纯数据):哪些实例属于同一图集格、每个实例在**批内**摆在哪、
 * 多高。怎么建 `THREE.InstancedMesh`、矩阵怎么填,是装配层的事
 * (`three/prop_batch.ts` 允许 import three —— 见 `assembly_math.ts` 的分层不变量)。
 * 这样「同格合并 / 组内顺序 / 封顶」这三条规则可以被测试直接驱动,而不是只能靠截图看。
 *
 * ## 三处口径(与既有代码同源,不各写一份)
 *
 * | 量 | 来源 | 各写一份的下场 |
 * |----|------|----------------|
 * | 像素高 → 世界高 | `assembly_math.SPRITE_CELL_WORLD / ATLAS_PX_PER_CELL` | 与既有 Sprite 路径大小不一致(本仓实测过一次放大 16 倍的事故) |
 * | 批内局部坐标 | 格心 `x + 0.5`(与 `three/boot.ts` 立牌落点同一做法) | 整批偏移半格 |
 * | 批原点 | 组内 `min 格心 x / min 格心 y / min z`,**从数据算** | 拿「首条」当原点 ⇒ 输入换个序原点就变,结果不可复现 |
 *
 * ## 组内顺序为什么是 `x` 主序
 *
 * 实例化之后**批内无法逐实例重排**,所以批内顺序**就是**提交顺序(也近似绘制顺序)。
 * 按 `(x, y)` 升序:输入乱序也得到同一个数组(可复现),且等轴测相机在 `+x+y` 方向
 * ⇒ 这个顺序近似「由远及近」。注意它与 `planObjSprites` 的扫描序(`y` 外 `x` 内)
 * **不同**:那条序服务于「同一 chunk 必得同一数组」,这条序服务于「同一批必得同一
 * 提交序」,目的不同 ⇒ 各自确定,不互相借用(借用会把其中一边的目的悄悄丢掉)。
 */

/**
 * 一次 `planPropBatches` 调用最多产出多少个**实例**(既不是批数,也不是立牌条数)。
 *
 * ## 为什么是 16384(不是随手挑一个「大数」)
 *
 * | 量 | 16384 实例下的值 | 说明 |
 * |----|------------------|------|
 * | 顶点 / 三角形 | 65536 / 32768 | 每实例 = 单位面 4 顶点 2 三角形 |
 * | `instanceMatrix` | 16 × 4 B × 16384 = **1 MiB 整** | 2^14 ⇒ 一次上传,不用换算 |
 * | draw call | = **批数** ≤ 图集不同格数 ≤ 358(`ATLAS_SPRITE_COUNT`) | 与实例数**无关** |
 *
 * 三个理由:
 *  1. 它取代的是「600 条立牌」这个口径 —— 600 之所以是天花板,是因为当时
 *     draw call 数 = 立牌数。实例化后 draw call 由**批数**决定(实测量级:几批到
 *     几十批),于是同样多的调用次数可以换到 **27 倍**以上的可见立牌(600 → 16384);
 *  2. **1 MiB 的矩阵缓冲**与一辆 chunk 地形网格的上传同量级,不引入新的量级;
 *  3. 上限**必须存在**:没有上限时,一次「把已加载的所有块都计划一遍」会吃掉几百 MB
 *     矩阵缓冲 —— 那不是「画得多」,是崩。超限时按**全局前缀**截断(确定性,见
 *     `planPropBatches`)。
 *
 * ⚠️ 这是**每次调用**的封顶。调用方按 chunk / 视野分次调用时,实例总数是
 * 「调用次数 × 本值」——那才是全局量,而它只能由调用方控制(只有它知道要摆多少块)。
 */
export const PROP_INSTANCE_BUDGET = 16384;

/**
 * 像素 → 世界单位的换算:`SPRITE_CELL_WORLD / ATLAS_PX_PER_CELL`
 * = (64/41) / 41 ≈ 0.0381 世界单位每像素。
 *
 * 与 `three/boot.ts` 里现用的 `(heightPx / ATLAS_PX_PER_CELL) * SPRITE_CELL_WORLD`
 * 是**同一个乘式**(只是先乘后除),两个常量都取自 `assembly_math`:
 * 41 图素 = 1 格,而这张 64px 画布在世界里占 `64/41` 格。
 */
export const OBJ_HEIGHT_WORLD_PER_PX = SPRITE_CELL_WORLD / ATLAS_PX_PER_CELL;

/** 未知 id / 兜底档高度对应的世界高度(`OBJ_SPRITE_FALLBACK_HEIGHT_PX` × 换算比) */
export const OBJ_SPRITE_FALLBACK_HEIGHT_WORLD =
  OBJ_SPRITE_FALLBACK_HEIGHT_PX * OBJ_HEIGHT_WORLD_PER_PX;

/**
 * 装饰(树/草)立牌的世界高度(格)。
 *
 * 为什么装饰**不看 `heightPx`**:树/草要能「盖住人」(`entity_sprites` 的玩家立牌
 * 28px ≈ 1.75 格),而从物品表里挑出来的那几张植被图(118/379/319/121)判出来的
 * 高度档只有 12px ⇒ 按物品档位画会矮到看不见。
 *
 * ⚠️ 本常量与 `three/boot.ts` 里的 `VEG_HEIGHT_WORLD` **当前同值(2.6)**。接线时应把
 * 那一处改成 import 本常量 —— 两处各写 2.6 不会有任何判据变红(漂了只能靠眼睛发现)。
 */
export const PROP_VEG_HEIGHT_WORLD = 2.6;

/**
 * 立牌面的宽高比(`宽 = 高 × 0.92`)。
 *
 * 图集帧是 64×64 的方画布,而其中「一格」的实际水平对角线只有 58px(见
 * `assembly_math.ATLAS_TILE_WIDTH_PX`)⇒ 横向略压一点才与地形格宽吻合。
 * `three/boot.ts` 的 `sp.scale.set(h * 0.92, h, 1)` 用的是同一个比例。
 */
export const PROP_SPRITE_ASPECT_X = 0.92;

/**
 * 一个**绘制批**:同一 `atlasCell` 的实例集合 ⇒ 装配层一个 `THREE.InstancedMesh`
 * ⇒ **一次 draw call**。
 *
 * ## 为什么按「图集格」分组,而不是按物品 id
 *
 * draw call 的个数由**材质切换次数**决定。同一张图集的不同格共用同一张纹理,
 * 但各自需要一份 `offset/repeat`(见 `assembly_math.offsetRepeatOfCell`)⇒ 材质必须
 * 按格分开;而同一个格的实例可以共用那一份材质 ⇒ 一次画完。
 * 所以分组键是 `atlasCell`;**`atlasCell < 0`(图集里没有这个 id)的项不参与分组** ——
 * 它没有可用的材质,画出来只会是错位的图(装配层必须跳过,见 `three/prop_batch.ts`)。
 *
 * ## 字段口径
 *
 * - `count`:本批实例数。所有批的 `count` 之和 = **参与分组的项数**(≤ 输入项数);
 * - `offsets`:**每实例 3 个 float**(`x, y, z`),是**批内局部坐标**:
 *   格心 `x + 0.5` 减 `originX`、`y + 0.5` 减 `originY`、`z` 减 `originZ`
 *   ⇒ `offsets.length === count * 3`;
 * - `heights`:**每实例 1 个 float**,世界单位高度(装配层按它缩放立牌面)
 *   ⇒ `heights.length === count`;
 * - `originX/Y/Z`:批原点(世界单位)。装配层把它放进 `InstancedMesh.position`,
 *   或直接揉进实例矩阵,两种做法等价 —— 本模块只保证「原点 + 局部偏移」能还原出
 *   原世界位置,不规定装配层用哪种;
 * - `kind`:**组内首实例**(按组内顺序)的类别,仅供诊断与统计;**绘制不看它** ——
 *   决定绘制的一切都在 `atlasCell` 与每实例高度里。
 * - `mixedKind`:本批是否**混了类别**。同一图集格上既有物品立牌又有装饰是真会发生的
 *   (例如物品 118 与装饰 id 118 落在同一格)⇒ 这类批**不拆**:拆开只会多一次
 *   draw call,而画出来的东西完全一样(高度本来就逐实例不同)。
 */
export interface PropBatch {
  /** 图集 row-major 格号;恒 `>= 0`(负值项不参与分组,见上) */
  atlasCell: number;
  /** 组内首实例的类别(**诊断用**,绘制不读它) */
  kind: 'obj' | 'vegetation';
  /** 本批是否混了 `obj` 与 `vegetation`(见上) */
  mixedKind: boolean;
  /** 本批实例数 */
  count: number;
  /** 批内局部坐标:每实例 3 个 float(`length === count * 3`) */
  offsets: Float32Array;
  /** 每实例世界高度(世界单位;`length === count`) */
  heights: Float32Array;
  /** 批原点 x(世界单位) */
  originX: number;
  /** 批原点 y(世界单位) */
  originY: number;
  /** 批原点 z(世界单位) */
  originZ: number;
}

/** 批计划的旋钮(全部有默认值;不传就是「产品口径」) */
export interface PropBatchPlanOptions {
  /** 本次调用的实例上限,默认 `PROP_INSTANCE_BUDGET`。`0` ⇒ 什么都不产出 */
  maxInstances?: number;
  /** 装饰立牌的世界高度,默认 `PROP_VEG_HEIGHT_WORLD` */
  vegetationHeightWorld?: number;
  /** 物品立牌的「像素 → 世界」换算比,默认 `OBJ_HEIGHT_WORLD_PER_PX` */
  objHeightWorldPerPx?: number;
}

/** 上限归一:`undefined` ⇒ 默认值;非有限 ⇒ 0(什么都不画,而不是让比较恒 false) */
function normalizeInstanceBudget(v: number | undefined): number {
  if (v === undefined) return PROP_INSTANCE_BUDGET;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.trunc(v));
}

/**
 * 像素高 → 世界高度。非有限/非正的像素高 ⇒ 兜底档;换算比坏了 ⇒ 回到默认换算比。
 *
 * 为什么要单独一个函数:同一条换算在装配层也要用(`three/prop_batch.ts` 的兜底),
 * 两处各写一份乘式迟早会漂 —— 这里的是**唯一来源**。
 */
export function objSpriteHeightWorld(
  heightPx: number,
  worldPerPx: number = OBJ_HEIGHT_WORLD_PER_PX,
): number {
  const k = Number.isFinite(worldPerPx) && worldPerPx > 0 ? worldPerPx : OBJ_HEIGHT_WORLD_PER_PX;
  const px = Number.isFinite(heightPx) ? heightPx : OBJ_SPRITE_FALLBACK_HEIGHT_PX;
  const h = px * k;
  return Number.isFinite(h) && h > 0 ? h : OBJ_SPRITE_FALLBACK_HEIGHT_WORLD;
}

/** 批计划内部的实例记录(规范化之后;负 `atlasCell` 已经在筛选阶段被丢掉) */
interface PropInstance {
  x: number;
  y: number;
  z: number;
  atlasCell: number;
  kind: 'obj' | 'vegetation';
  heightWorld: number;
}

/**
 * 规范序:`x` 升 → `y` 升 → `atlasCell` 升 → `kind` 字典序 → 相等。
 *
 * 前两级是「组内顺序按 x,y 升序」这条判据;后两级只是**完全排序**需要的兜底
 * (两条记录若 `x/y/cell/kind` 全同,则它们的绘制数据**逐字节相同** ⇒ 谁在前都一样,
 * 顺序不再有可观察差异)。坐标在进排序前已经规范化成有限数,所以这里不会出现
 * `NaN` 比较(比较器返回 `NaN` 会让排序结果依赖引擎实现)。
 */
function comparePropInstances(a: PropInstance, b: PropInstance): number {
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.atlasCell !== b.atlasCell) return a.atlasCell < b.atlasCell ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/**
 * 立牌列表 → 批列表。**纯函数**:只读输入,不碰 three、不碰 DOM。
 *
 * ## 判据(每条都能被坏实现打红)
 *
 * 1. **按 `atlasCell` 分组**:同格的项合进一批。改成「每项一批」⇒ 批数必不等于
 *    不同格数(测试第一条就是这么验证的);
 * 2. **组内顺序确定**:先按 `comparePropInstances` 全局排序再分组 ⇒ 输入乱序也得到
 *    同一个数组(`JSON.stringify` 逐字节相等);
 * 3. **批顺序确定**:按 `atlasCell` 升序输出(不依赖 `Map` 的插入顺序,那会跟着输入走);
 * 4. **`atlasCell < 0`(含非整数/`NaN`)不参与分组**:它们没有图集帧可用;
 * 5. **实例总数封顶**:超过上限时按**全局规范序取前缀**(确定性),不是随机丢、也不是
 *    「按批整块丢」(整块丢会让编号靠后的图集格永远不出现);
 * 6. **空输入 / 上限为 0 / 全部项都被筛掉 ⇒ `[]`**(不是「长度为 1 的空批」);
 * 7. **不抛异常**:坐标/高度是 `NaN`/`Infinity` 时按 `0`(坐标)与兜底档(高度)处理。
 *    高频路径上一个坏数不该打断整帧,而「少画一个」是可接受的降级。
 */
export function planPropBatches(
  items: readonly ObjSpriteInput[],
  opts?: PropBatchPlanOptions,
): PropBatch[] {
  const out: PropBatch[] = [];
  const cap = normalizeInstanceBudget(opts?.maxInstances);
  if (items.length === 0 || cap === 0) return out;

  const vegOpt = opts?.vegetationHeightWorld;
  const vegHeightWorld =
    vegOpt !== undefined && Number.isFinite(vegOpt) && vegOpt > 0 ? vegOpt : PROP_VEG_HEIGHT_WORLD;
  const perPx = opts?.objHeightWorldPerPx;

  /* ── 1 筛选 + 规范化(未知图集格在这里被丢掉,不占预算) ── */
  const cand: PropInstance[] = [];
  for (const it of items) {
    const cell = it.atlasCell;
    /* `atlasCell < 0` = 图集里没有这个 id(`cellIndexFromId` 的原样返回值);
       非整数/NaN 同理:没有「半格」这种图集帧。 */
    if (!Number.isInteger(cell) || cell < 0) continue;
    const x = Number.isFinite(it.x) ? it.x : 0;
    const y = Number.isFinite(it.y) ? it.y : 0;
    const z = Number.isFinite(it.z) ? it.z : 0;
    cand.push({
      x,
      y,
      z,
      atlasCell: cell,
      kind: it.kind === 'vegetation' ? 'vegetation' : 'obj',
      heightWorld: it.kind === 'vegetation'
        ? vegHeightWorld
        : objSpriteHeightWorld(it.heightPx, perPx),
    });
  }
  if (cand.length === 0) return out;

  /* ── 2 全局规范序 ⇒ 组内顺序与截断前缀都取自它 ── */
  cand.sort(comparePropInstances);
  const kept = cand.length > cap ? cand.slice(0, cap) : cand;

  /* ── 3 分组(组内保序) ── */
  const groups = new Map<number, PropInstance[]>();
  for (const c of kept) {
    const g = groups.get(c.atlasCell);
    if (g === undefined) groups.set(c.atlasCell, [c]);
    else g.push(c);
  }

  /* ── 4 每批算原点 + 填 offsets/heights;批按 atlasCell 升序输出 ── */
  const cells = [...groups.keys()].sort((a, b) => a - b);
  for (const cell of cells) {
    const g = groups.get(cell);
    if (g === undefined) continue;
    let originX = Number.POSITIVE_INFINITY;
    let originY = Number.POSITIVE_INFINITY;
    let originZ = Number.POSITIVE_INFINITY;
    for (const c of g) {
      const cx = c.x + 0.5;
      const cy = c.y + 0.5;
      if (cx < originX) originX = cx;
      if (cy < originY) originY = cy;
      if (c.z < originZ) originZ = c.z;
    }
    const offsets = new Float32Array(g.length * 3);
    const heights = new Float32Array(g.length);
    const first = g[0];
    const kind: 'obj' | 'vegetation' = first === undefined ? 'obj' : first.kind;
    let mixedKind = false;
    for (let i = 0; i < g.length; i += 1) {
      const c = g[i];
      /* `noUncheckedIndexedAccess` 关着,但 `i < g.length` 保证不是 undefined;
         这里显式跳过只是为了让「越界」在这段里的行为可读,不是防御性冗余。 */
      if (c === undefined) continue;
      offsets[i * 3] = c.x + 0.5 - originX;
      offsets[i * 3 + 1] = c.y + 0.5 - originY;
      offsets[i * 3 + 2] = c.z - originZ;
      heights[i] = c.heightWorld;
      if (c.kind !== kind) mixedKind = true;
    }
    out.push({
      atlasCell: cell,
      kind,
      mixedKind,
      count: g.length,
      offsets,
      heights,
      originX,
      originY,
      originZ,
    });
  }
  return out;
}

/** `Σ count`:计划里的实例总数(draw call 数 = `batches.length`,不是这个) */
export function propBatchInstanceCount(batches: readonly PropBatch[]): number {
  let n = 0;
  for (const b of batches) n += b.count;
  return n;
}
