/**
 * @module
 * `Symbol.asyncDispose`, installed where the runtime lacks it (Node before
 * 20.5) so `await using` works on the fakes without another module loaded
 * first.
 */
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);

export const asyncDispose: typeof Symbol.asyncDispose = Symbol.asyncDispose;
