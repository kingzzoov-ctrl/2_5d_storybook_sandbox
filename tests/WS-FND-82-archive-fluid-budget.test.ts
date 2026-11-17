/**
 * WS-FND-82 —— **超大稀疏水位的预算上限**(归档不许静默丢水)
 *
 * ## 这个套件补的是哪一段
 *
 * `tests/WS-FND-80` 把流体水位做进了 v2 头(稀疏表 + 全序),`tests/WS-FND-72`
 * 把 chunk 裁剪做成了可判定的纯函数。两条合起来还剩**一个边界**:水位表住在头里
 * ⇒ 它计入**固定开销**;512×512 全湿会产出 262144 行(JSON ≈ 2MB)⇒ 固定开销
 * 自己就超 1 MiB ⇒ `fitWorldArchive` 只能**如实抛错**(归档失败)。
 *
 * 本套件钉的是「给水位一个**独立预算**,超了按可判定规则降采样并记账」:
 *
 * | # | 判据 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | 小世界:水位**全留**,`fit` **原样返回入参**(`trimmed === false`、`report === null`、同一缓冲),头里没有 `trim` | 为了「统一」给没超限的快照也重编码 / 编一份空回执 |
 * | 2 | 超预算 ⇒ 按「amount 降序、同值 `(y,x)` 升序」保留**前缀**;两次调用**逐字节相同** | 随机 / 按插入顺序 / 「能塞就塞」而不是前缀 / 与优先级无关的顺序 |
 * | 3 | 被裁行数与原因**可读**:头里的 `trim`、回执、`planRestore().unavailable` 与 `.changes` 四处口径一致,且规则标识是字面量 | 静默丢 / 只报「裁过」不报多少 / 回执与头对不上 |
 * | 4 | 裁后字节 **≤ 上限**,解码出的水位仍**全序**,`encode(decode(x))` 逐字节回到 `x` | 裁完仍超限 / 把水位表写成乱序 / 摘要字段往返丢失 |
 * | 5 | **负对照**:同一份大世界把上限放到 1 MiB ⇒ **不裁**,水位一行不少,字节 = 入参 | 「总是裁一遍」顺手改字节 |
 * | 6 | **负对照**:只超地形(水位很小)⇒ 水位那几个键**根本不出现**,水位原样 | 把「没裁水位」写成「裁了 0 行」 |
 * | 7 | **负对照**:连零块地形 + 零行水位都装不下 ⇒ **抛错**(不写半截世界) | 硬塞 / 静默截断 |
 *
 * ## 断言右侧一律是**字面量**
 *
 * 上限写 `65536` / `200000` / `1048576`,规则写 `'amount>y>x'`,预算写 `917504`
 * —— 不取被测模块的导出常量当期望值(那是「用一个值断言它自己」)。唯一用常量的
 * 地方是「这个常量本身是不是推出来的那个数」(第 1 条末)。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { Chunk, idx } from '../server/src/world/chunk.ts';
import { packTile } from '../shared/types/tile.ts';
import {
  applyRestorePlan,
  decodeWorldArchive,
  encodeWorldArchive,
  fitWorldArchive,
  FLUID_LEVELS_BUDGET_BYTES,
  planFluidLevelsTrim,
  planRestore,
  type ArchiveFluidField,
  type ArchiveFluidLevel,
  type DecodedWorldArchive,
  type RestorePlan,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具与工具 ═══════════════════════ */

const CELL_X = 3;
const CELL_Y = 4;
const FURNITURE = 351; /* 暖松原木圆墙(内容表 351):玩家建造,seed 重建不出来 */

/** 与生产同一个数(`db/repo.ts:WORLD_ARCHIVE_MAX_BYTES`),手写字面量。 */
const MIB = 1048576;

const WORLD = {
  roomId: 'r_fnd82',
  seed: 4242,
  sizeCells: 512,
  biome: 'MEADOW',
  frame: 7,
  hourOfDay: 6.25,
};

/** 小世界的水位:三行,已经按 `(y, x)` 升序(编码侧的规范序)。 */
const SMALL_LEVELS: readonly ArchiveFluidLevel[] = [
  { x: 1, y: 0, amount: 1000 },
  { x: 5, y: 2, amount: 250 },
  { x: 9, y: 3, amount: 7 },
];

