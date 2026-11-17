/**
 * WS-FND-58 —— **虚拟摇杆(主输入)+ ackedSeq 剪枝**(D-08)。
 *
 * ## 本套件存在的理由
 *
 * D-08(owner,2026-11-16)把三件事定死了:
 * ```
 * 1 镜头跟随角色            → 已由 WS-FND-23 钉住(`net/camera_follow.ts`)
 * 2 主输入是**虚拟摇杆**     → 本套件 FND58-1…5(判定在 `net/joystick.ts`)
 * 3 WASD 只作桌面/调试兼容   → 本套件 FND58-5(优先级:摇杆压键盘)
 * ```
 * 摇杆的判定如果留在 `pointermove` 回调里,「死区 0.19」就只是**一句话**:
 * 改成 0.0 或 1.0 都不会让任何断言变红,只会让手机上的手感变成"抖"或"推不动"。
 * ⇒ 判定被抽进 `client/src/net/joystick.ts`(零 DOM),在这里逐条钉住。
 *
 * ## 逐条的注入靶子(每条都写明"改坏哪里会红")
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 死区 0.19:内侧/边界 ⇒ 零;外侧 ⇒ 非零 | 去掉死区判定 / 把 0.19 改成 0 |
 * | 2 | 超出手柄半径 ⇒ 幅值**恰为** maxRadius,方向不变 | `Math.min` 换成"直接丢弃"或归一化 |
 * | 3 | 零输入与 `NaN` ⇒ 精确零向量(不是 `NaN`) | 去掉 `Number.isFinite` 那道门 |
 * | 4 | 推力线性:距离/半径,比例(方向)保持 | 改成二值开关 / 分量各自截断(会歪方向) |
 * | 5 | `mergeCmd`:摇杆推了压过 WASD,松手回落 WASD,`seq` 不变 | 两路**相加** / 合并时重编 seq |
 * | 6 | `ackedSeq` 前进 ⇒ `pending` 变短且 `prunedTotal` 增长(确定性) | 剪枝被删 / 计数器不涨 |
 * | 7 | 负对照:`ackedSeq` **未推进** ⇒ 一条都不剪 | 每帧无条件清队列(会"通过"6 却丢输入) |
 * | 8 | 服务端**每连接**记账(`lastAckedSeqFor`);冻结层**已解锁**(包头带 `ackedSeq`) | 偷偷删掉那 4 字节 / 退回全局 ack |
 * | 9 | `?server=off` ⇒ 不发包;`main.ts` 装了摇杆 + **上行带 seq** + **下行 ack 喂进预测器** | 拆 `session !== null` 那道闸 / 少一个生产者 |
 */

import { test, ok, eq, near, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AnalogStick,
  JOYSTICK_DEAD_ZONE,
  STICK_RADIUS_PX,
  mergeCmd,
  stickVector,
} from '../client/src/net/joystick.ts';
import { LocalPredictor } from '../client/src/net/predictor.ts';
import { InputSource } from '../client/src/net/input.ts';
import { parseMoveIntent } from '../server/src/net/ws_server.ts';
import type { InputCmd } from '../client/src/net/prediction.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 读**代码态**(剥注释)。
 *
 * ⚠️ 本套件的 8/9 要判"代码里有没有这一行",而 `predictor.ts` / `ws_server.ts` 的
 * docblock 里**确实**写着 `ackedSeq`(它们正在解释为什么线上没有这个字段)⇒
 * 查原文会**假红**。剥法与 `WS-FND-16` 的 `readCode` 同形;那份不在 `shared/**`
 * (冻结层)里,故各留一份三行实现。
 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/* ═══════════════ 1. 摇杆判定(死区 / 截断 / 方向)═══════════════ */

