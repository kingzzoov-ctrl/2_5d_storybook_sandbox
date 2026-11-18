/**
 * WS-FND-113 · **客户端预测链的五处缺口**(第五轮实测)
 *
 * ## 本套件存在的理由
 *
 * `prediction.ts` 的四个纯函数一直有判据(`WS-07`),`predictor.ts` 的剪枝也有判据
 * (`WS-FND-58`)。变绿的是**每一个零件**,而**整条装配链**一次都没被问过:
 * ```
 * 1 参数从来没传过        main.ts 全文无 speedMul / frozen / mu ⇒ 眩晕、击退、装备加速**必然**分歧
 * 2 预测结果零渲染消费    renderPos / visualOffset 全仓零读者 ⇒ 玩家看到的仍是滞后一个 RTT 的权威位置
 * 3 上行 z 恒为 0         predictor 的构造/reset/onAuthoritative 三处都写 z:0 ⇒ 权威高度被逐帧抹平
 * 4 重连不复位            reset() 只在首帧调一次;InputSource.seq / 摇杆也都还是上一轮的
 * 5 state_store 无单调门  ackedSeq 可倒退、meta.tick 无条件覆盖 ⇒ 旧帧能把权威位置拉回
 * ```
 * 「零件都对、合起来不对」正是本仓反复记的那一类 —— 它的症状全都**不报错**。
 *
 * ## 逐条判据与它的注入靶子
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | `predictParamsOf`:四种禁步态 ⇒ frozen;NORMAL/SLIPPING/AFK_SHIELD ⇒ 不冻结(**负对照**);越界/空输入 ⇒ 不冻结 | 表里少一个状态 / 改成"总是冻结" |
 * | 2 | `mu` / `speedMul` 从权威状态派生(滑 ⇒ 0.98、背人 ⇒ 0.85、否则 1) | 把 `mu` 写死 / 不读 carryingEntityId |
 * | 3 | 参数**真的**进 `predictStep`:冻结 ⇒ 0 格;mul=2 ⇒ 0.45 格。**注入**:不传参数 ⇒ 同场景走 0.225 格 | 参数只存不用 / 传了不生效 |
 * | 4 | 前推与重演**同一份**参数。**注入**:重演传 `{}` ⇒ 位置差一半(0.675 格) | onAuthoritative 不用 `this.params` |
 * | 5 | 渲染消费:SMOOTH 后 `pos == 权威`、`render == 权威 + 未收回偏移`;`absorbVisual` 单调收敛。**负对照**:不校正时 render == pos | 把 renderPos 接成 pos / 不发视觉偏移 |
 * | 6 | 坏值(坐标 NaN)⇒ `poseView()` 返回 `null`(调用方退回权威)。**负对照**:正常时非 null | 去掉 `Number.isFinite` 那道门 |
 * | 7 | 上行 z 来自权威:播种 z=2 ⇒ `pos.z === 2`;回喂 z=3 ⇒ 抬到 3。**注入**:修前的 z:0 ⇒ 0 | 播种/回喂写死 z:0 |
 * | 8 | 重连复位:`InputSource.reset` ⇒ seq 回 1、按键清空;`predictor.reset` ⇒ 队列/acked/参数清。**注入**:不复位 ⇒ seq 继续 2/3 | 复位只做一半 |
 * | 9 | 真重连:`reconnect()` 换 socket 并报 `onOpen(2)`、epoch=2、重发 hello;**负对照**:`close()` 不重连 | 复位不挂到 epoch 上 / close 也重连 |
 * | 10 | 被动掉线 ⇒ 自动重连(否则第 4 处的复位在生产里永不触发) | 只留 `reconnect()` 而没人调 = 死代码 |
 * | 11 | 单调门:旧 DELTA 被丢(`stale-frame`,位置不回退)。**注入**:直接 `applyPacket` 会回退;**豁免**:旧 FULL 仍接受 | 无条件覆盖 meta.tick / 连 FULL 一起丢 |
 * | 12 | `ackedSeq` 只进不退(`-1` 也不会抹掉已有值) | 直接赋值(`this.ackedSeq_ = pkt.ackedSeq`) |
 * | 13 | 装配点(源码文本,弱):参数 / 预测渲染 / 重连复位 / z / jump 五个生产者都在 | 少任一生产者 |
 *
 * ⚠️ 13 是**弱判据**:`three/boot.ts` 与 `main.ts` 都摸 DOM,node 里 import 不了。
 * 强判据是 1–12(全部可 import、可注入)。
 */

