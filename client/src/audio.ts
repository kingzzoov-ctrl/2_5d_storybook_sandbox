/**
 * WS-09 / 八音盒音频 —— 32 音高 × 4 音色频率表 + 混音总线(不 import three,也不用 WebAudio)。
 *
 * 本模块只产出**参数**,不产出声音:装配层(`client/src/three/` 之外运行时)拿这些参数去驱动
 * `OscillatorNode` / `PeriodicWave`。这样测试可以在 node 里断言「频率是否与十二平均律一致」,
 * 而完全不需要音频上下文。
 *
 * 音高编号(冻结):
 *   音高索引 p ∈ [0, 31],对应 MIDI 音号 n = PITCH_BASE_MIDI + p = 60 + p,
 *   即 C4(MIDI 60,261.63Hz)一路到 G6(MIDI 91,1567.98Hz),共 32 个半音。
 *   A4(MIDI 69,440Hz)落在 p = 9。
 *
 * 频率公式(十二平均律,以 A4 = 440Hz 为基准):
 *   f(p) = 440 × 2^((60 + p − 69)/12) = 440 × 2^((p − 9)/12)
 *
 * 校验口径:`f(9) === 440`;`f(21) === 880`(A5,正好一个八度);`f(−3) = 220`(A3,虽越界但公式连续)。
 *
 * 四种音色(手册「乐器战歌」+ 408 共鸣音高传感器 + 611 八音盒音效):
 *   0 八音盒 / 1 琉璃笛 / 2 暖松木吉他 / 3 云钟
 * 音色差异用「谐波幅度表 + ADSR 包络 + 失谐量」三组参数表达,不用采样。
 */

/** 音高数量 */
export const PITCH_COUNT = 32;
/** 基准 MIDI:60 = C4 */
export const PITCH_BASE_MIDI = 60;
/** A4 频率基准 */
export const A4_HZ = 440;
/** A4 的 MIDI 音号 */
export const A4_MIDI = 69;
/** A4 在本系统的音高索引 */
export const A4_PITCH_INDEX = A4_MIDI - PITCH_BASE_MIDI;

/** 十二平均律:音高索引 → 频率(Hz) */
export function pitchFrequency(p: number): number {
  return A4_HZ * Math.pow(2, (p - A4_PITCH_INDEX) / 12);
}

/** MIDI 音号 → 频率 */
export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** 频率 → MIDI 音号(反查,用于音高检测/调音) */
export function hzToMidi(hz: number): number {
  if (!(hz > 0)) return Number.NaN;
  return 12 * Math.log2(hz / A4_HZ) + A4_MIDI;
}

/** 音名(用于 UI 显示 Do Re Mi 与十二音名) */
export const SOLFEGE: readonly string[] = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
export const NOTE_NAMES: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface PitchInfo {
  index: number;
  midi: number;
  hz: number;
  noteName: string;
  solfege: string;
  octave: number;
}

export function pitchInfo(p: number): PitchInfo {
  const midi = PITCH_BASE_MIDI + p;
  const hz = pitchFrequency(p);
  const pc = ((midi % 12) + 12) % 12;
  return {
    index: p,
    midi,
    hz,
    noteName: `${NOTE_NAMES[pc]}${Math.floor(midi / 12) - 1}`,
    solfege: SOLFEGE[pc],
    octave: Math.floor(midi / 12) - 1,
  };
}

/** 32 音高完整表(模块级算一次) */
export const PITCH_TABLE: readonly PitchInfo[] = Array.from({ length: PITCH_COUNT }, (_, i) => pitchInfo(i));

/** 12 平均律的相邻半音比值 */
export const SEMITONE_RATIO = Math.pow(2, 1 / 12);

/** 校验:相邻音高比值必须严格等于 SEMITONE_RATIO */
export function isChromaticTable(table: readonly number[] = PITCH_TABLE.map((p) => p.hz)): boolean {
  for (let i = 1; i < table.length; i += 1) {
    if (Math.abs(table[i] / table[i - 1] - SEMITONE_RATIO) > 1e-12) return false;
  }
  return true;
}

