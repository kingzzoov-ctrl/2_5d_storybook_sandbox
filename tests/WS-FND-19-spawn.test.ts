/**
 * WS-FND-19 —— **世界里真的刷出生物了没有**(2026-11-14)。
 *
 * ## 这个套件为什么存在
 *
 * `npm run play` 那天实测:
 * ```
 * assemble({ mobs: true }) → step(null) × 600 → cloneState().wildlife = 0 条
 * ★ 世界里没有怪 ⇒ 「打怪」这条玩法在实机里永远空转
 * ```
 * 根因是**两条链路各断一头**,而且两端都不报错:
 * ```
 * 世界侧  if (spawner.canSpawn(ctx, …)) spawned += 1;   ← 只计数,不造怪
 *         且 ctx.biome = 'PLAINS'(不在 BIOME_SPAWN 表里)、mobId = 'WILDLIFE'(不是真物种)
 * 网络侧  upsertWildlife()                              ← 全仓 0 个调用点
 *         房间从不把世界的生物写进 state.wildlife
 * ```
 * ⇒ 单看任何一端都「一切正常」:没有异常、没有日志、测试照过。
 *
 * ## 本套件钉的是什么(以及为什么每条都对应一个可注入的机制)
 *
 * | # | 断言 | 注入验证(改坏哪一行会红) |
 * | :--- | :--- | :--- |
 * | 1 | 900 帧内真的出现生物,且进了快照 | `tickSpawn()` 改回 `spawned += 1` |
 * | 2 | 放下的生物能被**权威扣血**,且扣血进快照 | 删掉 `step()` 里的 `projectWildlife()` |
 * | 3 | 生物没了就从快照消失(不是幽灵目标) | 删掉 `projectWildlife` 的差集删除 |
 * | 4 | `mobs: false` ⇒ 一帧都不刷(负对照) | `if (this.mobsOn)` 改成永真 |
 * | 5 | 整图在安全区内 ⇒ 一只都不刷 | 刷怪路径绕过 `decideSpawn`(自己造一只) |
 * | 6 | 刷出来的物种必须是**本群系**的 | 把 `biomeName` 写死成 `'MEADOW'` |
 *
 * ## ⚠️ 第 5 条是本套件里最值钱的一条
 * 1/2/3/6 都可能在「刷怪路径自己拍脑袋造怪」的实现下**照样通过**;
 * 只有第 5 条会红 —— 它要求刷怪必须**经过** `decideSpawn` 的安全区判定。
 * 换句话说:它检验的不是「有没有怪」,而是「怪是按规则来的」。
 *
 * ## 已知边界(本套件不声称的事)
 * `addMob(id, …)` 用**同一个字符串**当实例 id 与 `MOB_BY_ID` 的查表键
 * ⇒ 当前世界**每物种最多一只**(见 `world_sim.ts` 的 `trySpawnOne` 注释)。
 * 故本文件断言的是「至少 1 只、且每只都是真物种」,
 * **不**断言能刷到 `BIOME_SPAWN.hardCap` 那么多只 —— 那要先拆 id 契约。
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';

import { MOB_BY_ID, mobsByBiome } from '../shared/constants/mobs.ts';
import { Biome } from '../shared/types/entities.ts';

type W = { id: string; mobId: string; x: number; y: number; hp: number; maxHp: number };
type St = { wildlife: W[]; players: { id: string; x: number; y: number }[] };

/** 造一个有玩家、可选生物的世界。**一切走生产装配函数** `assemble()`。 */
function world(sizeCells: number, mobs: boolean, seed = 7) {
  const a = assemble({
    roomId: 'r_spawn',
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells,
    mobs,
    rng: mulberry32(seed),
  });
  a.runtime.join({ userId: 'u_owner' });
  return a;
}

const wildlifeOf = (rt: { cloneState(): unknown }): W[] => (rt.cloneState() as St).wildlife;

/** 推进到**第一次**看见生物为止;返回帧号,没看见返回 -1。 */
const stepUntilWildlife = (rt: { step(p: unknown): unknown; cloneState(): unknown }, maxFrames: number): number => {
  for (let i = 1; i <= maxFrames; i += 1) {
    rt.step(null);
    if (wildlifeOf(rt).length > 0) return i;
  }
  return -1;
};

