/**
 * 相机跟随**权威位置** —— 纯函数(零三方、零 DOM、**零 import**)。
 *
 * ## 为什么它不在 `three/boot.ts` 里(这是本仓的硬约束,不是偏好)
 *
 * `boot.ts` 的闭包含三方 `three` ⇒ node 里 import 不了 ⇒ 判定写在它里面就
 * **结构上不可测**。本仓验证客户端逻辑的**唯一**手法是把判定抽进纯模块再在
 * node 里断言:`net/action_target.ts` + `tests/WS-FND-22` 是范本,本模块照它写。
 *
 * ## 它修的是什么:一个**巧合**
 *
 * 接线前「角色不会走出画面」是**巧合**成立的:WASD **同时**干两件事 ——
 * 经 `main.ts` 驱角色(本地预测 + 上行),又顺手把相机平移(`boot.ts` 的 `pan.x += ...`)。
 * 两件事共用一批按键,于是看起来像跟随;而一旦输入不走 WASD
 * (服务端纠偏 / 传送 / 别的输入设备),角色立刻就走出画面,**且不会报任何错**。
 *
 * ⇒ 现在把关系反过来:相机**盯着权威位置**(`telegraphCenterOf` 的返回值),
 *   WASD 只驱角色。本模块只回答两个问题:
 * ```
 * cameraTargetFor(player, opts)   权威位置 ⇒ 相机该对准哪
 * stepCamera(cur, target, dt, s)  当前聚焦点 ⇒ 这一帧推进到哪
 * ```
 * `boot.ts` 那边只剩**调用点**(每帧一次),判定全在这里。
 *
 * ## 两条设计决定(都是取舍,写理由)
 *
 * ### 1 没有死区(与 `stage/iso_camera.ts` 的 `followCamera` **故意不同**)
 *
 * `followCamera` 有 2 格死区。死区会让相机**永远停在**离目标 2 格的位置 ——
 * 这与本模块的判据「收敛到目标」直接冲突(断言会红),而 2 格在等距视角下
 * 是 32px 的偏心:看起来像"没对准",却没有任何东西会报错。
 * ⇒ 抖动改用**指数平滑**吸收:它天然单调、无过冲、帧率无关。
 *
 * ### 2 必须有吸附阈值 `CAMERA_SNAP_DISTANCE`
 *
 * 纯平滑在**传送 / 服务端纠偏**下是错的:一次 20 格的纠偏要
 * `smoothing × ln(20/ε)` 才追上(≈1 秒),表现为「角色被挪走了、画面还留在原地」——
 * 正是本模块要消灭的那类缺陷。⇒ 距离超过阈值就**一步吸附**到目标。
 *
 * ⚠️ 阈值取 6 格是量出来的:服务端单帧允许的位移是
 * `BASE_MOVE_SPEED × DT × teleportSlack`(`server/src/net/anticheat.ts`,折算
 * 约 0.5 格/tick)⇒ 正常移动远达不到 6 格,故**不会误触发吸附**(否则平滑白写)。
 * 6 格在等距视角下 ≈ 96px,一次跳这么远只可能是传送,不可能是走路。
 */

/** 一个平面点(世界格)。相机聚焦点与权威玩家位置用同一套坐标。 */
export interface CameraPoint {
  x: number;
  y: number;
}

/** 世界边界(格)。相机聚焦点会被夹在此范围之内(留 `edgePad` 格边距)。 */
export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** `cameraTargetFor` 的可选项。 */
export interface CameraTargetOpts {
  /** 给了就夹紧到世界内;不给则**原样**返回权威位置(单测里常用)。 */
  bounds?: CameraBounds;
  /** 边缘留白(格)。缺省 `CAMERA_EDGE_PAD`,与 `DEFAULT_FOLLOW.edgePadCells` 同值。 */
  edgePad?: number;
}

/**
 * 平滑时间常数(秒)。取 0.12 与 `stage/iso_camera.ts` 的 `DEFAULT_FOLLOW.smoothing`
 * 同值 —— 相机手感不该有两个口径。
 *
 * 它的物理含义:以速度 `v` 持续移动时,相机落后 `≈ v × smoothing` 格
 * (`v = 12` 格/秒 ⇒ 约 1.44 格 ≈ 23px,远小于半屏)⇒ 「不会走出画面」。
 */
export const CAMERA_SMOOTHING_SEC = 0.12;

/** 超过这么多格 ⇒ 判定为传送 / 服务端纠偏,一步吸附(不做平滑)。 */
export const CAMERA_SNAP_DISTANCE = 6;

