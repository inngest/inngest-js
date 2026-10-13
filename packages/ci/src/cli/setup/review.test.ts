/**
 * Tests for the setup prompt's lines.
 *
 * @module
 */

import { expect, test } from "vitest";

import { createChoice } from "../prompt/choice.ts";
import { reviewLines } from "./review.ts";

const paint = (style: string, text: string) => {
  return style === "yellow" ? `<${text}>` : text;
};

test("draws aligned facts, then a blank line and the choice", () => {
  const state = createChoice("Run it?", [{ label: "Yes", value: true }]);

  expect(
    reviewLines(
      state,
      [
        { label: "Server", value: "server.ts" },
        { label: "Start", value: "tsx server.ts" },
        { label: "Warning", value: "No PORT.", warn: true },
      ],
      { width: 40, paint },
    ),
  ).toEqual([
    "  Server   server.ts",
    "  Start    tsx server.ts",
    "  Warning  <No PORT.>",
    "",
    "  Run it?",
    "› Yes",
  ]);
});

test("cuts a long value to the width", () => {
  const state = createChoice("Run it?", []);
  const [line] = reviewLines(
    state,
    [{ label: "Start", value: "x".repeat(50) }],
    {
      width: 20,
      paint,
    },
  );

  expect(line).toHaveLength(20);
  expect(line).toMatch(/…$/);
});
