/**
 * WS-FND-16 —— **AC15:`prediction.ts` 真的接上了生产链**(task-83 选乙)。
 *
 * ## 本套件存在的理由
 *
 * `HANDOVER` 的 AC15 一直是 `✗ 未达成(卡产品裁决)`,而"卡"的实物是:
 *
 * ```
 * net/prediction.ts   predictStep / reconcile / resimulate / pruneCmds / Interpolator
 *                     有单测(WS-07 的 D01…)、有文档,生产链上**零引用**
 *                     ⇒ 它被登记在 verify.ts 的 UNREACHABLE_EXEMPT 里,理由是
 *                       「真卡点在输入端:预测器要 InputCmd,而客户端无输入生产者」
 *                     而 WASD 当时驱动的是**相机平移**(three/boot.ts 的 pan.x += …)
 * ```
 *
 * ⇒ 2026-11-14 定为「乙」(WASD 驱角色),补两件东西:
 *   `net/input.ts`     —— 键 → `InputCmd`(生产端)
 *   `net/predictor.ts` —— 按 tick 推 `predictStep`、按权威姿态 `resimulate`
 * 以及**上行**:`session.sendMove` → `ws_server.ts` 的 `t:'move'` → `room.applyMove`。
 *
 * ## 这里测的是「接线」,不是「算法」
 *
 * `predictStep` 的速度/归一化、`reconcile` 的三档阈值已在 WS-07 的 D 段钉死。
 * 本套件**不重复**那些断言(重复=两份实现),只钉四件事:
 * ```
 * 1 键 → 命令:方向、seq 单调、jump 锁存、失焦清空
 * 2 命令 → 位移:`predictStep` 真的被喂到(且斜向不比直向快)
 * 3 权威 → 校正:三档各一条,且「无 ackedSeq」时队列有界
 * 4 上行帧形态:`encodeMoveUplink` 是**文本**帧且字段齐
 * ```
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';
import { ReconcileAction } from '../client/src/net/prediction.ts';
import { dirFromPressed, InputSource, attachKeyboard } from '../client/src/net/input.ts';
import { LocalPredictor, MAX_PENDING } from '../client/src/net/predictor.ts';
import { encodeMoveUplink } from '../client/src/net/session.ts';
import { parseMoveIntent } from '../server/src/net/ws_server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** 每步位移(格)—— 由**冻结层常量**算出,不写死 0.225。 */
const STEP = BASE_MOVE_SPEED * DT;

/**
 * 读**代码态**(剥注释)。
 *
 * ⚠️ 本文件需要的两条都是「代码里有没有这行」:注释里写着旧写法是很常见的
 * (本仓多处 docblock 会引用历史代码)⇒ 查原文会**假绿**。
 * 剥法与 `WS-FND-12` 的 `readCode` 同形;两处都不在 `shared/**` 里
 * (那一层是冻结的),故各留一份三行实现,并在两边都写明缘由。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════ 1. 键 → 命令 ═══════════ */

test('FND16-1 方向映射:W/S/A/D 与方向键等价,且 y 向下(与格坐标同向)', () => {
  /* 变红条件:有人把 W 改成正 y(数学坐标)—— 表现是「按 W 往下走」,
     而那**不会**让任何别的断言变红。 */
  const pressed = (...keys: string[]): ((k: string) => boolean) => (k) => keys.includes(k);
  eq(dirFromPressed(pressed('w')).moveY, -1, 'W 应是 -y(格坐标向下为正)');
  eq(dirFromPressed(pressed('s')).moveY, 1, 'S 应是 +y');
  eq(dirFromPressed(pressed('a')).moveX, -1, 'A 应是 -x');
  eq(dirFromPressed(pressed('d')).moveX, 1, 'D 应是 +x');
  eq(dirFromPressed(pressed('arrowup')).moveY, -1, '↑ 与 W 等价');
  eq(dirFromPressed(pressed('arrowleft')).moveX, -1, '← 与 A 等价');
  const diag = dirFromPressed(pressed('w', 'd'));
  eq(`${diag.moveX},${diag.moveY}`, '1,-1', 'W+D 应是 (+1,-1)');
  const none = dirFromPressed(() => false);
  eq(`${none.moveX},${none.moveY}`, '0,0', '没按键 ⇒ 零输入');
});

