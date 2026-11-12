# WS-09 2.5D 舞台渲染与客户端 UI

> 工作流编号:WS-09
> 代码位置:`client/src/stage/*.ts`(8 个)、`client/src/ui/*.ts`(6 个)、`client/src/audio.ts`、`client/src/three/stage_assembly.ts`
> 测试:`tests/WS-09.test.ts`(59 条断言)
> 上游依赖:冻结层 `shared/types/{tile,alchemy}.ts`、`shared/constants/items.ts`、WS-01 `world/chunk.ts`
> 下游消费:无(本模块是渲染末端)

---

## 1. 职责边界

### 1.1 本模块负责什么

WS-09 是**唯一的出图侧**,把服务端的权威状态变成玩家看得见的东西。四大块:

1. **投影与相机(`iso_camera.ts`)** —— 35° 俯仰 / 45° 方位的正交投影,屏幕↔格坐标双向映射,视口地面包围盒。所有 2.5D 观感都从这两个角度来。
2. **地形建面(`tile_mesh.ts`)** —— 把 16×16 的 32 位单元翻译成顶面 + 侧面的 quad 批次,含视锥剔除、LOD 四档选择与面数预算控制。
3. **视觉层叠(`roof_transparency.ts` / `dye_overlay.ts` / `particles.ts` / `shaders.ts` / `entity_sprites.ts`)** —— 屋顶淡出、染色覆盖、粒子池、6 个 GLSL 程序、剪影精灵与像素图标。
4. **UI 与音频(`ui/*.ts` / `audio.ts`)** —— 背包、配方树、蓝图框选、Boss 血条与预警圈、像素画架、拖拽状态机、乐器音色与混音总线。

### 1.2 本模块**不**负责什么

| 不做的事 | 归属 | 原因 |
| :--- | :--- | :--- |
| 世界的权威状态 | WS-01/WS-04/WS-08 | 客户端**永不**判定,只渲染收到的状态 |
| 位域的打包/解包 | 冻结层 `tile.ts` | 客户端只读 `unpackTile` 的字段 |
| 电路信号的推进 | WS-08 `wiring/graph.ts` | 客户端只画 WS-08 给的 `WireView` |
| 房间识别与蓝图编解码 | WS-03 `build/` | 客户端复用其字符串,不重新实现 |
| 物理与碰撞 | WS-02 `physics/world.ts` | 相机只做投影,不参与碰撞 |
| 染色对材质的影响 | WS-08/WS-03 的材质系统 | 本模块只输出 uniform,不改材质定义 |

### 1.3 为什么投影放在客户端而房间识别放在服务端

判定类的逻辑(房间算不算、蓝图合法不合法)在服务端,因为它决定玩法结果;表现类的逻辑(倾斜多少度、LOD 选哪档)在客户端,因为它只影响观感,而且必须随窗口尺寸变化实时重算。

**唯一的例外是 `screenRectToWorldRect`**:它把玩家的框选矩形变成世界 AABB,看似"表现",实际**决定了要采集哪些格子**——所以它的输出必须和服务端的格坐标定义严格一致(闭区间、Chunk 半开区间)。

---

## 2. 接口

### 2.1 相机与投影

```ts
export const PITCH_DEG = 35;
export const AZIMUTH_DEG = 45;
export const COS_PITCH = 0.8191520442889918;   // cos(35°),精确值
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function createCamera(w: number, h: number, pitch?: number): Camera;
export function projectGridToScreen(gx: number, gy: number, gz: number, cam: Camera): { x: number; y: number };
export function unprojectScreenToGrid(sx: number, sy: number, cam: Camera, gz: number): { gx: number; gy: number };
export function viewBounds(cam: Camera, minZ: number, maxZ: number): ViewBounds;
export function viewCorners(cam: Camera): { gx: number; gy: number }[];
export function groundScreenStepPx(cam: Camera): number;
export function pixelScale(cam: Camera): number;
export function snapZoom(z: number): number;
export function stepZoom(z: number, dir: -1 | 1): number;
export function isoDepth(gx: number, gy: number, gz: number): number;
export function zScreenOffset(z: number): number;
export function zScreenOffsetPx(z: number, cam: Camera): number;
```

### 2.2 地形建面

```ts
export const CHUNK_SIZE = 16;
export const CHUNK_CELLS = 256;
export const FACES_PER_CELL_MAX = 5;      // 1 顶面 + 4 侧面
export const FACE_BUDGET = 800000;
export const WORLD_SIZE_CELLS = 1024;
export const ELEV_TO_Z = [-1, 0, 1, 2];
export const LOD_COUNT = 4;
export const LOD_MERGE_SIZE = [1, 2, 4, 8];
export const LOD_MERGE_FACTOR = [1, 4, 16, 64];      // = mergeSize²
export const LOD_MAX_DIST_CELLS = [24, 48, 96, Infinity];

export function dominantZGrid(chunk: ChunkInput, lod: number): { grid: Float64Array; size: number; merge: number };
export function buildChunkQuads(chunk: ChunkInput, lod: number, ctx?: EdgeContext): QuadBatch;
export function frustumCull(chunks: readonly ChunkInput[], cameraBounds: CullBox): FrustumCullResult;
export function chunkBounds(chunk: ChunkInput): ChunkBounds;
export function chunkDistance(chunk: ChunkInput, camX: number, camY: number): number;
export function selectLod(dist: number): number;
export function smoothLod(cur: number, want: number, maxStep: number): number;
export function estimateFaceCount(chunk: ChunkInput, lod: number): number;
export function estimateFaceBreakdown(n: number): ...;
export function frameFaceCount(visible: readonly ChunkInput[], lodFor): { faces; topQuads; sideQuads; vertices };
export function rawWorstFaceCount(visibleCount: number): number;
export function cheapestLodWithinBudget(...): ...;
export function withinBudget(faces: number): boolean;
export function emptyChunk(key: string, cx: number, cy: number): ChunkInput;
export function zToElev(z: number): number;
```

