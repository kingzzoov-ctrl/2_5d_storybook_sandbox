/**
 * WS-FND-23 —— **相机跟随权威位置**(纯逻辑那一半)。
 *
 * ## 本套件存在的理由
 *
 * 「角色不会走出画面」在接线前是**巧合**:WASD 经 `main.ts` 驱角色,又顺手把相机
 * 平移(`boot.ts` 的 `pan.x += ...`)。两件事共用一批按键 ⇒ 看起来像跟随。
 * 一旦输入不走 WASD(服务端纠偏 / 传送 / 别的设备),角色立刻走出画面,
 * 而**没有任何断言或门禁会红** —— 它只表现为"看不出来是错的"。
 *
 * ⇒ 判定被抽进 `client/src/net/camera_follow.ts`(零三方、零 DOM),在这里逐条钉住。
 *    `boot.ts` 那边只剩每帧一个调用点(含三方 `three`,`node` 里 import 不了 ⇒
 *    只能做**源码文本**断言,见 FND23-6 的弱判据声明)。
 *
 * ## 逐条的注入靶子(每条都写明"改坏哪里会红")
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 目标 == 权威位置(且未知 · NaN ⇒ `null`,不是 `{0,0}`) | 目标里塞进偏移 / 用 0 兜底 |
 * | 2 | 平滑单调收敛、不过冲、**帧率无关** | 定比例推进(`cur + Δ×0.1`) |
 * | 3 | 传送 / 服务端纠偏**跟得上**,连续移动落后有界 | 去掉吸附阈值(传送后要 1 秒才追上) |
 * | 4 | `dt = 0` 是空操作(含 NaN 目标) | 忘判 dt ⇒ 静止帧也在推进 |
 * | 5 | 纯函数:同输入同输出、不改入参(入参 `freeze`) | 就地改入参 / 结果依赖调用历史 |
 * | 6 | 弱:boot.ts 每帧真的调它,且 WASD **不再**写 `pan` | 把跟随删了、或把 WASD 平移接回去 |
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAMERA_EDGE_PAD,
  CAMERA_SMOOTHING_SEC,
  CAMERA_SNAP_DISTANCE,
  cameraTargetFor,
  stepCamera,
} from '../client/src/net/camera_follow.ts';
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 服务端世界是 64×64 —— 夹紧用的边界与 `boot.ts` 传的同一份口径。 */
const WORLD = { minX: 0, minY: 0, maxX: 64, maxY: 64 };

/** 相机平滑用的时间常数(生产值)。 */
const S = CAMERA_SMOOTHING_SEC;

/**
 * 读**代码态**(剥注释)。
 *
 * ⚠️ 本文件需要的判据是「代码里有没有这行」,而本仓多处 docblock 会引用历史代码
 * (`boot.ts` 里就留着 `playerGx = pan.x` 的说明)⇒ 查原文会**假绿**。
 * 剥法与 `WS-FND-16` 的 `readCode` 同形;那份不在 `shared/**`(冻结层)里,
 * 故各留一份三行实现。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════ 1. 目标 == 权威位置 ═══════════ */

test('FND23-1 相机目标**等于**权威玩家位置;未知 / NaN 返回 null(不是世界原点)', () => {
  /* 变红条件:目标里被塞进"手感偏移"(如永远往上偏 1 格)⇒ 相机不再对着权威位置,
     而屏幕上看不出来是错的(只是角色不居中一点点)。 */
  const player = { x: 20.5, y: 31.25 };
  eq(cameraTargetFor(player), player, '不传 bounds ⇒ 目标必须**原样**等于权威位置');
  eq(cameraTargetFor({ x: 0.75, y: 0.5 }), { x: 0.75, y: 0.5 }, '非整数格同样原样透传');

  /* `null` = 「不知道」。若用 `{0,0}` 兜底,相机会被拉到**世界原点**
     —— 一个看起来合法的错误位置,且不报错(与 `telegraph_center.ts` 同款语义)。 */
  eq(cameraTargetFor(null), null, '权威未知 ⇒ null');
  eq(cameraTargetFor({ x: Number.NaN, y: 3 }), null, 'NaN 坐标 ⇒ null(不许污染相机)');
  eq(cameraTargetFor({ x: 3, y: Number.POSITIVE_INFINITY }), null, 'Infinity 同理');

  /* bounds 是**边界保护**,不是"永远偏心":世界内的权威位置一格都不许动。 */
  eq(cameraTargetFor({ x: 40, y: 20 }, { bounds: WORLD }), { x: 40, y: 20 },
    '世界内的权威位置不应被夹(夹紧只在边界上生效)');
  /* 越界的权威位置(服务端下发了垃圾坐标)⇒ 夹到边内 `edgePad` 格,画面才不会飞到地图外 */
  eq(cameraTargetFor({ x: -4, y: 999 }, { bounds: WORLD, edgePad: 8 }), { x: 8, y: 56 },
    '越界 ⇒ 夹到 [minX+edgePad, maxX-edgePad]');
  eq(cameraTargetFor({ x: 1, y: 1 }, { bounds: WORLD, edgePad: CAMERA_EDGE_PAD }),
    cameraTargetFor({ x: 1, y: 1 }, { bounds: WORLD, edgePad: 8 }),
    '缺省 edgePad 应就是 CAMERA_EDGE_PAD');
});

