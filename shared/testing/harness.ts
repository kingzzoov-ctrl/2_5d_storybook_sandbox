/**
 * 零依赖测试桩。
 *
 * 设计约束(全仓库强制):
 *  - Node 24 原生类型擦除运行 `.ts`,因此相对导入必须写全扩展名 `.ts`;
 *  - 禁止 `enum` / 参数属性 / 装饰器元数据等「不可擦除语法」;
 *  - 每个测试文件是一个可直接 `node tests/xxx.test.ts` 跑起来的独立脚本。
 */

export interface TestResult {
  name: string;
  ok: boolean;
  msg?: string;
}

export const results: TestResult[] = [];

export function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}

export function ok(cond: unknown, msg = '断言失败:期望为真'): void {
  if (!cond) throw new Error(msg);
}

/**
 * 结构化等价比较(见 `docs/CHANGE_REQUESTS.md` [CR-1])。
 *
 * 为什么不能直接用 `!==`:`eq([1,2,4,8], [1,2,4,8])` 在引用比较下必然失败,
 * 而报错会把两侧打印成同一段文本,看上去像环境故障而非断言失败。
 * 逐位比较比引用比较**更严格**,因此不存在「把真失败改成通过」的风险。
 */
function deepEqual(a: unknown, b: unknown, seen: Set<unknown>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  /* 循环引用防护:同一对对象重复进入即认为结构一致 */
  if (seen.has(a) || seen.has(b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    seen.add(a);
    seen.add(b);
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i], seen)) return false;
    }
    seen.delete(a);
    seen.delete(b);
    return true;
  }

  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map)) return false;
    if (a.size !== b.size) return false;
    seen.add(a);
    seen.add(b);
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k), seen)) return false;
    }
    seen.delete(a);
    seen.delete(b);
    return true;
  }

  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set)) return false;
    if (a.size !== b.size) return false;
    seen.add(a);
    seen.add(b);
    for (const v of a) {
      let hit = false;
      for (const w of b) {
        if (deepEqual(v, w, seen)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
    seen.delete(a);
    seen.delete(b);
    return true;
  }

  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  seen.add(a);
  seen.add(b);
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen)) return false;
  }
  seen.delete(a);
  seen.delete(b);
  return true;
}

/** 结构化打印:数组逐位展开,避免「两侧看起来一样」。 */
function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Set) return `Set(${v.size})`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${show(x)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return String(v);
}

/** 找出第一个不相等的路径,报错时指到具体位置。 */
function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= a.length) return `${path}[${i}] 仅存在于期望值(${show(b[i])})`;
      if (i >= b.length) return `${path}[${i}] 仅存在于实际值(${show(a[i])})`;
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      const va = (a as Record<string, unknown>)[k];
      const vb = (b as Record<string, unknown>)[k];
      if (!Object.prototype.hasOwnProperty.call(a as object, k)) return `${path}.${k} 仅存在于期望值(${show(vb)})`;
      if (!Object.prototype.hasOwnProperty.call(b as object, k)) return `${path}.${k} 仅存在于实际值(${show(va)})`;
      const d = firstDiff(va, vb, `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return `${path}:期望 ${show(b)} / 实际 ${show(a)}`;
}

/**
 * 断言相等。
 *
 * 原始类型走 `Object.is`(于是 `NaN` 与 `NaN` 相等、`+0` 与 `-0` 不等);
 * 数组/对象/Map/Set 走**结构化逐位比较**(CR-1)。
 * 报错信息会指出**首个不相等的位置**,避免「两侧看起来一样」的误导。
 */
export function eq<T>(actual: T, expected: T, msg = ''): void {
  if (deepEqual(actual, expected, new Set())) return;
  const where = firstDiff(actual, expected) ?? '';
  /* firstDiff 对原始类型返回 `$:期望 x / 实际 y`,剥掉 `$:` 前缀;结构化路径保留 */
  const detail = where.startsWith('$:') ? where.slice(2) : where.replace(/^\$\.?/, '');
  throw new Error(`${msg} ${detail}`.trim());
}

export function near(actual: number, expected: number, eps = 1e-6, msg = ''): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${msg} 期望 ${expected}(±${eps}) / 实际 ${actual}`.trim());
  }
}

export function includes<T>(arr: readonly T[], v: T, msg = ''): void {
  if (!arr.includes(v)) throw new Error(`${msg} 数组中未找到 ${String(v)}`.trim());
}

export function inRange(v: number, lo: number, hi: number, msg = ''): void {
  if (!(v >= lo && v <= hi)) throw new Error(`${msg} 期望区间 [${lo}, ${hi}] / 实际 ${v}`.trim());
}

/** 稳定伪随机(Mulberry32),让「随机 Roll」类断言可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 打印本模块结果并返回失败数(调用方据此设置 process.exitCode)。 */
export function report(moduleName: string): number {
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.error(`  ✗ [${moduleName}] ${r.name} — ${r.msg ?? ''}`);
  console.log(`[${moduleName}] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
  return failed.length;
}
