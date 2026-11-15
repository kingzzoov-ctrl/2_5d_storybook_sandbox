/**
 * `scripts/fps-probe.ts` —— **headless FPS 探针**(零新依赖)
 *
 * ## 它回答什么,以及它**不**回答什么
 *
 * 它回答:**在 headless Chrome 里,这个客户端每帧花多少时间、rAF 回路能跑多快。**
 * 它**不**回答「真机 FPS」—— 本机没有真机/手机,headless 没有 vsync,
 * 所以这里拿到的数字**不能**当作玩家手机上的帧率(见 `docs/MEASUREMENTS-S5.md` §1)。
 *
 * ```
 * node scripts/fps-probe.ts                      # 默认:Browser 自选的 GL(本机=硬件 ANGLE/D3D11)
 * node scripts/fps-probe.ts --gl=swiftshader     # 强制软件渲染(ANGLE+SwiftShader)
 * node scripts/fps-probe.ts --window-ms=8000     # 每个视口测 8 秒
 * node scripts/fps-probe.ts --json               # 只打印机器可读的那一行
 * ```
 * 退出码:`0` 全部有效 · `1` 渲染回路异常(数字无效)· `3` 缺前置(Chrome / vite)
 *
 * ## 为什么不用「截图 + 数帧」而是走 CDP
 *
 * `chrome --headless --screenshot` **只做一次加载 + 一次截图** —— 它没有时间轴,
 * 数不出帧率;而 `--virtual-time-budget` 会**快进虚拟时钟**,那时 `performance.now()`
 * 的差值与真实渲染无关(fps 会变成编出来的数)。
 * ⇒ 只有真跑一个窗口的**墙钟时间**才叫实测,所以本脚本用 CDP
 * (`Runtime.evaluate` + `requestAnimationFrame` 自计数)。
 *
 * ## 三条判据纪律(每条都有具体理由)
 *
 * 1 **两个独立读数**:页面自报的 `__stageReady().fps`(client 自己的窗口计数)
 *    + 本脚本注入的 rAF 自计数。两者不一致说明其中一条通路坏了。
 * 2 **必须有对照**:先在 `about:blank` 上测同一段窗口的 rAF 上限。
 *    若应用 fps ≈ 空页 fps,那这个数就是**浏览器调度上限**,不是渲染成本 ——
 *    脚本会把这条判读**打印出来**,不留给读者自己猜。
 * 3 **无效必须失败**:渲染回路死了(页面 `#fatal` 有文字 / `drawCalls===0` /
 *    CDP 收到 `Runtime.exceptionThrown`)时,本脚本**拒绝**给出数字(exit 1)。
 *    ⚠️ 这条是**实测逼出来的**:本仓正在被多个作业者同时改
 *    (`client/src/three/boot.ts` 有一次半成品状态),那次探针量到的
 *    「515 fps」其实是**空转页面的上限**(应用异常后 rAF 只剩本脚本自己) ——
 *    没有这条守卫就会把一个假数字写进文档。
 *
 * ## 零依赖说明
 *
 *  - WS 客户端用 Node 24 的**内建** `WebSocket`(不需要 `ws` 包);
 *  - HTTP 用内建 `fetch`;CDP 是纯 JSON over WS;
 *  - vite 用仓库已有的 devDependency(`node_modules/vite/bin/vite.js`),不新增依赖;
 *  - Chrome 用系统已安装的(可用 `CHROME_PATH` 指定);找不到就 exit 3,不静默降级。
 *  - 所有临时文件(Chrome profile)写在 `$PI_SCRATCH_DIR`(缺省 `os.tmpdir()`),
 *    **不往仓库里写任何文件**。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const argOf = (name: string): string | null => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
};
const numArg = (name: string, fallback: number): number => {
  const v = Number(argOf(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** GL 模式:`auto` = 让 Chrome 自己选(本机实测是硬件 ANGLE/D3D11);`swiftshader` = 强制软件渲染。 */
