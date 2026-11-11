/**
 * 未决台账(backlog ledger)
 *
 * 把 `docs/*.md` 里所有「未决」章节的条目抽成一张可复跑的清单,并**检测过时条目**。
 *
 * 为什么需要这个工具:文档里的「未决」会随实现推进而过时 ——
 * 实测发现 75 条未决里有 3 条明确写着「未实现」,而代码里早已实现
 * (`SIM-orchestration` US1/US3、`EVENT-BUS` U5)。读文档的人会在错误的心智
 * 模型上做决策,而**没有任何测试会变红**。
 *
 * 用法:
 *   node scripts/backlog.ts            # 全部未决 + 过时检测
 *   node scripts/backlog.ts --blocking # 只列阻塞项
 *   node scripts/backlog.ts --doc EVENT-BUS.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * 把 `//` 行注释与 `/* *​/` 块注释擦成空格(保留换行与偏移),字符串字面量原样保留。
 *
 * ## 为什么探针必须跑在去注释的文本上
 *
 * 实测踩到:`SIM-orchestration.md` US2 的探针是 `/WorldSim|world_sim/`,
 * 而 `room.ts` 里 `WorldSim` **只出现在 3 处注释中** ——
 * 其中一处写的是「`RoomRuntime` 至今**不认识** `WorldSim`(US2 仍未开)」。
 *
 * 于是探针匹配到这句**说明它还没做**的注释,反过来报了「过时」:
 * **结论与事实完全相反**。而去注释后 `/WorldSim/` 为 false —— 判定正确。
 *
 * `verify.ts` 的 `scanForbidden` 早就有这道防护(注释里写着「避免示例代码造成
 * 假阳性」),`STALE_PROBES` 缺了同一道处理。这个缺口对探针尤其致命:
 * 探针的**语义**是「文档说没做,而代码里已经有了」,
 * 而「代码里提到这个符号」最常见的形态恰恰是注释在解释它为什么还没有。
 *
 * 与 `verify.ts` 的同名函数是**两份实现**:`backlog.ts` 是零依赖 CLI,
 * 不适合反向 import 验证器。两处都必须保留各自的防护。
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl' = 'code';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tpl';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; } else out += ' ';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 把**注释与字符串内容**都擦成空格,只留代码骨架(保留换行与偏移)。
 *
 * ## 为什么探针需要「代码态」而不只是「去注释」
 *
 * `stripComments` **保留字符串内容**。于是任何字符串字面量里的符号都会触发探针:
 * 例如 `const msg = "US2 仍未接 WorldSim"` —— 这句在**说明还没做**,
 * 却会让探针判定「已经做了」。
 *
 * 后果分两类,方向相反:
 * - **噪音(多报)**:没有的符号被当成有 —— 吵,但看得见,会有人去核。
 * - **掩盖(少报)**:该报的不报 —— **静默**,最危险。
 *
 * 探针的语义是「文档说没做,而代码里已经有了」,判据必须是**代码骨架**,
 * 不是「文件里出现过这个字符串」。这与 `verify.ts` 的幽灵依赖/N7 是同一根因:
 * **凡对源码做正则,必须在代码态文本上做。**
 *
 * 实测(切换前先测量):17 条在岗探针全部仍命中 ⇒ 纯噪音去除,无真阳性损失。
 */
