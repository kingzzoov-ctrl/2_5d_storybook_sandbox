/**
 * WS-FND-81 —— 归档 **v2** 的**实时回滚**:玩家血量与流体水位真的落回世界。
 *
 * ## 这个套件补的是哪一段
 *
 * `tests/WS-FND-72` 把 WSA1 做成「解码 + chunk 裁剪 + 回滚计划」,`tests/WS-FND-78`
 * 把计划落回 `WorldSim`,但那时写入侧还只写 **v1**、回滚**只还位置/等级/地形**:
 *
 * ```
 * server/src/world/archive.ts  v2 头(players[].hp + fluid)已实现(WS-FND-80)
 * server/src/sim/world_sim.ts  describeWorldForArchive() 仍写 v1      ← 缺口
 *                              applyRestore() 不碰 hp / 不铺水位        ← 缺口
 * ```
 *
 * ⇒ 「完整回滚」在两处**如实缺口**下不成立:血量与液面在归档里根本不存在,
 *   于是回滚之后世界看起来对、水位与血却回不去。本套件钉的就是这两个字段的
 *   **写入侧 + 应用侧**闭环。
 *
 * ## 判据结构(全部走**真装配**的归档口,与生产同一条路径)
 *
 * | # | 正面 | 负对照 |
 * | :--- | :--- | :--- |
 * | 1 | 写入侧 v2:头带 `hp`(在玩家对象**最后**)、`fluid` **紧跟** `players`;稀疏水位表只收 `amount>0` 且按 `(y,x)` 升序 | 重置后帧号归零 / 种子换了 / hp 回满 / 水不见了 |
 * | 2 | 归档 → 重置 → `applyRestore` ⇒ 玩家 `hp` 逐字段回到归档前的 70 | 回滚前 hp 是满的(70 只在归档里) |
 * | 3 | 流体水位逐格铺回:列出的格 = 归档值(700 / 500),且**进了活跃集合** | 未列出的格保持重建值 0(不伪造) |
 * | 4 | **v1 归档**:不抛错,`hp` 保持登记后的满血,**水温按重建值** | v1 的 player op 连 `hp` 键都没有;不产生 `fluid` op |
 * | 5 | 流体场尺寸**不符 ⇒ 在任何改动之前拒绝** | 拒绝时帧号 / 种子 / 血量 / 水位**一字未改** |
 * | 6 | 归档里 `hp=0` ⇒ 回滚后**必须倒地**(`downed` 由本层重算,不留给 `revive`) | 重置后是活的(满血、未倒地) |
 *
 * ## 期望值一律是**字面量 / 手算**
 *
 * `hp` 写 70(`100 − 30`,用**真实伤害结算**打到 70)、水位写 `700` / `500`、
 * 世界边长写 `32`、帧号写 `40` —— 不取被测模块的输出当期望值(那是「用一个值
 * 断言它自己」)。唯一用常量的是「满血 = `PLAYER_BASE_HP`」这类**契约本身**。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { PLAYER_BASE_HP } from '../server/src/combat/vitals.ts';
import {
  decodeWorldArchive,
  encodeWorldArchive,
  planRestore,
  type ArchiveFluidField,
  type DecodedWorldArchive,
  type RestorePlan,
  type RestorePlayerOp,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具与工具 ═══════════════════════ */

const CELL_X = 3;
const CELL_Y = 4;
const FURNITURE = 351; /* 暖松原木圆墙(内容表 351):玩家建造,seed 重建不出来 */
const DAMAGE = 30;
/** 归档前的血量(手算:100 − 30 = 70)。 */
const HP_BEFORE = PLAYER_BASE_HP - DAMAGE;
const WATER_A = { x: 5, y: 6, amount: 700 };
const WATER_B = { x: 2, y: 2, amount: 500 };

/* 只声明本套件真正用到的成员 —— 不 import `WorldSim` 的具体类型(那要拉一整套
   依赖面);结构化明确读口,断言的失败会落在**行为**而不是类型上。 */
