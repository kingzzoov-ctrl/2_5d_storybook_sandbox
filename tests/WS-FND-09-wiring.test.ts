/**
 * WS-FND-09 —— **生产装配路径**断言(task-57)。
 *
 * ## 这个套件为什么存在
 *
 * 本仓已记过 8 次「测试全绿 + 生产零消费」。第 9 例是:
 *
 * ```
 * RoomRuntime 有契约字段 worldSaveHost(见 net/room.ts 的 WorldSaveHost)
 * 实测 server/src/** 里赋值 **0 处**
 * 全部 6 处赋值在 scripts/_us2_*.ts (5) + tests/WS-FND-02.test.ts (1)
 * ⇒ 运行期恒为 null ⇒ room.ts 里 `if (this.worldSaveHost)` 整段不进
 * ⇒ 「世界状态低频落盘」与「等级投影」运行期从不发生
 * ```
 *
 * ## 它和既有套件的**形态差别**(这是本文件唯一的价值)
 *
 * `tests/WS-FND-02.test.ts` 用 `rt.worldSaveHost = sim`(**手动装配**)验证
 * 「这个类装上 host 后能工作」。命题是:
 *
 *     「仓库里的 WorldSaveHost 能不能工作」        ← 已被覆盖 182 条
 *
 * 本套件的命题是不同的另一句:
 *
 *     「生产里它**被装上了**没有」                  ← 此前**零覆盖**
 *
 * ⇒ 所以本文件里**不允许出现** `rt.worldSaveHost = ...` 这种赋值。
 *   一切运行时都必须由 `server/src/index.ts` 的 `assemble()` 产出 ——
 *   即**生产用的那个函数**。若有一天 `assemble()` 不再装 host,
 *   下面的断言会红;而手动装配的测试**永远不会红**。
 *
 * ## 负对照的设计(踩过一次坑,记下来)
 *
 * 我第一版想「装配好后把 `rt.worldSaveHost = null`,断言等级回落」——
 * **实测不成立**:`syncLevelProjections` 在 host 为 null 时是**早退**,
 * 已写入的投影不会回滚(投影是**粘性**的)。真正的负对照必须是
 * **从未装配过**的运行时(即 `new RoomRuntime(rtOpts)` 不带 host)——
 * 那恰好就是第 9 例在生产里的真实状态。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble, createHost, createServer } from '../server/src/index.ts';
import { RoomRuntime, type WorldSaveHost } from '../server/src/net/room.ts';
import { AccessMode } from '../server/src/db/repo.ts';
import { isEntryLoadExempt, entryLoadExemptCount } from '../scripts/entry_load_exempt.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 固定时钟 —— 消除时间不确定性(与 WS-07 同一做法)。 */
const fixedClock = (t = 1_700_000_000_000): { nowMs: () => number } => ({ nowMs: () => t });

/** 把「权威等级」推到某级 —— 走 `WorldSim.progresses`(权威侧的输入)。 */
function setAuthoritativeLevel(host: WorldSaveHost, playerId: string, level: number): void {
  const sim = host as unknown as { progresses: Map<string, { level: number }> };
  sim.progresses.set(playerId, { level });
}

/* ═══════════════════ 1. 入口可加载、可装配(不依赖 colyseus) ═══════════════════ */

test('FND9-1 生产入口可加载,并导出 assemble / createHost / createServer', () => {
  /* 为什么先测这个:`server/src/net/room.colyseus.ts` 被 `verify.ts` 列为
     PROD_ENTRIES 之一,却**无法被 Node 加载**(命名导入自 CJS + 依赖含 44 处
     @type 装饰器)。这一点此前没有任何检查 —— 见报告「入口可加载性」一节。
     ⇒ 本入口刻意只装到 RoomRuntime 层,不含 colyseus,故必须能加载。 */
  ok(typeof assemble === 'function', 'assemble 应为函数');
  ok(typeof createHost === 'function', 'createHost 应为函数');
  ok(typeof createServer === 'function', 'createServer 应为函数');
});

