/**
 * WS-FND-180 / 地形顶面**按材质**着色:两张表 + `topColorOf` + 真几何的取值
 *
 * ## 这份套件要抓的缺陷
 *
 * 顶面曾经**只**按海拔层着色(`faceColor(elevLayerOfZ(z), true)`),而海拔层只有 4 个值 ⇒
 * 1024×1024 的世界在屏幕上只有 4 种色块:草地、金沙滩、浅水、熔岩、冰砖、榻榻米
 * 全是同一个绿/蓝/灰。「这块地表面是什么」在渲染里不存在,而**既有判据全部全绿** ——
 * 它们查的是顶点色长度、值域、有没有采样器,没有一条查「不同材质会不会画出不同颜色」。
 *
 * ## 判据口径(每条都带**负对照**,证明它不是恒真)
 *
 * | # | 判据 | 负对照(证明这条有牙齿) |
 * |---|------|--------------------------|
 * | 1 | `BASE_TOP_RGB.length === 10`(下标 = BaseFluid)、`FLOOR_TOP_RGB.length === 64`(下标 = 槽位);槽位 0 = `null` | 槽位 1..63 必须都有色;**不同色的总数必须 > 4**(否则等于还是按海拔层着色) |
 * | 2 | 铺装 > 地表 > 海拔层:同一格 `floorSlot = 5` 必须**盖掉** `base` | 两个色必须**不同**;不同 `base` 必须不同色 |
 * | 3 | 非法 `base`/`floorSlot`/`NaN` 不抛异常、不产生 NaN、分量 ∈ [0,1],且**走回落** | 合法输入必须**不**等于回落色(否则「回落」与「恒返回同一个值」不可区分) |
 * | 4 | 真几何:同海拔、不同 `base` ⇒ 顶点色里出现**两种**顶面色;再加 `floor: 5` ⇒ 第三种 | 把顶面改回 `faceColor(层, true)` 这条必红(实测见提交说明) |
 * | 5 | 片元着色器**仍不采样纹理**;分量数仍是 3 | 源码里注掉一次乘法/加一个 `sampler2D` 必须被同一条检测器抓到 |
 * | 6 | 侧面暗档与顶面材质表**无共同色**(两条着色路径可判定) | 手动往材质表塞一个暗档 ⇒ 同一口径必须报 1 处重叠 |
 *
 * 运行:`node tests/WS-FND-180-terrain-material-palette.test.ts`
 */

import { test, eq, ok, near, report } from '../shared/testing/harness.ts';

import { BaseFluid, Elevation, packTile } from '../shared/types/tile.ts';
import { CHUNK_SIZE, type ChunkInput } from '../client/src/stage/tile_mesh.ts';
import { emitChunkGeometry, validateChunkGeometry, type ChunkGeometry } from '../client/src/stage/chunk_geometry.ts';
import {
  BASE_TOP_RGB,
  FLOOR_TOP_RGB,
  TERRAIN_COLOR_COMPONENTS,
  TERRAIN_VCOLOR_FRAG,
  TERRAIN_VCOLOR_VERT,
  faceColor,
  lodPaletteOf,
  terrainShaderSamplesTexture,
  topColorOf,
  topMaterialPaletteOf,
  type FaceColor,
} from '../client/src/stage/terrain_vcolor.ts';

/* ─────────────────────────── 基础设施 ─────────────────────────── */

/** 颜色的字符串身份(调色表值是 float64,可逐位比)。 */
function rgbKey(c: FaceColor): string {
  return `${c.r},${c.g},${c.b}`;
}

function sameColor(a: FaceColor, b: FaceColor, eps = 1e-6): boolean {
  return Math.abs(a.r - b.r) <= eps && Math.abs(a.g - b.g) <= eps && Math.abs(a.b - b.b) <= eps;
}


/**
 * 几何里**顶面**(法线 +Z)的顶点色,按面出现顺序返回。
 *
 * 为什么按面取而不是按顶点取:一个合并块的顶面 4 个顶点同色,逐顶点数会把
 * 「1 块 1 色」当成 4 个样本;而「有几种颜色」这条判据必须是**每面一个样本**。
 */
