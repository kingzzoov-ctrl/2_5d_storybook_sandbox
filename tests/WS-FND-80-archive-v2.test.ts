/**
 * WS-FND-80 —— 归档头 **v2**:`players[].hp` + 流体水位,且 **v1 仍必须读得回**
 *
 * ## 这个套件补的是哪一段
 *
 * `tests/WS-FND-72` 把 WSA1 做成「解码 + chunk 裁剪 + 回滚计划」,`tests/WS-FND-78`
 * 把计划真落回 `WorldSim`。但归档头里**没有**两样东西,回滚因此有两处**如实缺口**:
 *
 * ```
 * players[].hp   v1 头里只有 id/x/y/z/level ⇒ 回滚只还位置与等级
 * 流体水位        FluidField.amount 数组不在快照里 ⇒ 液面按重建后的空地开始
 * ```
 *
 * 本套件钉的是「把这两项补进头里」之后的**双向约束**:
 *
 * | # | 判据 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | v2 写入侧(默认方向):头里有 `hp` + 稀疏水位表,解码逐字段相等,`encode(decode(x))` 逐字节回到 `x`;键序同写入侧 | 少写一个字段 / 键序漂了 / 水位表序不是全序 |
 * | 2 | **v1 仍可读**:缺 `hp`/`fluid` ⇒ 不抛错、不编值(`undefined` / `null`),往返逐字节;声明 v2 却缺 `hp`、声明 v1 却带 `hp` 都**抛错** | 把 v1 当坏数据抛 / 编一个 100 / 默默丢掉调用方给的数据 |
 * | 3 | 解码器对 v2 坏数据抛错并点名字段(坐标越界 / 水位非正 / 破坏升序 / 缺 `hp`) | 静默放过 = 回滚出一份坏世界 |
 * | 4 | 裁剪规则对 v2 同样成立,且**只裁地形**:裁完 ≤ 上限、建造块优先保留、`hp` 与水位原样还在、往返仍逐字节 | 裁剪顺手把水位/血量挤掉 / 静默截断 |
 * | 5 | 回滚计划:v2 ⇒ `player` op 带 `hp` + 一条 `fluid` op;v1 ⇒ 这两项进 `unavailable` 且**不产生 op**(负对照) | 计划漏字段 / 缺水位时编一个全零场 |
 * | 6 | **真实写入侧**(装配层归档口)的字节:两版本不变量 + 往返逐字节 | 写入侧与解码器漂移 |
 *
 * ## 断言右侧一律是**字面量**
 *
 * `hp` 写 `73.5`、水位写 `[1,0,1000]`、块坐标写 `3,0`、上限写 `200000` —— 不取
 * 被测模块的导出常量当期望值(那是「用一个值断言它自己」)。唯一用常量的地方是
 * 「支持的版本区间」这类**契约本身**。
 *
 * ## 为什么第 6 条允许两种版本
 *
 * 写入侧(`world_sim.ts` 的 `describeWorldForArchive`)不在本线可改范围里,所以
 * 它此刻仍可能写 v1。第 6 条因此钉**跨版本不变量**而不是「必须 v2」:读到哪个版本,
 * 那两个字段就按那个版本的语义在或不在 —— 等写入侧升到 v2 时,这条会自动覆盖新分支。
 */
import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { Chunk, idx } from '../server/src/world/chunk.ts';
import { packTile } from '../shared/types/tile.ts';
import {
  applyRestorePlan,
  decodeWorldArchive,
  describeDecodedWorld,
  diffWorldState,
  encodeWorldArchive,
  fitWorldArchive,
  planChunkTrim,
  planRestore,
  TRIM_RULE_ID,
  WORLD_ARCHIVE_FORMAT_VERSION,
  WORLD_ARCHIVE_MIN_READABLE_VERSION,
  type ArchiveFluidField,
  type ArchiveFluidLevel,
  type DecodedWorldArchive,
  type RestoreFluidOp,
  type RestorePlan,
  type RestorePlayerOp,
} from '../server/src/world/archive.ts';

