/**
 * WS-FND-189 · **主线六步的接线**(世界侧成功点 → 事件总线 → `applyEvent` ⇒ HUD 有进度)。
 *
 * ## 这套判据在守什么
 *
 * `quests/mainline.ts` 的六步状态机 17/17 全绿,但**没有任何地方喂它事件**
 * (`applyEvent` 的生产调用点 = 0)⇒ 运行期永远停在「一步没做」,玩家屏幕上的
 * `□ 主线 1/6` 与他做过什么**无关**。这是本仓的典型缺陷形态:**在、绿、但没人调**。
 *
 * 本套件因此不测「状态机对不对」(那是 `WS-FND-187` 的事),只测**接线**:
 * ```text
 * 真 WorldSim 的成功点 ──emit──▶ EventBus ──on──▶ attachMainline ──applyEvent──▶ mainlineOf()
 * ```
 * 第一条判据就是这条链的**端到端**证据:采一次自然材料,玩家的 `step` 从 1 变 2。
 *
 * ## 判据
 *
 * | # | 判据 | 为什么有牙(改坏了哪条会红) |
 * |---|------|----------------------------|
 * | FND189-0  | 前置:取样 id 的类别/存在性是**内容表**的事实;`regionAt` 的两个取样点确实是 meadow/camp | 内容表改了类别 / 设计图挪了区 ⇒ 与本文件的取样漂开,当场红(而不是让后面几条静默测错东西) |
 * | FND189-1  | ★★ `breakBlock(x,y,'p1')` 采掉一格自然材料 ⇒ `mainlineOf('p1').step` 1 → 2 | 摘掉 `attachMainline(sim.bus)` 的 gather 订阅 **或** `breakBlock` 里的 emit ⇒ 红(文末有实证) |
 * | FND189-2  | ★★ 依次做六件事 ⇒ `done === true`(每条事件都来自一个**真**成功点) | 六个成功点任缺一个 ⇒ 停在对应步,红 |
 * | FND189-3  | ★ 两个玩家各做一半 ⇒ 两人状态互不影响(p9 只采集 ⇒ 停在 2) | 把事件一律记到同一个 userId ⇒ 红(文末有实证) |
 * | FND189-4  | 负面对照:只打怪(没采集)⇒ step 仍是 **1**,但 `kill` 事件**确实发出来了** | 断言写成「kill 没发生」就变成恒真;这里同时钉「事件在、状态没动」 |
 * | FND189-5  | `mainlineOf('不存在的用户')` 不抛、返回**第一步视图**、不建档 | 改成抛错或返回 undefined ⇒ 红 |
 * | FND189-6  | **userId 是硬要求**:`breakBlock` 不传 actorId ⇒ 一条主线事件都不发 | 把 `emitMainline` 的「空 userId 不发」删掉 ⇒ 红(见实现处的第 2 条纪律) |
 * | FND189-7  | 换区事件**只在 region 的 id 真变时**发:同一区里走一步不发;`null` 区不发 | 改成「每次移动都发」⇒ 红;`after`/`before` 写反 ⇒ 红 |
 * | FND189-8  | Boss:世界侧**不判阈值**(0.92 也发一条),掉到 ≤ 0.5 才推进 | 把阈值判据搬到 `damageBoss` ⇒ 0.92 那条不发 ⇒ 红(阈值只许有一处) |
 * | FND189-9  | 事件形状:六类的 kind / payload / source 与**协议唯一持有者**逐字段一致 | payload 键名写错(生产端 `playerId`、消费端读 `userId`)⇒ 红 |
 * | FND189-10 | `detach()` 之后事件不再推进(订阅器是唯一入口) | 忘记 `off()` ⇒ 红 |
 *
 * ## 内容 id 为什么是这些(取自冻结内容表,不是随手编的)
 *
 * ```text
 * 101 暖松原木   category NATURAL  ⇒ 第 1 步认
 * 201 暖松石刃斧 category TOOL     ⇒ 第 2 步认
 * 305 复古红砖广场砖(= FLOOR)      ⇒ 第 3 步认(方块/家具/建筑都算)
 * 'meadow' → 'camp'                ⇒ 第 4 步认(regionAt 的真实返回值)
 * 'mob_boar'                       ⇒ 第 5 步认(MOB_BY_ID)
 * 'boss_jelly_king'                ⇒ 第 6 步认(BOSS_BY_ID)
 * ```
 * FND189-0 逐条把这些**假设**钉住:取样若与内容表/设计图漂开,第一条就红。
 *
 * ## 坐标为什么是 (64,64) 与 (90,90)
 *
 * ```text
 * (64,64) → regionAt = 'meadow'   (草原圆,半径 16)
 * (90,90) → regionAt = 'camp'     (营地矩形 84..107)
 * 相距 ≈ 37 格,而击杀归属半径 SHARE_RADIUS = 24 ⇒ 「远处的 p9」拿不到击杀事件
 * ```
 *
 * ## 有牙实证(改坏实现 ⇒ 判据真变红;两处变异都已还原,`git diff` 只剩本轮的接线)
 *
 * 见文件末尾「有牙实证」一节(实测输出原文)。
 *
 * 运行:`node --experimental-strip-types tests/WS-FND-189-mainline-wiring.test.ts`
 */

