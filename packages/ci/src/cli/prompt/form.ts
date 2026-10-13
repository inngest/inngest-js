/**
 * An input form's state and how keys change it. It asks a schema's fields one
 * at a time, then shows the finished value to run, change a field of, or start
 * over. Pure: the terminal only feeds it keys and draws `formLines()`.
 *
 * @module
 */

import type { Key } from "node:readline";

import type { JsonSchema } from "../../local/jsonSchema.ts";
import {
  assemble,
  exampleOf,
  type Field,
  fieldKey,
  fieldsOf,
  kindOf,
  readAnswer,
  valueAt,
} from "./formSchema.ts";
import { isCancel, type Outcome } from "./outcome.ts";
import { reduceText } from "./text.ts";

/** What the review offers, in order. */
export const reviewActions = ["Run", "Edit a field", "Start over"] as const;

export interface FormState {
  /** What is being asked for, like `deploy · event data`. */
  title: string;
  /** Something to say about the form, like why it can't offer fields. */
  note?: string;
  schema: JsonSchema;
  fields: Field[];
  /** What the fields start from, such as a saved fixture's value. */
  prefill?: unknown;
  /** What each answered field holds, by `fieldKey`. A field left out has none. */
  answers: Record<string, unknown>;
  /**
   * Asking the field at `field`, reviewing the finished value, or picking a
   * field to ask again.
   */
  step: "ask" | "review" | "pick";
  /** The field being asked. */
  field: number;
  /** Whether the field is asked again from the review, which returns to it. */
  editing: boolean;
  /** What has been typed for the field, or for the next item of a list. */
  text: string;
  /** The items of a list field so far. */
  items: unknown[];
  /**
   * The highlighted option of a choice (an optional one has a last option that
   * leaves the field out), review action or field.
   */
  cursor: number;
  /** Why the last `enter` was refused. */
  error?: string;
  outcome?: Outcome<unknown>;
}

/** The value of the answers so far. */
export const formValue = (state: FormState): unknown => {
  return assemble(state.schema, state.answers);
};

/** What a field starts from: its answer, else the prefill, else its default. */
const startingValue = (state: FormState, field: Field): unknown => {
  const key = fieldKey(field);

  if (key in state.answers) {
    return state.answers[key];
  }

  return valueAt(state.prefill, field.path) ?? field.schema.default;
};

/** Ask the field at `index`, set up with what it starts from. */
const askField = (
  state: FormState,
  index: number,
  editing: boolean,
): FormState => {
  const field = state.fields[index] as Field;
  const initial = startingValue(state, field);
  const asked: FormState = {
    ...state,
    step: "ask",
    field: index,
    editing,
    text: "",
    items: [],
    cursor: 0,
    error: undefined,
  };

  switch (field.kind) {
    case "choice": {
      const at = field.options.findIndex((option) => {
        return option.value === initial;
      });

      // An optional field with nothing to start from lands on "leave out".
      return {
        ...asked,
        cursor: at >= 0 ? at : field.required ? 0 : field.options.length,
      };
    }

    case "list": {
      return { ...asked, items: Array.isArray(initial) ? initial : [] };
    }

    case "json": {
      const start = initial ?? exampleOf(field.schema);

      return {
        ...asked,
        text: start === undefined ? "" : JSON.stringify(start),
      };
    }

    default: {
      return { ...asked, text: initial === undefined ? "" : String(initial) };
    }
  }
};

export const createForm = (opts: {
  title: string;
  schema: JsonSchema;
  note?: string;
  /** Starts the fields from this value. */
  initial?: unknown;
}): FormState => {
  const base: FormState = {
    title: opts.title,
    note: opts.note,
    schema: opts.schema,
    fields: fieldsOf(opts.schema),
    prefill: opts.initial,
    answers: {},
    step: "ask",
    field: 0,
    editing: false,
    text: "",
    items: [],
    cursor: 0,
  };

  return askField(base, 0, false);
};