function topFaceColors(g: ChunkGeometry): FaceColor[] {
  const out: FaceColor[] = [];
  for (let f = 0; f < g.faceCount; f += 1) {
    const v = f * 4;
    if (Math.abs(g.normals[v * 3 + 2]! - 1) > 1e-6) continue;
    out.push({ r: g.colors[v * 3]!, g: g.colors[v * 3 + 1]!, b: g.colors[v * 3 + 2]! });
  }
  return out;
}

function distinct(colors: readonly FaceColor[]): Set<string> {
  const s = new Set<string>();
  for (const c of colors) s.add(rgbKey(c));
  return s;
}

/* ─────────────────── 1 / 两张表的长度与槽位语义 ─────────────────── */

test('1 表长与槽位语义:10 / 64;槽位 0 = null,槽位 1..63 都有色', () => {
  eq(BASE_TOP_RGB.length, 10, 'BaseFluid 10 个取值 ⇒ 表长 10');
  eq(FLOOR_TOP_RGB.length, 64, 'floor 是 6 位槽位号 ⇒ 表长 64');

  /* 槽位 0 = 无铺装 ⇒ null(回落 base),不是「某种黑色铺装」 */
  eq(FLOOR_TOP_RGB[0], null, '槽位 0 必须是 null');

  let defined = 0;
  for (let s = 1; s < FLOOR_TOP_RGB.length; s += 1) {
    const c = FLOOR_TOP_RGB[s];
    ok(c !== null && c !== undefined, `槽位 ${s} 必须有铺装色`);
    if (c === null || c === undefined) continue;
    defined += 1;
    for (const v of [c.r, c.g, c.b]) ok(v >= 0 && v <= 1, `槽位 ${s} 的分量 ${v} 必须在 [0,1]`);
  }
  eq(defined, 63, '槽位 1..63 共 63 个都必须有定义(短一格 = UGC 地毯上有个看不见的洞)');

  /* UGC 变体槽(31..63)共用一色;33 个槽一个不少 */
  const ugc = rgbKey(FLOOR_TOP_RGB[63]!);
  eq(ugc, '0.62,0.62,0.62', '槽位 63(UGC 像素地毯变体)= 字面量 (0.62,0.62,0.62)');
  for (let s = 31; s <= 63; s += 1) eq(rgbKey(FLOOR_TOP_RGB[s]!), ugc, `槽位 ${s} 与 UGC 同色`);
  /* 命名槽位抽查两个端点(槽位 = 物品 ID − 300:1 ↔ 301 耕地,30 ↔ 330 制动轨) */
  eq([FLOOR_TOP_RGB[1]!.r, FLOOR_TOP_RGB[1]!.g, FLOOR_TOP_RGB[1]!.b], [0.48, 0.36, 0.26], '槽位 1 = 301 耕地');
  eq([FLOOR_TOP_RGB[30]!.r, FLOOR_TOP_RGB[30]!.g, FLOOR_TOP_RGB[30]!.b], [0.55, 0.50, 0.45], '槽位 30 = 330 制动轨');

  /* VOID 是兜底项:与 GRASS 同值 */
  eq([BASE_TOP_RGB[0]!.r, BASE_TOP_RGB[0]!.g, BASE_TOP_RGB[0]!.b], [0.42, 0.62, 0.36], 'VOID 兜底 = GRASS 同值');
  eq([BASE_TOP_RGB[3]!.r, BASE_TOP_RGB[3]!.g, BASE_TOP_RGB[3]!.b], [0.82, 0.74, 0.46], '下标 3 = GOLD_SAND');

  /* ★ 这条才是「修好了」的直接证据:可选颜色必须**多于 4 种**(= 不再是海拔层那 4 色) */
  const all = new Set<string>();
  for (const c of BASE_TOP_RGB) all.add(rgbKey(c));
  for (const c of FLOOR_TOP_RGB) if (c !== null) all.add(rgbKey(c));
  ok(all.size > 4, `顶面可选色必须多于 4 种(实测 ${all.size})—— 4 就是「只按海拔层着色」`);
});

/* ─────────────────── 2 / 铺装 > 地表 > 海拔层 ─────────────────── */

