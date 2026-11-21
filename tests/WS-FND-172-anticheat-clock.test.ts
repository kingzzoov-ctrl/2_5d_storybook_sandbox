/**
 * WS-FND-172 —— 反作弊**速度窗口的时钟轴**(P1)。
 *
 * ## 修点(3 行)
 *
 * `server/src/net/anticheat.ts` §6.2(窗口式移速)的**时间轴**从自报 `claimedTick`
 * 改为**服务端时钟** `s.lastTick`:
 * ```
 * s.window.push({ tick: s.lastTick, ... });              // 原: claimedTick
 * const cutoff = s.lastTick - limits.speedWindowTicks;   // 原: claimedTick - …
 * const spanTicks = s.lastTick - first.tick;             // 原: claimedTick - …
 * ```
 * 额度(`dtTicks`)与跳变判据**一字未动**。
 *
 * ## 病理(为什么必须换轴)
 *
 * 额度按**帧**发(`dtTicks × maxDisplacementPerTick`),而窗口的秒表此前走
 * `claimedTick` —— 它被 `lastMoveTick + MAX` 夹住,推进速率 = `min(报文率 f_c, 帧率 f_s)`,
 * 于是「**报文条数**」被当成了「时间」,而分母 `spanTicks × DT` 又按标称
 * `DT = 50ms / tick` 记账 ⇒ 合法速度被读成
 * ```
 * S_obs = S × 20 / min(f_c, f_s)
 * ```
 * 实测(fixedClock 驱动的 4.5 格/秒合法玩家、packet 15.93Hz):
 * ```
 * 旧轴 : 触发 1 次 SPEED(窗口均速 5.65 > 上限 5.625)   ← 误伤
 * 新轴 : 0 次                                          ← 本修点
 * ```
 * 同一条口径还堵住了「抬高自报 `tick` ⇒ 窗口秒表被推走」这条旁路。
 *
 * ## ⚠️ 本节登记的两处耦合(★ 本轮各有收口)
 *
 * 1. **服务端真实帧率低于标称**(★ 现已可修):分母原先写死标称 `DT`
 *    ⇒ 15.93Hz(62.8ms/帧)下窗口跨的 20 帧是 **1.256 秒**真实时间、分母只记 1.0 秒
 *    ⇒ 满速裸装合法玩家 4.5 被读成 **5.65 > 5.625**(= 4.5 × 20/15.93)。
 *    修法**不是**放大容差(那会在真作弊者身上同步放水,并会红掉以 5.63 为锚的
 *    WS-07 `M49` / WS-10),而是给**分母**注入**实测帧间隔**:
 *    `DEFAULT_FRAME_DT_SECONDS` · `AntiCheatRoom.setFrameIntervalMs(ms)` ·
 *    `tick(t, frameMs)`(房间侧有 `this.clock.nowMs()` 可读实测节拍)。
 *    **不注入 ⇒ 缺省 `DT`** ⇒ `FND172-3` 登记的那次误判照旧成立(未接线的房);
 *    注入实测值后:`FND172-11` 钉「满速 4.5 不再误判」、`FND172-12` 钉「判据未放水」。
 * 2. **同帧突发的窗口失明**(★ 本轮已修,**只动这一支**):同一帧内连发的报文全落进
 *    同一个 `lastTick` ⇒ `spanTicks = 0` ⇒ 窗口检查看不到时间流逝;而额度 = `T + 1`
 *    ⇒ 静默 T 帧后突发 `T + 1` 包**一条都不被拒**(修前实测 ≈ **17.56 格/秒、0 违规、0 踢**;
 *    旧轴同一输入仅 0.76 格/秒且被判 SPEED 踢出)。修法 = `anticheat.ts` §6.2b 零跨度分支:
 *    按**最小可判跨度 1 帧**结算同帧累计路径,并用**不同**的量区分两种形状 ——
 *    · 静默后突发(申报水位落后整窗口)必须违规:`FND172-10` / `FND172-4`;
 *    · 同帧合法连发(水位新鲜 / 零位移)不违规:`FND172-13`。
 *
 * ⇒ 第 2 条不再需要靠「入站报文限速」兜;`checkMove` 的额度与跳变判据**仍未动**。
 *
 * 运行:`node tests/WS-FND-172-anticheat-clock.test.ts`
 */
import { eq, near, ok, report, test, mulberry32 } from '../shared/testing/harness.ts';
import { BASE_MOVE_SPEED, DT } from '../shared/types/physics.ts';
import {
  AntiCheatRoom,
  MAX_MOVE_CATCHUP_TICKS,
  MAX_SPEED_BONUS_MUL,
  SPEED_WINDOW_TICKS,
  SPEED_WINDOW_TOLERANCE,
  VIOLATION_SCORE_KICK,
  ViolationKind,
  fixedClock,
  maxDisplacementPerTick,
  type FixedClock,
} from '../server/src/net/anticheat.ts';
/* ★ 端到端判据(FND172-14/15 走生产路径:`assemble()` → `RoomRuntime.step()`)。 */
import { AC_FRAME_GAP_MAX_MS } from '../server/src/net/room.ts';
import { assemble } from '../server/src/index.ts';

/** 窗口上限(格/秒)。 */
const capOf = (mul: number): number => BASE_MOVE_SPEED * mul * SPEED_WINDOW_TOLERANCE;
/** 单帧额度(格/帧)= maxDisplacementPerTick。 */
const quotaOf = (mul: number): number => maxDisplacementPerTick(mul);
/** 满加成合法玩家的单帧位移。 */
const LEGIT_STEP = BASE_MOVE_SPEED * DT;                       // mul=1: 0.225
const QUOTA_MAX = quotaOf(MAX_SPEED_BONUS_MUL);                // 0.918

/** 收集 SPEED 违规的实测均速(解析 detail,便于断言「5.65 还是 4.5」)。 */
function speedObserved(ac: AntiCheatRoom): number[] {
  return ac.violations()
    .filter((v) => v.kind === ViolationKind.SPEED)
    .map((v) => Number(/窗口均速 ([\d.]+)/.exec(v.detail)?.[1] ?? 'NaN'));
}

