import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["@sentry/core", "@sentry/types"],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/test/integration/**/*.test.ts"],
    globalSetup: ["./vitest.setup.integration.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    silent: "passed-only",
    hideSkippedTests: true,
    typecheck: {
      enabled: true,
      include: ["src/test/integration/**/*.test.ts"],
      ignoreSourceErrors: true,
      tsconfig: "./tsconfig.integration.json",
    },
  },
});
