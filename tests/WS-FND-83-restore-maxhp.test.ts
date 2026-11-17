/**
 * WS-FND-83 —— 归档回滚的**顺序**判据:等级 → 上限 → hp → downed。
 *
 * ## 这个套件补的是哪一段
 *
 * `tests/WS-FND-81` 把 v2 的 `hp` 接进了 `applyRestore`,但那一版只写 hp、
 * **不重算 `maxHp`**:
 *
 * ```
 * server/src/sim/world_sim.ts  applyRestore() 玩家分支:
 *   addPlayer()   ⇒ vitals.register ⇒ maxHp = 构造缺省 PLAYER_BASE_HP(100)
 *   写回 level    ⇒ 只是 progressOf().level
 *   vitals.revive(op.hp)          ← 此时上限还是 100
 * ```
 *
 * `VitalsSystem.revive` 的钳制是 `hp = Math.min(v.maxHp, Math.max(0, hp))`
 * (`server/src/combat/vitals.ts:732`),`VitalsSystem.syncMaxHp` 的策略 C 同样
 * 只钳不补(`vitals.ts:800`)⇒ 高等级玩家的归档血量会被**静默钳到 100**:
 * 不抛错、不警告,只是「回滚完了血不对」。
 *
 * ⇒ 修法在玩家分支里插一步「等级 → 上限」,**复用**仓库既有的那条路径
 * (`maxHpForLevel` 是上限的唯一算子、`syncMaxHp` 是 vitals 的唯一写入口 ——
 * 与 `restoreFromProfile` 第 3 步同一条纪律),顺序变成:
 *
 * ```
 * 1 等级(progresses)  →  2 上限(maxHpForLevel + syncMaxHp)  →  3 hp(revive)  →  4 downed
 * ```
 *
 * ## 判据结构
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 5 级玩家归档 hp=120 ⇒ 回滚后 hp **就是 120**(不被钳到 100) | 回滚前 hp / maxHp 都是基础 100(120 只在归档里) |
 * | 2 | 回滚后 `maxHp` = 该等级上限 160(手算 100+15×4),且 hp 仍是 120 | 锚:上限必须**高于**基础值,否则本套件无区分力 |
 * | 3 | 归档 hp=0(5 级)⇒ 回滚后 `downed === true`,hp=0 / maxHp=160 | 重置后是活的(满血、未倒地) |
 * | 4 | v1 归档(hp 不可用,3 级)⇒ 满血 = 当前上限 130,**不抛错** | v1 的 player op 连 `hp` 键都没有(不伪造一个 100) |
 *
 * ## 期望值全是**字面量 / 手算**
 *
 * `160 = 100 + 15×4`(5 级上限)、`130 = 100 + 15×2`(3 级上限)、`120 = 160 − 40`
 * —— 不取被测模块的输出当期望值。唯一用常量的是「基础血量 = `PLAYER_BASE_HP`」
 * 这类**契约本身**。
 *
 * ## 怎么变红(注入验证过的三处)
 *
 * - 删掉「等级 → 上限」那两步 ⇒ 判据 1(hp 变 100)、判据 2(maxHp 变 100);
 * - 把这两步挪到写 hp **之后** ⇒ 判据 1 变红(hp 被钳成 100,`maxHp` 事后才抬);
 * - 把 `v1 缺 hp` 分支去掉(留一个 100)⇒ 判据 4(hp=100 ≠ 满血 130)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { PLAYER_BASE_HP } from '../server/src/combat/vitals.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  planRestore,
  type DecodedWorldArchive,
  type RestorePlan,
  type RestorePlayerOp,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具与工具 ═══════════════════════ */

const LEVEL = 5;
/** 5 级上限(手算:`100 + 15×(5−1)`)。 */
const MAX_HP_AT_LV5 = 160;
/** 3 级上限(手算:`100 + 15×(3−1)`)。 */
const MAX_HP_AT_LV3 = 130;
const DAMAGE = 40;
/** 归档前的血量(手算:160 − 40 = 120;**高于**基础值 100 —— 这正是区分点)。 */
const HP_BEFORE = MAX_HP_AT_LV5 - DAMAGE;

