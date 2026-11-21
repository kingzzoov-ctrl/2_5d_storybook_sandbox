/**
 * WS-FND-178 —— 反作弊水位的**重锚**:世界自己挪了刚体之后,判据的参考点必须跟着走
 *
 * 运行:`node tests/WS-FND-178-anticheat-watermark-reanchor.test.ts`
 *
 * ## 症状(60 分钟 soak 实测,证据已定因 —— 本套件不重新论证它)
 *
 * ```
 * ledgers.acViolations 饱和到 512(环形容量),抓到的 512 条**全部**是:
 *   {"kind":"TELEPORT","tick":854,"playerId":"soak_c1","detail":"单帧位移 0.802 格 > 上界 0.225","weight":4}
 *   {"kind":"TELEPORT","tick":886,"playerId":"soak_c2","detail":"单帧位移 2.017 格 > 上界 0.225","weight":4}
 * SPEED 0 条。上界 0.225 = maxDisplacementPerTick(1) = 4.5 × 0.03125 × 1.6。
 * ```
 *
 * ## 根因(修点)
 *
 * `checkMove` 放行时把水位(`lastX/lastY/lastZ`)推到**申报坐标**,而世界可能把刚体
 * 放到别处(撞墙滑行 / 落地沉降 / 台阶 / **击退** / 被世界拒收),水位在修前又只有
 * `checkMove` 一个写入点 ⇒ 权威刚体与 AC 水位**永久偏离**。客户端按权威坐标重新起算的
 * 下一包就被判瞬移,而这一包被拒之后房间**提前返回**、世界与水位都不再更新 ⇒
 * **每个移动包都违规、永不收敛**(实测发作点 ≈92 秒,3 分钟内灌满环,≈96% 移动包被拒)。
 *
 * 两处修点(见 `server/src/net/anticheat.ts#syncWatermark` 与 `room.ts#applyMove`):
 * ```
 * A. AntiCheatRoom.syncWatermark(id,x,y,z) —— 只写水位三个坐标、三个都必须有限
 *    (fail-closed),不碰 window / lastTick / lastMoveTick / 流水 / 分数
 * B. room.applyMove 的**两条**路径都锚到「调用之后」的权威刚体:
 *    · 世界拒收路径:重读 hostPositionOf ⇒ 写 p / corrected / 水位(修前用 authBefore,
 *      而世界在同一次调用里可能已经把刚体改了 ⇒ 两处都写**陈旧值**)
 *    · 正常放行路径:无条件先读一次权威,投影与水位取**同一次读数**
 * ```
 *
 * ## 判据(本套件怎么做到「修了就红」)
 *
 * 1 读数一律取**权威口径**:`sim.playerPosition()`(= `hostPositionOf` 的同一读口)
 *   与 `rt.ac.get(id)` 的水位三个坐标,**不**读实现内部的新字段;
 * 2 每条正判据都从**真实世界**造形状(真击退 `applyKnockback` + 真慢帧 `advance`,
 *   真跳跃 `tryPlayerJump` + 真 z 裁决),不靠墙钟、不 sleep、不睡长跑:
 *   全部发生在 < 3 秒的定帧推进里(判据里的每一帧都是显式 `advance` / `tick`);
 * 3 **负对照**(三条,分别驳三种「假绿」):
 *    · FND178-3:同形状但**绕过重锚**(只过 `ac.move`,房间两条路径一条都不走)
 *      ⇒ 从权威刚体出发的诚实包**必须**被判 TELEPORT(否则本条门禁是恒绿的);
 *    · FND178-4:注入一个「**同一次调用里先搬刚体、再报拒收**」的世界源
 *      ⇒ `corrected` / 投影 / 水位都必须是**调用之后**的权威值(修前是陈旧值);
 *    · FND178-5:从**当前权威刚体**出发、位移超出单帧上界的包仍必须 TELEPORT
 *      (证明重锚没有把瞬移检查关掉;刚好合界的包仍放行 ⇒ 上界没被放宽);
 * 4 FND178-6 单独钉 `syncWatermark` 自己的契约(未登记 ⇒ 空操作;非有限值 ⇒ 整次
 *    不生效;窗口 / 两个时钟水位 / 流水 / 分数一律不动)。
 *
 * ⚠️ 本套件**不**断言任何判据常量被改过:`maxDisplacementPerTick(1)` 仍是 0.225,
 * `SPEED_WINDOW_TOLERANCE` / `TELEPORT_SLACK` 一字未动(重锚只挪参考点,不放宽上界)。
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { ViolationKind, fixedClock, maxDisplacementPerTick } from '../server/src/net/anticheat.ts';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const SIZE = 32;
const SEED = 178;
/** 单帧**合法**位移(格):`BASE_MOVE_SPEED × DT` = 0.140625 @32Hz ——
    小于单帧上界 0.225。步长一律由它派生(写死数字只在某一档帧率下合法)。 */
