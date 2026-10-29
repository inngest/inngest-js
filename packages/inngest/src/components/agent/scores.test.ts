/**
 * @module
 * Tests for the score helpers outside a function run.
 */
import { describe, expect, test } from "vitest";
import { scoreThisStep } from "./scores.ts";

describe("scoreThisStep", () => {
  test("does nothing outside a step", () => {
    expect(scoreThisStep("agent.model_ms", 5)).toBe(false);
  });
});
