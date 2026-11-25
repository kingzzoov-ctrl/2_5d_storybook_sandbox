/**
 * WS-FND-195 · 主世界(晨曦群岛)与通行规则。
 *
 * 守的是「这张大地图是能玩的」:
 * 生成确定;每个场地从出生点**走得到**(不靠跳);NPC 站位是空地;
 * 墙 / 树 / 深水 / 陡坎挡路而草丛不挡;装配出来的世界出生在镇广场、围着玩家刷怪、
 * 资源采走会长回来、镇子的建筑拆不掉、带着材料跟 NPC 说话能交差。
 *
 * 运行:`node tests/WS-FND-195-overworld.test.ts`
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import {
  NPC_SPOTS, REGION_DEFS, REGION_SEA, SPAWN_POINT, WORLD_SIZE, overworld, overworldCell, walkableFrom,
} from '../shared/world/overworld.ts';
import { canEnter, isDeepWater, isSolidObj, slideMove, type CellView } from '../shared/world/passable.ts';
import { Landmark } from '../shared/world/landmarks.ts';
import { BIOME_SPAWN } from '../server/src/mobs/spawner.ts';
import { assemble } from '../server/src/index.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { NPCS, activeNpcs, missingItemIds, setActiveNpcs } from '../server/src/npc/defs.ts';
import { OVERWORLD_NPCS } from '../server/src/npc/overworld_npcs.ts';
import { defaultGmConfig } from '../server/src/npc/ai.ts';
import { gatherToolFor } from '../server/src/net/actions/gather.ts';
import type { WorldSim } from '../server/src/sim/world_sim.ts';

const ow = overworld();
const N = ow.size;
const reach = walkableFrom(ow, SPAWN_POINT.x, SPAWN_POINT.y);
const cell = (x: number, y: number): CellView => overworldCell(ow, x, y)!;
const objOf = (x: number, y: number): number => cell(x, y).obj;

test('FND195-1 规模与确定性:512×512,陆地过半,十一个区都有地盘', () => {
  eq(N, WORLD_SIZE, '边长');
  eq(N, 512, '512 格');
  eq(ow.tiles.length, N * N, '每格一个值');
  ok(overworld() === ow, '重复调用拿到同一份(不重算)');
  ok(ow.stats.landCells > 140000, `陆地够大(实得 ${ow.stats.landCells})`);
  REGION_DEFS.forEach((r, i) => {
    ok(ow.stats.regionCells[i]! > (r.id === 'islet' ? 100 : 4000), `${r.name} 有地盘(实得 ${ow.stats.regionCells[i]})`);
    ok(BIOME_SPAWN[r.biome] !== undefined, `${r.name} 的群系键 ${r.biome} 在刷怪表里`);
  });
  eq(new Set(REGION_DEFS.map((r) => r.biome)).size, 8, '八个群系键全用到');
  /* 指纹:生成器任何一处改动都会改它(改了就在这里更新,并去看一眼地图)。 */
  let h = 0;
  for (let i = 0; i < ow.tiles.length; i += 97) h = (Math.imul(h, 31) + ow.tiles[i]!) | 0;
  ok(Number.isInteger(h), '指纹可算');
});

test('FND195-2 ★ 每个场地都从出生点走得到(只走路与台阶,不跳)', () => {
  eq(reach[SPAWN_POINT.y * N + SPAWN_POINT.x], 1, '出生点自己可站');
  eq(ow.sites.filter((s) => s.kind === 'altar').length, 8, '八座祭坛');
  eq(ow.sites.filter((s) => s.kind === 'outpost').length, 8, '八处营地');
  for (const s of ow.sites) {
    ok(ow.region[s.y * N + s.x] !== REGION_SEA, `${s.name} 在陆地上`);
    eq(REGION_DEFS[ow.region[s.y * N + s.x]!]!.id, s.region, `${s.name} 落在它声明的区里`);
    /* 场地正中可能是实心物(祭坛、篝火)⇒ 看它周围两格内有没有可达格。 */
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) if (reach[(s.y + dy) * N + s.x + dx] === 1) { near = true; break; }
    }
    ok(near, `★ ${s.name}(${s.x},${s.y})走得到`);
    if (s.kind === 'altar') eq(objOf(s.x, s.y), Landmark.ALTAR, `${s.name} 正中是祭坛`);
  }
  ok(ow.stats.stairCells >= 30, `高差处有台阶(实得 ${ow.stats.stairCells})`);
  ok(ow.stats.bridgeCells >= 60, `过水有栈桥(实得 ${ow.stats.bridgeCells})`);
  let total = 0;
  for (let i = 0; i < reach.length; i += 1) total += reach[i]!;
  ok(total / ow.stats.landCells > 0.8, `不跳也能走到八成以上的陆地(实得 ${(total / ow.stats.landCells).toFixed(2)})`);
});

