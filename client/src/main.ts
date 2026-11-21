/**
 * 浏览器入口 —— 极薄。
 *
 * ## 职责边界
 *
 * 本文件**只**做两件事:找到容器、启动引擎。**不含**任何几何/投影/地形算法,
 * 也**不** import three —— 那一切在 `three/boot.ts`。
 *
 * 这样分层不变量得以成立:
 * ```
 * main.ts(无三方依赖) → three/boot.ts(可 import three)→ stage/*.ts(纯逻辑)
 * ```
 *
 * ## 为什么要有这个文件
 *
 * 在此之前 `client/` 有 5546 行代码、17,736 行服务端测试全绿,
 * 但**从来没有任何东西把舞台画出来** —— 没有入口、没有 `index.html`。
 * 「定义存在 ≠ 功能接入」,本文件就是那个接入点。
 */

import { boot, type BootHandle } from './three/boot.ts';
import {
  CONNECT_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, RECONNECT_FACTOR, RECONNECT_MAX_MS,
  createSession, type SessionHandle,
} from './net/session.ts';
import {
  ACTION_KEYS, FACING_DEFAULT, cellInFront, cellUnder, describeActionResult,
  facingLabel, keyHints, nextFacing, type Facing,
} from './net/action_target.ts';
/* ★ 2026-11-15:动作入口层(合成 / 睡觉 / 开箱 / 派对开局)。
   纯逻辑在 `net/action_entry.ts`(0 import、可单测),键位薄绑定在 `net/action_binding.ts`;
   本文件只做**装配根**:把真 `SessionHandle` 注进端口,再挂到 `window`。 */
import { ActionEntry } from './net/action_entry.ts';
import { createActionBinding, entryKeyHints, hotbarKeyHints, sessionPorts } from './net/action_binding.ts';
/* ★ 第七轮审计 P2:输入避让 —— 搜索框里打字时动作键必须让路。
   判定在 `net/key_guard.ts`(纯、可单测):修前搜索态下打 `e` 会**同时**
   追加查询字符并发出 `BREAK_BLOCK`,两条监听各自都"工作正常"。 */
import { ActionKeyGuard } from './net/key_guard.ts';
/* ★ 第七轮审计 P2:合成(`CRAFT`)的 `have` 明细账本。
   修前 `have: undefined` ⇒ `craftRequest` 必判 INVALID ⇒ 按 N **永远发不出去**。 */
import { applyReceiptToHave, haveEntryCount, type HaveDetail } from './net/have_ledger.ts';
import { InputSource, attachKeyboard } from './net/input.ts';
import { LocalPredictor, predictParamsOf } from './net/predictor.ts';
/* ★ 2026-11-16(D-08 第一步):虚拟摇杆的**判定**住在这里(零 DOM、可单测)。
   `main.ts` 只把触屏指针喂进去 —— 判定留在事件回调里就没人测得到。 */
import {
  AnalogStick, JOYSTICK_DEAD_ZONE, STICK_RADIUS_PX, mergeCmd,
} from './net/joystick.ts';
/* ★ 2026-11-16(D-08 第二步):把摇杆**画出来**。
   判定在 `net/joystick.ts`,绘制在 `ui/joystick_ui.ts`(纯 DOM、零 three),
   本文件只剩三根线:落指 → `show`、拖动 → `moveTo`、抬手/取消 → `hide`。
   —— 只画不接 = 玩家仍然看不见手柄,而那**不会**让任何断言变红。 */
import { createJoystickUI } from './ui/joystick_ui.ts';
/* ═══ ★ WS-FND-166:触屏入口(手机没有键盘,而 `PANEL_KEYS` 全是字母键)═══
   判定全在**纯模块**里(可单测),本文件只接线:
   ```
   net/touch_intent.ts  「轻点算不算攻击」(拖动 / 长按 / 非法读数都得说得出话)
   ui/touch_bar.ts      屏幕按钮(攻击 + 每个 `PANEL_KEYS` 面板 + 关)的布局/命中/DOM
   ui/mobile_shell.ts   原生手势抑制(contextmenu/selectstart)+ reduced-motion 判定
   ```
   ⇒ 修前的三件真机事故:①触屏**永远打不出攻击**(摇杆 `preventDefault` 抑制了
   兼容 `mousedown`);②手指按在面板上拖动时摇杆照样开(角色一边走);
   ③手机**打不开任何面板**。 */
import { TAP_MAX_MS, TAP_MAX_TRAVEL_PX, tapAttackVerdict } from './net/touch_intent.ts';
import { createTouchBar, panelOfButtonId, touchButtons, type TouchButtonId } from './ui/touch_bar.ts';
import { SUPPRESSED_GESTURES, suppressNativeGestures } from './ui/mobile_shell.ts';
/* `UiPanel` 在本仓同时是**值**(词表)与**类型**(同名的 `type`)—— 一次 import 都拿得到。 */
import { UiPanel } from './ui/state_machine.ts';
import { telegraphCenterOf } from './net/telegraph_center.ts';
/* ★ 第六轮审计 P1:派对模式的**下标 → 名字**换算(词表来自冻结层 `PARTY_MODES`),
   同时服务于 `#hint`(boot.ts)与 `START_PARTY` 的模式回声(本文件)。 */
/* ★ WS-FND-167:a11y 最低限度层 —— 字号/对比度常量 + 面板的 role/aria-label/Tab 可达镜像。
   修前面板全画在 canvas 上(读屏器零可达、键盘 Tab 一个都到不了),而画布那层不在本文件
   写域内 ⇒ 这里的镜像面板与 DOM HUD 用**同一份**达标口径(`ui/a11y.ts` 的常量 + 对比度判据)。 */
import { MIN_TEXT_PX, a11yStyleProblems, createA11yMirror } from './ui/a11y.ts';
import { partyModeName } from './ui/party_hud.ts';
import { localPlayerZOf } from './net/height_placement.ts';
import { DT } from '../../shared/types/physics.ts';

declare global {
  interface Window {
    /** 供自检/截图脚本读取运行状态 */
    __stageReady?: () => Record<string, unknown>;
    /**
     * ★ WS-FND-167:`client/index.html` 的**非 module** 兜底脚本挂的致命错误出口。
     * 模块脚本自己 404 时,那段代码是唯一还能跑的东西(它先于模块执行)⇒ 两处**同一出口**。
     */
    __fatal?: (msg: string) => void;
    /** ★ WS-FND-167:启动看门狗句柄(`main()` 跑完必须撤掉,否则 8s 后会误报白屏)。 */
    __bootWatchdog?: ReturnType<typeof setTimeout>;
    /** ★ WS-FND-167:兜底脚本已经显示过致命错误(`true` = `#fatal` 里已有内容)。 */
    __fatalShown?: boolean;
  }
}

/**
 * ★ WS-FND-167:致命错误的**唯一出口**。
 *
 * 先走 `window.__fatal`(index.html 的兜底脚本:它做了"只显示一次"的去重,并且
 * 在模块脚本 404 时也活着);它不在(比如单测里直接 import 本模块)才自己写 DOM。
 */
function reportFatal(msg: string): void {
  if (typeof window.__fatal === 'function') { window.__fatal(msg); return; }
  const el = document.getElementById('fatal');
  if (el === null) return;
  el.style.display = 'block';
  el.textContent = String(msg);
}

/**
 * 联机地址 —— 由页面通过 `?server=ws://host:port` 指定。
 *
 * ## 为什么**默认不连**
 *
 * 阶段 3 只做「**最小可行接线**」:让字节流通、让权威位置画对。
 * 而 `boot()` 在**没有**服务端时必须照常跑(截图自检、离线开发都依赖它)——
 * 若默认去连一个不存在的地址,错误路径会淹没真正的失败。
 * ⇒ ∴ 不传 `?server=` 就是**单机模式**:`session` 为 `null`,一切照旧。
 *
 * ## 为什么把 `handle.store` **传进** `createSession`
 *
 * `boot()` 内部已经建了一个 `ClientStateStore`(渲染循环每帧读它)。
 * ⇒ `createSession({ store: handle.store })` 让会话写进**同一个**对象。
 * 若让会话自己再建一个,就会出现「字节收到了、画面不动」——
 * 而**没有任何东西会报错**(两个 store 各自都"正常工作")。
 * ⇒ 这是本仓反复出现的形态:两处都对,合起来不对。
 *   ∴ 把「谁持有 store」变成**参数**,而不是运行期约定。
 */
function serverUrlFromLocation(): string | null {
  const q = new URLSearchParams(window.location.search).get('server');
  if (q !== null && q !== '') return q === 'off' ? null : q;
  /* ★ 2026-11-14(`npm run play`):没给 `?server=` 时**默认连本机的 play 服务端** ——
     「打开页面就能玩」就是这一行的目的。端口与 `scripts/play.ts` 的默认值(8791)一致。
     ⚠️ 显式 `?server=off` 关闭联机:离线/截图自检时不能让重连噪音淹没真正的错误。 */
  return `ws://${window.location.hostname || '127.0.0.1'}:8791/ws`;
}

