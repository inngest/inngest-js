/**
 * Tests for the picker's state: moving, selecting, the matrix tree and
 * running.
 *
 * @module
 */

import type { Key } from "node:readline";
import { describe, expect, test } from "vitest";

import type { Target } from "../target.ts";
import {
  createPicker,
  markOf,
  type PickerRow,
  type PickerState,
  pickerRows,
  reducePicker,
  selectedCombos,
} from "./picker.ts";

/**
 * A matrix of os and node with `mac` on `22` excluded and linux on `18`
 * included, so 4 of the 6 products run and `18` belongs to no axis.
 */
const compat: Target = {
  kind: "job",
  id: "compat",
  takesInput: false,
  axes: { os: ["linux", "mac"], node: [20, 22, 18] },
  combos: [
    { os: "linux", node: 20 },
    { os: "linux", node: 22 },
    { os: "mac", node: 20 },
    { os: "linux", node: 18 },
  ],
};

const targets: Target[] = [
  { kind: "pipeline", id: "pr", triggers: [{ event: "github/push" }] },
  { kind: "pipeline", id: "lint", triggers: [{ event: "github/push" }] },
  { kind: "job", id: "lint", takesInput: false },
  compat,
];

/** The rows once the matrix is open: the matrix, `os` and its values, `node` and its values. */
const rows = {
  matrix: 3,
  os: 4,
  linux: 5,
  mac: 6,
  node: 7,
  node20: 8,
  node22: 9,
  node18: 10,
};

/** Press keys in order. */
const press = (state: PickerState, ...names: string[]): PickerState => {
  return names.reduce((current, name) => {
    const key: Key = name === "ctrl-c" ? { ctrl: true, name: "c" } : { name };

    return reducePicker(current, key);
  }, state);
};

/** Move the cursor to a row, which is a row number. */
const goTo = (state: PickerState, row: number): PickerState => {
  return { ...state, cursor: row };
};

/** The picker with the matrix open. */
const open = (): PickerState => {
  return press(goTo(createPicker(targets), rows.matrix), "right");
};

const count = (state: PickerState): number => {
  return selectedCombos(state, compat).length;
};

const mark = (state: PickerState, row: number): string => {
  return markOf(state, pickerRows(state)[row] as PickerRow);
};

describe("moving", () => {
  test("stays within the list", () => {
    const start = createPicker(targets);

    expect(press(start, "up").cursor).toBe(0);
    expect(press(start, "down", "down").cursor).toBe(2);
    expect(press(start, ...Array(9).fill("down")).cursor).toBe(3);
  });
});

describe("selecting", () => {
  test("space toggles a pipeline or a job", () => {
    const selected = press(createPicker(targets), "space");

    expect(selected.selected).toEqual(["pipeline:pr"]);
    expect(press(selected, "space").selected).toEqual([]);
    expect(
      press(createPicker(targets), "down", "down", "space").selected,
    ).toEqual(["job:lint"]);
  });
});

describe("a matrix", () => {
  test("opening it lists its axes, expanded to their values", () => {
    expect(
      pickerRows(open())
        .slice(rows.matrix)
        .map((row) => {
          switch (row.kind) {
            case "target": {
              return row.target.id;
            }

            case "axis": {
              return `${row.axis}: *`;
            }

            case "value": {
              return String(row.value);
            }
          }
        }),
    ).toEqual(["compat", "os: *", "linux", "mac", "node: *", "20", "22", "18"]);
  });

  test("an axis folds shut and open again, and left on it twice closes the matrix", () => {
    const folded = press(goTo(open(), rows.os), "left");

    expect(pickerRows(folded)).toHaveLength(rows.os + 1 + 4);
    expect(folded.cursor).toBe(rows.os);
    expect(pickerRows(press(folded, "right"))).toHaveLength(11);

    const closed = press(folded, "left");

    expect(pickerRows(closed)).toHaveLength(4);
    expect(closed.cursor).toBe(rows.matrix);
  });

  test("left on a value folds its axis and lands on it", () => {
    const folded = press(goTo(open(), rows.node22), "left");

    expect(folded.cursor).toBe(rows.node);
    expect(pickerRows(folded)).toHaveLength(8);
  });

  test("opening it again after closing it shows the axes unfolded", () => {
    const state = press(goTo(open(), rows.os), "left", "left", "right");

    expect(pickerRows(state)).toHaveLength(11);
  });
});

