/**
 * @module
 * EXPERIMENTAL: A check of a value that arrives from outside against a
 * Standard Schema. A failure is a `NonRetriableError`, since retrying cannot
 * change the value.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";

/**
 * Checks `value` against a Standard Schema that may validate asynchronously. A
 * value that does not fit is a `NonRetriableError`.
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