import { eq, near, ok, report, test } from '../shared/testing/harness.ts';

import { WorldSim } from '../server/src/sim/world_sim.ts';
import {
  MAINLINE_BUS_KIND,
  attachMainline,
  type MainlineWiring,
} from '../server/src/quests/mainline_wiring.ts';
import { makeMemoryOfferingPort } from '../server/src/bosses/runtime.ts';
import { DamageKind } from '../server/src/mobs/behaviors.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';
import { MOB_BY_ID } from '../shared/constants/mobs.ts';
import { BOSS_BY_ID } from '../shared/constants/bosses.ts';
import { ItemCategory } from '../shared/types/entities.ts';
import { DESIGN_SIZE, regionAt } from '../shared/world/design.ts';

/* ── 取样(理由见文件头;FND189-0 逐条钉住) ── */
const NAT_WOOD = 101;
const TOOL_AXE = 201;
const FLOOR_BRICK = 305;
const MOB_BOAR = 'mob_boar';
const MOB_BOAR_1 = 'mob_boar#1';
const BOSS_JELLY = 'boss_jelly_king';
const REGION_MEADOW = 'meadow';
const REGION_CAMP = 'camp';

/** 本玩家:草原中心。 */
const ME = 'p1';
/** 另一个玩家:无区地带 (30,30),距击杀点 ≈ 85 格 > `SHARE_RADIUS` 24。 */
const FAR = 'p9';
const ME_AT = { x: 64, y: 64 };
const FAR_AT = { x: 30, y: 30 };
const CAMP_AT = { x: 90, y: 90 };

const SEED = 189;

/**
 * 一房两玩家的真世界。
 *
 * `mobs: false` 关掉自动刷怪与 AI 推进(那会引入与本套件无关的时序),
 * 但**不动**事件总线、`settleKill`、`damageBoss`、`applyPlayerMove` ——
 * 本套件要观测的正是这几条路。
 *
 * 世界尺寸取 `DESIGN_SIZE`(与生产的设计图世界同一尺寸):草原 (64,64) 与营地
 * (90,90) 都落在世界内,`regionAt` 的设计坐标与世界坐标因此是同一套。
 */
function scene(): { sim: WorldSim; wire: MainlineWiring } {
  const sim = new WorldSim({ sizeCells: DESIGN_SIZE, mobs: false, wiring: false, seed: SEED });
  const wire = attachMainline(sim.bus);
  sim.addPlayer(ME, ME_AT.x, ME_AT.y);
  sim.addPlayer(FAR, FAR_AT.x, FAR_AT.y);
  return { sim, wire };
}

