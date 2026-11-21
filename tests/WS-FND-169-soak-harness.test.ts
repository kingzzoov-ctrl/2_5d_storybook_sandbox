/**
 * WS-FND-169 · **真长跑夹具**(`scripts/soak.ts`)自身的判据。
 *
 * ## 这一套判据在守什么
 * ```text
 * 前十三轮的「长跑」全是虚拟时钟快进:时钟是注入的 nowMs(),定时器一次都不触发。
 * ⇒ 它们能证明逻辑对不对,但证明不了「真墙钟 / 真文件 I/O / 真 GC / 真协议」下的行为。
 * 本套件要守的是:**夹具本身有牙** —— 短跑也必须真的产生数据,采样也必须可断言。
 * ```
 *
 * ## 判据(11 条)
 * ```text
 * FND169-1  量纲锚:默认 60 分钟 / 8 客户端 / 5s 采样 / 50ms 帧 / 96 格;参数非法一律抛
 * FND169-2  采样行结构:`[soak] {json}` 可读回,每个被跟踪序列都能解析成**有限数**
 * FND169-3  快跑真能跑通:短跑产出**恰好** ceil(时长/间隔)+1 条样本,日志**追加**且逐行可读回
 * FND169-4  内存 / 库增长**读得出来**:RSS/heap 非零、库字节增长、users/room_players 有行
 * FND169-5  ★ 客户端动作**真的改了世界**:move/action/attack 三条上行都到过服务端且被执行,
 *           玩家坐标相对出生点发生了位移,**地形**被真的写过(`terrainWrites > 0`)
 * FND169-6  ★★ 负对照:0 客户端 ⇒ `NO_LOAD`(而不是假装有负载);同一个判据在 2 客户端上必须 `LOAD`
 * FND169-7  ★ 单调增长的集合可判:世界帧号/上行计数/采样条数**单调涨**,内存类在下降集合里;
 *           判据的负对照 = 手写样本里那条序列降一格 ⇒ 必须从「单调涨」里掉出去
 * FND169-8  帧率是**实际间隔**(不是标称):均值/最大/最少帧数在量级内,且 `fps ≈ 1000/均值`
 * FND169-9  自动存档:成功次数 ≥ 2(冷启动帧轨 + 销毁),失败 0,错因台账为空
 * FND169-10 台账可读且入场是真的:入场审计 = 客户端数;反作弊证据在「小步走法」下为 0
 * FND169-11 汇总与序列对账:首末/峰值与序列**同一份事实**,不各算一遍
 * ```
 *
 * ## 反例的纪律
 * ```text
 * 1 期望值写字面量(60 / 8 / 5000 / 50 / 96 / 2),不拿被测常量当期望值;
 * 2 每条「成立」的断言都配一条负对照:NO_LOAD 用 0 客户端、单调判据用降一格的样本、
 *   采样行解析用一行非采样行(必须抛);
 * 3 不碰真仓库:库与日志都落在 tmpdir,跑完即删。
 * ```
 *
 * 运行:`node tests/WS-FND-169-soak-harness.test.ts`
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TICK_MS } from '../shared/types/physics.ts';
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import {
  DEFAULT_SOAK_OPTIONS,
  SAMPLE_PREFIX,
  SOAK_SERIES,
  SUMMARY_PREFIX,
  decreasedSeries,
  defaultLogPath,
  expectedSampleCount,
  formatSampleLine,
  monotonicGrowers,
  parseSampleLine,
  parseSoakArgs,
  runSoak,
  seriesReports,
  seriesValue,
  summarizeSoak,
  type SoakOptions,
  type SoakSample,
} from '../scripts/soak.ts';

const DIR = join(tmpdir(), `ws-fnd-169-${process.pid}`);
const SHORT_DB = join(DIR, 'short.db');
const SHORT_LOG = join(DIR, 'short.log');
const NEG_DB = join(DIR, 'neg.db');
const NEG_LOG = join(DIR, 'neg.log');

/** 短跑 = 2 秒(`--minutes` 的小数形态就是给测试用的)。 */
const SHORT_MINUTES = 2 / 60;
const SHORT_SAMPLE_MS = 500;
/** 预期样本条数(字面量:2000ms / 500ms = 4)。 */
const SHORT_STEPS = 4;
/** 负对照 = 1 秒。 */
const NEG_MINUTES = 1 / 60;
const NEG_STEPS = 2;

