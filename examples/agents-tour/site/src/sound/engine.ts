/**
 * @module
 * The sound engine: one Web Audio context made on the first click of the
 * speaker, and the small voices every style is built from (tones, noise,
 * drums, a guitar-like drive chain and a two-operator FM voice). Nothing is
 * created before `ensure` runs, so nothing can play before the reader asks.
 */

export interface Rig {
  ctx: BaseAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
  chains: Record<string, AudioNode>;
}

export interface LiveRig extends Rig {
  ctx: AudioContext;
}

let live: LiveRig | null = null;
let current: Rig | null = null;

export const midi = (note: number) => {
  return 440 * 2 ** ((note - 69) / 12);
};

const makeNoise = (ctx: BaseAudioContext) => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let at = 0; at < data.length; at++) {
    data[at] = Math.random() * 2 - 1;
  }

  return buffer;
};

/**
 * The context, made on first use. Call it from a click.
 */
export const ensure = () => {
  if (live) {
    return live;
  }

  const ctx = new AudioContext({ latencyHint: "playback" });
  const master = ctx.createDynamicsCompressor();
  const level = ctx.createGain();

  level.gain.value = 0.5;
  master.connect(level);
  level.connect(ctx.destination);
  live = { ctx, out: master, noise: makeNoise(ctx), chains: {} };
  current = live;

  return live;
};

export const liveRig = () => {
  return live;
};

const rig = () => {
  if (!current) {
    throw new Error("The sound engine is not started");
  }

  return current;
};

export const audio = () => {
  return rig().ctx;
};

export const output = () => {
  return rig().out;
};

/**
 * Runs `build` with another context and output in place of the live ones, so
 * a track can be scheduled into an offline context with the same voices.
 */
export const within = <T>(
  ctx: BaseAudioContext,
  out: AudioNode,
  build: () => T,
) => {
  const saved = current;

  current = { ctx, out, noise: makeNoise(ctx), chains: {} };

  try {
    return build();
  } finally {
    current = saved;
  }
};

/**
 * One note: a note number, a start offset in seconds, a length, a wave and a
 * gain, with an optional slide target and output.
 */
export const tone = (
  note: number,
  at: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slide?: number | null,
  out?: AudioNode | null,
) => {
  const { ctx, out: master } = rig();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(midi(note), t);

  if (slide != null) {
    osc.frequency.exponentialRampToValueAtTime(midi(slide), t + dur);
  }

  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp);
  amp.connect(out ?? master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
};

export const hiss = (
  at: number,
  dur: number,
  gain: number,
  freq: number,
  type: BiquadFilterType = "highpass",
  out?: AudioNode | null,
) => {
  const { ctx, out: master, noise } = rig();
  const t = ctx.currentTime + at;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();

  source.buffer = noise;
  filter.type = type;
  filter.frequency.value = freq;
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  source.connect(filter);
  filter.connect(amp);
  amp.connect(out ?? master);
  source.start(t);
  source.stop(t + dur + 0.05);
};

export const seq = (
  notes: (number | null)[],
  step: number,
  dur: number,
  type: OscillatorType,
  gain: number,
) => {
  notes.forEach((note, at) => {
    if (note != null) {
      tone(note, at * step, dur, type, gain);
    }
  });
};

export interface AmpSpec {
  // High-pass before the clip, the clip's drive, a mid band, a low-pass, and
  // the level after the clip.
  hp: number;
  k: number;
  mf: number;
  mg: number;
  lp: number;
  lv: number;
}

/**
 * A drive chain: high-pass, clip, mid band, low-pass, level. The level is set
 * after the clip, so a hit's own gain changes volume and not distortion.
 */
export const amp = (spec: AmpSpec): AudioNode => {
  const { ctx, out } = rig();
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  const shaper = ctx.createWaveShaper();
  const mid = ctx.createBiquadFilter();
  const lp = ctx.createBiquadFilter();
  const level = ctx.createGain();
  const size = 1024;
  const curve = new Float32Array(size);

  hp.type = "highpass";
  hp.frequency.value = spec.hp;

  for (let at = 0; at < size; at++) {
    curve[at] = Math.tanh(((at * 2) / size - 1) * spec.k);
  }

  shaper.curve = curve;
  shaper.oversample = "4x";
  mid.type = "peaking";
  mid.frequency.value = spec.mf;
  mid.gain.value = spec.mg;
  mid.Q.value = 0.9;
  lp.type = "lowpass";
  lp.frequency.value = spec.lp;
  lp.Q.value = 0.5;
  level.gain.value = spec.lv;
  input.connect(hp);
  hp.connect(shaper);
  shaper.connect(mid);
  mid.connect(lp);
  lp.connect(level);
  level.connect(out);

  return input;
};