/**
 * 投递当帧事件。
 *
 * **生产里就是这一步**:`WorldSim.tick()` 每帧调一次 `bus.drain()`
 * (`events/bus.ts` 的契约:emit 只入队,drain 才投递)。所以这里用 `tick()`
 * 而不是直接 `bus.drain()` —— 走的是线上真实的那条路。
 */
function deliver(sim: WorldSim): void {
  sim.tick();
}

/** 把一格写上一个物件(底层写口;它**不**发主线事件,所以能隔离被测的那一条)。 */
function putObj(sim: WorldSim, x: number, y: number, objId: number): void {
  sim.setCell(x, y, { obj: objId });
}

/** 打一只怪(真走 `damageMob` → `settleKill`)。返回是否真的打死了。 */
function killMob(sim: WorldSim, id: string, x: number, y: number): boolean {
  sim.addMob(id, 'MEADOW', x, y);
  const r = sim.damageMob(id, 999_999, DamageKind.PHYSICAL, 0);
  return r !== null && r.hpLoss > 0;
}

/** 召唤果冻国王(祭坛在安全区外;祭品由内存 port 提供)。 */
function summonJellyKing(sim: WorldSim): void {
  const r = sim.summonBoss(
    {
      bossId: BOSS_JELLY, itemId: 734, hasAltar: true,
      altarX: 200, altarY: 200, townCenterX: 0, townCenterY: 0,
      playerCount: 1, alreadyAlive: false, ownerId: ME,
    },
    makeMemoryOfferingPort({ [ME]: { 734: 1 } }),
  );
  ok(r.ok, `前置:${BOSS_JELLY} 召唤成功(${r.ok ? '' : r.reason})`);
}

/** 一条主线事件在总线投递日志里的形状。 */
interface MainlineRecord {
  kind: string;
  userId: string | undefined;
  source: string;
  payload: Record<string, number | string | boolean>;
}

/** 取投递日志里全部主线事件(按投递顺序)。 */
function mainlineRecords(sim: WorldSim): MainlineRecord[] {
  const out: MainlineRecord[] = [];
  for (const r of sim.bus.history()) {
    if (!r.event.kind.startsWith('mainline_')) continue;
    out.push({
      kind: r.event.kind,
      userId: typeof r.event.payload.userId === 'string' ? r.event.payload.userId : undefined,
      source: r.event.source,
      payload: r.event.payload,
    });
  }
  return out;
}

/* ══════════════════════ 0. 前置:取样是内容表/设计图的事实 ══════════════════════ */

test('FND189-0 前置:取样 id 的类别、存在性与两个取样点的区,都是冻结表/设计图的事实', () => {
  eq(ITEM_BY_ID.get(NAT_WOOD)?.category, ItemCategory.NATURAL, `#${NAT_WOOD} 必须是自然材料(第 1 步的判据)`);
  eq(ITEM_BY_ID.get(TOOL_AXE)?.category, ItemCategory.TOOL, `#${TOOL_AXE} 必须是工具(第 2 步的判据)`);
  ok(ITEM_BY_ID.has(FLOOR_BRICK), `#${FLOOR_BRICK} 在内容表里(第 3 步只要求在表里)`);
  ok(MOB_BY_ID.has(MOB_BOAR), `${MOB_BOAR} 在生物表里(第 5 步的判据)`);
  ok(BOSS_BY_ID.has(BOSS_JELLY), `${BOSS_JELLY} 在 Boss 表里(第 6 步的判据)`);
  eq(regionAt(ME_AT.x, ME_AT.y), REGION_MEADOW, '前置:起点在草原');
  eq(regionAt(CAMP_AT.x, CAMP_AT.y), REGION_CAMP, '前置:终点在营地');
  eq(regionAt(FAR_AT.x, FAR_AT.y), null, '前置:另一个玩家站在不属于任何区的地方');
  eq(DESIGN_SIZE, 192, '前置:设计图世界边长(坐标口径的锚)');
});

