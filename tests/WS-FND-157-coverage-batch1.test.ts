/**
 * WS-FND-157 —— **导出覆盖矩阵:第一批欠账(风险顺序前 15 条)**。
 *
 * ## 取哪 15 条(口径可复算)
 *
 * 来源 = `docs/COVERAGE-MATRIX.md` §2 待处置清单里「`none` 且仍被生产引用」那一档
 * (`node scripts/coverage-matrix.ts` 的 §3 打印同一份,**279 条**;本文件只吃前 15 条)。
 *
 * 排序**不按文件名字典序**,按**风险**:账 / 权限 / 距离 / 结算 / 持久化在前,
 * 纯格式化 helper 在后(本批一条格式化 helper 都没进 —— 它们还在池子里,风险最低)。
 *
 * ```text
 * # 导出(文件:符号)                          风险面                             本节判据
 * 1  db/repo.ts:setRoomStatus                 权限/持久化(休眠=存档的唯一写口)  FND157-1
 * 2  db/repo.ts:listRooms                     持久化(谁被载入/被排除)            FND157-2
 * 3  db/repo.ts:loadVitalsFromUsers           账(血量落盘的读回)                 FND157-3
 * 4  db/repo.ts:clampInt                      持久化边界(整数写入闸)             FND157-4 / FND157-4b
 * 5  db/repo.ts:TABLE_PRIMARY_KEYS            持久化契约(主键 / 表名白名单)      FND157-5
 * 6  net/actions/admin.ts:setRoomAccess       权限(改访问模式)                   FND157-6
 * 7  net/actions/admin.ts:closeRoom           权限(唯一**不带**宿主闸的处理器)    FND157-7
 * 8  party/actions.ts:gatePartyStart          权限(裁判哨台开会)                 FND157-8
 * 9  party/scoring.ts:rewardsForTeams         结算(团队发奖)                     FND157-9
 * 10 party/scoring.ts:rewardsForPlayers       结算(个人发奖)                     FND157-10
 * 11 party/modes.ts:settlePartyRun            结算(幂等:只结算一次)              FND157-11
 * 12 coop/rush_actions.ts:rushAcceptsDelivery 距离/结算(急单交付窗口)            FND157-12
 * 13 coop/rush_actions.ts:rushRewardCellOf    结算落点(奖励落哪一格)             FND157-13
 * 14 systems/depot.ts:CONTENT_PRICE_TABLE     账(定价表 = 内容表派生)            FND157-14
 * 15 net/actions/types.ts:ActionHandler       **无需**(见下)                     —
 * ```
 *
 * ## 无需(本批 3 条;台账状态列写 `无需(理由)`)
 *
 * ```text
 * server/src/net/actions/types.ts:ActionHandler
 *   理由:纯**类型导出**(`type ActionHandler = (ctx: ActionContext) => ActionOutcome`)。
 *   运行时它不存在,没有任何可断言的副作用/返回值;47 处生产引用全部是类型标注位。
 *   它体现的契约(「成功必带 effect、失败 kind 如其实」)由**注册表 + 每个处理器**判
 *   (`tests/WS-FND-154` FND154-1 判键集与真处理器,`tests/WS-FND-18` FND18-3 判 effect)——
 *   在本文件再写一条 `typeof handler === 'function'` 只会是「拿类型当值」的假判据。
 *
 * server/src/party/scoring.ts:PaintStanding / RaceResult
 *   理由:同上 —— **类型导出**。本文件第 9/10 节把它们用作 `PaintStanding[]` /
 *   `RaceResult[]` 的标注位,于是矩阵把这两行从 `none` 计成 `behavior`
 *   (矩阵自陈的边界 1:type 的 behavior 只表示「在测试代码里被引用(类型位)」)。
 *   它们**没有**可断言的运行时行为;真正的值语义由 `rewardsForTeams` /
 *   `rewardsForPlayers` 那两条判据盖住(名次/队伍/玩家字段逐条对账)。
 * ```
 *
 * ## 判据形态纪律
 *
 * 每条 = **调真函数** + **断后果**(返回值 / 落库行 / 副作用)+ **负对照**
 * (该拒的必须拒,且**零副作用**;该变的必须变,且**只有它变**)。
 * 常数不抄进断言:能用内容表/DDL/对偶函数复算的,一律**复算对账**。
 *
 * 运行:`node tests/WS-FND-157-coverage-batch1.test.ts`
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, ok, eq, includes, mulberry32, report } from '../shared/testing/harness.ts';

import { MemoryDb } from '../server/src/db/memory_db.ts';
import {
  AccessMode,
  RoomStatus,
  TABLE_PRIMARY_KEYS,
  WORLD_ARCHIVE_TABLE,
  clampInt,
  createRoom,
  createUser,
  getRoom,
  listRooms,
  loadVitalsFromUsers,
  migrate,
  schemaSqlPath,
  saveVitalsToUsers,
  setRoomStatus,
} from '../server/src/db/repo.ts';
import { closeRoom, setRoomAccess } from '../server/src/net/actions/admin.ts';
import type { ActionContext } from '../server/src/net/actions/types.ts';
import { RoomAction } from '../server/src/net/room.ts';
import { GATE_REJECT, gatePartyStart } from '../server/src/party/actions.ts';
import {
  PARTY_MODE_KEY,
  createBridgeRun,
  createPartyMode,
  modeTotalSec,
  settlePartyRun,
  startPartyMode,
  tickPartyMode,
} from '../server/src/party/modes.ts';
import {
  DEFAULT_STATION_CELLS,
  RUSH_ORDER_STATE,
  createManualClock,
  createRushOrderSession,
  startRushOrder,
} from '../server/src/coop/rush_order.ts';
import { rushAcceptsDelivery, rushRewardCellOf } from '../server/src/coop/rush_actions.ts';
import {
  REWARD_EXP_BY_RANK,
  REWARD_ITEM_BY_RANK,
  rewardsForPlayers,
  rewardsForTeams,
  type PaintStanding,
  type RaceResult,
} from '../server/src/party/scoring.ts';
import { CONTENT_PRICE_TABLE, buy, contentPriceTable, priceOf } from '../server/src/systems/depot.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';

/* ═══════════════════════ 0. 夹具 ═══════════════════════ */