import { test, ok, eq, near, report, results } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARRY_SLOWDOWN, DT } from '../shared/types/physics.ts';
import { STATE_FLAG_NAMES, type PlayerState } from '../shared/types/wire.ts';
import { createPlayerState, createRoomState } from '../server/src/net/schema.ts';
import {
  PROTOCOL_VERSION, applyPacket, decodePacket, encodeDelta, encodeFull,
} from '../shared/net/delta.ts';

import {
  GROUND_MU,
  LocalPredictor,
  MOVE_BLOCKING_FLAGS,
  SLIPPERY_MU,
  predictParamsOf,
} from '../client/src/net/predictor.ts';
import { ReconcileAction } from '../client/src/net/prediction.ts';
import { InputSource } from '../client/src/net/input.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import {
  createSession, encodeMoveUplink, type SessionState,
} from '../client/src/net/session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 读**代码态**(剥注释)—— 注释里写着旧写法是常态,不剥会假红(同 `WS-FND-58`)。 */
const readCode = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** 状态名 → 线上 `stateFlag` 下标(取自共享词表,不手抄数字)。 */
const flagOf = (name: string): number => STATE_FLAG_NAMES.indexOf(name);

/** 造一个**真**玩家状态(走服务端工厂 ⇒ 不手搓、不漏字段)。 */
const playerWith = (patch: Partial<PlayerState> = {}): PlayerState =>
  createPlayerState('p1', { name: '阿珍', x: 10, y: 10, ...patch });

/** 一步的位移(格):BASE_MOVE_SPEED 4.5 × DT 0.05 = 0.225 —— **字面量锚定**。 */
const STEP = 0.225;

/** 一条向东的命令。 */
const cmd = (seq: number): { seq: number; moveX: number; moveY: number; jump: boolean } =>
  ({ seq, moveX: 1, moveY: 0, jump: false });

/* ═══════════════ 1. 参数从权威状态派生(第 1 处)═══════════════ */

test('FND113-1 ★ predictParamsOf:四种禁步态 ⇒ frozen;其余不冻结(负对照)', () => {
  /* 表本身也要钉:少一个状态就是"某一种被冻住时客户端照样走"。 */
  eq(MOVE_BLOCKING_FLAGS, ['STUNNED', 'BUBBLED', 'FROZEN', 'GHOST_BUBBLE'],
    '禁步态词表(与 `applyPlayerMove` 的四个拒收来源一一对应)');

  for (const name of MOVE_BLOCKING_FLAGS) {
    eq(predictParamsOf(playerWith({ stateFlag: flagOf(name) })).frozen, true,
      `${name} ⇒ frozen(服务端整条拒收移动,客户端必须先停)`);
  }
  for (const name of ['NORMAL', 'SLIPPING', 'AFK_SHIELD']) {
    eq(predictParamsOf(playerWith({ stateFlag: flagOf(name) })).frozen, false,
      `${name} ⇒ **不**冻结(负对照:改成"总是冻结"会让这一条红)`);
  }
  /* 越界下标(坏包 / 协议加了新档):不许冻结 —— 冻结是"锁死玩家"的那一侧。 */
  eq(predictParamsOf(playerWith({ stateFlag: 99 })).frozen, false, '越界 stateFlag ⇒ 不冻结');
  /* 空输入:还没拿到自己的权威帧 ⇒ 与接线前一致(`{}`)。 */
  eq(predictParamsOf(undefined), {}, 'undefined ⇒ {}');
  eq(predictParamsOf(null), {}, 'null ⇒ {}');
});

test('FND113-2 ★ mu / speedMul 也从权威状态派生(不是写死)', () => {
  eq(GROUND_MU, 0.75, '地面摩擦取自 `createBody()` 默认值(字面量锚定)');
  eq(SLIPPERY_MU, 0.98, '冰面摩擦(315 冰砖 / 服务端 SLIPPING 时 max(mu, 0.98))');

  eq(predictParamsOf(playerWith({ stateFlag: flagOf('NORMAL') })).mu, 0.75, '普通地面 ⇒ 0.75');
  eq(predictParamsOf(playerWith({ stateFlag: flagOf('SLIPPING') })).mu, 0.98, 'SLIPPING ⇒ 0.98');
  eq(predictParamsOf(playerWith({ carryingEntityId: 'e77' })).speedMul, CARRY_SLOWDOWN,
    '背着人 ⇒ 0.85(与 `carrierSpeedMul` 同源)');
  eq(CARRY_SLOWDOWN, 0.85, 'CARRY_SLOWDOWN 是 0.85(字面量锚定)');
  /* 负对照:不背人时必须是 1,不是 0.85。 */
  eq(predictParamsOf(playerWith()).speedMul, 1, '不背人 ⇒ 1(负对照)');
});

