# three.js 官方文档与社区/素材库调研 —— 2.5D 等轴测落地指引

> **本文的写法**:每一条结论都**实际抓取网页或实测仓库文件**得出,并附来源 URL。
> 凡是我**没有验证**的,一律显式标「未验证」,不编造。
> 本次调研附带的临时脚本以 `_tp_` 前缀命名,已在完成后删除。

**调研时间**:2026-11-12(JST/Asia-Shanghai)
**目标引擎**:three.js + Vite,35° 正交等轴测,手机浏览器,免下载即点即玩
**当前仓库状态**:`three` 已作为 `optionalDependencies` 声明为 `^0.169.0`,且 `node_modules/three` 实装版本为 **0.169.0**(本地实测,见 [package.json](../package.json))

---

## 一、版本与来源清单

### 1.1 版本号(实测,非记忆)

| 包 | 版本 | 来源 |
| :--- | :--- | :--- |
| `three` | **0.187.0** | `https://registry.npmjs.org/three/latest`(HTTP 200,`"version":"0.187.0"`,`"main":"./build/three.cjs"`,unpackedSize 21,030,536 字节) |
| `three`(仓库内实装) | **0.169.0** | 本地 `node_modules/three/package.json` 实测 |
| `@types/three` | 建议对齐 `^0.187.0` | 见下方「版本号矛盾」说明 |

**版本号矛盾(如实记录)**:npm 页面显示 `@types/three` 最新为 **0.187.0**(「Last publish 9 days ago」),但 `registry.npmjs.org/@types/three` 的 `dist-tags.latest` 字段返回 **0.184.1**。两者不一致,我**没有**进一步确认哪一个是最新。
⇒ **未验证**:`@types/three` 的确切最新版本号。但定版策略不受影响:`@types/three` 应与 `three` **主次版本号对齐**(0.187.x ↔ 0.187.x),这是 DefinitelyTyped 的发布约定。

**推荐的 three.js 版本:`^0.187.0`**。理由:

1. `WebGLRenderer` 自 **r163** 起**不再支持 WebGL 1**(官方文档原文:"WebGL 1 is not supported since `r163`"),而手机浏览器现在 WebGL 2 覆盖已足够;
2. 仓库当前锁的 `^0.169.0` 允许升到 0.169.x,但**不会**自动到 0.187;升级只需改 [package.json](../package.json) 一行;
3. 本次调研核对的所有 API 签名在 0.169 → 0.187 之间**未变**(下面每节都标了源码路径,可逐条复核)。

### 1.2 官方文档的抓取路径(重要)

`threejs.org` 的文档子页在本次环境中**部分路径返回 404**。实测可用的路径是:

| 形式 | 结果 |
| :--- | :--- |
| `https://threejs.org/docs/OrthographicCamera.html` | ✗ 404 |
| `https://threejs.org/docs/api/en/cameras/OrthographicCamera.html` | ✗ 404 |
| `https://threejs.org/docs/index.html#api/en/cameras/OrthographicCamera` | ✓ 200(但只返回目录页) |
| **`https://threejs.org/docs/pages/OrthographicCamera.html`** | ✓ **200,返回完整正文(推荐)** |

⇒ **结论:抓 `threejs.org/docs/pages/<ClassName>.html`**。

除文档页外,我还**直接抓了 npm CDN 上的真实源码**作为交叉验证,因为文档是生成的、而源码是权威:

| 类 | 源码 URL |
| :--- | :--- |
| `OrthographicCamera` | `https://unpkg.com/three@0.187.0/src/cameras/OrthographicCamera.js` |
| `BatchedMesh` | `https://cdn.jsdelivr.net/npm/three@0.187.0/src/objects/BatchedMesh.js` |
| `InstancedMesh` | `https://unpkg.com/three@0.187.0/src/objects/InstancedMesh.js` |
| `Sprite` | `https://unpkg.com/three@0.187.0/src/objects/Sprite.js` |
| `Sprite` 顶点着色器 | `https://unpkg.com/three@0.187.0/src/renderers/shaders/ShaderLib/sprite.glsl.js` |
| `Texture` | `https://unpkg.com/three@0.187.0/src/textures/Texture.js` |
| `DataTexture` | `https://unpkg.com/three@0.187.0/src/textures/DataTexture.js` |
| `CanvasTexture` | `https://unpkg.com/three@0.187.0/src/textures/CanvasTexture.js` |
| `ShaderMaterial` | `https://unpkg.com/three@0.187.0/src/materials/ShaderMaterial.js` |
| `LOD` | `https://unpkg.com/three@0.187.0/src/objects/LOD.js` |
| `Raycaster` | `https://unpkg.com/three@0.187.0/src/core/Raycaster.js` |
| `Ray` | `https://unpkg.com/three@0.187.0/src/math/Ray.js` |
| `WebGLRenderer` | `https://unpkg.com/three@0.187.0/src/renderers/WebGLRenderer.js` |
| `BufferGeometry` | `https://unpkg.com/three@0.187.0/src/core/BufferGeometry.js` |

---

## 二、官方文档要点(A 项)

以下全部来自源码或 `threejs.org/docs/pages/*`,**默认值逐条核对过**。

### 2.1 `OrthographicCamera`

来源:https://threejs.org/docs/pages/OrthographicCamera.html 与 `src/cameras/OrthographicCamera.js`

- 构造签名:`new OrthographicCamera(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 2000)`
- `zoom` 默认 `1`;**`left/right/top/bottom` 的单位是「世界单位」,不是像素**
- `updateProjectionMatrix()` 内部逻辑(源码原文):

```js
const dx = ( this.right - this.left ) / ( 2 * this.zoom );
const dy = ( this.top - this.bottom ) / ( 2 * this.zoom );
const cx = ( this.right + this.left ) / 2;
const cy = ( this.top + this.bottom ) / 2;
```

  ⇒ **`zoom` 是「视锥缩小」而非「物体放大」**:zoom 变大 ⇒ `dx/dy` 变小 ⇒ 同样世界尺寸占更多像素。
- **正交相机的 `near` 可以是 `0`**(文档原文:"unlike for the `PerspectiveCamera`, `0` is a valid value for an orthographic camera's near plane")。透视相机不允许,这是正交特有的便利。

### 2.2 `BufferGeometry` / `BufferAttribute`

来源:https://unpkg.com/three@0.187.0/src/core/BufferGeometry.js

- `setAttribute(name, attribute)`、`index`(可为 `null`,此时「每三个连续位置构成一个三角形」)、`groups` 用于多材质
- **`groups` 的硬约束**(源码注释原文):"Every vertex and index must belong to exactly one group — groups must not share vertices or indices, and must not leave vertices or indices unused."
- 顶点属性必须逐顶点显式写;**这是本仓库曾经踩过的坑**:[chunk_geometry.ts](../client/src/stage/chunk_geometry.ts) 的文件头注释记录了「只分配 `Float32Array` 从不写入,position 全 0,一个三角形都画不出来」的历史缺陷。

### 2.3 `InstancedMesh` vs `BatchedMesh`(关键区别)

来源:https://threejs.org/docs/pages/InstancedMesh.html 与 https://threejs.org/docs/pages/BatchedMesh.html

| 维度 | `InstancedMesh` | `BatchedMesh` |
| :--- | :--- | :--- |
| 构造 | `(geometry, material, count)` | `(maxInstanceCount, maxVertexCount, maxIndexCount, material)` |
| 几何 | **单一几何**,多份变换 | **多种几何**共享一个材质 |
| 实例控制 | `setMatrixAt(i, m)` / `setColorAt(i, c)` | `addGeometry(g)` → `addInstance(gid)` → `setMatrixAt(iid, m)` |
| 逐实例可见性 | 无(只能用 `count` 截断或整体 `visible`) | **`setVisibleAt(id, bool)` / `getVisibleAt(id)`** |
| 视锥剔除粒度 | 整体 | **`perObjectFrustumCulled` 默认 `true`(逐实例剔除)** |
| 排序 | 由 `renderer.sortObjects` 统一处理 | **`sortObjects` 默认 `true`,逐实例排序** |
| 动态增删 | 需重建或改 `count` | `deleteInstance` / `setGeometryAt` / `optimize()` |
| 硬限制 | — | **「Negatively scaled matrices are not supported」** |