test('FND9-2 入口源码不含装饰器 / enum / 构造参数属性(可擦除铁律)', () => {
  /* 顺手把本仓铁律钉在这份新文件上 —— 新入口最容易第一个违规:
     它要引用 colyseus 相关概念,而 colyseus 的正确用法恰恰是装饰器。 */
  const src = readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  ok(!/^\s*@[A-Za-z_]/m.test(code), 'index.ts 不应含行首装饰器');
  ok(!/^\s*(export\s+)?enum\s+\w+/m.test(code), 'index.ts 不应含 enum');
  ok(!/^\s*namespace\s+\w+/m.test(code), 'index.ts 不应含 namespace');
  /* 相对 import 必须带 .ts */
  const badImports = [...code.matchAll(/from\s+['"](\.[^'"]*)['"]/g)]
    .map((m) => m[1] as string)
    .filter((s) => !s.endsWith('.ts'));
  eq(badImports.length, 0, `相对 import 必须带 .ts(违规:${badImports.join(', ') || '无'})`);
});

/* ═══════ 2. ★ 核心:装配产物上 host 真的非 null(生产路径,非手动赋值) ═══════ */

test('FND9-3 assemble() 产出的运行时上 worldSaveHost 非 null —— 本任务修复点', () => {
  const { host, rtOpts, runtime } = assemble({
    roomId: 'room_wiring', ownerId: 'o1', clock: fixedClock(), sizeCells: 32,
  });

  /* 这是全仓**唯一**验证「生产装配路径真的把 host 装上了」的断言。
     ⚠️ 注意:这里没有、也不允许有 `runtime.worldSaveHost = ...`。 */
  ok(runtime.worldSaveHost !== null, 'assemble() 后 runtime.worldSaveHost 必须非 null');
  ok(runtime.worldSaveHost === host, '运行时字段应与 assemble 产出的 host 是同一对象');
  ok(rtOpts.host === host, 'rtOpts.host 应被真正填上(而非省略)');

  /* 反面证据:契约字段的类型是 `WorldSaveHost | null`,所以「非 null」是**运行时**事实,
     不能靠类型系统保证 —— 这正是需要一个断言的原因。 */
  ok(runtime.worldSaveHost !== undefined, 'worldSaveHost 不应是 undefined');
});

test('FND9-4 host 上三个契约方法都在,且可调用', () => {
  const { host } = assemble({ roomId: 'r', ownerId: 'o', clock: fixedClock(), sizeCells: 32 });
  eq(typeof host.saveToDb, 'function', 'host.saveToDb 应为函数');
  eq(typeof host.attackMobAuthorized, 'function', 'host.attackMobAuthorized 应为函数');
  eq(typeof host.levelOf, 'function', 'host.levelOf 应为函数');

  /* 可调用性(不只是「存在」):levelOf 对未上场的玩家必须给 1,不能抛。 */
  eq(host.levelOf('never_joined'), 1, 'levelOf 对未知玩家应返回 1(不抛)');
});

/* ═══════ 3. ★ 端到端:等级投影真的改变容量(走生产装配路径) ═══════ */

test('FND9-5 等级投影经生产装配路径生效:level 30 ⇒ capacity 37', () => {
  const { host, runtime } = assemble({ roomId: 'r30', ownerId: 'o', clock: fixedClock(), sizeCells: 32 });
  runtime.join({ userId: 'p1', passwordHash: null, asGuest: true });

  /* 入场时是 Lv1 —— 先钉住起点,避免「一开始就 37」的假绿。 */
  eq(runtime.state.players[0]?.level, 1, '入场时投影应为 Lv1');
  eq(runtime.carryCapacityOf('p1'), 8, 'Lv1 容量应为 8(8 + (L-1))');

  setAuthoritativeLevel(host, 'p1', 30);
  runtime.step();

  eq(runtime.state.players[0]?.level, 30, 'step 后投影应更新为 30');
  eq(runtime.carryCapacityOf('p1'), 37, 'Lv30 容量应为 37(8 + 29)');
});

test('FND9-6 等级投影两侧扫描:封顶与下界都正确(不是只扫一个点)', () => {
  /* 本仓教训:某常量从 600 改成 2/10/…/599 时套件全绿,只有改到 601+ 才红。
     ⇒ 「封顶」必须扫**两侧**,否则「恰好落在某一侧」的实现也能通过。 */
  const cases: [number, number, number][] = [
    /* [权威等级, 期望投影等级, 期望容量] */
    [1, 1, 8],
    [10, 10, 17],
    [20, 20, 27],
    [30, 30, 37],
    [31, 30, 37],   /* 封顶:31 夹到 30 */
    [9999, 30, 37], /* 远上界:仍夹到 30 */
  ];
  for (const [input, expectLevel, expectCap] of cases) {
    const { host, runtime } = assemble({ roomId: `r${input}`, ownerId: 'o', clock: fixedClock(), sizeCells: 16 });
    runtime.join({ userId: 'p1', passwordHash: null, asGuest: true });
    setAuthoritativeLevel(host, 'p1', input);
    runtime.step();
    eq(runtime.state.players[0]?.level, expectLevel, `权威 level=${input} 应投影为 ${expectLevel}`);
    eq(runtime.carryCapacityOf('p1'), expectCap, `权威 level=${input} 应得容量 ${expectCap}`);
  }
});