function kindsOf(ac: AntiCheatRoom): Set<ViolationKind> {
  return new Set(ac.violations().map((v) => v.kind));
}

/* ═══════════ 1. 轴已换:窗口时间戳 = 服务端帧号 ═══════════ */

test('FND172-1 窗口的时间戳 = 服务端帧号(`s.lastTick`),不是报文条数', () => {
  const ac = new AntiCheatRoom();
  ac.join('p', 0, 0, 0, 0);
  let x = 0;
  for (let f = 1; f <= 3 * SPEED_WINDOW_TICKS; f += 1) {
    ac.tick(f);                                    // 服务端一帧
    x += LEGIT_STEP;                               // 合法:每帧 0.225 格 = 4.5 格/秒
    const v = ac.move({ playerId: 'p', tick: f, x, y: 0, z: 0, speedMul: 1 });
    eq(v.allowed, true, `第 ${f} 帧的合法移动必须放行`);
  }
  const s = ac.get('p');
  ok(s !== undefined, '状态应存在');
  if (s === undefined) return;
  /* 窗口里**最新**一条的时间戳 = 当时的服务端帧号(轴换了才会如此;报文条数轴下
     它会是「第几条报文」)。 */
  eq(s.window[s.window.length - 1]?.tick, 3 * SPEED_WINDOW_TICKS,
    '窗口末条 tick 必须等于当时的 `s.lastTick`');
  /* 窗口**最早**一条 = `lastTick - SPEED_WINDOW_TICKS` ⇒ spanTicks 恰好 20(= 名义 1 秒) */
  eq(s.lastTick - s.window[0].tick, 20,
    'spanTicks 由**帧号差**给出,应恰为 20 帧(= SPEED_WINDOW_TICKS,期望侧写字面量:常量在 actual 侧同源会是同义反复)');
  eq(speedObserved(ac).length, 0, `满速合法玩家不得产生 SPEED,实际 ${JSON.stringify(speedObserved(ac))}`);
});

/* ═══════════ 2. 【关键】报文集低于标称 ⇒ 满速合法玩家不越线 ═══════════ */

test('FND172-2 【关键】报文率 15.93Hz < 标称 20Hz:满速合法玩家不越线', () => {
  const PACKET_HZ = 15.93;
  const REAL_DT = 1 / PACKET_HZ;                        // 62.8ms
  const stepPerPacket = BASE_MOVE_SPEED * REAL_DT;      // 0.2825 格 ⇒ 真实 4.5 格/秒
  const ac = new AntiCheatRoom();
  ac.join('p', 0, 0, 0, 0);
  const clock: FixedClock = fixedClock(0);              // 假时钟驱动两条节拍
  let srvTick = 0;
  let x = 0;
  for (let i = 0; i < 200; i += 1) {
    /* 服务端按标称 20Hz 走:每 50ms 推一帧 */
    while (clock.nowMs() + 1e-9 >= (srvTick + 1) * DT * 1000) {
      srvTick += 1;
      ac.tick(srvTick);
    }
    x += stepPerPacket;
    const v = ac.move({ playerId: 'p', tick: srvTick + 1, x, y: 0, z: 0, speedMul: 1 });
    eq(v.allowed, true, `第 ${i} 包(报文率 ${PACKET_HZ}Hz、真实 4.5 格/秒)必须放行`);
    clock.advance(REAL_DT * 1000);
  }
  eq(speedObserved(ac).length, 0,
    `★ 报文率低于标称时满速合法玩家不得被判 SPEED,实际 ${JSON.stringify(speedObserved(ac))}`);
  eq(ac.get('p')?.kicked, false, '更不得因此累计到踢出');

  /* 负对照:旧口径(时间轴 = 报文条数)在**同一条轨迹**上必然越线 ——
     窗口保留 20 **条报文**(spanTicks = 20),分母却按 1 tick = 50ms 记:
       observed = (20 × 0.2825) / (20 × 0.05) = 5.65 > 上限 5.625 */
  const oldAxisObserved = (stepPerPacket * SPEED_WINDOW_TICKS) / (SPEED_WINDOW_TICKS * DT);
  ok(oldAxisObserved > capOf(1),
    `负对照:旧口径 observed=${oldAxisObserved.toFixed(3)} 应 > 上限 ${capOf(1)}`);
  near(oldAxisObserved, 5.65, 0.01,
    '旧口径 observed 应 ≈ 5.65(= W2 算式 S × 20/min(f_c,f_s),与实测旧代码一致)');
});

/* ═══════════ 3. 登记:服务端真帧率低于标称时的那处耦合 ═══════════ */