test('2 topColorOf:铺装覆盖 base,base 覆盖海拔层(优先级有牙)', () => {
  /* 无铺装 ⇒ 地表色(字面量:金沙滩) */
  const sand = topColorOf(1, BaseFluid.GOLD_SAND, 0);
  near(sand.r, 0.82, 1e-6, 'GOLD_SAND 地表色 r');
  near(sand.g, 0.74, 1e-6, 'GOLD_SAND 地表色 g');
  near(sand.b, 0.46, 1e-6, 'GOLD_SAND 地表色 b');

  /* 同一格改成 `floorSlot = 5`(305 红砖广场)⇒ **铺装盖掉 base** */
  const brick = topColorOf(1, BaseFluid.GOLD_SAND, 5);
  near(brick.r, 0.62, 1e-6, '槽位 5 红砖广场 r');
  near(brick.g, 0.34, 1e-6, '槽位 5 红砖广场 g');
  near(brick.b, 0.28, 1e-6, '槽位 5 红砖广场 b');
  ok(!sameColor(brick, sand), '铺装必须真的盖掉地表色(两个色相同 = 覆盖是空话)');

  /* 不同地表必须不同色(同一海拔层) */
  const grass = topColorOf(1, BaseFluid.GRASS, 0);
  const lava = topColorOf(1, BaseFluid.LAVA, 0);
  ok(!sameColor(grass, lava), '同一海拔层上 GRASS 与 LAVA 必须不同色(否则顶面还是只看层)');
  ok(!sameColor(lava, faceColor(1, true)), 'LAVA 色必须不同于该层的海拔层色');

  /* 兜底:两者都缺时才回落海拔层色(层 2 = PLATFORM = 字面量 0.62/0.58/0.46) */
  const fallback = topColorOf(2, 99, 999);
  eq([fallback.r, fallback.g, fallback.b], [0.62, 0.58, 0.46], 'base/floor 都非法 ⇒ 回落 faceColor(层, true)');

  /* 槽位号越大越靠后:抽查两个不同槽位确实不同色 */
  ok(!sameColor(topColorOf(1, BaseFluid.GRASS, 1), topColorOf(1, BaseFluid.GRASS, 13)),
    '不同槽位必须不同色(槽位真的是索引,不是「有铺装就一个色」)');
});

/* ─────────────────── 3 / 非法输入不抛异常 ─────────────────── */

test('3 非法 base / floorSlot / NaN:不抛异常、不产生 NaN、分量 ∈ [0,1],且走回落', () => {
  const cases: readonly (readonly [number, number, number])[] = [
    [1, 99, 0], [1, -1, 0], [1, 1.5, 0], [1, Number.NaN, 0], [1, Number.POSITIVE_INFINITY, 0],
    [1, 1, 999], [1, 1, -3], [1, 1, 2.5], [1, 1, Number.NaN], [1, 1, Number.POSITIVE_INFINITY],
    [1, 1, 64], [1, 1, -1],
    [Number.NaN, Number.NaN, Number.NaN], [3, 3, 30], [0, 0, 0],
  ];
  let checked = 0;
  for (const [layer, base, floorSlot] of cases) {
    let c: FaceColor | null = null;
    try {
      c = topColorOf(layer, base, floorSlot);
    } catch (e) {
      ok(false, `topColorOf(${layer}, ${base}, ${floorSlot}) 不得抛异常:${String(e)}`);
      continue;
    }
    for (const v of [c.r, c.g, c.b]) {
      ok(Number.isFinite(v), `(${layer},${base},${floorSlot}) 的分量 ${String(v)} 必须是有限值`);
      ok(v >= 0 && v <= 1, `(${layer},${base},${floorSlot}) 的分量 ${v} 必须在 [0,1]`);
    }
    checked += 1;
  }
  eq(checked, cases.length, '每个用例都必须真的被查过(有异常就会被少查)');

  /* 非法 ⇒ 回落:必须等于 faceColor(层, true) */
  const fallback = topColorOf(1, Number.NaN, Number.NaN);
  eq([fallback.r, fallback.g, fallback.b], [0.42, 0.62, 0.36], 'NaN 输入 ⇒ 回落海拔层色(层 1)');

  /* ★ 负对照:合法输入**不**等于回落色 —— 否则「走了回落」与「恒返回同一个色」不可区分 */
  ok(!sameColor(topColorOf(1, BaseFluid.LAVA, 0), fallback), '负对照:合法输入不得等于回落色');
});

