/**
 * The framework examples, each run against the packed `inngest` package by
 * the same test runner the GitHub workflow uses. Every example runs once, and
 * four of them run again with streaming forced.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { pack } from "./base.ts";

const run = async (example: string, streaming: "" | "force") => {
  await checkout();

  await $`pnpm --filter inngest run itest ${example}`.env({
    INNGEST_STREAMING: streaming,
  });
};

export const examples = ci.matrix(
  {
    id: "examples",
    from: pack,
    axes: {
      example: [
        "bun",
        "framework-astro",
        "framework-elysiajs",
        "framework-express",
        "framework-fastify",
        "framework-google-functions-framework",
        "framework-koa",
        "framework-nestjs-fastify",
        "framework-nextjs-app-router",
        "framework-nextjs-pages-router",
        "framework-nitro",
        "framework-nuxt",
        "framework-remix",
        "framework-sveltekit",
        "framework-sveltekit-2",
        "framework-tanstack-start",
      ],
    },
  },
  async ({ example }) => {
    await run(example, "");
  },
);

export const streamingExamples = ci.matrix(
  {
    id: "examples-streaming",
    from: pack,
    axes: {
      example: [
        "framework-express",
        "framework-nextjs-app-router",
        "framework-remix",
        "node",
      ],
    },
  },
  async ({ example }) => {
    await run(example, "force");
  },
);
