/**
 * WS-FND-147 —— 世界侧**五笔一直挂着的账**:逐笔要么接上,要么明确登记。
 *
 * ## 五笔账与本文的对应
 *
 * | 账 | 处置 | 判据 |
 * |---|---|---|
 * | D1 z 是客户端回声(服务端高度变化被回拖一个 RTT) | **接上**(空中/服务端动过 z ⇒ 归服务端)+ 剩余口径登记 | FND147-1..5 / FND147-12 |
 * | D2 元素表里没有 `EARTH` / `WATER` | **登记「不扩」的理由** + 把 6×6 自洽钉成事实 | FND147-6 |
 * | D3 `PENDING_ELEMENT_RESIST_MUL = 0.5` 待平衡 | **登记 `待平衡(owner)`**(数值一字未改) | FND147-7 / 8 / 10 |
 * | D4 `MOB_RARE_DROP_CHANCE = 0.15` 待平衡 | 同上 | FND147-7 / 8 / 10 |
 * | D5 `gz < 0` 落穴分支是死代码 | **按现状订正**(物理层注释)+ 行为面钉住 | FND147-9 |
 *
 * ## 判据纪律(本文为什么这么写)
 *
 * - 每条「接上」都配**负对照**,否则「改了但没生效」与「没改」分不开:
 *   FND147-1(空中不许回拖)的反面是 FND147-2(静止时**仍**接受声明值);
 *   FND147-9(深沟不会落下 -1)的反面是同一条里「高台真的到 1」。
 * - 台账的证据**真读源码**(`worldDebtLedgerVerdict`),而不是信它自己的 `status`;
 *   再加一条**合成源码**的负对照(FND147-8),证明「找不到那句话就会红」。
 * - 期望值一律写字面量(`0` / `1` / `0.5` / `0.15` / `6`),不从被测模块取期望值。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { assemble } from '../server/src/index.ts';
import {
  WORLD_DEBTS,
  WORLD_DEBT_STATUS,
  pendingBalanceRows,
  worldDebtOf,
  worldDebtVerdict,
  worldDebtLedgerVerdict,
} from '../server/src/sim/world_debts.ts';
import {
  ELEMENTS,
  ELEMENT_COUNTER,
  ELEMENT_COUNTER_MUL,
  ELEMENT_REVERSE_MUL,
} from '../server/src/combat/weapons.ts';
import { PENDING_ELEMENT_RESIST_MUL } from '../server/src/rooms/effects.ts';
import { MOB_RARE_DROP_CHANCE } from '../shared/constants/mobs.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 一张安静的图:`mobs: false` 不刷怪,`wiring: false` 不挂集成。 */
function bareSim(): WorldSim {
  return new WorldSim({ sizeCells: 24, mobs: false, wiring: false });
}

/** 真读源码(仓根相对路径);文件不存在 ⇒ `null`(与 `worldDebtVerdict` 的契约一致)。 */
function readSource(path: string): string | null {
  const abs = join(ROOT, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/* ══════════════════ D1 z 轴:回拖那一段被切断 ══════════════════ */

test('FND147-1 ★ 空中:客户端旧 z 不得把服务端高度回拖(修前最多拖一个 RTT)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.tryPlayerJump('p1').jumped, true, '前置:真的起跳了(否则下面全是空断言)');

  /* 3 快帧 = 0.15 s:vz = 6.0 - 18×0.15 = 3.3 ⇒ 必然还在空中。 */
  for (let i = 0; i < 3; i += 1) sim.tick();
  const midZ = sim.playerPosition('p1')!.z;
  ok(midZ > 0.05, `前置:服务端已经把人抬到 z=${midZ.toFixed(3)}`);

  /* 这就是「一个 RTT 之前的旧报文」:客户端还在报地面高度 0。 */
  eq(sim.applyPlayerMove('p1', 12.5, 12.5, 0), true, '平面写入仍被接受(不许因为 z 拒整条报文)');
  const after = sim.playerPosition('p1')!.z;
  ok(Math.abs(after - midZ) < 1e-9, `★★ 服务端高度不得被回拖(期望 ${midZ} 实测 ${after})`);
  eq(sim.lastZAuthority?.source, 'SERVER', '★ 裁决来源必须是 SERVER(不是「恰好相等」)');
  eq(sim.lastZAuthority?.declared, 0, '裁决记录了客户端声明值(=0)');
});

test('FND147-2 负对照:静止时报文里的 z 仍被接受(WS-FND-49 的对外契约不许被撕掉)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  eq(sim.applyPlayerMove('p1', 12.5, 12.5, 3), true, '带 z 的移动被接受(FND49-3 契约)');
  eq(sim.playerPosition('p1')!.z, 3, '★ 写进刚体的是 3(负对照:上一条不是靠「一律拒绝」通过)');
  eq(sim.lastZAuthority?.source, 'CLIENT', '★ 静止 + 权威没动过 ⇒ 来源 CLIENT');
});