/* ══════════════════════ 1. ★★ 接线真的通了(端到端) ══════════════════════ */

test('FND189-1 ★★ 采集一次自然材料 ⇒ 该玩家 step 1 → 2(WorldSim 的成功点真的发了事件)', () => {
  const { sim, wire } = scene();
  eq(wire.mainlineOf(ME).step, 1, '前置:一步没做');
  eq(wire.mainlineOf(ME).stepId, 'gather');
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.gather), 0, '前置:一条事件都没有');

  putObj(sim, 10, 10, NAT_WOOD);
  const r = sim.breakBlock(10, 10, ME);
  ok(r.ok === true, '前置:这一格的自然材料真的被采掉(成功点)');
  deliver(sim);

  const v = wire.mainlineOf(ME);
  eq(v.step, 2, '★★ 一步真的推进了(修前:没人喂事件 ⇒ 永远停在 1)');
  eq(v.stepId, 'craft', '当前步 = 第 2 步(合成)');
  eq(v.done, false);
  near(v.progress, 1 / 6, 1e-9, '整体进度 1/6');
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.gather), 1, '总线上有且只有一条 gather');
  eq(wire.mainlineOf(FAR).step, 1, '另一个玩家没做任何事 ⇒ 一步没动');
});

/* ══════════════════════ 2. ★★ 六步走完 ⇒ done ══════════════════════ */

test('FND189-2 ★★ 依次做六件事 ⇒ done === true(每条事件都来自一个真成功点)', () => {
  const { sim, wire } = scene();

  /* 1 采集:世界侧成功点 = `breakBlock` */
  putObj(sim, 10, 10, NAT_WOOD);
  eq(sim.breakBlock(10, 10, ME).ok, true, '第 1 步:采集成功');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 2, '第 1 步过(gather)');

  /* 2 合成:模拟层看不见背包 ⇒ 房间侧推来的事实入口 */
  sim.noteCraftSuccess(ME, TOOL_AXE);
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 3, '第 2 步过(craft)');

  /* 3 建造:世界侧成功点 = `placeBlock` */
  eq(sim.placeBlock(20, 20, FLOOR_BRICK, ME).ok, true, '第 3 步:放块成功');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 4, '第 3 步过(place)');

  /* 4 换区:草原 → 营地(生产入口 `applyPlayerMove`) */
  eq(sim.applyPlayerMove(ME, CAMP_AT.x, CAMP_AT.y), true, '第 4 步:移动被接受');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 5, '第 4 步过(enterRegion)');

  /* 5 击杀:怪刷新在玩家身边 1 格(≤ SHARE_RADIUS ⇒ 归属他) */
  ok(killMob(sim, MOB_BOAR_1, CAMP_AT.x, CAMP_AT.y + 1), '第 5 步:击杀成功');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 6, '第 5 步过(kill)');

  /* 6 Boss:血量掉到一半以下 */
  summonJellyKing(sim);
  const snap = sim.bossRaid.snapshot(BOSS_JELLY);
  ok(snap !== undefined, '前置:Boss 在场');
  const hp = snap!.hp;
  ok(
    sim.damageBoss(BOSS_JELLY, hp - Math.floor(snap!.maxHp * 0.3), ME) !== null,
    '第 6 步:Boss 吃到伤害',
  );
  deliver(sim);

  const v = wire.mainlineOf(ME);
  eq(v.done, true, '★★ 六步全通');
  eq(v.step, 6, '全通时停在 6(不越界)');
  near(v.progress, 1, 1e-9, '整体进度 1');
  eq(wire.completedOf(ME), 6);
});

/* ══════════════════════ 3. ★ 分账:两个玩家互不影响 ══════════════════════ */

