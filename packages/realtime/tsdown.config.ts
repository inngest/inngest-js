import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/hooks.ts", "src/middleware.ts"],
  format: ["cjs", "esm"],
  outDir: "dist",
  tsconfig: "tsconfig.build.json",
  target: "node20",
  sourcemap: true,
  failOnWarn: true, // keep the build as good we can
  minify: false, // let bundlers handle minification if they want it
  report: true,
  unbundle: true, // let bundlers handle bundling
  copy: ["package.json", "LICENSE.md", "README.md", "CHANGELOG.md"],
  skipNodeModulesBundle: true,
});