**`frustumCull` 的返回值契约**(踩过坑,见 §8.3):`visible` / `culled` 必须是**完整的 `ChunkInput`**(含 `tiles`),不是几何摘要。原因:`frameFaceCount(visible, lodFor)` 直接消费这个数组建面,若只有 `{key,cx,cy,minZ,maxZ}`,下游会在 `dominantZGrid` 里炸成 `Cannot read properties of undefined`。

### 2.3 屋顶透明

```ts
export const ROOF_ITEM_IDS: readonly number[];       // 屋顶白名单
export const ROOF_FADE_SEC = 0.22;
export const ROOF_MIN_ALPHA = 0.15;
export const NEIGHBOR4_DX = [0, 1, 0, -1];           // 北 东 南 西
export const NEIGHBOR4_DY = [-1, 0, 1, 0];

export function isRoofTile(tile: number): boolean;
export function buildRoofMask(tiles, w, h): RoofMask;
export function labelRoofComponents(mask: RoofMask): RoofComponents;
export function computeRoofAlpha(t: number): number;
export function advanceFade(st: FadeState, dt: number): FadeState;
export function smoothstep01(t: number): number;
export function roofAlpha(...): number;
export class RoofTransparencyManager {
  get componentCount(): number;
  get activeComponent(): number;
  get isIdle(): boolean;
  get versionTag(): number;
  rebuild(mask: RoofMask): RoofComponents;
  setPlayerCell(x: number, y: number): boolean;      // 返回是否**发生变化**
  alphaOf(i: number): number;
  alphaArray(): Float32Array;
  update(dt: number): boolean;
  markDirty(): void;
  needsRebuild(): boolean;
  componentAt(x: number, y: number): number;
}
```

### 2.4 染色

```ts
export const DYE_PALETTE_SIZE = 32;
export const DYE_PALETTE: readonly string[];
export const NO_DYE = -1;
export const DyeSurfaceKind = { WALL, FLOOR, ROOF, TEAMMATE, ... } as const;

export function materialKey(k: SurfaceKey): string;   // `${kind}#${uvVariant}#${dynamic}`
export function isValidSurfaceKey(k: SurfaceKey): boolean;
export function sprayAttenuation(dist: number): number;
export function unionRect(a: DyeRect, b: DyeRect): DyeRect;
export function uvRectOfCells(...): DyeRect;

export class DyeChannel {
  get materialInstances(): number;
  get dyedSurfaceCount(): number;
  get dirtyCount(): number;
  registerSurface(k: SurfaceKey): string;
  spray(k: SurfaceKey, tintIndex: number, rect: DyeRect, strength?: number, nowSec?: number): SprayResult;
  sprayMany(keys: readonly SurfaceKey[], tintIndex, rect, strength?, nowSec?): SprayResult;
  clear(k: SurfaceKey): boolean;
  flushDirty(): DyeEntry[];
  exportUniformArray(): Float32Array;
}
```

### 2.5 粒子

```ts
export const DEFAULT_POOL_CAPACITY = 4096;
export const PARTICLE_KIND_COUNT = 6;
export const ParticleKind = { SAKURA, DUST, LAVA_EMBER, ... } as const;
export const PARTICLE_PRESETS: Record<ParticleKind, { rate; life; size; gravityScale }>;

export class ParticlePool {
  get poolLength(): number;
  get activeCount(): number;
  get freeSlots(): number;
  get stats(): { issued; recycled; growths; droppedSpawns; active; capacity };
  acquire(): number;
  spawn(opts: SpawnOptions): number;       // 耗尽返回 −1 并计入 droppedSpawns
  release(i: number): boolean;
  update(dt: number): void;
  isAlive(i: number): boolean;
  read(i: number): ...;
}

export function emitBurst(pool, cfg, x, y, z): number;
export function createEmitter(ratePerSec: number): ContinuousEmitter;
export function stepEmitter(e: ContinuousEmitter, dt: number): number;
```

### 2.6 着色器

```ts
export const SHADER_NAMES: readonly string[];   // 6 个:water_ripple / grass_breeze / sakura_particles / lava_emissive / ice_reflect / dye_overlay
export const SHADER_PROGRAMS: Record<string, { vertex; fragment }>;
export const SHADER_UNIFORMS: Record<string, UniformDecl[]>;

export function braceBalance(src: string): number;
export function parenBalance(src: string): number;
export function declaredAttributes(src: string): string[];
export function declaredUniforms(src: string): string[];
export function duplicateDeclarations(src: string): string[];
export function uniformNames(name: string): string[];
export function uniformTableConsistency(name: string): { missing: string[]; undeclared: string[] };
```

### 2.7 UI 与音频

```ts
/* inventory.ts —— WS-FND-02 后容量由布局决定,不再等于内容数量 */
export const SLOTS_PER_ROW = 16;
export const INVENTORY_SPARE_ROWS = 1;          // 固定余量行
export const SLOTS_PER_PAGE_ROWS = 10;
export const SLOTS_PER_PAGE = 160;              // = 16 × 10,严格小于总容量
export const INVENTORY_ROWS = 21;               // = ceil(320/16) + 1
export const INVENTORY_SLOTS = 336;             // = 21 × 16,恒为 16 的整数倍
export const INVENTORY_PAGE_COUNT = 3;          // = ceil(336/160)
export interface SlotLayout {
  contentRows: number; rows: number; slots: number;
  pageRows: number; pageSlots: number; pageCount: number;
  rowAligned: boolean; fits: boolean;
}
export function computeSlotLayout(
  count: number, slotsPerRow: number, spareRows: number, pageRows?: number,
): SlotLayout;
export const CATEGORY_ORDER: readonly ItemCategory[];   // 12 项
export const CATEGORY_LABEL: Record<ItemCategory, string>;
export const BUCKETS: readonly CategoryBucket[];
export function categoryCounts(): Record<string, number>;
export function filterItems(opts?: FilterOptions): InventorySlot[];
export function buildView(opts?): InventoryView;
export function matchesQuery(item: ItemDef, query: string): boolean;
export function slotOf(itemId: number): number;
export function itemAt(slot: number): ItemDef | null;
export function isEmptySlot(slot: number): boolean;
export function sortSlots(slots, key: SortKey): InventorySlot[];
export function tableOf(itemId: number): { key: string } | null;
export function slotTooltip(slot): string;
export function usedSlotRatio(): number;

