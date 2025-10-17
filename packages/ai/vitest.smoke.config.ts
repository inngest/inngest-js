import { defineConfig } from "vitest/config";

// Allow filtering to only OpenAI smoke tests via:
// - pnpm test:smoke --openai
// - or environment variable OPENAI_ONLY=1
// - or npm_config_openai injected by pnpm when passing --openai
const argv = process.argv;
const openaiOnly =
  argv.includes("--openai") ||
  process.env.npm_config_openai !== undefined ||
  process.env.OPENAI_ONLY === "1";

export default defineConfig({
  test: {
    // Only include smoke tests; optionally filter to OpenAI-only
    include: openaiOnly
      ? ["test/smoke/openai-responses.smoke.test.ts"]
      : ["test/smoke/**/*.{test,spec}.{js,ts}"],
    environment: "node",
    testTimeout: 30000, // Longer timeout for network calls
    hookTimeout: 10000, // Longer hook timeout for setup/teardown
  },
});
