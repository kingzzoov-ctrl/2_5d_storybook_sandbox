/**
 * WS-FND-48 —— 玩家位置的 **z(高度)** 在客户端**真的影响画面**。
 *
 * ## 本套件存在的理由
 *
 * `shared/types/wire.ts` 的玩家字段表**含 `z`**,`client/src/net/session.ts` /
 * `state_store.ts` 也一路把它解析进 `RoomState.players[].z`,但接线前**没有任何读者**:
 * 立牌与相机只按 x/y 摆。⇒ 「跳起来的玩家」与「站在地上的玩家」在屏幕上**完全一样**,
 * 不抛错、不报门禁、截图也看不出 —— 正是本仓最想消灭的那类静默缺口。
 *
 * ⇒ 判定被抽进 `client/src/net/height_placement.ts`(零三方、零 DOM、零 `three`),
 *   在这里逐条钉住;`three/boot.ts` 那边只剩调用点(含三方 `three` ⇒ node 里
 *   import 不了 ⇒ 只能做**源码文本**断言,见 FND48-7 的弱判据声明)。
 *
 * ## 逐条的注入靶子(每条都写明「改坏哪里会红」)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | `z = 0` ⇒ 与「忽略 z」的今天**逐字段相同** | 给 z=0 加常量偏移(改既有表现) |
 * | 2 | `z > 0` ⇒ 已声明分量**单调上升**(字面量锚 6 组)+ 相机护栏恰好夹到 1 | 把 z 加错轴 / 忘了夹紧 / 系数漂移 |
 * | 3 | 负 z **被接受**(不抛错、不夹成 0) | 用 `Math.max(0, z)` 兜底(浸水玩家被画成站在水面) |
 * | 4 | `NaN` / `±Infinity` ⇒ 明确兜底到地面 + **标志**可读 | 让 NaN 穿进投影(精灵整体消失且不报错) |
 * | 5 | 纯函数:两次相同、不改入参、返回新对象 | 就地改入参 / 返回共享对象 / 依赖调用历史 |
 * | 6 | 与 `camera_follow` 不冲突:z=0 时地面口径逐字段相同,z 不许碰 x/y | 把高度混进相机目标(相机会在地面上滑走) |
 * | 7 | ★弱:boot.ts 真的接了两条线(立牌 + 相机 `focusZ`),且新模块零三方 / 不 import 服务端 | 模块存在但没接线 / 偷引 `server/**` 或 `three` |
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAMERA_HEIGHT_FOLLOW_RATIO,
  CAMERA_HEIGHT_MAX_OFFSET,
  HEIGHT_WORLD_PER_CELL,
  localPlayerZOf,
  placementForHeight,
  type HeightPlacement,
} from '../client/src/net/height_placement.ts';
import {
  CAMERA_SMOOTHING_SEC,
  cameraTargetFor,
  stepCamera,
} from '../client/src/net/camera_follow.ts';
import type { PlayerState, RoomState } from '../shared/types/wire.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 与 `boot.ts` 传的同一份边界口径(世界 64×64、边缘留白 8 格)。 */
const WORLD = { minX: 0, minY: 0, maxX: 64, maxY: 64 };
const CAMERA_OPTS = { bounds: WORLD, edgePad: 8 };

/**
 * 「**忽略 z** 的今天」—— 接线前的实现(立牌 z 只取地形高程,相机聚焦点高度恒 0)。
 *
 * 它是判据 1 的**右侧基线**:一个独立写出来的期望值,而不是调用被测实现得来的。
 */
function ignoreZ(
  x: number,
  y: number,
  groundZ: number,
): { sprite: { x: number; y: number; z: number }; cameraFocus: { x: number; y: number; z: number } } {
  return {
    sprite: { x, y, z: groundZ },
    cameraFocus: { x, y, z: 0 },
  };
}

