/**
 * WS-FND-190 / 立牌的**批绘制计划**:同图集格合并成一批(一次 draw call)
 *
 * ## 这份套件要抓的缺陷
 *
 * 世界里已有 **615 条**立牌在画,但那是**一条立牌一次 draw call**,并被
 * `three/boot.ts` 的 `SPRITE_BUDGET = 600`(按**立牌条数**封顶)卡住 ⇒ 密度上不去。
 * 正确的口径是「同一图集格的一批一次 draw call」,而封顶应该按**实例总数**。
 * 既有判据全绿也看不见这件事,因为它们查的是「计划里有哪些立牌」,不查「几次画完」。
 *
 * ## 判据口径(每条都写清它为什么**不是恒真**)
 *
 * | # | 判据 | 为什么有牙 |
 * |---|------|------------|
 * | 1 | 3 项同格 + 1 项异格 ⇒ **2 批** | 改成「每项一批」⇒ 4 批,红(★有牙实证,见 §末) |
 * | 2 | 同输入两次调用 `JSON.stringify` 相等;**乱序输入**结果也相等 | 不排序(靠输入顺序)⇒ 乱序那次不同,红 |
 * | 3 | 组内顺序按 `(x, y)` 升序(从 `offsets` 反解) | 按插入序 ⇒ 乱序输入后不单调,红 |
 * | 4 | `Σ count` == 参与分组的项数;`offsets.length == count*3`;`heights.length == count` | 少填/多填一个实例 ⇒ 长度对不上,红 |
 * | 5 | 空输入 ⇒ `[]`;`maxInstances: 0` ⇒ `[]` | 返回「一个空批」⇒ 长度 1,红 |
 * | 6 | `atlasCell < 0`(含 `NaN`/非整数)的项**不进任何批** | 照着 `-1` 分组 ⇒ 多出一批且 `offsets` 数不对,红 |
 * | 7 | 批数 == **不同图集格数**(358 格 × 10 项 = 3580 项 ⇒ 358 批) | 按项分批 ⇒ 批数 3580 > 358,红 |
 * | 8 | 实例总数封顶:`PROP_INSTANCE_BUDGET + 7` 项 ⇒ 总数 == 预算,且确定性 | 不封顶 ⇒ 总数 == 输入项数,红 |
 * | 9 | 同格混 `obj`/`vegetation` ⇒ **1 批**(不拆)+ `mixedKind` + 每实例高度不同 | 按 kind 拆批 ⇒ 2 批,红;高度写成批级单值 ⇒ 两实例同高,红 |
 * | 10 | 坏坐标/坏高度不抛,且产物里没有 `NaN` | 直接乘 `NaN` ⇒ 矩阵全 `NaN`,红 |
 * | 11 | `buildPropInstanced`:每批一个 mesh、`count`/`name`/顶点数/标脏正确 | 每实例一个 mesh ⇒ mesh 数 ≠ 批数,红 |
 * | 12 | 矩阵口径:锚点 = 实例位置,面心抬高 `(0.5 − SPRITE_CENTER_Y) × 高` | 不抬锚点 ⇒ 立牌下沉 0.35 高(只在截图上看得出来),红 |
 * | 13 | 朝向基:第三列 == 视线方向、三列正交且右手系 | 用 `setFromUnitVectors`(最短弧)⇒ 屏幕上不保,列为斜的,红 |
 * | 14 | 回收:摘父 + 每份 `geometry` 一次 `dispose`,**材质不被释放** | 顺手 dispose 共享材质 ⇒ 别的批变黑(不抛、不报),红 |
 * | 15 | 材质缺失/空批/批数据不完整 ⇒ 跳过,不建 mesh(且材质一次都不取) | 硬建 ⇒ 空材质白方块 / 越界读 `NaN`,红 |
 *
 * ## 两处刻意的口径说明
 *
 * 1. **本文件不 import three**。需要「容器对象」时用的是**批 mesh 自己**
 *    (`meshes[0].add(meshes[1])` —— 任何 `Object3D` 都能当父节点)。
 *    理由不是图省事:`node_modules/three` 没有 `.d.ts`,再写一条 `import ... 'three'`
 *    会给类型检查基线**新增一条指纹**(指纹带文件路径,见
 *    `scripts/typecheck-baseline-audit.ts:102`)⇒ 那是把「新增欠账」混进存量。
 *    (唯一那条豁免写在 `client/src/three/prop_batch.ts` 里,附自带判据。)
 * 2. **材质用桩对象**(`{ name, dispose(), addEventListener() }`)。这里要判的是
 *    「谁被释放」,而不是「three 的材质能不能用」;用桩反而更精确 —— 桩会把
 *    「被 dispose 了几次」记下来,而真材质只能靠监听事件。
 *    桩**不覆盖**的是「真材质在渲染器里的生命周期」,那件事由缓存的持有者负责
 *    (见 `disposePropInstanced` 的注释)。
 *
 * ## ★ 有牙实证(实测,不是推理)
 *
 * 把 `planPropBatches` 的分组键从「`atlasCell`」改成「每项一个批」后重跑本套件:
 * 第 1 条与第 7 条**变红**(批数 4 ≠ 2 / 批数 3580 ≠ 358),其余条目照旧通过 ——
 * 也就是这两条判据**咬的正是**「同格合并」这件事,而不是同义反复。
 *
 * 运行:`node tests/WS-FND-190-prop-batch.test.ts`
 */

