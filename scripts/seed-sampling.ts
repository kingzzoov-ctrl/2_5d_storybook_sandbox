/**
 * ★★★ task-78:比例数的**正确采样与误差报告**。
 *
 * 起因(实测,见 docs/PROGRESS.md 陷阱 107):
 *   本仓每个探针都写 `for (let s = 1; s <= N; s++) gen(lcg(s), ...)`,
 *   然后用 `sqrt(p(1-p)/N)` 报 ±SE。而实测:
 *
 *     · 指示序列 lag-1 自相关 rho = **0.42**(n=40000)
 *     · 设计效应 deff = 1 + 2Σrho ≈ **6.9**(自相关法)
 *     · 直接测(分块)deff = **8.9 ~ 30.7**(依块长)
 *     · 对照:把种子先 hash 打散,deff = **0.83**(正常)
 *     · 两法的**点估计同值**(43.94% vs 43.37%)⇒ **无偏,只是误差条虚高**
 *
 *   机制:`generateOrderBoard` 只消耗 **4~8** 次 `rng()`;
 *     而 `lcg(s)` 的首输出 = (1664525·s + 1013904223) mod 2^32 / 2^32
 *     ⇒ 相邻种子的**首输出差恒为 1664525/2^32 ≈ 0.000388**
 *     ⇒ 凡由首输出决定的量(槽位数)**相邻种子 100% 相同**(实测)
 *     ⇒ 于是"连续整数种子"不是独立样本,而是**分段相关**的序列。
 *
 * 本文件提供两件东西:
 *   1 `sampleProportion()` —— 同时给出 iid 误差与**分块误差**,并算 deff
 *   2 `hashSeed()` —— 把种子打散,使样本近似独立
 *   3 `--selftest` —— 用**已知答案**的合成序列证明本工具的分块误差是对的
 */