test('FND172-3 【登记·未修】服务端真实帧率 15.93Hz ⇒ 满速合法玩家仍被误判 SPEED', () => {
  /* ⚠️ 这条**不是**「修好了」,而是把本修点**没覆盖**的那处耦合钉住:
     窗口分母仍是 `spanTicks × DT`,`DT = 50ms` 是**标称**帧间隔。
     服务端真跑到 15.93Hz 时,窗口跨的 20 帧 = 1.256 秒真实时间,分母却记 1.0 秒
     ⇒ 合法速度被放大 20/15.93 = 1.256 倍。 */
  const SRV_HZ = 15.93;
  const REAL_DT = 1 / SRV_HZ;
  const stepPerFrame = BASE_MOVE_SPEED * REAL_DT;       // 0.2825 格/帧 ⇒ 真实 4.5 格/秒
  const ac = new AntiCheatRoom();
  ac.join('p', 0, 0, 0, 0);
  /* 先走一格:避免**首包与 join 同 tick** 给窗口多塞一条零位移段(那会把观测值
     从 5.65 抬到 5.93,混进与本条无关的伪影)。 */
  const clock: FixedClock = fixedClock(REAL_DT * 1000);
  let srvTick = 0;
  let x = 0;
  for (let i = 0; i < 200; i += 1) {
    while (clock.nowMs() + 1e-9 >= (srvTick + 1) * REAL_DT * 1000) {
      srvTick += 1;
      ac.tick(srvTick);
    }
    x += stepPerFrame;
    ac.move({ playerId: 'p', tick: srvTick + 1, x, y: 0, z: 0, speedMul: 1 });
    clock.advance(REAL_DT * 1000);
  }
  const observed = speedObserved(ac);
  ok(observed.length > 0,
    '登记的前提必须成立:服务端帧率低于标称时,窗口**仍会**误判 4.5 格/秒的合法玩家');
  ok(observed[0] > capOf(1),
    `登记:实测均速 ${observed[0]} 应 > 上限 ${capOf(1)}(即满足 S × 20/f_s 的放大)`);
  /* 放大倍数应是**恰好** 20/15.93 = 1.2555(观测值 = 4.5 × 20/15.93 = 5.6497;
     ⚠️ `detail` 只带 2 位小数 ⇒ 容差取 0.005)。 */
  near(observed[0], BASE_MOVE_SPEED * (20 / SRV_HZ), 0.005,
    `观测均速应恰为 S × 20/f_s = ${(BASE_MOVE_SPEED * (20 / SRV_HZ)).toFixed(4)}`);
  near(observed[0] / BASE_MOVE_SPEED, 20 / SRV_HZ, 0.002,
    `放大倍数应恰为 20/15.93 = ${(20 / SRV_HZ).toFixed(4)}`);
  /* 对照:FND172-2 已证明**报文率**那一侧的放大被本修点消掉了 ⇒ 剩下的确是 f_s 这一项。 */
  ok((20 / SRV_HZ) > SPEED_WINDOW_TOLERANCE,
    `根因确认:放大 ${(20 / SRV_HZ).toFixed(3)} > 容差 ${SPEED_WINDOW_TOLERANCE} ⇒ 必越线`);
});

/* ═══════════ 4. 零跨度(`spanTicks = 0`):同帧连发不再失明 ═══════════ */

test('FND172-4 同帧连发 ⇒ `spanTicks = 0`:窗口的失明由**零跨度分支**补上', () => {
  /* ⚠️ 口径已变(★ 本轮):这条原先钉的是「同帧连发**不判** SPEED,越界改由 TELEPORT 拦」
     —— 那正是失明本身。现在 `spanTicks === 0` **不等于放行**:见 `FND172-10` 的判据。 */
  const IDLE = SPEED_WINDOW_TICKS + 2;                  // 22 帧积压 ⇒ 额度 23 帧
  const ac = new AntiCheatRoom();
  ac.join('p', 0, 0, 0, 0);
  for (let f = 1; f <= IDLE; f += 1) ac.tick(f);
  let x = 0;
  let allowed = 0;
  const rejects: ViolationKind[] = [];
  for (let i = 0; i < IDLE + 2; i += 1) {                // 24 包 > 额度 23
    const v = ac.move({
      playerId: 'p', tick: IDLE + 1 + i,
      x: x + QUOTA_MAX, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
    });
    if (v.allowed) { allowed += 1; x += QUOTA_MAX; } else rejects.push(v.violation?.kind as ViolationKind);
  }
  const s = ac.get('p');
  ok(s !== undefined, '状态应存在');
  if (s === undefined) return;
  /* 第 1 包走的是**正常窗口分支**(此刻 `spanTicks = 22`,跨度按 22 帧算 ⇒ 读数 0.83 合法)
     ⇒ 它放行是**对的**,不得因为「后面还有同帧包」而误伤。 */
  eq(allowed, 1, '★ 同帧连发只放行第 1 包,其余由零跨度分支按最小 1 帧结算');
  eq(rejects.length, IDLE + 1, `其余 ${IDLE + 1} 包必须全被拒,实际 ${rejects.length}`);
  eq(rejects.every((k) => k === ViolationKind.SPEED), true,
    `拒因应为 SPEED(同帧累计路径的均速越线)—— 不再是「改由 TELEPORT 拦」,实际 [${[...new Set(rejects)].join(',')}]`);
  /* 轴换了才会出现这个形状:同一服务端帧内的所有推送带**同一个 tick** */
  ok(s.window.every((e) => e.tick === s.lastTick),
    `窗口内所有条目的 tick 应等于 s.lastTick=${s.lastTick}(同帧连发)⇒ 实际 ${JSON.stringify([...new Set(s.window.map((e) => e.tick))])}`);
  eq(s.lastTick - s.window[0].tick, 0,
    '⇒ `spanTicks = 0`:窗口这层看不到时间流逝,故必须由零跨度分支结算');
  eq(s.lastTick - s.lastMoveTick, IDLE - MAX_MOVE_CATCHUP_TICKS,
    `⇒ 触发条件也满足:申报水位落后 ${IDLE - MAX_MOVE_CATCHUP_TICKS} 帧 ≥ 窗口长 ${SPEED_WINDOW_TICKS}`);
  /* 读数口径 = **最小可判跨度 1 帧**(同帧累计路径 / 0.05s) */
  const observed = speedObserved(ac);
  eq(observed.length, IDLE + 1, '每条被拒的越界包都应留下 SPEED 流水(不再静默放行)');
  ok(observed.every((o) => Math.abs(o - QUOTA_MAX / DT) < 0.005),
    `读数应恒为 ${QUOTA_MAX}/${DT} = ${(QUOTA_MAX / DT).toFixed(2)} 格/秒,实际 ${JSON.stringify([...new Set(observed)].slice(0, 3))}`);
  eq(ac.violations()[0]?.detail.includes('同帧突发'), true,
    'detail 必须写明这是**同帧突发**(跨度按最小 1 帧),便于事后归因');
  eq(s.kicked, true,
    `${IDLE + 1} 条 SPEED(${(IDLE + 1) * 3} 分)必越过踢出阈值 ${VIOLATION_SCORE_KICK}`);
});

/* ═══════════ 5. 抬高自报 tick 不再改变窗口时间轴 ═══════════ */