/* ═══════════════ 2. 参数真的进 predictStep / 重演 ═══════════════ */

test('FND113-3 ★★ 参数生效:冻结 ⇒ 一步不动;mul=2 ⇒ 两倍;**注入**:不传参数 ⇒ 照样走一步', () => {
  /* 1 冻结:一步位移必须是**精确** 0。 */
  const frozen = new LocalPredictor({ x: 0, y: 0, z: 0 });
  frozen.setParams(predictParamsOf(playerWith({ stateFlag: flagOf('STUNNED') })));
  frozen.step(cmd(1));
  eq(frozen.pos, { x: 0, y: 0, z: 0 }, 'STUNNED ⇒ 预测一步走 0 格(修前:每帧 0.225 格)');

  /* 2 移速:mul=2 ⇒ 恰好两倍(不是"大约")。 */
  const fast = new LocalPredictor({ x: 0, y: 0, z: 0 });
  fast.setParams({ speedMul: 2 });
  fast.step(cmd(1));
  near(fast.pos.x, STEP * 2, 1e-12, 'mul=2 ⇒ 一步 0.45 格');
  eq(fast.lastParams, { speedMul: 2 }, '喂进去的参数**可读回**(自检口径)');

  /* 3 ★ 注入(修前的行为):同一个被冻住的玩家,若**不传参数**(={}),
     客户端会照样走一步;而服务端这条移动会被整条拒收 ⇒ 分歧累积到 1.5 格后硬 SNAP。 */
  const old = new LocalPredictor({ x: 0, y: 0, z: 0 });
  old.step(cmd(1));
  near(old.pos.x, STEP, 1e-12, '★ 注入:不传参数 ⇒ 被冻住的玩家照样走 0.225 格');
  ok(old.pos.x > 0.05,
    '★ 分歧 0.225 格 > 校正死区 0.05 ⇒ 每帧都会触发校正(修前的"橡皮筋"来源)');
});

test('FND113-4 ★★ 前推与**重演**用同一份参数(注入:重演传 {} ⇒ 位置差一半)', () => {
  /* 先在 mul=2 下走 3 步:0.45 × 3 = 1.35 */
  const p = new LocalPredictor({ x: 0, y: 0, z: 0 });
  p.setParams({ speedMul: 2 });
  for (let i = 1; i <= 3; i += 1) p.step(cmd(i));
  near(p.pos.x, 1.35, 1e-12, '前置:3 步 × 0.45 = 1.35');
  eq(p.pendingCount, 3, '前置:3 条待确认');

  /* 权威说"你还在原点"⇒ 从原点重演那 3 条。参数相同 ⇒ 重演与预测**逐位相同**
     ⇒ 零误差(IGNORE),位置不动。 */
  const r = p.onAuthoritative({ x: 0, y: 0, z: 0 });
  eq(r.action, ReconcileAction.IGNORE, '同一份参数重演 ⇒ 预测与重演重合(IGNORE)');
  near(p.pos.x, 1.35, 1e-12, '位置不动');

  /* ★ 注入:重演用 `{}`(修前的等效形态)⇒ 重演只走 0.225×3 = 0.675 ⇒ 差 0.675 格。 */
  const q = new LocalPredictor({ x: 0, y: 0, z: 0 });
  q.setParams({ speedMul: 2 });
  for (let i = 1; i <= 3; i += 1) q.step(cmd(i));
  const wrong = q.onAuthoritative({ x: 0, y: 0, z: 0 }, {});
  eq(wrong.action, ReconcileAction.SMOOTH, '★ 注入:重演用 {} ⇒ 误差 0.675 格(软校正)');
  near(q.pos.x, 0.675, 1e-12, '★ 注入:重演算出来的位置只有一半 ⇒ 正是"偶发橡皮筋"');
});

/* ═══════════════ 3. 渲染消费(第 2 处)═══════════════ */

