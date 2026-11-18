import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["@sentry/core", "@sentry/types"],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["src/test/integration/**"],
  },
});
