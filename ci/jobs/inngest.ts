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

const inngestDir = "/work/packages/inngest";

export const lint = ci.job({ id: "lint", from: source }, async () => {
  await $`pnpm --filter inngest run lint`;
});

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

export const dist = ci.job({ id: "dist", from: source }, async () => {
  await $`pnpm --filter inngest run test:dist`;
});

export const deps = ci.job({ id: "deps", from: source }, async () => {
  await $`pnpm --filter inngest run test:deps`;
});

export const integration = ci.matrix(
  { id: "integration", from: source, axes: { shard: ["1/3", "2/3", "3/3"] } },
  async ({ matrix, from }) => {
    await $`pnpm --filter inngest run test:integration --shard=${matrix.shard}`.env(
      {
        INNGEST_CLI_VERSION: (from.key as { devServer: string }).devServer,
      },
    );
  },
);

export const health = ci.job({ id: "health", from: pack }, async () => {
  await Promise.all([
    $`pnpm dlx publint --pack npm ./dist`.cwd(inngestDir).as("publint"),
    $`pnpm exec attw inngest.tgz`.cwd(inngestDir).as("are the types wrong"),
  ]);
});

export const composite = ci.job({ id: "composite", from: pack }, async () => {
  await $`npm i ../../inngest.tgz`.cwd(`${inngestDir}/test/composite_project`);

  await $`npm run test`.cwd(`${inngestDir}/test/composite_project`);
});