/** 相机聚焦点与世界边界之间的最小留白(格),与 `DEFAULT_FOLLOW.edgePadCells` 同值。 */
export const CAMERA_EDGE_PAD = 8;

function clampToBand(v: number, lo: number, hi: number): number {
  /* ⚠️ `lo > hi`(世界比两倍边距还小)时取中值:否则会把相机钉在一个越界的数上 */
  if (lo > hi) return (lo + hi) / 2;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * 权威玩家位置 → 相机**目标**聚焦点。
 *
 * ## 空输入的语义(`null`,不是 `{x:0,y:0}`)
 *
 * 三种情况都返回 `null`:
 *   1 `player === null` —— 权威位置**还不知道**(第一帧未到 / 没有自己 / 掉线);
 *   2 `x`/`y` 不是有限数 —— 网络来的数是外部输入,`NaN` 会让 `Math.min/max`
 *     一路传下去,表现为画面整体消失(投影全 NaN)且**不抛错**。
 *
 * `{0,0}` 是**世界原点** —— 一个"看起来合法的错误位置"。返回 `null` 把
 * 「不知道」与「位置是 0,0」分开,强迫调用方显式决定(本仓同款语义见
 * `net/telegraph_center.ts` 与 `stage/assembly_math.ts`)。
 *
 * ## `bounds` 为什么存在
 *
 * 给 `bounds` 才夹紧。生产的调用方(`boot.ts`)传世界范围:
 * 权威位置来自网络,若服务端下发一个越界坐标,不夹紧的相机就飞到地图外面看空白;
 * 夹紧后最多偏心 `edgePad` 格(8 格 ≈ 128px,视口半宽约 25 格)⇒ 玩家仍在画面里。
 * 而**不传** `bounds` 时原样返回 —— 单测与"我就想看权威位置原值"的场景要这个。
 */
export function cameraTargetFor(
  player: CameraPoint | null,
  opts: CameraTargetOpts = {},
): CameraPoint | null {
  if (player === null) return null;
  if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) return null;

  const b = opts.bounds;
  if (b === undefined) return { x: player.x, y: player.y };

  const pad = Math.max(0, opts.edgePad ?? CAMERA_EDGE_PAD);
  return {
    x: clampToBand(player.x, b.minX + pad, b.maxX - pad),
    y: clampToBand(player.y, b.minY + pad, b.maxY - pad),
  };
}

/**
 * 一帧的相机推进:指数平滑 + 传送吸附。
 *
 * ## 为什么是 `1 − e^(−dt/τ)` 而不是 `cur + (target−cur) × 0.1`
 *
 * 定比例的写法**帧率相关**:60Hz 的机器追得比 30Hz 快一倍,而这不是"配置差异",
 * 是同一个游戏在两台机器上手感不同且无人报错。指数形式对同样的**时长**给出同样的
 * 结果(见 `tests/WS-FND-23` 的帧率无关断言)。
 *
 * ## 空操作条件(判定顺序是有意的)
 *
 * ```
 * dt ≤ 0 / 非有限        ⇒ 原样返回(dt = 0 是"这一帧没过去时间")
 * dist = 0 或非有限(NaN) ⇒ 原样返回(目标不可信时不许把相机推到 NaN)
 * dist > snapDistance    ⇒ 吸附(传送 / 服务端纠偏)
 * 其余                   ⇒ 平滑一步(α < 1 ⇒ **永不过冲**)
 * ```
 *
 * 纯函数:返回**新对象**,不改入参(调用方可以直接拿它与旧值比)。
 */
export function stepCamera(
  cur: CameraPoint,
  target: CameraPoint,
  dt: number,
  smoothing: number,
  snapDistance: number = CAMERA_SNAP_DISTANCE,
): CameraPoint {
  if (!Number.isFinite(dt) || dt <= 0) return { x: cur.x, y: cur.y };

  const dx = target.x - cur.x;
  const dy = target.y - cur.y;
  const dist = Math.hypot(dx, dy);
  /* `!(dist > 0)` 同时兜住 dist = 0 与 dist = NaN(目标含 NaN 时 hypot 也是 NaN)
     —— 写成 `dist === 0` 会让 NaN 穿过去,于是相机坐标被污染成 NaN,画面整体消失。 */
  if (!(dist > 0)) return { x: cur.x, y: cur.y };

  if (dist > snapDistance) return { x: target.x, y: target.y };

  /* τ 取正的下界:τ = 0 会让 α = 1(退化成瞬移),τ 为负则是负数推进 ⇒ 反向跑 */
  const tau = Math.max(1e-4, smoothing);
  const alpha = 1 - Math.exp(-dt / tau);
  return { x: cur.x + dx * alpha, y: cur.y + dy * alpha };
}