test('FND189-3 ★ 两个玩家各做一半 ⇒ 两人的状态互不影响', () => {
  const { sim, wire } = scene();

  /* 两人各采一次(各自步数 1 → 2) */
  putObj(sim, 10, 10, NAT_WOOD);
  eq(sim.breakBlock(10, 10, ME).ok, true, 'p1 采集');
  putObj(sim, 11, 10, NAT_WOOD);
  eq(sim.breakBlock(11, 10, FAR).ok, true, 'p9 采集');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 2, 'p1 = 2');
  eq(wire.mainlineOf(FAR).step, 2, 'p9 = 2');

  /* 只有 p1 继续合成 ⇒ p9 必须原地不动 */
  sim.noteCraftSuccess(ME, TOOL_AXE);
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 3, '★ p1 走到第 3 步');
  eq(wire.mainlineOf(FAR).step, 2, '★★ p9 仍是第 2 步(事件按 userId 分账)');
  eq(wire.completedOf(ME), 2);
  eq(wire.completedOf(FAR), 1);

  /* 反向:p1 再击杀一只怪 ⇒ p9 连「击杀事件」都不该收到(距离 85 > 24) */
  ok(killMob(sim, MOB_BOAR_1, ME_AT.x, ME_AT.y + 1), 'p1 身边击杀');
  deliver(sim);
  const killEvents = mainlineRecords(sim).filter((r) => r.kind === MAINLINE_BUS_KIND.kill);
  eq(killEvents.length, 1, '只有一条击杀事件(远处那个玩家不在归属半径里)');
  eq(killEvents[0]!.userId, ME, '它记在 p1 头上');
  eq(wire.mainlineOf(FAR).step, 2, '★★ p9 不受影响');
});

/* ══════════════════════ 4. 负面对照:顺序由状态机管 ══════════════════════ */

test('FND189-4 负面对照:只打怪(没采集)⇒ step 仍是 1 —— 但 kill 事件**确实发出来了**', () => {
  const { sim, wire } = scene();
  ok(killMob(sim, MOB_BOAR_1, ME_AT.x, ME_AT.y + 1), '前置:击杀成功');
  deliver(sim);

  eq(sim.bus.countOf(MAINLINE_BUS_KIND.kill), 1, '击杀事件在总线上(否则下面那条断言就是恒真的空话)');
  eq(mainlineRecords(sim)[0]!.payload.mobId, MOB_BOAR, 'mobId 是**内容层 id**,不是实例 id');
  eq(wire.mainlineOf(ME).step, 1, '★ 只打怪 ⇒ 仍停在第 1 步(跳步无效是状态机的口径)');
  eq(wire.completedOf(ME), 0, '完成步数没动');
});

/* ══════════════════════ 5. 只读口对陌生用户的安全行为 ══════════════════════ */

test('FND189-5 mainlineOf("不存在的用户") 不抛、返回第一步视图、不建档', () => {
  const { sim, wire } = scene();
  eq(wire.size, 0, '前置:还没有任何人推进过');
  const v = wire.mainlineOf('不存在的用户');
  eq(v.step, 1, '第一步');
  eq(v.stepId, 'gather', '第 1 步是采集');
  eq(v.done, false);
  eq(v.progress, 0);
  eq(wire.completedOf('不存在的用户'), 0);
  eq(wire.size, 0, '★ 读一下不会凭空建档(只读口是只读的)');

  /* 空串同样不抛(边界:userId 收窄为空 ⇒ 事件会被丢弃) */
  eq(wire.mainlineOf('').step, 1, '空 userId 也不抛');
  sim.bus.emit(MAINLINE_BUS_KIND.gather, { userId: '', itemId: NAT_WOOD, count: 1 }, 'system');
  deliver(sim);
  eq(wire.size, 0, '空 userId 的事件被丢弃(没有归属就不记账)');
});

/* ══════════════════════ 6. userId 是硬要求 ══════════════════════ */

