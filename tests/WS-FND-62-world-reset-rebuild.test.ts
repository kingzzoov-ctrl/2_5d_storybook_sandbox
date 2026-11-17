/**
 * WS-FND-62 —— **`RESET_WORLD` 的宿主那一半**(裁决 D-06 = 归档 + 内存重建)。
 *
 * ## 这个套件钉的是什么
 *
 * 裁决原文(`docs/DECISIONS.md` **D-06**):
 *   「世界按新 seed **在内存重建**,旧世界存成一份**可回滚快照行**」
 *   「`WorldSim.resetWorld({seed})` 负责内存重建,归档由宿主/DB 侧做」
 *
 * 动作层那一半(`net/actions/reset_world.ts`)与存储那一半(`db/repo.ts` §13)已有
 * 自己的套件(`WS-FND-34` / `WS-FND-57`)。**本套件只管中间那一段**:
 * `WorldSim.resetWorld` 真的在内存里重建了世界,并且**如实**报出归档结果。
 *
 * ## 逐条对应的机制(注入验证的靶子)
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 重置后 `listWildlife()` 为空、钟点回 **06:00**、地形与掉落清空 | 只换个 rng 种子、世界状态原地不动 |
 * | 2 | 玩家仍在、满血、非倒地、回**出生点** | 重建时把玩家一起清了 / 只写 hp 不登记 |
 * | 3 | 旧世界**被归档**:真库里有 1 行、`id` 非空、`seed` 是**旧**种子 | 不归档 / 归档新世界 / 回执编一个空 id |
 * | 4 | 归档失败(sink 抛错)⇒ **`applied` 仍 true** + `archiveError` 非空 | 把"没存下来"当成"没生效" |
 * | 5 | 没有库 ⇒ `archive: null` + `archiveError` 含「没有库」 | 没有归档口却回成功 |
 * | 6 | 重置**真的换 seed**:同 seed 两次逐字节一致,不同 seed 不同 | 只清世界不换流 / 留了跨世代的脏状态 |
 * | 7 | 瞬态被清:料理 buff / 击退窗口 / 厨房 `fireOut` / 活人泡泡 | 只清"看得见的"(生物/地形) |
 *
 * ## 为什么第 6 条用「两次不同的历史 ⇒ 重置后逐字节一致」来钉
 *
 * 「同 seed 可重放」有两种写法:①同一个实例重置两次;②**两个历史不同的实例**
 * 重置到同一个 seed。后者更强 —— 它同时证明**没有任何跨世代残留**
 * (帧序 / 生物序号 / 击杀账 / 刷怪预算 / 物理位置)。①只证明"第二次也没炸"。
 *
 * ## 断言右侧一律是**字面量**
 * 种子写 `11` / `777` / `888`,钟点写 `6`,HP 写 `100`(`PLAYER_BASE_HP` 的字面值),
 * 出生点写 `0.5`(房间 `spawnPoint()` 的字面值)—— 不取被测模块的导出常量,
 * 否则就是"用一个值断言它自己"。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction, type ActionPayload, type RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { MemoryDb } from '../server/src/db/memory_db.ts';
import { createUser, listWorldArchives, migrate } from '../server/src/db/repo.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';

/* ───────────────────────── 取世界的那几个读口 ───────────────────────── */

/**
 * 本套件要用的世界侧能力(**只声明用到的**)。
 *
 * 为什么不直接用 `WorldSim` 类型:`assemble()` 的返回值刻意标成
 * `WorldSaveHost`(结构化契约,`net/room.ts` 不认识模拟层)。测试要断言的是
 * **世界内部可观测的状态**,故在一个**窄接口**上做一次 `as unknown as` ——
 * 与 `tests/WS-FND-34` 给真宿主临时挂能力是同一手法。
 */
