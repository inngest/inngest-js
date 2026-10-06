/**
 * The questions the session asks a person at a terminal: what to run, what
 * data to run it with, and whether to go again. The interactive renderer
 * implements them; without a terminal there is no prompter and the session
 * only uses what the command line gave it.
 *
 * @module
 */

import type { Fact } from "./setup/review.ts";
import type { JsonSchema } from "../local/jsonSchema.ts";
import type { Combo, Target } from "./target.ts";

/** What the picker chose to run. */
export interface Pick {
  target: Target;
  /** For a matrix: the combinations to run. Left out, every one. */
  combos?: Combo[];
}

/** Thrown by a prompt when the person backs out of it. */
export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled.");

    this.name = "PromptCancelled";
  }
}

/**
 * Every question rejects with {@link PromptCancelled} when the person backs
 * out (`esc`, `q` or Ctrl-C), so a caller only handles an answer.
 */
export interface Prompter {
  /** Pick one or more of `targets` to run. */
  pick(targets: Target[]): Promise<Pick[]>;
  choose<T>(
    question: string,
    options: { label: string; value: T }[],
  ): Promise<T>;
  /** Like `choose`, with what was found drawn above the question. */
  review<T>(
    question: string,
    options: { label: string; value: T }[],
    facts: Fact[],
  ): Promise<T>;
  /**
   * One line of text, which starts as `initial`. `check` returns what is
   * wrong with it, if anything.
   */
  line(
    question: string,
    check?: (text: string) => string | undefined,
    initial?: string,
  ): Promise<string>;
  /**
   * Build a value of `schema` field by field, then show it to run, edit a
   * field of or start over. `initial` is the value the fields start from, and
   * `note` is something to say about the form. Resolves with the value, which
   * is `undefined` when nothing was answered.
   */
  form(opts: {
    title: string;
    schema: JsonSchema;
    note?: string;
    initial?: unknown;
  }): Promise<unknown>;
  /**
   * Keep the view open once everything has run, so its links still work.
   * Resolves `true` for `r` to pick again (when `again`), `false` for `q`.
   */
  linger(again: boolean): Promise<boolean>;
}
