/**
 * WS-FND-60 —— D-08 第二步:**虚拟摇杆画在屏幕上**(纯 DOM 层)。
 *
 * ## 本套件存在的理由
 *
 * D-08 裁定「主输入 = 手机虚拟摇杆」,判定层(`net/joystick.ts`)已有 FND-58
 * 的 5 条钉着 —— 但屏幕上**没有手柄**。判定再绿,玩家按下去看不见东西,
 * 主输入这件事在手机上就等于没有。`client/src/ui/joystick_ui.ts` 补的就是这半。
 *
 * ## 为什么判据落在「纯函数 + 源码契约」而不是外观
 *
 * node 里没有 DOM(这正是 `joystick_ui.ts` 把 `document` 全塞进 `mount(el)` 的原因):
 * 像素长相**测不到**,所以不假装测它。能机械钉住的是:
 * ```
 * 1 无 DOM 环境 import / 构造 / 调用都不抛 ← 上面那条前提不成立的话,后面全跑不到
 * 2 帽位移的夹取与方向(纯函数,给字面量)
 * 3 死区与逻辑层**同一条**判据(同口径:帽不动 = 推力为 0)
 * 4 本模块不许 import three / server、不许建 .css(零构建)
 * 5 main.ts 真的接了线(只画不接 = 玩家看不见,且不报错)
 * 6 负对照:NaN / Infinity ⇒ 精确零向量
 * 7 几何不变量:帽最远点仍在底盘内、底盘被夹进视口
 * ```
 * **没有**钉住的部分(如实写明,别当成已验):真机手感、颜色对比度、浏览器里的
 * 入场/退场观感、以及 `prefers-reduced-motion` 的实际表现 —— 这些要在真浏览器里看。
 *
 * ## 逐条的注入靶子(每条都写明"改坏哪里会红")
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 无 DOM 下 import / 构造 / 空调用都不抛 | 在构造里 `document.createElement` |
 * | 2 | 超程 ⇒ 幅值恰为 radius、方向保持 | 去掉夹取(`scale` 写 1)/ 分量各自截断(方向歪) |
 * | 3 | 死区内(含边界)⇒ 帽偏移 0 | 去掉死区判定 / 换一个死区常量 |
 * | 4 | 零 three、零 server、零 css、样式内联 | 为了画渐变去 import three / 新建样式表 |
 * | 5 | main.ts 的 show/moveTo/hide 与鼠标守卫顺序 | 删掉接线 / 把 `pointerType` 那道 return 挪到 show 之后 |
 * | 6 | NaN / Infinity ⇒ 精确零向量 | 去掉 `Number.isFinite` 那道门(帽会消失且不报错) |
 * | 7 | `BASE = TRAVEL + KNOB`、落点夹进视口 | 用 overflow:hidden 掩盖出圈 / 把推程改成另一个数 |
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEAD_ZONE_RADIUS_PX,
  KNOB_RADIUS_PX,
  STICK_BASE_RADIUS_PX,
  STICK_TRAVEL_PX,
  createJoystickUI,
  knobOffset,
  placeBase,
} from '../client/src/ui/joystick_ui.ts';
import {
  JOYSTICK_DEAD_ZONE,
  STICK_RADIUS_PX,
  stickVector,
} from '../client/src/net/joystick.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 读**代码态**(剥注释)。
 *
 * 本套件的 4/5 要判"代码里有没有这一行",而 `joystick_ui.ts` 的 docblock 里
 * **确实**写着 "零 three / 零 server"(它正在解释自己的分层)⇒ 查原文会**假红**。
 * 剥法与 `tests/WS-FND-58` / `WS-FND-16` 的 `readCode` 同形;
 * 那份不在 `shared/**`(冻结层)里,故各留一份三行实现。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/* ═══════════════ 1. 无 DOM 环境(判据可测的前提)═══════════════ */

test('FND60-1 无 DOM 下 import / 构造 / 空调用都不抛:DOM 访问全在 mount(el) 里', () => {
  /* 前提本身也要断言:哪天跑进 jsdom,这条就退化成空断言(而它看起来还是绿的)。 */
  eq(typeof (globalThis as { document?: unknown }).document, 'undefined',
    '本判据的前提:node 里没有 document');
  ok(typeof createJoystickUI === 'function', '必须导出工厂 createJoystickUI');

  const ui = createJoystickUI();
  eq([ui.mounted, ui.visible], [false, false], '构造后:没挂载、不可见');

  /* 未挂载时全部方法必须是**空操作**而不是抛错:
     "先 show 后 mount"这种顺序不该把整页炸掉(那样错误只会出现在真机上)。 */
  ui.show(120, 400);
  ui.moveTo(40, -40);
  ui.hide();
  ui.dispose();
  eq([ui.mounted, ui.visible], [false, false], '空操作之后状态仍一致');
});

/* ═══════════════ 2. 纯部分:帽位移的夹取与方向 ═══════════════ */

