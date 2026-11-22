/**
 * WS-FND-179 —— **浏览器能不能进房间**(客户端身份 `userId`)。
 *
 * ## 本套件存在的理由(2026-11-22 实测的真故障)
 *
 * owner 报:「画面没有,逻辑没有」。查下去是**两件事**:
 * ```
 * 1 白屏   ← vite dev 的模块图 60 请求 / 6.67 MiB / 109 s 撞穿 index.html 的 8 s 看门狗
 *            (定因与修法见 HANDOVER §13.16;那条靠 `play.ts --dist`,不在本套件)
 * 2 进不去 ← 服务端 `onHello` 的判据是「**声明**的 userId 必须有」,而客户端**两头都不带**
 *            (默认地址 `ws://<host>:8791/ws`,hello 只有 {t, protocolVersion, contentClaim})
 *            ⇒ `{t:'reject', code:'NO_IDENTITY'}` + 关连接
 *            ⇒ 单机渲染照常(地形/UI 都在)、世界里没有你、怪也不同步 = 「画面有、逻辑没有」
 * ```
 *
 * ## 为什么 id 走**地址**而不是 hello(别顺手改回去)
 *
 * 服务端 `HelloFrame` 镜像**刻意不声明** `userId`(`ws_server.ts:969-975`);
 * `tests/WS-13.test.ts` 的 `WS13-5b-1` 逐字段守两侧一致,`WS13-6-6` 钉住
 * 「稳定 id 只从握手 URL 来」。⇒ 本套件**反过来**也钉一条:FND179-6
 * 「客户端 hello 仍不带 userId」—— 免得下一个人以为改 hello 更"干净",把两侧镜像拆开。
 *
 * ## 逐条的注入靶子
 *
 * | # | 断言 | 改坏哪里会红 |
 * | :--- | :--- | :--- |
 * | 1 | `sanitizeUserId`:形状合的通过;空串/怪字符/超长/非字符串 ⇒ null | 去掉 `ID_SHAPE` 判定 |
 * | 2 | `mintUserId`:形状 `u_`+12 位 base36;注入 random 可定值 | 改成 `Math.random().toString(36)` 等失控形态 |
 * | 3 | `resolveUserId` 优先级 `?user=` > 存储 > 现造 | 调换两段 / 把 query 当 fallback |
 * | 4 | 存储**抛异常**(手机私密模式)时仍能给出可用 id | 去掉两处 try/catch |
 * | 5 | `withUserId`:补 `?userId=` / 合并既有 query / **不覆盖**显式值 | 无条件覆盖 / 简单拼 `+ '?userId='` |
 * | 6 | **接线**:`main.ts` 真的调 `resolveUserId` 且把 id 拼进地址 | 删掉那两行(会立刻回到 NO_IDENTITY) |
 * | 7 | `play.ts` 显式 `requireToken: false`(play 模式) | 删掉 ⇒ 浏览器又进不去 |
 * | 8 | **反向**:`ws_demo.ts` / `soak.ts` 的生产调用**没有**关凭证 | 顺手在那边也关 ⇒ 网络边界失去认证 |
 */

import { test, ok, eq, report } from '../shared/testing/harness.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  USER_ID_STORAGE_KEY,
  mintUserId,
  resolveUserId,
  sanitizeUserId,
  withUserId,
  type IdentityStore,
} from '../client/src/net/identity.ts';
import { createSession } from '../client/src/net/session.ts';
import { ClientStateStore } from '../client/src/net/state_store.ts';
import { PROTOCOL_VERSION } from '../shared/net/delta.ts';
import { layoutTouchBar } from '../client/src/ui/touch_bar.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** 剥注释(代码态)——免得注释里的一句话把判据喂饱(本仓踩过这个坑)。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** 内存存储:可注入「抛异常」以模拟手机私密模式(Safari 会**抛**,不是返回 null)。 */
function memStore(init: Record<string, string> = {}, throwOn: 'get' | 'set' | null = null): IdentityStore {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => {
      if (throwOn === 'get') throw new Error('SecurityError(模拟私密模式)');
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (throwOn === 'set') throw new Error('QuotaExceededError(模拟私密模式)');
      map.set(k, v);
    },
  };
}