/* audio.ts */
export const A4_HZ = 440;
export const SEMITONE_RATIO = Math.pow(2, 1 / 12);
export const PITCH_COUNT = 32;
export const TIMBRES: readonly TimbreSpec[];            // 4 种
export const BELL_PARTIAL_RATIOS = [2.76, 5.4];         // 云钟非谐分音
export function resolveNote(ev: NoteEvent): ResolvedNote;
export function midiToHz(m: number): number;
export function hzToMidi(hz: number): number;
export function noteTotalSec(ev: NoteEvent): number;
export class MusicBus {
  get voiceCount(): number;
  get masterLevel(): number;      // getter,**按需重算**
  push(ev: NoteEvent): number;    // 0 = 被合并
  mix(): number;
  advance(tSec: number): number;
  clear(): void;
}
```

---

## 3. 数据结构

### 3.1 `ChunkInput` 与建面批次

```ts
interface ChunkInput {
  key: string;
  cx: number;
  cy: number;
  tiles: ArrayLike<number>;    // 256 项,每项 32 位打包单元
}

interface QuadBatch {
  topQuads: number;
  sideQuads: number;
  faceCount: number;           // = topQuads + sideQuads
  vertexCount: number;         // = faceCount × 4
  indexCount: number;          // = faceCount × 6
  cellsPerLayer: number[];     // 4 项,每层参与建面的格数
}
```

`cellsPerLayer` 是调试图层透明度的关键:它告诉你「z=−1 层有多少格在出图」,血色地形或悬空平台上排查错位时最有用。

### 3.2 `FrustumCullResult`

```ts
interface FrustumCullResult {
  visible: ChunkInput[];    // **含 tiles**,可直通 frameFaceCount
  culled: ChunkInput[];
  ratio: number;            // visible / total
}
```

### 3.3 屋顶与染色

```ts
interface RoofMask { width: number; height: number; mask: Uint8Array; roofCells: number; }
interface RoofComponents { count: number; labels: Int32Array; sizes: number[]; bounds: number[][]; }
interface FadeState { component: number; progress: number; entering: boolean; }

interface SurfaceKey { kind: DyeSurfaceKind; uvVariant: number; dynamic: 0 | 1; }
interface DyeRect { x: number; y: number; w: number; h: number; }
interface DyeEntry { key: string; tintIndex: number; strength: number; maskRect: DyeRect; }
```

### 3.4 粒子槽位(SoA)

`ParticlePool` 用**并列数组**(structure-of-arrays)而不是对象数组:`px[] py[] pz[] vx[] vy[] vz[] life[] maxLife[] size[] rot[] spin[] kind[] paletteIndex[] seed[] gravityScale[]`。

理由:每帧要遍历数千粒子做积分,对象数组会造成指针追逐与 GC 压力;并列的 `Float64Array` 能被引擎顺序预取。`freeList` 用栈式复用,`acquire` O(1)、`release` O(1),不产生任何新分配。

---

## 4. 算法

### 4.1 35° / 45° 正交投影

```
世界 (gx, gy, gz) → 屏幕:
  sx = (gx − gy) · cos45° · zoom + cx
  sy = (gx + gy) · cos45° · sin35° · zoom − gz · cos35° · zoom + cy
```

两个角度的分工:

- **方位 45°** 让 x/y 两轴在屏幕上对称(各占 `cos45° = 0.7071`),所以「南北」与「东西」看起来一样长 —— 这是等距视角可读性的前提。
- **俯仰 35°** 决定地面的"压扁"程度。`cos35° = 0.8191520442889918` 是硬编码的精确值而不是 `Math.cos(35 * Math.PI / 180)` 的运行时计算:后者在不同引擎上可能差 1 ulp,导致**网络同步的位置出现亚像素抖动**。

`sy` 中的 `− gz · cos35°` 说明 z 在屏幕上**向上为正**,与画布 y 轴向下的约定相反,所以 `zScreenOffset` 带来的偏移是负的。这个符号错一次会让整个世界的"高度"变成"深度"。

### 4.2 视口包围盒取地面四角

`viewBounds` 的做法是把屏幕四角**反投影到 z = minZ 与 z = maxZ 两个平面**,再取这 8 个点的 xy 包围盒。只取 z=0 单层会在有高低差的地形上漏掉边缘区块。

`viewCorners` 返回的 4 个点是**屏幕四角在 z=0 平面上的落点**,构成一个平行四边形(不是矩形)。这与 §4.5 的「AABB 紧致性」直接相关。

### 4.3 建面:顶面恒有,侧面按落差

```
buildChunkQuads(chunk, lod):
  1. dominantZGrid(chunk, lod) →
       merge = LOD_MERGE_SIZE[lod]
       size  = ceil(16 / merge)
       每格 grid[i] = 该合并块内**最高**的海拔(取 max,不是平均)
  2. 对每个非空气块:
       topQuads += 1
       cellsPerLayer[layer] += 1
       北/南/西/东各比一次:
         if (邻居 z < 自己 z) sideQuads += 1
  3. 邻居取不到时走 edgeZ(分片边界外侧),由 EdgeContext 提供或视为同高