/** 夹具的共用装配参数(小世界 + 少帧预热 ⇒ 测试快,但走的仍是生产装配)。 */
const BASE: Partial<SoakOptions> = {
  sampleEveryMs: SHORT_SAMPLE_MS,
  frameMs: 50,
  actionHz: 4,
  moveHz: 5,
  sizeCells: 48,
  warmupFrames: 120,
  quiet: true,
};

/** 负对照的日志先写一行"土标记":跑完必须还在(证明日志是**追加**,不是覆盖)。 */
const PRE_EXISTING = '# PRE-EXISTING-MARKER-DO-NOT-TRUNCATE';
mkdirSync(DIR, { recursive: true });
writeFileSync(NEG_LOG, `${PRE_EXISTING}\n`, 'utf8');

/* ═════════════════ 真跑两次(短跑 + 负对照)═════════════════
   ⚠️ `harness.test()` 只接同步函数 ⇒ 异步装配在模块层用 top-level await 做完,
   每条 `test()` 只对该读数做同步断言(与 `WS-FND-160` 的写法同源)。 */
const shortRun = await runSoak({
  ...BASE,
  minutes: SHORT_MINUTES,
  clients: 2,
  dbPath: SHORT_DB,
  logPath: SHORT_LOG,
  fresh: true,
});
const negRun = await runSoak({
  ...BASE,
  minutes: NEG_MINUTES,
  clients: 0,
  dbPath: NEG_DB,
  logPath: NEG_LOG,
  fresh: false,
});

const shortFirst = shortRun.samples[0] as SoakSample;
const shortLast = shortRun.samples[shortRun.samples.length - 1] as SoakSample;
const negFirst = negRun.samples[0] as SoakSample;
const negLast = negRun.samples[negRun.samples.length - 1] as SoakSample;

/* ═══════════════════════════ 1. 量纲锚 ═══════════════════════════ */

test('FND169-1 量纲锚:默认 60 分钟 / 8 客户端 / 5s 采样 / 50ms 帧 / 96 格;非法参数一律抛', () => {
  /* 期望侧写字面量 ⇒ 有人改默认值,这条**会红**。 */
  eq(DEFAULT_SOAK_OPTIONS.minutes, 60, '默认跑 60 分钟');
  eq(DEFAULT_SOAK_OPTIONS.clients, 8, '默认 8 个并发假客户端');
  eq(DEFAULT_SOAK_OPTIONS.sampleEveryMs, 5_000, '默认 5 秒采一条');
  /* 默认帧长必须 = **标称帧间隔**(冻结层 `TICK_MS`,由 `TICK_HZ` 派生)——
     旧写法写死 50,把 20Hz 抄进了这里。 */
  eq(DEFAULT_SOAK_OPTIONS.frameMs, TICK_MS, `默认帧长 = TICK_MS = ${TICK_MS}ms`);
  eq(DEFAULT_SOAK_OPTIONS.sizeCells, 96, '默认世界 96 格(与 scripts/play.ts 同值)');
  eq(DEFAULT_SOAK_OPTIONS.dbPath, '.data/soak.db', '默认落文件库(不是内存)');

  eq(expectedSampleCount(3_600_000, 5_000), 720, '60 分钟 / 5s = 720 条跑动期样本');
  eq(SHORT_STEPS, expectedSampleCount(SHORT_MINUTES * 60_000, SHORT_SAMPLE_MS),
    '2 秒 / 500ms = 4 条(与下面的字面量一致)');
  eq(defaultLogPath(60), '.data/soak-60m.log', '日志名带分钟数(便于对账)');

  /* 解析:给了就换成给的;没给就是默认。 */
  const parsed = parseSoakArgs(['--minutes', '60', '--clients', '8', '--sample-every', '5']);
  eq(parsed.minutes, 60, '--minutes 生效');
  eq(parsed.clients, 8, '--clients 生效');
  eq(parsed.sampleEveryMs, 5_000, '--sample-every 是**秒**,存成 ms');
  eq(parsed.logPath, '.data/soak-60m.log', '未给 --log ⇒ 按分钟数派生');
  eq(parseSoakArgs(['--minutes', '1', '--clients', '0']).clients, 0, '0 客户端是**合法**值(负对照组要用)');

  /* ★ 负对照:非法值必须**抛**,不许静默退回默认值。 */
  for (const bad of [
    ['--minutes', '0'], ['--minutes', '-5'], ['--minutes', 'abc'],
    ['--clients', '-1'], ['--clients', '1.5'],
    ['--sample-every', '0'], ['--frame-ms', '0'], ['--size', '16'],
  ]) {
    let threw = false;
    try { parseSoakArgs(bad); } catch { threw = true; }
    ok(threw, `非法参数应当抛:${bad.join(' ')}`);
  }
});

