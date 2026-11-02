/**
 * @module
 * Doom mode's game: what each moment does to health, score, ammo and weapon,
 * and what game over costs. Plain functions, so they run without a browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GAME_OVER_PENALTY,
  type Game,
  newGame,
  recover,
  tier,
  update,
} from "../site/src/sound/game.ts";

const withHealth = (health: number, extra: Partial<Game> = {}): Game => {
  return { ...newGame(), health, ...extra };
};

describe("the Doom game", () => {
  it("starts at full health, 50 ammo, no score and the first weapon", () => {
    assert.deepEqual(newGame(), {
      health: 100,
      score: 0,
      ammo: 50,
      weapon: 1,
      over: false,
      mood: null,
      penalty: 0,
    });
  });

  it("takes 20 health for a failed run and 25 for a failed check", () => {
    assert.equal(update(newGame(), "runFail").health, 80);
    assert.equal(update(newGame(), "checkFail").health, 75);
    assert.equal(update(newGame(), "checkFail").mood, "hurt");
  });

  it("heals on wins but never past 100", () => {
    assert.equal(update(withHealth(50), "checkPass").health, 65);
    assert.equal(update(withHealth(95), "moduleDone").health, 100);
    assert.equal(update(withHealth(50), "agentDone").health, 60);
  });

  it("scores wins and refills ammo at the end of a module", () => {
    const won = update(newGame(), "checkPass");

    assert.equal(won.score, 100);
    assert.equal(won.mood, "grin");
    assert.equal(update(newGame(), "runDone").score, 25);
    assert.equal(update(newGame(), "reply").score, 10);
    assert.equal(update(newGame(), "agentDone").score, 250);

    const cleared = update(withHealth(100, { ammo: 3 }), "moduleDone");

    assert.equal(cleared.score, 500);
    assert.equal(cleared.ammo, 50);
  });

  it("spends one ammo per run and picks up five per message, up to 99", () => {
    assert.equal(update(newGame(), "run").ammo, 49);
    assert.equal(update(newGame(), "run").mood, "fire");
    assert.equal(update(withHealth(100, { ammo: 0 }), "run").ammo, 0);
    assert.equal(update(newGame(), "message").ammo, 55);
    assert.equal(update(withHealth(100, { ammo: 97 }), "message").ammo, 99);
  });

  it("cycles the weapon with the page keys", () => {
    assert.equal(update(newGame(), "next").weapon, 2);
    assert.equal(update(withHealth(100, { weapon: 4 }), "next").weapon, 1);
    assert.equal(update(newGame(), "prev").weapon, 4);
    assert.equal(update(withHealth(100, { weapon: 3 }), "prev").weapon, 2);
  });

  it("ignores moments that are only sound", () => {
    assert.deepEqual(update(newGame(), "tool"), newGame());
    assert.deepEqual(update(newGame(), "key"), newGame());
  });

  it("is game over at 0 health and takes 500 off the score", () => {
    const dead = update(withHealth(20, { score: 700 }), "runFail");

    assert.equal(GAME_OVER_PENALTY, 500);
    assert.equal(dead.health, 0);
    assert.equal(dead.over, true);
    assert.equal(dead.score, 200);
    assert.equal(dead.penalty, 500);
    assert.equal(dead.mood, null);
  });

  it("never takes the score below 0", () => {
    const dead = update(withHealth(10, { score: 120 }), "checkFail");

    assert.equal(dead.over, true);
    assert.equal(dead.score, 0);
    assert.equal(dead.penalty, 120);
  });

  it("shows the penalty it really took", () => {
    const dead = update(withHealth(10, { score: 0 }), "checkFail");

    assert.equal(dead.score, 0);
    assert.equal(dead.penalty, 0);
  });

  it("ignores every moment while game over", () => {
    const dead = update(withHealth(10, { score: 900 }), "checkFail");

    assert.deepEqual(update(dead, "checkPass"), dead);
    assert.deepEqual(update(dead, "runFail"), dead);
  });

  it("recovers to 100 health and keeps the reduced score", () => {
    const dead = update(withHealth(10, { score: 900 }), "checkFail");
    const back = recover(dead);

    assert.equal(back.health, 100);
    assert.equal(back.over, false);
    assert.equal(back.score, 400);
    assert.equal(back.penalty, 0);
  });

  it("picks the face tier from health", () => {
    assert.deepEqual(
      [100, 81, 80, 61, 60, 41, 40, 21, 20, 1].map(tier),
      [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
    );
  });
});