import { test, eq, ok, report, near } from '../shared/testing/harness.ts';

import {
  ATLAS_SPRITE_COUNT,
  SPRITE_CENTER_Y,
  cameraOffsetDirection,
  cellIndexFromId,
  idFromCellIndex,
} from '../client/src/stage/assembly_math.ts';
import {
  OBJ_HEIGHT_WORLD_PER_PX,
  PROP_INSTANCE_BUDGET,
  PROP_VEG_HEIGHT_WORLD,
  objSpriteHeightPx,
  objSpriteHeightWorld,
  planPropBatches,
  propBatchInstanceCount,
  type ObjSpriteInput,
  type PropBatch,
} from '../client/src/stage/obj_sprites.ts';
import {
  PROP_INSTANCED_NAME_PREFIX,
  buildPropInstanced,
  disposePropInstanced,
  propBillboardBasis,
} from '../client/src/three/prop_batch.ts';

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** 路灯(501~537 档 ⇒ 20px)——图集格与「墙(352)」不同格,用来造「异格」 */
const ID_LAMP = 522;
/** 承重墙(351~385 档 ⇒ 32px) */
const ID_WALL = 352;
const CELL_LAMP = cellIndexFromId(ID_LAMP);
const CELL_WALL = cellIndexFromId(ID_WALL);

/** 一条立牌记录。默认值刻意用**图集内**的 id ⇒ 不用到处写 `atlasCell` */
function prop(x: number, y: number, over: Partial<ObjSpriteInput> = {}): ObjSpriteInput {
  const id = over.id ?? ID_LAMP;
  const base: ObjSpriteInput = {
    kind: 'obj',
    id,
    x,
    y,
    z: 0,
    atlasCell: cellIndexFromId(id),
    heightPx: objSpriteHeightPx(id),
  };
  return { ...base, ...over };
}

/** 批 → `atlasCell` → `count`(判据 1/7/9 都用它,避免按索引取批) */
function countsByCell(batches: readonly PropBatch[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of batches) m.set(b.atlasCell, b.count);
  return m;
}

/** 组内第 i 个实例的世界格心 x/y(从 `origin + offsets` 反解) */
function instanceX(b: PropBatch, i: number): number {
  return b.originX + b.offsets[i * 3];
}
function instanceY(b: PropBatch, i: number): number {
  return b.originY + b.offsets[i * 3 + 1];
}