/* ─────────────────── 4 / 真几何:不同材质真的画出不同颜色 ─────────────────── */

test('4 真几何(emitChunkGeometry):同海拔不同 base ⇒ 两种顶面色;加 floor:5 ⇒ 第三种', () => {
  /* 两格:同 elev(GROUND)、base 不同(GRASS / GOLD_SAND);(0,0) 排在最前 */
  const tiles = new Uint32Array(CHUNK_SIZE * CHUNK_SIZE);
  tiles.fill(packTile({ elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: 0, wire: 0, obj: 0, meta: 0 }));
  tiles[0] = packTile({ elev: Elevation.GROUND, base: BaseFluid.GOLD_SAND, floor: 0, wire: 0, obj: 0, meta: 0 });
  const chunk: ChunkInput & { tiles: Uint32Array } = { key: 'c_mat', cx: 0, cy: 0, tiles };

  const g = emitChunkGeometry(chunk, 0);
  eq(validateChunkGeometry(g), null, '几何自检必须通过(含顶点色长度/值域)');
  eq(g.colors.length, g.vertexCount * TERRAIN_COLOR_COMPONENTS, '顶点色长度 = 顶点数 × 3');

  /* 第 0 面 = (0,0) 的顶面 ⇒ GOLD_SAND 的材质色(字面量:near 走 float32) */
  near(g.colors[0]!, 0.82, 1e-6, '第一块(GOLD_SAND)顶面 r');
  near(g.colors[1]!, 0.74, 1e-6, '第一块(GOLD_SAND)顶面 g');
  near(g.colors[2]!, 0.46, 1e-6, '第一块(GOLD_SAND)顶面 b');

  /* ★ 有牙的那条:同一个海拔层(GROUND)上有**两种** base ⇒ 顶面必须是**两种**颜色 */
  const tops = topFaceColors(g);
  eq(tops.length, CHUNK_SIZE * CHUNK_SIZE, 'LOD0(merge=1):16×16 格各一个顶面');
  const kinds = distinct(tops);
  eq(kinds.size, 2, '★ 同海拔两种地表 ⇒ 恰好 2 种顶面色(只按海拔层着色的实现会给 1 种,必红)');
  /* 两种颜色必须**正好**是本例那两种材质色(不是「随便两种」) */
  const sand = { r: 0.82, g: 0.74, b: 0.46 };
  const grass = { r: 0.42, g: 0.62, b: 0.36 };
  ok(tops.some((c) => sameColor(c, sand, 1e-4)), `顶点色里必须有沙色(实测 ${[...kinds].join(' | ')})`);
  ok(tops.some((c) => sameColor(c, grass, 1e-4)), '顶点色里必须有草色');

  /* 再加一格 floor = 5(305 红砖广场,base 仍是 GRASS)⇒ 出现第三种颜色 */
  const paved = new Uint32Array(tiles);
  paved[1] = packTile({ elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: 5, wire: 0, obj: 0, meta: 0 });
  const g3 = emitChunkGeometry({ key: 'c_mat_floor', cx: 0, cy: 0, tiles: paved }, 0);
  eq(validateChunkGeometry(g3), null, '带铺装的几何自检也必须通过');
  const tops3 = topFaceColors(g3);
  eq(tops3.length, CHUNK_SIZE * CHUNK_SIZE, '仍是每格一个顶面(铺装不改变面数)');
  eq(distinct(tops3).size, 3, '★ 加一格 floor: 5 ⇒ 第三种颜色(铺装真的进了顶点色)');
  /* 第 1 面 = (1,0) 的顶面 ⇒ 红砖色(面 1 占顶点 4..7 ⇒ 颜色偏移 4×3) */
  const off = 4 * TERRAIN_COLOR_COMPONENTS;
  near(g3.colors[off]!, 0.62, 1e-6, '第二格(floor=5)顶面 r = 红砖广场');
  near(g3.colors[off + 1]!, 0.34, 1e-6, '第二格(floor=5)顶面 g');
  near(g3.colors[off + 2]!, 0.28, 1e-6, '第二格(floor=5)顶面 b');

  /* 负对照:这两格在**旧口径**下必然同色(同 elev)⇒ 上面那条「≥3 种」不是恒真 */
  const oldWay = faceColor(0, true);
  ok(!sameColor(topColorOf(1, BaseFluid.GOLD_SAND, 0), oldWay),
    '负对照:沙色 ≠ 层 1 的亮档(否则新口径与旧口径区分不开)');
});

