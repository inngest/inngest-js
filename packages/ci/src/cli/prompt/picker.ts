/**
 * The picker's state and how keys change it. Pure: the terminal only feeds it
 * keys and draws `pickerLines()`.
 *
 * A matrix is a tree: the matrix, its axes, and each axis's values. Selecting
 * a node selects everything under it, and a combination is selected when every
 * value in it is. What the matrix runs is counted against the combinations it
 * really has, so `exclude` and `include` are respected.
 *
 * @module
 */

import type { Key } from "node:readline";

import type { Pick } from "../prompter.ts";
import type { AxisValue, Combo, Target } from "../target.ts";
import { isCancel, type Outcome } from "./outcome.ts";

export interface PickerState {
  /** In the order they are listed: pipelines, jobs, then matrices. */
  targets: Target[];
  /** The highlighted row. */
  cursor: number;
  /** The {@link targetKey}s of the selected pipelines and jobs. */
  selected: string[];
  /**
   * The values selected on each axis of each matrix, by {@link targetKey}. A
   * matrix with nothing selected has no entry.
   */
  chosen: Record<string, Record<string, AxisValue[]>>;
  /** The matrices whose axes are listed. */
  open: string[];
  /** The axes of open matrices that are folded shut, as `<matrix key>/<axis>`. */
  folded: string[];
  outcome?: Outcome<Pick[]>;
}

/** One line of the list: a target, an axis of the matrix above it, or a value of the axis above. */
export type PickerRow =
  | { kind: "target"; target: Target }
  | { kind: "axis"; target: Target; axis: string }
  | { kind: "value"; target: Target; axis: string; value: AxisValue };

/** How much of a row is selected. */
export type Mark = "all" | "some" | "none";

/** Identifies a target: a pipeline and a job can share an ID. */
export const targetKey = (target: Target): string => {
  return `${target.kind}:${target.id}`;
};

const axisKey = (target: Target, axis: string): string => {
  return `${targetKey(target)}/${axis}`;
};

export const createPicker = (targets: Target[]): PickerState => {
  return {
    targets,
    cursor: 0,
    selected: [],
    chosen: {},
    open: [],
    folded: [],
  };
};

/** Every line, in order, with the open matrices' axes and values under them. */
export const pickerRows = (state: PickerState): PickerRow[] => {
  return state.targets.flatMap((target): PickerRow[] => {
    const row: PickerRow = { kind: "target", target };

    if (!target.axes || !state.open.includes(targetKey(target))) {
      return [row];
    }

    return [
      row,
      ...Object.entries(target.axes).flatMap(([axis, values]): PickerRow[] => {
        return [
          { kind: "axis", target, axis },
          ...(state.folded.includes(axisKey(target, axis))
            ? []
            : values.map((value): PickerRow => {
                return { kind: "value", target, axis, value };
              })),
        ];
      }),
    ];
  });
};

/** The combinations of a matrix that are selected. */
export const selectedCombos = (state: PickerState, target: Target): Combo[] => {
  const chosen = state.chosen[targetKey(target)] ?? {};

  return (target.kind === "job" ? (target.combos ?? []) : []).filter(
    (combo) => {
      return Object.entries(combo).every(([axis, value]) => {
        return chosen[axis]?.includes(value) ?? false;
      });
    },
  );
};

/** Whether a target runs: a pipeline or job is selected, a matrix has a combination selected. */
export const isSelected = (state: PickerState, target: Target): boolean => {
  return target.axes
    ? selectedCombos(state, target).length > 0
    : state.selected.includes(targetKey(target));
};

export const markOf = (state: PickerState, row: PickerRow): Mark => {
  const { target } = row;
  const chosen = state.chosen[targetKey(target)] ?? {};

  switch (row.kind) {
    case "value": {
      return chosen[row.axis]?.includes(row.value) ? "all" : "none";
    }

    case "axis": {
      const total = target.axes?.[row.axis]?.length ?? 0;
      const count = chosen[row.axis]?.length ?? 0;

      return count === 0 ? "none" : count === total ? "all" : "some";
    }

    case "target": {
      if (!target.axes) {
        return state.selected.includes(targetKey(target)) ? "all" : "none";
      }

      const count = selectedCombos(state, target).length;
      const total = target.kind === "job" ? (target.combos?.length ?? 0) : 0;

      return count === 0 ? "none" : count === total ? "all" : "some";
    }
  }
};

const submit = (state: PickerState, picks: Pick[]): PickerState => {
  return { ...state, outcome: { kind: "submit", value: picks } };
};

/** What the selection runs. A matrix with every combination selected runs them all. */
const picksOf = (state: PickerState): Pick[] => {
  return state.targets
    .filter((target) => {
      return isSelected(state, target);
    })
    .map((target): Pick => {
      if (!target.axes) {
        return { target };
      }

      const combos = selectedCombos(state, target);

      return target.kind === "job" && combos.length === target.combos?.length
        ? { target }
        : { target, combos };
    });
};

const withChosen = (
  state: PickerState,
  target: Target,
  chosen: Record<string, AxisValue[]>,
): PickerState => {
  const { [targetKey(target)]: _, ...others } = state.chosen;
  const filled = Object.values(chosen).some((values) => {
    return values.length > 0;
  });

  return {
    ...state,
    chosen: filled ? { ...others, [targetKey(target)]: chosen } : others,
  };
};