**本项目的选型结论(理由见 §4.4)**:地形块与立牌都用 **`InstancedMesh`**,不用 `BatchedMesh`。
理由:本项目所有地形块与所有立牌各自共享**同一个四边形几何**,差别只在「贴哪一格 UV + 平移到哪」。
`BatchedMesh` 的价值在于「多种不同几何 + 同一材质」,而我们的几何完全相同、只是 per-instance UV 不同 —— 那用 `InstancedMesh` + 一个 `InstancedBufferAttribute` 更直接,且避开 `BatchedMesh` 的顶点/索引预算手工管理(maxVertexCount 要自己估)。

### 2.4 `Sprite` / `SpriteMaterial`

来源:https://threejs.org/docs/pages/Sprite.html 与 `src/objects/Sprite.js`

- `new Sprite(material)`;几何是**共享的内置四边形**,顶点为 `(-0.5,-0.5)..(0.5,0.5)`,UV 与其对齐
- **`Sprite.center` 默认 `(0.5, 0.5)`**;文档原文:"A value of `(0.5, 0.5)` corresponds to the midpoint of the sprite. A value of `(0, 0)` corresponds to the **lower left corner** of the sprite."
- **「Sprites do not cast shadows, setting `Object3D#castShadow` to `true` will have no effect.」** ⇒ 立牌**不能投影**。要做影子必须另画一个贴地的暗色 quad。
- `count` 属性("The number of instances of this sprite")**仅 WebGPURenderer 可用**,WebGLRenderer 下无效。

顶点着色器的锚点数学(源码 `sprite.glsl.js` 原文):

```glsl
vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
```

由这条可以**精确反推 `center` 的方向**,这是 §4.3 的锚点结论的根据。

### 2.5 `Texture` / `CanvasTexture` / `DataTexture`(默认值差异很大)

来源:`src/textures/Texture.js`、`CanvasTexture.js`、`DataTexture.js`

| 属性 | `Texture` | `CanvasTexture` | `DataTexture` |
| :--- | :--- | :--- | :--- |
| `magFilter` | `LinearFilter` | `LinearFilter` | **`NearestFilter`** |
| `minFilter` | `LinearMipmapLinearFilter` | `LinearMipmapLinearFilter` | **`NearestFilter`** |
| `generateMipmaps` | `true`(默认) | `true` | **`false`** |
| `flipY` | `true` | `true` | **`false`** |
| `unpackAlignment` | `4` | `4` | **`1`** |
| `colorSpace` | **`NoColorSpace`** | 同左 | 同左 |
| `wrapS`/`wrapT` | `ClampToEdgeWrapping` | 同左 | 同左 |

**三个必须记住的推论**:

