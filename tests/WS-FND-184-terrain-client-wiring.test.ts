/**
 * WS-FND-184 · **地形下行客户端接线**:服务端下发的块必须决定屏幕,设计图只作首帧占位
 *
 * ## 这份套件要抓的缺陷(改前实测过的形态)
 * ```text
 * 服务端 w89 已经按 `chunkVersions` 把**真块字节**发下来了
 *   (1032 B/块,见 shared/net/terrain.ts);
 * 客户端 session.ts 也解了、也写进了 `ClientChunkStore` ……
 * 然后**没有任何消费者** —— `three/boot.ts` 的地形仍是
 *   `buildDesignChunks()` 在本地重算的那张设计图。
 * ```
 * ⇒ 玩家盖的墙 / 拆的块**一个字节都到不了屏幕**,而**没有任何东西会红**:
 *   连接是 `live`、快照照常到、面数统计也一样 —— 三者都"正常工作",合起来是另一张图。
 *
 * ## 判据表(每条都写清"为什么它不是恒真")
 *
 * | # | 判据 | 为什么有牙 |
 * |---|------|------------|
 * | 1 | `main.ts` 建一个 `ClientChunkStore` 并以 **`chunks`** 这个选项名传给 `createSession`;`createSession` 的**每个**选项名都必须在 `SessionOptions` 里 | 选项名改成 `chunkStore` ⇒ 检测器点名;真会话 `h.chunks === 传进去的那个` ⇒ 传错对象(自建一个)必红 |
 * | 2 | 收到地形帧时 **先 `dirty()` → 再 `applyTerrainChunks()` → 最后 `clearDirty()`** | 删任一条 / 换顺序 ⇒ 同一个检测器报红(漏 `clearDirty` 的表现是"每帧重建同一批") |
 * | 3 | `BootHandle` 暴露 `applyTerrainChunks`,实现里用纯函数算计划,且**先摘后建** | 删掉返回值那一行 / 换成"先建后摘" ⇒ 红 |
 * | 4 | 摘旧 mesh 时**从场景移除 + `geometry.dispose()` + 从 key 表删掉** | 删掉 `dispose()` ⇒ 红(不 dispose = 每帧 8 块的几何全留在 GPU 上,手机几轮就爆,且不报错) |
 * | 5 | 纯函数 `planTerrainRebuild` + **真 `ClientChunkStore`**:喂 3 块、只脏 1 块 ⇒ **只重建 1 块** | 去掉脏过滤(整表重建)⇒ 3 块,红;脏 key 不在来源里 ⇒ 0 块 |
 * | 6 | 首帧(屏幕上还没有服务器块)⇒ **整表对齐**(`full`),不是"只换脏块" | 只换脏块会让"设计图的另一半"留在屏幕上,而半张图看起来完全正常 |
 * | 7 | 一块服务器块都没有 ⇒ **保留设计图回落**(`fallback`),且回落**留痕** | 删掉设计图入口 / 删掉 `console.warn` ⇒ 红(静默回落与"设计图本来就这样"同形) |
 * | 8 | 已经吃过服务器块之后再遇到空来源 ⇒ **保持现状**(不把屏幕换回设计图) | 无条件回落 ⇒ 重连后世界"变成另一张图",而没人知道为什么 |
 * | 9 | HUD 的规模 / 来源随地形下行更新(`hud.setWorld`) | 不更新 ⇒ HUD 永远写着设计图的 192×192 / 144 块(w85 修过一次的同一个病) |
 * | 10 | `summary()` 里有 `terrainSource / terrainApplyCalls / terrainRebuilt / terrainDisposed` | 没有它们,"屏幕上的地形来自服务器还是本地"只能靠肉眼看画面 |
 * | 11 | 计划里给的块**就是**块存储里那块的字节(同一个 `Uint32Array`),key 口径 `"cx,cy"` | 用本地设计图块替换 ⇒ 字节不是同一份,红 |
 *
 * ## 为什么这里能直接 import `three/boot.ts`
 * 它 import three,而本机装了 three(optionalDependencies 里已就位)⇒
 * `node --experimental-strip-types` 能加载它。**它内部**(`boot()`)仍然不可测
 * (碰 `document` / `WebGLRenderer`)⇒ 所以"该重建哪些块"必须抽成纯函数
 * (`planTerrainRebuild`)才测得到 —— 这也是这条判据要求"抽出来"的原因。
 *
 * 运行:`node tests/WS-FND-184-terrain-client-wiring.test.ts`
 */