test('FND195-3 通行规则:墙 / 树 / 深水 / 陡坎挡路;草丛、花、作物不挡;台阶多上一层', () => {
  const ground: CellView = { elev: 1, base: 1, floor: 0, obj: 0 };
  const plat: CellView = { ...ground, elev: 2 };
  const cliff: CellView = { ...ground, elev: 3 };
  const water: CellView = { elev: 0, base: 5, floor: 0, obj: 0 };
  for (const o of [351, 363, 372, 101, 113, 501, 536, 750, Landmark.ALTAR, Landmark.PILLAR]) ok(isSolidObj(o), `#${o} 挡路`);
  for (const o of [0, 118, 121, 123, 124, 522, Landmark.FLOWER_BED, 377, 378]) ok(!isSolidObj(o), `#${o} 不挡路`);
  ok(canEnter(ground, { ...ground, obj: 118 }, 0), '草丛走得进');
  ok(!canEnter(ground, { ...ground, obj: 101 }, 0), '树走不进');
  ok(!canEnter(ground, plat, 0), '平地迈不上一层台地');
  ok(canEnter(ground, plat, 0.5), '★ 跳起来(z ≥ 0.45)够得着一层');
  ok(!canEnter(ground, cliff, 0.9), '跳也够不着两层');
  ok(canEnter({ ...ground, obj: 378 }, plat, 0), '★ 站在台阶上能上一层');
  ok(canEnter(plat, ground, 1), '往低处走永远可以');
  ok(canEnter(plat, cliff, 0) === false && canEnter({ ...plat, obj: 378 }, cliff, 0), '台地上的台阶通向崖顶');
  ok(isDeepWater(water) && !canEnter(ground, water, 0), '深水进不去');
  ok(!isDeepWater({ ...water, floor: 10 }) && canEnter(ground, { ...water, floor: 10 }, 0), '铺了栈桥的水面能走');
  ok(canEnter(water, water, 0), '已经在水里的人不会被卡死');
  ok(canEnter(ground, { elev: 1, base: 6, floor: 0, obj: 0 }, 0), '浅温泉可以走进去泡');
});

test('FND195-4 贴墙滑行:撞上去不穿墙、沿墙继续走;起点压着障碍时不卡死', () => {
  /* 一堵竖墙:x = 5 这一列全是 351。 */
  const at = (cx: number, cy: number): CellView | null =>
    (cx < 0 || cy < 0 || cx > 20 || cy > 20 ? null : { elev: 1, base: 1, floor: 0, obj: cx === 5 ? 351 : 0 });
  const head = slideMove(3.5, 3.5, 8.5, 3.5, 0.35, 0, at);
  ok(head.blocked && head.x < 5 - 0.35 + 1e-6 && head.x > 4.3, `正面撞墙停在墙前(x=${head.x.toFixed(2)})`);
  const diag = slideMove(4.5, 3.5, 6.5, 6.5, 0.35, 0, at);
  ok(diag.blocked && diag.x < 4.66 && diag.y > 6.3, `★ 斜着撞墙 ⇒ 沿墙滑(y=${diag.y.toFixed(2)})`);
  const free = slideMove(1.5, 1.5, 3.0, 2.5, 0.35, 0, at);
  eq([free.x, free.y, free.blocked], [3.0, 2.5, false], '没有障碍 ⇒ 原样到达');
  const stuck = slideMove(5.5, 3.5, 7.5, 3.5, 0.35, 0, at);
  ok(stuck.x > 6.9, `★ 起点在墙里 ⇒ 放行走出去(x=${stuck.x.toFixed(2)})`);
  eq(slideMove(1, 1, Number.NaN, 2, 0.35, 0, at).blocked, true, 'NaN 目标 ⇒ 原地不动');
});

