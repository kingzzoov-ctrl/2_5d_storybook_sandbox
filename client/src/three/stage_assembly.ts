/**
 * WS-09 / three.js 装配层 —— **唯一允许 import `three` 的地方**。
 *
 * 本文件不被任何测试导入(`tests/WS-09.test.ts` 只 import `node:*` 与 `shared/**`,
 * 且硬约束「不得 import three」)。它的职责极端单纯:**把纯逻辑层的输出翻译成 three 对象**,
 * 一行业务规则都不写。
 *
 * ## 纯计算住在哪
 *
 * 凡是**可测的纯计算**都已在 `stage/assembly_math.ts`(零依赖、被测试覆盖):
 * 相机朝向与正交半宽、NDC 换算、quad 索引缓冲、LOD 合并边长、uniform 类型分类、
 * 材质透明标志、立牌图集 UV、染色 uniform 负载。
 *
 * 本文件只负责「把那些数值塞进 three 构造函数」,因此以下都是**薄装配**而非逻辑:
 * `new THREE.Xxx(...)`、`setAttribute(...)`、`appendChild(...)`。
 *
 * 这里如果出现 `if (playerIsIndoors)` 这类判断,就是架构违规,应移回纯逻辑层。
 *
 * ## 层间不变量(task-15 审计补)
 *
 * `stage/**` 与 `ui/**` **永不** import `three`;只有 `three/**` 可以。
 * 审计脚本可验证:`grep -rn "from 'three'" client/src/stage client/src/ui` 应为空。
 */

import * as THREE from 'three';
import {
  createCamera,
  type IsoCamera,
  projectGridToScreen,
} from '../stage/iso_camera.ts';
import { type ChunkInput, buildChunkQuads } from '../stage/tile_mesh.ts';
import { emitChunkGeometry, validateChunkGeometry } from '../stage/chunk_geometry.ts';
import { TERRAIN_UV_ATTRIBUTE } from '../stage/terrain_vcolor.ts';
import { SHADER_PROGRAMS, SHADER_UNIFORMS, type ShaderName } from '../stage/shaders.ts';
import type { ParticlePool } from '../stage/particles.ts';
import { AURA_ANCHORS, ICON_SIZE, type WeaponTextureBundle } from '../stage/entity_sprites.ts';
import type { DyeEntry } from '../stage/dye_overlay.ts';
import {
  ORTHO_DISTANCE,
  atlasUvForFacing,
  billboardScale,
  cameraForwardVector,
  cameraPosition,
  dyeUniformPayload,
  dyeUploadCount,
  isTextureUniform,
  lodMergeSize,
  orthoHalfExtents,
  quadIndexBuffer,
  screenToNdc as ndcOf,
  shaderMaterialFlags,
  uniformTypeKind,
} from '../stage/assembly_math.ts';
import { assembleChunkGeometry, assembleTerrainMaterial, setThreeProvider, threeSource } from './compat.ts';
import { crossCheckExactFaces, exactFaceCount } from './count.ts';

/**
 * ★ WS-09 U1 的唯一注入点:真 `three` 从这里进相容层。
 *
 * 为什么放在模块顶层而不是函数里:装配是本模块每一次调用的前提,
 * 放到函数里就变成"谁忘了调谁静默退回兜底"—— 那种缺陷只在真机上表现为
 * 画面空白,单测永远看不见。
 *
 * 类型上 `three` 在本仓没有声明文件(基线里 `stage_assembly.ts` 的 TS7016 就是它),
 * 因此这里是 `unknown` 中转 —— 相容层只认 `ThreeLike` 那 4 个构造器。
 */
setThreeProvider(THREE as unknown as Parameters<typeof setThreeProvider>[0]);

/* ───────────────────── 正交相机装配 ───────────────────── */

/**
 * 由纯逻辑 `IsoCamera` 生成 three 正交相机。
 *
 * 关键映射(全部由 `assembly_math` 算出,这里只做装配):
 * 纯逻辑用「屏幕像素」(originX/originY 为 focus 的屏幕位置),
 * three 正交相机用「以视口中心为原点的世界单位」,换算为 `像素 / pixelScale`。
 */