/** 造一个只放了「自己(可带一个别人)」的最小 `RoomState`(字段照 `wire.ts` 的 `PlayerState`)。 */
function roomWith(me: { id: string; z: number }, other?: { id: string; z: number }): RoomState {
  const p = (id: string, z: number): PlayerState => ({
    id, name: id, level: 1, hp: 10, maxHp: 10,
    x: 3, y: 4, z,
    dir: 0, stateFlag: 0, weaponId: 0, aiWeaponRecipeHash: '',
    heldItemId: 0, carryingEntityId: '',
  });
  return {
    roomId: 'room',
    meta: { tick: 1, chunkVersions: {}, partyMode: 0, partyTimer: 0, scoreA: 0, scoreB: 0 },
    players: other === undefined ? [p(me.id, me.z)] : [p(me.id, me.z), p(other.id, other.z)],
    wildlife: [],
    bosses: [],
  };
}

/**
 * 读**代码态**(剥注释)。
 *
 * ⚠️ 本仓多处 docblock 会**引用历史代码**(本文件涉及的 `boot.ts` 里就留着
 * `playerGx = pan.x` 那类说明)⇒ 查原文会**假绿**。剥法与 `WS-FND-23` 的 `readCode` 同形;
 * 那份不在 `shared/**`(冻结层)里,故各留一份三行实现。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════ 1. z = 0 必须与「忽略 z 的今天」逐字段相同 ═══════════ */

test('FND48-1 z = 0 ⇒ 与「忽略 z」的实现**逐字段相同**(既有表现不许变)', () => {
  /* 变红条件:有人在 z=0 的路径上加了一个「手感偏移」(例如整体抬高 0.2 格)
     ⇒ 所有玩家(绝大多数时间 z = 0)脚下都浮起来或陷进去,而**没有任何东西会报错**。 */
  const anchors: readonly (readonly [number, number, number])[] = [
    [12.5, 30.25, 2],
    [0, 0, 0],
    [63.75, 63.5, -1],
    [32.125, 32.875, 1],
  ];
  for (const [x, y, gz] of anchors) {
    const base = ignoreZ(x, y, gz);
    const got = placementForHeight({ x, y, z: 0 }, gz);
    /* 逐字段比(不整对象比:`usedZ`/`zFallback` 是新加的元数据,不是摆放) */
    eq(got.sprite.x, base.sprite.x, `z=0 时 sprite.x 必须原样(${x})`);
    eq(got.sprite.y, base.sprite.y, `z=0 时 sprite.y 必须原样(${y})`);
    eq(got.sprite.z, base.sprite.z, `z=0 时 sprite.z 必须仍等于地形高程(${gz})`);
    eq(got.cameraFocus.x, base.cameraFocus.x, 'z=0 时相机的地面口径不许变');
    eq(got.cameraFocus.y, base.cameraFocus.y, 'z=0 时相机的地面口径不许变');
    eq(got.cameraFocus.z, base.cameraFocus.z, 'z=0 ⇒ 相机高度分量必须是 0(接线前它恒为 0)');
  }
  /* 再钉一组字面量:整对象形状也不许变(顺序无关的结构比较) */
  eq(placementForHeight({ x: 12.5, y: 30.25, z: 0 }, 2).sprite, { x: 12.5, y: 30.25, z: 2 });
  eq(placementForHeight({ x: 12.5, y: 30.25, z: 0 }, 2).cameraFocus, { x: 12.5, y: 30.25, z: 0 });
  /* `z = -0` 与 `0` 同款(浮点符号不该改变摆放) */
  eq(placementForHeight({ x: 1, y: 2, z: -0 }, 3).sprite, { x: 1, y: 2, z: 3 });
  /* 常量本身也钉住 —— 否则上面所有期望值都可以被"顺手调一下常量"绕过 */
  eq(HEIGHT_WORLD_PER_CELL, 1, 'z 与 x/y 同单位(格),换算系数必须是 1');
  eq(CAMERA_HEIGHT_FOLLOW_RATIO, 0.5, '相机高度跟随比例 = 一半');
  eq(CAMERA_HEIGHT_MAX_OFFSET, 1, '相机高度护栏 = ±1 格');
});

/* ═══════════ 2. z > 0 ⇒ 已声明分量单调变化(字面量锚) ═══════════ */

