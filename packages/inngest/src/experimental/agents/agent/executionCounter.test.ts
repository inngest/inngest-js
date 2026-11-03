/**
 * @module
 * Tests for the per-execution counter.
 */
import { describe, expect, test } from "vitest";
import { nextCount } from "./executionCounter.ts";

describe("nextCount", () => {
  test("counts each kind from 0, per execution", () => {
    const a = {};
    const b = {};

    expect([
      nextCount(a, "invoke"),
      nextCount(a, "invoke"),
      nextCount(a, "request"),
      nextCount(b, "invoke"),
    ]).toEqual([0, 1, 0, 0]);
  });
});
