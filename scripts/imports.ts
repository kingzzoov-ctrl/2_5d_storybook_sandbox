/**
 * **相对导入提取器 —— 单一事实来源。**
 *
 * ## 为什么单独一个文件
 *
 * 同一段逻辑此前有**两份**(`verify.ts` 的 `extractRelativeImports` 与
 * `deadcode-audit.ts:172` 里的 `s.linker.matchAll(/from\s*['"]…/)`),
 * 而它们**口径不同** —— 后者只认 `from`,漏掉裸副作用导入与动态导入。
 *
 * **实测后果(现行真实缺陷,不是潜伏)**:
 * ```
 * server/src/sim/world_sim.ts:108   import '../wiring/components.ts';   ← 裸副作用
 * deadcode-audit 的 DFS 只认 from
 *   ⇒ wiring/components.ts **不在生产可达闭包内**
 *   ⇒ 它被报为「[真缺陷] 提供者用 registerComponentKind 注册了行为,但没有任何
 *      生产文件 import 它」
 *   ⇒ **而那句话是假的** —— world_sim.ts:108 就 import 了它
 * ```
 * ⇒ 这就是本仓反复吃过的「**两份实现**」(陷阱 31/41):两份口径必然漂移,
 *   而判据自己不会报警。
 *
 * ## 覆盖的形态(全部实测,真值表 17/17)
 *
 * ```
 * import { a } from './x.ts'           ✓ 静态 named
 * import './y.ts'                      ✓ 裸副作用
 * export { b } from './z.ts'           ✓ 再导出
 * export * from './w.ts'               ✓ 星再导出
 * await import('./dyn.ts')             ✓ 动态(2026-11-12 补)
 * import('./dyn2.ts').then(...)        ✓ 动态
 * await import(`./t.ts`)               ✓ 动态模板串
 * await import("./dq.ts")              ✓ 动态双引号
 * ```
 * **不认**(防误抓):
 * ```
 * import { c } from 'three'            ✗ 包名(非相对)
 * await import('colyseus')             ✗ 包名
 * import.meta.url / import.meta.main   ✗ 不是导入(`.` 不是 `(`)
 * await import(someVar)                ✗ 非字面量,不可静态解析
 * 字符串里的 "from './fake.ts'"        ✗ 幽灵依赖
 * 注释里的 // import './c.ts'          ✗ 幽灵依赖
 * ```
 *
 * ## 为什么不能用 `stripCommentsOnly` + 正则
 *
 * `stripCommentsOnly` **保留字符串内容** ⇒ 字符串里的 `from './x.ts'` 会被
 * 当成真依赖 ⇒ **幽灵依赖** ⇒ 模块被误判可达(方向相反的错误)。
 * 本函数逐字符扫描:跳过注释与字符串**内容**,只在代码态识别关键字。
 *
 * ⚠️ **不要与 `stripCommentsAndStrings` 混用** —— 那个**销毁**字符串内容,
 * 而路径就在字符串里。用它会得到 0 条(判据变恒真)。两者语义相反。
 */
export function extractRelativeImports(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  const isId = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    /* 注释:整段跳过 */
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    /* 字符串:整段跳过(否则字符串里的 `from './x.ts'` 会变成幽灵依赖) */
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) { i += 1; break; } i += 1; }
      continue;
    }
    /* 代码态标识符 */
    if (isId(c) && !isId(text[i - 1])) {
      let j = i;
      while (j < n && isId(text[j])) j += 1;
      const word = text.slice(i, j);
      if (word === 'import' || word === 'from') {
        let k = j;
        while (k < n && /\s/.test(text[k] as string)) k += 1;
        /* 动态 `import(...)`。`import.meta` 的下一字符是 `.`(既非 `(` 也非引号)
           ⇒ 天然不匹配,**无需特例**。 */
        if (text[k] === '(') {
          let m = k + 1;
          while (m < n && /\s/.test(text[m] as string)) m += 1;
          const dq = text[m];
          if (dq === "'" || dq === '"' || dq === '`') {
            let e = m + 1;
            let spec = '';
            while (e < n) {
              if (text[e] === '\\') { spec += text[e + 1]; e += 2; continue; }
              if (text[e] === dq) break;
              spec += text[e]; e += 1;
            }
            if (spec.startsWith('.')) out.push(spec);
            i = e + 1;
            continue;
          }
        }
        /* 静态:`import ... from '<spec>'` / `import '<spec>'` / `export ... from '<spec>'` */
        const q = text[k];
        if (q === "'" || q === '"') {
          let e = k + 1;
          let spec = '';
          while (e < n) {
            if (text[e] === '\\') { spec += text[e + 1]; e += 2; continue; }
            if (text[e] === q) break;
            spec += text[e]; e += 1;
          }
          if (spec.startsWith('.')) out.push(spec);
          i = e + 1;
          continue;
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}