test('FND189-6 breakBlock 不传 actorId ⇒ 一条主线事件都不发(没有归属就不发)', () => {
  const { sim, wire } = scene();
  putObj(sim, 10, 10, NAT_WOOD);
  const r = sim.breakBlock(10, 10);
  ok(r.ok === true, '前置:不带 actor 的采集照常成功(旧调用点行为不变)');
  ok(!('gatherMul' in r), '前置:回执与接线前逐位相同(没有多余键)');
  deliver(sim);
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.gather), 0, '★ 没有 userId ⇒ 一条都不发');
  eq(wire.mainlineOf(ME).step, 1, 'p1 一步没动');
  eq(wire.size, 0);
});

/* ══════════════════════ 7. 换区:只在 id 真变时发 ══════════════════════ */

test('FND189-7 换区事件只在 regionAt 的 id 真变时发;同一区里走一步不发', () => {
  const { sim } = scene();
  /* 同一区(草原 → 草原) */
  eq(sim.applyPlayerMove(ME, ME_AT.x + 2, ME_AT.y + 2), true, '前置:移动被接受');
  deliver(sim);
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.enterRegion), 0, '★ 同一区里移动 ⇒ 不发');

  /* 跨区(草原 → 营地) */
  eq(sim.applyPlayerMove(ME, CAMP_AT.x, CAMP_AT.y), true, '前置:跨区移动被接受');
  deliver(sim);
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.enterRegion), 1, '★ 真换了区 ⇒ 一条');
  const rec = mainlineRecords(sim).find((r) => r.kind === MAINLINE_BUS_KIND.enterRegion);
  ok(rec !== undefined, '事件在投递日志里');
  eq(rec!.payload.regionId, REGION_CAMP, 'regionId 是 `regionAt` 的返回值');
  eq(rec!.userId, ME, 'userId 是移动的那个玩家');
  eq(rec!.source, ME, 'source 与 userId 同源(诊断也用同一个值)');

  /* 传送(测试/传送入口)走同一个判定 */
  sim.setPlayerPos(ME, ME_AT.x, ME_AT.y);
  deliver(sim);
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.enterRegion), 2, '★ 传送回草原也算换区(setPlayerPos 共用同一判定)');
});

/* ══════════════════════ 8. Boss:阈值不在世界侧 ══════════════════════ */

test('FND189-8 Boss:世界侧不判阈值(0.92 也发一条),掉到 ≤ 0.5 才推进', () => {
  const { sim, wire } = scene();
  /* 把玩家推到第 6 步之前的第 6 步位置:前五步走完(用真事件走,不直接改状态) */
  putObj(sim, 10, 10, NAT_WOOD);
  sim.breakBlock(10, 10, ME);
  sim.noteCraftSuccess(ME, TOOL_AXE);
  sim.placeBlock(20, 20, FLOOR_BRICK, ME);
  sim.applyPlayerMove(ME, CAMP_AT.x, CAMP_AT.y);
  ok(killMob(sim, MOB_BOAR_1, CAMP_AT.x, CAMP_AT.y + 1), '前置:击杀');
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 6, '前置:停在第 6 步(Boss)');

  summonJellyKing(sim);
  const snap = sim.bossRaid.snapshot(BOSS_JELLY)!;
  /* 只掉 8%:比例 0.92 > 0.5 ⇒ 事件照发,但状态机不该推进 */
  ok(sim.damageBoss(BOSS_JELLY, Math.round(snap.maxHp * 0.08), ME) !== null, '前置:打到一点伤害');
  deliver(sim);
  const first = mainlineRecords(sim).filter((r) => r.kind === MAINLINE_BUS_KIND.bossProgress);
  eq(first.length, 1, '★ 0.92 也发了一条(世界侧只报事实,不判阈值)');
  ok(Number(first[0]!.payload.hpRatio) > 0.5, `第一条的比例 > 0.5(实际 ${first[0]!.payload.hpRatio})`);
  eq(wire.mainlineOf(ME).step, 6, '★ 还没掉到一半 ⇒ 第 6 步不算过');

  /* 打到 0.3 ⇒ 这一步才过 */
  const now = sim.bossRaid.snapshot(BOSS_JELLY)!;
  ok(
    sim.damageBoss(BOSS_JELLY, now.hp - Math.floor(now.maxHp * 0.3), ME) !== null,
    '前置:继续打到 0.3',
  );
  deliver(sim);
  eq(wire.mainlineOf(ME).done, true, '★★ 掉到一半以下才推进到全通');
  const second = mainlineRecords(sim).filter((r) => r.kind === MAINLINE_BUS_KIND.bossProgress);
  eq(second.length, 2, '两次伤害两条事件(不去重 —— 去重是状态机按「当前步」判的)');
  ok(Number(second[1]!.payload.hpRatio) <= 0.5, '第二条的比例 ≤ 0.5');
});

