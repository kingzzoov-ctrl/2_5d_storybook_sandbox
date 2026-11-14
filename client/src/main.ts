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
import { InputSource, attachKeyboard } from './net/input.ts';
import { LocalPredictor } from './net/predictor.ts';
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
  return q !== null && q !== '' ? q : null;
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
      },
    });
  }

  /* WASD → InputCmd → 本地预测 → 上行(2026-11-14,task-83 选乙)。
     固定 20Hz:`predictStep` 的位移是 `v_max * DT`,而 DT 是服务端权威常数 ——
     跟着渲染帧走会让 60Hz 与 30Hz 的机器角色速度不同,且不报错。
     ⚠️ 相机仍是临时态:WASD **同时**在平移相机(`three/boot.ts` 的 `pan`),
     于是角色不会走出画面 —— 但那是**巧合**成立的,不是「相机跟随」。
     让相机跟随权威位置要动渲染路径,其验收只能靠看 ⇒ 单独一件,不在本轮。 */
  const input = new InputSource();
  const detachInput = attachKeyboard(window, input);
  const predictor = new LocalPredictor();
  let localTick = 0;
  let seeded = false;
  const inputLoop: ReturnType<typeof setInterval> = setInterval(() => {
    const cmd = input.nextCmd();
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
    if (session !== null) {
      session.sendMove({ tick: localTick, x: p.x, y: p.y, z: p.z });
    }
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
  });
  window.addEventListener('beforeunload', () => {
    detachInput();
    clearInterval(inputLoop);
    session?.close();
    handle.dispose();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}