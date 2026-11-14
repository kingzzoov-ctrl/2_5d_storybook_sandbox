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
 * 本文件是唯一事实源;7 个判据一律 `import { SKIP_DIRS, ... }`。
 * ⇒ 新增一个"不该被审计"的目录时,**改这一个文件**即可,不可能再出现 6/7 缺。
 */

import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

/**
 * 遍历时要**整棵跳过**的目录名。
 *
 * 判据:进入这些目录得到的东西**不是本仓的审计对象**。逐一说明理由 ——
 * 「不解释就跳过」会让下一个人不知道该不该加东西进来:
 *
 * - `node_modules`  依赖树,不是本仓代码
 * - `.git`          版本库内部
 * - `dist` / `build` 构建产物(可由源码重建,**审计源码才有意义**)
 * - `_design`       设计参考目录(**保留,不删不改**,只读留档)
 * - `_shots`        截图留档(同上)
 * - `_vss_restore`  2026-11-13 误删事故后从 VSS 卷影副本抢救的 188 个外部文件
 *                   (44.3 MB,**非本仓产物**)—— 当时就是因为"按名字匹配"被误判成残留
 * - `_probe_sandbox` ★ 2026-11-14 加:队友做**隔离实验**时拷的整仓副本。
 *                   它的内容**与 HEAD 同源** ⇒ 扫它等于把 HEAD 的问题
 *                   报成"本轮新增"(实测:BOM 假红 3 个)。
 *                   ⇒ 判据:凡是**仓库的副本**(而非本仓内容),都不该被审计 ——
 *                     因为对它的任何结论都**不是关于本仓的结论**。
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '_design',
  '_shots',
  '_vss_restore',
  '_probe_sandbox',
]);

/** 遍历时是否应跳过这个目录项。以 `.` 开头的隐藏目录一律跳过(`.git`/`.dsh` 等)。 */
export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

/**
 * 统一遍历仓库 —— 只产出**本仓审计对象**内的文件。
 *
 * ★ 用它的理由(而不各写一份 walk):各写一份是上面那个 6/7 缺的直接成因。
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

  const rec = (dir: string): void => {
    let ents: string[] = [];
    try { ents = readdirSync(dir); } catch { return; }
    for (const n of ents) {
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (shouldSkipDir(n)) continue;
        rec(abs);
        continue;
      }
      if (exts.length > 0 && !exts.some((e) => n.endsWith(e))) continue;
      out.push(useRel ? relative(root, abs).split('\\').join('/') : abs);
    }
  };
  for (const s of starts) rec(s);
  return out;
}
