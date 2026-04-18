import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/integration/**/*.test.ts"],
    globalSetup: ["./vitest.setup.integration.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    silent: "passed-only",
    hideSkippedTests: true,
  },
});
