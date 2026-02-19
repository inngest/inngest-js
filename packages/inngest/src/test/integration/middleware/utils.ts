import { describe, test } from "vitest";

/**
 * Runs a test with a matrix of levels: "client" and "function".
 */
export function matrixLevel(
  name: string,
  fn: (level: string) => Promise<void>,
) {
  describe(name, () => {
    for (const level of ["client", "function"]) {
      test(`level: ${level}`, () => fn(level));
    }
  });
}