/* ═══════════════════════ 0. 夹具与工具 ═══════════════════════ */

const CELL_X = 3;
const CELL_Y = 4;
const FURNITURE = 351; /* 暖松原木圆墙(内容表 351):玩家建造,seed 重建不出来 */
const HP = 73.5;
const V2 = 2;
const V1 = 1;

/** 世界世代(手写,不从被测模块取)。 */
const WORLD = {
  roomId: 'r_fnd80',
  seed: 4242,
  sizeCells: 32,
  biome: 'MEADOW',
  frame: 40,
  hourOfDay: 12.5,
};

/**
 * 水位表**故意乱序**给:(12,0) 排在 (2,1) 之前 —— 编码器必须按 `(y, x)` 升序
 * 写出来,否则「同一份水位」会有两种字节。
 */
const FLUID_LEVELS: readonly ArchiveFluidLevel[] = [
  { x: 12, y: 0, amount: 1000 },
  { x: 2, y: 1, amount: 500 },
  { x: 7, y: 7, amount: 250 },
];

const FLUID: ArchiveFluidField = { width: 32, height: 32, levels: FLUID_LEVELS.slice() };

/** 一块地形块体(用**真实的** `Chunk.serializeSnapshot`,不是手搓字节)。 */
function chunkBlob(cx: number, cy: number, built: boolean): Uint8Array {
  const c = new Chunk(cx, cy);
  if (built) {
    c.cells[idx(CELL_X, CELL_Y)] = packTile({
      elev: 0, base: 0, floor: 0, wire: 0, obj: FURNITURE, meta: 0,
    });
  }
  return c.serializeSnapshot();
}

/** v1 形状的玩家(没有 `hp` 这个键)。 */
function v1Player(): { id: string; x: number; y: number; z: number; level: number } {
  return { id: 'p1', x: 1.5, y: 2.5, z: 0, level: 3 };
}

/** v2 快照:玩家带血量 + 一张水位表。`version` **不显式给** —— 走「按形状推断」。 */
function makeV2(players: readonly { id: string; x: number; y: number; z: number; level: number; hp?: number }[] = [
  { ...v1Player(), hp: HP },
]): Uint8Array {
  return encodeWorldArchive({
    world: WORLD,
    players,
    fluid: FLUID,
    mobs: [],
    ground: [],
    chunks: [{ cx: 0, cy: 0, bytes: chunkBlob(0, 0, true) }],
  });
}

/** v1 快照:玩家没有 `hp`,头里也没有 `fluid`(与老写入侧的字节同形状)。 */
function makeV1(explicitVersion: boolean): Uint8Array {
  const base = {
    world: WORLD,
    players: [v1Player()],
    mobs: [],
    ground: [],
    chunks: [{ cx: 0, cy: 0, bytes: chunkBlob(0, 0, true) }],
  };
  return explicitVersion
    ? encodeWorldArchive({ version: V1, ...base })
    : encodeWorldArchive(base);
}