/* 只声明本套件真正用到的成员(与 `WS-FND-81` 同一取舍:不 import `WorldSim`
   的具体类型)。 */
interface SimVitals {
  applyDamage(id: string, amount: number): { applied: number; downed: boolean };
  get(id: string): { hp: number; maxHp: number; downed: boolean } | null;
}
interface SimHandle {
  readonly frame: number;
  readonly worldSeed: number;
  vitals: SimVitals;
  vitalsOf(id: string): { hp: number; maxHp: number; downed: boolean } | null;
  levelOf(id: string): number;
  restoreFromProfile(playerId: string, profile: {
    level: number; hp: number; x: number; y: number; z: number; weaponId?: number;
  }): number;
  resetWorld(opts: { seed: number; nowMs?: number }): { applied: boolean; seed: number };
  applyRestore(plan: unknown): {
    ok: boolean;
    reason?: string;
    applied?: {
      chunks: number; players: number; mobs: number; ground: number;
      fluid: number; seed: number; frame: number;
    };
  };
}

/** 走**真装配**造一个 32 格世界,并在重置时捕获归档字节。 */
function makeSim(tag: string): { sim: SimHandle; snaps: Uint8Array[] } {
  const snaps: Uint8Array[] = [];
  const a = assemble({
    roomId: `r_fnd83_${tag}`,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 4242,
    db: null,
    archiveSink: (req) => {
      snaps.push(req.snapshot.slice());
      return {
        id: `${req.roomId}#${snaps.length}`,
        seed: req.seed,
        archived_at: req.nowMs,
        bytes: req.snapshot.byteLength,
      };
    },
  });
  a.runtime.join({ userId: 'p1' });
  return { sim: a.host as unknown as SimHandle, snaps };
}

interface ArchivedWorld {
  sim: SimHandle;
  decoded: DecodedWorldArchive;
  plan: RestorePlan;
  hpBefore: number;
}

/**
 * 建世界 → 用**既有读档口** `restoreFromProfile` 把玩家推到 5 级(上限 160)
 * → 真实伤害扣到 120 → 重置(捕获归档)⇒ 返回「归档前事实 + 解码 + 回滚计划」。
 *
 * ⚠️ 等级**必须**经 `restoreFromProfile` 写:它是等级 / 上限唯一获准的批量入口
 * (直接改 `progresses` 会绕过上限同步,那就不是生产路径了)。
 */
function archivedWorld(tag: string): ArchivedWorld {
  const { sim, snaps } = makeSim(tag);
  const applied = sim.restoreFromProfile('p1', {
    level: LEVEL, hp: MAX_HP_AT_LV5, x: 10.5, y: 12.5, z: 0,
  });
  if (applied !== 1) throw new Error(`读档口应生效 1 个玩家(实得 ${applied})`);
  /* 前提自检:等级 / 上限确实抬到了 5 级派生值。 */
  if (sim.levelOf('p1') !== LEVEL) throw new Error(`等级应为 ${LEVEL}(实得 ${sim.levelOf('p1')})`);
  if (sim.vitalsOf('p1')?.maxHp !== MAX_HP_AT_LV5) {
    throw new Error(`5 级上限应为 ${MAX_HP_AT_LV5}(实得 ${sim.vitalsOf('p1')?.maxHp})`);
  }
  const hit = sim.vitals.applyDamage('p1', DAMAGE);
  if (hit.applied !== DAMAGE) throw new Error(`伤害应落地 ${DAMAGE}(实得 ${hit.applied})`);
  const hpBefore = sim.vitalsOf('p1')?.hp ?? -1;
  if (hpBefore !== HP_BEFORE) throw new Error(`归档前 hp 应为 ${HP_BEFORE}(实得 ${hpBefore})`);

  const reset = sim.resetWorld({ seed: 999, nowMs: 1234 });
  if (!reset.applied) throw new Error('重置应生效(否则写侧没走到归档那一步)');
  if (snaps.length !== 1) throw new Error(`归档口应恰好收到 1 份快照(实得 ${snaps.length})`);
  const decoded = decodeWorldArchive(snaps[0]);
  return { sim, decoded, plan: planRestore(decoded, null), hpBefore };
}

