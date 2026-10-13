/**
 * The setup's own prompt: a choice with what was found drawn above its
 * question. It reuses the choice's state and keys, so only the lines differ.
 *
 * @module
 */

import { type ChoiceState, choiceLines } from "../prompt/choice.ts";
import { type Paint, truncate } from "../render/format.ts";

/** A labelled line of what was found, like `Start  tsx server.ts`. */
export interface Fact {
  label: string;
  value: string;
  /** Draws the value as a warning. */
  warn?: boolean;
}

/** The facts, aligned, then a blank line and the choice. */
export const reviewLines = <T>(
  state: ChoiceState<T>,
  facts: Fact[],
  opts: { width: number; paint: Paint },
): string[] => {
  const { width, paint } = opts;
  const labelWidth = Math.max(
    ...facts.map((fact) => {
      return fact.label.length;
    }),
  );

  return [
    ...facts.map((fact) => {
      const value = truncate(fact.value, width - labelWidth - 4);

      return `  ${paint("dim", fact.label.padEnd(labelWidth))}  ${fact.warn ? paint("yellow", value) : value}`;
    }),
    "",
    ...choiceLines(state, opts),
  ];
};
