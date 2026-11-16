/**
 * 玩家位置的 **z(高度)** → 画面摆放 —— 纯函数(零三方、零 DOM、零 `three`、零 import 副作用)。
 *
 * ## 本文件存在的理由
 *
 * `shared/types/wire.ts` 的玩家字段表**含 `z`**,`client/src/net/session.ts` /
 * `state_store.ts` 也一路把它解析到 `RoomState.players[].z` —— 但接线前**没有任何东西**
 * 读它:立牌与相机只按 x/y 摆(见 `three/boot.ts` 的 `playerMarkerPlacement` 调用与
 * `net/camera_follow.ts`)。于是「线上有 z、屏幕上没有 z」,而且**不会报任何错**:
 * 一个跳起来的玩家看起来和站在地上的玩家完全一样。
 *
 * ## 为什么落在 `net/` 而不是 `three/`(本仓的硬约束,不是偏好)
 *
 * `three/**` 是唯一允许 import 三方 `three` 的目录,它的闭包在 node 里 import 不了
 * (实测:全仓无任何测试 import `three/` 下文件)⇒ 判定写在那边就**结构上不可测**。
 * 本仓验证客户端逻辑的唯一手法是把判定抽进纯模块,再在 node 里断言
 * (`net/camera_follow.ts` + `tests/WS-FND-23` 是范本),本文件照它写;
 * `three/boot.ts` 那边只剩**每帧一个调用点**。
 * 也不放 `stage/`:`stage/` 收的是几何/地形算法(解包、高程表、索引缓冲),
 * 本文件做的是**线上字段 → 画面**的翻译,与 `net/camera_follow.ts`、
 * `net/telegraph_center.ts` 同层同职责。
 *
 * ## 坐标系:本仓地图是 2.5D —— `y` 是纵深 ⇒ **`z` 是高度**
 *
 * 格平面用 `x`/`y`(`y` 是行,即画面的纵深方向),**`z` 是高度**。屏幕上竖直的那一根
 * 轴是向量/摆放的**第三分量** —— 这不是 three 惯常的「y 朝上」,而是本仓**既有约定**:
 * `stage/chunk_geometry.ts` 的 `pushVertex` 写的是 `(cellX + dx, cellY + dy, z)`
 * (第二分量是行,第三分量才是层高),`three/stage_assembly.ts` 的正交相机就是按这套
 * 约定摆的,地形因此显示正常(`three/boot.ts` 的屋顶网格注释记着同一条)。
 *
 * ⇒ **z 只影响摆放的第三分量**:精灵的 `position.z`、相机聚焦点的 `focusZ`。
 *   **绝不进 x/y**:把高度加进 x 或 y 会让角色在地面上**滑走/瞬移**若干格,
 *   而那看起来像「正常移动」—— 不抛错、不报红、截图也对不上。这是本函数的首要理由。
 *
 * ## z 的语义 = **地表之上**的高度(不是绝对高程)
 *
 * 取证(服务端,只读):`physics.spawn(id, { x, y, z: 0 })` 给每个玩家 z = 0,
 * 而 `applyPlayerMove(playerId, x, y)` **只收 x/y** ⇒ 玩家走到 elev = 2 的台地上时
 * 服务端里的 z 仍是 0。若把 z 读成绝对高程,抬高的地形上玩家就会被画成「埋在地里」。
 * ⇒ z 只能是**相对地表**的高度(0 = 站在地面;跳跃、流体浮沉、上下坡改的是它),
 *   而地形那一格的实际高程由调用方给(`groundZ`,来自 `boot.ts` 的 `zAt` 表)。
 *   本函数**只把它与 z 相加**,不自己查表(查表要 tile 解包,不属于本层)。
 *
 * ## 不预测(那是 `prediction.ts` 的地盘);`dt` 只作**入参**,不作模块状态
 *
 * `prediction.ts` 管的是「本地输入 → 位置」的推测。本文件的 `placementForHeight` 是
 * 纯粹的摆放换算:同一个入参永远同一输出,没有历史、没有 dt、没有上一帧。
 *
 * 本文件里唯一带 `dt` 的是 `stepCameraHeight`(WS-FND-51「相机高度按帧平滑」)。
 * 它**仍然无状态**:上一帧的高度是**入参** `current`,不是模块里的变量 ⇒
 * 同样的 `(current, target, dt)` 永远同一输出,依旧可以在 node 里直接断言。
 * x/y 的时间平滑仍归 `net/camera_follow.ts` 独占(见下面 `CAMERA_HEIGHT_*` 的取舍)。
 *
 * ## 两条「z 影响哪个轴、为什么」的取舍
 *
 * ### 1 精灵:`sprite.z = groundZ + z`(**全额**,不夹紧)
 *
 * 它是**权威高度本身**。夹紧等于替服务端改口:一个浸在水下(z < 0)的玩家若被夹到 0,
 * 画面上就是「站在水面上」—— 一张**说谎的图**,而且没有任何东西会报错。
 * 契约区间由 `shared/types/wire.ts` 的字段表声明(z ∈ [−1, 3] 格);不信网络值,
 * 也不该在这一层偷偷改它(要兜住坏值,兜底规则见下)。
 *
 * ### 2 相机聚焦点:`focusZ = clamp(z × 0.5, ±1)`(**部分**跟随 + 护栏)
 *
 * 全额跟随会把**每一次跳跃变成整屏上下抖**:正交视角下相机抬高 1 格 = 画面整体位移。
 * 完全不跟随则 z = 3 的玩家比画面中心高 3 格(纵向约 `3 × sin35° ≈ 1.72` 格显示单位),
 * 长时悬空会贴到画面上缘。取一半,并把幅度夹在 ±1 格:z 是网络来的数,
 * 一个垃圾 z(比如 1e9)不许把镜头送出地图。
 *
 * ⚠️ 相机的高度分量**只吃 z,不吃地形高程**:若把 `groundZ` 也加进去,那么 z = 0 的
 * 玩家一走上坡镜头就会动 —— 而「z = 0 必须与接线前逐字段相同」是本题的硬判据。
 *
 * ★ WS-FND-51:上面算出来的是**目标**(`cameraFocus.z`)。真正落到 `IsoCamera.focusZ`
 * 还要按帧推进(`stepCameraHeight`)—— 直接赋值会在**同一帧**内跳到目标高度,
 * 真浏览器里就是一次可见的「闪」。目标与当下在 `boot.ts` 里**分开命名**
 * (`cameraFocusZTarget` / `cameraFocusZ`),不再一个变量两用。
 *
 * ## 空/坏输入(NaN、±Infinity)的处置:**按 0(= 站在地面)兜底,并把标志交出去**
 *
 * `z` 不是有限数 ⇒ `usedZ = 0`,`zFallback = true`。理由与 `stage/assembly_math.ts`
 * 的 `groundZAt` 同一条:NaN 一路传进投影会让精灵**整个消失**(不是「没画」,
 * 是「画了一个看不见的东西」),比「站回地面」更难查。**不抛错**:渲染循环每帧都调它,
 * 一次坏包不该打断整帧(`state_store.ts` 对坏包也是「不抛,把结果返回」)。
 * 而且它**不静默**:`zFallback` 让调用方能把「这一帧的高度不可信」读出来。
 *
 * ⚠️ 这与 `cameraTargetFor` 的 `null` 语义**故意不同**,别把两处统一:
 * 那里「不知道**位置**」必须与「位置是 (0,0)」分开(世界原点是一个看起来合法的
 * **错误位置**)。这里兜底到的是**地面**,即玩家本来 99% 时间所在的地方;
 * 而真正有「错误位置」风险的 x/y 压根不经过本函数(原样透传)。
 */

