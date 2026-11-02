/**
 * @module
 * Doom's two tracks, both played as a looping pre-rendered buffer so nothing
 * about the music runs on the main thread: "Synth 2" is scheduled once into an
 * offline context when Doom starts, and "Light 'Em Up, Boyz!" (Freedoom's
 * MAP07, by Lola "BlueWorrior" Harvey and Goji) is a decoded Ogg file. Each
 * time Doom is unmuted one of them is picked at random; `swap` plays the
 * other.
 */
import {
  type AmpSpec,
  amp,
  audio,
  crash,
  fm,
  gt,
  kick,
  output,
  snare,
  sub,
  within,
} from "./engine.ts";

export interface Track {
  id: "synth2" | "map07";
  name: string;
  by: string;
}

export const tracks: Track[] = [
  { id: "synth2", name: "Synth 2", by: "original" },
  {
    id: "map07",
    name: "Light 'Em Up, Boyz!",
    by: "Freedoom, Lola Harvey and Goji",
  },
];

const targetRms = 0.09;

// Synth 2: slow and heavy. 8 bars at 84 bpm (22.9 s), G1 root, long power
// chords, half-time kick and snare, a bell that hangs over the end of each half.
const bpm = 84;
const bars = 8;
const root = 31;
const chords: Record<string, [number, number, number][]> = {
  P: [
    [0, 0, 5],
    [6, 0, 2],
    [8, 3, 5],
    [14, 2, 2],
  ],
  Q: [
    [0, 0, 5],
    [6, 0, 2],
    [8, 5, 4],
    [12, 3, 2],
    [14, 2, 2],
  ],
  X: [
    [0, 0, 3],
    [4, 7, 3],
    [8, 5, 3],
    [12, 3, 3],
  ],
};
const song = ["P", "P", "Q", "P", "P", "P", "Q", "X"];
const guitar: AmpSpec = { k: 3.5, hp: 70, mf: 380, mg: -6, lp: 2200, lv: 0.4 };

const scheduleBar = (bar: number, base: number, chain: AudioNode) => {
  const length = 240 / bpm;
  const step = length / 16;
  const at = (offset: number) => {
    return base + offset;
  };
  const kind = song[bar] ?? "P";

  for (const [start, offset, count] of chords[kind] ?? []) {
    const dur = count * step * 0.95;

    gt(root + offset, at(start * step), dur, 0.2, chain, 0.6);
    sub(root + offset, at(start * step), dur, 0.24);
  }

  kick(at(0), 1);
  kick(at(8 * step), 0.9);

  if (kind === "Q") {
    kick(at(6 * step), 0.7);
  }

  snare(at(8 * step), 1);

  if (bar === 7) {
    for (const start of [12, 13, 14, 15]) {
      snare(at(start * step), 0.6);
    }
  }

  if (bar === 0 || bar === 4) {
    crash(at(0), 2.6, 0.7);
  }

  if (bar === 3 || bar === 7) {
    [24, 27, 31].forEach((offset, index) => {
      fm(root + offset + 12, at(index * 4 * step), 1.1, 0.06, 2, 1.5);
    });
  }
};

/**
 * Scales a buffer to about the same loudness, never past a 0.95 peak.
 */
const normalise = (buffer: AudioBuffer) => {
  let sum = 0;
  let count = 0;
  let peak = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const value of buffer.getChannelData(channel)) {
      sum += value * value;
      count++;
      peak = Math.max(peak, Math.abs(value));
    }
  }

  const gain = Math.min(targetRms / Math.sqrt(sum / count), 0.95 / peak);

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);

    for (let at = 0; at < data.length; at++) {
      data[at] = (data[at] ?? 0) * gain;
    }
  }

  return buffer;
};

/**
 * Schedules every bar once into an offline context and renders it. The three
 * seconds of ring-out past the last bar are folded back onto the start, so
 * the loop has no seam.
 */
