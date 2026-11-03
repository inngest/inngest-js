/**
 * @module
 * Doom mode's game: the tour's moments as a tiny shooter. Health, score,
 * ammo and the weapon change with the moments; at 0 health it is game over,
 * which takes a chunk off the score, and health comes back to 100.
 */
import type { Moment } from "./moments.ts";

// Taken off the score at game over: a module done's worth.
export const GAME_OVER_PENALTY = 500;

export type Mood = "hurt" | "fire" | "grin" | null;

export interface Game {
  health: number;
  score: number;
  ammo: number;
  weapon: number;
  over: boolean;
  mood: Mood;
  // What the last game over really took off the score.
  penalty: number;
}

export const newGame = (): Game => {
  return {
    health: 100,
    score: 0,
    ammo: 50,
    weapon: 1,
    over: false,
    mood: null,
    penalty: 0,
  };
};

const heal = (game: Game, by: number) => {
  return Math.min(100, game.health + by);
};

const hurt = (game: Game, by: number): Game => {
  const health = Math.max(0, game.health - by);

  if (health > 0) {
    return { ...game, health, mood: "hurt" };
  }

  const score = Math.max(0, game.score - GAME_OVER_PENALTY);

  return {
    ...game,
    health: 0,
    over: true,
    mood: null,
    score,
    penalty: game.score - score,
  };
};

/**
 * What a moment does to the game. Nothing counts while it is game over.
 */
export const update = (game: Game, moment: Moment): Game => {
  if (game.over) {
    return game;
  }

  switch (moment) {
    case "runFail":
      return hurt(game, 20);
    case "checkFail":
      return hurt(game, 25);
    case "checkPass":
      return {
        ...game,
        health: heal(game, 15),
        score: game.score + 100,
        mood: "grin",
      };
    case "moduleDone":
      return {
        ...game,
        health: heal(game, 25),
        score: game.score + 500,
        ammo: 50,
        mood: "grin",
      };
    case "agentDone":
      return {
        ...game,
        health: heal(game, 10),
        score: game.score + 250,
        mood: "grin",
      };
    case "runDone":
      return { ...game, score: game.score + 25 };
    case "reply":
      return { ...game, score: game.score + 10 };
    case "run":
      return game.ammo > 0
        ? { ...game, ammo: game.ammo - 1, mood: "fire" }
        : game;
    case "message":
      return { ...game, ammo: Math.min(99, game.ammo + 5) };
    case "next":
      return { ...game, weapon: (game.weapon % 4) + 1 };
    case "prev":
      return { ...game, weapon: ((game.weapon + 2) % 4) + 1 };
    default:
      return game;
  }
};

/**
 * The game after the game over screen: full health, the reduced score kept.
 */
export const recover = (game: Game): Game => {
  return { ...game, health: 100, over: false, mood: null, penalty: 0 };
};

/**
 * Which of the five face sets a health value uses: 0 is healthy, 4 nearly dead.
 */
export const tier = (health: number) => {
  if (health > 80) {
    return 0;
  }

  if (health > 60) {
    return 1;
  }

  if (health > 40) {
    return 2;
  }

  return health > 20 ? 3 : 4;
};
