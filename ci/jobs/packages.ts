/**
 * The checks for every package besides `inngest`: the tests of the packages
 * that only have tests, the integration test of the Sentry middleware, and
 * the full checks of the packages that CI itself builds on.
 *
 * @module
 */

import { $ } from "@inngest/ci";

import { ci } from "../client.ts";
import { source } from "./base.ts";

export const audit = ci.job({ id: "audit", from: source }, async () => {
  await $`pnpm audit --audit-level=critical --prod --no-optional --ignore-registry-errors`;
});

export const tests = ci.matrix(
  {
    id: "tests",
    from: source,
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
  async ({ matrix }) => {
    await $`pnpm --filter ${matrix.package} test`;
  },
);

export const middlewareSentry = ci.job(
  { id: "middleware-sentry", from: source },
  async ({ from }) => {
    await from.$.integration.env({ PACKAGE: "@inngest/middleware-sentry" });
  },
);

export const quality = ci.matrix(
  {
    id: "quality",
    from: source,
    axes: { package: ["@inngest/otel", "@inngest/ci"] },
  },
  async ({ matrix }) => {
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
