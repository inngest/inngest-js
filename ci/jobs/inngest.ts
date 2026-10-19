/**
 * The checks for the `inngest` package: lint, the runtime tests on every
 * supported Node version, the type tests on every supported TypeScript
 * version, the integration tests in three shards, and package health.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { build, pack } from "./base.ts";

const inngestDir = "/work/packages/inngest";

export const lint = ci.job({ id: "lint", from: build }, async () => {
  await checkout();

  await $`pnpm --filter inngest run lint`;
});

export const runtime = ci.matrix(
  { id: "runtime", from: build, axes: { node: ["20", "22", "24.16.0"] } },
  async ({ node }) => {
    await checkout();

    await $`npx --yes -p node@${node} pnpm --filter inngest run test`.as(
      `test on node ${node}`,
    );
  },
);

export const types = ci.matrix(
  { id: "types", from: build, axes: { typescript: ["~5.9.0", "~5.8.0"] } },
  async ({ typescript }) => {
    await checkout();

    await $`pnpm --filter inngest add -D typescript@${typescript}`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run test:dist`;
  },
);

export const dist = ci.job({ id: "dist", from: build }, async () => {
  await checkout();

  await $`pnpm --filter inngest run test:dist`;
});

export const deps = ci.job({ id: "deps", from: build }, async () => {
  await checkout();

  await $`pnpm --filter inngest run test:deps`;
});

export const integration = ci.matrix(
  { id: "integration", from: build, axes: { shard: ["1/3", "2/3", "3/3"] } },
  async ({ shard }) => {
    await checkout();

    await $`pnpm --filter inngest run test:integration --shard=${shard}`;
  },
);

export const health = ci.job({ id: "health", from: pack }, async () => {
  await checkout();

  await Promise.all([
    $`pnpm dlx publint --pack npm ./dist`.cwd(inngestDir).as("publint"),
    $`pnpm exec attw inngest.tgz`.cwd(inngestDir).as("are the types wrong"),
  ]);
});

export const composite = ci.job({ id: "composite", from: pack }, async () => {
  await checkout();

  await $`npm i ../../inngest.tgz`.cwd(`${inngestDir}/test/composite_project`);

  await $`npm run test`.cwd(`${inngestDir}/test/composite_project`);
});
