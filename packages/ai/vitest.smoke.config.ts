import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only include smoke tests
    include: ["test/smoke/**/*.{test,spec}.{js,ts}"],
    environment: "node",
    testTimeout: 30000, // Longer timeout for network calls
    hookTimeout: 10000, // Longer hook timeout for setup/teardown
  },
});