export function buildOrthographicCamera(cam: IsoCamera, near = -1024, far = 4096): THREE.OrthographicCamera {
  const { halfW, halfH } = orthoHalfExtents(cam);
  const out = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, near, far);
  const pos = cameraPosition(cam.focusX, cam.focusY, cam.focusZ, ORTHO_DISTANCE);
  out.position.set(pos.x, pos.y, pos.z);
  out.up.set(0, 0, 1);
  out.lookAt(cam.focusX, cam.focusY, cam.focusZ);
  out.updateProjectionMatrix();
  return out;
}

/** 纯逻辑相机 → three 相机朝向(供阴影/后处理复用) */
export function cameraForward(): THREE.Vector3 {
  const f = cameraForwardVector();
  return new THREE.Vector3(f.x, f.y, f.z);
}

/* ───────────────────── 分块网格装配 ───────────────────── */

/**
 * 把面数结果落成真实 BufferGeometry(**经相容层装配**)。
 *
 * **本函数曾经只分配缓冲、从不写入** —— position 数组全是 0,地形一个三角形
 * 都画不出来,而 3226 行 WS-09 测试全绿(它们只断言 `vertexCount` 这个数字)。
 * 现在顶点与**顶点色**都由 `stage/chunk_geometry.emitChunkGeometry` 产出,与计数同源,
 * 并由相容层(`three/compat.ts`)塞进引擎 —— 没有 three 时同一段装配走兜底实现。
 *
 * 三条硬不变量,任一违反即抛:
 *   1. 几何自检(含顶点色长度/值域)通过;
 *   2. `dominantZGrid` 精确面数 == 写出面数(WS-09 U4);
 *   3. `exactFaces` 与 `buildChunkQuads` 不漂移。
 */
export function buildChunkGeometry(chunk: ChunkInput, lod: number): THREE.BufferGeometry {
  const emitted = emitChunkGeometry(chunk, lod);
  const err = validateChunkGeometry(emitted);
  if (err !== null) {
    /* 几何与计数不一致是**结构性错误**,不能静默通过 —— 直接抛,让它在开发期就炸出来 */
    throw new Error(`buildChunkGeometry: ${err}`);
  }
  const exact = exactFaceCount(chunk, lod);
  if (exact !== emitted.faceCount) {
    throw new Error(
      `buildChunkGeometry: dominantZGrid 精确面数 ${exact} ≠ 写出面数 ${emitted.faceCount}(${chunk.key} LOD${lod})`,
    );
  }
  const drift = crossCheckExactFaces(chunk, lod);
  if (drift !== null) throw new Error(`buildChunkGeometry: ${drift}`);
  /*
   * ★ WS-FND-193:把图集 UV 真的挂上几何。
   *
   * 相容层(`three/compat.assembleChunkGeometry`)的属性清单是 position/color/normal/
   * aLodMerge/索引 —— 它按「顶点色无纹理」那条旧裁决写的,**没有 uv**;而顶面现在
   * 要按 UV 采样地砖格 ⇒ 缺这一行的表现是「有颜色、没纹理」:不抛、不报错,与
   * WS-FND-89 那个「几何上的 color 属性没有任何读者」的缺陷同型。
   */
  const geom = assembleChunkGeometry(emitted, lod) as unknown as THREE.BufferGeometry;
  geom.setAttribute(TERRAIN_UV_ATTRIBUTE, new THREE.BufferAttribute(emitted.uvs, 2));
  return geom;
}