/** 把整数种子搅匀(用于消除"连续整数喂 LCG"引入的相关性)。 */
export function hashSeed(s: number): number {
  let x = (s ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** 本仓探针惯用的 LCG(与既有探针一致,便于对照历史数字)。 */
export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

export interface SampleResult {
  /** 有效样本数(排除被跳过的) */
  n: number;
  /** 点估计 */
  p: number;
  /** iid 假设下的标准误(**会偏小**) */
  seIid: number;
  /** 分块标准误(**推荐使用**) */
  seBlock: number;
  /** 设计效应 = seBlock² / seIid²(≈1 表示样本近似独立) */
  deff: number;
  /** 分块数 */
  blocks: number;
  /** 95% 区间(用 seBlock) */
  ci95: [number, number];
  /** 是否检测到显著相关性(deff 偏离 1 太多) */
  correlated: boolean;
}

/**
 * 采样一个 0/1 指标,并**同时**给出 iid 误差与分块误差。
 *
 * @param n        尝试的种子数
 * @param indicator `(seed) => 1|0|null`(null 表示该种子无效,不计入分母)
 * @param opts.seeds 种子生成方式:
 *        `'sequential'` = 1..n(**本仓旧探针的做法,有相关性**)
 *        `'hashed'`     = hashSeed(1..n)(推荐)
 * @param opts.blocks 分块数(默认 40)
 */
export function sampleProportion(
  n: number,
  indicator: (seed: number) => number | null,
  opts: { seeds?: 'sequential' | 'hashed'; blocks?: number } = {},
): SampleResult {
  const mode = opts.seeds ?? 'hashed';
  const blocks = opts.blocks ?? 40;

  const vals: number[] = [];
  /* ★ 这里原来写的是 `const blockMeans: number[][] = [[]]` ——
   *   即以一个**空块**初始化。后面虽然用 `.filter(b => b.length > 0)` 滤掉,
   *   但那个 `[[]]` 是"**先造一个坏值再过滤**"的写法:
   *     一旦将来有人把 filter 去掉(看起来只是清理),就会多出一个 0 长的块。
   *   ⇒ 改成空数组起步:坏值不产生,就不必依赖"后面有人滤掉它"。
   *   ⇒ 判据:**不要制造需要下游纠正的值** —— 那种纠正迟早会被当成冗余删掉。 */
  const blockBufs: number[][] = [];
  let acc: number[] = [];
  const perBlock = Math.max(1, Math.floor(n / blocks));

  for (let i = 1; i <= n; i += 1) {
    const s = mode === 'hashed' ? hashSeed(i) : i;
    const v = indicator(s);
    if (v === null) continue;
    vals.push(v);
    acc.push(v);
    if (acc.length >= perBlock) { blockBufs.push(acc); acc = []; }
  }
  if (acc.length > 0) blockBufs.push(acc);

  /* ★ 分母守卫:空集上的一切统计恒 0,而 0 最像一个"好消息"。
     故这里**显式抛错**而不是返回 0 —— 让"分母是 0"无法被误读成"误差是 0"。 */
  if (vals.length === 0) {
    throw new Error('sampleProportion: 有效样本数 = 0 ⇒ 无法给出任何统计量'
      + '(空集上的比例与误差都是无意义的 0,不要把它当结论)');
  }

  const p = vals.reduce((a, b) => a + b, 0) / vals.length;
  const seIid = Math.sqrt(p * (1 - p) / vals.length);

  const real = blockBufs;
  let seBlock = seIid;
  if (real.length >= 2) {
    const means = real.map((b) => b.reduce((a, c) => a + c, 0) / b.length);
    const mb = means.reduce((a, b) => a + b, 0) / means.length;
    /* 块均值的方差 / 块数 = 整体均值的方差估计 */
    const vMean = means.reduce((a, b) => a + (b - mb) ** 2, 0) / (means.length - 1);
    seBlock = Math.sqrt(vMean / means.length);
  }
  const deff = seIid > 0 ? (seBlock / seIid) ** 2 : 1;
  return {
    n: vals.length, p, seIid, seBlock, deff, blocks: real.length,
    ci95: [p - 1.96 * seBlock, p + 1.96 * seBlock],
    correlated: deff > 2,
  };
}

/** 便于打印的一行式。 */
export function fmt(r: SampleResult, label = ''): string {
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  return `${label.padEnd(22)} ${pct(r.p).padStart(7)}  `
    + `±${(r.seBlock * 100).toFixed(2)} (分块) / ±${(r.seIid * 100).toFixed(2)} (iid)  `
    + `deff=${r.deff.toFixed(2)}${r.correlated ? ' ★相关' : ''}  n=${r.n}`;
}

/* ─────────────────────── selftest ─────────────────────── */
if (process.argv.includes('--selftest')) {
  console.log('══ selftest:用**已知答案**的合成序列验证本工具 ══');
  let bad = 0;
  const assert = (ok: boolean, msg: string): void => {
    console.log(`   ${ok ? '✓' : '★'} ${msg}`);
    if (!ok) bad += 1;
  };

  /* 1 真 iid 序列 ⇒ deff 应 ≈ 1,且 p 应 ≈ 0.5 */
  {
    let x = 12345 >>> 0;
    const rnd = (): number => { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967296; };
    const which = rnd();
    const r = sampleProportion(20000, () => (rnd() < 0.5 ? 1 : 0), { seeds: 'sequential' });
    void which;
    console.log(`   [1] 真 iid:p=${(r.p * 100).toFixed(2)}% deff=${r.deff.toFixed(2)}`);
    assert(Math.abs(r.p - 0.5) < 0.02, `p 接近 0.5(得 ${(r.p * 100).toFixed(2)}%)`);
    assert(r.deff < 3, `deff < 3(得 ${r.deff.toFixed(2)})⇒ 对真 iid 不误报相关 ★★ 关键`);
  }

  /* 2 强自相关序列(块结构)⇒ deff 必须显著 > 1
   * ★ 第一版这里是错的:我写了个"看起来有块结构"的生成器
   *   (`(s*2654435761)>>>0` 再 `%2`),实测 deff=**0.21** ⇒ 它没有块结构。
   *   而断言写成 `deff > 1.5 || !r.correlated` ⇒ **恒真,永远通过**
   *   ⇒ 这是我的**阳性对照失效**:一个"看起来在测相关性"的用例,实际什么都没测。
   *   (与陷阱 100「11/11 通过不代表覆盖了 11 件事」同型)
   * 修法:块结构必须**真的**按块赋值 —— 块内恒定、块间更换。
   * 并用 SE 的**下界**做硬断言:块内完全相关时 deff 应 ≈ 块长。 */
  {
    const BLOCK = 200;
    let flip = 0;
    const r = sampleProportion(20000, (s) => {
      if (s % BLOCK === 1) flip = hashSeed(Math.floor(s / BLOCK)) % 2;
      return flip;
    }, { seeds: 'sequential', blocks: 40 });
    console.log(`   [2] 真块结构(块长 ${BLOCK}):p=${(r.p * 100).toFixed(2)}% deff=${r.deff.toFixed(2)}`);
    assert(r.deff > 3, `对**真**块结构给出 deff=${r.deff.toFixed(2)} > 3`
      + ' ⇒ 阳性对照成立(工具能检出真相关)');
  }

  /* 3 ★ 最关键:空集必须**抛错**,而不是返回 0 */
  {
    let threw = false;
    try { sampleProportion(100, () => null); } catch { threw = true; }
    assert(threw, '分母为 0 时**抛错**(不返回无意义的 0)★★ 这是本仓反复吃过亏的地方');
  }

  /* 4 hashSeed 是否真的打散:相邻输出应无关 */
  {
    const a: number[] = [];
    for (let s = 1; s <= 4000; s += 1) a.push(hashSeed(s) % 2);
    const p = a.reduce((x, y) => x + y, 0) / a.length;
    let num = 0;
    for (let i = 0; i + 1 < a.length; i += 1) num += (a[i]! - p) * (a[i + 1]! - p);
    const rho = num / (a.length - 1) / (p * (1 - p));
    console.log(`   [4] hashSeed 低位 lag-1 rho = ${rho.toFixed(4)}`);
    assert(Math.abs(rho) < 0.05, `|rho| < 0.05(得 ${rho.toFixed(4)})⇒ 打散有效`);
  }

  /* 5 ★ 自证:对同一指标,sequential 与 hashed 的**点估计应一致**(无偏),
       而 **deff 应不同**(sequential 更大) —— 这正是本工具存在的理由 */
  {
    const ind = (s: number): number => {
      /* 一个真实的、低消耗的伪随机指标(模拟 gen 只用几次 rng) */
      const l = lcg(s);
      return l() + l() + l() + l() > 2 ? 1 : 0;
    };
    const seqR = sampleProportion(20000, ind, { seeds: 'sequential' });
    const hashR = sampleProportion(20000, ind, { seeds: 'hashed' });
    console.log(`   [5] 同一指标: sequential p=${(seqR.p * 100).toFixed(2)}% deff=${seqR.deff.toFixed(2)}`
      + `  |  hashed p=${(hashR.p * 100).toFixed(2)}% deff=${hashR.deff.toFixed(2)}`);
    assert(Math.abs(seqR.p - hashR.p) < 0.03, '两种取法的**点估计一致** ⇒ 无偏(只是误差条不同)');
    assert(seqR.deff > hashR.deff, `sequential 的 deff 更大 ⇒ 工具能检出本仓的真问题`);
  }

  console.log(`\n   ⇒ ${bad === 0 ? '✓ 全部通过' : `★ ${bad} 项失败`}`);
  if (bad > 0) process.exitCode = 1;
}
