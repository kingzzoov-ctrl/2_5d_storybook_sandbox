/**
 * WS-FND-196 · NPC 的 AI 对话与兜底。
 *
 * 守的是「AI 出任何问题,玩家照样听到脚本台词」:端点没开、没配、超时、报错、空回复
 * 都必须落到 `ok:false`(调用方不追加),并且从不抛。另守配置规整与入场首帧的范围。
 */
import { eq, ok, report, test } from '../shared/testing/harness.ts';
import {
  askNpcAi, buildMessages, cleanReply, defaultGmConfig, endpointFor, normalizeGmConfig,
  DEFAULT_NPC_PROMPTS,
} from '../server/src/npc/ai.ts';
import { NPCS } from '../server/src/npc/defs.ts';

const FACTS = { scriptedLine: NPCS[0]!.lines[0]! };

function onCfg() {
  const c = defaultGmConfig();
  c.ai.enabled = true;
  c.ai.endpoint = { baseUrl: 'http://ai.test/v1', apiKey: 'k', model: 'm' };
  c.ai.timeoutMs = 500;
  return c;
}

const fetchOf = (content: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

test('FND193-1 每个 NPC 都有一份非空人设 prompt', () => {
  const c = defaultGmConfig();
  for (const n of NPCS) {
    ok((DEFAULT_NPC_PROMPTS[n.id] ?? '').length > 40, `${n.id} 有专属人设`);
    ok(c.npcs[n.id]!.prompt.includes(n.name), `${n.id} 的 prompt 点了自己的名字`);
  }
});

test('FND193-2 默认配置 = 兜底模式;各种「没配好」都不发请求', async () => {
  let calls = 0;
  const spy = (async () => { calls += 1; return new Response('{}'); }) as unknown as typeof fetch;
  const off = await askNpcAi(defaultGmConfig(), 'npc_mayor', FACTS, spy);
  eq(off.ok, false, '总开关默认关');
  const noEp = onCfg(); noEp.ai.endpoint.baseUrl = '';
  eq((await askNpcAi(noEp, 'npc_mayor', FACTS, spy)).ok, false, '端点没填');
  const one = onCfg(); one.npcs['npc_mayor']!.enabled = false;
  eq((await askNpcAi(one, 'npc_mayor', FACTS, spy)).ok, false, '单个 NPC 关掉');
  eq((await askNpcAi(onCfg(), 'npc_nobody', FACTS, spy)).ok, false, '未知 NPC');
  eq(calls, 0, '以上四种一次请求都没发');
});

test('FND193-3 端点答上来 ⇒ 用清洗后的那句', async () => {
  const r = await askNpcAi(onCfg(), 'npc_mayor', FACTS, fetchOf('镇长·阿岭:「篝火正旺,坐下歇歇吧。」'));
  ok(r.ok, '成功');
  if (r.ok) eq(r.line, '篝火正旺,坐下歇歇吧。', '去掉角色名前缀与引号');
});

test('FND193-4 超时 / 非 2xx / 空回复 / 抛错 ⇒ 兜底且不抛', async () => {
  const hang = ((_u: unknown, init: RequestInit) => new Promise((_res, rej) => {
    init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
  })) as unknown as typeof fetch;
  const t = await askNpcAi(onCfg(), 'npc_mayor', FACTS, hang);
  ok(!t.ok && t.reason.includes('超时'), '挂起的端点在 timeoutMs 后判超时');
  ok(t.ms < 2000, '没有等过头');
  eq((await askNpcAi(onCfg(), 'npc_mayor', FACTS, fetchOf('x', 500))).ok, false, '500');
  eq((await askNpcAi(onCfg(), 'npc_mayor', FACTS, fetchOf(''))).ok, false, '空回复');
  eq((await askNpcAi(onCfg(), 'npc_mayor', FACTS, fetchOf('<think>想了很久</think>'))).ok, false, '只有思考块');
  const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const b = await askNpcAi(onCfg(), 'npc_mayor', FACTS, boom);
  ok(!b.ok && b.reason.includes('ECONNREFUSED'), '网络错带原因');
});

test('FND193-5 请求体:人设进 system、任务事实进 user、端点可按 NPC 覆盖', async () => {
  const c = onCfg();
  c.npcs['npc_miner']!.endpoint = { model: 'other' };
  eq(endpointFor(c, 'npc_miner'), { baseUrl: 'http://ai.test/v1', apiKey: 'k', model: 'other' }, '只覆盖填了的字段');
  const miner = NPCS.find((n) => n.id === 'npc_miner')!;
  const m = buildMessages(c, miner, { scriptedLine: 'L', questTitle: '矿道口的石头', questStatus: 'accepted', needCount: 10, have: 4 });
  ok(m[0]!.content.includes('铁生') && m[0]!.content.includes(c.ai.worldPrompt), 'system = 世界观 + 人设');
  ok(m[1]!.content.includes('10') && m[1]!.content.includes('4') && m[1]!.content.includes('还没交齐'), '任务事实写进 user');
  let seen: { url: string; auth: string | null; model: string } | null = null;
  const spy = (async (u: string, init: RequestInit) => {
    seen = { url: u, auth: new Headers(init.headers).get('authorization'), model: JSON.parse(String(init.body)).model };
    return new Response(JSON.stringify({ choices: [{ message: { content: '行,十块石头。' } }] }));
  }) as unknown as typeof fetch;
  await askNpcAi(c, 'npc_miner', FACTS, spy);
  eq(seen, { url: 'http://ai.test/v1/chat/completions', auth: 'Bearer k', model: 'other' }, '打到 chat/completions,带 key 与覆盖后的模型');
});

test('FND193-6 配置规整:垃圾输入 ⇒ 完整默认;数值夹住;未知 NPC 丢弃', () => {
  for (const bad of [null, undefined, 42, 'x', []]) eq(normalizeGmConfig(bad), defaultGmConfig(), `输入 ${String(bad)}`);
  const c = normalizeGmConfig({
    ai: { enabled: true, timeoutMs: 1, temperature: 9, endpoint: { baseUrl: 'http://a/v1///' } },
    npcs: { npc_mayor: { prompt: '新人设', enabled: false }, npc_ghost: { prompt: 'x' } },
  });
  eq([c.ai.timeoutMs, c.ai.temperature, c.ai.endpoint.baseUrl], [500, 2, 'http://a/v1'], '夹住 + 去尾斜杠');
  eq([c.npcs['npc_mayor']!.prompt, c.npcs['npc_mayor']!.enabled], ['新人设', false], '改动保留');
  eq(Object.keys(c.npcs).sort(), NPCS.map((n) => n.id).sort(), '只有真实存在的 NPC');
});

test('FND193-7 cleanReply:截断与过短', () => {
  eq(cleanReply('好', '镇长·阿岭', 80), null, '一个字 ⇒ 兜底');
  eq(cleanReply('一二三四五六七八九十十一', '镇长·阿岭', 10), '一二三四五六七八九十…', '超长截断');
  eq(cleanReply('阿岭:你好呀\n旅人', '镇长·阿岭', 80), '你好呀 旅人', '短名前缀与换行');
});

report('WS-FND-196');