/** 断言 `fn` 抛错并返回消息(负对照:坏数据必须说清哪儿坏)。 */
function throwsWith(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${label} 必须抛错(静默放过 = 回滚出一份坏世界)`);
}

/** 逐字节比较两个 Uint8Array。 */
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

/** `[4,8)` 的 uint32 版本号(逐字节读,不信解码器的自述)。 */
function versionOf(bytes: Uint8Array): number {
  return viewOf(bytes).getUint32(4, true);
}

/**
 * 头 JSON 里的键必须**按给定顺序**出现。
 *
 * 为什么这条属于判据:键序是「逐字节可比」的一部分(见 `encodeWorldArchive` 的
 * 注释),而写入侧是**另一份**实现 —— 漂了就会在「同一份世界的两份归档」上出现
 * 字节差异,而回滚判据正是拿字节比的。
 */
function assertKeyOrder(headerText: string, keys: readonly string[]): void {
  let at = -1;
  for (const k of keys) {
    const i = headerText.indexOf(`"${k}":`);
    ok(i >= 0, `头里必须有 ${k} 这个键(实得头:${headerText.slice(0, 120)}…)`);
    ok(i > at, `头里键 ${k} 必须晚于前一个键(实得 ${i} ≤ ${at})—— 键序是逐字节可比的一部分`);
    at = i;
  }
}

/**
 * 原地改头 JSON(补丁必须**等长**,否则 `headerLen` 与块体偏移都要跟着改)。
 * 用来造「解不开的 v2 头」——`encodeWorldArchive` 会挡住这些形状,所以必须绕过它。
 */
function patchHeader(snapshot: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) {
    throw new Error(`补丁必须等长:${from}(${from.length})vs ${to}(${to.length})`);
  }
  const headerLen = viewOf(snapshot).getUint32(8, true);
  const text = new TextDecoder().decode(snapshot.subarray(12, 12 + headerLen));
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`补丁锚点找不到:${from}`);
  const byteAt = 12 + new TextEncoder().encode(text.slice(0, at)).byteLength;
  const out = snapshot.slice();
  out.set(new TextEncoder().encode(to), byteAt);
  return out;
}

/** `fluid === null` 时本套件的大部分判据都不成立 ⇒ 用一个显式的取用口。 */
function fluidOf(d: DecodedWorldArchive): ArchiveFluidField {
  if (d.fluid === null) throw new Error('这份夹具必须有水位(否则判据的前提不成立)');
  return d.fluid;
}

function playerOpOf(plan: RestorePlan): RestorePlayerOp {
  const op = plan.ops.find((o) => o.kind === 'player');
  if (op === undefined || op.kind !== 'player') throw new Error('计划里必须有 player op');
  return op;
}

function fluidOpOf(plan: RestorePlan): RestoreFluidOp {
  const op = plan.ops.find((o) => o.kind === 'fluid');
  if (op === undefined || op.kind !== 'fluid') throw new Error('计划里必须有 fluid op');
  return op;
}

/**
 * 造一份**超 200KB** 的 v2 快照:300 块地形 + 唯一一块玩家建造(i=3 ⇒ (3,0))
 * + 一张水位表 + 玩家血量。
 *
 * 为什么合成:`sizeCells` 够大的真世界要 32×32 块才超上限,那会把「裁剪」这条
 * 判据变成性能测试。合成用的是**同一个** `encodeWorldArchive` 与**同一份**
 * `Chunk.serializeSnapshot` —— 格式没有被第二份实现污染(v2 的真实字节由第 1/6 条钉)。
 */
function makeOversizedV2(): Uint8Array {
  const list = [];
  for (let i = 0; i < 300; i += 1) {
    const cx = i % 32;
    const cy = Math.floor(i / 32);
    list.push({ cx, cy, bytes: chunkBlob(cx, cy, i === 3) });
  }
  const levels: ArchiveFluidLevel[] = [];
  for (let i = 0; i < 20; i += 1) levels.push({ x: i, y: 0, amount: 100 * (i + 1) });
  return encodeWorldArchive({
    world: { roomId: 'r_fnd80_big', seed: 777, sizeCells: 512, biome: 'MEADOW', frame: 123, hourOfDay: 12.5 },
    players: [{ ...v1Player(), hp: HP }],
    fluid: { width: 512, height: 512, levels },
    mobs: [],
    ground: [],
    chunks: list,
  });
}

/**
 * 走**真装配**造一份归档快照:建造一格 → 推进 40 帧 → 掉落一件 → 重置(归档口捕获字节)。
 *
 * 为什么从归档口取字节:与生产同一条路径,而且是**写入侧真的写出来的**字节 ——
 * 第 6 条要的正是「写入侧与解码器没有漂移」。
 */
function captureRealSnapshot(): Uint8Array {
  const captured: Uint8Array[] = [];
  const a = assemble({
    roomId: 'r_fnd80_live',
    ownerId: 'p1',
    clock: { nowMs: () => 0 },
    sizeCells: 32,
    mobs: false,
    worldSeed: 4242,
    db: null,
    archiveSink: (req) => {
      captured.push(req.snapshot.slice());
      return {
        id: `${req.roomId}#1`,
        seed: req.seed,
        archived_at: req.nowMs,
        bytes: req.snapshot.byteLength,
      };
    },
  });
  a.runtime.join({ userId: 'p1' });
  const sim = a.host as unknown as {
    setCell(x: number, y: number, fields: { obj?: number }): void;
    dropItem(x: number, y: number, itemId: number, count: number): void;
    advance(n?: number): number;
    resetWorld(opts: { seed: number; nowMs?: number }): { applied: boolean };
  };
  sim.setCell(CELL_X, CELL_Y, { obj: FURNITURE });
  sim.advance(40);
  sim.dropItem(5.5, 6.5, 102, 2);
  const reset = sim.resetWorld({ seed: 999, nowMs: 1234 });
  ok(reset.applied, '重置应生效(否则写侧没走到归档那一步)');
  if (captured.length !== 1) throw new Error(`归档口应恰好收到 1 份快照(实得 ${captured.length})`);
  return captured[0];
}

