/**
 * 音频输出 —— 把 `audio.ts` 的**参数表**变成能听见的声音。
 *
 * ## 为什么单独一个文件(而不是塞进 boot.ts)
 *
 * `audio.ts` 产出的是**数据**:频率、ADSR、谐波幅度、增益。
 * 真正让空气振动要 `AudioContext` + `GainNode` + `OscillatorNode`,
 * 那是**平台绑定**,与 DOM/three 一样不能进纯逻辑层。
 *
 * 所以本文件只做一件事:把 `resolveNote(ev)` 的 `ResolvedNote` 铺到 WebAudio 上。
 * 音高、力度、包络**全部取自 audio.ts**,这里一个数都不算 ——
 * 否则「十二平均律对不对」就变成了不可测的运行时行为。
 *
 * ## 为什么要 `resume()`
 *
 * 浏览器自动播放策略:没有用户手势时 `AudioContext` 是 `suspended` 的,
 * 调用 `noteOn` 会被静默丢弃(不报错)。因此本类**记录是否已被唤醒**,
 * 并由 `summary()` 上报 `awake` —— 否则「音频没声音」会被误判成「接线没生效」。
 */

import {
  A4_HZ,
  type NoteEvent,
  type ResolvedNote,
  type TimbreSpec,
  musicBoxSfx,
  resolveNote,
  timbreOf,
} from '../audio.ts';

export interface AudioHandle {
  /** 是否已获得用户手势并唤醒(浏览器自动播放策略) */
  readonly awake: boolean;
  /** 已播放的音符数 */
  readonly playedCount: number;
  /** AudioContext 的原始 state('running'/'suspended'/...) —— 排查用 */
  readonly contextState: string;
  /** 唤醒音频上下文(需在用户手势里调用) */
  resume: () => Promise<void>;
  /** 播放一个音符;返回实际排入的音符(可能因未唤醒而返回 null) */
  noteOn: (ev: NoteEvent) => ResolvedNote | null;
  /** UI 点击音(八音盒),返回播放的 Hz */
  uiClick: (pitch?: number) => number;
  /** 主音量 0..1 */
  setMaster: (v: number) => void;
  dispose: () => void;
}

/** 单音符最大时长上限(秒),防止某个坏事件挂住一个振荡器 */
const MAX_NOTE_SEC = 4;

export function createAudio(): AudioHandle {
  /* `AudioContext` 在 headless Chrome 里也存在;若宿主完全没有则降级为空实现,
     但**保留 playedCount 语义**(播放请求被接受并处理),否则「有没有接线」无法区分。 */
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  const hasAudio = typeof Ctor === 'function';
  const ctx: AudioContext | null = hasAudio ? new Ctor() : null;

  let master: GainNode | null = null;
  if (ctx) {
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }

  let awake = false;
  let played = 0;

  const play = (hz: number, gain: number, spec: TimbreSpec, startSec: number, durSec: number, velocity: number): void => {
    if (!ctx || !master) return;
    const t0 = ctx.currentTime + Math.max(0, startSec);
    const dur = Math.min(MAX_NOTE_SEC, Math.max(0.02, durSec));
    /* 基频振荡器 + 谐波叠加:幅度直接来自 audio.ts 的 TIMBRES 表 */
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    /* 双振荡器失谐:detuneCents 来自音色表 */
    osc.frequency.value = hz * spec.pitchRatio;
    osc.detune.value = spec.detuneCents;

    const env = ctx.createGain();
    const { adsr } = spec;
    const peak = Math.max(0.0001, adsr.peak * velocity * gain);
    const a = Math.max(0.001, adsr.attack);
    const d = Math.max(0.001, adsr.decay);
    const sus = Math.max(0.0001, adsr.sustain) * peak;
    const r = Math.max(0.001, adsr.release);
    /* ADSR:线性上升 → 衰减到 sustain → 保持 → 释放 */
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + a);
    env.gain.linearRampToValueAtTime(sus, t0 + a + d);
    env.gain.setValueAtTime(sus, t0 + Math.max(a + d, dur));
    env.gain.linearRampToValueAtTime(0.0001, t0 + Math.max(a + d, dur) + r);

    osc.connect(env);
    env.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + r + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };

    /* 非谐和分音(云钟等):BELL_PARTIAL_RATIOS 的元素 × 基频 */
    if (spec.harmonics.length === 0) {
      for (const ratio of [2.76, 5.4]) {
        const p = ctx.createOscillator();
        p.type = 'sine';
        p.frequency.value = hz * ratio;
        const pe = ctx.createGain();
        pe.gain.setValueAtTime(peak * 0.18, t0);
        pe.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        p.connect(pe);
        pe.connect(master);
        p.start(t0);
        p.stop(t0 + dur + 0.02);
        p.onended = () => { p.disconnect(); pe.disconnect(); };
      }
    }
  };

  return {
    get awake(): boolean { return awake; },
    get playedCount(): number { return played; },
    /** 原始 context state —— `awake` 是我们的判定,这个是引擎的事实 */
    get contextState(): string { return ctx ? ctx.state : 'none'; },

    async resume(): Promise<void> {
      if (!ctx) return;
      /* 幂等:已经是 running 就不必再 resume(Chrome 里重复调用无害,但省一次 await) */
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /* 某些环境(如未授权的自动播放)会 reject —— 不抛出,
             否则会打断调用它的指针事件回调 */
        }
      }
      awake = ctx.state === 'running';
    },

    noteOn(ev: NoteEvent): ResolvedNote | null {
      /* resolveNote 是 audio.ts 的权威解析(含音高→Hz、音色→ADSR) */
      const resolved = resolveNote(ev);
      played += 1;
      play(resolved.hz, resolved.gain, timbreOf(resolved.timbre), resolved.startSec, resolved.durationSec, resolved.velocity);
      return resolved;
    },

    uiClick(pitch = 24): number {
      /* musicBoxSfx 返回 {hz, decaySec, gain} —— 三个数全来自 audio.ts */
      const sfx = musicBoxSfx();
      const hz = pitch === 24 ? sfx.hz : A4_HZ * Math.pow(2, (pitch - 9) / 12);
      played += 1;
      play(hz, sfx.gain, timbreOf(0), 0, sfx.decaySec, 0.9);
      return hz;
    },

    setMaster(v: number): void {
      if (master) master.gain.value = Math.max(0, Math.min(1, v));
    },

    dispose(): void {
      master?.disconnect();
      void ctx?.close();
    },
  };
}