```

**侧面只在「自己比邻居高」时才生成** —— 一个台阶只画它自己的那一面,不画邻居的。这样一面墙不会有两个重叠的 quad(z-fighting)。

`merge` 合并取 **max** 而非平均值:平均会把一座 16 格高的塔削成 8 格,轮廓全毁;取 max 保证 LOD 切换时**剪影不会塌**,代价是远处地面略微抬高。

### 4.4 LOD 四档与滞回

| 档 | `merge` | 合并因数 | 生效距离(格) | 一个 Chunk 的面数上限 |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 1 | ≤ 24 | 256 × 5 = 1280 |
| 1 | 2 | 4 | ≤ 48 | 64 × 5 = 320 |
| 2 | 4 | 16 | ≤ 96 | 16 × 5 = 80 |
| 3 | 8 | 64 | > 96 | 4 × 5 = 20 |

`LOD_MERGE_FACTOR = mergeSize²` 就是「一个合并块覆盖多少原始格」。档位间面数差 4 倍,所以**跨档跳变会肉眼可见**,必须用 `smoothLod(cur, want, maxStep)` 限制单帧最多跨 `maxStep` 档,否则相机快速推拉时地形会"呼吸"。

### 4.5 视锥剔除与 AABB 紧致性

```
hit = x0 <= camBounds.maxX && x1 > camBounds.minX
   && y0 <= camBounds.maxY && y1 > camBounds.minY
```

**注意 `>` 而不是 `>=`**:格坐标用闭区间 `[minX, maxX]` 表示"可见格",而 Chunk 覆盖的是半开区间 `[x0, x0+16)`。写成 `>=` 会让贴边的相邻 Chunk 多算一个,表现为视口边缘多渲染一列看不见的区块。

**为什么 AABB 只需两个对角就能算对**:屏幕矩形经逆投影得到的是平行四边形(仿射映射的像),仿射像的轴对齐包围盒确实只由两个对角决定。所以「取 4 角比取 2 角更准」**在数学上不成立** —— 实测把 pitch 取 0.5/0.7/0.9/1.1,四角法与两角法的宽度比恒为 **1.0000**。真正要守的性质是**紧致性**:AABB 的四条边至少各被某个角点触碰,否则框选会多选出没被框到的格子。

### 4.6 屋顶透明:连通域 + 淡出

```
labelRoofComponents(mask):    显式栈的迭代式 flood fill,O(w·h)
  4-邻域(不是 8-邻域),因为对角相接的两片屋顶在物理上是**分开的建筑**,
  8-邻域会把它们并成一片 —— 玩家从一侧走上屋顶,却看到另一侧也变透明。
```

顶点坐标约定:`NEIGHBOR4_DX = [0, 1, 0, −1]` / `DY = [−1, 0, 1, 0]` 对应 **北 东 南 西**。第 0 项是北 `(0, −1)`,所以 `DX[0] + DY[0] = −1` 是正确的;把它读成"偏移量为零"是把"北向"与"无偏移"混为一谈。

**管理器的边界必须保持原选区** —— 这一条在镜像与 α 数组上都踩过:`rebuild` 之后若用新 `cells` 反推 `minX/maxX`,单格构件会把边界收缩成一个点,再操作就漂移。

`ROOF_FADE_SEC = 0.22` 是"玩家走进去到屋顶变透"的时长:低于 0.15s 会有突兀的闪,高于 0.3s 会挡住玩家的移动判断。`ROOF_MIN_ALPHA = 0.15` 保留一点屋顶轮廓,让玩家知道"我还在屋檐下"。

### 4.7 染色:材质实例按表面身份并归

```
materialKey(k) = `${kind}#${uvVariant}#${dynamic}`
```

**材质 id 完全不随颜色变化** —— 这是本模块最重要的设计约束。32 种颜色轮流喷同一面墙,`materialInstances` 恒为 1:因为颜色走 uniform(`tintIndex`),不走材质实例。若把颜色编进材质 id,32 色 × N 面墙会炸出 32N 个材质,GPU 状态切换直接把帧率吃掉。

`sprayMany` 的返回字段语义要分清:

| 字段 | 含义 | 64 面墙、16 种 UV 变体时 |
| :--- | :--- | ---: |
| `surfaces` | **传入的表面数** | 64 |
| `changed` | 被改动的**材质实例数** | 16 |
| `hitTeammate` | 是否喷到了队友 | false |

`flushDirty()` 取出脏表并清空。幂等的正确含义是「**不新增脏标记**」,而不是「脏标记数为 0」—— 前一次喷色留下的标记本就该在,直到 flush 才清。

### 4.8 粒子:帧率无关的连续发射

```
stepEmitter(e, dt):
  e.elapsedSec += dt
  target = floor(e.elapsedSec × rate + 1e-9)
  n = max(0, target − e.emittedTotal)
  e.emittedTotal = target
  e.accumulator = elapsedSec × rate − emittedTotal