/* ═══════════════════════════ 2. 采样行结构 ═══════════════════════════ */

test('FND169-2 采样行结构:`[soak] {json}` 可读回,每个跟踪序列都能解析成有限数', () => {
  const line = formatSampleLine(shortFirst);
  ok(line.startsWith(`${SAMPLE_PREFIX} `), `采样行必须带前缀 ${SAMPLE_PREFIX}`);
  const back = parseSampleLine(line);
  eq(back, shortFirst, '序列化/读回是同一个对象(结构化相等)');
  ok(line.includes('"rssBytes"') && line.includes('"autosave"') && line.includes('"tick"'),
    '一行里同时有内存 / 存档 / 帧率三段(不用去猜字段在哪)');

  /* 每条序列都必须**真的存在**且是数:拼错一个键 ⇒ 这里当场红。 */
  for (const key of SOAK_SERIES) {
    const v = seriesValue(shortFirst, key);
    ok(Number.isFinite(v), `序列 ${key} 取不到有限数(实际 ${String(v)})`);
    ok(v >= 0, `序列 ${key} 不该是负数(实际 ${v})`);
  }
  ok(SOAK_SERIES.length >= 30, `被跟踪的序列足够多(实际 ${SOAK_SERIES.length})`);
  ok(SOAK_SERIES.includes('rssBytes') && SOAK_SERIES.includes('heapUsedBytes'),
    '内存两条在跟踪表里(RSS 单调涨是长跑要抓的头号形态)');

  /* ★ 负对照:非采样行必须抛(否则「能解析」这件事没有边界)。 */
  let threw = false;
  try { parseSampleLine('  [play] 装配世界...'); } catch { threw = true; }
  ok(threw, '负对照:不是采样行 ⇒ 必须抛');

  /* 结构:关键字段的类型与量级。 */
  ok(shortFirst.seq >= 1 && shortLast.phase === 'final', '首条 seq ≥ 1,末条是 final 阶段');
  ok(shortLast.atMs >= 0 && shortLast.atMs <= 60_000, `atMs 在跑动窗口内(实际 ${shortLast.atMs})`);
  ok(shortLast.db.totalBytes >= shortLast.db.mainBytes, '库字节总量 ≥ 主文件字节(含 WAL 侧)');
  /* ★ WS-FND-178:台账加了一项 `acDroppedViolations`(环形流水**丢弃**条数 ——
     `acViolations` 会饱和到 512,饱和与「一直在违规」在日志里长得一样)。
     计数跟着 +1:这条断言守的是「一项不少」,不是「恰好八项」。 */
  eq(Object.keys(shortLast.ledgers).length, 9, '台账 9 项一个不少(WS-FND-178 起含丢弃计数)');
  eq(Object.keys(shortLast.autosave).length, 6, '自动存档 6 项一个不少');
  eq(Object.keys(shortLast.tick).length, 6, '帧率 6 项一个不少');
});

/* ═══════════════════════════ 3. 快跑真能跑通 ═══════════════════════════ */

