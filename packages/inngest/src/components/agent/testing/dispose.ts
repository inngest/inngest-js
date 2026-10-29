/**
 * @module
 * `Symbol.asyncDispose` where the runtime has it, and the registered symbol
 * `await using` reads where it does not (Node before 20.5).
 */
export const asyncDispose: typeof Symbol.asyncDispose =
  Symbol.asyncDispose ?? (Symbol.for("Symbol.asyncDispose") as never);