/* ───────────────────────────── 音色 ───────────────────────────── */

export const Timbre = {
  MUSIC_BOX: 0,
  GLASS_FLUTE: 1,
  WOOD_GUITAR: 2,
  CLOUD_BELL: 3,
} as const;
export type Timbre = (typeof Timbre)[keyof typeof Timbre];

export const TIMBRE_COUNT = 4;
export const TIMBRE_NAMES: readonly string[] = ['八音盒', '琉璃笛', '暖松木吉他', '云钟'];

/** ADSR:秒为单位的四个阶段时长 + 峰值电平 */
export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  peak: number;
}

export interface TimbreSpec {
  id: Timbre;
  name: string;
  /** 谐波幅度表:索引 i = 第 (i+1) 次谐波,幅度 0..1 */
  harmonics: readonly number[];
  adsr: Adsr;
  /** 双振荡器失谐量(音分),0 = 单振荡器 */
  detuneCents: number;
  /** 基频倍数(音域平移) */
  pitchRatio: number;
  /** 建议音压级 0..1 */
  gain: number;
}

export const TIMBRES: readonly TimbreSpec[] = [
  {
    id: 0,
    name: '八音盒',
    /* 音乐盒的梳齿音:奇次谐波强、偶次谐波弱,高频段有一根突出的 7 次谐波 */
    harmonics: [1.0, 0.08, 0.55, 0.06, 0.30, 0.04, 0.22, 0.03, 0.12],
    adsr: { attack: 0.004, decay: 0.35, sustain: 0.0, release: 0.45, peak: 0.8 },
    detuneCents: 4,
    pitchRatio: 1,
    gain: 0.55,
  },
  {
    id: 1,
    name: '琉璃笛',
    /* 边棱音:近正弦,只保留 2 次谐波一点点空气感 */
    harmonics: [1.0, 0.18, 0.06, 0.02],
    adsr: { attack: 0.045, decay: 0.10, sustain: 0.72, release: 0.28, peak: 0.85 },
    detuneCents: 0,
    pitchRatio: 1,
    gain: 0.42,
  },
  {
    id: 2,
    name: '暖松木吉他',
    /* 拨弦:低次谐波饱满,并且基频轻微下移(琴弦张力) */
    harmonics: [1.0, 0.62, 0.40, 0.26, 0.16, 0.10, 0.06, 0.04],
    adsr: { attack: 0.008, decay: 0.55, sustain: 0.12, release: 0.38, peak: 0.9 },
    detuneCents: 7,
    pitchRatio: 0.5,
    gain: 0.5,
  },
  {
    id: 3,
    name: '云钟',
    /* 钟体是**非谐**振动体:基频之外的能量全在 2.76f / 5.40f 这类非整数倍位置上,
       整数倍谐波表因此只保留基频,其余由 BELL_PARTIAL_RATIOS 单独驱动 */
    harmonics: [1.0],
    adsr: { attack: 0.002, decay: 1.6, sustain: 0.0, release: 2.2, peak: 0.7 },
    detuneCents: 3,
    pitchRatio: 1,
    gain: 0.6,
  },
];

/** 云钟的非谐分音比例(对 TIMBRES[3] 的补充:钟体基频 + 2.76f + 5.40f) */
export const BELL_PARTIAL_RATIOS: readonly number[] = [2.76, 5.4];

export function timbreOf(id: number): TimbreSpec {
  const i = Math.trunc(id);
  return TIMBRES[i >= 0 && i < TIMBRES.length ? i : 0];
}

/* ───────────────────────────── 音符事件与总线 ───────────────────────────── */

export interface NoteEvent {
  /** 音高索引 0..31 */
  pitch: number;
  /** 音色 0..3 */
  timbre: number;
  /** 起始时间(秒,相对总线当前时间) */
  startSec: number;
  /** 持续时长(秒) */
  durationSec: number;
  /** 力度 0..1 */
  velocity: number;
}

