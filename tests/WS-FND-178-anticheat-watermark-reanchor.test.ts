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
 * 三处修点(见 `server/src/net/anticheat.ts#syncWatermark` 与 `room.ts#applyMove`):
 * ```
 * A. AntiCheatRoom.syncWatermark(id,x,y,z) —— 只写水位三个坐标、三个都必须有限
 *    (fail-closed),不碰 window / lastTick / lastMoveTick / 流水 / 分数
 * B. room.applyMove 的**两条出路径**都锚到「调用之后」的权威刚体:
 *    · 世界拒收路径:重读 hostPositionOf ⇒ 写 p / corrected / 水位(修前用 authBefore,
 *      而世界在同一次调用里可能已经把刚体改了 ⇒ 两处都写**陈旧值**)
 *    · 正常放行路径:无条件先读一次权威,投影与水位取**同一次读数**
 * C. (**第二修点**,60 分钟 soak 追加)room.applyMove **入口**、`snapshotMove` 之前:
 *    ```
 *    const bodyNow = this.hostPositionOf(userId);
 *    if (bodyNow !== null && typeof bodyNow.z === 'number' && Number.isFinite(bodyNow.z)) {
 *      this.ac.syncWatermark(userId, bodyNow.x, bodyNow.y, bodyNow.z);
 *    }
 *    ```
 * ```
 *
 * ## C 为什么必须存在(它守的是哪条路径)
 *
 * A/B 只覆盖「包进了房间」的两种去向。而**权威刚体在 `applyMove` 之外也会动**
 * (物理沉降 / 击退 / `syncPlayers` 把刚体投影回 `state.players`)⇒ 水位只跟着
 * 「被接受 / 被世界拒收」走,客户端却按**投影**起算下一包 ⇒
 * `dist = 漂移 + 步长 > 0.225` ⇒ TELEPORT ⇒ 走**反作弊拒绝的早退分支**(它**不**重锚)
 * ⇒ 漂移只增不减。实测(修 C 之前,60 分钟 soak):`gapBefore = |投影 − 水位|`
 * 从 0.3 涨到 **2.66**、`acDroppedViolations` ≈ **38/s**(环被灌满)、
 * `acViolations` 饱和 **512**,**全部** TELEPORT。
 * C 把判据的参考点从「上一次**申报**坐标」钉到「**此刻的权威刚体**」⇒
 * `dist` 变成「申报的位置离它**真实所在**有多远」(这正是瞬移判据该有的语义)。
 * 这是**加强**不是放松:上界 0.225 / 窗口 / Z 值域**一字未动**(FND178-5 钉着这一条)。
 * 实测(2.5 分钟 / 8 客户端):`acViolations` **512 → 13**、
 * `acDroppedViolations` **69 → 0**、`gapBefore` 峰值 **2.66 → 0.593**。
 *
 * ## 判据(本套件怎么做到「修了就红」)
 *
 * 1 读数一律取**权威口径**:`sim.playerPosition()`(= `hostPositionOf` 的同一读口)
 *   与 `rt.ac.get(id)` 的水位三个坐标,**不**读实现内部的新字段;
 * 2 每条正判据都从**真实世界**造形状(真击退 `applyKnockback` + 真慢帧,
 *   真跳跃 `tryPlayerJump` + 真 z 裁决),不靠墙钟、不 sleep、不睡长跑:
 *   全部发生在 < 3 秒的定帧推进里(判据里的每一帧都是显式 `stepRoom` / `tick`);
 * 3 房间走**真帧**(`stepRoom` = `rt.step()`):投影每帧从权威刷新 —— 那才是客户端
 *   在 `state.players`(网络快照)里能拿到的东西。只 `sim.advance()` 不推房间会让
 *   投影停在旧读数上,造出「客户端拿着几十毫秒前的坐标去申报」的形状;那是**夹具
 *   失真**,会把 FND178-1 这条正例变成假负例(实测:不推房间的失真版里那两包
 *   **全**被反作弊拒掉,世界拒收路径 **0/2** ⇒ 前置直接红);
 * 4 **负对照**(四条,分别驳四种「假绿」):
 *    · FND178-3:水位陈旧 + **只过 `ac.move`**(房间三条路径一条都不走)
 *      ⇒ 从权威刚体出发的诚实包**必须**被判 TELEPORT(否则本条门禁是恒绿的);
 *      同一条申报坐标改走 `applyMove`(C 在位)⇒ 必须放行 —— 两腿只差「有没有重锚」;
 *    · FND178-4:注入一个「**同一次调用里先搬刚体、再报拒收**」的世界源
 *      ⇒ `corrected` / 投影 / 水位都必须是**调用之后**的权威值(修前是陈旧值);
 *    · FND178-5:从**当前权威刚体**出发、位移超出单帧上界的包仍必须 TELEPORT
 *      (证明重锚没有把瞬移检查关掉;刚好合界的包仍放行 ⇒ 上界没被放宽);
 *    · FND178-7:**C 自己的牙** —— 刚体在 `applyMove` 之外被搬走(不经房间帧)
 *      ⇒ 水位**确实**陈旧,而接下来一包诚实移动必须放行、`水位 == 权威刚体`;
 * 5 FND178-6 单独钉 `syncWatermark` 自己的契约(未登记 ⇒ 空操作;非有限值 ⇒ 整次
 *    不生效;窗口 / 两个时钟水位 / 流水 / 分数一律不动)。
 *
 * ## 「有牙怎么验」(本轮实测,不是推测)
 *
 * 把 `room.ts` 入口 C 那三行**注释掉**再跑本套件 ⇒ `7/7` 变 **`4/7`**,红的正是:
 * `FND178-1`(击退期 17 条 TELEPORT)、`FND178-7`(诚实包判 TELEPORT)、
 * `FND178-3` 的对照腿;恢复那三行 ⇒ 回到 `7/7`。
 *
 * ## 残余(如实登记,2.5 分钟 / 8 客户端 / 5Hz 假客户端)
 *
 * C 之后仍会剩 **9~22 条** `acViolations`(≈0.06~0.15/s,`acDroppedViolations = 0`,
 * 全部 TELEPORT,`detail` 一律 `单帧位移 0.22x 格 > 上界 0.225`)。逐包读数(探针
 * `_gap3.ts`)显示:`projGap = |投影 − 刚体| = 0`(**应用那一刻**投影与刚体同源),
 * 差的全在 `readGap`(客户端**读**投影那一刻 vs 应用时刻刚体)= 0.014~0.300 格 ——
 * 也就是「客户端读位置 → 服务端应用这一包」之间那**一个服务端帧**里世界把刚体
 * 推/击退的距离(八个假客户端在角落堆叠,`resolvePairs` 每帧推一点;被怪击退时
 * 一帧就是 0.088~0.300 格)。**不是**判据错:那一包离权威刚体的距离**确实**超过
 * 一帧额度。⇒ 判据/上界一律不动,残余按「夹具 vs 产品」分类登记:
 * 见 `scripts/soak.ts#WALK_STEP` 的 docblock 与 `server/src/net/room.ts#applyMove`
 * 的「残余的**归因**」一段(夹具那一类修完:实测 **22 → 0**)。
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