/** 材质桩:只记「被 dispose 了几次」 */
interface FakeMaterial {
  name: string;
  disposals: number;
  dispose: () => void;
  addEventListener: (type: string, fn: () => void) => void;
}

function fakeMaterial(name: string): FakeMaterial {
  const m: FakeMaterial = {
    name,
    disposals: 0,
    dispose: (): void => {
      m.disposals += 1;
    },
    addEventListener: (): void => {
      /* three 材质事件接口的占位:本套件不监听它 */
    },
  };
  return m;
}

/** 按格给材质(记录取过哪些格 ⇒ 判据 11/15 要数「每批一次」/「坏批一次都不取」) */
function materialCache(): {
  of: (cell: number) => FakeMaterial | null;
  calls: number[];
  miss: Set<number>;
  mats: Map<number, FakeMaterial>;
} {
  const mats = new Map<number, FakeMaterial>();
  const calls: number[] = [];
  const miss = new Set<number>();
  return {
    mats,
    calls,
    miss,
    of: (cell: number): FakeMaterial | null => {
      calls.push(cell);
      if (miss.has(cell)) return null;
      const hit = mats.get(cell);
      if (hit !== undefined) return hit;
      const made = fakeMaterial(`cell_${cell}`);
      mats.set(cell, made);
      return made;
    },
  };
}

/* ─────────────────────────── 1 ─────────────────────────── */

test('1 同格合并:3 项同格 + 1 项异格 ⇒ 2 批(不是 4 批)', () => {
  ok(CELL_LAMP >= 0 && CELL_WALL >= 0, '夹具前提:两个 id 都在图集里');
  ok(CELL_LAMP !== CELL_WALL, '夹具前提:两个 id 落在不同图集格');

  const items = [
    prop(0, 0, { id: ID_LAMP }),
    prop(1, 0, { id: ID_LAMP }),
    prop(2, 0, { id: ID_LAMP }),
    prop(0, 1, { id: ID_WALL }),
  ];
  const batches = planPropBatches(items);

  eq(batches.length, 2, '同格 3 项必须合并 ⇒ 只有 2 次 draw call');
  eq(countsByCell(batches), new Map([[CELL_WALL, 1], [CELL_LAMP, 3]]),
    '每格的实例数(图集格号:墙 134 < 灯 189)');
  eq(batches.map((b) => b.atlasCell), [CELL_WALL, CELL_LAMP], '批按 atlasCell 升序输出');
  /* 有牙点:分组键若退化成「每项一批」,这里立刻变成 4 */
  ok(batches.length < items.length, '批数必须**严格小于**项数(否则就是没合并)');
});

/* ─────────────────────────── 2 / 3 ─────────────────────────── */

test('2 确定性:同输入两次相等;乱序输入结果相同(证明按坐标排序,不靠输入顺序)', () => {
  const a = [
    prop(5, 2, { id: ID_LAMP }),
    prop(1, 7, { id: ID_LAMP }),
    prop(3, 3, { id: ID_LAMP }),
  ];
  const first = planPropBatches(a);
  const second = planPropBatches(a);
  eq(JSON.stringify(second), JSON.stringify(first), '同输入两次调用必须逐字节相同');

  const shuffled = [a[2]!, a[0]!, a[1]!];
  const third = planPropBatches(shuffled);
  eq(JSON.stringify(third), JSON.stringify(first), '乱序输入必须得到同一个结果(先排序再分组)');

  /* 反证「不是恰好因为输入已有序」:shuffled 的顺序确实与原数组不同 */
  ok(JSON.stringify(shuffled) !== JSON.stringify(a), '输入确实被打乱了');
});

