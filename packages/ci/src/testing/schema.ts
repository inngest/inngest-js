/**
 * A fake Standard Schema for tests: an object of required and defaulted
 * primitive fields that can also describe itself as JSON Schema, like Zod 4.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

type Primitive = "string" | "number" | "boolean";

/**
 * A schema for an object with `fields`. A field with a default may be left
 * out and takes it; any other is required. `toJSONSchema()` writes it the way
 * Zod does.
 */
export const fakeSchema = <TOutput extends Record<string, unknown>>(
  fields: Record<keyof TOutput, Primitive>,
  defaults: Partial<TOutput> = {},
): StandardSchemaV1<Record<string, unknown>, TOutput> & {
  toJSONSchema(): unknown;
} => {
  return {
    "~standard": {
      version: 1,
      vendor: "fake",
      validate: (input: unknown) => {
        const issues: StandardSchemaV1.Issue[] = [];
        const value: Record<string, unknown> = {};
        const given = (input ?? {}) as Record<string, unknown>;

        for (const [key, type] of Object.entries(fields)) {
          const field = given[key] ?? defaults[key];

          if (field === undefined) {
            issues.push({ message: "Required", path: [key] });
          } else if (typeof field !== type) {
            issues.push({ message: `Expected ${type}`, path: [key] });
          } else {
            value[key] = field;
          }
        }

        return issues.length > 0 ? { issues } : { value: value as TOutput };
      },
    },

    toJSONSchema() {
      return {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(fields).map(([key, type]) => {
            return [
              key,
              { type, ...(key in defaults ? { default: defaults[key] } : {}) },
            ];
          }),
        ),
        required: Object.keys(fields).filter((key) => {
          return !(key in defaults);
        }),
      };
    },
  };
};
