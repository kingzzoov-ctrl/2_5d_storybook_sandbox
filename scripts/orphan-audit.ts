/**
 * 「实现存在但生产跑不到」扫描器 —— 永久门禁。
 *
 * 用法:
 *   node scripts/orphan-audit.ts              # 报告(不失败)
 *   node scripts/orphan-audit.ts --strict     # 有 L2 未登记项时失败
 *   node scripts/orphan-audit.ts --baseline   # 重新生成已登记清单
 *
 * ## 为什么需要它
 *
 * 本项目**第 5 次**踩同一个坑,每次都是事后偶然发现:
 *   1. 流体相变产物 `pendingObj` 只进不出 —— 实现完整,编排层不收
 *   2. `components.ts` 40 项电路件 —— 单测全绿,生产闭包里没有它
 *   3. 炼金 6 模块 —— 3626 行零引用
 *   4. 八步伤害公式 505 行 —— `computeDamage` 生产调用点 = 0
 *   5. 客户端 8 模块约 2500 行 —— 有单测,浏览器从不加载
 *
 * 每一次的症状都一样:**实现存在 + 测试全绿 + 生产不跑到**。
 * 前四个门禁(`checkReachability` 等)都看不见,因为它们查的是
 * **文件级 import 图**,而这类缺陷的文件往往被 import 了、
 * 只是里面的东西没人用。
 *
 * ## 判据(只查最危险的一类,避免噪音)
 *
 * **L2 测试专用**:模块有 `export`,但除自身外**只有 `tests/**` 引用**,
 * `server/src` 与 `client/src` 内零引用。
 * ⇒ 实现存在、测试绿、生产永不执行。
 *
 * 不查「导出符号零调用」那一档 —— 假阳性太多(工具函数、未来 API),
 * 会让门禁退化成噪音然后被忽略。**一条会误报的门禁等于没有门禁。**
 *
 * ## 已登记清单
 *
 * `ORPHAN_KNOWN` 里每条都必须写明**为什么不接**与**接入条件**。
 * 自检:
 * - 登记项若已变可达(生产里出现了引用) ⇒ 报「应移出」;
 * - 登记项若文件不存在 ⇒ 报「失真」;
 * - 未登记的新 orphan ⇒ 报「新增」。`--strict` 下升级为失败。
 *
 * 这套自检与 `verify.ts` 的 `UNREACHABLE_EXEMPT` 同一思路 ——
 * 白名单必须自己会失效,否则它会因事实变化而静默放宽。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const STRICT = process.argv.includes('--strict');
const REBASE = process.argv.includes('--baseline');

/**
 * 已登记的生产零引用模块。
 *
 * 每条:`[相对路径, 为什么不接 / 接入条件]`。
 * 理由必须 ≥8 字符且说清**卡在哪**,否则自检报「未写明理由」。
 */
export const ORPHAN_KNOWN = new Map<string, string>([
  /* ── 服务端:等编排层接线 ── */
  ['server/src/wiring/components.ts', 'WS-08 40 项电路件;待 wiring 编排入口真正求值'],
  ['server/src/wiring/logistics.ts', 'WS-08 物流(传送带/分拣/机械臂);待接 components 求值'],
  ['server/src/party/modes.ts', 'WS-11 派对模式;待编排层按房间模式分发'],
  ['server/src/social/afk.ts', 'WS-11 挂机检测;待房间 tick 调用'],
  ['server/src/prank/immunity.ts', 'WS-11 整蛊免疫;待接 applyPrank'],
  ['server/src/build/blueprint.ts', 'WS-03 蓝图接力;待客户端蓝图面板接线'],
  ['server/src/build/rooms.ts', 'WS-03 BFS 房间识别;待建造流程调用'],
  ['server/src/build/wiring_view.ts', 'WS-08 电路可视视图;待客户端接线'],
  ['server/src/combat/damage.ts', 'WS-10 八步公式;生产走 vitals.ts 简化路径,待接线'],
  ['server/src/combat/cooking.ts', 'WS-10 烹饪;待接入交互系统'],
  ['server/src/combat/revive.ts', 'WS-10 救援;待接入玩家倒地流程'],
  ['server/src/bosses/raid.ts', 'WS-05 副本编排;待 tickMobs 调用'],
  ['server/src/bosses/breaks.ts', 'WS-05 Boss 破防;待 tickMobs 调用'],
  ['server/src/mobs/taming.ts', 'WS-04 驯服;待交互系统调用'],
  ['server/src/net/prediction.ts', 'WS-07 客户端预测;待 rollback 路径接入'],
  ['server/src/db/memory_db.ts', 'WS-07 内存库;生产走 sqlite 驱动,仅测试用'],
  ['server/src/content/handshake.ts', '内容握手;待房间 join 时校验'],
  ['server/src/content/baseline.ts', '内容基线锁;仅门禁与测试使用'],
  /* ── 客户端:8 个模块已于 2026-11-12 **全部接线**,整块摘除 ──
   *
   * 曾经这里有 7 条(audio / boss_hud / inventory / pixel_easel / recipe_tree /
   * state_machine / blueprint / roof_transparency)。**本表自检把它们逐条抓了出来**
   * —— 每接通一个,它就报一次「已可达,应移出」。
   * 现有装配:`three/ui_binding.ts`(Canvas2D 覆盖层)+ `three/audio_out.ts`
   * (WebAudio)+ `ui/panel_layout.ts`(布局纯逻辑),由 UI 状态机驱动。
   * 客户端不再有「生产零引用」模块。
   *
   * **留作教训**:这张表自检抓出过我 **5 次**误登记(把已可达的写进来)。
   * 若没有那道自检,白名单会越积越宽而门禁全程绿色 ——
   * 与 `UNREACHABLE_EXEMPT` 的「理由过时」是同一个病。 */
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, out);
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const PROD_DIRS = ['server/src', 'client/src'];
const prodFiles = PROD_DIRS.flatMap((d) => walk(join(ROOT, d)));
const testFiles = walk(join(ROOT, 'tests'));

const relOf = (p: string): string => relative(ROOT, p).split(sep).join('/');
const text = new Map<string, string>();
for (const f of [...prodFiles, ...testFiles]) text.set(relOf(f), readFileSync(f, 'utf8'));

/** 解出相对说明符后反解成绝对路径再比 —— 避免 `./x.ts` / `./x` 写法漏判。 */
function referencedBy(target: string, froms: string[], self: string): string[] {
  const tAbs = resolve(ROOT, target);
  const hits: string[] = [];
  for (const f of froms) {
    const r = relOf(f);
    if (r === self) continue;
    const src = text.get(r) ?? '';
    const dir = dirname(resolve(ROOT, r));
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]*)['"]/g)) {
      let cand = resolve(dir, m[1]!);
      if (!existsSync(cand)) {
        for (const ext of ['.ts', '/index.ts']) if (existsSync(cand + ext)) { cand += ext; break; }
      }
      if (cand === tAbs) { hits.push(r); break; }
    }
  }
  return hits;
}

