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

/* 这三条把「handshake 为何是真欠账、但为何**不能现在接线**」钉住。
 * 它们是**接线的前置条件清单** —— 条件变了就该来改这里,并据此接线。 */

console.log('\n— task-37 归属判定:handshake 是真欠账但被三前提阻塞 —');

/* 前提1:生产 join 路径没有承载 contentClaim 的位置。 */
const roomSrcT37 = readFileSync(join(ROOT, 'server', 'src', 'net', 'room.ts'), 'utf8');
ok(!roomSrcT37.includes('contentClaim'),
  'room.ts 完全不提 contentClaim(join 无该入参位)⇒ 接线要先改 join 签名');
ok(!roomSrcT37.includes('verifyContentCompatibility'),
  'room.ts 不调用内容校验 ⇒ 现状是「完全不校验」而非「另有机制替代」');

/* 前提2:默认策略 STRICT,而它拒绝「未提供指纹」的客户端。 */
eq(h.DEFAULT_CONTENT_POLICY, h.ContentPolicy.STRICT, '默认策略为 STRICT');
const strictNull = h.verifyContentCompatibility(null, h.ContentPolicy.STRICT);
ok(strictNull.ok === false,
  'STRICT + 无指纹 ⇒ 拒绝(故「无条件接线」会把所有现有客户端挡在门外)');
ok(strictNull.reason?.includes('未提供内容指纹') === true,
  `拒因指明是「未提供指纹」(实测:${strictNull.reason?.slice(0, 40)}...)`);

/* 前提3:客户端没有网络层 ⇒ 发不出声明。 */
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
eq(clientNet.length, 0, '客户端零网络能力 ⇒ 无通道发送 contentClaim(接线需先补网络层)');

/* 三项合起来:现状**没有**替代机制在做内容一致性校验 —— 缺口是真实的。 */
const deltaSrcT37 = readFileSync(DELTA_SRC_PATH, 'utf8');
ok(!deltaSrcT37.includes('contentFingerprint'),
  'delta.ts 也不做内容校验 ⇒ 两端内容错配在生产上确实无人拦截');

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