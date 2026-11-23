/**
 * WS-FND-190 / 把 `stage/obj_sprites.planPropBatches` 的**批计划**装成
 * `THREE.InstancedMesh` —— **一批一次 draw call**。
 *
 * ## 为什么需要这一层
 *
 * 改前世界里的立牌是**一个 `THREE.Sprite` 一个 draw call**:`three/boot.ts` 用
 * `SPRITE_BUDGET = 600` 按「立牌条数」封顶,而实测世界里已有 **615 条**立牌在画
 * ⇒ 密度被 draw call 次数而不是被 GPU 能力卡住,树/草只能稀疏地撒。
 *
 * 同一图集格的实例**共用同一份材质**(纹理 + `offset/repeat` 都相同)⇒ 可以一次画完。
 * 于是封顶口径从「立牌条数」换成「实例总数」(`obj_sprites.PROP_INSTANCE_BUDGET`),
 * 而 draw call 数变成**批数**(实测:几批到几十批)。
 *
 * ## 本模块只做「装配」,不做「规则」
 *
 * | 规则 | 在哪 |
 * |------|------|
 * | 哪一格该摆什么、多高、怎么分组、怎么封顶 | `stage/obj_sprites.ts`(**纯函数,有测试**) |
 * | 矩阵怎么填、怎么建 mesh、怎么回收 | 本文件(允许 import three) |
 *
 * 这个切分与 `assembly_math.ts` 的分层不变量同一条:`stage/**` 永不 import three,
 * 纯规则因此可以被 `node` 直接驱动的测试覆盖,而不是只能靠截图看。
 *
 * ## 实例矩阵的口径(这一层最容易写错的地方)
 *
 * 立牌面 = `PlaneGeometry(1, 1)`(单位方图,中心在原点,法线 `+Z`),
 * 每个实例的矩阵 = `compose(position, 四元数, scale)`,其中:
 *
 * ```
 * scale    = (高 × 0.92, 高, 1)            ← 宽高比与 boot.ts 的 Sprite 同源
 * 旋转     = propBillboardBasis(视线方向)   ← 列 = 屏幕右 / 屏幕上 / 朝相机
 * position = 批原点 + 批内偏移 + 屏幕上 × (0.5 − SPRITE_CENTER_Y) × 高
 * ```
 *
 * 三点理由,缺一条就会静默画歪:
 *
 * 1. **朝向必须是「屏幕轴」而不是 `lookAt`**:three 的 `Sprite` 用的是**相机自身的
 *    三个轴**,所以「一个 Sprite 长什么样」= 面贴在屏幕平面上。实例化以后没有
 *    逐实例 `lookAt` 的机会,而相机是**正交 + 固定俯仰/方位**(`iso_camera` 的
 *    35°/45°)⇒ 视线方向**处处相同** ⇒ 一个全局旋转基与逐实例 `lookAt`
 *    **完全等价**(正交投影下没有透视方向差)。这不是近似,是恒等。
 * 2. **锚点要抬到面心**:`Sprite.center = (0.5, 0.15)`(见 `SPRITE_CENTER_Y`)的含义是
 *    「`position` 落在立牌从底部往上 15% 处」。而 `PlaneGeometry` 的 `position`
 *    对齐的是**面心**(50%)⇒ 面心必须再往「屏幕上」抬 `(0.5 − 0.15) × 高 = 0.35 × 高`,
 *    否则整批立牌会**静默下沉 0.35 个立牌高**(脚埋进地里)。
 * 3. **`position` 与 `scale` 必须一起定**:只改高度不改锚点抬升,会得到
 *    「越高沉得越深」——一个只在截图里看得出来的错。
 *
 * ## 每实例高度不同怎么进同一批
 *
 * 高度**逐实例进矩阵**(`heights` 每个实例一个 float,`scale.y` 就是它)。
 * 单位面 `1×1` 是共享的几何体,所以「同一批里既有 2.6 格高的树又有 0.46 格高的
 * 草丛」没有任何问题:几何体只描述「一个方形面」,大小全在矩阵里。
 * 这正是 `PropBatch.heights` 存在的理由 —— 否则就得按高度再分组,把批数乘上去。
 *
 * ## 谁负责回收(接线时照这个写)
 *
 * ```
 * const meshes = buildPropInstanced(batches, materialOfCell);   // 每批一个
 * for (const m of meshes) scene.add(m);
 * // ……重建世界(换 chunk / 换世界)时:
 * disposePropInstanced(meshes);   // 摘父 + 释放 geometry;材质**不**由它释放
 * ```
 *
 * `InstancedMesh` 的实例数据(`instanceMatrix`)随 geometry 的绑定状态一起释放
 * (three r169 里 `InstancedMesh` **没有** `dispose()` 方法,只有 `computeBoundingSphere()`)。
 * 材质是调用方**按格缓存**的共享对象,故 `buildPropInstanced` 与
 * `disposePropInstanced` 都**不碰**它。
 */

