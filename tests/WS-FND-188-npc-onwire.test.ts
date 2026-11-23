/**
 * WS-FND-188 · **NPC 上屏(看得见)+ 能对话** —— 静态表上线 / 立牌跟块 / `NPC_TALK`。
 *
 * ## 这份套件要抓的两个缺陷(改前实测形态,都是"全绿但没有")
 * ```text
 * 1 server/src/npc/defs.ts    有 4 个 NPC、dialogue.talk 有纯函数、npcAt 有空间查询
 *   客户端                     零进口、零立牌、零按键 ⇒ 玩家**看不见也点不到任何人**
 * 2 client/src/three/boot.ts  立牌只在 boot() 里按**首帧设计图块**算一次
 *   (地形已经在跟服务器块重建了 —— WS-FND-184)
 *   ⇒ 玩家拆掉一堵墙:地形面跟着变了,立牌**还是首帧那一份**(幽灵墙)
 * ```
 * 两者都**不报错**:连接是 live、快照照常到、面数统计正常、`propSpriteCount` 也有值。
 *
 * ## 判据表(每条都写清"为什么它不是恒真")
 *
 * | # | 判据 | 为什么有牙 |
 * |---|------|------------|
 * | 1 | NPC 帧往返**逐字节一致**(0 个 / 4 个两个边界) | 编码器改成"差不多就行"(丢字段/多写占位)⇒ 红 |
 * | 2 | 解出来的 4 条**逐字段**等于 `NPCS`(顺序也一致) | 坐标/名字/任务任一处错位 ⇒ 红 |
 * | 3 | tag 与 `PROTOCOL_VERSION`/`0x01`/`0x02`/`{` 都不撞,`classifyDownlink` 判它为二进制 | 换 tag ⇒ "被当差量包解"(协议版本不匹配)那条立刻红 |
 * | 4 | 坏帧**不抛**、`tryDecodeNpcFrame` 给出原因(截断/版本/hasQuest 非法三种) | 改成抛 ⇒ 连接会因为一条可忽略的坏帧停摆(本仓最忌的形态) |
 * | 5 | 真会话:好帧 ⇒ `npcFrames=1` + `onNpcs(4 个)`;坏帧 ⇒ `lastNpcError` 非空且**连接仍 live** | 删掉分流 ⇒ 客户端会以"协议版本不匹配"把它丢掉(症状名指错对象) |
 * | 6 | 分流写在 `session.ts` 的二进制分支里、且在 `store.apply` **之前**;删掉它 ⇒ 红 | 这是"别把它当协议版本不匹配"唯一能落地的地方 |
 * | 7 | 靠近判定:内 / 外 / **恰好 2.5** 两侧 + 非有限读数,且与 `npcAt` **逐值一致** | 把 `<=` 写成 `<`(或改半径)⇒ 红;两端口径不同 = "提示能说、按下去被拒" |
 * | 8 | 台词拼接(`npcTalkTextOf`)+ HUD 那一行(有 NPC 报名字与 `T`;没人 ⇒ **空串**)| 客户端自己编台词 / 写"按 T 与 null 说话"⇒ 红 |
 * | 9 | NPC 立牌计划非空、`atlasCell >= 0`、高度与玩家同档、贴图 id 在物品表里 | 换成图集外的 id ⇒ 一个都画不出来,**且不报错** |
 * | 10 | `NPC_TALK` 走**既有动作路由**(RoomAction 键 + 权限位 + 真处理器 + 真 runtime 回执) | 另开一条报文 = 权限/预算/幂等/回执四件事各写一遍;删掉登记 ⇒ 红 |
 * | 11 | 真 `RoomRuntime.npcFrame()` 的字节 = `encodeNpcFrame(NPCS)` 逐字节一致,解出 4 条 | 房间侧自己拼一份表(不含某个人/坐标不同)⇒ 红 |
 * | 12 | 一次性下发的位置:`hello` 成功路径里 **welcome → 快照 → 地形 → NPC**,只发一次 | 挪到广播循环(每帧重发)或删掉 ⇒ 红 |
 * | 13 | 距离门在**服务端**(权威坐标):近 ⇒ OK 且台词 = `talk()` 逐字;远 / 更近的是别人 / 未知 id / 缺 id ⇒ INVALID;没读口 ⇒ NOT_IMPLEMENTED;连说 5 次**不改账本与背包** | 信客户端报的坐标 ⇒ 站在营地能跟农田里的老农对话 |
 * | 14 | 立牌跟块:真 chunk 计划两次,**改一块 ⇒ 只有那一块的立牌被摘/加**;删掉"摘"这一步 ⇒ 红 | 不摘 = 幽灵立牌;全表重建 = 每帧几百个 Sprite |
 * | 15 | 摘除**不 dispose 共享材质**;`summary()` 有五个立牌读数 + 五个 NPC 读数 | dispose 共享材质会把别的块弄黑(不报错);读数缺一个就分不清"空表"与"没接线" |
 * | 16 | 装配根接线:`onNpcs → setNpcs` + `T` 分派(在 `USE_ITEM` 之前)+ 台词写回 HUD;删任一条 ⇒ 红 | 只接一半(只画不判 / 只判不画)在外部**完全同形** |
 * | 17 | 回归:设计图里真有 `obj`,`planChunkProps` 仍按"先物件、后植被"出计划 | 顺序变了 ⇒ 预算吃紧时被丢的是能交互的墙/灯/箱 |
 *
 * ## 运行
 * `node tests/WS-FND-188-npc-onwire.test.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, report } from '../shared/testing/harness.ts';

import {
  NPC_FRAME_HEADER_BYTES,
  NPC_FRAME_TAG,
  NPC_WIRE_VERSION,
  PROTOCOL_VERSION,
  decodeNpcFrame,
  encodeNpcFrame,
  isNpcFrame,
  tryDecodeNpcFrame,
  type NpcWireDef,
} from '../shared/net/delta.ts';
import { packTile, unpackTile } from '../shared/types/tile.ts';
import { ITEM_BY_ID } from '../shared/constants/items.ts';

import { NPCS, NPC_TALK_RADIUS, npcAt } from '../server/src/npc/defs.ts';
import { talk } from '../server/src/npc/dialogue.ts';
import { RoomAction, ACTION_PERMISSION } from '../server/src/net/room.ts';
import { ACTION_HANDLERS, lookupActionHandler } from '../server/src/net/actions/action_table.ts';
import { npcTalk, npcTalkLedgerSize } from '../server/src/net/actions/npc_talk.ts';
import { assemble } from '../server/src/index.ts';

import {
  NPC_SPRITE_ITEM_ID,
  NPC_TALK_KEY,
  NPC_TALK_RADIUS_CELLS,
  PROP_SPRITE_BUDGET,
  nearbyNpc,
  npcHintLine,
  npcTalkTextOf,
  planChunkProps,
  planNpcSprites,
  planPropApply,
} from '../client/src/three/boot.ts';
import { SPRITE_HEIGHT_PX } from '../client/src/stage/entity_sprites.ts';
import { planObjSprites } from '../client/src/stage/obj_sprites.ts';
import { cellIndexFromId } from '../client/src/stage/assembly_math.ts';
import { buildDesignChunks } from '../client/src/stage/design_world.ts';
import { classifyDownlink, createSession, type WebSocketLike } from '../client/src/net/session.ts';
import { ClientChunkStore } from '../client/src/net/chunk_store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p: string): string => readFileSync(p, 'utf8');

/* ─────────────────────────── 源码工具(与 WS-FND-184 同一手法)─────────────────────────── */