/* ══════════════════════ 9. 事件形状(协议一处持有) ══════════════════════ */

test('FND189-9 六类事件的 kind / payload / source 与协议唯一持有者逐字段一致', () => {
  const { sim } = scene();
  putObj(sim, 10, 10, NAT_WOOD);
  sim.breakBlock(10, 10, ME);
  sim.noteCraftSuccess(ME, TOOL_AXE);
  sim.placeBlock(20, 20, FLOOR_BRICK, ME);
  sim.applyPlayerMove(ME, CAMP_AT.x, CAMP_AT.y);
  ok(killMob(sim, MOB_BOAR_1, CAMP_AT.x, CAMP_AT.y + 1), '击杀');
  summonJellyKing(sim);
  const snap = sim.bossRaid.snapshot(BOSS_JELLY)!;
  sim.damageBoss(BOSS_JELLY, Math.round(snap.maxHp * 0.2), ME);
  deliver(sim);

  eq(
    Object.values(MAINLINE_BUS_KIND).sort().join(','),
    'mainline_boss_progress,mainline_craft,mainline_enter_region,mainline_gather,mainline_kill,mainline_place',
    '六个事件名(改名会让订阅端与生产端一起漂,这条把名字钉住)',
  );

  const recs = mainlineRecords(sim);
  eq(recs.length, 6, `六条事件各一条(实际 ${recs.length}:${recs.map((r) => r.kind).join(', ')}`);
  const byKind = new Map(recs.map((r) => [r.kind, r]));
  {
    const r = byKind.get(MAINLINE_BUS_KIND.gather)!;
    eq(r.payload.itemId, NAT_WOOD, 'gather.itemId = 那一格被取走的 obj');
    eq(r.payload.count, 1, 'gather.count = 1(件数放大在动作层)');
  }
  eq(byKind.get(MAINLINE_BUS_KIND.craft)!.payload.itemId, TOOL_AXE, 'craft.itemId = 产物');
  eq(byKind.get(MAINLINE_BUS_KIND.place)!.payload.objId, FLOOR_BRICK, 'place.objId = 放下的物件');
  eq(byKind.get(MAINLINE_BUS_KIND.enterRegion)!.payload.regionId, REGION_CAMP, 'enterRegion.regionId');
  eq(byKind.get(MAINLINE_BUS_KIND.kill)!.payload.mobId, MOB_BOAR, 'kill.mobId(内容层 id)');
  {
    const r = byKind.get(MAINLINE_BUS_KIND.bossProgress)!;
    eq(r.payload.bossId, BOSS_JELLY, 'bossProgress.bossId');
    ok(Number(r.payload.hpRatio) <= 1, 'bossProgress.hpRatio ∈ [0,1]');
    /* 与 Boss 运行时**自己报的**比例逐位相同(同一个数,不是两处各算一遍)。 */
    near(Number(r.payload.hpRatio), sim.bossRaid.snapshot(BOSS_JELLY)!.hpRatio, 1e-9, '比例与 Boss 快照同一个数');
  }
  /* 六条都带**同一个** userId,且 source 与它同源(诊断与分账不许分叉) */
  for (const r of recs) {
    eq(r.userId, ME, `${r.kind} 的 payload.userId`);
    eq(r.source, ME, `${r.kind} 的 source`);
  }
  eq(sim.bus.snapshot().totals.errors, 0, '零处理器抛错');
});

