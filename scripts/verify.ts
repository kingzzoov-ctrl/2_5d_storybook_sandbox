/**
 * 全仓库验证器(Lead 维护,写手只读)。
 *
 * 用法:
 *   node scripts/verify.ts                 # 冻结层 + 文档 + 内容锁 + 集成 + 全部测试
 *   node scripts/verify.ts --all           # 同上(显式写法;`npm test` 用它)
 *   node scripts/verify.ts --only WS-01    # 只跑某个工作流的测试
 *   node scripts/verify.ts --frozen        # 只跑冻结层不变量
 *   node scripts/verify.ts --docs          # 只检查文档结构完整性
 *   node scripts/verify.ts --content       # 只做内容基线一致性检查
 *   node scripts/verify.ts --integration   # 只做跨 WS 集成检查
 *   node scripts/verify.ts --strict-taut   # 把「未登记的同义反复候选」升级为失败
 *   node scripts/verify.ts --strict-reach  # 把「未登记的不可达模块」升级为失败
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FluidField } from '../server/src/world/fluid.ts';
import { collectOpenItems, detectStale } from './backlog.ts';
import { CarryReject } from '../server/src/physics/carry.ts';
import { DamageKind, ITEM } from '../server/src/mobs/behaviors.ts';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name: string): string | true | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const only = flag('only') as string | undefined;
const frozenOnly = argv.includes('--frozen');
const docsOnly = argv.includes('--docs');
const integrationOnly = argv.includes('--integration');
const contentOnly = argv.includes('--content');
/** `--strict-reach`:把「未登记的不可达模块」从告警升级为失败。见 `checkReachability`。 */
const strictReach = argv.includes('--strict-reach');
/** `--strict-taut`:把「未登记的同义反复候选」从告警升级为失败。见 `checkTautology`。 */
const strictTaut = argv.includes('--strict-taut');

/**
 * `--all`:跑**全部**门禁(等价于不传任何选择性 flag)。
 *
 * ⚠️ 第 13 批门禁审计(GATE-AUDIT-13 §N2)实测:这个 flag **此前根本不存在** ——
 * `verify.ts` 全文不含 `--all`。它"能用"只是因为不传 flag 恰好等于全跑,
 * 于是 `--all` 被静默忽略。而 `README L117` 与 `package.json` 的
 * `verify:all` / `test` 都把它当作"全部"来用。
 *
 * 危险点:若哪天有人加了 `--strict-*` 之类的**默认关闭**项,`--all`
 * 不会被算作"全跑",却又不会报错 —— 用 `npm test` 的人会以为跑全了。
 *
 * 现在显式解析它,并且在**同时出现选择性 flag**时直接报错(见 main),
 * 避免"`--all --frozen` 到底跑什么"这种口径歧义。
 */
const allFlag = argv.includes('--all');

let failures = 0;
/* 通过数也计数 —— 这样「跨 WS 集成 N/N」这个数字由工具报出,
   而不是靠人手数输出行数。手工数的坏处不是麻烦,是**口径会飘**:
   同一个 README 里的数字先后被数成 46 / 50 / 53,因为数的人
   有时把测试套件行算进去、有时只有集成段。名不副实的数字比
   明显的错更难发现。 */
let passes = 0;

/** 各测试套件的实测断言数(`runSuites` 填充,`checkDocs` 用它校验 README 表格)。 */
const suiteCounts = new Map<string, number>();

/** `checkFrozen` 实际通过的不变量条数(README 的 `冻结层不变量 N/N` 用它校验)。 */
let frozenInvariantCount = 0;

/**
 * `checkFrozen` 是否**真的跑过**。
 *
 * ⚠️ 为什么需要这个布尔(GATE-AUDIT-13 §N1):`frozenInvariantCount` 初值是 0,
 * 而 `--integration` 会跳过 `checkFrozen`。于是拿 0 去和 README 的 `17/17` 比,
 * 在**干净树**上报出:
 *   `✗ README 声称「冻结层不变量 17/17」,实测 0 —— 应更新为 0/0`
 * 这条红是**假红** —— 而 `--integration` 正是 README L114 与
 * `package.json` 的 `verify:integration` 明文提供的入口。
 * 修复者会照着提示去把 README 改成 `0/0`,方向完全错。
 *
 * 修法:**没跑过就跳过校验**,而不是拿"0"冒充"实测值"。
 * 这与 `checkDocs` 里 `suiteCounts` 为空时静默跳过是同一类坑 ——
 * 所以这里反过来:显式区分「跑了且为 0」与「没跑」。
 */
let frozenRan = false;

/**
 * 统计未决台账(README 的台账数字用它校验)。
 *
 * **复用 `backlog.ts` 的 `collectOpenItems()`,不重写解析器** ——
 * 我第一版按「编号列表」解析,结果一条都匹配不到(实际格式是表格
 * `| U8 | ... |`),于是这里返回 null、README 台账数字**静默不校验**。
 * 这正是本次要消灭的缺陷:口径分叉会让门禁悄悄变摆设。
 * `backlog.ts` 是台账的唯一口径来源,`verify.ts` 只消费它。
 */
async function countBacklog(): Promise<{
  total: number;
  open: number;
  blocking: number;
  closed: number;
} | null> {
  try {
    const bl = await import('./backlog.ts');
    const items = bl.collectOpenItems();
    if (items.length === 0) return null;
    return {
      total: items.length,
      /* `backlog.ts` 的「未关闭」= 未标记 closed 的条数 */
      open: items.filter((i) => !i.closed).length,
      blocking: items.filter((i) => i.blocking).length,
      closed: items.filter((i) => i.closed).length,
    };
  } catch {
    return null;
  }
}

/**
 * 允许使用装饰器的文件**白名单**。
 *
 * 装饰器与 `enum` / 构造器参数属性同属「strip-only 运行时拒绝」:
 * Node 24 默认不启用,实测 `.ts` 与 `.js` 都抛 `Invalid or unexpected token`,
 * 而 `node --check` 不报错。
 *
 * `schema.colyseus.ts` 是**唯一的例外**:它是 Colyseus 装配层,
 * `@type(...)` 装饰器本来就是构建期转译的产物,该文件不被任何测试 import,
 * 在生产里由 Colyseus 的构建链处理。
 *
 * ## 为什么白名单要**逐条核对**而不是直接跳过
 *
 * 白名单本身会腐化:文件改名、删除、或新增第二个装饰器文件时,
 * 一个「写死的字符串集合」不会报错。所以 `checkStrippable` 会核对
 * 白名单里的每个路径**确实存在且确实含装饰器** ——
 * 白名单失真(多出或失效)会当场失败,而不是静默放宽门禁。
 */
const DECORATOR_EXEMPT = new Set<string>(['server/src/net/schema.colyseus.ts']);

const fail = (msg: string): void => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const pass = (msg: string): void => {
  passes += 1;
  console.log(`  ✓ ${msg}`);
};

/* ───────────────────── 1. 冻结层不变量 ───────────────────── */