test('FND172-5 抬高自报 `tick` 不再改变窗口时间轴(逐位同判)', () => {
  const run = (offset: (f: number) => number): { ticks: number[]; verdicts: boolean[]; x: number } => {
    const ac = new AntiCheatRoom();
    ac.join('p', 0, 0, 0, 0);
    const verdicts: boolean[] = [];
    let x = 0;
    for (let f = 1; f <= 3 * SPEED_WINDOW_TICKS; f += 1) {
      ac.tick(f);
      x += LEGIT_STEP;
      const v = ac.move({ playerId: 'p', tick: offset(f), x, y: 0, z: 0, speedMul: 1 });
      verdicts.push(v.allowed);
    }
    return { ticks: (ac.get('p')?.window ?? []).map((e) => e.tick), verdicts, x };
  };
  const a = run((f) => f);
  const b = run((f) => f + 1e9);          // 声称 10 亿帧之后
  const c = run((f) => f + 1000);
  eq(b.ticks, a.ticks, '★ 抬高 tick 后窗口时间戳必须逐位相同(轴是服务端时钟,报什么 tick 都一样)');
  eq(c.ticks, a.ticks, '同上(偏移 1000)');
  eq(b.verdicts, a.verdicts, '抬高 tick 不得改变任何一条裁决');
  eq(c.verdicts, a.verdicts, '同上');
  /* 轴已换才会出现:窗口跨度恒 = 真帧数,与自报 tick 无关 */
  eq(a.ticks[a.ticks.length - 1] - a.ticks[0], a.ticks.length - 1,
    '窗口相邻条目的 tick 差恒为 1(每帧一条),即跨度只由服务端帧数决定');
});

/* ═══════════ 6/7. 真作弊仍被判 ═══════════ */

test('FND172-6 真作弊:单帧 2× 位移(mul=1)⇒ 仍判 TELEPORT', () => {
  const ac = new AntiCheatRoom();
  ac.join('cheat', 0, 0, 0, 0);
  ac.tick(1);
  /* 合法上限 = 4.5 × 1 × DT × 1.6 = 0.36;这里走 0.45 = 2× 合法…… */
  const v = ac.move({ playerId: 'cheat', tick: 1, x: 2 * BASE_MOVE_SPEED * DT, y: 0, z: 0, speedMul: 1 });
  eq(v.allowed, false, '2× 单帧位移必须被拒');
  eq(v.violation?.kind, ViolationKind.TELEPORT, '拒因应为 TELEPORT(单帧跳变)');
  eq(ac.get('cheat')?.lastX, 0, '被拒不得污染权威坐标');
  eq(ac.get('cheat')?.score, 4, 'TELEPORT 权重 4 应记分');
});

test('FND172-7 真作弊:持续 1.33× 均速(单帧在额度内)⇒ 窗口仍判 SPEED', () => {
  /* 每帧 0.30 格 = 6 格/秒:单帧额度 0.36 内(所以单帧检查放行),
     但 20 帧窗口均速 6.0 > 上限 5.625 ⇒ 必须在第 20 帧被窗口抓住。
     ⚠️ 这条**只在一帧一报**时成立 —— 同帧连发的结算见 FND172-10 / FND172-13。 */
  const ac = new AntiCheatRoom();
  ac.join('fast', 0, 0, 0, 0);
  const SPEED_STEP = 0.30;
  ok(SPEED_STEP < quotaOf(1), `前提:0.30 必须在单帧额度 ${quotaOf(1)} 内`);
  ok(SPEED_STEP / DT > capOf(1), `前提:6.0 格/秒必须超窗口上限 ${capOf(1)}`);
  let x = 0;
  for (let f = 1; f <= SPEED_WINDOW_TICKS; f += 1) {
    ac.tick(f);
    x += SPEED_STEP;
    ac.move({ playerId: 'fast', tick: f, x, y: 0, z: 0, speedMul: 1 });
  }
  const observed = speedObserved(ac);
  ok(observed.length > 0, `累计超速必须被判 SPEED,实际 ${JSON.stringify([...kindsOf(ac)])}`);
  near(observed[0], 6.0, 0.01, '实测窗口均速应为 6.00 格/秒');
  eq(ac.get('fast')?.kicked, false, '单次命中(3 分)< 阈值 12,尚未到踢出');
});

/* ═══════════ 8. 误伤面不扩大 ═══════════ */

test('FND172-8 对照:标称 20Hz 下满速合法玩家(mul=1 / mul=2.55)60 秒 0 违规', () => {
  for (const mul of [1, MAX_SPEED_BONUS_MUL]) {
    const ac = new AntiCheatRoom();
    ac.join('legit', 0, 0, 0, 0);
    const step = BASE_MOVE_SPEED * mul * DT;
    let x = 0;
    for (let f = 1; f <= 1200; f += 1) {           // 60 秒 @ 20Hz
      ac.tick(f);
      x += step;
      const v = ac.move({ playerId: 'legit', tick: f, x, y: 0, z: 0, speedMul: mul });
      eq(v.allowed, true, `mul=${mul} 第 ${f} 帧必须放行`);
    }
    const s = ac.get('legit');
    eq(ac.violations().length, 0, `mul=${mul}:60 秒合法移动不得留任何违规流水`);
    eq(s?.score, 0, `mul=${mul}:违规分应为 0`);
    eq(s?.kicked, false, `mul=${mul}:不得被踢出`);
    near(x, BASE_MOVE_SPEED * mul * 60, 1e-6, `mul=${mul}:60 秒总位移 = 速度 × 60`);
  }
});

/* ═══════════ 9. `kicked` 在生产侧无消费者(现状登记) ═══════════ */

