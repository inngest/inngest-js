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
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/**"],
    logHeapUsage: true,
    fileParallelism: true,
    silent: "passed-only",
    hideSkippedTests: true,
    typecheck: {
      tsconfig: "./tsconfig.types.json",
      enabled: true,
      include: ["**\/*.{test,spec}.?(c|m)[jt]s?(x)"],
    },
  },
});
