/**
 * WS-FND-136 —— **常量的单一事实源**(第九轮实测:六处「同一个数 / 同一份表 / 同一条曲线」
 * 在本仓被写了两遍以上)。
 *
 * ## 这一套件守的**不是**「值对不对」
 *
 * 六处的值**一直是对的**(0.5 是对的、32 是对的、24 是对的、0.35 是对的、100 是对的)——
 * 所以任何数值断言都看不见它们。它们共同的形态是:
 *
 * ```text
 * 同一个事实有两处(或三处)声明 ⇒ 两个消费者可以各自漂移 ⇒ 两边都"看起来合理"
 * ```
 *
 * 典型后果(都在本文件里有对应的判据):
 *   · 染色枪的「能不能染上」用平台折线(15 格 = 1.0),而冻结层判据要求中点 0.5
 *     ⇒ 同一枪 UI 里读 1.0、服务端记 0.5(`FREEZE.md:228` 的「中点 0.5」当场不成立);
 *   · 32 色调色盘两份逐字节相同的副本 ⇒ 画架画的第 N 号色可以不再是喷枪喷的第 N 号色;
 *   · `BASE_HP` 三份、24 格两份、`0.35` 两份 ⇒ 改一处不改另一处**不会报错**。
 *
 * ## 判据(12 条;每条都带负对照 / 注入验证)
 *
 * ```text
 * FND136-1  染色距离衰减:两条路径(sprayAttenuation / sprayStrengthAtDistance)
 *           与冻结层 dyeAttenuation 逐点同值,中点 15 格 = 0.5(FREEZE.md:228)
 * FND136-2  负对照:旧平台折线的两个特征值(15 格 = 1.0 / 22.5 格 = 0.5)必须**已消失**
 * FND136-3  32 色调色盘:三处消费点与冻结层是**同一批绑定**(=== 引用相等,不是文本相等)
 * FND136-4  调色盘字面量只在一处:全生产树扫描(注释已掩码)+ 合成副本注入 ⇒ 红
 * FND136-5  「32」不再以字面量硬编码:扫描 + 注入 ⇒ 红
 * FND136-6  BASE_HP 一份声明(= 100):`physics.ts` 只转发 + 注入副本 ⇒ 红
 * FND136-7  24 格:`RAID_PARTICIPATION_RADIUS` 引用 `SHARE_EXP_RADIUS` + 注入 ⇒ 红
 * FND136-8  `TOWN_SAFE_RADIUS` 保留自己的 24,但注释必须写明「数值相同、语义不同」
 * FND136-9  掉落翻倍概率:共享常量 + `raid.ts` 不再写裸字面量 + 与 603 烘焙派词条同值
 * FND136-10 `action_table.ts` 的「24 个动作」与表实况一致,旧话(22 / 13 未接)不许复活
 * FND136-11 `scoring.ts` 的判据锚逐条对账:「那一行真的是那个符号」+ 未登记的锚 ⇒ 红
 * FND136-12 染色覆盖层不再自带折线算术(旧公式不许复活)
 * ```
 *
 * ## 注入怎么跑(为什么本文件里就有)
 *
 * 每条文本类判据都写成**纯函数**(输入 `{path, src}` 列表),因此可以在**内存里**把某个
 * 副本写回去再跑同一段代码 ⇒ 「改任一副本 ⇒ 红」这件事**每次跑测试都被实测一次**,
 * 而不是靠一次性手工注入的记录。真实注入(改盘上文件 → 红 → 还原)另见
 * `docs/INJECTION-COVERAGE.md` 的同批登记。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, ok, report, test } from '../shared/testing/harness.ts';

import { DYE_PALETTE, DYE_PALETTE_SIZE, dyeAttenuation } from '../shared/constants/dye.ts';
import { DROP_DOUBLE_CHANCE } from '../shared/constants/items.ts';
import { BASE_HP, SHARE_EXP_RADIUS } from '../shared/types/entities.ts';
import { BASE_HP as PHYSICS_BASE_HP } from '../shared/types/physics.ts';
import { DYE_DECAY_FAR_CELLS, dyeDecayAt } from '../client/src/stage/dye_decay.ts';
import {
  DYE_PALETTE as OVERLAY_PALETTE,
  DYE_PALETTE_SIZE as OVERLAY_PALETTE_SIZE,
  PALETTE_COLS,
  PALETTE_ROWS,
  SPRAY_RANGE_FAR,
  SPRAY_RANGE_NEAR,
  sprayAttenuation,
  sprayStrengthAtDistance,
} from '../client/src/stage/dye_overlay.ts';
import { PALETTE_32, PALETTE_SIZE } from '../client/src/ui/pixel_easel.ts';
import { DYE_PALETTE_SIZE as SCORING_PALETTE_SIZE } from '../server/src/party/scoring.ts';
import { PLAYER_BASE_HP } from '../server/src/combat/vitals.ts';
import { RAID_PARTICIPATION_RADIUS } from '../server/src/bosses/raid.ts';
import { TOWN_SAFE_RADIUS } from '../server/src/mobs/spawner.ts';
import { ACTION_HANDLERS } from '../server/src/net/actions/action_table.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ═══════════════════ 0. 读盘 / 掩码 / 扫描:三条纯函数 ═══════════════════ */