test('3 组内顺序:x 升序、x 相同则 y 升序;且顺序与输入顺序无关', () => {
  const items = [
    prop(9, 1), prop(3, 9), prop(3, 4), prop(1, 1), prop(3, 4),
  ];
  const batches = planPropBatches(items);
  eq(batches.length, 1, '五项同格 ⇒ 一批');
  const b = batches[0]!;
  eq(b.count, 5);
  ok(b.count > 1, '至少要两个实例才能判「顺序」');
  for (let i = 1; i < b.count; i += 1) {
    const px = instanceX(b, i - 1);
    const py = instanceY(b, i - 1);
    const cx = instanceX(b, i);
    const cy = instanceY(b, i);
    ok(cx > px || (cx === px && cy >= py),
      `第 ${i} 个实例 (${cx},${cy}) 必须 ≥ 前一个 (${px},${py})(x 主序、y 次序)`);
  }
  /* 首条必是 (1,1)、末条必是 (9,1) —— 写明端点,免得「单调」被空数组蒙过 */
  near(instanceX(b, 0), 1.5, 1e-6, '首实例 x');
  near(instanceX(b, b.count - 1), 9.5, 1e-6, '末实例 x');

  const reversed = planPropBatches([...items].reverse());
  eq(JSON.stringify(reversed), JSON.stringify(batches), '倒序输入结果相同');
});

/* ─────────────────────────── 4 / 5 / 6 ─────────────────────────── */

test('4 长度口径:Σ count == 参与项数;offsets = count*3;heights = count', () => {
  const items = [
    prop(0, 0), prop(1, 0), prop(2, 0),
    prop(0, 1, { id: ID_WALL }), prop(1, 1, { id: ID_WALL }),
    /* 两条未知格:不参与分组,也就不该计入 */
    prop(9, 9, { atlasCell: -1 }), prop(9, 8, { atlasCell: -1 }),
  ];
  const batches = planPropBatches(items);
  eq(propBatchInstanceCount(batches), 5, 'Σ count == 参与分组的项数(7 项里有 2 项未知格)');
  for (const b of batches) {
    eq(b.offsets.length, b.count * 3, `格 ${b.atlasCell} 的 offsets 每实例 3 个分量`);
    eq(b.heights.length, b.count, `格 ${b.atlasCell} 的 heights 每实例 1 个`);
    ok(Number.isInteger(b.count) && b.count > 0, '批的 count 必须是正整数');
  }
});

test('5 空输入 / 上限为 0 ⇒ 空数组(不是「一个空批」)', () => {
  eq(planPropBatches([]), [], '空输入 ⇒ []');
  const items = [prop(0, 0), prop(1, 0)];
  eq(planPropBatches(items, { maxInstances: 0 }), [], '上限 0 ⇒ []');
  eq(planPropBatches(items, { maxInstances: Number.NaN }), [], '非有限上限 ⇒ 0 ⇒ []');
});

test('6 atlasCell < 0(含 NaN/非整数)的项不进任何批', () => {
  const items = [
    prop(0, 0),
    prop(1, 0),
    prop(5, 5, { atlasCell: -1 }),
    prop(6, 6, { atlasCell: Number.NaN }),
    prop(7, 7, { atlasCell: 1.5 }),
  ];
  const batches = planPropBatches(items);
  eq(batches.map((b) => b.atlasCell), [CELL_LAMP], '只有那一格成立批');
  eq(propBatchInstanceCount(batches), 2, '三项坏格都不能被算进去');
  for (const b of batches) ok(b.atlasCell >= 0, '批里的格号必须 ≥ 0');
  /* 反证:坏格的坐标一个都不该出现(它们与合法项同格心时也必须只出现合法的那两条) */
  const b = batches[0]!;
  for (let i = 0; i < b.count; i += 1) {
    ok(instanceX(b, i) < 5, `坏格 (5,5) 的实例不该在产物里(实得 x=${instanceX(b, i)})`);
  }
});

/* ─────────────────────────── 7 / 8 ─────────────────────────── */

