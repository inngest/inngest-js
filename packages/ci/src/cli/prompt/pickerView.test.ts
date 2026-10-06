/**
 * Tests for the picker's frame at a fixed width and height, with colour off.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { createPaint } from "../render/format.ts";
import type { Target } from "../target.ts";
import { createPicker, type PickerState, reducePicker } from "./picker.ts";
import { pickerLines } from "./pickerView.ts";

const paint = createPaint(false);

const targets: Target[] = [
  {
    kind: "pipeline",
    id: "pr",
    triggers: [
      { event: "github/pull_request.opened" },
      { event: "github/push" },
    ],
  },
  {
    kind: "pipeline",
    id: "deploy",
    triggers: [{ event: "ci/manual.deploy" }],
  },
  { kind: "pipeline", id: "nightly", triggers: [{ cron: "0 3 * * *" }] },
  { kind: "job", id: "lint", takesInput: false },
  { kind: "job", id: "build", takesInput: true },
  {
    kind: "job",
    id: "compat",
    takesInput: false,
    axes: { os: ["linux", "mac"], node: [20, 22] },
  },
];

const press = (state: PickerState, ...names: string[]): PickerState => {
  return names.reduce((current, name) => {
    return reducePicker(current, { name });
  }, state);
};

const draw = (state: PickerState, height = 30) => {
  return pickerLines(state, { width: 72, height, paint });
};

describe("pickerLines", () => {
  test("lists pipelines, jobs and matrices in sections", () => {
    expect(draw(createPicker(targets))).toEqual([
      "  Pipelines",
      "› ○ pr       pull_request.opened · push",
      "  ○ deploy   manual",
      "  ○ nightly  cron",
      "",
      "  Jobs",
      "  ○ lint",
      "  ○ build    takes input",
      "",
      "  Matrices",
      "  ○ compat   4 combinations →",
      "",
      "  ↑↓ move · space select · → expand · enter run · q quit",
    ]);
  });

  test("marks what is selected and counts it in the hint", () => {
    const lines = draw(press(createPicker(targets), "space", "down", "space"));

    expect(lines[1]).toBe("  ● pr       pull_request.opened · push");
    expect(lines[2]).toBe("› ● deploy   manual");
    expect(lines.at(-1)).toBe(
      "  ↑↓ move · space select · → expand · enter run 2 selected · q quit",
    );
  });

  test("lists a matrix's combinations under it, with the chosen one marked", () => {
    const state = press(
      createPicker(targets),
      "down",
      "down",
      "down",
      "down",
      "down",
      "right",
      "down",
      "down",
      "space",
    );

    expect(draw(state).slice(9)).toEqual([
      "  Matrices",
      "  ● compat   4 combinations",
      "  ├─ ○ all",
      "› ├─ ● os:linux, node:20",
      "  ├─ ○ os:linux, node:22",
      "  ├─ ○ os:mac, node:20",
      "  └─ ○ os:mac, node:22",
      "",
      "  ↑↓ move · space select · → expand · enter run 1 selected · q quit",
    ]);
  });

  test("shows the chosen combination on a closed matrix", () => {
    const state = press(
      createPicker(targets),
      ...Array(5).fill("down"),
      "right",
      "down",
      "down",
      "space",
      "up",
      "up",
      "left",
    );

    expect(draw(state)[10]).toBe("› ● compat   os:linux, node:20 →");
  });

  test("scrolls to keep the highlighted row in view", () => {
    const state = press(createPicker(targets), ...Array(5).fill("down"));
    const lines = draw(state, 6);

    expect(lines).toHaveLength(6);
    expect(lines.join("\n")).toContain("› ○ compat");
    expect(lines.at(-1)).toContain("q quit");
  });

  test("cuts lines to the width", () => {
    const lines = pickerLines(createPicker(targets), {
      width: 30,
      height: 30,
      paint,
    });

    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      30,
    );
  });
});