/** 迁移过的内存库 + 两行用户 + 一间房(与 `tests/WS-07.test.ts` 同一手法)。 */
function newDb(): MemoryDb {
  const db = new MemoryDb();
  migrate(db, 1000);
  createUser(db, { id: 'u1', displayName: 'A', nowMs: 1000 });
  createUser(db, { id: 'u2', displayName: 'B', nowMs: 1000, maxHp: 40 });
  createRoom(db, { id: 'r1', ownerId: 'u1', nowMs: 1000 });
  return db;
}

/** 动作层 `ActionContext` 手搓桩:只填处理器真会用到的那几口,并**记账**。 */
function makeCtx(opts: {
  action?: RoomAction;
  payload?: Record<string, unknown>;
  allowed?: boolean;
  closeOk?: boolean;
  accessOk?: boolean;
} = {}): {
  ctx: ActionContext;
  log: {
    access: { actorId: string; mode: unknown; passwordHash: string | null }[];
    close: number;
    classify: { actorId: string; action: RoomAction; reason: string | undefined }[];
  };
  status: { value: RoomStatus };
} {
  const status = { value: RoomStatus.OPEN as RoomStatus };
  const log = {
    access: [] as { actorId: string; mode: unknown; passwordHash: string | null }[],
    close: 0,
    classify: [] as { actorId: string; action: RoomAction; reason: string | undefined }[],
  };
  const raw = {
    actorId: 'u1',
    action: opts.action ?? RoomAction.CLOSE_ROOM,
    payload: opts.payload ?? {},
    state: { meta: { tick: 1 }, roomId: 'r1' },
    host: null,
    authorize: () => (opts.allowed === false ? { allowed: false, reason: '无权' } : { allowed: true }),
    classifyFailure: (actorId: string, action: RoomAction, reason: string | undefined) => {
      log.classify.push({ actorId, action, reason });
      return { ok: false, kind: 'PERMISSION', reason: `分类:${reason ?? ''}` };
    },
    materialsOf: () => null,
    hostPositionOf: () => null,
    applyInventory: () => ({ allowed: true, afterTotal: 0 }),
    grantItemSource: () => undefined,
    setMemberRole: () => ({ ok: true }),
    kick: () => ({ ok: true }),
    setAccess: (actorId: string, mode: unknown, passwordHash: string | null) => {
      log.access.push({ actorId, mode, passwordHash });
      return opts.accessOk === false ? { ok: false, reason: '无权' } : { ok: true };
    },
    setPartyModeBy: () => ({ ok: true }),
    close: () => {
      log.close += 1;
      if (opts.closeOk === false) return false;
      status.value = RoomStatus.CLOSED;
      return true;
    },
  };
  /* `status` 必须是**活读**的 getter(见 `actions/types.ts` 文件头):
     装配时取一次快照会让 `CLOSE_ROOM` 的回执谎报 `OPEN`。 */
  Object.defineProperty(raw, 'status', { get: () => status.value, enumerable: true });
  return { ctx: raw as unknown as ActionContext, log, status };
}

/** 一格急单会话(与 `tests/WS-FND-108` 同一夹具)。 */
function rushSession() {
  const clock = createManualClock(0);
  const s = createRushOrderSession({ clock, roomLevel: 1, seed: 7, rng: mulberry32(7) });
  return { clock, s };
}

/* ═══════════════════════ 1. 房间生命周期(持久化 / 权限)═══════════════════════ */

test('FND157-1 setRoomStatus:休眠=存档(status/last_active_at/saved_at 真落库;未知房间零副作用)', () => {
  /* 覆盖导出:server/src/db/repo.ts:setRoomStatus */
  const db = newDb();
  eq(getRoom(db, 'r1')?.status, RoomStatus.OPEN, '前提:新建房间是 OPEN');
  const roomsBefore = db.count('rooms');

  /* 正例:休眠写三列 —— `saved_at` 只有**休眠**这一支才写(它就是「存档时刻」)。 */
  eq(setRoomStatus(db, 'r1', RoomStatus.SLEEPING, 5000), 1, '写中 1 行');
  const slept = getRoom(db, 'r1');
  eq(slept?.status, RoomStatus.SLEEPING, 'status 真落库');
  eq(slept?.last_active_at, 5000, 'last_active_at 跟着刷(休眠也刷新活跃时间)');
  eq(slept?.saved_at, 5000, '★ saved_at = 存档时刻(休眠这一支才写)');

  /* 负对照 1:非休眠(CLOSED)⇒ 不许动 saved_at,但 status/last_active_at 照写。 */
  eq(setRoomStatus(db, 'r1', RoomStatus.CLOSED, 6000), 1);
  const closed = getRoom(db, 'r1');
  eq(closed?.status, RoomStatus.CLOSED, '关闭也要真落库');
  eq(closed?.last_active_at, 6000, 'last_active_at 照刷');
  eq(closed?.saved_at, 5000, '★ 非 SLEEPING 不许覆盖 saved_at(分支是按 status 判的)');

  /* 负对照 2:房间不存在 ⇒ 返回 0 且**不加行、不抛错**(写没落地这件事必须可断言)。 */
  eq(setRoomStatus(db, 'NOPE', RoomStatus.SLEEPING, 7000), 0, '★ 未知房间 ⇒ 0 行(不是抛错、也不是隐式建行)');
  eq(db.count('rooms'), roomsBefore, '行数不变(没有幽灵房间)');
});