test('FND113-5 ★★ 渲染消费:SMOOTH 后 pos == 权威、render == 权威 + 未收回偏移', () => {
  const p = new LocalPredictor({ x: 0, y: 0, z: 0 });
  p.step(cmd(1));
  p.step(cmd(2));
  near(p.pos.x, 0.45, 1e-12, '前置:两步到 0.45');
  /* 负对照:没有权威帧时**不许**凭空产生视觉偏移(否则立牌一开始就抖)。 */
  eq(p.renderPos, p.pos, '负对照:没有校正 ⇒ render == pos(无幽灵偏移)');
  eq(p.poseView()?.visualOffset, 0, '负对照:视觉偏移 = 0');

  /* 权威说你在 0.2,且它**已处理到 seq=2** ⇒ 队列被剪空,只剩"位置差 0.25 格"这一件事。 */
  const r = p.onAuthoritative({ x: 0.2, y: 0, z: 0, ackedSeq: 2 });
  eq(r.action, ReconcileAction.SMOOTH, '0.25 格落在软校正带内');
  eq([p.pendingCount, p.prunedTotal], [0, 2], '前置:队列剪空(否则下面混进了"重演位移")');
  near(p.pos.x, 0.2, 1e-12, '★ 逻辑位置**立即**对齐权威(权威成了唯一真值)');
  near(p.renderPos.x, 0.45, 1e-12, '★★ 渲染位置 = 校正**之前**那里(视觉连续,不跳)');

  const view = p.poseView();
  ok(view !== null, 'poseView 非 null');
  eq(view?.render, p.renderPos, '★ poseView.render **就是** renderPos(渲染读的就是它)');
  near(view?.visualOffset ?? -1, 0.25, 1e-12, '★ 视觉偏移 0.25 格(自检口径可读)');

  /* 逐帧吸收:偏移**单调**减小,并在若干帧后归零(之后 render 恒等于 pos)。 */
  let prev = view?.visualOffset ?? 0;
  let frames = 0;
  while (frames < 200) {
    p.absorbVisual(DT);
    const cur = p.poseView()?.visualOffset ?? 0;
    ok(cur <= prev + 1e-15, `第 ${frames} 帧偏移不许变大(${prev} → ${cur})`);
    prev = cur;
    frames += 1;
    if (cur === 0) break;
  }
  eq(prev, 0, `偏移最终归零(实得 ${frames} 帧;窗口 SMOOTH_WINDOW_S = 0.25s)`);
  eq(p.renderPos, p.pos, '归零后 render == pos');
});

test('FND113-6 ★ 坏值不进渲染:坐标 NaN ⇒ poseView() 返回 null(退回权威兜底)', () => {
  const p = new LocalPredictor({ x: 0, y: 0, z: 0 });
  eq(p.poseView()?.render, { x: 0, y: 0, z: 0 }, '负对照:正常值 ⇒ 非 null');
  /* 注入:让权威帧本身带坏值 —— 预测器会把它当权威原样收下。 */
  p.onAuthoritative({ x: Number.NaN, y: 0, z: 0 });
  eq(p.poseView(), null,
    '★ NaN ⇒ null(渲染层据此退回权威值;把 NaN 交给 three 会让立牌整个消失)');
  eq(Number.isFinite(p.renderPos.x), false, '前置:内部确实是 NaN(所以这道门非有不可)');
});

/* ═══════════════ 4. 上行 z 的真实来源(第 3 处)═══════════════ */

