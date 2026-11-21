/**
 * WS-FND-174 —— **同一房间的两个时钟**:HUD / 打盹的时基必须与判定同源
 *
 * ## 缺陷形态(两条,同根)
 *
 * ```text
 * 1 派对 HUD 剩余(room.ts#syncPartyHud)
 *     修前:elapsed = 墙钟 − startedAtMs(墙钟 ε {0.05s 名义一帧})
 *           而模式相位走**世界钟**(partyClock:0.5s × 慢帧数)
 *     实测:名义 20Hz 下两者恰好对上;真实帧率 ~15.93Hz 时墙钟快 ~20%
 *           ⇒ 180 秒的赛在墙上 180 秒就显示「剩余 0」,而世界还剩 37 秒
 *           (HUD 与判定打架,**不报错**)
 * 2 打盹时长(actions/sleep.ts = 墙钟 60s)
 *     而床上的回血/露水按**游戏秒**累加(social/afk.ts#tickAfk 的 dt)
 *     ⇒ 墙上睡满 60 秒只换来 47.8 世界秒的回血(717 HP,而不是 900)
 * ```
 *
 * ## 本套件钉的四件事
 *
 * | # | 判据 | 怎么变红(注入验证的靶子) |
 * |---|------|--------------------------|
 * | 1 | **HUD 剩余归零的时刻 == 世界结算的时刻**(15.93Hz 节拍) | 把 `worldSecondsOf` 换回 `this.clock.nowMs()` ⇒ 归零帧 717 ≠ 结算帧 899 |
 * | 2 | 归零前**一帧都不许**显示 0,归零帧 = 总时长(45×20 帧) | 把 `Math.ceil` 换成 `Math.round` ⇒ 提前一帧归零 |
 * | 3 | 换墙钟节拍(20Hz ↔ 15.93Hz)**同一帧**归零/结算 | 任一分支读墙钟 ⇒ 两个节拍差 182 帧 |
 * | 4 | 打盹窗口是**世界秒**(60)、结束帧与回血累计同一时基 | 窗口退回墙钟 ⇒ 15.93Hz 下 956 帧就醒(少 243 帧的回血) |
 *
 * 每条正判据都配负对照/注入验证(见各 test 的注释),`worldSecondsOf` 的读口
 * (`WorldSaveHost.simSeconds`)在 FND174-4 里被**当场摘掉**再跑一遍。
 *
 * 运行:`node tests/WS-FND-174-cross-clock.test.ts`
 */