interface SimFluid {
  readonly width: number;
  readonly height: number;
  /** 活跃集合大小:证明水位是经 `setCell`(markActive)写进去的,不是直写 `amount[]`。 */
  readonly activeCount: number;
  amountAt(x: number, y: number): number;
  setCell(x: number, y: number, init: { amount?: number }): void;
}
interface SimVitals {
  applyDamage(id: string, amount: number): { applied: number; downed: boolean };
  get(id: string): { hp: number; downed: boolean } | null;
}
interface SimHandle {
  readonly frame: number;
  readonly worldSeed: number;
  fluid: SimFluid;
  vitals: SimVitals;
  setCell(x: number, y: number, fields: { obj?: number }): void;
  advance(n?: number): number;
  vitalsOf(id: string): { hp: number; maxHp: number; downed: boolean } | null;
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
    roomId: `r_fnd81_${tag}`,
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
  snapshot: Uint8Array;
  decoded: DecodedWorldArchive;
  plan: RestorePlan;
  hpBefore: number;
}

/**
 * 建世界 → 建造一格 + 推进 40 帧 → 注水 → 打到 70 血 → 归档(重置)⇒ 返回
 * 「归档前事实 + 原始字节 + 解码 + 回滚计划」。
 *
 * ⚠️ 水位在 `advance(40)` **之后**注入:否则慢帧的流体步会在归档前把水挪走,
 *    「归档值」就不确定了(判据要的是确定的字节)。
 */
function archivedWorld(tag: string): ArchivedWorld {
  const { sim, snaps } = makeSim(tag);
  sim.setCell(CELL_X, CELL_Y, { obj: FURNITURE });
  sim.advance(40);
  sim.fluid.setCell(WATER_A.x, WATER_A.y, { amount: WATER_A.amount });
  sim.fluid.setCell(WATER_B.x, WATER_B.y, { amount: WATER_B.amount });
  /* 血量用**真实伤害结算**打到 70(不是直接把字段改成 70 —— 那会绕过 vitals)。 */
  const hit = sim.vitals.applyDamage('p1', DAMAGE);
  if (hit.applied !== DAMAGE) throw new Error(`伤害应落地 ${DAMAGE}(实得 ${hit.applied})`);
  const hpBefore = sim.vitalsOf('p1')?.hp ?? -1;
  const reset = sim.resetWorld({ seed: 999, nowMs: 1234 });
  if (!reset.applied) throw new Error('重置应生效(否则写侧没走到归档那一步)');
  if (snaps.length !== 1) throw new Error(`归档口应恰好收到 1 份快照(实得 ${snaps.length})`);
  const decoded = decodeWorldArchive(snaps[0]);
  return { sim, snapshot: snaps[0], decoded, plan: planRestore(decoded, null), hpBefore };
}

/** `fluid === null` 时本套件大部分判据的前提不成立 ⇒ 显式取用口。 */
function fluidOf(d: DecodedWorldArchive): ArchiveFluidField {
  if (d.fluid === null) throw new Error('这份夹具必须有水位(否则判据的前提不成立)');
  return d.fluid;
}