test('FND113-7 ★★ 上行 z 有真实来源:播种 z=2 ⇒ pos.z===2(修前恒 0)', () => {
  const p = new LocalPredictor();
  /* 与 `main.ts` 同一条路:第一次用权威值**播种**(z 也来自权威)。 */
  p.reset({ x: 4, y: 5, z: 2 });
  p.step(cmd(1));
  /* `predictStep` 刻意不改 z ⇒ 上行发的 `p.z` 就是权威高度。 */
  eq(p.pos.z, 2, '★ 播种 z=2 ⇒ 一步之后 z 仍是 2(上行 `z: p.z` 因此有真实来源)');
  near(p.pos.x, 4 + STEP, 1e-12, '前置:x 照常预测');

  /* ★ 注入(修前):播种写死 z:0 ⇒ 上行恒 0 ⇒ 服务端 `applyPlayerMove` 每帧把 b.z 抹平。 */
  const oldWay = new LocalPredictor();
  oldWay.reset({ x: 4, y: 5, z: 0 });
  oldWay.step(cmd(1));
  eq(oldWay.pos.z, 0, '★ 注入:z:0 播种 ⇒ 上行恒 0(权威高度被逐帧抹平)');
  ok(p.pos.z !== oldWay.pos.z, '★ 两种播种的高度**不同** ⇒ 这条判据有牙(不是两边都 0)');

  /* 权威回喂同样必须带真实 z(否则一跳起来就被拉回地面)。
     刻意用**硬对齐**档(SNAP):只有 SNAP 会把逻辑位置整个换成权威值,
     于是"回喂的 z 有没有被采纳"才可断言(IGNORE 档位置不动、测不出来)。 */
  p.onAuthoritative({ x: 10, y: 5, z: 3, ackedSeq: 1 });
  eq(p.pos.z, 3, '★ 回喂带 z=3 ⇒ 逻辑位置抬到 3(不是被重置成 0)');
  eq(p.pos.x, 10, '前置:硬对齐真的发生了(否则上面那条在测空气)');
});

/* ═══════════════ 5. 重连复位(第 4 处)═══════════════ */

test('FND113-8 ★★ 重连复位:seq 回 1、按键清空、预测器的队列/acked/参数一起清', () => {
  const input = new InputSource();
  input.press('w');
  const first = input.nextCmd();
  const second = input.nextCmd();
  eq([first.seq, second.seq], [1, 2], '前置:seq 从 1 单调递增');

  input.press('d');
  input.reset();
  const after = input.nextCmd();
  eq(after.seq, 1, '★ 复位后第一条命令的 seq 又是 1(它就是"这条连接上的第几条")');
  eq(after.moveX, 0, '★ 复位把按下的键也清空(断线期间收不到 keyup,否则会朝旧方向一直走)');

  /* ★ 注入:不复位 ⇒ seq 继续往上走,而服务端新连接的 ack 水位从 -1 重新开始。 */
  const noReset = new InputSource();
  noReset.nextCmd();
  noReset.nextCmd();
  eq(noReset.nextCmd().seq, 3, '★ 注入:不复位 ⇒ seq=3(与服务端新账本对不上)');

  const p = new LocalPredictor({ x: 1, y: 2, z: 0 });
  p.setParams({ frozen: true });
  p.step(cmd(1));
  p.onAuthoritative({ x: 1, y: 2, z: 0, ackedSeq: 1 });
  p.reset({ x: 1, y: 2, z: 2 });
  eq([p.pendingCount, p.prunedTotal, p.lastAckedSeq], [0, 0, -1],
    '★ 预测器:队列 / 剪枝计数 / acked 一起归零');
  eq(p.lastParams, {}, '★ 上一轮的冻结参数不许跨连接活下来(否则"重连后动不了")');
  eq(p.pos, { x: 1, y: 2, z: 2 }, '复位后的位置 = 传入的权威值(含 z)');
});

/** 假 socket:只实现 `session.ts` 用到的那一面,事件由测试**手动**触发。 */
interface FakeSock {
  binaryType: string;
  readyState: number;
  sent: Uint8Array[];
  send(d: Uint8Array): void;
  close(): void;
  addEventListener(type: string, fn: (ev: never) => void): void;
  fire(type: string, ev?: unknown): void;
}

function fakeSocket(): FakeSock {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  const sent: Uint8Array[] = [];
  const sock: FakeSock = {
    binaryType: 'blob',
    readyState: 1,
    sent,
    send(d: Uint8Array): void { sent.push(d); },
    close(): void { sock.readyState = 3; },
    addEventListener(type: string, fn: (ev: never) => void): void {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn as (ev: unknown) => void);
    },
    fire(type: string, ev?: unknown): void {
      for (const h of handlers.get(type) ?? []) h(ev ?? {});
    },
  };
  return sock;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** 异步版 `test`(`harness.test()` 不 await ⇒ 传 async 进去会**静默假绿**)。 */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

/** 一条握手 welcome(下行文本帧)—— 重连后必须重新走一遍。 */
function welcomeText(): string {
  return JSON.stringify({
    t: 'welcome', playerId: 'p1', roomId: 'r113',
    protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-x',
  });
}

