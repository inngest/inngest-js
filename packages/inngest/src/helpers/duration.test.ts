import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { durationToMs } from "./duration.ts";

describe("durationToMs", () => {
  test("numbers are milliseconds", () => {
    expect(durationToMs(1500)).toBe(1500);
  });

  test("ms strings", () => {
    expect(durationToMs("30s")).toBe(30_000);
    expect(durationToMs("2h")).toBe(7_200_000);
    expect(durationToMs("1d")).toBe(86_400_000);
    expect(durationToMs("1.5s")).toBe(1500);
  });

  test("compound strings", () => {
    expect(durationToMs("1h30m")).toBe(5_400_000);
    expect(durationToMs("1h 30m")).toBe(5_400_000);
  });

  test("Temporal.Duration", () => {
    expect(durationToMs(Temporal.Duration.from({ days: 1 }))).toBe(86_400_000);
    expect(durationToMs(Temporal.Duration.from({ minutes: 5 }))).toBe(300_000);
  });

  test("rejects calendar units, naming the field", () => {
    expect(() => {
      return durationToMs(Temporal.Duration.from({ weeks: 1 }), {
        name: "cache.maxAge",
      });
    }).toThrow(/cache\.maxAge cannot contain calendar/);
  });

  test("rejects invalid input", () => {
    for (const bad of [
      "soon",
      "",
      "-5m",
      "1h garbage",
      0,
      -1,
      1.5,
      NaN,
      true,
      null,
      {},
    ]) {
      expect(() => {
        return durationToMs(bad, { name: "timeout" });
      }).toThrow(/timeout must be a positive/);
    }
  });

  test("enforces maxMs", () => {
    expect(() => {
      return durationToMs("10m", { maxMs: 60_000, name: "timeout" });
    }).toThrow(/timeout must not exceed 60000/);
  });
});