const LEGAL_STEP = BASE_MOVE_SPEED * DT;
/** 击退总距离(格):`applyKnockback` 的上界是 2(WS-FND-98),1.0 足够越过单帧上界。 */
const KNOCK_CELLS = 1;

let seq = 0;
function freshId(tag: string): string {
  seq += 1;
  return `fnd178_${tag}_${seq}`;
}

interface RoomFixture {
  rt: RoomRuntime;
  sim: WorldSim;
  clock: ReturnType<typeof fixedClock>;
}

/**
 * 一房一世界(与 `tests/WS-FND-135` 逐点同形:房间把 `WorldSim` 当世界源)。
 *
 * 只清 0..8 格的**物件** ⇒ 出生点周围是开阔地,击退的 `sweepCircle` 不会被地形
 * 提前挡下(挡下会**立刻关窗**,形状就退化成「世界什么都没搬」)。
 */
function freshRoom(tag: string): RoomFixture {
  const clock = fixedClock(1_700_000_000_000);
  const rt = new RoomRuntime({ roomId: freshId(tag), ownerId: 'owner', clock: clock.clock });
  const sim = new WorldSim({ sizeCells: SIZE, mobs: false, wiring: false, seed: SEED });
  rt.worldSaveHost = sim as unknown as WorldSaveHost;
  const j = rt.join({ userId: 'p1' });
  ok(j.ok, '前置:玩家进场(世界侧同时登记刚体,与生产同一路径)');
  for (let x = 0; x <= 8; x += 1) for (let y = 0; y <= 8; y += 1) sim.setCell(x, y, { obj: 0 });
  return { rt, sim, clock };
}

/** 推进房间一帧(与 `step()` 同构:`meta.tick += 1` 之后 `ac.tick`)—— 不推进世界。 */
function bumpTick(rt: RoomRuntime): number {
  rt.state.meta.tick += 1;
  rt.ac.tick(rt.state.meta.tick);
  return rt.state.meta.tick;
}

/** 权威刚体(`hostPositionOf` 的同一读口)。 */
function authOf(f: RoomFixture): { x: number; y: number; z: number } {
  const p = f.sim.playerPosition('p1');
  ok(p !== null, '前置:世界侧有权威刚体');
  return p!;
}

/** 该玩家的 AC 水位。 */
function wmOf(f: RoomFixture): { x: number; y: number; z: number } {
  const s = f.rt.ac.get('p1');
  ok(s !== undefined, '前置:反作弊里有这个玩家');
  return { x: s!.lastX, y: s!.lastY, z: s!.lastZ };
}

/** 水位 == 权威刚体(三个坐标、精确相等:同一读数的拷贝,不是浮点运算结果)。 */
function wmEqAuth(f: RoomFixture): boolean {
  const w = wmOf(f);
  const a = authOf(f);
  return w.x === a.x && w.y === a.y && w.z === a.z;
}

/** 一包「诚实移动」:从**权威刚体**出发走一个合法步长(客户端按权威重新起算)。 */
function honestMoveFromAuth(f: RoomFixture): ReturnType<RoomRuntime['applyMove']> {
  const a = authOf(f);
  return f.rt.applyMove('p1', { tick: bumpTick(f.rt), x: a.x + LEGAL_STEP, y: a.y, z: a.z });
}

/** 一包「诚实移动」:从**房间投影**出发(soak 夹具的形态 —— 假客户端只能看到投影)。 */
function honestMoveFromProj(f: RoomFixture): ReturnType<RoomRuntime['applyMove']> {
  const p = f.rt.playerState('p1');
  ok(p !== undefined, '前置:投影里有这个玩家');
  return f.rt.applyMove('p1', { tick: bumpTick(f.rt), x: p!.x + LEGAL_STEP, y: p!.y, z: 0 });
}