import type { RoomState } from '../../../shared/types/wire.ts';

/** 一个三点位置。**分量含义按本仓约定**:`x`/`y` 是格平面,`z` 是高度。 */
export interface HeightPoint {
  x: number;
  y: number;
  z: number;
}

/** 摆放结果里的一个点(third 分量 = 高度轴)。 */
export interface PlacementPoint {
  x: number;
  y: number;
  z: number;
}

/** `placementForHeight` 的返回值(每个字段都被 `tests/WS-FND-48` 用字面量钉住)。 */
export interface HeightPlacement {
  /** 精灵/立牌该放哪(three 的 `position` 直接吃它)。 */
  sprite: PlacementPoint;
  /** 相机该对准哪(第三分量 = `IsoCamera.focusZ`)。 */
  cameraFocus: PlacementPoint;
  /** 真正参与画面的高度(= 兜底之后的 z,单位「格」)。 */
  usedZ: number;
  /** `true` ⇒ 入参的 z 不是有限数,已按「站在地面」兜底。**不要忽略它**。 */
  zFallback: boolean;
}

/**
 * z 的单位换算:z 与 x/y 走**同一个** `FieldType.POS`(`POS_SCALE = 1024`),
 * 解码后同单位 ⇒ `1 格 = 1 世界单位`(`chunk_geometry` 的格↔世界是恒等映射)。
 *
 * 留成常量而不是字面量 1:若哪天 z 换了单位(例如改成「像素」),这里是**唯一**改点,
 * 而所有断言会立刻指向它。
 */