/**
 * 地形材质:顶点色(材质基色)× 图集图素(明暗调制)。
 *
 * 返回的 `vertexColors === true`、**是 raw 材料**(three 不注入内建 `attribute`,
 * 源码自带宽高)、片元**采样**图集且采样被 `uAtlasReady` 门控 —— 与
 * `stage/terrain_vcolor.ts` 的判据同一份源码,不存在"测试查 A、渲染跑 B"。
 *
 * ★ WS-FND-89:这个函数此前**零生产调用点**(`boot.ts` 直接 `new MeshLambertMaterial`),
 *   于是几何上的 `color` 属性没有任何读者、真机恒为一块单色,而所有顶点色判据全绿。
 *   现在 `boot.ts` 的地形材质就是它(见 `boot.ts` 里 `buildTerrainMaterial()` 那行)。
 *
 * ★ WS-FND-193:两个图集 uniform(`uAtlas` / `uAtlasReady`)在这里建好并置成
 *   「未就绪」,纹理由 `bindTerrainAtlas()` 在运行时拿到图集后填进来 ⇒
 *   图集没到的那一帧着色器走纯顶点色分支,**不会黑屏**。
 */
export function buildTerrainMaterial(): THREE.ShaderMaterial {
  const mat = assembleTerrainMaterial() as unknown as THREE.ShaderMaterial;
  /*
   * ★ WS-FND-193:图集 uniform 的默认值必须是「**未就绪**」。
   *
   * 图集是运行时 fetch 的(`boot.ts` 的 `loadAtlasImage()`),首帧一定还没有纹理;
   * 若默认 `uAtlasReady = 1`,着色器会去采样一张**未绑定**纹理 ⇒ 地形整片变黑,
   * 不抛异常、不报错(只有眼睛能发现的缺陷)。
   * ⇒ 0 = 「退回纯顶点色」;只有 `bindTerrainAtlas()` 真拿到 image 才置 1。
   *
   * ⚠️ 这里放的是 three 的 uniform **对象本身**(`{ value }`),不是快照:three 在
   *    程序首次渲染时按对象身份缓存 uniform 上传清单(`WebGLUniforms.seqWithValue`),
   *    所以后续换纹理**只能改 `.value`**,不能换对象(见 `bindTerrainAtlas`)。
   */
  mat.uniforms.uAtlas = { value: null };
  mat.uniforms.uAtlasReady = { value: 0 };
  return mat;
}

/**
 * 把 `loadAtlasImage()` 拿到的图片装成地形材质的图集纹理 —— **图集接线的唯一入口**。
 *
 * ## 调用点(`boot.ts` 里要加的那一行)
 *
 * ```ts
 * const mat = buildTerrainMaterial();
 * void loadAtlasImage().then((img) => { bindTerrainAtlas(mat, img); });
 * ```
 *
 * ## 为什么 `img === null` 时不抛,而是返回 null
 *
 * `loadAtlasImage()` 在资源缺失时 **resolve(null)**(见它的注释:没有图集时场景仍要
 * 能跑)。那时保持 `uAtlasReady = 0` ⇒ 地形退回纯顶点色 —— 这是**降级**,不是错误:
 * 把「资源缺失」升级成「白屏/黑地形」只会让排查更难。
 *
 * ## 三个纹理参数为什么这么取
 *
 *   1. `NearestFilter` + `generateMipmaps = false`:像素画风;双线性/多级渐远会把
 *      屏幕上只有 16px 一格的地砖糊成色斑;
 *   2. `colorSpace` **不设** `SRGBColorSpace`(与 `boot.ts` 的立牌路径刻意相反):
 *      立牌图是**成品色**,必须解码;这里图素是**乘数**(`vColor * tex * 2.0`),
 *      与顶点色在同一空间相乘 —— 设成 sRGB 会把整片地形压暗约 2.2 次方;
 *   3. `flipY` 保持默认 `true`:图集 UV 由 `assembly_math.frameToUv` 按「图像左上角
 *      原点 + flipY」算出(`v = 1 - y/H`),两边必须同一假设。
 */