import { eq, near, ok, report, test, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { FAST_PER_SLOW, WorldSim } from '../server/src/sim/world_sim.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { PartyMode } from '../server/src/db/repo.ts';
import { clearPartyRegistry, partyStateOf } from '../server/src/net/actions/start_party.ts';
import { PARTY_MODES } from '../shared/constants/bosses.ts';
import {
  SLEEP_DURATION_MS,
  SLEEP_DURATION_SEC,
  beginSleep,
  clearSleepRegistry,
  resetSleepClock,
  setSleepClock,
  sleepClockBaseOf,
  sleepStateOf,
} from '../server/src/net/actions/sleep.ts';
import { BED_HP_PER_SEC, createAfkPlayer, goBackground, tickAfk } from '../server/src/social/afk.ts';

/* ═════════════════════════ 基础设施 ═════════════════════════ */

/** 写死的时间原点(墙钟;被故意做假的那一半)。 */
const T0 = 1_700_000_000_000;
/** 名义节拍:20Hz。 */
const NOMINAL_BEAT_MS = 50;
/** 真实节拍(实测 ~15.93Hz):**一个世界帧真实花掉 62.8ms,而世界钟只记 50ms**。 */
const REAL_BEAT_MS = 1000 / 15.93;

type Meta = { meta: { partyMode: number; partyTimer: number; scoreA: number; scoreB: number } };
type HudRoom = ReturnType<typeof assemble>['runtime'];
type Room = ReturnType<typeof assemble>;

function metaOf(rt: HudRoom): Meta['meta'] {
  return (rt.cloneState() as unknown as Meta).meta;
}

/**
 * 一局派对赛的**全过程读数**(走生产路径:`SET_PARTY_MODE` + `START_PARTY`,
 * 后者的成功钩子 `startWorldPartyRun` 才把世界侧的赛局开起来)。
 *
 * ⚠️ 墙钟只在 `wall += beatMs` 那一行推进 —— 这正是「两个时钟」的那一半:
 *    世界钟随 `rt.step()`(→ `host.advance(1)`)按**帧**前进,与墙钟的节拍无关。
 */
interface PartyProbe {
  startFrame: number;
  hudZeroFrame: number;
  settleFrame: number;
  /** 结算前最后一个「剩余 > 0」的帧(用来证明没有提前归零)。 */
  lastNonZeroFrame: number;
  /** 开局帧的剩余秒数(应 = 本局总时长)。 */
  timerAtStart: number;
  totalSec: number;
  wallAtSettleSec: number;
  noClockFrames: number;
}

function runParty(opts: {
  tag: string;
  beatMs: number;
  frames?: number;
  mode?: PartyMode;
  /** 注入验证:摘掉 `WorldSaveHost.simSeconds`(世界钟读口)。 */
  stripWorldClock?: boolean;
}): PartyProbe {
  clearPartyRegistry();
  let wall = T0;
  const a: Room = assemble({
    roomId: `r_fnd174_${opts.tag}`,
    ownerId: 'owner',
    clock: { nowMs: () => wall },
    sizeCells: 24,
    mobs: false,
    rng: mulberry32(174),
  });
  const rt = a.runtime;
  const sim = a.host as unknown as WorldSim;
  rt.join({ userId: 'owner' });
  if (opts.stripWorldClock === true) Object.defineProperty(sim, 'simSeconds', { value: undefined, configurable: true });

  const mode = opts.mode ?? PartyMode.BRIDGE_CTF;
  eq(rt.setPartyModeBy('owner', mode).ok, true, '前置:SET_PARTY_MODE 成功');
  eq(rt.dispatchAction('owner', RoomAction.START_PARTY, {}).ok, true, '前置:START_PARTY 成功');
  const cfg = PARTY_MODES.find((m) => m.key === mode);
  ok(cfg !== undefined, `锚:${mode} 在冻结层 PARTY_MODES 里`);

  const probe: PartyProbe = {
    startFrame: -1, hudZeroFrame: -1, settleFrame: -1, lastNonZeroFrame: -1,
    timerAtStart: -1, totalSec: cfg!.buildSec + cfg!.raceSec, wallAtSettleSec: -1,
    noClockFrames: 0,
  };
  const frames = opts.frames ?? 1400;
  for (let k = 0; k < frames; k += 1) {
    wall += opts.beatMs;
    rt.step();
    const m = metaOf(rt);
    const phase = sim.partyPhase();
    const settled = sim.partySettlement() !== null;
    if (probe.startFrame < 0 && phase !== 'IDLE' && phase !== '') {
      probe.startFrame = k;
      probe.timerAtStart = m.partyTimer;
    }
    if (probe.startFrame >= 0 && m.partyTimer > 0) probe.lastNonZeroFrame = k;
    if (probe.hudZeroFrame < 0 && probe.startFrame >= 0 && m.partyTimer === 0) probe.hudZeroFrame = k;
    if (probe.settleFrame < 0 && settled) {
      probe.settleFrame = k;
      probe.wallAtSettleSec = (wall - T0) / 1000;
    }
  }
  probe.noClockFrames = rt.partyHudNoClockFrames;
  return probe;
}

/**
 * 一次打盹的**全过程读数**(走生产路径:真卧室 + 真 `SLEEP` 动作 +
 * 装配层注入的 `sleepSource` → 世界侧 `stepDozingEntry`)。
 *
 * 玩家固定站在卧室中心(WS-03 / WS-FND-26 同法),世界侧 `roomEffectOf.inBedroom`
 * 由 2Hz 慢帧刷新 ⇒ 先空跑 30 帧再上床。
 */
interface SleepProbe {
  base: string | null;
  windowMs: number;
  /** 睡醒(窗口到期)的帧号,以 SLEEP 那一刻为 0。 */
  expireFrame: number;
  /** 世界里那条打盹(回血/露水的驱动)真正结束的帧号。 */
  dozeEndFrame: number;
  /** 打盹在世界侧真正开始的帧号(`-1` = 从没开始)。 */
  dozeStartFrame: number;
  /** 到期那一刻的**墙钟**已走秒数(用来证明它与世界秒不是一回事)。 */
  wallAtExpireSec: number;
  sinceMs: number;
}

function buildBedroom(sim: WorldSim, x0 = 3, y0 = 3, w = 9): { cx: number; cy: number } {
  const WALL = 351;
  for (let dy = 0; dy < w; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const edge = dx === 0 || dy === 0 || dx === w - 1 || dy === w - 1;
      sim.setCell(x0 + dx, y0 + dy, edge ? { obj: WALL, floor: 1, elev: 1 } : { floor: 1, elev: 1 });
    }
  }
  sim.setCell(x0 + 3, y0 + w - 1, { obj: 363, floor: 1, elev: 1 });
  sim.setCell(x0 + 2, y0 + 2, { obj: 517 });
  return { cx: x0 + Math.floor(w / 2), cy: y0 + Math.floor(w / 2) };
}

