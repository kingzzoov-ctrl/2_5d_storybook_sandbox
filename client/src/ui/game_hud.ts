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
}

/** 快捷栏格数。 */
export const HOTBAR_SLOTS = 8;
/** 快捷栏一格的边长(CSS 像素)。 */
const HOTBAR_CELL_PX = 46;

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
      const hotbar = mk('display:flex;gap:4px;padding:5px;border-radius:12px;'
        + 'background:rgba(62,39,35,.82);border:2px solid #f6d9a8;', bar);
      const bagText = mk('font-size:11px;opacity:.9;text-shadow:0 1px 2px #3e2723;', bar);

      els = { meName, meFill, meText, target, targetName, targetFill, prompt, toast, hotbar, bagText, heldText };
    },

    hitAt(x, y): boolean {
      if (els === null) return false;
      const inside = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      return (els.prompt.style.display !== 'none' && inside(els.prompt)) || inside(els.hotbar);
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
      const sig = `${view.heldItemId}|${view.bagCapacity}|${view.bag.map((b) => `${b.id}x${b.count}`).join(',')}`;
      if (sig !== hotbarSig) {
        hotbarSig = sig;
        const doc = els.hotbar.ownerDocument;
        els.hotbar.textContent = '';
        for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
          const it = view.bag[i];
          const cell = doc.createElement('div');
          const on = it !== undefined && it.id === view.heldItemId;
          cell.style.cssText = `position:relative;width:${HOTBAR_CELL_PX}px;height:${HOTBAR_CELL_PX}px;`
            + `border-radius:8px;background:rgba(255,248,236,${on ? '.95' : '.16'});`
            + `border:2px solid ${on ? '#ffd166' : 'rgba(246,217,168,.45)'};`
            + (on ? 'box-shadow:0 0 0 2px #3e2723;' : '') + (it === undefined ? '' : 'cursor:pointer;');
          if (it !== undefined) {
            const icon = doc.createElement('div');
            icon.style.cssText = `position:absolute;inset:0;${itemIconStyle(it.id, HOTBAR_CELL_PX - 4)}`;
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