/* ═══════════ 1. 正例:世界自己搬家(击退)⇒ 水位跟着走 ═══════════ */

test('FND178-1 ★★ 击退窗口:世界自己搬刚体 + 世界拒收搬家 ⇒ 每包都不判违规,水位恒 == 权威刚体;关窗后的诚实包放行', () => {
  const f = freshRoom('knock');
  const { rt, sim } = f;

  /* ── 前置:一包诚实移动(水位 / 窗口 / 权威三者对齐) ── */
  const first = honestMoveFromAuth(f);
  eq(first.allowed, true, '前置:合法小步放行');
  eq(wmEqAuth(f), true, '前置:水位与权威同源');
  const anchor = authOf(f);
  eq(rt.ac.violations().length, 0, '前置:零违规');

  /* ── 世界自己搬家:击退(慢帧分两步推刚体)+ 期间所有移动报文都被世界拒收 ──
     这正是 soak 里 92 秒那一瞬间的形状:`applyPlayerMove` 返回 `false`(窗口开着),
     而刚体在这一帧里被世界推走了 —— 没有任何**被接受的移动**记录这次位移。 */
  eq(sim.applyKnockback('p1', -5, -5, KNOCK_CELLS), true, '前置:击退真的施加了');
  eq(sim.knockbackOf('p1'), true, '前置:搬家窗口开着(这段时间世界会拒收移动)');

  const seen: { allowed: boolean; worldRejected: boolean | undefined; kind: string | undefined }[] = [];
  let wmDrift = 0;
  let slowFrames = 0;
  /* 循环条件读**世界**的窗口状态(不写死步数:击退走几步由世界自己决定,
     写死 2 会在世界改步数时变成空断言)。上限 8 只是防空转。 */
  while (sim.knockbackOf('p1') && slowFrames < 8) {
    sim.advance(FAST_PER_SLOW);            /* 1 个慢帧 = 击退推一步(真世界,不是注入) */
    slowFrames += 1;
    const r = honestMoveFromProj(f);       /* soak 的假客户端:从投影起算 */
    seen.push({ allowed: r.allowed, worldRejected: r.worldRejected, kind: r.violation?.kind });
    if (!wmEqAuth(f)) wmDrift += 1;
  }
  ok(slowFrames >= 1, '前置:击退至少推进了一个慢帧');
  eq(sim.knockbackOf('p1'), false, '前置:击退窗口已关(世界现在会接受搬家)');
  const worldRejects = seen.filter((s) => s.worldRejected === true).length;
  ok(worldRejects > 0, `前置:至少有一包撞在世界的搬家窗口上(${worldRejects}/${seen.length})`);
  eq(seen.filter((s) => s.kind === ViolationKind.TELEPORT).length, 0,
    `★★ 击退期间**零** TELEPORT(修前:第二包起每一包都是 TELEPORT)`);
  eq(seen.filter((s) => s.kind === ViolationKind.SPEED).length, 0,
    `★★ 击退期间**零** SPEED(修前那条缓慢漂移会把窗口均速读数顶上界)`);
  eq(rt.ac.violations().length, 0, '★★ 整个击退窗口**零违规**(合法玩家不被误判)');
  eq(wmDrift, 0, '★★ 每一包之后:AC 水位 == 权威刚体(修前恒不相等)');

  /* ── 关窗后:从**权威刚体**出发的下一包诚实移动必须放行 ── */
  sim.advance(FAST_PER_SLOW);
  eq(sim.knockbackOf('p1'), false, '前置:击退窗口已关(世界现在会接受搬家)');
  const after = authOf(f);
  const moved = Math.hypot(after.x - anchor.x, after.y - anchor.y);
  ok(moved > maxDisplacementPerTick(1),
    `前置:世界把刚体搬出了单帧上界之外(${moved.toFixed(3)} > ${maxDisplacementPerTick(1)})`);
  const next = honestMoveFromAuth(f);
  eq(next.allowed, true, '★★ 关窗后从**权威刚体**出发的诚实包放行(修前:按旧水位判成瞬移)');
  eq(next.violation, undefined, '★ 这一包没有任何违规记录');
  eq(rt.ac.violations().length, 0, '★ 仍然零违规');
  eq(wmEqAuth(f), true, '★ 水位 == 权威刚体(诚实移动之后仍然如此)');
  eq(rt.worldMoveRejects, worldRejects, '★ 世界拒收计数只来自击退窗口那几包(关窗后世界真的接受了)');
});