test('FND48-2 z > 0 ⇒ sprite.z 严格上升、cameraFocus.z 上升到护栏为止(字面量锚)', () => {
  /* 变红条件:把高度加进 x/y(角色在地面上滑走)、或忘了 `cameraFocus.z`(镜头不动)、
     或把系数写成别的值 —— 三种都只表现为「看着有点怪」,不会抛错。 */
  const zs: readonly number[] = [0.25, 0.5, 1, 2, 3];
  const spriteExpect: readonly number[] = [0.25, 0.5, 1, 2, 3];
  const camExpect: readonly number[] = [0.125, 0.25, 0.5, 1, 1];

  for (let i = 0; i < zs.length; i += 1) {
    const got = placementForHeight({ x: 10, y: 20, z: zs[i] }, 0);
    near(got.sprite.z, spriteExpect[i], 1e-12, `z=${zs[i]} 的立牌高度`);
    near(got.cameraFocus.z, camExpect[i], 1e-12, `z=${zs[i]} 的相机高度分量`);
    /* 地面平面**一个数都不许动** —— 这是「z 只进第三分量」的正面证据 */
    eq(got.sprite.x, 10, 'z 不许改变 sprite.x');
    eq(got.sprite.y, 20, 'z 不许改变 sprite.y');
    eq(got.cameraFocus.x, 10, 'z 不许改变相机目标的 x');
    eq(got.cameraFocus.y, 20, 'z 不许改变相机目标的 y');
    eq(got.zFallback, false, '有限 z 不许走兜底分支');
  }
  /* 单调:严格上升(sprite)/ 非下降(相机,到护栏后持平) */
  for (let i = 1; i < zs.length; i += 1) {
    const prev = placementForHeight({ x: 0, y: 0, z: zs[i - 1] }, 0);
    const cur = placementForHeight({ x: 0, y: 0, z: zs[i] }, 0);
    ok(cur.sprite.z > prev.sprite.z,
      `立牌高度必须单调上升(${zs[i - 1]} → ${zs[i]}: ${prev.sprite.z} → ${cur.sprite.z})`);
    ok(cur.cameraFocus.z >= prev.cameraFocus.z,
      `相机高度分量不许随 z 反向(${zs[i - 1]} → ${zs[i]})`);
  }
  /* 地形高程 + 高度:**两者相加**,不是二选一 */
  near(placementForHeight({ x: 5, y: 5, z: 1.5 }, 2).sprite.z, 3.5, 1e-12,
    '台地(elev 2)+ 跳起 1.5 格 ⇒ 立牌必须在 3.5');
  near(placementForHeight({ x: 5, y: 5, z: 2 }, 2).sprite.z, 4, 1e-12, '相加同理');
  /* 护栏**恰好**生效:z × 0.5 超过 1 之后就被夹住(垃圾 z 不许把镜头送出地图) */
  near(placementForHeight({ x: 0, y: 0, z: 2 }, 0).cameraFocus.z, 1, 1e-12, '恰好到护栏');
  near(placementForHeight({ x: 0, y: 0, z: 4 }, 0).cameraFocus.z, 1, 1e-12, '超过护栏 ⇒ 夹住');
  near(placementForHeight({ x: 0, y: 0, z: 1e6 }, 0).cameraFocus.z, 1, 1e-12,
    '一个荒谬的 z(1e6)也只许把镜头抬 1 格');
  /* 而**立牌**不夹紧:z 是权威读数,夹了就是替服务端改口 */
  near(placementForHeight({ x: 0, y: 0, z: 1e6 }, 0).sprite.z, 1e6, 1e-3,
    '立牌按权威高度全额摆放(它的可信度由契约区间与兜底规则管,不在这里夹)');
});

/* ═══════════ 3. 负 z 被接受 ═══════════ */

