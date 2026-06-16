import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/node.ts"],
  format: ["esm"],
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
  skipNodeModulesBundle: true,
});