/* ═══════════════════════ 1. v2 写入侧 ═══════════════════════ */

test('FND80-1 v2 头带 hp 与水位:逐字段相等 + 逐字节往返 + 键序同写入侧', () => {
  const bytes = makeV2();
  eq(versionOf(bytes), V2, '★ [4,8) 的版本号 = 2(不显式给 version ⇒ 按入参形状推断)');
  eq(WORLD_ARCHIVE_FORMAT_VERSION, V2, '本文件默认写出的版本 = 2');
  eq(WORLD_ARCHIVE_MIN_READABLE_VERSION, V1, '仍然可读的最低版本 = 1');

  const d = decodeWorldArchive(bytes);
  eq(d.version, V2, '头里的 version');
  eq(d.players.length, 1, '一个玩家');
  eq(d.players[0].hp, HP, '★ 玩家血量解回来了');

  const fluid = fluidOf(d);
  eq(fluid.width, 32, '水位场宽');
  eq(fluid.height, 32, '水位场高');
  eq(fluid.levels.length, 3, '三格非零水位');
  eq(
    fluid.levels,
    [
      { x: 12, y: 0, amount: 1000 },
      { x: 2, y: 1, amount: 500 },
      { x: 7, y: 7, amount: 250 },
    ],
    '★ 水位表按 (y, x) 升序写出(乱序给进去 ⇒ 全序写出来)',
  );
  eq(d.warnings, [], 'v2 的真实字节解码不该有告警');
  eq(d.trim, null, '没裁过');

  /* 键序:写入侧必须与 `encodeWorldArchive` 同序(否则「同一份世界」会出两种字节)。 */
  assertKeyOrder(headerTextOf(bytes), [
    'version', 'roomId', 'seed', 'sizeCells', 'biome', 'frame', 'hourOfDay',
    'players', 'fluid', 'mobs', 'ground', 'chunks',
  ]);
  ok(
    headerTextOf(bytes).includes('"level":3,"hp":73.5'),
    `玩家对象里 hp 必须紧跟 level(实得 ${headerTextOf(bytes).slice(0, 200)}…)`,
  );

  /* 往返:encode(decode(x)) 必须逐字节回到 x。 */
  const again = encodeWorldArchive({
    version: d.version,
    world: d.world,
    players: d.players,
    fluid: d.fluid,
    mobs: d.mobs,
    ground: d.ground,
    chunks: d.chunks,
  });
  ok(bytesEqual(again, bytes), '★ encode(decode(x)) 逐字节 = x(v2)');

  /* 纯函数:解码两次得到同一份水位(不能靠共享可变数组)。 */
  const d2 = decodeWorldArchive(bytes);
  eq(diffWorldState(describeDecodedWorld(d), describeDecodedWorld(d2)), [], '两次解码的描述逐字段相等');
});

