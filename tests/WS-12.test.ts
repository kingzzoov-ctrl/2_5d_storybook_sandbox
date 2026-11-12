/**
 * WS-12 测试 — 客户端联机层最小接线(task-67 阶段 3)
 *
 * ```
 * node tests/WS-12.test.ts   (Node 24 原生跑 .ts)
 * ```
 * 零外部依赖:只用 `shared/testing/harness.ts` + 本仓库实现层。
 *
 * ## 本套件守的三条验收判据
 *
 * ```
 * 判据一 **预警圈圆心 == 权威玩家位置**
 *        └ 强(行为):authoritative → buildTelegraph → 逆投影 → 重算圆心 → 恒等
 *        └ 弱(文本):boot.ts 的 cx/cy 确实绑到权威来源 —— ★ 显式标注为弱判据
 * 判据二 **`applyPacket` 的返回值被接住**
 *        └ 它返回**新对象**;丢弃返回值 ⇒ 状态不变、不报错、画面冻住
 * 判据三 **坏包不崩**
 *        └ 含一条最容易漏的:**0 字节帧不是坏包**(是「本 tick 无差量」)
 * ```
 *
 * ## 为什么判据一能用**行为**断言(而不是只能读源码文本)
 *
 * 判据的本体在 `three/boot.ts`,而它的闭包含三方 `three` ⇒ Node 里 import 不了
 * (实测:全仓无任何测试 import `three/` 下文件)。
 * 但**几何那半**落在 `ui/boss_hud.ts`(`buildTelegraph`)与 `stage/iso_camera.ts`
 * (`projectGridToScreen` / `unprojectScreenToGrid`)—— 两者都**纯**,且 WS-09 已在 import。
 * ⇒ 所以本文件用**一次真实往返**测几何,文本断言只留给"接线点"那一处。
 * ⇒ 强弱分开标注:**不把弱判据混进「全部通过」的错觉里**。
 */

import {
  test, ok, eq, near, includes, report,
} from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ── 被测:客户端联机层(三个新模块,全部纯、零三方)── */
import { telegraphCenterOf } from '../client/src/net/telegraph_center.ts';
import { ClientStateStore, emptyRoomState } from '../client/src/net/state_store.ts';
import {
  encodeClientFrame, decodeClientFrame, createSession, classifyDownlink,
} from '../client/src/net/session.ts';

/* ── 夹具:服务端侧(用来造**真实**字节流,不手搓协议)── */
import {
  createRoomState, createPlayerState,
} from '../server/src/net/schema.ts';
import {
  encodeFull, encodeDelta, decodePacket, PROTOCOL_VERSION,
} from '../shared/net/delta.ts';

/* ── 几何(判据一的**强**那半:两者都纯,WS-09 已在 import)── */
import { buildTelegraph, type TelegraphSpec } from '../client/src/ui/boss_hud.ts';
import {
  createCamera, unprojectScreenToGrid, type IsoCamera,
} from '../client/src/stage/iso_camera.ts';

const ROOT = join(import.meta.dirname, '..');

/* ── 源码文本断言的小工具 ──
 *
 * ★ **注释必须先剥掉**。这是本仓咬过两次的坑:注释里提到某个符号名,
 *   会让「这个符号用了/没用」的文本判据**同时**出现假阴与假阳。
 *   例:本文件的 `boot.ts` 弱判据若不清注释,注释里刻意保留的旧写法
 *   (`playerGx = pan.x;` 作为「为什么删掉它」的记录)会被当成**活的代码**。
 *
 * 只处理行注释与块注释的**行首形态**,对本仓风格足够;不做完整词法分析。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   /* 块注释(含 JSDoc) */
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))  /* 行注释 */
    .join('\n');
}

/** 读一个文件的**代码**(已剥注释),用于文本断言。 */
function codeOf(...parts: string[]): string {
  return stripComments(readFileSync(join(ROOT, ...parts), 'utf8'));
}

/* ═══════════ 1. ★ 验收判据一(强):预警圈圆心 == 权威玩家位置 ═══════════ */

console.log('\n— 判据一(强):预警圈圆心 == 权威玩家位置 —');

/**
 * 造一个**真**权威状态:走服务端工厂 ⇒ 不手搓、不漏字段。
 * (客户端造不出 `createRoomState` —— 它留在 server 的 16 个里,见 §3。)
 */
function authState(id: string, x: number, y: number) {
  const s = createRoomState('demo');
  const p = createPlayerState(id, { name: '阿珍', x, y });
  s.players.push(p);
  return s;
}

/** 预警圈 spec:圆心取自 `telegraphCenterOf`(经**同一**权威状态) */
function telegraphSpecFor(state: ReturnType<typeof authState>, id: string): TelegraphSpec | null {
  const c = telegraphCenterOf(state, id);
  if (c === null) return null;
  return {
    shape: 'ANNULUS', cx: c.cx, cy: c.cy, cz: 0,
    radius: 3.5, innerRadius: 2, chargeSec: 0.8, danger: 0.8,
  };
}

/**
 * **往返**:圆心 → 预警圈屏幕顶点 → 逆投影回网格 → 重算圆心。
 *
 * ⚠️ 关键设计:**相机故意不等于玩家位置**(见各用例)。若圆心是从相机来的,
 * 这一往返就**不可能**回到权威位置 ⇒ 该用例会红。这是"排除一整类假通过"的对照。
 */
function centerRoundTrip(spec: TelegraphSpec, cam: IsoCamera): { cx: number; cy: number } {
  const g = buildTelegraph(spec, cam);
  const back = g.screenOuter.map((p) => unprojectScreenToGrid(p.x, p.y, cam, 0));
  return {
    cx: back.reduce((a, b) => a + b.gx, 0) / back.length,
    cy: back.reduce((a, b) => a + b.gy, 0) / back.length,
  };
}

test('判据一 · 权威位置经预警圈往返后恒等', () => {
  const st = authState('p1', 12.5, 7.25);
  const cam = createCamera(1280, 720);
  /* ★ 相机**离开**玩家 —— 防"圆心其实跟着相机走"这种假通过 */
  cam.focusX = 10;
  cam.focusY = 10;

  const spec = telegraphSpecFor(st, 'p1');
  ok(spec !== null, 'telegraphCenterOf 能拿到圆心');
  if (spec === null) return;

  eq(spec.cx, 12.5, 'spec.cx 取自权威 x');
  eq(spec.cy, 7.25, 'spec.cy 取自权威 y');

  const rt = centerRoundTrip(spec, cam);
  near(rt.cx, 12.5, 1e-9, '往返圆心 x == 权威 x(双精度往返)');
  near(rt.cy, 7.25, 1e-9, '往返圆心 y == 权威 y(双精度往返)');
});