test('FND169-3 短跑跑通:样本条数 = ceil(时长/间隔)+1,日志**追加**且逐行可读回', () => {
  eq(shortRun.samples.length, SHORT_STEPS + 2,
    `2 秒 / 500ms ⇒ ${SHORT_STEPS} 条跑动样本 + 1 条基线 + 1 条末样本`);
  eq(shortRun.lines.length, SHORT_STEPS + 2, '日志写的是「基线 + 跑动样本」,不含汇总行');

  const logLines = readFileSync(SHORT_LOG, 'utf8').split('\n').filter((l) => l !== '');
  eq(logLines.length, shortRun.lines.length + 1, '磁盘上的行数 = 写出的行数 + 1 条汇总');
  ok((logLines[0] as string).startsWith('# soak start'), '第一行是运行头(房间/客户端/间隔都在)');
  ok((logLines[logLines.length - 1] as string).startsWith(`${SUMMARY_PREFIX} `),
    '最后一行是汇总(JSON,可被脚本消费)');
  let parsed = 0;
  for (const l of logLines.slice(1, logLines.length - 1)) {
    const s = parseSampleLine(l);
    ok(Number.isFinite(s.rssBytes) && s.rssBytes > 0, '逐行都能读回,且 RSS 是正数');
    parsed += 1;
  }
  eq(parsed, shortRun.lines.length - 1, '头一行之后、汇总之前全是采样行');

  /* ★ 负对照:负对照组的日志里,**先前写的那一行必须还在**(追加,不是覆盖)。 */
  const negLines = readFileSync(NEG_LOG, 'utf8').split('\n').filter((l) => l !== '');
  eq(negLines[0], PRE_EXISTING, '负对照组:老日志行原样保留 ⇒ 日志是追加写');
  eq(negLines.length, 1 + negRun.lines.length + 1, '负对照组的行数同样对得上');
  eq(negRun.samples.length, NEG_STEPS + 2, `1 秒 / 500ms ⇒ ${NEG_STEPS} 条 + 基线 + 末样本`);
});

/* ═══════════════════════════ 4. 内存 / 库增长 ═══════════════════════════ */

test('FND169-4 内存与库增长**读得出来**:RSS/heap 非零、库字节增长、users/room_players 有行', () => {
  ok(shortFirst.rssBytes > 10 * 1048576,
    `RSS 是真实进程读数(>10MiB,实际 ${(shortFirst.rssBytes / 1048576).toFixed(1)}MiB)`);
  ok(shortFirst.heapUsedBytes > 1048576 && shortFirst.heapUsedBytes < shortFirst.heapTotalBytes,
    'heapUsed < heapTotal(量纲没写反)');
  ok(shortLast.rssBytes > 0 && shortLast.heapUsedBytes > 0, '末样本内存读数仍在');

  ok(shortLast.db.totalBytes > shortFirst.db.totalBytes,
    `库字节在长(${shortFirst.db.totalBytes} → ${shortLast.db.totalBytes})`);
  ok(shortLast.db.totalBytes > 100_000, '库文件不是空壳(>100KB)');

  /* users = 房主 1 + 假客户端 2;room_players = 真入场的 2 人。 */
  eq(shortLast.tables['users'], 3, 'users 行 = 房主 + 2 个客户端');
  eq(shortLast.tables['room_players'], 2, 'room_players 行 = 2(入场真的落了行)');
  eq(shortLast.tables['rooms'], 1, '只有本房间一行');

  /* `room_events` 读得到(值可能是 0 —— 那是事实,不是缺字段)。 */
  eq(typeof shortLast.events, 'number', 'room_events 行数是数字');
  eq(shortLast.events, shortLast.tables['room_events'], '顶层 events 与 tables 里同一份事实');
  eq(summaryEvents(shortRun.summary), shortLast.events, '汇总里的末值 = 末样本(不各算一遍)');
});

/** 汇总里 `events.last` 的读数(小工具:避免测试里到处写 `?.`)。 */
function summaryEvents(s: { events: { last: number } }): number {
  return s.events.last;
}

/* ═══════════════════════════ 5. 客户端动作真的改了世界 ═══════════════════════════ */