export interface ResolvedNote {
  pitch: number;
  timbre: number;
  hz: number;
  startSec: number;
  durationSec: number;
  velocity: number;
  /** 最终线性增益(含音色 gain 与力度) */
  gain: number;
  adsr: Adsr;
  harmonics: readonly number[];
  detuneCents: number;
}

/** 把音符事件解析成可直接喂给合成器的参数 */
export function resolveNote(ev: NoteEvent): ResolvedNote {
  const t = timbreOf(ev.timbre);
  return {
    pitch: ev.pitch,
    timbre: t.id,
    hz: pitchFrequency(ev.pitch) * t.pitchRatio,
    startSec: Math.max(0, ev.startSec),
    durationSec: Math.max(0, ev.durationSec),
    velocity: Math.min(1, Math.max(0, ev.velocity)),
    gain: t.gain * Math.min(1, Math.max(0, ev.velocity)),
    adsr: t.adsr,
    harmonics: t.harmonics,
    detuneCents: t.detuneCents,
  };
}

/** 总时长 = 音符时长 + release 尾巴 */
export function noteTotalSec(ev: NoteEvent): number {
  const t = timbreOf(ev.timbre);
  return Math.max(0, ev.durationSec) + t.adsr.release;
}

/**
 * 乐器战歌光环混音总线。
 *
 * 规则(手册「乐器战歌」):
 *  - 同一音高在 0.02s 内被多人重复触发时**合并**,只留人数最多的音色(避免 8 人同奏炸成噪音);
 *  - 总线有 8 条音轨上限,超出丢最早的;
 *  - 总线输出做软削波 tanh,防止 8 人同时开大招时爆音削顶。
 */
export class MusicBus {
  private readonly voices: ResolvedNote[];
  private readonly maxVoices: number;
  private level: number;
  private readonly mergeWindowSec: number;