```

**必须用「逻辑总时间 × 速率」重算,不能逐帧累加 `rate × dt`。** 逐帧累加会累积浮点误差:`0.005` 累加 200 次得到 `0.9999999999999998` 而不是 `1`,`floor(0.9999… × 20)` 于是给出 **19** 而不是 20 —— 表现成「同样一秒,帧率越高粒子越少」,恰好摧毁这个函数存在的唯一理由。

实测三种步长都精确得到 20:

| 步长 | 帧数 | 结果 |
| :--- | ---: | ---: |
| 0.05s | 20 | 20 |
| 0.005s | 200 | 20 |
| 0.001s | 1000 | 20 |

池满时 `emitBurst` **继续遍历剩余粒子**而不是 `break`:每个失败请求都要计入 `stats.droppedSpawns`,否则「本次爆发被丢弃了几个」这个观测指标永远只等于 1,火焰/烟尘的密度调控就失去反馈信号。失败路径不做任何分配,继续遍历几乎零成本。

### 4.9 着色器:双 stage 声明是合法的

6 个 GLSL 程序全部通过括号平衡、属性与 uniform 声明校验。**同一个 uniform 在顶点与片元各声明一次是 GLSL 的正常且必要用法** —— 两个 stage 各自编译,不共享符号表,片元里想读 `uTime` 就必须自己声明。

因此「顶点+片元合并后无重复」是**错误判据**,它会把所有双 stage 使用的 uniform 都判成冲突。真正该禁的是**同一 stage 内**重复声明(`duplicateDeclarations`),以及登记表内的重名(`uniformNames`)。

`uniformTableConsistency(name)` 做双向对账:表里有的都必须在源码声明(`missing`),源码声明的都必须登记在表(`undeclared`)。

### 4.10 云钟的非谐分音

音色分**两类发声模型**:

- **整谐振动体**(八音盒 9 个谐波 / 琉璃笛 4 / 暖松木吉他 8):整数倍谐波表就是它的全部能量。
- **非谐振动体**(云钟):钟体基频之外的能量全在 `2.76f` / `5.40f` 这类**非整数倍**位置,整数倍谐波表因此只保留基频,其余由 `BELL_PARTIAL_RATIOS` 单独驱动。

```ts
harmonics: [1.0],                        // 只留基频
BELL_PARTIAL_RATIOS: [2.76, 5.4],        // 两个非谐分音
```

真实的管钟/云钟就是这样:基频给音高,2.76f 给金属味,5.40f 给尾韵。判据应是「整数倍谐波 + 非谐分音」的**总振荡分量数** ≥ 3,而不是机械地数 `harmonics.length`。

### 4.11 混音总线

```
mix() = tanh(Σ adsr.peak × gain)
```

`tanh` 而非 `clamp`:硬截断在过载时产生刺耳的高频谐波(数字削波),`tanh` 是软削波,过载时渐进饱和,听感上像模拟设备。8 轨满编时输出约 **0.93**,始终落在 `(0, 1)`。

`masterLevel` 是 **getter 且按需重算**,不读缓存字段。曾有一个缺陷:`level` 只在 `mix()` 里赋值,于是首次 `mix()` 之前读该属性得到 `undefined`,`bus.masterLevel > 0` 变成 NaN 比较、静默为 `false` —— 把"电平异常"伪装成"测试写错"。

---

## 5. 参数

### 5.1 相机

| 常量 | 值 | 说明 |
| :--- | ---: | :--- |
| `PITCH_DEG` | 35 | 俯仰角,决定地面压扁程度 |
| `AZIMUTH_DEG` | 45 | 方位角,让 x/y 对称 |
| `COS_PITCH` | 0.8191520442889918 | 精确硬编码,避免跨引擎 ulp 抖动 |
| `ZOOM_LEVELS` | 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 | 6 档吸附,避免任意缩放导致像素不对齐 |

`zoomLevels = ZOOM_LEVELS`(同一数组,别名导出)是刻意的:两者永远同源,不会漂移。

### 5.2 地形与预算

| 常量 | 值 | 说明 |
| :--- | ---: | :--- |
| `CHUNK_SIZE` | 16 | 与 WS-01 分片、WS-03 蓝图尺寸对齐 |
| `FACES_PER_CELL_MAX` | 5 | 1 顶面 + 4 侧面 |
| `FACE_BUDGET` | 800000 | 单帧面数上限(80 万) |
| `WORLD_SIZE_CELLS` | 1024 | 世界边长 |
| `ELEV_TO_Z` | `[−1, 0, 1, 2]` | 四层海拔 → z |
| `LOD_MERGE_SIZE` | `[1, 2, 4, 8]` | 四档合并边长 |
| `LOD_MAX_DIST_CELLS` | `[24, 48, 96, ∞]` | 四档生效距离 |

80 万面的预算来自:1024×1024 世界若全部以 LOD0 出图是 1024²×5 ≈ 524 万面,远超预算;靠 LOD 分级 + 视锥剔除把同屏面数压到 80 万以内。

`ELEV` 只有 **2 位(0~3)** 是冻结层事实,所以「四层海拔」是上界,没有第五层。

### 5.3 视觉层

| 常量 | 值 |
| :--- | ---: |
| `ROOF_FADE_SEC` | 0.22 |
| `ROOF_MIN_ALPHA` | 0.15 |
| `DYE_PALETTE_SIZE` | 32 |
| `DEFAULT_POOL_CAPACITY` | 4096 |
| `PARTICLE_KIND_COUNT` | 6 |
| `ICON_SIZE` / `ICON_PIXELS` / `ICON_RGBA_BYTES` | 16 / 256 / 1024 |
| `FACING_COUNT` | 4 |

粒子池 4096 是"够用又不浪费"的取点:最密的熔岩 + 樱花同时爆发峰值约 1200,4096 给了 3 倍余量;超过就静默降级并计入 `droppedSpawns`。

### 5.4 UI 与音频

| 常量 | 值 |
| :--- | ---: |
| `INVENTORY_SLOTS` | 336(布局推导,≠ 内容数 320) |
| `INVENTORY_ROWS` / `INVENTORY_SPARE_ROWS` | 21 / 1 |
| `SLOTS_PER_ROW` / `SLOTS_PER_PAGE` | 16 / 160 |
| `INVENTORY_PAGE_COUNT` | 3 |
| `A4_HZ` | 440 |
| `PITCH_COUNT` | 32 |
| `MAX_DEPTH`(配方树) | 8 |
| `TELEGRAPH_SHAPES` | 5 |

---

## 6. 性能

### 6.1 复杂度

| 操作 | 复杂度 | 频率 |
| :--- | :--- | :--- |
| `projectGridToScreen` / `unprojectScreenToGrid` | O(1) | 每帧每实体 |
| `frustumCull` | O(Chunk 数) | 每帧一次 |
| `buildChunkQuads` | O(256 / merge²) | 每可见 Chunk |
| `dominantZGrid` | O(256) | 同上 |
| `labelRoofComponents` | O(w·h) | 屋顶变化时 |
| `ParticlePool.update` | O(活跃粒子) | 每帧 |
| `MusicBus.masterLevel` | O(音轨数) ≤ 8 | 按需 |
| `filterItems` | O(320) | 搜索输入变化时 |

### 6.2 实测

| 场景 | 结果 |
| :--- | ---: |
| `frustumCull` 4096 Chunk | 144 可见 / 3952 剔除 |
| `frameFaceCount` 144 Chunk(LOD0) | 36864 面 / 147456 顶点 |
| `stepEmitter` 三种步长 | 均精确 20 个 |
| `MusicBus` 8 轨满编 | 电平 0.9312 |

144 个可见 Chunk 对应 144 × 256 = 36864 格,即视口内约 3.7 万格 —— 在这个量级下 LOD0 全出图就是 36864 面,远低于 80 万预算,所以**近处不需要降档**。

### 6.3 关键性能设计

1. **并列数组存粒子** —— 避免指针追逐与 GC(§3.4)。
2. **材质实例按表面身份并归** —— 32 色不炸材质(§4.7)。
3. **`dominantZGrid` 取 max** —— LOD 切换剪影不塌(§4.3)。
4. **建面全部在建造事件里,不在 tick 里** —— `buildChunkQuads` 只在 Chunk 脏时重算,每帧只做视锥剔除与绘制调用。
5. **`flushDirty` 批量上传** —— 染色每帧一次 uniform 上传,不是每次喷色一次。

---

## 7. 边界

### 7.1 明确拒绝/降级的输入

| 输入 | 结果 | 理由 |
| :--- | :--- | :--- |
| `selectLod(Infinity)` | 3 | 无穷远取最粗档 |
| `selectLod(-50)` | 2 | 取绝对值,与 +50 同档 |
| `selectLod(-Infinity)` | 3 | 绝对值仍为无穷 |
| `zoom` 非 `ZOOM_LEVELS` 成员 | `snapZoom` 吸附到最近档 | 避免任意缩放导致像素不对齐 |
| 粒子池耗尽 | `spawn` 返回 −1,计入 `droppedSpawns` | 静默降级,不抛错 |
| `emitBurst` 池满 | 返回实际生成数(可能 < count) | 继续遍历以累计丢弃数 |
| 染色色索引越界 | 视为 `NO_DYE`(擦除) | 非法输入等价于清除,不崩 |
| 染色 `uvVariant ≥ 16` | `isValidSurfaceKey` 返回 false | 图集只有 16 种变体 |
| 像素图标未知字符 | 透明 | `paletteCharToRgba` 兜底 `a=0` |
| 像素图标行数不足 16 | `normalizeIconRows` 补空行 | 玩家手绘必然是残缺的 |
| 像素图标行超 16 列 | 截断到 16 | 同上 |
| `hexToRgba` 非法 hex | 返回品红 `(255,0,255)` | 高可见度的"错误色",不会静默变黑 |
| `timbreOf` 越界 | 回退音色 0(八音盒) | 不抛错 |
| 配方树超深度 | 节点标 `truncated`,不展开 | 防爆栈 |
| `masterLevel` 在 `mix()` 前读取 | 按需重算,返回当前值 | 不返回陈旧/未初始化值 |

### 7.2b 配方树的留白槽(`recipeAnyTag`)—— CR-17 / task-54

冻结层的 `ItemDef.recipeAnyTag` 表达「**留白槽**」:某槽位接受**任意**一个带该 tag 的材料。
**本模块曾只读 `recipe`,完全忽略 `recipeAnyTag`,因而会误导玩家。**

**缺陷形态**(以 `#237 七彩颜料水球` 为例):