test('FND147-3 负对照:省略 z ⇒ 高度一字不写,且裁决可辨(不是「等于权威」)', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  sim.applyPlayerMove('p1', 12.5, 12.5, 4);
  eq(sim.playerPosition('p1')!.z, 4, '前置:先有一个合法高度');

  eq(sim.applyPlayerMove('p1', 14.5, 14.5), true, '不带 z 的移动仍被接受(FND49-5 契约)');
  eq(sim.playerPosition('p1')!.z, 4, '★ 高度保持 4(省略 ≠ 归零)');
  eq(sim.lastZAuthority, null, '★ 「这条报文没对高度表态」必须与「裁决结果等于权威」分得开');
});

test('FND147-4 ★ 台阶(elev)抬起来的高度同样不许被旧 z 抹平', () => {
  const sim = bareSim();
  /* elev = 2 ⇒ groundZAt = (2 & 3) - 1 = 1(冻结层的口径,这里不另算)。 */
  sim.setCell(5, 5, { elev: 2 });
  eq(sim.physics.groundZAt(5, 5), 1, '前置:该格地面高度 = 1');
  sim.addPlayer('p1', 5.5, 5.5);
  sim.tick();
  eq(sim.playerPosition('p1')!.z, 1, '前置:服务端把 z 抬到台阶高度');

  sim.applyPlayerMove('p1', 5.5, 5.5, 0);
  eq(sim.playerPosition('p1')!.z, 1, '★★ 台阶高度不得被客户端旧 z 抹平');
  eq(sim.lastZAuthority?.source, 'SERVER', '★ 来源 SERVER');
});

test('FND147-5 权威**会释放**:落地后的第一包仍按权威,权威稳定后恢复接受声明值', () => {
  const sim = bareSim();
  sim.addPlayer('p1', 12.5, 12.5);
  sim.tryPlayerJump('p1');
  for (let i = 0; i < 3; i += 1) sim.tick();
  sim.applyPlayerMove('p1', 12.5, 12.5, 0);
  eq(sim.lastZAuthority?.source, 'SERVER', '空中:声明值被忽略');

  /* 滞空 ≈ 2×6/18 = 0.67 s ≈ 13 帧;给到 20 帧必然落地。 */
  for (let i = 0; i < 20; i += 1) sim.tick();
  eq(sim.playerPosition('p1')!.z, 0, '前置:已经落地 z=0');

  sim.applyPlayerMove('p1', 12.5, 12.5, 0.9);
  eq(sim.lastZAuthority?.source, 'SERVER', '落地那一帧服务端动过 z ⇒ 这一包仍按权威');
  eq(sim.playerPosition('p1')!.z, 0, '★ 落地高度不被 0.9 覆盖');

  sim.applyPlayerMove('p1', 12.5, 12.5, 0.9);
  eq(sim.lastZAuthority?.source, 'CLIENT', '★★ 权威稳定后恢复接受声明值(不是永久锁死)');
  eq(sim.playerPosition('p1')!.z, 0.9, '★ 真的写进去了');
});

/* ══════════════════ D2 元素表:登记「不扩」 ══════════════════ */

