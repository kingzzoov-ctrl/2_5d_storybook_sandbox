/**
 * WS-FND-185 —— **群系按格刷怪**(2026-11-26)。
 *
 * ## 修前是什么样
 * 群系是**整图一个**(`WorldSim.biomeName`),`trySpawnOne(biome)` 拿它当入参 ⇒
 * 无论怪刷在哪一格,候选名单都是同一个 `spawnableMobs(biome)`。而设计图
 * (`shared/world/design.ts`)早就声明了每块地属于哪个群系(`REGION_BIOME`,12 区 → 8 群系)
 * ⇒ 那 8 个群系里,除世界默认的那个以外**永远不会出现在世界上**。
 *
 * 这个缺陷之所以能长期存在,是因为它**不报错**:
 * ```text
 * BIOME_SPAWN[biome]            ← 键错/缺
 * decideSpawn: cfg = BIOME_SPAWN[ctx.biome] ?? BIOME_SPAWN.MEADOW   ← 静默兜底
 * ```
 * 症状只是"全图刷同一批怪",而没有任何一条现成读数能显示它。
 *
 * ## 本套件钉的是什么
 *
 * | # | 断言 | 注入验证(改坏哪一处会红) |
 * | :--- | :--- | :--- |
 * | 1 | 设计图 8 个群系都出现,且每个都有可刷名单 | `REGION_BIOME` 里改错一个群系键 |
 * | 2 | 每个群系的物种 ⊆ `spawnableMobs(该群系)`(逐群系) | `trySpawnOne` 里 `biome` 退回 `fallbackBiome` |
 * | 3 | 不同群系出现**不同物种**(不是"都刷同一种") | 同上 |
 * | 4 | 海上/未分区 ⇒ 兜底**世界默认群系**(默认 MEADOW) | 兜底改成 `'RUINS'` 之类 |
 * | 5 | `biomeHistogram()` 非空、键 ⊆ 8 群系、总数 == 存活数、与按格重算逐群系相等 | 直方图改成按 `def.biome` 统计 |
 * | 6 | ★ 常量 `'MEADOW'` 的实现在这批观测上**必然**选错(有牙实证) | —— 这条本身就是"坏实现会红"的证明 |
 * | 7 | `biomeOfCell` 与 `biomeAt` 一致(floor 语义)、稳定、只读 | `biomeOfCell` 改用 `Math.round` |
 * | 8 | `biome: 'DESSERT'` 的世界里区外格刷 DESSERT 物种(兜底听世界默认值) | 兜底写成字面量 `'MEADOW'` |
 *
 * ## ⚠️ 为什么「期望」不调用 `biomeOfCell`
 * 第 2/6 条的期望由**测试自己**用 `biomeAt` + 世界默认群系算出来。若两边都调
 * `biomeOfCell`,实现改了函数语义时两边一起漂移 ⇒ 断言恒真(自证)。
 *
 * ## 为什么用 `anchorX/anchorY` 而不是 `x/y`
 * 怪会走(`MOB_AI_RATE_HZ` 推进 FSM)。拿**当前**坐标回查群系会读到"它走到的那个区",
 * 而不是"它被刷在哪个区" ⇒ 会假红。`MobHost.addMob` 把 `anchorX/anchorY` 记成
 * **入册坐标**(= 刷怪点),它不随后续移动改变。
 *
 * 运行:`node tests/WS-FND-185-biome-spawn.test.ts`
 */

import { test, ok, eq, report, mulberry32 } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { biomeAt, regionAt, BIOME_KEYS, DESIGN_SIZE, REGION_BIOME } from '../shared/world/design.ts';
import { BIOME_SPAWN, spawnableMobs } from '../server/src/mobs/spawner.ts';

/** 只声明本套件真正用到的世界能力(不是 `any`;理由同 `WS-FND-19` 的 `SimLike`)。 */
type MobRt = {
  id: string;
  def: { id: string; biome: string };
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  alive: boolean;
};
type SimLike = {
  biomeOfCell(x: number, y: number): string;
  biomeHistogram(): Record<string, number>;
  mobHost: { runtimes(): MobRt[] };
};