/* ═══ 1. 形状判定 ═══ */

test('FND179-1 `sanitizeUserId`:只放行 `[A-Za-z0-9_-]{1,40}`,其余一律 null', () => {
  eq(sanitizeUserId('u_abc123'), 'u_abc123', '常规');
  eq(sanitizeUserId('  u_x  '), 'u_x', '两侧空白应被 trim');
  eq(sanitizeUserId(''), null, '空串 ⇒ null(调用方据此当成没给)');
  eq(sanitizeUserId('   '), null, '纯空白 ⇒ null');
  eq(sanitizeUserId('a b'), null, '带空格 ⇒ null(它要进 URL 与日志)');
  eq(sanitizeUserId('a/b'), null, '斜杠 ⇒ null');
  eq(sanitizeUserId('名字'), null, '非 ASCII ⇒ null');
  eq(sanitizeUserId('a'.repeat(41)), null, '41 字符 ⇒ null(上限 40)');
  eq(sanitizeUserId('a'.repeat(40)), 'a'.repeat(40), '40 字符 ⇒ 通过(边界)');
  eq(sanitizeUserId(null), null, 'null ⇒ null');
  eq(sanitizeUserId(undefined), null, 'undefined ⇒ null');
  eq(sanitizeUserId(123), null, '非字符串 ⇒ null');
  eq(sanitizeUserId({}), null, '对象 ⇒ null');
});

/* ═══ 2. 造号 ═══ */

test('FND179-2 `mintUserId`:形状 `u_` + 12 位 base36;注入 random 可定值', () => {
  const id = mintUserId();
  ok(/^u_[0-9a-z]{12}$/.test(id), `形状应为 u_+12 位 base36,实得 ${id}`);
  eq(mintUserId(() => 0), 'u_000000000000', '注入 0 ⇒ 全 0(证明它是**可注入**的纯函数)');
  eq(mintUserId(() => 0.999999), mintUserId(() => 0.999999), '同一读数 ⇒ 同一个 id');
  let n = 0;
  const seen = new Set<string>();
  while (n < 50) {
    seen.add(mintUserId());
    n += 1;
  }
  ok(seen.size > 45, `50 次造号应几乎全不同(碰撞 ≤4),实得不同 ${seen.size} 个`);
});

/* ═══ 3. 优先级 ═══ */

test('FND179-3 `resolveUserId`:`?user=` > 存储 > 现造(顺序写死,排障要能回答"我是谁")', () => {
  const stored = memStore({ [USER_ID_STORAGE_KEY]: 'u_stored' });

  const byQuery = resolveUserId('?user=u_query', stored);
  eq(byQuery.userId, 'u_query', '★ query 优先(即使存储里已有值)');
  eq(byQuery.source, 'query', '来源必须如实上报');

  const byStorage = resolveUserId('', stored);
  eq(byStorage.userId, 'u_stored', '没有 query ⇒ 用存储的');
  eq(byStorage.source, 'storage', '来源 = storage');

  /* query 非法 ⇒ **退回**存储,而不是把非法值带进去(否则服务端会拒,而现象是"连不上") */
  const badQuery = resolveUserId('?user=a%20b', memStore({ [USER_ID_STORAGE_KEY]: 'u_stored' }));
  eq(badQuery.userId, 'u_stored', '非法 query 应被忽略并退回存储');
  eq(badQuery.source, 'storage', '来源 = storage');

  const empty = memStore();
  const minted = resolveUserId('', empty, () => 'u_fixed000000');
  eq(minted.userId, 'u_fixed000000', '都没有 ⇒ 现造一个');
  eq(minted.source, 'minted', '来源 = minted');
  eq(empty.getItem(USER_ID_STORAGE_KEY), 'u_fixed000000', '★ 造出来的 id 必须**写回**存储(否则每次刷新都是新号)');
});

/* ═══ 4. 存储不可用 ═══ */

