/**
 * Tests for the form's frames at a fixed width and height, with colour off.
 *
 * @module
 */

import type { Key } from "node:readline";
import { describe, expect, test } from "vitest";

import type { JsonSchema } from "../../local/jsonSchema.ts";
import { createPaint } from "../render/format.ts";
import { createForm, type FormState, reduceForm } from "./form.ts";
import { formLines } from "./formView.ts";

const paint = createPaint(false);

const deploy: JsonSchema = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["web", "api"],
      description: "Where to deploy",
    },
    dryRun: {
      type: "boolean",
      default: true,
      description: "Build and check without releasing",
    },
    note: { type: "string", description: "Shown on the release page" },
  },
  required: ["target"],
};

/** Press keys, or type text, in order. */
const press = (state: FormState, ...inputs: string[]): FormState => {
  return inputs.reduce((current, input) => {
    const key: Key =
      input.length === 1 ? { sequence: input, name: input } : { name: input };

    return reduceForm(current, key);
  }, state);
};

const draw = (state: FormState, height = 24, width = 64) => {
  return formLines(state, { width, height, paint });
};

const start = (schema: JsonSchema = deploy, note?: string) => {
  return createForm({ title: "deploy · event data", schema, note });
};

/** Through `target` and `dryRun`, with `note` half typed. */
const atNote = () => {
  return press(start(), "down", "return", "return", ..."ship it");
};

describe("asking", () => {
  test("shows a choice's guidance and its options", () => {
    expect(draw(start())).toEqual([
      "  deploy · event data",
      "",
      "  target  1 of 3 · required",
      "  Where to deploy",
      "› web",
      "  api",
      "",
      "  ↑↓ move · enter pick · esc cancel",
    ]);
  });

  test("marks the default option and offers to leave an optional field out", () => {
    expect(draw(press(start(), "return"))).toEqual([
      "  deploy · event data",
      "",
      "  ✓ target  web",
      "",
      "  dryRun  2 of 3 · optional · default yes",
      "  Build and check without releasing",
      "› yes  default",
      "  no",
      "  leave out",
      "",
      "  ↑↓ move · enter pick · esc cancel",
    ]);
  });

  test("shows a text field mid-way, with what was answered above it", () => {
    expect(draw(atNote())).toEqual([
      "  deploy · event data",
      "",
      "  ✓ target  api",
      "  ✓ dryRun  yes",
      "",
      "  note  3 of 3 · optional · string",
      "  Shown on the release page",
      "› ship it▏",
      "",
      "  enter confirm · empty enter leaves it out · esc cancel",
    ]);
  });

  test("shows a field that was left out, and an error under the prompt", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        note: { type: "string" },
        retries: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["retries"],
    };
    const lines = draw(press(start(schema), "return", "9", "return"));

    expect(lines).toEqual([
      "  deploy · event data",
      "",
      "  – note  left out",
      "",
      "  retries  2 of 2 · required · integer, 1 to 5",
      "› 9▏",
      "  Must be at most 5.",
      "",
      "  enter confirm · ctrl-u clears · esc cancel",
    ]);
  });

  test("shows the items of a list so far", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    };

    expect(
      draw(press(start(schema), "a", "return", "b", "return", "c")),
    ).toEqual([
      "  deploy · event data",
      "",
      "  tags  optional · list of strings",
      "  · a",
      "  · b",
      "› c▏",
      "",
      "  enter adds an item · empty enter finishes · esc cancel",
    ]);
  });

  test("says why a form has no fields to offer, wrapped to the width", () => {
    const lines = draw(
      start(
        {},
        "build takes input but has no schema. Add `input: <schema>` to `ci.job` to get a form.",
      ),
      24,
      40,
    );

    expect(lines.slice(0, 4)).toEqual([
      "  deploy · event data",
      "  build takes input but has no schema.",
      "  Add `input: <schema>` to `ci.job` to",
      "  get a form.",
    ]);
    expect(lines.at(-3)).toBe("› ▏");
  });

  test("drops the oldest answers when the height is short", () => {
    const lines = draw(atNote(), 9);

    expect(lines).toHaveLength(9);
    expect(lines[2]).toBe("  ✓ dryRun  yes");
    expect(lines.at(-1)).toContain("esc cancel");
  });

  test("cuts every line to the width", () => {
    const lines = draw(atNote(), 24, 20);

    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      20,
    );
  });
});

describe("reviewing", () => {
  const review = () => {
    return press(atNote(), "return");
  };

  test("pretty-prints the value above the three actions", () => {
    expect(draw(review())).toEqual([
      "  deploy · event data",
      "",
      "  {",
      '    "target": "api",',
      '    "dryRun": true,',
      '    "note": "ship it"',
      "  }",
      "",
      "› Run",
      "  Edit a field",
      "  Start over",
      "",
      "  ↑↓ move · enter pick · esc cancel",
    ]);
  });

  test("cuts a long value to the height, saying how much", () => {
    const lines = draw(review(), 11);

    expect(lines).toHaveLength(11);
    expect(lines[4]).toBe("  … 3 more lines");
  });

  test("lists the fields to edit, with their values", () => {
    expect(draw(press(review(), "down", "return"))).toEqual([
      "  deploy · event data",
      "",
      "  Which field?",
      "› target  api",
      "  dryRun  yes",
      "  note    ship it",
      "",
      "  ↑↓ move · enter edit · esc back",
    ]);
  });

  test("scrolls the field list around the cursor", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        ["a", "b", "c", "d", "e", "f"].map((name) => {
          return [name, { type: "string" }];
        }),
      ),
    };
    const done = press(start(schema), ...Array(6).fill("return"));
    const lines = draw(
      press(done, "down", "return", "down", "down", "down", "down"),
      8,
    );

    expect(lines).toHaveLength(8);
    expect(lines.join("\n")).toContain("› e");
  });
});
