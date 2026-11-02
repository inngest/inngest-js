/**
 * @module
 * EXPERIMENTAL: Small checks on values that arrive from outside: a value
 * against a Standard Schema, a hand-written object schema, an allow list and
 * an ask signal. Each failure is a `NonRetriableError`, since retrying cannot
 * change the value.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { NonRetriableError } from "../NonRetriableError.ts";

/**
 * Checks `value` against a Standard Schema synchronously, for the small
 * hand-written schemas of the trigger helpers. A value that does not fit is a
 * `NonRetriableError`: retrying cannot change the event.
 */
export const parseWith = <T>(
  /**
   * A schema whose validation is synchronous.
   */
  schema: StandardSchemaV1<unknown, T>,

  /**
   * The value to check.
   */
  value: unknown,

  /**
   * Names the value in the error.
   */
  what: string,
): T => {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error(`${what}: the schema must validate synchronously.`);
  }

  if (result.issues) {
    throw new NonRetriableError(
      `${what}: ${result.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; ")}`,
    );
  }

  return result.value;
};

/**
 * Like `parseWith()`, for a schema that may validate asynchronously.
 */
export const parseWithAsync = async <T>(
  /**
   * The schema.
   */
  schema: StandardSchemaV1<unknown, T>,

  /**
   * The value to check.
   */
  value: unknown,

  /**
   * Names the value in the error.
   */
  what: string,
): Promise<T> => {
  const result = await schema["~standard"].validate(value);

  if (result.issues) {
    throw new NonRetriableError(
      `${what}: ${result.issues
        .map((issue) => {
          return issue.message;
        })
        .join("; ")}`,
    );
  }

  return result.value;
};

/**
 * What a field of `objectSchema` must be.
 *
 * - `"string"` and `"number"`: required.
 * - `{ integer }`: a whole number from `min` to `max`.
 * - `"string?"`: a string, or missing.
 * - `"nullable"`: a string, missing or null.
 * - `{ pattern }`: a string the pattern matches; with `optional`, or missing.
 */
export type FieldSpec =
  | "string"
  | "string?"
  | "nullable"
  | "number"
  | { integer: { min: number; max: number } }
  | { pattern: RegExp; optional?: boolean };

/**
 * A Standard Schema for an object with the listed fields. Other fields pass
 * through.
 */
export const objectSchema = <T>(
  fields: Record<string, FieldSpec>,
): StandardSchemaV1<unknown, T> => {
  return {
    "~standard": {
      version: 1,
      vendor: "inngest",
      validate: (value) => {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "expected an object" }] };
        }

        const issues: StandardSchemaV1.Issue[] = [];

        for (const [field, spec] of Object.entries(fields)) {
          const found = (value as Record<string, unknown>)[field];

          const optional =
            spec === "string?" ||
            spec === "nullable" ||
            (typeof spec === "object" &&
              "optional" in spec &&
              spec.optional === true);

          if (found === undefined && optional) {
            continue;
          }

          if (found === null && spec === "nullable") {
            continue;
          }

          const wanted =
            spec === "number" || (typeof spec === "object" && "integer" in spec)
              ? "number"
              : "string";

          if (typeof found !== wanted) {
            issues.push({
              message: `\`${field}\` must be a ${wanted}`,
              path: [field],
            });

            continue;
          }

          if (
            typeof spec === "object" &&
            "integer" in spec &&
            !(
              Number.isSafeInteger(found) &&
              (found as number) >= spec.integer.min &&
              (found as number) <= spec.integer.max
            )
          ) {
            issues.push({
              message: `\`${field}\` is not a valid value`,
              path: [field],
            });

            continue;
          }

          if (
            typeof spec === "object" &&
            "pattern" in spec &&
            !spec.pattern.test(found as string)
          ) {
            issues.push({
              message: `\`${field}\` is not a valid value`,
              path: [field],
            });
          }
        }

        return issues.length > 0 ? { issues } : { value: value as T };
      },
    },
  };
};

/**
 * Throws a `NonRetriableError` unless `value` is in the allow list. The
 * triggers filter on the same list, but an event can reach a channel by
 * another route, so the channel checks it again.
 */
export const assertAllowed = (
  /**
   * What is checked, for the error: `"channel"`, `"repository"`.
   */
  what: string,

  /**
   * The value from the event.
   */
  value: string,

  /**
   * The allowed values.
   */
  allowed: readonly string[],
): void => {
  if (!allowed.includes(value)) {
    throw new NonRetriableError(
      `The ${what} "${value}" is not in the allow list, so nothing is posted there.`,
    );
  }
};

/**
 * Throws a `NonRetriableError` unless `signal` is safe to put in a button, a
 * block ID or a comment marker.
 */
export const assertSignal = (
  /**
   * The ask's signal.
   */
  signal: string,
): void => {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(signal)) {
    throw new NonRetriableError(
      "An ask signal is 1 to 200 letters, digits, and the characters _ . : -.",
    );
  }
};