/* ═════════ 2. 正例:世界采纳平面但把 z 裁决成自己的值(空中/落地) ═════════ */

test('FND178-2 ★★ 世界采纳了坐标却把 z 裁决成权威值(空中/落地)⇒ 水位三个坐标一起锚到权威', () => {
  const f = freshRoom('air');
  const { rt, sim } = f;

  eq(sim.tryPlayerJump('p1').jumped, true, '前置:真的起跳了(否则下面全是空断言)');
  for (let i = 0; i < 3; i += 1) sim.tick();
  const air = authOf(f);
  ok(air.z > 0.05, `前置:服务端已经把人抬到 z=${air.z.toFixed(3)}(水平位移同一时刻发生)`);

  /* 报文明说 `z: 0`(地面高度),世界按 `lastZAuthority` 裁决**不采纳**它。 */
  const r = honestMoveFromProj(f);
  eq(r.allowed, true, '前置:平面写入被接受');
  eq(sim.lastZAuthority?.source, 'SERVER', '前置:z 由服务端裁决(不是「恰好相等」)');
  const after = authOf(f);
  ok(Math.abs(after.z - air.z) < 1e-9, '前置:世界没有把高度抹平');
  eq(wmOf(f).z, after.z, '★★ 水位 z == 权威 z(修前停在申报值 0 ⇒ 参考点与刚体不一致)');
  eq(rt.playerState('p1')!.z, after.z, '★ 投影 z 与水位取自同一次读数(= 权威)');
  eq(wmEqAuth(f), true, '★★ 三个坐标一起 == 权威刚体');
  eq(honestMoveFromAuth(f).allowed, true, '★ 从权威刚体出发的下一包诚实移动放行');
  eq(rt.ac.violations().length, 0, '★ 零违规');
});

/* ═════════ 3. 牙:绕过重锚 ⇒ 权威出发的诚实包必须被判瞬移 ═════════ */

test('FND178-3 ★★ 牙(负对照):同形状但**绕过重锚**(只过 `ac.move`)⇒ 权威出发的诚实包被判 TELEPORT', () => {
  const f = freshRoom('bypass');
  const { rt, sim } = f;

  eq(honestMoveFromAuth(f).allowed, true, '前置:一包诚实移动(水位 = 权威 = 起点 + δ)');
  const anchor = authOf(f);
  const w0 = wmOf(f);
  eq(w0.x, anchor.x, '前置:水位与权威同源');

  /* 同一个形状:世界自己把刚体搬走(击退两步走完、窗口关掉)。 */
  eq(sim.applyKnockback('p1', -5, -5, KNOCK_CELLS), true, '前置:击退施加');
  sim.advance(FAST_PER_SLOW * 2);
  eq(sim.knockbackOf('p1'), false, '前置:窗口已关');
  const moved = authOf(f);
  const drift = Math.hypot(moved.x - anchor.x, moved.y - anchor.y);
  ok(drift > maxDisplacementPerTick(1),
    `前置:权威刚体被搬到 ${drift.toFixed(3)} 格外(> 单帧上界 ${maxDisplacementPerTick(1)})`);

  /* ── 绕过重锚:客户端只过反作弊闸,房间那两条重锚路径**一条都不经过** ──
     (等价于修前的 `applyMove`:水位推进到申报坐标,而世界自己挪的那一段
      **永远**不会写回水位) */
  for (let k = 1; k <= 2; k += 1) {
    const v = rt.ac.move({
      playerId: 'p1', tick: bumpTick(rt), x: w0.x + LEGAL_STEP * k, y: w0.y, z: 0,
    });
    eq(v.allowed, true, `注入组 ${k}:逐包都在单帧额度内(绕过的是重锚,不是判据)`);
  }
  eq(rt.worldMoveRejects, 0, '负对照:世界侧拒收计数为 0 —— 这条路径上房间根本没参与');

  const teeth = honestMoveFromAuth(f);
  eq(teeth.allowed, false, '★★ 牙:从**权威刚体**出发的诚实包被判违规(重锚缺位就必须红)');
  eq(teeth.violation?.kind, ViolationKind.TELEPORT, '★★ 违规类型 = TELEPORT');
  eq(teeth.worldRejected, undefined, '负对照:这是**反作弊侧**拒绝,不是世界侧');
  /* 对照(FND178-1 同一形状走了房间 ⇒ 绿):差别**只**在有没有经过重锚。 */
  ok((teeth.violation?.detail ?? '').includes('单帧位移'), `理由可读:${teeth.violation?.detail}`);
});

