/**
 * ★★★ 扫描范围的**唯一事实源** —— 所有"遍历仓库"的判据都必须从这里取跳过规则。
 *
 * ## 为什么要有这个文件(不是"整洁性",是修一类**反复复发**的缺陷)
 *
 * 实测(2026-11-14):仓库根多了一个 `_probe_sandbox/`(队友做隔离实验时拷的
 * **整仓副本**,142 个文件 / 4.5 MB)。它立刻让门禁报红:
 * ```
 * ✗ 发现本轮新增的 BOM(它会让 JSON.parse 抛错 ⇒ 门禁会红在无关处):
 *      ★ _probe_sandbox/server/src/mobs/aoi.ts
 *      ★ _probe_sandbox/server/src/mobs/geometry.ts
 *      ★ _probe_sandbox/server/src/mobs/taming.ts
 * ```
 * ⇒ 那三个 BOM **不是本轮新增的**,它们是**副本里 HEAD 本来就有的**那 3 个,
 *   因为 `bom-guard.ts` 的 `SKIP_DIRS` **没有** `_probe_sandbox`
 *   ⇒ 它把副本当成了本仓 ⇒ **假红**。
 *
 * ## 更根本的问题:跳过规则**散落在 7 个文件里,各写一份**
 *
 * ```
 * 实测(同一轮):含 `_vss_restore` 的脚本有 7 个,而其中**只有 1 个**同时含 `_probe_sandbox`:
 *     bom-guard.ts        ★缺
 *     clean-temp.ts       ✓有
 *     dup-export-audit.ts ★缺
 *     eol-audit.ts        ★缺
 *     gate-selfcheck.ts   ★缺
 *     ts-paths.ts         ★缺
 *     verify.ts           ★缺
 * ⇒ 6 / 7 缺。而 `clean-temp.ts` 的注释里**早就写着**:
 *     「与 verify.ts 的 checkTempResidue 保持**同一份规则** ——
 *       改一处要改两处(CR-20 的形态)」
 *   ⇒ 那条注释把"两处"当成上限,实际是**七处**。
 *     且它把问题描述成"**记得改两处**"(靠纪律),而不是"**让第二处不存在**"(靠结构)。
 * ```
 * ★ 这正是本仓陷阱 129 的同一形态:**我在写"专门用来防这件事"的东西时,自己犯了这件事** ——
 *   注释点名了重复的代价,却**没有消除重复**。
 *
 * ## 处置
 *
 * 本文件是唯一事实源;7 个判据一律 `import { ... }`。
 * ⇒ 新增一个"不该被审计"的目录时,**改这一个文件**即可,不可能再出现 6/7 缺。
 *
 * ## ★★ 2026-11-14(接手者)第二件事:跳过名分**两类**,因为它们的作用域不同
 *
 * ```
 * BUILD_OUTPUT_DIRS  只在**遍历起点那一层**跳过  ← 构建 / 测试产物
 * NON_REPO_DIRS      **任何层**都跳过          ← 内容根本不是本仓的审计对象
 * ```
 *
 * 详见 `BUILD_OUTPUT_DIRS` 上方那段长注释(陷阱 110 的第 4 次复发:整棵
 * `server/src/build/` 被静默漏掉 ⇒ 生产文件数算成 93,权威值 98)。
 */

import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

/**
 * 遍历时要**整棵跳过**的目录名 —— 但**作用域不同**,故分两类。
 *
 * 判据:进入这些目录得到的东西**不是本仓的审计对象**。逐一说明理由 ——
 * 「不解释就跳过」会让下一个人不知道该不该加东西进来:
 *
 * - `node_modules`  依赖树,不是本仓代码
 * - `.git`          版本库内部
 * - `dist` / `build` 构建产物(可由源码重建,**审计源码才有意义**)—— 仅根层
 * - `_design`       设计参考目录(**保留,不删不改**,只读留档)
 * - `_shots`        截图留档(同上)
 * - `_vss_restore`  2026-11-13 误删事故后从 VSS 卷影副本抢救的 188 个外部文件
 *                   (44.3 MB,**非本仓产物**)—— 当时就是因为"按名字匹配"被误判成残留
 * - `_probe_sandbox` ★ 2026-11-14 加:队友做**隔离实验**时拷的整仓副本。
 *                   它的内容**与 HEAD 同源** ⇒ 扫它等于把 HEAD 的问题
 *                   报成"本轮新增"(实测:BOM 假红 3 个)。
 *                   ⇒ 判据:凡是**仓库的副本**(而非本仓内容),都不该被审计 ——
 *                     因为对它的任何结论都**不是关于本仓的结论**。
 * - `out` / `_cdp_profile` ★ 2026-11-14(接手者补):这两条此前**只存在于局部跳过表**里
 *                   —— `out` 在 `verify.ts:1790`,`_cdp_profile` 在 `verify.ts:3986`。
 *                   实测两者在仓库根**均不存在**;把它们搬进唯一事实源是为了让那两处
 *                   局部表可以**整段删掉**,而各判据看到的范围**逐条不变**。
 *                   ⇒ 判据:归并范围时,**新增条目必须能归入既有的一类**
 *                     (out→构建产物;_cdp_profile→`_` 开头的非本仓资产),
 *                     而不是"顺手多跳过一个目录" —— 后者是**放宽门禁**,说不出理由。
 */