/* ═══════════════════════ 2. v1 仍可读(★ 负对照) ═══════════════════════ */

test('FND80-2 ★v1 仍可读:缺 hp/fluid 不抛错、不编值,往返逐字节;声明与载荷不符则抛错', () => {
  for (const explicit of [false, true]) {
    const bytes = makeV1(explicit);
    eq(versionOf(bytes), V1, `v1 字节的版本号 = 1(explicit=${explicit})`);
    const d = decodeWorldArchive(bytes);
    eq(d.version, V1, '头版本');
    eq(d.players.length, 1, '玩家解出来了');
    eq(
      d.players[0].hp,
      undefined,
      '★ v1 头里没有血量 ⇒ `undefined`(不可用),**不是**编出来的 100',
    );
    eq(
      Object.prototype.hasOwnProperty.call(d.players[0], 'hp'),
      false,
      '★ 连键都不建:`undefined` 的显式键与「没有这个键」在逐字段比较里是两回事',
    );
    eq(d.fluid, null, '★ v1 头里没有水位 ⇒ `null`(不可用),不是全零密度场');
    eq(d.warnings, [], '干净的 v1 字节不该有告警(v1 里缺这两个字段是**正常的**)');

    const again = encodeWorldArchive({
      version: d.version,
      world: d.world,
      players: d.players,
      fluid: d.fluid,
      mobs: d.mobs,
      ground: d.ground,
      chunks: d.chunks,
    });
    ok(bytesEqual(again, bytes), '★ encode(decode(x)) 逐字节 = x(v1)');
  }

  /* ★ 负对照 1:同一份 v1 形状的数据声明 v2 ⇒ 缺 hp 必须抛错(不拿等级/满血凑)。 */
  const missHp = throwsWith(
    () => encodeWorldArchive({
      version: V2,
      world: WORLD,
      players: [v1Player()],
      fluid: FLUID,
      mobs: [],
      ground: [],
      chunks: [{ cx: 0, cy: 0, bytes: chunkBlob(0, 0, false) }],
    }),
    '声明 v2 却缺 hp',
  );
  ok(missHp.includes('hp'), `抛错要点名 hp(实得 ${missHp})`);

  /* ★ 负对照 2:声明 v1 却带着 hp / fluid ⇒ 抛错(默默丢掉调用方给的数据更糟)。 */
  const dropHp = throwsWith(
    () => encodeWorldArchive({
      version: V1,
      world: WORLD,
      players: [{ ...v1Player(), hp: HP }],
      mobs: [],
      ground: [],
      chunks: [],
    }),
    '声明 v1 却带 hp',
  );
  ok(dropHp.includes('hp'), `抛错要点名 hp(实得 ${dropHp})`);
  const dropFluid = throwsWith(
    () => encodeWorldArchive({
      version: V1,
      world: WORLD,
      players: [v1Player()],
      fluid: FLUID,
      mobs: [],
      ground: [],
      chunks: [],
    }),
    '声明 v1 却带 fluid',
  );
  ok(dropFluid.includes('fluid'), `抛错要点名 fluid(实得 ${dropFluid})`);

  /* ★ 负对照 3:不认识的版本也不许「尽力而为」。 */
  ok(throwsWith(() => decodeWorldArchive(makeV1(true).slice(0, 8)), '半截前缀').length > 0, '前缀不足 ⇒ 抛错');
});

/* ═══════════════════════ 3. v2 坏数据的负对照 ═══════════════════════ */