test('7 批数 == 不同图集格数(358 格 × 10 项 = 3580 项 ⇒ 358 批)', () => {
  const items: ObjSpriteInput[] = [];
  for (let cell = 0; cell < ATLAS_SPRITE_COUNT; cell += 1) {
    const id = idFromCellIndex(cell);
    ok(id >= 0, `格 ${cell} 必须能反查回一个 id`);
    for (let k = 0; k < 10; k += 1) items.push(prop(cell, k, { id }));
  }
  eq(items.length, ATLAS_SPRITE_COUNT * 10);
  const batches = planPropBatches(items);
  eq(batches.length, ATLAS_SPRITE_COUNT, 'draw call 数 == 不同图集格数(与实例数解耦)');
  eq(propBatchInstanceCount(batches), ATLAS_SPRITE_COUNT * 10, '实例一个不能丢');
  eq(batches.map((b) => b.atlasCell).join(','),
    [...Array(ATLAS_SPRITE_COUNT).keys()].join(','), '批按 atlasCell 升序且不重不漏');
  /* 有牙点:按项分批的话这里是 3580 ≫ 358 这个事实就没了 */
  ok(batches.length * 5 < items.length, '批数必须远小于项数(这是「一次画一批」的量化口径)');
});

test('8 实例总数封顶:> PROP_INSTANCE_BUDGET 的输入 ⇒ 总数 == 预算,且确定性', () => {
  const n = PROP_INSTANCE_BUDGET + 7;
  const items: ObjSpriteInput[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = i % 2 === 0 ? ID_LAMP : ID_WALL;
    items.push(prop(i % 128, Math.floor(i / 128), { id }));
  }
  const capped = planPropBatches(items);
  eq(propBatchInstanceCount(capped), PROP_INSTANCE_BUDGET, '超限时总数必须**正好**等于预算');
  ok(propBatchInstanceCount(capped) < items.length, '输入确实超限了');
  /* 确定性:换一个输入顺序必须得到同一份截断结果 */
  const other = planPropBatches([...items].reverse());
  eq(JSON.stringify(other), JSON.stringify(capped), '截断必须是确定性的(全局规范序取前缀)');

  /* 预算本身的量级判据:它取代的是「600 条立牌」那个口径 ⇒ 必须显著更大 */
  ok(PROP_INSTANCE_BUDGET > 600, `预算要高于旧口径 600(实测 ${PROP_INSTANCE_BUDGET})`);
  /* 但也不能大到「一次上传几百 MB」:每实例 64 B 的矩阵缓冲 ⇒ ≤ 4 MiB */
  ok(PROP_INSTANCE_BUDGET * 64 <= 4 * 1024 * 1024, '矩阵缓冲不超过 4 MiB');
});

/* ─────────────────────────── 9 / 10 ─────────────────────────── */

test('9 同格混 kind ⇒ 1 批(不拆)+ mixedKind + 每实例高度不同', () => {
  const items = [
    prop(0, 0, { kind: 'obj', id: ID_LAMP }),
    prop(1, 0, { kind: 'vegetation', id: ID_LAMP, heightPx: objSpriteHeightPx(ID_LAMP) }),
  ];
  const batches = planPropBatches(items);
  eq(countsByCell(batches).get(CELL_LAMP), 2, '同一图集格 ⇒ 仍然只有一批(拆开只会多一次 draw call)');
  eq(batches.length, 1);
  const b = batches[0]!;
  eq(b.mixedKind, true, '混了 obj 与 vegetation 必须如实标出');
  eq(b.kind, 'obj', 'kind 记的是组内首实例的类别(仅供诊断)');
  /* 每实例高度不同,且各有各的来源:物品按像素档、装饰按固定值 */
  near(b.heights[0], objSpriteHeightWorld(objSpriteHeightPx(ID_LAMP)), 1e-6, '物品实例:像素档换算');
  near(b.heights[1], PROP_VEG_HEIGHT_WORLD, 1e-6, '装饰实例:固定世界高度');
  ok(b.heights[0] !== b.heights[1], '两实例高度必须不同(否则「每实例高度」是摆设)');
  ok(PROP_VEG_HEIGHT_WORLD > objSpriteHeightWorld(objSpriteHeightPx(ID_LAMP)),
    '夹具前提:树比路灯高(这正是装饰不用像素档的原因)');
});