test('FND157-2 listRooms:在读集 = OPEN(默认)/ 休眠要显式带上 / CLOSED 永不在读集', () => {
  /* 覆盖导出:server/src/db/repo.ts:listRooms */
  const db = newDb();
  createRoom(db, { id: 'r2', ownerId: 'u2', nowMs: 2000 });

  /* 正例:默认只给 OPEN,按 last_active_at 降序(r2 更新在前)。 */
  eq(listRooms(db).map((r) => r.id), ['r2', 'r1'], 'OPEN 房间按最近活跃降序');

  /* 负对照 1:SLEEPING 不在默认读集里(休眠房间不该被重新载入),要 `includeSleeping` 才带。 */
  setRoomStatus(db, 'r1', RoomStatus.SLEEPING, 3000);
  eq(listRooms(db).map((r) => r.id), ['r2'], '★ 休眠房间默认被排除');
  eq(listRooms(db, { includeSleeping: true }).map((r) => r.id), ['r1', 'r2'],
    '★ includeSleeping ⇒ 带上休眠,且排序仍按活跃时间(r1 刚刷过 ⇒ 在前)');

  /* 负对照 2:CLOSED **任何口径都不出现**(它不是「睡得沉」,是消失)。 */
  setRoomStatus(db, 'r2', RoomStatus.CLOSED, 4000);
  eq(listRooms(db).map((r) => r.id), [], '关闭后默认读集为空');
  eq(listRooms(db, { includeSleeping: true }).map((r) => r.id), ['r1'],
    '★ includeSleeping 也**不**放 CLOSED 进来 —— 关闭 ≠ 休眠');
});

/* ═══════════════════════ 2. 账:血量落盘的读回 ═══════════════════════ */

test('FND157-3 loadVitalsFromUsers:只回显式 ID 且 hp 有限的那些(缺 → 没有,不是默认值)', () => {
  /* 覆盖导出:server/src/db/repo.ts:loadVitalsFromUsers */
  const db = newDb();
  eq(getRoom(db, 'r1')?.id, 'r1', '前提:库已迁移');

  /* 正例:与 `saveVitalsToUsers` 往返一次(37 落在 max_hp=100 的钳制区间内)。 */
  eq(saveVitalsToUsers(db, { u1: { hp: 37 } }, 2000), { saved: 1, skipped: 0 }, '前提:落盘成功');
  eq(loadVitalsFromUsers(db, ['u1']), { u1: { hp: 37 } }, '★ 往返:写进 users.hp 的值能读回来');

  /* 负对照 1:**只读显式给出的 ID** —— 库里有 u2,但没被点名 ⇒ 不许出现在结果里。
     这正是「幽灵玩家」的来源:按全表读会把「库里恰好有谁」当成「谁该被还原」。 */
  eq(loadVitalsFromUsers(db, ['u1']).u2, undefined, '★ 未被点名的用户不许被读回来');
  eq(Object.keys(loadVitalsFromUsers(db, ['u1'])).sort(), ['u1'], '结果键集 === 入参里真实存在且在库的 ID');

  /* 负对照 2:不存在的 ID ⇒ 不出现,也**不编一个默认 hp**。 */
  eq(loadVitalsFromUsers(db, ['ghost']), {}, '★ 未知 ID ⇒ 空(不返回默认 100)');

  /* 负对照 3:hp 非有限 ⇒ 与 `saveVitalsToUsers` 的拒收口径一致,不返回该条。
     (users.hp 的 DDL CHECK 是 `hp >= 0`,Infinity 能进库 —— 闸必须在读口这侧。) */
  db.update('users', { id: 'u2' }, { hp: Number.POSITIVE_INFINITY });
  eq(loadVitalsFromUsers(db, ['u2']), {}, '★ 非有限 hp ⇒ 丢弃(不让 NaN/∞ 流进世界)');

  /* 负对照 4:同一 ID 重复给 ⇒ 一条(读口无副作用)。 */
  eq(loadVitalsFromUsers(db, ['u1', 'u1']), { u1: { hp: 37 } }, '重复 ID 不产生第二个条目');
});

/* ═══════════════════════ 3. 持久化边界:整数写入闸 ═══════════════════════ */

