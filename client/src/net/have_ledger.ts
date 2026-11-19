/**
 * 背包**明细**账本 —— `CRAFT` 的 `have` 到底从哪来(第七轮审计 P2)。
 *
 * ## 修的是什么
 * `main.ts` 修前把合成参数写成:
 * ```ts
 * craft: () => ({ itemId: lastItemId, have: undefined })
 * ```
 * 而 `net/action_entry.craftRequest` 的判据是**`have` 必填**
 * (服务端 `craft.ts` 只认客户端给的明细,`authoritativeItemTotal()` 只有总量、
 * `inventoryDetailOf()` 恒 `null`)⇒ 那一行让「按 N」**永远走不到发送**
 * (`code: 'INVALID_INPUT'`,提示"需要 have")。功能在、入口在、报文永不产生。
 *
 * ## 明细从哪来(为什么这不是编的)
 * 快照里**没有**背包明细,但**回执里有增量事实**:
 * ```
 * BREAK_BLOCK  effect: { objId, gained }            拆下来真的进包几件(0 = 背包满掉地上)
 * PICKUP_ITEM  effect: { itemId }                   捡起 ⇒ 1 件
 * CRAFT        effect: { itemId, produced, consumed } 产出与**真的扣掉的那几件**
 * BUY_ITEM     effect: { itemId, qty }
 * OPEN_CHEST   effect: { itemId, stored | taken }
 * DROP_ITEM    effect: { itemId, count }             丢出去 ⇒ 减
 * PLACE_BLOCK  effect: { itemId }                    放一块 ⇒ 减 1
 * USE_ITEM     effect: { itemId }                    用掉一件 ⇒ 减 1
 * ```
 * ⇒ 本模块把这些增量**逐条落账**,得到一份客户端估计值。
 *
 * ## 它是"估计",并**照实**这么说
 * 断线重连 / 存档恢复 / 别的玩家改动背包都会让估计漂移。取舍是明确的:
 * ```
 * 不给 have ⇒ 按 N **永远**不发(功能不存在)
 * 给估计   ⇒ 漂了就发一条,服务端回 INVALID + "材料不足:…"(玩家看得到原因)
 * ```
 * 后者至少是**有话说**的失败,前者是死键 —— 本仓的判据一直是后者不可接受。
 *
 * ⚠️ 账本**不预测成功**:它不在发送前扣材料,只按服务端回执改。
 *   (乐观扣减会让"被拒"看起来像"成功了",那是第二条真值来源。)
 */

/** 背包明细:`{ "物品id": 件数 }`(与 `craft.ts` 的 `stockField` 同形,键是字符串)。 */
export type HaveDetail = Readonly<Record<string, number>>;

/** 落账所需的最小回执形状(与 `net/session.ts` 的 `ActionResultFrame` 结构兼容)。 */
export interface HaveReceipt {
  action: string;
  ok: boolean;
  effect?: Record<string, unknown>;
}

/** 空账本。 */
export const EMPTY_HAVE: HaveDetail = {};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function itemIdOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/** 键 → 件数,去掉 0 与负数(账本里不留"0 件"这种条目)。 */
function put(out: Record<string, number>, id: number, delta: number): void {
  if (id <= 0 || delta === 0) return;
  const next = (out[id] ?? 0) + delta;
  if (next > 0) out[id] = next;
  else delete out[id];
}

/**
 * 一条回执 → 新账本(**纯函数**:不改入参,永远返回新对象)。
 *
 * 只有 `ok === true` 的回执才会改账 —— 被拒的动作没有改动背包,
 * 拿它改账会让"被拒"看起来像"发生了"。
 */
export function applyReceiptToHave(detail: HaveDetail, receipt: HaveReceipt): HaveDetail {
  if (receipt.ok !== true) return detail;
  const e = receipt.effect;
  if (e === undefined || e === null) return detail;

  const out: Record<string, number> = { ...detail };
  /* 物品 id 的两个来源:`itemId`(大多数动作)与 `objId`(BREAK_BLOCK 拆下来的那件) */
  const itemId = itemIdOf(e.itemId);
  const objId = itemIdOf(e.objId);
  const gainId = itemId > 0 ? itemId : objId;

  /* ── 增量(进包) ── */
  put(out, gainId, num(e.gained));            /* 拆块真的进包几件 */
  put(out, itemId, num(e.produced));          /* 合成产出 */
  put(out, itemId, num(e.qty));               /* 买到的件数 */
  put(out, itemId, num(e.taken));             /* 从箱子里取出 */
  if (receipt.action === 'PICKUP_ITEM' && itemId > 0) put(out, itemId, 1);

  /* ── 减量(出包) ── */
  put(out, itemId, -num(e.stored));           /* 存进箱子 */
  if (receipt.action === 'DROP_ITEM') put(out, itemId, -num(e.count));
  if (receipt.action === 'PLACE_BLOCK' && itemId > 0) put(out, itemId, -1);
  if (receipt.action === 'USE_ITEM' && itemId > 0) put(out, itemId, -1);

  /* ── 合成的消耗表(`consumed` 是嵌套对象:id → 真的扣掉的件数) ── */
  const consumed = e.consumed;
  if (consumed !== null && typeof consumed === 'object' && !Array.isArray(consumed)) {
    for (const [k, v] of Object.entries(consumed as Record<string, unknown>)) {
      put(out, Number(k), -num(v));
    }
  }
  return out;
}

/**
 * 账本里某件物品的**已知**件数。
 *
 * `0` 同时表示"没有"与"不知道" ⇒ 调用方不该用它下判断,
 * 它只用于自检口径与提示行。
 */
export function haveCountOf(detail: HaveDetail, itemId: number): number {
  return detail[String(itemId)] ?? 0;
}

/** 账本条目数(自检口径:是否真的在落账)。 */
export function haveEntryCount(detail: HaveDetail): number {
  return Object.keys(detail).length;
}