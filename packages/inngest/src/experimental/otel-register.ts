/**
 * Registers OpenTelemetry's ESM loader hook so that module-load-based
 * instrumentations (http, Express, pg, Anthropic, etc.) can patch ES modules.
 *
 * In CommonJS apps, OpenTelemetry instrumentations patch modules by hooking
 * `require()`, which works at any point at runtime. In ESM apps, imports are
 * resolved by the module loader before any application code runs, so patching
 * requires a loader hook that must be registered before the application's
 * modules are imported. A middleware can never do that itself; it has to
 * happen via Node's `--import` flag.
 *
 * Use this entrypoint when using `extendedTracesMiddleware` with the
 * `"createProvider"` (or `"auto"`) behaviour in an ESM application:
 *
 * ```sh
 * node --import inngest/experimental/otel-register ./app.js
 * ```
 *
 * @module
 */
import * as nodeModule from "node:module";

type ModuleWithRegister = {
  register?: (specifier: string, opts: { parentURL: string }) => void;
};

// Resolve `register` across our ESM and CJS builds; it's also absent on
// Node.js versions older than 20.6.
const mod = nodeModule as ModuleWithRegister & { default?: ModuleWithRegister };
const register = mod.register ?? mod.default?.register;

try {
  if (typeof register === "function") {
    // Resolve the hook relative to this file so it uses the same copy of
    // `@opentelemetry/instrumentation` as the instrumentations registered by
    // `extendedTracesMiddleware`.
    register("@opentelemetry/instrumentation/hook.mjs", {
      parentURL: import.meta.url,
    });
  } else {
    console.warn(
      "inngest: this version of Node.js does not support module.register(); OpenTelemetry instrumentation will not be able to patch ES modules",
    );
  }
} catch (err) {
  console.warn(
    "inngest: failed to register the OpenTelemetry ESM loader hook; extended traces may miss spans from instrumented modules",
    err,
  );
}
