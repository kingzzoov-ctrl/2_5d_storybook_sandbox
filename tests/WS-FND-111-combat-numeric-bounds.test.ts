/**
 * WS-FND-111 —— 第四轮审计:战斗数值层的五处 P2(判据 + 负对照 + 注入说明)。
 *
 * | # | 判据 | 修的是什么 | 改坏哪里会红(注入点) |
 * | :--- | :--- | :--- | :--- |
 * | 1 | `ELEMENT_COUNTER` 只允许四档值 `{1.0, 1.5, 0.75, 0.5}` | 修前 `ICE→SLIME = 1.25` 是全表唯一的第五档值 | 把 1.25 写回 `weapons.ts` 的 `ICE:` 行(`:75`) |
 * | 2 | **反克对互反**:`X→Y = 1.5 ⟺ Y→X = 0.75`(双向) | 修前 `SLIME→LIGHTNING = 0.5` 与 `LIGHTNING→SLIME = 1.5` 不成对 | 同上 / 把 `SLIME→LIGHTNING` 改回 0.5 |
 * | 3 | 同属性 `0.5`;`NONE` 行/列全 `1.0`;`elementMul` 逐格等于表 | 表与取值函数两份口径 | 让 `elementMul` 自己算一份 |
 * | 4 | 每个元素(除 `NONE`)至少一侧可达;`LIGHT` **不再是**「只作攻击方无目标」 | 修前 `SLIME→LIGHT = 1.0` ⇒ 星光列全是 1.0 | 把 `SLIME→LIGHT` 改回 1.0(`weapons.ts:78` 那行末段) |
 * | 5 | 死元素登记与 `WEAPONS` **双向**对齐(`ICE` 无产出方) | 修前 `ICE` 行/列是不可达死键,但没人登记 | 往 `WEAPONS` 塞一把 ICE 武器 |
 * | 6 | `vitals.heal` 有限性门:NaN / ±Infinity 拒绝且不污染 hp | 修前 `Math.max(0, NaN) = NaN` ⇒ hp **永久** NaN | 删掉 `vitals.ts` 的 `if (!Number.isFinite(amount)) return 0;` |
 * | 7 | `gainExp` 入口拒非有限:NaN 不再一口气升到满级 | 修前 `exp < need` 恒 false ⇒ Lv.1 + NaN ⇒ Lv.30 | 删掉 `progression.ts` 的非有限分支 |
 * | 8 | 铲子词条池每条都有消费者(`dodge_rate` / `knockback_mul` 已移除) | 修前 606/607 的铲子词条是静默 no-op | 把 `knockback_mul` 加回池尾 |
 * | 9 | `hpFlat` 不叠加(602 × 3 ⇒ 30),单份值逐字透传 | 修前 `602 × N ⇒ +30N` 无封顶 | 把 `mergeFoodBuffs` 的 `Math.max` 改回 `+=` |
 * | 10 | 倒地泡泡连击窗口:任意间隔的第 3 发不再「续杯」 | 修前层数只 `+1`、无衰减路径 | 删掉 `tickGhostBubble` 里的窗口过期分支 |
 * | 11 | `createTarget` 的 `shieldMax` 派生(修前两行同条件 if 只剩一行) | 重复死分支 | 把显式 `shieldMax` 的优先级反过来 |
 *
 * ## 判据 1~5 的自洽检查器是**本文件自己的**(不复用实现)
 *
 * `matrixViolations()` 按注释里的四条规则**独立**重算一遍,再拿修前的三格错误值
 * (1.25 / 0.5 / 1.0)构造「坏矩阵」断言它**报错**。若把检查器写成「读实现的常量核实现」,
 * 注入时它会跟着一起漂 —— 那是同义反复,不是判据。
 *
 * ## 断言右侧一律用**字面量**(2026-11-18 第四轮收口)
 *
 * 修前 `eq(ba, ELEMENT_REVERSE_MUL)` / `eq(h3.downed.invulnSec, BUBBLE_TRAP_SEC)` 这类写法
 * 把**被测模块的导出常量**放在 expected 一侧 ⇒ 命中的是「同义反复候选」(改常量两边一起变)。
 * 现已全改成字面量(0.75 / 1.5 / 5),模块常量只出现在 **actual 一侧**当锚点
 * (`eq(BUBBLE_TRAP_SEC, 5)` / `elementMul(...)`),候选数 **3 → 0**。
 *
 * ## 运行
 *
 * `node tests/WS-FND-111-combat-numeric-bounds.test.ts`
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { BodyState } from '../shared/types/physics.ts';
import { MAX_LEVEL, expToNext } from '../shared/types/entities.ts';
import {
  DEAD_ELEMENTS,
  ELEMENTS,
  ELEMENT_COUNTER,
  ELEMENT_COUNTER_MUL,
  ELEMENT_MATRIX_VALUES,
  ELEMENT_NEUTRAL_MUL,
  ELEMENT_REVERSE_MUL,
  ELEMENT_SELF_MUL,
  WEAPONS,
  elementMul,
} from '../server/src/combat/weapons.ts';
import { VitalsSystem } from '../server/src/combat/vitals.ts';
import { createProgress, gainExp } from '../server/src/combat/progression.ts';
import {
  COMBAT_KEYWORD_POOL,
  FOOD_BY_ID,
  SOUP_NORMAL_RECIPE,
  cookSoup,
  foodBuffFrom,
  mergeFoodBuffs,
  type FoodBuff,
} from '../server/src/combat/cooking.ts';
import {
  BUBBLE_GUN_SHOTS,
  BUBBLE_STACK_WINDOW_SEC,
  BUBBLE_TRAP_SEC,
  bubbleGunHit,
  createDowned,
  tickGhostBubble,
  type DownedState,
  type EquipmentSnapshot,
} from '../server/src/combat/revive.ts';
import { createTarget } from '../server/src/combat/damage.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FND111_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 剥注释后只留**代码** —— 结构判据必须只看代码:说明里会引用被修的写法(本仓惯例)。
 * 逐字符扫(不用正则),故 `https://` 之类的行注释误伤不存在。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? src.length : j + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** 抽某段实现体(签名 → endMarker)并剥注释;锚点漂移必须抛错(否则判据静默恒真)。 */