async function main(): Promise<void> {
  await atest('FND113-9 ★★ 真重连:reconnect() 换 socket 并报 onOpen(2);负对照:close() 不重连', async () => {
    const socks: FakeSock[] = [];
    const opened: number[] = [];
    const states: SessionState[] = [];
    const s = createSession({
      url: 'ws://x/',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      /* 5ms:只为让负对照能在几十毫秒内断言"没有多拨一条"。 */
      autoReconnectMs: 5,
      events: {
        onFrame: () => {},
        onOpen: (epoch) => opened.push(epoch),
        onState: (st) => states.push(st),
      },
    });
    eq(socks.length, 1, '前置:建会话即拨第一条');
    eq(s.epoch, 0, '还没 open ⇒ epoch 0');

    socks[0]!.fire('open');
    eq(opened, [1], '★ 首连报 onOpen(1)');
    eq(s.epoch, 1, 'epoch 跟着 onOpen 走(同一个数,不造第二份计数)');
    eq(socks[0]!.sent.length, 1, '★ open 之后**先**发 hello');

    /* ★ 主动重连:换一条 socket,新 socket 的 open 报 epoch=2。 */
    s.reconnect();
    eq(socks.length, 2, '★ reconnect() 拨了**新** socket');
    eq(s.state, 'connecting', '新连接还没握手 ⇒ connecting(不是还以为 live)');
    socks[1]!.fire('open');
    eq(opened, [1, 2], '★★ 重连报 onOpen(2) —— 这就是调用方复位的触发点');
    eq(s.epoch, 2, 'epoch = 2');
    eq(socks[1]!.sent.length, 1, '重连后同样先发 hello(同一段 dial)');
    socks[1]!.fire('message', { data: welcomeText() });
    eq(s.state, 'live', '重连握手完成 ⇒ live');

    /* 老 socket 的 close **不许**被记成"又断了一次"(否则会多排一次重连)。 */
    socks[0]!.fire('close');
    eq(s.state, 'live', '老 socket 的 close 不影响当前会话状态');
    await sleep(30);
    eq(socks.length, 2, '★ 老 socket 的 close 没有触发第二次重连');

    /* ★ 负对照:主动 close() ⇒ 即使开了 autoReconnectMs 也**不**再拨。 */
    s.close();
    await sleep(40);
    eq(socks.length, 2, '★ close() 是调用方的决定 ⇒ 不自动重连(负对照)');
    eq(s.state, 'closed', '状态停在 closed');
    eq(states.filter((x) => x === 'failed').length, 0, '全程没有 failed 噪声');
  });

  await atest('FND113-10 ★★ 被动掉线 ⇒ 自动重连(没有它,第 4 处的复位永不触发)', async () => {
    const socks: FakeSock[] = [];
    const opened: number[] = [];
    createSession({
      url: 'ws://x/',
      makeSocket: () => { const f = fakeSocket(); socks.push(f); return f as never; },
      store: new ClientStateStore(),
      autoReconnectMs: 5,
      events: { onFrame: () => {}, onOpen: (e) => opened.push(e) },
    });
    socks[0]!.fire('open');
    eq(opened, [1], '前置:首连');
    socks[0]!.fire('close');
    for (let i = 0; i < 100 && socks.length < 2; i += 1) await sleep(5);
    eq(socks.length, 2, '★ 被动 close ⇒ 自动拨第二条');
    socks[1]!.fire('open');
    eq(opened, [1, 2], '★ 自动重连同样走 onOpen(2)');
  });
}

/* ═══════════════ 6. state_store 单调门(第 5 处)═══════════════ */

/** 造一帧全量快照(玩家位置可控)。 */
function fullFrame(x: number, tick: number): Uint8Array {
  const st = createRoomState('r113');
  st.players.push(createPlayerState('p1', { name: '阿珍', x, y: 3 }));
  return encodeFull(st, tick).bytes;
}

/** 造一份"从 x=a 变到 x=b"的差量帧(prev 用同形状的独立快照)。 */
function deltaFrame(a: number, b: number, tick: number): Uint8Array {
  const prev = createRoomState('r113');
  prev.players.push(createPlayerState('p1', { name: '阿珍', x: a, y: 3 }));
  const next = createRoomState('r113');
  next.players.push(createPlayerState('p1', { name: '阿珍', x: b, y: 3 }));
  return encodeDelta(prev, next, tick).bytes;
}