test('判据一 · 对照 A:改掉圆心 ⇒ 往返必须查得出(判据非恒真)', () => {
  const cam = createCamera(640, 480);
  const st = authState('p1', 12.5, 7.25);
  const good = telegraphSpecFor(st, 'p1')!;
  /* 故意把圆心挪 2 格 */
  const bad: TelegraphSpec = { ...good, cx: good.cx + 2 };
  const rtBad = centerRoundTrip(bad, cam);
  ok(Math.abs(rtBad.cx - 12.5) > 1.0,
    `故意改圆心后往返值确实跟着偏(实测偏 ${Math.abs(rtBad.cx - 12.5).toFixed(3)})`);
});

test('判据一 · 对照 B:相机移到天边 ⇒ 圆心**不变**(证明判的是世界坐标不是相机)', () => {
  const st = authState('p1', 12.5, 7.25);
  const spec = telegraphSpecFor(st, 'p1')!;

  const camA = createCamera(1280, 720);
  camA.focusX = 0; camA.focusY = 0;
  const camB = createCamera(1280, 720);
  camB.focusX = 9999; camB.focusY = -4321;

  const a = centerRoundTrip(spec, camA);
  const b = centerRoundTrip(spec, camB);
  near(a.cx, 12.5, 1e-9, '相机在原点时圆心 == 权威位置');
  near(b.cx, 12.5, 1e-9, '★ 相机在天边时圆心**仍** == 权威位置(故判的是世界坐标)');
  near(a.cy, b.cy, 1e-9, '两台相机给出的圆心一致');
});

test('判据一 · 对照 C:非整数/边界权威位置都能往返', () => {
  const cam = createCamera(800, 600);
  const cases: [number, number][] = [[0.5, 0.5], [0.001, 0.001], [12.3333, 7.6667], [0, 0]];
  for (const [x, y] of cases) {
    const st = authState('p1', x, y);
    const spec = telegraphSpecFor(st, 'p1')!;
    const rt = centerRoundTrip(spec, cam);
    near(rt.cx, x, 1e-9, `权威 x=${x} 往返一致`);
    near(rt.cy, y, 1e-9, `权威 y=${y} 往返一致`);
  }
});

test('判据一 · 圆心随权威值变化而变化(不是常量)', () => {
  const cam = createCamera(640, 480);
  const a = centerRoundTrip(telegraphSpecFor(authState('p1', 3, 4), 'p1')!, cam);
  const b = centerRoundTrip(telegraphSpecFor(authState('p1', 9, 11), 'p1')!, cam);
  near(a.cx, 3, 1e-9, '第一个权威位置往返正确');
  near(b.cx, 9, 1e-9, '第二个权威位置往返正确');
  ok(Math.abs(a.cx - b.cx) > 1, '两次圆心不同 ⇒ 它真的跟着权威值走');
});

/* ═══════════ 2. 空态语义(Lead 要求的第三项边界) ═══════════ */

console.log('\n— 空态:权威未知时返回 null,不返回 {0,0} —');

test('空态 · players 为空 ⇒ null(第一帧还没到)', () => {
  const st = createRoomState('demo');
  eq(st.players.length, 0, '夹具确认:没有玩家');
  eq(telegraphCenterOf(st, 'p1'), null, '★ 空 players ⇒ null(不是 {0,0})');
});

test('空态 · 本地 id 未知 ⇒ null', () => {
  const st = authState('p1', 12.5, 7.25);
  eq(telegraphCenterOf(st, ''), null, '★ 空 id ⇒ null(还没握手拿到自己的 id)');
});

test('空态 · ★ 玩家 id 恰为空串时,**空 localId 仍返回 null**(不误认它为自己)', () => {
  /* 这条专门守 `if (localPlayerId === '') return null;` 那一行 ——
     它**不是**冗余的:若没有它,`find(x => x.id === '')` 会**匹配**到这个畸形玩家,
     于是「还没拿到自己的 id」会被当成「自己就是那个空 id 玩家」⇒ 圆心钉到一个不该用的实体上。
     ⚠️ 故障注入实测:删掉那一行后,其余 31 条**全部仍绿** ⇒ 必须有本用例才算守住。 */
  const st = createRoomState('demo');
  st.players.push(createPlayerState('', { name: '畸形', x: 9, y: 9 }));
  eq(telegraphCenterOf(st, ''), null,
    '★ 空 localId + 存在空 id 玩家 ⇒ 仍 null(不把它误认成自己)');
  /* 对照:传一个**不存在**的 id 也找不到(证明上面不是碰巧) */
  eq(telegraphCenterOf(st, 'p1'), null, '对照:传不存在的 id ⇒ 找不到');
  /* 再对照:把畸形玩家的 id 改成正常值 ⇒ 立刻能找到
     ⇒ 证明上面两条的 null 来自「空 id 早退」,不是「这个 state 整体找不到人」 */
  const st2 = createRoomState('demo');
  st2.players.push(createPlayerState('p1', { name: '正常', x: 9, y: 9 }));
  ok(telegraphCenterOf(st2, 'p1') !== null, '对照:同样的 state 换成非空 id ⇒ 能找到');
});

test('空态 · 玩家在但**不是自己** ⇒ null(不 fallback 到 players[0])', () => {
  const st = authState('p1', 12.5, 7.25);
  eq(telegraphCenterOf(st, 'pX'), null,
    '★ id 不匹配 ⇒ null —— 不悄悄挑 players[0](那会把圆心钉到别人头上)');
});

test('空态 · 多人房间里取的**是本地玩家**(不是第一个)', () => {
  const st = createRoomState('demo');
  st.players.push(createPlayerState('other', { name: '别人', x: 1, y: 1 }));
  st.players.push(createPlayerState('me', { name: '我', x: 30, y: 40 }));
  const c = telegraphCenterOf(st, 'me');
  ok(c !== null, '能找到自己');
  eq(c?.cx, 30, '取的是**自己**的 x(不是 players[0] 的 1)');
  eq(c?.cy, 40, '取的是**自己**的 y');
});

test('空态 · null 语义可用性:调用方据 null 保持上一帧(不清零)', () => {
  /* 模拟 boot.ts 帧循环的写法:center 为 null ⇒ 保持旧值 */
  let gx = 8;
  let gy = 8;
  const apply = (c: { cx: number; cy: number } | null): void => {
    if (c !== null) { gx = c.cx; gy = c.cy; }
  };
  apply(telegraphCenterOf(createRoomState('demo'), 'p1'));  /* 空 ⇒ 保持 */
  eq(gx, 8, '权威未知时保持出生点(不被清零到 0)');
  apply(telegraphCenterOf(authState('p1', 20, 30), 'p1'));  /* 有 ⇒ 更新 */
  eq(gx, 20, '权威到达后更新');
  apply(telegraphCenterOf(createRoomState('demo'), 'p1'));  /* 又空 ⇒ 保持 */
  eq(gx, 20, '再次未知时保持**上一帧的权威值**(不退回出生点)');
});

