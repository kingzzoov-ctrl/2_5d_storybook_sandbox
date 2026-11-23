/**
 * 玩家 HUD:屏幕上给**玩家**看的那几样东西(血条、目标、提示、飘字)。
 *
 * 与 `#status` / `#hint` / `#hud` 的分工:那三块是**诊断面板**(连接、帧率、拒因),
 * 默认收起,按 ` 或带 `?debug=1` 才出现;本文件画的是任何时候都在的游戏界面。
 * 只读权威快照算出的视图,不持有任何游戏状态。
 */

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

export interface GameHud {
  /** `onPrompt`:情境提示卡被点/按下时调用(手机上它就是那个互动键)。 */
  mount: (root: HTMLElement, onPrompt?: () => void) => void;
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
  } | null = null;
  let lastToast = '';
  let toastUntil = 0;

  return {
    mount(root, onPrompt): void {
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

      const toast = mk(`${S_CARD}bottom:96px;left:50%;transform:translateX(-50%);max-width:88vw;`
        + 'font-size:14px;text-align:center;display:none;', layer);
      const prompt = mk(`${S_CARD}bottom:44px;left:50%;transform:translateX(-50%);max-width:88vw;`
        + 'font-size:14px;font-weight:700;text-align:center;background:rgba(255,248,236,.94);'
        + 'color:#3e2723;border-color:#3e2723;display:none;', layer);

      prompt.style.pointerEvents = 'auto';
      prompt.style.cursor = 'pointer';
      prompt.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onPrompt?.(); });

      els = { meName, meFill, meText, target, targetName, targetFill, prompt, toast };
    },

    hitAt(x, y): boolean {
      if (els === null || els.prompt.style.display === 'none') return false;
      const r = els.prompt.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
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
