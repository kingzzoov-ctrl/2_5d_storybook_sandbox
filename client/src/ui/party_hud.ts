/**
 * 派对 / 比分 HUD 的**纯逻辑**层(零 DOM、零 three ⇒ 可被 node 直接断言)。
 *
 * ## 为什么要有这个文件(第六轮审计 P1)
 *
 * 房间级快照带四个字段:`meta.partyMode` / `meta.partyTimer` / `meta.scoreA` /
 * `meta.scoreB`(`shared/types/wire.ts` 的 `ROOM_FIELD_TABLE` bit 1..4)。
 * 接线前它们在 `client/src` 里的**读者数是 0** —— `RoomState` 解出来、存进
 * store、然后**没有任何东西看它们**:
 *
 * ```
 * grep -rn "partyMode\|scoreA\|scoreB" client/src   ⇒ 只有 state_store.emptyRoomState 的字面量
 * ```
 *
 * ⇒ 症状是「派对开了、比分在变,屏幕上什么都没有」,两端都不报错。
 *
 * ## 分工
 *
 * ```
 * shared/types/wire.ts  meta.partyMode 是**下标**(1=BRIDGE_CTF 2=JELLY_BALL ...)
 * shared/constants/bosses.ts  PARTY_MODES  是**词表**(唯一的模式名来源)
 * ui/party_hud.ts(本文件)    下标 + 计时 + 比分 → 一句可显示的话 / 结构化视图
 * three/boot.ts             每帧把 `text` 写进 `#hint`,把视图塞进自检口径
 * ```
 *
 * ⚠️ 下标 → 模式名**必须**走冻结层的 `PARTY_MODES`,不许在客户端另抄一份名字:
 * 抄一份之后服务端改名(或加模式)就会静默错位成"上一档的名字"。
 */

import { PARTY_MODES } from '../../../shared/constants/bosses.ts';
import type { RoomMetaState } from '../../../shared/types/wire.ts';

/** 派对 HUD 需要的四个房间级字段(只取需要的,便于测试构造) */
export type PartyMetaInput = Pick<RoomMetaState, 'partyMode' | 'partyTimer' | 'scoreA' | 'scoreB'>;

export interface PartyHudView {
  /** 线上下标原值(0 = 没有派对) */
  mode: number;
  /** 模式名(来自 `PARTY_MODES`);未登记的下标为 `null` */
  modeName: string | null;
  /** 是否在派对中(= `modeName !== null`) */
  active: boolean;
  /** 剩余秒数(原值,可能带小数 —— 它来自 `FieldType.POS` 的定点解码) */
  timer: number;
  /** 剩余秒数(向上取整,供显示) */
  timerSec: number;
  scoreA: number;
  scoreB: number;
  /** 一行可显示文本;**没有派对时是空串**(调用方据此决定画不画) */
  text: string;
}

/**
 * 下标 → 模式名。
 *
 * 线上 `partyMode` 与 `PARTY_MODES` 是**差一**关系:`0` = 没有派对,
 * `k ≥ 1` 对应 `PARTY_MODES[k - 1]`(见 `ROOM_FIELD_TABLE` 的注释)。
 * 越界下标返回 `null`(而不是猜一个),让调用方显式处理"不认识"。
 */
export function partyModeName(mode: number): string | null {
  if (!Number.isFinite(mode)) return null;
  const i = Math.trunc(mode) - 1;
  if (i < 0 || i >= PARTY_MODES.length) return null;
  return PARTY_MODES[i]?.name ?? null;
}

/** 非负整数化(线上污染值不许把一个 NaN 带进 HUD) */
function nonNeg(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.round(v));
}

/**
 * 房间级 meta → HUD 视图。
 *
 * 语义:
 *   · `mode` 越界 / 为 0 ⇒ `active === false`、`text === ''`(不画);
 *   · 计时**向上取整** —— 剩 0.2 秒时显示 `1s` 而不是 `0s`:显示 0 秒但还没结算
 *     会被读成"卡住了";
 *   · 比分为 0 时**照实显示 0**,不做"省略"或"推断"(省略会让"红队 0 分"和
 *     "比分还没到"变得不可区分)。
 */
export function partyHudOf(meta: PartyMetaInput): PartyHudView {
  const mode = Number.isFinite(meta.partyMode) ? Math.trunc(meta.partyMode) : 0;
  const modeName = partyModeName(mode);
  const timer = Number.isFinite(meta.partyTimer) ? Math.max(0, meta.partyTimer) : 0;
  const scoreA = nonNeg(meta.scoreA);
  const scoreB = nonNeg(meta.scoreB);
  const timerSec = Math.ceil(timer);
  const active = modeName !== null;
  const text = active
    ? `派对 ${modeName} · 剩余 ${timerSec}s · 红 ${scoreA} : ${scoreB} 蓝`
    : '';
  return { mode, modeName, active, timer, timerSec, scoreA, scoreB, text };
}