test('FND179-4 存储**抛异常**(手机私密模式)⇒ 仍能给出可用 id,且不向外抛', () => {
  const getThrows = resolveUserId('', memStore({}, 'get'), () => 'u_getthrow00');
  eq(getThrows.userId, 'u_getthrow00', 'getItem 抛 ⇒ 当作没有,现造');
  eq(getThrows.source, 'minted', '来源 = minted');

  const setThrows = resolveUserId('', memStore({}, 'set'), () => 'u_setthrow00');
  eq(setThrows.userId, 'u_setthrow00', 'setItem 抛 ⇒ 本次会话仍可用');
  eq(setThrows.source, 'minted', '来源 = minted(代价只是下次换号)');

  const noStore = resolveUserId('', null, () => 'u_nostore000');
  eq(noStore.userId, 'u_nostore000', 'store 为 null(拿不到 localStorage)⇒ 现造');
});

/* ═══ 5. 拼地址 ═══ */

test('FND179-5 `withUserId`:补 `?userId=` / 合并既有 query / **不覆盖**显式值', () => {
  eq(withUserId('ws://h:8791/ws', 'u_a'), 'ws://h:8791/ws?userId=u_a', '无 query ⇒ 追加');
  eq(withUserId('ws://h:8791/ws?x=1', 'u_a'), 'ws://h:8791/ws?x=1&userId=u_a', '既有 query ⇒ 合并');
  eq(withUserId('ws://h:8791/ws?userId=u_explicit', 'u_a'),
    'ws://h:8791/ws?userId=u_explicit', '★ 已有 userId 时**不覆盖**(显式更具体)');
  eq(withUserId('ws://h:8791/ws?userId=', 'u_a'), 'ws://h:8791/ws?userId=u_a', '空值视作没给 ⇒ 补上');
  ok(withUserId('ws://h:8791/ws', 'u_a').includes('userId=u_a'), '结果必须真的带上 id');
});

/* ═══ 6-8. 接线(代码态)═══ */

const MAIN = stripComments(read('client/src/main.ts'));
const PLAY = stripComments(read('scripts/play.ts'));
const WS_DEMO = stripComments(read('server/src/sim/ws_demo.ts'));
const SOAK = stripComments(read('scripts/soak.ts'));
const SESSION = stripComments(read('client/src/net/session.ts'));

test('FND179-6 接线:`main.ts` 必须**定身份并把它拼进 WS 地址**(删掉就回到 NO_IDENTITY)', () => {
  ok(/from\s+'\.\/net\/identity\.ts'/.test(MAIN), 'main.ts 必须从 net/identity.ts 导入');
  ok(/resolveUserId\s*\(/.test(MAIN), 'main.ts 必须调用 resolveUserId');
  ok(/withUserId\s*\(/.test(MAIN), 'main.ts 必须调用 withUserId');
  /* 函数签名带 userId:防「留着工具函数但地址里不带」——那和没修一样 */
  ok(/function\s+serverUrlFromLocation\s*\(\s*userId\s*:\s*string\s*\)/.test(MAIN),
    '★ `serverUrlFromLocation` 必须收 userId 参数(否则地址里又没 id 了)');
  /* ★ 先把**定义**摘掉再数调用 —— 否则 `function serverUrlFromLocation(userId: string)`
     会被当成一处调用(第一版就这么红了一次:定义里当然没有 `identity.userId`)。 */
  const callSites = MAIN.replace(/function\s+serverUrlFromLocation\s*\([^)]*\)/, '')
    .match(/serverUrlFromLocation\s*\(([^)]*)\)/g) ?? [];
  ok(callSites.length >= 1, '至少要有**一处调用**(否则地址里根本不会带 id)');
  ok(callSites.every((c) => /identity\.userId/.test(c)),
    `★ 每处调用都必须传 identity.userId,实得:${callSites.join(' | ')}`);
});