/* ═══════════ 3. ★ 判据二:`applyPacket` 返回值被接住 ═══════════ */

console.log('\n— 判据二:状态确实被替换(applyPacket 返回新对象)—');

test('判据二 · 空 base 的**键集**与真实 RoomState 一致', () => {
  const real = createRoomState('demo');
  const empty = emptyRoomState();
  eq(
    JSON.stringify(Object.keys(empty).sort()),
    JSON.stringify(Object.keys(real).sort()),
    '★ 顶层键集一致(否则协议加字段时空 base 会**静默缺字段**)',
  );
  eq(
    JSON.stringify(Object.keys(empty.meta).sort()),
    JSON.stringify(Object.keys(real.meta).sort()),
    '★ meta 键集一致',
  );
  ok(empty.roomId === '', '空 base 的 roomId 为空串(不进协议,由服务端 welcome 给)');
  eq(empty.players.length, 0, '空 base 无玩家');
});

test('判据二 · 合入一帧后状态真的**换了对象**(不是原地改)', () => {
  const store = new ClientStateStore();
  const before = store.state;
  const src = authState('p1', 12.5, 7.25);
  const pkt = encodeFull(src, 4242);

  const r = store.apply(pkt.bytes);
  ok(r.changed, 'apply 报告 changed=true');
  ok(store.state !== before, '★ store.state 是**另一个对象**(applyPacket 返回新对象)');
  eq(before.players.length, 0, '★ 旧对象**未被就地修改**(证明必须接返回值)');
  eq(before.meta.tick, 0, '旧对象 tick 也没变');
  eq(store.state.players.length, 1, '新状态里有玩家');
  eq(store.state.meta.tick, 4242, 'tick 已更新');
});

test('判据二 · 玩家坐标经量化往返后与权威一致', () => {
  const store = new ClientStateStore();
  const src = authState('p1', 12.5, 7.25);
  store.apply(encodeFull(src, 7).bytes);
  const p = store.state.players[0];
  ok(p !== undefined, '玩家在状态里');
  near(p?.x, 12.5, 1e-4, 'x 量化往返一致');
  near(p?.y, 7.25, 1e-4, 'y 量化往返一致');
  eq(p?.id, 'p1', 'id 一致');
});

test('判据二 · 增量帧也接住了返回值(tick 前进、玩家保留)', () => {
  const store = new ClientStateStore();
  const src = authState('p1', 12.5, 7.25);
  store.apply(encodeFull(src, 4242).bytes);
  const mid = store.state;
  const r2 = store.apply(encodeDelta(src, src, 4243).bytes);
  ok(r2.changed, '第二帧 applied');
  eq(store.state.meta.tick, 4243, 'tick 前进到 4243');
  eq(store.state.players.length, 1, '玩家仍在(增量不含删除)');
  ok(store.state !== mid, '又是新对象');
});

test('判据二 · 圆心真的来自 store(端到端:字节 → 圆心)', () => {
  const store = new ClientStateStore();
  store.setLocalPlayerId('p1');
  eq(telegraphCenterOf(store.state, store.localPlayerId), null, '未收到帧 ⇒ null');

  store.apply(encodeFull(authState('p1', 21.5, 33.25), 10).bytes);
  const c = telegraphCenterOf(store.state, store.localPlayerId);
  ok(c !== null, '收到帧后有了圆心');
  near(c?.cx, 21.5, 1e-4, '圆心 x 来自**服务端字节流**');
  near(c?.cy, 33.25, 1e-4, '圆心 y 来自**服务端字节流**');
});

/* ═══════════ 4. ★ 判据三:坏包不崩;0 字节 ≠ 坏包 ═══════════ */

console.log('\n— 判据三:坏包与空帧都不打断渲染 —');

test('判据三 · 0 字节帧被**跳过**,不算错误(★ 最容易漏的一条)', () => {
  const store = new ClientStateStore();
  const r = store.apply(new Uint8Array(0));
  ok(!r.changed, '0 字节 ⇒ changed=false');
  eq(r.skipped, 'empty-frame', '★ 归类为 empty-frame(不是 decode-failed)');
  eq(store.decodeErrors, 0, '★ **不计入**解码错误 —— 它是协议的一部分,不是损坏');
  eq(store.emptyFrames, 1, '空帧被单独计数');

  /* 对照组:真的喂给 decodePacket 会抛 —— 证明这个跳过**必须有** */
  let threw = false;
  try { decodePacket(new Uint8Array(0)); } catch { threw = true; }
  ok(threw, '★ 对照:decodePacket(空) 确实抛 ⇒ 所以跳过不是多余的防御');
});

test('判据三 · null 载荷视作空帧(WebSocket 空负载)', () => {
  const store = new ClientStateStore();
  const r = store.apply(null);
  eq(r.skipped, 'empty-frame', 'null ⇒ empty-frame');
  eq(store.decodeErrors, 0, '不计错误');
});

test('判据三 · 四类坏包都**不抛**,且各自被计数', () => {
  const store = new ClientStateStore();
  const cases: [string, Uint8Array][] = [];

  /* ① 截断(只有 1 字节,协议头要更多) */
  cases.push(['截断', new Uint8Array([1])]);
  /* ② 协议版本不符 */
  const badVer = encodeFull(authState('p1', 1, 1), 5).bytes.slice();
  badVer[0] = 99;
  cases.push(['版本不符', badVer]);
  /* ③ 未知 op */
  const badOp = encodeFull(authState('p1', 1, 1), 5).bytes.slice();
  badOp[1] = 77;
  cases.push(['未知 op', badOp]);
  /* ④ 半截断 */
  const half = encodeFull(authState('p1', 1, 1), 5).bytes;
  cases.push(['半截断', half.slice(0, 2)]);

  for (const [name, bytes] of cases) {
    let threw = false;
    let r: ReturnType<typeof store.apply> | null = null;
    try { r = store.apply(bytes); } catch { threw = true; }
    ok(!threw, `坏包「${name}」**不抛**(渲染循环不被打断)`);
    eq(r?.skipped, 'decode-failed', `坏包「${name}」归类为 decode-failed`);
    eq(r?.changed, false, `坏包「${name}」不改变状态`);
  }
  eq(store.decodeErrors, 4, '4 个坏包都被计数');
  ok(store.lastError !== undefined && store.lastError.length > 0,
    `最近错误原因被记下(实测:${store.lastError?.slice(0, 30)}...)`);
});

