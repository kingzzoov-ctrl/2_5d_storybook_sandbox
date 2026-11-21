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
 * 2 起 WS 服务端:startWsServer({ room }) —— 32Hz。房间的 step() 会推进世界
 *   (`room.ts` 里 task-59 接的 advance(1));世界会跑、怪会动
 * 3 起客户端 dev server(vite)并打印**可直接打开的地址**
 *   **已经有生物**:生物是按配表密度逐只刷的,第一只约 13 秒才来。实测:
 *   预热 1200 帧(37.5 秒)⇒ 3 只;默认取 2400 帧(75 秒)⇒ 更多。
 *   **已经有生物**:生物是按配表密度逐只刷的,第一只约 13 秒才来
 *   └ ★ **D-26(时间口径)**:启动 5 秒后打印**实测节拍**(tick 间隔 / 实际 fps /
 *     世界钟×墙钟倍率)。世界时间 = `帧数 × DT`,**不读挂钟** ⇒
 *     **「1200 游戏秒」不等于「1200 墙钟秒」**(本机实测 62.77ms/帧 ⇒ 倍率 32 / 15.93 = 2.0088)。
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
 *
 * ## 存档(★ 2026-11-20 owner 裁定:像 Minecraft 一样自动保存)
 *
 * ```
 * 默认    ./.data/world.db   ← 文件库;`--db <path>` 换路径
 *         ⇒ 房间自动存档:30 秒周期 + 玩家离场 + 房间销毁 + 世界重置(见 net/room.ts)
 * --memory 显式内存模式      ← 不落盘,退出即丢(「只看一眼」的试玩用)
 * ```
 * **没有**手动 `SAVE` / `LOAD` 动作 —— 存的就是同一个世界:库在,重启接着玩;
 * 关掉进程时库里留的是**最后一次自动存档**(本脚本在 `SIGINT` 时会额外存一次)。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DB_PATH, assemble } from '../server/src/index.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';

import { DT } from '../shared/types/physics.ts';

/* ★ 2026-11-25(tick 口径硬化):WS 广播循环的帧间隔**不再写死**(旧值取自旧的
   tick 率)。它就该是**标称帧长**(`1000 / TICK_HZ` = `DT × 1000` = 31.25ms),
   而 `NOMINAL_TICK_MS` 是 `soak.ts` 里唯一的那个派生量(那边已有一份实现,
   这里再写一个数就是"两处各写一份")。 */
import { NOMINAL_TICK_MS, formatTickRateLine, tickRateOf, type TickRate } from './soak.ts';

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

/* ── 存档目标(★ 2026-11-20 owner 裁定:自动保存)──
   `--memory` = 显式内存模式:`--db` 与默认路径都不生效,进程退出即丢。
   为什么用**显式开关**而不是「路径为空就不存」:后者会让「忘了配」与
   「我不要存」在行为上完全一样,而这正是 owner 要消灭的那种静默。 */
const MEMORY_MODE = argv.includes('--memory');
const DB_FLAG_AT = argv.indexOf('--db');
const DB_PATH = DB_FLAG_AT >= 0 ? (argv[DB_FLAG_AT + 1] ?? '') : '';
/** 落盘目标(内存模式下为 `null`,永不打开)。 */
const DB_TARGET: string | null = MEMORY_MODE ? null : (DB_PATH !== '' ? DB_PATH : DEFAULT_DB_PATH);

const log = (m: string): void => { console.log(`  [play] ${m}`); };

/**
 * 实测节拍探针(★ D-26):**只读** `step` 的调用间隔 —— 不改参数、不改返回值、
 * 不吞异常。返回的 `rate()` 与 `formatTickRateLine()` 一起给出
 * 「实测 tick 间隔 / 实际 fps / 世界钟×墙钟倍率」。
 *
 * 导出是为了**可判**(`tests/WS-FND-175-clock-convention.test.ts` 拿一个假 `step`
 * 直接验它);同款包法见 `scripts/soak.ts#createSoakFixture`。
 */
export type TickProbe = {
  /** 已采到的间隔(ms);第一个调用没有前驱 ⇒ 不计。 */
  intervals: number[];
  /** 现算的节拍读数(均值 / 极值 / fps)。 */
  rate: () => TickRate;
  /** 还原原方法(测试用)。 */
  restore: () => void;
};

