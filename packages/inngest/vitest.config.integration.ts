import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    tsConfigPaths({
      projects: ["./"],
    }),
  ],
  test: {
    environment: "node",
    globals: true,
    include: ["src/test/integration/**/*.test.ts"],
    globalSetup: ["./vitest.setup.integration.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    // Run tests sequentially since they share a Dev Server
    fileParallelism: false,
    silent: "passed-only",
    hideSkippedTests: true,
  },
});
