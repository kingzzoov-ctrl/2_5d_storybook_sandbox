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
import { createSession, type SessionHandle } from './net/session.ts';
import {
  ACTION_KEYS, cellInFront, cellUnder, describeActionResult, keyHints, type Facing,
} from './net/action_target.ts';
/* ★ 2026-11-15:动作入口层(合成 / 睡觉 / 开箱 / 派对开局)。
   纯逻辑在 `net/action_entry.ts`(0 import、可单测),键位薄绑定在 `net/action_binding.ts`;
   本文件只做**装配根**:把真 `SessionHandle` 注进端口,再挂到 `window`。 */
import { ActionEntry } from './net/action_entry.ts';
import { createActionBinding, entryKeyHints, sessionPorts } from './net/action_binding.ts';
import { InputSource, attachKeyboard } from './net/input.ts';
import { LocalPredictor } from './net/predictor.ts';
/* ★ 2026-11-16(D-08 第一步):虚拟摇杆的**判定**住在这里(零 DOM、可单测)。
   `main.ts` 只把触屏指针喂进去 —— 判定留在事件回调里就没人测得到。 */
import {
  AnalogStick, JOYSTICK_DEAD_ZONE, STICK_RADIUS_PX, mergeCmd,
} from './net/joystick.ts';
import { telegraphCenterOf } from './net/telegraph_center.ts';
import { DT } from '../../shared/types/physics.ts';

