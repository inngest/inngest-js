import {
  instrumentTracing,
  registerNodeTraceInstrumentationHook,
} from "./instrument.ts";

// CommonJS preloads use require hooks; Node's async ESM hook registration can
// race with app startup when loaded through `--require`.
if (!import.meta.url.endsWith(".cjs")) {
  registerNodeTraceInstrumentationHook();
}

instrumentTracing();