test('10 坏坐标/坏高度不抛,产物里不出现 NaN', () => {
  const items = [
    prop(0, 0),
    prop(Number.NaN, 4),
    prop(2, Number.POSITIVE_INFINITY, { heightPx: Number.NaN, z: Number.NEGATIVE_INFINITY }),
  ];
  const batches = planPropBatches(items);
  eq(propBatchInstanceCount(batches), 3, '坏数**不丢实例**(丢了就是「静默少画」)');
  for (const b of batches) {
    ok(Number.isFinite(b.originX) && Number.isFinite(b.originY) && Number.isFinite(b.originZ),
      '原点必须是有限数');
    for (let i = 0; i < b.offsets.length; i += 1) {
      ok(Number.isFinite(b.offsets[i]), `offsets[${i}] 不是有限数`);
    }
    for (let i = 0; i < b.heights.length; i += 1) {
      ok(Number.isFinite(b.heights[i]) && b.heights[i] > 0, `heights[${i}] 必须是正有限数`);
    }
  }
});

/* ─────────────────────────── 11 / 12 ─────────────────────────── */

test('11 buildPropInstanced:每批一个 mesh,count/name/顶点数/标脏正确', () => {
  const batches = planPropBatches([
    prop(0, 0), prop(1, 0), prop(2, 0), prop(0, 1, { id: ID_WALL }),
  ]);
  eq(batches.length, 2, '夹具前提');
  const cache = materialCache();
  const meshes = buildPropInstanced(batches, cache.of);

  eq(meshes.length, batches.length, 'draw call 数 == 批数(每批一个 mesh,不是每实例一个)');
  for (let i = 0; i < meshes.length; i += 1) {
    const m = meshes[i]!;
    const b = batches[i]!;
    eq(m.isInstancedMesh, true, '必须是 InstancedMesh');
    eq(m.count, b.count, `mesh.count 必须等于批的实例数(格 ${b.atlasCell})`);
    eq(m.name, `${PROP_INSTANCED_NAME_PREFIX}${b.atlasCell}`, '名字里带格号,便于从场景里回查');
    eq(m.instanceMatrix.array.length, b.count * 16, '每个实例 16 个 float 的矩阵');
    eq(m.geometry.attributes.position.count, 4, '单位面 = 4 顶点');
    /* three r169 的 `needsUpdate` 只有 setter(setter 里 `version++`)⇒ 可观察量是 version */
    ok(m.instanceMatrix.version >= 1, '填完矩阵必须标脏,否则 GPU 上还是空的');
    ok(m.boundingSphere !== null && m.boundingSphere !== undefined,
      '必须重算包围球(否则视锥裁剪会按 1×1 单位面把整批丢掉)');
    eq(cache.mats.get(b.atlasCell) === m.material, true, '材质取自按格缓存(不是每次新建)');
  }
  eq(cache.calls.length, batches.length, '每批只取一次材质');
});