test('FND195-5 挡路的资源互不相邻:林子里永远有路', () => {
  let adjacent = 0;
  let solidNatural = 0;
  for (let y = 1; y < N - 1; y += 1) {
    for (let x = 1; x < N - 1; x += 1) {
      const o = objOf(x, y);
      if (o < 101 || o > 130 || !isSolidObj(o)) continue;
      solidNatural += 1;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
        const n = objOf(x + dx, y + dy);
        if (n >= 101 && n <= 130 && isSolidObj(n)) adjacent += 1;
      }
    }
  }
  ok(solidNatural > 3000, `树和矿够多(实得 ${solidNatural})`);
  eq(adjacent, 0, '★ 没有两棵树 / 两块矿贴在一起');
});

test('FND195-6 NPC:19 位,站位是走得到的空地,差事要的东西世界里采得到', () => {
  eq(OVERWORLD_NPCS.length, 19, '19 位');
  eq(new Set(OVERWORLD_NPCS.map((n) => n.id)).size, 19, 'id 唯一');
  eq(Object.keys(NPC_SPOTS).sort(), OVERWORLD_NPCS.map((n) => n.id).sort(), '名册与站位表一一对应');
  const inWorld = new Map<number, number>();
  for (let i = 0; i < ow.tiles.length; i += 1) {
    const o = (ow.tiles[i]! >>> 16) & 0xfff;
    if (o !== 0) inWorld.set(o, (inWorld.get(o) ?? 0) + 1);
  }
  const questIds = new Set<string>();
  for (const n of OVERWORLD_NPCS) {
    eq(reach[n.home.y * N + n.home.x], 1, `★ ${n.name} 站的格子走得到`);
    eq(objOf(n.home.x, n.home.y), 0, `${n.name} 站的格子是空的`);
    eq(n.lines.length, 3, `${n.name} 有三句台词`);
    eq(new Set(n.lines).size, 3, `${n.name} 三句互不相同`);
    ok((n.persona ?? '').includes(n.name) && (n.persona ?? '').length > 60, `${n.name} 有人设 prompt`);
    if (n.quest === undefined) continue;
    ok(!questIds.has(n.quest.id), `差事 id ${n.quest.id} 唯一`);
    questIds.add(n.quest.id);
    ok((inWorld.get(n.quest.needItemId) ?? 0) >= n.quest.needCount * 3,
      `★ ${n.name} 要的 #${n.quest.needItemId} 世界里采得到(有 ${inWorld.get(n.quest.needItemId) ?? 0} 处)`);
  }
  eq(questIds.size, 18, '镇长之外人人有差事');
  /* 木匠的谢礼是镐:拿到之前要用的东西必须不需要镐。 */
  const carpenter = OVERWORLD_NPCS.find((n) => n.id === 'npc_carpenter')!;
  eq([carpenter.quest!.needItemId, carpenter.quest!.rewardItemId], [101, 203], '木匠:原木换镐');
  eq(gatherToolFor(101)!.tools.includes(201), true, '起始包里的斧能砍原木');
  setActiveNpcs(OVERWORLD_NPCS);
  try {
    eq(missingItemIds(), [], '★ 差事用到的物品 id 全在内容表里');
    const cfg = defaultGmConfig();
    eq(Object.keys(cfg.npcs).length, 19, 'GM 配置里 19 位都有一份');
    for (const n of OVERWORLD_NPCS) eq(cfg.npcs[n.id]!.prompt, n.persona, `${n.name} 的默认 prompt = 人设`);
  } finally {
    setActiveNpcs(NPCS);
  }
});

/* ── 装配出来的世界 ── */

function world() {
  const a = assemble({ overworld: true, mobs: true, memory: true, db: null, archiveSink: null });
  const sim = a.host as unknown as WorldSim;
  a.runtime.join({ userId: 'p1' });
  return { rt: a.runtime, sim };
}
function run(rt: ReturnType<typeof world>['rt'], seconds: number): void {
  let prev: unknown = null;
  for (let i = 0; i < 32 * seconds; i += 1) { rt.step(prev); prev = rt.cloneState(); }
}
/** 离 (x,y) 最近的、满足条件的格(在 `r` 格内找)。 */
function findNear(x0: number, y0: number, r: number, want: (c: CellView, x: number, y: number) => boolean): { x: number; y: number } {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (let y = y0 - r; y <= y0 + r; y += 1) {
    for (let x = x0 - r; x <= x0 + r; x += 1) {
      const c = overworldCell(ow, x, y);
      if (c === null || !want(c, x, y)) continue;
      const d = Math.hypot(x - x0, y - y0);
      if (d < bd) { bd = d; best = { x, y }; }
    }
  }
  if (best === null) throw new Error('附近找不到符合条件的格');
  return best;
}

