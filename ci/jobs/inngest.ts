/**
 * The checks for the `inngest` package: lint, the runtime tests on every
 * supported Node version, the type tests on every supported TypeScript
 * version, the integration tests in three shards, and package health.
 *
 * @module
 */

import { $ } from "@inngest/ci";

import { ci } from "../client.ts";
import { pack, source } from "./base.ts";

export const checks = ci.matrix(
  {
    id: "inngest",
    from: source,
    axes: { script: ["lint", "test:dist", "test:deps"] },
  },
  async ({ matrix }) => {
    await $`pnpm --filter inngest run ${matrix.script}`;
  },
);

export const runtime = ci.matrix(
  { id: "runtime", from: source, axes: { node: ["20", "22", "24.16.0"] } },
  async ({ matrix }) => {
    const script = `node --version | grep -E "^v${matrix.node}(\\.|$)" && pnpm --filter inngest run test`;

    await $`npx --yes -p node@${matrix.node} sh -c ${script}`.as(
      `test on node ${matrix.node}`,
    );
  },
);

export const types = ci.matrix(
  { id: "types", from: source, axes: { typescript: ["~5.9.0", "~5.8.0"] } },
  async ({ matrix }) => {
    await $`pnpm --filter inngest add -D typescript@${matrix.typescript}`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run test:dist`;
  },
);

export const integration = ci.matrix(
  { id: "integration", from: source, axes: { shard: ["1/3", "2/3", "3/3"] } },
  async ({ matrix, from }) => {
    await from.$.integration.env({ SHARD: matrix.shard });
  },
);

export const health = ci.job({ id: "health", from: pack }, async ({ from }) => {
  await Promise.all([from.$.publint, from.$.attw]);
});

export const composite = ci.job(
  { id: "composite", from: pack },
  async ({ from }) => {
    await from.$.composite;
  },
);
