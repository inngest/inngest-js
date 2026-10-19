/**
 * The pull request checks for inngest-js: every check runs on a machine that
 * starts from a cached image, and every job reports its own result.
 *
 * @module
 */

import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { examples } from "../jobs/examples.ts";
import {
  checks,
  composite,
  health,
  integration,
  runtime,
  types,
} from "../jobs/inngest.ts";
import { audit, middlewareSentry, quality, tests } from "../jobs/packages.ts";

export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async () => {
    const results = await Promise.allSettled([
      audit(),
      checks(),
      runtime(),
      types(),
      integration(),
      health(),
      composite(),
      tests(),
      middlewareSentry(),
      quality(),
      examples(),
    ]);

    const reasons = results.flatMap((result) => {
      return result.status === "rejected" ? [result.reason] : [];
    });

    if (reasons.length > 0) {
      throw new AggregateError(reasons, `${reasons.length} jobs failed`);
    }
  },
);