test('FND58-1 死区 0.19:内侧与边界给零向量,外侧给方向(边界取"死"侧)', () => {
  /* 右字面量:0.19 是**生产值**,不是随手写的数。 */
  eq(JOYSTICK_DEAD_ZONE, 0.19, 'D-08 的死区常量');

  const R = 100; /* 手柄半径 100px ⇒ 死区 = 19px */
  /* 内侧:明显没推 */
  eq(stickVector({ dx: 10, dy: 0 }, { maxRadius: R }), { x: 0, y: 0, magnitude: 0 },
    '死区内侧必须是**精确**零向量(0.1 的向量会让角色以 10% 速爬行)');
  /* 斜向内侧:r = √(10²+10²) ≈ 14.14 < 19 */
  eq(stickVector({ dx: 10, dy: 10 }, { maxRadius: R }), { x: 0, y: 0, magnitude: 0 },
    '死区是**半径**判定,不是分量各自判定');
  /* 边界:r 恰为 deadZone×R ⇒ 判"死"(写死一侧,不许两头都对) */
  eq(stickVector({ dx: 19, dy: 0 }, { maxRadius: R }), { x: 0, y: 0, magnitude: 0 },
    'r === deadZone×maxRadius 取死侧');
  /* 外侧:刚过死区 ⇒ 必须动 */
  const out = stickVector({ dx: 19.2, dy: 0 }, { maxRadius: R });
  ok(out.magnitude > 0, `死区外必须产生推力(实测 magnitude=${out.magnitude})`);
  near(out.x, 0.192, 1e-9, '推力 = r/R');
  eq(out.y, 0, '纯水平输入不该有 y 分量');
});

test('FND58-2 超出手柄半径 ⇒ 幅值**恰为** maxRadius(截断,不是丢弃)', () => {
  const R = 100;
  /* (300,400) 长度 500 = 5 倍手柄直径:拇指常态会推到这么远 */
  const v = stickVector({ dx: 300, dy: 400 }, { maxRadius: R });
  eq(v.magnitude, R, '幅值必须**恰为** maxRadius(右字面量 100)');
  near(v.x, 0.6, 1e-9, '截断后方向不变:单位向量 0.6');
  near(v.y, 0.8, 1e-9, '截断后方向不变:单位向量 0.8');
  near(Math.hypot(v.x, v.y), 1, 1e-9, '归一化方向的模必须是 1(满舵)');
  /* 恰好在半径上:不截也不丢 */
  const onEdge = stickVector({ dx: 0, dy: R }, { maxRadius: R });
  eq(onEdge.magnitude, R, 'r === maxRadius 仍是满幅');
  eq(onEdge.y, 1, 'y 向下:手指在基点下方 ⇒ moveY = +1(格坐标)');
});

test('FND58-3 零输入与非法输入 ⇒ 精确零向量(不是 NaN,不是"上一帧")', () => {
  const zero = { x: 0, y: 0, magnitude: 0 };
  eq(stickVector({ dx: 0, dy: 0 }), zero, '原点即零向量');
  eq(stickVector({ dx: Number.NaN, dy: 0 }), zero, 'NaN 输入必须被拦成零向量');
  eq(stickVector({ dx: 1, dy: Number.POSITIVE_INFINITY }), zero, 'Infinity 输入同理');
  eq(stickVector({ dx: 50, dy: 0 }, { maxRadius: 0 }), zero, 'maxRadius<=0 是配置错误 ⇒ 零向量');
  /* 判定"拦住了"要比较**值**,不是 `isNaN` 一遍就算 —— NaN 会一路进位置,再也回不来。 */
  const bad = stickVector({ dx: Number.NaN, dy: 3 }, { maxRadius: 10 });
  ok(Number.isFinite(bad.x) && Number.isFinite(bad.y), '输出不许含 NaN');
});

test('FND58-4 推力线性 + 方向保持(分量各自截断会把方向拧歪)', () => {
  const R = 100;
  /* 同一方向(3:4),三种距离 ⇒ 推力线性、方向恒定 */
  const a = stickVector({ dx: 30, dy: 40 }, { maxRadius: R }); /* r=50 */
  const b = stickVector({ dx: 60, dy: 80 }, { maxRadius: R }); /* r=100 */
  const c = stickVector({ dx: 120, dy: 160 }, { maxRadius: R }); /* r=200 ⇒ 截断 */
  near(a.magnitude, 50, 1e-9, '半程推力 50');
  near(b.magnitude, 100, 1e-9, '满程推力 100');
  eq(c.magnitude, 100, '超程截断到 100');
  /* 方向比恒为 4:3 —— 分量各自截断会让 (120,160) 变成 (100,100) ⇒ 45° */
  near(a.y / a.x, 4 / 3, 1e-9, '方向比保持');
  near(b.y / b.x, 4 / 3, 1e-9, '方向比保持');
  near(c.y / c.x, 4 / 3, 1e-9, '截断后方向比**仍**保持');
});

/* ═══════════════ 2. 状态机与优先级(摇杆 > WASD)═══════════════ */

