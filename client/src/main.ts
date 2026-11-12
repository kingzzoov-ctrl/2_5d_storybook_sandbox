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
          console.info(`[session] 已加入房间 ${w.roomId}(玩家 ${w.playerId})`);
        },
      },
    });
  }

  window.__stageReady = () => ({
    ...handle.summary(),
    /* 联机状态也进自检口径 —— 否则「连没连上」只能靠看控制台 */
    sessionState: session?.state ?? 'offline',
    serverContentClaim: session?.serverContentClaim ?? null,
  });
  window.addEventListener('beforeunload', () => {
    session?.close();
    handle.dispose();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}