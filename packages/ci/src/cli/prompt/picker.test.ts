/**
 * Tests for the picker's state: moving, selecting, opening a matrix and
 * running.
 *
 * @module
 */

import type { Key } from "node:readline";
import { describe, expect, test } from "vitest";

import type { Target } from "../target.ts";
import {
  createPicker,
  type PickerState,
  pickerRows,
  reducePicker,
} from "./picker.ts";

const targets: Target[] = [
  { kind: "pipeline", id: "pr", triggers: [{ event: "github/push" }] },
  { kind: "pipeline", id: "lint", triggers: [{ event: "github/push" }] },
  { kind: "job", id: "lint", takesInput: false },
  {
    kind: "job",
    id: "compat",
    takesInput: false,
    axes: { os: ["linux", "mac"], node: [20] },
  },
];

/** Press keys in order. */
const press = (state: PickerState, ...names: string[]): PickerState => {
  return names.reduce((current, name) => {
    const key: Key = name === "ctrl-c" ? { ctrl: true, name: "c" } : { name };

    return reducePicker(current, key);
  }, state);
};

const start = () => {
  return createPicker(targets);
};

describe("moving", () => {
  test("goes down and up, and stops at both ends", () => {
    expect(press(start(), "up").cursor).toBe(0);
    expect(press(start(), "down", "down").cursor).toBe(2);
    expect(press(start(), "down", "down", "down", "down", "down").cursor).toBe(
      3,
    );
  });
});

describe("selecting", () => {
  test("toggles the highlighted row", () => {
    const selected = press(start(), "space");

    expect(selected.selected).toEqual(["pipeline:pr"]);
    expect(press(selected, "space").selected).toEqual([]);
  });

  test("tells a pipeline from a job of the same name", () => {
    expect(press(start(), "down", "space").selected).toEqual(["pipeline:lint"]);
    expect(press(start(), "down", "down", "space").selected).toEqual([
      "job:lint",
    ]);
  });
});

describe("a matrix", () => {
  const onMatrix = () => {
    return press(start(), "down", "down", "down");
  };

  test("opens with right and lists all first, then each combination", () => {
    const open = press(onMatrix(), "right");

    expect(open.expanded).toBe("job:compat");
    expect(
      pickerRows(open)
        .slice(3)
        .map((row) => {
          return row.kind === "combo" ? (row.index ?? "all") : "matrix";
        }),
    ).toEqual(["matrix", "all", 0, 1]);
  });

  test("closes with left, back on the matrix", () => {
    const closed = press(onMatrix(), "right", "down", "down", "left");

    expect(closed.expanded).toBeUndefined();
    expect(closed.cursor).toBe(3);
  });

  test("keeps the cursor on the matrix when another one closes above it", () => {
    const more: Target[] = [
      ...targets,
      { kind: "job", id: "wide", takesInput: false, axes: { a: [1, 2] } },
    ];
    const state = press(
      createPicker(more),
      "down",
      "down",
      "down",
      "right",
      "down",
      "down",
      "down",
      "down",
      "down",
      "right",
    );

    expect(pickerRows(state)[state.cursor]).toMatchObject({
      kind: "target",
      target: { id: "wide" },
    });
  });

  test("space on a combination chooses it and selects the matrix", () => {
    const chosen = press(onMatrix(), "right", "down", "down", "space");

    expect(chosen.selected).toEqual(["job:compat"]);
    expect(chosen.combos).toEqual({ "job:compat": 0 });
    expect(press(chosen, "down", "space").combos).toEqual({
      "job:compat": 1,
    });
    expect(press(chosen, "up", "space").combos).toEqual({});
  });

  test("enter on a collapsed matrix opens it instead of running", () => {
    const open = press(onMatrix(), "return");

    expect(open.expanded).toBe("job:compat");
    expect(open.outcome).toBeUndefined();
  });
});

describe("enter", () => {
  test("runs the highlighted row when nothing is selected", () => {
    expect(press(start(), "down", "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[1] }],
    });
  });

  test("runs the selection, in the order listed, not the highlighted row", () => {
    const state = press(start(), "down", "down", "space", "up", "up", "space");

    expect(press(state, "down", "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[0] }, { target: targets[2] }],
    });
  });

  test("runs a matrix with every combination unless one was chosen", () => {
    const all = press(start(), "down", "down", "down", "space", "return");

    expect(all.outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[3], combo: {} }],
    });

    const one = press(
      start(),
      "down",
      "down",
      "down",
      "right",
      "down",
      "down",
      "down",
      "return",
    );

    expect(one.outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[3], combo: { os: "mac", node: 20 } }],
    });
  });

  test("on an open matrix's own row, runs it", () => {
    expect(
      press(start(), "down", "down", "down", "right", "return").outcome,
    ).toEqual({
      kind: "submit",
      value: [{ target: targets[3], combo: {} }],
    });
  });
});

describe("quitting", () => {
  test("q, esc and Ctrl-C cancel", () => {
    for (const name of ["q", "escape", "ctrl-c"]) {
      expect(press(start(), name).outcome).toEqual({ kind: "cancel" });
    }
  });

  test("ignores other keys", () => {
    const state = start();

    expect(press(state, "tab")).toEqual(state);
  });
});