test('FND48-3 负 z(水下/下沉)被接受:不抛错、**不夹成 0**、与地形高程照常相加', () => {
  /* 变红条件:用 `Math.max(0, z)` 兜底 ⇒ 浸在水下(z < 0)的玩家被画成「站在水面上」,
     一张**说谎的图**,而且没有任何东西会报错。 */
  const below = placementForHeight({ x: 7.5, y: 8.5, z: -1.5 }, 0);
  near(below.sprite.z, -1.5, 1e-12, '负高度原样保留(不许夹成 0)');
  ok(below.sprite.z !== 0, '★ 负 z 不许被夹成 0');
  eq(below.zFallback, false, '负数是**有限数**,不是坏输入');
  /* 下沉的水面城:地形 elev -1 + 玩家 z -0.25 ⇒ 立牌在 -1.25 */
  near(placementForHeight({ x: 1, y: 2, z: -0.25 }, -1).sprite.z, -1.25, 1e-12,
    '负高度与负高程照常相加');
  /* 相机分量也带符号(但仍受护栏约束) */
  near(placementForHeight({ x: 0, y: 0, z: -1 }, 0).cameraFocus.z, -0.5, 1e-12, '负 z 的相机分量');
  near(placementForHeight({ x: 0, y: 0, z: -3 }, 0).cameraFocus.z, -1, 1e-12,
    '负方向的护栏同样恰好是 -1');
  /* 契约区间的两端(`wire.ts` 字段表写的是 z ∈ [−1, 3] 格)都能过 */
  near(placementForHeight({ x: 0, y: 0, z: -1 }, 0).sprite.z, -1, 1e-12, '契约下界');
  near(placementForHeight({ x: 0, y: 0, z: 3 }, 0).sprite.z, 3, 1e-12, '契约上界');
});

/* ═══════════ 4. NaN / ±Infinity 明确处置 ═══════════ */

test('FND48-4 NaN / ±Infinity ⇒ 兜底到「站在地面」且**标志可读**(理由:NaN 会让精灵整体消失)', () => {
  /* 变红条件:让非有限的 z 直接进 `position.z` ⇒ 投影全 NaN ⇒ 精灵**整个消失**
     (不是「没画」,是「画了一个看不见的东西」),比站回地面更难查;
     或者**静默**兜底(没标志)⇒ 调用方分不清「这一帧高度不可信」。 */
  const cases: readonly (readonly [string, number])[] = [
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];
  for (const [label, z] of cases) {
    const got: HeightPlacement = placementForHeight({ x: 4, y: 5, z }, 2);
    eq(got.zFallback, true, `${label}:必须把「高度不可信」交出去,不许静默`);
    eq(got.usedZ, 0, `${label}:参与画面的高度按 0(站在地面)兜底`);
    eq(got.sprite.z, 2, `${label}:立牌落在地形高程上(不是 NaN、也不是 0)`);
    eq(got.cameraFocus.z, 0, `${label}:相机高度分量按 0 兜底(= 接线前的不动镜头)`);
    /* x/y 是**另一条路**来的(不经过本函数),坏 z 不许连累它们 */
    eq(got.sprite, { x: 4, y: 5, z: 2 }, `${label}:地面位置必须完好`);
    eq(got.cameraFocus, { x: 4, y: 5, z: 0 }, `${label}:相机地面口径必须完好`);
  }
  /* 地形高程本身是坏数(`zAt` 查不到/脏表)时也不许把 NaN 传下去 */
  const badGround = placementForHeight({ x: 1, y: 1, z: 1 }, Number.NaN);
  eq(badGround.sprite.z, 1, '脏高程按 0 兜底,而 z 的部分照常生效');
  ok(Number.isFinite(badGround.sprite.z), '输出必须是有限数(否则精灵消失且不报错)');
  /* 权威状态里的坏 z 同样不许流出来(`localPlayerZOf` 的兜底) */
  eq(localPlayerZOf(roomWith({ id: 'me', z: Number.NaN }), 'me'), 0, '权威里的 NaN z ⇒ 0(地面)');
  eq(localPlayerZOf(roomWith({ id: 'me', z: Number.POSITIVE_INFINITY }), 'me'), 0, 'Infinity 同理');
  eq(localPlayerZOf(roomWith({ id: 'me', z: 1.25 }), 'me'), 1.25, '正常值原样返回');
  eq(localPlayerZOf(roomWith({ id: 'me', z: 0 }), ''), 0, '还没握手(空 id)⇒ 0,不是抛错');
  eq(localPlayerZOf(roomWith({ id: 'me', z: 2 }), 'other'), 0, 'id 不在房里 ⇒ 0');
  eq(localPlayerZOf(roomWith({ id: 'me', z: 2 }, { id: 'other', z: 9 }), 'me'), 2,
    '多人房里取**自己**的 z(不悄悄挑第一个玩家)');
});

