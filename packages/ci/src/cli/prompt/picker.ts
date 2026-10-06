/**
 * The picker's state and how keys change it. Pure: the terminal only feeds it
 * keys and draws `pickerLines()`.
 *
 * @module
 */

import type { Key } from "node:readline";

import type { Pick } from "../prompter.ts";
import { combinations, type Target } from "../target.ts";
import { isCancel, type Outcome } from "./outcome.ts";

export interface PickerState {
  /** In the order they are listed: pipelines, jobs, then matrices. */
  targets: Target[];
  /** The highlighted row, counting expanded combinations. */
  cursor: number;
  /** The {@link targetKey}s of the selected targets. */
  selected: string[];
  /** The matrix whose combinations are listed, if any. */
  expanded?: string;
  /** The combination chosen for each matrix, by index. Absent means all. */
  combos: Record<string, number>;
  outcome?: Outcome<Pick[]>;
}

/** One line of the list: a target, or a combination of the matrix above it. */
export type PickerRow =
  | { kind: "target"; target: Target }
  | {
      kind: "combo";
      target: Target;
      /** Into the matrix's combinations; absent is all of them. */
      index?: number;
    };

/** Identifies a target: a pipeline and a job can share an ID. */
export const targetKey = (target: Target): string => {
  return `${target.kind}:${target.id}`;
};

export const createPicker = (targets: Target[]): PickerState => {
  return { targets, cursor: 0, selected: [], combos: {} };
};

/** Every line, in order, with the expanded matrix's combinations under it. */
export const pickerRows = (state: PickerState): PickerRow[] => {
  return state.targets.flatMap((target): PickerRow[] => {
    const row: PickerRow = { kind: "target", target };

    if (!target.axes || state.expanded !== targetKey(target)) {
      return [row];
    }

    return [
      row,
      { kind: "combo", target },
      ...combinations(target.axes).map((_, index): PickerRow => {
        return { kind: "combo", target, index };
      }),
    ];
  });
};

const pickOf = (state: PickerState, target: Target): Pick => {
  const index = state.combos[targetKey(target)];

  if (!target.axes) {
    return { target };
  }

  return {
    target,
    combo: index === undefined ? {} : combinations(target.axes)[index],
  };
};

const submit = (state: PickerState, picks: Pick[]): PickerState => {
  return { ...state, outcome: { kind: "submit", value: picks } };
};

/** Choose a combination for its matrix, and select the matrix. */
const choose = (
  state: PickerState,
  row: Extract<PickerRow, { kind: "combo" }>,
): PickerState => {
  const key = targetKey(row.target);
  const { [key]: _, ...others } = state.combos;

  return {
    ...state,
    combos: row.index === undefined ? others : { ...others, [key]: row.index },
    selected: state.selected.includes(key)
      ? state.selected
      : [...state.selected, key],
  };
};

const toggle = (state: PickerState, row: PickerRow): PickerState => {
  if (row.kind === "combo") {
    return choose(state, row);
  }

  const key = targetKey(row.target);

  return {
    ...state,
    selected: state.selected.includes(key)
      ? state.selected.filter((item) => {
          return item !== key;
        })
      : [...state.selected, key],
  };
};

/** Open or close a matrix's combinations, keeping the cursor on the matrix. */
const setExpanded = (
  state: PickerState,
  target: Target,
  open: boolean,
): PickerState => {
  const next = { ...state, expanded: open ? targetKey(target) : undefined };

  return {
    ...next,
    cursor: pickerRows(next).findIndex((row) => {
      return row.kind === "target" && row.target === target;
    }),
  };
};

/** `enter`: run what's selected, else the highlighted row. */
const run = (state: PickerState, row: PickerRow): PickerState => {
  if (state.selected.length > 0) {
    return submit(
      state,
      state.targets
        .filter((target) => {
          return state.selected.includes(targetKey(target));
        })
        .map((target) => {
          return pickOf(state, target);
        }),
    );
  }

  if (row.kind === "combo") {
    const chosen = choose(state, row);

    return submit(chosen, [pickOf(chosen, row.target)]);
  }

  // A matrix opens to choose from first.
  if (row.target.axes && state.expanded !== targetKey(row.target)) {
    return setExpanded(state, row.target, true);
  }

  return submit(state, [pickOf(state, row.target)]);
};

/**
 * `↑` `↓` move, `space` selects, `→` and `←` open and close a matrix's
 * combinations, `enter` runs the selection (or the highlighted row when
 * nothing is selected) and `q`, `esc` and Ctrl-C quit.
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
      return row.target.axes && row.kind === "target"
        ? setExpanded(state, row.target, true)
        : state;
    }

    case "left": {
      return row.target.axes ? setExpanded(state, row.target, false) : state;
    }

    case "return": {
      return run(state, row);
    }

    default: {
      return state;
    }
  }
};