/** 一只被观测到的野生物:**刷怪格** + 物种 + 该格在设计图上的区/群系。 */
interface Obs {
  id: string;
  species: string;
  /** 物种自报的群系(`MobDef.biome`,来自 `mobsByBiome`)。 */
  speciesBiome: string;
  ax: number;
  ay: number;
  /** `regionAt(刷怪格)`;`null` = 海上 / 未分区。 */
  region: string | null;
  /** 按**设计图 + 世界默认群系**算出的期望群系(测试自己算,不调 `biomeOfCell`)。 */
  cellBiome: string;
}

interface RunResult {
  sim: SimLike;
  obs: Obs[];
  alive: number;
  hist: Record<string, number>;
}

const MEADOW_ROSTER = new Set(spawnableMobs('MEADOW').map((m) => m.id));

/**
 * 造一个**盖过设计图的 192×192 世界**跑 `frames` 帧,回收每只活怪的刷怪格与物种。
 *
 * 全部走生产装配入口 `assemble()`(测试手动拼世界 = 本仓「测试全绿、生产零消费」的成因)。
 * `rng` 固定种子 ⇒ 同一组参数完全可复现(不是抽样式断言)。
 */
function run(opts: { seed: number; frames: number; biome?: string }): RunResult {
  const fallback = opts.biome ?? 'MEADOW';
  const a = assemble({
    roomId: 'r_biome185',
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    sizeCells: DESIGN_SIZE,
    mobs: true,
    design: true,
    worldSeed: opts.seed,
    rng: mulberry32(opts.seed),
    ...(opts.biome === undefined ? {} : { biome: opts.biome }),
  });
  a.runtime.join({ userId: 'u_owner' });
  for (let i = 0; i < opts.frames; i += 1) a.runtime.step(null);

  const sim = a.host as unknown as SimLike;
  const obs: Obs[] = sim.mobHost.runtimes()
    .filter((r) => r.alive)
    .map((r) => {
      const cx = Math.floor(r.anchorX);
      const cy = Math.floor(r.anchorY);
      const region = regionAt(cx, cy);
      return {
        id: r.id,
        species: r.def.id,
        speciesBiome: r.def.biome,
        ax: cx,
        ay: cy,
        region,
        cellBiome: biomeAt(cx, cy) ?? fallback,
      };
    });
  return { sim, obs, alive: obs.length, hist: sim.biomeHistogram() };
}

/** 按群系分组后的物种名单(值 = 去重后的物种)。 */
function speciesByBiome(obs: readonly Obs[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const o of obs) {
    const set = out.get(o.cellBiome) ?? new Set<string>();
    set.add(o.species);
    out.set(o.cellBiome, set);
  }
  return new Map([...out].map(([b, s]) => [b, [...s].sort()]));
}

/* 主世界:默认群系(MEADOW)+ 20000 帧。20000 帧 ≈ 2.8 分钟世界时间 ⇒ 设计图上
   **8 个区**都能被随机刷怪点到(实测 seed 11:8/8,见第 2 条的消息)。 */
const MAIN = run({ seed: 11, frames: 20000 });

/* ───────────────────────── 1 ───────────────────────── */

