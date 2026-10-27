/**
 * The checks for the agent primitives on `jack/agent-primitives`: the agent
 * unit tests, the type tests, lint, and every scenario of the agents e2e kit
 * (`pnpm agents:verify --all`). The scenarios use the kit's `direct` stack, so
 * they start the Dev Server from `base` and a Redis in the job instead of
 * devstack.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { build, devServerBin } from "./base.ts";

export const agentChecks = ci.job(
  { id: "agent-checks", from: build },
  async () => {
    await checkout();

    await $`pnpm --filter inngest run test agent`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run lint`;
  },
);

export const agentScenarios = ci.job(
  { id: "agent-scenarios", from: build },
  async () => {
    await checkout();

    await $.sh`command -v redis-server || (apt-get update -qq && apt-get install -y -qq redis-server)`.as(
      "install redis",
    );

    await $.sh`AGENTS_VERIFY_STACK=direct AGENTS_VERIFY_DEV_BIN=${devServerBin} pnpm agents:verify --all`.as(
      "agents:verify --all",
    );
  },
);