test('FND169-5 ★ 客户端动作真的改了世界:三条上行都到达并被应用,玩家坐标发生位移', () => {
  const load = shortLast.load;
  ok(load.clients === 2 && load.connected === 2, `2 个假客户端都完成了握手(实际 ${load.connected})`);
  ok(load.framesReceived > 0, `客户端收到了下行帧(实际 ${load.framesReceived} 条)`);

  ok(load.sends.move > 0, `客户端**真发**了移动(实际 ${load.sends.move})`);
  ok(load.sends.action > 0, `客户端**真发**了动作(实际 ${load.sends.action})`);
  ok(load.movesApplied > 0, `服务端**真应用**了移动(实际 ${load.movesApplied})`);
  ok(load.actionsApplied > 0, `动作到达了房间执行层(实际 ${load.actionsApplied})`);
  ok(load.actionOk >= 1, `至少一条动作真的成功(实际 OK ${load.actionOk} 条:${JSON.stringify(shortRun.summary.actionKinds)})`);
  /* ★ WS-FND-173 修正:修前这里断的是 `load.worldWrites > 0` —— 而那颗计数器
     数的是「物质层五方法被调了几次」,**地面掉落**就能满足它(实测 2 秒短跑里
     `worldWrites=4` 全部来自地面掉落与被拒的拆块,`room_chunks` 一行都没有)。
     ⇒ 改成地形写(`placeBlock` / `breakBlock` 成功),它才真的对应「地形被改」。 */
  ok(load.terrainWrites > 0,
    `地形被真的写过(实际 ${load.terrainWrites} 次;地面写 ${load.groundWrites}、被拒 ${load.rejectedWrites})`);

  /* ★★ 世界**真的变了**:坐标相对出生点挪开了(不是「调了方法就算数」)。 */
  ok(load.displacement > 0.5,
    `玩家相对出生点位移 ${load.displacement} 格(>0.5)⇒ 移动落到了世界坐标上`);
  ok(shortLast.tick.worldTick > shortFirst.tick.worldTick,
    `世界帧号在推进(${shortFirst.tick.worldTick} → ${shortLast.tick.worldTick})`);
  eq(load.movesWorldRejected, 0, '小步走法不触发世界侧拒收(零噪音)');
});

/* ═══════════════════════════ 6. 负对照:0 客户端 ═══════════════════════════ */

test('FND169-6 ★★ 负对照:0 客户端 ⇒ 报告 NO_LOAD(不假装有负载);2 客户端 ⇒ LOAD', () => {
  eq(negRun.summary.verdict, 'NO_LOAD', '★★ 0 客户端的长跑必须判 NO_LOAD');
  eq(negLast.verdict, 'NO_LOAD', '末样本同样是 NO_LOAD');
  eq(negLast.load.clients, 0, '客户端数 0');
  eq(negLast.load.connected, 0, '没有连接');
  eq(negLast.load.sends.move + negLast.load.sends.action + negLast.load.sends.attack, 0,
    '一条上行都没发');
  eq(negLast.load.movesApplied + negLast.load.actionsApplied + negLast.load.attacksApplied, 0,
    '一条动作都没被执行');
  eq(negLast.load.terrainWrites, 0, '地形零写入(没有人去改地形)');
  eq(negLast.load.groundWrites, 0, '地面账零写入');
  eq(negLast.load.rejectedWrites, 0, '连被拒的地形写都没有');
  eq(negLast.load.displacement, 0, '零位移');

  /* 世界**仍在跑**:「无负载」不等于「没在跑」。 */
  ok(negLast.tick.worldTick > negFirst.tick.worldTick,
    `无负载时世界照旧推进(${negFirst.tick.worldTick} → ${negLast.tick.worldTick})`);
  ok(negLast.tick.observed > 0, '帧间隔样本仍在采(观测没停)');

  /* ★★ 判据的牙:同一个判据在 2 客户端的短跑上必须**转假**。 */
  eq(shortRun.summary.verdict, 'LOAD', '★★ 负对照的反面:2 客户端 ⇒ LOAD(不是恒判 NO_LOAD)');
  ok(shortLast.load.sends.move > 0, '2 客户端那一跑里上行确实存在');
});

/* ═══════════════════════════ 7. 单调增长的集合 ═══════════════════════════ */