test('FND147-6 ★ 元素表就是 6 个,没有 `EARTH` / `WATER`;6×6 的反克对互反仍成立', () => {
  eq(ELEMENTS.length, 6, '元素表只有 6 个(D2 = 不扩)');
  eq(ELEMENTS.join(','), 'NONE,FIRE,ICE,LIGHTNING,LIGHT,SLIME', '★ 表项与顺序(加元素必须同时改台账 D2)');
  eq(ELEMENTS.includes('EARTH' as (typeof ELEMENTS)[number]), false, '★ 没有 EARTH');
  eq(ELEMENTS.includes('WATER' as (typeof ELEMENTS)[number]), false, '★ 没有 WATER');
  eq(Object.keys(ELEMENT_COUNTER).length, 6, '克制矩阵 6 行(与元素表两份声明必须一致)');

  /* 「不扩」的代价/理由要可核对:现表必须自洽,否则「先扩再修」也没有基线。 */
  let pairs = 0;
  const broken: string[] = [];
  for (const a of ELEMENTS) {
    for (const b of ELEMENTS) {
      const ab = ELEMENT_COUNTER[a][b];
      const ba = ELEMENT_COUNTER[b][a];
      if (ab === ELEMENT_COUNTER_MUL) {
        pairs += 1;
        if (ba !== ELEMENT_REVERSE_MUL) broken.push(`${a}→${b}=1.5 而 ${b}→${a}=${ba}`);
      }
    }
  }
  ok(pairs > 0, '前置:确实存在克制对(否则下面的循环是空转)');
  eq(broken.length, 0, `★ 反克对必须互反:${broken.join(' / ')}`);
});

/* ══════════════════ D3 / D4 待平衡:数值不许改,且必须可被工具看见 ══════════════════ */

test('FND147-7 ★ 台账逐条自检:五条账的证据必须**真在源码里**(不是自我宣告)', () => {
  const problems = worldDebtLedgerVerdict(readSource);
  eq(problems.length, 0, `台账与源码已分叉:${problems.join(' / ')}`);
  eq(WORLD_DEBTS.length, 5, '恰好五笔账(D1..D5)');
});

test('FND147-8 负对照:证据/owner 不合格时必须**变红**(判据不是恒真)', () => {
  const d3 = worldDebtOf('D3');
  ok(d3 !== null, '前置:D3 存在');
  /* 合成源码:任何 needle 都找不到 ⇒ 必须报「找不到」,而不是静默通过。 */
  const blind = worldDebtVerdict(d3!, () => '/* 空文件 */');
  ok(blind.length > 0, '★ 找不到那句话时必须报警');
  ok(blind.some((m) => m.includes('找不到')), `报告要写清「找不到」:${blind.join(' / ')}`);

  /* owner 写成 TODO ⇒ 红(平衡裁决不许被实现层静默接管)。 */
  const fakeOwner = worldDebtVerdict({ ...d3!, owner: 'TODO' }, readSource);
  ok(fakeOwner.some((m) => m.includes('owner')), '★ owner 写成 TODO 必须红');

  /* 文件不存在 ⇒ 红(指向不存在的位置 = 过度声称)。 */
  const ghost = worldDebtVerdict(
    { ...d3!, evidence: [{ file: 'server/src/sim/__nope__.ts', needle: 'x' }] },
    readSource,
  );
  ok(ghost.some((m) => m.includes('不存在')), '★ evidence 指向不存在的文件必须红');
});

test('FND147-9 ★ `gz < 0` 那一支是死代码:深沟格 z 落 0,**高台格真的到 1**(负对照)', () => {
  const sim = bareSim();
  sim.setCell(8, 8, { elev: 0 });
  eq(sim.physics.groundZAt(8, 8), -1, '前置:深沟格地面高度 = -1');
  sim.addPlayer('p1', 8.5, 8.5);
  for (let i = 0; i < 10; i += 1) sim.tick();
  eq(sim.playerPosition('p1')!.z, 0, '★★ 冻结层把 z 钳在 ≥ 0 ⇒ 永远落不到 -1(那一支是死代码)');

  /* 负对照:同一条判据在能走到的分支上必须**真的变** —— 否则「z 恒 0」也能过。 */
  sim.setCell(9, 9, { elev: 2 });
  eq(sim.physics.groundZAt(9, 9), 1, '前置:高台格地面高度 = 1');
  sim.addPlayer('p2', 9.5, 9.5);
  for (let i = 0; i < 10; i += 1) sim.tick();
  eq(sim.playerPosition('p2')!.z, 1, '★ 高台上 z 真的到 1(负对照)');

  const phys = readSource('server/src/physics/world.ts');
  ok(phys !== null, '前置:物理层源码可读');
  ok(phys!.includes('死代码'), '★ 物理层注释必须点明 gz<0 那一支是死代码(按现状订正)');
});