function stripToCode(text: string): string {
  const noComments = stripComments(text);
  let out = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'tpl' = 'code';
  while (i < noComments.length) {
    const c = noComments[i];
    if (mode === 'code') {
      if (c === "'") { mode = 'single'; out += ' '; i += 1; continue; }
      if (c === '"') { mode = 'double'; out += ' '; i += 1; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    /* 字符串内部:擦成空格(换行保留,避免行号错位) */
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) {
      mode = 'code';
      out += ' ';
      i += 1;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

export interface OpenItem {
  doc: string;
  id: string;
  /** 条目正文(截断到可读长度) */
  text: string;
  /** 是否被标注为阻塞 */
  blocking: boolean;
  /** 是否已标注为已定稿/已采纳/已解决 */
  closed: boolean;
  line: number;
}

/**
 * 过时检测表:**(文档, 条目号) → (代码探针文件, 正则)**。
 *
 * 每一条都是「文档声称未实现,但代码里存在该符号」的候选。
 * 命中即报「文档过时」—— 这是**测量**,不是猜测。
 *
 * 维护方式:当你关掉一条未决项时,把它加进这张表,让未来的自己能自动发现
 * 「文档说没做、其实做了」的漂移。
 */
const STALE_PROBES: { doc: string; id: string; claim: RegExp; file: string; probe: RegExp; why: string }[] = [
  {
    doc: 'SIM-orchestration.md',
    id: 'US1',
    claim: /生物行为未接入/,
    file: 'server/src/sim/world_sim.ts',
    probe: /mobHost/,
    why: '编排层已构造 MobHost 并每慢帧 tickMobs —— 生物行为已接入',
  },
  {
    doc: 'SIM-orchestration.md',
    id: 'US3',
    claim: /战斗与炼金未进循环/,
    file: 'server/src/sim/world_sim.ts',
    probe: /this\.vitals|resolveMobStrikes/,
    why: '伤害管线已进慢帧循环(resolveMobStrikes + vitals)',
  },
  {
    doc: 'EVENT-BUS.md',
    id: 'U5',
    claim: /生物→玩家的伤害闭环/,
    file: 'server/src/combat/vitals.ts',
    probe: /applyHit/,
    why: 'VitalsSystem.applyHit 已是「生物对玩家施加伤害」的正规出口',
  },
  {
    doc: 'EVENT-BUS.md',
    id: 'U8',
    claim: /靠交互\/受击触发的事件在生产中不产生/,
    file: 'server/src/sim/world_sim.ts',
    probe: /interactMob\(/,
    why: 'U8 已由 CR-11 解决(补了 interactMob / damageMob 编排层入口)',
  },
  {
    doc: 'SIM-orchestration.md',
    id: 'US8',
    claim: /CarrySystem.*已构造但未接入循环/,
    file: 'server/src/sim/world_sim.ts',
    probe: /carryActors\(\)/,
    why: 'US8 已由 CR-10 解决(活视图 + lift/dropTop/throwPlayer + 每帧冷却)',
  },
  {
    doc: 'EVENT-BUS.md',
    id: 'U1',
    claim: /移动权威.*三方案选哪个/,
    file: 'server/src/mobs/host.ts',
    probe: /advanceFsmBase/,
    why: '方案 D 已实施(FSM 基础移动 + AI 专属动作),该条已被 CR-9 裁决',
  },
  {
    doc: 'FLUID-BUDGET.md',
    id: 'F1',
    claim: /vertical.*形参.*未使用/,
    file: 'server/src/world/fluid.ts',
    probe: /vertical/,
    why: '该形参已删除 —— 若又出现在代码里,说明回退了,probe 命中会报出来',
  },

  /* ═══════════════════════════════════════════════════════════════════
   * 以下 18 条由 task-14 批量核查补充(docs/BACKLOG-AUDIT.md 有逐条证据)。
   *
   * 与上面 7 条的关键差异 —— **这批全部是「防御性探针」,基线必须休眠**:
   *   上面 7 条描述的是「已关掉的历史条目」,探针指向的是**已完成的实现**,
   *   它们靠文档行被 `~~` 划掉而休眠(见 detectStale 的 ~~ 跳过分支)。
   *   本批描述的是**当前确实仍开放**的缺口,文档行未划掉,因此只能靠
   *   「探针在代码里尚不存在」而休眠。一旦有人真的实现了该功能,探针立刻命中,
   *   提醒「这条未决该关了」—— 这正是台账该做的事。
   *
   * 为什么必须休眠:verify.ts 对 detectStale() 的每一条命中都调用 fail()。
   * 往本表塞一条**当前就会命中**的探针 = 让 verify 立刻变红。核查中发现 D1
   * 极易被误判:「击退未实现」而 applyImpulse 确实存在,但**全仓无生产调用点**
   * (只有 WS-02 测试调它),所以 D1 是真开放。探针据此改为匹配 world_sim.ts
   * 里的调用,而不是 physics/world.ts 里的定义。
   * ═══════════════════════════════════════════════════════════════════ */

  /* ── DAMAGE-LOOP.md ── */
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D1',
    claim: /击退|硬直/,
    file: 'server/src/sim/world_sim.ts',
    probe: /applyImpulse\(/,
    why: '击退写回 PhysicsBody 后,编排层会出现 applyImpulse 调用(定义在 physics/world.ts,但生产调用点为 0)',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D2',
    claim: /不检查视线/,
    file: 'server/src/sim/world_sim.ts',
    probe: /lineOfSight|hasLineOfSight|losClear/,
    why: '结算前加射线遮挡判定后,会出现视线函数;当前全仓无任何 lineOfSight 类符号',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D3',
    claim: /PvP/,
    file: 'server/src/combat/damage.ts',
    probe: /\bpvp\b|\bPvp\b|\bPVP\b/,
    why: 'PvP 分支落地后伤害管线会出现 pvp 标识;当前 damage.ts 无任何 PvP 语义',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D4',
    claim: /元素抗性/,
    file: 'server/src/combat/vitals.ts',
    probe: /elementResist|resistMul|resistOf/,
    why: '生物攻击带元素抗性后,玩家侧结算处会出现抗性系数;当前抗性只在 progression 天赋里出现',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D5',
    claim: /玩家侧无对应状态/,
    file: 'server/src/combat/vitals.ts',
    probe: /blindSec|blindUntil|blindedSec/,
    why: '玩家侧出现致盲状态时会新增 blind 计时字段;当前 blindSec 只存在于 mobs/behaviors.ts 的 rt.mem',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D6',
    claim: /复活流程/,
    file: 'server/src/sim/world_sim.ts',
    probe: /createDowned|touchRevive|featherRevive|flagRevive/,
    why: '复活流程接入编排层后会 import combat/revive.ts;当前该模块只被 tests/WS-10.test.ts 引用',
  },
  {
    doc: 'DAMAGE-LOOP.md',
    id: 'D7',
    claim: /持久化|满血/,
    file: 'server/src/sim/world_sim.ts',
    probe: /savePlayerState|loadPlayerVitals/,
    why: '血量落盘接入后会调用存档函数;当前 savePlayerState 全仓只有 WS-07 测试调用(零生产调用点)',
  },

  /* ── FLUID-BUDGET.md ── */
  {
    doc: 'FLUID-BUDGET.md',
    id: 'F4',
    claim: /无上限/,
    file: 'server/src/world/fluid.ts',
    probe: /MAX_ACTIVE_CELLS|ACTIVE_CAP|activeCap/,
    why: '活跃集合加封顶后会出现容量常量;当前 activeArr 只增不封顶',
  },
  {
    doc: 'FLUID-BUDGET.md',
    id: 'F5',
    claim: /游泳|淹没|水车/,
    file: 'server/src/world/fluid.ts',
    probe: /swim|wade|submerg|drown/,
    why: '流体与实体交互落地后会出现游泳/淹没语义;当前全仓只有 prank/immunity.ts 的死因枚举提 DROWNING',
  },

  /* ── SIM-orchestration.md ── */
  {
    doc: 'SIM-orchestration.md',
    id: 'US2',
    claim: /互不依赖/,
    file: 'server/src/net/room.ts',
    probe: /WorldSim|world_sim/,
    why: '网关联动接入后 RoomRuntime 会引用 WorldSim;当前 room.ts 完全不含该符号',
  },
  {
    doc: 'SIM-orchestration.md',
    id: 'US7',
    /* claim 用「回放/录制」而非「未实现」:该行已被 WS-07 改写为
       「仍开放,已核实」,原来的 `/未实现/` 会静默失效(probe 死掉)。
       锚定条目**主题词**比锚定结论措辞耐漂移。 */
    claim: /回放|录制/,
    file: 'server/src/sim/world_sim.ts',
    probe: /recordFrame|replayInput|ReplayLog/,
    why: '回放录制落地后会出现输入序列记录;当前无任何录制入口',
  },

  /* ── WS-03-build.md ── */
  {
    doc: 'WS-03-build.md',
    id: 'U3',
    claim: /全量/,
    file: 'server/src/build/rooms.ts',
    probe: /scanRoomsIncremental|dirtyRoomCells|roomDirty/,
    why: 'scanRooms 改增量维护后会出现脏格集合;当前是纯全量重扫',
  },
  {
    doc: 'WS-03-build.md',
    id: 'U5',
    claim: /只统计|不限制并发/,
    file: 'server/src/build/blueprint.ts',
    probe: /MAX_RELAY_CONCURRENCY|relayConcurrency|clampRelay/,
    why: '中继建造加并发上限后会出现并发常量;当前 relayWorkload 只做累加统计',
  },
  {
    doc: 'WS-03-build.md',
    id: 'U7',
    claim: /带上/,
    file: 'server/src/build/blueprint.ts',
    probe: /stripWire|clearWire|omitWire/,
    why: '若决定蓝图不带电路,会出现清 wire 位的函数;当前 captureBlueprint 保留 wire 位',
  },

  /* ── WS-06-alchemy.md ── */
  {
    doc: 'WS-06-alchemy.md',
    id: 'U4',
    claim: /未加约束/,
    file: 'server/src/alchemy/gate.ts',
    probe: /CATEGORY_MECHANIC_MATRIX|isLegalCombo|comboWhitelist/,
    why: '加「类别 × 机制」白名单矩阵后会出现该表;当前只做枚举合法性校验,无交叉约束',
  },

  /* ── WS-09-client-render.md ── */
  {
    doc: 'WS-09-client-render.md',
    id: 'U1',
    claim: /依赖 `three`/,
    file: 'client/src/three/stage_assembly.ts',
    probe: /threeCompat|ThreeFacade|createCompatScene/,
    why: '抽出极简 three 相容层后会出现该 facade;当前文件第 25 行直接 import * as THREE',
  },
  {
    doc: 'WS-09-client-render.md',
    id: 'U11',
    claim: /4-邻域/,
    file: 'client/src/stage/roof_transparency.ts',
    probe: /NEIGHBOR8_DX|NEIGHBOR8_DY/,
    why: '改 8-邻域或加对角权重后会出现 8 邻偏移表;当前只有 NEIGHBOR4_DX/DY',
  },
];

/** 抽出所有文档的未决条目。 */
export function collectOpenItems(): OpenItem[] {
  const docsDir = join(ROOT, 'docs');
  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  const items: OpenItem[] = [];
  for (const f of files) {
    const lines = readFileSync(join(docsDir, f), 'utf8').split('\n');
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^##+\s*\d*\.?\s*未决/.test(lines[i])) {
        start = i;
        continue;
      }
      if (start >= 0 && i > start && /^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    if (start < 0) continue;
    for (let i = start; i < end; i += 1) {
      const m = /^\|\s*\*{0,2}(U|F|D|US)(\d+)\*{0,2}\s*\|(.+)$/.exec(lines[i]);
      if (!m) continue;
      const raw = lines[i];
      /* 已裁决的条目不算阻塞 —— 「已采纳」「已定稿」意味着结论有了,只是还没写代码。
         实测踩过:`WS-11` U12 写着「**Lead 已采纳**:不改为冻结计时器」,
         却因为含「阻塞玩家操作」这个词被误判成阻塞项。判据必须排除已裁决。 */
      const decided = /已采纳|已定稿|已裁决|已解决|已删除|已修正诊断|~~/.test(raw);
      items.push({
        doc: f,
        id: `${m[1]}${m[2]}`,
        text: m[3].trim().replace(/\s+/g, ' ').slice(0, 110),
        blocking: !decided && /阻塞|阻断|需 CR|需先定/.test(raw),
        closed: /已删除|已解决|已定稿|已采纳|已实现|已修正诊断|~~/.test(raw),
        line: i + 1,
      });
    }
  }
  return items;
}

/**
 * 在文档里定位某个条目号对应的表格行。
 *
 * **为什么要单独抽出来 —— 旧写法有一个静默缺陷。**
 * 原来的行定位正则是 `^\|\s*\*{0,2}${id}\*{0,2}\s*\|`,它接受 `| U5 |`
 * 与 `| **U5** |`,但**匹配不到 `| ~~U5~~ |`**。而 `EVENT-BUS.md` 的
 * U1/U3/U5/U8 恰好都写成划掉态,后果是该文档下 3 条探针**永远不可能命中**:
 * 条目行找不到 → `continue` → 探针变成死代码,而它本应是
 * 「条目被重新打开 + 代码回退」的回归报警器。
 *
 * 同一编号出现多行时(例如同时留有历史划掉行与新行)**优先取未划掉的那行**:
 * 取错会把一条仍在开放的条目当成已归档,静默漏报。
 */
export function findLedgerRow(docText: string, id: string): string | null {
  const re = new RegExp(`^\\|\\s*(?:~~)?\\s*\\*{0,2}${id}\\*{0,2}\\s*(?:~~)?\\s*\\|`);
  const rows = docText.split('\n').filter((l) => re.test(l));
  if (rows.length === 0) return null;
  return rows.find((r) => !/~~/.test(r)) ?? rows[0];
}

/** 一条探针的体检结果。 */
export interface ProbeHealth {
  doc: string;
  id: string;
  why: string;
  /** dormant=在岗待命 / firing=已命中(报告过时) / 其余为**失效**状态 */
  status: 'dormant' | 'firing' | 'row-missing' | 'claim-drift' | 'archived' | 'file-missing';
}

/**
 * 探针体检:把「静默失效的探针」显式暴露出来。
 *
 * 这是本次核查发现的真问题:探针表最容易的腐烂方式不是**误报**(那会被
 * verify 立刻拦下),而是**漏报** —— 文档行被改写措辞、编号被划掉、
 * 文件被重命名,探针就悄悄不再生效,而门禁永远全绿。
 * `detectStale` 只回答「有没有过时」,`auditProbes` 回答「这把尺子还准不准」。
 */
export function auditProbes(): ProbeHealth[] {
  const out: ProbeHealth[] = [];
  for (const p of STALE_PROBES) {
    let docText = '';
    let codeText: string | null = null;
    try {
      docText = readFileSync(join(ROOT, 'docs', p.doc), 'utf8');
      codeText = readFileSync(join(ROOT, p.file), 'utf8');
    } catch {
      out.push({ doc: p.doc, id: p.id, why: p.why, status: 'file-missing' });
      continue;
    }
    const row = findLedgerRow(docText, p.id);
    if (!row) out.push({ doc: p.doc, id: p.id, why: p.why, status: 'row-missing' });
    else if (!p.claim.test(row)) out.push({ doc: p.doc, id: p.id, why: p.why, status: 'claim-drift' });
    else if (/~~/.test(row)) out.push({ doc: p.doc, id: p.id, why: p.why, status: 'archived' });
    /* 跑在**代码态**文本上 —— 见 `stripToCode` 的说明:
       去注释还不够,字符串内容也必须擦掉,否则 `"US2 仍未接 WorldSim"`
       这种「说明它还没做」的字符串会反过来让探针报「已过时」。 */
    else if (p.probe.test(stripToCode(codeText))) {
      out.push({ doc: p.doc, id: p.id, why: p.why, status: 'firing' });
    } else out.push({ doc: p.doc, id: p.id, why: p.why, status: 'dormant' });
  }
  return out;
}

/** 检测过时条目。返回命中的说明。 */
export function detectStale(): { doc: string; id: string; why: string }[] {
  const out: { doc: string; id: string; why: string }[] = [];
  for (const p of STALE_PROBES) {
    let docText: string;
    let codeText: string;
    try {
      docText = readFileSync(join(ROOT, 'docs', p.doc), 'utf8');
      codeText = readFileSync(join(ROOT, p.file), 'utf8');
    } catch {
      continue;
    }
    /* 该条目行是否仍在声称那件事 */
    const row = findLedgerRow(docText, p.id);
    if (!row || !p.claim.test(row)) continue;
    /* 已被划掉(~~)视为已归档,不算过时 */
    if (/~~/.test(row)) continue;
    /* 与 `auditProbes` 同一口径:跑在**代码态**文本上,否则两个函数会
       给出互相矛盾的结论(一个报过时、一个报在岗)。 */
    if (p.probe.test(stripToCode(codeText))) {
      out.push({ doc: p.doc, id: p.id, why: p.why });
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const items = collectOpenItems();
  const stale = detectStale();
  const staleKeys = new Set(stale.map((s) => `${s.doc}|${s.id}`));

  let list = items;
  if (args.includes('--blocking')) list = list.filter((i) => i.blocking && !i.closed);
  const docArg = args.indexOf('--doc');
  if (docArg >= 0) list = list.filter((i) => i.doc === args[docArg + 1]);

  const open = items.filter((i) => !i.closed);
  console.log('══ 未决台账 ══');
  console.log(
    `总计 ${items.length} 条 / 未关闭 ${open.length} 条 / 阻塞 ${items.filter((i) => i.blocking && !i.closed).length} 条` +
      ` / 已关闭 ${items.length - open.length} 条\n`,
  );

  const byDoc = new Map<string, OpenItem[]>();
  for (const it of list) {
    if (!byDoc.has(it.doc)) byDoc.set(it.doc, []);
    byDoc.get(it.doc)!.push(it);
  }
  for (const [doc, rows] of byDoc) {
    console.log(`${doc}  (${rows.length} 条)`);
    for (const r of rows) {
      const mark = staleKeys.has(`${doc}|${r.id}`) ? '⚠过时' : r.blocking ? '🚧阻塞' : r.closed ? ' 已闭' : '     ';
      console.log(`  ${mark} ${r.id.padEnd(4)} ${r.text}`);
    }
    console.log('');
  }

  if (stale.length > 0) {
    console.log('══ ⚠ 过时条目(文档说未实现,代码里已有)══');
    for (const s of stale) {
      console.log(`  ${s.doc} ${s.id}: ${s.why}`);
    }
    console.log('\n  → 这些条目的描述与代码不符,读文档的人会误判进度。应更新描述或标记已关闭。');
  } else {
    console.log('══ 无过时条目 ══');
  }

  /* 探针体检只在 --audit 下打印:它回答的是「尺子还准不准」,
     与日常「有没有过时」是两个问题,不该混进默认输出。 */
  if (args.includes('--audit')) {
    const health = auditProbes();
    /* archived 是**正常终态**而非故障:守的条目已关闭、行被划掉,
       探针使命完成。真正的故障是 row-missing / claim-drift / file-missing ——
       它们意味着探针悄悄不再生效,而门禁永远全绿。两者必须分开计数。 */
    const retired = health.filter((h) => h.status === 'archived');
    const broken = health.filter(
      (h) => h.status === 'row-missing' || h.status === 'claim-drift' || h.status === 'file-missing',
    );
    console.log(`\n══ 探针体检 ${health.length} 条 ══`);
    for (const h of health) {
      const tag =
        h.status === 'dormant'
          ? '在岗'
          : h.status === 'firing'
            ? '命中'
            : h.status === 'archived'
              ? '已归档'
              : `失效(${h.status})`;
      console.log(`  ${tag.padEnd(16)} ${h.doc} ${h.id}`);
    }
    console.log(`\n  在岗/命中 ${health.length - retired.length - broken.length} 条 / 已归档 ${retired.length} 条`);
    if (broken.length === 0) {
      console.log('  → 无静默失效探针(已归档不算失效:它们守的条目已关闭,属正常退役)。');
    } else {
      console.log(`  → ${broken.length} 条探针已静默失效:文档措辞/编号变动后它们不再生效,需修正 claim 或 id。`);
      for (const b of broken) console.log(`     ${b.status}: ${b.doc} ${b.id}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('backlog.ts')) main();