/* ═══════════ 2. 平滑:收敛 · 不过冲 · 帧率无关 ═══════════ */

test('FND23-2 平滑单调收敛到目标、**不过冲**,且同样时长内与帧率无关', () => {
  /* 目标取 3 格(< 吸附阈值 6)⇒ 走的是平滑那条路(阈值行为在 FND23-3 单测)。
     变红条件:α > 1(如写成 `dt / smoothing` 而不是 `1 - exp(-dt/τ)`)⇒ 直接过冲。 */
  const target = { x: 3, y: 0 };
  let cur = { x: 0, y: 0 };
  let prev = cur.x;
  for (let i = 0; i < 180; i += 1) {
    cur = stepCamera(cur, target, 1 / 60, S);
    ok(cur.x > prev, `第 ${i + 1} 帧必须**向前**推进(实测 ${cur.x})`);
    ok(cur.x <= target.x, `第 ${i + 1} 帧不得过冲(实测 ${cur.x} > 目标 ${target.x})`);
    prev = cur.x;
  }
  near(cur.x, target.x, 1e-3, '180 帧(3 秒)内应收敛到目标');
  near(cur.y, 0, 1e-12, '目标 y 没动 ⇒ 相机 y 一格都不许动');

  /* 帧率无关:同样 0.5 秒,60Hz 与 30Hz 必须到**同一处**。
     定比例推进的话 60Hz 会比 30Hz 追得快一倍 —— 同一个游戏两台机器手感不同,
     而且**无人报错**(那不是"配置差异",是缺陷)。 */
  let a = { x: 0, y: 0 };
  for (let i = 0; i < 30; i += 1) a = stepCamera(a, target, 1 / 60, S);
  let b = { x: 0, y: 0 };
  for (let i = 0; i < 15; i += 1) b = stepCamera(b, target, 1 / 30, S);
  near(a.x, b.x, 1e-6, `同样 0.5 秒:60Hz 到 ${a.x} / 30Hz 到 ${b.x},必须一致`);
});

/* ═══════════ 3. 传送 / 服务端纠偏:跟得上 ═══════════ */

test('FND23-3 传送一步吸附、纠偏 1 秒内收敛、连续移动落后**有界**', () => {
  /* (i) 传送:20 格 —— 必须**一步**到位。
     变红条件:去掉吸附阈值 ⇒ 20 格要 smoothing×ln(20/ε) ≈ 1 秒才追上,
     表现为「角色被挪走了、画面还留在原地」。 */
  eq(stepCamera({ x: 32, y: 32 }, { x: 52, y: 52 }, 1 / 60, S), { x: 52, y: 52 },
    '换算约 28 格(> 阈值)⇒ 必须一步吸附,不许慢慢追');

  /* 阈值两侧行为必须**不同**,否则阈值形同虚设(两个方向各有一条注射)。 */
  const over = CAMERA_SNAP_DISTANCE + 0.5;
  eq(stepCamera({ x: 0, y: 0 }, { x: over, y: 0 }, 1 / 60, S), { x: over, y: 0 },
    '略超阈值 ⇒ 吸附');
  const under = CAMERA_SNAP_DISTANCE - 0.5;
  ok(stepCamera({ x: 0, y: 0 }, { x: under, y: 0 }, 1 / 60, S).x < under,
    '略低于阈值 ⇒ 必须平滑(若也吸附,平滑就白写了)');

  /* (ii) 服务端纠偏 4 格(小于阈值)⇒ 走平滑,但**1 秒内**要压到 0.1 格内。
     按服务端 tick(= DT)推进,与快照节奏同频。 */
  let cam = { x: 0, y: 0 };
  for (let i = 0; i < 20; i += 1) cam = stepCamera(cam, { x: 4, y: 0 }, DT, S);
  ok(Math.abs(4 - cam.x) < 0.1,
    `纠偏后 1 秒内误差须 < 0.1 格(实测落后 ${(4 - cam.x).toFixed(4)} 格)`);

  /* (iii) 连续移动:落后要有界(≈ v×smoothing)且**不累积**。
     变红条件:把平滑写成"每帧只走固定步长" ⇒ 落后随速度无限增长。 */
  const maxLagOf = (speed: number, frames: number): number => {
    let c = { x: 0, y: 0 };
    let worst = 0;
    for (let i = 1; i <= frames; i += 1) {
      const t = { x: (speed * i) / 60, y: 0 };
      c = stepCamera(c, t, 1 / 60, S);
      worst = Math.max(worst, t.x - c.x);
    }
    return worst;
  };
  const walkLag = maxLagOf(BASE_MOVE_SPEED, 180);
  ok(walkLag < 1, `步行(${BASE_MOVE_SPEED} 格/秒)落后应远小于 1 格(实测 ${walkLag.toFixed(3)})`);
  const sprintLag = maxLagOf(12, 180);
  ok(sprintLag < 2, `12 格/秒(旧相机平移速度)落后也须有界(实测 ${sprintLag.toFixed(3)} 格)`);
  ok(sprintLag >= walkLag - 1e-9, '落后随速度单调(说明它由 v×smoothing 决定,不是常数)');
});

