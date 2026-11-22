/**
 * WS-FND-182 —— **地形下行**:服务端把真正的块字节发给客户端。
 *
 * ## 修前的形态(本任务要修的**那一件事**)
 * ```text
 * 客户端:client/src/stage/design_world.ts 的 buildDesignChunks() 在**本地**重算同一张设计图
 * 服务端:WorldSim / WorldGrid 里跑着**另一份**世界
 * 中间:  shared/net/delta.ts 的 chunkWireBytes / diffChunkVersions / makeChunkVersionKey
 *        **只有单测在用** —— 线上不存在 chunk 下行
 * ```
 * ⇒ 玩家盖的墙、拆的块、被载具改过的地形**一个字节都到不了客户端**;
 *   而**没有任何指标会红**(连接 live、快照照常、画面也在动,只是地形是另一张图)。
 *
 * ## 这一套守什么
 * ```text
 * 1 序列化口径:单块 = 1024 + 8 字节,且**块内 1024 字节 == Chunk.serialize()**
 * 2 逐字节往返(含 u32 全 0 / 全 0xFFFFFFFF 两个边界)
 * 3 **负对照**:改一个字节 ⇒ 比较必须红(证明"比较真的在比")
 * 4 diffChunkVersions 驱动:改一块 ⇒ 只列一块、只发一块
 * 5 客户端 store:同 key 后者为准 / chunks() 顺序稳定 / 脏标记是消费型的
 * 6 **两端同一份数据**:真 WorldSim 的块 → 帧 → 解回来 → 逐块与 sim 的块逐字节一致
 * 7 连接路由:地形帧进块存储,**不进**实体快照 store;坏帧出声但不判死连接
 * 8 节流:不是每帧重算,一轮的突发字节有上限
 * ```
 */

import {
  CHUNK_HEAD_BYTES,
  CHUNK_TILES_BYTES,
  TERRAIN_CHUNK_BYTES,
  TERRAIN_CHUNKS_PER_FRAME,
  TERRAIN_FRAME_HEADER_BYTES,
  TERRAIN_FRAME_TAG,
  TERRAIN_WIRE_VERSION,
  decodeTerrainFrame,
  decodeTerrainFrames,
  encodeChunkTiles,
  encodeTerrainFrame,
  encodeTerrainFrames,
  isTerrainFrame,
  terrainChunkKey,
  type TerrainChunkInput,
} from '../shared/net/terrain.ts';
import { PROTOCOL_VERSION, chunkWireBytes, diffChunkVersions } from '../shared/net/delta.ts';
import { CHUNK_CELLS, CHUNK_SIZE, Elevation } from '../shared/types/tile.ts';
import { Chunk } from '../server/src/world/chunk.ts';
import { WorldSim } from '../server/src/sim/world_sim.ts';
import { RoomRuntime } from '../server/src/net/room.ts';
import {
  TERRAIN_FRAMES_PER_WINDOW,
  TERRAIN_JOIN_BURST_FRAMES,
  TERRAIN_RESEND_MIN_INTERVAL_MS,
} from '../server/src/net/ws_server.ts';
import { ClientChunkStore } from '../client/src/net/chunk_store.ts';
import { createSession } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';

