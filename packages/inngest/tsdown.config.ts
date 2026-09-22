import { defineConfig, type Options } from "tsdown";

const config = {
  clean: true,
  dts: true,
  entry: [
    "src/astro.ts",
    "src/bun.ts",
    "src/cloudflare.ts",
    "src/connect.ts",
    "src/deno/fresh.ts",
    "src/digitalocean.ts",
    "src/edge.ts",
    "src/experimental.ts",
    "src/express.ts",
    "src/fastify.ts",
    "src/h3.ts",
    "src/hono.ts",
    "src/index.ts",
    "src/internals.ts",
    "src/koa.ts",
    "src/react.ts",
    "src/realtime.ts",
    "src/lambda.ts",
    "src/next.ts",
    "src/nitro.ts",
    "src/node.ts",
    "src/nuxt.ts",
    "src/redwood.ts",
    "src/remix.ts",
    "src/experimental/durable-endpoints/index.ts",
    "src/experimental/durable-endpoints/client.ts",
    "src/sveltekit.ts",
    "src/types.ts",

    // Connect worker thread runner. Must be an entrypoint so that it compiles
    "src/components/connect/strategies/workerThread/runner.ts",

    "!src/test/**/*",
    "!src/**/*.test.*",
  ],
  outDir: "dist",
  tsconfig: "tsconfig.build.json",
  target: "node20",
  platform: "neutral",
  sourcemap: true,
  failOnWarn: true, // keep the build as good we can
  minify: false, // let bundlers handle minification if they want it
  report: true,
  unbundle: true, // let bundlers handle bundling
  copy: ["package.json", "LICENSE.md", "README.md", "CHANGELOG.md"],
  skipNodeModulesBundle: true,
} satisfies Options;

export default defineConfig([
  {
    ...config,
    format: ["cjs"],
  },
  {
    ...config,
    entry: [...config.entry, "src/effect.ts"],
    format: ["esm"],
    clean: false,
    copy: undefined,
  },
]);