test('FND16-2 命令:seq 单调递增、零输入也发、jump 恰好锁存一次', () => {
  /* 变红条件:
       1 零输入时不发命令 ⇒ 服务端永远不知道玩家松手(角色继续走);
       2 jump 不锁存 ⇒ 按住空格在 20Hz 下每秒发 20 次跳跃。 */
  const src = new InputSource();
  const idle = src.nextCmd();
  eq(idle.seq, 1, '第一个命令的 seq 应为 1');
  eq(`${idle.moveX},${idle.moveY}`, '0,0', '没按键 ⇒ 零输入命令(仍然要发)');
  src.press('d');
  const a = src.nextCmd();
  const b = src.nextCmd();
  eq(a.seq, 2, 'seq 应单调 +1');
  eq(b.seq, 3, 'seq 应单调 +1');
  eq(a.moveX, 1, '按着 D ⇒ moveX=1');
  src.release('d');
  eq(src.nextCmd().moveX, 0, '松开后应回到零输入');
  src.press(' ');
  const j1 = src.nextCmd();
  const j2 = src.nextCmd();
  eq(j1.jump, true, '按下空格后的**第一条**命令应带 jump');
  eq(j2.jump, false, '第二条不该再带(锁存,不是保持)');
});

test('FND16-3 键盘薄壳:按下/松开/失焦都作用到同一个 InputSource', () => {
  /* 变红条件:薄壳没接上事件(键按了但 source 不知道),或失焦不清空
     ⇒ 「按住 W → 切窗口 → 松手」后 W 永远按着。 */
  const handlers: Record<string, Array<(ev: { key: string }) => void>> = {};
  const target = {
    addEventListener: (t: string, fn: (ev: { key: string }) => void): void => {
      (handlers[t] ??= []).push(fn);
    },
    removeEventListener: (t: string, fn: (ev: { key: string }) => void): void => {
      handlers[t] = (handlers[t] ?? []).filter((f) => f !== fn);
    },
  };
  const src = new InputSource();
  const detach = attachKeyboard(target, src);
  handlers['keydown']?.forEach((f) => f({ key: 'W' }));
  eq(src.nextCmd().moveY, -1, 'W 按下应产生 -y 命令(且大小写不敏感)');
  handlers['blur']?.forEach((f) => f({ key: '' }));
  eq(src.pressedCount, 0, '失焦后应按键表清空');
  eq(src.nextCmd().moveY, 0, '失焦后不应再有位移');
  detach();
  eq((handlers['keydown'] ?? []).length, 0, '解绑后不应残留 keydown 监听');
});

/* ═══════════ 2. 命令 → 位移 ═══════════ */

test('FND16-4 ★ 按住 D ⇒ 命令经 predictStep 产生位移(AC15 的核心)', () => {
  /* 变红条件:输入端断开(命令恒零)或 predictor 不真调 predictStep
     ⇒ 位移为 0。这条就是「按键能不能让角色动」在无浏览器环境下的替代判据。 */
  const src = new InputSource();
  const pred = new LocalPredictor({ x: 10, y: 10, z: 0 });
  src.press('d');
  const steps = 5;
  let last = pred.pos;
  for (let i = 0; i < steps; i += 1) last = pred.step(src.nextCmd());
  eq(last.y, 10, '按 D 不应改变 y');
  ok(last.x > 10, `按 D 应让 x 增加(实测 ${last.x.toFixed(4)})`);
  /* 位移量由**冻结层常量**决定:5 步 × (BASE_MOVE_SPEED × DT) */
  ok(Math.abs(last.x - (10 + STEP * steps)) < 1e-9,
    `5 步位移应为 ${(STEP * steps).toFixed(4)} 格,实测 ${(last.x - 10).toFixed(4)}`);
  eq(pred.pendingCount, steps, '每条命令都应进入待确认队列');
});

test('FND16-5 斜向不比直向快(归一化只有一份,predictStep 里那份)', () => {
  /* 变红条件:某个调用方自己又归一化一次,或有人去掉 predictStep 里的归一化
     ⇒ 斜向位移 = 直向 × √2。 */
  const straight = new LocalPredictor();
  const diag = new LocalPredictor();
  const d = new InputSource();
  d.press('d');
  const wd = new InputSource();
  wd.press('w');
  wd.press('d');
  let a = straight.pos;
  let b = diag.pos;
  for (let i = 0; i < 3; i += 1) {
    a = straight.step(d.nextCmd());
    b = diag.step(wd.nextCmd());
  }
  const lenA = Math.hypot(a.x, a.y);
  const lenB = Math.hypot(b.x, b.y);
  ok(Math.abs(lenA - lenB) < 1e-9,
    `直向与斜向位移长度应相等(直 ${lenA.toFixed(4)} / 斜 ${lenB.toFixed(4)})`);
});

/* ═══════════ 3. 权威 → 校正 ═══════════ */