function runSleep(opts: { tag: string; beatMs: number; frames?: number }): SleepProbe {
  clearSleepRegistry();
  resetSleepClock();
  let wall = T0;
  const roomId = `r_fnd174_${opts.tag}`;
  const a: Room = assemble({
    roomId, ownerId: 'u_owner', clock: { nowMs: () => wall },
    sizeCells: 24, mobs: false, rng: mulberry32(43),
  });
  const rt = a.runtime;
  const sim = a.host as unknown as WorldSim;
  rt.join({ userId: 'p1' });
  const c = buildBedroom(sim);
  sim.addPlayer('p1', c.cx + 0.5, c.cy + 0.5);
  for (let i = 0; i < 30; i += 1) { wall += opts.beatMs; rt.step(); }

  const res = rt.dispatchAction('p1', RoomAction.SLEEP);
  eq(res.ok, true, `前置:卧室里 SLEEP 成功(kind=${res.kind} reason=${res.reason ?? '-'})`);
  const sinceMs = res.effect!.sinceMs as number;
  const untilMs = res.effect!.untilMs as number;
  const wallAtSleepMs = wall;

  const probe: SleepProbe = {
    base: sleepClockBaseOf(roomId, 'p1'),
    windowMs: untilMs - sinceMs,
    expireFrame: -1, dozeEndFrame: -1, dozeStartFrame: -1,
    wallAtExpireSec: -1, sinceMs,
  };
  const frames = opts.frames ?? 1500;
  for (let k = 0; k < frames; k += 1) {
    wall += opts.beatMs;
    rt.step();
    const dozing = sim.dozingOf('p1');
    if (probe.dozeStartFrame < 0 && dozing) probe.dozeStartFrame = k;
    if (probe.expireFrame < 0 && !sleepStateOf(roomId, 'p1').sleeping) {
      probe.expireFrame = k;
      probe.wallAtExpireSec = (wall - wallAtSleepMs) / 1000;
    }
    if (probe.expireFrame >= 0 && probe.dozeEndFrame < 0 && !dozing) probe.dozeEndFrame = k;
  }
  return probe;
}

/* ═════════ 1. 派对 HUD 剩余:与世界结算同一帧(★ 核心判据)═════════ */