test('FND172-9 【登记】`kicked` 在生产侧无消费者:置位后不阻断任何裁决', () => {
  /* `kickedPlayers()` 只被测试读(全仓 grep:`server/src/**` 里只有定义处)。
     ⇒ 越过阈值 = 「留下作弊证据」,**不是**「踢人」。这条机器判据钉的就是这件事:
     一旦房间层接上消费者(断开/拒绝),它必须被改写 —— 否则这里会静默漂移。 */
  const ac = new AntiCheatRoom();
  ac.join('bad', 0, 0, 0, 0);
  /* 3 条回退帧(TELEPORT,权重 4)= 12 分 = VIOLATION_SCORE_KICK */
  for (let i = 0; i < 3; i += 1) ac.move({ playerId: 'bad', tick: 0, x: (i + 1) * 0.5, y: 0, z: 0 });
  const s = ac.get('bad');
  ok(s !== undefined, '状态应存在');
  if (s === undefined) return;
  eq(s.kicked, true, `3 × TELEPORT = ${3 * 4} 分应达阈值 ${VIOLATION_SCORE_KICK}`);
  eq(ac.kickedPlayers(), ['bad'], 'kickedPlayers 应能查出该玩家(目前**只**有测试读它)');
  /* ★ 关键:置位之后,后续**合法**移动仍照常放行 ⇒ 踢出标记不参与裁决 */
  ac.tick(5);
  const after = ac.move({ playerId: 'bad', tick: 5, x: s.lastX + LEGIT_STEP, y: 0, z: 0, speedMul: 1 });
  eq(after.allowed, true,
    '★ `kicked === true` 之后合法移动仍被放行 ⇒ 该标记在生产侧**无消费者**(未接断开/拒绝)');
  eq(s.kicked, true, '标记本身保持置位(它只是证据,不是执行)');
});

/* ═══════════ 10. ★ 判据一:静默 ≥ 一整个窗口后的同帧突发 ⇒ 必须违规 ═══════════ */

test('FND172-10 【关键·本轮已修】静默 ≥ 20 帧后的同帧突发必须被抓(不再「0 违规获益」)', () => {
  /* ⚠️ 口径已翻(★ 本轮):这条此前是**登记**,记的是本改动带出的口子 ——
     「同帧连发的报文全落进同一个 `lastTick` ⇒ `spanTicks = 0` ⇒ 窗口失明;
     而额度 = `T + 1` ⇒ 静默 T 帧后突发 T+1 包**一条都不被拒**」。
     形状**逐字保留**(间隔 22 帧、每轮 22 包 × 0.918 格、跑 20 轮),只把断言换成新口径 ——
     它变红就是「有人修了」的信号,见 `anticheat.ts` §6.2b 零跨度分支。
     修前实测:**403.92 格 / 460 帧 ≈ 17.56 格/秒、0 违规、0 踢**;
     修后:每轮只有**第 1 包**放行(它走正常窗口分支),其余全判 SPEED。 */
  const IDLE = SPEED_WINDOW_TICKS + 2;               // 22(> 窗口长,使上一轮位置被 cutoff 剪掉)
  const ac = new AntiCheatRoom();
  ac.join('burst', 0, 0, 0, 0);
  let frames = 0;
  let totalX = 0;
  const startX0 = ac.get('burst')?.lastX ?? 0;
  for (let c = 0; c < 20; c += 1) {
    for (let i = 0; i < IDLE; i += 1) { frames += 1; ac.tick(frames); }   // 静默换积压
    const startX = ac.get('burst')?.lastX ?? startX0;
    let x = startX;
    for (let i = 0; i < IDLE; i += 1) {                                   // 同一帧内连发
      const v = ac.move({
        playerId: 'burst', tick: frames + 1 + i,
        x: x + QUOTA_MAX, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
      });
      if (v.allowed) x += QUOTA_MAX;
    }
    totalX += x - startX;
    frames += 1; ac.tick(frames);
  }
  const rate = (totalX / frames) * (1 / DT);
  const st = ac.get('burst');

  /* 1) 突发必须**留下违规流水**,归因 = SPEED(均速越线),并越过踢出阈值。 */
  ok(ac.violations().length > 0,
    `★ 同帧突发必须留下违规(修前为 0 条),实际 ${ac.violations().length} 条`);
  eq(kindsOf(ac).has(ViolationKind.SPEED), true,
    `★ 归因应为 SPEED(同帧累计路径 / 最小 1 帧),实际 [${[...kindsOf(ac)].join(',')}]`);
  eq(st?.kicked, true,
    `★ 一轮 ${IDLE - 1} 条 SPEED(${(IDLE - 1) * 3} 分 > 阈值 ${VIOLATION_SCORE_KICK})⇒ 必须被标记踢出`);

  /* 2) 速率必须**塌回合法上限以内** —— 「可持续移速优势」被消掉的直接证据。 */
  near(totalX, 20 * QUOTA_MAX, 1e-6,
    `每轮 ${IDLE} 包只放行 1 包 ⇒ 20 轮 × ${QUOTA_MAX} 格 = ${(20 * QUOTA_MAX).toFixed(3)} 格`);
  ok(rate <= capOf(MAX_SPEED_BONUS_MUL),
    `★ 修后实测 ${rate.toFixed(2)} 格/秒必须 ≤ 满加成合法上限 ${capOf(MAX_SPEED_BONUS_MUL).toFixed(2)}(修前 17.56)`);

  /* 3) 读数口径 = **最小可判跨度 1 帧**:越界包的路径恰为一包位移 ⇒ 0.918 / 0.05 = 18.36。
     ⚠️ 该值与**旧口径**(时间轴 = 报文条数)在修前的负对照里同值 —— 巧合,不是同一条判据:
     旧口径把「20 条报文」当成 1 秒;新分支只把**同一帧内的**累计路径按 1 帧结,
     报文条数不再能放大读数。 */
  const observed = speedObserved(ac);
  ok(observed.length > 0 && observed.every((o) => Math.abs(o - QUOTA_MAX / DT) < 0.005),
    `读数应恒为 ${(QUOTA_MAX / DT).toFixed(2)} 格/秒,实际 ${JSON.stringify([...new Set(observed)].slice(0, 3))}`);
  near(QUOTA_MAX / DT, 18.36, 0.01,
    '口径自检:同帧累计路径 0.918 格 / 最小跨度 0.05 秒 = 18.36 格/秒');
});

/* ═══════════ 10b. ★ 判据二(不同判据):同帧内的**合法连发**不得被误判 ═══════════ */