/** 一块地形块体(真实的 `Chunk.serializeSnapshot`,不是手搓字节)。 */
function chunkBlob(cx: number, cy: number, built: boolean): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) {
    c.cells[idx(CELL_X, CELL_Y)] = packTile({
      elev: 0, base: 0, floor: 0, wire: 0, obj: FURNITURE, meta: 0,
    });
  }
  return c.serializeSnapshot();
}

/**
 * 大水位夹具:512×512 场里的 `rows` 行非零水位,**按 `(y, x)` 升序**生成。
 *
 * `amount = 1 + ((i * 37) % 1000)` 的周期是 1000 ⇒ **必然出现同值行**
 * (第 2 条的 tie-break 才有东西可测)。
 */
function bigLevels(rows: number): ArchiveFluidLevel[] {
  const out: ArchiveFluidLevel[] = [];
  for (let i = 0; i < rows; i += 1) {
    out.push({ x: i % 512, y: Math.floor(i / 512), amount: 1 + ((i * 37) % 1000) });
  }
  return out;
}

/** 20000 行水位 + 4 块地形(2×2):水位把固定开销顶穿,块体本身很小。 */
function bigFluidSnapshot(): Uint8Array {
  const chunks = [];
  for (let cy = 0; cy < 2; cy += 1) {
    for (let cx = 0; cx < 2; cx += 1) chunks.push({ cx, cy, bytes: chunkBlob(cx, cy, false) });
  }
  return encodeWorldArchive({
    world: WORLD,
    players: [{ id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3, hp: 73.5 }],
    fluid: { width: 512, height: 512, levels: bigLevels(20000) },
    mobs: [],
    ground: [],
    chunks,
  });
}

/** 小世界:3 行水位 + 2 块地形(其中一块是玩家建造)。 */
function smallSnapshot(): Uint8Array {
  return encodeWorldArchive({
    world: WORLD,
    players: [{ id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3, hp: 73.5 }],
    fluid: { width: 32, height: 32, levels: SMALL_LEVELS.slice() },
    mobs: [],
    ground: [],
    chunks: [
      { cx: 0, cy: 0, bytes: chunkBlob(0, 0, true) },
      { cx: 1, cy: 0, bytes: chunkBlob(1, 0, false) },
    ],
  });
}