test('FND174-1 ★★ HUD 剩余归零的时刻 == 世界结算的时刻(15.93Hz 节拍)', () => {
  /* 判据的目标(任务书原文):伪造 15.93Hz 节拍,断言两者**同一帧**。
   * 变红条件:把 `syncPartyHud` 的剩余算回墙钟(elapsed = clock.nowMs() − startedAtMs)
   * ⇒ 15.93Hz 下 HUD 在墙上 45 秒(= 第 717 帧)就归零,而世界在第 899 帧才结算。 */
  const p = runParty({ tag: 'real', beatMs: REAL_BEAT_MS });

  ok(p.startFrame >= 0, '前置:世界侧的赛局真的开起来了(partyPhase 非 IDLE)');
  ok(p.settleFrame > 0, `前置:世界侧真的结算了(settleFrame=${p.settleFrame})`);
  eq(p.hudZeroFrame, p.settleFrame,
    '★★ HUD 剩余归零的时刻必须**就是**结算发生的时刻(同源:两边都读世界钟)');
  eq(p.lastNonZeroFrame, p.settleFrame - 1,
    '★ 结算前一帧还必须是「剩余 1」—— 提前归零与晚归零都会在这里红');
  eq(p.timerAtStart, p.totalSec, `★ 开局帧剩余 = 本局总时长 ${p.totalSec}s(锚点取在开局那一刻)`);
  eq(p.totalSec, 45, '锚:BRIDGE_CTF 总时长 15 + 30 = 45s(字面量)');
});

test('FND174-2 ★ 墙钟在结算帧已经走了 56.5 秒 ⇒ 它不可能再驱动这个 HUD(判据有牙)', () => {
  const p = runParty({ tag: 'real2', beatMs: REAL_BEAT_MS });
  /* 时间**形态**:世界钟按帧走 ⇒ 45 秒 = 45 × 20 = 900 帧(帧号是 **0 基**的步号:
     第 k 步把世界推到第 k+1 帧 ⇒ 结算在步 899 = 第 900 帧)。 */
  eq(p.settleFrame, 45 * 20 - 1,
    '★ 结算发生在开局的第 900 帧(0 基步号 899 = 45 世界秒 × 20Hz)');
  /* 墙钟形态:同一个 900 帧在 15.93Hz 下是 56.5 秒。
     负对照(旧实现):墙钟第 45 秒(= 第 717 帧)就会把它算成「剩余 0」。 */
  ok(p.wallAtSettleSec > p.totalSec + 10,
    `★ 结算时墙钟已走 ${p.wallAtSettleSec.toFixed(1)}s > 总时长 ${p.totalSec}s ⇒ 旧实现早就归零了`);
  const wallPredictedZeroFrame = Math.round((p.totalSec * 1000) / REAL_BEAT_MS);
  eq(wallPredictedZeroFrame, 717, '锚:墙钟读法会在第 717 帧归零(45s ÷ 62.8ms)');
  ok(wallPredictedZeroFrame !== p.hudZeroFrame,
    `★ 墙钟预测的归零帧 ${wallPredictedZeroFrame} ≠ 实测归零帧 ${p.hudZeroFrame} ⇒ 判据能区分两个钟`);
});

test('FND174-3 ★★ 换墙钟节拍(20Hz ↔ 15.93Hz):归零帧与结算帧**都不动**', () => {
  const real = runParty({ tag: 'cmp_real', beatMs: REAL_BEAT_MS });
  const nominal = runParty({ tag: 'cmp_nom', beatMs: NOMINAL_BEAT_MS });
  /* 两个节拍下墙钟差 ~1.26 倍(56.5s vs 45s),而世界钟完全一样 ⇒ 帧号必须一致。
     变红条件:任一侧读墙钟 ⇒ 两个节拍差 182 帧(899 − 717)。 */
  eq(nominal.startFrame, real.startFrame, '★ 开局帧与墙钟节拍无关');
  eq(nominal.hudZeroFrame, real.hudZeroFrame, '★★ 归零帧与墙钟节拍无关(HUD 不再被墙钟驱动)');
  eq(nominal.settleFrame, real.settleFrame, '★ 结算帧与墙钟节拍无关');
  near(nominal.wallAtSettleSec, 45, 0.2, '锚:名义 20Hz 下结算时墙钟正好 45s');
  ok(real.wallAtSettleSec - nominal.wallAtSettleSec > 10,
    `锚:两个节拍的墙钟读数差 ${(real.wallAtSettleSec - nominal.wallAtSettleSec).toFixed(1)}s(世界钟读数相同)`);
});