/* ─────────────────── 5 / 着色器仍不采样纹理 ─────────────────── */

test('5 片元着色器仍不采样纹理;分量数仍是 3(材质色不改顶点布局)', () => {
  eq(terrainShaderSamplesTexture(), false, '顶点色路径不得出现 sampler2D / texture2D');
  eq(TERRAIN_COLOR_COMPONENTS, 3, '锚点:每顶点 3 分量(材质色进来的前提是不动布局)');
  ok(!/sampler2D|texture2D|textureCube/.test(TERRAIN_VCOLOR_FRAG), '片元源码无采样器');
  ok(!/sampler2D|texture2D|textureCube/.test(TERRAIN_VCOLOR_VERT), '顶点源码无采样器');

  /* ★ 负对照:同一检测器对「加了采样器」的源码必须为真 —— 证明 `false` 不是因为正则写错 */
  const tainted = `${TERRAIN_VCOLOR_FRAG}\nuniform sampler2D uAlbedo;`;
  ok(/sampler2D|texture2D|textureCube/.test(tainted), '负对照:注入 sampler2D 后同一检测器必须报真');
  ok(/sampler2D|texture2D|textureCube/.test(TERRAIN_VCOLOR_FRAG) === false, '被污染的样本必须与产品源码可区分');
});

/* ─────────────────── 6 / 两张表不重叠 ─────────────────── */

test('6 侧面暗档与顶面材质表无共同色(两条着色路径可判定)', () => {
  const side = new Set<string>();
  for (let layer = 0; layer < 4; layer += 1) side.add(rgbKey(faceColor(layer, false)));
  eq(side.size, 4, '侧面暗档 4 档(每层一个)');

  const material = new Set<string>();
  for (const c of BASE_TOP_RGB) material.add(rgbKey(c));
  for (const c of FLOOR_TOP_RGB) if (c !== null) material.add(rgbKey(c));
  ok(material.size > 4, `材质表去重后必须多于 4 色(实测 ${material.size})`);

  const both = [...material].filter((k) => side.has(k));
  eq(both, [], '★ 两张表不得有共同色,否则「这个色属于哪条路径」不可判定');

  /* ★ 负对照:同一个口径喂给「故意漏了一个暗档」的集合 ⇒ 必须报出 1 处重叠 */
  const leaked = new Set<string>(material);
  leaked.add([...side][0]!);
  eq([...leaked].filter((k) => side.has(k)).length, 1,
    '负对照:往材质表里塞一个侧面暗档 ⇒ 同一比较必须命中(检测器不是恒空)');

  /* 反查函数对同一个色给相反结论:侧面暗档只认 lodPaletteOf,沙色只认材质表 */
  eq(lodPaletteOf(faceColor(0, false)), { layer: 0, isTop: false }, '侧面暗档在海拔层调色板里');
  eq(topMaterialPaletteOf(faceColor(0, false)), null, '但它不在顶面材质表里');
  const sand = topColorOf(1, BaseFluid.GOLD_SAND, 0);
  eq(lodPaletteOf(sand), null, '沙色不在海拔层调色板里(旧口径认不出它)');
  eq(topMaterialPaletteOf(sand) !== null, true, '它是材质表里的色');
  /* 平坦草地是「两表同值」的那一个色(GRASS = GROUND):务必显式钉住,免得被当成「表没换」 */
  eq(lodPaletteOf(faceColor(1, true)), { layer: 1, isTop: true }, 'GRASS 材质色恰好 = GROUND 基色');
  eq(topMaterialPaletteOf(faceColor(1, true)) !== null, true, '同一色也是材质色(同值,不是没换表)');
});

report('WS-FND-180');
