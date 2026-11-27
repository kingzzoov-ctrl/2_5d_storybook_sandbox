/**
 * 玩家 HUD:屏幕上给**玩家**看的那几样东西(血条、目标、提示、飘字)。
 *
 * 与 `#status` / `#hint` / `#hud` 的分工:那三块是**诊断面板**(连接、帧率、拒因),
 * 默认收起,按 ` 或带 `?debug=1` 才出现;本文件画的是任何时候都在的游戏界面。
 * 只读权威快照算出的视图,不持有任何游戏状态。
 */

import {
  ATLAS_CELL, ATLAS_IMAGE_H, ATLAS_IMAGE_W, cellCoordsOf, cellIndexFromId,
} from '../stage/assembly_math.ts';
import { ITEM_BY_ID } from '../../../shared/constants/items.ts';

/** HUD 一帧的输入。字段缺失一律用 `null`,不编数字。 */
export interface GameHudView {
  /** 本地玩家;`null` = 权威第一帧还没到 */
  me: { name: string; level: number; hp: number; maxHp: number } | null;
  /** 当前目标(最近的生物);`null` = 附近没有 */
  target: { name: string; hp: number; maxHp: number } | null;
  /** 情境提示(如「按 T 与镇长说话」);空串 = 不显示 */
  prompt: string;
  /** 最近一条反馈(动作回执 / 台词);空串 = 不显示 */
  toast: string;
  /** 背包明细(按物品 id 升序);来自服务端的 `inventory` 帧 */
  bag: readonly { id: number; count: number }[];
  /** 背包总件数容量(0 = 还不知道) */
  bagCapacity: number;
  /** 手上选中的物品 id(0 = 没选) */
  heldItemId: number;
  /** 是否在线;离线时血条位置显示连接状态 */
  online: boolean;
  /** 离线/连接中时的那句话 */
  offlineText: string;
}

/** 飘字停留时长(毫秒)。 */
export const TOAST_MS = 3500;