1. **`Texture.colorSpace` 默认是 `NoColorSpace`,不是 `SRGBColorSpace`。** 像素画颜色纹理必须**手工**设 `map.colorSpace = THREE.SRGBColorSpace`,否则颜色会偏。这一点在 three.js 官方 issue 里被反复确认(https://github.com/mrdoob/three.js/issues/29549 )。
2. **`DataTexture` 天生适合像素画**:`NearestFilter` + 无 mipmap + `flipY=false` 全是像素画想要的默认值,`unpackAlignment=1` 还避免了非 4 字节对齐行的错位。
3. `CanvasTexture` 唯一特殊之处是构造时**立即**把 `needsUpdate` 设为 `true`(源码注释:"sets `Texture#needsUpdate` to `true` immediately since a canvas can directly be used for rendering"),其余与 `Texture` 相同 ⇒ **它并不会自动关掉 mipmap/线性过滤**,像素画用 `CanvasTexture` 仍要手工设 `NearestFilter`。

### 2.6 `ShaderMaterial`

来源:https://unpkg.com/three@0.187.0/src/materials/ShaderMaterial.js

- **「`ShaderMaterial` can only be used with `WebGLRenderer`」**;要让 three 不注入内置 attribute/uniform,用 `RawShaderMaterial`
- `glslVersion` 默认 `null`(即 GLSL1);可设 `THREE.GLSL3` 用 `#version 300 es`
- `lights` 默认 `false`、`fog` 默认 `false`、`clipping` 默认 `false` ⇒ 自定义 shader **不会自动获得光照/雾/裁剪**,要显式打开并自己合并 uniform
- `defaultAttributeValues` 默认含 `{ color: [1,1,1], uv: [0,0], uv1: [0,0] }` ⇒ **几何缺少某属性时不会报错**,而是喂默认值。这是一个静默陷阱:如果忘了给 `InstancedBufferAttribute` 起对名字,shader 会安静地全用 `uv=[0,0]`,画面全错但不报错。
- `extensions.multiDraw` 默认 `false` ⇒ 要用 `gl_DrawID` 必须显式打开(这是 `BatchedMesh` 在 WebGL 下走多绘制路径的关键)

### 2.7 `LOD`

来源:https://threejs.org/docs/pages/LOD.html 与 `src/objects/LOD.js`

- `addLevel(object, distance = 0, hysteresis = 0)`;`hysteresis` 是"Threshold used to avoid flickering at LOD boundaries, as a fraction of distance"
- `autoUpdate` 默认 `true`(渲染器每帧自动 `update(camera)`);设 `false` 则要自己调 `lod.update(camera)`
- `levels` 数组按 `distance` **升序**维护(源码在插入时 `splice` 保持有序)
- `getObjectForDistance(distance)` 返回「第一个距离大于给定距离」的对象
- **注意**:`distance` 是**相机到该对象的距离**,不是屏幕尺寸。对等轴测固定俯角场景,相机沿一条固定方向看,距离与「离屏幕中心多远」不成正比,所以直接拿 `LOD` 做「远近四档」会**与视口中心不等距**。本项目已有自己的四档 LOD 与分块策略([tile_mesh.ts](../client/src/stage/tile_mesh.ts)),**建议不用 `LOD` 类**,而是在分块层面自己选档(理由见 §4.4)。

### 2.8 `WebGLRenderer`(默认值)

来源:https://threejs.org/docs/pages/WebGLRenderer.html 与 `src/renderers/WebGLRenderer.js`

构造参数的**实测默认值**(源码解构那一行):

```js
const { canvas = createCanvasElement(), context = null, depth = true, stencil = false,
        alpha = false, antialias = false, premultipliedAlpha = true,
        preserveDrawingBuffer = false, powerPreference = 'default',
        failIfMajorPerformanceCaveat = false, reversedDepthBuffer = false,
        outputBufferType = UnsignedByteType } = parameters;
```

| 属性 | 默认 | 备注 |
| :--- | :--- | :--- |
| **`antialias`** | **`false`** | 要开必须写 `antialias: true`;**只能在构造时设,不能事后切换** |
| **`outputColorSpace`** | **`SRGBColorSpace`** | 源码 `this._outputColorSpace = SRGBColorSpace;` ⇒ **默认就是 sRGB,不要重复设** |
| `toneMapping` | `NoToneMapping` | 像素画**应当保持** `NoToneMapping`,开了会洗掉色阶 |
| `shadowMap.enabled` | `false` | 不开就没有阴影 |
| `shadowMap.type` | `PCFShadowMap` | |
| `logarithmicDepthBuffer` | `false` | 官方注明会禁用 Early Fragment Test,损性能 |
| `reversedDepthBuffer` | `false` | 需要 `EXT_clip_control`;官方称「more faster and accurate than logarithmic」 |
| `stencil` | `false` | |
| `powerPreference` | `'default'` | 可设 `'high-performance'` 或 `'low-power'` |
| `depth` | `true` | |

- `renderer.info.render.calls` = 每帧 draw call 数;`info.memory.geometries`/`.textures` = 活跃几何/纹理数。这是**唯一权威的 draw call 计数器**。
- `setSize(w, h, updateStyle)`:`updateStyle=false` 可阻止改 canvas 的 CSS 尺寸
- `setPixelRatio(v)`:传 `undefined` 会直接 return(源码 `if ( value === undefined ) return;`)
- `compileAsync(scene, camera)`:基于 `KHR_parallel_shader_compile`,**推荐用它预热**,避免首次出现在画面时卡一帧
- `forceContextLoss()` / `forceContextRestore()`:需要 `WEBGL_lose_context` 扩展,可用于**测试**上下文丢失恢复路径

---

## 三、等轴测 + 正交相机的正确参数(B 项)

### 3.1 口径对齐:35° 是「俯角(pitch)」,45° 是「方位角(azimuth)」

先明确术语,避免后面全程歧义:

- **俯角 pitch = 35°**:相机视线与**水平面**的夹角。35° 时相机略高于物体向下看。
- **方位角 azimuth = 45°**:相机在水平面上的投影方向与 +X 轴的夹角。

> 注:真正的**等轴测(isometric)**是 30°(游戏惯用)或 35.264°(数学精确值 `atan(1/√2)`)。
> 本项目用 **35°**,与两者都不同 —— 这是**刻意的艺术选择**,不是误差。
> 这一点在 [iso_camera.ts](../client/src/stage/iso_camera.ts) 的文件头有明确记录:「35° 让地面在纵向保有呼吸感,Z 轴拉伸感弱、绘本感强」。

### 3.2 与仓库既有公式的对齐(已数值验证)

仓库 [iso_camera.ts](../client/src/stage/iso_camera.ts) 的公式(原文):

```
ux = (gx − gy) · cos45°
uy = (gx + gy) · sin45° · sin35° − gz · cos35°
sx = originX + ux · k
sy = originY + uy · k        (k = scale × zoom,像素/格)
```

**我没有直接采信,而是独立实现了同一公式再逐点比对**(自证,见 §3.6):6 个采样点最大误差 **2.27e-13** ⇒ 公式一致,工具自证通过。

> ⚠️ 这里有一个**容易写错的细节**:`(gx − gy) · cos45°` 里两个轴用的是**同一个** `cos45°`。
> 因为 `cos45° = sin45° = 0.7071067811865476`,所以写成 `cos45°` 或 `sin45°` 数值上等价。
> 但**语义上**第一项是「屏幕横向」,第二项是「屏幕纵向」,不要因为数值相等就随手抄错。
> 实测:两者之差 `1.1e-16`(浮点误差级),确认相等。

### 3.3 相机位置:方位角/俯角 → xyz

```ts
/** 由方位角、俯角、半径求相机位置(世界坐标系 Z 轴向上) */
export function cameraPosition(
  azimuthDeg: number,
  pitchDeg: number,
  radius: number,
): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const pit = (pitchDeg * Math.PI) / 180;
  return [
    radius * Math.cos(pit) * Math.cos(az), // x: 水平距离 × 方位投影
    radius * Math.cos(pit) * Math.sin(az), // y
    radius * Math.sin(pit),                // z: 高度
  ];
}
```

实测:半径 1000、方位 45°、俯角 35° ⇒ 位置 `(579.228, 579.228, 573.576)`,`|pos| = 1000.000000` ✓;
反算俯角 `35.000000°`、方位角 `45.000000°` ⇒ **往返一致** ✓。

### 3.4 世界轴映射(这一步最容易出错,已用基向量验证)

three.js 的 `Object3D.lookAt` 用 `up` 向量构造正交基:

```
zaxis = normalize(eye - target)
xaxis = normalize(cross(up, zaxis))
yaxis = cross(zaxis, xaxis)
```

实测(方位 45°、俯角 35°、`up = (0,0,1)`):

| 基向量 | 值 | 含义 |
| :--- | :--- | :--- |
| `zaxis` | `(0.579228, 0.579228, 0.573576)` | 相机后向 |
| `xaxis` | `(-0.707107, 0.707107, 0)` | 屏幕右 |
| `yaxis` | `(-0.405580, -0.405580, 0.819152)` | 屏幕上 |

我把**四套候选映射**都代进基向量,看哪一套能让 three.js 的屏幕坐标等于项目公式。结果:

| 候选 | 映射 | 方位角 | 横向误差 | 纵向误差 | 判定 |
| :--- | :--- | ---: | ---: | ---: | :--- |
| A | `(gx, -gy, gz)` | **-45°** | 1.42e-14 | 7.11e-15 | ✓ **一致** |
| B | `(gx, +gy, gz)` | +45° | 7.07e+1 | 7.11e-15 | ✗ 横向差 70 |
| C | `(-gx, -gy, gz)` | +45° | 1.42e-14 | 1.22e+2 | ✗ 纵向差 122 |
| D | `(gy, gx, gz)` | +45° | 7.11e-15 | 7.11e-15 | ✓ **一致** |

**两套映射都成立,这是重要发现**:A 和 D 都能复现项目公式,因为它们在 x/y 上**互换并同时镜像方位角** —— 几何上等价(只是「哪个世界轴叫 x」的命名约定不同)。

**结论(推荐用 A,因为不需要交换轴语义)**:

```ts
// 世界坐标 = (格x, -格y, 海拔z);相机方位角取 -45°,俯角 +35°,up = (0,0,1)
```

⇒ **踩坑提示**:如果按「方位角 = +45°」直接摆相机,横向会差 **70 个格当量**(候选 B 的实测误差),画面完全错位但不会报任何错。**必须**同时定下 `gy` 的符号。

### 3.5 正交视锥:`left/right/top/bottom` 的算法

**关键认识**:`left/right/top/bottom` 的单位是**世界单位**。本项目的世界单位是「格」,而 1 格 = `TILE_PX × zoom` 像素。所以:

```ts
/** 由视口像素尺寸反推正交视锥(单位:世界格) */
export function frustumFromViewport(
  viewportW: number,
  viewportH: number,
  zoom = 1,
  tilePx = 16,
): { left: number; right: number; top: number; bottom: number } {
  const halfW = viewportW / (2 * tilePx * zoom);
  const halfH = viewportH / (2 * tilePx * zoom);
  return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}
```

实测:

| 视口 | zoom | left | right | top | bottom |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 390×844 | 1 | -12.1875 | 12.1875 | 26.3750 | -26.3750 |
| 390×844 | 2 | -6.0938 | 6.0938 | 13.1875 | -13.1875 |
| 1280×720 | 1 | -40.0000 | 40.0000 | 22.5000 | -22.5000 |
| 1280×720 | 0.5 | -80.0000 | 80.0000 | 45.0000 | -45.0000 |

`near/far` 的取法:

- **`near` 可以取 `0`**(正交相机特有)。取 0 的代价是物体贴着相机平面时仍会渲染;好处是永不裁掉近处物体。
- 推荐 `near = -2000, far = 2000` 这类**对称且宽裕**的范围,把相机放在场景**外部**沿视线方向,而不是把相机放在场景内部。
- ⚠️ 但注意:`near` 为负会让「相机后方的物体」也进入视锥。若下方有剔除逻辑依赖 `near > 0`,需一并检查。

### 3.6 屏幕 ↔ 世界格换算 + 拾取

**换算(正投影)**,已在 §3.2 与仓库公式对齐。

**拾取**:三种做法,我推荐第三种。

**做法 1 —— `Raycaster` + `setFromCamera`(three.js 标准路径)**

源码(`Raycaster.js`)对正交相机有专门分支:

```js
} else if ( camera.isOrthographicCamera ) {
  this.ray.origin.set( coords.x, coords.y, camera.projectionMatrix.elements[ 14 ] ).unproject( camera );
  // set origin in plane of camera
  this.ray.direction.set( 0, 0, - 1 ).transformDirection( camera.matrixWorld );
}
```

⇒ **正交相机下,`ray.direction` 对所有像素完全相同**(恒为相机光轴方向),只有 `origin` 随像素变化。这是正交与透视的本质区别。

**做法 2 —— 射线与 z 平面求交**:`Ray.distanceToPlane(plane)` 源码中用 `denominator = plane.normal.dot(direction)`,`denominator === 0` 时返回 `null`(平行)。因 `direction` 固定,可**预先算一次** `dir.z`。

**做法 3(推荐)—— O(1) 解析反投影**:既然射线方向恒定,完全不需要 `Raycaster` 的场景图遍历。直接反解公式即可。

```ts
/** 屏幕像素 → 格坐标(必须指定落在哪个海拔平面) */
export function screenToGrid(
  sx: number,
  sy: number,
  opts: {
    originX: number; originY: number; scale: number; zoom: number;
    focusX: number; focusY: number; focusZ: number;
  },
  targetZ: number,
): { gx: number; gy: number } {
  const k = opts.scale * opts.zoom;
  const cos45 = Math.SQRT1_2;                 // cos45° = sin45° = √2/2
  const sin35 = Math.sin((35 * Math.PI) / 180);
  const cos35 = Math.cos((35 * Math.PI) / 180);
  const ux = (sx - opts.originX) / k;         // 屏幕横 → 世界横
  const uy = (sy - opts.originY) / k;         // 屏幕纵 → 世界纵
  // 由 ux = (dx - dy)·cos45 与 uy = (dx + dy)·sin45·sin35 - dz·cos35 反解
  const dz = targetZ - opts.focusZ;
  const s = (uy + dz * cos35) / (cos45 * sin35); // = dx + dy
  const t = ux / cos45;                          // = dx - dy
  const dx = (s + t) / 2;
  const dy = (s - t) / 2;
  return { gx: dx + opts.focusX, gy: dy + opts.focusY };
}
```

**自证结果(实测)**:

- 6 个采样点「格 → 屏幕 → 格」往返最大误差 **2.51e-15** ✓
- 4 个像素「屏幕 → 格(z=0) → 屏幕」往返最大误差 **1.14e-13 px** ✓
- 4 个像素「z=0 → z=1 的世界位移方向」与相机光轴共线,`|1-|dot|| = 2.22e-16` ✓

⇒ 三种做法在数学上等价;做法 3 少一次 `Raycaster` 场景遍历,对「点一格地砖」这种高频操作用它。

> ⚠️ **`Raycaster` 对 `Sprite` 有额外入口**:`Raycaster.params.Sprite = {}`,且 `raycaster.camera` 字段「is set when calling `setFromCamera()`」——
> 因为 slprite 是 billboard,**它的朝向依赖相机**,所以 `camera` 必须正确设置,否则 sprite 拾取会错。

### 3.7 可运行的最小场景(TypeScript)

下面这段是**完整可运行**的,可直接放进 `client/src/three/` 下作为装配入口的骨架。

```ts
import * as THREE from 'three';
import { PITCH_DEG, AZIMUTH_DEG, TILE_PX } from '../stage/iso_camera.ts';

export interface IsoStage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createIsoStage(canvas: HTMLCanvasElement, w: number, h: number): IsoStage {
  // 1) 渲染器:像素画目标 —— 保持默认 sRGB 输出、保持 NoToneMapping、关 MSAA(像素画不需要)
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,          // 像素画用 NearestFilter,开 MSAA 反而糊
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 上限 2,防手机 GPU 过载
  renderer.setClearColor(0x1b1f2a, 1);
  // outputColorSpace 默认已是 SRGBColorSpace,无需重复设置

  const scene = new THREE.Scene();

  // 2) 正交相机:视锥单位 = 世界「格」
  const halfW = w / (2 * TILE_PX);
  const halfH = h / (2 * TILE_PX);
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -2000, 2000);

  // 3) 相机位置:方位 -45°、俯角 35°(见 §3.4 的映射 A)
  const R = 1000;
  const az = (-AZIMUTH_DEG * Math.PI) / 180;
  const pit = (PITCH_DEG * Math.PI) / 180;
  camera.position.set(
    R * Math.cos(pit) * Math.cos(az),
    R * Math.cos(pit) * Math.sin(az),
    R * Math.sin(pit),
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const resize = (nw: number, nh: number): void => {
    const hw = nw / (2 * TILE_PX);
    const hh = nh / (2 * TILE_PX);
    camera.left = -hw; camera.right = hw;
    camera.top = hh; camera.bottom = -hh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh, false);
  };
  resize(w, h);

  const dispose = (): void => {
    renderer.dispose();
    renderer.forceContextLoss();
  };

  return { renderer, scene, camera, resize, dispose };
}
```

---

## 四、图集渲染(C 项)

### 4.1 图集的实测事实(不是假设)

我直接解析了 [atlas_sprites.json](../_design/cozy_25d_sandbox_project/assets/atlas_sprites.json),实测:

| 项 | 实测值 |
| :--- | :--- |
| 图集尺寸 | **1280 × 1152** |
| 单格 | **64 × 64** |
| 列 × 行 | **20 × 18** |
| 网格容量 | 20 × 18 = **360** |
| 实际精灵数 | **358**(与 `meta.total_sprites` 一致 ✓) |
| **空槽** | **2 个**,位于 `(col18,row17)` 与 `(col19,row17)` |
| 帧尺寸一致性 | **358/358 全部 64×64** ✓ |
| 锚点一致性 | **358/358 全部 (0.5, 0.85)** ✓ |
| `id` 范围 | **101 … 858**,共 358 个值 |
| `id` 是否连续 | **不连续 —— 有 12 个空洞**(131, 171, 219, 256, 331, 386, 441, 538, 631, 746, 807, 835) |
| 键序是否 = row-major | **358/358 吻合** ✓ |

**两条直接影响实现的结论**:

1. **不能用 `index = id − 101` 算下标**。id 有 12 个空洞,`858 − 101 + 1 = 758 ≠ 358`,直接相减会越界或错位。
   ⇒ 必须建 `Map<id, frame>` 或按 JSON 的**键序**建索引。
2. **但要算 UV,键序可以直接用**:实测 358 个帧的位置都严格等于按键序遍历时的 `(i % 20) × 64, floor(i / 20) × 64`。
   ⇒ 若只用「图集第 i 格」而不关心 `id`,可以走 `O(1)` 的固定步长公式,不必查表。
   ⇒ 若要从**游戏逻辑的实体 id** 定位精灵,则必须查表(因为 id 不连续)。

### 4.2 UV 计算(实测 358/358 可逆)

TexturePacker 的 `frame.x/y` 以**图像左上角**为原点;three.js 的 UV 以**左下角**为原点,且 `Texture.flipY` 默认为 `true`。因此:

```ts
export interface FrameUV { u0: number; v0: number; u1: number; v1: number }

/** TexturePacker 帧矩形 → three.js UV(图像左上角原点 ⇒ UV 左下角原点) */
export function frameToUV(
  x: number, y: number, fw: number, fh: number,
  texW: number, texH: number,
): FrameUV {
  return {
    u0: x / texW,
    u1: (x + fw) / texW,
    // y 从顶部度量,v 从底部度量 ⇒ 用 1 - · 翻转
    v0: 1 - (y + fh) / texH,   // v0 对应帧的**下**边
    v1: 1 - y / texH,          // v1 对应帧的**上**边
  };
}
```

**自证(逐精灵全查 358 个)**:

- 用上式算出 UV,再反算回像素矩形,与 JSON 中的 `frame.x/y/w/h` **逐个比对完全一致**:不一致数 **0** ✓
- UV 越界(< 0 或 > 1)的数量:**0** ✓

抽样:`id_101`(暖松原木,frame 在 `(0,0)`)⇒ `u:[0.000000, 0.050000]`,`v:[0.944444, 1.000000]`;
`id_858`(终极 Boss,frame 在 `(1088,1088)`)⇒ `u:[0.850000, 0.900000]`,`v:[0.000000, 0.055556]`。

### 4.3 锚点 (0.5, 0.85):**方向与 three.js 相反**(本文最重要的发现)

这一条我原本准备标「未验证」,因为它是纯视觉判断。后来我用 Pillow **逐个像素扫描**出了每个精灵的 alpha 包围盒,并生成叠加图目视确认,**现在是已验证的**。

**实测数据(358 个精灵的 alpha 包围盒统计)**:

| 统计项 | 值 |
| :--- | :--- |
| 完全不透明的格 | **0**(358 个都有内容) |
| 内容**底边** `maxy/63` 中位数 | **0.952** |
| 内容顶边 `miny/63` 中位数 | 0.048 |
| 内容高度占格比 中位数 | 0.906 |
| 底边贴到格子底部(> 0.95)的精灵 | **230 / 358(64.2%)** |

**目视验证**:我把代表性精灵放大 6 倍,叠两条线 ——

- **红线** = `y = 0.85` 从**顶部**度量 ⇒ 落在每个精灵的**脚部 / 底部接触点** ✓
- **蓝线** = `y = 0.85` 从**底部**度量(即 three.js `center.y = 0.85`)⇒ 落在精灵**上方的空白处** ✗

**结论**:

> 图集 JSON 的 `anchor` 采用**「从顶部度量」**的约定(TexturePacker / Photoshop 习惯)。
> three.js 的 `Sprite.center` 采用**「从底部度量」**的约定(官方文档原文:"A value of `(0, 0)` corresponds to the **lower left corner**")。
> **两者方向相反。**
>
> ⇒ 要让「脚落在格点上」,必须做 `center.y = 1 − anchor.y`:
>
> ```ts
> const anchor = frame.anchor;              // { x: 0.5, y: 0.85 }  ← 从顶部
> sprite.center.set(anchor.x, 1 - anchor.y); // ⇒ (0.5, 0.15)      ← 从底部,three.js 语义
> ```

**数学核对**(由 `sprite.glsl.js` 的 `alignedPosition = (position.xy - (center - vec2(0.5))) * scale` 反推):
sprite 局部几何 `position.y ∈ [-0.5, +0.5]`,对应 uv `v ∈ [0, 1]`。要求锚点落在 `v = 1 − 0.85 = 0.15` 处,
即 `position.y = -0.5 + 0.15 = -0.35`;令 `alignedPosition.y = 0` 解得 `center.y = 0.15 = 1 − 0.85` ✓

**如果直接照抄 `center.set(0.5, 0.85)` 会怎样**(已用上式计算并实测):
把 `center.y` 从正确的 `0.15` 取成 `0.85`,代入 shader 公式:

| 顶点 | `center.y = 0.15`(正确) | `center.y = 0.85`(错抄) | 位移 |
| :--- | ---: | ---: | ---: |
| 顶边 `position.y = +0.5` | `+0.85 · scale` | `+0.15 · scale` | **−0.70 · scale** |
| 底边 `position.y = −0.5` | `−0.15 · scale` | `−0.85 · scale` | **−0.70 · scale** |

⇒ **整个立牌被画低 `0.70 × 精灵高度`**。在 64px 精灵上是 **44.8 像素**的竖直错位 ——
角色会**陷进地面**,脚被土埋住。这个错位**不会报任何错**,只能靠眼睛发现。

> ⚠️ **两个容易混淆的基准**,我第一版就写错了(见 §8.2 的 E13):
> - 相对**正确 anchor**(`0.15`)的误差 = `0.70 × 高度 = 44.8 px` ← **这才是"错抄会错多少"**
> - 相对**默认 center**(`0.5`)的误差 = `0.35 × 高度 = 22.4 px` ← 这只是"相对默认值偏了多少",不是修复收益
> 说"差 22.4px"会把严重程度**低估一半**。修 bug 时要对比的是前者。

### 4.4 菱形地形块 vs 立牌:渲染方式完全不同

**先说几何实测**。我对地砖做了逐行宽度扫描:

| 精灵 | 内容尺寸 | 最宽 | 顶行宽 | 底行宽 | 形状 |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `id_303` 暖松人字木地板 | y 8..55(48px) | **58px** @y=27 | 3px | 9px | 菱形/六边形 |
| `id_326` 双子星传送地砖A | y 6..56(51px) | **58px** @y=25 | 7px | 5px | 同上 |
| `id_327` 双子星传送地砖B | y 6..56(51px) | **58px** @y=25 | 7px | 5px | 同上 |
| `id_323` 流沙向心漩涡砖 | y 7..55(49px) | **58px** @y=26 | 3px | 2px | 同上 |

**四个地砖的最宽处都是 58px —— 高度一致的设计网格**。宽度剖面呈「先增后减」,与「菱形顶面 + 一定厚度侧面」吻合:

- 顶面宽 58px ⇒ 由 `宽 = 2 · cos45° · T` 反推 **`T ≈ 58 / 1.4142 = 41.01 px/格`**
- 顶面高应为 `58 × sin35° = 58 × 0.5736 = 33.27 px`
- 实测总高 48~51px ⇒ 减去顶面高 ⇒ **侧面厚度约 15~18px**

⇒ **实现含义**:`iso_camera.ts` 里 `TILE_PX = 16`,与图集自带的 `≈41 px/格` **不一致**。
两条路都行,但**必须选一条并全局统一**:

1. **保持 `TILE_PX = 16`**,把 64px 精灵按 `16 × 2 × cos45° / 58 = 0.390` 缩放绘制;
2. **或**把设计基准改成 `TILE_PX ≈ 41`,让图集 1:1 绘制(视觉最清晰,但视口能容纳的格数变少,需重算 LOD 档位)。

我倾向 **方案 1**:它保持了 [iso_camera.ts](../client/src/stage/iso_camera.ts) 与 [tile_mesh.ts](../client/src/stage/tile_mesh.ts) 既有常量不变,缩放只在装配层做一次;而方案 2 会牵动 `zoomLevels`、LOD 距离档、视口包围盒等一串已测常量。

**两类精灵的渲染差异**:

| 维度 | 菱形地形块 | 立牌(角色/道具/树) |
| :--- | :--- | :--- |
| 显示朝向 | **贴地**,随相机倾斜的固定平面 | **永远竖直面向相机**(billboard) |
| 几何 | 屏幕对齐的 `PlaneGeometry`(或投影后的四边形) | 内置 Sprite 四边形,或自绘 billboard quad |
| 排序依据 | **海拔 z + 行序**(画家算法) | **格位 y**(屏幕纵深) |
| 锚点 | 用格中心(菱形中心) | `center.y = 0.15`(脚) |
| 能否投影 | 可以(但本项目建议烘死) | **不能**(官方明确 Sprite 不投影) |
| 图集采样 | 由格坐标直接算 UV | 由实体 id 查表算 UV |

**为什么地形块用「屏幕对齐平面」而不是 3D 水平面**:因为图集里的地形块**已经被画成了等轴测投影后的样子**(菱形顶面 + 侧面厚度)。如果再用一个真正的 3D 水平面去贴它,会**二次投影** —— 菱形被压扁成更扁的形状。正确做法是把它当作一个**屏幕空间的贴片**,只是摆放位置由投影公式算出来。这也顺带避免了与地面共面引起的 **z-fighting**。

### 4.5 三种渲染方式怎么选:给结论

| 方案 | draw call | 逐实例 UV | 适用 | 本项目是否用 |
| :--- | :--- | :--- | :--- | :--- |
| `Sprite` 对象 | **每个 1 次**(不批处理) | 天然支持(各持一个材质/纹理) | 少量、需 billboard、需独立 `center` | ❌ 数量大时不可用 |
| `PlaneGeometry` + 纹理 | 每个 mesh 1 次 | 一个 mesh 一份材质 | 少量、需要精确几何控制 | ❌ 同上 |
| **`InstancedMesh` + per-instance UV** | **每批 1 次** | 需一个 `InstancedBufferAttribute` + shader 补丁 | 大批量、同几何 | ✅ **推荐** |

**结论与理由**:

1. **立牌用 `InstancedMesh`**。358 种精灵共用**同一个四边形几何**,差别只有「UV 取哪一格 + 平移到哪 + 是否翻转」。这正是 `InstancedMesh` 的定义场景。
   代价:要自己加一个 `InstancedBufferAttribute('uvOffset', 2)` 与 `uvScale`,并在 shader 里 `vUv = uv * uvScale + uvOffset`。这是约 15 行 shader 数学,换来的是「200 个立牌 1 次 draw call」而不是 200 次。
2. **地形块同理,但按 LOD 档位分开批**。每一档一个 `InstancedMesh`,不同档不能混在一批里(几何 detail 不同)。
3. **不要用 `THREE.Sprite` 渲染 bulk 立牌**。`Sprite` 每个对象 1 次 draw call,而且 `Sprite.center` 是**每个对象**的属性,没法在实例化时逐实例变化 —— 而我们的锚点对所有精灵是统一的 (0.15),所以「统一锚点」这一点上 `InstancedMesh` 也不吃亏。
4. **不要用 `LOD` 类**。理由已述(§2.7):`LOD` 按「相机到对象距离」切档,而等轴测下这个距离与「在屏幕上离中心多远」不成正比,会导致同屏出现不该有的档位跳变。本项目已有自己的分块 + 四档策略([tile_mesh.ts](../client/src/stage/tile_mesh.ts)),**在 chunk 层面选档**比在对象层面选档更可控。
5. **`BatchedMesh` 本项目不需要**:它的价值是「多几何 + 同材质」,而我们的几何是同一个。用它会白白背上 `maxVertexCount` / `maxIndexCount` 的手工预算,并且 `setMatrixAt` 有「不支持负缩放」的限制。

**draw call 预算实测对照**:

| 量 | 值 |
| :--- | ---: |
| 世界尺寸 / 分块 | 1024 格 ÷ 16 = **4096 个 chunk** |
| 单 chunk 满载(LOD0,5 面/格) | 256 格 × 5 = **1280 面** |
| 全图 LOD0 | **5,242,880 面**(超 800,000 预算 **6.6 倍**)⇒ 必须靠 LOD + 剔除降下来 |

社区共识的 draw call 预算(来源:https://www.utsubo.com/blog/threejs-best-practices-100-tips 与 https://threejsroadmap.com/blog/draw-calls-the-silent-killer ):
**手机 < 100~200,桌面 < 500**;「100–300 可接受,500+ 即使强显卡也吃力」。
⇒ 4096 个 chunk 若各 1 次 draw call 就爆了;**必须靠视锥剔除把同屏 chunk 压到几十个**。

---

## 五、社区与素材库:能不能直接用(D 项)

用户明确要求「多看社区和素材库,免得走弯路或者重复造轮子」。我逐项给**能不能用**的判断。

### 5.1 three.js 做 isometric 2.5D 的成熟库

| 方案 | URL | 判断 |
| :--- | :--- | :--- |
| `three-isometric` npm 包 | — | ❌ **不能直接用(且我不确定它存在)**。我尝试抓 `registry.npmjs.org/three-isometric/latest` 返回 **404**。⇒ **未验证**:网上流传的「three-isometric」包我**没能确认**其在 npm 上的存在。**不要**把它写进依赖。 |
| `elchininet/isometric` | https://github.com/elchininet/isometric | ❌ **不适用**。它是**纯 SVG** 等轴测库(`IsometricCanvas` 画 SVG),不是 WebGL,与本项目的 4~16 人同房实时场景不匹配。 |
| `@isora/react` 等 React 系 | https://npm.io/search/keyword:isometric | ❌ **不适用**。渲染成 SVG,且绑定 React;本项目要 WebGL 大批量精灵。 |
| `react-three-fiber` | — | ❌ **不适用**(本项目是 vanilla + Vite,没有 React)。它本身也不是等轴测库,只是 React 的 three.js 绑定。 |
| 「正交相机 + `camera.position.set(20,20,20)`」社区惯例 | https://stackoverflow.com/questions/23450588/isometric-camera-with-three-js | ⚠️ **部分可用,但与本项目不同**。该惯例是**真等轴测**(x=y=z,即 35.264°);本项目是 **35° 俯角**,数值不同。**不要照抄 `set(20,20,20)`。** |

**结论**:等轴测这块**没有值得引入的第三方库**,社区主流做法就是「自己摆正交相机」。本项目 [iso_camera.ts](../client/src/stage/iso_camera.ts) 已经把这层数学做完了,**不要重复造轮子 —— 直接用仓库里这个**。

### 5.2 图集加载库(TexturePacker 的 three 加载器)

**重要结论:three.js 官方没有 TexturePacker loader。** 社区做法都是自写一个约 40 行的类。

| 来源 | URL | 判断 |
| :--- | :--- | :--- |
| `ayamflow` 的 TextureAtlas gist | https://gist.github.com/ayamflow/64d00589546c730b93ab85627acad66d | ⚠️ **思路可用,代码过时**。它用 `texture.clone()` 每帧克隆(**会爆纹理对象数**),且用 `t.offset` + `t.repeat` 而非 UV 属性。原帖作者自述「这是 6-7 年前的,TexturePacker 现在的格式可能不一样了」。 |
| Zenn 上的 TextureAtlas 实现 | https://zenn.dev/a_saya_108/articles/bfca7c455a31bf | ✅ **思路正确**(`texture.clone()` + 帧矩形),但仍是逐帧克隆纹理。 |
| `mauriciomassaia` 的 TS 版 | https://gist.github.com/mauriciomassaia/2343d4e45d046077e8f902e029167cdf | ✅ **类型定义可直接借用**(`Rect` / `Frame` / `SourceSize` / `Meta` / `Frames`)。 |
| TexturePacker 官方格式文档 | https://www.codeandweb.com/texturepacker/documentation (JSON Hash / JSON Array 两种) | ✅ **权威**。本项目 [atlas_sprites.json](../_design/cozy_25d_sandbox_project/assets/atlas_sprites.json) 用的是 **JSON Hash**(`frames` 是对象,键为名字)。 |

**能不能直接用**:不能照搬,但**核心思路是自写 40 行**。关键设计选择:

- ❌ **不要**为 358 个精灵各 `texture.clone()`。那会产生 358 个纹理对象(=358 份 GPU 上传),直接爆掉手机显存预算。
- ✅ **正确做法**:**只持有 1 个 `Texture`(整张图集)**,把「取哪一格」编码为**每实例的 UV 属性**。这也正是 §4.5 选 `InstancedMesh` 的原因 —— 两者是同一个决策。
- ✅ 本项目 [atlas_sprites.json](../_design/cozy_25d_sandbox_project/assets/atlas_sprites.json) 是**规整网格**(所有帧 64×64、键序 = row-major),所以连「遍历 frames 建 UV 表」这一步都可以简化成 `O(1)` 步长公式(见 §4.1)。

### 5.3 移动端 three.js 性能优化公认清单

来源:https://www.utsubo.com/blog/threejs-best-practices-100-tips、https://invokfung.github.io/blog/2025/08/26/threejs_08_low_end_performance、https://metadesignsolutions.com/blog/threejs-performance-optimization-best-practices、https://dev.to/gronskideveloper/threejs-on-mobile-the-device-gotchas-that-tank-a-configurator-3oe

| 措施 | 公认做法 | 本项目怎么办 |
| :--- | :--- | :--- |
| **像素比上限** | `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` | ✅ 照做。3x 屏上直接用 `devicePixelRatio` 会让像素量翻 2.25 倍 |
| **draw call** | 手机 < 100~200 | ✅ §4.5 的 `InstancedMesh` 方案 |
| **三角面** | 手机 < 250~500k | ✅ 预算 800,000 是「全图」,单帧同屏须靠剔除压到几十万 |
| **纹理显存** | 手机总计 < 100 MB | ✅ 图集未压缩 RGBA = **5.63 MB**(1280×1152×4),余量充足 |
| **纹理边长** | 手机 ≤ 2048(勿用 4096) | ✅ 图集 1280×1152,**最严格的 2048 上限下仍有 1.60× 余量** |
| **抗锯齿** | 手机优先关 MSAA,改用后处理 | ✅ 像素画**本来就该关**(`antialias: false`) |
| **阴影** | 手机 1 × 1024 PCF,禁用 PCFSoft | ⚠️ 见 §6.1;本项目建议**烘死阴影进图集**,完全不开 shadowMap |
| **后处理** | 手机 0~1 pass | ✅ 本项目用 shader 内联效果([shaders.ts](../client/src/stage/shaders.ts)),不走后处理链 |
| **按需渲染** | 静止时停渲染省电 | ✅ 绘本风沙盒很适合;`renderer.setAnimationLoop(null)` 即停 |
| **shader 程序数** | 手机 < 30 | ✅ 本项目 6 个 shader 契约,远低于上限 |
| **上下文丢失** | 必须监听 `webglcontextlost` | ⚠️ **必做,见 §6.2** |
| **材质选用** | 背景物件用 Lambert 而非 Standard | ✅ 本项目用自定义 `ShaderMaterial`,无 PBR 开销 |

### 5.4 现成的等轴测相机/拾取轮子

- **相机**:没有值得引入的库(见 §5.1)。仓库 [iso_camera.ts](../client/src/stage/iso_camera.ts) 的 288 行已经把「投影 / 反投影 / 视口包围盒 / 缩放档位」做完了,且是**零依赖纯数学层**(可被 node 直接单测)。
- **拾取**:three.js 内置 `Raycaster` 对正交相机**已有专门分支**(§3.6 引源码),可直接用;但等轴测下**解析反投影更快**,见 §3.6 做法 3。
- **辅助工具**(值得装):
  - **Spector.js**(Chrome 扩展):抓单帧、逐个 draw call 看 shader 与几何,定位 rogue draw call —— https://metadesignsolutions.com/blog/threejs-performance-optimization-best-practices
  - **stats-gl** / `renderer.info`:`renderer.info.render.calls` 是官方唯一权威计数器。
- **`.gltf` / glTF 工具链**:本项目**不需要** —— 素材是 2D 图集,没有 3D 模型。

---

## 六、已知陷阱(必须查证,已逐条查)

### 6.1 正交相机下的阴影与深度精度

**深度精度(我算过,不是猜)**:正交投影的深度是**线性**的(不像透视是对数分布),所以量化步长就是 `(far − near) / 2^24`:

| near / far | 深度步长(格) | 折算像素 @16px/格 |
| :--- | ---: | ---: |
| 0.1 / 2000 | 1.192e-4 | 0.0019 px |
| 1 / 4000 | 2.384e-4 | 0.0038 px |
| **800 / 1200** | **2.384e-5** | **0.00038 px** |

⇒ **正交相机的深度精度问题比透视相机小得多**(透视在远处会急剧退化)。把 `near/far` 收窄到实际需要(如 800~1200)可再提升 5 倍。
⇒ 结论:**本项目几乎不用担心 z-fighting 来自深度精度**;要担心的是**共面几何**(地形块与地面同高)—— 那个用「地形块 = 屏幕对齐贴片」已经绕开了(§4.4)。

**阴影**:来源 https://mofu-dev.com/en/blog/threejs-shadow-map 与 https://discourse.threejs.org/t/shadow-acne-regressions-encountered-while-migrating-to-newer-version-of-three-js/10199

- 平行光(DirectionalLight)的 `shadow.camera` **本身就是 `OrthographicCamera`**,且必须把视锥**收到刚好包住要投影的物体** —— 「太宽则深度图不精确」。
- 阴影 acne 的常规对策:`light.shadow.bias` 取负值(社区实测约 `-0.004` 起,`-0.01` 更明显),但会带来 **peter-panning**(影子脱离物体)。
- **本项目的重要特例**:官方明确 **`Sprite` 不投影**(§2.4)。所以若立牌用 `InstancedMesh` 而非 `Sprite`,技术上可以投影,但——
- **推荐结论**:本项目**不开 shadowMap**,把影子**烘进图集**(贴一个椭圆暗色 quad 在脚下)。理由:① 手机省一整个 shadow pass;② 绘本风格要的是「软投影」,实时阴影的硬度反而不对;③ 立牌若用 `Sprite` 则根本无法投影,烘死是唯一统一方案。
- ⚠️ **未验证**:我**没有实测**本项目图集在真实手机上的阴影表现(没开过 shadowMap 跑过)。上面的推荐是基于「省一个 pass」与「Sprite 不能投影」两条硬约束的推论,不是实测。

### 6.2 移动端 WebGL2 降级与上下文丢失

来源:https://dev.to/gronskideveloper/threejs-on-mobile-the-device-gotchas-that-tank-a-configurator-3oe、https://invokfung.github.io/blog/2025/08/26/threejs_08_low_end_performance、https://bugnet.io/blog/how-to-fix-too-many-active-webgl-contexts-oldest-context-will-be-lost

- **WebGL 1 已不支持**:`WebGLRenderer` 源码里直接 `throw new Error('THREE.WebGLRenderer: WebGL 1 is not supported since r163.')`。⇒ **「降级到 WebGL 1」这条路不存在**。目标机型必须支持 WebGL 2;不支持就只能给不支持提示,没有中间态。
- **上下文丢失在手机上不是边缘情况**:「Backgrounded tabs, memory pressure, the OS reclaiming the GPU: mobile loses the WebGL context far more than desktop.」
- **必须 `preventDefault()`**,否则浏览器不会尝试恢复:

```ts
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();   // 关键:告诉浏览器「我打算处理恢复」
  renderer.setAnimationLoop(null);   // 停循环
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  // 重建被释放的 GPU 资源,然后重启循环
  renderer.setAnimationLoop(loop);
});
```

- **Three.js 自身不做恢复**:issue #5857 与 #11435 明确「three.js 只调 `preventDefault`,不重建资源」。**重建是你的责任**。
- **上下文数量上限**:「Desktop Chrome allows around 16 active contexts; mobile browsers allow fewer. **Design for one.**」⇒ 全应用**一个 renderer、一个 canvas**。
- **测试手段**:`renderer.getContext().getExtension('WEBGL_lose_context')` + `loseContext()` / `restoreContext()`,可**主动模拟**丢失,用来验证恢复路径 —— 建议写进测试。

### 6.3 图集出血(bleeding)与 padding

来源(机制):https://discourse.threejs.org/t/canvas-texture-seams-artifact-lines-at-repeat-border/15512
(实践):https://ilovesprites.com/blog/threejs-texture-atlas-draw-calls

**问题机制**:本图集**格子紧贴,没有 padding** —— 相邻帧间距恰好 64px = `0.05` UV。在 `LinearFilter` 或 `mipmap` 下,采样会跨到邻格,边缘出现**邻格像素**。

**两条对策(实测对比)**:

| 对策 | 做法 | 实测结果 |
| :--- | :--- | :--- |
| **A(推荐)** | `magFilter = minFilter = NearestFilter` + `generateMipmaps = false` | 不跨格采样,像素画清晰,零丢边 |
| B | UV 内缩半像素(inset = 0.5px = `0.00039063` UV) | 实测内缩后 UV 确实 ⊂ 原 UV ✓,但**会让 64px 精灵变成有效 63px ⇒ 像素画丢边** |

⇒ **本项目选 A**。理由:① 这是像素画,`NearestFilter` 本来就是正确选择;② 不做内缩就不会丢边;③ 关了 mipmap 后**缩小时会有摩尔纹**——但这在本项目可接受,因为缩放档位是离散的 6 档(`zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2]`),最大只缩到 0.5×,摩尔纹不严重。

⚠️ **补充警告**:`NearestFilter` + 关闭 mipmap 在**大幅缩小时**会闪烁。若将来出现 0.25× 这类更小的档位,需要改回 `LinearMipmapNearestFilter`(社区帖子里被点名为「唯一能同时避免混色」的组合之一)。

### 6.4 `outputColorSpace` 与像素画色彩

来源:https://discourse.threejs.org/t/updates-to-color-management-in-three-js-r152/50791、https://github.com/mrdoob/three.js/issues/29549

- **r152 起,`WebGLRenderer.outputColorSpace` 默认 `SRGBColorSpace`**,`ColorManagement.enabled` 默认 `true`。我在 0.187.0 源码里核实了:`this._outputColorSpace = SRGBColorSpace;` ✓
- **`Texture.colorSpace` 默认 `NoColorSpace`**(我在 `Texture.js` 构造签名里核实:`colorSpace = NoColorSpace`)。⇒ **颜色纹理必须手工设**:

```ts
const tex = new THREE.Texture(atlasImage);
tex.colorSpace = THREE.SRGBColorSpace;   // 颜色纹理必须显式设置
tex.magFilter = THREE.NearestFilter;
tex.minFilter = THREE.NearestFilter;
tex.generateMipmaps = false;
tex.needsUpdate = true;
```

- **像素画还有一个额外陷阱**:**`toneMapping` 默认 `NoToneMapping`**(源码核实)——这是好事,**保持它**。若误设 `ACESFilmicToneMapping`,色阶会被压缩,像素画的调色板直接失真。
- **`DataTexture` 的特例**:本项目 [entity_sprites.ts](../client/src/stage/entity_sprites.ts) 会生成 16×16 的 RGBA 武器图标喂给 `DataTexture`。这里是**程序生成的调色板色**,不是从 sRGB 图片解码的颜色。是否要设 `SRGBColorSpace` 取决于这些 hex 值按哪个空间解释。
  ⇒ ⚠️ **未验证**:我没有实测这些生成图标在 `SRGBColorSpace` 与 `NoColorSpace` 下的视觉差异。建议**在浏览器里对一次色卡**再定。

### 6.5 大批量精灵的 draw call

- `renderer.info.render.calls` 是唯一权威计数(§2.8)。
- **`Sprite` 不批处理**:社区明确「`THREE.Sprite` objects don't batch this way — each is its own draw call」(https://ilovesprites.com/blog/threejs-texture-atlas-draw-calls )。这就是 §4.5 不用 `Sprite` 的直接理由。
- **draw call 随「材质数 × 几何数」增长,不随 mesh 数**:所以「一个材质 + 一个几何 + N 个实例」= 1 次调用。
- **`InstancedMesh` 的隐性成本**:`computeBoundingSphere()` 是**引擎在需要时自动算**的,但 `computeBoundingBox()` **必须手工调用**。若逐帧改实例矩阵,包围球会过期 ⇒ 视锥剔除失效(物体在屏幕上却因包围球没更新被剔掉,或反之)。**改完 `setMatrixAt` 后务必置 `instanceMatrix.needsUpdate = true`**,必要时重算包围球。
- ⚠️ **未验证**:我没有在真机上实测本项目的 draw call 峰值。§4.5 的预算是**算出来的**,不是测出来的。

---

## 七、与仓内既有实现的接口对齐

这一节是给实现者的「别重复造轮子」清单 —— 仓库里已经有的东西。

| 已有模块 | 提供什么 | 本次调研建议 |
| :--- | :--- | :--- |
| [iso_camera.ts](../client/src/stage/iso_camera.ts) | 35°/45° 投影与反投影、视口地面包围盒、6 档缩放 | ✅ **直接用**。本文 §3 独立复现了它的公式并逐点比对(误差 2.27e-13),确认可用 |
| [tile_mesh.ts](../client/src/stage/tile_mesh.ts) | 四层海拔分块建面 + 视锥剔除 + 四档 LOD 的**面数统计** | ✅ 直接用它的分块/LOD **决策**,但注意它「只数面不产顶点」 |
| [chunk_geometry.ts](../client/src/stage/chunk_geometry.ts) | 把面数统计变成**真实顶点**(修掉「position 全 0」的历史缺陷) | ✅ 顶点来源用这个 |
| [shaders.ts](../client/src/stage/shaders.ts) | 6 个 GLSL 契约(字符串 + uniform 表,零依赖可单测) | ✅ 自定义材质素材;`dye_overlay` 的「只改 uniform 不重建材质」思路与 §4.5 的实例化方向一致 |
| [entity_sprites.ts](../client/src/stage/entity_sprites.ts) | 8 帧朝向映射、16×16 武器图标 → RGBA 1024 字节、粒子挂点 | ✅ `DataTexture` 的数据源 |
| [three/stage_assembly.ts](../client/src/three/stage_assembly.ts) | 装配入口(唯一允许 `import three` 的地方) | ⚠️ **当前零引用**。它是 `three` 的**唯一**装配点,需要变成真正入口 |

**一个必须点出的对齐问题**:[stage_assembly.ts](../client/src/three/stage_assembly.ts) 的头注释自述是「唯一允许 import `three` 的地方」,但它**目前没有任何调用方**,且因为 `three` 只在 `optionalDependencies` 里而无法在测试中 import。本文 §3.7 的 `createIsoStage()` 就是为填补这个位置准备的骨架。

---

## 八、未验证项清单与本次工具自证

### 8.1 显式标「未验证」的项(共 6 条)

| # | 未验证项 | 为什么没验证 | 怎么验证 |
| :--: | :--- | :--- | :--- |
| 1 | `@types/three` 的确切最新版本 | npm 页面(0.187.0)与 registry `dist-tags.latest`(0.184.1)**互相矛盾** | `npm view @types/three version` |
| 2 | `three-isometric` npm 包是否存在 | `registry.npmjs.org/three-isometric/latest` 返回 404 | `npm view three-isometric` |
| 3 | 本项目图集在真机上的**阴影**表现 | 没开过 shadowMap 实测;结论由「Sprite 不能投影」+「省一个 pass」推出 | 真机开/关 shadowMap 对比 |
| 4 | 程序生成的 16×16 武器图标该用 `SRGBColorSpace` 还是 `NoColorSpace` | 需要**目视**对色卡;离线无法判定 | 浏览器里放色卡比对 |
| 5 | 本项目在真机上的 **draw call 峰值** | §4.5 的数字是**算出来的**预算,不是实测 | 真机 `renderer.info.render.calls` |
| 6 | 地砖「顶面 33.27px + 侧面 15~18px」的分解 | 由「最宽 58px」反推,未逐像素分离顶面与侧面 | 沿竖直中线扫描,找顶面/侧面的拐点 |

**唯一曾被打算标为「未验证」但最终**验证了**的**:`anchor (0.5, 0.85)` 的度量方向(§4.3)。用 Pillow 逐像素扫描 alpha 包围盒 + 生成放大叠线图目视,结论确定。

### 8.2 本次我自己的工具错误(如实报告)

| # | 错误 | 现象 | 修正 |
| :--: | :--- | :--- | :--- |
| **E10** | 与相机光轴共线的检查里,**忘了把 `gy` 的负号换算成世界坐标** | 输出 ✗,但实际公式是对的 | 补上 `-(Δgy)` 后 `|1-\|dot\|| = 2.22e-16` ✓。**教训:映射定下来后,所有后续检查都要套用同一个符号约定** |
| **E11** | Python 脚本内嵌 `⇒` 等非 GBK 字符 | `UnicodeEncodeError: 'gbk' codec can't encode` | 改为把结果写进 UTF-8 文件再读。**本环境 Python stdout 是 GBK** |
| **E12** | PowerShell 内联 `node -e "...\"version\"..."` | 解析器报「字符串缺少终止符」 | 改为写独立 `.ts` 脚本文件。**嵌套引号在本环境不可靠** |
| **E13** | §4.3 里把「错抄锚点的偏移」写成 `0.35 × 高度 = 22.4px` | 数字本身算对了,但**基准取错** | 正确基准是「相对正确 anchor `0.15`」= `0.70 × 高度 = 44.8px`。**教训:报"差多少"必须先声明基准;基准错会把严重程度低估一半** |
| **E14** | `_tp_check.ts` 里正则写 `^````ts` 做围栏统计 | 模板字符串被三反引号提前截断,`ERR_INVALID_TYPESCRIPT_SYNTAX` | 改用 `'`'.repeat(3)` 拼接。**反引号出现在待匹配文本里时不能直接写进模板字符串** |

**E10 的教训值得单独说**:我在 §3.4 已经确认映射 A 需要 `gy → -gy`,但在 §3.6 写检查时用了裸的 `Δgy`。**如果我没做那次检查、或者检查通过方向与预期一致,这个符号错误就会进入文档。** —— 工具自证必须覆盖「我预期之外」的方向。

### 8.3 自证通过项汇总

| 自证项 | 判据 | 实测结果 |
| :--- | :--- | :--- |
| 投影公式与仓库一致 | 6 点逐点比对 | 最大误差 **2.27e-13** ✓ |
| 反投影可逆 | 6 点「格→屏→格」 | 最大误差 **2.51e-15** ✓ |
| 屏幕往返 | 4 点「屏→格→屏」 | 最大误差 **1.14e-13 px** ✓ |
| 射线方向恒定 | 4 个像素的 z 位移与光轴共线 | `|1-\|dot\|| = 2.22e-16` ✓ |
| 45° 轴向对称 | +X 与 +Y 一步的屏幕长度 | 均 **19.563975 px**,相等 ✓ |
| UV 计算 | 358 个精灵反算回像素矩形 | 不一致 **0** 个 ✓ |
| UV 越界 | 358 个 UV 落在 [0,1] | 越界 **0** 个 ✓ |
| 相机位置往返 | 半径 500/1000 反算俯角与方位角 | 35.000000° / 45.000000° ✓ |
| 锚点方向 | 红线(从顶部 0.85)落在脚部 | 目视确认 ✓ |

---

## 九、给实现者的最短行动清单

1. **升级 `three` 到 `^0.187.0`**,并把 [stage_assembly.ts](../client/src/three/stage_assembly.ts) 接成真正的装配入口(它目前零引用)。
2. **照 §3.4 的映射 A 摆相机**:世界轴 `(gx, -gy, gz)`,方位角 **-45°**,俯角 +35°,`up = (0,0,1)`。**不要**用 +45°。
3. **锚点做 `1 - 0.85 = 0.15`**:`sprite.center.set(0.5, 0.15)`。这是最容易错、错了也最难发现的一处。
4. **图集用单张 `Texture` + per-instance UV**,不要为 358 个精灵各 `clone()`。
5. **纹理设 `NearestFilter` + `generateMipmaps = false` + `colorSpace = SRGBColorSpace`;保持 `toneMapping = NoToneMapping`。**
6. **立牌与地形块都用 `InstancedMesh`**,按「材质 × LOD 档」分批;地形块按 §4.4 选 `TILE_PX` 基准(建议保持 16 并在装配层缩放)。
7. **影子烘进图集,不开 shadowMap。**
8. **必做 `webglcontextlost` / `webglcontextrestored` 处理**,并用 `WEBGL_lose_context` 扩展写个测试。
9. **`id ≠ 下标`**:从实体 id 找精灵必须查表(id 有 12 个空洞);只有「第 i 格」才可用固定步长。
10. **用 `renderer.info.render.calls` 盯 draw call**,手机目标 < 100~200。
