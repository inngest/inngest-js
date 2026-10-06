/**
 * Tests for the input form's state: asking each kind of field, defaults,
 * skipping, inline errors, the review, editing a field, starting over and
 * starting from a saved value.
 *
 * @module
 */

import type { Key } from "node:readline";
import { describe, expect, test } from "vitest";

import type { JsonSchema } from "../../local/jsonSchema.ts";
import { createForm, type FormState, formValue, reduceForm } from "./form.ts";

const deploy: JsonSchema = {
  type: "object",
  properties: {
    target: { type: "string", enum: ["web", "api"] },
    dryRun: { type: "boolean", default: true },
    note: { type: "string", description: "Shown on the release" },
  },
  required: ["target"],
};

/** Press keys, or type text, in order. A name of more than one character is a key. */
const press = (state: FormState, ...inputs: string[]): FormState => {
  return inputs.reduce((current, input) => {
    if (input.length === 1) {
      return reduceForm(current, { sequence: input, name: input });
    }

    const key: Key =
      input === "ctrl-c"
        ? { ctrl: true, name: "c" }
        : input === "ctrl-u"
          ? { ctrl: true, name: "u", sequence: "\x15" }
          : { name: input };

    return reduceForm(current, key);
  }, state);
};

const type = (state: FormState, text: string): FormState => {
  return press(state, ...text.split(""));
};

const start = (schema: JsonSchema = deploy, initial?: unknown) => {
  return createForm({ title: "deploy · event data", schema, initial });
};

/** Answer every field of the deploy form with its first option or `note`, then review. */
const finished = (): FormState => {
  return press(type(press(start(), "return", "return"), "ship it"), "return");
};

describe("asking", () => {
  test("starts on the first field, a choice on its first option", () => {
    const state = start();

    expect(state).toMatchObject({ step: "ask", field: 0, cursor: 0 });
    expect(state.fields.map((field) => field.path.join("."))).toEqual([
      "target",
      "dryRun",
      "note",
    ]);
  });

  test("a choice moves within its options and picks with enter", () => {
    const state = press(start(), "up", "down", "down", "return");

    expect(state.field).toBe(1);
    expect(state.answers).toEqual({ target: "api" });
  });

  test("an optional boolean with a default starts on it, and enter accepts", () => {
    const state = press(start(), "return");

    expect(state.field).toBe(1);
    expect(state.cursor).toBe(0);
    expect(press(state, "return").answers).toEqual({
      target: "web",
      dryRun: true,
    });
  });

  test("an optional choice with nothing to start from starts on leave out", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { size: { type: "string", enum: ["s", "m"] } },
    };
    const state = start(schema);

    expect(state.cursor).toBe(2);
    expect(press(state, "up", "up", "up").cursor).toBe(0);
    expect(press(state, "down").cursor).toBe(2);
    expect(press(state, "return").answers).toEqual({});
  });

  test("a required choice has no leave out", () => {
    expect(press(start(), "down", "down", "down").cursor).toBe(1);
  });

  test("a text field is typed, and enter on nothing leaves an optional one out", () => {
    const atNote = press(start(), "return", "return");

    expect(atNote.field).toBe(2);
    expect(press(atNote, "return").answers).toEqual({
      target: "web",
      dryRun: true,
    });
    expect(type(atNote, "hi there").text).toBe("hi there");
    expect(press(type(atNote, "hi there"), "return").answers).toMatchObject({
      note: "hi there",
    });
  });

  test("a default prefills a text field, and enter accepts it", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { region: { type: "string", default: "eu" } },
    };
    const state = start(schema);

    expect(state.text).toBe("eu");
    expect(press(state, "return").answers).toEqual({ region: "eu" });
    expect(press(state, "ctrl-u", "return").answers).toEqual({});
  });

  test("an empty required field is refused, and typing clears the refusal", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const refused = press(start(schema), "return");

    expect(refused.error).toBe("Required.");
    expect(refused.step).toBe("ask");
    expect(type(refused, "a").error).toBeUndefined();
  });

  test("a number is checked inline, and the form stays on the field", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { retries: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["retries"],
    };
    const wrong = press(type(start(schema), "9"), "return");

    expect(wrong).toMatchObject({
      step: "ask",
      field: 0,
      error: "Must be at most 5.",
    });
    expect(type(start(schema), "abc").text).toBe("abc");
    expect(press(type(start(schema), "abc"), "return").error).toBe(
      "Enter a number.",
    );

    const fixed = press(wrong, "backspace", "3", "return");

    expect(fixed.answers).toEqual({ retries: 3 });
    expect(fixed.step).toBe("review");
  });

  test("a list takes items one at a time, and an empty entry finishes", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    };
    const added = press(
      type(press(type(start(schema), "a"), "return"), "b"),
      "return",
    );

    expect(added.items).toEqual(["a", "b"]);
    expect(added.text).toBe("");
    expect(press(added, "return").answers).toEqual({ tags: ["a", "b"] });
  });

  test("a list checks each item, and an empty optional list is left out", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { ports: { type: "array", items: { type: "integer" } } },
      required: ["ports"],
    };

    expect(press(type(start(schema), "x"), "return").error).toBe(
      "Enter a number.",
    );
    expect(press(start(schema), "return").answers).toEqual({ ports: [] });
    expect(
      press(
        start({
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" } } },
        }),
        "return",
      ).answers,
    ).toEqual({});
  });

  test("anything else is a JSON line, starting from an example", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        limits: {
          type: "object",
          properties: { cpu: { type: "number" } },
          required: ["cpu"],
        },
        rows: { type: "array", items: { type: "object" } },
      },
    };
    const state = start(schema);

    // `limits` has properties, so it is asked field by field; `rows` is JSON.
    expect(state.fields.map((field) => field.kind)).toEqual(["number", "json"]);

    const rows = press(type(state, "1"), "return");

    expect(rows.text).toBe("[]");
    expect(press(type(press(rows, "ctrl-u"), "["), "return").error).toBe(
      "Not valid JSON.",
    );
    expect(press(rows, "return").answers).toEqual({
      "limits.cpu": 1,
      rows: [],
    });
  });

  test("a JSON line is checked against what the schema says", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { a: { type: "number" } },
            required: ["a"],
          },
        },
      },
    };
    const state = type(press(start(schema), "ctrl-u"), "[{}]");

    expect(press(state, "return").error).toBe("0.a: Required.");
  });

  test("nested objects are asked with their path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        build: {
          type: "object",
          properties: { target: { type: "string", enum: ["web", "api"] } },
          required: ["target"],
        },
      },
      required: ["build"],
    };
    const state = press(start(schema), "down", "return");

    expect(state.answers).toEqual({ "build.target": "api" });
    expect(formValue(state)).toEqual({ build: { target: "api" } });
  });

  test("cancels on esc and Ctrl-C, but q is just a letter", () => {
    const atNote = press(start(), "return", "return");

    expect(press(start(), "escape").outcome).toEqual({ kind: "cancel" });
    expect(press(atNote, "ctrl-c").outcome).toEqual({ kind: "cancel" });
    expect(type(atNote, "q").text).toBe("q");
    expect(press(atNote, "q").outcome).toBeUndefined();
  });
});

