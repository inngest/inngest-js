import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    silent: "passed-only",
    setupFiles: ["src/testing/setup.ts"],
    typecheck: {
      enabled: true,
      include: ["src/**/*.test.ts"],
    },
  },
});
