/**
 * ★ **一键开始玩**(2026-11-14)。
 *
 * ```
 * npm run play          # 想换端口:node scripts/play.ts --port 9001
 * ```
 *
 * ## 它做了什么
 *
 * ```
 * 1 装配**真实世界**:`assemble({ sizeCells, mobs: true })` ⇒ RoomRuntime + WorldSim
 * 2 起 WS 服务端:startWsServer({ room }) —— 20Hz。房间的 step() 会推进世界
 *   (`room.ts` 里 task-59 接的 advance(1));世界会跑、怪会动
 * 3 起客户端 dev server(vite)并打印**可直接打开的地址**
 *   **已经有生物**:生物是按配表密度逐只刷的,第一只约 13 秒才来。实测:
 *   预热 1200 帧(60 秒)⇒ 3 只;默认取 2400 帧(120 秒)⇒ 更多。
 *   **已经有生物**:生物是按配表密度逐只刷的,第一只约 13 秒才来
 * ```
 *
 * ## 为什么必须用 `assemble()` 而不是 `ws_demo.ts`
 *
 * `server/src/sim/ws_demo.ts --serve` 是**传输演示**:它的 host 是存根,
 * `attackMobAuthorized` 直接返回 `{ ok: false, reason: 'demo 无战斗' }`、世界里没有怪。
 * ⇒ 用它「能连上、能看到别人在动」,但**打不了、盖不了** —— 不是能玩的世界。
 * 本文件用生产装配路径(`createHost` → `WorldSim`),所以：
 * ```
 * 怪真的会被**刷出来**(2026-11-14 修:此前刷怪 tick 只计数不造怪,且
 *   `upsertWildlife()` 全仓无人调用 ⇒ 世界里 0 只、快照里恒 `wildlife: []`)
 * 攻击真的结算(RoomRuntime.applyAttack → host.attackMobAuthorized)
 * 房间真的推世界(step → host.advance(1))
 * ```
 *
 * ## 它**不**做的事(以及为什么)
 *
 * ```
 * 不做构建:开发用 vite dev(秒级热更),发布用 `npm run build:client`(产物在 dist/)
 * 不做鉴权:本地单人/联机试玩,`?server=` 指哪连哪 —— 这不是部署脚本
 * 不做"登录":userId 由 URL/hello 决定(见 ws_server 的契约 §12.2)
 * ```
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from '../server/src/index.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};

const WS_PORT = numArg('port', 8791);
const WEB_PORT = numArg('web-port', 5173);
/** 世界边长(格)。96 足够走一圈看到地形、怪与屋顶;**再大会拖慢首帧建面**。 */
const WORLD_CELLS = numArg('size', 96);

const log = (m: string): void => { console.log(`  [play] ${m}`); };

async function main(): Promise<void> {
  /* ── 1 真实世界 + 房间 ── */
  log(`装配世界(${WORLD_CELLS}×${WORLD_CELLS},带怪)…`);
  const assembled = assemble({
    roomId: 'play',
    ownerId: 'u_host',
    sizeCells: WORLD_CELLS,
    mobs: true,
  });

  /* ── 1b 预热世界(★ 2026-11-14)──
     生物是按**配表速率**逐只刷出来的(慢帧 2Hz × `BIOME_SPAWN.perChunk`),
     第一只约 13 秒世界时间 ⇒ 不预热的话你打开浏览器看到的是**空世界**,
     很容易误判成"怪又没生效"。
     ⇒ 让世界在你连上之前先跑一会儿 —— 真实的服务器本来就是这样(开机起就在跑)。
     ⚠️ 预热推进的是**同一条刷怪路径**(同样的安全区/上限/群系规则),
        不是在开局"摆"几只:去掉预热,世界只是空一会儿,规则不变。 */
  const warmup = numArg('warmup', 1200);
  const warmT0 = Date.now();
  for (let i = 0; i < warmup; i += 1) assembled.runtime.step(null);
  const mobs = assembled.host.listWildlife();
  log(`预热 ${warmup} 帧(${(warmup / 20).toFixed(0)} 秒世界时间,耗时 ${Date.now() - warmT0}ms)`
    + ` ⇒ 世界里有 ${mobs.length} 只生物`
    + (mobs.length === 0 ? '  ⚠️ 一只都没有(若 --size 小到整图都在安全区里,就会是 0)' : ''));
  if (mobs.length > 0) {
    log('  ' + mobs.slice(0, 8).map((m) => `${m.mobId}(${m.hp}/${m.maxHp})`).join(' · ')
      + (mobs.length > 8 ? ` … 共 ${mobs.length} 只` : ''));
  }
  log(`房间 ${assembled.runtime.id} 就绪;host=${assembled.host === null ? 'null(异常)' : '已装配'}`);

  /* ── 2 WS 服务端(20Hz;room.step 推进世界) ── */
  const srv = await startWsServer({
    port: WS_PORT,
    room: assembled.runtime as never,
    frameMs: 20,
    onLog: (m) => { if (process.env['PLAY_VERBOSE'] === '1') log(`[ws] ${m}`); },
  });
  log(`WS 服务端:ws://127.0.0.1:${srv.port}/ws`);

  /* ── 3 客户端 dev server ── */
  const webUrl = `http://localhost:${WEB_PORT}/`;
  const playUrl = `${webUrl}?server=${encodeURIComponent(`ws://127.0.0.1:${srv.port}/ws`)}`;
  let web: ReturnType<typeof spawn> | null = null;
  if (existsSync(join(ROOT, 'node_modules', 'vite'))) {
    web = spawn('npm', ['run', 'dev:client', '--', '--port', String(WEB_PORT)], {
      cwd: ROOT, shell: true, stdio: 'inherit',
    });
  } else {
    log('⚠️ 未装 vite(devDependencies)⇒ 只起了服务端。装好后重跑,或用 `npm run build:client` 的产物。');
  }

  console.log('');
  console.log('  ══════════════════════════════════════════════');
  console.log('   开始玩 —— 浏览器打开:');
  console.log(`     ${playUrl}`);
  console.log('');
  console.log(`   (客户端已默认连 ws://<当前主机>:${srv.port}/ws,直接开 ${webUrl} 也行)`);
  console.log(`   操作:WASD/方向键 移动 · 鼠标左键 或 空格 攻击最近的怪`);
  console.log('  ══════════════════════════════════════════════');
  console.log('');

  const shutdown = (): void => {
    log('正在关闭…');
    try { web?.kill(); } catch { /* 已退出 */ }
    void srv.close();
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(`  [play] 启动失败:${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
