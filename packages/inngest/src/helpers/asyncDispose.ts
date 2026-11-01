/**
 * @module
 * `Symbol.asyncDispose`, installed where the runtime lacks it (Node before
 * 20.5) so `await using` finds the symbol the SDK's disposable objects use.
 * Import `asyncDispose` from here and use it as the key, so a bundler that
 * drops unused modules keeps this one.
 */
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);

export const asyncDispose: typeof Symbol.asyncDispose = Symbol.asyncDispose;
