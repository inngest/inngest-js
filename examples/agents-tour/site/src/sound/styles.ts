/**
 * @module
 * The five sound styles, in the order of the menu: Soft (the default), Quest,
 * Chiptune, Kalimba and Doom. Each one answers every moment with a short
 * sound, built from the voices in `engine.ts`. Payoffs are louder than
 * ordinary news, and quiet moments are quieter still.
 */
import {
  type AmpSpec,
  crash,
  drive,
  fm,
  gt,
  hiss,
  kick,
  midi,
  nt,
  seq,
  snare,
  sub,
  tone,
} from "./engine.ts";
import type { Moment } from "./moments.ts";

export type StyleId = "soft" | "quest" | "chip" | "kalimba" | "doom";

// What the page does on top of the sound, for payoffs and failures.
export type Fx = "none" | "confetti" | "scan" | "ripple" | "shake";

type Voice = (gain: number) => void;

export interface Style {
  id: StyleId;
  name: string;
  fx: Fx;
  sounds: Record<Moment, Voice>;
}

// How loud a moment is: quiet, normal, or a payoff.
export const weights: Record<Moment, number> = {
  run: 0.5,
  runDone: 0.85,
  runFail: 0.85,
  checkPass: 1.2,
  checkFail: 0.85,
  next: 0.5,
  prev: 0.5,
  moduleDone: 1.2,
  message: 0.5,
  tool: 0.5,
  reply: 0.85,
  agentDone: 0.85,
  enable: 0.85,
  disable: 0.85,
};

const pluck = (note: number, at: number, gain: number) => {
  tone(note, at, 0.5, "triangle", gain);
  tone(note + 12, at, 0.15, "sine", gain * 0.4);
  tone(note + 19.02, at, 0.08, "sine", gain * 0.2);
};

const drop = (at: number, gain: number) => {
  tone(96, at, 0.12, "sine", gain, 72);
  hiss(at, 0.03, gain * 0.3, 4000, "bandpass");
};

const soft: Style = {
  id: "soft",
  name: "Soft",
  fx: "none",
  sounds: {
    run: (g) => {
      tone(79, 0, 0.07, "sine", 0.06 * g);
    },
    runDone: (g) => {
      seq([76, 83], 0.07, 0.18, "sine", 0.08 * g);
    },
    runFail: (g) => {
      tone(64, 0, 0.25, "sine", 0.09 * g, 59);
    },
    checkPass: (g) => {
      seq([72, 76, 79, 84], 0.075, 0.5, "sine", 0.07 * g);
    },
    checkFail: (g) => {
      seq([67, 62], 0.09, 0.18, "sine", 0.08 * g);
    },
    next: (g) => {
      tone(84, 0, 0.05, "sine", 0.04 * g);
    },
    prev: (g) => {
      tone(79, 0, 0.05, "sine", 0.04 * g);
    },
    moduleDone: (g) => {
      seq([72, 79, 84, 88], 0.1, 0.7, "sine", 0.07 * g);
      tone(60, 0, 0.9, "sine", 0.05 * g);
    },
    message: (g) => {
      tone(88, 0, 0.09, "sine", 0.045 * g);
    },
    tool: (g) => {
      tone(81, 0, 0.04, "triangle", 0.05 * g);
    },
    reply: (g) => {
      seq([79, 84], 0.06, 0.12, "sine", 0.05 * g);
    },
    agentDone: (g) => {
      seq([79, 76, 72], 0.09, 0.3, "sine", 0.06 * g);
    },
    enable: (g) => {
      tone(84, 0, 0.08, "sine", 0.07 * g);
    },
    disable: (g) => {
      seq([84, 76], 0.07, 0.18, "sine", 0.07 * g);
    },
  },
};

const quest: Style = {
  id: "quest",
  name: "Quest",
  fx: "confetti",
  sounds: {
    run: (g) => {
      tone(84, 0, 0.15, "triangle", 0.07 * g);
      tone(91, 0.05, 0.2, "sine", 0.04 * g);
    },
    runDone: (g) => {
      seq([72, 76, 79], 0.07, 0.35, "triangle", 0.1 * g);
    },
    runFail: (g) => {
      seq([64, 63, 60], 0.11, 0.3, "triangle", 0.1 * g);
    },
    checkPass: (g) => {
      seq([60, 64, 67, 72, 76, 79, 84], 0.055, 0.45, "triangle", 0.09 * g);

      for (const note of [72, 76, 79, 84]) {
        tone(note, 0.4, 0.9, "triangle", 0.07 * g);
      }

      tone(96, 0.45, 0.8, "sine", 0.05 * g);
      tone(100, 0.5, 0.7, "sine", 0.03 * g);
    },
    checkFail: (g) => {
      seq([67, 64], 0.12, 0.35, "triangle", 0.09 * g);
    },
    next: (g) => {
      tone(88, 0, 0.12, "sine", 0.05 * g);
    },
    prev: (g) => {
      tone(83, 0, 0.12, "sine", 0.05 * g);
    },
    moduleDone: (g) => {
      seq([67, 72, 76, 79, 84, 88, 91], 0.07, 0.5, "triangle", 0.09 * g);

      for (const note of [72, 79, 84, 88, 96]) {
        tone(note, 0.55, 1.1, "triangle", 0.07 * g);
      }
    },
    message: (g) => {
      tone(96, 0, 0.3, "sine", 0.06 * g);
      tone(103, 0.07, 0.3, "sine", 0.04 * g);
    },
    tool: (g) => {
      seq([79, 86], 0.05, 0.15, "triangle", 0.06 * g);
    },
    reply: (g) => {
      seq([76, 79, 83], 0.06, 0.2, "triangle", 0.07 * g);
    },
    agentDone: (g) => {
      seq([72, 79, 84], 0.09, 0.5, "triangle", 0.09 * g);
    },
    enable: (g) => {
      seq([79, 84, 88], 0.06, 0.25, "triangle", 0.08 * g);
    },
    disable: (g) => {
      seq([84, 79, 72], 0.07, 0.3, "triangle", 0.08 * g);
    },
  },
};