```
recipe       = {"165":1, "166":1}
recipeAnyTag = [["染料"]]
```

`166 绯红植物染料` 本身带 `染料` tag ⇒ 它是该槽的**登记代表**,
由槽接管,**不是额外的硬性要求**(冻结层注释 CR-17 已写明)。
旧实现把 `166` 当硬性要求显示 ⇒ **拿着 `167 琥珀阳光染料` 的玩家看到
「需要绯红植物染料」,以为自己缺料 —— 而服务端 `matchRecipeByTags` 实测 `ok=true`。**

⇒ 这是「**UI 说错了**」(误导),不是「UI 少显示了」(残缺)。两者修法优先级不同。

**修法(选择 (a) 的变体:独立槽节点 + 保留登记代表语义)**:确定件只取 `recipe` 里
**非登记代表**的键;每个留白槽再生成**一个终端槽节点**,
名字形如 `任意染料(166/167/168/169)`,并带 `slotTags` / `slotCandidates`。

选 (a) 而非 (b) 改标注的理由:
- 槽是**独立的一个需求位**,节点数应与「真实槽数」对齐;
  (b) 把信息藏进名字里,`children.length` 仍会小于真实槽数,
  `#356` 那种双槽会显示成 1 个节点 —— **结构性错误在数据层就已存在**,UI 层补不回来;
- 终端节点上有 `slotCandidates`,UI 可以直接渲染候选列表,不必解析字符串。

**判定语义(`checkCraft`)与冻结层 `matchRecipeByTags` 同构**:
1. 先扣**确定件**(`tree.leaves`,`与` 语义);
2. 再**逐槽**填留白(`或` 语义),每槽消耗 1 件有余量的合格材料。

两条必须做对,否则会重演同类缺陷:
- **槽不能折进 `tree.leaves`**:那会让 UI 要求玩家同时凑齐 166/167/168/169,比原来更错;
- **多个槽要逐个扣减**:`#356` 是「任意染料 ×2」,只判「背包里有染料」会用 1 件冒充 2 件
  (冻结层注释专门记了这条)。