declare global {
  interface Window {
    /** 供自检/截图脚本读取运行状态 */
    __stageReady?: () => Record<string, unknown>;
  }
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
    /* 启动失败直接把错误显示出来 —— headless 截图能拍到,
       避免「白屏但控制台里其实有异常」这种查不出来的情况。 */
    const el = document.getElementById('fatal');
    if (el) {
      el.style.display = 'block';
      el.textContent = `启动失败:\n${(e as Error).stack ?? String(e)}`;
    }
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
  let lastAction = `按 ${keyHints()} —— 动作入口 ${entryKeyHints()}`;
  let lastItemId = 0;
  const facing: Facing = { dx: 0, dy: 1 };

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
         `have`(背包明细)客户端**拿不到** —— 快照里只有总量、没有明细
         (见 `action_entry.ts` 的 `craftRequest`)。这里如实给 `undefined`
         ⇒ 入口会**不发**并给出可读原因,而不是发一条注定被拒的报文。 */
      craft: () => ({ itemId: lastItemId, have: undefined }),
      /* 开箱:取**脚下**那格 —— 箱子是地面实体,站着就能开。 */
      chestCell: () => {
        const me = handle.store.state.players.find((p) => p.id === handle.store.localPlayerId);
        return me === undefined ? { x: undefined, y: undefined } : cellUnder(me);
      },
      /* 派对模式回声:**不给**。`meta.partyMode` 是**下标**(1=BRIDGE_CTF...),
         而服务端 `start_party.ts` 拿它跟**模式名**比(`String(declared) !== String(mode)`)
         ⇒ 回声一个下标会被判"不一致"。模式词表的唯一出处是服务端,客户端不另写一份
         ⇒ 不知道就**不声称**(省略这个键 = 不核对)。 */
      partyModeEcho: () => undefined,
    },
  });
  /* 键位:薄绑定。`window` 满足结构化目标 `KeyEventTarget`,不需要 jsdom 也照样能驱动。 */
  const detachActionKeys = actionBinding.attachKeyboard(window);

  if (url !== null) {
    session = createSession({
      url,
      /* ★ 复用 boot 的 store —— 别让两个 store 各写各的(见上) */
      store: handle.store,
      events: {
        /* 帧到达:渲染循环自己在读 `handle.store`,这里**不需要**触发重画。
           只把"坏包/空帧"留痕,便于自检脚本读。 */
        onFrame: () => { /* 渲染循环每帧自读 store */ },
        onState: (s, detail) => {
          if (s === 'failed') console.warn('[session] 失败:', detail);
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
        },
      },
    });
  }

  /* WASD → InputCmd → 本地预测 → 上行(2026-11-14,task-83 选乙)。
     固定 20Hz:`predictStep` 的位移是 `v_max * DT`,而 DT 是服务端权威常数 ——
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

  /**
   * 最近的怪 —— 从**权威快照**取(`store.state.wildlife`)。
   * ⚠️ 客户端不自己维护怪列表:那是服务端的事,两份列表迟早分叉。
   */
  const nearestWildlife = (from: { x: number; y: number }):
    { mobId: string; hp: number; maxHp: number; d: number } | null => {
    let best: { mobId: string; hp: number; maxHp: number; d: number } | null = null;
    for (const w of handle.store.state.wildlife) {
      const d = Math.hypot(w.x - from.x, w.y - from.y);
      if (best === null || d < best.d) best = { mobId: w.mobId, hp: w.hp, maxHp: w.maxHp, d };
    }
    return best;
  };

  /** 左键 / 空格:打**最近**那只(距离与伤害都由服务端判,客户端只给目标)。 */
  const attackNearest = (): void => {
    if (session === null) { lastHit = '未联机,打不了'; return; }
    const w = nearestWildlife(predictor.pos);
    if (w === null) { lastHit = '附近没有怪'; return; }
    session.sendAttack({ mobId: w.mobId });
    lastHit = `已发攻击 → ${w.mobId}(${w.d.toFixed(1)} 格)`;
  };
  window.addEventListener('mousedown', (ev) => { if (ev.button === 0) attackNearest(); });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' || ev.code === 'Space') { ev.preventDefault(); attackNearest(); }
  });

  /** 每 tick 刷一次状态条(连接态不是 live 时变黄 —— 一眼能看出「没连上」)。 */
  const paintStatus = (
    pos: { x: number; y: number },
    near: { mobId: string; hp: number; maxHp: number; d: number } | null,
  ): void => {
    if (statusEl === null) return;
    const st = session?.state ?? 'offline';
    statusEl.textContent = [
      `连接 ${st}`,
      `坐标 ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}`,
      near === null
        ? '附近 无怪'
        : `最近 ${near.mobId} hp ${near.hp.toFixed(0)}/${near.maxHp.toFixed(0)} (${near.d.toFixed(1)}格)`,
      lastHit,
      /* 动作那两行:回执文案(分类不同话不同)+ 最近碰过的物品。
         背包**明细**不在快照里(只有服务端有)⇒ 这里不编一个数字出来。 */
      lastAction,
      /* ★ 2026-11-15:五个新动作(合成/睡觉/开箱/派对开局)那一行。
         它由**入口**给出:发出去时是"合成 → 已发 (itemId=151)",
         被拒时是"开公共箱 ✗ 你没有这个权限"(四条失败分类四句话)。
         ⇒ 玩家第一次能分清"我按错了"与"服务端不让我做"。 */
      actionEntry.status,
      lastItemId === 0 ? '最近物品 (还没有)' : `最近物品 ${lastItemId}`,
    ].join('\n');
    statusEl.classList.toggle('bad', st !== 'live');
  };
  /* ── 动作键位(2026-11-14 第二轮):让「建造 / 拆掉 / 丢下 / 捡起」在浏览器里真的能按 ──

     ⚠️ 目标格的判定**不在**这里:它住在 `net/action_target.ts`(纯函数、有断言,
        见 `tests/WS-FND-22`)。本文件只做"读键 → 调它 → 发报文 → 显示回执"。
        ——判定留在不可测的入口里,就是本仓反复记的那种"改坏了没人知道"。 */
  window.addEventListener('keydown', (ev) => {
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
      lastAction = `${spec.label} ✗ 先按 E 拆一块或按 F 捡一件`;
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
    lastAction = `${spec.label} → 格(${cell.x},${cell.y})`;
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
  let stickPointerId: number | null = null;
  const onStickDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse') return;
    if (stickPointerId !== null) return; /* 只跟第一根手指:第二根按下不该改方向 */
    stickPointerId = ev.pointerId;
    stick.begin(ev.clientX, ev.clientY);
  };
  const onStickMove = (ev: PointerEvent): void => {
    if (stickPointerId !== ev.pointerId) return;
    stick.moveTo(ev.clientX, ev.clientY);
  };
  /* `pointercancel` 与 `pointerup` **同一处理**:系统手势 / 来电会发 cancel,
     漏了它的表现是「角色一直朝最后方向走」(与 `input.clear()` 失焦那个病同形)。 */
  const onStickEnd = (ev: PointerEvent): void => {
    if (stickPointerId !== ev.pointerId) return;
    stickPointerId = null;
    stick.end();
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
  };

  const predictor = new LocalPredictor();
  let localTick = 0;
  let seeded = false;
  const inputLoop: ReturnType<typeof setInterval> = setInterval(() => {
    /* 摇杆推了就用摇杆,否则回落到 WASD —— 优先级只写在这一处(`mergeCmd`)。 */
    const cmd = mergeCmd(input.nextCmd(), stick.vector());
    const p = predictor.step(cmd);
    localTick += 1;
    /* 权威姿态喂回预测器。第一次先**播种** —— 预测器必须从权威值起步,
       否则它从 (0,0) 出发一路追,表现是「角色从世界原点滑过来」。 */
    const pose = playerId === null ? null : telegraphCenterOf(handle.store.state, playerId);
    if (pose !== null) {
      if (!seeded) {
        predictor.reset({ x: pose.cx, y: pose.cy, z: 0 });
        seeded = true;
      } else {
        predictor.onAuthoritative({ x: pose.cx, y: pose.cy, z: 0 });
      }
    }
    predictor.absorbVisual(DT);
    /* ⚠️ `?server=off` ⇒ `session === null` ⇒ **不发包**(单机/截图自检靠这条:
       没连上却每 tick 调 `sendMove`,表现是控制台刷"还没连上"而画面不动)。 */
    if (session !== null) {
      session.sendMove({ tick: localTick, x: p.x, y: p.y, z: p.z });
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
    paintStatus(p, near);
  }, DT * 1000);

  window.__stageReady = () => ({
    ...handle.summary(),
    /* 联机状态也进自检口径 —— 否则「连没连上」只能靠看控制台 */
    sessionState: session?.state ?? 'offline',
    serverContentClaim: session?.serverContentClaim ?? null,
    /* ★ 2026-11-14(task-83 选乙):预测链路也进自检口径 —— */
    /* 否则「输入有没有真的产生命令」只能靠看控制台,而那正是它静默一整轮的原因。 */
    inputKeys: input.pressedCount,
    predictedPos: predictor.pos,
    pendingCmds: predictor.pendingCount,
    lastReconcileAction: predictor.lastReconcile?.action ?? null,
    /* ★ 2026-11-16(D-08):摇杆与 `ackedSeq` 也进自检口径 ——
       「摇杆推了到底有没有产生方向」「剪枝到底跑没跑」都必须是**读得出来的数**,
       否则它们只会是代码里一行"看起来接上了"。 */
    stickActive: stick.active,
    stickMagnitude: stick.vector().magnitude,
    joystickDeadZone: JOYSTICK_DEAD_ZONE,
    ackedSeq: predictor.lastAckedSeq,
    prunedCmds: predictor.prunedTotal,
    /* ★ 2026-11-15:动作入口也进自检口径。否则「按 N 到底发没发」只能靠肉眼看画面 ——
       而这正是本仓记过一整轮的静默形态(`status` 是一句话,`sent` 是计数,
       两者都由入口给出,**不是**截图脚本自己推断的)。 */
    actionStatus: actionEntry.status,
    actionSent: actionEntry.sentCount,
    actionKeys: entryKeyHints(),
  });
  window.addEventListener('beforeunload', () => {
    detachInput();
    detachStick();
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