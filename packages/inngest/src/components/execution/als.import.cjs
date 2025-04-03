/**
 * This file is used to conditionally import the `AsyncLocalStorage` class from
 * the `node:async_hooks` module. While this is available in most supported
 * runtimes (Node, Bun, Deno), it is not available in all, especially browsers.
 *
 * This file safely imports the module, but also does it within a `.cjs`,
 * meaning Webpack will not attempt to statically analyze the import and
 * complain about it not being available in the browser before it attempts to
 * import.
 */
let als;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, no-undef
  const { AsyncLocalStorage } = require("node:async_hooks");
  als = new AsyncLocalStorage();
} catch {
  // eslint-disable-next-line no-undef
  console.warn(
    "node:async_hooks is not supported in this runtime. Experimental async context is disabled."
  );

  als = {
    getStore: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
    run: (_, fn) => fn(),
  };
}

// eslint-disable-next-line no-undef
module.exports = { als };