test('FND169-7 ★ 单调增长集合可判:世界帧号/上行计数单调涨,内存类不被误判为单调涨', () => {
  const growers = monotonicGrowers(shortRun.samples);
  for (const key of ['tick.worldTick', 'tick.observed', 'load.sends.move', 'load.movesApplied']) {
    ok(growers.includes(key), `${key} 应当被判为单调增长(实际:${growers.join(', ')})`);
  }
  ok(growers.includes('db.totalBytes'), '库字节单调涨(自动存档真的在写盘)');
  /* ⚠️ 位移在这次短跑里**是**单调涨的(玩家斜着走向墙角,2 秒撞不到墙)⇒ 那一条不能
     当作「非单调」的例子;非单调的牙口放在下面的**合成样本**上(降一格 / 持平)。 */

  /* ★★ 负对照:把一条序列**降一格**的合成样本 ⇒ 它必须从「单调涨」里掉出去,
     而 `decreasedSeries` 必须点出它。手写样本来自真实样本的拷贝。 */
  const tampered: SoakSample[] = [
    { ...shortFirst, load: { ...shortFirst.load, movesApplied: 10, displacement: 5 } },
    { ...shortFirst, load: { ...shortFirst.load, movesApplied: 9, displacement: 5 } },
    { ...shortFirst, load: { ...shortFirst.load, movesApplied: 12, displacement: 5 } },
  ];
  const tamperedGrowers = monotonicGrowers(tampered);
  ok(!tamperedGrowers.includes('load.movesApplied'),
    '★ 负对照(降一格)⇒ 该序列从单调涨里掉出去');
  ok(decreasedSeries(tampered).includes('load.movesApplied'),
    '★ 负对照(降一格)⇒ 它出现在「中途下降」集合里');
  ok(tamperedGrowers.includes('load.displacement') === false,
    '★ 合成样本里位移是平的(不涨)⇒ 也不算单调增长(判据要求末值 > 首值)');

  /* 内存类:这次真跑里 RSS/heapUsed 中途降过(真 GC)⇒ 不许出现在单调集合里。
     ⚠️ 这一条依赖真跑,所以写成「若它在下降集合里,就更不在增长集合里」的**互斥**判据,
     再单独硬断言一次互斥关系本身(它恒真且能抓住「两个集合都收了同一个键」的 bug)。 */
  const decreased = decreasedSeries(shortRun.samples);
  for (const key of decreased) {
    ok(!growers.includes(key), `${key} 不能同时在「增长」与「下降」两个集合里`);
  }
  const reports = seriesReports(shortRun.samples);
  eq(reports.length, SOAK_SERIES.length, '一条序列一份报告,不多不少');
  for (const r of reports) {
    if (r.monotonic && r.grew) ok(growers.includes(r.key), `${r.key}: 单调且增长 ⇒ 必须在增长集合里`);
  }
});

/* ═══════════════════════════ 8. 帧率 ═══════════════════════════ */

test('FND169-8 帧率是**实际间隔**:均值/最大/帧数在量级内,且 fps ≈ 1000/均值', () => {
  const t = shortRun.summary.tick;
  ok(t.observed >= 20, `2 秒 20Hz ⇒ 至少 20 个帧间隔(实际 ${t.observed})`);
  ok(t.meanMs >= 25, `均值 ≥ 标称的一半(50ms 帧 ⇒ ≥25ms;实际 ${t.meanMs}ms)`);
  ok(t.meanMs <= 400, `均值不该离谱(实际 ${t.meanMs}ms —— 真定时器抖动会体现在这里)`);
  ok(t.maxMs >= t.meanMs, `最大 ≥ 均值(实际 max ${t.maxMs} / mean ${t.meanMs})`);
  ok(t.maxMs <= 2_000, `单帧不超过 2 秒(实际 ${t.maxMs}ms)`);
  ok(Math.abs(t.fps - 1000 / t.meanMs) < 0.05,
    `fps 由均值算出,不另算一遍(fps=${t.fps} vs 1000/${t.meanMs})`);

  /* ★ 牙口:把「标称间隔」当成实际读数 ⇒ 判据必须转假。
     实测的帧间隔是**墙钟**:观测到的间隔数 × 均值应当覆盖住整个跑动窗口
     (虚拟时钟跑出来的间隔与墙钟窗口无关 ⇒ 这个比值会失配)。 */
  const wallWindowMs = Math.max(1, shortLast.atMs);
  const coveredMs = t.observed * t.meanMs;
  const ratio = coveredMs / wallWindowMs;
  ok(ratio > 0.75 && ratio < 1.5,
    `观测间隔覆盖墙钟窗口:${coveredMs.toFixed(0)}ms / ${wallWindowMs}ms = ${ratio.toFixed(2)}`);
});

/* ═══════════════════════════ 9. 自动存档 ═══════════════════════════ */

