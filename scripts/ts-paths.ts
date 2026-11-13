/**
 * ★ task-80:本仓**唯一正确的文件遍历器**。
 *
 * 起因(陷阱 110):我在排查器里写
 *     `const SKIP = new Set([..., 'dist', 'build']);`
 *   本意是跳过**构建产物**;而本仓有 `server/src/build/` 这个**源码目录**
 *   (WS-03 建造与房间识别:autotile / blueprint / grid / rooms / wiring_view)。
 *   ⇒ 遍历器**静默跳过 5 个生产文件**,分母从 88 变成 83。
 *   ⇒ 而后果不是"少扫了",是**假阳性**:
 *      它报 `boundaryLeak`「没有任何非零赋值 ⇒ 恒为初值」,
 *      而 `rooms.ts:285` 就有 `boundaryLeak = true;` —— 那个文件根本没被读。
 *
 * ★★★ 判据:一个"排除规则"会同时排除两件东西 ——
 *   你要排除的,和**与你排除目标同名的别的东西**。
 *   ⇒ 与陷阱 91「按名字匹配的清理规则两侧都错」是同族;
 *     这次受害的不是"删除",而是"扫描范围",而它**更隐蔽**:
 *     遍历器不会说"我跳过了 5 个文件",它只给你一个**小一点的**分母,
 *     而所有比例数看起来都正常。
 *
 * ## 三条硬规则(本文件的实现依据)
 *
 * ```
 * 1 产物目录的排除必须**锚定到仓库根**(dist / build 只在根才是产物),
 *   不能按裸目录名匹配
 * 2 遍历器**必须报告它排除了什么** —— 静默排除是危险的
 * 3 **分母必须与独立来源对账** —— 这是唯一发现该 bug 的方式
 *   (不是"再读一遍自己的代码",那样只会确认我写的就是我想写的)
 * ```
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 仓库根。 */
export const ROOT = process.cwd();

/** 只在**仓库根**才是产物的目录名(出现在 src/ 下面就是源码目录)。 */
const ROOT_ONLY_ARTIFACTS = new Set(['build', 'out', 'release', 'coverage']);

/** 任何深度都排除的目录(确定不含源码)。 */
const ALWAYS_EXCLUDE = new Set(['node_modules', '.git', '_design', '_shots', '_vss_restore']);

export interface WalkResult {
  /** 全部 .ts 文件(绝对路径) */
  files: string[];
  /** 被排除的目录(相对路径)+ 原因 ⇒ **供打印,不允许静默** */
  excluded: { path: string; why: string }[];
}

/**
 * 遍历 `.ts` 文件。
 * @param dir 起点(默认仓库根)
 */
export function walkTs(dir: string = ROOT): WalkResult {
  const files: string[] = [];
  const excluded: { path: string; why: string }[] = [];

  const rec = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = relative(ROOT, full).split(sep).join('/');
      if (!e.isDirectory()) {
        if (e.isFile() && e.name.endsWith('.ts')) files.push(full);
        continue;
      }
      if (ALWAYS_EXCLUDE.has(e.name)) { excluded.push({ path: rel, why: '确定不含源码' }); continue; }
      if (e.name.startsWith('.')) { excluded.push({ path: rel, why: '隐藏目录' }); continue; }
      /* ★ 关键:产物名**只有位于仓库根**时才排除 */
      if (ROOT_ONLY_ARTIFACTS.has(e.name) && rel === e.name) {
        excluded.push({ path: rel, why: '仓库根的产物目录(按路径锚定)' });
        continue;
      }
      if (ROOT_ONLY_ARTIFACTS.has(e.name) && rel !== e.name) {
        /* 出现在非根位置 ⇒ 当源码遍历。但**要报出来**,以便人确认这不是误判 */
        excluded.push({ path: rel, why: `★ 同名产物目录但**不在根**,已按源码遍历` });
      }
      rec(full);
    }
  };
  rec(dir);
  return { files, excluded };
}

/** 生产文件(server|client|shared 的 src 下)。 */
export function isProd(f: string): boolean {
  return /^(server|client|shared)\/src\//.test(relative(ROOT, f).split(sep).join('/'));
}

/** 相对路径(统一 `/`)。 */
export function relOf(f: string): string {
  return relative(ROOT, f).split(sep).join('/');
}

/* ── CLI:同时把"分母对账"做出来 ── */
if (process.argv[1]?.endsWith('ts-paths.ts')) {
  const { files, excluded } = walkTs();
  const prod = files.filter(isProd);
  const tests = files.filter((f) => /^tests\//.test(relOf(f)));
  const scripts = files.filter((f) => /^scripts\//.test(relOf(f)));

  console.log('══ 分母(本仓唯一权威遍历器)══');
  console.log(`   全部 .ts : ${files.length}`);
  console.log(`   生产     : ${prod.length}  (server/client/shared 的 src 下)`);
  console.log(`   tests/   : ${tests.length}`);
  console.log(`   scripts/ : ${scripts.length}`);

  console.log('\n══ 排除清单(**必须可见,不允许静默**)══');
  for (const e of excluded) console.log(`   · ${e.path}   ← ${e.why}`);

  console.log('\n══ 按一级目录分布(便于对账)══');
  const byTop = new Map<string, number>();
  for (const f of prod) {
    const top = relOf(f).split('/').slice(0, 3).join('/');
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  for (const [k, v] of [...byTop.entries()].sort()) console.log(`   ${k.padEnd(28)} ${v}`);

  console.log(`
\n★★ 判据:报任何"总数"时,若存在独立来源,必须对账。
   对不上就先查**分母**,别急着查结论。
   ⇒ 本文件的由来:我报了 83,队友的探针报了 98,差的就是被误跳的
     server/src/build/(5 个文件)加上统计口径差异。
   ⇒ 若不是"数对不上",我不会去查遍历器 —— 因为代码读起来完全正常。
`);
}

void statSync;