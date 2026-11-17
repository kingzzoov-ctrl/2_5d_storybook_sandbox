/**
 * WS-FND-76 测试侧欠账清零的**有牙证明**(档 2 第 1/2/5 组)。
 *
 * ## 它守的是什么
 * 本套件不测业务行为,只测「刚清掉的那批断言**现在还咬得住**」:
 *
 * 1 十六处「期望值 / 上下界取自被测模块」的站点已换成**字面量**,
 *   且每个常量都留了一条 `eq(CONST, 字面量)` 锚点 —— 常量被改坏时**锚点先红**,
 *   不会像原写法那样「两边一起漂、恒真通过」;
 * 2 `tests/WS-08.test.ts` 的弹簧垫冷却由单侧 `cooldown > 0` 改成**双侧**
 *   (实测值 3 = 4 帧冷却 − 已递减的 1 帧);
 * 3 `tests/WS-FND-06.test.ts` 的三个**死导入**(`S_LOGIC_MIN` / `S_LOGIC_MAX` /
 *   `PROF_MAX_LEVEL`)已不在文件里 —— 且这三个常量**仍在** `attributes.ts` 导出
 *   (是删导入,不是删常量)。
 *
 * ## 为什么不用「子进程注入」
 * 注入要在门禁运行时**改写被测源文件**,那会制造竞态与残留,而门禁本身要求可重复。
 * 这里用两条**等价判据**代替:
 *
 * - **运行期**:直接 import 真实常量与真实实现,期望值全写字面量
 *   ⇒ 常量被改坏时**本套件当场红**(不必等子进程);
 * - **静态**:用 `scripts/verify.ts` 的 `detectTautologyHits`(与门禁**同一份**判据)
 *   扫这五个套件,要求这十四个常量名 **0 命中**;
 *   并用一份「旧写法」样本证明该判据在旧写法上**确实会响**
 *   —— 否则「0 命中」可能只是判据坏了(形态:判据本身失去区分力)。
 *
 * ## 一条纪律:期望值全部手写
 * 本文件**不**从被测模块取任何期望值:字面量 -1 / 0.8 / 1.25 / 1.5 / 3 / 4 / 6 / 6.6 /
 * 32 / 50 / 69 / 512 与文件行号都是手写的;被测模块只出现在 `actual` 侧。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, near, inRange, report } from '../shared/testing/harness.ts';
import { maskSource, detectTautologyHits } from '../scripts/verify.ts';

/* 被测常量(只做 actual 侧;期望值写字面量) */
import { TELEGRAPH_SEC_MIN, TELEGRAPH_SEC_MAX } from '../server/src/mobs/fsm.ts';
import { BOAR_CHARGE_TILES } from '../server/src/mobs/behaviors.ts';
import {
  EPSILON_MIN, EPSILON_MAX, UTIL_CAP_PERCENT,
  S_LOGIC_MIN, S_LOGIC_MAX, PROF_MAX_LEVEL,
} from '../server/src/alchemy/attributes.ts';
import { WireColor } from '../shared/types/tile.ts';
import { SignalGraph, layHorizontal } from '../server/src/wiring/graph.ts';
import { makeComponent, SPRING_COOLDOWN_TICKS } from '../server/src/wiring/components.ts';
import { BASE_CRIT_DMG } from '../server/src/combat/weapons.ts';
import { PITCH_COUNT, PITCH_BRICK_ROWS, PITCH_BRICK_COLS, A4_MIDI, pitchInfo } from '../client/src/audio.ts';
import { ORTHO_DISTANCE, cameraPosition } from '../client/src/stage/assembly_math.ts';
import { TRANSPARENT_INDEX, PixelEasel } from '../client/src/ui/pixel_easel.ts';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** 读某个套件的**剥注释**源码(`maskSource` 把注释与字符串内容抹成空格、长度不变)。 */
function maskedSuite(suite: string): string {
  return maskSource(readFileSync(join(TESTS_DIR, `${suite}.test.ts`), 'utf8'));
}

/** 原样源码(要扫 import 名,不能混淆)。 */
function rawSuite(suite: string): string {
  return readFileSync(join(TESTS_DIR, `${suite}.test.ts`), 'utf8');
}

/* ══════════ 1 常量锚点:被字面量钉住的那批常量,现在真的钉住了 ══════════ */