test('FND174-4 ★★ 注入验证:摘掉世界钟读口 ⇒ 墙钟再也推不动 HUD(停在总时长 + 计数)', () => {
  /* 注入手法:`Object.defineProperty(sim, 'simSeconds', { value: undefined })` —— 世界钟
     读口当场消失(手写 host 假件 / 老宿主同形)。要求的行为是**如实降级**:
     停在总时长并计数,而**不是**退回墙钟(退回墙钟就是本缺陷本身)。
     ★ 本锚点必须改(单独说明理由,WS-FND-176 批):修前这里钉的是「4000 帧一次
     都不归零 / `lastNonZeroFrame = 3999`」,而那个形态**恰好依赖** Z2 缺陷 ——
     「自然结算后账本永远 `RUNNING`」。WS-FND-176(D-23)修完:结算后世界相位自动回
     `IDLE` ⇒ 房间 `endParty` 收束账本 ⇒ HUD 走「已结算 ⇒ 剩余 0」那一支,
     归零是**正确**行为,不能再当判据。牙改成「结算之前每一帧都走『没有读数』那一支
     并逐帧计数」—— 退回墙钟的实现这里恒 0(不是 > 阈值),照样红。 */
  const p = runParty({ tag: 'noclock', beatMs: NOMINAL_BEAT_MS, frames: 4000, stripWorldClock: true });
  ok(p.startFrame >= 0, '前置:账本与世界侧的赛局都在跑(只是读不到世界钟)');
  eq(p.timerAtStart, p.totalSec, '★ 剩余停在**本局总时长**(如实降级:不知道就不倒计时)');
  ok(p.settleFrame > 0, `前置:世界侧照常自然结算(settleFrame=${p.settleFrame},与读口在不在无关)`);
  ok(p.noClockFrames > 300,
    `★★ 结算之前每一帧都走「没有世界钟读数」那一支(${p.noClockFrames} 帧,结算帧 ${p.settleFrame})`
    + ' ⇒ 墙钟一次都没参与(退回墙钟的实现这里恒 0)');
  ok(p.lastNonZeroFrame >= p.settleFrame - 1,
    `★ 结算之前每一帧都是「剩余 = 总时长」⇒ 倒计时一帧都没走过(实测 ${p.lastNonZeroFrame})`);
  /* 负对照(同一夹具、**只差读口在不在**):有世界钟时同一局照常在第 899 帧归零。 */
  const keep = runParty({ tag: 'keep', beatMs: NOMINAL_BEAT_MS, frames: 4000 });
  eq(keep.hudZeroFrame, 899, '负对照:读口在 ⇒ 倒计时照常在第 899 帧归零');
  eq(keep.noClockFrames, 0, '负对照:读口在 ⇒ 「缺读数」计数恒 0(两条降级路径分得开)');
});

/* ═════════ 2. 打盹:窗口与回血同一时基 ═════════ */

test('FND174-5 ★★ 打盹窗口打在**世界钟**上:60 世界秒,而不是 60 墙钟秒', () => {
  const real = runSleep({ tag: 'sleep_real', beatMs: REAL_BEAT_MS });
  /* 窗口的基:生产路径(房间每帧推世界钟)⇒ WORLD。 */
  eq(real.base, 'WORLD', '★★ 窗口的时基 = 世界钟(房间推开的世界秒),不是模块时钟(墙钟)');
  eq(real.windowMs, SLEEP_DURATION_MS, '窗口长度 = SLEEP_DURATION_MS(60 世界秒)');
  eq(real.windowMs / 1000, 60, '锚:窗口秒数 = 60(= SLEEP_DURATION_SEC;期望侧写字面量以免同义反复)');
  /* 结束时刻:世界秒 60 ⇒ 60 × 20 = 1200 帧(窗口在世界钟 1.5s 处开)。 */
  eq(real.expireFrame, SLEEP_DURATION_SEC * 20 - 1,
    `★ 第 1200 帧到期(0 基步号 1199 = 60 世界秒 × 20Hz),实测 ${real.expireFrame}`);
  /* 同一时刻的**墙钟**读数:15.93Hz 下已走 ~75 秒 ⇒ 两个钟不是一回事。
     负对照(旧实现):窗口按墙钟判 ⇒ 第 956 帧(墙上 60 秒)就醒。 */
  ok(real.wallAtExpireSec > SLEEP_DURATION_SEC + 10,
    `★ 到期时墙钟已走 ${real.wallAtExpireSec.toFixed(1)}s(> 60s)⇒ 旧实现会早 243 帧就醒`);
  const wallBasedExpireFrame = Math.round((SLEEP_DURATION_SEC * 1000) / REAL_BEAT_MS);
  eq(wallBasedExpireFrame, 956, '锚:墙钟读法会在第 956 帧到期(60s ÷ 62.77ms)');
  ok(wallBasedExpireFrame !== real.expireFrame, '★ 判据能区分「世界秒 60」与「墙钟 60 秒」');
});

