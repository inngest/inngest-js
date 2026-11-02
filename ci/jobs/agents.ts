/**
 * The checks for the agent primitives on `jack/agent-primitives`: the agent
 * unit tests, the type tests and lint.
 *
 * @module
 */

import { $, checkout } from "@inngest/ci";

import { ci } from "../client.ts";
import { build } from "./base.ts";

export const agentChecks = ci.job(
  { id: "agent-checks", from: build },
  async () => {
    await checkout();

    await $`pnpm --filter inngest run test agent`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run lint`;
  },
);