test('FND185-1 设计图声明了每格群系:8 个群系键都出现,且每个都有可刷名单', () => {
  const seen = new Set<string>();
  for (let y = 0; y < DESIGN_SIZE; y += 1) {
    for (let x = 0; x < DESIGN_SIZE; x += 1) {
      const b = biomeAt(x, y);
      if (b !== null) seen.add(b);
    }
  }
  eq(seen.size, BIOME_KEYS.length,
    `设计图应覆盖全部 ${BIOME_KEYS.length} 个群系,实测 ${seen.size} 个:[${[...seen].sort().join('/')}]`);
  for (const k of BIOME_KEYS) {
    ok(seen.has(k), `群系 ${k} 在设计图上**一格都没有** ⇒ 那个群系的野生物永远不会出现`);
    /* 键必须真的在配表里:否则 `decideSpawn` 会 `?? MEADOW` 静默兜底(不报错)。 */
    ok(BIOME_SPAWN[k] !== undefined, `BIOME_SPAWN 缺键 ${k} ⇒ 会静默按草甸刷`);
    ok(spawnableMobs(k).length > 0, `群系 ${k} 的可刷名单为空 ⇒ 这个群系刷不出任何东西`);
  }
  /* `REGION_BIOME` 的值必须都在 `BIOME_KEYS` 里 —— 拼错一个字母就是"这个区永远草甸"。 */
  for (const [region, b] of Object.entries(REGION_BIOME)) {
    ok(BIOME_KEYS.includes(b), `区 ${region} 的群系键 "${b}" 不在 BIOME_KEYS 里(会静默兜底 MEADOW)`);
  }
});

/* ───────────────────────── 2 ───────────────────────── */

test('FND185-2 ★ 每个群系刷出来的物种 ⊆ spawnableMobs(该群系)(逐群系断言)', () => {
  ok(MAIN.alive >= 20,
    `20000 帧内应刷出至少 20 只活怪(否则下面的"逐群系"是空断言),实测 ${MAIN.alive} 只`);

  const byBiome = speciesByBiome(MAIN.obs);
  ok(byBiome.size >= 4,
    `观测到的群系太少(${byBiome.size} 个:[${[...byBiome.keys()].join('/')}]) ⇒ 分区没真正生效`);

  for (const [biome, species] of byBiome) {
    const allowed = new Set(spawnableMobs(biome).map((m) => m.id));
    for (const s of species) {
      ok(allowed.has(s),
        `群系 ${biome} 刷出了不属于它的物种 "${s}"(该群系只允许 [${[...allowed].join('/')}]) `
        + '—— 这说明刷怪用的是"整图一个群系",不是这一格的群系');
    }
    /* 物种自报的群系必须与刷怪格的群系一致(物种本来就是从这里挑的)。 */
    for (const o of MAIN.obs.filter((x) => x.cellBiome === biome)) {
      eq(o.speciesBiome, biome, `${o.id} 的物种群系与刷怪格群系不一致`);
    }
  }
  /* 8 个群系一个不少 —— 这是"设计图真的被用上了"的最强读数。 */
  eq(byBiome.size, BIOME_KEYS.length,
    `期望 8 个群系都刷出过怪,实测 ${byBiome.size} 个:[${byBiome.size > 0 ? [...byBiome.keys()].sort().join('/') : '无'}]`);
});

/* ───────────────────────── 3 ───────────────────────── */

test('FND185-3 不同群系出现**不同物种**(不是"都刷同一种")', () => {
  const byBiome = speciesByBiome(MAIN.obs);
  const nonMeadow = [...byBiome.keys()].filter((b) => b !== 'MEADOW').sort();
  ok(nonMeadow.length >= 2,
    `至少要有 2 个非 MEADOW 群系刷出怪(实测 [${nonMeadow.join('/')}])`);

  const a = byBiome.get('MEADOW') ?? [];
  ok(a.length > 0, 'MEADOW 群系应刷出过怪(世界默认群系)');
  for (const b of nonMeadow) {
    const species = byBiome.get(b) ?? [];
    const diff = species.filter((s) => !a.includes(s));
    ok(diff.length > 0,
      `群系 ${b} 的物种 [${species.join('/')}] 与 MEADOW [${a.join('/')}] 完全相同 `
      + '—— 那说明分区只是标签,名单没换');
  }
  /* 全物种里必须出现**MEADOW 名单之外**的物种(否则"换名单"没发生)。 */
  const all = new Set(MAIN.obs.map((o) => o.species));
  const outside = [...all].filter((s) => !MEADOW_ROSTER.has(s)).sort();
  ok(outside.length >= 2,
    `除草甸之外应至少刷出 2 种别的群系物种,实测 [${outside.join('/')}]`);
});