test('FND157-4 clampInt:截断(不是四舍五入)+ 端点闭区间', () => {
  /* 覆盖导出:server/src/db/repo.ts:clampInt */
  eq(clampInt(3.9, 0, 10, 'x'), 3, '★ 向零截断(3.9 ⇒ 3;四舍五入会写 4)');
  eq(clampInt(-3.9, -10, 10, 'x'), -3, '★ 负数也向零截断(-3.9 ⇒ -3)');
  eq(clampInt(0, 0, 10, 'x'), 0, '下端点合法(闭区间)');
  eq(clampInt(10, 0, 10, 'x'), 10, '上端点合法(闭区间)');
  eq(clampInt(7, 7, 7, 'x'), 7, '退化区间 [7,7] 只能用那一个值');
});

test('FND157-4b clampInt 的负对照:越界 / 非有限一律抛错(不静默钳、不写坏行)', () => {
  /* 覆盖导出:server/src/db/repo.ts:clampInt */
  const catches = (fn: () => number): string => {
    try {
      fn();
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  ok(catches(() => clampInt(11, 0, 10, 'maxPlayers')).includes('超出'), '★ 越上界必须抛(静默钳会把非法输入写成合法行)');
  ok(catches(() => clampInt(-1, 0, 10, 'maxPlayers')).includes('超出'), '★ 越下界必须抛');
  ok(catches(() => clampInt(Number.NaN, 0, 10, 'x')).includes('有限'), '★ NaN 必须抛');
  ok(catches(() => clampInt(Number.POSITIVE_INFINITY, 0, 10, 'x')).includes('有限'), '★ ∞ 必须抛');
  /* 负对照的对照:同样的输入在合法时**不**抛 —— 证明上面的抛错不是「一律抛」。 */
  eq(catches(() => clampInt(10, 0, 10, 'x')), '', '合法输入不许抛');
});

test('FND157-5 TABLE_PRIMARY_KEYS:与 DDL 逐表对账,且真是 MemoryDb 的主键/白名单来源', () => {
  /* 覆盖导出:server/src/db/repo.ts:TABLE_PRIMARY_KEYS */

  /* ── 5a 常量 vs DDL:逐表比对主键列(两种写法都要认:行内 `col PRIMARY KEY` 与
        表级 `PRIMARY KEY (a, b)`)── */
  /* DDL 正解 = `server/src/db/` 下**所有** `schema*.sql` 产物(不是手抄一份表清单):
     新加一张表(自己的 DDL 文件 + 常量登记)会被这条自动纳入对账。 */
  const dbDir = dirname(schemaSqlPath());
  const ddlFiles = readdirSync(dbDir).filter((f) => /^schema.*\.sql$/.test(f)).sort();
  ok(ddlFiles.length >= 2, `db 目录里至少要有 schema.sql + 独立 DDL 产物,实测 ${ddlFiles.length} 个`);
  const ddl = ddlFiles.map((f) => readFileSync(join(dbDir, f), 'utf8')).join('\n');
  const bodyOf = (table: string): string | null => {
    const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
    const at = ddl.indexOf(head);
    if (at < 0) return null;
    const from = at + head.length;
    const endRe = /\n\)[^\n]*;/g;
    endRe.lastIndex = from;
    const m = endRe.exec(ddl);
    return m === null ? null : ddl.slice(from, m.index);
  };
  const pkColumnsOf = (body: string): string[] => {
    const out: string[] = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/--.*$/, '').trim();
      if (!/PRIMARY\s+KEY/i.test(line)) continue;
      const tableLevel = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line);
      if (tableLevel !== null) {
        for (const part of tableLevel[1].split(',')) {
          const col = part.trim().split(/\s+/)[0];
          if (col !== undefined && col !== '') out.push(col);
        }
        continue;
      }
      const inline = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (inline !== null) out.push(inline[1]);
    }
    return out.sort();
  };
  const problems: string[] = [];
  for (const [table, cols] of Object.entries(TABLE_PRIMARY_KEYS)) {
    const body = bodyOf(table);
    if (body === null) {
      problems.push(`${table}:DDL 里找不到这张表`);
      continue;
    }
    const declared = pkColumnsOf(body).join(',');
    const want = [...cols].sort().join(',');
    if (declared !== want) problems.push(`${table}:DDL 主键 [${declared}] ≠ 常量 [${want}]`);
  }
  eq(problems, [], '★ 主键常量必须与 DDL 逐表一致(多一列/少一列都红)');
  includes(Object.keys(TABLE_PRIMARY_KEYS), WORLD_ARCHIVE_TABLE,
    '★ 世界归档表必须登记 —— `driver.sqlite.ts` 的表名白名单是从本常量派生的,不登记就写不进真库');

  /* ── 5b 它真是 MemoryDb 的主键口径 ── */
  const db = newDb();
  let thrown = '';
  try {
    db.insert('not_a_registered_table', { id: 'x' });
  } catch (e) {
    thrown = (e as Error).message;
  }
  ok(thrown.includes('未登记主键'), `★ 未登记的表插不进 MemoryDb(白名单派生自本常量),实际:「${thrown}」`);

  /* 复合主键:`room_players` 是 (room_id, user_id) 两列 ——
     同两列冲突、换第二列能进(若常量写成单列 `id`,这一条立刻红)。 */
  db.insert('room_players', { room_id: 'r1', user_id: 'u1', joined_at: 1, last_seen_at: 1 });
  thrown = '';
  try {
    db.insert('room_players', { room_id: 'r1', user_id: 'u1', joined_at: 2, last_seen_at: 2 });
  } catch (e) {
    thrown = (e as Error).message;
  }
  ok(thrown.includes('主键冲突'), `★ 同 (room_id,user_id) 二次插入必须冲突,实际:「${thrown}」`);
  db.insert('room_players', { room_id: 'r1', user_id: 'u2', joined_at: 1, last_seen_at: 1 });
  eq(db.count('room_players'), 2, '★ 换第二列是另一行 ⇒ 主键是两列,不是 room_id 一列');
});