test('判据三 · 坏包之后**仍能正常合入好包**(状态没被污染)', () => {
  const store = new ClientStateStore();
  store.apply(new Uint8Array([9]));
  store.apply(new Uint8Array(0));
  eq(store.decodeErrors, 1, '一个坏包');
  eq(store.emptyFrames, 1, '一个空帧');

  const r = store.apply(encodeFull(authState('p1', 5, 6), 100).bytes);
  ok(r.changed, '★ 坏包之后好包仍能合入');
  eq(store.state.players.length, 1, '状态正常');
  eq(store.state.meta.tick, 100, 'tick 正常');
});

/* ═══════════ 5. 帧类型头(纯函数,可测) ═══════════ */

console.log('\n— 上行帧类型头:encode/decode 往返 —');

test('帧头 · 二进制帧往返', () => {
  const payload = new Uint8Array([10, 20, 30]);
  const f = encodeClientFrame(payload, false);
  eq(f.length, 4, '加了 1 字节头');
  const d = decodeClientFrame(f);
  eq(d?.kind, 'binary', '识别为 binary');
  eq(d?.payload.length, 3, '载荷长度正确');
  eq([...(d?.payload ?? [])].join(','), '10,20,30', '载荷逐字节一致');
});

test('帧头 · 文本帧往返(握手走这条)', () => {
  const f = encodeClientFrame(new TextEncoder().encode('{}'), true);
  const d = decodeClientFrame(f);
  eq(d?.kind, 'text', '识别为 text');
  eq(new TextDecoder().decode(d?.payload), '{}', 'JSON 可还原');
});

test('帧头 · 空帧与未知 tag ⇒ null(不崩)', () => {
  eq(decodeClientFrame(new Uint8Array(0)), null, '空帧 ⇒ null');
  eq(decodeClientFrame(new Uint8Array([9, 1])), null, '未知 tag ⇒ null');
});

/* ═══════════ 5b. ★★★ 下行帧分派:值碰撞回归守卫 ═══════════ */

console.log('\n— 下行帧分派(★ 含一处真实的值碰撞回归)—');

/**
 * ★★★ 这一节守的是一个**已被抓到过的真缺陷**,不是假想:
 *
 * ```
 * 服务端下行 = **裸协议包**(room.ts 三处出口都直接返回 `.bytes`)
 * 裸包首字节 = PROTOCOL_VERSION = **1** = 0x01 = FRAME_TEXT
 * ⇒ 第一版分派写的是 `if (bytes[0] === FRAME_TEXT) { 当 JSON 解析 }`
 *   ⇒ 裸包首字节恰好命中 ⇒ 被当 JSON ⇒ JSON.parse 抛 ⇒ state='failed'
 *   ⇒ ★ **端到端全线失败**
 * ⇒ 而本套件**从未测到** —— 因为原用例全部走 `binaryFrame()`(人为加了 0x02 tag),
 *   而真服务端**不加 tag**。
 * ```
 * ⇒ ∴ 本节同时钉两件事:① 四种下行形态都能通;② 那次碰撞的**具体值**被记住。
 */
test('分派 · ★ 裸协议包(真服务端行为)必须能通 —— 这是碰撞点', () => {
  const st = createRoomState('r');
  st.players.push(createPlayerState('p1', { name: 'n', x: 1, y: 2 }));
  const bare = encodeFull(st, 7).bytes;
  /* 先钉住碰撞的前提:裸包首字节 == FRAME_TEXT 的值(0x01) */
  eq(bare[0], 0x01, '★ 裸包首字节是 1');
  eq(bare[0], PROTOCOL_VERSION, '★ 它就是 PROTOCOL_VERSION');
  ok(bare[0] === 0x01, '★ 而与 FRAME_TEXT(0x01)**同值** —— 这就是碰撞');

  const d = classifyDownlink(bare);
  eq(d.kind, 'binary', '★ 必须判成 binary(不能因为首字节是 0x01 就当文本)');
  eq(d.payload.length, bare.length, '★ 且**不切字节**(裸包没有 tag 可切)');
  const pkt = decodePacket(d.payload);
  eq(pkt.tick, 7, '原样解码后 tick 正确');
});

test('分派 · 四种下行形态全部可通', () => {
  const st = createRoomState('r');
  st.players.push(createPlayerState('p1', { name: 'n', x: 1, y: 2 }));
  const bare = encodeFull(st, 7).bytes;
  const taggedBin = new Uint8Array(bare.length + 1);
  taggedBin[0] = 0x02; taggedBin.set(bare, 1);
  const json = new TextEncoder().encode(JSON.stringify({
    t: 'welcome', playerId: 'p1', roomId: 'r', protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-a',
  }));
  const taggedTxt = new Uint8Array(json.length + 1);
  taggedTxt[0] = 0x01; taggedTxt.set(json, 1);

  /* ① 裸包 ② 0x02+包 ⇒ binary;③ 裸 JSON ④ 0x01+JSON ⇒ text */
  const b1 = classifyDownlink(bare);
  eq(b1.kind, 'binary', '① 裸包 ⇒ binary');
  eq(b1.payload.length, bare.length, '① 不切字节');
  const b2 = classifyDownlink(taggedBin);
  eq(b2.kind, 'binary', '② tag+包 ⇒ binary');
  eq(b2.payload.length, bare.length, '② 切掉 1 字节');
  eq(decodePacket(b2.payload).tick, 7, '② 内容正确');
  eq(classifyDownlink(json).kind, 'text', '③ 裸 JSON ⇒ text');
  eq(classifyDownlink(taggedTxt).kind, 'text', '④ tag+JSON ⇒ text');
  eq(classifyDownlink(taggedTxt).payload.length, json.length, '④ 切掉 1 字节');
});

test('分派 · 空/极短输入不崩且归入 binary', () => {
  eq(classifyDownlink(new Uint8Array(0)).kind, 'binary', '空 ⇒ binary(长度 0,交给 store 按空帧处理)');
  eq(classifyDownlink(new Uint8Array(0)).payload.length, 0, '空 ⇒ 载荷 0 字节');
  eq(classifyDownlink(new Uint8Array([0x01])).kind, 'binary',
    '只有 0x01(无第 2 字节)⇒ binary —— 不能当成"带 tag 的空 JSON"');
  eq(classifyDownlink(new Uint8Array([0x7B])).kind, 'text',
    '只有 `{` ⇒ text(交给 JSON.parse 去报清晰错误)');
  /* ★ 长度守卫:切 tag 前必须确认"后面真有东西"。
     故障注入实测抓到过:去掉 `&& bytes.byteLength > 1` 后,`[0x02]` 会被切成
     **空载荷** ⇒ 于是它会被误当成「本 tick 无差量」的**空帧**而静默通过,
     而它其实是**无法解释的 1 字节输入** ⇒ 应归坏包(decode-failed),不该被吞。
     ⇒ 两种处置的可见性完全不同:空帧是"正常",坏包是"留痕"。 */
  eq(classifyDownlink(new Uint8Array([0x02])).payload.length, 1,
    '★ 1 字节 `[0x02]` ⇒ **不切**(长度守卫:后面没有可切的内容)');
  eq(classifyDownlink(new Uint8Array([0x02])).kind, 'binary', '且归 binary ⇒ 由 store 报坏包');
});