function main(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('缺少 #app 容器');

  let handle: BootHandle;
  try {
    handle = boot(root);
  } catch (e) {
    /* 启动失败直接把错误显示出来 —— headless 截图能拍到(fps-probe 判 `#fatal` 非空),
       避免「白屏但控制台里其实有异常」这种查不出来的情况。
       ★ WS-FND-167:走**唯一出口** `reportFatal`(index.html 那段非 module 脚本挂的
       `window.__fatal`;模块脚本自己 404 时这里根本执行不到,由那段兜底)。 */
    reportFatal(`启动失败:\n${(e as Error).stack ?? String(e)}`);
    throw e;
  }

  /* ── 联机:只在给了 `?server=` 时才连 ──
     不给就完全是单机模式,与接线前行为一致(截图自检依赖这一点)。 */
  let session: SessionHandle | null = null;
  /* 自己的 playerId —— 只在 `welcome` 里拿得到。预测器要用它去 store 里
     取**权威**位置(`telegraphCenterOf` 的第二个参数)。 */
  let playerId: string | null = null;
  const url = serverUrlFromLocation();
  /* 动作状态**先于** `createSession` 与键处理声明:两处都要用它们
     (声明在后面会 TDZ —— 回执回调是异步的,但键处理不是)。 */
  /* ★ 第十轮:开局那句话把**两张键位表**都报出来 —— 修前只报字母表那六个,
     四个新动作(驯养/购买/炼金/放自动化件)的入口对玩家**不可见**。 */
  let lastAction = `按 ${keyHints()} —— 动作入口 ${entryKeyHints()} · 热键 ${hotbarKeyHints()}`;
  /**
   * ★ 第十轮 P3:最近一条**服务端拒绝原因**(`reject` 报文)。
   *
   * 修前 `session` 已经把拒因放在三处(`onReject` / `lastReject` / `rejectedFrames`),
   * 而本文件**一个都没接**:只在 `onState('failed')` 时 warn 一句,而服务端的拒绝
   * 随即把状态推成 `closed` ⇒ 拒因被"断开"盖掉,现场只剩「连不上」。
   * 现在它同时进 HUD(状态条)与 `__stageReady`(机读),不再被覆盖。
   */
  let lastReject = '';
  /**
   * ★ WS-FND-167:最近一条 `onState` 的 **detail**(状态本身的具名原因)。
   *
   * 修前 `detail` 只在 `failed` / 带拒因的 `closed` 时被 warn 一句,界面上**从不显示**
   * ⇒ "连接超时:8000ms 内未建立连接(地址…)"这种具名原因没人看得到,
   * 玩家读到的仍是 `连接 connecting`。现在它进 HUD 第一行(与状态同一个字符串)。
   * ⚠️ 只在有 detail 时覆盖:状态变 `live` 时不清空 —— 上一轮的失败原因要留着可读。
   */
  let lastStateDetail = '';
  /**
   * 「最近真的碰过的那件」物品 id。
   *
   * ⚠️ ★ 第十轮 P1:**它是 Q/E/G/F 与 N/T 以及四个新动作的前置**,
   *   而新玩家开局**从未碰过任何物品** ⇒ `lastItemId === 0` ⇒ 全部被拒。
   *   客户端的快照里**没有按件背包明细**(`PlayerState` 只有 `heldItemId`,
   *   而它恒 0)⇒ 拿不到"脚下/面前最近一件"这种默认值 —— 凭空编一个 id
   *   只会换来一条 `INVALID`(而且掩盖真正的原因)。
   *   ⇒ 如实说清前置:提示点名「先按 E 拆一块或 F 捡一件」,手册同样写明
   *   (PLAY.md「先拿到一件」一节 + `client/index.html` 的提示条)。
   */
  let lastItemId = 0;
  /**
   * ★ 第七轮审计 P1:**朝向**。
   *
   * 修前是 `const facing: Facing = { dx: 0, dy: 1 }` —— 写死的"向下",而且 `const`。
   * 于是 `cellInFront(me, facing)` 恒等于「脚下南侧一格」:
   * **Q 放置与 E 拆除永远作用于同一格**,不管角色朝哪走。
   * 现在它每 tick 由 `nextFacing()` 更新(本地输入优先,其次权威位移)。
   */
  let facing: Facing = { ...FACING_DEFAULT };
  /** 上一帧的权威位置(`nextFacing` 的位移来源;`null` = 还没见过权威值) */
  let lastAuthPos: { x: number; y: number } | null = null;
  /**
   * ★ 第七轮审计 P2:背包**明细**账本(`CRAFT` 的 `have`)。
   *
   * 快照里没有明细,但每条回执都带增量(`gained/produced/consumed/...`)⇒
   * `net/have_ledger.ts` 把它们累成一份估计值。修前这里是常量 `undefined`,
   * 于是 `craftRequest` 必判"需要 have"⇒ 按 N 永远发不出去(死键)。
   */
  let haveDetail: HaveDetail = {};
  /**
   * ★ 第七轮审计 P2:动作键守卫(搜索框里打字时让路)。
   * 每次按键前用 `handle.textInputActive()` 同步一次 —— 那一头是 `boot.ts` 的 `searchMode`。
   */
  const keyGuard = new ActionKeyGuard();

  /* ── 动作入口(2026-11-15):让「合成 / 睡觉 / 开箱 / 派对开局」在浏览器里**真能按** ──
     ⚠️ 判定**不在本文件**:构建载荷、三类分支(参数不对 / 未连接 / 发)、回执文案
       全在 `net/action_entry.ts`(零 import、`tests/WS-FND-35-client-entry.test.ts` 有断言);
        键位表在 `net/action_binding.ts`。本文件只做**装配根**:把真会话注进端口。
        —— 把判定留在不可测的入口里,正是本仓反复记的"改坏了没人知道"。 */
  const actionEntry = new ActionEntry(sessionPorts(() => session));
  const actionBinding = createActionBinding({
    entry: actionEntry,
    inputs: {
      /* 合成:`lastItemId` 是"**最近真的碰过的那件**"(回执 `effect` 带回来的)。
         ★ 第七轮审计 P2:`have` 修前恒 `undefined`,而 `craftRequest` 判它**必填**
         (服务端 `craft.ts` 没有按明细的读口)⇒ 「按 N」永远走不到发送 = 死键。
         现在给的是 `net/have_ledger.ts` 按回执增量累出来的**估计值** ——
         漂了就发一条、服务端回 INVALID + 可读理由,总比"按了没有任何反应"强。 */
      craft: () => ({ itemId: lastItemId, have: haveDetail }),
      /* 开箱:取**脚下**那格 —— 箱子是地面实体,站着就能开。 */
      chestCell: () => {
        const me = handle.store.state.players.find((p) => p.id === handle.store.localPlayerId);
        return me === undefined ? { x: undefined, y: undefined } : cellUnder(me);
      },
      /* 派对模式回声:★ 第六轮起**给了** —— `meta.partyMode` 已经有读者
         (`ui/party_hud.ts` 的下标→模式名换算),而服务端 `start_party.ts` 拿它跟
         **模式名**比(`String(declared) !== String(mode)`)⇒ 这里必须回**名字**,
         不能回下标(回下标会被判"不一致")。
         `partyMode === 0`(房间还没选模式)⇒ `undefined` ⇒ 省略这个键 = 不核对
         (不知道就**不声称**,与接线前同一条纪律)。 */
      partyModeEcho: () => partyModeName(handle.store.state.meta.partyMode) ?? undefined,
      /**
       * ★ 第七轮审计 P2:`USE_ITEM`(按 T)此前**没有端口**。
       *
       * `net/action_binding.ts` 的 `EntryInputs.useItem` 是**可选**的,而本文件从没给过它
       * ⇒ 键盘路径按 `{}` 调构建器 ⇒ 恒回"需要 itemId" ⇒ 按 T **永远不发**(死键)。
       * 与 `CRAFT` 同理,物品 id 用「最近真的碰过的那件」(`lastItemId`,来源是回执的 `effect`)。
       * 一件都没有时仍然是"有话说"的拒绝(`actionEntry.status` 会写出来),不是静默。
       */
      useItem: () => ({ itemId: lastItemId }),
      /*
       * ★ 第十轮(WS-FND-138):四个此前**玩家按不到**的动作,现在有了宿主参数来源。
       * 参数一律取**权威快照**里的东西(最近的生物 / 最近碰过的物品),不编造:
       * - 驯养(`1`):投喂离你最近的那只 —— `petId` 用**实例 id**(`wildlife[].id`),
       *   `mobId` 用**物种 id**;两者是两层,服务端第一次投喂要靠它登记。
       * - 购买(`2`)/ 炼金台(`3`):都用「最近物品」当 itemId(购买 1 件)。
       * - 放自动化件(`4`):走**播种形态**(只给 itemId)——
       *   客户端不持有 `wiring` 的 kind 名单(那是服务端的注册表),编一份就是第二份实现。
       * ⚠️ 给不出参数时**不发**,由入口回一句可读的话(绝不发一条注定被拒的报文)。
       */
      breedTame: () => {
        const me = predictor.pos;
        const w = nearestWildlife(me);
        return { op: 'FEED', petId: w?.id, mobId: w?.mobId, itemId: lastItemId };
      },
      buyItem: () => ({ itemId: lastItemId, qty: 1 }),
      useAlchemyFurnace: () => ({ itemId: lastItemId }),
      /* ⚠️ 目标格必须是**整数格**:`predictor.pos` 是浮点(如 12.53),直接传会被
         构建器的整数守卫拒掉(`PLACE_AUTOMATION 需要 x / y(整数)`),而玩家看到的是
         "按了 4 没反应" —— 这就是"修好了一半"的典型。用 `cellUnder`(与开箱同一口径)。 */
      placeAutomation: () => {
        const cell = cellUnder(predictor.pos);
        return { x: cell.x, y: cell.y, itemId: lastItemId };
      },
      /* ★ WS-FND-154:采集(`5`)—— 目标是**面前那格**,与 `Q`/`E` 同一个 `cellInFront`
         口径(`net/action_target.ts` 的朝向说明)。客户端**不判**「那一格能不能采」:
         可采集性(内容表 §3.1 自然资源)/ 工具族词条 / 采集半径三件事只在服务端
         `net/actions/gather.ts` 一处判 —— 快照里也没有格子物件数据可判。 */
      gather: () => {
        const cell = cellInFront(predictor.pos, facing);
        return { x: cell.x, y: cell.y };
      },
    },
  });
  /* 键位:薄绑定。`window` 满足结构化目标 `KeyEventTarget`,不需要 jsdom 也照样能驱动。 */
  const detachActionKeys = actionBinding.attachKeyboard(window);

  /* ★ WS-FND-151:模式面板选中某一档 ⇒ 发 `SET_PARTY_MODE`。

     本文件是**装配根**(持有 `session` 与 `actionEntry`),而 `three/boot.ts` 两个
     都没有 ⇒ 端口在这里注入(与 `setPoseSource` 同一条手法)。选中的档位来自
     `ui/party_panel.ts`(名字/规则来自冻结层 `PARTY_MODES`),报文由
     `net/action_entry.setPartyMode` 走**同一条**三支分流(参数不对 / 未连接 / 发)。
     ⚠️ 不是开局:`V`(`START_PARTY`)仍只开"房间已选"的模式。 */
  handle.setPartyModeSink((mode: number, key: string): string => {
    const out = actionEntry.setPartyMode({ partyMode: key });
    lastAction = out.status;
    return out.sent ? out.status : `${out.status}(第 ${String(mode)} 档)`;
  });

  if (url !== null) {
    session = createSession({
      url,
      /* ★ 复用 boot 的 store —— 别让两个 store 各写各的(见上) */
      store: handle.store,
      /* ★ WS-FND-113 第 4 处:被动断开 ⇒ 自动重连(主动 `close()` 不重连)。
         没有它,"重连路径"在生产里根本不存在,那一堆复位也就无从触发。
         ★ WS-FND-167:1500 是**退避基数**(不再是固定间隔)—— 间隔按
         `backoffDelayMs(次数, 基数, 上限 30s, 倍率 2)` 指数增长并封顶,
         死服务不再每 1.5s 无限空转;成功 `open` 后退避计数归零。 */
      autoReconnectMs: 1500,
      /* ★ WS-FND-167 缺口 1:连接 / 握手都**具名超时** —— 黑洞端口连事件都不来,
         不设超时的话状态会永久停在 `connecting`,界面上永远写着"连接中"。 */
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      reconnectMaxMs: RECONNECT_MAX_MS,
      reconnectFactor: RECONNECT_FACTOR,
      events: {
        /* 帧到达:渲染循环自己在读 `handle.store`,这里**不需要**触发重画。
           只把"坏包/空帧"留痕,便于自检脚本读。 */
        onFrame: () => { /* 渲染循环每帧自读 store */ },
        /* ★ 第十轮 P3:**拒因不许被 close 盖掉**。修前这里只对 `'failed'` 告警,
           而服务端的拒绝随即把状态推成 `'closed'`(带同一条拒因)⇒ 「为什么被拒」
           只留在一次瞬时 `failed` 上,现场只剩「断了」。⇒ `closed` 带 detail 时也打。
           ★ WS-FND-167:同一句话也进 HUD(`lastStateDetail`)—— 超时/拒因/版本不符
           都不再只在控制台里(界面上必须读得到"到底卡在哪一步")。 */
        onState: (s, detail) => {
          if (detail !== undefined && detail !== '') lastStateDetail = detail;
          if (s === 'failed' || (s === 'closed' && detail !== undefined)) {
            console.warn(`[session] ${s}:`, detail);
          }
        },
        /* ★ WS-FND-167:重连排程 ⇒ 界面显示"第几次、多久后"。
           修前只有"断了"这一个事实 ⇒ 状态条永远在转,玩家不知道还要等多久。 */
        onRetryScheduled: ({ attempt, delayMs }) => {
          lastStateDetail = `第 ${attempt} 次重连已排程:${(delayMs / 1000).toFixed(1)}s 后重拨`;
        },
        /* ★ 第十轮 P3:`session` 的 `onReject` / `lastReject` / `rejectedFrames`
           三个出口此前在客户端**零消费者**。现在接上,并做**分档**:
           `WORLD_REJECTED`(世界侧回退权威坐标)是**游戏内事件**——「原地不动」,
           不是连接级失败;其余(反作弊/入场)才按失败告警。 */
        onReject: (r) => {
          const code = r.code ?? r.kind ?? 'UNKNOWN';
          if (code === 'WORLD_REJECTED') {
            lastReject = '移动被世界侧拒收 ⇒ 回退权威坐标(非反作弊)';
            return;
          }
          lastReject = `服务端拒绝 ${code}:${r.reason ?? '没给理由'}`;
          console.warn('[session] 拒绝:', lastReject);
        },
        /* ★ WS-FND-113 第 4 处:`epoch >= 2` = 这一次 open 是**重连** ⇒
           先把整条本地预测链复位,再让新一代命令从 seq=1 出发。 */
        onOpen: (epoch) => {
          if (epoch > 1) resetLocalChain();
        },
        onWelcome: (w) => {
          playerId = w.playerId;
          console.info(`[session] 已加入房间 ${w.roomId}(玩家 ${w.playerId})`);
        },
        /* ★ 2026-11-14:动作回执。三件事:
           1 变成玩家能读的一句话(分类不同,话不同 —— 见 `action_target.ts`);
           2 **记下那次动过的物品 id** —— 快照里没有背包明细,而回执的 `effect`
             是唯一"玩家真的碰过这件东西"的真值来源(下一步动作用它);
           3 ★ 2026-11-15:同一份回执也递给**动作入口**(`net/action_entry.ts`)——
             它给五个新动作(CRAFT / SLEEP / OPEN_CHEST / USE_OWN_CHEST / START_PARTY)
             翻出**带动作名**的一句话。四条失败分类在那里是**四句不同的话**,
             而 `action_target.ts` 的键位表里没有这五个动作(它只管建造/拆/丢/捡)
             ⇒ 少这一路,被拒就又是"按了没反应"。 */
        onActionResult: (r) => {
          lastAction = describeActionResult(r);
          actionEntry.onActionResult(r);
          const e = r.effect;
          if (e !== undefined) {
            const id = e.objId ?? e.itemId;
            if (typeof id === 'number' && Number.isFinite(id)) lastItemId = id;
          }
          /* ★ 第七轮审计 P2:回执里的**增量**落进明细账本 —— `CRAFT` 的 `have` 就是它。
             被拒的回执(`ok === false`)不落账:它没有改动背包(见 `have_ledger.ts`)。 */
          haveDetail = applyReceiptToHave(haveDetail, { action: r.action, ok: r.ok, effect: r.effect });
        },
      },
    });
  }

  /* WASD → InputCmd → 本地预测 → 上行(2026-11-14,task-83 选乙)。
     固定 32Hz:`predictStep` 的位移是 `v_max * DT`,而 DT 是服务端权威常数 ——
     跟着渲染帧走会让 60Hz 与 30Hz 的机器角色速度不同,且不报错。

     ★ WS-FND-23 更新:WASD 现在**只**驱角色。相机跟随**权威位置**
     (`three/boot.ts` 每帧一次 `net/camera_follow.ts` 的 `stepCamera`),
     所以「角色不会走出画面」不再依赖按键。旧写法里「WASD 顺手平移相机」那半
     已经删掉(`boot.ts` 的 `pan.x += ...` 没了)—— **别把它加回来**:
     相机与角色共用一批按键时,跟随会重新退化成**巧合**(输入一变就失效、且不报错)。 */
  /* ── 攻击与 HUD(2026-11-14:让「能玩」在屏幕上可见)── */
  const statusEl = document.getElementById('status');
  let lastHit = '还没打过';
  const lastHp = new Map<string, number>();
  /* ── ★ WS-FND-167:加载指示 + 面板文本镜像(a11y)──
     修前两件事都不可见:
     ```text
     a 图集加载失败只进 `summary()` ⇒ 屏幕上只是"背包格变色块",**原因读不到**;
     b 面板全画在 canvas 上 ⇒ 读屏器零可达、键盘 Tab 一个面板都到不了。
     ```
     ⇒ 这里各接一条:加载指示读 `summary()`(`atlasOk` / `atlasErr`),镜像面板读
     **同一串** HUD 文本(`ui/a11y.ts` 的 role/aria-label/Tab 可达 + 字号/对比度常量)。 */
  const bootStatusEl = document.getElementById('bootstatus');
  const hintEl = document.getElementById('hint');
  const a11y = createA11yMirror();
  /* 挂到 `#app`(与摇杆同一层):`position:fixed` 的镜像面板不参与画布布局。 */
  a11y.mount(root);
  /** 第一份权威数据(或单机)是不是已经到了 —— 隐藏"加载中"的唯一判据。 */
  let readySeen = session === null;
  /** 慢档读数(每 500ms 拉一次 `summary()`;按帧拉太贵 —— 它会投影所有立牌)。 */
  let lastPollMs = 0;
  let atlasNote = '图集 加载中…(格子暂为色块占位)';
  let panelNote = '面板 无';

  /**
   * 最近的怪 —— 从**权威快照**取(`store.state.wildlife`)。
   * ⚠️ 客户端不自己维护怪列表:那是服务端的事,两份列表迟早分叉。
   *
   * ★ 第十轮:`id`(**实例 id**)也一起返回 —— 驯养动作(`BREED_TAME`)的 `petId`
   *   要的是**实例 id**,而 `mobId` 是**物种 id**,两者是两层
   *   (见 `server/src/mobs/spawner.ts` 的 id 规则)。只返回 `mobId` 的话,
   *   驯养那条路只能拿物种 id 当 petId 用 —— 那是两个不同的键。
   */
  const nearestWildlife = (from: { x: number; y: number }):
    { id: string; mobId: string; hp: number; maxHp: number; d: number } | null => {
    let best: { id: string; mobId: string; hp: number; maxHp: number; d: number } | null = null;
    for (const w of handle.store.state.wildlife) {
      const d = Math.hypot(w.x - from.x, w.y - from.y);
      if (best === null || d < best.d) {
        best = { id: w.id, mobId: w.mobId, hp: w.hp, maxHp: w.maxHp, d };
      }
    }
    return best;
  };

  /* ═══ ★ WS-FND-166:触屏按钮条(手机没有键盘 ⇒ 面板一个都打不开)═══
     面板键位表 `PANEL_KEYS` 全是字母键(i/r/h/p/m);真机上**没有任何键盘**。
     屏幕按钮是"最低方案",而它按下去走的是**同一台状态机**(`boot.togglePanel`
     → `setPanel`),不是另开一条开关面板的路。 */
  const detachGestures = suppressNativeGestures(window);
  let lastTouchButton = '还没按过';
  let lastTouchIntent = `还没碰过屏幕(轻点上限 ${TAP_MAX_MS}ms / ${TAP_MAX_TRAVEL_PX}px)`;
  /** 被 UI 吃掉、因而**没有**开摇杆的指针数(自检口径:> 0 = 互斥真生效过) */
  let uiPointerSuppressions = 0;
  /** 轻点被判成攻击的次数(`0` 且一直为 0 ⇒ 触屏攻击这条出口没跑起来) */
  let tapAttacks = 0;
  const nowMs = (): number => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  );
  const touchBar = createTouchBar((id: TouchButtonId): void => {
    lastTouchButton = id;
    if (id === 'attack') { attackNearest('button'); return; }
    if (id === 'close') { handle.closePanel(); return; }
    const panel = panelOfButtonId(id);
    if (panel !== null) handle.togglePanel(panel);
  });
  touchBar.mount(root);

  /**
   * ★ WS-FND-166:**UI 与摇杆 / 攻击的互斥** —— 先判 UI,再判摇杆。
   *
   * ## 修前是什么样(实测)
   *
   * 摇杆只管"指针类型"(`pointerType !== 'mouse'`),而它的监听挂在 `window`
   * **冒泡层**:手指按在背包面板上往下拖时,`boot` 的画布监听**先**执行并拿起格子,
   * `main` 的 window 监听**随后**照样开摇杆 ⇒ 「单指拖背包时角色一边走」。
   * 两条监听各自都"工作正常",所以没有任何断言会红。
   *
   * ## 现在
   * 「这一下归不归 UI」由**纯判定**回答(`boot.uiHitAt` → `ui/panel_hit.uiConsumesPoint`,
   * 面板容器也算)加上触摸条自己的命中(`hitTouchBar`) ⇒ 与事件注册顺序无关。
   */
  function pointerConsumedByUi(x: number, y: number): boolean {
    return touchBar.hitAt(x, y) !== null || handle.uiHitAt(x, y);
  }

  /**
   * 左键 / 轻点 / 「攻」按钮:打**最近**那只(距离与伤害都由服务端判,客户端只给目标)。
   * `source` 只进那句话 —— 让「这一刀是哪条入口打出来的」可读(`__stageReady.lastTouchIntent`)。
   */
  function attackNearest(source: 'mouse' | 'tap' | 'button' = 'mouse'): void {
    if (session === null) { lastHit = `未联机,打不了(${source})`; return; }
    const w = nearestWildlife(predictor.pos);
    if (w === null) { lastHit = '附近没有怪'; return; }
    session.sendAttack({ mobId: w.mobId });
    lastHit = `已发攻击(${source}) → ${w.mobId}(${w.d.toFixed(1)} 格)`;
  }
  /**
   * 攻击的**指针入口**(★ WS-FND-166)。
   *
   * 修前只挂 `mousedown`,而摇杆对**每一次触摸**都 `preventDefault()`
   * ⇒ 浏览器不再补发兼容的 `mousedown` ⇒ **手机上永远打不出攻击**,
   * 而控制台一句话都不说。现在三条出口:
   * ```
   * 鼠标左键(`pointerdown` + `pointerType === 'mouse'`)  ⇒ 即刻攻击
   * 触屏轻点(抬手判定,见 `onStickEnd`)                  ⇒ 不拖动就等于攻击
   * 屏幕「攻」按钮(触摸条)                              ⇒ 确定性入口
   * ```
   * ⚠ 先判 UI:按在面板/按钮上的那一下不该挥刀(与摇杆互斥同一口径)。
   */
  window.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (pointerConsumedByUi(ev.clientX, ev.clientY)) return;
    if (ev.pointerType === 'mouse') attackNearest('mouse');
  });
  /**
   * 空格 = **攻击**(这条监听),而同一个键在 `net/input.ts` 的 `InputSource.press`
   * 里**同时**会锁存一次 `jump`。
   *
   * ★ 第十轮 P1:这条"一键两义"此前**任何文档都没写**(PLAY.md 与提示条都只说
   *   「空格 攻击」),而它有两个后果:
   * ```
   * 1 玩家以为空格是跳   ⇒ 对,但整条链是异步的:客户端只**锁存**一次 `jump: true`
   *                        随下一条移动命令上行,能不能起跳由世界侧裁决(见下)
   * 2 玩家以为空格是攻击 ⇒ 对,但每按一次还夹带一条带 `jump:true` 的移动命令
   * ```
   * ⇒ 本轮**如实写清**(PLAY.md 的键位表 + `client/index.html` 的提示条都点名),
   *   不拆键位:拆会把「空格 = 攻击」这条已被玩家与 `WS-FND-16`/`WS-FND-113`
   *   钉住的行为无声改掉。跳跃的末端**已接通**(此前这里是「服务端不接」,那句是错的):
   *   `server/src/net/ws_server.ts#parseMoveIntent`(只收字面 `true`)→ `applyJumpIntent`
   *   → `WorldSim.tryPlayerJump`,结果(含拒绝理由)记进 `lastJumpReport`;
   *   判据 `tests/WS-FND-122-protocol-exits.test.ts`。见 `net/input.ts` 的 `jumpLatched` 注释。
   */
  window.addEventListener('keydown', (ev) => {
    /* ★ 第七轮审计 P2:搜索框里打空格应当是"空格",不是"挥一刀"。
       判定走 `net/key_guard.ts`(纯),源是 `boot` 的 `searchMode`(拉,不是回调)。 */
    keyGuard.setTextInput(handle.textInputActive());
    if (keyGuard.textInputActive) return;
    if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); attackNearest(); }
  });

  /**
   * 每 tick 刷一次状态条(连接态不是 live 时变黄 —— 一眼能看出「没连上」)。
   *
   * ★ WS-FND-167:这个函数产出的是**唯一一份** HUD 文本 —— `#status`(看)与
   * `#a11y_panels`(读屏器 / Tab)写的是**同一个数组**。两处各拼一份的话,
   * "屏幕上写了、读屏器念的是别的"这种漂移没人测得出来。
   */
  const paintStatus = (
    pos: { x: number; y: number },
    near: { mobId: string; hp: number; maxHp: number; d: number } | null,
  ): void => {
    const st = session?.state ?? 'offline';
    /* ── ★ WS-FND-167:连接那三行:状态 + **具名 detail** + 阶段 + 退避排程 ──
       修前只有 `连接 connecting` 这一行:黑洞端口永远停在"连接中",而"第几次重试、
       下次什么时候拨"在界面上**根本不存在**(只在 `session` 的内部字段里)。 */
    const sessionLine = `连接 ${st}${lastStateDetail === '' ? '' : `:${lastStateDetail}`}`;
    const phaseLine = session === null
      ? '连接阶段 单机(未联机,不发包)'
      : session.lastTimeout !== null
        ? `连接阶段 已判死:${session.lastTimeout.kind === 'connect' ? '连接' : '握手'}超时`
          + ` ${(session.lastTimeout.ms / 1000).toFixed(1)}s —— ${session.lastTimeout.text}`
        : st === 'connecting'
          ? `连接阶段 连接中...(建立连接上限 ${(CONNECT_TIMEOUT_MS / 1000).toFixed(0)}s /`
            + ` 之后等 welcome 上限 ${(HANDSHAKE_TIMEOUT_MS / 1000).toFixed(0)}s,超时会写明原因)`
          : st === 'live' ? '连接阶段 已握手(收到 welcome)' : '连接阶段 未连接';
    const retryLine = session === null || session.retryDelayMs === null || session.nextRetryAtMs === null
      ? '重试 无(当前没有在排)'
      : `重试 第 ${session.retryCount} 次 · 下次约`
        + ` ${(Math.max(0, session.nextRetryAtMs - Date.now()) / 1000).toFixed(1)}s 后`
        + `(退避 ${(session.retryDelayMs / 1000).toFixed(1)}s / 上限 ${(RECONNECT_MAX_MS / 1000).toFixed(0)}s)`;
    /* ── ★ WS-FND-167 缺口 4:坏包 / 空帧 / 旧帧 / 载荷丢帧 / 拒收**上界面** ──
       修前这几个计数只有 `__stageReady` 里有(而这个字段得开 devtools 才读得到)
       ⇒ "确实在丢数据"在画面上完全看不见。 */
    const diagLine = session === null
      ? '诊断 单机(无会话)'
      : `诊断 坏包 ${handle.store.decodeErrors} 空帧 ${handle.store.emptyFrames}`
        + ` 旧帧 ${handle.store.staleFrames} 丢帧 ${session.droppedFrames} 拒收 ${session.rejectedFrames}`
        + (session.lastDropReason === null ? '' : ` · 最近丢帧:${session.lastDropReason}`);
    const lines = [
      sessionLine,
      phaseLine,
      retryLine,
      diagLine,
      /* ★ WS-FND-167:图集/加载那一行 —— 失败时把**原因**写出来(修前只进 summary)。 */
      atlasNote,
      `坐标 ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`,
      near === null
        ? '附近 无怪'
        : `最近 ${near.mobId} hp ${near.hp.toFixed(0)}/${near.maxHp.toFixed(0)} (${near.d.toFixed(1)}格)`,
      lastHit,
      /* 动作那两行:回执文案(分类不同话不同)+ 最近碰过的物品。
         背包**明细**不在快照里(只有服务端有)⇒ 这里不编一个数字出来。 */
      lastAction,
      /* ★ 第十轮 P3:最近一条**服务端拒绝原因**(HUD 出口)。修前拒因在客户端
         一个出口都没有 —— 只在 `onState('failed')` 的一瞬 warn,随即被 close 盖掉。 */
      lastReject === '' ? '拒绝 (无)' : lastReject,
      /* ★ 2026-11-15:五个新动作(合成/睡觉/开箱/派对开局)那一行。
         它由**入口**给出:发出去时是"合成 → 已发 (itemId=151)",
         被拒时是"开公共箱 ✗ 你没有这个权限"(四条失败分类四句话)。
         ⇒ 玩家第一次能分清"我按错了"与"服务端不让我做"。 */
      actionEntry.status,
      lastItemId === 0 ? '最近物品 (还没有)' : `最近物品 ${lastItemId}`,
      /* ★ 第十轮:四个热键的**前置**也写进状态条 —— 它是那句话的机器可读版,
         自检/复现脚本据此能判断"这条拒绝是前置没满足,不是参数写错"。 */
      lastItemId === 0
        ? '热键 1/2/3/4 需要「最近物品」(按 E 或 F 先拿一件)'
        : '热键 1/2/3/4 就绪(1 驯养 · 2 购买 · 3 炼金台 · 4 放自动化件)',
    ];
    if (statusEl !== null) {
      statusEl.textContent = lines.join('\n');
      statusEl.classList.toggle('bad', st !== 'live');
    }
    /* ★ WS-FND-167:a11y —— 同一份文本按面板归档(读屏器 / Tab 到 `#a11y_panels` 时念)。
       `panel` 那块给的是"当前面板 + 站在哪",`hint` 那块直接取 `#hint` 的文本(一处文案)。 */
    a11y.update({
      session: [sessionLine, phaseLine, retryLine].join('\n'),
      diagnostics: [diagLine, lastReject === '' ? '拒绝 (无)' : lastReject, lastHit].join('\n'),
      load: `${atlasNote}\n${panelNote}`,
      panel: [`当前面板 ${panelNote.replace(/^面板 /, '')}`, `坐标 ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`,
        `最近物品 ${lastItemId === 0 ? '(还没有)' : lastItemId}`].join('\n'),
      hint: hintEl?.textContent ?? '键位提示不可读(#hint 缺失)',
    });
  };
  /* ── 动作键位(2026-11-14 第二轮):让「建造 / 拆掉 / 丢下 / 捡起」在浏览器里真的能按 ──

     ⚠️ 目标格的判定**不在**这里:它住在 `net/action_target.ts`(纯函数、有断言,
        见 `tests/WS-FND-22`)。本文件只做"读键 → 调它 → 发报文 → 显示回执"。
        ——判定留在不可测的入口里,就是本仓反复记的那种"改坏了没人知道"。 */
  window.addEventListener('keydown', (ev) => {
    /* ── ★ 第七轮审计 P2:搜索态下**动作键必须让路** ──
     *
     * 修前这条监听不知道 `boot.ts` 有个搜索框 ⇒ 在背包搜索里打 "e":
     * ```
     * 查询串多一个 e(对) + 一条 BREAK_BLOCK 发出(错)
     * ```
     * 两条监听各自都"工作正常",所以没有任何断言会红。
     * 判定在 `net/key_guard.ts`(纯函数、可在 node 里断言),来源是 `handle.textInputActive()`
     * —— `boot` 的 keydown 监听比本监听先注册,同一次按键里它已经更新过 `searchMode`。 */
    keyGuard.setTextInput(handle.textInputActive());
    if (!keyGuard.handles(ev.key)) {
      /* 只报"被文本输入挡掉"的那一类(非动作键本来就该静默返回,两种原因必须分开) */
      if (keyGuard.blockedByTextInput(ev.key)) {
        lastAction = `输入中 ⇒ ${ev.key} 不触发动作(先按 Enter 结束搜索)`;
      }
      return;
    }
    const spec = ACTION_KEYS[ev.key.toLowerCase()];
    if (spec === undefined) return;
    if (session === null) { lastAction = `${spec.label} ✗ 未联机`; return; }
    const me = handle.store.state.players.find((p) => p.id === handle.store.localPlayerId);
    if (me === undefined) { lastAction = `${spec.label} ✗ 快照里还没有自己`; return; }
    const cell = spec.target === 'front' ? cellInFront(me, facing) : cellUnder(me);
    /* 三个动作要一个物品 id。用"**最近真的碰过的那件**"(回执 effect 里带回来的),
       而不是"手上那件":快照的 `heldItemId` 目前恒 0(没有装备槽),
       而拆一块 / 捡一件都会把 id 回给我们 ⇒ 那是唯一"玩家确实持有过"的真值来源。
       一件都没有时**如实说**,不发一个注定被拒的报文。 */
    const needItem = spec.action === 'PLACE_BLOCK' || spec.action === 'DROP_ITEM'
      || spec.action === 'PICKUP_ITEM';
    if (needItem && lastItemId === 0) {
      /* ★ 第十轮 P1:**新玩家的第一步就卡在这里。**
         开局从未碰过任何物品 ⇒ `lastItemId === 0` ⇒ Q/E/G/F 与 N/T(以及四个热键)
         全部被拒。修前那句话只说「先按 E 拆一块或按 F 捡一件」—— 没写清
         **这件事是有前置的、而且 E/F 会把"最近物品"记下来**;玩家读到的是
         "这个键坏了"。现在把三件事一次说清:缺什么、怎么拿到、拿到后哪个键会通。 */
      lastAction = `${spec.label} ✗ 还缺「最近物品」:先按 E 拆一块或按 F 捡一件`
        + `(拆 / 捡的回执会把物品 id 记下来,之后 Q/G/F/N/T/2/3/4 才发得出去)`;
      return;
    }
    ev.preventDefault();
    session.sendAction({
      action: spec.action,
      x: cell.x,
      y: cell.y,
      ...(needItem ? { itemId: lastItemId } : {}),
      ...(spec.action === 'DROP_ITEM' ? { count: 1 } : {}),
    });
    /* 格坐标与朝向一起报:`facing` 修前恒向下,而"格坐标"看起来永远正常 ——
       只有把朝向写进提示,"Q 永远放脚下南侧"才是一个玩家/脚本都读得出来的事实。 */
    lastAction = `${spec.label} → 格(${cell.x},${cell.y}) 朝向 ${facingLabel(facing)}`;
  });
  const input = new InputSource();
  const detachInput = attachKeyboard(window, input);
  /* ═══ D-08 第一步:虚拟摇杆是**主**输入,WASD 只作桌面/调试兼容 ═══
     判定(死区 0.19 / 超程按半径截断 / 方向 / 摇杆压键盘)全在 `net/joystick.ts`
     —— 零 DOM、可单测(`tests/WS-FND-58-joystick-prediction.test.ts` FND58-1…5)。
     本文件只剩**薄壳**:指针坐标喂给 `AnalogStick`,再用 `mergeCmd` 并进命令。
     ⚠️ 只跟**触屏/笔**(`pointerType === 'mouse'` 直接 return):
        鼠标左键仍是攻击(`attackNearest`)—— 一条输入不该同时干两件事。 */
  const stick = new AnalogStick({ maxRadius: STICK_RADIUS_PX });
  /* ★ D-08 第二步:同一根手指,逻辑进 `stick`,视觉进 `stickUI`。
     两者共用 `stick.origin`(基点只在一个地方记)⇒ 不会出现"帽画在 A 点、判定从 B 点算"。
     挂到 `#app`(而不是 body):那一层是 `position:relative`,与画布同一个坐标系。 */
  const stickUI = createJoystickUI();
  stickUI.mount(root);
  let stickPointerId: number | null = null;
  /**
   * ★ WS-FND-166:落指读数(轻点判定用)—— `null` = 这一指针没在摇杆上。
   * 只有**真的开了摇杆**的落指才记,被 UI 吃掉的那些不参与(否则"按面板"会被判成轻点攻击)。
   */
  let stickTap: { at: number; x: number; y: number } | null = null;
  /**
   * 触屏落指:开摇杆。★ WS-FND-166 两处新增(理由见上面「互斥」那段):
   * ```
   * 1 `pointerConsumedByUi` ⇒ **先判 UI 再判摇杆**
   *   (修前手指按在背包上往下拖时,这个 window 监听照样开摇杆 ⇒ 角色一边走)
   * 2 记下 `stickTap` ⇒ 抬手时判「轻点 = 攻击」(`onStickEnd`,判定在 `net/touch_intent.ts`)
   * ```
   */
  const onStickDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse') return; /* 桌面用 WASD:鼠标左键是攻击,不弹摇杆 */
    if (pointerConsumedByUi(ev.clientX, ev.clientY)) { uiPointerSuppressions += 1; return; }
    if (stickPointerId !== null) return; /* 只跟第一根手指 */
    stickPointerId = ev.pointerId;
    stickTap = { at: nowMs(), x: ev.clientX, y: ev.clientY };
    stick.begin(ev.clientX, ev.clientY);
    /* 手柄出现在**手指底下**(浮动摇杆),固定角落会逼玩家先去找手柄 */
    stickUI.show(ev.clientX, ev.clientY);
    /* 挡掉浏览器补发的**兼容的** `mousedown` ⇒「想走路,结果挥了一刀」。
       ⚠️ 修前攻击**只**挂 `mousedown`,这一挡顺手把触屏攻击也挡死了(真机实测:
       手机上永远打不出攻击)。现在攻击改挂**指针事件**(鼠标左键即刻 + 触屏轻点
       + 屏幕「攻」按钮)⇒ 挡掉兼容 `mousedown` 是安全的,而且仍然必要。 */
    ev.preventDefault();
  };
  const onStickMove = (ev: PointerEvent): void => {
    if (stickPointerId !== ev.pointerId) return;
    stick.moveTo(ev.clientX, ev.clientY);
    /* 帽的位移**从基点算**,基点只有一个出处(`stick.origin`)⇒ 视觉与判定用同一对坐标。
       帽的夹取/死区在 `ui/joystick_ui.ts` 的 `knobOffset`(与 `stickVector` 同口径)。 */
    const o = stick.origin;
    stickUI.moveTo(ev.clientX - o.x, ev.clientY - o.y);
  };
  /* `pointercancel` 与 `pointerup` **同一处理**:系统手势 / 来电会发 cancel,
     漏了它的表现是「角色一直朝最后方向走」(与 `input.clear()` 失焦那个病同形)。
     ★ 摇杆视觉必须走**同一条**出口:漏掉的话来电之后屏幕上永远挂着一个手柄
       (帽停在最后那一点),而逻辑早已归零 —— 玩家会以为还在走。 */
  const onStickEnd = (ev: PointerEvent): void => {
    if (stickPointerId !== ev.pointerId) return;
    const tap = stickTap;
    stickPointerId = null;
    stickTap = null;
    stick.end();
    stickUI.hide();
    /* ★ WS-FND-166:抬手判「轻点 = 攻击」(判定在 `net/touch_intent.ts`,纯、可单测)。
       ⚠️ 只有 `pointerup` 参与:`pointercancel` 是系统打断(来电 / 系统手势),
         那一刻挥刀不是玩家的意思 —— 判定里那条"非法读数不攻击"是同一纪律。 */
    if (tap !== null && ev.type === 'pointerup') {
      const verdict = tapAttackVerdict({
        durationMs: nowMs() - tap.at,
        travelPx: Math.hypot(ev.clientX - tap.x, ev.clientY - tap.y),
      });
      lastTouchIntent = verdict.reason;
      if (verdict.attack) { tapAttacks += 1; attackNearest('tap'); }
    }
  };
  window.addEventListener('pointerdown', onStickDown);
  window.addEventListener('pointermove', onStickMove);
  window.addEventListener('pointerup', onStickEnd);
  window.addEventListener('pointercancel', onStickEnd);
  const detachStick = (): void => {
    window.removeEventListener('pointerdown', onStickDown);
    window.removeEventListener('pointermove', onStickMove);
    window.removeEventListener('pointerup', onStickEnd);
    window.removeEventListener('pointercancel', onStickEnd);
    stick.end();
    stickUI.hide();
  };

  const predictor = new LocalPredictor();
  let localTick = 0;
  let seeded = false;
  /* ═══ ★ WS-FND-113 第 4 处:重连复位(整条本地预测链)═══
     重连之后 `InputSource.seq` / `LocalPredictor.acked` / 摇杆状态**都还是上一轮的**,
     而服务端新连接从 ack `-1` 重新开始 ⇒ 症状只是"偶尔不走 / 偶尔回弹",不报任何错。
     复位点**只有这一处**(由 `session` 的 `onOpen(epoch >= 2)` 触发,见下)——
     把复位散进每个失败分支,迟早有一条分支漏掉,而那种漏法查不出来。 */
  const resetLocalChain = (): void => {
    /* 1 预测器:位置先留在原地(下一帧的权威值会重新播种),队列 / acked / 参数全清。 */
    predictor.reset(predictor.pos);
    seeded = false;
    /* 2 输入序号:回零 —— 它就是"这条连接上的第几条命令"(服务端按连接记账)。 */
    input.reset();
    /* 3 摇杆:逻辑与视觉一起归零,指针也不再认作"第一根手指"(否则第二根手指点不动)。
       ★ WS-FND-166:落指读数(`stickTap`)也必须清 —— 否则重连后抬手会把上一轮的
       落指当成"轻点"而白挥一刀。 */
    stickPointerId = null;
    stickTap = null;
    stick.end();
    stickUI.hide();
  };
  /* ★ WS-FND-113 第 2 处:渲染**每帧**从预测器拉一次位置(见 `boot.ts` 的
     `setPoseSource`)。权威还没到(`seeded === false`)⇒ 返回 `null`,
     渲染退回权威兜底 —— 即**没有预测时与接线前逐字段相同**。 */
  handle.setPoseSource(() => (seeded ? predictor.poseView() : null));
  const inputLoop: ReturnType<typeof setInterval> = setInterval(() => {
    /* 摇杆推了就用摇杆,否则回落到 WASD —— 优先级只写在这一处(`mergeCmd`)。 */
    const cmd = mergeCmd(input.nextCmd(), stick.vector());
    /* ★ WS-FND-113 第 1 处:`frozen` / `mu` / `speedMul` 必须**从权威状态推**出来,
       而且**先于这一步**生效(判定在 `predictor.ts` 的 `predictParamsOf`,零 DOM、可单测)。
       修前这里一个参数都不传 ⇒ 眩晕/冰冻禁步、击退、装备加速时客户端**必然**与权威分歧,
       只能靠 1.5 格的 SNAP 硬清队列(玩家看到的是"橡皮筋",而不是"被冻住")。 */
    const me = playerId === null
      ? undefined
      : handle.store.state.players.find((p) => p.id === playerId);
    predictor.setParams(predictParamsOf(me));
    const p = predictor.step(cmd);
    localTick += 1;
    /* 权威姿态喂回预测器。第一次先**播种** —— 预测器必须从权威值起步,
       否则它从 (0,0) 出发一路追,表现是「角色从世界原点滑过来」。 */
    const pose = playerId === null ? null : telegraphCenterOf(handle.store.state, playerId);
    /* ── ★ 第七轮审计 P1:**朝向**每 tick 更新一次(修前是写死的常量) ──
     * 优先级在 `net/action_target.nextFacing` 里(纯函数、可单测):
     * 本地输入非零 ⇒ 立刻转向;否则权威位置动了 ⇒ 按位移转向;都没有 ⇒ 保持。
     * ⚠️ 只在**这一处**写 `facing`:分散到按键回调里会让"松开方向键之后朝向回哪"没人说得清。 */
    facing = nextFacing({
      prev: facing,
      input: { moveX: cmd.moveX, moveY: cmd.moveY },
      from: lastAuthPos,
      to: pose === null ? null : { x: pose.cx, y: pose.cy },
    });
    if (pose !== null) lastAuthPos = { x: pose.cx, y: pose.cy };
    /* ★ WS-FND-113 第 3 处:上行 `z` 的**真实来源**。
       修前播种与回喂都写死 `z: 0` ⇒ predictor 恒把 0 当高度,而上行又照发 `p.z`
       ⇒ 服务端 `applyPlayerMove` 每帧把 `b.z` 抹成 0,**权威高度被抹平**。
       这里改用 `localPlayerZOf`(与 `boot.ts` 同一条入口,纯函数、可单测)。 */
    const authoritativeZ = playerId === null ? 0 : localPlayerZOf(handle.store.state, playerId);
    if (pose !== null) {
      if (!seeded) {
        predictor.reset({ x: pose.cx, y: pose.cy, z: authoritativeZ });
        seeded = true;
      } else {
        /* ★ D-14(2026-11-17):ack 是**这一帧包头**带回来的数(`store` 解码时落账),
           不是本地推出来的 —— 否则"剪枝真的发生"会变成一条本地可以伪造的断言。
           `?server=off` 时 store 恒为空 ⇒ `lastAckedSeq === -1` ⇒ 一条都不剪。 */
        predictor.onAuthoritative({
          x: pose.cx, y: pose.cy, z: authoritativeZ, ackedSeq: handle.store.lastAckedSeq,
        });
      }
    }
    predictor.absorbVisual(DT);
    /* ⚠️ `?server=off` ⇒ `session === null` ⇒ **不发包**(单机/截图自检靠这条:
       没连上却每 tick 调 `sendMove`,表现是控制台刷"还没连上"而画面不动)。
       ★ D-14(2026-11-17):上行**必须带 `cmd.seq`** —— 服务端只把**应用成功**的
       `seq` 写进下行包头 `ackedSeq`,客户端据此剪 `pending`。漏了它的症状是
       「移动照常、永不剪枝」,而两端**都不报错**(TASK-100 实测:生产者此前不存在)。 */
    if (session !== null) {
      /* ★ WS-FND-113:`jump` 在这里**有出口**(此前 `InputSource` 的锁存永远发不出去);
         末端也已接通:`parseMoveIntent`(只收字面 `true`)→ `applyJumpIntent`
         → `tryPlayerJump`,被拒写进 `lastJumpReport`(判据 `tests/WS-FND-122-protocol-exits.test.ts`)。
         本行只负责**发出去**;能不能起跳是服务端的裁决,客户端不预判。 */
      session.sendMove({ tick: localTick, x: p.x, y: p.y, z: p.z, seq: cmd.seq, jump: cmd.jump });
    }
    /* ── HUD:连没连上 / 站在哪 / 附近有没有怪 / 最近一次命中 ──
       「命中量」不是客户端编的:它来自**权威快照里那只怪的血量下降**
       (服务端 applyAttack 结算后写进快照)⇒ 这条反馈与战斗是同一个真值来源。 */
    const near = nearestWildlife(p);
    if (near !== null) {
      const prev = lastHp.get(near.mobId);
      if (prev !== undefined && near.hp < prev) {
        lastHit = `命中 ${near.mobId} -${(prev - near.hp).toFixed(1)} HP`;
      }
      lastHp.set(near.mobId, near.hp);
    }
    /* ── ★ WS-FND-167 缺口 5:加载指示 + 慢档读数 ──
       1 **加载指示**:修前"有没有在加载"完全不可见 —— 只等 HUD 出数,而一旦连不上
         就永远没有数(HUD 的坐标是预测器的本地值,所以"看起来在动"其实说明不了任何事)。
         判据只有一条:第一份**权威**数据到了(联机时 = 握手给了自己的 id)或本来就没会话
         (`?server=off`)。判死(failed/closed)时也撤掉 —— 那时该看的是超时/拒因那几行。
       2 **慢档 500ms**:`summary()` 会投影所有立牌,按帧拉太贵 ⇒ 每 500ms 一次,
         把 `atlasOk` / `atlasErr` / 当前面板变成屏幕上读得到的字。 */
    if (!readySeen) {
      const dead = session !== null && (session.state === 'failed' || session.state === 'closed');
      if (session === null || handle.store.localPlayerId !== '' || dead) {
        readySeen = true;
        if (bootStatusEl !== null) bootStatusEl.style.display = 'none';
      }
    }
    const nowMs = Date.now();
    if (nowMs - lastPollMs >= 500) {
      lastPollMs = nowMs;
      try {
        const s = handle.summary() as {
          atlasOk?: unknown;
          atlasErr?: unknown;
          wiring?: { stateMachine?: { panel?: unknown } };
        };
        if (s.atlasOk === true) {
          atlasNote = '图集 已就绪';
        } else if (typeof s.atlasErr === 'string' && s.atlasErr !== '') {
          atlasNote = `图集 ✗ ${s.atlasErr}(格子是色块占位;资源名 atlas_sprites.png)`;
        } else {
          atlasNote = '图集 加载中…(格子暂为色块占位)';
        }
        const panel = s.wiring?.stateMachine?.panel;
        panelNote = `面板 ${typeof panel === 'string' && panel !== '' ? panel : '无'}`;
        /* ★ WS-FND-166:触摸条**高亮当前面板**(玩家一眼看出按哪个会关掉)。
           值就是 `UiPanel` 的字符串词表 —— 这里不另做映射,避免第二份对照表。 */
        touchBar.setActivePanel(typeof panel === 'string' ? (panel as UiPanel) : UiPanel.NONE);
      } catch (e) {
        /* ⚠️ 读数失败**不许**把 HUD 打崩:如实写一句并留着上一帧的值。 */
        atlasNote = `图集 状态读不到(handle.summary 抛错:${(e as Error).message})`;
      }
    }
    paintStatus(p, near);
  }, DT * 1000);

  window.__stageReady = () => ({
    ...handle.summary(),
    /* 联机状态也进自检口径 —— 否则「连没连上」只能靠看控制台 */
    sessionState: session?.state ?? 'offline',
    /* ★ 第十轮 P3:拒因进**机读口径**(与 HUD 同一份字符串)——「被拒的原因」
       否则只能靠看控制台,而那正是它静默一整轮的原因。 */
    lastReject,
    serverContentClaim: session?.serverContentClaim ?? null,
    /* ── ★ WS-FND-167:连接超时 / 退避 / 诊断计数都进**机读口径** ──
       修前这几件事只有 `session` 的内部字段(JS 里读不到)与 `atlasErr`(只在 summary 里)
       ⇒ "到底卡在哪一步、下次什么时候重拨、丢了多少帧"在自检脚本里读不出来。 */
    lastStateDetail,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    reconnectMaxMs: RECONNECT_MAX_MS,
    reconnectFactor: RECONNECT_FACTOR,
    lastTimeout: session?.lastTimeout ?? null,
    retryCount: session?.retryCount ?? 0,
    retryDelayMs: session?.retryDelayMs ?? null,
    nextRetryAtMs: session?.nextRetryAtMs ?? null,
    droppedFrames: session?.droppedFrames ?? 0,
    lastDropReason: session?.lastDropReason ?? null,
    rejectedFrames: session?.rejectedFrames ?? 0,
    decodeErrors: handle.store.decodeErrors,
    emptyFrames: handle.store.emptyFrames,
    bootReady: readySeen,
    bootStatusVisible: bootStatusEl === null ? null : bootStatusEl.style.display !== 'none',
    atlasNote,
    panelNote,
    /* ── ★ WS-FND-167:a11y 口径 —— 字号/对比度是否达标、镜像面板里到底写了什么 ──
       这两项一起读才分得清"常量达标但没接上"与"接上了但写的是空串"。 */
    a11yTextPx: MIN_TEXT_PX,
    a11yProblems: a11yStyleProblems(),
    a11yMounted: a11y.mounted,
    a11yPanels: a11y.textOf(),
    /* ★ 2026-11-14(task-83 选乙):预测链路也进自检口径 —— */
    /* 否则「输入有没有真的产生命令」只能靠看控制台,而那正是它静默一整轮的原因。 */
    inputKeys: input.pressedCount,
    predictedPos: predictor.pos,
    /* ★ WS-FND-113 第 2 处:渲染**消费**的就是这两个 —— 只报 `predictedPos` 时,
       "画面画的到底是预测位置还是权威位置"仍然读不出来(它正是静默一整轮的原因)。 */
    predictedRenderPos: predictor.renderPos,
    predictedVisualOffset: predictor.poseView()?.visualOffset ?? null,
    /* ★ 第 1 处:喂进预测器的参数也是读数 —— 否则"冻结/摩擦到底生效没有"只能靠读代码。 */
    predictParams: predictor.lastParams,
    /* ★ 第 5 处:被单调门丢掉的旧帧数(与空帧、坏包**分开**计)。 */
    staleFrames: handle.store.staleFrames,
    /* ★ 第 3 处:上行用的 `z`(= 权威高度;修前这条路恒 0,把权威高度抹平了)。 */
    uplinkZ: predictor.pos.z,
    pendingCmds: predictor.pendingCount,
    lastReconcileAction: predictor.lastReconcile?.action ?? null,
    /* ★ 2026-11-16(D-08):摇杆与 `ackedSeq` 也进自检口径 ——
       「摇杆推了到底有没有产生方向」「剪枝到底跑没跑」都必须是**读得出来的数**,
       否则它们只会是代码里一行"看起来接上了"。 */
    stickActive: stick.active,
    stickMagnitude: stick.vector().magnitude,
    joystickDeadZone: JOYSTICK_DEAD_ZONE,
    /* ★ D-08 第二步:手柄**在不在屏幕上**也进自检口径。
       否则「摇杆视觉到底弹没弹」只能靠肉眼看截图 —— 而那正是它静默一整轮的原因。 */
    joystickVisible: stickUI.visible,
    joystickMounted: stickUI.mounted,
    /* ═══ ★ WS-FND-166:触屏入口的**读数**(手机上的"打不出攻击 / 面板打不开"必须可读)═══
       四个字段各有分工,少一个就分不清是哪一半坏了:
       ```
       touchBarMounted   触摸条挂上了吗(没挂 ⇒ 面板**一个都打不开**)
       touchButtons      画出几个按钮(0 = 手机上没有任何面板入口)
       lastTouchButton   最后按了哪个按钮(空 ⇒ 屏幕按钮这条路从没跑过)
       tapAttacks        轻点被判成攻击的次数(0 且一直 0 ⇒ 触屏攻击那条出口没通)
       uiPointerSuppressions  被 UI 吃掉、因而**没开摇杆**的指针数(>0 ⇒ 互斥真生效过)
       gestureSuppressed 抑制了哪几个原生手势(空 ⇒ 长按会弹菜单/选文本)
       ```
       ⚠️ 这些都取**生产变量**,不是脚本自己推断的(`lastTouchIntent` 是判定给的那句话)。 */
    touchBarMounted: touchBar.mounted,
    touchButtons: touchBar.buttonCount,
    touchButtonLabels: touchButtons().map((b) => b.label).join(''),
    lastTouchButton,
    lastTouchIntent,
    tapAttacks,
    uiPointerSuppressions,
    gestureSuppressed: [...SUPPRESSED_GESTURES],
    ackedSeq: predictor.lastAckedSeq,
    prunedCmds: predictor.prunedTotal,
    /* ★ 2026-11-15:动作入口也进自检口径。否则「按 N 到底发没发」只能靠肉眼看画面 ——
       而这正是本仓记过一整轮的静默形态(`status` 是一句话,`sent` 是计数,
       两者都由入口给出,**不是**截图脚本自己推断的)。 */
    actionStatus: actionEntry.status,
    actionSent: actionEntry.sentCount,
    actionKeys: entryKeyHints(),
    /* ★ 第十轮(WS-FND-138):四个新动作的入口也必须**读得出来** ——
       否则「按 1/2/3/4 到底发没发」又是只能靠肉眼看的静默形态。
       三个读数各有分工:`hotbarKeys` 是键位表本身(不是手抄的),
       `lastItemId` 是四个热键的**前置**(0 = 还没拿到任何物品),
       `lastSentAction` 是**真的发出过的那一条**的动作名。 */
    hotbarKeys: hotbarKeyHints(),
    lastItemId,
    lastSentAction: actionEntry.lastRequest?.action ?? null,
    /* ── ★ 第七轮审计 P1:朝向进自检口径 ──
     * 修前 `facing` 是写死的常量,而"格坐标"永远看起来正常 ⇒
     * 「Q 永远放脚下南侧」这件事**读不出来**。三个字段一起读:
     *   `facing`       当前朝向(本地输入优先,其次权威位移)
     *   `facingLabel`  人读的方向名
     *   `facingCell`   ▶ 现在按 Q/E 会作用于哪一格(与 `cellInFront(me, facing)` 同一个入口)
     */
    facing: { ...facing },
    facingLabel: facingLabel(facing),
    facingCell: cellInFront(predictor.pos, facing),
    /* ── ★ 第七轮审计 P2:`CRAFT` 的 `have` 到底有没有内容(死键的出口) ── */
    haveEntries: haveEntryCount(haveDetail),
    have: haveDetail,
    /* 搜索框里打字时动作键是否被挡掉(拉 `boot` 的 searchMode) */
    textInputActive: handle.textInputActive(),
  });
  /* ★ WS-FND-167:`main()` 跑到这里说明模块**真的**跑起来了 ⇒ 撤掉启动看门狗。
     不撤的话:8s 后它会因为"没见到 `__stageReady`"再显示一次致命错误(误报白屏)。
     ⚠️ `__stageReady` 已经赋值 ⇒ 就算漏撤,看门狗自己也会先 `return`(双保险)。 */
  if (window.__bootWatchdog !== undefined) {
    clearTimeout(window.__bootWatchdog);
    window.__bootWatchdog = undefined;
  }
  window.addEventListener('beforeunload', () => {
    detachInput();
    detachStick();
    stickUI.dispose();
    /* ★ WS-FND-166:触屏按钮条与手势抑制器也必须卸干净(否则第二次 `main()` 会叠加) */
    touchBar.dispose();
    detachGestures();
    /* ★ WS-FND-167:镜像面板的 DOM 也归零(节点与引用都不留)。 */
    a11y.dispose();
    clearInterval(inputLoop);
    session?.close();
    detachActionKeys();
    handle.dispose();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}