describe("reviewing", () => {
  test("shows the value after the last field", () => {
    const state = finished();

    expect(state.step).toBe("review");
    expect(formValue(state)).toEqual({
      target: "web",
      dryRun: true,
      note: "ship it",
    });
  });

  test("Run submits the value", () => {
    expect(press(finished(), "return").outcome).toEqual({
      kind: "submit",
      value: { target: "web", dryRun: true, note: "ship it" },
    });
  });

  test("moves between the three actions", () => {
    expect(press(finished(), "down", "down", "down").cursor).toBe(2);
    expect(press(finished(), "up").cursor).toBe(0);
  });

  test("cancels on esc", () => {
    expect(press(finished(), "escape").outcome).toEqual({ kind: "cancel" });
  });

  test("Edit a field lists the fields and asks the picked one again, from its answer", () => {
    const picking = press(finished(), "down", "return");

    expect(picking.step).toBe("pick");

    const editing = press(picking, "down", "return");

    expect(editing).toMatchObject({ step: "ask", field: 1, editing: true });
    // The answer was `yes`, so the choice starts on it.
    expect(editing.cursor).toBe(0);

    const back = press(editing, "down", "return");

    expect(back.step).toBe("review");
    expect(formValue(back)).toEqual({
      target: "web",
      dryRun: false,
      note: "ship it",
    });
  });

  test("editing a text field starts from what was typed", () => {
    const editing = press(
      finished(),
      "down",
      "return",
      "down",
      "down",
      "return",
    );

    expect(editing.text).toBe("ship it");
    expect(
      formValue(press(type(press(editing, "ctrl-u"), "x"), "return")),
    ).toMatchObject({ note: "x" });
  });

  test("esc backs out of picking a field to the review", () => {
    expect(press(finished(), "down", "return", "escape").step).toBe("review");
    expect(press(finished(), "down", "return", "ctrl-c").outcome).toEqual({
      kind: "cancel",
    });
  });

  test("Start over clears the answers and asks the first field again", () => {
    const again = press(finished(), "down", "down", "return");

    expect(again).toMatchObject({ step: "ask", field: 0, answers: {} });
  });
});

describe("starting from a saved value", () => {
  const saved = { target: "api", dryRun: false, note: "from a fixture" };

  test("each field starts from its value, and enter goes through them", () => {
    const state = start(deploy, saved);

    expect(state.cursor).toBe(1);

    const done = press(state, "return", "return", "return");

    expect(done.step).toBe("review");
    expect(formValue(done)).toEqual(saved);
  });

  test("a text field starts from it, and over a default", () => {
    const atNote = press(start(deploy, saved), "return", "return");

    expect(atNote.text).toBe("from a fixture");
  });

  test("a value the saved one lacks falls back to the default", () => {
    const state = press(start(deploy, { target: "api" }), "return");

    expect(state.cursor).toBe(0);
  });

  test("Start over begins from the saved value again", () => {
    const state = press(
      press(start(deploy, saved), "return", "return", "return"),
      "down",
      "down",
      "return",
    );

    expect(state.cursor).toBe(1);
    expect(state.answers).toEqual({});
  });
});

describe("a schema that isn't an object", () => {
  test("asks one field, and the review shows its value", () => {
    const state = press(type(start({}), "1"), "return");

    expect(state.error).toBeUndefined();
    expect(state.step).toBe("review");
    expect(formValue(state)).toBe(1);
  });

  test("starts from a given value as JSON", () => {
    expect(start({}, { a: 1 }).text).toBe('{"a":1}');
    expect(start({}).text).toBe("");
  });

  test("keeps the note", () => {
    expect(createForm({ title: "t", schema: {}, note: "why" }).note).toBe(
      "why",
    );
  });
});
