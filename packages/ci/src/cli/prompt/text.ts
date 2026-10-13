/**
 * A single line of text to type: the state, how keys change it, and the
 * lines that draw it.
 *
 * @module
 */

import type { Key } from "node:readline";

import { type Paint, truncate } from "../render/format.ts";
import { isCancel, type Outcome } from "./outcome.ts";

export interface TextState {
  question: string;
  text: string;
  /** Says what is wrong with the text, or nothing when it's fine. */
  check?: (text: string) => string | undefined;
  /** Why the last `enter` was refused. */
  error?: string;
  outcome?: Outcome<string>;
}

export const createText = (
  question: string,
  check?: TextState["check"],
): TextState => {
  return { question, text: "", check };
};

/**
 * Typing adds, backspace removes and Ctrl-U clears. `enter` submits unless
 * `check` finds fault, in which case the line stays to be fixed. `esc` and
 * Ctrl-C cancel; `q` is just a letter here.
 */
export const reduceText = (state: TextState, key: Key): TextState => {
  if (isCancel(key)) {
    return { ...state, outcome: { kind: "cancel" } };
  }

  if (key.name === "return") {
    const error = state.check?.(state.text);

    return error
      ? { ...state, error }
      : { ...state, outcome: { kind: "submit", value: state.text } };
  }

  if (key.name === "backspace") {
    return { ...state, text: state.text.slice(0, -1), error: undefined };
  }

  if (key.ctrl && key.name === "u") {
    return { ...state, text: "", error: undefined };
  }

  const typed = key.sequence ?? "";

  if (!key.ctrl && !key.meta && typed.length === 1 && typed >= " ") {
    return { ...state, text: state.text + typed, error: undefined };
  }

  return state;
};

export const textLines = (
  state: TextState,
  opts: { width: number; paint: Paint },
): string[] => {
  const { width, paint } = opts;

  return [
    `  ${paint("bold", truncate(state.question, width - 2))}`,
    `${paint("bold", "› ")}${truncate(state.text, width - 4)}${paint("dim", "▏")}`,
    ...(state.error ? [`  ${paint("red", state.error)}`] : []),
  ];
};