import { readFileSync } from 'node:fs';
import { test, eq, ok, report } from '../shared/testing/harness.ts';

import { BaseFluid, CHUNK_CELLS, Elevation, packTile } from '../shared/types/tile.ts';
import { encodeTerrainFrame } from '../shared/net/terrain.ts';
import { ClientChunkStore } from '../client/src/net/chunk_store.ts';
import { createSession, type WebSocketLike } from '../client/src/net/session.ts';
import {
  TERRAIN_SOURCE_DESIGN,
  TERRAIN_SOURCE_SERVER,
  planTerrainRebuild,
} from '../client/src/three/boot.ts';

/* ─────────────────────────── 源码工具 ─────────────────────────── */

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * 剥注释 —— 与 `WS-09` / `WS-FND-89` 同一手法。
 *
 * ★ 为什么必须剥:docblock 里刻意留了"改前是什么样"的取证片段(那是有价值的),
 *   不剥的话**把代码注释掉**也能让正则命中 ⇒ 判据没有牙。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = '';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (quote !== '') {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) quote = '';
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === '\'' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

const mainCode = stripComments(read('client/src/main.ts'));
const bootCode = stripComments(read('client/src/three/boot.ts'));
const sessionCode = stripComments(read('client/src/net/session.ts'));

/** `createSession({ ... })` 的实参块(`\n    });` 收尾 —— 4 空格缩进的那一层)。 */
function sessionCallOf(code: string): string {
  const at = code.indexOf('createSession({');
  if (at < 0) return '';
  const end = code.indexOf('\n    });', at);
  return end < 0 ? '' : code.slice(at, end);
}

/**
 * `SessionOptions` 的字段名集合 —— **从源码解析**,不是手抄一份清单。
 *
 * 手抄清单正是"改名之后判据还绿"的成因;这里直接读 interface 体。
 */
function sessionOptionNames(): Set<string> {
  const at = sessionCode.indexOf('export interface SessionOptions {');
  if (at < 0) return new Set<string>();
  const end = sessionCode.indexOf('\n}', at);
  const body = end < 0 ? '' : sessionCode.slice(at, end);
  const names = new Set<string>();
  for (const m of body.matchAll(/^ {2}(\w+)\??:/gm)) names.add(m[1]!);
  return names;
}

/** `main.ts` 里 `createSession` 实参的键名(6 空格缩进那一层)。 */
function sessionCallKeys(): string[] {
  const block = sessionCallOf(mainCode);
  const keys: string[] = [];
  for (const m of block.matchAll(/^ {6}(\w+):/gm)) keys.push(m[1]!);
  return keys;
}

/**
 * 地形接线的检测器(空 = 正确)。**返回问题清单而不是布尔** ——
 * 这样负对照能点名是哪一条掉了(与 `WS-FND-167` 同一手法)。
 */
function terrainWiringProblems(code: string): string[] {
  const p: string[] = [];
  if (!code.includes('new ClientChunkStore()')) p.push('没有建 ClientChunkStore(地形块无处落地)');
  const block = sessionCallOf(code);
  if (block === '') {
    p.push('找不到 createSession({ ... }) 的实参块(判据会恒真)');
    return p;
  }
  if (!block.includes('chunks: chunkStore,')) p.push('createSession 没收到块存储(`chunks: chunkStore`)');
  if (!block.includes('store: handle.store,')) p.push('createSession 没收到状态存储(既有接线被动了)');
  if (!block.includes('onTerrain:')) p.push('events 里没有 onTerrain —— 地形帧到了没人处理');
  return p;
}

/** onTerrain 回调体(窗口 900 字符;比这更远的东西不算这个回调的)。 */
function onTerrainBody(code: string): string {
  const at = code.indexOf('onTerrain: (');
  return at < 0 ? '' : code.slice(at, at + 900);
}