function playerOpOf(plan: RestorePlan): RestorePlayerOp {
  const op = plan.ops.find((o) => o.kind === 'player');
  if (op === undefined || op.kind !== 'player') throw new Error('计划里必须有 player op');
  return op;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function headerTextOf(bytes: Uint8Array): string {
  const headerLen = viewOf(bytes).getUint32(8, true);
  return new TextDecoder().decode(bytes.subarray(12, 12 + headerLen));
}

/** 头 JSON 里的键必须**按给定顺序**出现(键序是逐字节可比的一部分)。 */
function assertKeyOrder(text: string, keys: readonly string[]): void {
  let at = -1;
  for (const k of keys) {
    const i = text.indexOf(`"${k}":`);
    ok(i >= 0, `头里必须有 ${k} 这个键(实得头:${text.slice(0, 160)}...)`);
    ok(i > at, `头里键 ${k} 必须晚于前一个键(实得 ${i} ≤ ${at})—— 键序是逐字节可比的一部分`);
    at = i;
  }
}

/* ═══════════ 1. 写入侧 v2(含负对照) ═══════════ */

test('FND81-1 写入侧 v2:头带 hp(在最后)+ 稀疏水位表;负对照:重置后世界真的变了', () => {
  /* 期望值:
       · 版本 = 2;
       · 玩家 hp = 70(手算 100−30);
       · 水位表 = [{2,2,500},{5,6,700}](按 (y,x) 升序);
       · 关键键序:fluid 紧跟 players;玩家对象里 hp 紧跟 level。
     怎么变红:
       · 写入侧仍写 v1 / 少写 hp ⇒ 第 1/3 条;
       · 水位表乱序或缺格 ⇒ 第 6 条;
       · fluid 挪到 mobs 之后 / hp 不在最后 ⇒ 键序两条。 */
  const w = archivedWorld('write');
  eq(w.decoded.version, 2, '★ 写入侧写的版本 = 2');
  eq(w.hpBefore, HP_BEFORE, '前提:归档前 hp = 100 − 30 = 70(手算)');
  eq(w.decoded.players.length, 1, '一个玩家');
  eq(w.decoded.players[0].hp, HP_BEFORE, '★ 头里玩家 hp = 归档前血量');
  eq(playerOpOf(w.plan).hp, HP_BEFORE, '★ v2 计划里 player op 也带血量');

  const f = fluidOf(w.decoded);
  eq(f.width, 32, '水位场宽 = 世界边长');
  eq(f.height, 32, '水位场高');
  eq(
    f.levels,
    [
      { x: WATER_B.x, y: WATER_B.y, amount: WATER_B.amount },
      { x: WATER_A.x, y: WATER_A.y, amount: WATER_A.amount },
    ],
    '★ 稀疏水位表:只收 amount>0,且按 (y, x) 升序(y=2 排在 y=6 之前)',
  );

  /* 键序:写入侧必须与 `encodeWorldArchive` 逐键一致。 */
  const header = headerTextOf(w.snapshot);
  assertKeyOrder(header, [
    'version', 'roomId', 'seed', 'sizeCells', 'biome', 'frame', 'hourOfDay',
    'players', 'fluid', 'mobs', 'ground', 'chunks',
  ]);
  ok(
    header.includes(`"level":1,"hp":${HP_BEFORE}`),
    `★ 玩家对象里 hp 必须紧跟 level(实得 ${header.slice(0, 200)}...)`,
  );

  /* ★ 负对照:重置后(还没回滚)世界确实变了 —— 否则「一模一样」可能是恒真。 */
  eq(w.sim.frame, 0, '重置把帧序归零');
  eq(w.sim.worldSeed, 999, '重置换了种子');
  eq(w.sim.vitalsOf('p1')?.hp, 100, '★ 负对照:重置后 hp 回满(不是 70;100 = 基础血量的字面量锚)');
  eq(w.sim.fluid.amountAt(WATER_A.x, WATER_A.y), 0, '★ 负对照:重置后那格水不见了');
});

/* ═══════════ 2. 血量回滚 ═══════════ */

test('FND81-2 归档 → 重置 → applyRestore ⇒ 玩家 hp 逐字段回到归档前(并重算 downed)', () => {
  /* 怎么变红:
       · applyRestore 不消费 op.hp ⇒ 第 2 条(仍是满血 100);
       · 把 hp 写回但不重算 downed ⇒ 只要 hp>0,第 3 条仍绿;见 FND81-3 的 downed 反例
         (本判据的意义是「hp 真的回到 70」这一条)。 */
  const w = archivedWorld('hp');
  eq(w.sim.vitalsOf('p1')?.hp, 100, '前提:回滚前 hp 是满的(70 只在归档里)');
  const r = w.sim.applyRestore(w.plan);
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(w.sim.vitalsOf('p1')?.hp, HP_BEFORE, '★ 玩家 hp 回到归档前的 70');
  eq(w.sim.vitalsOf('p1')?.downed, false, 'hp>0 ⇒ 不倒地');
  eq(r.applied?.players, 1, '回滚报告恢复了 1 个玩家');
  eq(r.applied?.fluid, 1, '回滚报告铺了 1 条 fluid op');
});

/* ═══════════ 3. 流体水位回滚 ═══════════ */

test('FND81-3 流体水位逐格铺回:列出的格 = 归档值,未列出的格保持重建值 0', () => {
  /* 怎么变红:
       · applyRestore 不消费 fluid op ⇒ 第 2/3 条(仍是空场);
       · 直写 `amount[]`(绕过 `markActive`)⇒ 水位数值对但第 4 条(activeCount=0);
       · 顺手把未列出的格清零 / 编值 ⇒ 第 5 条仍绿(它本来就是 0),但第 4 条会暴露。 */
  const w = archivedWorld('fluid');
  eq(w.sim.fluid.amountAt(WATER_A.x, WATER_A.y), 0, '前提:回滚前是空场');
  const r = w.sim.applyRestore(w.plan);
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(w.sim.fluid.amountAt(WATER_A.x, WATER_A.y), WATER_A.amount, '★ (5,6) 水位回到 700');
  eq(w.sim.fluid.amountAt(WATER_B.x, WATER_B.y), WATER_B.amount, '★ (2,2) 水位回到 500');
  eq(w.sim.fluid.amountAt(0, 0), 0, '未列出的格保持重建值(空场 0)');
  ok(
    w.sim.fluid.activeCount > 0,
    `★ 铺回的水必须进**活跃集合**(经 setCell/markActive,实得 activeCount=${w.sim.fluid.activeCount})`
    + ' —— 直写 amount[] 会让这些水位下一帧不被推进',
  );
});

/* ═══════════ 4. v1 归档:两项按不可用处理 ═══════════ */

test('FND81-4 ★v1 归档:v2 项按不可用处理(不抛错;hp 保持满血;水温为重建值)', () => {
  /* 怎么变红:
       · 把缺 hp 当坏数据抛错 ⇒ 第 5 条;
       · 为一个 v1 计划编一个 100 / 全零水位场 ⇒ 第 6 条(编 100 时 hp≠满血)或第 9 条;
       · 无 fluid op 也去铺水位 ⇒ 不红,但会掩盖缺口(那条 op 不该存在)。 */
  const v1 = encodeWorldArchive({
    version: 1,
    world: {
      roomId: 'r_fnd81_v1', seed: 4242, sizeCells: 32, biome: 'MEADOW', frame: 40, hourOfDay: 12.5,
    },
    players: [{ id: 'p1', x: 10.5, y: 12.5, z: 0, level: 1 }],
    mobs: [],
    ground: [],
    chunks: [],
  });
  const d1 = decodeWorldArchive(v1);
  const plan1 = planRestore(d1, null);
  eq(d1.version, 1, '前提:v1 头');
  eq(d1.fluid, null, '前提:v1 没有水位');
  eq(plan1.ops.filter((o) => o.kind === 'fluid').length, 0, '★ v1 ⇒ **不产生** fluid op');
  eq(
    Object.prototype.hasOwnProperty.call(playerOpOf(plan1), 'hp'),
    false,
    '★ v1 ⇒ player op 里连 hp 键都没有(不填一个 100)',
  );

  const { sim } = makeSim('v1');
  const r = sim.applyRestore(plan1);
  ok(r.ok, `v1 计划也必须能应用,不抛错(${r.reason ?? ''})`);
  eq(r.applied?.fluid, 0, '没有 fluid op ⇒ 铺了 0 条');
  eq(sim.vitalsOf('p1')?.hp, 100, '★ v1 ⇒ hp 保持登记后的满血(100 = 基础血量字面量,不读被测模块)');
  eq(sim.vitalsOf('p1')?.downed, false, '满血 ⇒ 不倒地');
  eq(sim.fluid.amountAt(WATER_A.x, WATER_A.y), 0, '★ v1 ⇒ 水温按重建值(空场 0)');
});

/* ═══════════ 5. 尺寸不符:任何改动之前拒绝 ═══════════ */

test('FND81-5 ★负对照:流体场尺寸不符 ⇒ 拒绝回滚,且世界一字未改', () => {
  /* 尺寸闸必须在 `rebuildWorld` **之前** —— 否则地形/玩家已经动过,
     `WS-FND-78` 的「拒绝时世界一字未改」当场破掉。
     怎么变红:
       · 不校验流体场尺寸 ⇒ 第 1/2 条(变成 ok:true);
       · 先重建再检查 ⇒ 第 3~6 条(世界已经被改了)。 */
  const w = archivedWorld('size');
  const bad: RestorePlan = {
    ...w.plan,
    ops: w.plan.ops.map((op) => (op.kind === 'fluid' ? { ...op, width: 16 } : op)),
  };
  const frameBefore = w.sim.frame;
  const seedBefore = w.sim.worldSeed;
  const hpBefore = w.sim.vitalsOf('p1')?.hp;
  const fluidBefore = w.sim.fluid.amountAt(WATER_A.x, WATER_A.y);

  const r = w.sim.applyRestore(bad);
  eq(r.ok, false, '★ 流体场尺寸不符必须拒绝');
  ok((r.reason ?? '').includes('流体'), `理由要点名流体场(${r.reason ?? ''})`);
  eq(w.sim.frame, frameBefore, '★ 帧号一字未改');
  eq(w.sim.worldSeed, seedBefore, '★ 种子一字未改');
  eq(w.sim.vitalsOf('p1')?.hp, hpBefore, '★ 血量一字未改');
  eq(w.sim.fluid.amountAt(WATER_A.x, WATER_A.y), fluidBefore, '★ 水位一字未改');
});

/* ═══════════ 6. hp=0 ⇒ 倒地(自己重算 downed) ═══════════ */

test('FND81-6 ★归档里 hp=0 ⇒ 回滚后必须倒地(downed 由本层重算)', () => {
  /* `VitalsSystem.revive` 恒把 `downed` 清成 false ⇒ 若把「hp≤0 ⇒ 倒地」留给它,
     「血量 0 却不倒地」这种坏状态就会成立。这条专门把那个分支逼出来。
     怎么变红:
       · 不重算 downed(只 revive)⇒ 第 5 条(hp=0 却显示未倒地);
       · 写回 hp 时把 0 当成缺席 / 凑一个满血 ⇒ 第 3/4 条。 */
  const { sim, snaps } = makeSim('downed');
  sim.advance(40);
  const hit = sim.vitals.applyDamage('p1', PLAYER_BASE_HP);
  eq(hit.applied, 100, '前提:满额伤害真的落地');
  eq(sim.vitalsOf('p1')?.hp, 0, '前提:归档前 hp = 0');

  const reset = sim.resetWorld({ seed: 777, nowMs: 5 });
  ok(reset.applied, '重置应生效');
  const decoded = decodeWorldArchive(snaps[0]);
  eq(decoded.players[0].hp, 0, '★ v2 头里 hp=0 **如实**写(没被凑成满血)');
  eq(sim.vitalsOf('p1')?.downed, false, '前提:重置后是活的(满血、未倒地)');

  const r = sim.applyRestore(planRestore(decoded, null));
  ok(r.ok, `回滚应成功(${r.reason ?? ''})`);
  eq(sim.vitalsOf('p1')?.hp, 0, 'hp 回到 0');
  eq(sim.vitalsOf('p1')?.downed, true, '★ hp=0 ⇒ 必须倒地(downed 由 applyRestore 重算)');
});
report('WS-FND-81');
