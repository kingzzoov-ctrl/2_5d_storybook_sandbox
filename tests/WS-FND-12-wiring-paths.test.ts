/**
 * WS-FND-12 —— **两套装配路径的口径分叉**(task-76)。
 *
 * ## 本套件为什么存在
 *
 * 本仓把「世界装进房间」的代码写了**两遍**:
 *
 * ```
 * A 路  server/src/index.ts 的 assemble()
 *         rtOpts.host = host                      ← ★ 真接上
 * B 路  server/src/net/room.colyseus.ts 的 onCreate()
 *         rtOpts.host = this.deps?.host ?? null
 *         而 deps 只由 room.withDeps(deps) 注入,全仓调用点 0 处
 *         ⇒ B 路 host **恒为 null**
 * ```
 *
 * 而仓里曾有一句话把它写成**一句**:
 * > 「生产装配路径**已存在**,host **不再是恒 null**」(`scripts/verify.ts` 旧文本)
 *
 * 那句话**只对 A 路成立**。本套件把「分口径」这件事变成断言,
 * 使「将来任何人想把它简化成一句」时**立刻红**。
 *
 * ## 本套件的取证手段(2026-11-14 task-95 后已更新)
 *
 * 本套件原先**不能** import B 路 —— `room.colyseus.ts` 当时无法被 Node 加载:
 * ```
 * 它传递依赖 ./net/schema.colyseus.ts,后者含 44 处 @type 装饰器
 * ⇒ Node strip-only 无法擦除装饰器 ⇒ SyntaxError: Invalid or unexpected token
 * ⇒ 该「不可加载」还会经 import 边传染给 index.ts 的闭包
 * ```
 * ✅ task-95 已把这条阻塞修掉(装饰器 → `defineTypes`;CJS 命名导入 →
 *   默认导出解构 / `import type`),⇒ 现在**可以** import B 路,
 *   而「不可加载」那条断言按设计改向为「**必须可加载** + 4 条 handler 必须已注册」
 *   (见 FND12-8;它同时**实跑**一次 `onCreate()` 取证,不再只查字符串在不在)。
 * ⇒ 其余断言仍**读源码**:它们测的是「两条路的字段名 / rtOpts 键集是否分叉」——
 *   那不是 import 能测的(import 一个模块什么也不证明),
 *   文本判据在这里是**恰当**手段,不是退而求其次。
 *
 * ## 每条断言都附「它能怎么变红」
 *
 * 见各断言上方的注释 —— 这是本仓纪律(「一条不能变红的断言等于没写」)。
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from '../server/src/index.ts';
import { RoomRuntime, RoomRegistry } from '../server/src/net/room.ts';
import { NetPersistRoom } from '../server/src/net/room.colyseus.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const readSrc = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 固定时钟 —— 消除时间不确定性。 */
const fixedClock = (t = 1_700_000_000_000): { nowMs: () => number } => ({ nowMs: () => t });

/* ═══════════ 1. A 路:host 真的接上了(行为判据,不是文本判据)═══════════ */

test('FND12-1 A 路 assemble():host 非 null 且真的进了运行时', () => {
  /* 变红条件:assemble() 不再把 host 放进 rtOpts,或不再构造 host。 */
  const a = assemble({ roomId: 'r_a', ownerId: 'o', clock: fixedClock(), sizeCells: 16 });
  ok(a.host !== null && a.host !== undefined, 'assemble() 应构造出 host');
  ok(a.rtOpts.host === a.host, 'rtOpts.host 应**是**那个 host(引用相等,不是同形新对象)');
  ok(a.runtime.worldSaveHost === a.host, '运行时的 worldSaveHost 应就是它(真的漏进去了)');
});

test('FND12-2 A 路的 host 是可用的(有 saveToDb / levelOf / attackMobAuthorized)', () => {
  /* 变红条件:返回类型标注把某个方法结构化裁掉(本仓陷阱 89 的形态)。 */
  const a = assemble({ roomId: 'r_a', ownerId: 'o', clock: fixedClock(), sizeCells: 16 });
  eq(typeof a.host.saveToDb, 'function', 'host.saveToDb 应是函数');
  eq(typeof a.host.levelOf, 'function', 'host.levelOf 应是函数');
  eq(typeof a.host.attackMobAuthorized, 'function', 'host.attackMobAuthorized 应是函数');
});

/* ═══════════ 2. B 路:host 恒为 null(源码态 + 无注入者)═══════════ */

test('FND12-3 B 路的 rtOpts.host 是 `this.deps?.host ?? null`(源码态)', () => {
  /* 变红条件:有人把 B 路的 host 改成别的来源(例如真的接上了)——
     **那条改动就该同时改本断言**,否则本套件会一直替旧事实作证。 */
  const src = readSrc('server/src/net/room.colyseus.ts');
  ok(/host:\s*this\.deps\?\.host\s*\?\?\s*null/.test(src),
    'B 路 rtOpts.host 应仍为 `this.deps?.host ?? null`(若已接线,请同步本断言)');
});