function onTerrainOrderProblems(code: string): string[] {
  const p: string[] = [];
  const body = onTerrainBody(code);
  if (body === '') {
    p.push('没有 onTerrain 回调(改前那个"零消费者"的形态)');
    return p;
  }
  const d = body.indexOf('.dirty()');
  const a = body.indexOf('applyTerrainChunks(');
  const c = body.indexOf('clearDirty()');
  if (d < 0) p.push('没读 dirty()');
  if (a < 0) p.push('没调 boot 的建面入口 applyTerrainChunks()');
  if (c < 0) p.push('没清脏标记(漏了 = 每帧重建同一批)');
  if (d >= 0 && a >= 0 && c >= 0 && !(d < a && a < c)) {
    p.push('顺序错:必须 先 dirty() → 再 applyTerrainChunks() → 最后 clearDirty()');
  }
  return p;
}

/** `BootHandle` 上的入口 + 实现体的形态问题。 */
function applyEntryProblems(code: string): string[] {
  const p: string[] = [];
  if (!code.includes('applyTerrainChunks: ((') && !code.includes('applyTerrainChunks: (')) {
    p.push('BootHandle 没暴露 applyTerrainChunks');
  }
  if (!code.includes('applyTerrainChunks: (next, dirtyKeys) =>')) {
    p.push('返回值里没接上 applyTerrainChunks');
  }
  const at = code.indexOf('const applyTerrainChunks = (');
  if (at < 0) {
    p.push('没有 applyTerrainChunks 的实现');
    return p;
  }
  const body = code.slice(at, at + 3000);
  if (!body.includes('planTerrainRebuild(')) p.push('没用纯函数算计划(判定散进装配层就没法断言)');
  const rm = body.indexOf('removeTerrainMesh(chunk.key)');
  const add = body.indexOf('addTerrainMesh(chunk)');
  if (rm < 0) p.push('没摘旧 mesh');
  if (add < 0) p.push('没建新 mesh');
  if (rm >= 0 && add >= 0 && !(rm < add)) p.push('不是"先摘旧的、再建新的"(旧几何会漏 dispose)');
  if (!body.includes('console.warn(')) p.push('回落没有留痕(静默回落 = 与"设计图本来就这样"同形)');
  if (!body.includes('hud.setWorld(')) p.push('没把规模 / 来源同步给 HUD(那行数字会一直是设计图的)');
  return p;
}

/** 摘旧 mesh 的函数体(窗口 900 字符)。 */
function removeMeshBody(code: string): string {
  const at = code.indexOf('const removeTerrainMesh');
  return at < 0 ? '' : code.slice(at, at + 900);
}

function disposeProblems(code: string): string[] {
  const p: string[] = [];
  const body = removeMeshBody(code);
  if (body === '') {
    p.push('没有 removeTerrainMesh(摘旧 mesh 的唯一入口)');
    return p;
  }
  if (!body.includes('scene.remove(')) p.push('摘 mesh 时没从场景里移除(留在场景图里 = 还在画)');
  if (!/mesh\.geometry\.dispose\(\)/.test(body)) p.push('没 dispose 旧几何(显存泄漏,且不报错)');
  if (!body.includes('meshes.delete(')) p.push('没从 key 表里删掉(下次重建会当成新块,计数虚高)');
  return p;
}

/** 设计图回落的问题清单。 */
function fallbackProblems(code: string): string[] {
  const p: string[] = [];
  if (!code.includes('buildDesignChunks()')) p.push('没有设计图入口(拿不到服务器块时世界是空的)');
  if (!code.includes("console.warn('[terrain]")) p.push('回落没有留痕');
  if (!code.includes('TERRAIN_SOURCE_DESIGN')) p.push('没有"设计图占位"这个来源标记(HUD / 自检读不到)');
  if (!code.includes('for (const chunk of chunks) addTerrainMesh(chunk)')) {
    p.push('首帧没有按占位块建面(那屏幕上就是空的)');
  }
  return p;
}

/** `summary()` 的返回对象体(`\n    }),` 收尾 —— 4 空格缩进的那一层)。 */
function summaryBodyOf(code: string): string {
  const at = code.indexOf('summary: () => ({');
  if (at < 0) return '';
  const end = code.indexOf('\n    }),', at);
  return end < 0 ? '' : code.slice(at, end);
}

