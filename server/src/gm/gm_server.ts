/**
 * GM 端:一个本机 HTTP 服务,提供配置页面与 JSON 接口。
 *
 * 管两件事:① NPC 的 AI 端点与人设 prompt(读写 `GmConfig`,落盘);② 世界现状只读概览。
 * 默认只绑 127.0.0.1:页面能改 API key,不该直接暴露到公网;远程用请走 SSH 隧道或反代。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NPCS } from '../npc/defs.ts';
import {
  askNpcAi, defaultGmConfig, normalizeGmConfig, saveGmConfig, type GmConfig,
} from '../npc/ai.ts';
import { GM_PAGE_HTML } from './gm_page.ts';

export interface GmWorldStatus {
  players: { id: string; name: string; level: number; hp: number; maxHp: number; x: number; y: number }[];
  wildlife: Record<string, number>;
  tick: number;
}

/** 最近一次 AI 调用的结果(每个 NPC 一条,给 GM 页面看端点是否在工作)。 */
export interface AiCallLog { at: number; ok: boolean; ms: number; text: string }

export interface GmServerOptions {
  port: number;
  host?: string;
  configPath: string;
  /** 当前配置(GM 端与对话逻辑共用同一个对象的读口) */
  getConfig: () => GmConfig;
  setConfig: (cfg: GmConfig) => void;
  worldStatus: () => GmWorldStatus;
  aiLog: () => Record<string, AiCallLog>;
}

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function startGmServer(opts: GmServerOptions): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://gm');
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === 'GET /' || route === 'GET /index.html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(GM_PAGE_HTML);
        } else if (route === 'GET /api/config') {
          json(res, 200, {
            config: opts.getConfig(),
            npcs: NPCS.map((n) => ({ id: n.id, name: n.name, lines: n.lines, quest: n.quest?.title ?? null })),
            configPath: opts.configPath,
          });
        } else if (route === 'PUT /api/config') {
          const cfg = normalizeGmConfig(JSON.parse(await readBody(req)));
          opts.setConfig(cfg);
          saveGmConfig(opts.configPath, cfg);
          json(res, 200, { ok: true, config: cfg });
        } else if (route === 'POST /api/config/reset') {
          /* 只重置 prompt 与参数,端点连接信息保留(重填 key 很烦)。 */
          const cur = opts.getConfig();
          const cfg = defaultGmConfig();
          cfg.ai.enabled = cur.ai.enabled;
          cfg.ai.endpoint = cur.ai.endpoint;
          opts.setConfig(cfg);
          saveGmConfig(opts.configPath, cfg);
          json(res, 200, { ok: true, config: cfg });
        } else if (route === 'POST /api/npc/test') {
          /* 用**页面上当前填的**配置试一次(不必先保存);总开关视为开。 */
          const body = JSON.parse(await readBody(req)) as { npcId?: string; config?: unknown };
          const cfg = normalizeGmConfig(body.config ?? opts.getConfig());
          cfg.ai.enabled = true;
          const npc = NPCS.find((n) => n.id === body.npcId);
          if (npc === undefined) { json(res, 400, { ok: false, reason: '没有这个 NPC' }); return; }
          if (cfg.npcs[npc.id] !== undefined) cfg.npcs[npc.id]!.enabled = true;
          const r = await askNpcAi(cfg, npc.id, {
            scriptedLine: npc.lines[0]!,
            ...(npc.quest === undefined ? {} : {
              questTitle: npc.quest.title, questStatus: 'available', needCount: npc.quest.needCount, have: 0,
            }),
          });
          json(res, 200, { ...r, fallback: npc.lines[0] });
        } else if (route === 'GET /api/status') {
          json(res, 200, { world: opts.worldStatus(), ai: opts.aiLog() });
        } else {
          json(res, 404, { ok: false, reason: '没有这个接口' });
        }
      } catch (e) {
        json(res, 400, { ok: false, reason: (e as Error).message });
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve({ server, port: opts.port }));
  });
}
