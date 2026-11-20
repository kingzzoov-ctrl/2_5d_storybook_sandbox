/**
 * 派对**模式选择面板**的纯逻辑(零 DOM、零 three ⇒ node 里可直接断言)。
 *
 * ## 修的是什么(WS-FND-151)
 *
 * 台账 `wiring_ledger.ts` 里 `SET_PARTY_MODE` 一直是 `missing`,理由写得很具体:
 * 「四选一要**选择器 + 权限位**;裸键只能"轮到下一档"、没有确认」。本文件就是那个
 * 选择器的**数据侧**:列出 `PARTY_MODES` 的全部模式(名字 + 一句话规则)、
 * 标出当前档、把"选了哪个"翻成一条**可发送的命令**。
 *
 * ```
 * shared/constants/bosses.ts  PARTY_MODES       词表(唯一的名字来源,不手抄)
 * 本文件                       下标/名字/规则/光标/命令(**纯**)
 * ui/panel_layout.ts           面板摆在哪(纯)
 * three/ui_binding.ts          只做 fillRect/fillText + 命中测试
 * net/action_entry.ts          setPartyModeRequest() ⇒ 恰好一条报文
 * ```
 *
 * ⚠️ 三条纪律:
 *   1 **不在客户端另抄一份模式名**(抄一份之后服务端加模式就会静默错位成"上一档");
 *   2 线上下标是 **1 起**(`0` = 没有派对,见 `party_hud.partyModeName`),
 *      而 `PARTY_MODES` 是 0 起 ⇒ 换算只写在 `partyModeOptions()/partyModeOptionAt()` 一处;
 *   3 本文件**不发报文**、也不判权限 —— 权限位在服务端(`net/room.ts` 的
 *      `authorize(actorId, SET_PARTY_MODE)`),被拒时由回执如实说出来。
 */

import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
import { partyModeName } from './party_hud.ts';

/**
 * 线上动作名。
 *
 * 取值逐字等于 `server/src/net/room.ts` 的 `RoomAction.SET_PARTY_MODE`;
 * 载荷键是 `partyMode`(字符串 key,不是下标 —— 见 `net/actions/admin.ts:66` 的
 * `ctx.payload.partyMode` 与 `setPartyModeBy(actorId, mode: PartyMode)`)。
 */
export const PARTY_MODE_ACTION = 'SET_PARTY_MODE';

/** 一个可选模式(名字与规则**全部**来自冻结层 `PARTY_MODES`)。 */
export interface PartyModeOption {
  /** 线上下标(**1 起**;`0` 是"没有派对") */
  mode: number;
  /** 冻结层 key(`BRIDGE_CTF` 等;报文里发的是它) */
  key: string;
  /** 模式名 */
  name: string;
  /** 一句话规则(`PARTY_MODES[].note`) */
  rule: string;
  /** 人数区间(`PARTY_MODES[].players`) */
  players: string;
  /** 面板那一行的**一行文本**(名字 + 人数 + 规则) */
  text: string;
}

/** 全部模式(顺序 = 冻结层顺序 = 线下标顺序)。 */
export function partyModeOptions(): PartyModeOption[] {
  return PARTY_MODES.map((m, i) => ({
    mode: i + 1,
    key: m.key,
    name: m.name,
    rule: m.note,
    players: m.players,
    text: `${i + 1}. ${m.name}(${m.players})—— ${m.note}`,
  }));
}

/** 模式总数(**从冻结层算**,不是写死的 4 —— 加一个模式这里自动跟着变)。 */
export const PARTY_MODE_COUNT: number = PARTY_MODES.length;

/** 线下标(1 起)→ 选项;越界 = `null`(不猜,也不回落到第一档)。 */
export function partyModeOptionAt(mode: number): PartyModeOption | null {
  if (!Number.isFinite(mode)) return null;
  const i = Math.trunc(mode) - 1;
  if (i < 0 || i >= PARTY_MODES.length) return null;
  return partyModeOptions()[i] ?? null;
}

/** 光标夹到 `[0, count)`(面板行数变少时不越界)。 */
export function clampPartyCursor(cursor: number, count: number = PARTY_MODE_COUNT): number {
  const n = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  const c = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  return Math.max(0, Math.min(n - 1, c));
}

/**
 * 光标移动(循环)。
 *
 * 循环而不是夹紧:`J` 一直按会回到第一档 —— 「到底了没反应」在键盘上分不清
 * 「列表只有一档」和「键坏了」。
 */
export function movePartyCursor(cursor: number, delta: number, count: number = PARTY_MODE_COUNT): number {
  const n = Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1;
  const c = clampPartyCursor(cursor, n);
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return ((c + d) % n + n) % n;
}

/** 面板里的一行(光标 / 当前档都是**标记**,不是别处再算一次)。 */
export interface PartyPanelRow extends PartyModeOption {
  /** 房间当前已选的那一档(= 权威 `meta.partyMode`) */
  current: boolean;
  /** 键盘光标停在这一行 */
  cursor: boolean;
}

/** 面板要画的一切 —— 由 `three/boot.ts` 每帧组装,**本文件不碰 UI**。 */
export interface PartyPanelView {
  /** 房间当前档的线上下标(0 = 没选) */
  currentMode: number;
  /** 当前档的名字(未选 / 越界 = `null`) */
  currentName: string | null;
  /** 键盘光标(0 起,行下标) */
  cursor: number;
  rows: PartyPanelRow[];
  /** 光标那一档(按 Enter 会发的那一档;空列表 = `null`) */
  selected: PartyModeOption | null;
  /** 标题右半边那句:「当前:xxx」/「当前:未选」 */
  currentText: string;
  /** 底部一行:键位 + 提示 */
  hint: string;
}

/**
 * 房间级 `meta` + 光标 → 面板视图。
 *
 * ⚠️ `currentMode` **直接取权威字段**,不在本层缓存:缓存一份就会在服务端
 * 改档后仍显示旧档(而那不报错)。
 */
export function partyPanelOf(
  meta: { partyMode: number },
  cursor: number,
): PartyPanelView {
  const raw = Number.isFinite(meta.partyMode) ? Math.trunc(meta.partyMode) : 0;
  const currentName = partyModeName(raw);
  const options = partyModeOptions();
  const cur = clampPartyCursor(cursor, options.length);
  const rows: PartyPanelRow[] = options.map((o) => ({
    ...o,
    current: currentName !== null && o.mode === raw,
    cursor: o.mode - 1 === cur,
  }));
  return {
    currentMode: raw,
    currentName,
    cursor: cur,
    rows,
    selected: options[cur] ?? null,
    currentText: currentName === null ? '当前:未选(开局前必须先选一档)' : `当前:${currentName}`,
    hint: `J/L 选 · Enter 定(发 ${PARTY_MODE_ACTION}) · M/Esc 关`,
  };
}

/** 一条待发的报文(扁平一层:`action` 在展开之后,与 `ActionEntry.submit` 同口径)。 */
export interface PartyModeIntent {
  action: string;
  partyMode: string;
}

/**
 * 选中某档 → 待发报文。
 *
 * 越界 / 不认识的档返回 `null`(**不发**一条注定被服务端拒的报文);
 * 载荷里的 `partyMode` 是**冻结层 key**,不是下标。
 */
export function partyModeIntent(mode: number): PartyModeIntent | null {
  const opt = partyModeOptionAt(mode);
  if (opt === null) return null;
  return { action: PARTY_MODE_ACTION, partyMode: opt.key };
}