/* three 未随包发布类型声明(`node_modules/three` 里没有 `*.d.ts`)⇒ `tsc` 对这条
   import 报 TS7016。既有两处同因,且已登记在 `scripts/typecheck-baseline.json`:
     · `client/src/three/boot.ts:22`
     · `client/src/three/stage_assembly.ts:25`
   这里**不复用那条欠账**:基线指纹是 `${file}|${code}|${msg}`,带**文件路径**
   (`scripts/typecheck-baseline-audit.ts:102`)⇒ 多一个文件就是多一条指纹 ⇒
   改基线等于把「新增欠账」写成「存量」。
   故用指令就地豁免:
   ⚠️ 它**自带判据** —— 哪天 three 补上类型声明,这条指令会因为「没有错误可忽略」
   而报 TS2578 ⇒ 那时应当删掉它并改用真类型(而不是顺手再忽略一次)。 */
// @ts-expect-error three 没有类型声明文件(理由见上,不是笔误)
import * as THREE from 'three';

import { SPRITE_CENTER_Y, cameraOffsetDirection, type Vec3 } from '../stage/assembly_math.ts';
import {
  OBJ_SPRITE_FALLBACK_HEIGHT_WORLD,
  PROP_SPRITE_ASPECT_X,
  type PropBatch,
} from '../stage/obj_sprites.ts';

/* ───────────────────────────── 对外契约 ───────────────────────────── */

/**
 * 图集格 → 材质。**必须按格缓存**(同一格的所有批共用一份):
 * 每次调用都新建材质会让「一批一次 draw call」变成「一批一次纹理上传」,
 * 把实例化省下来的开销又还回去。
 *
 * 返回 `null` 表示「这一格现在没有材质」(例如图集图片还没加载完)⇒ 对应批**跳过**。
 */
export type PropMaterialOfCell = (atlasCell: number) => THREE.Material | null;

/** 装配旋钮(全部有默认值) */
export interface PropBatchBuildOptions {
  /**
   * 立牌面朝向的**视线方向**(单位向量,由焦点指向相机)。
   * 默认 `assembly_math.cameraOffsetDirection()`(35°/45° 固定相机)。
   * 相机是正交的 ⇒ 全局一个方向与逐实例 `lookAt` 等价(见文件头第 1 条)。
   */
  faceDirection?: Vec3;
  /** mesh 名字前缀,默认 `PROP_INSTANCED_NAME_PREFIX`;名字里会带上图集格号,便于回查 */
  namePrefix?: string;
}

/** 批 mesh 的名字前缀:`prop_batch_<图集格号>` */
export const PROP_INSTANCED_NAME_PREFIX = 'prop_batch_';

/** 单位面:每实例 4 顶点 / 2 三角形(与 `three.PlaneGeometry(1, 1)` 一致) */
export const PROP_PLANE_VERTS = 4;