test('FND174-6 ★★ 同一打盹:结束时刻与回血/露水的驱动**同一帧**结束(≤ 1 慢帧)', () => {
  const real = runSleep({ tag: 'doze_real', beatMs: REAL_BEAT_MS });
  const nominal = runSleep({ tag: 'doze_nom', beatMs: NOMINAL_BEAT_MS });
  /* 世界侧那条打盹(露水/回血的驱动)由 `sleepSource` ⇒ `sleepStateOf` 驱动,
     ⇒ 窗口一到期,世界侧下一慢帧就把它注销(采样延迟 ≤ 1 个慢帧 = 0.5 世界秒)。 */
  ok(real.dozeStartFrame >= 0, '前置:世界侧真的进了打盹(装配层的 sleepSource 生效)');
  ok(real.dozeEndFrame > real.expireFrame,
    `★ 打盹在窗口到期之后结束(expire=${real.expireFrame} dozeEnd=${real.dozeEndFrame})`);
  ok(real.dozeEndFrame - real.expireFrame <= FAST_PER_SLOW,
    `★ 延迟 ≤ 1 个慢帧(${real.dozeEndFrame - real.expireFrame} 帧 ≤ ${FAST_PER_SLOW})—— 是世界钟上的采样延迟,不是两个钟的错配`);
  /* 换墙钟节拍:两个节拍下**同一帧**到期、同一帧结束打盹 ⇒ 回血累计的那段时间也相同。
     变红条件:窗口退回墙钟 ⇒ 15.93Hz 那一组早 243 帧结束(回血少了 243/10 × 7.5 ≈ 182 HP)。 */
  eq(nominal.expireFrame, real.expireFrame, '★★ 打盹到期帧与墙钟节拍无关(同一时基)');
  eq(nominal.dozeEndFrame, real.dozeEndFrame, '★★ 打盹结束帧与墙钟节拍无关 ⇒ 回血累计时长也相同');
  ok(real.wallAtExpireSec > nominal.wallAtExpireSec + 10,
    '锚:两组墙钟读数差 > 10s(而世界钟读数一致)');
});