/**
 * `summary()` 里的地形读数(四个都要在)。
 *
 * ★ 判据只在 **`summary()` 的对象体**里找,并且要求 `名字:` 或 `名字,`(简写属性)——
 *   全文找的话 `terrainRebuilt` 会命中 `terrainRebuiltChunks`(那个变量名),
 *   于是"把 summary 里那个字段删掉"也照样绿。
 */
function summaryFieldProblems(code: string): string[] {
  const p: string[] = [];
  const body = summaryBodyOf(code);
  if (body === '') {
    p.push('找不到 summary() 的返回对象(判据会恒真)');
    return p;
  }
  for (const f of ['terrainSource', 'terrainApplyCalls', 'terrainRebuilt', 'terrainDisposed']) {
    if (!new RegExp(`\\b${f}\\b\\s*[:,]`).test(body)) p.push(`summary() 缺 ${f}`);
  }
  if (!code.includes('TERRAIN_SOURCE_SERVER')) p.push('来源标记没有"服务器"那一档');
  return p;
}

/** `makeHud` 的 `setWorld`(规模 + 来源)是否真的被消费。 */
function hudWorldProblems(code: string): string[] {
  const p: string[] = [];
  if (!code.includes('setWorld: (cells: number, chunkCount: number, source: string)')) {
    p.push('Hud 接口没有 setWorld');
  }
  if (!code.includes('let cells = world?.cells ?? WORLD_CELLS')) p.push('HUD 的规模不是可变量(永远停在设计图)');
  if (!code.includes('地形来源')) p.push('HUD 没有"地形来源"那一行(回落不可见)');
  return p;
}

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** 一整块同海拔草地(内容无关,只要求是合法 u32 格)。 */
function tiles(): number[] {
  const out: number[] = [];
  for (let i = 0; i < CHUNK_CELLS; i += 1) {
    out.push(packTile({
      elev: Elevation.GROUND, base: BaseFluid.GRASS, floor: 0, wire: 0, obj: 0, meta: 0,
    }));
  }
  return out;
}

/** 造一条**真的**地形帧(与服务端同一个编码器)。 */
function frameOf(cells: readonly { cx: number; cy: number }[]): Uint8Array {
  return encodeTerrainFrame(cells.map((c, i) => ({
    cx: c.cx, cy: c.cy, version: i + 1, tiles: tiles(),
  })));
}

const THREE_CELLS = [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }, { cx: 0, cy: 1 }] as const;

/** 3 块落地、脏标记清掉,再单落 1 块 ⇒ 真实状态:**3 块里只有 1 块脏**。 */
function threeChunksOneDirty(): ClientChunkStore {
  const store = new ClientChunkStore();
  store.applyWire(frameOf([{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }]));
  store.clearDirty();
  store.applyWire(frameOf([{ cx: 2, cy: 0 }]));
  return store;
}

/** 最小 WebSocket 替身(与 `WS-12` 同一形态:不连网,只为让 `createSession` 跑起来)。 */
function fakeSocket(): WebSocketLike {
  return {
    binaryType: 'blob',
    readyState: 0,
    send: () => { /* 上行不测 */ },
    close: () => { /* 幂等 */ },
    addEventListener: () => { /* 不驱动事件 */ },
  };
}

/* ═══════════════════════ 1 接线:main.ts → session ═══════════════════════ */