/* ═══════════════════════ 4. 权限:动作处理器的闸 ═══════════════════════ */

test('FND157-6 setRoomAccess:无 mode 先拒(零副作用);成功时把 hash 原样转交;失败走分类', () => {
  /* 覆盖导出:server/src/net/actions/admin.ts:setRoomAccess */
  /* 负对照 1:缺 `mode` ⇒ INVALID,且**一次都不许**调宿主方法(零副作用)。 */
  const noMode = makeCtx({ action: RoomAction.SET_ROOM_ACCESS, payload: {} });
  eq(setRoomAccess(noMode.ctx), { ok: false, kind: 'INVALID', reason: '需要 mode' }, '★ 缺 mode ⇒ INVALID');
  eq(noMode.log.access.length, 0, '★ 拒的时候宿主方法一次都没被调(不留半截写入)');

  /* 正例:mode + passwordHash **原样**转交给宿主方法(处理器不做第二份判定)。 */
  const okCtx = makeCtx({
    action: RoomAction.SET_ROOM_ACCESS,
    payload: { mode: AccessMode.PASSWORD, passwordHash: 'h-1' },
  });
  eq(setRoomAccess(okCtx.ctx), { ok: true, kind: 'OK', effect: { mode: 'PASSWORD' } }, '成功回执带 effect');
  eq(okCtx.log.access, [{ actorId: 'u1', mode: 'PASSWORD', passwordHash: 'h-1' }],
    '★ 入参逐字透传:actorId / mode / passwordHash');

  /* 负对照 2:没给 hash ⇒ 传 `null`(不是 undefined、不是空串)。 */
  const noHash = makeCtx({ action: RoomAction.SET_ROOM_ACCESS, payload: { mode: AccessMode.PUBLIC } });
  setRoomAccess(noHash.ctx);
  eq(noHash.log.access, [{ actorId: 'u1', mode: 'PUBLIC', passwordHash: null }], '★ 缺 hash ⇒ null');

  /* 负对照 3:宿主拒 ⇒ 走 `classifyFailure`(不自己从 reason 文本里猜分类)。 */
  const denied = makeCtx({
    action: RoomAction.SET_ROOM_ACCESS,
    payload: { mode: AccessMode.PASSWORD, passwordHash: 'h' },
    accessOk: false,
  });
  eq(setRoomAccess(denied.ctx), { ok: false, kind: 'PERMISSION', reason: '分类:无权' }, '★ 失败分类交宿主');
  eq(denied.log.classify.length, 1, 'classifyFailure 恰问一次');
  eq(denied.log.classify[0]?.reason, '无权', '原样把宿主的 reason 交过去');
});

test('FND157-7 closeRoom:闸在处理器里(权限不足 ⇒ 零副作用);status 是活读不是快照', () => {
  /* 覆盖导出:server/src/net/actions/admin.ts:closeRoom */
  /* 负对照 1:越权 ⇒ PERMISSION,且 `close()` **一次都没被调**(关房是不可逆的,
     拒的时候绝不能已经关掉)。 */
  const denied = makeCtx({ allowed: false });
  eq(closeRoom(denied.ctx), { ok: false, kind: 'PERMISSION', reason: '无权' }, '★ 越权 ⇒ PERMISSION');
  eq(denied.log.close, 0, '★ 越权时 close() 零调用');
  eq(denied.status.value, RoomStatus.OPEN, '房间仍是 OPEN(零副作用)');

  /* 负对照 2:有权限但房间已不是 OPEN ⇒ `close()` 回 false ⇒ ROOM_CLOSED(不是 OK)。 */
  const alreadyClosed = makeCtx({ closeOk: false });
  eq(closeRoom(alreadyClosed.ctx), { ok: false, kind: 'ROOM_CLOSED', reason: '房间已不是 OPEN' },
    '★ close() 拒 ⇒ ROOM_CLOSED,不许谎报成功');

  /* 正例:回执的 status 必须是 close() **之后**读到的活值(装配时取快照会报 OPEN)。 */
  const good = makeCtx({});
  eq(closeRoom(good.ctx), { ok: true, kind: 'OK', effect: { status: 'CLOSED' } },
    '★ effect.status = CLOSED ⇒ status 是 getter 活读');
  eq(good.log.close, 1, '有权限就走一次 close()');
  eq(good.status.value, RoomStatus.CLOSED, '房间真的关了');
});