/* ── 找出所有 L2 orphan ── */
const found: { file: string; tests: string[]; lines: number }[] = [];
for (const f of prodFiles) {
  const r = relOf(f);
  const src = text.get(r) ?? '';
  if (!/^export /m.test(src)) continue;
  if (referencedBy(f, prodFiles, r).length > 0) continue;
  const byTest = referencedBy(f, testFiles, r);
  if (byTest.length === 0) continue;
  found.push({ file: r, tests: byTest.map((t) => t.replace(/^tests\//, '')), lines: src.split('\n').length });
}
found.sort((a, b) => b.lines - a.lines);

if (REBASE) {
  console.log('已登记的 orphan 清单(复制进 ORPHAN_KNOWN):');
  for (const x of found) console.log(`  ['${x.file}', 'TODO: 写明为什么不接'],`);
  process.exit(0);
}

/* ── 自检 ── */
const stale: string[] = [];
for (const [rel, reason] of ORPHAN_KNOWN) {
  if (!existsSync(join(ROOT, rel))) { stale.push(`${rel}(文件不存在)`); continue; }
  if (!reason || reason.trim().length < 8) { stale.push(`${rel}(未写明理由)`); continue; }
  const abs = join(ROOT, rel);
  if (referencedBy(abs, prodFiles, rel).length > 0) stale.push(`${rel}(已可达,应移出)`);
}

const unlisted = found.filter((x) => !ORPHAN_KNOWN.has(x.file));
const totalLines = found.reduce((s, x) => s + x.lines, 0);

console.log('\n══ 生产零引用审计(测试专用模块)══\n');
console.log(`  生产文件 ${prodFiles.length} / 测试文件 ${testFiles.length}`);
console.log(`  实测 orphan:${found.length} 个 / ${totalLines} 行`);
console.log(`  已登记:${ORPHAN_KNOWN.size} 条\n`);

if (found.length > 0) {
  console.log('  模块                                                 行数  测试');
  for (const x of found) {
    const mark = ORPHAN_KNOWN.has(x.file) ? ' ' : '!';
    console.log(`  ${mark} ${x.file.padEnd(50)} ${String(x.lines).padStart(4)}  ${x.tests.join(',')}`);
  }
  console.log('\n  (! = 未登记)');
}

let failed = false;
if (stale.length > 0) {
  console.log(`\n  ✗ 登记清单失真(${stale.length} 处,应修正):`);
  for (const s of stale) console.log(`      ${s}`);
  failed = true;
}
if (unlisted.length > 0) {
  const msg = `新增未登记的生产零引用模块 ${unlisted.length} 个:${unlisted.map((x) => x.file).join(', ')}`;
  if (STRICT) { console.log(`\n  ✗ ${msg}`); failed = true; }
  else console.log(`\n  ⚠ ${msg}\n    (补白名单理由,或接线;--strict 下升级为失败)`);
}

if (!failed) {
  console.log(`\n  ✓ 生产零引用审计通过(${found.length} 个已登记 / 0 处失真)`);
}
console.log('');
process.exit(failed ? 1 : 0);