test('FND184-1 main.ts 建块存储并以 `chunks` 传给会话;选项名逐个对得上 SessionOptions', () => {
  eq(terrainWiringProblems(mainCode), [], 'main.ts 必须把块存储接线进会话');

  /* ── 选项名逐个对:createSession 的每个键都必须是 `SessionOptions` 的字段 ── */
  const names = sessionOptionNames();
  ok(names.size >= 8, `SessionOptions 的字段名应当解析得出来(实测 ${names.size} 个)`);
  ok(names.has('chunks'), '`chunks` 必须是 SessionOptions 的字段(session.ts 的 opts.chunks)');
  const keys = sessionCallKeys();
  ok(keys.length >= 5, `createSession 的实参应当解析得出来(实测 ${keys.length} 个键)`);
  for (const k of keys) {
    ok(names.has(k), `createSession 的选项名 \`${k}\` 不是 SessionOptions 的字段`
      + `(白名单:${[...names].join(',')})`);
  }
  ok(keys.includes('chunks'), 'createSession 的实参里必须有 `chunks`');
  /* 反向:`ClientChunkStore` 是**类型名**,不是选项名 —— 拿它当键写进实参是不合法的。 */
  ok(!names.has('ClientChunkStore'), '反向:类型名不是选项名(写错键 TS 会挡,但改名后残留的旧键不会)');

  /* ── 真身:会话必须复用**这一个**对象(不是自建一个同形状的) ── */
  const passed = new ClientChunkStore();
  const handle = createSession({
    url: 'ws://127.0.0.1:1/ws',
    chunks: passed,
    makeSocket: fakeSocket,
    connectTimeoutMs: 0,
    handshakeTimeoutMs: 0,
    events: { onFrame: () => { /* 不驱动 */ } },
  });
  ok(handle.chunks === passed, '会话必须复用调用方传进来的块存储'
    + '(自建一个 = 字节写进 A、渲染读 B,两块各自"正常工作")');
  /* 反向:不传 `chunks` 时会话自建一个(所以"传了"这件事必须是上面那条断言的证据)。 */
  const selfBuilt = createSession({
    url: 'ws://127.0.0.1:1/ws',
    makeSocket: fakeSocket,
    connectTimeoutMs: 0,
    handshakeTimeoutMs: 0,
    events: { onFrame: () => { /* 不驱动 */ } },
  });
  ok(selfBuilt.chunks !== passed, '反向:不传块存储时会话会自建一个(证明上一条不是恒真)');
  handle.close();
  selfBuilt.close();
});
test('FND184-2 onTerrain:先 dirty() → 再重建 → 最后 clearDirty();删任一条都必红', () => {
  eq(onTerrainOrderProblems(mainCode), [], 'onTerrain 的三行顺序必须正确');
  for (const witness of ['.dirty()', 'applyTerrainChunks(', 'clearDirty()']) {
    const broken = mainCode.split(witness).join('');
    ok(broken !== mainCode, `前提:onTerrain 里确实有 ${witness}`);
    ok(onTerrainOrderProblems(broken).length > 0, `★ 删掉 ${witness} ⇒ 检测器必须报红`);
  }
  /* 反向:换顺序(先清脏再重建)⇒ 红 —— 那种写法下"这一帧到底重建了哪些块"是空的。 */
  const swapped = mainCode
    .replace('          const r = handle.applyTerrainChunks(store.chunks(), dirty);\n', '')
    .replace('          const dirty = store.dirty();\n', '          const dirty = store.dirty();\n'
      + '          store.clearDirty();\n'
      + '          const r = handle.applyTerrainChunks(store.chunks(), dirty);\n')
    .replace('          store.clearDirty();\n          lastTerrainNote', '          lastTerrainNote');
  ok(swapped !== mainCode, '前提:onTerrain 的三行确实按那个顺序摆在源码里');
  ok(onTerrainOrderProblems(swapped).some((x) => x.includes('顺序错')), '★ 先清脏再重建 ⇒ 必红');
});

/* ═══════════════════ 2 boot.ts:暴露入口 + 释放旧几何 ═══════════════════ */

test('FND184-3 boot.ts 暴露 applyTerrainChunks(纯函数算计划、先摘后建)', () => {
  eq(applyEntryProblems(bootCode), [], 'boot.ts 必须暴露建面入口,并先摘旧的再建新的');
  /* 反向:去掉"先摘"那一步(只建新的)⇒ 旧几何留在 GPU 上 */
  const noRemove = bootCode.replace('      removeTerrainMesh(chunk.key);', '');
  ok(noRemove !== bootCode, '前提:实现里确实先摘旧 mesh');
  ok(applyEntryProblems(noRemove).some((x) => x.includes('没摘旧 mesh')), '★ 不摘旧 mesh ⇒ 必红');
  /* 反向:把纯函数换成"直接遍历"(判定散进装配层)⇒ 红 */
  const noPlan = bootCode.replace(
    'planTerrainRebuild(next, dirtyKeys, terrainFromServer)',
    '((all) => ({ rebuild: all.slice(), full: false, fallback: false }))(next)',
  );
  ok(noPlan !== bootCode, '前提:实现里确实调了 planTerrainRebuild');
  ok(applyEntryProblems(noPlan).some((x) => x.includes('纯函数')), '★ 不用纯函数算计划 ⇒ 必红');
});