function codeOf(rel: string, signature: string, endMarker: string): string {
  const src = readFileSync(join(FND111_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`找不到锚点 \`${signature}\`(漂移即本判据失效)`);
  const end = src.indexOf(endMarker, i);
  if (end < 0) throw new Error(`\`${signature}\` 之后找不到 ${JSON.stringify(endMarker)}`);
  return stripComments(src.slice(i, end + endMarker.length));
}

/* ═════════════════ 独立检查器:矩阵自洽的四条规则 ═════════════════ */

type Matrix = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * 按注释里的四条规则**独立**检查一张矩阵(空数组 = 自洽)。
 * 刻意**不**读实现的任何判定函数:否则「用实现核实现」,注入时两边一起漂。
 */
function matrixViolations(m: Matrix): string[] {
  const out: string[] = [];
  const allowed: readonly number[] = ELEMENT_MATRIX_VALUES;

  /* 规则 3:取值只有登记的四档 */
  for (const a of ELEMENTS) {
    for (const b of ELEMENTS) {
      const v = m[a]?.[b];
      if (typeof v !== 'number' || !allowed.includes(v)) out.push(`值越界 ${a}→${b} = ${String(v)}`);
    }
  }
  /* 规则 2:反克对互反(双向) */
  for (const a of ELEMENTS) {
    for (const b of ELEMENTS) {
      if (a === b) continue;
      const ab = m[a][b];
      const ba = m[b][a];
      if (ab === ELEMENT_COUNTER_MUL && ba !== ELEMENT_REVERSE_MUL) out.push(`反克对不互反:${a}→${b}=1.5 而 ${b}→${a}=${ba}`);
      if (ab === ELEMENT_REVERSE_MUL && ba !== ELEMENT_COUNTER_MUL) out.push(`反克对不互反:${a}→${b}=0.75 而 ${b}→${a}=${ba}`);
    }
  }
  /* 规则 3':同属性 0.5;NONE 行/列全中性 */
  for (const a of ELEMENTS) {
    if (a !== 'NONE' && m[a][a] !== ELEMENT_SELF_MUL) out.push(`同属性 ${a}→${a} = ${m[a][a]}(应 0.5)`);
    if (m['NONE'][a] !== ELEMENT_NEUTRAL_MUL) out.push(`NONE 行 ${a} = ${m['NONE'][a]}`);
    if (m[a]['NONE'] !== ELEMENT_NEUTRAL_MUL) out.push(`NONE 列 ${a} = ${m[a]['NONE']}`);
  }
  /* 规则 4:除 NONE 外每个元素至少一侧可达 */
  for (const a of ELEMENTS) {
    if (a === 'NONE') continue;
    let reachable = false;
    for (const b of ELEMENTS) {
      if (b === a) continue;
      if (m[a][b] === ELEMENT_COUNTER_MUL || m[b][a] === ELEMENT_COUNTER_MUL) reachable = true;
    }
    if (!reachable) out.push(`元素 ${a} 两侧都不可达`);
  }
  return out;
}

/** 复制当前矩阵并改一格(负对照用)。 */
function withCell(row: string, col: string, value: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of ELEMENTS) out[a] = { ...ELEMENT_COUNTER[a] };
  out[row][col] = value;
  return out;
}

