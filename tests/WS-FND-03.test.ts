/**
 * WS-FND-03 —— 内容版本协商(handshake)测试
 *
 * 被测:`server/src/content/handshake.ts`
 * 性质:纯函数,零依赖,可在任何环境跑。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as h from '../server/src/content/handshake.ts';
import { contentFingerprintLine, contentFingerprints, fnv1a32 } from '../server/src/content/registry.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import * as DELTA from '../shared/net/delta.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ★ delta 编解码器的**源码路径唯一定义点**(task-68 上移后)。
 *
 * 为什么要有这个常量(而不是像别处那样直接在断言里 `join(...)`):
 * ```
 * 本文件对 delta.ts 有两类依赖:
 *   1 **行为依赖** —— `import * as DELTA`(上移前是路径读文本 ⇒ 上移即崩 ENOENT)
 *   2 ★ **否定依赖** —— 「delta 未 import 内容指纹」这类断言**没有行为对应物**
 *      (你无法在一次 import 里证明「它没有引用别的东西」)
 *      ⇒ 只能保留源码扫描 ⇒ 就需要路径
 * ⇒ 路径抽成常量:上移/改名时**只改这一处**,不会出现「改了两处漏一处 ⇒ 崩」
 * 承 `verify.ts` 抽 `extractRelativeImports` 的先例(CR-20:两份实现两份口径)。
 */