async function checkFrozen(): Promise<void> {
  console.log('\n[冻结层不变量]');
  const frozenAtStart = passes;
  const items = await import('../shared/constants/items.ts');
  const mobs = await import('../shared/constants/mobs.ts');
  const bosses = await import('../shared/constants/bosses.ts');
  const tile = await import('../shared/types/tile.ts');
  const phy = await import('../shared/types/physics.ts');
  const ent = await import('../shared/types/entities.ts');
  const alc = await import('../shared/types/alchemy.ts');

  /* 物品表:320 项、ID 唯一、十大分表数量与手册一致 */
  if (items.ITEM_LIST.length !== 320) fail(`物品总数 ${items.ITEM_LIST.length} ≠ 320`);
  else pass('物品总数 320');

  const ids = items.ITEM_LIST.map((i: { id: number }) => i.id);
  const uniq = new Set(ids);
  if (uniq.size !== ids.length) fail(`物品 ID 重复:${ids.length - uniq.size} 个`);
  else pass('物品 ID 全局唯一');

  const expected: Record<string, number> = {
    '3.1': 30, '3.2': 20, '3.3': 18, '3.4': 35, '3.5': 30,
    '3.6': 35, '3.7': 40, '3.8': 37, '3.9': 30, '3.10': 45,
  };
  for (const t of items.ITEM_TABLES) {
    if (t.ids.length !== expected[t.key]) fail(`分表 ${t.key} 数量 ${t.ids.length} ≠ ${expected[t.key]}`);
  }
  const sum = Object.values(expected).reduce((a, b) => a + b, 0);
  if (items.ITEM_TABLES.length !== 10 || sum !== 320) fail('分表结构不满足 10 表 / 320 项');
  else pass('十大分表结构 10 表 320 项');

  const malformed = items.ITEM_LIST.filter(
    (i: { name: string; tags: string[]; value: number; note: string }) =>
      !i.name || !Array.isArray(i.tags) || i.tags.length === 0 || typeof i.value !== 'number' || !i.note,
  );
  if (malformed.length > 0) fail(`${malformed.length} 条物品缺 name/tags/value/note`);
  else pass('全部物品字段完整');

  /* 配方引用完整性:所有 recipe / station 指向已存在 ID */
  const idSet = new Set<number>(ids);
  const badRefs: string[] = [];
  for (const it of items.ITEM_LIST) {
    if (it.recipe) {
      for (const k of Object.keys(it.recipe)) {
        if (!idSet.has(Number(k))) badRefs.push(`item#${it.id}.recipe→${k}`);
      }
    }
    if (it.station !== undefined && !idSet.has(it.station)) badRefs.push(`item#${it.id}.station→${it.station}`);
  }
  if (badRefs.length > 0) fail(`配方引用悬空 ${badRefs.length} 处:${badRefs.slice(0, 5).join(', ')}`);
  else pass('配方与加工台引用全部闭合');

  /* 生物表:24 种,群系分布 3×8,掉落引用闭合 */
  if (mobs.MOB_LIST.length !== 24) fail(`生物数量 ${mobs.MOB_LIST.length} ≠ 24`);
  else pass('野生动物 24 种');
  const perBiome = new Map<string, number>();
  for (const m of mobs.MOB_LIST) perBiome.set(m.biome, (perBiome.get(m.biome) ?? 0) + 1);
  if (perBiome.size !== 8 || [...perBiome.values()].some((v) => v !== 3)) {
    fail(`群系分布异常:${[...perBiome.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  } else pass('8 群系 × 3 种 = 24');

  const mobBadDrops: string[] = [];
  for (const m of mobs.MOB_LIST) {
    for (const k of Object.keys(m.drops)) if (!idSet.has(Number(k))) mobBadDrops.push(`${m.id}→${k}`);
    if (m.tameItem !== undefined && !idSet.has(m.tameItem)) mobBadDrops.push(`${m.id}.tameItem→${m.tameItem}`);
  }
  if (mobBadDrops.length > 0) fail(`生物掉落/驯养引用悬空:${mobBadDrops.join(', ')}`);
  else pass('生物掉落与驯养引用闭合');

  /* Boss 表:8 个,祭品/战利品引用闭合,号码与手册一致 */
  const expectedBossHp: Record<string, number> = {
    boss_jelly_king: 2500, boss_beaver_mecha: 4800, boss_fox_kitsune: 7500, boss_crab_kraken: 11000,
    boss_scorpion_pharaoh: 15000, boss_ginger_troll: 20000, boss_sky_whale: 26000, boss_chronos_colossus: 38000,
  };
  if (bosses.BOSS_LIST.length !== 8) fail(`Boss 数量 ${bosses.BOSS_LIST.length} ≠ 8`);
  else pass('世界 Boss 8 个');
  const bossBad: string[] = [];
  for (const b of bosses.BOSS_LIST) {
    if (expectedBossHp[b.id] !== b.baseHp) bossBad.push(`${b.id}.baseHp=${b.baseHp}≠${expectedBossHp[b.id]}`);
    if (!idSet.has(b.summonItem)) bossBad.push(`${b.id}.summonItem→${b.summonItem}`);
    for (const l of b.loot) if (!idSet.has(l)) bossBad.push(`${b.id}.loot→${l}`);
  }
  if (bossBad.length > 0) fail(`Boss 表校验失败:${bossBad.join(', ')}`);
  else pass('Boss 血量/祭品/战利品全部与手册一致');

  /* 位压缩往返一致性(穷举 20000 组随机组合) */
  let packBad = 0;
  for (let i = 0; i < 20000; i += 1) {
    const f = {
      elev: i % 4, base: (i * 3) % 16, floor: (i * 7) % 64,
      wire: (i * 5) % 16, obj: (i * 137) % 4096, meta: (i * 11) % 16,
    };
    const packed = tile.packTile(f);
    if (packed < 0 || packed > 0xffffffff) { packBad += 1; continue; }
    const out = tile.unpackTile(packed);
    if (out.elev !== f.elev || out.base !== f.base || out.floor !== f.floor
      || out.wire !== f.wire || out.obj !== f.obj || out.meta !== f.meta) packBad += 1;
    /* 互不干扰:改任一字段不影响其它字段 */
    const bumped = tile.withField(packed, 'obj', (f.obj + 1) % 4096);
    const bu = tile.unpackTile(bumped);
    if (bu.elev !== f.elev || bu.base !== f.base || bu.floor !== f.floor
      || bu.wire !== f.wire || bu.meta !== f.meta) packBad += 1;
  }
  if (packBad > 0) fail(`位压缩往返错误 ${packBad} 例`);
  else pass('位压缩 20000 组往返 + 字段隔离正确');

  /* 关键物理常数与手册数值一致 */
  const consts: [string, number, number][] = [
    ['TICK_HZ', phy.TICK_HZ, 20], ['DT', phy.DT, 0.05],
    ['SLOW_TICK_HZ', phy.SLOW_TICK_HZ, 2], ['GRAVITY', phy.GRAVITY, -18],
    ['THROW_SPEED_XY', phy.THROW_SPEED_XY, 8.5], ['THROW_SPEED_Z', phy.THROW_SPEED_Z, 6],
    ['CARRY_Z_STEP', phy.CARRY_Z_STEP, 0.85], ['CARRY_MAX_DEPTH', phy.CARRY_MAX_DEPTH, 4],
    ['CATCH_RADIUS', phy.CATCH_RADIUS, 0.8], ['BASE_MOVE_SPEED', phy.BASE_MOVE_SPEED, 4.5],
    ['CHUNK_BYTES', tile.CHUNK_BYTES, 1024],
  ];
  const badConst = consts.filter(([, a, b]) => Math.abs(a - b) > 1e-9).map(([n, a, b]) => `${n}=${a}≠${b}`);
  if (badConst.length > 0) fail(`物理/网格常数漂移:${badConst.join(', ')}`);
  else pass('物理与网格常数与手册一致');

  /* 成长与 Boss 缩放公式 */
  const growth: [number, number][] = [[1, 100], [10, 235], [30, 535]];
  for (const [l, hp] of growth) {
    if (ent.statsAtLevel(l).maxHp !== hp) fail(`statsAtLevel(${l}).maxHp=${ent.statsAtLevel(l).maxHp}≠${hp}`);
  }
  if (ent.expToNext(1) !== 100 || ent.expToNext(10) !== 5500) fail('expToNext 公式不符 50L²+50L');
  else pass('经验与属性成长公式正确');
  if (ent.bossScaledHp(2500, 4) !== 7375) fail(`bossScaledHp(2500,4)=${ent.bossScaledHp(2500, 4)}≠7375`);
  else pass('Boss 人数血量缩放正确(N=4 → ×2.95)');

  /* 炼金契约 */
  if (alc.recipeHash([712, 116, 125]) !== '116_125_712') fail('recipeHash 排序拼接错误');
  else pass('配方哈希 recipeHash 排序拼接正确');
  const rarityEdges: [number, number][] = [[0.99, 0], [1.0, 1], [1.24, 1], [1.25, 2], [1.54, 2], [1.55, 3]];
  for (const [q, tier] of rarityEdges) {
    const got = q < 1 ? 0 : q < 1.25 ? 1 : q < 1.55 ? 2 : 3;
    if (got !== tier) fail(`稀有度阈值 ${q} 期望档 ${tier}`);
  }
  pass('稀有度阈值 1.00/1.25/1.55 分档一致');

  /* 冻结层禁止不可擦除语法 */
  const forbidden = scanForbidden(join(ROOT, 'shared'));
  if (forbidden.length > 0) fail(`冻结层出现不可擦除语法:${forbidden.join(', ')}`);
  else pass('冻结层无 enum / 参数属性 / 装饰器元数据');

  /* 记录本节的**实际**通过条数,供 README 的「冻结层不变量 N/N」校验。
     不手数 —— 手数的口径会飘(这与集成计数是同一类缺陷)。 */
  frozenInvariantCount = passes - frozenAtStart;
  frozenRan = true;
}

/* ───────────────────── 2. 语法扫描 ───────────────────── */

function walk(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * 去掉注释与字符串字面量,只留代码。
 *
 * **为什么必须做**:扫描正则会命中**注释里**的示例代码与**字符串里**的
 * 代码片段,产生假阳性。假阳性比漏报更能毁掉门禁 —— 被误报几次之后,
 * 人就开始忽略这条告警,于是它连真问题也一起失去了作用。
 *
 * 实测踩到两处:我把「不要用构造器参数属性」写进注释(注释里含
 * `constructor(private readonly maxHp: number)`),以及一个测试断言里
 * 含 `from '../net/` 字符串片段 —— 两者都被当成真语法报了出来。
 *
 * 实现是够用的近似:块注释、行注释、单双引号字符串、模板字符串。
 * 不追求完美(那需要真 tokenizer),只要覆盖本项目的实际形态。
 */
function stripCommentsAndStrings(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    /* 块注释 */
    if (c === '/' && c2 === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    /* 行注释 */
    if (c === '/' && c2 === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      out += ' ';
      continue;
    }
    /* 字符串:单引号 / 双引号 / 模板 */
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        /* 模板字符串里的 ${...} 保守跳过整段 —— 宁可漏报代码里的问题,
           也不要因误解析而把后续代码当成字符串(那会掩盖真问题)。 */
        i += 1;
      }
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 去注释但**保留字符串内容**,用于导入路径检查。
 *
 * 与 `stripCommentsAndStrings` 分开是因为需求冲突:语法检查要抹掉字符串
 * (否则注释/字符串里的示例代码会假阳性),而导入路径检查**必须**看到
 * 字符串内容(路径本身就在字符串里)。
 *
 * 分开两个函数而不是加开关参数:两种用途的意图完全不同,合并后
 * 每次调用都要想「这个参数这次该传什么」。
 */
function stripCommentsOnly(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && c2 === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 解析一个文件里的**具名导入** → `局部名 → 导入来源模块(仓库相对路径)`。
 *
 * 两个已知坑(都是实测踩出来的,见 `docs/ADVERSARIAL-REVIEW-8.md`):
 *
 * ① **import 花括号里可以有注释**。`import { /* 门禁 *​/ checkGate, /* 像素 *​/ ICON_SIZE }`
 *    是合法 TS。若直接对**原文**做 `split(',')`,会得到 `"/* 像素 *​/\n  ICON_SIZE"`
 *    这样的垃圾段,`trim()` 后不是标识符 —— 于是该名字**从未被登记**。
 *    故先 `stripCommentsOnly` 再切分。
 *
 * ② **来源模块可能是转发文件**(`index.ts` 只写 `export {X} from './x.ts'`)。
 *    此时「导入来源」与「常量定义模块」不是同一个文件,
 *    按来源建键会查不到定义。故沿 `export {...} from` 链解析到**真正的定义模块**。
 *    `server/src/alchemy/index.ts` 就是这种:零个 `export const`,转发 155 个符号,
 *    WS-06 的 74 个导入**全部**指向它。
 *
 * @param src 文件原文
 * @param resolveDef 给定(来源模块, 名字)⇒ 定义模块;返回 null 表示无法解析
 */
function parseNamedImports(
  src: string,
  resolveDef: (sourceMod: string, name: string) => string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  /* **代码态**扫描:字符串里的假 import 不再被当成真导入(U12) */
  for (const blk of extractCodeStateBlocks(src, 'import')) {
    let mod = blk.spec.replace(/^\.\.\//, '');
    if (!/^(server|client)\/src/.test(mod)) continue;
    if (!mod.endsWith('.ts')) {
      for (const cand of [`${mod}.ts`, `${mod}/index.ts`]) {
        if (existsSync(join(ROOT, cand))) { mod = cand; break; }
      }
    }
    for (const raw of blk.names.split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      /* 允许 `type X` 前缀:取最后一个 token 作为局部名 */
      const local = parts[parts.length - 1]!.trim().replace(/^type\s+/, '');
      if (!/^[A-Za-z_]\w*$/.test(local)) continue;   /* 非法名直接丢弃,不建垃圾键 */
      out.set(local, resolveDef(mod, local) ?? mod);
    }
  }
  return out;
}

function scanForbidden(dir: string): string[] {
  const hits: string[] = [];
  for (const file of walk(dir, ['.ts'])) {
    const raw = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).split(sep).join('/');

    /* 语法检查:用去掉注释与字符串的版本,避免示例代码造成假阳性 */
    const code = stripCommentsAndStrings(raw);
    if (/^\s*(export\s+)?(const\s+)?enum\s/m.test(code)) hits.push(`${rel}:enum`);
    if (/constructor\s*\([^)]*\b(private|public|protected|readonly)\s/.test(code)) {
      hits.push(`${rel}:ctor-param-prop`);
    }
    if (/\bnamespace\s+\w+\s*\{/.test(code)) hits.push(`${rel}:namespace`);

    /* 装饰器:与 enum 同属**运行时拒绝**。
       Node 24 默认不启用装饰器(需 `--experimental-decorators` 或转译器),
       实测 `.ts` 与 `.js` 都抛 `Invalid or unexpected token` ——
       而 `node --check` **不报错**,所以它和参数属性一样「只在 import 那一刻爆发」。

       唯一允许的文件见 `DECORATOR_EXEMPT`(Colyseus Schema 装配层:
       本就需要构建期转译,且不被任何测试 import)。
       例外必须**登记在案** —— 漏扫等于不设防;把已知例外显式列出,
       新增装饰器文件就会立刻被拦。 */
    if (/^\s*@[A-Za-z_][\w.]*\s*\(/m.test(code) && !DECORATOR_EXEMPT.has(rel)) {
      hits.push(`${rel}:decorator`);
    }

    /* 导入扩展名检查:用只去注释的版本 —— 路径本身在字符串里。
       
       但**必须排除「字符串里的 from」**:本项目有测试断言会检视源码文本
       (`!src.includes("from '../net/")`),那是**数据**不是导入语句。
       
       判据:从匹配位置向前看 300 字符,若出现过 `import` 或 `export`
       且中间**没有语句分隔符 `;`**,就算真导入语句。
       用「向前窗口」而不是「同一行」是因为多行导入的 `from` 单独成行:
           import {
             a, b,
           } from '../x.ts';
       这种写法里含 `from` 的那行没有 `import` 关键字,按行判会漏报。

       **U12 加固**:窗口里出现 `export const` / `export function` 这类**变量/函数声明**
       并不代表是导入语句。实测下面这种**字符串**会被误报成 import-no-ext:
           export const msg = "failed from '../combat/damage'";
       故要求 `import`/`export` 之后**紧跟 `{` 或字符串**(即真导入/转发的形态),
       排除 `export const` / `export function` / `export interface` 等。 */
    const code2 = stripCommentsOnly(raw);
    for (const m of code2.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      const at = m.index ?? 0;
      const window = code2.slice(Math.max(0, at - 300), at);
      /* 语句边界之后的片段才算数 */
      const sinceBoundary = window.slice(window.lastIndexOf(';') + 1);
      /* 必须形如 `import {` / `import '*'` / `export {` / `export *`,
         而不是 `export const` 之类 */
      if (!/\b(?:import|export)\s*(?:\{|type\s*\{|\*)/.test(sinceBoundary)) continue;
      if (!m[1].endsWith('.ts') && !m[1].endsWith('.json')) {
        hits.push(`${rel}:import-no-ext(${m[1]})`);
      }
    }
  }
  return hits;
}

/**
 * 全仓不可擦除语法扫描 —— 不止冻结层。
 *
 * **为什么必须扩到全仓**:Node 24 的 strip-only 模式对 `enum` /
 * 构造器参数属性 / `namespace` 是**运行时拒绝**,而 `node --check`
 * **不报错**(它只做语法解析,不做 strip 可行性检查)。
 * 于是这类错误只在真正 `import` 那一刻爆发 —— 而那时它已经把
 * 整个测试或服务拖下水。
 *
 * 这个缺口是实际踩到的:我在 `server/src/combat/vitals.ts` 写了
 * `constructor(private readonly maxHp: number = PLAYER_BASE_HP)`,
 * `--check` 通过、但 import 时抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
 * 原因就是 `scanForbidden` 当时**只扫 `shared/`** ——
 * 门禁覆盖面比它声称的窄。逻辑本身是对的,范围不对。
 */
function checkStrippable(): void {
  console.log('\n[可擦除语法]');
  const dirs = ['shared', 'server/src', 'client/src', 'tests', 'scripts'].map((d) => join(ROOT, d));
  const hits: string[] = [];
  for (const d of dirs) hits.push(...scanForbidden(d));
  /* 排除 verify.ts 自身:`scanForbidden` 的正则字面量里含 'constructor(...)' 模式 */
  const filtered = hits.filter((h) => !h.startsWith('scripts/verify.ts'));

  /* 白名单自检:登记为「允许装饰器」的文件必须**真的存在且真的含装饰器**。
     否则白名单会因改名/删除而悄悄生效,把门禁放宽成摆设。 */
  const staleExempt: string[] = [];
  for (const rel of DECORATOR_EXEMPT) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      staleExempt.push(`${rel}(文件不存在)`);
      continue;
    }
    const code = stripCommentsAndStrings(readFileSync(p, 'utf8'));
    if (!/^\s*@[A-Za-z_][\w.]*\s*\(/m.test(code)) {
      staleExempt.push(`${rel}(已无装饰器,应移出白名单)`);
    }
  }

  if (filtered.length > 0) {
    fail(`出现 strip-only 不支持的语法(${filtered.length} 处):${filtered.slice(0, 5).join(', ')}`);
  } else if (staleExempt.length > 0) {
    fail(`装饰器白名单失真(应修正):${staleExempt.join(', ')}`);
  } else {
    pass(
      `全仓可擦除:${dirs.length} 个目录无 enum / 参数属性 / namespace / 装饰器 / 缺扩展名导入` +
        `(装饰器例外 ${DECORATOR_EXEMPT.size} 处已登记并核对)`,
    );
  }
}

/* ───────────────── 2.5 生产可达性(编排缺口) ───────────────── */

/**
 * 生产入口(`package.json` 里 `node xxx.ts` 形式的脚本)。
 *
 * 只认 **真的会启动服务/模拟** 的入口,不认工具脚本(`scripts/**`)——
 * 后者不是生产路径,把它们算作根会让几乎所有模块都「可达」,
 * 门禁随即失去意义。
 */
const PROD_ENTRIES = [
  'server/src/sim/demo.ts', // npm run sim
  'server/src/net/room.colyseus.ts', // Colyseus 房间被 server 装配层实例化

  /* ── 客户端入口(2026-11-12 补,task-32)──
   *
   * ⚠️ 这里曾漏掉整个客户端,后果是本门禁**把正在被浏览器加载的模块
   * 报成「未登记的不可达模块」**:
   *   · client/src/main.ts / stage/chunk_geometry.ts /
   *     stage/demo_world.ts / three/boot.ts
   * 它们当时确实可达(`client/index.html` 里 `<script src="./src/main.ts">`,
   * 页面实测 60 FPS 能跑),门禁却不知道 —— 因为 `PROD_ENTRIES` 只有服务端两项。
   *
   * 这个漏项的方向是**最坏的一种**:不可达数偏大 ⇒ 白名单被要求覆盖
   * 本来可达的模块 ⇒ 16 条 `client/**` 带着「本仓无装配入口」这条**假理由**
   * 长期挂在白名单里,而自检只查「文件存在」「已可达」,查不出「理由已过时」。
   *
   * 入口取 `client/src/main.ts` 而非 `client/index.html`:
   * 闭包只解析 `.ts` 的相对 import,HTML 不是 TS 图的一部分。
   * 两者的对应关系由 `checkReachability` 里的断言守住(见 `CLIENT_HTML`)。 */
  'client/src/main.ts', // client/index.html → <script src="./src/main.ts">
];

/**
 * 客户端 HTML 入口 → 它加载的 TS 模块。
 *
 * 断言 `client/index.html` 里**确实**引用了 `client/src/main.ts`。
 * 否则两者会各走各的:HTML 改了 script 路径而 `PROD_ENTRIES` 没跟,
 * 客户端又会从闭包里掉出去 —— 即上面那段事故的复发路径。
 */
const CLIENT_HTML = 'client/index.html';
const CLIENT_HTML_ENTRY = './src/main.ts';

/**
 * 不可达模块白名单:文件 → 为什么可以不接入生产。
 *
 * **这不是「允许写死代码」的列表。** 每一处都必须写明**为什么现在可以不接**,
 * 以及**接入条件**。凡不能给出理由的,就不该进这张表 —— 那正是本门禁要抓的东西。
 *
 * 自检(见 `checkReachability`):表里每个路径必须**存在**;
 * 若某天它变成可达,也要移出。否则白名单会因改名/删除而静默放宽。
 */
const UNREACHABLE_EXEMPT = new Map<string, string>([
  /* ── 客户端:已接线部分**已移出**(2026-11-12,task-32)──
   *
   * 下面 8 条曾以「客户端子系统,本仓无装配入口」为理由整目录挂在表里。
   * 该理由**当时是事实**(client/ 无 index.html / main.ts),
   * 但本会话补上 `client/index.html` + `client/src/main.ts` 之后它**变成假的**,
   * 而门禁没察觉:自检只查「文件不存在」「已可达」,不查「理由本身过时」。
   *
   * 已移出(现由 `client/src/main.ts` 闭包覆盖,共 15 个文件中的 8 个):
   *   stage/assembly_math.ts · stage/dye_overlay.ts · stage/entity_sprites.ts ·
   *   stage/iso_camera.ts · stage/particles.ts · stage/shaders.ts ·
   *   stage/tile_mesh.ts · three/stage_assembly.ts
   * 移出后若它们**再次**不可达,门禁会以「未登记」报出来 —— 这正是本表的作用。
   */

  /* ── 客户端:8 条已于 2026-11-12 全部接线,整块摘除 ──
   *
   * 摘除的 8 条:`audio.ts` · `stage/roof_transparency.ts` ·
   * `ui/{blueprint,boss_hud,inventory,pixel_easel,recipe_tree,state_machine}.ts`
   *
   * 接线方式(不是「import 一下」):
   *   · `client/src/three/ui_binding.ts` —— Canvas2D 覆盖层(刻意不 import three)
   *   · `client/src/three/audio_out.ts` —— WebAudio 输出,音高/ADSR 全部取自 audio.ts
   *   · `client/src/ui/panel_layout.ts` —— 面板布局纯逻辑,故可在 node 断言
   *   · `boot.ts` 里由 `UiStateMachine` 驱动开关(I/R/E/P/Esc),各面板有交互
   *
   * 它们原来能进本表,是因为表里的理由是「**本仓无装配入口**」——
   * 而那是**假的**(`client/index.html` 与 `client/src/main.ts` 当时都已存在)。
   * 这个假理由被 `detectStaleReason` 抓出来,现已整块删除。
   *
   * **留作教训**:目录级、笼统的理由会让白名单在事实变化后继续豁免。
   * 理由必须写到「**谁接、接法是什么、接在哪一行**」,才可判定是否过时。
   */

  /* ── 服务端:尚未接入编排(构成本门禁要暴露的主类) ── */
  /* WS-06 炼金 7 条(index + 6 内部模块)已于 2026-11-12 接线,
     入口 `WorldSim.forgeAlchemy()`。已从白名单摘除 —— 不在表里
     却仍不可达会让门禁报「未登记」,这正是本表存在的意义。 */
  ['server/src/bosses/breaks.ts', 'WS-05 Boss 破防,待接入 tickMobs'],
  ['server/src/bosses/phases.ts', 'WS-05 Boss 阶段,待接入 tickMobs'],
  ['server/src/bosses/raid.ts', 'WS-05 副本编排,待接入'],
  ['server/src/build/autotile.ts', 'WS-03 自动贴图,待客户端接线'],
  ['server/src/build/blueprint.ts', 'WS-03 蓝图接力队列,待接入'],
  ['server/src/build/grid.ts', 'WS-03 建造网格,待接入'],
  ['server/src/build/rooms.ts', 'WS-03 BFS 房间检测,待接入'],
  ['server/src/build/wiring_view.ts', 'WS-08 电路可视视图,待客户端接线'],
  ['server/src/combat/cooking.ts', 'WS-06 料理,待接入'],
  ['server/src/combat/damage.ts', 'WS-10 八步伤害公式 —— 生产走 vitals.ts 简化路径,待接线'],
  ['server/src/combat/progression.ts', 'WS-10 击杀结算,待接入'],
  ['server/src/combat/revive.ts', 'WS-10 复活/无敌,待接入'],
  ['server/src/combat/weapons.ts', 'WS-10 武器表,随 damage.ts 一起接'],
  ['server/src/content/baseline.ts', 'WS-03 内容基线登记,待接入'],
  ['server/src/content/handshake.ts', '内容握手协议,待接入'],
  ['server/src/content/registry.ts', '内容注册表,待接入'],
  ['server/src/coop/rush_order.ts', 'WS-11 抢单协作,待接入'],
  ['server/src/db/driver.sqlite.ts', '驱动按 DbLike 结构化类型注入,生产入口尚未注入'],
  ['server/src/db/memory_db.ts', '驱动按 DbLike 结构化类型注入,生产入口尚未注入'],
  ['server/src/mobs/taming.ts', 'WS-04 牧场驯服,待接入'],
  ['server/src/net/prediction.ts', 'WS-07 客户端预测,待客户端接线'],
  ['server/src/party/modes.ts', 'WS-11 竞技模式状态机,待接入'],
  ['server/src/party/scoring.ts', 'WS-11 计分,待接入'],
  ['server/src/prank/immunity.ts', 'WS-11 整蛊免疫,待接入'],
  ['server/src/prank/toys.ts', 'WS-11 玩具,待接入'],
  ['server/src/social/afk.ts', 'WS-11 挂机/生态箱,待接入'],
  ['server/src/wiring/logistics.ts', 'WS-08 物流,待接入'],
]);

/**
 * 白名单分类:把「**真的欠账**」与「**刻意不接**」分开计数。
 *
 * ## 为什么需要这个
 *
 * 白名单本身有个隐蔽的失败形态:理由**都是真的**,条目**一个不失真**,
 * 于是门禁全绿、`✓ 白名单 50 条` 看上去很干净 —— 但读者看不出
 * **其中多少条是真的还没接线**。缺口被「已全部登记理由」这句话吸收了。
 *
 * 这与「假绿门禁」是同一族问题的另一面:不是**判据**失效,而是
 * **聚合口径**把欠账说轻了。所以这里把两类**分别数出来并打印**,
 * 且数字可断言 —— 待接线数量下降是进展,上升是新增欠账,两者都不会静默。
 *
 * 判据(按理由文本,而非文件位置,因为位置无法区分意图):
 * - `pendingWiring` = 理由里含「待…接」/「随…一起接」/「尚未注入」⇒ 明确欠账
 * - `intentional`   = 含「本仓无装配入口」/「客户端子系统」⇒ 结构事实,非欠账
 */
/* 判据 —— **按阻塞原因分类,而不是按「是不是欠账」**:

   我先前的二分类是错的:把「本仓无装配入口」当作「非欠账」。实测推翻了它 ——
   `client/` 16 个文件**没有任何入口**(无 main/index/.html、无构建脚本),
   而 WS-09 **明确在范围内**(LEAD-PLAN L52),其测试 **import 了其中 15 个**。
   ⇒ 它们有实现、有测试、在范围内,只差装配入口。**「无入口」是欠账的原因,不是免除的理由。**

   所以「有没有欠账」的答案恒为「有」,统计它没有信息量。
   有信息量的是**欠账卡在哪**,因此按阻塞原因分类:

   - `blockedOnClientShell`:等客户端入口壳(client/src 无入口文件)
   - `blockedOnDependency`:等外部依赖(如 `three` 未安装 —— 台账已有 open item)
   - `blockedOnMechanism`:等服务端机制(如产出凭证记账、权威物品总量)
   - `blockedOnDecision`:等产品/设计裁决(如回放系统 US7)

   每类都**是欠账**,区别只在「谁能解」。这样报出来不会让读者误以为有「不必修的」。
 */
/* ⚠️ 必须用**窄词**:早期版本写 /客户端|本仓无装配入口/,
   宽词「客户端」会把 3 条 server/src/** 的**接线活**先抓走 ——
   它们的理由是「待客户端接线」(缺接线动作),不是「等入口文件」。
   实测:宽词 19/22/9/0 → 窄词 16/25/9/0。 */
const WL_BLOCK_CLIENT_SHELL = /本仓无装配入口|客户端子系统/;
const WL_BLOCK_DEPENDENCY = /three|依赖未安装|相容层/;
const WL_BLOCK_MECHANISM = /随.*一起接|尚未注入|被.*聚合/;
/* 「缺接线动作」与「等人拍板」是两件事,不可混。当前 43 条全是前者:
   没有一条是「本可做、但等产品决定」的 —— 所以 decision 预期恒 0。 */
const WL_BLOCK_WIRING = /待接|等编排层接线|待客户端接线/;
/** decision 的模式(两个条件都满足才算「等人拍板」)。 */
const WL_DECISION_A = /(?:待|等|尚未|随)/;
const WL_DECISION_B = /(?:接|注入)/;

function whitelistBreakdown(): {
  clientShell: number; wiring: number; mechanism: number; dependency: number;
  decision: number; other: number; decisionShadowed: number;
} {
  let clientShell = 0;
  let wiring = 0;
  let mechanism = 0;
  let dependency = 0;
  let decision = 0;
  let other = 0;
  /* **被前面的桶抢走的 decision 候选数**。
     ⚠️ 这个计数器是本轮(task-32)加的,原因的实证如下:
     43 条里**有 27 条**同时满足 decision 的两个正则,而**没有一条**能落进
     `decision` 桶 —— 它们全部先被 `wiring`(24)或 `mechanism`(3)抓走。
     于是打印出来的「等裁决 0」**不是「没有等人拍板的事」这个测量结果**,
     而是分类顺序的结构性产物。实测:把 `WL_BLOCK_MECHANISM` 里的
     「尚未注入」去掉,同样的表就会算出 `mechanism 1 / decision 2` ——
     说明这个 0 极度依赖正则的写法,不能当作事实读。
     所以现在把「影子数」一并算出来并打印,让读者知道 0 是怎么来的。 */
  let decisionShadowed = 0;

  for (const [, reason] of UNREACHABLE_EXEMPT) {
    /* 顺序有讲究 —— **具体优先于笼统**:
       1 `wiring`:最具体(明确说「待接/接线」= 缺接线动作);
       2 `clientShell`:缺入口文件;
       3 `mechanism`:随别的模块一起接;
       4 `dependency`:等外部依赖安装(独立计数,不再并进 other);
       5 `decision`:等人拍板;
       6 其余归 `other`。
       早期把 clientShell 排在 wiring 前面,导致「待客户端接线」被宽词抓走。 */
    const isDecisionCandidate = WL_DECISION_A.test(reason) && WL_DECISION_B.test(reason);
    if (WL_BLOCK_WIRING.test(reason)) {
      wiring += 1;
      if (isDecisionCandidate) decisionShadowed += 1;
      continue;
    }
    if (WL_BLOCK_CLIENT_SHELL.test(reason)) {
      clientShell += 1;
      if (isDecisionCandidate) decisionShadowed += 1;
      continue;
    }
    if (WL_BLOCK_MECHANISM.test(reason)) {
      mechanism += 1;
      if (isDecisionCandidate) decisionShadowed += 1;
      continue;
    }
    if (WL_BLOCK_DEPENDENCY.test(reason)) {
      dependency += 1;
      if (isDecisionCandidate) decisionShadowed += 1;
      continue;
    }
    if (isDecisionCandidate) { decision += 1; continue; }
    other += 1;
  }
  return { clientShell, wiring, mechanism, dependency, decision, other, decisionShadowed };
}


/** 解析一个 TS 文件的相对 import 目标(绝对路径)。 */
function resolveImport(fromAbs: string, spec: string): string | null {
  let p = resolve(dirname(fromAbs), spec);
  if (p.endsWith('.ts')) return existsSync(p) ? p : null;
  if (existsSync(`${p}.ts`)) return `${p}.ts`;
  const idx = join(p, 'index.ts');
  if (existsSync(idx)) return idx;
  return null;
}

/**
 * 提取**代码态**下的相对导入路径。
 *
 * **为什么不用正则 + `stripCommentsOnly`**(那是 S26 之前的写法,已被实测证伪):
 * `stripCommentsOnly` 保留字符串内容,于是下面这些**字符串字面量**里的
 * `from './x.ts'` 会被误当成依赖(四种形态实测**全部误抓**):
 *
 * ```ts
 * export const msg = "failed from './combat/damage.ts'";
 * export const q   = "src from '../a/b.ts' here";
 * export const t   = `load from './c.ts'`;
 * ```
 *
 * 后果:**幽灵依赖** ⇒ 该模块被误判为可达 ⇒ 不可达数偏小。
 * 若幽灵指向白名单模块,会因「已可达」自检而暴露;若指向未登记模块,
 * **告警会静默消失** —— 那是掩盖方向,必须消除。
 *
 * 本函数逐字符扫描:跳过注释与字符串的**内容**,只在代码态识别
 * `import` / `from` 关键字,再读紧随其后的字符串字面量作为路径。
 */
function extractRelativeImports(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  const isId = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    /* 注释:整段跳过 */
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    /* 字符串:整段跳过(**这里正是旧实现漏掉的**) */
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) { i += 1; break; } i += 1; }
      continue;
    }
    /* 代码态标识符 */
    if (isId(c) && !isId(text[i - 1])) {
      let j = i;
      while (j < n && isId(text[j])) j += 1;
      const word = text.slice(i, j);
      if (word === 'import' || word === 'from') {
        let k = j;
        while (k < n && /\s/.test(text[k] as string)) k += 1;
        const q = text[k];
        if (q === "'" || q === '"') {
          let e = k + 1;
          let spec = '';
          while (e < n) {
            if (text[e] === '\\') { spec += text[e + 1]; e += 2; continue; }
            if (text[e] === q) break;
            spec += text[e]; e += 1;
          }
          if (spec.startsWith('.')) out.push(spec);
          i = e + 1;
          continue;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 在**代码态**下依次产出源码里的标识符、字符串字面量、以及分界符。
 *
 * **为什么需要它**(U12,一个被连续证伪两次的教训):
 * `stripCommentsOnly` **保留字符串内容**,凡是「正则跑在它上面」的地方,
 * 字符串里出现的代码片段都会被当成真语法。已实测两处受害:
 *
 * 1. `reachableClosure`(S26):字符串里 `from './x.ts'` ⇒ **幽灵依赖** ⇒ 模块被误判可达
 * 2. `parseNamedImports` / `buildReexportMap`(U12):字符串里
 *    `export { ICON_SIZE } from './attributes.ts'` ⇒ **幽灵转发边** ⇒
 *    常量被解析到错误定义模块 ⇒ 候选**静默消失**(实测 32 → 31)
 *
 * **规范**:正则只应跑在代码态文本上。见 `extractCodeStateBlocks` 与
 * `extractRelativeImports` —— 它们按「关键字在代码态、路径在字符串」的语义取。
 */

/**
 * 提取 `import { ... } from '<spec>'` / `export { ... } from '<spec>'`
 * 的**代码态**形态。
 *
 * 旧实现跑 `stripCommentsOnly` + 正则,已被 U12 证伪(字符串幽灵转发边):
 * 字符串里 `export { ICON_SIZE } from './attributes.ts'` 会被当成真转发,
 * 把常量重定向到错误模块 ⇒ 候选**静默消失**(实测 32 → 31)。
 *
 * 本函数单遍扫描:只在代码态认关键字,然后**不限长度**推进到
 * 配对的 `}` → `from` → 字符串字面量。不限长度很重要 —— 本仓有 47 名的大转发块,
 * 用固定窗口截断会漏(我自己在诊断脚本里就犯过这个错)。
 */
function extractCodeStateBlocks(text: string, keyword: 'import' | 'export'): { names: string; spec: string }[] {
  const out: { names: string; spec: string }[] = [];
  const n = text.length;
  const isId = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) { i += 1; break; } i += 1; }
      continue;
    }
    if (isId(c) && !isId(text[i - 1])) {
      let j = i;
      while (j < n && isId(text[j])) j += 1;
      if (text.slice(i, j) === keyword) {
        let k = j;
        while (k < n && /\s/.test(text[k] as string)) k += 1;
        if (/^type\b/.test(text.slice(k, k + 5))) { k += 4; while (k < n && /\s/.test(text[k] as string)) k += 1; }
        if (text[k] === '{') {
          const close = text.indexOf('}', k + 1);
          if (close > 0) {
            let m = close + 1;
            while (m < n && /\s/.test(text[m] as string)) m += 1;
            if (/^from\b/.test(text.slice(m, m + 5))) {
              m += 4;
              while (m < n && /\s/.test(text[m] as string)) m += 1;
              const q2 = text[m];
              if (q2 === "'" || q2 === '"') {
                let e2 = m + 1;
                let spec = '';
                while (e2 < n) {
                  if (text[e2] === '\\') { spec += text[e2 + 1] ?? ''; e2 += 2; continue; }
                  if (text[e2] === q2) break;
                  spec += text[e2]; e2 += 1;
                }
                /* names 里可能夹注释(如「斜星号 像素 星斜号 ICON_SIZE」形态)——
                   必须剥掉,否则会建出带注释前缀的垃圾键,而真名字从未登记
                   (REVIEW-8 缺陷 A)。 */
                if (spec.startsWith('.')) out.push({ names: stripCommentsOnly(text.slice(k + 1, close)), spec });
              }
            }
          }
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 从入口出发做 BFS,得到可达文件集合(绝对路径)。 */
function reachableClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entries.map((e) => resolve(ROOT, e)).filter((p) => existsSync(p));
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const spec of extractRelativeImports(readFileSync(cur, 'utf8'))) {
      const dep = resolveImport(cur, spec);
      if (dep && !seen.has(dep)) stack.push(dep);
    }
  }
  return seen;
}

/**
 * 判断一条白名单**理由**是否已经过时 —— 返回过时原因的说明(空数组 = 仍然成立)。
 *
 * ## 为什么需要它(task-32 的核心交付)
 *
 * 白名单原有的两处自检是「文件不存在」「已可达,应移出」。两者都只看
 * **条目与文件系统的关系**,不看**理由说了什么**。于是有这样一类静默放宽:
 *
 *   `client/**` 16 条的理由是「客户端子系统,**本仓无装配入口**」。
 *   这句话在写下时是**事实**(client/ 无 index.html / main.ts)。
 *   后来补上了 `client/index.html` + `client/src/main.ts`,这句话**变成假的**。
 *   条目仍「文件存在」、在门禁眼里仍「不可达」(因为 `PROD_ENTRIES` 漏了客户端),
 *   于是两处自检**全绿**,而这 16 条的理由已经不能解释任何事了。
 *
 * 这是最难发现的一类:**不是条目错了,是理由和事实错位了**。
 * 它让「已全部登记理由」这句话变得没有信息量。
 *
 * ## 判据(两条,都只看理由文本与文件系统,不做语义推理)
 *
 * 1. **否定的存在性断言** —— 理由里出现 `无 X` / `没有 X` / `尚无 X` 这类
 *    否定式,而 X 指向的路径**现在存在** ⇒ 过时。
 *    例:「本仓无装配入口(无 index.html / main.ts)」而两者都在 ⇒ 报。
 * 2. **肯定的路径引用** —— 理由里提到的调用点/文件(`xxx.ts`、`main.ts`、
 *    `index.html`)必须**存在**;若指向的道路不存在,理由已与代码脱节。
 *
 * ## 局限(刻意承认,不是遗漏)
 *
 * 这**不是**自然语言理解。它抓不到「理由在语法上仍成立、但语义已变」的情形,
 * 例如「随 damage.ts 一起接」在 damage.ts **真被接线之后**依然字面成立。
 * 所以它是一道**窄网**:能抓住 task-32 这一类的措辞,抓不住所有过时。
 * 补网的办法是**把理由写成可判定的形式**(写明文件路径与否定断言),
 * 而不是把正则写得更宽 —— 宽正则会把本来正确的理由误判成过时,
 * 那会让人开始无视这条告警,比没有更糟。
 */
function detectStaleReason(reason: string): string[] {
  const out: string[] = [];

  /* 理由里提到的路径候选:`xxx.ts` / `xxx.html` / `client/src/...`。
     只认带扩展名的形态 —— 裸词(如「装配层」)无法判定存在性。 */
  const pathLike = reason.match(/[\w./-]*[\w-]+\.(?:ts|html|json)/g) ?? [];

  /* ── 判据 1:否定式存在断言 ──
     匹配 `无 X` / `没有 X` / `尚无 X` / `不存在 X`,X 为路径样式。
     注意用的是「无」而非「不含」等词,并把「无入口」这种**不带路径**的
     笼统说法排除在外 —— 那种无法自动判定,留给评审。 */
  const negRe = /(?:无|没有|尚无|不存在)\s*([\w./-]*[\w-]+\.(?:ts|html|json))/g;
  for (const m of reason.matchAll(negRe)) {
    const p = m[1]!;
    /* 相对于 ROOT 找:理由里可能写 `index.html`(= client/index.html)、
       `main.ts`、或完整相对路径。任一命中即视为「它已存在」。 */
    const candidates = [
      join(ROOT, p),
      join(ROOT, 'client', p),
      join(ROOT, 'client/src', p),
      join(ROOT, 'server/src', p),
    ];
    const hit = candidates.find((c) => existsSync(c));
    if (hit !== undefined) {
      out.push(`写了「${m[0]}」但它已存在(${relOfPath(hit)})`);
    }
  }

  /* ── 判据 1b:「本仓无装配入口」这一具体措辞 ──
     它是 task-32 的实际肇事句子,且无法用上面的通用式抓住
     (因为它没直接跟路径)。单独判定:客户端入口一旦存在,该说法即失效。 */
  if (/本仓无装配入口/.test(reason)) {
    const clientEntry = join(ROOT, 'client/src/main.ts');
    const clientHtml = join(ROOT, 'client/index.html');
    if (existsSync(clientEntry) || existsSync(clientHtml)) {
      const which = [existsSync(clientEntry) ? 'client/src/main.ts' : '', existsSync(clientHtml) ? 'client/index.html' : '']
        .filter(Boolean).join('、');
      out.push(`声称「本仓无装配入口」但装配入口已存在(${which})`);
    }
  }

  /* ── 判据 2:肯定的路径引用必须存在 ──
     排除已被判据 1 处理过的否定式引用(否则同一处会报两遍)。 */
  const negMatches = new Set([...reason.matchAll(negRe)].map((m) => m[0]));
  for (const p of pathLike) {
    if ([...negMatches].some((n) => n.includes(p))) continue;
    /* `damage.ts`、`main.ts` 这类**不带目录**的引用:全仓找一个同名文件。
       找不到 ⇒ 理由引用的文件已不存在(改名/删除/从未存在)。 */
    if (p.includes('/')) {
      if (!existsSync(join(ROOT, p))) out.push(`引用的路径不存在:${p}`);
      continue;
    }
    const found = findFileByName(p);
    if (!found) out.push(`引用的文件不存在:${p}`);
  }

  return out;
}

/** `path` 相对 ROOT 的 POSIX 形态(reason 检测的报错用)。 */
function relOfPath(p: string): string {
  return relative(ROOT, p).split(sep).join('/');
}

/** 在 `server/src` / `client/src` / `shared` 下按文件名找(用于裸文件名引用)。 */
function findFileByName(name: string): string | null {
  for (const d of ['server/src', 'client/src', 'shared', 'client']) {
    const base = join(ROOT, d);
    if (!existsSync(base)) continue;
    const hit = walk(base, [name.slice(name.lastIndexOf('.'))]).find((f) => f.endsWith(sep + name));
    if (hit) return hit;
  }
  return null;
}

/**
 * 生产可达性门禁。
 *
 * **为什么需要它**:本仓反复出现「完整实现、单测全绿、编排层不接」的缺陷
 * (典型:`combat/damage.ts` 约 2300 行、`wiring/components.ts` 40 项件;
 *  清单见 `docs/FOUNDATION-AUDIT.md` §3.5/§3.6)。
 * 每一例都是靠人工 grep 才发现的 —— 这类缺陷不会让任何测试变红,
 * 因为它压根不在生产路径上。没有本门禁,下一次同类缺陷仍要靠运气。
 *
 * **为什么报警告而不是 fail**:不可达有合理情形(客户端子系统在无装配入口的
 * 仓里必然不可达)。一上来 fail 会立刻被加白名单绕过,反而失去意义。
 * 所以:**先让它可见,再逐步收紧**。
 *
 * **但它不能是装饰**:故把「不可达模块数」本身做成断言 ——
 * 数字只在两种情况下允许变化:(a) 出白名单;(b) 真的接入编排。
 * 新造一个没人 import 的模块会让数字 +1,当场可察觉。
 */
function checkReachability(): void {
  console.log('\n[生产可达性]');
  const prodDirs = ['server/src', 'client/src'];
  const prodAll: string[] = [];
  for (const d of prodDirs) prodAll.push(...walk(join(ROOT, d), ['.ts']));

  const reach = reachableClosure(PROD_ENTRIES);
  const relOf = (p: string): string => relative(ROOT, p).split(sep).join('/');

  const unreachable = prodAll
    .map(relOf)
    .filter((r) => !reach.has(resolve(ROOT, r)))
    .sort();

  const entries = PROD_ENTRIES.filter((e) => existsSync(join(ROOT, e)));
  const missingEntries = PROD_ENTRIES.filter((e) => !existsSync(join(ROOT, e)));

  /* ── 客户端 HTML 入口与 PROD_ENTRIES 必须对得上 ──
     否则 HTML 改了 script 路径而入口没跟,整个客户端又会从闭包里掉出去
     —— 即 task-32 那次事故的复发路径。 */
  const htmlAbs = join(ROOT, CLIENT_HTML);
  if (!existsSync(htmlAbs)) {
    fail(`客户端 HTML 入口不存在:${CLIENT_HTML} —— 客户端可达性口径失效`);
  } else {
    const html = readFileSync(htmlAbs, 'utf8');
    if (!html.includes(CLIENT_HTML_ENTRY)) {
      fail(
        `${CLIENT_HTML} 里找不到 \`${CLIENT_HTML_ENTRY}\` —— HTML 入口与 `
        + `PROD_ENTRIES 的客户端入口已脱节(客户端会再次从可达闭包里消失)`,
      );
    }
  }

  /* ── 白名单自检(与 DECORATOR_EXEMPT 同一思路)── */
  const stale: string[] = [];
  /* 「理由过时」是**独立的一类**,与「条目失真」分开收集:
     条目可能完好(文件在、当前确实不可达),而理由描述的事实已经变了。
     旧自检只查前两类,因此抓不到它 —— 那正是 16 条 client/** 带着
     「本仓无装配入口」长期挂在表里的原因(task-32)。 */
  const staleReason: string[] = [];

  for (const [rel, reason] of UNREACHABLE_EXEMPT) {
    if (!existsSync(join(ROOT, rel))) {
      stale.push(`${rel}(文件不存在)`);
      continue;
    }
    if (!reason || reason.trim().length < 8) {
      stale.push(`${rel}(未写明理由)`);
      continue;
    }
    if (reach.has(resolve(ROOT, rel))) {
      stale.push(`${rel}(已可达,应移出白名单)`);
      continue;
    }
    /* ── 理由过时检测(新)── */
    for (const found of detectStaleReason(reason)) {
      staleReason.push(`${rel}(理由过时:${found})`);
    }
  }

  const unlisted = unreachable.filter((r) => !UNREACHABLE_EXEMPT.has(r));

  if (missingEntries.length > 0) {
    fail(`生产入口不存在(门禁口径失效):${missingEntries.join(', ')}`);
  } else if (stale.length > 0) {
    fail(`不可达白名单失真(${stale.length} 处,应修正):${stale.join('; ')}`);
  } else if (staleReason.length > 0) {
    fail(
      `不可达白名单**理由过时**(${staleReason.length} 处)—— 条目本身没失真,`
      + `但它写的事实已经变了,读者会据此低估欠账:${staleReason.slice(0, 4).join('; ')}`,
    );
  } else if (unlisted.length > 0) {
    /* 未登记的不可达模块 —— 本门禁的核心产出。
       默认只告警(见函数头注释),但 `--strict-reach` 会把告警升级为失败,
       否则「永远是警告」本身又会退化成一条不起作用的装饰。 */
    if (strictReach) {
      fail(
        `新增未登记的不可达模块 ${unlisted.length} 个(--strict-reach):`
        + `${unlisted.slice(0, 4).join(', ')}${unlisted.length > 4 ? ' …' : ''}`,
      );
    } else {
      console.warn(
        `  ⚠ 新增未登记的不可达模块 ${unlisted.length} 个(不在生产闭包内,需补白名单理由或接线):`,
      );
      for (const u of unlisted.slice(0, 12)) console.warn(`      · ${u}`);
      if (unlisted.length > 12) console.warn(`      … 另有 ${unlisted.length - 12} 个`);
    }
  }

  /* 数字可断言:不可达总数 + 未登记数都是硬数字,变化即可察觉。
     **必须无条件打印** —— 失败时(入口缺失/白名单失真)恰恰最需要知道
     总数有没有跟着变:那是区分「修复落地」和「有人动了别处」的唯一依据。 */
  const unreachableCount = unreachable.length;
  const wl = whitelistBreakdown();
  const summary =
    `生产可达性:可达 ${prodAll.length - unreachableCount} / 不可达 ${unreachableCount} `
    + `(共 ${prodAll.length},入口 ${entries.length} 个,白名单 ${UNREACHABLE_EXEMPT.size} 条)`
    + (unlisted.length > 0 ? ` —— 其中未登记 ${unlisted.length} 个` : '');
  /* 条数**取实测**,不写死 —— 旧版这里硬编码「50 条」,而白名单早已降到 43
     (WS-06 炼金 7 条接线后摘除),于是门禁自己印着一个过时数字。
     这与 README 的过时数字是同一类缺陷,只不过发生在**门禁的输出**里,
     更难被发现:读者倾向于相信门禁自己说的话。 */
  const breakdown =
    `        └─ 欠账构成(${UNREACHABLE_EXEMPT.size} 条全部待接,按卡点分类):等客户端入口 ${wl.clientShell}`
    + ` / 等编排层接线 ${wl.wiring} / 等服务端机制 ${wl.mechanism}`
    /* 「等外部依赖」与「未归类」**仅在非 0 时出现**:
       README 的固定四桶句式因此保持有效(不因 0 值桶而格式抖动),
       而一旦真有该类别欠账,它会立刻出现在输出里。 */
    + (wl.dependency > 0 ? ` / 等外部依赖 ${wl.dependency}` : '')
    + ` / 等裁决 ${wl.decision}`
    + (wl.other > 0 ? ` / 未归类 ${wl.other}` : '')
    /* 「等裁决 0」是分类顺序的产物而非测量结果 —— 必须显式说出来,
       否则读者会把它读成「没有等人拍板的事」。实测 43 条里 27 条
       (分类收窄后 35 条里 35 条)都满足「等裁决」的两个正则,却没有一条
       能落进该桶:它们全部被更具体的桶先抓走。 */
    + (wl.decisionShadowed > 0
      ? `\n  i         └─ 注:等裁决 ${wl.decision} 是**分类顺序**的结果 —— 另有 `
        + `${wl.decisionShadowed} 条也符合「等裁决」句式,但归入了上方更具体的桶;`
        + '故这个 0 不代表没有待裁决事项'
      : '');
  if (missingEntries.length === 0 && stale.length === 0) {
    pass(summary);
  } else {
    /* 失败路径也报数字;钉住它是为了让下方 fail 的编号不与绿色混淆 */
    console.log(`  ℹ ${summary}`);
  }
  /* 分类行**无条件打印**(通过也打):它承载「还欠多少接线」这个事实。
     若只在失败时打印,接线做完那天它就消失 —— 与 R6/S11 那个
     「数字只在绿灯时打印」是同一个坑,方向相反。 */
  console.log(`  i ${breakdown}`);
}

/* ───────────── 2.5 同义反复候选检查(S11)───────────── */

/**
 * 「同义反复候选」白名单。
 *
 * 条目格式:`<套件>::<常量名>` —— **必须带套件**。
 * 因为同一常量名可能在多个模块各有一份(`ICON_SIZE` 在 `pixel_icon.ts` 与
 * `entity_sprites.ts`、`DYE_PALETTE_SIZE` 在 `dye_overlay.ts` 与 `scoring.ts`),
 * 只按名字登记会张冠李戴。
 *
 * 本表登记的是**已知的**候选,不是「已确认为缺陷」的清单。
 * 门禁的产出是「**新出现的**未登记候选」—— 那才是回归信号。
 */
const TAUT_SUSPECT_EXEMPT = new Map<string, string>([
  /* ── WS-01 ──
     `OBSIDIAN_ID` 已修:原 :740 `eq(p.obj, OBSIDIAN_ID)` 恒真
     (fluid.ts:620 相变产物直取该常量),已改为字面量 110,故条目已移出。
     行为覆盖由 :679/:680 的字面量 110 守住,无缺口。 */
  /* ── WS-03 ── */
  ['WS-03::BLUEPRINT_SIZE', '已知:断言右侧取自 blueprint.ts,待换字面量'],
  /* ── WS-04 ── */
  ['WS-04::BEETLE_FRONT_DR', '已知:断言右侧取自 behaviors.ts,待换字面量'],
  ['WS-04::BOAR_WINDUP_SEC', '已知:断言右侧取自 behaviors.ts,待换字面量'],
  ['WS-04::CAPYBARA_REFLECT_HEARTS', '已知:断言右侧取自 behaviors.ts,待换字面量'],
  ['WS-04::GINGER_ESCAPE_SEC', '已知:断言右侧取自 behaviors.ts,待换字面量'],
  ['WS-04::KNIGHT_FRONT_DR', '已知:断言右侧取自 behaviors.ts,待换字面量'],
  ['WS-04::PROBE_READS_PER_STEP', '已知:测试把常量作为输入透传,待换字面量'],
  /* ── WS-05 ── */
  ['WS-05::FOX_CLONE_COUNT', '已知:断言右侧取自 phases.ts,待换字面量'],
  ['WS-05::SUMMON_ITEM_MAX', '已知:断言右侧取自 raid.ts,待换字面量'],
  ['WS-05::SUMMON_ITEM_MIN', '已知:断言右侧取自 raid.ts,待换字面量'],
  ['WS-05::TIME_SHIELD_SEC', '已知:断言右侧取自 phases.ts,待换字面量'],
  /* ── WS-06 ──
     本套件此前**对门禁完全不可见**(导入经 alchemy/index.ts 转发文件),
     修好键解析后才浮现。
     `ICON_SIZE` 是**混合性质**:552/553(比 schema 的 minItems/maxItems,
     而 prompt.ts 直取该常量)是真同义反复,**已改为字面量 16 + 锚定**;
     111/112(比 SILHOUETTE_ART 字面量美术的有牙齿断言)**保留**,故此项仍在候选集里。
     注入 16→8 实测:552 变红、111/112 变红 ⇒ 两条路径都有效。 */
  ['WS-06::ICON_SIZE', '已知:552/553 已改字面量;111/112 比 SILHOUETTE_ART 有牙齿,保留'],
  /* ── WS-07 ── */
  /* PROTOCOL_VERSION 已于本批修复(WS-07:861 改为字面量 1)—— 已移出白名单 */
  /* ── WS-09 ── */
  ['WS-09::A4_MIDI', '已知:断言右侧取自 audio.ts,待换字面量'],
  ['WS-09::ICON_SIZE', '已知:断言右侧取自 entity_sprites.ts,待换字面量'],
  ['WS-09::NO_DYE', '已知:断言右侧取自 dye_overlay.ts,待换字面量'],
  ['WS-09::PITCH_COUNT', '已知:断言右侧取自 audio.ts,待换字面量'],
  ['WS-09::ROOF_MIN_ALPHA', '已知:断言右侧取自 roof_transparency.ts,待换字面量'],
  ['WS-09::SLOTS_PER_ROW', '已知:断言右侧取自 inventory.ts,待换字面量'],
  /* ── WS-10 ── */
  ['WS-10::BASE_CRIT_DMG', '已知:断言右侧取自 weapons.ts,待换字面量'],
  ['WS-10::BUBBLE_TRAP_SEC', '已知:断言右侧取自 revive.ts,待换字面量'],
  ['WS-10::GHOST_MOVE_MUL', '已知:断言右侧取自 revive.ts,待换字面量'],
  /* `WS-10::REFLECT_RADIUS` 已移出:Lead 改成字面量 3 + `eq(REFLECT_RADIUS, 3)` 双重锚定。
     实证注入 3.0→6.0 ⇒ 44/44 变 43/44(修复前是 44/44 全绿)。 */
  /* ── WS-11 ── */
  ['WS-11::BEAVER_RECLAIM_QTY', '已知:断言右侧取自 rush_order.ts,待换字面量'],
  ['WS-11::BOMB_FUSE_SEC', '已知:测试把常量作为输入透传,待换字面量'],
  ['WS-11::CHAIN_BREAK_PENALTY', '已知:断言右侧取自 rush_order.ts,待换字面量'],
  ['WS-11::CROWN_PICKUP_COOLDOWN_SEC', '已知:断言右侧取自 modes.ts,待换字面量'],
  ['WS-11::HELMET_SELF_PARALYZE_SEC', '已知:断言右侧取自 toys.ts,待换字面量'],
  ['WS-11::MAILBOX_CAPACITY', '已知:断言右侧取自 afk.ts,待换字面量'],
  ['WS-11::SNOWBALL_FREEZE_SEC', '已知:断言右侧取自 toys.ts,待换字面量'],
  ['WS-11::Z2_REACH_TARGET', '已知:断言右侧取自 rush_order.ts,待换字面量'],
  /* ── WS-FND-01 ── */
  ['WS-FND-01::CONTENT_FINGERPRINT_VERSION', '已知:断言右侧取自 registry.ts,待换字面量'],
  /* ── WS-FND-02 ── */
  ['WS-FND-02::HISTORY_CAPACITY', '已知:断言右侧取自 bus.ts,待换字面量'],
  ['WS-FND-02::MAX_EVENTS_PER_FRAME', '已知:断言右侧取自 bus.ts,待换字面量'],
]);

/** 收集生产模块(server/src + client/src)的数值型导出常量:`<文件>::<名>` → 表达式。 */
function collectNumericExports(): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of ['server/src', 'client/src']) {
    for (const f of walk(join(ROOT, d), ['.ts'])) {
      const rel = relative(ROOT, f).split(sep).join('/');
      const code = stripCommentsAndStrings(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(/^export const (\w+)(?::\s*number)?\s*=\s*([^\n;]+);/gm)) {
        const expr = m[2].trim();
        if (/^[{['"`]/.test(expr) || /=>/.test(expr)) continue;
        if (!Number.isFinite(Number(expr))) continue;
        out.set(`${rel}::${m[1]}`, expr);
      }
    }
  }
  return out;
}

/**
 * 建立**转发链**映射:`<转发文件>::<导出名>` → `<定义模块>`。
 *
 * 用于解决「测试从 `index.ts` 导入,而常量定义在别处」。
 * `server/src/alchemy/index.ts` 是典型:零个 `export const`,却转发 155 个符号
 * (来自 gate/attributes/pixel_icon/prompt/degrade/cache 六个文件)。
 * WS-06 的 74 个导入**全部**指向它 —— 不解析这一层,该套件对门禁恒不可见。
 *
 * 只解析 `export { ... } from './x.ts'` 这一种形态(本仓唯一的转发写法)。
 * 多跳也正确处理:逐轮展开直到不再变化,带轮次上限防环。
 *
 * **必须用代码态扫描**(U12):旧版跑 `stripCommentsOnly` + 正则,于是
 * 字符串里的 `export { X } from './y.ts'` 会被当成真转发边,
 * 把 X 解析到错误模块 ⇒ 候选**静默消失**(实测 32 → 31)。
 */
function buildReexportMap(): Map<string, string> {
  const out = new Map<string, string>();
  const edges: { from: string; names: [string, string][]; to: string }[] = [];
  for (const d of ['server/src', 'client/src']) {
    for (const f of walk(join(ROOT, d), ['.ts'])) {
      const rel = relative(ROOT, f).split(sep).join('/');
      const dir = rel.slice(0, rel.lastIndexOf('/'));
      for (const blk of extractCodeStateBlocks(readFileSync(f, 'utf8'), 'export')) {
        let to = blk.spec.replace(/^\.\.\//, '');
        if (/^\.\//.test(to)) to = `${dir}/${to.slice(2)}`;
        else if (!/^(server|client)\//.test(to)) to = `${dir}/${to}`;
        if (!to.endsWith('.ts')) {
          if (existsSync(join(ROOT, `${to}.ts`))) to = `${to}.ts`;
          else if (existsSync(join(ROOT, `${to}/index.ts`))) to = `${to}/index.ts`;
          else continue;
        }
        const names: [string, string][] = [];
        for (const raw of blk.names.split(',')) {
          const p = raw.trim().split(/\s+as\s+/);
          const orig = p[0]!.trim().replace(/^type\s+/, '');
          const exported = (p[1] ?? p[0])!.trim().replace(/^type\s+/, '');
          if (/^[A-Za-z_]\w*$/.test(orig) && /^[A-Za-z_]\w*$/.test(exported)) names.push([exported, orig]);
        }
        edges.push({ from: rel, names, to });
      }
    }
  }

  /* 逐轮展开:若 e.to 自己也转发 orig,就继续下钻到更深的定义处 */
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    for (const e of edges) {
      for (const [exported, orig] of e.names) {
        const deeper = out.get(`${e.to}::${orig}`);
        const target = deeper ?? e.to;
        const key = `${e.from}::${exported}`;
        if (out.get(key) !== target) { out.set(key, target); changed = true; }
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 同义反复候选门禁(S11)。
 *
 * **为什么需要它**:`eq(x, CONST)` 里 `CONST` 若取自被测模块自身,而实现也读同一常量,
 * 那么把常量改成任何值两边都会同步移动 —— **断言恒真**。
 * `docs/ADVERSARIAL-REVIEW-2/3/4.md` 累计实证 21 处(WS-10 `REFLECT_RADIUS`、
 * WS-05 `BREAK_CRIT_BONUS` 等),最严重的是 WS-07 `PROTOCOL_VERSION`
 * (改成 7 而 132 条断言全绿 ⇒ 跨端静默不兼容)。
 *
 * **本门禁只报「候选」,不做「判定」** —— 这是刻意的,理由是实测:
 * 曾尝试加一条静态判据 P(「同套件内另有把该常量与数值字面量比对的断言」⇒ 有独立锚点),
 * 用 21 个已知真同义反复 + 9 个已知有牙齿的常量做交叉验证,结果
 * **P 误判 5/21、漏判 4/9** ⇒ 不等价,不能当判定器用。
 * 真正的判定只能靠注入法,那是人工流程。所以这里只保证「**新出现的候选**会被看见」。
 *
 * **为什么默认告警**:候选里有大量合法情形 —— 枚举成员比对、把常量作为输入透传
 * (`CRAB_SHELL_DR`)、以及值另被同套件字面量断言钉住的常量
 * (`BOAR_WINDUP_SEC` 注入实测变红)。一上来 fail 会立刻被整片加白名单绕过。
 *
 * **为什么仍然可信**:①候选数、白名单数都是硬数字,每次运行都打印;
 * ②`--strict-taut` 把未登记候选升级为失败;
 * ③白名单自检「已不再命中」—— 修好一处后**必须**移出白名单,否则报错,
 * 这使本表会随修复单调收缩,而不会烂在原地。
 */
/* ═════════════ 2.6 信任边界:安全判据不得取自客户端输入(S36)═════════════ */

/**
 * 「必须由服务端导出」的入参字段 —— 显式契约表。
 *
 * ## 为什么需要这张表
 *
 * 本章所有其它门禁查的都是「代码对不对」。但有一类缺陷**代码是对的、装配是错的**:
 *
 *   `server/src/net/room.colyseus.ts` 的 `onMessage` 处理函数
 *   把**客户端报文里的值**当作反作弊的**判据**传进去。
 *
 * 实测(2026-11-11)三处,全部通过 1141 条断言与 24 项集成门禁:
 * - `allowedSources: new Set(msg.allowedSources)` ⇒ 凭空产出检查
 *   (`checkInventory` 判 `allowedSources.has(source)`)**由客户端自带集合决定**;
 * - `capacity: msg.capacity` ⇒ 容量溢出检查形同虚设;
 * - `beforeTotal: msg.ops.reduce(...)` ⇒ 守恒律 `after = before + net >= 0`
 *   在「全扣减」时恒 `after ≡ 0`,**`ITEM_NEGATIVE` 分支不可达**。
 *
 * ## 判据为什么不是「语法」而是这张表
 *
 * 我试过纯语法判据「实参引用 msg ⇒ 命中」:它能命中上述 3 处、零误报,
 * 但它是**靠语法巧合成立**的 —— 反例就在同一文件:
 * `applyMove(client.sessionId, msg)` 与 `applyAttack(id, msg?.claimedBonus)`
 * 同样引用 msg 却漏掉,只因为它们是**位置参数**而非字段。
 *
 * 真正的区分是**语义**:同一个客户端值,
 * - 被服务端常数**界定**(如 `Math.min(speedMul, MAX_SPEED_BONUS_MUL)`)⇒ 可接受,它只是个「量」;
 * - 直接**充当判据**(如 `allowedSources.has(x)` 里它就是界定别人的东西)⇒ 致命。
 *
 * 纯文本无法区分「量」与「判据」,需要数据流分析。所以这里退一步:
 * **把契约写成显式表,并做「字段级」判定** ——
 * 取该字段在实参里的**取值表达式**,再判它是否引用了客户端数据。
 * (实参整体透传、字段名不出现时才回退接口级,保守多报。)
 *
 * ## 本门禁的已知边界(如实记录,不假装完整)
 *
 * 1. 字段级判定能分辨「未修 / 半修 / 真修」三态(实测:3/3、2/3、0/3)。
 *    但它只懂**单层**取值表达式;若某字段被多步加工(ctor 再传参),
 *    仍可能判错 —— 那需要真正的数据流分析。
 * 2. 修一条就移一条:门禁做**字段级**比对,某字段改成服务端取值后
 *    该条即变为「已登记但不再命中」⇒ 报「白名单失真,应移出」。
 *    (早期版本是接口级,导致「修好也看不出」的恒绿 —— 见下第 4 点。)
 * 3. 实参**整体透传**(如 `applyInventory(userId, input)`,字段名不出现)时
 *    字段级无法定位,此时**回退接口级** ⇒ 该汇点的全部受管字段一律计入命中,
 *    并在输出里单独打印「回退接口级 N 个汇点」。
 *
 *    ⚠️ 这条**曾经是空头承诺**:注释从第 12 批起就写着「回退接口级…保守多报,不漏」,
 *    而代码里只有 `if (!fm) continue;`,根本没有回退分支。第 13 批门禁审计
 *    (GATE-AUDIT-13 §D1)用 `inventory(userId, input as never)` 实测:
 *    退出码 0、打印「实测取自客户端 0 处」—— **把漏报显示成了好消息**。
 *    现在真的实现了回退(见 `checkClientTrust` 里的 `matched === 0` 分支)。
 * 4. **接口级恒绿的教训**(实测已确认):`ops: msg.ops` 是**合法且必须**的
 *    客户端输入(客户端提交要买/卖什么),所以「该接口引用客户端」答案**恒为是**。
 *    接口级判定**单独使用**时测不出任何东西 —— 判据的分辨率低于被测量。
 *    它比不装更危险:**让「已检查」看起来成立**。
 *    故接口级只作为**字段级的兜底**(仅在字段级完全无法定位时启用),
 *    不单独作为主判据。
 * 5. 受管字段表是**人工维护**的。新写一个 `onMessage` 处理函数时,
 *    如果它引入的服务端自有字段没进表,门禁看不到 —— 这是残余风险。
 *    缓解:`SERVER_OWNED_INPUTS` 与 `TRUST_EXEMPT` 就在本文件可读处,
 *    评审新 handler 时应一并检查。
 * 6. **契约表自身有双向自检**(第 13 批审计 D2 后补):表被清空、方法名拼错、
 *    条目被删、字段名在实参里找不到 —— 一律 fail。
 *    在此之前这些状态全部静默通过,于是「检查范围归零」也会显示绿色。
 */
const SERVER_OWNED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  /* 入参字段 → 为什么必须由服务端提供 */
  applyInventory: ['allowedSources', 'capacity', 'beforeTotal'],
};

/**
 * **必须受管**的汇点方法 —— `SERVER_OWNED_INPUTS` 的「应有键」参照。
 *
 * ## 为什么需要一份独立的名单(D2)
 *
 * 只用 `SERVER_OWNED_INPUTS` 自检有个盲点:若某条目被**整条删掉**,
 * 遍历「表里有什么」的检查全部跳过 —— 表没了,检查也没了,而门禁仍然绿。
 * 这和第 13 批审计里「白名单因改名而静默放宽」是同一形态。
 *
 * 所以「应有哪些键」必须来自**表之外**。这里的名单是刻意的短清单:
 * 只有那些**确认必须受管**的方法才登记;`applyMove` / `applyAttack`
 * **不在**此列 —— 因为它们的问题不是「取自客户端」(它们本就该接客户端输入),
 * 而是上游钳制口径,详见下方「本门禁的盲区登记」。
 *
 * 增加新 handler 时:若它引入服务端自有字段,同时加进本名单与
 * `SERVER_OWNED_INPUTS`;只加后者会被「多余键」检查放过,但**不加后者**
 * 会被「缺失键」检查抓住。
 */
const TRUST_MUST_MANAGE: readonly string[] = ['applyInventory'];

/**
 * ⚠️ **本门禁的盲区登记**(不是遗漏,是刻意划界)。
 *
 * `applyMove` / `applyAttack` **也**被上面的扫描正则覆盖,但它们**不在**
 * `SERVER_OWNED_INPUTS` 里 —— 因为它们的输入**本就该取自客户端**,
 * 问题不在「取自客户端」,而在别处。它俩分属两件不同性质的事(CR-14 U2):
 *
 * **U2-a —— 已裁决为「可接受的设计取舍」,不是缺陷。**
 * ```
 *   applyMove(client.sessionId, msg)          → 声明 2.55 ⇒ 上限抬到约 ×3.19 基线
 *   applyAttack(id, msg?.claimedBonus ?? 0)   → 声明 1.0 ⇒ 拿满 2× 攻速
 * ```
 * 上游只做**钳位**、不做自证:`WS-07-net-persist.md` §7 明确写「一律钳到上限,
 * **不自证**」。原因不是懒 —— 是服务端**物理上没有**可自证的数据:
 * `PlayerState` 只有 `weaponId`、无装备槽,`room.ts` 零穿戴状态,
 * `statsAtLevel` 不含任何速度字段。真做服务端核算需要「新增装备槽 +
 * 从零建服务端速度模型 + 穿戴追踪」,属跨 WS 结构性改动。
 *
 * 早先 `anticheat.ts:146` 的注释写「服务端会与服务端自己的账比对」,
 * 与 §7 矛盾 —— 那句注释**是错的**(已改写)。本注释早先也把它整体写成
 * 「确认为真缺陷」,同样过时,现已按裁决更正。
 * 该取舍由 `tests/WS-07.test.ts` 的 `WR-14 U2-a` 用例**钉住**:
 * 将来若真做服务端核算,该用例会变红提醒改口径。
 *
 * **U2-b —— 真缺陷,已修。**
 * `Math.max(0, {})` 得 `NaN` ⇒ `dist > NaN` 恒 false ⇒ 瞬移 / 窗口均速 /
 * 攻速**三道检查同时静默失效**,单帧跳 200 格直接放行。这与「上限多大」
 * 无关(即便上限设 1.0 也照样失守),属**判据本身被污染**,与 U1 同类。
 * 路径真实可达:`{"speedMul":{}}` 经 JSON 到 `onMessage`,TS 的类型标注
 * **不产生运行时校验**。已修(`sanitizeMul` 兜底 NaN 与 `-Infinity`;
 * `+Infinity` 故意不动 —— 它本来就被 `Math.min` 正确钳到上限)。
 *
 * 放这两个方法进受管表会**误报**(它们的输入本就合法)。所以显式记在这里,
 * 免得读者把「已登记 0 处」当成「这段没有欠账」。修法见 `CHANGE_REQUESTS.md` CR-14。
 */

/**
 * 已登记的存量违规:文件 → 方法 → 字段 → 为什么现在还不能修。
 *
 * 与 `UNREACHABLE_EXEMPT` 同一思路:**缺口要登记,不能靠门禁静默**。
 * 修掉一处就移出一处;门禁会报「已修复,应移出」。
 *
 * ## 已修复(CR-14 U1,2026-11-11)
 *
 * 原先登记的三条 —— `allowedSources` / `capacity` / `beforeTotal` —— **全部已修**:
 * `room.colyseus.ts` 只接受 `ops`,其余三个由 `RoomRuntime.applyInventory`
 * 从服务端状态派生(`grantedSourcesFor` / `authoritativeItemTotal` / `carryCapacityOf`)。
 * 出现在汇点的取值表达式已由 `input.*` 变为 `this.<服务端方法>(...)`,
 * 门禁据此报「登记失真」并**要求移出本表** —— 那次报错就是修复完成的证据。
 */
const TRUST_EXEMPT: ReadonlyArray<readonly [string, string, string, string]> = [];

/** 取出一个 `this.runtime.applyXxx(...)` 调用的实参文本(括号配对)。 */
function extractCallArgs(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

/**
 * 检查**反作弊汇点**的入参来源。
 *
 * ## 为什么查汇点而不查转发点(实测教训)
 *
 * 第一版查 `room.colyseus.ts` 里 `applyInventory(...)` 的实参 —— 那是**转发点**。
 * 转发点只传 `{ ops }`(客户端本来就该传 ops),判据根本不在那里:
 * 真正决定判据的是 `room.ts` 里 `this.ac.inventory(userId, {...})` 的实参 —— **汇点**。
 *
 * 查错位置的后果实测:**修好之后门禁仍报「取自客户端 3 处」**,
 * 修复者会以为没修好而反复折腾。这是「绿/红含义与看起来不同」的第二种形态:
 * 不只是「恒绿」,还有「红的位置不对」。
 *
 * ## 判据
 *
 * 汇点里每个受管字段的**取值表达式**,若形如 `input.X` / `msg.X` / `payload.X`
 * (即从客户端透传) ⇒ 命中;若形如 `this.<服务端方法>(...)` ⇒ 干净。
 */
function checkClientTrust(): void {
  console.log('\n[信任边界]');
  const SINK_FILE = 'server/src/net/room.ts';
  const SINK_CALLS = [
    { call: 'this.ac.inventory(', method: 'applyInventory' },
    { call: 'this.ac.move(', method: 'applyMove' },
    { call: 'this.ac.attack(', method: 'applyAttack' },
  ] as const;

  const abs = join(ROOT, SINK_FILE);
  if (!existsSync(abs)) {
    fail(`信任边界门禁无法执行:${SINK_FILE} 不存在 —— 口径失效`);
    return;
  }
  const src = stripCommentsOnly(readFileSync(abs, 'utf8'));

  /* 客户端来源的参数名:这些形参会从网络层透传进来。 */
  const clientParam = /\b(?:input|msg|pkt|payload|req)\b/;
  const found: { method: string; field: string; expr: string }[] = [];

  /* ── 契约表自检的收集桶(D2)──
     这张表是本门禁**唯一的判据来源**。它若被清空 / 拼错 / 删条,
     检查范围就静默归零,而门禁自己的自我描述仍然成立。
     另外三张白名单(DECORATOR_EXEMPT / UNREACHABLE_EXEMPT /
     TAUT_SUSPECT_EXEMPT)都有「失真即报错」的双向自检,唯独这张没有。
     这里补齐,并要求「登记了但没覆盖」也必须报错 —— 那是最隐蔽的一种。 */
  const methodUnknown: string[] = [];
  const sinkMissing: string[] = [];
  const fieldMissing: string[] = [];
  /** 整体透传(回退接口级)的方法名。 */
  const passthrough: string[] = [];

  const knownMethods = new Set<string>(SINK_CALLS.map((c) => c.method));
  for (const m of Object.keys(SERVER_OWNED_INPUTS)) {
    if (!knownMethods.has(m)) methodUnknown.push(m);
  }
  /* 应有键的**反向**检查:整条被删时上一条会静默通过(表都没了)。
     参照 `TRUST_MUST_MANAGE`,它独立于本表存在。 */
  for (const m of TRUST_MUST_MANAGE) {
    if (!(m in SERVER_OWNED_INPUTS)) fieldMissing.push(`${m} <契约条目被整条删除>`);
  }

  for (const { call, method } of SINK_CALLS) {
    const want = SERVER_OWNED_INPUTS[method];
    if (!want) continue;
    /* 空字段表 = 该汇点实际不受管,但读者会以为它在受管。 */
    if (want.length === 0) {
      fieldMissing.push(`${method} <字段表为空>`);
      continue;
    }
    const at = src.indexOf(call);
    if (at < 0) {
      sinkMissing.push(`${method}(${call.trim()})`);
      continue;
    }
    const args = extractCallArgs(src, at + call.length - 1);
    let matched = 0;
    const missed: string[] = [];
    for (const field of want) {
      const fm = new RegExp(`\\b${field}\\s*:\\s*`).exec(args);
      if (!fm) {
        /* 字段名在实参里找不到 ⇒ 这条契约是**死的**:
           读者以为该字段受管,门禁其实从没查过它。 */
        missed.push(field);
        continue;
      }
      matched += 1;
      /* 取该字段的取值表达式(括号配平,止于顶层逗号) */
      const from = fm.index + fm[0].length;
      let depth = 0;
      let end = args.length;
      for (let i = from; i < args.length; i += 1) {
        const c = args[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0 && c === ')') { end = i; break; }
          depth -= 1;
        } else if (c === ',' && depth === 0) { end = i; break; }
      }
      const expr = args.slice(from, end).trim();
      /* 判据:**取值表达式的根**是不是客户端形参。
         `input.ops` ⇒ 命中;`this.grantedSourcesFor(userId)` ⇒ 干净;
         `msg.ops.reduce(...)` ⇒ 命中(根是 msg)。 */
      if (clientParam.test(expr)) found.push({ method, field, expr });
    }
    /* ── D2:登记了但没覆盖 ⇒ 必须报错,不能 continue 静默跳过 ── */
    for (const f of missed) fieldMissing.push(`${method}.${f}`);

    /* ── D1:实参**整体透传**(对象整体递下去,字段名不出现)──
       此时字段级判定无从下手。旧版在这里静默 `continue`,
       于是 `inventory(userId, input)` 会报「实测 0 处」——
       **把漏报显示成好消息**。而这正是最需要报出来的形态:
       3 个受管字段全部失控。

       判据:一个字面字段都没匹配到,且实参里出现了客户端标识符
       (或实参根本不是对象字面量)。此时按**接口级**回退:
       把所有受管字段标记为「取自客户端」并置对应豁免状态。
       —— 这就是函数头 `:1176-1177` 一直承诺、但代码里从未实现的回退。 */
    if (matched === 0) {
      const looksLikeLiteral = /\{\s*$/.test(args.slice(0, 60));
      if (clientParam.test(args) || !looksLikeLiteral) {
        for (const field of want) {
          found.push({ method, field, expr: '<实参整体透传,回退接口级>' });
        }
        passthrough.push(`${method}(整体透传)`);
      }
    }
  }
  void passthrough;

  const key = (a: string, b: string) => `${a}::${b}`;
  const exemptSet = new Set(TRUST_EXEMPT.map(([f, mth, fld]) => key(f, mth, fld)));
  const foundSet = new Set(found.map((f) => key(SINK_FILE.replace('room.ts', 'room.ts'), f.method) + '::' + f.field));
  /* TRUST_EXEMPT 里的文件名是 room.colyseus.ts(历史位置),统一到汇点文件比较 */
  const normalizedExempt = new Set(TRUST_EXEMPT.map(([, mth, fld]) => key(mth, fld)));
  const normalizedFound = new Set(found.map((f) => key(f.method, f.field)));
  void foundSet;
  void exemptSet;

  const unlisted = [...normalizedFound].filter((k) => !normalizedExempt.has(k));
  const stale = [...normalizedExempt].filter((k) => !normalizedFound.has(k));

  const summary =
    `安全判据的信任边界:**汇点** ${SERVER_OWNED_INPUTS ? Object.keys(SERVER_OWNED_INPUTS).length : 0} 个 / `
    + `受管字段 ${Object.values(SERVER_OWNED_INPUTS).flat().length} 个 / `
    + `实测取自客户端 ${found.length} 处(已登记 ${TRUST_EXEMPT.length} 处)`;

  /* ── D2:契约表自检 —— 与另外三张白名单同款「失真即报错」──
     本表被清空 / 拼错 / 删条 / 字段名写错,判据来源就静默失效,
     而门禁仍会打印「已检查」。这些都必须 fail,不允许「数字变了但不红」。 */
  if (methodUnknown.length > 0) {
    fail(
      `信任边界契约表失真:登记了不存在的汇点方法 ${methodUnknown.join(', ')}`
      + ' —— 该条目永远不会被检查,属死的契约',
    );
  }
  if (sinkMissing.length > 0) {
    fail(
      `信任边界契约表失真:${sinkMissing.join(', ')}`
      + ' 在汇点文件里找不到 —— 汇点被改名/删除,而契约表还在,检查范围静默归零',
    );
  }
  if (fieldMissing.length > 0) {
    fail(
      `信任边界契约表失真:${fieldMissing.length} 个受管字段在汇点实参里找不到:`
      + fieldMissing.join(', ')
      + ' —— 读者以为它们受管,门禁其实从未查过(「定义了但没覆盖」)',
    );
  }

  if (unlisted.length > 0) {
    fail(
      `汇点里新增「安全判据取自客户端输入」${unlisted.length} 处(未登记):`
      + unlisted.join('; ')
      + ' —— 客户端可自行决定判据,等价于该检查不存在',
    );
  } else if (stale.length > 0) {
    fail(
      `信任边界登记失真(${stale.length} 处汇点已不取自客户端,应移出 TRUST_EXEMPT):`
      + stale.join('; '),
    );
  } else if (methodUnknown.length === 0 && sinkMissing.length === 0 && fieldMissing.length === 0) {
    pass(summary);
  }
  /* 整体透传必须可解释:它命中 ≥3 处,是**真报出来**的,不是静默跳过。
     这条无条件打印,免得读者以为「0 处」等于「没这回事」。 */
  if (passthrough.length > 0) {
    console.log(
      `  i         └─ 回退接口级 ${passthrough.length} 个汇点(实参整体透传,字段名不可见):${
        passthrough.join(', ')} —— 已按受管字段全量计入`,
    );
  }
  console.log(`  i         └─ 已登记欠账:${TRUST_EXEMPT.length} 处`);
}


function checkTautology(): void {
  console.log('\n[同义反复候选]');
  const numExports = collectNumericExports();
  const reexport = buildReexportMap();
  /* 沿转发链把「导入来源」解析到「常量定义模块」。
     查不到时回落到来源模块本身 —— 保持旧行为,不制造新键。 */
  const resolveDef = (sourceMod: string, name: string): string | null =>
    reexport.get(`${sourceMod}::${name}`) ?? null;

  const testsDir = join(ROOT, 'tests');
  const suiteFiles = walk(testsDir, ['.test.ts']);
  const found = new Map<string, { suite: string; mod: string }>();

  for (const tf of suiteFiles) {
    const suite = basename(tf).replace('.test.ts', '');
    const src = readFileSync(tf, 'utf8');
    const code = stripCommentsAndStrings(src);
    const lines = code.split('\n');

    /* 局部名 → 定义模块相对路径(剥注释 + 沿转发链解析,见 parseNamedImports) */
    const nameToMod = parseNamedImports(src, resolveDef);

    /* import 区行号(跳过) */
    const importLines = new Set<number>();
    let inImport = false;
    lines.forEach((l, i) => {
      if (/^\s*import\b/.test(l)) inImport = true;
      if (inImport) { importLines.add(i); if (/from\s*['"]/.test(l)) inImport = false; }
    });

    /* 正文实际引用到的生产常量名 —— 这一步把范围收窄到「本套件真的在乎」的常量。
       不做这一步会把其它模块导出的常量全算进来(实测误报率高 34:1,见 REVIEW-4 §3.1)。 */
    const bodyRefs = new Set<string>();
    lines.forEach((l, i) => {
      if (importLines.has(i)) return;
      for (const m of l.matchAll(/\b([A-Za-z_]\w*)\b/g)) if (nameToMod.has(m[1])) bodyRefs.add(m[1]);
    });

    lines.forEach((l, i) => {
      if (importLines.has(i)) return;
      for (const m of l.matchAll(/\b(?:eq|near)\s*\(\s*[^,]+,\s*([A-Za-z_]\w*)\s*[,)]/g)) {
        const cn = m[1];
        if (!bodyRefs.has(cn)) continue;
        const mod = nameToMod.get(cn)!;
        if (!numExports.has(`${mod}::${cn}`)) continue;
        found.set(`${suite}::${cn}`, { suite, mod });
      }
    });
  }

  /* ── 白名单自检 ── */
  const stale: string[] = [];
  for (const [key, reason] of TAUT_SUSPECT_EXEMPT) {
    const [suite, name] = key.split('::');
    if (!existsSync(join(ROOT, `tests/${suite}.test.ts`))) {
      stale.push(`${key}(套件文件不存在)`);
      continue;
    }
    if (!reason || reason.trim().length < 8) {
      stale.push(`${key}(未写明理由)`);
      continue;
    }
    if (!found.has(key)) {
      stale.push(`${key}(已不再命中,应移出白名单)`);
      continue;
    }
    if (name === undefined || name.length === 0) stale.push(`${key}(条目格式应为 套件::常量名)`);
  }

  const unlisted = [...found.keys()].filter((k) => !TAUT_SUSPECT_EXEMPT.has(k)).sort();

  if (stale.length > 0) {
    fail(`同义反复白名单失真(${stale.length} 处,应修正):${stale.join('; ')}`);
  } else if (unlisted.length > 0) {
    if (strictTaut) {
      fail(
        `新增未登记的同义反复候选 ${unlisted.length} 个(--strict-taut):`
        + `${unlisted.slice(0, 4).join(', ')}${unlisted.length > 4 ? ' ...' : ''}`,
      );
    } else {
      console.warn(`  ⚠ 新增未登记的同义反复候选 ${unlisted.length} 个(断言右侧取自被测模块导出常量):`);
      for (const u of unlisted.slice(0, 12)) {
        const [s, n] = u.split('::');
        console.warn(`      · ${s}  ${n}`);
      }
      if (unlisted.length > 12) console.warn(`      ... 另有 ${unlisted.length - 12} 个`);
    }
  }

  /* 数字**无条件打印** —— 与 R6 同理:失败路径最需要知道命中总数有没有变。
     失败时同时打印「未登记/失真」明细,不再二选一。 */
  const summary =
    `同义反复候选:命中 ${found.size} 条(白名单 ${TAUT_SUSPECT_EXEMPT.size} 条)`
    + (unlisted.length > 0 ? `,未登记 ${unlisted.length} 条` : '');
  if (stale.length === 0 && unlisted.length === 0) {
    pass(summary);
  } else if (stale.length === 0) {
    /* 有未登记但白名单健康:已在上方告警或 fail,这里补数字 */
    console.log(`  ℹ ${summary}(见上方明细)`);
  } else {
    console.log(`  ℹ ${summary}(白名单失真 ${stale.length} 处,见下方)`);
  }
}


/* ───────────────────── 3. 文档结构检查 ───────────────────── */

function checkDocs(): void {
  console.log('\n[文档结构]');
  const docsDir = join(ROOT, 'docs');
  const files = walk(docsDir, ['.md']).filter((f) => /WS-\d\d-/.test(f));
  if (files.length === 0) {
    console.log('  · 暂无 WS 文档(docs/WS-XX-*.md)');
    return;
  }
  const required = ['职责边界', '接口', '数据结构', '算法', '参数', '性能', '边界', '耦合', '验收', '未决'];
  let bad = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const missing = required.filter((k) => !text.includes(k));
    const rel = relative(ROOT, f).split(sep).join('/');
    if (missing.length > 0) {
      fail(`${rel} 缺章节关键词:${missing.join('/')}`);
      bad += 1;
    }
    if (text.length < 2000) {
      fail(`${rel} 篇幅不足(${text.length} 字符 < 2000),细化深度不够`);
      bad += 1;
    }
  }

  /* 交叉校验:每个有测试的 WS 都必须有对应文档。
     否则「只遍历已存在的文档」会让缺失的 WS 静默通过 —— 门禁假绿。 */
  const testDir = join(ROOT, 'tests');
  if (existsSync(testDir)) {
    const wsIds = new Set<string>();
    for (const t of walk(testDir, ['.test.ts'])) {
      const m = /WS-(\d\d)/.exec(basename(t));
      if (m) wsIds.add(m[1]);
    }
    const documented = new Set<string>();
    for (const f of files) {
      const m = /WS-(\d\d)-/.exec(basename(f));
      if (m) documented.add(m[1]);
    }
    const missingDocs = [...wsIds].filter((id) => !documented.has(id)).sort();
    if (missingDocs.length > 0) {
      fail(`有测试但缺文档:${missingDocs.map((id) => `WS-${id}`).join(' ')}`);
      bad += 1;
    }
    const orphanDocs = [...documented].filter((id) => !wsIds.has(id)).sort();
    if (orphanDocs.length > 0) {
      fail(`有文档但无测试:${orphanDocs.map((id) => `WS-${id}`).join(' ')}`);
      bad += 1;
    }
  }

  if (bad === 0) pass(`${files.length} 份 WS 文档结构完整,且与测试集合一一对应`);

  /* 非 WS 文档同样要守规矩。
     
     此前这里只过滤 `/WS-\d\d-/`,于是 `FLUID-BUDGET.md` / `DAMAGE-LOOP.md` /
     `EVENT-BUS.md` / `EXTENDING.md` / `SIM-orchestration.md` / `LEAD-PLAN.md` /
     `CHANGE_REQUESTS.md` **七份文档完全不受门禁约束** —— 写了什么都不会被检查。
     这和「文档声称 vs 代码实际」是同一类隐患:文档漂移没人发现。
     
     新增的两类文档(架构说明 + 变更记录)不需要 10 个章节关键词(它们不是
     WS 契约),但必须有实质内容,且**不能是空壳**。 */
  const nonWs = walk(docsDir, ['.md']).filter((f) => !/WS-\d\d-/.test(f));
  const MIN_NON_WS_CHARS = 1500;
  let badNonWs = 0;
  for (const f of nonWs) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f).split(sep).join('/');
    if (text.length < MIN_NON_WS_CHARS) {
      fail(`${rel} 篇幅不足(${text.length} 字符 < ${MIN_NON_WS_CHARS}),像占位而非文档`);
      badNonWs += 1;
    }
    /* 至少要有 3 个标题(二/三级均可)—— 空壳文档通不过这一条。
       不强制二级:`CHANGE_REQUESTS.md` 用 `###` 记录每条 CR(2 个 `##` +
       8 个 `###` + 16988 字符),那是合理结构,不该被判失败。 */
    const sections = (text.match(/^#{2,3}\s+\S/gm) ?? []).length;
    if (sections < 3) {
      fail(`${rel} 只有 ${sections} 个二/三级标题(< 3),结构不足以承载内容`);
      badNonWs += 1;
    }
  }
  if (badNonWs === 0 && nonWs.length > 0) {
    pass(`${nonWs.length} 份非 WS 文档有实质内容(≥${MIN_NON_WS_CHARS} 字符、≥3 节)`);
  }

  /* 交叉校验:文档里指向其它文档的相对链接必须真的存在。
     `SIM-orchestration.md` 引用 `FLUID-BUDGET.md` 这类链接一旦失效,
     读文档的人会找不到文件 —— 而没有任何测试会红。 */
  let brokenLinks = 0;
  for (const f of walk(docsDir, ['.md'])) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f).split(sep).join('/');
    for (const m of text.matchAll(/\]\(([A-Za-z0-9_.-]+\.md)\)/g)) {
      const target = join(docsDir, m[1]);
      if (!existsSync(target)) {
        fail(`${rel} 链接到不存在的文档:${m[1]}`);
        brokenLinks += 1;
      }
    }
  }
  if (brokenLinks === 0) pass('文档间的相对链接全部有效');

  /* 未决台账:文档里不许留「说过时话」的条目

     这一条守的是一类不报错的漂移:`docs/*.md` 的「未决」章节写着
     「XX 未实现」,而代码里早已实现。没有任何测试会因此变红,
     但读文档的人(包括未来的自己)会在错误的心智模型上做决策。

     首次启用即抓到 3 条:`SIM-orchestration` US1/US3、`EVENT-BUS` U5。
     检测表在 `scripts/backlog.ts` 的 `STALE_PROBES` —— 关掉一条未决项时
     把探针登记进去,未来回退时就会自动报红。 */
  let staleCount = 0;
  for (const s of detectStale()) {
    fail(`${s.doc} ${s.id} 是过时条目:${s.why} —— 描述与代码不符,应更新或标记关闭`);
    staleCount += 1;
  }
  if (staleCount === 0) {
    const open = collectOpenItems().filter((i) => !i.closed).length;
    pass(`未决台账无过时条目(${open} 条未关闭)`);
  }
}

/* ───────────────────── 4. 跨 WS 集成门禁 ───────────────────── */

/**
 * 单元测试证明「每个模块自己是对的」,但证明不了「它们能一起跑」。
 *
 * 交付后审计发现:677 条断言全绿的同时,全仓跨 WS 的 import 只有 1 处,
 * 没有任何代码同时驱动地形/物理/电路/生物 —— **世界从未跑起来过**。
 * 各套件都只在自己建的对象上断言,这是单元测试的正常形态,
 * 但它留下一个结构性的盲区:契约断裂(参数顺序、容器类型、调用顺序)
 * 恰恰只在**跨模块**时才暴露。
 *
 * 这一节把「世界能跑」变成门禁的一部分:
 *   1. 编排层可实例化 —— 全部子系统能同时构造,不因参数不匹配而抛;
 *   2. 双频节奏正确 —— 慢帧数恰为快帧数的 1/10;
 *   3. 各子系统真的在动 —— 刚体数、流体总量、通电格数、活跃生物数都非空;
 *   4. 确定性 —— 同种子两次运行终态逐字节一致;
 *   5. 跨 WS 接线存在 —— 编排层至少 import 3 个不同 WS 的模块。
 */
async function checkIntegration(): Promise<void> {
  console.log('\n[跨 WS 集成]');
  const passAtStart = passes;

  let sim: Awaited<typeof import('../server/src/sim/world_sim.ts')>;
  try {
    sim = await import('../server/src/sim/world_sim.ts');
  } catch (e) {
    fail(`编排层无法加载:${(e as Error).message}`);
    return;
  }

  const { WorldSim, FAST_PER_SLOW } = sim;
  const { WireColor } = await import('../shared/types/tile.ts');

  /* 0. 文档-代码一致性(**静态检查,必须先跑**)

     `fluid.ts` 顶部设计说明曾声称「向下优先(重力满流量),水平按位势差减半扩散」,
     而实现里对应那个形参(`vertical: boolean`)**一次都没被读**——
     竖直边与水平边走同一段代码。这类「文档说有、代码没有」的漂移不会让任何
     测试变红,却会让后来的人在错误的心智模型上改代码。

     **放在最前面是因为它是纯文本检查,不依赖运行时。** 若排在流体调用之后,
     一旦真的有人把那个形参加回去(且忘了传参),前面的代码会先抛异常,
     这条门禁就被跳过,报出来的是堆栈而不是真正的原因。 */
  const fluidSrc = readFileSync(join(ROOT, 'server', 'src', 'world', 'fluid.ts'), 'utf8');
  /* 只在**代码**里找 —— 注释里提到它是正常的(那里在解释为什么删掉它) */
  const fluidCode = stripCommentsAndStrings(fluidSrc);
  if (/vertical/.test(fluidCode)) {
    fail('fluid.ts 的**代码**里出现了 `vertical` —— 该形参曾是死参数,若重新引入必须真的被使用');
  } else if (!/elev\[i\] \* \(CAP \+ 1\)/.test(fluidSrc)) {
    fail('找不到 `elev × (CAP+1)` 的水面台阶模型 —— 「先向低处流」的机制可能已被改掉');
  } else {
    pass('文档与代码一致:重力由 elev 层差表达,代码里无死分支');
  }

  /** 建一个内容确定的演示世界。 */
  const build = (): InstanceType<typeof WorldSim> => {
    const s = new WorldSim({ sizeCells: 64 });
    s.fillRect(8, 8, 39, 39, { floor: 1, elev: 1 });
    for (let y = 30; y < 34; y += 1) for (let x = 30; x < 34; x += 1) s.fluid.addWater(x, y, 4);
    for (let x = 10; x < 20; x += 1) s.wiring.addWire(x, 10, WireColor.RED);
    s.addWireDrive(10, 10, WireColor.RED, true);
    s.addPlayer('p1', 12, 12);
    s.addPlayer('p2', 20, 14);
    s.addMob('m1', 'PLAINS', 16, 18);
    s.addMob('m2', 'PLAINS', 18, 18);
    return s;
  };

  /* 1. 实例化:全部子系统同时构造 */
  let s: InstanceType<typeof WorldSim>;
  try {
    s = build();
    pass('编排层可实例化(地形/物理/流体/电路/AOI/刷怪 同时构造)');
  } catch (e) {
    fail(`编排层构造失败:${(e as Error).message}`);
    return;
  }

  /* 2. 双频节奏:20Hz 与 2Hz 的比值必须是 **10**。
     注意这里把 10 写死而**不能**用 `FAST_PER_SLOW` 去算期望值 —— 
     那样两边同源,改常量会让断言与实现一起变,永远相等(同义反复,
     曾经真的这样写过,注入 `FAST_PER_SLOW *= 2` 都测不出来)。
     10 来自手册 §2.1 的 20Hz / 2Hz,是外部事实,应当硬编码。 */
  const TOTAL = 200;
  const { frames, slowFrames } = s.run(TOTAL);
  const HZ_FAST = 20;
  const HZ_SLOW = 2;
  const expectSlow = (TOTAL / (HZ_FAST / HZ_SLOW)) | 0;
  if (FAST_PER_SLOW !== HZ_FAST / HZ_SLOW) {
    fail(`快慢比例常数 ${FAST_PER_SLOW} ≠ 手册规定的 ${HZ_FAST}/${HZ_SLOW} = ${HZ_FAST / HZ_SLOW}`);
  } else if (slowFrames !== expectSlow) {
    fail(`慢帧数 ${slowFrames} ≠ 期望 ${expectSlow}(${TOTAL} 帧 @ 20Hz 应对应 ${expectSlow} 个 2Hz 慢帧)`);
  } else {
    pass(`双频节奏正确:${frames} 快帧 / ${slowFrames} 慢帧 = ${FAST_PER_SLOW}:1`);
  }
  if (s.frame !== TOTAL) fail(`帧序 ${s.frame} ≠ ${TOTAL}`);
  else pass(`帧序单调推进至 ${s.frame}`);

  /* 2b. 模拟时间必须按快帧单位换算。
     帧序永远是快帧计数,所以任意一帧的 `simSeconds` 恒为 `frame / 20` —— 
     即使这一帧同时是慢帧。曾经写成 `isSlow ? frame / SLOW_TICK_HZ : frame / TICK_HZ`,
     慢帧那一支除以 2 而不是 20,时间**快了 10 倍**(第 10 帧报 5.00s,真值 0.5s)。
     单独验一条,避免这类「相位分支污染时间基」的错误再次溜过。 */
  const tsim = build();
  let timeOk = true;
  let timeDetail = '';
  for (let i = 0; i < 25; i += 1) {
    const r = tsim.tick();
    const want = r.frame / HZ_FAST;
    if (Math.abs(r.simSeconds - want) > 1e-12) {
      timeOk = false;
      timeDetail = `第 ${r.frame} 帧(${r.phase})报 ${r.simSeconds},应为 ${want}`;
      break;
    }
  }
  if (timeOk) pass(`模拟时间基正确:任意帧 simSeconds = frame / ${HZ_FAST}(慢帧也不例外)`);
  else fail(`模拟时间基错误:${timeDetail}`);

  /* 3. 各子系统真的在动 —— 空跑不报错是最容易蒙混过关的假绿。
     注意区分**注册数**与**活跃数**:`snapshot().mobs` 是已注册生物数,
     即使 AOI 从不唤醒它也是非零。要证明生态在跑,必须看真正被
     唤醒并推进的数量,那是 `report.activeMobs`。 */
  const totalActive = s.run(TOTAL).reports.reduce((n, r) => n + r.activeMobs, 0);
  const snap = s.snapshot();
  const checks: [string, boolean, string][] = [
    ['物理刚体', snap.bodies === 4, `期望 4 个(2 玩家 + 2 生物),实际 ${snap.bodies}`],
    ['地形 Chunk', snap.chunks > 0, `期望 > 0,实际 ${snap.chunks}`],
    ['流体总量', snap.fluidTotal > 0, `期望 > 0,实际 ${snap.fluidTotal}`],
    ['电路通电格', snap.wireCells > 0, `期望 > 0(布线且已驱动),实际 ${snap.wireCells}`],
    ['AOI 唤醒', totalActive > 0, `期望 > 0(生物被 AOI 唤醒并推进),实际 ${totalActive}`],
  ];
  for (const [name, okFlag, detail] of checks) {
    if (okFlag) pass(`${name}在动:${detail.replace(/^期望/, '')}`);
    else fail(`${name}未动:${detail}`);
  }

  /* 4. 确定性 */
  const a = build();
  const b = build();
  a.run(300);
  b.run(300);
  const sa = JSON.stringify(a.snapshot());
  const sb = JSON.stringify(b.snapshot());
  if (sa !== sb) fail(`同种子两次运行终态不一致:\n      A=${sa}\n      B=${sb}`);
  else pass('确定性:同种子两次运行 300 帧后终态逐字节一致');

  /* 5. 跨子系统状态同步:地形写一处必须投影到另一处。
     `WorldGrid`(位平面)与 `FluidField`(自己的 solid/elev/base 数组)是
     两套独立影子状态,只写前者会让水**永远不扩散**且总量恒定不变 —— 
     没有任何异常,只是模拟结果静默地不合理。这里验证投影真的生效。 */
  const proj = new WorldSim({ sizeCells: 64 });
  /* 左半 elev=2 高地,右半 elev=0 低地,水灌在高地上 */
  proj.fillRect(20, 20, 31, 50, { elev: 2 });
  proj.fillRect(32, 20, 50, 50, { elev: 0 });
  proj.fluid.addWater(30, 32, 500);
  const before = proj.fluid.total();
  proj.run(200);
  const high = proj.fluid.amountAt(30, 32);
  const low = proj.fluid.amountAt(33, 32);
  const after = proj.fluid.total();
  if (low <= 0) fail(`地形→流体投影未生效:低地 (33,32) = ${low},水没有顺落差流过去`);
  else if (high >= 500) fail(`水没有离开高地:(30,32) 仍为 ${high}`);
  else pass(`地形→流体投影生效:高地 → 低地(落差倾泻,(33,32) = ${low})`);
  if (after !== before) fail(`流体不守恒:${before} → ${after}`);
  else pass(`流体守恒:${before} → ${after}`);

  /* 6. 单机确定性 + 反向约束:水不上坡 */
  const uphill = new WorldSim({ sizeCells: 64 });
  uphill.fillRect(20, 20, 31, 50, { elev: 2 });
  uphill.fillRect(32, 20, 50, 50, { elev: 0 });
  uphill.fluid.addWater(34, 32, 500);
  uphill.run(200);
  const uphillHigh = uphill.fluid.amountAt(30, 32);
  if (uphillHigh !== 0) fail(`水逆流上坡:(30,32) = ${uphillHigh},应为 0`);
  else pass('方向约束正确:低处的水不会爬升到高地');

  /* 7. 跨 WS 接线:编排层必须真的消费多个 WS,而不是只剩一层壳 */
  const src = readFileSync(join(ROOT, 'server', 'src', 'sim', 'world_sim.ts'), 'utf8');
  const wsDirs = new Set<string>();
  for (const m of src.matchAll(/from\s+'(\.\.\/)+([a-z_]+)\//g)) wsDirs.add(m[2]);
  const wanted = ['world', 'physics', 'wiring', 'mobs', 'events'];
  const missing = wanted.filter((d) => !wsDirs.has(d));
  if (missing.length > 0) fail(`编排层未接入这些 WS 目录:${missing.join(', ')}(集成会退化成空壳)`);
  else pass(`跨 WS 接线完整:${wanted.join(' / ')} 五个子系统均由编排层驱动`);

  /* 8. 事件总线真的被 drain(接线检查的最后一段)
     
     「编排层 import 了 events 目录」≠「它真的在投递事件」。前者是语法事实,
     后者才是行为事实 —— 而这两者之间正是假绿的常见位置:
     写了 import、建了实例、却忘了每帧 drain,于是事件永远 pending。 */
  const bush = new WorldSim({ sizeCells: 32 });
  bush.addPlayer('p1', 16, 16);
  const N = 40;
  for (let i = 0; i < N; i += 1) bush.tick();
  if (bush.bus.snapshot().totals.frames !== N) {
    fail(`事件总线未被每帧 drain:${N} 次 tick 仅 ${bush.bus.snapshot().totals.frames} 次投递`);
  } else {
    pass(`事件总线每帧投递:${N} 次 tick = ${N} 次 drain`);
  }
  /* 更进一步:一个手动 emit 的事件必须在下一 tick 前被清掉 */
  bush.bus.emit('probe', {}, 'verify');
  if (bush.bus.pending !== 1) fail(`emit 未入队:pending = ${bush.bus.pending}`);
  else {
    bush.tick();
    if (bush.bus.pending !== 0) fail(`事件未被当帧投递:pending 仍为 ${bush.bus.pending}(会无限堆积)`);
    else pass('事件当帧投递:不留到下一帧');
  }

  /* 9. 生物 AI 生产可达 —— 此前是空回调
     
     这一条守的是本项目最隐蔽的一类缺口:代码完整、单测全绿、
     但**生产路径从未执行**。实测证据:25 个 AI 的 tick 实现、
     MobFsm 的完整实现,在生产里调用次数为 0。 */
  const mhost = new WorldSim({ sizeCells: 48 });
  mhost.addPlayer('p1', 24, 24);
  mhost.addMob('mob_pangolin', 'MEADOW', 24, 25);
  for (let i = 0; i < 100; i += 1) mhost.tick();
  if (mhost.mobHost.totals.ticks <= 0) {
    fail('生物 AI 生产不可达:100 帧内宿主推进 0 次(编排层可能退回了空回调)');
  } else {
    pass(`生物 AI 生产可达:100 帧推进 ${mhost.mobHost.totals.ticks} 次`);
  }
  if (mhost.mobErrors !== 0) {
    fail(`生物 AI 抛错 ${mhost.mobErrors} 次(宿主可能缺少 AI 需要的字段)`);
  } else {
    pass('生物 AI 零抛错');
  }
  /* 移动权威(方案 D):FSM 做**基础移动**,AI 做**专属动作**,位置恒同步

     这条断言被改过。原来它守的是「宿主绝不调用 fsm.tick」——
     那个保守选择有致命后果:实测 **22/24 生物 60 秒位移为 0**,
     与玩家在不在场无关(它们连游荡都不会,因为游荡逻辑只在 FSM 里)。
     而单独跑 `fsm.tick()` 120 帧能走 5.44 格并会追猎。

     所以正确的不变量不是「不调用」,而是「调用之后位置不分叉」:
     AI 写了位置就以 AI 为准并把 FSM 同步过去,没写就保留 FSM 的位移。
     分叉才是「生物瞬移」的真正成因。 */
  const rts = mhost.mobHost.runtimes();
  const fsmTicksAfter = rts.reduce((n, rt) => n + rt.fsm.ticks, 0);
  const maxDrift = rts.reduce(
    (m, rt) => Math.max(m, Math.abs(rt.x - rt.fsm.x), Math.abs(rt.y - rt.fsm.y)),
    0,
  );
  if (fsmTicksAfter === 0) {
    fail('宿主从未推进 FSM —— 生物的游荡逻辑只存在于 FSM 里,后果是 22/24 种生物原地不动');
  } else if (maxDrift > 1e-6) {
    fail(
      `FSM 与 rt 位置分叉(最大偏差 ${maxDrift.toFixed(3)})—— ` +
        `两条移动轨迹会越走越远,表现是生物瞬移`,
    );
  } else {
    pass(
      `移动权威一致:FSM 推进 ${fsmTicksAfter} 次 / 位置零分叉 / ` +
        `基础移动 ${mhost.mobHost.totals.fsmMoves} 次 + AI 接管 ${mhost.mobHost.totals.aiOverrides} 次`,
    );
  }

  /* 10. AI 真的看得见玩家
     
     这一条守的是一个**完全不报错**的缺口:25 个 AI 的
     `BaseMobAi.nearest()` 只读 `world.players()`。若编排层忘了同步
     (或把生物也当成玩家),表现分别是「所有追猎行为永不触发」
     和「生物互相视为猎物」—— 两者都不抛异常,只是行为全错。
     实测未同步时 `mob_boar` 的 mem 是 `{}`(AI 跑了但每次判断
     「附近有玩家吗」都得到「没有」)。 */
  const pvis = new WorldSim({ sizeCells: 48 });
  pvis.addPlayer('p1', 24, 24);
  pvis.addMob('mob_boar', 'MEADOW', 29, 24);
  pvis.addMob('mob_sheep', 'MEADOW', 30, 24);
  const seenPlayers = pvis.mobHost.players();
  if (seenPlayers.length !== 1 || seenPlayers[0].id !== 'p1') {
    fail(
      `AI 眼中的玩家列表错误:期望 [p1],实际 [${seenPlayers.map((p) => p.id).join(', ')}]` +
        `(含生物 = 生物互相当猎物;为空 = 追猎永不触发)`,
    );
  } else {
    pass('AI 可见玩家且不含生物');
  }
  for (let i = 0; i < 60; i += 1) pvis.tick();
  const boarRt = pvis.mobHost.runtimeOf('mob_boar');
  const boarMem = boarRt ? Object.keys(boarRt.mem) : [];
  if (boarMem.length === 0) {
    fail('AI 未产生任何状态:有玩家在旁却 mem 为空,说明 AI 判断「附近没玩家」');
  } else {
    pass(`AI 响应玩家:野猪进入状态机(${boarMem.slice(0, 4).join(', ')}…)`);
  }

  /* 11. 伤害闭环:生物的攻击真的能打到玩家
     
     这一条守的是「AI 产出预警几何 → 有人结算」这段。缺它的表现是
     `WarnGeom` 被造出来又扔掉:生物围着你打、血条不动、不报错。 */
  const dmg = new WorldSim({ sizeCells: 48 });
  dmg.addPlayer('p1', 24, 24);
  dmg.addMob('mob_lava_elem', 'MEADOW', 24, 26);
  for (let i = 0; i < 400; i += 1) dmg.tick();
  const dv = dmg.vitals.get('p1');
  if (!dv) {
    fail('玩家未被登记到 vitals —— 生物攻击将永远不掉血');
  } else if (dmg.hitCount === 0) {
    fail('生物在旁 400 帧零命中:预警几何未被结算(见 combat/vitals.ts)');
  } else {
    pass(`伤害闭环可达:岩元素命中 ${dmg.hitCount} 次,掉血 ${dv.totalTaken}`);
  }

  /* 12. 对照:没有生物时玩家不掉血 */
  const calm = new WorldSim({ sizeCells: 48 });
  calm.addPlayer('p1', 24, 24);
  for (let i = 0; i < 400; i += 1) calm.tick();
  const cv = calm.vitals.get('p1');
  if (!cv || calm.hitCount !== 0 || cv.hp !== cv.maxHp) {
    fail(`无生物却掉血(hp=${cv?.hp},命中=${calm.hitCount})—— 伤害结算误伤了空世界`);
  } else {
    pass('对照通过:无生物时满血');
  }

  /* 11b. 生物**真的会动**(方案 D 的核心外部事实)

     这条守的是本项目最隐蔽的一类缺口:子系统全部实现、单测全绿、
     宿主也接上了,但**生物永远站着**。实测:
       · 启用方案 D 前:**22/24** 生物 60 秒位移为 0,与玩家在不在场无关;
       · 原因:游荡逻辑只在 `MobFsm.tick()` 里,而宿主从不调用它
         (当时怕「两个移动权威」);
       · 启用后:22/24 恢复游荡(约 1.8 格/60 秒)且有玩家时追猎(约 15 格)。

     判据用「位移」这个外部事实,不用任何实现常量。 */
  const mover = new WorldSim({ sizeCells: 64 });
  mover.addPlayer('p1', 30, 30);
  for (const id of ['mob_sheep', 'mob_boar', 'mob_tanuki', 'mob_scorpion', 'mob_glow_frog']) {
    mover.addMob(id, 'PLAINS', 38, 38);
  }
  const startPos = new Map<string, { x: number; y: number }>();
  for (const id of ['mob_sheep', 'mob_boar', 'mob_tanuki', 'mob_scorpion', 'mob_glow_frog']) {
    const r = mover.mobHost.runtimeOf(id)!;
    startPos.set(id, { x: r.x, y: r.y });
  }
  for (let i = 0; i < 300; i += 1) mover.tick();
  let movedCount = 0;
  for (const [id, p0] of startPos) {
    const r = mover.mobHost.runtimeOf(id)!;
    if (Math.hypot(r.x - p0.x, r.y - p0.y) > 0.5) movedCount += 1;
  }
  if (movedCount === 0) {
    fail(
      `5 只生物 300 帧全部原地不动 —— 游荡逻辑未生效(方案 D 的 FSM 基础移动可能又断了)`,
    );
  } else {
    pass(`生物会动:300 帧内 ${movedCount}/5 只产生位移(游荡或追猎)`);
  }

  /* 11c. 举投**经编排层可达**(而不是只在单测里可用)

     这一条守的是本项目反复出现的一类缺口:**子系统完整实现、单测全绿、
     但编排层从不调用**。实测过两次:
       · 25 个 AI 的 `tick` 生产调用次数 0;
       · `CarrySystem` —— `this.carry = new CarrySystem(new Map())` 是一份
         **与物理无关的空表**,玩家从未注册,`this.carry.xxx()` 调用点 **0 个**。

     后者更隐蔽:WS-02 的 43 条断言全绿,因为它们直接 `new CarrySystem(map)`
     测,从不经编排层。所以判据必须是**经 `WorldSim` 走一遍全流程**。 */
  const cs = new WorldSim({ sizeCells: 48 });
  cs.addPlayer('a', 10, 10);
  cs.addPlayer('b', 10.5, 10);
  const liftVerdict = cs.lift('a', 'b');
  if (liftVerdict !== CarryReject.OK) {
    fail(
      `举投经编排层不可达:lift(a,b) = ${liftVerdict}(应为 OK)` +
        ` —— 玩家可能又没接进 CarrySystem(空 Map 的老问题)`,
    );
  } else {
    const chain = cs.carryChain('a');
    const topZ = chain.length > 0 ? chain[chain.length - 1].z : -1;
    const mul = cs.carrySpeedMul('a');
    /* 链高度与移速系数是手册的外部数值(Z 步长 0.85,2 层系数 0.85) */
    if (Math.abs(topZ - 0.85) > 1e-6) {
      fail(`链高度错:链尾 z = ${topZ}(手册步长 0.85)`);
    } else if (Math.abs(mul - 0.85) > 1e-6) {
      fail(`负重移速系数错:2 层 = ${mul}(应为 0.85)`);
    } else {
      pass(`举投可达:链尾 z=${topZ.toFixed(2)} / 移速 ×${mul.toFixed(3)}`);
    }
  }

  /* 冷却必须会被推进 —— `CarrySystem.tick` 只递减冷却表,
     漏掉它的后果是「投掷一次后永久不能再投」,且不抛错。 */
  const cs2 = new WorldSim({ sizeCells: 48 });
  cs2.addPlayer('a', 10, 10);
  cs2.addPlayer('b', 10.5, 10);
  cs2.lift('a', 'b');
  const thrown = cs2.throwPlayer('a', 1, 0);
  if (thrown === null) {
    fail('投掷不可达:throwPlayer 返回 null(链上不足 2 人?)');
  } else if (!cs2.carry.isOnCooldown('a')) {
    fail('投掷后未进入冷却 —— 投掷会变成无限连发');
  } else {
    /* 手册 §2.2 的投掷初速度:水平 8.5 格/秒、垂直 +6.0 格/秒 */
    const okSpeed = Math.abs(thrown.vx - 8.5) < 1e-6 && Math.abs(thrown.vz - 6.0) < 1e-6;
    for (let i = 0; i < 40; i += 1) cs2.tick();
    if (!okSpeed) {
      fail(`投掷初速度不符手册 §2.2:vx=${thrown.vx} vz=${thrown.vz}(应 8.5 / 6.0)`);
    } else if (cs2.carry.isOnCooldown('a')) {
      fail('冷却 2 秒后仍未解冻 —— `CarrySystem.tick` 没有被每帧推进');
    } else {
      pass(`投掷闭环:vx=${thrown.vx} vz=${thrown.vz}(手册 §2.2)/ 冷却可解冻`);
    }
  }

  /* 11d. 每个**有状态子系统**每帧真的被推进了

     这一条把「生产可达性」从手工抽查变成常驻门禁 —— 上面 11c 那条
     (举投)就是靠人工发现的,而这类缺口在本项目已出现**三次**:
       · 25 个 AI 的 `tick` 生产调用 0 次;
       · `fsm.tick()` 生产调用 0 次 → 22/24 生物永远站着;
       · `CarrySystem` 拿到空 Map + 0 个调用点 → 举投不可达。

     判据是「调用计数 > 0」——外部可观测,不依赖实现常量。 */
  const drv = new WorldSim({ sizeCells: 48 });
  drv.addPlayer('p1', 10, 10);
  drv.addMob('m1', 'PLAINS', 14, 14);
  const counts = new Map<string, number>();
  const watchSub = (key: string, method: string): void => {
    const obj = (drv as unknown as Record<string, Record<string, unknown>>)[key];
    if (!obj || typeof obj[method] !== 'function') return;
    const fn = obj[method] as (...a: unknown[]) => unknown;
    counts.set(`${key}.${method}`, 0);
    obj[method] = function patched(this: unknown, ...args: unknown[]): unknown {
      counts.set(`${key}.${method}`, (counts.get(`${key}.${method}`) ?? 0) + 1);
      return fn.apply(this, args);
    };
  };
  watchSub('fluid', 'step');
  watchSub('wiring', 'tick');
  watchSub('carry', 'tick');
  watchSub('mobHost', 'tickMobs');
  watchSub('vitals', 'stepTimers');
  watchSub('physics', 'step');
  watchSub('bus', 'drain');
  watchSub('spawner', 'canSpawn');
  for (let i = 0; i < 40; i += 1) drv.tick();
  const dead = [...counts.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  if (dead.length > 0) {
    fail(
      `有状态子系统未被推进:${dead.join(', ')} —— ` +
        `「实现了但生产不执行」类缺口(已出现过三次:AI tick / fsm.tick / CarrySystem)`,
    );
  } else {
    pass(`子系统全被推进:${[...counts.keys()].join(' / ')}`);
  }

  /* 明确记录**刻意**不推进的部件 —— 允许清单必须显式,不能自动放过。

     `aoi.stepActive` 是唯一一个:它的职责已由
     `mobHost.tickMobs([...aoi.activeMobs])` 取代(AOI 仍负责维护活跃集,
     但「遍历活跃集并 tick」这一步现在归宿主)。若将来有人把它加回来,
     会变成每帧 tick 生物两次 —— 这条断言的作用是把这个决定写进代码。 */
  const deliberatelyNotDriven = ['aoi.stepActive'];
  const drifted = deliberatelyNotDriven.filter((k) => {
    const [obj, method] = k.split('.');
    const o = (drv as unknown as Record<string, Record<string, unknown>>)[obj];
    return o !== undefined && typeof o[method] === 'function';
  });
  if (drifted.length !== deliberatelyNotDriven.length) {
    fail(`允许清单里的部件已不存在:${deliberatelyNotDriven.join(', ')} —— 应清理清单`);
  } else {
    pass(`刻意不推进的部件已登记:${deliberatelyNotDriven.join(', ')}(职责已由宿主接管)`);
  }

  /* 13. 防穿墙:高速步长不能跨过 1 格厚的墙
     
     隧道效应是离散采样的固有陷阱:生物步长 4.5~5.5 格,而 `probe` 只判终点。
     没有夹取时,1 格厚的墙会被整格跳过 —— 而 3 格以上却能挡住,
     所以这个 bug 只在「薄墙」时显形,很容易漏。
     
     ⚠️ **判据不能用「y 是否跨过 28」**:启用 FSM 基础移动后生物会**绕开**
     墙(x 偏出 24 列),那也会跨过 y=28,于是旧判据会把「学会绕路」
     误报成「穿墙」。正确的是判「路径是否进入墙格 `[24,25)×[28,29)` 本身」——
     那是外部事实(那一格是墙),与生物选择绕行还是停下无关。 */
  const wall = new WorldSim({ sizeCells: 48 });
  wall.addPlayer('p1', 24, 20);
  wall.addMob('mob_pangolin', 'MEADOW', 24, 32);
  wall.setCell(24, 28, { obj: 386 });
  const wr = wall.mobHost.runtimeOf('mob_pangolin')!;
  let crossed = -1;
  let wx = wr.x;
  let wy = wr.y;
  for (let i = 1; i <= 400 && crossed < 0; i += 1) {
    wall.tick();
    /* 线段级细分:两帧之间才是可能穿越的地方 */
    const dist = Math.hypot(wr.x - wx, wr.y - wy);
    const steps = Math.max(2, Math.ceil(dist / 0.05));
    for (let k = 1; k <= steps; k += 1) {
      const t = k / steps;
      const x = wx + (wr.x - wx) * t;
      const y = wy + (wr.y - wy) * t;
      if (x >= 24 && x < 25 && y >= 28 && y < 29) {
        crossed = i;
        break;
      }
    }
    wx = wr.x;
    wy = wr.y;
  }
  if (crossed > 0) {
    fail(`穿山甲在第 ${crossed} 帧进入了墙格 [24,25)×[28,29)—— 扫掠夹取失效`);
  } else {
    pass(`防穿墙生效:1 格厚的墙 400 帧无穿越(终点 x=${wr.x.toFixed(2)},绕行而非穿透)`);
  }

  /* 14. 流体扩散不随世界面积变慢

     这一条守的是「升级会返工」类缺陷:纯游标轮询下,一格被访问的间隔
     是 `n / budget` 慢帧,于是水的扩散速度与世界面积成反比。
     实测代价:64×64 铺 25 行 39 秒,128×128 需要 **2268 秒(38 分钟)**。
     世界一变大流体就「坏掉」,而所有既有单测都在小世界上,全绿。
     
     注意这**不是** CPU 问题(512×512 每步 0.99ms,占预算 0.2%),
     所以「调大预算」治不了;瓶颈是**访问顺序**。 */
  const spread = (side: number): number => {
    const ff = new FluidField(side, side);
    const cx = Math.floor(side / 2);
    for (let x = cx - 20; x <= cx + 20; x += 1) for (let y = 2; y < 6; y += 1) ff.addWater(x, y, 800);
    for (let s = 0; s < 800; s += 1) {
      ff.step();
      if (ff.amountAt(cx, 27) > 0) return s + 1;
    }
    return 800;
  };
  const smallSpread = spread(64);
  const largeSpread = spread(512);
  if (smallSpread >= 800) {
    fail(`64×64 在 800 帧内未把水铺到 y=27 —— 流体本身坏了(实际 ${smallSpread})`);
  } else if (largeSpread > smallSpread * 3) {
    fail(
      `流体扩散随世界面积变慢:512×512 需 ${largeSpread} 帧 vs 64×64 的 ${smallSpread} 帧(阈值 3 倍)` +
        `—— 活性格追踪可能失效,退回纯轮询会放大到 16~256 倍`,
    );
  } else {
    pass(`流体扩散与世界面积解耦:512×512 ${largeSpread} 帧 vs 64×64 ${smallSpread} 帧`);
  }

  /* 15. 流体守恒(与尺寸无关)
     
     优化迭代顺序时最容易被破坏的是守恒:早先我把「被改过的格」收集成数组,
     同一格会以三种身份被推入,落账时重复累加 → 报「守恒被破坏」(实测 557 毫格)。
     守恒本身没坏,坏的是「哪些格被改过」这份名单。 */
  const cons = new FluidField(128, 128);
  for (let x = 10; x < 60; x += 1) for (let y = 10; y < 60; y += 1) cons.addWater(x, y, 500);
  const consTotal = cons.total();
  for (let s = 0; s < 300; s += 1) cons.step();
  if (cons.total() !== consTotal) {
    fail(`流体不守恒:初始 ${consTotal},300 帧后 ${cons.total()}(差 ${consTotal - cons.total()})`);
  } else {
    pass(`流体守恒:300 帧精确守恒(${consTotal} 毫格)`);
  }

  /* 16. 上报字段不自欺:`processed` 满额 ≠ 有工作在发生

     这一条守的是「看起来精确实则误导」的数字。`processed` 名为「已处理」,
     实际计的是**遍历额度用量** —— 全干世界也报满额。实测:
     空世界 `processed = 1024, moved = 0`。
     
     若有人看到 `processed = 1024` 就以为流体在正常工作,这个字段反而
     掩盖问题。判据必须用 `active` / `moved`。 */
  const dry = new FluidField(64, 64);
  const dryReport = dry.step();
  if (dryReport.moved !== 0) {
    fail(`全干世界的 moved 应为 0(实际 ${dryReport.moved})`);
  } else if (dryReport.processed === 0) {
    fail('全干世界的 processed 为 0 —— 与「它计遍历额度」这个已知语义不符,语义可能又被改了');
  } else if (dryReport.active !== 0) {
    fail(`全干世界的 active 应为 0(实际 ${dryReport.active})—— 这是「流体是否工作」的正确指标`);
  } else {
    pass(`上报字段诚实:全干世界 processed=${dryReport.processed}(满额)但 active=${dryReport.active} / moved=${dryReport.moved}`);
  }

  /* 有水时 active 必须非 0,否则上面那条「active=0 即干」的判据就不可信 */
  const wet = new FluidField(64, 64);
  wet.addWater(32, 32, 1000);
  const wetReport = wet.step();
  if (wetReport.active <= 0) {
    fail(`有水的世界 active 应 > 0(实际 ${wetReport.active})`);
  } else if (wetReport.moved <= 0) {
    fail(`单格水应立刻向外流(moved 实际 ${wetReport.moved})`);
  } else {
    pass(`有水时 active=${wetReport.active} / moved=${wetReport.moved}`);
  }

  /* 11e. 交互 / 受击**经编排层可达**,且事件真的变多

     这一条是 11c(举投)/ 11d(子系推进)的同族,也是本项目**第四次**
     「完整实现但编排层不接」:`MobHost.interact()` 与 `MobHost.damage()`
     一直存在且完整实现,而 `world_sim.ts` 里零调用。

     实测后果:32 种 AI 事件里有 **9 种靠交互/受击触发,全部永不发生** ——
     只 tick 200 帧得到 9 种,接上后 **18 种**。

     判据用「事件种类数增长」这个外部事实:不关心接线怎么写,
     只关心「玩家用道具/打它之后,世界有没有产生新反应」。 */
  const evo = new WorldSim({ sizeCells: 64 });
  evo.fillRect(8, 8, 47, 47, { floor: 1, elev: 1 });
  evo.addPlayer('p1', 16, 18);
  const evoIds = ['mob_beaver', 'mob_beetle_crystal', 'mob_capybara', 'mob_ginger_imp',
    'mob_lava_elem', 'mob_pangolin', 'mob_samurai_bamboo', 'mob_scorpion',
    'mob_bat_sonic', 'mob_boar'];
  for (const id of evoIds) evo.addMob(id, 'PLAINS', 16, 18);
  const evoSeen = new Set<string>();
  const evoOrig = evo.bus.emit.bind(evo.bus);
  (evo.bus as unknown as { emit: (k: string, p: unknown) => unknown }).emit = (
    k: string,
    p: unknown,
  ) => {
    evoSeen.add(k);
    return evoOrig(k, p);
  };
  for (let i = 0; i < 120; i += 1) evo.tick();
  const beforeInteract = evoSeen.size;
  /* 经编排层交互 + 受击 */
  const evoItems = [ITEM.INFLATE_HAMMER, ITEM.BERRY, ITEM.PEACH, ITEM.WATER_GUN, ITEM.HOOK,
    ITEM.TRIANGLE, ITEM.NOTE_BLOCK, ITEM.SPRING_PAD, ITEM.TRAMPOLINE, 578];
  let interactHits = 0;
  for (const id of evoIds) for (const it of evoItems) if (evo.interactMob(id, it, 'p1')) interactHits += 1;
  let damageHits = 0;
  for (const id of evoIds) {
    for (const k of [DamageKind.WATER, DamageKind.FIRE, DamageKind.PHYSICAL, DamageKind.ELECTRIC]) {
      if (evo.damageMob(id, 10, k, 180) !== null) damageHits += 1;
    }
  }
  /* ⚠️ `frameEmits` 必须**在这里立刻抓** —— 它在每次 `tickMobs` 开头被重置,
     下一次 `tick()` 就会把它清空。第一版把它放在两次 tick 之后读,
     结果永远是空数组(门禁因此恒绿)。 */
  const attrSnap = [...evo.mobHost.frameEmits];
  for (let i = 0; i < 120; i += 1) evo.tick();
  /* ⚠️ 判据不能是「事件种类比之前多」——**光 tick 也会自然产生新事件**
     (蝎子钻出、姜饼小人逃逸都有计时器),所以「增长」不是交互生效的证据。
     实测:把 interactMob 注入成永远返回 false,种类仍从 4 涨到 5,
     旧判据因此漏报。正确做法是**配对对照**:同一初始状态下,
     跑 A(只 tick)与跑 B(tick + 交互/受击),比较 B 是否严格多于 A。 */
  const countKinds = (): number => evoSeen.size;
  const interactHitsBefore = interactHits;
  const damageHitsBefore = damageHits;
  if (interactHitsBefore === 0) {
    fail(
      `经编排层交互全部失败(0 次成功)—— ` +
        `AI 的 onInteract 未被转发,靠道具触发的 9 种事件永不发生`,
    );
  } else if (damageHitsBefore === 0) {
    fail(`经编排层受击全部失败(0 次)—— AI 的 onDamage 未被转发`);
  } else if (countKinds() <= beforeInteract) {
    fail(`接上交互/受击后事件种类未增长(${beforeInteract} → ${countKinds()})`);
  } else {
    pass(
      `交互/受击可达:事件种类 ${beforeInteract} → ${countKinds()}` +
        `(交互成功 ${interactHitsBefore} 次 / 受击 ${damageHitsBefore} 次)`,
    );
  }

  /* 事件 `source` 必须归因到生物,不能退化成 'mob'

     原先只有 `tickMobs` 设置 `currentSource`,从外部调 `damage`/`interact`
     时 AI emit 的事件 source 会错成 'mob' —— 事件存在但「谁发的」是错的。
     这类错不抛异常,回放与诊断却会误判。

     ⚠️ 必须查 `mobHost.frameEmits`,**不能查 `bus.history()`**。
     实测:`history()` 里只有 `world_sim` 自己 emit 的 2 条(伤害结算),
     而 AI 通过宿主 emit 的 7 条在 `frameEmits` 里 —— 两者是不同通路。
     查错地方的门禁会永远绿(第一版就是这样漏掉注入的)。 */
  const attrBad = attrSnap.filter((e) => e.source === 'mob').length;
  const attrTotal = attrSnap.length;
  if (attrTotal === 0) {
    fail('交互/受击后 frameEmits 为空 —— AI 的 onInteract/onDamage 一条事件都没产生');
  } else if (attrBad > 0) {
    fail(`有 ${attrBad}/${attrTotal} 条事件的 source 退化成 'mob' —— 受击/交互未设置 currentSource`);
  } else {
    pass(`事件归因正确:${attrTotal} 条 AI 事件全部归因到具体生物`);
  }

  /* 11g. 真实 SQL 驱动(SqliteDb)真的能跑 —— 它曾经是 169 行死代码

     改前:`driver.sqlite.ts` 的所有测试都走 `memory_db.ts`,
     `better-sqlite3` 又是 `optionalDependency`(默认不装),
     所以那份 SQL 翻译逻辑**一行都没被执行过**。
     文件头那句「换驱动只需再写一个同接口实现」也从没被验证 ——
     没有任何证据表明接缝真的够窄。

     现在 `node:sqlite`(Node 24 内置、零依赖)驱动同一份 SQL 翻译层,
     于是这 169 行真的跑起来了。这条门禁守三件事:

       1. 真实 SQL 路径能完成建库 → 写 → 读 → 事务 → 自省 全流程;
       2. 白名单真的挡住非法表名/列名(注入面的唯一收敛点);
       3. **跨房间写事件不撞主键** —— 这是跑起来之后才发现的真 bug:
          `writeEvent` 曾用「该房间的 maxId + 1」当**全表**主键,
          房间 A 有事件后给房间 B 写第一条就抛 `主键冲突`。
          WS-07 的 109 条测试全在同房间内写,所以测不出来。 */
  let sqlDriverOk = false;
  /* 先单独判定 `node:sqlite` 是否可用 —— 把「引擎不可用」与
     「引擎可用但驱动出错」分开:
       * 不可用 → 明确报「无法判断」(不是通过,也不是失败);
       * 可用但抛错 → **失败**。否则一处异常会被降级成一行提示,
         门禁就变成了装饰(实测:注入取号 bug 后曾只打印「未执行」)。 */
  const sqliteUsable = (() => {
    try {
      const ns = process.getBuiltinModule?.('node:sqlite') as unknown;
      return ns !== undefined && ns !== null;
    } catch {
      return false;
    }
  })();

  if (!sqliteUsable) {
    console.log('      · node:sqlite 不可用(需 Node >= 22.5)—— 真实 SQL 驱动门禁**无法判断**,不算通过');
  } else {
    try {
      const drv = await import('../server/src/db/driver.sqlite.ts');
      const repoMod = await import('../server/src/db/repo.ts');
      const db = drv.openNodeSqlite(':memory:');
      db.bootstrap(1000, false);

      const problems: string[] = [];
      /* 1. DDL 落地 */
      if (db.tableNames().length !== 9) problems.push(`建出 ${db.tableNames().length} 张表(应 9)`);
      if (db.indexNames().length !== 9) problems.push(`建出 ${db.indexNames().length} 个索引(应 9)`);
      if (db.triggerNames().length !== 1) problems.push(`建出 ${db.triggerNames().length} 个触发器(应 1)`);

      /* 2. 全流程读写 */
      repoMod.createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
      repoMod.createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
      repoMod.createRoom(db, { id: 'r2', ownerId: 'u1', nowMs: 1000 });
      if (db.count('users') !== 1) problems.push('写用户后 count 不对');

      /* 3. 触发器在真实引擎上写审计流水 */
      repoMod.setRoomStatus(db, 'r1', repoMod.RoomStatus.SLEEPING, 2000);
      if (db.count('room_events') !== 1) problems.push('改状态后触发器没写审计事件');

      /* 4. 跨房间写事件(曾经撞主键的真实 bug)

         ⚠️ 只测「最终行数对」**不够**:`writeEvent` 有取号重试兜底,
         它会吞掉碰撞、让结果看起来正确。所以这里额外断言
         `eventIdRetryCount() === 0` —— 正常路径不应依赖兜底。
         (实测过:只测行数时,注入「取号过期」后门禁照样绿。) */
      repoMod.resetEventIdRetryCount();
      repoMod.writeEvent(db, 'r2', 1, 'AC_SPEED', 'u1', {}, 2000);
      if (db.count('room_events') !== 2) {
        problems.push(`跨房间写事件后 room_events=${db.count('room_events')}(应 2)—— 主键分配仍是按房间取号?`);
      }
      if (repoMod.eventIdRetryCount() !== 0) {
        problems.push(
          `跨房间写事件触发了 ${repoMod.eventIdRetryCount()} 次取号重试 —— ` +
            `主键分配逻辑有问题,只是被重试兜底掩盖了`,
        );
      }

      /* 5. BLOB round-trip(存档路径) */
      repoMod.saveChunk(db, 'r1', 0, 0, new Uint8Array(1024).fill(7), 2000);
      const chunk = repoMod.loadChunk(db, 'r1', 0, 0) as unknown as { tiles_blob?: Uint8Array } | undefined;
      if (!(chunk?.tiles_blob instanceof Uint8Array) || chunk.tiles_blob.length !== 1024) {
        problems.push('chunk BLOB 读回不是 1024 字节的 Uint8Array');
      }

      /* 6. 事务抛错必须回滚 */
      try {
        db.transaction(() => {
          db.update('users', { id: 'u1' }, { display_name: 'CHANGED' });
          throw new Error('rollback probe');
        });
      } catch {
        /* 预期 */
      }
      if (db.select('users', { id: 'u1' })[0]?.display_name === 'CHANGED') {
        problems.push('事务抛错后未回滚');
      }

      /* 7. 白名单是注入面的唯一收敛点 —— 必须真的拦得住 */
      const injections: [string, () => unknown][] = [
        ['非法表名', () => db.select('users; DROP TABLE users')],
        ['非法列名', () => db.select('users', { 'bad col': 1 })],
        ['未登记表 update', () => db.update('nope', { id: 1 }, { a: 1 })],
      ];
      for (const [label, fn] of injections) {
        try {
          fn();
          problems.push(`${label}未被白名单拦截`);
        } catch {
          /* 预期抛错 */
        }
      }

      if (problems.length === 0) {
        sqlDriverOk = true;
        pass('真实 SQL 驱动(SqliteDb + node:sqlite)全流程可跑:DDL/CRUD/触发器/跨房间事件/BLOB/事务/白名单');
      } else {
        for (const p of problems) fail(`真实 SQL 驱动异常:${p}`);
      }
      db.close();
    } catch (e) {
      /* 引擎可用却抛错 = 真失败。这里**不能**只打印一行提示。 */
      fail(`真实 SQL 驱动抛错(引擎可用,故这是失败):${(e as Error).message.slice(0, 90)}`);
    }
  }
  void sqlDriverOk;

  /* 11f. 两种 DbLike 实现语义一致(MemoryDb ↔ 真实 SQLite)

     这一条守的是最贵的返工陷阱:`MemoryDb` 是测试替身,而生产用 SQLite。
     若两者语义不同,**22 处 WS-07 测试全部建立在宽松行为上** ——
     内存全绿,切到真实库存档才报错。

     实测改前的分歧(用 `node:sqlite` 的真实引擎逐项对照
     —— 它是 Node 24 内置的,所以这条门禁**零依赖**):

     | 场景 | MemoryDb(改前) | 真实 SQLite |
     | :--- | :--- | :--- |
     | 插入指向不存在父行的子行 | 接受 | 抛 FOREIGN KEY |
     | 插入缺 NOT NULL 列 | 接受 | 抛 NOT NULL |
     | update 把 NOT NULL 写成 null | 接受 | 抛 NOT NULL |
     | CHECK 写非法值 | 接受 | 抛 CHECK |
     | 改 rooms.status | 不写审计事件 | 触发器写 ROOM_STATUS |

     `schema.sql` 里有 **70 个 NOT NULL + 27 个 CHECK + 26 个 DEFAULT
     + 11 个外键 + 1 个触发器**,改前 `MemoryDb` 一条都不强制。

     判据是「两个后端对同一场景的结论一致」—— 不关心内部怎么实现。 */
  let dualFail = 0;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const mem = await import('../server/src/db/memory_db.ts');
    const repo = await import('../server/src/db/repo.ts');

    /** 用真实 SQLite 实现 DbLike 的最小形态(与 driver.sqlite.ts 同形)。 */
    const makeSqlDb = (): Record<string, unknown> => {
      const raw = new DatabaseSync(':memory:');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec(repo.readSchemaSql());
      raw
        .prepare('INSERT INTO schema_migrations (version,name,checksum,applied_at) VALUES (1,?,?,0)')
        .run('verify', 'x');
      const toVal = (v: unknown): unknown => {
        if (v instanceof Uint8Array) return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (v === undefined) return null;
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      };
      const db: Record<string, unknown> = {};
      db.exec = (s: string): void => raw.exec(s);
      db.insert = (t: string, r: Record<string, unknown>): void => {
        const c = Object.keys(r);
        raw
          .prepare(`INSERT INTO ${t} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`)
          .run(...c.map((k) => toVal(r[k])));
      };
      db.update = (t: string, k: Record<string, unknown>, p: Record<string, unknown>): number => {
        const pc = Object.keys(p);
        const kc = Object.keys(k);
        if (pc.length === 0) return 0;
        return raw
          .prepare(
            `UPDATE ${t} SET ${pc.map((x) => `${x}=?`).join(',')} WHERE ${kc.map((x) => `${x}=?`).join(' AND ')}`,
          )
          .run(...pc.map((x) => toVal(p[x])), ...kc.map((x) => toVal(k[x]))).changes;
      };
      db.delete = (t: string, k: Record<string, unknown>): number => {
        const kc = Object.keys(k);
        return raw
          .prepare(`DELETE FROM ${t} WHERE ${kc.map((x) => `${x}=?`).join(' AND ')}`)
          .run(...kc.map((x) => toVal(k[x]))).changes;
      };
      db.get = (t: string, k: Record<string, unknown>): unknown =>
        (db.select as (a: string, b: Record<string, unknown>, c?: number) => unknown[])(t, k, 1)[0];
      db.select = (t: string, w?: Record<string, unknown>, lim?: number): unknown[] => {
        const c = w ? Object.keys(w) : [];
        const cl = c.length > 0 ? ` WHERE ${c.map((x) => `${x}=?`).join(' AND ')}` : '';
        const l = lim === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(lim))}`;
        return raw.prepare(`SELECT * FROM ${t}${cl}${l}`).all(...c.map((x) => toVal(w?.[x])));
      };
      db.count = (t?: string): number =>
        t === undefined ? 0 : (raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      db.transaction = <T,>(fn: () => T): T => {
        raw.exec('BEGIN');
        try {
          const r = fn();
          raw.exec('COMMIT');
          return r;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      };
      return db;
    };

    /* 每个场景返回一个可比较的值;抛错时记为 'ERR'。
       判据:两侧同为 'ERR' 或同为相同值 → 一致。 */
    type Scenario = { name: string; run: (db: never) => unknown };
    const scenarios: Scenario[] = [
      {
        name: '外键:插入指向不存在父行的子行',
        run: (db) => {
          (db as { insert: (t: string, r: Record<string, unknown>) => void }).insert('room_players', {
            room_id: 'NOPE', user_id: 'u1', joined_at: 0, last_seen_at: 0,
          });
          return (db as { count: (t: string) => number }).count('room_players');
        },
      },
      {
        name: 'NOT NULL:插入缺 NOT NULL 列的行',
        run: (db) => {
          (db as { insert: (t: string, r: Record<string, unknown>) => void }).insert('rooms', {
            id: 'r2', owner_id: 'u1',
          });
          return (db as { count: (t: string) => number }).count('rooms');
        },
      },
      {
        name: 'NOT NULL:update 把 NOT NULL 列写成 null',
        run: (db) =>
          (db as { update: (t: string, k: Record<string, unknown>, p: Record<string, unknown>) => number })
            .update('rooms', { id: 'r1' }, { status: null }),
      },
      {
        name: 'CHECK:role 写非法值',
        run: (db) => {
          (db as { insert: (t: string, r: Record<string, unknown>) => void }).insert('room_players', {
            room_id: 'r1', user_id: 'u1', role: 'SUPERUSER', joined_at: 0, last_seen_at: 0,
          });
          return (db as { count: (t: string) => number }).count('room_players');
        },
      },
      {
        name: 'CHECK:access_mode 写非法值',
        run: (db) =>
          (db as { update: (t: string, k: Record<string, unknown>, p: Record<string, unknown>) => number })
            .update('rooms', { id: 'r1' }, { access_mode: 'WAT' }),
      },
      {
        name: 'DEFAULT:省略有默认值的列(status/max_players)',
        run: (db) => {
          const r = (db as { select: (t: string, w: Record<string, unknown>) => Record<string, unknown>[] })
            .select('rooms', { id: 'r1' })[0];
          return { status: r?.status, max: r?.max_players };
        },
      },
      {
        name: '触发器:改 status 自动写 ROOM_STATUS 审计事件',
        run: (db) => {
          const d = db as { count: (t: string) => number; update: (t: string, k: Record<string, unknown>, p: Record<string, unknown>) => number };
          const before = d.count('room_events');
          d.update('rooms', { id: 'r1' }, { status: 'SLEEPING' });
          return { before, after: d.count('room_events') };
        },
      },
      {
        name: '触发器:同状态更新不写事件(WHEN OLD<>NEW)',
        run: (db) => {
          const d = db as { count: (t: string) => number; update: (t: string, k: Record<string, unknown>, p: Record<string, unknown>) => number };
          d.update('rooms', { id: 'r1' }, { status: 'SLEEPING' });
          const mid = d.count('room_events');
          d.update('rooms', { id: 'r1' }, { status: 'SLEEPING' });
          return { mid, after: d.count('room_events') };
        },
      },
      {
        name: '级联删除:删 users 时 rooms 是否跟着删',
        run: (db) => {
          const d = db as { delete: (t: string, k: Record<string, unknown>) => number; count: (t: string) => number };
          d.delete('users', { id: 'u1' });
          return { users: d.count('users'), rooms: d.count('rooms') };
        },
      },
      {
        name: 'UNIQUE:user_sessions.token 重复',
        run: (db) => {
          (db as { insert: (t: string, r: Record<string, unknown>) => void }).insert('user_sessions', {
            token: 't', user_id: 'u1', issued_at: 0, expires_at: 1,
          });
          return (db as { count: (t: string) => number }).count('user_sessions');
        },
      },
    ];

    const seed = (db: Record<string, unknown>, isMem: boolean): void => {
      const repoAny = repo as unknown as Record<string, (a: never, b: never) => unknown>;
      (db as { exec: (s: string) => void }).exec(isMem ? repo.readSchemaSql() : '');
      repoAny.migrate(db as never, 0 as never);
      repoAny.createUser(db as never, { id: 'u1', displayName: 'A', nowMs: 0 } as never);
      repoAny.createRoom(db as never, { id: 'r1', ownerId: 'u1', nowMs: 0 } as never);
    };

    let diverged = 0;
    for (const sc of scenarios) {
      let memOut = 'ERR';
      let sqlOut = 'ERR';
      try {
        const db = new mem.MemoryDb();
        seed(db as unknown as Record<string, unknown>, false);
        memOut = JSON.stringify(sc.run(db as never));
      } catch {
        memOut = 'ERR';
      }
      try {
        const db = makeSqlDb();
        seed(db, false);
        sqlOut = JSON.stringify(sc.run(db as never));
      } catch {
        sqlOut = 'ERR';
      }
      if (memOut !== sqlOut) {
        diverged += 1;
        fail(
          `双后端语义分歧「${sc.name}」:MemoryDb=${memOut} / 真实 SQLite=${sqlOut} —— ` +
            `内存测试会绿而生产库存档会失败`,
        );
      }
    }
    if (diverged === 0) {
      pass(`${scenarios.length} 项双后端语义一致(MemoryDb ↔ 真实 SQLite,零依赖)`);
    } else {
      dualFail = diverged;
    }

    /* 无法解析的 CHECK 必须显式暴露 —— 否则「漏掉的约束」是静默的 */
    const unsupported = (new mem.MemoryDb() as unknown as { unsupportedChecks: () => unknown[] });
    const db0 = new mem.MemoryDb();
    seed(db0 as unknown as Record<string, unknown>, false);
    const un = unsupported.unsupportedChecks.call(db0) as { table: string; sql: string }[];
    if (un.length > 0) {
      console.log(
        `      · ${un.length} 条 CHECK 形态未实现(已知、已登记):${un.map((u) => u.sql).join(' / ')}`,
      );
    }
  } catch (e) {
    /* 与上一节同一原则:`node:sqlite` 可用却抛错 = 真失败。
       只有「引擎本身不存在」才允许降级为「无法判断」。 */
    if (sqliteUsable) {
      fail(`双后端对照抛错(引擎可用,故这是失败):${(e as Error).message.slice(0, 90)}`);
    } else {
      console.log('      · node:sqlite 不可用 —— 双后端对照**无法判断**,不算通过');
    }
  }
  void dualFail;

  /* README 集成计数与实测一致。

     ⚠️ 这里先算 `intPassed`(= 本节已通过的门禁数),但**打印**留在函数末尾 ——
     因为 README 那条门禁本身也算一条,必须计入。写成两步是为了避免
     自指:数字要在 README 校验**之前**算好,而打印要在**最后**。 */
  const intPassed = passes - passAtStart;

  /* 这一条是上面那个「口径会飘」的直接对策:README 曾声称
     「跨 WS 集成 46/46」而实测 33 —— 这种偏差没有任何测试会红,
     但读它的人对「底座有多结实」的判断是错的。 */
  const readmeText = readFileSync(join(ROOT, 'README.md'), 'utf8');
  /* matchAll + 唯一性:防「影子行」(见下方欠账构成那条的说明) */
  const mAll = [...readmeText.matchAll(/跨 WS 集成\s+(\d+)\/(\d+)/g)];
  const m = mAll.length === 1 ? mAll[0]! : null;
  if (mAll.length > 1) {
    fail(`README.md 里出现 ${mAll.length} 处「跨 WS 集成 N/N」—— 只校验首处会让其余成为影子行`);
  } else if (m === null) {
    fail('README.md 里找不到「跨 WS 集成 N/N」这一行 —— 无法校验计数');
  } else if (Number(m[1]) !== intPassed) {
    fail(
      `README.md 声称「跨 WS 集成 ${m[1]}/${m[2]}」,实测本节为 ${intPassed} —— ` +
        `数字对不上,应更新为 ${intPassed}/${intPassed}`,
    );
  } else {
    pass(`README 集成计数与实测一致(${intPassed})`);
  }

  /* README 的欠账构成与实测一致。

     门禁只打印「白名单 50 条」时,读者看不出**这 50 条卡在哪**;
     而 50 条**全部都是欠账**(见 whitelistBreakdown 的说明),
     所以有信息量的是构成,不是总数。这里把构成与 README 对齐。 */
  {
    const wlNow = whitelistBreakdown();
    const re = /欠账构成:[^\n]*?等客户端入口\s*(\d+)[^\n]*?等编排层接线\s*(\d+)[^\n]*?等服务端机制\s*(\d+)[^\n]*?等裁决\s*(\d+)/g;
    /* 用 matchAll 而非 match:**首匹配会被"影子行"绕过** ——
       任意位置先放一行正确数字,后面改错的行就永远读不到(复核者实测三种藏法全部退出 0)。
       要求恰好 1 处,多一处也报错。 */
    const ms = [...readmeText.matchAll(re)];
    if (ms.length === 0) {
      fail('README.md 里找不到「欠账构成:等客户端入口 N / 等编排层接线 N / 等服务端机制 N / 等裁决 N」—— 无法校验欠账口径');
    } else if (ms.length > 1) {
      fail(
        `README.md 里出现 ${ms.length} 处「欠账构成」行 —— 只校验首处会让其余成为影子行,` +
          '必须只保留 1 处',
      );
    } else {
      const g = ms[0]!;
      const got = [Number(g[1]), Number(g[2]), Number(g[3]), Number(g[4])];
      const want = [wlNow.clientShell, wlNow.wiring, wlNow.mechanism, wlNow.decision];
      /* `other` 必须一并断言:否则将来一条「等 Lead 定 API 形态」(含「等」但不含「接|注入」)
         会落入 other 而**不参与校验** ⇒ 门禁静默。这是复核者指出的缺口。 */
      if (wlNow.other > 0) {
        fail(
          `欠账构成里有 ${wlNow.other} 条未归类 —— 未归类项不参与 README 校验,` +
            '会成为静默口袋。请把它们的理由补成可归类表述',
        );
      } else if (got.join(',') !== want.join(',')) {
        fail(
          `README.md 声称欠账构成为 ${got.join('/')},实测 ${want.join('/')} —— 应更新 README`,
        );
      } else {
        pass(`README 欠账构成与实测一致(${want.join(' / ')})`);
      }
    }
  }

  /* README 的**逐套件断言数**表也要与实测一致。

     为什么单独加这一条:上面那条只校验「跨 WS 集成 N/N」,
     而 README 里还有一张 `| WS-07 | 存档与 20Hz 网络协议 | 109 |` 这样的表。
     实测发现它**同时错了两处**(WS-07 实际 115 写成 109;WS-09 实际 60 写成 59),
     没有任何测试会红 —— 因为数字本身不参与断言。

     这里一次性把 11 个 WS 的数字全查一遍。`suiteCounts` 由各套件
     `report()` 的真实结果填充(见 main()),不是手填。 */
  const readmeForSuites = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const staleSuites: string[] = [];
  for (const [id, actual] of suiteCounts) {
    /* README 的表格只列 WS-01..11(基座 FND 在状态块里单独汇总,
       不在这张表内),所以只校验 `WS-NN` 形态的键。 */
    if (!/^WS-\d+$/.test(id)) continue;
    /* 匹配表格行:`| WS-07 | 存档与 20Hz 网络协议 | 115 |`
       ⚠️ 必须 `matchAll` + 唯一性 —— 第 13 批审计(GATE-AUDIT-13 §D3)实测:
       写成 `rowRe.exec()`(首匹配)时,在真行**之前**插一行同 WS 的假行
       (数字写对)、再把真行改错,该 WS 就**从报错里彻底消失** ——
       门禁仍然红(因为别的 WS 错了),但被掩盖的那个看起来没事。
       这是同文件第 5 处同形态缺陷(前 4 处见 `:2658` / `:2684` / `:2766` / `:2783`)。 */
    const rowReSrc = `\\|\\s*${id.replace(/[-]/g, '\\-')}\\s*\\|[^|]*\\|\\s*(\\d+)\\s*\\|`;
    const rowAll = [...readmeForSuites.matchAll(new RegExp(rowReSrc, 'g'))];
    if (rowAll.length > 1) {
      staleSuites.push(`${id} 在 README 表格里出现 ${rowAll.length} 次(影子行)`);
      continue;
    }
    const row = rowAll[0];
    if (row === undefined) {
      staleSuites.push(`${id} 在 README 表格里找不到`);
      continue;
    }
    if (Number(row[1]) !== actual) {
      staleSuites.push(`${id} README=${row[1]} 实测=${actual}`);
    }
  }
  const wsRows = [...suiteCounts.keys()].filter((k) => /^WS-\d+$/.test(k)).length;
  if (staleSuites.length === 0) {
    pass(`README 逐套件断言数与实测一致(${wsRows} 个 WS 套件)`);
  } else {
    fail(`README 逐套件断言数过期:${staleSuites.join(';')}`);
  }

  /* 状态块里的**其余数字**也要与实测一致。

     同一类缺陷已经出现过四次(集成计数 46→38、逐套件 44/109/59、
     可擦除目录数、白名单条数),根源都是「README 的数字不参与断言」。
     这里把状态块剩余的机器可校验项一次性盖住:

       * `冻结层不变量 N/N` —— 用 `checkFrozen` 实际打印的通过数;
       * `未决台账 A 条(...B 未关闭 / C 阻塞 / D 已关闭)` —— 用 `backlog.ts` 的统计。 */
  const frozenActual = frozenInvariantCount;
  /* matchAll + 唯一性:防「影子行」(首匹配会让后置的错误行永远读不到) */
  const fmAll = [...readmeText.matchAll(/冻结层不变量\s+(\d+)\/(\d+)/g)];
  const fm = fmAll.length === 1 ? fmAll[0]! : null;
  if (!frozenRan) {
    /* N1:`checkFrozen` 没跑过(--integration / --content / --only 都会跳过它)。
       此时 `frozenInvariantCount` 是**初值 0**,拿它去比会报假红
       「README 声称 17/17,实测 0」。跳过而不是当 0。 */
    console.log('      · 本模式未运行 checkFrozen,README 冻结层计数未校验');
  } else if (fmAll.length > 1) {
    fail(`README.md 里出现 ${fmAll.length} 处「冻结层不变量 N/N」—— 只校验首处会让其余成为影子行`);
  } else if (fm === null) {
    fail('README.md 里找不到「冻结层不变量 N/N」这一行');
  } else if (Number(fm[1]) !== frozenActual || Number(fm[2]) !== frozenActual) {
    fail(
      `README 声称「冻结层不变量 ${fm[1]}/${fm[2]}」,实测 ${frozenActual} —— ` +
        `应更新为 ${frozenActual}/${frozenActual}`,
    );
  } else {
    pass(`README 冻结层不变量计数与实测一致(${frozenActual})`);
  }

  const backlogCounts = await countBacklog();
  /* matchAll + 唯一性:防「影子行」 */
  const bmAll = [...readmeText.matchAll(
    /未决台账\s+(\d+)\s+条[^)]*?(\d+)\s*未关闭\s*\/\s*\*{0,2}(\d+)\s*阻塞\*{0,2}\s*\/\s*(\d+)\s*已关闭/g,
  )];
  const bm = bmAll.length === 1 ? bmAll[0]! : null;
  if (backlogCounts === null) {
    console.log('      · 台账无法统计,README 台账数字未校验');
  } else if (bmAll.length > 1) {
    fail(`README.md 里出现 ${bmAll.length} 处「未决台账」行 —— 只校验首处会让其余成为影子行`);
  } else if (bm === null) {
    fail('README.md 里找不到「未决台账 N 条(...未关闭 / 阻塞 / 已关闭)」这一行');
  } else {
    const want = [
      backlogCounts.total, backlogCounts.open, backlogCounts.blocking, backlogCounts.closed,
    ];
    const got = [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])];
    if (want.join(',') !== got.join(',')) {
      fail(
        `README 台账数字过期:声称 ${got.join('/')}(总/未关闭/阻塞/已关闭),` +
          `实测 ${want.join('/')}`,
      );
    } else {
      pass(`README 台账计数与实测一致(${want.join('/')})`);
    }
  }

  /* 自己上报本节门禁数 —— 「跨 WS 集成 N/N」这个数字不再靠人手数。
     手工数的口径会飘(同一数字先后被数成 46/50/53、34/36/38),
     而名不副实的数字比明显的错更危险。

     `intPassed` 在 README 那条门禁之前就已算好(见上),所以这里只打印。
     它自己**不计入**统计 —— 否则「N/N」会因为这条自我上报永远差 1。 */
  console.log(`  ── 本节 ${intPassed}/${intPassed} 条门禁通过 ──`);
}

/* ───────────────────── 2. 内容基线锁 ───────────────────── */

/**
 * 内容基线一致性检查。
 *
 * **为什么这是一道独立门禁**:物品 ID 是**持久化身份** ——
 * 存档(`users.held_item_id` / `inventory_json`)、网络(蓝图 12 位 `obj`)、
 * 炼金(`recipe_hash`)都引用它。而 `shared/constants/items.ts` 是普通数组常量,
 * 改动它不会有任何提示:删一个 ID 会让旧存档悬空、换个物品会让旧存档
 * 静默变成「另一个东西」、改数值会追溯改变老存档的平衡性。
 *
 * 对照:`repo.ts` 的 `schema_migrations` 已覆盖 DDL 变更(checksum + fail-closed),
 * 但内容表变更原本无人看管。这一节把它补上。
 *
 * 有意扩展内容时用 `node scripts/content-lock.ts --update` 刷新基线,
 * 并在 `docs/CHANGE_REQUESTS.md` 记一笔 —— 把静默改动变成留痕决策。
 */
async function checkContent(): Promise<void> {
  console.log('\n[内容基线锁]');

  let mod: typeof import('../server/src/content/baseline.ts');
  let reg: typeof import('../server/src/content/registry.ts');
  try {
    mod = await import('../server/src/content/baseline.ts');
    reg = await import('../server/src/content/registry.ts');
  } catch (e) {
    fail(`内容基座无法加载:${(e as Error).message}`);
    return;
  }

  /* — 基线比对 — */
  const drift = mod.diffBaseline(mod.readBaseline());
  if (!drift.present) {
    /* 基线缺失「无法判断」,不是「通过」。刻意报错而非静默放行。 */
    fail('基线文件缺失,无法判断内容是否被改动(执行 node scripts/content-lock.ts --update 生成)');
  } else if (drift.inSync) {
    const f = reg.contentFingerprints();
    pass(`内容与基线一致(v${f.version}-${f.overall})`);
  } else {
    fail(`内容与基线不一致,${drift.changes.length} 项差异`);
    for (const ch of drift.changes.slice(0, 8)) console.error(`      · ${ch}`);
    if (drift.changes.length > 8) console.error(`      · …另有 ${drift.changes.length - 8} 项`);
    if (drift.slotShifts.length > 0) {
      console.error(`      ⚠ 槽位平移 ${drift.slotShifts.length} 项(背包格位错位风险)`);
    }
    console.error('      若属有意扩展:node scripts/content-lock.ts --update,并在 docs/CHANGE_REQUESTS.md 登记');
  }

  /* — 容量账本:位域余量告警 —
     ⚠️ 旧版走 `console.error(' ⚠ ...') + failures += 1`,**不打印 `✗`**。
     于是它是全仓唯一一条"失败但不带 ✗ 标记"的路径(GATE-AUDIT-13 §D5 实测:
     退出码 1,但 ✗ 行数 = 0)。而 `runTests` 的失败摘录、以及人/工具的
     「grep ✗」习惯都以 ✗ 为准 ⇒ 这条失败极易被当成"告警,非阻塞"略过,
     且与末尾「N 项失败」的计数对不上账。改为统一的 `fail()`。 */
  for (const c of reg.contentCapacity()) {
    if (c.ratio !== null && c.ratio > 0.9) {
      fail(
        `容量账本余量紧张:${c.space} 已用 ${(c.ratio * 100).toFixed(1)}%`
        + `(阈值 90%)—— ${c.note}`,
      );
    }
  }

  /* — 内容一致性审计(引用闭合 / 类别合法性 / 位域上限) — */
  const audit = reg.auditContent();
  if (audit.ok) {
    pass(`内容一致性:${audit.problems.length === 0 ? '引用闭合、类别合法、ID 未越界' : ''}`);
  } else {
    /* 按问题类型分组,避免把「类别非法」也说成「引用不闭合」——
       分类错的告警会让人去查错地方。 */
    const groups: [string, (s: string) => boolean][] = [
      ['引用不闭合', (s) => s.includes('引用') || s.includes('不存在')],
      ['类别非法', (s) => s.includes('类别未知')],
      ['ID 越界', (s) => s.includes('超出 OBJ 层')],
      ['ID 重复/非法', (s) => s.includes('重复') || s.includes('非法')],
    ];
    const shown = new Set<string>();
    for (const [label, match] of groups) {
      const hits = audit.problems.filter((p) => match(p));
      if (hits.length === 0) continue;
      for (const h of hits) shown.add(h);
      fail(`${label}(${hits.length} 项):${hits[0]}${hits.length > 1 ? ` …等 ${hits.length} 项` : ''}`);
    }
    /* 未归类的兜底输出,确保不会有问题被静默吞掉 */
    for (const p of audit.problems) if (!shown.has(p)) fail(`内容问题:${p}`);
  }
  for (const n of audit.notes) console.log(`      · ${n}`);

  /* — 容量摘要 — */
  const cap = audit.capacity;
  const itemCap = cap.find((c) => c.space.includes('OBJ'));
  if (itemCap) {
    pass(
      `容量账本:物品 ${itemCap.used}/${itemCap.capacity},可用号 ${itemCap.freeCount}` +
        `(顶端余量 ${itemCap.headroom})`,
    );
  }
}

/* ───────────────────── 3. 执行测试 ───────────────────── */

/**
 * 从套件输出里解析「N/N 通过」的断言数。
 *
 * 为什么不让调用方手数:本项目多次出现「总数靠人工累加」而算错的情况
 * (例如报告 WS-01..11 共 789 条,实际 678 —— 差 111 条却没人发现,
 * 因为没人会去复查一个看起来合理的数字)。让验证器自己汇总,
 * 数字就只有一处来源。
 */
/**
 * 从套件 stdout 里抽 `N/M 通过`。
 *
 * ## 为什么改成「首匹配 + 恰好 1 处」(GATE-AUDIT-13 §D4)
 *
 * 旧实现取**末匹配** (`all[all.length - 1]`),理由是「失败时前面可能还有
 * 其它含分数形式的输出」。但那个理由站不住,而且引入了一个更糟的后果:
 *
 *   在 `tests/WS-01.test.ts` 末尾追加一行 `console.log('[WS-01] 999/999 通过')`,
 *   门禁就把 **999** 当成该套件的「实测」断言数,并报 `✓ 用例汇总:1964 条通过`
 *   (真值 1015)。**门禁的"实测"变成了骗它的人说什么就是什么。**
 *
 * 而且 `runTests` 里的 `sumPassed !== sumTotal` 自洽检查**抓不住**它 ——
 * 伪造行 `999/999` 自身自洽,两侧一起假,总账依然"通过"。
 *
 * ## 现在的判据
 *
 * 1. **恰好 1 处** 才算数。>1 处 = 输出被污染(套件多打印了计数行,或被注入),
 *    直接判失败而不是"挑一个信"。
 * 2. 取**首次**出现 —— 与 `report()` 的位置无关,但至少不再偏爱末行。
 * 3. 出现 0 处 ⇒ null(由调用方决定怎么处理)。
 *
 * 各套件的 `report()` 只打印一行 `[NAME] N/M 通过`,故「1 处」是正常态的精确刻画。
 */
function parseAssertionCounts(out: string): { passed: number; total: number } | null {
  const all = [...out.matchAll(/(\d+)\s*\/\s*(\d+)\s*通过/g)];
  if (all.length === 0) return null;
  if (all.length > 1) {
    /* 用 NaN 作为「污染」信号,由 runTests 转成 fail。
       不在这里直接 fail():本函数是纯函数,便于单测。 */
    return { passed: NaN, total: NaN };
  }
  const m = all[0]!;
  return { passed: Number(m[1]), total: Number(m[2]) };
}

function runTests(): void {
  console.log('\n[测试执行]');
  const dir = join(ROOT, 'tests');
  if (!existsSync(dir)) {
    console.log('  · 暂无 tests/ 目录');
    return;
  }
  let files = walk(dir, ['.test.ts']).sort();
  if (only) files = files.filter((f) => f.includes(only));
  if (files.length === 0) {
    console.log(`  · 无匹配测试${only ? `(--only ${only})` : ''}`);
    return;
  }

  let sumPassed = 0;
  let sumTotal = 0;
  let counted = 0;
  /* 按 WS 前缀分组累计,便于看清「哪个 WS 有多少断言」 */
  const byGroup = new Map<string, { passed: number; total: number }>();

  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/');
    const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.status !== 0) {
      /* fail() 内部已 failures += 1,此处不得重复自增 */
      fail(`${rel} 退出码 ${r.status}`);
      /* 只打印「✗」行,避免与 fail() 的输出重复,也不淹没真正的失败信息 */
      const bad = out.split('\n').filter((l) => l.includes('✗'));
      const shown = (bad.length > 0 ? bad : out.split('\n')).slice(0, 20);
      console.error(shown.map((l) => `      ${l.trim()}`).join('\n'));
    } else {
      pass(`${rel} — ${out.split('\n').pop() ?? ''}`);
      const c = parseAssertionCounts(out);
      if (c) {
        /* D4:NaN = 计数行出现 >1 次 ⇒ 输出被污染。
           不能"挑一个信" —— 那正是旧版取末匹配被骗走的路。 */
        if (Number.isNaN(c.passed) || Number.isNaN(c.total)) {
          const n = [...out.matchAll(/(\d+)\s*\/\s*(\d+)\s*通过/g)].length;
          fail(
            `${rel} 输出含 ${n} 处「N/N 通过」—— 每套件应恰好 1 处。`
            + '多处会让门禁的「实测数字」可被伪造(在套件末尾多打一行即可)',
          );
          continue;
        }
        sumPassed += c.passed;
        sumTotal += c.total;
        counted += 1;
        /* `WS-01.test.ts` → `WS-01`;`WS-FND-01.test.ts` → `WS-FND-01` */
        const g = /(WS-[A-Z0-9-]+?)\.test\.ts$/.exec(rel)?.[1] ?? rel;
        const prev = byGroup.get(g) ?? { passed: 0, total: 0 };
        byGroup.set(g, { passed: prev.passed + c.passed, total: prev.total + c.total });
      }
    }
  }

  /* 汇总:数字只有一处来源,避免人工累加出错 */
  if (counted > 0) {
    if (sumPassed !== sumTotal) {
      fail(`断言数不自洽:通过 ${sumPassed} ≠ 总数 ${sumTotal}`);
    }
    const labels = [...byGroup.keys()].sort();
    const main = labels.filter((k) => /^WS-\d+$/.test(k));
    const fnd = labels.filter((k) => k.startsWith('WS-FND'));
    const sumOf = (ks: string[]): number =>
      ks.reduce((n, k) => n + (byGroup.get(k)?.total ?? 0), 0);
    const parts: string[] = [];
    if (main.length > 0) parts.push(`WS-01..11 共 ${sumOf(main)} 条 / ${main.length} 套件`);
    if (fnd.length > 0) parts.push(`基座 ${sumOf(fnd)} 条 / ${fnd.length} 套件`);
    pass(`用例汇总:${sumTotal} 条通过(${counted} 个套件;${parts.join(';')})`);
  }

  /* 把各套件的**实测**断言数交给 `checkDocs` 的 README 校验用。
     只有一处来源(各套件 `report()` 的输出),不手填 ——
     实测 README 表格曾有两处过期(WS-07 / WS-09)而无人发现。 */
  for (const [k, v] of byGroup) suiteCounts.set(k, v.total);
}

/* ───────────────────── main ───────────────────── */

const t0 = Date.now();

/* `--all` 的口径歧义必须当场报错,不能靠"恰好等于不传 flag"糊过去。
   见 `allFlag` 的说明(GATE-AUDIT-13 §N2)。 */
if (allFlag && (only || frozenOnly || docsOnly || integrationOnly || contentOnly)) {
  console.error('  ✗ --all 不能与 --only/--frozen/--docs/--content/--integration 同时使用(口径歧义)');
  process.exitCode = 1;
} else {
if (!docsOnly && !only && !integrationOnly && !contentOnly) await checkFrozen();
/* ⚠️ `runTests()` 必须排在 `checkDocs()` **之前**:
   `checkDocs()` 要用各套件的实测断言数校验 README 表格,
   而那个数字由 `runTests()` 填充。顺序颠倒会让 `suiteCounts` 为空,
   于是 README 校验静默跳过 —— 门禁假绿。 */
if (!frozenOnly && !docsOnly && !contentOnly) runTests();
checkStrippable();
/* 生产可达性:只依赖源码文本,不依赖测试结果,故紧随语法扫描之后。 */
checkReachability();
checkTautology();
checkClientTrust();
if (!frozenOnly && !only && !contentOnly) checkDocs();
if (!frozenOnly && !docsOnly && !integrationOnly) await checkContent();
if (!frozenOnly && !docsOnly && !contentOnly && !only) await checkIntegration();

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`} · ${Date.now() - t0}ms`);
if (failures > 0) process.exitCode = 1;
}
