/**
 * WS-FND-51 —— 客户端的**相机高度不再硬跳变**。
 *
 * ## 修的是什么(WF-48 留下的真实缺陷)
 *
 * `WS-FND-48` 把线上 `z` 接到了相机的 `focusZ` 上,但接法是**直接赋值**:
 * ```
 *   cameraFocusZ = mount.cameraFocus.z;   // 同一帧内跳到目标高度
 * ```
 * z 是网络来的数(跳跃 / 服务器纠偏 / 一个迟到的快照)⇒ 镜头在一次 16ms 内平移若干像素,
 * 真浏览器里表现为**闪一下**。它不抛错、不进日志、静态截图里完全看不出来 ——
 * 与 WF-48 那批「静默缺口」同一族,只是这次的受害者是**观感**而不是读数。
 *
 * ## 冻的是哪一件事
 *
 * | 概念 | 接线时 | 现在 |
 * |---|---|---|
 * | 相机高度 | 每帧**直接赋值**到目标 | 每帧用 `stepCameraHeight(当下, 目标, dt)` 推进 |
 * | 目标 vs 当下 | **一个变量两用**(`cameraFocusZ`) | 分开命名(`cameraFocusZTarget` / `cameraFocusZ`) |
 * | `z = 0` | 目标 0 ⇒ 镜头恒 0 | 目标 0 ⇒ **当下也恒 0**(平滑不引入偏移) |
 *
 * ## 为什么判据落在这里而不是 `boot.ts`
 *
 * `three/boot.ts` 的闭包含三方 `three` ⇒ node 里 import 不了(全仓无测试 import 它)
 * ⇒ 平滑本身是**纯函数**(`client/src/net/height_placement.ts`),`boot.ts` 那边只剩
 * 「每帧一次调用 + 两个变量」。本文件测的就是那个纯函数,以及它与 `placementForHeight`
 * 的**接缝**(「z = 0 ⇒ 目标高度与基础高度逐位相同」)。
 *
 * ⚠️ 断言右侧一律是**字面量**(`0.5` / `1e-3` / `1 / 60`),不从被测模块取期望值。
 * ⚠️ 每条都配「改坏哪里会红」(见各自的注释),尤其 FND51-6/7 ——
 *    没有它们,「平滑真的按 dt 走」与「平滑根本没接」分不开。
 */
import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import {
  placementForHeight,
  stepCameraHeight,
} from '../client/src/net/height_placement.ts';

/**
 * 60Hz 的一帧时长(**秒**)。与 `boot.ts` 送给纯函数的口径相同(那边写 `dt / 1000`)。
 * 字面量写在这里而不是从被测模块取 —— 期望值不许来自被测实现。
 */
const FRAME_SEC = 1 / 60;

/* ══════════════════ 1. 拒绝:dt 不合法 ⇒ 逐位原样返回 ══════════════════ */

