import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: true,
  format: ["cjs", "esm"],
  outDir: "dist",
  tsconfig: "tsconfig.build.json",
  target: "node20",
  platform: "node",
  sourcemap: true,
  failOnWarn: true,
  minify: false,
  report: true,
  unbundle: true,
  copy: ["package.json", "LICENSE.md", "README.md", "CHANGELOG.md"],
  deps: { neverBundle: true },
});