test('FND80-3 解码器对 v2 坏数据抛错并点名字段(越界 / 非正水位 / 破坏升序 / 缺 hp)', () => {
  const good = makeV2();
  decodeWorldArchive(good); /* 前提:这份字节本来是好的 */

  const outOfRange = throwsWith(
    () => decodeWorldArchive(patchHeader(good, '[12,0,1000]', '[32,0,1000]')),
    '水位坐标 x=32 越界(场是 32 宽)',
  );
  ok(outOfRange.includes('之外'), `越界要点名「场之外」(实得 ${outOfRange})`);

  const notPositive = throwsWith(
    () => decodeWorldArchive(patchHeader(good, '[2,1,500]', '[2,1,0.0]')),
    '水位写成 0(与「不在表里」重复表达同一件事)',
  );
  ok(notPositive.includes('不是正数'), `要点名「不是正数」(实得 ${notPositive})`);

  const brokenOrder = throwsWith(
    () => decodeWorldArchive(patchHeader(good, '[7,7,250]', '[7,0,250]')),
    '水位表破坏 (y,x) 升序',
  );
  ok(brokenOrder.includes('升序'), `要点名「升序/全序」(实得 ${brokenOrder})`);

  const missingHp = throwsWith(
    () => decodeWorldArchive(patchHeader(good, '"hp":73.5', '"hx":73.5')),
    'v2 头里玩家缺 hp',
  );
  ok(missingHp.includes('hp'), `要点名 hp(实得 ${missingHp})`);

  /* 负对照:补丁本身不能把字节改坏到这个程度 —— 同一份字节不改就是好的。 */
  ok(bytesEqual(good, makeV2()), '锚:两次造出的 v2 字节逐字节相同(夹具确定性)');
});

/* ═══════════════════════ 4. 裁剪规则对 v2 ═══════════════════════ */

test('FND80-4 v2 超上限:裁剪后 ≤ 上限、建造块优先保留,且 hp 与水位原样还在 + 往返逐字节', () => {
  const big = makeOversizedV2();
  ok(big.byteLength > 200000, `合成快照必须真的超限(实得 ${big.byteLength})`);

  const fit = fitWorldArchive(big, 200000);
  ok(fit.trimmed, '★ 超限 ⇒ 裁过');
  ok(fit.bytes.byteLength <= 200000, `★ 裁剪后 ${fit.bytes.byteLength} 字节 ≤ 200000`);
  const report = fit.report;
  if (report === null) throw new Error('裁过必须有报告');
  ok(report.droppedChunks > 0, `被裁列表非空(实得 ${report.droppedChunks})`);
  eq(report.rule, TRIM_RULE_ID, '规则标识可被机器判断(裁剪规则没变)');
  eq(report.budgetBytes, 200000, '报告的预算 = 上限');
  eq(report.originalBytes, big.byteLength, '报告记着原字节数');

  const kept = decodeWorldArchive(fit.bytes);
  eq(kept.version, V2, '★ 裁剪后仍是 v2(没被降版)');
  eq(kept.players[0].hp, HP, '★ 裁剪只裁地形:玩家血量原样还在');
  eq(
    fluidOf(kept).levels,
    [
      ...Array.from({ length: 20 }, (_unused, i) => ({ x: i, y: 0, amount: 100 * (i + 1) })),
    ],
    '★ 裁剪只裁地形:水位原样还在',
  );
  eq(kept.chunks.length, report.keptChunks, '解码出来的块数 = 报告里的保留数');
  ok(kept.trim !== null, '裁剪摘要写进了快照头');

  /* ★ 玩家建造优先:(3,0) 是唯一一块建造,必须留在保留集里。 */
  const keptKeys = new Set(kept.chunks.map((c) => `${c.cx},${c.cy}`));
  ok(keptKeys.has('3,0'), '★ 建造块 (3,0) 必须保留(裁剪不许裁掉玩家作品)');
  for (const dd of report.dropped) {
    ok(!keptKeys.has(`${dd.cx},${dd.cy}`), `被裁块 (${dd.cx},${dd.cy}) 不许出现在保留集`);
  }

  /* ★ 裁剪规则本身(v2 的块表同一把尺子):预算 = 三分之一时必然裁,字节账不漏。 */
  const plan = planChunkTrim(kept.chunks, Math.floor(kept.bodyBytes / 3));
  ok(plan.dropped.length > 0, '预算不够 ⇒ 必须有块被裁(规则对 v2 同样成立)');
  eq(plan.droppedBytes + plan.keptBytes, plan.totalBytes, '裁掉 + 保留 = 全部(字节账不漏)');
  ok(plan.keptBytes <= plan.budgetBytes, '保留字节 ≤ 块体预算');

  /* 往返:裁剪路径也要逐字节自洽。 */
  const again = encodeWorldArchive({
    version: kept.version,
    world: kept.world,
    players: kept.players,
    fluid: kept.fluid,
    mobs: kept.mobs,
    ground: kept.ground,
    chunks: kept.chunks,
    trim: kept.trim,
  });
  ok(bytesEqual(again, fit.bytes), '★ encode(decode(裁剪后的字节)) 逐字节 = 裁剪后的字节(v2)');

  /* 裁剪是纯函数:同输入两次 ⇒ 逐字节同样的输出。 */
  const fit2 = fitWorldArchive(big, 200000);
  ok(bytesEqual(fit.bytes, fit2.bytes), '★ 同输入两次裁剪 ⇒ 字节完全一致');
});