/*
 * ────────────────────────────────────────────────────────────────────────────
 * ★★★ 两类跳过名,作用域不同 —— 这是 2026-11-14 修的根因
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 陷阱 110 的**第 4 次复发**(实测证据,不是推断):
 *
 * ```
 * 本仓有一整棵**生产源码树**叫 `server/src/build/`,5 个 .ts:
 *     autotile.ts / blueprint.ts / grid.ts / rooms.ts / wiring_view.ts
 * ⇒ 若把 `build` 当成"任何层都跳过的产物目录":
 *   实测 `walkRepo(root, ['.ts'])` 过滤 `^(server|client|shared)/` 得 **93**,
 *   而 `ts-paths.ts` 与 `git ls-files` 的权威值是 **98**
 *   ⇒ 整棵 `server/src/build/` 被**静默漏掉**(93 vs 98,差 5)。
 * ⇒ 这正是陷阱 110 的原话:"我的排除清单里有 'build' ——
 *   而本仓有一整棵生产源码树叫 server/src/build/"。
 * ```
 *
 * ⇒ `gate-selfcheck.ts:670-687` **早已**把这条写成注释纪律:
 *   「只在根层跳过 build/dist/out,子层一律当源码」。
 *   但**纪律写在注释里 = 每个新判据都要重犯一次**(实测已复发 4 次)。
 * ⇒ 故本轮把它变成**类型**:两类分开,`shouldSkipDirAtDepth()` 是唯一入口,
 *   `walkRepo()` 默认就走深度感知口径 ⇒ 「写错」比「写对」更难。
 * ★ 判据:反复复发 3 次以上的纪律,应当从"注释里的提醒"升级为"类型/API 上的唯一入口"。
 */

/** 构建 / 测试产物:可由源码重建 ⇒ 审计源码才有意义。**只在遍历起点那一层跳过**。 */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  /* 后两个来自 `gate-selfcheck.ts:692` 的根层正则(同一类,一并归位,避免第二份清单)。 */
  'coverage',
  'release',
]);

/** 无论在哪一层,内容都**不是本仓审计对象**。 */
export const NON_REPO_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '_design',
  '_shots',
  /* `_cdp_profile` = 浏览器调试用 profile 目录,与 `_design` / `_shots` **同一类**
     (`_` 开头的非本仓资产)。此前只写在 `verify.ts:3986` 与 `clean-temp.ts:75` 的局部表里。 */
  '_cdp_profile',
  '_vss_restore',
  '_probe_sandbox',
]);

/** 全部要跳过的目录名(= 上面两类的并集)。消费方一般不该直接用这个集合,请用下面的函数。 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ...BUILD_OUTPUT_DIRS,
  ...NON_REPO_DIRS,
]);

/** 任何层都跳过的那些(**不含**构建产物类)。`depth > 0` 时用它。 */
export function shouldSkipDirAnyDepth(name: string): boolean {
  return NON_REPO_DIRS.has(name) || name.startsWith('.');
}

/**
 * **任何层**口径 —— 以 `.` 开头的隐藏目录一律跳过(`.git`/`.dsh`/`.baseline` 等)。
 *
 * ⚠️ 这是 `SKIP_DIRS` 的全集口径。**对"根层收窄"的判据请用 `shouldSkipDirAtDepth()`** ——
 *    直接用这个函数会把 `server/src/build/` 一起跳掉(93 vs 98 那个缺陷)。
 */
export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

/**
 * ★ 深度感知口径 —— 与 `shouldSkipDir()` 的**唯一**差别是:
 *   构建产物类(`dist` / `build` / `out` / `coverage` / `release`)**只在 depth 0 跳过**。
 *
 * 论据:`server/src/build/` 是生产源码(5 个 .ts),`depth > 0` 时**必须进**。
 * 作者原话见 `gate-selfcheck.ts:670-687` 与 `ts-paths.ts` 的
 * 「server/src/build ← 同名产物目录但**不在根**,已按源码遍历」。
 *
 * @param depth 相对**遍历起点**的层数:起点下的直接子项是 0。
 */
export function shouldSkipDirAtDepth(name: string, depth: number): boolean {
  return depth === 0 ? shouldSkipDir(name) : shouldSkipDirAnyDepth(name);
}

/**
 * 统一遍历仓库 —— 只产出**本仓审计对象**内的文件。
 *
 * ★ 用它的理由(而不各写一份 walk):各写一份是上面那个 6/7 缺的直接成因。
 * ★ 它默认走**深度感知**口径(`shouldSkipDirAtDepth`):`dist` / `build` 只在根层跳,
 *   子层一律当源码。⇒ 消费方**不需要**自己再判一次深度(那是第二份清单的开始)。
 *
 * @param root  起点绝对路径(通常 `process.cwd()`)
 * @param exts  扩展名白名单,如 `['.ts']` 或 `['.md']`
 * @param opts.subdirs 只在给定子目录里走(如 `['server/src', 'client/src', 'shared']`)
 * @param opts.relative 返回相对 `root` 的 `/` 分隔路径(默认 true)
 */
export function walkRepo(
  root: string,
  exts: readonly string[],
  opts: { subdirs?: readonly string[]; relative?: boolean } = {},
): string[] {
  const useRel = opts.relative !== false;
  const out: string[] = [];
  const starts = opts.subdirs && opts.subdirs.length > 0
    ? opts.subdirs.map((s) => join(root, s))
    : [root];

  const rec = (dir: string, depth: number): void => {
    let ents: string[] = [];
    try { ents = readdirSync(dir); } catch { return; }
    for (const n of ents) {
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (shouldSkipDirAtDepth(n, depth)) continue;
        rec(abs, depth + 1);
        continue;
      }
      if (exts.length > 0 && !exts.some((e) => n.endsWith(e))) continue;
      out.push(useRel ? relative(root, abs).split('\\').join('/') : abs);
    }
  };
  for (const s of starts) rec(s, 0);
  return out;
}
