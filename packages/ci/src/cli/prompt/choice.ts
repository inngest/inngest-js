/**
 * A short list to choose one item from: the state, how keys change it, and
 * the lines that draw it.
 *
 * @module
 */

import type { Key } from "node:readline";

import { type Paint, truncate } from "../render/format.ts";
import { isCancel, type Outcome } from "./outcome.ts";

export interface ChoiceState<T> {
  question: string;
  options: { label: string; value: T }[];
  /** The highlighted option, which `enter` picks. */
  cursor: number;
  outcome?: Outcome<T>;
}

export const createChoice = <T>(
  question: string,
  options: ChoiceState<T>["options"],
): ChoiceState<T> => {
  return { question, options, cursor: 0 };
};

/** `↑` and `↓` move, `enter` picks, `esc`, `q` and Ctrl-C cancel. */
export const reduceChoice = <T>(
  state: ChoiceState<T>,
  key: Key,
): ChoiceState<T> => {
  if (isCancel(key) || key.name === "q") {
    return { ...state, outcome: { kind: "cancel" } };
  }

  if (key.name === "up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.name === "down") {
    return {
      ...state,
      cursor: Math.min(state.options.length - 1, state.cursor + 1),
    };
  }

  const option = state.options[state.cursor];

  if (key.name === "return" && option) {
    return { ...state, outcome: { kind: "submit", value: option.value } };
  }

  return state;
};

export const choiceLines = <T>(
  state: ChoiceState<T>,
  opts: { width: number; paint: Paint },
): string[] => {
  const { width, paint } = opts;

  return [
    `  ${paint("bold", truncate(state.question, width - 2))}`,
    ...state.options.map((option, index) => {
      const label = truncate(option.label, width - 4);

      return index === state.cursor
        ? `${paint("bold", "› ")}${paint("bold", label)}`
        : `  ${label}`;
    }),
  ];
};