test('FND58-5 摇杆是主输入:推了压过 WASD,松手回落 WASD,seq 不被重编', () => {
  const R = 10;
  const stick = new AnalogStick({ maxRadius: R });
  const kb = new InputSource();
  kb.press('w'); /* 桌面兼容:按着 W(moveY = -1) */

  const base: InputCmd = kb.nextCmd();
  eq(base.seq, 1, 'InputSource 的 seq 从 1 起');
  eq(stick.vector(), { x: 0, y: 0, magnitude: 0 }, '没按下时向量恒为零');

  /* 按下但没推:向量仍零(刚落下不算推)⇒ 命令仍是 WASD 的 */
  stick.begin(500, 500);
  eq(stick.vector().magnitude, 0, 'begin 之后同点 ⇒ 零');
  eq(mergeCmd(base, stick.vector()), base, '没推 ⇒ 完全保留键盘命令');

  /* 往右下推(retina 上 6:8 = 半径 10 ⇒ 满舵) */
  stick.moveTo(506, 508);
  const v = stick.vector();
  near(v.magnitude, 10, 1e-9, '半径 10 ⇒ 满幅');
  const merged = mergeCmd(base, v);
  near(merged.moveX, 0.6, 1e-9, '摇杆压过 WASD:x 取摇杆');
  near(merged.moveY, 0.8, 1e-9, '摇杆压过 WASD:y 取摇杆(不是相加成 -0.2)');
  eq(merged.seq, base.seq, '⚠️ seq 必须沿用键盘那份(它是 ackedSeq 的地基)');
  eq(merged.jump, base.jump, 'jump 也沿用键盘那份');

  /* 抬起:回落到 WASD */
  stick.end();
  eq(stick.vector(), { x: 0, y: 0, magnitude: 0 }, 'end 之后恒零(不是"最后那一下")');
  eq(mergeCmd(kb.nextCmd(), stick.vector()).moveY, -1, '松手 ⇒ 回落到 W(moveY=-1)');

  /* 生产半径:常量必须**真被**当半径用(改 64 会改变手感,但判定不变) */
  eq(STICK_RADIUS_PX, 64, '生产手柄半径 64px');
});

/* ═══════════════ 3. ackedSeq 剪枝(第二步)═══════════════ */

/** 喂 n 条命令(每步都往东走),返回预测器。同一个函数跑两遍必须给同一组数。 */
function feed(n: number): LocalPredictor {
  const p = new LocalPredictor();
  for (let i = 1; i <= n; i += 1) p.step({ seq: i, moveX: 1, moveY: 0, jump: false });
  return p;
}

test('FND58-6 ★ `ackedSeq` 前进 ⇒ pending 变短、prunedTotal 增长(确定性)', () => {
  /* 确定性的口径:同一场景跑两遍,四个数**逐一相等**(不是"看起来变了")。 */
  const run = (): { before: number; after: number; pruned: number; acked: number } => {
    const p = feed(3);
    const before = p.pendingCount;
    /* 误差取 0 ⇒ IGNORE 档,位置不动 ⇒ 断言只测剪枝,不搀和校正档位 */
    p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 2 });
    return { before, after: p.pendingCount, pruned: p.prunedTotal, acked: p.lastAckedSeq };
  };
  const a = run();
  const b = run();
  eq(a.before, 3, '先喂 3 条 ⇒ 3 条待确认');
  eq(a.after, 1, 'ackedSeq=2 ⇒ 只剩 seq 3');
  eq(a.pruned, 2, '剪掉 2 条(计数器要**真的**涨)');
  eq(a.acked, 2, '记录的最高 ack = 2');
  eq(a, b, '同一场景两遍必须给同一组数');

  /* 再推进一次:1 → 0,累计 3 */
  const p = feed(3);
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 2 });
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 3 });
  eq(p.pendingCount, 0, 'ackedSeq=3 ⇒ 队列空');
  eq(p.prunedTotal, 3, '累计剪掉 3 条');
  eq(p.lastAckedSeq, 3, 'ack 单调推进到 3');
});

