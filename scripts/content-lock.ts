/**
 * 内容基线锁工具。
 *
 * 用法:
 *   node scripts/content-lock.ts             # 比对当前内容与基线(CI/验证用,有差异则退出 1)
 *   node scripts/content-lock.ts --update    # 重新生成基线(有意扩展后执行)
 *   node scripts/content-lock.ts --capacity  # 打印容量报表与扩展可用空间
 *   node scripts/content-lock.ts --audit     # 引用闭合与一致性审计
 *
 * 为什么是独立脚本而不是塞进 verify.ts:
 * 验证器要同时管冻结层、文档、集成、测试;内容锁是**内容专责**,
 * 且它有一个「写文件」的动作(--update),不适合藏在只读验证流程里。
 * verify.ts 只调用它的只读比对模式。
 */

import {
  buildBaseline,
  readBaseline,
  writeBaseline,
  diffBaseline,
  defaultBaselinePath,
} from '../server/src/content/baseline.ts';
import {
  contentFingerprints,
  contentFingerprintLine,
  idSegments,
  freeIdSegments,
  freeIdCount,
  capacityReport,
  auditContent,
} from '../server/src/content/registry.ts';

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(`--${f}`);

/* 着色:非 TTY、或设了 NO_COLOR 时一律不输出转义码。
   否则重定向到文件/管道时会把 \x1b[32m 当普通字符写进去,污染日志。 */
const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  g: wrap('32'),
  r: wrap('31'),
  y: wrap('33'),
  d: wrap('2'),
};

/* ── --capacity ── */
if (has('capacity')) {
  console.log('══ 内容容量账本 ══\n');
  console.log(capacityReport());

  console.log('\n\n══ ID 区间登记(手册章节 ↔ 号段)══\n');
  for (const s of idSegments()) {
    const slack = s.slackInside > 0 ? c.y(`留白 ${s.slackInside}`) : c.d('紧包');
    console.log(`  [${String(s.from).padStart(3)}~${String(s.to).padStart(3)}]  用 ${String(s.used).padStart(3)}  ${slack}   ${s.note.split(';')[1] ?? ''}`);
  }

  const free = freeIdSegments();
  const between = free.filter((s) => s.to < 746);
  console.log('\n\n══ 扩展可用空间 ══\n');
  console.log(`  分表之间的空档(${between.length} 段,只列 ≥8 连续号):`);
  for (const s of between) {
    console.log(`    [${String(s.from).padStart(4)}~${String(s.to).padStart(4)}]  ${String(s.to - s.from + 1).padStart(4)} 号`);
  }
  const betweenTotal = between.reduce((n, s) => n + (s.to - s.from + 1), 0);
  const above = free.filter((s) => s.from >= 746).reduce((n, s) => n + (s.to - s.from + 1), 0);
  console.log(`    小计 ${betweenTotal} 号`);
  console.log(`  746 以上未分配区:${above} 号`);
  /* 精确总数用 freeIdCount():上面的求和会漏掉 <8 的短段(如 219~220) */
  const exact = freeIdCount();
  console.log(`\n  ${c.g(`合计可用 ${exact} 号`)} / OBJ 层共 4095 号`);
  if (exact !== betweenTotal + above) {
    console.log(
      `  ${c.d(`(列表小计 ${betweenTotal + above} 号,另有 ${exact - betweenTotal - above} 个零散短空隙未列出)`)}`,
    );
  }
  process.exit(0);
}

/* ── --audit ── */
if (has('audit')) {
  const audit = auditContent();
  console.log('══ 内容一致性审计 ══\n');
  console.log(`  指纹 v${audit.fingerprint.version} · ${audit.fingerprint.overall}`);
  const obj = audit.capacity.find((c) => c.space.includes('OBJ'));
  console.log(
    `  物品 ${obj?.used} · 生物 ${audit.capacity[2].used} · Boss ${audit.capacity[3].used}` +
      ` · 可用号 ${obj?.freeCount}`,
  );
  console.log(`\n  引用闭合(生物掉落/驯养物、Boss 召唤物/战利品):`);
  if (audit.problems.length === 0) console.log(`    ${c.g('✓ 全部指向存在的物品 ID')}`);
  else for (const p of audit.problems) console.log(`    ${c.r('✗')} ${p}`);
  if (audit.notes.length > 0) {
    console.log('\n  提示:');
    for (const n of audit.notes) console.log(`    ${c.y('·')} ${n}`);
  }
  process.exit(audit.ok ? 0 : 1);
}

