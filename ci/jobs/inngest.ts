/**
 * The checks for the `inngest` package: lint, the runtime tests on every
 * supported Node version, the type tests on every supported TypeScript
 * version, the integration tests in six shards, and package health.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { build, pack } from "./base.ts";

export const checks = ci.job(
  {
    id: "inngest",
    from: build,
    matrix: { axes: { script: ["lint", "test:dist", "test:deps"] } },
  },
  async ({ matrix }) => {
    await checkout();

    await $`pnpm --filter inngest run ${matrix.script}`;
  },
);

export const runtime = ci.job(
  {
    id: "runtime",
    from: build,
    matrix: { axes: { node: ["20", "22", "24.16.0"] } },
  },
  async ({ matrix }) => {
    await checkout();

    const script = `node --version | grep -E "^v${matrix.node}(\\.|$)" && pnpm --filter inngest run test`;

    await $`npx --yes -p node@${matrix.node} sh -c ${script}`.as(
      `test on node ${matrix.node}`,
    );
  },
);

export const types = ci.job(
  {
    id: "types",
    from: build,
    matrix: { axes: { typescript: ["~5.9.0", "~5.8.0"] } },
  },
  async ({ matrix }) => {
    await checkout();

    await $`pnpm --filter inngest add -D typescript@${matrix.typescript}`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run test:dist`;
  },
);

export const integration = ci.job(
  {
    id: "integration",
    from: build,
    matrix: { axes: { shard: ["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"] } },
  },
  async ({ matrix, from }) => {
    await checkout();

    await from.$.integration.env({ SHARD: matrix.shard });
  },
);

export const health = ci.job({ id: "health", from: pack }, async ({ from }) => {
  await checkout();

  await Promise.all([from.$.publint, from.$.attw]);
});

export const composite = ci.job(
  { id: "composite", from: pack },
  async ({ from }) => {
    await checkout();

    await from.$.composite;
  },
);