test('T1 常量锚点:十四个常量对上手写字面量(改坏任一 ⇒ 本套件红)', () => {
  /* 每条右值都是**手册数值**,不取自被测模块。
     若有人把常量改成别的值,这里立刻红 —— 这一步就是「有牙」的最小内核。 */
  eq(TELEGRAPH_SEC_MIN, 0.8, '预警时长下界 = 0.8s(手册 §5)');
  eq(TELEGRAPH_SEC_MAX, 1.5, '预警时长上界 = 1.5s(手册 §5)');
  eq(BOAR_CHARGE_TILES, 6, '野猪冲锋 = 6 格(手册 §5)');
  eq(EPSILON_MIN, 0.8, 'ε 截断下界 = 0.8');
  eq(EPSILON_MAX, 1.25, 'ε 截断上界 = 1.25');
  eq(UTIL_CAP_PERCENT, 50, 'Util 上限 = 50%');
  eq(SPRING_COOLDOWN_TICKS, 4, '弹簧垫冷却 = 4 帧(2.0s @ 2Hz)');
  eq(BASE_CRIT_DMG, 1.5, '基础爆伤 = 1.5(150%)');
  eq(PITCH_COUNT, 32, '音高数 = 32');
  eq(PITCH_BRICK_ROWS, 2, '音高砖 2 行');
  eq(PITCH_BRICK_COLS, 16, '音高砖 16 列');
  eq(A4_MIDI, 69, 'A4 MIDI = 69');
  eq(ORTHO_DISTANCE, 512, '正交距离 = 512');
  eq(TRANSPARENT_INDEX, -1, '透明哨兵 = -1');
});

test('T2 常量锚点:行数 / 乘积 / 距离这些「结构关系」也咬得住', () => {
  /* 2 × 16 = 32:三边都是字面量 ⇒ 改行数、改列数、改音高总数任一都会红 */
  eq(PITCH_BRICK_ROWS * PITCH_BRICK_COLS, 32, '2×16 = 32 音');
  eq(PITCH_COUNT, 32, '音高总数 = 32');
  /* 相机到焦点的距离恒为 512,与焦点位置无关 */
  const pos = cameraPosition(0, 0, 0);
  near(Math.hypot(pos.x, pos.y, pos.z), 512, 1e-9, '相机到焦点距离 = 512');
  const pos2 = cameraPosition(10, 20, 1);
  near(Math.hypot(pos2.x - 10, pos2.y - 20, pos2.z - 1), 512, 1e-9, '平移焦点后距离仍 = 512');
  /* 音高 9 = A4 = MIDI 69(真实实现 + 手写字面量) */
  eq(pitchInfo(9).midi, 69, '音高 9 的 MIDI = 69');
  /* 透明哨兵:真实实现读回 -1,不是「读回常量本身」的同义反复 */
  const e = new PixelEasel();
  eq(e.get(0, 0), -1, '新画架像素为 -1');
  ok(e.paint(2, 2, 5), '上色成功');
  ok(!e.paint(2, 2, 5), '同色重复上色不入栈');
  eq(e.get(99, 99), -1, '越界读出 -1');
});

/* ══════════ 2 WS-08 双侧:弹簧垫冷却(单侧 `> 0` ⇒ 双侧) ══════════ */

test('T3 WS-08 冷却双侧:真实图跑出 3,上下界都钉住', () => {
  /* 场景与 `tests/WS-08.test.ts::WT-08-32` 一致。冷却 4 帧:
     第 1 帧弹射并把冷却置 4,第 2 帧递减 1 ⇒ `run(2)` 后应为 **3**。
     ★ 双侧性:常量若改成 8 ⇒ 实测 7(上界破);改成 2 ⇒ 实测 1(下界破)。
       原写法 `cooldown > 0` 在这两种改法下**都还是绿的** —— 那才是欠账。 */
  const g = new SignalGraph(12, 12);
  layHorizontal(g, 3, 9, 3, WireColor.RED);
  const spring = makeComponent('spring', 422, 4, 3, { params: { launchDir: 2, range: 5 } });
  g.addComponent(spring);
  g.drive(3, 3, WireColor.RED, true);
  spring.params.payloadAbove = 1;
  g.run(2);
  eq(spring.state.launches, 1, '弹簧垫弹射 1 次');
  eq(SPRING_COOLDOWN_TICKS, 4, '冷却常量 = 4 帧');
  eq(spring.state.cooldown, 3, '弹射后冷却 = 3(4 − 1),不是「> 0」');
  inRange(spring.state.cooldown, 1, 4, '冷却落在 (0, 4] 内且上界同样被盯住');
});

/* ══════════ 3 WS-FND-06 三个死导入:已删,且常量仍在导出 ══════════ */