/* ── --update ── */
if (has('update')) {
  const before = readBaseline();
  const after = buildBaseline();
  writeBaseline(after);
  console.log('══ 内容基线已重新生成 ══\n');
  console.log(`  文件     : ${defaultBaselinePath()}`);
  console.log(`  指纹     : ${before ? `${before.fingerprints.overall} → ` : ''}${after.fingerprints.overall}`);
  console.log(`  物品     : ${after.counts.items}`);
  console.log(`  生物/Boss: ${after.counts.mobs} / ${after.counts.bosses}`);
  if (before) {
    const drift = diffBaseline(before);
    if (drift.changes.length > 0) {
      console.log(`\n  ${c.y('本次内容变更:')}`);
      for (const ch of drift.changes) console.log(`    · ${ch}`);
      if (drift.slotShifts.length > 0) {
        console.log(`\n  ${c.r('⚠ 存在槽位平移,需确认存档兼容性')}`);
        for (const s of drift.slotShifts.slice(0, 10)) console.log(`    ${c.r('!')} ${s}`);
        if (drift.slotShifts.length > 10) console.log(`    ${c.d(`… 另有 ${drift.slotShifts.length - 10} 项`)}`);
      }
      console.log(`\n  ${c.y('请在 docs/CHANGE_REQUESTS.md 登记这次内容扩展。')}`);
    } else {
      console.log(`\n  ${c.g('内容与旧基线一致,基线仅刷新了格式。')}`);
    }
  }
  process.exit(0);
}

/* ── 默认:比对 ── */
const baseline = readBaseline();
const drift = diffBaseline(baseline);

console.log('══ 内容基线锁 ══\n');
console.log(`  基线文件 : ${defaultBaselinePath()}`);
console.log(`  当前指纹 : ${contentFingerprintLine()}`);

if (!drift.present) {
  console.log(`\n  ${c.r('✗ 基线文件缺失')}`);
  console.log(`  执行 ${c.y('node scripts/content-lock.ts --update')} 生成初始基线。`);
  console.log(`  ${c.d('注意:缺失基线不算通过 —— 无法判断内容是否被改动过。')}`);
  process.exit(1);
}

if (drift.inSync) {
  console.log(`  基线指纹 : ${baseline!.fingerprints.overall}`);
  console.log(`\n  ${c.g('✓ 内容与基线一致')}`);
  console.log(`    ${c.d('物品')} ${baseline!.counts.items}  ${c.d('生物')} ${baseline!.counts.mobs}  ${c.d('Boss')} ${baseline!.counts.bosses}`);
  process.exit(0);
}

console.log(`  基线指纹 : ${baseline!.fingerprints.overall}`);
console.log(`\n  ${c.y('⚠ 内容与基线不一致,共 ' + drift.changes.length + ' 项差异')}\n`);
for (const ch of drift.changes) console.log(`    · ${ch}`);

if (drift.slotShifts.length > 0) {
  console.log(`\n  ${c.r('⚠ 槽位平移 ' + drift.slotShifts.length + ' 项(最高风险)')}`);
  for (const s of drift.slotShifts.slice(0, 12)) console.log(`    ${c.r('!')} ${s}`);
  if (drift.slotShifts.length > 12) console.log(`    ${c.d(`… 另有 ${drift.slotShifts.length - 12} 项`)}`);
  console.log(`\n  ${c.d('背包格位 = ITEM_LIST 数组下标。非末尾插入会让其后全部物品平移;')}`);
  console.log(`  ${c.d('若槽位已被持久化,旧存档背包将整体错位且不会报错。建议改为按 ID 取槽位。')}`);
}

console.log(`\n  若这是有意扩展:${c.y('node scripts/content-lock.ts --update')}`);
console.log(`  并在 ${c.y('docs/CHANGE_REQUESTS.md')} 登记。`);
process.exit(1);
