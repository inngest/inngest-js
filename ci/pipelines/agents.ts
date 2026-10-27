/**
 * The check for the agent primitives branch: every push to
 * `jack/agent-primitives` runs the agent unit, type and lint checks and all
 * the e2e scenarios, so a squash that breaks the branch shows up at once. A
 * newer push cancels the run in progress.
 *
 * @module
 */

import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { agentChecks, agentScenarios } from "../jobs/agents.ts";

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
    const results = await Promise.allSettled([agentChecks(), agentScenarios()]);
    const reasons = results.flatMap((result) => {
      return result.status === "rejected" ? [result.reason] : [];
    });

    if (reasons.length > 0) {
      throw new AggregateError(reasons, `${reasons.length} jobs failed`);
    }
  },
);