const chip: Style = {
  id: "chip",
  name: "Chiptune",
  fx: "scan",
  sounds: {
    run: (g) => {
      tone(72, 0, 0.08, "square", 0.05 * g, 84);
    },
    runDone: (g) => {
      seq([72, 76, 79, 84], 0.06, 0.08, "square", 0.06 * g);
    },
    runFail: (g) => {
      tone(60, 0, 0.3, "square", 0.07 * g, 36);
    },
    checkPass: (g) => {
      seq([67, 72, 76, 79, 84, 88, 91, 96], 0.06, 0.1, "square", 0.06 * g);
      seq([55, 60, 64, 67, 72, 76, 79, 84], 0.06, 0.1, "triangle", 0.1 * g);
      tone(96, 0.55, 0.4, "square", 0.05 * g);
    },
    checkFail: (g) => {
      tone(55, 0, 0.12, "square", 0.07 * g);
      tone(48, 0.13, 0.2, "square", 0.07 * g);
    },
    next: (g) => {
      tone(79, 0, 0.04, "square", 0.035 * g);
    },
    prev: (g) => {
      tone(72, 0, 0.04, "square", 0.035 * g);
    },
    moduleDone: (g) => {
      seq(
        [60, 64, 67, 72, 60, 64, 67, 72, 76, 79, 84, 88, 91],
        0.07,
        0.1,
        "square",
        0.055 * g,
      );
      seq([48, 48, 55, 55, 60, 60, 64, 64], 0.1, 0.12, "triangle", 0.1 * g);
      tone(96, 0.95, 0.5, "square", 0.05 * g);
    },
    message: (g) => {
      seq([91, 96], 0.05, 0.05, "square", 0.035 * g);
    },
    tool: (g) => {
      tone(84, 0, 0.06, "square", 0.04 * g, 91);
    },
    reply: (g) => {
      seq([76, 83], 0.05, 0.06, "square", 0.045 * g);
    },
    agentDone: (g) => {
      seq([84, 79, 84, 91], 0.07, 0.09, "square", 0.05 * g);
    },
    enable: (g) => {
      seq([72, 84], 0.05, 0.06, "square", 0.05 * g);
    },
    disable: (g) => {
      seq([84, 76, 67], 0.05, 0.07, "square", 0.05 * g);
    },
  },
};

const kalimba: Style = {
  id: "kalimba",
  name: "Kalimba",
  fx: "ripple",
  sounds: {
    run: (g) => {
      pluck(67, 0, 0.05 * g);
    },
    runDone: (g) => {
      pluck(72, 0, 0.07 * g);
      pluck(79, 0.08, 0.07 * g);
    },
    runFail: (g) => {
      pluck(65, 0, 0.07 * g);
      pluck(58, 0.12, 0.07 * g);
    },
    checkPass: (g) => {
      [60, 62, 64, 67, 69, 72, 74, 79].forEach((note, at) => {
        pluck(note, at * 0.06, 0.08 * g);
      });

      for (const note of [72, 76, 79, 84]) {
        pluck(note, 0.55, 0.07 * g);
      }
    },
    checkFail: (g) => {
      pluck(62, 0, 0.07 * g);
      pluck(57, 0.1, 0.07 * g);
    },
    next: (g) => {
      pluck(76, 0, 0.035 * g);
    },
    prev: (g) => {
      pluck(72, 0, 0.035 * g);
    },
    moduleDone: (g) => {
      [60, 64, 67, 72, 76, 79, 84, 88].forEach((note, at) => {
        pluck(note, at * 0.07, 0.08 * g);
      });
      [72, 79, 84, 91].forEach((note, at) => {
        pluck(note, 0.65 + at * 0.05, 0.07 * g);
      });
    },
    message: (g) => {
      drop(0, 0.06 * g);
    },
    tool: (g) => {
      pluck(81, 0, 0.05 * g);
      pluck(76, 0.06, 0.04 * g);
    },
    reply: (g) => {
      pluck(72, 0, 0.06 * g);
      pluck(76, 0.07, 0.06 * g);
      pluck(79, 0.14, 0.06 * g);
    },
    agentDone: (g) => {
      [79, 76, 72].forEach((note, at) => {
        pluck(note, at * 0.1, 0.07 * g);
      });
    },
    enable: (g) => {
      pluck(72, 0, 0.07 * g);
      pluck(79, 0.07, 0.07 * g);
    },
    disable: (g) => {
      pluck(79, 0, 0.07 * g);
      pluck(72, 0.07, 0.07 * g);
    },
  },
};