test('分派 · 真事件流:裸包与裸 JSON 都能被正确处理', () => {
  const st = createRoomState('r');
  st.players.push(createPlayerState('p1', { name: 'n', x: 1, y: 2 }));
  const bare = encodeFull(st, 7).bytes;
  const cp = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

  /* 空 store 从 0 开始 ⇒ 证明裸包真的被合入了 */
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {} },
  });
  fire('open', {});
  fire('message', { data: cp(bare) });
  eq(store.state.meta.tick, 7, '★ 裸包进了 store(碰撞前这里会失败)');
  eq(store.state.players.length, 1, '玩家进状态');
  eq(store.decodeErrors, 0, '不是坏包');
});

/* ═══════════ 6. 契约容纳两侧(为 registry 上移留位) ═══════════ */

console.log('\n— 握手契约:收必做、发留空(上移后只需填发的那半)—');

test('契约 · 客户端 hello 的 contentClaim **阶段 3 留空**', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'net', 'session.ts'), 'utf8');
  ok(src.includes('contentClaim: null'),
    '★ 发的那半留空(null)⇒ registry 上移后只需填这一处,**不改契约**');
  ok(src.includes('contentClaim: string'),
    '收的那半是必做字段(string)⇒ 阶段 3 已经会记账服务端指纹');
  /* hello 帧里的位置:字段存在且当前类型是 `null`(不是 optional —— 上移后要改成
     `ContentClaim | null` 的形状时,这里会提示改,而不会静默接受任意值) */
  ok(/contentClaim:\s*null;/.test(src),
    'hello 的 contentClaim 字段位在 ⇒ 上移后填值不需要新增字段');
});

test('契约 · 协议版本不符时**明确失败**,不静默降级', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'net', 'session.ts'), 'utf8');
  ok(src.includes('协议版本不匹配'),
    '★ 版本不符 ⇒ 置 failed 并写明原因(不静默继续)');
  ok(src.includes("setState('failed'"), '失败路径确实落到 failed 态');
});

test('契约 · session **不自己建 store**(否则渲染读的和网络写的是两个)', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'net', 'session.ts'), 'utf8');
  ok(src.includes('opts.store ?? new ClientStateStore()'),
    '★ store 由调用方传入(省略才自建)⇒ 「谁持有 store」是编译期可见的参数');
  /* ⚠️ 下面这条**必须剥注释**。故障注入实测抓到过:原判据用未剥注释的全文,
     而 main.ts 的 JSDoc 里**正好**写着 `createSession({ store: handle.store })` 作为说明
     ⇒ 把真正的接线那行删掉后,断言**仍然绿**(它匹配到了注释)。
     ⇒ 这是本仓咬过两次的形态:注释里提到符号名 ⇒ 判据同时出现假阴假阳。 */
  const mainCode = codeOf('client', 'src', 'main.ts');
  ok(mainCode.includes('store: handle.store'),
    '★ main.ts 的**代码**(非注释)把 boot 的 store 传进会话(避免"字节收到了、画面不动")');
  /* 计数式对照:代码里该引用恰好 1 处(不是被注释或重复行撑起来的) */
  const n = (mainCode.match(/store:\s*handle\.store/g) ?? []).length;
  eq(n, 1, `★ 剥注释后该接线恰好 1 处(实测 ${n})`);
});

/* ═══════════ 6b. ★ 会话行为:用**注入的假 socket** 测真事件流 ═══════════ */

console.log('\n— 会话行为(注入假 socket:不需要真网络,也不必 import boot.ts)—');

/**
 * 造一个**可控的假 WebSocket**:手动触发 open/message/close/error。
 *
 * ★ 为什么这是必要的(而不是"够用就行"):`session.ts` 里的事件处理逻辑
 * (握手解析、版本核对、帧分派)在**真实网络下几乎测不到边界**。
 * 而故障注入实测证明:把 `if (w.protocolVersion !== PROTOCOL_VERSION)` 改成 `if (false)`,
 * **无论断言 client 源码多少条都不会红** —— 因为它守的是**行为**,不是文本。
 * ⇒ 所以必须有一条真跑事件流的用例。
 *
 * ## ★ `binaryType` 必须被**如实建模**(不是摆设)
 *
 * 真 WebSocket 的 `binaryType` 默认是 `'blob'`。若它是 `'blob'`,二进制帧到达时
 * `ev.data` 是 **Blob** 而**不是** `ArrayBuffer` ⇒ `session.ts` 的
 * `raw instanceof ArrayBuffer` 判断为假 ⇒ **整条数据流被静默丢弃**:
 * 不抛错、不报错、`decodeErrors` 还是 0,只有画面永远停在出生点。
 *
 * ⇒ 初版假 socket 忽略了 `binaryType`(收到什么就给什么),于是
 *   「删掉 `socket.binaryType = 'arraybuffer'`」这个注入**查不出来** —— 假象全绿。
 * ⇒ 现在:若没设成 `'arraybuffer'`,message 事件按**Blob 形状**投递(带 `arrayBuffer()`),
 *   而它 **不是** `ArrayBuffer` 实例 ⇒ 行为缺陷会真实暴露。
 */
function fakeSocket() {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  const sent: Uint8Array[] = [];
  let closed = false;
  const sock = {
    /* ★ 真 WebSocket 的默认值,不是 'arraybuffer' */
    binaryType: 'blob',
    readyState: 1,
    send(d: Uint8Array): void { sent.push(d); },
    close(): void { closed = true; sock.readyState = 3; },
    addEventListener(t: string, fn: (ev: never) => void): void {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t)!.push(fn as (ev: unknown) => void);
    },
  };
  /**
   * 触发事件。`message` 会**按 `binaryType` 投递**:
   *   'arraybuffer' ⇒ 原样给 ArrayBuffer
   *   其它           ⇒ 给一个 **Blob 形状**的对象(核心:它不是 ArrayBuffer 实例)
   */
  const fire = (t: string, ev: unknown): void => {
    let payload = ev;
    if (t === 'message') {
      const d = (ev as { data?: unknown }).data;
      /* ★ 用**真 `Blob`**(不是形状相似的假对象)—— 因为 `describePayload` 用的是
         `raw instanceof Blob`,假对象过不了它。这也正是"如实建模"的要求:
         用真类型才能测到真行为。 */
      const blobLike = sock.binaryType === 'arraybuffer'
        ? d
        : new Blob([d as ArrayBuffer]);
      payload = { data: blobLike };
    }
    for (const h of handlers.get(t) ?? []) h(payload);
  };
  return { sock, sent, fire, isClosed: () => closed };
}