/* ═════ 4. 牙:世界在同一次调用里改了刚体 ⇒ 必须取**调用之后**的权威 ═════ */

test('FND178-4 ★★ 牙:世界「先搬刚体、再报拒收」⇒ corrected / 投影 / 水位都必须是调用之后的权威值', () => {
  const f = freshRoom('stale');
  const { rt, sim } = f;

  eq(honestMoveFromAuth(f).allowed, true, '前置:一包诚实移动(水位 = 权威)');
  const before = authOf(f);

  /* ── 注入:世界源在**同一次 `applyPlayerMove` 调用里**先把刚体搬走(+0.9 格,
     模拟击退搬家 / 撞墙滑行 / 落地沉降),然后才报「这次搬家被拒」。 ──
     (真 `WorldSim` 的拒收路径此刻不动刚体 ⇒ 这条不对称只能用注入来钉;
       修前 `room.ts` 用的是调用**之前**读到的 `authBefore`,于是 `state.players`
       与 `corrected` 两处都写**陈旧值**。) */
  const realApply = sim.applyPlayerMove.bind(sim);
  let injected = false;
  sim.applyPlayerMove = ((playerId: string, x: number, y: number, z?: number): boolean => {
    if (!injected) {
      injected = true;
      realApply(playerId, x + 0.9, y, z);   /* 权威先被改了 */
      return false;                          /* 再报拒收 */
    }
    return realApply(playerId, x, y, z);
  }) as typeof sim.applyPlayerMove;

  const rejected = honestMoveFromProj(f);
  const after = authOf(f);
  eq(injected, true, '前置:注入的世界源真的被调到了');
  ok(Math.abs(after.x - before.x) > 0.5,
    `前置:刚体在世界那次调用里被搬走了(authAfter.x ${after.x.toFixed(3)} vs authBefore.x ${before.x.toFixed(3)})`);
  eq(rejected.allowed, false, '世界拒收 ⇒ 如实拒绝(WS-FND-135 的既有契约不变)');
  eq(rejected.worldRejected, true, '★ 拒绝来源标记为世界侧');
  eq(rejected.corrected?.x, after.x, '★★ corrected 必须是**调用之后**的权威(修前 = authBefore 陈旧值)');
  eq(rejected.corrected?.y, after.y, '★ corrected.y 同理');
  eq(rt.playerState('p1')!.x, after.x, '★★ state 投影同理(修前把投影写回陈旧坐标)');
  eq(wmOf(f).x, after.x, '★★ 水位锚到调用之后的权威(修前停在移动之前的水位)');
  eq(rt.worldMoveRejects, 1, '★ 世界拒收计数 = 1(原有读数不变)');
  eq(rt.lastMoveWorldReject, true, '★ 回滚真的发生了(原有读数不变)');

  const next = honestMoveFromAuth(f);
  eq(next.allowed, true, '★★ 下一包从权威出发的诚实移动放行(陈旧值会让它变成瞬移)');
  eq(rt.ac.violations().length, 0, '★ 零违规');
});

/* ═════ 5. 牙:重锚没有把瞬移检查关掉(不误伤真作弊) ═════ */