export const HEIGHT_WORLD_PER_CELL = 1;

/** 相机聚焦点跟随玩家高度的**比例**(取一半,理由见文件头「取舍 2」)。 */
export const CAMERA_HEIGHT_FOLLOW_RATIO = 0.5;

/** 相机高度分量的护栏(格)。垃圾 z 不许把镜头送出地图。 */
export const CAMERA_HEIGHT_MAX_OFFSET = 1;

function clampBand(v: number, lo: number, hi: number): number {
  /* lo > hi 的退化区间在本题不可能出现(常量一正一负),但保持与 camera_follow 同形 */
  if (lo > hi) return (lo + hi) / 2;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * `(x, y, z)` + 该格的地形高程 → 精灵与相机的摆放。
 *
 * ```
 * sprite.z      = groundZ + z            // 全额:权威高度是什么就是什么
 * cameraFocus.z = clamp(z × 0.5, ±1)     // 部分跟随 + 护栏(手感量,不是权威读数)
 * sprite.x/y    = cameraFocus.x/y = 入参 x/y   // ★ z 绝不碰格平面
 * ```
 *
 * `z = 0` 时 `sprite` 就是 `{x, y, groundZ}`、`cameraFocus.z` 就是 `0`
 * —— 与「忽略 z 的今天」**逐字段相同**(相机 `focusZ` 的缺省值本来就是 0)。
 *
 * 纯函数:返回**新对象**,不改入参(入参可被调用方 `freeze`)。
 * 不查表、不读 `RoomState`、不看上一帧。
 */
export function placementForHeight(pos: HeightPoint, groundZ: number): HeightPlacement {
  const zFallback = !Number.isFinite(pos.z);
  const usedZ = zFallback ? 0 : pos.z * HEIGHT_WORLD_PER_CELL;
  /* 地形高程也是外部数据(高程表)。非有限数按 0(地表基准)兜底 —— `zFallback` 只管 z,
     不替地形表背锅;表本身由 `zAt`/`groundZAt` 保证是有限数或 0。 */
  const gz = Number.isFinite(groundZ) ? groundZ : 0;
  const cam = usedZ * CAMERA_HEIGHT_FOLLOW_RATIO;
  return {
    sprite: { x: pos.x, y: pos.y, z: gz + usedZ },
    cameraFocus: {
      x: pos.x,
      y: pos.y,
      z: clampBand(cam, -CAMERA_HEIGHT_MAX_OFFSET, CAMERA_HEIGHT_MAX_OFFSET),
    },
    usedZ,
    zFallback,
  };
}

/**
 * 一帧的**相机高度**推进:从 `current` 朝 `target` 走一步 —— ★ WS-FND-51。
 *
 * ## 它修的是什么
 *
 * `IsoCamera.focusZ` 接线后是**直接赋值**(`cameraFocusZ = mount.cameraFocus.z`),
 * 即「同一帧内跳到目标高度」。z 是网络来的数:一次跳跃 / 一次纠偏 / 一个迟到的快照
 * 都会让镜头在一次 16ms 内平移若干像素 —— 真浏览器里表现为**闪一下**,
 * 而它**不抛错、不进日志**:静态截图里完全看不出来。
 *
 * ## 为什么落在本文件(与文件头同一条硬约束)
 *
 * 判定写在 `three/boot.ts` 里就**结构上不可测**(那半含三方 `three`,node 里 import 不了)。
 * ⇒ 平滑本身是**纯函数**,`boot.ts` 那边只剩「每帧一次调用 + 两个变量」。
 *
 * ## 公式:`α = 1 − (1 − ratio)^dt`,dt 单位 = **秒**
 *
 * 与 `net/camera_follow.ts` 的 `stepCamera` 是同一个族(`α = 1 − e^(−dt/τ)`):
 * 底数 `1 − ratio > 0` ⇒ 对**时长**可加(两帧 `dt₁ + dt₂` 与一帧 `dt₁ + dt₂` 结果相同)
 * ⇒ **帧率无关**:30Hz 与 60Hz 的机器追到同一个地方,只是步数不同(判据 FND51-6 钉住)。
 * 区别只是时间常数由 `CAMERA_HEIGHT_FOLLOW_RATIO` 定:
 * `τ = −1 / ln(1 − 0.5) ≈ 1.4427 s`。
 *
 * ⚠️ 它比 x/y 的 `CAMERA_SMOOTHING_SEC = 0.12` **慢一个数量级**,这是有意的:
 *   高度分量只吃 z、幅度被 `CAMERA_HEIGHT_MAX_OFFSET` 夹在 ±1 格;
 *   若按 x/y 那个速度追,一次跳跃(airtime ≈ 0.5s)就会把整屏上下推 ~10px ——
 *   那正是文件头「取舍 2」要避免的「每一次跳跃变成整屏上下抖」。
 *   慢到一帧只走百分之一量级 ⇒ 手感上是"镜头缓缓跟上来",而不是"画面抖一下"。
 *
 * ## 拒绝而非夹取(判定顺序是有意的,与 `stepCamera` 同形)
 *
 * ```
 * dt ≤ 0 / 非有限        ⇒ 原样返回(**不是**夹到 0:这一帧没过去时间,就不该动)
 * current/target 非有限  ⇒ 原样返回(NaN 一旦写进 focusZ 就再也回不来 ⇒ 画面整体消失)
 * current === target     ⇒ 原样返回(**逐位**恒等,连 0.0 × 任何数 的舍入都不引入)
 * 其余                   ⇒ α ∈ (0, 1) ⇒ 结果**严格**落在 current 与 target 之间
 * ```
 *
 * ## 为什么「永不过冲」不是靠夹紧
 *
 * `0 < α < 1` 是**结构性**的:`dt > 0` 且 `0 < ratio < 1` ⇒ `(1 − ratio)^dt ∈ (0, 1)`
 * ⇒ 既不会越过 target,也不会反向。⇒ 无需 `clamp(..., min(cur,target), max(cur,target))`
 * 那种「夹住算出来的错值」的写法(夹紧会把「反向跑」这种真错掩盖成『只是慢』)。
 * `dt` 大到 `(1 − ratio)^dt` 下溢成 0 时 `α === 1` ⇒ 正好落到 target,仍不过冲。
 *
 * 纯函数:只读入参,不写任何模块状态(上一帧的值是 `current`,不是隐藏变量)。
 */
export function stepCameraHeight(current: number, target: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (!Number.isFinite(current) || !Number.isFinite(target)) return current;
  if (current === target) return current;
  const alpha = 1 - Math.pow(1 - CAMERA_HEIGHT_FOLLOW_RATIO, dt);
  return current + (target - current) * alpha;
}

/**
 * 本地玩家的**高度** `z`(来自权威状态)。未知 ⇒ `0`。
 *
 * ## 为什么需要这个入口(而不是在 `boot.ts` 里 `players.find(...)`)
 *
 * 判定落在 `three/boot.ts` 里就**结构上不可测**(那半含三方 `three`,node 里 import 不了)
 * —— 与文件头同一条理由:能搬进纯模块的就搬进来。
 *
 * ## 为什么「未知」给 `0` 而不是 `null`
 *
 * `x`/`y` 那条路(`net/telegraph_center.ts`)在「不知道」时给 `null`,
 * 因为世界原点是**看起来合法的错误位置**。高度这里不一样:
 *   · 不知道 ⇒ 立牌本来就 `visible: false`(`playerMarkerPlacement` 的 `null` 分支),
 *     高度取什么都不影响画面;
 *   · `0` 正是「站在地面」,是玩家绝大多数时间的高度,而不是某个「合法但错」的地方。
 * ⇒ 用 `0` + 文件头的兜底规则,不再造一个 `null` 分支。
 *
 * ⚠️ 为什么不顺手给 `telegraphCenterOf` 的返回值加一个 `cz`:
 * 它的返回形状被 `tests/WS-12` **逐字段**断言成 `{cx, cy}`(结构化比较比对键集),
 * 加字段会让那条判据变红。⇒ z 走本文件的**独立**入口,不动那条已绿的路径。
 */
export function localPlayerZOf(state: RoomState, localPlayerId: string): number {
  if (localPlayerId === '') return 0;
  const p = state.players.find((x) => x.id === localPlayerId);
  if (p === undefined) return 0;
  return Number.isFinite(p.z) ? p.z : 0;
}