test('FND179-7 `play.ts` 必须显式 `requireToken: false`(play 模式;否则浏览器进不去)', () => {
  ok(/requireToken\s*:\s*false/.test(PLAY), '★ play.ts 的 startWsServer 必须显式关掉强制凭证');
  /* 反向:play 里**不得**再出现 requireToken: true —— 那等于把浏览器又挡在门外 */
  ok(!/requireToken\s*:\s*true/.test(PLAY), 'play.ts 不该同时出现 requireToken: true');
});

test('FND179-8 反向:生产/长跑路径**不得**关凭证(`ws_demo` / `soak` 保持默认 true)', () => {
  ok(!/requireToken/.test(WS_DEMO), 'ws_demo.ts 不该出现 requireToken(用默认 true)');
  ok(!/requireToken/.test(SOAK), 'soak.ts 不该出现 requireToken(用默认 true)');
  /* 服务端默认值本身也要在:选项缺省必须是「强制」 */
  const WS_SERVER = stripComments(read('server/src/net/ws_server.ts'));
  ok(/const\s+requireToken\s*=\s*opts\.requireToken\s*\?\?\s*true/.test(WS_SERVER),
    '★ `startWsServer` 的 requireToken 缺省**必须**是 true(网络边界的表态)');
});

test('FND179-9 设计守位:客户端 hello **仍不带** userId(id 只走地址,WS13-6-6 的同一口径)', () => {
  const helloBlock = /const hello:\s*HelloFrame\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(SESSION);
  ok(helloBlock !== null, '应能在 session.ts 里找到 hello 字面量');
  ok(!/userId/.test(helloBlock![1]!), '★ hello 字面量里**不得**出现 userId(要加就先改两侧镜像与 WS13)');
  const iface = /export interface HelloFrame\s*\{([\s\S]*?)\n\}/.exec(SESSION);
  ok(iface !== null, '应能找到客户端的 HelloFrame 接口');
  ok(!/userId/.test(iface![1]!), '★ 客户端 HelloFrame 也不得声称有 userId(否则 WS13-5b-1 会红)');
});

/* ═══ 10. 行为:`kind:"MOVE"` 的 reject **不得**杀死会话(2026-11-22 实测:撞墙即"断线")═══ */

/** 假 socket:与 WS-12 同形的建模(`binaryType` 那条教训见 WS-12 的注释)。 */
function fakeSocket(): { sock: never; fire: (t: string, ev: unknown) => void } {
  const handlers = new Map<string, ((ev: unknown) => void)[]>();
  const sock = {
    binaryType: 'arraybuffer',
    readyState: 1,
    send(): void { /* 本用例不看上行 */ },
    close(): void { sock.readyState = 3; },
    addEventListener(t: string, fn: (ev: never) => void): void {
      if (!handlers.has(t)) handlers.set(t, []);
      handlers.get(t)!.push(fn as (ev: unknown) => void);
    },
  };
  return {
    sock: sock as never,
    fire: (t, ev) => { for (const h of handlers.get(t) ?? []) h(ev); },
  };
}

/** 服务端下行**文本**帧 = 1 字节 tag `0x01` + JSON(与 WS-12 的 `textFrame` 同形)。 */
function textFrame(obj: unknown): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const f = new Uint8Array(body.length + 1);
  f[0] = 0x01;
  f.set(body, 1);
  return f.buffer as ArrayBuffer;
}