test('FND16-6 权威姿态三档:死区 IGNORE / 软误差 SMOOTH / 大误差 SNAP', () => {
  /* 变红条件:
       1 任何误差都 SNAP ⇒ 手感「一卡一跳」;
       2 任何误差都 IGNORE ⇒ 位置永不校正,服务端与客户端长期分叉。 */
  /* IGNORE:预测与权威一致(重演后误差 0) */
  const ig = new LocalPredictor();
  ig.step({ seq: 1, moveX: 1, moveY: 0, jump: false });
  const rIg = ig.onAuthoritative({ x: 0, y: 0, z: 0 });
  eq(rIg.action, ReconcileAction.IGNORE, '误差 0 应走死区');

  /* SMOOTH:软误差 ⇒ 位置对齐重演结果,并留下视觉偏移 */
  const sm = new LocalPredictor();
  sm.step({ seq: 1, moveX: 1, moveY: 0, jump: false });
  const rSm = sm.onAuthoritative({ x: 0.1, y: 0, z: 0 });
  eq(rSm.action, ReconcileAction.SMOOTH, '0.1 格误差应走软校正');
  ok(Math.abs(sm.pos.x - (0.1 + STEP)) < 1e-9, '软校正后位置应 = 权威 + 重演剩余命令');
  ok(Math.abs(sm.renderPos.x - sm.pos.x) > 0, '软校正应留下非零视觉偏移(供渲染收回)');

  /* SNAP:硬误差 ⇒ 直接采用权威值,并清空待确认队列 */
  const sn = new LocalPredictor();
  sn.step({ seq: 1, moveX: 1, moveY: 0, jump: false });
  const rSn = sn.onAuthoritative({ x: 5, y: 0, z: 0 });
  eq(rSn.action, ReconcileAction.SNAP, '5 格误差应硬对齐');
  eq(sn.pos.x, 5, '硬对齐后位置应就是权威值');
  eq(sn.pendingCount, 0, '硬对齐后队列应清空(位置已不可信,重演只会放大错误)');
});

test('FND16-7 有 ackedSeq 时剪队列;没有时队列**有界**(不是慢慢涨)', () => {
  /* 变红条件:
       1 有 ackedSeq 却不剪 ⇒ 重演范围随时间无限变大(表现为越玩越卡);
       2 没有 ackedSeq 且不截断 ⇒ 无界内存增长,而它**不报错**。 */
  const p = new LocalPredictor();
  for (let i = 1; i <= 3; i += 1) p.step({ seq: i, moveX: 1, moveY: 0, jump: false });
  eq(p.pendingCount, 3, '先有 3 条待确认');
  p.onAuthoritative({ x: 0, y: 0, z: 0, ackedSeq: 2 });
  eq(p.pendingCount, 1, 'ackedSeq=2 ⇒ 只应剩 seq 3');

  const q = new LocalPredictor();
  for (let i = 1; i <= MAX_PENDING + 5; i += 1) {
    q.step({ seq: i, moveX: 0, moveY: 0, jump: false });
  }
  /* ★ 断言的是**不变量**,不是那个常量本身:
     `eq(q.pendingCount, MAX_PENDING)` 会被同义反复检测器判为自证
     (拿实现里的常量去核实现里的行为,常量一改两边一起变)。
     这里改成算术恒等式:**留下来的 + 被丢掉的 = 一共喂进去的**
     —— 有人改上限不会误报,而有人"丢了却不计数"会当场红。 */
  eq(q.pendingCount + q.pendingTruncated, MAX_PENDING + 5, '留下的 + 丢掉的 应等于喂进去的总数');
  ok(q.pendingCount < MAX_PENDING + 5, `队列必须有界(实测 ${q.pendingCount} 条)`);
  eq(q.pendingTruncated, 5, '被丢掉的条数应被记下来(而不是静默)');
});

/* ═══════════ 4. 上行帧形态 + 生产引用 ═══════════ */

test('FND16-8 上行是**文本**帧且字段齐(二进制分支会被当协议包解析)', () => {
  /* 变红条件:isText 改成 false ⇒ 服务端走到 `decodePacket` 分支
     (那是**下行**包格式)⇒ 帧发出去、没人认领,且不报错。 */
  const frame = encodeMoveUplink({ tick: 7, x: 1.5, y: 2.5, z: 0 });
  eq(frame[0], 0x01, '首字节应是文本标记 0x01');
  const json = JSON.parse(new TextDecoder().decode(frame.subarray(1))) as Record<string, unknown>;
  eq(json['t'], 'move', '载荷应带 t="move"(服务端据此分流)');
  eq(json['tick'], 7, 'tick 应原样透传');
  eq(json['x'], 1.5, 'x 应原样透传');
  eq(json['y'], 2.5, 'y 应原样透传');
  eq(json['z'], 0, 'z 应原样透传');
});