test('FND147-10 ★ 两个待平衡数值**一字未改**,且台账登记的就是它们(改数不台账 ⇒ 红)', () => {
  eq(PENDING_ELEMENT_RESIST_MUL, 0.5, 'D3 的数值本批未改(平衡裁决不属于实现层)');
  eq(MOB_RARE_DROP_CHANCE, 0.15, 'D4 的数值本批未改');

  const pending = pendingBalanceRows();
  eq(pending.length, 2, '待平衡条目恰好两条(可被工具枚举,而不是 grep 中文)');
  eq(pending.map((d) => d.id).sort().join(','), 'D3,D4', '★ 就是这两条');

  const d3 = worldDebtOf('D3')!;
  const d4 = worldDebtOf('D4')!;
  eq(d3.owner, '待平衡(owner)', '★ D3 的 owner 必须显式标「待平衡(owner)」');
  eq(d4.owner, '待平衡(owner)', '★ D4 同上');
  ok(
    d3.evidence.some((e) => e.needle.includes(`= ${PENDING_ELEMENT_RESIST_MUL}`)),
    '★ 台账里的字面值与真常量一致(改数不改台账会失配)',
  );
  ok(
    d4.evidence.some((e) => e.needle.includes(`= ${MOB_RARE_DROP_CHANCE}`)),
    '★ 同上(D4)',
  );
});

/* ══════════════════ 生产读口 + 端到端(房间投影读权威) ══════════════════ */

test('FND147-11 生产读口:世界读得到同一份台账(「存在」≠「本世界读的是这份」)', () => {
  const sim = bareSim();
  const rows = sim.worldDebtLedger();
  eq(rows.length, WORLD_DEBTS.length, '世界侧读到的条数一致');
  eq(rows.map((r) => r.id).join(','), 'D1,D2,D3,D4,D5', '★ 五条账的顺序与 ID');
  eq(worldDebtOf('D5')!.status, WORLD_DEBT_STATUS.CLOSED, 'D5 的状态 = 已按现状订正');
  eq(worldDebtOf('D2')!.status, WORLD_DEBT_STATUS.REGISTERED, 'D2 的状态 = 已登记(不扩)');
});

test('FND147-12 ★★ 端到端:房间投影读的是**权威 z**,不是客户端旧报文', () => {
  const a = assemble({ roomId: 'r_z_authority', ownerId: 'p1', sizeCells: 24, mobs: false });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as WorldSim;
  if (!sim.physics.bodies.has('p1')) sim.addPlayer('p1', 12.5, 12.5);
  /* 出生点由房间定(0.5 + n×1.5),不能拿字面量 12.5 —— 那会先被反作弊判成 TELEPORT。 */
  const spawn = a.runtime.state.players.find((x) => x.id === 'p1')!;

  eq(sim.tryPlayerJump('p1').jumped, true, '前置:起跳');
  for (let i = 0; i < 4; i += 1) sim.tick();
  const midZ = sim.playerPosition('p1')!.z;
  ok(midZ > 0.05, `前置:空中 z=${midZ.toFixed(3)}`);

  /* 客户端报的还是地面高度 0(旧报文);平面坐标**原地不动**,免得被反作弊拦掉。 */
  const v = a.runtime.applyMove('p1', { tick: 1, x: spawn.x, y: spawn.y, z: 0 }) as { allowed: boolean };
  eq(v.allowed, true, '前置:这条报文过了反作弊(否则下面测的是另一条路径)');
  const p = a.runtime.state.players.find((x) => x.id === 'p1');
  ok(p !== undefined, '前置:房间里有这名玩家');
  ok(
    Math.abs((p!.z ?? 0) - midZ) < 1e-9,
    `★★ 下发给客户端的高度必须是权威 ${midZ},实测 ${String(p!.z)}(修前是客户端旧值 0)`,
  );
});

report('WS-FND-147');