const MATRIX: Matrix = ELEMENT_COUNTER as unknown as Matrix;

/* ═════════════════ 1. 矩阵取值只有四档 ═════════════════ */

test('FND111-1 克制矩阵只允许四档值(1.0 / 1.5 / 0.75 / 0.5),6×6 全覆盖', () => {
  eq(ELEMENT_MATRIX_VALUES, [1.0, 1.5, 0.75, 0.5], '登记的四档值(字面量)');
  eq(ELEMENTS.length, 6, '元素表 6 项');
  eq(Object.keys(ELEMENT_COUNTER).length, ELEMENTS.length, '矩阵行数 = 元素表项数(两份声明必须一致)');
  eq(matrixViolations(MATRIX), [], '当前矩阵必须零违规');

  /* 负对照:修前那格 1.25 会被检查器逐条抓住 */
  const buggy = withCell('ICE', 'SLIME', 1.25);
  const hits = matrixViolations(buggy);
  ok(hits.length >= 2, `修前形态至少违反两条(值越界 + 反克对不互反),实测 ${hits.length} 条`);
  ok(hits.some((h) => h.includes('值越界 ICE→SLIME')), '报出「1.25 不在允许的四档里」');
});

/* ═════════════════ 2. 反克对互反(双向) ═════════════════ */

test('FND111-2 反克对必须互反:1.5 ⟺ 反向 0.75,全表零例外', () => {
  let counterPairs = 0;
  for (const a of ELEMENTS) {
    for (const b of ELEMENTS) {
      if (a === b) continue;
      const ab = elementMul(a, b);
      const ba = elementMul(b, a);
      if (ab === ELEMENT_COUNTER_MUL) {
        counterPairs += 1;
        eq(ba, 0.75, `${a}→${b}=1.5 ⇒ ${b}→${a} 必须 0.75(字面量,不读被测常量)`);
      }
      if (ab === ELEMENT_REVERSE_MUL) eq(ba, 1.5, `${a}→${b}=0.75 ⇒ ${b}→${a} 必须 1.5(字面量,不读被测常量)`);
    }
  }
  eq(counterPairs, 6, '全表恰好 6 条克制关系(四元环 4 + 星光克胶质 + 霜冻克胶质)');

  /* 负对照:`SLIME→LIGHTNING = 0.5` 是修前那对不成对的值 */
  const buggy = withCell('SLIME', 'LIGHTNING', 0.5);
  ok(
    matrixViolations(buggy).some((h) => h.includes('SLIME→LIGHTNING=0.5')),
    '修前的 0.5 必须被检查器点名',
  );
  eq(elementMul('SLIME', 'LIGHTNING'), 0.75, '★ 现值 0.75(与 LIGHTNING→SLIME=1.5 成对)');
});

/* ═════════════════ 3. 同属性 / NONE / 取值函数单点 ═════════════════ */

test('FND111-3 同属性 0.5、NONE 全中性,且 elementMul 与表逐格同值', () => {
  for (const a of ELEMENTS) {
    if (a === 'NONE') continue;
    eq(elementMul(a, a), 0.5, `${a} 同属性互抗 0.5`);
    eq(elementMul('NONE', a), 1.0, `NONE 打 ${a} 无克制`);
    eq(elementMul(a, 'NONE'), 1.0, `${a} 打 NONE 无克制`);
  }
  /* 取值函数不是第二份真值:逐格与表相同 */
  for (const a of ELEMENTS) for (const b of ELEMENTS) eq(elementMul(a, b), ELEMENT_COUNTER[a][b], `elementMul(${a}, ${b}) 必须等于表里的格子`);
});