test('FND178-5 ★★ 不误伤真作弊:从**当前权威刚体**出发的超界包仍 TELEPORT,刚好合界的包仍放行', () => {
  const f = freshRoom('cheat');
  const { rt } = f;

  eq(honestMoveFromAuth(f).allowed, true, '前置:一包诚实移动(水位 = 权威)');
  /* 量纲锚:单帧上界仍是 0.225(重锚只挪参考点,常量一字未动)。 */
  eq(maxDisplacementPerTick(1), 0.225, '锚:单帧上界 = maxDisplacementPerTick(1) = 4.5 × DT × 1.6');

  /* (a) 位移**远超**上界:一条瞬移(3 格)必须红。 */
  const a = authOf(f);
  const jump = rt.applyMove('p1', { tick: bumpTick(rt), x: a.x + 3, y: a.y, z: 0 });
  eq(jump.allowed, false, '★★ 从权威刚体出发的 3 格瞬移仍被判违规(重锚没有把检查关掉)');
  eq(jump.violation?.kind, ViolationKind.TELEPORT, '★ 类型 = TELEPORT');
  eq(jump.worldRejected, undefined, '负对照:反作弊侧拒绝(与「世界拒收」可区分)');
  eq(rt.ac.violations().length, 1, '★ 违规入流水(流水是判定的事实,重锚不撤销它)');

  /* (b) 上界**没有**被放宽:刚好合界的包放行,刚超一点点就红。 */
  eq(honestMoveFromAuth(f).allowed, true, '负对照:合界的包仍放行(水位随上一次的权威值)');
  const edge = maxDisplacementPerTick(1);
  const over = rt.applyMove('p1', { tick: bumpTick(rt), x: authOf(f).x + edge + 0.01, y: authOf(f).y, z: 0 });
  eq(over.allowed, false, '★★ 超出上界 0.01 格 ⇒ 仍被判违规(判据没有被放水)');
  eq(over.violation?.kind, ViolationKind.TELEPORT, '★ 类型 = TELEPORT');
  eq(rt.ac.violations().length, 2, '★ 第二条也进了流水');
});

/* ═════ 6. `syncWatermark` 自己的契约(fail-closed) ═════ */

test('FND178-6 ★ syncWatermark 契约:未登记 ⇒ 空操作不新建;非有限值 ⇒ 整次不生效;其余字段一律不动', () => {
  const f = freshRoom('contract');
  const { rt } = f;
  const s = rt.ac.get('p1');
  ok(s !== undefined, '前置:有 AC 状态');
  const st = s!;

  /* ── 未登记:不抛、不新建 ── */
  eq(rt.ac.get('ghost'), undefined, '前置:没有 ghost 这个玩家');
  rt.ac.syncWatermark('ghost', 1, 2, 3);
  eq(rt.ac.get('ghost'), undefined, '★★ 未登记 ⇒ 不新建状态(空操作,不抛)');

  /* ── 非有限值:整次调用不生效(宁可保持旧水位,也不写进 NaN / Infinity) ── */
  const keep = wmOf(f);
  const windowLen = st.window.length;
  const moveTick = st.lastMoveTick;
  const clockTick = st.lastTick;
  const score = st.score;
  const viol = rt.ac.violations().length;
  for (const bad of [
    [Number.NaN, 2, 3], [1, Number.POSITIVE_INFINITY, 3], [1, 2, Number.NaN],
    [1, 2, Number.NEGATIVE_INFINITY], [Number.NaN, Number.NaN, Number.NaN],
  ] as const) {
    rt.ac.syncWatermark('p1', bad[0], bad[1], bad[2]);
    eq(wmEqAuth(f) && wmOf(f).x === keep.x && wmOf(f).y === keep.y && wmOf(f).z === keep.z, true,
      `★★ 非有限值(${bad.join(',')})⇒ 整次不生效,水位一字不动`);
  }

  /* ── 合法值:只写三个坐标,别的字段一律不动 ── */
  rt.ac.syncWatermark('p1', 5.25, 6.5, 7.75);
  eq([wmOf(f).x, wmOf(f).y, wmOf(f).z], [5.25, 6.5, 7.75], '★ 三个坐标写进去了');
  eq(st.window.length, windowLen, '★★ 窗口**不动**(窗口是观测;动它才是放水)');
  eq(st.lastMoveTick, moveTick, '★★ 申报水位不动(额度闸门;回退它等于重复兑现)');
  eq(st.lastTick, clockTick, '★★ 服务端时钟水位不动');
  eq(st.score, score, '★★ 分数不动(重锚是位置事实,不是「撤销一次违规」)');
  eq(rt.ac.violations().length, viol, '★★ 违规流水不动');
  eq(rt.ac.droppedViolations >= 0, true, '★ 丢弃计数可读(soak 台账新读口的口径)');
});

report('WS-FND-178');