interface SimHandle {
  readonly worldSeed: number;
  readonly frame: number;
  hourOfDay(): number;
  advance(n?: number): number;
  listWildlife(): { id: string; mobId: string; x: number; y: number; hp: number }[];
  addMob(id: string, biome: string, x: number, y: number): void;
  dropItem(x: number, y: number, itemId: number, count: number): void;
  groundItemsNear(x: number, y: number, radius: number): { itemId: number; count: number }[];
  setCell(x: number, y: number, fields: { obj?: number }): void;
  blockAt(x: number, y: number): number;
  applyPlayerMove(id: string, x: number, y: number, z?: number): boolean;
  applyKnockback(id: string, fromX: number, fromY: number, distance: number): boolean;
  knockbackOf(id: string): boolean;
  poseOf(id: string): { x: number; y: number; z: number } | null;
  vitalsOf(id: string): { hp: number; maxHp: number; downed: boolean } | null;
  useItem(id: string, req: { itemId: number }): { applied: boolean; reason: string };
  buffsOf(id: string): { atkMul: number };
  extinguishStationAt(deviceId: number): void;
  stationState(deviceId: number): { fireOut: boolean };
  liveBubbleOf(id: string): { stacks: number; trapSec: number };
  resetWorld(opts: { seed: number; nowMs?: number }): {
    applied: boolean;
    seed: number;
    reason?: string;
    archive: { id: string; seed: number; archived_at: number; bytes: number } | null;
    archiveError?: string;
  };
  /** 生命值的权威(直接打一下,把"倒地"造出来 —— 与 WS-10 同一手法)。 */
  vitals: { applyHit(attackerId: string, playerId: string, level: number, mul?: number): { applied: number; downed: boolean } };
}

const simOf = (host: WorldSaveHost): SimHandle => host as unknown as SimHandle;

/**
 * `null` 即失败的取值 —— 与 `ok(x !== null)` 的区别是**类型会收窄**。
 * (`ok()` 没有 `asserts` 签名:它只保证"抛了就红",TS 看不见窄化,
 *  于是 `born.x` 会被判成 `possibly null`。)
 */
function need<T>(v: T | null, msg: string): T {
  if (v === null) throw new Error(msg);
  return v;
}

let roomSeq = 0;

/** 造一个**真装配**的房间 + 它的世界(玩家 `p1` 按 `ownerId` 入座)。 */
function makeRoom(opts: {
  sizeCells?: number;
  mobs?: boolean;
  worldSeed?: number;
  db?: MemoryDb | null;
  archiveSink?: ((req: unknown) => { id: string; seed: number; archived_at: number; bytes: number }) | null;
} = {}): { rt: ReturnType<typeof assemble>['runtime']; sim: SimHandle; roomId: string } {
  roomSeq += 1;
  const roomId = opts.worldSeed === undefined ? `r_fnd62_${roomSeq}` : `r_fnd62_${roomSeq}_s${opts.worldSeed}`;
  const a = assemble({
    roomId,
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: opts.sizeCells ?? 32,
    mobs: opts.mobs ?? false,
    worldSeed: opts.worldSeed,
    db: opts.db ?? null,
    ...(opts.archiveSink !== undefined ? { archiveSink: opts.archiveSink } : {}),
  });
  a.runtime.join({ userId: 'p1' });
  return { rt: a.runtime, sim: simOf(a.host), roomId };
}

/** 派一次 `RESET_WORLD`(动作层 = `destructive`,只有 OWNER 能过)。 */
const resetVia = (rt: RoomRuntime, seed: number) => {
  /* `seed` / `confirm` **尚未**写进 `ActionPayload`(动作层按需局部窄化,见
     `net/actions/reset_world.ts` 的 `ResetWorldPayload`)⇒ 这里显式断言,
     不让"类型里没有这个键"变成测试绕不过去的墙。 */
  const payload = { confirm: true, seed } as unknown as ActionPayload;
  return rt.dispatchAction('p1', RoomAction.RESET_WORLD, payload);
};
/* ───────────────────────── 1. 世界真的重建了 ───────────────────────── */