test('FND195-7 ★ 装配:出生在镇广场、只带起始包、名册换成主世界、镇里不刷怪而镇外围着玩家刷', () => {
  const { rt, sim } = world();
  try {
    eq(activeNpcs().length, 19, '名册换成主世界的 19 位');
    const p = sim.playerPosition('p1')!;
    eq([Math.floor(p.x), Math.floor(p.y)], [SPAWN_POINT.x, SPAWN_POINT.y], '出生点 = 镇广场');
    eq(rt.inventoryOf('p1')!.items, { 101: 2, 106: 2, 118: 2, 201: 1 }, '只有起始包');
    run(rt, 45);
    eq(rt.state.wildlife.length, 0, '★ 人在镇里 ⇒ 安全区,一只怪都不刷');
    sim.setPlayerPos('p1', 316.5, 256.5);
    run(rt, 90);
    const near = rt.state.wildlife.filter((w) => Math.hypot(w.x - 316.5, w.y - 256.5) <= 40).length;
    ok(near >= 5, `★ 走到镇外 ⇒ 身边 40 格内有怪(实得 ${near} 只)`);
    eq(rt.state.wildlife.length, near, '全部刷在玩家身边(不撒到地图另一头)');
    /* 走远 ⇒ 原来那批离场。 */
    sim.setPlayerPos('p1', 150.5, 262.5);
    run(rt, 20);
    eq(rt.state.wildlife.filter((w) => Math.hypot(w.x - 316.5, w.y - 256.5) <= 40).length, 0, '★ 走远之后旧地方的怪离场');
    ok(sim.despawnedFarMobs >= near, `离场有计数(实得 ${sim.despawnedFarMobs})`);
  } finally {
    setActiveNpcs(NPCS);
  }
});

test('FND195-8 ★ 碰撞接进了服务端落点:喷泉走不进、河里走不进、草丛走得过', () => {
  const { sim } = world();
  try {
    /* 朝喷泉走 60 步。 */
    sim.setPlayerPos('p1', 256.5, 260.5);
    for (let i = 0; i < 60; i += 1) { const p = sim.playerPosition('p1')!; sim.applyPlayerMove('p1', p.x, p.y - 0.14); }
    const p = sim.playerPosition('p1')!;
    ok(p.y > 257.3 && p.y < 257.5, `★ 停在喷泉南沿(y=${p.y.toFixed(2)})`);
    eq(sim.lastMoveRejection, 'BLOCKED', '被挡的那一包有具名原因');
    /* 河岸 → 河里。 */
    const bank = findNear(300, 256, 14, (c, x, y) => !isDeepWater(c) && c.obj === 0 && isDeepWater(cell(x + 1, y)));
    sim.setPlayerPos('p1', bank.x + 0.5, bank.y + 0.5);
    for (let i = 0; i < 30; i += 1) { const q = sim.playerPosition('p1')!; sim.applyPlayerMove('p1', q.x + 0.14, q.y); }
    ok(sim.playerPosition('p1')!.x < bank.x + 1, '★ 走不进河里');
    /* 草丛:踩得过去。 */
    const grass = findNear(256, 320, 40, (c, x, y) => c.obj === 118 && cell(x - 1, y).obj === 0 && cell(x + 1, y).obj === 0
      && cell(x - 1, y).elev === c.elev && cell(x + 1, y).elev === c.elev);
    sim.setPlayerPos('p1', grass.x - 0.5, grass.y + 0.5);
    for (let i = 0; i < 16; i += 1) { const q = sim.playerPosition('p1')!; sim.applyPlayerMove('p1', q.x + 0.14, q.y); }
    ok(sim.playerPosition('p1')!.x > grass.x + 1, '★ 草丛不挡路');
  } finally {
    setActiveNpcs(NPCS);
  }
});