/**
 * 推**一个真房间帧**:`meta.tick += 1` → `ac.tick` → `host.advance(1)` → **投影刷新**。
 *
 * ⚠️ 为什么必须走它、而不是直接 `sim.advance(FAST_PER_SLOW)`:
 * `state.players[]` 的 x/y/z 是**只读投影**(契约 §2.3),只有房间帧里的
 * `projectAllPlayers()` 把它从权威刚体刷一遍。只推世界不推房间 ⇒ 投影停在旧读数上,
 * 而**客户端唯一能看到的就是投影**(网络下发的就是它,见 `ws_server` 的快照广播)
 * ⇒ 造出来的形状是「客户端拿着几十毫秒前的坐标去申报」——那是**夹具失真**,
 * 不是产品行为:它会把「世界自己搬了刚体」误读成「客户端申报了远方坐标」,
 * 于是把 FND178-1 那条**正例**变成假的负例。
 * 按真帧驱动之后,投影与权威在每个帧边界上同源 —— 这才是客户端真能拿到的东西。
 */
function stepRoom(f: RoomFixture): void {
  f.rt.step();
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
  let frames = 0;
  /* 循环条件读**世界**的窗口状态(不写死步数:击退走几步由世界自己决定,
     写死 2 会在世界改步数时变成空断言)。上限 40 只是防空转:
     击退把一个慢帧切成两段推,而**房间帧 = 一个快帧**(`FAST_PER_SLOW` 个快帧 = 一个慢帧)。 */
  while (sim.knockbackOf('p1') && frames < 40) {
    stepRoom(f);                           /* 1 个真房间帧:世界推进 + 投影刷新 */
    frames += 1;
    const r = honestMoveFromProj(f);       /* soak 的假客户端:从**投影**起算 */
    seen.push({ allowed: r.allowed, worldRejected: r.worldRejected, kind: r.violation?.kind });
    if (!wmEqAuth(f)) wmDrift += 1;
  }
  ok(frames >= 1, '前置:击退至少推进了一个房间帧');
  ok(frames > 1, `前置:这个形状覆盖了**多个**包(${frames} 个房间帧),不是单点`);
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
  stepRoom(f);
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

test('FND178-3 ★★ 牙(负对照):水位陈旧 + **只过 `ac.move`**(入口重锚缺位)⇒ 从权威刚体出发的诚实包被判 TELEPORT', () => {
  const f = freshRoom('bypass');
  const { rt, sim } = f;

  eq(honestMoveFromAuth(f).allowed, true, '前置:一包诚实移动(水位 = 权威 = 起点 + δ)');
  const anchor = authOf(f);
  const w0 = wmOf(f);
  eq(w0.x, anchor.x, '前置:水位与权威同源');

  /* ── 同一个形状:世界自己把刚体搬走(击退两步走完、窗口关掉) ──
     ⚠️ 关键在「**不经** `applyMove`」:没有房间帧、没有世界调用、没有包进房间 ⇒
     第二修点(入口重锚)那三行**一次都不会执行**,水位就停在 `w0`(陈旧)。
     这正是本修点要堵的形态的**最小构造**:权威刚体被搬出单帧上界之外,
     而判据的参考点还钉在上一次**申报**坐标上。 */
  eq(sim.applyKnockback('p1', -5, -5, KNOCK_CELLS), true, '前置:击退施加');
  sim.advance(FAST_PER_SLOW * 2);
  eq(sim.knockbackOf('p1'), false, '前置:窗口已关');
  const moved = authOf(f);
  const drift = Math.hypot(moved.x - anchor.x, moved.y - anchor.y);
  ok(drift > maxDisplacementPerTick(1),
    `前置:权威刚体被搬到 ${drift.toFixed(3)} 格外(> 单帧上界 ${maxDisplacementPerTick(1)})`);
  const stale = Math.hypot(wmOf(f).x - moved.x, wmOf(f).y - moved.y);
  ok(stale > maxDisplacementPerTick(1),
    `前置:水位**确实**陈旧(${stale.toFixed(3)} 格之外)—— 这就是「重锚缺位」本身`);
  eq(rt.worldMoveRejects, 0, '负对照:世界侧拒收计数为 0 —— 这条路径上房间根本没参与');

  /* ── 绕过重锚:客户端只过反作弊闸,房间的三条重锚路径**一条都不经过** ──
     (修前的水位形态正是这样:世界自己挪的那一段**永远**不会写回水位) */
  const a = authOf(f);
  const teeth = rt.ac.move({
    playerId: 'p1', tick: bumpTick(rt), x: a.x + LEGAL_STEP, y: a.y, z: 0,
  });
  eq(teeth.allowed, false, '★★ 牙:从**权威刚体**出发的诚实包被判违规(重锚缺位就必须红)');
  eq(teeth.violation?.kind, ViolationKind.TELEPORT, '★★ 违规类型 = TELEPORT');
  eq(teeth.worldRejected, undefined, '负对照:这是**反作弊侧**拒绝,不是世界侧');
  /* 对照(FND178-1 同一形状走了房间 ⇒ 绿):差别**只**在有没有经过重锚。 */
  ok((teeth.violation?.detail ?? '').includes('单帧位移'), `理由可读:${teeth.violation?.detail}`);

  /* ── 对照腿:**同一个申报坐标**改走 `applyMove`(入口重锚在位)⇒ 必须放行 ──
     两腿的唯一差别 = 有没有经过重锚(判据、上界、水位推进全同)。 */
  const same = rt.applyMove('p1', { tick: bumpTick(rt), x: a.x + LEGAL_STEP, y: a.y, z: 0 });
  eq(same.allowed, true, '★★ 对照:同一包走 `applyMove`(入口重锚在位)⇒ 放行');
  eq(rt.ac.violations().length, 1, '★ 流水里只有牙那一条(对照腿没有新增)');
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

/* ═════ 7. ★ 第二修点:刚体在 `applyMove` **之外**被搬走 ⇒ 入口重锚 ═════ */

test('FND178-7 ★★ 入口重锚:刚体在 `applyMove` 之外被世界搬走 ⇒ 下一包诚实移动不判 TELEPORT,且水位 == 权威刚体', () => {
  const f = freshRoom('entry-anchor');
  const { rt, sim } = f;

  eq(honestMoveFromAuth(f).allowed, true, '前置:一包诚实移动(水位 = 权威)');
  const before = authOf(f);
  eq(wmEqAuth(f), true, '前置:水位 == 权威刚体');

  /* ── 造形状:刚体在 `applyMove` **之外**被搬走 ──
     真击退 + 真慢帧,而**房间一帧都不跑**(`stepRoom` 一次都不调)⇒
     `state.players` 投影与 AC 水位**双双**停在旧读数上,正是 soak 里
     `gapBefore = |投影 − 水位|` 一路涨到 2.66 的那个形态的静止版。
     判据(上界 0.225)在这里不动:**这一包离刚体的距离是客观事实**。 */
  eq(sim.applyKnockback('p1', -5, -5, KNOCK_CELLS), true, '前置:击退施加(世界自己搬,不经房间)');
  sim.advance(FAST_PER_SLOW * 2);
  eq(sim.knockbackOf('p1'), false, '前置:搬家窗口已关(这一包会真的到达世界)');
  const moved = authOf(f);
  const drift = Math.hypot(moved.x - before.x, moved.y - before.y);
  ok(drift > maxDisplacementPerTick(1),
    `前置:刚体被搬到单帧上界之外(${drift.toFixed(3)} > ${maxDisplacementPerTick(1)})`);
  eq(wmEqAuth(f), false, '前置:水位**确实**陈旧(没有 `applyMove` ⇒ 两条出路径都没跑过)');

  /* ── 诚实包(客户端按**权威刚体**重新起算)⇒ 入口重锚先把它钉到权威再判 ── */
  const next = honestMoveFromAuth(f);
  eq(next.allowed, true, '★★ 诚实包不判 TELEPORT(入口重锚把参考点钉到此刻的权威刚体)');
  eq(next.violation, undefined, '★ 这一包没有任何违规记录');
  eq(next.worldRejected, undefined, '★ 世界侧也接受了(不是靠世界拒收绕过判据)');
  eq(rt.ac.violations().length, 0, '★★ 零违规');
  eq(wmEqAuth(f), true, '★★ 水位 == 权威刚体(入口重锚 + 出路径重锚,三处同一读数)');
  const body = authOf(f);
  eq(rt.ac.get('p1')!.lastX, body.x, '★ 水位 x 与权威精确同源(不是浮点近似)');
  eq(rt.ac.get('p1')!.lastY, body.y, '★ 水位 y 同理');
  eq(rt.playerState('p1')!.x, body.x, '★ 投影与权威同源(客户端看到的正是刚体)');
  eq(rt.worldMoveRejects, 0, '★ 这一包没有被世界拒收(只走「正常放行」那条路径)');

  /* ── 反证:入口重锚那三行被注释掉时,同一条判据必须红 ──
     (本轮实测:注释掉 `room.ts` 入口那三行 ⇒ 本用例在
      「★★ 诚实包不判 TELEPORT」与 「★★ 零违规」两条上失败,
      `detail` = 单帧位移 ≈ 位移量 > 上界 0.225 —— 见套件头部「有牙怎么验」。) */
});

report('WS-FND-178');