/** 造一帧**文本**(服务端下行握手)= 1 字节 tag 0x01 + JSON */
function textFrame(obj: unknown): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const f = new Uint8Array(body.length + 1);
  f[0] = 0x01;
  f.set(body, 1);
  return f.buffer as ArrayBuffer;
}

/** 造一帧**二进制**(服务端下行协议包)= 1 字节 tag 0x02 + 原始字节 */
function binaryFrame(bytes: Uint8Array): ArrayBuffer {
  const f = new Uint8Array(bytes.length + 1);
  f[0] = 0x02;
  f.set(bytes, 1);
  return f.buffer as ArrayBuffer;
}

test('会话 · open ⇒ 发出 hello(版本号取自共享协议常量,指纹留空)', () => {
  const { sock, sent, fire } = fakeSocket();
  const s = createSession({
    url: 'ws://x/',
    makeSocket: () => sock as never,
    store: new ClientStateStore(),
    events: { onFrame: () => {} },
  });
  eq(s.state, 'connecting', '建会话后进入 connecting');
  eq(sent.length, 0, '连接前不发东西');

  fire('open', {});
  eq(sent.length, 1, 'open 后发出 1 帧');
  const d = decodeClientFrame(sent[0]!);
  eq(d?.kind, 'text', '★ 第一帧是**文本**(握手走文本通道)');
  const hello = JSON.parse(new TextDecoder().decode(d?.payload)) as Record<string, unknown>;
  eq(hello.t, 'hello', '帧类型 hello');
  eq(hello.protocolVersion, PROTOCOL_VERSION, '★ 版本号 == 共享协议常量(不是本地写的数)');
  eq(hello.contentClaim, null, '★ 阶段 3 指纹留空(registry 上移后才填)');
});

test('会话 · welcome ⇒ 置 live、记下 playerId 与**服务端指纹**', () => {
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {} },
  });
  fire('open', {});
  fire('message', {
    data: textFrame({
      t: 'welcome', playerId: 'p1', roomId: 'r1',
      protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-abc',
    }),
  });
  eq(s.state, 'live', '握手完成 ⇒ live');
  eq(store.localPlayerId, 'p1', '★ playerId 写进了**同一个** store(圆心要用)');
  eq(s.serverContentClaim, 'v1-abc', '★ 服务端指纹被记账(阶段 3 只收不发)');
});

test('会话 · ★ 版本不符 ⇒ 明确失败,不静默继续(故障注入实测的盲区)', () => {
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  const details: string[] = [];
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {}, onState: (st, d) => details.push(`${st}:${d ?? ''}`) },
  });
  fire('open', {});
  fire('message', {
    data: textFrame({
      t: 'welcome', playerId: 'p1', roomId: 'r1',
      protocolVersion: PROTOCOL_VERSION + 1,   /* 服务端版本更高 */
      contentClaim: 'v9-zzz',
    }),
  });
  eq(s.state, 'failed', '★ 版本不符 ⇒ failed(不静默降级到 live)');
  eq(store.localPlayerId, '', '★ 失败的握手**没有**污染 store(不写入 playerId)');
  eq(s.serverContentClaim, null, '★ 也不记指纹(握手没有成立)');
  ok(details.some((x) => x.includes('协议版本不匹配')),
    `失败原因被写明(实测:${details.join(' | ').slice(0, 70)})`);
});

test('会话 · 二进制帧 ⇒ 字节进 store,状态真的推进', () => {
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  const frames: unknown[] = [];
  createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: (r) => frames.push(r) },
  });
  fire('open', {});
  fire('message', { data: textFrame({ t: 'welcome', playerId: 'p1', roomId: 'r', protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-a' }) });

  const pkt = encodeFull(authState('p1', 12.5, 7.25), 99);
  fire('message', { data: binaryFrame(pkt.bytes) });
  eq(store.state.meta.tick, 99, '★ 协议包被解包并合入(走的是一条真实事件流)');
  eq(store.state.players.length, 1, '玩家进状态');
  eq(frames.length, 1, 'onFrame 回调被调了一次');
});

test('会话 · ★ 0 字节帧(真·零字节)⇒ 不崩,且不误报为坏包', () => {
  /* ⚠️ 本用例被**改过一次**,原因值得记:
     初版写的是 `binaryFrame(new Uint8Array(0))` —— 即 `[0x02]`(一个 tag + 零载荷)。
     ⇒ 但**服务端真实发的 0 字节帧是"真的 0 字节"**(room.ts:1154 `new Uint8Array(0)`),
       **不带任何 tag** ⇒ 初版那个形态在线上**不会出现**。
     ⇒ 修复值碰撞后,`[0x02]` 被判为"1 字节裸包" ⇒ 走 decodePacket ⇒ 抛(归坏包)。
       这**是对的**:1 字节在真协议里不可能合法(协议头就要 6 字节)。
     ⇒ ∴ 本用例改为喂**真·零字节** —— 那才是线上形态。 */
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {} },
  });
  fire('open', {});
  let threw = false;
  try { fire('message', { data: new ArrayBuffer(0) }); } catch { threw = true; }
  ok(!threw, '不抛');
  eq(store.emptyFrames, 1, '★ 认成空帧(不是 decode-failed)');
  eq(store.decodeErrors, 0, '★ 不误报为坏包');

  /* 对照:`[0x02]` 这种"带 tag 但无载荷"的形态 ⇒ 归坏包(它在线上不出现,且确实无意义) */
  const store2 = new ClientStateStore();
  const r2 = store2.apply(new Uint8Array([0x02]));
  eq(r2.skipped, 'decode-failed', '对照:[0x02] 单字节 ⇒ 坏包(协议头长度不足)');
});