// Doom's guitar: a tight thrash gallop with bite around 1.4 kHz.
const root = 40;
const guitar: AmpSpec = { k: 6, hp: 110, mf: 1400, mg: 3, lp: 3200, lv: 0.3 };

const hit = (offset: number, at: number, dur: number, volume: number) => {
  gt(
    root + offset,
    at,
    Math.max(0.04, dur),
    0.18,
    drive("a2", guitar, volume),
    0.8,
  );
  sub(root + offset, at, dur, 0.1 * volume);
};

const doom: Style = {
  id: "doom",
  name: "Doom",
  fx: "shake",
  sounds: {
    run: (g) => {
      hiss(0, 0.14, 0.2 * g, 900, "bandpass");
      kick(0, 0.8 * g, true);
    },
    runDone: (g) => {
      hit(0, 0, 0.1, 0.8 * g);
      hit(7, 0.1, 0.22, 0.9 * g);
    },
    runFail: (g) => {
      [
        [0, 0],
        [0, 0.07],
        [-2, 0.15],
        [-4, 0.25],
        [-7, 0.38],
      ].forEach(([offset, at], index) => {
        hit(offset ?? 0, at ?? 0, 0.08, 0.9 * g);

        if (index % 2 === 0) {
          kick(at ?? 0, 0.6 * g);
        }
      });
    },
    checkPass: (g) => {
      [0, 0, 0, 0, 0, 0, 3, 3, 0, 0].forEach((offset, index) => {
        hit(offset, index * 0.065, 0.055, g);

        if (index % 2 === 0) {
          kick(index * 0.065, 0.7 * g);
        }
      });
      snare(0.26, g);
      snare(0.52, g);
      hit(0, 0.65, 0.55, 1.1 * g);
      hit(12, 0.65, 0.55, 0.8 * g);
      crash(0.65, 0.8, g);
      kick(0.65, g);
      snare(0.65, g);
    },
    checkFail: (g) => {
      hit(0, 0, 0.12, 0.9 * g);
      hit(-1, 0.14, 0.3, 0.9 * g);
    },
    next: (g) => {
      hiss(0, 0.025, 0.12 * g, 3200, "bandpass");
      hiss(0.07, 0.03, 0.12 * g, 2200, "bandpass");
    },
    prev: (g) => {
      hiss(0, 0.025, 0.12 * g, 2200, "bandpass");
      hiss(0.07, 0.03, 0.12 * g, 1500, "bandpass");
    },
    moduleDone: (g) => {
      [0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 5, 5, 3, 3, 1, 1].forEach(
        (offset, index) => {
          hit(offset, index * 0.06, 0.05, g);

          if (index % 2 === 0) {
            kick(index * 0.06, 0.7 * g);
          }
        },
      );

      for (const at of [0.24, 0.48, 0.72, 0.96]) {
        snare(at, g);
      }

      hit(7, 1.02, 0.7, 1.1 * g);
      hit(0, 1.02, 0.7, 1.1 * g);
      crash(1.02, 1, g);
      kick(1.02, g);
      snare(1.02, g);
    },
    message: (g) => {
      fm(84, 0, 0.25, 0.08 * g, 2, 1.5);
      fm(91, 0.07, 0.3, 0.08 * g, 2, 1.5);
    },
    tool: (g) => {
      hiss(0, 0.02, 0.1 * g, 2500, "bandpass");
    },
    reply: (g) => {
      hit(0, 0, 0.07, 0.7 * g);
      hit(3, 0.09, 0.12, 0.7 * g);
    },
    agentDone: (g) => {
      hit(0, 0, 0.1, 0.7 * g);
      hit(7, 0.1, 0.1, 0.7 * g);
      hit(12, 0.2, 0.3, 0.8 * g);
    },
    enable: (g) => {
      hit(7, 0, 0.12, 0.7 * g);
    },
    disable: (g) => {
      hit(7, 0, 0.1, 0.6 * g);
      hit(0, 0.1, 0.25, 0.6 * g);
    },
  },
};

/**
 * The falling sound at game over.
 */
export const gameOverSound = (gain: number) => {
  const chain = drive("a2", guitar, 1);

  nt("sawtooth", midi(40), 0, 1.2, 0.2, chain, {
    to: midi(22),
    sus: 0.6,
  });
  nt("sine", midi(34), 0, 1.2, 0.25, null, { to: midi(22), sus: 0.6 });
  kick(0, 1.2 * gain, true);
  crash(0, 1, gain);
};

export const styles: Style[] = [soft, quest, chip, kalimba, doom];

export const styleOf = (id: StyleId) => {
  return styles.find((style) => {
    return style.id === id;
  }) as Style;
};
