/**
 * Tests for deriving JSON Schema from a Standard Schema. The schemas are
 * fakes shaped like each library's real output, so no library is installed.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vitest";

import { jsonSchemaOf } from "./jsonSchema.ts";

/** What Zod 4 writes for `z.object({ target: z.enum(["web", "api"]), dryRun: z.boolean().default(true) })`. */
const zodOutput = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    target: { type: "string", enum: ["web", "api"] },
    dryRun: { default: true, type: "boolean" },
  },
  required: ["target"],
};

/** A Standard Schema that accepts anything, with extras a library may add. */
const standard = (extras: object, standardExtras: object = {}) => {
  return {
    "~standard": {
      version: 1,
      vendor: "fake",
      validate: (value: unknown) => {
        return { value };
      },
      ...standardExtras,
    },
    ...extras,
  } as StandardSchemaV1;
};

describe("jsonSchemaOf", () => {
  test("reads the Standard JSON Schema interface, asking for draft 2020-12 input", () => {
    const targets: string[] = [];
    const schema = standard(
      {},
      {
        jsonSchema: {
          input: (options: { target: string }) => {
            targets.push(options.target);

            return zodOutput;
          },
        },
      },
    );

    expect(jsonSchemaOf(schema)).toEqual(zodOutput);
    expect(targets).toEqual(["draft-2020-12"]);
  });

  test("falls back to toJSONSchema(), as Zod has it", () => {
    const schema = standard({
      toJSONSchema() {
        return zodOutput;
      },
    });

    expect(jsonSchemaOf(schema)).toEqual(zodOutput);
  });

  test("falls back to toJsonSchema(), as ArkType has it", () => {
    const schema = standard({
      toJsonSchema() {
        return zodOutput;
      },
    });

    expect(jsonSchemaOf(schema)).toEqual(zodOutput);
  });

  test("prefers the Standard interface, then toJSONSchema()", () => {
    const schema = standard(
      {
        toJSONSchema() {
          return { type: "string" };
        },
        toJsonSchema() {
          return { type: "number" };
        },
      },
      {
        jsonSchema: {
          input() {
            return { type: "object" };
          },
        },
      },
    );

    expect(jsonSchemaOf(schema)).toEqual({ type: "object" });
    expect(
      jsonSchemaOf(
        standard({
          toJSONSchema() {
            return { type: "string" };
          },
          toJsonSchema() {
            return { type: "number" };
          },
        }),
      ),
    ).toEqual({ type: "string" });
  });

  test("moves on when a way throws, as a schema the library can't express does", () => {
    const schema = standard(
      {
        toJSONSchema() {
          throw new Error("transforms can't be represented");
        },
        toJsonSchema() {
          return zodOutput;
        },
      },
      {
        jsonSchema: {
          input() {
            throw new Error("nope");
          },
        },
      },
    );

    expect(jsonSchemaOf(schema)).toEqual(zodOutput);
  });

  test("is undefined for a library with no way, such as Valibot or Zod 3", () => {
    expect(jsonSchemaOf(standard({}))).toBeUndefined();
    expect(jsonSchemaOf(undefined)).toBeUndefined();
  });

  test("is undefined when every way throws or answers with something else", () => {
    expect(
      jsonSchemaOf(
        standard({
          toJSONSchema() {
            throw new Error("no");
          },
          toJsonSchema() {
            return "not a schema";
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      jsonSchemaOf(
        standard({
          toJSONSchema() {
            return [];
          },
        }),
      ),
    ).toBeUndefined();
  });
});
