/**
 * WS-FND-194 · 背包下行与容量口径。
 *
 * 守三件事:
 * 1 新玩家进场收到的背包**就是起始包**(不是整张物品表);
 * 2 背包变了客户端会再收到一帧,没变就不重发;
 * 3 容量 = 负重格 × `ITEMS_PER_CARRY_SLOT`(起始包之外还装得下一趟采集)。
 *
 * 运行:`node tests/WS-FND-194-inventory-downlink.test.ts`
 */
import { eq, ok, report, results, test } from '../shared/testing/harness.ts';
import { assemble } from '../server/src/index.ts';
import { startWsServer } from '../server/src/net/ws_server.ts';
import { PROTOCOL_VERSION } from '../shared/net/delta.ts';
import { STARTING_INVENTORY } from '../shared/constants/starting_inventory.ts';
import { ITEM_LIST } from '../shared/constants/items.ts';
import { carryItemCapacity, ITEMS_PER_CARRY_SLOT } from '../server/src/combat/progression.ts';

const STARTING: Record<string, number> = Object.fromEntries(
  STARTING_INVENTORY.map((e) => [String(e.itemId), e.count]),
);
const STARTING_TOTAL = STARTING_INVENTORY.reduce((n, e) => n + e.count, 0);

test('FND194-1 容量 = 负重格 × 每格件数;起始包之外还有余量', () => {
  eq(ITEMS_PER_CARRY_SLOT, 20, '一格 20 件');
  eq(carryItemCapacity(8), 160, 'Lv.1 的 8 格 = 160 件');
  eq(carryItemCapacity(0), 0, '0 格 = 0');
  eq(carryItemCapacity(-3), 0, '负数夹到 0');
  ok(carryItemCapacity(8) - STARTING_TOTAL >= 100, '带着起始包仍装得下一趟采集(一次任务要 8~10 件)');
});

test('FND194-2 房间读口:成员拿到起始包与容量;外人拿到 null', () => {
  const a = assemble({ memory: true, db: null, archiveSink: null, sizeCells: 32 });
  a.runtime.join({ userId: 'u1' });
  const inv = a.runtime.inventoryOf('u1');
  ok(inv !== null, '成员有背包');
  eq(Object.fromEntries(Object.entries(inv!.items).map(([k, v]) => [k, v])), STARTING, '背包 = 起始包,逐件相同');
  eq(inv!.capacity, carryItemCapacity(8), '容量 = Lv.1 的 8 格');
  ok(Object.keys(inv!.items).length < ITEM_LIST.length / 10, '远少于物品表(不是整表)');
  eq(a.runtime.inventoryOf('stranger'), null, '不在成员表里 ⇒ null');
});

const enc = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until(cond: () => boolean, budgetMs = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 >= budgetMs) return false;
    await sleep(5);
  }
  return true;
}
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); } catch (err) {
    results.push({ name, ok: false, msg: err instanceof Error ? err.message : String(err) });
  }
}
/** 上行文本帧 = 1 字节 tag(0x01)+ JSON。 */
function sendJson(ws: WebSocket, obj: unknown): void {
  const body = enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = 0x01;
  out.set(body, 1);
  ws.send(out);
}

await atest('FND194-3 真连接:进场收到起始包;背包变了再收一帧,没变不重发', async () => {
  const a = assemble({ memory: true, db: null, archiveSink: null, sizeCells: 32 });
  const srv = await startWsServer({ port: 0, room: a.runtime as never, frameMs: 20, requireToken: false });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?userId=bag1`);
  const frames: { items: Record<string, number>; capacity: number }[] = [];
  ws.addEventListener('open', () => { sendJson(ws, { t: 'hello', protocolVersion: PROTOCOL_VERSION, contentClaim: null }); });
  ws.addEventListener('message', ((ev: { data: unknown }) => {
    if (typeof ev.data !== 'string') return;
    const j = JSON.parse(ev.data) as { t?: string; items: Record<string, number>; capacity: number };
    if (j.t === 'inventory') frames.push(j);
  }) as never);
  try {
    ok(await until(() => frames.length >= 1), '进场后应收到背包帧');
    eq(frames[0]!.items, STARTING, '第一帧 = 起始包');
    eq(frames[0]!.capacity, carryItemCapacity(8), '带容量');

    /* 没变化 ⇒ 兜底比对(每 200ms 一次)不该重发。 */
    await sleep(500);
    eq(frames.length, 1, '背包没变 ⇒ 不重发');

    /* 动作之外的变化(这里直接改账,等价于掉落/奖励)⇒ 兜底比对补发一帧。 */
    a.runtime.grantItemSource('bag1', 'test:gift');
    const r = a.runtime.applyInventory('bag1', { ops: [{ itemId: 121, delta: 3, source: 'test:gift' }] });
    ok(r.allowed, '前置:塞 3 颗甜莓应成功');
    ok(await until(() => frames.length >= 2), '背包变了 ⇒ 再收到一帧');
    eq(frames[1]!.items, { ...STARTING, 121: 3 }, '新帧带上新物品,旧的不丢');
  } finally {
    ws.close();
    await srv.close();
  }
});

report('WS-FND-194');