/** 剥注释 —— 不剥的话"把代码注释掉"也能让正则命中 ⇒ 判据没有牙。 */
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

const bootCode = stripComments(read(join(ROOT, 'client/src/three/boot.ts')));
const mainCode = stripComments(read(join(ROOT, 'client/src/main.ts')));
const sessionCode = stripComments(read(join(ROOT, 'client/src/net/session.ts')));
const wsCode = stripComments(read(join(ROOT, 'server/src/net/ws_server.ts')));
const roomCode = stripComments(read(join(ROOT, 'server/src/net/room.ts')));
const tableCode = stripComments(read(join(ROOT, 'server/src/net/actions/action_table.ts')));

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** `NPCS` → 线上形状(**判据自己映射**,不调被测代码的映射)。 */
function wireOfDefs(): NpcWireDef[] {
  return NPCS.map((n) => {
    const q = n.quest;
    return q === undefined
      ? { id: n.id, name: n.name, x: n.home.x, y: n.home.y }
      : {
        id: n.id, name: n.name, x: n.home.x, y: n.home.y,
        quest: { id: q.id, title: q.title, needItemId: q.needItemId, needCount: q.needCount },
      };
  });
}

/** UTF-8 字节数(`str` 编码按**字节**算长度,不是 JS 的字符数)。 */
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** `Uint8Array` → 真 `ArrayBuffer`(真 WebSocket 给的就是这个形态)。 */
function asFrame(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** 一块地形(全空草地 + 指定格上的 obj)。 */
function chunkWith(
  key: string,
  cx: number,
  cy: number,
  objs: Record<number, number>,
): { key: string; cx: number; cy: number; tiles: Uint32Array } {
  const tiles = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    tiles[i] = packTile({ elev: 1, base: 1, floor: 0, wire: 0, obj: 0, meta: 0 });
  }
  for (const [idx, obj] of Object.entries(objs)) {
    const i = Number(idx);
    const u = unpackTile(tiles[i]!);
    tiles[i] = packTile({ elev: u.elev, base: u.base, floor: u.floor, wire: u.wire, obj, meta: u.meta });
  }
  return { key, cx, cy, tiles };
}

/* ═══════════════════ 1 线上帧:编解码往返 + 逐字段 ═══════════════════ */

test('FND188-1 NPC 帧编解码**逐字节往返一致**(0 个 / 4 个两个边界)', () => {
  /* ── 边界 A:0 个(合法输入,且必须自包含 —— 只有帧头) ── */
  const empty = encodeNpcFrame([]);
  eq(empty.length, NPC_FRAME_HEADER_BYTES, `空表 = 帧头 ${NPC_FRAME_HEADER_BYTES} 字节`);
  eq(empty[0], NPC_FRAME_TAG, '首字节是 tag');
  eq(empty[1], NPC_WIRE_VERSION, '次字节是线路版本');
  const emptyRt = decodeNpcFrame(empty);
  eq(emptyRt.npcs.length, 0, '空表解出 0 条');
  ok(bytesEqual(encodeNpcFrame(emptyRt.npcs), empty), '★ 空表往返**逐字节一致**');

  /* ── 边界 B:4 个(= 生产里那张表,含"有任务"与"没任务"两种形态) ── */
  const wire = wireOfDefs();
  eq(wire.length, 4, '前提:`NPCS` 就是 4 个');
  const frame = encodeNpcFrame(wire);
  const dec = decodeNpcFrame(frame);
  eq(dec.npcs.length, 4, '解出 4 条');
  eq(dec.bytesConsumed, frame.length, '恰好消耗完(尾部不许有垃圾)');
  ok(bytesEqual(encodeNpcFrame(dec.npcs), frame), '★ 4 条往返**逐字节一致**(定点坐标也不许抖)');

  /* 反向:多写一个字节(尾部垃圾)⇒ 必须抛(不许"尽量解") */
  const padded = new Uint8Array(frame.length + 1);
  padded.set(frame);
  let threw = '';
  try { decodeNpcFrame(padded); } catch (e) { threw = (e as Error).message; }
  ok(threw.includes('尾部'), `★ 尾部有垃圾 ⇒ 抛错(实得:${threw || '没抛'})`);
});