test('会话 · ★★ 没设 binaryType ⇒ 数据被丢,但**必须留痕**(不许静默)', () => {
  /* 真 WebSocket 的 binaryType 默认是 **'blob'**(实测)。
     ⇒ 若 session.ts 不显式设成 'arraybuffer',二进制帧到的是 Blob ⇒ 全部丢弃。
     ⇒ 危险点不是"丢"(那是必然),而是**丢得没有痕迹**:
       decodeErrors=0、emptyFrames=0、state='live' ⇒ 画面永远停在出生点而指标全绿。
     ⇒ 所以本用例守的是「**丢弃必须可观测**」这条。 */
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  const drops: string[] = [];
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {}, onDrop: (r) => drops.push(r) },
  });
  fire('open', {});
  eq(sock.binaryType, 'arraybuffer', '★ session 把 binaryType 设成了 arraybuffer');

  /* 强行改回 blob,模拟"有人删掉了那行" */
  sock.binaryType = 'blob';
  fire('message', { data: binaryFrame(encodeFull(authState('p1', 3, 4), 5).bytes) });

  eq(store.state.meta.tick, 0, 'Blob 载荷没能进 store(故数据确实丢了)');
  eq(s.droppedFrames, 1, '★★ 但丢弃被**计数**了(不是静默)');
  ok(s.lastDropReason !== null && s.lastDropReason.includes('Blob'),
    `★ 原因指明是 Blob(实测:${s.lastDropReason?.slice(0, 50)})`);
  eq(drops.length, 1, 'onDrop 回调被触发');
  /* ★ 关键区分:这不是"坏包",是"形态不对" —— 两个计数器意义不同 */
  eq(store.decodeErrors, 0, '不计入解码错误(根本没走到解码)');

  /* 对照:设回 arraybuffer 后同一帧就能进 */
  sock.binaryType = 'arraybuffer';
  fire('message', { data: binaryFrame(encodeFull(authState('p1', 3, 4), 6).bytes) });
  eq(store.state.meta.tick, 6, '★ 设对 binaryType 后同一帧正常合入 ⇒ 证明差异就是形态');
  eq(s.droppedFrames, 1, '丢弃数没再增长');
});

test('会话 · 非二进制载荷(字符串/对象)⇒ 忽略但**留痕**,不崩', () => {
  const { sock, fire } = fakeSocket();
  const store = new ClientStateStore();
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store,
    events: { onFrame: () => {} },
  });
  fire('open', {});
  let threw = false;
  try {
    fire('message', { data: 'plain string' });
    fire('message', { data: { weird: true } });
    fire('message', { data: null });
  } catch { threw = true; }
  ok(!threw, '★ 非二进制载荷被忽略,渲染循环不被打断');
  eq(s.droppedFrames, 3, '★ 三次都被计数(可观测,不是静默)');
  eq(store.decodeErrors, 0, '不算解码错误(形态问题 ≠ 坏包)');
});

test('会话 · close ⇒ 状态置 closed;close() 幂等', () => {
  const { sock, fire } = fakeSocket();
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never,
    store: new ClientStateStore(), events: { onFrame: () => {} },
  });
  fire('open', {});
  fire('close', {});
  eq(s.state, 'closed', '对端关闭 ⇒ closed');
  s.close();
  s.close();
  eq(s.state, 'closed', 'close() 幂等(连调两次不抛)');
});

test('会话 · 未连接时 send ⇒ 返回 false(不抛)', () => {
  const { sock } = fakeSocket();
  sock.readyState = 0;  /* CONNECTING */
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never,
    store: new ClientStateStore(), events: { onFrame: () => {} },
  });
  eq(s.send(new Uint8Array([1])), false, '★ 未 OPEN ⇒ false(不抛)');
});

test('会话 · ★ store 由调用方传入 ⇒ 会话与 boot 用**同一个**对象', () => {
  /* 这条用**行为**证明 main.ts 的接线意图:`opts.store` 真的被使用。
     故障注入实测:把 main.ts 的 `store: handle.store` 删掉,只断言源码文本**不会红**
     (因为 session.ts 内部 `?? new ClientStateStore()` 是合法的降级路径)。
     ⇒ 真正的判据是「传进去的那个对象被写了吗」。 */
  const { sock, fire } = fakeSocket();
  const shared = new ClientStateStore();
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock as never, store: shared,
    events: { onFrame: () => {} },
  });
  ok(s.store === shared, '★ 会话持有的 store **就是**传入的那个(同一引用)');
  fire('open', {});
  fire('message', { data: binaryFrame(encodeFull(authState('p1', 3, 4), 5).bytes) });
  eq(shared.state.meta.tick, 5, '★ 传入的 store 收到了数据(故 boot 的渲染循环能读到)');
  eq(s.store.state.meta.tick, 5, '两边读的是同一份状态');
});

/* ═══════════ 7. ★ 判据一(弱):接线点文本断言 ═══════════ */

console.log('\n— 判据一(弱):boot.ts 的接线点 —');

/**
 * ⚠️⚠️ **弱判据声明** ⚠️⚠️
 *
 * 下面这几条只读 `boot.ts` 的**源码文本**。它们证明的是
 * «这个调用点**存在**»,**不**证明它被**正确调用**、也**不**证明运行期行为正确。
 *
 * 为什么只能这样:`boot.ts` 的闭包含三方 `three` ⇒ Node 里 import 不了
 * (实测:全仓无任何测试 import `three/` 下文件)。
 *
 * ⇒ 真正证明行为的是本文件 §1 的**往返判据**(强),
 *   以及 Lead 新加的 **vite 构建门禁**(它至少保证 boot.ts 可被打包)。
 *   三者强度不同,叠加使用 —— **不要把这一节读成"行为已验证"**。
 */
test('判据一(弱) · boot.ts 的圆心绑到权威来源', () => {
  const code = codeOf('client', 'src', 'three', 'boot.ts');
  /* ★★ 必须锚定**渲染循环里的那次绑定**,不能只查「文件里出现过 telegraphCenterOf」。
     故障注入实测抓到过这个漏洞:把渲染循环改成 `const center = { cx: pan.x, cy: pan.y }`,
     而 `summary()` 里**还有一处** telegraphCenterOf 调用 ⇒ 宽松判据仍然绿。
     ⇒ 原判据的视野覆盖了整个文件,而被测本体只是**帧循环里那一处**。 */
  ok(/const center = telegraphCenterOf\(authority\.state, authority\.localPlayerId\)/.test(code),
    '★ 弱:帧循环里 center **直接**绑定到 telegraphCenterOf(权威状态)—— 不是从 pan 抄的');
  ok(code.includes('cx: playerGx') && code.includes('cy: playerGy'),
    '★ 弱:预警圈 spec 的 cx/cy 仍取自 playerGx/playerGy(接到权威来源的那两个量)');
  /* 反面对照:绑定右侧不得出现 pan */
  const bind = /const center = ([^;]+);/.exec(code);
  ok(bind !== null, '能取到 center 的绑定式');
  ok(!/pan\./.test(bind?.[1] ?? ''),
    `★ 弱:center 的绑定式**不含 pan**(实测:${bind?.[1]?.trim().slice(0, 60)})`);
});