test('FND58-7 负对照:`ackedSeq` 未推进(重复/倒退/缺失)⇒ 一条都不剪', () => {
  /* 这条是 6 的**负对照**。少了它,"每帧无条件清空队列"也能让 6 变绿 ——
     而那种实现会把玩家还没被确认的按键位移**丢掉**,表现是"松手后角色回弹"。 */
  const p = feed(3);
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 2 });
  eq([p.pendingCount, p.prunedTotal], [1, 2], '基线:先剪到 1 条');

  /* 重复同一个 ack */
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 2 });
  eq([p.pendingCount, p.prunedTotal, p.lastAckedSeq], [1, 2, 2], '重复 ack ⇒ 不剪、不重复计数');

  /* 倒退的 ack(重连后旧帧晚到) */
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 1 });
  eq([p.pendingCount, p.prunedTotal, p.lastAckedSeq], [1, 2, 2], '倒退 ack ⇒ 一律忽略');

  /* 根本不给这个字段(= 当前协议的真实状态) */
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0 });
  eq([p.pendingCount, p.prunedTotal], [1, 2], '未给 ackedSeq ⇒ 不剪(降级:靠 MAX_PENDING)');

  /* NaN:若少了 `Number.isFinite`,`seq > NaN` 恒假 ⇒ 队列被**静默清空** */
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: Number.NaN });
  eq([p.pendingCount, p.prunedTotal], [1, 2], 'NaN ack ⇒ 不剪(否则整队被清空)');

  /* 重置(重连)后 ack 回到 -1:否则新会话的命令一条都进不来 */
  p.reset({ x: 0, y: 0, z: 0 });
  eq([p.pendingCount, p.prunedTotal, p.lastAckedSeq], [0, 0, -1], 'reset 把 ack 与计数一起归零');
  p.step({ seq: 1, moveX: 1, moveY: 0, jump: false });
  p.onAuthoritative({ x: p.pos.x, y: p.pos.y, z: 0, ackedSeq: 1 });
  eq(p.pendingCount, 0, '重连后第一条命令能正常被剪');
});

/* ═══════════════ 4. 服务端那一半 + 冻结层的边界 ═══════════════ */