const allValues = (target: Target): Record<string, AxisValue[]> => {
  return Object.fromEntries(
    Object.entries(target.axes ?? {}).map(([axis, values]) => {
      return [axis, [...values]];
    }),
  );
};

/** Select or deselect everything under a row. */
const setNode = (
  state: PickerState,
  row: PickerRow,
  on: boolean,
): PickerState => {
  const { target } = row;
  const key = targetKey(target);
  const chosen = state.chosen[key] ?? {};

  switch (row.kind) {
    case "target": {
      if (target.axes) {
        return withChosen(state, target, on ? allValues(target) : {});
      }

      return {
        ...state,
        selected: on
          ? [...state.selected, key]
          : state.selected.filter((item) => {
              return item !== key;
            }),
      };
    }

    case "axis": {
      return withChosen(state, target, {
        ...chosen,
        [row.axis]: on ? [...(target.axes?.[row.axis] ?? [])] : [],
      });
    }

    case "value": {
      const others = (chosen[row.axis] ?? []).filter((value) => {
        return value !== row.value;
      });

      return withChosen(state, target, {
        ...chosen,
        [row.axis]: on ? [...others, row.value] : others,
      });
    }
  }
};

/** `space`: everything under the row on, or off when it's all on already. */
const toggle = (state: PickerState, row: PickerRow): PickerState => {
  return setNode(state, row, markOf(state, row) !== "all");
};

/**
 * What `enter` runs when nothing is selected: the highlighted row. A value runs
 * the combinations with it, whatever their other values.
 */
const highlighted = (state: PickerState, row: PickerRow): PickerState => {
  const { target } = row;
  const everything = setNode(state, { kind: "target", target }, true);

  if (row.kind !== "value") {
    return everything;
  }

  return withChosen(everything, target, {
    ...everything.chosen[targetKey(target)],
    [row.axis]: [row.value],
  });
};

/** `enter`: run what's selected, else the highlighted row. */
const run = (state: PickerState, row: PickerRow): PickerState => {
  const selected = state.targets.some((target) => {
    return isSelected(state, target);
  });
  const ready = selected ? state : highlighted(state, row);

  return submit(ready, picksOf(ready));
};

/** Tells a row apart from the others, whatever the state. */
const rowId = (row: PickerRow): string => {
  switch (row.kind) {
    case "target": {
      return targetKey(row.target);
    }

    case "axis": {
      return axisKey(row.target, row.axis);
    }

    case "value": {
      return `${axisKey(row.target, row.axis)}/${row.value}`;
    }
  }
};

const moveTo = (state: PickerState, row: PickerRow): PickerState => {
  return {
    ...state,
    cursor: pickerRows(state).findIndex((candidate) => {
      return rowId(candidate) === rowId(row);
    }),
  };
};

/** `→`: open a matrix, or unfold an axis. */
const expand = (state: PickerState, row: PickerRow): PickerState => {
  const key = targetKey(row.target);

  if (row.kind === "target" && row.target.axes) {
    return {
      ...state,
      open: [
        ...state.open.filter((item) => {
          return item !== key;
        }),
        key,
      ],
      folded: state.folded.filter((item) => {
        return !item.startsWith(`${key}/`);
      }),
    };
  }

  if (row.kind === "axis") {
    return {
      ...state,
      folded: state.folded.filter((item) => {
        return item !== axisKey(row.target, row.axis);
      }),
    };
  }

  return state;
};

/** `←`: fold the axis the row is in, else close its matrix. */
const collapse = (state: PickerState, row: PickerRow): PickerState => {
  if (row.kind === "target") {
    return moveTo(
      {
        ...state,
        open: state.open.filter((item) => {
          return item !== targetKey(row.target);
        }),
      },
      row,
    );
  }

  if (
    row.kind === "axis" &&
    state.folded.includes(axisKey(row.target, row.axis))
  ) {
    return collapse(state, { kind: "target", target: row.target });
  }

  return moveTo(
    { ...state, folded: [...state.folded, axisKey(row.target, row.axis)] },
    { kind: "axis", target: row.target, axis: row.axis },
  );
};

/**
 * `↑` `↓` move, `space` selects (a matrix, an axis or a value, with what is
 * under it), `→` and `←` open and close, `enter` runs the selection (or the
 * highlighted row when nothing is selected) and `q`, `esc` and Ctrl-C quit.
 */
export const reducePicker = (state: PickerState, key: Key): PickerState => {
  if (isCancel(key) || key.name === "q") {
    return { ...state, outcome: { kind: "cancel" } };
  }

  const rows = pickerRows(state);
  const row = rows[state.cursor];

  if (!row) {
    return state;
  }

  switch (key.name) {
    case "up": {
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    }

    case "down": {
      return { ...state, cursor: Math.min(rows.length - 1, state.cursor + 1) };
    }

    case "space": {
      return toggle(state, row);
    }

    case "right": {
      return expand(state, row);
    }

    case "left": {
      return collapse(state, row);
    }

    case "return": {
      return run(state, row);
    }

    default: {
      return state;
    }
  }
};