/* ═══════════ 4. ★ 负对照:未装配的运行时就是第 9 例的真实状态 ═══════════ */

test('FND9-7 负对照:省略 host 的运行时等级恒为 1、容量恒为 8(即缺陷本来的样子)', () => {
  /* ⚠️ 这条**不用** assemble(),故意手动 new 一个不带 host 的 RoomRuntime ——
     那就是 `server/src/index.ts` 存在之前,生产里真实的运行状态。
     它与 FND9-3/5 构成**正负对照**:同一个 RoomRuntime 类,一份装了 host、一份没装,
     断言能分辨出两者 ⇒ 证明 FND9-3 不是恒真。
     ⚠️ 注意:这里**不是**「装配后再拔掉 host」——
        实测投影是**粘性**的,拔掉 host 不会回滚已写入的等级(见文件头注释)。 */
  const rt = new RoomRuntime({
    roomId: 'room_nohost',
    ownerId: 'o',
    clock: fixedClock(),
    accessMode: AccessMode.PUBLIC,
    /* host 刻意省略 —— 此前生产就是这个形状 */
  }, null);

  eq(rt.worldSaveHost, null, '未装 host 的运行时该字段应为 null(复现缺陷起点)');
  rt.join({ userId: 'p1', passwordHash: null, asGuest: true });
  for (let i = 0; i < 5; i += 1) rt.step();
  eq(rt.state.players[0]?.level, 1, '没有 host ⇒ 等级投影整段跳过 ⇒ 恒为 1');
  eq(rt.carryCapacityOf('p1'), 8, '没有 host ⇒ 容量恒为 8(与「未接线」完全一样)');
});

/* ═══════════ 5. 落盘路径也真的会执行(不只等级投影) ═══════════ */

test('FND9-8 有 host 时低频落盘真的发生;无 host 时整段跳过', () => {
  /* `saveToDb` 是**存量**缺口(比 levelOf 更早),同一根因。
     用 `lastSaveReport` 区分「执行了」与「跳过了」——
     这正是第 9 例里「没有东西会报错」的那一处。 */
  const withHost = assemble({ roomId: 'room_save', ownerId: 'o', clock: fixedClock(), sizeCells: 32 });
  withHost.runtime.join({ userId: 'p1', passwordHash: null, asGuest: true });
  /* 低频节流:20 帧一次(见 room.ts 的 saveToDb 注释)。 */
  for (let i = 0; i < 25; i += 1) withHost.runtime.step();
  ok(withHost.runtime.state.meta.tick >= 20, `应已推进 ≥20 帧(实测 ${withHost.runtime.state.meta.tick})`);

  const noHost = new RoomRuntime({
    roomId: 'room_nosave', ownerId: 'o', clock: fixedClock(), accessMode: AccessMode.PUBLIC,
  }, null);
  noHost.join({ userId: 'p1', passwordHash: null, asGuest: true });
  for (let i = 0; i < 25; i += 1) noHost.step();
  /* 无 host ⇒ 落盘整段跳过 ⇒ 报告恒 null。不谎报「存过了」。 */
  eq(noHost.lastSaveReport, null, '无 host 时 lastSaveReport 应恒为 null(不谎报)');
});

/* ═══════════ 6. rtOpts 与房间那一份字段对齐(防两份装配并存) ═══════════ */