/* ═══════════ 5. 纯函数性 ═══════════ */

test('FND48-5 纯函数:两次同输入同输出、不改入参、返回**新对象**', () => {
  /* 入参 `freeze`:ESM 是严格模式,若实现就地改入参会当场抛
     (`Cannot assign to read only property`)—— 比断言更早、更准地抓到。 */
  const pos = Object.freeze({ x: 1.5, y: 2.25, z: 3 });
  const first = placementForHeight(pos, 1);
  for (let i = 0; i < 5; i += 1) {
    eq(placementForHeight(pos, 1), first, `第 ${i + 2} 次同输入必须同输出(不许依赖调用历史)`);
  }
  eq(pos, { x: 1.5, y: 2.25, z: 3 }, '入参 pos 不得被改');
  eq(first.sprite, { x: 1.5, y: 2.25, z: 4 }, '结果字面量');
  /* 返回**新对象**:否则调用方一改就污染后续调用(而且不会有任何提示) */
  const second = placementForHeight(pos, 1);
  ok(first !== second && first.sprite !== second.sprite && first.cameraFocus !== second.cameraFocus,
    '每次调用都必须返回新对象/新子对象');
  first.sprite.z = 999;
  eq(placementForHeight(pos, 1).sprite.z, 4, '改上一次的结果不许影响下一次调用');
  /* 与「地形高程」是纯加法的正面证据:入参没变 ⇒ 结果不变 */
  eq(placementForHeight(pos, 1), placementForHeight({ x: 1.5, y: 2.25, z: 3 }, 1),
    '同值的另一个对象也必须给同结果(不按引用缓存)');
});

/* ═══════════ 6. 与 camera_follow 不冲突 ═══════════ */

test('FND48-6 与 camera_follow 不冲突:z=0 时地面口径逐字段相同,且 z 不许碰 x/y', () => {
  /* 变红条件:把高度混进相机的 x/y(相机会在地面上滑走)、或让 z=0 时相机目标
     与 `cameraTargetFor` 的今天输出不同(既有跟随表现被改)?**两条都会红**。 */
  const p = { x: 12.5, y: 30.25 };
  const today = cameraTargetFor(p, CAMERA_OPTS);
  const at0 = placementForHeight({ x: 12.5, y: 30.25, z: 0 }, 0).cameraFocus;
  eq({ x: at0.x, y: at0.y }, today, 'z=0 ⇒ 相机的**地面**口径与 camera_follow 今天逐字段相同');
  eq(today, { x: 12.5, y: 30.25 }, '世界内的权威位置本就不该被夹(基线自证)');

  /* camera_follow 的入口只读 x/y:**多带一个 z 也结构性忽略**(所以两者不会互相污染) */
  /* ⚠️ 取**世界内部**的点(20, 30):贴边的点会被 `edgePad = 8` 夹到 8,那是边界保护的
     行为,与 z 无关 —— 拿贴边点来测「z 有没有被吃进去」会得到一个假红。 */
  const withZ = { x: 20, y: 30, z: 7 };
  const withZTarget = cameraTargetFor(withZ, CAMERA_OPTS);
  eq(withZTarget, { x: 20, y: 30 }, 'camera_follow 不看 z(结构上不吃第三个分量)');
  ok(withZTarget !== null, '前提:世界内的点必须有目标(否则下面那条断言没有意义)');
  eq(stepCamera({ x: 20, y: 30 }, withZTarget!, 1 / 60, CAMERA_SMOOTHING_SEC),
    { x: 20, y: 30 }, '已在目标上 ⇒ stepCamera 原地不动(z 不参与它的判定)');

  /* z 变化**只**改高度分量:把同一 (x,y) 的 z 从 0 拉到 3,x/y 一个数都不许动 */
  let prev = placementForHeight({ x: 12.5, y: 30.25, z: 0 }, 0);
  for (const z of [0.5, 1, 2, 3]) {
    const cur = placementForHeight({ x: 12.5, y: 30.25, z }, 0);
    eq({ x: cur.cameraFocus.x, y: cur.cameraFocus.y }, today, `z=${z} 时相机地面口径仍须等于今天`);
    ok(cur.cameraFocus.z >= prev.cameraFocus.z, `z=${z} 时高度分量不许反向`);
    prev = cur;
  }
  /* 相机高度分量的**上界**与视口的关系:1 格 ≈ sin35° ≈ 0.57 显示单位 ⇒ 远小于半屏,
     所以「部分跟随 + 护栏」不会把角色挤出画面(粗算,不是像素级断言)。 */
  ok(CAMERA_HEIGHT_MAX_OFFSET * Math.sin((35 * Math.PI) / 180) < 1,
    '护栏 1 格在屏幕纵向上的偏移必须远小于半屏');
});