test('T4 WS-FND-06:三个死导入不在文件里,常量本身仍在 attributes.ts 导出', () => {
  const src = rawSuite('WS-FND-06');
  /* 逐名扫全文(包括注释):死导入若回来,这里先红 */
  ok(!/\bS_LOGIC_MIN\b/.test(src), 'WS-FND-06 里仍有 S_LOGIC_MIN 引用');
  ok(!/\bS_LOGIC_MAX\b/.test(src), 'WS-FND-06 里仍有 S_LOGIC_MAX 引用');
  ok(!/\bPROF_MAX_LEVEL\b/.test(src), 'WS-FND-06 里仍有 PROF_MAX_LEVEL 引用');
  /* 反证:删的是**导入**,不是常量 —— 三个常量仍可用、仍是数值 */
  eq(typeof S_LOGIC_MIN, 'number', 'S_LOGIC_MIN 仍在 attributes.ts 导出');
  eq(typeof S_LOGIC_MAX, 'number', 'S_LOGIC_MAX 仍在 attributes.ts 导出');
  eq(typeof PROF_MAX_LEVEL, 'number', 'PROF_MAX_LEVEL 仍在 attributes.ts 导出');
  ok(Number.isFinite(S_LOGIC_MIN) && Number.isFinite(S_LOGIC_MAX), 'S 逻辑上下界是有限数');
  ok(Number.isInteger(PROF_MAX_LEVEL) && PROF_MAX_LEVEL > 0, 'PROF_MAX_LEVEL 是正整数');
  /* 对照:同一 import 块里的兄弟名字仍在(证明这条断言不是「整块都被删了」) */
  ok(/\bPROF_RATE_PER_LEVEL\b/.test(src), '同块的 PROF_RATE_PER_LEVEL 应仍在');
  ok(/\bEPSILON_SIGMA\b/.test(src), '同块的 EPSILON_SIGMA 应仍在');
});

/* ══════════ 4 站点静态断言:期望侧现在是字面量(剥注释后扫) ══════════ */

test('T5 站点静态:十六处用字面量,不再引被测常量作期望值', () => {
  const w4 = maskedSuite('WS-04');
  ok(w4.includes('inRange(fsm.telegraph!.geom.warnSec, 0.8, 1.5'), 'WS-04 预警区间应为字面量');
  ok(w4.includes('eq(TELEGRAPH_SEC_MIN, 0.8'), 'WS-04 常量锚点(TELEGRAPH_SEC_MIN)缺失');
  ok(w4.includes('eq(TELEGRAPH_SEC_MAX, 1.5'), 'WS-04 常量锚点(TELEGRAPH_SEC_MAX)缺失');
  ok(!w4.includes('geom.warnSec, TELEGRAPH_SEC_MIN'), 'WS-04 仍有「区间取自常量」的写法');
  ok(w4.includes('inRange(rt.mem.travel, 6, 6.6'), 'WS-04 冲锋距离应为字面量区间');
  ok(w4.includes('eq(BOAR_CHARGE_TILES, 6'), 'WS-04 常量锚点(BOAR_CHARGE_TILES)缺失');
  ok(!w4.includes('rt.mem.travel, BOAR_CHARGE_TILES'), 'WS-04 仍有「下界取自常量」的写法');

  const w6 = maskedSuite('WS-06');
  ok(w6.includes('inRange(e, 0.8, 1.25'), 'WS-06 ε 采样应为字面量区间');
  ok(w6.includes('eq(EPSILON_MIN, 0.8'), 'WS-06 常量锚点(EPSILON_MIN)缺失');
  ok(w6.includes('eq(EPSILON_MAX, 1.25'), 'WS-06 常量锚点(EPSILON_MAX)缺失');
  ok(w6.includes('inRange(out.stats.rolled.util, 0, 50'), 'WS-06 两处 util 上界应为 50');
  ok(w6.includes('eq(UTIL_CAP_PERCENT, 50'), 'WS-06 常量锚点(UTIL_CAP_PERCENT)缺失');
  ok(!w6.includes('rolled.util, 0, UTIL_CAP_PERCENT'), 'WS-06 仍有「上界取自常量」的写法');
  ok(!w6.includes('inRange(e, EPSILON_MIN'), 'WS-06 仍有「区间取自常量」的采样断言');

  const w8 = maskedSuite('WS-08');
  ok(w8.includes('eq(spring.state.cooldown, 3'), 'WS-08 冷却应为双侧(实测 3)');
  ok(w8.includes('eq(SPRING_COOLDOWN_TICKS, 4'), 'WS-08 冷却常量锚点缺失');
  ok(!w8.includes('spring.state.cooldown > 0'), 'WS-08 仍是单侧 `> 0`');

  const w9 = maskedSuite('WS-09');
  ok(w9.includes('eq(e.get(0, 0), -1'), 'WS-09 初始透明应为 -1');
  ok(w9.includes('eq(e.get(3, 4), -1'), 'WS-09 撤销回透明应为 -1');
  ok(w9.includes('eq(e.get(99, 99), -1'), 'WS-09 越界读出应为 -1');
  ok(w9.includes('eq(e.get(5, 5), -1'), 'WS-09 擦除应为 -1');
  ok(w9.includes('eq(e.get(8, 8), -1'), 'WS-09 端点外应为 -1');
  ok(w9.includes('eq(e3.get(0, 0), -1'), 'WS-09 变换后原位应为 -1');
  ok(w9.includes('eq(TRANSPARENT_INDEX, -1'), 'WS-09 常量锚点(TRANSPARENT_INDEX)缺失');
  ok(w9.includes('eq(PITCH_BRICK_ROWS * PITCH_BRICK_COLS, 32'), 'WS-09 音高砖乘积应为 32');
  ok(w9.includes('near(Math.hypot(pos.x, pos.y, pos.z), 512'), 'WS-09 相机距离应为 512');
  ok(w9.includes('eq(ORTHO_DISTANCE, 512'), 'WS-09 常量锚点(ORTHO_DISTANCE)缺失');
  ok(w9.includes('eq(pitchInfo(9).midi, 69'), 'WS-09 音高 9 的 MIDI 应为 69');
  ok(w9.includes('eq(A4_MIDI, 69'), 'WS-09 常量锚点(A4_MIDI)缺失');

  const w10 = maskedSuite('WS-10');
  ok(w10.includes('eq(edgeLow.critMul, 1.5'), 'WS-10 爆伤应为字面量 1.5');
  ok(w10.includes('eq(BASE_CRIT_DMG, 1.5'), 'WS-10 常量锚点(BASE_CRIT_DMG)缺失');
  ok(!w10.includes('critMul, BASE_CRIT_DMG'), 'WS-10 仍有「期望值取自常量」的写法');
});