/* ══════════════════════ 10. detach:订阅器是唯一入口 ══════════════════════ */

test('FND189-10 detach() 之后事件不再推进(订阅器是唯一入口)', () => {
  const { sim, wire } = scene();
  putObj(sim, 10, 10, NAT_WOOD);
  sim.breakBlock(10, 10, ME);
  deliver(sim);
  eq(wire.mainlineOf(ME).step, 2, '前置:推进到第 2 步');

  wire.detach();
  eq(wire.size, 0, '账本被清空');
  putObj(sim, 11, 10, NAT_WOOD);
  sim.breakBlock(11, 10, ME);
  deliver(sim);
  eq(sim.bus.countOf(MAINLINE_BUS_KIND.gather), 2, '事件照发(世界侧不受影响)');
  eq(wire.mainlineOf(ME).step, 1, '★ 没人订阅 ⇒ 状态不推进(退回到第一步视图,不抛)');
});

/* ══════════════════════ 有牙实证(改坏实现 ⇒ 判据真变红) ══════════════════════
 *
 * 三处变异各跑一遍,输出原文如下;三处都已**逐字还原**(还原后本套件 11/11,
 * 且 `git diff` 里没有残留的变异行)。
 *
 * ### 1 摘掉订阅:`quests/mainline_wiring.ts` 的 `bus.on(MAINLINE_BUS_KIND.gather, feed)` 删掉
 *
 * ```text
 * ✗ FND189-1 ★★ 采集一次自然材料 ⇒ 该玩家 step 1 → 2 — ★★ 一步真的推进了 … 期望 2 / 实际 1
 * ✗ FND189-2 ★★ 依次做六件事 ⇒ done === true — 第 1 步过(gather) 期望 2 / 实际 1
 * ✗ FND189-3 ★ 两个玩家各做一半 ⇒ 两人的状态互不影响 — p1 = 2 期望 2 / 实际 1
 * ✗ FND189-8 Boss:世界侧不判阈值(0.92 也发一条)… — 前置:停在第 6 步(Boss) 期望 6 / 实际 1
 * ✗ FND189-10 detach() 之后事件不再推进 — 前置:推进到第 2 步 期望 2 / 实际 1
 * [WS-FND-189-mainline-wiring] 6/11 通过
 * ```
 * ⇒ **第一条判据就是「接线通了」的硬证据**:订阅一摘,它当场变红。
 *
 * ### 2 分账写死:`mainline_wiring.ts#attachMainline` 里把 `userId` 换成常量 `'p1'`
 *
 * ```text
 * ✗ FND189-3 ★ 两个玩家各做一半 ⇒ 两人的状态互不影响 — p9 = 2 期望 2 / 实际 1
 * [WS-FND-189-mainline-wiring] 10/11 通过
 * ```
 * ⇒ 「按 userId 分账」这一条真的有牙:所有事件记到同一个人身上,p9 立刻回到 1。
 *
 * ### 3 换区判定:`world_sim.ts#emitRegionChange` 去掉 `after === before`(每次移动都发)
 *
 * ```text
 * ✗ FND189-7 换区事件只在 regionAt 的 id 真变时发 — ★ 同一区里移动 ⇒ 不发 期望 0 / 实际 1
 * [WS-FND-189-mainline-wiring] 10/11 通过
 * ```
 *
 * 还原后:`node --experimental-strip-types tests/WS-FND-189-mainline-wiring.test.ts`
 * ⇒ `[WS-FND-189-mainline-wiring] 11/11 通过`。
 */

report('WS-FND-189-mainline-wiring');