test('FND179-10 ★★ `kind:"MOVE"` 的 reject **不得**把会话打成 failed(撞墙/被击退是常态)', () => {
  const { sock, fire } = fakeSocket();
  const states: string[] = [];
  const s = createSession({
    url: 'ws://x/', makeSocket: () => sock, store: new ClientStateStore(),
    events: { onFrame: () => {}, onState: (st: string) => states.push(st) },
  });
  fire('open', {});
  fire('message', {
    data: textFrame({
      t: 'welcome', playerId: 'p1', roomId: 'r',
      protocolVersion: PROTOCOL_VERSION, contentClaim: 'v1-a',
    }),
  });
  eq(s.state, 'live', '前置:welcome 之后是 live');

  /* ① 世界侧拒收**这一条**移动(服务端**不**关连接) */
  fire('message', {
    data: textFrame({ t: 'reject', kind: 'MOVE', code: 'WORLD_REJECTED', reason: '世界侧拒收本次移动' }),
  });
  eq(s.state, 'live', '★★ 会话仍是 live(修前是 failed ⇒ 撞一下墙就被当成断线、且不再重试)');
  eq(s.rejectedFrames, 1, '★ 但必须留痕:计数 +1');
  eq(s.lastReject?.code, 'WORLD_REJECTED', '★ 最近拒因可读(排障要看得出是世界拒收)');
  ok(!states.includes('failed'), '★★ 状态历史里**不得**出现 failed');

  /* ② 连接级拒绝(握手 / 入场)—— 仍必须 failed(WS-FND-134 的契约不变) */
  fire('message', { data: textFrame({ t: 'reject', code: 'NO_IDENTITY', reason: '缺少 userId' }) });
  eq(s.state, 'failed', '★ 没有 kind 的 reject 仍按连接级处理');
  ok(states.includes('failed'), '状态历史里必须出现 failed');
});

test('FND179-11 守位:`session.ts` 的 reject 分支必须**按 kind 判**,不得退回无条件 failed', () => {
  const S = stripComments(read('client/src/net/session.ts'));
  const branch = /w\.t === 'reject'\)\s*\{([\s\S]*?)\n\s*\}/.exec(S);
  ok(branch !== null, '应能定位 reject 分支');
  ok(/w\.kind !== 'MOVE'/.test(branch![1]!),
    "★ 分支里必须是 `if (w.kind !== 'MOVE') setState('failed', …)`(修前是无条件 failed)");
});
/* ═══ 12-13. 手机按钮条:重绘不得抹几何 + 布局必须真的铺开 ═══ */

test('FND179-12 守位:触摸条重绘**不得**重置 `cssText`,relayout 必须挡住 0 视口', () => {
  const S = stripComments(read('client/src/ui/touch_bar.ts'));
  /* 实测缺陷:setActivePanel 里 `el.style.cssText = …` 会把 relayout 写的
     width/height/left/top 一并抹掉 ⇒ 7 个按钮缩成 15×15 全叠在左上角。 */
  ok(!/style\.cssText\s*=\s*[^;\n]*S_BUTTON_ACTIVE/.test(S),
    '★ 不得把 S_BUTTON_ACTIVE 拼进 cssText(会抹掉 relayout 的几何)');
  ok(/el\.style\.background\s*=/.test(S), '高亮必须走**属性级**写入(background / borderColor)');
  ok(/Number\.isFinite\(vw\)/.test(S) && /vw <= 0/.test(S),
    '★ relayout 必须有视口守卫:0 / 非有限一律不写样式');
});

test('FND179-13 手机布局:383×717 上 7 个按钮**互不重叠**、≥ 32 宽、都在视口内', () => {
  const L = layoutTouchBar(383, 717);
  eq(L.buttons.length, 7, '按钮数应为 7(attack + 5 面板 + close)');
  ok(L.buttonW >= 32, `按钮宽应 ≥ 32(拇指可点),实得 ${L.buttonW}`);
  eq(L.comfortable, true, 'comfortable 应为 true(≥ TOUCH_BUTTON_MIN_W_PX)');
  for (const b of L.buttons) {
    ok(b.rect.x >= 0 && b.rect.y >= 0
      && b.rect.x + b.rect.w <= 383 && b.rect.y + b.rect.h <= 717,
      `${b.id} 必须整个在视口内,实得 ${JSON.stringify(b.rect)}`);
  }
  /* ★ 这条正是修前那 7 个 [0,0,15,15] 的反面:两两不得重叠 */
  for (let i = 0; i < L.buttons.length; i += 1) {
    for (let j = i + 1; j < L.buttons.length; j += 1) {
      const a = L.buttons[i]!.rect;
      const c = L.buttons[j]!.rect;
      const hit = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
      ok(!hit, `${L.buttons[i]!.id} 与 ${L.buttons[j]!.id} 不得重叠(重叠 = 手机上按不准)`);
    }
  }
});
report('WS-FND-179');