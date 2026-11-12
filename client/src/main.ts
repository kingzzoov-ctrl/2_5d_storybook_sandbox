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

declare global {
  interface Window {
    /** 供自检/截图脚本读取运行状态 */
    __stageReady?: () => Record<string, unknown>;
  }
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

  window.__stageReady = () => handle.summary();
  window.addEventListener('beforeunload', () => handle.dispose());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}