test('FND157-8 gatePartyStart:裁判哨台闸(表外模式 / 没人站台 / 已开跑,逐个自有拒因)', () => {
  /* 覆盖导出:server/src/party/actions.ts:gatePartyStart */
  const base = { modeKey: PARTY_MODE_KEY.BRIDGE_CTF, refereeId: 'u1', refereeAtDesk: true, runActive: false };
  eq(gatePartyStart(base), { ok: true, reason: GATE_REJECT.OK }, '前提:全通过才 PASS');

  /* 负对照 1:表外模式 ⇒ UNKNOWN_MODE(含旧词表的 `BRIDGE_FLAG` —— 词表以冻结层为准)。 */
  eq(gatePartyStart({ ...base, modeKey: 'BRIDGE_FLAG' }).reason, GATE_REJECT.UNKNOWN_MODE,
    '★ 冻结层之外的模式名必须拒');
  eq(gatePartyStart({ ...base, modeKey: '' }).reason, GATE_REJECT.UNKNOWN_MODE, '★ 空串也拒');

  /* 负对照 2:没人站在哨台格(或没有裁判 ID)⇒ NO_REFEREE。 */
  eq(gatePartyStart({ ...base, refereeAtDesk: false }).reason, GATE_REJECT.NO_REFEREE,
    '★ 不在哨台格 ⇒ 拒(开局主体是站在 436 上的裁判)');
  eq(gatePartyStart({ ...base, refereeId: '' }).reason, GATE_REJECT.NO_REFEREE, '★ 空裁判 ID ⇒ 拒');

  /* 负对照 3:同房间不许叠开两局。 */
  eq(gatePartyStart({ ...base, runActive: true }).reason, GATE_REJECT.ALREADY_RUNNING, '★ 已在跑 ⇒ 拒');

  /* 检查顺序(顺序即优先级):模式非法时**先**报 UNKNOWN_MODE,不报 NO_REFEREE。 */
  eq(gatePartyStart({ ...base, modeKey: 'NOPE', refereeAtDesk: false }).reason, GATE_REJECT.UNKNOWN_MODE,
    '★ 多个前置同时不满足时,按「模式 → 裁判 → 叠开」的次序报第一个拒因');
});

/* ═══════════════════════ 5. 结算:发奖与一次性结算 ═══════════════════════ */

test('FND157-9 rewardsForTeams:名次 → 奖励逐档对账;超出档位钳到最后一档', () => {
  /* 覆盖导出:server/src/party/scoring.ts:rewardsForTeams */
  const standing: PaintStanding[] = [
    { rank: 1, team: 'RED', tiles: 100, ratio: 0.5 },
    { rank: 2, team: 'BLUE', tiles: 50, ratio: 0.25 },
    { rank: 3, team: 'YELLOW', tiles: 10, ratio: 0.05 },
    { rank: 4, team: 'GREEN', tiles: 1, ratio: 0.005 },
  ];
  const lines = rewardsForTeams(standing);

  /* 逐档对账:期望值取自**常量表**(不是手抄数字),团队字段落上,个人字段为空。 */
  eq(lines.length, standing.length, '一队一行(不合并、不丢弃)');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    eq(line.rank, standing[i].rank, `第 ${i + 1} 行名次原样带出`);
    eq(line.team, standing[i].team, `第 ${i + 1} 行队伍原样带出`);
    eq(line.playerId, null, '★ 团队奖不带玩家 ID(两套奖不串台)');
    eq(line.exp, REWARD_EXP_BY_RANK[i], `第 ${i + 1} 名经验 = 常量表第 ${i + 1} 档`);
    eq(line.rewards, { ...REWARD_ITEM_BY_RANK[i] }, `第 ${i + 1} 名物品 = 常量表第 ${i + 1} 档`);
  }
  eq(lines[0]?.exp, 600, '锚:冠军 600 经验(与常量表/文档同口径)');
  eq(lines[3]?.rewards, {}, '★ #4 档只给经验不给物品(空表不是漏写)');

  /* 负对照 1:名次越界(赛制改了但调用方没钳)⇒ 钳到最后一档,不许 undefined/NaN。 */
  const over = rewardsForTeams([{ rank: 9, team: 'RED', tiles: 0, ratio: 0 }]);
  eq(over[0]?.exp, REWARD_EXP_BY_RANK[REWARD_EXP_BY_RANK.length - 1], '★ 越界名次钳到最后一档');
  eq(over[0]?.rank, 9, '但报出来的名次仍是调用方给的 9(不回写假名次)');

  /* 负对照 2:不改入参。 */
  eq(standing.map((s) => s.team), ['RED', 'BLUE', 'YELLOW', 'GREEN'], '入参不被改写');
  eq(rewardsForTeams([]), [], '★ 空榜单 ⇒ 一份不发');
});

test('FND157-10 rewardsForPlayers:个人奖按**每行自己的 rank**发,不按数组顺序', () => {
  /* 覆盖导出:server/src/party/scoring.ts:rewardsForPlayers */
  const results: RaceResult[] = [
    { rank: 1, playerId: 'p1', elapsedMs: 12345, dnf: false },
    { rank: 2, playerId: 'p2', elapsedMs: 20000, dnf: false },
    { rank: 3, playerId: 'p3', elapsedMs: Number.POSITIVE_INFINITY, dnf: true },
  ];
  const lines = rewardsForPlayers(results);
  eq(lines.map((l) => l.playerId), ['p1', 'p2', 'p3'], '玩家 ID 原样带出(完赛/未完赛都发参与奖)');
  eq(lines.map((l) => l.exp), REWARD_EXP_BY_RANK.slice(0, 3), '经验逐档 = 常量表前 3 档');
  eq(lines[0]?.rewards, { ...REWARD_ITEM_BY_RANK[0] }, '★ 冠军物品 = 常量表第 1 档');
  eq(lines[0]?.team, null, '★ 个人奖不带队伍(两套奖不串台)');

  /* 负对照 1:数组顺序与 rank 顺序不一致 ⇒ 奖励跟着 **rank** 走。 */
  const shuffled: RaceResult[] = [
    { rank: 2, playerId: 'p2', elapsedMs: 20000, dnf: false },
    { rank: 1, playerId: 'p1', elapsedMs: 10000, dnf: false },
  ];
  eq(rewardsForPlayers(shuffled).map((l) => l.exp), [REWARD_EXP_BY_RANK[1], REWARD_EXP_BY_RANK[0]],
    '★ 第 1 行 rank=2 ⇒ 拿 2 档奖(不是按位置发)');

  /* 负对照 2:空名单 ⇒ 一份不发(不是发默认奖)。 */
  eq(rewardsForPlayers([]), [], '★ 空名单 ⇒ []');
});