function playerOpOf(plan: RestorePlan): RestorePlayerOp {
  const op = plan.ops.find((o) => o.kind === 'player');
  if (op === undefined || op.kind !== 'player') throw new Error('计划里必须有 player op');
  return op;
}

/* ═══════════ 1. hp 不被基础上限钳住(顺序判据的正身) ═══════════ */

test('FND83-1 ★5 级玩家归档 hp=120 ⇒ 回滚后 hp 就是 120(不被钳到基础 100)', () => {
  /* 判据本体:上限若是「构造缺省 100」,`revive(120)` 会静默给出 100。
     怎么变红:
       · 玩家分支不重算上限 ⇒ 第 9 条(hp=100);
       · 先写 hp 再抬上限 ⇒ 同样第 9 条(hp 当场被钳,之后的同步不补血);
       · 写回 hp 时凑一个满血 ⇒ 第 9 条(160 ≠ 120)。 */
  const w = archivedWorld('hp');
  eq(w.decoded.version, 2, '前提:写入侧是 v2(头里才有 level + hp)');
  eq(w.decoded.players.length, 1, '一个玩家');
  eq(w.decoded.players[0].level, LEVEL, '★ 归档记的是 5 级');
  eq(w.decoded.players[0].hp, HP_BEFORE, '★ 归档 hp = 160 − 40 = 120(手算)');
  eq(w.hpBefore, HP_BEFORE, '前提:归档前 hp 就是 120');

  /* ★ 负对照:重置之后 hp / maxHp 都回到基础 100 —— 120 只存在于归档里。 */
  eq(w.sim.vitalsOf('p1')?.hp, 100, '★ 负对照:回滚前 hp = 基础 100');
  eq(w.sim.vitalsOf('p1')?.maxHp, 100, '★ 负对照:回滚前上限 = 基础 100');

  const r = w.sim.applyRestore(w.plan);
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(r.applied?.players, 1, '回滚报告恢复了 1 个玩家');
  eq(w.sim.levelOf('p1'), LEVEL, '回滚后等级 = 5');
  eq(w.sim.vitalsOf('p1')?.hp, HP_BEFORE, '★ 回滚后 hp = 归档的 120(没被钳成 100)');
});

/* ═══════════ 2. 上限 = 该等级的上限 ═══════════ */

test('FND83-2 ★回滚后 maxHp = 该等级上限 160(手算 100+15×4),hp 仍是 120', () => {
  /* 这一条与 FND83-1 分开,理由:两者可以**各自单独**坏掉 ——
     「hp 对了但 maxHp 还是 100」在 `syncMaxHp` 之后再 revive 的写法里就会出现;
     那会让下一次 `stepTimers` 的 `hp < maxHp` 立刻回血 / 泡温泉填不满上限。
     怎么变红:
       · 不调 `maxHpForLevel` + `syncMaxHp` ⇒ 第 3 条(100);
       · 自己写 `100 + 15*(lv-1)` 之外的常数 / 抄错等级 ⇒ 第 3 条。 */
  const w = archivedWorld('maxhp');
  ok(
    MAX_HP_AT_LV5 > PLAYER_BASE_HP,
    `锚:5 级上限 ${MAX_HP_AT_LV5} 必须高于基础 ${PLAYER_BASE_HP}(否则本判据无区分力)`,
  );
  const r = w.sim.applyRestore(w.plan);
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(w.sim.vitalsOf('p1')?.maxHp, MAX_HP_AT_LV5, '★ 回滚后 maxHp = 5 级上限 160');
  eq(w.sim.vitalsOf('p1')?.hp, HP_BEFORE, '上限抬起来之后 hp 仍是归档值 120(没被补成满血)');
  eq(w.sim.levelOf('p1'), LEVEL, '等级与上限同源(都是 5)');
});

/* ═══════════ 3. 负对照:hp=0 ⇒ 倒地 ═══════════ */