/* ═════════════════ 4. 每个元素至少一侧可达;LIGHT 不再是「无目标」 ═════════════════ */

test('FND111-4 每个元素至少一侧可达;星光**不再是**只作攻击方无目标', () => {
  for (const a of ELEMENTS) {
    if (a === 'NONE') continue;
    let reachable = false;
    for (const b of ELEMENTS) {
      if (b === a) continue;
      if (elementMul(a, b) === 1.5 || elementMul(b, a) === 1.5) reachable = true;
    }
    ok(reachable, `元素 ${a} 必须至少出现在一条克制关系里`);
  }
  /* ★ 修前 LIGHT 的**列**全是 1.0(除自身 0.5)⇒「只作攻击方、没有任何目标」。
     现在 SLIME→LIGHT = 0.75:有人打星光会吃亏,星光的列不再是空的。 */
  const lightColumn = ELEMENTS.filter((a) => a !== 'LIGHT' && elementMul(a, 'LIGHT') !== 1.0);
  eq(lightColumn, ['SLIME'], '★ 星光列的非中性项 = 胶质(0.75),修前为空');
  eq(elementMul('SLIME', 'LIGHT'), 0.75, '★ 现值 0.75');

  const buggy = withCell('SLIME', 'LIGHT', 1.0);
  ok(matrixViolations(buggy).length > 0, '修前的 1.0 必须被检查器判违规(LIGHT 两侧都不可达)');
});

/* ═════════════════ 5. 死元素登记双向 ═════════════════ */

test('FND111-5 死元素登记与 WEAPONS 双向对齐(ICE 无产出方)', () => {
  const produced = new Set<string>(WEAPONS.map((w) => w.element));
  const unproduced = ELEMENTS.filter((e) => e !== 'NONE' && !produced.has(e));
  eq(unproduced, ['ICE'], '由内容表派生的「无攻击方」元素集合');

  /* 两个方向都判:漏登记 / 腾笼后没撤登记,各红一半 */
  eq(DEAD_ELEMENTS.map((d) => d.element), unproduced, '登记表 ⇔ 派生集合逐项一致');
  for (const d of DEAD_ELEMENTS) eq(d.kind, 'NO_ATTACKER', `${d.element} 的登记类型`);
  for (const e of produced) {
    ok(!DEAD_ELEMENTS.some((d) => d.element === e), `${e} 有产出方,不得登记成死元素`);
  }
  ok(DEAD_ELEMENTS.length > 0, 'ICE 的死键事实必须被登记(而不是靠读者自己发现)');
});

/* ═════════════════ 6. vitals.heal 有限性门 ═════════════════ */

test('FND111-6 vitals.heal:NaN / ±Infinity 拒绝且不污染 hp', () => {
  const v = new VitalsSystem(120);
  const p = v.register('p1');
  eq(v.applyDamage('p1', 30).applied, 30, '前置:先掉 30 血');
  eq(p.hp, 90, '前置:hp = 90');

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    eq(v.heal('p1', bad), 0, `heal(${String(bad)}) 必须被拒(返回 0)`);
    eq(p.hp, 90, `heal(${String(bad)}) 不得改动 hp`);
    ok(Number.isFinite(p.hp), `heal(${String(bad)}) 之后 hp 仍是有限数`);
    ok(Number.isFinite(p.iframeSec), '无敌计时也没被污染');
  }
  eq(v.heal('p1', -5), 0, '负值治不了(返回 0,hp 不变)');
  eq(p.hp, 90, '负值之后 hp 仍不变');

  eq(v.heal('p1', 10), 10, '正对照:合法治疗照常生效');
  eq(p.hp, 100, '正对照:hp 90 → 100');
  eq(v.heal('p1', 1e9), 20, '正对照:超量治疗被上限钳住(120 − 100)');
  eq(p.hp, 120, '正对照:不超过上限');

  /* ★ 负对照(结构):这条门的牙在 `vitals.ts::heal` 的**代码**里 ——
     删掉那一行有限性守卫本判据就红。替代了修前那两条
     `Math.max(0, NaN) === NaN` 的纯 JS 恒真断言(它们一次也没碰被测模块)。 */
  const healBody = codeOf('server/src/combat/vitals.ts', 'heal(id: string, amount: number): number {', '\n  }\n');
  ok(/if \(!Number\.isFinite\(amount\)\)\s*return 0;/.test(healBody),
    '★ heal 必须先做有限性门(删掉它 NaN 会把 hp 永久污染成 NaN)');
  ok(healBody.indexOf('Number.isFinite') < healBody.indexOf('v.hp ='),
    '有限性门必须排在**写 hp 之前**(排在写后等于没门)');
  /* ★ 注入:把守卫那一行删掉 ⇒ 上面两条判据必须同时为假(证明它们不是恒真) */
  const healInjected = healBody.replace(/if \(!Number\.isFinite\(amount\)\)\s*return 0;/, '');
  ok(!/Number\.isFinite/.test(healInjected), '负对照:删掉守卫后判据必须为假');
});

