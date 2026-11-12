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
 * 把 `buildChunkQuads` 的面数结果落成真实 BufferGeometry。
 *
 * **本函数曾经只分配缓冲、从不写入** —— position 数组全是 0,地形一个三角形
 * 都画不出来,而 3226 行 WS-09 测试全绿(它们只断言 `vertexCount` 这个数字)。
 * 现在顶点由 `stage/chunk_geometry.emitChunkGeometry` 产出,与计数同源。
 */
export function buildChunkGeometry(chunk: ChunkInput, lod: number): THREE.BufferGeometry {
  const emitted = emitChunkGeometry(chunk, lod);
  const err = validateChunkGeometry(emitted);
  if (err !== null) {
    /* 几何与计数不一致是**结构性错误**,不能静默通过 —— 直接抛,让它在开发期就炸出来 */
    throw new Error(`buildChunkGeometry: ${err}`);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(emitted.positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(emitted.uvs, 2));
  geom.setAttribute('normal', new THREE.BufferAttribute(emitted.normals, 3));
  geom.setAttribute('aLodMerge', new THREE.BufferAttribute(
    new Float32Array(emitted.vertexCount).fill(lodMergeSize(lod)),
    1,
  ));
  geom.setIndex(new THREE.BufferAttribute(emitted.indices, 1));
  return geom;
}

/* ───────────────────── Shader 材质 ───────────────────── */

/** 由 shader 契约表生成 three 材质(不硬编码任何 uniform 名) */
export function buildShaderMaterial(name: ShaderName): THREE.ShaderMaterial {
  const prog = SHADER_PROGRAMS[name];
  const uniforms: Record<string, THREE.IUniform> = {};
  for (const spec of SHADER_UNIFORMS[name]) {
    uniforms[spec.name] = { value: defaultValueFor(spec.type) };
  }
  const flags = shaderMaterialFlags(name);
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: prog.vertex,
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