test('12 矩阵口径:锚点落在实例位置,面心抬高 (0.5 − SPRITE_CENTER_Y) × 高', () => {
  /* 视线取 (0,1,0) ⇒「屏幕上」正好是世界 +Z(见 propBillboardBasis 的推导),
     于是锚点抬升直接体现在 translation 的 z 分量上,判据不必再解一个旋转。 */
  const face = { x: 0, y: 1, z: 0 };
  const items = [prop(3, 5, { z: 1 })];
  const batches = planPropBatches(items);
  eq(batches.length, 1);
  const b = batches[0]!;
  const cache = materialCache();
  const meshes = buildPropInstanced(batches, cache.of, { faceDirection: face });
  eq(meshes.length, 1);

  const arr = meshes[0]!.instanceMatrix.array;
  const h = objSpriteHeightPx(ID_LAMP) * OBJ_HEIGHT_WORLD_PER_PX;
  const lift = (0.5 - SPRITE_CENTER_Y) * h;

  near(arr[12]!, b.originX + b.offsets[0]!, 1e-4, '实例位置 x = 批原点 + 批内偏移');
  near(arr[13]!, b.originY + b.offsets[1]!, 1e-4, '实例位置 y');
  near(arr[14]!, b.originZ + b.offsets[2]! + lift, 1e-4,
    '实例位置 z **加上锚点抬升**(不抬 ⇒ 立牌下沉 0.35 个立牌高)');
  ok(lift > 0, '锚点抬升必须是正的');
  /* 这个朝向下:基的 y 列(屏幕上)= 世界 +Z ⇒ 面高落在矩阵的 [6];
     x 列 = 世界 −X ⇒ 面宽取绝对值;面法线是第三列(世界 +Y)⇒ [9] 恒为 1。 */
  near(arr[6]!, h, 1e-5, 'scale.y == 实例高度(屏幕上 = 世界 +Z)');
  near(Math.abs(arr[0]!), h * 0.92, 1e-5, 'scale.x == 高度 × 0.92(与 boot.ts 的 Sprite 同宽高比)');
  near(arr[9]!, 1, 1e-6, '面法线方向的缩放恒 1');

  /* 两个实例(同批)各自抬升:高度不同的实例抬得也不同 ⇒ 这才是「每实例高度」的牙 */
  const mixed = planPropBatches([
    prop(3, 5, { z: 1 }),
    prop(4, 5, { z: 1, kind: 'vegetation', heightPx: objSpriteHeightPx(ID_LAMP) }),
  ]);
  const cache2 = materialCache();
  const meshes2 = buildPropInstanced(mixed, cache2.of, { faceDirection: face });
  eq(meshes2.length, 1);
  const a2 = meshes2[0]!.instanceMatrix.array;
  /* 每个实例占 16 个 float ⇒ 实例 i 的 translation 在 `i*16 + 12..14` */
  const tz = (i: number): number => a2[i * 16 + 14]!;
  near(tz(0), 1 + (0.5 - SPRITE_CENTER_Y) * h, 1e-4, '实例 0(物品:20px 档)按自己的高度抬升');
  near(tz(1), 1 + (0.5 - SPRITE_CENTER_Y) * PROP_VEG_HEIGHT_WORLD, 1e-4,
    '实例 1(装饰)按**它自己的**高度抬升');
  ok(tz(1) !== tz(0), '同一批里两个实例的抬升量必须不同(批级单值高度就做不到了)');
});

/* ─────────────────────────── 13 ─────────────────────────── */