  constructor(maxVoices = 8, mergeWindowSec = 0.02) {
    this.voices = [];
    this.maxVoices = Math.max(1, Math.trunc(maxVoices));
    this.mergeWindowSec = Math.max(0, mergeWindowSec);
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  /**
   * 当前削波后的总线电平。
   *
   * 必须**按需重算**而不是读缓存字段:`push()` / `pushAll()` / `advance()` 都会
   * 改变音轨集合,若只在 `mix()` 里写 `this.level`,那么在首次 `mix()` 之前
   * (或任何一次入轨之后、下一次 mix 之前)读该属性会拿到旧的/未初始化的值 ——
   * 初始状态下甚至是 `undefined`,`bus.masterLevel > 0` 就变成 NaN 比较、
   * 静默为 false,把「电平异常」伪装成「测试写错」。
   * 六个音轨以内开销可忽略(一次遍历 + 一次 tanh)。
   */
  get masterLevel(): number {
    return this.computeLevel();
  }

  /** 纯计算:音轨包络求和后做 tanh 软削波,不改任何状态 */
  private computeLevel(): number {
    let sum = 0;
    for (const v of this.voices) sum += v.adsr.peak * v.gain;
    return Math.tanh(sum);
  }

  get voices$(): readonly ResolvedNote[] {
    return this.voices;
  }

  /** 推入一个音符;返回实际入轨的数量(0 = 被合并丢弃) */
  push(ev: NoteEvent): number {
    const r = resolveNote(ev);
    for (const v of this.voices) {
      if (v.pitch === r.pitch && Math.abs(v.startSec - r.startSec) <= this.mergeWindowSec) {
        /* 合并:取更大力度 */
        if (r.velocity > v.velocity) v.velocity = r.velocity;
        return 0;
      }
    }
    this.voices.push(r);
    if (this.voices.length > this.maxVoices) this.voices.shift();
    return 1;
  }

  /** 批量推入(一次性大招),返回入轨数量 */
  pushAll(events: readonly NoteEvent[]): number {
    let n = 0;
    for (const e of events) n += this.push(e);
    return n;
  }

  /** 混音求和 + tanh 软削波 */
  mix(): number {
    this.level = this.computeLevel();
    return this.level;
  }

  /** 推进到 t 秒:移除已结束的音轨 */
  advance(tSec: number): number {
    let removed = 0;
    for (let i = this.voices.length - 1; i >= 0; i -= 1) {
      const v = this.voices[i];
      if (tSec > v.startSec + v.durationSec + v.adsr.release) {
        this.voices.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.voices.length = 0;
    this.level = 0;
  }
}

/* ───────────────────────────── 音高砖与传感器 ───────────────────────────── */

/** 408 共鸣音高传感器的默认谜题:Do-Mi-Sol = 音高索引 0 / 4 / 7 → 位掩码 */
export const DO_MI_SOL_PITCHES: readonly number[] = [0, 4, 7];

export function pitchMaskOf(pitches: readonly number[]): number {
  let m = 0;
  for (const p of pitches) {
    const i = Math.trunc(p);
    if (i >= 0 && i < PITCH_COUNT) m |= 1 << i;
  }
  return m >>> 0;
}

export function pitchesOfMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < PITCH_COUNT; i += 1) if (((mask >>> i) & 1) === 1) out.push(i);
  return out;
}

/** 序列匹配:玩家依次弹奏的音高是否命中传感器掩码(顺序敏感的「琶音」模式) */
export function matchesArpeggio(mask: number, sequence: readonly number[]): boolean {
  if (sequence.length === 0) return false;
  for (const p of sequence) if (((mask >>> Math.trunc(p)) & 1) === 0) return false;
  return true;
}

/** 单音匹配:任一音在掩码内即触发(「和弦」模式) */
export function matchesAnyPitch(mask: number, pitch: number): boolean {
  const p = Math.trunc(pitch);
  if (p < 0 || p >= PITCH_COUNT) return false;
  return ((mask >>> p) & 1) === 1;
}

/**
 * 八音盒音效参数:611 回声果冻挥剑音效用的短促高音。
 *
 * 默认音高取 **C6(音高索引 24,≈1046.5Hz)** 而非 A5:真实八音盒的梳齿音域集中在
 * C6–C8,这是它听感「清脆」而不是「闷响」的物理原因;放到 C6 才落在高音区。
 */
export function musicBoxSfx(hz = pitchFrequency(24)): { hz: number; decaySec: number; gain: number } {
  return { hz, decaySec: 0.18, gain: 0.35 };
}

/** 音高砖编辑面板的默认 32 格布局(4 组 × 8 音,两行半音阶) */
export const PITCH_BRICK_ROWS = 2;
export const PITCH_BRICK_COLS = 16;

export function pitchBrickPosition(p: number): { row: number; col: number } {
  const i = Math.max(0, Math.min(PITCH_COUNT - 1, Math.trunc(p)));
  return { row: Math.floor(i / PITCH_BRICK_COLS), col: i % PITCH_BRICK_COLS };
}

export function pitchBrickIndex(row: number, col: number): number {
  const r = Math.max(0, Math.min(PITCH_BRICK_ROWS - 1, Math.trunc(row)));
  const c = Math.max(0, Math.min(PITCH_BRICK_COLS - 1, Math.trunc(col)));
  return r * PITCH_BRICK_COLS + c;
}

/** 校验:32 音高表与十二平均律一致,返回偏差最大的音(用于文档 & 测试输出) */
export function worstPitchDeviation(): { index: number; expected: number; actual: number; absError: number } {
  let worst = { index: 0, expected: pitchFrequency(0), actual: PITCH_TABLE[0].hz, absError: 0 };
  for (let p = 0; p < PITCH_COUNT; p += 1) {
    const expected = A4_HZ * Math.pow(2, (p - A4_PITCH_INDEX) / 12);
    const actual = PITCH_TABLE[p].hz;
    const err = Math.abs(actual - expected);
    if (err > worst.absError) worst = { index: p, expected, actual, absError: err };
  }
  return worst;
}