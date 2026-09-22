// After `pnpm --filter inngest build`, from packages/inngest:
// node test/effect-platform/run.mjs
// bun test/effect-platform/run.mjs
// deno run --no-lock --node-modules-dir=manual --allow-env --allow-read --allow-sys test/effect-platform/run.mjs
import { runPlatformSmoke } from "./scenario.mjs";

console.log(JSON.stringify(await runPlatformSmoke(), null, 2));