test('FND172-13 【关键】同帧内的合法连发不许被误判(水位新鲜 / 零位移 —— 都不是「突发」)', () => {
  /* 与 `FND172-10` 用**不同**的量区分两种形状(不是同一条判据的松紧):
     · 突发 = 申报水位 `lastMoveTick` 落后服务端时钟**整整一个窗口**(≥ 20 帧)⇒ 零跨度分支;
     · 合法 = 水位只差 0~1 帧(连续流里的同帧双发),或同帧累计路径 = 0(重复/心跳)
       ⇒ 零跨度分支**不参与**(前者由 `spanTicks > 0` 的正常分支判,后者路径为 0)。 */

  /* ── 形状 A:连续流里的同帧双发(客户端 20Hz 与服务端错帧的常态) ──
     mul=2.55 满加成:每帧 0.5737 格;同帧两包合计 1.147 格,仍 ≤ 2 帧额度 ⇒ 合法。 */
  const STEP = BASE_MOVE_SPEED * MAX_SPEED_BONUS_MUL * DT;      // 0.57375
  const ac = new AntiCheatRoom();
  ac.join('p', 0, 0, 0, 0);
  let x = 0;
  for (let f = 1; f <= SPEED_WINDOW_TICKS + 5; f += 1) {        // 连续 25 帧,一帧一报
    ac.tick(f);
    x += STEP;
    eq(ac.move({ playerId: 'p', tick: f, x, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL }).allowed, true,
      `第 ${f} 帧的合法移动必须放行`);
  }
  /* 本帧(第 26 帧)连发 2 包:声称 26 / 27 —— 都在 `lastTick + MAX` 内,各拿 1 帧额度 */
  ac.tick(SPEED_WINDOW_TICKS + 6);                              // 服务端推进到第 26 帧
  const pair = [SPEED_WINDOW_TICKS + 6, SPEED_WINDOW_TICKS + 7].map((t) => {
    x += STEP;
    return ac.move({ playerId: 'p', tick: t, x, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL });
  });
  eq(pair.map((v) => v.allowed), [true, true],
    '★ 同帧双发(每包都在自己的额度内)必须放行 —— 合法连发不得被误判');
  const s = ac.get('p');
  ok(s !== undefined, '状态应存在');
  if (s === undefined) return;
  ok(s.lastTick - s.lastMoveTick < SPEED_WINDOW_TICKS,
    `前提:水位新鲜(落后 ${s.lastTick - s.lastMoveTick} 帧 < ${SPEED_WINDOW_TICKS})⇒ 零跨度分支不参与`);
  ok(s.lastTick - s.window[0].tick > 0,
    '前提:窗口里有更早的帧 ⇒ 走的是**正常**窗口分支(`spanTicks > 0`,看不到失明)');
  /* 同帧累计路径 = 1 × STEP ≤ 单帧额度 ⇒ 即使把零跨度分支的触发条件放宽也不该命中 */
  ok(STEP <= quotaOf(MAX_SPEED_BONUS_MUL),
    `前提:同帧累计路径 ${STEP.toFixed(3)} ≤ 单帧额度 ${QUOTA_MAX.toFixed(3)}(合法连发的量级)`);
  eq(speedObserved(ac).length, 0, `★ 合法连发不得报 SPEED,实际 ${JSON.stringify(speedObserved(ac))}`);
  eq(ac.violations().length, 0, '合法轨迹上不留任何违规流水');

  /* ── 形状 B:静默 ≥ 窗口长之后的**零位移**连发(重传/心跳语义) ──
     它**满足**零跨度分支的两个触发条件(水位落后 + `spanTicks = 0`),但累计路径 = 0
     ⇒ 判据是「累计路径越线」,不是「同帧包数」。 */
  const hb = new AntiCheatRoom();
  hb.join('hb', 0, 0, 0, 0);
  for (let f = 1; f <= SPEED_WINDOW_TICKS + 2; f += 1) hb.tick(f);      // 静默 22 帧
  const hx = hb.get('hb')?.lastX ?? 0;
  let hbAllowed = 0;
  for (let i = 0; i < 30; i += 1) {
    const v = hb.move({
      playerId: 'hb', tick: SPEED_WINDOW_TICKS + 3 + i,
      x: hx, y: 0, z: 0, speedMul: MAX_SPEED_BONUS_MUL,
    });
    if (v.allowed) hbAllowed += 1;
  }
  const hs = hb.get('hb');
  eq(hbAllowed, 30, '零位移包(重复/心跳)必须全部放行:累计路径 = 0');
  eq(hb.violations().length, 0, '零位移连发不得留下任何违规(不得按「同帧包数」判)');
  eq((hs?.lastTick ?? Number.NaN) - (hs?.window[0].tick ?? Number.NaN), 0,
    '前提:窗口全落同一 `lastTick`(`spanTicks = 0`)⇒ 本形状下唯一可能命中的就是零跨度分支');
  eq(hs?.kicked, false, '更不得被标记踢出');
});

/* ═══════════ 11. ★ 分母注入实测帧间隔:62.77ms/帧下满速 4.5 格/秒不越线 ═══════════ */

test('FND172-11 ★ 注入实测帧间隔 62.77ms ⇒ 满速合法玩家 4.5 格/秒不再被判 SPEED', () => {
  /* 口径与 D-26 一致:本机 20Hz 循环实测 62.77ms/帧 ⇒ 15.93Hz。
     玩家仍以**真实** 4.5 格/秒走 ⇒ 每帧 0.2825 格(单帧额度 0.36 内)。 */
  const SRV_HZ = 15.93;
  const FRAME_MS = 1000 / SRV_HZ;                          // 62.77ms
  const stepPerFrame = BASE_MOVE_SPEED / SRV_HZ;           // 0.2825 格/帧
  ok(stepPerFrame < quotaOf(1),
    `前提:${stepPerFrame.toFixed(4)} 必须在单帧额度 ${quotaOf(1)} 内(否则先被 TELEPORT 拦,测不到窗口)`);

  const run = (inject: boolean): AntiCheatRoom => {
    const ac = new AntiCheatRoom();
    ac.join('p', 0, 0, 0, 0);
    let x = 0;
    for (let f = 1; f <= 3 * SPEED_WINDOW_TICKS; f += 1) {
      /* 房间侧接线形态:每帧把**实测**间隔传给 `tick`(room.ts 有 clock.nowMs())。 */
      if (inject) ac.tick(f, FRAME_MS); else ac.tick(f);
      x += stepPerFrame;
      ac.move({ playerId: 'p', tick: f, x, y: 0, z: 0, speedMul: 1 });
    }
    return ac;
  };

  const fixed = run(true);
  near(fixed.dtSeconds, FRAME_MS / 1000, 1e-12,
    '注入后分母应 = 62.77ms(而不是标称 50ms)');
  eq(speedObserved(fixed).length, 0,
    `★ 分母取实测节拍后,真实 4.5 格/秒的合法玩家不得被误判 SPEED,实际 ${JSON.stringify(speedObserved(fixed))}`);
  eq(fixed.get('p')?.kicked, false, '更不得因此累计到踢出');

  /* 负对照 = `FND172-3` 的形状:同一条轨迹**不注入** ⇒ 缺省 `DT` ⇒ 读数被放大 20/15.93 */
  const nominal = run(false);
  eq(nominal.dtSeconds, DT, '未注入 ⇒ 分母仍是标称 DT(既有房的行为逐位不变)');
  near(speedObserved(nominal)[0] ?? Number.NaN, BASE_MOVE_SPEED * (20 / SRV_HZ), 0.02,
    '未注入时读数仍是被放大的 ≈ 5.65(即 FND172-3 登记的那次误判)');
});