describe("selecting in a matrix", () => {
  test("space on the matrix selects every combination, and again none", () => {
    const all = press(goTo(open(), rows.matrix), "space");

    expect(count(all)).toBe(4);
    expect(mark(all, rows.matrix)).toBe("all");
    expect(mark(all, rows.os)).toBe("all");
    expect(mark(all, rows.node18)).toBe("all");
    expect(count(press(all, "space"))).toBe(0);
    expect(mark(press(all, "space"), rows.matrix)).toBe("none");
  });

  test("space on an axis selects its values; the matrix counts none until every axis has some", () => {
    const node = press(goTo(open(), rows.node), "space");

    expect(mark(node, rows.node)).toBe("all");
    expect(mark(node, rows.node20)).toBe("all");
    expect(count(node)).toBe(0);
    expect(mark(node, rows.matrix)).toBe("none");

    const both = press(goTo(node, rows.os), "space");

    expect(count(both)).toBe(4);
    expect(mark(both, rows.matrix)).toBe("all");
    expect(count(press(both, "space"))).toBe(0);
  });

  test("space on a value selects just that value", () => {
    const state = press(
      goTo(open(), rows.linux),
      "space",
      ...Array(rows.node20 - rows.linux).fill("down"),
      "space",
    );

    expect(mark(state, rows.os)).toBe("some");
    expect(mark(state, rows.linux)).toBe("all");
    expect(mark(state, rows.mac)).toBe("none");
    expect(mark(state, rows.node)).toBe("some");
    expect(selectedCombos(state, compat)).toEqual([{ os: "linux", node: 20 }]);
    expect(mark(state, rows.matrix)).toBe("some");
  });

  test("counts the combinations that really run, not the product", () => {
    // Every os with node 20 and 22: the product has 4, but mac on 22 is excluded.
    const state = press(
      goTo(open(), rows.os),
      "space",
      ...Array(rows.node20 - rows.os).fill("down"),
      "space",
      "down",
      "space",
    );

    expect(selectedCombos(state, compat)).toEqual([
      { os: "linux", node: 20 },
      { os: "linux", node: 22 },
      { os: "mac", node: 20 },
    ]);
    expect(mark(state, rows.matrix)).toBe("some");
  });

  test("a combination only an include adds is selected while its values are", () => {
    const node18 = press(
      goTo(open(), rows.linux),
      "space",
      ...Array(rows.node18 - rows.linux).fill("down"),
      "space",
    );

    expect(selectedCombos(node18, compat)).toEqual([{ os: "linux", node: 18 }]);

    const without = press(node18, "space");

    expect(count(without)).toBe(0);
  });

  test("a matrix with an axis fully off is not run", () => {
    const node = press(goTo(open(), rows.node), "space");

    expect(node.chosen).toEqual({ "job:compat": { node: [20, 22, 18] } });
    expect(press(goTo(node, 0), "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[0] }],
    });
  });
});

describe("enter", () => {
  test("runs the highlighted row when nothing is selected", () => {
    expect(press(createPicker(targets), "down", "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[1] }],
    });
  });

  test("runs what is selected, in the order listed", () => {
    const state = press(
      createPicker(targets),
      "down",
      "down",
      "space",
      "up",
      "up",
      "space",
    );

    expect(press(state, "down", "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: targets[0] }, { target: targets[2] }],
    });
  });

  test("runs every combination of a matrix with all of them selected", () => {
    const state = press(
      goTo(createPicker(targets), rows.matrix),
      "space",
      "return",
    );

    expect(state.outcome).toEqual({
      kind: "submit",
      value: [{ target: compat }],
    });
  });

  test("runs only the selected combinations of a matrix", () => {
    const state = press(
      goTo(open(), rows.linux),
      "space",
      "down",
      "down",
      "down",
      "space",
      "return",
    );

    expect(state.outcome).toEqual({
      kind: "submit",
      value: [{ target: compat, combos: [{ os: "linux", node: 20 }] }],
    });
  });

  test("on a matrix or an axis runs every combination", () => {
    for (const row of [rows.matrix, rows.os]) {
      expect(press(goTo(open(), row), "return").outcome).toEqual({
        kind: "submit",
        value: [{ target: compat }],
      });
    }
  });

  test("on a value runs the combinations with it, whatever their other values", () => {
    expect(press(goTo(open(), rows.node22), "return").outcome).toEqual({
      kind: "submit",
      value: [{ target: compat, combos: [{ os: "linux", node: 22 }] }],
    });
    expect(press(goTo(open(), rows.linux), "return").outcome).toEqual({
      kind: "submit",
      value: [
        {
          target: compat,
          combos: [
            { os: "linux", node: 20 },
            { os: "linux", node: 22 },
            { os: "linux", node: 18 },
          ],
        },
      ],
    });
  });
});

describe("quitting", () => {
  test("q, esc and Ctrl-C cancel", () => {
    for (const name of ["q", "escape", "ctrl-c"]) {
      expect(press(createPicker(targets), name).outcome).toEqual({
        kind: "cancel",
      });
    }
  });

  test("ignores other keys", () => {
    const state = createPicker(targets);

    expect(press(state, "tab")).toEqual(state);
  });
});