/* ═════════════════ 7. gainExp 入口拒非有限 ═════════════════ */

test('FND111-7 gainExp:NaN / ±Infinity 不再一口气升到满级', () => {
  const p = createProgress('Ninja');
  eq(p.level, 1, '前置:Lv.1');

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const r = gainExp(p, bad);
    eq(r.progress.level, 1, `gainExp(${String(bad)}) 不得升级`);
    eq(r.progress.exp, 0, 'exp 未变');
    eq(r.progress.totalExp, 0, 'totalExp 未变');
    eq(r.levelUps.length, 0, '不得产生升级事件');
    eq(r.gained, 0, 'gained = 0');
    eq(r.animation.play, false, '不播放升级动画');
    ok(r.progress === p, '档案原样回传(同一引用,一字不动)');
  }

  /* ★ 负对照(结构):修前的循环(`exp = NaN` + 出口 `exp < need`)会顶到满级 ——
     这条断言打在 `progression.ts::gainExp` 的**代码**上:删掉非有限分支就红。
     (替代了修前那个不碰模块的本地 while 循环 + `Math.max(0, NaN)` 恒真断言。) */
  const gainBody = codeOf('server/src/combat/progression.ts', 'export function gainExp(', '\n}\n');
  ok(/if \(!Number\.isFinite\(amount\)\)/.test(gainBody),
    '★ gainExp 必须先拒非有限(删掉它 NaN 会一口气升到 Lv.30)');
  ok(gainBody.indexOf('Number.isFinite') < gainBody.indexOf('while (level < MAX_LEVEL)'),
    '非有限门必须排在升级循环**之前**');
  const gainInjected = gainBody.replace(/if \(!Number\.isFinite\(amount\)\)/, 'if (false)');
  ok(!/Number\.isFinite/.test(gainInjected), '负对照:去掉非有限门后判据必须为假(证明它不是恒真)');

  /* 正对照:闸不是「什么都拒」—— 合法经验照样升级,0 经验不升级 */
  eq(gainExp(createProgress('Grinder'), 449500).progress.level, MAX_LEVEL, '合法大额经验仍可满级');
  const one = gainExp(createProgress('Small'), expToNext(1));
  eq(one.progress.level, 2, '恰好一级所需经验 ⇒ 升到 Lv.2');
  eq(gainExp(createProgress('Zero'), 0).levelUps.length, 0, '0 经验不升级');
});

/* ═════════════════ 8. 铲子词条池的消费者 ═════════════════ */

test('FND111-8 铲子词条池:每条都有消费者(dodge_rate / knockback_mul 已移除)', () => {
  eq(COMBAT_KEYWORD_POOL.length, 5, '池缩到 5 条(全部有 statMods 消费者)');
  for (const dead of ['dodge_rate', 'knockback_mul']) {
    ok(!COMBAT_KEYWORD_POOL.includes(dead), `${dead} 不得回到池里:全仓零读取 ⇒ 静默空词条`);
  }

  /* 修前 7 条池下 607 恒拿 `knockback_mul` 的**本地数组模拟**已删除 ——
     它不碰被测模块(恒真槽位)。下面是**行为**负对照:每道能出锅的料理,
     铲子词条都必须真的改变至少一格 statMods(607 也只许走这条路)。 */

  /* 行为判据:经 506 能出锅的每道料理,铲子词条都必须**真的改变**至少一格 statMods。 */
  const reachable: Array<[number, Record<number, number>]> = [
    [604, { ...SOUP_NORMAL_RECIPE }],
    [607, { 126: 2 }],
    [608, { 127: 1 }],
    [609, { 119: 2 }],
    [610, { 125: 2 }],
    [611, { 124: 3 }],
  ];
  for (const [id, inputs] of reachable) {
    const plain = cookSoup({ inputs });
    const shoveled = cookSoup({ inputs, shovelUsed: true });
    eq(plain.ok, true, `${id} 前提:正常出锅`);
    eq(plain.itemId, id, `前提:出锅的是 ${id}`);
    eq(plain.bonusKeywords.length, 0, `${id} 不用铲子无额外词条`);
    eq(shoveled.bonusKeywords.length, 1, `${id} 用铲子 +1 条`);
    const kw = shoveled.bonusKeywords[0];
    ok(!['dodge_rate', 'knockback_mul'].includes(kw), `${id} 的铲子词条 ${kw} 必须有消费者`);
    const before = plain.buff!.statMods as unknown as Record<string, number>;
    const after = shoveled.buff!.statMods as unknown as Record<string, number>;
    let changed = 0;
    for (const k of Object.keys(before)) if (before[k] !== after[k]) changed += 1;
    ok(changed >= 1, `★ ${id} 的铲子词条 ${kw} 必须真的改变 statMods(修前 607 是 no-op)`);
    ok(shoveled.buff!.flags[`kw_${kw}`] !== undefined, `kw_${kw} 仍照旧记账`);
  }
});