test('FND184-4 摘旧 mesh 必须 dispose 几何;删掉 dispose 必红', () => {
  eq(disposeProblems(bootCode), [], '摘旧 mesh = 场景移除 + dispose 几何 + 从 key 表删掉');
  const noDispose = bootCode.replace('mesh.geometry.dispose();', '');
  ok(noDispose !== bootCode, '前提:源码里确实有 mesh.geometry.dispose()');
  ok(disposeProblems(noDispose).some((x) => x.includes('dispose')), '★ 删掉 dispose ⇒ 必红');
  const noSceneRemove = bootCode.replace('scene.remove(mesh);', '');
  ok(noSceneRemove !== bootCode, '前提:源码里确实有 scene.remove(mesh)');
  ok(disposeProblems(noSceneRemove).some((x) => x.includes('场景')), '★ 不从场景移除 ⇒ 必红');
});

/* ═══════════════════ 3 纯函数:该重建哪些块(真 ChunkStore)═══════════════════ */

test('FND184-5 喂 3 块只重建 1 块(真 ClientChunkStore 的 chunks() / dirty())', () => {
  const store = threeChunksOneDirty();
  eq(store.size, 3, '3 块已落地');
  eq(store.dirty(), ['2,0'], '只有 (2,0) 是脏的(脏标记是消费型的)');

  const plan = planTerrainRebuild(store.chunks(), store.dirty(), true);
  eq(plan.rebuild.length, 1, '喂 3 块、只脏 1 块 ⇒ **只重建 1 块**');
  eq(plan.rebuild[0]!.key, '2,0', '重建的就是那块脏的');
  eq(plan.full, false, '不是首帧 ⇒ 不做整表对齐');
  eq(plan.fallback, false, '有服务器块 ⇒ 不是回落');

  /* 反向 1:把脏集合换成**全部** key ⇒ 3 块(说明这条判据真的在看脏集合) */
  const all = planTerrainRebuild(store.chunks(), store.chunks().map((c) => c.key), true);
  eq(all.rebuild.length, 3, '反向:全部 key 都脏 ⇒ 3 块');
  /* 反向 2:脏 key 在来源里不存在 ⇒ 一块都不建(不能凭空造块) */
  const ghost = planTerrainRebuild(store.chunks(), ['9,9'], true);
  eq(ghost.rebuild.length, 0, '反向:脏 key 不在来源里 ⇒ 0 块');
  /* 反向 3:没有脏 key ⇒ 一块都不动(帧到了但内容没变) */
  eq(planTerrainRebuild(store.chunks(), [], true).rebuild.length, 0, '无脏块 ⇒ 0 块');
});

test('FND184-6 首帧(屏幕上还没有服务器块)⇒ 整表对齐,不是只换脏块', () => {
  const store = new ClientChunkStore();
  store.applyWire(frameOf(THREE_CELLS));
  const plan = planTerrainRebuild(store.chunks(), ['0,0'], false);
  eq(plan.rebuild.length, 3, '首帧即使只脏 1 块,也必须**整份**替换设计图占位');
  eq(plan.full, true, '首帧要标成整表对齐(自检口径读它)');
  eq(plan.fallback, false, '有块就不是回落');
  /* 反向:把 hasServerTerrain 说成 true ⇒ 只重建 1 块(设计图那半边会留在屏幕上) */
  eq(planTerrainRebuild(store.chunks(), ['0,0'], true).rebuild.length, 1,
    '反向:当成"已有服务器地形"时就只换 1 块 —— 设计图的另一半会留着');
});

