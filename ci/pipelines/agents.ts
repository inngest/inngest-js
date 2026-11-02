/**
 * The check for the agent primitives branch: every push to
 * `jack/agent-primitives` runs the agent unit, type and lint checks, so a
 * squash that breaks the branch shows up at once. A newer push cancels the
 * run in progress.
 *
 * @module
 */

import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { agentChecks } from "../jobs/agents.ts";

export const agents = ci.pipeline(
  {
    id: "agents",
    on: github.push({
      branches: ["jack/agent-primitives"],
      repo: "inngest/inngest-js",
    }),
    singleton: { key: "event.data.ref", mode: "cancel" },
  },
  async () => {
    await agentChecks();
  },
);