/* ═════════════════ 9. hpFlat 不叠加 ═════════════════ */

test('FND111-9 hpFlat 不再线性叠加(602 × 3 ⇒ 30),单份值仍逐字透传', () => {
  const cake = FOOD_BY_ID.get(602)!;
  eq(cake.statMods.hpFlat, 30, '602 庆典蛋糕的 hpFlat = 30(手册字面量)');

  const one = mergeFoodBuffs([foodBuffFrom(cake)]);
  eq(one.hpFlat, 30, '一份 602 ⇒ +30');
  const three = mergeFoodBuffs([foodBuffFrom(cake), foodBuffFrom(cake), foodBuffFrom(cake)]);
  eq(three.hpFlat, 30, '★ 三份 602 ⇒ 仍是 30(修前 90,无封顶)');

  /* 负对照:修前的纯相加形态 —— 用**模块算出的单份值**乘份数(不是字面量乘法,
     模块若把单份值改坏,这条会跟着红)。 */
  ok(one.hpFlat * 3 === 90, '修前(纯相加)= 单份值 × 3 份 = 90');
  ok(three.hpFlat < 90, '叠加真的被挡住了');

  /* 既有契约保护:单份 40 必须**逐字**透传(WS-FND-17 FND17-3 的「原样透传」)。 */
  const wide: FoodBuff = { ...foodBuffFrom(cake), statMods: { ...one, hpFlat: 40 } };
  eq(mergeFoodBuffs([wide]).hpFlat, 40, '单份 40 ⇒ 40(不许把「不叠加」写成「钳到 30」)');
  eq(mergeFoodBuffs([wide, foodBuffFrom(cake)]).hpFlat, 40, '两份取强者 = 40,不是 70');
});

/* ═════════════════ 10. 倒地泡泡连击窗口 ═════════════════ */