test('FND184-7 一块服务器块都没有 ⇒ 保留设计图回落(并留痕);删掉回落必红', () => {
  const plan = planTerrainRebuild([], [], false);
  eq(plan.fallback, true, '没有服务器块 ⇒ 必须回落设计图(拿不到块时世界也要看得见)');
  eq(plan.rebuild.length, 0, '反向:回落时**不建任何块**(不能凭空造)');
  eq(plan.full, false, '回落不是整表对齐');

  eq(fallbackProblems(bootCode), [], '设计图回落必须真的在,并且留痕');
  /* ★ 反向:把设计图入口删掉 ⇒ "无块时仍返回非空"那条必须红 */
  const noDesign = bootCode.split('buildDesignChunks()').join('[]');
  ok(noDesign !== bootCode, '前提:源码里确实有 buildDesignChunks()');
  ok(fallbackProblems(noDesign).some((x) => x.includes('设计图')), '★ 删掉设计图回落 ⇒ 必红');
  /* ★ 反向:把回落留痕删掉(静默回落)⇒ 红 */
  const noWarn = bootCode.replace("console.warn('[terrain]", 'console.log(');
  ok(noWarn !== bootCode, '前提:源码里确实有 console.warn(\'[terrain]');
  ok(fallbackProblems(noWarn).some((x) => x.includes('留痕')), '★ 静默回落 ⇒ 必红');
});

test('FND184-8 已吃过服务器块后遇到空来源 ⇒ 保持现状(不把屏幕换回设计图)', () => {
  /* 重连把 store `reset()` 之后,dirty 与 chunks 都是空的 —— 但屏幕上已经是服务器地形。 */
  const plan = planTerrainRebuild([], [], true);
  eq(plan.fallback, false, '★ 已经吃过服务器块 ⇒ 不许回落(否则重连后"世界变成另一张图")');
  eq(plan.rebuild.length, 0, '也不建任何块(没有字节可建)');
  /* 反向:同一个输入但 hasServerTerrain=false ⇒ 回落,说明这条判据真的看那个参数 */
  eq(planTerrainRebuild([], [], false).fallback, true, '反向:还没吃过 ⇒ 回落');
});

/* ═══════════════════ 4 HUD / 自检口径 ═══════════════════ */

test('FND184-9 HUD 的规模与来源随地形下行更新(setWorld 接线);删掉 => 必红', () => {
  eq(hudWorldProblems(bootCode), [], 'HUD 必须能被改写规模与来源');
  eq(applyEntryProblems(bootCode).filter((x) => x.includes('HUD')), [], '地形下行必须真的调 hud.setWorld');
  const noSetWorld = bootCode.split('hud.setWorld(').join('void 0;(');
  ok(noSetWorld !== bootCode, '前提:源码里确实调了 hud.setWorld');
  ok(applyEntryProblems(noSetWorld).some((x) => x.includes('HUD')), '★ 不同步 HUD ⇒ 必红');
});

test('FND184-10 summary() 必须报地形来源与三个重建读数', () => {
  eq(summaryFieldProblems(bootCode), [], '四个读数缺一个,自检脚本就分不清"服务器没发"与"发了一块没重建"');
  for (const f of ['terrainSource:', 'terrainApplyCalls,', 'terrainRebuilt:', 'terrainDisposed:']) {
    const broken = bootCode.replace(f, '');
    ok(broken !== bootCode, `前提:源码里确实有 ${f}`);
    ok(summaryFieldProblems(broken).some((x) => x.includes(f.replace(/[:,]$/, ''))),
      `★ 删掉 ${f} ⇒ 必红`);
  }
  eq(TERRAIN_SOURCE_SERVER, 'server', '服务器来源的取值是常量(两处共用一份词表)');
  eq(TERRAIN_SOURCE_DESIGN, 'design', '设计图来源的取值是常量');
});

test('FND184-11 计划里的块就是块存储里那份字节(key 口径 "cx,cy")', () => {
  const store = threeChunksOneDirty();
  const plan = planTerrainRebuild(store.chunks(), store.dirty(), true);
  const stored = store.get('2,0');
  ok(stored !== undefined, '(2,0) 必须在块存储里');
  ok(plan.rebuild[0]!.tiles === stored!.tiles,
    '★ 重建用的必须是**服务器块**的字节(同一个 Uint32Array),不是本地设计图重算的那份');
  eq(plan.rebuild[0]!.cx, 2, '块坐标原样带过去(建面按它算世界偏移)');
  eq(plan.rebuild[0]!.cy, 0, '块坐标原样带过去');
  eq(store.chunks().map((c) => c.key), ['0,0', '1,0', '2,0'], 'key 口径 = "cx,cy",稳定序 (cy,cx)');
});

report('WS-FND-184');