/* ═══════════════════════ 5. 回滚计划 ═══════════════════════ */

test('FND80-5 ★回滚计划:v2 带 hp 与 fluid op;v1 两项进 unavailable 且不产生 op', () => {
  /* ── v2:两项都**有**,计划里就必须带着它们,而且不算缺口。 ── */
  const d2 = decodeWorldArchive(makeV2());
  const plan2 = planRestore(d2, null);
  eq(plan2.ops[0].kind, 'world', '第一条 op 是世界身份');
  eq(playerOpOf(plan2).hp, HP, '★ player op 带血量');
  const fluidOp = fluidOpOf(plan2);
  eq(fluidOp.width, 32, 'fluid op 的场宽');
  eq(fluidOp.height, 32, 'fluid op 的场高');
  eq(fluidOp.levels.length, 3, 'fluid op 带 3 格非零水位');
  eq(
    plan2.ops.length,
    1 + 1 + 1 + 1,
    'ops = world(1) + player(1) + fluid(1) + chunk(1),一条不多一条不少',
  );
  ok(
    !plan2.unavailable.some((u) => u.includes('hp')),
    `★ 血量有值 ⇒ 不许列进缺口(实得 ${plan2.unavailable.join(' / ')})`,
  );
  ok(
    !plan2.unavailable.some((u) => u.includes('fluid')),
    `★ 水位有值 ⇒ 不许列进缺口(实得 ${plan2.unavailable.join(' / ')})`,
  );

  const applied2 = applyRestorePlan(plan2);
  eq(applied2.players[0].hp, HP, '★ 按计划重建 ⇒ 血量还回来了');
  eq(applied2.fluid, fluidOf(d2), '★ 按计划重建 ⇒ 水位逐格还回来了');
  eq(diffWorldState(applied2, describeDecodedWorld(d2)), [], '★ 计划自足:从空世界走一遍 = 归档描述');
  ok(diffWorldState(applyRestorePlan(plan2), applied2).length === 0, '同一份计划应用两次结果相同');

  /* ── 负对照:v1 的两项**没有**,计划必须如实说缺,且不许编 op。 ── */
  const d1 = decodeWorldArchive(makeV1(false));
  const plan1 = planRestore(d1, null);
  ok(
    plan1.unavailable.some((u) => u.includes('hp')),
    `★ v1 缺血量 ⇒ 必须进 unavailable(实得 ${plan1.unavailable.join(' / ')})`,
  );
  ok(
    plan1.unavailable.some((u) => u.includes('fluid')),
    `★ v1 缺水位 ⇒ 必须进 unavailable(实得 ${plan1.unavailable.join(' / ')})`,
  );
  eq(
    plan1.ops.filter((o) => o.kind === 'fluid').length,
    0,
    '★ 缺水位就不产生 fluid op(编一个全零密度场 = 静默把水抽干)',
  );
  eq(
    Object.prototype.hasOwnProperty.call(playerOpOf(plan1), 'hp'),
    false,
    '★ 缺血量 ⇒ player op 里连 hp 键都没有(不填一个 100)',
  );
  const applied1 = applyRestorePlan(plan1);
  eq(applied1.fluid, null, '重建出来的描述里 water === null(不可用,不是全零场)');
  eq(
    Object.prototype.hasOwnProperty.call(applied1.players[0], 'hp'),
    false,
    '重建出来的玩家没有 hp 键',
  );
  eq(applied1.seed, 4242, 'v1 的世界种子照样还回去了');

  /* 差异叙述只读 `current`,不影响 ops:v2 归档 + v1 现状 ⇒ 叙述里点出「没有水位」这一项。 */
  const mixed = planRestore(d2, describeDecodedWorld(d1));
  ok(
    mixed.changes.some((c) => c.includes('流体水位')),
    `★ 现状没有水位而归档有 ⇒ 叙述里要说(实得 ${mixed.changes.join(' | ')})`,
  );
  eq(
    mixed.ops.filter((o) => o.kind === 'fluid').length,
    1,
    '★ 叙述不影响 ops(fluid op 照样在)',
  );
});

