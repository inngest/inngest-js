import "./pipelines/cache.ts";
import "./pipelines/durations.ts";
import "./pipelines/failures.ts";
import "./pipelines/from.ts";
import "./pipelines/images.ts";
import "./pipelines/inline.ts";
import "./pipelines/inputs.ts";

/**
 * Definitions that must fail when the app boots live apart, so one bad
 * definition doesn't take the other pipelines down: `E2E_BAD=<name>` loads it.
 */
if (process.env.E2E_BAD) {
  await import(`./bad/${process.env.E2E_BAD}.ts`);
}

export { ci } from "./client.ts";