/* ───────────────────────────── 朝向基 ───────────────────────────── */

/**
 * 立牌面的旋转基:列为 **(屏幕右, 屏幕上, 朝相机)**,右手系。
 *
 * 与 three 的 `Sprite` 用的是同一套轴 —— Sprite 取相机自身的三个轴,而在
 * **正交固定相机**下那三个轴处处相同 ⇒ 这里算一次,所有实例共用。
 *
 * 算法:
 * ```
 * z = 视线方向(归一)
 * y = worldUp 去掉沿 z 的分量后归一            (屏幕上)
 * x = y × z                                    (屏幕右)
 * y = z × x                                    (正交化,保证右手系)
 * ```
 * `worldUp` 与视线平行时(理论上的正俯视)`(0,0,1)` 的投影会退化成零向量 ⇒
 * 依次换 `(1,0,0)`、`(0,1,0)` 再投一次;三次都退化只可能发生在 `z` 非单位向量时,
 * 此时直接用 `(0,1,0)` 收尾 —— **不抛异常,也不留 `NaN`**(高频路径上的坏方向
 * 应该退化成「朝向不对」而不是「整帧崩」)。
 */
export function propBillboardBasis(dir: Vec3 = cameraOffsetDirection()): THREE.Matrix4 {
  const zAxis = new THREE.Vector3(dir.x, dir.y, dir.z);
  if (!Number.isFinite(zAxis.lengthSq()) || zAxis.lengthSq() === 0) zAxis.set(0, 0, 1);
  zAxis.normalize();

  const up = new THREE.Vector3();
  for (const cand of [[0, 0, 1], [1, 0, 0], [0, 1, 0]]) {
    /* 投影:`up − (up·z)·z`(去掉了沿视线的分量 ⇒ 与面法线垂直) */
    up.set(cand[0], cand[1], cand[2]).addScaledVector(zAxis, -up.dot(zAxis));
    if (up.lengthSq() > 1e-12) break;
  }
  if (up.lengthSq() <= 1e-12) up.set(0, 1, 0);
  up.normalize();

  const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
}

/* ───────────────────────────── 建批 ───────────────────────────── */

/**
 * 批计划 → 批 mesh 列表。**返回数组里的每个对象对应一次 draw call**。
 *
 * ## 跳过条件(每一条都对应一种「画出来是错的」)
 *
 * | 条件 | 不跳会怎样 |
 * |------|-----------|
 * | `atlasCell < 0`(含非整数) | 去采样 `frameRectOfCell(-1)`(实为 `cellCoordsOf(-1)` ⇒ 列 `-1`)⇒ 取到**错位的图**,而且不报错 |
 * | `count === 0` | 建出一个什么都不画的对象 + 一次空调用,白占预算 |
 * | `offsets`/`heights` 长度不足 | 越界读 `undefined` ⇒ 矩阵里出现 `NaN` ⇒ **整批消失** |
 * | `materialOfCell` 返回 `null` | 材质为空 ⇒ three 走默认材质 ⇒ 白方块盖住地形 |
 *
 * 这些条件都属于「输入是坏数据」而不该是「抛异常」:高频路径上一个坏批不该打断整帧。
 *
 * ## 视锥裁剪
 *
 * 每个批**重算包围球**(`computeBoundingSphere()`)。不重算的话裁剪读的是
 * `PlaneGeometry` 的 1×1 单位球 ⇒ 批原点一离开视口,整批立牌会**一起消失**。
 *
 * ## 名下的所有权
 *
 * 返回的 mesh:`geometry` 由本模块新建(每批一份,不共享)⇒ **归调用方释放**;
 * `material` 由 `materialOfCell` 提供(调用方按格缓存)⇒ **仍归调用方**,
 * 本模块不释放、也不应被外部释放到别的批还在用的那份。回收见 `disposePropInstanced`。
 */