test('FND169-9 自动存档:成功 ≥ 2(冷启动帧轨 + 销毁),失败 0,错因台账为空', () => {
  eq(shortLast.autosave.failCount, 0, '一次都没失败');
  eq(shortLast.ledgers.saveErrors, 0, '失败台账为空(与 failCount 同一份事实)');
  ok(shortLast.autosave.count >= 2,
    `至少 2 次真实落盘(冷启动帧轨 + 销毁);实际 ${shortLast.autosave.count} 次`);
  eq(shortLast.autosave.lastReason, 'dispose', '末样本的最近一次是销毁路径(收尾真的存了)');
  eq(shortLast.autosave.lastError, null, '没有错因');
  eq(shortLast.autosave.inFlight, false, '收尾时没有在途写入');
  eq(negRun.summary.autosave.failCount, 0, '负对照也没有存档失败');
});

/* ═══════════════════════════ 10. 台账 ═══════════════════════════ */

test('FND169-10 台账可读且入场是真的:入场审计 = 客户端数;小步走法不产生反作弊证据', () => {
  for (const [k, v] of Object.entries(shortLast.ledgers)) {
    ok(typeof v === 'number' && v >= 0, `台账 ${k} 是可读的非负数(实际 ${String(v)})`);
  }
  eq(shortLast.ledgers.joinAudits, 2, `入场审计 2 条(= 客户端数);实际 ${shortLast.ledgers.joinAudits}`);
  eq(shortLast.ledgers.acViolations, 0, '小步走法不产生反作弊证据(长跑里不该长出假阳性)');
  eq(shortLast.ledgers.removalConflicts, 0, '没有「重进撞车」');
  ok(shortLast.ledgers.removeLog >= 0, '移除流水可读');
});

/* ═══════════════════════════ 11. 汇总对账 ═══════════════════════════ */

test('FND169-11 汇总与序列对账:首末/峰值与序列同一份事实', () => {
  const s = shortRun.summary;
  eq(s.samples, shortRun.samples.length, '汇总的样本数 = 实际样本数');
  eq(s.clients, 2, '汇总记的是这次的客户端数');
  eq(s.rss.first, shortFirst.rssBytes, 'RSS 首值 = 首样本');
  eq(s.rss.last, shortLast.rssBytes, 'RSS 末值 = 末样本');
  ok(s.rss.peak >= s.rss.last && s.rss.peak >= s.rss.first, '峰值 ≥ 首末两端');
  eq(s.disk.last, shortLast.db.totalBytes, '库字节末值 = 末样本');
  eq(s.events.last, shortLast.events, '事件末值 = 末样本');
  eq(s.load.movesApplied, shortLast.load.movesApplied, '负载末值 = 末样本');
  ok(s.monotonicGrowers.length > 0, `单调增长集合非空(${s.monotonicGrowers.join(', ')})`);
  eq(s.monotonicGrowers, monotonicGrowers(shortRun.samples), '汇总里的集合 = 重新算一遍的结果');
  eq(s.wsLogLines >= 0, true, 'ws 日志行数可读');
  eq(summarizeSoak({
    options: shortRun.options,
    samples: shortRun.samples,
    counters: { ...emptyCounters(), actionKinds: {} },
    wsLogLines: 0,
    durationMs: 1,
  }).samples, shortRun.samples.length, '同一批样本再汇总一次,样本数不变(纯函数)');
});

/** 空计数(只为 `summarizeSoak` 的形参;**不**参与任何负载断言)。 */
function emptyCounters(): {
  movesApplied: number; movesWorldRejected: number; actionsApplied: number; actionOk: number;
  actionKinds: Record<string, number>; attacksApplied: number;
  terrainWrites: number; groundWrites: number; rejectedWrites: number;
  framesReceived: number;
} {
  return {
    movesApplied: 0, movesWorldRejected: 0, actionsApplied: 0, actionOk: 0,
    actionKinds: {}, attacksApplied: 0,
    terrainWrites: 0, groundWrites: 0, rejectedWrites: 0, framesReceived: 0,
  };
}

/* 清理:库与日志都在 tmpdir,跑完即删(WAL/SHM 一并删)。 */
for (const p of [SHORT_DB, SHORT_LOG, NEG_DB, NEG_LOG,
  `${SHORT_DB}-wal`, `${SHORT_DB}-shm`, `${NEG_DB}-wal`, `${NEG_DB}-shm`]) {
  try { rmSync(p, { force: true }); } catch { /* 句柄未放时不强求 */ }
}

report('WS-FND-169');