test('FND62-1 ★ 重置后 listWildlife() 为空、钟点回 06:00、地形与掉落清空', () => {
  const { sim } = makeRoom({ sizeCells: 48, mobs: true, worldSeed: 11 });

  /* 先把世界弄"脏":推进(真的刷怪 / 时钟走动)、放一只怪、铺一格墙、掉两件货。 */
  sim.advance(600);
  sim.addMob('mob_sheep#1', 'MEADOW', 20.5, 20.5);
  sim.setCell(6, 6, { obj: 351 });
  sim.dropItem(7.5, 7.5, 151, 2);

  ok(sim.listWildlife().length >= 1, '重置前世界里必须**有**生物(否则第 1 条是空断言)');
  ok(sim.hourOfDay() > 6, `重置前时钟必须已经走过 06:00(实测 ${sim.hourOfDay().toFixed(3)})`);
  eq(sim.blockAt(6, 6), 351, '重置前那格墙是存在的');
  eq(sim.groundItemsNear(7.5, 7.5, 2).length, 1, '重置前地上有 1 堆货');

  const r = sim.resetWorld({ seed: 4242 });

  eq(r.applied, true, '重置必须生效');
  eq(r.seed, 4242, '回执里的种子是**实际生效**的那个');
  eq(sim.listWildlife(), [], '★ 生物被清空(不是"刷新了"、不是"还剩尸体")');
  eq(sim.hourOfDay(), 6, '★ 钟点回 06:00(D-07:0 帧 = 06:00)');
  eq(sim.frame, 0, '帧序归零(时间是帧序派生的,**不是**另存一个累加器)');
  eq(sim.blockAt(6, 6), 0, '地形被清空(旧世界的地形进了归档,不进新世界)');
  eq(sim.groundItemsNear(7.5, 7.5, 2), [], '地面掉落被清空');
});

/* ───────────────────────── 2. 玩家被保留 ───────────────────────── */

test('FND62-2 ★ 玩家仍在、满血、非倒地、回出生点', () => {
  const { sim } = makeRoom({ sizeCells: 32, worldSeed: 5 });

  /* 出生点先记下来(房间按席位排开:`0.5 + n*1.5`;p1 是第一个 ⇒ 0.5,0.5)。 */
  const born = need(sim.poseOf('p1'), '入座后世界里必须有 p1 的刚体');
  eq(born.x, 0.5, 'p1 的出生点 x(房间 spawnPoint 的字面值)');
  eq(born.y, 0.5, 'p1 的出生点 y');

  /* 弄脏:**走开** + **打到倒地**。 */
  eq(sim.applyPlayerMove('p1', 12.5, 9.5), true, '先把人挪走(否则"回出生点"是空断言)');
  const hit = sim.vitals.applyHit('mob_boar#1', 'p1', 30, 10);
  eq(hit.downed, true, '先真的把人打倒(否则"非倒地"是空断言)');
  const hurt = sim.vitalsOf('p1');
  eq(hurt?.hp, 0, '倒地时 HP 归零');
  eq(hurt?.downed, true, '倒地标记');

  const r = sim.resetWorld({ seed: 606 });
  eq(r.applied, true, '重置必须生效');

  const after = need(sim.poseOf('p1'), '★ 玩家**被保留**(重建不删玩家)');
  eq(after.x, 0.5, '★ 回到出生点 x');
  eq(after.y, 0.5, '★ 回到出生点 y');

  const v = need(sim.vitalsOf('p1'), '生命值记录仍在(重建后必须重新登记,漏了就是"打个不掉血")');
  eq(v.hp, 100, '★ 满血(PLAYER_BASE_HP 的字面值)');
  eq(v.maxHp, 100, '上限也是满的');
  eq(v.downed, false, '★ 非倒地');
});

/* ───────────────────────── 3. 旧世界被归档(真库) ───────────────────────── */