test('判据一(弱) · 旧的「把相机当玩家」写点**已不存在**', () => {
  const code = codeOf('client', 'src', 'three', 'boot.ts');
  const live = code.split('\n').filter((l) => /playerGx\s*=\s*pan\.x/.test(l));
  eq(live.length, 0,
    '★ 弱:代码里**没有** `playerGx = pan.x`(S1 已删;若回归则任何权威值都被同帧覆盖)');
  const live2 = code.split('\n').filter((l) => /playerGy\s*=\s*pan\.y/.test(l));
  eq(live2.length, 0, '★ 弱:代码里没有 `playerGy = pan.y`');
});

test('判据一(弱) · playerGx 的**每帧**写点唯一且来自权威', () => {
  const code = codeOf('client', 'src', 'three', 'boot.ts');
  const writes = code.split('\n')
    .filter((l) => /(^|\s)playerGx\s*=(?!=)/.test(l))
    /* 排除 `let` 声明(那是初始化,不是每帧写点) */
    .filter((l) => !/\blet\s+playerGx\s*=/.test(l));
  eq(writes.length, 1,
    `★ 弱:playerGx 的**赋值**写点恰好 1 处(实测 ${writes.length}:${writes.join(' | ').trim().slice(0, 80)})`);
  ok(/=\s*center\.cx/.test(writes[0] ?? ''),
    '★ 弱:那一处取自 center.cx(权威)');
  /* 声明点仍存在(证明不是把整个变量删掉了) */
  ok(/let\s+playerGx\s*=/.test(code), '声明点仍在(`let playerGx = ...`)');
});

/* ═══════════ 8. 模块纯净性(可测的前提) ═══════════ */

console.log('\n— 三个新模块必须纯(否则上面所有行为判据都跑不起来)—');

test('纯净 · 三个新模块不引入三方依赖、不引 node:', () => {
  /* ★ 这条只能做**文本**判据,不能做行为判据 —— 原因是实测出来的:
     `node_modules/three` **存在** ⇒ 动态 `import('three')` 在同一进程里能解析成功
     ⇒ 行为式判据对"偷偷用了三方"这件事**是盲的**(它会绿)。
     ∴ 用文本正则。而**必须覆盖三种导入形态** —— 只查 `from` 是漏的:
       ① `import x from 'pkg'`      (具名/默认导入)
       ② `import 'pkg'`             (裸副作用导入)← `from` 形态查不到
       ③ `await import('pkg')`      (动态导入)    ← `from` 形态查不到
     ⚠️ 后两种是 `judgement_audit` 的 C 检测器**正确指出**的:
        我第一版只写了 `/from\s*['"].../`,它报「只认 from,未覆盖裸副作用与动态 import()」——
        ★ 那条**不是误报**,是真的漏:用 `import 'three'` 就能绕过我的纯净判据。
     ⇒ 判据:**三种形态合并成一个正则里**捕获,任一命中即算引入外部模块。 */
  const EXTERNAL_MODULE_RE = /(?:\bfrom\s*|(?<![\w.])import\s*\(?\s*)['"]([^'".][^'"]*)['"]/g;
  const ALLOWED_EXTERNAL: readonly string[] = [];   /* 三个模块的许用外部模块:无 */
  for (const f of ['telegraph_center.ts', 'state_store.ts', 'session.ts']) {
    const code = codeOf('client', 'src', 'net', f);
    const ext = [...code.matchAll(EXTERNAL_MODULE_RE)].map((m) => m[1]);
    eq(ext.length, ALLOWED_EXTERNAL.length,
      `★ ${f} 零外部模块导入(实测:${JSON.stringify(ext)})`);
  }
  ok(ALLOWED_EXTERNAL.length === 0, '许用外部模块列表为空(三个新模块都不许引三方/node:)');

  /* ★ 自检:证明这个正则**真的**能抓住三种形态 ——
     否则「0 命中」既可能是"代码干净",也可能是"正则根本没在匹配"。
     (这是"阴性对照":把三种形态喂给正则,必须各抓到 1 条。) */
  for (const [form, sample] of [
    ['具名 from', "import { a } from 'three';"],
    ['裸副作用', "import 'three';"],
    ['动态', "const m = await import('three');"],
  ] as const) {
    const hits = [...sample.matchAll(EXTERNAL_MODULE_RE)].map((m) => m[1]);
    eq(hits.length, 1, `★ 自检:正则能抓住「${form}」形态(实测抓到 ${JSON.stringify(hits)}`);
    eq(hits[0], 'three', `★ 自检:「${form}」抓到的模块名是 three`);
  }
  /* 相对导入**不该**被算成外部 —— 否则判据会把正常代码判红 */
  for (const sample of ["import { a } from './x.ts';", "import '../../../shared/types/wire.ts';"]) {
    eq([...sample.matchAll(EXTERNAL_MODULE_RE)].length, 0, `相对导入不算外部:${sample}`);
  }
});

test('纯净 · session.ts 是**唯一**碰 WebSocket 的客户端文件(其余不许扩散)', () => {
  ok(codeOf('client', 'src', 'net', 'session.ts').includes('WebSocket'),
    'session.ts 里用 WebSocket(它是通道本体)');
  /* 另外两个**代码里**不许碰 —— 通道与状态解耦,否则状态层就没法在 Node 里测。
     (注释里提到 WebSocket 是允许的:那是解释"为什么这里不碰它"。) */
  for (const f of ['state_store.ts', 'telegraph_center.ts']) {
    ok(!/WebSocket/.test(codeOf('client', 'src', 'net', f)),
      `★ ${f} 的**代码**不碰 WebSocket(状态/几何与通道解耦)⇒ 可在 Node 里直接测`);
  }
});

/* ═══════════ 9. 协议常量(防止两端各写一份) ═══════════ */

console.log('\n— 协议常量:只有一份实现 —');

test('协议 · 客户端用的是 delta.ts 的 PROTOCOL_VERSION(不是自己写的数)', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'net', 'session.ts'), 'utf8');
  ok(src.includes('PROTOCOL_VERSION'),
    '★ hello 里发的版本号来自 shared/net/delta.ts ⇒ 不出现第二份字面量');
  ok(src.includes("from '../../../shared/net/delta.ts'"),
    'session.ts 从共享协议模块取常量');
  ok(PROTOCOL_VERSION >= 1, `协议版本是个正整数(实测 ${PROTOCOL_VERSION})`);
});

test('协议 · state_store 用共享的 applyPacket/decodePacket(不自己解包)', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'net', 'state_store.ts'), 'utf8');
  ok(src.includes('applyPacket') && src.includes('decodePacket'),
    '★ 解包/合入都复用 shared/net/delta.ts ⇒ 两端只有一份协议实现');
  ok(!/Uint8Array[\s\S]{0,80}readU8/.test(src),
    'state_store 不自己写字节读取(那会是第二份实现)');
});

report('WS-12');