/** 把包头那 4 字节 ack 改成指定值(线上编码 = ack + 1;见 `WS-FND-63`)。 */
function withAck(bytes: Uint8Array, ack: number): Uint8Array {
  const b = Uint8Array.from(bytes);
  const v = ack + 1;
  b[6] = v & 0xff;
  b[7] = (v >> 8) & 0xff;
  b[8] = (v >> 16) & 0xff;
  b[9] = (v >> 24) & 0xff;
  return b;
}

test('FND113-11 ★★ 单调门:旧 DELTA 被丢(位置不回退);旧 FULL 仍接受(重连恢复)', () => {
  const store = new ClientStateStore();
  ok(store.apply(fullFrame(1, 5)).changed, '前置:FULL tick=5 合入');
  near(store.state.players[0]!.x, 1, 1e-9, '前置:x=1');

  /* 正常前进的一帧差量:tick 6、x 1→3。 */
  ok(store.apply(deltaFrame(1, 3, 6)).changed, 'tick 6 前进 ⇒ 合入');
  near(store.state.players[0]!.x, 3, 1e-9, '前置:x=3');

  /* ★ 晚到的旧帧(同样是 tick 6,内容来自另一条分支:x 1→9)⇒ 必须被丢。 */
  const stale = deltaFrame(1, 9, 6);
  const dropped = store.apply(stale);
  eq(dropped.changed, false, '★ 旧 DELTA ⇒ changed=false');
  eq(dropped.skipped, 'stale-frame', '★ 归因是 `stale-frame`(与空帧、坏包分开计)');
  eq(store.staleFrames, 1, '★ 旧帧计数 +1(可读的自检口径)');
  near(store.state.players[0]!.x, 3, 1e-9, '★★ 权威位置**没有**被旧帧拉回 9');

  /* ★ 注入(修前的行为 = 直接 `applyPacket`):同一份字节会把位置拉回 9。 */
  const oldWay = applyPacket(store.state, decodePacket(stale));
  near(oldWay.players[0]!.x, 9, 1e-9,
    '★ 注入:没有单调门时同一份字节会把 x 写成 9(位置被旧帧拉回)');

  /* ★ 豁免:FULL 是自包含快照(重连恢复),旧 tick 也**必须**接受。 */
  const replay = store.apply(fullFrame(7, 2));
  eq(replay.changed, true, '★ 旧 tick 的 FULL 仍被接受(重连快照)');
  eq(store.state.meta.tick, 2, '★ meta.tick 跟着恢复快照走(= 2)');
  near(store.state.players[0]!.x, 7, 1e-9, '★ 位置来自恢复快照');
  eq(store.staleFrames, 1, 'FULL 不计入 staleFrames(它没被丢)');
});

test('FND113-12 ★★ ackedSeq 只进不退(-1 也不会把已有值抹掉)', () => {
  const store = new ClientStateStore();
  eq(store.lastAckedSeq, -1, '前置:还没收到 ack');

  eq(store.apply(withAck(fullFrame(1, 10), 5)).ackedSeq, 5, '前端:这一帧带 ack=5');
  eq(store.lastAckedSeq, 5, '★ 落账 5');

  /* 乱序旧帧带 ack=3 ⇒ 不许倒退(否则已确认的命令会被重新算成待确认)。 */
  store.apply(withAck(fullFrame(1, 11), 3));
  eq(store.lastAckedSeq, 5, '★ 倒退的 ack 被忽略(负对照:直接赋值会变回 3)');

  /* 占位 0(-1 = 本帧没带 ack)⇒ 同样不许抹掉。 */
  store.apply(fullFrame(1, 12));
  eq(store.lastAckedSeq, 5, '★ 不带 ack 的帧不会把 5 抹成 -1');

  /* 前进仍然生效。 */
  store.apply(withAck(fullFrame(1, 13), 8));
  eq(store.lastAckedSeq, 8, '★ 前进照常推进(不是"永远不动")');
});

/* ═══════════════ 7. 装配点(弱判据:源码文本)═══════════════ */