test('FND60-2 超程 ⇒ 方向保持、幅值**恰为** radius(夹取,不是归一化丢弃)', () => {
  const R = 64;
  const far = knobOffset(1000, 1000, R);
  const mag = Math.hypot(far.x, far.y);
  near(mag, R, 1e-9, '字面量:dx=dy=1000、radius=64 ⇒ 幅值恰 64');
  ok(mag <= R, '幅值不许超过 radius —— 帽飞不出底盘');
  ok(far.x > 0 && far.y > 0, '方向保持(右下:两个分量都必须为正)');
  near(far.x, far.y, 1e-9, '45° 输入 ⇒ 两个分量相等(方向没被拧歪)');
  near(far.x, R / Math.SQRT2, 1e-9, '分量 = R/√2');

  /* 未超程 ⇒ **原样**返回(不缩、不抬):缩放系数必须是精确 1。 */
  eq(knobOffset(30, 40, R), { x: 30, y: 40 }, 'r=50 < 64 ⇒ 原样');
  eq(knobOffset(0, -R, R), { x: 0, y: -64 }, '恰在推程上 ⇒ 原样(边界不缩)');

  /* 夹取与"丢弃"的区别:超程后长度**恰为** R,而不是变成单位向量(1)。 */
  eq(Math.hypot(knobOffset(0, 100000, R).y, 0), R, '超程只夹取长度');
});

test('FND60-3 死区与逻辑层**同口径**:死区内(含边界)帽不动,过一点才动', () => {
  const R = STICK_TRAVEL_PX;
  eq(DEAD_ZONE_RADIUS_PX, JOYSTICK_DEAD_ZONE * R, '死区半径由逻辑层的比例算出,不是另写的像素数');
  eq(knobOffset(0, 0, R), { x: 0, y: 0 }, '原点');
  eq(knobOffset(5, 0, R), { x: 0, y: 0 }, '明显没推 ⇒ **精确**零(帽不该跟着手指抖)');
  eq(knobOffset(DEAD_ZONE_RADIUS_PX, 0, R), { x: 0, y: 0 }, '边界取死侧');

  /* ★ 同口径的正面对照:同一对 (dx, R) 在两个函数上必须给出同一个"推没推"。 */
  eq(stickVector({ dx: DEAD_ZONE_RADIUS_PX, dy: 0 }, { maxRadius: R }).magnitude, 0,
    '逻辑层也判"没推"(同一条边界)');
  const out = knobOffset(DEAD_ZONE_RADIUS_PX + 1, 0, R);
  ok(out.x > 0, `刚过死区 ⇒ 帽必须动(实测 x=${out.x})`);
  ok(stickVector({ dx: DEAD_ZONE_RADIUS_PX + 1, dy: 0 }, { maxRadius: R }).magnitude > 0,
    '逻辑层也必须判定"推了"');
});

/* ═══════════════ 3. 源码契约:分层与零构建 ═══════════════ */