test('FND157-11 settlePartyRun:裸运行时 ⇒ null;有钩子 ⇒ 结算一次并幂等(不翻倍)', () => {
  /* 覆盖导出:server/src/party/modes.ts:settlePartyRun */
  const clock = createManualClock(0);

  /* 负对照 1:裸 `createPartyMode` 没有结算语义 ⇒ `null`,且不许偷偷置 `settlement`。 */
  const bare = createPartyMode({ key: PARTY_MODE_KEY.BRIDGE_CTF, clock, refereeId: 'ref1' });
  eq(settlePartyRun(bare), null, '★ settleHook = null ⇒ null(不是空结算对象)');
  eq(bare.settlement, null, '★ 拒结算时不许留下半份 settlement');

  /* 正例:`createBridgeRun` 挂上钩子 ⇒ 相位到点那一帧结算,回执落在运行时上。 */
  const run = createBridgeRun(clock, 'ref1');
  let hookCalls = 0;
  const realHook = run.mode.settleHook;
  ok(realHook !== null, 'createBridgeRun 必须挂上结算钩子(否则 rewards 永不发放)');
  if (realHook !== null) {
    run.mode.settleHook = () => {
      hookCalls += 1;
      return realHook();
    };
  }
  startPartyMode(run.mode);
  clock.set(modeTotalSec(run.mode) + 1);
  includes(tickPartyMode(run.mode), 'PARTY_SETTLED', '★ 相位到点那一帧必须结算(不靠上层记得调)');
  const first = settlePartyRun(run.mode);
  ok(first !== null, '有钩子 ⇒ 结算出一份回执');
  eq(run.mode.settlement, first, '回执落在运行时上(可复读)');
  eq(hookCalls, 1, '★ 结算钩子只跑一次');

  /* 幂等:再调一次回**同一份**,钩子不再跑(奖励不翻倍)。 */
  eq(settlePartyRun(run.mode), first, '★ 幂等:重复结算回同一份');
  eq(hookCalls, 1, '★ 幂等:钩子调用数不涨');
  if (first !== null) {
    eq(first.mode, PARTY_MODE_KEY.BRIDGE_CTF, '回执带着模式身份');
    ok(first.rewards.length > 0, '★ 结算真的发了奖(空的结算 = 白结算)');
    eq(first.standing.length, 4, '四队排名都在(不分名次也给名次行)');
  }
});

/* ═══════════════════════ 6. 距离 / 落点:急单交付 ═══════════════════════ */

test('FND157-12 rushAcceptsDelivery:只在「在跑 + 还有欠货」时收(交满 / 收工都立刻不收)', () => {
  /* 覆盖导出:server/src/coop/rush_actions.ts:rushAcceptsDelivery */
  const { s } = rushSession();
  eq(s.state, RUSH_ORDER_STATE.IDLE, '前提:新建会话是 IDLE');

  /* 负对照 1:开工前不收交付(订单板还没跑)。 */
  eq(rushAcceptsDelivery(s), false, '★ IDLE ⇒ 不收');

  /* 正例:在跑 + 有欠货 ⇒ 收。 */
  startRushOrder(s);
  eq(s.state, RUSH_ORDER_STATE.RUNNING, '前提:开工后 RUNNING');
  eq(rushAcceptsDelivery(s), true, 'RUNNING + 欠货 ⇒ 收');

  /* 负对照 2:欠货清零 ⇒ 即便状态还是 RUNNING 也不收(判定有两个合取项,不是一个)。 */
  for (const slot of s.board.slots) slot.delivered = slot.need;
  eq(rushAcceptsDelivery(s), false, '★ 交满 ⇒ 不收(状态仍是 RUNNING)');

  /* 负对照 3:收工 ⇒ 不收。 */
  const done = rushSession();
  startRushOrder(done.s);
  done.s.state = RUSH_ORDER_STATE.SETTLED;
  eq(rushAcceptsDelivery(done.s), false, '★ SETTLED ⇒ 不收(收工后交货没人认)');
});