test('FND9-9 assemble() 的 rtOpts 字段集必须覆盖房间 onCreate 的全部字段', () => {
  /* 为什么要这条:`room.colyseus.ts` 的 `onCreate` 里有一份**同形**的 rtOpts 字面量。
     两份若分叉,就是「两份装配并存」—— 那正是第 9 例的成因形态,不是解法。
     这里从**源码**抽出房间那份的字段名,与 assemble() 实际产出的键对比。 */
  const roomSrc = readFileSync(join(ROOT, 'server/src/net/room.colyseus.ts'), 'utf8');
  const m = /const rtOpts: RoomRuntimeOptions = \{([\s\S]*?)\n    \};/.exec(roomSrc);
  ok(m !== null, 'room.colyseus.ts 里应能找到 rtOpts 字面量(若已重构,请同步本断言)');
  const body = m?.[1] ?? '';
  /* ⚠️ 必须同时认两种写法:`k: v`(普通属性)**与** `k,`(-- 简写属性)。
     我第一版只写了 `^\s*(\w+):`,于是 `roomId,`(房间侧确实用的是简写)
     **被漏掉**,「房间侧共 8 个」是错的(实为 9 个)。
     ⇒ 一个过窄的测量工具会静默少收一个键,而 missing 判据仍然全绿。
     这与本任务里 `@type` 计数用 `/@type/g` 而多数了 5 是同一类错误:
     **提取口径比事实窄(或宽)时,判据不会自己报警。** */
  const roomFields = [
    ...[...body.matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1] as string),
    ...[...body.matchAll(/^\s*(\w+)\s*,\s*$/gm)].map((x) => x[1] as string),
  ].sort();
  ok(roomFields.length >= 9, `房间侧 rtOpts 应至少 9 个键(实测 ${roomFields.length}:${roomFields.join(', ')})`);

  const { rtOpts } = assemble({ roomId: 'r', ownerId: 'o', clock: fixedClock(), sizeCells: 16, maxPlayers: 8, worldSeed: 7 });
  const ourFields = Object.keys(rtOpts).sort();

  /* 房间那份的每个字段,assemble() 都必须产出(反之允许:房间可省略可选件)。 */
  const missing = roomFields.filter((f) => !ourFields.includes(f));
  eq(missing.length, 0, `assemble() 缺少房间侧字段:${missing.join(', ') || '无'}(房间侧共 ${roomFields.length} 个)`);
  /* 反向也查:我方不许多出房间侧没有的键 —— 多出的键说明两边在分叉。 */
  const extra = ourFields.filter((f) => !roomFields.includes(f));
  eq(extra.length, 0, `assemble() 多出房间侧没有的键:${extra.join(', ') || '无'}`);

  /* ★ 其中 `host` 必须在两边都出现 —— 它是本任务的主角。 */
  ok(roomFields.includes('host'), '房间侧 rtOpts 应含 host 字段(seam 唯一)');
  ok(ourFields.includes('host'), 'assemble() 产出的 rtOpts 应含 host 字段');
});

/* ═══════════ 7. createServer 只装配、不监听(CI 安全) ═══════════ */

test('FND9-10 createServer() 装配但不监听端口;产物内含已装好 host 的运行时', () => {
  const srv = createServer({ roomId: 'room_srv', ownerId: 'o', clock: fixedClock(), sizeCells: 32 });
  ok(srv.rooms.size >= 1, '应至少注册一个房间运行时');
  const rt = srv.rooms.get('room_srv');
  ok(rt !== undefined, '房间表应含 room_srv');
  ok(rt?.worldSaveHost !== null && rt?.worldSaveHost !== undefined, '房间表里的运行时其上 host 应已装配');
  ok(srv.summary.includes('非 null'), '装配摘要应报告 worldSaveHost 非 null');
  /* 只装配不监听:函数是同步的、立即返回,没有打开任何句柄。 */
  eq(typeof srv.summary, 'string', 'summary 应为字符串(同步产出 ⇒ 未异步监听)');
});

test('FND9-11 import 本入口必须**无副作用**(不打印、不装配、不监听)', () => {
  /* 为什么需要这条(由一次故障注入发现):
     我把文件末尾的 `if (invokedDirectly)` 改成 `if (true)`(即「无条件执行」),
     **没有任何断言变红** —— 说明「import 时不该有副作用」这件事此前无人守。
     而它会真实伤人:`scripts/verify.ts` 的「入口可加载性」检查会在**子进程**里
     import 每个 PROD_ENTRIES;若入口一被 import 就打印/起服务,CI 会被污染或挂住。
     ⇒ 用**子进程**观测 import 的 stdout:必须是空的。 */
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e',
      "const m = await import('./server/src/index.ts'); console.log('IMPORTED:' + Object.keys(m).length);"],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  );
  /* 只应看到我们自己的标记行 —— 不应出现装配摘要。 */
  ok(out.includes('IMPORTED:'), '子进程应成功 import 本入口');
  ok(!out.includes('装配完成'), `import 不应触发装配(实测 stdout:${JSON.stringify(out.slice(0, 160))})`);
  ok(!out.includes('不监听端口'), `import 不应打印摘要(仅直接执行时才打印)`);
});

/* ═══════════ 6. 入口可加载性豁免:登记而非掩盖(task-57 附带交付) ═══════════ */