const DELTA_SRC_PATH = join(ROOT, 'shared', 'net', 'delta.ts');

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string): void => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${msg}`);
  }
};
const eq = (a: unknown, b: unknown, msg: string): void =>
  ok(a === b, `${msg}${a === b ? '' : `  (实测 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)})`}`);
const okHas = (s: string, sub: string, msg: string): void => ok(s.includes(sub), `${msg}(含「${sub}」)`);

console.log('[WS-FND-03] 内容版本协商\n');

/* ═══════════ 1. 服务端身份 ═══════════ */

console.log('— 本地内容身份 —');
const local = h.localContentClaim();
eq(typeof local.version, 'number', '版本号是数字');
eq(local.version, contentFingerprints().version, '版本号取自 registry');
eq(local.overall, contentFingerprints().overall, 'overall 取自 registry');
eq(typeof local.parts?.items, 'string', 'items 分区存在');
eq(local.parts?.items, contentFingerprints().items, 'items 分区与 registry 一致');
eq(typeof local.parts?.mobs, 'string', 'mobs 分区存在');
eq(typeof local.parts?.bosses, 'string', 'bosses 分区存在');
eq(typeof local.parts?.modes, 'string', 'modes 分区存在');

/* 幂等:函数内部每次都重算,结果必须稳定 */
const local2 = h.localContentClaim();
eq(local.overall, local2.overall, '两次调用 overall 相同(幂等)');

/* ═══════════ 2. 编码 / 解析 round-trip ═══════════ */

console.log('\n— 编码解析 round-trip —');
const enc = h.encodeContentClaim(local);
const dec = h.decodeContentClaim(enc);
eq(dec?.overall, local.overall, 'overall round-trip');
eq(dec?.version, local.version, 'version round-trip');
eq(dec?.parts?.items, local.parts?.items, 'items round-trip');
eq(dec?.parts?.mobs, local.parts?.mobs, 'mobs round-trip');
eq(dec?.parts?.bosses, local.parts?.bosses, 'bosses round-trip');
eq(dec?.parts?.modes, local.parts?.modes, 'modes round-trip');

/* 编码格式:`v<版本>-<overall>[-<4 个分区>]` */
eq(enc.startsWith('v'), true, '编码以 v 开头');
eq(enc.split('-').length, 3, '含分区时恰好 3 段');
const partsSeg = enc.split('-')[2].split('.');
eq(partsSeg.length, 4, '分区段恰 4 个');
okHas(enc, local.overall, '编码含 overall');

/* 无分区形式 */
const bare = h.encodeContentClaim({ version: 1, overall: 'abcdef01' });
eq(bare, 'v1-abcdef01', '无分区编码格式正确');
eq(h.decodeContentClaim(bare)?.parts, undefined, '无分区解析出 parts 为 undefined');
eq(h.decodeContentClaim(bare)?.overall, 'abcdef01', '无分区解析出 overall');

/* 编码幂等 */
eq(h.encodeContentClaim(local), h.encodeContentClaim(h.localContentClaim()), '两次编码相同');

/* ═══════════ 3. 非法输入全部拒绝 ═══════════ */

console.log('\n— 非法输入拒绝 —');
const badCases: [string, string][] = [
  ['', '空串'],
  ['x1-abc', '缺少 v 前缀'],
  ['v1', '只有版本段'],
  ['v1-ZZZZZZZZ', 'overall 非十六进制'],
  ['v1-', 'overall 为空'],
  ['vabc-deadbeef', '版本非数字'],
  ['v0-deadbeef', '版本为 0'],
  ['v-1-deadbeef', '版本负数'],
  ['v1.5-deadbeef', '版本含小数点'],
  ['v1-abc-a.b.c', '分区只有 3 个'],
  ['v1-abc-a.b.c.d.e', '分区 5 个'],
  ['v1-abc-a.b.c.zzz', '分区含非十六进制'],
  ['v1-abc-a.b.c.d-extra', '多余段(静默丢弃风险)'],
  ['v1-abc-a.b.c.d-x-y', '更多多余段'],
  ['v1-abc-', '分区段为空'],
];
for (const [bad, desc] of badCases) eq(h.decodeContentClaim(bad), null, `${desc} → null`);

/* null / undefined 也要安全 */
eq(h.decodeContentClaim(null), null, 'null → null');
eq(h.decodeContentClaim(undefined), null, 'undefined → null');

/* ═══════════ 4. 严格模式 ═══════════ */

console.log('\n— 严格模式(默认) —');
eq(h.DEFAULT_CONTENT_POLICY, 'STRICT', '默认策略为 STRICT');
const strictSame = h.verifyContentCompatibility(local, h.ContentPolicy.STRICT);
eq(strictSame.ok, true, '一致 → 放行');
eq(strictSame.match, true, '一致 → match 为真');
eq(strictSame.reason, undefined, '一致 → 无拒绝原因');
eq(strictSame.warning, undefined, '一致 → 无告警');

const strictDiff = h.verifyContentCompatibility({ ...local, overall: 'deadbeef' }, h.ContentPolicy.STRICT);
eq(strictDiff.ok, false, '不一致 → 拒绝');
eq(strictDiff.match, false, '不一致 → match 为假');
ok(strictDiff.reason !== undefined, '不一致 → 有拒绝原因');
okHas(strictDiff.reason ?? '', '物品 ID 是持久化身份', '拒绝原因解释了为什么危险');

const strictMissing = h.verifyContentCompatibility(null, h.ContentPolicy.STRICT);
eq(strictMissing.ok, false, '缺指纹 → 严格模式拒绝');
okHas(strictMissing.reason ?? '', '未提供', '说明客户端未提供');

/* 空字符串等同缺失 */
eq(h.verifyContentCompatibility({ version: 1, overall: '' }, h.ContentPolicy.STRICT).ok, false, '空 overall → 拒绝');

/* ═══════════ 5. 宽松模式 ═══════════ */

console.log('\n— 宽松模式 —');
const lenDiff = h.verifyContentCompatibility({ ...local, overall: 'deadbeef' }, h.ContentPolicy.LENIENT);
eq(lenDiff.ok, true, '不一致 → 放行');
eq(lenDiff.match, false, '不一致 → match 仍为假');
ok(typeof lenDiff.warning === 'string', '不一致 → 给出告警');

const lenMissing = h.verifyContentCompatibility(null, h.ContentPolicy.LENIENT);
eq(lenMissing.ok, true, '缺指纹 → 放行');
ok(typeof lenMissing.warning === 'string', '缺指纹 → 给出告警');

const lenSame = h.verifyContentCompatibility(local, h.ContentPolicy.LENIENT);
eq(lenSame.ok, true, '一致 → 放行');
eq(lenSame.warning, undefined, '一致 → 无告警');

/* ═══════════ 6. 分区诊断 ═══════════ */

console.log('\n— 分区诊断 —');
const onlyItemsDiff = {
  version: local.version,
  overall: 'deadbeef',
  parts: { items: 'ffffffff', mobs: local.parts?.mobs, bosses: local.parts?.bosses, modes: local.parts?.modes },
};
const diag = h.verifyContentCompatibility(onlyItemsDiff, h.ContentPolicy.STRICT);
eq(diag.differingParts?.length, 1, '只识别出 1 个差异分区');
eq(diag.differingParts?.[0], 'items', '差异分区是 items');

const allDiff = {
  version: local.version,
  overall: 'deadbeef',
  parts: { items: '11111111', mobs: '22222222', bosses: '33333333', modes: '44444444' },
};
eq(h.verifyContentCompatibility(allDiff, h.ContentPolicy.STRICT).differingParts?.length, 4, '全不同 → 4 个分区');

/* 无分区信息时不应崩,只是无法定位 */
const noParts = h.verifyContentCompatibility({ version: local.version, overall: 'deadbeef' }, h.ContentPolicy.STRICT);
eq(noParts.differingParts?.length, 0, '无分区信息 → 差异分区为空');
okHas(noParts.reason ?? '', '无法定位差异', '并说明无法定位');

/* ═══════════ 7. 算法版本不匹配 ═══════════ */

console.log('\n— 指纹算法版本 —');
const verMismatch = h.verifyContentCompatibility({ version: local.version + 1, overall: local.overall }, h.ContentPolicy.STRICT);
eq(verMismatch.ok, false, '算法版本不同 → 拒绝');
okHas(verMismatch.reason ?? '', '算法版本', '原因指出是算法版本');
/* 即使 overall 相同也要拒绝:不同算法算出的指纹不可比 */
eq(
  h.verifyContentCompatibility({ version: local.version + 1, overall: local.overall }, h.ContentPolicy.LENIENT).ok,
  true,
  '宽松模式下算法版本不同仍放行',
);

/* ═══════════ 8. 存档侧校验 ═══════════ */

console.log('\n— 存档内容版本 —');
const cur = contentFingerprintLine();
const saveOk = h.checkSaveContent(cur);
eq(saveOk.ok, true, '指纹一致 → 可载入');
eq(saveOk.needsMigration, false, '一致 → 无需迁移');
eq(saveOk.current, cur, 'current 为当前指纹');

const saveNull = h.checkSaveContent(null);
eq(saveNull.ok, false, '旧存档无指纹 → 拒绝载入');
eq(saveNull.needsMigration, true, '旧存档 → 需要迁移');
eq(saveNull.saved, null, 'saved 为 null');
okHas(saveNull.message, '固化', '说明会固化错误');

eq(h.checkSaveContent(undefined).ok, false, 'undefined → 拒绝');
eq(h.checkSaveContent(undefined).needsMigration, true, 'undefined → 需迁移');
eq(h.checkSaveContent('').needsMigration, true, '空串 → 需迁移');

const saveDiff = h.checkSaveContent('v1-00000000');
eq(saveDiff.ok, false, '指纹不一致 → 拒绝载入');
eq(saveDiff.needsMigration, true, '不一致 → 需迁移');
okHas(saveDiff.message, 'EXTENDING.md', '指向迁移手册');

/* ═══════════ 9. 安全性质:服务端指纹不取自客户端 ═══════════ */

console.log('\n— 安全性 —');
eq(
  h.verifyContentCompatibility(local, h.ContentPolicy.STRICT).serverFingerprint,
  cur,
  'serverFingerprint 恒取自本地内容表',
);
/* 客户端声称一个服务端没有的指纹 → 仍返回本地指纹,不回声客户端值 */
const forged = h.verifyContentCompatibility({ version: 1, overall: 'ffffffff' }, h.ContentPolicy.STRICT);
eq(forged.ok, false, '伪造指纹被拒');
eq(forged.serverFingerprint, cur, '仍返回本地指纹(不回声客户端)');
eq(forged.serverFingerprint.includes('ffffffff'), false, '返回值不含客户端伪造值');

/* 客户端不能通过「声称与服务端一致」来绕过 —— 因为服务端算自己的 */
const echoing = h.verifyContentCompatibility({ version: local.version, overall: local.overall }, h.ContentPolicy.STRICT);
eq(echoing.serverFingerprint, cur, '一致时服务端指纹仍是本地算的');

/* ═══════════ 10. 报告输出 ═══════════ */

console.log('\n— 报告 —');
const repBad = h.contentCompatReport(strictDiff);
okHas(repBad, '拒绝', '拒绝报告含「拒绝」');
okHas(repBad, 'STRICT', '含策略名');
okHas(repBad, cur, '含服务端指纹');
okHas(repBad, '原因', '含原因标签');

const repGood = h.contentCompatReport(strictSame);
okHas(repGood, '一致', '一致报告含「一致」');

const repLenient = h.contentCompatReport(lenDiff);
okHas(repLenient, '放行', '宽松报告含「放行」');
okHas(repLenient, '告警', '宽松报告含告警');

const breakdown = h.fingerprintBreakdown();
for (const k of ['items', 'mobs', 'bosses', 'modes', 'overall']) {
  okHas(breakdown, k, `分区视图含 ${k}`);
}
okHas(breakdown, `v${contentFingerprints().version}`, '分区视图含算法版本');

/* ═══════════ 11. 约束:不改线格式 ═══════════ */

console.log('\n— 与既有线格式解耦 —');
/**
 * ★ task-68:原判据是 `readFileSync(join(ROOT,'server','src','net','delta.ts'))` ——
 * **硬编码路径**。delta.ts 上移 `shared/net/` 后该路径不存在 ⇒ `readFileSync`
 * 在**模块顶层**抛 ENOENT ⇒ 未捕获 ⇒ **进程直接退出**,
 * 表现为「exit≠0 且没有任何断言输出」—— 比断言变红**更难排查**(看不到哪条挂了)。
 *
 * ⇒ 拆成两条**口径不同**的断言,各自用它能用的最强形式:
 *   1 「协议版本常量还在」⇒ 换**行为判据**(更强:文本里有 ≠ 真的导出成功)
 *   2 「未 import 内容指纹」⇒ **否定**断言,无行为对应物 ⇒ 保留源码扫描,路径由常量给
 */
ok(typeof DELTA.PROTOCOL_VERSION === 'number', 'delta 仍有协议版本常量(行为判据:真的导出成功)');
const deltaSrc = readFileSync(DELTA_SRC_PATH, 'utf8');
ok(
  !deltaSrc.includes('contentFingerprint'),
  'delta.ts 未 import 内容指纹(内容协商与线格式解耦)',
);

const hsSrc = readFileSync(join(ROOT, 'server', 'src', 'content', 'handshake.ts'), 'utf8');
ok(
  !hsSrc.includes("from '../net/") && !hsSrc.includes("from './delta"),
  'handshake.ts 不依赖网络层(可独立测试)',
);
okHas(hsSrc, 'ContentPolicy', '导出策略常量');

/* ═══════════ task-37:handshake 的主人归属判定 ═══════════ */

/*
 * ★★ task-A 结构性改写(2026-11-13):从「**钉住缺陷**」改成「**钉住能力**」
 *
 * ## 原形态的病
 * ```
 * 原文四条都是**否定式**,记录的是「内容协商在生产上完全没接线」:
 *   L298 ok(!roomSrc.includes('contentClaim'))         ← room 还不承载
 *   L300 ok(!roomSrc.includes('verifyContentCompatibility')) ← room 还不校验
 *   L323 eq(clientNet.length, 0)                        ← 客户端还没有网络层
 *   L327 ok(!deltaSrc.includes('contentFingerprint'))   ← 协议层不管内容
 * ⇒ 前三条把**一个缺陷状态**写成了**期望值**
 *   ⇒ 缺陷一被修,它们就变红 ⇒ **这不是意外,是它们的设计注定的**
 *   ⇒ 后果:接线的人必须"先改测试",于是测试从**门禁**退化成**路障**
 * ```
 * ## 改法:三种断言分开,各自钉它真正该钉的东西
 * ```
 * 甲 **能力断言**(永远为真,接线前后都绿)—— 判据是「这个机制能不能工作」
 * 乙 **架构不变量**(永远为真)—— 判据是「两层的职责边界」
 * 丙 ★ **不许出现的中间态**(接线前后都绿,**只在半接线时红**)
 *     这是关键:把「两个独立的缺失」升级成「一个不许出现的组合」
 *     ⇒ 它不奖励"没做",也不惩罚"做了",只抓"做了一半"
 * 丁 **接线状态报告**(非断言)—— 让下一个人看到进展,但**不会因进展变红**
 * ```
 * ⚠️ 为什么丙比"接上了就绿"更强:接线有**两个独立动作**(服务端承载 + 客户端发送)。
 *    「接上了就绿」只覆盖两个都完成的终态;而真正的危险区恰恰是**中间态**
 *    (服务端开始校验、客户端还没发指纹 ⇒ **所有客户端被挡在门外**)。
 *    ⇒ 丙把这个中间态抓成红的 —— 那是**真缺陷**,不是进度差异。
 */

console.log('\n— task-37 归属判定:内容协商的能力与接线状态 —');

/* ── 甲 能力断言:机制本身能不能工作(接线前后都必须成立)── */
console.log('\n  · 能力:校验机制覆盖三态');
eq(h.DEFAULT_CONTENT_POLICY, h.ContentPolicy.STRICT, '默认策略为 STRICT');
const strictNull = h.verifyContentCompatibility(null, h.ContentPolicy.STRICT);
ok(strictNull.ok === false,
  '能力①:STRICT + 无指纹 ⇒ 拒绝(故「无条件接线」会把所有现有客户端挡在门外)');
ok(strictNull.reason?.includes('未提供内容指纹') === true,
  `能力①拒因指明是「未提供指纹」(实测:${strictNull.reason?.slice(0, 40)}...)`);

/* ★ task-A 补的两条:原判据只测了「null + STRICT ⇒ 拒」,
   而**能力齐全**还要求「匹配 ⇒ 通」「不匹配 ⇒ 拒」。
   缺后两条的话,一个「永远返回 false」的实现也能让上面那条绿。
   ⚠️ `verifyContentCompatibility` 收的是 **ClientContentClaim 对象**,不是字符串
      (我第一版传了字符串 ⇒ 实测 ok=false ⇒ 被自己的断言抓住)。 */
const claimLocal = h.localContentClaim();
const matchRes = h.verifyContentCompatibility(claimLocal, h.ContentPolicy.STRICT);
ok(matchRes.ok === true,
  `能力②:提供的指纹与本地一致 ⇒ 放行(实测 ok=${matchRes.ok})`);
const mismatchRes = h.verifyContentCompatibility(
  { ...claimLocal, overall: 'ffffffffffffffff' }, h.ContentPolicy.STRICT);
ok(mismatchRes.ok === false,
  '能力③:指纹不一致 ⇒ 拒绝(否则校验形同虚设)');

/* ── 丙 ★ 不许出现的中间态:服务端承载就必须校验,不承载就两边都不carry ──
 *
 * ⚠️⚠️ **这一族判据必须读「代码」,不能读「原文」** —— 我第一版用
 *      `roomSrc.includes('verifyContentCompatibility')` 措词,**反向核查当场抓住它没牙**:
 * ```
 * 注入:room.ts 加一行 `const contentClaim = null;` +
 *       一句**注释**里提到 verifyContentCompatibility
 * ⇒ roomCarries=true,roomVerifies=true(命中注释!)⇒ 两边相等 ⇒ **绿**
 * ⇒ 但那正是「承载了却不校验」= 真缺陷 ⇒ 判据对真缺陷**没有牙**
 * ```
 * ⇒ 与 `maskMore` 那条 bug **完全同族**:「注释里的字不是判据」。
 *   修法同 task-63:去注释,**并且**判**调用形态**而不是判"出现过":
 * ```
 * `/verifyContentCompatibility\s*\(/`  ← 带左括号
 *   ⇒ 排除 `import { verifyContentCompatibility } from ...`(那是"引入",不是"调用")
 *   ⇒ 排除类型注解 `: typeof verifyContentCompatibility`
 * ```
 */
/* ══════════════════════════════════════════════════════════════════════════
   ★ stripComments —— 把「注释里的字」从判据里剔掉

   ⚠️⚠️ **这个函数的必要性是被反向核查证明的**(见上方日志):不去注释的话,
      一句提到 `verifyContentCompatibility` 的**注释**就会让判据误判为"已校验"。

   ## 那条 `(^|[^:])` 守卫:方向对,但**理由必须写准**
   ```
   我原来的注释写:「否则 https:// 里的 // 会被当注释截断」
   ⇒ ★ 这句**不准** —— 实测(8 个用例,仅 1 例有差别):
        A 同行:`const u='https://x/y'; const r = verifyContentCompatibility(c);`
          有守卫=true  无守卫=**false**   ★★ 有差别
        B 跨行:`https://` 与真调用**不同行**
          有守卫=true  无守卫=true        无差别
   ⇒ 被吃掉的**不是 URL**(URL 本身是对的),而是**同一行里、URL 之后紧跟的真代码**。
     跨行形态下无差别,因为那一行的真代码本来就不在同一行。
   ⇒ ⇒ 所以守卫防的是**假阴性**(把真调用弄丢),而假阴性**看不见** ——
       这正是本仓反复出问题的那一类。**测例必须用同行形态**,否则证明不了这一点。
   ```
   ## ★ 已知理论边界:模板串里的 `//`
   ```
   实测:`const s = \`// x\`; const r = verifyContentCompatibility(c);`
     ⇒ stripComments 之后 = **false**(期望 true)⇒ **假阴性**
   原因:本函数**先剥注释、不认模板串**,所以 `` `// x` `` 里的 `//` 被当行注释,
        连带吃掉同行的真代码。
   实测本仓**当前无此形态**(room.ts / delta.ts 里没有把 `//` 写进模板串的)
     ⇒ 不修,但**写在这里**:它某天出现时会以"判据莫名其妙变绿"的形式咬人。
   ⚠️ 为什么不现在改成完整的词法扫描:那是**第三份** masker 实现,
      而本仓已有一份(`assertion-audit.ts` 的 maskMore,带 tpl/interp 栈)。
      ⇒ 造第三份 = 三份口径 ⇒ 违背 CR-20。正确做法是**共用**,
        但那要动 assertion-audit 的导出面,属另一个任务。
   ══════════════════════════════════════════════════════════════════════════ */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const roomSrcT37 = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.ts'), 'utf8');