export function buildPropInstanced(
  batches: readonly PropBatch[],
  materialOfCell: PropMaterialOfCell,
  opts?: PropBatchBuildOptions,
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  if (batches.length === 0) return out;
  if (typeof materialOfCell !== 'function') return out;

  const basis = propBillboardBasis(opts?.faceDirection);
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
  /* 屏幕上(世界方向)= 基的第二列。锚点落在实例位置、面心在锚点上方 ⇒ 见文件头第 2 条 */
  const up = new THREE.Vector3().setFromMatrixColumn(basis, 1);
  const anchorToCenter = 0.5 - SPRITE_CENTER_Y;
  const prefix = opts?.namePrefix ?? PROP_INSTANCED_NAME_PREFIX;

  /* 循环外复用的临时量(每实例 new 一个 Vector3/Matrix4 会在几千实例时变成 GC 压力) */
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const m4 = new THREE.Matrix4();

  for (const b of batches) {
    if (!Number.isInteger(b.atlasCell) || b.atlasCell < 0) continue;
    if (b.count === 0) continue;
    if (b.offsets.length < b.count * 3 || b.heights.length < b.count) continue;
    const material = materialOfCell(b.atlasCell);
    if (material === null || material === undefined) continue;

    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geometry, material, b.count);
    mesh.name = `${prefix}${b.atlasCell}`;
    mesh.count = b.count;
    for (let i = 0; i < b.count; i += 1) {
      const hRaw = b.heights[i];
      /* 高度坏掉 ⇒ 兜底档(与 `obj_sprites.OBJ_SPRITE_FALLBACK_HEIGHT_WORLD` 同源)。
         为什么不是「跳过这个实例」:那会让 `count` 与矩阵里的实例数对不上 ——
         而 `InstancedMesh` 画的就是前 `count` 个 ⇒ 末位会画出一个**未初始化的单位面**
         (位于世界原点),比「矮了一点」难查得多。 */
      const h = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : OBJ_SPRITE_FALLBACK_HEIGHT_WORLD;
      pos
        .set(
          b.originX + b.offsets[i * 3],
          b.originY + b.offsets[i * 3 + 1],
          b.originZ + b.offsets[i * 3 + 2],
        )
        .addScaledVector(up, anchorToCenter * h);
      scale.set(h * PROP_SPRITE_ASPECT_X, h, 1);
      m4.compose(pos, quat, scale);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out;
}

/* ───────────────────────────── 回收 ───────────────────────────── */

/**
 * 回收批 mesh:**从父节点摘下来 + 释放 geometry**。返回释放了几份 geometry
 * (调用方可以拿它断言「计划里的批都回收了」)。
 *
 * - `geometry` 由本模块释放:每个批一份 `PlaneGeometry`,不共享 ⇒ 释放它不影响别的批;
 * - **材质不在这里释放**:`materialOfCell` 返回的是调用方按格缓存的**共享**材质
 *   (多个批可能共用,甚至与别的立牌共用)⇒ 在这里 dispose 会让别的批整批变黑。
 *   它归缓存持有者统一回收。
 * - `InstancedMesh` 的实例缓冲随 geometry 的绑定状态释放(three r169 的
 *   `InstancedMesh` 没有 `dispose()` 方法,只有 `computeBoundingSphere()`)。
 */
export function disposePropInstanced(objects: readonly THREE.Object3D[]): number {
  let n = 0;
  for (const o of objects) {
    /* 结构类型而不是 `as THREE.Mesh`:调用方手里可能是 `Object3D[]`(例如它把 mesh
       混进了通用的场景对象列表),这里只用到「摘父」与「geometry」两个能力。 */
    const mesh = o as {
      geometry?: { dispose?: () => void } | null;
      removeFromParent?: () => void;
    };
    if (typeof mesh.removeFromParent === 'function') mesh.removeFromParent();
    const g = mesh.geometry;
    if (g !== null && g !== undefined && typeof g.dispose === 'function') {
      g.dispose();
      n += 1;
    }
  }
  return n;
}
