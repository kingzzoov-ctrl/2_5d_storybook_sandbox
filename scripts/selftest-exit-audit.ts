/**
 * ★ task-77:本仓「自检脚本的退出码」普查。
 *
 * 动因:我刚建的 `scripts/count-audit.ts` 有 `--selftest`,但**从不设退出码** ——
 * 即:它的 selftest 红了,进程仍 exit 0 ⇒ 谁在 CI 里跑它都看不见。
 * ⇒ 这正是本仓已登记的**陷阱 79「恒报 0 的工具比没有工具更危险」**
 *   与**陷阱 82「不拦门禁的自检脚本,它的红没有代价」**。
 * ⇒ 我一边记录这两条,一边造了一个新的 ⇒ 先普查,别只修自己那一个。
 *
 * 判据(可机械化):
 *   有 `--selftest` / 自检语义 的脚本,必须满足:
 *     a 存在某个路径会设非零退出码(process.exitCode = 1 / process.exit(1))
 *     b 且该路径**由断言结果驱动**(不是只由参数驱动)
 *   只有 a ⇒ 可能是"参数校验失败即退出",与自检结果无关(仍是摆设)
 *
 * ⚠️ 本脚本只出**清单**,不判红:
 *   「该脚本是否应当阻塞」要求推断意图(陷阱:分水岭)⇒ 不在门禁范围。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'scripts');
const files = existsSync(ROOT)
  ? readdirSync(ROOT).filter((f) => f.endsWith('.ts')).sort()
  : [];

interface Info {
  name: string;
  hasSelftest: boolean;
  setsExit: boolean;
  /** 退出码是否被断言结果驱动:找 `failures`/`failed`/`不能` 附近的 exitCode */
  drivenByAssert: boolean;
  lines: number;
  exitStyle: string;
}

const infos: Info[] = [];
for (const f of files) {
  const p = join(ROOT, f);
  const src = readFileSync(p, 'utf8');
  const hasSelftest = /--selftest/.test(src);
  /* ★ 第一版这里写的是 `/process\.exit(Code)?\s*=/` —— 只认赋值形态。
     实测漏掉了 `process.exit(selfFail > 0 ? 1 : 0)`(judgement_audit.ts:1717)
     ⇒ 把一个有退出码的脚本误报成"从不设退出码"。
     ⇒ 这是本仓反复出现的同一类错:**检测器的判据比它要检的东西窄**
       (陷阱 95「范围偷换」的同族:我写了 `exitCode =`,却当成"设退出码"的全部形态)。
     修法:两种形态都认 —— 赋值 `process.exitCode =` 与调用 `process.exit(`。 */
  const setsExitCodeAssign = /process\.exitCode\s*=/.test(src);
  const setsExitCall = /process\.exit\s*\(/.test(src);
  const setsExit = setsExitCodeAssign || setsExitCall;
  /* 断言驱动:失败计数出现在 `process.exit*(...)` 的参数里,或 if(失败) 里设退出码。
     ⚠️ 这仍是**启发式** —— 判据要求"这一句是否由断言结果驱动"需读语义。
        故结论里必须标注哪些是启发式判定(见下方输出)。 */
  const drivenByAssert = /process\.exit\s*\([^)]*(fail|bad|wrong|errors?|未通过|失败)/i.test(src)
    || /process\.exitCode\s*=\s*[^;\n]*(fail|bad|errors?|未通过|失败)/i.test(src)
    || /if\s*\([^)]*(fail|bad|wrong|errors?|未通过|失败)[^)]*\)\s*[^{]*\{?[^}]{0,160}process\.exit/is.test(src);
  infos.push({
    name: f, hasSelftest, setsExit, drivenByAssert, lines: src.split('\n').length,
    exitStyle: setsExitCall && setsExitCodeAssign ? 'both' : (setsExitCall ? 'exit()' : 'exitCode='),
  });
}

console.log('══ 普查:scripts/*.ts 的自检与退出码 ══');
console.log('   文件                                行数  selftest  设退出码  断言驱动');
for (const i of infos) {
  const flag = !i.setsExit
    ? '★ 无'
    : (i.drivenByAssert ? '✓ 是' : '? 仅参数');
  console.log(`   ${i.name.padEnd(34)} ${String(i.lines).padStart(4)}  `
    + `${(i.hasSelftest ? '有' : '--').padEnd(8)}  `
    + `${(i.setsExit ? '设' : '★未设').padEnd(8)}  ${flag}`);
}

console.log('\n══ 判定 ══');
const withSelfNoExit = infos.filter((i) => i.hasSelftest && !i.setsExit);
console.log(`   有 --selftest 的: ${infos.filter((i) => i.hasSelftest).length} 个`);
console.log(`   ★ 其中有 selftest 但**从不设退出码**的: ${withSelfNoExit.length} 个`);
for (const i of withSelfNoExit) {
  console.log(`      ★ ${i.name} —— 它的 selftest 红了,进程仍 exit 0`);
}
console.log(`
   ⇒ 这一类的危害形态(陷阱 79):
     一个自检脚本若**永远 exit 0**,它的输出就只是一段散文;
     把它接进任何流水线都不会红 ⇒ **比没有这个脚本更危险**,
     因为"有一个 selftest"这件事本身会让人以为覆盖到了。
`);

console.log('══ 附:有自检但退出码只由参数驱动(仍在"摆设"边缘)══');
const paramOnly = infos.filter((i) => i.setsExit && !i.drivenByAssert && i.lines > 200);
if (paramOnly.length === 0) console.log('   (无)');
for (const i of paramOnly) {
  console.log(`   ? ${i.name}(${i.lines} 行)—— 设了退出码,但没看出它由断言结果驱动`);
  console.log('     ⚠️ 这个判断是**启发式**(正则),可能误报;需人工看那一处代码');
}

console.log('\n══ 本普查自身的方法学说明 ══');
console.log(`
   · 三条判据都是**句法**的(有无第二个 flag 的存在、有无退出码赋值),
     所以结论**确定**:「没有退出码赋值」这句话不会错。
   · 但「该不该有」需要推断意图 ⇒ **只出清单,不判红**。
     (本仓分水岭:判据是否要求推断意图?要求 ⇒ 清单;不要求 ⇒ 可门禁)
   · ★ 因而本脚本**故意不设非零退出码** ——
     否则就与它所批评的对象同形。它是一份**报告**,不是一道门禁。
`);