/**
 * @module
 * Sound for the whole site. The one call is `sound(moment)`: the site (or any
 * `tour:moment` window event) says what happened and the picked style answers.
 * The sound is muted on load and nothing is created until the speaker is
 * clicked. Picking Doom turns the page into a small shooter: the bar, the
 * face, two looping tracks, damage and game over.
 */
import { store } from "../platform.ts";
import { ensure, liveRig } from "./engine.ts";
import { preloadFaces } from "./faces.ts";
import { hurtFlash, visual } from "./fx.ts";
import { type Game, newGame, recover, update } from "./game.ts";
import { isMoment, type Moment } from "./moments.ts";
import * as music from "./music.ts";
import { plan, showPeek, startPeeking } from "./peek.ts";
import {
  gameOverSound,
  type StyleId,
  styleOf,
  styles,
  weights,
} from "./styles.ts";

export interface SoundState {
  muted: boolean;
  style: StyleId;
  // Doom is picked and the sound is on: the bar and the music are up.
  doom: boolean;
  game: Game;
  track: music.Track;
  // The track is still being prepared.
  rendering: boolean;
  // The style menu is open, so it owns the arrows, Enter, Esc and 1 to 5.
  menu: boolean;
}

const styleKey = "tour:sound-style";
const savedStyle = store.get(styleKey);

let state: SoundState = {
  muted: true,
  style: styles.some((style) => {
    return style.id === savedStyle;
  })
    ? (savedStyle as StyleId)
    : "soft",
  doom: false,
  game: newGame(),
  track: music.tracks[0] as music.Track,
  rendering: false,
  menu: false,
};

const listeners = new Set<() => void>();

const set = (patch: Partial<SoundState>) => {
  state = { ...state, ...patch };

  for (const listener of listeners) {
    listener();
  }
};

export const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const setMenu = (menu: boolean) => {
  set({ menu });
};

export const getState = () => {
  return state;
};

let moodTimer: number | undefined;
let overTimer: number | undefined;

const mark = (game: Game) => {
  set({ game });

  if (game.mood) {
    window.clearTimeout(moodTimer);
    moodTimer = window.setTimeout(
      () => {
        set({ game: { ...state.game, mood: null } });
      },
      game.mood === "hurt" ? 320 : game.mood === "fire" ? 120 : 700,
    );
  }
};

const gameOver = () => {
  try {
    gameOverSound(weights.checkPass);
  } catch (error) {
    console.error(error);
  }

  music.duck(0.12, 0.1);
  window.clearTimeout(overTimer);
  overTimer = window.setTimeout(() => {
    mark(recover(state.game));
    music.duck(0.55, 0.4);
  }, 1500);
};

const applyGame = (moment: Moment) => {
  const before = state.game;
  const after = update(before, moment);

  if (after === before) {
    return;
  }

  mark(after);

  if (after.health < before.health) {
    hurtFlash();
  }

  if (after.over && !before.over) {
    gameOver();
  }
};

const startDoom = () => {
  const pick = Math.floor(Math.random() * music.tracks.length);
  const track = music.tracks[pick] as music.Track;

  preloadFaces();
  set({ doom: true, game: newGame(), track });
  void music
    .start(track, (rendering) => {
      set({ rendering });
    })
    .then(() => {
      music.warm(music.tracks[1 - pick] as music.Track);
    })
    .catch((error: unknown) => {
      console.error(error);
    });
};

const stopDoom = () => {
  window.clearTimeout(moodTimer);
  window.clearTimeout(overTimer);
  music.stop();
  set({ doom: false, rendering: false, game: newGame() });
};

const sync = () => {
  const wanted = state.style === "doom" && !state.muted && liveRig() !== null;

  if (wanted && !state.doom) {
    startDoom();
  } else if (!wanted && state.doom) {
    stopDoom();
  }

  document.documentElement.classList.toggle("dm-on", state.doom);
  document.documentElement.dataset.soundStyle = state.muted ? "" : state.style;
  plan();
};

/**
 * Plays a moment in the picked style. Silent while muted.
 */
export const sound = (moment: Moment) => {
  if (state.muted || !liveRig()) {
    return;
  }

  const style = styleOf(state.style);

  try {
    style.sounds[moment](weights[moment]);
  } catch (error) {
    console.error(error);
  }

  if (state.style === "doom") {
    applyGame(moment);
  }

  const hurts = moment === "runFail" || moment === "checkFail";

  if (
    !(state.style === "doom" && hurts) &&
    (weights[moment] === 1.2 || moment === "runFail")
  ) {
    visual(style.fx, moment === "runFail");
  }
};

/**
 * The speaker: unmutes (the enabled sound plays) or mutes (the disabled sound
 * is the last one).
 */
export const setMuted = (muted: boolean) => {
  if (muted === state.muted) {
    return;
  }

  if (muted) {
    const style = styleOf(state.style);

    try {
      if (liveRig()) {
        style.sounds.disable(weights.disable);
      }
    } catch (error) {
      console.error(error);
    }

    set({ muted: true });
    sync();

    return;
  }

  const rig = ensure();

  void rig.ctx.resume?.();
  set({ muted: false });
  sound("enable");
  sync();
};

export const toggleMuted = () => {
  setMuted(!state.muted);
};

/**
 * Picks a style. While muted, that turns the sound on.
 */
export const pickStyle = (id: StyleId) => {
  store.set(styleKey, id);
  set({ style: id });

  if (state.muted) {
    setMuted(false);

    return;
  }

  sync();

  if (id !== "doom") {
    sound("checkPass");
  }
};

/**
 * Plays the other Doom track.
 */
export const swapTrack = () => {
  if (!state.doom) {
    return;
  }

  const next = music.tracks.find((track) => {
    return track.id !== state.track.id;
  }) as music.Track;

  music.stop();
  set({ track: next });
  void music
    .start(next, (rendering) => {
      set({ rendering });
    })
    .catch((error: unknown) => {
      console.error(error);
    });
};

/**
 * Shows the Doom peek now (it only shows with Doom picked and the sound muted).
 */
export const peekNow = () => {
  if (state.style === "doom" && state.muted) {
    showPeek();
  }
};

/**
 * Starts listening for `tour:moment` events, once.
 */
let started = false;

export const startSound = () => {
  if (started) {
    return;
  }

  started = true;
  startPeeking(() => {
    return state.style === "doom" && state.muted;
  });
  window.addEventListener("tour:moment", (event) => {
    const name = (event as CustomEvent<string>).detail;

    if (isMoment(name)) {
      sound(name);
    }
  });
  sync();
};