/** 血量比例,夹在 [0,1];`maxHp <= 0` 视为 0(不除零)。 */
export function hpRatio(hp: number, maxHp: number): number {
  if (!(maxHp > 0) || !Number.isFinite(hp)) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

/** HUD 上玩家能点的东西。 */
export interface GameHudEvents {
  /** 情境提示卡被点(手机上它就是互动键) */
  onPrompt?: () => void;
  /** 快捷栏某一格被点(传物品 id) */
  onSelectItem?: (itemId: number) => void;
  /** 触屏互动按钮被点(传对应的键名 `e` 采集 / `f` 拾取);不给 ⇒ 不显示按钮(键盘设备) */
  onAction?: (key: 'e' | 'f') => void;
}

/** 快捷栏格数。 */
export const HOTBAR_SLOTS = 8;
/** 快捷栏一格的最大边长(CSS 像素);窄屏按屏宽缩小,见 `hotbarCellPx`。 */
const HOTBAR_CELL_MAX_PX = 46;
/** 快捷栏格子的最小边长:再小图标就看不清了。 */
const HOTBAR_CELL_MIN_PX = 30;
/** 快捷栏格间距 / 外框内边距+边框 / 两侧留白(CSS 像素),与下面的样式串同一份数。 */
const HOTBAR_GAP_PX = 4;
const HOTBAR_FRAME_PX = 14;
const HOTBAR_SIDE_MARGIN_PX = 12;

/**
 * 按屏宽算快捷栏一格的边长:8 格 + 7 道间距 + 外框 + 两侧留白必须塞进屏宽。
 * 390 宽的手机算出 40(固定 46 会超出 ~30px,最后一格被屏幕边缘截掉)。
 */
export function hotbarCellPx(viewportW: number): number {
  if (!Number.isFinite(viewportW) || viewportW <= 0) return HOTBAR_CELL_MAX_PX;
  const room = viewportW - 2 * HOTBAR_SIDE_MARGIN_PX - HOTBAR_FRAME_PX - (HOTBAR_SLOTS - 1) * HOTBAR_GAP_PX;
  return Math.max(HOTBAR_CELL_MIN_PX, Math.min(HOTBAR_CELL_MAX_PX, Math.floor(room / HOTBAR_SLOTS)));
}

/** 物品图标的内联样式(图集里没有这件 ⇒ 空串,格子只显示底色)。 */
export function itemIconStyle(itemId: number, px: number): string {
  const cell = cellIndexFromId(itemId);
  if (cell < 0) return '';
  const { col, row } = cellCoordsOf(cell);
  const k = px / ATLAS_CELL;
  return `background-image:url(atlas_sprites.png);background-repeat:no-repeat;`
    + `background-size:${ATLAS_IMAGE_W * k}px ${ATLAS_IMAGE_H * k}px;`
    + `background-position:-${col * px}px -${row * px}px;image-rendering:pixelated;`;
}

export interface GameHud {
  mount: (root: HTMLElement, events?: GameHudEvents) => void;
  /** 这个屏幕点是不是落在提示卡上(给「UI 先于摇杆/攻击」的互斥判定用)。 */
  hitAt: (x: number, y: number) => boolean;
  update: (view: GameHudView, nowMs: number) => void;
}

const S_ROOT = 'position:fixed;inset:0;pointer-events:none;z-index:20;'
  + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;color:#fff8ec;";
const S_CARD = 'position:absolute;background:rgba(62,39,35,.82);border:2px solid #f6d9a8;'
  + 'border-radius:14px;padding:8px 12px;box-shadow:0 3px 0 rgba(62,39,35,.5);';
const S_BAR = 'height:12px;border-radius:6px;background:rgba(0,0,0,.35);overflow:hidden;margin-top:5px;';

export function createGameHud(): GameHud {
  let els: {
    meName: HTMLElement; meFill: HTMLElement; meText: HTMLElement;
    target: HTMLElement; targetName: HTMLElement; targetFill: HTMLElement;
    prompt: HTMLElement; toast: HTMLElement;
    hotbar: HTMLElement; bagText: HTMLElement; heldText: HTMLElement;
    actionBtns: HTMLElement[];
  } | null = null;
  let hotbarSig = '';
  let onSelect: ((itemId: number) => void) | undefined;
  let lastToast = '';
  let toastUntil = 0;

  return {
    mount(root, events): void {
      if (els !== null) return;
      const doc = root.ownerDocument;
      const mk = (css: string, parent: HTMLElement): HTMLElement => {
        const e = doc.createElement('div');
        e.style.cssText = css;
        parent.appendChild(e);
        return e;
      };
      const layer = mk(S_ROOT, root);
      layer.id = 'gamehud';

      const me = mk(`${S_CARD}top:10px;left:10px;width:min(46vw,220px);`, layer);
      me.id = 'gh_me';
      const meName = mk('font-size:14px;font-weight:700;', me);
      const meFill = mk('height:100%;background:#ff7a7a;border-radius:6px;width:0;', mk(S_BAR, me));
      const meText = mk('font-size:12px;margin-top:3px;opacity:.9;', me);

      const target = mk(`${S_CARD}top:10px;left:50%;transform:translateX(-50%);width:min(40vw,240px);`
        + 'text-align:center;display:none;', layer);
      target.id = 'gh_target';
      const targetName = mk('font-size:13px;font-weight:700;', target);
      const targetFill = mk('height:100%;background:#ffb347;border-radius:6px;width:0;', mk(S_BAR, target));

      const toast = mk(`${S_CARD}bottom:176px;left:50%;transform:translateX(-50%);max-width:88vw;`
        + 'font-size:14px;text-align:center;display:none;', layer);
      const prompt = mk(`${S_CARD}bottom:124px;left:50%;transform:translateX(-50%);max-width:88vw;`
        + 'font-size:14px;font-weight:700;text-align:center;background:rgba(255,248,236,.94);'
        + 'color:#3e2723;border-color:#3e2723;display:none;', layer);

      prompt.style.pointerEvents = 'auto';
      prompt.style.cursor = 'pointer';
      prompt.addEventListener('pointerdown', (ev) => { ev.preventDefault(); events?.onPrompt?.(); });
      onSelect = events?.onSelectItem;

      /* 快捷栏:背包里前 8 种物品,点一下 = 拿在手上。 */
      const bar = mk('position:absolute;bottom:8px;left:50%;transform:translateX(-50%);'
        + 'display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:auto;', layer);
      bar.id = 'gh_hotbar';
      const heldText = mk('font-size:12px;font-weight:700;text-shadow:0 1px 2px #3e2723,0 0 4px #3e2723;', bar);
      const hotbar = mk(`display:flex;gap:${HOTBAR_GAP_PX}px;padding:5px;border-radius:12px;`
        + 'background:rgba(62,39,35,.82);border:2px solid #f6d9a8;', bar);
      const bagText = mk('font-size:11px;opacity:.9;text-shadow:0 1px 2px #3e2723;', bar);

      /* 触屏互动按钮:手机没有 E / F 键,不加的话砍不了树、捡不了掉落。
         点下去由调用方派发同一个键盘事件 ⇒ 与键盘走同一条动作链路。 */
      const actionBtns: HTMLElement[] = [];
      const onAction = events?.onAction;
      if (onAction !== undefined) {
        const defs: readonly { key: 'e' | 'f'; text: string; bottom: number }[] = [
          { key: 'e', text: '采集', bottom: 104 },
          { key: 'f', text: '拾取', bottom: 172 },
        ];
        for (const d of defs) {
          const b = mk(`position:absolute;right:12px;bottom:${d.bottom}px;width:56px;height:56px;`
            + 'border-radius:50%;display:flex;align-items:center;justify-content:center;'
            + 'font-size:15px;font-weight:800;background:rgba(255,248,236,.94);color:#3e2723;'
            + 'border:3px solid #3e2723;box-shadow:0 3px 0 rgba(62,39,35,.5);'
            + 'pointer-events:auto;cursor:pointer;-webkit-user-select:none;user-select:none;', layer);
          b.textContent = d.text;
          b.setAttribute('role', 'button');
          b.setAttribute('aria-label', d.text);
          b.dataset.actionKey = d.key;
          b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); onAction(d.key); });
          actionBtns.push(b);
        }
      }

      els = { meName, meFill, meText, target, targetName, targetFill, prompt, toast, hotbar, bagText, heldText, actionBtns };
    },

    hitAt(x, y): boolean {
      if (els === null) return false;
      const inside = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      return (els.prompt.style.display !== 'none' && inside(els.prompt)) || inside(els.hotbar)
        || els.actionBtns.some(inside);
    },

    update(view, nowMs): void {
      if (els === null) return;
      if (view.me === null || !view.online) {
        els.meName.textContent = view.online ? '进入世界中…' : view.offlineText;
        els.meFill.style.width = '0';
        els.meText.textContent = '';
      } else {
        els.meName.textContent = `Lv.${view.me.level} ${view.me.name}`;
        els.meFill.style.width = `${(hpRatio(view.me.hp, view.me.maxHp) * 100).toFixed(1)}%`;
        els.meText.textContent = `${Math.max(0, Math.round(view.me.hp))} / ${Math.round(view.me.maxHp)}`;
      }

      if (view.target === null) {
        els.target.style.display = 'none';
      } else {
        els.target.style.display = 'block';
        els.targetName.textContent = view.target.name;
        els.targetFill.style.width = `${(hpRatio(view.target.hp, view.target.maxHp) * 100).toFixed(1)}%`;
      }

      /* 快捷栏只在内容变了的时候重建(每帧重建会吞掉点击)。 */
      const cellPx = hotbarCellPx(els.hotbar.ownerDocument.defaultView?.innerWidth ?? 0);
      const sig = `${cellPx}|${view.heldItemId}|${view.bagCapacity}|${view.bag.map((b) => `${b.id}x${b.count}`).join(',')}`;
      if (sig !== hotbarSig) {
        hotbarSig = sig;
        const doc = els.hotbar.ownerDocument;
        els.hotbar.textContent = '';
        for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
          const it = view.bag[i];
          const cell = doc.createElement('div');
          const on = it !== undefined && it.id === view.heldItemId;
          cell.style.cssText = `position:relative;width:${cellPx}px;height:${cellPx}px;`
            + `border-radius:8px;background:rgba(255,248,236,${on ? '.95' : '.16'});`
            + `border:2px solid ${on ? '#ffd166' : 'rgba(246,217,168,.45)'};`
            + (on ? 'box-shadow:0 0 0 2px #3e2723;' : '') + (it === undefined ? '' : 'cursor:pointer;');
          if (it !== undefined) {
            const icon = doc.createElement('div');
            icon.style.cssText = `position:absolute;inset:0;${itemIconStyle(it.id, cellPx - 4)}`;
            cell.appendChild(icon);
            if (it.count > 1) {
              const n = doc.createElement('div');
              n.textContent = String(it.count);
              n.style.cssText = 'position:absolute;right:2px;bottom:0;font-size:12px;font-weight:800;'
                + 'color:#fff;text-shadow:0 1px 0 #3e2723,1px 0 0 #3e2723,-1px 0 0 #3e2723,0 -1px 0 #3e2723;';
              cell.appendChild(n);
            }
            cell.title = ITEM_BY_ID.get(it.id)?.name ?? `#${it.id}`;
            const id = it.id;
            cell.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onSelect?.(id); });
          }
          els.hotbar.appendChild(cell);
        }
        const total = view.bag.reduce((a, b) => a + b.count, 0);
        const more = view.bag.length > HOTBAR_SLOTS ? ` · 另有 ${view.bag.length - HOTBAR_SLOTS} 种在包里` : '';
        els.bagText.textContent = view.bagCapacity > 0 ? `背包 ${total} / ${view.bagCapacity} 件${more}` : '';
        els.heldText.textContent = view.heldItemId > 0
          ? `手持:${ITEM_BY_ID.get(view.heldItemId)?.name ?? `#${view.heldItemId}`}`
          : '';
      }

      els.prompt.style.display = view.prompt === '' ? 'none' : 'block';
      els.prompt.textContent = view.prompt;

      if (view.toast !== lastToast) {
        lastToast = view.toast;
        toastUntil = view.toast === '' ? 0 : nowMs + TOAST_MS;
        els.toast.textContent = view.toast;
      }
      els.toast.style.display = nowMs < toastUntil ? 'block' : 'none';
    },
  };
}
