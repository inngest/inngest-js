import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^inngest$/,
        replacement: path.resolve(__dirname, "../inngest/src/index.ts"),
      },
      {
        find: /^inngest\/node$/,
        replacement: path.resolve(__dirname, "../inngest/src/node.ts"),
      },
      {
        find: "@inngest/test-harness",
        replacement: path.resolve(__dirname, "../test-harness/src/index.ts"),
      },
    ],
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
  },
});