const renderSynth = async () => {
  const live = audio();
  const rate = live.sampleRate;
  const length = Math.round(bars * (240 / bpm) * rate);
  const tail = Math.round(3 * rate);
  const offline = new OfflineAudioContext(2, length + tail, rate);
  const bus = offline.createGain();

  bus.connect(offline.destination);
  within(offline, bus, () => {
    const chain = amp(guitar);

    for (let bar = 0; bar < bars; bar++) {
      scheduleBar(bar, bar * (240 / bpm), chain);
    }
  });

  const raw = await offline.startRendering();
  const buffer = live.createBuffer(2, length, rate);

  for (let channel = 0; channel < 2; channel++) {
    const from = raw.getChannelData(channel);
    const to = buffer.getChannelData(channel);

    for (let at = 0; at < length; at++) {
      to[at] = (from[at] ?? 0) + (at < tail ? (from[length + at] ?? 0) : 0);
    }
  }

  return buffer;
};

const decodeFile = async (url: string) => {
  const response = await fetch(url);

  return audio().decodeAudioData(await response.arrayBuffer());
};

const buffers = new Map<Track["id"], Promise<AudioBuffer>>();

const bufferOf = (track: Track) => {
  let ready = buffers.get(track.id);

  if (!ready) {
    ready = (
      track.id === "synth2"
        ? renderSynth()
        : decodeFile("/freedoom/music/map07-loop.ogg")
    ).then(normalise);
    buffers.set(track.id, ready);
    ready.catch(() => {
      buffers.delete(track.id);
    });
  }

  return ready;
};

/**
 * Tells whether a track's buffer is ready to play.
 */
export const isReady = (track: Track) => {
  return buffers.has(track.id);
};

interface Playing {
  bus: GainNode;
  source: AudioBufferSourceNode | null;
}

let playing: Playing | null = null;
let over = false;

/**
 * Starts a track with a half-second fade in. `rendering` is called with true
 * while the track is still being prepared.
 */
export const start = (
  track: Track,
  rendering: (busy: boolean) => void,
): Promise<void> => {
  if (playing) {
    return Promise.resolve();
  }

  const ctx = audio();
  const bus = ctx.createGain();
  const mine: Playing = { bus, source: null };

  playing = mine;
  bus.gain.value = 0;
  bus.connect(output());
  rendering(!buffers.has(track.id));

  return bufferOf(track).then((buffer) => {
    rendering(false);

    if (playing !== mine) {
      return;
    }

    const source = ctx.createBufferSource();
    const t = ctx.currentTime;

    source.buffer = buffer;
    source.loop = true;
    source.connect(bus);
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(over ? 0.12 : 0.55, t + 0.5);
    source.start(t + 0.01);
    mine.source = source;
  });
};

/**
 * Prepares a track in the background, so a swap to it is instant.
 */
export const warm = (track: Track) => {
  void bufferOf(track).catch(() => {});
};

export const stop = () => {
  if (!playing) {
    return;
  }

  const gone = playing;
  const ctx = audio();
  const t = ctx.currentTime;

  playing = null;
  gone.bus.gain.cancelScheduledValues(t);
  gone.bus.gain.setValueAtTime(gone.bus.gain.value, t);
  gone.bus.gain.linearRampToValueAtTime(0, t + 0.06);
  window.setTimeout(() => {
    try {
      gone.source?.stop();
    } catch {
      // Already stopped.
    }

    gone.bus.disconnect();
  }, 120);
};

/**
 * Brings the music to a level over some seconds, such as under the game over
 * screen.
 */
export const duck = (level: number, secs: number) => {
  over = level < 0.3;

  if (!playing) {
    return;
  }

  const ctx = audio();
  const gain = playing.bus.gain;
  const t = ctx.currentTime;

  gain.cancelScheduledValues(t);
  gain.setValueAtTime(gain.value, t);
  gain.linearRampToValueAtTime(level, t + secs);
};

export const isPlaying = () => {
  return playing !== null;
};
