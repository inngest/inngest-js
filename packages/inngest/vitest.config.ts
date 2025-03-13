/* eslint-disable import/no-unresolved */
/* eslint-disable import/no-extraneous-dependencies */
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
    silent: true,
    logHeapUsage: true,
    typecheck: {
      tsconfig: "./tsconfig.types.json",
    },
  },
});