test('FND62-3 ★ 旧世界被归档:真库里有 1 行、id 非空、seed 是**旧**种子', () => {
  const db = new MemoryDb();
  migrate(db, 1000);
  /* 房间 bootstrap 会 `createRoom(ownerId)` —— 房主必须先存在(否则 `repo` 抛
     "房主不存在";`WS-07` 的 db 夹具也是同一套路)。 */
  createUser(db, { id: 'p1', displayName: 'A', nowMs: 1000 });
  const { rt, sim, roomId } = makeRoom({ sizeCells: 32, worldSeed: 11, db });

  /* 给旧世界留点**可重建**的东西,并推进几帧(归档行要记 world_tick)。 */
  sim.setCell(4, 4, { obj: 351 });
  sim.addMob('mob_sheep#1', 'MEADOW', 18.5, 18.5);
  sim.advance(20);

  const out = resetVia(rt, 777);
  eq(out.ok, true, `动作层应成功(kind=${out.kind ?? '-'} reason=${out.reason ?? '-'})`);
  eq(out.effect?.archive, 'ARCHIVED', '★ 宿主报告已归档 ⇒ 动作层回 ARCHIVED');
  ok(
    typeof out.effect?.archiveId === 'string' && out.effect.archiveId.length > 0,
    `★ 归档句柄必须非空(实得 ${String(out.effect?.archiveId)})`,
  );
  eq(out.effect?.archiveSeed, 11, '★ 归档的是**旧世界**的种子(不是新种子 777)');
  eq(out.effect?.seed, 777, '原先的口径不变:effect.seed 是**新**种子');
  eq(sim.worldSeed, 777, '世界侧的身份也换成了新种子');

  /* 存储侧:真的落了 1 行,句柄 = `<room_id>#<seq>`,字节非空。 */
  const rows = listWorldArchives(db, roomId);
  eq(rows.length, 1, '★ 一次重置 = 一行归档(不是 upsert)');
  eq(rows[0].id, `${roomId}#1`, '句柄形态');
  eq(rows[0].seed, 11, '★ 行里的 seed 是旧世界的');
  ok(rows[0].bytes > 100, `★ 快照真的有内容(实得 ${rows[0].bytes} 字节;空快照回滚出去是空世界)`);
  eq(rows[0].world_tick, 20, 'world_tick 记的是**旧世界**推进过的帧数');
});

/* ───────────────────────── 4. 负对照:归档失败 ───────────────────────── */

test('FND62-4 ★ 负对照:归档口抛错 ⇒ `applied` 仍 true 且 `archiveError` 非空', () => {
  const { rt, sim } = makeRoom({
    sizeCells: 24,
    worldSeed: 3,
    archiveSink: () => {
      throw new Error('磁盘满(注入)');
    },
  });
  sim.addMob('mob_sheep#1', 'MEADOW', 12.5, 12.5);

  const out = resetVia(rt, 909);

  /* ★ 判决:「旧世界没存下来」≠「新世界没生效」。 */
  eq(out.ok, true, '★ 归档失败**不许**把重置判成失败(世界确实已经换了)');
  eq(out.effect?.applied, true, 'applied 仍是 true');
  eq(out.effect?.archive, 'NOT_ARCHIVED', '归档没成 ⇒ NOT_ARCHIVED(不是 UNREPORTED)');
  eq(out.effect?.archiveId, undefined, '没归档就没有句柄(不许编一个)');
  ok(
    typeof out.effect?.archiveError === 'string' && out.effect.archiveError.length > 0,
    `★ 归档失败的原因必须转述(实得 ${String(out.effect?.archiveError)})`,
  );

  /* 世界侧:重建**真的发生了** —— 否则上面那句"世界确实换了"就是空话。 */
  eq(sim.listWildlife(), [], '★ 归档失败不影响重建');
  eq(sim.hourOfDay(), 6, '钟点仍回 06:00');
  eq(sim.worldSeed, 909, '种子仍换成新的');
});

/* ───────────────────────── 5. 没有库 ───────────────────────── */

test('FND62-5 ★ 没有 sink(装配没给库)⇒ `archive: null` + `archiveError` 含「没有库」', () => {
  const { rt, sim } = makeRoom({ sizeCells: 24, worldSeed: 4 }); /* 不给 db ⇒ 没有归档口 */

  const out = resetVia(rt, 1001);

  eq(out.ok, true, '没有库**不是**重置失败(世界照样重建)');
  eq(out.effect?.archive, 'NOT_ARCHIVED', '明确没归档');
  ok(
    typeof out.effect?.archiveError === 'string' && out.effect.archiveError.includes('没有库'),
    `★ 理由必须说清是"没有库"(实得 ${String(out.effect?.archiveError)})`,
  );
  eq(sim.worldSeed, 1001, '世界仍然重建并换了种子');
});

/* ───────────────────────── 6. 真的换了种子 ───────────────────────── */

/** 把 `listWildlife()` 压成可逐字节比较的字符串(位置固定 4 位小数)。 */
function traceOf(sim: SimHandle): string {
  return JSON.stringify(
    sim.listWildlife()
      .map((w) => [w.id, w.mobId, w.x.toFixed(4), w.y.toFixed(4), w.hp])
      .sort(),
  );
}