test('FND188-2 解出来的 4 条**逐字段**等于 `NPCS`(顺序也一致)', () => {
  const dec = decodeNpcFrame(encodeNpcFrame(wireOfDefs())).npcs;
  for (let i = 0; i < NPCS.length; i += 1) {
    const def = NPCS[i]!;
    const got = dec[i]!;
    eq(got.id, def.id, `第 ${i} 条的 id`);
    eq(got.name, def.name, `${def.id} 的名字`);
    eq(got.x, def.home.x, `${def.id} 的 x(设计图格坐标)`);
    eq(got.y, def.home.y, `${def.id} 的 y`);
    eq(got.quest?.title ?? null, def.quest?.title ?? null, `${def.id} 的任务标题`);
    eq(got.quest?.needItemId ?? null, def.quest?.needItemId ?? null, `${def.id} 的任务物品 id`);
    eq(got.quest?.needCount ?? null, def.quest?.needCount ?? null, `${def.id} 的任务件数`);
  }
  /* 台词**不上线**:客户端不该拿到第二份台词表(两份必然漂)。 */
  ok(!JSON.stringify(dec).includes('欢迎来到这座岛'), '★ lines 不许上线(台词由服务端选)');
  /* 负对照:改一个坐标 ⇒ 解出来就不等(证明上面在看真字段) */
  const moved = wireOfDefs();
  moved[0] = { ...moved[0]!, x: moved[0]!.x + 1 };
  ok(decodeNpcFrame(encodeNpcFrame(moved)).npcs[0]!.x !== NPCS[0]!.home.x, '反向:坐标真的会跟着变');
});

test('FND188-3 tag 不与任何既有首字节撞;`classifyDownlink` 判它是二进制', () => {
  const reserved = new Set<number>([0x01, 0x02, 0x7b, PROTOCOL_VERSION]);
  ok(!reserved.has(NPC_FRAME_TAG),
    `★ NPC_FRAME_TAG=${NPC_FRAME_TAG} 不许撞 0x01/0x02/{ /PROTOCOL_VERSION(${PROTOCOL_VERSION})`);
  const frame = encodeNpcFrame(wireOfDefs());
  ok(isNpcFrame(frame), 'isNpcFrame 认它');
  eq(classifyDownlink(frame).kind, 'binary', '★ 它走**二进制**分支(不是 JSON)');
  /* 反向:改掉首字节 ⇒ 不再是 NPC 帧(证明判据真的看 tag) */
  const other = new Uint8Array(frame);
  other[0] = 0x54;
  eq(isNpcFrame(other), false, '反向:换成地形 tag ⇒ 不再被当 NPC 帧');
  ok(!isNpcFrame(new Uint8Array([NPC_FRAME_TAG, NPC_WIRE_VERSION])), '长度不足帧头 ⇒ 不是 NPC 帧');
});

test('FND188-4 坏帧**不抛**且给出原因(截断 / 版本错 / hasQuest 非法)', () => {
  const good = encodeNpcFrame(wireOfDefs());

  const r1 = tryDecodeNpcFrame(good.subarray(0, good.length - 3));
  eq(r1.npcs.length, 0, '★ 坏帧 ⇒ **空表**(不许返回半份)');
  ok((r1.error ?? '').includes('截断'), `截断要指名"截断"(实得:${r1.error})`);

  const badVer = new Uint8Array(good);
  badVer[1] = NPC_WIRE_VERSION + 1;
  const r2 = tryDecodeNpcFrame(badVer);
  ok((r2.error ?? '').includes('版本'), `版本漂移要指名"版本"(实得:${r2.error})`);

  /* hasQuest 非法:第 1 条 = str id + str name + 两个 i32 + 标志字节(长度都按**字节**算)。 */
  const first = NPCS[0]!;
  const flagAt = NPC_FRAME_HEADER_BYTES + 1 + utf8Len(first.id) + 1 + utf8Len(first.name) + 8;
  const badFlag = new Uint8Array(good);
  eq(badFlag[flagAt], 0, '前提:第 1 个 NPC 没任务(标志位是 0)');
  badFlag[flagAt] = 7;
  const r3 = tryDecodeNpcFrame(badFlag);
  ok((r3.error ?? '').includes('quest'), `非法标志要指名"quest"(实得:${r3.error})`);

  /* 好帧 ⇒ `error === null` 且条数对(证明上面三条不是"恒有错") */
  const rOk = tryDecodeNpcFrame(good);
  eq(rOk.error, null, '好帧 error = null');
  eq(rOk.npcs.length, 4, '好帧给出 4 条');
});

/* ═══════════════════ 2 真会话:分流 + 留痕 ═══════════════════ */