/* ───────────────────────── 4 ───────────────────────── */

test('FND185-4 海上/未分区 ⇒ 兜底**世界默认群系**(默认 MEADOW)', () => {
  /* (5,5) 在设计图的东南角海里;先把这个地图事实钉住,免得断言变成"碰运气"。 */
  eq(regionAt(5, 5), null, '(5,5) 应是区外(海上 / 未分区)');
  eq(biomeAt(5, 5), null, '(5,5) 的 design 群系应是 null(区外)');
  eq(MAIN.sim.biomeOfCell(5.5, 5.5), 'MEADOW', '区外格应兜底世界默认群系 MEADOW');
  eq(MAIN.sim.biomeOfCell(5.9, 5.1), 'MEADOW', '区外格(非格心坐标)同样兜底 MEADOW');

  const outside = MAIN.obs.filter((o) => o.region === null);
  ok(outside.length > 0,
    '应观测到落在区外(海/未分区)格上的怪 —— 否则"兜底"这条没被真的走过');
  for (const o of outside) {
    ok(MEADOW_ROSTER.has(o.species),
      `区外格 (${o.ax},${o.ay}) 刷出了 "${o.species}",不在 MEADOW 名单 [${[...MEADOW_ROSTER].join('/')}] 里`);
  }
});

/* ───────────────────────── 5 ───────────────────────── */

test('FND185-5 biomeHistogram():非空、键 ⊆ 8 群系、总数 == 存活数、与按格重算逐群系相等', () => {
  const hist = MAIN.hist;
  const keys = Object.keys(hist);
  ok(keys.length > 0, '直方图不该是空的(20000 帧里至少刷出过一只)');
  for (const k of keys) {
    ok(BIOME_KEYS.includes(k), `直方图出现了不属于 8 个群系的键 "${k}"`);
  }
  const sum = keys.reduce((n, k) => n + (hist[k] ?? 0), 0);
  eq(sum, MAIN.alive, '直方图总数应等于存活野生物数(尸体不算)');

  /* 与**按刷怪格重算**的分布逐群系相等 —— 这是直方图真的在读 `mobBiome` 的证明。 */
  const expect: Record<string, number> = {};
  for (const o of MAIN.obs) expect[o.cellBiome] = (expect[o.cellBiome] ?? 0) + 1;
  eq(JSON.stringify(hist, Object.keys(hist).sort()), JSON.stringify(expect, Object.keys(expect).sort()),
    `直方图应与按刷怪格重算的分布一致(实测 ${JSON.stringify(hist)} / 期望 ${JSON.stringify(expect)})`);
});

/* ───────────────────────── 6 ───────────────────────── */

test('FND185-6 ★ 有牙实证:常量 MEADOW 的实现在这批观测上**必然**选错物种', () => {
  /* 这条不是"再断言一次实现对",而是把**坏实现**代入同一批数据算一遍:
     若 `trySpawnOne` 用常量 `'MEADOW'` 挑物种,那么刷在非 MEADOW 格上的怪
     **只能是草甸物种** ⇒ 第 2 条的逐群系断言在**这些格**上必然红。
     下面数出来的就是"下界样本数"—— 它 > 0 才说明第 2 条不是恒真。 */
  const witnesses = MAIN.obs.filter(
    (o) => o.cellBiome !== 'MEADOW' && !MEADOW_ROSTER.has(o.species),
  );
  ok(witnesses.length >= 5,
    `应有至少 5 只"非 MEADOW 格 + 非 MEADOW 物种"的怪(实测 ${witnesses.length} 只)`
    + ' —— 为 0 说明这批观测无法区分"按格群系"与"整图 MEADOW"');
  /* 逐群系都要有见证:每个非 MEADOW 群系至少一只不可能是草甸物种的怪。 */
  const byBiome = new Map<string, number>();
  for (const w of witnesses) byBiome.set(w.cellBiome, (byBiome.get(w.cellBiome) ?? 0) + 1);
  for (const b of new Set(MAIN.obs.map((o) => o.cellBiome))) {
    if (b === 'MEADOW') continue;
    ok((byBiome.get(b) ?? 0) > 0,
      `群系 ${b} 里没有"草甸实现选不出来"的物种 ⇒ 该群系的断言在坏实现下仍会通过(无牙)`);
  }
});