test('FND111-10 倒地泡泡连击窗口:任意间隔的第 3 发不再「续杯」', () => {
  eq(BUBBLE_GUN_SHOTS, 3, '需连中 3 发');
  eq(BUBBLE_TRAP_SEC, 5, '困住 5 秒');
  eq(BUBBLE_STACK_WINDOW_SEC, 5, '窗口 = 困住时长 = 5s(字面量锚;与 live_bubble 同口径,不新增数值)');

  const progress = createProgress('BubbleTarget');
  const EQUIP: EquipmentSnapshot = { weapon: null, armor: null, helm: null, boots: null, relic: null, cape: null };

  /* ——— 正对照:5 秒窗口内连中 3 发 ⇒ 困住 5 秒 ——— */
  let d: DownedState = createDowned(progress, EQUIP, 0, 0);
  eq(d.bubbleStacks, 0, '起手 0 层');
  const h1 = bubbleGunHit(d);
  eq(h1.downed.bubbleStacks, 1, '第 1 发 1 层');
  d = tickGhostBubble(h1.downed, 1.0).downed;
  eq(d.bubbleStacks, 1, '窗口内漂 1s:层数保留');
  eq(d.bubbleSinceHitSec, 1, '窗口计时 +1s');
  const h2 = bubbleGunHit(d);
  eq(h2.downed.bubbleStacks, 2, '第 2 发 2 层');
  eq(h2.downed.bubbleSinceHitSec, 0, '★ 每次命中把窗口重置为 0(按最后一次命中算)');
  d = tickGhostBubble(h2.downed, 1.0).downed;
  const h3 = bubbleGunHit(d);
  eq(h3.trapped, true, '★ 窗口内连中 3 发仍能困住');
  eq(h3.downed.state, BodyState.BUBBLED, '状态 = BUBBLED');
  eq(h3.downed.invulnSec, 5, '困住计时 = 5 秒(字面量)');
  eq(h3.downed.bubbleStacks, 0, '困住后层数归零');
  const reopen = bubbleGunHit(h3.downed);
  eq(reopen.downed.bubbleStacks, 1, '困住后再打:从 0 重新累计');
  eq(reopen.downed.invulnSec, 5, '单发不改写困住计时(仍是 5)');

  /* ——— 负对照:每发之间漂 6 秒(> 窗口)⇒ 永远凑不出 3 层,invulnSec 不会被重置 ——— */
  let g: DownedState = createDowned(progress, EQUIP, 0, 0);
  for (let i = 1; i <= 5; i += 1) {
    const hit = bubbleGunHit(g);
    eq(hit.trapped, false, `第 ${i} 发(与前发间隔 6s)不得困住`);
    eq(hit.downed.bubbleStacks, 1, `第 ${i} 发后层数只到 1`);
    eq(hit.downed.invulnSec, 0, `第 ${i} 发不得把困住计时写成 5 秒(不许续杯)`);
    g = tickGhostBubble(hit.downed, 6.0).downed;
    eq(g.bubbleStacks, 0, '★ 漂 6s > 窗口 ⇒ 层数被清掉');
    eq(g.bubbleSinceHitSec, 0, '窗口计时一并归零(只在有层数时有意义)');
  }

  /* ★ 负对照(取代修前那个不碰模块的本地循环模型):漂移**恰好等于**窗口时长
     ⇒ 层数必须清零。走真 `tickGhostBubble`:删掉窗口过期分支 ⇒ 层数仍为 2 ⇒ 红。 */
  let bd: DownedState = createDowned(progress, EQUIP, 0, 0);
  bd = bubbleGunHit(bd).downed;
  bd = bubbleGunHit(bd).downed;
  eq(bd.bubbleStacks, 2, '前置:窗口内连中 2 发 ⇒ 2 层');
  const atWindow = tickGhostBubble(bd, BUBBLE_STACK_WINDOW_SEC).downed;
  eq(atWindow.bubbleStacks, 0, '★ 漂移 = 窗口 5.0s(边界)⇒ 层数清零(不再是恒真槽位)');
  eq(atWindow.bubbleSinceHitSec, 0, '窗口计时一并归零');

  /* 键不得凭空出现在 `createDowned`(WS-FND-36 把键集钉成 13 个)。 */
  eq(Object.keys(createDowned(progress, EQUIP, 0, 0)).length, 13, 'createDowned 键数不变(窗口字段只由命中建立)');
  ok(!Object.prototype.hasOwnProperty.call(createDowned(progress, EQUIP, 0, 0), 'bubbleSinceHitSec'), 'createDowned 不带窗口字段');
  ok(Object.prototype.hasOwnProperty.call(h1.downed, 'bubbleSinceHitSec'), '首次命中才建立窗口字段');
});

/* ═════════════════ 11. createTarget 的 shieldMax 派生 ═════════════════ */

test('FND111-11 createTarget:shieldMax 派生(修前两行同条件 if 只剩一行)', () => {
  eq(createTarget({ id: 'a', name: 'A' }).shieldMax, 0, '都没给 ⇒ 0');
  eq(createTarget({ id: 'a', name: 'A', shield: 7 }).shieldMax, 7, '只给 shield ⇒ 以它当初始上限');
  eq(createTarget({ id: 'a', name: 'A', shieldMax: 12 }).shieldMax, 12, '只给 shieldMax ⇒ 原样');
  eq(createTarget({ id: 'a', name: 'A', shield: 7, shieldMax: 3 }).shieldMax, 3, '★ 两者都给 ⇒ 显式 shieldMax 优先');
  eq(createTarget({ id: 'a', name: 'A', shield: 7 }).shield, 7, 'shield 本体不被改写');
  eq(createTarget({ id: 'a', name: 'A', shield: 7, shieldMax: 3 }).shield, 7, '显式优先时 shield 也照旧');
});

report('WS-FND-111');