test('FND188-5 真会话:好帧 ⇒ npcFrames=1 + onNpcs(4);坏帧 ⇒ lastNpcError 且连接仍 live', () => {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  let closed = false;
  const sock = {
    binaryType: 'blob',              /* 真 WebSocket 的默认值 */
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

  const seen: NpcWireDef[][] = [];
  const drops: string[] = [];
  const s = createSession({
    url: 'ws://fnd188/', makeSocket: () => sock as unknown as WebSocketLike,
    chunks: new ClientChunkStore(),
    connectTimeoutMs: 0, handshakeTimeoutMs: 0,
    events: {
      onFrame: () => { /* 实体快照不在这里测 */ },
      onDrop: (r) => drops.push(r),
      onNpcs: (npcs) => seen.push(npcs),
    },
  });
  fire('open', {});
  fire('message', {
    data: asFrame(new TextEncoder().encode(JSON.stringify({
      t: 'welcome', playerId: 'p1', roomId: 'r188',
      protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-fnd188',
    }))),
  });
  eq(s.state, 'live', '握手完成 ⇒ live');

  /* ── 好帧 ── */
  const frame = encodeNpcFrame(wireOfDefs());
  fire('message', { data: asFrame(frame) });
  eq(s.npcFrames, 1, '★ NPC 帧计数 +1(独立读数,与 terrainFrames 分开)');
  eq(s.lastNpcError, null, '好帧不写错误');
  eq(seen.length, 1, 'onNpcs 被调 1 次');
  eq(seen[0]?.length, 4, '★ **客户端拿到了 4 个 NPC**(这就是"世界里有人"的前提)');
  eq(drops.length, 0, '好帧不产生 drop');

  /* ── 坏帧(tag 对、版本错)── */
  const bad = new Uint8Array(frame);
  bad[1] = NPC_WIRE_VERSION + 1;
  let threw = false;
  try { fire('message', { data: asFrame(bad) }); } catch { threw = true; }
  eq(threw, false, '★ 坏 NPC 帧**不许**把异常抛穿 socket 回调(连接必须活下去)');
  eq(s.npcFrames, 1, '坏帧不计入已落地帧数');
  ok(s.lastNpcError !== null, '★ lastNpcError 记下原因(可拉的证据)');
  eq(seen.length, 1, '坏帧不进 onNpcs');
  eq(s.state, 'live', '★ 坏帧不许把连接判死');
  eq(closed, false, '连接没被关');

  /* 反向:同一条字节把 tag 改成差量包首字节 ⇒ 会以"协议版本不匹配"的形态报出来
     (那正是"症状名 ≠ 成因名"要走开的那条路 ⇒ 分流必须存在)。 */
  const asPacket = new Uint8Array(frame);
  asPacket[0] = PROTOCOL_VERSION;
  const before = s.store.decodeErrors;
  fire('message', { data: asFrame(asPacket) });
  ok(s.store.decodeErrors > before, '反向:当成差量包解 ⇒ 记成坏包(说明分流**确实**改变了行为)');
  s.close();
});

test('FND188-6 分流写在 `session.ts` 的二进制分支里,且在 `store.apply` **之前**', () => {
  const p = (frag: string): number => sessionCode.indexOf(frag);
  ok(p('isNpcFrame(cls.payload)') > 0, 'session.ts 里有 isNpcFrame 分流');
  ok(p('applyNpcFrame(cls.payload)') > 0, '分流调的是 applyNpcFrame');
  ok(p('const r = store.apply(cls.payload);') > p('isNpcFrame(cls.payload)'),
    '★ 判据必须在 store.apply **之前**(否则会被当差量包报「协议版本不匹配」)');
  ok(p('tryDecodeNpcFrame(') > 0, '解帧走**不抛**的那一口');
  ok(p('lastNpcError = d.error') > 0, '坏帧写进 lastNpcError');
  ok(p('opts.events.onNpcs?.(d.npcs)') > 0, '好帧推给 onNpcs');

  /* 反向:把分流整段删掉 ⇒ 上面几条立刻红(有牙实证)。 */
  const at = sessionCode.indexOf('      if (isNpcFrame(cls.payload)) {');
  ok(at > 0, '前提:分流那一行的字面形态');
  const broken = sessionCode.slice(0, at) + sessionCode.slice(at + 200);
  ok(broken !== sessionCode, '前提:确实切掉了一段');
  ok(broken.indexOf('applyNpcFrame(cls.payload)') < 0, '★ 删掉分流 ⇒ 检测器必须报红');
});

/* ═══════════════════ 3 客户端纯函数:靠近 / 文案 / 立牌 ═══════════════════ */

test('FND188-7 靠近判定:内 / 外 / **恰好 2.5** 两侧;与 `npcAt` 逐值一致', () => {
  eq(NPC_TALK_RADIUS_CELLS, NPC_TALK_RADIUS,
    '★ 客户端半径必须与服务端 `NPC_TALK_RADIUS` 同值(两端不同 = "提示能说、按下去被拒")');
  const wire = wireOfDefs();
  const mayor = NPCS[0]!;
  eq(mayor.id, 'npc_mayor', '前提:第 0 个是镇长(96,96)');

  /* 恰好 2.5 格的两侧:2.5 含边界,**2.5 + 1e-6 不含**。 */
  eq(nearbyNpc(wire, mayor.home.x + 2.5, mayor.home.y)?.id, mayor.id, '恰好 2.5 ⇒ 在范围内(含边界)');
  eq(nearbyNpc(wire, mayor.home.x + 2.5 + 1e-6, mayor.home.y), null, '刚过 2.5 ⇒ 没人');
  eq(nearbyNpc(wire, mayor.home.x + 2.4, mayor.home.y)?.id, mayor.id, '2.4 ⇒ 在范围内');
  eq(nearbyNpc(wire, mayor.home.x - 2.5, mayor.home.y)?.id, mayor.id, '另一侧恰好 2.5 ⇒ 同样算在');

  /* 与**服务端**的同一对坐标逐值一致(两端口径必须同源)。 */
  for (const [dx, dy] of [[0, 0], [1.5, 1.5], [2.5, 0], [3, 0], [10, 10]] as const) {
    const x = mayor.home.x + dx;
    const y = mayor.home.y + dy;
    eq(nearbyNpc(wire, x, y)?.id ?? null, npcAt(x, y)?.id ?? null,
      `(${x},${y}) 上客户端与服务端必须给出**同一个**人(含"都没有")`);
  }
  /* 非有限读数 ⇒ null(不知道玩家在哪时不猜 —— 猜了会在出生点就能跟农田里的人说话) */
  eq(nearbyNpc(wire, Number.NaN, 0), null, 'NaN 横坐标 ⇒ null');
  eq(nearbyNpc(wire, 0, Infinity), null, 'Infinity 纵坐标 ⇒ null');
  eq(nearbyNpc([], mayor.home.x, mayor.home.y), null, '空表 ⇒ null(不是"随便挑一个")');
});

test('FND188-8 台词拼接与 HUD 那一行(纯函数)', () => {
  eq(npcTalkTextOf({ npc: '镇长·阿岭', line: '欢迎来到这座岛。' }), '镇长·阿岭:欢迎来到这座岛。',
    '拼接格式:名字 + 冒号 + 台词');
  eq(npcTalkTextOf({ line: '没名字' }), 'NPC:没名字', '缺 npc ⇒ 用中性名字(不写 undefined)');
  eq(npcTalkTextOf({ npc: 'X' }), '', '★ 缺 line ⇒ 空串(调用方据此不写这一行)');
  eq(npcTalkTextOf({ npc: 'X', line: 42 }), '', 'line 不是字符串 ⇒ 空串');
  eq(npcTalkTextOf(undefined), '', 'undefined ⇒ 空串');
  eq(npcTalkTextOf(null), '', 'null ⇒ 空串');

  const wire = wireOfDefs();
  const line = npcHintLine(wire[0]!);
  ok(line.includes(wire[0]!.name), `提示要报名字(实得:${line})`);
  ok(line.includes(NPC_TALK_KEY.toUpperCase()), '提示要报按哪个键');
  ok(line.includes('使用道具'), '★ 提示要说清"走开之后这个键仍是使用道具"(一键两义必须写在屏幕上)');
  eq(npcHintLine(null), '', '★ 附近没人 ⇒ 空串(不许写"按 T 与 null 说话")');
});

test('FND188-9 NPC 立牌计划非空、atlasCell ≥ 0、高度与玩家同档、贴图 id 在物品表里', () => {
  const plan = planNpcSprites(wireOfDefs());
  eq(plan.length, 4, '4 个 NPC ⇒ 4 条立牌计划');
  for (const p of plan) {
    ok(p.atlasCell >= 0, `★ ${p.id} 的 atlasCell 必须 ≥ 0(=-1 会一个都画不出来,且**不报错**)`);
    eq(p.atlasCell, cellIndexFromId(NPC_SPRITE_ITEM_ID), '贴图格来自 `cellIndexFromId`(不手算下标)');
    eq(p.heightPx, SPRITE_HEIGHT_PX.player, '高度与玩家立牌**同档**(人比人高会被读成另一个物种)');
  }
  ok(ITEM_BY_ID.has(NPC_SPRITE_ITEM_ID),
    `★ 临时贴图 ${NPC_SPRITE_ITEM_ID} 必须在冻结物品表里(否则图集格是另一个东西)`);
  ok(plan.filter((p) => p.hasQuest).length === 3, '3 个 NPC 有任务(镇长刻意没有 ⇒ 负对照)');
  /* 反向:图集外的 id 给出 -1(证明上面那条不是恒真) */
  ok(cellIndexFromId(99999) < 0, '反向:图集外的 id 给出 -1');
});

/* ═══════════════════ 4 服务端:帧 + 动作路由 ═══════════════════ */

test('FND188-10 `RoomAction.NPC_TALK` 走**既有动作路由**,登记的是真处理器', () => {
  ok(roomCode.includes("NPC_TALK: 'NPC_TALK',"), '★ RoomAction 里有 NPC_TALK(不是另开一套报文)');
  ok(roomCode.includes("NPC_TALK: 'baseline',"), '权限位登记了');
  eq(ACTION_PERMISSION[RoomAction.NPC_TALK], 'baseline', '与 NPC 说话是基础生存动作(游客也能问路)');
  eq(lookupActionHandler(RoomAction.NPC_TALK), npcTalk, '★ 登记的是真处理器(不是 notImplemented 占位)');
  ok(tableCode.includes("import { npcTalk } from './npc_talk.ts';"), '处理器来自它自己那个模块(改它不碰 room.ts)');

  /* 反向:删掉 action_table 里那一行 ⇒ 上面那条 eq 当场红(有牙实证)。 */
  const broken = tableCode.replace('  NPC_TALK: npcTalk,\n', '');
  ok(broken !== tableCode, '前提:源码里确实有 `NPC_TALK: npcTalk,`');
  ok(!broken.includes('NPC_TALK: npcTalk,'), '★ 删掉登记 ⇒ `lookupActionHandler` 会给回 undefined(上一条红)');

  /* ★ 运行时实证(比源码文本更强):把登记项**真的删掉**,`dispatchAction` 就必须
     回 `NOT_IMPLEMENTED`(即"这条路由不存在"是可观测的)。随后立刻复原。 */
  const table = ACTION_HANDLERS as unknown as Record<string, unknown>;
  const saved = table.NPC_TALK;
  try {
    delete table.NPC_TALK;
    eq(lookupActionHandler(RoomAction.NPC_TALK), undefined,
      '★ 删掉路由 ⇒ 查不到处理器("路由存在"这件事因此**可断**而非恒真)');
    const rtNoRoute = assemble({ roomId: 'r_npc_noroute', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16 }).runtime;
    rtNoRoute.join({ userId: 'o' });
    eq(rtNoRoute.dispatchAction('o', RoomAction.NPC_TALK, { npcId: 'npc_mayor' }).kind, 'NOT_IMPLEMENTED',
      '★ 删掉路由 ⇒ 回 NOT_IMPLEMENTED(那条 eq(npcTalk) 的负向对照)');
  } finally {
    table.NPC_TALK = saved;
  }
  eq(lookupActionHandler(RoomAction.NPC_TALK), npcTalk, '复原:登记又回来了(不污染后续用例)');

  /* 行为级:真 runtime 跑一次。`{}` 载荷 ⇒ INVALID(不是 NOT_IMPLEMENTED ⇒ 它**接上了**) */
  const rt = assemble({ roomId: 'r_npc_route', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16 }).runtime;
  rt.join({ userId: 'o' });
  const out = rt.dispatchAction('o', RoomAction.NPC_TALK, {});
  eq(out.kind, 'INVALID', '★ 缺 npcId ⇒ INVALID(参数问题),而**不是** NOT_IMPLEMENTED(没有功能)');
  const bad = rt.dispatchAction('o', RoomAction.NPC_TALK, { npcId: 'npc_不存在' });
  eq(bad.kind, 'INVALID', '不存在的 npcId ⇒ INVALID(不假装它说了什么)');
});

test('FND188-11 真 `RoomRuntime.npcFrame()`:4 条、坐标与 `NPCS` 一致、字节与共享编码器逐字节一致', () => {
  const rt = assemble({ roomId: 'r_npc_frame', ownerId: 'o', clock: { nowMs: () => 0 }, sizeCells: 16 }).runtime;
  const frame = rt.npcFrame();
  const dec = decodeNpcFrame(frame);
  eq(dec.npcs.length, 4, '★ 客户端拿到的就是 4 个(**这条 + FND188-5** 合起来才叫"客户端拿到 4 个")');
  eq(dec.npcs.map((n) => n.id).join(','), NPCS.map((n) => n.id).join(','), 'id 顺序 = 声明顺序(确定性)');
  eq(dec.npcs.map((n) => `${n.x},${n.y}`).join(' '), NPCS.map((n) => `${n.home.x},${n.home.y}`).join(' '),
    '坐标 = `NpcDef.home`(不换算第二遍 —— 两端各换算一次就是"人站半格外")');
  ok(bytesEqual(frame, encodeNpcFrame(wireOfDefs())), '★ 房间编出来的字节 = 共享编码器的输出(逐字节)');
});

test('FND188-12 一次性下发:在 hello 成功路径里,welcome → 快照 → 地形 → NPC,且只发一次', () => {
  ok(wsCode.includes('npcFrame?(): Uint8Array;'), 'WsRoomLike 上声明了可选读口(单机房不实现 ⇒ 整段不发)');
  ok(wsCode.includes('const pushNpcFrame = (c: WsConn)'), '有唯一的发送出口');
  const order = ['t: \'welcome\'', 'sendBinary(c, withAckedSeq(', 'pushTerrain(c, TERRAIN_JOIN_BURST_FRAMES);', 'pushNpcFrame(c);']
    .map((f) => wsCode.indexOf(f));
  ok(order.every((i) => i > 0), `四步都在源码里(实得:${order.join(',')})`);
  ok(order[0]! < order[1]! && order[1]! < order[2]! && order[2]! < order[3]!,
    '★ 顺序必须是 welcome → 首帧快照 → 地形突发 → NPC(静态数据早到没有消费者)');
  eq(wsCode.split('pushNpcFrame(c);').length - 1, 1, '★ 只在握手处发**一次**(进广播循环 = 每帧重发)');
  ok(wsCode.includes('npcFramesSent += 1;'), '发送计数(自检口径)');

  /* 反向:删掉那一行调用 ⇒ 顺序/次数判据必须报红(即"客户端拿到 4 个"的前提消失)。 */
  const broken = wsCode.replace('    pushNpcFrame(c);\n', '');
  ok(broken !== wsCode, '前提:源码里确实有那一行调用');
  ok(broken.split('pushNpcFrame(c);').length - 1 === 0, '★ 删掉一次性 NPC 帧 ⇒ 上面的次数判据当场红');
});

/* ═══════════════════ 5 服务端:距离门(手搓 ctx) ═══════════════════ */

/** 动作上下文的形状(取自处理器签名本身 ⇒ 不会与 `ActionContext` 漂)。 */
type Ctx = Parameters<typeof npcTalk>[0];

/**
 * 最小 `ActionContext` —— 只给 `npc_talk` 真正读的那些口。
 * 与 `tests/WS-FND-77` 的 BUY_ITEM 夹具同一手法(手搓 ctx 是仓库既有做法)。
 */
function mkCtx(
  at: { x: number; y: number } | null,
  payload: Record<string, unknown>,
  stock: Record<number, number> | null,
): Ctx {
  const ids = stock === null ? null : Object.keys(stock).map(Number);
  return {
    actorId: 'o',
    action: RoomAction.NPC_TALK,
    payload,
    state: { roomId: 'r_npc_talk' },
    authorize: () => ({ allowed: true }),
    hostPositionOf: () => at,
    itemCountOf: stock === null ? undefined : (_u: string, id: number) => stock[id] ?? 0,
    itemIdsOf: ids === null ? undefined : () => ids,
  } as unknown as Ctx;
}

test('FND188-13 距离门在**服务端**(权威坐标):近 ⇒ OK 且台词 = `talk()`;远 / 借别人的 id ⇒ INVALID', () => {
  const mayor = NPCS[0]!;
  const stock: Record<number, number> = {};
  const ledgerBefore = npcTalkLedgerSize();

  /* ── 近(1 格)⇒ OK ── */
  const near = npcTalk(mkCtx({ x: mayor.home.x + 1, y: mayor.home.y }, { npcId: mayor.id }, stock));
  eq(near.kind, 'OK', `站在旁边应当成功(实得 ${near.kind}:${near.reason ?? ''})`);
  const expected = talk(mayor.id, { inventory: stock, quests: {} });
  eq(near.effect?.npc, mayor.name, '回执里是**谁**在说话');
  eq(near.effect?.line, expected.line, '★ 台词 = `dialogue.talk()` 的返回(服务端选,不是客户端编)');
  eq(near.effect?.npcId, mayor.id, '回执里带 npcId(UI 对账用)');
  eq(near.effect?.rewardItemId ?? null, null, '★ `talk` **不发奖**(领奖是另一条写路径)');

  /* ── 远(隔半张地图)⇒ INVALID ── */
  const far = npcTalk(mkCtx({ x: 10, y: 10 }, { npcId: mayor.id }, stock));
  eq(far.kind, 'INVALID', '★ 隔着半张地图伪造一条报文 ⇒ 必被拒(客户端报的坐标不构成授权)');
  ok((far.reason ?? '').includes('附近'), `拒因要指向"附近没人"(实得:${far.reason})`);

  /* ── 站在镇长面前却报农夫(更近的是别人)⇒ INVALID ── */
  const farmer = NPCS[1]!;
  const wrong = npcTalk(mkCtx({ x: mayor.home.x + 1, y: mayor.home.y }, { npcId: farmer.id }, stock));
  eq(wrong.kind, 'INVALID', '★ 报文里的 npcId 与"最近的人"不一致 ⇒ 拒');
  ok((wrong.reason ?? '').includes(mayor.name), `拒因要点名你离谁更近(实得:${wrong.reason})`);

  /* ── 载荷形状与链路 ── */
  eq(npcTalk(mkCtx({ x: mayor.home.x, y: mayor.home.y }, {}, stock)).kind, 'INVALID', '缺 npcId ⇒ INVALID');
  eq(npcTalk(mkCtx({ x: mayor.home.x, y: mayor.home.y }, { npcId: 42 }, stock)).kind, 'INVALID',
    'npcId 不是字符串 ⇒ INVALID(不猜)');
  eq(npcTalk(mkCtx(null, { npcId: mayor.id }, stock)).kind, 'INVALID', '拿不到权威位置 ⇒ INVALID');
  eq(npcTalk(mkCtx({ x: mayor.home.x, y: mayor.home.y }, { npcId: mayor.id }, null)).kind, 'NOT_IMPLEMENTED',
    '★ 没有按件库存读口 ⇒ fail-closed(**不**退回"have = 0"那种假数据)');

  /* ── 连说 5 次:账本与背包一个字节都不变(本动作只说话) ── */
  for (let i = 0; i < 5; i += 1) {
    npcTalk(mkCtx({ x: mayor.home.x, y: mayor.home.y }, { npcId: mayor.id }, stock));
  }
  eq(npcTalkLedgerSize(), ledgerBefore, '★ 说话不改任务账本(领/交任务是另一条路,不在本轮)');
  eq(Object.keys(stock).length, 0, '★ 说话不改背包');
});

/* ═══════════════════ 6 立牌跟块 ═══════════════════ */

test('FND188-14 立牌跟块:改一块 ⇒ **只有那一块**的立牌被摘/加(真 chunk 计划两次)', () => {
  /* 两块真数据(合成 fixture:0,0 有 3 个 obj;1,0 有 1 个)。 */
  const a1 = chunkWith('0,0', 0, 0, { 5: 522, 6: 522, 21: 513 });
  const b1 = chunkWith('1,0', 1, 0, { 9: 352 });
  const before = { a: planChunkProps(a1, [118], 0x5eed), b: planChunkProps(b1, [118], 0x5eed) };
  /* ⚠️ 计划里**同时**含植被(`kind: 'vegetation'`)—— 数物件那一条必须显式筛 kind,
     否则"植物多长了一棵"会被读成"墙多了一堵"(而两者都不报错)。 */
  const objs = (list: readonly { kind: string }[]): number => list.filter((p) => p.kind === 'obj').length;
  eq(objs(before.a), 3, '前提:A 块有 3 条**物件**立牌(另有植被,不参与本条)');
  eq(objs(before.b), 1, '前提:B 块有 1 条物件立牌');

  /* 玩家拆掉 A 块里那两格墙(obj 522 → 0)⇒ **A 的物件立牌计划变了,B 的一条不改**。 */
  const a2 = chunkWith('0,0', 0, 0, { 21: 513 });
  eq(objs(planChunkProps(a2, [118], 0x5eed)), 1, '改完之后 A 只剩 1 条物件立牌');
  eq(JSON.stringify(planChunkProps(b1, [118], 0x5eed)), JSON.stringify(before.b),
    '★ **另一块**的立牌计划逐字节不变(不许"顺手全表重算")');

  /* 计划:被重建的只有 A ⇒ 摘/加都只涉及 A。 */
  const plan = planPropApply(['0,0', '1,0'], [a2]);
  eq(plan.remove, ['0,0'], '★ 只摘被重建的那一块(另一块的立牌留在场景里)');
  eq(plan.add.map((c) => c.key), ['0,0'], '★ 只加被重建的那一块');
  ok(!plan.remove.includes('1,0'), 'B 块不在摘除名单里');

  /* 负对照:没登记过的块被重建 ⇒ 摘除名单为空(摘一个不存在的键是空操作,但读数会虚高)。 */
  eq(planPropApply(['1,0'], [a2]).remove, [], '反向:表里没有 A ⇒ 不摘它');
  /* 首帧整表对齐 ⇒ 全部摘、全部加。 */
  const all = planPropApply(['0,0', '1,0'], [a1, b1]);
  eq(all.remove.length, 2, '整表对齐 ⇒ 两块都摘');
  eq(all.add.length, 2, '整表对齐 ⇒ 两块都加');

  /* 装配层真的按这个计划做了(源码断言 + 反向)。 */
  const at = bootCode.indexOf('const applyTerrainChunks = (');
  ok(at > 0, '前提:存在 applyTerrainChunks');
  const body = bootCode.slice(at, at + 3000);
  ok(body.includes('planPropApply('), '★ 计划由纯函数算(判定不散进装配层)');
  ok(body.includes('removePropsForChunk(key)'), '★ 先摘');
  ok(body.includes('addPropsForChunk(chunk)'), '★ 再建');
  ok(body.indexOf('removePropsForChunk(key)') < body.indexOf('addPropsForChunk(chunk)'), '顺序:先摘后建');
  const noRemove = body.replace('for (const key of propPlan.remove) removePropsForChunk(key);', '');
  ok(noRemove !== body, '前提:源码里确实有"按计划摘除"那一行');
  ok(!noRemove.includes('removePropsForChunk(key)'), '★ 不摘 ⇒ 幽灵立牌(这条判据当场红)');
});

test('FND188-15 立牌摘除**不 dispose 共享材质**;summary 能看出"表为空"', () => {
  const at = bootCode.indexOf('const removePropsForChunk = (key: string)');
  ok(at > 0, '前提:存在 removePropsForChunk');
  const body = bootCode.slice(at, at + 700);
  ok(body.includes('scene.remove(sp)'), '★ 从场景里摘掉(= 真的不画了)');
  ok(!body.includes('material.dispose()'),
    '★ 摘除**不许** dispose 材质:它是按图集格共享的(会把其它块的立牌一起弄黑)');
  ok(body.includes('propsByChunk.delete(key)'), '从表里删掉(否则下次重建会当成新块,计数虚高)');
  ok(bootCode.includes('for (const m of propMaterials.values())'),
    '共享材质在 `dispose()` 里**统一**释放(唯一一次)');
  eq(PROP_SPRITE_BUDGET, 600, '立牌总数仍封顶 600(不许因为"跟块"就把上限去掉)');

  /* summary 的读数(少一个就分不清"空表"与"没接线") */
  const s = bootCode.indexOf('summary: () => ({');
  ok(s > 0, '前提:存在 summary()');
  const summary = bootCode.slice(s, s + 9000);
  for (const f of ['propSpriteCount', 'propChunkCount', 'propRemovedChunks', 'propDroppedByBudget',
    'propTableEmpty', 'npcCount', 'npcSpriteCount', 'npcAtlasCell', 'npcHintLine', 'npcTalkLine']) {
    ok(new RegExp(`\\b${f}\\b\\s*[:,]`).test(summary), `summary() 缺 ${f}`);
  }
  const noEmpty = summary.replace('propChunkCount: propChunks.size,', '');
  ok(noEmpty !== summary, '前提:summary 里确实有 propChunkCount');
  ok(!new RegExp('\\bpropChunkCount\\b\\s*[:,]').test(noEmpty),
    '★ 删掉"立牌表有几块"这个读数 ⇒ 上面的检查立刻红');
});

/* ═══════════════════ 7 客户端接线(装配根)与回归 ═══════════════════ */

test('FND188-16 `main.ts`:NPC 表 → boot(画)与按键(判)两件事都接上;删任一条 ⇒ 红', () => {
  ok(mainCode.includes('onNpcs: (npcs) => {'), '★ 会话的 NPC 事件接上了(否则一条字节都没有消费者)');
  ok(mainCode.includes('handle.setNpcs(npcs);'), '★ 交给 boot 摆立牌(看得见)');
  ok(mainCode.includes('npcList = npcs;'), '★ 留在本文件给按键判定(点得到)');
  ok(mainCode.includes('npcTalkTextOf(r.effect)'), '★ 台词从回执的 effect 拼出来(不自己编台词)');
  ok(mainCode.includes('handle.showTalk(said);'), '★ 台词写进 HUD');
  ok(mainCode.includes('actionEntry.npcTalk({ npcId: near.id })'), '★ 走**同一条**动作入口(三支分流)');
  ok(mainCode.includes('nearbyNpc(npcList,'), '★ 按键判定用同一份表与同一个纯函数');
  ok(mainCode.includes('ev.key.toLowerCase() === NPC_TALK_KEY'), '★ `T` 分派存在');
  ok(mainCode.indexOf('actionEntry.npcTalk({') < mainCode.indexOf('const spec = ACTION_KEYS'),
    '★ 分派必须在 `USE_ITEM` 那一条**之前**(否则永远走不到)');

  for (const frag of ['handle.setNpcs(npcs);', 'npcList = npcs;', 'handle.showTalk(said);',
    'actionEntry.npcTalk({ npcId: near.id })']) {
    const broken = mainCode.replace(frag, '');
    ok(broken !== mainCode, `前提:源码里确实有 ${frag}`);
    ok(!broken.includes(frag), `★ 删掉 ${frag} ⇒ 对应那条判据当场红`);
  }
});

test('FND188-17 回归:设计图里真有 `obj`,`planChunkProps` 仍按"先物件、后植被"出计划', () => {
  /* 这条是"我改的是装配层,不是计划层"的守门:车道 B 的 `obj_sprites.ts` 一个字都不该动。 */
  const real = buildDesignChunks();
  const total = real.reduce((s, c) => s + planObjSprites(c).length, 0);
  ok(total > 0, '设计图里确实有 obj(所以"立牌跟块"有东西可跟)');
  const anyReal = real.find((c) => planObjSprites(c).length > 0)!;
  const planned = planChunkProps(anyReal, [118, 379], 0x5eed);
  ok(planned.length > 0, `有 obj 的真块必须产出立牌计划(实得 ${planned.length})`);
  ok(planned.every((p) => p.kind === 'obj' || p.kind === 'vegetation'), 'kind 只有两种');
  /* 顺序契约:先物件、后植被(预算截断丢的是尾部 ⇒ 交互物件要留在屏幕上) */
  const firstVeg = planned.findIndex((p) => p.kind === 'vegetation');
  if (firstVeg >= 0) {
    ok(planned.slice(firstVeg).every((p) => p.kind === 'vegetation'),
      '★ 顺序必须是"先物件、后植被"(否则预算吃紧时丢的是能交互的墙/灯/箱)');
  }
});

report('WS-FND-188');