export function bindTerrainAtlas(
  material: THREE.ShaderMaterial,
  img: HTMLImageElement | null,
): THREE.Texture | null {
  if (img === null) return null;
  /* 图集里的地砖是等轴测菱形精灵,四角是透明的。地形着色器只取 `.rgb`
     (`vColor * tex * 2.0`),透明像素的 rgb 是 0 ⇒ 乘出来是黑的,铺满地面就是
     「红黑 / 黑白棋盘」和满地噪点。
     加载时把每一格的透明部分用这一格不透明像素的平均色填实(按 alpha 混合,半透明边也平滑过渡),
     格布局不变 ⇒ `assembly_math` 算的 UV 仍有效;着色器与兜底格都不动。
     整格都透明 ⇒ 填中灰(乘 2.0 后恰好是顶点色原样)。
     没有 `document`(node 里的断言)或读像素失败 ⇒ 退回原图,与此前一致。 */
  let source: HTMLImageElement | HTMLCanvasElement = img;
  try {
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d');
    if (ctx !== null) {
      ctx.drawImage(img, 0, 0);
      const image = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = image.data;
      const CELL = 64;
      for (let cy = 0; cy + CELL <= cv.height; cy += CELL) {
        for (let cx = 0; cx + CELL <= cv.width; cx += CELL) {
          let r = 0; let g = 0; let b = 0; let n = 0;
          for (let y = cy; y < cy + CELL; y += 1) {
            for (let x = cx; x < cx + CELL; x += 1) {
              const i = (y * cv.width + x) * 4;
              if (d[i + 3]! < 200) continue;
              r += d[i]!; g += d[i + 1]!; b += d[i + 2]!; n += 1;
            }
          }
          const ar = n > 0 ? r / n : 128;
          const ag = n > 0 ? g / n : 128;
          const ab = n > 0 ? b / n : 128;
          for (let y = cy; y < cy + CELL; y += 1) {
            for (let x = cx; x < cx + CELL; x += 1) {
              const i = (y * cv.width + x) * 4;
              const a = d[i + 3]! / 255;
              d[i] = d[i]! * a + ar * (1 - a);
              d[i + 1] = d[i + 1]! * a + ag * (1 - a);
              d[i + 2] = d[i + 2]! * a + ab * (1 - a);
              d[i + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(image, 0, 0);
      source = cv;
    }
  } catch {
    source = img;
  }
  const tex = new THREE.Texture(source);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const u = material.uniforms;
  /* 只改 `.value`:uniform 对象身份被 three 缓存,换对象等于这次接线没生效 */
  if (u.uAtlas !== undefined) u.uAtlas.value = tex; else u.uAtlas = { value: tex };
  if (u.uAtlasReady !== undefined) u.uAtlasReady.value = 1; else u.uAtlasReady = { value: 1 };
  return tex;
}

/**
 * 把相机的 `projectionMatrix` / `matrixWorldInverse` 喂给地形顶点色材质。
 *
 * ★ 为什么必须**每帧**调用:材质是 `RawShaderMaterial`,three **不会**注入
 *   `projectionMatrix` / `modelViewMatrix`,矩阵只能由我们上传。漏掉这一步的表现是
 *   「地形整片消失或塌成一个点」,而不是报错 —— 又是那种只靠眼睛才能发现的缺陷。
 *
 * `uModel` 保持单位矩阵:世界顶点已经是绝对格坐标(见 `stage/chunk_geometry.ts`)。
 */
export function syncTerrainCamera(
  material: THREE.ShaderMaterial,
  camera: THREE.OrthographicCamera,
): void {
  camera.updateMatrixWorld();
  const u = material.uniforms;
  if (!u || !u.uProjection || !u.uView || !u.uModel) return;
  (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
  (u.uView.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
  (u.uModel.value as THREE.Matrix4).identity();
}

/** 当前装配走的是真 three 还是相容层兜底(浏览器自检可读它) */
export function assemblySource(): 'injected' | 'fallback' {
  return threeSource();
}

/* ─────────────── 未接线的装配函数(第六轮审计 P1:登记,不宣称)───────────────
 *
 * 下面这 6 个导出在 `client/src` 里**仍然没有调用点**(实测):
 *
 * ```
 * buildShaderMaterial / buildPixelTexture / buildBillboard /
 * attachAuraEmitters / applyDyeUniforms / createStage
 * ```
 *
 * 连带没有消费者的还有:`stage/shaders.ts` 的 12 个程序、`stage/particles.ts`
 * 的粒子池、`stage/dye_overlay.ts` 的染色通道、`entity_sprites.buildWeaponTexture`。
 *
 * **本文件的注释不再暗示它们被生产使用**(修前注释里的"装配入口"读起来像已接线)。
 * 每条为什么没接、接了需要什么,写在 `client/src/wiring_ledger.ts` 的台账里;
 * 台账状态与真实调用点由 `tests/WS-FND-121` 双向核对(标 blocked 就必须真的 0 调用点)。
 *
 * ⚠️ 谁把它们接上去了,**必须**同步把台账那条改成 `wired` —— 否则判据会红,
 *    那不是判据坏了,是台账过期了。
 */

/**
 * 由 shader 契约表生成 three 材质(不硬编码任何 uniform 名)。
 *
 * ★ WS-FND-89:`stage/shaders.ts` 的顶点源码**自己声明** `attribute vec3 position;`
 *   (水面/草木/熔岩/染色)与 `attribute vec2 uv;`,还有 `normal`。这与
 *   `ShaderMaterial` 天生冲突:three 会**再注入一遍**同名声明 ⇒ GLSL 重定义 ⇒
 *   材质编译失败(对象整块不显示,且不抛异常)。
 *
 *   所以这里用 `RawShaderMaterial`(three 不注入任何东西),并在顶点源码前补一行
 *   `precision highp float;`(raw 连默认精度都没有;片元源码自己已经写了)。
 *   源码常量本身**不动** —— `tests/WS-09` 逐条断言它们声明了 `position` / `normal` /
 *   `aWindWeight` 等属性,那是对的:属性该由源码声明,只是不该由 three 再声明一次。
 *
 * ⚠️ raw 材料不注入 `projectionMatrix`/`modelViewMatrix`:矩阵必须由调用方从
 *   `uProjection`/`uView`/`uModel` 上传(与地形同一条约束,见 `syncTerrainCamera`)。
 */
export function buildShaderMaterial(name: ShaderName): THREE.ShaderMaterial {
  const prog = SHADER_PROGRAMS[name];
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const spec of SHADER_UNIFORMS[name]) {
    uniforms[spec.name] = { value: defaultValueFor(spec.type) };
  }
  const flags = shaderMaterialFlags(name);
  return new THREE.RawShaderMaterial({
    name,
    uniforms,
    vertexShader: `precision highp float;\n${prog.vertex}`,
    fragmentShader: prog.fragment,
    transparent: flags.transparent,
    depthWrite: flags.depthWrite,
  });
}

function defaultValueFor(type: string): unknown {
  if (isTextureUniform(type)) return null;
  switch (uniformTypeKind(type)) {
    case 'number':
      return 0;
    case 'vec2':
      return new THREE.Vector2();
    case 'vec3':
      return new THREE.Vector3();
    case 'vec4':
      return new THREE.Vector4();
    case 'mat4':
      return new THREE.Matrix4();
    default:
      return null;
  }
}

/* ───────────────────── 像素纹理 ───────────────────── */

/**
 * `WeaponTextureBundle` 的 1024 字节 RGBA → `THREE.DataTexture`。
 * `flipY = false`:我们的行序第 0 行即图像顶部。
 */
export function buildPixelTexture(bundle: WeaponTextureBundle): THREE.DataTexture {
  const tex = new THREE.DataTexture(bundle.rgba, ICON_SIZE, ICON_SIZE, THREE.RGBAFormat);
  tex.flipY = false;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ───────────────────── 立牌与挂点 ───────────────────── */

/** 立牌 Sprite:始终面向相机,uv 按 8 帧朝向从图集取子块 */
export function buildBillboard(texture: THREE.Texture, facing: number, heightPx: number, cam: IsoCamera): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(mat);
  const s = billboardScale(heightPx, cam);
  sprite.scale.set(s, s, 1);
  const uv = atlasUvForFacing(facing);
  mat.map.offset.set(uv.offsetU, uv.offsetV);
  mat.map.repeat.set(uv.repeatU, uv.repeatV);
  return sprite;
}

/** 在实体上挂粒子光环发射器(用锚点表,不写死坐标) */
export function attachAuraEmitters(
  root: THREE.Object3D,
  aura: string,
  pool: ParticlePool,
  spawn: (pool: ParticlePool, x: number, y: number, z: number, kind: number, scale: number) => void,
): void {
  const anchors = AURA_ANCHORS[aura] ?? [];
  for (const a of anchors) {
    const obj = new THREE.Object3D();
    obj.position.set(a.offsetX, a.offsetY, a.offsetZ);
    obj.userData.particleKind = a.kind;
    obj.userData.scale = a.scale;
    root.add(obj);
    /* 发射器本身是无状态的:每帧由渲染循环按锚点世界位置调用 spawn */
    obj.userData.spawnNeeded = true;
    obj.userData.spawn = () => spawn(pool, obj.position.x, obj.position.y, obj.position.z, a.kind, a.scale);
  }
}

/* ───────────────────── 染色 uniform 上传 ───────────────────── */

/**
 * 把染色记录上传为 uniform。
 *
 * **计数语义已修正**:`uDyeTint`/`uDyeMaskRect`/`uDyeStrength` 在材质上各只有**一个**槽位,
 * 循环写 N 次只有最后一次可见。原实现按 `entries.length` 累加计数,把
 * 「写了 N 次同一个槽位」误报成「N 个表面已上传」。
 * 现在返回 `dyeUploadCount(entries)`,即「是否真的有一次可见的上传」(0/1);
 * 多表面请走 `DyeChannel.exportUniformArray()` + 实例化属性。
 */
export function applyDyeUniforms(
  material: THREE.ShaderMaterial,
  entries: readonly DyeEntry[],
  paletteColor: (i: number) => string,
): number {
  if (entries.length === 0) return 0;
  const tint = material.uniforms.uDyeTint;
  if (!tint) return 0;
  const payload = dyeUniformPayload(entries[entries.length - 1], paletteColor);
  (tint.value as THREE.Vector3).set(payload.tint.r, payload.tint.g, payload.tint.b);
  const rect = material.uniforms.uDyeMaskRect;
  if (rect) {
    (rect.value as THREE.Vector4).set(
      payload.maskRect.x, payload.maskRect.y, payload.maskRect.w, payload.maskRect.h,
    );
  }
  const st = material.uniforms.uDyeStrength;
  if (st) st.value = payload.strength;
  return dyeUploadCount(entries);
}

/* ───────────────────── 场景装配入口 ───────────────────── */

export interface StageHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  clean: () => void;
}

/**
 * 最小可用装配:MVP 阶段只搭空舞台,几何由 `WS-01` 的 Chunk 数据驱动。
 * 复杂度 O(1)(不在此处做任何建面遍历)。
 */
export function createStage(container: HTMLElement, viewportW: number, viewportH: number): StageHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(viewportW, viewportH);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2233);

  const logicCam = createCamera(viewportW, viewportH);
  const camera = buildOrthographicCamera(logicCam);

  return {
    renderer,
    scene,
    camera,
    clean: () => {
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}

/** 世界(格)→ three 世界坐标(Vector3)。恒等映射,避免手工换算出错。 */
export function gridToVector3(gx: number, gy: number, gz: number, out?: THREE.Vector3): THREE.Vector3 {
  return (out ?? new THREE.Vector3()).set(gx, gy, gz);
}

/** 屏幕像素 → three NDC(供射线拾取)。像素换算是纯函数,见 `assembly_math.screenToNdc`。 */
export function screenToNdc(sx: number, sy: number, cam: IsoCamera, out?: THREE.Vector2): THREE.Vector2 {
  const n = ndcOf(sx, sy, cam.viewportW, cam.viewportH);
  return (out ?? new THREE.Vector2()).set(n.x, n.y);
}

/** 调试辅助:把纯逻辑投影点转成 three Vector2(验证装配与纯逻辑一致) */
export function projectedToVector2(gx: number, gy: number, gz: number, cam: IsoCamera): THREE.Vector2 {
  const p = projectGridToScreen(gx, gy, gz, cam);
  return new THREE.Vector2(p.x, p.y);
}