test('FND174-7 ★ 单位恒等:一次打盹窗口的回血 = SLEEP_DURATION_SEC × BED_HP_PER_SEC', () => {
  /* 模块级恒等(sleep.ts 的窗口 ↔ afk.ts 的累加):两个模块说的是不是**同一段时间**。 */
  const p = createAfkPlayer('p1');
  p.onBed = true;
  goBackground(p, 0);
  const ticks = SLEEP_DURATION_SEC * 2;          /* 0.5s 一慢帧 ⇒ 60 世界秒 */
  for (let i = 0; i < ticks; i += 1) tickAfk(p, 5 + i * 0.5, 0.5);

  near(p.dozedSec, 60, 1e-9, '★ 打盹累计 = 窗口的世界秒数(60,字面量:SLEEP_DURATION_SEC 在 actual 侧同源)');
  near(p.healedHp, SLEEP_DURATION_SEC * BED_HP_PER_SEC, 1e-9,
    '★★ 同一窗口的回血 = 60 × 15 = 900 HP(与窗口同一时基)');
  near(p.dew, SLEEP_DURATION_SEC / 30, 1e-9, '★ 露水也按同一段时间攒(60 × 1/30 = 2 滴)');

  /* 负对照:把**同一个 60 秒**按墙钟读(15.93Hz 的真实节拍)只值 47.8 世界秒 ⇒ 717 HP。
     两个数不同 ⇒ 「按哪个钟读」这件事有牙(修前的形态正是 717)。 */
  const wallSec = SLEEP_DURATION_SEC * (15.93 / 20);
  const wallHealed = wallSec * BED_HP_PER_SEC;
  ok(wallHealed < SLEEP_DURATION_SEC * BED_HP_PER_SEC - 100,
    `负对照:墙钟读法只给 ${wallHealed.toFixed(1)} HP < 900 ⇒ 两个时基不可互换`);
  near(wallHealed, 716.9, 0.2, '锚:47.79 世界秒 × 15 = 716.9 HP(修前实测形态)');
});

test('FND174-8 ★ 第 3 级兜底:没有世界钟读数 ⇒ 模块时钟开窗与判到期(60_000ms 整)', () => {
  /* 负对照的另一半:窗口**不靠调用方记得**就落在同一时基上 ——
     世界钟那档已由 FND174-5 钉住,这里钉「没有世界就读模块时钟」这一档。 */
  clearSleepRegistry();
  let fake = 5_000_000;
  setSleepClock(() => fake);
  const r = beginSleep('r_fnd174_mod', 'p1');
  eq(r.record.base, 'MODULE', '★ 没有世界钟读数 ⇒ 记录标成模块时钟');
  eq(sleepClockBaseOf('r_fnd174_mod', 'p1'), 'MODULE', '读口与记录一致');
  eq(r.record.untilMs - r.record.sinceMs, SLEEP_DURATION_MS, '窗口仍是 60 秒(只是换了钟)');

  fake += SLEEP_DURATION_MS - 1;
  eq(sleepStateOf('r_fnd174_mod', 'p1').sleeping, true, '★ 差 1ms ⇒ 还在睡(不上取整提前)');
  fake += 1;
  eq(sleepStateOf('r_fnd174_mod', 'p1').sleeping, false, '★ 正好 60_000ms ⇒ 醒(边界含)');
  eq(sleepStateOf('r_fnd174_mod', 'p1').remainingMs, 0, '醒后 remainingMs = 0');

  /* 显式 `nowMs` 的调用方自带基准 ⇒ 记录标 MODULE(与修前行为一致,不悄悄改口径)。 */
  eq(beginSleep('r_fnd174_expl', 'p1', 1_000).record.base, 'MODULE',
    '显式 nowMs ⇒ 记录标模块时钟(查询侧也要一起给 nowMs)');
  resetSleepClock();
  clearSleepRegistry();
});

test('FND174-9 ★ 负对照:没有赛局记录 ⇒ HUD 三字段如实 0(修法没有把 0 变成恒定值)', () => {
  clearPartyRegistry();
  let wall = T0;
  const a: Room = assemble({
    roomId: 'r_fnd174_none', ownerId: 'owner', clock: { nowMs: () => wall },
    sizeCells: 24, mobs: false, rng: mulberry32(7),
  });
  const rt = a.runtime;
  rt.join({ userId: 'owner' });
  wall += NOMINAL_BEAT_MS;
  rt.step();
  eq([metaOf(rt).partyTimer, metaOf(rt).scoreA, metaOf(rt).scoreB], [0, 0, 0],
    '没开局 ⇒ 三字段 0(HUD 的 0 来自「没有赛局」这一支,而不是「世界钟读不到」)');
  eq(partyStateOf('r_fnd174_none'), null, '`partyStateOf` = null(从没开过局)');
  eq(rt.partyHudNoClockFrames, 0, '★ 没有赛局在跑 ⇒ 不该计「缺世界钟」的账(两条降级路径分得开)');
});

report('WS-FND-174');