test('FND60-4 ★ 源码契约:绘制层零 three、零 server、零 .css(样式内联)', () => {
  const src = readCode('client/src/ui/joystick_ui.ts');
  ok(src.length > 0, '文件必须读得到(改路径要红)');
  ok(!/from\s+['"][^'"]*three/.test(src), '绘制层不许 import three(它是 DOM 层,three 在 three/boot.ts)');
  ok(!/from\s+['"][^'"]*server\//.test(src), '客户端不许 import server/');
  ok(!/import\s+['"][^'"]*\.css['"]/.test(src), '不许 import 样式表');
  ok(!existsSync(join(ROOT, 'client/src/ui/joystick_ui.css')),
    '不许新建 .css 文件(零构建:样式以内联字符串写在模块里)');
  ok(src.includes('.style.cssText'), '样式必须真的以内联 cssText 写在模块里(与 three/boot.ts 的 makeHud 同形)');
  ok(!/transition\s*:\s*all/.test(src), '`transition: all` 是被禁的写法');
  /* 反向对照:常量必须**取自**逻辑层,否则死区/推程会各写一份(迟早分叉) */
  ok(/from\s+'\.\.\/net\/joystick\.ts'/.test(src),
    '必须从 net/joystick.ts 取 JOYSTICK_DEAD_ZONE / STICK_RADIUS_PX');
});

test('FND60-5 ★ 接线:main.ts 真把摇杆层接进了指针链路(代码态)', () => {
  const main = readCode('client/src/main.ts');
  ok(/from\s+'\.\/ui\/joystick_ui\.ts'/.test(main), 'main.ts 必须 import ui/joystick_ui.ts(只画不接就是本仓记过的形态)');
  ok(/createJoystickUI\(\)/.test(main), '必须真的建出这一层');
  ok(/stickUI\.mount\(/.test(main), '必须挂进 DOM(不 mount 则永远不可见)');
  eq((main.match(/stickUI\.show\(/g) ?? []).length, 1, '落指只有一处 show');
  eq((main.match(/stickUI\.moveTo\(/g) ?? []).length, 1, '拖动只有一处 moveTo');
  ok(/stick\.end\(\);\s*stickUI\.hide\(\)/.test(main),
    '抬手:逻辑归零与视觉隐藏必须在**同一处**(漏掉的话屏上永远挂着一个手柄)');

  /* 鼠标不弹摇杆 —— 守卫必须排在 show **之前**;反过来是"鼠标点一下也弹手柄"。 */
  ok(/pointerType === 'mouse'[\s\S]{0,400}?stickUI\.show\(/.test(main),
    '`pointerType === mouse` 的提前 return 必须排在 stickUI.show 之前');
  ok(/onStickEnd/.test(main) && /pointercancel/.test(main),
    'pointercancel 仍与 pointerup 同一处理(来电后角色不许一直走)');
  ok(/stickUI\.visible/.test(main), '自检口径必须暴露摇杆可见性(否则"弹没弹"只能靠肉眼)');

  /* 负对照:既有链路不许被这次接线改坏(FND-58 的断言还在跑) */
  ok(/mergeCmd\(input\.nextCmd\(\), stick\.vector\(\)\)/.test(main), '命令仍由 键盘 + 摇杆向量 合并');
  eq((main.match(/session\.sendMove\(/g) ?? []).length, 1, '上行发送点仍然唯一');
});

/* ═══════════════ 4. 负对照与几何不变量 ═══════════════ */

test('FND60-6 负对照:NaN / Infinity / radius<=0 ⇒ 精确零向量(不许把 NaN 写进 style)', () => {
  const z = { x: 0, y: 0 };
  eq(knobOffset(Number.NaN, 0, 64), z, 'NaN dx');
  eq(knobOffset(0, Number.NaN, 64), z, 'NaN dy');
  eq(knobOffset(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 64), z, '双无穷');
  eq(knobOffset(10, 0, 0), z, 'radius=0 是配置错误 ⇒ 零向量(不是除零得 NaN)');
  eq(knobOffset(10, 0, Number.NaN), z, 'NaN radius');
  eq(knobOffset(10, 0, -3), z, '负 radius');
  eq(knobOffset(10, 0, 64, Number.NaN), { x: 10, y: 0 }, 'deadZone 非法 ⇒ 当 0(不把整只手柄变成 NaN)');

  for (const p of [knobOffset(Number.NaN, 3, 64), knobOffset(1e9, 1e9, 64), knobOffset(0, 1e-9, 64)]) {
    ok(Number.isFinite(p.x) && Number.isFinite(p.y), '输出不许含 NaN / Infinity');
  }
});

test('FND60-7 ★ 几何不变量:帽推到极限也贴住盘边;底盘整体被夹进视口', () => {
  eq(STICK_TRAVEL_PX, STICK_RADIUS_PX, '视觉推程必须**就是**逻辑层的满舵距离(同一个数,不是两个 64)');
  eq(STICK_BASE_RADIUS_PX, STICK_TRAVEL_PX + KNOB_RADIUS_PX, '底盘 = 推程 + 帽半径');

  /* 任意方向、任意推程下,帽最远的那一点仍在底盘内 ⇒ 不需要 overflow:hidden 掩盖。 */
  for (const [dx, dy] of [[64, 0], [1000, 1000], [0, -64], [-45, 45], [0, 0]]) {
    const o = knobOffset(dx, dy, STICK_TRAVEL_PX);
    ok(Math.hypot(o.x, o.y) + KNOB_RADIUS_PX <= STICK_BASE_RADIUS_PX + 1e-9,
      `帽越过了盘边:(${dx},${dy}) ⇒ ${Math.hypot(o.x, o.y) + KNOB_RADIUS_PX} > ${STICK_BASE_RADIUS_PX}`);
  }

  /* 落点在屏幕边缘时,底盘整体仍在视口内(视口 390×844,底盘半径 86,留白 8)。 */
  eq(placeBase(2, 2, STICK_BASE_RADIUS_PX, 390, 844), { x: 94, y: 94 }, '左上角落指 ⇒ 夹到 86+8');
  eq(placeBase(388, 842, STICK_BASE_RADIUS_PX, 390, 844), { x: 296, y: 750 }, '右下角落指同理');
  eq(placeBase(195, 420, STICK_BASE_RADIUS_PX, 390, 844), { x: 195, y: 420 },
    '视口内落指**不能被动**(夹取只救边缘,不许挪动正常落点)');
  eq(placeBase(2, 2, STICK_BASE_RADIUS_PX, 100, 100), { x: 50, y: 50 },
    '视口比底盘还窄 ⇒ 居中(不是把界夹成一条线之后跑出去)');
  const nan = placeBase(Number.NaN, Number.NaN, STICK_BASE_RADIUS_PX, 390, 844);
  ok(Number.isFinite(nan.x) && Number.isFinite(nan.y), 'NaN 落点也要给有限坐标');
});

report('WS-FND-60');