**一处必须保留的能力(否则是回归)**:登记代表被槽接管后,它的**基础叶子**
(如 `166` = `121 露水甜莓×2`)不再进 `tree.leaves`。故 `RecipeSlot.candidateLeaves`
单独记下每个候选件的基础叶子,使「玩家没有现成染料、但有合成染料的基础材料」仍判为可合成。
少了这层会从「误导」变成另一种错:**拿基础料反而做不出**。

**实测范围**:配表 320 件中,含 `recipeAnyTag` 的共 **3** 件
(`#237` 单槽 / `#245` 单槽 / `#356` **双槽**)。断言**遍历全部**含槽物品而非只测样本,
并配**负对照**(264 件无槽物品的 `children` 数必须恰好等于 `recipe` 键数)。

### 7.2 未定义行为的显式化

- `unprojectScreenToGrid` 对屏幕上"地平线以上"的点返回**有限但很大**的格坐标,而不是 `NaN`。理由:框选可能拖到天际,返回 `NaN` 会让下游的 `Math.min/Math.max` 全部污染;返回大数则由 `clampCellRange` 在下一步夹紧。
- `RoofTransparencyManager.alphaArray()` 在无屋顶时返回空数组(长度 0),不是 `null`。调用方遍历空数组是零成本的,判空则每处都要写。

### 7.3 像素矩阵的字节偏移

公式是 **`(y * 16 + x) * 4`**,不是 `4 * y + x`。这个坑踩过一次:断言写 `rgba[4 * 1 + 0]` 求值为 4,实际指向 `(y=0, x=1)`,而不是想说的 `(y=1, x=0)` —— 后者在 64。因为在检查完全不同的像素,断言报的错和真实缺陷完全对不上。测试里统一改用 `px(y, x, k)` 取值函数,消除手写偏移。

---

## 8. 耦合

### 8.1 对上游的依赖

| 依赖 | 符号 | 稳定性 |
| :--- | :--- | :--- |
| 冻结层 `tile.ts` | `unpackTile` / `Elevation` / `CHUNK_BYTES` | **冻结** |
| 冻结层 `alchemy.ts` | `VisualStyle` / `CARRIER_TAGS` / `MECHANIC_TAGS` | 冻结 |
| `items.ts` | 物品名、类别、词条、配方、加工台 | 冻结 |
| `bosses.ts` | Boss 名、阶段阈值、预警形状 | 冻结 |
| WS-01 `world/chunk.ts` | `FLOOR_PALETTE` / `floorIdOfSlot` | 单向 |
| WS-03 `build/` | 蓝图的字符串编解码 | 单向 |
| WS-08 `wiring/` | `WireView`(电路叠加显示) | 单向 |

### 8.2 对下游的供给

WS-09 是**末端**,没有下游代码依赖它。它唯一的"输出"是屏幕像素与扬声器。

### 8.3 三条踩过的契约断裂(都值得记住)

1. **`frustumCull` 丢 `tiles`(真缺陷)** —— 它曾返回 `chunkBounds()` 的几何摘要(只有 `key/cx/cy/minZ/maxZ`),而 `frameFaceCount(visible, lodFor)` 直接消费这个数组建面,于是 `dominantZGrid` 读 `chunk.tiles[...]` 抛 `Cannot read properties of undefined`。**长期存在的原因**:原测试只断言 `visible.length < 200`,从不把结果交给下游消费 —— 契约断了却没人碰。修法:返回完整 `ChunkInput`,并在测试里把「数据流打通」本身变成判据。

2. **`mirrorBlueprint` 用结果反推边界(真缺陷)** —— 早先版本镜像后用新 `cells` 重算 `minX/maxX`,单格构件的镜像把边界收缩成一个点(`0..5` → `4..4`);对结果再镜像,轴变成 `4+4=8`,`8−4=4` 就不回到原点 —— 镜像**不满足对合性**,表现成「反复按镜像键,图形一路向右漂移」。修法:边界属"这次框选的范围",镜像只翻内容,边界保持原选区。

3. **`MusicBus.masterLevel` 读缓存字段(真缺陷)** —— `level` 只在 `mix()` 里赋值,首次 `mix()` 之前读该属性得到 `undefined`,`> 0` 变成 NaN 比较、静默 `false`。修法:getter 按需重算。

三条的共同特征:**下游消费方式的断裂,而不是单个函数算错**。所以断言也要写在下游边界上(见 §9.2)。

### 8.4 与 WS-03 的边界

`client/src/ui/blueprint.ts` 与服务端 `server/src/build/blueprint.ts` **同名不同责**:

- **客户端**:框选交互。`screenRectToWorldRect` / `collectBlueprint` / `mirrorBlueprint` / `blueprintChunks` / `blueprintOutline` / `blueprintSummary`。它产出一个 `Blueprint` 数据结构。
- **服务端**:编解码与材料。`encodeBlueprint` / `decodeBlueprint` / `expandMaterials` / `buildRelayQueue`。

两者共享 `Blueprint` 的字段形状,但**客户端不 import 服务端模块**。这保证客户端包不引入任何服务端依赖。

---

## 9. 验收

### 9.1 断言分组(59 条)

| 组 | 覆盖内容 | 条数 |
| :--- | :--- | ---: |
| A. 相机与投影 | 35°/45° 常量、双向往返、视口包围盒、缩档吸附 | 12 |
| B. 建面与 LOD | 顶面/侧面、四层海拔、棋盘格、四档门限、滞回、面数预算 | 13 |
| C. 视锥与剔除 | 可见性、AABB 紧致性、平行四边形面积界 | 4 |
| D. 屋顶透明 | 连通域、4-邻域分离、α 数组、跨片切换、幂等 | 7 |
| E. 染色 | 32 色、材质 id 与颜色无关、幂等、批量、脏表 | 6 |
| F. 粒子 | 池无泄漏、爆发、池满降级、帧率无关 | 5 |
| G. 着色器 | 6 程序、括号平衡、属性、双 stage uniform | 4 |
| H. 精灵与像素 | 剪影、像素矩阵容错、字节偏移 | 4 |
| I. 背包与配方树 | 12 分类、320 格、§3.9 拆桶、过滤、深度截断 | 4 |