/* ═══════════ 7. ★弱判据:接线点(源码文本)+ 模块纯净性 ═══════════ */

test('FND48-7 ★弱:boot.ts 真的接了**两条**线(立牌 z + 相机 focusZ),模块零三方、不 import 服务端', () => {
  /* ⚠️⚠️ 弱判据声明 ⚠️⚠️
     `three/boot.ts` 的闭包含三方 `three` ⇒ node 里 import 不了(全仓无测试 import 它)。
     下面只读**源码文本(剥注释)**,它证明的是「这两个调用点**存在**」,
     而**不**证明运行期行为正确 —— 行为由 FND48-1..6(强)+ vite 构建门禁覆盖。
     不要把这一节读成「行为已验证」。 */
  const boot = readCode('client/src/three/boot.ts');
  ok(/from '\.\.\/net\/height_placement\.ts'/.test(boot),
    'boot.ts 必须从 height_placement.ts 导入(否则模块存在但没接线)');
  ok(/playerGz = localPlayerZOf\(authority\.state, authority\.localPlayerId\)/.test(boot),
    '每帧必须从**权威状态**取高度(与 x/y 同源,不许自己猜 z)');
  ok(/playerMarkerPlacement\(center, zAt\)/.test(boot),
    '立牌仍走 playerMarkerPlacement(地形高程来源没换)');
  ok(/placementForHeight\(/.test(boot), '摆放必须经纯函数合成(不许在 boot.ts 里另写一份算术)');
  ok(/playerMarker\.position\.set\(/.test(boot), '合成结果必须真的写到精灵上');
  ok(/c\.focusZ = cameraFocusZ/.test(boot),
    '相机的高度分量必须真的塞进逻辑相机(只抬立牌不抬镜头 = 漏了一半)');
  ok(/from '\.\.\/net\/camera_follow\.ts'/.test(boot),
    '相机跟随仍走 camera_follow(本任务不许换掉那条路)');

  /* 新模块的纯净性:本仓「可测」的前提 —— 一旦引入三方或服务端模块,上面所有行为判据都跑不起来 */
  const mod = readCode('client/src/net/height_placement.ts');
  ok(!/from '[^']*three'/.test(mod), '零三方:不许 import three');
  ok(!/from '[^']*\/server\//.test(mod), '不许 import 服务端模块(那一半不归客户端)');
  ok(!/\benum\b|namespace |@[A-Za-z]/.test(mod), '不许 enum / namespace / 装饰器(不可擦除语法)');
  const rel = [...mod.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
  ok(rel.length === 1 && rel[0] === '../../../shared/types/wire.ts',
    `相对导入只允许那一条 type-only imports(实测 ${rel.join(', ')})`);
  ok(rel.every((p) => p.endsWith('.ts')), '相对导入必须以 .ts 结尾(node 原生擦除)');
});

report('WS-FND-48-client-z');