test('FND9-12 本入口**不在**豁免表 —— 它是能加载的,不许靠豁免掩盖', () => {
  /* 这条与 FND9-1 形成对照:FND9-1 证「它能加载」,本条证「它**没有**被登记为豁免」。
     若有人为了绕开加载失败而把 `index.ts` 加进豁免表,本条会红 ——
     那是「用登记掩盖缺陷」,而豁免表的设计意图恰恰是**(只)**登记
     「结构上不可加载且写出路」的入口(浏览器入口 / 待 CR 裁决的装饰器矛盾)。 */
  ok(!isEntryLoadExempt('server/src/index.ts'),
    'server/src/index.ts 不应在 ENTRY_LOAD_EXEMPT 里(它是可加载入口)');
});

test('FND9-13 已知不可加载的入口已登记,且豁免数与 PROD_ENTRIES 交叉自洽', () => {
  /* 为什么要这条:豁免表若**越积越多**,就会退化成一份「假的绿色清单」——
     本仓对 `UNREACHABLE_EXEMPT` 有过同一教训(理由过时/条目失真)。
     ⇒ 这里钉住三件事:已知的两个真实不可加载入口在表内、本入口不在表内、条数固定。 */
  ok(isEntryLoadExempt('server/src/net/room.colyseus.ts'),
    'room.colyseus.ts 应已登记(44 处 @type 装饰器,Node strip-only 不可加载,待 CR 裁决)');
  ok(isEntryLoadExempt('client/src/main.ts'),
    'client/src/main.ts 应已登记(浏览器入口,依赖 document/window)');

  /* ⚠️ 条数会随 PROD_ENTRIES 增删而变 —— 改了 `PROD_ENTRIES` 就回来核这个数。
     把这条写在这里而不是散落各处,是为了让「表变宽」必须**显式**改一行断言。 */
  eq(entryLoadExemptCount(), 2,
    '豁免条数应为 2(改 PROD_ENTRIES 条数或增删豁免时,回来核这个数)');
});