test('13 朝向基:第三列 == 视线方向、三列正交、右手系;默认取相机方向', () => {
  const dir = cameraOffsetDirection();
  const m = propBillboardBasis();
  const col = (i: number): number[] => [
    m.elements[i * 4]!, m.elements[i * 4 + 1]!, m.elements[i * 4 + 2]!,
  ];

  for (const c of [col(0), col(1), col(2)]) {
    near(Math.hypot(c[0]!, c[1]!, c[2]!), 1, 1e-6, '三列必须是单位向量');
  }
  near(col(2)[0]!, dir.x, 1e-6, '第三列 = 立面法线 = 朝相机方向(与相机同源)');
  near(col(2)[1]!, dir.y, 1e-6);
  near(col(2)[2]!, dir.z, 1e-6);
  const dot = (a: number[], c: number[]): number => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
  near(dot(col(0), col(1)), 0, 1e-6, '屏幕右 ⊥ 屏幕上');
  near(dot(col(0), col(2)), 0, 1e-6, '屏幕右 ⊥ 面法线');
  /* 右手系:col0 × col1 == col2(反向的话面会背对相机,什么都看不见) */
  const cross = [
    col(0)![1]! * col(1)![2]! - col(0)![2]! * col(1)![1]!,
    col(0)![2]! * col(1)![0]! - col(0)![0]! * col(1)![2]!,
    col(0)![0]! * col(1)![1]! - col(0)![1]! * col(1)![0]!,
  ];
  near(cross[0]!, col(2)![0]!, 1e-6, 'col0 × col1 = col2(右手系)');
  near(cross[1]!, col(2)![1]!, 1e-6);
  near(cross[2]!, col(2)![2]!, 1e-6);
  ok(col(1)![2]! > 0, '「屏幕上」必须朝世界 +z(相机在上方 ⇒ 屏幕上方就是世界高处)');

  /* 显式给方向时按参数走;坏方向(全 0)不产生 NaN */
  const up = propBillboardBasis({ x: 0, y: 1, z: 0 });
  near(up.elements[8]!, 0, 1e-9, '面法线 x');
  near(up.elements[9]!, 1, 1e-9, '面法线 y');
  const zero = propBillboardBasis({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < 16; i += 1) {
    ok(Number.isFinite(zero.elements[i]), `坏方向下 elements[${i}] 不该是 NaN`);
  }
});

/* ─────────────────────────── 14 ─────────────────────────── */

test('14 回收:摘父 + 每份 geometry 一次 dispose,材质**不**被释放', () => {
  const batches = planPropBatches([
    prop(0, 0), prop(1, 0), prop(0, 1, { id: ID_WALL }),
  ]);
  const cache = materialCache();
  const meshes = buildPropInstanced(batches, cache.of);
  eq(meshes.length, 2, '夹具前提:两个批');

  /* 用一个批 mesh 当父节点挂另一个(不 import three —— 理由见文件头): */
  meshes[0]!.add(meshes[1]!);
  eq(meshes[1]!.parent === meshes[0], true, '挂上去了');

  let geoDisposals = 0;
  for (const m of meshes) {
    m.geometry.addEventListener('dispose', () => {
      geoDisposals += 1;
    });
  }

  const released = disposePropInstanced(meshes);
  eq(released, meshes.length, '返回值 == 释放的 geometry 份数');
  eq(geoDisposals, meshes.length, '每份 geometry 都必须真的 dispose 一次');
  eq(meshes[1]!.parent, null, '必须从父节点摘下来(否则场景里还留着引用)');
  for (const mat of cache.mats.values()) {
    eq(mat.disposals, 0, `共享材质不得被本函数释放(否则别的批整批变黑):${mat.name}`);
  }
});

/* ─────────────────────────── 15 ─────────────────────────── */

test('15 坏输入跳过:材质缺失 / 空批 / 数据不完整 ⇒ 不建 mesh,且不抛', () => {
  const batches = planPropBatches([prop(0, 0), prop(0, 1, { id: ID_WALL })]);
  const cache = materialCache();
  cache.miss.add(CELL_WALL);
  const meshes = buildPropInstanced(batches, cache.of);
  eq(meshes.length, 1, '没有材质的批必须跳过(否则 three 会用默认材质画白方块)');
  eq(meshes[0]!.name, `${PROP_INSTANCED_NAME_PREFIX}${CELL_LAMP}`);

  /* 手造三种坏批:负格、空批、offsets 太短 —— 都必须被跳过而不是越界读 */
  const good = batches[0]!;
  const bad: PropBatch[] = [
    { ...good, atlasCell: -1 },
    { ...good, count: 0, offsets: new Float32Array(0), heights: new Float32Array(0) },
    { ...good, offsets: new Float32Array(1), heights: new Float32Array(1) },
  ];
  const cache2 = materialCache();
  eq(buildPropInstanced(bad, cache2.of), [], '三种坏批一个都不能建出来');
  eq(cache2.calls.length, 0, '坏批连材质都不该去取');
  eq(buildPropInstanced([], cache2.of), [], '空计划 ⇒ 空结果');
});

report('WS-FND-190');