test('FND16-9 ★ 生产引用:main.ts 真的装配了输入源 / 预测器 / 上行(代码态)', () => {
  /* 变红条件:有人在 main.ts 里删掉这三行之一 —— 那正是「模块存在但没接线」
     的复发形态,而它不会让任何行为断言变红(离线模式照常跑)。 */
  const main = readCode('client/src/main.ts');
  ok(/new InputSource\(\)/.test(main), 'main.ts 应构造 InputSource');
  ok(/attachKeyboard\(/.test(main), 'main.ts 应把输入源绑到键盘');
  ok(/new LocalPredictor\(/.test(main), 'main.ts 应构造 LocalPredictor');
  ok(/session\.sendMove\(/.test(main), 'main.ts 应真的上行移动意图');
  ok(/predictor\.onAuthoritative\(/.test(main), 'main.ts 应把权威姿态喂回预测器');

  /* `prediction.ts` 必须被**生产**模块 import(而不是只被测试 import) */
  const pred = readCode('client/src/net/predictor.ts');
  ok(/from '\.\/prediction\.ts'/.test(pred), 'predictor.ts 应从 prediction.ts 导入');
  ok(/predictStep\(/.test(pred), 'predictor.ts 应调用 predictStep');
  ok(/resimulate\(/.test(pred), 'predictor.ts 应调用 resimulate(重演,而不是直接赋值)');
});
/* ═══════════ 5. 上行入口(服务端那一侧) ═══════════ */
test('FND16-10 上行数值校验:NaN / Infinity / 缺字段必须被拦(不是穿过)', () => {
  /* 变红条件:`parseMoveIntent` 退化成只查 `typeof v === 'number'`
     ⇒ `NaN` 会**穿过**(`typeof NaN === 'number'` 恒真,且它比较恒 false
     ⇒ 连范围检查也拦不住)⇒ 它会一路走到 `checkMove`。 */
  const good = parseMoveIntent({ tick: 1, x: 1, y: 2, z: 0 });
  eq(good.ok, true, '四个有限数应通过');
  if (good.ok) eq(`${good.intent.x},${good.intent.y},${good.intent.z}`, '1,2,0', '坐标应原样透传');
  const nan = parseMoveIntent({ tick: 1, x: Number.NaN, y: 2, z: 0 });
  eq(nan.ok, false, '★ NaN 必须被拦(它穿得过类型与范围检查)');
  const inf = parseMoveIntent({ tick: 1, x: Number.POSITIVE_INFINITY, y: 2, z: 0 });
  eq(inf.ok, false, 'Infinity 必须被拦');
  const missing = parseMoveIntent({ tick: 1, x: 1, y: 2 });
  eq(missing.ok, false, '缺 z 必须被拦');
  const str = parseMoveIntent({ tick: 1, x: '1', y: 2, z: 0 });
  eq(str.ok, false, '字符串坐标必须被拦');
  /* speedMul 是**可选**:非法时当作没给,而不是整条拒绝 */
  const badMul = parseMoveIntent({ tick: 1, x: 1, y: 2, z: 0, speedMul: Number.NaN });
  eq(badMul.ok, true, '坏 speedMul 不该让整次移动消失');
  if (badMul.ok) eq(badMul.intent.speedMul, undefined, '坏 speedMul 应被忽略(不是 0、不是 NaN)');
  const goodMul = parseMoveIntent({ tick: 1, x: 1, y: 2, z: 0, speedMul: 2 });
  if (goodMul.ok) eq(goodMul.intent.speedMul, 2, '合法 speedMul 应透传');
});

test('FND16-11 文本上行按 `t` 分流:move 走移动,其余仍按 hello(代码态)', () => {
  /* 变红条件:分流被删 ⇒ 移动意图被当成 hello(并再 join 一次);
     或写成「只认 move」⇒ 客户端不带 `t` 的 hello 被拒 ⇒ 握手回归性断裂。 */
  const ws = readCode('server/src/net/ws_server.ts');
  ok(/parsed\.t === 'move'/.test(ws), '应显式判 t === "move"');
  ok(/onMove\(c, parsed/.test(ws), 'move 分支应交给 onMove');
  ok(/onHello\(c, parsed\)/.test(ws), '其余仍应走 onHello(不能只认 move)');
  ok(/apply\.call\(opts\.room, c\.userId, intent\)/.test(ws), '应把意图交给房间的 applyMove');
  ok(/c\.helloDone/.test(ws), '未 hello 就发 move 必须被拦(没有 userId 无法应用)');
});

report('WS-FND-16');