/**
 * The checks for every package besides `inngest`: the tests of the packages
 * that only have tests, the integration test of the Sentry middleware, and
 * the full checks of the packages that CI itself builds on.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { build, runWithDevServer } from "./base.ts";

export const audit = ci.job({ id: "audit", from: build }, async () => {
  await checkout();

  await $`pnpm audit --audit-level=critical --prod --no-optional --ignore-registry-errors`;
});

export const tests = ci.job(
  {
    id: "tests",
    from: build,
    matrix: {
      axes: {
        package: [
          "@inngest/eslint-plugin",
          "@inngest/middleware-encryption",
          "@inngest/middleware-validation",
          "@inngest/realtime",
          "@inngest/test",
        ],
      },
    },
  },
  async ({ matrix }) => {
    await checkout();

    await $`pnpm --filter ${matrix.package} test`;
  },
);

export const middlewareSentry = ci.job(
  { id: "middleware-sentry", from: build },
  async ({ from }) => {
    await checkout();

    await runWithDevServer(
      from,
      from.$.integration.env({ PACKAGE: "@inngest/middleware-sentry" }),
    );
  },
);

export const quality = ci.job(
  {
    id: "quality",
    from: build,
    matrix: { axes: { package: ["@inngest/otel", "@inngest/ci"] } },
  },
  async ({ matrix }) => {
    await checkout();

    for (const script of [
      "type-check",
      "lint",
      "format:check",
      "test",
      "build",
    ]) {
      await $`pnpm --filter ${matrix.package} run ${script}`;
    }
  },
);