### 9.2 关键断言(能区分实现,不是形式断言)

1. **`frustumCull` → `frameFaceCount` 直通** —— 断言每个可见 Chunk 都带 `tiles` 且长度完整。这条能抓住 §8.3-1 的契约断裂;只断言 `visible.length` 抓不到。
2. **镜像对合性** —— `mirror(mirror(x)) === x`。这条能抓住 §8.3-2 的漂移缺陷;只断言单次镜像的坐标抓不到。
3. **三种步长的发射器结果相同** —— 0.05s×20 / 0.005s×200 / 0.001s×1000 都必须得 20。这条能抓住 §4.8 的浮点累积误差;只测一种步长抓不到。
4. **32 色轮喷后材质实例恒为 1** —— 这条锁死"颜色走 uniform 不走材质实例"这个性能前提。
5. **4-邻域把对角相接的两片屋顶分成 2 片** —— 若实现误用 8-邻域,这条立刻红。
6. **`changed` 与 `surfaces` 语义分离** —— 64 面墙 / 16 变体时断言 `surfaces=64` 且 `changed=16`。把两者混为一谈的实现在这里暴露。
7. **`masterLevel` 在 `mix()` 前可读且落在 `(0,1)`** —— 抓 §8.3-3 的 `undefined` 缺陷。
8. **棋盘格侧面数 ≤ 128×4 = 512** —— 承认"理论上界减去分片边界扣减"是对的,同时把 `256×4 = 1024`(超过理论上界)这种不可能值挡在断言之外。

### 9.3 运行

```
node tests/WS-09.test.ts              → [WS-09] 59/59 通过
node scripts/verify.ts --only WS-09   → 全部通过
```

---

## 10. 未决

| # | 问题 | 现状 | 建议 | 需要谁裁决 |
| :--- | :--- | :--- | :--- | :--- |
| U1 | **`stage_assembly.ts` 依赖 `three`,而仓库零依赖** | 该文件无法在测试中 import | 需要一个**极简 `three` 相容层**(只要 `Scene` / `Mesh` / `BufferGeometry` / `DataTexture` 四个 facade),或把装配逻辑抽象成"产出描述对象"由宿主适配。当前测试覆盖不到它 | Lead |
| U2 | **顶点颜色 vs 纹理图集** | `tile_mesh` 只输出 quad 批次与图集索引 | 若选纹理图集,`spriteIndex` 已经是图集下标,直接可用;若选顶点色,需要把图集索引改成调色盘索引。这是美术管线的**岔路口**,越晚定越贵 | Lead + 美术 |
| U3 | **`flattenTree` 的叶子聚合口径** | 同 ID 合并计数 | 若两处需要不同批次数(如 3 个配方各需 1,合并成"需 3"),当前实现是对的;若要保留"来自哪个父节点"的溯源,需要额外结构 | Lead |
| U4 | **`estimateFaceBreakdown` 的估算精度** | 上界估算 | 是否需要按每 Chunk 实际 `dominantZGrid` 精确算?当前估算是保守上界,配合 `cheapestLodWithinBudget` 够用;若实测有掉帧再改 | Lead |
| U5 | **染色 `sprayAttenuation` 的距离衰减曲线** | 线性 | 喷枪边缘的柔和度是手感问题,建议由美术调参,不进冻结层 | 美术 + Lead |
| U6 | **粒子预设的 `rate` 是否该随画质档缩放** | 固定值 | 低端机需要降密度。建议在装配层乘一个全局系数,而不改预设表(预设表是"标准画质"的意图) | Lead |
| U7 | **`BossTelegraphRow` 与实际预警圈的字段对齐** | 已能 import | 预警圈的 5 种几何(圆/锥/矩形/环/线)与 Boss 表的字段映射需逐 Boss 核对一遍,防止某个 Boss 的预警形状灰落到默认值 | Lead + WS-05 |
| U8 | **已解决** ~~UI 面板的 320 格全展开是否太重~~ | 实测已改为**分页**:`SLOTS_PER_PAGE = 16 × 10 = 160`(不再是 320) | 原「现状」写「全展开」与代码不符 —— 代码早已走分页(`client/src/ui/inventory.ts:39,45,48`),`TOTAL_ITEM_COUNT = 320` 时必然分 2 页,分页路径不再退化。容量断言与分页切片由 `tests/WS-09.test.ts` 锁定。**本条由 task-14 台账核查判定为「已实现」,Lead 关行** | Lead |
| U9 | **`client/src/**` 的中文注释曾被 GBK 污染** | 已用 `scripts/fix_mojibake.py` 修复 | 残留的**有损**损坏(字节被截断成 `?`)无法自动还原,需人工按上下文重写。已确认当前全部文件能通过 `--check` | Lead |
| U10 | **`zoomLevels` 与 `ZOOM_LEVELS` 双导出** | 同一数组的两个名字 | 保留是为了兼容两处命名习惯;若要清理,应保留 `ZOOM_LEVELS` 并给 `zoomLevels` 加 deprecation 注释 | Lead |
| U11 | **4-邻域 vs 8-邻域的屋顶连通域** | 4-邻域 | 4-邻域让对角相接的屋顶保持独立(已断言);但玩家可能期望"我的 L 形屋顶算一片"。若收到反馈,可加"对角权重"折中方案 | Lead |
| U12 | **`frustumCull` 返回完整 `ChunkInput` 的内存代价** | 只是引用,不复制 | 当前是引用传递,零拷贝;若将来要传"可见子集的对象副本",需要重新评估 4096 Chunk × 256 单元的拷贝开销 | Lead |