/* ══════════ 5 门禁同一判据:这十四个常量名在五个套件里 0 命中 ══════════ */

/** 被清零的常量列表:`[套件, [[常量名, 定义模块], ...]]`(与 `verify.ts` 的口径一致)。 */
const CLEARED: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['WS-04', [
    ['TELEGRAPH_SEC_MIN', 'server/src/mobs/fsm.ts'],
    ['TELEGRAPH_SEC_MAX', 'server/src/mobs/fsm.ts'],
    ['BOAR_CHARGE_TILES', 'server/src/mobs/behaviors.ts'],
  ]],
  ['WS-06', [
    ['EPSILON_MIN', 'server/src/alchemy/attributes.ts'],
    ['EPSILON_MAX', 'server/src/alchemy/attributes.ts'],
    ['UTIL_CAP_PERCENT', 'server/src/alchemy/attributes.ts'],
  ]],
  ['WS-08', [
    ['SPRING_COOLDOWN_TICKS', 'server/src/wiring/components.ts'],
  ]],
  ['WS-09', [
    ['PITCH_COUNT', 'client/src/audio.ts'],
    ['PITCH_BRICK_ROWS', 'client/src/audio.ts'],
    ['PITCH_BRICK_COLS', 'client/src/audio.ts'],
    ['A4_MIDI', 'client/src/audio.ts'],
    ['ORTHO_DISTANCE', 'client/src/stage/assembly_math.ts'],
    ['TRANSPARENT_INDEX', 'client/src/ui/pixel_easel.ts'],
  ]],
  ['WS-10', [
    ['BASE_CRIT_DMG', 'server/src/combat/weapons.ts'],
  ]],
];

test('T6 门禁判据复算:这十四个常量名在五个套件里 0 候选、锚点仍在', () => {
  for (const [suite, pairs] of CLEARED) {
    const nameToMod = new Map<string, string>();
    const numExports = new Map<string, string>();
    for (const [name, mod] of pairs) {
      nameToMod.set(name, mod);
      numExports.set(`${mod}::${name}`, '1');
    }
    const scan = detectTautologyHits(rawSuite(suite), nameToMod, numExports);
    ok(
      scan.hits.length === 0,
      `${suite} 仍有同义反复候选:${scan.hits.map((h) => `L${h.line} ${h.constName}[${h.role}]`).join('; ')}`,
    );
    ok(scan.anchors.length > 0, `${suite} 一个锚点都没有 ⇒ 常量失去锚点`);
  }
});