test('FND113-13 ★ 装配点:参数 / 预测渲染 / 重连复位 / z / jump 五个生产者都在', () => {
  const main = readCode('client/src/main.ts');
  const pred = readCode('client/src/net/predictor.ts');
  const boot = readCode('client/src/three/boot.ts');
  const sess = readCode('client/src/net/session.ts');

  /* 1 参数:每 tick 从权威状态推一次并喂进去。 */
  ok(/predictParamsOf\(me\)/.test(main), '★ main.ts 每 tick 从权威玩家状态推参数');
  ok(/predictor\.setParams\(/.test(main), '★ main.ts 把参数喂进预测器(只算不喂 = 没接)');
  ok(/const me = playerId === null[\s\S]{0,160}players\.find\(/.test(main),
    '★ 参数来源是**快照里的自己**(不是本地猜的)');

  /* 2 渲染消费:main 注入、boot 每帧拉并改用预测位置画。 */
  ok(/handle\.setPoseSource\(/.test(main), '★ main.ts 把预测姿态源接进渲染');
  ok(/predictor\.poseView\(\)/.test(main), '★ 源就是 `poseView`(renderPos + 视觉偏移)');
  ok(/setPoseSource: \(fn\)/.test(boot), '★ boot.ts 暴露 setPoseSource(接了才有生产者)');
  ok(/poseSource === null \? null : poseSource\(\)/.test(boot),
    '★ boot.ts **每帧**拉一次(不是 push 一个值)');
  ok(/baseShown/.test(boot), '★ 立牌画的是预测位置(`baseShown`),权威值仍留作兜底');

  /* 3 z:播种/回喂都用权威高度;修前那两处 `z: 0` 必须消失。 */
  ok(/localPlayerZOf\(handle\.store\.state, playerId\)/.test(main),
    '★ z 的来源是 `localPlayerZOf`(与 boot 同一条入口)');
  ok(!/z: 0,/.test(main), '★ 修前的 `z: 0` 写死已不存在(否则权威高度又被抹平)');
  ok(/z: authoritativeZ/.test(main), '★ 播种与回喂都用 `authoritativeZ`');

  /* 4 重连:session 有重连 + epoch;main 在 epoch>1 时复位整条链。 */
  ok(/autoReconnectMs\?: number/.test(sess), '★ session.ts 有自动重连开关(省略 ⇒ 与接线前一致)');
  ok(/opts\.events\.onOpen\?\.\(epoch\)/.test(sess), '★ open 事件报 epoch');
  ok(/reconnect\(\): void/.test(sess), '★ 主动重连入口(与自动重连共用 dial)');
  ok(/if \(epoch > 1\) resetLocalChain\(\)/.test(main), '★ main.ts 在**重连**时复位');
  ok(/const resetLocalChain = \(\): void =>/.test(main), '★ 复位函数存在');
  ok(/predictor\.reset\(predictor\.pos\)/.test(main), '★ 复位预测器');
  ok(/input\.reset\(\)/.test(main), '★ 复位输入序号');
  ok(/stickPointerId = null;/.test(main), '★ 复位摇杆指针');

  /* 5 jump 的出口 + 第 5 处的两个「不静默」。 */
  ok(/jump: cmd\.jump/.test(main), '★ jump 真的进上行(修前它永远发不出去)');
  ok(/jump\?: boolean/.test(sess), '★ MoveIntent 有 jump 字段(出口在这一侧)');
  ok(/jumpLatched/.test(readCode('client/src/net/input.ts')),
    '锁存仍在(删掉会让空格的行为无声消失)');
  ok(/stale-frame/.test(readCode('client/src/net/state_store.ts')),
    '★ state_store 有单调门的归因');

  /* 6 出口的**形状**:编出来的报文里必须真的有 `jump`。
     ⚠️ 服务端 `parseMoveIntent` 目前会丢弃它 —— 这一半如实标注为残留,不谎称已落地。 */
  const withJump = new TextDecoder().decode(
    encodeMoveUplink({ tick: 1, x: 0, y: 0, z: 0, seq: 1, jump: true }).subarray(1),
  );
  ok(/"jump":true/.test(withJump), '★ 上行报文带 jump:true(字段真的出了客户端)');
  const without = new TextDecoder().decode(
    encodeMoveUplink({ tick: 1, x: 0, y: 0, z: 0, seq: 1 }).subarray(1),
  );
  ok(!/"jump"/.test(without), '负对照:不带 jump 时报文里没有这个字段');

  /* 反面对照:预测器的默认参数必须是 `this.params`,不是 `{}`。 */
  ok(/params: PredictParams = this\.params/.test(pred),
    '★ 预测器的默认参数是 `this.params`(不是 `{}`)');
});

await main();
/* ⚠️ `report()` 必须在异步区**之后** —— 否则计数只统计"跑完的那部分"。 */
report('WS-FND-113');