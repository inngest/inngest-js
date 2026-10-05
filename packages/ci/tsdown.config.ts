import { defineConfig } from "tsdown";

const shared = {
  fixedExtension: true,
  outDir: "dist",
  tsconfig: "tsconfig.build.json",
  target: "node20",
  platform: "node",
  sourcemap: true,
  failOnWarn: true,
  minify: false,
  report: true,
  deps: { neverBundle: true },
} as const;

export default defineConfig([
  {
    ...shared,
    clean: true,
    dts: true,
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    unbundle: true,
    copy: ["package.json", "LICENSE.md", "README.md", "CHANGELOG.md"],
  },
  {
    ...shared,
    clean: false,
    dts: false,
    entry: { cli: "src/cli/main.ts" },
    format: ["esm"],
    banner: "#!/usr/bin/env node",
    unbundle: true,
  },
]);