test('T7 反向对照:同一判据在「旧写法」样本上会响(0 命中不是判据坏了)', () => {
  const header = "import { x } from '../server/src/x.ts';\n";
  const names = new Map<string, string>([
    ['TELEGRAPH_SEC_MIN', 'server/src/x.ts'],
    ['TELEGRAPH_SEC_MAX', 'server/src/x.ts'],
  ]);
  const exports = new Map<string, string>([
    ['server/src/x.ts::TELEGRAPH_SEC_MIN', '0.8'],
    ['server/src/x.ts::TELEGRAPH_SEC_MAX', '1.5'],
  ]);
  /* 旧写法:区间两侧都取自被测常量 ⇒ 判据必须报 2 条(lo / hi) */
  const oldSrc = `${header}inRange(v, TELEGRAPH_SEC_MIN, TELEGRAPH_SEC_MAX, 'm');\n`;
  const oldScan = detectTautologyHits(oldSrc, names, exports);
  eq(oldScan.hits.length, 2, '旧写法应被报 2 条(下界 + 上界)');
  eq(oldScan.hits.map((h) => h.role).sort().join(','), 'hi,lo', '两条分别是上下界');
  /* 新写法:同一断言换字面量 ⇒ 0 命中(锚点 0,因为它压根没引常量) */
  const newSrc = `${header}inRange(v, 0.8, 1.5, 'm');\n`;
  eq(detectTautologyHits(newSrc, names, exports).hits.length, 0, '字面量写法不应被报');
  /* 锚点写法:`eq(CONST, 字面量)` 记作锚点而非候选 */
  const anchorSrc = `${header}eq(TELEGRAPH_SEC_MIN, 0.8, 'm');\n`;
  const anchorScan = detectTautologyHits(anchorSrc, names, exports);
  eq(anchorScan.hits.length, 0, '锚点写法不应被报成候选');
  eq(anchorScan.anchors.length, 1, '锚点写法应被记 1 条锚点');
});

/* ══════════ 6 自检:同一份判据对本文件也生效 ══════════ */

test('T8 自检:本文件不引入同义反复写法', () => {
  const pairs: [string, string][] = [
    ['TELEGRAPH_SEC_MIN', 'server/src/mobs/fsm.ts'],
    ['TELEGRAPH_SEC_MAX', 'server/src/mobs/fsm.ts'],
    ['BOAR_CHARGE_TILES', 'server/src/mobs/behaviors.ts'],
    ['EPSILON_MIN', 'server/src/alchemy/attributes.ts'],
    ['EPSILON_MAX', 'server/src/alchemy/attributes.ts'],
    ['UTIL_CAP_PERCENT', 'server/src/alchemy/attributes.ts'],
    ['SPRING_COOLDOWN_TICKS', 'server/src/wiring/components.ts'],
    ['BASE_CRIT_DMG', 'server/src/combat/weapons.ts'],
    ['PITCH_COUNT', 'client/src/audio.ts'],
    ['PITCH_BRICK_ROWS', 'client/src/audio.ts'],
    ['PITCH_BRICK_COLS', 'client/src/audio.ts'],
    ['A4_MIDI', 'client/src/audio.ts'],
    ['ORTHO_DISTANCE', 'client/src/stage/assembly_math.ts'],
    ['TRANSPARENT_INDEX', 'client/src/ui/pixel_easel.ts'],
  ];
  const nameToMod = new Map<string, string>(pairs);
  const numExports = new Map<string, string>(pairs.map(([n, m]) => [`${m}::${n}`, '1']));
  /* 本文件名是 `WS-FND-76-test-debt.test.ts`,不是 `<套件>.test.ts` ⇒ 直接按文件名读。 */
  const scan = detectTautologyHits(rawSuite('WS-FND-76-test-debt'), nameToMod, numExports);
  /* 本文件里这些名字只出现在**锚点**一侧(`eq(CONST, 字面量)`)⇒ 候选必须为 0。
     ⚠️ T7 的合成样本是字符串字面量,`scanAssertionArgs` 内部已 maskSource ⇒ 不计入。 */
  eq(scan.hits.length, 0, `本文件出现候选:${scan.hits.map((h) => `L${h.line} ${h.constName}`).join('; ')}`);
  ok(scan.anchors.length >= 14, `锚点应≥14 条,实际 ${scan.anchors.length}`);
});

report('WS-FND-76');