/**
 * 「不同的历史 → 重置到同一个 seed → 同一条序列」。
 *
 * `warmup` 与初始 seed 刻意不同:重置后若还剩**任何**跨世代状态
 * (帧序 / 生物序号 / 击杀账 / 刷怪预算 / 生物与刚体),两条序列就会分叉。
 */
function replay(warmup: number, initialSeed: number, resetSeed: number): string {
  const s = new WorldSim({ sizeCells: 48, seed: initialSeed, mobs: true, archiveSink: null });
  s.addPlayer('p1', 24.5, 24.5);
  s.advance(warmup);
  s.addMob('mob_boar#1', 'MEADOW', 30.5, 30.5);
  s.resetWorld({ seed: resetSeed });
  /* 重置后**手工**放两只:它们的轨迹由新种子那条流决定(AI 每拍取 rng)。 */
  s.addMob('mob_boar#1', 'MEADOW', 30.5, 30.5);
  s.addMob('mob_sheep#1', 'MEADOW', 30.5, 34.5);
  s.advance(400);
  return traceOf(simOf(s as unknown as WorldSaveHost));
}

test('FND62-6 ★ 重置真的换 seed:同 seed 可重放(逐字节一致),不同 seed 不同', () => {
  /* (a) 两次**历史不同**的运行重置到同一个种子 ⇒ 完全一致。 */
  const a = replay(30, 11, 777);
  const b = replay(300, 99, 777);
  eq(a, b, '★ 同种子 + 历史不同 ⇒ 重置后逐字节一致(没有跨世代残留)');
  ok(a.length > 2, `复位后的世界必须真的在动(实得 trace=${a.slice(0, 80)})`);

  /* (b) 换个重置种子 ⇒ 序列必须不同(否则"换种子"是空话)。 */
  const c = replay(30, 11, 888);
  ok(a !== c, '★ 不同种子 ⇒ 不同的世界(位置/血量/刷怪序列至少一处不同)');

  /* (c) 世界侧的身份也跟着换。 */
  const s = new WorldSim({ sizeCells: 16, seed: 11 });
  eq(s.worldSeed, 11, '构造期的种子身份');
  s.resetWorld({ seed: 777 });
  eq(s.worldSeed, 777, '★ 重置后身份换成新种子');
});

/* ───────────────────────── 7. 瞬态被清 ───────────────────────── */

test('FND62-7 ★ 瞬态被清:料理 buff / 击退窗口 / 厨房 fireOut / 活人泡泡', () => {
  const { sim } = makeRoom({ sizeCells: 32, worldSeed: 8 });

  /* 1 料理 buff(605 近战串:atkMul 1.25,持续 600 秒) */
  eq(sim.useItem('p1', { itemId: 605 }).applied, true, '先吃下一份料理');
  eq(sim.buffsOf('p1').atkMul, 1.25, '★ 重置前 buff 真的在(否则第 7 条是空断言)');

  /* 2 击退窗口(受击位移还剩 2 段没推完) */
  eq(sim.applyKnockback('p1', 0, 0, 2), true, '记一次击退');
  eq(sim.knockbackOf('p1'), true, '★ 重置前击退窗口真的开着');

  /* 3 厨房炉火浇灭标记 */
  sim.extinguishStationAt(506);
  eq(sim.stationState(506).fireOut, true, '★ 重置前炉火确实是"已浇灭"');

  const r = sim.resetWorld({ seed: 31337 });
  eq(r.applied, true, '重置必须生效');

  eq(sim.buffsOf('p1').atkMul, 1, '★ 料理 buff 被清(乘区回到中性 1)');
  eq(sim.knockbackOf('p1'), false, '★ 击退窗口被清(否则重置后玩家动不了)');
  eq(sim.stationState(506).fireOut, false, '★ 炉火"已浇灭"不许跨世代(新世界的锅是好的)');
  eq(sim.liveBubbleOf('p1').stacks, 0, '活人泡泡回到初始态');
  eq(sim.liveBubbleOf('p1').trapSec, 0, '困住计时也归零');
});

report('WS-FND-62-world-reset-rebuild');