/* ═══════════════════════ 6. 真实写入侧 ═══════════════════════ */

test('FND80-6 真实写入侧的字节:版本不变量成立,且 encode(decode(x)) 逐字节回到 x', () => {
  const real = captureRealSnapshot();
  const d = decodeWorldArchive(real);
  eq(versionOf(real), d.version, '前缀版本号 = 头里的 version');
  ok(
    d.version >= WORLD_ARCHIVE_MIN_READABLE_VERSION && d.version <= WORLD_ARCHIVE_FORMAT_VERSION,
    `写入侧写的版本必须在本文件的支持区间里(实得 ${d.version})`,
  );

  /* 跨版本不变量:读到哪个版本,那两个字段就按那个版本的语义在或不在。 */
  if (d.version === V1) {
    eq(d.fluid, null, 'v1 写入侧 ⇒ 水位不可用');
    for (const p of d.players) {
      eq(p.hp, undefined, `v1 写入侧 ⇒ 玩家 ${p.id} 没有血量(不编值)`);
    }
  } else {
    for (const p of d.players) {
      ok(p.hp !== undefined, `v2 写入侧的每个玩家都必须带 hp(实得 ${p.id} 没有)`);
    }
  }

  /* 真实字节的往返:写入侧与解码器**没有漂移**(含键序 / 键名 / 水位表序)。 */
  const again = encodeWorldArchive({
    version: d.version,
    world: d.world,
    players: d.players,
    fluid: d.fluid,
    mobs: d.mobs,
    ground: d.ground,
    chunks: d.chunks,
  });
  ok(
    bytesEqual(again, real),
    `★ 写入侧字节 → decode → encode 必须逐字节相等(版本 ${d.version};`
    + '键序或字段语义一漂,这条就红)',
  );

  /* 锚:归档口给的是**真实世界**的字节(不是空世界)。 */
  eq(d.world.seed, 4242, '归档记的是旧世界的种子');
  eq(d.world.frame, 40, '归档记的是重置前的帧号(advance(40))');
  eq(d.ground.length, 1, '有一件地面掉落');
});

report('WS-FND-80');
