/**
 * Tests for reading a JSON Schema into form fields, and for checking and
 * assembling their answers.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { JsonSchema } from "../../local/jsonSchema.ts";
import {
  assemble,
  describeFields,
  describeProblems,
  exampleOf,
  fieldKey,
  fieldsOf,
  problemsOf,
  readAnswer,
  typeLabel,
  valueAt,
} from "./formSchema.ts";

const deploy: JsonSchema = {
  type: "object",
  properties: {
    target: { type: "string", enum: ["web", "api"] },
    dryRun: { type: "boolean", default: true },
    note: { type: "string", description: "Shown on the release" },
    retries: { type: "integer", minimum: 0, maximum: 5 },
    tags: { type: "array", items: { type: "string" } },
    limits: {
      type: "object",
      properties: {
        cpu: { type: "number" },
        memory: { type: "number" },
      },
      required: ["cpu"],
    },
    env: { type: "object" },
    channel: {
      anyOf: [{ const: "stable", title: "Stable" }, { const: "next" }],
    },
    hosts: { type: "array", items: { type: "object" } },
  },
  required: ["target", "limits"],
};

const kinds = (schema: JsonSchema) => {
  return fieldsOf(schema).map((field) => {
    return [fieldKey(field), field.kind, field.required];
  });
};

describe("fieldsOf", () => {
  test("asks an object property by property, in order, with nested paths", () => {
    expect(kinds(deploy)).toEqual([
      ["target", "choice", true],
      ["dryRun", "choice", false],
      ["note", "text", false],
      ["retries", "number", false],
      ["tags", "list", false],
      ["limits.cpu", "number", true],
      ["limits.memory", "number", false],
      ["env", "json", false],
      ["channel", "choice", false],
      ["hosts", "json", false],
    ]);
  });

  test("lists the options of an enum, a boolean and a union of consts", () => {
    const options = (key: string) => {
      return fieldsOf(deploy)
        .find((field) => {
          return fieldKey(field) === key;
        })
        ?.options.map((option) => {
          return option.label;
        });
    };

    expect(options("target")).toEqual(["web", "api"]);
    expect(options("dryRun")).toEqual(["yes", "no"]);
    expect(options("channel")).toEqual(["Stable", "next"]);
  });

  test("a nested field is required only when everything around it is", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        build: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
    };

    expect(kinds(schema)).toEqual([["build.target", "text", false]]);
  });

  test("a schema that isn't an object is one field with no path", () => {
    expect(fieldsOf({ type: "string" })).toMatchObject([
      { path: [], kind: "text", required: true },
    ]);
    expect(kinds({ type: "object" })).toEqual([["", "json", true]]);
    expect(kinds({})).toEqual([["", "json", true]]);
  });

  test("falls back to JSON for what has no prompt of its own", () => {
    expect(
      kinds({
        type: "object",
        properties: {
          union: { anyOf: [{ type: "string" }, { type: "number" }] },
          nullable: { type: ["string", "null"] },
          rows: { type: "array", items: { type: "object" } },
          flags: { type: "array", items: { type: "boolean" } },
        },
      }).map(([, kind]) => kind),
    ).toEqual(["json", "json", "json", "json"]);
  });
});

describe("typeLabel and describeFields", () => {
  test("says each field's type, with ranges and options", () => {
    expect(
      fieldsOf(deploy).map((field) => {
        return typeLabel(field);
      }),
    ).toEqual([
      "web | api",
      "yes or no",
      "string",
      "integer, 0 to 5",
      "list of strings",
      "number",
      "number",
      "JSON",
      "Stable | next",
      "JSON",
    ]);
    expect(
      typeLabel(fieldsOf({ type: "number", minimum: 1 })[0] as never),
    ).toBe("number, at least 1");
    expect(
      typeLabel(fieldsOf({ type: "number", maximum: 9 })[0] as never),
    ).toBe("number, at most 9");
  });

  test("lists the fields with their types, marking optional ones", () => {
    expect(
      describeFields({
        type: "object",
        properties: {
          target: { type: "string", enum: ["web", "api"] },
          note: { type: "string" },
        },
        required: ["target"],
      }),
    ).toBe("target (web | api), note (string, optional)");
  });
});

describe("exampleOf", () => {
  test("is the default, else something of the schema's shape", () => {
    expect(exampleOf({ type: "string", default: "x" })).toBe("x");
    expect(exampleOf({ type: "string" })).toBe("");
    expect(exampleOf({ type: "integer", minimum: 3 })).toBe(3);
    expect(exampleOf({ type: "number" })).toBe(0);
    expect(exampleOf({ type: "boolean" })).toBe(true);
    expect(exampleOf({ type: "array", items: { type: "string" } })).toEqual([]);
    expect(exampleOf({ type: "string", enum: ["b", "a"] })).toBe("b");
    expect(exampleOf({ anyOf: [{ type: "number" }, { type: "string" }] })).toBe(
      0,
    );
    expect(exampleOf({})).toBeUndefined();
  });

  test("describes an object by its properties", () => {
    expect(
      exampleOf({
        type: "object",
        properties: {
          name: { type: "string" },
          size: { type: "integer", default: 2 },
        },
      }),
    ).toEqual({ name: "", size: 2 });
  });
});

describe("problemsOf", () => {
  const messages = (schema: JsonSchema, value: unknown) => {
    return describeProblems(schema, value);
  };

  test("accepts what matches", () => {
    expect(
      messages(deploy, {
        target: "web",
        limits: { cpu: 1 },
        tags: ["a"],
        retries: 5,
      }),
    ).toEqual([]);
  });

  test("names a missing required property, nested too", () => {
    expect(messages(deploy, {})).toEqual([
      "target: Required.",
      "limits: Required.",
    ]);
    expect(messages(deploy, { target: "web", limits: {} })).toEqual([
      "limits.cpu: Required.",
    ]);
  });

  test("checks types, enums, ranges and list items", () => {
    expect(
      messages(deploy, {
        target: "mars",
        dryRun: "yes",
        note: 3,
        retries: 6,
        tags: ["a", 1],
        limits: { cpu: "fast" },
      }),
    ).toEqual([
      "target: Must be one of web, api.",
      "dryRun: Must be true or false.",
      "note: Must be a string.",
      "retries: Must be at most 5.",
      "tags.1: Must be a string.",
      "limits.cpu: Must be a number.",
    ]);
    expect(messages({ type: "integer" }, 1.5)).toEqual([
      "Must be a whole number.",
    ]);
    expect(messages({ type: "number", minimum: 2 }, 1)).toEqual([
      "Must be at least 2.",
    ]);
    expect(messages({ type: "array" }, "a")).toEqual(["Must be a list."]);
    expect(messages({ type: "object" }, [])).toEqual(["Must be an object."]);
  });

  test("lets through what it can't be sure of", () => {
    expect(
      problemsOf({ anyOf: [{ type: "string" }, { type: "number" }] }, true),
    ).toEqual([]);
    expect(problemsOf({ type: ["string", "null"] }, 3)).toEqual([]);
    expect(problemsOf({}, "anything")).toEqual([]);
  });
});

describe("readAnswer", () => {
  test("takes text as typed", () => {
    expect(readAnswer("text", { type: "string" }, " hi ")).toEqual({
      value: " hi ",
    });
  });

  test("parses a number and checks it against the range", () => {
    const schema: JsonSchema = { type: "integer", minimum: 1, maximum: 10 };

    expect(readAnswer("number", schema, "7")).toEqual({ value: 7 });
    expect(readAnswer("number", schema, "abc")).toEqual({
      error: "Enter a number.",
    });
    expect(readAnswer("number", schema, "")).toEqual({
      error: "Enter a number.",
    });
    expect(readAnswer("number", schema, "2.5")).toEqual({
      error: "Must be a whole number.",
    });
    expect(readAnswer("number", schema, "0")).toEqual({
      error: "Must be at least 1.",
    });
    expect(readAnswer("number", schema, "11")).toEqual({
      error: "Must be at most 10.",
    });
  });

  test("parses JSON and checks it against the schema", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    };

    expect(readAnswer("json", schema, '{"a":1}')).toEqual({ value: { a: 1 } });
    expect(readAnswer("json", schema, "{")).toEqual({
      error: "Not valid JSON.",
    });
    expect(readAnswer("json", schema, "{}")).toEqual({
      error: "a: Required.",
    });
  });
});

describe("assemble and valueAt", () => {
  test("builds the nested value from the answers, leaving out what was skipped", () => {
    expect(
      assemble(deploy, {
        target: "web",
        "limits.cpu": 2,
        tags: ["a"],
      }),
    ).toEqual({ target: "web", tags: ["a"], limits: { cpu: 2 } });
  });

  test("a required object is there even with nothing answered in it", () => {
    expect(assemble(deploy, {})).toEqual({ limits: {} });
  });

  test("an optional object nothing was answered in is left out", () => {
    expect(
      assemble(
        {
          type: "object",
          properties: {
            extra: { type: "object", properties: { a: { type: "string" } } },
          },
        },
        {},
      ),
    ).toEqual({});
  });

  test("a schema that isn't an object is its one answer", () => {
    expect(assemble({ type: "string" }, { "": "x" })).toBe("x");
    expect(assemble({ type: "string" }, {})).toBeUndefined();
  });

  test("reads a value at a path", () => {
    expect(valueAt({ a: { b: 1 } }, ["a", "b"])).toBe(1);
    expect(valueAt({ a: 1 }, ["a", "b"])).toBeUndefined();
    expect(valueAt("x", [])).toBe("x");
    expect(valueAt(undefined, ["a"])).toBeUndefined();
  });
});
