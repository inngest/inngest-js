import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { durationToMs } from "./duration.ts";

describe("durationToMs", () => {
  test.each([
    [1500, 1500],
    ["30s", 30_000],
    ["1d", 86_400_000],
    ["1.5s", 1500],
    ["1h30m", 5_400_000],
    ["1h 30m", 5_400_000],
    [Temporal.Duration.from({ minutes: 5 }), 300_000],
    // Not capped: the receiving API decides what is too long.
    ["30d", 2_592_000_000],
  ])("%s is %i ms", (input, expected) => {
    expect(durationToMs(input)).toBe(expected);
  });

  test("rejects calendar units, naming the field", () => {
    expect(() => {
      return durationToMs(Temporal.Duration.from({ weeks: 1 }), {
        name: "cache.maxAge",
      });
    }).toThrow(/cache\.maxAge cannot contain calendar/);
  });

  test.each([
    "soon",
    "",
    "-5m",
    "1h garbage",
    "1h30",
    0,
    -1,
    1.5,
    NaN,
    true,
    null,
    {},
  ])("rejects %j", (bad) => {
    expect(() => {
      return durationToMs(bad, { name: "timeout" });
    }).toThrow(/timeout must be a positive/);
  });
});