const roomCode = stripComments(roomSrcT37);
const roomCarries = /\bcontentClaim\b/.test(roomCode);
const roomVerifies = /verifyContentCompatibility\s*\(/.test(roomCode);

/* ── 丙-方向1 服务端**半接线**:承载了却不校验 ──
   ⇒ 危害形态:**挡在门外** —— 一旦开始校验而客户端没发指纹,
     STRICT 策略会把**所有**现有客户端拒掉 ⇒ 故障**可见**(没人能进来)。 */
ok(
  roomCarries === roomVerifies,
  roomCarries
    ? '★ 丙①:服务端已承载 contentClaim ⇒ 必须同时校验(否则「半接线」把所有客户端挡在门外)'
    : '★ 丙①:服务端未承载 contentClaim ⇒ 与「不校验」一致(两态自洽,不是缺陷)',
);

/* ── 丙-方向2 ★ 客户端**已发真指纹**但服务端**不读** ──
 *
 * 这是 Lead 指出的另一个方向的中间态。**实测它是真实存在的**(不是假想):
 * ```
 * client/src/net/session.ts:166-170  open 事件里发 hello:
 *     const hello: HelloFrame = { t:'hello', protocolVersion, contentClaim: null };
 *     socket.send(encodeClientFrame(JSON.stringify(hello), true));
 * ⇒ **客户端确实在线上发 contentClaim 字段** ✓
 *
 * server/src/net/room.colyseus.ts:134
 *     override onJoin(client, options: { passwordHash?: string; asGuest?: boolean })
 * ⇒ ★ options 的类型里**没有 contentClaim** ⇒ 服务端**根本没读它**
 * ```
 * ⇒ **方向2 成立**,且危害形态与方向1**根本不同**:
 * ```
 * 方向1 挡在门外   ⇒ 故障**可见**(没人能进来)⇒ 会有人来报
 * 方向2 静默丢弃   ⇒ 外部表现**一切正常**,而指纹**从来没被比对过**
 *                    ⇒ ★ **没有人会来报** —— 所以它比方向1更危险
 * ```
 * ⚠️ 为什么现在**是绿的**(而不是"我放过了它"):
 * ```
 * 客户端当前发的是**字面 `null`** —— 一个不带信息的占位符。
 * 丢掉一个 `null` 不损失任何信息 ⇒ **此刻无危害**。
 * ⇒ 判据因此钉的不是"发没发",而是「**发的是不是真指纹**」:
 *     发真指纹 + 服务端不读 ⇒ **立刻变红**
 *   ⇒ 这样它在"危险的那一刻"红,而不是在"接线中途"红。
 * ```
 */
const colyseusSrc = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.colyseus.ts'), 'utf8');
const clientSrc = readFileSync(join(ROOT, 'client', 'src', 'net', 'session.ts'), 'utf8');
const clientCode2 = stripComments(clientSrc);
/* ⚠️⚠️ **必须区分上行/下行** —— 我第一版的正则
 *    `/contentClaim\s*:\s*(?!null\b)\S/` 命中的是 **`WelcomeFrame.contentClaim: string`**
 *    (那是**服务端→客户端**的下行字段,不是客户端发的)**⇒ 判据当场误红 114/115**。
 * ```
 * ⇒ ★ 「同名标识符在不同方向上含义相反」—— 这是本任务里我第三次踩
 *   「同一个名字、不同含义」类的坑(前两次:量纲 1024/1000、注释 vs 代码)。
 * ⇒ 修法:**只在 `HelloFrame`(上行)的声明块内**判定。
 * ⚠️⚠️ 但**危险只看「线上发的是什么」= 运行时构造值**。我上一版要求
 *    「声明 **且** 运行时都非 null」才算危险,**反向核查当场抓住它漏报**:
 * ```
 * 注入:只把运行时构造改成 'v1-abc123'(声明接口仍留 null)
 *   旧条件 clientSendsRealClaim && sendsRealAtRuntime && !serverReadsClaim
 *     = false && true && true = **false** ⇒ 仍绿 ⇒ **漏报**
 * ⇒ 但那一刻线上**确实**在发真指纹、服务端确实不读 ⇒ 就是「静默丢弃」
 * ⇒ ⇒ 「声明」是**类型契约**,「构造值」是**线上事实**;危险由**事实**决定。
 *   我把「光看声明不够」错推成了「两者都要」——**"不足"不等于"必需"**。
 * ```
 * ⚠️ 而两者**不一致**本身值得单独报(契约与实际不符),故另起一条。
 * ```
 */
const helloBlock = /export interface HelloFrame\s*\{([\s\S]*?)\n\}/.exec(clientCode2);
const helloDecl = helloBlock === null ? '' : helloBlock[1]!;
const clientSendsField = /\bcontentClaim\b/.test(helloDecl);
const clientSendsRealClaim = /contentClaim\s*:\s*(?!null\b)\S/.test(helloDecl);
const helloLiteral = /const hello\s*:\s*HelloFrame\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(clientCode2);
const helloLiteralBody = helloLiteral === null ? '' : helloLiteral[1]!;
const sendsRealAtRuntime = /contentClaim\s*:\s*(?!null\b)\S/.test(helloLiteralBody);
/* 服务端是否读它:onJoin 的 options 类型或 room 侧引用 */
const serverReadsClaim = /\bcontentClaim\b/.test(stripComments(colyseusSrc)) || roomCarries;

ok(
  !(sendsRealAtRuntime && !serverReadsClaim),
  sendsRealAtRuntime && !serverReadsClaim
    ? '★ 丙②:客户端**线上发真指纹**而服务端不读 ⇒ **静默丢弃**(外部一切正常,而指纹从未被比对)'
    : `★ 丙②:线上发的 contentClaim ${sendsRealAtRuntime ? '是**真指纹**' : '是字面 null(占位,丢弃无损失)'}`
      + `;服务端${serverReadsClaim ? '读它' : '不读它'} ⇒ 无「静默丢弃」`,
);
/* ★ 契约 vs 事实不一致 —— 危害与上条不同(上条是"丢数据",这条是"契约撒谎") */
ok(
  clientSendsRealClaim === sendsRealAtRuntime,
  clientSendsRealClaim === sendsRealAtRuntime
    ? `★ 丙②契约自洽:声明(${clientSendsRealClaim ? '真指纹' : 'null'})`
      + ` = 运行时(${sendsRealAtRuntime ? '真指纹' : 'null'})`
    : `★ 丙②:类型声明与运行时构造**不一致**(声明${clientSendsRealClaim ? '真指纹' : 'null'}`
      + ` vs 运行时${sendsRealAtRuntime ? '真指纹' : 'null'})⇒ 契约与实际不符`,
);

/* ── 乙 架构不变量:线格式层与内容协商解耦 ──
   ⚠️ 这条**保持否定式是对的** —— 它守的不是"还没做",是**职责边界**:
      协议层永远不该知道内容指纹。它与进度无关。
   ⚠️ 同样要**去注释**再判,否则注释里提一句就假红。 */
const deltaSrcT37 = readFileSync(DELTA_SRC_PATH, 'utf8');
ok(!stripComments(deltaSrcT37).includes('contentFingerprint'),
  '架构不变量:线格式层不依赖内容指纹(协议与内容协商解耦)');

/* ── 丁 接线状态报告(★ 不是断言,不会因进展变红)── */
import { readdirSync, statSync } from 'node:fs';
function walkClient(d: string, a: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    if (['node_modules', '.git', 'dist'].includes(e)) continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walkClient(p, a) : /\.ts$/.test(e) && a.push(p);
  }
  return a;
}
const clientNet = walkClient(join(ROOT, 'client')).filter((f) =>
  /WebSocket|colyseus|fetch\(/.test(readFileSync(f, 'utf8')));
/* ★ 这里**不再断言** `clientNet.length === 0`。
   原因:它钉的是「客户端还没有网络层」= 一个**必然被修掉的状态**。
   改成报告:把事实说出来,让读者判断进度,**但不把进度差异判成失败**。
   (原判据在 client-stage 建 `client/src/net/session.ts` 时按设计变红 ——
    那是它的结构注定的,不是"有人弄坏了什么"。) */
console.log(`  · 接线状态(非断言):客户端有网络能力的文件 = ${clientNet.length} 个`
  + (clientNet.length > 0 ? ` → ${clientNet.map((f) => f.replace(/\\/g, '/').replace(/.*\/client\//, 'client/')).join(', ')}` : ''));
console.log(`  · 接线状态(非断言):服务端承载=${roomCarries} 校验=${roomVerifies}`
  + ` ⇒ ${roomCarries && roomVerifies ? '**已接线**' : '**未接线**(缺口真实存在:两端内容错配在生产上无人拦截)'}`);


/* 顺带钉住「不该顺手修正」的历史指纹:handshake 里的旧指纹是故意保留的记录。 */
okHas(hsSrc, 'fa111d71', 'handshake.ts 保留旧指纹 fa111d71(历史记录,刻意不改)');
okHas(hsSrc, 'checkSaveContent', '导出存档校验');

/* ═══════════ 12. 指纹与内容表真的对应 ═══════════ */

console.log('\n— 指纹与内容表对应 —');
/* 用一个独立算路径重算 items 指纹,应与 registry 一致 */
const manualItems = ITEM_LIST.map((i) => `${i.id}:${i.name}:${i.category}:${i.tags.join('|')}:${i.value}`).join('\n');
ok(manualItems.length > 0, `物品表可独立序列化(${manualItems.length} 字符)`);
ok(fnv1a32(manualItems) !== contentFingerprints().items, 'registry 用的是规范化序列化,不是简单拼接(两者不同属预期)');
ok(/^[0-9a-f]{8}$/.test(contentFingerprints().items), 'items 指纹为 8 位十六进制');

console.log(`\n[WS-FND-03] ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;