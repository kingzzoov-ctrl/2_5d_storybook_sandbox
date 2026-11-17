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

/** 一处动态 `import()` 的位置与它是否字面量。 */
export interface DynamicImportSite {
  /** 1-based 行号(数的是 `(` 所在行)。 */
  line: number;
  /** `true` = 说明符是字符串字面量(已跟踪);`false` = 变量/表达式(**不跟踪**)。 */
  literal: boolean;
}

/**
 * 找出源码里**所有**动态 `import(...)`,并标出说明符是不是字面量。
 *
 * ## 为什么需要它与 `extractRelativeImports` 并存
 *
 * `extractRelativeImports` 只产出**能跟踪的**边(字面量相对说明符)。
 * 于是"不跟踪"这种情形在门禁里**完全不可见** —— 它不是"0 命中",
 * 而是**根本没有这个词**。
 * `docs/RULINGS-DRAFT.md` §4.5 已裁定把「动态 `import()` 不跟踪」**正式接受**
 * (影响=零),但接受的前提是**它每次都被打印出来**,而不是靠"没人再提"。
 * ⇒ 本函数提供计数口径:字面量几处(已跟踪)/ 非字面量几处(已接受边界)。
 *
 * ## 覆盖与不覆盖(与 `extractRelativeImports` 完全一致)
 *
 * ```
 * await import('./dyn.ts')   ⇒ 字面量 ✓
 * await import(`./t.ts`)     ⇒ 字面量 ✓
 * await import(name)         ⇒ 非字面量(本函数的目的)
 * import.meta.url / .main    ⇒ 不是导入(`.` 不是 `(`)⇒ 不算
 * 注释/字符串里的 import(    ⇒ 不算(逐字符扫描,跳过注释与字符串)
 * ```
 *
 * ⚠️ 模板串里的 `${...}` 整段跳过 ⇒ 其中若嵌 `import(x)` 会漏。
 *   这是**已知且刻意的边界**(与 `stripCommentsAndStrings` 同一取舍):
 *   宁可漏报嵌套在模板串里的代码,也不要因误解析把后面的代码吞进字符串。
 */
export function findDynamicImports(text: string): DynamicImportSite[] {
  const n = text.length;
  const lineStarts: number[] = [0];
  for (let i = 0; i < n; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const isId = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  const out: DynamicImportSite[] = [];
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (isId(c) && !isId(text[i - 1])) {
      let j = i;
      while (j < n && isId(text[j])) j += 1;
      if (text.slice(i, j) === 'import') {
        let k = j;
        while (k < n && /\s/.test(text[k] as string)) k += 1;
        if (text[k] === '(') {
          let m = k + 1;
          while (m < n && /\s/.test(text[m] as string)) m += 1;
          const dq = text[m];
          /* ⚠️ **空实参 `import()` 一律不算**(实测踩到的伪命中):
             本仓有**消息文本**里写着 `import()` 字样的断言(如
             `tests/WS-FND-01.test.ts` 的「以动态 import() 引用 baseline.ts」),
             而扫描器遇到**正则字面量里的引号**(`/import\(\s*['"]…/`)时会把
             引号当成字符串起止 ⇒ 字符串状态错位 ⇒ 紧随其后的那句 `'…import()…'`
             被当成**代码态**。`import()` 空实参在 TS 里本来就不合法,
             所以这条过滤**不会漏掉任何真导入**,只挡掉状态错位的伪命中。
             ★ 记下它而不是悄悄加:这是本文件第二个"引号状态会被正则骗到"的实例,
               真修法是给扫描器加正则字面量识别(牵动 `extractRelativeImports`),
               不属本次范围。 */
          if (dq !== ')') out.push({ line: lineOf(k), literal: dq === "'" || dq === '"' || dq === '`' });
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}