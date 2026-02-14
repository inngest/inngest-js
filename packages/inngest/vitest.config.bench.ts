import codspeedPlugin from "@codspeed/vitest-plugin";
import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    codspeedPlugin(),
    tsConfigPaths({
      projects: ["./"],
    }),
  ],
  test: {
    benchmark: {
      include: ["src/bench/**/*.bench.ts"],
    },
    globalSetup: ["./vitest.setup.bench.ts"],
    fileParallelism: false,
    silent: "passed-only",
    testTimeout: 300_000,
  },
});
