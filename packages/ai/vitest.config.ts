import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Include all test files except smoke tests by default
    include: ["src/**/*.{test,spec}.{js,ts}", "test/**/*.{test,spec}.{js,ts}"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "test/smoke/**", // Exclude smoke tests from default test run
    ],
    environment: "node",
  },
});