test('FND157-13 rushRewardCellOf:落点是「第一台**有格**的在场工位」,副本不可改坏工位簿', () => {
  /* 覆盖导出:server/src/coop/rush_actions.ts:rushRewardCellOf */
  const { s } = rushSession();
  eq(rushRewardCellOf(s), DEFAULT_STATION_CELLS.FURNACE, '★ 默认工位序(FURNACE 在前)⇒ 落点是它的格');

  /* 负对照 1:改返回值不许改到工位簿(返回的是副本,不是簿里的那个对象)。 */
  const cell = rushRewardCellOf(s);
  if (cell !== null) {
    cell.x = 9999;
    cell.y = 9999;
  }
  eq(DEFAULT_STATION_CELLS.FURNACE, { x: 0, y: 0 }, '★ 返回副本:改它不影响工位簿');
  eq(rushRewardCellOf(s), DEFAULT_STATION_CELLS.FURNACE, '再取一次仍是原值');

  /* 负对照 2:顺序依赖 —— 把工位反过来 ⇒ 落点跟着变成最后一台。 */
  s.stations = [...s.stations].reverse();
  eq(rushRewardCellOf(s), DEFAULT_STATION_CELLS.CUTTER, '★ 落点 = `stations` 顺序里第一台有格的,不是写死 FURNACE');

  /* 负对照 3:工位簿缺项 ⇒ 跳过它落到下一台(不是给 (0,0) 或 null)。 */
  const missing = rushSession().s;
  delete (missing.stationCells as unknown as Record<string, unknown>)['FURNACE'];
  eq(rushRewardCellOf(missing), DEFAULT_STATION_CELLS.POT, '★ 缺 FURNACE 的格 ⇒ 落到 POT');

  /* 负对照 4:没有工位 ⇒ null(调用方不许凭空掉落奖励)。 */
  const empty = rushSession().s;
  empty.stations = [];
  eq(rushRewardCellOf(empty), null, '★ 没有工位 ⇒ null(不是 (0,0))');
});

/* ═══════════════════════ 7. 账:定价表 ═══════════════════════ */

test('FND157-14 CONTENT_PRICE_TABLE:定价只由内容表派生;无定价照实说UNPRICED;buy 真用它', () => {
  /* 覆盖导出:server/src/systems/depot.ts:CONTENT_PRICE_TABLE */
  /* 对账:用测试自己的一轮重算比对常量(常量若被手改成「看着合理」的数,这里立刻红)。 */
  const recomputed: Record<number, number> = {};
  for (const item of ITEM_LIST) {
    const raw = item.price;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) recomputed[item.id] = raw;
  }
  eq({ ...CONTENT_PRICE_TABLE }, recomputed, '★ CONTENT_PRICE_TABLE === 内容表 price 列(逐条派生,不是抄件)');
  eq({ ...CONTENT_PRICE_TABLE }, { ...contentPriceTable(ITEM_LIST) }, '与派生函数本身一致(两者不许分叉)');
  ok(Object.isFrozen(CONTENT_PRICE_TABLE), '★ 常量表必须冻结(否则任何一处写的都改它)');

  /* 负对照 1:内容表里**没有定价**的那件 ⇒ 必须明说 UNPRICED(不是 0 元、不是默认价)。 */
  const unpriced = ITEM_LIST.find((i) => {
    const p = i.price;
    return !(typeof p === 'number' && Number.isFinite(p) && p > 0);
  });
  if (unpriced === undefined) throw new Error('前提不成立:内容表每一件都写了 price,本判据需要一件无定价的物品');
  const looked = priceOf(unpriced.id, CONTENT_PRICE_TABLE);
  eq(looked.kind, 'UNPRICED', '★ 无定价 ⇒ UNPRICED(照实,不编价)');

  /* 负对照 2:同一件物品**喂进来的表**里有价 ⇒ PRICED —— 证明判的是「表里有没有」,
     不是「这件东西天生没价」。 */
  eq(priceOf(unpriced.id, { [unpriced.id]: 5 }), { kind: 'PRICED', price: 5 }, '★ 显式定价表 ⇒ PRICED');

  /* buy 的缺省定价表就是它:同一个物品,不喂表 ⇒ 拒(UNPRICED,成本 0、库存不变);
     喂表 ⇒ 成交(成本 = 单价 × 数量,库存减)。 */
  const refused = buy({ itemId: unpriced.id, qty: 2, stock: { [unpriced.id]: 3 } });
  eq(refused.ok, false, '★ 不喂定价表 ⇒ 拒(默认表 = CONTENT_PRICE_TABLE)');
  eq(refused.cost, 0, '拒的时候不许计费');
  eq(refused.stock, { [unpriced.id]: 3 }, '★ 拒的时候库存一件不动(不留「拒了但已扣」的半截状态)');

  const bought = buy({ itemId: unpriced.id, qty: 2, stock: { [unpriced.id]: 3 }, table: CONTENT_PRICE_TABLE });
  eq(bought.ok, false, '同一张(空的)内容表喂进去还是拒 —— 与上一条同因');

  const priced = buy({ itemId: unpriced.id, qty: 2, stock: { [unpriced.id]: 3 }, table: { [unpriced.id]: 5 } });
  eq(priced.ok, true, '有价 ⇒ 成交');
  eq(priced.cost, 10, '成本 = 单价 5 × 数量 2');
  eq(priced.stock, { [unpriced.id]: 1 }, '库存扣掉 2 件');

  /* 负对照 3:库存不足 ⇒ 拒且库存不变(定价对了也不许半截扣货)。 */
  const short = buy({ itemId: unpriced.id, qty: 9, stock: { [unpriced.id]: 3 }, table: { [unpriced.id]: 5 } });
  eq(short.ok, false, '★ 库存不足 ⇒ 拒');
  eq(short.stock, { [unpriced.id]: 3 }, '★ 拒的时候库存不变');
});

report('WS-FND-157-coverage-batch1');