/* ═══════════ 12. 缺省 50ms ⇒ 5.63 锚点不变;注入只改读数不改判据 ═══════════ */

test('FND172-12 帧间隔 50ms 时 5.63 锚点逐位不变;注入实测值只改**读数**、不放水', () => {
  /* 锚点 = WS-07 `M49` 的步长口径(裸装 mul=1,上限 4.5 × 1.25 = 5.625 ≈ 5.63):
     0.25 格/帧 = 5.00 格/秒 < 5.63 合法;0.30 格/帧 = 6.00 格/秒 在第 20 帧被拒。 */
  const walk = (step: number, frameMs?: number): AntiCheatRoom => {
    const ac = new AntiCheatRoom();
    ac.join('p', 0, 0, 0, 0);
    let x = 0;
    for (let f = 1; f <= 2 * SPEED_WINDOW_TICKS; f += 1) {
      if (frameMs === undefined) ac.tick(f); else ac.tick(f, frameMs);
      x += step;
      ac.move({ playerId: 'p', tick: f, x, y: 0, z: 0, speedMul: 1 });
    }
    return ac;
  };
  const slow = walk(0.25);
  eq(slow.dtSeconds, DT, '缺省分母 = DT');
  eq(slow.violations().length, 0, '5.00 格/秒(< 5.63)必须 0 违规 —— 锚点不变');
  const fast = walk(0.30);
  near(speedObserved(fast)[0] ?? Number.NaN, 6.0, 0.01,
    '6.00 格/秒的读数仍是 6.00(分母 = 缺省 DT,读数一格没变)');
  ok(speedObserved(fast).length > 0, '6.00 格/秒仍被窗口抓住(判据未动)');

  /* 注入 62.77ms:同一个 0.36 格/帧(单帧额度上界,恰好放行)的作弊者,
     读数从**膨胀的 7.20** 修正为**真实 5.735 格/秒** —— 仍 > 同一个上限 5.625
     ⇒ 照样被拒。即:容差没动,只是秒表准了(真作弊者身上没有同步放水)。 */
  const quotaStep = quotaOf(1);                            // 0.36,恰好 = 单帧上界
  const inflated = walk(quotaStep);
  near(speedObserved(inflated)[0] ?? Number.NaN, quotaStep / DT, 0.01,
    '缺省分母把 0.36 格/帧读成 7.20 格/秒(标称 20Hz 口径)');
  const real = walk(quotaStep, 1000 / 15.93);
  const realObserved = speedObserved(real);
  near(realObserved[0] ?? Number.NaN, quotaStep / (1000 / 15.93 / 1000), 0.01,
    '注入 62.77ms 后读数 = **真实** 5.735 格/秒(分母修的是秒表,不是容差)');
  ok(realObserved.length > 0 && realObserved[0] > capOf(1),
    `依然越线被抓:真实 ${realObserved[0]} > 上限 ${capOf(1)}(放水会放行它)`);

  /* 注入门:非法值**保持**当前值(写成 NaN 会让 `observed > NaN` 恒 false ⇒ 窗口失明)。 */
  const guard = new AntiCheatRoom();
  eq(guard.dtSeconds, DT, '缺省 = 标称 DT');
  eq(guard.setFrameIntervalMs(Number.NaN), DT, 'NaN 注入被忽略 ⇒ 保持 DT(分母不得变 NaN)');
  eq(guard.setFrameIntervalMs(0), DT, '0 注入被忽略');
  eq(guard.setFrameIntervalMs(-5), DT, '负数注入被忽略');
  near(guard.setFrameIntervalMs(62.77), 0.06277, 1e-12, '合法注入生效');
  guard.tick(1, 62.79);
  near(guard.dtSeconds, 0.06279, 1e-12, '`tick(t, frameMs)` 是房间侧的转发入口(读回 dtSeconds)');
});

/* ═══════════ 13. ★ 判据(端到端):房间侧**接线**实测帧间隔 ═══════════ */

/**
 * 一个**真房**夹具:走生产路径(`assemble()` → `RoomRuntime` → `step()`),
 * 唯一推进墙钟的地方是 `wall += beatMs`,房间自己用 `this.clock.nowMs()` 量差值。
 * 玩家以**真实** 4.5 格/秒走 ⇒ 每帧 `BASE_MOVE_SPEED / hz` 格(与节拍无关)。
 */
function runRoom(fields: { tag: string; beatMs: number; hz: number }): ReturnType<typeof assemble>['runtime'] {
  let wall = 1_700_000_000_000;
  const a = assemble({
    roomId: `r_fnd172_${fields.tag}`,
    ownerId: 'u_o',
    clock: { nowMs: () => wall },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(172),
  });
  const rt = a.runtime;
  rt.ac.join('p', 0, 0, 0, 0);
  const stepPerFrame = BASE_MOVE_SPEED / fields.hz;
  let x = 0;
  for (let f = 1; f <= 3 * SPEED_WINDOW_TICKS; f += 1) {
    wall += fields.beatMs;
    rt.step();
    x += stepPerFrame;
    rt.ac.move({ playerId: 'p', tick: rt.state.meta.tick, x, y: 0, z: 0, speedMul: 1 });
  }
  return rt;
}