/* ───────────────────────── 7 ───────────────────────── */

test('FND185-7 biomeOfCell 与 biomeAt 一致(floor 语义)、稳定、只读', () => {
  /* 每个群系一个样本格(与 `WS-FND-181` 的采样格同源),外加区外格。 */
  const sample: [number, number][] = [[96, 96], [64, 48], [128, 50], [138, 62], [64, 114], [86, 146], [80, 38], [118, 118], [5, 5]];
  for (const [x, y] of sample) {
    const want = biomeAt(x, y) ?? 'MEADOW';
    eq(MAIN.sim.biomeOfCell(x + 0.5, y + 0.5), want, `格 (${x},${y}) 的群系应是 ${want}(格心坐标)`);
    eq(MAIN.sim.biomeOfCell(x, y), want, `格 (${x},${y}) 的群系应是 ${want}(格角坐标)`);
    /* floor 语义:同一格内的任意小数都必须给出同一个答案(round 会让 0.5 跨格)。 */
    eq(MAIN.sim.biomeOfCell(x + 0.99, y + 0.01), want, `格 (${x},${y}) 内的小数坐标应仍属该格`);
  }
  /* 只读:调用前后世界读数不变。 */
  const before = JSON.stringify(MAIN.sim.biomeHistogram());
  const r1 = MAIN.sim.biomeOfCell(128.5, 128.5);
  const r2 = MAIN.sim.biomeOfCell(128.5, 128.5);
  eq(r1, r2, 'biomeOfCell 同输入应同输出(纯查询)');
  eq(JSON.stringify(MAIN.sim.biomeHistogram()), before, 'biomeOfCell 不该改动世界状态');
});

/* ───────────────────────── 8 ───────────────────────── */

test('FND185-8 兜底听**世界默认群系**:`biome: DESSERT` 世界里的区外格刷沙丘物种', () => {
  /* 为什么要有这条:`biomeName` 改名成"兜底/默认群系"之后,兜底必须**真的**跟着它走。
     若把它写死成字面量 `'MEADOW'`,这里会红 —— 而字面量兜底还会让
     `WS-FND-19` 的 FND19-6/FND19-10(在 48/64 格小世界里跑 RUINS/SAKURA)一起红,
     那两条判据的语义是"世界默认群系生效",不是"整图只有一个群系"。 */
  const w = run({ seed: 5, frames: 20000, biome: 'DESSERT' });
  const dessert = new Set(spawnableMobs('DESSERT').map((m) => m.id));
  const outside = w.obs.filter((o) => o.region === null);
  ok(outside.length > 0,
    `应观测到区外格上的怪(实测存活 ${w.alive} 只 / 区外 ${outside.length} 只)`);
  for (const o of outside) {
    ok(dessert.has(o.species),
      `世界默认群系是 DESSERT 时,区外格 (${o.ax},${o.ay}) 应刷沙丘物种,实测 "${o.species}"`);
  }
  /* 区内的格仍然按设计图走(不被世界默认值盖掉)。 */
  const inRegion = w.obs.filter((o) => o.region !== null);
  ok(inRegion.length > 0, 'DESSERT 世界里也应有点落在设计图的区里(随机撒点,区的面积占多数)');
  for (const o of inRegion) {
    const allowed = new Set(spawnableMobs(o.cellBiome).map((m) => m.id));
    ok(allowed.has(o.species),
      `区 ${o.region}(群系 ${o.cellBiome})刷出了 "${o.species}"(只允许 [${[...allowed].join('/')}])`
      + ' —— 世界默认群系不该盖掉设计图上已知的区');
  }
});

report('WS-FND-185');