/* ═══════════ 4. dt = 0 是空操作 ═══════════ */

test('FND23-4 dt = 0 / 负 / NaN 都是空操作;目标 NaN 也不许污染相机', () => {
  /* 变红条件:漏判 dt ⇒ 稳定帧(或 dt 被算成 0 的那一帧)也在推进;
     更糟的是 dt 为 NaN 时 `cur + dx×NaN` 会把相机坐标整片变成 NaN(画面全黑)。 */
  const cur = { x: 5, y: 6 };
  const far = { x: 40, y: 40 };
  eq(stepCamera(cur, far, 0, S), cur, 'dt = 0 ⇒ 不推进(哪怕目标是传送级距离)');
  eq(stepCamera(cur, far, -1, S), cur, '负 dt 同样不推进');
  eq(stepCamera(cur, far, Number.NaN, S), cur, 'dt = NaN 不推进(不许把相机推成 NaN)');
  eq(stepCamera(cur, { x: Number.NaN, y: 6 }, 1 / 60, S), cur, '目标含 NaN ⇒ 保持不动');
  eq(stepCamera(cur, cur, 1 / 60, S), cur, '已在目标上 ⇒ 不动');
  eq(cur, { x: 5, y: 6 }, '入参不得被改');
});

/* ═══════════ 5. 纯函数性 ═══════════ */

test('FND23-5 纯函数:同输入同输出、与调用历史无关、且不改入参', () => {
  /* 入参 `freeze`:ESM 是严格模式,若实现"就地改入参"会当场抛
     (`Cannot assign to read only property`)—— 比断言更早、更准地抓到。 */
  const cur = Object.freeze({ x: 1, y: 2 });
  const target = Object.freeze({ x: 1.5, y: 2.5 });
  const first = stepCamera(cur, target, 1 / 60, S);
  for (let i = 0; i < 5; i += 1) {
    eq(stepCamera(cur, target, 1 / 60, S), first, `第 ${i + 2} 次同输入必须同输出`);
  }
  eq(cur, { x: 1, y: 2 }, '入参 cur 不得被改');
  eq(target, { x: 1.5, y: 2.5 }, '入参 target 不得被改');
  eq(cameraTargetFor(cur), { x: 1, y: 2 }, '目标函数(不夹紧)同样不改入参');
  /* 夹紧那条路也不能改入参 —— 用**世界内**的点:越界点会被夹到 8/56,那是夹紧在起作用 */
  const inside = Object.freeze({ x: 20, y: 20 });
  eq(cameraTargetFor(inside, { bounds: WORLD }), { x: 20, y: 20 }, '夹紧路径不改入参');
  eq(inside, { x: 20, y: 20 }, '入参 inside 不得被改');
  ok(first.x !== cur.x && first.y !== cur.y, '推进后的值必须与起点不同(否则断言"纯"没有意义)');
});

/* ═══════════ 6. 弱判据:接线点(源码文本) ═══════════ */

test('FND23-6 ★弱判据:boot.ts 每帧真的调它,且 WASD **不再**写 pan', () => {
  /* ⚠️⚠️ 弱判据声明 ⚠️⚠️
     `three/boot.ts` 的闭包含三方 `three` ⇒ node 里 import 不了(全仓无测试 import 它)。
     下面只读**源码文本(剥注释)**,证明的是「调用点存在」,**不**证明行为正确 ——
     行为由 FND23-1..5(强)覆盖,两者强度不同,不要把这节读成"行为已验证"。 */
  const boot = readCode('client/src/three/boot.ts');
  ok(/from '\.\.\/net\/camera_follow\.ts'/.test(boot),
    'boot.ts 必须从 camera_follow.ts 导入(否则模块存在但没接线)');
  ok(/const target = cameraTargetFor\(authoritySeen \? \{ x: playerGx, y: playerGy \} : null/.test(boot),
    '每帧的目标必须由**权威位置**(playerGx/playerGy)算出 —— 权威未知时传 null(不落地世界原点)');
  ok(/const next = stepCamera\(pan, target, dt \/ 1000, CAMERA_SMOOTHING_SEC\)/.test(boot),
    '每帧必须用 stepCamera 推进相机聚焦点(秒 = dt/1000),且平滑常数走生产值');
  /* 反面对照:WASD 平移相机的两条痕迹都应消失 */
  ok(!/keys\.has\('a'\)|keys\.has\('w'\)/.test(boot),
    'boot.ts 里不应再有按键驱动的相机平移(`keys.has(...)`)');
  ok(!/pan\.x \+= \(dx \/ len\)/.test(boot), '旧的按帧把 WASD 位移灌进 pan 的写点必须已删除');
  ok(/from '\.\.\/net\/telegraph_center\.ts'/.test(boot),
    '权威位置仍走 telegraphCenterOf(相机的唯一输入源没有换人)');
});

report('WS-FND-23-camera-follow');
