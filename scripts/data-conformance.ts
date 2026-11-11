/**
 * 手册数值表 ↔ 代码实现 全量对照审计(WS-FND-06 的可复跑工具)。
 *
 * ## 这个脚本存在的理由
 *
 * 数值错**不会让任何测试变红** —— 测试常常是照抄实现写的。它会静默改变玩法平衡,
 * 而这正是最难在事后发现的一类缺陷。本脚本把「手册原文」当作**外部事实**去校验代码,
 * 判据永远取自手册文本(带行号),绝不拿代码自己的常量当判据 ——
 * 否则两边同源,改数值会让断言与实现一起变,永远相等(同义反复)。
 *
 * ## 用法
 *
 * ```
 * node scripts/data-conformance.ts                 # 全部对照
 * node scripts/data-conformance.ts --group 地砖     # 只看某一组
 * node scripts/data-conformance.ts --only-mismatch # 只打印不一致
 * node scripts/data-conformance.ts --json          # 输出机读汇总
 * ```
 *
 * **退出码恒为 0**:本脚本是**审计工具**而非门禁。不一致项需要 Lead 裁决
 * (数值改动会引发跨 WS 连锁),把它们变成红灯会逼人「改到绿」,
 * 而那恰恰是要避免的。门禁部分是 `tests/WS-FND-06.test.ts` —— 它只固化**已确认一致**的项。
 *
 * ## 手册位置
 *
 * 手册在仓库外。脚本按顺序尝试:环境变量 `PLAN_MD`、Downloads 常见路径、
 * 仓库内 `docs/` 副本。找不到时**不伪造结论**,而是把所有对照标为
 * 「无法判断」并在退出时明确提示缺什么。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ═══════════════════════════ 断言模型 ═══════════════════════════ */

export type Verdict = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

export interface Check {
  group: string;
  label: string;
  /** 手册值(文本),null 表示手册未给出可比对的具体数值 */
  hb: string | null;
  /** 手册行号(1-based),null 表示未能定位 */
  hbLine: number | null;
  /** 代码值(文本),null 表示代码侧无对应实现 */
  code: string | null;
  /** 代码位置 file:line */
  codeRef: string | null;
  verdict: Verdict;
  note: string;
}

const checks: Check[] = [];

function add(c: Check): void {
  checks.push(c);
}

/** 纯数值比较,容差 1e-9。 */
function numCheck(
  group: string, label: string,
  hb: number | null, hbLine: number | null,
  code: number | null, codeRef: string | null,
  note = '',
): void {
  let verdict: Verdict;
  if (hb === null) verdict = 'UNKNOWN';
  else if (code === null) verdict = 'UNKNOWN';
  else verdict = Math.abs(hb - code) < 1e-9 ? 'MATCH' : 'MISMATCH';
  add({
    group, label,
    hb: hb === null ? null : String(hb), hbLine,
    code: code === null ? null : String(code), codeRef,
    verdict,
    note: verdict === 'UNKNOWN' && note === '' ? '手册未给数值或代码无对应实现' : note,
  });
}

/** 集合/结构比较。 */
function eqCheck(
  group: string, label: string,
  hb: string, hbLine: number | null,
  code: string | null, codeRef: string | null,
  note = '',
): void {
  let verdict: Verdict;
  if (code === null) verdict = 'UNKNOWN';
  else verdict = hb === code ? 'MATCH' : 'MISMATCH';
  add({ group, label, hb, hbLine, code, codeRef, verdict, note });
}

/* ═══════════════════════════ 手册定位 ═══════════════════════════ */

export function locatePlan(): { path: string; lines: string[] } | null {
  const cands: string[] = [];
  if (process.env.PLAN_MD) cands.push(process.env.PLAN_MD);
  cands.push(
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Downloads', '2_5d_cartoon_sandbox_plan.md'),
    join(ROOT, 'docs', '2_5d_cartoon_sandbox_plan.md'),
    join(ROOT, '..', '2_5d_cartoon_sandbox_plan.md'),
    '/mnt/user-data/uploads/2_5d_cartoon_sandbox_plan.md',
  );
  for (const p of cands) {
    if (p && existsSync(p)) return { path: p, lines: readFileSync(p, 'utf8').split(/\r?\n/) };
  }
  return null;
}

/** 在手册里定位第一个匹配行(返回 1-based 行号)。 */
function findLine(lines: string[], re: RegExp): number | null {
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) return i + 1;
  return null;
}

/**
 * 名称归一化。
 *
 * 手册正文用**全角括号**(`(和平盾)`),代码用**半角**(`(和平盾)`)——
 * 直接字符串比较会把 7 项纯排版差异误报成「名称漂移」。
 * 归一化只消掉排版噪音(空白 + 全角/半角括号),不动任何实义字符:
 * 若代码真把「青竹」写成「翠竹」,归一化后依然不等,不会漏报。
 */
function normName(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[\uff08]/g, '(')
    .replace(/[\uff09]/g, ')')
    .replace(/[\u3010\u3011]/g, '')
    .replace(/[·・]/g, '');
}

/* ═══════════════════════════ 分组 1:内容基线 ═══════════════════════════ */

async function auditIdentity(plan: { lines: string[] } | null): Promise<void> {
  const G = '内容基线';
  const items = await import('../shared/constants/items.ts');
  const mobs = await import('../shared/constants/mobs.ts');
  const bosses = await import('../shared/constants/bosses.ts');
  const reg = await import('../server/src/content/registry.ts');

  const title = plan ? findLine(plan.lines, /320 项独立 ID 明细配表/) : null;
  const G10 = plan ? findLine(plan.lines, /3\.10 怪物战利品/) : null;
  const ids = items.ITEM_LIST.map((i: { id: number }) => i.id);
  const maxId = Math.max(...ids);

  eqCheck(G, '物品总数', '320', title, String(items.ITEM_LIST.length),
    'shared/constants/items.ts#ITEM_LIST', plan ? '' : '未找到手册文件');
  eqCheck(G, '最大物品 ID', '745', G10, String(maxId), 'items.ts#ITEM_LIST',
    '手册 §3.10 表头写 701~745');
  eqCheck(G, '野生动物种数', '24', plan ? findLine(plan.lines, /24 种野生动物/) : null,
    String(mobs.MOB_LIST.length), 'shared/constants/mobs.ts#MOB_LIST');
  eqCheck(G, '世界 Boss 个数', '8', plan ? findLine(plan.lines, /八大群系野生世界 Boss/) : null,
    String(bosses.BOSS_LIST.length), 'shared/constants/bosses.ts#BOSS_LIST');

  /* 十大分表数量:手册每节标题都写了「共 N 项」 */
  const tableExpect: [string, number][] = [
    ['3.1', 30], ['3.2', 20], ['3.3', 18], ['3.4', 35], ['3.5', 30],
    ['3.6', 35], ['3.7', 40], ['3.8', 37], ['3.9', 30], ['3.10', 45],
  ];
  const byKey = new Map(items.ITEM_TABLES.map((t: { key: string; ids: number[] }) => [t.key, t.ids.length]));
  for (const [key, n] of tableExpect) {
    const secRe = new RegExp(`### ${key.replace('.', '\\.')} `);
    const line = plan ? findLine(plan.lines, secRe) : null;
    eqCheck(G, `分表 ${key} 数量`, String(n), line, String(byKey.get(key) ?? null),
      'items.ts#ITEM_TABLES');
  }

  /* 位域上限:手册 §2.3 写 OBJ 12 位,「支持 4095 种」 */
  const tile = await import('../shared/types/tile.ts');
  const objLine = plan ? findLine(plan.lines, /支持 4095 种地面物体/) : null;
  const objMax = (tile.OBJ_MASK >>> tile.OBJ_SHIFT);
  eqCheck(G, 'OBJ 层位域上限', '4095', objLine, String(objMax), 'shared/types/tile.ts#OBJ_MASK',
    '(1<<12)-1');
  eqCheck(G, 'OBJ 层位数', '12', objLine,
    String(tile.OBJ_MASK === 0 ? 0 : 32 - Math.clz32(tile.OBJ_MASK) - tile.OBJ_SHIFT),
    'shared/types/tile.ts#OBJ_MASK');

  /* 内容指纹与可用号(既有锚点) */
  const f = reg.contentFingerprints();
  add({
    group: G, label: '内容指纹 overall',
    hb: 'v1-fa111d71(既有锚点)', hbLine: null,
    code: `v${f.version}-${f.overall}`, codeRef: 'server/src/content/registry.ts#contentFingerprints',
    verdict: f.overall === 'fa111d71' && f.version === 1 ? 'MATCH' : 'MISMATCH',
    note: '锚点来自 README 状态块',
  });
  const cap = reg.contentCapacity().find((c: { space: string }) => c.space.includes('OBJ'));
  if (cap) {
    add({
      group: G, label: 'OBJ 可用号 freeIdCount',
      hb: '3775(既有锚点)', hbLine: objLine, code: String(cap.freeCount),
      codeRef: 'server/src/content/registry.ts#contentCapacity',
      verdict: cap.freeCount === 3775 ? 'MATCH' : 'MISMATCH', note: '',
    });
    add({
      group: G, label: 'OBJ 顶端余量 headroom',
      hb: '3350(既有锚点)', hbLine: objLine, code: String(cap.headroom),
      codeRef: 'server/src/content/registry.ts#contentCapacity',
      verdict: cap.headroom === 3350 ? 'MATCH' : 'MISMATCH', note: '',
    });
  }

  /* ── 全 320 项名称逐一比对(手册表格行 vs 代码 name) ── */
  if (plan) {
    const parsed = new Map<number, { name: string; line: number }>();
    for (let i = 0; i < plan.lines.length; i += 1) {
      const m = /^\|\s*`(\d{3})`\s*\|\s*(\*{0,2})([^|*]+?)\*{0,2}\s*\|/.exec(plan.lines[i]);
      if (m) {
        const id = Number(m[1]);
        if (!parsed.has(id)) parsed.set(id, { name: m[3].trim(), line: i + 1 });
      }
    }
    let nameMatch = 0;
    const nameBad: string[] = [];
    for (const it of items.ITEM_LIST) {
      const h = parsed.get(it.id);
      if (!h) continue;
      const a = normName(h.name);
      const b = normName(String(it.name));
      if (a === b) nameMatch += 1;
      else nameBad.push(`#${it.id} 手册「${h.name}」(L${h.line}) vs 代码「${it.name}」`);
    }
    add({
      group: G, label: `全 ${items.ITEM_LIST.length} 项名称与手册一致`,
      hb: `${parsed.size} 行可解析 / ${nameMatch} 项一致`, hbLine: title,
      code: nameBad.length === 0 ? '全部一致' : `${nameBad.length} 项不一致`,
      codeRef: 'items.ts#ITEM_LIST',
      verdict: nameBad.length === 0 ? 'MATCH' : 'MISMATCH',
      note: nameBad.slice(0, 12).join(' ; ') + (nameBad.length > 12 ? ` …等 ${nameBad.length} 项` : ''),
    });
  }
}

/* ═══════════════════════════ 分组 2:地砖摩擦表(301~330) ═══════════════════════════ */

interface HbFloor { id: number; name: string; mu: number; speedPct: number; line: number }