/**
 * `assemble()` 的 `host` **声明**成结构化接口 `WorldSaveHost`(它刻意不 import
 * 模拟层类型),而**运行期它就是 `WorldSim`**。测试里要「放一只怪」必须用
 * 世界自己的公开方法 —— 手搓 `state.wildlife` 只能验证「投影会转发一个假
 * payload」,验不到「世界里的怪被打掉血之后快照跟着变」。
 * ⇒ 这里做一次显式窄化(不是 `as any`),且只暴露测试真正用到的两个方法;
 *   这样 `verify.ts` 的类型错误基线**不会因为本文件而增加**。
 */
type SimLike = {
  addMob(id: string, biome: string, x: number, y: number): void;
  mobHost: { removeMob(id: string): boolean };
};
const hostSim = (a: { host: unknown }): SimLike => a.host as SimLike;

/* ───────────────────────── 1 ───────────────────────── */

test('FND19-1 世界真的会刷出生物,而且进了权威快照', () => {
  const a = world(64, true);
  const rt = a.runtime;

  /* 开局必须是空的 —— 生物是 2Hz 慢帧一只只来的,不是创世时摆好的。
     这条同时是注入面:若有人改成「装配时直接填满」,这里会红。 */
  eq(wildlifeOf(rt).length, 0, '开局世界应当是空的(生物靠慢帧逐只刷)');

  const firstAt = stepUntilWildlife(rt, 900);
  ok(firstAt > 0, `900 帧(45 秒世界时间)内应刷出第一只生物,实测第 ${firstAt} 帧`);

  const list = wildlifeOf(rt);
  ok(list.length >= 1, '快照里应能看到至少一只生物');
  for (const w of list) {
    /* 真物种:`MOB_BY_ID` 里查得到。修订前写的是 `mobId: 'WILDLIFE'` ——
       一个**任何表里都没有**的名字(真去 addMob 只会进 `unknownMobs` 空壳)。 */
    ok(MOB_BY_ID.has(w.mobId), `快照里的 mobId 必须是真物种,实测 "${w.mobId}"`);
    ok(w.hp > 0, `${w.id} 应是活的(hp > 0),实测 ${w.hp}`);
    eq(w.maxHp > 0, true, `${w.id} 的 maxHp 应来自物种定义`);
    eq(w.id, w.mobId, `当前 id 契约:实例 id = 物种 id(${w.id} vs ${w.mobId})`);
    /* 坐标必须落在世界内(刷怪点取的是格心,+0.5)。 */
    ok(w.x >= 0 && w.x < 64 && w.y >= 0 && w.y < 64, `${w.id} 的坐标应在世界内,实测 ${w.x},${w.y}`);
  }
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND19-2 放下的生物能被权威扣血,且扣血写进快照', () => {
  const a = world(64, true);
  const rt = a.runtime;

  /* ⚠️ 用**世界自己的** `addMob`(生产方法),不是手搓 state.wildlife ——
     手搓只能验证「投影会把一个假 payload 转发出去」,验不到「世界里的怪
     被打掉血之后,快照跟着变」。 */
  hostSim(a).addMob('mob_sheep', 'MEADOW', 1.5, 0.5);
  rt.step(null);

  const before = wildlifeOf(rt).find((w) => w.id === 'mob_sheep');
  ok(before !== undefined, 'addMob 之后快照里就该有这只生物(投影真的在跑)');
  const hp0 = before!.hp;

  const res = rt.applyAttack('u_owner', 0, 'mob_sheep');
  eq(res.allowed, true, '一格外(玩家出生在 0.5,0.5)的攻击应获准');

  const rep = rt.lastAttackReport;
  ok(rep !== null, '应留下攻击回执');
  eq(rep!.outcome, 'OK', '应真的结算,而不是 OUT_OF_AOI(那说明物理位置没进世界)');
  /* ⚠️ 回执(`lastAttackReport`)是**扁平**的:`hit` 是布尔、`outOfReach`/`dodged`
     在顶层。嵌套形状(`hit.result.outOfReach`)属于**模拟层** `attackMobAuthorized`
     的返回值,房间在 `applyAttack` 里把它摊平了 —— 我第一次就是照 `WorldSaveHost`
     的 docblock 写成了嵌套路径,于是 `rep.hit.result` 是 undefined。 */
  eq(rep!.hit, true, '应有一次命中记录(hit = true)');
  eq(rep!.outOfReach, false, '一格外不该判 outOfReach');

  rt.step(null);
  const after = wildlifeOf(rt).find((w) => w.id === 'mob_sheep');
  /* 两种合法结果:被打伤(还在)或被打死(已从快照清掉)。 */
  if (after === undefined) {
    ok(rep!.hpLoss > 0, '生物从快照消失只允许是「被打死」这一种解释');
  } else {
    ok(after.hp < hp0, `权威扣血应反映到快照:${hp0} → ${after.hp}`);
  }
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND19-3 生物没了就从快照里消失(不是打不动的幽灵目标)', () => {
  const a = world(64, true);
  const rt = a.runtime;

  hostSim(a).addMob('mob_sheep', 'MEADOW', 1.5, 0.5);
  rt.step(null);
  eq(wildlifeOf(rt).some((w) => w.id === 'mob_sheep'), true, '放下后应在快照里');

  hostSim(a).mobHost.removeMob('mob_sheep');
  rt.step(null);
  eq(wildlifeOf(rt).some((w) => w.id === 'mob_sheep'), false,
    '世界侧移除后,快照必须跟着清掉 —— 否则客户端会永久看到一只打不动的幽灵');
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND19-4 关掉 mobs 就一只都不刷(负对照)', () => {
  const a = world(64, false);
  const rt = a.runtime;
  const at = stepUntilWildlife(rt, 900);
  eq(at, -1, `mobs: false 时 900 帧内不应出现任何生物,实测第 ${at} 帧`);
  eq(wildlifeOf(rt).length, 0, 'mobs: false 时快照里的生物数恒为 0');
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND19-5 刷怪必须经过 decideSpawn:整图在安全区内 ⇒ 一只都不刷', () => {
  /* 32×32 世界:城镇中心 (16,16),安全半径 `TOWN_SAFE_RADIUS` = 24;
     最远的角到中心 = √(16²+16²) ≈ 22.63 < 24 ⇒ **全图都在安全区内**。
     ⇒ 若这一条刷出了东西,说明新刷怪路径**绕过**了 `decideSpawn`
       (自己造一只,而不是问规则)。 */
  const a = world(32, true);
  const rt = a.runtime;
  const at = stepUntilWildlife(rt, 900);
  eq(at, -1,
    `整图都在安全区内时不应刷出任何生物,实测第 ${at} 帧 —— `
    + '刷出东西说明刷怪没有走 decideSpawn 的安全区判定');
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND19-6 刷出来的是**本群系**的物种(群系真的在起作用)', () => {
  /* 修订前刷怪 tick 里写死 `biome: 'PLAINS'` —— 那个名字**不在 BIOME_SPAWN
     表里**,于是永远走 `?? BIOME_SPAWN.MEADOW` 的兜底(而兜底不报错)。
     这里对两个群系各跑一次:刷出来的物种必须属于**该群系**的名单。 */
  for (const biome of [Biome.MEADOW, Biome.RUINS]) {
    const allowed = new Set(mobsByBiome(biome).map((d) => d.id));
    const a = assemble({
      roomId: 'r_biome', ownerId: 'u_owner', clock: { nowMs: () => 0 },
      sizeCells: 64, mobs: true, biome, rng: mulberry32(11),
    });
    a.runtime.join({ userId: 'u_owner' });
    const at = stepUntilWildlife(a.runtime, 900);
    ok(at > 0, `群系 ${biome} 下 900 帧内应刷出生物(实测第 ${at} 帧)`);
    for (const w of wildlifeOf(a.runtime)) {
      ok(allowed.has(w.mobId),
        `群系 ${biome} 只能刷本群系物种,实际刷出 "${w.mobId}"(不在 ${[...allowed].join('/')} 里)`);
    }
  }
});

report('WS-FND-19');