test('FND83-3 ★负对照:归档 hp=0(5 级)⇒ 回滚后 downed === true,maxHp 仍是 160', () => {
  /* `VitalsSystem.revive` 恒把 `downed` 清成 false ⇒ 「hp≤0 ⇒ 倒地」必须由
     `applyRestore` 自己在写完 hp **之后**重算,顺序也就在这条判据里被钉住。
     怎么变红:
       · 只 revive 不重算 downed ⇒ 第 6 条(hp=0 却未倒地);
       · 把 0 当缺席 / 凑满血 ⇒ 第 4 条(头里 hp 不是 0)与第 7 条;
       · 顺手写上 hp 就结束(不抬上限)⇒ 第 8 条(maxHp=100)。 */
  const { sim, snaps } = makeSim('downed');
  eq(
    sim.restoreFromProfile('p1', { level: LEVEL, hp: MAX_HP_AT_LV5, x: 10.5, y: 12.5, z: 0 }),
    1,
    '前提:读档口把玩家推到 5 级',
  );
  const hit = sim.vitals.applyDamage('p1', MAX_HP_AT_LV5);
  eq(hit.applied, MAX_HP_AT_LV5, '前提:满额伤害真的落地');
  eq(sim.vitalsOf('p1')?.hp, 0, '前提:归档前 hp = 0');

  const reset = sim.resetWorld({ seed: 777, nowMs: 5 });
  ok(reset.applied, '重置应生效');
  const decoded = decodeWorldArchive(snaps[0]);
  eq(decoded.players[0].level, LEVEL, '★ 头里等级如实写 5');
  eq(decoded.players[0].hp, 0, '★ v2 头里 hp=0 **如实**写(没被凑成满血)');
  eq(sim.vitalsOf('p1')?.downed, false, '★ 负对照:重置后是活的(满血、未倒地)');

  const r = sim.applyRestore(planRestore(decoded, null));
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(sim.vitalsOf('p1')?.hp, 0, 'hp 回到 0');
  eq(sim.vitalsOf('p1')?.maxHp, MAX_HP_AT_LV5, '★ 上限仍按 5 级抬起(160)');
  eq(sim.vitalsOf('p1')?.downed, true, '★ hp=0 ⇒ 必须倒地(downed 由 applyRestore 重算)');
});

/* ═══════════ 4. v1 归档:hp 不可用 ⇒ 满血,且不抛错 ═══════════ */

test('FND83-4 ★v1 归档(hp 不可用,3 级)⇒ 满血 = 上限 130,不抛错', () => {
  /* v1 头里没有 `hp` ⇒ 计划里连这个键都没有。修法把上限按等级抬到位之后,
     「满血」= 当前 `maxHp`(130),**不是** `addPlayer` 那一刻的 100 ——
     填 100 就等于凭空扣掉 30 血,而且不报错。
     怎么变红:
       · 缺 hp 时抛错 ⇒ 第 3 条;
       · 缺 hp 留一个 100 / 不抬上限 ⇒ 第 4 / 5 条(100 ≠ 130)。 */
  const v1 = encodeWorldArchive({
    version: 1,
    world: {
      roomId: 'r_fnd83_v1', seed: 4242, sizeCells: 32, biome: 'MEADOW', frame: 40, hourOfDay: 12.5,
    },
    players: [{ id: 'p1', x: 10.5, y: 12.5, z: 0, level: 3 }],
    mobs: [],
    ground: [],
    chunks: [],
  });
  const d1 = decodeWorldArchive(v1);
  const plan1 = planRestore(d1, null);
  eq(d1.version, 1, '前提:v1 头');
  eq(d1.fluid, null, '前提:v1 也没有水位');
  eq(
    Object.prototype.hasOwnProperty.call(playerOpOf(plan1), 'hp'),
    false,
    '★ v1 ⇒ player op 里连 hp 键都没有(不伪造一个 100)',
  );

  const { sim } = makeSim('v1');
  const r = sim.applyRestore(plan1);
  ok(r.ok, `v1 计划也必须能应用,不抛错(${r.reason ?? ''})`);
  eq(sim.levelOf('p1'), 3, '回滚后等级 = 3');
  eq(sim.vitalsOf('p1')?.maxHp, MAX_HP_AT_LV3, '★ v1 也按等级抬上限(3 级 = 130)');
  eq(sim.vitalsOf('p1')?.hp, MAX_HP_AT_LV3, '★ v1 缺 hp ⇒ 满血 = 当前上限 130(不是基础 100)');
  eq(sim.vitalsOf('p1')?.downed, false, '满血 ⇒ 不倒地');
});

report('WS-FND-83');