/* ═══════════════════════ 一个全文件唯一的比较器 ═══════════════════════
 *
 * ★ **负对照的载体**:本任务的"有牙实证"就是把它临时改成 `return a.byteLength
 *   === b.byteLength`(只比长度)⇒ 下面所有"往返逐字节一致"的断言必须变红。
 *   ⇒ 别把这个函数拆成多份,也别在某一条断言里绕开它 —— 那样"只比长度"的
 *   那次注入就只能让**一部分**断言变红,实证的说服力就没了。
 *
 * 为什么不用 harness 的 `eq(a, b)`:`deepEqual` 对 TypedArray 会按对象逐键比
 * (键是 "0","1",…),能过但报错信息是一团;而"只比长度"那种走样在 `eq` 上
 * 根本无处施加(它的行为不归本文件管)。
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 断言「它会抛」——并返回抛出来的那条消息(便于断言文案指对了对象)。 */
function throws(fn: () => unknown, what: string): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${what} —— 期望抛错,实际没有抛`);
}

/** 造一块全 `fill` 的格数组(边界用例用)。 */
function tilesFilled(fill: number): Uint32Array {
  const t = new Uint32Array(CHUNK_CELLS);
  t.fill(fill >>> 0);
  return t;
}

/** 造一条可以直接喂给会话的二进制帧(裸 ArrayBuffer,服务端下行不带 tag)。 */
function asFrame(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

/* ═══════════════════════ 1. 口径 ═══════════════════════ */

test('FND182-1 单块口径 = 1024 + 8 = chunkWireBytes();帧长 = 4 + n×1032', () => {
  /* ★ 这条盯的是「同一个数字只有一处」:地形帧的块长必须**取**自冻结层出口
     `chunkWireBytes()`,不是本文件另写一个 1032。改任何一侧都会在这里红。 */
  eq(TERRAIN_CHUNK_BYTES, chunkWireBytes(), '块长必须等于 chunkWireBytes()');
  eq(TERRAIN_CHUNK_BYTES, CHUNK_HEAD_BYTES + CHUNK_TILES_BYTES, '块长 = 块头 8 + 格 1024');
  eq(CHUNK_TILES_BYTES, CHUNK_CELLS * 4, '格字节 = 256 × 4');
  eq(TERRAIN_CHUNK_BYTES, 1032, '线上单块 1032 字节(WS-07 的 C14 也钉着这个数)');
  eq(TERRAIN_FRAME_HEADER_BYTES, 4, '帧头 = tag u8 + ver u8 + count u16');

  const one = encodeTerrainFrame([{ cx: 0, cy: 0, version: 7, tiles: tilesFilled(0) }]);
  eq(one.byteLength, TERRAIN_FRAME_HEADER_BYTES + TERRAIN_CHUNK_BYTES, '1 块的帧长');
  const three = encodeTerrainFrame([
    { cx: 0, cy: 0, version: 7, tiles: tilesFilled(0) },
    { cx: 1, cy: 0, version: 8, tiles: tilesFilled(0) },
    { cx: 0, cy: 1, version: 9, tiles: tilesFilled(0) },
  ]);
  eq(three.byteLength, TERRAIN_FRAME_HEADER_BYTES + 3 * TERRAIN_CHUNK_BYTES, '3 块的帧长');
  eq(one[0], TERRAIN_FRAME_TAG, '首字节 = 地形 tag(客户端据此与差量包分流)');
  eq(one[1], TERRAIN_WIRE_VERSION, '次字节 = 地形线路版本');
  ok(isTerrainFrame(one), 'isTerrainFrame 认自己产的帧');
  /* 差量包(首字节 = 协议版本号)不是地形帧 —— 两条二进制通道的分流判据。 */
  const deltaLike = new Uint8Array(14);   /* 合法差量包最短 14 字节 */
  deltaLike[0] = PROTOCOL_VERSION;
  eq(isTerrainFrame(deltaLike), false, '差量包不是地形帧(不靠 tag 就没有东西能区分两者)');
});

/* ═══════════════════════ 2. 逐字节往返 ═══════════════════════ */

test('FND182-2 真 Chunk → 帧 → 解回来:块内 1024 字节与 Chunk.serialize() 逐字节一致', () => {
  const c = new Chunk(2, 3);
  c.set(1, 1, { obj: 351, elev: Elevation.PLATFORM });
  c.setFloor(4, 4, 306);
  /* 屋顶是**旁路层**(Uint16Array),不进 1024 字节 —— 写它不影响这条断言,
     留着是为了证明"旁路层不被误塞进块体"。 */
  c.setRoof(5, 5, 372);

  const frame = encodeTerrainFrame([{ cx: 2, cy: 3, version: c.version, tiles: c.cells }]);
  const dec = decodeTerrainFrame(frame);
  eq(dec.chunks.length, 1, '解出 1 块');
  eq(dec.chunks[0].cx, 2, 'cx 往返');
  eq(dec.chunks[0].cy, 3, 'cy 往返');
  eq(dec.chunks[0].version, c.version, '版本号往返');

  /* ★★ 这一条是「两端同一份数据」的最小形态:块体内的字节**就是**
     `Chunk.serialize()` 那 1024 字节(同一条口径:256 个 u32 小端)。 */
  const body = frame.subarray(TERRAIN_FRAME_HEADER_BYTES + CHUNK_HEAD_BYTES);
  ok(sameBytes(body, c.serialize()), '线上块体必须逐字节等于 Chunk.serialize()');
  ok(
    sameBytes(encodeChunkTiles(dec.chunks[0].tiles), c.serialize()),
    '解码出来的格再编码回去仍等于 Chunk.serialize()(往返闭合)',
  );
  eq(Array.from(dec.chunks[0].tiles), Array.from(c.cells), '256 个格逐格相等');
});

test('FND182-3 边界:u32 **全 0** 的块往返逐字节一致', () => {
  const zeros = tilesFilled(0);
  const frame = encodeTerrainFrame([{ cx: -1, cy: -2, version: 0, tiles: zeros }]);
  const dec = decodeTerrainFrame(frame);
  eq(dec.chunks.length, 1);
  eq(dec.chunks[0].cx, -1, '负坐标往返(块坐标是 i16)');
  eq(dec.chunks[0].cy, -2, '负坐标往返');
  eq(dec.chunks[0].version, 0, '版本 0 往返');
  ok(sameBytes(encodeChunkTiles(dec.chunks[0].tiles), new Uint8Array(CHUNK_TILES_BYTES)),
    '全 0 的 1024 字节仍是全 0');
  eq(Array.from(dec.chunks[0].tiles).every((v) => v === 0), true, '逐格都是 0');
});

test('FND182-4 边界:u32 **全 0xFFFFFFFF** 的块往返逐字节一致', () => {
  const ones = tilesFilled(0xffffffff);
  const frame = encodeTerrainFrame([{ cx: 32767, cy: -32768, version: 0xffffffff, tiles: ones }]);
  const dec = decodeTerrainFrame(frame);
  eq(dec.chunks.length, 1);
  eq(dec.chunks[0].cx, 32767, 'i16 上界往返');
  eq(dec.chunks[0].cy, -32768, 'i16 下界往返');
  eq(dec.chunks[0].version, 0xffffffff, 'u32 上界版本号往返(**不是** -1 / 不是回绕)');
  eq(Array.from(dec.chunks[0].tiles).every((v) => v === 0xffffffff), true, '逐格都是 0xFFFFFFFF');
  ok(
    sameBytes(encodeChunkTiles(dec.chunks[0].tiles), new Uint8Array(CHUNK_TILES_BYTES).fill(0xff)),
    '全 0xFF 的 1024 字节仍是全 0xFF',
  );
});

/* ═══════════════════════ 3. 负对照(比较真的在比)═══════════════════════ */

test('FND182-5 ★负对照:改一个字节 ⇒ 逐字节比较必须红;同一份字节必须绿', () => {
  const tiles = tilesFilled(0);
  tiles[0] = 0x0000_1234;
  const a = encodeTerrainFrame([{ cx: 0, cy: 0, version: 5, tiles }]);

  /* 先证明比较器**不是恒假**:同一份字节必须判"一样"。 */
  ok(sameBytes(a, a), '同一份字节必须判为一致(否则下面的"红"是恒真的假判据)');
  ok(sameBytes(a, Uint8Array.from(a)), '逐字节拷贝必须判为一致');

  /* 再证明它不是恒真:改**一个**字节(第 0 格的高字节)必须判"不一样"。 */
  const b = Uint8Array.from(a);
  const at = TERRAIN_FRAME_HEADER_BYTES + CHUNK_HEAD_BYTES + 2;
  b[at] = (b[at] ?? 0) ^ 0xff;
  ok(!sameBytes(a, b), `改一个字节(偏移 ${at})必须判为不一致 —— 这是"比较真的在比"的证据`);
  ok(!sameBytes(a, a.subarray(0, a.byteLength - 1)), '少一个字节也必须判为不一致(长度门)');

  /* 改的确实是同一块的第 0 格 —— 不是"某个没人读的填充位"。 */
  const da = decodeTerrainFrame(a).chunks[0];
  const db = decodeTerrainFrame(b).chunks[0];
  ok(da !== undefined && db !== undefined, '两边都要解得出来(改的字节落在格区内)');
  const ta = da?.tiles[0] ?? 0;
  const tb = db?.tiles[0] ?? 0;
  ok(ta !== tb, `第 0 格必须真的变了(0x${ta.toString(16)} vs 0x${tb.toString(16)})`);
  eq(ta, 0x1234, '原值就是写进去的那个');
});

/* ═══════════════════════ 4. diff 驱动:只发改了的块 ═══════════════════════ */

test('FND182-6 diffChunkVersions 驱动:改一块 ⇒ 只列一块、只编一块', () => {
  const prev = { '0,0': 3, '1,0': 3, '0,1': 9 };
  const next = { '0,0': 3, '1,0': 4, '0,1': 9 };

  const d = diffChunkVersions(prev, next);
  eq(d.length, 1, '只列 1 块(改的是 (1,0))');
  eq(d[0]?.cx, 1, 'cx');
  eq(d[0]?.cy, 0, 'cy');
  eq(d[0]?.fromVersion, 3, 'from 版本');
  eq(d[0]?.toVersion, 4, 'to 版本');
  eq(diffChunkVersions(prev, prev).length, 0, '版本全同 ⇒ 一块都不列(节流的第一层)');

  /* 只把 diff 列出来的块编成帧 ⇒ 帧里**只有**那一块。 */
  const want: TerrainChunkInput[] = d.map((e) => ({
    cx: e.cx, cy: e.cy, version: e.toVersion, tiles: tilesFilled(0x01010101),
  }));
  const frames = encodeTerrainFrames(want);
  eq(frames.length, 1, '一块 = 一帧(远小于每帧上限)');
  const dec = decodeTerrainFrames(frames);
  eq(dec.length, 1, '解回来只有 1 块');
  eq(dec[0]?.cx, 1, '就是 (1,0)');
  eq(dec[0]?.cy, 0, '就是 (1,0)');
  eq(dec[0]?.version, 4, '带的是**新**版本号');
});

/* ═══════════════════════ 5. 客户端块存储 ═══════════════════════ */

test('FND182-7 客户端 store:同一 key 收到两次 ⇒ **后者为准**', () => {
  const store = new ClientChunkStore();
  const first = tilesFilled(0);
  first[0] = 0xaaaa_aaaa;
  const second = tilesFilled(0);
  second[0] = 0xbbbb_bbbb;

  const r1 = store.applyFrame(decodeTerrainFrame(
    encodeTerrainFrame([{ cx: 0, cy: 0, version: 1, tiles: first }]),
  ));
  eq(r1.changed, ['0,0'], '首帧:新增一块');
  eq(r1.added, 1, 'added = 1');
  eq(r1.replaced, 0, 'replaced = 0');

  const r2 = store.applyFrame(decodeTerrainFrame(
    encodeTerrainFrame([{ cx: 0, cy: 0, version: 2, tiles: second }]),
  ));
  eq(r2.changed, ['0,0'], '同 key:仍是"变了"');
  eq(r2.added, 0, 'added = 0(不是新增)');
  eq(r2.replaced, 1, 'replaced = 1(整块替换)');
  eq(store.size, 1, '同 key 不会长出第二块');

  const got = store.get(terrainChunkKey(0, 0));
  eq(got?.version, 2, '版本是**后者**');
  eq(got?.tiles[0], 0xbbbb_bbbb, '格字节是**后者**(不是先到先得,也不是 merge)');
  eq(store.versions(), { '0,0': 2 }, '版本表同口径(`"cx,cy"` ⇒ 值)');
  eq(store.appliedFrames, 2, '落地帧数(与块数分开计)');
});

test('FND182-8 客户端 store:chunks() 顺序稳定(按 (cy,cx)),与写入顺序无关', () => {
  const mk = (cx: number, cy: number): Uint8Array => encodeTerrainFrame([
    { cx, cy, version: 1, tiles: tilesFilled(0) },
  ]);
  /* 故意**乱序**写入:(1,1) → (0,1) → (1,0) → (0,0) */
  const a = new ClientChunkStore();
  for (const [cx, cy] of [[1, 1], [0, 1], [1, 0], [0, 0]] as const) a.applyWire(mk(cx, cy));
  const keysA = a.chunks().map((c) => c.key);
  eq(keysA, ['0,0', '1,0', '0,1', '1,1'], '先 cy 后 cx');

  /* 同一批块换个写入顺序 ⇒ 结果逐项相同(与 `diffChunkVersions` 的排序同口径)。 */
  const b = new ClientChunkStore();
  for (const [cx, cy] of [[0, 0], [1, 1], [1, 0], [0, 1]] as const) b.applyWire(mk(cx, cy));
  eq(b.chunks().map((c) => c.key), keysA, '写入顺序不影响输出顺序');
  /* 重复调用也是同一份顺序(不是"每次按 Map 的插入序")*/
  eq(a.chunks().map((c) => c.key), keysA, '重复调用顺序不变');

  /* 脏标记是**消费型**的:清之前一直在,清之后为空。 */
  eq(a.dirty(), keysA, '四块都脏(按同一序)');
  a.clearDirty();
  eq(a.dirty(), [], '清完为空(漏清的表现是"每帧重建同一批",不是"某帧漏重建")');

  /* `chunks()` 的形状必须能直接喂建面:`key/cx/cy/tiles`(`tile_mesh.ts` 的 ChunkInput)。 */
  const first = a.chunks()[0];
  ok(first !== undefined, '至少一块');
  eq(first?.cx, 0, 'cx');
  eq(first?.cy, 0, 'cy');
  eq(first?.tiles.length, CHUNK_SIZE * CHUNK_SIZE, '每块 256 格');
});

/* ═══════════════════════ 6. 两端同一份数据(真 WorldSim)═══════════════════════ */

test('FND182-9 真 WorldSim:块 → 帧 → 解回来,与 sim 里的块**逐块逐字节**一致', () => {
  const sim = new WorldSim({ sizeCells: 48, mobs: false, wiring: false });
  sim.setCell(3, 4, { obj: 351, elev: Elevation.PLATFORM });
  sim.setCell(20, 5, { floor: 5 });
  sim.setCell(35, 40, { obj: 360 });

  const live = sim.terrainChunks();
  ok(live.length >= 3, `至少 3 块(实得 ${live.length})`);

  const frames = encodeTerrainFrames(live.map((c) => ({
    cx: c.cx, cy: c.cy, version: c.version, tiles: c.tiles,
  })));
  ok(frames.length > 0, '有块就有帧');

  const dec = decodeTerrainFrames(frames);
  eq(dec.length, live.length, `解回来的块数必须与 sim 的块数一致(${live.length})`);

  /* ★★ 硬证据:每一块的 1024 字节都与 `Chunk.serialize()` 逐字节相同。
     这是"两端同一份数据"的判据 —— 不是"字段差不多",是**逐字节**。 */
  for (let i = 0; i < dec.length; i += 1) {
    const got = dec[i];
    const src = live[i];
    ok(got !== undefined && src !== undefined, `第 ${i} 块存在`);
    const chunk = sim.grid.getChunk(src!.cx, src!.cy);
    ok(chunk !== undefined, `sim 里必须有块 (${src!.cx},${src!.cy})`);
    eq(got!.cx, src!.cx, `第 ${i} 块 cx`);
    eq(got!.cy, src!.cy, `第 ${i} 块 cy`);
    eq(got!.version, src!.version, `第 ${i} 块版本号`);
    ok(
      sameBytes(encodeChunkTiles(got!.tiles), chunk!.serialize()),
      `第 ${i} 块(${src!.cx},${src!.cy})的格字节必须与 Chunk.serialize() 逐字节一致`,
    );
  }
});

test('FND182-10 房间侧 terrainDeltaFor:全量 → 稳态 0 帧 → 改一块只发那一块', () => {
  const sim = new WorldSim({ sizeCells: 32, mobs: false, wiring: false });
  sim.setCell(1, 1, { obj: 351 });
  /* ★ 真 `WorldSim` 走**真** `RoomRuntime`(构造参 `host`,不手写 host 桩)⇒
     这条打的是"接口声明了没有"那条链(`WorldSaveHost.terrainChunks`)。 */
  const rt = new RoomRuntime({
    roomId: 'fnd182-terrain',
    ownerId: 'u_owner',
    clock: { nowMs: () => 0 },
    host: sim,
  }, null);

  /* 1 全量:基线为空 ⇒ 所有已创建的块都要发。 */
  const full = rt.terrainDeltaFor({});
  eq(full.frames.length, 1, `一帧就装得下(实得 ${full.frames.length} 帧)`);
  const fullChunks = decodeTerrainFrames(full.frames);
  eq(fullChunks.length, 1, 'sim 里只有 (0,0) 这一块');
  eq(fullChunks[0]?.cx, 0, 'cx');
  eq(fullChunks[0]?.cy, 0, 'cy');
  eq(full.versions, { '0,0': full.versions['0,0'] }, '版本表只含这一块');
  ok((full.versions['0,0'] ?? 0) > 0, '块被写过 ⇒ 版本 > 0');

  /* 2 稳态:**没有块变 ⇒ 一帧都不发**(节流的第一层,判据在房间里)。 */
  const steady = rt.terrainDeltaFor(full.versions);
  eq(steady.frames.length, 0, '没有变化 ⇒ frames 为空(一个字节都不编)');
  eq(steady.versions, full.versions, '版本表不变');

  /* 3 改**另一块** ⇒ 只发那一块。 */
  sim.setCell(20, 5, { obj: 352 });          /* 块 (1,0) */
  const after = rt.terrainDeltaFor(full.versions);
  eq(after.frames.length, 1, '只编一帧');
  const only = decodeTerrainFrames(after.frames);
  eq(only.length, 1, '只发**那一块**(不是全量重发)');
  eq(only[0]?.cx, 1, '就是 (1,0)');
  eq(only[0]?.cy, 0, '就是 (1,0)');
  /* 再问一次(基线已推进)⇒ 又是 0 帧 ⇒ 不会"每帧全量重发"。 */
  eq(rt.terrainDeltaFor(after.versions).frames.length, 0, '推进基线后再问 ⇒ 0 帧');
});

/* ═══════════════════════ 7. 坏输入必须抛 ═══════════════════════ */

test('FND182-11 坏输入一律抛(截断 / 尾部垃圾 / 错 tag / 错版本 / 短格数组)', () => {
  const frame = encodeTerrainFrame([{ cx: 0, cy: 0, version: 1, tiles: tilesFilled(0) }]);

  const truncMsg = throws(() => decodeTerrainFrame(frame.subarray(0, frame.byteLength - 1)),
    '截断的帧');
  ok(truncMsg.includes('截断'), `截断的错误文案要点明"截断"(实得:${truncMsg})`);

  const tail = new Uint8Array(frame.byteLength + 3);
  tail.set(frame);
  const tailMsg = throws(() => decodeTerrainFrame(tail), '尾部有垃圾的帧');
  ok(tailMsg.includes('未消耗'), `尾部垃圾也要抛(与 decodePacket 同规;实得:${tailMsg})`);

  const wrongTag = Uint8Array.from(frame);
  wrongTag[0] = PROTOCOL_VERSION;   /* 伪装成差量包 ⇒ 必须在这里就红 */
  const tagMsg = throws(() => decodeTerrainFrame(wrongTag), '首字节不是地形 tag');
  ok(tagMsg.includes('不是地形帧'), `错 tag 的错误文案要指出对象(实得:${tagMsg})`);
  eq(isTerrainFrame(wrongTag), false, 'isTerrainFrame 也不认它');

  const wrongVer = Uint8Array.from(frame);
  wrongVer[1] = TERRAIN_WIRE_VERSION + 1;
  const verMsg = throws(() => decodeTerrainFrame(wrongVer), '线路版本不符');
  ok(verMsg.includes('版本不匹配'), `版本不符要明确失败(实得:${verMsg})`);

  const shortMsg = throws(
    () => encodeTerrainFrame([{ cx: 0, cy: 0, version: 1, tiles: new Uint32Array(CHUNK_CELLS - 1) }]),
    '格数组短于 256',
  );
  ok(shortMsg.includes('格数组不足'), `短格数组必须抛(否则后面所有的格错位;实得:${shortMsg})`);

  throws(() => encodeTerrainFrame([{ cx: 40000, cy: 0, version: 1, tiles: tilesFilled(0) }]),
    'cx 超出 i16');
  throws(() => encodeTerrainFrame([{ cx: 0, cy: 0, version: 0x1_0000_0000, tiles: tilesFilled(0) }]),
    '版本号超出 u32');
  /* ⚠️ 用**普通 number[]** 而不是 Uint32Array:`u32[-1] = -1` 会被**类型化数组**
     自己回绕成 0xFFFFFFFF(那是 JS 语义,不是本协议的锅),于是这条断言就变成了
     恒真。要测的是"编码器拒绝非 u32",就得让 -1 **原样**递进去。 */
  const badTiles: number[] = Array.from(tilesFilled(0));
  badTiles[3] = -1;
  throws(() => encodeTerrainFrame([{ cx: 0, cy: 0, version: 1, tiles: badTiles }]),
    '格值非 u32(不许静默 `>>> 0`)');
});

/* ═══════════════════════ 8. 切帧 ═══════════════════════ */

test('FND182-12 超过每帧上限 ⇒ 多条**自包含**帧;合起来仍等于全部块', () => {
  const n = TERRAIN_CHUNKS_PER_FRAME * 2 + 3;
  const all: TerrainChunkInput[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = tilesFilled(0);
    t[0] = i + 1;
    all.push({ cx: i, cy: 1, version: i + 10, tiles: t });
  }
  const frames = encodeTerrainFrames(all);
  eq(frames.length, Math.ceil(n / TERRAIN_CHUNKS_PER_FRAME), `${n} 块要切成 ${Math.ceil(n / TERRAIN_CHUNKS_PER_FRAME)} 帧`);
  for (const f of frames) {
    ok(isTerrainFrame(f), '每一帧都自带 tag(可单独解,不需要拼装)');
    const one = decodeTerrainFrame(f);
    ok(one.chunks.length <= TERRAIN_CHUNKS_PER_FRAME, '每帧块数不超过上限');
    eq(one.bytesConsumed, f.byteLength, '每帧都被恰好解完(没有跨帧的半块)');
  }
  const back = decodeTerrainFrames(frames);
  eq(back.length, n, `合起来仍是 ${n} 块`);
  eq(back.map((c) => c.cx), all.map((c) => c.cx), '块顺序 = 帧序 × 帧内序(确定性)');
  eq(encodeTerrainFrames([]).length, 0, '空输入 ⇒ 空数组(调用方据此判"不发")');
});

/* ═══════════════════════ 9. 连接路由(真 createSession + 假 socket)═══════════════════════ */

test('FND182-13 会话路由:地形帧进块存储、不进实体快照;坏帧出声但不判死连接', () => {
  /* 假 socket:与 WS-12 同一形态(按 `binaryType` 投递 —— 设错了会以 Blob 到达)。 */
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  let closed = false;
  const sock = {
    binaryType: 'blob',      /* 真 WebSocket 的默认值 */
    readyState: 1,
    send(): void { /* 上行这里不测 */ },
    close(): void { closed = true; sock.readyState = 3; },
    addEventListener(t: string, fn: (ev: never) => void): void {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t)?.push(fn as (ev: unknown) => void);
    },
  };
  const fire = (t: string, ev: unknown): void => {
    let payload = ev;
    if (t === 'message') {
      const d = (ev as { data?: unknown }).data;
      payload = { data: sock.binaryType === 'arraybuffer' ? d : new Blob([d as ArrayBuffer]) };
    }
    for (const h of handlers.get(t) ?? []) h(payload);
  };

  const store = new ClientStateStore();
  const chunks = new ClientChunkStore();
  let entityFrames = 0;
  const drops: string[] = [];
  const terrainEvents: { changed: string[]; store: ClientChunkStore }[] = [];
  const s = createSession({
    url: 'ws://fnd182/', makeSocket: () => sock as never, store, chunks,
    connectTimeoutMs: 0, handshakeTimeoutMs: 0,   /* 单测不跑超时轨 */
    events: {
      onFrame: () => { entityFrames += 1; },
      onDrop: (r) => drops.push(r),
      onTerrain: (e) => terrainEvents.push(e),
    },
  });
  fire('open', {});
  /* 握手(裸 JSON:text 帧以 `{` 开头) */
  fire('message', {
    data: asFrame(new TextEncoder().encode(JSON.stringify({
      t: 'welcome', playerId: 'p1', roomId: 'r1',
      protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-fnd182',
    }))),
  });
  eq(s.state, 'live', '握手完成 ⇒ live');

  const tiles = tilesFilled(0);
  tiles[0] = 0x0bad_c0de;
  const frame = encodeTerrainFrame([{ cx: 0, cy: 0, version: 42, tiles }]);
  fire('message', { data: asFrame(frame) });

  eq(s.terrainFrames, 1, '地形帧计数 +1(独立读数)');
  eq(chunks.size, 1, '块进了块存储');
  eq(chunks.get('0,0')?.version, 42, '版本号也落了');
  eq(chunks.get('0,0')?.tiles[0], 0x0bad_c0de, '块字节**逐格**落了');
  eq(entityFrames, 0, '★ 地形帧**不许**进实体快照 store(那会以"协议版本不匹配"报错)');
  eq(store.state.players.length, 0, '实体 store 一个玩家都没有(没收到过快照)');
  eq(terrainEvents.length, 1, 'onTerrain 被调了 1 次');
  eq(terrainEvents[0]?.changed, ['0,0'], 'changed 指出是哪一块');
  ok(terrainEvents[0]?.store === chunks, '★ 回调里的 store 必须是**同一个对象**(不是副本)');
  eq(drops.length, 0, '正常帧不产生 drop');
  eq(closed, false, '连接没被关');

  /* 坏帧:tag 对、块数声明 1 但字节不够 ⇒ 必须出声(不是静默丢)。 */
  const bad = new Uint8Array([TERRAIN_FRAME_TAG, TERRAIN_WIRE_VERSION, 1, 0, 0, 0, 0]);
  fire('message', { data: asFrame(bad) });
  eq(s.terrainFrames, 1, '坏帧**不计入**已落地帧数');
  ok(s.lastTerrainError !== null, 'lastTerrainError 记下了原因(可拉的证据)');
  ok((s.lastTerrainError ?? '').includes('截断'), `坏帧原因要指对(实得:${s.lastTerrainError})`);
  eq(drops.length, 1, '坏帧走 onDrop(与"形态不对"同一条出口)');
  eq(s.state, 'live', '★ 坏地形帧**不许**把连接判死(与坏动作同一纪律)');
  eq(closed, false, '连接仍然活着');
  s.close();
});

/* ═══════════════════════ 10. 节流口径 ═══════════════════════ */

test('FND182-14 节流:不是每帧重算、单轮突发有上限、进场分批', () => {
  /* 32Hz 广播循环 ⇒ 一帧 31.25ms。地形门必须**远**大于它,否则等于每帧重算。 */
  ok(TERRAIN_RESEND_MIN_INTERVAL_MS >= 100,
    `地形重算间隔必须 ≥ 100ms(实得 ${TERRAIN_RESEND_MIN_INTERVAL_MS}ms;32Hz = 31.25ms/帧)`);
  ok(TERRAIN_RESEND_MIN_INTERVAL_MS >= 31.25 * 3,
    '至少比广播帧长 3 倍以上才算"节流"');

  /* 单轮突发上限:2 帧 × 8 块 × 1032 字节 ≈ 16.5KB —— 远小于一条 WS 帧的 64KB 域,
     也远小于"一次把 148KB 全写进 socket"那种会把连接打挂的形态。 */
  ok(TERRAIN_FRAMES_PER_WINDOW >= 1, '一轮至少能发 1 帧(否则地形永远发不出去)');
  const burst = TERRAIN_FRAMES_PER_WINDOW * TERRAIN_CHUNKS_PER_FRAME * TERRAIN_CHUNK_BYTES;
  ok(burst < 65535, `一轮的突发必须 < 64KB(实得 ${burst} 字节)`);
  ok(TERRAIN_JOIN_BURST_FRAMES >= 1 && TERRAIN_JOIN_BURST_FRAMES <= 8,
    `进场突发帧数要在 1..8(实得 ${TERRAIN_JOIN_BURST_FRAMES})`);

  /* 接线:时间门必须在"问房间要 delta"**之前**(否则每帧都要读一遍世界块清单)。 */
  const src = readFileSync(new URL('../server/src/net/ws_server.ts', import.meta.url), 'utf8');
  ok(src.includes('nowTerrainMs >= nextTerrainAtMs'),
    '广播循环里必须有时间门(nowTerrainMs >= nextTerrainAtMs)');
  ok(src.includes('nextTerrainAtMs = nowTerrainMs + TERRAIN_RESEND_MIN_INTERVAL_MS'),
    '时间门必须推进下一次的时刻(否则第一帧之后就永远不进)');
  ok(src.includes('pushTerrain(c, TERRAIN_FRAMES_PER_WINDOW)'),
    '轮内上限必须真的接在循环里(常量定义了不接线 = 没有节流)');
  ok(src.includes('pushTerrain(c, TERRAIN_JOIN_BURST_FRAMES)'),
    '握手成功后必须立刻推一批(否则"进场"与"没进场"在地形上看不出区别)');
  ok(src.includes('if (!isBroadcastTarget(c)) continue;'),
    '被踢者不许再收块(广播集判据复用同一处)');
});

report('WS-FND-182');