/** 地形很大、水位很小:超出的是**块体**,不是水位(第 6 条的负对照)。 */
function bigTerrainSnapshot(): Uint8Array {
  const chunks = [];
  for (let i = 0; i < 300; i += 1) {
    const cx = i % 32;
    const cy = Math.floor(i / 32);
    chunks.push({ cx, cy, bytes: chunkBlob(cx, cy, i === 3) });
  }
  const levels: ArchiveFluidLevel[] = [];
  for (let i = 0; i < 20; i += 1) levels.push({ x: i, y: 0, amount: 100 * (i + 1) });
  return encodeWorldArchive({
    world: { ...WORLD, roomId: 'r_fnd82_bigterrain' },
    players: [{ id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3, hp: 73.5 }],
    fluid: { width: 512, height: 512, levels },
    mobs: [],
    ground: [],
    chunks,
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function headerTextOf(bytes: Uint8Array): string {
  const headerLen = viewOf(bytes).getUint32(8, true);
  return new TextDecoder().decode(bytes.subarray(12, 12 + headerLen));
}

/** `fluid === null` 时判据的前提不成立 ⇒ 显式取用口。 */
function fluidOf(d: DecodedWorldArchive): ArchiveFluidField {
  if (d.fluid === null) throw new Error('这份夹具必须有水位(否则判据的前提不成立)');
  return d.fluid;
}

/** 断言 `fn` 抛错并返回消息(负对照:装不下必须说清,不许硬塞)。 */
function throwsWith(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label} 必须抛错(硬塞 = 写一份半截世界)`);
}

/**
 * **测自己写的一把尺子**:优先级序 = `amount` 降序、同值 `(y, x)` 升序。
 * 这是判据里的「期望」,刻意**不**调用被测模块的比较函数(那就成了自证)。
 */
function priorityOrder(levels: readonly ArchiveFluidLevel[]): ArchiveFluidLevel[] {
  return levels.slice().sort((a, b) => (b.amount - a.amount) || (a.y - b.y) || (a.x - b.x));
}

function keyOf(l: ArchiveFluidLevel): string {
  return `${l.x},${l.y}`;
}

/** 计划里那条 fluid op 的水位表(第 3 条要证明「计划只铺保留的那批」)。 */
function fluidOpLevels(plan: RestorePlan): ArchiveFluidLevel[] {
  const op = plan.ops.find((o) => o.kind === 'fluid');
  if (op === undefined || op.kind !== 'fluid') throw new Error('大世界的计划里必须有 fluid op');
  return op.levels;
}

/* ═══════════════════════ 1. 小世界:一行都不裁 ═══════════════════════ */

test('FND82-1 小世界:水位全留,且 fit 原样返回入参(不重编码、不编回执)', () => {
  /* 预算常量本身:「`1 MiB` - `128 KiB`」= 917504(手写字面量,不是抄常量)。 */
  eq(FLUID_LEVELS_BUDGET_BYTES, 917504, '★ 水位预算 = 1048576 - 131072(推导可复核)');

  const small = smallSnapshot();
  ok(small.byteLength <= MIB, `前提:小世界本来就不超上限(实得 ${small.byteLength})`);

  const fit = fitWorldArchive(small, MIB);
  eq(fit.trimmed, false, '★ 不超上限 ⇒ 没裁过');
  eq(fit.report, null, '★ 不裁 ⇒ 没有回执(不许为了好看编一份「裁了 0 行」)');
  ok(fit.bytes === small, '★ 不裁 ⇒ 返回入参本身(没有重编码,逐字节不可能变)');
  ok(bytesEqual(fit.bytes, small), '逐字节相同');

  const d = decodeWorldArchive(fit.bytes);
  eq(fluidOf(d).levels, SMALL_LEVELS, '★ 小世界的水位一行不少');
  eq(d.trim, null, '★ 头里没有 `trim`(键的缺席才是「完整」的证据)');
  ok(!headerTextOf(fit.bytes).includes('fluidLevelsDropped'), '头里不许出现水位裁剪的键');
});

/* ═══════════════════════ 2. 超预算:按规则裁剪 + 确定性 ═══════════════════════ */

test('FND82-2 超预算:按「amount 降序、同值 (y,x) 升序」留前缀,且两次逐字节相同', () => {
  const big = bigFluidSnapshot();
  eq(decodeWorldArchive(big).fluid?.levels.length, 20000, '前提:入参有 20000 行水位');
  ok(big.byteLength > 65536, `前提:这份快照必须真的超上限(实得 ${big.byteLength})`);

  const fit = fitWorldArchive(big, 65536);
  ok(fit.trimmed, '★ 超预算 ⇒ 裁过');
  const trim = fit.report;
  if (trim === null) throw new Error('裁过必须有报告');

  const keptDecoded = decodeWorldArchive(fit.bytes);
  const keptLevels = fluidOf(keptDecoded).levels;
  eq(keptLevels.length, trim.fluidLevelsKept ?? -1, '报告里的保留行数 = 解码出来的行数');
  eq(
    trim.fluidLevelsDropped,
    20000 - keptLevels.length,
    '★ 被裁行数 = 原有 - 保留(字节账不漏)',
  );
  ok(keptLevels.length > 0, `★ 不许「一刀裁光」(实得保留 ${keptLevels.length} 行)`);
  ok(
    keptLevels.length < 20000,
    `★ 必须真的裁掉一些(实得仍保留 ${keptLevels.length} 行 —— 那这条判据没测到东西)`,
  );

  /* ★ 规则本身:保留集必须**恰好**是优先级序的前 K 项(前缀,不是「能塞就塞」)。 */
  const order = priorityOrder(bigLevels(20000));
  const keptSet = new Set(keptLevels.map(keyOf));
  for (let i = 0; i < keptLevels.length; i += 1) {
    ok(
      keptSet.has(keyOf(order[i])),
      `★ 第 ${i} 个该保留的是 (${order[i].x},${order[i].y}) 水位 ${order[i].amount}`,
    );
  }
  eq(keptSet.size, keptLevels.length, '保留集里没有重复格');

  /* ★ 支配性:留下的每一行的水位都不低于被丢掉的任何一行(值大的水更重要)。 */
  const keptAmounts = keptLevels.map((l) => l.amount);
  const minKept = Math.min(...keptAmounts);
  const keptKeys = new Set(keptLevels.map(keyOf));
  let maxDropped = 0;
  let droppedRows = 0;
  for (const l of bigLevels(20000)) {
    if (keptKeys.has(keyOf(l))) continue;
    droppedRows += 1;
    if (l.amount > maxDropped) maxDropped = l.amount;
  }
  eq(droppedRows, trim.fluidLevelsDropped, '逐行点出来的被裁行数 = 报告里的数');
  ok(
    minKept >= maxDropped,
    `★ 保留的最小水位 ${minKept} 必须 ≥ 被裁的最大水位 ${maxDropped}(规则是「值大的先留」)`,
  );

  /* ★ 确定性:同一份入参两次 ⇒ 逐字节相同(纯函数 + 全序)。 */
  const fit2 = fitWorldArchive(big, 65536);
  ok(bytesEqual(fit.bytes, fit2.bytes), '★ 同输入两次裁剪 ⇒ 字节完全一致');
  eq(fit2.report?.fluidLevelsDropped, trim.fluidLevelsDropped, '两次的行数一致');
});

/* ═══════════════════════ 3. 被裁行数与原因可读 ═══════════════════════ */

test('FND82-3 被裁行数与原因四处口径一致:头里的 trim / 回执 / unavailable / changes', () => {
  const big = bigFluidSnapshot();
  const fit = fitWorldArchive(big, 65536);
  const trim = fit.report;
  if (trim === null) throw new Error('裁过必须有报告');
  const dropped = trim.fluidLevelsDropped ?? -1;
  const kept = trim.fluidLevelsKept ?? -1;
  ok(dropped > 0, `★ 回执里必须能读到被裁行数(实得 ${dropped})`);

  /* ── ① 回执 ── */
  eq(trim.fluidLevelsTotal, 20000, '回执里的原有行数');
  eq(trim.fluidRule, 'amount>y>x', '★ 规则标识可被机器判断(字面量)');
  ok(
    (trim.fluidReason ?? '').includes(`裁掉 ${dropped} 行`),
    `★ 回执原因要点名裁了多少行(实得 ${String(trim.fluidReason)})`,
  );
  ok(
    (trim.fluidReason ?? '').includes('水位预算'),
    '原因里要说清是「水位预算」而不是块体预算',
  );

  /* ── ② 头里的 `trim`(从字节读回来,不信内存里的对象) ── */
  const d = decodeWorldArchive(fit.bytes);
  const inHeader = d.trim;
  if (inHeader === null) throw new Error('★ 裁剪摘要必须写进快照头(否则读档的人看不出水位少了)');
  eq(inHeader.fluidLevelsDropped, dropped, '★ 头里的被裁行数 = 回执');
  eq(inHeader.fluidLevelsKept, kept, '头里的保留行数 = 回执');
  eq(inHeader.fluidLevelsTotal, 20000, '头里的原有行数');
  eq(inHeader.fluidReason, trim.fluidReason, '头里的原因与回执**逐字**一致');
  ok(
    headerTextOf(fit.bytes).includes('"fluidLevelsDropped"'),
    '头 JSON 里真的写出了这个键(不是只在内存对象上)',
  );

  /* ── ③ 回滚计划:`unavailable` + `changes` ── */
  const plan = planRestore(d, null);
  const gap = plan.unavailable.find((u) => u.includes('fluid.levels'));
  if (gap === undefined) {
    throw new Error(`★ 计划必须把被裁的水位列进 unavailable(实得 ${plan.unavailable.join(' / ')})`);
  }
  ok(gap.includes(`裁掉 ${dropped} 行`), `★ 缺口要点名行数(实得 ${gap})`);
  ok(gap.includes('不编 0'), '缺口要说清「不编 0」(编 0 = 静默把水抽干)');
  const note = plan.changes.find((c) => c.includes('流体水位') && c.includes('裁掉'));
  if (note === undefined) {
    throw new Error(`★ changes 里也要能读到(实得 ${plan.changes.join(' | ')})`);
  }
  ok(note.includes(`${dropped} 行`), `★ changes 里点名行数(实得 ${note})`);
  ok(note.includes('amount>y>x'), 'changes 里点名规则');

  /* ★ 计划只铺**保留**的那批:被裁的格不进 fluid op(也不填 0)。 */
  const opLevels = fluidOpLevels(plan);
  eq(opLevels.length, kept, 'fluid op 的行数 = 保留行数');
  eq(
    opLevels.length,
    fluidOf(d).levels.length,
    'fluid op 与解码出来的水位表同长(计划不是另一份数据)',
  );
  const applied = applyRestorePlan(plan);
  eq(applied.fluid?.levels.length, kept, '按计划重建 ⇒ 也只铺回保留的那批');

  /* ── 负对照:没被裁的水位不许出现在 unavailable / changes 里 ── */
  const clean = planRestore(decodeWorldArchive(smallSnapshot()), null);
  ok(
    !clean.unavailable.some((u) => u.includes('fluid.levels')),
    `★ 没裁水位 ⇒ 不许出现「水位被裁」的缺口(实得 ${clean.unavailable.join(' / ')})`,
  );
  ok(
    !clean.changes.some((c) => c.includes('裁掉了')),
    '★ 没裁水位 ⇒ changes 里不许有「裁掉了 X 行」',
  );
});

/* ═══════════════════════ 4. 裁后仍装得下 / 自洽 ═══════════════════════ */

test('FND82-4 裁后字节 ≤ 上限、水位仍全序、encode(decode(x)) 逐字节回到 x', () => {
  const big = bigFluidSnapshot();
  const fit = fitWorldArchive(big, 65536);
  ok(fit.bytes.byteLength <= 65536, `★ 裁后 ${fit.bytes.byteLength} 字节 ≤ 65536`);
  eq(fit.report?.budgetBytes, 65536, '回执记的预算 = 上限');
  eq(fit.report?.originalBytes, big.byteLength, '回执记的原字节数');

  const d = decodeWorldArchive(fit.bytes);
  const levels = fluidOf(d).levels;
  ok(levels.length > 0, '裁完还剩一些水位(否则「降采样」变成「抽干」)');
  /* 解码器自己会校验升序/唯一,这里再点一次:裁完的表仍是全序(否则回放不稳)。 */
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1].y * d.fluid!.width + levels[i - 1].x;
    const cur = levels[i].y * d.fluid!.width + levels[i].x;
    ok(cur > prev, `第 ${i} 行破坏了 (y,x) 升序(prev key=${prev}, cur key=${cur})`);
  }
  /* 保留行的字节必须在预算内(这是「预算真的生效」的硬账,不是「大概小了一点」)。 */
  const keptRowBytes = levels.reduce(
    (n, l) => n + JSON.stringify([l.x, l.y, l.amount]).length + 1,
    0,
  );
  ok(
    keptRowBytes <= (fit.report?.fluidBudgetBytes ?? 0),
    `保留行 ${keptRowBytes} 字节 ≤ 水位预算 ${fit.report?.fluidBudgetBytes ?? 0}`,
  );

  /* 往返:裁剪路径也要逐字节自洽(含新加的 trim 键)。 */
  const again = encodeWorldArchive({
    version: d.version,
    world: d.world,
    players: d.players,
    fluid: d.fluid,
    mobs: d.mobs,
    ground: d.ground,
    chunks: d.chunks,
    trim: d.trim,
  });
  ok(bytesEqual(again, fit.bytes), '★ encode(decode(裁剪后的字节)) 逐字节 = 裁剪后的字节');

  /* 规则本体单独可测:预算够 ⇒ 一行不裁,且原因如实写「预算足够」。 */
  const tiny = planFluidLevelsTrim(SMALL_LEVELS, 100000);
  eq(tiny.droppedRows, 0, '预算够 ⇒ 不裁');
  eq(tiny.kept.length, 3, '三行全留');
  ok(tiny.reason.includes('预算足够'), `原因要写清「预算足够」(实得 ${tiny.reason})`);
  const zero = planFluidLevelsTrim(SMALL_LEVELS, 0);
  eq(zero.kept.length, 0, '预算 0 ⇒ 一行都留不下');
  eq(zero.droppedRows, 3, '三行全裁');
  ok(zero.reason.includes('裁掉 3 行'), `原因点名裁了多少(实得 ${zero.reason})`);

  /*
   * ★ **同值行的次序**也要可判定:三行都是 500,预算只够两行。
   * 期望 = `(y, x)` 升序的那两行 `[(1,0),(9,0)]`(字面量,不调被测比较函数)。
   * 为什么这条必需:大夹具按 `(y,x)` 升序生成,同值组可能整组落在分界线同一侧,
   * 「同值按 y 降序」在那里**看不出来** —— 用这张最小的表把规则钉死。
   */
  const tie = planFluidLevelsTrim([
    { x: 9, y: 0, amount: 500 },
    { x: 1, y: 0, amount: 500 },
    { x: 5, y: 1, amount: 500 },
  ], 20);
  eq(tie.kept.length, 2, '预算 20 字节 = 两行(每行 10 字节)');
  eq(
    tie.kept,
    [{ x: 1, y: 0, amount: 500 }, { x: 9, y: 0, amount: 500 }],
    '★ 同值按 (y, x) 升序 ⇒ 留 (1,0) 与 (9,0);保留集本身按 (y,x) 排回去',
  );
  eq(tie.droppedRows, 1, '被裁 1 行');
});

/* ═══════════════════════ 5. 负对照:不裁时字节逐字节不变 ═══════════════════════ */

test('FND82-5 ★负对照:同一份大世界把上限放到 1 MiB ⇒ 不裁,水位一行不少,字节 = 入参', () => {
  const big = bigFluidSnapshot();
  ok(big.byteLength <= MIB, `前提:它本来就不超 1 MiB(实得 ${big.byteLength})`);

  const fit = fitWorldArchive(big, MIB);
  eq(fit.trimmed, false, '★ 不超上限 ⇒ 没裁过(哪怕它「大到值得裁」)');
  eq(fit.report, null, '不裁 ⇒ 没有回执');
  ok(fit.bytes === big, '★ 不裁 ⇒ 逐字节不变(返回入参本身)');
  eq(fluidOf(decodeWorldArchive(fit.bytes)).levels.length, 20000, '★ 水位一行不少');
  eq(decodeWorldArchive(fit.bytes).trim, null, '头里没有 trim');

  /* 同一份夹具在 64 KiB 下是**会**被裁的 —— 证明第 5 条不是「它本来就不用裁」。 */
  const trimmed = fitWorldArchive(big, 65536);
  ok(trimmed.trimmed, '同一份字节在 64 KiB 上限下确实被裁(负对照成立)');
});

/* ═══════════════════════ 6. 负对照:只裁地形时水位不动 ═══════════════════════ */

test('FND82-6 ★负对照:超的是地形(水位很小)⇒ 水位键根本不出现,水位原样', () => {
  const big = bigTerrainSnapshot();
  ok(big.byteLength > 200000, `前提:这份快照必须真的超限(实得 ${big.byteLength})`);

  const fit = fitWorldArchive(big, 200000);
  ok(fit.trimmed, '★ 超限 ⇒ 裁过(裁的是地形)');
  const trim = fit.report;
  if (trim === null) throw new Error('裁过必须有报告');
  ok(trim.droppedChunks > 0, `裁掉了地形块(实得 ${trim.droppedChunks})`);
  /* ★ 水位一个字都没动 ⇒ 那组键**不许**出现(「裁了 0 行」与「没裁」要分得清)。 */
  eq(trim.fluidLevelsDropped, undefined, '★ 没裁水位 ⇒ 回执里没有 fluidLevelsDropped');
  eq(trim.fluidReason, undefined, '没裁水位 ⇒ 没有水位原因');
  const d = decodeWorldArchive(fit.bytes);
  eq(d.trim?.fluidLevelsDropped, undefined, '头里也没有水位裁剪的键');
  eq(
    fluidOf(d).levels,
    Array.from({ length: 20 }, (_unused, i) => ({ x: i, y: 0, amount: 100 * (i + 1) })),
    '★ 水位 20 行原样还在(只裁地形的路径不许顺手动水位)',
  );
  ok(!headerTextOf(fit.bytes).includes('fluidLevelsTotal'), '头 JSON 里没有水位裁剪的键');
  /* 计划的缺口里也不该有水位那条(只有 chunks 那条)。 */
  const plan = planRestore(d, null);
  ok(
    !plan.unavailable.some((u) => u.includes('fluid.levels')),
    `★ 水位完整 ⇒ 它的缺口不许出现在 unavailable(实得 ${plan.unavailable.join(' / ')})`,
  );
});

/* ═══════════════════════ 7. 负对照:装不下就如实失败 ═══════════════════════ */

test('FND82-7 ★负对照:水位裁到 0 行、地形一块不留仍装不下 ⇒ 抛错(不写半截世界)', () => {
  const big = bigFluidSnapshot();
  /* 400 字节:连「世界世代 + 一个玩家」的头都装不进 ⇒ 不许硬塞。 */
  const msg = throwsWith(() => fitWorldArchive(big, 400), '上限 400 字节');
  ok(msg.includes('裁剪失败'), `★ 抛错要说清是裁剪失败(实得 ${msg})`);
  ok(msg.includes('400'), `抛错要点名上限(实得 ${msg})`);

  /* 锚:同一份字节在够大的上限下不抛(证明抛错不是夹具坏了)。 */
  const okFit = fitWorldArchive(big, 65536);
  ok(okFit.bytes.byteLength <= 65536, '够大的上限下正常返回');
});

report('WS-FND-82');