/** 装探针(幂等性不管:同一对象只许装一次,与 `soak.ts` 同款)。 */
export function installTickProbe(room: object): TickProbe {
  const target = room as unknown as Record<string, unknown>;
  const base = (target['step'] as (...args: unknown[]) => unknown).bind(room);
  const intervals: number[] = [];
  let lastAtMs = 0;
  target['step'] = (...args: unknown[]): unknown => {
    const now = Date.now();
    if (lastAtMs !== 0) intervals.push(now - lastAtMs);
    lastAtMs = now;
    return base(...args);
  };
  return {
    intervals,
    rate: () => tickRateOf(intervals),
    restore: (): void => { target['step'] = base; },
  };
}

async function main(): Promise<void> {
  /* ── 1 真实世界 + 房间 ── */
  log(`装配世界(${WORLD_CELLS}×${WORLD_CELLS},带怪)…`);
  const assembled = assemble({
    roomId: 'play',
    ownerId: 'u_host',
    sizeCells: WORLD_CELLS,
    mobs: true,
    /* ★ 两种模式**互斥且显式**:内存模式给 `memory: true`,否则给文件路径。
       不给路径又不给 `--memory` ⇒ 走 `DEFAULT_DB_PATH`(而不是悄悄不落盘)。 */
    ...(DB_TARGET === null ? { memory: true } : { dbPath: DB_TARGET }),
  });
  log(DB_TARGET === null
    ? '存档:内存模式(--memory)⇒ 不落盘,退出即丢'
    + `;房间仍会按 AUTOSAVE_INTERVAL_MS 调 saveWorldNow(只是没有库可写)`
    : `存档:${DB_TARGET}(文件库)⇒ 30 秒周期 + 离场 + 销毁 + 重置 自动保存`);
  if (assembled.runtime.db === null && DB_TARGET !== null) {
    log(`⚠️ 期望文件库(${DB_TARGET})但 db 仍是 null —— 落盘不会发生`);
  }

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
  /* ★ D-26:世界时间是 `帧数 × DT`(**不读挂钟**)⇒ 这里的「秒」是**世界秒**;
     而那个 `耗时 Xms` 是**同步跑帧的 CPU 成本**,不是节拍 ——
     真实节拍(墙钟)见下面「实测节拍」那一行。 */
  log(`预热 ${warmup} 帧(${(warmup * DT).toFixed(0)} 秒世界时间 = ${warmup} 帧 × DT;`
    + `同步跑帧的 CPU 耗时 ${Date.now() - warmT0}ms,不是节拍)`
    + ` ⇒ 世界里有 ${mobs.length} 只生物`
    + (mobs.length === 0 ? '  ⚠️ 一只都没有(若 --size 小到整图都在安全区里,就会是 0)' : ''));
  if (mobs.length > 0) {
    log('  ' + mobs.slice(0, 8).map((m) => `${m.mobId}(${m.hp}/${m.maxHp})`).join(' · ')
      + (mobs.length > 8 ? ` … 共 ${mobs.length} 只` : ''));
  }
  log(`房间 ${assembled.runtime.id} 就绪;host=${assembled.host === null ? 'null(异常)' : '已装配'}`);

  /* ── 1c 实测节拍探针(★ D-26:帧数即时间)──
     世界时间 = `frameCount × DT`(不读挂钟)⇒「32Hz / 31.25ms」是**物量纲的标称**,
     不是墙钟承诺:宿主定时器粒度 > 31.25ms 的机器上,同一段世界时间要更长的墙钟。
     探针只**读** `step` 的调用间隔(不改参数 / 不改返回值),由下面的启动打印给出
     「实测 tick 间隔 / 实际 fps / 世界钟×墙钟倍率」。
     ⚠️ 必须在 `startWsServer` **之前**装:那个 32Hz 循环每次现取 `room.step`。
     ⚠️ 本脚本的循环 `frameMs = NOMINAL_TICK_MS`(= `DT × 1000` = 31.25ms)
     ⇒ 每次广播推**一**世界帧(31.25ms 世界时间)⇒ **标称**下「1 世界帧 = 1 墙钟帧」。
     实测节拍偏慢时倍率 > 1(本机约 2.0 倍),启动打印如实算出来 ——
     别按「1 世界帧 = 1 墙钟帧」**读实测那行**。
     ★ 2026-11-25(口径硬化):这里原来是写死的 `20`。那是**旧口径的帧长**:留着它,
     世界钟在标称下会比墙钟**快** `NOMINAL_TICK_MS ÷ 20` = 1.5625 倍 —— 与「帧数即时间」
     的口径直接打架,而这种矛盾**不报错**,只会让读日志的人算错时长。 */
  const tickProbe = installTickProbe(assembled.runtime);

  /* ── 2 WS 服务端(32Hz;room.step 推进世界) ── */
  const srv = await startWsServer({
    port: WS_PORT,
    room: assembled.runtime as never,
    frameMs: NOMINAL_TICK_MS,
    onLog: (m) => { if (process.env['PLAY_VERBOSE'] === '1') log(`[ws] ${m}`); },
  });
  log(`WS 服务端:ws://127.0.0.1:${srv.port}/ws`);

  /* ── 2a 实测节拍(★ D-26)──
     5 秒后打一行:此时循环已跑过几十帧,读数才有意义。**只打印**,不改世界一步。
     `unref`:它不该让进程活着(退出由 ws / 浏览器那侧决定)。 */
  const tickWatch = setTimeout(() => {
    log(formatTickRateLine('实测节拍(WS 循环 step:每次广播 = 1 世界帧)', tickProbe.rate()));
  }, 5_000);
  if (typeof tickWatch.unref === 'function') tickWatch.unref();

  /* ── 2b 自动存档的**日志观测点**(owner 裁定要求「失败不能静默」)──
     每 10 秒对比一次房间的存档计数:变了就报「存了几次 / 最近何时」,
     失败就报错因(并把 `lastSaveError` 打全)。
     ⚠️ 这里**只读**房间的观测量(`saveCount` / `lastSaveAt` / `lastSaveError`),
     不触发存档、不碰库 —— 触发点全在 `room.ts` 里(周期/离场/销毁/重置)。 */
  let seenSaveCount = 0;
  let seenSaveError: string | null = null;
  const saveWatch = setInterval(() => {
    const rt = assembled.runtime;
    if (rt.saveCount !== seenSaveCount) {
      seenSaveCount = rt.saveCount;
      const when = rt.lastSaveAt === null ? '?' : new Date(rt.lastSaveAt).toLocaleTimeString();
      log(`自动存档 #${rt.saveCount}(原因 ${rt.lastSaveReason ?? '?'} · ${when})`);
    }
    if (rt.lastSaveError !== null && rt.lastSaveError !== seenSaveError) {
      seenSaveError = rt.lastSaveError;
      log(`⚠️ ${rt.lastSaveError}(累计失败 ${rt.saveFailCount} 次)`);
    }
  }, 10_000);
  /* `unref`:本定时器不该让进程活着(退出由 ws/浏览器那侧决定)。 */
  if (typeof saveWatch.unref === 'function') saveWatch.unref();
  if (DB_TARGET !== null) {
    log(`存档观测:` + `saveCount=${assembled.runtime.saveCount}`
      + ` · lastSaveAt=${String(assembled.runtime.lastSaveAt)}`
      + ` · lastSaveError=${String(assembled.runtime.lastSaveError)}`);
  }

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
    log('正在关闭...');
    /* ★ **最后存一次**(owner 裁定:关闭不该丢最后一段进度)。
       走 `close()` 而不是直接 `saveWorldNow()`:它同时是「房间销毁」的语义
       (colyseus 的 `onDispose` 也是这条),于是存档 + 状态置 CLOSED 一起完成,
       不会留下「进程要没了而库里房间还标着 OPEN」。 */
    try {
      assembled.runtime.close();
    } catch (e) {
      log(`⚠️ 关闭时存档失败:${(e as Error).message}`);
    }
    const rt = assembled.runtime;
    log(`存档统计:成功 ${rt.saveCount} 次 · 失败 ${rt.saveFailCount} 次`
      + ` · 最近 ${rt.lastSaveAt === null ? '从未' : new Date(rt.lastSaveAt).toLocaleTimeString()}`
      + (rt.lastSaveError === null ? '' : ` · 最近错因:${rt.lastSaveError}`));
    clearInterval(saveWatch);
    clearTimeout(tickWatch);
    try { web?.kill(); } catch { /* 已退出 */ }
    void srv.close();
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ★ 入口守卫(与 `scripts/soak.ts` 同款):被 import 时**不**启动服务 ——
   判据(`tests/WS-FND-175-clock-convention.test.ts`)要直接验本文件的探针与打印。 */
const entry = process.argv[1]?.replace(/\\/g, '/');
if (entry !== undefined && entry.endsWith('play.ts')) {
  main().catch((e: unknown) => {
    console.error(`  [play] 启动失败:${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}