/**
 * A hit's way into one shared drive chain per voice. A hit adds a single gain
 * node, so a payoff of many hits never builds a pile of shapers.
 */
export const drive = (key: string, spec: AmpSpec, level: number) => {
  const { ctx, chains } = rig();

  chains[key] ??= amp(spec);

  const gain = ctx.createGain();

  gain.gain.value = level;
  gain.connect(chains[key]);

  return gain;
};

interface NoteOptions {
  // Slide to this frequency over `sl` (default the note's length).
  to?: number;
  sl?: number;
  det?: number;
  // The level the note decays to, as a share of its gain.
  sus?: number;
  // Attack in seconds.
  a?: number;
}

/**
 * A note with a real attack (4 ms), a decay to `sus` and a short release.
 */
export const nt = (
  type: OscillatorType,
  freq: number,
  at: number,
  dur: number,
  gain: number,
  out?: AudioNode | null,
  o: NoteOptions = {},
) => {
  const { ctx, out: master } = rig();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  const attack = o.a ?? 0.004;
  const release = Math.min(0.04, dur * 0.4);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);

  if (o.to) {
    osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.sl ?? dur));
  }

  if (o.det) {
    osc.detune.value = o.det;
  }

  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + attack);
  amp.gain.exponentialRampToValueAtTime(
    Math.max(0.0001, gain * (o.sus ?? 1)),
    t + Math.max(attack + 0.005, dur - release),
  );
  amp.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(amp);
  amp.connect(out ?? master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
};

/**
 * A guitar-like chord: two detuned saws plus the fifth.
 */
export const gt = (
  note: number,
  at: number,
  dur: number,
  gain: number,
  out: AudioNode,
  sus: number,
) => {
  nt("sawtooth", midi(note), at, dur, gain, out, { det: -9, sus });
  nt("sawtooth", midi(note), at, dur, gain, out, { det: 9, sus });
  nt("sawtooth", midi(note + 7), at, dur, gain * 0.7, out, { sus });
};

export const sub = (note: number, at: number, dur: number, gain: number) => {
  nt("sine", midi(note), at, dur, gain, null, { sus: 0.5, a: 0.006 });
};

const dirtyKick: AmpSpec = { k: 4, hp: 30, mf: 200, mg: -3, lp: 2500, lv: 0.5 };

export const kick = (at: number, level: number, dirty = false) => {
  const out = dirty ? drive("kick", dirtyKick, level) : null;

  nt("sine", 160, at, 0.22, 0.5 * level * (dirty ? 0.6 : 1), out, {
    to: 42,
    sl: 0.12,
    sus: 0.3,
    a: 0.002,
  });
  hiss(at, 0.02, 0.06 * level, 2500, "bandpass", out);
};

export const snare = (at: number, level: number) => {
  hiss(at, 0.16, 0.12 * level, 1800, "highpass");
  nt("triangle", 190, at, 0.09, 0.15 * level, null, {
    to: 120,
    a: 0.002,
    sus: 0.2,
  });
};

export const crash = (at: number, dur: number, level: number) => {
  hiss(at, dur, 0.05 * level, 5500);
};

/**
 * A two-operator FM voice.
 */
export const fm = (
  note: number,
  at: number,
  dur: number,
  gain: number,
  ratio: number,
  index: number,
) => {
  const { ctx, out } = rig();
  const freq = midi(note);
  const t = ctx.currentTime + at;
  const carrier = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const depth = ctx.createGain();
  const amp = ctx.createGain();

  carrier.frequency.value = freq;
  modulator.frequency.value = freq * ratio;
  depth.gain.setValueAtTime(freq * index, t);
  depth.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  modulator.connect(depth);
  depth.connect(carrier.frequency);
  carrier.connect(amp);
  amp.connect(out);
  carrier.start(t);
  modulator.start(t);
  carrier.stop(t + dur + 0.02);
  modulator.stop(t + dur + 0.02);
};
