import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    silent: "passed-only",
    typecheck: {
      enabled: true,
      include: ["src/**/*.test.ts"],
    },
  },
});