test('FND51-1 ★ dt ≤ 0 / NaN / ±Infinity ⇒ **逐位**原样返回 current(拒绝,不是夹取)', () => {
  /* 变红条件:
     · 把 `dt <= 0` 写成「夹到 0」或「按 0 推进一步」⇒ 后台标签页回来/退回上一帧时
       镜头会朝目标走一步(切回来才发现镜头自己跑了),而这一帧**根本没过去时间**;
     · 把非有限 dt 放进指数 ⇒ α = 0(不动,恰好也对)或 NaN(整屏消失)。
     `eq` 对原始类型走 `Object.is`(见 harness)⇒ 这里钉的是**逐位**相同,不是"差不多"。 */
  for (const dt of [0, -0, -1, -FRAME_SEC, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    eq(stepCameraHeight(0.3, 0.9, dt), 0.3, `dt = ${String(dt)} 必须原样返回 0.3`);
  }
  /* `0` 这种"位型上看起来无所谓"的值也要逐位保住(`-0` 与 `0` 在 `Object.is` 下不同) */
  eq(stepCameraHeight(0, 1, 0), 0, 'current = 0 / dt = 0 ⇒ 逐位仍是 0');
  /* 目标不可信(NaN)时**不许**把当前值污染成 NaN:一旦写进 `cameraFocusZ`,`syncCamera()`
     会把它送进相机矩阵,而 NaN 投影的表现是**整屏消失**(比"没跟随"难查得多) */
  eq(stepCameraHeight(0.25, Number.NaN, FRAME_SEC), 0.25, '目标 NaN ⇒ 原样返回 current(不污染)');
  eq(stepCameraHeight(Number.NaN, 0.5, FRAME_SEC), Number.NaN, '当下已是 NaN ⇒ 仍是 NaN(不假装正常)');
});

/* ══════════════════ 2. 恒等:current === target ══════════════════ */

test('FND51-2 current === target ⇒ 逐位恒等(不引入 0 × α 的舍入)', () => {
  /* 变红条件:把 `current === target` 提前返回删掉 ⇒ 结果要经过一次浮点乘加,
     而「已经在目标上」的每一帧都会被重算一遍 ⇒ 残留的 ULP 会让 `syncCamera()`
     的差量判断偶尔为真(白白重建相机矩阵),也让「恒等」这条契约不可断言。 */
  for (const v of [0, 0.75, -0.3, 1, 1e-9, -1]) {
    eq(stepCameraHeight(v, v, FRAME_SEC), v, `current = target = ${v} ⇒ 逐位返回 current`);
  }
  /* dt 再大也一样:恒等与时间步无关 */
  eq(stepCameraHeight(0.4, 0.4, 1e9), 0.4, 'dt = 1e9 时恒等仍成立');
});

/* ══════════════════ 3. 收敛(给字面量 N 与字面量容差)══════════════════ */

test('FND51-3 反复推进 900 帧(15 秒)⇒ 与 target 误差 < 1e-3,且不越过 target', () => {
  /* 变红条件:α 写成常数(忽略 dt)、或直接把 target 赋回去(不管 dt)——
     前者会在**别的** dt 下变红(FND51-6),后者会让 FND51-7 的「一帧不许到」变红;
     而「不收敛」会红在这里:α 若被写成 `ratio * dt / …` 这种线性式,残差会阶梯式停住。 */
  let x = 0;
  for (let i = 0; i < 900; i += 1) x = stepCameraHeight(x, 1, FRAME_SEC);
  ok(Math.abs(1 - x) < 1e-3, `900 帧(15 秒)后必须收敛到 1(实际 ${x})`);
  ok(x < 1, `收敛途中不许越过 target(实际 ${x})`);
});

/* ══════════════════ 4. 不过冲 + 方向单调(两个方向)══════════════════ */

test('FND51-4 ★ 任一步都不越过 target,且方向单调(从下逼近 / 从上逼近)', () => {
  /* 变红条件:α ≥ 1(退化成瞬移)**或** α 为负/大于 1 的实现 ——
     「过冲」在等距视角下不是小事:focusZ 越过目标再弹回来 = 整屏抖一下,
     正是本任务要消灭的那个观感缺陷。逐帧断言(而不是只看末值)才抓得住中间那一步。 */
  let up = 0;
  for (let i = 0; i < 300; i += 1) {
    const next = stepCameraHeight(up, 1, FRAME_SEC);
    ok(next <= 1, `第 ${i + 1} 帧越过了 target(过冲):${up} → ${next}`);
    ok(next >= up, `第 ${i + 1} 帧反向走了:${up} → ${next}`);
    up = next;
  }
  let down = 1;
  for (let i = 0; i < 300; i += 1) {
    const next = stepCameraHeight(down, 0, FRAME_SEC);
    ok(next >= 0, `第 ${i + 1} 帧越过了 target(过冲):${down} → ${next}`);
    ok(next <= down, `第 ${i + 1} 帧反向走了:${down} → ${next}`);
    down = next;
  }
});

/* ══════════════════ 5. 从上方 / 从下方都收敛到同一个值 ══════════════════ */

test('FND51-5 从上方与从下方都收敛到同一个 target(0.2)', () => {
  /* 变红条件:α 只在上行方向对(例如实现里写成 `max(current, …)` 或忘了负 gap),
     ⇒ 从上方逼近会卡住/反向,而这条会红。 */
  let fromBelow = 0;
  let fromAbove = 1;
  for (let i = 0; i < 900; i += 1) {
    fromBelow = stepCameraHeight(fromBelow, 0.2, FRAME_SEC);
    fromAbove = stepCameraHeight(fromAbove, 0.2, FRAME_SEC);
  }
  ok(Math.abs(fromBelow - 0.2) < 1e-3, `从下方逼近必须收敛(实际 ${fromBelow})`);
  ok(Math.abs(fromAbove - 0.2) < 1e-3, `从上方逼近必须收敛(实际 ${fromAbove})`);
  /* 两侧都不许穿过 target(0.2):下行时不许低于、上行时不许高于 */
  ok(fromAbove >= 0.2, `从上方逼近不许穿过 target(实际 ${fromAbove})`);
  ok(fromBelow <= 0.2, `从下方逼近不许穿过 target(实际 ${fromBelow})`);
});

/* ══════════════════ 6. dt 真的进入计算:帧率无关 + 同一帧走得更多 ══════════════════ */

test('FND51-6 ★ 平滑按 dt 折算:同样 10 秒 = 同一个位置;dt 加倍 ⇒ 这一帧走得更远', () => {
  /* 变红条件:忽略 dt(α 取常数)⇒ 下面「同样 10 秒」这一条会红到离谱
     (60Hz 走 600 步 vs 30Hz 走 300 步,α 若与 dt 无关,两者的残差差几个数量级)。 */
  const run = (dt: number, frames: number): number => {
    let x = 0;
    for (let i = 0; i < frames; i += 1) x = stepCameraHeight(x, 1, dt);
    return x;
  };
  const at60 = run(FRAME_SEC, 600);
  const at30 = run(1 / 30, 300);
  near(at60, at30, 1e-9, '同样 10 秒(600 帧 @60Hz / 300 帧 @30Hz)必须追到同一个地方');

  /* 字面量窗口:残差 = (1 − 0.5)^10 = 0.5^10 ≈ 9.77e-4 ⇒ 值必须落在 [0.999, 1) ——
     这个窗口钉住的是「`CAMERA_HEIGHT_FOLLOW_RATIO = 0.5` 是**每秒**闭合一半」
     (若实现改成"每帧闭合一半",10 秒后早已等于 1,窗口下半边会红)。 */
  ok(at60 >= 0.999 && at60 < 1, `10 秒后残差应是 1e-3 量级(实际 ${at60})`);

  const oneFrame = stepCameraHeight(0, 1, FRAME_SEC);
  const twoFrames = stepCameraHeight(0, 1, 2 * FRAME_SEC);
  ok(twoFrames > oneFrame, `dt 加倍 ⇒ 这一帧必须走得更远(${oneFrame} → ${twoFrames})`);
  ok(twoFrames < 1, `但一步仍不许到 target(实际 ${twoFrames})`);
});

/* ══════════════════ 7. z = 0 与接线前逐位一致(+ 反向对照)══════════════════ */

test('FND51-7 ★ z = 0 ⇒ 相机目标高度与基础高度逐位相同;z = 5 ⇒ 确实不同(反向对照)', () => {
  /* 这一条钉的是 WF-48 的硬判据在**平滑之后仍然成立**:z = 0 时
     目标高度 = 接线前 `createCamera()` 的 `focusZ` 缺省值 = 0(字面量),
     且当下(平滑值)也恒 0 ⇒ 平滑**不引入**任何偏移。
     变红条件:给 z = 0 加常量偏移、或让平滑值在目标为 0 时漂移。 */
  const pos = { x: 12.5, y: 30.25 };
  const atZero = placementForHeight({ x: pos.x, y: pos.y, z: 0 }, 2);
  eq(atZero.cameraFocus.z, 0, 'z = 0 ⇒ 相机目标高度必须逐位等于基础高度 0');
  eq(stepCameraHeight(0, atZero.cameraFocus.z, FRAME_SEC), 0, 'z = 0 ⇒ 推进一帧仍是 0');
  eq(stepCameraHeight(0, atZero.cameraFocus.z, 1), 0, 'z = 0 ⇒ dt 再大也仍是 0');
  /* 地形高程(gz = 7)不许混进高度分量:否则 z = 0 的玩家一走上坡镜头就会动 */
  eq(placementForHeight({ x: pos.x, y: pos.y, z: 0 }, 7).cameraFocus.z, 0,
    'z = 0 且地形高程 = 7 ⇒ 目标高度仍是 0(高程不进相机高度)');

  /* 反向对照:没有它上面那三条可能**恒真**(比如目标高度被实现成硬编码 0) */
  const high = placementForHeight({ x: pos.x, y: pos.y, z: 5 }, 2);
  ok(high.cameraFocus.z !== 0, 'z = 5 ⇒ 目标高度**必须**不同于基础高度(否则上面恒真)');
  eq(high.cameraFocus.z, 1, 'z = 5 ⇒ 目标撞上护栏 = 1(字面量)');
  /* 而「一帧之后就到目标」正是被修掉的那个硬跳变:必须**动了一点但仍未到达** */
  const oneFrame = stepCameraHeight(0, high.cameraFocus.z, FRAME_SEC);
  ok(oneFrame > 0, `必须真的朝目标走了一点(实际 ${oneFrame};否则平滑等于没接)`);
  ok(oneFrame < 1, `一帧之内不许已经在目标上(实际 ${oneFrame};那正是硬跳变)`);
});

report('WS-FND-51-client-z-camera-smooth');