test('FND9-14 豁免表是**单一事实来源**:verify.ts 必须 import 它,不得持副本', () => {
  /* 为什么要这条:本仓多次踩「两份实现并存」——同一份数据抄两处,
     改一处另一处不动,而两边看起来都「有检查」。
     ⇒ 判据:豁免理由的**特征串**只应存在于 `entry_load_exempt.ts`;
       且 `verify.ts` 必须 import 该模块(而不是自带一份 Map)。 */
  const gate = readFileSync(join(ROOT, 'scripts/verify.ts'), 'utf8');
  const exemptMod = readFileSync(join(ROOT, 'scripts/entry_load_exempt.ts'), 'utf8');

  /* 1) 特征串(取豁免理由里够独特的一句)只应出现在豁免模块里。 */
  const fingerprint = '44 处 @type 装饰器';
  ok(exemptMod.includes(fingerprint), '豁免模块应含登记理由');
  ok(!gate.includes(fingerprint),
    '`verify.ts` 不应**复制**豁免理由(副本 = 两份实现;它应 import 单一来源)');

  /* 2) 门禁必须真的 import 它 —— 否则「单一来源」只是名义上的。 */
  ok(/from\s+['"]\.\/entry_load_exempt\.ts['"]/.test(gate),
    'verify.ts 应 import ./entry_load_exempt.ts(而非自带副本)');

  /* 3) 反向:豁免模块**不得** import verify.ts ——
        否则测试 import 它时会连带把整个门禁跑一遍(嵌套执行 ⇒ 假绿/假红)。
     ⚠️ **必须剥注释后再判**。我第一版直接对原文跑正则,结果是**假红**:
        `entry_load_exempt.ts` 的文档注释里**引用**了一句反例
        `import { ENTRY_LOAD_EXEMPT } from '../scripts/verify.ts'`
        —— 那是在说明「为什么不能这么做」,不是真的 import。
        ⇒ 这与我把 `@type` 数成 49(把注释里**讨论**该词的行算成装饰器)
          是**同一形状**:对「文本出现」判真假,却不管它是不是**代码**。
        ⇒ 这里只剥注释、**保留字符串内容**(import 路径就在字符串里)。
     ⚠️⚠️ **`(^|[^:])` 前缀是刻意写的,不是冗余 —— 不要顺手删掉。**
        它防的是「行内两个斜杠并非注释开头」的情况,最典型的是 **URL**
        (下例的第一段是字符串内容,两个斜杠出现在 `http:` 之后,不该被当注释起点):

            const url = 'http://example.com/a';      // 真注释在这里

        若去掉这个前缀(即用裸的两个斜杠起头),则 URL 里的那两个斜杠会被当成注释起点,
        **从那里到行尾全部被删** ⇒ 行内 `const …='http:` 变成半截。
        对本判据的后果是:**字符串内容被截断 ⇒ 里面的 import 路径可能看不全**
        ⇒ 判据**静默失效但仍然绿**。⇒ 与本仓记过的「判据工具自己需要被验证」
        (陷阱 44 同族)正是同一件事,故此处显式留证。
        ⚠️ 本式**不**处理正则字面量或字符串里的转义斜杠 —— 本文件不需要;
           那类情况应交由本仓已有的 `stripCommentsAndStrings` 处理,不要在此扩展。
        ⚠️ 另注:本段注释里**故意不写出那段正则的完整字面量**,因为它以
           「星号紧跟斜杠」结尾,会**提前闭合本块注释** —— 我加这段说明时
           正好踩了它一次,实测报 `ERR_INVALID_TYPESCRIPT_SYNTAX`。 */
  const stripCommentsOnly = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /* 判据工具自检(两道):
     ① 必须真的**变短** —— 否则说明正则不匹配,后续判据会退化成「对原文跑正则 ⇒ 恒真」。
     ② 必须**保住字符串里的 URL/路径** —— 否则 ① 仍可能通过而语义已错。 */
  ok(stripCommentsOnly(exemptMod).length < exemptMod.length,
    '剥注释应使源码变短 —— 否则工具没生效(判据会退化成恒真)');
  eq(
    stripCommentsOnly("const u = 'http://x/a.ts';\n// 注释\n"),
    "const u = 'http://x/a.ts';\n\n",
    '剥注释必须保住字符串里的斜杠(防 URL 被截断 ⇒ 判据静默失效)',
  );
  eq(stripCommentsOnly('const p = 1; // 尾注释\n'), 'const p = 1; \n', '行尾注释应被剥掉');

  /* ⚠️ **必须同时覆盖四种 import 形态**。我第一版只写了
     `from\s*['"]…verify\.ts['"]` —— 于是**裸副作用导入** `import './verify.ts';`
     (没有 `from`)**完全不被抓到**。而它恰恰是最危险的形态:它正是我在故障注入里
     让本模块 import verify.ts 时**实际造成无限递归 fork(76 个 node 进程)**的那种写法。
     ⇒ 漏掉它 = 这条断言守不住它本来要守的那件事。由 J8 真值表发现。 */
  const importsVerify = (src: string): boolean => {
    const s = stripCommentsOnly(src);
    return (
      /* 1) import ... from '…/verify.ts' */
      /\bimport\b[^;]*\bfrom\s*['"][^'"]*verify\.ts['"]/.test(s)
      /* 2) 裸副作用导入 import '…/verify.ts' */
      || /\bimport\s*['"][^'"]*verify\.ts['"]/.test(s)
      /* 3) 再导出 export ... from '…/verify.ts' */
      || /\bexport\b[^;]*\bfrom\s*['"][^'"]*verify\.ts['"]/.test(s)
      /* 4) 动态 import('…/verify.ts') */
      || /\bimport\s*\(\s*['"][^'"]*verify\.ts['"]\s*\)/.test(s)
    );
  };

  /* 判据自检(J8 真值表):四条负例必须**都**被判为「有导入」。
     少了这个自检,上面那条 `ok(!importsVerify(...))` 可能是恒真。 */
  const MUST_FLAG: [string, string][] = [
    ['named from', "import { x } from '../scripts/verify.ts';"],
    ['裸副作用导入', "import './verify.ts';"],
    ['再导出', "export { x } from './verify.ts';"],
    ['动态 import', "const m = await import('./verify.ts');"],
  ];
  for (const [label, src] of MUST_FLAG) {
    ok(importsVerify(src), `判据应能抓到「${label}」形态的 verify.ts 导入`);
  }
  /* 正例:注释里的引用、无关文件、仅字符串提及 —— 都不应误报。 */
  ok(!importsVerify("/* 反例:import { X } from './verify.ts' */"), '注释里的引用不应误报');
  ok(!importsVerify("import { x } from './other.ts';"), '无关文件不应误报');
  ok(!importsVerify("const p = './verify.ts'; // 见 verify.ts"), '仅字符串提及不应误报');

  ok(!importsVerify(exemptMod),
    'entry_load_exempt.ts 不得以任何形态 import verify.ts(注释里的反例引用不算)');
});

report('WS-FND-09');