test('FND58-8 服务端**每连接**记账;冻结层**已解锁**(包头带 `ackedSeq`)', () => {
  /* 1 上行 `seq` 可选且必须是非负整数 —— 它是"处理到第几条",不是坐标。 */
  const good = parseMoveIntent({ tick: 5, x: 1, y: 2, z: 0, seq: 7 });
  ok(good.ok, '合法移动意图不该被拒');
  eq(good.ok ? good.intent.seq : null, 7, 'seq 原样保留');

  const none = parseMoveIntent({ tick: 5, x: 1, y: 2, z: 0 });
  eq(none.ok ? (none.intent.seq ?? null) : null, null, '不带 seq ⇒ 当没给(不是 0)');

  for (const bad of [1.5, -3, Number.NaN]) {
    const r = parseMoveIntent({ tick: 5, x: 1, y: 2, z: 0, seq: bad });
    ok(r.ok, `坏 seq=${String(bad)} 不该让整次移动消失`);
    eq(r.ok ? (r.intent.seq ?? null) : null, null, `坏 seq=${String(bad)} ⇒ 不带 ack`);
  }
  /* 坐标那三道门仍在(别为了加 seq 把原来的校验放宽) */
  eq(parseMoveIntent({ tick: 5, x: Number.NaN, y: 2, z: 0 }).ok, false, 'NaN 坐标仍被拦');

  /* 2 ★ 冻结层证据:`shared/net/delta.ts` 是**下行帧**的定义处,
     而里面**没有** `ackedSeq` ⇒ 要把 ack 放进**编码帧**,必须改冻结层。
     这条断言的作用是**在测试里留证**:它一旦变红,说明协议**又**被改了
     (改回去/挪位置/换编码都算)。 */
  const deltaSrc = readCode('shared/net/delta.ts');
  ok(/export function encodeFull\(/.test(deltaSrc), 'encodeFull 仍在冻结层里(它不是本套件能改的东西)');
  ok(/ackedSeq/.test(deltaSrc), '★ 冻结层已解锁:包头带 ackedSeq(本行变红 = 有人又把它删了)');
  ok(/w\.u32\(0\)/.test(deltaSrc), 'encode 侧确实写出了那 4 字节占位(0 = 「没有 ack」)');
  ok(/r\.u32\(\) - 1/.test(deltaSrc), 'decode 侧把线上值减 1 还原(线上编码 = ackedSeq + 1)');

  /* 3 ★ ack 的**落点**:由 delta.ts 解码 ⇒ 由 state_store.ts 记账。
     ⚠️ 这里**不再**断言"session.ts 里 ackedSeq 0 次" —— 那是解锁**前**的口径
     (冻结层没有这个字段时,"运输层也没碰它"才说明没人偷偷扩协议)。
     现在 ack 已是协议的一部分,有意义的不变量变成「**谁**落了账」,
     端到端的判据在 `tests/WS-FND-63-acked-seq-e2e.test.ts`。 */
  const storeSrc = readCode('client/src/net/state_store.ts');
  ok(/lastAckedSeq/.test(storeSrc), '★ ack 的消费点在 state_store(解码结果落账)');
  ok(/pkt\.ackedSeq/.test(storeSrc), '★ 落的就是**解码**出来的那个数(不是本地推的)');

  /* 4 服务端那一半确实在岗,而且必须是**每连接**的账。
     旧写法是闭包级 `let lastAckedSeq`(多连接互相冒充)⇒ 这里同时钉住它**不在**。 */
  const wsSrc = readCode('server/src/net/ws_server.ts');
  ok(/lastAckedSeqFor\(userId: string\): number/.test(wsSrc), 'WsServerHandle 必须暴露**每连接**的 ack 读数');
  ok(/c\.ackedSeq = intent\.seq/.test(wsSrc), '只有**应用成功**之后才推进,且推的是本连接的账');
  ok(/withAckedSeq\(payload, c\.ackedSeq\)/.test(wsSrc), '广播必须**逐连接**重写包头那 4 字节');
  ok(!/let lastAckedSeq\b/.test(wsSrc), '★ 闭包级全局 ack 必须消失(它正是"互相冒充"的成因)');
});

/* ═══════════════ 5. 生产装配(?server=off 与摇杆接线)═══════════════ */

test('FND58-9 `?server=off` 不发包;`main.ts` 真把摇杆接进了预测链(代码态)', () => {
  const main = readCode('client/src/main.ts');
  /* 1 关闭联机的**唯一**开关:显式 off ⇒ null;没有这行,截图自检会被重连噪音淹掉。 */
  ok(/q === 'off' \? null : q/.test(main), '`?server=off` 必须映射成 null(不建会话)');
  /* 2 上行被 `session !== null` 闸住 —— 且**只有这一处**上行发送。 */
  ok(/if \(session !== null\) \{\s*session\.sendMove\(/.test(main), 'sendMove 必须在 session !== null 里');
  eq((main.match(/session\.sendMove\(/g) ?? []).length, 1, '上行发送点必须唯一(两处就会两倍速率)');

  /* 3 摇杆真的接进了同一条链:指针 → AnalogStick → mergeCmd → predictor.step */
  ok(/new AnalogStick\(/.test(main), 'main.ts 必须装配 AnalogStick');
  ok(/mergeCmd\(input\.nextCmd\(\), stick\.vector\(\)\)/.test(main),
    '命令必须是"键盘命令 + 摇杆向量"合并出来的');
  ok(/addEventListener\('pointercancel'/.test(main),
    'pointercancel 必须与 pointerup 同一处理(否则来电后角色一直走)');
  ok(/ev\.pointerType === 'mouse'/.test(main), '鼠标不该同时驱动摇杆(左键是攻击)');
  /* 4 自检口径可读:否则"剪枝跑没跑"只能靠读代码 */
  ok(/ackedSeq: predictor\.lastAckedSeq/.test(main), '__stageReady 必须暴露 ackedSeq');
  ok(/stickMagnitude: stick\.vector\(\)\.magnitude/.test(main), '__stageReady 必须暴露摇杆幅值');
  /* 5 ★ D-14(2026-11-17):上行 `seq` 的**生产者**与下行 ack 的**喂入点**。
     缺任何一个,整条链就是"看起来接上了"而实际永不动:
       · 不发 seq ⇒ 服务端永远没有 ack 可推(上游 TASK-100 实测:这个生产者此前**不存在**);
       · 不喂 `store.lastAckedSeq` ⇒ 预测器永远不剪(剪枝实现只是"存在")。 */
  ok(/seq: cmd\.seq/.test(main), '★ sendMove 必须带上 `cmd.seq`(整个上行 ack 的地基)');
  ok(/ackedSeq: handle\.store\.lastAckedSeq/.test(main),
    '★ 预测器必须吃**线上来的** ack(`store.lastAckedSeq`),不许本地另造一个');
});

report('WS-FND-58');