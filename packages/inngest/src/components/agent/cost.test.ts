/**
 * @module
 * Tests for pricing a model call.
 */
import { describe, expect, test } from "vitest";
import { priceOf } from "./cost.ts";

describe("priceOf", () => {
  test("a function gets the call's tokens and the model, and returns dollars", () => {
    const seen: unknown[] = [];
    const cost = priceOf(
      (usage, model) => {
        seen.push([usage, model]);

        return usage.input * 0.000003 + usage.output * 0.000015;
      },
      { input: 1000, output: 100 },
      "claude-x",
    );

    expect(cost).toBeCloseTo(0.0045);
    expect(seen).toEqual([[{ input: 1000, output: 100 }, "claude-x"]]);
  });

  test("a table gives rates per million tokens by model, with * for any other", () => {
    const table = {
      "claude-x": { input: 3, output: 15 },
      "*": { input: 1, output: 2 },
    };

    expect(
      priceOf(table, { input: 1_000_000, output: 1_000_000 }, "claude-x"),
    ).toBe(18);
    expect(
      priceOf(table, { input: 1_000_000, output: 1_000_000 }, "other"),
    ).toBe(3);
    expect(priceOf(table, { input: 1_000_000, output: 0 }, undefined)).toBe(1);
  });

  test("a table with no rate for the model prices nothing", () => {
    expect(
      priceOf(
        { "claude-x": { input: 3, output: 15 } },
        { input: 5, output: 5 },
        "y",
      ),
    ).toBeUndefined();
    expect(
      priceOf(
        { constructor: { input: 3, output: 15 } },
        { input: 5, output: 5 },
        "toString",
      ),
    ).toBeUndefined();
  });

  test("a function that returns something that isn't dollars throws", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        priceOf(() => bad, { input: 1, output: 1 }, undefined),
      ).toThrow(/must return a number of dollars/);
    }
  });
});