const norm = (p: string): string => p.split('\\').join('/');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) walkTs(`${dir}/${e.name}`, out);
    } else if (e.name.endsWith('.ts')) out.push(`${dir}/${e.name}`);
  }
  return out;
}

/**
 * 掩掉注释、**保留字符串内容**(长度与换行都不变 ⇒ 行号不偏)。
 *
 * 为什么要掩:判据 5/7/9/12 扫的是「代码里还有没有写死的字面量」,而
 * 「改版前这里是 `rng() < 0.35`」这类**注释**里的历史记录不该算命中
 * (那是留档,不是第二份实现)。反之判据 4 的颜色字面量住在字符串里,
 * 所以字符串必须**一字不掩**。
 */
function maskComments(src: string): string {
  let out = '';
  let i = 0;
  let st: 'code' | 'line' | 'block' | 'str' = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { st = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { st = 'str'; quote = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += c; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (st === 'block') {
      if (c === '*' && c2 === '/') { st = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1; continue;
    }
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
    if (c === quote) { st = 'code'; quote = ''; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

interface SrcFile { path: string; src: string; code: string }
const mkFile = (path: string, src: string): SrcFile => ({ path, src, code: maskComments(src) });

/** 生产三层(与 `verify.ts` §2.8b 的层定义一致;测试 / 脚本 / 文档不算)。 */
function productionFiles(): SrcFile[] {
  const paths = [...walkTs('shared'), ...walkTs('client/src'), ...walkTs('server/src')];
  return paths.map((p) => mkFile(norm(p), readFileSync(join(ROOT, p), 'utf8')));
}

function readOne(rel: string): SrcFile {
  return mkFile(rel, readFileSync(join(ROOT, rel), 'utf8'));
}

/* ── 三条可注入的扫描器(输入是文件列表 ⇒ 可以喂合成副本)── */

/** 代码里命中 `re` 的文件(注释已掩码)。 */
function hitsInCode(files: readonly SrcFile[], re: RegExp): string[] {
  return files.filter((f) => re.test(f.code)).map((f) => f.path);
}

/** 命中 `re` 的文件(含注释 —— 用于「注释里的旧话不许复活」这一类)。 */
function hitsAnywhere(files: readonly SrcFile[], re: RegExp): string[] {
  return files.filter((f) => re.test(f.src)).map((f) => f.path);
}

/** 含 ≥ min 个「当前调色盘」颜色的文件(颜色取自冻结层那一份,不另抄)。 */
function filesWithManyPaletteColors(files: readonly SrcFile[], min: number): string[] {
  return files
    .map((f) => ({ path: f.path, n: DYE_PALETTE.filter((c) => f.code.includes(c)).length }))
    .filter((x) => x.n >= min)
    .map((x) => x.path);
}

/** 把某一路径的源码**换成注入版**(其余文件原样)—— 注入验证的最小机制。 */
function inject(files: readonly SrcFile[], path: string, src: string): SrcFile[] {
  return files.map((f) => (f.path === path ? mkFile(path, src) : f));
}

const lineAt = (src: string, n: number): string => (src.split(/\r?\n/)[n - 1] ?? '');
const lineCount = (src: string): number => src.split(/\r?\n/).length;

const PROD = productionFiles();

/* ═══════════════ 1. 染色距离衰减:唯一的一条曲线 ═══════════════ */

const SAMPLE_CELLS: readonly number[] = [0, 1, 5, 14.9, 15, 22.5, 29, 30, 31, 100];

test('FND136-1 两条染色路径与冻结层逐点同值;中点 15 格 = 0.5(FREEZE.md:228)', () => {
  eq(DYE_DECAY_FAR_CELLS, 30, '射程口径:30 格(唯一一份 `DYE_DECAY_FAR_CELLS`)');
  eq(SPRAY_RANGE_FAR, 30, '覆盖层的射程上界必须就是 30');
  ok(SPRAY_RANGE_FAR === DYE_DECAY_FAR_CELLS, '两处射程必须同源(dye_overlay 不许另写 30)');
  ok(SPRAY_RANGE_NEAR * 2 === DYE_DECAY_FAR_CELLS, '近距分界 = 射程的一半(= 判据里的「中点」)');
  eq(SPRAY_RANGE_NEAR, 15, '近距分界 = 15 格');

  for (const d of SAMPLE_CELLS) {
    ok(
      sprayAttenuation(d) === dyeDecayAt(d),
      `${d} 格:覆盖层与 dye_decay 必须逐位相同(实测 ${sprayAttenuation(d)} vs ${dyeDecayAt(d)})`,
    );
    ok(
      sprayAttenuation(d) === dyeAttenuation(d, DYE_DECAY_FAR_CELLS),
      `${d} 格:必须等于冻结层 dyeAttenuation(实测 ${sprayAttenuation(d)})`,
    );
    ok(
      sprayStrengthAtDistance(d) === sprayAttenuation(d),
      `${d} 格:「能不能染上」与「有多浓」必须是同一个数`,
    );
  }

  /* 冻结判据本身(期望值全是字面量,不取被测模块的输出)。 */
  eq(sprayAttenuation(0), 1, '端点:贴身 = 1');
  eq(sprayAttenuation(15), 0.5, '★ 中点 15 格 = 0.5(FREEZE.md:228 第 7 条)');
  eq(sprayAttenuation(22.5), 0.25, '22.5 格 = 1 − 22.5/30 = 0.25');
  eq(sprayAttenuation(30), 0, '端点:射程处 = 0');
  eq(sprayAttenuation(31), 0, '射程外 = 0');
  eq(sprayAttenuation(-3), 1, '负距离按贴身处理(= 1,与 dyeDecayAt 同口径)');

  let prev = sprayAttenuation(0);
  for (let d = 0.5; d <= 30; d += 0.5) {
    const cur = sprayAttenuation(d);
    ok(cur <= prev, `单调不增在 ${d} 格破了:${prev} → ${cur}`);
    prev = cur;
  }
});

test('FND136-2 负对照:旧平台折线的两个特征值必须已消失(否则判据 1 会被它遮住)', () => {
  ok(sprayAttenuation(15) !== 1, '旧口径「15 格内满强度」必须已删 —— 它正是中点 0.5 不成立的原因');
  ok(
    Math.abs(sprayAttenuation(22.5) - 0.5) > 1e-9,
    '旧口径「22.5 格才是中点」必须已删(现在 22.5 格 = 0.25)',
  );
  /* 注释里的旧话:那条与两条实现**都不符**的数(0.61)+ 旧的射程描述 */
  const overlay = readOne('client/src/stage/dye_overlay.ts');
  eq(hitsAnywhere([overlay], /0\.61/), [], 'dye_overlay.ts 里那条「0.61」已经没有任何实现能对上');
  eq(hitsAnywhere([overlay], /15 格内满强度/), [], '旧的「15 格内满强度」注释必须已订正');
});

test('FND136-3 32 色调色盘:三处消费点与冻结层是同一批绑定(引用相等)', () => {
  ok(PALETTE_32 === DYE_PALETTE, '画架的 PALETTE_32 必须就是冻结层那一份(=== 引用相等)');
  ok(OVERLAY_PALETTE === DYE_PALETTE, '染色覆盖层的 DYE_PALETTE 必须就是冻结层那一份');
  ok(
    PALETTE_SIZE === DYE_PALETTE_SIZE
      && OVERLAY_PALETTE_SIZE === DYE_PALETTE_SIZE
      && SCORING_PALETTE_SIZE === DYE_PALETTE_SIZE,
    '三处「32」都必须等于冻结层的 DYE_PALETTE_SIZE',
  );
  eq(DYE_PALETTE_SIZE, 32, '调色盘色数 = 32');
  eq(PALETTE_SIZE, 32, '画架的 PALETTE_SIZE = 32');
  eq(OVERLAY_PALETTE_SIZE, 32, '覆盖层的 DYE_PALETTE_SIZE = 32');
  eq(SCORING_PALETTE_SIZE, 32, '服务端记分槽数 = 32');
  eq(PALETTE_COLS * PALETTE_ROWS, 32, 'UI 网格 8×4 = 32');
  eq(PALETTE_ROWS, 4, '行数由色数推出:32 / 8 = 4');

  /* ★ 负对照(第十轮 P3 修):修前这里是
       —— 一个自造的 `a===b` 比较器,套在一份逐字节相同的副本上断言 false
     —— 纯 JS 引用语义,**与被测实现无数据依赖**:把 `PALETTE_32` 改成独立副本、
     甚至把整个导出删掉,这一行照样为 false(删除实现也不会红)。
     现在改成**源码形态 + 注入**:被测模块必须把 `PALETTE_32` 落成**别名**
     (`= DYE_PALETTE`);把数组字面量(旧形态的第二份副本)写回去 ⇒ 命中。
     ⇒ 这条对照依赖实现:实现一改成副本就红。 */
  const easel = readOne('client/src/ui/pixel_easel.ts');
  const ALIAS = /export\s+const\s+PALETTE_32\s*:[^=]*=\s*DYE_PALETTE\s*;/;
  const COPY = /export\s+const\s+PALETTE_32\s*:[^=]*=\s*\[/;
  ok(ALIAS.test(easel.code), 'PALETTE_32 必须是**别名**(`= DYE_PALETTE`),不是第二份数组副本');
  eq(hitsInCode([easel], COPY), [], '画架不许用数组字面量声明 PALETTE_32(= 第二份副本)');
  const copyBack = "export const PALETTE_32: readonly string[] = ['#000000', '#ffffff'];\n";
  eq(hitsInCode([mkFile('client/src/ui/pixel_easel.ts', copyBack)], COPY).length, 1,
    '负对照/注入:把数组字面量写回画架 ⇒ 副本形态命中(证明本判据有牙)');
  eq(ALIAS.test(copyBack), false, '负对照/注入:副本形态**不**满足别名判据');
});

test('FND136-4 调色盘字面量只在一处;把副本写回任一侧 ⇒ 本判据变红', () => {
  eq(filesWithManyPaletteColors(PROD, 4), ['shared/constants/dye.ts'],
    '含 ≥4 个调色盘颜色的生产文件只能有一个');
  const dye = readOne('shared/constants/dye.ts');
  eq(DYE_PALETTE.filter((c) => dye.src.includes(c)).length, 32, '冻结层那一份必须 32 色齐全');

  /* 注入:把 32 色副本写回画架(等价于改版前的形态)⇒ 命中数必须变成 2 */
  const easel = readOne('client/src/ui/pixel_easel.ts');
  const copyBack = `export const PALETTE_32: readonly string[] = [\n  ${DYE_PALETTE.slice(0, 4).map((c) => `'${c}'`).join(', ')},\n];\n`;
  const injected = inject(PROD, 'client/src/ui/pixel_easel.ts', copyBack);
  eq(filesWithManyPaletteColors(injected, 4).length, 2,
    `注入:画架侧再写一份 ⇒ 命中 2 处(实测 ${filesWithManyPaletteColors(injected, 4).join(' / ')})`);
  ok(filesWithManyPaletteColors(PROD, 4).length === 1, `未注入时命中 1 处(实测 ${easel.path})`);
});

test('FND136-5 「32」不再以字面量硬编码;写回任一侧 ⇒ 红', () => {
  const HARDCODED = /(?:PALETTE_SIZE|DYE_PALETTE_SIZE)\s*=\s*32\b/;
  eq(hitsInCode(PROD, HARDCODED), [], '生产代码里不许有 `…PALETTE_SIZE = 32` 这种第二处声明');
  const synthetic: SrcFile[] = [mkFile('server/src/party/scoring.ts', 'export const DYE_PALETTE_SIZE = 32;\n')];
  eq(hitsInCode(synthetic, HARDCODED).length, 1, '注入:写回 `= 32` ⇒ 扫描器命中(证明它有牙)');
  const serverBack = readOne('server/src/party/scoring.ts').src
    .replace('export { DYE_PALETTE_SIZE };', 'export const DYE_PALETTE_SIZE = 32;');
  eq(
    hitsInCode(inject(PROD, 'server/src/party/scoring.ts', serverBack), HARDCODED).length,
    1,
    '注入:改服务端侧 ⇒ 红',
  );
});

test('FND136-6 BASE_HP 只有一份声明(100);`physics.ts` 只转发', () => {
  eq(BASE_HP, 100, '冻结层 entities.ts#BASE_HP = 100');
  eq(PHYSICS_BASE_HP, 100, 'physics.ts 转发出来的也是 100');
  eq(PLAYER_BASE_HP, 100, 'vitals 的缺省上限 = 100');
  ok(PHYSICS_BASE_HP === BASE_HP && BASE_HP === PLAYER_BASE_HP,
    '三处必须是同一个值(改一处其余跟着变,不是"碰巧都是 100")');

  const DECL = /export const BASE_HP\s*=\s*[^;]+;/;
  eq(hitsInCode(PROD, DECL), ['shared/types/entities.ts'], 'BASE_HP 的 `export const` 只能有一处');
  const physics = readOne('shared/types/physics.ts');
  ok(physics.src.includes("export { BASE_HP } from './entities.ts';"),
    'physics.ts 必须把副本换成对 entities.ts 的**转发**');

  const back = inject(PROD, 'shared/types/physics.ts', 'export const BASE_HP = 100;\n');
  eq(hitsInCode(back, DECL).length, 2, '注入:把副本写回 physics.ts ⇒ 命中 2 处(改版前正是 2 处)');
});

test('FND136-7 24 格:祭坛参与半径引用经验共享半径;写回字面量 ⇒ 红', () => {
  eq(SHARE_EXP_RADIUS, 24, '经验共享半径 = 24(冻结层)');
  eq(RAID_PARTICIPATION_RADIUS, 24, '祭坛参与判定半径 = 24');
  ok(RAID_PARTICIPATION_RADIUS === SHARE_EXP_RADIUS,
    '两者必须是同一个来源(改版前注释自称"一致"却各自手抄 24)');

  const raid = readOne('server/src/bosses/raid.ts');
  ok(raid.src.includes('export const RAID_PARTICIPATION_RADIUS = SHARE_EXP_RADIUS;'),
    'raid.ts 必须引用 SHARE_EXP_RADIUS,而不是再写一个 24');
  const REWRITTEN = /RAID_PARTICIPATION_RADIUS\s*=\s*24\b/;
  eq(hitsInCode(PROD, REWRITTEN), [], '生产代码里不许再出现手抄的 `= 24`');
  eq(
    hitsInCode(inject(PROD, 'server/src/bosses/raid.ts', 'export const RAID_PARTICIPATION_RADIUS = 24;\n'), REWRITTEN).length,
    1,
    '注入:写回 `= 24` ⇒ 红',
  );
});

test('FND136-8 TOWN_SAFE_RADIUS 保留自己的 24,注释必须写明「数值相同、语义不同」', () => {
  eq(TOWN_SAFE_RADIUS, 24, '城镇安全区半径 = 24(语义:刷怪抑制 + 护盾)');
  const spawner = readOne('server/src/mobs/spawner.ts');
  ok(spawner.src.includes('export const TOWN_SAFE_RADIUS = 24;'),
    '它必须保留**自己的**数值(不许改成引用经验共享半径:那是另一件事)');
  ok(spawner.src.includes('语义不同') && spawner.src.includes('数值相同'),
    '注释必须写明与经验共享半径「数值相同、语义不同」,否则下一个人会把它合并掉');
  eq(hitsInCode(PROD, /TOWN_SAFE_RADIUS\s*=\s*SHARE_EXP_RADIUS/), [],
    '不许把安全区半径接到经验共享半径上(数值相同不等于同一件事)');
});

test('FND136-9 掉落翻倍概率:共享常量 + raid.ts 不再写裸字面量', () => {
  eq(DROP_DOUBLE_CHANCE, 0.35, '共享常量 = 0.35(既有内容里的那个数,不是新拍的)');
  const raid = readOne('server/src/bosses/raid.ts');
  ok(raid.code.includes('rng() < DROP_DOUBLE_CHANCE'), 'raid.ts 必须取共享常量');
  const BARE = /rng\(\)\s*<\s*0\.35/;
  eq(hitsInCode(PROD, BARE), [], '生产代码里不许再出现裸的 `rng() < 0.35`');
  eq(hitsInCode([mkFile('server/src/bosses/raid.ts', 'const j = rng() < 0.35 ? 1 : 0;\n')], BARE).length, 1,
    '注入:写回裸字面量 ⇒ 红');

  /* 另一个消费点(603 烘焙派词条)这一轮不在写域内 ⇒ 用判据把「两处同值」钉住:
     哪天它单独改了,这条会红,提醒同步(它已经写在共享常量的注释里)。 */
  const cook = readOne('server/src/combat/cooking.ts');
  const declared = Number(/dropDoubleChance:\s*([0-9.]+)/.exec(cook.src)?.[1]);
  eq(declared, 0.35, '603 烘焙派词条的 dropDoubleChance 仍应是 0.35');
  ok(declared === DROP_DOUBLE_CHANCE, '两处必须同值:一处改、另一处不改就是静默分叉');
});

test('FND136-10 action_table 的注释与表实况一致(24 条;旧话不许复活)', () => {
  const tableSrc = readOne('server/src/net/actions/action_table.ts');
  const actual = Object.keys(ACTION_HANDLERS).length;
  eq(actual, 24, '实况:表里 24 条动作');
  eq(
    Object.keys(ACTION_HANDLERS).filter((k) => typeof (ACTION_HANDLERS as unknown as Record<string, unknown>)[k] === 'function').length,
    24,
    '每个键都必须绑到一个处理器函数(没有占位空实现)',
  );

  /* 注释里每一处「N 个动作」都必须等于实况(钉结构,不钉某个抄来的数)。 */
  const claimed: number[] = [];
  for (const m of tableSrc.src.matchAll(/(\d+)\s*个动作/g)) claimed.push(Number(m[1]));
  ok(claimed.length >= 2, `注释里至少要有 2 处「N 个动作」可核(实测 ${claimed.length} 处)`);
  for (const c of claimed) eq(c, actual, `注释写的 ${c} 个动作与表实况 ${actual} 不一致`);

  /* 旧话:与实况不符的两句(改版前写着「22 个动作 / 13 个未接」)。 */
  eq(hitsAnywhere([tableSrc], /22\s*个动作/), [], '本文件不许再写「22 个动作」');
  eq(hitsAnywhere([tableSrc], /13\s*个未接/), [], '本文件不许再写「13 个未接动作」');

  /* 注入:把旧话写回去 ⇒ 与实况 24 不等 ⇒ 红 */
  const stale = ' * **动作 → 处理器**的唯一一张表(`RoomAction` 22 个动作的**执行层归属**)。';
  const staleClaims: number[] = [];
  for (const m of stale.matchAll(/(\d+)\s*个动作/g)) staleClaims.push(Number(m[1]));
  eq(staleClaims.length, 1, '注入样本里能解析出 1 处声明');
  ok(staleClaims[0] !== actual, `注入:「22 个动作」必须与实况 ${actual} 不等(否则本判据无区分力)`);
});

/* ═══════════ 2. scoring.ts 的判据锚:逐条对账 ═══════════ */

interface Anchor {
  /** `scoring.ts` 注释里的原文写法(键)。 */
  ref: string;
  /** 解析到的仓库相对路径。 */
  file: string;
  /** 起始行(1-based)。 */
  line: number;
  /** 区间终点(可选)。 */
  end?: number;
  /** 该锚声称的符号:必须**出现在那一行**(行号锚的全部意义)。 */
  marker: string;
}

/**
 * `scoring.ts` 里**允许**出现的 `文件.ts:行号` 判据锚(第九轮逐条重钉)。
 *
 * 为什么必须有这张表而不是"扫一遍看看有没有越界":越界只能抓住「文件缩了」,
 * 抓不住「文件长了、行号指向了别的代码」—— 后者才是本仓实测到的那一类
 * (`ARCH-GAPS` 的 `vitals.ts:345` 之谜)。所以这里钉的是「那一行真的是那个符号」。
 */
const ANCHORS: readonly Anchor[] = [
  { ref: 'modes.ts:257', file: 'server/src/party/modes.ts', line: 257, marker: 'BRIDGE_SCORE_PER_FLAG = 100' },
  { ref: 'modes.ts:258', file: 'server/src/party/modes.ts', line: 258, marker: 'BRIDGE_SCORE_PER_TILE = 2' },
  { ref: 'modes.ts:329', file: 'server/src/party/modes.ts', line: 329, marker: 'function settleBridgeRun' },
  { ref: 'modes.ts:479', file: 'server/src/party/modes.ts', line: 479, marker: 'ts.score += 1' },
  { ref: 'modes.ts:595-598', file: 'server/src/party/modes.ts', line: 595, end: 598, marker: 'r.holderTeam !== null' },
  { ref: 'modes.ts:597', file: 'server/src/party/modes.ts', line: 597, marker: 'ts.crownSec += dt' },
  { ref: 'modes.ts:614', file: 'server/src/party/modes.ts', line: 614, marker: 'function settleCrown' },
  { ref: 'modes.ts:695', file: 'server/src/party/modes.ts', line: 695, marker: '.tiles = tiles' },
  { ref: 'modes.ts:706', file: 'server/src/party/modes.ts', line: 706, marker: 'function settlePaintWar' },
  { ref: 'start_party.ts:87', file: 'server/src/net/actions/start_party.ts', line: 87, marker: 'PARTY_MODE_VALUES' },
  { ref: 'start_party.ts:102', file: 'server/src/net/actions/start_party.ts', line: 102, marker: 'scores: Map<string, number>' },
  { ref: 'start_party.ts:199', file: 'server/src/net/actions/start_party.ts', line: 199, marker: 'function addScore' },
  { ref: 'start_party.ts:256-259', file: 'server/src/net/actions/start_party.ts', line: 256, end: 259, marker: 'rows.sort' },
  { ref: 'server/src/net/actions/start_party.ts:199', file: 'server/src/net/actions/start_party.ts', line: 199, marker: 'function addScore' },
  { ref: 'shared/constants/bosses.ts:247', file: 'shared/constants/bosses.ts', line: 247, marker: 'export const PARTY_MODES' },
  { ref: 'docs/WS-11-coop-prank-party.md:453', file: 'docs/WS-11-coop-prank-party.md', line: 453, marker: '未夺旗队 + 2 × built' },
  { ref: 'docs/WS-11-coop-prank-party.md:463', file: 'docs/WS-11-coop-prank-party.md', line: 463, marker: '进球 → 对手队 goals++' },
];

const ANCHOR_REF = /([A-Za-z0-9_./-]+\.(?:ts|md|json)):(\d+)(?:\s*[-–~]\s*(\d+))?/g;

/** 抽出源码里所有 `文件:行` 引用(去重,保持首次出现序)。 */
function parseAnchors(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(ANCHOR_REF)) {
    const key = `${m[1]}:${m[2]}${m[3] ? `-${m[3]}` : ''}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** 按 basename 建索引(与 `scripts/doc-line-audit.ts` 同一套解析策略)。 */
function basenameIndex(): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const all = [...walkTs('shared'), ...walkTs('client'), ...walkTs('server'), ...walkTs('docs')];
  for (const p of all) {
    const b = norm(p).split('/').pop() as string;
    idx.set(b, [...(idx.get(b) ?? []), norm(p)]);
  }
  return idx;
}

/** 一条锚的问题列表(空 = 这条锚站得住)。 */
function anchorProblems(a: Anchor, idx: Map<string, string[]>): string[] {
  const problems: string[] = [];
  const refPath = a.ref.slice(0, a.ref.lastIndexOf(':'));
  if (!a.file.endsWith(refPath)) problems.push(`${a.ref}:表里的路径与 ref 不一致(${a.file})`);
  let file = a.file;
  if (!refPath.includes('/')) {
    const hits = idx.get(refPath) ?? [];
    if (hits.length !== 1) return [`${a.ref}:basename 解析到 ${hits.length} 个文件(需人判)`];
    file = hits[0] as string;
  }
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return [`${a.ref}:目标文件不存在(${file})`];
  }
  const total = lineCount(text);
  if (a.line > total) problems.push(`${a.ref}:行号 ${a.line} > 文件总行数 ${total}`);
  if (a.end !== undefined && a.end > total) problems.push(`${a.ref}:区间终点 ${a.end} > 总行数 ${total}`);
  const at = lineAt(text, a.line);
  if (!at.includes(a.marker)) {
    problems.push(`${a.ref}:L${a.line} 不是「${a.marker}」(实测:«${at.trim().slice(0, 60)}»)`);
  }
  return problems;
}

test('FND136-11 scoring.ts 的判据锚逐条对账:那一行真的是那个符号;未登记的锚 ⇒ 红', () => {
  const scoring = readOne('server/src/party/scoring.ts');
  const idx = basenameIndex();

  const problems: string[] = [];
  for (const a of ANCHORS) problems.push(...anchorProblems(a, idx));
  eq(problems.length, 0, `判据锚逐条对账(实测问题:${problems.join(' || ')})`);

  /* 反向:源码里出现的每个锚都必须在表里(否则新加的锚没人核)。 */
  const known = new Set(ANCHORS.map((a) => a.ref));
  const unregistered = parseAnchors(scoring.src).filter((r) => !known.has(r));
  eq(unregistered.length, 0, `scoring.ts 里出现未登记的判据锚:${unregistered.join(', ')}`);

  /* 源文件里那个锚必须真的写着(表不是凭空造的)。 */
  for (const a of ANCHORS) {
    ok(scoring.src.includes(a.ref), `scoring.ts 里应写着 ${a.ref}`);
  }

  /* 负对照:把「过期的行号」当锚 ⇒ 必须被抓住(改版前 modes.ts:213/266/405/519/537/614/629
     全部指向别的东西,本判据逐条报出)。 */
  const stale: Anchor = { ref: 'modes.ts:213', file: 'server/src/party/modes.ts', line: 213, marker: 'BRIDGE_SCORE_PER_TILE = 2' };
  ok(anchorProblems(stale, idx).length > 0, '负对照:旧行号 213 指不到 `BRIDGE_SCORE_PER_TILE` ⇒ 必须报问题');

  /* `world_sim.ts` 的锚**刻意只钉符号名**(它已上万行、每轮都在长):所以这里核符号。 */
  const ws = readOne('server/src/sim/world_sim.ts');
  ok(scoring.src.includes('this.bus.emit(\'party_event\', { kind: ev })'), 'scoring.ts 必须点名 party_event 的发射形状');
  ok(scoring.src.includes('`after.alive = false`'), 'scoring.ts 必须点名击杀那行的形状');
  ok(ws.code.includes('bus.emit(\'party_event\''), 'world_sim.ts 里必须真的有这个发射点(锚不能指向不存在的东西)');
  ok(ws.code.includes('after.alive = false'), 'world_sim.ts 里必须真的有 `after.alive = false`');
});

test('FND136-12 染色覆盖层不再自带折线算术(旧公式不许复活)', () => {
  const plateau = /SPRAY_RANGE_FAR\s*-\s*SPRAY_RANGE_NEAR/;
  eq(hitsInCode(PROD, plateau), [], '生产代码里不许再有「射程平台 + 折线」的那套算术');
  const overlay = readOne('client/src/stage/dye_overlay.ts');
  ok(overlay.code.includes('return dyeDecayAt(distance);'), 'sprayAttenuation 必须直接转发 dyeDecayAt');
  ok(overlay.code.includes('export { DYE_PALETTE, DYE_PALETTE_SIZE };'),
    '调色盘必须是**转发**(`export { … }`),不是又一次 `export const … = [...]`');
  eq(
    hitsInCode([mkFile('client/src/stage/dye_overlay.ts',
      'return 1 - (d - SPRAY_RANGE_NEAR) / (SPRAY_RANGE_FAR - SPRAY_RANGE_NEAR);\n')], plateau).length,
    1,
    '注入:写回旧折线公式 ⇒ 红',
  );
});

report('WS-FND-136');