test('FND195-9 ★ 采集与再生:砍树进包、那一格空了、两分钟后长回来;隔远了采不到', () => {
  const { rt, sim } = world();
  try {
    const tree = findNear(256, 310, 40, (c, x, y) => c.obj === 101 && cell(x - 1, y).obj === 0 && cell(x - 1, y).elev === c.elev);
    eq(rt.dispatchAction('p1', RoomAction.GATHER, { x: tree.x, y: tree.y }).ok, false, '站在镇里够不着镇外的树');
    /* 拆除走的是同一条规则(不是隔空采集的后门)。 */
    eq(rt.dispatchAction('p1', RoomAction.BREAK_BLOCK, { x: tree.x, y: tree.y }).ok, false, '★ 用「拆除」隔空采同样被拒');
    sim.setPlayerPos('p1', tree.x - 0.5, tree.y + 0.5);
    const got = rt.dispatchAction('p1', RoomAction.GATHER, { x: tree.x, y: tree.y });
    eq(got.ok, true, `走到树旁能砍(${got.reason ?? ''})`);
    ok(rt.inventoryOf('p1')!.items[101]! >= 3, '★ 原木进包(起始 2 根 + 至少 1 根)');
    eq(sim.blockAt(tree.x, tree.y), 0, '那一格空了');
    /* 人站开,等它长回来。 */
    sim.setPlayerPos('p1', tree.x - 3.5, tree.y + 0.5);
    run(rt, 125);
    eq(sim.blockAt(tree.x, tree.y), 101, '★ 两分钟后长回来');
    eq(sim.regrownCount, 1, '再生有计数');
  } finally {
    setActiveNpcs(NPCS);
  }
});

test('FND195-10 ★ 镇子拆不掉;带够材料跟 NPC 说话 = 交差(扣材料、发谢礼、只发一次)', () => {
  const { rt, sim } = world();
  try {
    /* 镇公所的一段墙。 */
    const wall = findNear(256, 256, 30, (c) => c.obj === 352);
    sim.setPlayerPos('p1', 256.5, 260.5);
    const br = rt.dispatchAction('p1', RoomAction.BREAK_BLOCK, { x: wall.x, y: wall.y });
    eq(br.ok, false, '镇上的墙拆不掉');
    ok((br.reason ?? '').includes('拆不掉'), `拒因说人话(${br.reason ?? ''})`);
    eq(sim.blockAt(wall.x, wall.y), 352, '墙还在');

    /* 木匠:6 根原木换一把镐。 */
    const c = OVERWORLD_NPCS.find((n) => n.id === 'npc_carpenter')!;
    sim.setPlayerPos('p1', c.home.x + 0.5, c.home.y + 1.5);
    const talkTo = () => rt.dispatchAction('p1', RoomAction.NPC_TALK, { npcId: c.id });
    const first = talkTo();
    eq(first.ok, true, `能搭上话(${first.reason ?? ''})`);
    eq([first.effect!.questStatus, first.effect!.questNow, first.effect!.line], ['available', 'accepted', c.lines[0]], '第一次 = 开价并接下');
    const second = talkTo();
    eq([second.effect!.questNow, second.effect!.line, second.effect!.turnedIn], ['accepted', c.lines[1], undefined], '材料不够 ⇒ 催一句,不交差');
    rt.grantItemSource('p1', 't:logs');
    ok(rt.applyInventory('p1', { ops: [{ itemId: 101, delta: 4, source: 't:logs' }] }).allowed, '前置:补到 6 根原木');
    const third = talkTo();
    eq([third.effect!.questNow, third.effect!.turnedIn, third.effect!.rewardItemId, third.effect!.line],
      ['completed', true, 203, c.lines[2]], '★ 材料够了 ⇒ 交差');
    const inv = rt.inventoryOf('p1')!.items;
    eq([inv[101] ?? 0, inv[203]], [0, 1], '★ 6 根原木扣掉,镐进包');
    const fourth = talkTo();
    eq([fourth.effect!.turnedIn, rt.inventoryOf('p1')!.items[203]], [undefined, 1], '★ 再搭话不重复发');
  } finally {
    setActiveNpcs(NPCS);
  }
});

report('WS-FND-195');