/* ═══════════ 14. 端到端:分母真的来自房间的实测节拍 ═══════════ */

test('FND172-14 ★ 端到端:真房 `step()` 每帧把**实测**节拍喂进窗口(62.77ms ⇒ 满速 4.5 不越线)', () => {
  const SRV_HZ = 15.93;
  const FRAME_MS = 1000 / SRV_HZ;                       // 62.77ms
  const real = runRoom({ tag: 'e2e_real', beatMs: FRAME_MS, hz: SRV_HZ });
  /* 1) 分母 = **房间自己量到**的差值。`FND172-11` 只证明注入入口能用,这条证明房间真在注入
        (标称 DT = 50ms 与本值分得开 ⇒ 断言有牙)。 */
  near(real.ac.dtSeconds, FRAME_MS / 1000, 1e-6,
    `★ 分母应 = 房间实测的 ${FRAME_MS.toFixed(2)}ms(缺省标称是 ${DT * 1000}ms)`);
  eq(real.acFrameGapDiscarded, 0, '节拍正常 ⇒ 一次都没被丢弃');
  /* 2) 满速合法玩家不越线(接线之前=无注入的形态见 `FND172-3`:5.65 > 5.625 误判)。 */
  eq(speedObserved(real.ac).length, 0,
    `★ 实测节拍注入后满速合法玩家不得被判 SPEED,实际 ${JSON.stringify(speedObserved(real.ac))}`);
  eq(real.ac.get('p')?.kicked, false, '更不得因此累计到踢出');

  /* 负对照:**同一条每帧轨迹**换成标称 20Hz 节拍 ⇒ 分母 50ms ⇒ 读数被放大 20/15.93 ⇒ 误判。
     ⇒ 判据分得开「房间按实测节拍注入」与「分母恒为标称 DT」。 */
  const nom = runRoom({ tag: 'e2e_nom', beatMs: DT * 1000, hz: SRV_HZ });
  near(nom.ac.dtSeconds, DT, 1e-9, '标称 20Hz 节拍 ⇒ 分母 = 50ms');
  ok(speedObserved(nom.ac).length > 0,
    '负对照:同一条每帧轨迹在标称节拍下仍被误判(⇒ 判据钉的是「喂了实测值」,不是「改了判据」)');
});

/* ═══════════ 15. ★ 休眠唤醒后的首个差值必须被丢弃(不稀释)═══════════ */

test('FND172-15 ★ 端到端:休眠唤醒后的首个极大差值被**丢弃** —— 分母不被稀释', () => {
  const FRAME_MS = 1000 / 15.93;                         // 62.77ms
  let wall = 1_700_000_000_000;
  const a = assemble({
    roomId: 'r_fnd172_e2e_sleep',
    ownerId: 'u_o',
    clock: { nowMs: () => wall },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(15),
  });
  const rt = a.runtime;
  rt.ac.join('p', 0, 0, 0, 0);
  for (let f = 1; f <= 3 * SPEED_WINDOW_TICKS; f += 1) { wall += FRAME_MS; rt.step(); }
  near(rt.ac.dtSeconds, FRAME_MS / 1000, 1e-6, '前置:分母已被实测节拍钉住');
  const before = rt.ac.dtSeconds;
  const tickBefore = rt.state.meta.tick;

  /* 休眠:`step()` 在 `status !== OPEN` 早退 ⇒ 该行 `ac.tick` **根本不被调用** ⇒ 水位冻结。 */
  eq(rt.sleep(), true, '前置:房间进入 SLEEPING');
  for (let i = 0; i < 12; i += 1) { wall += 5_000; rt.step(); }   // 60 秒没人推进
  eq(rt.state.meta.tick, tickBefore, '休眠房不推进帧号(既有口径不变)');
  eq(rt.ac.dtSeconds, before, '休眠期间一次 tick 都没发生 ⇒ 分母一动不动');
  eq(rt.acFrameGapDiscarded, 0, '休眠期间没有差值可丢');

  /* 唤醒:首个差值 = 60 秒 ⇒ **远超** `AC_FRAME_GAP_MAX_MS` ⇒ 必须丢弃且计数。 */
  eq(rt.wake(), true, '前置:唤醒');
  wall += 60_000;
  rt.step();
  eq(rt.acFrameGapDiscarded, 1, '★ 唤醒后首个极大差值必须计一次丢弃(可观测,不静默)');
  near(rt.ac.dtSeconds, before, 1e-12, '★ 分母仍是休眠前的实测值 —— **不被 60 秒差值稀释**');
  ok(rt.ac.dtSeconds <= AC_FRAME_GAP_MAX_MS / 1000,
    `分母不得越过上限 ${AC_FRAME_GAP_MAX_MS}ms`);

  /* 丢弃只影响**那一帧**:下一帧差值恢复正常 ⇒ 注入照常生效(不是「一丢就永久失明」)。 */
  wall += FRAME_MS;
  rt.step();
  near(rt.ac.dtSeconds, FRAME_MS / 1000, 1e-6, '下一帧差值正常 ⇒ 注入恢复');
  eq(rt.acFrameGapDiscarded, 1, '正常帧不再计丢弃');

  /* 负对照(照抄「把差值直接喂进去」的改法):分母 = 60s ⇒ 窗口读数被稀释 ~1200 倍。 */
  const naiveDt = 60_000 / 1000;
  const dilutedObserved = LEGIT_STEP / naiveDt;          // 每帧 0.225 格 ÷ 60 秒/帧
  near(dilutedObserved, 0.00375, 1e-6,
    '锚:无上限时合法 4.5 格/秒被读成 0.0038 格/秒(反作弊失明)');
  ok(BASE_MOVE_SPEED / dilutedObserved > 1000,
    '★ 稀释倍率 > 1000 ⇒ 这正是 `AC_FRAME_GAP_MAX_MS` 要挡的那件事(比不接线更糟)');
});

report('WS-FND-172');