test('FND12-4 `withDeps` 在全仓**零调用点** ⇒ B 路的 deps 无人注入', () => {
  /* 变红条件:有人真的调了 withDeps(那就该更新本断言,并宣布 B 路已接上)。
     ⚠️ 判据必须**排除定义处与注释**:git grep 实测只有 :定义 与 :注释 两处。
     这里逐行分类,而不是「出现次数 > 1 就算有调用」——
     那种口径会把注释也算成调用(本仓已犯过「提取口径比事实宽」的错)。 */
  const files = ['server/src/net/room.colyseus.ts', 'server/src/index.ts'];
  const callSites: string[] = [];
  for (const f of files) {
    const code = readSrc(f)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // 行注释(保护 `://`)
    code.split('\n').forEach((l, i) => {
      if (!/withDeps/.test(l)) return;
      /* 定义处:withDeps(deps: …): this {  —— 它含 `): this` 或 `{` 收尾 */
      if (/withDeps\s*\([^)]*\)\s*:\s*this\s*\{/.test(l)) return;
      callSites.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  eq(callSites.length, 0, `withDeps 应无调用点,实测:${callSites.join(' | ') || '无'}`);
});

test('FND12-5 B 路的 host 为 null 时,三处 host 用法整段跳过(负对照)', () => {
  /* 这条是**行为**判据:证明「host=null」不是无害的 —— 它让三件事不发生。
     变红条件:运行时在 host 为 null 时仍尝试落盘/投影等级(那会抛错或谎报)。 */
  const rt = new RoomRuntime(
    { roomId: 'r_b', ownerId: 'o', clock: fixedClock(), host: null },
    null,
  );
  eq(rt.worldSaveHost, null, '不传 host 时 worldSaveHost 应为 null(这正是 B 路生产态)');
  rt.join({ userId: 'p1' });
  /* 推进若干帧:host 为 null ⇒ 不应有任何落盘报告 */
  for (let i = 0; i < 25; i += 1) rt.step(null);
  eq(rt.lastSaveReport, null, 'host 为 null 时 lastSaveReport 应恒为 null(不谎报已落盘)');
});

/* ═══════════ 3. 两条路的 ownerId 必须同名(语义同一字段)═══════════ */

test('FND12-6 两条装配路径喂给 ownerId 的字段**同名**(此前后者叫 registryOwnerId)', () => {
  /* 为什么这条值得单独钉:同一个契约字段 `RoomRuntimeOptions.ownerId`
     被两处赋值,若两处的**来源字段名**不同,读者会以为那是两件事。
     实测它们是一件事(用途只有一个:判房主角色 + 玩家 id)。
     ⇒ 变红条件:有人把任一处的来源名改回不一致。 */
  const colSrc = readSrc('server/src/net/room.colyseus.ts');
  const idxSrc = readSrc('server/src/index.ts');
  ok(!/registryOwnerId/.test(colSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')),
    'room.colyseus.ts 的**代码态**不应再出现 registryOwnerId(已改名 ownerId)');
  ok(/ownerId:\s*this\.deps\?\.ownerId\s*\?\?\s*'u_owner'/.test(colSrc),
    'B 路应从 deps.ownerId 取值,与 A 路同名');
  ok(/ownerId:\s*deps\.ownerId\s*\?\?\s*'u_owner'/.test(idxSrc),
    'A 路应从 deps.ownerId 取值');
});

test('FND12-7 ownerId 的用途是**玩家身份**(不是注册表运维者)—— 行为反证', () => {
  /* 若 ownerId 是「注册表运维者」,那它不该决定房间内的角色。
     实测它决定:ownerId 那个人拿 OWNER 角色。⇒ 变红条件:角色不再由 ownerId 决定。 */
  const reg = new RoomRegistry({ clock: fixedClock() });
  const rt = reg.create({ roomId: 'r_own', ownerId: 'u_boss' });
  const asOwner = rt.join({ userId: 'u_boss' });
  const asOther = rt.join({ userId: 'u_someone' });
  ok(asOwner.ok && asOther.ok, '两人都应能进(准入未设限)');
  eq(asOwner.role, 'OWNER', 'ownerId 那个人应拿 OWNER 角色');
  ok(asOther.role !== 'OWNER', '别人不该拿 OWNER 角色');
});

/* ═══ 4. 「不可加载」**已修**:接线阻塞消失,且 handler 真的注册了 ═══ */

test('FND12-8 B 路**必须可加载**,且 4 条 handler 在 onCreate 里真的被注册(原断言为「不可加载」)', () => {
  /* ★ 本条于 2026-11-14(task-95)**按设计改向**,不是删改措辞。
     原断言把「B 路当前不可加载」钉成事实,并据此证明「在 index.ts 里加一行 import
     会让门禁红」。三条阻塞(装饰器 / CJS 命名导入 / registerHandlers 0 调用点)
     修好后,那条断言**必然变红** —— 变红是「接线阻塞消失」的验收信号,
     而不是回归(原注释里就写着「若这条红了:说明 B 路已可加载……应更新本断言」)。
     ⇒ 新口径(本条**保留**,只换方向):**B 路必须可加载**,且 **handler 必须已注册**。

     判据与 verify.ts 的 `entryLoadable()` 同源:子进程 import,只看
     SyntaxError / ERR_MODULE_NOT_FOUND / ERR_INVALID_TYPESCRIPT_SYNTAX。 */
  const judge = (spec: string): boolean => {
    const src =
      `import(${JSON.stringify(spec)}).then(()=>{process.exit(0)},e=>{`
      + `const name=String(e&&e.constructor&&e.constructor.name);`
      + `const code=String((e&&e.code)||'');`
      + `const bad=code==='ERR_MODULE_NOT_FOUND'||code==='ERR_INVALID_TYPESCRIPT_SYNTAX'`
      + `||code==='ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';`
      + `if(name==='SyntaxError'||bad){process.exit(3)}process.exit(0)});`;
    const r = spawnSync(process.execPath, ['-e', src], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
    return r.status === 0;
  };
  ok(judge('./server/src/index.ts'), '基线:index.ts 应可加载');
  ok(judge('./server/src/net/room.colyseus.ts'),
    'B 路**必须可加载**。若这条红了:装饰器 / CJS 命名导入的阻塞又回来了 ——'
    + '而它是 PROD_ENTRIES 成员(生产入口),加载不了就等于整条 B 路跑不到');

  /* ── 第二半:4 条 handler 必须**真的**被注册 ──
     ★ 为什么必须用行为判据,不能只查源码里有 `this.registerHandlers();` 这一行:
       源码里存在 ≠ 被调用。task-95 实测的原始缺陷恰恰是「方法声明在、全仓 0 调用点」——
       而「查字符串在不在」的断言对那个缺陷**恰好是绿的**(本仓反复点名的
       「存在性断言冒充定位断言」形态)。
     ⇒ 做法:真跑一次 `onCreate()`,只把**副作用**换掉 ——
       · Colyseus 构造器会 `setPatchRate(50)` 起一个定时器,故在 prototype 上先换掉它
         (否则定时器挂住进程,测试文件跑完不退出);
       · `onMessage` 换成记录器(这样「注册了哪几条」可逐条核对);
       · `setState` / `setSimulationInterval` 换成空实现(不真起 patch 与 20Hz 定时器)。
       `assertSchemaReady()`、`new RoomRuntime(...)`、`this.maxClients = ...` 都**真跑**。
     ⇒ 变红条件:去掉 `onCreate` 里的 `this.registerHandlers();`(或改坏它的调用),
       则 `seen` 为空数组 ⇒ 本断言红。 */
  const proto = NetPersistRoom.prototype as unknown as Record<string, unknown>;
  const realPatchRate = proto.setPatchRate;
  proto.setPatchRate = function stubPatchRate(): void { /* 不建定时器 */ };
  const room = new NetPersistRoom();
  proto.setPatchRate = realPatchRate;
  /* 关掉 Colyseus 的「空房自动销毁」定时器(否则 1s 后它自己 dispose,污染 stderr)。 */
  room.autoDispose = false;

  const rec = room as unknown as {
    onMessage: (type: string, cb: unknown) => void;
    setState: (state: unknown) => void;
    setSimulationInterval: (fn: () => void, ms: number) => void;
    onCreate: (options: unknown) => void;
    maxClients: number;
    runtime: { id: string };
  };
  const seen: string[] = [];
  rec.onMessage = (type) => { seen.push(type); };
  rec.setState = () => { /* 不建 schema 状态 */ };
  rec.setSimulationInterval = () => { /* 不起 20Hz 定时器 */ };
  rec.onCreate({ roomId: 'r_fnd12', maxPlayers: 4 });

  eq(seen, ['move', 'attack', 'inventory', 'action'],
    'onCreate 必须注册 4 条报文入口(漏一条 = 那条输入在生产里被**静默丢弃**:'
    + 'onMessage 无 handler 时 Colyseus 不报错)');
  eq(rec.maxClients, 4, 'onCreate 确实执行了(它把 options.maxPlayers 写进房间)');
  ok(rec.runtime !== undefined && rec.runtime.id === 'r_fnd12',
    'onCreate 确实建好了运行时 ⇒ 上面那次注册发生在 runtime 之后(handler 收到报文时读它)');
});

/* ═══════════ 5. 两处 rtOpts 键集仍相等(防分叉,与 FND9-9 互补)═══════════ */

test('FND12-9 两处 rtOpts 的**键集**逐字相等(分叉即红)', () => {
  /* FND9-9 已查「房间侧的键 assemble() 都有,且不多」。
     这里补一个**反向**视角:直接从两段源码抽键集比大小与成员,
     不经过 assemble() 的实际产出 —— 于是即使 assemble() 坏了,
     这条仍能独立指出「两边字面量已经不一样了」。 */
  const grab = (src: string, re: RegExp): string[] => {
    const m = re.exec(src);
    ok(m !== null, '应能在源码里找到 rtOpts 字面量');
    const body = m?.[1] ?? '';
    return [
      ...[...body.matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1] as string),
      ...[...body.matchAll(/^\s*(\w+)\s*,\s*$/gm)].map((x) => x[1] as string),
    ].sort();
  };
  const idx = grab(readSrc('server/src/index.ts'), /const rtOpts: RoomRuntimeOptions = \{([\s\S]*?)\n  \};/);
  const col = grab(readSrc('server/src/net/room.colyseus.ts'), /const rtOpts: RoomRuntimeOptions = \{([\s\S]*?)\n    \};/);
  /* 分母先断言 > 0,避免「两边都抽空了 ⇒ 相等 ⇒ 绿」这种空对空。 */
  ok(idx.length > 0 && col.length > 0, `两侧都应抽到键(实测 ${idx.length} / ${col.length})`);
  const onlyIdx = idx.filter((k) => !col.includes(k));
  const onlyCol = col.filter((k) => !idx.includes(k));
  eq(onlyIdx.length, 0, `只在 A 路的键:${onlyIdx.join(', ') || '无'}`);
  eq(onlyCol.length, 0, `只在 B 路的键:${onlyCol.join(', ') || '无'}`);
});

/* ═══════════ 6. verify.ts 的措辞必须**分口径**(不许简化成一句)═══════════ */

test('FND12-10 verify.ts 不得再声称「生产装配路径已存在 / host 不再是恒 null」而不带口径', () => {
  /* 这条是本任务 3 的**验收**:措辞修正必须能变红。
     判据:那两句断言强度的句子,若出现,必须与「A 路 / B 路」同时出现。
     变红条件:有人把分口径的句子删回一句过度声称。 */
  const v = readSrc('scripts/verify.ts');
  const overclaim = /生产装配路径\*\*已存在\*\*,host \*\*不再是恒 null\*\*/;
  ok(!overclaim.test(v), '旧的无口径断言应已被移除');
  /* 分口径的说法必须在场 */
  ok(/A 路/.test(v) && /B 路/.test(v),
    'verify.ts 应显式区分 A 路 / B 路');
  ok(/仍然恒为 null|恒为 null/.test(v),
    'verify.ts 应仍**保留**「B 路 host 恒为 null」这个未交付事实(不可连带删掉)');
});

test('FND12-11 verify.ts 的 patch 关闭说明必须记着 setPatchRate(null) 这个形态', () => {
  /* task-76 顺带实测出的并列缺陷:直赋 `patchRate = null` 关不掉定时器。
     变红条件:有人把这条实测记录删掉(那下一个人会再踩一次)。
     ⚠️ 我第一版只查「`setPatchRate(null)` 在全文出现过」—— **那条断言没有牙**:
        `setPatchRate(null)` 在文中出现 **2 处**(L3211 的对照行 + L3214 的结论行),
        删掉任一处,另一处仍满足正则 ⇒ 注入实测**没变红**。
        ⇒ 这正是「存在性断言冒充定位断言」的形态。
        改为**要求三件事落在同一个连续块里**(机制/对照/结论),
        删掉任何一句都会把这个块打断。 */
  const v = readSrc('scripts/verify.ts');
  /* 取一段连续文本作为「那块记录」—— 三句必须在同一块内相邻出现 */
  const block = /broadcastPatch[^]{0,400}?setPatchRate\(null\)[^]{0,400}?已改为[^]{0,80}?setPatchRate\(null\)/;
  ok(block.test(v),
    'verify.ts 应有一段**连续**的 patch 实测记录:broadcastPatch 机制 → setPatchRate(null) 对照 → '
    + '「已改为 setPatchRate(null)」结论。缺任一句都说明这段记录被削弱了');
  /* 且必须写明「直赋属性」的老写法是错的 —— 否则读者会以为两者等价 */
  ok(/直赋|直接赋/.test(v), 'verify.ts 应记明「直赋 patchRate = null」是错的那种写法');
});

report('WS-FND-12');