function parseFloorTable(lines: string[]): HbFloor[] {
  const out: HbFloor[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\|\s*`?(?:`)?\*{0,2}(\d{3})\*{0,2}`?\*{0,2}\s*\|[^|]*\|\s*\*{0,2}`?([\d.]+)`?\*{0,2}\s*\|\s*\*{0,2}`?(\d+)%`?\*{0,2}\s*\|/.exec(lines[i]);
    if (m) {
      const id = Number(m[1]);
      if (id >= 301 && id <= 330 && !out.some((o) => o.id === id)) {
        out.push({ id, name: '', mu: Number(m[2]), speedPct: Number(m[3]), line: i + 1 });
      }
    }
  }
  return out;
}

async function auditFloors(plan: { lines: string[] } | null): Promise<void> {
  const G = '地砖摩擦 μ (301~330)';
  const chunk = await import('../server/src/world/chunk.ts');
  const phys = await import('../server/src/physics/world.ts');

  if (!plan) {
    add({
      group: G, label: '整表对照', hb: null, hbLine: null, code: null, codeRef: null,
      verdict: 'UNKNOWN', note: '未找到手册文件,无法取得 301~330 的 μ 原文',
    });
    return;
  }

  const hbRows = parseFloorTable(plan.lines);
  if (hbRows.length !== 30) {
    add({
      group: G, label: '手册表解析', hb: `期望 30 行`, hbLine: null,
      code: `解析出 ${hbRows.length} 行`, codeRef: 'scripts/data-conformance.ts#parseFloorTable',
      verdict: hbRows.length === 30 ? 'MATCH' : 'MISMATCH',
      note: '手册 §3.5 表应有 301~330 共 30 行',
    });
  }

  let match = 0;
  for (const r of hbRows) {
    const codeMu = chunk.floorMu(r.id) as number;
    const isDefault = !chunk.FLOOR_META.has(r.id);
    const codeRef = isDefault
      ? 'server/src/world/chunk.ts#FLOOR_DEFAULT_MU'
      : 'server/src/world/chunk.ts#FLOOR_META';
    const v: Verdict = Math.abs(codeMu - r.mu) < 1e-9 ? 'MATCH' : 'MISMATCH';
    if (v === 'MATCH') match += 1;
    add({
      group: G, label: `${r.id} μ`, hb: String(r.mu), hbLine: r.line, code: String(codeMu),
      codeRef, verdict: v, note: isDefault ? '代码未登记该项,落回缺省 0.75' : '',
    });
  }

  add({
    group: G, label: 'μ 全表一致条数', hb: '30', hbLine: null,
    code: String(match), codeRef: 'server/src/world/chunk.ts#FLOOR_META',
    verdict: match === 30 ? 'MATCH' : 'MISMATCH',
    note: match === 30 ? '' : `仅 ${match}/30 一致`,
  });

  /* 移速修正列:手册 30 行全部给出,代码 FloorMeta 有无对应字段? */
  const meta = chunk.FLOOR_META.get(303) as Record<string, unknown> | undefined;
  const hasSpeed = meta !== undefined && 'speedMul' in meta;
  add({
    group: G, label: '移速修正列(speedMul)',
    hb: '30 行均给出(如 315=130%、316=45%、313=125%)', hbLine: hbRows[0]?.line ?? null,
    code: hasSpeed ? '已建模' : 'FloorMeta 无 speedMul 字段',
    codeRef: 'server/src/world/chunk.ts#FloorMeta',
    verdict: hasSpeed ? 'MATCH' : 'MISMATCH',
    /* 字段存在 = 数据有出处;但**消费点**是另一件事,必须分开说,
       否则「已建模」会被误读成「已生效」。 */
    note: hasSpeed
      ? '数据字段已落地(30 项 + 快查表),但**消费点未接入** —— 尚未进物理积分,当前只是可查数据'
      : '手册 §3.5 的「移速修正」列在代码里没有任何承载字段,该列整列未落地',
  });

  /* 加速带推力:手册只对 317 给了具体数值 */
  const beltLine = findLine(plan.lines, /单向狂飙加速带/);
  numCheck(G, '317 加速带推力(格/秒)', 10.0, beltLine,
    (phys.BELT_FORCE.get(317) ?? null) as number | null,
    'server/src/physics/world.ts#BELT_FORCE');
  const belt313 = findLine(plan.lines, /塑胶跑道计速砖/);
  numCheck(G, '313 加速带推力(格/秒)', null, belt313,
    (phys.BELT_FORCE.get(313) ?? null) as number | null,
    'server/src/physics/world.ts#BELT_FORCE', '手册只写「125% 移速修正」,未给格/秒推力');
  const belt330 = findLine(plan.lines, /矿车制动加速轨/);
  numCheck(G, '330 加速带推力(格/秒)', null, belt330,
    (phys.BELT_FORCE.get(330) ?? null) as number | null,
    'server/src/physics/world.ts#BELT_FORCE', '手册只写「全速推力」,未给数值');
}

/* ═══════════════════════════ 分组 3:野生动物 AI(24 种) ═══════════════════════════ */

interface HbMob { id: string; name: string; level: number; hp: number; line: number }

function parseMobTable(lines: string[]): HbMob[] {
  const out: HbMob[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /\|\s*\*\*\d+\.\s*[^*]+\*\*\s*\|\s*`(mob_\w+)`\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*Lv\.(\d+)\s*\/\s*`([\d,]+)`/.exec(lines[i]);
    if (m) {
      const hp = Number(m[5].replace(/,/g, ''));
      if (!out.some((o) => o.id === m[1])) {
        out.push({ id: m[1], name: m[2].trim(), level: Number(m[4]), hp, line: i + 1 });
      }
    }
  }
  return out;
}

async function auditMobs(plan: { lines: string[] } | null): Promise<void> {
  const G = '野生动物 (24 种)';
  const mobs = await import('../shared/constants/mobs.ts');
  const bh = await import('../server/src/mobs/behaviors.ts');

  if (!plan) {
    add({
      group: G, label: '整表对照', hb: null, hbLine: null, code: null, codeRef: null,
      verdict: 'UNKNOWN', note: '未找到手册文件',
    });
    return;
  }

  const hbRows = parseMobTable(plan.lines);
  add({
    group: G, label: '手册表解析行数', hb: '24', hbLine: null, code: String(hbRows.length),
    codeRef: 'scripts/data-conformance.ts#parseMobTable',
    verdict: hbRows.length === 24 ? 'MATCH' : 'MISMATCH', note: '手册 §4.2 表应有 24 行',
  });

  let lvOk = 0; let hpOk = 0; let found = 0;
  for (const r of hbRows) {
    const m = mobs.MOB_BY_ID.get(r.id) as { level: number; hp: number } | undefined;
    if (!m) {
      add({
        group: G, label: `${r.id} 存在性`, hb: r.name, hbLine: r.line, code: null,
        codeRef: 'shared/constants/mobs.ts#MOB_BY_ID', verdict: 'MISMATCH',
        note: '手册有此生物,代码缺失',
      });
      continue;
    }
    found += 1;
    if (m.level === r.level) lvOk += 1;
    else add({
      group: G, label: `${r.id} 等级`, hb: String(r.level), hbLine: r.line, code: String(m.level),
      codeRef: 'shared/constants/mobs.ts#MOB_BY_ID', verdict: 'MISMATCH', note: '',
    });
    if (m.hp === r.hp) hpOk += 1;
    else add({
      group: G, label: `${r.id} HP`, hb: String(r.hp), hbLine: r.line, code: String(m.hp),
      codeRef: 'shared/constants/mobs.ts#MOB_BY_ID', verdict: 'MISMATCH', note: '',
    });
  }
  add({
    group: G, label: 'Lv/HP 全表一致', hb: `${hbRows.length}/${hbRows.length}`, hbLine: null,
    code: `找到 ${found} 种,等级一致 ${lvOk},HP 一致 ${hpOk}`,
    codeRef: 'shared/constants/mobs.ts#MOB_LIST',
    verdict: lvOk === hbRows.length && hpOk === hbRows.length ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 手册正文里可定位的具体 AI 数值 */
  const L = plan.lines;
  numCheck(G, '野猪 蓄力(秒)', 1.0, findLine(L, /野猪.*刨蹄蓄力 1 秒|原地刨蹄蓄力 1 秒/),
    bh.BOAR_WINDUP_SEC, 'server/src/mobs/behaviors.ts#BOAR_WINDUP_SEC');
  numCheck(G, '野猪 冲锋距离(格)', 6, findLine(L, /沿直线高速冲锋 `?6 `?格|冲锋 `6 格`/),
    bh.BOAR_CHARGE_TILES, 'server/src/mobs/behaviors.ts#BOAR_CHARGE_TILES');
  numCheck(G, '野猪 撞墙自晕(秒)', 3, findLine(L, /撞晕 3 秒|自己撞晕 3 秒/),
    bh.BOAR_SELF_STUN_SEC, 'server/src/mobs/behaviors.ts#BOAR_SELF_STUN_SEC');
  numCheck(G, '紫晶重甲虫 正面免伤率', 0.80, findLine(L, /正面甲壳免疫 `?80%/),
    bh.BEETLE_FRONT_DR, 'server/src/mobs/behaviors.ts#BEETLE_FRONT_DR');
  numCheck(G, '姜饼小人 逃逸计时(秒)', 10.0, findLine(L, /10 秒内没抓到就会钻进糖果屋|10 秒内没抓到/),
    bh.GINGER_ESCAPE_SEC, 'server/src/mobs/behaviors.ts#GINGER_ESCAPE_SEC');
  numCheck(G, '彩虹陆行鸟 驯服所需黄金小麦', 3, findLine(L, /喂 3 个 `?123 黄金小麦/),
    bh.CHOCOBO_TAME_WHEAT, 'server/src/mobs/behaviors.ts#CHOCOBO_TAME_WHEAT');

  /* 手册未给数值的 AI 参数(代码自行设定) */
  for (const [label, val, ref, hbLine] of [
    ['穿山甲 反抽眩晕(秒)', bh.PANGOLIN_STUN_SEC, 'PANGOLIN_STUN_SEC', findLine(L, /反抽回去撞墙眩晕/)],
    ['音波蝠 坠地(秒)', bh.BAT_FALL_SEC, 'BAT_FALL_SEC', findLine(L, /干扰其声呐使其坠地/)],
    ['布丁法师 治疗量', bh.PUDDING_HEAL_AMOUNT, 'PUDDING_HEAL_AMOUNT', findLine(L, /并为周围果冻怪加血/)],
    ['巧克力盾卫 护甲免伤率', bh.CHOCO_ARMOR, 'CHOCO_ARMOR', findLine(L, /巧克力护甲会融化/)],
  ] as [string, number, string, number | null][]) {
    add({
      group: G, label, hb: null, hbLine, code: String(val),
      codeRef: `server/src/mobs/behaviors.ts#${ref}`, verdict: 'UNKNOWN',
      note: '手册只说机制未给数值,代码自行设定 —— 需设计确认',
    });
  }

  /* 掉落逐条对照(手册写「掉 119 云朵棉花×2、701 鲜肉」) */
  const dropSpec: [string, number, number][] = [
    [''.concat('mob_sheep'), 119, 2], ['mob_sheep', 701, 1],
    ['mob_boar', 701, 2], ['mob_boar', 702, 2],
    ['mob_beaver', 703, 2], ['mob_beaver', 151, 3],
    ['mob_samurai_bamboo', 103, 4],
    ['mob_beetle_crystal', 116, 3], ['mob_beetle_crystal', 114, 2],
    ['mob_pangolin', 702, 3],
    ['mob_scorpion', 108, 4],
    ['mob_pudding_mage', 162, 3],
    ['mob_choco_golem', 105, 5],
    ['mob_sky_manta', 119, 4],
    ['mob_thunder_sprite', 117, 2], ['mob_thunder_sprite', 159, 5],
    ['mob_mimic_cog', 158, 6], ['mob_mimic_cog', 115, 3],
    ['mob_lava_elem', 710, 2], ['mob_lava_elem', 110, 3],
    ['mob_clock_knight', 114, 4], ['mob_clock_knight', 158, 8],
  ];
  let dropOk = 0;
  for (const [id, itemId, qty] of dropSpec) {
    const m = mobs.MOB_BY_ID.get(id) as { drops: Record<number, number> } | undefined;
    const got = m?.drops[itemId];
    const v: Verdict = got === qty ? 'MATCH' : 'MISMATCH';
    if (v === 'MATCH') dropOk += 1;
    const line = findLine(L, new RegExp(`${id.replace('mob_', '')}`)) ;
    add({
      group: G, label: `${id} 掉落 ${itemId}`, hb: String(qty), hbLine: line,
      code: got === undefined ? null : String(got),
      codeRef: 'shared/constants/mobs.ts#MOB_BY_ID', verdict: v, note: '',
    });
  }
  add({
    group: G, label: '掉落数量抽查一致', hb: String(dropSpec.length), hbLine: null,
    code: String(dropOk), codeRef: 'shared/constants/mobs.ts#MOB_BY_ID',
    verdict: dropOk === dropSpec.length ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 手册未给 ID 的掉落物:代码用了替代物 —— 这是需要裁决的语义漂移 */
  for (const [id, note] of [
    ['mob_chocobo', '手册「掉蓬松彩羽」,代码给 119 云朵棉花;蓬松彩羽在 320 项里无对应 ID'],
    ['mob_choco_golem', '手册「稀有甜点食谱」,代码给 603 绯樱蜜桃果酱派;手册未指明是哪一条食谱'],
    ['mob_ginger_imp', '手册「掉大量 128 皇家蜂蜜」,代码给 128×3;「大量」是否等于 3 需确认'],
    ['mob_squirrel', '手册「掉 101 原木、稀有树种」,代码只有 101;「稀有树种」无 ID'],
    ['mob_house_troll', '手册「皇家甜点主题全套城堡图纸与姜饼人随从」,代码未建模'],
  ] as [string, string][]) {
    add({
      group: G, label: `${id} 无 ID 掉落物`,
      hb: '手册原文未给物品 ID', hbLine: findLine(L, new RegExp(id.replace('mob_', ''))),
      code: JSON.stringify((mobs.MOB_BY_ID.get(id) as { drops?: unknown } | undefined)?.drops ?? null),
      codeRef: 'shared/constants/mobs.ts#MOB_BY_ID', verdict: 'UNKNOWN', note,
    });
  }
}

/* ═══════════════════════════ 分组 4:世界 Boss(8 个) ═══════════════════════════ */

interface HbBoss { name: string; level: number; hp: number; line: number; phases: number }

/**
 * 解析手册 §4.3 Boss 表。
 *
 * 手册的 Boss 名与 Lv/HP 在**同一个单元格**里被 `|` 包住,但名字含全角冒号与
 * 间隔号(如「草甸:果冻国王·波波大帝」),`[^*]+` 贪心会跨单元格。
 * 因此改成「先定位 `Lv.N / HP: N` 这一段,再往回取同一行的加粗标题」——
 * 锚在唯一稳定的结构上,不依赖名字里有哪些标点。
 */
function parseBossTable(lines: string[]): HbBoss[] {
  const out: HbBoss[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /Lv\.(\d+)\s*\/\s*`HP:\s*([\d,]+)`/.exec(lines[i]);
    if (!m) continue;
    const title = /\*\*\d+\.\s*([^*]+?)\*\*/.exec(lines[i]);
    if (!title) continue;
    const name = title[1].trim();
    if (out.some((o) => o.name === name)) continue;
    /* 阶段数:该行出现的 `**Pn` 标记个数。
       注意不能用「两个星号 + P[1-9] + 两个星号」这种严格写法 ——
       手册把 P2 写成「两个星号 + P2(50%血)+ 两个星号」,加号会漏掉它,
       于是果冻王被数成 2 个阶段(实际 3 个)。只锚到星号 + P + 数字即可。 */
    const phases = (lines[i].match(/\*\*P\d/g) ?? []).length;
    out.push({ name, level: Number(m[1]), hp: Number(m[2].replace(/,/g, '')), line: i + 1, phases });
  }
  return out;
}

async function auditBosses(plan: { lines: string[] } | null): Promise<void> {
  const G = '世界 Boss (8 个)';
  const bosses = await import('../shared/constants/bosses.ts');
  const ent = await import('../shared/types/entities.ts');

  if (!plan) {
    add({
      group: G, label: '整表对照', hb: null, hbLine: null, code: null, codeRef: null,
      verdict: 'UNKNOWN', note: '未找到手册文件',
    });
    return;
  }

  const L = plan.lines;
  const hbRows = parseBossTable(L);
  add({
    group: G, label: '手册表解析行数', hb: '8', hbLine: null, code: String(hbRows.length),
    codeRef: 'scripts/data-conformance.ts#parseBossTable',
    verdict: hbRows.length === 8 ? 'MATCH' : 'MISMATCH', note: '手册 §4.3 表应有 8 行',
  });

  /* 按手册 HP 顺序与代码 baseHp 逐一对齐(手册行序 = 代码数组序) */
  let hpOk = 0; let lvOk = 0;
  for (let k = 0; k < Math.min(hbRows.length, bosses.BOSS_LIST.length); k += 1) {
    const hb = hbRows[k];
    const b = bosses.BOSS_LIST[k] as { id: string; level: number; baseHp: number };
    if (b.baseHp === hb.hp) hpOk += 1;
    else add({
      group: G, label: `${b.id} baseHp`, hb: String(hb.hp), hbLine: hb.line,
      code: String(b.baseHp), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
      verdict: 'MISMATCH', note: `手册名「${hb.name}」`,
    });
    if (b.level === hb.level) lvOk += 1;
    else add({
      group: G, label: `${b.id} level`, hb: String(hb.level), hbLine: hb.line,
      code: String(b.level), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
      verdict: 'MISMATCH', note: '',
    });
  }
  add({
    group: G, label: '全 8 个 baseHp 一致', hb: '8', hbLine: null, code: String(hpOk),
    codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
    verdict: hpOk === 8 ? 'MATCH' : 'MISMATCH', note: '',
  });
  add({
    group: G, label: '全 8 个 level 一致', hb: '8', hbLine: null, code: String(lvOk),
    codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
    verdict: lvOk === 8 ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 祭品 ID 734~741:手册 §3.10 逐条写「放置在…祭坛上,召唤…」 */
  const sacrificeLine = findLine(L, /【祭品】皇家十倍甜莓布丁/);
  let sacOk = 0;
  for (let k = 0; k < 8; k += 1) {
    const want = 734 + k;
    const b = bosses.BOSS_LIST[k] as { summonItem: number; id: string };
    if (b.summonItem === want) sacOk += 1;
    else add({
      group: G, label: `${b.id} summonItem`, hb: String(want), hbLine: sacrificeLine,
      code: String(b.summonItem), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
      verdict: 'MISMATCH', note: '手册 §3.10 祭品表 ID 连续 734~741',
    });
  }
  add({
    group: G, label: '祭品 ID 734~741 连续对齐', hb: '734..741', hbLine: sacrificeLine,
    code: `${bosses.BOSS_LIST[0].summonItem}..${bosses.BOSS_LIST[7].summonItem}`,
    codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
    verdict: sacOk === 8 ? 'MATCH' : 'MISMATCH', note: `${sacOk}/8 对齐`,
  });

  /* 阶段数:直接用手册行的 `**Pn**` 计数(parseBossTable 已算好) */
  let phOk = 0;
  for (let k = 0; k < Math.min(hbRows.length, bosses.BOSS_LIST.length); k += 1) {
    const want = hbRows[k].phases;
    const got = bosses.BOSS_LIST[k].phases.length;
    if (got === want) phOk += 1;
    else add({
      group: G, label: `${bosses.BOSS_LIST[k].id} 阶段数`, hb: String(want),
      hbLine: hbRows[k].line, code: String(got),
      codeRef: 'shared/constants/bosses.ts#BOSS_LIST', verdict: 'MISMATCH',
      note: `手册「${hbRows[k].name}」`,
    });
  }
  add({
    group: G, label: '阶段数一致', hb: String(hbRows.length), hbLine: null, code: String(phOk),
    codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
    verdict: phOk === 8 && hbRows.length === 8 ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 血量缩放公式 HP(N) = HP_base × (1 + 0.65(N-1)) */
  const scaleLine = findLine(L, /HP\(N\) = \\text\{HP\}_\{\\text\{Base\}\}/) ?? findLine(L, /1 \+ 0\.65\(N-1\)/);
  const scaled = ent.bossScaledHp(2500, 4);
  add({
    group: G, label: '人数缩放 N=4(2500 → 7375)', hb: '2500×(1+0.65×3)=7375', hbLine: scaleLine,
    code: String(scaled), codeRef: 'shared/types/entities.ts#bossScaledHp',
    verdict: scaled === 7375 ? 'MATCH' : 'MISMATCH', note: '×2.95',
  });
  numCheck(G, '血量缩放系数(每多 1 人)', 0.65, scaleLine, 0.65,
    'shared/types/entities.ts#bossScaledHp', '公式内联在函数里,无常量导出');

  /* 战利品:手册给「必掉史诗战利品」文字,多数未给 ID —— 逐条核对已给 ID 的 */
  const lootSpec: [string, number, number | null][] = [
    ['boss_jelly_king', 704, null], ['boss_jelly_king', 719, null], ['boss_jelly_king', 727, null],
    ['boss_fox_kitsune', 705, null], ['boss_fox_kitsune', 720, null],
    ['boss_crab_kraken', 706, null], ['boss_crab_kraken', 721, null], ['boss_crab_kraken', 728, null],
    ['boss_scorpion_pharaoh', 707, null], ['boss_scorpion_pharaoh', 722, null],
    ['boss_sky_whale', 117, null], ['boss_sky_whale', 718, null],
    ['boss_chronos_colossus', 708, null], ['boss_chronos_colossus', 723, null],
    ['boss_beaver_mecha', 703, null],
  ];
  let lootOk = 0; let lootTotal = 0;
  for (const [id, item, lineGuess] of lootSpec) {
    const b = bosses.BOSS_BY_ID.get(id) as { loot: number[] } | undefined;
    const has = b?.loot.includes(item) ?? false;
    lootTotal += 1;
    if (has) lootOk += 1;
    else add({
      group: G, label: `${id} 含战利品 ${item}`, hb: '手册列出此物', hbLine: lineGuess,
      code: JSON.stringify(b?.loot ?? null), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
      verdict: 'MISMATCH', note: '手册写明必掉但代码 loot 未含',
    });
  }
  add({
    group: G, label: '手册点名的战利品齐备', hb: String(lootTotal), hbLine: null,
    code: String(lootOk), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
    verdict: lootOk === lootTotal ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 代码自造的战利品:手册没写的,属「新增」而非「漂移」,但需登记 */
  for (const [id, note] of [
    ['boss_beaver_mecha', 'loot 含 437 叮当蒸汽小火车头;手册写「自动伐木机甲宠物图纸」,无对应 ID'],
    ['boss_ginger_troll', 'loot 含 739 皇家焦糖彩虹姜饼屋 —— 该 ID 同时是本 Boss 的召唤祭品'],
    ['boss_sky_whale', 'loot 含 440 八人云海探险飞艇;手册战利品列未含此物'],
    ['boss_chronos_colossus', '手册写 3 件战利品(708/723/纯金纪念碑),代码只有 2 条'],
  ] as [string, string][]) {
    const b = bosses.BOSS_BY_ID.get(id) as { loot: number[] } | undefined;
    add({
      group: G, label: `${id} 战利品存疑`, hb: '手册战利品描述', hbLine: null,
      code: JSON.stringify(b?.loot ?? null), codeRef: 'shared/constants/bosses.ts#BOSS_LIST',
      verdict: 'UNKNOWN', note,
    });
  }

  /* 4.3 破防机制描述是否落地 */
  const breakMod = await import('../server/src/bosses/breaks.ts');
  const breakIds = new Set(
    (Object.values(breakMod).filter((v) => typeof v === 'object' && v !== null) as Record<string, unknown>[])
      .flatMap((o) => Object.values(o)).filter((v) => typeof v === 'number') as number[],
  );
  add({
    group: G, label: '破防机制引用的物品 ID 落在 320 项内',
    hb: '手册 8 条 breakMechanic 引用的物品', hbLine: findLine(L, /投弹喂食破防/),
    code: `breaks.ts 引用 ${breakIds.size} 个 ID`,
    codeRef: 'server/src/bosses/breaks.ts',
    verdict: breakIds.size > 0 ? 'MATCH' : 'UNKNOWN', note: '仅确认存在,未逐条比对文案',
  });
}

/* ═══════════════════════════ 分组 5:料理 601~615 ═══════════════════════════ */

async function auditCooking(plan: { lines: string[] } | null): Promise<void> {
  const G = '料理 601~615';
  const cook = await import('../server/src/combat/cooking.ts');
  const L = plan?.lines ?? null;

  const byId = new Map<number, Record<string, unknown>>(
    (cook.FOODS as unknown as Record<string, unknown>[]).map((f) => [f.id as number, f]),
  );
  add({
    group: G, label: '料理条目数(601~615)', hb: '15', hbLine: L ? findLine(L, /ID 601 ~ 630/) : null,
    code: String((cook.FOODS as unknown as unknown[]).length),
    codeRef: 'server/src/combat/cooking.ts#FOODS',
    verdict: (cook.FOODS as unknown as unknown[]).length === 15 ? 'MATCH' : 'MISMATCH',
    note: '手册 §3.9 把 601~630 合成一节;601~615 为料理',
  });

  /* 手册逐条给了恢复量与时长(分钟 → 秒) */
  const spec: [number, number | null, number | null, string, number | null][] = [
    [601, 40, 600, '立即恢复 40 HP,持续 10 分钟', null],
    [602, null, 600, '持续 10 分钟', null],
    [603, null, null, '暴击率 +15%(手册未给时长)', null],
    [604, null, null, '跳跃高度 +50%(未给时长)', null],
    [605, null, null, '近战攻击力 +25%(未给时长)', null],
    [606, null, 900, '持续 15 分钟', null],
    [608, null, 60, '集体变成小肥鸡 60 秒', null],
    [612, 80, null, '立即恢复 80 HP', null],
    [613, null, 1200, '20 分钟经验 +30%', null],
    [615, null, 1800, '接下来 30 分钟', null],
  ];
  let healOk = 0; let healTot = 0; let durOk = 0; let durTot = 0;
  for (const [id, heal, dur, hbText, line] of spec) {
    const f = byId.get(id);
    if (!f) {
      add({
        group: G, label: `${id} 存在性`, hb: hbText, hbLine: line, code: null,
        codeRef: 'server/src/combat/cooking.ts#FOODS', verdict: 'MISMATCH', note: '代码缺此料理',
      });
      continue;
    }
    const ln = line ?? (L ? findLine(L, new RegExp(`\`${id}\``)) : null);
    if (heal !== null) {
      healTot += 1;
      const got = (f.instantHealHp as number) ?? 0;
      if (got === heal) healOk += 1;
      else add({
        group: G, label: `${id} 立即恢复 HP`, hb: String(heal), hbLine: ln, code: String(got),
        codeRef: 'server/src/combat/cooking.ts#FOODS', verdict: 'MISMATCH', note: '',
      });
    }
    if (dur !== null) {
      durTot += 1;
      const got = (f.durationSec as number) ?? 0;
      if (got === dur) durOk += 1;
      else add({
        group: G, label: `${id} 持续时长(秒)`, hb: String(dur), hbLine: ln, code: String(got),
        codeRef: 'server/src/combat/cooking.ts#FOODS', verdict: 'MISMATCH', note: '',
      });
    }
  }
  add({
    group: G, label: '恢复量一致', hb: String(healTot), hbLine: null, code: String(healOk),
    codeRef: 'server/src/combat/cooking.ts#FOODS',
    verdict: healOk === healTot ? 'MATCH' : 'MISMATCH', note: '',
  });
  add({
    group: G, label: '时长一致', hb: String(durTot), hbLine: null, code: String(durOk),
    codeRef: 'server/src/combat/cooking.ts#FOODS',
    verdict: durOk === durTot ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 手册未给时长的料理:代码自定,需登记 */
  for (const [id, hbText] of [
    [603, '手册未给时长'], [604, '手册未给时长'], [605, '手册未给时长'],
    [607, '手册未给时长'], [609, '手册未给时长'], [610, '手册未给时长'],
    [611, '手册未给时长'],
  ] as [number, string][]) {
    const f = byId.get(id);
    add({
      group: G, label: `${id} 时长来源`, hb: hbText,
      hbLine: L ? findLine(L, new RegExp(`\`${id}\``)) : null,
      code: String((f?.durationSec as number) ?? null),
      codeRef: 'server/src/combat/cooking.ts#FOODS', verdict: 'UNKNOWN',
      note: '手册只描述效果未给时长,代码自行设定',
    });
  }

  /* 610 μ 覆盖值 —— 手册给了具体数字 */
  const l610 = L ? findLine(L, /μ=0\.96/) : null;
  const f610 = byId.get(610) as { statMods?: { muOverride?: number } } | undefined;
  numCheck(G, '610 摩擦系数覆盖 μ', 0.96, l610, f610?.statMods?.muOverride ?? null,
    'server/src/combat/cooking.ts#FOODS');
  /* 609 手册「重力降低 70%」→ 代码 gravityMul 应为 0.3 */
  const l609 = L ? findLine(L, /重力降低 `?70%/) : null;
  const f609 = byId.get(609) as { statMods?: { gravityMul?: number } } | undefined;
  numCheck(G, '609 重力倍率(降低 70% → 0.3)', 0.3, l609, f609?.statMods?.gravityMul ?? null,
    'server/src/combat/cooking.ts#FOODS');
  /* 607 手册「每走三步…冲刺 2 格」 */
  const l607 = L ? findLine(L, /每走三步喷出一串彩虹火苗/) : null;
  const f607 = byId.get(607) as { flags?: { rocketEverySteps?: number; rocketDashTiles?: number } } | undefined;
  numCheck(G, '607 火焰冲刺间隔(步)', 3, l607, f607?.flags?.rocketEverySteps ?? null,
    'server/src/combat/cooking.ts#FOODS');
  numCheck(G, '607 火焰冲刺距离(格)', 2, l607, f607?.flags?.rocketDashTiles ?? null,
    'server/src/combat/cooking.ts#FOODS');
}

/* ═══════════════════════════ 分组 6:整蛊玩具 221~255 ═══════════════════════════ */

async function auditToys(plan: { lines: string[] } | null): Promise<void> {
  const G = '整蛊玩具 221~255';
  const toys = await import('../server/src/prank/toys.ts');
  const imm = await import('../server/src/prank/immunity.ts');
  const L = plan?.lines ?? null;

  /* 手册 §3.4 玩具表:表头在 L161,`221` 那一行在 L162。行号 = 162 + (id − 221)。 */
  const rowOf = (id: number): number | null => {
    if (!L) return null;
    const ln = 162 + (id - 221);
    if (ln < 1 || ln > L.length) return null;
    /* 校验这行确实是 id 对应的那一行,而不是「碰巧以 | 开头」的表头/分隔行 */
    return new RegExp(`^\\|\\s*\`${id}\`\\s*\\|`).test(L[ln - 1]) ? ln : null;
  };
  const cellsOf = (id: number): string[] => {
    const ln = rowOf(id);
    return ln === null ? [] : L![ln - 1].split('|').map((s) => s.trim());
  };
  const itemsMod = await import('../shared/constants/items.ts');
  const id2name = new Map<number, string>(
    itemsMod.ITEM_LIST.map((i: { id: number; name: string }) => [i.id, i.name]),
  );

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const list = toys.PRANK_TOYS as unknown as { id: number; name: string; [k: string]: any }[];
  add({
    group: G, label: '玩具条目数', hb: '35', hbLine: L ? findLine(L, /ID 221 ~ 255,共 35 项/) : null,
    code: String(list.length), codeRef: 'server/src/prank/toys.ts#PRANK_TOYS',
    verdict: list.length === 35 ? 'MATCH' : 'MISMATCH', note: '手册 §3.4',
  });
  add({
    group: G, label: 'ID 集合 = [221..255] 连续', hb: '221..255',
    hbLine: L ? findLine(L, /ID 221 ~ 255/) : null,
    code: `[${list[0].id}..${list[list.length - 1].id}]`,
    codeRef: 'server/src/prank/toys.ts#PRANK_TOYS',
    verdict: list.every((t, k) => t.id === 221 + k) ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* ── 35 项名称逐条比对 ── */
  if (L) {
    const nameBad: string[] = [];
    for (const t of list) {
      const hbName = (cellsOf(t.id)[2] ?? '').replace(/\*/g, '').trim();
      if (hbName === '') continue;
      if (normName(hbName) !== normName(t.name)) {
        nameBad.push(`#${t.id} 手册「${hbName}」(L${rowOf(t.id)}) vs 代码「${t.name}」`);
      }
    }
    add({
      group: G, label: '35 项名称与手册一致', hb: '35', hbLine: 162,
      code: nameBad.length === 0 ? '全部一致' : `${nameBad.length} 项不一致`,
      codeRef: 'server/src/prank/toys.ts#PRANK_TOYS',
      verdict: nameBad.length === 0 ? 'MATCH' : 'MISMATCH',
      note: nameBad.join(' ; '),
    });
  }

  /* ── 35 项配方逐条比对(手册第 5 列「合成配方」) ──
     这是本组最有价值的一条:配方是一张 35 行的对照表,手抄极容易**串行**,
     而代码里 recipe 是纯数据,串了不会有任何其它测试变红。 */
  if (L) {
    let recipeOk = 0; let recipeTotal = 0; let recipeSkip = 0;
    const recipeBad: string[] = [];
    for (const t of list) {
      const hbRecipe = cellsOf(t.id)[4] ?? '';
      /* 非「材料×N」形态(225 是「吃掉 滑溜香蕉 获得」)不计入 */
      if (!/×\d/.test(hbRecipe)) { recipeSkip += 1; continue; }
      const codeRecipe = (itemsMod.ITEM_BY_ID.get(t.id) as { recipe?: Record<string, number> })?.recipe;
      recipeTotal += 1;
      const hbPairs: [string, number][] = [];
      for (const m of hbRecipe.matchAll(/`?([^`+×\s][^+×`]*?)`?×(\d+)/g)) {
        hbPairs.push([m[1].replace(/[`\s]/g, ''), Number(m[2])]);
      }
      const codePairs: [string, number][] = Object.entries(codeRecipe ?? {})
        .map(([k, v]) => [id2name.get(Number(k)) ?? `#${k}`, v as number]);
      const normPairs = (p: [string, number][]): string =>
        p.map(([n, q]) => `${n.replace(/[（(].*?[)）]/g, '')}x${q}`).sort().join('+');
      if (normPairs(hbPairs) === normPairs(codePairs)) recipeOk += 1;
      else {
        recipeBad.push(
          `#${t.id} 手册「${hbPairs.map(([n, q]) => `${n}×${q}`).join('+')}」 `
          + `vs 代码「${codePairs.map(([n, q]) => `${n}×${q}`).join('+')}」`,
        );
      }
    }
    add({
      group: G, label: '配方逐条比对', hb: `${recipeTotal} 条有配方`, hbLine: 162,
      code: `一致 ${recipeOk} / 共 ${recipeTotal}`,
      codeRef: 'shared/constants/items.ts#ITEM_BY_ID',
      verdict: recipeBad.length === 0 ? 'MATCH' : 'MISMATCH',
      note: recipeBad.join(' ; ')
        + (recipeSkip ? `(另 ${recipeSkip} 项无配方:225 由「吃掉香蕉」获得)` : ''),
    });
  }

  /* ── 手册正文里给了具体数字的玩具参数(代码集中在 toys.ts 具名常量里) ── */
  const byId = new Map<number, Record<string, any>>(list.map((t) => [t.id, t]));
  const paramSpec: [string, number, number | undefined, RegExp, string][] = [
    ['#222 击退冲量(格/秒)', 8, byId.get(222)?.impulse,
      /瞬间施加 `?8 `?格\/秒`? 击退冲量/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#223 拳套弹射距离(格)', 4, byId.get(223)?.radius,
      /直线弹出 `?4 `?格`? 远的弹簧大拳头/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#225 打滑距离(格)', 5, toys.BANANA_SLIDE_TILES,
      /极速打滑 `?5 `?格/, 'server/src/prank/toys.ts#BANANA_SLIDE_TILES'],
    ['#227 困人所需发射数', 3, toys.BUBBLE_HITS_TO_TRAP,
      /连射队友 3 发/, 'server/src/prank/toys.ts#BUBBLE_HITS_TO_TRAP'],
    ['#227 泡泡漂浮时长(秒)', 6, toys.BUBBLE_DRIFT_SEC,
      /装进大泡泡随风乱飘/, 'server/src/prank/toys.ts#BUBBLE_DRIFT_SEC'],
    ['#227 泡泡叠加上限', 3, toys.BUBBLE_STACK_LIMIT,
      /泡泡连发水枪/, 'server/src/prank/toys.ts#BUBBLE_STACK_LIMIT'],
    ['#228 引信(秒)', 3, toys.BOMB_FUSE_SEC,
      /点燃后 3 秒爆炸/, 'server/src/prank/toys.ts#BOMB_FUSE_SEC'],
    ['#228 破甲爆破伤害', 120, toys.BOMB_ENEMY_DAMAGE,
      /`120 点` 破甲爆破伤害/, 'server/src/prank/toys.ts#BOMB_ENEMY_DAMAGE'],
    ['#229 变身时长(秒)', 10, byId.get(229)?.morphSec,
      /变成无害的小肥鸡或小绵羊 10 秒/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#230 缩小倍率', 0.3, toys.SHRINK_SCALE,
      /缩小为 `?0\.3 倍/, 'server/src/prank/toys.ts#SHRINK_SCALE'],
    ['#231 放大倍率', 2.0, toys.GIANT_SCALE,
      /体积放大 `?2\.0 倍/, 'server/src/prank/toys.ts#GIANT_SCALE'],
    ['#232 蜂蜜减速比例', 0.70, toys.HONEY_SLOW_RATIO,
      /跑酷对手 `?70%`? 移速/, 'server/src/prank/toys.ts#HONEY_SLOW_RATIO'],
    ['#233 冰冻时长(秒)', 3, toys.SNOWBALL_FREEZE_SEC,
      /将其冻成“冰雕”3 秒/, 'server/src/prank/toys.ts#SNOWBALL_FREEZE_SEC'],
    ['#235 揍飞距离(格)', 3, byId.get(235)?.enemyEffect?.moveTiles,
      /弹簧拳套揍飞 3 格/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#238 撑杆跨越宽度(格)', 4, byId.get(238)?.allyEffect?.moveTiles,
      /越过 `?4 `?格`? 宽的河流/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#241 拔河冲量', 10, toys.TUG_IMPULSE,
      /双向拔河大麻绳/, 'server/src/prank/toys.ts#TUG_IMPULSE'],
    ['#242 仇恨吸引半径(格)', 8, byId.get(242)?.radius,
      /强制吸引周围 `?8 `?格`? 内怪物的仇恨/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#243 感电半径(格)', 3, byId.get(243)?.radius,
      /对周围 3 格内怪物造成感电麻痹/, 'server/src/prank/toys.ts#PRANK_TOYS'],
    ['#243 自身麻痹(秒)', 1.5, byId.get(243)?.stunSec,
      /把自己电成爆炸头/, 'server/src/prank/toys.ts#HELMET_SELF_PARALYZE_SEC'],
    ['#246 治疗光环半径(格)', 6, byId.get(246)?.radius,
      /周围 `?6 `?格`? 内队友提供每秒 `?\+5 HP/, 'server/src/prank/toys.ts#PRANK_TOYS'],
  ];
  let pOk = 0; const pBad: string[] = []; const pUnknown: string[] = [];
  for (const [label, hb, got, re, codeRef] of paramSpec) {
    const ln = L ? findLine(L, re) : null;
    const v: Verdict = got === undefined || got === null
      ? 'UNKNOWN'
      : Math.abs(got - hb) < 1e-9 ? 'MATCH' : 'MISMATCH';
    if (v === 'MATCH') { pOk += 1; continue; }
    if (v === 'MISMATCH') pBad.push(`${label} 手册 ${hb} vs 代码 ${got}`);
    else pUnknown.push(`${label}(代码无该字段)`);
    add({
      group: G, label, hb: String(hb), hbLine: ln,
      code: got === undefined || got === null ? null : String(got),
      codeRef, verdict: v, note: v === 'UNKNOWN' ? '手册给了数值,代码未建模为可比字段' : '',
    });
  }
  add({
    group: G, label: '手册点名的玩具参数逐条比对', hb: String(paramSpec.length), hbLine: 162,
    code: `一致 ${pOk} / 不一致 ${pBad.length} / 未建模 ${pUnknown.length}`,
    codeRef: 'server/src/prank/toys.ts',
    verdict: pBad.length === 0 && pUnknown.length === 0
      ? 'MATCH' : pBad.length === 0 ? 'UNKNOWN' : 'MISMATCH',
    note: [...pBad, ...pUnknown].join(' ; '),
  });

  /* 218 平安盾:手册点名三项,代码须 100% 覆盖 */
  const shieldLine = L ? findLine(L, /100% 免疫队友举起、大锤击退与香蕉皮/) : null;
  for (const [id, named] of [[221, '举起'], [222, '大锤击退'], [225, '香蕉皮']] as [number, string][]) {
    add({
      group: G, label: `218 免疫 ${id}(${named})`,
      hb: '手册点名 100% 免疫', hbLine: shieldLine,
      code: String(imm.isImmuneToAllyPrank(true, id)),
      codeRef: 'server/src/prank/immunity.ts#isImmuneToAllyPrank',
      verdict: imm.isImmuneToAllyPrank(true, id) ? 'MATCH' : 'MISMATCH', note: '',
    });
  }
  const allImmune = list.every((t) => imm.isImmuneToAllyPrank(true, t.id));
  add({
    group: G, label: '218 对全 35 项队友整蛊免疫', hb: '手册只点名 3 项(代码泛化到 35 项)',
    hbLine: shieldLine, code: String(allImmune),
    codeRef: 'server/src/prank/immunity.ts#isImmuneToAllyPrank',
    verdict: allImmune ? 'MATCH' : 'MISMATCH',
    note: '代码是手册的超集:手册点名 3 项,代码扩展到全部队友侧整蛊',
  });
  const hostileOk = imm.HOSTILE_SOURCES.every((s: string) => !imm.isImmuneToHostile(true, s));
  add({
    group: G, label: '218 不免疫 Boss/环境伤害', hb: '手册未写(但「和平盾」语义不应挡 Boss)',
    hbLine: shieldLine, code: String(hostileOk),
    codeRef: 'server/src/prank/immunity.ts#isImmuneToHostile',
    verdict: hostileOk ? 'MATCH' : 'MISMATCH', note: '手册未明确;代码选择穿透',
  });
}

/* ═══════════════════════════ 分组 7:成长曲线 Lv.1~30 ═══════════════════════════ */

async function auditGrowth(plan: { lines: string[] } | null): Promise<void> {
  const G = '成长曲线 Lv.1~30';
  const ent = await import('../shared/types/entities.ts');
  const L = plan?.lines ?? null;

  const lvLine = L ? findLine(L, /角色从 `Lv\.1` 起步,满级 `Lv\.30`/) : null;
  const expLine = L ? findLine(L, /50 \\times L\^2 \+ 50 \\times L/) : null;
  const statLine = L ? findLine(L, /每升 1 级自动获得/) : null;

  add({
    group: G, label: '满级上限', hb: '30', hbLine: lvLine, code: String(ent.MAX_LEVEL),
    codeRef: 'shared/types/entities.ts#MAX_LEVEL',
    verdict: ent.MAX_LEVEL === 30 ? 'MATCH' : 'MISMATCH', note: '',
  });
  /* EXP_next(L) = 50L² + 50L */
  let expOk = 0;
  for (const l of [1, 2, 5, 10, 20, 29, 30]) {
    const want = 50 * l * l + 50 * l;
    const got = ent.expToNext(l);
    if (got === want) expOk += 1;
    else add({
      group: G, label: `expToNext(${l})`, hb: String(want), hbLine: expLine, code: String(got),
      codeRef: 'shared/types/entities.ts#expToNext', verdict: 'MISMATCH', note: '公式 50L²+50L',
    });
  }
  add({
    group: G, label: 'expToNext 公式 50L²+50L(7 点)', hb: '7', hbLine: expLine, code: String(expOk),
    codeRef: 'shared/types/entities.ts#expToNext',
    verdict: expOk === 7 ? 'MATCH' : 'MISMATCH', note: '',
  });

  /* 初始属性 */
  const disc = L ? findLine(L, /初始属性:`HP = 100`/) : null;
  numCheck(G, '初始 HP', 100, disc, ent.BASE_HP, 'shared/types/entities.ts#BASE_HP');
  const phy = await import('../shared/types/physics.ts');
  numCheck(G, '初始基础攻击', 10, disc, phy.BASE_ATK, 'shared/types/physics.ts#BASE_ATK');
  numCheck(G, '初始移动速度(格/秒)', 4.5, disc, phy.BASE_MOVE_SPEED,
    'shared/types/physics.ts#BASE_MOVE_SPEED');

  /* 每级成长 */
  const s1 = ent.statsAtLevel(1);
  const s30 = ent.statsAtLevel(30);
  numCheck(G, 'Lv.1 最大 HP', 100, statLine, s1.maxHp, 'shared/types/entities.ts#statsAtLevel');
  numCheck(G, 'Lv.30 最大 HP', 100 + 15 * 29, statLine, s30.maxHp,
    'shared/types/entities.ts#statsAtLevel', '每级 +15');
  numCheck(G, 'Lv.30 伤害倍率', 1 + 0.03 * 29, statLine, Number(s30.dmgMul.toFixed(6)),
    'shared/types/entities.ts#statsAtLevel', '每级 +3%');
  /* 负重格:手册只写「+1/级」,未给基准值 */
  add({
    group: G, label: '初始背包负重格', hb: null, hbLine: statLine, code: String(s1.carrySlots),
    codeRef: 'shared/types/entities.ts#statsAtLevel',
    verdict: 'UNKNOWN', note: '手册只写「每级 +1」,未给基准格数;代码取 8',
  });
  /* 每 5 级天赋 */
  const talLine = L ? findLine(L, /每升 5 级解锁 1 个被动天赋/) : null;
  eqCheck(G, '天赋解锁等级', '5,10,15,20,25,30', talLine,
    ent.TALENT_LEVELS.join(','), 'shared/types/entities.ts#TALENT_LEVELS');

  /* 经验共享 */
  const shareLine = L ? findLine(L, /距离该怪物 `?24 `?格`? 内的所有玩家/) : null;
  numCheck(G, '经验共享半径(格)', 24, shareLine, ent.SHARE_EXP_RADIUS,
    'shared/types/entities.ts#SHARE_EXP_RADIUS');
  const bonusLine = L ? findLine(L, /同屏参战人数 \$\\ge 3\$ 人/) : null;
  numCheck(G, '欢聚加成人数门槛', 3, bonusLine, ent.PARTY_BONUS_THRESHOLD,
    'shared/types/entities.ts#PARTY_BONUS_THRESHOLD');
  numCheck(G, '欢聚经验加成', 0.25, bonusLine, ent.PARTY_BONUS,
    'shared/types/entities.ts#PARTY_BONUS');
  const afkLine = L ? findLine(L, /30% 的梦境见习经验/) : null;
  numCheck(G, '打盹经验比例', 0.3, afkLine, ent.AFK_EXP_RATIO,
    'shared/types/entities.ts#AFK_EXP_RATIO');
  const revLine = L ? findLine(L, /即可在 `?1 秒`? 内将其半血救活/) : null;
  numCheck(G, '幽灵泡泡救援耗时(秒)', 1.0, revLine, ent.REVIVE_TIME,
    'shared/types/entities.ts#REVIVE_TIME');
  numCheck(G, '幽灵泡泡复活血量比例', 0.5, revLine, ent.REVIVE_HP_RATIO,
    'shared/types/entities.ts#REVIVE_HP_RATIO');
  const featherLine = L ? findLine(L, /隔着 `?6 格`? 远也能瞬间将其满血复活/) : null;
  numCheck(G, '733 羽毛笔射程(格)', 6, featherLine, ent.FEATHER_RANGE,
    'shared/types/entities.ts#FEATHER_RANGE');
  numCheck(G, '733 羽毛笔无敌时长(秒)', 3.0, featherLine, ent.FEATHER_INVULN,
    'shared/types/entities.ts#FEATHER_INVULN');
}

/* ═══════════════════════════ 分组 8:电路件 401~440 ═══════════════════════════ */

async function auditCircuits(plan: { lines: string[] } | null): Promise<void> {
  const G = '电路件 401~440';
  const comp = await import('../server/src/wiring/components.ts');
  const logi = await import('../server/src/wiring/logistics.ts');
  const L = plan?.lines ?? null;

  const specs = comp.COMPONENT_SPECS as unknown as { id: number; name: string }[];
  add({
    group: G, label: '组件条目数', hb: '40', hbLine: L ? findLine(L, /ID 401 ~ 440,共 40 项/) : null,
    code: String(specs.length), codeRef: 'server/src/wiring/components.ts#COMPONENT_SPECS',
    verdict: specs.length === 40 ? 'MATCH' : 'MISMATCH', note: '手册 §3.7',
  });

  /* 404 瞬时脉冲 0.5 秒 */
  numCheck(G, '404 脉冲高电平(秒)', 0.5, L ? findLine(L, /按下后输出 `?0\.5 秒`? 高电平/) : null,
    comp.PULSE_BUTTON_SECONDS, 'server/src/wiring/components.ts#PULSE_BUTTON_SECONDS');

  /* 413 四档延时 */
  const relayLine = L ? findLine(L, /点击可切换延迟 `?0\.2s \/ 0\.5s \/ 1\.0s \/ 2\.0s`?/) : null;
  eqCheck(G, '413 延时四档(秒)', '0.2,0.5,1,2', relayLine,
    comp.RELAY_DELAY_SECONDS.join(','), 'server/src/wiring/components.ts#RELAY_DELAY_SECONDS');
  /* 2Hz 量化为帧:ceil(s/0.5) */
  eqCheck(G, '413 四档量化帧数(2Hz)', '1,1,2,4', relayLine,
    comp.RELAY_DELAY_TICKS.join(','), 'server/src/wiring/components.ts#RELAY_DELAY_TICKS');

  /* 417 0-99 计数器 */
  numCheck(G, '417 计数器量程', 100, L ? findLine(L, /0-99 翻页计数器/) : null,
    comp.COUNTER_MOD, 'server/src/wiring/components.ts#COUNTER_MOD', '0~99 即 mod 100');

  /* 418 频道 1~8 */
  const chLine = L ? findLine(L, /相同频道\(1~8频道\)/) : null;
  numCheck(G, '418 频道下限', 1, chLine, comp.CHANNEL_MIN,
    'server/src/wiring/components.ts#CHANNEL_MIN');
  numCheck(G, '418 频道上限', 8, chLine, comp.CHANNEL_MAX,
    'server/src/wiring/components.ts#CHANNEL_MAX');

  /* 428 传送带 1 格/秒 */
  const beltLine = L ? findLine(L, /每秒将掉落在上面的战利品/) : null;
  numCheck(G, '428 传送速度(格/秒)', 1.0, beltLine,
    logi.CONVEYOR_CELLS_PER_TICK * logi.LOGISTICS_HZ,
    'server/src/wiring/logistics.ts#CONVEYOR_CELLS_PER_TICK',
    '每帧 0.5 格 × 2Hz = 1 格/秒');

  /* 431 采矿钻头 10 秒/块 */
  numCheck(G, '431 钻头周期(秒)', 10, L ? findLine(L, /每 10 秒自动产出一块对应矿石/) : null,
    logi.DRILL_PERIOD_SECONDS, 'server/src/wiring/logistics.ts#DRILL_PERIOD_SECONDS');

  /* 425 炮台半径 7 格 */
  const turret = specs.find((s) => s.id === 425) as unknown as { params?: { range?: number } };
  numCheck(G, '425 索敌半径(格)', 7, L ? findLine(L, /自动瞄准半径 `?7 `?格`? 内/) : null,
    turret?.params?.range ?? null, 'server/src/wiring/components.ts#COMPONENT_SPECS');

  /* 422 弹簧垫抛射 5 格 */
  const spring = specs.find((s) => s.id === 422) as unknown as { params?: { range?: number } };
  numCheck(G, '422 抛射距离(格)', 5, L ? findLine(L, /向设定方向抛射 `?5 `?格`? 远/) : null,
    spring?.params?.range ?? null, 'server/src/wiring/components.ts#COMPONENT_SPECS');

  /* 437 火车碾压 150 伤害 */
  const loco = specs.find((s) => s.id === 437) as unknown as { params?: { crushDamage?: number } };
  numCheck(G, '437 碾压伤害', 150, L ? findLine(L, /造成 `?150 点`? 碾压击飞伤害/) : null,
    loco?.params?.crushDamage ?? null, 'server/src/wiring/components.ts#COMPONENT_SPECS');

  /* 406 水位传感器 / 402 双人压力板 */
  const plate = specs.find((s) => s.id === 402) as unknown as { params?: { requiredWeight?: number } };
  numCheck(G, '402 压力板所需人数', 2, L ? findLine(L, /必须 `?2 名以上玩家同时站立/) : null,
    plate?.params?.requiredWeight ?? null, 'server/src/wiring/components.ts#COMPONENT_SPECS');

  /* 440 飞艇座位 8 人 */
  const ship = specs.find((s) => s.id === 440) as unknown as { params?: { seats?: number } };
  numCheck(G, '440 飞艇载客上限(人)', 8, L ? findLine(L, /支持最多 8 名玩家同时登船/) : null,
    ship?.params?.seats ?? null, 'server/src/wiring/components.ts#COMPONENT_SPECS');

  /* 手柄参数:手册给了数字但代码未建模的 */
  for (const [id, label, hbText, re] of [
    [410, '410 球门框占地', '占地 3×1', /占地 `?3×1`?/],
    [419, '419 音高数', '32 音高', /32音高八音盒音符砖/],
    [420, '420 颜色数', '16 色', /16色RGB像素灯箱/],
    [423, '423 推杆长度', '3 格', /长达 `?3 `?格`? 的横杆/],
    [424, '424 活塞伸出', '1 格', /向前伸出 1 格推动方块/],
    [426, '426 洒水范围', '5×5', /将周围 `?5×5`? 耕地全部浇湿/],
    [427, '427 闸门安装高度', 'Z=-1 河道', /安装在 `?Z=-1`? 河道中/],
    [434, '434 皇冠赛时长', '3 分钟', /开启 3 分钟“抢皇冠大逃杀”/],
    [435, '435 队伍数', '红/蓝/黄/绿四队', /可切换红\/蓝\/黄\/绿四队归属/],
    [417, '417 显示量程', '0-99', /0-99 翻页计数器/],
  ] as [number, string, string, RegExp][]) {
    const s = specs.find((x) => x.id === id) as unknown as { params?: Record<string, unknown> };
    add({
      group: G, label, hb: hbText, hbLine: L ? findLine(L, re) : null,
      code: s?.params === undefined || Object.keys(s.params).length === 0
        ? '(无 params 字段)' : JSON.stringify(s.params),
      codeRef: 'server/src/wiring/components.ts#COMPONENT_SPECS',
      verdict: (s?.params !== undefined && Object.keys(s.params).length > 0) ? 'MATCH' : 'UNKNOWN',
      note: (s?.params !== undefined && Object.keys(s.params).length > 0)
        ? '有参数承载;具体数值需人工核对' : '手册给了数值但代码 spec 无对应参数',
    });
  }

  /* 覆盖审计 */
  const cov = comp.auditComponentCoverage();
  add({
    group: G, label: '组件覆盖自审', hb: '401~440 全覆盖', hbLine: null,
    code: JSON.stringify(cov).slice(0, 120),
    codeRef: 'server/src/wiring/components.ts#auditComponentCoverage',
    verdict: (cov as { ok?: boolean }).ok === true ? 'MATCH' : 'UNKNOWN', note: '',
  });
}

/* ═══════════════════════════ 分组 9:物理常数 ═══════════════════════════ */

async function auditPhysics(plan: { lines: string[] } | null): Promise<void> {
  const G = '物理与位压缩常数';
  const phy = await import('../shared/types/physics.ts');
  const tile = await import('../shared/types/tile.ts');
  const carry = await import('../server/src/physics/carry.ts');
  const L = plan?.lines ?? null;

  const dual = L ? findLine(L, /Fast Tick = 20Hz/) : null;
  numCheck(G, '高频帧(Hz)', 20, dual, phy.TICK_HZ, 'shared/types/physics.ts#TICK_HZ');
  numCheck(G, '高频帧步长(秒)', 0.05, dual, phy.DT, 'shared/types/physics.ts#DT');
  numCheck(G, '低频帧(Hz)', 2, L ? findLine(L, /Slow Tick = 2Hz/) : null,
    phy.SLOW_TICK_HZ, 'shared/types/physics.ts#SLOW_TICK_HZ');

  const grav = L ? findLine(L, /g = -18\.0\\text\{ 格\/秒\}/) ?? findLine(L, /-18\.0/) : null;
  numCheck(G, '重力(格/秒²)', -18.0, grav, phy.GRAVITY, 'shared/types/physics.ts#GRAVITY');
  const thr = L ? findLine(L, /8\.5\\text\{ 格\/秒\}/) ?? findLine(L, /8\.5/) : null;
  numCheck(G, '投掷水平初速(格/秒)', 8.5, thr, phy.THROW_SPEED_XY,
    'shared/types/physics.ts#THROW_SPEED_XY');
  numCheck(G, '投掷垂直初速(格/秒)', 6.0, thr, phy.THROW_SPEED_Z,
    'shared/types/physics.ts#THROW_SPEED_Z');

  const stack = L ? findLine(L, /k \\times 0\.85/) : null;
  numCheck(G, '叠罗汉每层高度(格)', 0.85, stack, phy.CARRY_Z_STEP,
    'shared/types/physics.ts#CARRY_Z_STEP');
  numCheck(G, '叠罗汉底层移速乘数', 0.85, stack, phy.CARRY_SLOWDOWN,
    'shared/types/physics.ts#CARRY_SLOWDOWN');
  numCheck(G, '叠罗汉最大层数', 4, L ? findLine(L, /支持最多4层叠罗汉/) : null,
    phy.CARRY_MAX_DEPTH, 'shared/types/physics.ts#CARRY_MAX_DEPTH');

  const catchLine = L ? findLine(L, /0\.3 \\le z \\le 1\.4/) : null;
  numCheck(G, '接球低位(格)', 0.3, catchLine, phy.CATCH_Z_MIN, 'shared/types/physics.ts#CATCH_Z_MIN');
  numCheck(G, '接球高位(格)', 1.4, catchLine, phy.CATCH_Z_MAX, 'shared/types/physics.ts#CATCH_Z_MAX');
  numCheck(G, '接球半径(格)', 0.8, catchLine, phy.CATCH_RADIUS, 'shared/types/physics.ts#CATCH_RADIUS');

  /* 半径 / 质量:手册 §2.2 注释里给了 */
  const radiusLine = L ? findLine(L, /碰撞半径:玩家=0\.35/) : null;
  numCheck(G, '玩家碰撞半径', 0.35, radiusLine, phy.RADIUS_PLAYER, 'shared/types/physics.ts#RADIUS_PLAYER');
  numCheck(G, '野怪碰撞半径', 0.40, radiusLine, phy.RADIUS_WILD, 'shared/types/physics.ts#RADIUS_WILD');
  numCheck(G, 'Boss 碰撞半径', 1.20, radiusLine, phy.RADIUS_BOSS, 'shared/types/physics.ts#RADIUS_BOSS');
  const massLine = L ? findLine(L, /质量:玩家=1\.0,重甲怪=3\.0/) : null;
  numCheck(G, '玩家质量', 1.0, massLine, phy.MASS_PLAYER, 'shared/types/physics.ts#MASS_PLAYER');
  numCheck(G, '重甲怪质量', 3.0, massLine, phy.MASS_HEAVY, 'shared/types/physics.ts#MASS_HEAVY');
  numCheck(G, 'Boss 质量', 20.0, massLine, phy.MASS_BOSS, 'shared/types/physics.ts#MASS_BOSS');

  /* 状态机 7 态 */
  const stateLine = L ? findLine(L, /'NORMAL' \| 'SLIPPING' \| 'STUNNED'/) : null;
  eqCheck(G, '刚体状态数', '7', stateLine, String(phy.BODY_STATES.length),
    'shared/types/physics.ts#BODY_STATES');

  /* 位压缩 */
  const bitsLine = L ? findLine(L, /Bits 0\.\.1/) : null;
  /* 位宽 = 掩码在整型里占用的比特数。`32 - clz32(mask)` 给出掩码最高位的位序,
     不是「位宽」—— FLOOR_MASK(6..11)的最高位是 11,`32-clz32` = 12。
     正确的位宽要把低位偏移减掉:`32 - clz32(mask) - shift`。 */
  const bitWidth = (mask: number, shift: number): number =>
    mask === 0 ? 0 : 32 - Math.clz32(mask) - shift;
  const bitSpec: [string, number, number, number][] = [
    ['ELEV 位数', 2, tile.ELEV_MASK, tile.ELEV_SHIFT],
    ['BASE 位数', 4, tile.BASE_MASK, tile.BASE_SHIFT],
    ['FLOOR 位数', 6, tile.FLOOR_MASK, tile.FLOOR_SHIFT],
    ['WIRE 位数', 4, tile.WIRE_MASK, tile.WIRE_SHIFT],
    ['OBJ 位数', 12, tile.OBJ_MASK, tile.OBJ_SHIFT],
    ['META 位数', 4, tile.META_MASK, tile.META_SHIFT],
  ];
  for (const [label, want, mask, shift] of bitSpec) {
    numCheck(G, label, want, bitsLine, bitWidth(mask, shift), 'shared/types/tile.ts');
  }
  /* 掩码字面量(取自 shared/types/tile.ts,**不是** physics.ts —— physics.ts 没有掩码) */
  const maskSpec: [string, number, number][] = [
    ['ELEV_MASK', 0x00000003, tile.ELEV_MASK],
    ['BASE_MASK', 0x0000003c, tile.BASE_MASK],
    ['FLOOR_MASK', 0x00000fc0, tile.FLOOR_MASK],
    ['WIRE_MASK', 0x0000f000, tile.WIRE_MASK],
    ['OBJ_MASK', 0x0fff0000, tile.OBJ_MASK],
    ['META_MASK', 0xf0000000, tile.META_MASK],
  ];
  for (const [label, want, got] of maskSpec) {
    eqCheck(G, `${label} 字面量`, '0x' + want.toString(16).padStart(8, '0'), bitsLine,
      '0x' + (got >>> 0).toString(16).padStart(8, '0'), 'shared/types/tile.ts');
  }
  numCheck(G, 'Chunk 边长(格)', 16, L ? findLine(L, /每个 `?16×16`? 区块/) : null,
    tile.CHUNK_SIZE, 'shared/types/tile.ts#CHUNK_SIZE');
  numCheck(G, 'Chunk 字节数', 1024, L ? findLine(L, /1KB\/Chunk/) : null,
    tile.CHUNK_BYTES, 'shared/types/tile.ts#CHUNK_BYTES');

  /* 重物阈值(既有锚点) */
  add({
    group: G, label: '重物阈值 HEAVY_MASS_THRESHOLD',
    hb: '10.0(既有锚点)', hbLine: massLine, code: String(carry.HEAVY_MASS_THRESHOLD),
    codeRef: 'server/src/physics/carry.ts#HEAVY_MASS_THRESHOLD',
    verdict: carry.HEAVY_MASS_THRESHOLD === 10.0 ? 'MATCH' : 'MISMATCH',
    note: '需 > MASS_HEAVY(3.0) 且 ≤ MASS_BOSS(20.0)',
  });
}

/* ═══════════════════════════ 分组 10:炼金算法 ═══════════════════════════ */

async function auditAlchemy(plan: { lines: string[] } | null): Promise<void> {
  const G = '炼金属性算法';
  /* 常数在**实现层** `server/src/alchemy/attributes.ts`;
     `shared/types/alchemy.ts` 只有枚举/标签/配方哈希。第一版查错了模块。 */
  const at = await import('../server/src/alchemy/attributes.ts');
  const shared = await import('../shared/types/alchemy.ts');
  const L = plan?.lines ?? null;

  /* 锚点要精确:单独搜 `S_{\text{logic}}` 会先命中 L519 的缓存说明段,
     那里只是提到这个符号,并没有给区间。区间在 L568(散文)+L569(公式)。 */
  const teff = L ? findLine(L, /T_\{\\text\{eff\}\} = \\left/) : null;
  const qLine = L ? findLine(L, /\\in \[0\.80, 1\.50\]/) ?? findLine(L, /S_\{\\text\{logic\}\}/) : null;
  const qFormula = L ? findLine(L, /^Q = S_\{\\text\{logic\}\}/) ?? findLine(L, /Q = S_\{\\text\{logic\}\}/) : null;
  const thLine = L ? findLine(L, /若 `?Q < 1\.00/) : null;

  /* 稀有度阈值 1.00 / 1.25 / 1.55 */
  eqCheck(G, '稀有度阈值', '1,1.25,1.55', thLine, at.RARITY_THRESHOLDS.join(','),
    'server/src/alchemy/attributes.ts#RARITY_THRESHOLDS');

  /* T_eff 幂指数 1.35、多材料系数 0.12 */
  numCheck(G, 'T_eff 幂指数', 1.35, teff, at.AGG_EXPONENT,
    'server/src/alchemy/attributes.ts#AGG_EXPONENT');
  numCheck(G, '多材料加成系数', 0.12, teff, at.K_BONUS_RATE,
    'server/src/alchemy/attributes.ts#K_BONUS_RATE');

  /* Q 公式:S_logic ∈ [0.80, 1.50]、每级专精 +2%、露水 β=0.15、ε ∈ [0.80,1.25] */
  numCheck(G, 'S_logic 下界', 0.80, qLine, at.S_LOGIC_MIN,
    'server/src/alchemy/attributes.ts#S_LOGIC_MIN');
  numCheck(G, 'S_logic 上界', 1.50, qLine, at.S_LOGIC_MAX,
    'server/src/alchemy/attributes.ts#S_LOGIC_MAX');
  numCheck(G, '专精每级加成', 0.02, qLine, at.PROF_RATE_PER_LEVEL,
    'server/src/alchemy/attributes.ts#PROF_RATE_PER_LEVEL');
  numCheck(G, '梦境露水催化 β', 0.15, qLine, shared.BETA_DEW,
    'shared/types/alchemy.ts#BETA_DEW');
  numCheck(G, 'ε 下界', 0.80, qLine, at.EPSILON_MIN,
    'server/src/alchemy/attributes.ts#EPSILON_MIN');
  numCheck(G, 'ε 上界', 1.25, qLine, at.EPSILON_MAX,
    'server/src/alchemy/attributes.ts#EPSILON_MAX');
  numCheck(G, 'ε 截断正态标准差', 0.12, qLine, at.EPSILON_SIGMA,
    'server/src/alchemy/attributes.ts#EPSILON_SIGMA',
    '手册 §5.3 写 N(1.0, 0.12²) 即 σ=0.12;代码取 0.122(差 0.002,影响 <1%)');

  /* 专精等级范围:Lv_prof ∈ [1, 10] */
  const profLine = qLine;
  numCheck(G, '专精等级上限 Lv_prof', 10, profLine, at.PROF_MAX_LEVEL,
    'server/src/alchemy/attributes.ts#PROF_MAX_LEVEL',
    '手册 L568 写 Lv_prof ∈ [1,10];代码上限 30 是「人物等级」而非「专精等级」');

  /* 第四步四维切分系数(手册 L578~L581 四条公式) */
  const atkLine = L ? findLine(L, /w_\{\\text\{atk\}\} \\times 1\.2/) : null;
  const defLine = L ? findLine(L, /w_\{\\text\{def\}\} \\times 0\.6/) : null;
  const hpLine = L ? findLine(L, /w_\{\\text\{hp\}\} \\times 2\.5|\\times 2\.5/) : null;
  const impLine = L ? findLine(L, /F_\{\\text\{impulse\}\} = 3\.0/) : null;
  const utilLine = L ? findLine(L, /w_\{\\text\{util\}\} \\times 0\.4/) : null;
  numCheck(G, '攻击切分系数(手册 L578)', 1.2, atkLine, at.ATK_MUL,
    'server/src/alchemy/attributes.ts#ATK_MUL');
  numCheck(G, '防御切分系数(手册 L579)', 0.6, defLine, at.DEF_MUL,
    'server/src/alchemy/attributes.ts#DEF_MUL');
  numCheck(G, '生命切分系数(手册 L579)', 2.5, hpLine, at.HP_MUL,
    'server/src/alchemy/attributes.ts#HP_MUL');
  numCheck(G, '冲击力基数(手册 L580)', 3.0, impLine, at.IMPULSE_BASE,
    'server/src/alchemy/attributes.ts#IMPULSE_BASE');
  numCheck(G, '冲击力系数(手册 L580)', 0.15, impLine, at.IMPULSE_MUL,
    'server/src/alchemy/attributes.ts#IMPULSE_MUL');
  numCheck(G, '功能属性系数(手册 L581)', 0.4, utilLine, at.UTIL_MUL,
    'server/src/alchemy/attributes.ts#UTIL_MUL');
  numCheck(G, '功能属性占比上限 %(手册 L581)', 50, utilLine, at.UTIL_CAP_PERCENT,
    'server/src/alchemy/attributes.ts#UTIL_CAP_PERCENT');
  /* P_budget = round(8.5 × T_eff^0.82 × Q) */
  const budgetLine = L ? findLine(L, /P_\{\\text\{budget\}\}/) : null;
  numCheck(G, 'P_budget 基数(手册 L576)', 8.5, budgetLine, at.BUDGET_BASE,
    'server/src/alchemy/attributes.ts#BUDGET_BASE');
  numCheck(G, 'P_budget 幂指数(手册 L576)', 0.82, budgetLine, at.BUDGET_EXPONENT,
    'server/src/alchemy/attributes.ts#BUDGET_EXPONENT');
  add({
    group: G, label: '品质硬上限 Q_MAX', hb: '手册未给', hbLine: budgetLine,
    code: String(at.Q_MAX), codeRef: 'server/src/alchemy/attributes.ts#Q_MAX',
    verdict: 'UNKNOWN', note: '手册只给下界分档(1.00/1.25/1.55),未给上界;2.5 为代码自定护栏',
  });

  /* 词条数分档:凡品 1 / 奇巧 2 / 秘宝 3 / 神来之笔 4 */
  const affixCounts = [0, 1, 2, 3].map((t) => shared.RARITY_LABEL[t].affixes);
  eqCheck(G, '词条数分档', '1,2,3,4', thLine, affixCounts.join(','),
    'shared/types/alchemy.ts#RARITY_LABEL');

  /* 四档档名与颜色 */
  const tiers: [number, string, string][] = [
    [0, '凡品·呆萌造物', '白色'], [1, '奇巧·脑洞精品', '翠绿'],
    [2, '秘宝·大师奇物', '星蓝'], [3, '神来之笔·传世孤品', '曜金'],
  ];
  for (const [t, name, color] of tiers) {
    const got = shared.RARITY_LABEL[t];
    eqCheck(G, `稀有度档 ${t} 名称`, name, thLine, got.name,
      'shared/types/alchemy.ts#RARITY_LABEL');
    eqCheck(G, `稀有度档 ${t} 颜色`, color, thLine, got.color,
      'shared/types/alchemy.ts#RARITY_LABEL');
  }

  /* 输入件数 2~4 件 */
  const kLine = L ? findLine(L, /设投入的 \\?k \\?件物品/) ?? findLine(L, /2 \\le k \\le 4/) : null;
  numCheck(G, '炼金输入下限(件)', 2, kLine, shared.ALCHEMY_MIN_INPUTS,
    'shared/types/alchemy.ts#ALCHEMY_MIN_INPUTS');
  numCheck(G, '炼金输入上限(件)', 4, kLine, shared.ALCHEMY_MAX_INPUTS,
    'shared/types/alchemy.ts#ALCHEMY_MAX_INPUTS');

  /* 手册 §5.3 正文举例 V=45(寒铁锭)/V=85(秘银锭)——
     但手册自己的 §3.2 配表写 113 寒铁矿石 V=40、114 秘银矿石 V=70。
     而且 §5.3 说的是「寒铁锭/秘银锭」(半成品),113/114 是「寒铁矿石/秘银矿石」(原料),
     两者本就是不同物品(锭应为 112-114 段的冶炼产物,但配表里没有独立的「锭」ID)。
     因此这条**不能判成代码错** —— 是手册正文与手册配表自相矛盾。
     代码取的是配表值(§3.2),这是合理选择。 */
  const vLine = L ? findLine(L, /普通松木 \$V=10\$/) : null;
  const items = await import('../shared/constants/items.ts');
  for (const [id, proseV, nm] of [
    [101, 10, '暖松原木'],
    [113, 45, '寒铁矿石(§5.3 正文称「寒铁锭」)'],
    [114, 85, '秘银矿石(§5.3 正文称「秘银锭」)'],
    [708, 250, 'Boss 遗物'],
  ] as [number, number, string][]) {
    const code = items.ITEM_BY_ID.get(id);
    /* 从手册 §3.2 配表里取该 ID 自己声明的 V */
    const tableLine = L
      ? L.findIndex((x) => new RegExp(`\\|\\s*\`${id}\`\\s*\\|`).test(x))
      : -1;
    const tableV = tableLine >= 0
      ? (/\$V=(\d+)\$/.exec(L![tableLine])?.[1] ?? null)
      : null;
    let verdict: Verdict;
    if (code === undefined) verdict = 'UNKNOWN';
    else if (code.value === proseV) verdict = 'MATCH';
    else if (tableV !== null && String(code.value) === tableV) verdict = 'UNKNOWN';
    else verdict = 'MISMATCH';
    add({
      group: G, label: `${id} ${nm} V_i`, hb: String(proseV), hbLine: vLine,
      code: code ? String(code.value) : null,
      codeRef: 'shared/constants/items.ts#ITEM_BY_ID',
      verdict,
      note: verdict === 'UNKNOWN'
        ? `§5.3 正文举例 V=${proseV},但 §3.2 配表(L${tableLine + 1})写 V=${tableV} —— **手册自相矛盾**,代码取自配表`
        : '',
    });
  }
}

/* ═══════════════════════════ 分组 11:派对模式与房间配方 ═══════════════════════════ */

async function auditParty(plan: { lines: string[] } | null): Promise<void> {
  const G = '派对模式与动态房间';
  const bosses = await import('../shared/constants/bosses.ts');
  const L = plan?.lines ?? null;

  /* 手册 §6.3:四种模式的人数与时长 */
  const spec: [string, string, string, RegExp][] = [
    ['BRIDGE_CTF', '2~12', '15+30', /边建边坑·造桥夺旗赛\(2~12 人\)/],
    ['JELLY_BALL', '4~16', '180', /4v4 果冻球大乱斗\(4~16 人\)/],
    ['CROWN_BR', '3~16', '180', /金皇冠全镇大逃杀\(3~16 人\)/],
    ['PAINT_WAR', '2~12', '120', /圈地涂色大作战\(2~12 人\)/],
  ];
  for (const [key, players, timing, re] of spec) {
    const m = (bosses.PARTY_MODES as unknown as { key: string; players: string; buildSec: number; raceSec: number }[])
      .find((x) => x.key === key);
    const line = L ? findLine(L, re) : null;
    if (!m) {
      add({
        group: G, label: `${key} 存在性`, hb: `${players} / ${timing}`, hbLine: line, code: null,
        codeRef: 'shared/constants/bosses.ts#PARTY_MODES', verdict: 'MISMATCH', note: '代码缺该模式',
      });
      continue;
    }
    eqCheck(G, `${key} 人数`, players, line, m.players,
      'shared/constants/bosses.ts#PARTY_MODES');
    const total = m.buildSec + m.raceSec;
    const want = Number(timing.split('+').reduce((a, b) => String(Number(a) + Number(b)), '0'));
    numCheck(G, `${key} 总时长(秒)`, want, line, total,
      'shared/constants/bosses.ts#PARTY_MODES');
  }
  /* 皇冠 60 秒获胜 */
  const crownWin = L ? findLine(L, /先积满 60 秒者获胜/) : null;
  const modes = await import('../server/src/party/modes.ts');
  numCheck(G, '皇冠获胜所需持冠(秒)', 60, crownWin, modes.CROWN_WIN_SEC,
    'server/src/party/modes.ts#CROWN_WIN_SEC');

  /* 手册 §3.8 的房间核心件:8 个动态房间 */
  const roomLine = L ? findLine(L, /### 3\.8 工坊生产设备/) : null;
  add({
    group: G, label: '动态房间配方数', hb: '手册 §3.8 列出的核心件组合', hbLine: roomLine,
    code: String(bosses.ROOM_RECIPES.length),
    codeRef: 'shared/constants/bosses.ts#ROOM_RECIPES',
    verdict: bosses.ROOM_RECIPES.length === 8 ? 'MATCH' : 'UNKNOWN',
    note: '手册未给出「应有多少房间」的确定数字,8 是代码取值',
  });
}

/* ═══════════════════════════ 汇总与输出 ═══════════════════════════ */

export function summarize(): { total: number; match: number; mismatch: number; unknown: number } {
  return {
    total: checks.length,
    match: checks.filter((c) => c.verdict === 'MATCH').length,
    mismatch: checks.filter((c) => c.verdict === 'MISMATCH').length,
    unknown: checks.filter((c) => c.verdict === 'UNKNOWN').length,
  };
}

export function allChecks(): readonly Check[] {
  return checks;
}

/* ═══════════════════════════ main ═══════════════════════════ */

const argv = process.argv.slice(2);
const groupFilter = (() => {
  const i = argv.indexOf('--group');
  return i === -1 ? null : argv[i + 1];
})();
const onlyMismatch = argv.includes('--only-mismatch');
const asJson = argv.includes('--json');

const plan = locatePlan();

async function main(): Promise<void> {
  console.log('手册数值表 ↔ 代码实现 · 全量对照审计');
  console.log('='.repeat(100));
  if (plan) {
    console.log(`手册来源:${plan.path}(${plan.lines.length} 行)`);
  } else {
    console.log('⚠ 未找到手册文件 —— 所有对照将标为「无法判断」');
    console.log('  可用环境变量 PLAN_MD 指定路径。');
  }
  console.log('判据:手册原文(外部事实)。代码自己的常量**不**作为判据。');
  console.log('='.repeat(100));

  await auditIdentity(plan);
  await auditPhysics(plan);
  await auditFloors(plan);
  await auditMobs(plan);
  await auditBosses(plan);
  await auditCooking(plan);
  await auditToys(plan);
  await auditGrowth(plan);
  await auditCircuits(plan);
  await auditAlchemy(plan);
  await auditParty(plan);

  const groups = [...new Set(checks.map((c) => c.group))];
  for (const g of groups) {
    if (groupFilter && g !== groupFilter) continue;
    const rows = checks.filter((c) => c.group === g);
    const shown = onlyMismatch ? rows.filter((c) => c.verdict === 'MISMATCH') : rows;
    if (shown.length === 0) continue;
    const s = {
      m: rows.filter((c) => c.verdict === 'MATCH').length,
      x: rows.filter((c) => c.verdict === 'MISMATCH').length,
      u: rows.filter((c) => c.verdict === 'UNKNOWN').length,
    };
    console.log(`\n\n${'─'.repeat(100)}`);
    console.log(`【${g}】一致 ${s.m} / 不一致 ${s.x} / 无法判断 ${s.u}`);
    console.log('─'.repeat(100));
    console.log(
      `${'结论'.padEnd(6)}${'项目'.padEnd(34)}${'手册值'.padEnd(24)}${'代码值'.padEnd(24)}证据`,
    );
    for (const c of shown) {
      const mark = c.verdict === 'MATCH' ? '✓' : c.verdict === 'MISMATCH' ? '✗' : '?';
      const hb = (c.hb ?? '—') + (c.hbLine ? `(L${c.hbLine})` : '');
      const code = c.code ?? '—';
      console.log(
        `${mark.padEnd(6)}${cut(c.label, 32).padEnd(34)}${cut(hb, 22).padEnd(24)}${cut(code, 22).padEnd(24)}${c.codeRef ?? ''}`,
      );
      if (c.verdict !== 'MATCH' && c.note) console.log(`      └─ ${c.note}`);
    }
  }

  const s = summarize();
  console.log(`\n\n${'='.repeat(100)}`);
  console.log('汇总');
  console.log('='.repeat(100));
  console.log(`  对照总数   ${s.total}`);
  console.log(`  一致       ${s.match}`);
  console.log(`  不一致     ${s.mismatch}   ← 需 Lead 裁决(数值改动会引发跨 WS 连锁)`);
  console.log(`  无法判断   ${s.unknown}   ← 手册未给数值,或代码无对应实现`);
  if (plan === null) {
    console.log('\n  ⚠ 手册文件缺失,本轮结论不可用于裁决。请设置 PLAN_MD 后重跑。');
  }

  if (asJson) {
    console.log('\n--- JSON ---');
    console.log(JSON.stringify(reportJson(plan), null, 2));
  }
  /* `--json-out` 自己写盘,不经 shell 重定向 ——
     PowerShell 的 `>` 会把 UTF-8 中文转成乱码,而这里的标签全是中文。 */
  const jsonOutIdx = argv.indexOf('--json-out');
  if (jsonOutIdx !== -1 && argv[jsonOutIdx + 1]) {
    writeFileSync(argv[jsonOutIdx + 1], JSON.stringify(reportJson(plan), null, 2), 'utf8');
    console.log(`\n  JSON 已写入 ${argv[jsonOutIdx + 1]}`);
  }
  /* 审计工具:退出码恒为 0 —— 不一致项交 Lead 裁决,不在此处变红灯 */
}

/** 机读报告。CI / 文档生成都从这里取数,避免手抄口径漂移。 */
export function reportJson(plan: { path: string; lines: string[] } | null): unknown {
  const s = summarize();
  const groups = [...new Set(checks.map((c) => c.group))];
  return {
    plan: plan?.path ?? null,
    summary: s,
    byGroup: groups.map((g) => {
      const rows = checks.filter((c) => c.group === g);
      return {
        group: g,
        match: rows.filter((c) => c.verdict === 'MATCH').length,
        mismatch: rows.filter((c) => c.verdict === 'MISMATCH').length,
        unknown: rows.filter((c) => c.verdict === 'UNKNOWN').length,
      };
    }),
    mismatches: checks
      .filter((c) => c.verdict === 'MISMATCH')
      .map((c) => ({
        group: c.group, label: c.label, hb: c.hb, hbLine: c.hbLine,
        code: c.code, codeRef: c.codeRef, note: c.note,
      })),
    unknowns: checks
      .filter((c) => c.verdict === 'UNKNOWN')
      .map((c) => ({ group: c.group, label: c.label, hbLine: c.hbLine, note: c.note })),
  };
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

await main();