const review = (state: FormState): FormState => {
  return {
    ...state,
    step: "review",
    editing: false,
    cursor: 0,
    error: undefined,
  };
};

/** Keep an answer (or, with none, leave the field out) and go on. */
const answer = (
  state: FormState,
  field: Field,
  value: { value: unknown } | undefined,
): FormState => {
  const { [fieldKey(field)]: _, ...others } = state.answers;
  const next = {
    ...state,
    answers: value ? { ...others, [fieldKey(field)]: value.value } : others,
  };

  if (state.editing || state.field + 1 >= state.fields.length) {
    return review(next);
  }

  return askField(next, state.field + 1, false);
};

const submitText = (state: FormState, field: Field): FormState => {
  const empty = state.text.trim() === "";

  if (field.kind === "list") {
    if (empty) {
      return answer(
        state,
        field,
        state.items.length === 0 && !field.required
          ? undefined
          : { value: state.items },
      );
    }

    const items = field.schema.items as JsonSchema;
    const reading = readAnswer(kindOf(items), items, state.text);

    return "error" in reading
      ? { ...state, error: reading.error }
      : {
          ...state,
          items: [...state.items, reading.value],
          text: "",
          error: undefined,
        };
  }

  if (empty) {
    return field.required
      ? { ...state, error: "Required." }
      : answer(state, field, undefined);
  }

  const reading = readAnswer(field.kind, field.schema, state.text);

  return "error" in reading
    ? { ...state, error: reading.error }
    : answer(state, field, reading);
};

const reduceAsk = (state: FormState, key: Key): FormState => {
  const field = state.fields[state.field] as Field;

  if (field.kind !== "choice") {
    if (key.name === "return") {
      return submitText(state, field);
    }

    const text = reduceText({ question: "", text: state.text }, key).text;

    return text === state.text ? state : { ...state, text, error: undefined };
  }

  const last = field.options.length - (field.required ? 1 : 0);

  if (key.name === "up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.name === "down") {
    return { ...state, cursor: Math.min(last, state.cursor + 1) };
  }

  if (key.name === "return") {
    const option = field.options[state.cursor];

    return answer(state, field, option ? { value: option.value } : undefined);
  }

  return state;
};

const reduceReview = (state: FormState, key: Key): FormState => {
  if (key.name === "up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.name === "down") {
    return {
      ...state,
      cursor: Math.min(reviewActions.length - 1, state.cursor + 1),
    };
  }

  if (key.name !== "return") {
    return state;
  }

  switch (reviewActions[state.cursor]) {
    case "Run": {
      return {
        ...state,
        outcome: { kind: "submit", value: formValue(state) },
      };
    }

    case "Edit a field": {
      return { ...state, step: "pick", cursor: 0 };
    }

    default: {
      return askField({ ...state, answers: {} }, 0, false);
    }
  }
};

const reducePick = (state: FormState, key: Key): FormState => {
  if (key.name === "escape") {
    return review(state);
  }

  if (key.name === "up") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.name === "down") {
    return {
      ...state,
      cursor: Math.min(state.fields.length - 1, state.cursor + 1),
    };
  }

  return key.name === "return" ? askField(state, state.cursor, true) : state;
};

/**
 * Typing, `↑` `↓` and `enter` answer the field being asked; the review's
 * `enter` runs, edits a field or starts over. `esc` and Ctrl-C cancel, except
 * that `esc` backs out of picking a field.
 */
export const reduceForm = (state: FormState, key: Key): FormState => {
  const cancelled = isCancel(key) && (state.step !== "pick" || key.ctrl);

  if (cancelled) {
    return { ...state, outcome: { kind: "cancel" } };
  }

  switch (state.step) {
    case "ask": {
      return reduceAsk(state, key);
    }

    case "review": {
      return reduceReview(state, key);
    }

    case "pick": {
      return reducePick(state, key);
    }
  }
};
