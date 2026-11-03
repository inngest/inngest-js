/**
 * @module
 * Freedoom's status-bar faces (served from `/freedoom/faces/`, see the
 * LICENSE and README beside them): which one to show for the health, the
 * mood and where the eyes look.
 */
import { type Game, tier } from "./game.ts";

export type Look = -1 | 0 | 1;

/**
 * The file name (without `.png`) of the face: `st` is calm with a glance
 * (0 ahead, 1 left, 2 right), `ouch` hit, `kill` firing, `evl` grin.
 */
export const faceKey = (game: Game, look: Look) => {
  const at = tier(game.health);

  if (game.health <= 0) {
    return "dead0";
  }

  if (game.mood === "hurt") {
    return `ouch${at}`;
  }

  if (game.mood === "fire") {
    return `kill${at}`;
  }

  if (game.mood === "grin") {
    return `evl${at}`;
  }

  return `st${at}${look < 0 ? 1 : look > 0 ? 2 : 0}`;
};

export const faceUrl = (key: string) => {
  return `/freedoom/faces/stf${key}.png`;
};

const keys = [
  "dead0",
  ...[0, 1, 2, 3, 4].flatMap((at) => {
    return [
      `ouch${at}`,
      `kill${at}`,
      `evl${at}`,
      `st${at}0`,
      `st${at}1`,
      `st${at}2`,
    ];
  }),
];

/**
 * Loads every face, so the bar never flickers while one arrives.
 */
export const preloadFaces = () => {
  for (const key of keys) {
    new Image().src = faceUrl(key);
  }
};
