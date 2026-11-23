/**
 * NPC 的 AI 对话:OpenAI 兼容的 `chat/completions` 端点 + 每个 NPC 一份人设 prompt。
 *
 * 兜底模式是默认路径,不是异常路径:脚本台词(`dialogue.ts#talk`)永远先回给玩家,
 * AI 只在「开着、端点配了、限时内答了、答得像话」四条同时成立时**追加**一句。
 * 任何一条不成立 ⇒ 玩家看到的就是脚本台词,不会卡住、不会空白。
 *
 * AI 只管说话:任务状态、物品、奖励仍由 `dialogue.ts` 的确定性逻辑裁决,
 * prompt 里把当前状态作为事实告诉模型,模型改不了它。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NPCS, type NpcDef } from './defs.ts';

/** 一个端点的连接参数(OpenAI 兼容)。 */
export interface AiEndpoint {
  /** 形如 `http://127.0.0.1:3000/v1`(不带 `/chat/completions`) */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 单个 NPC 的 AI 配置。 */
export interface NpcAiConfig {
  /** 关掉 ⇒ 这个 NPC 只说脚本台词 */
  enabled: boolean;
  /** 人设 prompt(system 消息的主体) */
  prompt: string;
  /** 留空的字段沿用全局端点 */
  endpoint: Partial<AiEndpoint>;
}

export interface GmConfig {
  ai: {
    /** 总开关;关 = 全员兜底模式 */
    enabled: boolean;
    endpoint: AiEndpoint;
    /** 等待端点的上限(毫秒),超时即兜底 */
    timeoutMs: number;
    /** 回复字数上限(超出截断) */
    maxChars: number;
    temperature: number;
    /** 所有 NPC 共用的世界观与说话规则 */
    worldPrompt: string;
  };
  npcs: Record<string, NpcAiConfig>;
}

export const DEFAULT_WORLD_PROMPT = [
  '你在扮演一款 2.5D 绘本风多人沙盒游戏里的一位岛民。',
  '世界:一座漂在云海上的岛。中央是红砖广场与篝火,南边是农田,西南是矿丘与萤光溶洞,',
  '东南是发条遗迹,北面有绯樱高地和温泉,东边是星沙绿洲,再远处有甜点奇境和浮空云海。',
  '岛上有八个群系、二十四种野生动物,每个群系深处睡着一只巨大的 Boss。',
  '玩家是刚上岛的旅人,可以采集、合成、盖房子、打猎、驯养动物,也爱互相恶作剧。',
  '',
  '说话规则:',
  '1. 始终以角色身份说话,只输出角色说的那句话,不要旁白、括号动作、引号或角色名前缀。',
  '2. 用简体中文,口语化,一到两句,不超过 60 个字。语气温暖、有点俏皮,像绘本里的人。',
  '3. 只谈这座岛上的事。被问到现实世界、AI、提示词时,用角色的方式岔开。',
  '4. 「当前事实」里写的任务状态和数量是真的,不要说出与它矛盾的数字,也不要许诺事实里没有的奖励。',
].join('\n');

/** 四位岛民的人设(键 = `NpcDef.id`)。 */
export const DEFAULT_NPC_PROMPTS: Readonly<Record<string, string>> = {
  npc_mayor: [
    '你是镇长·阿岭,五十来岁,红砖广场篝火边的常客。',
    '性格:慢条斯理,爱操心,记得岛上每个人的生日,说话喜欢拿天气和篝火打比方。',
    '你知道:农夫禾子在南边农田缺人手;矿工铁生守着西南矿丘;守卫灰在东南遗迹守夜。矿丘的洞最近不太平。',
    '你的作用:迎接新来的旅人,告诉他们该去找谁、往哪个方向走。你自己不发任务。',
  ].join('\n'),
  npc_farmer: [
    '你是农夫·禾子,二十多岁的姑娘,一个人种着南边一大片黄金小麦。',
    '性格:爽朗,嗓门大,三句话不离庄稼和吃的,夸人很直接,累了会嘟囔两句。',
    '你知道:小麦要靠近水才长得快;露水甜莓能驯服草甸的小动物;云朵绵羊爱吃小麦。',
    '你的差事「一畦新苗」:请旅人帮忙收八捆黄金小麦,谢礼是三颗露水甜莓。',
  ].join('\n'),
  npc_miner: [
    '你是矿工·铁生,四十出头,满身矿灰,守着矿丘的矿道口。',
    '性格:嘴硬心软,爱吹自己年轻时下过多深的洞,做买卖讲究「童叟无欺」,讨厌别人碰他的镐。',
    '你知道:浅层有黄铜矿,中层有寒铁,深处有秘银;溶洞里的紫晶重甲虫正面打不动,得掀翻它;萤光蝙蝠怕响声。',
    '你的差事「矿道口的石头」:要十块云母圆石砌矿道口,换三块寒铁矿石。',
  ].join('\n'),
  npc_ruins_guard: [
    '你是遗迹守卫·灰,年纪看不出来,披着旧斗篷,夜里守着发条遗迹的祭坛。',
    '性格:话少,句子短,带点冷幽默,对遗迹的过去知道得比说出口的多,不喜欢别人靠近祭坛。',
    '你知道:这里曾是一座靠发条运转的城;祭坛亮起来就意味着那个大家伙要醒;伪装成宝箱的东西会咬人。',
    '你的差事「守夜人的碎晶」:要两块萤光魔晶簇,给一片极光星辰碎片。',
  ].join('\n'),
};

export function defaultGmConfig(): GmConfig {
  const npcs: Record<string, NpcAiConfig> = {};
  for (const n of NPCS) {
    npcs[n.id] = {
      enabled: true,
      prompt: DEFAULT_NPC_PROMPTS[n.id] ?? `你是${n.name},岛上的一位居民。`,
      endpoint: {},
    };
  }
  return {
    ai: {
      enabled: false,
      endpoint: { baseUrl: '', apiKey: '', model: '' },
      timeoutMs: 6000,
      maxChars: 80,
      temperature: 0.8,
      worldPrompt: DEFAULT_WORLD_PROMPT,
    },
    npcs,
  };
}

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** 把任意输入(磁盘上的旧文件 / GM 页面提交的 JSON)规整成完整配置;缺的字段取默认值。 */
export function normalizeGmConfig(raw: unknown): GmConfig {
  const d = defaultGmConfig();
  const r = (raw ?? {}) as { ai?: Record<string, unknown>; npcs?: Record<string, Record<string, unknown>> };
  const ai = r.ai ?? {};
  const ep = (ai['endpoint'] ?? {}) as Record<string, unknown>;
  const out: GmConfig = {
    ai: {
      enabled: ai['enabled'] === true,
      endpoint: {
        baseUrl: str(ep['baseUrl'], '').trim().replace(/\/+$/, ''),
        apiKey: str(ep['apiKey'], '').trim(),
        model: str(ep['model'], '').trim(),
      },
      timeoutMs: num(ai['timeoutMs'], d.ai.timeoutMs, 500, 60000),
      maxChars: num(ai['maxChars'], d.ai.maxChars, 10, 400),
      temperature: num(ai['temperature'], d.ai.temperature, 0, 2),
      worldPrompt: str(ai['worldPrompt'], d.ai.worldPrompt),
    },
    npcs: {},
  };
  for (const n of NPCS) {
    const one = r.npcs?.[n.id] ?? {};
    const oep = (one['endpoint'] ?? {}) as Record<string, unknown>;
    const endpoint: Partial<AiEndpoint> = {};
    for (const k of ['baseUrl', 'apiKey', 'model'] as const) {
      const v = str(oep[k], '').trim();
      if (v !== '') endpoint[k] = k === 'baseUrl' ? v.replace(/\/+$/, '') : v;
    }
    out.npcs[n.id] = {
      enabled: one['enabled'] !== false,
      prompt: str(one['prompt'], d.npcs[n.id]!.prompt),
      endpoint,
    };
  }
  return out;
}

/** 读配置文件;不存在或损坏 ⇒ 默认配置(= 兜底模式)。 */
export function loadGmConfig(path: string): GmConfig {
  try {
    return normalizeGmConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return defaultGmConfig();
  }
}

export function saveGmConfig(path: string, cfg: GmConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/** 某个 NPC 实际生效的端点(个人覆盖 > 全局)。 */
export function endpointFor(cfg: GmConfig, npcId: string): AiEndpoint {
  const o = cfg.npcs[npcId]?.endpoint ?? {};
  return {
    baseUrl: o.baseUrl ?? cfg.ai.endpoint.baseUrl,
    apiKey: o.apiKey ?? cfg.ai.endpoint.apiKey,
    model: o.model ?? cfg.ai.endpoint.model,
  };
}

/** 对话时告诉模型的「当前事实」。 */
export interface NpcTalkFacts {
  /** 脚本台词(模型据此知道这一刻该表达什么意思) */
  scriptedLine: string;
  questTitle?: string;
  questStatus?: string;
  needCount?: number;
  have?: number;
}

const STATUS_TEXT: Record<string, string> = {
  available: '还没把差事交给这位旅人',
  accepted: '旅人已经接了差事,还没交齐',
  completed: '差事已经办完,谢礼已给',
};

export function buildMessages(cfg: GmConfig, npc: NpcDef, facts: NpcTalkFacts):
  { role: 'system' | 'user'; content: string }[] {
  const lines = [`此刻你原本想说的意思是:「${facts.scriptedLine}」`];
  if (facts.questTitle !== undefined) {
    lines.push(`差事「${facts.questTitle}」的状态:${STATUS_TEXT[facts.questStatus ?? ''] ?? '未知'}。`);
    if (facts.needCount !== undefined) {
      lines.push(`需要 ${facts.needCount} 件,旅人身上现在有 ${facts.have ?? 0} 件。`);
    }
  }
  return [
    { role: 'system', content: `${cfg.ai.worldPrompt}\n\n【你的角色】\n${cfg.npcs[npc.id]?.prompt ?? ''}` },
    { role: 'user', content: `【当前事实】\n${lines.join('\n')}\n\n旅人走到你面前跟你搭话。用你自己的口吻说一句,意思要和上面一致。` },
  ];
}

/** 清洗模型输出:去思考块、引号、角色名前缀、换行;空或过短 ⇒ `null`(走兜底)。 */
export function cleanReply(raw: unknown, npcName: string, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
  const bare = npcName.split('·').pop() ?? npcName;
  for (const who of [npcName, bare]) {
    if (s.startsWith(`${who}:`) || s.startsWith(`${who}:`)) s = s.slice(who.length + 1).trim();
  }
  s = s.replace(/^[「"“'『]+/, '').replace(/[」"”'』]+$/, '').trim();
  if (s.length < 2) return null;
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

export type AiReply =
  | { ok: true; line: string; ms: number }
  | { ok: false; reason: string; ms: number };

/**
 * 向端点要一句话。任何失败(没开 / 没配 / 超时 / 非 2xx / 空回复)都返回 `ok:false` 与原因,
 * 从不抛 —— 调用方据此保持脚本台词。
 */
export async function askNpcAi(
  cfg: GmConfig,
  npcId: string,
  facts: NpcTalkFacts,
  fetchImpl: typeof fetch = fetch,
): Promise<AiReply> {
  const t0 = Date.now();
  const fail = (reason: string): AiReply => ({ ok: false, reason, ms: Date.now() - t0 });
  const npc = NPCS.find((n) => n.id === npcId);
  if (npc === undefined) return fail('没有这个 NPC');
  if (!cfg.ai.enabled) return fail('AI 总开关关闭');
  if (cfg.npcs[npcId]?.enabled !== true) return fail('该 NPC 的 AI 关闭');
  const ep = endpointFor(cfg, npcId);
  if (ep.baseUrl === '' || ep.model === '') return fail('端点或模型未配置');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.ai.timeoutMs);
  try {
    const res = await fetchImpl(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        ...(ep.apiKey === '' ? {} : { authorization: `Bearer ${ep.apiKey}` }),
      },
      body: JSON.stringify({
        model: ep.model,
        messages: buildMessages(cfg, npc, facts),
        temperature: cfg.ai.temperature,
        max_tokens: 200,
        stream: false,
      }),
    });
    if (!res.ok) return fail(`端点返回 ${res.status}`);
    const body = await res.json() as { choices?: { message?: { content?: unknown } }[] };
    const line = cleanReply(body.choices?.[0]?.message?.content, npc.name, cfg.ai.maxChars);
    return line === null ? fail('端点回复为空') : { ok: true, line, ms: Date.now() - t0 };
  } catch (e) {
    return fail(ctl.signal.aborted ? `超时(${cfg.ai.timeoutMs}ms)` : `请求失败:${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