const GL_MODE = argOf('gl') === 'swiftshader' ? 'swiftshader' : 'auto';
const WINDOW_MS = numArg('window-ms', 4000);
const PORT = numArg('port', 5199);
const JSON_ONLY = argv.includes('--json');
/** 整脚本看门狗:任何一步卡住都不会让门禁挂死。 */
const WATCHDOG_MS = numArg('watchdog-ms', 240_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
function cleanup(): void {
  for (const c of children) {
    try { c.kill(); } catch { /* 已经退出 */ }
  }
}

/* ═══════════════════════════ 1. 前置:Chrome 与 vite ═══════════════════════════ */

function findChrome(): string | null {
  const env = process.env['CHROME_PATH'];
  if (env !== undefined && env !== '' && existsSync(env)) return env;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? '';
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  let last = 'no attempt';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时(${timeoutMs}ms),最后一次:${last}`);
}

/* ═══════════════════════════ 2. CDP 客户端(内建 WebSocket)═══════════════════════════ */

/** 连上页面 target,返回一个极小的 CDP 调用器。 */
async function openCdp(
  wsUrl: string,
  onException: () => void,
  onAtlasRequest: (requestId: string) => void,
): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => void;
}> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 0;

  ws.addEventListener('message', (ev: MessageEvent) => {
    const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
    const msg = JSON.parse(text) as Record<string, unknown>;
    const id = msg['id'];
    if (typeof id === 'number' && pending.has(id)) {
      const resolve = pending.get(id);
      pending.delete(id);
      if (resolve !== undefined) resolve(msg);
      return;
    }
    /* 事件:任何页面异常都记一笔 —— 它是「这次数字无效」的判据之一。 */
    const method = msg['method'];
    if (method === 'Runtime.exceptionThrown') onException();
    if (method === 'Fetch.requestPaused') {
      const params = (msg['params'] ?? {}) as Record<string, unknown>;
      const requestId = params['requestId'];
      if (typeof requestId === 'string') onAtlasRequest(requestId);
    }
  });

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });

  const send = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      nextId += 1;
      const myId = nextId;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params: params ?? {} }));
    });

  const evaluate = async (expression: string): Promise<unknown> => {
    const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const result = (msg['result'] ?? {}) as Record<string, unknown>;
    const details = result['exceptionDetails'];
    if (details !== undefined) {
      const d = details as Record<string, unknown>;
      throw new Error(`页面内求值抛错:${String(d['text'])} ${String(d['exception'])}`);
    }
    const inner = (result['result'] ?? {}) as Record<string, unknown>;
    return inner['value'];
  };

  await opened;
  return { send, evaluate, close: () => ws.close() };
}

/* ═══════════════════════════ 3. 测量 ═══════════════════════════ */

/** 注入一段 rAF 自计数:返回真实墙钟毫秒与帧数(独立于应用自己的 fps 计数器)。 */
async function measureRaf(
  evaluate: (expression: string) => Promise<unknown>,
  ms: number,
): Promise<{ ms: number; frames: number; fps: number }> {
  const expr = `(async () => {
    const r = await new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => {
        n += 1;
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(f);
        else res({ ms: performance.now() - t0, frames: n });
      };
      requestAnimationFrame(f);
    });
    return JSON.stringify(r);
  })()`;
  const raw = await evaluate(expr);
  const parsed = JSON.parse(String(raw)) as { ms: number; frames: number };
  return { ms: parsed.ms, frames: parsed.frames, fps: (parsed.frames * 1000) / parsed.ms };
}

/** 一段窗口的「主线程每帧成本」(Chrome 自己的 TaskDuration/ScriptDuration 计数差)。 */
async function measureWithCpu(
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  evaluate: (expression: string) => Promise<unknown>,
  ms: number,
): Promise<Record<string, unknown>> {
  const m0 = await perfMetrics(send);
  const raf = await measureRaf(evaluate, ms);
  const m1 = await perfMetrics(send);
  const n = raf.frames;
  const delta = (k: string): number => (m1[k] ?? 0) - (m0[k] ?? 0);
  return {
    windowMs: Math.round(raf.ms * 10) / 10,
    frames: n,
    fps: Math.round(raf.fps * 10) / 10,
    taskMsPerFrame: n > 0 ? Math.round(((delta('TaskDuration') * 1000) / n) * 1000) / 1000 : null,
    scriptMsPerFrame: n > 0 ? Math.round(((delta('ScriptDuration') * 1000) / n) * 1000) / 1000 : null,
    layoutMsPerFrame: n > 0 ? Math.round(((delta('LayoutDuration') * 1000) / n) * 1000) / 1000 : null,
  };
}

async function perfMetrics(
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, number>> {
  const msg = await send('Performance.getMetrics', {});
  const res = (msg['result'] ?? {}) as Record<string, unknown>;
  const list = (res['metrics'] ?? []) as { name: string; value: number }[];
  const out: Record<string, number> = {};
  for (const m of list) out[m.name] = m.value;
  return out;
}

function sha12(rel: string): string {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return 'missing';
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
}

/* ═══════════════════════════ 4. 主流程 ═══════════════════════════ */

async function main(): Promise<void> {
  const chromePath = findChrome();
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (chromePath === null) {
    console.log('SKIP:未找到 Chrome/Edge。设 CHROME_PATH 指向可执行文件后重跑(exit 3)。');
    process.exit(3);
  }
  if (!existsSync(viteBin)) {
    console.log(`SKIP:未找到 vite(${viteBin})—— 客户端 dev server 起不来(exit 3)。`);
    process.exit(3);
  }

  const tmpBase = process.env['PI_SCRATCH_DIR'] ?? tmpdir();
  const profile = mkdtempSync(join(tmpBase, 'fps-probe-'));
  const atlasPath = join(ROOT, 'assets', 'atlas_sprites.png');
  const atlasB64 = existsSync(atlasPath) ? readFileSync(atlasPath).toString('base64') : null;
  let atlasHits = 0;
  let exceptions = 0;
  let chrome: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let viteOut = '';
  /** vite 的退出状态(code/signal)。`null` = 仍在跑;非 null 且服务未就绪 ⇒ 立刻 throw。 */
  let viteExit: string | null = null;

  const watchdog = setTimeout(() => {
    console.error(`看门狗超时(${WATCHDOG_MS}ms)—— 清理并退出(exit 2)。`);
    cleanup();
    rmSync(profile, { recursive: true, force: true });
    process.exit(2);
  }, WATCHDOG_MS);

  try {
    /* ── 4.1 vite dev server(客户端 dev server,root = client/)── */
    vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(vite);
    vite.stdout?.on('data', (d: Buffer) => { viteOut += d.toString(); });
    vite.stderr?.on('data', (d: Buffer) => { viteOut += d.toString(); });
    /* ★ 子进程**可能起不来或崩掉**(端口被占、依赖坏)。空输出**不能**当成正常:
       这里把 exit code / signal 记下来,并在 HTTP 等待失败时**直接 throw** ——
       否则一次崩溃会退化成「等 60 秒超时」,而超时的原因只能靠猜。 */
    vite.on('error', (e: Error) => { viteExit = `spawn error: ${e.message}`; });
    vite.on('exit', (code: number | null, signal: string | null) => {
      viteExit = `exit code=${String(code)} signal=${String(signal)}`;
    });
    try {
      await waitForHttp(`http://127.0.0.1:${PORT}/`, 60_000);
    } catch (e) {
      /* 把子进程的真实下场并进错误里 —— 否则「为什么没起来」只能靠猜。 */
      throw new Error(`${e instanceof Error ? e.message : String(e)}`
        + ` · vite:${viteExit ?? '仍在运行(但没在监听)'} · 输出尾部:${viteOut.slice(-400)}`);
    }

    /* ── 4.2 Chrome(先停 about:blank,再经 CDP 导航 —— 这样图集拦截一定来得及开)── */
    const glFlags = GL_MODE === 'swiftshader'
      ? ['--use-angle=swiftshader', '--use-gl=angle']
      : [];
    chrome = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      /* headless 里 WebGL 需要显式允许软件渲染后端;硬件可用时 Chrome 仍会优先用硬件。 */
      '--enable-unsafe-swiftshader',
      ...glFlags,
      '--window-size=1280,720',
      '--hide-scrollbars',
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(chrome);
    let chromeErr = '';
    chrome.stderr?.on('data', (d: Buffer) => { chromeErr = (chromeErr + d.toString()).slice(-2000); });

    const portFile = join(profile, 'DevToolsActivePort');
    const tPort = Date.now();
    while (!existsSync(portFile) && Date.now() - tPort < 30_000) await sleep(100);
    if (!existsSync(portFile)) throw new Error(`Chrome 未写出 DevToolsActivePort;stderr 尾部:${chromeErr}`);
    const devPort = readFileSync(portFile, 'utf8').split('\n')[0] ?? '';
    const targetsRaw = await waitForHttp(`http://127.0.0.1:${devPort}/json/list`, 20_000);
    const targets = JSON.parse(targetsRaw) as { type: string; webSocketDebuggerUrl: string; url: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (page === undefined) throw new Error('CDP 里没有 page target');

    /* ── 4.3 CDP:把图集请求就地补上(dev root=client/,`atlas_sprites.png` 在仓库根的 assets/)──
       `boot.ts` 的 ATLAS_URL 是**相对页面**的 'atlas_sprites.png',dev 下必然 404。
       这里用 CDP Fetch 域把它替换成真文件,让被测场景**包含 4 个立牌**
       —— 否则量到的是一个缺了立牌的场景,与产物(distant client/ 里有图集)不是同一个东西。 */
    const cdp = await openCdp(
      page.webSocketDebuggerUrl,
      () => { exceptions += 1; },
      (requestId: string) => {
        atlasHits += 1;
        if (atlasB64 === null) {
          void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
          return;
        }
        void cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'image/png' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: atlasB64,
        });
      },
    );

    await cdp.send('Runtime.enable', {});
    await cdp.send('Page.enable', {});
    await cdp.send('Performance.enable', {});
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*atlas_sprites.png*', requestStage: 'Request' }],
    });

    /* ── 4.4 对照:空页(about:blank)的 rAF 上限 ── */
    await sleep(500);
    const control = await measureWithCpu(cdp.send, cdp.evaluate, WINDOW_MS);

    /* ── 4.5 导航到客户端并等舞台就绪 ── */
    const url = `http://127.0.0.1:${PORT}/?server=off`;
    await cdp.send('Page.navigate', { url });
    const tReady = Date.now();
    let readyKind = '';
    while (Date.now() - tReady < 60_000) {
      readyKind = String(await cdp.evaluate('typeof window.__stageReady'));
      if (readyKind === 'function') break;
      await sleep(300);
    }
    const fatalText = String(await cdp.evaluate(
      '(document.getElementById("fatal") && document.getElementById("fatal").textContent) || ""',
    ));

    const scene = JSON.parse(String(await cdp.evaluate(
      'JSON.stringify(window.__stageReady ? window.__stageReady() : null)',
    ))) as Record<string, unknown> | null;
    if (readyKind !== 'function' || scene === null) {
      throw new Error(`舞台未就绪(typeof __stageReady = ${readyKind})·#fatal = ${JSON.stringify(fatalText)}`
        + ` · vite 尾部:${viteOut.slice(-300)}`);
    }
    /* 预热:第一次量之前先让它跑 2 秒,避开「首帧建面 + 纹理上传」的暂态。 */
    await sleep(2000);

    const sceneBefore = JSON.parse(String(await cdp.evaluate('JSON.stringify(window.__stageReady())'))) as
      Record<string, unknown>;

    /* ── 4.6 两个视口各量一段 ── */
    const desktop = await measureWithCpu(cdp.send, cdp.evaluate, WINDOW_MS);
    const desktopApp = JSON.parse(String(await cdp.evaluate('JSON.stringify(window.__stageReady())'))) as
      Record<string, unknown>;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await sleep(1500);
    const phone = await measureWithCpu(cdp.send, cdp.evaluate, WINDOW_MS);
    const phoneApp = JSON.parse(String(await cdp.evaluate('JSON.stringify(window.__stageReady())'))) as
      Record<string, unknown>;
    const phoneViewport = phoneApp['viewport'];
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    const glInfo = JSON.parse(String(await cdp.evaluate(`(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return JSON.stringify({ webgl: false });
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return JSON.stringify({
        webgl: true,
        version: String(g.getParameter(g.VERSION)),
        unmaskedVendor: dbg ? String(g.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
        unmaskedRenderer: dbg ? String(g.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      });
    })()`))) as Record<string, unknown>;

    cdp.close();

    /* ── 4.7 有效性判据(无效 ⇒ 不报数字)── */
    const drawCalls = Number(sceneBefore['drawCalls'] ?? 0);
    const appFpsDesktop = Number(desktopApp['fps'] ?? 0);
    const invalidReasons: string[] = [];
    if (fatalText !== '') invalidReasons.push(`页面 #fatal 非空:${fatalText.slice(0, 200)}`);
    if (exceptions > 0) invalidReasons.push(`CDP 收到 ${exceptions} 次 Runtime.exceptionThrown`);
    if (drawCalls === 0) invalidReasons.push('drawCalls = 0(渲染回路没在画)');
    if (appFpsDesktop === 0) invalidReasons.push('应用自报 fps = 0(计数窗口没走到)');
    if (desktop['frames'] === 0) invalidReasons.push('对照窗口 0 帧');

    const report = {
      probe: 'headless-chrome-fps',
      isRealDevice: false,
      glMode: GL_MODE,
      chrome: chromePath,
      url,
      windowMs: WINDOW_MS,
      renderer: glInfo['unmaskedRenderer'] ?? null,
      rendererVendor: glInfo['unmaskedVendor'] ?? null,
      webgl: glInfo['webgl'] === true,
      atlasIntercepted: atlasHits,
      scene: {
        cells: sceneBefore['cells'],
        chunks: sceneBefore['chunks'],
        verts: sceneBefore['verts'],
        faces: sceneBefore['faces'],
        drawCalls: sceneBefore['drawCalls'],
        triangles: sceneBefore['triangles'],
        buildMs: sceneBefore['buildMs'],
        atlasOk: sceneBefore['atlasOk'],
        spriteCount: sceneBefore['spriteCount'],
        viewport: sceneBefore['viewport'],
      },
      measuredRevision: {
        'client/src/three/boot.ts': sha12('client/src/three/boot.ts'),
        'client/src/main.ts': sha12('client/src/main.ts'),
        'client/index.html': sha12('client/index.html'),
        'vite.config.ts': sha12('vite.config.ts'),
      },
      controlAboutBlank: control,
      desktop: { ...desktop, appFps: appFpsDesktop, viewport: desktopApp['viewport'] },
      phone: { ...phone, appFps: Number(phoneApp['fps'] ?? 0), viewport: phoneViewport },
      exceptions,
      fatal: fatalText,
      valid: invalidReasons.length === 0,
      invalidReasons,
    };

    if (invalidReasons.length > 0) {
      console.error('✗ 测量无效 —— 拒绝给出 FPS 数字(exit 1):');
      for (const r of invalidReasons) console.error(`   · ${r}`);
      console.error(`FP_JSON ${JSON.stringify(report)}`);
      clearTimeout(watchdog);
      process.exit(1);
    }

    if (!JSON_ONLY) {
      const appFps = Number(report.desktop.appFps);
      const ctlFps = Number((control as Record<string, unknown>)['fps']);
      const atCeiling = appFps >= ctlFps * 0.95;
      console.log('══ headless FPS 探针(★ 这不是真机 FPS)══');
      console.log(`  命令        node scripts/fps-probe.ts${GL_MODE === 'swiftshader' ? ' --gl=swiftshader' : ''} --window-ms=${WINDOW_MS}`);
      console.log(`  Chrome      ${chromePath}`);
      console.log(`  vite        ${viteBin} (dev server,root=client/)`);
      console.log(`  URL         ${url}`);
      console.log(`  WebGL 渲染器 ${String(report.renderer)}`);
      console.log(`               vendor=${String(report.rendererVendor)}`);
      console.log(`  被测修订     boot.ts=${report.measuredRevision['client/src/three/boot.ts']}`
        + ` main.ts=${report.measuredRevision['client/src/main.ts']}`
        + ` index.html=${report.measuredRevision['client/index.html']}`);
      console.log(`  场景        ${JSON.stringify(report.scene)}`);
      console.log(`  图集拦截    ${String(atlasHits)} 次(dev 下 atlas_sprites.png 必然 404,已用 CDP 就地补上)`);
      console.log('  ────────────────────────────────────────────────');
      console.log(`  [对照] about:blank   ${control['frames']} 帧 / ${control['windowMs']}ms`
        + ` = ${String(control['fps'])} fps · 主线程 ${String(control['taskMsPerFrame'])} ms/帧`);
      console.log(`  [桌面] ${JSON.stringify(report.desktop.viewport)}   ${desktop['frames']} 帧 / ${desktop['windowMs']}ms`
        + ` = ${String(desktop['fps'])} fps · 主线程 ${String(desktop['taskMsPerFrame'])} ms/帧`
        + ` · 脚本 ${String(desktop['scriptMsPerFrame'])} ms/帧 · 应用自报 fps=${String(report.desktop.appFps)}`);
      console.log(`  [手机] ${JSON.stringify(report.phone.viewport)}(DPR3)   ${phone['frames']} 帧 / ${phone['windowMs']}ms`
        + ` = ${String(phone['fps'])} fps · 主线程 ${String(phone['taskMsPerFrame'])} ms/帧`
        + ` · 脚本 ${String(phone['scriptMsPerFrame'])} ms/帧 · 应用自报 fps=${String(report.phone.appFps)}`);
      console.log('  ────────────────────────────────────────────────');
      console.log(atCeiling
        ? `  ⚠️ 应用 fps(${appFps}) ≈ 空页 rAF 上限(${ctlFps}) ⇒ 这个数字是**浏览器调度上限**,`
          + `\n     不是渲染成本 —— 它只能说明「每帧的主线程工作是 ${String(desktop['taskMsPerFrame'])} ms」。`
        : `  ✓ 应用 fps(${appFps}) < 空页上限(${ctlFps}) ⇒ 该 GL 模式下受渲染成本限制`
          + `(每帧主线程 ${String(desktop['taskMsPerFrame'])} ms)。`);
      console.log('  结论口径    本数字来自 headless Chrome,★ 不是真机 FPS ——'
        + ' 真机未测,原因见 docs/MEASUREMENTS-S5.md §1');
    }
    console.log(`FP_JSON ${JSON.stringify(report)}`);
    clearTimeout(watchdog);
    process.exit(0);
  } finally {
    cleanup();
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(`✗ fps-probe 失败:${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  cleanup();
  process.exit(2);
});
